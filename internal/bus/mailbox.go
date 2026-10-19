package bus

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

var rcptRank = map[string]int{RcptDelivered: 1, RcptRead: 2, RcptAccepted: 3, RcptRejected: 3}

// Profiles returns all published agent profiles.
func (b *Bus) Profiles() (map[string]*Profile, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	return b.profiles, nil
}

// Events returns all loaded events in time order.
func (b *Bus) Events() ([]Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	return b.events, nil
}

// addressedTo reports whether e targets agent.
func (b *Bus) addressedTo(e *Event, agent string) bool {
	p := b.profiles[agent]
	for _, t := range e.To {
		switch {
		case t == agent || t == "*":
			return true
		case strings.HasPrefix(t, "#") && p != nil && slices.Contains(p.Channels, t[1:]):
			return true
		}
	}
	return false
}

func (b *Bus) addressedToMe(e *Event) bool {
	if !b.addressedTo(e, b.Me()) {
		return false
	}
	// Channel/broadcast tasks only reach agents that can run them.
	if e.Kind == KindTaskCreate && e.Task != nil && !slices.Contains(e.To, b.Me()) {
		return b.capable(b.Me(), e.Task.Requires)
	}
	return true
}

func (b *Bus) capable(agent string, req []string) bool {
	p := b.profiles[agent]
	for _, r := range req {
		if p == nil || !slices.Contains(p.Capabilities, r) {
			return false
		}
	}
	return true
}

// receiptLevel returns the highest receipt agent has given for ref.
func (b *Bus) receiptLevel(ref, agent string) string {
	best := ""
	for i := range b.events {
		e := &b.events[i]
		if e.Kind == KindReceipt && e.Ref == ref && e.From == agent && rcptRank[e.Status] > rcptRank[best] {
			best = e.Status
		}
	}
	return best
}

// Recipients expands e.To into concrete agent names.
func (b *Bus) Recipients(e *Event) []string {
	var out []string
	for name := range b.profiles {
		if name != e.From && b.addressedTo(e, name) {
			if e.Kind == KindTaskCreate && e.Task != nil && !slices.Contains(e.To, name) && !b.capable(name, e.Task.Requires) {
				continue
			}
			out = append(out, name)
		}
	}
	slices.Sort(out)
	return out
}

// RcptStatus is one recipient's receipt state for a message.
type RcptStatus struct {
	Agent  string `json:"agent"`
	Level  string `json:"level"` // "" = not yet delivered
	Reason string `json:"reason,omitempty"`
	At     string `json:"at,omitempty"`
}

// Status returns per-recipient receipts for a message/task.
func (b *Bus) Status(id string) (*Event, []RcptStatus, error) {
	e, err := b.Resolve(id)
	if err != nil {
		return nil, nil, err
	}
	var out []RcptStatus
	for _, r := range b.Recipients(e) {
		rs := RcptStatus{Agent: r}
		for i := range b.events {
			x := &b.events[i]
			if x.Kind == KindReceipt && x.Ref == e.ID && x.From == r && rcptRank[x.Status] > rcptRank[rs.Level] {
				rs.Level, rs.Reason, rs.At = x.Status, x.Reason, x.TS.Format(time.RFC3339)
			}
		}
		out = append(out, rs)
	}
	return e, out, nil
}

// Send emits a message.
func (b *Bus) Send(to []string, subject, body string, attach []string, replyTo string, expectAck time.Duration) (*Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	e := Event{Kind: KindMessage, To: to, Subject: subject, Body: body}
	if replyTo != "" {
		parent, err := b.Resolve(replyTo)
		if err != nil {
			return nil, err
		}
		e.ReplyTo, e.Thread = parent.ID, threadOf(parent)
		if len(e.To) == 0 {
			e.To = []string{parent.From}
		}
		if e.Subject == "" {
			e.Subject = "Re: " + strings.TrimPrefix(parent.Subject, "Re: ")
		}
	}
	if len(e.To) == 0 {
		return nil, fmt.Errorf("no recipient: use --to <agent|#channel|*>")
	}
	for _, t := range e.To {
		name := strings.TrimPrefix(t, "#")
		if t != "*" && !ValidName(name) {
			return nil, fmt.Errorf("invalid recipient %q", t)
		}
	}
	if expectAck > 0 {
		e.ExpectAck = b.Now().UTC().Add(expectAck).Format(time.RFC3339)
	}
	for _, p := range attach {
		a, err := b.PutBlob(p)
		if err != nil {
			return nil, err
		}
		e.Attach = append(e.Attach, a)
	}
	return b.Emit(e)
}

// Receipt emits a receipt for ref unless an equal-or-higher one exists.
func (b *Bus) Receipt(ref, level, reason string) (*Event, error) {
	e, err := b.Resolve(ref)
	if err != nil {
		return nil, err
	}
	if rcptRank[b.receiptLevel(e.ID, b.Me())] >= rcptRank[level] {
		return nil, nil
	}
	if level == RcptRejected && reason == "" {
		return nil, fmt.Errorf("--reason is required when rejecting")
	}
	return b.Emit(Event{Kind: KindReceipt, Ref: e.ID, Thread: threadOf(e), Status: level, Reason: reason, To: []string{e.From}})
}

// Read returns a message and records a read receipt if addressed to me.
func (b *Bus) Read(id string) (*Event, error) {
	e, err := b.Resolve(id)
	if err != nil {
		return nil, err
	}
	cp := *e
	if e.From != b.Me() && b.addressedToMe(e) && (e.Kind == KindMessage || e.Kind == KindTaskCreate) {
		if _, err := b.Receipt(e.ID, RcptRead, ""); err != nil {
			return nil, err
		}
	}
	return &cp, nil
}

