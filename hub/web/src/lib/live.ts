// Live status helpers (contract §3): delivery receipts + agent activity.
import type { Activity, ActivityState, Receipt, ReceiptState, ThreadLive } from "../types";

export const RECEIPT_LABEL: Record<ReceiptState, string> = {
  sent: "已送达",
  received: "已读",
  working: "处理中",
  handled: "已处理",
  failed: "投递失败",
};

/** Progress order: a post's aggregate state is the *least advanced* receipt (failed wins). */
const ORDER: Record<ReceiptState, number> = { sent: 0, received: 1, working: 2, handled: 3, failed: -1 };

export interface ReceiptSummary {
  state: ReceiptState;
  total: number;
  counts: Record<ReceiptState, number>;
  /** Earliest eta among "sent" receipts, if known. */
  eta: number | null;
}

export function summarizeReceipts(list: readonly Receipt[] | undefined): ReceiptSummary | null {
  if (!list || list.length === 0) return null;
  const counts: Record<ReceiptState, number> = { sent: 0, received: 0, working: 0, handled: 0, failed: 0 };
  let state: ReceiptState = "handled";
  let eta: number | null = null;
  for (const r of list) {
    counts[r.state]++;
    if (r.state === "failed") state = "failed";
    else if (state !== "failed" && ORDER[r.state] < ORDER[state]) state = r.state;
    if (r.state === "sent" && r.eta !== null && (eta === null || r.eta < eta)) eta = r.eta;
  }
  return { state, total: list.length, counts, eta };
}

/** Same aggregation for a feed item's receipts_summary (no failed / eta info). */
export function summaryStateFromCounts(c: { sent: number; received: number; working: number; handled: number } | undefined): ReceiptState | null {
  if (!c) return null;
  if (c.sent + c.received + c.working + c.handled === 0) return null;
  if (c.sent > 0) return "sent";
  if (c.received > 0) return "received";
  if (c.working > 0) return "working";
  return "handled";
}

/** "mm:ss" (or "h:mm:ss") until `eta`; negative / past → "0:00". */
export function formatCountdown(eta: number, now: number): string {
  const s = Math.max(0, Math.ceil((eta - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Elapsed clock "m:ss" since `start`. */
export function formatElapsed(start: number, now: number): string {
  return formatCountdown(now, start);
}

/** One-line label for a single recipient's receipt. */
export function receiptText(r: Receipt, name: string, now: number): string {
  switch (r.state) {
    case "sent":
      if (r.eta === null) return `等待 @${name} 唤醒`;
      return r.eta > now ? `等待 @${name} 唤醒 · 预计 ${formatCountdown(r.eta, now)}` : `等待 @${name} 唤醒 · 应该快了`;
    case "received":
      return `@${name} 已读`;
    case "working":
      return `@${name} 正在处理`;
    case "handled":
      return `@${name} 已处理`;
    case "failed":
      return `投递给 @${name} 失败`;
  }
}

export const ACTIVE_ACTIVITY: ReadonlySet<ActivityState> = new Set(["claimed", "running", "typing"]);
const ACTIVE_RECEIPT: ReadonlySet<ReceiptState> = new Set(["sent", "received", "working"]);

/** Whether the live view should poll fast (2 s). */
export function isLiveActive(live: ThreadLive | undefined): boolean {
  if (!live) return false;
  for (const list of Object.values(live.receipts)) for (const r of list) if (ACTIVE_RECEIPT.has(r.state)) return true;
  return live.activity.some((a) => ACTIVE_ACTIVITY.has(a.state) && !a.stale);
}

/** Activity rows that belong in the bottom bar (in progress, newest first). */
export function visibleActivity(list: readonly Activity[] | undefined): Activity[] {
  return (list ?? []).filter((a) => ACTIVE_ACTIVITY.has(a.state)).sort((a, b) => b.updated_at - a.updated_at);
}

/** Bottom-bar text for one activity row. */
export function activityText(a: Activity, name: string): string {
  const what = a.detail ?? [a.cli, a.model].filter(Boolean).join(" · ");
  switch (a.state) {
    case "claimed":
      return `@${name} 已接收`;
    case "running":
      return what ? `@${name} 正在运行 ${what}` : `@${name} 正在运行`;
    case "typing":
      return `@${name} 正在输入`;
    case "done":
      return `@${name} 已完成`;
    case "failed":
      return a.detail ? `@${name} 运行失败：${a.detail}` : `@${name} 运行失败`;
  }
}
