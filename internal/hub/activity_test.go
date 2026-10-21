package hub

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func fakeEnv(t *testing.T, tk *Ticker) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(tk.Dir, "fakecli-env.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestTickActivityAndLabels(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	if _, err := tk.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(h.states(), ","); got != "claimed,running,done" {
		t.Fatalf("states %s", got)
	}
	// the model is not known before the first run: the cli alone
	run, done := h.activities[1], h.activities[2]
	if run.ThreadID != "t_1" || run.Detail != "claude" || run.CLI != "claude" || run.Model != "" {
		t.Fatalf("running %+v", run)
	}
	if done.Model != "claude-sonnet-4-5" || done.Detail != "" {
		t.Fatalf("done %+v", done)
	}
	if env := fakeEnv(t, tk); env != "cli=claude model= has_model=false" {
		t.Fatalf("env %s", env)
	}
	// the tick's post names the CLI and the model the run reported
	if len(h.newPosts) != 1 || h.newPosts[0].CLI != "claude" || h.newPosts[0].Model != "claude-sonnet-4-5" {
		t.Fatalf("post labels %+v", h.newPosts)
	}

	// the next tick knows the model from usage.jsonl
	tk.lastModel = ""
	h.activities = nil
	h.addThread("t_2", d("d_2", "p_2"))
	if _, err := tk.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if run := h.activities[1]; run.Detail != "claude · claude-sonnet-4-5" || run.Model != "claude-sonnet-4-5" {
		t.Fatalf("running %+v", run)
	}
	if env := fakeEnv(t, tk); env != "cli=claude model=claude-sonnet-4-5 has_model=true" {
		t.Fatalf("env %s", env)
	}

	// a configured model wins
	tk.Cfg.Model = "opus-x"
	if m := tk.knownModel(); m != "opus-x" {
		t.Fatal(m)
	}
}

func TestTickActivityFailed(t *testing.T) {
	h, tk := tickEnv(t, "fail")
	h.addThread("t_1", d("d_1", "p_1"))
	if _, err := tk.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(h.states(), ","); got != "claimed,running,failed" {
		t.Fatalf("states %s", got)
	}
	f := h.activities[2]
	if !strings.Contains(f.Detail, "model overloaded") || utf8.RuneCountInString(f.Detail) > 120 {
		t.Fatalf("failed %+v", f)
	}
	// failure notices are still posted
	if len(h.newPosts) != 1 || !strings.HasPrefix(h.newPosts[0].Body, noticeFailed) || h.newPosts[0].CLI != "claude" {
		t.Fatalf("posts %+v", h.newPosts)
	}
}

func TestTickActivityOldHub(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.activity404 = true
	h.addThread("t_1", d("d_1", "p_1"))
	h.addThread("t_2", d("d_2", "p_2"))
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitOK || len(out.Threads) != 2 {
		t.Fatalf("%+v %v", out, err)
	}
	for _, to := range out.Threads {
		if !to.Acked || !to.TickPosted || to.ErrorSummary != "" {
			t.Fatalf("%+v", to)
		}
	}
	if !tk.activityOff || len(h.activities) != 0 {
		t.Fatal("a 404 should switch live status off for the tick")
	}
}

func TestFailDetail(t *testing.T) {
	long := strings.Repeat("错", 300)
	if got := failDetail(long); utf8.RuneCountInString(got) != 120 || !strings.HasSuffix(got, "…") {
		t.Fatalf("%d %q", utf8.RuneCountInString(got), got)
	}
	got := failDetail("401 from https://api.example.com/v1?key=abc: Authorization: Bearer sk-ant-0123456789abcdef\nretry")
	if strings.Contains(got, "sk-ant") || strings.Contains(got, "key=abc") || strings.Contains(got, "\n") {
		t.Fatalf("not scrubbed: %q", got)
	}
	if failDetail("") != "failed" {
		t.Fatal("empty summary")
	}
	if runningDetail("codex", "") != "codex" || runningDetail("codex", "gpt-5") != "codex · gpt-5" {
		t.Fatal("running detail")
	}
}

// answered seeds t_1 with an earlier answer of mine to p_1.
func answered(h *fakeHub, kind, body string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.posts["t_1"] = append(h.posts["t_1"], Post{ID: "p_mine", ThreadID: "t_1", AuthorID: "m_1", Kind: kind, Body: body,
		CreatedAt: time.Now().Add(-30 * time.Second).UnixMilli()})
}

