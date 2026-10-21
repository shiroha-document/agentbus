// Package tui has small interactive prompts for the CLI: an arrow-key menu
// (Select), a yes/no question (Confirm) and a line of text (Input).
//
// On a terminal, Select puts stdin in raw mode (termios on unix, console
// mode with VT input/processing on Windows) and draws a highlighted menu that
// reacts to ↑/↓, j/k, the number keys 1-9 and Enter; Ctrl-C cancels. When
// stdin or stdout is not a terminal (pipes, tests, CI), every prompt falls
// back to plain line input: Select prints a numbered list and accepts a
// number or the option's value/label.
package tui

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/shiroha-document/agentbus/internal/i18n"
)

// ErrInterrupted is returned when the user pressed Ctrl-C (or Ctrl-D /
// end of input in a menu).
var ErrInterrupted = errors.New("interrupted")

// Option is one menu entry. Value is what non-interactive input may type;
// Label is shown; Hint is dimmed text after the label.
type Option struct {
	Value string
	Label string
	Hint  string
}

func (o Option) label() string { return firstNonEmpty(o.Label, o.Value) }

// UI is a prompt session over one input and one output. Use a single UI for
// a whole dialogue so buffered input is never lost between prompts.
type UI struct {
	in    *bufio.Reader
	out   io.Writer
	inF   *os.File
	tty   bool
	color bool
}

// New returns a UI reading in and writing out. It is interactive only when
// both are terminals.
func New(in io.Reader, out io.Writer) *UI {
	u := &UI{in: bufio.NewReader(in), out: out}
	fi, okIn := in.(*os.File)
	fo, okOut := out.(*os.File)
	if okIn && okOut && isTerminal(fi) && isTerminal(fo) && os.Getenv("TERM") != "dumb" {
		u.inF, u.tty = fi, true
		u.color = os.Getenv("NO_COLOR") == ""
	}
	return u
}

// Interactive reports whether menus use raw-mode key handling.
func (u *UI) Interactive() bool { return u.tty }

var (
	stdOnce sync.Once
	std     *UI
)

// Std is the shared UI on os.Stdin / os.Stdout.
func Std() *UI {
	stdOnce.Do(func() { std = New(os.Stdin, os.Stdout) })
	return std
}

// Select asks on stdin/stdout; see UI.Select.
func Select(title string, options []Option, def int) (int, error) {
	return Std().Select(title, options, def)
}

// Confirm asks on stdin/stdout; see UI.Confirm.
func Confirm(q string, def bool) (bool, error) { return Std().Confirm(q, def) }

// Input asks on stdin/stdout; see UI.Input.
func Input(q, def string) (string, error) { return Std().Input(q, def) }

// Select shows options and returns the chosen index. def is preselected
// (clamped into range).
func (u *UI) Select(title string, options []Option, def int) (int, error) {
	if len(options) == 0 {
		return -1, errors.New("tui: no options")
	}
	if def < 0 || def >= len(options) {
		def = 0
	}
	if u.tty {
		restore, err := makeRaw(u.inF)
		if err == nil {
			i, err := u.selectRaw(title, options, def)
			restore()
			return i, err
		}
		// raw mode unavailable (old Windows console…): plain list
	}
	return u.selectLine(title, options, def)
}

// selectLine is the non-interactive menu: a numbered list and one line of
// input (number, value or label; empty = default). Invalid answers are asked
// again; end of input takes the default when nothing was typed.
func (u *UI) selectLine(title string, options []Option, def int) (int, error) {
	fmt.Fprintln(u.out, title)
	for i, o := range options {
		mark := " "
		if i == def {
			mark = "*"
		}
		line := fmt.Sprintf(" %s %d) %s", mark, i+1, o.label())
		if o.Hint != "" {
			line += "  — " + o.Hint
		}
		fmt.Fprintln(u.out, line)
	}
	for {
		fmt.Fprintf(u.out, "%s [%s]: ", i18n.Pick("choose", "请选择"), options[def].label())
		line, err := u.in.ReadString('\n')
		ans := strings.TrimSpace(line)
		if ans == "" {
			if err != nil && line == "" && !errors.Is(err, io.EOF) {
				return -1, err
			}
			return def, nil
		}
		if i, ok := matchOption(options, ans); ok {
			return i, nil
		}
		fmt.Fprintf(u.out, "%s %q\n", i18n.Pick("not an option:", "无效选项："), ans)
		if err != nil {
			return -1, fmt.Errorf("%s %q", i18n.Pick("not an option:", "无效选项："), ans)
		}
	}
}

