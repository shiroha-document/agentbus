// Cron watchdog (hub.md §9), runs every minute.
import type { Env } from "./env";
import { DB } from "./db";
import { createPost, deadNotice, systemFor } from "./core";
import { decryptUrl } from "./crypto";
import { errText, flushNotifications, notify } from "./notify";
import { evaluatePause } from "./pause";

const MAX_ATTEMPTS = 5;
const TRIGGER_GAP_MS = 60_000;
const TRIGGER_TIMEOUT_MS = 10_000;

type Step = (env: Env, now: number) => Promise<unknown>;

/** Run every step; one failing step must not block the rest. */
export async function runWatchdog(env: Env, now = Date.now()) {
  const steps: [string, Step][] = [
    ["leases", expireLeases],
    ["unresponsive", checkUnresponsive],
    ["offline", checkOffline],
    ["resume", autoResume],
    ["triggers", callTriggers],
    ["cleanup", cleanup],
    ["notify", (e, n) => flushNotifications(e, { now: n })],
  ];
  const errors: Record<string, string> = {};
  for (const [name, fn] of steps) {
    try {
      await fn(env, now);
    } catch (e) {
      errors[name] = errText(e);
      console.error("watchdog step failed", name, errText(e));
    }
  }
  return errors;
}

/** Teams whose global_pause is on. */
async function pausedTeams(db: DB): Promise<Set<string>> {
  const rows = await db.all<{ team_id: string }>("SELECT team_id FROM team_settings WHERE key = 'global_pause' AND value = '1'");
  return new Set(rows.map((r) => r.team_id));
}

/** Expired leases go back to pending (attempts+1) or dead at 5; stale thread locks are released. Global across teams. */
export async function expireLeases(env: Env, now: number) {
  const db = new DB(env.DB);
  const rows = await db.all<{ id: string; team_id: string | null; member_id: string; thread_id: string; attempts: number; name: string | null }>(
    `SELECT d.id, d.team_id, d.member_id, d.thread_id, d.attempts, m.name FROM deliveries d LEFT JOIN members m ON m.id = d.member_id
     WHERE d.state = 'leased' AND d.lease_until < ? LIMIT 500`,
    now,
  );
  const threads = await db.all<{ team_id: string | null }>(
    "SELECT DISTINCT team_id FROM threads WHERE lease_holder IS NOT NULL AND lease_until < ?",
    now,
  );
  const touched = new Set<string | null>([...rows.map((r) => r.team_id), ...threads.map((t) => t.team_id)]);
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const attempts = Number(r.attempts) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    stmts.push(
      db.stmt(
        "UPDATE deliveries SET state = ?, attempts = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'leased'",
        dead ? "dead" : "pending",
        attempts,
        now,
        r.id,
      ),
    );
    if (dead) stmts.push(deadNotice(db.forTeam(r.team_id), r.name ?? r.member_id, r.thread_id, r.id, "租约超时"));
  }
  stmts.push(db.stmt("UPDATE threads SET lease_holder = NULL, lease_until = NULL WHERE lease_holder IS NOT NULL AND lease_until < ?", now));
  const res = await db.batch(stmts);
  const changed = res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  if (changed) await db.batch([...touched].filter(Boolean).map((t) => db.forTeam(t).bumpSeq()));
  return rows.length;
}

/** A mention pending for > 3 wake intervals → system post @owner + email. */
export async function checkUnresponsive(env: Env, now: number) {
  const db = new DB(env.DB);
  const rows = await db.all<{
    id: string;
    team_id: string;
    thread_id: string;
    member_id: string;
    name: string;
    display_name: string;
    owner: string | null;
    title: string;
  }>(
    `SELECT d.id, t.team_id, d.thread_id, d.member_id, m.name, m.display_name, m.owner, t.title
     FROM deliveries d JOIN members m ON m.id = d.member_id JOIN threads t ON t.id = d.thread_id
     WHERE d.state = 'pending' AND d.reason = 'mention' AND d.alerted = 0
       AND m.status = 'active' AND m.paused = 0 AND t.auto_paused = 0
       AND d.created_at < ? - 3 * COALESCE(m.wake_interval_s, 300) * 1000
     ORDER BY d.created_at LIMIT 50`,
    now,
  );
  if (!rows.length) return 0;
  const paused = await pausedTeams(db);
  // One alert per (member, thread) per run.
  const seen = new Set<string>();
  for (const r of rows) {
    if (paused.has(r.team_id)) continue;
    const tdb = db.forTeam(r.team_id);
    const key = `${r.member_id}:${r.thread_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await db.run(
      "UPDATE deliveries SET alerted = 1 WHERE member_id = ? AND thread_id = ? AND state = 'pending' AND reason = 'mention'",
      r.member_id,
      r.thread_id,
    );
    const owner = r.owner
      ? await db.first<{ name: string }>(
          "SELECT name FROM members WHERE (name = ? OR email = ?) AND status = 'active' AND kind != 'system' AND team_id = ?",
          r.owner.toLowerCase(),
          r.owner.toLowerCase(),
          r.team_id,
        )
      : null;
    const who = owner ? `@${owner.name} ` : "";
    await createPost(env, systemFor(r.team_id), {
      thread_id: r.thread_id,
      body: `${who}${r.display_name}（\`${r.name}\`）被 @ 后超过 3 个醒来间隔仍未回应，请检查它的定时任务或额度。`,
      kind: "system",
      system: true,
    });
    await notify(
      tdb,
      "agent_unresponsive",
      {
        title: `${r.display_name}（@${r.name}）没有回应`,
        text: `讨论串「${r.title}」里的 @ 超过 3 个醒来间隔仍未处理。`,
        link: `/threads/${r.thread_id}`,
      },
      `unresponsive:${r.id}`,
    ).run();
  }
  return seen.size;
}

