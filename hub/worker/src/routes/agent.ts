import { Hono } from "hono";
import type { AppEnv, Me } from "../env";
import { SERVER_VERSION } from "../env";
import { DB, WORKSPACE_SELECT, deliveryOut, hydratePosts, memberOut, qmarks, threadOut, workspaceOut } from "../db";
import {
  ACTIVITY_STATES,
  ack,
  activityUpsert,
  canManageWorkspace,
  claim,
  createPost,
  heartbeat,
  hubConfig,
  loadThread,
  managerScopes,
  nack,
  patchThread,
  requireManager,
} from "../core";
import { isValidPublicKey } from "../auth";
import { hubEvent, ingestEvents } from "../analytics";
import { handleDownload, handleUpload } from "../files";
import { encryptUrl, validTriggerUrl } from "../crypto";
import {
  approveMember,
  budgetFor,
  listMembers,
  loadMember,
  membersByIds,
  pauseMember,
  putQuotaRules,
  quotaRules,
  rejectMember,
  resumeMember,
} from "../members";
import { notify } from "../notify";
import { evaluatePause } from "../pause";
import { redact } from "../redact";
import { HttpError, NAME_RE, RESERVED_NAMES, bad, clampLimit, conflict, forbidden, newId, notFound, sha256Hex } from "../util";
import { createWorkspace, updateWorkspace, workspaceDetail } from "./shared";

type Body = Record<string, unknown>;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const agent = new Hono<AppEnv>();

const body = (c: { get: (k: "body") => unknown }) => (c.get("body") ?? {}) as Body;

// ---------------------------------------------------------------- join

