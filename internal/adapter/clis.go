package adapter

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// ---- Claude Code ----

type claude struct{}

func (claude) Name() string       { return "claude" }
func (claude) Binaries() []string { return []string{"claude"} }

func (a claude) Build(prompt string, o Options) (Spec, error) {
	bin, err := Resolve(a, o)
	if err != nil {
		return Spec{}, err
	}
	args := []string{"-p", "--output-format", "json"}
	switch o.tier() {
	case TierReadonly:
		args = append(args, "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob")
	case TierFull:
		args = append(args, "--dangerously-skip-permissions")
	default:
		args = append(args, "--permission-mode", "acceptEdits",
			"--allowedTools", "Read,Edit,Write,Grep,Glob,Bash(git *),Bash(agentbus *)")
	}
	return Spec{Path: bin, Args: args, Stdin: prompt}, nil
}

// Parse reads `claude -p --output-format json`: one result object with
// usage, modelUsage, total_cost_usd, result and is_error.
func (claude) Parse(out []byte) Result {
	m := lastJSONObject(out)
	if m == nil {
		return Result{IsError: true, Err: "no JSON result in output", Text: truncate(string(out), 4000)}
	}
	r := Result{Text: str(m, "result"), IsError: boolean(m, "is_error")}
	if st := str(m, "subtype"); st != "" && st != "success" {
		r.IsError = true
		r.Err = st
	}
	if r.IsError && r.Err == "" {
		r.Err = truncate(r.Text, 300)
	}
	if _, ok := path(m, "usage"); ok {
		r.Known = true
		r.Usage.Input, _ = num(m, "usage.input_tokens")
		r.Usage.CacheWrite, _ = num(m, "usage.cache_creation_input_tokens")
		r.Usage.CacheRead, _ = num(m, "usage.cache_read_input_tokens")
		r.Usage.Output, _ = num(m, "usage.output_tokens")
	}
	if c, ok := flt(m, "total_cost_usd"); ok {
		r.Usage.CostUSD = ptrF(c)
	} else if c, ok := flt(m, "cost_usd"); ok {
		r.Usage.CostUSD = ptrF(c)
	}
	if d, ok := num(m, "duration_ms"); ok {
		r.Usage.DurationMS = d
	}
	if mu, ok := m["modelUsage"].(map[string]any); ok && len(mu) > 0 {
		// main model = the one with the most output tokens
		best, bestOut := "", int64(-1)
		keys := make([]string, 0, len(mu))
		for k := range mu {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			o, _ := num(mu[k], "outputTokens")
			if o > bestOut {
				best, bestOut = k, o
			}
		}
		r.Usage.Model = ptrS(best)
	}
	return r
}

// ---- Codex ----

type codex struct{}

func (codex) Name() string       { return "codex" }
func (codex) Binaries() []string { return []string{"codex"} }

func (a codex) Build(prompt string, o Options) (Spec, error) {
	bin, err := Resolve(a, o)
	if err != nil {
		return Spec{}, err
	}
	sandbox := map[string]string{
		TierReadonly:  "read-only",
		TierWorkspace: "workspace-write",
		TierFull:      "danger-full-access",
	}[o.tier()]
	args := []string{"exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox, "-"}
	return Spec{Path: bin, Args: args, Stdin: prompt}, nil
}

// Parse reads `codex exec --json` JSONL events: usage is summed over
// turn.completed events; the final answer is the last agent_message item.
// Codex's input_tokens include cached_input_tokens and output_tokens include
// reasoning_output_tokens; both are split out here so the fields add up.
// A run without any turn.completed has unknown usage.
func (codex) Parse(out []byte) Result {
	var r Result
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev map[string]any
		if json.Unmarshal(line, &ev) != nil {
			continue
		}
		switch str(ev, "type") {
		case "turn.completed":
			in, _ := num(ev, "usage.input_tokens")
			cached, _ := num(ev, "usage.cached_input_tokens")
			outT, _ := num(ev, "usage.output_tokens")
			reason, _ := num(ev, "usage.reasoning_output_tokens")
			if cached > in {
				cached = in
			}
			if reason > outT {
				reason = outT
			}
			r.Known = true
			r.Usage.Input += in - cached
			r.Usage.CacheRead += cached
			r.Usage.Output += outT - reason
			r.Usage.Reasoning += reason
		case "item.completed":
			if str(ev, "item.type") == "agent_message" {
				r.Text = str(ev, "item.text")
			}
		case "turn.failed":
			r.IsError = true
			r.Err = firstNonEmpty(str(ev, "error.message"), "turn failed")
		case "error":
			r.IsError = true
			r.Err = firstNonEmpty(str(ev, "message"), "error")
		}
		if m := str(ev, "model"); m != "" {
			r.Usage.Model = ptrS(m)
		}
	}
	if !r.Known && !r.IsError && r.Text == "" {
		r.IsError = true
		r.Err = "no events in output"
	}
	if r.IsError {
		r.Known = false
		r.Usage = Usage{}
	}
	return r
}

