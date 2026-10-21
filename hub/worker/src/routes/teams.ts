// Teams, invites and join codes — hub-api.md §0.1 / §6. Mounted inside `web`.
import { Hono } from "hono";
import type { AppEnv, Env, Me } from "../env";
import { DB, memberOut, type Row } from "../db";
import { isAdmin } from "../core";
import { humanMemberStmts } from "../auth";
import { loadMember } from "../members";
import { flushNotifications, notify } from "../notify";
import { HttpError, bad, conflict, forbidden, maskEmail, newId, notFound, secretToken, sha256Hex } from "../util";

type Body = Record<string, unknown>;
const body = (c: { get: (k: "body") => unknown }) => {
  const b = c.get("body");
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Body;
};
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const MAX_OWNED_TEAMS = 5;
const INVITE_TTL_MS = 7 * 86400_000;
const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export const teams = new Hono<AppEnv>();

// ---------------------------------------------------------------- helpers

export function teamOut(r: Row) {
  return { id: r.id as string, name: r.name as string, owner_id: r.owner_id as string, created_at: Number(r.created_at) };
}

function inviteOut(r: Row) {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: r.id as string,
    email: (r.email as string) ?? null,
    role: (r.role as string) ?? "admin",
    created_by: (r.created_by as string) ?? null,
    created_at: Number(r.created_at),
    expires_at: Number(r.expires_at),
    accepted_by: (r.accepted_by as string) ?? null,
    accepted_at: n(r.accepted_at),
    revoked_at: n(r.revoked_at),
  };
}

function joinCodeOut(r: Row) {
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: r.id as string,
    label: (r.label as string) ?? "",
    prefix: r.prefix as string,
    created_by: (r.created_by as string) ?? null,
    created_at: Number(r.created_at),
    expires_at: n(r.expires_at),
    revoked_at: n(r.revoked_at),
    uses: Number(r.uses ?? 0),
    last_used_at: n(r.last_used_at),
  };
}

function teamName(v: unknown): string {
  const name = str(v, 64);
  if (!name) throw bad("团队名不能为空（最多 64 个字符）");
  return name;
}

function requireAdmin(me: Me) {
  if (!isAdmin(me)) throw forbidden("只有团队管理员能做这个操作");
}

function requireOwner(me: Me) {
  if (me.kind !== "human" || me.role !== "owner") throw forbidden("只有团队 owner 能做这个操作");
}

