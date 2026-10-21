// Shared domain logic: posts, inbox, thread updates, permissions.
import type { Env, Me } from "./env";
import { DB, hydratePosts, qmarks, threadOut, type Row, type PostOut } from "./db";
import { notify } from "./notify";
import { redact } from "./redact";
import { HttpError, bad, conflict, forbidden, newId, notFound } from "./util";

export const SYSTEM_ID = "m_system";
export const DEFAULTS = { lease_s: 900, context_posts: 30, max_claim_threads: 3 };
export const MAX_BODY_CHARS = 64_000;
export const MAX_STATE_CHARS = 32_000;
const FLOOD_LIMIT = 10;

export async function hubConfig(db: DB) {
  const s = await db.settings();
  const n = (k: keyof typeof DEFAULTS) => {
    const v = Number(s[k]);
    return Number.isFinite(v) && v > 0 ? v : DEFAULTS[k];
  };
  return { lease_s: n("lease_s"), context_posts: n("context_posts"), max_claim_threads: n("max_claim_threads") };
}

// ---------------------------------------------------------------- mentions

const MENTION_RE = /(^|[^A-Za-z0-9_.@/-])@([a-z0-9][a-z0-9_-]{1,31})(?![A-Za-z0-9_-])/g;

/** Names mentioned with @name, ignoring code spans/blocks and emails. */
export function parseMentions(body: string): string[] {
  const stripped = body.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const out = new Set<string>();
  for (const m of stripped.matchAll(MENTION_RE)) out.add(m[2]);
  return [...out];
}

// ---------------------------------------------------------------- members

export async function resolveMember(db: DB, ref: string): Promise<Row | null> {
  const r = ref.trim().replace(/^@/, "");
  if (!r) return null;
  return db.first("SELECT * FROM members WHERE (id = ? OR name = ?) AND kind != 'system' AND team_id = ?", r, r, db.team);
}

/** Team owner or admin (human). */
export function isAdmin(me: Me): boolean {
  return me.kind === "human" && (me.role === "owner" || me.role === "admin");
}

/** DB bound to the requester's team. */
export function teamDb(env: Env, me: Me): DB {
  return new DB(env.DB, me.team_id);
}

/** Manager workspace scope: null = everything. */
export async function managerScopes(db: DB, managerId: string): Promise<string[] | null> {
  const rows = await db.all<{ workspace_id: string }>("SELECT workspace_id FROM manager_scopes WHERE manager_id = ?", managerId);
  return rows.length ? rows.map((r) => r.workspace_id) : null;
}

export async function canManageWorkspace(db: DB, me: Me, workspaceId: string): Promise<boolean> {
  if (isAdmin(me)) return true;
  if (me.role !== "manager") return false;
  const s = await managerScopes(db, me.id);
  return s === null || s.includes(workspaceId);
}

export function requireManager(me: Me) {
  if (me.role !== "manager" && !isAdmin(me)) throw forbidden("只有 Manager 能执行此操作");
}

// ---------------------------------------------------------------- posts

export interface Target {
  id: string;
  reason: "mention" | "assign" | "reply" | "event";
}
const PRIORITY = { mention: 0, assign: 1, reply: 2, event: 3 } as const;

export interface CreatePostInput {
  thread_id?: string;
  workspace_id?: string;
  title?: string;
  assignee?: string | null;
  body: string;
  kind?: string;
  reply_to?: string | null;
  idempotency_key?: string | null;
  usage?: unknown;
  /** Extra delivery targets (system posts). */
  extra?: Target[];
  /** Skip participant bookkeeping for system posts. */
  system?: boolean;
}

export interface CreatePostResult {
  post: PostOut;
  thread: ReturnType<typeof threadOut>;
  duplicate: boolean;
  redacted: string[];
}

function cleanUsage(u: unknown): string | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const int = (k: string) => Math.max(0, Math.floor(Number(o[k]) || 0));
  const out = {
    input: int("input"),
    cache_write: int("cache_write"),
    cache_read: int("cache_read"),
    output: int("output"),
    reasoning: int("reasoning"),
    cost_usd_est: o.cost_usd_est == null || !Number.isFinite(Number(o.cost_usd_est)) ? null : Number(o.cost_usd_est),
    duration_ms: int("duration_ms"),
    model: typeof o.model === "string" ? o.model.slice(0, 100) : null,
  };
  return JSON.stringify(out);
}

