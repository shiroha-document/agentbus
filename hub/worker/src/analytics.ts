// Product analytics (埋点): ingestion, hub-side events, stats (v06-contract §5).
import type { DB } from "./db";
import { bad } from "./util";

export const EVENT_NAME_RE = /^[a-z][a-z0-9_.]{1,48}$/;
const PROP_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_EVENTS = 50;
const MAX_PROPS = 20;
const DAY = 86_400_000;
export const EVENTS_RETENTION_MS = 90 * DAY;
const SAMPLE = 5000;

type PropVal = string | number | boolean;
export interface CleanEvent {
  name: string;
  props: Record<string, PropVal>;
  duration_ms: number | null;
  ok: number | null;
  client_version: string | null;
  os: string | null;
  at: number;
}

const shortStr = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Validate one incoming event; null = drop silently. */
export function cleanEvent(e: unknown, now = Date.now()): CleanEvent | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (typeof o.name !== "string" || !EVENT_NAME_RE.test(o.name)) return null;
  const props: Record<string, PropVal> = {};
  if (o.props && typeof o.props === "object" && !Array.isArray(o.props)) {
    for (const [k, v] of Object.entries(o.props as Record<string, unknown>)) {
      if (Object.keys(props).length >= MAX_PROPS) break;
      if (!PROP_KEY_RE.test(k)) continue;
      if (typeof v === "string") props[k] = v.slice(0, 200);
      else if (typeof v === "number" && Number.isFinite(v)) props[k] = v;
      else if (typeof v === "boolean") props[k] = v;
    }
  }
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? Math.min(Math.max(o.at, now - 7 * DAY), now + 5 * 60_000) : now;
  const dur = typeof o.duration_ms === "number" && Number.isFinite(o.duration_ms) && o.duration_ms >= 0 ? Math.floor(o.duration_ms) : null;
  return {
    name: o.name,
    props,
    duration_ms: dur,
    ok: o.ok === true ? 1 : o.ok === false ? 0 : null,
    client_version: shortStr(o.client_version, 40),
    os: shortStr(o.os, 40),
    at: Math.floor(at),
  };
}

/** POST /agent/events, /web/events → number of stored events. */
export async function ingestEvents(db: DB, source: "cli" | "web", memberId: string | null, body: unknown): Promise<number> {
  const list = (body as { events?: unknown })?.events;
  if (!Array.isArray(list)) throw bad("events 必须是数组");
  if (list.length > MAX_EVENTS) throw bad(`一次最多上报 ${MAX_EVENTS} 个事件`);
  const now = Date.now();
  const clean = list.map((e) => cleanEvent(e, now)).filter((e): e is CleanEvent => !!e);
  if (!clean.length) return 0;
  await db.batch(
    clean.map((e) =>
      db.stmt(
        "INSERT INTO events (team_id, source, member_id, name, props, duration_ms, ok, client_version, os, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        db.team,
        source,
        memberId,
        e.name,
        JSON.stringify(e.props),
        e.duration_ms,
        e.ok,
        e.client_version,
        e.os,
        e.at,
      ),
    ),
  );
  return clean.length;
}

/** Hub-side event (source hub) as a statement for an existing batch. */
export function hubEvent(db: DB, name: string, props: Record<string, PropVal>, memberId: string | null, now = Date.now()) {
  return db.stmt(
    "INSERT INTO events (team_id, source, member_id, name, props, created_at) VALUES (?, 'hub', ?, ?, ?, ?)",
    db.team,
    memberId,
    name,
    JSON.stringify(props),
    now,
  );
}

/** Run analytics statements on their own; failures never reach the caller. */
export async function logEvents(db: DB, stmts: D1PreparedStatement[]) {
  try {
    await db.batch(stmts);
  } catch (e) {
    console.error("analytics", e);
  }
}

/** Nearest-rank percentile over unsorted samples. */
export function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]);
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY_SQL = (col: string) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;

