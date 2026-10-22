package hub

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/adapter"
	"github.com/shiroha-document/agentbus/internal/quota"
)

// Exit codes of `agentbus tick` (hub-api.md §8).
const (
	ExitOK      = 0
	ExitErr     = 1
	ExitUsage   = 2
	ExitNothing = 3
	ExitPaused  = 4
	ExitQuota   = 5
)

// ErrLocked means another tick holds the process lock.
var ErrLocked = errors.New("another agentbus tick is running")

// Ticker runs one round (hub.md §7).
type Ticker struct {
	Dir     string
	Cfg     *Config
	Client  *Client
	Version string
	Exe     string // this binary, for the prompt and the child's PATH
	Log     io.Writer

	MaxThreads     int
	Timeout        time.Duration // per CLI run (default 20m)
	DryRun         bool
	HeartbeatEvery time.Duration // default 5m
	KillGrace      time.Duration // default 10s

	// Quota collects readings (default quota.Collect with Cfg.QuotaSource).
	Quota func(ctx context.Context) []quota.Reading
	// LookPath resolves CLI binaries (default exec.LookPath).
	LookPath func(string) (string, error)
	Now      func() time.Time

	activityOff bool   // the hub answered 404 to a live-status report
	lastModel   string // the model the last run of this tick reported
}

// Outcome is what one tick did.
type Outcome struct {
	Code    int
	Message string
	Threads []ThreadOutcome
}

// ThreadOutcome describes one processed thread.
type ThreadOutcome struct {
	ThreadID    string
	Acked       bool
	Nacked      bool
	TimedOut    bool
	AgentPosted bool // the agent wrote a post of its own this round
	TickPosted  bool
	// SkippedPost: a successful round that needs no fallback post — a no-op
	// re-delivery (see noopRedelivery), or the agent said nothing / NO_REPLY
	SkippedPost  bool
	ErrorSummary string
	Run          *Run
}

func (t *Ticker) logf(format string, a ...any) {
	if t.Log != nil {
		fmt.Fprintf(t.Log, "agentbus tick: "+format+"\n", a...)
	}
}

func (t *Ticker) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

func (t *Ticker) paths() Paths { return Paths{t.Dir} }

// Run executes one tick and returns its outcome; Code is the process exit
// code. err is set for hard failures (Code 1).
func (t *Ticker) Run(ctx context.Context) (Outcome, error) {
	unlock, err := TryLock(t.paths().Lock())
	if errors.Is(err, ErrLocked) {
		return Outcome{Code: ExitNothing, Message: "another tick is still running"}, nil
	}
	if err != nil {
		return Outcome{Code: ExitErr}, err
	}
	defer unlock()
	out, err := t.run(ctx)
	st := LoadState(t.Dir)
	st.LastTickAt = t.now().UnixMilli()
	st.LastExit = out.Code
	st.LastError = ""
	if err != nil {
		st.LastError = err.Error()
	}
	for _, th := range out.Threads {
		if th.Run != nil {
			st.LastRunAt = th.Run.EndedAt
			st.LastThread = th.ThreadID
		}
	}
	_ = SaveState(t.Dir, st)
	return out, err
}

// gate reads the member state and stops the round when the agent is
// pending, revoked or (not quota-)paused. stop != nil ends the round.
func (t *Ticker) gate(ctx context.Context) (s *State, quotaPaused bool, stop *Outcome, err error) {
	s, err = t.Client.State(ctx)
	if err != nil {
		return nil, false, &Outcome{Code: ExitErr}, err
	}
	switch s.Member.Status {
	case "pending":
		return s, false, &Outcome{Code: ExitPaused, Message: "等待管理员在网页上批准"}, nil
	case "revoked":
		return s, false, &Outcome{Code: ExitErr}, errors.New("this agent was revoked on the hub; join again with a new name")
	}
	quotaPaused = s.Member.Paused && s.Member.PauseReason != nil && strings.HasPrefix(*s.Member.PauseReason, "quota:")
	if s.GlobalPause {
		return s, quotaPaused, &Outcome{Code: ExitPaused, Message: "hub is globally paused"}, nil
	}
	if s.Member.Paused && !quotaPaused {
		return s, quotaPaused, &Outcome{Code: ExitPaused, Message: "paused: " + deref(s.Member.PauseReason)}, nil
	}
	return s, quotaPaused, nil, nil
}

