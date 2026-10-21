package quota

import (
	"path/filepath"
	"strings"
	"testing"
)

func wantBalance(t *testing.T, r *Reading, amount float64, currency string) {
	t.Helper()
	if r == nil {
		t.Fatalf("missing balance (want %v %s)", amount, currency)
	}
	if r.Balance == nil || r.Balance.Amount != amount || r.Balance.Currency != currency || r.UsedPct != nil || r.ResetsAt != nil {
		t.Fatalf("%s/%s: %+v balance %+v, want %v %s", r.Provider, r.Window, r, r.Balance, amount, currency)
	}
}

func TestParseDeepSeek(t *testing.T) {
	rs, err := parseDeepSeek(fixture(t, "deepseek_balance.json"))
	if err != nil {
		t.Fatal(err)
	}
	// the currency with money left comes first and is "balance"
	if len(rs) != 2 || rs[0].Window != "balance" || rs[1].Window != "balance_usd" {
		t.Fatalf("windows %v", windows(rs))
	}
	wantBalance(t, &rs[0], 110, "CNY")
	wantBalance(t, &rs[1], 0, "USD")
	if _, err := parseDeepSeek([]byte(`{"balance_infos":[]}`)); err != errNoBalance {
		t.Fatalf("empty: %v", err)
	}
	if _, err := parseDeepSeek([]byte(`nope`)); err != errBadReply {
		t.Fatalf("garbage: %v", err)
	}
	rs, _ = parseDeepSeek([]byte(`{"balance_infos":[{"currency":"RMB","total_balance":3.456}]}`))
	wantBalance(t, &rs[0], 3.46, "CNY")
}

