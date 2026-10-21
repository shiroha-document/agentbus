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
  owner: "所有者",
  admin: "管理员",
  manager: "Manager",
  agent: "Agent",
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
  pending: "待接受",
  accepted: "已接受",
  revoked: "已作废",
  expired: "已过期",
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
export const ONBOARDING_URL = "https://github.com/shiroha-document/agentbus/blob/main/docs/ONBOARDING.md";

function hubOf(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** Shell lines shown once after creating a join code (manual, two steps). */
export function joinSnippet(origin: string, secret: string): string {
  return `${INSTALL_LINE}\nagentbus setup --hub ${hubOf(origin)} --join-code ${secret}`;
}

/** macOS / Linux: install + join in one line (install.sh runs `agentbus setup --yes`). */
export function unixOneLiner(origin: string, secret: string): string {
  return `${INSTALL_LINE} -s -- --hub ${hubOf(origin)} --join-code ${secret}`;
}

/** Windows PowerShell: install + join in one line (install.ps1 reads the env vars). */
export function windowsOneLiner(origin: string, secret: string): string {
  return `$env:AGENTBUS_HUB='${hubOf(origin)}'; $env:AGENTBUS_JOIN_CODE='${secret}'; ${INSTALL_PS1}`;
}

/**
 * A prompt to paste into Claude Code / Codex / Cursor / Gemini on the target
 * machine: the coding agent installs agentbus and joins the team by itself.
 */
export function agentPrompt(origin: string, secret: string, team?: string): string {
  const hub = hubOf(origin);
  const where = team ? `agentbus hub（${hub}）的「${team}」团队` : `agentbus hub（${hub}）`;
  return [
    `请帮我把这台机器作为 agent 接入${where}。`,
    "",
    "1. 安装 agentbus 并加入团队（只需一条命令）：",
    `   - macOS / Linux：${unixOneLiner(hub, secret)}`,
    `   - Windows PowerShell：${windowsOneLiner(hub, secret)}`,
    "2. 如果报错，先运行 `agentbus doctor` 看哪一项失败，按提示修好后重新运行 `agentbus setup`；需要时参考接入文档：" +
      ONBOARDING_URL,
    "3. 完成后告诉我 agent 的名字、所在团队和状态（pending 表示等待管理员在网页上批准，这是正常的）。",
    "",
    "注意：加入码只用于首次加入，不要把它写进仓库或日志。",
  ].join("\n");
}

/** Delete-team confirmation: exact name, ignoring surrounding whitespace. */
export function deleteConfirmMatches(teamName: string, input: string): boolean {
  return teamName.length > 0 && input.trim() === teamName.trim();
}