func (t *Ticker) run(ctx context.Context) (Outcome, error) {
	if t.Cfg.CLI == adapter.Manual {
		// a self-driven agent: its own scheduler runs `agentbus inbox`
		return Outcome{Code: ExitNothing, Message: "manual mode: tick does nothing; the agent runs `agentbus inbox` itself"}, nil
	}
	s, quotaPaused, stop, err := t.gate(ctx)
	if stop != nil {
		return *stop, err
	}

	// quota: report readings; the hub decides whether we are paused
	if qr, err := t.reportQuota(ctx); err != nil {
		t.logf("quota report failed: %v", err)
		if quotaPaused {
			return Outcome{Code: ExitQuota, Message: "paused: " + deref(s.Member.PauseReason)}, nil
		}
	} else if qr.Paused {
		reason := deref(qr.PauseReason)
		if strings.HasPrefix(reason, "quota:") || reason == "" {
			return Outcome{Code: ExitQuota, Message: "quota exhausted: " + reason + until(qr.PausedUntil)}, nil
		}
		return Outcome{Code: ExitPaused, Message: "paused: " + reason}, nil
	}

	t.resendRuns(ctx)

	max := t.MaxThreads
	if max <= 0 {
		max = s.Config.MaxClaimThreads
	}
	cr, err := t.Client.Claim(ctx, max)
	if err != nil {
		return Outcome{Code: ExitErr}, err
	}
	if cr.Paused {
		return Outcome{Code: ExitPaused, Message: "paused by the hub"}, nil
	}
	if len(cr.Threads) == 0 {
		return Outcome{Code: ExitNothing, Message: "nothing to do"}, nil
	}
	for _, ct := range cr.Threads {
		t.activity(ctx, ct.ThreadID, "claimed", "", "")
	}
	out := Outcome{Code: ExitOK}
	var runs []Run
	for _, ct := range cr.Threads {
		to := t.processThread(ctx, ct)
		out.Threads = append(out.Threads, to)
		if to.Run != nil {
			runs = append(runs, *to.Run)
		}
		if ctx.Err() != nil {
			break
		}
	}
	if len(runs) > 0 {
		t.reportRuns(ctx, runs)
	}
	if !t.DryRun {
		if _, err := t.reportQuota(ctx); err != nil {
			t.logf("final quota report failed: %v", err)
		}
	}
	out.Message = fmt.Sprintf("processed %d thread(s)", len(out.Threads))
	return out, nil
}

func (t *Ticker) reportQuota(ctx context.Context) (*QuotaResp, error) {
	collect := t.Quota
	if collect == nil {
		collect = func(ctx context.Context) []quota.Reading {
			return quota.Collect(ctx, quota.Options{Source: t.Cfg.QuotaSource})
		}
	}
	rs := collect(ctx)
	if rs == nil {
		rs = []quota.Reading{}
	}
	return t.Client.Quota(ctx, rs)
}

// resendRuns re-posts runs that a previous tick could not report.
func (t *Ticker) resendRuns(ctx context.Context) {
	pending := Unreported(t.paths().Usage())
	if len(pending) == 0 {
		return
	}
	if _, err := t.Client.Runs(ctx, pending); err != nil {
		t.logf("re-sending %d unreported run(s) failed: %v", len(pending), err)
		return
	}
	ids := make([]string, len(pending))
	for i, r := range pending {
		ids[i] = r.ID
	}
	_ = MarkReported(t.paths().Usage(), ids)
}

