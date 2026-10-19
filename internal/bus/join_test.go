package bus

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeGH is an in-process GitHub API (RoundTripper, no listener).
type fakeGH struct {
	mu       sync.Mutex
	keys     []DeployKey
	comments []string
	issues   map[string]map[string]any
	perms    map[string]string
	nextID   int64
}

func (f *fakeGH) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var in map[string]any
	if r.Body != nil {
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &in)
	}
	p := r.URL.Path
	reply := func(code int, v any) (*http.Response, error) {
		b, _ := json.Marshal(v)
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(string(b))), Header: http.Header{}}, nil
	}
	switch {
	case r.Method == "POST" && strings.HasSuffix(p, "/keys"):
		for _, k := range f.keys {
			if keyCore(k.Key) == keyCore(in["key"].(string)) {
				return reply(422, map[string]string{"message": "key is already in use"})
			}
		}
		f.nextID++
		k := DeployKey{ID: f.nextID, Key: in["key"].(string), Title: in["title"].(string), ReadOnly: in["read_only"].(bool)}
		f.keys = append(f.keys, k)
		return reply(201, k)
	case r.Method == "GET" && strings.HasSuffix(p, "/keys"):
		return reply(200, f.keys)
	case r.Method == "DELETE" && strings.Contains(p, "/keys/"):
		var keep []DeployKey
		for _, k := range f.keys {
			if !strings.HasSuffix(p, "/keys/"+itoa(k.ID)) {
				keep = append(keep, k)
			}
		}
		f.keys = keep
		return reply(204, nil)
	case strings.HasSuffix(p, "/comments"):
		f.comments = append(f.comments, in["body"].(string))
		return reply(201, map[string]any{})
	case strings.Contains(p, "/collaborators/"):
		user := strings.TrimSuffix(p[strings.Index(p, "/collaborators/")+len("/collaborators/"):], "/permission")
		if perm, ok := f.perms[user]; ok {
			return reply(200, map[string]string{"permission": perm})
		}
		return reply(404, map[string]string{"message": "not found"})
	case r.Method == "PATCH" || strings.HasSuffix(p, "/labels"):
		if f.issues == nil {
			f.issues = map[string]map[string]any{}
		}
		f.issues[p] = in
		return reply(200, map[string]any{})
	}
	return reply(404, map[string]string{"message": "unhandled " + r.Method + " " + p})
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func (f *fakeGH) client() *GitHub {
	return &GitHub{Token: "t", API: "https://api.test", HTTP: &http.Client{Transport: f}}
}

