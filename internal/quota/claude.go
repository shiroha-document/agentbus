package quota

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Claude Code: the OAuth sign-in Claude Code keeps (macOS keychain item
// "Claude Code-credentials", else ~/.claude/.credentials.json; both under
// CLAUDE_CONFIG_DIR when set) asked for its 5-hour and weekly utilisation
// at the OAuth usage endpoint. The endpoint is undocumented: a reply that
// can't be read becomes a reading with Error "unknown: …".

type claudeProvider struct{}

func (claudeProvider) ID() string { return "claude" }

// claudeDir is Claude Code's config directory.
func claudeDir() string {
	if d := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// claudeAccountFile is where Claude Code keeps the signed-in account's
// profile (email, organisation): <dir>/.claude.json with CLAUDE_CONFIG_DIR,
// else ~/.claude.json.
func claudeAccountFile() string {
	if d := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); d != "" {
		return filepath.Join(d, ".claude.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude.json")
}

func (claudeProvider) Detect() bool {
	d := claudeDir()
	if d == "" {
		return false
	}
	if fileExists(filepath.Join(d, ".credentials.json")) {
		return true
	}
	return claudeKeychainAvailable() && dirExists(d)
}

type claudeOAuth struct {
	AccessToken      string `json:"accessToken"`
	ExpiresAt        int64  `json:"expiresAt"`
	SubscriptionType string `json:"subscriptionType"`
	RateLimitTier    string `json:"rateLimitTier"`
}

// parseClaudeCredentials reads {"claudeAiOauth":{…}}; the keychain may hold
// it hex-encoded.
func parseClaudeCredentials(b []byte) (claudeOAuth, bool) {
	b = keychainText([]byte(strings.TrimSpace(string(b))))
	var c struct {
		OAuth *claudeOAuth `json:"claudeAiOauth"`
	}
	if json.Unmarshal(b, &c) != nil || c.OAuth == nil || c.OAuth.AccessToken == "" {
		return claudeOAuth{}, false
	}
	return *c.OAuth, true
}

// keychainText decodes `security -w` output that came back hex-encoded
// (it does so for a value with bytes it won't print).
func keychainText(out []byte) []byte {
	if len(out) == 0 || len(out)%2 != 0 || out[0] == '{' {
		return out
	}
	b, err := hex.DecodeString(string(out))
	if err != nil || !json.Valid(b) {
		return out
	}
	return b
}

// claudeCredentials finds the sign-in: the keychain first on a Mac, as
// Claude Code does, then the file.
func claudeCredentials(ctx context.Context) (claudeOAuth, bool) {
	if b, ok := claudeKeychainRead(ctx, claudeDir()); ok {
		if c, ok := parseClaudeCredentials(b); ok {
			return c, true
		}
	}
	b, err := readSmallFile(filepath.Join(claudeDir(), ".credentials.json"))
	if err != nil {
		return claudeOAuth{}, false
	}
	return parseClaudeCredentials(b)
}

func claudeAccount() string {
	b, err := readSmallFile(claudeAccountFile())
	if err != nil {
		return ""
	}
	var c struct {
		OAuthAccount struct {
			Email string `json:"emailAddress"`
		} `json:"oauthAccount"`
	}
	if json.Unmarshal(b, &c) != nil {
		return ""
	}
	return strings.TrimSpace(c.OAuthAccount.Email)
}

func (claudeProvider) Read(ctx context.Context) ([]Reading, error) {
	c, ok := claudeCredentials(ctx)
	if !ok {
		return nil, errNotLoggedIn
	}
	now := nowFrom(ctx)
	if c.ExpiresAt > 0 && time.UnixMilli(c.ExpiresAt).Before(now) {
		// refreshing would rotate Claude Code's own refresh token under it
		return nil, errors.New("token expired")
	}
	b, err := doJSON(ctx, "GET", claudeUsageURL, map[string]string{
		"Authorization":  "Bearer " + c.AccessToken,
		"anthropic-beta": "oauth-2025-04-20",
	}, nil)
	if err != nil {
		return nil, unknownErr(err)
	}
	rs, err := parseClaudeUsage(b)
	if err != nil {
		return nil, unknownErr(err)
	}
	acct, plan := claudeAccount(), strings.ToLower(strings.TrimSpace(c.SubscriptionType))
	for i := range rs {
		rs[i].Account, rs[i].Plan = acct, plan
		rs[i].ReadAt = now.UnixMilli()
	}
	return rs, nil
}

// claudeWindows are the usage reply's keys and the hub's window names.
var claudeWindows = []struct{ key, window string }{
	{"five_hour", "5h"},
	{"seven_day", "7d"},
	{"seven_day_opus", "7d_opus"},
	{"seven_day_sonnet", "7d_sonnet"},
	{"seven_day_oauth_apps", "7d_oauth_apps"},
	{"seven_day_overage_included", "7d_fable"},
}

// parseClaudeUsage reads
//
//	{"five_hour":{"utilization":12.0,"resets_at":"2026-10-20T15:00:00Z"},
//	 "seven_day":{…},"seven_day_opus":null,…}
//
// utilization is a percentage. A window that is null is not on the plan.
func parseClaudeUsage(b []byte) ([]Reading, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil || raw == nil {
		return nil, errBadReply
	}
	var out []Reading
	for _, w := range claudeWindows {
		v, ok := raw[w.key]
		if !ok || string(v) == "null" {
			continue
		}
		var x struct {
			Utilization any `json:"utilization"`
			ResetsAt    any `json:"resets_at"`
		}
		if json.Unmarshal(v, &x) != nil {
			continue
		}
		u, ok := number(x.Utilization)
		if !ok {
			continue
		}
		r := Reading{Window: w.window, UsedPct: f64(clampPct(u))}
		if t, ok := parseTime(x.ResetsAt); ok {
			r.ResetsAt = i64(t.UnixMilli())
		}
		out = append(out, r)
	}
	if len(out) == 0 {
		return nil, errBadReply
	}
	return out, nil
}

// number reads a JSON number, or a number written as a string.
func number(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	}
	return 0, false
}

// parseTime reads an RFC 3339 string or a Unix time (seconds or ms).
func parseTime(v any) (time.Time, bool) {
	switch x := v.(type) {
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return time.Time{}, false
		}
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t, true
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return unixAuto(n)
		}
	case float64:
		return unixAuto(int64(x))
	}
	return time.Time{}, false
}

// unixAuto reads n as seconds when it is below 1e12, else milliseconds.
func unixAuto(n int64) (time.Time, bool) {
	switch {
	case n <= 0:
		return time.Time{}, false
	case n < 1e12:
		return time.Unix(n, 0), true
	}
	return time.UnixMilli(n), true
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// readSmallFile reads a config file, refusing anything over 4 MiB.
func readSmallFile(p string) ([]byte, error) {
	if p == "" {
		return nil, os.ErrNotExist
	}
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if st.Size() > maxBody {
		return nil, errors.New("file too large")
	}
	return os.ReadFile(p)
}
