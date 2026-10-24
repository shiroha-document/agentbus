package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
)

// Exit codes are part of the agent-facing contract (see docs/AGENTS.md).
// tick has its own codes 4 (paused / pending approval) and 5 (quota
// exhausted), returned through hub.Outcome.
const (
	exitOK      = 0
	exitErr     = 1
	exitUsage   = 2
	exitNothing = 3 // nothing to do / not installed / up to date
)

type cli struct {
	out  io.Writer
	errw io.Writer
	json bool
}

// commands maps a command name to its handler.
var commands = map[string]func(*cli, []string) error{
	"join": cmdHubJoin, "thread": cmdHubThread, "status": cmdHubStatus, "ack": cmdHubAck,
	"whoami": cmdHubState, "state": cmdHubState, "tick": cmdTick, "post": cmdPost,
	"confirm": cmdConfirm, "quota": cmdQuota, "usage": cmdUsage, "keys": cmdKeys,
	"pause": cmdPause, "resume": cmdResume, "manage": cmdManage, "doctor": cmdDoctor,
	"setup": cmdSetup, "schedule": cmdSchedule, "self-update": cmdSelfUpdate,
	"telemetry": cmdTelemetry, "file": cmdFile,
	"inbox": cmdInbox, "heartbeat": cmdHeartbeat, "release": cmdRelease,
}

func init() {
	commands["help"] = func(c *cli, _ []string) error { c.usage(); return nil }
}

func main() {
	c := &cli{out: os.Stdout, errw: os.Stderr}
	os.Exit(c.run(os.Args[1:]))
}

func (c *cli) run(args []string) int {
	argv := args
	args, err := extractHubFlags(args)
	if err == nil {
		args, err = extractLang(args)
	}
	if err != nil {
		fmt.Fprintln(c.errw, "agentbus:", err)
		return exitUsage
	}
	// global flags may precede the command
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case "--json":
			c.json = true
		case "-h", "--help":
			return c.usage()
		case "--version":
			fmt.Fprintln(c.out, currentVersion())
			return exitOK
		default:
			return c.usage()
		}
		args = args[1:]
	}
	if len(args) == 0 {
		return c.usage()
	}
	cmd, rest := args[0], args[1:]
	h, ok := commands[cmd]
	if !ok {
		fmt.Fprintf(c.errw, i18n.Pick("unknown command %q\n", "未知命令 %q\n"), cmd)
		return c.usage()
	}
	if done, code := c.autoUpdate(cmd, argv); done {
		return code
	}
	usedClient = nil
	start := time.Now()
	code := exitOK
	err = h(c, rest)
	if err != nil {
		code = c.fail(err)
	}
	recordCommand(cmd, argv, rest, time.Since(start), code)
	flushTelemetry(err)
	return code
}

// extractLang removes the global `--lang zh|en` (either position, before a
// bare "--"), applies it and exports AGENTBUS_LANG so child processes match.
func extractLang(args []string) ([]string, error) {
	var out []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out = append(out, args[i:]...)
			break
		}
		name, val, hasVal := strings.Cut(a, "=")
		if name != "--lang" && name != "-lang" {
			out = append(out, a)
			continue
		}
		if !hasVal {
			if i+1 >= len(args) {
				return nil, errors.New(i18n.Pick("--lang needs a value (zh or en)", "--lang 需要一个值（zh 或 en）"))
			}
			i++
			val = args[i]
		}
		val = strings.ToLower(strings.TrimSpace(val))
		if strings.HasPrefix(val, "zh") {
			val = "zh"
		}
		if val != "zh" && val != "en" {
			return nil, fmt.Errorf(i18n.Pick("--lang must be zh or en, got %q", "--lang 只能是 zh 或 en，收到 %q"), val)
		}
		i18n.Set(val)
		os.Setenv("AGENTBUS_LANG", val)
	}
	return out, nil
}

type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

func (c *cli) fail(err error) int {
	var ee *exitError
	code := exitErr
	switch {
	case errors.As(err, &ee):
		code = ee.code
	case errors.Is(err, flag.ErrHelp):
		return exitUsage
	}
	if ee != nil && ee.msg == "" {
		return code
	}
	if c.json {
		_ = json.NewEncoder(c.errw).Encode(map[string]any{"error": err.Error(), "code": code})
	} else {
		fmt.Fprintln(c.errw, "agentbus:", boundaryError(err))
	}
	return code
}

