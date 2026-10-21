package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
	"github.com/shiroha-document/agentbus/internal/telemetry"
)

// joinedHub is a fake hub with alice joined and active.
func joinedHub(t *testing.T) (*cliHub, string) {
	t.Helper()
	h, url := newCLIHub(t)
	if code, out := run(t, "join", url, "--join-code", testJoinCode, "--name", "alice", "--cli", "claude"); code != 0 {
		t.Fatalf("join: %d %s", code, out)
	}
	h.status = "active"
	h.mu.Lock()
	h.events, h.posts = nil, nil
	h.mu.Unlock()
	t.Cleanup(func() { telemetry.Init("", false, "") })
	return h, url
}

func TestTelemetryCommandAndFlush(t *testing.T) {
	h, _ := joinedHub(t)
	t.Setenv("AGENTBUS_THREAD", "t_1")
	if code, out := run(t, "post", "--body", "-secret-body", "--key", "k1"); code != 0 {
		t.Fatalf("%d %s", code, out)
	}
	var ev *hub.Event
	for i := range h.events {
		if h.events[i].Name == "cli.command" && h.events[i].Props["cmd"] == "post" {
			ev = &h.events[i]
		}
	}
	if ev == nil {
		t.Fatalf("no cli.command for post: %+v", h.events)
	}
	if ev.Props["flags"] != "body,key" || ev.Props["adapter"] != "claude" || ev.Props["lang"] != "en" ||
		ev.OK == nil || !*ev.OK || ev.DurationMS == nil || ev.ClientVersion == "" {
		t.Fatalf("%+v", ev)
	}
	raw, _ := json.Marshal(h.events)
	if bytes.Contains(raw, []byte("secret")) || bytes.Contains(raw, []byte("k1")) || bytes.Contains(raw, []byte("t_1")) {
		t.Fatalf("leaked values: %s", raw)
	}
	if telemetry.Queued() != 0 {
		t.Fatal("queue not flushed")
	}

	// status / off / on persist the config
	if code, out := run(t, "telemetry"); code != 0 || !strings.Contains(out, "telemetry: on") {
		t.Fatalf("%d %s", code, out)
	}
	if code, out := run(t, "telemetry", "off"); code != 0 || !strings.Contains(out, "turned off") {
		t.Fatalf("%d %s", code, out)
	}
	if cfg, _ := hub.LoadConfig(hub.Dir()); cfg.Telemetry == nil || *cfg.Telemetry {
		t.Fatalf("config %+v", cfg.Telemetry)
	}
	n := len(h.events)
	if code, _ := run(t, "post", "--body", "x"); code != 0 || len(h.events) != n || telemetry.Queued() != 0 {
		t.Fatalf("events while off: %d", len(h.events)-n)
	}
	if code, out := run(t, "--json", "telemetry", "status"); code != 0 || !strings.Contains(out, `"enabled": false`) {
		t.Fatalf("%d %s", code, out)
	}
	if code, _ := run(t, "telemetry", "on"); code != 0 {
		t.Fatal("on")
	}
	if cfg, _ := hub.LoadConfig(hub.Dir()); cfg.Telemetry == nil || !*cfg.Telemetry {
		t.Fatal("not on")
	}
	// the environment opt-out wins
	t.Setenv("AGENTBUS_TELEMETRY", "off")
	n = len(h.events)
	if code, out := run(t, "telemetry", "status"); code != 0 || !strings.Contains(out, "AGENTBUS_TELEMETRY") || len(h.events) != n {
		t.Fatalf("%d %s", code, out)
	}
	if code, _ := run(t, "telemetry", "bogus"); code != exitUsage {
		t.Fatal("bogus sub")
	}
}

func TestFlagNames(t *testing.T) {
	got := flagNames([]string{"post", "--body", "-x", "--key=abc", "--body=y", "-o", "f", "--secret=1", "--", "--title"})
	if got != "body,key,o" {
		t.Fatal(got)
	}
}

