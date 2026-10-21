package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/shiroha-document/agentbus/internal/adapter"
	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
	"github.com/shiroha-document/agentbus/internal/quota"
)

// ---- join ----

type joinOpts struct {
	joinCode                                  string
	url, name, display, cli, binary, template string
	usagePaths                                map[string]string
	wake, triggerURL, owner, machine          string
	interval                                  time.Duration
	// autoName: the name was suggested, not chosen; on a name clash the
	// join retries with -2, -3, … instead of failing.
	autoName bool
}

func cmdHubJoin(c *cli, args []string) error {
	fs := newFlags("join")
	var o joinOpts
	fs.StringVar(&o.joinCode, "join-code", "", "team join code abj_… from a team admin (hub Settings → Agent 加入码); default $AGENTBUS_JOIN_CODE")
	fs.StringVar(&o.name, "name", "", "agent name (^[a-z0-9][a-z0-9_-]{1,31}$)")
	fs.StringVar(&o.display, "display-name", "", "display name shown on the hub")
	fs.StringVar(&o.cli, "cli", "claude", "coding CLI: "+strings.Join(adapter.Known, "|"))
	fs.StringVar(&o.binary, "binary", "", "path or name of the CLI executable (default: look it up on PATH)")
	fs.StringVar(&o.template, "template", "", "custom CLI command line, e.g. `mycli --input {prompt_file} --json`")
	var paths multi
	fs.Var(&paths, "usage-path", "custom CLI: field=dotted.json.path (repeatable)")
	interval := fs.String("wake-interval", "5m", "how often the scheduler runs `agentbus tick`")
	fs.StringVar(&o.wake, "wake", "poll", "poll | trigger")
	fs.StringVar(&o.triggerURL, "trigger-url", "", "URL the hub calls to wake this agent (--wake trigger)")
	fs.StringVar(&o.owner, "owner", "", "human owner of this agent")
	fs.StringVar(&o.machine, "machine", "", "machine description (default hostname os/arch)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	o.url = firstOr(hubURLFlag, envHubURL())
	if len(pos) > 0 {
		o.url = pos[0]
	}
	if o.interval, err = parseDur(*interval); err != nil {
		return &exitError{code: exitUsage, msg: i18n.Pick("bad --wake-interval: ", "--wake-interval 无效：") + err.Error()}
	}
	o.usagePaths = map[string]string{}
	for _, p := range paths {
		k, v, ok := strings.Cut(p, "=")
		if !ok {
			return &exitError{code: exitUsage, msg: i18n.Pick("--usage-path wants field=path", "--usage-path 的格式是 field=path")}
		}
		o.usagePaths[k] = v
	}
	ctx, cancel := cmdContext()
	defer cancel()
	cfg, status, err := hubJoin(ctx, o)
	if err != nil {
		return err
	}
	printJoined(c, cfg, status)
	return nil
}

// Join codes: "abj_" + 26 lowercase base32 characters, created by a team
// admin in the hub web UI. The hub only stores their hash.
const (
	joinCodePrefix  = "abj_"
	askAdminForCode = "ask a team admin for a join code (hub Settings → Agent 加入码)"
	joinCodeMissing = "a join code is required to join a hub team: " + askAdminForCode +
		", then pass --join-code abj_… or set AGENTBUS_JOIN_CODE"
	joinCodeBad = "the hub rejected this join code (wrong, expired or revoked): " + askAdminForCode + " and try again"

	askAdminForCodeZh = "向团队管理员要一个加入码（hub Settings → Agent 加入码）"
	joinCodeMissingZh = "加入 hub 团队需要加入码：" + askAdminForCodeZh + "，然后加 --join-code abj_… 或设置 AGENTBUS_JOIN_CODE"
	joinCodeBadZh     = "hub 拒绝了这个加入码（错误、过期或已撤销）：" + askAdminForCodeZh + "后重试"
	pendingEN         = "waiting for a team admin to approve this agent on the hub web UI"
	pendingZh         = "等待团队管理员在 hub 网页上批准这个 agent"
)

func joinCodeMissingText() string { return i18n.Pick(joinCodeMissing, joinCodeMissingZh) }
func pendingText() string         { return i18n.Pick(pendingEN, pendingZh) }

// envJoinCode is $AGENTBUS_JOIN_CODE, the default for --join-code.
func envJoinCode() string { return strings.TrimSpace(os.Getenv("AGENTBUS_JOIN_CODE")) }

// envHubURL is $AGENTBUS_HUB, the default hub URL for join and setup (the
// one-line installer sets it so `agentbus setup` needs no arguments).
func envHubURL() string { return strings.TrimSpace(os.Getenv("AGENTBUS_HUB")) }

// nameVariant is base with a -n suffix, trimmed to the 32-character limit.
func nameVariant(base string, n int) string {
	suf := fmt.Sprintf("-%d", n)
	if len(base)+len(suf) > 32 {
		base = strings.TrimRight(base[:32-len(suf)], "-_")
	}
	return base + suf
}

// normalizeJoinCode trims whitespace (and stray quotes from copy-paste) and
// lower-cases; join codes are lowercase base32.
func normalizeJoinCode(s string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(s), `"'`))
}

// joinError turns hub join errors into actionable messages.
func joinError(err error, name, hubURL string) error {
	switch {
	case hub.IsCode(err, "join_code_required"):
		return fmt.Errorf("%s (%v)", joinCodeMissingText(), err)
	case hub.IsCode(err, "bad_join_code"):
		return fmt.Errorf("%s (%v)", i18n.Pick(joinCodeBad, joinCodeBadZh), err)
	case hub.IsStatus(err, 409):
		return fmt.Errorf(i18n.Pick("the name %q is taken in this team on %s: pick another --name (%v)",
			"名字 %q 在 %s 的这个团队里已被占用：换一个 --name（%v）"), name, hubURL, err)
	}
	return err
}

// teamText is "Name (o_…)" for the team saved in cfg, or "-".
func teamText(cfg *hub.Config) string {
	switch {
	case cfg.TeamName != "" && cfg.TeamID != "":
		return cfg.TeamName + " (" + cfg.TeamID + ")"
	case cfg.TeamID != "":
		return cfg.TeamID
	}
	return "-"
}

// teamOf is the saved team as a JSON object.
func teamOf(cfg *hub.Config) hub.TeamRef { return hub.TeamRef{ID: cfg.TeamID, Name: cfg.TeamName} }

