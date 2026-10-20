//go:build unix

package main

import (
	"os"
	"syscall"
)

// reexecProcess replaces this process with the binary at path, keeping pid,
// stdio and environment. It only returns on failure.
func reexecProcess(path string, argv []string) (int, error) {
	return 0, syscall.Exec(path, append([]string{path}, argv...), os.Environ())
}
