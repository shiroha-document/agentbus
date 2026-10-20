// Package quota reads remaining subscription / API quota for local coding
// agents and normalises it into Reading values that agentbus reports to the
// hub. Only readings leave the machine: never credentials or raw responses.
package quota

import (
	"context"
	"sort"
	"strings"
	"time"
)

// Balance is a monetary balance (API-key providers).
type Balance struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// Reading is one provider/account/window measurement. JSON field names match
// docs/design/hub-api.md (QuotaReading); times are Unix milliseconds.
type Reading struct {
	Provider string   `json:"provider"`
	Account  string   `json:"account,omitempty"`
	Plan     string   `json:"plan,omitempty"`
	Window   string   `json:"window"`
	UsedPct  *float64 `json:"used_pct"`
	ResetsAt *int64   `json:"resets_at"`
	Balance  *Balance `json:"balance,omitempty"`
	Source   string   `json:"source"` // "native" | "magpie"
	ReadAt   int64    `json:"read_at"`
	Error    string   `json:"error,omitempty"`
}

// Options controls Collect.
type Options struct {
	// Source is "auto" (default), "native", "magpie" or "both".
	Source string
	// Providers limits native collection to these provider ids; empty = all
	// detected on this machine.
	Providers []string
	// MagpiePath overrides the magpie binary lookup (default: PATH).
	MagpiePath string
	// Timeout bounds the whole collection (default 20s).
	Timeout time.Duration
	// Now is injectable for tests.
	Now func() time.Time
}

// Source values.
const (
	SourceAuto   = "auto"
	SourceNative = "native"
	SourceMagpie = "magpie"
	SourceBoth   = "both"
)

// DefaultTimeout bounds Collect when Options.Timeout is zero.
const DefaultTimeout = 20 * time.Second

// Collect gathers readings according to opt. It never returns an error:
// failures become readings with Error set (or are dropped when a provider is
// simply not installed), so a quota problem never blocks a tick.
func Collect(ctx context.Context, opt Options) (out []Reading) {
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	if ctx == nil {
		ctx = context.Background()
	}
	if opt.Timeout <= 0 {
		opt.Timeout = DefaultTimeout
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	mode := strings.ToLower(strings.TrimSpace(opt.Source))
	switch mode {
	case SourceNative, SourceMagpie, SourceBoth:
	default:
		mode = SourceAuto
	}
	// outer bounds Collect; the collectors get a slightly earlier deadline
	// so their partial results are handed back before outer ends
	outer, cancelOuter := context.WithTimeout(ctx, opt.Timeout)
	defer cancelOuter()
	margin := min(opt.Timeout/10, 250*time.Millisecond)
	ctx, cancel := context.WithTimeout(outer, opt.Timeout-margin)
	defer cancel()
	ctx = withNow(ctx, opt.Now)

	wantNative := mode != SourceMagpie
	wantMagpie := mode != SourceNative
	nativeCh := make(chan []Reading, 1)
	magpieCh := make(chan []Reading, 1)
	if wantNative {
		go func() {
			defer func() {
				if recover() != nil {
					nativeCh <- nil
				}
			}()
			nativeCh <- collectNative(ctx, opt)
		}()
	}
	if wantMagpie {
		go func() {
			defer func() {
				if recover() != nil {
					magpieCh <- nil
				}
			}()
			magpieCh <- collectMagpie(ctx, opt)
		}()
	}
	// Both collectors honour ctx themselves; outer only stops Collect from
	// waiting on one that doesn't.
	recv := func(ch chan []Reading) []Reading {
		select {
		case r := <-ch:
			return r
		case <-outer.Done():
			return nil
		}
	}
	var native, magpie []Reading
	if wantNative {
		native = recv(nativeCh)
	}
	if wantMagpie {
		magpie = filterProviders(recv(magpieCh), opt.Providers)
	}
	switch mode {
	case SourceNative:
		out = native
	case SourceMagpie:
		out = magpie
	case SourceBoth:
		out = append(append([]Reading{}, native...), magpie...)
	default:
		out = mergeAuto(native, magpie, opt.Now())
	}
	sortReadings(out)
	return out
}

// filterProviders keeps the readings of the listed providers (all when the
// list is empty).
func filterProviders(rs []Reading, ids []string) []Reading {
	if len(ids) == 0 {
		return rs
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[strings.ToLower(strings.TrimSpace(id))] = true
	}
	out := rs[:0:0]
	for _, r := range rs {
		if want[strings.ToLower(r.Provider)] {
			out = append(out, r)
		}
	}
	return out
}

func sortReadings(rs []Reading) {
	sort.SliceStable(rs, func(i, j int) bool {
		a, b := rs[i], rs[j]
		if a.Provider != b.Provider {
			return a.Provider < b.Provider
		}
		if a.Account != b.Account {
			return a.Account < b.Account
		}
		if a.Window != b.Window {
			return a.Window < b.Window
		}
		return a.Source > b.Source // native before magpie
	})
}
