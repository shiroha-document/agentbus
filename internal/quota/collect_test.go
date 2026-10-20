package quota

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func reading(provider, account, window, source string, used float64, readAt time.Time, errMsg string) Reading {
	r := Reading{Provider: provider, Account: account, Window: window, Source: source, ReadAt: readAt.UnixMilli(), Error: errMsg}
	if errMsg == "" {
		r.UsedPct = f64(used)
	}
	return r
}

func TestMergeAuto(t *testing.T) {
	fresh := testNow.Add(-time.Minute)
	stale := testNow.Add(-11 * time.Minute)
	magpieAt := testNow.Add(-30 * time.Second)
	native := []Reading{
		reading("claude", "dev@example.com", "5h", SourceNative, 10, fresh, ""),   // fresh: wins
		reading("claude", "dev@example.com", "7d", SourceNative, 11, stale, ""),   // stale: magpie's
		reading("codex", "", "5h", SourceNative, 12, fresh, "unknown: http 500"),  // error: magpie's
		reading("zhipu", "", "5h", SourceNative, 13, stale, ""),                   // stale, magpie errs: kept
		reading("gemini", "", WindowAll, SourceNative, 0, fresh, "token expired"), // provider-wide error
		reading("kimi-code", "", "5h", SourceNative, 14, fresh, ""),
	}
	magpie := []Reading{
		reading("claude", "dev@example.com", "5h", SourceMagpie, 40, magpieAt, ""),
		reading("claude", "dev@example.com", "7d", SourceMagpie, 20, magpieAt, ""),
		reading("claude", "dev@example.com", "7d_opus", SourceMagpie, 5, magpieAt, ""), // missing natively
		reading("codex", "dev@example.com · Team", "5h", SourceMagpie, 50, magpieAt, ""),
		reading("zhipu", "", "5h", SourceMagpie, 0, magpieAt, "http 401"),
		reading("gemini", "", "gemini-2.5-pro", SourceMagpie, 25, magpieAt, ""),
		reading("kimi-code", "", WindowAll, SourceMagpie, 0, magpieAt, "network error"), // noise
		reading("copilot", "", "premium_requests_monthly", SourceMagpie, 33, magpieAt, ""),
	}
	out := mergeAuto(native, magpie, testNow)
	sortReadings(out)
	check := func(provider, window, source string, used float64) {
		t.Helper()
		r := find(out, provider, window)
		if r == nil || r.Source != source {
			t.Fatalf("%s/%s: got %+v, want source %s", provider, window, r, source)
		}
		if find(out, provider, window, map[string]string{SourceNative: SourceMagpie, SourceMagpie: SourceNative}[source]) != nil {
			t.Fatalf("%s/%s reported twice", provider, window)
		}
		wantPct(t, r, used)
	}
	check("claude", "5h", SourceNative, 10)
	check("claude", "7d", SourceMagpie, 20)
	check("claude", "7d_opus", SourceMagpie, 5)
	check("codex", "5h", SourceMagpie, 50)
	check("zhipu", "5h", SourceNative, 13)
	check("gemini", "gemini-2.5-pro", SourceMagpie, 25)
	check("kimi-code", "5h", SourceNative, 14)
	check("copilot", "premium_requests_monthly", SourceMagpie, 33)
	if find(out, "gemini", WindowAll) != nil {
		t.Fatal("native provider-wide error kept next to magpie's windows")
	}
	if find(out, "kimi-code", WindowAll) != nil {
		t.Fatal("magpie provider-wide error kept next to a native reading")
	}
	if len(out) != 8 {
		t.Fatalf("got %d readings: %v", len(out), windows(out))
	}
}

