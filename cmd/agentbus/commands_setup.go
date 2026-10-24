package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/adapter"
	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
	"github.com/shiroha-document/agentbus/internal/quota"
	"github.com/shiroha-document/agentbus/internal/sched"
	"github.com/shiroha-document/agentbus/internal/tui"
)

// Test seams.
var (
	schedRunner sched.Runner = sched.ExecRunner{}
	setupIn     io.Reader    = os.Stdin
	lookPath                 = exec.LookPath
	// cliVersion runs `<bin> --version` (bounded); replaced in tests.
	cliVersion = func(ctx context.Context, bin string) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, bin, "--version").CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
)

// ---- schedule ----

func schedHost() sched.Host {
	home, _ := os.UserHomeDir()
	return sched.Host{GOOS: runtime.GOOS, Home: home, UID: os.Getuid(), Runner: schedRunner}
}

func querySchedule(name string) sched.Status { return sched.Query(schedHost(), "", name) }

func schedText(st sched.Status) string {
	if i18n.IsZh() {
		if st.Installed {
			return "已安装（" + st.Detail + "）"
		}
		return "未安装（" + st.Detail + "；运行 `agentbus schedule install`）"
	}
	if st.Installed {
		return "installed (" + st.Detail + ")"
	}
	return "not installed (" + st.Detail + "; run `agentbus schedule install`)"
}

func schedJob(cfg *hub.Config) sched.Job {
	exe, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	j := sched.Job{Name: cfg.Name, Exe: exe, Interval: time.Duration(cfg.WakeIntervalS) * time.Second,
		LogDir: hub.Paths{Dir: hub.Dir()}.Logs(), Path: os.Getenv("PATH")}
	if os.Getenv("AGENTBUS_HUB_HOME") != "" {
		j.HubHome, _ = filepath.Abs(hub.Dir())
	}
	return j
}

func cmdSchedule(c *cli, args []string) error {
	if len(args) == 0 {
		args = []string{"status"}
	}
	sub, rest := args[0], args[1:]
	fs := newFlags("schedule " + sub)
	interval := fs.String("interval", "", "tick interval (default: the join --wake-interval)")
	method := fs.String("method", "", "launchd | systemd | cron | schtasks (default: detect)")
	if _, err := parse(fs, rest); err != nil {
		return err
	}
	dir := hub.Dir()
	cfg, err := hub.LoadConfig(dir)
	if err != nil {
		return err
	}
	switch sub {
	case "install":
		if *interval != "" {
			d, err := parseDur(*interval)
			if err != nil || d < time.Minute {
				return &exitError{code: exitUsage, msg: i18n.Pick("--interval must be a duration of at least 1m", "--interval 必须是至少 1m 的时长")}
			}
			cfg.WakeIntervalS = int64(d / time.Second)
			if err := cfg.Save(dir); err != nil {
				return err
			}
		}
		return installSchedule(c, cfg, *method)
	case "uninstall", "remove":
		m, err := sched.Uninstall(schedHost(), *method, cfg.Name)
		if err != nil {
			return err
		}
		c.emit(map[string]any{"method": m, "installed": false}, func() {
			fmt.Fprintf(c.out, i18n.Pick("removed the %s job for %s\n", "已移除 %[2]s 的 %[1]s 定时任务\n"), m, cfg.Name)
		})
		return nil
	case "status":
		st := sched.Query(schedHost(), *method, cfg.Name)
		c.emit(st, func() { fmt.Fprintf(c.out, "%s: %s\n", st.Method, schedText(st)) })
		if !st.Installed {
			return &exitError{code: exitNothing}
		}
		return nil
	}
	return &exitError{code: exitUsage, msg: "schedule install|uninstall|status"}
}

func installSchedule(c *cli, cfg *hub.Config, method string) error {
	j := schedJob(cfg)
	m, err := sched.Install(schedHost(), method, j)
	if err != nil {
		return err
	}
	c.emit(map[string]any{"method": m, "installed": true, "interval_s": cfg.WakeIntervalS, "exe": j.Exe}, func() {
		fmt.Fprintf(c.out, i18n.Pick("installed %s job: `%s %s` every %s\n", "已安装 %s 定时任务：`%s %s`，每 %s 一次\n"), m, j.Exe, strings.Join(j.Args(), " "), FmtDurS(cfg.WakeIntervalS))
	})
	return nil
}

