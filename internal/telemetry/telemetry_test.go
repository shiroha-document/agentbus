package telemetry

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/shiroha-document/agentbus/internal/hub"
)

type fakeSender struct {
	got [][]hub.Event
	err error
}

func (f *fakeSender) Events(_ context.Context, evs []hub.Event) error {
	if f.err != nil {
		return f.err
	}
	f.got = append(f.got, evs)
	return nil
}

func setup(t *testing.T, on bool) string {
	t.Helper()
	t.Setenv("AGENTBUS_TELEMETRY", "")
	d := t.TempDir()
	Init(d, on, "0.6.0")
	t.Cleanup(func() { Init("", false, "") })
	return d
}

func TestRecordAndFlush(t *testing.T) {
	setup(t, true)
	for i := 0; i < 120; i++ {
		Record(hub.Event{Name: "cli.command", Props: map[string]any{"cmd": "post", "n": i, "Bad-Key": "x", "obj": []int{1}}})
	}
	if Queued() != 120 {
		t.Fatal(Queued())
	}
	f := &fakeSender{}
	if n := Flush(context.Background(), f); n != 50 || Queued() != 70 {
		t.Fatalf("sent %d, queued %d", n, Queued())
	}
	ev := f.got[0][0]
	if ev.ClientVersion != "0.6.0" || ev.OS != runtime.GOOS || ev.At == 0 || ev.Props["cmd"] != "post" ||
		ev.Props["Bad-Key"] != nil || ev.Props["obj"] != nil || ev.Props["n"].(float64) != 0 {
		t.Fatalf("%+v", ev)
	}
	// failures keep the queue
	if n := Flush(context.Background(), &fakeSender{err: errors.New("down")}); n != 0 || Queued() != 70 {
		t.Fatal(n, Queued())
	}
	Flush(context.Background(), f)
	Flush(context.Background(), f)
	if Queued() != 0 || len(f.got) != 3 || len(f.got[2]) != 20 || f.got[2][19].Props["n"].(float64) != 119 {
		t.Fatalf("queued %d, batches %d", Queued(), len(f.got))
	}
	if _, err := os.Stat(Path()); !os.IsNotExist(err) {
		t.Fatal("empty queue file left behind")
	}
}

func TestCap(t *testing.T) {
	setup(t, true)
	for i := 0; i < MaxQueued+300; i++ {
		Record(hub.Event{Name: "cli.tick", Props: map[string]any{"threads": i, "pad": fmt.Sprintf("%0150d", 0)}})
	}
	if q := Queued(); q > MaxQueued || q < MaxQueued-50 {
		t.Fatal(q)
	}
	f := &fakeSender{}
	Flush(context.Background(), f)
	if f.got[0][0].Props["threads"].(float64) < 300 {
		t.Fatalf("oldest not dropped: %v", f.got[0][0].Props)
	}
}

func TestOptOut(t *testing.T) {
	d := setup(t, false)
	Record(hub.Event{Name: "cli.command"})
	if _, err := os.Stat(filepath.Join(d, FileName)); !os.IsNotExist(err) {
		t.Fatal("recorded while disabled")
	}
	Init(d, true, "x")
	for _, v := range []string{"off", "0", "FALSE"} {
		t.Setenv("AGENTBUS_TELEMETRY", v)
		if Enabled() {
			t.Fatal(v)
		}
	}
	t.Setenv("AGENTBUS_TELEMETRY", "on")
	if !Enabled() {
		t.Fatal("on")
	}
	// a missing config dir is never created
	Init(filepath.Join(d, "nope"), true, "x")
	Record(hub.Event{Name: "cli.command"})
	if _, err := os.Stat(filepath.Join(d, "nope")); !os.IsNotExist(err) {
		t.Fatal("dir created")
	}
	if Flush(context.Background(), nil) != 0 {
		t.Fatal("nil sender")
	}
}

func TestCleanProps(t *testing.T) {
	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	in := map[string]any{"s": string(long)}
	for i := 0; i < 30; i++ {
		in[fmt.Sprintf("k%d", i)] = i
	}
	out := cleanProps(in)
	if len(out) != 20 {
		t.Fatal(len(out))
	}
	if s, ok := out["s"].(string); ok && len(s) != 200 {
		t.Fatal(len(s))
	}
	for _, k := range []string{"", "9a", "A", "a-b", "abcdefghijabcdefghijabcdefghijabc"} {
		if validKey(k) {
			t.Error(k)
		}
	}
}
