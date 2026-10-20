package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/shiroha-document/agentbus/internal/bus"
)

func cmdTask(c *cli, args []string) error {
	if len(args) == 0 {
		return &exitError{code: exitUsage, msg: "task needs a subcommand: create|list|show|claim|progress|done|cancel|run"}
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "create":
		return taskCreate(c, rest)
	case "list", "ls":
		return taskList(c, rest)
	case "show":
		return taskShow(c, rest)
	case "claim":
		return taskClaim(c, rest)
	case "progress", "beat":
		return taskProgress(c, rest)
	case "done":
		return taskDone(c, rest)
	case "cancel":
		return taskCancel(c, rest)
	case "run":
		return taskRun(c, rest)
	}
	return &exitError{code: exitUsage, msg: "unknown task subcommand " + strconv.Quote(sub)}
}

func taskCreate(c *cli, args []string) error {
	fs := newFlags("task create")
	to := fs.String("to", "", "assignee: agent, #channel or *")
	subject := fs.String("subject", "", "")
	body := fs.String("body", "", "inline body")
	bodyFile := fs.String("body-file", "", "file with body ('-' = stdin)")
	requires := fs.String("requires", "", "comma-separated capabilities a claimer must have")
	template := fs.String("template", "", "structured handler key")
	params := fs.String("params", "", "template params (JSON)")
	deadline := fs.String("deadline", "6h", "duration from now or RFC3339")
	heartbeat := fs.String("heartbeat", "10m", "expected progress interval")
	maxAttempts := fs.Int("max-attempts", bus.DefaultMaxAttempts, "")
	var attach multi
	fs.Var(&attach, "attach", "attach file (repeatable)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	text, err := readBody(*body, *bodyFile)
	if err != nil {
		return err
	}
	spec := bus.TaskSpec{Requires: splitList(*requires), Template: *template, MaxAttempts: *maxAttempts}
	if *params != "" {
		if err := json.Unmarshal([]byte(*params), &spec.Params); err != nil {
			return &exitError{code: exitUsage, msg: "--params must be JSON: " + err.Error()}
		}
	}
	dl, err := parseWhen(*deadline, time.Now())
	if err != nil {
		return &exitError{code: exitUsage, msg: "bad --deadline: " + err.Error()}
	}
	spec.Deadline = dl.UTC().Format(time.RFC3339)
	hb, err := parseDur(*heartbeat)
	if err != nil {
		return &exitError{code: exitUsage, msg: "bad --heartbeat: " + err.Error()}
	}
	spec.HeartbeatSec = int(hb / time.Second)
	b, err := openSynced()
	if err != nil {
		return err
	}
	e, err := b.CreateTask(splitList(*to), *subject, text, spec, attach)
	if err != nil {
		return err
	}
	c.emit(e, func() {
		fmt.Fprintf(c.out, "task %s created for %s; candidates: %s\n", bus.ShortID(e.ID), strings.Join(e.To, ","), firstOr(strings.Join(b.Recipients(e), ","), "(none yet)"))
	})
	return nil
}

func taskList(c *cli, args []string) error {
	fs := newFlags("task list")
	mine := fs.Bool("mine", false, "tasks I issued")
	assigned := fs.Bool("assigned", false, "tasks addressed to me")
	claimable := fs.Bool("claimable", false, "tasks I can claim now")
	active := fs.Bool("active", false, "only open/running/stale")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	scope := ""
	switch {
	case *mine:
		scope = "mine"
	case *assigned:
		scope = "assigned"
	case *claimable:
		scope = "claimable"
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	vs, err := b.Tasks(scope)
	if err != nil {
		return err
	}
	if *active {
		var keep []*bus.TaskView
		for _, v := range vs {
			if v.State == bus.TaskOpen || v.State == bus.TaskRunning || v.State == bus.TaskStale {
				keep = append(keep, v)
			}
		}
		vs = keep
	}
	c.emit(vs, func() {
		if len(vs) == 0 {
			fmt.Fprintln(c.out, "no tasks")
			return
		}
		tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tSTATE\tFROM\tTO\tCLAIMER\tATTEMPT\tPROGRESS\tSUBJECT")
		for _, v := range vs {
			prog := "-"
			if v.Last != nil {
				prog = fmt.Sprintf("%s %d%%", v.Last.Phase, v.Last.Percent)
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%d/%d\t%s\t%s\n", bus.ShortID(v.Task.ID), v.State, v.Task.From,
				strings.Join(v.Task.To, ","), dash(v.Claimer), v.Attempt, v.MaxAttempts, prog, v.Task.Subject)
		}
		tw.Flush()
	})
	return nil
}

func taskShow(c *cli, args []string) error {
	pos, err := parse(newFlags("task show"), args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "task id"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	v, err := b.Task(pos[0])
	if err != nil {
		return err
	}
	c.emit(v, func() { printTask(c, v) })
	return nil
}

func printTask(c *cli, v *bus.TaskView) {
	printEvent(c, &v.Task)
	fmt.Fprintf(c.out, "\nstate:   %s", v.State)
	if v.Reason != "" {
		fmt.Fprintf(c.out, " (%s)", v.Reason)
	}
	fmt.Fprintf(c.out, "\nattempt: %d/%d  claimer: %s  last beat: %s  deadline: %s\n", v.Attempt, v.MaxAttempts, dash(v.Claimer),
		ago(v.LastBeat), v.Deadline.Local().Format(time.RFC3339))
	if v.Last != nil {
		fmt.Fprintf(c.out, "progress: %s %d%%\n", v.Last.Phase, v.Last.Percent)
		if v.Last.Tail != "" {
			for _, l := range strings.Split(v.Last.Tail, "\n") {
				fmt.Fprintf(c.out, "    │ %s\n", l)
			}
		}
	}
	if v.Result != nil {
		fmt.Fprintf(c.out, "result:  %s %s\n", v.Result.Progress.Status, v.Result.Reason)
		for _, a := range v.Result.Attach {
			fmt.Fprintf(c.out, "attach:  %s (%d bytes)  agentbus blob %s\n", a.Name, a.Size, a.SHA256[:12])
		}
		if v.Result.Body != "" {
			fmt.Fprintf(c.out, "\n%s\n", v.Result.Body)
		}
	}
	if v.Claimable {
		fmt.Fprintf(c.out, "\nclaim with: agentbus task claim %s\n", bus.ShortID(v.Task.ID))
	}
}

func taskClaim(c *cli, args []string) error {
	pos, err := parse(newFlags("task claim"), args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "task id"); err != nil {
		return err
	}
	b, err := open()
	if err != nil {
		return err
	}
	v, err := b.Claim(pos[0])
	if err != nil {
		return err
	}
	c.emit(v, func() {
		fmt.Fprintf(c.out, "claimed %s attempt %d; heartbeat at least every %ds (agentbus task progress %s --attempt %d --phase ...)\n",
			bus.ShortID(v.Task.ID), v.Attempt, v.Heartbeat, bus.ShortID(v.Task.ID), v.Attempt)
	})
	return nil
}

func taskProgress(c *cli, args []string) error {
	fs := newFlags("task progress")
	attempt := fs.Int("attempt", 0, "my attempt number (recommended: enables fencing)")
	phase := fs.String("phase", "running", "")
	percent := fs.Int("percent", 0, "")
	tailFile := fs.String("tail-file", "", "attach the last lines of this log")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "task id"); err != nil {
		return err
	}
	tail := ""
	if *tailFile != "" {
		tail = readTail(*tailFile, 16<<10)
	}
	b, err := open()
	if err != nil {
		return err
	}
	v, err := b.Progress(pos[0], *attempt, *phase, *percent, tail)
	if err != nil {
		return err
	}
	c.emit(v, func() {
		fmt.Fprintf(c.out, "%s attempt %d: %s %d%%\n", bus.ShortID(v.Task.ID), v.Attempt, *phase, *percent)
	})
	return nil
}

func taskDone(c *cli, args []string) error {
	fs := newFlags("task done")
	attempt := fs.Int("attempt", 0, "")
	status := fs.String("status", "", "succeeded|failed")
	body := fs.String("body", "", "")
	bodyFile := fs.String("body-file", "", "")
	reason := fs.String("reason", "", "")
	var attach multi
	fs.Var(&attach, "attach", "attach file (repeatable)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "task id"); err != nil {
		return err
	}
	if *status == "" {
		return &exitError{code: exitUsage, msg: "task done needs --status succeeded|failed"}
	}
	text, err := readBody(*body, *bodyFile)
	if err != nil {
		return err
	}
	b, err := open()
	if err != nil {
		return err
	}
	e, err := b.Complete(pos[0], *attempt, *status, text, *reason, attach)
	if err != nil {
		return err
	}
	c.emit(e, func() { fmt.Fprintf(c.out, "reported %s for %s\n", e.Progress.Status, bus.ShortID(e.Ref)) })
	return nil
}

func taskCancel(c *cli, args []string) error {
	fs := newFlags("task cancel")
	reason := fs.String("reason", "", "required")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "task id"); err != nil {
		return err
	}
	if *reason == "" {
		return &exitError{code: exitUsage, msg: "task cancel needs --reason"}
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	e, err := b.Cancel(pos[0], *reason)
	if err != nil {
		return err
	}
	c.emit(e, func() { fmt.Fprintf(c.out, "cancelled %s\n", bus.ShortID(e.Ref)) })
	return nil
}

// ---- task run: the batteries-included worker ----

var reProgress = regexp.MustCompile(`^::agentbus-progress\s+(\d{1,3})(?:\s+(.+))?$`)

// taskRun claims (optionally) and runs CMD, heartbeating with the log tail,
// stopping the command on cancel/fencing, and reporting the result.
//
// The command may print "::agentbus-progress 40 compiling" lines to report
// percent/phase.
func taskRun(c *cli, args []string) error {
	fs := newFlags("task run")
	claim := fs.Bool("claim", false, "claim first (else I must already hold the task)")
	attachLog := fs.Bool("attach-log", false, "attach the full log (last 5MB) to the result")
	beat := fs.String("beat", "", "heartbeat interval (default: task heartbeat / 2)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) < 2 {
		return &exitError{code: exitUsage, msg: "usage: task run ID [--claim] -- CMD ARGS..."}
	}
	id, argv := pos[0], pos[1:]
	b, err := openLong()
	if err != nil {
		return err
	}
	var v *bus.TaskView
	err = b.Locked(func() (err error) {
		if *claim {
			v, err = b.Claim(id)
			return err
		}
		if err := b.Sync(); err != nil {
			return err
		}
		if v, err = b.Task(id); err != nil {
			return err
		}
		if v.Claimer != b.Me() || v.Result != nil {
			return fmt.Errorf("%w (claimer=%s state=%s); use --claim", bus.ErrFenced, dash(v.Claimer), v.State)
		}
		return nil
	})
	if err != nil {
		return err
	}
	taskID, attempt := v.Task.ID, v.Attempt
	interval := time.Duration(v.Heartbeat) * time.Second / 2
	if *beat != "" {
		if interval, err = parseDur(*beat); err != nil {
			return err
		}
	}
	if interval < time.Second {
		interval = time.Second
	}
	logDir := filepath.Join(b.Home, "logs")
	_ = os.MkdirAll(logDir, 0o700)
	logPath := filepath.Join(logDir, fmt.Sprintf("%s-%d.log", bus.ShortID(taskID), attempt))
	logf, err := os.Create(logPath)
	if err != nil {
		return err
	}
	defer logf.Close()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = append(os.Environ(), "AGENTBUS_TASK="+taskID, "AGENTBUS_ATTEMPT="+strconv.Itoa(attempt))
	setProcessGroup(cmd)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw

	var mu sync.Mutex
	phase, percent := "running", 0
	scanDone := make(chan struct{})
	go func() {
		defer close(scanDone)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			fmt.Fprintln(logf, line)
			fmt.Fprintln(c.errw, line)
			if m := reProgress.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
				mu.Lock()
				percent, _ = strconv.Atoi(m[1])
				if m[2] != "" {
					phase = m[2]
				}
				mu.Unlock()
			}
		}
		_, _ = io.Copy(io.Discard, pr)
	}()
	if err := cmd.Start(); err != nil {
		pw.Close()
		<-scanDone
		cerr := b.Locked(func() error {
			_, err := b.Complete(taskID, attempt, bus.TaskFailed, "", "could not start command: "+err.Error(), nil)
			return err
		})
		return errors.Join(err, cerr)
	}
	exited := make(chan error, 1)
	go func() { err := cmd.Wait(); pw.Close(); exited <- err }()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sig)
	tick := time.NewTicker(interval)
	defer tick.Stop()

	progress := func(ph string, pc int, tail string) error {
		return b.Locked(func() error { _, err := b.Progress(taskID, attempt, ph, pc, tail); return err })
	}
	_ = progress("started", 0, "")
	var stopReason error
	var waitErr error
