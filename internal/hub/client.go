package hub

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// APIPrefix is the base path of every hub endpoint.
const APIPrefix = "/api/v1"

// SigningString builds the string signed for a request (hub-api.md §2).
func SigningString(method, pathWithQuery, timestamp, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	return "agentbus-v1\n" + method + "\n" + pathWithQuery + "\n" + timestamp + "\n" + nonce + "\n" + hex.EncodeToString(sum[:])
}

// Sign returns the standard-base64 ed25519 signature for a request.
func Sign(k ed25519.PrivateKey, method, pathWithQuery, timestamp, nonce string, body []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(k, []byte(SigningString(method, pathWithQuery, timestamp, nonce, body))))
}

// NewNonce is 32 random URL-safe characters.
func NewNonce() string {
	var b [24]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// APIError is a hub error reply.
type APIError struct {
	Status  int
	Code    string
	Message string
	Upgrade string
}

func (e *APIError) Error() string {
	if e.Status == http.StatusUpgradeRequired {
		up := firstNonEmpty(e.Upgrade, "agentbus self-update")
		return fmt.Sprintf("this agentbus is too old for the hub (%s); run `%s`", firstNonEmpty(e.Message, "client_too_old"), up)
	}
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	if e.Code != "" {
		return fmt.Sprintf("hub: %s (%s, HTTP %d)", msg, e.Code, e.Status)
	}
	return fmt.Sprintf("hub: %s (HTTP %d)", msg, e.Status)
}

// IsStatus reports whether err is an APIError with this HTTP status.
func IsStatus(err error, status int) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == status
}

// IsTooOld reports a 426 reply.
func IsTooOld(err error) bool { return IsStatus(err, http.StatusUpgradeRequired) }

// Client talks to one hub as one member.
type Client struct {
	BaseURL  string // e.g. https://hub.shiroha.tech
	MemberID string // "join" while joining
	Key      ed25519.PrivateKey
	Version  string
	HTTP     *http.Client
	// Retries for idempotent requests on 5xx / network errors (default 3).
	Retries int
	// Backoff before retry n (1-based); default 500ms·2^(n-1).
	Backoff func(n int) time.Duration
	// Now is injectable for tests.
	Now func() time.Time
	// LastDate is the Date header of the last response (clock-skew check).
	LastDate time.Time
}

// NewClient builds a client from a config and key.
func NewClient(cfg *Config, key ed25519.PrivateKey, version string) *Client {
	return &Client{BaseURL: cfg.HubURL, MemberID: cfg.MemberID, Key: key, Version: version}
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Do sends a signed request to path (relative to /api/v1, e.g.
// "/agent/state"), JSON-encoding in (nil = empty body) and decoding the
// reply into out (nil = discard). idempotent requests are retried.
func (c *Client) Do(ctx context.Context, method, path string, in, out any, idempotent bool) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	retries := c.Retries
	if retries == 0 {
		retries = 3
	}
	if !idempotent {
		retries = 0
	}
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		if attempt > 0 {
			d := 500 * time.Millisecond << (attempt - 1)
			if c.Backoff != nil {
				d = c.Backoff(attempt)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
			}
		}
		retry, err := c.once(ctx, method, path, body, out)
		if err == nil {
			return nil
		}
		lastErr = err
		if !retry || ctx.Err() != nil {
			break
		}
	}
	return lastErr
}

