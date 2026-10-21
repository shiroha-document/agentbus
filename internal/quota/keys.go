package quota

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// API keys come only from environment variables and from the coding CLIs'
// own local config: Claude Code's settings.json "env" block, which is
// where a GLM / Kimi / MiniMax / OpenRouter plan is usually wired into
// Claude Code (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN). Keys are held
// only for the request they authorise.

// keySource says where to find one provider's key.
type keySource struct {
	env   []string // dedicated variables, first set wins
	hosts []string // ANTHROPIC_BASE_URL hosts that mean this provider
	// base, when set, is used in place of hosts to recognise an
	// ANTHROPIC_BASE_URL (a provider sharing its host with another)
	base func(u *url.URL) bool
	// extra, when set, is tried after env: a CLI's own pair of variables,
	// or its own key file
	extra func() string
}

// hostIs recognises a base URL by its host.
func hostIs(hosts ...string) func(u *url.URL) bool {
	return func(u *url.URL) bool {
		h := strings.ToLower(u.Hostname())
		for _, want := range hosts {
			if h == want {
				return true
			}
		}
		return false
	}
}

// openCodeAuthPath is OpenCode's key file: a map of its provider id to
// {"type":"api","key":"…"} (or a sign-in, which is not a key).
func openCodeAuthPath() string {
	if d := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); d != "" {
		return filepath.Join(d, "opencode", "auth.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "opencode", "auth.json")
}

// openCodeKey is the API key OpenCode keeps for its provider id, or "".
func openCodeKey(id string) string {
	b, err := readSmallFile(openCodeAuthPath())
	if err != nil {
		return ""
	}
	var all map[string]struct {
		Type string `json:"type"`
		Key  string `json:"key"`
	}
	if json.Unmarshal(b, &all) != nil {
		return ""
	}
	if e, ok := all[id]; ok && e.Type == "api" {
		return strings.TrimSpace(e.Key)
	}
	return ""
}

// fromOpenCode is an extra key source: OpenCode's key for id.
func fromOpenCode(id string) func() string {
	return func() string { return openCodeKey(id) }
}

// pairKey is a CLI's or SDK's key variable when its base-URL variable
// points at one of hosts (defaultHost when the base is unset): the same
// MOONSHOT_API_KEY is Moonshot's China account or its global one by the
// MOONSHOT_BASE_URL beside it.
func pairKey(keyVar, baseVar, defaultHost string, hosts ...string) func() string {
	return func() string {
		key := strings.TrimSpace(lookupEnv(keyVar))
		if key == "" {
			return ""
		}
		h := defaultHost
		if base := strings.TrimSpace(lookupEnv(baseVar)); base != "" {
			u, err := url.Parse(base)
			if err != nil {
				return ""
			}
			h = strings.ToLower(u.Hostname())
		}
		for _, want := range hosts {
			if h == want {
				return key
			}
		}
		return ""
	}
}

// kimiCLIKey is kimi-cli's KIMI_API_KEY when its KIMI_BASE_URL points at
// one of hosts; defaultHost is the CLI's default base URL's host.
func kimiCLIKey(defaultHost string, hosts ...string) func() string {
	return pairKey("KIMI_API_KEY", "KIMI_BASE_URL", defaultHost, hosts...)
}

// firstKey tries each source in turn.
func firstKey(srcs ...func() string) func() string {
	return func() string {
		for _, f := range srcs {
			if v := f(); v != "" {
				return v
			}
		}
		return ""
	}
}

// lookupEnv is os.Getenv; tests replace it.
var lookupEnv = os.Getenv

// claudeSettingsPaths are Claude Code's settings files, user then local.
func claudeSettingsPaths() []string {
	d := claudeDir()
	if d == "" {
		return nil
	}
	return []string{filepath.Join(d, "settings.json"), filepath.Join(d, "settings.local.json")}
}

// find returns the key, or "".
func (s keySource) find() string {
	for _, e := range s.env {
		if v := strings.TrimSpace(lookupEnv(e)); v != "" {
			return v
		}
	}
	if s.extra != nil {
		if v := s.extra(); v != "" {
			return v
		}
	}
	match := s.base
	if match == nil {
		if len(s.hosts) == 0 {
			return ""
		}
		match = hostIs(s.hosts...)
	}
	if k := anthropicKeyFor(match, lookupEnv); k != "" {
		return k
	}
	for _, p := range claudeSettingsPaths() {
		env := claudeSettingsEnv(p)
		if env == nil {
			continue
		}
		if k := anthropicKeyFor(match, func(k string) string { return env[k] }); k != "" {
			return k
		}
	}
	return ""
}

// anthropicKeyFor is ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) when
// ANTHROPIC_BASE_URL is one match recognises.
func anthropicKeyFor(match func(*url.URL) bool, get func(string) string) string {
	base := strings.TrimSpace(get("ANTHROPIC_BASE_URL"))
	if base == "" {
		return ""
	}
	u, err := url.Parse(base)
	if err != nil || !match(u) {
		return ""
	}
	for _, k := range []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"} {
		if v := strings.TrimSpace(get(k)); v != "" {
			return v
		}
	}
	return ""
}

// claudeSettingsEnv reads the string values of a settings file's "env".
func claudeSettingsEnv(path string) map[string]string {
	b, err := readSmallFile(path)
	if err != nil {
		return nil
	}
	var s struct {
		Env map[string]any `json:"env"`
	}
	if json.Unmarshal(b, &s) != nil || len(s.Env) == 0 {
		return nil
	}
	out := make(map[string]string, len(s.Env))
	for k, v := range s.Env {
		if str, ok := v.(string); ok {
			out[k] = str
		}
	}
	return out
}
