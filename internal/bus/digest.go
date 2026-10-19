package bus

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// OpenRemote opens a read-only view of a bus (no profile, never pushes). Used
// by CI and admin tooling. dir is a scratch directory that may be reused.
func OpenRemote(remote, branch, dir string) (*Bus, error) {
	if branch == "" {
		branch = "agent-bus"
	}
	g, err := Clone(remote, branch, filepath.Join(dir, "clone"), "agentbus-ci", "")
	if err != nil {
		return nil, err
	}
	if err := g.Pull(); err != nil {
		return nil, err
	}
	return &Bus{Home: dir, Cfg: &Config{Remote: remote, Branch: branch, Me: "agentbus-ci"}, Git: g, Now: time.Now, Warn: os.Stderr}, nil
}

// Refresh pulls without emitting anything (read-only sync).
func (b *Bus) Refresh() error {
	if err := b.Git.Pull(); err != nil {
		return err
	}
	b.loaded = false
	return b.load()
}

// Digest levels.
const (
	DigestAll       = "all"       // every human-meaningful event
	DigestImportant = "important" // things a human should look at
	DigestAlerts    = "alerts"    // only time-based alerts (overdue / stale / expired)
)

// DigestOpts selects what a digest covers.
type DigestOpts struct {
	Since time.Time       // events / alerts after this time
	IDs   map[string]bool // if set, only these events (e.g. from a pushed commit range)
	Level string
}

// EventIDsInRange lists event ids added between two commits (push payload).
func (b *Bus) EventIDsInRange(from, to string) (map[string]bool, error) {
	args := []string{"diff", "--name-only", "--diff-filter=A", from, to, "--", "events/"}
	if strings.Trim(from, "0") == "" {
		args = []string{"ls-tree", "-r", "--name-only", to, "--", "events/"}
	}
	out, err := b.Git.run(args...)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, l := range strings.Split(out, "\n") {
		if base := filepath.Base(strings.TrimSpace(l)); strings.HasSuffix(base, ".json") {
			ids[strings.TrimSuffix(base, ".json")] = true
		}
	}
	return ids, nil
}

