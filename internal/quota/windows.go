package quota

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Window names follow hub-api.md: "5h", "7d", "monthly", "daily",
// "balance", otherwise a short lowercase token. A model- or pool-specific
// window is "<span>_<model>" for subscription sub-windows ("7d_opus") and
// "<bucket>_<span>" for a plan's side buckets ("video_5h", "mcp_month"),
// matching how magpie names them ("7 days · Opus", "Video · 5 hours").

const (
	windowBalance = "balance"
	windowMonthly = "monthly"
	windowDaily   = "daily"
)

// spanWindow names a window by its length: 300m -> "5h", 7 days -> "7d".
func spanWindow(d time.Duration) string {
	switch {
	case d <= 0:
		return "allowance"
	case d%(24*time.Hour) == 0:
		return fmt.Sprintf("%dd", d/(24*time.Hour))
	case d%time.Hour == 0:
		return fmt.Sprintf("%dh", d/time.Hour)
	case d >= time.Minute:
		return fmt.Sprintf("%dm", d/time.Minute)
	}
	return "allowance"
}

var reSpanPart = regexp.MustCompile(`^(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$`)

// normWindow turns a magpie window name into a hub window name.
func normWindow(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "allowance"
	}
	parts := strings.Split(name, "·")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = normWindowPart(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return "allowance"
	}
	return strings.Join(out, "_")
}

func normWindowPart(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	if m := reSpanPart.FindStringSubmatch(p); m != nil {
		n, _ := strconv.Atoi(m[1])
		switch m[2][0] {
		case 'm':
			return spanWindow(time.Duration(n) * time.Minute)
		case 'h':
			return spanWindow(time.Duration(n) * time.Hour)
		case 'd':
			return spanWindow(time.Duration(n) * 24 * time.Hour)
		case 'w':
			return spanWindow(time.Duration(n) * 7 * 24 * time.Hour)
		}
	}
	switch p {
	case "month", "monthly", "per month":
		return windowMonthly
	case "day", "daily", "today", "per day":
		return windowDaily
	case "week", "weekly":
		return "7d"
	case "hour", "hourly":
		return "1h"
	}
	var b strings.Builder
	dash := false
	for _, r := range p {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-':
			b.WriteRune(r)
			dash = false
		case r > 0x7f:
			b.WriteRune(r)
			dash = false
		default:
			if !dash && b.Len() > 0 {
				b.WriteByte('_')
				dash = true
			}
		}
	}
	return strings.Trim(b.String(), "_")
}
