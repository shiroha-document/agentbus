//go:build windows

package hub

import (
	"os/exec"
	"strconv"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// procGroup assigns the child to a Job Object with KILL_ON_JOB_CLOSE so a
// timeout (or our own exit) kills the whole process tree. When the job
// can't be created, kill falls back to `taskkill /T /F`.
type procGroup struct {
	cmd *exec.Cmd
	job windows.Handle
}

func newProcGroup(cmd *exec.Cmd) *procGroup {
	g := &procGroup{cmd: cmd}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return g
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return g
	}
	g.job = job
	return g
}

func (g *procGroup) started() error {
	if g.job == 0 || g.cmd.Process == nil {
		return nil
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(g.cmd.Process.Pid))
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(g.job, h); err != nil {
		windows.CloseHandle(g.job)
		g.job = 0
	}
	return nil
}

func (g *procGroup) kill(time.Duration) {
	if g.job != 0 {
		_ = windows.TerminateJobObject(g.job, 1)
		return
	}
	if g.cmd.Process != nil {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(g.cmd.Process.Pid)).Run()
		_ = g.cmd.Process.Kill()
	}
}

func (g *procGroup) close() {
	if g.job != 0 {
		windows.CloseHandle(g.job)
		g.job = 0
	}
}
