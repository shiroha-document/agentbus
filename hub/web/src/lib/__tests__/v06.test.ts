import { setLanguage } from "../i18n";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activityText,
  formatCountdown,
  formatElapsed,
  isLiveActive,
  receiptText,
  summarizeReceipts,
  summaryStateFromCounts,
  visibleActivity,
} from "../live";
import { agentPeer, buildRows, continuesGroup, dayLabel, mergeOlder, nextPendingConfirm, supersededProgress } from "../posts";
import { attachmentHref, formatBytes, isInlineImage, mimeGroup, validateFiles, MAX_ATTACHMENTS } from "../attachments";
import { activeMentionQuery, rankMentions } from "../mentions";
import type { Activity, Member, Post, Receipt, ThreadLive } from "../../types";

const r = (state: Receipt["state"], eta: number | null = null): Receipt => ({ member_id: "m", state, at: 0, eta });
const act = (state: Activity["state"], extra: Partial<Activity> = {}): Activity => ({
  member_id: "m_a",
  state,
  detail: null,
  cli: null,
  model: null,
  started_at: 0,
  updated_at: 0,
  stale: false,
  ...extra,
});
const P = (id: string, author: string, at: number, extra: Partial<Post> = {}): Post => ({
  id,
  thread_id: "t",
  author_id: author,
  reply_to: null,
  body: id,
  kind: "msg",
  mentions: [],
  redacted: false,
  usage: null,
  reactions: [],
  confirmation: null,
  created_at: at,
  ...extra,
});
const M = (id: string, kind: Member["kind"]): Member =>
  ({ id, kind, name: id, display_name: id, status: "active" }) as unknown as Member;

describe("live receipts", () => {
  it("aggregates to the least advanced state, failed wins", () => {
    expect(summarizeReceipts([])).toBeNull();
    expect(summarizeReceipts([r("handled"), r("received")])?.state).toBe("received");
    expect(summarizeReceipts([r("handled"), r("working")])?.state).toBe("working");
    expect(summarizeReceipts([r("handled"), r("handled")])?.state).toBe("handled");
    expect(summarizeReceipts([r("sent"), r("failed"), r("handled")])?.state).toBe("failed");
    const s = summarizeReceipts([r("sent", 9000), r("sent", 5000), r("received")]);
    expect(s?.eta).toBe(5000);
    expect(s?.counts).toEqual({ sent: 2, received: 1, working: 0, handled: 0, failed: 0 });
  });
  it("derives feed summary state", () => {
    expect(summaryStateFromCounts(undefined)).toBeNull();
    expect(summaryStateFromCounts({ sent: 0, received: 0, working: 0, handled: 0 })).toBeNull();
    expect(summaryStateFromCounts({ sent: 1, received: 0, working: 0, handled: 2 })).toBe("sent");
    expect(summaryStateFromCounts({ sent: 0, received: 0, working: 1, handled: 2 })).toBe("working");
    expect(summaryStateFromCounts({ sent: 0, received: 0, working: 0, handled: 2 })).toBe("handled");
  });
  it("labels receipts", () => {
    expect(receiptText(r("sent", 65_000), "codex", 0)).toBe("等待 @codex 唤醒 · 预计 1:05");
    expect(receiptText(r("sent", 1000), "codex", 5000)).toBe("等待 @codex 唤醒 · 应该快了");
    expect(receiptText(r("sent"), "codex", 0)).toBe("等待 @codex 唤醒");
    expect(receiptText(r("received"), "codex", 0)).toBe("@codex 已接收");
    expect(receiptText(r("handled"), "codex", 0)).toBe("@codex 已处理");
    expect(receiptText(r("failed"), "codex", 0)).toBe("投递给 @codex 失败");
  });
  it("formats countdown and elapsed", () => {
    expect(formatCountdown(0, 1000)).toBe("0:00");
    expect(formatCountdown(9_500, 0)).toBe("0:10");
    expect(formatCountdown(600_000, 0)).toBe("10:00");
    expect(formatCountdown(3_723_000, 0)).toBe("1:02:03");
    expect(formatElapsed(0, 75_000)).toBe("1:15");
  });
  it("decides fast polling", () => {
    const live = (receipts: Receipt[], activity: Activity[] = []): ThreadLive => ({ now: 0, receipts: { p: receipts }, activity, next_post_id: null });
    expect(isLiveActive(undefined)).toBe(false);
    expect(isLiveActive(live([r("handled")]))).toBe(false);
    expect(isLiveActive(live([r("sent")]))).toBe(true);
    expect(isLiveActive(live([r("handled")], [act("typing")]))).toBe(true);
    expect(isLiveActive(live([r("handled")], [act("running", { stale: true })]))).toBe(false);
    expect(isLiveActive(live([], [act("done")]))).toBe(false);
  });
  it("labels activity", () => {
    expect(activityText(act("claimed"), "codex")).toBe("@codex 已接收");
    expect(activityText(act("running", { detail: "cursor · gpt-5" }), "codex")).toBe("@codex 正在运行 cursor · gpt-5");
    expect(activityText(act("running", { cli: "codex", model: "gpt-5" }), "codex")).toBe("@codex 正在运行 codex · gpt-5");
    expect(activityText(act("typing"), "codex")).toBe("@codex 正在输入");
    expect(visibleActivity([act("done"), act("typing", { updated_at: 1 }), act("claimed", { updated_at: 2 })]).map((a) => a.state)).toEqual([
      "claimed",
      "typing",
    ]);
  });
});

