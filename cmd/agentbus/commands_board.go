package main

import (
	"fmt"
	"os"
	"time"
	_ "time/tzdata" // --tz works on Windows and minimal containers too

	"github.com/shiroha-document/agentbus/internal/bus"
)

// openReport opens the bus read-only for digest/board: from --remote into a
// scratch dir (no agent identity needed, works in CI), else the local home.
func openReport(remote, branch, work string) (*bus.Bus, func(), error) {
	if remote == "" {
		b, err := open()
		if err == nil {
			err = b.Refresh()
		}
		return b, func() {}, err
	}
	cleanup := func() {}
	if work == "" {
		dir, err := os.MkdirTemp("", "agentbus-report-")
		if err != nil {
			return nil, cleanup, err
		}
		work, cleanup = dir, func() { os.RemoveAll(dir) }
	}
	b, err := bus.OpenRemote(remote, branch, work)
	return b, cleanup, err
}

// cmdBoard prints the dashboard markdown that the digest workflow keeps in
// the pinned "agentbus board" issue.
func cmdBoard(c *cli, args []string) error {
	fs := newFlags("board")
	remote := fs.String("remote", "", "read the bus from this remote (no agent identity needed)")
	branch := fs.String("branch", "agent-bus", "")
	work := fs.String("workdir", "", "scratch dir for --remote (default temp)")
	tz := fs.String("tz", "", "display time zone, e.g. Asia/Shanghai (default $AGENTBUS_TZ, else UTC)")
	recent := fs.String("recent", "7d", "window for finished tasks and mail")
	rows := fs.Int("max-rows", 30, "rows per section")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	o := bus.BoardOpts{MaxRows: *rows}
	if name := firstOr(*tz, os.Getenv("AGENTBUS_TZ")); name != "" {
		loc, err := time.LoadLocation(name)
		if err != nil {
			return &exitError{code: exitUsage, msg: fmt.Sprintf("--tz: %v", err)}
		}
		o.Loc = loc
	}
	d, err := parseDur(*recent)
	if err != nil {
		return &exitError{code: exitUsage, msg: fmt.Sprintf("--recent: %v", err)}
	}
	o.Recent = d
	b, cleanup, err := openReport(*remote, *branch, *work)
	defer cleanup()
	if err != nil {
		return err
	}
	md, err := b.Board(o)
	if err != nil {
		return err
	}
	c.emit(map[string]string{"markdown": md}, func() { fmt.Fprint(c.out, md) })
	return nil
}
