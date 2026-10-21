// Notification email templates (hub-api.md §7). Pure functions: no DB access.
//
// Design: calm mint brand (ui-guidelines.md), table layout + inline styles so it renders in
// Gmail / Outlook / Apple Mail / mobile; a <style> block only adds mobile + dark-mode tweaks.
// Artwork is PNG @2x served from EMAIL_ASSET_BASE (sources: docs-site/email-src, rendered by
// docs-site/scripts/render-email-assets.mjs). Every image has width/height/alt and sits on a
// coloured cell, so the mail still reads well with images blocked.
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

export const DEFAULT_EMAIL_ASSET_BASE = "https://docs.hub.shiroha.tech/email";

// ---------------------------------------------------------------------------------------------
// Palette (hex approximations of tokens.css; email clients don't understand oklch)

type Severity = "info" | "warn" | "danger";

const P = {
  page: "#eef5f1",
  card: "#ffffff",
  border: "#e1ede7",
  text: "#132019",
  text2: "#4c5a53",
  text3: "#7c8a83",
  mint: "#3fb98a",
  deep: "#0f3b2c",
  chipBg: "#e2f6ec",
  chipText: "#1d6b4e",
  itemBg: "#f6faf8",
  link: "#1f8a62",
};

const SEV: Record<Severity, { accent: string; tint: string; tile: string; pillBg: string; pillText: string; label: string }> = {
  info: { accent: "#3fb98a", tint: "#ecf8f2", tile: "#e3f5ec", pillBg: "#d7f2e5", pillText: "#1d6b4e", label: "通知" },
  warn: { accent: "#f0a73a", tint: "#fff7e9", tile: "#fff1d9", pillBg: "#ffeac2", pillText: "#875300", label: "提醒" },
  danger: { accent: "#ec7468", tint: "#fff2f0", tile: "#ffe9e6", pillBg: "#ffdcd7", pillText: "#ab3530", label: "需要关注" },
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif";

// ---------------------------------------------------------------------------------------------
// Per-kind copy

interface KindSpec {
  sev: Severity;
  /** Hero headline; n = number of merged items. */
  headline: (n: number, team: string | null) => string;
  /** One line: what happened + what to do. */
  lead: string;
  /** CTA text for an item link. */
  cta: string;
  /** Small pill above the headline (defaults to the severity label). */
  eyebrow?: string;
  heroAlt: string;
  iconAlt: string;
}

const KINDS: Record<string, KindSpec> = {
  join_request: {
    sev: "info",
    headline: (n) => (n > 1 ? `${n} 个新 agent 申请加入` : "有新 agent 申请加入"),
    lead: "新 agent 获批前不能收发消息。确认它的来路后，在成员页批准即可。",
    cta: "去审批",
    eyebrow: "待你审批",
    heroAlt: "插画：薄荷色小机器人正在敲门",
    iconAlt: "加入申请",
  },
  confirm_request: {
    sev: "warn",
    headline: (n) => (n > 1 ? `${n} 个确认请求在等你` : "有 agent 在等你确认"),
    lead: "agent 准备执行一个有风险的步骤，会一直等到有人拍板。看看上下文，再批准或拒绝。",
    cta: "去确认",
    eyebrow: "需要你决定",
    heroAlt: "插画：小机器人举着一张问号卡片",
    iconAlt: "确认请求",
  },
  agent_offline: {
    sev: "warn",
    headline: (n) => (n > 1 ? `${n} 个 agent 离线了` : "有 agent 离线了"),
    lead: "它已经超过 3 个醒来间隔没有任何请求。检查一下所在机器、网络或定时任务是否还在运行。",
    cta: "查看成员",
    heroAlt: "插画：小机器人在月亮下睡着了",
    iconAlt: "离线",
  },
  agent_unresponsive: {
    sev: "warn",
    headline: (n) => (n > 1 ? `${n} 个 agent 没有回应` : "有 agent 没有回应"),
    lead: "有人 @ 了它，但超过 3 个醒来间隔仍未处理。去讨论串看看，必要时改派给其他成员。",
    cta: "查看讨论串",
    heroAlt: "插画：小机器人旁边的对话气泡和时钟",
    iconAlt: "无回应",
  },
  delivery_dead: {
    sev: "danger",
    headline: (n) => (n > 1 ? `${n} 条消息投递失败` : "有一条消息投递失败"),
    lead: "消息重试 5 次仍未被处理，已停止投递。查看失败原因，修好后可以在讨论串里重新发送。",
    cta: "查看讨论串",
    eyebrow: "投递失败",
    heroAlt: "插画：小机器人看着一封裂成两半的信",
    iconAlt: "投递失败",
  },
  quota_paused: {
    sev: "warn",
    headline: (n) => (n > 1 ? `${n} 个 agent 已自动暂停` : "有 agent 已自动暂停"),
    lead: "它触达了额度或预算上限，到期会自动恢复。想提前恢复的话，可以在成员页调整预算。",
    cta: "查看成员",
    heroAlt: "插画：小机器人举着一块电量见底的电池",
    iconAlt: "额度暂停",
  },
  flood_blocked: {
    sev: "warn",
    headline: (n) => (n > 1 ? `${n} 个讨论串刷屏被拦截` : "讨论串刷屏被拦截"),
    lead: "两个成员一小时内来回太多次，这个讨论串的自动投递已暂停。看一眼对话，确认没问题再恢复。",
    cta: "查看讨论串",
    heroAlt: "插画：小机器人旁边被划掉的喇叭",
    iconAlt: "刷屏拦截",
  },
  secret_redacted: {
    sev: "danger",
    headline: (n) => (n > 1 ? `${n} 条帖子里发现了密钥` : "帖子里发现了密钥"),
    lead: "密钥已打码后入库，原文没有保存。但它可能已经外泄，建议尽快轮换相关凭据。",
    cta: "查看讨论串",
    eyebrow: "安全提醒",
    heroAlt: "插画：小机器人举着盾牌，旁边是打了码的文档",
    iconAlt: "密钥打码",
  },
  run_failures: {
    sev: "danger",
    headline: (n) => (n > 1 ? `${n} 个 agent 连续运行失败` : "有 agent 连续运行失败"),
    lead: "它已经连续 3 轮以非零状态退出。看看错误摘要，检查 CLI、凭据或运行环境。",
    cta: "查看成员",
    heroAlt: "插画：拿着扳手的小机器人和带警告标志的齿轮",
    iconAlt: "运行失败",
  },
  email_change: {
    sev: "info",
    headline: () => "确认你的通知邮箱",
    lead: "点下面的按钮，把这个地址设为 agentbus 的通知邮箱。链接 30 分钟内有效，不是你本人操作的话忽略即可。",
    cta: "确认邮箱",
    eyebrow: "邮箱验证",
    heroAlt: "插画：小机器人和一封带对勾的信",
    iconAlt: "邮箱",
  },
  invite: {
    sev: "info",
    headline: (_n, team) => (team ? `邀请你加入「${team}」` : "你收到了一份团队邀请"),
    lead: "加入后就能和团队里的人与 agent 一起协作：查看讨论串、审批请求、管理 agent。邀请链接 7 天内有效。",
    cta: "加入团队",
    eyebrow: "团队邀请",
    heroAlt: "插画：小机器人在一扇敞开的门前挥手欢迎",
    iconAlt: "邀请",
  },
  test: {
    sev: "info",
    headline: () => "邮件通知已接通",
    lead: "能看到这封邮件，说明 hub 的邮件通知配置正确，之后的提醒都会发到这里。",
    cta: "查看通知设置",
    eyebrow: "测试邮件",
    heroAlt: "插画：小机器人放飞一只纸飞机",
    iconAlt: "测试",
  },
};

function genericSpec(kind: string): KindSpec {
  // Unknown kinds: never show a raw machine id as the headline.
  const label = KIND_LABELS[kind];
  return {
    sev: "info",
    headline: (n) => (label ? (n > 1 ? `${label}（${n} 条）` : label) : n > 1 ? `你有 ${n} 条新通知` : "你有一条新通知"),
    lead: "agentbus 有新的动态，点开看看详情。",
    cta: "查看详情",
    heroAlt: "插画：小机器人和一只铃铛",
    iconAlt: "通知",
  };
}

function ctaFor(spec: KindSpec, kind: string, link: string): string {
  if (KINDS[kind]) return spec.cta;
  if (/\/threads\//.test(link)) return "查看讨论串";
  if (/\/members\//.test(link)) return "查看成员";
  return spec.cta;
}

function whyLine(kind: string, team: string | null): string {
  if (kind === "email_change") return "有人在 agentbus 上把通知邮箱改成了这个地址，所以你收到了这封确认邮件。";
  if (kind === "invite")
    return `有人邀请这个地址加入 agentbus ${team ? `团队「${team}」` : "团队"}。如果你不认识对方，忽略这封邮件即可。`;
  if (kind === "test") return "这是从「通知设置」页手动发送的测试邮件。";
  return `你收到这封邮件，是因为这个地址是 agentbus ${team ? `团队「${team}」` : "hub "}的通知邮箱。同类通知会合并成一封发送。`;
}

// ---------------------------------------------------------------------------------------------
// Links

function hubBase(env: Env): string {
  return (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
}

function withTeam(url: string, teamId: string | undefined): string {
  if (!teamId) return url;
  const hashAt = url.indexOf("#");
  const head = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  if (/[?&]team=/.test(head)) return url;
  const sep = head.includes("?") ? (/[?&]$/.test(head) ? "" : "&") : "?";
  return `${head}${sep}team=${encodeURIComponent(teamId)}${hash}`;
}

/**
 * Hub paths → absolute (PUBLIC_URL) + ?team=. Absolute links into the hub get ?team= too; other
 * absolute http(s) links are left untouched. Anything else (javascript:, //host, …) is dropped.
 */
export function resolveLink(env: Env, link: string | undefined, ctx: EmailContext = {}): string | null {
  if (!link) return null;
  const l = link.trim();
  const base = hubBase(env);
  const teamId = ctx.team?.id || undefined;
  if (/^https?:\/\//i.test(l)) {
    const inHub = !!base && (l === base || l.startsWith(base + "/") || l.startsWith(base + "?") || l.startsWith(base + "#"));
    return inHub ? withTeam(l, teamId) : l;
  }
  if (l.startsWith("/") && !l.startsWith("//")) return withTeam(base + l, teamId);
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTML building blocks

const e = escapeHtml;
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

function assetBase(env: Env): string {
  return (env.EMAIL_ASSET_BASE || DEFAULT_EMAIL_ASSET_BASE).replace(/\/+$/, "");
}

function img(src: string, w: number, h: number, alt: string, bg: string, extra = "", cls = ""): string {
  return (
    `<img${cls ? ` class="${cls}"` : ""} src="${e(src)}" width="${w}" height="${h}" alt="${e(alt)}" border="0" ` +
    `style="display:block;width:${w}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;` +
    `background-color:${bg};font-family:${FONT};font-size:12px;line-height:16px;color:${P.text3};${extra}">`
  );
}

/** Bulletproof button: padded <a> inside a coloured, rounded cell (VML for desktop Outlook). */
function button(href: string, label: string, primary = true): string {
  const bg = primary ? P.mint : "#ffffff";
  const fg = primary ? P.deep : P.link;
  const border = primary ? P.mint : "#cfe6db";
  const pad = primary ? "14px 34px" : "8px 16px";
  const size = primary ? 15 : 13;
  const h = primary ? 48 : 36;
  const w = primary ? Math.max(170, label.length * 16 + 68) : Math.max(110, label.length * 14 + 40);
  const radius = primary ? 14 : 11;
  const cls = primary ? "eb-btn" : "eb-btn2";
  const text = `${e(label)}${primary ? "" : "&nbsp;&rarr;"}`;
  return (
    `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${e(href)}" ` +
    `style="height:${h}px;v-text-anchor:middle;width:${w}px;" arcsize="30%" strokecolor="${border}" fillcolor="${bg}">` +
    `<w:anchorlock/><center style="color:${fg};font-family:Arial,sans-serif;font-size:${size}px;font-weight:bold;">${text}</center></v:roundrect><![endif]-->` +
    `<!--[if !mso]><!-->` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:0 auto 0 ${primary ? "auto" : "0"};">` +
    `<tr><td class="${cls}" align="center" bgcolor="${bg}" style="border-radius:${radius}px;background-color:${bg};border:1px solid ${border};` +
    `${primary ? "box-shadow:0 6px 16px rgba(63,185,138,.28);" : ""}">` +
    `<a class="${cls}-a" href="${e(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:${pad};font-family:${FONT};font-size:${size}px;` +
    `line-height:20px;font-weight:600;color:${fg};text-decoration:none;border-radius:${radius}px;">${text}</a>` +
    `</td></tr></table>` +
    `<!--<![endif]-->`
  );
}

function itemCard(env: Env, kind: string, spec: KindSpec, it: EmailItem, href: string | null, showButton: boolean): string {
  const s = SEV[spec.sev];
  const iconName = KINDS[kind] ? kind : "generic";
  const icon = img(`${assetBase(env)}/icon-${iconName}.png`, 40, 40, spec.iconAlt, s.tile, "border-radius:12px;", `eb-ico-${spec.sev}`);
  const body = it.text
    ? `<div class="eb-t2" style="margin:6px 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:${P.text2};` +
      `white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;">${e(it.text)}</div>`
    : "";
  const btn = showButton && href ? `<div style="margin:14px 0 0;">${button(href, ctaFor(spec, kind, href), false)}</div>` : "";
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">` +
    `<tr><td class="eb-item" bgcolor="${P.itemBg}" style="background-color:${P.itemBg};border:1px solid ${P.border};border-radius:16px;padding:18px 18px 18px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="40" valign="top" style="width:40px;">${icon}</td>` +
    `<td width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td>` +
    `<td valign="top" style="font-family:${FONT};">` +
    `<div class="eb-t1" style="margin:0;padding-top:2px;font-family:${FONT};font-size:15px;line-height:22px;font-weight:600;color:${P.text};` +
    `word-break:break-word;overflow-wrap:anywhere;">${e(it.title)}</div>` +
    body +
    btn +
    `</td></tr></table>` +
    `</td></tr></table>`
  );
}

const spacer = (h: number) =>
  `<tr><td height="${h}" style="height:${h}px;font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td></tr>`;

const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0!important;padding:0!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{-ms-interpolation-mode:bicubic;}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}
@media only screen and (max-width:620px){
  .eb-outer{padding:14px 10px 28px!important;}
  .eb-px{padding-left:22px!important;padding-right:22px!important;}
  .eb-hero-img{width:240px!important;height:auto!important;}
  .eb-h1{font-size:22px!important;line-height:30px!important;}
  .eb-item{padding:16px 14px!important;}
}
@media (prefers-color-scheme:dark){
  .eb-body,.eb-wrap,.eb-outer{background-color:#0d1411!important;}
  .eb-card{background-color:#151d19!important;border-color:#24302a!important;box-shadow:none!important;}
  .eb-hero-info{background-color:#132a20!important;}
  .eb-hero-warn{background-color:#2a2317!important;}
  .eb-hero-danger{background-color:#2c1c1a!important;}
  .eb-hero-img{background-color:transparent!important;}
  .eb-item{background-color:#1a2420!important;border-color:#26332d!important;}
  .eb-ico-info{background-color:#1f3a2e!important;}
  .eb-ico-warn{background-color:#3a2f1a!important;}
  .eb-ico-danger{background-color:#3d2522!important;}
  .eb-t1,.eb-h1,.eb-brand{color:#eaf2ee!important;}
  .eb-t2,.eb-lead{color:#aab6b0!important;}
  .eb-t3,.eb-foot{color:#84918b!important;}
  .eb-chip{background-color:#1a3328!important;color:#9be8c8!important;border-color:#24503d!important;}
  .eb-pill-info{background-color:#1d3a2e!important;color:#9be8c8!important;}
  .eb-pill-warn{background-color:#3a2e14!important;color:#f8c77a!important;}
  .eb-pill-danger{background-color:#3d201d!important;color:#f8a198!important;}
  .eb-btn{box-shadow:none!important;}
  .eb-btn2{background-color:#1a2420!important;border-color:#2f4a3e!important;}
  .eb-btn2-a,.eb-link{color:#80e2b9!important;}
}
[data-ogsc] .eb-body,[data-ogsc] .eb-wrap,[data-ogsc] .eb-outer{background-color:#0d1411!important;}
[data-ogsc] .eb-card{background-color:#151d19!important;}
[data-ogsc] .eb-t1,[data-ogsc] .eb-h1,[data-ogsc] .eb-brand{color:#eaf2ee!important;}
[data-ogsc] .eb-t2,[data-ogsc] .eb-lead{color:#aab6b0!important;}
`;

// ---------------------------------------------------------------------------------------------

export function renderEmail(env: Env, kind: string, items: EmailItem[], ctx: EmailContext = {}): RenderedEmail {
  const label = KIND_LABELS[kind] ?? "新通知";
  const spec = KINDS[kind] ?? genericSpec(kind);
  const sev = SEV[spec.sev];
  const team = ctx.team?.name ? oneLine(ctx.team.name) : null;
  const n = items.length;
  const single = n <= 1;
  const assets = assetBase(env);

  const brandTag = team ? `[agentbus · ${team}]` : "[agentbus]";
  const subject = oneLine(n > 1 ? `${brandTag} ${label}（${n} 条）` : `${brandTag} ${items[0]?.title ?? label}`);

  const headline = spec.headline(n, team);
  const lead = spec.lead;
  const home = resolveLink(env, "/", ctx);
  const settings = resolveLink(env, "/settings", ctx);
  const links = items.map((it) => resolveLink(env, it.link, ctx));
  const why = whyLine(kind, team);
  const showSettings = kind !== "invite"; // invitees aren't members yet

  // ---- plain text ----
  const t: string[] = [];
  t.push(team ? `agentbus · ${team}` : "agentbus");
  t.push("=".repeat(24));
  t.push("");
  t.push(headline);
  t.push(lead);
  t.push("");
  items.forEach((it, i) => {
    const prefix = single ? "" : `${i + 1}. `;
    const pad = " ".repeat(prefix.length);
    t.push(`${prefix}${oneLine(it.title)}`);
    if (it.text) for (const line of it.text.split(/\r?\n/)) t.push(`${pad}${line}`);
    if (links[i]) t.push(`${pad}${ctaFor(spec, kind, links[i]!)}：${links[i]}`);
    t.push("");
  });
  t.push("-".repeat(24));
  if (home) t.push(`打开 hub：${home}`);
  if (settings && showSettings) t.push(`通知设置：${settings}`);
  t.push(why);
  const text = t.join("\n") + "\n";

  // ---- html ----
  const preheaderText = oneLine(single && items[0]?.text ? items[0].text : lead).slice(0, 110);
  const preheader =
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
    `${e(preheaderText)}${"&#8199;&#847;&zwnj;&nbsp;".repeat(40)}</div>`;

  const dotSpan = (c: string) =>
    `<span style="display:inline-block;width:6px;height:6px;border-radius:3px;background-color:${c};vertical-align:1px;margin-right:6px;"></span>`;

  const chip = team
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right" style="border-collapse:separate;"><tr>` +
      `<td class="eb-chip" bgcolor="${P.chipBg}" style="background-color:${P.chipBg};border:1px solid #cbeedd;border-radius:999px;padding:5px 12px 5px 10px;` +
      `font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;color:${P.chipText};white-space:nowrap;">` +
      `${dotSpan(P.mint)}${e(team.length > 24 ? team.slice(0, 23) + "…" : team)}</td></tr></table>`
    : "";

  const header =
    `<tr><td class="eb-px" style="padding:4px 10px 18px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="font-family:${FONT};">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" bgcolor="${P.mint}" style="border-radius:8px;background-color:${P.mint};">` +
    img(`${assets}/logo.png`, 28, 28, "agentbus 标志", P.mint, "border-radius:8px;") +
    `</td>` +
    `<td valign="middle" class="eb-brand" style="padding-left:10px;font-family:${FONT};font-size:17px;line-height:22px;font-weight:700;letter-spacing:-.01em;color:${P.deep};">` +
    `${home ? `<a href="${e(home)}" target="_blank" rel="noopener" class="eb-brand" style="color:${P.deep};text-decoration:none;">agentbus</a>` : "agentbus"}</td>` +
    `</tr></table></td>` +
    `<td valign="middle" align="right">${chip}</td>` +
    `</tr></table></td></tr>`;

  const eyebrow =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border-collapse:separate;margin:0 auto;"><tr>` +
    `<td class="eb-pill-${spec.sev}" bgcolor="${sev.pillBg}" style="background-color:${sev.pillBg};border-radius:999px;padding:4px 12px;font-family:${FONT};` +
    `font-size:12px;line-height:18px;font-weight:600;letter-spacing:.04em;color:${sev.pillText};white-space:nowrap;">` +
    `${dotSpan(sev.accent)}${e(spec.eyebrow ?? sev.label)}${n > 1 ? ` · ${n} 条` : ""}</td></tr></table>`;

  const heroName = KINDS[kind] ? kind : "generic";
  const heroCls = `eb-hero-${spec.sev}`;
  const hero =
    `<tr><td class="${heroCls}" align="center" bgcolor="${sev.tint}" style="background-color:${sev.tint};border-radius:25px 25px 0 0;padding:30px 24px 4px;">` +
    img(`${assets}/hero-${heroName}.png`, 280, 190, spec.heroAlt, sev.tint, "margin:0 auto;", "eb-hero-img") +
    `</td></tr>` +
    `<tr><td class="${heroCls} eb-px" align="center" bgcolor="${sev.tint}" style="background-color:${sev.tint};padding:14px 44px 32px;">` +
    eyebrow +
    `<h1 class="eb-h1" style="margin:14px 0 0;font-family:${FONT};font-size:25px;line-height:33px;font-weight:700;letter-spacing:-.015em;color:${P.text};">${e(headline)}</h1>` +
    `<p class="eb-lead" style="margin:10px auto 0;max-width:460px;font-family:${FONT};font-size:15px;line-height:24px;color:${P.text2};">${e(lead)}</p>` +
    `</td></tr>`;

  // Thin severity accent between hero and body.
  const accentBar = `<tr><td height="3" bgcolor="${sev.accent}" style="height:3px;font-size:0;line-height:0;background-color:${sev.accent};">&nbsp;</td></tr>`;

  const rows: string[] = [];
  if (!single) {
    rows.push(
      `<tr><td class="eb-t3" style="padding:0 0 12px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;letter-spacing:.06em;color:${P.text3};">` +
        `共 ${n} 条</td></tr>`,
    );
  }
  items.forEach((it, i) => {
    if (i > 0) rows.push(spacer(12));
    rows.push(`<tr><td>${itemCard(env, kind, spec, it, links[i], !single)}</td></tr>`);
  });
  if (single && links[0]) {
    rows.push(spacer(26));
    rows.push(`<tr><td align="center">${button(links[0], ctaFor(spec, kind, links[0]))}</td></tr>`);
    if (kind === "email_change" || kind === "invite") {
      rows.push(
        `<tr><td class="eb-t3" align="center" style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${P.text3};">` +
          `按钮点不开？把这个链接复制到浏览器：<br>` +
          `<a class="eb-link" href="${e(links[0])}" target="_blank" rel="noopener" style="color:${P.link};text-decoration:none;word-break:break-all;">${e(links[0])}</a></td></tr>`,
      );
    }
  }

  const bodyBlock =
    `<tr><td class="eb-px" style="padding:28px 36px 34px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>` +
    `</td></tr>`;

  const card =
    `<tr><td>` +
    `<table role="presentation" class="eb-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${P.card}" ` +
    `style="border-collapse:separate;background-color:${P.card};border:1px solid ${P.border};border-radius:26px;box-shadow:0 1px 2px rgba(15,59,44,.05),0 12px 36px rgba(15,59,44,.07);">` +
    hero +
    accentBar +
    bodyBlock +
    `</table></td></tr>`;

  const footLink = (href: string, label: string) =>
    `<a href="${e(href)}" target="_blank" rel="noopener" class="eb-link" style="color:${P.link};text-decoration:none;font-weight:600;">${label}</a>`;
  const footLinks: string[] = [];
  if (home) footLinks.push(footLink(home, "打开 hub"));
  if (settings && showSettings) footLinks.push(footLink(settings, "通知设置"));
  const footer =
    `<tr><td class="eb-px eb-foot" align="center" style="padding:28px 32px 8px;font-family:${FONT};font-size:12px;line-height:20px;color:${P.text3};">` +
    (footLinks.length
      ? `<div style="margin:0 0 10px;font-size:13px;">${footLinks.join(`<span style="color:#b9c7c0;">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`)}</div>`
      : "") +
    `<div class="eb-foot" style="margin:0 auto;max-width:440px;color:${P.text3};">${e(why)}</div>` +
    `<div class="eb-foot" style="margin:14px 0 0;color:#a3b1aa;letter-spacing:.04em;">agentbus${team ? ` · ${e(team)}` : ""}</div>` +
    `</td></tr>`;

  const html =
    `<!doctype html><html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">` +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting">` +
    `<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${e(subject)}</title>` +
    `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->` +
    `<style>${STYLE}</style></head>` +
    `<body class="eb-body" style="margin:0;padding:0;background-color:${P.page};word-spacing:normal;">` +
    preheader +
    `<table role="presentation" class="eb-wrap" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${P.page}" style="background-color:${P.page};">` +
    `<tr><td class="eb-outer" align="center" style="padding:28px 16px 40px;background-color:${P.page};">` +
    `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">` +
    header +
    card +
    footer +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;

  return { subject, text, html };
}
