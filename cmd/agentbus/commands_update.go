package main

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
	"github.com/shiroha-document/agentbus/internal/update"
)

// version is set by release builds: -ldflags "-X main.version=0.3.0".
// `go install ...@vX` builds fall back to the module version; plain source
// builds report devVersion and never auto-update.
var version = ""

// devVersion is what source builds report (and send to the hub in
// X-Agentbus-Version). Bump it with each minor release line.
const devVersion = "0.6.1-dev"

// isDev reports a source build ("dev" is the pre-0.4 spelling).
func isDev(v string) bool { return v == "dev" || strings.HasSuffix(v, "-dev") }

func currentVersion() string {
	if version != "" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok && isReleaseTag(bi.Main.Version) {
		return strings.TrimPrefix(bi.Main.Version, "v")
	}
	return devVersion
}

// pseudoRE matches Go pseudo-versions (…-0.20250101120000-abcdef123456).
var pseudoRE = regexp.MustCompile(`\d{14}-[0-9a-f]{12}`)

// isReleaseTag accepts module versions stamped by `go install …@vX.Y.Z`, not
// the VCS stamps of source builds (v0.3.1+dirty, pseudo-versions).
func isReleaseTag(v string) bool {
	if v == "" || v == "(devel)" || strings.Contains(v, "+") || pseudoRE.MatchString(v) {
		return false
	}
	_, ok := update.Parse(v)
	return ok
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
	newer := update.Newer(tag, cur) && !isDev(cur)
	res := map[string]any{"current": cur, "latest": tag, "newer": newer}
	if *check {
		c.emit(res, func() {
			if newer {
				fmt.Fprintf(c.out, i18n.Pick("agentbus %s is available (you have %s); run `agentbus self-update`\n", "agentbus %s 已发布（当前 %s）；运行 `agentbus self-update` 升级\n"), tag, cur)
			} else {
				fmt.Fprintf(c.out, i18n.Pick("agentbus %s is up to date (latest %s)\n", "agentbus %s 已是最新（最新 %s）\n"), cur, tag)
			}
		})
		if !newer {
			return &exitError{code: exitNothing}
		}
		return nil
	}
	if !newer && !*force && *want == "" {
		c.emit(res, func() {
			if isDev(cur) {
				fmt.Fprintf(c.out, i18n.Pick("this is a dev build; latest release is %s (use --force to replace it)\n", "这是开发版；最新发布版是 %s（加 --force 替换）\n"), tag)
			} else {
				fmt.Fprintf(c.out, i18n.Pick("agentbus %s is up to date\n", "agentbus %s 已是最新\n"), cur)
			}
		})
		return nil
	}
	path, err := applyUpdate(ctx, u, tag)
	if err != nil {
		return err
	}
	recordUpdate(cur, tag)
	res["installed"], res["path"] = tag, path
	c.emit(res, func() { fmt.Fprintf(c.out, "agentbus %s -> %s (%s)\n", cur, tag, path) })
	return nil
}

func applyUpdate(ctx context.Context, u *update.Updater, tag string) (string, error) {
	exe, err := executable()
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

// updateStatePath caches the release check next to the hub config.
func updateStatePath() string { return filepath.Join(hub.Dir(), "update.json") }

func saveUpdateState(tag string) {
	update.SaveState(updateStatePath(), update.State{CheckedAt: time.Now().UTC(), Latest: tag})
}