// ---- Cursor ----

type cursor struct{}

func (cursor) Name() string       { return "cursor" }
func (cursor) Binaries() []string { return []string{"cursor-agent", "agent"} }

func (a cursor) Build(prompt string, o Options) (Spec, error) {
	bin, err := Resolve(a, o)
	if err != nil {
		return Spec{}, err
	}
	args := []string{"-p", "--output-format", "json"}
	if o.tier() == TierFull {
		args = append(args, "--force")
	}
	args = append(args, argPrompt(prompt, o.PromptFile))
	return Spec{Path: bin, Args: args}, nil
}

// Parse reads `cursor-agent -p --output-format json`. Token fields only exist
// in newer versions (camelCase or snake_case); there is never a cost.
func (cursor) Parse(out []byte) Result {
	m := lastJSONObject(out)
	if m == nil {
		return Result{IsError: true, Err: "no JSON result in output", Text: truncate(string(out), 4000)}
	}
	r := Result{Text: str(m, "result"), IsError: boolean(m, "is_error")}
	if st := str(m, "subtype"); st != "" && st != "success" {
		r.IsError = true
		r.Err = st
	}
	if r.IsError && r.Err == "" {
		r.Err = truncate(r.Text, 300)
	}
	if d, ok := num(m, "duration_ms"); ok {
		r.Usage.DurationMS = d
	}
	if _, ok := path(m, "usage"); ok {
		in, okIn := firstNum(m, "usage.inputTokens", "usage.input_tokens")
		outT, okOut := firstNum(m, "usage.outputTokens", "usage.output_tokens")
		r.Usage.CacheRead, _ = firstNum(m, "usage.cacheReadTokens", "usage.cache_read_tokens", "usage.cache_read_input_tokens")
		r.Usage.CacheWrite, _ = firstNum(m, "usage.cacheWriteTokens", "usage.cache_write_tokens", "usage.cache_creation_input_tokens")
		r.Usage.Input, r.Usage.Output = in, outT
		r.Known = okIn || okOut
	}
	r.Usage.Model = ptrS(str(m, "model"))
	return r
}

// ---- Gemini CLI ----

type gemini struct{}

func (gemini) Name() string       { return "gemini" }
func (gemini) Binaries() []string { return []string{"gemini"} }

func (a gemini) Build(prompt string, o Options) (Spec, error) {
	bin, err := Resolve(a, o)
	if err != nil {
		return Spec{}, err
	}
	mode := map[string]string{TierReadonly: "default", TierWorkspace: "auto_edit", TierFull: "yolo"}[o.tier()]
	// gemini appends -p to whatever arrives on stdin
	args := []string{"--output-format", "json", "--approval-mode", mode,
		"-p", "Follow the instructions above."}
	return Spec{Path: bin, Args: args, Stdin: prompt}, nil
}