// ---- doctor ----

type check struct {
	Name   string `json:"name"`
	Status string `json:"status"` // ok | warn | fail | skip
	Detail string `json:"detail"`
}

func cmdDoctor(c *cli, args []string) error {
	if _, err := parse(newFlags("doctor"), args); err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	cs := runDoctor(ctx)
	failed := 0
	for _, ch := range cs {
		if ch.Status == "fail" {
			failed++
		}
	}
	c.emit(map[string]any{"checks": cs, "ok": failed == 0}, func() {
		for _, ch := range cs {
			detail := ch.Detail
			if ch.Name == "config" && ch.Status == "fail" && detail == hub.ErrNoConfig.Error() {
				detail = boundaryError(hub.ErrNoConfig).Error()
			}
			fmt.Fprintf(c.out, "%-5s %-10s %s\n", strings.ToUpper(ch.Status), ch.Name, detail)
		}
		if failed == 0 {
			fmt.Fprintln(c.out, i18n.Pick("all checks passed", "全部检查通过"))
		} else {
			fmt.Fprintf(c.out, i18n.Pick("%d check(s) failed\n", "%d 项检查未通过\n"), failed)
		}
	})
	if failed > 0 {
		return &exitError{code: exitErr}
	}
	return nil
}

func runDoctor(ctx context.Context) []check {
	var cs []check
	add := func(name, status, f string, a ...any) { cs = append(cs, check{name, status, fmt.Sprintf(f, a...)}) }
	dir := hub.Dir()
	p := hub.Paths{Dir: dir}
	cfg, err := hub.LoadConfig(dir)
	if err != nil {
		add("config", "fail", "%v", err)
		return cs
	}
	add("config", "ok", "%s: %s on %s, team %s", p.Config(), cfg.Name, cfg.HubURL, teamText(cfg))

	k, kerr := hub.LoadKey(p.Key())
	switch {
	case kerr != nil:
		add("key", "fail", "%v", kerr)
	case runtime.GOOS != "windows":
		if fi, err := os.Stat(p.Key()); err == nil && fi.Mode().Perm()&0o077 != 0 {
			add("key", "fail", "%s is mode %o; run: chmod 600 %s", p.Key(), fi.Mode().Perm(), p.Key())
		} else {
			add("key", "ok", "%s (0600)", p.Key())
		}
	default:
		add("key", "ok", "%s", p.Key())
	}

	if cfg.CLI == adapter.Manual {
		add("cli", "ok", "manual (self-driven: the agent runs `agentbus inbox` from its own scheduled task)")
	} else if ad, err := adapter.Get(cfg.CLI); err != nil {
		add("cli", "fail", "%v", err)
	} else if bin, err := adapter.Resolve(ad, adapter.Options{Binary: cfg.CLIBinary, Template: cfg.CLITemplate, LookPath: lookPath}); err != nil {
		if cfg.CLI == "custom" {
			add("cli", "ok", "custom template %q", cfg.CLITemplate)
		} else {
			add("cli", "fail", "%s not found on PATH (%v); install it or join with --binary PATH", cfg.CLI, err)
		}
	} else if v, err := cliVersion(ctx, bin); err != nil {
		add("cli", "warn", "%s (%s --version failed: %v)", bin, cfg.CLI, err)
	} else {
		add("cli", "ok", "%s: %s", bin, firstLine(v))
	}

	if repos, err := hub.LoadRepos(p.Repos()); err != nil {
		add("repos", "fail", "%v", err)
	} else if len(repos) == 0 {
		add("repos", "ok", "no repos mapped (rounds run in %s)", p.Work())
	} else {
		var bad []string
		for r, path := range repos {
			if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
				bad = append(bad, r+" -> "+path)
			}
		}
		if len(bad) > 0 {
			add("repos", "fail", "missing directories in %s: %s", p.Repos(), strings.Join(bad, ", "))
		} else {
			add("repos", "ok", "%d repo(s) mapped", len(repos))
		}
	}

	if cfg.Wake == "trigger" {
		add("scheduler", "skip", "wake mode trigger")
	} else if cfg.CLI == adapter.Manual {
		if st := querySchedule(cfg.Name); st.Installed {
			add("scheduler", "warn", "%s: %s — not needed in manual mode (tick does nothing); remove it with `agentbus schedule uninstall`", st.Method, st.Detail)
		} else {
			add("scheduler", "skip", "manual mode: the agent's own scheduled task runs `agentbus inbox`")
		}
	} else if st := querySchedule(cfg.Name); st.Installed {
		add("scheduler", "ok", "%s: %s", st.Method, st.Detail)
	} else {
		add("scheduler", "fail", "%s: %s; run `agentbus schedule install`", st.Method, st.Detail)
	}

	if kerr != nil {
		add("hub", "skip", "no key")
		return cs
	}
	cl := newClient(cfg, k)
	hctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	s, err := cl.State(hctx)
	if !cl.LastDate.IsZero() {
		skew := time.Since(cl.LastDate)
		if skew < 0 {
			skew = -skew
		}
		switch {
		case skew > 5*time.Minute:
			add("clock", "fail", "clock is %s off the hub's; signatures are rejected beyond 5m, fix the system time", skew.Round(time.Second))
		case skew > time.Minute:
			add("clock", "warn", "clock is %s off the hub's", skew.Round(time.Second))
		default:
			add("clock", "ok", "skew %s", skew.Round(time.Second))
		}
	}
	switch {
	case err == nil:
		rememberTeam(dir, cfg, s.Team)
		add("hub", "ok", "reachable, signature accepted; %s is %s in team %s", s.Member.Name, s.Member.Status, teamText(cfg))
		if s.Member.Status == "pending" {
			add("approval", "warn", pendingText())
		}
		if s.MinClientVersion != "" && newerVersion(s.MinClientVersion, hubVersion()) {
			add("version", "fail", "client %s is older than the hub minimum %s; run `agentbus self-update`", hubVersion(), s.MinClientVersion)
		} else {
			add("version", "ok", "client %s (hub minimum %s)", hubVersion(), dash(s.MinClientVersion))
		}
	case hub.IsTooOld(err):
		add("hub", "fail", "%v", err)
	case hub.IsStatus(err, 401) || hub.IsStatus(err, 403):
		add("hub", "fail", "reachable but the signature was rejected: %v", err)
	default:
		add("hub", "fail", "%v", err)
	}
	return cs
}

