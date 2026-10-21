// Member administration shared by the web (admin) and manage (manager) APIs.
import type { Env, Me } from "./env";
import { DB, memberOut, qmarks, type Row } from "./db";
import { isAdmin } from "./core";
import { evaluatePause } from "./pause";
import { bad, conflict, forbidden, notFound } from "./util";

/** Member of `db.team` (other teams' members are 404). */
export async function loadMember(db: DB, id: string): Promise<Row> {
  const m = await db.first("SELECT * FROM members WHERE id = ? AND kind != 'system' AND team_id = ?", id, db.team);
  if (!m) throw notFound("成员");
  return m;
}

function guardTarget(me: Me, m: Row) {
  if (isAdmin(me)) {
    if (m.kind === "human" && m.role === "owner" && me.role !== "owner") throw forbidden("不能管理团队 owner");
    return;
  }
  if (m.kind !== "agent") throw forbidden("Manager 只能管理 agent");
  if (m.role === "manager" && m.id !== me.id) throw forbidden("Manager 不能管理其他 Manager");
}

export async function approveMember(env: Env, me: Me, id: string) {
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  guardTarget(me, m);
  if (m.status !== "pending") throw conflict("只有待审批的成员可以批准");
  await db.batch([
    db.stmt("UPDATE members SET status = 'active', last_seen_at = COALESCE(last_seen_at, ?) WHERE id = ?", Date.now(), id),
    db.audit(me.id, "member.approve", id),
    db.bumpSeq(),
  ]);
  return memberOut((await loadMember(db, id))!);
}

/** Rejecting a join request deletes it so the name can be reused. */
export async function rejectMember(env: Env, me: Me, id: string) {
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  guardTarget(me, m);
  if (m.status !== "pending") throw conflict("只有待审批的成员可以拒绝");
  await db.batch([
    db.stmt("DELETE FROM member_keys WHERE member_id = ?", id),
    db.stmt("DELETE FROM triggers WHERE member_id = ?", id),
    db.stmt("DELETE FROM members WHERE id = ?", id),
    db.audit(me.id, "member.reject", id, { name: m.name }),
    db.bumpSeq(),
  ]);
  return { ok: true };
}

export async function pauseMember(env: Env, me: Me, id: string, reason: unknown, until: unknown) {
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  guardTarget(me, m);
  if (m.kind !== "agent") throw bad("只能暂停 agent");
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : "手动暂停";
  let untilMs: number | null = null;
  if (until !== undefined && until !== null) {
    untilMs = Number(until);
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) throw bad("until 必须是未来的毫秒时间戳");
  }
  await db.batch([
    db.stmt(
      "UPDATE members SET paused = 1, pause_kind = 'manual', pause_reason = ?, paused_until = ? WHERE id = ?",
      why,
      untilMs,
      id,
    ),
    db.audit(me.id, "member.pause", id, { reason: why, until: untilMs }),
    db.bumpSeq(),
  ]);
  return memberOut(await loadMember(db, id));
}

export async function resumeMember(env: Env, me: Me, id: string) {
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  guardTarget(me, m);
  await db.batch([
    db.stmt("UPDATE members SET paused = 0, pause_kind = NULL, pause_reason = NULL, paused_until = NULL WHERE id = ?", id),
    db.audit(me.id, "member.resume", id),
    db.bumpSeq(),
  ]);
  // Quota/budget limits still apply after a manual resume.
  await evaluatePause(env, id);
  return memberOut(await loadMember(db, id));
}

export async function revokeMember(env: Env, me: Me, id: string) {
  if (!isAdmin(me)) throw forbidden("只有管理员能吊销成员");
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  if (m.id === me.id) throw bad("不能吊销自己");
  if (m.kind === "human") {
    if (m.role === "owner") throw forbidden("不能吊销团队 owner");
    if (me.role !== "owner") throw forbidden("只有团队 owner 能移除人类成员");
  }
  const now = Date.now();
  await db.batch([
    db.stmt("UPDATE members SET status = 'revoked', paused = 0, pause_kind = NULL, pause_reason = NULL, paused_until = NULL WHERE id = ?", id),
    db.stmt("UPDATE member_keys SET expires_at = ? WHERE member_id = ? AND (expires_at IS NULL OR expires_at > ?)", now, id, now),
    db.stmt("UPDATE deliveries SET state = 'done', lease_until = NULL, updated_at = ? WHERE member_id = ? AND state IN ('pending', 'leased')", now, id),
    db.stmt("UPDATE threads SET lease_holder = NULL, lease_until = NULL WHERE lease_holder = ?", id),
    db.stmt("DELETE FROM triggers WHERE member_id = ?", id),
    db.audit(me.id, "member.revoke", id, { name: m.name }),
    db.bumpSeq(),
  ]);
  return memberOut(await loadMember(db, id));
}