func TestJoinRequestRoundTrip(t *testing.T) {
	home := t.TempDir()
	_, pub, err := EnsureKey(home, "dave")
	if err != nil {
		t.Fatal(err)
	}
	r := &JoinRequest{Name: "dave", PublicKey: pub, Capabilities: []string{"gpu"}, Wake: "poll", Owner: "octocat", At: time.Now().UTC()}
	got, err := ParseJoinRequest("noise\r\n" + strings.ReplaceAll(r.IssueBody(), "\n", "\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "dave" || got.PublicKey != pub || got.Capabilities[0] != "gpu" {
		t.Fatalf("round trip %+v", got)
	}
	if _, err := ParseJoinRequest("```json\n{\"name\":\"x\"}\n```"); err == nil {
		t.Fatal("body without marker must be rejected")
	}
	bad := *r
	bad.Name = "Bad Name"
	if err := bad.Validate(); err == nil {
		t.Fatal("bad name accepted")
	}
	bad = *r
	bad.PublicKey = "ssh-rsa AAAA; rm -rf /"
	if err := bad.Validate(); err == nil {
		t.Fatal("bad key accepted")
	}
	u := NewIssueURL("o/r", r)
	if !strings.HasPrefix(u, "https://github.com/o/r/issues/new?") || !strings.Contains(u, "labels=agentbus-join") {
		t.Fatal(u)
	}
}

func TestJoinApproveRevoke(t *testing.T) {
	remote := newRemote(t)
	alice := agent(t, remote, "alice")
	gh := &fakeGH{}
	dhome := filepath.Join(filepath.Dir(remote), "dave")

	st, err := Join(JoinOpts{Home: dhome, Remote: remote, Request: JoinRequest{Name: "dave", Capabilities: []string{"gpu"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CheckJoin(dhome, nil); !errors.Is(err, ErrJoinPending) {
		t.Fatalf("want pending before approval, got %v", err)
	}
	m, err := Approve(ApproveOpts{Remote: remote, Repo: "o/r", GH: gh.client(), WorkDir: t.TempDir(), Approver: "boss"}, &st.Request)
	if err != nil {
		t.Fatal(err)
	}
	if len(gh.keys) != 1 || gh.keys[0].ReadOnly || gh.keys[0].Title != "agentbus:dave" {
		t.Fatalf("deploy key %+v", gh.keys)
	}
	// idempotent
	if _, err := Approve(ApproveOpts{Remote: remote, Repo: "o/r", GH: gh.client(), WorkDir: t.TempDir(), Approver: "boss"}, &st.Request); err != nil {
		t.Fatalf("re-approve: %v", err)
	}
	dave, err := CheckJoin(dhome, nil)
	if err != nil {
		t.Fatal(err)
	}
	if dave.Me() != "dave" {
		t.Fatal(dave.Me())
	}
	if st, _ := LoadJoin(dhome); st != nil {
		t.Fatal("join state should be cleared")
	}
	noErr(t, alice.Sync())
	ps := chk(alice.Profiles())
	if ps["dave"] == nil || ps["dave"].Capabilities[0] != "gpu" {
		t.Fatalf("profile %+v", ps["dave"])
	}
	if ms := chk(alice.Members()); ms["dave"].ApprovedBy != "boss" || ms["dave"].KeySHA256 != m.KeySHA256 {
		t.Fatalf("member %+v", ms["dave"])
	}

	// someone else tries to take the name
	ehome := filepath.Join(filepath.Dir(remote), "eve")
	est, err := Join(JoinOpts{Home: ehome, Remote: remote, Request: JoinRequest{Name: "dave"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Approve(ApproveOpts{Remote: remote, WorkDir: t.TempDir()}, &est.Request); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("want ErrNameTaken, got %v", err)
	}
	if _, err := CheckJoin(ehome, nil); !errors.Is(err, ErrJoinDenied) {
		t.Fatalf("eve should be denied, got %v", err)
	}

	chk(dave.Send([]string{"alice"}, "before", "", nil, "", 0))
	if _, err := Revoke(ApproveOpts{Remote: remote, Repo: "o/r", GH: gh.client(), WorkDir: t.TempDir(), Approver: "boss"}, "dave"); err != nil {
		t.Fatal(err)
	}
	if len(gh.keys) != 0 {
		t.Fatal("deploy key not removed")
	}
	time.Sleep(10 * time.Millisecond)
	chk(dave.Send([]string{"alice"}, "after", "", nil, "", 0))
	noErr(t, alice.Sync())
	var subjects []string
	for _, e := range chk(alice.Events()) {
		if e.From == "dave" && e.Kind == KindMessage {
			subjects = append(subjects, e.Subject)
		}
	}
	if strings.Join(subjects, ",") != "before" {
		t.Fatalf("after revoke, events = %v", subjects)
	}
	if ps := chk(alice.Profiles()); ps["dave"] != nil {
		t.Fatal("revoked profile still listed")
	}
}

func TestCanWrite(t *testing.T) {
	gh := &fakeGH{perms: map[string]string{"boss": "admin", "dev": "write", "fan": "read"}}
	c := gh.client()
	for user, want := range map[string]bool{"boss": true, "dev": true, "fan": false, "stranger": false} {
		got, err := c.CanWrite("o/r", user)
		if err != nil || got != want {
			t.Fatalf("%s: got %v %v", user, got, err)
		}
	}
	if repo, n, ok := ParseIssueURL("https://github.com/o/r/issues/12"); !ok || repo != "o/r" || n != 12 {
		t.Fatal(repo, n, ok)
	}
	if r, ok := GitHubRepo("git@github.com:o/r.git"); !ok || r != "o/r" {
		t.Fatal(r)
	}
}