// ---- setup ----

// setupUI wraps the prompts of one setup run; in --yes mode every question
// returns its default without asking.
type setupUI struct {
	ui  *tui.UI
	yes bool
}

// ask returns one line (def when empty or at end of input).
func (s *setupUI) ask(q, def string) string {
	if s.yes {
		return def
	}
	a, _ := s.ui.Input(q, def)
	return a
}

func (s *setupUI) confirm(q string, def bool) bool {
	if s.yes {
		return def
	}
	a, _ := s.ui.Confirm(q, def)
	return a
}

// choose shows a menu (arrow keys on a terminal, a numbered list otherwise)
// and returns the chosen option's value; def is the preselected value.
func (s *setupUI) choose(title string, opts []tui.Option, def string) (string, error) {
	di := 0
	for i, o := range opts {
		if o.Value == def {
			di = i
		}
	}
	if s.yes {
		return opts[di].Value, nil
	}
	i, err := s.ui.Select(title, opts, di)
	if errors.Is(err, tui.ErrInterrupted) {
		return "", &exitError{code: exitErr, msg: i18n.Pick("setup cancelled", "已取消安装")}
	}
	if err != nil {
		return "", &exitError{code: exitUsage, msg: err.Error()}
	}
	return opts[i].Value, nil
}

// detectCLIs returns the supported CLIs found on PATH (name -> path), in
// display order. manual and custom have no binary and are never "found".
func detectCLIs() (map[string]string, []string) {
	found := map[string]string{}
	var order []string
	for _, n := range adapter.Known {
		if n == "custom" || n == adapter.Manual {
			continue
		}
		ad, _ := adapter.Get(n)
		if p, err := adapter.Resolve(ad, adapter.Options{LookPath: lookPath}); err == nil {
			found[n] = p
			order = append(order, n)
		}
	}
	return found, order
}