// rememberTeam stores the team reported by the hub in the local config when
// it differs (renamed team, or a config written before teams existed).
// Best effort: status output must not fail because of it.
func rememberTeam(dir string, cfg *hub.Config, t hub.TeamRef) {
	if t.ID == "" || (t.ID == cfg.TeamID && t.Name == cfg.TeamName) {
		return
	}
	cfg.TeamID, cfg.TeamName = t.ID, t.Name
	_ = cfg.Save(dir)
}

func printJoined(c *cli, cfg *hub.Config, status string) {
	c.emit(map[string]any{"member_id": cfg.MemberID, "name": cfg.Name, "hub": cfg.HubURL, "team": teamOf(cfg),
		"status": status, "dir": hub.Dir()}, func() {
		fmt.Fprintf(c.out, i18n.Pick("joined %s as %s (%s) in team %s, status %s; config in %s\n", "已加入 %s，身份 %s（%s），团队 %s，状态 %s；配置在 %s\n"), cfg.HubURL, cfg.Name, cfg.MemberID,
			teamText(cfg), status, hub.Dir())
		if status == "pending" {
			fmt.Fprintln(c.out, pendingText())
		}
	})
}

// hubJoin generates (or reuses) the key, POSTs /agent/join and saves the
// config. Re-running with the same key is idempotent on the hub.
func hubJoin(ctx context.Context, o joinOpts) (*hub.Config, string, error) {
	dir := hub.Dir()
	if cfg, err := hub.LoadConfig(dir); err == nil {
		if o.url == "" || strings.TrimRight(o.url, "/") == cfg.HubURL {
			if o.name == "" || o.name == cfg.Name {
				st := "unknown"
				if k, err := hub.LoadKey(hub.Paths{Dir: dir}.Key()); err == nil {
					if s, err := newClient(cfg, k).State(ctx); err == nil {
						st = s.Member.Status
						rememberTeam(dir, cfg, s.Team)
					}
				}
				return cfg, st, nil
			}
		}
		return nil, "", fmt.Errorf(i18n.Pick("%s is already joined to %s as %s; use --hub-home DIR (or AGENTBUS_HUB_HOME) for another identity", "%s 已经以 %[3]s 的身份加入了 %[2]s；要用另一个身份请加 --hub-home DIR（或设置 AGENTBUS_HUB_HOME）"),
			dir, cfg.HubURL, cfg.Name)
	}
	if !isHubURL(o.url) {
		return nil, "", &exitError{code: exitUsage, msg: i18n.Pick("join needs the hub URL: agentbus join https://hub.example.com --join-code abj_… --name NAME", "join 需要 hub 地址：agentbus join https://hub.example.com --join-code abj_… --name NAME")}
	}
	o.joinCode = normalizeJoinCode(firstOr(strings.TrimSpace(o.joinCode), envJoinCode()))
	if o.joinCode == "" {
		return nil, "", &exitError{code: exitUsage, msg: joinCodeMissingText()}
	}
	if !strings.HasPrefix(o.joinCode, joinCodePrefix) {
		return nil, "", &exitError{code: exitUsage, msg: i18n.Pick("join codes start with abj_: "+askAdminForCode,
			"加入码以 abj_ 开头："+askAdminForCodeZh)}
	}
	if !nameRE.MatchString(o.name) {
		return nil, "", &exitError{code: exitUsage, msg: i18n.Pick("join needs --name matching ^[a-z0-9][a-z0-9_-]{1,31}$", "join 需要符合 ^[a-z0-9][a-z0-9_-]{1,31}$ 的 --name")}
	}
	if _, err := adapter.Get(o.cli); err != nil {
		return nil, "", &exitError{code: exitUsage, msg: err.Error()}
	}
	if o.cli == "custom" && o.template == "" {
		return nil, "", &exitError{code: exitUsage, msg: i18n.Pick("--cli custom needs --template 'CMD ... {prompt_file}'", "--cli custom 需要 --template 'CMD ... {prompt_file}'")}
	}
	if o.wake == "" {
		o.wake = "poll"
	}
	if o.wake != "poll" && o.wake != "trigger" {
		return nil, "", &exitError{code: exitUsage, msg: i18n.Pick("--wake must be poll or trigger", "--wake 只能是 poll 或 trigger")}
	}
	if o.wake == "trigger" && o.triggerURL == "" {
		return nil, "", &exitError{code: exitUsage, msg: i18n.Pick("--wake trigger needs --trigger-url", "--wake trigger 需要 --trigger-url")}
	}
	if o.interval <= 0 {
		o.interval = 5 * time.Minute
	}
	if o.machine == "" {
		h, _ := os.Hostname()
		o.machine = strings.TrimSpace(h + " " + runtime.GOOS + "/" + runtime.GOARCH)
	}
	if o.owner == "" {
		o.owner = firstOr(os.Getenv("USER"), os.Getenv("USERNAME"))
	}
	p := hub.Paths{Dir: dir}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, "", err
	}
	k, err := hub.LoadKey(p.Key())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return nil, "", err
		}
		if k, err = hub.GenerateKey(); err != nil {
			return nil, "", err
		}
		if err := hub.SaveKey(p.Key(), k); err != nil {
			return nil, "", err
		}
	}
	cfg := &hub.Config{HubURL: strings.TrimRight(o.url, "/"), Name: o.name, CLI: o.cli, CLIBinary: o.binary,
		CLITemplate: o.template, Wake: o.wake, WakeIntervalS: int64(o.interval / time.Second), TriggerURL: o.triggerURL,
		Owner: o.owner, Machine: o.machine}
	if len(o.usagePaths) > 0 {
		cfg.CLIUsagePaths = o.usagePaths
	}
	cl := newClient(cfg, k)
	base := o.name
	var res *hub.JoinResp
	for n := 1; ; n++ {
		if n > 1 {
			cfg.Name = nameVariant(base, n)
		}
		res, err = cl.Join(ctx, hub.JoinReq{JoinCode: o.joinCode, Name: cfg.Name, DisplayName: o.display, CLI: o.cli, WakeMode: o.wake,
			WakeIntervalS: cfg.WakeIntervalS, Owner: o.owner, Machine: o.machine, PublicKey: hub.PublicKeyB64(k),
			ClientVersion: hubVersion(), TriggerURL: o.triggerURL})
		if err == nil || !o.autoName || !hub.IsStatus(err, 409) || n >= 20 {
			break
		}
	}
	if err != nil {
		return nil, "", joinError(err, cfg.Name, cfg.HubURL)
	}
	cfg.MemberID = res.MemberID
	cfg.TeamID, cfg.TeamName = res.Team.ID, res.Team.Name
	cfg.JoinedAt = time.Now().UnixMilli()
	if err := cfg.Save(dir); err != nil {
		return nil, "", err
	}
	return cfg, res.Status, nil
}