agent.post("/join", async (c) => {
  const root = new DB(c.env.DB);
  const b = body(c);
  const pk = b.public_key as string;
  if (!isValidPublicKey(pk)) throw bad("public_key 无效");

  // Same key re-submitting: return the original record (idempotent join).
  const existing = await root.first<{ member_id: string }>("SELECT member_id FROM member_keys WHERE public_key = ?", pk);
  if (existing) {
    const m = await root.first<{ id: string; status: string; team_id: string | null }>(
      "SELECT id, status, team_id FROM members WHERE id = ?",
      existing.member_id,
    );
    if (m) {
      const t = m.team_id ? await root.first<{ id: string; name: string }>("SELECT id, name FROM teams WHERE id = ?", m.team_id) : null;
      return c.json({ member_id: m.id, status: m.status, team: t ? { id: t.id, name: t.name } : null });
    }
  }

  const code = str(b.join_code, 100);
  if (!code) throw new HttpError(400, "join_code_required", "需要加入码（join_code），请向团队管理员索取");

  // 10 join attempts per IP per hour.
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const ipHash = (await sha256Hex(`join:${ip}`)).slice(0, 16);
  const now = Date.now();
  const recent = await root.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'join.attempt' AND target = ? AND created_at > ?",
    ipHash,
    now - 3600_000,
  );
  if ((recent?.n ?? 0) >= 10) throw new HttpError(429, "rate_limited", "加入申请过于频繁，请一小时后再试");
  await root.audit(null, "join.attempt", ipHash).run();

  const jc = await root.first<{ id: string; team_id: string; expires_at: number | null; revoked_at: number | null }>(
    "SELECT id, team_id, expires_at, revoked_at FROM join_codes WHERE code_hash = ?",
    await sha256Hex(code),
  );
  const team = jc ? await root.first<{ id: string; name: string }>("SELECT id, name FROM teams WHERE id = ?", jc.team_id) : null;
  if (!jc || !team || jc.revoked_at != null || (jc.expires_at != null && jc.expires_at <= now)) {
    throw new HttpError(403, "bad_join_code", "加入码无效、已过期或已作废");
  }
  const db = root.forTeam(team.id);

  const name = str(b.name, 32).toLowerCase();
  if (!NAME_RE.test(name) || RESERVED_NAMES.has(name)) throw bad("名字只能用小写字母、数字、- 和 _，2–32 位，且不能是保留字");
  const cli = str(b.cli, 32);
  if (!cli) throw bad("需要 cli");
  const wake = str(b.wake_mode, 10) || "poll";
  if (wake !== "poll" && wake !== "trigger") throw bad("wake_mode 只能是 poll 或 trigger");
  const interval = Math.floor(Number(b.wake_interval_s ?? 300));
  if (!Number.isFinite(interval) || interval < 60 || interval > 86400) throw bad("wake_interval_s 必须在 60..86400 之间");
  let trigger: { ciphertext: string; iv: string } | null = null;
  if (b.trigger_url) {
    if (!validTriggerUrl(b.trigger_url)) throw bad("trigger_url 必须是 https 地址");
    trigger = await encryptUrl(c.env, b.trigger_url);
  } else if (wake === "trigger") {
    throw bad("wake_mode=trigger 时需要 trigger_url");
  }
  if (await db.first("SELECT 1 FROM members WHERE team_id = ? AND name = ?", team.id, name)) throw conflict(`名字 ${name} 已被占用`);

  const id = newId("m", now);
  const display = str(b.display_name, 64) || name;
  const stmts = [
    db.stmt(
      `INSERT INTO members (id, team_id, kind, role, name, display_name, cli, wake_mode, wake_interval_s, owner, machine, client_version, status, created_at)
       VALUES (?, ?, 'agent', 'agent', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      team.id,
      name,
      display,
      cli,
      wake,
      interval,
      str(b.owner, 64) || null,
      str(b.machine, 200) || null,
      str(b.client_version, 32) || null,
      now,
    ),
    db.stmt("INSERT INTO member_keys (member_id, public_key, created_at) VALUES (?, ?, ?)", id, pk, now),
    db.stmt("UPDATE join_codes SET uses = uses + 1, last_used_at = ? WHERE id = ?", now, jc.id),
    notify(db, "join_request", {
      title: `${display}（@${name}）申请加入`,
      text: `CLI：${cli} · 唤醒：${wake} / ${interval}s · 主人：${str(b.owner, 64) || "未填"} · 机器：${str(b.machine, 200) || "未填"}`,
      link: `/members/${id}`,
    }),
    db.audit(null, "member.join", id, { name, cli, wake, interval, join_code: jc.id }),
    db.bumpSeq(),
    hubEvent(db, "member.join", {}, id, now),
  ];
  if (trigger) {
    stmts.push(db.stmt("INSERT INTO triggers (member_id, url_ciphertext, iv) VALUES (?, ?, ?)", id, trigger.ciphertext, trigger.iv));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw conflict(`名字 ${name} 已被占用`);
    throw e;
  }
  return c.json({ member_id: id, status: "pending", team: { id: team.id, name: team.name } });
});

// ---------------------------------------------------------------- state

agent.get("/state", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  if (me.status === "active") await evaluatePause(c.env, me.id);
  const [m, s, cfg, rules, budget, pending, team] = await Promise.all([
    loadMember(db, me.id),
    db.settings(),
    hubConfig(db),
    quotaRules(db, me.id),
    budgetFor(db, me.id),
    db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deliveries d JOIN threads t ON t.id = d.thread_id
       WHERE d.member_id = ? AND d.state = 'pending' AND t.auto_paused = 0`,
      me.id,
    ),
    db.first<{ id: string; name: string }>("SELECT id, name FROM teams WHERE id = ?", me.team_id),
  ]);
  return c.json({
    member: memberOut(m),
    team: team ? { id: team.id, name: team.name } : null,
    global_pause: s.global_pause === "1",
    min_client_version: s.min_client_version ?? "0.0.0",
    server_version: SERVER_VERSION,
    config: cfg,
    quota_rules: rules,
    budget,
    pending: pending?.n ?? 0,
  });
});

// ---------------------------------------------------------------- inbox

agent.post("/claim", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const b = body(c);
  const p = await evaluatePause(c.env, me.id);
  if (p.paused) return c.json({ threads: [], paused: true, pause_reason: p.pause_reason, paused_until: p.paused_until });
  const cfg = await hubConfig(db);
  const threads = await claim(c.env, me, Number(b.max_threads ?? cfg.max_claim_threads));
  return c.json({ threads, paused: false });
});

