//go:build unix

package main

import (
	"os/exec"
	"syscall"
	"time"
)

func setProcessGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killGroup sends SIGTERM to the command's process group, then SIGKILL.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	go func() {
		time.Sleep(10 * time.Second)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}()
}
