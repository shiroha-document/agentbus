package quota

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestParseClaudeUsage(t *testing.T) {
	rs, err := parseClaudeUsage(fixture(t, "claude_usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := windows(rs), []string{"5h", "7d", "7d_opus"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows %v, want %v", got, want)
	}
	wantPct(t, &rs[0], 37.5)
	wantReset(t, &rs[0], time.Date(2026, 10, 20, 15, 0, 0, 123000000, time.UTC))
	wantPct(t, &rs[1], 12)
	wantReset(t, &rs[1], time.Date(2026, 10, 25, 8, 0, 0, 0, time.UTC))
	wantPct(t, &rs[2], 0)
	if rs[2].ResetsAt != nil {
		t.Fatalf("7d_opus resets_at %v, want nil", *rs[2].ResetsAt)
	}
	for _, bad := range []string{``, `[]`, `{}`, `{"five_hour":null}`, `{"five_hour":{"utilization":"x"}}`} {
		if _, err := parseClaudeUsage([]byte(bad)); err == nil {
			t.Errorf("parseClaudeUsage(%q) did not fail", bad)
		}
	}
}

func TestParseClaudeCredentials(t *testing.T) {
	b := fixture(t, "claude_credentials.json")
	c, ok := parseClaudeCredentials(b)
	if !ok || c.SubscriptionType != "max" || c.ExpiresAt != 4102444800000 || c.AccessToken == "" {
		t.Fatalf("parse: ok=%v sub=%q exp=%d", ok, c.SubscriptionType, c.ExpiresAt)
	}
	// the keychain may hand the item back hex-encoded
	hexed := []byte(strings.ToUpper(hex.EncodeToString(b)))
	if c2, ok := parseClaudeCredentials(hexed); !ok || c2 != c {
		t.Fatalf("hex-encoded credentials not read")
	}
	if _, ok := parseClaudeCredentials([]byte(`{"claudeAiOauth":{}}`)); ok {
		t.Fatal("empty token accepted")
	}
}

// copyCodexHome copies the rollout fixtures into a temp CODEX_HOME, giving
// the newer session the newer mtime.
func copyCodexHome(t *testing.T, dst string) {
	t.Helper()
	src := filepath.Join("testdata", "codex")
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out := filepath.Join(dst, rel)
		writeFile(t, out, b)
		mod := time.Date(2026, 10, 19, 9, 1, 0, 0, time.UTC)
		if strings.Contains(rel, "2026-10-20") {
			mod = time.Date(2026, 10, 20, 11, 0, 3, 0, time.UTC)
		}
		return os.Chtimes(out, mod, mod)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestParseRollout(t *testing.T) {
	b := fixture(t, filepath.Join("codex", "sessions", "2026", "10", "20", "rollout-2026-10-20T10-00-00-00000000-0000-0000-0000-000000000001.jsonl"))
	now := time.Date(2026, 10, 20, 11, 30, 0, 0, time.UTC)
	rs, ok := parseRollout(bytes.NewReader(b), now, now)
	if !ok {
		t.Fatal("no readings")
	}
	// the 11:00 event wins over 10:00; the model-specific limit is skipped
	if got, want := windows(rs), []string{"5h", "7d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows %v, want %v", got, want)
	}
	wantPct(t, &rs[0], 42.5)
	wantReset(t, &rs[0], time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC))
	wantPct(t, &rs[1], 17)
	wantReset(t, &rs[1], time.Unix(1792900000, 0))
	at := time.Date(2026, 10, 20, 11, 0, 0, 0, time.UTC).UnixMilli()
	for _, r := range rs {
		if r.ReadAt != at || r.Plan != "plus" {
			t.Fatalf("%s: read_at %d plan %q", r.Window, r.ReadAt, r.Plan)
		}
	}

	// once the 5-hour window has reset, nothing is known to be used in it
	later := time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC)
	rs, _ = parseRollout(bytes.NewReader(b), later, later)
	wantPct(t, &rs[0], 0)
	if rs[0].ResetsAt != nil {
		t.Fatal("a past reset was reported")
	}
	wantPct(t, &rs[1], 17)

	if _, ok := parseRollout(strings.NewReader(`{"type":"event_msg","payload":{"type":"agent_message","text":"token_count rate_limits"}}`+"\n"+`not json "token_count" "rate_limits"`), now, now); ok {
		t.Fatal("readings from lines without limits")
	}
}

