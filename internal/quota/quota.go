// Package quota reads remaining subscription / API quota for local coding
// agents and normalises it into Reading values that agentbus reports to the
// hub. Only readings leave the machine: never credentials or raw responses.
package quota

import (
	"context"
	"sort"
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
	Source   string   `json:"source"` // always "native"
	ReadAt   int64    `json:"read_at"`
	Error    string   `json:"error,omitempty"`
}

// Options controls Collect.
type Options struct {
	// Source is kept for configs written before v0.6: every value reads
	// natively ("magpie" and "both" are deprecated and mean "native").
	Source string
	// Providers limits collection to these provider ids; empty = all
	// detected on this machine.
	Providers []string
	// MagpiePath is deprecated and ignored: magpie is no longer run.
	MagpiePath string
	// Timeout bounds the whole collection (default 20s).
	Timeout time.Duration
	// Now is injectable for tests.
	Now func() time.Time
}

// Source values. Only native readers exist; SourceMagpie and SourceBoth
// are deprecated and read natively, like SourceAuto.
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
	// outer bounds Collect; the readers get a slightly earlier deadline so
	// their partial results are handed back before outer ends
	outer, cancelOuter := context.WithTimeout(ctx, opt.Timeout)
	defer cancelOuter()
	margin := min(opt.Timeout/10, 250*time.Millisecond)
	ctx, cancel := context.WithTimeout(outer, opt.Timeout-margin)
	defer cancel()
	ctx = withNow(ctx, opt.Now)

	ch := make(chan []Reading, 1)
	go func() {
		defer func() {
			if recover() != nil {
				ch <- nil
			}
		}()
		ch <- collectNative(ctx, opt)
	}()
	// collectNative honours ctx itself; outer only stops Collect from
	// waiting on it if it doesn't
	select {
	case out = <-ch:
	case <-outer.Done():
	}
	sortReadings(out)
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
		return a.Window < b.Window
	})
}
