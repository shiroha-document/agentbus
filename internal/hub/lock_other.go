//go:build !unix && !windows

package hub

import (
	"os"
	"path/filepath"
	"time"
)

// TryLock uses an O_EXCL lock file where neither flock nor LockFileEx exist.
func TryLock(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	path += ".excl"
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if st, serr := os.Stat(path); serr == nil && time.Since(st.ModTime()) > 2*time.Hour {
			os.Remove(path) // stale
			continue
		}
		break
	}
	return nil, ErrLocked
}

func isWindows() bool { return false }