// Digest renders a markdown summary for humans. Empty string = nothing to say.
// Agent owners (profile.owner, a GitHub login) are @-mentioned on things that
// need them, which is what turns into e-mail on GitHub.
func (b *Bus) Digest(o DigestOpts) (string, error) {
	if err := b.load(); err != nil {
		return "", err
	}
	if o.Level == "" {
		o.Level = DigestAll
	}
	now := b.Now()
	owner := func(agent string) string {
		if p := b.profiles[agent]; p != nil && p.Owner != "" {
			return "@" + strings.TrimPrefix(p.Owner, "@")
		}
		return ""
	}
	var human, tasks, msgs, agents, alerts []string
	mention := map[string]bool{}
	in := func(e *Event) bool {
		if o.IDs != nil {
			return o.IDs[e.ID]
		}
		return !o.Since.IsZero() && e.TS.After(o.Since)
	}
	if o.Level != DigestAlerts {
		for i := range b.events {
			e := &b.events[i]
			if !in(e) {
				continue
			}
			toHuman := slices.Contains(e.To, "human") || slices.Contains(e.To, "#human")
			switch {
			case e.Kind == KindMessage && toHuman:
				m := owner(e.From)
				mention[m] = m != ""
				human = append(human, fmt.Sprintf("- **%s** → human %s: **%s** `%s`\n%s", e.From, m, firstNonEmpty(e.Subject, "(no subject)"),
					ShortID(e.ID), quote(oneLineKeep(e.Body, 1200))))
			case e.Kind == KindMessage && o.Level == DigestAll:
				msgs = append(msgs, fmt.Sprintf("- %s → %s: %s", e.From, strings.Join(e.To, ","), describe(e)))
			case e.Kind == KindTaskCreate && o.Level == DigestAll:
				tasks = append(tasks, fmt.Sprintf("- 🆕 %s → %s: **%s** `%s`", e.From, strings.Join(e.To, ","), e.Subject, ShortID(e.ID)))
			case e.Kind == KindTaskDone && e.Progress != nil:
				t := b.byID[e.Ref]
				if t == nil {
					continue
				}
				icon, m := "✅", ""
				if e.Progress.Status != TaskSucceeded {
					icon, m = "❌", owner(t.From)
					mention[m] = m != ""
				} else if o.Level != DigestAll {
					m = owner(t.From)
				}
				tasks = append(tasks, fmt.Sprintf("- %s **%s** (%s) by %s, attempt %d: %s %s %s", icon, t.Subject, ShortID(t.ID), e.From,
					e.Progress.Attempt, e.Progress.Status, firstNonEmpty(e.Reason, ""), m))
			case e.Kind == KindTaskCancel && o.Level == DigestAll:
				tasks = append(tasks, fmt.Sprintf("- ⏹ %s cancelled %s: %s", e.From, ShortID(e.Ref), e.Reason))
			case e.Kind == KindReceipt && e.Status == RcptRejected:
				t := b.byID[e.Ref]
				m := ""
				if t != nil {
					m = owner(t.From)
				}
				msgs = append(msgs, fmt.Sprintf("- 🚫 %s rejected %s: %s %s", e.From, ShortID(e.Ref), e.Reason, m))
			case e.Kind == KindHello:
				if b.firstHello(e) {
					agents = append(agents, fmt.Sprintf("- 👋 **%s** joined (%s) caps=%v wake=%s %s", e.From, profileRole(e), profileCaps(e), profileWake(e), owner(e.From)))
				}
			}
		}
	}
	// time-based alerts that crossed their threshold inside the window
	win := o.Since
	if win.IsZero() {
		win = now.Add(-time.Hour)
	}
	if o.Level != DigestAll || o.IDs == nil {
		ov, _ := b.Overdue("")
		for _, it := range ov {
			dl, _ := time.Parse(time.RFC3339, it.Event.ExpectAck)
			if dl.After(win) {
				m := owner(it.Event.From)
				mention[m] = m != ""
				alerts = append(alerts, fmt.Sprintf("- ⏰ ack overdue on %s from %s, pending: %s %s", describe(&it.Event), it.Event.From, strings.Join(it.Pending, ","), m))
			}
		}
		for i := range b.events {
			t := &b.events[i]
			if t.Kind != KindTaskCreate || t.Task == nil {
				continue
			}
			v := b.view(t)
			var crossed time.Time
			switch v.State {
			case TaskExpired:
				crossed = v.Deadline
			case TaskStale, TaskFailed:
				if v.Result == nil && v.Attempt > 0 {
					crossed = v.LastBeat.Add(time.Duration(v.Heartbeat*StaleAfterBeats) * time.Second)
				}
			}
			if crossed.IsZero() || !crossed.After(win) || crossed.After(now) {
				continue
			}
			m := owner(t.From)
			mention[m] = m != ""
			alerts = append(alerts, fmt.Sprintf("- ⚠️ task **%s** `%s` is %s: %s %s", t.Subject, ShortID(t.ID), v.State, v.Reason, m))
		}
	}
	if len(human)+len(tasks)+len(msgs)+len(agents)+len(alerts) == 0 {
		return "", nil
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "### agentbus digest — %s\n", now.UTC().Format("2006-01-02 15:04 MST"))
	section := func(title string, rows []string) {
		if len(rows) > 0 {
			fmt.Fprintf(&sb, "\n**%s**\n\n%s\n", title, strings.Join(rows, "\n"))
		}
	}
	section("For humans", human)
	section("Needs attention", alerts)
	section("Tasks", tasks)
	section("Agents", agents)
	if len(msgs) > 40 {
		msgs = append(msgs[:40], fmt.Sprintf("- … and %d more (`agentbus history`)", len(msgs)-40))
	}
	section("Messages", msgs)
	sb.WriteString("\n<sub>reply as an agent: `agentbus send --reply ID`; full context: `agentbus brief ID`</sub>\n")
	return sb.String(), nil
}

func (b *Bus) firstHello(e *Event) bool {
	for i := range b.events {
		x := &b.events[i]
		if x.Kind == KindHello && x.From == e.From {
			return x.ID == e.ID
		}
	}
	return false
}

func profileRole(e *Event) string {
	if e.Profile != nil {
		return firstNonEmpty(e.Profile.Role, "no role")
	}
	return "no role"
}

func profileCaps(e *Event) []string {
	if e.Profile != nil {
		return e.Profile.Capabilities
	}
	return nil
}

func profileWake(e *Event) string {
	if e.Profile != nil {
		return e.Profile.Wake
	}
	return ""
}

func quote(s string) string {
	if s == "" {
		return ""
	}
	return "  > " + strings.ReplaceAll(s, "\n", "\n  > ")
}

func oneLineKeep(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) > n {
		return string([]rune(s)[:n]) + "…"
	}
	return s
}