loop:
	for {
		select {
		case waitErr = <-exited:
			break loop
		case s := <-sig:
			stopReason = fmt.Errorf("worker received %v", s)
			killGroup(cmd)
		case <-tick.C:
			mu.Lock()
			ph, pc := phase, percent
			mu.Unlock()
			if err := progress(ph, pc, readTail(logPath, 4<<10)); err != nil {
				if errors.Is(err, bus.ErrFenced) || errors.Is(err, bus.ErrCancelled) {
					stopReason = err
					killGroup(cmd)
					continue
				}
				fmt.Fprintln(c.errw, "agentbus: heartbeat failed (will retry):", err)
			}
		}
	}
	<-scanDone
	logf.Sync()
	tail := readTail(logPath, 8<<10)
	if errors.Is(stopReason, bus.ErrFenced) {
		return stopReason // someone else owns it now: report nothing
	}
	status, reason := bus.TaskSucceeded, ""
	code := exitCodeOf(waitErr)
	if errors.Is(stopReason, bus.ErrCancelled) {
		status, reason = bus.TaskCancelled, "stopped on cancel"
	} else if stopReason != nil {
		status, reason = bus.TaskFailed, stopReason.Error()
	} else if waitErr != nil {
		status, reason = bus.TaskFailed, fmt.Sprintf("command exited %d", code)
	}
	body := fmt.Sprintf("`%s` exited %d after attempt %d.\n\n```\n%s\n```\n", strings.Join(argv, " "), code, attempt, tail)
	var attach []string
	if *attachLog {
		if p, err := trimmedCopy(logPath, bus.MaxBlob-1024); err == nil {
			attach = append(attach, p)
		}
	}
	var e *bus.Event
	err = b.Locked(func() (err error) { e, err = b.Complete(taskID, attempt, status, body, reason, attach); return err })
	if err != nil {
		return err
	}
	c.emit(e, func() { fmt.Fprintf(c.out, "task %s %s (exit %d)\n", bus.ShortID(taskID), e.Progress.Status, code) })
	switch {
	case e.Progress.Status == bus.TaskCancelled:
		return &exitError{code: exitCancel}
	case status == bus.TaskFailed:
		return &exitError{code: exitErr}
	}
	return nil
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

