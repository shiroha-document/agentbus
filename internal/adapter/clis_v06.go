package adapter

import (
	"bytes"
	"encoding/json"
	"strings"
)

// ---- TRAE CLI 2.0 ----

// traecli runs `traecli exec --json <prompt>` (contract §7). Its event stream
// is codex-like JSONL, but the exact schema is not published, so Parse reads
// it defensively.
//
// Assumptions (no public reference for the flags yet):
//   - the prompt is a positional argument (like cursor; long prompts become a
//     pointer to the prompt file so Windows' 32k command-line cap is never hit);
//   - non-interactive exec mode applies the CLI's own configured permission
//     policy. No tier flag is passed because a wrong flag name would make
//     every round fail; the tier is exported as AGENTBUS_TIER for wrappers and
//     the round prompt states it. Add tier flags here once they are confirmed.
type traecli struct{}

func (traecli) Name() string       { return "traecli" }
func (traecli) Binaries() []string { return []string{"traecli", "trae-cli"} }

func (a traecli) Build(prompt string, o Options) (Spec, error) {
	bin, err := Resolve(a, o)
	if err != nil {
		return Spec{}, err
	}
	args := []string{"exec", "--json", argPrompt(prompt, o.PromptFile)}
	return Spec{Path: bin, Args: args, Env: []string{"AGENTBUS_TIER=" + o.tier()}}, nil
}

// Parse reads the JSONL stream. Final text: the last assistant/agent message
// (codex item.completed agent_message, or any event whose type/role says
// assistant/final/result). Usage: summed over turn.completed events when there
// are any (codex semantics), else the last usage object seen, found under
// usage / token_usage / the event itself (input_tokens/output_tokens). Model:
// the last "model" field. Output without any JSON line is taken as plain text.
func (traecli) Parse(out []byte) Result {
	var r Result
	var turnSum, last Usage
	sawTurn, sawLast, sawJSON := false, false, false
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev map[string]any
		if json.Unmarshal(line, &ev) != nil {
			continue
		}
		sawJSON = true
		typ := strings.ToLower(str(ev, "type"))
		if u, ok := findUsage(ev); ok {
			if typ == "turn.completed" {
				sawTurn = true
				turnSum.Input += u.Input
				turnSum.CacheRead += u.CacheRead
				turnSum.CacheWrite += u.CacheWrite
				turnSum.Output += u.Output
				turnSum.Reasoning += u.Reasoning
			} else {
				sawLast = true
				last = u
			}
		}
		if t := eventText(ev, typ); t != "" {
			r.Text = t
		}
		if typ == "error" || typ == "turn.failed" || strings.HasSuffix(typ, ".failed") || boolean(ev, "is_error") {
			r.IsError = true
			r.Err = firstNonEmpty(str(ev, "error.message"), str(ev, "message"), str(ev, "error"), typ, "error")
		}
		for _, p := range []string{"model", "item.model", "data.model", "session.model", "usage.model", "result.model"} {
			if m := str(ev, p); m != "" {
				r.Usage.Model = ptrS(m)
				break
			}
		}
	}
	switch {
	case sawTurn:
		r.Known = true
		r.Usage = withModel(turnSum, r.Usage.Model)
	case sawLast:
		r.Known = true
		r.Usage = withModel(last, r.Usage.Model)
	}
	if !sawJSON {
		t := strings.TrimSpace(string(out))
		if t == "" {
			return Result{IsError: true, Err: "no output"}
		}
		return Result{Text: truncate(t, 30000)}
	}
	if !r.Known && !r.IsError && r.Text == "" {
		r.IsError = true
		r.Err = "no assistant message in output"
	}
	if r.IsError {
		r.Known = false
		r.Usage = Usage{}
	}
	return r
}

func withModel(u Usage, m *string) Usage {
	u.Model = m
	return u
}

// findUsage looks for token counts in the usual places of one event.
func findUsage(ev map[string]any) (Usage, bool) {
	for _, p := range []string{"usage", "token_usage", "item.usage", "data.usage", "result.usage", "payload.usage", "info.usage"} {
		if v, ok := path(ev, p); ok {
			if m, ok := v.(map[string]any); ok {
				if u, ok := readUsage(m); ok {
					return u, true
				}
			}
		}
	}
	return readUsage(ev)
}

