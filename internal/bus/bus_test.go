package bus

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newRemote(t *testing.T) string {
	t.Helper()
	r := filepath.Join(t.TempDir(), "bus.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", r).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	return r
}

func agent(t *testing.T, remote, name string, caps ...string) *Bus {
	t.Helper()
	home := filepath.Join(filepath.Dir(remote), name)
	b, err := Init(home, remote, "", Profile{Name: name, Capabilities: caps, Channels: []string{"build"}}, "")
	if err != nil {
		t.Fatalf("init %s: %v", name, err)
	}
	b.Warn = os.Stderr
	return b
}

// chk unwraps (v, err); a non-nil err panics, which fails the test.
func chk[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func noErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func level(t *testing.T, b *Bus, id, who string) string {
	t.Helper()
	if err := b.Sync(); err != nil {
		t.Fatal(err)
	}
	_, rs := must2(t, b, id)
	for _, r := range rs {
		if r.Agent == who {
			return r.Level
		}
	}
	return "?"
}

func must2(t *testing.T, b *Bus, id string) (*Event, []RcptStatus) {
	e, rs, err := b.Status(id)
	if err != nil {
		t.Fatal(err)
	}
	return e, rs
}

func TestReceiptsLifecycle(t *testing.T) {
	r := newRemote(t)
	alice, bob := agent(t, r, "alice"), agent(t, r, "bob")
	m := chk(alice.Send([]string{"bob"}, "hi", "hello", nil, "", 30*time.Minute))
	if l := level(t, alice, m.ID, "bob"); l != "" {
		t.Fatalf("before bob syncs: %q", l)
	}
	chk(bob.Inbox(false, false))
	if err := bob.Sync(); err != nil {
		t.Fatal(err)
	}
	if l := level(t, alice, m.ID, "bob"); l != RcptDelivered {
		t.Fatalf("want delivered got %q", l)
	}
	chk(bob.Read(m.ID))
	if l := level(t, alice, m.ID, "bob"); l != RcptRead {
		t.Fatalf("want read got %q", l)
	}
	if _, err := bob.Receipt(m.ID, RcptRejected, ""); err == nil {
		t.Fatal("reject without reason must fail")
	}
	chk(bob.Receipt(m.ID, RcptAccepted, ""))
	if l := level(t, alice, m.ID, "bob"); l != RcptAccepted {
		t.Fatalf("want accepted got %q", l)
	}
	// receipts never go backwards
	chk(bob.Read(m.ID))
	if l := level(t, alice, m.ID, "bob"); l != RcptAccepted {
		t.Fatalf("receipt regressed to %q", l)
	}
}

func TestOverdue(t *testing.T) {
	r := newRemote(t)
	alice, _ := agent(t, r, "alice"), agent(t, r, "bob")
	m := chk(alice.Send([]string{"bob"}, "need ack", "", nil, "", time.Minute))
	alice.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	alice.loaded = false
	ov := chk(alice.Overdue(""))
	if len(ov) != 1 || ov[0].Event.ID != m.ID || ov[0].Pending[0] != "bob" {
		t.Fatalf("overdue = %+v", ov)
	}
}

func TestChannelTaskClaimRaceAndRun(t *testing.T) {
	r := newRemote(t)
	alice := agent(t, r, "alice")
	bob, carol, dan := agent(t, r, "bob", "docker"), agent(t, r, "carol", "docker"), agent(t, r, "dan")
	task := chk(alice.CreateTask([]string{"#build"}, "img", "build it", TaskSpec{Requires: []string{"docker"}, HeartbeatSec: 60, MaxAttempts: 2,
		Deadline: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, nil))

	if _, err := dan.Claim(task.ID); !errors.Is(err, ErrNotClaimable) {
		t.Fatalf("dan lacks docker; got %v", err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, b := range []*Bus{bob, carol} {
		wg.Add(1)
		go func() { defer wg.Done(); _, errs[i] = b.Claim(task.ID) }()
	}
	wg.Wait()
	wins := 0
	for _, err := range errs {
		if err == nil {
			wins++
		} else if !errors.Is(err, ErrClaimLost) && !errors.Is(err, ErrNotClaimable) {
			t.Fatalf("unexpected claim error: %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("want exactly one winner, errs=%v", errs)
	}
	noErr(t, alice.Sync())
	v := chk(alice.Task(task.ID))
	if v.State != TaskRunning || v.Attempt != 1 {
		t.Fatalf("view %+v", v)
	}
	winner := map[string]*Bus{"bob": bob, "carol": carol}[v.Claimer]
	loser := map[string]*Bus{"bob": carol, "carol": bob}[v.Claimer]
	if _, err := loser.Progress(task.ID, 1, "x", 1, ""); !errors.Is(err, ErrFenced) {
		t.Fatalf("loser progress should be fenced: %v", err)
	}
	chk(winner.Progress(task.ID, 1, "compile", 50, "log line"))
	chk(winner.Complete(task.ID, 1, TaskSucceeded, "done", "", nil))
	noErr(t, alice.Sync())
	v = chk(alice.Task(task.ID))
	if v.State != TaskSucceeded || v.Last.Percent != 50 {
		t.Fatalf("final %+v", v)
	}
	brief := chk(alice.Brief(task.ID))
	if !strings.Contains(brief, "succeeded") {
		t.Fatalf("brief missing state:\n%s", brief)
	}
}

func TestStaleReclaimAndFencing(t *testing.T) {
	r := newRemote(t)
	alice, bob, carol := agent(t, r, "alice"), agent(t, r, "bob"), agent(t, r, "carol")
	task := chk(alice.CreateTask([]string{"bob", "carol"}, "long", "", TaskSpec{HeartbeatSec: 10, MaxAttempts: 2,
		Deadline: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, nil))
	chk(bob.Claim(task.ID))
	// carol looks 1 minute later: bob missed 3 beats
	later := func() time.Time { return time.Now().Add(time.Minute) }
	carol.Now = later
	if err := carol.Sync(); err != nil {
		t.Fatal(err)
	}
	v := chk(carol.Task(task.ID))
	if v.State != TaskStale || !v.Claimable {
		t.Fatalf("want stale, got %s (%s)", v.State, v.Reason)
	}
	v = chk(carol.Claim(task.ID))
	if v.Attempt != 2 || v.Claimer != "carol" {
		t.Fatalf("reclaim %+v", v)
	}
	// bob wakes up and is fenced
	if _, err := bob.Progress(task.ID, 1, "still here", 90, ""); !errors.Is(err, ErrFenced) {
		t.Fatalf("bob should be fenced, got %v", err)
	}
	if _, err := bob.Complete(task.ID, 1, TaskSucceeded, "", "", nil); !errors.Is(err, ErrFenced) {
		t.Fatalf("bob complete should be fenced, got %v", err)
	}
	// carol also dies -> attempts exhausted
	alice.Now = func() time.Time { return time.Now().Add(5 * time.Minute) }
	noErr(t, alice.Sync())
	v = chk(alice.Task(task.ID))
	if v.State != TaskFailed || v.Claimable {
		t.Fatalf("want failed/exhausted, got %s claimable=%v", v.State, v.Claimable)
	}
}

func TestCancelOnlyByIssuer(t *testing.T) {
	r := newRemote(t)
	alice, bob := agent(t, r, "alice"), agent(t, r, "bob")
	task := chk(alice.CreateTask([]string{"bob"}, "t", "", TaskSpec{Deadline: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, nil))
	chk(bob.Claim(task.ID))
	if _, err := bob.Cancel(task.ID, "nope"); err == nil {
		t.Fatal("claimer must not cancel")
	}
	chk(alice.Cancel(task.ID, "changed plans"))
	if _, err := bob.Progress(task.ID, 1, "x", 1, ""); !errors.Is(err, ErrCancelled) {
		t.Fatalf("want ErrCancelled, got %v", err)
	}
	chk(bob.Complete(task.ID, 1, TaskCancelled, "", "stopped", nil))
	noErr(t, alice.Sync())
	if v := chk(alice.Task(task.ID)); v.State != TaskCancelled {
		t.Fatalf("state %s", v.State)
	}
}

func TestDeadlineExpires(t *testing.T) {
	r := newRemote(t)
	alice := agent(t, r, "alice")
	task := chk(alice.CreateTask([]string{"*"}, "t", "", TaskSpec{Deadline: time.Now().Add(time.Second).UTC().Format(time.RFC3339)}, nil))
	alice.Now = func() time.Time { return time.Now().Add(time.Hour) }
	alice.loaded = false
	if v := chk(alice.Task(task.ID)); v.State != TaskExpired || v.Claimable {
		t.Fatalf("state %s", v.State)
	}
}

func TestForgedEventIgnored(t *testing.T) {
	r := newRemote(t)
	alice, mallory := agent(t, r, "alice"), agent(t, r, "mallory")
	// mallory writes an event claiming to be from alice into her own dir
	e := Event{V: Version, ID: NewID(time.Now()), TS: time.Now().UTC(), From: "alice", Kind: KindMessage, To: []string{"*"}, Body: "forged"}
	rel := filepath.Join("events", "mallory", time.Now().UTC().Format("2006-01"), e.ID+".json")
	noErr(t, writeJSON(filepath.Join(mallory.Git.Dir, rel), e))
	noErr(t, mallory.Git.Commit("forge", rel))
	noErr(t, mallory.Git.Push())
	noErr(t, alice.Sync())
	evs := chk(alice.Events())
	for _, x := range evs {
		if x.Body == "forged" {
			t.Fatal("forged event was accepted")
		}
	}
}

func TestRedactionAndBlobs(t *testing.T) {
	r := newRemote(t)
	alice, bob := agent(t, r, "alice"), agent(t, r, "bob")
	f := filepath.Join(t.TempDir(), "log.txt")
	os.WriteFile(f, []byte("ok\nAPI_TOKEN=abcd1234secret\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n"), 0o600)
	m := chk(alice.Send([]string{"bob"}, "s", "use sk-abcdefghijklmnopqrstuvwx please", []string{f}, "", 0))
	if strings.Contains(m.Body, "sk-abcdefghijkl") {
		t.Fatalf("body not redacted: %s", m.Body)
	}
	noErr(t, bob.Sync())
	data := chk(bob.GetBlob(m.Attach[0].SHA256))
	if strings.Contains(string(data), "abcd1234secret") || strings.Contains(string(data), "ghp_abcdef") {
		t.Fatalf("blob not redacted: %s", data)
	}
}

func TestWaitWakesOnNewEvent(t *testing.T) {
	r := newRemote(t)
	alice, bob := agent(t, r, "alice"), agent(t, r, "bob")
	go func() {
		time.Sleep(1500 * time.Millisecond)
		_, _ = bob.Send([]string{"alice"}, "ping", "", nil, "", 0)
	}()
	evs := chk(alice.Wait(t.Context(), 20*time.Second, 300*time.Millisecond, nil))
	if len(evs) == 0 || evs[0].Subject != "ping" {
		t.Fatalf("wait got %+v", evs)
	}
	evs = chk(alice.Wait(t.Context(), time.Second, 300*time.Millisecond, nil))
	if len(evs) != 0 {
		t.Fatalf("second wait should be empty, got %d", len(evs))
	}
}

func TestDigest(t *testing.T) {
	r := newRemote(t)
	alice := agent(t, r, "alice")
	p := Profile{Name: "alice", Owner: "octocat"}
	noErr(t, alice.PublishProfile(p))
	chk(alice.Send([]string{"human"}, "need a decision", "pick A or B", nil, "", 0))
	ci := chk(OpenRemote(r, "", t.TempDir()))
	md := chk(ci.Digest(DigestOpts{Since: time.Now().Add(-time.Hour), Level: DigestImportant}))
	if !strings.Contains(md, "For humans") || !strings.Contains(md, "@octocat") || !strings.Contains(md, "pick A or B") {
		t.Fatalf("digest:\n%s", md)
	}
	md = chk(ci.Digest(DigestOpts{Since: time.Now().Add(-time.Hour), Level: DigestAlerts}))
	if md != "" {
		t.Fatalf("alerts digest should be empty:\n%s", md)
	}
}
