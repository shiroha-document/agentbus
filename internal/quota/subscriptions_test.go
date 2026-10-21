package quota

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseOllama(t *testing.T) {
	rs, err := parseOllama(fixture(t, "ollama_balance.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(windows(rs), ",") != "session,7d,monthly,balance" {
		t.Fatalf("windows %v", windows(rs))
	}
	wantPct(t, find(rs, "", "session"), 25)
	wantReset(t, find(rs, "", "session"), time.Date(2026, 10, 20, 15, 0, 0, 0, time.UTC))
	wantPct(t, find(rs, "", "7d"), 60)
	wantPct(t, find(rs, "", "monthly"), 27.5)
	wantReset(t, find(rs, "", "monthly"), time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC))
	wantBalance(t, find(rs, "", "balance"), 25, "USD")

	// a period that isn't a month is named by its length
	rs, _ = parseOllama([]byte(`{"included":{"balance_usd":5,"allowance_usd":10,"period":{"from":"2026-10-20T00:00:00Z","until":"2026-10-27T00:00:00Z"}}}`))
	wantPct(t, find(rs, "", "7d"), 50)
	if _, err := parseOllama([]byte(`{}`)); err == nil {
		t.Fatal("empty reply accepted")
	}
}

func TestParseOpenCodeGo(t *testing.T) {
	rs, err := parseOpenCodeGo(fixture(t, "opencode_go_usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(windows(rs), ",") != "5h,7d,monthly" {
		t.Fatalf("windows %v", windows(rs))
	}
	wantPct(t, find(rs, "", "5h"), 37)
	wantReset(t, find(rs, "", "5h"), time.Date(2026, 10, 20, 14, 0, 0, 0, time.UTC))
	if r := find(rs, "", "7d"); r.ResetsAt != nil {
		t.Fatal("an unused window has no reset")
	}
	wantPct(t, find(rs, "", "monthly"), 12.5)
	if _, err := parseOpenCodeGo([]byte(`{"usage":{}}`)); err == nil {
		t.Fatal("empty reply accepted")
	}
	if id := openCodeSessionID(); !strings.HasPrefix(id, "ses_") || len(id) != 4+12+14 {
		t.Fatalf("session id %q", id)
	}
}

func TestParseCommandCode(t *testing.T) {
	ws, bal, err := parseCommandCode(fixture(t, "commandcode_credits.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(windows(ws), ",") != "5h,7d" {
		t.Fatalf("windows %v", windows(ws))
	}
	wantPct(t, &ws[0], 30)
	wantReset(t, &ws[0], time.Date(2026, 10, 20, 15, 0, 0, 0, time.UTC))
	wantPct(t, &ws[1], 30)
	wantReset(t, &ws[1], time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC))
	// negative free credits count as none
	wantBalance(t, bal, 46.2, "USD")
	if ws[0].Plan != "GOAT" || bal.Plan != "GOAT" {
		t.Fatalf("plan %q", ws[0].Plan)
	}
	for id, want := range map[string]string{"individual-pro-v1-monthly": "Pro", "individual_pro": "Pro", "individual-provider": "Provider", "teams-pro-annual": "Teams Pro", "mystery": ""} {
		if got := commandCodePlanName(id); got != want {
			t.Errorf("plan %q = %q, want %q", id, got, want)
		}
	}
	if _, _, err := parseCommandCode([]byte(`{"credits":{}}`)); err == nil {
		t.Fatal("empty reply accepted")
	}
}

func TestParseCopilot(t *testing.T) {
	rs, err := parseCopilot(fixture(t, "copilot_user.json"))
	if err != nil {
		t.Fatal(err)
	}
	// unlimited chat and completions are not windows
	if len(rs) != 1 || rs[0].Window != "premium_monthly" || rs[0].Plan != "Pro" {
		t.Fatalf("got %+v", rs)
	}
	wantPct(t, &rs[0], 60)
	wantReset(t, &rs[0], time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC))

	rs, _ = parseCopilot([]byte(`{"copilot_plan":"individual","access_type_sku":"free_limited_copilot","quota_reset_date":"2026-11-01",
	  "quota_snapshots":{"chat":{"entitlement":50,"percent_remaining":90},"completions":{"entitlement":"2000","remaining":"500"},
	  "premium_interactions":{"unlimited":true,"has_quota":false}}}`))
	if len(rs) != 3 || rs[0].Plan != "Free" {
		t.Fatalf("free plan: %+v", rs)
	}
	wantPct(t, find(rs, "", "premium_monthly"), 100)
	wantPct(t, find(rs, "", "chat_monthly"), 10)
	wantPct(t, find(rs, "", "completions_monthly"), 75)
	wantReset(t, find(rs, "", "chat_monthly"), time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC))
	if _, err := parseCopilot([]byte(`{"quota_snapshots":{"chat":{"unlimited":true}}}`)); err == nil {
		t.Fatal("nothing capped accepted")
	}
	if copilotPlanName("business", "") != "Business" || copilotPlanName("weird", "") != "Weird" {
		t.Fatal("plan names")
	}
}