// readUsage reads OpenAI-style (input includes cached) or Anthropic-style
// (input excludes cache reads/writes) counters from m.
func readUsage(m map[string]any) (Usage, bool) {
	in, okIn := firstNum(m, "input_tokens", "prompt_tokens", "inputTokens", "promptTokens")
	outT, okOut := firstNum(m, "output_tokens", "completion_tokens", "outputTokens", "completionTokens")
	if !okIn && !okOut {
		return Usage{}, false
	}
	var u Usage
	// OpenAI style: cached tokens are part of input
	if cached, ok := firstNum(m, "cached_input_tokens", "prompt_tokens_details.cached_tokens", "input_tokens_details.cached_tokens", "cachedInputTokens"); ok {
		if cached > in {
			cached = in
		}
		in -= cached
		u.CacheRead = cached
	} else {
		// Anthropic style: separate counters
		u.CacheRead, _ = firstNum(m, "cache_read_input_tokens", "cache_read_tokens", "cacheReadTokens")
	}
	u.CacheWrite, _ = firstNum(m, "cache_creation_input_tokens", "cache_write_tokens", "cacheWriteTokens")
	if reason, ok := firstNum(m, "reasoning_output_tokens", "completion_tokens_details.reasoning_tokens", "output_tokens_details.reasoning_tokens", "reasoningTokens"); ok {
		if reason > outT {
			reason = outT
		}
		outT -= reason
		u.Reasoning = reason
	}
	u.Input, u.Output = in, outT
	return u, true
}

// eventText returns the assistant text carried by one event, if any.
func eventText(ev map[string]any, typ string) string {
	if item, ok := ev["item"].(map[string]any); ok {
		it := strings.ToLower(str(item, "type"))
		if (typ == "item.completed" || typ == "") && (it == "agent_message" || it == "assistant_message" || (it == "message" && str(item, "role") == "assistant")) {
			return firstNonEmpty(str(item, "text"), contentText(item["content"]))
		}
		return ""
	}
	role := strings.ToLower(str(ev, "role"))
	switch {
	case role == "assistant",
		typ == "agent_message", typ == "assistant", typ == "assistant_message", typ == "message" && role == "",
		typ == "final", typ == "final_answer", typ == "result", typ == "response", typ == "completed", typ == "done":
	default:
		return ""
	}
	return firstNonEmpty(str(ev, "text"), str(ev, "result"), str(ev, "message.text"), contentText(path1(ev, "message.content")),
		contentText(ev["content"]), str(ev, "message"), str(ev, "response"), str(ev, "output"))
}

func path1(v any, p string) any {
	x, _ := path(v, p)
	return x
}

// contentText flattens a string or a [{type:text,text}] content array.
func contentText(v any) string {
	switch c := v.(type) {
	case string:
		return c
	case []any:
		var parts []string
		for _, e := range c {
			if m, ok := e.(map[string]any); ok {
				if t := str(m, "text"); t != "" {
					parts = append(parts, t)
				}
			} else if s, ok := e.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// ---- DeepSeek Harness ----

// dsh runs `dsh --profile headless <prompt>` (contract §7): stdout is the
// final answer, exit 0/1, no token usage. The tier goes through the
// DSH_PERMISSION_MODE environment variable.
type dsh struct{}

func (dsh) Name() string       { return "dsh" }
func (dsh) Binaries() []string { return []string{"dsh"} }

func (a dsh) Build(prompt string, o Options) (Spec, error) {
	bin, err := Resolve(a, o)
	if err != nil {
		return Spec{}, err
	}
	mode := map[string]string{
		TierReadonly:  "read-only",
		TierWorkspace: "workspace-write",
		TierFull:      "danger-full-access",
	}[o.tier()]
	return Spec{Path: bin, Args: []string{"--profile", "headless", argPrompt(prompt, o.PromptFile)},
		Env: []string{"DSH_PERMISSION_MODE=" + mode}}, nil
}

// Parse takes stdout as the final text; failure is the exit code's business.
func (dsh) Parse(out []byte) Result {
	return Result{Text: truncate(string(out), 30000)}
}
