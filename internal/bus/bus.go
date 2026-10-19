package bus

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxBlob caps a single attachment.
const MaxBlob = 5 << 20

// Bus is an opened agentbus for one agent identity.
type Bus struct {
	Home string
	Cfg  *Config
	Git  *Git
	Now  func() time.Time
	Warn io.Writer

	events   []Event
	byID     map[string]*Event
	profiles map[string]*Profile
	claims   map[string][]Claim // task id -> claims sorted by attempt
	members  map[string]*Member
	loaded   bool

	// PerOpLock makes long-running loops (wait/watch/task run) take the home
	// lock per operation instead of holding it for the whole process, so child
	// processes can use the CLI on the same home concurrently.
	PerOpLock bool
}

// Lock takes the exclusive per-home lock (serialises all agentbus processes
// sharing one clone) and invalidates the in-memory view.
func (b *Bus) Lock() (func(), error) {
	unlock, err := lockFile(filepath.Join(b.Home, "lock"))
	if err != nil {
		return nil, err
	}
	b.loaded = false
	return unlock, nil
}

func (b *Bus) opLock() func() {
	if !b.PerOpLock {
		return func() {}
	}
	u, err := b.Lock()
	if err != nil {
		fmt.Fprintln(b.Warn, "agentbus: warning: lock:", err)
		return func() {}
	}
	return u
}

// Init creates (or re-uses) home, clones the bus branch, and publishes the
// agent's profile.
func Init(home, remote, branch string, p Profile, sshKey string) (*Bus, error) {
	if !ValidName(p.Name) || p.Name == "human" {
		return nil, fmt.Errorf("invalid agent name %q (use [a-z0-9._-], 2-40 chars)", p.Name)
	}
	if branch == "" {
		branch = "agent-bus"
	}
	g, err := Clone(remote, branch, clonePath(home), p.Name, sshKey)
	if err != nil {
		return nil, err
	}
	cfg := &Config{Remote: remote, Branch: branch, Me: p.Name, SSHKey: sshKey}
	if err := SaveConfig(home, cfg); err != nil {
		return nil, err
	}
	b := &Bus{Home: home, Cfg: cfg, Git: g, Now: time.Now, Warn: os.Stderr}
	if err := b.PublishProfile(p); err != nil {
		return nil, err
	}
	return b, nil
}

// Open opens an initialised home.
func Open(home string) (*Bus, error) {
	cfg, err := LoadConfig(home)
	if err != nil {
		return nil, err
	}
	g := &Git{Dir: clonePath(home), Remote: "origin", Branch: cfg.Branch, Agent: cfg.Me, SSHKey: cfg.SSHKey}
	return &Bus{Home: home, Cfg: cfg, Git: g, Now: time.Now, Warn: os.Stderr}, nil
}

// OpenDir opens an existing checkout of the bus branch read-only, without an
// agentbus home (used by CI to render digests). Me is "ci".
func OpenDir(dir string) *Bus {
	g := &Git{Dir: dir, Remote: "origin", Agent: "ci"}
	return &Bus{Cfg: &Config{Me: "ci"}, Git: g, Now: time.Now, Warn: os.Stderr}
}

// Locked runs f under the per-home lock when PerOpLock is set.
func (b *Bus) Locked(f func() error) error {
	unlock := b.opLock()
	defer unlock()
	return f()
}

// Me returns this agent's name.
func (b *Bus) Me() string { return b.Cfg.Me }

// PublishProfile writes agents/<me>/profile.json and pushes.
func (b *Bus) PublishProfile(p Profile) error {
	p.Name = b.Me()
	rel := filepath.Join("agents", p.Name, "profile.json")
	if err := writeJSON(filepath.Join(b.Git.Dir, rel), p); err != nil {
		return err
	}
	if err := b.Git.Commit("agentbus: profile "+p.Name, rel); err != nil {
		return err
	}
	if _, err := b.emitLocal(Event{Kind: KindHello, Profile: &p}); err != nil {
		return err
	}
	b.loaded = false
	return b.Git.Push()
}