func TestOllamaAndOpenCodeGoRead(t *testing.T) {
	env, home := isolate(t)
	s := &serve{status: 200, body: fixture(t, "ollama_balance.json")}
	srv := newServer(t, s)
	setVar(t, &ollamaBalanceURL, srv.URL+"/api/balance")
	setVar(t, &openCodeGoUsageURL, srv.URL+"/zen/go/v1/usage")
	ps := map[string]Provider{}
	for _, p := range keyedPlanProviders() {
		ps[p.ID()] = p
	}
	for _, id := range []string{"ollama-cloud", "opencode-go", "commandcode", "commandcode-plan"} {
		if ps[id] == nil || ps[id].Detect() {
			t.Fatalf("%s detected without a key", id)
		}
	}
	env["OLLAMA_API_KEY"] = "ollama-key"
	rs, err := ps["ollama-cloud"].Read(ctxAt(testNow))
	if err != nil || len(rs) != 4 {
		t.Fatalf("ollama: %+v %v", rs, err)
	}
	if req := s.req(); req.URL.Path != "/api/balance" || req.Header.Get("Authorization") != "Bearer ollama-key" {
		t.Fatalf("ollama request %s", req.URL.Path)
	}

	// OpenCode Go's key from OpenCode's auth.json; its gateway wants a session
	writeFile(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), []byte(`{"opencode-go":{"type":"api","key":"oc-go-key"}}`))
	if !ps["opencode-go"].Detect() {
		t.Fatal("opencode-go not detected")
	}
	s.body = fixture(t, "opencode_go_usage.json")
	rs, err = ps["opencode-go"].Read(ctxAt(testNow))
	if err != nil || len(rs) != 3 {
		t.Fatalf("opencode-go: %+v %v", rs, err)
	}
	req := s.req()
	if req.Header.Get("Authorization") != "Bearer oc-go-key" || !strings.HasPrefix(req.Header.Get("x-opencode-session"), "ses_") || req.Header.Get("x-opencode-client") != "cli" {
		t.Fatal("opencode-go headers")
	}
	// Claude Code on OpenCode Go's Anthropic endpoint is its key too; the
	// Zen endpoint on the same host is not
	writeFile(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), []byte(`{}`))
	env["ANTHROPIC_AUTH_TOKEN"] = "cc-key"
	env["ANTHROPIC_BASE_URL"] = "https://opencode.ai/zen/v1"
	if openCodeGoKeys.find() != "" {
		t.Fatal("zen base taken for go")
	}
	env["ANTHROPIC_BASE_URL"] = "https://opencode.ai/zen/go"
	if openCodeGoKeys.find() != "cc-key" {
		t.Fatal("go base not recognised")
	}

	s.status, s.body = 403, []byte(`{"error":"cc-key revoked"}`)
	if _, err := ps["opencode-go"].Read(ctxAt(testNow)); err == nil {
		t.Fatal("refusal accepted")
	} else {
		wantNoSecret(t, err.Error(), "cc-key")
	}
}

func TestCommandCodeRead(t *testing.T) {
	env, home := isolate(t)
	s := &serve{status: 200, body: fixture(t, "commandcode_credits.json")}
	srv := newServer(t, s)
	setVar(t, &commandCodeBaseURL, srv.URL)

	// the keyed preset: the balance only
	env["COMMANDCODE_API_KEY"] = "cc-studio"
	rs, err := commandCodeProvider{}.Read(ctxAt(testNow))
	if err != nil || len(rs) != 1 {
		t.Fatalf("keyed: %+v %v", rs, err)
	}
	wantBalance(t, &rs[0], 46.2, "USD")
	if req := s.req(); req.URL.Path != "/alpha/billing/credits" || req.Header.Get("Authorization") != "Bearer cc-studio" {
		t.Fatalf("request %s", req.URL.Path)
	}

	// the CLI's sign-in: the plan's windows, named by the account
	if (commandCodePlanProvider{}).Detect() {
		t.Fatal("plan detected without auth.json")
	}
	writeFile(t, filepath.Join(home, ".commandcode", "auth.json"), []byte(`{"apiKey":"cc-cli","userName":"dev"}`))
	rs, err = commandCodePlanProvider{}.Read(ctxAt(testNow))
	if err != nil || strings.Join(windows(rs), ",") != "5h,7d" || rs[0].Account != "dev" || rs[0].Plan != "GOAT" {
		t.Fatalf("plan: %+v %v", rs, err)
	}
	if s.req().Header.Get("Authorization") != "Bearer cc-cli" {
		t.Fatal("plan used the wrong key")
	}
	// an account without a plan reports its balance
	s.body = []byte(`{"credits":{"monthlyCredits":0,"purchasedCredits":7}}`)
	rs, err = commandCodePlanProvider{}.Read(ctxAt(testNow))
	if err != nil || len(rs) != 1 {
		t.Fatalf("no plan: %+v %v", rs, err)
	}
	wantBalance(t, &rs[0], 7, "USD")
	// and the keyed preset errors without a balance
	s.body = []byte(`{"credits":{},"windowLimits":{"fiveHour":{"used":1,"cap":2}}}`)
	if _, err := (commandCodeProvider{}).Read(ctxAt(testNow)); err != errNoBalance {
		t.Fatalf("no balance: %v", err)
	}
}

