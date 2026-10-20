//go:build !unix && !windows

package hub

import (
	"os/exec"
	"time"
)

type procGroup struct{ cmd *exec.Cmd }

func newProcGroup(cmd *exec.Cmd) *procGroup { return &procGroup{cmd: cmd} }
func (g *procGroup) started() error         { return nil }
func (g *procGroup) kill(time.Duration) {
	if g.cmd.Process != nil {
		_ = g.cmd.Process.Kill()
	}
}
func (g *procGroup) close() {}