// ---- state / status ----

func cmdHubState(c *cli, args []string) error {
	if _, err := parse(newFlags("state"), args); err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	s, err := e.cl.State(ctx)
	if err != nil {
		return err
	}
	rememberTeam(e.dir, e.cfg, s.Team)
	if s.Team.ID == "" { // older hub: fall back to what join saved
		s.Team = teamOf(e.cfg)
	}
	c.emit(s, func() {
		m := s.Member
		fmt.Fprintf(c.out, "%s (%s) on %s\n", m.Name, m.ID, e.cfg.HubURL)
		fmt.Fprintf(c.out, "team %s\n", teamText(e.cfg))
		fmt.Fprintf(c.out, i18n.Pick("role %s, status %s%s\n", "角色 %s，状态 %s%s\n"), m.Role, m.Status, pauseText(s))
		fmt.Fprintf(c.out, i18n.Pick("pending deliveries %d; cli %s, tier %s, wake %s every %s\n", "待处理投递 %d；cli %s，权限 %s，唤醒 %s 每 %s\n"), s.Pending, e.cfg.CLI, e.cfg.Tier,
			e.cfg.Wake, FmtDurS(e.cfg.WakeIntervalS))
		fmt.Fprintf(c.out, i18n.Pick("hub %s, min client %s, this client %s\n", "hub %s，最低客户端 %s，本客户端 %s\n"), dash(s.ServerVersion), dash(s.MinClientVersion), hubVersion())
	})
	return nil
}

// FmtDurS formats seconds.
func FmtDurS(s int64) string { return hub.FmtDuration(time.Duration(s) * time.Second) }

func pauseText(s *hub.State) string {
	var parts []string
	if s.Member.Paused {
		p := "paused"
		if s.Member.PauseReason != nil && *s.Member.PauseReason != "" {
			p += ": " + *s.Member.PauseReason
		}
		if s.Member.PausedUntil != nil && *s.Member.PausedUntil > 0 {
			p += " until " + fmtMS(*s.Member.PausedUntil)
		}
		parts = append(parts, p)
	}
	if s.GlobalPause {
		parts = append(parts, "hub globally paused")
	}
	if len(parts) == 0 {
		return ""
	}
	return " — " + strings.Join(parts, "; ")
}

func fmtMS(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).Local().Format("2006-01-02 15:04")
}

func agoMS(ms int64) string {
	if ms <= 0 {
		return "never"
	}
	return ago(time.UnixMilli(ms))
}

var tickExitText = map[int]string{0: "processed threads", 1: "error", 2: "usage error", 3: "nothing to do", 4: "paused / pending", 5: "quota exhausted"}

func cmdHubStatus(c *cli, args []string) error {
	fs := newFlags("status")
	noQuota := fs.Bool("no-quota", false, "skip reading local quota")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	s, serr := e.cl.State(ctx)
	ls := hub.LoadState(e.dir)
	var rs []quota.Reading
	if !*noQuota {
		rs = quota.Collect(ctx, quota.Options{Source: e.cfg.QuotaSource, Timeout: 10 * time.Second})
	}
	st := querySchedule(e.cfg.Name)
	if s != nil && serr == nil {
		rememberTeam(e.dir, e.cfg, s.Team)
	}
	out := map[string]any{"name": e.cfg.Name, "member_id": e.cfg.MemberID, "hub": e.cfg.HubURL, "team": teamOf(e.cfg),
		"local": ls, "quota": rs, "schedule": st}
	if s != nil && serr == nil {
		out["state"] = s
	} else {
		out["error"] = serr.Error()
	}
	c.emit(out, func() {
		fmt.Fprintf(c.out, "%s (%s) on %s\n", e.cfg.Name, e.cfg.MemberID, e.cfg.HubURL)
		fmt.Fprintf(c.out, "team %s\n", teamText(e.cfg))
		if serr != nil {
			fmt.Fprintf(c.out, "hub: %v\n", serr)
		} else {
			fmt.Fprintf(c.out, i18n.Pick("status %s, role %s%s; pending deliveries %d\n", "状态 %s，角色 %s%s；待处理投递 %d\n"), s.Member.Status, s.Member.Role, pauseText(s), s.Pending)
		}
		lt := "never"
		if ls.LastTickAt > 0 {
			lt = fmt.Sprintf("%s (exit %d, %s)", agoMS(ls.LastTickAt), ls.LastExit, tickExitText[ls.LastExit])
		}
		fmt.Fprintf(c.out, i18n.Pick("last tick %s\n", "上次 tick %s\n"), lt)
		if ls.LastError != "" {
			fmt.Fprintf(c.out, i18n.Pick("last error %s\n", "上次错误 %s\n"), ls.LastError)
		}
		if ls.LastRunAt > 0 {
			fmt.Fprintf(c.out, i18n.Pick("last run %s in %s\n", "上次运行 %s，线程 %s\n"), agoMS(ls.LastRunAt), ls.LastThread)
		}
		if ls.BaselineInput > 0 {
			fmt.Fprintf(c.out, i18n.Pick("wake-up baseline %s input tokens\n", "每次唤醒基线 %s 输入 token\n"), hub.FmtTokens(ls.BaselineInput))
		}
		fmt.Fprintf(c.out, i18n.Pick("scheduler %s: %s\n", "定时任务 %s：%s\n"), st.Method, schedText(st))
		if !*noQuota {
			fmt.Fprintf(c.out, i18n.Pick("quota %s\n", "额度 %s\n"), quotaSummary(rs))
		}
	})
	return nil
}

func quotaSummary(rs []quota.Reading) string {
	if len(rs) == 0 {
		return "no readings"
	}
	var parts []string
	for _, r := range rs {
		switch {
		case r.Error != "":
			parts = append(parts, fmt.Sprintf("%s/%s ?", r.Provider, r.Window))
		case r.UsedPct != nil:
			p := fmt.Sprintf("%s/%s %.0f%%", r.Provider, r.Window, *r.UsedPct)
			if r.ResetsAt != nil && *r.ResetsAt > 0 {
				p += " (resets " + time.UnixMilli(*r.ResetsAt).Local().Format("01-02 15:04") + ")"
			}
			parts = append(parts, p)
		case r.Balance != nil:
			parts = append(parts, fmt.Sprintf("%s %.2f %s", r.Provider, r.Balance.Amount, r.Balance.Currency))
		}
	}
	return strings.Join(parts, " · ")
}

