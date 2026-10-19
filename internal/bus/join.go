package bus

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Self-service onboarding.
//
//	agent:  agentbus join --repo OWNER/REPO --me NAME ...   -> key + join request
//	human:  submit the pre-filled issue (or comment /approve) -> one click
//	CI:     agentbus admin approve ... adds the deploy key + members/NAME.json
//	agent:  agentbus join --wait 14m  -> detects access, runs init, done

// JoinMarker tags a join request so CI can find it in an issue body.
const JoinMarker = "<!-- agentbus-join v1 -->"

// FiledByAgentMarker marks issues the agent opened itself (with whatever
// token it has). Those are never approved just by being opened: a maintainer
// must comment /approve. Issues a human submits from the pre-filled link lack
// it, so submitting is the approval.
const FiledByAgentMarker = "<!-- agentbus-filed-by-agent -->"

// JoinLabel is put on join-request issues.
const JoinLabel = "agentbus-join"

// JoinRequest is what an agent asks for.
type JoinRequest struct {
	Name         string    `json:"name"`
	PublicKey    string    `json:"public_key"`
	Role         string    `json:"role,omitempty"`
	Capabilities []string  `json:"capabilities,omitempty"`
	Channels     []string  `json:"channels,omitempty"`
	Wake         string    `json:"wake,omitempty"`
	Owner        string    `json:"owner,omitempty"`
	Description  string    `json:"description,omitempty"`
	Host         string    `json:"host,omitempty"`
	At           time.Time `json:"at"`
}

// JoinState is $AGENTBUS_HOME/join.json: a pending request, so `join --wait`
// can be re-run (e.g. by an agent that only lives for one turn).
type JoinState struct {
	Repo     string      `json:"repo,omitempty"` // OWNER/REPO when on GitHub
	Remote   string      `json:"remote"`
	Branch   string      `json:"branch"`
	Request  JoinRequest `json:"request"`
	KeyPath  string      `json:"key_path"`
	IssueURL string      `json:"issue_url,omitempty"`
	NewURL   string      `json:"new_issue_url,omitempty"`
}

func joinPath(home string) string { return filepath.Join(home, "join.json") }

// LoadJoin reads a pending join (nil if none).
func LoadJoin(home string) (*JoinState, error) {
	var s JoinState
	if err := readJSON(joinPath(home), &s); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

// SaveJoin persists a pending join.
func SaveJoin(home string, s *JoinState) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	return writeJSON(joinPath(home), s)
}

// ClearJoin removes the pending join after a successful init.
func ClearJoin(home string) { _ = os.Remove(joinPath(home)) }

// EnsureKey returns (creating if needed) this home's ed25519 key pair. The
// private key never leaves home; only the .pub goes into the request.
func EnsureKey(home, name string) (keyPath, pub string, err error) {
	dir := filepath.Join(home, "keys")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	keyPath = filepath.Join(dir, "id_ed25519")
	if _, err := os.Stat(keyPath); errors.Is(err, os.ErrNotExist) {
		cmd := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "agentbus:"+name, "-f", keyPath)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", "", fmt.Errorf("ssh-keygen: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	data, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		return "", "", err
	}
	return keyPath, strings.TrimSpace(string(data)), nil
}

var rePubKey = regexp.MustCompile(`^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{40,800}( [^\n\r]{0,100})?$`)

// Fingerprint returns the OpenSSH SHA256 fingerprint of an authorized_keys line.
func Fingerprint(pub string) (string, error) {
	f := strings.Fields(pub)
	if len(f) < 2 {
		return "", errors.New("malformed public key")
	}
	raw, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil {
		return "", fmt.Errorf("malformed public key: %v", err)
	}
	sum := sha256.Sum256(raw)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:]), nil
}

// Validate checks a request before a human sees it and again before approval.
func (r *JoinRequest) Validate() error {
	if !ValidName(r.Name) || r.Name == "human" {
		return fmt.Errorf("invalid agent name %q (use [a-z0-9._-], 2-40 chars)", r.Name)
	}
	if !rePubKey.MatchString(r.PublicKey) {
		return errors.New("public_key must be a single OpenSSH public key line")
	}
	if _, err := Fingerprint(r.PublicKey); err != nil {
		return err
	}
	for _, c := range append(append([]string{}, r.Capabilities...), r.Channels...) {
		if !ValidName(c) {
			return fmt.Errorf("invalid capability/channel %q", c)
		}
	}
	switch r.Wake {
	case "", "daemon", "poll", "wait", "manual":
	default:
		return fmt.Errorf("invalid wake %q", r.Wake)
	}
	if len(r.Description) > 500 || len(r.Role) > 100 || len(r.Owner) > 60 {
		return errors.New("role/owner/description too long")
	}
	return nil
}

