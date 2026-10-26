import { t as tr, docsUrl, getLanguage, type Language } from "./i18n";
// Current-team plumbing (hub-api.md §0.1, §6) and small team/role helpers.
// Everything here is pure or takes an injected storage so it can be unit-tested in node.

import type { Invite, MemberRole } from "../types";

export const TEAM_KEY = "agentbus.team";
export const TEAM_HEADER = "X-Agentbus-Team";
export const TEAM_PARAM = "team";

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage disabled (privacy mode)
  }
}

/** Team ids are `o_` + lowercase base32; be lenient on length, strict on charset. */
export function isTeamId(v: unknown): v is string {
  return typeof v === "string" && /^o_[a-z0-9]{1,64}$/.test(v);
}

export function getStoredTeam(storage: KV | null = browserStorage()): string | null {
  try {
    const v = storage?.getItem(TEAM_KEY) ?? null;
    return isTeamId(v) ? v : null;
  } catch {
    return null;
  }
}

export function setStoredTeam(id: string | null, storage: KV | null = browserStorage()): void {
  try {
    if (id && isTeamId(id)) storage?.setItem(TEAM_KEY, id);
    else storage?.removeItem(TEAM_KEY);
  } catch {
    /* ignore */
  }
}

export function clearStoredTeam(storage: KV | null = browserStorage()): void {
  setStoredTeam(null, storage);
}

/** Request headers for the selected team; empty when none (server then uses the earliest joined team). */
export function teamHeaders(id: string | null): Record<string, string> {
  return id && isTeamId(id) ? { [TEAM_HEADER]: id } : {};
}

/**
 * Reads `?team=` from a URL. Returns the team id (if valid) and the URL with the
 * param removed (relative: path + search + hash), or `cleaned: null` when the URL
 * had no `team` param and needs no rewrite.
 */
export function consumeTeamParam(href: string): { team: string | null; cleaned: string | null } {
  const url = new URL(href, "https://x.invalid");
  if (!url.searchParams.has(TEAM_PARAM)) return { team: null, cleaned: null };
  const raw = url.searchParams.get(TEAM_PARAM);
  url.searchParams.delete(TEAM_PARAM);
  const search = url.searchParams.toString();
  return { team: isTeamId(raw) ? raw : null, cleaned: url.pathname + (search ? `?${search}` : "") + url.hash };
}

/** Boot-time: apply `?team=` to storage and strip it from the address bar. */
export function applyTeamParamFromLocation(
  loc: { href: string } = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
  storage: KV | null = browserStorage(),
): string | null {
  const { team, cleaned } = consumeTeamParam(loc.href);
  if (cleaned === null) return null;
  if (team) setStoredTeam(team, storage);
  history.replaceState(history.state, "", cleaned);
  return team;
}

// ---------------------------------------------------------------- roles

export const ROLE_LABEL: Record<MemberRole, string> = {
  get owner() { return tr("所有者"); },
  get admin() { return tr("管理员"); },
  get manager() { return tr("role.manager"); },
  get agent() { return tr("role.agent"); },
};

export function roleLabel(role: string | null | undefined): string {
  return role ? (ROLE_LABEL[role as MemberRole] ?? role) : "";
}

/** "管理员" in the contract = owner or admin. */
export function isAdminRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === "owner";
}

/** Initial for a team tile: first CJK char, or up to two Latin word initials ("Shiroha Lab" → "SL"). */
export function teamInitial(name: string): string {
  const src = name.trim();
  if (!src) return "?";
  const first = Array.from(src)[0]!;
  if (!/[A-Za-z0-9]/.test(first)) return first;
  const words = src.split(/[\s_\-.]+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!)
    .filter((c) => /[A-Za-z0-9]/.test(c));
  return (letters.join("") || first).toUpperCase();
}

// ---------------------------------------------------------------- invites & join codes

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export function inviteStatus(inv: Pick<Invite, "accepted_at" | "revoked_at" | "expires_at">, now = Date.now()): InviteStatus {
  if (inv.accepted_at) return "accepted";
  if (inv.revoked_at) return "revoked";
  if (inv.expires_at <= now) return "expired";
  return "pending";
}

export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = {
  get pending() { return tr("待接受"); },
  get accepted() { return tr("已接受"); },
  get revoked() { return tr("已作废"); },
  get expired() { return tr("已过期"); },
};

export type JoinCodeStatus = "active" | "revoked" | "expired";

export function joinCodeStatus(c: { revoked_at: number | null; expires_at: number | null }, now = Date.now()): JoinCodeStatus {
  if (c.revoked_at) return "revoked";
  if (c.expires_at !== null && c.expires_at <= now) return "expired";
  return "active";
}

const RAW = "https://raw.githubusercontent.com/shiroha-document/agentbus/main";
export const INSTALL_LINE = `curl -fsSL ${RAW}/install.sh | sh`;
export const INSTALL_PS1 = `irm ${RAW}/install.ps1 | iex`;
export const onboardingUrl = (language = getLanguage()) => docsUrl("guide/onboarding", language);

