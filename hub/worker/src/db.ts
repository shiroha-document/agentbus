// Thin helpers over D1 plus row → API object mappers (hub-api.md §1).

export type Row = Record<string, unknown>;
export type Arg = string | number | null;

/** Settings stored per team in team_settings; everything else is platform-wide in settings. */
export const TEAM_SETTING_KEYS = new Set(["notify_email", "notify_kinds", "global_pause", "default_pause_pct", "merge_window_min"]);

export const TEAM_SETTING_DEFAULTS: Record<string, string> = {
  notify_kinds: "{}",
  global_pause: "0",
  default_pause_pct: "100",
  merge_window_min: "15",
};

/**
 * D1 helpers bound to one team (hub-api.md §0.1). `team` is the requester's
 * team; settings / change_seq / audit go to that team. null = platform-only
 * context (team settings read as defaults, bumpSeq is a no-op).
 */
export class DB {
  constructor(
    readonly d1: D1Database,
    readonly team: string | null = null,
  ) {}

  forTeam(team: string | null): DB {
    return new DB(this.d1, team);
  }

  stmt(sql: string, ...args: Arg[]): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...args.map((a) => (a === undefined ? null : a)));
  }
  async all<T = Row>(sql: string, ...args: Arg[]): Promise<T[]> {
    const r = await this.stmt(sql, ...args).all<T>();
    return r.results ?? [];
  }
  async first<T = Row>(sql: string, ...args: Arg[]): Promise<T | null> {
    return (await this.stmt(sql, ...args).first<T>()) ?? null;
  }
  async run(sql: string, ...args: Arg[]): Promise<number> {
    const r = await this.stmt(sql, ...args).run();
    return r.meta?.changes ?? 0;
  }
  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    if (!stmts.length) return [];
    return this.d1.batch(stmts);
  }

  async setting(key: string): Promise<string | null> {
    if (TEAM_SETTING_KEYS.has(key)) {
      const r = this.team
        ? await this.first<{ value: string }>("SELECT value FROM team_settings WHERE team_id = ? AND key = ?", this.team, key)
        : null;
      return r?.value ?? TEAM_SETTING_DEFAULTS[key] ?? null;
    }
    const r = await this.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return r?.value ?? null;
  }
  /** Platform settings merged with this team's settings (team wins). */
  async settings(): Promise<Record<string, string>> {
    const rows = await this.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const out: Record<string, string> = { ...TEAM_SETTING_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
    if (this.team) {
      const t = await this.all<{ key: string; value: string }>("SELECT key, value FROM team_settings WHERE team_id = ?", this.team);
      for (const r of t) out[r.key] = r.value;
    }
    return out;
  }
  setSetting(key: string, value: string): D1PreparedStatement {
    if (TEAM_SETTING_KEYS.has(key)) {
      if (!this.team) throw new Error(`team setting ${key} needs a team`);
      return this.stmt(
        "INSERT INTO team_settings (team_id, key, value) VALUES (?, ?, ?) ON CONFLICT(team_id, key) DO UPDATE SET value = excluded.value",
        this.team,
        key,
        value,
      );
    }
    return this.stmt(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
  /** Per-team change counter (no-op without a team). */
  bumpSeq(): D1PreparedStatement {
    return this.stmt("UPDATE teams SET change_seq = change_seq + 1 WHERE id = ?", this.team);
  }
  audit(actor: string | null, action: string, target: string | null, detail?: unknown): D1PreparedStatement {
    return this.stmt(
      "INSERT INTO audit_log (team_id, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      this.team,
      actor,
      action,
      target,
      detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
      Date.now(),
    );
  }
}

/** `IN (?, ?, …)` placeholder list. */
export const qmarks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

const bool = (v: unknown) => v === 1 || v === true || v === "1";
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const parseJson = <T>(s: unknown, def: T): T => {
  if (typeof s !== "string" || !s) return def;
  try {
    return JSON.parse(s) as T;
  } catch {
    return def;
  }
};

export function memberOut(r: Row, now = Date.now()) {
  const interval = Number(r.wake_interval_s ?? 0) || 300;
  const last = num(r.last_seen_at);
  const online = r.kind === "agent" && r.status === "active" && last !== null && now - last <= 3 * interval * 1000;
  return {
    id: r.id as string,
    kind: r.kind as string,
    role: r.role as string,
    name: r.name as string,
    display_name: r.display_name as string,
    avatar_url: (r.avatar_url as string) ?? null,
    email: r.kind === "human" ? ((r.email as string) ?? null) : null,
    cli: (r.cli as string) ?? null,
    wake_mode: (r.wake_mode as string) ?? null,
    wake_interval_s: num(r.wake_interval_s),
    owner: (r.owner as string) ?? null,
    machine: (r.machine as string) ?? null,
    client_version: (r.client_version as string) ?? null,
    status: r.status as string,
    paused: bool(r.paused),
    pause_reason: (r.pause_reason as string) ?? null,
    paused_until: num(r.paused_until),
    online: r.kind === "human" ? false : online,
    last_seen_at: last,
    created_at: Number(r.created_at),
  };
}
export type MemberOut = ReturnType<typeof memberOut>;

export function threadOut(r: Row) {
  return {
    id: r.id as string,
    workspace_id: r.workspace_id as string,
    title: r.title as string,
    status: r.status as string,
    assignee_id: (r.assignee_id as string) ?? null,
    labels: parseJson<string[]>(r.labels, []),
    state: (r.state as string) ?? "",
    lease_holder: (r.lease_holder as string) ?? null,
    lease_until: num(r.lease_until),
    auto_paused: bool(r.auto_paused),
    version: Number(r.version),
    last_post_at: Number(r.last_post_at ?? r.created_at),
    created_by: r.created_by as string,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}
export type ThreadOut = ReturnType<typeof threadOut>;

export function workspaceOut(r: Row) {
  return {
    id: r.id as string,
    name: r.name as string,
    goal: (r.goal as string) ?? "",
    repo: (r.repo as string) ?? null,
    branch: (r.branch as string) ?? null,
    brief: (r.brief as string) ?? "",
    status: r.status as string,
    updated_by: (r.updated_by as string) ?? "",
    updated_at: Number(r.updated_at),
    created_at: Number(r.created_at),
    thread_counts: {
      open: Number(r.n_open ?? 0),
      done: Number(r.n_done ?? 0),
      closed: Number(r.n_closed ?? 0),
    },
  };
}
export type WorkspaceOut = ReturnType<typeof workspaceOut>;

export const WORKSPACE_SELECT = `SELECT w.*,
  (SELECT COUNT(*) FROM threads t WHERE t.workspace_id = w.id AND t.status = 'open') AS n_open,
  (SELECT COUNT(*) FROM threads t WHERE t.workspace_id = w.id AND t.status = 'done') AS n_done,
  (SELECT COUNT(*) FROM threads t WHERE t.workspace_id = w.id AND t.status = 'closed') AS n_closed
  FROM workspaces w`;

export function confirmationOut(r: Row) {
  return {
    id: r.id as string,
    thread_id: r.thread_id as string,
    post_id: r.post_id as string,
    requester_id: r.requester_id as string,
    question: r.question as string,
    status: r.status as string,
    decided_by: (r.decided_by as string) ?? null,
    decided_at: num(r.decided_at),
    note: (r.note as string) ?? null,
  };
}

export function runOut(r: Row) {
  return {
    id: r.id as string,
    member_id: r.member_id as string,
    thread_id: (r.thread_id as string) ?? null,
    started_at: Number(r.started_at),
    ended_at: Number(r.ended_at),
    exit_code: Number(r.exit_code),
    cli: (r.cli as string) ?? "",
    model: (r.model as string) ?? null,
    input: Number(r.input),
    cache_write: Number(r.cache_write),
    cache_read: Number(r.cache_read),
    output: Number(r.output),
    reasoning: Number(r.reasoning),
    cost_usd_est: num(r.cost_usd_est),
    error_summary: (r.error_summary as string) ?? null,
  };
}

export function quotaOut(r: Row) {
  return {
    provider: r.provider as string,
    account: (r.account as string) || null,
    plan: (r.plan as string) ?? null,
    window: r.window as string,
    used_pct: num(r.used_pct),
    resets_at: num(r.resets_at),
    balance: parseJson<{ amount: number; currency: string } | null>(r.balance_json, null),
    source: r.source as string,
    read_at: Number(r.read_at),
    error: (r.error as string) ?? null,
  };
}

export function deliveryOut(r: Row) {
  return {
    id: r.id as string,
    thread_id: r.thread_id as string,
    post_id: r.post_id as string,
    reason: r.reason as string,
    attempts: Number(r.attempts),
  };
}

/** Load posts with reactions and confirmations attached. */
export async function hydratePosts(db: DB, rows: Row[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as string);
  const [reacts, confs] = await Promise.all([
    db.all<{ post_id: string; member_id: string; emoji: string }>(
      `SELECT post_id, member_id, emoji FROM reactions WHERE post_id IN (${qmarks(ids.length)}) ORDER BY rowid`,
      ...ids,
    ),
    db.all(`SELECT * FROM confirmations WHERE post_id IN (${qmarks(ids.length)})`, ...ids),
  ]);
  const rmap = new Map<string, Map<string, string[]>>();
  for (const r of reacts) {
    let m = rmap.get(r.post_id);
    if (!m) rmap.set(r.post_id, (m = new Map()));
    const list = m.get(r.emoji) ?? [];
    list.push(r.member_id);
    m.set(r.emoji, list);
  }
  const cmap = new Map(confs.map((c) => [c.post_id as string, confirmationOut(c)]));
  return rows.map((r) => ({
    id: r.id as string,
    thread_id: r.thread_id as string,
    author_id: r.author_id as string,
    reply_to: (r.reply_to as string) ?? null,
    body: r.body as string,
    kind: r.kind as string,
    mentions: parseJson<string[]>(r.mentions, []),
    redacted: bool(r.redacted),
    usage: parseJson<Record<string, unknown> | null>(r.usage_json, null),
    reactions: [...(rmap.get(r.id as string) ?? new Map()).entries()].map(([emoji, member_ids]) => ({
      emoji,
      member_ids,
    })),
    confirmation: cmap.get(r.id as string) ?? null,
    created_at: Number(r.created_at),
  }));
}
export type PostOut = Awaited<ReturnType<typeof hydratePosts>>[number];

export async function reactionsFor(db: DB, postId: string) {
  const posts = await hydratePosts(db, [{ id: postId }]);
  return posts[0].reactions;
}