describe("post grouping", () => {
  const t0 = new Date(2026, 9, 21, 10, 0).getTime();
  it("groups same author within 5 minutes", () => {
    expect(continuesGroup(P("a", "x", t0), P("b", "x", t0 + 60_000))).toBe(true);
    expect(continuesGroup(P("a", "x", t0), P("b", "x", t0 + 6 * 60_000))).toBe(false);
    expect(continuesGroup(P("a", "x", t0), P("b", "y", t0 + 1000))).toBe(false);
    expect(continuesGroup(P("a", "x", t0), P("b", "x", t0 + 1000, { kind: "confirm" }))).toBe(false);
    expect(continuesGroup(P("a", "x", t0), P("b", "x", t0 + 1000, { reply_to: "a" }))).toBe(false);
    expect(continuesGroup(undefined, P("b", "x", t0))).toBe(false);
  });
  it("inserts day separators and compact flags", () => {
    const yesterday = t0 - 86_400_000;
    const rows = buildRows([P("a", "x", yesterday), P("b", "x", t0), P("c", "x", t0 + 1000), P("d", "y", t0 + 2000)], t0);
    expect(rows.map((x) => (x.type === "day" ? x.label : `${x.post.id}${x.compact ? "*" : ""}`))).toEqual(["昨天", "a", "今天", "b", "c*", "d"]);
  });
  it("labels days", () => {
    expect(dayLabel(t0, t0)).toBe("今天");
    expect(dayLabel(new Date(2026, 9, 18).getTime(), t0)).toBe("10月18日 周日");
    expect(dayLabel(new Date(2025, 0, 2).getTime(), t0)).toBe("2025年1月2日");
  });
  it("detects agent↔agent messages", () => {
    const members = new Map([M("a1", "agent"), M("a2", "agent"), M("h", "human")].map((m) => [m.id, m]));
    expect(agentPeer(P("p", "a1", 0, { mentions: ["a2"] }), members)?.id).toBe("a2");
    expect(agentPeer(P("p", "a1", 0, { mentions: ["a2", "h"] }), members)).toBeUndefined();
    expect(agentPeer(P("p", "a1", 0), members, P("q", "a2", 0))?.id).toBe("a2");
    expect(agentPeer(P("p", "a1", 0, { mentions: ["a2"] }), members, P("q", "h", 0))).toBeUndefined();
    expect(agentPeer(P("p", "h", 0, { mentions: ["a2"] }), members)).toBeUndefined();
  });
  it("merges older pages and finds pending confirms", () => {
    const merged = mergeOlder([P("a", "x", 1), P("b", "x", 2)], [P("b", "x", 2), P("c", "x", 3)]);
    expect(merged.map((p) => p.id)).toEqual(["a", "b", "c"]);
    const pend = (id: string, at: number) =>
      P(id, "x", at, { kind: "confirm", confirmation: { id, thread_id: "t", post_id: id, requester_id: "x", question: "", status: "pending", decided_by: null, decided_at: null, note: null } });
    const list = [P("a", "x", 1), pend("b", 2), P("c", "x", 3), pend("d", 4)];
    expect(nextPendingConfirm(list, null)).toBe(1);
    expect(nextPendingConfirm(list, "b")).toBe(3);
    expect(nextPendingConfirm(list, "d")).toBe(1);
    expect(nextPendingConfirm([P("a", "x", 1)], null)).toBe(-1);
  });
  it("folds repeated progress from the same author", () => {
    const pr = (id: string, author: string, at: number) => P(id, author, at, { kind: "progress" });
    const list = [pr("a", "x", 1), pr("b", "y", 2), pr("c", "x", 3), P("m", "h", 4), pr("d", "x", 5), P("n", "x", 6), pr("e", "x", 7)];
    expect([...supersededProgress(list)].sort()).toEqual(["a", "d"]);
  });
});

