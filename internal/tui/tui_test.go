package tui

import (
	"bufio"
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/shiroha-document/agentbus/internal/i18n"
)

func TestMain(m *testing.M) {
	i18n.Set("en")
	m.Run()
}

func keys(t *testing.T, in string) []keyEvent {
	t.Helper()
	r := bufio.NewReader(strings.NewReader(in))
	var out []keyEvent
	for {
		k, err := readKey(r)
		if err != nil {
			return out
		}
		out = append(out, k)
	}
}

func TestReadKey(t *testing.T) {
	got := keys(t, "\x1b[A\x1b[B\x1bOA\x1bOB\x1b[H\x1b[F\x1b[1~\x1b[4~kj\x10\x0e3\r\n\x03\x04x\x1b[1;5C")
	want := []keyKind{keyUp, keyDown, keyUp, keyDown, keyHome, keyEnd, keyHome, keyEnd, keyUp, keyDown, keyUp, keyDown,
		keyDigit, keyEnter, keyEnter, keyCancel, keyCancel, keyNone, keyNone}
	if len(got) != len(want) {
		t.Fatalf("got %d keys: %+v", len(got), got)
	}
	for i, k := range got {
		if k.kind != want[i] {
			t.Errorf("key %d: %v want %v", i, k.kind, want[i])
		}
	}
	if got[12].digit != 3 {
		t.Fatal(got[12])
	}
}

func TestMenu(t *testing.T) {
	m := &menu{n: 3, cur: 0}
	step := func(k keyEvent) (bool, error) { return m.apply(k) }
	step(keyEvent{kind: keyUp})
	if m.cur != 2 {
		t.Fatal(m.cur)
	}
	step(keyEvent{kind: keyDown})
	if m.cur != 0 {
		t.Fatal(m.cur)
	}
	step(keyEvent{kind: keyEnd})
	step(keyEvent{kind: keyHome})
	if done, _ := step(keyEvent{kind: keyNone}); done || m.cur != 0 {
		t.Fatal(m.cur)
	}
	if done, _ := step(keyEvent{kind: keyDigit, digit: 9}); done {
		t.Fatal("digit out of range must be ignored")
	}
	if done, err := step(keyEvent{kind: keyDigit, digit: 2}); !done || err != nil || m.cur != 1 {
		t.Fatal(done, err, m.cur)
	}
	if done, err := step(keyEvent{kind: keyEnter}); !done || err != nil {
		t.Fatal(done, err)
	}
	if done, err := step(keyEvent{kind: keyCancel}); !done || !errors.Is(err, ErrInterrupted) {
		t.Fatal(done, err)
	}
}

var opts = []Option{{Value: "claude", Label: "Claude Code", Hint: "/bin/claude"}, {Value: "codex", Label: "Codex"}, {Value: "dsh"}}

func TestSelectLine(t *testing.T) {
	cases := []struct {
		in   string
		want int
		err  bool
	}{
		{"2\n", 1, false},
		{"codex\n", 1, false},
		{"claude code\n", 0, false},
		{"DSH", 2, false},
		{"\n", 1, false},
		{"", 1, false},
		{"nope\n3\n", 2, false},
		{"nope", 0, true},
		{"9\n1\n", 0, false},
	}
	for _, c := range cases {
		var out bytes.Buffer
		u := New(strings.NewReader(c.in), &out)
		if u.Interactive() {
			t.Fatal("buffers must not be interactive")
		}
		i, err := u.Select("Pick", opts, 1)
		if (err != nil) != c.err || (!c.err && i != c.want) {
			t.Errorf("%q: %d %v", c.in, i, err)
		}
		if !strings.Contains(out.String(), " * 2) Codex") || !strings.Contains(out.String(), "1) Claude Code  — /bin/claude") {
			t.Errorf("listing: %q", out.String())
		}
	}
	if _, err := New(strings.NewReader(""), &bytes.Buffer{}).Select("x", nil, 0); err == nil {
		t.Fatal("no options must fail")
	}
	// out-of-range default clamps to 0
	if i, _ := New(strings.NewReader("\n"), &bytes.Buffer{}).Select("x", opts, 7); i != 0 {
		t.Fatal(i)
	}
}

func TestSessionKeepsBufferedInput(t *testing.T) {
	u := New(strings.NewReader("codex\nmy answer\ny\n"), &bytes.Buffer{})
	if i, _ := u.Select("a", opts, 0); i != 1 {
		t.Fatal(i)
	}
	if s, _ := u.Input("b", "def"); s != "my answer" {
		t.Fatal(s)
	}
	if ok, _ := u.Confirm("c", false); !ok {
		t.Fatal("confirm")
	}
	if s, _ := u.Input("d", "def"); s != "def" {
		t.Fatal(s)
	}
}

func TestParseYes(t *testing.T) {
	for in, want := range map[string]bool{"y": true, "YES": true, "是": true, "好": true, "n": false, "No": false, "否": false, "不要": false} {
		if parseYes(in, !want) != want {
			t.Errorf("%q", in)
		}
	}
	if !parseYes("", true) || parseYes("", false) || !parseYes("maybe", true) {
		t.Fatal("default")
	}
}

func TestRender(t *testing.T) {
	u := &UI{color: true}
	s := u.render(opts, 1)
	lines := strings.Split(strings.TrimSuffix(s, "\r\n"), "\r\n")
	if len(lines) != 3 || !strings.Contains(lines[1], "❯ 2. Codex") || !strings.Contains(lines[1], ansiCyan) ||
		!strings.Contains(lines[0], "  1. Claude Code") || !strings.Contains(lines[0], ansiDim+"/bin/claude") {
		t.Fatalf("%q", lines)
	}
	u.color = false
	if strings.Contains(u.render(opts, 0), "\x1b[3") {
		t.Fatal("colour without color")
	}
}