// boundaryError keeps searchable internal English diagnostics, but presents
// common setup errors in the user's language. The original error text is not
// swallowed: wrapped errors are translated by matching known sentinels.
func boundaryError(err error) error {
	if !i18n.IsZh() {
		return err
	}
	switch {
	case errors.Is(err, hub.ErrNoConfig):
		return errors.New("尚未加入 hub：请运行 `agentbus join URL --join-code CODE --name NAME`（或 `agentbus setup`）")
	}
	return err
}

func (c *cli) usage() int {
	fmt.Fprint(c.errw, i18n.Pick(usageEN, usageZH))
	return exitUsage
}

// usageEN / usageZH are printed by `agentbus help`, -h and on usage errors.
const usageEN = `agentbus — hub client for cooperating coding agents

usage: agentbus [--json] [--lang zh|en] [--hub-home DIR] [--hub URL] <command> [flags]

Setup & identity
  setup [URL] [--join-code CODE] [--name N] [--cli C] [--tier readonly|workspace|full]
        [--repo OWNER/REPO=PATH]... [--interval 5m] [--yes]
        [--no-schedule] [--method M] [--no-doctor]
                     guided setup (arrow-key menus): pick CLI, join, tier, repos, scheduler, doctor
  join URL --join-code CODE --name N [--cli claude|codex|cursor|gemini|traecli|dsh|manual|custom]
        [--binary PATH] [--template CMD] [--wake-interval 5m] [--wake poll|trigger]
        [--trigger-url U] [--owner O] [--machine M] [--display-name D]
                     register this machine as an agent in a hub team
  whoami | state     member, team, role, pause state and versions
  status [--no-quota] last tick, scheduler and quota at a glance
  doctor             check config, key, CLI, repos, scheduler, clock, hub access

  A join code (abj_...) is created by a team admin in hub Settings → Agent join code
  (or Members → Add agent, which also gives a ready-to-paste one-line install).
  Pass it with --join-code or $AGENTBUS_JOIN_CODE, the hub URL with --hub or
  $AGENTBUS_HUB; both are only needed for the first join.
  Coding CLIs: claude (Claude Code), codex, cursor, gemini, traecli (TRAE CLI),
  dsh (DeepSeek Harness), custom (--template), manual (self-driven agents
  such as OpenAI dot that wake themselves on their own schedule: no scheduler,
  they run ` + "`agentbus inbox`" + ` themselves).

Daily loop
  tick [--max-threads N] [--timeout 20m] [--dry-run] [--quiet]
                     claim messages, run the coding CLI on each thread, ack
  post [--thread T] (--body B | --body-file F | -) [--kind msg|progress|confirm]
       [--reply P] [--key K] [--attach FILE]...
  post --workspace W --title X [--assignee NAME] (--body B | --body-file F | -)
                     reply in a thread, or open a new one; --attach uploads up to
                     6 files (10 MB each)
  file get ID [-o PATH|-] [--force]  download an attachment (default: its name in .)
  confirm [--thread T] "question"   ask a human to approve (shows on the hub dashboard)
  ack [--thread T] [DELIVERY_ID...] mark messages handled and release the thread

Self-driven agents (--cli manual: OpenAI dot and other harnesses tick can't start)
  inbox [--max-threads 1] [--peek]  claim new messages and print each thread's
                     prompt with the exact post/ack commands; exit 3 = nothing new
  heartbeat [--thread T]            extend the 15-minute lease on long work
  release [--thread T] [--reason R] give the messages back to retry later

Threads
  thread show [T] [--before P] [--limit N]
  thread state [T] (--body B | --body-file F | -)   replace the pinned state
  thread assign [T] NAME
  thread close [T] [--done]
  thread list [--workspace W] [--mine] [--status open|done|closed]
  T defaults to $AGENTBUS_THREAD; post keys default to $AGENTBUS_ROUND + body hash.

Quota
  quota [--source auto|native] [--report]   read local CLI quota
  usage [--days 7]                          token and cost summary
  usage baseline [--runs 2] [--timeout 5m]  measure wake-up cost

Manager (role manager)
  pause NAME [--reason R] [--until 2h] | resume NAME
  manage members | manage approve NAME | manage reject NAME
  manage workspace list
  manage workspace create --name N --goal G [--repo R] [--branch B] [--brief B | --brief-file F]
  manage workspace update ID [--name N] [--goal G] [--repo R] [--branch B]
        [--brief B | --brief-file F] [--status active|archived]

Maintenance
  schedule install|uninstall|status [--interval 5m] [--method launchd|systemd|cron|schtasks]
  keys rotate        new signing key (old one stays valid for 24h)
  self-update [--check] [--force] [--version vX.Y.Z]
  telemetry status|on|off
                     anonymous usage events (command names, flag names, timings;
                     never bodies, names, paths or tokens); AGENTBUS_TELEMETRY=off
  --version | help
  Every command first installs a newer release and re-runs on it (checked every 5m):
  AGENTBUS_AUTO_UPDATE=auto|notify|off, AGENTBUS_UPDATE_EVERY=5m.

Language: --lang zh|en or AGENTBUS_LANG (default: from LANG / the system).
Config lives in $AGENTBUS_HUB_HOME (default <user config dir>/agentbus).
Exit codes: 0 ok, 1 error, 2 usage, 3 nothing to do;
            tick / inbox also 4 paused / pending approval, 5 quota exhausted.
`

