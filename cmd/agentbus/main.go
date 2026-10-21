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
		fmt.Fprintf(c.errw, "unknown command %q\n", cmd)
		return c.usage()
	}
	if done, code := c.autoUpdate(cmd, argv); done {
		return code
	}
	if err := h(c, rest); err != nil {
		return c.fail(err)
	}
	return exitOK
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
		fmt.Fprintln(c.errw, "agentbus:", err)
	}
	return code
}

func (c *cli) usage() int {
	fmt.Fprint(c.errw, usageText)
	return exitUsage
}

// usageText is printed by `agentbus help`, -h and on usage errors.
const usageText = `agentbus — hub client for cooperating coding agents

usage: agentbus [--json] [--hub-home DIR] [--hub URL] <command> [flags]

Setup & identity
  setup [URL] [--join-code CODE] [--name N] [--cli C] [--tier readonly|workspace|full]
        [--repo OWNER/REPO=PATH]... [--interval 5m] [--quota-source S] [--yes]
        [--no-schedule] [--method M] [--no-doctor]
                     guided setup: pick CLI, join, tier, repos, scheduler, quota, doctor
  join URL --join-code CODE --name N [--cli claude|codex|cursor|gemini|custom]
        [--binary PATH] [--template CMD] [--wake-interval 5m] [--wake poll|trigger]
        [--trigger-url U] [--owner O] [--machine M] [--display-name D]
                     register this machine as an agent in a hub team
  whoami | state     member, team, role, pause state and versions
  status [--no-quota] last tick, scheduler and quota at a glance
  doctor             check config, key, CLI, repos, scheduler, clock, hub access

  A join code (abj_...) is created by a team admin in hub Settings → Agent 加入码
  (or Members → 添加 agent, which also gives a ready-to-paste one-line install).
  Pass it with --join-code or $AGENTBUS_JOIN_CODE, the hub URL with --hub or
  $AGENTBUS_HUB; both are only needed for the first join.

Daily loop
  tick [--max-threads N] [--timeout 20m] [--dry-run] [--quiet]
                     claim messages, run the coding CLI on each thread, ack
  post [--thread T] (--body B | --body-file F | -) [--kind msg|progress|confirm]
       [--reply P] [--key K]
  post --workspace W --title X [--assignee NAME] (--body B | --body-file F | -)
                     reply in a thread, or open a new one
  confirm [--thread T] "question"   ask a human to approve (shows on the hub dashboard)
  ack [--thread T] [DELIVERY_ID...] mark messages handled and release the thread

Threads
  thread show [T] [--before P] [--limit N]
  thread state [T] (--body B | --body-file F | -)   replace the pinned state
  thread assign [T] NAME
  thread close [T] [--done]
  thread list [--workspace W] [--mine] [--status open|done|closed]
  T defaults to $AGENTBUS_THREAD; post keys default to $AGENTBUS_ROUND + body hash.

Quota
  quota [--source auto|native|magpie|both] [--report]   read local CLI quota
  usage [--days 7]                                      token and cost summary
  usage baseline [--runs 2] [--timeout 5m]              measure wake-up cost

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
  --version | help
  Every command first installs a newer release and re-runs on it (checked every 5m):
  AGENTBUS_AUTO_UPDATE=auto|notify|off, AGENTBUS_UPDATE_EVERY=5m.

Config lives in $AGENTBUS_HUB_HOME (default <user config dir>/agentbus).
Exit codes: 0 ok, 1 error, 2 usage, 3 nothing to do;
            tick also 4 paused / pending approval, 5 quota exhausted.
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
		return &exitError{code: exitUsage, msg: "missing " + what}
	}
	return nil
}

// ---- small helpers ----

func ago(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := time.Since(t).Round(time.Second)
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
