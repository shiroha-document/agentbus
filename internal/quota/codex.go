package quota

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Codex: the rate limits Codex writes into its own session logs. Every
// turn's token_count event in $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
// carries payload.rate_limits {primary, secondary}, each {used_percent,
// window_minutes, resets_at | resets_in_seconds}. The newest one is the
// reading, timed at its event, so an old session reads as old (the hub
// shows read_at).

type codexProvider struct{}

func (codexProvider) ID() string { return "codex" }

func codexHome() string {
	if d := strings.TrimSpace(os.Getenv("CODEX_HOME")); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

func (codexProvider) Detect() bool {
	h := codexHome()
	return h != "" && (fileExists(filepath.Join(h, "auth.json")) || dirExists(filepath.Join(h, "sessions")))
}

// codexScanFiles bounds how many of the newest rollouts are looked at, and
// codexTail how much of the end of each is read.
const (
	codexScanFiles = 8
	codexTail      = 1 << 20
)

func (codexProvider) Read(ctx context.Context) ([]Reading, error) {
	h := codexHome()
	files := newestRollouts(filepath.Join(h, "sessions"), codexScanFiles)
	now := nowFrom(ctx)
	for _, f := range files {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		rs, ok := readRolloutLimits(f, now)
		if !ok {
			continue
		}
		acct, plan := codexIdentity(h)
		for i := range rs {
			rs[i].Account = acct
			if rs[i].Plan == "" {
				rs[i].Plan = plan
			}
		}
		return rs, nil
	}
	// signed in with an API key, or no turn taken yet: nothing to tell
	return nil, errNotLoggedIn
}

// newestRollouts lists up to n rollout files, newest first, walking the
// YYYY/MM/DD tree from its latest day so old sessions are never listed.
func newestRollouts(root string, n int) []string {
	type file struct {
		path string
		mod  time.Time
	}
	var out []file
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		es, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		sort.Slice(es, func(i, j int) bool { return es[i].Name() > es[j].Name() })
		var day []file
		for _, e := range es {
			if len(out) >= n {
				return
			}
			p := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if depth < 4 {
					walk(p, depth+1)
				}
				continue
			}
			if strings.HasPrefix(e.Name(), "rollout-") && strings.HasSuffix(e.Name(), ".jsonl") {
				if info, err := e.Info(); err == nil {
					day = append(day, file{p, info.ModTime()})
				}
			}
		}
		sort.SliceStable(day, func(i, j int) bool { return day[i].mod.After(day[j].mod) })
		for _, f := range day {
			if len(out) >= n {
				return
			}
			out = append(out, f)
		}
	}
	walk(root, 0)
	sort.SliceStable(out, func(i, j int) bool { return out[i].mod.After(out[j].mod) })
	paths := make([]string, len(out))
	for i, f := range out {
		paths[i] = f.path
	}
	return paths
}

type codexWindow struct {
	UsedPercent     *float64 `json:"used_percent"`
	WindowMinutes   float64  `json:"window_minutes"`
	ResetsAt        any      `json:"resets_at"`
	ResetsInSeconds *float64 `json:"resets_in_seconds"`
}

type codexLine struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type       string `json:"type"`
		RateLimits *struct {
			Primary   *codexWindow `json:"primary"`
			Secondary *codexWindow `json:"secondary"`
			PlanType  string       `json:"plan_type"`
			LimitID   string       `json:"limit_id"`
		} `json:"rate_limits"`
	} `json:"payload"`
}

var (
	tokenCountMark = []byte(`"token_count"`)
	rateLimitsMark = []byte(`"rate_limits"`)
)

// readRolloutLimits reads the last token_count event with rate limits in
// the tail of one rollout file.
func readRolloutLimits(path string, now time.Time) ([]Reading, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, false
	}
	if st.Size() > codexTail {
		if _, err := f.Seek(st.Size()-codexTail, io.SeekStart); err != nil {
			return nil, false
		}
	}
	return parseRollout(f, st.ModTime(), now)
}

// parseRollout scans a rollout's lines for the last usable token_count
// event. fallback times an event without a timestamp.
func parseRollout(r io.Reader, fallback, now time.Time) ([]Reading, bool) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	var last []Reading
	for sc.Scan() {
		b := sc.Bytes()
		if bytes.Contains(b, tokenCountMark) && bytes.Contains(b, rateLimitsMark) {
			if rs, ok := rolloutReadings(b, fallback, now); ok {
				last = rs // a later event wins
			}
		}
	}
	return last, len(last) > 0
}

func rolloutReadings(line []byte, fallback, now time.Time) ([]Reading, bool) {
	var l codexLine
	if json.Unmarshal(line, &l) != nil || l.Type != "event_msg" || l.Payload.Type != "token_count" || l.Payload.RateLimits == nil {
		return nil, false
	}
	rl := l.Payload.RateLimits
	if id := strings.ToLower(strings.TrimSpace(rl.LimitID)); id != "" && id != "codex" {
		return nil, false // a model's own allowance, not the account's
	}
	at := fallback
	if t, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
		at = t
	}
	var out []Reading
	for _, w := range []*codexWindow{rl.Primary, rl.Secondary} {
		if w == nil || w.UsedPercent == nil || w.WindowMinutes <= 0 {
			continue
		}
		r := Reading{
			Window:  spanWindow(roundSpan(time.Duration(w.WindowMinutes * float64(time.Minute)))),
			UsedPct: f64(clampPct(*w.UsedPercent)),
			Plan:    strings.ToLower(rl.PlanType),
			ReadAt:  at.UnixMilli(),
		}
		var reset time.Time
		if t, ok := parseTime(w.ResetsAt); ok {
			reset = t
		} else if w.ResetsInSeconds != nil && *w.ResetsInSeconds >= 0 {
			reset = at.Add(time.Duration(*w.ResetsInSeconds * float64(time.Second)))
		}
		if !reset.IsZero() {
			if reset.Before(now) {
				// the window has started again since: nothing used in it
				// that this log knows of
				r.UsedPct = f64(0)
			} else {
				r.ResetsAt = i64(reset.UnixMilli())
			}
		}
		out = append(out, r)
	}
	return out, len(out) > 0
}

// roundSpan snaps a window to whole hours or days when within a couple of
// minutes of one (Codex has reported 299 minutes for its 5-hour window).
func roundSpan(d time.Duration) time.Duration {
	for _, unit := range []time.Duration{24 * time.Hour, time.Hour} {
		n := math.Round(float64(d) / float64(unit))
		if n >= 1 && math.Abs(float64(d)-n*float64(unit)) <= float64(2*time.Minute) {
			return time.Duration(n) * unit
		}
	}
	return d
}

// codexIdentity reads the account email and plan from the ID token's claims
// in auth.json. The tokens themselves are not kept.
func codexIdentity(home string) (account, plan string) {
	b, err := readSmallFile(filepath.Join(home, "auth.json"))
	if err != nil {
		return "", ""
	}
	var a struct {
		Tokens *struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(b, &a) != nil || a.Tokens == nil {
		return "", ""
	}
	claims := jwtClaims(a.Tokens.IDToken)
	account, _ = claims["email"].(string)
	if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
		plan, _ = auth["chatgpt_plan_type"].(string)
	}
	return strings.TrimSpace(account), strings.ToLower(strings.TrimSpace(plan))
}

// jwtClaims decodes a JWT's payload without verifying it (it only names the
// account).
func jwtClaims(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}