func readTail(path string, max int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, _ := f.Stat()
	if st != nil && st.Size() > max {
		_, _ = f.Seek(-max, io.SeekEnd)
	}
	data, _ := io.ReadAll(f)
	s := string(data)
	if st != nil && st.Size() > max {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
	}
	return strings.TrimRight(s, "\n")
}

func trimmedCopy(path string, max int64) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if st.Size() <= max {
		return path, nil
	}
	out := path + ".tail"
	return out, os.WriteFile(out, []byte(readTail(path, max)), 0o600)
}

// ---- wake ----

func kindMatcher(spec string) func(*bus.Event) bool {
	kinds := splitList(spec)
	if len(kinds) == 0 {
		return nil
	}
	return func(e *bus.Event) bool {
		for _, k := range kinds {
			if k == e.Kind || strings.HasSuffix(k, "*") && strings.HasPrefix(e.Kind, strings.TrimSuffix(k, "*")) {
				return true
			}
		}
		return false
	}
}

func cmdWait(c *cli, args []string) error {
	fs := newFlags("wait")
	timeout := fs.String("timeout", "14m", "give up after (exit 3)")
	interval := fs.String("interval", "20s", "poll interval")
	kind := fs.String("kind", "", "only these kinds (msg,task.*,receipt)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	to, err := parseDur(*timeout)
	if err != nil {
		return err
	}
	iv, err := parseDur(*interval)
	if err != nil {
		return err
	}
	b, err := openLong()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	evs, err := b.Wait(ctx, to, iv, kindMatcher(*kind))
	if err != nil {
		return err
	}
	if len(evs) == 0 {
		if c.json {
			c.emit([]bus.Event{}, func() {})
		} else {
			fmt.Fprintln(c.errw, "nothing new")
		}
		return &exitError{code: exitNothing}
	}
	c.emit(evs, func() {
		printTimeline(c, evs, true)
		fmt.Fprintln(c.out, "\nnext: agentbus read ID | agentbus ack ID | agentbus task show ID")
	})
	return nil
}

func cmdWatch(c *cli, args []string) error {
	fs := newFlags("watch")
	interval := fs.String("interval", "60s", "")
	execCmd := fs.String("exec", "", "shell command run per event (gets AGENTBUS_EVENT json, AGENTBUS_EVENT_ID, AGENTBUS_EVENT_KIND)")
	kind := fs.String("kind", "", "only these kinds")
	once := fs.Bool("once", false, "single pass (for cron)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	iv, err := parseDur(*interval)
	if err != nil {
		return err
	}
	b, err := openLong()
	if err != nil {
		return err
	}
	match := kindMatcher(*kind)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	for {
		var evs []bus.Event
		var serr, terr error
		_ = b.Locked(func() error {
			if serr = b.Sync(); serr == nil {
				evs, terr = b.TakeNew()
			}
			return nil
		})
		if serr != nil {
			fmt.Fprintln(c.errw, "agentbus: sync failed (retrying):", serr)
		} else if terr != nil {
			return terr
		} else {
			for i := range evs {
				e := &evs[i]
				if match != nil && !match(e) {
					continue
				}
				if *execCmd == "" {
					c.emit(e, func() { printTimeline(c, []bus.Event{*e}, true) })
					continue
				}
				js, _ := json.Marshal(e)
				sh := exec.CommandContext(ctx, "sh", "-c", *execCmd)
				sh.Env = append(os.Environ(), "AGENTBUS_EVENT="+string(js), "AGENTBUS_EVENT_ID="+e.ID, "AGENTBUS_EVENT_KIND="+e.Kind, "AGENTBUS_FROM="+e.From)
				sh.Stdout, sh.Stderr = c.out, c.errw
				if err := sh.Run(); err != nil {
					fmt.Fprintf(c.errw, "agentbus: handler failed for %s: %v\n", bus.ShortID(e.ID), err)
				}
			}
		}
		if *once {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(iv):
		}
	}
}
