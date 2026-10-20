package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/shiroha-document/agentbus/internal/update"
)

// releaseRedirect answers /releases/latest like GitHub does and serves the
// assets of that release.
type releaseRedirect struct {
	tag    string
	files  map[string][]byte
	checks *atomic.Int32
}

func (f releaseRedirect) RoundTrip(r *http.Request) (*http.Response, error) {
	h := http.Header{}
	code := 404
	body := []byte{}
	switch {
	case strings.HasSuffix(r.URL.Path, "/releases/latest"):
		if f.checks != nil {
			f.checks.Add(1)
		}
		code = 302
		h.Set("Location", "https://rel.test/o/r/releases/tag/"+f.tag)
	case strings.Contains(r.URL.Path, "/releases/download/"+f.tag+"/"):
		if b, ok := f.files[filepath.Base(r.URL.Path)]; ok {
			code, body = 200, b
		}
	}
	return &http.Response{StatusCode: code, Header: h, Body: io.NopCloser(bytes.NewReader(body)), Request: r}, nil
}

func fakeRelease(tag string, bin []byte) releaseRedirect {
	name := update.AssetName(runtime.GOOS, runtime.GOARCH)
	s := sha256.Sum256(bin)
	return releaseRedirect{tag: tag, checks: &atomic.Int32{}, files: map[string][]byte{
		name:         bin,
		"SHA256SUMS": []byte(hex.EncodeToString(s[:]) + "  " + name + "\n"),
	}}
}

func TestAutoUpdateBeforeEveryCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake binary is a shell script")
	}
	home := t.TempDir()
	t.Setenv("AGENTBUS_HOME", home)
	t.Setenv("AGENTBUS_UPDATE_BASE", "https://rel.test/o/r")
	t.Setenv("AGENTBUS_AUTO_UPDATE", "")
	t.Setenv("AGENTBUS_UPDATE_EVERY", "")
	t.Setenv(reexecEnv, "")
	t.Setenv("GITHUB_ACTIONS", "")
	t.Setenv("CI", "")
	newBin := []byte("#!/bin/sh\necho 0.4.0\n")
	rel := fakeRelease("v0.4.0", newBin)
	old := http.DefaultTransport
	http.DefaultTransport = rel
	defer func() { http.DefaultTransport = old }()
	exe := filepath.Join(t.TempDir(), "agentbus")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho 0.3.2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	var gotPath string
	var gotArgv []string
	oldV, oldExe, oldRe := version, executable, reexec
	defer func() { version, executable, reexec = oldV, oldExe, oldRe }()
	executable = func() (string, error) { return exe, nil }
	reexec = func(p string, argv []string) (int, error) { gotPath, gotArgv = p, argv; return 7, nil }

	version = "0.4.0"
	if code, out := run(t, "self-update", "--check"); code != exitNothing || !strings.Contains(out, "up to date") {
		t.Fatalf("up to date: %d %s", code, out)
	}
	version = "0.3.2"
	if code, out := run(t, "self-update", "--check"); code != 0 || !strings.Contains(out, "v0.4.0 is available") {
		t.Fatalf("newer: %d %s", code, out)
	}

	// any command, even across a 0.x minor: install, then re-run argv on the new binary
	os.Remove(updateStatePath())
	code, out := run(t, "--json", "agents", "--x")
	if code != 7 || gotPath != exe || strings.Join(gotArgv, " ") != "--json agents --x" {
		t.Fatalf("reexec: code=%d path=%q argv=%q out=%s", code, gotPath, gotArgv, out)
	}
	if !strings.Contains(out, "updated 0.3.2 -> v0.4.0 (commands may have changed)") {
		t.Fatalf("stderr: %s", out)
	}
	if b, _ := os.ReadFile(exe); !bytes.Equal(b, newBin) {
		t.Fatalf("binary not replaced: %q", b)
	}
	if os.Getenv(reexecEnv) != "0.3.2" {
		t.Fatal("re-exec guard not set for the child")
	}

	// the re-executed child skips the check and clears the guard
	var errw bytes.Buffer
	c := &cli{out: io.Discard, errw: &errw}
	if done, _ := c.autoUpdate("inbox", nil); done || os.Getenv(reexecEnv) != "" {
		t.Fatal("child must not update again")
	}

	// cached: a second command within AGENTBUS_UPDATE_EVERY makes no request
	n := rel.checks.Load()
	gotPath = ""
	if done, _ := c.autoUpdate("inbox", nil); done || rel.checks.Load() != n || gotPath != "" {
		t.Fatal("check should be cached")
	}
	// AGENTBUS_UPDATE_EVERY=0 checks every call
	t.Setenv("AGENTBUS_UPDATE_EVERY", "0")
	version = "0.4.0"
	c.autoUpdate("inbox", nil)
	if rel.checks.Load() != n+1 {
		t.Fatal("UPDATE_EVERY=0 should check every call")
	}

	// notify only announces
	version = "0.3.2"
	t.Setenv("AGENTBUS_AUTO_UPDATE", "notify")
	errw.Reset()
	if done, _ := c.autoUpdate("inbox", nil); done || !strings.Contains(errw.String(), "v0.4.0 is available") {
		t.Fatalf("notify: %q", errw.String())
	}
	// off, self-update, CI: nothing at all
	errw.Reset()
	t.Setenv("AGENTBUS_AUTO_UPDATE", "")
	c.autoUpdate("self-update", nil)
	t.Setenv("CI", "true")
	c.autoUpdate("inbox", nil)
	t.Setenv("CI", "")
	t.Setenv("AGENTBUS_AUTO_UPDATE", "off")
	c.autoUpdate("inbox", nil)
	if errw.Len() != 0 {
		t.Fatalf("unexpected output: %q", errw.String())
	}

	// a broken release never fails the command
	t.Setenv("AGENTBUS_AUTO_UPDATE", "")
	bad := fakeRelease("v0.4.0", newBin)
	bad.files[update.AssetName(runtime.GOOS, runtime.GOARCH)] = []byte("tampered")
	http.DefaultTransport = bad
	errw.Reset()
	if done, _ := c.autoUpdate("inbox", nil); done || !strings.Contains(errw.String(), "continuing with 0.3.2") {
		t.Fatalf("bad release: %q", errw.String())
	}
}
