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

	"github.com/shiroha-document/agentbus/internal/bus"
)

// Exit codes are part of the agent-facing contract (see docs/AGENTS.md).
const (
	exitOK       = 0
	exitErr      = 1
	exitUsage    = 2
	exitNothing  = 3 // wait timed out / inbox empty with --fail-empty
	exitFenced   = 4 // task re-claimed by someone else: stop working
	exitCancel   = 5 // task cancelled by issuer: stop working
	exitClaimLst = 6 // lost a claim race
)

type cli struct {
	out  io.Writer
	errw io.Writer
	json bool
}

func main() {
	c := &cli{out: os.Stdout, errw: os.Stderr}
	os.Exit(c.run(os.Args[1:]))
}

func (c *cli) run(args []string) int {
	argv := args
	// global flags may precede the command
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case "--json":
			c.json = true
		case "--home":
			if len(args) < 2 {
				return c.usage()
			}
			os.Setenv("AGENTBUS_HOME", args[1])
			args = args[1:]
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
	err := h(c, rest)
	processUnlock()
	code := exitOK
	if err != nil {
		code = c.fail(err)
	}
	return code
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
	case errors.Is(err, bus.ErrFenced):
		code = exitFenced
	case errors.Is(err, bus.ErrCancelled):
		code = exitCancel
	case errors.Is(err, bus.ErrClaimLost):
		code = exitClaimLst
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
	fmt.Fprint(c.errw, `agentbus — git-backed mailbox + long tasks for cooperating agents

usage: agentbus [--json] [--home DIR] <command> [flags]

setup      init --remote URL --me NAME [--role R] [--cap docker,arm64] [--channel ci] [--wake daemon|poll|wait|manual]
           whoami | agents | sync
mail       send --to A[,#chan,*] [--subject S] (--body TEXT | --body-file F | --body-file -) [--attach F]... [--reply ID] [--expect-ack 30m]
           inbox [--unread] [--all] | read ID | ack ID [--reject --reason R] | status ID | thread ID | overdue [--all]
join       join --repo OWNER/REPO --me NAME [--cap ..] [--owner GH_LOGIN] [--wait 14m]   (self-service: human approves once)
           members | admin approve (--issue URL | --request F) | admin revoke NAME | admin handle-issue
tasks      task create --to A|#chan [--subject S] [--body-file F] [--requires docker] [--template T --params JSON]
                       [--deadline 6h|RFC3339] [--heartbeat 10m] [--max-attempts 2]
           task list [--mine|--assigned|--claimable] | task show ID | task claim ID
           task progress ID [--attempt N] --phase P [--percent N] [--tail-file F]
           task done ID [--attempt N] --status succeeded|failed [--body-file F] [--reason R] [--attach F]...
           task cancel ID --reason R
           task run ID [--claim] [--attach-log] -- CMD ARGS...   (claim + heartbeat + stop on cancel + report)
wake       wait [--timeout 14m] [--interval 20s] [--kind msg,task.*]   (exit 3 on timeout)
           watch [--interval 60s] [--exec 'CMD']                        (long-running poller; CMD gets AGENTBUS_EVENT)
history    history [--agent A] [--kind K|prefix*] [--since 7d] [--limit N] | search QUERY
           brief ID | blob HASH [-o FILE]
update     self-update [--check] [--force] [--version vX.Y.Z] | --version
           (every command first installs a newer release and re-runs on it; checks cached 5m.
            AGENTBUS_AUTO_UPDATE=auto|notify|off, AGENTBUS_UPDATE_EVERY=5m)
ci         digest [--since 1h | --range A..B] [--level all|important|alerts] [--remote URL]   (markdown for humans; exit 3 if empty)
           board [--tz Asia/Shanghai] [--recent 7d] [--max-rows 30] [--remote URL]          (dashboard markdown; pinned issue)

exit codes: 0 ok, 1 error, 2 usage, 3 nothing new, 4 fenced (stop), 5 cancelled (stop), 6 claim lost
`)
	return exitUsage
}

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

type flagSet = flag.FlagSet

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

// parse supports positional args mixed with flags: `read ID --json`.
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

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
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

// processUnlock releases the home lock held by short-lived commands.
var processUnlock = func() {}

// open opens the home and holds its lock for the rest of the process, so
// concurrent CLI invocations on one home never interleave git operations.
func open() (*bus.Bus, error) {
	b, err := bus.Open(bus.Home())
	if err != nil {
		return nil, err
	}
	u, err := b.Lock()
	if err != nil {
		return nil, err
	}
	processUnlock = u
	return b, nil
}

// openLong opens the home for long-running loops (wait/watch/task run): the
// lock is taken per operation so other processes, including our own child,
// can use the same home in between.
func openLong() (*bus.Bus, error) {
	b, err := bus.Open(bus.Home())
	if err != nil {
		return nil, err
	}
	b.PerOpLock = true
	return b, nil
}

func openSynced() (*bus.Bus, error) {
	b, err := open()
	if err != nil {
		return nil, err
	}
	if err := b.Sync(); err != nil {
		fmt.Fprintln(os.Stderr, "agentbus: warning: sync failed, showing local view:", err)
	}
	return b, nil
}

func need(pos []string, n int, what string) error {
	if len(pos) < n {
		return &exitError{code: exitUsage, msg: "missing " + what}
	}
	return nil
}