// ---- tick ----

func cmdTick(c *cli, args []string) error {
	fs := newFlags("tick")
	max := fs.Int("max-threads", 0, "threads to claim this round (default: hub config)")
	timeout := fs.String("timeout", "20m", "per-thread CLI timeout")
	dry := fs.Bool("dry-run", false, "claim, print the prompt and CLI command, release without running")
	quiet := fs.Bool("quiet", false, "no progress log on stderr")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	to, err := parseDur(*timeout)
	if err != nil || to <= 0 {
		return &exitError{code: exitUsage, msg: "bad --timeout"}
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	exe, _ := os.Executable()
	ctx, cancel := cmdContext()
	defer cancel()
	var log io.Writer = c.errw
	if *quiet {
		log = nil
	}
	tk := &hub.Ticker{Dir: e.dir, Cfg: e.cfg, Client: e.cl, Version: hubVersion(), Exe: exe, Log: log,
		MaxThreads: *max, Timeout: to, DryRun: *dry}
	out, err := tk.Run(ctx)
	if err != nil {
		return err
	}
	if !*dry {
		recordTick(out, e.cfg.CLI)
	}
	c.emit(out, func() {
		fmt.Fprintf(c.errw, "agentbus tick: %s\n", out.Message)
		for _, t := range out.Threads {
			s := "acked"
			switch {
			case t.TimedOut:
				s = "timed out (released)"
			case t.Nacked:
				s = "released"
			case !t.Acked:
				s = "not acked"
			}
			if t.ErrorSummary != "" {
				s += ": " + firstLine(t.ErrorSummary)
			}
			fmt.Fprintf(c.out, "%s %s\n", t.ThreadID, s)
		}
	})
	if out.Code != 0 {
		return &exitError{code: out.Code}
	}
	return nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " …"
	}
	return s
}

// ---- post / confirm / ack ----

// postKey is the idempotency key: AGENTBUS_ROUND + body hash inside a round
// (so a retried command never double-posts), else random per invocation.
func postKey(explicit, kind, body string) string {
	if explicit != "" {
		return explicit
	}
	if r := strings.TrimSpace(os.Getenv("AGENTBUS_ROUND")); r != "" {
		h := sha256.Sum256([]byte(kind + "\n" + body))
		return r + ":" + hex.EncodeToString(h[:])[:16]
	}
	return "cli:" + hub.NewNonce()
}

func bodyArg(text, file string, pos []string) (string, error) {
	if file == "" && text == "" && len(pos) > 0 && pos[len(pos)-1] == "-" {
		file = "-"
	}
	b, err := readBody(text, file)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(b) == "" {
		return "", &exitError{code: exitUsage, msg: i18n.Pick("empty body: pass --body TEXT, --body-file F or - (stdin)", "正文为空：用 --body TEXT、--body-file F 或 -（标准输入）")}
	}
	return b, nil
}

func cmdPost(c *cli, args []string) error {
	fs := newFlags("post")
	thread := fs.String("thread", "", "thread id (default $AGENTBUS_THREAD)")
	body := fs.String("body", "", "post body (Markdown)")
	file := fs.String("body-file", "", "read the body from a file (- = stdin)")
	kind := fs.String("kind", "msg", "msg | progress | confirm")
	reply := fs.String("reply", "", "post id this replies to")
	key := fs.String("key", "", "idempotency key (default $AGENTBUS_ROUND + body hash)")
	ws := fs.String("workspace", "", "open a new thread in this workspace (with --title)")
	title := fs.String("title", "", "title of the new thread")
	assignee := fs.String("assignee", "", "assignee of the new thread (name)")
	var attach multi
	fs.Var(&attach, "attach", "attach a file (repeatable, up to 6 files of 10 MB each)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	switch *kind {
	case "msg", "progress", "confirm":
	default:
		return &exitError{code: exitUsage, msg: i18n.Pick("--kind must be msg, progress or confirm", "--kind 只能是 msg、progress 或 confirm")}
	}
	b, err := bodyArg(*body, *file, pos)
	if err != nil {
		return err
	}
	np := hub.NewPost{Body: b, Kind: *kind, ReplyTo: *reply}
	if *ws != "" || *title != "" {
		if *ws == "" || *title == "" {
			return &exitError{code: exitUsage, msg: i18n.Pick("a new thread needs both --workspace and --title", "新建线程需要同时给出 --workspace 和 --title")}
		}
		np = hub.NewPost{WorkspaceID: *ws, Title: *title, Assignee: *assignee, Body: b}
	} else if np.ThreadID, err = threadArg(*thread); err != nil {
		return err
	}
	files, err := readAttachments(attach)
	if err != nil {
		return err
	}
	np.IdempotencyKey = postKey(*key, np.Kind+np.Title, b+attachKey(files))
	return doPostFiles(c, np, files)
}

func doPost(c *cli, np hub.NewPost) error { return doPostFiles(c, np, nil) }

