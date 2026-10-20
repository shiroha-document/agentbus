package hub

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shiroha-document/agentbus/internal/quota"
)

func readAll(r *http.Request) []byte {
	b, _ := io.ReadAll(r.Body)
	return b
}

func verify(pub ed25519.PublicKey, ss, sig string) bool {
	raw, err := base64.StdEncoding.DecodeString(sig)
	return err == nil && ed25519.Verify(pub, []byte(ss), raw)
}

// fakeHub is a minimal in-memory hub for tick tests.
type fakeHub struct {
	t   *testing.T
	srv *httptest.Server
	pub ed25519.PublicKey

	mu          sync.Mutex
	status      string // member status
	paused      bool
	pauseReason string
	quotaPaused bool
	claims      []ClaimedThread
	posts       map[string][]Post // thread -> posts
	keys        map[string]Post   // idempotency key -> post
	acks        []string
	nacks       []string
	runs        []Run
	heartbeats  int
	quotaCalls  int
	seq         int
}

func newFakeHub(t *testing.T, pub ed25519.PublicKey) *fakeHub {
	h := &fakeHub{t: t, pub: pub, status: "active", posts: map[string][]Post{}, keys: map[string]Post{}}
	h.srv = httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *fakeHub) addThread(id string, deliveries ...Delivery) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.claims = append(h.claims, ClaimedThread{ThreadID: id, WorkspaceID: "w_1", Deliveries: deliveries})
	for _, d := range deliveries {
		h.posts[id] = append(h.posts[id], Post{ID: d.PostID, ThreadID: id, AuthorID: "m_bob", Body: "@alice please fix the test",
			Kind: "msg", CreatedAt: time.Now().Add(-time.Minute).UnixMilli()})
	}
}

func (h *fakeHub) reply(w http.ResponseWriter, v any) {
	w.Header().Set("Date", time.Now().UTC().Format(http.TimeFormat))
	_ = json.NewEncoder(w).Encode(v)
}

func (h *fakeHub) serve(w http.ResponseWriter, r *http.Request) {
	body := readAll(r)
	ss := SigningString(r.Method, r.URL.RequestURI(), r.Header.Get("X-Agentbus-Timestamp"), r.Header.Get("X-Agentbus-Nonce"), body)
	if !verify(h.pub, ss, r.Header.Get("X-Agentbus-Signature")) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"bad signature"}}`))
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, APIPrefix)
	switch r.Method + " " + path {
	case "GET /agent/state":
		var pr *string
		if h.pauseReason != "" {
			pr = &h.pauseReason
		}
		h.reply(w, State{Member: Member{ID: "m_1", Name: "alice", Role: "agent", Status: h.status, Paused: h.paused, PauseReason: pr},
			Config: StateConfig{LeaseS: 900, ContextPosts: 30, MaxClaimThreads: 3}})
	case "POST /agent/quota":
		h.quotaCalls++
		if h.quotaPaused {
			reason, until := "quota:claude/5h 100%", time.Now().Add(time.Hour).UnixMilli()
			h.reply(w, QuotaResp{Paused: true, PauseReason: &reason, PausedUntil: &until})
			return
		}
		h.reply(w, QuotaResp{})
	case "POST /agent/claim":
		cs := h.claims
		h.claims = nil
		if cs == nil {
			cs = []ClaimedThread{}
		}
		h.reply(w, ClaimResp{Threads: cs})
	case "GET /agent/context":
		id := r.URL.Query().Get("thread")
		repo := "acme/app"
		h.reply(w, Context{
			Workspace: Workspace{ID: "w_1", Name: "app", Goal: "ship it", Repo: &repo},
			Thread:    Thread{ID: id, WorkspaceID: "w_1", Title: "flaky test", Status: "open"},
			Posts:     h.posts[id],
			Members:   []Member{{ID: "m_bob", Name: "bob"}},
			Me:        Member{ID: "m_1", Name: "alice", Role: "agent"},
		})
	case "GET /agent/posts":
		h.reply(w, PostsResp{Posts: h.posts[r.URL.Query().Get("thread")]})
	case "POST /agent/posts":
		var np NewPost
		_ = json.Unmarshal(body, &np)
		if p, ok := h.keys[np.IdempotencyKey]; ok {
			h.reply(w, PostResp{Post: p, Duplicate: true})
			return
		}
		h.seq++
		p := Post{ID: fmt.Sprintf("p_new%d", h.seq), ThreadID: np.ThreadID, AuthorID: "m_1", Body: np.Body, Kind: np.Kind,
			Usage: np.Usage, CreatedAt: time.Now().UnixMilli()}
		h.keys[np.IdempotencyKey] = p
		h.posts[np.ThreadID] = append(h.posts[np.ThreadID], p)
		h.reply(w, PostResp{Post: p})
	case "POST /agent/ack":
		h.acks = append(h.acks, string(body))
		h.reply(w, map[string]int{"acked": 1})
	case "POST /agent/nack":
		h.nacks = append(h.nacks, string(body))
		h.reply(w, map[string]int{"released": 1})
	case "POST /agent/heartbeat":
		h.heartbeats++
		h.reply(w, map[string]int64{"lease_until": time.Now().Add(15 * time.Minute).UnixMilli()})
	case "POST /agent/runs":
		var in struct {
			Runs []Run `json:"runs"`
		}
		_ = json.Unmarshal(body, &in)
		h.runs = append(h.runs, in.Runs...)
		h.reply(w, map[string]int{"accepted": len(in.Runs)})
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"` + path + `"}}`))
	}
}

