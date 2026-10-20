package quota

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Cursor: magpie retired its built-in Cursor reader (usage now comes from a
// community plugin), so there is nothing to port. When Cursor's agent CLI
// is installed it is reported as unsupported, so the hub knows the gap is
// ours rather than an empty plan.

type cursorProvider struct{}

func (cursorProvider) ID() string { return "cursor" }

// lookPath is exec.LookPath; tests replace it.
var lookPath = exec.LookPath

func (cursorProvider) Detect() bool {
	for _, n := range []string{"cursor-agent", "cursor"} {
		if _, err := lookPath(n); err == nil {
			return true
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	exe := "cursor-agent"
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	return fileExists(filepath.Join(home, ".local", "bin", exe))
}

func (cursorProvider) Read(context.Context) ([]Reading, error) {
	return []Reading{{Window: WindowAll, Error: errUnsupported.Error()}}, nil
}