// doPostFiles uploads files, then posts np with them attached. Inside a tick
// round it first shows "typing" on the thread (best effort).
func doPostFiles(c *cli, np hub.NewPost, files []attachFile) error {
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	np.CLI = firstOr(strings.TrimSpace(os.Getenv("AGENTBUS_CLI")), e.cfg.CLI)
	np.Model = strings.TrimSpace(os.Getenv("AGENTBUS_MODEL"))
	if os.Getenv("AGENTBUS_IN_TICK") == "1" && np.ThreadID != "" {
		actx, acancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		_ = e.cl.Activity(actx, hub.ActivityReq{ThreadID: np.ThreadID, State: "typing", CLI: np.CLI, Model: np.Model})
		acancel()
	}
	for _, f := range files {
		a, err := e.cl.Upload(ctx, f.name, f.mime, f.data)
		if err != nil {
			return fmt.Errorf(i18n.Pick("uploading %s: %w", "上传 %s 失败：%w"), f.name, err)
		}
		if a.ID == "" {
			return fmt.Errorf(i18n.Pick("uploading %s: the hub returned no attachment id", "上传 %s 失败：hub 没有返回附件 id"), f.name)
		}
		np.Attachments = append(np.Attachments, a.ID)
	}
	r, err := e.cl.Post(ctx, np)
	if err != nil {
		return err
	}
	c.emit(r, func() {
		what := "posted"
		if r.Duplicate {
			what = "already posted"
		}
		fmt.Fprintf(c.out, "%s %s in %s", what, r.Post.ID, firstOr(r.Post.ThreadID, r.Thread.ID))
		if np.Title != "" {
			fmt.Fprintf(c.out, " (new thread %q)", r.Thread.Title)
		}
		if n := len(np.Attachments); n > 0 {
			fmt.Fprintf(c.out, i18n.Pick(" with %d attachment(s)", "，附件 %d 个"), n)
		}
		fmt.Fprintln(c.out)
		if r.Collapsed {
			fmt.Fprintln(c.out, i18n.Pick("updated the previous progress post", "已更新上一条进度"))
		}
		if len(r.Redacted) > 0 {
			fmt.Fprintf(c.errw, i18n.Pick("agentbus: the hub redacted secrets from the post: %s\n", "agentbus: hub 从帖子中抹掉了密钥：%s\n"),
				strings.Join(r.Redacted, ", "))
		}
	})
	return nil
}

func cmdConfirm(c *cli, args []string) error {
	fs := newFlags("confirm")
	thread := fs.String("thread", "", "thread id (default $AGENTBUS_THREAD)")
	file := fs.String("body-file", "", "read the question from a file (- = stdin)")
	key := fs.String("key", "", "idempotency key")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	q := strings.Join(pos, " ")
	if q == "-" {
		q, *file = "", "-"
	}
	b, err := bodyArg(q, *file, nil)
	if err != nil {
		return err
	}
	t, err := threadArg(*thread)
	if err != nil {
		return err
	}
	return doPost(c, hub.NewPost{ThreadID: t, Kind: "confirm", Body: b, IdempotencyKey: postKey(*key, "confirm", b)})
}

func cmdHubAck(c *cli, args []string) error {
	fs := newFlags("ack")
	thread := fs.String("thread", "", "thread id (default $AGENTBUS_THREAD)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	t, err := threadArg(*thread)
	if err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	if err := e.cl.Ack(ctx, t, pos); err != nil {
		return err
	}
	c.emit(map[string]any{"thread": t, "acked": true}, func() { fmt.Fprintf(c.out, "acked %s\n", t) })
	return nil
}

// ---- thread ----

func cmdHubThread(c *cli, args []string) error {
	if len(args) == 0 {
		return &exitError{code: exitUsage, msg: "thread show|state|assign|close|list"}
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "show":
		return threadShow(c, rest)
	case "state":
		return threadState(c, rest)
	case "assign":
		return threadAssign(c, rest)
	case "close":
		return threadClose(c, rest)
	case "list", "ls":
		return threadList(c, rest)
	}
	return &exitError{code: exitUsage, msg: "unknown thread subcommand " + sub + " (show|state|assign|close|list)"}
}

func threadShow(c *cli, args []string) error {
	fs := newFlags("thread show")
	before := fs.String("before", "", "show posts before this post id")
	limit := fs.Int("limit", 0, "number of posts")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	t, err := threadArg(firstOr(strings.Join(pos, ""), ""))
	if err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	hc, cerr := e.cl.Context(ctx, t)
	names := map[string]string{}
	var posts []hub.Post
	hasMore := false
	if cerr == nil {
		for _, m := range hc.Members {
			names[m.ID] = m.Name
		}
		names[hc.Me.ID] = hc.Me.Name
		posts, hasMore = hc.Posts, hc.HasMore
	}
	if *before != "" || *limit > 0 || cerr != nil {
		pr, err := e.cl.Posts(ctx, t, *before, *limit)
		if err != nil {
			return err
		}
		posts, hasMore = pr.Posts, pr.HasMore
	}
	out := map[string]any{"posts": posts, "has_more": hasMore}
	if cerr == nil {
		out["thread"], out["workspace"] = hc.Thread, hc.Workspace
	}
	c.emit(out, func() {
		if cerr == nil {
			th := hc.Thread
			fmt.Fprintf(c.out, "%s  %s  [%s] in %s", th.ID, th.Title, th.Status, hc.Workspace.Name)
			if th.AssigneeID != nil {
				fmt.Fprintf(c.out, ", assignee %s", firstOr(names[*th.AssigneeID], *th.AssigneeID))
			}
			fmt.Fprintln(c.out)
			if s := strings.TrimSpace(th.State); s != "" && *before == "" {
				fmt.Fprintf(c.out, "\n当前状态:\n%s\n", indent(s))
			}
			fmt.Fprintln(c.out)
		}
		if hasMore && len(posts) > 0 {
			fmt.Fprintf(c.out, i18n.Pick("(older: agentbus thread show %s --before %s)\n", "（更早的：agentbus thread show %s --before %s）\n"), t, posts[0].ID)
		}
		for _, p := range posts {
			who := firstOr(names[p.AuthorID], p.AuthorID)
			extra := ""
			if p.Kind != "msg" && p.Kind != "" {
				extra = " [" + p.Kind + "]"
			}
			if p.ReplyTo != nil {
				extra += " ↩" + *p.ReplyTo
			}
			if p.Confirmation != nil {
				extra += " (confirmation " + p.Confirmation.Status + ")"
			}
			fmt.Fprintf(c.out, "%s  %s  @%s%s\n%s\n\n", p.ID, fmtMS(p.CreatedAt), who, extra, indent(strings.TrimSpace(p.Body)))
		}
	})
	return nil
}

func indent(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = "    " + l
	}
	return strings.Join(lines, "\n")
}

func patchThread(c *cli, t string, p hub.ThreadPatch, what string) error {
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	th, err := e.cl.PatchThread(ctx, t, p)
	if err != nil {
		return err
	}
	c.emit(map[string]any{"thread": th}, func() { fmt.Fprintf(c.out, "%s %s\n", what, firstOr(th.ID, t)) })
	return nil
}