func TestCopilotRead(t *testing.T) {
	_, home := isolate(t)
	p := copilotProvider{}
	if p.Detect() {
		t.Fatal("detected without a sign-in")
	}
	s := &serve{status: 200, body: fixture(t, "copilot_user.json")}
	srv := newServer(t, s)
	setVar(t, &copilotUserURL, srv.URL+"/copilot_internal/user")

	// the Copilot CLI's config: the last signed-in github.com user
	writeFile(t, filepath.Join(home, ".copilot", "config.json"), []byte(`{
	  "lastLoggedInUser":{"host":"https://github.com","login":"octocat"},
	  "loggedInUsers":[{"host":"https://ghe.example.com","login":"corp"}],
	  "copilotTokens":{"https://github.com:octocat":"gho_CLI"}}`))
	rs, err := p.Read(ctxAt(testNow))
	if err != nil || len(rs) != 1 || rs[0].Account != "octocat" {
		t.Fatalf("cli: %+v %v", rs, err)
	}
	req := s.req()
	if req.Header.Get("Authorization") != "token gho_CLI" || req.Header.Get("Copilot-Integration-Id") != "vscode-chat" || req.Header.Get("Editor-Version") == "" {
		t.Fatal("copilot headers")
	}

	// the editor plugins' apps.json comes first
	writeFile(t, filepath.Join(home, ".config", "github-copilot", "apps.json"),
		[]byte(`{"ghe.example.com:Iv1":{"user":"corp","oauth_token":"gho_GHE"},"github.com:Iv1.b507a08c87ecfe98":{"user":"octo","oauth_token":"gho_APPS"}}`))
	if tok, user := copilotToken(); tok != "gho_APPS" || user != "octo" {
		t.Fatalf("apps.json: %q", user)
	}

	s.status, s.body = 401, []byte(`{"message":"Bad credentials gho_APPS"}`)
	if _, err := p.Read(ctxAt(testNow)); err == nil {
		t.Fatal("refusal accepted")
	} else {
		wantNoSecret(t, err.Error(), "gho_APPS")
	}
}

func TestParseClineLimits(t *testing.T) {
	rs, err := parseClineLimits(fixture(t, "cline_usage_limits.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(windows(rs), ",") != "5h,7d,monthly" || rs[0].Plan != "ClinePass" {
		t.Fatalf("got %+v", rs)
	}
	wantPct(t, &rs[0], 12)
	wantReset(t, &rs[0], time.Date(2026, 10, 20, 15, 0, 0, 0, time.UTC))
	wantPct(t, &rs[1], 41.5)
	if _, err := parseClineLimits([]byte(`{"success":false,"error":"bad key"}`)); err == nil || !strings.Contains(err.Error(), "bad key") {
		t.Fatalf("refusal: %v", err)
	}
}

func TestClinePassRead(t *testing.T) {
	env, _ := isolate(t)
	p := clinePassProvider{}
	if p.Detect() {
		t.Fatal("detected without a key")
	}
	env["CLINE_API_KEY"] = "cline-key"
	limits := fixture(t, "cline_usage_limits.json")
	limitStatus := 200
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if r.Header.Get("X-CLIENT-TYPE") != "cline-desktop" {
			w.WriteHeader(403)
			return
		}
		switch r.URL.Path {
		case "/users/me/plan/usage-limits":
			w.WriteHeader(limitStatus)
			_, _ = w.Write(limits)
		case "/users/me":
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":"usr_1","clineUserId":""}}`))
		case "/users/usr_1/balance":
			_, _ = w.Write([]byte(`{"success":true,"data":{"balance":12340000}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	httpClient = srv.Client()
	setVar(t, &clineBaseURL, srv.URL)

	rs, err := p.Read(ctxAt(testNow))
	if err != nil || strings.Join(windows(rs), ",") != "5h,7d,monthly,balance" || auth != "Bearer cline-key" {
		t.Fatalf("got %+v %v", rs, err)
	}
	wantBalance(t, &rs[3], 12.34, "USD")

	// no ClinePass on the account: the credits alone
	limitStatus = 404
	rs, err = p.Read(ctxAt(testNow))
	if err != nil || len(rs) != 1 {
		t.Fatalf("no plan: %+v %v", rs, err)
	}
	// limits failing otherwise is said beside the balance
	limitStatus = 500
	rs, _ = p.Read(ctxAt(testNow))
	if len(rs) != 2 || find(rs, "", WindowAll) == nil || !strings.Contains(find(rs, "", WindowAll).Error, "http 500") {
		t.Fatalf("limits error: %+v", rs)
	}
}
