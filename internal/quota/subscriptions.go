package quota

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Plans bought with an API key whose windows the key can ask: Ollama
// Cloud's included allowance, OpenCode Go's usage limits and Command
// Code's credits. Endpoints and reply shapes follow magpie's
// ollama_usage.go, planquota.go and commandcode_plan.go (THIRD_PARTY.md).

// --- Ollama Cloud ---------------------------------------------------------

var ollamaKeys = keySource{env: []string{"OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY"}, hosts: []string{"ollama.com"}, extra: fromOpenCode("ollama-cloud")}

func readOllama(ctx context.Context, key string) ([]Reading, error) {
	b, err := doJSON(ctx, "GET", ollamaBalanceURL, map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return nil, err
	}
	return parseOllama(b)
}

// parseOllama reads
//
//	{"included":{"balance_usd":72.5,"allowance_usd":100,
//	   "period":{"from":"…","until":"…"},
//	   "session":{"remaining_percent":75,"resets_at":"…"},
//	   "weekly":{"remaining_percent":40,"resets_at":"…"}},
//	 "purchased":{"balance_usd":25}}
//
// session and weekly are the plan's rate windows ("session", "7d"); the
// allowance is the period's included dollars ("monthly" when the period is
// a month); purchased is money bought past it, a USD balance.
func parseOllama(b []byte) ([]Reading, error) {
	type limit struct {
		Remaining any    `json:"remaining_percent"`
		ResetsAt  string `json:"resets_at"`
	}
	var r struct {
		Included *struct {
			Balance   any `json:"balance_usd"`
			Allowance any `json:"allowance_usd"`
			Period    *struct {
				From  string `json:"from"`
				Until string `json:"until"`
			} `json:"period"`
			Session *limit `json:"session"`
			Weekly  *limit `json:"weekly"`
		} `json:"included"`
		Purchased *struct {
			Balance any `json:"balance_usd"`
		} `json:"purchased"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	var out []Reading
	win := func(name string, l *limit) {
		if l == nil {
			return
		}
		left, ok := number(l.Remaining)
		if !ok {
			return
		}
		rd := Reading{Window: name, UsedPct: f64(clampPct(100 - left))}
		if t, ok := parseTime(l.ResetsAt); ok {
			rd.ResetsAt = i64(t.UnixMilli())
		}
		out = append(out, rd)
	}
	if in := r.Included; in != nil {
		win("session", in.Session)
		win("7d", in.Weekly)
		allowance, ok1 := number(in.Allowance)
		left, ok2 := number(in.Balance)
		if ok1 && ok2 && allowance > 0 {
			rd := Reading{Window: "allowance", UsedPct: f64(clampPct((allowance - left) / allowance * 100))}
			if p := in.Period; p != nil {
				until, uok := parseTime(p.Until)
				if uok {
					rd.ResetsAt = i64(until.UnixMilli())
				}
				if from, fok := parseTime(p.From); fok && uok && until.After(from) {
					if d := until.Sub(from).Hours() / 24; d >= 27 && d <= 32 {
						rd.Window = windowMonthly
					} else {
						rd.Window = spanWindow(roundSpan(until.Sub(from)))
					}
				}
			}
			out = append(out, rd)
		}
	}
	if p := r.Purchased; p != nil {
		if v, ok := number(p.Balance); ok {
			out = append(out, balanceReading(v, "USD"))
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no allowance or balance in the reply")
	}
	return out, nil
}

// --- OpenCode Go ----------------------------------------------------------

var openCodeGoKeys = keySource{env: []string{"OPENCODE_GO_API_KEY"},
	base:  func(u *url.URL) bool { return hostIs("opencode.ai")(u) && strings.HasPrefix(u.Path, "/zen/go") },
	extra: fromOpenCode("opencode-go")}

func readOpenCodeGo(ctx context.Context, key string) ([]Reading, error) {
	// OpenCode's gateway refuses a request that names no session (400)
	sid := openCodeSessionID()
	b, err := doJSON(ctx, "GET", openCodeGoUsageURL, map[string]string{
		"Authorization":         "Bearer " + key,
		"x-opencode-session":    sid,
		"x-opencode-session-id": sid,
		"x-opencode-client":     "cli",
	}, nil)
	if err != nil {
		return nil, err
	}
	return parseOpenCodeGo(b)
}

// openCodeSessionID is a session id of OpenCode's shape: "ses_", 12 hex
// digits, 14 base62 characters.
func openCodeSessionID() string {
	const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	var rnd [14]byte
	_, _ = rand.Read(rnd[:])
	id := fmt.Sprintf("ses_%012x", ^(uint64(time.Now().UnixMilli())*0x1000+1)&0xffffffffffff)
	for _, c := range rnd {
		id += string(base62[int(c)%len(base62)])
	}
	return id
}

// parseOpenCodeGo reads
//
//	{"usage":{"rolling":{"status":"ok","percent":37,"resetsAt":"…"},
//	          "weekly":{…},"monthly":{…}}}
//
// rolling is the 5-hour window. A window at 0% has no reset to tell (the
// reply gives one anyway).
func parseOpenCodeGo(b []byte) ([]Reading, error) {
	var r struct {
		Usage map[string]struct {
			Percent  *float64 `json:"percent"`
			ResetsAt string   `json:"resetsAt"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, errBadReply
	}
	var out []Reading
	for _, x := range []struct{ key, window string }{{"rolling", "5h"}, {"weekly", "7d"}, {"monthly", windowMonthly}} {
		w, ok := r.Usage[x.key]
		if !ok || w.Percent == nil {
			continue
		}
		rd := Reading{Window: x.window, UsedPct: f64(clampPct(*w.Percent))}
		if t, ok := parseTime(w.ResetsAt); ok && *w.Percent > 0 {
			rd.ResetsAt = i64(t.UnixMilli())
		}
		out = append(out, rd)
	}
	if len(out) == 0 {
		return nil, errors.New("no usage windows in the reply")
	}
	return out, nil
}