func TestMergeAutoBothErrors(t *testing.T) {
	n := []Reading{reading("x", "", "5h", SourceNative, 0, testNow.Add(-time.Minute), "timeout")}
	newer := []Reading{reading("x", "", "5h", SourceMagpie, 0, testNow, "http 500")}
	older := []Reading{reading("x", "", "5h", SourceMagpie, 0, testNow.Add(-time.Hour), "http 500")}
	if out := mergeAuto(n, newer, testNow); len(out) != 1 || out[0].Source != SourceMagpie {
		t.Fatalf("newer error should win: %+v", out)
	}
	if out := mergeAuto(n, older, testNow); len(out) != 1 || out[0].Source != SourceNative {
		t.Fatalf("older error should lose: %+v", out)
	}
}

// stubMagpie makes magpie "installed" and answer with out.
func stubMagpie(t *testing.T, out []byte) *[]string {
	t.Helper()
	var got []string
	bin := filepath.Join(t.TempDir(), "magpie")
	writeFile(t, bin, []byte("not run"))
	lookPath = func(name string) (string, error) {
		if name == "magpie" {
			return bin, nil
		}
		return "", os.ErrNotExist
	}
	runMagpie = func(_ context.Context, b string, args ...string) ([]byte, error) {
		got = append([]string{b}, args...)
		return out, errors.New("exit status 1") // output is used anyway
	}
	return &got
}

func TestCollectModes(t *testing.T) {
	isolate(t)
	stale := testNow.Add(-20 * time.Minute)
	restore := setRegistry([]Provider{
		fakeProvider{id: "claude", detected: true, read: func(context.Context) ([]Reading, error) {
			return []Reading{
				{Window: "5h", UsedPct: f64(10)},
				{Window: "7d", UsedPct: f64(11), ReadAt: stale.UnixMilli()},
			}, nil
		}},
		fakeProvider{id: "codex", detected: true, read: func(context.Context) ([]Reading, error) {
			return nil, errors.New("unknown: http 503")
		}},
		fakeProvider{id: "gemini", detected: true, read: func(context.Context) ([]Reading, error) { return nil, errNotLoggedIn }},
		fakeProvider{id: "cursor", detected: false, read: func(context.Context) ([]Reading, error) { panic("not detected: never read") }},
	})
	defer restore()
	args := stubMagpie(t, fixture(t, "magpie_quota.json"))

	native := Collect(context.Background(), Options{Source: SourceNative, Now: fixedNow})
	if len(native) != 3 || find(native, "codex", WindowAll).Error != "unknown: http 503" || find(native, "gemini", WindowAll) != nil {
		t.Fatalf("native: %+v", native)
	}
	if r := find(native, "claude", "5h"); r.Source != SourceNative || r.ReadAt != testNow.UnixMilli() {
		t.Fatalf("native reading not stamped: %+v", r)
	}
	if len(*args) != 0 {
		t.Fatal("magpie ran in native mode")
	}

	mag := Collect(context.Background(), Options{Source: SourceMagpie, Now: fixedNow})
	if strings.Join((*args)[1:], " ") != "quota --json" {
		t.Fatalf("magpie args %v", *args)
	}
	for _, r := range mag {
		if r.Source != SourceMagpie {
			t.Fatalf("magpie mode returned %+v", r)
		}
	}

	both := Collect(context.Background(), Options{Source: SourceBoth, Now: fixedNow})
	if len(both) != len(native)+len(mag) {
		t.Fatalf("both: %d readings, want %d", len(both), len(native)+len(mag))
	}
	if r := both[0]; r.Provider != "claude" || r.Window != "5h" || r.Source != SourceNative {
		t.Fatalf("both not sorted native first: %+v", r)
	}

	auto := Collect(context.Background(), Options{Now: fixedNow})
	for _, c := range []struct{ provider, window, source string }{
		{"claude", "5h", SourceNative}, // fresh native
		{"claude", "7d", SourceMagpie}, // stale native
		{"claude", "7d_opus", SourceMagpie},
		{"codex", "5h", SourceMagpie}, // native error -> magpie
		{"deepseek", "balance", SourceMagpie},
	} {
		if r := find(auto, c.provider, c.window); r == nil || r.Source != c.source {
			t.Fatalf("auto %s/%s: %+v, want %s", c.provider, c.window, r, c.source)
		}
	}
	if find(auto, "codex", WindowAll) != nil {
		t.Fatal("auto kept the native codex error")
	}

	// Providers limits both sources
	only := Collect(context.Background(), Options{Source: SourceBoth, Providers: []string{"Claude"}, Now: fixedNow})
	for _, r := range only {
		if r.Provider != "claude" {
			t.Fatalf("Providers filter let %s through", r.Provider)
		}
	}
	if len(only) != 2+3 {
		t.Fatalf("got %d claude readings", len(only))
	}
}

