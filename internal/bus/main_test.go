package bus

import (
	"os"
	"testing"
)

// Background `git gc --auto` / maintenance can still be writing .git/objects when
// t.TempDir cleanup runs, which makes RemoveAll fail intermittently on CI.
func TestMain(m *testing.M) {
	os.Setenv("GIT_CONFIG_COUNT", "3")
	os.Setenv("GIT_CONFIG_KEY_0", "gc.auto")
	os.Setenv("GIT_CONFIG_VALUE_0", "0")
	os.Setenv("GIT_CONFIG_KEY_1", "maintenance.auto")
	os.Setenv("GIT_CONFIG_VALUE_1", "false")
	os.Setenv("GIT_CONFIG_KEY_2", "gc.autoDetach")
	os.Setenv("GIT_CONFIG_VALUE_2", "false")
	os.Exit(m.Run())
}