func TestRecordTick(t *testing.T) {
	pendingEvents = nil
	recordTick(hub.Outcome{Threads: []hub.ThreadOutcome{{AgentPosted: true}, {TimedOut: true, ErrorSummary: "x"},
		{TickPosted: true, Run: &hub.Run{ExitCode: 2}}}}, "codex")
	p := pendingEvents[0].Props
	pendingEvents = nil
	if p["threads"] != 3 || p["posted"] != 2 || p["timed_out"] != 1 || p["failed"] != 2 || p["adapter"] != "codex" {
		t.Fatalf("%v", p)
	}
}

func TestPostAttachAndStatus(t *testing.T) {
	h, _ := joinedHub(t)
	t.Setenv("AGENTBUS_THREAD", "t_1")
	t.Setenv("AGENTBUS_IN_TICK", "1")
	t.Setenv("AGENTBUS_CLI", "traecli")
	t.Setenv("AGENTBUS_MODEL", "m-1")
	d := t.TempDir()
	png := filepath.Join(d, "shot.png")
	blob := filepath.Join(d, "notes")
	_ = os.WriteFile(png, []byte("\x89PNG\r\n\x1a\nxx"), 0o644)
	_ = os.WriteFile(blob, []byte("plain text here"), 0o644)
	h.collapsed = true
	code, out := run(t, "post", "--body", "see files", "--attach", png, "--attach", blob)
	if code != 0 || !strings.Contains(out, "posted p_9 in t_1 with 2 attachment(s)") ||
		!strings.Contains(out, "updated the previous progress post") {
		t.Fatalf("%d %s", code, out)
	}
	if len(h.uploads) != 2 || h.uploads[0].Name != "shot.png" || h.uploads[0].Mime != "image/png" ||
		!strings.HasPrefix(h.uploads[1].Mime, "text/plain") || h.uploads[1].Size != 15 {
		t.Fatalf("%+v", h.uploads)
	}
	np := h.posts[len(h.posts)-1]
	if strings.Join(np.Attachments, ",") != "f_1,f_2" || np.CLI != "traecli" || np.Model != "m-1" {
		t.Fatalf("%+v", np)
	}
	if len(h.activities) != 1 || h.activities[0].ThreadID != "t_1" || h.activities[0].State != "typing" ||
		h.activities[0].CLI != "traecli" {
		t.Fatalf("%+v", h.activities)
	}
	// same body with other files is a different post
	k1 := np.IdempotencyKey
	t.Setenv("AGENTBUS_ROUND", "d_1:r1")
	run(t, "post", "--body", "see files", "--attach", png)
	run(t, "post", "--body", "see files")
	if a, b := h.posts[len(h.posts)-2].IdempotencyKey, h.posts[len(h.posts)-1].IdempotencyKey; a == b || a == k1 {
		t.Fatalf("keys %q %q %q", k1, a, b)
	}

	// outside a tick: no activity, CLI from the config
	t.Setenv("AGENTBUS_IN_TICK", "")
	t.Setenv("AGENTBUS_CLI", "")
	n := len(h.activities)
	if code, _ := run(t, "post", "--body", "y"); code != 0 || len(h.activities) != n || h.posts[len(h.posts)-1].CLI != "claude" {
		t.Fatalf("%+v", h.posts[len(h.posts)-1])
	}

	// limits are checked before anything is uploaded
	big := filepath.Join(d, "big.bin")
	f, _ := os.Create(big)
	_ = f.Truncate(maxAttachmentSize + 1)
	f.Close()
	up := len(h.uploads)
	if code, out := run(t, "post", "--body", "x", "--attach", big); code != exitUsage || !strings.Contains(out, "10 MB") {
		t.Fatalf("%d %s", code, out)
	}
	if code, _ := run(t, "post", "--body", "x", "--attach", d); code != exitUsage {
		t.Fatal("directory accepted")
	}
	args := []string{"post", "--body", "x"}
	for i := 0; i < maxAttachments+1; i++ {
		args = append(args, "--attach", png)
	}
	if code, out := run(t, args...); code != exitUsage || !strings.Contains(out, "at most 6") {
		t.Fatalf("%d %s", code, out)
	}
	if code, _ := run(t, "post", "--body", "x", "--attach", filepath.Join(d, "missing")); code == 0 {
		t.Fatal("missing file accepted")
	}
	if len(h.uploads) != up {
		t.Fatal("uploaded despite limit errors")
	}
}

