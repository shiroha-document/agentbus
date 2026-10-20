//go:build darwin

package quota

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"strings"
	"time"
)

// claudeKeychainOff lets tests keep the real keychain out of reach.
var claudeKeychainOff = false

func claudeKeychainAvailable() bool {
	if claudeKeychainOff {
		return false
	}
	_, err := exec.LookPath("security")
	return err == nil
}

// claudeKeychainService is the keychain item Claude Code keeps its sign-in
// in: "Claude Code-credentials", or with CLAUDE_CONFIG_DIR set that name
// and the first 8 hex digits of the directory's SHA-256.
func claudeKeychainService() string {
	const base = "Claude Code-credentials"
	d := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
	if d == "" {
		return base
	}
	sum := sha256.Sum256([]byte(d))
	return base + "-" + hex.EncodeToString(sum[:])[:8]
}

// claudeKeychainRead runs `security find-generic-password -s <service> -w`
// directly (no shell). Its output is the secret and is never logged.
func claudeKeychainRead(ctx context.Context, _ string) ([]byte, bool) {
	if !claudeKeychainAvailable() {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "security", "find-generic-password", "-s", claudeKeychainService(), "-w")
	cmd.Stderr = nil
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	out = bytes.TrimSpace(out)
	return out, len(out) > 0
}