func (c *Client) once(ctx context.Context, method, path string, body []byte, out any) (retry bool, err error) {
	u, err := url.Parse(strings.TrimRight(c.BaseURL, "/") + APIPrefix + path)
	if err != nil {
		return false, err
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return false, err
	}
	pq := u.EscapedPath()
	if u.RawQuery != "" {
		pq += "?" + u.RawQuery
	}
	ts := strconv.FormatInt(c.now().Unix(), 10)
	nonce := NewNonce()
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "agentbus/"+c.Version+" ("+runtime.GOOS+"/"+runtime.GOARCH+")")
	req.Header.Set("X-Agentbus-Version", c.Version)
	req.Header.Set("X-Agentbus-Member", c.MemberID)
	req.Header.Set("X-Agentbus-Timestamp", ts)
	req.Header.Set("X-Agentbus-Nonce", nonce)
	if c.Key != nil {
		req.Header.Set("X-Agentbus-Signature", Sign(c.Key, method, pq, ts, nonce, body))
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		var ne net.Error
		return errors.As(err, &ne) || !errors.Is(err, context.Canceled), fmt.Errorf("hub unreachable: %w", err)
	}
	defer resp.Body.Close()
	if d, perr := http.ParseTime(resp.Header.Get("Date")); perr == nil {
		c.LastDate = d
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return true, fmt.Errorf("hub: reading reply: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		ae := &APIError{Status: resp.StatusCode}
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
				Upgrade string `json:"upgrade"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &env) == nil {
			ae.Code, ae.Message, ae.Upgrade = env.Error.Code, env.Error.Message, env.Error.Upgrade
		}
		if ae.Message == "" && ae.Code == "" {
			ae.Message = strings.TrimSpace(string(data))
			if len(ae.Message) > 200 {
				ae.Message = ae.Message[:200]
			}
		}
		return resp.StatusCode >= 500, ae
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return false, nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false, fmt.Errorf("hub: bad reply to %s %s: %w", method, path, err)
	}
	return false, nil
}

// ---- typed endpoints ----

func (c *Client) Join(ctx context.Context, r JoinReq) (*JoinResp, error) {
	var out JoinResp
	saved := c.MemberID
	c.MemberID = "join"
	defer func() { c.MemberID = saved }()
	// join is idempotent per public key
	return &out, c.Do(ctx, "POST", "/agent/join", r, &out, true)
}

func (c *Client) State(ctx context.Context) (*State, error) {
	var out State
	return &out, c.Do(ctx, "GET", "/agent/state", nil, &out, true)
}

func (c *Client) Claim(ctx context.Context, maxThreads int) (*ClaimResp, error) {
	var out ClaimResp
	in := map[string]any{}
	if maxThreads > 0 {
		in["max_threads"] = maxThreads
	}
	// not retried: a lost reply would leave leases we don't know about (they expire)
	return &out, c.Do(ctx, "POST", "/agent/claim", in, &out, false)
}

func (c *Client) Context(ctx context.Context, thread string) (*Context, error) {
	var out Context
	return &out, c.Do(ctx, "GET", "/agent/context?thread="+url.QueryEscape(thread), nil, &out, true)
}

func (c *Client) Posts(ctx context.Context, thread, before string, limit int) (*PostsResp, error) {
	q := url.Values{"thread": {thread}}
	if before != "" {
		q.Set("before", before)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out PostsResp
	return &out, c.Do(ctx, "GET", "/agent/posts?"+q.Encode(), nil, &out, true)
}

// Post is idempotent thanks to the idempotency key.
func (c *Client) Post(ctx context.Context, p NewPost) (*PostResp, error) {
	var out PostResp
	return &out, c.Do(ctx, "POST", "/agent/posts", p, &out, p.IdempotencyKey != "")
}

func (c *Client) PatchThread(ctx context.Context, id string, p ThreadPatch) (*Thread, error) {
	var out struct {
		Thread Thread `json:"thread"`
	}
	return &out.Thread, c.Do(ctx, "PATCH", "/agent/threads/"+url.PathEscape(id), p, &out, p.Version != nil || p.Labels == nil)
}

func (c *Client) Threads(ctx context.Context, workspace, status string, mine bool) ([]Thread, error) {
	q := url.Values{}
	if workspace != "" {
		q.Set("workspace", workspace)
	}
	if status != "" {
		q.Set("status", status)
	}
	if mine {
		q.Set("mine", "1")
	}
	p := "/agent/threads"
	if len(q) > 0 {
		p += "?" + q.Encode()
	}
	var out struct {
		Threads []Thread `json:"threads"`
	}
	return out.Threads, c.Do(ctx, "GET", p, nil, &out, true)
}

func (c *Client) Workspaces(ctx context.Context) ([]Workspace, error) {
	var out struct {
		Workspaces []Workspace `json:"workspaces"`
	}
	return out.Workspaces, c.Do(ctx, "GET", "/agent/workspaces", nil, &out, true)
}

func (c *Client) Ack(ctx context.Context, thread string, deliveries []string) error {
	in := map[string]any{"thread_id": thread}
	if len(deliveries) > 0 {
		in["delivery_ids"] = deliveries
	}
	return c.Do(ctx, "POST", "/agent/ack", in, nil, true)
}

func (c *Client) Nack(ctx context.Context, thread string, deliveries []string, reason string) error {
	in := map[string]any{"thread_id": thread, "reason": reason}
	if len(deliveries) > 0 {
		in["delivery_ids"] = deliveries
	}
	return c.Do(ctx, "POST", "/agent/nack", in, nil, false)
}

func (c *Client) Heartbeat(ctx context.Context, thread string) (int64, error) {
	in := map[string]any{}
	if thread != "" {
		in["thread_id"] = thread
	}
	var out struct {
		LeaseUntil int64 `json:"lease_until"`
	}
	return out.LeaseUntil, c.Do(ctx, "POST", "/agent/heartbeat", in, &out, true)
}

func (c *Client) Runs(ctx context.Context, runs []Run) (int, error) {
	var out struct {
		Accepted int `json:"accepted"`
	}
	return out.Accepted, c.Do(ctx, "POST", "/agent/runs", map[string]any{"runs": runs}, &out, true)
}

func (c *Client) Quota(ctx context.Context, readings any) (*QuotaResp, error) {
	var out QuotaResp
	return &out, c.Do(ctx, "POST", "/agent/quota", map[string]any{"readings": readings}, &out, true)
}

func (c *Client) RotateKey(ctx context.Context, newPub string) (int64, error) {
	var out struct {
		OK              bool  `json:"ok"`
		OldKeyExpiresAt int64 `json:"old_key_expires_at"`
	}
	return out.OldKeyExpiresAt, c.Do(ctx, "POST", "/agent/keys/rotate", map[string]any{"new_public_key": newPub}, &out, false)
}

// ---- manager ----

func (c *Client) ManageMembers(ctx context.Context) ([]Member, error) {
	var out struct {
		Members []Member `json:"members"`
	}
	return out.Members, c.Do(ctx, "GET", "/agent/manage/members", nil, &out, true)
}

// ManageMember posts action (approve, reject, pause, resume) for member id.
func (c *Client) ManageMember(ctx context.Context, id, action string, in any) error {
	if in == nil {
		in = map[string]any{}
	}
	return c.Do(ctx, "POST", "/agent/manage/members/"+url.PathEscape(id)+"/"+action, in, nil, true)
}

func (c *Client) CreateWorkspace(ctx context.Context, w WorkspaceReq) (*Workspace, error) {
	var out struct {
		Workspace Workspace `json:"workspace"`
	}
	return &out.Workspace, c.Do(ctx, "POST", "/agent/manage/workspaces", w, &out, false)
}

func (c *Client) UpdateWorkspace(ctx context.Context, id string, w WorkspaceReq) (*Workspace, error) {
	var out struct {
		Workspace Workspace `json:"workspace"`
	}
	return &out.Workspace, c.Do(ctx, "PATCH", "/agent/manage/workspaces/"+url.PathEscape(id), w, &out, true)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