// Profile converts the request into the profile the agent will publish.
func (r *JoinRequest) Profile() Profile {
	return Profile{Name: r.Name, Role: r.Role, Capabilities: r.Capabilities, Channels: r.Channels,
		Wake: r.Wake, Owner: r.Owner, Description: r.Description, SigningKey: r.PublicKey}
}

// IssueTitle / IssueBody render the request as a GitHub issue that a human can
// approve by submitting it (maintainer-opened requests are auto-approved).
func (r *JoinRequest) IssueTitle() string { return "[agentbus-join] " + r.Name }

func (r *JoinRequest) IssueBody() string {
	fp, _ := Fingerprint(r.PublicKey)
	js, _ := json.MarshalIndent(r, "", "  ")
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s\n### Agent `%s` asks to join this agentbus\n\n", JoinMarker, r.Name)
	fmt.Fprintf(&sb, "| | |\n|---|---|\n| role | %s |\n| capabilities | %s |\n| channels | %s |\n| wake | %s |\n| owner | %s |\n| host | %s |\n| key | `%s` |\n\n",
		dashIf(r.Role), dashIf(strings.Join(r.Capabilities, ", ")), dashIf(strings.Join(r.Channels, ", ")),
		dashIf(r.Wake), dashIf(r.Owner), dashIf(r.Host), fp)
	if r.Description != "" {
		fmt.Fprintf(&sb, "> %s\n\n", strings.ReplaceAll(r.Description, "\n", " "))
	}
	sb.WriteString("**To approve:** if you are a maintainer and are looking at the *new issue* form, just press **Submit** — that is the approval. ")
	sb.WriteString("Otherwise comment `/approve` (or `/deny <reason>`). Revoke later with `/revoke`.\n\n")
	sb.WriteString("Approval grants this key write access to the repo (deploy key) and records `members/" + r.Name + ".json`.\n\n")
	fmt.Fprintf(&sb, "```json\n%s\n```\n", js)
	return sb.String()
}

func dashIf(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

var reJoinJSON = regexp.MustCompile("(?s)" + regexp.QuoteMeta(JoinMarker) + ".*?```json\\s*\\n(\\{.*?\\})\\s*\\n```")

// ParseJoinRequest extracts a request from an issue body (or a raw JSON file).
func ParseJoinRequest(text string) (*JoinRequest, error) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	raw := strings.TrimSpace(text)
	if m := reJoinJSON.FindStringSubmatch(text); m != nil {
		raw = m[1]
	} else if !strings.HasPrefix(raw, "{") {
		return nil, errors.New("no agentbus join request found (missing marker / json block)")
	}
	var r JoinRequest
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return nil, fmt.Errorf("join request json: %v", err)
	}
	r.PublicKey = strings.TrimSpace(r.PublicKey)
	return &r, r.Validate()
}