func TestCollectNoMagpie(t *testing.T) {
	isolate(t)
	defer setRegistry(nil)()
	ran := false
	runMagpie = func(context.Context, string, ...string) ([]byte, error) { ran = true; return nil, nil }
	if rs := Collect(context.Background(), Options{Source: SourceMagpie}); rs != nil || ran {
		t.Fatalf("missing magpie: %+v ran=%v", rs, ran)
	}
	if rs := Collect(context.Background(), Options{Source: SourceMagpie, MagpiePath: filepath.Join(t.TempDir(), "nope")}); rs != nil || ran {
		t.Fatalf("missing MagpiePath: %+v", rs)
	}
	// an explicit path is used; output that isn't JSON gives nothing
	bin := filepath.Join(t.TempDir(), "magpie-bin")
	writeFile(t, bin, nil)
	runMagpie = func(_ context.Context, b string, _ ...string) ([]byte, error) {
		ran = b == bin
		return []byte("magpie: no providers configured\n"), nil
	}
	if rs := Collect(context.Background(), Options{Source: SourceAuto, MagpiePath: bin}); len(rs) != 0 || !ran {
		t.Fatalf("bad output: %+v ran=%v", rs, ran)
	}
}

func TestCollectTimeout(t *testing.T) {
	isolate(t)
	block := make(chan struct{})
	defer close(block)
	restore := setRegistry([]Provider{
		// honours its context
		fakeProvider{id: "slow", detected: true, read: func(ctx context.Context) ([]Reading, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}},
		// ignores it altogether
		fakeProvider{id: "stuck", detected: true, read: func(context.Context) ([]Reading, error) {
			<-block
			return nil, nil
		}},
		fakeProvider{id: "fast", detected: true, read: func(context.Context) ([]Reading, error) {
			return []Reading{{Window: "5h", UsedPct: f64(1)}}, nil
		}},
	})
	defer restore()
	// magpie hangs too, ignoring its context
	stubMagpie(t, nil)
	runMagpie = func(context.Context, string, ...string) ([]byte, error) {
		<-block
		return nil, nil
	}
	const limit = 300 * time.Millisecond
	start := time.Now()
	rs := Collect(context.Background(), Options{Timeout: limit, Now: fixedNow})
	if took := time.Since(start); took > limit+100*time.Millisecond {
		t.Fatalf("Collect took %v with Timeout %v", took, limit)
	}
	if r := find(rs, "fast", "5h"); r == nil {
		t.Fatalf("fast reading lost: %+v", rs)
	}
	for _, id := range []string{"slow", "stuck"} {
		if r := find(rs, id, WindowAll); r == nil || r.Error != "timeout" {
			t.Fatalf("%s: %+v", id, r)
		}
	}

	// a caller's own deadline is honoured as well
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start = time.Now()
	Collect(ctx, Options{Source: SourceNative, Timeout: 10 * time.Second})
	if took := time.Since(start); took > 300*time.Millisecond {
		t.Fatalf("caller deadline ignored: %v", took)
	}
}

type panicky struct{ inID bool }