export async function loadThread(db: DB, id: string): Promise<Row> {
  const t = await db.first("SELECT * FROM threads WHERE id = ? AND team_id = ?", id, db.team);
  if (!t) throw notFound("讨论串");
  return t;
}

export async function loadPost(db: DB, id: string): Promise<PostOut> {
  const r = await db.first("SELECT * FROM posts WHERE id = ? AND team_id = ?", id, db.team);
  if (!r) throw notFound("帖子");
  return (await hydratePosts(db, [r]))[0];
}

/**
 * Create a post (and optionally a new thread), redact secrets, compute
 * deliveries, record participants, detect floods. All writes go in one batch.
 */
export async function createPost(env: Env, me: Me, input: CreatePostInput): Promise<CreatePostResult> {
  if (!me.team_id) throw notFound("团队");
  const db = teamDb(env, me);
  const team = me.team_id;
  const now = Date.now();
  const kind = input.kind ?? "msg";
  if (!["msg", "progress", "confirm", "system"].includes(kind)) throw bad("kind 只能是 msg / progress / confirm");
  if (kind === "system" && me.id !== SYSTEM_ID) throw bad("不能手动发 system 帖");
  if (typeof input.body !== "string" || !input.body.trim()) throw bad("body 不能为空");
  if (input.body.length > MAX_BODY_CHARS) throw bad(`body 超过 ${MAX_BODY_CHARS} 个字符`);
  const idem = input.idempotency_key ? String(input.idempotency_key).slice(0, 200) : null;

  if (idem) {
    const dup = await db.first("SELECT * FROM posts WHERE author_id = ? AND idempotency_key = ?", me.id, idem);
    if (dup) {
      const thread = threadOut(await loadThread(db, dup.thread_id as string));
      return { post: (await hydratePosts(db, [dup]))[0], thread, duplicate: true, redacted: [] };
    }
  }

  const stmts: D1PreparedStatement[] = [];
  let thread: Row;
  let newThread = false;
  if (input.thread_id) {
    thread = await loadThread(db, input.thread_id);
    if (thread.status === "closed" && me.id !== SYSTEM_ID) {
      if (me.kind !== "human") throw conflict("讨论串已关闭");
      stmts.push(db.stmt("UPDATE threads SET status = 'open' WHERE id = ?", thread.id as string));
      thread.status = "open";
    }
  } else {
    if (!input.workspace_id || !input.title?.trim()) throw bad("需要 thread_id，或者 workspace_id + title 新开讨论串");
    const ws = await db.first("SELECT id, status FROM workspaces WHERE id = ? AND team_id = ?", input.workspace_id, team);
    if (!ws) throw notFound("工作区");
    if (ws.status === "archived") throw conflict("工作区已归档");
    let assigneeId: string | null = null;
    if (input.assignee) {
      const a = await resolveMember(db, input.assignee);
      if (!a || a.status !== "active") throw bad(`负责人 ${input.assignee} 不存在或未激活`);
      assigneeId = a.id as string;
    }
    const title = redact(input.title.trim().slice(0, 200)).text;
    thread = {
      id: newId("t", now),
      workspace_id: ws.id,
      title,
      status: "open",
      assignee_id: assigneeId,
      labels: "[]",
      state: "",
      lease_holder: null,
      lease_until: null,
      auto_paused: 0,
      version: 1,
      last_post_at: now,
      created_by: me.id,
      created_at: now,
      updated_at: now,
    };
    newThread = true;
    stmts.push(
      db.stmt(
        "INSERT INTO threads (id, team_id, workspace_id, title, status, assignee_id, created_by, created_at, updated_at, last_post_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
        thread.id as string,
        team,
        ws.id as string,
        title,
        assigneeId,
        me.id,
        now,
        now,
        now,
      ),
    );
    if (assigneeId) stmts.push(participant(db, thread.id as string, assigneeId));
  }
  const threadId = thread.id as string;

  // Reply target must be in the same thread.
  let replyAuthor: string | null = null;
  if (input.reply_to) {
    const rp = await db.first<{ author_id: string; thread_id: string }>(
      "SELECT author_id, thread_id FROM posts WHERE id = ? AND team_id = ?",
      input.reply_to,
      team,
    );
    if (!rp || rp.thread_id !== threadId) throw bad("reply_to 不在这个讨论串里");
    replyAuthor = rp.author_id;
  }

  const { text: body, kinds: redactedKinds } = redact(input.body);

  // Mentions → member ids.
  const names = parseMentions(body);
  const mentionAll = names.includes("all");
  const named = names.filter((n) => n !== "all");
  const mentioned = named.length
    ? await db.all<{ id: string; name: string; kind: string; status: string }>(
        `SELECT id, name, kind, status FROM members WHERE name IN (${qmarks(named.length)}) AND kind != 'system' AND team_id = ?`,
        ...named,
        team,
      )
    : [];

  const targets = new Map<string, Target["reason"]>();
  const add = (id: string | null | undefined, reason: Target["reason"]) => {
    if (!id) return;
    const cur = targets.get(id);
    if (!cur || PRIORITY[reason] < PRIORITY[cur]) targets.set(id, reason);
  };
  for (const m of mentioned) add(m.id, "mention");
  if (mentionAll) {
    const parts = await db.all<{ member_id: string }>("SELECT member_id FROM thread_members WHERE thread_id = ?", threadId);
    for (const p of parts) add(p.member_id, "mention");
  }
  if (!input.system) add(thread.assignee_id as string | null, "assign");
  add(replyAuthor, "reply");
  for (const e of input.extra ?? []) add(e.id, e.reason);
  targets.delete(me.id);

  const ids = [...targets.keys()];
  const eligible = ids.length
    ? new Set(
        (
          await db.all<{ id: string }>(
            `SELECT id FROM members WHERE id IN (${qmarks(ids.length)}) AND kind = 'agent' AND status = 'active' AND team_id = ?`,
            ...ids,
            team,
          )
        ).map((r) => r.id),
      )
    : new Set<string>();

  const postId = newId("p", now);
  stmts.push(
    db.stmt(
      "INSERT INTO posts (id, team_id, thread_id, author_id, reply_to, body, kind, mentions, idempotency_key, redacted, usage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      postId,
      team,
      threadId,
      me.id,
      input.reply_to ?? null,
      body,
      kind,
      JSON.stringify(mentioned.map((m) => m.id)),
      idem,
      redactedKinds.length ? 1 : 0,
      cleanUsage(input.usage),
      now,
    ),
  );
  for (const [id, reason] of targets) {
    if (!eligible.has(id)) continue;
    stmts.push(
      db.stmt(
        "INSERT OR IGNORE INTO deliveries (id, team_id, member_id, thread_id, post_id, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        newId("d", now),
        team,
        id,
        threadId,
        postId,
        reason,
        now,
        now,
      ),
    );
  }
  if (!input.system) {
    stmts.push(participant(db, threadId, me.id));
    for (const m of mentioned) stmts.push(participant(db, threadId, m.id));
  }
  if (!newThread) {
    stmts.push(db.stmt("UPDATE threads SET last_post_at = ?, updated_at = ? WHERE id = ?", now, now, threadId));
  }

  if (kind === "confirm") {
    stmts.push(
      db.stmt(
        "INSERT INTO confirmations (id, team_id, thread_id, post_id, requester_id, question, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
        newId("c", now),
        team,
        threadId,
        postId,
        me.id,
        body,
      ),
      notify(db, "confirm_request", {
        title: `${me.name || me.id} 请求确认：${String(thread.title)}`,
        text: body.slice(0, 500),
        link: `/threads/${threadId}`,
      }),
    );
  }
  if (redactedKinds.length) {
    stmts.push(
      notify(db, "secret_redacted", {
        title: `${me.name || me.id} 的帖子里扫描到密钥（${redactedKinds.join(", ")}）`,
        text: "已打码后入库，原文未保存。建议立即轮换相关凭据。",
        link: `/threads/${threadId}`,
      }),
      db.audit(me.id, "post.redacted", postId, redactedKinds),
    );
  }
  stmts.push(db.bumpSeq());

  try {
    await db.batch(stmts);
  } catch (e) {
    if (idem && /UNIQUE/i.test(String((e as Error).message))) {
      const dup = await db.first("SELECT * FROM posts WHERE author_id = ? AND idempotency_key = ?", me.id, idem);
      if (dup) {
        const t = threadOut(await loadThread(db, dup.thread_id as string));
        return { post: (await hydratePosts(db, [dup]))[0], thread: t, duplicate: true, redacted: [] };
      }
    }
    throw e;
  }

  // Follow-ups that create their own system posts.
  if (redactedKinds.length && me.id !== SYSTEM_ID) {
    await createPost(env, systemFor(team), {
      thread_id: threadId,
      body: `这条帖子里有疑似凭据（${redactedKinds.join(", ")}），已打码后入库，原文未保存。请不要在帖子里贴凭据，并尽快轮换。`,
      kind: "system",
      reply_to: postId,
      system: true,
      extra: me.kind === "agent" ? [{ id: me.id, reason: "event" }] : [],
    });
  }
  if (me.kind === "agent") await checkFlood(env, team, threadId);

  const post = await loadPost(db, postId);
  return { post, thread: threadOut(await loadThread(db, threadId)), duplicate: false, redacted: redactedKinds };
}

