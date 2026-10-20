//go:build !darwin

package quota

import "context"

// claudeKeychainOff is unused off macOS; it exists so tests build anywhere.
var claudeKeychainOff = false

func claudeKeychainAvailable() bool { return false }

func claudeKeychainRead(context.Context, string) ([]byte, bool) { return nil, false }
