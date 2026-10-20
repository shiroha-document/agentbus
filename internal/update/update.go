// Package update keeps the agentbus binary current from the GitHub Releases
// of the public code repo. It needs no token and no API quota: the latest tag
// is read from the /releases/latest redirect, binaries and SHA256SUMS come
// from /releases/download/<tag>/.
package update

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// DefaultBase is the release page of the public code repo.
const DefaultBase = "https://github.com/shiroha-document/agentbus"

// Base returns the release base URL (override with AGENTBUS_UPDATE_BASE for
// mirrors and tests).
func Base() string {
	if b := strings.TrimSpace(os.Getenv("AGENTBUS_UPDATE_BASE")); b != "" {
		return strings.TrimRight(b, "/")
	}
	return DefaultBase
}

// AssetName is the release asset for this platform: agentbus-linux-amd64,
// agentbus-windows-arm64.exe, ...
func AssetName(goos, goarch string) string {
	n := "agentbus-" + goos + "-" + goarch
	if goos == "windows" {
		n += ".exe"
	}
	return n
}

// Updater talks to one release base.
type Updater struct {
	Base string
	HTTP *http.Client
}

// New returns an updater for Base() with sane timeouts.
func New() *Updater { return &Updater{Base: Base(), HTTP: &http.Client{Timeout: 2 * time.Minute}} }

func (u *Updater) client() *http.Client {
	if u.HTTP != nil {
		return u.HTTP
	}
	return http.DefaultClient
}

// Latest returns the newest release tag (e.g. "v0.3.1").
func (u *Updater) Latest(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u.Base+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	c := *u.client()
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	i := strings.LastIndex(loc, "/tag/")
	if resp.StatusCode/100 != 3 || i < 0 {
		return "", fmt.Errorf("update: no published release at %s (HTTP %d)", u.Base, resp.StatusCode)
	}
	tag := loc[i+len("/tag/"):]
	if _, ok := Parse(tag); !ok {
		return "", fmt.Errorf("update: latest release tag %q is not a version", tag)
	}
	return tag, nil
}

func (u *Updater) get(ctx context.Context, tag, name string, max int64) ([]byte, error) {
	url := u.Base + "/releases/download/" + tag + "/" + name
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("update: GET %s: HTTP %d", url, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("update: %s is larger than %d bytes", name, max)
	}
	return data, nil
}

// Fetch downloads this platform's binary for tag and verifies it against the
// release's SHA256SUMS.
func (u *Updater) Fetch(ctx context.Context, tag, goos, goarch string) ([]byte, error) {
	name := AssetName(goos, goarch)
	sums, err := u.get(ctx, tag, "SHA256SUMS", 64<<10)
	if err != nil {
		return nil, err
	}
	want := ""
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return nil, fmt.Errorf("update: release %s has no build for %s/%s", tag, goos, goarch)
	}
	bin, err := u.get(ctx, tag, name, 200<<20)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(bin)
	if got := hex.EncodeToString(sum[:]); got != want {
		return nil, fmt.Errorf("update: checksum mismatch for %s (got %s, want %s)", name, got[:12], want[:min(12, len(want))])
	}
	return bin, nil
}

// Install atomically replaces the executable at path with bin. verify, if
// set, runs against the staged file before it goes live.
func Install(path string, bin []byte, verify func(staged string) error) error {
	if p, err := filepath.EvalSymlinks(path); err == nil {
		path = p
	}
	dir := filepath.Dir(path)
	mode := os.FileMode(0o755)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm() | 0o111
	}
	f, err := os.CreateTemp(dir, ".agentbus-update-*")
	if err != nil {
		return fmt.Errorf("update: cannot write next to %s (%w); reinstall with install.sh into a directory you own", path, err)
	}
	staged := f.Name()
	defer os.Remove(staged)
	if _, err := f.Write(bin); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(staged, mode); err != nil {
		return err
	}
	if verify != nil {
		if err := verify(staged); err != nil {
			return fmt.Errorf("update: new binary failed its self-check: %w", err)
		}
	}
	if runtime.GOOS == "windows" {
		// a running .exe cannot be overwritten, but it can be renamed away
		old := path + ".old"
		_ = os.Remove(old)
		if err := os.Rename(path, old); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Rename(staged, path)
}

// ---- versions ----

// Parse reads "v1.2.3" / "1.2.3" / "1.2.3-rc1" into [major minor patch].
// Pre-release suffixes are ignored for ordering; "dev" builds do not parse.
func Parse(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Newer reports whether latest is a higher version than current. A current
// version that does not parse (a dev build) is never considered outdated.
func Newer(latest, current string) bool {
	l, ok1 := Parse(latest)
	c, ok2 := Parse(current)
	if !ok1 || !ok2 {
		return false
	}
	for i := range l {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

// SameMajor reports whether both versions share a major version (for 0.x,
// the minor version too, since 0.x minors may break).
func SameMajor(a, b string) bool {
	x, ok1 := Parse(a)
	y, ok2 := Parse(b)
	if !ok1 || !ok2 || x[0] != y[0] {
		return false
	}
	return x[0] != 0 || x[1] == y[1]
}

// ---- throttled background check ----

// State is cached at $AGENTBUS_HOME/update.json.
type State struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest,omitempty"`
}

// LoadState reads the cache; a missing or broken file is a zero State.
func LoadState(path string) State {
	var s State
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

// SaveState writes the cache (best effort).
func SaveState(path string, s State) {
	b, _ := json.Marshal(s)
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}
