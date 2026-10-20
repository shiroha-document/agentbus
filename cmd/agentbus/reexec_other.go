//go:build !unix

package main

import (
	"errors"
	"os"
	"os/exec"
)

// reexecProcess runs the binary at path as a child with our stdio and
// returns its exit code (Windows has no exec(2)).
func reexecProcess(path string, argv []string) (int, error) {
	cmd := exec.Command(path, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, nil
}
