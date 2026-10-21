package hub

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrNoConfig means this machine has not joined a hub (no hub.json).
var ErrNoConfig = errors.New("not joined to a hub: run `agentbus join URL --join-code CODE --name NAME` (or `agentbus setup`)")

// Dir is the per-user config directory: $AGENTBUS_HUB_HOME, else
// os.UserConfigDir()/agentbus (~/Library/Application Support/agentbus on
// macOS, ~/.config/agentbus on Linux, %AppData%\agentbus on Windows).
func Dir() string {
	if d := strings.TrimSpace(os.Getenv("AGENTBUS_HUB_HOME")); d != "" {
		return d
	}
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "agentbus")
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".config", "agentbus")
	}
	return ".agentbus-hub"
}

// Config is hub.json.
type Config struct {
	HubURL        string            `json:"hub_url"`
	MemberID      string            `json:"member_id,omitempty"`
	TeamID        string            `json:"team_id,omitempty"`
	TeamName      string            `json:"team_name,omitempty"`
	Name          string            `json:"name"`
	CLI           string            `json:"cli"`
	CLIBinary     string            `json:"cli_binary,omitempty"`
	CLITemplate   string            `json:"cli_template,omitempty"`    // custom: argv template with {prompt_file}
	CLIUsagePaths map[string]string `json:"cli_usage_paths,omitempty"` // custom: field -> dotted JSON path
	Wake          string            `json:"wake"`                      // poll | trigger
	WakeIntervalS int64             `json:"wake_interval_s"`
	TriggerURL    string            `json:"trigger_url,omitempty"`
	Owner         string            `json:"owner,omitempty"`
	Machine       string            `json:"machine,omitempty"`
	Tier          string            `json:"permission_tier"` // readonly | workspace | full
	QuotaSource   string            `json:"quota_source"`    // auto | native | magpie | both
	JoinedAt      int64             `json:"joined_at,omitempty"`
}

// Paths of the files in a config dir.
type Paths struct{ Dir string }

func (p Paths) Config() string  { return filepath.Join(p.Dir, "hub.json") }
func (p Paths) Key() string     { return filepath.Join(p.Dir, "key.seed") }
func (p Paths) OldKey() string  { return filepath.Join(p.Dir, "key.seed.old") }
func (p Paths) Repos() string   { return filepath.Join(p.Dir, "repos.toml") }
func (p Paths) Usage() string   { return filepath.Join(p.Dir, "usage.jsonl") }
func (p Paths) State() string   { return filepath.Join(p.Dir, "state.json") }
func (p Paths) Lock() string    { return filepath.Join(p.Dir, "tick.lock") }
func (p Paths) Logs() string    { return filepath.Join(p.Dir, "logs") }
func (p Paths) Work() string    { return filepath.Join(p.Dir, "work") }
func (p Paths) Prompts() string { return filepath.Join(p.Dir, "prompts") }

// Exists reports whether a hub.json is present in dir.
func Exists(dir string) bool {
	_, err := os.Stat(Paths{dir}.Config())
	return err == nil
}

// LoadConfig reads hub.json from dir.
func LoadConfig(dir string) (*Config, error) {
	b, err := os.ReadFile(Paths{dir}.Config())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNoConfig
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", Paths{dir}.Config(), err)
	}
	c.fill()
	return &c, nil
}

func (c *Config) fill() {
	c.HubURL = strings.TrimRight(c.HubURL, "/")
	if c.CLI == "" {
		c.CLI = "claude"
	}
	if c.Wake == "" {
		c.Wake = "poll"
	}
	if c.WakeIntervalS <= 0 {
		c.WakeIntervalS = 300
	}
	if c.Tier == "" {
		c.Tier = "workspace"
	}
	if c.QuotaSource == "" {
		c.QuotaSource = "auto"
	}
}

// Save writes hub.json (0600) into dir.
func (c *Config) Save(dir string) error {
	c.fill()
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(Paths{dir}.Config(), append(b, '\n'), 0o600)
}

// ---- keys ----

