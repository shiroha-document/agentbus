package sched

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite golden files")

func golden(t *testing.T, name, got string) {
	t.Helper()
	p := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(p, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("%s mismatch:\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}

var job = Job{Name: "alice", Exe: "/Users/a b/bin/agentbus", Interval: 5 * time.Minute,
	LogDir: "/Users/a b/Library/Application Support/agentbus/logs", Path: "/opt/homebrew/bin:/usr/bin:/bin"}

func TestGolden(t *testing.T) {
	golden(t, "launchd.plist", LaunchdPlist(job))
	golden(t, "systemd.service", SystemdService(job))
	golden(t, "systemd.timer", SystemdTimer(job))
	golden(t, "cron.txt", CronLine(job)+"\n")
	j := job
	j.HubHome = "/tmp/hub & co"
	golden(t, "launchd_hubhome.plist", LaunchdPlist(j))
}

func TestSchtasks(t *testing.T) {
	j := Job{Name: "bob", Exe: `C:\Program Files\agentbus\agentbus.exe`, Interval: 10 * time.Minute}
	want := []string{"/create", "/sc", "minute", "/mo", "10", "/tn", "agentbus-bob", "/tr", `"C:\Program Files\agentbus\agentbus.exe" tick`, "/f"}
	if got := SchtasksCreateArgs(j); !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
}

func TestCronSchedule(t *testing.T) {
	for in, want := range map[time.Duration]string{
		30 * time.Second: "* * * * *", time.Minute: "* * * * *", 5 * time.Minute: "*/5 * * * *",
		90 * time.Second: "*/2 * * * *", 2 * time.Hour: "0 */2 * * *", 48 * time.Hour: "0 0 * * *",
	} {
		if got := CronSchedule(Job{Interval: in}); got != want {
			t.Errorf("%v: %s want %s", in, got, want)
		}
	}
}

func TestMergeCrontab(t *testing.T) {
	cur := "MAILTO=x\n0 1 * * * backup\n*/5 * * * * /old/agentbus tick # agentbus:alice\n*/5 * * * * other # agentbus:bob\n"
	got := MergeCrontab(cur, "alice", "*/10 * * * * new # agentbus:alice")
	want := "MAILTO=x\n0 1 * * * backup\n*/5 * * * * other # agentbus:bob\n*/10 * * * * new # agentbus:alice\n"
	if got != want {
		t.Fatalf("%q", got)
	}
	if got := MergeCrontab("x # agentbus:alice\n", "alice", ""); got != "" {
		t.Fatalf("%q", got)
	}
}

type call struct {
	name  string
	args  []string
	stdin string
}

type fakeRunner struct {
	calls []call
	fail  map[string]bool   // "name arg0" -> error
	out   map[string]string // "name arg0" -> output
}

func (f *fakeRunner) Run(name string, args []string, stdin string) (string, error) {
	f.calls = append(f.calls, call{name, args, stdin})
	k := name
	if len(args) > 0 {
		k += " " + args[0]
	}
	if len(args) > 1 && name == "systemctl" {
		k += " " + args[1]
	}
	if f.fail[k] {
		return f.out[k], errors.New("exit status 1")
	}
	return f.out[k], nil
}

func (f *fakeRunner) cmds() []string {
	var s []string
	for _, c := range f.calls {
		s = append(s, strings.TrimSpace(c.name+" "+strings.Join(c.args, " ")))
	}
	return s
}

func TestInstallLaunchd(t *testing.T) {
	home := t.TempDir()
	r := &fakeRunner{}
	h := Host{GOOS: "darwin", Home: home, UID: 501, Runner: r}
	j := job
	j.LogDir = filepath.Join(home, "logs")
	m, err := Install(h, "", j)
	if err != nil || m != Launchd {
		t.Fatal(m, err)
	}
	p := LaunchdPlistPath(home, "alice")
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
	want := []string{"launchctl bootout gui/501/tech.shiroha.agentbus.alice", "launchctl bootstrap gui/501 " + p}
	if !reflect.DeepEqual(r.cmds(), want) {
		t.Fatalf("%q", r.cmds())
	}
	if st := Query(h, "", "alice"); !st.Installed {
		t.Fatalf("%+v", st)
	}
	if _, err := Uninstall(h, "", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("plist not removed")
	}
}

func TestInstallSystemdAndCron(t *testing.T) {
	home := t.TempDir()
	r := &fakeRunner{out: map[string]string{"systemctl --user is-active": "active\n"}}
	h := Host{GOOS: "linux", Home: home, Runner: r}
	if m, err := Install(h, "", job); err != nil || m != Systemd {
		t.Fatal(m, err)
	}
	if _, err := os.Stat(filepath.Join(SystemdDir(home), "agentbus-alice.timer")); err != nil {
		t.Fatal(err)
	}
	want := []string{"systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable --now agentbus-alice.timer"}
	if !reflect.DeepEqual(r.cmds(), want) {
		t.Fatalf("%q", r.cmds())
	}
	if st := Query(h, Systemd, "alice"); !st.Installed {
		t.Fatalf("%+v", st)
	}

	// no systemd user session -> cron
	r = &fakeRunner{fail: map[string]bool{"systemctl --user show-environment": true, "crontab -l": true},
		out: map[string]string{"crontab -l": "no crontab for alice\n"}}
	h.Runner = r
	if m, err := Install(h, "", Job{Name: "alice", Exe: "/usr/local/bin/agentbus"}); err != nil || m != Cron {
		t.Fatal(m, err)
	}
	last := r.calls[len(r.calls)-1]
	if last.name != "crontab" || last.stdin != "*/5 * * * * /usr/local/bin/agentbus tick # agentbus:alice\n" {
		t.Fatalf("%+v", last)
	}
}

func TestInstallSchtasks(t *testing.T) {
	r := &fakeRunner{}
	h := Host{GOOS: "windows", Runner: r}
	if m, err := Install(h, "", Job{Name: "bob", Exe: `C:\ab\agentbus.exe`, Interval: 5 * time.Minute}); err != nil || m != Schtasks {
		t.Fatal(m, err)
	}
	if got := r.cmds()[0]; got != `schtasks /create /sc minute /mo 5 /tn agentbus-bob /tr C:\ab\agentbus.exe tick /f` {
		t.Fatal(got)
	}
	if _, err := Uninstall(h, "", "bob"); err != nil {
		t.Fatal(err)
	}
}
