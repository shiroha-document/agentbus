package hub

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/shiroha-document/agentbus/internal/adapter"
)

// BaselinePrompt is the trivial prompt used to measure the fixed cost of
// waking the CLI (system prompt, tool definitions, project files).
const BaselinePrompt = "This is a calibration run. Do not use any tools. Reply with exactly: OK"

// BaselineOptions controls Baseline.
type BaselineOptions struct {
	Runs     int           // default 2
	Timeout  time.Duration // per run, default 5m
	LookPath func(string) (string, error)
	Now      func() time.Time
}

// Baseline runs the configured CLI o.Runs times with BaselinePrompt in the
// per-agent work dir and returns the run with the smallest total input as a
// Run record (thread_id null, error_summary "baseline"), plus every parsed
// result.
func Baseline(ctx context.Context, dir string, cfg *Config, o BaselineOptions) (*Run, []adapter.Result, error) {
	if o.Runs <= 0 {
		o.Runs = 2
	}
	if o.Timeout <= 0 {
		o.Timeout = 5 * time.Minute
	}
	now := o.Now
	if now == nil {
		now = time.Now
	}
	ad, err := adapter.Get(cfg.CLI)
	if err != nil {
		return nil, nil, err
	}
	p := Paths{dir}
	promptFile := filepath.Join(p.Prompts(), "baseline.md")
	_ = os.MkdirAll(filepath.Dir(promptFile), 0o700)
	if err := os.WriteFile(promptFile, []byte(BaselinePrompt), 0o600); err != nil {
		return nil, nil, err
	}
	opts := adapter.Options{Tier: cfg.Tier, Binary: cfg.CLIBinary, PromptFile: promptFile,
		Template: cfg.CLITemplate, UsagePaths: cfg.CLIUsagePaths, LookPath: o.LookPath}
	spec, err := ad.Build(BaselinePrompt, opts)
	if err != nil {
		return nil, nil, err
	}
	work := filepath.Join(p.Work(), "baseline")
	if err := os.MkdirAll(work, 0o700); err != nil {
		return nil, nil, err
	}
	env := childEnv(map[string]string{"AGENTBUS_HUB_HOME": dir, "AGENTBUS_IN_TICK": "1", "AGENTBUS_BASELINE": "1"})
	var best *Run
	var results []adapter.Result
	var lastErr error
	for i := 0; i < o.Runs; i++ {
		started := now()
		res := RunSpec(ctx, spec, ExecOptions{Dir: work, Env: env, Timeout: o.Timeout, Grace: 5 * time.Second})
		parsed := adapter.ParseWith(ad, res.Stdout, opts)
		results = append(results, parsed)
		if res.TimedOut || res.Err != nil || res.ExitCode != 0 || parsed.IsError || !parsed.Known {
			if !parsed.Known && res.ExitCode == 0 && res.Err == nil && !res.TimedOut {
				lastErr = fmt.Errorf("%s did not report token usage", cfg.CLI)
			} else {
				lastErr = errors.New(errorSummary(res, parsed))
			}
			continue
		}
		u := parsed.Usage
		r := &Run{ID: NewID("r", started), MemberID: cfg.MemberID, StartedAt: started.UnixMilli(), EndedAt: now().UnixMilli(),
			CLI: cfg.CLI, Model: u.Model, Input: u.Input, CacheWrite: u.CacheWrite, CacheRead: u.CacheRead,
			Output: u.Output, Reasoning: u.Reasoning, CostUSD: u.CostUSD, ErrorSummary: ptr("baseline")}
		if best == nil || u.TotalInput() < best.Input+best.CacheWrite+best.CacheRead {
			best = r
		}
		if ctx.Err() != nil {
			break
		}
	}
	if best == nil {
		if lastErr == nil {
			lastErr = errors.New("no run completed")
		}
		return nil, results, fmt.Errorf("baseline: %w", lastErr)
	}
	return best, results, nil
}