/** GET /web/analytics (AnalyticsResponse). */
export async function analytics(db: DB, daysIn: unknown, now = Date.now()) {
  const n = daysIn === undefined || daysIn === null || daysIn === "" ? 30 : Math.floor(Number(daysIn));
  const days = Math.min(90, Math.max(1, Number.isFinite(n) ? n : 30));
  const team = db.team;
  // Whole UTC days: today plus the days-1 before it.
  const todayStart = Math.floor(now / DAY) * DAY;
  const since = todayStart - (days - 1) * DAY;
  type N = { n: number };

  const [
    evTotal,
    actives,
    postsTotal,
    runsTotal,
    evDaily,
    postsDaily,
    top,
    cmds,
    cmdSamples,
    pages,
    clients,
    agentClis,
    runClis,
    claimSamples,
    replySamples,
    byKind,
  ] = await Promise.all([
    db.first<N>("SELECT COUNT(*) AS n FROM events WHERE team_id = ? AND created_at >= ?", team, since),
    db.all<{ kind: string; n: number }>(
      `SELECT kind, COUNT(*) AS n FROM members WHERE team_id = ? AND id IN (
         SELECT member_id FROM events WHERE team_id = ? AND created_at >= ? AND member_id IS NOT NULL
         UNION SELECT author_id FROM posts WHERE team_id = ? AND created_at >= ?
         UNION SELECT member_id FROM runs WHERE team_id = ? AND started_at >= ?)
       GROUP BY kind`,
      team,
      team,
      since,
      team,
      since,
      team,
      since,
    ),
    db.first<N>("SELECT COUNT(*) AS n FROM posts WHERE team_id = ? AND created_at >= ?", team, since),
    db.first<{ n: number; failed: number }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END), 0) AS failed FROM runs WHERE team_id = ? AND started_at >= ?",
      team,
      since,
    ),
    db.all<{ day: string; source: string; n: number }>(
      `SELECT ${DAY_SQL("created_at")} AS day, source, COUNT(*) AS n FROM events WHERE team_id = ? AND created_at >= ? GROUP BY day, source`,
      team,
      since,
    ),
    db.all<{ day: string; n: number }>(
      `SELECT ${DAY_SQL("created_at")} AS day, COUNT(*) AS n FROM posts WHERE team_id = ? AND created_at >= ? GROUP BY day`,
      team,
      since,
    ),
    db.all<{ name: string; source: string; n: number }>(
      "SELECT name, source, COUNT(*) AS n FROM events WHERE team_id = ? AND created_at >= ? GROUP BY name, source ORDER BY n DESC, name LIMIT 20",
      team,
      since,
    ),
    db.all<{ cmd: string; n: number; failed: number }>(
      `SELECT json_extract(props, '$.cmd') AS cmd, COUNT(*) AS n, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed
       FROM events WHERE team_id = ? AND created_at >= ? AND name = 'cli.command' AND json_extract(props, '$.cmd') IS NOT NULL
       GROUP BY cmd ORDER BY n DESC LIMIT 50`,
      team,
      since,
    ),
    db.all<{ cmd: string; d: number }>(
      `SELECT json_extract(props, '$.cmd') AS cmd, duration_ms AS d FROM events
       WHERE team_id = ? AND created_at >= ? AND name = 'cli.command' AND duration_ms IS NOT NULL ORDER BY created_at DESC LIMIT ${SAMPLE}`,
      team,
      since,
    ),
    db.all<{ path: string; n: number }>(
      `SELECT json_extract(props, '$.path') AS path, COUNT(*) AS n FROM events
       WHERE team_id = ? AND created_at >= ? AND name = 'page.view' AND json_extract(props, '$.path') IS NOT NULL
       GROUP BY path ORDER BY n DESC LIMIT 50`,
      team,
      since,
    ),
    db.all<{ version: string; n: number }>(
      `SELECT client_version AS version, COUNT(*) AS n FROM members
       WHERE team_id = ? AND kind = 'agent' AND status = 'active' AND client_version IS NOT NULL GROUP BY client_version ORDER BY n DESC`,
      team,
    ),
    db.all<{ cli: string; n: number }>(
      "SELECT COALESCE(cli, 'unknown') AS cli, COUNT(*) AS n FROM members WHERE team_id = ? AND kind = 'agent' AND status = 'active' GROUP BY 1",
      team,
    ),
    db.all<{ cli: string; n: number }>(
      "SELECT COALESCE(NULLIF(cli, ''), 'unknown') AS cli, COUNT(*) AS n FROM runs WHERE team_id = ? AND started_at >= ? GROUP BY 1",
      team,
      since,
    ),
    db.all<{ w: number }>(
      `SELECT json_extract(props, '$.wait_ms') AS w FROM events
       WHERE team_id = ? AND created_at >= ? AND name = 'delivery.claim' ORDER BY created_at DESC LIMIT ${SAMPLE}`,
      team,
      since,
    ),
    db.all<{ at: number; replied: number | null }>(
      `SELECT p.created_at AS at,
         (SELECT q.created_at FROM posts q
           WHERE q.thread_id = p.thread_id AND q.team_id = p.team_id AND q.id > p.id
             AND q.author_id IN (SELECT j.value FROM json_each(p.mentions) j JOIN members a ON a.id = j.value AND a.kind = 'agent')
           ORDER BY q.id LIMIT 1) AS replied
       FROM posts p JOIN members m ON m.id = p.author_id
       WHERE p.team_id = ? AND p.created_at >= ? AND m.kind = 'human' AND p.mentions != '[]'
       ORDER BY p.created_at DESC LIMIT ${SAMPLE}`,
      team,
      since,
    ),
    db.all<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM posts WHERE team_id = ? AND created_at >= ? GROUP BY kind ORDER BY n DESC",
      team,
      since,
    ),
  ]);

  const daily = Array.from({ length: days }, (_, i) => ({ day: dayKey(since + i * DAY), web: 0, cli: 0, hub: 0, posts: 0 }));
  const dmap = new Map(daily.map((d) => [d.day, d]));
  for (const r of evDaily) {
    const d = dmap.get(r.day);
    if (d && (r.source === "web" || r.source === "cli" || r.source === "hub")) d[r.source] += Number(r.n);
  }
  for (const r of postsDaily) {
    const d = dmap.get(r.day);
    if (d) d.posts += Number(r.n);
  }

  const durByCmd = new Map<string, number[]>();
  for (const s of cmdSamples) {
    if (s.cmd == null) continue;
    const k = String(s.cmd);
    const l = durByCmd.get(k) ?? [];
    l.push(Number(s.d));
    durByCmd.set(k, l);
  }

  const adapters = new Map<string, { cli: string; members: number; runs: number }>();
  const ad = (cli: string) => {
    let a = adapters.get(cli);
    if (!a) adapters.set(cli, (a = { cli, members: 0, runs: 0 }));
    return a;
  };
  for (const r of agentClis) ad(r.cli).members += Number(r.n);
  for (const r of runClis) ad(r.cli).runs += Number(r.n);

  const claims = claimSamples.map((r) => Number(r.w)).filter((x) => Number.isFinite(x) && x >= 0);
  const replies = replySamples.filter((r) => r.replied != null).map((r) => Math.max(0, Number(r.replied) - Number(r.at)));

  return {
    days,
    totals: {
      events: Number(evTotal?.n ?? 0),
      active_humans: Number(actives.find((a) => a.kind === "human")?.n ?? 0),
      active_agents: Number(actives.find((a) => a.kind === "agent")?.n ?? 0),
      posts: Number(postsTotal?.n ?? 0),
      runs: Number(runsTotal?.n ?? 0),
      failed_runs: Number(runsTotal?.failed ?? 0),
    },
    daily,
    top_events: top.map((r) => ({ name: r.name, source: r.source, n: Number(r.n) })),
    cli_commands: cmds.map((r) => ({
      cmd: String(r.cmd),
      n: Number(r.n),
      failed: Number(r.failed),
      p50_ms: percentile(durByCmd.get(String(r.cmd)) ?? [], 0.5),
    })),
    pages: pages.map((r) => ({ path: String(r.path), n: Number(r.n) })),
    clients: clients.map((r) => ({ version: r.version, n: Number(r.n) })),
    adapters: [...adapters.values()].sort((a, b) => b.members - a.members || b.runs - a.runs || a.cli.localeCompare(b.cli)),
    latency: {
      claim_p50_ms: percentile(claims, 0.5),
      claim_p90_ms: percentile(claims, 0.9),
      reply_p50_ms: percentile(replies, 0.5),
      reply_p90_ms: percentile(replies, 0.9),
    },
    posts_by_kind: byKind.map((r) => ({ kind: r.kind, n: Number(r.n) })),
  };
}
