// Package bus implements agentbus: an append-only, git-backed mailbox and
// long-running task protocol for cooperating agents.
//
// Layout on the bus branch:
//
//	agents/<name>/profile.json            identity, role, capabilities, channels
//	events/<name>/<YYYY-MM>/<id>.json     append-only events authored by <name>
//	claims/<task_id>/<attempt>.json       task claims; create-only (git push race = lock)
//	blobs/<sha256>                        content-addressed attachments
//
// Every agent writes only under its own agents/ and events/ directories, so
// concurrent pushes never conflict except on claims, which is exactly the
// mutual-exclusion we want.
package bus

import (
	"crypto/rand"
	"encoding/binary"
	"strings"
	"time"
)

// Version of the on-branch event format.
const Version = 1

// Event kinds.
const (
	KindHello        = "agent.hello"   // profile published / presence heartbeat
	KindMessage      = "msg"           // mail
	KindReceipt      = "receipt"       // delivered | read | accepted | rejected
	KindTaskCreate   = "task.create"   // issuer opens a task
	KindTaskProgress = "task.progress" // claimer heartbeat + progress
	KindTaskDone     = "task.done"     // claimer finished: succeeded | failed
	KindTaskCancel   = "task.cancel"   // issuer cancels
)

// Receipt levels, in increasing order.
const (
	RcptDelivered = "delivered"
	RcptRead      = "read"
	RcptAccepted  = "accepted"
	RcptRejected  = "rejected"
)

// Task states (derived, never stored).
const (
	TaskOpen      = "open"
	TaskRunning   = "running"
	TaskStale     = "stale" // claimer missed heartbeats; re-claimable
	TaskSucceeded = "succeeded"
	TaskFailed    = "failed"
	TaskCancelled = "cancelled"
	TaskExpired   = "expired" // deadline passed without completion
)

// Profile is an agent's self-description (agents/<name>/profile.json).
type Profile struct {
	Name         string   `json:"name"`
	Role         string   `json:"role,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	Channels     []string `json:"channels,omitempty"` // without leading '#'
	Wake         string   `json:"wake,omitempty"`     // daemon | poll | wait | manual
	Owner        string   `json:"owner,omitempty"`    // human to notify (e.g. GitHub login)
	Description  string   `json:"description,omitempty"`
	SigningKey   string   `json:"signing_key,omitempty"` // ssh public key (reserved)
}

// TaskSpec is carried by task.create.
type TaskSpec struct {
	Requires     []string `json:"requires,omitempty"`      // capabilities a claimer must have
	Template     string   `json:"template,omitempty"`      // structured handler key, e.g. "ci-steps"
	Params       any      `json:"params,omitempty"`        // template parameters
	Deadline     string   `json:"deadline,omitempty"`      // RFC3339
	HeartbeatSec int      `json:"heartbeat_sec,omitempty"` // expected progress interval
	MaxAttempts  int      `json:"max_attempts,omitempty"`
}

// Progress is carried by task.progress / task.done.
type Progress struct {
	Attempt int    `json:"attempt"`
	Phase   string `json:"phase,omitempty"`
	Percent int    `json:"percent,omitempty"`
	Tail    string `json:"tail,omitempty"`   // last log lines (redacted)
	Status  string `json:"status,omitempty"` // task.done: succeeded | failed
}

// Event is the single on-branch record type.
type Event struct {
	V       int       `json:"v"`
	ID      string    `json:"id"`
	TS      time.Time `json:"ts"`
	From    string    `json:"from"`
	Kind    string    `json:"kind"`
	To      []string  `json:"to,omitempty"`       // agent | #channel | *
	Thread  string    `json:"thread,omitempty"`   // root message/task id
	ReplyTo string    `json:"reply_to,omitempty"` // parent event id
	Ref     string    `json:"ref,omitempty"`      // receipt / task target id
	Subject string    `json:"subject,omitempty"`
	Body    string    `json:"body,omitempty"`
	Attach  []Attach  `json:"attach,omitempty"`
	// Receipt level (kind=receipt) or reason (rejected / cancel / failed).
	Status    string    `json:"status,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	ExpectAck string    `json:"expect_ack,omitempty"` // RFC3339 deadline for accept/reject
	Task      *TaskSpec `json:"task,omitempty"`
	Progress  *Progress `json:"progress,omitempty"`
	Profile   *Profile  `json:"profile,omitempty"`
}

// Attach references a blob.
type Attach struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Claim is claims/<task>/<attempt>.json.
type Claim struct {
	Task    string    `json:"task"`
	Attempt int       `json:"attempt"`
	Agent   string    `json:"agent"`
	TS      time.Time `json:"ts"`
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewID returns a 26-char ULID-like id: sortable by time, globally unique.
func NewID(t time.Time) string {
	var b [16]byte
	binary.BigEndian.PutUint64(b[0:8], uint64(t.UnixMilli())<<16)
	_, _ = rand.Read(b[6:])
	// encode 128 bits into 26 base32 chars
	var sb strings.Builder
	var acc uint64
	var bits uint
	// first char takes the top 3 bits so the total is 26*5 = 130 >= 128
	sb.WriteByte(crockford[b[0]>>5])
	acc, bits = uint64(b[0]&0x1f), 5
	for i := 1; i < 16; i++ {
		acc = acc<<8 | uint64(b[i])
		bits += 8
		for bits >= 5 {
			bits -= 5
			sb.WriteByte(crockford[(acc>>bits)&0x1f])
		}
	}
	if bits > 0 {
		sb.WriteByte(crockford[(acc<<(5-bits))&0x1f])
	}
	return sb.String()
}

// ShortID is the human-friendly prefix used in CLI output; any unique prefix
// (min 6 chars) is accepted as input.
func ShortID(id string) string {
	if len(id) > 10 {
		return id[len(id)-10:]
	}
	return id
}
