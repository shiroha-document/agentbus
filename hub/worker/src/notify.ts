import type { Env } from "./env";
import { DB, qmarks } from "./db";
import { escapeHtml, newId } from "./util";

export const KIND_LABELS: Record<string, string> = {
  join_request: "新 agent 申请加入",
  confirm_request: "新的确认请求",
  agent_offline: "agent 离线",
  agent_unresponsive: "agent 无回应",
  delivery_dead: "消息投递失败",
  quota_paused: "agent 被暂停（额度/预算）",
  flood_blocked: "刷屏被拦截",
  secret_redacted: "帖子里扫描到密钥",
  run_failures: "agent 连续运行失败",
  email_change: "确认通知邮箱",
  test: "测试邮件",
};

export interface NotePayload {
  title: string;
  text?: string;
  /** Path on the hub ("/threads/t_x") or absolute URL. */
  link?: string;
  to?: string;
}

export function notify(db: DB, kind: string, payload: NotePayload, dedupeKey: string | null = null): D1PreparedStatement {
  return db.stmt(
    "INSERT OR IGNORE INTO notifications (id, kind, dedupe_key, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    newId("n"),
    kind,
    dedupeKey,
    JSON.stringify(payload),
    Date.now(),
  );
}

function absLink(env: Env, link?: string): string | null {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  const base = (env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return base ? base + link : link;
}

export function renderEmail(env: Env, kind: string, items: NotePayload[]) {
  const label = KIND_LABELS[kind] ?? kind;
  const subject = items.length > 1 ? `[agentbus] ${label}（${items.length} 条）` : `[agentbus] ${items[0]?.title ?? label}`;
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const it of items) {
    const link = absLink(env, it.link);
    textParts.push(`• ${it.title}${it.text ? `\n  ${it.text}` : ""}${link ? `\n  ${link}` : ""}`);
    htmlParts.push(
      `<li style="margin:0 0 14px"><div style="font-weight:600">${escapeHtml(it.title)}</div>` +
        (it.text ? `<div style="color:#475569;white-space:pre-wrap">${escapeHtml(it.text)}</div>` : "") +
        (link
          ? `<div><a href="${escapeHtml(link)}" style="color:#059669;text-decoration:none">打开 →</a></div>`
          : "") +
        `</li>`,
    );
  }
  const home = absLink(env, "/");
  const text = `${label}\n\n${textParts.join("\n\n")}\n\n${home ? `agentbus hub: ${home}\n` : ""}`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">` +
    `<div style="font-size:13px;color:#10b981;font-weight:600;letter-spacing:.02em">agentbus</div>` +
    `<h2 style="font-size:18px;margin:6px 0 18px">${escapeHtml(label)}</h2>` +
    `<ul style="padding-left:18px;margin:0">${htmlParts.join("")}</ul>` +
    (home ? `<p style="font-size:12px;color:#94a3b8;margin-top:24px"><a href="${escapeHtml(home)}" style="color:#94a3b8">${escapeHtml(home)}</a></p>` : "") +
    `</div>`;
  return { subject, text, html };
}

export async function sendEmail(env: Env, to: string, msg: { subject: string; text: string; html: string }) {
  if (!env.EMAIL) throw new Error("EMAIL binding not configured");
  if (!env.MAIL_FROM) throw new Error("MAIL_FROM not configured");
  await env.EMAIL.send({ from: { name: "agentbus", email: env.MAIL_FROM }, to, subject: msg.subject, text: msg.text, html: msg.html });
}

interface NoteRow {
  id: string;
  kind: string;
  payload: string;
  created_at: number;
}

/**
 * Send due notifications. Each kind is merged into one email; a kind that was
 * emailed less than `merge_window_min` ago waits for the window to pass.
 * `email_change` goes only to the new address and is never merged.
 */
export async function flushNotifications(env: Env, opts: { force?: boolean; now?: number } = {}) {
  const db = new DB(env.DB);
  const now = opts.now ?? Date.now();
  const s = await db.settings();
  const windowMs = Math.max(0, Number(s.merge_window_min ?? 15)) * 60_000;
  let kinds: Record<string, boolean> = {};
  try {
    kinds = JSON.parse(s.notify_kinds ?? "{}");
  } catch {
    kinds = {};
  }
  const to = s.notify_email ?? "";
  const unsent = await db.all<NoteRow>(
    "SELECT id, kind, payload, created_at FROM notifications WHERE sent_at IS NULL ORDER BY created_at LIMIT 500",
  );
  if (!unsent.length) return { sent: 0 };
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
  };
  for (const [kind, rows] of byKind) {
    if (kind === "email_change") {
      for (const r of rows) {
        const p = JSON.parse(r.payload) as NotePayload;
        try {
          if (!p.to) throw new Error("missing recipient");
          await sendEmail(env, p.to, renderEmail(env, kind, [p]));
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
    if (!opts.force && kind !== "test") {
      const last = await db.first<{ t: number | null }>(
        "SELECT MAX(sent_at) AS t FROM notifications WHERE kind = ? AND sent_at IS NOT NULL AND error IS NULL",
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
      await sendEmail(env, to, renderEmail(env, kind, payloads));
      await mark(ids, null);
      sent++;
    } catch (e) {
      await mark(ids, errText(e));
      console.error("notify send failed", kind, errText(e));
    }
  }
  return { sent };
}

export function errText(e: unknown): string {
  const err = e as { code?: string; message?: string };
  return [err?.code, err?.message ?? String(e)].filter(Boolean).join(": ").slice(0, 300);
}