// Parse reads `gemini -p --output-format json`: {response, stats.models.<m>.
// tokens{prompt,candidates,cached,thoughts}, error}. prompt includes cached.
func (gemini) Parse(out []byte) Result {
	m := lastJSONObject(out)
	if m == nil {
		return Result{IsError: true, Err: "no JSON result in output", Text: truncate(string(out), 4000)}
	}
	r := Result{Text: str(m, "response")}
	if e, ok := m["error"]; ok && e != nil {
		r.IsError = true
		r.Err = firstNonEmpty(str(m, "error.message"), "error")
	}
	models, _ := path(m, "stats.models")
	mm, _ := models.(map[string]any)
	keys := make([]string, 0, len(mm))
	for k := range mm {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	bestOut := int64(-1)
	for _, k := range keys {
		t, ok := path(mm[k], "tokens")
		if !ok {
			continue
		}
		r.Known = true
		prompt, _ := num(t, "prompt")
		cached, _ := num(t, "cached")
		cand, _ := num(t, "candidates")
		thoughts, _ := num(t, "thoughts")
		if cached > prompt {
			cached = prompt
		}
		r.Usage.Input += prompt - cached
		r.Usage.CacheRead += cached
		r.Usage.Output += cand
		r.Usage.Reasoning += thoughts
		if cand > bestOut {
			bestOut = cand
			r.Usage.Model = ptrS(k)
		}
	}
	return r
}

// ---- custom template ----

type custom struct{}

func (custom) Name() string       { return "custom" }
func (custom) Binaries() []string { return nil }

// Build splits o.Template into argv (whitespace separated, single or double
// quotes group words; no shell expansion) and substitutes {prompt_file}.
// The prompt is also written to stdin.
func (custom) Build(prompt string, o Options) (Spec, error) {
	words, err := SplitTemplate(o.Template)
	if err != nil {
		return Spec{}, err
	}
	if len(words) == 0 {
		return Spec{}, errors.New("custom cli: empty command template (set cli_template in hub.json)")
	}
	for i, w := range words {
		words[i] = strings.ReplaceAll(w, "{prompt_file}", o.PromptFile)
	}
	bin, err := o.lookPath()(words[0])
	if err != nil {
		return Spec{}, err
	}
	return Spec{Path: bin, Args: words[1:], Stdin: prompt}, nil
}

// Parse reads the last JSON object in stdout via the configured paths. It
// can't see the paths here, so callers use ParseCustom; Parse treats the
// whole stdout as the final text.
func (custom) Parse(out []byte) Result {
	return ParseCustom(out, nil)
}

// ParseCustom reads usage from the last JSON object in out using paths
// (keys: input, cache_write, cache_read, output, reasoning, cost_usd, model,
// text, is_error). Without a JSON object or paths, stdout is the text.
func ParseCustom(out []byte, paths map[string]string) Result {
	m := lastJSONObject(out)
	if m == nil || len(paths) == 0 {
		return Result{Text: truncate(string(out), 8000)}
	}
	r := Result{}
	if p := paths["text"]; p != "" {
		r.Text = str(m, p)
	} else {
		r.Text = truncate(string(out), 8000)
	}
	if p := paths["is_error"]; p != "" {
		r.IsError = boolean(m, p)
		if r.IsError {
			r.Err = truncate(r.Text, 300)
		}
	}
	set := func(key string, dst *int64) {
		if n, ok := num(m, paths[key]); ok {
			*dst = n
			r.Known = true
		}
	}
	set("input", &r.Usage.Input)
	set("cache_write", &r.Usage.CacheWrite)
	set("cache_read", &r.Usage.CacheRead)
	set("output", &r.Usage.Output)
	set("reasoning", &r.Usage.Reasoning)
	if c, ok := flt(m, paths["cost_usd"]); ok {
		r.Usage.CostUSD = ptrF(c)
	}
	r.Usage.Model = ptrS(str(m, paths["model"]))
	return r
}

// ParseWith parses out with a, honouring custom usage paths.
func ParseWith(a Adapter, out []byte, o Options) Result {
	if _, ok := a.(custom); ok {
		return ParseCustom(out, o.UsagePaths)
	}
	return a.Parse(out)
}

// SplitTemplate splits a command template into words without a shell:
// whitespace separates words, '...' and "..." group, backslash escapes the
// next character outside single quotes.
func SplitTemplate(s string) ([]string, error) {
	var words []string
	var cur strings.Builder
	inWord := false
	var quote rune
	esc := false
	for _, ch := range s {
		switch {
		case esc:
			cur.WriteRune(ch)
			esc = false
		case quote == '\'':
			if ch == '\'' {
				quote = 0
			} else {
				cur.WriteRune(ch)
			}
		case quote == '"':
			switch ch {
			case '"':
				quote = 0
			case '\\':
				esc = true
			default:
				cur.WriteRune(ch)
			}
		case ch == '\\':
			esc, inWord = true, true
		case ch == '\'' || ch == '"':
			quote, inWord = ch, true
		case unicode.IsSpace(ch):
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(ch)
			inWord = true
		}
	}
	if quote != 0 || esc {
		return nil, fmt.Errorf("custom cli template: unterminated quote or escape in %q", s)
	}
	if inWord {
		words = append(words, cur.String())
	}
	return words, nil
}

// argPrompt is the prompt for CLIs that take it as an argument: short
// prompts go inline, long ones (Windows caps a command line at 32k chars)
// as a pointer to the prompt file.
func argPrompt(prompt, file string) string {
	if len(prompt) <= 8000 || file == "" {
		return prompt
	}
	return "Read the file " + file + " in full and follow the instructions in it exactly."
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
