import type { Env } from "./env";
import { DB, qmarks } from "./db";
import { newId } from "./util";
import { KIND_LABELS, renderEmail } from "./email";

export { KIND_LABELS };

export interface NotePayload {
  title: string;
  text?: string;
  /** Path on the hub ("/threads/t_x") or absolute URL. */
  link?: string;
  to?: string;
}

/** Queue a notification for `db.team` (hub-api.md §7). */
export function notify(db: DB, kind: string, payload: NotePayload, dedupeKey: string | null = null): D1PreparedStatement {
  return db.stmt(
    "INSERT OR IGNORE INTO notifications (id, team_id, kind, dedupe_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    newId("n"),
    db.team,
    kind,
    dedupeKey,
    JSON.stringify(payload),
    Date.now(),
  );
}

export async function sendEmail(env: Env, to: string, msg: { subject: string; text: string; html: string }) {
  if (!env.EMAIL) throw new Error("EMAIL binding not configured");
  if (!env.MAIL_FROM) throw new Error("MAIL_FROM not configured");
  await env.EMAIL.send({ from: { name: "agentbus", email: env.MAIL_FROM }, to, subject: msg.subject, text: msg.text, html: msg.html });
}

interface NoteRow {
  id: string;
  team_id: string | null;
  kind: string;
  payload: string;
  created_at: number;
}

/** Kinds sent straight to `payload.to`, one email each, never merged. */
export const DIRECT_KINDS = new Set(["email_change", "invite"]);

/**
 * Send due notifications, per team. Each (team, kind) is merged into one email
 * to that team's notify_email; a kind that was emailed less than the team's
 * `merge_window_min` ago waits for the window to pass. `email_change` and
 * `invite` go only to `payload.to` and are never merged. `team` / `kind`
 * restrict the flush (e.g. send just-created invites without flushing the
 * rest of the team's outbox early).
 */
export async function flushNotifications(env: Env, opts: { force?: boolean; now?: number; team?: string; kind?: string } = {}) {
  const now = opts.now ?? Date.now();
  const root = new DB(env.DB);
  const where = ["sent_at IS NULL"];
  const args: string[] = [];
  if (opts.team) {
    where.push("team_id = ?");
    args.push(opts.team);
  }
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  const unsent = await root.all<NoteRow>(
    `SELECT id, team_id, kind, payload, created_at FROM notifications WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT 500`,
    ...args,
  );
  if (!unsent.length) return { sent: 0 };
  const byTeam = new Map<string, NoteRow[]>();
  for (const n of unsent) {
    const k = n.team_id ?? "";
    const list = byTeam.get(k) ?? [];
    list.push(n);
    byTeam.set(k, list);
  }
  let sent = 0;
  for (const [teamId, rows] of byTeam) sent += await flushTeam(env, teamId || null, rows, now, !!opts.force);
  return { sent };
}

async function flushTeam(env: Env, teamId: string | null, unsent: NoteRow[], now: number, force: boolean): Promise<number> {
  const db = new DB(env.DB, teamId);
  const s = await db.settings();
  const team = teamId ? await db.first<{ id: string; name: string }>("SELECT id, name FROM teams WHERE id = ?", teamId) : null;
  const ctx = { team };
  const windowMs = Math.max(0, Number(s.merge_window_min ?? 15)) * 60_000;
  let kinds: Record<string, boolean> = {};
  try {
    kinds = JSON.parse(s.notify_kinds ?? "{}");
  } catch {
    kinds = {};
  }
  const to = teamId ? (s.notify_email ?? "") : "";
  const byKind = new Map<string, NoteRow[]>();
  for (const n of unsent) {
    const list = byKind.get(n.kind) ?? [];
    list.push(n);
    byKind.set(n.kind, list);
  }
  let sent = 0;
  const mark = async (ids: string[], error: string | null) => {
    if (!ids.length) return;
    await db.run(
      `UPDATE notifications SET sent_at = ?, error = ? WHERE id IN (${qmarks(ids.length)})`,
      now,
      error,
      ...ids,
    );
    if (error && error !== "disabled") await db.batch([db.bumpSeq()]);
  };
  for (const [kind, rows] of byKind) {
    if (DIRECT_KINDS.has(kind)) {
      for (const r of rows) {
        const p = JSON.parse(r.payload) as NotePayload;
        try {
          if (!p.to) throw new Error("missing recipient");
          await sendEmail(env, p.to, renderEmail(env, kind, [p], ctx));
          await mark([r.id], null);
          sent++;
        } catch (e) {
          await mark([r.id], errText(e));
        }
      }
      continue;
    }
    const ids = rows.map((r) => r.id);
    if (kinds[kind] === false) {
      await mark(ids, "disabled");
      continue;
    }
    if (!force && kind !== "test") {
      const last = await db.first<{ t: number | null }>(
        "SELECT MAX(sent_at) AS t FROM notifications WHERE team_id IS ? AND kind = ? AND sent_at IS NOT NULL AND error IS NULL",
        teamId,
        kind,
      );
      if (last?.t && now - last.t < windowMs) continue;
    }
    if (!to) {
      await mark(ids, "notify_email not set");
      continue;
    }
    try {
      const payloads = rows.map((r) => JSON.parse(r.payload) as NotePayload);
      await sendEmail(env, to, renderEmail(env, kind, payloads, ctx));
      await mark(ids, null);
      sent++;
    } catch (e) {
      await mark(ids, errText(e));
      console.error("notify send failed", kind, errText(e));
    }
  }
  return sent;
}