function hubOf(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Shell lines shown once after creating a join code (manual, two steps). */
export function joinSnippet(origin: string, secret: string, language: Language = getLanguage()): string {
  return `${INSTALL_LINE.replace("| sh", `| AGENTBUS_LANG=${language} sh`)} -s -- --no-setup\nagentbus --lang ${language} setup --hub ${hubOf(origin)} --join-code ${secret}`;
}

/** macOS / Linux: install + join in one line (install.sh runs `agentbus setup --yes`). */
export function unixOneLiner(origin: string, secret: string, language: Language = getLanguage()): string {
  return `${INSTALL_LINE.replace("| sh", `| AGENTBUS_LANG=${language} sh`)} -s -- --lang ${language} --hub ${hubOf(origin)} --join-code ${secret}`;
}

/** Windows PowerShell: install + join in one line (install.ps1 reads the env vars). */
export function windowsOneLiner(origin: string, secret: string, language: Language = getLanguage()): string {
  return `$env:AGENTBUS_LANG='${language}'; $env:AGENTBUS_HUB='${hubOf(origin)}'; $env:AGENTBUS_JOIN_CODE='${secret}'; ${INSTALL_PS1}`;
}

/** CLI names `--cli` accepts for coding agents tick can start. */
export const SPAWNABLE_CLIS = ["claude", "codex", "cursor", "gemini", "traecli", "dsh"] as const;

/** macOS / Linux one-liner pinned to one CLI (e.g. "manual" for a self-driven agent). */
export function unixOneLinerFor(origin: string, secret: string, cli: string, language: Language = getLanguage()): string {
  return `${unixOneLiner(origin, secret, language)} --cli ${cli}`;
}

/** Windows one-liner pinned to one CLI. */
export function windowsOneLinerFor(origin: string, secret: string, cli: string, language: Language = getLanguage()): string {
  return `$env:AGENTBUS_CLI='${cli}'; ${windowsOneLiner(origin, secret, language)}`;
}

/**
 * A prompt to paste into the coding agent on the target machine (Claude Code,
 * Codex, Cursor, Gemini CLI, TRAE CLI, DeepSeek Harness — or a self-driven
 * agent such as OpenAI dot that can only wake itself with a scheduled task):
 * the agent installs agentbus and joins the team by itself.
 */
export function agentPrompt(origin: string, secret: string, team?: string, language: Language = getLanguage()): string {
  const hub = hubOf(origin);
  const where = team ? tr("agentbus hub（{0}）的「{1}」团队", [hub, team], language) : tr("install.hub", [hub], language);
  return [
    tr("请帮我把这台机器（或者你自己）作为 agent 接入{0}。先判断你属于哪一种：", [where], language),
    "",
    tr("A. 你是能被命令行启动的编程 CLI（Claude Code、Codex、Cursor、Gemini CLI、TRAE CLI、DeepSeek Harness）：", [], language),
    tr("install.cli-step", [SPAWNABLE_CLIS.join(" / ")], language),
    `      - macOS / Linux: ${unixOneLinerFor(hub, secret, "claude", language)}`,
    `      - Windows PowerShell: ${windowsOneLinerFor(hub, secret, "claude", language)}`,
    tr("   2. 之后 agentbus 会用定时任务自动唤醒你处理消息，不用你再做什么。", [], language),
    "",
    tr("B. 你不能被命令行启动，只能靠自己的定时任务唤醒自己、手动执行命令（例如 OpenAI dot、托管型 agent）：", [], language),
    tr("   1. 用自驱模式安装并加入团队：", [], language),
    `      - macOS / Linux: ${unixOneLinerFor(hub, secret, "manual", language)}`,
    `      - Windows PowerShell: ${windowsOneLinerFor(hub, secret, "manual", language)}`,
    tr("   2. 在你自己的 harness 里建一个定时任务（建议每 5–15 分钟一次），每次唤醒时运行 `agentbus inbox`：", [], language),
    tr("      - 输出「没有新消息」/ 退出码 3：本次结束，等下一次唤醒；", [], language),
    tr("      - 输出了讨论串：按里面的提示词处理，用 `agentbus post --thread <讨论串> --body …` 回复，最后运行 `agentbus ack --thread <讨论串>`；", [], language),
    tr("      - 处理超过 10 分钟先运行 `agentbus heartbeat --thread <讨论串>` 续租；做不了就 `agentbus release --thread <讨论串> --reason …` 退回。", [], language),
    "",
    tr("两种方式都适用：", [], language),
    tr("install.troubleshoot", [onboardingUrl(language)], language),
    tr("- 完成后告诉我 agent 的名字、所在团队和状态（pending 表示等待管理员在网页上批准，这是正常的）。", [], language),
    tr("- 加入码只用于首次加入，不要把它写进仓库或日志。", [], language),
  ].join("\n");
}

/** Delete-team confirmation: exact name, ignoring surrounding whitespace. */
export function deleteConfirmMatches(teamName: string, input: string): boolean {
  return teamName.length > 0 && input.trim() === teamName.trim();
}
