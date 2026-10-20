// Package adapter knows how to run each supported coding-agent CLI headless
// (Claude Code, Codex, Cursor, Gemini, or a user-defined template) and how to
// read token usage and the final answer back from its structured output.
//
// Adapters only build argv: commands are always executed directly, never via
// a shell.
package adapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
)

// Permission tiers (hub.md §7).
const (
	TierReadonly  = "readonly"
	TierWorkspace = "workspace"
	TierFull      = "full"
)

// Usage is one round's token accounting. JSON names match the hub contract
// (docs/design/hub-api.md, Usage). Input excludes cached tokens; total input
// is Input+CacheWrite+CacheRead.
type Usage struct {
	Input      int64    `json:"input"`
	CacheWrite int64    `json:"cache_write"`
	CacheRead  int64    `json:"cache_read"`
	Output     int64    `json:"output"`
	Reasoning  int64    `json:"reasoning"`
	CostUSD    *float64 `json:"cost_usd_est"`
	DurationMS int64    `json:"duration_ms"`
	Model      *string  `json:"model"`
}

// TotalInput is input including cache reads and writes.
func (u Usage) TotalInput() int64 { return u.Input + u.CacheWrite + u.CacheRead }

// Total is every token counted.
func (u Usage) Total() int64 { return u.TotalInput() + u.Output + u.Reasoning }

// Result is what an adapter could read from the CLI's stdout.
type Result struct {
	Usage   Usage
	Known   bool   // Usage was actually reported by the CLI
	Text    string // final answer of the agent
	IsError bool   // the CLI reported a failed round
	Err     string // short error description when IsError
}

// Options are the per-run knobs.
type Options struct {
	Tier string // readonly | workspace | full (default workspace)
	// Binary overrides the executable (absolute path or name on PATH).
	Binary string
	// PromptFile is a file holding the prompt, for templates that want it.
	PromptFile string
	// Template is the custom adapter's command line, e.g.
	// `mycli run --input {prompt_file} --json`.
	Template string
	// UsagePaths maps usage fields (input, cache_write, cache_read, output,
	// reasoning, cost_usd, model, text, is_error) to dotted JSON paths in the
	// custom CLI's final JSON object.
	UsagePaths map[string]string
	// LookPath is injectable for tests (default exec.LookPath).
	LookPath func(string) (string, error)
}

func (o Options) tier() string {
	switch o.Tier {
	case TierReadonly, TierFull:
		return o.Tier
	}
	return TierWorkspace
}

func (o Options) lookPath() func(string) (string, error) {
	if o.LookPath != nil {
		return o.LookPath
	}
	return exec.LookPath
}

// Spec is a fully built command: run Path with Args, feeding Stdin.
type Spec struct {
	Path  string
	Args  []string
	Stdin string
}

// Adapter is one CLI.
type Adapter interface {
	Name() string
	// Binaries lists executable names to look for, in preference order.
	Binaries() []string
	Build(prompt string, o Options) (Spec, error)
	Parse(stdout []byte) Result
}

var registry = map[string]Adapter{
	"claude": claude{},
	"codex":  codex{},
	"cursor": cursor{},
	"gemini": gemini{},
	"custom": custom{},
}

// Get returns the adapter for a CLI name.
func Get(name string) (Adapter, error) {
	a, ok := registry[strings.ToLower(strings.TrimSpace(name))]
	if !ok {
		return nil, fmt.Errorf("unknown cli %q (want claude, codex, cursor, gemini or custom)", name)
	}
	return a, nil
}

// Names lists the supported CLIs.
func Names() []string {
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Resolve finds the executable for a: o.Binary when set, else the first of
// a.Binaries() on PATH.
func Resolve(a Adapter, o Options) (string, error) {
	lp := o.lookPath()
	if o.Binary != "" {
		return lp(o.Binary)
	}
	var firstErr error
	for _, b := range a.Binaries() {
		p, err := lp(b)
		if err == nil {
			return p, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("%s: no binary configured", a.Name())
	}
	return "", firstErr
}

// ---- JSON helpers ----

// lastJSONObject returns the last top-level JSON object in out: the whole
// output when it is one object, else the last line that parses as one.
func lastJSONObject(out []byte) map[string]any {
	var m map[string]any
	t := bytes.TrimSpace(out)
	if len(t) > 0 && t[0] == '{' && json.Unmarshal(t, &m) == nil {
		return m
	}
	lines := bytes.Split(t, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		if len(l) == 0 || l[0] != '{' {
			continue
		}
		m = nil
		if json.Unmarshal(l, &m) == nil {
			return m
		}
	}
	return nil
}

// path walks a dotted path ("usage.input_tokens") in v.
func path(v any, p string) (any, bool) {
	if p == "" {
		return nil, false
	}
	cur := v
	for _, k := range strings.Split(p, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		if cur, ok = m[k]; !ok {
			return nil, false
		}
	}
	return cur, true
}

func num(v any, p string) (int64, bool) {
	x, ok := path(v, p)
	if !ok {
		return 0, false
	}
	switch n := x.(type) {
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	}
	return 0, false
}

func flt(v any, p string) (float64, bool) {
	x, ok := path(v, p)
	if !ok {
		return 0, false
	}
	f, ok := x.(float64)
	return f, ok
}

func str(v any, p string) string {
	x, _ := path(v, p)
	s, _ := x.(string)
	return s
}

func boolean(v any, p string) bool {
	x, _ := path(v, p)
	b, _ := x.(bool)
	return b
}

func ptrF(f float64) *float64 { return &f }
func ptrS(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// firstNum returns the first of several paths that holds a number.
func firstNum(v any, ps ...string) (int64, bool) {
	for _, p := range ps {
		if n, ok := num(v, p); ok {
			return n, true
		}
	}
	return 0, false
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
