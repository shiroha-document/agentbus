package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/shiroha-document/agentbus/internal/hub"
)

// A self-driven agent: join --cli manual, inbox claims and prints the
// prompt, post --thread reuses the round key, ack / release forget it.
func TestInboxManualFlow(t *testing.T) {
	h, url := newCLIHub(t)
	if code, out := run(t, "join", url, "--join-code", testJoinCode, "--name", "alice", "--cli", "manual"); code != 0 {
		t.Fatalf("join: %d %s", code, out)
	}
	h.status = "active"

	// tick is a no-op in manual mode
	if code, out := run(t, "tick"); code != hub.ExitNothing || !strings.Contains(out, "inbox") {
		t.Fatalf("tick: %d %s", code, out)
	}
	if code, out := run(t, "inbox"); code != hub.ExitNothing || !strings.Contains(out, "Nothing to do") {
		t.Fatalf("empty inbox: %d %s", code, out)
	}

	h.claims = []hub.ClaimedThread{{ThreadID: "t_1", WorkspaceID: "w_1",
		Deliveries: []hub.Delivery{{ID: "d_1", ThreadID: "t_1", PostID: "p_1", Reason: "mention"}}}}
	code, out := run(t, "inbox")
	if code != 0 || !strings.Contains(out, "agentbus inbox: thread t_1 (flaky test)") ||
		!strings.Contains(out, "agentbus ack --thread t_1") || !strings.Contains(out, "@alice fix it") {
		t.Fatalf("inbox: %d %s", code, out)
	}

	for i := 0; i < 2; i++ {
		if code, out := run(t, "post", "--thread", "t_1", "--body", "fixed"); code != 0 {
			t.Fatalf("post: %d %s", code, out)
		}
	}
	if len(h.posts) != 2 || h.posts[0].IdempotencyKey != h.posts[1].IdempotencyKey ||
		!strings.HasPrefix(h.posts[0].IdempotencyKey, "d_1:r1:") {
		t.Fatalf("post keys: %+v", h.posts)
	}
	if code, out := run(t, "heartbeat", "--thread", "t_1"); code != 0 || h.heartbeats != 1 || !strings.Contains(out, "extended") {
		t.Fatalf("heartbeat: %d %s", code, out)
	}
	if code, out := run(t, "ack", "--thread", "t_1"); code != 0 || len(h.acks) != 1 {
		t.Fatalf("ack: %d %s", code, out)
	}
	if r := hub.InboxRound(hub.Dir(), "t_1"); r != "" {
		t.Fatalf("round kept after ack: %q", r)
	}

	// a second round, given back with release
	h.claims = []hub.ClaimedThread{{ThreadID: "t_1", WorkspaceID: "w_1",
		Deliveries: []hub.Delivery{{ID: "d_2", ThreadID: "t_1", PostID: "p_1", Reason: "mention"}}}}
	code, out = run(t, "inbox", "--json")
	var got hub.InboxOutcome
	if code != 0 || json.Unmarshal([]byte(out), &got) != nil || len(got.Threads) != 1 || got.Threads[0].Round != "d_2:r1" {
		t.Fatalf("inbox --json: %d %s", code, out)
	}
	if code, out := run(t, "release", "--thread", "t_1", "--reason", "needs a human"); code != 0 ||
		len(h.nacks) != 1 || !strings.Contains(h.nacks[0], "needs a human") {
		t.Fatalf("release: %d %s %v", code, out, h.nacks)
	}
	if r := hub.InboxRound(hub.Dir(), "t_1"); r != "" {
		t.Fatalf("round kept after release: %q", r)
	}
}

func TestSetupManualInstallsNoScheduler(t *testing.T) {
	h, url := newCLIHub(t)
	h.status = "active"
	fc := &fakeCron{}
	oldR, oldL := schedRunner, lookPath
	schedRunner = fc
	lookPath = func(string) (string, error) { return "", errors.New("not found") }
	defer func() { schedRunner, lookPath = oldR, oldL }()
	code, out := run(t, "setup", "--yes", "--hub", url, "--join-code", testJoinCode, "--name", "dot", "--cli", "manual", "--interval", "30m")
	if code != 0 || !strings.Contains(out, "agentbus inbox") || !strings.Contains(out, "every 30m") || fc.tab != "" {
		t.Fatalf("%d %s\ncrontab: %q", code, out, fc.tab)
	}
	cfg, err := hub.LoadConfig(hub.Dir())
	if err != nil || cfg.CLI != "manual" || cfg.WakeIntervalS != 1800 || cfg.Tier == "" {
		t.Fatalf("%+v %v", cfg, err)
	}
	if code, out := run(t, "doctor"); code != 0 || !strings.Contains(out, "manual") {
		t.Fatalf("doctor: %d %s", code, out)
	}
}

func TestCLIOptionsOrder(t *testing.T) {
	oldL := lookPath
	lookPath = func(n string) (string, error) {
		if n == "codex" {
			return "/opt/bin/codex", nil
		}
		return "", errors.New("not found")
	}
	defer func() { lookPath = oldL }()
	var got []string
	for _, o := range cliOptions(found(detectCLIs())) {
		got = append(got, o.Value)
	}
	if len(got) < 4 || got[0] != "codex" || got[1] != "manual" || got[2] != "custom" {
		t.Fatalf("order %v", got)
	}
}

func found(m map[string]string, _ []string) map[string]string { return m }
