package update

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeReleases serves a GitHub-like release layout without a listener.
type fakeReleases struct {
	tag   string
	files map[string][]byte
	gets  []string
}

func (f *fakeReleases) RoundTrip(r *http.Request) (*http.Response, error) {
	f.gets = append(f.gets, r.URL.Path)
	resp := &http.Response{StatusCode: 404, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: r}
	switch {
	case r.URL.Path == "/o/r/releases/latest" && f.tag != "":
		resp.StatusCode = 302
		resp.Header.Set("Location", "https://example.test/o/r/releases/tag/"+f.tag)
	case strings.HasPrefix(r.URL.Path, "/o/r/releases/download/"+f.tag+"/"):
		if b, ok := f.files[filepath.Base(r.URL.Path)]; ok {
			resp.StatusCode = 200
			resp.Body = io.NopCloser(bytes.NewReader(b))
		}
	}
	return resp, nil
}

func newFake(tag string, bins map[string][]byte) *fakeReleases {
	f := &fakeReleases{tag: tag, files: map[string][]byte{}}
	var sums strings.Builder
	for n, b := range bins {
		s := sha256.Sum256(b)
		sums.WriteString(hex.EncodeToString(s[:]) + "  " + n + "\n")
		f.files[n] = b
	}
	f.files["SHA256SUMS"] = []byte(sums.String())
	return f
}

func TestLatestAndFetch(t *testing.T) {
	name := AssetName("linux", "amd64")
	f := newFake("v0.4.1", map[string][]byte{name: []byte("new-binary")})
	u := &Updater{Base: "https://example.test/o/r", HTTP: &http.Client{Transport: f}}
	ctx := context.Background()
	tag, err := u.Latest(ctx)
	if err != nil || tag != "v0.4.1" {
		t.Fatalf("latest = %q, %v", tag, err)
	}
	bin, err := u.Fetch(ctx, tag, "linux", "amd64")
	if err != nil || string(bin) != "new-binary" {
		t.Fatalf("fetch = %q, %v", bin, err)
	}
	if _, err := u.Fetch(ctx, tag, "plan9", "mips"); err == nil || !strings.Contains(err.Error(), "no build") {
		t.Fatalf("missing platform: %v", err)
	}
	// tampered binary
	f.files[name] = []byte("evil")
	if _, err := u.Fetch(ctx, tag, "linux", "amd64"); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered: %v", err)
	}
	// no release yet
	u2 := &Updater{Base: "https://example.test/o/r", HTTP: &http.Client{Transport: &fakeReleases{}}}
	if _, err := u2.Latest(ctx); err == nil {
		t.Fatal("expected error without releases")
	}
}

func TestInstall(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "agentbus")
	if err := os.WriteFile(exe, []byte("old"), 0o750); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}
	// failed self-check leaves the old binary in place
	err := Install(link, []byte("bad"), func(string) error { return io.ErrUnexpectedEOF })
	if err == nil {
		t.Fatal("expected verify failure")
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatalf("binary replaced despite failed check: %q", b)
	}
	var seen string
	if err := Install(link, []byte("new"), func(p string) error { seen = p; return nil }); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new" {
		t.Fatalf("got %q", b)
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o111 == 0 {
		t.Fatalf("not executable: %v", st.Mode())
	}
	if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink was replaced instead of its target")
	}
	if _, err := os.Stat(seen); !os.IsNotExist(err) {
		t.Fatal("staged file left behind")
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 2 {
		t.Fatalf("leftovers: %v", ents)
	}
}

func TestVersions(t *testing.T) {
	cases := []struct {
		latest, cur string
		newer       bool
	}{
		{"v0.3.0", "0.2.0", true},
		{"v0.3.0", "v0.3.0", false},
		{"v0.10.0", "v0.9.9", true},
		{"v1.0.0", "v1.0.1", false},
		{"v0.3.1", "v0.3.1-rc1", false},
		{"v9.9.9", "dev", false},
		{"garbage", "v0.1.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.latest, c.cur); got != c.newer {
			t.Errorf("Newer(%q,%q) = %v", c.latest, c.cur, got)
		}
	}
	if !SameMajor("v1.2.0", "v1.9.3") || SameMajor("v0.2.0", "v0.3.0") || !SameMajor("v0.3.0", "v0.3.7") || SameMajor("v1.0.0", "v2.0.0") {
		t.Error("SameMajor")
	}
}

func TestState(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x", "update.json")
	if s := LoadState(p); !s.CheckedAt.IsZero() {
		t.Fatal("zero state expected")
	}
	SaveState(p, State{Latest: "v1.2.3"})
	if s := LoadState(p); s.Latest != "v1.2.3" {
		t.Fatalf("got %+v", s)
	}
}