func threadState(c *cli, args []string) error {
	fs := newFlags("thread state")
	body := fs.String("body", "", "new pinned state (Markdown)")
	file := fs.String("body-file", "", "read it from a file (- = stdin)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	id := ""
	if len(pos) > 0 && pos[0] != "-" {
		id = pos[0]
	}
	b, err := bodyArg(*body, *file, pos)
	if err != nil {
		return err
	}
	t, err := threadArg(id)
	if err != nil {
		return err
	}
	return patchThread(c, t, hub.ThreadPatch{State: &b}, "updated state of")
}

func threadAssign(c *cli, args []string) error {
	pos, err := parse(newFlags("thread assign"), args)
	if err != nil {
		return err
	}
	var id, who string
	switch len(pos) {
	case 1:
		who = pos[0]
	case 2:
		id, who = pos[0], pos[1]
	default:
		return &exitError{code: exitUsage, msg: "thread assign [THREAD] NAME"}
	}
	t, err := threadArg(id)
	if err != nil {
		return err
	}
	who = strings.TrimPrefix(who, "@")
	return patchThread(c, t, hub.ThreadPatch{Assignee: &who}, "assigned "+who+" to")
}

func threadClose(c *cli, args []string) error {
	fs := newFlags("thread close")
	done := fs.Bool("done", false, "mark as done (finished) instead of closed")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	t, err := threadArg(strings.Join(pos, ""))
	if err != nil {
		return err
	}
	st := "closed"
	if *done {
		st = "done"
	}
	return patchThread(c, t, hub.ThreadPatch{Status: &st}, "marked "+st+":")
}

func threadList(c *cli, args []string) error {
	fs := newFlags("thread list")
	ws := fs.String("workspace", "", "workspace id")
	mine := fs.Bool("mine", false, "only threads assigned to me")
	status := fs.String("status", "", "open | done | closed")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	ts, err := e.cl.Threads(ctx, *ws, *status, *mine)
	if err != nil {
		return err
	}
	c.emit(map[string]any{"threads": ts}, func() {
		tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "THREAD\tSTATUS\tWORKSPACE\tLAST POST\tTITLE")
		for _, t := range ts {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", t.ID, t.Status, t.WorkspaceID, fmtMS(t.LastPostAt), t.Title)
		}
		tw.Flush()
	})
	return nil
}

// ---- quota ----

func cmdQuota(c *cli, args []string) error {
	fs := newFlags("quota")
	asJSON := fs.Bool("json", false, "JSON output")
	source := fs.String("source", "", "auto | native (legacy magpie/both are read natively)")
	report := fs.Bool("report", false, "also POST the readings to the hub")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *asJSON {
		c.json = true
	}
	var e *hubEnv
	src := *source
	if *report || src == "" {
		var err error
		if e, err = loadHub(); err != nil && *report {
			return err
		}
		if e != nil && src == "" {
			src = e.cfg.QuotaSource
		}
	}
	switch src {
	case "", quota.SourceAuto, quota.SourceNative, quota.SourceMagpie, quota.SourceBoth:
	default:
		return &exitError{code: exitUsage, msg: "--source must be auto, native, magpie or both"}
	}
	ctx, cancel := cmdContext()
	defer cancel()
	rs := quota.Collect(ctx, quota.Options{Source: src})
	if rs == nil {
		rs = []quota.Reading{}
	}
	var qr *hub.QuotaResp
	if *report {
		var err error
		if qr, err = e.cl.Quota(ctx, rs); err != nil {
			return err
		}
	}
	c.emit(map[string]any{"readings": rs, "hub": qr}, func() {
		if len(rs) == 0 {
			fmt.Fprintln(c.out, i18n.Pick("no quota readings on this machine", "本机没有额度读数"))
		} else {
			tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
			fmt.Fprintln(tw, "PROVIDER\tWINDOW\tUSED\tRESETS\tPLAN\tSOURCE\tNOTE")
			for _, r := range rs {
				used := "-"
				if r.UsedPct != nil {
					used = fmt.Sprintf("%.0f%%", *r.UsedPct)
				} else if r.Balance != nil {
					used = fmt.Sprintf("%.2f %s", r.Balance.Amount, r.Balance.Currency)
				}
				resets := "-"
				if r.ResetsAt != nil {
					resets = fmtMS(*r.ResetsAt)
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.Provider, dash(r.Window), used, resets, dash(r.Plan), r.Source, r.Error)
			}
			tw.Flush()
		}
		if qr != nil {
			if qr.Paused {
				fmt.Fprintf(c.out, i18n.Pick("hub: paused (%s)%s\n", "hub：已暂停（%s）%s\n"), derefS(qr.PauseReason), untilText(qr.PausedUntil))
			} else {
				fmt.Fprintln(c.out, i18n.Pick("hub: reported, not paused", "hub：已上报，未暂停"))
			}
		}
	})
	return nil
}