/** Active agents silent for > 3 wake intervals → offline notice (once until seen again). */
export async function checkOffline(env: Env, now: number) {
  const db = new DB(env.DB);
  const rows = await db.all<{ id: string; team_id: string | null; name: string; display_name: string; last_seen_at: number | null; wake_interval_s: number | null }>(
    `SELECT id, team_id, name, display_name, last_seen_at, wake_interval_s FROM members
     WHERE kind = 'agent' AND status = 'active' AND offline_notified = 0 AND last_seen_at IS NOT NULL
       AND last_seen_at < ? - 3 * COALESCE(wake_interval_s, 300) * 1000`,
    now,
  );
  if (!rows.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const mins = Math.round((now - Number(r.last_seen_at)) / 60_000);
    stmts.push(
      db.stmt("UPDATE members SET offline_notified = 1 WHERE id = ?", r.id),
      notify(
        db.forTeam(r.team_id),
        "agent_offline",
        {
          title: `${r.display_name}（@${r.name}）离线`,
          text: `已经 ${mins} 分钟没有任何请求（醒来间隔 ${r.wake_interval_s ?? 300}s）。`,
          link: `/members/${r.id}`,
        },
        `offline:${r.id}:${r.last_seen_at}`,
      ),
    );
  }
  for (const t of new Set(rows.map((r) => r.team_id))) stmts.push(db.forTeam(t).bumpSeq());
  await db.batch(stmts);
  return rows.length;
}

/** Re-evaluate automatic pauses and expired manual pauses. */
export async function autoResume(env: Env, now: number) {
  const db = new DB(env.DB);
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM members WHERE kind = 'agent' AND status = 'active' AND paused = 1
       AND (pause_kind != 'manual' OR (paused_until IS NOT NULL AND paused_until <= ?))`,
    now,
  );
  for (const r of rows) await evaluatePause(env, r.id, now);
  return rows.length;
}

let triggerFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
/** Tests only. */
export function setTriggerFetch(f: typeof triggerFetch) {
  triggerFetch = f;
}

/** Wake trigger-mode agents that have claimable work, at most once a minute each. */
export async function callTriggers(env: Env, now: number) {
  const db = new DB(env.DB);
  const paused = await pausedTeams(db);
  const all = await db.all<{ member_id: string; team_id: string; url_ciphertext: string; iv: string; name: string }>(
    `SELECT tr.member_id, m.team_id, tr.url_ciphertext, tr.iv, m.name FROM triggers tr JOIN members m ON m.id = tr.member_id
     WHERE m.status = 'active' AND m.paused = 0 AND m.wake_mode = 'trigger'
       AND (tr.last_called_at IS NULL OR tr.last_called_at <= ?)
       AND EXISTS (
         SELECT 1 FROM deliveries d JOIN threads t ON t.id = d.thread_id
         WHERE d.member_id = tr.member_id AND d.state = 'pending' AND t.auto_paused = 0
           AND (t.lease_holder IS NULL OR t.lease_holder = tr.member_id OR t.lease_until < ?)
       )
     LIMIT 50`,
    now - TRIGGER_GAP_MS,
    now,
  );
  const rows = all.filter((r) => !paused.has(r.team_id));
  let called = 0;
  for (const r of rows) {
    // Claim the slot first so overlapping cron runs don't double-call.
    const ok = await db.run(
      "UPDATE triggers SET last_called_at = ? WHERE member_id = ? AND (last_called_at IS NULL OR last_called_at <= ?)",
      now,
      r.member_id,
      now - TRIGGER_GAP_MS,
    );
    if (!ok) continue;
    try {
      const url = await decryptUrl(env, r.url_ciphertext, r.iv);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TRIGGER_TIMEOUT_MS);
      try {
        const res = await triggerFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "agentbus-hub" },
          body: JSON.stringify({ event: "wake", member: r.name, at: now }),
          signal: ctl.signal,
          redirect: "manual",
        });
        if (!res.ok) console.warn("trigger non-2xx", r.name, res.status);
        called++;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      console.warn("trigger failed", r.name, errText(e));
    }
  }
  return called;
}

/** Cheap housekeeping; safe to run every minute. */
export async function cleanup(env: Env, now: number) {
  const db = new DB(env.DB);
  const day = 86400_000;
  await db.batch([
    db.stmt("DELETE FROM nonces WHERE expires_at < ?", now),
    db.stmt("DELETE FROM email_changes WHERE expires_at < ?", now),
    db.stmt("DELETE FROM notifications WHERE sent_at IS NOT NULL AND sent_at < ?", now - 30 * day),
    db.stmt("DELETE FROM audit_log WHERE action = 'join.attempt' AND created_at < ?", now - day),
  ]);
}