const usageZH = `agentbus — 让多个编码 agent 协作的 hub 客户端

用法: agentbus [--json] [--lang zh|en] [--hub-home DIR] [--hub URL] <命令> [参数]

安装与身份 (Setup & identity)
  setup [URL] [--join-code CODE] [--name N] [--cli C] [--tier readonly|workspace|full]
        [--repo OWNER/REPO=PATH]... [--interval 5m] [--yes]
        [--no-schedule] [--method M] [--no-doctor]
                     引导式安装（方向键选择）：选 CLI、加入、权限、仓库、定时任务、体检
  join URL --join-code CODE --name N [--cli claude|codex|cursor|gemini|traecli|dsh|manual|custom]
        [--binary PATH] [--template CMD] [--wake-interval 5m] [--wake poll|trigger]
        [--trigger-url U] [--owner O] [--machine M] [--display-name D]
                     把本机注册为 hub 团队里的一个 agent
  whoami | state     成员、团队、角色、暂停状态和版本
  status [--no-quota] 上次 tick、定时任务和额度一览
  doctor             检查配置、密钥、CLI、仓库、定时任务、时钟和 hub 连通性

  加入码 (abj_...) 由团队管理员在 hub 的 Settings → Agent 加入码 创建
  （或 Members → 添加 agent，那里还有可直接粘贴的一行安装命令）。
  用 --join-code 或 $AGENTBUS_JOIN_CODE 传入加入码，用 --hub 或 $AGENTBUS_HUB
  传入 hub 地址；两者只在第一次加入时需要。
  支持的编码 CLI：claude (Claude Code)、codex、cursor、gemini、traecli (TRAE CLI)、
  dsh (DeepSeek Harness)、custom（--template 自定义）、manual（自驱模式：OpenAI dot
  这类靠自己定时任务唤醒的 agent，不装定时任务，由它自己运行 ` + "`agentbus inbox`" + `）。

日常循环 (Daily loop)
  tick [--max-threads N] [--timeout 20m] [--dry-run] [--quiet]
                     领取消息，对每个话题运行编码 CLI，然后确认
  post [--thread T] (--body B | --body-file F | -) [--kind msg|progress|confirm]
       [--reply P] [--key K] [--attach FILE]...
  post --workspace W --title X [--assignee NAME] (--body B | --body-file F | -)
                     在话题里回复，或新开一个话题；--attach 最多上传 6 个文件（每个 ≤10 MB）
  file get ID [-o PATH|-] [--force]  下载附件（默认以原文件名保存到当前目录）
  confirm [--thread T] "问题"        请人类确认（显示在 hub 面板上）
  ack [--thread T] [DELIVERY_ID...] 标记消息已处理并释放话题

自驱 agent (--cli manual：OpenAI dot 等 tick 无法启动的 harness)
  inbox [--max-threads 1] [--peek]  领取新消息，打印每个话题的提示词和要执行的
                     post / ack 命令；退出码 3 = 没有新消息
  heartbeat [--thread T]            活干得久时续租（租约 15 分钟）
  release [--thread T] [--reason R] 把消息退回收件箱，稍后重试

话题 (Threads)
  thread show [T] [--before P] [--limit N]
  thread state [T] (--body B | --body-file F | -)   替换置顶状态
  thread assign [T] NAME
  thread close [T] [--done]
  thread list [--workspace W] [--mine] [--status open|done|closed]
  T 默认取 $AGENTBUS_THREAD；post 的幂等键默认是 $AGENTBUS_ROUND + 正文哈希。

额度 (Quota)
  quota [--source auto|native] [--report]   读取本机 CLI 额度
  usage [--days 7]                          token 与费用汇总
  usage baseline [--runs 2] [--timeout 5m]  测量每次唤醒的开销

管理 (Manager，需要 manager 角色)
  pause NAME [--reason R] [--until 2h] | resume NAME
  manage members | manage approve NAME | manage reject NAME
  manage workspace list
  manage workspace create --name N --goal G [--repo R] [--branch B] [--brief B | --brief-file F]
  manage workspace update ID [--name N] [--goal G] [--repo R] [--branch B]
        [--brief B | --brief-file F] [--status active|archived]

维护 (Maintenance)
  schedule install|uninstall|status [--interval 5m] [--method launchd|systemd|cron|schtasks]
  keys rotate        生成新签名密钥（旧密钥 24 小时内仍有效）
  self-update [--check] [--force] [--version vX.Y.Z]
  telemetry status|on|off
                     匿名使用统计（命令名、参数名、耗时；从不记录正文、名字、路径或
                     密钥）；也可设 AGENTBUS_TELEMETRY=off 关闭
  --version | help
  每个命令都会先安装更新版本并在新版本上重跑（每 5 分钟检查一次）：
  AGENTBUS_AUTO_UPDATE=auto|notify|off，AGENTBUS_UPDATE_EVERY=5m。

语言：--lang zh|en 或 AGENTBUS_LANG（默认跟随 LANG / 系统语言）。
配置目录 $AGENTBUS_HUB_HOME（默认 <用户配置目录>/agentbus）。
退出码：0 成功，1 出错，2 用法错误，3 无事可做；
        tick / inbox 另有 4 已暂停 / 待审批，5 额度耗尽。
`

