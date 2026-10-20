// Package sched installs the periodic `agentbus tick` job in the user's
// scheduler: launchd (macOS), systemd user timers or cron (Linux and other
// Unix), and the Task Scheduler (Windows).
//
// The text of every job is produced by pure functions (golden-tested); the
// install functions only write files and run commands through a Runner, so
// tests never touch the real scheduler.
package sched

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Methods.
const (
	Launchd  = "launchd"
	Systemd  = "systemd"
	Cron     = "cron"
	Schtasks = "schtasks"
)

// Job is one agent's periodic tick.
type Job struct {
	Name     string        // agent name (^[a-z0-9][a-z0-9_-]{1,31}$)
	Exe      string        // absolute path of the agentbus binary
	Interval time.Duration // default 5m
	LogDir   string        // where launchd/cron write tick.log
	HubHome  string        // passed as `tick --hub-home DIR` when set
	Path     string        // PATH for the job (so it finds claude/codex/…)
}

func (j Job) seconds() int {
	s := int(j.Interval / time.Second)
	if s <= 0 {
		s = 300
	}
	if s < 60 {
		s = 60
	}
	return s
}

// Minutes is the interval rounded up to whole minutes (1..1439).
func (j Job) Minutes() int {
	m := (j.seconds() + 59) / 60
	if m > 1439 {
		m = 1439
	}
	return m
}

// Args is the argv after the executable.
func (j Job) Args() []string {
	a := []string{"tick"}
	if j.HubHome != "" {
		a = append(a, "--hub-home", j.HubHome)
	}
	return a
}

// launchd/systemd/cron files are unix-only: always use forward slashes.
func (j Job) logFile() string { return path.Join(j.LogDir, "tick.log") }

// ---- launchd ----

// LaunchdLabel is tech.shiroha.agentbus.<name>.
func LaunchdLabel(name string) string { return "tech.shiroha.agentbus." + name }

// LaunchdPlistPath is ~/Library/LaunchAgents/<label>.plist.
func LaunchdPlistPath(home, name string) string {
	return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel(name)+".plist")
}

func xmlEsc(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

// LaunchdPlist renders the LaunchAgent.
func LaunchdPlist(j Job) string {
	var b strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&b, f, a...) }
	w("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	w("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	w("<plist version=\"1.0\">\n<dict>\n")
	w("\t<key>Label</key>\n\t<string>%s</string>\n", xmlEsc(LaunchdLabel(j.Name)))
	w("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, a := range append([]string{j.Exe}, j.Args()...) {
		w("\t\t<string>%s</string>\n", xmlEsc(a))
	}
	w("\t</array>\n")
	w("\t<key>StartInterval</key>\n\t<integer>%d</integer>\n", j.seconds())
	w("\t<key>RunAtLoad</key>\n\t<false/>\n")
	w("\t<key>ProcessType</key>\n\t<string>Background</string>\n")
	if j.Path != "" {
		w("\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>PATH</key>\n\t\t<string>%s</string>\n\t</dict>\n", xmlEsc(j.Path))
	}
	if j.LogDir != "" {
		w("\t<key>StandardOutPath</key>\n\t<string>%s</string>\n", xmlEsc(j.logFile()))
		w("\t<key>StandardErrorPath</key>\n\t<string>%s</string>\n", xmlEsc(j.logFile()))
	}
	w("</dict>\n</plist>\n")
	return b.String()
}

// ---- systemd ----

// SystemdUnit is agentbus-<name> (.service / .timer).
func SystemdUnit(name string) string { return "agentbus-" + name }

// SystemdDir is ~/.config/systemd/user.
func SystemdDir(home string) string { return filepath.Join(home, ".config", "systemd", "user") }

func systemdQuote(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\"'\\$%;") {
		return s
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, `$`, `$$`)
	return `"` + r.Replace(s) + `"`
}

// SystemdService renders the oneshot service that runs one tick. Exit codes
// 3/4/5 (nothing to do, paused, quota) count as success.
func SystemdService(j Job) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[Unit]\nDescription=agentbus tick (%s)\n\n[Service]\nType=oneshot\n", j.Name)
	if j.Path != "" {
		fmt.Fprintf(&b, "Environment=%s\n", systemdQuote("PATH="+j.Path))
	}
	argv := []string{systemdQuote(j.Exe)}
	for _, a := range j.Args() {
		argv = append(argv, systemdQuote(a))
	}
	fmt.Fprintf(&b, "ExecStart=%s\n", strings.Join(argv, " "))
	b.WriteString("SuccessExitStatus=3 4 5\n")
	return b.String()
}

// SystemdTimer renders the timer: first run shortly after activation, then
// every interval after the previous run.
func SystemdTimer(j Job) string {
	return fmt.Sprintf("[Unit]\nDescription=agentbus tick every %ds (%s)\n\n[Timer]\nOnActiveSec=30s\nOnUnitActiveSec=%ds\nAccuracySec=15s\nUnit=%s.service\n\n[Install]\nWantedBy=timers.target\n",
		j.seconds(), j.Name, j.seconds(), SystemdUnit(j.Name))
}