describe("attachments", () => {
  it("groups mimes", () => {
    expect(mimeGroup("image/png")).toBe("image");
    expect(mimeGroup("application/pdf")).toBe("pdf");
    expect(mimeGroup("application/zip")).toBe("archive");
    expect(mimeGroup("application/gzip")).toBe("archive");
    expect(mimeGroup("text/plain")).toBe("text");
    expect(mimeGroup("application/json")).toBe("text");
    expect(mimeGroup("", "notes.md")).toBe("text");
    expect(mimeGroup("application/octet-stream", "x.bin")).toBe("other");
  });
  it("only inlines safe raster images", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/svg+xml")).toBe(false);
  });
  it("only allows safe attachment urls", () => {
    expect(attachmentHref("/api/v1/web/files/f_1")).toBe("/api/v1/web/files/f_1");
    expect(attachmentHref("https://x.test/a.png")).toBe("https://x.test/a.png");
    expect(attachmentHref("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
    expect(attachmentHref("data:text/html,<script>")).toBeNull();
    expect(attachmentHref("javascript:alert(1)")).toBeNull();
    expect(attachmentHref("//evil.test/x")).toBeNull();
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(200 * 1024)).toBe("200 KB");
    expect(formatBytes(3.25 * 1024 * 1024)).toBe("3.3 MB");
  });
  it("validates count and size", () => {
    const f = (name: string, size: number) => ({ name, size });
    const v = validateFiles([f("a", 10), f("big", 11 * 1024 * 1024), f("b", 10), f("c", 10)], MAX_ATTACHMENTS - 2);
    expect(v.ok.map((x) => x.name)).toEqual(["a", "b"]);
    expect(v.errors).toEqual(["「big」超过 10 MB，无法上传", "每条消息最多 6 个附件，已忽略 1 个"]);
  });
});

describe("mention autocomplete", () => {
  it("accepts display-name queries", () => {
    expect(activeMentionQuery("hi @陈", 5)).toEqual({ query: "陈", start: 3 });
    expect(activeMentionQuery("hi @Claude", 10)).toEqual({ query: "Claude", start: 3 });
    expect(activeMentionQuery("mail a@b", 8)).toBeNull();
  });
  it("ranks candidates", () => {
    const list = [
      { name: "chen", display_name: "陈雪", kind: "human" },
      { name: "codex-linux", display_name: "Codex Linux", kind: "agent" },
      { name: "claude-mac", display_name: "Claude Mac", kind: "agent" },
      { name: "old", display_name: "Old", kind: "agent", status: "revoked" },
    ];
    expect(rankMentions(list, "c").map((m) => m.name)).toEqual(["claude-mac", "codex-linux", "chen"]);
    expect(rankMentions(list, "陈").map((m) => m.name)).toEqual(["chen"]);
    expect(rankMentions(list, "linux").map((m) => m.name)).toEqual(["codex-linux"]);
    expect(rankMentions(list, "").length).toBe(3);
    expect(rankMentions(list, "old")).toEqual([]);
  });
});

// Existing fixtures assert the Chinese presentation.
beforeEach(() => setLanguage("zh"));
