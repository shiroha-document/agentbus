package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Self-driven ("manual") agents: harnesses tick cannot spawn (OpenAI dot, a
// hosted agent, …) wake themselves on their own schedule and run
// `agentbus inbox`. Inbox claims like tick does, but instead of running a CLI
// it hands the agent the round prompt; the agent then posts, acks (or
// releases) by hand with an explicit --thread.

// InboxThread is one claimed thread handed to a self-driven agent.
type InboxThread struct {
	ThreadID   string     `json:"thread_id"`
	Title      string     `json:"title"`
	Workspace  string     `json:"workspace"`
	Round      string     `json:"round"`
	LeaseUntil int64      `json:"lease_until"`
	Deliveries []Delivery `json:"deliveries"`
	Workdir    string     `json:"workdir"`
	PromptFile string     `json:"prompt_file"`
	Prompt     string     `json:"prompt"`
}

// InboxOutcome is what `agentbus inbox` did; Code follows the tick exit codes
// (0 claimed, 3 nothing to do, 4 paused / pending, 5 quota paused).
type InboxOutcome struct {
	Code    int           `json:"code"`
	Message string        `json:"message"`
	Pending int           `json:"pending"`
	Threads []InboxThread `json:"threads"`
}

// Inbox claims up to max threads (0 = hub default) and builds a manual-mode
// prompt for each. With peek it only reports how many deliveries wait.
func (t *Ticker) Inbox(ctx context.Context, max int, peek bool) (InboxOutcome, error) {
	out, err := t.inbox(ctx, max, peek)
	if !peek {
		st := LoadState(t.Dir)
		st.LastTickAt = t.now().UnixMilli()
		st.LastExit = out.Code
		st.LastError = ""
		if err != nil {
			st.LastError = err.Error()
		}
		if len(out.Threads) > 0 {
			st.LastRunAt = st.LastTickAt
			st.LastThread = out.Threads[len(out.Threads)-1].ThreadID
		}
		_ = SaveState(t.Dir, st)
	}
	if out.Threads == nil {
		out.Threads = []InboxThread{}
	}
	return out, err
}

func (t *Ticker) inbox(ctx context.Context, max int, peek bool) (InboxOutcome, error) {
	s, quotaPaused, stop, err := t.gate(ctx)
	if stop != nil {
		return InboxOutcome{Code: stop.Code, Message: stop.Message}, err
	}
	if quotaPaused {
		return InboxOutcome{Code: ExitQuota, Message: "paused: " + deref(s.Member.PauseReason)}, nil
	}
	if peek {
		code, msg := ExitNothing, "no new messages"
		if s.Pending > 0 {
			code, msg = ExitOK, fmt.Sprintf("%d message(s) waiting", s.Pending)
		}
		return InboxOutcome{Code: code, Message: msg, Pending: s.Pending}, nil
	}
	if max <= 0 {
		max = s.Config.MaxClaimThreads
	}
	cr, err := t.Client.Claim(ctx, max)
	if err != nil {
		return InboxOutcome{Code: ExitErr}, err
	}
	if cr.Paused {
		return InboxOutcome{Code: ExitPaused, Message: "paused by the hub"}, nil
	}
	if len(cr.Threads) == 0 {
		return InboxOutcome{Code: ExitNothing, Message: "no new messages"}, nil
	}
	out := InboxOutcome{Code: ExitOK, Pending: s.Pending}
	exe := t.Exe
	if exe == "" {
		exe = "agentbus"
	}
	for _, ct := range cr.Threads {
		c, err := t.Client.Context(ctx, ct.ThreadID)
		if err != nil {
			t.logf("%s: context: %v", ct.ThreadID, err)
			t.release(ctx, &ThreadOutcome{}, ct.ThreadID, nil, "context failed: "+err.Error())
			continue
		}
		ds := ct.Deliveries
		if len(ds) == 0 {
			ds = c.Deliveries
		}
		round := RoundKey(ds)
		if round == "" {
			round = ct.ThreadID + ":r" + fmt.Sprint(t.now().Unix())
		}
		dir, note := t.workDir(c)
		prompt, err := BuildPrompt(PromptInput{Ctx: c, Deliveries: ds, Round: round, Exe: exe, WorkdirNote: note,
			MemberID: t.Cfg.MemberID, Manual: true})
		if err != nil {
			t.logf("%s: prompt: %v", ct.ThreadID, err)
			t.release(ctx, &ThreadOutcome{}, ct.ThreadID, nil, "prompt: "+err.Error())
			continue
		}
		pf := filepath.Join(t.paths().Prompts(), sanitizeFile(ct.ThreadID)+".md")
		_ = os.MkdirAll(filepath.Dir(pf), 0o700)
		_ = os.WriteFile(pf, []byte(prompt), 0o600)
		lease := ct.LeaseUntil
		if lease == 0 {
			lease = t.now().Add(time.Duration(max0(s.Config.LeaseS, 900)) * time.Second).UnixMilli()
		}
		_ = SaveInboxRound(t.Dir, ct.ThreadID, round)
		t.activity(ctx, ct.ThreadID, "running", runningDetail(t.Cfg.CLI, t.knownModel()), t.knownModel())
		out.Threads = append(out.Threads, InboxThread{ThreadID: ct.ThreadID, Title: c.Thread.Title, Workspace: c.Workspace.Name,
			Round: round, LeaseUntil: lease, Deliveries: ds, Workdir: dir, PromptFile: pf, Prompt: prompt})
	}
	if len(out.Threads) == 0 {
		return InboxOutcome{Code: ExitErr, Message: "claimed threads could not be prepared (released)"}, fmt.Errorf("inbox: no claimed thread could be prepared")
	}
	out.Message = fmt.Sprintf("claimed %d thread(s)", len(out.Threads))
	return out, nil
}

func max0(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// ---- manual-round keys ----
//
// A self-driven agent has no AGENTBUS_ROUND in its environment, so inbox
// remembers each claimed thread's round in inbox.json; `agentbus post
// --thread T` uses it for the idempotency key (a retried command never
// double-posts) and ack / release forget it.

func inboxFile(dir string) string { return filepath.Join(dir, "inbox.json") }

func loadInbox(dir string) map[string]string {
	m := map[string]string{}
	if b, err := os.ReadFile(inboxFile(dir)); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func saveInbox(dir string, m map[string]string) error {
	b, _ := json.MarshalIndent(m, "", "  ")
	return writeFileAtomic(inboxFile(dir), append(b, '\n'), 0o600)
}

// SaveInboxRound remembers thread's current manual round.
func SaveInboxRound(dir, thread, round string) error {
	m := loadInbox(dir)
	m[thread] = round
	return saveInbox(dir, m)
}

// InboxRound is thread's current manual round ("" = none).
func InboxRound(dir, thread string) string {
	if thread == "" {
		return ""
	}
	return loadInbox(dir)[thread]
}

// ForgetInboxRound drops thread's manual round (after ack / release).
func ForgetInboxRound(dir, thread string) {
	m := loadInbox(dir)
	if _, ok := m[thread]; !ok {
		return
	}
	delete(m, thread)
	_ = saveInbox(dir, m)
}