async function ownedTeams(db: DB, email: string): Promise<number> {
  const r = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM members m JOIN teams t ON t.id = m.team_id AND t.owner_id = m.id
     WHERE m.email = ? AND m.kind = 'human' AND m.status <> 'revoked'`,
    email,
  );
  return Number(r?.n ?? 0);
}

function canSignup(env: Env, me: Me): boolean {
  return (env.SIGNUP ?? "invite").trim().toLowerCase() === "open" || !!me.platform_admin;
}

/** GET /web/me (hub-api.md §6). */
export async function meOut(env: Env, me: Me) {
  const root = new DB(env.DB);
  const email = me.email ?? "";
  const refs = await root.all<{ id: string; name: string; role: string }>(
    `SELECT t.id, t.name, m.role FROM members m JOIN teams t ON t.id = m.team_id
     WHERE m.email = ? AND m.kind = 'human' AND m.status <> 'revoked' ORDER BY m.created_at, m.id`,
    email,
  );
  let team: ReturnType<typeof teamOut> | null = null;
  let member: ReturnType<typeof memberOut> | null = null;
  if (me.team_id) {
    const t = await root.first("SELECT * FROM teams WHERE id = ?", me.team_id);
    team = t ? teamOut(t) : null;
    member = memberOut(await loadMember(root.forTeam(me.team_id), me.id));
  }
  const owned = await ownedTeams(root, email);
  return {
    identity: { email, platform_admin: !!me.platform_admin },
    team,
    member,
    role: member ? me.role : null,
    teams: refs.map((r) => ({ id: r.id, name: r.name, role: r.role })),
    can_create_team: canSignup(env, me) && owned < MAX_OWNED_TEAMS,
  };
}

// ---------------------------------------------------------------- teams

teams.post("/teams", async (c) => {
  const me = c.get("me");
  const email = me.email ?? "";
  if (!email) throw forbidden();
  if (!canSignup(c.env, me)) throw forbidden("只有平台管理员能新建团队；请让团队管理员给你发邀请链接");
  const name = teamName(body(c).name);
  const root = new DB(c.env.DB);
  if ((await ownedTeams(root, email)) >= MAX_OWNED_TEAMS) throw conflict(`每人最多拥有 ${MAX_OWNED_TEAMS} 个团队`);
  const now = Date.now();
  const id = newId("o", now);
  const db = root.forTeam(id);
  const m = await humanMemberStmts(db, id, email, "owner", now);
  const settings: [string, string][] = [
    ["notify_email", email],
    ["notify_kinds", "{}"],
    ["global_pause", "0"],
    ["default_pause_pct", "100"],
    ["merge_window_min", "15"],
  ];
  await db.batch([
    db.stmt("INSERT INTO teams (id, name, owner_id, change_seq, created_at) VALUES (?, ?, ?, 1, ?)", id, name, m.id, now),
    m.stmt,
    ...settings.map(([k, v]) => db.stmt("INSERT INTO team_settings (team_id, key, value) VALUES (?, ?, ?)", id, k, v)),
    db.audit(m.id, "team.create", id, { name }),
  ]);
  return c.json({ team: teamOut((await db.first("SELECT * FROM teams WHERE id = ?", id))!) });
});

teams.patch("/team", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const name = teamName(body(c).name);
  const db = new DB(c.env.DB, me.team_id);
  await db.batch([
    db.stmt("UPDATE teams SET name = ? WHERE id = ?", name, db.team),
    db.audit(me.id, "team.rename", db.team, { name }),
    db.bumpSeq(),
  ]);
  return c.json({ team: teamOut((await db.first("SELECT * FROM teams WHERE id = ?", db.team))!) });
});

teams.post("/team/transfer", async (c) => {
  const me = c.get("me");
  requireOwner(me);
  const db = new DB(c.env.DB, me.team_id);
  const id = str(body(c).member_id, 40);
  const t = await db.first<{ id: string; kind: string; status: string; email: string | null }>(
    "SELECT id, kind, status, email FROM members WHERE id = ? AND team_id = ?",
    id,
    db.team,
  );
  if (!t) throw notFound("成员");
  if (t.id === me.id) throw bad("你已经是 owner 了");
  if (t.kind !== "human" || t.status !== "active") throw bad("只能移交给本团队里的活跃人类成员");
  if (t.email && (await ownedTeams(db, t.email)) >= MAX_OWNED_TEAMS) throw conflict(`对方已经拥有 ${MAX_OWNED_TEAMS} 个团队`);
  await db.batch([
    db.stmt("UPDATE members SET role = 'owner' WHERE id = ?", t.id),
    db.stmt("UPDATE members SET role = 'admin' WHERE id = ?", me.id),
    db.stmt("UPDATE teams SET owner_id = ? WHERE id = ?", t.id, db.team),
    db.audit(me.id, "team.transfer", t.id),
    db.bumpSeq(),
  ]);
  return c.json({ team: teamOut((await db.first("SELECT * FROM teams WHERE id = ?", db.team))!) });
});

teams.post("/team/leave", async (c) => {
  const me = c.get("me");
  if (me.kind !== "human") throw forbidden();
  if (me.role === "owner") throw forbidden("owner 不能直接退出：请先把团队移交给别人，或删除团队");
  const db = new DB(c.env.DB, me.team_id);
  await db.batch([
    db.stmt("UPDATE members SET status = 'revoked' WHERE id = ? AND team_id = ?", me.id, db.team),
    db.audit(me.id, "team.leave", me.id),
    db.bumpSeq(),
  ]);
  return c.json({ ok: true });
});

/** Every statement deleting all of a team's rows, children first. */
export function deleteTeamStmts(db: DB, teamId: string): D1PreparedStatement[] {
  const members = "SELECT id FROM members WHERE team_id = ?";
  const stmts = [
    db.stmt("DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE team_id = ?)", teamId),
    db.stmt("DELETE FROM thread_members WHERE thread_id IN (SELECT id FROM threads WHERE team_id = ?)", teamId),
    db.stmt(
      `DELETE FROM manager_scopes WHERE manager_id IN (${members}) OR workspace_id IN (SELECT id FROM workspaces WHERE team_id = ?)`,
      teamId,
      teamId,
    ),
  ];
  for (const t of ["member_keys", "triggers", "quota_readings", "quota_rules", "budgets", "nonces"]) {
    stmts.push(db.stmt(`DELETE FROM ${t} WHERE member_id IN (${members})`, teamId));
  }
  for (const t of [
    "deliveries",
    "confirmations",
    "posts",
    "threads",
    "workspaces",
    "runs",
    "notifications",
    "audit_log",
    "email_changes",
    "join_codes",
    "invites",
    "team_settings",
    "members",
  ]) {
    stmts.push(db.stmt(`DELETE FROM ${t} WHERE team_id = ?`, teamId));
  }
  stmts.push(db.stmt("DELETE FROM teams WHERE id = ?", teamId));
  return stmts;
}

teams.delete("/team", async (c) => {
  const me = c.get("me");
  requireOwner(me);
  const root = new DB(c.env.DB);
  const t = await root.first<{ id: string; name: string }>("SELECT id, name FROM teams WHERE id = ?", me.team_id);
  if (!t) throw notFound("团队");
  if (str(body(c).confirm, 100) !== t.name) throw bad("请输入团队名确认删除");
  await root.batch([...deleteTeamStmts(root, t.id), root.audit(null, "team.delete", t.id, { name: t.name, by: maskEmail(me.email) })]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- invites

teams.get("/invites", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const db = new DB(c.env.DB, me.team_id);
  const rows = await db.all("SELECT * FROM invites WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT 200", db.team);
  return c.json({ invites: rows.map(inviteOut) });
});

teams.post("/invites", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const db = new DB(c.env.DB, me.team_id);
  const b = body(c);
  const email = str(b.email, 254).toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw bad("邮箱格式不对");
  const pending = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM invites WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    db.team,
    Date.now(),
  );
  if (Number(pending?.n ?? 0) >= 50) throw conflict("未使用的邀请太多了，请先作废一些");
  const team = (await db.first<{ name: string }>("SELECT name FROM teams WHERE id = ?", db.team))!;
  const token = secretToken("abi_");
  const now = Date.now();
  const id = newId("i", now);
  const base = (c.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
  const url = `${base}/invite/${token}`;
  const stmts = [
    db.stmt(
      "INSERT INTO invites (id, team_id, token_hash, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)",
      id,
      db.team,
      await sha256Hex(token),
      email,
      me.id,
      now,
      now + INVITE_TTL_MS,
    ),
    db.audit(me.id, "invite.create", id, email ? { email: maskEmail(email) } : null),
    db.bumpSeq(),
  ];
  if (email) {
    stmts.push(
      notify(db, "invite", {
        title: `${me.name} 邀请你加入 agentbus 团队「${team.name}」`,
        text: "点下面的链接接受邀请。链接 7 天内有效，只能使用一次。",
        link: url,
        to: email,
      }),
    );
  }
  await db.batch(stmts);
  let email_error: string | null = null;
  if (email) {
    await flushNotifications(c.env, { force: true, team: db.team ?? undefined, kind: "invite" });
    const row = await db.first<{ error: string | null }>(
      "SELECT error FROM notifications WHERE team_id = ? AND kind = 'invite' ORDER BY created_at DESC, id DESC LIMIT 1",
      db.team,
    );
    email_error = row?.error ?? null;
    // Don't keep the invite token around in the outbox.
    await db.run(
      "UPDATE notifications SET payload = json_object('title', json_extract(payload, '$.title')) WHERE team_id = ? AND kind = 'invite' AND sent_at IS NOT NULL",
      db.team,
    );
  }
  const row = (await db.first("SELECT * FROM invites WHERE id = ?", id))!;
  return c.json({ invite: inviteOut(row), url, ...(email ? { email_error } : {}) });
});

teams.delete("/invites/:id", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const db = new DB(c.env.DB, me.team_id);
  const id = c.req.param("id");
  const row = await db.first<{ id: string }>("SELECT id FROM invites WHERE id = ? AND team_id = ?", id, db.team);
  if (!row) throw notFound("邀请");
  await db.batch([
    db.stmt("UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", Date.now(), id),
    db.audit(me.id, "invite.revoke", id),
    db.bumpSeq(),
  ]);
  return c.json({ invite: inviteOut((await db.first("SELECT * FROM invites WHERE id = ?", id))!) });
});

interface InviteRow {
  id: string;
  team_id: string;
  created_by: string | null;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}

async function findInvite(db: DB, token: string) {
  if (!/^abi_[0-9a-z]{26}$/.test(token)) return null;
  const inv = await db.first<InviteRow>(
    "SELECT id, team_id, created_by, expires_at, accepted_at, revoked_at FROM invites WHERE token_hash = ?",
    await sha256Hex(token),
  );
  if (!inv) return null;
  const team = await db.first<{ id: string; name: string }>("SELECT id, name FROM teams WHERE id = ?", inv.team_id);
  if (!team) return null;
  const valid = inv.accepted_at == null && inv.revoked_at == null && inv.expires_at > Date.now();
  return { inv, team, valid };
}

teams.get("/invites/preview", async (c) => {
  const me = c.get("me");
  const db = new DB(c.env.DB);
  const found = await findInvite(db, c.req.query("token") ?? "");
  if (!found) throw notFound("邀请");
  const { inv, team, valid } = found;
  const inviter = inv.created_by
    ? await db.first<{ name: string; display_name: string }>("SELECT name, display_name FROM members WHERE id = ?", inv.created_by)
    : null;
  const mine = await db.first(
    "SELECT 1 FROM members WHERE team_id = ? AND email = ? AND kind = 'human' AND status <> 'revoked'",
    team.id,
    me.email ?? "",
  );
  return c.json({
    team: { id: team.id, name: team.name },
    inviter: inviter ? { name: inviter.name, display_name: inviter.display_name } : null,
    expires_at: Number(inv.expires_at),
    valid,
    already_member: !!mine,
  });
});

teams.post("/invites/accept", async (c) => {
  const me = c.get("me");
  const email = me.email ?? "";
  if (!email) throw forbidden();
  const root = new DB(c.env.DB);
  const found = await findInvite(root, str(body(c).token, 100));
  if (!found) throw notFound("邀请");
  const { inv, team } = found;
  const db = root.forTeam(team.id);
  const existing = await db.first<{ id: string; status: string }>(
    "SELECT id, status FROM members WHERE team_id = ? AND email = ? AND kind = 'human'",
    team.id,
    email,
  );
  if (existing && existing.status !== "revoked") return c.json({ team: { id: team.id, name: team.name }, already_member: true });
  if (!found.valid) throw new HttpError(410, "invite_invalid", "邀请已过期、已被使用或已作废，请向团队管理员要新的邀请链接");
  const now = Date.now();
  let memberId: string;
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    // Rejoining after leaving or being removed: reuse the row (email is unique per team).
    memberId = existing.id;
    stmts.push(db.stmt("UPDATE members SET status = 'active', role = 'admin' WHERE id = ?", existing.id));
  } else {
    const m = await humanMemberStmts(db, team.id, email, "admin", now);
    memberId = m.id;
    stmts.push(m.stmt);
  }
  // Single use: the guarded UPDATE runs first so a concurrent accept can't reuse the token.
  const res = await db.batch([
    db.stmt("UPDATE invites SET accepted_by = ?, accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
      memberId,
      now,
      inv.id,
      now,
    ),
  ]);
  if (!res[0]?.meta?.changes) throw new HttpError(410, "invite_invalid", "邀请已过期、已被使用或已作废，请向团队管理员要新的邀请链接");
  await db.batch([...stmts, db.audit(memberId, "invite.accept", inv.id), db.bumpSeq()]);
  return c.json({ team: { id: team.id, name: team.name } });
});

// ---------------------------------------------------------------- join codes

teams.get("/join-codes", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const db = new DB(c.env.DB, me.team_id);
  const rows = await db.all("SELECT * FROM join_codes WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT 200", db.team);
  return c.json({ codes: rows.map(joinCodeOut) });
});

teams.post("/join-codes", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const db = new DB(c.env.DB, me.team_id);
  const b = body(c);
  const label = str(b.label, 64);
  let expires: number | null = null;
  if (b.expires_in_days != null) {
    const d = Number(b.expires_in_days);
    if (!Number.isFinite(d) || d <= 0 || d > 365) throw bad("expires_in_days 必须在 1..365 之间");
    expires = Date.now() + Math.round(d * 86400_000);
  }
  const active = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM join_codes WHERE team_id = ? AND revoked_at IS NULL", db.team);
  if (Number(active?.n ?? 0) >= 50) throw conflict("有效的加入码太多了，请先作废一些");
  const secret = secretToken("abj_");
  const now = Date.now();
  const id = newId("j", now);
  await db.batch([
    db.stmt(
      "INSERT INTO join_codes (id, team_id, label, code_hash, prefix, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      db.team,
      label,
      await sha256Hex(secret),
      secret.slice(0, 8),
      me.id,
      now,
      expires,
    ),
    db.audit(me.id, "join_code.create", id, { label }),
    db.bumpSeq(),
  ]);
  return c.json({ code: joinCodeOut((await db.first("SELECT * FROM join_codes WHERE id = ?", id))!), secret });
});

teams.delete("/join-codes/:id", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const db = new DB(c.env.DB, me.team_id);
  const id = c.req.param("id");
  if (!(await db.first("SELECT 1 FROM join_codes WHERE id = ? AND team_id = ?", id, db.team))) throw notFound("加入码");
  await db.batch([
    db.stmt("UPDATE join_codes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", Date.now(), id),
    db.audit(me.id, "join_code.revoke", id),
    db.bumpSeq(),
  ]);
  return c.json({ code: joinCodeOut((await db.first("SELECT * FROM join_codes WHERE id = ?", id))!) });
});
