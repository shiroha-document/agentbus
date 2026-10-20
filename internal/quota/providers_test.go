package quota

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// serve answers every request with status and body, recording the last
// request's path and headers.
type serve struct {
	status int
	body   []byte
	calls  atomic.Int32
	last   atomic.Value // *http.Request (headers only)
}

func newServer(t *testing.T, s *serve) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.calls.Add(1)
		s.last.Store(r.Clone(context.Background()))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(s.status)
		_, _ = w.Write(s.body)
	}))
	t.Cleanup(srv.Close)
	httpClient = srv.Client()
	return srv
}

func (s *serve) req() *http.Request {
	r, _ := s.last.Load().(*http.Request)
	return r
}

func ctxAt(now time.Time) context.Context {
	return withNow(context.Background(), func() time.Time { return now })
}

func TestClaudeProviderRead(t *testing.T) {
	_, home := isolate(t)
	if (claudeProvider{}).Detect() {
		t.Fatal("detected without credentials")
	}
	dir := filepath.Join(home, ".claude")
	creds := fixture(t, "claude_credentials.json")
	writeFile(t, filepath.Join(dir, ".credentials.json"), creds)
	writeFile(t, filepath.Join(dir, ".claude.json"), fixture(t, "claude_account.json"))
	if !(claudeProvider{}).Detect() {
		t.Fatal("not detected")
	}
	s := &serve{status: 200, body: fixture(t, "claude_usage.json")}
	srv := newServer(t, s)
	setVar(t, &claudeUsageURL, srv.URL+"/api/oauth/usage")

	rs, err := claudeProvider{}.Read(ctxAt(testNow))
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 3 {
		t.Fatalf("got %d readings", len(rs))
	}
	for _, r := range rs {
		if r.Account != "dev@example.com" || r.Plan != "max" || r.ReadAt != testNow.UnixMilli() {
			t.Fatalf("%s: account %q plan %q read_at %d", r.Window, r.Account, r.Plan, r.ReadAt)
		}
	}
	req := s.req()
	if req.URL.Path != "/api/oauth/usage" || req.Header.Get("Authorization") != "Bearer sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKE" || req.Header.Get("anthropic-beta") != "oauth-2025-04-20" {
		t.Fatalf("request %s auth-ok=%v beta=%q", req.URL.Path, strings.HasPrefix(req.Header.Get("Authorization"), "Bearer "), req.Header.Get("anthropic-beta"))
	}

	// an undocumented endpoint that fails reads as unknown
	s.status, s.body = 500, []byte(`{"error":"token sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKE rejected"}`)
	_, err = claudeProvider{}.Read(ctxAt(testNow))
	if err == nil || err.Error() != "unknown: http 500" {
		t.Fatalf("err %v", err)
	}
	s.status, s.body = 200, []byte(`<html>`)
	if _, err = (claudeProvider{}).Read(ctxAt(testNow)); err == nil || err.Error() != "unknown: unexpected reply" {
		t.Fatalf("err %v", err)
	}

	// an expired token is not refreshed and the endpoint is not called
	before := s.calls.Load()
	if _, err = (claudeProvider{}).Read(ctxAt(time.Date(2100, 1, 2, 0, 0, 0, 0, time.UTC))); err == nil || err.Error() != "token expired" {
		t.Fatalf("err %v", err)
	}
	if s.calls.Load() != before {
		t.Fatal("expired token was sent")
	}
}