func TestRoundSpan(t *testing.T) {
	for in, want := range map[time.Duration]string{
		299 * time.Minute:   "5h",
		300 * time.Minute:   "5h",
		10080 * time.Minute: "7d",
		10079 * time.Minute: "7d",
		90 * time.Minute:    "90m",
		0:                   "allowance",
	} {
		if got := spanWindow(roundSpan(in)); got != want {
			t.Errorf("%v -> %q, want %q", in, got, want)
		}
	}
}

func TestCodexProviderRead(t *testing.T) {
	_, home := isolate(t)
	codex := filepath.Join(home, ".codex")
	if (codexProvider{}).Detect() {
		t.Fatal("detected without a codex home")
	}
	copyCodexHome(t, codex)
	// an id token naming the account and plan (unsigned, synthetic)
	claims := `{"email":"dev@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}`
	idTok := "e30." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".c2ln"
	writeFile(t, filepath.Join(codex, "auth.json"), []byte(`{"OPENAI_API_KEY":null,"tokens":{"id_token":"`+idTok+`","access_token":"fake","refresh_token":"fake"}}`))
	if !(codexProvider{}).Detect() {
		t.Fatal("not detected")
	}
	ctx := withNow(context.Background(), func() time.Time { return time.Date(2026, 10, 20, 11, 30, 0, 0, time.UTC) })
	rs, err := codexProvider{}.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 2 {
		t.Fatalf("got %d readings", len(rs))
	}
	wantPct(t, &rs[0], 42.5)
	for _, r := range rs {
		if r.Account != "dev@example.com" || r.Plan != "plus" {
			t.Fatalf("account %q plan %q", r.Account, r.Plan)
		}
	}

	// a home with no limits in any rollout reads as not logged in
	empty := filepath.Join(home, "empty")
	writeFile(t, filepath.Join(empty, "sessions", "2026", "10", "20", "rollout-x.jsonl"), []byte(`{"type":"session_meta"}`+"\n"))
	t.Setenv("CODEX_HOME", empty)
	if _, err := (codexProvider{}).Read(ctx); err != errNotLoggedIn {
		t.Fatalf("err %v, want errNotLoggedIn", err)
	}
}

func TestParseZhipu(t *testing.T) {
	rs, err := parseZhipu(fixture(t, "zhipu.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := windows(rs), []string{"5h", "7d", "mcp_monthly"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows %v, want %v", got, want)
	}
	wantPct(t, &rs[0], 12)
	wantReset(t, &rs[0], time.UnixMilli(1761062400000))
	wantPct(t, &rs[1], 40)
	wantPct(t, &rs[2], 3)
	for _, r := range rs {
		if r.Plan != "pro" {
			t.Fatalf("plan %q", r.Plan)
		}
	}
	if _, err := parseZhipu(fixture(t, "zhipu_refused.json")); err == nil || err.Error() != "令牌已过期或验证不正确" {
		t.Fatalf("refused: %v", err)
	}
	if _, err := parseZhipu([]byte(`{"success":true,"data":{"limits":[]}}`)); err == nil {
		t.Fatal("no windows accepted")
	}
}

