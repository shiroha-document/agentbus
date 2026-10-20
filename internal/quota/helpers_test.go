package quota

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testNow is the clock every test runs at.
var testNow = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

func fixedNow() time.Time { return testNow }

// isolate keeps a test away from this machine's real sign-ins and keys:
// home and the CLIs' config dirs point at an empty temp dir, keys come from
// the returned map only, PATH lookups fail, the keychain is off and magpie
// is not run unless the test stubs it.
func isolate(t *testing.T) (env map[string]string, home string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("GOOGLE_CLOUD_PROJECT", "")
	env = map[string]string{}
	oldEnv, oldLook, oldKC, oldClient, oldRun := lookupEnv, lookPath, claudeKeychainOff, httpClient, runMagpie
	lookupEnv = func(k string) string { return env[k] }
	lookPath = func(string) (string, error) { return "", exec.ErrNotFound }
	claudeKeychainOff = true
	runMagpie = func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New("magpie not stubbed")
	}
	t.Cleanup(func() {
		lookupEnv, lookPath, claudeKeychainOff, httpClient, runMagpie = oldEnv, oldLook, oldKC, oldClient, oldRun
	})
	return env, home
}

// setVar points a URL var at a test server for the test's duration.
func setVar(t *testing.T, v *string, val string) {
	t.Helper()
	old := *v
	*v = val
	t.Cleanup(func() { *v = old })
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func writeFile(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// find returns the reading of provider/window (and source, when given).
func find(rs []Reading, provider, window string, source ...string) *Reading {
	for i := range rs {
		r := &rs[i]
		if r.Provider == provider && r.Window == window && (len(source) == 0 || r.Source == source[0]) {
			return r
		}
	}
	return nil
}

func windows(rs []Reading) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.Window
	}
	return out
}

func wantPct(t *testing.T, r *Reading, want float64) {
	t.Helper()
	if r == nil {
		t.Fatalf("missing reading (want %v%%)", want)
	}
	if r.UsedPct == nil {
		t.Fatalf("%s/%s: used_pct nil, want %v", r.Provider, r.Window, want)
	}
	if d := *r.UsedPct - want; d > 1e-9 || d < -1e-9 {
		t.Fatalf("%s/%s: used_pct %v, want %v", r.Provider, r.Window, *r.UsedPct, want)
	}
}

func wantReset(t *testing.T, r *Reading, want time.Time) {
	t.Helper()
	if r.ResetsAt == nil {
		t.Fatalf("%s/%s: resets_at nil, want %v", r.Provider, r.Window, want)
	}
	if *r.ResetsAt != want.UnixMilli() {
		t.Fatalf("%s/%s: resets_at %v, want %v", r.Provider, r.Window, time.UnixMilli(*r.ResetsAt).UTC(), want)
	}
}

func wantNoSecret(t *testing.T, s string, secrets ...string) {
	t.Helper()
	for _, sec := range secrets {
		if sec != "" && strings.Contains(s, sec) {
			t.Fatalf("%q leaks %q", s, sec)
		}
	}
}

// fakeProvider is a scripted Provider.
type fakeProvider struct {
	id       string
	detected bool
	read     func(ctx context.Context) ([]Reading, error)
}

func (p fakeProvider) ID() string   { return p.id }
func (p fakeProvider) Detect() bool { return p.detected }
func (p fakeProvider) Read(ctx context.Context) ([]Reading, error) {
	return p.read(ctx)
}