export async function deleteMember(env: Env, me: Me, id: string) {
  if (!isAdmin(me)) throw forbidden("只有管理员能删除成员");
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  if (m.status !== "revoked") throw conflict("只能删除已吊销的成员");
  const tables = ["member_keys", "triggers", "quota_readings", "quota_rules", "budgets", "deliveries", "thread_members", "nonces"];
  await db.batch([
    ...tables.map((t) => db.stmt(`DELETE FROM ${t} WHERE member_id = ?`, id)),
    db.stmt("DELETE FROM manager_scopes WHERE manager_id = ?", id),
    db.stmt("UPDATE threads SET assignee_id = NULL WHERE assignee_id = ?", id),
    db.stmt("DELETE FROM members WHERE id = ?", id),
    db.audit(me.id, "member.delete", id, { name: m.name }),
    db.bumpSeq(),
  ]);
  return { ok: true };
}

export async function putQuotaRules(env: Env, me: Me, id: string, rules: unknown) {
  const db = new DB(env.DB, me.team_id);
  const m = await loadMember(db, id);
  guardTarget(me, m);
  if (!Array.isArray(rules) || rules.length > 100) throw bad("rules 必须是数组（最多 100 条）");
  const clean = new Map<string, { provider: string; window: string; pct: number }>();
  for (const r of rules as Record<string, unknown>[]) {
    const provider = String(r?.provider ?? "").trim() || "*";
    const window = String(r?.window ?? "").trim() || "*";
    const pct = Number(r?.pause_at_pct);
    if (provider.length > 64 || window.length > 32) throw bad("provider / window 太长");
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) throw bad("pause_at_pct 必须在 1..100 之间");
    clean.set(`${provider}|${window}`, { provider, window, pct });
  }
  await db.batch([
    db.stmt("DELETE FROM quota_rules WHERE member_id = ?", id),
    ...[...clean.values()].map((r) =>
      db.stmt("INSERT INTO quota_rules (member_id, provider, window, pause_at_pct) VALUES (?, ?, ?, ?)", id, r.provider, r.window, r.pct),
    ),
    db.audit(me.id, "member.quota_rules", id, [...clean.values()]),
    db.bumpSeq(),
  ]);
  await evaluatePause(env, id);
  return { rules: await quotaRules(db, id) };
}

export async function quotaRules(db: DB, id: string) {
  const rows = await db.all("SELECT member_id, provider, window, pause_at_pct FROM quota_rules WHERE member_id = ? ORDER BY provider, window", id);
  return rows.map((r) => ({ member_id: r.member_id, provider: r.provider, window: r.window, pause_at_pct: Number(r.pause_at_pct) }));
}

export async function putBudget(env: Env, me: Me, id: string, body: Record<string, unknown>) {
  if (!isAdmin(me)) throw forbidden();
  const db = new DB(env.DB, me.team_id);
  await loadMember(db, id);
  const tok = body.daily_tokens == null || body.daily_tokens === "" ? null : Number(body.daily_tokens);
  const usd = body.monthly_usd == null || body.monthly_usd === "" ? null : Number(body.monthly_usd);
  if (tok !== null && (!Number.isFinite(tok) || tok < 0)) throw bad("daily_tokens 必须是非负数");
  if (usd !== null && (!Number.isFinite(usd) || usd < 0)) throw bad("monthly_usd 必须是非负数");
  await db.batch([
    tok === null && usd === null
      ? db.stmt("DELETE FROM budgets WHERE member_id = ?", id)
      : db.stmt(
          "INSERT INTO budgets (member_id, daily_tokens, monthly_usd) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET daily_tokens = excluded.daily_tokens, monthly_usd = excluded.monthly_usd",
          id,
          tok === null ? null : Math.floor(tok),
          usd,
        ),
    db.audit(me.id, "member.budget", id, { daily_tokens: tok, monthly_usd: usd }),
    db.bumpSeq(),
  ]);
  await evaluatePause(env, id);
  return { budget: await budgetFor(db, id) };
}

export async function budgetFor(db: DB, id: string) {
  const b = await db.first("SELECT member_id, daily_tokens, monthly_usd FROM budgets WHERE member_id = ?", id);
  return b
    ? { member_id: b.member_id as string, daily_tokens: b.daily_tokens == null ? null : Number(b.daily_tokens), monthly_usd: b.monthly_usd == null ? null : Number(b.monthly_usd) }
    : null;
}

export async function listMembers(db: DB) {
  const rows = await db.all("SELECT * FROM members WHERE kind != 'system' AND team_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, kind DESC, name", db.team);
  const now = Date.now();
  return rows.map((r) => memberOut(r, now));
}

export async function membersByIds(db: DB, ids: string[]) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const rows = await db.all(`SELECT * FROM members WHERE id IN (${qmarks(uniq.length)}) AND kind != 'system' AND team_id = ?`, ...uniq, db.team);
  return rows.map((r) => memberOut(r));
}