// --- Command Code ---------------------------------------------------------

// Command Code's key is the CLI's own (~/.commandcode/auth.json, written by
// `cmd login`) or one from its Studio; GET /alpha/billing/credits tells it
// the credits left and, on a plan, the 5-hour and weekly windows. The
// commandcode-plan subscription and the keyed commandcode preset read the
// same reply, so each reports what is its own: the plan its windows, the
// key its balance.

func commandCodeAuthPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".commandcode", "auth.json")
}

// commandCodeOwn is the CLI's signed-in key and user name.
func commandCodeOwn() (key, user string) {
	b, err := readSmallFile(commandCodeAuthPath())
	if err != nil {
		return "", ""
	}
	var a struct {
		APIKey   string `json:"apiKey"`
		UserName string `json:"userName"`
		UserID   string `json:"userId"`
	}
	if json.Unmarshal(b, &a) != nil {
		return "", ""
	}
	user = a.UserName
	if user == "" {
		user = a.UserID
	}
	return strings.TrimSpace(a.APIKey), user
}

var (
	commandCodeKeys     = keySource{env: []string{"COMMANDCODE_API_KEY", "COMMAND_CODE_API_KEY"}, hosts: []string{"api.commandcode.ai"}}
	commandCodePlanKeys = keySource{extra: func() string { k, _ := commandCodeOwn(); return k }}
)

type commandCodeCredits struct {
	Credits struct {
		PlanID    string `json:"planId"`
		Monthly   any    `json:"monthlyCredits"`
		Purchased any    `json:"purchasedCredits"`
		Free      any    `json:"freeCredits"`
	} `json:"credits"`
	Windows *struct {
		FiveHour *commandCodeWindow `json:"fiveHour"`
		Weekly   *commandCodeWindow `json:"weekly"`
	} `json:"windowLimits"`
}

type commandCodeWindow struct {
	Used    any `json:"used"`
	Cap     any `json:"cap"`
	ResetAt any `json:"resetAt"`
}

func readCommandCodeCredits(ctx context.Context, key string) (commandCodeCredits, error) {
	var c commandCodeCredits
	b, err := doJSON(ctx, "GET", strings.TrimSuffix(commandCodeBaseURL, "/")+"/alpha/billing/credits", map[string]string{"Authorization": "Bearer " + key}, nil)
	if err != nil {
		return c, err
	}
	if json.Unmarshal(b, &c) != nil {
		return c, errBadReply
	}
	return c, nil
}

// commandCodePlans maps a planId prefix to the plan's name, longest
// prefixes first where one is another's ("individual-pro-v1" before
// "individual-pro").
var commandCodePlans = []struct{ prefix, name string }{
	{"individual-provider", "Provider"}, {"individual-pro-v1", "Pro"}, {"individual-goat", "GOAT"},
	{"individual-ultra", "Ultra"}, {"individual-max", "Max"}, {"individual-pro", "Pro"},
	{"individual-go", "Go"}, {"teams-pro", "Teams Pro"},
}

func commandCodePlanName(id string) string {
	id = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(id)), "_", "-")
	for _, p := range commandCodePlans {
		if strings.HasPrefix(id, p.prefix) {
			return p.name
		}
	}
	return ""
}