func TestParseKimi(t *testing.T) {
	rs, err := parseKimi(fixture(t, "kimi.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := windows(rs), []string{"5h", "7d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows %v, want %v", got, want)
	}
	wantPct(t, &rs[0], 25)
	wantReset(t, &rs[0], time.Date(2026, 10, 20, 15, 0, 0, 0, time.UTC))
	wantPct(t, &rs[1], 12)
	wantReset(t, &rs[1], time.Date(2026, 10, 27, 5, 24, 18, 440000000, time.UTC))
	// numbers as numbers, a limit of 0 skipped
	rs, err = parseKimi([]byte(`{"usage":{"limit":0,"used":1},"limits":[{"window":{"duration":1,"timeUnit":"TIME_UNIT_DAY"},"detail":{"limit":50,"used":10}}]}`))
	if err != nil || len(rs) != 1 || rs[0].Window != "1d" {
		t.Fatalf("got %v %v", rs, err)
	}
	wantPct(t, &rs[0], 20)
	if _, err := parseKimi([]byte(`{}`)); err == nil {
		t.Fatal("empty reply accepted")
	}
}

func TestParseMiniMax(t *testing.T) {
	rs, err := parseMiniMax(fixture(t, "minimax.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := windows(rs), []string{"5h", "7d", "video_1d"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows %v, want %v", got, want)
	}
	wantPct(t, &rs[0], 36)
	wantReset(t, &rs[0], time.UnixMilli(1760972400000))
	wantPct(t, &rs[1], 10)
	wantReset(t, &rs[1], time.UnixMilli(1761523200000))
	wantPct(t, &rs[2], 100)
	wantReset(t, &rs[2], time.Unix(1761004800, 0))
	_, err = parseMiniMax(fixture(t, "minimax_refused.json"))
	if err == nil || !strings.HasPrefix(err.Error(), "login fail") {
		t.Fatalf("refused: %v", err)
	}
	if _, err := parseMiniMax([]byte(`{"model_remains":[]}`)); err == nil {
		t.Fatal("reply without base_resp accepted")
	}
}

func TestParseOpenRouter(t *testing.T) {
	b, err := parseOpenRouter(fixture(t, "openrouter.json"))
	if err != nil {
		t.Fatal(err)
	}
	if *b != (Balance{Amount: 16.54, Currency: "USD"}) {
		t.Fatalf("balance %+v", *b)
	}
	if _, err := parseOpenRouter([]byte(`{"data":{}}`)); err == nil {
		t.Fatal("reply without credits accepted")
	}
}

func TestParseGemini(t *testing.T) {
	project, plan, err := parseGeminiLoad(fixture(t, "gemini_load.json"))
	if err != nil || project != "fake-project-123" || plan != "free-tier" {
		t.Fatalf("load: %q %q %v", project, plan, err)
	}
	project, _, _ = parseGeminiLoad([]byte(`{"cloudaicompanionProject":{"id":"obj-project"}}`))
	if project != "obj-project" {
		t.Fatalf("object project %q", project)
	}
	rs, err := parseGeminiQuota(fixture(t, "gemini_quota.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := windows(rs), []string{"gemini-2.5-flash", "gemini-2.5-pro"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("windows %v, want %v", got, want)
	}
	wantPct(t, &rs[0], 0)
	wantPct(t, &rs[1], 25)
	wantReset(t, &rs[1], time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))
	if _, err := parseGeminiQuota([]byte(`{"buckets":[]}`)); err == nil {
		t.Fatal("no buckets accepted")
	}
}

func TestNormWindow(t *testing.T) {
	for in, want := range map[string]string{
		"5 hours":                  "5h",
		"7 days":                   "7d",
		"7 days · Opus":            "7d_opus",
		"Premium requests · Month": "premium_requests_monthly",
		"MCP · Month":              "mcp_monthly",
		"Video · 5 hours":          "video_5h",
		"Week":                     "7d",
		"Today":                    "daily",
		"30 minutes":               "30m",
		"":                         "allowance",
	} {
		if got := normWindow(in); got != want {
			t.Errorf("normWindow(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseMoney(t *testing.T) {
	for in, want := range map[string]Balance{
		"$12.34":       {12.34, "USD"},
		"-$1.50":       {-1.5, "USD"},
		"¥88.50":       {88.5, "CNY"},
		"EUR 3.20":     {3.2, "EUR"},
		"1.2K credits": {1200, "credits"},
		"$1,234.5":     {1234.5, "USD"},
		"12 USD":       {12, "USD"},
	} {
		b, ok := parseMoney(in)
		if !ok || *b != want {
			t.Errorf("parseMoney(%q) = %+v %v, want %+v", in, b, ok, want)
		}
	}
	for _, in := range []string{"", "n/a", "12", "unlimited"} {
		if b, ok := parseMoney(in); ok {
			t.Errorf("parseMoney(%q) = %+v", in, *b)
		}
	}
}