export const systemMe: Me = { id: SYSTEM_ID, kind: "system", role: "agent", name: "system", status: "system", team_id: null };

/** The system author acting inside one team. */
export function systemFor(teamId: string | null): Me {
  return { ...systemMe, team_id: teamId };
}

function participant(db: DB, threadId: string, memberId: string) {
  return db.stmt("INSERT OR IGNORE INTO thread_members (thread_id, member_id) VALUES (?, ?)", threadId, memberId);
}

/** Two agents alternating more than FLOOD_LIMIT times within an hour → auto_paused. */
export async function checkFlood(env: Env, teamId: string, threadId: string, now = Date.now()) {
  const db = new DB(env.DB, teamId);
  const t = await db.first<{ auto_paused: number; flood_reset_at: number | null; title: string }>(
    "SELECT auto_paused, flood_reset_at, title FROM threads WHERE id = ? AND team_id = ?",
    threadId,
    teamId,
  );
  if (!t || t.auto_paused) return false;
  const since = Math.max(now - 3600_000, t.flood_reset_at ?? 0);
  const rows = await db.all<{ author_id: string }>(
    `SELECT p.author_id FROM posts p JOIN members m ON m.id = p.author_id
     WHERE p.thread_id = ? AND p.created_at >= ? AND m.kind = 'agent' ORDER BY p.rowid`,
    threadId,
    since,
  );
  // Count alternations per unordered author pair in the agent-only sequence.
  const pairs = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].author_id;
    const b = rows[i].author_id;
    if (a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const hit = [...pairs.entries()].find(([, n]) => n > FLOOD_LIMIT);
  if (!hit) return false;
  const [a, b] = hit[0].split("|");
  const names = await db.all<{ id: string; name: string }>("SELECT id, name FROM members WHERE id IN (?, ?)", a, b);
  const label = names.map((n) => "@" + n.name).join(" 和 ");
  await db.batch([
    db.stmt("UPDATE threads SET auto_paused = 1, updated_at = ? WHERE id = ?", now, threadId),
    notify(
      db,
      "flood_blocked",
      { title: `刷屏拦截：${t.title}`, text: `${label} 一小时内来回超过 ${FLOOD_LIMIT} 次，已暂停这个讨论串的自动投递。`, link: `/threads/${threadId}` },
      `flood:${threadId}`,
    ),
    db.audit(null, "thread.flood_blocked", threadId, { pair: [a, b], alternations: hit[1] }),
    db.bumpSeq(),
  ]);
  const admins = await db.all<{ name: string }>(
    "SELECT name FROM members WHERE kind = 'human' AND role IN ('owner', 'admin') AND status = 'active' AND team_id = ? ORDER BY created_at",
    teamId,
  );
  await createPost(env, systemFor(teamId), {
    thread_id: threadId,
    kind: "system",
    system: true,
    body: `${label} 在一小时内来回超过 ${FLOOD_LIMIT} 次，已暂停这个讨论串的自动投递。${admins.map((x) => "@" + x.name).join(" ")} 请在网页上检查后解除。`,
  });
  return true;
}