// Notable reports whether e should surface in my inbox / wake me up.
func (b *Bus) Notable(e *Event) bool {
	me := b.Me()
	if e.From == me {
		return false
	}
	switch e.Kind {
	case KindMessage, KindTaskCreate:
		return b.addressedToMe(e)
	case KindReceipt:
		// Only decisions on things I sent.
		return (e.Status == RcptAccepted || e.Status == RcptRejected) && b.authoredByMe(e.Ref)
	case KindTaskDone:
		return b.authoredByMe(e.Ref)
	case KindTaskCancel:
		return b.claimedByMe(e.Ref)
	}
	return false
}

func (b *Bus) authoredByMe(id string) bool {
	x, ok := b.byID[id]
	return ok && x.From == b.Me()
}

// InboxItem is an inbox row.
type InboxItem struct {
	Event Event  `json:"event"`
	Level string `json:"my_receipt,omitempty"` // my receipt on it (msgs/tasks)
	New   bool   `json:"new"`                  // not yet surfaced to me
}

// Inbox lists notable events. unread: only msgs/tasks I have not read yet,
// plus decisions/results not yet surfaced.
func (b *Bus) Inbox(unread bool, markSeen bool) ([]InboxItem, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	st := loadState(b.Home)
	var out []InboxItem
	for i := range b.events {
		e := &b.events[i]
		if !b.Notable(e) {
			continue
		}
		it := InboxItem{Event: *e, New: !st.Seen[e.ID]}
		if e.Kind == KindMessage || e.Kind == KindTaskCreate {
			it.Level = b.receiptLevel(e.ID, b.Me())
			if unread && rcptRank[it.Level] >= rcptRank[RcptRead] {
				continue
			}
		} else if unread && !it.New {
			continue
		}
		out = append(out, it)
		if markSeen {
			st.Seen[e.ID] = true
		}
	}
	if markSeen {
		if err := st.save(b.Home); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// TakeNew returns notable events not yet surfaced, and marks them surfaced.
func (b *Bus) TakeNew() ([]Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	st := loadState(b.Home)
	var out []Event
	for i := range b.events {
		e := &b.events[i]
		if st.Seen[e.ID] || !b.Notable(e) {
			continue
		}
		out = append(out, *e)
		st.Seen[e.ID] = true
	}
	if len(out) > 0 {
		if err := st.save(b.Home); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Overdue lists my messages whose expect-ack deadline passed with at least one
// recipient not having accepted or rejected.
type OverdueItem struct {
	Event   Event    `json:"event"`
	Pending []string `json:"pending"`
}

// Overdue returns overdue items. If agent is "", it is computed for every
// sender (used by CI to notify humans).
func (b *Bus) Overdue(agent string) ([]OverdueItem, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	now := b.Now()
	var out []OverdueItem
	for i := range b.events {
		e := &b.events[i]
		if e.ExpectAck == "" || (agent != "" && e.From != agent) {
			continue
		}
		dl, err := time.Parse(time.RFC3339, e.ExpectAck)
		if err != nil || now.Before(dl) {
			continue
		}
		var pending []string
		for _, r := range b.Recipients(e) {
			if rcptRank[b.receiptLevel(e.ID, r)] < rcptRank[RcptAccepted] {
				pending = append(pending, r)
			}
		}
		if len(e.To) > 0 && len(b.Recipients(e)) == 0 {
			pending = append(pending, strings.Join(e.To, ","))
		}
		if len(pending) > 0 {
			out = append(out, OverdueItem{Event: *e, Pending: pending})
		}
	}
	return out, nil
}

// Thread returns every event in id's thread (including receipts/progress).
func (b *Bus) Thread(id string) ([]Event, error) {
	e, err := b.Resolve(id)
	if err != nil {
		return nil, err
	}
	root := threadOf(e)
	var out []Event
	for i := range b.events {
		x := &b.events[i]
		if x.ID == root || x.Thread == root || x.Ref == root {
			out = append(out, *x)
		}
	}
	return out, nil
}

// Filter selects history.
type Filter struct {
	Agent string // from or to
	Kind  string // exact, or prefix with trailing '*'
	Since time.Time
	Query string // case-insensitive substring over subject/body/reason/tail
	Limit int
}

// History returns events matching f (newest last).
func (b *Bus) History(f Filter) ([]Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	q := strings.ToLower(f.Query)
	var out []Event
	for i := range b.events {
		e := &b.events[i]
		if !f.Since.IsZero() && e.TS.Before(f.Since) {
			continue
		}
		if f.Agent != "" && e.From != f.Agent && !slices.Contains(e.To, f.Agent) {
			continue
		}
		if f.Kind != "" {
			if strings.HasSuffix(f.Kind, "*") {
				if !strings.HasPrefix(e.Kind, strings.TrimSuffix(f.Kind, "*")) {
					continue
				}
			} else if e.Kind != f.Kind {
				continue
			}
		}
		if q != "" {
			hay := strings.ToLower(e.Subject + "\n" + e.Body + "\n" + e.Reason)
			if e.Progress != nil {
				hay += "\n" + strings.ToLower(e.Progress.Phase+"\n"+e.Progress.Tail)
			}
			if !strings.Contains(hay, q) {
				continue
			}
		}
		out = append(out, *e)
	}
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[len(out)-f.Limit:]
	}
	return out, nil
}
