package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode"

	"github.com/shiroha-document/agentbus/internal/hub"
	"github.com/shiroha-document/agentbus/internal/i18n"
	"github.com/shiroha-document/agentbus/internal/quota"
)

// hasCJK reports whether s contains any Han character.
func hasCJK(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// withLang runs fn with the given UI language, restoring English afterwards
// (TestMain pins en for the other suites).
func withLang(lang string, fn func()) {
	i18n.Set(lang)
	defer i18n.Set("en")
	fn()
}

// joinActive joins a fake hub as "zhu" and flips the member to active.
func joinActive(t *testing.T, name string) (*cliHub, string) {
	t.Helper()
	h, url := newCLIHub(t)
	if code, out := run(t, "join", url, "--join-code", testJoinCode, "--name", name, "--cli", "manual"); code != 0 {
		t.Fatalf("join: %d %s", code, out)
	}
	h.status = "active"
	return h, url
}

// TestI18nInboxEmpty covers the system text of an empty inbox in both
// languages: Chinese mode prints the localized line; English system output
// contains no Han characters (user content is exempt, and there is none here).
func TestI18nInboxEmpty(t *testing.T) {
	joinActive(t, "zhu")

	withLang("zh", func() {
		if code, out := run(t, "inbox"); code != hub.ExitNothing ||
			!strings.Contains(out, "没有新消息") || !strings.Contains(out, "没有要处理的消息") {
			t.Fatalf("zh empty inbox: %d %s", code, out)
		}
		// --peek shares the same outcome text.
		if code, out := run(t, "inbox", "--peek"); code != hub.ExitNothing || !strings.Contains(out, "没有新消息") {
			t.Fatalf("zh peek: %d %s", code, out)
		}
	})

	i18n.Set("en")
	if code, out := run(t, "inbox"); code != hub.ExitNothing || hasCJK(out) ||
		!strings.Contains(out, "no new messages") {
		t.Fatalf("en empty inbox must be CJK-free: %d %s", code, out)
	}
}

// JSON preserves the pre-existing protocol strings independently of UI language.
func TestI18nInboxJSONPreservesProtocol(t *testing.T) {
	joinActive(t, "json")
	withLang("zh", func() {
		code, out := run(t, "--json", "inbox", "--peek")
		if code != hub.ExitNothing || !strings.Contains(out, `"message": "没有新消息"`) {
			t.Fatalf("zh --json peek must preserve baseline message: %d %s", code, out)
		}
	})
}

// TestI18nThreadListHeader checks the localized table header for thread list.
func TestI18nThreadListHeader(t *testing.T) {
	h, _ := joinActive(t, "lin")
	h.threads = []hub.Thread{{ID: "t_9", Title: "保持标题原文", Status: "open", WorkspaceID: "w_1", LastPostAt: 0}}

	withLang("zh", func() {
		if code, out := run(t, "thread", "list"); code != 0 ||
			!strings.Contains(out, "讨论串") || !strings.Contains(out, "最近发帖") ||
			!strings.Contains(out, "工作区") {
			t.Fatalf("zh thread list: %d %s", code, out)
		}
	})

	i18n.Set("en")
	// The user-authored title is Chinese on purpose: en-no-CJK applies to
	// system text only, so strip the title line before asserting.
	code, out := run(t, "thread", "list")
	if code != 0 || !strings.Contains(out, "THREAD") || !strings.Contains(out, "LAST POST") {
		t.Fatalf("en thread list: %d %s", code, out)
	}
	sysLine := strings.SplitN(out, "t_9", 2)[0]
	if hasCJK(sysLine) {
		t.Fatalf("en system header must be CJK-free: %q", sysLine)
	}
}

// TestI18nStatusLines covers status/whoami system text and the pause suffix.
func TestI18nStatusLines(t *testing.T) {
	joinActive(t, "bai")

	withLang("zh", func() {
		if code, out := run(t, "status", "--no-quota"); code != 0 ||
			!strings.Contains(out, "团队 Acme (o_team1)") ||
			!strings.Contains(out, "状态 active，角色 agent") ||
			!strings.Contains(out, "待处理投递 0") ||
			!strings.Contains(out, "上次 tick") {
			t.Fatalf("zh status: %d %s", code, out)
		}
	})

	i18n.Set("en")
	code, out := run(t, "status", "--no-quota")
	if code != 0 || hasCJK(out) || !strings.Contains(out, "team Acme (o_team1)") ||
		!strings.Contains(out, "status active, role agent") {
		t.Fatalf("en status must be CJK-free: %d %s", code, out)
	}
}

// TestI18nManageAndQuotaHeaders checks the remaining tabwriter table headers.
type quotaFixtureProvider struct {
	id       string
	readings []quota.Reading
}

func (p quotaFixtureProvider) ID() string   { return p.id }
func (p quotaFixtureProvider) Detect() bool { return len(p.readings) > 0 }
func (p quotaFixtureProvider) Read(context.Context) ([]quota.Reading, error) {
	return append([]quota.Reading(nil), p.readings...), nil
}

func TestI18nManageAndQuotaHeaders(t *testing.T) {
	// Keep the fixture independent of credentials, installed CLIs and keychains.
	for _, provider := range quota.Registered() {
		quota.Register(quotaFixtureProvider{id: provider.ID()})
		t.Cleanup(func() { quota.Register(provider) })
	}
	// "manage members" needs an admin identity; the fake hub answers regardless.
	h, _ := joinActive(t, "guan")
	h.mu.Lock()
	h.status = "active"
	h.mu.Unlock()

	withLang("zh", func() {
		if code, out := run(t, "manage", "members"); code != 0 ||
			!strings.Contains(out, "名称") || !strings.Contains(out, "最近出现") {
			t.Fatalf("zh manage members: %d %s", code, out)
		}
		if code, out := run(t, "manage", "workspaces"); code != 0 ||
			!strings.Contains(out, "仓库") || !strings.Contains(out, "未完成") {
			t.Fatalf("zh manage workspaces: %d %s", code, out)
		}
		if code, out := run(t, "quota"); code != 0 || !strings.Contains(out, "本机没有额度读数") {
			t.Fatalf("zh quota empty: %d %s", code, out)
		}
	})

	i18n.Set("en")
	if code, out := run(t, "manage", "members"); code != 0 || hasCJK(out) ||
		!strings.Contains(out, "NAME") || !strings.Contains(out, "LAST SEEN") {
		t.Fatalf("en manage members: %d %s", code, out)
	}
	if code, out := run(t, "quota"); code != 0 || !strings.Contains(out, "no quota readings") {
		t.Fatalf("en quota empty: %d %s", code, out)
	}
}

// TestI18nPostAndAck verifies action echo lines in both languages.
func TestI18nPostAndAck(t *testing.T) {
	joinActive(t, "tie")
	t.Setenv("AGENTBUS_ROUND", "d_1:r1")
	t.Setenv("AGENTBUS_THREAD", "t_1")

	withLang("zh", func() {
		if code, out := run(t, "post", "--body", "hello"); code != 0 ||
			!strings.Contains(out, "已发帖 p_9，讨论串 t_1") {
			t.Fatalf("zh post: %d %s", code, out)
		}
		if code, out := run(t, "ack", "--thread", "t_1"); code != 0 ||
			!strings.Contains(out, "已确认 t_1") {
			t.Fatalf("zh ack: %d %s", code, out)
		}
	})

	i18n.Set("en")
	t.Setenv("AGENTBUS_ROUND", "d_1:r2")
	if code, out := run(t, "post", "--body", "hello"); code != 0 || hasCJK(out) ||
		!strings.Contains(out, "posted p_9 in t_1") {
		t.Fatalf("en post: %d %s", code, out)
	}
}

// TestI18nOutcomeMappers pins CLI-boundary translations and passthrough rules.
func TestI18nOutcomeMappers(t *testing.T) {
	zhCases := map[string]string{
		"no new messages":                                "没有新消息",
		"3 message(s) waiting":                           "3 条消息待处理",
		"claimed 2 thread(s)":                            "领取了 2 个讨论串",
		"paused by the hub":                              "被 hub 暂停",
		"another tick is still running":                  "另一个 tick 仍在运行",
		"waiting for a team admin to approve on the hub": "等待管理员在网页上批准",
		"hub is globally paused":                         "hub 已全局暂停",
		"paused: quota":                                  "已暂停：quota",
		"quota exhausted: daily":                         "额度用尽：daily",
		"nothing to do":                                  "没有要处理的消息",
		"processed 1 thread(s)":                          "已处理 1 个讨论串",
		"manual mode: tick does nothing; the agent runs `agentbus inbox` itself": "手动模式：tick 不做任何事；agent 自己运行 `agentbus inbox`",
	}
	withLang("zh", func() {
		for en, zh := range zhCases {
			if got := tickOutcomeText(en); got != zh {
				t.Errorf("tickOutcomeText(%q) = %q, want %q", en, got, zh)
			}
		}
		if got := inboxOutcomeText("no new messages"); got != "没有新消息" {
			t.Errorf("inboxOutcomeText = %q", got)
		}
	})
	// English mode is identity.
	i18n.Set("en")
	for en := range zhCases {
		if tickOutcomeText(en) != en {
			t.Errorf("en tickOutcomeText changed %q", en)
		}
	}
	// Unknown strings (e.g. member-authored pause reasons) pass through in both
	// languages — the boundary never invents translations.
	unknown := "paused: 自定义原因 zìdìngyì"
	withLang("zh", func() {
		if got := tickOutcomeText(unknown); got != "已暂停：自定义原因 zìdìngyì" {
			t.Errorf("prefix map: %q", got)
		}
		if got := tickOutcomeText("totally unknown server text"); got != "totally unknown server text" {
			t.Errorf("unknown passthrough: %q", got)
		}
	})
}

// TestI18nAgoAndExitLabels checks time-ago text and tick exit-code labels.
func TestI18nAgoAndExitLabels(t *testing.T) {
	withLang("zh", func() {
		if got := agoMS(0); got != "从未" {
			t.Errorf("agoMS(0) zh = %q", got)
		}
		if got := tickExitLabel(3); got != "没有要处理的消息" {
			t.Errorf("exit 3 zh = %q", got)
		}
		if got := tickExitLabel(5); got != "额度用尽" {
			t.Errorf("exit 5 zh = %q", got)
		}
	})
	i18n.Set("en")
	if got := agoMS(0); got != "never" || hasCJK(got) {
		t.Errorf("agoMS(0) en = %q", got)
	}
	if got := tickExitLabel(3); got != "nothing to do" {
		t.Errorf("exit 3 en = %q", got)
	}
}

// TestI18nBoundaryError covers the CLI-boundary translation of the common
// "not joined" setup error, including when it is wrapped.
func TestI18nBoundaryError(t *testing.T) {
	i18n.Set("en")
	if got := boundaryError(hub.ErrNoConfig); got.Error() != hub.ErrNoConfig.Error() {
		t.Fatalf("en must keep original: %v", got)
	}
	withLang("zh", func() {
		got := boundaryError(hub.ErrNoConfig)
		if !strings.Contains(got.Error(), "尚未加入 hub") {
			t.Fatalf("zh ErrNoConfig: %v", got)
		}
		wrapped := fmt.Errorf("thread list: %w", hub.ErrNoConfig)
		got = boundaryError(wrapped)
		if !strings.Contains(got.Error(), "尚未加入 hub") {
			t.Fatalf("zh wrapped ErrNoConfig: %v", got)
		}
		// Unknown errors pass through untouched in both languages.
		other := errors.New("dial tcp: i/o timeout")
		if boundaryError(other).Error() != other.Error() {
			t.Fatalf("unknown error should passthrough: %v", other)
		}
	})
}