// ---- cron ----

func cronMarker(name string) string { return "# agentbus:" + name }

func shQuote(s string) string {
	if s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:=@,+") == "" {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// CronSchedule is the 5-field schedule for an interval.
func CronSchedule(j Job) string {
	m := (j.seconds() + 59) / 60
	switch {
	case m <= 1:
		return "* * * * *"
	case m < 60:
		return fmt.Sprintf("*/%d * * * *", m)
	}
	h := m / 60
	if h >= 24 {
		return "0 0 * * *"
	}
	return fmt.Sprintf("0 */%d * * *", h)
}

// CronLine is the crontab entry, tagged with a marker comment.
func CronLine(j Job) string {
	var parts []string
	if j.Path != "" {
		parts = append(parts, "PATH="+shQuote(j.Path))
	}
	parts = append(parts, shQuote(j.Exe))
	for _, a := range j.Args() {
		parts = append(parts, shQuote(a))
	}
	line := CronSchedule(j) + " " + strings.Join(parts, " ")
	if j.LogDir != "" {
		line += " >>" + shQuote(j.logFile()) + " 2>&1"
	}
	return line + " " + cronMarker(j.Name)
}

// MergeCrontab returns crontab text with the entry for name replaced by
// line (removed when line is "").
func MergeCrontab(current, name, line string) string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(current, "\r\n", "\n"), "\n") {
		if strings.HasSuffix(strings.TrimSpace(l), cronMarker(name)) {
			continue
		}
		out = append(out, l)
	}
	for len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
		out = out[:len(out)-1]
	}
	if line != "" {
		out = append(out, line)
	}
	if len(out) == 0 {
		return ""
	}
	return strings.Join(out, "\n") + "\n"
}

// ---- Windows Task Scheduler ----

// TaskName is agentbus-<name>.
func TaskName(name string) string { return "agentbus-" + name }

func winQuote(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\"") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// SchtasksCreateArgs is the argv for `schtasks`.
func SchtasksCreateArgs(j Job) []string {
	tr := []string{winQuote(j.Exe)}
	for _, a := range j.Args() {
		tr = append(tr, winQuote(a))
	}
	return []string{"/create", "/sc", "minute", "/mo", fmt.Sprint(j.Minutes()), "/tn", TaskName(j.Name), "/tr", strings.Join(tr, " "), "/f"}
}

// ---- install ----

// Runner runs a command (never through a shell) and returns its combined
// output.
type Runner interface {
	Run(name string, args []string, stdin string) (string, error)
}

// Host is the machine being configured.
type Host struct {
	GOOS   string
	Home   string
	UID    int
	Runner Runner
}

// Detect picks the scheduler for h.
func Detect(h Host) string {
	switch h.GOOS {
	case "darwin":
		return Launchd
	case "windows":
		return Schtasks
	}
	if _, err := h.Runner.Run("systemctl", []string{"--user", "show-environment"}, ""); err == nil {
		return Systemd
	}
	return Cron
}

// Status describes an installed job.
type Status struct {
	Method    string
	Installed bool
	Detail    string
}

func writeFile(path, data string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(data), 0o644)
}

func run(h Host, name string, args ...string) (string, error) {
	out, err := h.Runner.Run(name, args, "")
	if err != nil {
		return out, fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(out))
	}
	return out, nil
}

// Install installs (or replaces) j using method ("" = Detect).
func Install(h Host, method string, j Job) (string, error) {
	if method == "" {
		method = Detect(h)
	}
	if j.Name == "" || j.Exe == "" {
		return method, fmt.Errorf("schedule: job needs a name and an executable")
	}
	if j.LogDir != "" {
		if err := os.MkdirAll(j.LogDir, 0o700); err != nil {
			return method, err
		}
	}
	switch method {
	case Launchd:
		p := LaunchdPlistPath(h.Home, j.Name)
		dom := fmt.Sprintf("gui/%d", h.UID)
		_, _ = h.Runner.Run("launchctl", []string{"bootout", dom + "/" + LaunchdLabel(j.Name)}, "")
		if err := writeFile(p, LaunchdPlist(j)); err != nil {
			return method, err
		}
		_, err := run(h, "launchctl", "bootstrap", dom, p)
		return method, err
	case Systemd:
		dir, u := SystemdDir(h.Home), SystemdUnit(j.Name)
		if err := writeFile(filepath.Join(dir, u+".service"), SystemdService(j)); err != nil {
			return method, err
		}
		if err := writeFile(filepath.Join(dir, u+".timer"), SystemdTimer(j)); err != nil {
			return method, err
		}
		if _, err := run(h, "systemctl", "--user", "daemon-reload"); err != nil {
			return method, err
		}
		_, err := run(h, "systemctl", "--user", "enable", "--now", u+".timer")
		return method, err
	case Cron:
		cur, _ := h.Runner.Run("crontab", []string{"-l"}, "") // "no crontab for user" is fine
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(cur)), "no crontab") {
			cur = ""
		}
		if out, err := h.Runner.Run("crontab", []string{"-"}, MergeCrontab(cur, j.Name, CronLine(j))); err != nil {
			return method, fmt.Errorf("crontab -: %v: %s", err, strings.TrimSpace(out))
		}
		return method, nil
	case Schtasks:
		_, err := run(h, "schtasks", SchtasksCreateArgs(j)...)
		return method, err
	}
	return method, fmt.Errorf("unknown scheduler %q (want launchd, systemd, cron or schtasks)", method)
}