// tickEnv sets up a config dir joined to a fake hub, with the claude adapter
// pointing at this test binary (see TestMain).
func tickEnv(t *testing.T, mode string) (*fakeHub, *Ticker) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("AGENTBUS_HUB_HOME", dir)
	t.Setenv("AGENTBUS_FAKE_CLI", mode)
	k, _ := GenerateKey()
	h := newFakeHub(t, k.Public().(ed25519.PublicKey))
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{HubURL: h.srv.URL, MemberID: "m_1", Name: "alice", CLI: "claude", CLIBinary: exe}
	if err := cfg.Save(dir); err != nil {
		t.Fatal(err)
	}
	if err := SaveKey(Paths{dir}.Key(), k); err != nil {
		t.Fatal(err)
	}
	cl := NewClient(cfg, k, "0.4.0-test")
	cl.Backoff = func(int) time.Duration { return time.Millisecond }
	tk := &Ticker{Dir: dir, Cfg: cfg, Client: cl, Version: "0.4.0-test", Exe: exe, Log: io.Discard,
		Timeout: 20 * time.Second, KillGrace: 200 * time.Millisecond,
		Quota: func(context.Context) []quota.Reading { return nil }}
	return h, tk
}

// TestMain doubles as a fake coding CLI when AGENTBUS_FAKE_CLI is set and
// AGENTBUS_IN_TICK=1 (i.e. we were started by tick).
func TestMain(m *testing.M) {
	if mode := os.Getenv("AGENTBUS_FAKE_CLI"); mode != "" && os.Getenv("AGENTBUS_IN_TICK") == "1" {
		os.Exit(fakeCLI(mode))
	}
	os.Exit(m.Run())
}

const fakeClaudeOK = `{"type":"result","subtype":"success","is_error":false,"duration_ms":1200,"result":"Fixed the flaky test; CI is green.","total_cost_usd":0.0412,"usage":{"input_tokens":3200,"cache_creation_input_tokens":0,"cache_read_input_tokens":28000,"output_tokens":900},"modelUsage":{"claude-sonnet-4-5":{"outputTokens":900}}}`

func fakeCLI(mode string) int {
	prompt, _ := io.ReadAll(os.Stdin)
	if !strings.Contains(string(prompt), os.Getenv("AGENTBUS_THREAD")) {
		fmt.Fprintln(os.Stderr, "prompt does not mention the thread")
		return 2
	}
	switch mode {
	case "ok":
		fmt.Println(fakeClaudeOK)
	case "fail":
		fmt.Fprintln(os.Stderr, "boom: model overloaded")
		return 1
	case "sleep":
		fmt.Println(`{"type":"partial"}`)
		time.Sleep(60 * time.Second)
	case "post":
		// behave like an agent that runs `agentbus post --kind progress`
		dir := os.Getenv("AGENTBUS_HUB_HOME")
		cfg, err := LoadConfig(dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		k, err := LoadKey(Paths{dir}.Key())
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		c := NewClient(cfg, k, "0.4.0-test")
		_, err = c.Post(context.Background(), NewPost{ThreadID: os.Getenv("AGENTBUS_THREAD"), Kind: "progress",
			Body: "要做什么 → 修测试；改了什么 → x_test.go", IdempotencyKey: os.Getenv("AGENTBUS_ROUND") + ":agent"})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println(fakeClaudeOK)
	}
	return 0
}