func TestParseMoonshotStepFunSiliconFlow(t *testing.T) {
	rs, err := parseMoonshot("USD")(fixture(t, "moonshot_balance.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 49.58, "USD")
	rs, err = parseStepFun("CNY")(fixture(t, "stepfun_accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 26, "CNY")
	rs, err = parseSiliconFlow("CNY")(fixture(t, "siliconflow_info.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 88.88, "CNY")
	if _, err := parseSiliconFlow("CNY")([]byte(`{"code":20092,"message":"deprecated"}`)); err != errSiliconFlowRetired {
		t.Fatalf("retired: %v", err)
	}
	for _, p := range []func([]byte) ([]Reading, error){parseMoonshot("USD"), parseStepFun("CNY"), parseSiliconFlow("CNY")} {
		if _, err := p([]byte(`{}`)); err != errNoBalance {
			t.Fatalf("empty reply: %v", err)
		}
	}
}

func TestParseAiHubMix(t *testing.T) {
	rs, err := parseAiHubMix(fixture(t, "aihubmix_remain.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 12.5, "USD")
	if _, err := parseAiHubMix([]byte(`{"total_usage":-1}`)); err == nil || !strings.Contains(err.Error(), "AIHUBMIX_ACCESS_TOKEN") {
		t.Fatalf("unlimited key: %v", err)
	}
	rs, err = parseAiHubMixAccount(fixture(t, "aihubmix_self.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 5, "USD")
	if _, err := parseAiHubMixAccount([]byte(`{"success":false,"message":"无权进行此操作"}`)); err == nil || err.Error() != "无权进行此操作" {
		t.Fatalf("refused: %v", err)
	}
}

func balanceByID(t *testing.T, id string) balanceProvider {
	t.Helper()
	for _, p := range balanceProviders() {
		if bp, ok := p.(balanceProvider); ok && bp.id == id {
			return bp
		}
	}
	t.Fatalf("no balance provider %s", id)
	return balanceProvider{}
}

func TestBalanceProvidersRead(t *testing.T) {
	const key = "sk-FAKEKEYFAKEKEYFAKEKEY0123"
	for _, c := range []struct {
		id, envVar, fixture, path string
		url                       *string
		amount                    float64
		currency                  string
	}{
		{"deepseek", "DEEPSEEK_API_KEY", "deepseek_balance.json", "/user/balance", &deepSeekBalanceURL, 110, "CNY"},
		{"moonshot", "MOONSHOT_GLOBAL_API_KEY", "moonshot_balance.json", "/v1/users/me/balance", &moonshotBalanceURL, 49.58, "USD"},
		{"moonshot-cn", "MOONSHOT_CN_API_KEY", "moonshot_balance.json", "/v1/users/me/balance", &moonshotCNBalanceURL, 49.58, "CNY"},
		{"siliconflow", "SILICONFLOW_API_KEY", "siliconflow_info.json", "/v1/user/info", &siliconFlowInfoURL, 88.88, "CNY"},
		{"stepfun", "STEPFUN_GLOBAL_API_KEY", "stepfun_accounts.json", "/v1/accounts", &stepFunAccountsURL, 26, "USD"},
		{"stepfun-cn", "STEPFUN_CN_API_KEY", "stepfun_accounts.json", "/v1/accounts", &stepFunCNAccountsURL, 26, "CNY"},
	} {
		t.Run(c.id, func(t *testing.T) {
			env, _ := isolate(t)
			p := balanceByID(t, c.id)
			if p.Detect() {
				t.Fatal("detected without a key")
			}
			if _, err := p.Read(ctxAt(testNow)); err != errNotLoggedIn {
				t.Fatalf("no key: %v", err)
			}
			env[c.envVar] = key
			if !p.Detect() {
				t.Fatal("not detected")
			}
			s := &serve{status: 200, body: fixture(t, c.fixture)}
			srv := newServer(t, s)
			setVar(t, c.url, srv.URL+c.path)
			rs, err := p.Read(ctxAt(testNow))
			if err != nil {
				t.Fatal(err)
			}
			wantBalance(t, &rs[0], c.amount, c.currency)
			if req := s.req(); req.URL.Path != c.path || req.Header.Get("Authorization") != "Bearer "+key {
				t.Fatalf("request %s auth-ok=%v", req.URL.Path, req.Header.Get("Authorization") == "Bearer "+key)
			}
			// a refusal echoing the key never carries it
			s.status, s.body = 401, []byte(`{"error":"invalid key `+key+`"}`)
			_, err = p.Read(ctxAt(testNow))
			if err == nil {
				t.Fatal("refusal accepted")
			}
			wantNoSecret(t, err.Error(), key)
		})
	}
}

func TestBalanceKeySources(t *testing.T) {
	env, home := isolate(t)
	// one MOONSHOT_API_KEY is the global or the China account by its base
	env["MOONSHOT_API_KEY"] = "sk-moon"
	if balanceByID(t, "moonshot").keys.find() != "sk-moon" || balanceByID(t, "moonshot-cn").keys.find() != "" {
		t.Fatal("MOONSHOT_API_KEY without a base is the global account's")
	}
	env["MOONSHOT_BASE_URL"] = "https://api.moonshot.cn/v1"
	if balanceByID(t, "moonshot").keys.find() != "" || balanceByID(t, "moonshot-cn").keys.find() != "sk-moon" {
		t.Fatal("MOONSHOT_BASE_URL .cn not honoured")
	}
	// STEPFUN_API_KEY defaults to the China endpoint
	env["STEPFUN_API_KEY"] = "sk-step"
	if balanceByID(t, "stepfun-cn").keys.find() != "sk-step" || balanceByID(t, "stepfun").keys.find() != "" {
		t.Fatal("STEPFUN_API_KEY default")
	}
	// OpenCode's auth.json; a sign-in that is not an API key is no key
	writeFile(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"),
		[]byte(`{"deepseek":{"type":"api","key":" sk-oc "},"siliconflow-cn":{"type":"oauth","access":"x"}}`))
	if got := balanceByID(t, "deepseek").keys.find(); got != "sk-oc" {
		t.Fatalf("opencode key %q", got)
	}
	if balanceByID(t, "siliconflow").keys.find() != "" {
		t.Fatal("oauth entry used as a key")
	}
	// Claude Code pointed at DeepSeek's Anthropic endpoint
	writeFile(t, filepath.Join(home, ".local", "share", "opencode", "auth.json"), []byte(`{}`))
	env["ANTHROPIC_BASE_URL"] = "https://api.deepseek.com/anthropic"
	env["ANTHROPIC_AUTH_TOKEN"] = "sk-cc"
	env["DEEPSEEK_API_KEY"] = ""
	if got := balanceByID(t, "deepseek").keys.find(); got != "sk-cc" {
		t.Fatalf("anthropic base key %q", got)
	}
}

func TestSiliconFlowRetired(t *testing.T) {
	env, _ := isolate(t)
	env["SILICONFLOW_API_KEY"] = "sk-sf"
	s := &serve{status: 410, body: []byte(`gone`)}
	srv := newServer(t, s)
	setVar(t, &siliconFlowInfoURL, srv.URL+"/v1/user/info")
	if _, err := balanceByID(t, "siliconflow").Read(ctxAt(testNow)); err != errSiliconFlowRetired {
		t.Fatalf("410: %v", err)
	}
}

func TestAiHubMixRead(t *testing.T) {
	env, _ := isolate(t)
	p := aiHubMixProvider{}
	if p.Detect() {
		t.Fatal("detected without a key")
	}
	s := &serve{status: 200, body: fixture(t, "aihubmix_remain.json")}
	srv := newServer(t, s)
	setVar(t, &aiHubMixBaseURL, srv.URL)
	env["AIHUBMIX_API_KEY"] = "sk-ahm"
	rs, err := p.Read(ctxAt(testNow))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 12.5, "USD")
	if req := s.req(); req.URL.Path != "/dashboard/billing/remain" || req.Header.Get("Authorization") != "Bearer sk-ahm" {
		t.Fatalf("key request %s", req.URL.Path)
	}
	// the access token is preferred and sent bare
	env["AIHUBMIX_ACCESS_TOKEN"] = "tok-ahm"
	s.body = fixture(t, "aihubmix_self.json")
	rs, err = p.Read(ctxAt(testNow))
	if err != nil {
		t.Fatal(err)
	}
	wantBalance(t, &rs[0], 5, "USD")
	if req := s.req(); req.URL.Path != "/api/user/self" || req.Header.Get("Authorization") != "tok-ahm" {
		t.Fatalf("token request %s", req.URL.Path)
	}
	s.status, s.body = 401, []byte(`{"message":"bad token tok-ahm"}`)
	if _, err := p.Read(ctxAt(testNow)); err == nil {
		t.Fatal("refusal accepted")
	} else {
		wantNoSecret(t, err.Error(), "tok-ahm")
	}
}
