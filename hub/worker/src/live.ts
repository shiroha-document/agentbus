// Live thread status: delivery receipts + agent activity (v06-contract §3).
import { DB, qmarks } from "./db";

const ACTIVITY_WINDOW_MS = 30 * 60_000;
export const STALE_MS = 10 * 60_000;
const RECEIPT_POSTS = 30;

export type ReceiptState = "sent" | "received" | "working" | "handled" | "failed";
export interface Receipt {
  member_id: string;
  state: ReceiptState;
  at: number;
  eta: number | null;
}

function receiptState(delivery: string, activity: string | undefined): ReceiptState | null {
  switch (delivery) {
    case "pending":
      return "sent";
    case "leased":
      return activity === "running" || activity === "typing" ? "working" : "received";
    case "done":
      return "handled";
    case "dead":
      return "failed";
    default:
      return null;
  }
}

/** Activity state per member for the given threads ("member|thread" → state), recent rows only. */
async function activityMap(db: DB, threadIds: string[], now: number) {
  if (!threadIds.length) return new Map<string, string>();
  const rows = await db.all<{ member_id: string; thread_id: string; state: string }>(
    `SELECT member_id, thread_id, state FROM activity WHERE team_id = ? AND thread_id IN (${qmarks(threadIds.length)}) AND updated_at >= ?`,
    db.team,
    ...threadIds,
    now - ACTIVITY_WINDOW_MS,
  );
  return new Map(rows.map((r) => [`${r.member_id}|${r.thread_id}`, r.state]));
}

/** GET /web/threads/:id/live body (thread already checked to be in db.team). */
export async function threadLive(db: DB, threadId: string, now = Date.now(), requestedPostIds?: readonly string[]) {
  const [postIds, act, newest] = await Promise.all([
    requestedPostIds === undefined
      ? db.all<{ post_id: string }>(
          "SELECT DISTINCT post_id FROM deliveries WHERE thread_id = ? AND team_id = ? ORDER BY post_id DESC LIMIT ?",
          threadId,
          db.team,
          RECEIPT_POSTS,
        )
      : requestedPostIds.map((post_id) => ({ post_id })),
    db.all<{
      member_id: string;
      state: string;
      detail: string | null;
      cli: string | null;
      model: string | null;
      started_at: number;
      updated_at: number;
    }>(
      "SELECT member_id, state, detail, cli, model, started_at, updated_at FROM activity WHERE thread_id = ? AND team_id = ? AND updated_at >= ? ORDER BY updated_at DESC",
      threadId,
      db.team,
      now - ACTIVITY_WINDOW_MS,
    ),
    db.first<{ id: string }>("SELECT id FROM posts WHERE thread_id = ? AND team_id = ? ORDER BY id DESC LIMIT 1", threadId, db.team),
  ]);
  const ids = postIds.map((p) => p.post_id);
  const ds = ids.length
    ? await db.all<{ post_id: string; member_id: string; state: string; updated_at: number; last_seen_at: number | null; wake_interval_s: number | null }>(
        `SELECT d.post_id, d.member_id, d.state, d.updated_at, m.last_seen_at, m.wake_interval_s
         FROM deliveries d
         JOIN posts p ON p.id = d.post_id AND p.team_id = d.team_id AND p.thread_id = d.thread_id
         LEFT JOIN members m ON m.id = d.member_id AND m.team_id = d.team_id
         WHERE d.team_id = ? AND d.thread_id = ? AND d.post_id IN (SELECT value FROM json_each(?)) ORDER BY d.post_id, d.created_at`,
        db.team,
        threadId,
        JSON.stringify(ids),
      )
    : [];
  const actState = new Map(act.map((a) => [a.member_id, a.state]));
  const receipts: Record<string, Receipt[]> = {};
  for (const d of ds) {
    const state = receiptState(d.state, actState.get(d.member_id));
    if (!state) continue;
    const eta =
      state === "sent" && d.last_seen_at != null ? Number(d.last_seen_at) + (Number(d.wake_interval_s) || 300) * 1000 : null;
    (receipts[d.post_id] ??= []).push({ member_id: d.member_id, state, at: Number(d.updated_at), eta });
  }
  return {
    now,
    receipts,
    activity: act.map((a) => ({
      member_id: a.member_id,
      state: a.state,
      detail: a.detail ?? null,
      cli: a.cli ?? null,
      model: a.model ?? null,
      started_at: Number(a.started_at),
      updated_at: Number(a.updated_at),
      stale: a.state !== "done" && a.state !== "failed" && now - Number(a.updated_at) > STALE_MS,
    })),
    next_post_id: newest?.id ?? null,
  };
}

export type ReceiptsSummary = { sent: number; received: number; working: number; handled: number };

/** Per-post receipt counts for feed items (one grouped query + one activity lookup). */
export async function receiptsSummary(db: DB, postIds: string[], now = Date.now()): Promise<Map<string, ReceiptsSummary>> {
  const out = new Map<string, ReceiptsSummary>();
  if (!postIds.length) return out;
  const rows = await db.all<{ post_id: string; thread_id: string; member_id: string; state: string }>(
    `SELECT post_id, thread_id, member_id, state FROM deliveries WHERE team_id = ? AND post_id IN (${qmarks(postIds.length)})`,
    db.team,
    ...postIds,
  );
  if (!rows.length) return out;
  const leasedThreads = [...new Set(rows.filter((r) => r.state === "leased").map((r) => r.thread_id))];
  const act = await activityMap(db, leasedThreads, now);
  for (const r of rows) {
    const s = receiptState(r.state, act.get(`${r.member_id}|${r.thread_id}`));
    if (!s || s === "failed") continue;
    let o = out.get(r.post_id);
    if (!o) out.set(r.post_id, (o = { sent: 0, received: 0, working: 0, handled: 0 }));
    o[s]++;
  }
  return out;
}
