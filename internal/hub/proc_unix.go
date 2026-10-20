//go:build unix

package hub

import (
	"os/exec"
	"syscall"
	"time"
)

// procGroup puts the child in its own process group so a timeout kills the
// whole tree.
type procGroup struct{ cmd *exec.Cmd }

func newProcGroup(cmd *exec.Cmd) *procGroup {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &procGroup{cmd: cmd}
}

// started is called right after cmd.Start.
func (g *procGroup) started() error { return nil }

// kill sends SIGTERM to the group, then SIGKILL after grace.
func (g *procGroup) kill(grace time.Duration) {
	if g.cmd.Process == nil {
		return
	}
	pid := g.cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	go func() {
		time.Sleep(grace)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}()
}

// close releases resources (and kills leftovers of the group).
func (g *procGroup) close() {
	if g.cmd.Process != nil {
		_ = syscall.Kill(-g.cmd.Process.Pid, syscall.SIGKILL)
	}
}
