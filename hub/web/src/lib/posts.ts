// Message-list layout helpers: author grouping, day separators, agent↔agent detection.
import type { Member, Post } from "../types";

export const GROUP_WINDOW_MS = 5 * 60_000;

/** Kinds that read as chat bubbles and can be grouped under one header. */
const GROUPABLE = new Set(["msg", "progress"]);

export type ListRow =
  | { type: "day"; key: string; label: string; ts: number }
  | { type: "post"; key: string; post: Post; compact: boolean };

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** "今天" / "昨天" / "10月18日 周六" / "2025年10月18日". */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const wk = "日一二三四五六"[d.getDay()];
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 周${wk}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * Whether `post` continues `prev` (same author, both groupable, < 5 min apart, same day,
 * and not a reply — a reply always shows its quote with a full header).
 */
export function continuesGroup(prev: Post | undefined, post: Post): boolean {
  if (!prev) return false;
  if (prev.author_id !== post.author_id) return false;
  if (!GROUPABLE.has(prev.kind) || !GROUPABLE.has(post.kind)) return false;
  if (post.reply_to) return false;
  if (post.created_at - prev.created_at > GROUP_WINDOW_MS || post.created_at < prev.created_at) return false;
  return dayKey(prev.created_at) === dayKey(post.created_at);
}

/** Flatten posts (ascending) into rows with day separators and compact flags. */
export function buildRows(posts: readonly Post[], now: number = Date.now()): ListRow[] {
  const rows: ListRow[] = [];
  let lastDay: string | null = null;
  let prev: Post | undefined;
  for (const p of posts) {
    const dk = dayKey(p.created_at);
    if (dk !== lastDay) {
      rows.push({ type: "day", key: `day-${dk}`, label: dayLabel(p.created_at, now), ts: p.created_at });
      lastDay = dk;
      prev = undefined;
    }
    rows.push({ type: "post", key: p.id, post: p, compact: continuesGroup(prev, p) });
    prev = p;
  }
  return rows;
}

/**
 * agent↔agent: an agent's message that is addressed to another agent (reply to an agent's
 * post, or mentions only agents). Returns the other agent, if any.
 */
export function agentPeer(post: Post, members: Map<string, Member>, replyTo?: Post): Member | undefined {
  if (post.kind !== "msg") return undefined;
  const author = members.get(post.author_id);
  if (author?.kind !== "agent") return undefined;
  if (replyTo) {
    const ra = members.get(replyTo.author_id);
    if (ra?.kind === "agent" && ra.id !== author.id) return ra;
    if (ra) return undefined;
  }
  const targets = post.mentions.map((id) => members.get(id)).filter((m): m is Member => !!m && m.id !== author.id);
  if (targets.length > 0 && targets.every((m) => m.kind === "agent")) return targets[0];
  return undefined;
}

/** Merge an older page in front of the loaded posts (dedup by id, keep ascending order). */
export function mergeOlder(older: readonly Post[], current: readonly Post[]): Post[] {
  const ids = new Set(current.map((p) => p.id));
  return [...older.filter((p) => !ids.has(p.id)), ...current].sort((a, b) => a.created_at - b.created_at);
}

/** Index of the first pending confirmation after `afterIndex` (wraps around); -1 if none. */
export function nextPendingConfirm(posts: readonly Post[], afterId: string | null): number {
  const pending = posts.map((p, i) => (p.kind === "confirm" && p.confirmation?.status === "pending" ? i : -1)).filter((i) => i >= 0);
  if (pending.length === 0) return -1;
  if (afterId === null) return pending[0]!;
  const cur = posts.findIndex((p) => p.id === afterId);
  return pending.find((i) => i > cur) ?? pending[0]!;
}

/**
 * Progress posts that a later progress post from the same author already replaces (no other
 * author's msg/confirm in between). The worker collapses a running round into one post, but
 * separate rounds can still repeat themselves; the UI folds the older ones.
 */
export function supersededProgress(posts: readonly Post[]): Set<string> {
  const out = new Set<string>();
  const lastByAuthor = new Map<string, string>();
  for (const p of posts) {
    if (p.kind === "progress") {
      const prev = lastByAuthor.get(p.author_id);
      if (prev) out.add(prev);
      lastByAuthor.set(p.author_id, p.id);
    } else if (p.kind === "msg" || p.kind === "confirm") {
      // Someone (else) spoke: earlier progress stays visible as context.
      for (const a of [...lastByAuthor.keys()]) if (a !== p.author_id || p.kind === "confirm") lastByAuthor.delete(a);
    }
  }
  return out;
}
