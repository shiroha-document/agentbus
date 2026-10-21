package quota

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"
)

// Provider is one native quota reader.
type Provider interface {
	// ID is the provider id (claude, codex, zhipu…), listed in COVERAGE.md.
	ID() string
	// Detect says the provider is installed / configured on this machine.
	// It must be cheap: no network, no subprocess other than a PATH lookup.
	Detect() bool
	// Read returns the provider's readings. A provider that turns out not
	// to be logged in returns errNotLoggedIn (no reading is reported); any
	// other error becomes one reading with Error set.
	Read(ctx context.Context) ([]Reading, error)
}

// errNotLoggedIn drops a provider from the report without an error.
var errNotLoggedIn = errors.New("not logged in")

// WindowAll is the window of a reading about the provider as a whole: an
// error that stopped every window from being read.
const WindowAll = "*"

// readerTimeoutMax caps one reader's time; the overall Timeout caps it too.
var readerTimeoutMax = 15 * time.Second

var (
	registryMu sync.RWMutex
	registry   []Provider
)

// Register adds p to the native registry, replacing a provider of the same
// id.
func Register(p Provider) {
	if p == nil {
		return
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	for i, q := range registry {
		if q.ID() == p.ID() {
			registry[i] = p
			return
		}
	}
	registry = append(registry, p)
}

// Registered returns the registered native providers.
func Registered() []Provider {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return append([]Provider(nil), registry...)
}

// setRegistry replaces the registry and returns a func restoring it (tests).
func setRegistry(ps []Provider) (restore func()) {
	registryMu.Lock()
	old := registry
	registry = ps
	registryMu.Unlock()
	return func() {
		registryMu.Lock()
		registry = old
		registryMu.Unlock()
	}
}

func init() {
	for _, p := range builtinProviders() {
		Register(p)
	}
}

func builtinProviders() []Provider {
	ps := []Provider{
		claudeProvider{},
		codexProvider{},
		geminiProvider{},
		cursorProvider{},
		openRouterProvider{},
	}
	ps = append(ps, planProviders()...)
	ps = append(ps, balanceProviders()...)
	ps = append(ps, keyedPlanProviders()...)
	return append(ps, copilotProvider{}, clinePassProvider{})
}

type nowKey struct{}

func withNow(ctx context.Context, now func() time.Time) context.Context {
	return context.WithValue(ctx, nowKey{}, now)
}

// nowFrom is the clock Collect was given, time.Now outside Collect.
func nowFrom(ctx context.Context) time.Time {
	if f, ok := ctx.Value(nowKey{}).(func() time.Time); ok && f != nil {
		return f()
	}
	return time.Now()
}

type slot struct {
	id       string
	detected bool
	done     bool
	out      []Reading
}

// collectNative runs every selected, detected provider concurrently, each
// with its own timeout, and returns what they read before ctx ended.
func collectNative(ctx context.Context, opt Options) []Reading {
	ps := selectProviders(Registered(), opt.Providers)
	if len(ps) == 0 {
		return nil
	}
	per := readerTimeoutMax
	if t := opt.Timeout * 9 / 10; t > 0 && t < per {
		per = t
	}
	var mu sync.Mutex
	slots := make([]*slot, len(ps))
	var wg sync.WaitGroup
	for i, p := range ps {
		s := &slot{id: safeID(p)}
		slots[i] = s
		wg.Add(1)
		go func(p Provider, s *slot) {
			defer wg.Done()
			out, detected := runProvider(ctx, p, per, func() {
				mu.Lock()
				s.detected = true
				mu.Unlock()
			})
			mu.Lock()
			s.detected, s.done, s.out = detected, true, out
			mu.Unlock()
		}(p, s)
	}
	all := make(chan struct{})
	go func() { wg.Wait(); close(all) }()
	select {
	case <-all:
	case <-ctx.Done():
	}
	now := nowFrom(ctx).UnixMilli()
	mu.Lock()
	defer mu.Unlock()
	var out []Reading
	for _, s := range slots {
		switch {
		case s.done:
			out = append(out, s.out...)
		case s.detected:
			out = append(out, Reading{Provider: s.id, Window: WindowAll, Source: SourceNative, ReadAt: now, Error: "timeout"})
		}
	}
	return out
}

// runProvider detects and reads one provider, recovering from a panic and
// bounding Read by per. detected is called once Detect said yes.
func runProvider(ctx context.Context, p Provider, per time.Duration, detected func()) (out []Reading, ok bool) {
	id := safeID(p)
	defer func() {
		if recover() != nil {
			out = []Reading{{Provider: id, Window: WindowAll, Source: SourceNative, ReadAt: nowFrom(ctx).UnixMilli(), Error: "unknown: reader failed"}}
		}
	}()
	if id == "" || !p.Detect() {
		return nil, false
	}
	ok = true
	detected()
	rctx, cancel := context.WithTimeout(ctx, per)
	defer cancel()
	rs, err := p.Read(rctx)
	now := nowFrom(ctx).UnixMilli()
	if err != nil && len(rs) == 0 {
		if errors.Is(err, errNotLoggedIn) {
			return nil, true
		}
		msg := err.Error()
		if rctx.Err() != nil {
			msg = "timeout"
		}
		rs = []Reading{{Window: WindowAll, Error: msg}}
	}
	for i := range rs {
		r := &rs[i]
		if r.Provider == "" {
			r.Provider = id
		}
		if r.Window == "" {
			r.Window = WindowAll
		}
		r.Source = SourceNative
		if r.ReadAt == 0 {
			r.ReadAt = now
		}
		r.Error = sanitize(r.Error)
	}
	return rs, true
}

func safeID(p Provider) (id string) {
	defer func() {
		if recover() != nil {
			id = ""
		}
	}()
	return p.ID()
}

func selectProviders(ps []Provider, ids []string) []Provider {
	if len(ids) == 0 {
		return ps
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[strings.ToLower(strings.TrimSpace(id))] = true
	}
	var out []Provider
	for _, p := range ps {
		if want[strings.ToLower(safeID(p))] {
			out = append(out, p)
		}
	}
	return out
}

func f64(v float64) *float64 { return &v }
func i64(v int64) *int64     { return &v }

func clampPct(v float64) float64 {
	switch {
	case v != v: // NaN
		return 0
	case v < 0:
		return 0
	case v > 100:
		return 100
	}
	return v
}
