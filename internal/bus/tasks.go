package bus

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Defaults for long tasks.
const (
	DefaultHeartbeat   = 10 * time.Minute
	DefaultDeadline    = 6 * time.Hour
	DefaultMaxAttempts = 2
	// A claimer is considered gone after missing this many heartbeats.
	StaleAfterBeats = 3
)

var (
	// ErrFenced: the caller's attempt is no longer the current one (someone
	// re-claimed a stale task). The caller must stop working immediately.
	ErrFenced = errors.New("fenced: this attempt is no longer current; stop working")
	// ErrCancelled: the issuer cancelled the task. Stop and report.
	ErrCancelled = errors.New("task cancelled by issuer")
	// ErrNotClaimable: task is not open/stale, or attempts are exhausted.
	ErrNotClaimable = errors.New("task is not claimable")
)

// TaskView is the derived state of a task.
type TaskView struct {
	Task         Event      `json:"task"`
	State        string     `json:"state"`
	Reason       string     `json:"reason,omitempty"`
	Attempt      int        `json:"attempt"` // current attempt (0 = never claimed)
	Claimer      string     `json:"claimer,omitempty"`
	LastBeat     time.Time  `json:"last_beat,omitempty"`
	Last         *Progress  `json:"last_progress,omitempty"`
	Result       *Event     `json:"result,omitempty"`
	Deadline     time.Time  `json:"deadline"`
	Heartbeat    int        `json:"heartbeat_sec"`
	MaxAttempts  int        `json:"max_attempts"`
	Claims       []Claim    `json:"claims,omitempty"`
	CancelledBy  string     `json:"cancelled_by,omitempty"`
	CancelAt     *time.Time `json:"cancel_at,omitempty"`
	Claimable    bool       `json:"claimable"`
	ProgressSeen int        `json:"progress_events"`
}

// CreateTask opens a long-running task.
func (b *Bus) CreateTask(to []string, subject, body string, spec TaskSpec, attach []string) (*Event, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	if len(to) == 0 {
		return nil, fmt.Errorf("no assignee: use --to <agent|#channel|*>")
	}
	if spec.HeartbeatSec <= 0 {
		spec.HeartbeatSec = int(DefaultHeartbeat / time.Second)
	}
	if spec.MaxAttempts <= 0 {
		spec.MaxAttempts = DefaultMaxAttempts
	}
	if spec.Deadline == "" {
		spec.Deadline = b.Now().UTC().Add(DefaultDeadline).Format(time.RFC3339)
	} else if _, err := time.Parse(time.RFC3339, spec.Deadline); err != nil {
		return nil, fmt.Errorf("deadline must be RFC3339: %v", err)
	}
	e := Event{Kind: KindTaskCreate, To: to, Subject: subject, Body: body, Task: &spec}
	for _, p := range attach {
		a, err := b.PutBlob(p)
		if err != nil {
			return nil, err
		}
		e.Attach = append(e.Attach, a)
	}
	return b.Emit(e)
}

// Task derives a task's state.
func (b *Bus) Task(id string) (*TaskView, error) {
	t, err := b.Resolve(id)
	if err != nil {
		return nil, err
	}
	if t.Kind != KindTaskCreate || t.Task == nil {
		return nil, fmt.Errorf("%s is a %s, not a task", ShortID(t.ID), t.Kind)
	}
	return b.view(t), nil
}

