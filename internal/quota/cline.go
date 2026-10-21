package quota

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
)

// ClinePass: a Cline API key is told the plan's 5-hour, weekly and monthly
// limits (GET /users/me/plan/usage-limits, 404 on an account without
// ClinePass) and the account's credits (GET /users/me for the id, then
// /users/{id}/balance in millionths of a dollar). Replies are a
// {success, data} envelope. Endpoints, headers and shapes follow magpie's
// cline_usage.go and cline.go (THIRD_PARTY.md).

var clineKeys = keySource{env: []string{"CLINE_API_KEY", "CLINEPASS_API_KEY"}, extra: fromOpenCode("cline")}

const clineVersion = "3.5.54"

func clineGet(ctx context.Context, key, path string, out any) error {
	b, err := doJSON(ctx, "GET", strings.TrimSuffix(clineBaseURL, "/")+path, map[string]string{
		"Authorization":    "Bearer " + key,
		"HTTP-Referer":     "https://cline.bot",
		"X-Title":          "Cline",
		"X-IS-MULTIROOT":   "false",
		"X-CLIENT-TYPE":    "cline-desktop",
		"X-CLIENT-VERSION": clineVersion,
		"User-Agent":       "Cline/" + clineVersion,
	}, nil)
	if err != nil {
		return err
	}
	return clineUnwrap(b, out)
}

// clineUnwrap reads a {success, error, data} reply's data into out (a reply
// without the envelope is read as it is).
func clineUnwrap(b []byte, out any) error {
	var env struct {
		Success *bool           `json:"success"`
		Error   string          `json:"error"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(b, &env) != nil {
		return errBadReply
	}
	if env.Success != nil && !*env.Success {
		if env.Error == "" {
			env.Error = "refused"
		}
		return errors.New("Cline refused: " + env.Error)
	}
	if env.Success != nil || len(env.Data) > 0 {
		b = env.Data
	}
	if json.Unmarshal(b, out) != nil {
		return errBadReply
	}
	return nil
}

// parseClineLimits reads {"limits":[{"type":"five_hour","percentUsed":12,
// "resetsAt":"…"},…]} into "5h", "7d" and "monthly".
func parseClineLimits(b []byte) ([]Reading, error) {
	var lim struct {
		Limits []struct {
			Type        string `json:"type"`
			PercentUsed any    `json:"percentUsed"`
			ResetsAt    string `json:"resetsAt"`
		} `json:"limits"`
	}
	if err := clineUnwrap(b, &lim); err != nil {
		return nil, err
	}
	var out []Reading
	for _, x := range []struct{ typ, window string }{{"five_hour", "5h"}, {"weekly", "7d"}, {"monthly", windowMonthly}} {
		for _, l := range lim.Limits {
			if l.Type != x.typ {
				continue
			}
			used, ok := number(l.PercentUsed)
			if !ok {
				break
			}
			rd := Reading{Window: x.window, UsedPct: f64(clampPct(used)), Plan: "ClinePass"}
			if t, ok := parseTime(l.ResetsAt); ok {
				rd.ResetsAt = i64(t.UnixMilli())
			}
			out = append(out, rd)
			break
		}
	}
	return out, nil
}

// clineBalance is the account's credits in dollars.
func clineBalance(ctx context.Context, key string) (float64, error) {
	var me struct {
		ID          string `json:"id"`
		ClineUserID string `json:"clineUserId"`
		Subject     string `json:"subject"`
	}
	if err := clineGet(ctx, key, "/users/me", &me); err != nil {
		return 0, err
	}
	last := errors.New("Cline told no user id")
	for _, id := range []string{me.ClineUserID, me.Subject, me.ID} {
		if strings.TrimSpace(id) == "" {
			continue
		}
		var b struct {
			Balance any `json:"balance"`
		}
		if last = clineGet(ctx, key, "/users/"+url.PathEscape(id)+"/balance", &b); last != nil {
			continue
		}
		n, ok := number(b.Balance)
		if !ok || n < 0 {
			return 0, errNoBalance
		}
		return n / 1e6, nil
	}
	return 0, last
}

type clinePassProvider struct{}

func (clinePassProvider) ID() string   { return "clinepass" }
func (clinePassProvider) Detect() bool { return clineKeys.find() != "" }

func (clinePassProvider) Read(ctx context.Context) ([]Reading, error) {
	key := clineKeys.find()
	if key == "" {
		return nil, errNotLoggedIn
	}
	var out []Reading
	b, limErr := doJSONCline(ctx, key, "/users/me/plan/usage-limits")
	if limErr == nil {
		out, limErr = parseClineLimits(b)
	}
	var se statusError
	if errors.As(limErr, &se) && se.code == 404 {
		limErr = nil // no ClinePass on the account: its credits alone
	}
	bal, balErr := clineBalance(ctx, key)
	if balErr == nil {
		out = append(out, balanceReading(bal, "USD"))
	}
	if len(out) == 0 {
		err := limErr
		if err == nil {
			err = balErr
		}
		return nil, errors.New(sanitize(unknownErr(err).Error(), key))
	}
	if limErr != nil {
		out = append(out, Reading{Window: WindowAll, Error: sanitize("limits unread: "+unknownErr(limErr).Error(), key)})
	}
	return out, nil
}

// doJSONCline is the data of a Cline reply, still raw JSON.
func doJSONCline(ctx context.Context, key, path string) ([]byte, error) {
	var raw json.RawMessage
	if err := clineGet(ctx, key, path, &raw); err != nil {
		return nil, err
	}
	return raw, nil
}
