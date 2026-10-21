package hub

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/shiroha-document/agentbus/internal/adapter"
)

// ExecResult is the outcome of running one CLI round.
type ExecResult struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
	TimedOut bool
	Duration time.Duration
	Err      error // failure to start / wait (not a non-zero exit)
}

// ExecOptions controls RunSpec.
type ExecOptions struct {
	Dir     string
	Env     []string
	Timeout time.Duration
	// Every, when > 0, calls Tick periodically while the command runs
	// (heartbeats).
	Every time.Duration
	Tick  func()
	// Grace between SIGTERM and SIGKILL on timeout (default 10s).
	Grace time.Duration
	// MaxOutput caps captured stdout/stderr each (default 32 MiB).
	MaxOutput int
}

// RunSpec executes s directly (never via a shell) with a timeout that kills
// the whole process tree.
func RunSpec(ctx context.Context, s adapter.Spec, o ExecOptions) ExecResult {
	start := time.Now()
	cmd := exec.Command(s.Path, s.Args...)
	cmd.Dir = o.Dir
	cmd.Env = o.Env
	if len(s.Env) > 0 {
		base := cmd.Env
		if base == nil {
			base = os.Environ()
		}
		cmd.Env = append(append([]string{}, base...), s.Env...)
	}
	if s.Stdin != "" {
		cmd.Stdin = strings.NewReader(s.Stdin)
	}
	max := o.MaxOutput
	if max <= 0 {
		max = 32 << 20
	}
	var stdout, stderr capBuf
	stdout.max, stderr.max = max, max
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	g := newProcGroup(cmd)
	defer g.close()
	if err := cmd.Start(); err != nil {
		return ExecResult{Err: err, ExitCode: -1, Duration: time.Since(start)}
	}
	_ = g.started()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 20 * time.Minute
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var tickC <-chan time.Time
	if o.Every > 0 && o.Tick != nil {
		t := time.NewTicker(o.Every)
		defer t.Stop()
		tickC = t.C
	}
	grace := o.Grace
	if grace <= 0 {
		grace = 10 * time.Second
	}
	res := ExecResult{}
	var werr error
loop:
	for {
		select {
		case werr = <-done:
			break loop
		case <-tickC:
			go o.Tick()
		case <-timer.C:
			res.TimedOut = true
			g.kill(grace)
			werr = waitOr(done, grace+5*time.Second)
			break loop
		case <-ctx.Done():
			g.kill(grace)
			werr = waitOr(done, grace+5*time.Second)
			if res.Err == nil {
				res.Err = ctx.Err()
			}
			break loop
		}
	}
	res.Duration = time.Since(start)
	res.Stdout, res.Stderr = stdout.Bytes(), stderr.Bytes()
	var ee *exec.ExitError
	switch {
	case werr == nil:
		res.ExitCode = 0
	case errors.As(werr, &ee):
		res.ExitCode = ee.ExitCode()
	default:
		res.ExitCode = -1
		if res.Err == nil && !res.TimedOut {
			res.Err = werr
		}
	}
	if res.TimedOut {
		res.ExitCode = 124
	}
	return res
}

func waitOr(done chan error, d time.Duration) error {
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		return errors.New("process did not exit after kill")
	}
}

// capBuf is a goroutine-safe buffer that keeps at most max bytes (the head;
// the rest is dropped).
type capBuf struct {
	mu  sync.Mutex
	b   bytes.Buffer
	max int
}

func (c *capBuf) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := c.max - c.b.Len(); room > 0 {
		if len(p) > room {
			c.b.Write(p[:room])
		} else {
			c.b.Write(p)
		}
	}
	return len(p), nil
}

func (c *capBuf) Bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.b.Bytes()...)
}

var _ io.Writer = (*capBuf)(nil)

// childEnv is os.Environ plus extra, with extra keys replacing existing
// ones (case-insensitively on Windows).
func childEnv(extra map[string]string) []string {
	env := os.Environ()
	out := env[:0:0]
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if _, ok := lookupFold(extra, k); ok {
			continue
		}
		out = append(out, kv)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		out = append(out, k+"="+extra[k])
	}
	return out
}

func lookupFold(m map[string]string, k string) (string, bool) {
	if v, ok := m[k]; ok {
		return v, true
	}
	if isWindows() {
		for mk, v := range m {
			if strings.EqualFold(mk, k) {
				return v, true
			}
		}
	}
	return "", false
}