// GenerateKey creates a new random ed25519 key.
func GenerateKey() (ed25519.PrivateKey, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	return priv, err
}

// SaveKey writes the 32-byte seed of k to path with mode 0600.
func SaveKey(path string, k ed25519.PrivateKey) error {
	return writeFileAtomic(path, k.Seed(), 0o600)
}

// LoadKey reads a 32-byte seed file.
func LoadKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s: want a %d-byte ed25519 seed, got %d bytes", path, ed25519.SeedSize, len(b))
	}
	return ed25519.NewKeyFromSeed(b), nil
}

// PublicKeyB64 is the standard base64 of the raw 32-byte public key.
func PublicKeyB64(k ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(k.Public().(ed25519.PublicKey))
}

// ---- repos.toml ----

// Repos maps "owner/repo" to a local checkout path.
type Repos map[string]string

var reposLine = regexp.MustCompile(`^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.\-/]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$`)

// LoadRepos parses repos.toml: `"owner/repo" = "/path"` lines, optionally
// under a `[repos]` table. Other tables are ignored. A missing file is an
// empty map.
func LoadRepos(path string) (Repos, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Repos{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := Repos{}
	table := ""
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		n++
		l := strings.TrimSpace(sc.Text())
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		if strings.HasPrefix(l, "[") {
			table = strings.TrimSpace(strings.Trim(strings.SplitN(l, "#", 2)[0], " []"))
			continue
		}
		if table != "" && table != "repos" {
			continue
		}
		m := reposLine.FindStringSubmatch(l)
		if m == nil {
			return nil, fmt.Errorf("%s:%d: want `\"owner/repo\" = \"/local/path\"`", path, n)
		}
		k, err := tomlString(m[1])
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %v", path, n, err)
		}
		v, err := tomlString(m[2])
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %v", path, n, err)
		}
		out[strings.ToLower(k)] = v
	}
	return out, sc.Err()
}

func tomlString(s string) (string, error) {
	switch {
	case strings.HasPrefix(s, `"`):
		return strconv.Unquote(s)
	case strings.HasPrefix(s, `'`):
		return strings.Trim(s, "'"), nil
	}
	return s, nil
}

// Lookup finds the path for repo, accepting "owner/repo", a GitHub URL or
// an ssh remote.
func (r Repos) Lookup(repo string) (string, bool) {
	key := NormalizeRepo(repo)
	if key == "" {
		return "", false
	}
	p, ok := r[key]
	return p, ok
}

// NormalizeRepo turns URLs and remotes into lowercase "owner/repo".
func NormalizeRepo(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	for _, p := range []string{"https://", "http://", "ssh://", "git@"} {
		s = strings.TrimPrefix(s, p)
	}
	s = strings.Replace(s, ":", "/", 1)
	parts := strings.Split(s, "/")
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
	return s
}

// SaveRepos writes r as a `[repos]` table.
func SaveRepos(path string, r Repos) error {
	var b strings.Builder
	b.WriteString("# agentbus: repository -> local checkout used by `agentbus tick`\n[repos]\n")
	keys := make([]string, 0, len(r))
	for k := range r {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s = %s\n", strconv.Quote(k), strconv.Quote(r[k]))
	}
	return writeFileAtomic(path, []byte(b.String()), 0o600)
}

// ---- state.json ----

// LocalState is state.json: what the last tick saw.
type LocalState struct {
	LastTickAt    int64  `json:"last_tick_at,omitempty"`
	LastExit      int    `json:"last_exit"`
	LastError     string `json:"last_error,omitempty"`
	LastRunAt     int64  `json:"last_run_at,omitempty"`
	LastThread    string `json:"last_thread,omitempty"`
	BaselineInput int64  `json:"baseline_tokens,omitempty"`
}

func LoadState(dir string) LocalState {
	var s LocalState
	if b, err := os.ReadFile(Paths{dir}.State()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

func SaveState(dir string, s LocalState) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return writeFileAtomic(Paths{dir}.State(), append(b, '\n'), 0o600)
}

// ---- helpers ----

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil && !isWindows() {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func nowMS() int64 { return time.Now().UnixMilli() }
