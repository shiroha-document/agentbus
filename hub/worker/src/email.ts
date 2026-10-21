// Notification email templates (hub-api.md §7). Pure functions: no DB access.
import type { Env } from "./env";
import { escapeHtml } from "./util";

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
  invite: "团队邀请",
  test: "测试邮件",
};

export interface EmailItem {
  title: string;
  text?: string;
  /** Path on the hub ("/threads/t_x") or absolute URL. */
  link?: string;
}

export interface EmailContext {
  /** Team the notification belongs to; shown in the header and appended to links as ?team=. */
  team?: { id: string; name: string } | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function absLink(env: Env, link?: string): string | null {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  const base = (env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return base ? base + link : link;
}

export function renderEmail(env: Env, kind: string, items: EmailItem[], _ctx: EmailContext = {}) {
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