// parseCommandCodeWindows is the plan's capped windows, "5h" and "7d".
func parseCommandCodeWindows(c commandCodeCredits) []Reading {
	if c.Windows == nil {
		return nil
	}
	var out []Reading
	for _, w := range []struct {
		name string
		w    *commandCodeWindow
	}{{"5h", c.Windows.FiveHour}, {"7d", c.Windows.Weekly}} {
		if w.w == nil {
			continue
		}
		used, ok1 := number(w.w.Used)
		limit, ok2 := number(w.w.Cap)
		if !ok1 || !ok2 || limit <= 0 {
			continue
		}
		rd := Reading{Window: w.name, UsedPct: f64(clampPct(100 * used / limit))}
		if t, ok := parseTime(w.w.ResetAt); ok {
			rd.ResetsAt = i64(t.UnixMilli())
		}
		out = append(out, rd)
	}
	return out
}

// commandCodeBalance is the dollars left: the month's credits and the
// bought and free ones (each at least 0); ok is false when none is told.
func commandCodeBalance(c commandCodeCredits) (left float64, ok bool) {
	for _, v := range []any{c.Credits.Monthly, c.Credits.Purchased, c.Credits.Free} {
		if n, is := number(v); is {
			left += max(0, n)
			ok = true
		}
	}
	return left, ok
}

// parseCommandCode reads
//
//	{"credits":{"planId":"individual-goat-monthly","monthlyCredits":41.2,
//	   "purchasedCredits":5,"freeCredits":0},
//	 "windowLimits":{"fiveHour":{"used":3.1,"cap":10,"resetAt":1790000000000},
//	   "weekly":{"used":12,"cap":40,"resetAt":…}}}
//
// into the plan's windows (plan set) and the balance.
func parseCommandCode(b []byte) (windows []Reading, balance *Reading, err error) {
	var c commandCodeCredits
	if json.Unmarshal(b, &c) != nil {
		return nil, nil, errBadReply
	}
	return commandCodeReadings(c)
}

func commandCodeReadings(c commandCodeCredits) (windows []Reading, balance *Reading, err error) {
	windows = parseCommandCodeWindows(c)
	plan := commandCodePlanName(c.Credits.PlanID)
	for i := range windows {
		windows[i].Plan = plan
	}
	if left, ok := commandCodeBalance(c); ok {
		rd := balanceReading(left, "USD")
		rd.Plan = plan
		balance = &rd
	}
	if len(windows) == 0 && balance == nil {
		return nil, nil, errors.New("no credits in the reply")
	}
	return windows, balance, nil
}

// commandCodeProvider is the keyed preset: the key's credits balance.
type commandCodeProvider struct{}

func (commandCodeProvider) ID() string   { return "commandcode" }
func (commandCodeProvider) Detect() bool { return commandCodeKeys.find() != "" }

func (commandCodeProvider) Read(ctx context.Context) ([]Reading, error) {
	key := commandCodeKeys.find()
	if key == "" {
		return nil, errNotLoggedIn
	}
	c, err := readCommandCodeCredits(ctx, key)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), key))
	}
	_, bal, err := commandCodeReadings(c)
	if err != nil {
		return nil, err
	}
	if bal == nil {
		return nil, errNoBalance
	}
	return []Reading{*bal}, nil
}

// commandCodePlanProvider is the CLI's signed-in subscription: its plan
// windows, or the credits balance on an account with none.
type commandCodePlanProvider struct{}

func (commandCodePlanProvider) ID() string   { return "commandcode-plan" }
func (commandCodePlanProvider) Detect() bool { return commandCodePlanKeys.find() != "" }

func (commandCodePlanProvider) Read(ctx context.Context) ([]Reading, error) {
	key, user := commandCodeOwn()
	if key == "" {
		return nil, errNotLoggedIn
	}
	c, err := readCommandCodeCredits(ctx, key)
	if err != nil {
		return nil, errors.New(sanitize(err.Error(), key))
	}
	ws, bal, err := commandCodeReadings(c)
	if err != nil {
		return nil, err
	}
	out := ws
	if len(out) == 0 && bal != nil {
		out = []Reading{*bal}
	}
	for i := range out {
		out[i].Account = sanitizeAccount(user)
	}
	return out, nil
}

// sanitizeAccount keeps an account label short and printable; anything
// that looks like a token is dropped.
func sanitizeAccount(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || sanitize(s) != s {
		return ""
	}
	if r := []rune(s); len(r) > 80 {
		s = string(r[:80])
	}
	return s
}

// --- plan providers keyed by an API key ----------------------------------

func keyedPlanProviders() []Provider {
	return []Provider{
		planProvider{id: "ollama-cloud", keys: ollamaKeys, read: readOllama},
		planProvider{id: "opencode-go", keys: openCodeGoKeys, read: readOpenCodeGo},
		commandCodeProvider{},
		commandCodePlanProvider{},
	}
}
