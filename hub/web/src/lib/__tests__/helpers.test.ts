import { setLanguage } from "../i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { activeMentionQuery, applyMention, extractMentions, splitMentions, splitRedactions } from "../mentions";
import { formatDuration, formatRelative, formatTokens, formatUntil, formatUsd, greeting } from "../format";
import { clampPct, groupQuota, quotaColorVar, quotaLevel } from "../quota";
import { AVATAR_PALETTE_SIZE, avatarGradient, avatarInitial, hashString } from "../avatar";
import { parseProgress } from "../progress";
import { buildHeatmap, heatLevel } from "../heatmap";
import type { QuotaReading } from "../../types";

describe("mentions", () => {
  it("splits mentions and marks unknown names", () => {
    const segs = splitMentions("hi @alice and @bob, cc @all", new Set(["alice"]));
    expect(segs).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", name: "alice", known: true },
      { type: "text", text: " and " },
      { type: "mention", name: "bob", known: false },
      { type: "text", text: ", cc " },
      { type: "mention", name: "all", known: true },
    ]);
  });
  it("ignores emails and uppercase", () => {
    expect(extractMentions("mail me@example.com or @Alice")).toEqual([]);
  });
  it("handles CJK neighbours and start of string", () => {
    expect(extractMentions("@codex-1 请看一下，@alice帮忙")).toEqual(["codex-1", "alice"]);
    expect(extractMentions("请@alice 看")).toEqual(["alice"]);
  });
  it("finds active autocomplete query and applies it", () => {
    const text = "ping @al";
    const q = activeMentionQuery(text, text.length);
    expect(q).toEqual({ query: "al", start: 5 });
    expect(activeMentionQuery("a@b", 3)).toBeNull();
    const r = applyMention(text, q!.start, text.length, "alice");
    expect(r).toEqual({ text: "ping @alice ", caret: 12 });
  });
  it("splits redaction markers", () => {
    expect(splitRedactions("token [已打码:github-pat] end")).toEqual([
      { type: "text", text: "token " },
      { type: "redacted", label: "github-pat" },
      { type: "text", text: " end" },
    ]);
  });
});

describe("format", () => {
  it("formats tokens compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(34_000)).toBe("34k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(null)).toBe("—");
  });
  it("formats usd", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(12.3)).toBe("$12.30");
    expect(formatUsd(12345.6)).toBe("$12,346");
  });
  it("formats relative and remaining time", () => {
    const now = new Date(2026, 9, 20, 15, 0, 0).getTime();
    expect(formatRelative(now - 10_000, now)).toBe("刚刚");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatRelative(now - 3 * 3600_000, now)).toBe("3 小时前");
    expect(formatRelative(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe("昨天 09:05");
    expect(formatRelative(now - 3 * 86400_000, now)).toBe("3 天前");
    expect(formatRelative(null, now)).toBe("从未");
    expect(formatUntil(now + 12 * 60_000, now)).toBe("12 分钟");
    expect(formatUntil(now + 125 * 60_000, now)).toBe("2 小时 5 分");
    expect(formatUntil(now - 1, now)).toBe("已到期");
  });
  it("formats durations and greetings", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_000)).toBe("12秒");
    expect(formatDuration(200_000)).toBe("3分20秒");
    expect(greeting(new Date(2026, 0, 1, 8))).toBe("早上好");
    expect(greeting(new Date(2026, 0, 1, 14))).toBe("下午好");
    expect(greeting(new Date(2026, 0, 1, 21))).toBe("晚上好");
    expect(greeting(new Date(2026, 0, 1, 3))).toBe("晚上好");
  });
});

