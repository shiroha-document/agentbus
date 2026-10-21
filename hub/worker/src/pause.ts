// Pause evaluation (hub-api.md §5).
import type { Env } from "./env";
import { DB } from "./db";
import { notify } from "./notify";
import { shDayStart, shMonthStart, shNextDay, shNextMonth } from "./util";

interface RuleRow {
  provider: string;
  window: string;
  pause_at_pct: number;
}

export function thresholdFor(rules: RuleRow[], provider: string, window: string, def: number): number {
  const pick = (p: string, w: string) => rules.find((r) => r.provider === p && r.window === w);
  const r = pick(provider, window) ?? pick(provider, "*") ?? pick("*", window) ?? pick("*", "*");
  return r ? Number(r.pause_at_pct) : def;
}

export const TOKENS_SQL = "COALESCE(SUM(input + cache_write + cache_read + output + reasoning), 0)";

export interface PauseDecision {
  paused: boolean;
  kind: "manual" | "quota" | "budget" | null;
  reason: string | null;
  until: number | null;
}

/** Compute the automatic (quota / budget) pause state for a member; `db` must be bound to the member's team. */
export async function autoPause(db: DB, memberId: string, now = Date.now()): Promise<PauseDecision> {
  const none: PauseDecision = { paused: false, kind: null, reason: null, until: null };
  const [rules, readings, budget, defPct] = await Promise.all([
    db.all<RuleRow>("SELECT provider, window, pause_at_pct FROM quota_rules WHERE member_id = ?", memberId),
    db.all<{ provider: string; window: string; used_pct: number | null; resets_at: number | null; read_at: number; error: string | null }>(
      "SELECT provider, window, used_pct, resets_at, read_at, error FROM quota_readings WHERE member_id = ? AND used_pct IS NOT NULL",
      memberId,
    ),
    db.first<{ daily_tokens: number | null; monthly_usd: number | null }>(
      "SELECT daily_tokens, monthly_usd FROM budgets WHERE member_id = ?",
      memberId,
    ),
    db.setting("default_pause_pct"),
  ]);
  const def = Number(defPct ?? 100) || 100;
  let best: PauseDecision | null = null;
  for (const r of readings) {
    if (r.error || r.used_pct === null) continue;
    if (r.resets_at !== null && r.resets_at <= now) continue; // window already reset
    if (r.resets_at === null && now - r.read_at > 6 * 3600_000) continue; // stale, no reset time
    const th = thresholdFor(rules, r.provider, r.window, def);
    if (r.used_pct >= th) {
      const d: PauseDecision = {
        paused: true,
        kind: "quota",
        reason: `quota:${r.provider}/${r.window} ${Math.round(r.used_pct)}%`,
        until: r.resets_at,
      };
      // Prefer the reading that blocks longest; unknown reset counts as longest.
      if (!best || d.until === null || (best.until !== null && d.until > best.until)) best = d;
    }
  }
  if (best) return best;
  if (budget?.daily_tokens != null) {
    const t = await db.first<{ n: number }>(
      `SELECT ${TOKENS_SQL} AS n FROM runs WHERE member_id = ? AND started_at >= ?`,
      memberId,
      shDayStart(now),
    );
    if ((t?.n ?? 0) >= budget.daily_tokens) {
      return { paused: true, kind: "budget", reason: `budget:daily_tokens ${t?.n ?? 0}/${budget.daily_tokens}`, until: shNextDay(now) };
    }
  }
  if (budget?.monthly_usd != null) {
    const t = await db.first<{ n: number }>(
      "SELECT COALESCE(SUM(cost_usd_est), 0) AS n FROM runs WHERE member_id = ? AND started_at >= ?",
      memberId,
      shMonthStart(now),
    );
    const used = Math.round((t?.n ?? 0) * 100) / 100;
    if (used >= budget.monthly_usd) {
      return { paused: true, kind: "budget", reason: `budget:monthly_usd $${used}/$${budget.monthly_usd}`, until: shNextMonth(now) };
    }
  }
  return none;
}

/**
 * Re-evaluate and persist a member's pause state. Manual pauses win and only
 * expire when `paused_until` passes. Returns the effective state (global
 * pause included).
 */
export async function evaluatePause(env: Env, memberId: string, now = Date.now()) {
  const m = await new DB(env.DB).first<{ team_id: string | null; name: string; display_name: string; paused: number; pause_kind: string | null; pause_reason: string | null; paused_until: number | null }>(
    "SELECT team_id, name, display_name, paused, pause_kind, pause_reason, paused_until FROM members WHERE id = ?",
    memberId,
  );
  if (!m) return { paused: false, pause_reason: null, paused_until: null };
  // Settings (global_pause, default_pause_pct), audit and notifications belong to the member's team.
  const db = new DB(env.DB, m.team_id);
  const global = (await db.setting("global_pause")) === "1";
  let state: PauseDecision;
  const manualActive = m.paused && m.pause_kind === "manual" && (m.paused_until === null || m.paused_until > now);
  if (manualActive) {
    state = { paused: true, kind: "manual", reason: m.pause_reason, until: m.paused_until };
  } else {
    state = await autoPause(db, memberId, now);
  }
  const changed =
    Boolean(m.paused) !== state.paused ||
    (m.pause_kind ?? null) !== state.kind ||
    (m.pause_reason ?? null) !== state.reason ||
    (m.paused_until ?? null) !== state.until;
  if (changed) {
    const stmts = [
      db.stmt(
        "UPDATE members SET paused = ?, pause_kind = ?, pause_reason = ?, paused_until = ? WHERE id = ?",
        state.paused ? 1 : 0,
        state.kind,
        state.reason,
        state.until,
        memberId,
      ),
      db.audit(null, state.paused ? "member.auto_pause" : "member.auto_resume", memberId, state.reason ?? m.pause_reason),
      db.bumpSeq(),
    ];
    const newlyAuto = state.paused && state.kind !== "manual" && (!m.paused || m.pause_reason !== state.reason);
    if (newlyAuto) {
      stmts.push(
        notify(
          db,
          "quota_paused",
          {
            title: `${m.display_name}（@${m.name}）已暂停`,
            text: `${state.reason}${state.until ? `，预计 ${new Date(state.until).toISOString().replace("T", " ").slice(0, 16)} UTC 恢复` : ""}`,
            link: `/members/${memberId}`,
          },
          `quota_paused:${memberId}:${state.reason}`,
        ),
      );
    }
    await db.batch(stmts);
  }
  return {
    paused: state.paused || global,
    pause_reason: state.paused ? state.reason : global ? "global" : null,
    paused_until: state.paused ? state.until : null,
  };
}
