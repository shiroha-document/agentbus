package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
)

// ---- self-driven agents: inbox / heartbeat / release ----

// cmdInbox claims new messages for a self-driven agent (one that wakes
// itself on its own schedule, e.g. OpenAI dot) and prints each thread's
// round prompt with explicit finish commands. Exit 3 = nothing to do.
func cmdInbox(c *cli, args []string) error {
	fs := newFlags("inbox")
	max := fs.Int("max-threads", 1, "threads to claim (0 = hub default)")
	peek := fs.Bool("peek", false, "only count waiting messages, claim nothing")
	asJSON := fs.Bool("json", false, "JSON output")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *asJSON {
		c.json = true
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	exe, _ := os.Executable()
	ctx, cancel := cmdContext()
	defer cancel()
	tk := &hub.Ticker{Dir: e.dir, Cfg: e.cfg, Client: e.cl, Version: hubVersion(), Exe: exe, Log: c.errw}
	out, err := tk.Inbox(ctx, *max, *peek)
	if err != nil {
		return err
	}
	c.emit(out, func() {
		if len(out.Threads) == 0 {
			fmt.Fprintf(c.out, i18n.Pick("agentbus inbox: %s\n", "agentbus inbox：%s\n"), inboxOutcomeText(out.Message))
			if out.Code == hub.ExitNothing && !*peek {
				fmt.Fprintln(c.out, i18n.Pick("Nothing to do — stop here until your next scheduled wake-up.", "没有要处理的消息，本次到此结束，等下一次定时唤醒。"))
			}
			return
		}
		for i, t := range out.Threads {
			if i > 0 {
				fmt.Fprintln(c.out)
			}
			fmt.Fprintln(c.out, inboxHeader(t))
			fmt.Fprintln(c.out, t.Prompt)
		}
	})
	if out.Code != 0 {
		return &exitError{code: out.Code}
	}
	return nil
}

// inboxHeader is the banner printed above a claimed thread's prompt.
func inboxHeader(t hub.InboxThread) string {
	lease := time.UnixMilli(t.LeaseUntil).Local().Format("15:04")
	return fmt.Sprintf(i18n.Pick(
		"======== agentbus inbox: thread %s (%s) ========\nround %s · lease until %s · workdir %s\nfinish with: agentbus post --thread %s …  then  agentbus ack --thread %s\n",
		"======== agentbus inbox：讨论串 %s（%s）========\n轮次 %s · 租约到 %s · 工作目录 %s\n收尾：agentbus post --thread %s …  然后  agentbus ack --thread %s\n"),
		t.ThreadID, t.Title, t.Round, lease, t.Workdir, t.ThreadID, t.ThreadID)
}

// cmdHeartbeat extends the lease on a thread being worked on.
func cmdHeartbeat(c *cli, args []string) error {
	fs := newFlags("heartbeat")
	thread := fs.String("thread", "", "thread id (default $AGENTBUS_THREAD)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	t, err := threadArg(firstOr(*thread, strings.Join(pos, "")))
	if err != nil {
		return err
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	until, err := e.cl.Heartbeat(ctx, t)
	if err != nil {
		return err
	}
	c.emit(map[string]any{"thread": t, "lease_until": until}, func() {
		fmt.Fprintf(c.out, i18n.Pick("lease on %s extended to %s\n", "%s 的租约已延长到 %s\n"), t, time.UnixMilli(until).Local().Format("15:04"))
	})
	return nil
}

// cmdRelease gives claimed messages back (nack) so they are retried later.
func cmdRelease(c *cli, args []string) error {
	fs := newFlags("release")
	thread := fs.String("thread", "", "thread id (default $AGENTBUS_THREAD)")
	reason := fs.String("reason", "", "why the messages go back (shown to the team)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	t, err := threadArg(*thread)
	if err != nil {
		return err
	}
	why := strings.TrimSpace(*reason)
	if why == "" {
		why = "released by the agent"
	}
	e, err := loadHub()
	if err != nil {
		return err
	}
	ctx, cancel := cmdContext()
	defer cancel()
	if err := e.cl.Nack(ctx, t, pos, why); err != nil {
		return err
	}
	if len(pos) == 0 {
		hub.ForgetInboxRound(e.dir, t)
	}
	c.emit(map[string]any{"thread": t, "released": true}, func() {
		fmt.Fprintf(c.out, i18n.Pick("released %s (the messages will be delivered again)\n", "已退回 %s（消息稍后会重新投递）\n"), t)
	})
	return nil
}
