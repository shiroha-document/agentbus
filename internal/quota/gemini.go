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

// Gemini CLI: its own Google sign-in (~/.gemini/oauth_creds.json) asked
// Code Assist for the project (loadCodeAssist) and then the per-model
// allowance (retrieveUserQuota), as magpie's google.go does. Both are
// undocumented. The access token is used only while it is still valid:
// refreshing it would need Gemini CLI's OAuth client and would rotate the
// CLI's own sign-in, so an expired token reads as an error until Gemini CLI
// next runs.

type geminiProvider struct{}

func (geminiProvider) ID() string { return "gemini" }

func geminiDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gemini")
}

func (geminiProvider) Detect() bool {
	d := geminiDir()
	return d != "" && fileExists(filepath.Join(d, "oauth_creds.json"))
}

func (geminiProvider) Read(ctx context.Context) ([]Reading, error) {
	d := geminiDir()
	b, err := readSmallFile(filepath.Join(d, "oauth_creds.json"))
	if err != nil {
		return nil, errNotLoggedIn
	}
	var c struct {
		AccessToken string `json:"access_token"`
		Expiry      int64  `json:"expiry_date"`
	}
	if json.Unmarshal(b, &c) != nil || c.AccessToken == "" {
		return nil, errNotLoggedIn
	}
	now := nowFrom(ctx)
	if c.Expiry > 0 && time.UnixMilli(c.Expiry).Before(now.Add(30*time.Second)) {
		return nil, errors.New("token expired")
	}
	tok := c.AccessToken
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	base := strings.TrimSuffix(geminiCodeAssistURL, "/") + "/v1internal:"
	lb, err := doJSON(ctx, "POST", base+"loadCodeAssist", hdr,
		[]byte(`{"metadata":{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}`))
	if err != nil {
		return nil, unknownErr(err)
	}
	project, plan, err := parseGeminiLoad(lb)
	if err != nil {
		return nil, unknownErr(err)
	}
	if p := strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT")); project == "" && p != "" {
		project = p
	}
	if project == "" {
		return nil, unknownErr(errors.New("no Code Assist project"))
	}
	body, _ := json.Marshal(map[string]string{"project": project})
	qb, err := doJSON(ctx, "POST", base+"retrieveUserQuota", hdr, body)
	if err != nil {
		return nil, unknownErr(err)
	}
	rs, err := parseGeminiQuota(qb)
	if err != nil {
		return nil, unknownErr(err)
	}
	acct := geminiAccount(d)
	for i := range rs {
		rs[i].Account, rs[i].Plan = acct, plan
	}
	return rs, nil
}

// parseGeminiLoad reads loadCodeAssist's project ("cloudaicompanionProject",
// a string or {"id":…}) and the current tier's id as the plan.
func parseGeminiLoad(b []byte) (project, plan string, err error) {
	var r struct {
		CurrentTier *struct {
			ID string `json:"id"`
		} `json:"currentTier"`
		Project json.RawMessage `json:"cloudaicompanionProject"`
	}
	if json.Unmarshal(b, &r) != nil {
		return "", "", errBadReply
	}
	if len(r.Project) > 0 {
		var s string
		if json.Unmarshal(r.Project, &s) == nil {
			project = s
		} else {
			var o struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(r.Project, &o) == nil {
				project = o.ID
			}
		}
	}
	if r.CurrentTier != nil {
		plan = strings.ToLower(strings.TrimSpace(r.CurrentTier.ID))
	}
	return strings.TrimSpace(project), plan, nil
}

// parseGeminiQuota reads
//
//	{"buckets":[{"modelId":"gemini-2.5-pro","remainingFraction":0.8,
//	  "resetTime":"2026-10-21T00:00:00Z","tokenType":"REQUESTS"}]}
//
// One reading per model: the window is the model id.
func parseGeminiQuota(b []byte) ([]Reading, error) {
	var r struct {
		Buckets []struct {
			ModelID           string   `json:"modelId"`
			RemainingFraction *float64 `json:"remainingFraction"`
			ResetTime         string   `json:"resetTime"`
		} `json:"buckets"`
	}
	if json.Unmarshal(b, &r) != nil {
		return nil, errBadReply
	}
	seen := map[string]bool{}
	var out []Reading
	for _, k := range r.Buckets {
		id := strings.TrimSpace(k.ModelID)
		if id == "" || seen[id] || strings.HasSuffix(id, "_vertex") || k.RemainingFraction == nil {
			continue
		}
		seen[id] = true
		rd := Reading{Window: normWindowPart(id), UsedPct: f64(clampPct((1 - *k.RemainingFraction) * 100))}
		if t, ok := parseTime(k.ResetTime); ok {
			rd.ResetsAt = i64(t.UnixMilli())
		}
		out = append(out, rd)
	}
	if len(out) == 0 {
		return nil, errors.New("no quota buckets")
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Window < out[j].Window })
	return out, nil
}

func geminiAccount(dir string) string {
	b, err := readSmallFile(filepath.Join(dir, "google_accounts.json"))
	if err != nil {
		return ""
	}
	var a struct {
		Active string `json:"active"`
	}
	if json.Unmarshal(b, &a) != nil {
		return ""
	}
	return strings.TrimSpace(a.Active)
}