describe("quota", () => {
  it("maps thresholds to levels", () => {
    expect(quotaLevel(0)).toBe("ok");
    expect(quotaLevel(69.9)).toBe("ok");
    expect(quotaLevel(70)).toBe("warn");
    expect(quotaLevel(89.9)).toBe("warn");
    expect(quotaLevel(90)).toBe("danger");
    expect(quotaLevel(130)).toBe("danger");
    expect(quotaLevel(null)).toBe("unknown");
    expect(quotaColorVar("warn")).toBe("var(--warning)");
    expect(quotaColorVar("ok")).toBe("var(--mint-500)");
    expect(clampPct(140)).toBe(100);
    expect(clampPct(null)).toBe(0);
  });
  it("groups native/magpie pairs and flags divergence > 5pt", () => {
    const base: QuotaReading = {
      provider: "claude", account: null, plan: "max", window: "5h", used_pct: 40,
      resets_at: null, balance: null, source: "magpie", read_at: 0, error: null,
    };
    const groups = groupQuota([base, { ...base, source: "native", used_pct: 47 }, { ...base, window: "7d" }]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.readings[0]!.source).toBe("native");
    expect(groups[0]!.divergent).toBe(true);
    expect(groupQuota([base, { ...base, source: "native", used_pct: 44 }])[0]!.divergent).toBe(false);
  });
});

describe("avatar", () => {
  it("is deterministic and within palette", () => {
    expect(hashString("alice")).toBe(hashString("alice"));
    expect(hashString("alice")).not.toBe(hashString("bob"));
    const a = avatarGradient("alice");
    expect(a).toEqual(avatarGradient("alice"));
    expect(a.index).toBeGreaterThanOrEqual(0);
    expect(a.index).toBeLessThan(AVATAR_PALETTE_SIZE);
    expect(a.from).toBe(`var(--avatar-${a.index}-a)`);
    const seen = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((n) => avatarGradient(n).index));
    expect(seen.size).toBeGreaterThan(3);
  });
  it("picks an initial", () => {
    expect(avatarInitial("alice")).toBe("A");
    expect(avatarInitial("小金")).toBe("小");
    expect(avatarInitial("", "codex")).toBe("C");
  });
});

describe("progress parsing", () => {
  it("parses heading sections", () => {
    const p = parseProgress("开始\n## 要做什么\n修 bug\n## 改了什么\n- a\n- b\n## 怎么验证\n跑测试\n## 下一步\n发版");
    expect(p?.preamble).toBe("开始");
    expect(p?.sections.map((s) => s.name)).toEqual(["要做什么", "改了什么", "怎么验证", "下一步"]);
    expect(p?.sections[1]!.body).toBe("- a\n- b");
  });
  it("parses inline label lines", () => {
    const p = parseProgress("要做什么：加缓存\n**改了什么**：改了 api.ts\n下一步: 无");
    expect(p?.sections).toEqual([
      { name: "要做什么", body: "加缓存" },
      { name: "改了什么", body: "改了 api.ts" },
      { name: "下一步", body: "无" },
    ]);
  });
  it("falls back when not structured", () => {
    expect(parseProgress("just some text\n下一步：x")).toBeNull();
    expect(parseProgress("```\n## 要做什么\n## 改了什么\n```")).toBeNull();
  });
});

describe("heatmap", () => {
  it("levels by ratio", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(6, 10)).toBe(3);
    expect(heatLevel(10, 10)).toBe(4);
  });
  it("lays out weeks Monday-first with month labels", () => {
    const end = new Date(2026, 9, 20); // Tue
    const h = buildHeatmap([{ day: "2026-10-20", count: 4 }, { day: "2026-10-01", count: 2 }], end, 365);
    expect(h.weeks.every((w) => w.length === 7)).toBe(true);
    expect(h.total).toBe(6);
    expect(h.max).toBe(4);
    const lastWeek = h.weeks[h.weeks.length - 1]!;
    expect(lastWeek[1]).toMatchObject({ day: "2026-10-20", count: 4, level: 4, inRange: true });
    expect(lastWeek[2]!.inRange).toBe(false);
    expect(h.months.some((m) => m.label === "10月")).toBe(true);
    expect(h.weeks.length).toBeGreaterThanOrEqual(53);
  });
});

// Existing fixtures assert the Chinese presentation.
beforeEach(() => setLanguage("zh"));