func (t *Ticker) reportRuns(ctx context.Context, runs []Run) {
	es := make([]UsageEntry, len(runs))
	for i, r := range runs {
		es[i] = UsageEntry{Run: r}
	}
	if err := AppendUsage(t.paths().Usage(), es...); err != nil {
		t.logf("writing usage.jsonl: %v", err)
	}
	if _, err := t.Client.Runs(ctx, runs); err != nil {
		t.logf("reporting runs failed (will retry next tick): %v", err)
		return
	}
	ids := make([]string, len(runs))
	for i, r := range runs {
		ids[i] = r.ID
	}
	_ = MarkReported(t.paths().Usage(), ids)
}

// RoundKey is "<delivery_id>:r<attempt>" for the first delivery by id: the
// AGENTBUS_ROUND value and the idempotency key of tick-authored posts.
func RoundKey(ds []Delivery) string {
	if len(ds) == 0 {
		return ""
	}
	d := append([]Delivery(nil), ds...)
	sort.Slice(d, func(i, j int) bool { return d[i].ID < d[j].ID })
	return fmt.Sprintf("%s:r%d", d[0].ID, d[0].Attempts+1)
}

func (t *Ticker) processThread(ctx context.Context, ct ClaimedThread) (to ThreadOutcome) {
	to.ThreadID = ct.ThreadID
	model := t.knownModel()
	defer func() {
		if to.Run != nil && to.Run.Model != nil && *to.Run.Model != "" {
			model = *to.Run.Model
		}
		if to.ErrorSummary != "" {
			t.activity(ctx, ct.ThreadID, "failed", failDetail(to.ErrorSummary), model)
		} else {
			t.activity(ctx, ct.ThreadID, "done", "", model)
		}
	}()
	c, err := t.Client.Context(ctx, ct.ThreadID)
	if err != nil {
		to.ErrorSummary = "context: " + err.Error()
		t.logf("%s: %v", ct.ThreadID, err)
		t.release(ctx, &to, ct.ThreadID, nil, "context failed: "+err.Error())
		return to
	}
	ds := ct.Deliveries
	if len(ds) == 0 {
		ds = c.Deliveries
	}
	ids := make([]string, len(ds))
	for i, d := range ds {
		ids[i] = d.ID
	}
	round := RoundKey(ds)
	if round == "" {
		round = ct.ThreadID + ":r" + fmt.Sprint(t.now().Unix())
	}

	dir, note := t.workDir(c)
	exe := t.Exe
	if exe == "" {
		exe = "agentbus"
	}
	prompt, err := BuildPrompt(PromptInput{Ctx: c, Deliveries: ds, Round: round, Exe: exe, WorkdirNote: note, MemberID: t.Cfg.MemberID})
	if err != nil {
		to.ErrorSummary = "prompt: " + err.Error()
		t.release(ctx, &to, ct.ThreadID, ids, to.ErrorSummary)
		return to
	}
	promptFile := filepath.Join(t.paths().Prompts(), sanitizeFile(ct.ThreadID)+".md")
	_ = os.MkdirAll(filepath.Dir(promptFile), 0o700)
	_ = os.WriteFile(promptFile, []byte(prompt), 0o600)

	ad, err := adapter.Get(t.Cfg.CLI)
	opts := adapter.Options{Tier: t.Cfg.Tier, Binary: t.Cfg.CLIBinary, PromptFile: promptFile,
		Template: t.Cfg.CLITemplate, UsagePaths: t.Cfg.CLIUsagePaths, LookPath: t.LookPath}
	var spec adapter.Spec
	if err == nil {
		spec, err = ad.Build(prompt, opts)
	}
	if t.DryRun {
		fmt.Fprintf(logOr(t.Log), "---- %s (round %s, dir %s)\n", ct.ThreadID, round, dir)
		if err != nil {
			fmt.Fprintf(logOr(t.Log), "cli: %v\n", err)
		} else {
			fmt.Fprintf(logOr(t.Log), "cli: %s %s\n", spec.Path, strings.Join(spec.Args, " "))
		}
		fmt.Fprintf(logOr(t.Log), "%s\n", prompt)
		t.release(ctx, &to, ct.ThreadID, ids, "dry-run")
		return to
	}
	started := t.now()
	run := &Run{ID: NewID("r", started), MemberID: t.Cfg.MemberID, ThreadID: &ct.ThreadID,
		StartedAt: started.UnixMilli(), CLI: t.Cfg.CLI}
	to.Run = run
	if err != nil {
		// the CLI could not even be built/found: say so, and let the message retry
		msg := fmt.Sprintf(noticeStart+"%s：%v\n\n请在这台机器上运行 `agentbus doctor` 排查。", t.Cfg.CLI, err)
		run.EndedAt, run.ExitCode = t.now().UnixMilli(), -1
		run.ErrorSummary = ptr(truncate1("start: "+err.Error(), 500))
		to.ErrorSummary = *run.ErrorSummary
		t.tickPost(ctx, &to, ct.ThreadID, round, msg, nil, t.Cfg.Model)
		t.release(ctx, &to, ct.ThreadID, ids, "cli unavailable: "+err.Error())
		return to
	}

	before := map[string]bool{}
	var cutoff int64
	for _, p := range c.Posts {
		before[p.ID] = true
		if p.CreatedAt > cutoff {
			cutoff = p.CreatedAt
		}
	}
	env := childEnv(roundEnv(map[string]string{
		"AGENTBUS_THREAD":    ct.ThreadID,
		"AGENTBUS_ROUND":     round,
		"AGENTBUS_WORKSPACE": c.Workspace.ID,
		"AGENTBUS_HUB_HOME":  t.Dir,
		"AGENTBUS_IN_TICK":   "1",
		"AGENTBUS_PROMPT":    promptFile,
		"PATH":               pathWithExe(t.Exe),
	}, t.Cfg.CLI, model))
	hb := t.HeartbeatEvery
	if hb <= 0 {
		hb = 5 * time.Minute
	}
	t.activity(ctx, ct.ThreadID, "running", runningDetail(t.Cfg.CLI, model), model)
	t.logf("%s: running %s in %s", ct.ThreadID, t.Cfg.CLI, dir)
	res := RunSpec(ctx, spec, ExecOptions{
		Dir: dir, Env: env, Timeout: t.Timeout, Every: hb, Grace: t.KillGrace,
		Tick: func() {
			if _, err := t.Client.Heartbeat(ctx, ct.ThreadID); err != nil {
				t.logf("%s: heartbeat: %v", ct.ThreadID, err)
			}
		},
	})
	ended := t.now()
	run.EndedAt = ended.UnixMilli()
	run.ExitCode = res.ExitCode
	parsed := adapter.ParseWith(ad, res.Stdout, opts)
	u := parsed.Usage
	if u.DurationMS == 0 {
		u.DurationMS = res.Duration.Milliseconds()
	}
	if parsed.Known {
		run.Input, run.CacheWrite, run.CacheRead = u.Input, u.CacheWrite, u.CacheRead
		run.Output, run.Reasoning, run.CostUSD = u.Output, u.Reasoning, u.CostUSD
	}
	run.Model = u.Model
	postModel := strings.TrimSpace(t.Cfg.Model) // the model the run reported, else the configured one
	if u.Model != nil && strings.TrimSpace(*u.Model) != "" {
		postModel = strings.TrimSpace(*u.Model)
		t.lastModel = postModel
	}

	failed := res.TimedOut || res.Err != nil || res.ExitCode != 0 || parsed.IsError
	if failed {
		run.ErrorSummary = ptr(truncate1(errorSummary(res, parsed), 500))
		to.ErrorSummary = *run.ErrorSummary
		if res.ExitCode == 0 {
			run.ExitCode = 1
		}
	}

	to.AgentPosted = t.agentPosted(ctx, ct.ThreadID, before, cutoff)
	var uptr *adapter.Usage
	if parsed.Known {
		uptr = &u
	}
	footer := UsageFooter(viewOf(parsed), res.Duration)
	switch {
	case res.TimedOut:
		to.TimedOut = true
		msg := fmt.Sprintf(noticeTimeout+"%s 运行超过 %s 被终止，消息已退回收件箱，稍后重试。", t.Cfg.CLI, FmtDuration(t.timeout()))
		if txt := strings.TrimSpace(parsed.Text); txt != "" {
			msg += "\n\n最后的输出：\n\n" + quote(truncate1(txt, 2000))
		}
		t.tickPost(ctx, &to, ct.ThreadID, round, msg+"\n\n---\n"+footer, uptr, postModel)
		t.release(ctx, &to, ct.ThreadID, ids, "timeout")
		return to
	case to.AgentPosted:
		// the agent spoke for itself; usage goes to the run record
	case failed:
		msg := fmt.Sprintf(noticeFailed+"%s 退出码 %d。\n\n%s", t.Cfg.CLI, res.ExitCode, quote(truncate1(firstNonEmpty(to.ErrorSummary, "（没有错误输出）"), 2000)))
		if txt := strings.TrimSpace(parsed.Text); txt != "" && !strings.Contains(to.ErrorSummary, txt) {
			msg += "\n\n输出：\n\n" + truncate1(txt, 4000)
		}
		t.tickPost(ctx, &to, ct.ThreadID, round, msg+"\n\n---\n"+footer, uptr, postModel)
	case noopRedelivery(c, ds, firstNonEmpty(c.Me.ID, t.Cfg.MemberID)):
		// a re-delivery an earlier attempt already answered: nothing new to
		// say, so no fallback post (the run record still carries the usage)
		to.SkippedPost = true
		t.logf("%s: re-delivery already answered; no fallback progress post", ct.ThreadID)
	default:
		txt := strings.TrimSpace(parsed.Text)
		if txt == "" || IsNoReply(txt) {
			// nothing worth a post: the run record still carries the usage
			to.SkippedPost = true
			t.logf("%s: the agent left nothing to post; no fallback post", ct.ThreadID)
			break
		}
		t.tickPost(ctx, &to, ct.ThreadID, round, truncate1(txt, 30000)+"\n\n---\n"+footer, uptr, postModel)
	}
	if err := t.Client.Ack(ctx, ct.ThreadID, ids); err != nil {
		t.logf("%s: ack: %v", ct.ThreadID, err)
		to.ErrorSummary = firstNonEmpty(to.ErrorSummary, "ack: "+err.Error())
	} else {
		to.Acked = true
	}
	return to
}

