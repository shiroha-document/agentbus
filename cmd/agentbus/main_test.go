package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/agentbus/agentbus/internal/bus"
)

// fakeAPI records GitHub calls; installed as http.DefaultTransport.
type fakeAPI struct {
	mu       sync.Mutex
	perms    map[string]string
	keys     int
	comments []string
	closed   string
	labels   []string
}

func (f *fakeAPI) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var in map[string]any
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &in)
	}
	p := r.URL.Path
	code, out := 200, any(map[string]any{})
	switch {
	case strings.Contains(p, "/collaborators/"):
		u := strings.TrimSuffix(strings.SplitN(p, "/collaborators/", 2)[1], "/permission")
		if perm, ok := f.perms[u]; ok {
			out = map[string]string{"permission": perm}
		} else {
			code = 404
		}
	case r.Method == "POST" && strings.HasSuffix(p, "/keys"):
		f.keys++
		code, out = 201, map[string]any{"id": f.keys, "key": in["key"], "read_only": in["read_only"]}
	case strings.HasSuffix(p, "/comments"):
		f.comments = append(f.comments, in["body"].(string))
	case strings.HasSuffix(p, "/labels"):
		for _, l := range in["labels"].([]any) {
			f.labels = append(f.labels, l.(string))
		}
	case r.Method == "PATCH":
		f.closed, _ = in["state_reason"].(string)
	default:
		code = 404
	}
	b, _ := json.Marshal(out)
	return &http.Response{StatusCode: code, Body: io.NopCloser(bytes.NewReader(b)), Header: http.Header{}}, nil
}

func run(t *testing.T, args ...string) (int, string) {
	t.Helper()
	var out, errw bytes.Buffer
	c := &cli{out: &out, errw: &errw}
	code := c.run(args)
	return code, out.String() + errw.String()
}

func TestHandleIssueFlow(t *testing.T) {
	dir := t.TempDir()
	remote := filepath.Join(dir, "bus.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", remote).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	t.Setenv("AGENTBUS_HOME", filepath.Join(dir, "alice"))
	if code, out := run(t, "init", "--remote", remote, "--me", "alice"); code != 0 {
		t.Fatal(out)
	}

	api := &fakeAPI{perms: map[string]string{"boss": "admin", "rando": "read"}}
	old := http.DefaultTransport
	http.DefaultTransport = api
	defer func() { http.DefaultTransport = old }()
	t.Setenv("AGENTBUS_GITHUB_API", "https://api.test")
	t.Setenv("GITHUB_TOKEN", "gha")
	t.Setenv("AGENTBUS_ADMIN_TOKEN", "pat")
	t.Setenv("AGENTBUS_GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "")

	// agent side: request filed by the agent itself
	dhome := filepath.Join(dir, "dave")
	t.Setenv("AGENTBUS_HOME", dhome)
	if code, out := run(t, "join", "--remote", remote, "--me", "dave", "--cap", "gpu", "--no-issue"); code != exitNothing {
		t.Fatalf("join should be pending (3), got %d: %s", code, out)
	}
	st, err := bus.LoadJoin(dhome)
	if err != nil || st == nil {
		t.Fatal(err)
	}
	body := st.Request.IssueBody() + "\n" + bus.FiledByAgentMarker + "\n"

	event := func(name string, ev map[string]any) string {
		ev["repository"] = map[string]any{"full_name": "o/r"}
		iss := map[string]any{"number": 7, "html_url": "https://github.com/o/r/issues/7", "body": body, "user": map[string]any{"login": "dave-bot"}}
		ev["issue"] = iss
		b, _ := json.Marshal(ev)
		p := filepath.Join(dir, name+".json")
		os.WriteFile(p, b, 0o600)
		return p
	}
	handle := func(ev string) (int, string) {
		return run(t, "admin", "handle-issue", "--event", ev, "--remote", remote)
	}
	members := func() map[string]*bus.Member {
		g := exec.Command("git", "--git-dir", remote, "show", "agent-bus:members/dave.json")
		out, err := g.Output()
		if err != nil {
			return nil
		}
		var m bus.Member
		_ = json.Unmarshal(out, &m)
		return map[string]*bus.Member{"dave": &m}
	}

	// 1. opened by the agent: never auto-approved, just acknowledged
	if code, out := handle(event("opened", map[string]any{"action": "opened", "sender": map[string]any{"login": "dave-bot", "type": "User"}})); code != 0 {
		t.Fatal(out)
	}
	if members() != nil || api.keys != 0 || len(api.comments) != 1 {
		t.Fatalf("agent-filed issue must not approve: keys=%d comments=%v", api.keys, api.comments)
	}
	// 2. /approve from a non-maintainer is ignored
	ev := event("c1", map[string]any{"action": "created", "sender": map[string]any{"login": "rando", "type": "User"},
		"comment": map[string]any{"body": "/approve", "user": map[string]any{"login": "rando"}}})
	if code, out := handle(ev); code != 0 || members() != nil {
		t.Fatalf("non-maintainer approved?! %d %s", code, out)
	}
	// 3. /approve from a maintainer
	ev = event("c2", map[string]any{"action": "created", "sender": map[string]any{"login": "boss", "type": "User"},
		"comment": map[string]any{"body": "LGTM\n/approve", "user": map[string]any{"login": "boss"}}})
	if code, out := handle(ev); code != 0 {
		t.Fatal(out)
	}
	m := members()
	if m == nil || m["dave"].ApprovedBy != "boss" || api.keys != 1 || api.closed != "completed" {
		t.Fatalf("approve failed: m=%v keys=%d closed=%q comments=%v", m, api.keys, api.closed, api.comments)
	}
	// 4. agent completes its join
	if code, out := run(t, "join", "--wait", "5s", "--interval", "1s"); code != 0 || !strings.Contains(out, "approved") {
		t.Fatalf("join completion %d: %s", code, out)
	}
	if code, out := run(t, "whoami"); code != 0 || !strings.Contains(out, "dave") {
		t.Fatal(out)
	}
}

func TestParsePassthrough(t *testing.T) {
	fs := newFlags("x")
	claim := fs.Bool("claim", false, "")
	pos, err := parse(fs, []string{"ID", "--claim", "--", "sh", "-c", "echo --claim"})
	if err != nil || !*claim || strings.Join(pos, "|") != "ID|sh|-c|echo --claim" {
		t.Fatalf("%v %v %q", err, *claim, pos)
	}
}