agent.post("/ack", async (c) => {
  const b = body(c);
  return c.json({ acked: await ack(c.env, c.get("me"), str(b.thread_id, 40), b.delivery_ids) });
});

agent.post("/nack", async (c) => {
  const b = body(c);
  return c.json({ released: await nack(c.env, c.get("me"), str(b.thread_id, 40), b.delivery_ids, str(b.reason, 500)) });
});

agent.post("/heartbeat", async (c) => {
  const b = body(c);
  return c.json({ lease_until: await heartbeat(c.env, c.get("me"), str(b.thread_id, 40) || null) });
});

// ---------------------------------------------------------------- reading

export async function threadParticipants(db: DB, threadId: string, extra: string[] = []) {
  const rows = await db.all<{ member_id: string }>(
    `SELECT member_id FROM thread_members WHERE thread_id = ?
     UNION SELECT DISTINCT author_id FROM posts WHERE thread_id = ?`,
    threadId,
    threadId,
  );
  return membersByIds(db, [...rows.map((r) => r.member_id), ...extra]);
}

agent.get("/context", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const id = c.req.query("thread") ?? "";
  const t = await loadThread(db, id);
  const cfg = await hubConfig(db);
  const n = clampLimit(c.req.query("limit"), cfg.context_posts, 200);
  const rows = await db.all("SELECT * FROM posts WHERE thread_id = ? ORDER BY id DESC LIMIT ?", id, n + 1);
  const hasMore = rows.length > n;
  const posts = await hydratePosts(db, rows.slice(0, n).reverse(), "agent");
  const [ws, ds, members, meRow] = await Promise.all([
    db.first(`${WORKSPACE_SELECT} WHERE w.id = ? AND w.team_id = ?`, t.workspace_id as string, db.team),
    db.all("SELECT * FROM deliveries WHERE member_id = ? AND thread_id = ? AND state = 'leased' ORDER BY created_at", me.id, id),
    threadParticipants(db, id, [t.assignee_id as string]),
    loadMember(db, me.id),
  ]);
  return c.json({
    workspace: ws ? workspaceOut(ws) : null,
    thread: threadOut(t),
    posts,
    has_more: hasMore,
    deliveries: ds.map(deliveryOut),
    members,
    me: memberOut(meRow),
  });
});

export async function postsPage(db: DB, threadId: string, before: string | undefined, limit: number) {
  await loadThread(db, threadId);
  const rows = before
    ? await db.all("SELECT * FROM posts WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?", threadId, before, limit + 1)
    : await db.all("SELECT * FROM posts WHERE thread_id = ? ORDER BY id DESC LIMIT ?", threadId, limit + 1);
  return { posts: await hydratePosts(db, rows.slice(0, limit).reverse(), "agent"), has_more: rows.length > limit };
}

agent.get("/posts", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  return c.json(await postsPage(db, c.req.query("thread") ?? "", c.req.query("before"), clampLimit(c.req.query("limit"))));
});

agent.post("/posts", async (c) => {
  const b = body(c);
  if (!b.idempotency_key) throw bad("需要 idempotency_key");
  const r = await createPost(c.env, c.get("me"), {
    thread_id: str(b.thread_id, 40) || undefined,
    workspace_id: str(b.workspace_id, 40) || undefined,
    title: typeof b.title === "string" ? b.title : undefined,
    assignee: str(b.assignee, 40) || null,
    body: b.body as string,
    kind: str(b.kind, 16) || "msg",
    reply_to: str(b.reply_to, 40) || null,
    idempotency_key: String(b.idempotency_key),
    usage: b.usage,
    model: str(b.model, 64) || null,
    cli: str(b.cli, 64) || null,
    attachments: b.attachments,
    urlBase: "agent",
  });
  return c.json(r);
});

// ---------------------------------------------------------------- live status + files

