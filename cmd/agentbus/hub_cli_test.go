package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/shiroha-document/agentbus/internal/hub"
)

// cliHub is a minimal signed fake hub for the v3 commands.
type cliHub struct {
	mu      sync.Mutex
	pub     ed25519.PublicKey
	status  string
	posts   []hub.NewPost
	patches []hub.ThreadPatch
	paths   []string
	version string
}

func (h *cliHub) serve(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	b, _ := io.ReadAll(r.Body)
	path := strings.TrimPrefix(r.URL.Path, hub.APIPrefix)
	h.paths = append(h.paths, r.Method+" "+path)
	h.version = r.Header.Get("X-Agentbus-Version")
	reply := func(code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	if path == "/agent/join" {
		var jr hub.JoinReq
		_ = json.Unmarshal(b, &jr)
		raw, _ := base64.StdEncoding.DecodeString(jr.PublicKey)
		h.pub = ed25519.PublicKey(raw)
		if jr.Name == "taken" {
			reply(409, map[string]any{"error": map[string]any{"code": "conflict", "message": "name taken"}})
			return
		}
	}
	ss := hub.SigningString(r.Method, r.URL.RequestURI(), r.Header.Get("X-Agentbus-Timestamp"), r.Header.Get("X-Agentbus-Nonce"), b)
	sig, _ := base64.StdEncoding.DecodeString(r.Header.Get("X-Agentbus-Signature"))
	if len(h.pub) != ed25519.PublicKeySize || !ed25519.Verify(h.pub, []byte(ss), sig) {
		reply(401, map[string]any{"error": map[string]any{"code": "unauthorized", "message": "bad signature"}})
		return
	}
	switch {
	case path == "/agent/join":
		reply(200, hub.JoinResp{MemberID: "m_1", Status: "pending"})
	case path == "/agent/state":
		reply(200, hub.State{Member: hub.Member{ID: "m_1", Name: "alice", Role: "agent", Status: h.status}, MinClientVersion: "0.4.0"})
	case path == "/agent/posts" && r.Method == "POST":
		var np hub.NewPost
		_ = json.Unmarshal(b, &np)
		h.posts = append(h.posts, np)
		reply(200, hub.PostResp{Post: hub.Post{ID: "p_9", ThreadID: firstOr(np.ThreadID, "t_new")}, Thread: hub.Thread{ID: firstOr(np.ThreadID, "t_new"), Title: np.Title}})
	case strings.HasPrefix(path, "/agent/threads/") && r.Method == "PATCH":
		var p hub.ThreadPatch
		_ = json.Unmarshal(b, &p)
		h.patches = append(h.patches, p)
		reply(200, map[string]any{"thread": hub.Thread{ID: strings.TrimPrefix(path, "/agent/threads/")}})
	default:
		reply(404, map[string]any{"error": map[string]any{"code": "not_found", "message": path}})
	}
}

func newCLIHub(t *testing.T) (*cliHub, string) {
	t.Helper()
	h := &cliHub{status: "pending"}
	srv := httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(srv.Close)
	t.Setenv("AGENTBUS_HUB_HOME", t.TempDir())
	t.Setenv("AGENTBUS_AUTO_UPDATE", "off")
	t.Setenv("AGENTBUS_ROUND", "")
	t.Setenv("AGENTBUS_THREAD", "")
	return h, srv.URL
}

func TestHubJoinPostThread(t *testing.T) {
	h, url := newCLIHub(t)
	code, out := run(t, "join", url, "--name", "alice", "--cli", "claude")
	if code != 0 || !strings.Contains(out, "等待管理员在网页上批准") {
		t.Fatalf("join: %d %s", code, out)
	}
	dir := hub.Dir()
	cfg, err := hub.LoadConfig(dir)
	if err != nil || cfg.MemberID != "m_1" || cfg.Name != "alice" {
		t.Fatalf("%+v %v", cfg, err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(hub.Paths{Dir: dir}.Key()); fi.Mode().Perm() != 0o600 {
			t.Fatalf("key mode %o", fi.Mode().Perm())
		}
	}
	if h.version != "0.4.0" {
		t.Fatalf("version header %q", h.version)
	}
	// re-running join is idempotent
	if code, out := run(t, "join", url, "--name", "alice"); code != 0 || !strings.Contains(out, "pending") {
		t.Fatalf("rejoin: %d %s", code, out)
	}
	// another name on the same config dir is refused
	if code, _ := run(t, "join", url, "--name", "bob"); code == 0 {
		t.Fatal("second identity accepted")
	}

	// whoami/status now dispatch to v3
	h.status = "active"
	if code, out := run(t, "whoami"); code != 0 || !strings.Contains(out, "alice (m_1)") {
		t.Fatalf("whoami: %d %s", code, out)
	}

	// post inside a round: key = round + body hash, stable across retries
	t.Setenv("AGENTBUS_ROUND", "d_1:r1")
	t.Setenv("AGENTBUS_THREAD", "t_1")
	for i := 0; i < 2; i++ {
		if code, out := run(t, "post", "--body", "hello"); code != 0 || !strings.Contains(out, "posted p_9 in t_1") {
			t.Fatalf("post: %d %s", code, out)
		}
	}
	if len(h.posts) != 2 || h.posts[0].IdempotencyKey != h.posts[1].IdempotencyKey ||
		!strings.HasPrefix(h.posts[0].IdempotencyKey, "d_1:r1:") || h.posts[0].ThreadID != "t_1" || h.posts[0].Kind != "msg" {
		t.Fatalf("%+v", h.posts)
	}
	if code, _ := run(t, "confirm", "merge", "now?"); code != 0 || h.posts[2].Kind != "confirm" || h.posts[2].Body != "merge now?" {
		t.Fatalf("confirm %+v", h.posts[2])
	}
	if code, out := run(t, "post", "--workspace", "w_1", "--title", "New", "--body", "x"); code != 0 || !strings.Contains(out, "new thread") {
		t.Fatalf("new thread: %d %s", code, out)
	}
	if code, _ := run(t, "thread", "state", "--body", "## state"); code != 0 {
		t.Fatal("thread state")
	}
	if code, _ := run(t, "thread", "assign", "t_2", "@bob"); code != 0 {
		t.Fatal("thread assign")
	}
	if code, _ := run(t, "thread", "close", "--done"); code != 0 {
		t.Fatal("thread close")
	}
	if len(h.patches) != 3 || *h.patches[0].State != "## state" || *h.patches[1].Assignee != "bob" || *h.patches[2].Status != "done" {
		t.Fatalf("%+v", h.patches)
	}
	if code, _ := run(t, "post", "--kind", "bogus", "--body", "x"); code != exitUsage {
		t.Fatal("bad kind accepted")
	}
	if code, _ := run(t, "--hub", "https://other.example", "state"); code == 0 {
		t.Fatal("--hub mismatch accepted")
	}
}

func TestHubJoinNameTaken(t *testing.T) {
	_, url := newCLIHub(t)
	code, out := run(t, "join", url, "--name", "taken")
	if code == 0 || !strings.Contains(out, "is taken") {
		t.Fatalf("%d %s", code, out)
	}
	if hub.Exists(hub.Dir()) {
		t.Fatal("config saved after 409")
	}
}

func TestDispatchV1V3(t *testing.T) {
	t.Setenv("AGENTBUS_HUB_HOME", t.TempDir())
	if useHub("whoami", nil, "") || useHub("join", []string{"--remote", "x", "--me", "a"}, "") {
		t.Fatal("no hub config: want v1")
	}
	if !useHub("join", []string{"https://hub.example", "--name", "a"}, "") || !useHub("status", nil, "https://h") {
		t.Fatal("hub URL given: want v3")
	}
	if err := (&hub.Config{HubURL: "https://h", Name: "alice"}).Save(hub.Dir()); err != nil {
		t.Fatal(err)
	}
	if !useHub("thread", []string{"show", "t_1"}, "") {
		t.Fatal("hub config: want v3")
	}
	if useHub("join", []string{"--repo", "o/r", "--me", "a"}, "") {
		t.Fatal("v1 join flags: want v1")
	}
	args, u, err := extractHubFlags([]string{"tick", "--hub-home", "/x", "--hub=https://h", "--", "--hub", "y"})
	if err != nil || u != "https://h" || strings.Join(args, " ") != "tick -- --hub y" || os.Getenv("AGENTBUS_HUB_HOME") != "/x" {
		t.Fatalf("%v %q %v", args, u, err)
	}
}

func TestVersionDev(t *testing.T) {
	code, out := run(t, "--version")
	if code != 0 || strings.TrimSpace(out) != "0.4.0-dev" || hubVersion() != "0.4.0" {
		t.Fatalf("%d %q", code, out)
	}
}

// fakeCron is a Runner emulating crontab without systemd.
type fakeCron struct {
	tab   string
	calls []string
}

func (f *fakeCron) Run(name string, args []string, stdin string) (string, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	switch {
	case name == "crontab" && len(args) == 1 && args[0] == "-l":
		if f.tab == "" {
			return "no crontab for user", errors.New("exit 1")
		}
		return f.tab, nil
	case name == "crontab" && len(args) == 1 && args[0] == "-":
		f.tab = stdin
		return "", nil
	}
	return "", errors.New("not available")
}

func TestScheduleCron(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("cron path is linux-only")
	}
	t.Setenv("AGENTBUS_HUB_HOME", t.TempDir())
	t.Setenv("AGENTBUS_AUTO_UPDATE", "off")
	if err := (&hub.Config{HubURL: "https://h", Name: "alice"}).Save(hub.Dir()); err != nil {
		t.Fatal(err)
	}
	fc := &fakeCron{}
	old := schedRunner
	schedRunner = fc
	defer func() { schedRunner = old }()
	if code, out := run(t, "schedule", "status"); code != exitNothing || !strings.Contains(out, "not installed") {
		t.Fatalf("%d %s", code, out)
	}
	code, out := run(t, "schedule", "install", "--interval", "10m")
	if code != 0 || !strings.Contains(out, "installed cron job") {
		t.Fatalf("%d %s", code, out)
	}
	if !strings.Contains(fc.tab, "*/10 * * * *") || !strings.Contains(fc.tab, "tick --hub-home") || !strings.Contains(fc.tab, "# agentbus:alice") {
		t.Fatal(fc.tab)
	}
	if cfg, _ := hub.LoadConfig(hub.Dir()); cfg.WakeIntervalS != 600 {
		t.Fatalf("interval %d", cfg.WakeIntervalS)
	}
	if code, _ := run(t, "schedule", "status"); code != 0 {
		t.Fatal("status after install")
	}
	if code, _ := run(t, "schedule", "uninstall"); code != 0 || strings.Contains(fc.tab, "agentbus:alice") {
		t.Fatal(fc.tab)
	}
}

func TestSetupNonInteractive(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("cron path is linux-only")
	}
	h, url := newCLIHub(t)
	h.status = "pending"
	fc := &fakeCron{}
	oldR, oldL := schedRunner, lookPath
	schedRunner = fc
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	defer func() { schedRunner, lookPath = oldR, oldL }()
	repo := t.TempDir()
	code, out := run(t, "setup", "--yes", "--hub", url, "--name", "alice", "--cli", "codex", "--tier", "readonly",
		"--repo", "Acme/App="+repo, "--interval", "15m", "--quota-source", "magpie")
	// doctor fails: codex is not on PATH
	if code != exitErr || !strings.Contains(out, "usemagpie.ai/install.sh") || !strings.Contains(out, "codex not found") ||
		!strings.Contains(out, "等待管理员在网页上批准") {
		t.Fatalf("%d %s", code, out)
	}
	cfg, err := hub.LoadConfig(hub.Dir())
	if err != nil || cfg.CLI != "codex" || cfg.Tier != "readonly" || cfg.QuotaSource != "magpie" || cfg.WakeIntervalS != 900 {
		t.Fatalf("%+v %v", cfg, err)
	}
	rs, _ := hub.LoadRepos(hub.Paths{Dir: hub.Dir()}.Repos())
	if v, ok := rs.Lookup("acme/app"); !ok || v != repo {
		t.Fatalf("%v", rs)
	}
	if !strings.Contains(fc.tab, "*/15 * * * *") {
		t.Fatal(fc.tab)
	}
	// doctor with a CLI present and the scheduler installed passes
	lookPath = func(n string) (string, error) { return filepath.Join("/opt/bin", n), nil }
	oldV := cliVersion
	cliVersion = func(_ context.Context, bin string) (string, error) { return "codex 1.0", nil }
	defer func() { cliVersion = oldV }()
	if code, out := run(t, "doctor"); code != 0 || !strings.Contains(out, "signature accepted") || !strings.Contains(out, "codex 1.0") {
		t.Fatalf("%d %s", code, out)
	}
}

// TestMain points AGENTBUS_HUB_HOME at an empty dir so a real hub config on
// the developer's machine never routes the v1 tests to v3.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "agentbus-hub-home")
	if err == nil {
		os.Setenv("AGENTBUS_HUB_HOME", dir)
	}
	code := m.Run()
	if dir != "" {
		os.RemoveAll(dir)
	}
	os.Exit(code)
}

func TestIsReleaseTag(t *testing.T) {
	for v, want := range map[string]bool{"v0.4.0": true, "v0.3.1+dirty": false, "(devel)": false, "": false,
		"v0.3.2-0.20261020101010-abcdef123456": false, "v0.3.1-0.20261020101010-abcdef123456+dirty": false} {
		if isReleaseTag(v) != want {
			t.Errorf("%q", v)
		}
	}
}