// NoReply is the final answer an agent gives when the round needs no post.
const NoReply = "NO_REPLY"

// IsNoReply reports whether an agent's final answer opts out of the
// fallback post: its last non-empty line is NO_REPLY (markup ignored).
func IsNoReply(txt string) bool {
	lines := strings.Split(strings.TrimSpace(txt), "\n")
	last := strings.Trim(strings.TrimSpace(lines[len(lines)-1]), "`*_.。 ")
	return strings.EqualFold(last, NoReply)
}

func (t *Ticker) timeout() time.Duration {
	if t.Timeout <= 0 {
		return 20 * time.Minute
	}
	return t.Timeout
}

// tickPost writes a progress post authored by tick (idempotency key =
// round), labelled with the CLI and model ("" = unknown).
func (t *Ticker) tickPost(ctx context.Context, to *ThreadOutcome, thread, round, body string, u *adapter.Usage, model string) {
	_, err := t.Client.Post(ctx, NewPost{ThreadID: thread, Body: body, Kind: "progress", IdempotencyKey: round, Usage: u,
		CLI: label64(t.Cfg.CLI), Model: label64(model)})
	if err != nil {
		t.logf("%s: posting progress: %v", thread, err)
		return
	}
	to.TickPosted = true
}

// release nacks the deliveries so they are retried.
func (t *Ticker) release(ctx context.Context, to *ThreadOutcome, thread string, ids []string, reason string) {
	if err := t.Client.Nack(ctx, thread, ids, truncate1(reason, 300)); err != nil {
		t.logf("%s: nack: %v", thread, err)
		return
	}
	to.Nacked = true
}