agent.post("/activity", async (c) => {
  const me = c.get("me");
  const db = new DB(c.env.DB, me.team_id);
  const b = body(c);
  const state = str(b.state, 16);
  if (!(ACTIVITY_STATES as readonly string[]).includes(state)) throw bad("state 只能是 claimed / running / typing / done / failed");
  if (b.detail != null && (typeof b.detail !== "string" || b.detail.length > 200)) throw bad("detail 不能超过 200 个字符");
  const threadId = str(b.thread_id, 40);
  if (!threadId) throw bad("需要 thread_id");
  await loadThread(db, threadId);
  const opt = (v: unknown) => (v == null ? undefined : str(v, 64) || null);
  const now = Date.now();
  await activityUpsert(db, me.id, threadId, state, now, {
    detail: b.detail == null ? undefined : redact(String(b.detail)).text,
    cli: opt(b.cli),
    model: opt(b.model),
  }).run();
  return c.json({ ok: true, at: now });
});

agent.post("/uploads", (c) => handleUpload(c, "agent"));
agent.get("/files/:id", (c) => handleDownload(c));

agent.post("/events", async (c) => {
  const me = c.get("me");
  return c.json({ accepted: await ingestEvents(new DB(c.env.DB, me.team_id), "cli", me.id, body(c)) });
});

agent.patch("/threads/:id", async (c) => {
  const b = body(c);
  if ("auto_paused" in b) throw forbidden("只有管理员能解除刷屏拦截");
  const { thread } = await patchThread(c.env, c.get("me"), c.req.param("id"), b);
  return c.json({ thread });
});

export async function listThreads(db: DB, q: { workspace?: string; status?: string; assignee?: string }) {
  const where: string[] = ["team_id = ?"];
  const args: (string | null)[] = [db.team];
  if (q.workspace) {
    where.push("workspace_id = ?");
    args.push(q.workspace);
  }
  if (q.status) {
    where.push("status = ?");
    args.push(q.status);
  }
  if (q.assignee) {
    where.push("assignee_id = ?");
    args.push(q.assignee);
  }
  const rows = await db.all(
    `SELECT * FROM threads WHERE ${where.join(" AND ")} ORDER BY COALESCE(last_post_at, created_at) DESC LIMIT 200`,
    ...args,
  );
  return rows.map(threadOut);
}

agent.get("/threads", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const mine = c.req.query("mine");
  return c.json({
    threads: await listThreads(db, {
      workspace: c.req.query("workspace"),
      status: c.req.query("status"),
      assignee: mine && mine !== "0" && mine !== "false" ? me.id : undefined,
    }),
  });
});

agent.get("/workspaces", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const rows = await db.all(`${WORKSPACE_SELECT} WHERE w.team_id = ? ORDER BY w.status, w.updated_at DESC`, db.team);
  return c.json({ workspaces: rows.map(workspaceOut) });
});

agent.get("/workspaces/:id", async (c) => {
  return c.json(await workspaceDetail(new DB(c.env.DB, c.get("me").team_id), c.req.param("id")));
});

// ---------------------------------------------------------------- telemetry

const RUN_INT = ["input", "cache_write", "cache_read", "output", "reasoning"] as const;