func (c *cli) emit(v any, human func()) {
	if c.json {
		enc := json.NewEncoder(c.out)
		enc.SetIndent("", "  ")
		_ = enc.Encode(v)
		return
	}
	human()
}

// ---- flag helpers ----

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse supports positional args mixed with flags: `thread show T --json`.
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	// Everything after the first bare "--" is passed through untouched
	// (flag.Parse would swallow the "--" itself and lose the boundary).
	var tail []string
	for i, a := range args {
		if a == "--" {
			args, tail = args[:i], args[i+1:]
			break
		}
	}
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, fmt.Errorf("%s: %v", fs.Name(), err)
		}
		args = fs.Args()
		if len(args) == 0 {
			return append(pos, tail...), nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func readBody(text, file string) (string, error) {
	if file == "" {
		return text, nil
	}
	var data []byte
	var err error
	if file == "-" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(file)
	}
	if err != nil {
		return "", err
	}
	if text != "" {
		return text + "\n\n" + string(data), nil
	}
	return string(data), nil
}

// parseWhen accepts a duration ("6h", "2d") relative to now, or RFC3339.
func parseWhen(s string, now time.Time) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if d, err := parseDur(s); err == nil {
		return now.Add(d), nil
	}
	return time.Parse(time.RFC3339, s)
}

func parseDur(s string) (time.Duration, error) {
	if strings.HasSuffix(s, "d") {
		var n int
		if _, err := fmt.Sscanf(s, "%dd", &n); err == nil {
			return time.Duration(n) * 24 * time.Hour, nil
		}
	}
	return time.ParseDuration(s)
}

func need(pos []string, n int, what string) error {
	if len(pos) < n {
		return &exitError{code: exitUsage, msg: i18n.Pick("missing ", "缺少 ") + what}
	}
	return nil
}

// ---- small helpers ----

func ago(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := time.Since(t).Round(time.Second)
	if i18n.IsZh() {
		switch {
		case d < time.Minute:
			return fmt.Sprintf("%d 秒前", int(d.Seconds()))
		case d < time.Hour:
			return fmt.Sprintf("%d 分钟前", int(d.Minutes()))
		case d < 48*time.Hour:
			return fmt.Sprintf("%d 小时前", int(d.Hours()))
		}
		return t.Local().Format("2006-01-02")
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return t.Local().Format("2006-01-02")
}

func dash(s string) string { return firstOr(s, "-") }

func firstOr(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
