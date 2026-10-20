package main

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/shiroha-document/agentbus/internal/bus"
)

var commands map[string]func(*cli, []string) error

func init() {
	commands = map[string]func(*cli, []string) error{
		"init": cmdInit, "whoami": cmdWhoami, "agents": cmdAgents, "sync": cmdSync,
		"send": cmdSend, "inbox": cmdInbox, "read": cmdRead, "ack": cmdAck,
		"status": cmdStatus, "thread": cmdThread, "overdue": cmdOverdue,
		"task": cmdTask, "wait": cmdWait, "watch": cmdWatch,
		"history": cmdHistory, "search": cmdSearch, "brief": cmdBrief, "blob": cmdBlob,
		"digest": cmdDigest, "join": cmdJoin, "admin": cmdAdmin,
		"self-update": cmdSelfUpdate,
		"help":        func(c *cli, _ []string) error { c.usage(); return nil },
	}
}

func cmdInit(c *cli, args []string) error {
	fs := newFlags("init")
	remote := fs.String("remote", "", "git remote URL of the bus repo")
	branch := fs.String("branch", "agent-bus", "bus branch")
	me := fs.String("me", "", "agent name")
	role := fs.String("role", "", "free-text role")
	caps := fs.String("cap", "", "comma-separated capabilities")
	chans := fs.String("channel", "", "comma-separated channels to join (without #)")
	wake := fs.String("wake", "poll", "how this agent wakes up: daemon|poll|wait|manual")
	owner := fs.String("owner", "", "human owner (e.g. GitHub login) for notifications")
	desc := fs.String("desc", "", "description")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *remote == "" || *me == "" {
		return &exitError{code: exitUsage, msg: "init needs --remote and --me"}
	}
	p := bus.Profile{Name: *me, Role: *role, Capabilities: splitList(*caps), Channels: splitList(*chans),
		Wake: *wake, Owner: *owner, Description: *desc}
	b, err := bus.Init(bus.Home(), *remote, *branch, p, "")
	if err != nil {
		return err
	}
	c.emit(map[string]any{"me": b.Me(), "home": b.Home, "branch": b.Cfg.Branch}, func() {
		fmt.Fprintf(c.out, "joined %s (branch %s) as %s; home %s\n", *remote, b.Cfg.Branch, b.Me(), b.Home)
	})
	return nil
}

func cmdWhoami(c *cli, _ []string) error {
	b, err := open()
	if err != nil {
		return err
	}
	ps, _ := b.Profiles()
	p := ps[b.Me()]
	c.emit(map[string]any{"me": b.Me(), "remote": b.Cfg.Remote, "branch": b.Cfg.Branch, "home": b.Home, "profile": p}, func() {
		fmt.Fprintf(c.out, "%s @ %s#%s (home %s)\n", b.Me(), b.Cfg.Remote, b.Cfg.Branch, b.Home)
	})
	return nil
}

func cmdAgents(c *cli, _ []string) error {
	b, err := openSynced()
	if err != nil {
		return err
	}
	ps, _ := b.Profiles()
	evs, _ := b.Events()
	last := map[string]time.Time{}
	for _, e := range evs {
		if e.TS.After(last[e.From]) {
			last[e.From] = e.TS
		}
	}
	names := make([]string, 0, len(ps))
	for n := range ps {
		names = append(names, n)
	}
	sort.Strings(names)
	type row struct {
		*bus.Profile
		LastSeen time.Time `json:"last_seen"`
	}
	var rows []row
	for _, n := range names {
		rows = append(rows, row{ps[n], last[n]})
	}
	c.emit(rows, func() {
		tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "AGENT\tROLE\tCAPS\tCHANNELS\tWAKE\tLAST SEEN")
		for _, r := range rows {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", r.Name, r.Role, strings.Join(r.Capabilities, ","),
				strings.Join(r.Channels, ","), r.Wake, ago(r.LastSeen))
		}
		tw.Flush()
	})
	return nil
}

func cmdSync(c *cli, _ []string) error {
	b, err := open()
	if err != nil {
		return err
	}
	if err := b.Sync(); err != nil {
		return err
	}
	items, err := b.Inbox(true, false)
	if err != nil {
		return err
	}
	c.emit(map[string]any{"unread": len(items)}, func() { fmt.Fprintf(c.out, "synced; %d unread\n", len(items)) })
	return nil
}