agent.post("/runs", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const runs = body(c).runs;
  if (!Array.isArray(runs) || runs.length > 200) throw bad("runs 必须是数组（最多 200 条）");
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  // Client-supplied thread ids are kept only when the thread is in my team (hub-api.md §0.1).
  const tids = [...new Set((runs as Body[]).map((r) => (r && typeof r === "object" ? str(r.thread_id, 40) : "")).filter(Boolean))];
  const ownThreads = new Set(
    tids.length
      ? (await db.all<{ id: string }>(`SELECT id FROM threads WHERE team_id = ? AND id IN (${qmarks(tids.length)})`, db.team, ...tids)).map((t) => t.id)
      : [],
  );
  for (const raw of runs as Body[]) {
    const id = str(raw.id, 40);
    if (!/^r_[0-9a-z]{26}$/.test(id)) throw bad(`run id 无效：${id}`);
    const started = Number(raw.started_at);
    const ended = Number(raw.ended_at ?? started);
    if (!Number.isFinite(started) || !Number.isFinite(ended)) throw bad("started_at / ended_at 无效");
    const ints = RUN_INT.map((k) => Math.max(0, Math.floor(Number(raw[k]) || 0)));
    const cost = raw.cost_usd_est == null || !Number.isFinite(Number(raw.cost_usd_est)) ? null : Math.max(0, Number(raw.cost_usd_est));
    const err = raw.error_summary == null ? null : redact(String(raw.error_summary).slice(0, 2000)).text;
    stmts.push(
      db.stmt(
        `INSERT OR IGNORE INTO runs (id, team_id, member_id, thread_id, started_at, ended_at, exit_code, cli, model, input, cache_write, cache_read, output, reasoning, cost_usd_est, error_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        me.team_id,
        me.id,
        ownThreads.has(str(raw.thread_id, 40)) ? str(raw.thread_id, 40) : null,
        Math.floor(started),
        Math.floor(ended),
        Math.floor(Number(raw.exit_code) || 0),
        str(raw.cli, 32) || null,
        str(raw.model, 100) || null,
        ...ints,
        cost,
        err,
        now,
      ),
    );
  }
  // Attribute this member's posts written during a run to the run's model (v06-contract §2).
  for (const raw of runs as Body[]) {
    const tid = str(raw.thread_id, 40);
    const model = str(raw.model, 64);
    if (!tid || !model || !ownThreads.has(tid)) continue;
    const started = Math.floor(Number(raw.started_at));
    const ended = Math.floor(Number(raw.ended_at ?? raw.started_at));
    stmts.push(
      db.stmt(
        "UPDATE posts SET model = ? WHERE author_id = ? AND thread_id = ? AND team_id = ? AND model IS NULL AND created_at BETWEEN ? AND ?",
        model,
        me.id,
        tid,
        db.team,
        started,
        ended + 60_000,
      ),
    );
  }
  const res = await db.batch(stmts);
  const accepted = res.slice(0, runs.length).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  if (accepted) {
    await db.bumpSeq().run();
    await checkRunFailures(c.env, me);
    await evaluatePause(c.env, me.id);
  }
  return c.json({ accepted });
});

/** Email once when an agent's three latest runs (excluding baselines) all failed. */
async function checkRunFailures(env: AppEnv["Bindings"], me: Me) {
  const db = new DB(env.DB, me.team_id);
  const last = await db.all<{ id: string; exit_code: number; error_summary: string | null }>(
    "SELECT id, exit_code, error_summary FROM runs WHERE member_id = ? AND team_id = ? AND COALESCE(error_summary, '') != 'baseline' ORDER BY started_at DESC LIMIT 4",
    me.id,
    db.team,
  );
  const failed = (r?: { exit_code: number }) => !!r && r.exit_code !== 0;
  if (last.length >= 3 && failed(last[0]) && failed(last[1]) && failed(last[2]) && !failed(last[3])) {
    await notify(
      db,
      "run_failures",
      {
        title: `@${me.name} 连续 3 轮运行失败`,
        text: last
          .slice(0, 3)
          .map((r) => `exit ${r.exit_code}${r.error_summary ? `：${r.error_summary.slice(0, 200)}` : ""}`)
          .join("\n"),
        link: `/members/${me.id}`,
      },
      `run_failures:${me.id}:${last[2].id}`,
    ).run();
  }
}

agent.post("/quota", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const readings = body(c).readings;
  if (!Array.isArray(readings) || readings.length > 200) throw bad("readings 必须是数组（最多 200 条）");
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of readings as Body[]) {
    const provider = str(r.provider, 64);
    const window = str(r.window, 32);
    if (!provider || !window) continue;
    const source = str(r.source, 16) === "magpie" ? "magpie" : "native";
    const used = r.used_pct == null || !Number.isFinite(Number(r.used_pct)) ? null : Math.max(0, Number(r.used_pct));
    const resets = r.resets_at == null || !Number.isFinite(Number(r.resets_at)) ? null : Math.floor(Number(r.resets_at));
    let balance: string | null = null;
    const bal = r.balance as Body | null | undefined;
    if (bal && Number.isFinite(Number(bal.amount))) balance = JSON.stringify({ amount: Number(bal.amount), currency: str(bal.currency, 8) || "USD" });
    const readAt = Number.isFinite(Number(r.read_at)) && Number(r.read_at) > 0 ? Math.min(Math.floor(Number(r.read_at)), now) : now;
    stmts.push(
      db.stmt(
        `INSERT INTO quota_readings (member_id, provider, account, window, source, plan, used_pct, resets_at, balance_json, read_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id, provider, account, window, source) DO UPDATE SET
           plan = excluded.plan, used_pct = excluded.used_pct, resets_at = excluded.resets_at,
           balance_json = excluded.balance_json, read_at = excluded.read_at, error = excluded.error`,
        me.id,
        provider,
        str(r.account, 120),
        window,
        source,
        str(r.plan, 64) || null,
        used,
        resets,
        balance,
        readAt,
        r.error ? redact(String(r.error).slice(0, 300)).text : null,
      ),
    );
  }
  if (stmts.length) {
    stmts.push(db.bumpSeq());
    await db.batch(stmts);
  }
  const p = await evaluatePause(c.env, me.id);
  return c.json(p);
});

agent.post("/keys/rotate", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const pk = body(c).new_public_key;
  if (!isValidPublicKey(pk)) throw bad("new_public_key 无效");
  if (await db.first("SELECT 1 FROM member_keys WHERE public_key = ?", pk)) throw conflict("这个公钥已经在用了");
  const now = Date.now();
  const exp = now + 24 * 3600_000;
  await db.batch([
    db.stmt(
      "UPDATE member_keys SET expires_at = ? WHERE member_id = ? AND (expires_at IS NULL OR expires_at > ?)",
      exp,
      me.id,
      exp,
    ),
    db.stmt("INSERT INTO member_keys (member_id, public_key, created_at) VALUES (?, ?, ?)", me.id, pk, now),
    db.audit(me.id, "member.key_rotate", me.id),
    db.bumpSeq(),
  ]);
  return c.json({ ok: true, old_key_expires_at: exp });
});

// ---------------------------------------------------------------- manager

const manage = new Hono<AppEnv>();
manage.use("*", async (c, next) => {
  requireManager(c.get("me"));
  await next();
});

manage.get("/members", async (c) => c.json({ members: await listMembers(new DB(c.env.DB, c.get("me").team_id)) }));
manage.post("/members/:id/approve", async (c) => c.json({ member: await approveMember(c.env, c.get("me"), c.req.param("id")) }));
manage.post("/members/:id/reject", async (c) => c.json(await rejectMember(c.env, c.get("me"), c.req.param("id"))));
manage.post("/members/:id/pause", async (c) => {
  const b = body(c);
  return c.json({ member: await pauseMember(c.env, c.get("me"), c.req.param("id"), b.reason, b.until) });
});
manage.post("/members/:id/resume", async (c) => c.json({ member: await resumeMember(c.env, c.get("me"), c.req.param("id")) }));
manage.put("/members/:id/quota-rules", async (c) => c.json(await putQuotaRules(c.env, c.get("me"), c.req.param("id"), body(c).rules)));

manage.post("/workspaces", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const ws = await createWorkspace(c.env, me, body(c));
  const scopes = await managerScopes(db, me.id);
  if (scopes !== null) {
    await db.run("INSERT OR IGNORE INTO manager_scopes (manager_id, workspace_id) VALUES (?, ?)", me.id, ws.id);
  }
  return c.json({ workspace: ws });
});

manage.patch("/workspaces/:id", async (c) => {
  const db = new DB(c.env.DB, c.get("me").team_id);
  const me = c.get("me");
  const id = c.req.param("id");
  if (!(await db.first("SELECT 1 FROM workspaces WHERE id = ? AND team_id = ?", id, db.team))) throw notFound("工作区");
  if (!(await canManageWorkspace(db, me, id))) throw forbidden("这个工作区不在你的管理范围内");
  return c.json({ workspace: await updateWorkspace(c.env, me, id, body(c)) });
});

agent.route("/manage", manage);

export { qmarks };
