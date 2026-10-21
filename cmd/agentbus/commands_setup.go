package main

import (
	"bufio"
	"context"
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
	"github.com/shiroha-document/agentbus/internal/quota"
	"github.com/shiroha-document/agentbus/internal/sched"
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

const magpieInstall = "curl -fsSL https://usemagpie.ai/install.sh | sh"

// ---- schedule ----

func schedHost() sched.Host {
	home, _ := os.UserHomeDir()
	return sched.Host{GOOS: runtime.GOOS, Home: home, UID: os.Getuid(), Runner: schedRunner}
}

func querySchedule(name string) sched.Status { return sched.Query(schedHost(), "", name) }

func schedText(st sched.Status) string {
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
				return &exitError{code: exitUsage, msg: "--interval must be a duration of at least 1m"}
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
		c.emit(map[string]any{"method": m, "installed": false}, func() { fmt.Fprintf(c.out, "removed the %s job for %s\n", m, cfg.Name) })
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
		fmt.Fprintf(c.out, "installed %s job: `%s %s` every %s\n", m, j.Exe, strings.Join(j.Args(), " "), FmtDurS(cfg.WakeIntervalS))
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
			fmt.Fprintf(c.out, "%-5s %-10s %s\n", strings.ToUpper(ch.Status), ch.Name, ch.Detail)
		}
		if failed == 0 {
			fmt.Fprintln(c.out, "all checks passed")
		} else {
			fmt.Fprintf(c.out, "%d check(s) failed\n", failed)
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

	if ad, err := adapter.Get(cfg.CLI); err != nil {
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
	} else if st := querySchedule(cfg.Name); st.Installed {
		add("scheduler", "ok", "%s: %s", st.Method, st.Detail)
	} else {
		add("scheduler", "fail", "%s: %s; run `agentbus schedule install`", st.Method, st.Detail)
	}

	if kerr != nil {
		add("hub", "skip", "no key")
		return cs
	}
	cl := hub.NewClient(cfg, k, hubVersion())
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
			add("approval", "warn", "waiting for a team admin to approve this agent on the hub web UI")
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

type prompter struct {
	r   *bufio.Reader
	out io.Writer
	yes bool
}

// ask returns def without asking in --yes mode.
func (p *prompter) ask(q, def string) string {
	if p.yes {
		return def
	}
	if def != "" {
		fmt.Fprintf(p.out, "%s [%s]: ", q, def)
	} else {
		fmt.Fprintf(p.out, "%s: ", q)
	}
	line, _ := p.r.ReadString('\n')
	if line = strings.TrimSpace(line); line == "" {
		return def
	}
	return line
}

func (p *prompter) confirm(q string, def bool) bool {
	d := "Y/n"
	if !def {
		d = "y/N"
	}
	a := strings.ToLower(p.ask(q+" ("+d+")", ""))
	if a == "" {
		return def
	}
	return strings.HasPrefix(a, "y")
}

// detectCLIs returns the supported CLIs found on PATH (name -> path).
func detectCLIs() (map[string]string, []string) {
	found := map[string]string{}
	var order []string
	for _, n := range []string{"claude", "codex", "cursor", "gemini"} {
		ad, _ := adapter.Get(n)
		if p, err := adapter.Resolve(ad, adapter.Options{LookPath: lookPath}); err == nil {
			found[n] = p
			order = append(order, n)
		}
	}
	return found, order
}

func cmdSetup(c *cli, args []string) error {
	fs := newFlags("setup")
	yes := fs.Bool("yes", false, "non-interactive: take flags and defaults, ask nothing")
	joinCode := fs.String("join-code", "", "team join code abj_… from a team admin (hub Settings → Agent 加入码); default $AGENTBUS_JOIN_CODE")
	name := fs.String("name", "", "agent name")
	cliName := fs.String("cli", "", "claude | codex | cursor | gemini | custom (default: first found)")
	binary := fs.String("binary", "", "CLI executable path")
	template := fs.String("template", "", "custom CLI command line with {prompt_file}")
	tier := fs.String("tier", "", "permission tier: readonly | workspace | full (default workspace)")
	var repoFlags multi
	fs.Var(&repoFlags, "repo", "OWNER/REPO=PATH local checkout (repeatable)")
	interval := fs.String("interval", "", "tick interval (default 5m)")
	qsrc := fs.String("quota-source", "", "auto | native | magpie | both (default auto)")
	noSched := fs.Bool("no-schedule", false, "do not install the scheduler job")
	method := fs.String("method", "", "scheduler: launchd | systemd | cron | schtasks (default: detect)")
	noDoctor := fs.Bool("no-doctor", false, "skip the final doctor run")
	owner := fs.String("owner", "", "human owner")
	machine := fs.String("machine", "", "machine description")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	pr := &prompter{r: bufio.NewReader(setupIn), out: c.out, yes: *yes}
	say := func(f string, a ...any) {
		if !c.json {
			fmt.Fprintf(c.out, f+"\n", a...)
		}
	}
	ctx, cancel := cmdContext()
	defer cancel()
	dir := hub.Dir()
	existing, _ := hub.LoadConfig(dir)

	// 1. CLIs
	found, order := detectCLIs()
	if len(order) == 0 {
		say("1/7 coding CLIs: none of claude, codex, cursor-agent, gemini found on PATH")
	} else {
		var parts []string
		for _, n := range order {
			parts = append(parts, n+" ("+found[n]+")")
		}
		say("1/7 coding CLIs: %s", strings.Join(parts, ", "))
	}
	def := "claude"
	if existing != nil {
		def = existing.CLI
	} else if len(order) > 0 {
		def = order[0]
	}
	cn := firstOr(*cliName, pr.ask("which CLI should this agent run", def))
	if _, err := adapter.Get(cn); err != nil {
		return &exitError{code: exitUsage, msg: err.Error()}
	}
	if cn == "custom" && *template == "" && existing == nil {
		*template = pr.ask("custom command line (use {prompt_file})", "")
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
			o.url = pr.ask("hub URL", "")
		}
		if o.joinCode == "" {
			o.joinCode = strings.TrimSpace(pr.ask("team join code (abj_…; "+askAdminForCode+")", ""))
		}
		if o.joinCode == "" {
			return &exitError{code: exitUsage, msg: joinCodeMissing}
		}
		if o.name == "" {
			h, _ := os.Hostname()
			sug := suggestName(h, cn)
			o.name = pr.ask("agent name", sug)
			o.autoName = o.name == sug // taken? the join picks sug-2, sug-3, …
		}
	}
	if *interval != "" {
		if o.interval, err = parseDur(*interval); err != nil || o.interval < time.Minute {
			return &exitError{code: exitUsage, msg: "--interval must be a duration of at least 1m"}
		}
	}
	cfg, status, err := hubJoin(ctx, o)
	if err != nil {
		return err
	}
	say("2/7 joined %s as %s (%s) in team %s, status %s", cfg.HubURL, cfg.Name, cfg.MemberID, teamText(cfg), status)
	if status == "pending" {
		say("    waiting for a team admin to approve this agent on the hub web UI")
	}
	if cn != cfg.CLI || (*binary != "" && *binary != cfg.CLIBinary) || (*template != "" && *template != cfg.CLITemplate) {
		cfg.CLI, cfg.CLIBinary, cfg.CLITemplate = cn, firstOr(*binary, cfg.CLIBinary), firstOr(*template, cfg.CLITemplate)
	}
	if o.interval > 0 {
		cfg.WakeIntervalS = int64(o.interval / time.Second)
	}

	// 3. tier
	t := firstOr(*tier, pr.ask("permission tier: readonly (read code, post only) | workspace (edit files in the repo) | full (no limits)", cfg.Tier))
	switch t {
	case adapter.TierReadonly, adapter.TierWorkspace, adapter.TierFull:
	default:
		return &exitError{code: exitUsage, msg: "--tier must be readonly, workspace or full"}
	}
	cfg.Tier = t
	if err := cfg.Save(dir); err != nil {
		return err
	}
	say("3/7 permission tier %s", t)

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
			e := pr.ask("map a GitHub repo to a local checkout, OWNER/REPO=PATH (empty to finish)", "")
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
			return &exitError{code: exitUsage, msg: "--repo wants OWNER/REPO=PATH, got " + e}
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
			return fmt.Errorf("repo %s: %s is not a directory", r, path)
		}
		repos[hub.NormalizeRepo(r)] = path
	}
	if len(entries) > 0 {
		if err := hub.SaveRepos(p.Repos(), repos); err != nil {
			return err
		}
	}
	say("4/7 %d repo(s) mapped in %s", len(repos), p.Repos())

	// 5. scheduler
	if *noSched || cfg.Wake == "trigger" {
		say("5/7 scheduler skipped")
	} else if pr.confirm(fmt.Sprintf("install a scheduler job running `agentbus tick` every %s", FmtDurS(cfg.WakeIntervalS)), true) {
		j := schedJob(cfg)
		m, err := sched.Install(schedHost(), *method, j)
		if err != nil {
			return fmt.Errorf("installing the scheduler job: %w", err)
		}
		say("5/7 installed %s job every %s", m, FmtDurS(cfg.WakeIntervalS))
	} else {
		say("5/7 scheduler skipped (run `agentbus schedule install` later)")
	}

	// 6. quota source
	q := firstOr(*qsrc, pr.ask("quota source: auto | native | magpie | both", cfg.QuotaSource))
	switch q {
	case quota.SourceAuto, quota.SourceNative, quota.SourceMagpie, quota.SourceBoth:
	default:
		return &exitError{code: exitUsage, msg: "--quota-source must be auto, native, magpie or both"}
	}
	cfg.QuotaSource = q
	if err := cfg.Save(dir); err != nil {
		return err
	}
	say("6/7 quota source %s", q)
	magpieMissing := false
	if q != quota.SourceNative {
		if _, err := lookPath("magpie"); err != nil {
			magpieMissing = true
			if q == quota.SourceAuto {
				say("    optional: magpie reads more providers' quota; install it with:\n      %s", magpieInstall)
			} else {
				say("    magpie is not installed; install it with:\n      %s", magpieInstall)
			}
		}
	}

	// 7. doctor
	var cs []check
	failed := 0
	if *noDoctor {
		say("7/7 doctor skipped")
	} else {
		say("7/7 doctor")
		cs = runDoctor(ctx)
		for _, ch := range cs {
			if ch.Status == "fail" {
				failed++
			}
			say("    %-5s %-10s %s", strings.ToUpper(ch.Status), ch.Name, ch.Detail)
		}
	}
	if c.json {
		c.emit(map[string]any{"config": cfg, "status": status, "repos": repos, "magpie_missing": magpieMissing,
			"magpie_install": magpieInstall, "checks": cs}, func() {})
	}
	if failed > 0 {
		say("setup finished with %d failing check(s); fix them and run `agentbus doctor`", failed)
		return &exitError{code: exitErr}
	}
	say("setup done")
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