func TestFileGet(t *testing.T) {
	h, _ := joinedHub(t)
	h.files = map[string][]byte{"f_1": []byte("hello file")}
	h.listed = []hub.Post{{ID: "p_1", Attachments: []hub.Attachment{{ID: "f_1", Name: "../../etc/report.txt"}}}}
	t.Setenv("AGENTBUS_THREAD", "t_1")
	wd, _ := os.Getwd()
	d := t.TempDir()
	if err := os.Chdir(d); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	code, out := run(t, "file", "get", "f_1")
	if code != 0 || !strings.Contains(out, "saved f_1 (10 bytes) to report.txt") {
		t.Fatalf("%d %s", code, out)
	}
	if b, _ := os.ReadFile(filepath.Join(d, "report.txt")); string(b) != "hello file" {
		t.Fatal(string(b))
	}
	if code, out := run(t, "file", "get", "f_1"); code != exitErr || !strings.Contains(out, "--force") {
		t.Fatalf("overwrite: %d %s", code, out)
	}
	if code, _ := run(t, "file", "get", "f_1", "--force"); code != 0 {
		t.Fatal("force")
	}
	if code, out := run(t, "file", "get", "f_1", "-o", "-"); code != 0 || out != "hello file" {
		t.Fatalf("stdout: %d %q", code, out)
	}
	if code, out := run(t, "--json", "file", "get", "f_1", "-o", "x.bin"); code != 0 || !strings.Contains(out, `"size": 10`) {
		t.Fatalf("%d %s", code, out)
	}
	// unknown name outside a thread: the id is the file name
	t.Setenv("AGENTBUS_THREAD", "")
	if code, out := run(t, "file", "get", "f_1"); code != 0 || !strings.Contains(out, "to f_1") {
		t.Fatalf("by id: %s", out)
	}
	if _, err := os.Stat(filepath.Join(d, "f_1")); err != nil {
		t.Fatal(err)
	}
	if code, _ := run(t, "file", "get", "f_404", "-o", "-"); code == 0 {
		t.Fatal("missing attachment")
	}
	if code, _ := run(t, "file", "list"); code != exitUsage {
		t.Fatal("file list")
	}
}

func TestSafeFileName(t *testing.T) {
	for in, want := range map[string]string{"a.txt": "a.txt", "../../x": "x", `..\..\y.png`: "y.png", "/": "", "..": "",
		".hidden": "hidden", "a:b?c": "a_b_c", "x\x00y": "x_y"} {
		if got := safeFileName(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestDetectMime(t *testing.T) {
	if m := detectMime("a.PNG", nil); m != "image/png" {
		t.Fatal(m)
	}
	if m := detectMime("noext", []byte("%PDF-1.4 xx")); m != "application/pdf" {
		t.Fatal(m)
	}
}

func TestLangFlag(t *testing.T) {
	t.Setenv("AGENTBUS_LANG", "en")
	defer i18n.Set("en")
	rest, err := extractLang([]string{"--lang", "zh_CN", "post", "--", "--lang", "en"})
	if err != nil || strings.Join(rest, " ") != "post -- --lang en" || !i18n.IsZh() || os.Getenv("AGENTBUS_LANG") != "zh" {
		t.Fatal(rest, err)
	}
	if _, err := extractLang([]string{"--lang=fr"}); err == nil {
		t.Fatal("fr accepted")
	}
	if _, err := extractLang([]string{"--lang"}); err == nil {
		t.Fatal("missing value")
	}
	i18n.Set("en")
	code, out := run(t, "--lang", "zh", "help")
	if code != 0 || !strings.Contains(out, "用法") || !strings.Contains(out, "traecli") || !strings.Contains(out, "dsh") {
		t.Fatalf("%d %s", code, out)
	}
	i18n.Set("en")
	if code, out := run(t, "--lang=en", "help"); code != 0 || !strings.Contains(out, "usage: agentbus") ||
		!strings.Contains(out, "AGENTBUS_LANG") || !strings.Contains(out, "file get ID") {
		t.Fatalf("%d %s", code, out)
	}
}