// Sync pulls new events, then acknowledges delivery of everything newly
// addressed to this agent (receipt=delivered), and pushes.
func (b *Bus) Sync() error {
	if err := b.Git.Pull(); err != nil {
		return err
	}
	b.loaded = false
	if err := b.load(); err != nil {
		return err
	}
	n := 0
	for i := range b.events {
		e := &b.events[i]
		if (e.Kind != KindMessage && e.Kind != KindTaskCreate) || e.From == b.Me() || !b.addressedToMe(e) {
			continue
		}
		if b.receiptLevel(e.ID, b.Me()) != "" {
			continue
		}
		if _, err := b.emitLocal(Event{Kind: KindReceipt, Ref: e.ID, Thread: threadOf(e), Status: RcptDelivered, To: []string{e.From}}); err != nil {
			return err
		}
		n++
	}
	if n > 0 || b.Git.Ahead() {
		if err := b.Git.Push(); err != nil {
			return err
		}
		b.loaded = false
	}
	return nil
}

// Emit appends an event authored by this agent and pushes it.
func (b *Bus) Emit(e Event) (*Event, error) {
	ev, err := b.emitLocal(e)
	if err != nil {
		return nil, err
	}
	if err := b.Git.Push(); err != nil {
		return nil, fmt.Errorf("event %s committed locally but push failed (will retry on next sync): %w", ev.ID, err)
	}
	b.loaded = false
	return ev, nil
}

func (b *Bus) emitLocal(e Event) (*Event, error) {
	now := b.Now().UTC()
	e.V = Version
	e.TS = now
	e.From = b.Me()
	if e.ID == "" {
		e.ID = NewID(now)
	}
	if e.Thread == "" && e.ReplyTo == "" && (e.Kind == KindMessage || e.Kind == KindTaskCreate) {
		e.Thread = e.ID
	}
	e.Body = Redact(e.Body)
	e.Subject = Redact(e.Subject)
	e.Reason = Redact(e.Reason)
	if e.Progress != nil {
		e.Progress.Tail = Redact(tailLines(e.Progress.Tail, 40, 8<<10))
	}
	rel := filepath.Join("events", e.From, now.Format("2006-01"), e.ID+".json")
	if err := writeJSON(filepath.Join(b.Git.Dir, rel), e); err != nil {
		return nil, err
	}
	msg := fmt.Sprintf("%s %s", e.Kind, ShortID(e.ID))
	if e.Ref != "" {
		msg += " ref=" + ShortID(e.Ref)
	}
	if e.Status != "" {
		msg += " " + e.Status
	}
	if err := b.Git.Commit(msg, rel); err != nil {
		return nil, err
	}
	if b.loaded {
		b.events = append(b.events, e)
		b.reindex()
	}
	return &e, nil
}

// PutBlob stores a file under blobs/<sha256> (redacting text) and returns the
// attachment reference. The caller's next Emit pushes it.
func (b *Bus) PutBlob(path string) (Attach, error) {
	st, err := os.Stat(path)
	if err != nil {
		return Attach{}, err
	}
	if st.Size() > MaxBlob {
		return Attach{}, fmt.Errorf("%s is %d bytes; attachments are capped at %d (trim logs first)", path, st.Size(), MaxBlob)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Attach{}, err
	}
	if utf8.Valid(data) {
		data = []byte(Redact(string(data)))
	}
	sum := sha256.Sum256(data)
	h := hex.EncodeToString(sum[:])
	rel := filepath.Join("blobs", h)
	abs := filepath.Join(b.Git.Dir, rel)
	if _, err := os.Stat(abs); err != nil {
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return Attach{}, err
		}
		if err := os.WriteFile(abs, data, 0o644); err != nil {
			return Attach{}, err
		}
		if err := b.Git.Commit("blob "+h[:12], rel); err != nil {
			return Attach{}, err
		}
	}
	return Attach{Name: filepath.Base(path), SHA256: h, Size: int64(len(data))}, nil
}

// GetBlob returns a blob's content by full or prefix hash.
func (b *Bus) GetBlob(prefix string) ([]byte, error) {
	if len(prefix) < 8 {
		return nil, errors.New("blob hash prefix must be at least 8 chars")
	}
	ents, _ := os.ReadDir(filepath.Join(b.Git.Dir, "blobs"))
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), prefix) {
			return os.ReadFile(filepath.Join(b.Git.Dir, "blobs", e.Name()))
		}
	}
	return nil, fmt.Errorf("blob %s not found (try `agentbus sync`)", prefix)
}