func derefS(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func untilText(ms *int64) string {
	if ms == nil || *ms <= 0 {
		return ""
	}
	return " until " + fmtMS(*ms)
}

// ---- usage ----

func cmdUsage(c *cli, args []string) error {
	if len(args) > 0 && args[0] == "baseline" {
		return usageBaseline(c, args[1:])
	}
	fs := newFlags("usage")
	days := fs.Int("days", 7, "days to summarize")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	dir := hub.Dir()
	es, err := hub.ReadUsage(hub.Paths{Dir: dir}.Usage())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	type agg struct {
		Day       string  `json:"day"`
		Runs      int     `json:"runs"`
		Failed    int     `json:"failed"`
		Input     int64   `json:"input"`
		Cached    int64   `json:"cache_read"`
		Output    int64   `json:"output"`
		CostUSD   float64 `json:"cost_usd_est"`
		Unreport  int     `json:"unreported"`
		Baselines int     `json:"baselines"`
	}
	cut := time.Now().AddDate(0, 0, -*days+1)
	cut = time.Date(cut.Year(), cut.Month(), cut.Day(), 0, 0, 0, 0, time.Local)
	byDay := map[string]*agg{}
	byThread := map[string]*agg{}
	var total agg
	total.Day = "total"
	for _, en := range es {
		r := en.Run
		t := time.UnixMilli(r.StartedAt)
		if t.Before(cut) {
			continue
		}
		day := t.Local().Format("2006-01-02")
		th := "(none)"
		if r.ThreadID != nil {
			th = *r.ThreadID
		}
		for _, a := range []*agg{getAgg(byDay, day), getAgg(byThread, th), &total} {
			a.Runs++
			if r.ErrorSummary != nil && *r.ErrorSummary == "baseline" {
				a.Baselines++
			} else if r.ExitCode != 0 {
				a.Failed++
			}
			a.Input += r.Input + r.CacheWrite + r.CacheRead
			a.Cached += r.CacheRead
			a.Output += r.Output + r.Reasoning
			if r.CostUSD != nil {
				a.CostUSD += *r.CostUSD
			}
			if !en.Reported {
				a.Unreport++
			}
		}
	}
	keys := func(m map[string]*agg) []string {
		var ks []string
		for k := range m {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		return ks
	}
	var days_, threads []agg
	for _, k := range keys(byDay) {
		days_ = append(days_, *byDay[k])
	}
	for _, k := range keys(byThread) {
		a := *byThread[k]
		a.Day = k
		threads = append(threads, a)
	}
	ls := hub.LoadState(dir)
	c.emit(map[string]any{"days": days_, "threads": threads, "total": total, "baseline_tokens": ls.BaselineInput}, func() {
		if total.Runs == 0 {
			fmt.Fprintf(c.out, i18n.Pick("no runs in the last %d day(s) (%s)\n", "最近 %d 天没有运行记录（%s）\n"), *days, hub.Paths{Dir: dir}.Usage())
			return
		}
		tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "DAY\tRUNS\tFAILED\tINPUT\tCACHED\tOUTPUT\tCOST")
		for _, a := range append(days_, total) {
			fmt.Fprintf(tw, "%s\t%d\t%d\t%s\t%s\t%s\t%s\n", a.Day, a.Runs, a.Failed, hub.FmtTokens(a.Input), hub.FmtTokens(a.Cached),
				hub.FmtTokens(a.Output), hub.FmtUSD(a.CostUSD))
		}
		tw.Flush()
		fmt.Fprintln(c.out)
		tw = tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "THREAD\tRUNS\tINPUT\tOUTPUT\tCOST")
		for _, a := range threads {
			fmt.Fprintf(tw, "%s\t%d\t%s\t%s\t%s\n", a.Day, a.Runs, hub.FmtTokens(a.Input), hub.FmtTokens(a.Output), hub.FmtUSD(a.CostUSD))
		}
		tw.Flush()
		if ls.BaselineInput > 0 {
			fmt.Fprintf(c.out, i18n.Pick("\nwake-up baseline: %s input tokens per round\n", "\n每次唤醒基线：每轮 %s 输入 token\n"), hub.FmtTokens(ls.BaselineInput))
		}
		if total.Unreport > 0 {
			fmt.Fprintf(c.out, i18n.Pick("%d run(s) not yet reported to the hub (the next tick retries)\n", "%d 次运行还没上报 hub（下次 tick 会重试）\n"), total.Unreport)
		}
	})
	return nil
}

func getAgg[T any](m map[string]*T, k string) *T {
	if a, ok := m[k]; ok {
		return a
	}
	a := new(T)
	m[k] = a
	return a
}

// baselineLookPath is a test seam.
var baselineLookPath func(string) (string, error)

func usageBaseline(c *cli, args []string) error {
	fs := newFlags("usage baseline")
	runs := fs.Int("runs", 2, "how many calibration runs (the smallest wins)")
	timeout := fs.String("timeout", "5m", "per-run timeout")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	to, err := parseDur(*timeout)
	if err != nil {
		return &exitError{code: exitUsage, msg: "bad --timeout"}
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	fmt.Fprintf(c.errw, i18n.Pick("agentbus: running %s %d time(s) with a trivial prompt…\n", "agentbus：用一个简单提示运行 %s %d 次…\n"), e.cfg.CLI, *runs)
	r, _, err := hub.Baseline(ctx, e.dir, e.cfg, hub.BaselineOptions{Runs: *runs, Timeout: to, LookPath: baselineLookPath})
	if err != nil {
		return err
	}
	_ = hub.AppendUsage(e.paths().Usage(), hub.UsageEntry{Run: *r})
	reported := false
	if _, err := e.cl.Runs(ctx, []hub.Run{*r}); err != nil {
		fmt.Fprintf(c.errw, i18n.Pick("agentbus: reporting the baseline failed (the next tick retries): %v\n", "agentbus：上报基线失败（下次 tick 会重试）：%v\n"), err)
	} else {
		reported = true
		_ = hub.MarkReported(e.paths().Usage(), []string{r.ID})
	}
	total := r.Input + r.CacheWrite + r.CacheRead
	st := hub.LoadState(e.dir)
	st.BaselineInput = total
	_ = hub.SaveState(e.dir, st)
	c.emit(map[string]any{"run": r, "total_input": total, "reported": reported}, func() {
		cost := ""
		if r.CostUSD != nil {
			cost = " · 约 " + hub.FmtUSD(*r.CostUSD)
		}
		fmt.Fprintf(c.out, "baseline: %s input (cached %s) / %s output per wake-up%s\n",
			hub.FmtTokens(total), hub.FmtTokens(r.CacheRead), hub.FmtTokens(r.Output+r.Reasoning), cost)
	})
	return nil
}

// ---- keys ----

func cmdKeys(c *cli, args []string) error {
	if len(args) == 0 || args[0] != "rotate" {
		return &exitError{code: exitUsage, msg: "keys rotate"}
	}
	if _, err := parse(newFlags("keys rotate"), args[1:]); err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	nk, err := hub.GenerateKey()
	if err != nil {
		return err
	}
	p := e.paths()
	staged := p.Key() + ".new"
	// keep the new key on disk before the hub knows it, so a crash never
	// leaves us with a registered key we no longer have
	if err := hub.SaveKey(staged, nk); err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	exp, err := e.cl.RotateKey(ctx, hub.PublicKeyB64(nk))
	if err != nil {
		os.Remove(staged)
		return err
	}
	if err := hub.SaveKey(p.OldKey(), e.key); err != nil {
		return err
	}
	if err := os.Rename(staged, p.Key()); err != nil {
		return fmt.Errorf(i18n.Pick("the hub accepted the new key but installing it failed (it is in %s): %w", "hub 已接受新密钥，但本地安装失败（新密钥在 %s）：%w"), staged, err)
	}
	c.emit(map[string]any{"public_key": hub.PublicKeyB64(nk), "old_key_expires_at": exp}, func() {
		fmt.Fprintf(c.out, i18n.Pick("rotated key; new public key %s; the old key stops working at %s\n", "已轮换密钥；新公钥 %s；旧密钥在 %s 失效\n"), hub.PublicKeyB64(nk), fmtMS(exp))
	})
	return nil
}

// ---- manager ----

func resolveMember(ctx context.Context, cl *hub.Client, who string) (*hub.Member, error) {
	who = strings.TrimPrefix(who, "@")
	ms, err := cl.ManageMembers(ctx)
	if err != nil {
		return nil, err
	}
	for i := range ms {
		if ms[i].ID == who || ms[i].Name == who {
			return &ms[i], nil
		}
	}
	return nil, fmt.Errorf(i18n.Pick("no member named %q (see `agentbus manage members`)", "没有名为 %q 的成员（见 `agentbus manage members`）"), who)
}

func memberAction(c *cli, who, action string, body any) error {
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	m, err := resolveMember(ctx, e.cl, who)
	if err != nil {
		return err
	}
	if err := e.cl.ManageMember(ctx, m.ID, action, body); err != nil {
		return err
	}
	c.emit(map[string]any{"member": m.ID, "name": m.Name, "action": action}, func() {
		fmt.Fprintf(c.out, "%s: %s (%s)\n", action, m.Name, m.ID)
	})
	return nil
}

func cmdPause(c *cli, args []string) error {
	fs := newFlags("pause")
	reason := fs.String("reason", "", "why (shown on the hub)")
	until := fs.String("until", "", "resume automatically after this long (e.g. 2h) or at RFC3339 time")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "member name"); err != nil {
		return err
	}
	body := map[string]any{"reason": firstOr(*reason, "paused by manager")}
	if *until != "" {
		t, err := parseWhen(*until, time.Now())
		if err != nil {
			return &exitError{code: exitUsage, msg: "bad --until: " + err.Error()}
		}
		body["until"] = t.UnixMilli()
	}
	return memberAction(c, pos[0], "pause", body)
}