// ---------------------------------------------------------------- thread patch

export interface ThreadPatchInput {
  state?: string;
  assignee?: string | null;
  status?: string;
  labels?: string[];
  title?: string;
  version?: number;
  auto_paused?: boolean;
}

export async function patchThread(env: Env, me: Me, id: string, p: ThreadPatchInput) {
  const db = teamDb(env, me);
  const t = await loadThread(db, id);
  const now = Date.now();
  const isManager = await canManageWorkspace(db, me, t.workspace_id as string);
  const leaseMine = t.lease_holder === me.id && Number(t.lease_until ?? 0) > now;
  const isParticipant = !!(await db.first("SELECT 1 FROM thread_members WHERE thread_id = ? AND member_id = ?", id, me.id));
  const allowed =
    isManager ||
    t.assignee_id === me.id ||
    leaseMine ||
    t.created_by === me.id ||
    (t.assignee_id === null && isParticipant);
  if (!allowed) throw forbidden("只有负责人、持锁者或 Manager 能修改讨论串");
  if (p.auto_paused !== undefined) {
    if (!isAdmin(me)) throw forbidden("只有管理员能解除刷屏拦截");
    if (p.auto_paused !== false) throw bad("auto_paused 只能设为 false");
  }

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const events: string[] = [];
  let redactedKinds: string[] = [];
  let newAssignee: Row | null = null;

  if (p.state !== undefined) {
    if (typeof p.state !== "string" || p.state.length > MAX_STATE_CHARS) throw bad(`state 必须是不超过 ${MAX_STATE_CHARS} 字符的字符串`);
    const r = redact(p.state);
    redactedKinds = r.kinds;
    sets.push("state = ?");
    args.push(r.text);
  }
  if (p.title !== undefined) {
    if (typeof p.title !== "string" || !p.title.trim()) throw bad("title 不能为空");
    sets.push("title = ?");
    args.push(redact(p.title.trim().slice(0, 200)).text);
  }
  if (p.labels !== undefined) {
    if (!Array.isArray(p.labels) || p.labels.some((l) => typeof l !== "string")) throw bad("labels 必须是字符串数组");
    const labels = [...new Set(p.labels.map((l) => l.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
    sets.push("labels = ?");
    args.push(JSON.stringify(labels));
  }
  if (p.status !== undefined) {
    if (!["open", "done", "closed"].includes(p.status)) throw bad("status 只能是 open / done / closed");
    if (p.status !== t.status) {
      sets.push("status = ?");
      args.push(p.status);
      events.push(p.status === "open" ? "重新打开了讨论串" : p.status === "done" ? "把讨论串标记为完成" : "关闭了讨论串");
    }
  }
  if (p.assignee !== undefined) {
    if (p.assignee === null || p.assignee === "") {
      if (t.assignee_id !== null) {
        sets.push("assignee_id = NULL");
        events.push("取消了负责人");
      }
    } else {
      newAssignee = await resolveMember(db, String(p.assignee));
      if (!newAssignee || newAssignee.status !== "active") throw bad(`负责人 ${p.assignee} 不存在或未激活`);
      if (newAssignee.id === t.assignee_id) newAssignee = null;
      else {
        sets.push("assignee_id = ?");
        args.push(newAssignee.id as string);
        events.push(`把负责人改为 @${newAssignee.name}`);
      }
    }
  }
  if (p.auto_paused === false && t.auto_paused) {
    sets.push("auto_paused = 0", "flood_reset_at = ?");
    args.push(now);
    events.push("解除了刷屏拦截");
  }
  if (!sets.length) return { thread: threadOut(t), redacted: [] as string[] };

  sets.push("version = version + 1", "updated_at = ?");
  args.push(now);
  let where = "id = ?";
  args.push(id);
  if (p.version !== undefined && p.version !== null) {
    where += " AND version = ?";
    args.push(Number(p.version));
  }
  const stmts = [db.stmt(`UPDATE threads SET ${sets.join(", ")} WHERE ${where}`, ...args)];
  if (newAssignee) stmts.push(participant(db, id, newAssignee.id as string));
  if (p.status === "closed" || p.status === "done") {
    stmts.push(
      db.stmt(
        "UPDATE deliveries SET state = 'done', updated_at = ? WHERE thread_id = ? AND state IN ('pending', 'leased')",
        now,
        id,
      ),
      db.stmt("UPDATE threads SET lease_holder = NULL, lease_until = NULL WHERE id = ?", id),
    );
  }
  if (redactedKinds.length) {
    stmts.push(
      notify(db, "secret_redacted", {
        title: `${me.name} 更新讨论串状态时扫描到密钥（${redactedKinds.join(", ")}）`,
        text: "已打码后保存。建议立即轮换相关凭据。",
        link: `/threads/${id}`,
      }),
    );
  }
  stmts.push(db.audit(me.id, "thread.update", id, { ...p, state: p.state !== undefined ? "(updated)" : undefined }), db.bumpSeq());
  const res = await db.batch(stmts);
  if ((res[0].meta?.changes ?? 0) === 0) {
    const cur = await loadThread(db, id);
    throw new HttpError(409, "conflict", `讨论串已被其他人修改（当前版本 ${cur.version}），请刷新后重试`, { thread: threadOut(cur) });
  }
  if (events.length) {
    await createPost(env, systemFor(me.team_id), {
      thread_id: id,
      kind: "system",
      system: true,
      body: `${me.name || me.id} ${events.join("，")}`,
      extra: newAssignee ? [{ id: newAssignee.id as string, reason: "assign" }] : [],
    });
  }
  return { thread: threadOut(await loadThread(db, id)), redacted: redactedKinds };
}

// ---------------------------------------------------------------- confirmations

export async function decideConfirmation(env: Env, me: Me, id: string, decision: string, note?: string | null) {
  const db = teamDb(env, me);
  if (decision !== "approve" && decision !== "reject") throw bad("decision 只能是 approve 或 reject");
  const c = await db.first("SELECT * FROM confirmations WHERE id = ? AND team_id = ?", id, me.team_id);
  if (!c) throw notFound("确认请求");
  if (c.status !== "pending") throw conflict("这个确认请求已经处理过了");
  const now = Date.now();
  const status = decision === "approve" ? "approved" : "rejected";
  const cleanNote = note ? redact(String(note).slice(0, 2000)).text : null;
  const changed = await db.run(
    "UPDATE confirmations SET status = ?, decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'",
    status,
    me.id,
    now,
    cleanNote,
    id,
  );
  if (!changed) throw conflict("这个确认请求已经处理过了");
  await db.batch([db.audit(me.id, `confirmation.${decision}`, id, cleanNote), db.bumpSeq()]);
  const requester = await db.first<{ name: string }>("SELECT name FROM members WHERE id = ?", c.requester_id as string);
  await createPost(env, systemFor(me.team_id), {
    thread_id: c.thread_id as string,
    kind: "system",
    system: true,
    reply_to: c.post_id as string,
    body: `${me.name} ${decision === "approve" ? "✅ 批准了" : "❌ 拒绝了"} @${requester?.name ?? c.requester_id} 的确认请求${cleanNote ? `：${cleanNote}` : ""}`,
    extra: [{ id: c.requester_id as string, reason: "event" }],
  });
  const row = await db.first("SELECT * FROM confirmations WHERE id = ?", id);
  return row!;
}

// ---------------------------------------------------------------- inbox

export async function claim(env: Env, me: Me, maxThreads: number) {
  const db = teamDb(env, me);
  const cfg = await hubConfig(db);
  const now = Date.now();
  const leaseUntil = now + cfg.lease_s * 1000;
  const max = Math.max(1, Math.min(Math.floor(maxThreads) || cfg.max_claim_threads, 10));
  const cands = await db.all<{ thread_id: string; workspace_id: string }>(
    `SELECT d.thread_id, t.workspace_id, MIN(d.created_at) AS first_at
     FROM deliveries d JOIN threads t ON t.id = d.thread_id
     WHERE d.member_id = ? AND (d.state = 'pending' OR (d.state = 'leased' AND d.lease_until >= ?))
       AND t.auto_paused = 0 AND t.status != 'closed'
       AND (t.lease_holder IS NULL OR t.lease_holder = ? OR t.lease_until < ?)
     GROUP BY d.thread_id ORDER BY first_at LIMIT ?`,
    me.id,
    now,
    me.id,
    now,
    max,
  );
  const threads = [];
  for (const c of cands) {
    const got = await db.run(
      "UPDATE threads SET lease_holder = ?, lease_until = ? WHERE id = ? AND (lease_holder IS NULL OR lease_holder = ? OR lease_until < ?)",
      me.id,
      leaseUntil,
      c.thread_id,
      me.id,
      now,
    );
    if (!got) continue;
    await db.run(
      "UPDATE deliveries SET state = 'leased', lease_until = ?, updated_at = ? WHERE member_id = ? AND thread_id = ? AND (state = 'pending' OR state = 'leased')",
      leaseUntil,
      now,
      me.id,
      c.thread_id,
    );
    const ds = await db.all(
      "SELECT * FROM deliveries WHERE member_id = ? AND thread_id = ? AND state = 'leased' ORDER BY created_at",
      me.id,
      c.thread_id,
    );
    threads.push({
      thread_id: c.thread_id,
      workspace_id: c.workspace_id,
      lease_until: leaseUntil,
      deliveries: ds.map((d) => ({ id: d.id, thread_id: d.thread_id, post_id: d.post_id, reason: d.reason, attempts: Number(d.attempts) })),
    });
  }
  if (threads.length) await db.bumpSeq().run();
  return threads;
}

async function selectDeliveries(db: DB, me: Me, threadId: string, ids: unknown, states: string[]) {
  let sql = `SELECT id, attempts FROM deliveries WHERE member_id = ? AND thread_id = ? AND state IN (${qmarks(states.length)})`;
  const args: (string | number)[] = [me.id, threadId, ...states];
  if (Array.isArray(ids) && ids.length) {
    if (ids.length > 500) throw bad("delivery_ids 太多");
    sql += ` AND id IN (${qmarks(ids.length)})`;
    args.push(...ids.map(String));
  }
  return db.all<{ id: string; attempts: number }>(sql, ...args);
}

async function releaseThreadIfIdle(db: DB, me: Me, threadId: string) {
  const still = await db.first(
    "SELECT 1 FROM deliveries WHERE member_id = ? AND thread_id = ? AND state = 'leased'",
    me.id,
    threadId,
  );
  if (!still) {
    await db.run("UPDATE threads SET lease_holder = NULL, lease_until = NULL WHERE id = ? AND lease_holder = ?", threadId, me.id);
  }
}

export async function ack(env: Env, me: Me, threadId: string, ids: unknown) {
  const db = teamDb(env, me);
  if (!threadId) throw bad("需要 thread_id");
  const rows = await selectDeliveries(db, me, threadId, ids, Array.isArray(ids) && ids.length ? ["leased", "pending"] : ["leased"]);
  const now = Date.now();
  if (rows.length) {
    await db.batch([
      db.stmt(
        `UPDATE deliveries SET state = 'done', lease_until = NULL, updated_at = ? WHERE id IN (${qmarks(rows.length)})`,
        now,
        ...rows.map((r) => r.id),
      ),
      db.bumpSeq(),
    ]);
  }
  await releaseThreadIfIdle(db, me, threadId);
  return rows.length;
}

export async function nack(env: Env, me: Me, threadId: string, ids: unknown, reason: string) {
  const db = teamDb(env, me);
  if (!threadId) throw bad("需要 thread_id");
  const rows = await selectDeliveries(db, me, threadId, ids, ["leased"]);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const attempts = Number(r.attempts) + 1;
    stmts.push(
      db.stmt(
        "UPDATE deliveries SET state = ?, attempts = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
        attempts >= 5 ? "dead" : "pending",
        attempts,
        now,
        r.id,
      ),
    );
    if (attempts >= 5) stmts.push(deadNotice(db, me.name, threadId, r.id, reason));
  }
  if (rows.length) stmts.push(db.audit(me.id, "delivery.nack", threadId, { reason: String(reason ?? "").slice(0, 300), n: rows.length }), db.bumpSeq());
  await db.batch(stmts);
  await releaseThreadIfIdle(db, me, threadId);
  return rows.length;
}

export function deadNotice(db: DB, memberName: string, threadId: string, deliveryId: string, reason?: string) {
  return notify(
    db,
    "delivery_dead",
    {
      title: `@${memberName} 的一条消息重试 5 次仍未处理`,
      text: reason ? `最后原因：${String(reason).slice(0, 300)}` : undefined,
      link: `/threads/${threadId}`,
    },
    `dead:${deliveryId}`,
  );
}

export async function heartbeat(env: Env, me: Me, threadId?: string | null) {
  const db = teamDb(env, me);
  const cfg = await hubConfig(db);
  const now = Date.now();
  const until = now + cfg.lease_s * 1000;
  const tf = threadId ? " AND thread_id = ?" : "";
  const targs = threadId ? [threadId] : [];
  await db.batch([
    db.stmt(`UPDATE deliveries SET lease_until = ?, updated_at = ? WHERE member_id = ? AND state = 'leased'${tf}`, until, now, me.id, ...targs),
    db.stmt(`UPDATE threads SET lease_until = ? WHERE lease_holder = ?${threadId ? " AND id = ?" : ""}`, until, me.id, ...targs),
  ]);
  return until;
}

