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
	// extra, when set, is tried after env: a CLI's own pair of variables
	extra func() string
}

// kimiCLIKey is kimi-cli's KIMI_API_KEY when its KIMI_BASE_URL points at
// one of hosts; defaultHost is the CLI's default base URL's host.
func kimiCLIKey(defaultHost string, hosts ...string) func() string {
	return func() string {
		key := strings.TrimSpace(lookupEnv("KIMI_API_KEY"))
		if key == "" {
			return ""
		}
		h := defaultHost
		if base := strings.TrimSpace(lookupEnv("KIMI_BASE_URL")); base != "" {
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
	if len(s.hosts) == 0 {
		return ""
	}
	if k := anthropicKeyFor(s.hosts, lookupEnv); k != "" {
		return k
	}
	for _, p := range claudeSettingsPaths() {
		env := claudeSettingsEnv(p)
		if env == nil {
			continue
		}
		if k := anthropicKeyFor(s.hosts, func(k string) string { return env[k] }); k != "" {
			return k
		}
	}
	return ""
}

// anthropicKeyFor is ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) when
// ANTHROPIC_BASE_URL points at one of hosts.
func anthropicKeyFor(hosts []string, get func(string) string) string {
	base := strings.TrimSpace(get("ANTHROPIC_BASE_URL"))
	if base == "" {
		return ""
	}
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	h := strings.ToLower(u.Hostname())
	for _, want := range hosts {
		if h == want {
			for _, k := range []string{"ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"} {
				if v := strings.TrimSpace(get(k)); v != "" {
					return v
				}
			}
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