// load reads all events, profiles and claims from the clone. Events whose
// From does not match their directory are rejected (an agent may only speak
// for itself).
func (b *Bus) load() error {
	if b.loaded {
		return nil
	}
	b.events = nil
	b.profiles = map[string]*Profile{}
	root := b.Git.Dir
	b.members = LoadMembers(root)
	agents, _ := os.ReadDir(filepath.Join(root, "agents"))
	for _, a := range agents {
		if m := b.members[a.Name()]; m != nil && m.Revoked {
			continue // revoked agents disappear from the directory
		}
		var p Profile
		if err := readJSON(filepath.Join(root, "agents", a.Name(), "profile.json"), &p); err == nil && p.Name == a.Name() {
			pp := p
			b.profiles[p.Name] = &pp
		}
	}
	err := filepath.WalkDir(filepath.Join(root, "events"), func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil
		}
		rel, _ := filepath.Rel(filepath.Join(root, "events"), path)
		author := strings.SplitN(rel, string(filepath.Separator), 2)[0]
		var e Event
		if err := readJSON(path, &e); err != nil {
			fmt.Fprintf(b.Warn, "agentbus: skip unreadable event %s: %v\n", rel, err)
			return nil
		}
		if e.From != author || e.ID+".json" != filepath.Base(path) {
			fmt.Fprintf(b.Warn, "agentbus: reject forged event %s (from=%q, dir=%q)\n", rel, e.From, author)
			return nil
		}
		if m := b.members[author]; m != nil && m.Revoked && m.RevokedAt != nil && e.TS.After(*m.RevokedAt) {
			return nil // written after the agent was revoked
		}
		b.events = append(b.events, e)
		return nil
	})
	if err != nil {
		return err
	}
	sort.SliceStable(b.events, func(i, j int) bool {
		if !b.events[i].TS.Equal(b.events[j].TS) {
			return b.events[i].TS.Before(b.events[j].TS)
		}
		return b.events[i].ID < b.events[j].ID
	})
	b.claims = map[string][]Claim{}
	tasks, _ := os.ReadDir(filepath.Join(root, "claims"))
	for _, t := range tasks {
		files, _ := os.ReadDir(filepath.Join(root, "claims", t.Name()))
		for _, f := range files {
			var c Claim
			if err := readJSON(filepath.Join(root, "claims", t.Name(), f.Name()), &c); err != nil {
				continue
			}
			if c.Task != t.Name() || f.Name() != fmt.Sprintf("%d.json", c.Attempt) {
				continue
			}
			b.claims[c.Task] = append(b.claims[c.Task], c)
		}
		sort.Slice(b.claims[t.Name()], func(i, j int) bool { return b.claims[t.Name()][i].Attempt < b.claims[t.Name()][j].Attempt })
	}
	b.reindex()
	b.loaded = true
	return nil
}

// reindex rebuilds pointer indices; must run after any change to b.events
// (append may reallocate the slice and invalidate old pointers).
func (b *Bus) reindex() {
	b.byID = make(map[string]*Event, len(b.events))
	for i := range b.events {
		b.byID[b.events[i].ID] = &b.events[i]
	}
}

// Resolve finds an event by full id or unique suffix/prefix (>= 6 chars).
func (b *Bus) Resolve(id string) (*Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	if e, ok := b.byID[id]; ok {
		return e, nil
	}
	if len(id) < 6 {
		return nil, fmt.Errorf("id %q too short (need >= 6 chars)", id)
	}
	id = strings.ToUpper(id)
	var hit *Event
	for i := range b.events {
		e := &b.events[i]
		if strings.HasSuffix(e.ID, id) || strings.HasPrefix(e.ID, id) {
			if hit != nil {
				return nil, fmt.Errorf("id %q is ambiguous", id)
			}
			hit = e
		}
	}
	if hit == nil {
		return nil, fmt.Errorf("event %q not found (try `agentbus sync`)", id)
	}
	return hit, nil
}

func threadOf(e *Event) string {
	if e.Thread != "" {
		return e.Thread
	}
	return e.ID
}

func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func tailLines(s string, maxLines, maxBytes int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	out := strings.Join(lines, "\n")
	if len(out) > maxBytes {
		out = out[len(out)-maxBytes:]
	}
	return out
}