// Uninstall removes the job for name.
func Uninstall(h Host, method, name string) (string, error) {
	if method == "" {
		method = Detect(h)
	}
	switch method {
	case Launchd:
		_, _ = h.Runner.Run("launchctl", []string{"bootout", fmt.Sprintf("gui/%d/%s", h.UID, LaunchdLabel(name))}, "")
		if err := os.Remove(LaunchdPlistPath(h.Home, name)); err != nil && !os.IsNotExist(err) {
			return method, err
		}
		return method, nil
	case Systemd:
		dir, u := SystemdDir(h.Home), SystemdUnit(name)
		_, _ = h.Runner.Run("systemctl", []string{"--user", "disable", "--now", u + ".timer"}, "")
		for _, ext := range []string{".timer", ".service"} {
			if err := os.Remove(filepath.Join(dir, u+ext)); err != nil && !os.IsNotExist(err) {
				return method, err
			}
		}
		_, err := run(h, "systemctl", "--user", "daemon-reload")
		return method, err
	case Cron:
		cur, err := h.Runner.Run("crontab", []string{"-l"}, "")
		if err != nil {
			return method, nil // no crontab, nothing to remove
		}
		if out, err := h.Runner.Run("crontab", []string{"-"}, MergeCrontab(cur, name, "")); err != nil {
			return method, fmt.Errorf("crontab -: %v: %s", err, strings.TrimSpace(out))
		}
		return method, nil
	case Schtasks:
		out, err := h.Runner.Run("schtasks", []string{"/delete", "/tn", TaskName(name), "/f"}, "")
		if err != nil && !strings.Contains(strings.ToLower(out), "cannot find") {
			return method, fmt.Errorf("schtasks /delete: %v: %s", err, strings.TrimSpace(out))
		}
		return method, nil
	}
	return method, fmt.Errorf("unknown scheduler %q", method)
}

// Query reports whether the job for name is installed.
func Query(h Host, method, name string) Status {
	if method == "" {
		method = Detect(h)
	}
	st := Status{Method: method}
	switch method {
	case Launchd:
		p := LaunchdPlistPath(h.Home, name)
		if _, err := os.Stat(p); err != nil {
			st.Detail = p + " not found"
			return st
		}
		if _, err := h.Runner.Run("launchctl", []string{"print", fmt.Sprintf("gui/%d/%s", h.UID, LaunchdLabel(name))}, ""); err != nil {
			st.Detail = p + " exists but is not loaded (run `agentbus schedule install` again)"
			return st
		}
		st.Installed, st.Detail = true, p
	case Systemd:
		u := SystemdUnit(name) + ".timer"
		out, err := h.Runner.Run("systemctl", []string{"--user", "is-active", u}, "")
		st.Installed = err == nil && strings.TrimSpace(out) == "active"
		st.Detail = u + ": " + firstLine(out)
	case Cron:
		out, err := h.Runner.Run("crontab", []string{"-l"}, "")
		if err == nil {
			for _, l := range strings.Split(out, "\n") {
				if strings.HasSuffix(strings.TrimSpace(l), cronMarker(name)) {
					st.Installed, st.Detail = true, strings.TrimSpace(l)
				}
			}
		}
		if !st.Installed {
			st.Detail = "no crontab entry tagged " + cronMarker(name)
		}
	case Schtasks:
		out, err := h.Runner.Run("schtasks", []string{"/query", "/tn", TaskName(name)}, "")
		st.Installed = err == nil
		st.Detail = TaskName(name)
		if err != nil {
			st.Detail += ": " + firstLine(out)
		}
	default:
		st.Detail = "unknown scheduler"
	}
	return st
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

// Methods lists the supported schedulers.
func Methods() []string {
	m := []string{Launchd, Systemd, Cron, Schtasks}
	sort.Strings(m)
	return m
}

// ExecRunner runs real commands via os/exec.
type ExecRunner struct{}

func (ExecRunner) Run(name string, args []string, stdin string) (string, error) {
	cmd := exec.Command(name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}
