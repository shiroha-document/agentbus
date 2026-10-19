package bus

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Wait syncs every interval until there is at least one new notable event or
// ctx/timeout expires. It is the primitive for agents that cannot schedule
// themselves: call `agentbus wait --timeout 14m` inside a single turn.
// On timeout it returns (nil, nil), or the last transient sync error if the
// final attempt failed.
func (b *Bus) Wait(ctx context.Context, timeout, interval time.Duration, match func(*Event) bool) ([]Event, error) {
	if interval <= 0 {
		interval = 20 * time.Second
	}
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	var lastErr error
	for {
		evs, err := b.Poll(match)
		var te *TransientError
		switch {
		case errors.As(err, &te):
			lastErr = err // network hiccup: keep waiting
		case err != nil:
			return nil, err
		case len(evs) > 0:
			return evs, nil
		default:
			lastErr = nil
		}
		select {
		case <-ctx.Done():
			return nil, lastErr
		case <-time.After(interval):
		}
	}
}

// Poll does one sync and returns notable events not yet surfaced (marking
// them surfaced). Sync failures are wrapped in *TransientError.
func (b *Bus) Poll(match func(*Event) bool) ([]Event, error) {
	unlock := b.opLock()
	defer unlock()
	if err := b.Sync(); err != nil {
		return nil, &TransientError{err}
	}
	evs, err := b.peekNew(match)
	if err != nil || len(evs) == 0 {
		return nil, err
	}
	return b.markSeen(evs)
}

// TransientError marks a retryable (network / remote) failure.
type TransientError struct{ Err error }

func (t *TransientError) Error() string { return "sync: " + t.Err.Error() }
func (t *TransientError) Unwrap() error { return t.Err }

func (b *Bus) peekNew(match func(*Event) bool) ([]Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	st := loadState(b.Home)
	var out []Event
	for i := range b.events {
		e := &b.events[i]
		if st.Seen[e.ID] || !b.Notable(e) || (match != nil && !match(e)) {
			continue
		}
		out = append(out, *e)
	}
	return out, nil
}

func (b *Bus) markSeen(evs []Event) ([]Event, error) {
	st := loadState(b.Home)
	for _, e := range evs {
		st.Seen[e.ID] = true
	}
	return evs, st.save(b.Home)
}

// KindMatcher returns a matcher for kinds like ["msg", "task.*"]; nil = all.
func KindMatcher(kinds []string) func(*Event) bool {
	if len(kinds) == 0 {
		return nil
	}
	return func(e *Event) bool {
		for _, k := range kinds {
			if k == e.Kind || (strings.HasSuffix(k, "*") && strings.HasPrefix(e.Kind, strings.TrimSuffix(k, "*"))) {
				return true
			}
		}
		return false
	}
}
