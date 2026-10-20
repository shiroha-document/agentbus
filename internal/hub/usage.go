package hub

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"strings"
	"sync"
	"time"
)

// NewID returns "<prefix>_<26 lowercase base32>" whose first 10 characters
// encode the Unix millisecond time (ULID layout, hub-api.md §0).
func NewID(prefix string, t time.Time) string {
	const alpha = "0123456789abcdefghjkmnpqrstvwxyz"
	var out [26]byte
	ms := uint64(t.UnixMilli())
	for i := 9; i >= 0; i-- {
		out[i] = alpha[ms&31]
		ms >>= 5
	}
	var r [16]byte
	_, _ = rand.Read(r[:])
	for i := 10; i < 26; i++ {
		out[i] = alpha[r[i-10]&31]
	}
	return prefix + "_" + string(out[:])
}

// UsageEntry is one line of usage.jsonl.
type UsageEntry struct {
	Run      Run    `json:"run"`
	Reported bool   `json:"reported"`
	Thread   string `json:"thread_title,omitempty"`
}

var usageMu sync.Mutex

// AppendUsage adds entries to usage.jsonl.
func AppendUsage(path string, es ...UsageEntry) error {
	usageMu.Lock()
	defer usageMu.Unlock()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	for _, e := range es {
		b, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if _, err := f.Write(append(b, '\n')); err != nil {
			return err
		}
	}
	return nil
}

// ReadUsage reads every entry of usage.jsonl (broken lines are skipped).
func ReadUsage(path string) ([]UsageEntry, error) {
	usageMu.Lock()
	defer usageMu.Unlock()
	return readUsage(path)
}

func readUsage(path string) ([]UsageEntry, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []UsageEntry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "" {
			continue
		}
		var e UsageEntry
		if json.Unmarshal([]byte(l), &e) == nil && e.Run.ID != "" {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

// MarkReported rewrites usage.jsonl marking the given run ids reported.
func MarkReported(path string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	usageMu.Lock()
	defer usageMu.Unlock()
	es, err := readUsage(path)
	if err != nil {
		return err
	}
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	var b strings.Builder
	for _, e := range es {
		if set[e.Run.ID] {
			e.Reported = true
		}
		line, _ := json.Marshal(e)
		b.Write(line)
		b.WriteByte('\n')
	}
	return writeFileAtomic(path, []byte(b.String()), 0o600)
}

// Unreported returns runs not yet accepted by the hub.
func Unreported(path string) []Run {
	es, _ := ReadUsage(path)
	var out []Run
	for _, e := range es {
		if !e.Reported {
			out = append(out, e.Run)
		}
	}
	return out
}