func TestPlanProvidersRead(t *testing.T) {
	cases := []struct {
		id, envVar string
		url        *string
		path, auth string
		fixture    string
		windows    []string
	}{
		{"zhipu", "ZHIPU_API_KEY", &zhipuBaseURL, "/api/monitor/usage/quota/limit", "FAKEKEY-zhipu", "zhipu.json", []string{"5h", "7d", "mcp_monthly"}},
		{"zai", "ZAI_API_KEY", &zaiBaseURL, "/api/monitor/usage/quota/limit", "FAKEKEY-zai", "zhipu.json", []string{"5h", "7d", "mcp_monthly"}},
		{"kimi-code", "KIMI_CODE_API_KEY", &kimiGlobalBaseURL, "/coding/v1/usages", "Bearer FAKEKEY-kimi-code", "kimi.json", []string{"5h", "7d"}},
		{"kimi-code-cn", "KIMI_CODE_CN_API_KEY", &kimiCNBaseURL, "/coding/v1/usages", "Bearer FAKEKEY-kimi-code-cn", "kimi.json", []string{"5h", "7d"}},
		{"minimax", "MINIMAX_API_KEY", &minimaxBaseURL, "/v1/token_plan/remains", "Bearer FAKEKEY-minimax", "minimax.json", []string{"5h", "7d", "video_1d"}},
		{"minimax-cn", "MINIMAX_CN_API_KEY", &minimaxCNBaseURL, "/v1/token_plan/remains", "Bearer FAKEKEY-minimax-cn", "minimax.json", []string{"5h", "7d", "video_1d"}},
	}
	for _, c := range cases {
		t.Run(c.id, func(t *testing.T) {
			env, _ := isolate(t)
			var p Provider
			for _, q := range planProviders() {
				if q.ID() == c.id {
					p = q
				}
			}
			if p == nil || p.Detect() {
				t.Fatal("missing, or detected without a key")
			}
			env[c.envVar] = "FAKEKEY-" + c.id
			if !p.Detect() {
				t.Fatal("not detected")
			}
			s := &serve{status: 200, body: fixture(t, c.fixture)}
			srv := newServer(t, s)
			base := srv.URL
			if strings.Contains(c.path, "/coding/v1") {
				base += "/coding/v1"
			}
			setVar(t, c.url, base)
			rs, err := p.Read(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(windows(rs), ","); got != strings.Join(c.windows, ",") {
				t.Fatalf("windows %s", got)
			}
			if r := s.req(); r.URL.Path != c.path || r.Header.Get("Authorization") != c.auth {
				t.Fatalf("path %s, auth as expected: %v", r.URL.Path, r.Header.Get("Authorization") == c.auth)
			}
			// a failure never carries the key
			s.status, s.body = 401, []byte(`{"msg":"bad key FAKEKEY-`+c.id+`"}`)
			_, err = p.Read(context.Background())
			if err == nil || err.Error() != "unknown: http 401" {
				t.Fatalf("err %v", err)
			}
		})
	}
}

func TestPlanRefusalSanitized(t *testing.T) {
	env, _ := isolate(t)
	key := "FAKEKEY-minimax-0123456789"
	env["MINIMAX_API_KEY"] = key
	s := &serve{status: 200, body: []byte(`{"base_resp":{"status_code":1004,"status_msg":"login fail for ` + key + ` at https://api.minimax.io/v1/x?key=abc"}}`)}
	srv := newServer(t, s)
	setVar(t, &minimaxBaseURL, srv.URL)
	var p Provider
	for _, q := range planProviders() {
		if q.ID() == "minimax" {
			p = q
		}
	}
	_, err := p.Read(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "unknown: login fail") {
		t.Fatalf("err %v", err)
	}
	wantNoSecret(t, err.Error(), key, "?key=", "abc", "/v1/x")
}

func TestPlanKeyFromClaudeSettings(t *testing.T) {
	env, home := isolate(t)
	// a GLM plan wired into Claude Code through its settings' env block
	writeFile(t, filepath.Join(home, ".claude", "settings.json"),
		[]byte(`{"env":{"ANTHROPIC_BASE_URL":"https://open.bigmodel.cn/api/anthropic","ANTHROPIC_AUTH_TOKEN":"FAKEKEY-settings"}}`))
	zhipu := keySource{env: []string{"ZHIPU_API_KEY"}, hosts: []string{"open.bigmodel.cn"}}
	kimi := keySource{env: []string{"KIMI_CODE_API_KEY"}, hosts: []string{"api.kimi.ai"}}
	if got := zhipu.find(); got != "FAKEKEY-settings" {
		t.Fatalf("zhipu key %q", got)
	}
	if got := kimi.find(); got != "" {
		t.Fatal("key given to the wrong host")
	}
	// the environment wins over the settings file
	env["ANTHROPIC_BASE_URL"] = "https://open.bigmodel.cn/api/anthropic"
	env["ANTHROPIC_AUTH_TOKEN"] = "FAKEKEY-env"
	if got := zhipu.find(); got != "FAKEKEY-env" {
		t.Fatalf("zhipu key %q", got)
	}
	env["ZHIPU_API_KEY"] = "FAKEKEY-dedicated"
	if got := zhipu.find(); got != "FAKEKEY-dedicated" {
		t.Fatalf("zhipu key %q", got)
	}
	// kimi-cli's own pair
	env["KIMI_API_KEY"] = "FAKEKEY-kimi-cli"
	if got := kimiCLIKey("api.kimi.com", "api.kimi.com")(); got != "FAKEKEY-kimi-cli" {
		t.Fatalf("kimi-cli default host: %q", got)
	}
	env["KIMI_BASE_URL"] = "https://api.kimi.ai/coding/v1"
	if kimiCLIKey("api.kimi.com", "api.kimi.com")() != "" || kimiCLIKey("api.kimi.com", "api.kimi.ai")() != "FAKEKEY-kimi-cli" {
		t.Fatal("kimi-cli key given to the wrong region")
	}
}

func TestOpenRouterProviderRead(t *testing.T) {
	env, _ := isolate(t)
	if (openRouterProvider{}).Detect() {
		t.Fatal("detected without a key")
	}
	env["OPENROUTER_API_KEY"] = "sk-or-v1-FAKEFAKEFAKE"
	s := &serve{status: 200, body: fixture(t, "openrouter.json")}
	srv := newServer(t, s)
	setVar(t, &openRouterBaseURL, srv.URL+"/api/v1")
	rs, err := openRouterProvider{}.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 1 || rs[0].Window != "balance" || *rs[0].Balance != (Balance{16.54, "USD"}) {
		t.Fatalf("got %+v", rs)
	}
	if r := s.req(); r.URL.Path != "/api/v1/credits" || r.Header.Get("Authorization") != "Bearer sk-or-v1-FAKEFAKEFAKE" {
		t.Fatalf("path %s", r.URL.Path)
	}
}

func TestGeminiProviderRead(t *testing.T) {
	_, home := isolate(t)
	dir := filepath.Join(home, ".gemini")
	if (geminiProvider{}).Detect() {
		t.Fatal("detected without a sign-in")
	}
	writeFile(t, filepath.Join(dir, "oauth_creds.json"), []byte(`{"access_token":"ya29.FAKEFAKE","refresh_token":"fake","expiry_date":4102444800000}`))
	writeFile(t, filepath.Join(dir, "google_accounts.json"), []byte(`{"active":"dev@example.com","old":[]}`))
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer ya29.FAKEFAKE" {
			w.WriteHeader(400)
			return
		}
		switch r.URL.Path {
		case "/v1internal:loadCodeAssist":
			_, _ = w.Write(fixture(t, "gemini_load.json"))
		case "/v1internal:retrieveUserQuota":
			_, _ = w.Write(fixture(t, "gemini_quota.json"))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	httpClient = srv.Client()
	setVar(t, &geminiCodeAssistURL, srv.URL)
	if !(geminiProvider{}).Detect() {
		t.Fatal("not detected")
	}
	rs, err := geminiProvider{}.Read(ctxAt(testNow))
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 2 || rs[1].Window != "gemini-2.5-pro" || rs[1].Account != "dev@example.com" || rs[1].Plan != "free-tier" {
		t.Fatalf("got %+v", rs)
	}
	if strings.Join(paths, ",") != "/v1internal:loadCodeAssist,/v1internal:retrieveUserQuota" {
		t.Fatalf("calls %v", paths)
	}
}

func TestCursorUnsupported(t *testing.T) {
	isolate(t)
	if (cursorProvider{}).Detect() {
		t.Fatal("detected without cursor")
	}
	lookPath = func(name string) (string, error) { return "/fake/bin/" + name, nil }
	if !(cursorProvider{}).Detect() {
		t.Fatal("not detected")
	}
	rs, _ := cursorProvider{}.Read(context.Background())
	if len(rs) != 1 || rs[0].Error != "unsupported" || rs[0].Window != WindowAll {
		t.Fatalf("got %+v", rs)
	}
}