func (b *Bus) view(t *Event) *TaskView {
	spec := t.Task
	v := &TaskView{Task: *t, Heartbeat: spec.HeartbeatSec, MaxAttempts: spec.MaxAttempts}
	if v.Heartbeat <= 0 {
		v.Heartbeat = int(DefaultHeartbeat / time.Second)
	}
	if v.MaxAttempts <= 0 {
		v.MaxAttempts = DefaultMaxAttempts
	}
	v.Deadline, _ = time.Parse(time.RFC3339, spec.Deadline)
	v.Claims = b.claims[t.ID]
	if n := len(v.Claims); n > 0 {
		c := v.Claims[n-1]
		v.Attempt, v.Claimer, v.LastBeat = c.Attempt, c.Agent, c.TS
	}
	for i := range b.events {
		e := &b.events[i]
		if e.Ref != t.ID {
			continue
		}
		switch e.Kind {
		case KindTaskCancel:
			if e.From == t.From && v.CancelAt == nil {
				ts := e.TS
				v.CancelAt, v.CancelledBy, v.Reason = &ts, e.From, e.Reason
			}
		case KindTaskProgress:
			if e.Progress != nil && e.From == v.Claimer && e.Progress.Attempt == v.Attempt {
				v.ProgressSeen++
				if e.TS.After(v.LastBeat) {
					v.LastBeat = e.TS
				}
				p := *e.Progress
				v.Last = &p
			}
		case KindTaskDone:
			if e.Progress != nil && e.From == v.Claimer && e.Progress.Attempt == v.Attempt && v.Result == nil {
				r := *e
				v.Result = &r
			}
		}
	}
	now := b.Now()
	switch {
	case v.Result != nil:
		v.State = v.Result.Progress.Status
		if v.State != TaskSucceeded {
			v.State = TaskFailed
		}
		if v.Reason == "" || v.CancelAt == nil {
			v.Reason = v.Result.Reason
		}
		if v.CancelAt != nil && v.Result.Progress.Status == TaskCancelled {
			v.State = TaskCancelled
		}
	case v.CancelAt != nil:
		v.State = TaskCancelled
	case !v.Deadline.IsZero() && now.After(v.Deadline):
		v.State, v.Reason = TaskExpired, "deadline passed"
	case v.Attempt == 0:
		v.State, v.Claimable = TaskOpen, true
	case now.Sub(v.LastBeat) > time.Duration(v.Heartbeat*StaleAfterBeats)*time.Second:
		if v.Attempt >= v.MaxAttempts {
			v.State, v.Reason = TaskFailed, fmt.Sprintf("claimer %s lost heartbeat; attempts exhausted (%d/%d)", v.Claimer, v.Attempt, v.MaxAttempts)
		} else {
			v.State, v.Claimable = TaskStale, true
			v.Reason = fmt.Sprintf("claimer %s silent since %s", v.Claimer, v.LastBeat.Format(time.RFC3339))
		}
	default:
		v.State = TaskRunning
	}
	return v
}

// Tasks lists tasks. scope: "mine" (issued by me), "assigned" (addressed to
// me), "claimable" (I could claim now), "" (all).
func (b *Bus) Tasks(scope string) ([]*TaskView, error) {
	if err := b.load(); err != nil {
		return nil, err
	}
	var out []*TaskView
	for i := range b.events {
		e := &b.events[i]
		if e.Kind != KindTaskCreate || e.Task == nil {
			continue
		}
		switch scope {
		case "mine":
			if e.From != b.Me() {
				continue
			}
		case "assigned":
			if !b.addressedToMe(e) {
				continue
			}
		case "claimable":
			if !b.addressedToMe(e) || e.From == b.Me() && !slices.Contains(e.To, b.Me()) {
				continue
			}
		}
		v := b.view(e)
		if scope == "claimable" && !v.Claimable {
			continue
		}
		out = append(out, v)
	}
	return out, nil
}

// Claim claims a task (open or stale). Exactly one concurrent claimer wins.
func (b *Bus) Claim(id string) (*TaskView, error) {
	if err := b.Sync(); err != nil {
		return nil, err
	}
	v, err := b.Task(id)
	if err != nil {
		return nil, err
	}
	if !v.Claimable {
		return v, fmt.Errorf("%w: state=%s %s", ErrNotClaimable, v.State, v.Reason)
	}
	t := &v.Task
	if !b.addressedToMe(t) {
		return v, fmt.Errorf("%w: task is not addressed to %s", ErrNotClaimable, b.Me())
	}
	if !b.capable(b.Me(), t.Task.Requires) {
		return v, fmt.Errorf("%w: missing capabilities %v", ErrNotClaimable, t.Task.Requires)
	}
	c := Claim{Task: t.ID, Attempt: v.Attempt + 1, Agent: b.Me(), TS: b.Now().UTC()}
	data, _ := json.MarshalIndent(c, "", "  ")
	rel := filepath.Join("claims", t.ID, fmt.Sprintf("%d.json", c.Attempt))
	if err := b.Git.Claim(rel, append(data, '\n'), fmt.Sprintf("claim %s attempt %d", ShortID(t.ID), c.Attempt)); err != nil {
		b.loaded = false
		return v, err
	}
	b.loaded = false
	if _, err := b.Receipt(t.ID, RcptAccepted, ""); err != nil {
		return nil, err
	}
	if _, err := b.Emit(Event{Kind: KindTaskProgress, Ref: t.ID, Thread: t.ID, To: []string{t.From},
		Progress: &Progress{Attempt: c.Attempt, Phase: "claimed"}}); err != nil {
		return nil, err
	}
	return b.Task(t.ID)
}