// cliOptions is the CLI menu: the CLIs found on this machine first (with
// their path), then manual (self-driven harnesses) and custom, then the
// supported CLIs that are not installed.
func cliOptions(found map[string]string) []tui.Option {
	var have, missing []tui.Option
	for _, n := range adapter.Known {
		if n == "custom" || n == adapter.Manual {
			continue
		}
		o := tui.Option{Value: n, Label: adapter.Label(n)}
		if found[n] != "" {
			o.Hint = found[n]
			have = append(have, o)
		} else {
			o.Hint = i18n.Pick("not installed", "未安装")
			missing = append(missing, o)
		}
	}
	opts := append(have,
		tui.Option{Value: adapter.Manual, Label: i18n.Pick("Manual / self-driven", "手动 / 自驱"),
			Hint: i18n.Pick("OpenAI dot and other agents that wake themselves on a schedule and run `agentbus inbox`",
				"OpenAI dot 等靠自己的定时任务唤醒、自己运行 `agentbus inbox` 的 agent")},
		tui.Option{Value: "custom", Label: i18n.Pick("Custom command", "自定义命令"),
			Hint: i18n.Pick("your own command line with {prompt_file}", "自定义命令行，用 {prompt_file} 传入提示词")})
	return append(opts, missing...)
}

// manualHowTo tells a self-driven agent how to wire its own scheduler.
func manualHowTo(every string) string {
	return fmt.Sprintf(i18n.Pick(
		"manual mode: no scheduler job is installed. In the agent's own harness create a recurring task (every %s) that runs `agentbus inbox`; "+
			"when it prints a thread, follow the prompt, reply with `agentbus post --thread T …` and finish with `agentbus ack --thread T`. "+
			"Exit code 3 / \"nothing to do\" means stop until the next wake-up.",
		"自驱模式：不安装定时任务。请在 agent 自己的 harness 里建一个每 %s 运行一次的定时任务，执行 `agentbus inbox`；"+
			"输出了讨论串就按里面的提示词处理，用 `agentbus post --thread T …` 回复，最后 `agentbus ack --thread T`。"+
			"退出码 3 /「没有新消息」就结束，等下一次唤醒。"), every)
}

func tierOptions() []tui.Option {
	return []tui.Option{
		{Value: adapter.TierReadonly, Label: "readonly", Hint: i18n.Pick("read code, post only", "只读代码，只能发帖")},
		{Value: adapter.TierWorkspace, Label: "workspace", Hint: i18n.Pick("edit files in the repo", "可修改仓库内的文件")},
		{Value: adapter.TierFull, Label: "full", Hint: i18n.Pick("no limits (dangerous)", "不设限制（危险）")},
	}
}

// intervalOptions are the wake intervals offered interactively.
var intervalChoices = []string{"1m", "2m", "5m", "10m", "15m", "30m", "1h"}

func intervalOptions() []tui.Option {
	var opts []tui.Option
	for _, v := range intervalChoices {
		o := tui.Option{Value: v, Label: v}
		if v == "5m" {
			o.Hint = i18n.Pick("recommended", "推荐")
		}
		opts = append(opts, o)
	}
	return opts
}