// agentPosted reports whether I wrote a post of any kind (msg, progress,
// confirm, state) in thread after the context snapshot.
func (t *Ticker) agentPosted(ctx context.Context, thread string, before map[string]bool, cutoff int64) bool {
	pr, err := t.Client.Posts(ctx, thread, "", 50)
	if err != nil {
		t.logf("%s: checking for progress post: %v", thread, err)
		return false
	}
	for _, p := range pr.Posts {
		if p.AuthorID == t.Cfg.MemberID && !before[p.ID] && p.CreatedAt >= cutoff {
			return true
		}
	}
	return false
}

// workDir picks the CLI's working directory: the repos.toml mapping for the
// workspace repo, else a per-agent directory under the config dir.
func (t *Ticker) workDir(c *Context) (string, string) {
	repo := deref(c.Workspace.Repo)
	if repo != "" {
		if rs, err := LoadRepos(t.paths().Repos()); err == nil {
			if p, ok := rs.Lookup(repo); ok {
				if st, err := os.Stat(p); err == nil && st.IsDir() {
					return p, ""
				}
				t.logf("repos.toml maps %s to %s, which is not a directory", repo, p)
			}
		}
	}
	d := filepath.Join(t.paths().Work(), sanitizeFile(firstNonEmpty(c.Workspace.Name, c.Workspace.ID, "default")))
	_ = os.MkdirAll(d, 0o700)
	note := "这是你在本机的独立工作目录 " + d + "。"
	if repo != "" {
		note += "本机没有把仓库 " + repo + " 映射到本地路径（repos.toml）；需要代码时自己 clone 到这里。"
	}
	return d, note
}