// matchOption maps typed text to an option: 1-based number, else value or
// label (case-insensitive).
func matchOption(options []Option, ans string) (int, bool) {
	if n, err := strconv.Atoi(ans); err == nil && n >= 1 && n <= len(options) {
		return n - 1, true
	}
	for i, o := range options {
		if strings.EqualFold(ans, o.Value) || strings.EqualFold(ans, o.Label) {
			return i, true
		}
	}
	return -1, false
}

// ---- raw-mode menu ----

type keyKind int

const (
	keyNone keyKind = iota
	keyUp
	keyDown
	keyHome
	keyEnd
	keyEnter
	keyCancel
	keyDigit
)

type keyEvent struct {
	kind  keyKind
	digit int // 1-9 for keyDigit
}

// readKey decodes one key press from r: arrows (ESC [ A / ESC O A …), j/k,
// digits, Enter, Ctrl-C / Ctrl-D. Unknown input is keyNone.
func readKey(r *bufio.Reader) (keyEvent, error) {
	b, err := r.ReadByte()
	if err != nil {
		return keyEvent{}, err
	}
	switch {
	case b == 3 || b == 4: // Ctrl-C, Ctrl-D
		return keyEvent{kind: keyCancel}, nil
	case b == '\r' || b == '\n':
		return keyEvent{kind: keyEnter}, nil
	case b == 'k' || b == 'K' || b == 16: // Ctrl-P
		return keyEvent{kind: keyUp}, nil
	case b == 'j' || b == 'J' || b == 14: // Ctrl-N
		return keyEvent{kind: keyDown}, nil
	case b >= '1' && b <= '9':
		return keyEvent{kind: keyDigit, digit: int(b - '0')}, nil
	case b == 0x1b:
		if r.Buffered() == 0 {
			return keyEvent{}, nil // lone Esc
		}
		b2, err := r.ReadByte()
		if err != nil || (b2 != '[' && b2 != 'O') {
			return keyEvent{}, err
		}
		// CSI: parameters then a final byte in 0x40..0x7e
		var params []byte
		for {
			c, err := r.ReadByte()
			if err != nil {
				return keyEvent{}, err
			}
			if c >= 0x40 && c <= 0x7e {
				switch {
				case c == 'A':
					return keyEvent{kind: keyUp}, nil
				case c == 'B':
					return keyEvent{kind: keyDown}, nil
				case c == 'H' || (c == '~' && (string(params) == "1" || string(params) == "7")):
					return keyEvent{kind: keyHome}, nil
				case c == 'F' || (c == '~' && (string(params) == "4" || string(params) == "8")):
					return keyEvent{kind: keyEnd}, nil
				}
				return keyEvent{}, nil
			}
			if len(params) < 8 {
				params = append(params, c)
			}
		}
	}
	return keyEvent{}, nil
}

// menu is the Select state machine, independent of the terminal.
type menu struct {
	n, cur int
}

// apply moves the cursor or finishes. done with err == nil means cur is
// the choice.
func (m *menu) apply(k keyEvent) (done bool, err error) {
	switch k.kind {
	case keyUp:
		m.cur = (m.cur - 1 + m.n) % m.n
	case keyDown:
		m.cur = (m.cur + 1) % m.n
	case keyHome:
		m.cur = 0
	case keyEnd:
		m.cur = m.n - 1
	case keyDigit:
		if k.digit <= m.n {
			m.cur = k.digit - 1
			return true, nil
		}
	case keyEnter:
		return true, nil
	case keyCancel:
		return true, ErrInterrupted
	}
	return false, nil
}

