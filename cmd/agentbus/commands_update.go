package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/bus"
	"github.com/shiroha-document/agentbus/internal/update"
)

// version is set by release builds: -ldflags "-X main.version=0.3.0".
// `go install ...@vX` builds fall back to the module version; plain source
// builds are "dev" and never auto-update.
var version = ""

func currentVersion() string {
	if version != "" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return strings.TrimPrefix(bi.Main.Version, "v")
	}
	return "dev"
}

// DocsURL is where agents read the manual (public, no auth).
const DocsURL = "https://github.com/shiroha-document/agentbus/blob/main/docs/AGENTS.md"

func cmdSelfUpdate(c *cli, args []string) error {
	fs := newFlags("self-update")
	check := fs.Bool("check", false, "only report whether a newer release exists (exit 3 if up to date)")
	force := fs.Bool("force", false, "install even if not newer (e.g. replace a dev build)")
	want := fs.String("version", "", "install this tag instead of the latest (e.g. v0.3.0)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	cur := currentVersion()
	u := update.New()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	tag := *want
	if tag == "" {
		var err error
		if tag, err = u.Latest(ctx); err != nil {
			return err
		}
	}
	saveUpdateState(tag)
	newer := update.Newer(tag, cur)
	res := map[string]any{"current": cur, "latest": tag, "newer": newer}
	if *check {
		c.emit(res, func() {
			if newer {
				fmt.Fprintf(c.out, "agentbus %s is available (you have %s); run `agentbus self-update`\n", tag, cur)
			} else {
				fmt.Fprintf(c.out, "agentbus %s is up to date (latest %s)\n", cur, tag)
			}
		})
		if !newer {
			return &exitError{code: exitNothing}
		}
		return nil
	}
	if !newer && !*force && *want == "" {
		c.emit(res, func() {
			if cur == "dev" {
				fmt.Fprintf(c.out, "this is a dev build; latest release is %s (use --force to replace it)\n", tag)
			} else {
				fmt.Fprintf(c.out, "agentbus %s is up to date\n", cur)
			}
		})
		return nil
	}
	path, err := applyUpdate(ctx, u, tag)
	if err != nil {
		return err
	}
	res["installed"], res["path"] = tag, path
	c.emit(res, func() { fmt.Fprintf(c.out, "agentbus %s -> %s (%s)\n", cur, tag, path) })
	return nil
}

func applyUpdate(ctx context.Context, u *update.Updater, tag string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	bin, err := u.Fetch(ctx, tag, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	verify := func(staged string) error {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(cctx, staged, "--version").Output()
		if err != nil {
			return err
		}
		if got := strings.TrimSpace(string(out)); got != strings.TrimPrefix(tag, "v") {
			return fmt.Errorf("reports version %q, expected %s", got, tag)
		}
		return nil
	}
	return exe, update.Install(exe, bin, verify)
}

func updateStatePath() string { return filepath.Join(bus.Home(), "update.json") }

func saveUpdateState(tag string) {
	update.SaveState(updateStatePath(), update.State{CheckedAt: time.Now().UTC(), Latest: tag})
}

// autoUpdateCommands are the per-turn commands that piggyback a throttled
// release check. Long-running loops (watch, task run) are excluded.
var autoUpdateCommands = map[string]bool{"inbox": true, "wait": true, "join": true, "sync": true, "whoami": true}

const autoUpdateEvery = 12 * time.Hour

// maybeAutoUpdate runs after a successful per-turn command. Mode comes from
// AGENTBUS_AUTO_UPDATE: "auto" (default) installs releases within the same
// compatible line (same major; same minor for 0.x) and only notifies about
// bigger jumps; "notify" only prints a hint; "off" disables it. It never
// changes the command's exit code and never runs in CI or on dev builds.
func (c *cli) maybeAutoUpdate(cmd string) {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("AGENTBUS_AUTO_UPDATE")))
	if mode == "" {
		mode = "auto"
	}
	cur := currentVersion()
	if !autoUpdateCommands[cmd] || mode == "off" || mode == "0" || mode == "false" ||
		os.Getenv("GITHUB_ACTIONS") == "true" || os.Getenv("CI") == "true" || cur == "dev" {
		return
	}
	st := update.LoadState(updateStatePath())
	latest := st.Latest
	if time.Since(st.CheckedAt) >= autoUpdateEvery {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		tag, err := update.New().Latest(ctx)
		cancel()
		// record the attempt even on failure so an offline agent is not slowed every turn
		update.SaveState(updateStatePath(), update.State{CheckedAt: time.Now().UTC(), Latest: firstOr(tag, st.Latest)})
		if err != nil {
			return
		}
		latest = tag
	}
	if !update.Newer(latest, cur) {
		return
	}
	if mode != "auto" || !update.SameMajor(latest, cur) {
		fmt.Fprintf(c.errw, "agentbus: %s is available (you have %s); run `agentbus self-update`, then re-read %s\n", latest, cur, DocsURL)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := applyUpdate(ctx, update.New(), latest); err != nil {
		fmt.Fprintf(c.errw, "agentbus: auto-update to %s failed (%v); run `agentbus self-update` or reinstall\n", latest, err)
		return
	}
	fmt.Fprintf(c.errw, "agentbus: updated %s -> %s; the next command uses it\n", cur, latest)
}