func cmdSend(c *cli, args []string) error {
	fs := newFlags("send")
	to := fs.String("to", "", "recipients: agent, #channel, * (comma-separated)")
	subject := fs.String("subject", "", "")
	body := fs.String("body", "", "inline body")
	bodyFile := fs.String("body-file", "", "file with body ('-' = stdin)")
	reply := fs.String("reply", "", "reply to message id")
	expect := fs.String("expect-ack", "", "require accept/reject within duration, e.g. 30m")
	var attach multi
	fs.Var(&attach, "attach", "attach file (repeatable)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	text, err := readBody(*body, *bodyFile)
	if err != nil {
		return err
	}
	var d time.Duration
	if *expect != "" {
		if d, err = parseDur(*expect); err != nil {
			return err
		}
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	e, err := b.Send(splitList(*to), *subject, text, attach, *reply, d)
	if err != nil {
		return err
	}
	c.emit(e, func() {
		fmt.Fprintf(c.out, "sent %s to %s; recipients: %s\n", bus.ShortID(e.ID), strings.Join(e.To, ","), strings.Join(b.Recipients(e), ","))
	})
	return nil
}

func cmdInbox(c *cli, args []string) error {
	fs := newFlags("inbox")
	all := fs.Bool("all", false, "include already-read items")
	unread := fs.Bool("unread", true, "only unread (default)")
	failEmpty := fs.Bool("fail-empty", false, "exit 3 when empty")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	items, err := b.Inbox(*unread && !*all, true)
	if err != nil {
		return err
	}
	c.emit(items, func() {
		if len(items) == 0 {
			fmt.Fprintln(c.out, "inbox empty")
			return
		}
		tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tWHEN\tFROM\tKIND\tSUMMARY\tMY RECEIPT")
		for _, it := range items {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", bus.ShortID(it.Event.ID), ago(it.Event.TS), it.Event.From,
				it.Event.Kind, bus.Describe(&it.Event), dash(it.Level))
		}
		tw.Flush()
	})
	if len(items) == 0 && *failEmpty {
		return &exitError{code: exitNothing}
	}
	return nil
}

func cmdRead(c *cli, args []string) error {
	fs := newFlags("read")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "message id"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	e, err := b.Read(pos[0])
	if err != nil {
		return err
	}
	c.emit(e, func() { printEvent(c, e) })
	return nil
}

func printEvent(c *cli, e *bus.Event) {
	fmt.Fprintf(c.out, "id:      %s\nfrom:    %s\nto:      %s\nwhen:    %s\nkind:    %s\n", e.ID, e.From, strings.Join(e.To, ","), e.TS.Format(time.RFC3339), e.Kind)
	if e.Subject != "" {
		fmt.Fprintf(c.out, "subject: %s\n", e.Subject)
	}
	if e.ReplyTo != "" {
		fmt.Fprintf(c.out, "reply-to: %s\n", e.ReplyTo)
	}
	if e.ExpectAck != "" {
		fmt.Fprintf(c.out, "expect-ack by: %s  (answer with: agentbus ack %s [--reject --reason ...])\n", e.ExpectAck, bus.ShortID(e.ID))
	}
	if e.Task != nil {
		fmt.Fprintf(c.out, "task:    requires=%v template=%s deadline=%s heartbeat=%ds max_attempts=%d\n",
			e.Task.Requires, e.Task.Template, e.Task.Deadline, e.Task.HeartbeatSec, e.Task.MaxAttempts)
	}
	for _, a := range e.Attach {
		fmt.Fprintf(c.out, "attach:  %s (%d bytes)  agentbus blob %s\n", a.Name, a.Size, a.SHA256[:12])
	}
	if e.Body != "" {
		fmt.Fprintf(c.out, "\n%s\n", e.Body)
	}
}

func cmdAck(c *cli, args []string) error {
	fs := newFlags("ack")
	reject := fs.Bool("reject", false, "reject instead of accept")
	reason := fs.String("reason", "", "reason (required with --reject)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "message id"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	level := bus.RcptAccepted
	if *reject {
		level = bus.RcptRejected
	}
	e, err := b.Receipt(pos[0], level, *reason)
	if err != nil {
		return err
	}
	c.emit(map[string]any{"receipt": e}, func() {
		if e == nil {
			fmt.Fprintln(c.out, "already acknowledged")
		} else {
			fmt.Fprintf(c.out, "%s %s\n", level, bus.ShortID(e.Ref))
		}
	})
	return nil
}

func cmdStatus(c *cli, args []string) error {
	pos, err := parse(newFlags("status"), args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "message id"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	e, rs, err := b.Status(pos[0])
	if err != nil {
		return err
	}
	c.emit(map[string]any{"event": e, "recipients": rs}, func() {
		fmt.Fprintf(c.out, "%s  %s\n", bus.ShortID(e.ID), bus.Describe(e))
		tw := tabwriter.NewWriter(c.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "RECIPIENT\tRECEIPT\tAT\tREASON")
		for _, r := range rs {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Agent, firstOr(r.Level, "sent (pending)"), dash(r.At), r.Reason)
		}
		tw.Flush()
	})
	return nil
}

func cmdThread(c *cli, args []string) error {
	pos, err := parse(newFlags("thread"), args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "id"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	evs, err := b.Thread(pos[0])
	if err != nil {
		return err
	}
	c.emit(evs, func() { printTimeline(c, evs, true) })
	return nil
}

func printTimeline(c *cli, evs []bus.Event, bodies bool) {
	for _, e := range evs {
		fmt.Fprintf(c.out, "%s  %-14s %s\n", e.TS.Local().Format("2006-01-02 15:04:05"), e.From, bus.Describe(&e))
		if bodies && e.Body != "" && (e.Kind == bus.KindMessage || e.Kind == bus.KindTaskCreate || e.Kind == bus.KindTaskDone) {
			for _, l := range strings.Split(strings.TrimRight(e.Body, "\n"), "\n") {
				fmt.Fprintf(c.out, "    │ %s\n", l)
			}
		}
	}
}

func cmdOverdue(c *cli, args []string) error {
	fs := newFlags("overdue")
	all := fs.Bool("all", false, "all senders (for CI)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	who := b.Me()
	if *all {
		who = ""
	}
	items, err := b.Overdue(who)
	if err != nil {
		return err
	}
	c.emit(items, func() {
		if len(items) == 0 {
			fmt.Fprintln(c.out, "nothing overdue")
		}
		for _, it := range items {
			fmt.Fprintf(c.out, "%s  from %s  deadline %s  pending: %s  %s\n", bus.ShortID(it.Event.ID), it.Event.From,
				it.Event.ExpectAck, strings.Join(it.Pending, ","), bus.Describe(&it.Event))
		}
	})
	return nil
}

func cmdHistory(c *cli, args []string) error {
	fs := newFlags("history")
	agent := fs.String("agent", "", "from or to agent")
	kind := fs.String("kind", "", "event kind or prefix* (msg, receipt, task.*)")
	since := fs.String("since", "", "e.g. 24h, 7d")
	limit := fs.Int("limit", 200, "max events (newest kept)")
	q := fs.String("q", "", "text query")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	return history(c, bus.Filter{Agent: *agent, Kind: *kind, Query: *q, Limit: *limit}, *since)
}

func cmdSearch(c *cli, args []string) error {
	fs := newFlags("search")
	limit := fs.Int("limit", 50, "")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "query"); err != nil {
		return err
	}
	return history(c, bus.Filter{Query: strings.Join(pos, " "), Limit: *limit}, "")
}

func history(c *cli, f bus.Filter, since string) error {
	b, err := openSynced()
	if err != nil {
		return err
	}
	if since != "" {
		d, err := parseDur(since)
		if err != nil {
			return err
		}
		f.Since = time.Now().Add(-d)
	}
	evs, err := b.History(f)
	if err != nil {
		return err
	}
	c.emit(evs, func() { printTimeline(c, evs, false) })
	return nil
}

func cmdBrief(c *cli, args []string) error {
	pos, err := parse(newFlags("brief"), args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "id"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	md, err := b.Brief(pos[0])
	if err != nil {
		return err
	}
	c.emit(map[string]string{"markdown": md}, func() { fmt.Fprint(c.out, md) })
	return nil
}

func cmdBlob(c *cli, args []string) error {
	fs := newFlags("blob")
	out := fs.String("o", "", "write to file")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if err := need(pos, 1, "blob hash"); err != nil {
		return err
	}
	b, err := openSynced()
	if err != nil {
		return err
	}
	data, err := b.GetBlob(pos[0])
	if err != nil {
		return err
	}
	if *out != "" {
		return os.WriteFile(*out, data, 0o644)
	}
	_, err = c.out.Write(data)
	return err
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