func cmdResume(c *cli, args []string) error {
	pos, err := parse(newFlags("resume"), args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "member name"); err != nil {
		return err
	}
	return memberAction(c, pos[0], "resume", nil)
}

func cmdManage(c *cli, args []string) error {
	if len(args) == 0 {
		return &exitError{code: exitUsage, msg: "manage members|approve|reject|workspace"}
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "approve", "reject":
		pos, err := parse(newFlags("manage "+sub), rest)
		if err != nil {
			return err
		}
		if err := need(pos, 1, "member name"); err != nil {
			return err
		}
		return memberAction(c, pos[0], sub, nil)
	case "members":
		if _, err := parse(newFlags("manage members"), rest); err != nil {
			return err
		}
		e, err := loadHub()
		if err != nil {
			return err
		}
		ctx, cancel := cmdContext()
		defer cancel()
		ms, err := e.cl.ManageMembers(ctx)
		if err != nil {
			return err
		}
		c.emit(map[string]any{"members": ms}, func() {
			tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
			fmt.Fprintln(tw, "NAME\tID\tROLE\tSTATUS\tCLI\tLAST SEEN\tPAUSE")
			for _, m := range ms {
				ls := "-"
				if m.LastSeenAt != nil {
					ls = agoMS(*m.LastSeenAt)
				}
				pause := "-"
				if m.Paused {
					pause = firstOr(derefS(m.PauseReason), "paused")
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", m.Name, m.ID, m.Role, m.Status, dash(derefS(m.CLI)), ls, pause)
			}
			tw.Flush()
		})
		return nil
	case "workspace", "workspaces":
		return manageWorkspace(c, rest)
	}
	return &exitError{code: exitUsage, msg: "unknown manage subcommand " + sub}
}

func manageWorkspace(c *cli, args []string) error {
	if len(args) == 0 {
		args = []string{"list"}
	}
	sub, rest := args[0], args[1:]
	fs := newFlags("manage workspace " + sub)
	name := fs.String("name", "", "workspace name")
	goal := fs.String("goal", "", "one-line goal")
	repo := fs.String("repo", "", "GitHub owner/repo")
	branch := fs.String("branch", "", "default branch")
	brief := fs.String("brief", "", "brief (Markdown)")
	briefFile := fs.String("brief-file", "", "read the brief from a file (- = stdin)")
	status := fs.String("status", "", "active | archived (update only)")
	pos, err := parse(fs, rest)
	if err != nil {
		return err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	opt := func(flag string, v string) *string {
		if set[flag] {
			return &v
		}
		return nil
	}
	var req hub.WorkspaceReq
	if sub == "create" || sub == "update" {
		b, err := readBody(*brief, *briefFile)
		if err != nil {
			return err
		}
		req = hub.WorkspaceReq{Name: opt("name", *name), Goal: opt("goal", *goal), Repo: opt("repo", *repo),
			Branch: opt("branch", *branch), Status: opt("status", *status)}
		if set["brief"] || set["brief-file"] {
			req.Brief = &b
		}
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	switch sub {
	case "list", "ls":
		ws, err := e.cl.Workspaces(ctx)
		if err != nil {
			return err
		}
		c.emit(map[string]any{"workspaces": ws}, func() {
			tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tNAME\tSTATUS\tREPO\tOPEN\tGOAL")
			for _, w := range ws {
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\n", w.ID, w.Name, w.Status, dash(derefS(w.Repo)), w.ThreadCounts.Open, w.Goal)
			}
			tw.Flush()
		})
		return nil
	case "create":
		if *name == "" || *goal == "" {
			return &exitError{code: exitUsage, msg: i18n.Pick("manage workspace create needs --name and --goal", "manage workspace create 需要 --name 和 --goal")}
		}
		w, err := e.cl.CreateWorkspace(ctx, req)
		if err != nil {
			return err
		}
		c.emit(map[string]any{"workspace": w}, func() {
			fmt.Fprintf(c.out, i18n.Pick("created workspace %s (%s)\n", "已创建工作区 %s（%s）\n"), w.Name, w.ID)
		})
		return nil
	case "update":
		if err := need(pos, 1, "workspace id"); err != nil {
			return err
		}
		if len(set) == 0 {
			return &exitError{code: exitUsage, msg: i18n.Pick("nothing to update", "没有要更新的内容")}
		}
		w, err := e.cl.UpdateWorkspace(ctx, pos[0], req)
		if err != nil {
			return err
		}
		c.emit(map[string]any{"workspace": w}, func() {
			fmt.Fprintf(c.out, i18n.Pick("updated workspace %s (%s)\n", "已更新工作区 %s（%s）\n"), firstOr(w.Name, pos[0]), firstOr(w.ID, pos[0]))
		})
		return nil
	}
	return &exitError{code: exitUsage, msg: "manage workspace list|create|update"}
}
