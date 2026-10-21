package quota

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// GitHub Copilot: the sign-in the editors' plugins (apps.json / hosts.json)
// or the Copilot CLI (config.json) keep on disk is a GitHub OAuth token, and
// GET /copilot_internal/user tells it the plan and the month's chat,
// completions and premium-request quotas. Endpoint, headers and reply shape
// follow magpie's subscription_usage.go and copilot_*.go (THIRD_PARTY.md).
// Tokens kept only in the OS keychain are not read.

type copilotProvider struct{}

func (copilotProvider) ID() string { return "copilot" }
func (copilotProvider) Detect() bool {
	tok, _ := copilotToken()
	return tok != ""
}

func (copilotProvider) Read(ctx context.Context) ([]Reading, error) {
	tok, user := copilotToken()
	if tok == "" {
		return nil, errNotLoggedIn
	}
	b, err := doJSON(ctx, "GET", copilotUserURL, map[string]string{
		"Authorization":          "token " + tok,
		"Accept":                 "application/json",
		"Editor-Version":         "vscode/1.140.0",
		"Editor-Plugin-Version":  "copilot-chat/0.68.0",
		"Copilot-Integration-Id": "vscode-chat",
		"User-Agent":             "GitHubCopilotChat/0.68.0",
	}, nil)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), tok))
	}
	rs, err := parseCopilot(b)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), tok))
	}
	for i := range rs {
		rs[i].Account = sanitizeAccount(user)
	}
	return rs, nil
}

func xdgConfigHome() string {
	if d := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config")
}

func copilotCLIDir() string {
	if d := strings.TrimSpace(os.Getenv("COPILOT_HOME")); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".copilot")
}

// copilotToken is the first github.com Copilot sign-in found: the editor
// plugins' apps.json, then hosts.json, then the Copilot CLI's config.json.
func copilotToken() (token, user string) {
	if d := xdgConfigHome(); d != "" {
		for _, name := range []string{"apps.json", "hosts.json"} {
			if t, u := copilotPluginToken(filepath.Join(d, "github-copilot", name)); t != "" {
				return t, u
			}
		}
	}
	if d := copilotCLIDir(); d != "" {
		return copilotCLIToken(filepath.Join(d, "config.json"))
	}
	return "", ""
}

// copilotPluginToken reads {"github.com[:client id]":{"user":"…","oauth_token":"…"}}.
func copilotPluginToken(path string) (token, user string) {
	b, err := readSmallFile(path)
	if err != nil {
		return "", ""
	}
	var m map[string]struct {
		User  string `json:"user"`
		Token string `json:"oauth_token"`
	}
	if json.Unmarshal(b, &m) != nil {
		return "", ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !strings.HasPrefix(strings.ToLower(k), "github.com") {
			continue
		}
		if t := strings.TrimSpace(m[k].Token); t != "" {
			return t, m[k].User
		}
	}
	return "", ""
}

// copilotCLIToken reads the Copilot CLI's config: the last signed-in user
// first, then the others, each one's token under
// copilotTokens["https://github.com:<login>"]. Only github.com sign-ins.
func copilotCLIToken(path string) (token, user string) {
	b, err := readSmallFile(path)
	if err != nil {
		return "", ""
	}
	type login struct {
		Host  string `json:"host"`
		Login string `json:"login"`
	}
	var c struct {
		Last   *login            `json:"lastLoggedInUser"`
		Users  []login           `json:"loggedInUsers"`
		Tokens map[string]string `json:"copilotTokens"`
	}
	if json.Unmarshal(b, &c) != nil {
		return "", ""
	}
	users := c.Users
	if c.Last != nil {
		users = append([]login{*c.Last}, users...)
	}
	for _, u := range users {
		host := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(u.Host)), "/")
		host = strings.TrimPrefix(host, "https://")
		if host != "" && host != "github.com" || u.Login == "" {
			continue
		}
		if t := strings.TrimSpace(c.Tokens["https://github.com:"+u.Login]); t != "" {
			return t, u.Login
		}
	}
	return "", ""
}

var copilotPlanNames = map[string]string{
	"free": "Free", "individual": "Pro", "individual_pro": "Pro+", "individual_max": "Max",
	"individual_edu": "Education", "business": "Business", "enterprise": "Enterprise",
}

func copilotPlanName(plan, sku string) string {
	switch strings.ToLower(strings.TrimSpace(sku)) {
	case "free_educational_quota":
		return "Education"
	case "free_limited_copilot":
		return "Free"
	}
	p := strings.ToLower(strings.TrimSpace(plan))
	if n, ok := copilotPlanNames[p]; ok {
		return n
	}
	if p == "" {
		return ""
	}
	return strings.ToUpper(p[:1]) + p[1:]
}

// parseCopilot reads
//
//	{"copilot_plan":"individual","access_type_sku":"…",
//	 "quota_reset_date_utc":"2026-11-01T00:00:00Z",
//	 "quota_snapshots":{"premium_interactions":{"entitlement":300,
//	   "remaining":120,"percent_remaining":40,"unlimited":false},
//	   "chat":{"unlimited":true},…}}
//
// one monthly window per capped snapshot: "premium_monthly",
// "chat_monthly", "completions_monthly".
func parseCopilot(b []byte) ([]Reading, error) {
	type snap struct {
		Entitlement any   `json:"entitlement"`
		Remaining   any   `json:"remaining"`
		PctLeft     any   `json:"percent_remaining"`
		Unlimited   bool  `json:"unlimited"`
		HasQuota    *bool `json:"has_quota"`
		ResetAt     any   `json:"quota_reset_at"`
	}
	var r struct {
		Plan      string           `json:"copilot_plan"`
		SKU       string           `json:"access_type_sku"`
		ResetUTC  string           `json:"quota_reset_date_utc"`
		ResetDate string           `json:"quota_reset_date"`
		Snapshots map[string]*snap `json:"quota_snapshots"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	plan := copilotPlanName(r.Plan, r.SKU)
	var reset *int64
	if t, ok := parseTime(r.ResetUTC); ok {
		reset = i64(t.UnixMilli())
	} else if t, err := time.Parse("2006-01-02", strings.TrimSpace(r.ResetDate)); err == nil {
		reset = i64(t.UnixMilli())
	}
	var out []Reading
	for _, x := range []struct{ key, window string }{
		{"premium_interactions", "premium_monthly"}, {"chat", "chat_monthly"}, {"completions", "completions_monthly"},
	} {
		s := r.Snapshots[x.key]
		if s == nil {
			continue
		}
		rd := Reading{Window: x.window, Plan: plan, ResetsAt: reset}
		if t, ok := parseTime(s.ResetAt); ok {
			rd.ResetsAt = i64(t.UnixMilli())
		}
		switch {
		case s.Unlimited:
			// an unlimited premium snapshot without a quota is a plan
			// that has none to spend
			if x.key != "premium_interactions" || s.HasQuota == nil || *s.HasQuota {
				continue
			}
			rd.UsedPct = f64(100)
		default:
			ent, ok := number(s.Entitlement)
			if !ok || ent <= 0 {
				continue
			}
			if rem, ok := number(s.Remaining); ok {
				rd.UsedPct = f64(clampPct((ent - rem) / ent * 100))
			} else if left, ok := number(s.PctLeft); ok {
				rd.UsedPct = f64(clampPct(100 - left))
			} else {
				continue
			}
		}
		out = append(out, rd)
	}
	if len(out) == 0 {
		return nil, errors.New("no capped quota in the reply")
	}
	return out, nil
}
