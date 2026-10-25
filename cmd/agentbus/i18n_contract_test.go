package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/quota"
)

func TestInboxJSONMessageCompatibility(t *testing.T) {
	joinActive(t, "contract")
	for _, lang := range []string{"en", "zh"} {
		withLang(lang, func() {
			code, out := run(t, "--json", "inbox", "--peek")
			var got hub.InboxOutcome
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if code != hub.ExitNothing || got.Message != "没有新消息" {
				t.Errorf("%s JSON changed baseline message: %d %q", lang, code, got.Message)
			}
		})
	}
}

func TestPendingTickJSONMessageCompatibility(t *testing.T) {
	h, _ := joinActive(t, "pending-contract")
	cfg, err := hub.LoadConfig(hub.Dir())
	if err != nil {
		t.Fatal(err)
	}
	cfg.CLI = "claude"
	if err := cfg.Save(hub.Dir()); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	h.status = "pending"
	h.mu.Unlock()
	for _, lang := range []string{"en", "zh"} {
		withLang(lang, func() {
			code, out := run(t, "--json", "tick")
			var got hub.Outcome
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if code != hub.ExitPaused || got.Message != "等待管理员在网页上批准" {
				t.Errorf("%s JSON changed baseline message: %d %q", lang, code, got.Message)
			}
		})
	}
}

func TestDoctorJSONDetailCompatibility(t *testing.T) {
	t.Setenv("AGENTBUS_HUB_HOME", t.TempDir())
	for _, lang := range []string{"en", "zh"} {
		withLang(lang, func() {
			code, out := run(t, "--json", "doctor")
			var got struct {
				Checks []check `json:"checks"`
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if code != exitErr || len(got.Checks) != 1 || got.Checks[0].Detail != hub.ErrNoConfig.Error() {
				t.Errorf("%s JSON changed baseline detail: %d %+v", lang, code, got.Checks)
			}
		})
	}
	withLang("zh", func() {
		if code, out := run(t, "doctor"); code != exitErr || !strings.Contains(out, "尚未加入 hub") {
			t.Errorf("human doctor must retain Chinese explanation: %d %s", code, out)
		}
	})
}

func TestLegacyOutcomeTextLocalization(t *testing.T) {
	for _, tc := range []struct{ canonical, en string }{
		{"没有新消息", "no new messages"},
		{"3 条消息待处理", "3 message(s) waiting"},
		{"领取了 2 个讨论串", "claimed 2 thread(s)"},
		{"等待管理员在网页上批准", "waiting for a team admin to approve on the hub"},
	} {
		withLang("en", func() {
			if got := tickOutcomeText(tc.canonical); got != tc.en {
				t.Errorf("tick %q = %q, want %q", tc.canonical, got, tc.en)
			}
			if got := inboxOutcomeText(tc.canonical); got != tc.en {
				t.Errorf("inbox %q = %q, want %q", tc.canonical, got, tc.en)
			}
		})
		withLang("zh", func() {
			if got := tickOutcomeText(tc.canonical); got != tc.canonical {
				t.Errorf("zh canonical text changed: %q", got)
			}
			if got := inboxOutcomeText(tc.canonical); got != tc.canonical {
				t.Errorf("zh inbox canonical text changed: %q", got)
			}
		})
	}
}

func TestQuotaHeaderUsesFixedReadings(t *testing.T) {
	joinActive(t, "quota-fixture")
	providers := quota.Registered()
	for _, provider := range providers {
		quota.Register(quotaFixtureProvider{id: provider.ID()})
		t.Cleanup(func() { quota.Register(provider) })
	}
	used := 50.0
	quota.Register(quotaFixtureProvider{id: providers[0].ID(), readings: []quota.Reading{{Window: "5h", UsedPct: &used, ReadAt: 1}}})
	for _, tc := range []struct{ lang, header string }{{"en", "PROVIDER"}, {"zh", "服务商"}} {
		withLang(tc.lang, func() {
			code, out := run(t, "quota")
			if code != 0 || !strings.Contains(out, tc.header) || !strings.Contains(out, "50%") || !strings.Contains(out, "5h") {
				t.Errorf("%s quota fixture: %d %s", tc.lang, code, out)
			}
		})
	}
}
