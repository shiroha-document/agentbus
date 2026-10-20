package bus

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"
)

// BoardOpts controls the human dashboard.
type BoardOpts struct {
	Loc     *time.Location // display time zone (default UTC)
	Recent  time.Duration  // window for finished tasks / messages (default 7 days)
	MaxRows int            // per section (default 30)
}

// boardLimit keeps the rendered board under GitHub's 65,536-char issue body cap.
const boardLimit = 60000

// Board renders a full snapshot of the bus as markdown: agents, live tasks,
// things that need a human, recently finished work and recent mail. Unlike
// Digest it is a state view (always non-empty), meant to overwrite the body
// of one pinned issue so it reads like a web dashboard. It never @-mentions
// anyone, because edits that add mentions would notify people every refresh.
func (b *Bus) Board(o BoardOpts) (string, error) {
	if err := b.load(); err != nil {
		return "", err
	}
	if o.Loc == nil {
		o.Loc = time.UTC
	}
	if o.Recent <= 0 {
		o.Recent = 7 * 24 * time.Hour
	}
	if o.MaxRows <= 0 {
		o.MaxRows = 30
	}
	now := b.Now()
	since := now.Add(-o.Recent)
	at := func(t time.Time) string {
		if t.IsZero() {
			return "-"
		}
		return t.In(o.Loc).Format("01-02 15:04") + " (" + agoAt(now, t) + ")"
	}

	// ---- collect ----
	last := map[string]time.Time{}
	for i := range b.events {
		e := &b.events[i]
		if e.TS.After(last[e.From]) {
			last[e.From] = e.TS
		}
	}
	var live, done []*TaskView
	for i := range b.events {
		e := &b.events[i]
		if e.Kind != KindTaskCreate || e.Task == nil {
			continue
		}
		v := b.view(e)
		switch v.State {
		case TaskOpen, TaskRunning, TaskStale:
			live = append(live, v)
		default:
			if finishedAt(v).After(since) {
				done = append(done, v)
			}
		}
	}
	sort.SliceStable(done, func(i, j int) bool { return finishedAt(done[i]).After(finishedAt(done[j])) })

	var attention []string
	ov, _ := b.Overdue("")
	for _, it := range ov {
		attention = append(attention, fmt.Sprintf("- ⏰ ack overdue: %s from **%s**, waiting on %s", cell(describe(&it.Event)), it.Event.From, strings.Join(it.Pending, ", ")))
	}
	for _, v := range live {
		if v.State == TaskStale {
			attention = append(attention, fmt.Sprintf("- ⚠️ task `%s` **%s** is stale: %s", ShortID(v.Task.ID), cell(v.Task.Subject), cell(v.Reason)))
		}
	}
	for _, v := range done {
		if (v.State == TaskFailed || v.State == TaskExpired) && finishedAt(v).After(now.Add(-24*time.Hour)) {
			attention = append(attention, fmt.Sprintf("- ❌ task `%s` **%s** %s: %s", ShortID(v.Task.ID), cell(v.Task.Subject), v.State, cell(v.Reason)))
		}
	}
	var toHuman, mail []*Event
	for i := len(b.events) - 1; i >= 0; i-- {
		e := &b.events[i]
		if e.Kind != KindMessage || e.TS.Before(since) {
			continue
		}
		if slices.Contains(e.To, "human") || slices.Contains(e.To, "#human") {
			toHuman = append(toHuman, e)
		} else {
			mail = append(mail, e)
		}
	}

	// ---- render ----
	var sb strings.Builder
	fmt.Fprintf(&sb, "# agentbus board\n\n")
	fmt.Fprintf(&sb, "Updated **%s** (%s) · %d agents · %d live tasks · %d need attention\n",
		now.In(o.Loc).Format("2006-01-02 15:04"), o.Loc, len(b.profiles), len(live), len(attention))

	if len(attention) > 0 {
		fmt.Fprintf(&sb, "\n## Needs attention\n\n%s\n", strings.Join(capRows(attention, o.MaxRows), "\n"))
	}

	if len(toHuman) > 0 {
		sb.WriteString("\n## For humans\n\n| when | from | subject | id |\n|---|---|---|---|\n")
		for i, e := range toHuman {
			if i == o.MaxRows {
				fmt.Fprintf(&sb, "| | | … %d more | |\n", len(toHuman)-i)
				break
			}
			fmt.Fprintf(&sb, "| %s | %s | %s | `%s` |\n", at(e.TS), e.From, cell(firstNonEmpty(e.Subject, oneLine(e.Body, 80))), ShortID(e.ID))
		}
	}

	sb.WriteString("\n## Agents\n\n")
	if len(b.profiles) == 0 {
		sb.WriteString("_No agents yet. Point one at docs/ONBOARDING.md._\n")
	} else {
		sb.WriteString("| | agent | owner | role | caps | wake | last activity |\n|---|---|---|---|---|---|---|\n")
		names := make([]string, 0, len(b.profiles))
		for n := range b.profiles {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			p := b.profiles[n]
			fmt.Fprintf(&sb, "| %s | **%s** | %s | %s | %s | %s | %s |\n", presence(now, last[n]), n, cell(strings.TrimPrefix(p.Owner, "@")),
				cell(p.Role), cell(strings.Join(p.Capabilities, ", ")), cell(p.Wake), at(last[n]))
		}
		sb.WriteString("\n<sub>🟢 active < 30 min · 🟡 < 24 h · ⚪ older. Agents only show activity when they write to the bus.</sub>\n")
	}

	sb.WriteString("\n## Live tasks\n\n")
	if len(live) == 0 {
		sb.WriteString("_None._\n")
	} else {
		sb.WriteString("| id | task | from → to | state | claimer | progress | last beat | deadline |\n|---|---|---|---|---|---|---|---|\n")
		for i, v := range live {
			if i == o.MaxRows {
				fmt.Fprintf(&sb, "| | … %d more | | | | | | |\n", len(live)-i)
				break
			}
			prog := "-"
			if v.Last != nil {
				prog = fmt.Sprintf("%d%% %s", v.Last.Percent, cell(v.Last.Phase))
			}
			claimer := "-"
			if v.Claimer != "" {
				claimer = fmt.Sprintf("%s (#%d/%d)", v.Claimer, v.Attempt, v.MaxAttempts)
			}
			beat := "-"
			if v.Attempt > 0 {
				beat = at(v.LastBeat)
			}
			dl := "-"
			if !v.Deadline.IsZero() {
				dl = v.Deadline.In(o.Loc).Format("01-02 15:04")
			}
			fmt.Fprintf(&sb, "| `%s` | %s | %s → %s | %s %s | %s | %s | %s | %s |\n", ShortID(v.Task.ID), cell(v.Task.Subject),
				v.Task.From, cell(strings.Join(v.Task.To, ",")), stateIcon(v.State), v.State, claimer, prog, beat, dl)
		}
	}

	if len(done) > 0 {
		fmt.Fprintf(&sb, "\n## Finished (last %s)\n\n| id | task | state | by | finished | note |\n|---|---|---|---|---|---|\n", fmtWindow(o.Recent))
		for i, v := range done {
			if i == o.MaxRows {
				fmt.Fprintf(&sb, "| | … %d more | | | | |\n", len(done)-i)
				break
			}
			fmt.Fprintf(&sb, "| `%s` | %s | %s %s | %s | %s | %s |\n", ShortID(v.Task.ID), cell(v.Task.Subject), stateIcon(v.State), v.State,
				firstNonEmpty(v.Claimer, v.CancelledBy, "-"), at(finishedAt(v)), cell(oneLine(v.Reason, 80)))
		}
	}

	if len(mail) > 0 {
		fmt.Fprintf(&sb, "\n## Recent mail (last %s)\n\n| when | from → to | subject | id |\n|---|---|---|---|\n", fmtWindow(o.Recent))
		for i, e := range mail {
			if i == o.MaxRows {
				fmt.Fprintf(&sb, "| | | … %d more (`agentbus history`) | |\n", len(mail)-i)
				break
			}
			subj := firstNonEmpty(e.Subject, oneLine(e.Body, 80))
			if e.ReplyTo != "" {
				subj = "↩ " + subj
			}
			fmt.Fprintf(&sb, "| %s | %s → %s | %s | `%s` |\n", at(e.TS), e.From, cell(strings.Join(e.To, ",")), cell(subj), ShortID(e.ID))
		}
	}

	sb.WriteString("\n---\n<sub>Read-only snapshot of the `agent-bus` branch, refreshed by the digest workflow. " +
		"Refresh now: Actions → agentbus-digest → Run workflow. Details: `agentbus brief ID`.</sub>\n")
	out := sb.String()
	if len(out) > boardLimit {
		cut := strings.LastIndex(out[:boardLimit], "\n")
		out = out[:cut] + "\n\n_(board truncated; use `agentbus history` for the rest)_\n"
	}
	return out, nil
}

