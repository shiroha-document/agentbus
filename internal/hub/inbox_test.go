package hub

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/shiroha-document/agentbus/internal/adapter"
)

func TestInboxClaimsAndBuildsManualPrompt(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	out, err := tk.Inbox(context.Background(), 1, false)
	if err != nil || out.Code != ExitOK || len(out.Threads) != 1 {
		t.Fatalf("%+v %v", out, err)
	}
	th := out.Threads[0]
	if th.ThreadID != "t_1" || th.Round != "d_1:r1" || th.Title != "flaky test" || th.LeaseUntil == 0 || th.Workdir == "" {
		t.Fatalf("%+v", th)
	}
	for _, want := range []string{"--thread t_1", "agentbus ack --thread t_1", "agentbus heartbeat --thread t_1", "agentbus release --thread t_1", "agentbus inbox"} {
		if !strings.Contains(th.Prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, th.Prompt)
		}
	}
	if strings.Contains(th.Prompt, "AGENTBUS_THREAD=") {
		t.Fatalf("manual prompt mentions the round environment:\n%s", th.Prompt)
	}
	if b, err := os.ReadFile(th.PromptFile); err != nil || string(b) != th.Prompt {
		t.Fatalf("prompt file: %v", err)
	}
	if r := InboxRound(tk.Dir, "t_1"); r != "d_1:r1" {
		t.Fatalf("inbox round %q", r)
	}
	// nothing acked or released, no CLI run, state says running
	if len(h.acks) != 0 || len(h.nacks) != 0 || len(h.runs) != 0 {
		t.Fatalf("acks %v nacks %v runs %v", h.acks, h.nacks, h.runs)
	}
	if s := h.states(); len(s) != 1 || s[0] != "running" {
		t.Fatalf("activity %v", s)
	}
	if st := LoadState(tk.Dir); st.LastExit != ExitOK || st.LastThread != "t_1" {
		t.Fatalf("%+v", st)
	}
	ForgetInboxRound(tk.Dir, "t_1")
	if r := InboxRound(tk.Dir, "t_1"); r != "" {
		t.Fatalf("forgotten round %q", r)
	}
}

func TestInboxNothingPeekPaused(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	out, err := tk.Inbox(context.Background(), 0, false)
	if err != nil || out.Code != ExitNothing || out.Threads == nil || len(out.Threads) != 0 {
		t.Fatalf("nothing: %+v %v", out, err)
	}
	out, err = tk.Inbox(context.Background(), 0, true)
	if err != nil || out.Code != ExitNothing {
		t.Fatalf("peek: %+v %v", out, err)
	}
	h.addThread("t_1", d("d_1", "p_1"))
	h.paused, h.pauseReason = true, "manager: holiday"
	out, err = tk.Inbox(context.Background(), 0, false)
	if err != nil || out.Code != ExitPaused || len(h.claims) != 1 {
		t.Fatalf("paused: %+v %v", out, err)
	}
	h.paused, h.pauseReason, h.status = false, "", "pending"
	if out, _ := tk.Inbox(context.Background(), 0, false); out.Code != ExitPaused || len(h.claims) != 1 {
		t.Fatalf("pending: %+v", out)
	}
}

func TestTickManualModeDoesNothing(t *testing.T) {
	h, tk := tickEnv(t, "ok")
	h.addThread("t_1", d("d_1", "p_1"))
	tk.Cfg.CLI = adapter.Manual
	out, err := tk.Run(context.Background())
	if err != nil || out.Code != ExitNothing || !strings.Contains(out.Message, "inbox") {
		t.Fatalf("%+v %v", out, err)
	}
	if len(h.claims) != 1 || h.quotaCalls != 0 {
		t.Fatal("manual tick claimed or reported quota")
	}
}