const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiDim    = "\x1b[2m"
	ansiCyan   = "\x1b[36m"
	ansiGreen  = "\x1b[32m"
	clearLine  = "\r\x1b[2K"
	hideCursor = "\x1b[?25l"
	showCursor = "\x1b[?25h"
)

func (u *UI) paint(codes, s string) string {
	if !u.color {
		return s
	}
	return codes + s + ansiReset
}

// render returns the menu body (one line per option).
func (u *UI) render(options []Option, cur int) string {
	var b strings.Builder
	for i, o := range options {
		b.WriteString(clearLine)
		num := ""
		if i < 9 {
			num = strconv.Itoa(i+1) + ". "
		}
		if i == cur {
			b.WriteString(u.paint(ansiCyan+ansiBold, "❯ "+num+o.label()))
		} else {
			b.WriteString("  " + num + o.label())
		}
		if o.Hint != "" {
			b.WriteString("  " + u.paint(ansiDim, o.Hint))
		}
		b.WriteString("\r\n")
	}
	return b.String()
}

func (u *UI) selectRaw(title string, options []Option, def int) (int, error) {
	m := &menu{n: len(options), cur: def}
	help := i18n.Pick("↑/↓ to move, Enter to select, Ctrl-C to cancel", "↑/↓ 移动，回车确认，Ctrl-C 取消")
	fmt.Fprint(u.out, hideCursor+clearLine+u.paint(ansiBold, title)+"  "+u.paint(ansiDim, help)+"\r\n")
	fmt.Fprint(u.out, u.render(options, m.cur))
	finish := func() {
		// replace the menu with a one-line summary
		fmt.Fprintf(u.out, "\x1b[%dA", len(options)+1)
		for range len(options) + 1 {
			fmt.Fprint(u.out, clearLine+"\x1b[1B")
		}
		fmt.Fprintf(u.out, "\x1b[%dA", len(options)+1)
		fmt.Fprint(u.out, showCursor)
	}
	for {
		k, err := readKey(u.in)
		if err != nil {
			finish()
			return -1, ErrInterrupted
		}
		done, err := m.apply(k)
		if done {
			finish()
			if err != nil {
				fmt.Fprint(u.out, clearLine+u.paint(ansiBold, title)+"  "+u.paint(ansiDim, "^C")+"\r\n")
				return -1, err
			}
			fmt.Fprint(u.out, clearLine+u.paint(ansiBold, title)+"  "+u.paint(ansiGreen, options[m.cur].label())+"\r\n")
			return m.cur, nil
		}
		fmt.Fprintf(u.out, "\x1b[%dA", len(options))
		fmt.Fprint(u.out, u.render(options, m.cur))
	}
}

// ---- line prompts ----

// Input asks for one line; empty input (or end of input) returns def.
func (u *UI) Input(q, def string) (string, error) {
	if def != "" {
		fmt.Fprintf(u.out, "%s [%s]: ", u.paint(ansiBold, q), def)
	} else {
		fmt.Fprintf(u.out, "%s: ", u.paint(ansiBold, q))
	}
	line, err := u.in.ReadString('\n')
	if line = strings.TrimSpace(line); line == "" {
		if err != nil && !errors.Is(err, io.EOF) {
			return def, err
		}
		return def, nil
	}
	return line, nil
}

// Confirm asks a yes/no question; empty input returns def. y/yes/是/好
// count as yes, n/no/否/不 as no.
func (u *UI) Confirm(q string, def bool) (bool, error) {
	d := "Y/n"
	if !def {
		d = "y/N"
	}
	a, err := u.Input(q+" ("+d+")", "")
	if err != nil {
		return def, err
	}
	return parseYes(a, def), nil
}

func parseYes(a string, def bool) bool {
	a = strings.ToLower(strings.TrimSpace(a))
	switch {
	case a == "":
		return def
	case strings.HasPrefix(a, "y"), a == "是", a == "好", a == "对", a == "确认":
		return true
	case strings.HasPrefix(a, "n"), strings.HasPrefix(a, "否"), strings.HasPrefix(a, "不"):
		return false
	}
	return def
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// IsTerminal reports whether f is a terminal.
func IsTerminal(f *os.File) bool { return f != nil && isTerminal(f) }
