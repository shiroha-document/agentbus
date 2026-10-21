// Package telemetry queues CLI analytics events (contract
// docs/design/v06-contract.md §5) in <config dir>/events.jsonl and uploads
// them best-effort to the hub.
//
// Privacy: callers only pass enumerated values, counts and flag NAMES —
// never bodies, emails, tokens, names, paths or URLs. Props values other
// than string/number/bool are dropped and strings are cut to 200 bytes.
//
// Opt-out: AGENTBUS_TELEMETRY=off|0|false|no, or config telemetry=false
// (`agentbus telemetry off`). Record never blocks on the network, never
// fails and never panics.
package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shiroha-document/agentbus/internal/hub"
)

const (
	// FileName is the queue file inside the config dir.
	FileName = "events.jsonl"
	// MaxQueued caps the queue; the oldest events are dropped first.
	MaxQueued = 500
	// BatchSize is the most events one Flush sends (hub limit).
	BatchSize = 50
	// FlushTimeout bounds one Flush overall.
	FlushTimeout = 2 * time.Second
)

var (
	mu      sync.Mutex
	dir     string
	enabled bool
	version string
)

// Init sets the config dir holding the queue, whether telemetry is enabled
// by config, and the client version stamped on events. The environment
// opt-out always wins.
func Init(configDir string, on bool, clientVersion string) {
	mu.Lock()
	defer mu.Unlock()
	dir, enabled, version = configDir, on, clientVersion
}

// EnvOff reports whether $AGENTBUS_TELEMETRY disables telemetry.
func EnvOff() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AGENTBUS_TELEMETRY"))) {
	case "off", "0", "false", "no", "disable", "disabled":
		return true
	}
	return false
}

// Enabled reports whether events are recorded and sent.
func Enabled() bool {
	mu.Lock()
	defer mu.Unlock()
	return enabled && dir != "" && !EnvOff()
}

// Path is the queue file ("" before Init).
func Path() string {
	mu.Lock()
	defer mu.Unlock()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, FileName)
}

// Record queues one event. The config dir must already exist (nothing is
// recorded before the first join). Never blocks on the network and never
// fails.
func Record(ev hub.Event) {
	defer func() { _ = recover() }()
	if !Enabled() {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if ev.At == 0 {
		ev.At = time.Now().UnixMilli()
	}
	if ev.ClientVersion == "" {
		ev.ClientVersion = version
	}
	if ev.OS == "" {
		ev.OS = runtime.GOOS
	}
	ev.Props = cleanProps(ev.Props)
	line, err := json.Marshal(ev)
	if err != nil {
		return
	}
	p := filepath.Join(dir, FileName)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return
	}
	_, werr := f.Write(append(line, '\n'))
	fi, serr := f.Stat()
	f.Close()
	// cheap size check first: 500 events are well above 64 KiB
	if werr == nil && serr == nil && fi.Size() > 64<<10 {
		trim(p)
	}
}

// trim keeps the newest MaxQueued lines.
func trim(p string) {
	lines := readLines(p)
	if len(lines) <= MaxQueued {
		return
	}
	writeLines(p, lines[len(lines)-MaxQueued:])
}

// Sender is the part of *hub.Client Flush needs.
type Sender interface {
	Events(ctx context.Context, evs []hub.Event) error
}

// Flush sends up to BatchSize queued events (oldest first) within
// FlushTimeout and removes the sent lines from the queue. It returns the
// number sent; errors leave the queue untouched and are not reported.
func Flush(ctx context.Context, s Sender) (n int) {
	defer func() {
		if recover() != nil {
			n = 0
		}
	}()
	if s == nil || !Enabled() {
		return 0
	}
	p := Path()
	mu.Lock()
	lines := readLines(p)
	mu.Unlock()
	if len(lines) == 0 {
		return 0
	}
	var batch []hub.Event
	var sent [][]byte
	for _, l := range lines {
		if len(batch) == BatchSize {
			break
		}
		var ev hub.Event
		if json.Unmarshal(l, &ev) == nil && ev.Name != "" {
			batch = append(batch, ev)
		}
		sent = append(sent, l) // unparsable lines are dropped with the batch
	}
	ctx, cancel := context.WithTimeout(ctx, FlushTimeout)
	defer cancel()
	if len(batch) > 0 {
		if err := s.Events(ctx, batch); err != nil {
			return 0
		}
	}
	mu.Lock()
	defer mu.Unlock()
	// another process may have appended or trimmed meanwhile: drop exactly
	// the lines we sent, wherever they are now
	cur := readLines(p)
	drop := map[string]int{}
	for _, l := range sent {
		drop[string(l)]++
	}
	keep := cur[:0]
	for _, l := range cur {
		if drop[string(l)] > 0 {
			drop[string(l)]--
			continue
		}
		keep = append(keep, l)
	}
	if len(keep) == 0 {
		_ = os.Remove(p)
	} else {
		writeLines(p, keep)
	}
	return len(batch)
}

// Queued is the number of events waiting in the queue.
func Queued() int {
	p := Path()
	if p == "" {
		return 0
	}
	mu.Lock()
	defer mu.Unlock()
	return len(readLines(p))
}

// Clear deletes the queue (after an opt-out).
func Clear() {
	if p := Path(); p != "" {
		mu.Lock()
		_ = os.Remove(p)
		mu.Unlock()
	}
}

func readLines(p string) [][]byte {
	if p == "" {
		return nil
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var out [][]byte
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if l := bytes.TrimSpace(sc.Bytes()); len(l) > 0 {
			out = append(out, append([]byte(nil), l...))
		}
	}
	return out
}

func writeLines(p string, lines [][]byte) {
	tmp := p + ".tmp"
	data := append(bytes.Join(lines, []byte("\n")), '\n')
	if os.WriteFile(tmp, data, 0o600) != nil {
		return
	}
	if os.Rename(tmp, p) != nil {
		_ = os.Remove(tmp)
	}
}

// cleanProps keeps at most 20 string/number/bool props with valid keys.
func cleanProps(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		if len(out) == 20 || !validKey(k) {
			continue
		}
		switch x := v.(type) {
		case string:
			if len(x) > 200 {
				x = x[:200]
			}
			out[k] = x
		case bool, int, int64, int32, float64, float32, uint, uint64:
			out[k] = x
		}
	}
	return out
}

func validKey(k string) bool {
	if k == "" || len(k) > 32 || k[0] < 'a' || k[0] > 'z' {
		return false
	}
	for i := 0; i < len(k); i++ {
		c := k[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
