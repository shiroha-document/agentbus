package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/update"
)

// Auto-update runs before every command, so an agent always executes the
// newest release: if one is out, it is downloaded, verified (SHA256SUMS +
// self-check) and swapped in, and the same command line is re-executed on
// the new binary. The release check is cached for AGENTBUS_UPDATE_EVERY
// (default 5m; 0 = every call) so bursts of commands cost one request.
//
// AGENTBUS_AUTO_UPDATE: auto (default) installs any newer release, including
// ones that may change commands (stderr then asks the agent to re-read the
// docs); notify only prints a hint; off disables it. CI runs, dev builds and
// self-update/help never auto-update. Failures never fail the command.

const (
	defaultUpdateEvery = 5 * time.Minute
	updateCheckTimeout = 3 * time.Second
	reexecEnv          = "AGENTBUS_REEXEC"
)

// noAutoUpdate lists commands that must not trigger an update.
var noAutoUpdate = map[string]bool{"self-update": true, "help": true}

// test seams
var (
	executable = os.Executable
	reexec     = reexecProcess
)

func autoUpdateMode() string {
	m := strings.ToLower(strings.TrimSpace(os.Getenv("AGENTBUS_AUTO_UPDATE")))
	switch m {
	case "", "auto", "on", "1", "true":
		return "auto"
	case "off", "0", "false", "no":
		return "off"
	}
	return "notify"
}

func updateEvery() time.Duration {
	if s := strings.TrimSpace(os.Getenv("AGENTBUS_UPDATE_EVERY")); s != "" {
		if d, err := parseDur(s); err == nil && d >= 0 {
			return d
		}
	}
	return defaultUpdateEvery
}

// autoUpdate is called before dispatching cmd. If it installed a new binary
// and re-ran argv on it, it returns (true, child exit code) and the caller
// must return that code without running the command itself.
func (c *cli) autoUpdate(cmd string, argv []string) (bool, int) {
	if from := os.Getenv(reexecEnv); from != "" {
		// we are the freshly installed binary; don't let our children inherit the guard
		os.Unsetenv(reexecEnv)
		return false, 0
	}
	cur := currentVersion()
	mode := autoUpdateMode()
	if noAutoUpdate[cmd] || mode == "off" || isDev(cur) ||
		os.Getenv("GITHUB_ACTIONS") == "true" || os.Getenv("CI") == "true" {
		return false, 0
	}
	st := update.LoadState(updateStatePath())
	if every := updateEvery(); every > 0 && time.Since(st.CheckedAt) < every {
		return false, 0 // checked recently; anything found then was handled then
	}
	ctx, cancel := context.WithTimeout(context.Background(), updateCheckTimeout)
	latest, err := update.New().Latest(ctx)
	cancel()
	// record the attempt even on failure so an offline agent is not slowed every call
	update.SaveState(updateStatePath(), update.State{CheckedAt: time.Now().UTC(), Latest: firstOr(latest, st.Latest)})
	if err != nil || !update.Newer(latest, cur) {
		return false, 0
	}
	if mode != "auto" {
		fmt.Fprintf(c.errw, "agentbus: %s is available (you have %s); run `agentbus self-update`, then re-read %s\n", latest, cur, DocsURL)
		return false, 0
	}
	dctx, dcancel := context.WithTimeout(context.Background(), 2*time.Minute)
	path, err := applyUpdate(dctx, update.New(), latest)
	dcancel()
	if err != nil {
		fmt.Fprintf(c.errw, "agentbus: auto-update to %s failed (%v); continuing with %s. Fix: `agentbus self-update` or reinstall\n", latest, err, cur)
		return false, 0
	}
	recordUpdate(cur, latest)
	note := "bug-fix release"
	if !update.SameMajor(latest, cur) {
		note = "commands may have changed"
	}
	fmt.Fprintf(c.errw, "agentbus: updated %s -> %s (%s); re-read %s\n", cur, latest, note, DocsURL)
	os.Setenv(reexecEnv, cur)
	code, err := reexec(path, argv)
	if err != nil {
		os.Unsetenv(reexecEnv)
		fmt.Fprintf(c.errw, "agentbus: could not restart on %s (%v); this run uses %s\n", latest, err, cur)
		return false, 0
	}
	return true, code
}