func (p panicky) ID() string {
	if p.inID {
		panic("id")
	}
	return "boom"
}
func (panicky) Detect() bool                            { return true }
func (panicky) Read(context.Context) ([]Reading, error) { panic("read") }

func TestCollectPanics(t *testing.T) {
	isolate(t)
	defer setRegistry([]Provider{panicky{}, panicky{inID: true}, nil})()
	rs := Collect(context.Background(), Options{Source: SourceNative, Now: fixedNow})
	if len(rs) != 1 || rs[0].Provider != "boom" || rs[0].Error != "unknown: reader failed" {
		t.Fatalf("got %+v", rs)
	}
	// a magpie runner that panics gives no readings, not a crash
	stubMagpie(t, nil)
	runMagpie = func(context.Context, string, ...string) ([]byte, error) { panic("magpie") }
	if rs := Collect(context.Background(), Options{Source: SourceMagpie}); rs != nil {
		t.Fatalf("got %+v", rs)
	}
	// nil context
	//lint:ignore SA1012 a nil context must not crash Collect
	_ = Collect(nil, Options{Source: SourceNative}) //nolint:staticcheck
}

func TestMagpieReadings(t *testing.T) {
	rs, err := magpieReadings(fixture(t, "magpie_quota.json"), testNow)
	if err != nil {
		t.Fatal(err)
	}
	sortReadings(rs)
	want := map[[2]string]float64{
		{"claude", "5h"}:                        40,
		{"claude", "7d"}:                        20,
		{"claude", "7d_opus"}:                   5,
		{"codex", "5h"}:                         50,
		{"codex", "7d"}:                         18,
		{"copilot", "premium_requests_monthly"}: 33.3,
		{"zhipu", "5h"}:                         12,
		{"zhipu", "mcp_monthly"}:                3,
	}
	for k, used := range want {
		wantPct(t, find(rs, k[0], k[1]), used)
	}
	c5 := find(rs, "claude", "5h")
	if c5.Account != "dev@example.com" || c5.Plan != "max" || c5.Source != SourceMagpie ||
		c5.ReadAt != time.Date(2026, 10, 20, 11, 59, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("claude 5h: %+v", c5)
	}
	wantReset(t, c5, time.Date(2026, 10, 20, 15, 0, 0, 0, time.UTC))
	if r := find(rs, "claude", "7d_opus"); r.ResetsAt != nil {
		t.Fatal("reset invented")
	}
	if r := find(rs, "codex", "5h"); r.ReadAt != time.Date(2026, 10, 20, 11, 50, 0, 0, time.UTC).UnixMilli() || r.Account != "dev@example.com · Team" {
		t.Fatalf("codex: %+v", r)
	}
	if r := find(rs, "copilot", "premium_requests_monthly"); r.ReadAt != testNow.UnixMilli() {
		t.Fatal("a card without a time is not read now")
	}
	for p, b := range map[string]Balance{"deepseek": {88.5, "CNY"}, "openrouter": {16.54, "USD"}, "commandcode": {1200, "credits"}} {
		r := find(rs, p, "balance")
		if r == nil || r.Balance == nil || *r.Balance != b || r.UsedPct != nil {
			t.Fatalf("%s balance: %+v", p, r)
		}
	}
	for _, c := range []struct{ provider, window string }{{"moonshot", "balance"}, {"gemini", WindowAll}} {
		r := find(rs, c.provider, c.window)
		if r == nil || r.Error == "" || r.UsedPct != nil {
			t.Fatalf("%s error: %+v", c.provider, r)
		}
		wantNoSecret(t, r.Error, "sk-FAKE", "ya29", "?token", "abc", "/v1/users")
	}
	if len(rs) != len(want)+3+2 {
		t.Fatalf("got %d readings", len(rs))
	}
	// JSON field names follow hub-api.md
	b, _ := json.Marshal(find(rs, "deepseek", "balance"))
	for _, k := range []string{`"provider":"deepseek"`, `"window":"balance"`, `"used_pct":null`, `"resets_at":null`, `"balance":{"amount":88.5,"currency":"CNY"}`, `"source":"magpie"`, `"read_at":`} {
		if !strings.Contains(string(b), k) {
			t.Fatalf("%s lacks %s", b, k)
		}
	}
	if _, err := magpieReadings([]byte("no json here"), testNow); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestSanitize(t *testing.T) {
	cases := []struct {
		in      string
		secrets []string
		leaks   []string
	}{
		{"Get \"https://user:pw@api.example.com/v1/usage?key=SECRETQ&x=1\": dial tcp", nil, []string{"user:pw", "/v1/usage", "SECRETQ", "?key"}},
		{"Authorization: Bearer abc.def.ghi failed", nil, []string{"abc.def.ghi"}},
		{"api_key=hunter2hunter2 refused", nil, []string{"hunter2"}},
		{"token: \"tok_123456\"", nil, []string{"tok_123456"}},
		{"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here", nil, []string{"eyJhbGci", "c2lnbmF0dXJl"}},
		{"bad key sk-ant-api03-ABCDEFGHIJ", nil, []string{"ABCDEFGHIJ"}},
		{"opaque 0123456789abcdef0123456789abcdef0123 end", nil, []string{"0123456789abcdef0123456789abcdef"}},
		{"plain secret mykey99 echoed", []string{"mykey99"}, []string{"mykey99"}},
		{"line\nbreak\x00", nil, []string{"\n", "\x00"}},
	}
	for _, c := range cases {
		got := sanitize(c.in, c.secrets...)
		wantNoSecret(t, got, c.leaks...)
	}
	if got := sanitize("Get \"https://api.example.com/v1/x?token=abc\": timeout"); !strings.Contains(got, "https://api.example.com") {
		t.Fatalf("host lost: %q", got)
	}
	if got := sanitize(strings.Repeat("é", 500)); len([]rune(got)) > 201 {
		t.Fatalf("not truncated: %d runes", len([]rune(got)))
	}
	if got := sanitize("login fail: 令牌已过期"); got != "login fail: 令牌已过期" {
		t.Fatalf("harmless text changed: %q", got)
	}
}

// TestReaderErrorsSanitized: whatever a reader returns, a native Error has
// no token or query string in it.
func TestReaderErrorsSanitized(t *testing.T) {
	isolate(t)
	defer setRegistry([]Provider{
		fakeProvider{id: "leaky", detected: true, read: func(context.Context) ([]Reading, error) {
			return nil, errors.New(`Get "https://api.example.com/usage?access_token=SECRETSECRET": Bearer sk-live-SECRETSECRET`)
		}},
		fakeProvider{id: "leaky2", detected: true, read: func(context.Context) ([]Reading, error) {
			return []Reading{{Window: "5h", Error: "refresh_token=SECRETSECRET"}}, nil
		}},
	})()
	for _, r := range Collect(context.Background(), Options{Source: SourceNative}) {
		wantNoSecret(t, r.Error, "SECRETSECRET", "?access_token", "/usage")
		if r.Error == "" {
			t.Fatalf("%s: error lost", r.Provider)
		}
	}
}

func TestRegister(t *testing.T) {
	defer setRegistry(nil)()
	Register(fakeProvider{id: "a"})
	Register(fakeProvider{id: "b"})
	Register(fakeProvider{id: "a", detected: true})
	Register(nil)
	ps := Registered()
	if len(ps) != 2 || !ps[0].Detect() {
		t.Fatalf("registry %+v", ps)
	}
}

func TestBuiltinRegistry(t *testing.T) {
	want := []string{"claude", "codex", "gemini", "cursor", "openrouter", "zhipu", "zai", "kimi-code", "kimi-code-cn", "minimax", "minimax-cn"}
	var got []string
	for _, p := range builtinProviders() {
		got = append(got, p.ID())
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("builtin %v", got)
	}
}