export interface EmailHealth {
  ok: boolean;
  last_error: string | null;
  last_error_at: number | null;
  last_sent_at: number | null;
  failed_count: number;
  hint: string | null;
}

/** Map a send error to an actionable Chinese hint. */
export function emailHint(error: string | null): string | null {
  if (!error) return null;
  if (/E_RECIPIENT_NOT_ALLOWED|not a verified/i.test(error))
    return "收件地址还没在 Cloudflare Email Routing 里验证：去邮箱点开 Cloudflare 发来的验证邮件（Dashboard → Email Routing → Destination addresses 可重发），验证后在设置页发一封测试邮件确认。";
  if (/notify_email not set/.test(error)) return "还没有设置通知邮箱，提醒邮件都被丢弃了。请在设置页填写通知邮箱。";
  if (/EMAIL binding not configured|MAIL_FROM not configured/.test(error))
    return "Worker 没有配置邮件发送（send_email 绑定或 MAIL_FROM），需要检查 wrangler 配置后重新部署。";
  if (/E_SENDER|sender/i.test(error)) return "发件地址不可用：MAIL_FROM 的域名需要在 Cloudflare 启用 Email Routing。";
  if (/rate|limit|quota/i.test(error)) return "邮件发送被限流，稍后会继续；如持续出现请检查 Cloudflare 邮件额度。";
  return "邮件发送失败。可在设置页点「发送测试邮件」重试并查看具体错误。";
}

/**
 * Health of a team's notify_email channel: unhealthy when the most recent
 * attempt (by sent_at, then id — ids are monotonic, so same-millisecond
 * attempts are still ordered) failed. Direct kinds (`email_change`, `invite`:
 * other recipients, errors shown inline) and disabled kinds are ignored.
 */
export async function emailHealth(db: DB, teamId: string | null = db.team): Promise<EmailHealth> {
  const base = "FROM notifications WHERE team_id IS ? AND sent_at IS NOT NULL AND (error IS NULL OR error <> 'disabled') AND kind NOT IN ('email_change', 'invite')";
  const [latest, err, ok] = await Promise.all([
    db.first<{ id: string; error: string | null; sent_at: number }>(`SELECT id, error, sent_at ${base} ORDER BY sent_at DESC, id DESC LIMIT 1`, teamId),
    db.first<{ error: string; sent_at: number }>(`SELECT error, sent_at ${base} AND error IS NOT NULL ORDER BY sent_at DESC, id DESC LIMIT 1`, teamId),
    db.first<{ id: string; sent_at: number }>(`SELECT id, sent_at ${base} AND error IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1`, teamId),
  ]);
  const healthy = !latest || latest.error === null;
  let failed = 0;
  if (!healthy) {
    const r = ok
      ? await db.first<{ n: number }>(
          `SELECT COUNT(*) AS n ${base} AND error IS NOT NULL AND (sent_at > ? OR (sent_at = ? AND id > ?))`,
          teamId,
          ok.sent_at,
          ok.sent_at,
          ok.id,
        )
      : await db.first<{ n: number }>(`SELECT COUNT(*) AS n ${base} AND error IS NOT NULL`, teamId);
    failed = Number(r?.n ?? 0);
  }
  return {
    ok: healthy,
    last_error: err?.error ?? null,
    last_error_at: err?.sent_at ?? null,
    last_sent_at: ok?.sent_at ?? null,
    failed_count: failed,
    hint: healthy ? null : emailHint(latest!.error),
  };
}

export function errText(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return [err?.code, err?.message ?? String(e)].filter(Boolean).join(": ").slice(0, 300);
}
