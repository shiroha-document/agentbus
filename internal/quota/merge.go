package quota

import (
	"strings"
	"time"
)

// mergeKey identifies one measured quantity.
type mergeKey struct{ provider, account, window string }

func keyOf(r Reading) mergeKey {
	return mergeKey{strings.ToLower(r.Provider), strings.ToLower(strings.TrimSpace(r.Account)), r.Window}
}

// usable says a native reading may stand without magpie's: it read fine
// and is no older than staleAfter.
func usable(r Reading, now time.Time) bool {
	return r.Error == "" && now.UnixMilli()-r.ReadAt <= staleAfter.Milliseconds()
}

// mergeAuto prefers, per (provider, account, window), the native reading,
// falling back to magpie's when the native one is missing, has Error set or
// is older than staleAfter.
//
// Accounts are named differently by the two sources at times (magpie adds
// " · Team" to a seat, native may not know the account at all), so a native
// reading with no account matches magpie's for the same provider and window
// whatever its account, and the other way round.
//
// When every native reading of a provider is unusable and magpie has
// readings for it, magpie's replace them all: a provider-wide native error
// (window "*") gives way to magpie's windows.
func mergeAuto(native, magpie []Reading, now time.Time) []Reading {
	nat := map[mergeKey]int{}
	for i, r := range native {
		nat[keyOf(r)] = i
	}
	// does magpie have anything for a provider?
	magpieHas := map[string]bool{}
	for _, r := range magpie {
		magpieHas[strings.ToLower(r.Provider)] = true
	}
	// does native have a usable reading for a provider?
	nativeGood := map[string]bool{}
	for _, r := range native {
		if usable(r, now) {
			nativeGood[strings.ToLower(r.Provider)] = true
		}
	}

	// find the native reading magpie's r is the counterpart of
	match := func(r Reading) (int, bool) {
		k := keyOf(r)
		if i, ok := nat[k]; ok {
			return i, true
		}
		for i, n := range native {
			nk := keyOf(n)
			if nk.provider == k.provider && nk.window == k.window && (nk.account == "" || k.account == "") {
				return i, true
			}
		}
		return 0, false
	}

	drop := make([]bool, len(native))
	var fromMagpie []Reading
	for _, m := range magpie {
		i, ok := match(m)
		if !ok {
			// native has no such window: magpie's fills the gap unless
			// native read the provider fine and magpie's is only an error
			if m.Error != "" && nativeGood[strings.ToLower(m.Provider)] {
				continue
			}
			fromMagpie = append(fromMagpie, m)
			continue
		}
		n := native[i]
		if usable(n, now) {
			continue // native wins
		}
		if m.Error != "" && n.Error == "" {
			continue // a stale reading beats an error
		}
		if m.Error != "" && n.Error != "" && m.ReadAt <= n.ReadAt {
			continue
		}
		drop[i] = true
		fromMagpie = append(fromMagpie, m)
	}
	// a provider-wide native error gives way to magpie's windows
	for i, n := range native {
		p := strings.ToLower(n.Provider)
		if n.Window == WindowAll && n.Error != "" && magpieHas[p] && !nativeGood[p] {
			drop[i] = true
		}
	}
	out := make([]Reading, 0, len(native)+len(fromMagpie))
	for i, n := range native {
		if !drop[i] {
			out = append(out, n)
		}
	}
	// a magpie provider-wide error is noise next to any native reading of it
	for _, m := range fromMagpie {
		if m.Window == WindowAll && m.Error != "" && hasProvider(out, m.Provider) {
			continue
		}
		out = append(out, m)
	}
	return out
}

func hasProvider(rs []Reading, p string) bool {
	for _, r := range rs {
		if strings.EqualFold(r.Provider, p) {
			return true
		}
	}
	return false
}