func TestTickSkipsNoopRedelivery(t *testing.T) {
	redelivered := Delivery{ID: "d_1", ThreadID: "t_1", PostID: "p_1", Reason: "mention", Attempts: 1}

	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", redelivered)
	answered(h, "progress", "要做什么 → 修测试；改了什么 → x_test.go")
	out, err := tk.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	to := out.Threads[0]
	if !to.SkippedPost || to.TickPosted || !to.Acked || len(h.newPosts) != 0 {
		t.Fatalf("%+v posts=%d", to, len(h.newPosts))
	}
	if len(h.runs) != 1 || h.runs[0].Input != 3200 {
		t.Fatalf("the run is still reported: %+v", h.runs)
	}
	if got := strings.Join(h.states(), ","); got != "claimed,running,done" {
		t.Fatalf("states %s", got)
	}

	// an earlier failure notice is no answer: post
	h, tk = tickEnv(t, "ok")
	h.addThread("t_1", redelivered)
	answered(h, "progress", noticeFailed+"claude 退出码 1。")
	out, _ = tk.Run(context.Background())
	if out.Threads[0].SkippedPost || !out.Threads[0].TickPosted {
		t.Fatalf("%+v", out.Threads[0])
	}

	// a first delivery always gets its fallback post
	h, tk = tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	answered(h, "progress", "older progress")
	out, _ = tk.Run(context.Background())
	if out.Threads[0].SkippedPost || !out.Threads[0].TickPosted {
		t.Fatalf("%+v", out.Threads[0])
	}

	// a re-delivery whose round fails still says so
	h, tk = tickEnv(t, "fail")
	h.addThread("t_1", redelivered)
	answered(h, "progress", "done earlier")
	out, _ = tk.Run(context.Background())
	if out.Threads[0].SkippedPost || !out.Threads[0].TickPosted {
		t.Fatalf("%+v", out.Threads[0])
	}
}