func cmdSetup(c *cli, args []string) error {
	fs := newFlags("setup")
	yes := fs.Bool("yes", false, "non-interactive: take flags and defaults, ask nothing")
	joinCode := fs.String("join-code", "", "team join code abj_… from a team admin (hub: Settings → Agent join code); default $AGENTBUS_JOIN_CODE")
	name := fs.String("name", "", "agent name")
	cliName := fs.String("cli", "", strings.Join(adapter.Known, " | ")+" (default: first found)")
	binary := fs.String("binary", "", "CLI executable path")
	template := fs.String("template", "", "custom CLI command line with {prompt_file}")
	tier := fs.String("tier", "", "permission tier: readonly | workspace | full (default workspace)")
	var repoFlags multi
	fs.Var(&repoFlags, "repo", "OWNER/REPO=PATH local checkout (repeatable)")
	interval := fs.String("interval", "", "tick interval (default 5m)")
	qsrc := fs.String("quota-source", "", "auto | native (default auto)")
	noSched := fs.Bool("no-schedule", false, "do not install the scheduler job")
	method := fs.String("method", "", "scheduler: launchd | systemd | cron | schtasks (default: detect)")
	noDoctor := fs.Bool("no-doctor", false, "skip the final doctor run")
	owner := fs.String("owner", "", "human owner")
	machine := fs.String("machine", "", "machine description")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if *qsrc != "" {
		switch *qsrc {
		case quota.SourceAuto, quota.SourceNative, quota.SourceMagpie, quota.SourceBoth:
		default:
			return &exitError{code: exitUsage, msg: i18n.Pick("--quota-source must be auto or native", "--quota-source 只能是 auto 或 native")}
		}
	}
	pr := &setupUI{ui: tui.New(setupIn, c.out), yes: *yes}
	say := func(f string, a ...any) {
		if !c.json {
			fmt.Fprintf(c.out, f+"\n", a...)
		}
	}
	// Ctrl-C at a prompt ends setup at once (every step saves as it goes)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := hub.Dir()
	existing, _ := hub.LoadConfig(dir)

	// 1. CLIs
	found, order := detectCLIs()
	if len(order) == 0 {
		var names []string
		for _, n := range adapter.Known {
			if n != "custom" {
				names = append(names, n)
			}
		}
		say(i18n.Pick("1/6 coding CLIs: none of %s found on PATH", "1/6 编码 CLI：PATH 中没有找到 %s"), strings.Join(names, ", "))
	} else {
		var parts []string
		for _, n := range order {
			parts = append(parts, adapter.Label(n)+" ("+found[n]+")")
		}
		say(i18n.Pick("1/6 coding CLIs: %s", "1/6 编码 CLI：%s"), strings.Join(parts, ", "))
	}
	def := "claude"
	if existing != nil {
		def = existing.CLI
	} else if len(order) > 0 {
		def = order[0]
	}
	cn := strings.ToLower(strings.TrimSpace(firstOr(*cliName, os.Getenv("AGENTBUS_CLI"))))
	if cn == "" && existing == nil && len(order) == 1 {
		// one coding CLI on this machine: nothing to choose
		cn = order[0]
		say(i18n.Pick("    using %s (the only one found; another: --cli codex|…|manual)", "    使用 %s（本机只找到这一个；换别的：--cli codex|…|manual）"), adapter.Label(cn))
	}
	if cn == "" {
		if cn, err = pr.choose(i18n.Pick("Which coding CLI should this agent run?", "这个 agent 用哪个编码 CLI？"), cliOptions(found), def); err != nil {
			return err
		}
	}
	if _, err := adapter.Get(cn); err != nil {
		return &exitError{code: exitUsage, msg: err.Error()}
	}
	recordEvent("cli.setup", map[string]any{"step": "cli", "choice": cn})
	if cn == "custom" && *template == "" && existing == nil {
		*template = pr.ask(i18n.Pick("custom command line (use {prompt_file})", "自定义命令行（用 {prompt_file} 表示提示词文件）"), "")
	}

	// 2. join
	o := joinOpts{cli: cn, binary: *binary, template: *template, owner: *owner, machine: *machine, wake: "poll"}
	o.url = firstOr(hubURLFlag, envHubURL())
	if len(pos) > 0 {
		o.url = pos[0]
	}
	o.name = *name
	o.joinCode = firstOr(strings.TrimSpace(*joinCode), envJoinCode())
	if existing != nil {
		// already joined: hubJoin reuses the saved identity, no code needed
		o.url = firstOr(o.url, existing.HubURL)
		o.name = firstOr(o.name, existing.Name)
	} else {
		if o.url == "" {
			o.url = pr.ask(i18n.Pick("hub URL", "hub 地址"), "")
		}
		if o.joinCode == "" {
			o.joinCode = strings.TrimSpace(pr.ask(i18n.Pick("team join code (abj_…; "+askAdminForCode+")",
				"团队加入码（abj_…；"+askAdminForCodeZh+"）"), ""))
		}
		if o.joinCode == "" {
			return &exitError{code: exitUsage, msg: joinCodeMissingText()}
		}
		if o.name == "" {
			h, _ := os.Hostname()
			sug := suggestName(h, cn)
			o.name = pr.ask(i18n.Pick("agent name", "agent 名字"), sug)
			o.autoName = o.name == sug // taken? the join picks sug-2, sug-3, …
		}
	}
	if *interval != "" {
		if o.interval, err = parseDur(*interval); err != nil || o.interval < time.Minute {
			return &exitError{code: exitUsage, msg: i18n.Pick("--interval must be a duration of at least 1m", "--interval 必须是至少 1m 的时长")}
		}
	} else if pr.ui.Interactive() && !*yes && (!*noSched || cn == adapter.Manual) && (existing == nil || existing.Wake != "trigger") {
		cur := "5m"
		if existing != nil {
			cur = hub.FmtDuration(time.Duration(existing.WakeIntervalS) * time.Second)
		}
		q := i18n.Pick("How often should this agent check for new messages?", "多久检查一次新消息？")
		if cn == adapter.Manual {
			q = i18n.Pick("How often will the agent's own scheduled task run `agentbus inbox`?", "agent 自己的定时任务多久运行一次 `agentbus inbox`？")
		}
		v, err := pr.choose(q, intervalOptions(), cur)
		if err != nil {
			return err
		}
		o.interval, _ = parseDur(v)
		recordEvent("cli.setup", map[string]any{"step": "interval", "choice": v})
	}
	cfg, status, err := hubJoin(ctx, o)
	if err != nil {
		return err
	}
	say(i18n.Pick("2/6 joined %s as %s (%s) in team %s, status %s", "2/6 已加入 %s，名字 %s（%s），团队 %s，状态 %s"),
		cfg.HubURL, cfg.Name, cfg.MemberID, teamText(cfg), status)
	if status == "pending" {
		say("    " + pendingText())
	}
	recordEvent("cli.setup", map[string]any{"step": "join", "choice": status})
	if cn != cfg.CLI || (*binary != "" && *binary != cfg.CLIBinary) || (*template != "" && *template != cfg.CLITemplate) {
		cfg.CLI, cfg.CLIBinary, cfg.CLITemplate = cn, firstOr(*binary, cfg.CLIBinary), firstOr(*template, cfg.CLITemplate)
	}
	if o.interval > 0 {
		cfg.WakeIntervalS = int64(o.interval / time.Second)
	}
	if *qsrc != "" {
		cfg.QuotaSource = *qsrc
	}

	// 3. tier
	t := *tier
	if t == "" && cn == adapter.Manual {
		// the harness has its own permissions; the tier only labels the agent
		t = firstOr(cfg.Tier, adapter.TierWorkspace)
	}
	if t == "" {
		if t, err = pr.choose(i18n.Pick("Permission tier (what the CLI may do)", "权限级别（CLI 能做什么）"), tierOptions(), cfg.Tier); err != nil {
			return err
		}
	}
	switch t {
	case adapter.TierReadonly, adapter.TierWorkspace, adapter.TierFull:
	default:
		return &exitError{code: exitUsage, msg: i18n.Pick("--tier must be readonly, workspace or full", "--tier 只能是 readonly、workspace 或 full")}
	}
	cfg.Tier = t
	if err := cfg.Save(dir); err != nil {
		return err
	}
	say(i18n.Pick("3/6 permission tier %s", "3/6 权限级别 %s"), t)
	recordEvent("cli.setup", map[string]any{"step": "tier", "choice": t})

	// 4. repos
	p := hub.Paths{Dir: dir}
	repos, err := hub.LoadRepos(p.Repos())
	if err != nil {
		return err
	}
	if repos == nil {
		repos = hub.Repos{}
	}
	entries := []string(repoFlags)
	if len(entries) == 0 && !*yes {
		for {
			e := pr.ask(i18n.Pick("map a GitHub repo to a local checkout, OWNER/REPO=PATH (empty to finish)",
				"把 GitHub 仓库映射到本地目录，OWNER/REPO=PATH（直接回车结束）"), "")
			if e == "" {
				break
			}
			entries = append(entries, e)
		}
	}
	for _, e := range entries {
		r, path, ok := strings.Cut(e, "=")
		r, path = strings.TrimSpace(r), strings.TrimSpace(path)
		if !ok || hub.NormalizeRepo(r) == "" || path == "" {
			return &exitError{code: exitUsage, msg: i18n.Pick("--repo wants OWNER/REPO=PATH, got ", "--repo 格式应为 OWNER/REPO=PATH，收到 ") + e}
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
			return fmt.Errorf(i18n.Pick("repo %s: %s is not a directory", "仓库 %s：%s 不是目录"), r, path)
		}
		repos[hub.NormalizeRepo(r)] = path
	}
	if len(entries) > 0 {
		if err := hub.SaveRepos(p.Repos(), repos); err != nil {
			return err
		}
	}
	say(i18n.Pick("4/6 %d repo(s) mapped in %s", "4/6 已映射 %d 个仓库，见 %s"), len(repos), p.Repos())
	recordEvent("cli.setup", map[string]any{"step": "repos", "count": len(repos)})

	// 5. scheduler
	schedChoice := "skipped"
	if cfg.CLI == adapter.Manual {
		schedChoice = "manual"
		say("5/6 " + manualHowTo(FmtDurS(cfg.WakeIntervalS)))
	} else if *noSched || cfg.Wake == "trigger" {
		say(i18n.Pick("5/6 scheduler skipped", "5/6 跳过定时任务"))
	} else if pr.confirm(fmt.Sprintf(i18n.Pick("install a scheduler job running `agentbus tick` every %s", "安装定时任务，每 %s 运行一次 `agentbus tick`"),
		FmtDurS(cfg.WakeIntervalS)), true) {
		j := schedJob(cfg)
		m, err := sched.Install(schedHost(), *method, j)
		if err != nil {
			return fmt.Errorf(i18n.Pick("installing the scheduler job: %w", "安装定时任务失败：%w"), err)
		}
		schedChoice = m
		say(i18n.Pick("5/6 installed %s job every %s", "5/6 已安装 %s 定时任务，每 %s 一次"), m, FmtDurS(cfg.WakeIntervalS))
	} else {
		say(i18n.Pick("5/6 scheduler skipped (run `agentbus schedule install` later)", "5/6 跳过定时任务（之后可运行 `agentbus schedule install`）"))
	}
	recordEvent("cli.setup", map[string]any{"step": "scheduler", "choice": schedChoice})

	// 6. doctor
	var cs []check
	failed := 0
	if *noDoctor {
		say(i18n.Pick("6/6 doctor skipped", "6/6 跳过体检"))
	} else {
		say(i18n.Pick("6/6 doctor", "6/6 体检"))
		cs = runDoctor(ctx)
		for _, ch := range cs {
			if ch.Status == "fail" {
				failed++
			}
			say("    %-5s %-10s %s", strings.ToUpper(ch.Status), ch.Name, ch.Detail)
		}
		recordEvent("cli.setup", map[string]any{"step": "doctor", "choice": map[bool]string{true: "ok", false: "failed"}[failed == 0], "failed": failed})
	}
	if c.json {
		c.emit(map[string]any{"config": cfg, "status": status, "repos": repos, "checks": cs}, func() {})
	}
	if failed > 0 {
		say(i18n.Pick("setup finished with %d failing check(s); fix them and run `agentbus doctor`",
			"安装完成，但有 %d 项检查未通过；修复后运行 `agentbus doctor`"), failed)
		return &exitError{code: exitErr}
	}
	say(i18n.Pick("setup done", "安装完成"))
	return nil
}

// suggestName builds a valid agent name from the host name and CLI.
func suggestName(host, cli string) string {
	host = strings.ToLower(strings.SplitN(host, ".", 2)[0])
	var b strings.Builder
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	n := strings.Trim(b.String(), "-_") + "-" + cli
	n = strings.TrimLeft(n, "-_")
	if len(n) > 32 {
		n = n[:32]
	}
	if !nameRE.MatchString(n) {
		return cli + "-agent"
	}
	return n
}

// newerVersion reports whether a > b (both x.y.z).
func newerVersion(a, b string) bool {
	pa, pb := splitVer(a), splitVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func splitVer(v string) [3]int {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	for i, p := range strings.SplitN(v, ".", 3) {
		fmt.Sscanf(p, "%d", &out[i])
	}
	return out
}