// CheckOwner syncs and verifies I still hold attempt (0 = any) of a live
// task. ErrFenced / ErrCancelled mean: stop working.
func (b *Bus) CheckOwner(id string, attempt int) (*TaskView, error) {
	return b.checkOwner(id, attempt)
}

// checkOwner verifies I still hold the current attempt and the task is live.
func (b *Bus) checkOwner(id string, attempt int) (*TaskView, error) {
	if err := b.Sync(); err != nil {
		return nil, err
	}
	v, err := b.Task(id)
	if err != nil {
		return nil, err
	}
	if v.Claimer != b.Me() || (attempt > 0 && v.Attempt != attempt) {
		return v, ErrFenced
	}
	if v.CancelAt != nil {
		return v, ErrCancelled
	}
	if v.Result != nil {
		return v, fmt.Errorf("task already finished (%s)", v.State)
	}
	return v, nil
}

// Progress reports progress / heartbeat for my current attempt. attempt=0
// means "whatever attempt I hold". Returns ErrFenced or ErrCancelled when the
// worker must stop.
func (b *Bus) Progress(id string, attempt int, phase string, percent int, tail string) (*TaskView, error) {
	v, err := b.checkOwner(id, attempt)
	if err != nil {
		return v, err
	}
	_, err = b.Emit(Event{Kind: KindTaskProgress, Ref: v.Task.ID, Thread: v.Task.ID, To: []string{v.Task.From},
		Progress: &Progress{Attempt: v.Attempt, Phase: phase, Percent: percent, Tail: tail}})
	if err != nil {
		return v, err
	}
	return b.Task(v.Task.ID)
}

// Complete finishes my attempt. status: succeeded | failed | cancelled.
func (b *Bus) Complete(id string, attempt int, status, body, reason string, attach []string) (*Event, error) {
	switch status {
	case TaskSucceeded, TaskFailed, TaskCancelled:
	default:
		return nil, fmt.Errorf("status must be succeeded|failed|cancelled")
	}
	v, err := b.checkOwner(id, attempt)
	if errors.Is(err, ErrCancelled) && status != TaskSucceeded {
		status, err = TaskCancelled, nil
	}
	if err != nil {
		return nil, err
	}
	e := Event{Kind: KindTaskDone, Ref: v.Task.ID, Thread: v.Task.ID, To: []string{v.Task.From},
		Subject: "Result: " + v.Task.Subject, Body: body, Reason: reason,
		Progress: &Progress{Attempt: v.Attempt, Status: status, Percent: 100}}
	for _, p := range attach {
		a, err := b.PutBlob(p)
		if err != nil {
			return nil, err
		}
		e.Attach = append(e.Attach, a)
	}
	return b.Emit(e)
}

// Cancel cancels a task I issued.
func (b *Bus) Cancel(id, reason string) (*Event, error) {
	v, err := b.Task(id)
	if err != nil {
		return nil, err
	}
	if v.Task.From != b.Me() {
		return nil, fmt.Errorf("only the issuer (%s) can cancel", v.Task.From)
	}
	if v.Result != nil || v.State == TaskCancelled {
		return nil, fmt.Errorf("task already %s", v.State)
	}
	to := []string{}
	if v.Claimer != "" {
		to = append(to, v.Claimer)
	}
	return b.Emit(Event{Kind: KindTaskCancel, Ref: v.Task.ID, Thread: v.Task.ID, To: to, Reason: reason})
}