// GitHubRepo parses OWNER/REPO, https or ssh GitHub URLs.
func GitHubRepo(s string) (string, bool) {
	s = strings.TrimSuffix(strings.TrimSpace(s), ".git")
	for _, p := range []string{"git@github.com:", "ssh://git@github.com/", "https://github.com/", "github.com/"} {
		if strings.HasPrefix(s, p) {
			s = strings.TrimPrefix(s, p)
			break
		}
	}
	parts := strings.Split(s, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(s, ":@ ") {
		return "", false
	}
	return s, true
}

// NewIssueURL is a pre-filled "new issue" link: the human opens it and clicks
// Submit. No token is needed on the agent side.
func NewIssueURL(repo string, r *JoinRequest) string {
	q := url.Values{}
	q.Set("title", r.IssueTitle())
	q.Set("body", r.IssueBody())
	q.Set("labels", JoinLabel)
	return "https://github.com/" + repo + "/issues/new?" + q.Encode()
}

// JoinOpts is the agent side of onboarding.
type JoinOpts struct {
	Home    string
	Repo    string // OWNER/REPO (GitHub); derives Remote when empty
	Remote  string // ssh remote the key will be authorised for
	Branch  string
	Request JoinRequest
	GH      *GitHub // optional: lets the agent open the issue itself
}

// Join creates (or reuses) this home's key and a pending join request. When a
// GitHub token is available the request is filed as an issue; otherwise a
// pre-filled new-issue URL is returned for the human to open and submit.
func Join(o JoinOpts) (*JoinState, error) {
	if _, err := LoadConfig(o.Home); err == nil {
		return nil, fmt.Errorf("home %s is already initialised; use a different AGENTBUS_HOME for another identity", o.Home)
	}
	if o.Branch == "" {
		o.Branch = "agent-bus"
	}
	if o.Repo == "" {
		if r, ok := GitHubRepo(o.Remote); ok {
			o.Repo = r
		}
	}
	if o.Remote == "" {
		if o.Repo == "" {
			return nil, errors.New("join needs --repo OWNER/REPO or --remote URL")
		}
		o.Remote = "git@github.com:" + o.Repo + ".git"
	}
	if strings.HasPrefix(o.Remote, "http") {
		return nil, errors.New("join authorises an ssh key: use an ssh remote (git@host:owner/repo.git)")
	}
	if prev, _ := LoadJoin(o.Home); prev != nil && prev.Request.Name != o.Request.Name {
		return nil, fmt.Errorf("a join request for %q is already pending in %s", prev.Request.Name, o.Home)
	}
	key, pub, err := EnsureKey(o.Home, o.Request.Name)
	if err != nil {
		return nil, err
	}
	r := o.Request
	r.PublicKey, r.At = pub, time.Now().UTC()
	if r.Host == "" {
		r.Host, _ = os.Hostname()
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	st := &JoinState{Repo: o.Repo, Remote: o.Remote, Branch: o.Branch, Request: r, KeyPath: key}
	if prev, _ := LoadJoin(o.Home); prev != nil && prev.IssueURL != "" {
		st.IssueURL = prev.IssueURL
	}
	if o.Repo != "" {
		st.NewURL = NewIssueURL(o.Repo, &r)
		if o.GH != nil && st.IssueURL == "" {
			body := strings.Replace(r.IssueBody(), "**To approve:** if you are a maintainer and are looking at the *new issue* form, just press **Submit** — that is the approval. ", "**To approve:** ", 1)
			is, err := o.GH.CreateIssue(o.Repo, r.IssueTitle(), body+"\n"+FiledByAgentMarker+"\n", []string{JoinLabel})
			if err != nil {
				fmt.Fprintf(os.Stderr, "agentbus: could not open the join issue (%v); falling back to the link\n", err)
			} else {
				st.IssueURL = is.HTMLURL
			}
		}
	}
	return st, SaveJoin(o.Home, st)
}

// Join check results.
var (
	ErrJoinPending = errors.New("join request pending approval")
	ErrJoinDenied  = errors.New("join request denied")
)

// CheckJoin tries to complete a pending join: if the key has been granted
// access and the bus records this key as a member, it initialises the home
// and publishes the profile. Returns ErrJoinPending while waiting.
func CheckJoin(home string, gh *GitHub) (*Bus, error) {
	st, err := LoadJoin(home)
	if err != nil {
		return nil, err
	}
	if st == nil {
		if _, err := LoadConfig(home); err == nil {
			return Open(home)
		}
		return nil, errors.New("no pending join request: run `agentbus join` first")
	}
	if _, err := LsRemote(st.Remote, st.Branch, st.KeyPath); err != nil {
		if st.IssueURL != "" && issueClosedUnapproved(gh, st.IssueURL) {
			return nil, fmt.Errorf("%w (see %s)", ErrJoinDenied, st.IssueURL)
		}
		return nil, ErrJoinPending
	}
	g, err := Clone(st.Remote, st.Branch, clonePath(home), st.Request.Name, st.KeyPath)
	if err != nil {
		return nil, err
	}
	if err := g.Pull(); err != nil {
		return nil, err
	}
	ms := LoadMembers(g.Dir)
	fp, _ := Fingerprint(st.Request.PublicKey)
	// Reachability alone is not approval (local / self-hosted remotes may have
	// no per-key access control): the approver must have recorded our key.
	m := ms[st.Request.Name]
	if m == nil {
		return nil, ErrJoinPending // key works but membership not recorded (yet)
	}
	if m.Revoked || m.KeySHA256 != fp {
		return nil, fmt.Errorf("%w: members/%s.json does not hold this key (revoked=%v)", ErrJoinDenied, m.Name, m.Revoked)
	}
	b, err := Init(home, st.Remote, st.Branch, st.Request.Profile(), st.KeyPath)
	if err != nil {
		return nil, err
	}
	ClearJoin(home)
	return b, nil
}

// issueClosedUnapproved best-effort checks a GitHub issue (public repos work
// without a token).
func issueClosedUnapproved(gh *GitHub, issueURL string) bool {
	repo, n, ok := ParseIssueURL(issueURL)
	if !ok {
		return false
	}
	if gh == nil {
		gh = &GitHub{}
	}
	var is struct {
		State       string `json:"state"`
		StateReason string `json:"state_reason"`
	}
	if err := gh.do("GET", fmt.Sprintf("/repos/%s/issues/%d", repo, n), nil, &is); err != nil {
		return false
	}
	return is.State == "closed" && is.StateReason == "not_planned"
}