func TestNoopRedeliveryRule(t *testing.T) {
	post := func(id, author, kind string, at int64) Post {
		return Post{ID: id, AuthorID: author, Kind: kind, Body: "x", CreatedAt: at}
	}
	re := func(post string, attempts int) Delivery {
		return Delivery{ID: "d_" + post, PostID: post, Attempts: attempts}
	}
	edited := post("p_me", "m_1", "progress", 100)
	edited.EditedAt = ptr(int64(300))
	for _, c := range []struct {
		name  string
		posts []Post
		ds    []Delivery
		want  bool
	}{
		{"answered", []Post{post("p_1", "m_bob", "msg", 100), post("p_me", "m_1", "progress", 200)}, []Delivery{re("p_1", 1)}, true},
		{"first delivery", []Post{post("p_1", "m_bob", "msg", 100), post("p_me", "m_1", "progress", 200)}, []Delivery{re("p_1", 0)}, false},
		{"one new message", []Post{post("p_1", "m_bob", "msg", 100), post("p_me", "m_1", "progress", 200), post("p_2", "m_bob", "msg", 300)},
			[]Delivery{re("p_1", 1), re("p_2", 1)}, false},
		{"my last post is a msg", []Post{post("p_1", "m_bob", "msg", 100), post("p_me", "m_1", "msg", 200)}, []Delivery{re("p_1", 2)}, false},
		{"never answered", []Post{post("p_1", "m_bob", "msg", 100)}, []Delivery{re("p_1", 1)}, false},
		{"delivered post not shown", []Post{post("p_me", "m_1", "progress", 200)}, []Delivery{re("p_old", 1)}, false},
		{"collapsed progress counts at its edit", []Post{edited, post("p_1", "m_bob", "msg", 200)}, []Delivery{re("p_1", 1)}, true},
		{"no deliveries", []Post{post("p_me", "m_1", "progress", 200)}, nil, false},
	} {
		if got := noopRedelivery(&Context{Posts: c.posts}, c.ds, "m_1"); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestPostV06FieldsDecode(t *testing.T) {
	var pr PostsResp
	err := json.Unmarshal([]byte(`{"posts":[
	  {"id":"p_1","thread_id":"t_1","author_id":"m_1","reply_to":null,"body":"done","kind":"progress","mentions":[],
	   "redacted":false,"usage":null,"reactions":[],"confirmation":null,"created_at":1790000000000,
	   "model":"claude-sonnet-4-5","cli":"claude","edited_at":1790000060000,"revisions":2,
	   "attachments":[{"id":"f_1","name":"report.pdf","mime":"application/pdf","size":1536,"url":"/api/v1/agent/files/f_1"}]},
	  {"id":"p_2","thread_id":"t_1","author_id":"m_bob","body":"hi","kind":"state","created_at":1790000000001,
	   "model":null,"cli":null,"edited_at":null,"revisions":0,"attachments":[]},
	  {"id":"p_3","thread_id":"t_1","author_id":"m_bob","body":"old hub","kind":"msg","created_at":1}],"has_more":false}`), &pr)
	if err != nil {
		t.Fatal(err)
	}
	p := pr.Posts[0]
	if p.Model == nil || *p.Model != "claude-sonnet-4-5" || p.CLI == nil || *p.CLI != "claude" ||
		p.EditedAt == nil || *p.EditedAt != 1790000060000 || p.Revisions != 2 {
		t.Fatalf("%+v", p)
	}
	if len(p.Attachments) != 1 || p.Attachments[0] != (Attachment{ID: "f_1", Name: "report.pdf", Mime: "application/pdf", Size: 1536, URL: "/api/v1/agent/files/f_1"}) {
		t.Fatalf("attachments %+v", p.Attachments)
	}
	for _, q := range pr.Posts[1:] {
		if q.Model != nil || q.CLI != nil || q.EditedAt != nil || q.Revisions != 0 || len(q.Attachments) != 0 {
			t.Fatalf("%s: %+v", q.ID, q)
		}
	}
	if pr.Posts[1].Kind != "state" {
		t.Fatal(pr.Posts[1].Kind)
	}
	// a create reply's collapsed flag
	var cr PostResp
	if err := json.Unmarshal([]byte(`{"post":{"id":"p_1","revisions":3},"collapsed":true}`), &cr); err != nil || !cr.Collapsed || cr.Post.Revisions != 3 {
		t.Fatalf("%+v %v", cr, err)
	}
	// NewPost sends the labels only when set
	b, _ := json.Marshal(NewPost{ThreadID: "t_1", Body: "x", IdempotencyKey: "k"})
	if strings.Contains(string(b), "model") || strings.Contains(string(b), "cli") || strings.Contains(string(b), "attachments") {
		t.Fatal(string(b))
	}
	b, _ = json.Marshal(NewPost{ThreadID: "t_1", Body: "x", IdempotencyKey: "k", Model: "m", CLI: "codex", Attachments: []string{"f_1"}})
	if !strings.Contains(string(b), `"model":"m","cli":"codex","attachments":["f_1"]`) {
		t.Fatal(string(b))
	}
}

func TestPromptAttachmentsAndKinds(t *testing.T) {
	repo := "acme/app"
	c := &Context{
		Workspace: Workspace{ID: "w_1", Name: "app", Goal: "ship", Repo: &repo},
		Thread:    Thread{ID: "t_1", Title: "logs", Status: "open"},
		Posts: []Post{{ID: "p_1", AuthorID: "m_bob", Kind: "msg", Body: "@alice see the log", CreatedAt: 1790000000000,
			Attachments: []Attachment{
				{ID: "f_1", Name: "crash log.txt", Mime: "text/plain", Size: 1536},
				{ID: "f_2", Name: "shot.png", Mime: "image/png", Size: 2_411_725},
				{ID: "f_3", Name: "", Mime: "", Size: 12},
			}}},
		Me: Member{ID: "m_1", Name: "alice", Role: "manager"},
	}
	out, err := BuildPrompt(PromptInput{Ctx: c, Deliveries: []Delivery{{ID: "d_1", PostID: "p_1", Reason: "mention"}}, Round: "d_1:r1", Exe: "agentbus"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"附件：crash log.txt (text/plain, 1.5 KB) → agentbus file get f_1\n",
		"附件：shot.png (image/png, 2.3 MB) → agentbus file get f_2\n",
		"附件：f_3 (application/octet-stream, 12 B) → agentbus file get f_3\n",
		"agentbus post --attach",
		"`state`", "`system`", "`confirm`",
		"合并成一张卡片",
		"什么都没变就不要发进度帖",
		"跟进进度", // manager duties
	} {
		if !strings.Contains(out, want) {
			t.Errorf("prompt lacks %q", want)
		}
	}
	// listed under the post and again under the delivery
	if n := strings.Count(out, "agentbus file get f_2"); n != 2 {
		t.Errorf("f_2 listed %d times", n)
	}
	if strings.Contains(out, "model badge") || strings.Contains(out, "AGENTBUS_MODEL") {
		t.Error("the prompt should not talk about model labels")
	}
	for n, want := range map[int64]string{0: "0 B", 1023: "1023 B", 1024: "1 KB", 1536: "1.5 KB", 10 << 20: "10 MB", 3 << 30: "3 GB"} {
		if got := FmtSize(n); got != want {
			t.Errorf("FmtSize(%d) = %q, want %q", n, got, want)
		}
	}
}
