package adapter

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func read(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func fakeLook(name string) (string, error) { return "/bin/" + name, nil }

func TestClaudeParse(t *testing.T) {
	r := claude{}.Parse(read(t, "claude_ok.json"))
	if !r.Known || r.IsError || r.Usage.Input != 3200 || r.Usage.CacheRead != 28000 || r.Usage.Output != 900 {
		t.Fatalf("%+v", r)
	}
	if r.Usage.CostUSD == nil || *r.Usage.CostUSD != 0.0412 || r.Usage.Model == nil || *r.Usage.Model != "claude-sonnet-4-5" {
		t.Fatalf("%+v", r.Usage)
	}
	if r.Usage.DurationMS != 133000 || !strings.HasPrefix(r.Text, "Done:") {
		t.Fatalf("%+v", r)
	}
	e := claude{}.Parse(read(t, "claude_error.json"))
	if !e.IsError || e.Err != "error_max_turns" || e.Usage.CacheWrite != 2000 {
		t.Fatalf("%+v", e)
	}
	g := claude{}.Parse([]byte("panic: boom"))
	if !g.IsError || g.Known {
		t.Fatalf("%+v", g)
	}
}

func TestCodexParse(t *testing.T) {
	r := codex{}.Parse(read(t, "codex_ok.jsonl"))
	want := Usage{Input: 315 + 1000, CacheRead: 24448, Output: 58 + 100, Reasoning: 64}
	if !r.Known || r.IsError || !reflect.DeepEqual(r.Usage, want) {
		t.Fatalf("%+v", r)
	}
	if r.Text != "All set: posted progress to the thread." {
		t.Fatal(r.Text)
	}
	f := codex{}.Parse(read(t, "codex_failed.jsonl"))
	if !f.IsError || f.Known || !strings.Contains(f.Err, "stream disconnected") {
		t.Fatalf("%+v", f)
	}
}

func TestCursorParse(t *testing.T) {
	r := cursor{}.Parse(read(t, "cursor_ok.json"))
	if !r.Known || r.Usage.Input != 12000 || r.Usage.CacheRead != 9000 || r.Usage.Output != 800 || r.Usage.CostUSD != nil || r.Text != "Updated README." {
		t.Fatalf("%+v", r)
	}
	o := cursor{}.Parse(read(t, "cursor_old.json"))
	if o.Known || o.IsError || o.Text != "ok" {
		t.Fatalf("%+v", o)
	}
}

func TestGeminiParse(t *testing.T) {
	r := gemini{}.Parse(read(t, "gemini_ok.json"))
	want := Usage{Input: 1000 + 5000, CacheRead: 15000, Output: 710, Reasoning: 300}
	got := r.Usage
	got.Model = nil
	if !r.Known || !reflect.DeepEqual(got, want) || *r.Usage.Model != "gemini-2.5-pro" || r.Text == "" {
		t.Fatalf("%+v %+v", r, got)
	}
}

func TestCustomParse(t *testing.T) {
	paths := map[string]string{"input": "stats.in", "output": "stats.out", "cache_read": "stats.cache.read",
		"cost_usd": "cost", "model": "model", "text": "answer", "is_error": "failed"}
	r := ParseCustom(read(t, "custom_ok.txt"), paths)
	if !r.Known || r.Usage.Input != 100 || r.Usage.Output != 20 || r.Usage.CacheRead != 50 || *r.Usage.CostUSD != 0.01 || r.Text != "custom done" || *r.Usage.Model != "local-llm" {
		t.Fatalf("%+v", r)
	}
	plain := ParseCustom([]byte("hello"), nil)
	if plain.Known || plain.Text != "hello" {
		t.Fatalf("%+v", plain)
	}
}

func TestBuild(t *testing.T) {
	o := Options{LookPath: fakeLook}
	cases := []struct {
		cli, tier string
		want      []string
		stdin     bool
	}{
		{"claude", TierReadonly, []string{"-p", "--output-format", "json", "--permission-mode", "plan", "--allowedTools", "Read,Grep,Glob"}, true},
		{"claude", "", []string{"-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Grep,Glob,Bash(git *),Bash(agentbus *)"}, true},
		{"claude", TierFull, []string{"-p", "--output-format", "json", "--dangerously-skip-permissions"}, true},
		{"codex", TierReadonly, []string{"exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"}, true},
		{"codex", TierFull, []string{"exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "-"}, true},
		{"cursor", TierWorkspace, []string{"-p", "--output-format", "json", "PROMPT"}, false},
		{"cursor", TierFull, []string{"-p", "--output-format", "json", "--force", "PROMPT"}, false},
		{"gemini", TierWorkspace, []string{"--output-format", "json", "--approval-mode", "auto_edit", "-p", "Follow the instructions above."}, true},
		{"gemini", TierFull, []string{"--output-format", "json", "--approval-mode", "yolo", "-p", "Follow the instructions above."}, true},
	}
	for _, c := range cases {
		a, _ := Get(c.cli)
		o.Tier = c.tier
		s, err := a.Build("PROMPT", o)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(s.Args, c.want) || (s.Stdin == "PROMPT") != c.stdin {
			t.Errorf("%s/%s: %q stdin=%q", c.cli, c.tier, s.Args, s.Stdin)
		}
	}
	cu, _ := Get("custom")
	s, err := cu.Build("P", Options{LookPath: fakeLook, PromptFile: "/tmp/p.md", Template: `mycli run --in {prompt_file} --name "a b" 'c d'`})
	if err != nil || s.Path != "/bin/mycli" || !reflect.DeepEqual(s.Args, []string{"run", "--in", "/tmp/p.md", "--name", "a b", "c d"}) {
		t.Fatalf("%v %q", err, s.Args)
	}
	if _, err := SplitTemplate(`a "b`); err == nil {
		t.Fatal("want error")
	}
}

func TestCursorFallbackBinary(t *testing.T) {
	look := func(n string) (string, error) {
		if n == "agent" {
			return "/x/agent", nil
		}
		return "", os.ErrNotExist
	}
	s, err := cursor{}.Build("p", Options{LookPath: look})
	if err != nil || s.Path != "/x/agent" {
		t.Fatal(err, s.Path)
	}
}