func viewOf(r adapter.Result) *UsageView {
	if !r.Known {
		return nil
	}
	return &UsageView{Known: true, TotalInput: r.Usage.TotalInput(), Cached: r.Usage.CacheRead,
		Output: r.Usage.Output + r.Usage.Reasoning, Cost: r.Usage.CostUSD}
}

func errorSummary(res ExecResult, p adapter.Result) string {
	switch {
	case res.TimedOut:
		return "timeout"
	case res.Err != nil:
		return res.Err.Error()
	case res.ExitCode == 0 && p.IsError && p.Err != "":
		return p.Err
	}
	tail := strings.TrimSpace(string(res.Stderr))
	if len(tail) > 1500 {
		tail = "…" + tail[len(tail)-1500:]
	}
	switch {
	case tail != "":
		return tail
	case p.IsError && p.Err != "":
		return p.Err
	}
	return fmt.Sprintf("exit code %d", res.ExitCode)
}

var unsafeFile = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func sanitizeFile(s string) string {
	s = unsafeFile.ReplaceAllString(s, "-")
	if s == "" || s == "." || s == ".." {
		return "x"
	}
	return s
}

// roundEnv adds AGENTBUS_CLI, and AGENTBUS_MODEL when the model is known,
// to a round's environment.
func roundEnv(env map[string]string, cli, model string) map[string]string {
	env["AGENTBUS_CLI"] = cli
	if model != "" {
		env["AGENTBUS_MODEL"] = model
	}
	return env
}

func pathWithExe(exe string) string {
	p := os.Getenv("PATH")
	if exe == "" {
		return p
	}
	return filepath.Dir(exe) + string(os.PathListSeparator) + p
}

func logOr(w io.Writer) io.Writer {
	if w == nil {
		return io.Discard
	}
	return w
}

func until(ms *int64) string {
	if ms == nil || *ms == 0 {
		return ""
	}
	return " (until " + time.UnixMilli(*ms).Local().Format("2006-01-02 15:04") + ")"
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func ptr[T any](v T) *T { return &v }

func truncate1(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// keep valid UTF-8
	cut := n
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}
