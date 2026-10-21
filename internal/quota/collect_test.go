package quota

import (
	"context"
	"errors"
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

	native := Collect(context.Background(), Options{Source: SourceNative, Now: fixedNow})
	if len(native) != 3 || find(native, "codex", WindowAll).Error != "unknown: http 503" || find(native, "gemini", WindowAll) != nil {
		t.Fatalf("native: %+v", native)
	}
	if r := find(native, "claude", "5h"); r.Source != SourceNative || r.ReadAt != testNow.UnixMilli() {
		t.Fatalf("native reading not stamped: %+v", r)
	}
	if r := find(native, "claude", "7d"); r.ReadAt != stale.UnixMilli() {
		t.Fatalf("reader's own time lost: %+v", r)
	}

	// every other mode, deprecated or unknown, reads natively too
	for _, mode := range []string{"", SourceAuto, SourceMagpie, SourceBoth, "bogus"} {
		got := Collect(context.Background(), Options{Source: mode, MagpiePath: "/nonexistent/magpie", Now: fixedNow})
		if len(got) != len(native) {
			t.Fatalf("mode %q: %+v", mode, got)
		}
		for i := range got {
			if got[i].Provider != native[i].Provider || got[i].Window != native[i].Window || got[i].Source != SourceNative {
				t.Fatalf("mode %q: %+v", mode, got[i])
			}
		}
	}

	// Providers limits collection
	only := Collect(context.Background(), Options{Providers: []string{"Claude"}, Now: fixedNow})
	if len(only) != 2 || only[0].Provider != "claude" || only[0].Window != "5h" {
		t.Fatalf("Providers filter: %+v", only)
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
	// nil context
	//lint:ignore SA1012 a nil context must not crash Collect
	_ = Collect(nil, Options{Source: SourceNative}) //nolint:staticcheck
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
	want := []string{"claude", "codex", "gemini", "cursor", "openrouter", "zhipu", "zai", "kimi-code", "kimi-code-cn", "minimax", "minimax-cn",
		"deepseek", "moonshot", "moonshot-cn", "siliconflow", "stepfun", "stepfun-cn", "aihubmix",
		"ollama-cloud", "opencode-go", "commandcode", "commandcode-plan", "copilot", "clinepass"}
	var got []string
	for _, p := range builtinProviders() {
		got = append(got, p.ID())
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("builtin %v", got)
	}
}