func finishedAt(v *TaskView) time.Time {
	switch {
	case v.Result != nil:
		return v.Result.TS
	case v.CancelAt != nil:
		return *v.CancelAt
	case !v.Deadline.IsZero():
		return v.Deadline
	}
	return v.LastBeat
}

func presence(now, t time.Time) string {
	switch {
	case t.IsZero():
		return "⚪"
	case now.Sub(t) < 30*time.Minute:
		return "🟢"
	case now.Sub(t) < 24*time.Hour:
		return "🟡"
	}
	return "⚪"
}

func stateIcon(s string) string {
	switch s {
	case TaskOpen:
		return "🆕"
	case TaskRunning:
		return "🏃"
	case TaskStale:
		return "⚠️"
	case TaskSucceeded:
		return "✅"
	case TaskFailed:
		return "❌"
	case TaskCancelled:
		return "⏹"
	case TaskExpired:
		return "⌛"
	}
	return ""
}

// cell makes text safe inside a markdown table cell and keeps it from
// @-mentioning people or auto-linking issues on every board refresh.
func cell(s string) string {
	s = oneLine(s, 120)
	if s == "" {
		return "-"
	}
	r := strings.NewReplacer("|", "\\|", "@", "@​", "<", "&lt;", ">", "&gt;", "#", "#​")
	return r.Replace(s)
}

func capRows(rows []string, n int) []string {
	if len(rows) <= n {
		return rows
	}
	return append(rows[:n:n], fmt.Sprintf("- … and %d more", len(rows)-n))
}

func agoAt(now, t time.Time) string {
	d := now.Sub(t)
	switch {
	case d < 0:
		return "in " + fmtWindow(-d)
	case d < time.Minute:
		return "just now"
	}
	return fmtWindow(d) + " ago"
}

func fmtWindow(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}
