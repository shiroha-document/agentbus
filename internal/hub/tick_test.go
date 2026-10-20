package hub

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func d(id, post string) Delivery {
	return Delivery{ID: id, ThreadID: "t_1", PostID: post, Reason: "mention"}
}

func TestTickNothingToDo(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitNothing {
		t.Fatalf("%+v %v", out, err)
	}
	if h.quotaCalls != 1 {
		t.Fatalf("quota reported %d times", h.quotaCalls)
	}
	if st := LoadState(tk.Dir); st.LastExit != ExitNothing || st.LastTickAt == 0 {
		t.Fatalf("%+v", st)
	}
}

func TestTickLockHeld(t *testing.T) {
	_, tk := tickEnv(t, "ok")
	unlock, err := TryLock(Paths{tk.Dir}.Lock())
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, err := TryLock(Paths{tk.Dir}.Lock()); err != ErrLocked && !isWindows() {
		t.Fatalf("second TryLock: %v", err)
	}
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitNothing {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestTickPaused(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	h.paused, h.pauseReason = true, "manager: holiday"
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitPaused || !strings.Contains(out.Message, "holiday") {
		t.Fatalf("%+v %v", out, err)
	}
	h.paused, h.pauseReason, h.status = false, "", "pending"
	out, err = tk.Run(context.Background())
	if err != nil || out.Code != ExitPaused || len(h.claims) != 1 {
		t.Fatalf("pending: %+v %v", out, err)
	}
}

func TestTickQuotaExhausted(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	h.quotaPaused = true
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitQuota || !strings.Contains(out.Message, "quota:claude/5h") {
		t.Fatalf("%+v %v", out, err)
	}
	if len(h.claims) != 1 || len(h.runs) != 0 {
		t.Fatal("claimed while quota-paused")
	}
}

func TestTickNormalRound(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitOK || len(out.Threads) != 1 {
		t.Fatalf("%+v %v", out, err)
	}
	to := out.Threads[0]
	if !to.Acked || to.Nacked || !to.TickPosted || to.AgentPosted || to.ErrorSummary != "" {
		t.Fatalf("%+v", to)
	}
	ps := h.posts["t_1"]
	last := ps[len(ps)-1]
	if last.Kind != "progress" || !strings.HasPrefix(last.Body, "Fixed the flaky test") ||
		!strings.Contains(last.Body, "本轮 31.2k 输入（缓存 28k）/ 0.9k 输出 · 约 $0.04 · ") {
		t.Fatalf("progress post: %+v", last)
	}
	if last.Usage == nil || last.Usage.Input != 3200 || last.Usage.CacheRead != 28000 {
		t.Fatalf("usage: %+v", last.Usage)
	}
	if _, ok := h.keys["d_1:r1"]; !ok {
		t.Fatalf("idempotency key: %v", h.keys)
	}
	if len(h.acks) != 1 || !strings.Contains(h.acks[0], `"d_1"`) {
		t.Fatalf("acks %v", h.acks)
	}
	if len(h.runs) != 1 || h.runs[0].Input != 3200 || h.runs[0].ExitCode != 0 || h.runs[0].CLI != "claude" ||
		h.runs[0].Model == nil || *h.runs[0].Model != "claude-sonnet-4-5" || h.runs[0].ThreadID == nil {
		t.Fatalf("runs %+v", h.runs)
	}
	es, _ := ReadUsage(Paths{tk.Dir}.Usage())
	if len(es) != 1 || !es[0].Reported {
		t.Fatalf("usage.jsonl %+v", es)
	}
	// the CLI ran in a per-agent work dir (repo not mapped) and saw the prompt file
	if _, err := os.Stat(filepath.Join(tk.Dir, "work", "app")); err != nil {
		t.Fatal(err)
	}
	if h.quotaCalls != 2 {
		t.Fatalf("quota calls %d", h.quotaCalls)
	}
}

func TestTickRepoMapping(t *testing.T) {
	_, tk := tickEnv(t, "ok")
	repo := t.TempDir()
	if err := SaveRepos(Paths{tk.Dir}.Repos(), Repos{"acme/app": repo}); err != nil {
		t.Fatal(err)
	}
	r := "https://github.com/Acme/app.git"
	dir, note := tk.workDir(&Context{Workspace: Workspace{Name: "app", Repo: &r}})
	if dir != repo || note != "" {
		t.Fatalf("%s %q", dir, note)
	}
}

func TestTickFailedRound(t *testing.T) {
	h, tk := tickEnv(t, "fail")
	h.addThread("t_1", d("d_1", "p_1"))
	out, _ := tk.Run(context.Background())
	to := out.Threads[0]
	if !to.Acked || !to.TickPosted || !strings.Contains(to.ErrorSummary, "model overloaded") {
		t.Fatalf("%+v", to)
	}
	ps := h.posts["t_1"]
	if b := ps[len(ps)-1].Body; !strings.Contains(b, "本轮失败") || !strings.Contains(b, "本轮用量未知") {
		t.Fatal(b)
	}
	if h.runs[0].ExitCode != 1 || h.runs[0].ErrorSummary == nil {
		t.Fatalf("%+v", h.runs[0])
	}
}

func TestTickTimeout(t *testing.T) {
	h, tk := tickEnv(t, "sleep")
	tk.Timeout = 1500 * time.Millisecond
	tk.HeartbeatEvery = 200 * time.Millisecond
	h.addThread("t_1", d("d_1", "p_1"))
	start := time.Now()
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitOK {
		t.Fatalf("%+v %v", out, err)
	}
	if time.Since(start) > 15*time.Second {
		t.Fatal("process was not killed")
	}
	to := out.Threads[0]
	if !to.TimedOut || !to.Nacked || to.Acked || !to.TickPosted {
		t.Fatalf("%+v", to)
	}
	ps := h.posts["t_1"]
	if b := ps[len(ps)-1].Body; !strings.Contains(b, "超时") {
		t.Fatal(b)
	}
	if len(h.nacks) != 1 || len(h.acks) != 0 || h.heartbeats == 0 {
		t.Fatalf("nacks=%v acks=%v hb=%d", h.nacks, h.acks, h.heartbeats)
	}
	if len(h.runs) != 1 || h.runs[0].ExitCode != 124 {
		t.Fatalf("%+v", h.runs)
	}
}

func TestTickAgentPostedProgress(t *testing.T) {
	h, tk := tickEnv(t, "post")
	h.addThread("t_1", d("d_1", "p_1"))
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitOK {
		t.Fatalf("%+v %v", out, err)
	}
	to := out.Threads[0]
	if !to.AgentPosted || to.TickPosted || !to.Acked {
		t.Fatalf("%+v", to)
	}
	n := 0
	for _, p := range h.posts["t_1"] {
		if p.Kind == "progress" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d progress posts", n)
	}
	if len(h.runs) != 1 || h.runs[0].Input != 3200 {
		t.Fatalf("%+v", h.runs)
	}
}

func TestTickResendsUnreportedRuns(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	th := "t_old"
	if err := AppendUsage(Paths{tk.Dir}.Usage(), UsageEntry{Run: Run{ID: "r_old", MemberID: "m_1", ThreadID: &th, CLI: "claude"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := tk.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.runs) != 1 || h.runs[0].ID != "r_old" {
		t.Fatalf("%+v", h.runs)
	}
	if len(Unreported(Paths{tk.Dir}.Usage())) != 0 {
		t.Fatal("still unreported")
	}
}

func TestReposAndRoundKey(t *testing.T) {
	p := filepath.Join(t.TempDir(), "repos.toml")
	_ = os.WriteFile(p, []byte("# x\n\"Acme/App\" = \"/src/app\"\n[repos]\nfoo/bar = '/src/bar' # c\n[other]\nx = \"y\"\n"), 0o600)
	r, err := LoadRepos(p)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := r.Lookup("git@github.com:acme/app.git"); !ok || v != "/src/app" {
		t.Fatal(r)
	}
	if v, ok := r.Lookup("foo/bar"); !ok || v != "/src/bar" || len(r) != 2 {
		t.Fatal(r)
	}
	_ = os.WriteFile(p, []byte("nonsense line\n"), 0o600)
	if _, err := LoadRepos(p); err == nil {
		t.Fatal("want parse error")
	}
	if k := RoundKey([]Delivery{{ID: "d_b", Attempts: 0}, {ID: "d_a", Attempts: 2}}); k != "d_a:r3" {
		t.Fatal(k)
	}
}

func TestUsageFooter(t *testing.T) {
	c := 0.04
	got := UsageFooter(&UsageView{Known: true, TotalInput: 31200, Cached: 28000, Output: 900, Cost: &c}, 133*time.Second)
	if got != "本轮 31.2k 输入（缓存 28k）/ 0.9k 输出 · 约 $0.04 · 2m13s" {
		t.Fatal(got)
	}
	if got := UsageFooter(nil, 45*time.Second); got != "本轮用量未知 · 45s" {
		t.Fatal(got)
	}
}
