//go:build !unix

package bus

import (
	"errors"
	"os"
	"time"
)

// lockFile uses an O_EXCL lock file where flock is unavailable.
func lockFile(path string) (func(), error) {
	path += ".excl"
	for i := 0; i < 600; i++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if st, serr := os.Stat(path); serr == nil && time.Since(st.ModTime()) > 10*time.Minute {
			os.Remove(path) // stale
			continue
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, errors.New("timed out waiting for " + path)
}
