package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// magpie (github.com/yetone/magpie) reads many more providers than the
// native readers. Its `magpie quota --json` prints a JSON array of its
// provider.Quota cards (internal/provider/quotas.go), which magpieReadings
// turns into Readings.

// magpieArgs is the command run: `magpie quota --json`.
var magpieArgs = []string{"quota", "--json"}

// magpieMaxOutput caps how much of magpie's output is read.
const magpieMaxOutput = 8 << 20

// runMagpie runs the binary and returns its stdout; tests replace it.
var runMagpie = func(ctx context.Context, bin string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	var out limitedBuffer
	out.max = magpieMaxOutput
	cmd.Stdout = &out
	cmd.Stderr = nil // magpie's diagnostics may name accounts: not kept
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	return out.Bytes(), err
}

type limitedBuffer struct {
	bytes.Buffer
	max int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		if len(p) > room {
			b.Buffer.Write(p[:room])
		} else {
			b.Buffer.Write(p)
		}
	}
	return len(p), nil
}

// magpieBinary finds magpie: opt.MagpiePath, else PATH; "" when absent.
func magpieBinary(opt Options) string {
	if p := strings.TrimSpace(opt.MagpiePath); p != "" {
		if fileExists(p) {
			return p
		}
		if q, err := lookPath(p); err == nil {
			return q
		}
		return ""
	}
	if p, err := lookPath("magpie"); err == nil {
		return p
	}
	return ""
}

// collectMagpie runs magpie and converts its report. A missing binary, a
// failed run or output that isn't magpie's JSON all give no readings.
func collectMagpie(ctx context.Context, opt Options) []Reading {
	bin := magpieBinary(opt)
	if bin == "" {
		return nil
	}
	// magpie exits non-zero when a card failed but still prints the
	// report, so the output is used whatever the exit status
	out, _ := runMagpie(ctx, bin, magpieArgs...)
	if len(out) == 0 {
		return nil
	}
	rs, err := magpieReadings(out, opt.Now())
	if err != nil {
		return nil
	}
	return rs
}

// magpieQuota is the part of magpie's provider.Quota that is used.
type magpieQuota struct {
	Provider string       `json:"provider"`
	Name     string       `json:"name"`
	Kind     string       `json:"kind"`
	Plan     string       `json:"plan"`
	User     string       `json:"user"`
	Windows  []magpieSpan `json:"windows"`
	Balance  string       `json:"balance"`
	Error    string       `json:"error"`
	AsOf     *time.Time   `json:"asOf"`
	ReadAt   *time.Time   `json:"readAt"`
}

type magpieSpan struct {
	Unlimited bool       `json:"unlimited"`
	Name      string     `json:"name"`
	Used      float64    `json:"used"`
	Remaining *float64   `json:"remaining"`
	ResetsAt  *time.Time `json:"resetsAt"`
}

// magpieReadings converts `magpie quota --json` output.
func magpieReadings(out []byte, now time.Time) ([]Reading, error) {
	i := bytes.IndexByte(out, '[')
	if i < 0 {
		return nil, errBadReply
	}
	var qs []magpieQuota
	if err := json.NewDecoder(bytes.NewReader(out[i:])).Decode(&qs); err != nil {
		return nil, errBadReply
	}
	var rs []Reading
	for _, q := range qs {
		rs = append(rs, magpieQuotaReadings(q, now)...)
	}
	return rs, nil
}

func magpieQuotaReadings(q magpieQuota, now time.Time) []Reading {
	id := strings.ToLower(strings.TrimSpace(q.Provider))
	if id == "" {
		return nil
	}
	at := now
	switch {
	case q.AsOf != nil && !q.AsOf.IsZero():
		at = *q.AsOf // a kept reading: its own time
	case q.ReadAt != nil && !q.ReadAt.IsZero():
		at = *q.ReadAt
	}
	base := Reading{
		Provider: id,
		Account:  sanitizeAccount(q.User),
		Plan:     strings.ToLower(strings.TrimSpace(q.Plan)),
		Source:   SourceMagpie,
		ReadAt:   at.UnixMilli(),
	}
	var out []Reading
	for _, w := range q.Windows {
		if w.Unlimited {
			continue
		}
		r := base
		r.Window = normWindow(w.Name)
		r.UsedPct = f64(clampPct(w.Used))
		if w.ResetsAt != nil && !w.ResetsAt.IsZero() {
			r.ResetsAt = i64(w.ResetsAt.UnixMilli())
		}
		out = append(out, r)
	}
	if b, ok := parseMoney(q.Balance); ok {
		r := base
		r.Window = windowBalance
		r.Balance = b
		out = append(out, r)
	}
	if len(out) == 0 && strings.TrimSpace(q.Error) != "" {
		r := base
		r.Window = WindowAll
		if q.Kind == "balance" {
			r.Window = windowBalance
		}
		r.Error = sanitize(q.Error)
		if r.Error == "" {
			r.Error = "unknown"
		}
		out = append(out, r)
	}
	return out
}

// sanitizeAccount keeps an account label short and printable.
func sanitizeAccount(s string) string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s))
	if r := []rune(s); len(r) > 120 {
		s = string(r[:120])
	}
	return s
}

var reMoney = regexp.MustCompile(`^([+-]?)\s*([^\d\s+.,-]*)\s*([+-]?)\s*([\d][\d,]*(?:\.\d+)?|\.\d+)\s*([kKmM]?)\s*(.*)$`)

var currencySigns = map[string]string{
	"$": "USD", "US$": "USD", "¥": "CNY", "￥": "CNY", "CN¥": "CNY", "RMB": "CNY",
	"€": "EUR", "£": "GBP", "₹": "INR", "₩": "KRW", "HK$": "HKD", "A$": "AUD", "C$": "CAD",
}

// parseMoney reads a magpie balance display string: "$12.34", "-$1.50",
// "¥5.00", "EUR 3.20", "1.2K credits".
func parseMoney(s string) (*Balance, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	m := reMoney.FindStringSubmatch(s)
	if m == nil {
		return nil, false
	}
	n, err := strconv.ParseFloat(strings.ReplaceAll(m[4], ",", ""), 64)
	if err != nil {
		return nil, false
	}
	switch m[5] {
	case "k", "K":
		n *= 1e3
	case "m", "M":
		n *= 1e6
	}
	if m[1] == "-" || m[3] == "-" {
		n = -n
	}
	cur := ""
	if pre := strings.TrimSpace(m[2]); pre != "" {
		if c, ok := currencySigns[strings.ToUpper(pre)]; ok {
			cur = c
		} else if c, ok := currencySigns[pre]; ok {
			cur = c
		} else if isCode(pre) {
			cur = strings.ToUpper(pre)
		} else {
			return nil, false
		}
	}
	if post := strings.TrimSpace(m[6]); post != "" {
		if i := strings.IndexAny(post, " ·(,;"); i > 0 {
			post = post[:i]
		}
		switch {
		case cur != "":
		case currencySigns[strings.ToUpper(post)] != "":
			cur = currencySigns[strings.ToUpper(post)]
		case isCode(post):
			cur = strings.ToUpper(post)
		default:
			cur = strings.ToLower(post) // "credits", "tokens"
		}
	}
	if cur == "" {
		return nil, false
	}
	return &Balance{Amount: n, Currency: cur}, true
}

func isCode(s string) bool {
	if len(s) != 3 {
		return false
	}
	for _, r := range s {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}