// Brief renders a self-contained markdown hand-over for a task or thread, so
// a fresh agent can pick it up without any other context.
func (b *Bus) Brief(id string) (string, error) {
	e, err := b.Resolve(id)
	if err != nil {
		return "", err
	}
	root := threadOf(e)
	if r, ok := b.byID[root]; ok {
		e = r
	}
	var sb strings.Builder
	w := func(f string, a ...any) { fmt.Fprintf(&sb, f, a...) }
	w("# Brief: %s\n\n", firstNonEmpty(e.Subject, e.Kind))
	w("- id: `%s`\n- from: %s → to: %s\n- created: %s\n", e.ID, e.From, strings.Join(e.To, ", "), e.TS.Format(time.RFC3339))
	if e.Kind == KindTaskCreate && e.Task != nil {
		v := b.view(e)
		w("- **state: %s**", v.State)
		if v.Reason != "" {
			w(" (%s)", v.Reason)
		}
		w("\n- attempt: %d/%d, claimer: %s, last heartbeat: %s\n", v.Attempt, v.MaxAttempts, firstNonEmpty(v.Claimer, "-"), fmtTime(v.LastBeat))
		w("- deadline: %s, heartbeat every %ds, requires: %v\n", v.Deadline.Format(time.RFC3339), v.Heartbeat, e.Task.Requires)
		if e.Task.Template != "" {
			pj, _ := json.Marshal(e.Task.Params)
			w("- template: `%s` params: `%s`\n", e.Task.Template, pj)
		}
		if v.Last != nil {
			w("\n## Latest progress (attempt %d)\n\n- phase: %s (%d%%)\n", v.Last.Attempt, v.Last.Phase, v.Last.Percent)
			if v.Last.Tail != "" {
				w("\n```\n%s\n```\n", v.Last.Tail)
			}
		}
		if v.Result != nil {
			w("\n## Result: %s\n\n%s\n", v.Result.Progress.Status, v.Result.Body)
			if v.Result.Reason != "" {
				w("\nreason: %s\n", v.Result.Reason)
			}
			writeAttach(&sb, v.Result.Attach)
		}
	}
	w("\n## Request\n\n%s\n", firstNonEmpty(e.Body, "(no body)"))
	writeAttach(&sb, e.Attach)
	evs, _ := b.Thread(e.ID)
	w("\n## Timeline (%d events)\n\n", len(evs))
	for _, x := range evs {
		w("- %s **%s** %s%s\n", x.TS.Format("01-02 15:04:05"), x.From, describe(&x), "")
	}
	w("\n## How to continue\n\n")
	if e.Kind == KindTaskCreate {
		w("- claim (if open/stale): `agentbus task claim %s`\n- report: `agentbus task progress %s --phase ... --percent N`\n- finish: `agentbus task done %s --status succeeded|failed --body result.md`\n", ShortID(e.ID), ShortID(e.ID), ShortID(e.ID))
	} else {
		w("- reply: `agentbus send --reply %s --body reply.md`\n- decide: `agentbus ack %s` or `agentbus ack %s --reject --reason ...`\n", ShortID(e.ID), ShortID(e.ID), ShortID(e.ID))
	}
	return sb.String(), nil
}

func writeAttach(sb *strings.Builder, as []Attach) {
	for _, a := range as {
		fmt.Fprintf(sb, "- attachment `%s` (%d bytes): `agentbus blob %s`\n", a.Name, a.Size, a.SHA256[:12])
	}
}

// describe is a one-line human summary of an event.
func describe(e *Event) string {
	switch e.Kind {
	case KindMessage:
		s := "✉ " + firstNonEmpty(e.Subject, oneLine(e.Body, 60))
		if e.ReplyTo != "" {
			s = "↩ " + firstNonEmpty(e.Subject, oneLine(e.Body, 60))
		}
		return s + " [" + ShortID(e.ID) + "]"
	case KindReceipt:
		s := "receipt " + e.Status + " on " + ShortID(e.Ref)
		if e.Reason != "" {
			s += ": " + e.Reason
		}
		return s
	case KindTaskCreate:
		return "task created: " + e.Subject + " [" + ShortID(e.ID) + "]"
	case KindTaskProgress:
		if e.Progress == nil {
			return "progress"
		}
		return fmt.Sprintf("progress #%d %s %d%%", e.Progress.Attempt, e.Progress.Phase, e.Progress.Percent)
	case KindTaskDone:
		if e.Progress == nil {
			return "done"
		}
		s := fmt.Sprintf("done #%d %s", e.Progress.Attempt, e.Progress.Status)
		if e.Reason != "" {
			s += ": " + e.Reason
		}
		return s
	case KindTaskCancel:
		return "cancelled " + ShortID(e.Ref) + ": " + e.Reason
	case KindHello:
		return "hello"
	}
	return e.Kind
}

// Describe is exported for the CLI.
func Describe(e *Event) string { return describe(e) }

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > n {
		return string([]rune(s)[:n]) + "…"
	}
	return s
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func fmtTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Format(time.RFC3339)
}

func (b *Bus) claimedByMe(id string) bool {
	cs := b.claims[id]
	return len(cs) > 0 && cs[len(cs)-1].Agent == b.Me()
}
