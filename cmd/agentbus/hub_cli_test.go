package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
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
	code    string // join_code of the last join
	team    hub.TeamRef
	taken   map[string]bool // names the join answers 409 for

	// v0.6 endpoints
	uploads    []hub.Attachment  // received uploads (Size = body length)
	files      map[string][]byte // GET /agent/files/:id
	listed     []hub.Post        // GET /agent/posts
	activities []hub.ActivityReq
	events     []hub.Event
	collapsed  bool // POST /agent/posts answers collapsed

	// self-driven (inbox) endpoints
	claims     []hub.ClaimedThread
	acks       []string
	nacks      []string
	heartbeats int
}

const testJoinCode = "abj_k3x9abcdefghijklmnopqrst"

func run(t *testing.T, args ...string) (int, string) {
	t.Helper()
	var out, errw bytes.Buffer
	c := &cli{out: &out, errw: &errw}
	code := c.run(args)
	return code, out.String() + errw.String()
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
		h.code = jr.JoinCode
		if jr.JoinCode == "" {
			reply(400, map[string]any{"error": map[string]any{"code": "join_code_required", "message": "join_code is required"}})
			return
		}
		if jr.JoinCode != testJoinCode {
			reply(403, map[string]any{"error": map[string]any{"code": "bad_join_code", "message": "invalid, expired or revoked join code"}})
			return
		}
		if jr.Name == "taken" || h.taken[jr.Name] {
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
		reply(200, hub.JoinResp{MemberID: "m_1", Status: "pending", Team: h.team})
	case path == "/agent/state":
		reply(200, hub.State{Member: hub.Member{ID: "m_1", Name: "alice", Role: "agent", Status: h.status}, Team: h.team,
			MinClientVersion: "0.6.0"})
	case path == "/agent/posts" && r.Method == "POST":
		var np hub.NewPost
		_ = json.Unmarshal(b, &np)
		h.posts = append(h.posts, np)
		reply(200, hub.PostResp{Post: hub.Post{ID: "p_9", ThreadID: firstOr(np.ThreadID, "t_new")}, Thread: hub.Thread{ID: firstOr(np.ThreadID, "t_new"), Title: np.Title},
			Collapsed: h.collapsed})
	case path == "/agent/posts" && r.Method == "GET":
		reply(200, hub.PostsResp{Posts: h.listed})
	case path == "/agent/uploads" && r.Method == "POST":
		name, _ := neturl.PathUnescape(r.Header.Get("X-File-Name"))
		a := hub.Attachment{ID: fmt.Sprintf("f_%d", len(h.uploads)+1), Name: name, Mime: r.Header.Get("Content-Type"), Size: int64(len(b))}
		h.uploads = append(h.uploads, a)
		reply(200, map[string]any{"attachment": a})
	case strings.HasPrefix(path, "/agent/files/") && r.Method == "GET":
		data, ok := h.files[strings.TrimPrefix(path, "/agent/files/")]
		if !ok {
			reply(404, map[string]any{"error": map[string]any{"code": "not_found", "message": "no such file"}})
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(data)
	case path == "/agent/activity":
		var a hub.ActivityReq
		_ = json.Unmarshal(b, &a)
		h.activities = append(h.activities, a)
		reply(200, map[string]any{"ok": true})
	case path == "/agent/events":
		var in struct {
			Events []hub.Event `json:"events"`
		}
		_ = json.Unmarshal(b, &in)
		h.events = append(h.events, in.Events...)
		reply(200, map[string]any{"accepted": len(in.Events)})
	case strings.HasPrefix(path, "/agent/threads/") && r.Method == "PATCH":
		var p hub.ThreadPatch
		_ = json.Unmarshal(b, &p)
		h.patches = append(h.patches, p)
		reply(200, map[string]any{"thread": hub.Thread{ID: strings.TrimPrefix(path, "/agent/threads/")}})
	case path == "/agent/claim":
		cs := h.claims
		h.claims = nil
		if cs == nil {
			cs = []hub.ClaimedThread{}
		}
		reply(200, hub.ClaimResp{Threads: cs})
	case path == "/agent/context":
		id := r.URL.Query().Get("thread")
		reply(200, hub.Context{Workspace: hub.Workspace{ID: "w_1", Name: "app"},
			Thread: hub.Thread{ID: id, WorkspaceID: "w_1", Title: "flaky test", Status: "open"},
			Posts:  []hub.Post{{ID: "p_1", ThreadID: id, AuthorID: "m_bob", Body: "@alice fix it", Kind: "msg"}},
			Me:     hub.Member{ID: "m_1", Name: "alice", Role: "agent"}})
	case path == "/agent/ack":
		h.acks = append(h.acks, string(b))
		reply(200, map[string]int{"acked": 1})
	case path == "/agent/nack":
		h.nacks = append(h.nacks, string(b))
		reply(200, map[string]int{"released": 1})
	case path == "/agent/heartbeat":
		h.heartbeats++
		reply(200, map[string]int64{"lease_until": 1893456000000})
	default:
		reply(404, map[string]any{"error": map[string]any{"code": "not_found", "message": path}})
	}
}

func newCLIHub(t *testing.T) (*cliHub, string) {
	t.Helper()
	h := &cliHub{status: "pending", team: hub.TeamRef{ID: "o_team1", Name: "Acme"}}
	srv := httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(srv.Close)
	t.Setenv("AGENTBUS_HUB_HOME", t.TempDir())
	t.Setenv("AGENTBUS_AUTO_UPDATE", "off")
	t.Setenv("AGENTBUS_ROUND", "")
	t.Setenv("AGENTBUS_THREAD", "")
	t.Setenv("AGENTBUS_JOIN_CODE", "")
	t.Setenv("AGENTBUS_HUB", "")
	t.Setenv("AGENTBUS_TELEMETRY", "")
	t.Setenv("AGENTBUS_IN_TICK", "")
	t.Setenv("AGENTBUS_CLI", "")
	t.Setenv("AGENTBUS_MODEL", "")
	return h, srv.URL
}

func TestHubJoinPostThread(t *testing.T) {
	h, url := newCLIHub(t)
	code, out := run(t, "join", url, "--join-code", " "+strings.ToUpper(testJoinCode)+"\n", "--name", "alice", "--cli", "claude")
	if code != 0 || !strings.Contains(out, "waiting for a team admin") || !strings.Contains(out, "in team Acme (o_team1)") {
		t.Fatalf("join: %d %s", code, out)
	}
	dir := hub.Dir()
	cfg, err := hub.LoadConfig(dir)
	if err != nil || cfg.MemberID != "m_1" || cfg.Name != "alice" || cfg.TeamID != "o_team1" || cfg.TeamName != "Acme" {
		t.Fatalf("%+v %v", cfg, err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(hub.Paths{Dir: dir}.Key()); fi.Mode().Perm() != 0o600 {
			t.Fatalf("key mode %o", fi.Mode().Perm())
		}
	}
	if h.code != testJoinCode {
		t.Fatalf("join_code %q", h.code)
	}
	if h.version != "0.7.0" {
		t.Fatalf("version header %q", h.version)
	}
	// re-running join is idempotent and needs no join code
	if code, out := run(t, "join", url, "--name", "alice"); code != 0 || !strings.Contains(out, "pending") {
		t.Fatalf("rejoin: %d %s", code, out)
	}
	// another name on the same config dir is refused
	if code, _ := run(t, "join", url, "--join-code", testJoinCode, "--name", "bob"); code == 0 {
		t.Fatal("second identity accepted")
	}

	h.status = "active"
	if code, out := run(t, "whoami"); code != 0 || !strings.Contains(out, "alice (m_1)") || !strings.Contains(out, "team Acme (o_team1)") {
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
	code, out := run(t, "join", url, "--join-code", testJoinCode, "--name", "taken")
	if code == 0 || !strings.Contains(out, "is taken") {
		t.Fatalf("%d %s", code, out)
	}
	if hub.Exists(hub.Dir()) {
		t.Fatal("config saved after 409")
	}
}

func TestHubJoinCode(t *testing.T) {
	h, url := newCLIHub(t)
	// missing --join-code (and no $AGENTBUS_JOIN_CODE): usage error, no request
	code, out := run(t, "join", url, "--name", "alice")
	if code != exitUsage || !strings.Contains(out, "join code is required") || !strings.Contains(out, "Settings → Agent 加入码") ||
		!strings.Contains(out, "AGENTBUS_JOIN_CODE") || len(h.paths) != 0 {
		t.Fatalf("missing code: %d %s %v", code, out, h.paths)
	}
	// not an abj_ code: usage error, no request
	code, out = run(t, "join", url, "--join-code", "ABCD-EFGH-JKMN", "--name", "alice")
	if code != exitUsage || !strings.Contains(out, "start with abj_") || len(h.paths) != 0 {
		t.Fatalf("bad prefix: %d %s %v", code, out, h.paths)
	}
	// rejected code: 403 bad_join_code with a clear hint, nothing saved
	const wrong = "abj_wrongwrongwrongwrongwrongw"
	code, out = run(t, "join", url, "--join-code", wrong, "--name", "alice")
	if code != exitErr || !strings.Contains(out, "rejected this join code") || !strings.Contains(out, "ask a team admin") ||
		!strings.Contains(out, "Settings → Agent 加入码") {
		t.Fatalf("bad code: %d %s", code, out)
	}
	if h.code != wrong || hub.Exists(hub.Dir()) {
		t.Fatalf("code %q, config saved after 403", h.code)
	}
	// --json errors carry the same message
	code, out = run(t, "--json", "join", url, "--join-code", wrong, "--name", "alice")
	if code != exitErr || !strings.Contains(out, `"error"`) || !strings.Contains(out, "ask a team admin") {
		t.Fatalf("json bad code: %d %s", code, out)
	}
	// $AGENTBUS_JOIN_CODE is the default
	t.Setenv("AGENTBUS_JOIN_CODE", " "+testJoinCode+" ")
	if code, out := run(t, "--json", "join", url, "--name", "alice"); code != 0 || h.code != testJoinCode ||
		!strings.Contains(out, `"id": "o_team1"`) || !strings.Contains(out, `"name": "Acme"`) {
		t.Fatalf("env code: %d %s %q", code, out, h.code)
	}
}

func TestHubJoinFlagBeatsEnv(t *testing.T) {
	h, url := newCLIHub(t)
	t.Setenv("AGENTBUS_JOIN_CODE", "abj_fromenvfromenvfromenvfromen")
	if code, out := run(t, "join", url, "--join-code", testJoinCode, "--name", "alice"); code != 0 || h.code != testJoinCode {
		t.Fatalf("%d %s %q", code, out, h.code)
	}
}

func TestJoinErrorMapping(t *testing.T) {
	cases := []struct {
		err  *hub.APIError
		want []string
	}{
		{&hub.APIError{Status: 400, Code: "join_code_required", Message: "join_code is required"},
			[]string{"join code is required", "ask a team admin", "Settings → Agent 加入码", "--join-code", "join_code_required"}},
		{&hub.APIError{Status: 403, Code: "bad_join_code", Message: "invalid"},
			[]string{"rejected this join code", "expired or revoked", "ask a team admin", "Settings → Agent 加入码", "bad_join_code"}},
		{&hub.APIError{Status: 409, Code: "conflict", Message: "taken"}, []string{`name "alice" is taken`, "pick another --name"}},
	}
	for _, tc := range cases {
		got := joinError(tc.err, "alice", "https://hub.example").Error()
		for _, w := range tc.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s: %q lacks %q", tc.err.Code, got, w)
			}
		}
	}
	// anything else passes through unchanged
	other := &hub.APIError{Status: 403, Code: "forbidden", Message: "nope"}
	if err := joinError(other, "alice", "h"); err != error(other) {
		t.Errorf("unmapped error changed: %v", err)
	}
}

func TestTeamSavedAndShown(t *testing.T) {
	h, url := newCLIHub(t)
	if code, out := run(t, "join", url, "--join-code", testJoinCode, "--name", "alice"); code != 0 {
		t.Fatalf("join: %d %s", code, out)
	}
	h.status = "active"
	// whoami --json carries the team from /agent/state
	code, out := run(t, "--json", "whoami")
	var st hub.State
	if code != 0 || json.Unmarshal([]byte(out), &st) != nil || st.Team.ID != "o_team1" || st.Team.Name != "Acme" {
		t.Fatalf("whoami --json: %d %s", code, out)
	}
	// status text and JSON
	if code, out := run(t, "status", "--no-quota"); code != 0 || !strings.Contains(out, "team Acme (o_team1)") {
		t.Fatalf("status: %d %s", code, out)
	}
	code, out = run(t, "--json", "status", "--no-quota")
	var sj struct {
		Team hub.TeamRef `json:"team"`
	}
	if code != 0 || json.Unmarshal([]byte(out), &sj) != nil || sj.Team != (hub.TeamRef{ID: "o_team1", Name: "Acme"}) {
		t.Fatalf("status --json: %d %s", code, out)
	}
	// a renamed team is picked up from /agent/state and saved
	h.team.Name = "Acme Labs"
	if code, out := run(t, "whoami"); code != 0 || !strings.Contains(out, "team Acme Labs (o_team1)") {
		t.Fatalf("renamed: %d %s", code, out)
	}
	if cfg, _ := hub.LoadConfig(hub.Dir()); cfg.TeamName != "Acme Labs" {
		t.Fatalf("team name not saved: %+v", cfg)
	}
	// doctor shows the team in the config and hub checks (text and JSON)
	oldL, oldV := lookPath, cliVersion
	lookPath = func(n string) (string, error) { return filepath.Join("/opt/bin", n), nil }
	cliVersion = func(context.Context, string) (string, error) { return "claude 1.0", nil }
	defer func() { lookPath, cliVersion = oldL, oldV }()
	_, out = run(t, "doctor")
	if !strings.Contains(out, "team Acme Labs (o_team1)") || !strings.Contains(out, "active in team Acme Labs") {
		t.Fatalf("doctor: %s", out)
	}
	_, out = run(t, "--json", "doctor")
	if !strings.Contains(out, "team Acme Labs (o_team1)") {
		t.Fatalf("doctor --json: %s", out)
	}
	// an older hub without team in /agent/state keeps the saved team
	h.team = hub.TeamRef{}
	code, out = run(t, "--json", "whoami")
	st = hub.State{}
	if code != 0 || json.Unmarshal([]byte(out), &st) != nil || st.Team.ID != "o_team1" || st.Team.Name != "Acme Labs" {
		t.Fatalf("old hub whoami: %d %s", code, out)
	}
}

func TestTeamText(t *testing.T) {
	for _, tc := range []struct {
		cfg  hub.Config
		want string
	}{{hub.Config{TeamID: "o_1", TeamName: "A"}, "A (o_1)"}, {hub.Config{TeamID: "o_1"}, "o_1"}, {hub.Config{}, "-"}} {
		if got := teamText(&tc.cfg); got != tc.want {
			t.Errorf("%+v: %q", tc.cfg, got)
		}
	}
}

func TestExtractHubFlags(t *testing.T) {
	t.Setenv("AGENTBUS_HUB_HOME", t.TempDir())
	args, err := extractHubFlags([]string{"tick", "--hub-home", "/x", "--hub=https://h", "--", "--hub", "y"})
	if err != nil || hubURLFlag != "https://h" || strings.Join(args, " ") != "tick -- --hub y" || os.Getenv("AGENTBUS_HUB_HOME") != "/x" {
		t.Fatalf("%v %q %v", args, hubURLFlag, err)
	}
	if _, err := extractHubFlags([]string{"state", "--hub"}); err == nil {
		t.Fatal("--hub without a value accepted")
	}
	hubURLFlag = ""
}

func TestVersionDev(t *testing.T) {
	code, out := run(t, "--version")
	if code != 0 || strings.TrimSpace(out) != "0.7.0-dev" || hubVersion() != "0.7.0" {
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
	// --yes without --join-code / $AGENTBUS_JOIN_CODE is a usage error
	if code, out := run(t, "setup", "--yes", "--hub", url, "--name", "alice", "--cli", "codex", "--no-schedule", "--no-doctor"); code != exitUsage ||
		!strings.Contains(out, "join code is required") || !strings.Contains(out, "ask a team admin") || hub.Exists(hub.Dir()) {
		t.Fatalf("setup without join code: %d %s", code, out)
	}
	code, out := run(t, "setup", "--yes", "--hub", url, "--join-code", testJoinCode, "--name", "alice", "--cli", "codex", "--tier", "readonly",
		"--repo", "Acme/App="+repo, "--interval", "15m", "--quota-source", "magpie")
	// doctor fails: codex is not on PATH
	if code != exitErr || strings.Contains(out, "magpie") || !strings.Contains(out, "codex not found") ||
		!strings.Contains(out, "waiting for a team admin") || !strings.Contains(out, "in team Acme (o_team1)") {
		t.Fatalf("%d %s", code, out)
	}
	cfg, err := hub.LoadConfig(hub.Dir())
	if err != nil || cfg.CLI != "codex" || cfg.Tier != "readonly" || cfg.QuotaSource != "magpie" || cfg.WakeIntervalS != 900 ||
		cfg.TeamID != "o_team1" {
		t.Fatalf("%+v %v", cfg, err)
	}
	// setup steps are recorded (choices only) and flushed after the join
	steps := map[string]any{}
	for _, ev := range h.events {
		if ev.Name == "cli.setup" {
			steps[ev.Props["step"].(string)] = ev.Props["choice"]
		}
	}
	if steps["cli"] != "codex" || steps["tier"] != "readonly" || steps["join"] != "pending" || steps["doctor"] != "failed" {
		t.Fatalf("setup events %v", steps)
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

func TestSetupInteractiveAsksJoinCode(t *testing.T) {
	h, url := newCLIHub(t)
	oldL, oldIn := lookPath, setupIn
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	// cli, join code, name, tier, repos (none), scheduler (no)
	setupIn = strings.NewReader("codex\n  " + testJoinCode + "  \nalice\nreadonly\n\nn\n")
	defer func() { lookPath, setupIn = oldL, oldIn }()
	code, out := run(t, "setup", "--hub", url, "--no-doctor")
	if code != 0 || !strings.Contains(out, "team join code (abj_…; ask a team admin") || h.code != testJoinCode {
		t.Fatalf("%d %q %s", code, h.code, out)
	}
	cfg, err := hub.LoadConfig(hub.Dir())
	if err != nil || cfg.Name != "alice" || cfg.CLI != "codex" || cfg.TeamID != "o_team1" || cfg.TeamName != "Acme" {
		t.Fatalf("%+v %v", cfg, err)
	}
	// already joined: setup re-runs without asking for (or sending) a code
	h.code = "untouched"
	setupIn = strings.NewReader("codex\nreadonly\n\nn\n")
	code, out = run(t, "setup", "--no-doctor")
	if code != 0 || strings.Contains(out, "team join code") || h.code != "untouched" {
		t.Fatalf("rerun: %d %q %s", code, h.code, out)
	}
}

func TestSetupInteractiveEmptyJoinCode(t *testing.T) {
	h, url := newCLIHub(t)
	oldL, oldIn := lookPath, setupIn
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	setupIn = strings.NewReader("codex\n\n")
	defer func() { lookPath, setupIn = oldL, oldIn }()
	code, out := run(t, "setup", "--hub", url, "--no-doctor")
	if code != exitUsage || !strings.Contains(out, "join code is required") || len(h.paths) != 0 {
		t.Fatalf("%d %s %v", code, out, h.paths)
	}
}

func TestSetupJoinCodeFromEnv(t *testing.T) {
	h, url := newCLIHub(t)
	oldL := lookPath
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	defer func() { lookPath = oldL }()
	t.Setenv("AGENTBUS_JOIN_CODE", testJoinCode)
	code, out := run(t, "setup", "--yes", "--hub", url, "--name", "alice", "--cli", "codex", "--no-schedule", "--no-doctor")
	if code != 0 || h.code != testJoinCode || !strings.Contains(out, "in team Acme (o_team1)") {
		t.Fatalf("%d %q %s", code, h.code, out)
	}
}

func TestSetupHubFromEnvAndAutoName(t *testing.T) {
	h, url := newCLIHub(t)
	oldL := lookPath
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	defer func() { lookPath = oldL }()
	t.Setenv("AGENTBUS_HUB", url)
	t.Setenv("AGENTBUS_JOIN_CODE", testJoinCode)
	// the suggested name is taken: setup retries with a suffix
	h.taken = map[string]bool{suggestName(mustHost(t), "codex"): true}
	code, out := run(t, "setup", "--yes", "--cli", "codex", "--no-schedule", "--no-doctor")
	want := nameVariant(suggestName(mustHost(t), "codex"), 2)
	if code != 0 || h.code != testJoinCode || !strings.Contains(out, "as "+want+" ") {
		t.Fatalf("%d %s", code, out)
	}
	if cfg, err := hub.LoadConfig(hub.Dir()); err != nil || cfg.Name != want || cfg.HubURL != url {
		t.Fatalf("%+v %v", cfg, err)
	}
}

func TestJoinExplicitNameTakenFails(t *testing.T) {
	_, url := newCLIHub(t)
	t.Setenv("AGENTBUS_HUB", url)
	code, out := run(t, "join", "--join-code", testJoinCode, "--name", "taken")
	if code == 0 || !strings.Contains(out, `the name "taken" is taken`) {
		t.Fatalf("%d %s", code, out)
	}
}

func TestNameVariant(t *testing.T) {
	if got := nameVariant("box-codex", 2); got != "box-codex-2" {
		t.Fatal(got)
	}
	long := strings.Repeat("a", 31) + "b"
	if got := nameVariant(long, 12); len(got) != 32 || !strings.HasSuffix(got, "-12") || !nameRE.MatchString(got) {
		t.Fatal(got)
	}
}

func mustHost(t *testing.T) string {
	t.Helper()
	h, _ := os.Hostname()
	return h
}

func TestUsageText(t *testing.T) {
	if code, _ := run(t); code != exitUsage {
		t.Fatalf("bare agentbus exit %d", code)
	}
	code, out := run(t, "help")
	if code != 0 {
		t.Fatalf("help exit %d", code)
	}
	for _, w := range []string{"Setup & identity", "Daily loop", "Threads", "Quota", "Manager", "Maintenance",
		"join URL --join-code CODE --name N", "setup [URL] [--join-code CODE]", "AGENTBUS_JOIN_CODE", "AGENTBUS_HUB", "Settings → Agent 加入码",
		"Self-driven agents", "inbox [--max-threads 1]", "heartbeat [--thread T]", "release [--thread T]", "manual"} {
		if !strings.Contains(out, w) {
			t.Errorf("usage lacks %q", w)
		}
	}
	for _, w := range []string{"--tenant", "--home ", " board", " digest", "AGENTBUS_GITHUB_TOKEN"} {
		if strings.Contains(out, w) {
			t.Errorf("usage still mentions %q", w)
		}
	}
	for name := range commands {
		if !strings.Contains(out, name) {
			t.Errorf("usage lacks command %q", name)
		}
	}
}

// TestMain points AGENTBUS_HUB_HOME at an empty dir so a real hub config on
// the developer's machine never leaks into the tests.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "agentbus-hub-home")
	if err == nil {
		os.Setenv("AGENTBUS_HUB_HOME", dir)
	}
	// tests assert the English texts; telemetry is opted in per test
	os.Setenv("AGENTBUS_LANG", "en")
	i18n.Set("en")
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
