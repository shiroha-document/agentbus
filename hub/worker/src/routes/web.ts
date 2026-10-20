// Web (admin) API — hub-api.md §6. Mounted at /api/v1/web behind accessAuth.
import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import {
  DB,
  WORKSPACE_SELECT,
  confirmationOut,
  hydratePosts,
  memberOut,
  quotaOut,
  qmarks,
  reactionsFor,
  runOut,
  threadOut,
  workspaceOut,
  type Arg,
  type Row,
} from "../db";
import { createPost, decideConfirmation, loadThread, patchThread, resolveMember } from "../core";
import {
  approveMember,
  budgetFor,
  deleteMember,
  listMembers,
  loadMember,
  pauseMember,
  putBudget,
  putQuotaRules,
  quotaRules,
  rejectMember,
  resumeMember,
  revokeMember,
} from "../members";
import { KIND_LABELS, flushNotifications, notify } from "../notify";
import { TOKENS_SQL, evaluatePause } from "../pause";
import { bad, clampLimit, conflict, escapeHtml, maskEmail, notFound, randomToken, sha256Hex, shDayKey, shDayStart } from "../util";
import { listThreads, threadParticipants } from "./agent";
import { createWorkspace, updateWorkspace, workspaceDetail } from "./shared";

type Body = Record<string, unknown>;
const body = (c: { get: (k: "body") => unknown }) => {
  const b = c.get("body");
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Body;
};
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const DAY = 86400_000;
const SH_DAY_SQL = (col: string) => `strftime('%Y-%m-%d', (${col} + 28800000) / 1000, 'unixepoch')`;

export const web = new Hono<AppEnv>();

// ---------------------------------------------------------------- me / changes

web.get("/me", async (c) => {
  const db = new DB(c.env.DB);
  return c.json({ member: memberOut(await loadMember(db, c.get("me").id)), admin: true });
});

web.patch("/me", async (c) => {
  const db = new DB(c.env.DB);
  const me = c.get("me");
  const b = body(c);
  const sets: string[] = [];
  const args: Arg[] = [];
  if ("display_name" in b) {
    const d = str(b.display_name, 64);
    if (!d) throw bad("display_name 不能为空");
    sets.push("display_name = ?");
    args.push(d);
  }
  if ("avatar_url" in b) {
    const u = str(b.avatar_url, 500);
    if (u && !/^https:\/\/[^\s]+$/.test(u)) throw bad("avatar_url 必须是 https 地址");
    sets.push("avatar_url = ?");
    args.push(u || null);
  }
  if (sets.length) {
    await db.batch([db.stmt(`UPDATE members SET ${sets.join(", ")} WHERE id = ?`, ...args, me.id), db.bumpSeq()]);
  }
  return c.json({ member: memberOut(await loadMember(db, me.id)), admin: true });
});

web.get("/changes", async (c) => {
  const db = new DB(c.env.DB);
  const seq = Number((await db.setting("change_seq")) ?? 0);
  const since = Number(c.req.query("since") ?? 0);
  c.header("cache-control", "no-store");
  if (since === seq) return c.body(null, 304);
  return c.json({ seq });
});

// ---------------------------------------------------------------- dashboard / feed

web.get("/dashboard", async (c) => {
  const db = new DB(c.env.DB);
  const now = Date.now();
  const today = shDayStart(now);
  const [active, pending, confs, heat, agents, postsToday, usage] = await Promise.all([
    db.all("SELECT * FROM threads WHERE status = 'open' ORDER BY COALESCE(last_post_at, created_at) DESC LIMIT 20"),
    db.all("SELECT * FROM members WHERE status = 'pending' AND kind = 'agent' ORDER BY created_at"),
    db.all("SELECT * FROM confirmations WHERE status = 'pending' ORDER BY id"),
    db.all<{ day: string; count: number }>(
      `SELECT ${SH_DAY_SQL("created_at")} AS day, COUNT(*) AS count FROM posts WHERE created_at >= ? GROUP BY day ORDER BY day`,
      today - 364 * DAY,
    ),
    db.all("SELECT * FROM members WHERE kind = 'agent' AND status = 'active'"),
    db.first<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE created_at >= ?", today),
    db.first<{ tokens: number; cost: number }>(
      `SELECT ${TOKENS_SQL} AS tokens, COALESCE(SUM(cost_usd_est), 0) AS cost FROM runs WHERE started_at >= ?`,
      today,
    ),
  ]);
  return c.json({
    active_threads: active.map(threadOut),
    pending_joins: pending.map((m) => memberOut(m, now)),
    pending_confirmations: confs.map(confirmationOut),
    heatmap: heat.map((h) => ({ day: h.day, count: Number(h.count) })),
    stats: {
      agents_online: agents.filter((a) => memberOut(a, now).online).length,
      agents_total: agents.length,
      posts_today: Number(postsToday?.n ?? 0),
      tokens_today: Number(usage?.tokens ?? 0),
      cost_today: Math.round(Number(usage?.cost ?? 0) * 10000) / 10000,
    },
  });
});

web.get("/feed", async (c) => {
  const db = new DB(c.env.DB);
  const limit = clampLimit(c.req.query("limit"), 30);
  const before = c.req.query("before");
  const rows = before
    ? await db.all("SELECT * FROM posts WHERE id < ? ORDER BY id DESC LIMIT ?", before, limit + 1)
    : await db.all("SELECT * FROM posts ORDER BY id DESC LIMIT ?", limit + 1);
  const page = rows.slice(0, limit);
  const posts = await hydratePosts(db, page);
  const tids = [...new Set(page.map((p) => p.thread_id as string))];
  const threads = tids.length
    ? await db.all<{ id: string; title: string; workspace_id: string; ws_name: string }>(
        `SELECT t.id, t.title, t.workspace_id, w.name AS ws_name FROM threads t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE t.id IN (${qmarks(tids.length)})`,
        ...tids,
      )
    : [];
  const tmap = new Map(threads.map((t) => [t.id, t]));
  return c.json({
    items: posts.map((p) => {
      const t = tmap.get(p.thread_id);
      return {
        post: p,
        thread: { id: p.thread_id, title: t?.title ?? "" },
        workspace: { id: t?.workspace_id ?? "", name: t?.ws_name ?? "" },
      };
    }),
    has_more: rows.length > limit,
  });
});

// ---------------------------------------------------------------- workspaces

web.get("/workspaces", async (c) => {
  const db = new DB(c.env.DB);
  const rows = await db.all(`${WORKSPACE_SELECT} ORDER BY w.status, w.updated_at DESC`);
  return c.json({ workspaces: rows.map(workspaceOut) });
});
web.post("/workspaces", async (c) => c.json({ workspace: await createWorkspace(c.env, c.get("me"), body(c)) }));
web.get("/workspaces/:id", async (c) => c.json(await workspaceDetail(new DB(c.env.DB), c.req.param("id"))));
web.patch("/workspaces/:id", async (c) =>
  c.json({ workspace: await updateWorkspace(c.env, c.get("me"), c.req.param("id"), body(c)) }),
);

// ---------------------------------------------------------------- threads / posts

web.get("/threads", async (c) => {
  const db = new DB(c.env.DB);
  let assignee = c.req.query("assignee");
  if (assignee) assignee = ((await resolveMember(db, assignee))?.id as string) ?? assignee;
  return c.json({
    threads: await listThreads(db, { workspace: c.req.query("workspace"), status: c.req.query("status"), assignee }),
  });
});

web.post("/threads", async (c) => {
  const b = body(c);
  const r = await createPost(c.env, c.get("me"), {
    workspace_id: str(b.workspace_id, 40) || undefined,
    title: typeof b.title === "string" ? b.title : undefined,
    assignee: str(b.assignee, 40) || null,
    body: b.body as string,
  });
  return c.json({ thread: r.thread, post: r.post, redacted: r.redacted });
});

web.get("/threads/:id", async (c) => {
  const db = new DB(c.env.DB);
  const id = c.req.param("id");
  const t = await loadThread(db, id);
  const rows = await db.all("SELECT * FROM posts WHERE thread_id = ? ORDER BY id DESC LIMIT 200", id);
  const [posts, ws, members] = await Promise.all([
    hydratePosts(db, rows.reverse()),
    db.first(`${WORKSPACE_SELECT} WHERE w.id = ?`, t.workspace_id as string),
    threadParticipants(db, id, [t.assignee_id as string]),
  ]);
  return c.json({ thread: threadOut(t), workspace: ws ? workspaceOut(ws) : null, posts, members });
});

web.patch("/threads/:id", async (c) => {
  const { thread } = await patchThread(c.env, c.get("me"), c.req.param("id"), body(c));
  return c.json({ thread });
});

web.post("/posts", async (c) => {
  const b = body(c);
  if (!str(b.thread_id, 40)) throw bad("需要 thread_id");
  const r = await createPost(c.env, c.get("me"), {
    thread_id: str(b.thread_id, 40),
    body: b.body as string,
    reply_to: str(b.reply_to, 40) || null,
    idempotency_key: str(b.idempotency_key, 200) || null,
  });
  return c.json({ post: r.post, redacted: r.redacted });
});

web.post("/posts/:id/reactions", async (c) => {
  const db = new DB(c.env.DB);
  const me = c.get("me");
  const id = c.req.param("id");
  const emoji = str(body(c).emoji, 32);
  if (!emoji || /\s/.test(emoji) || [...emoji].length > 8) throw bad("emoji 无效");
  if (!(await db.first("SELECT 1 FROM posts WHERE id = ?", id))) throw notFound("帖子");
  const removed = await db.run("DELETE FROM reactions WHERE post_id = ? AND member_id = ? AND emoji = ?", id, me.id, emoji);
  if (!removed) {
    const n = await db.first<{ n: number }>("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE post_id = ?", id);
    if ((n?.n ?? 0) >= 20) throw bad("这条帖子的表情太多了");
    await db.run("INSERT OR IGNORE INTO reactions (post_id, member_id, emoji) VALUES (?, ?, ?)", id, me.id, emoji);
  }
  await db.bumpSeq().run();
  return c.json({ reactions: await reactionsFor(db, id) });
});

web.post("/confirmations/:id", async (c) => {
  const b = body(c);
  const row = await decideConfirmation(c.env, c.get("me"), c.req.param("id"), str(b.decision, 10), typeof b.note === "string" ? b.note : null);
  return c.json({ confirmation: confirmationOut(row) });
});

// ---------------------------------------------------------------- members

/** Latest reading per provider/account/window (native wins ties over magpie). */
function latestQuota(rows: Row[]) {
  const best = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.member_id}|${r.provider}|${r.account}|${r.window}`;
    const cur = best.get(k);
    if (!cur || Number(r.read_at) > Number(cur.read_at) || (Number(r.read_at) === Number(cur.read_at) && r.source === "native")) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => String(a.provider).localeCompare(String(b.provider)) || String(a.window).localeCompare(String(b.window)));
}

web.get("/members", async (c) => {
  const db = new DB(c.env.DB);
  const today = shDayStart(Date.now());
  const [members, quota, lastRuns, todays] = await Promise.all([
    listMembers(db),
    db.all("SELECT * FROM quota_readings"),
    db.all(
      `SELECT r.* FROM runs r JOIN (SELECT member_id, MAX(started_at) AS s FROM runs GROUP BY member_id) x
       ON x.member_id = r.member_id AND x.s = r.started_at`,
    ),
    db.all<{ member_id: string; tokens: number; cost: number }>(
      `SELECT member_id, ${TOKENS_SQL} AS tokens, COALESCE(SUM(cost_usd_est), 0) AS cost FROM runs WHERE started_at >= ? GROUP BY member_id`,
      today,
    ),
  ]);
  const q = new Map<string, Row[]>();
  for (const r of latestQuota(quota)) {
    const list = q.get(r.member_id as string) ?? [];
    list.push(r);
    q.set(r.member_id as string, list);
  }
  const lr = new Map(lastRuns.map((r) => [r.member_id as string, r]));
  const td = new Map(todays.map((r) => [r.member_id, r]));
  return c.json({
    members: members.map((m) => {
      const t = td.get(m.id);
      const run = lr.get(m.id);
      return {
        ...m,
        quota: (q.get(m.id) ?? []).map(quotaOut),
        last_run: run ? runOut(run) : null,
        today: { tokens: Number(t?.tokens ?? 0), cost: Number(t?.cost ?? 0) },
      };
    }),
  });
});

async function usageSeries(db: DB, group: "day" | "agent" | "thread", since: number, days: number, memberId?: string) {
  const keyExpr = group === "day" ? SH_DAY_SQL("r.started_at") : group === "agent" ? "r.member_id" : "COALESCE(r.thread_id, '')";
  const where = ["r.started_at >= ?"];
  const args: Arg[] = [since];
  if (memberId) {
    where.push("r.member_id = ?");
    args.push(memberId);
  }
  const rows = await db.all<Record<string, number | string>>(
    `SELECT ${keyExpr} AS k, SUM(r.input) AS input, SUM(r.cache_read) AS cache_read, SUM(r.cache_write) AS cache_write,
            SUM(r.output) AS output, SUM(r.reasoning) AS reasoning, COALESCE(SUM(r.cost_usd_est), 0) AS cost,
            COUNT(*) AS runs, SUM(CASE WHEN r.exit_code != 0 THEN 1 ELSE 0 END) AS failed
     FROM runs r WHERE ${where.join(" AND ")} GROUP BY k ORDER BY k`,
    ...args,
  );
  const item = (key: string, label: string, r?: Record<string, number | string>) => ({
    key,
    label,
    input: Number(r?.input ?? 0),
    cache_read: Number(r?.cache_read ?? 0),
    cache_write: Number(r?.cache_write ?? 0),
    output: Number(r?.output ?? 0),
    reasoning: Number(r?.reasoning ?? 0),
    cost: Math.round(Number(r?.cost ?? 0) * 10000) / 10000,
    runs: Number(r?.runs ?? 0),
    failed: Number(r?.failed ?? 0),
  });
  if (group === "day") {
    const byDay = new Map(rows.map((r) => [String(r.k), r]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const key = shDayKey(since + i * DAY);
      out.push(item(key, key.slice(5), byDay.get(key)));
    }
    return out;
  }
  const keys = rows.map((r) => String(r.k)).filter(Boolean);
  const labels = new Map<string, string>();
  if (keys.length) {
    const table = group === "agent" ? "SELECT id, name AS label FROM members" : "SELECT id, title AS label FROM threads";
    for (const l of await db.all<{ id: string; label: string }>(`${table} WHERE id IN (${qmarks(keys.length)})`, ...keys)) labels.set(l.id, l.label);
  }
  const tokens = (x: ReturnType<typeof item>) => x.input + x.cache_read + x.cache_write + x.output + x.reasoning;
  return rows
    .map((r) => {
      const k = String(r.k);
      const label = k ? (group === "agent" ? `@${labels.get(k) ?? k}` : labels.get(k) ?? k) : "（无讨论串）";
      return item(k || "-", label, r);
    })
    .sort((a, b) => tokens(b) - tokens(a));
}

web.get("/members/:id", async (c) => {
  const db = new DB(c.env.DB);
  const id = c.req.param("id");
  const m = await loadMember(db, id);
  const since = shDayStart(Date.now()) - 6 * DAY;
  const [keys, quota, rules, budget, runs, usage, scopes] = await Promise.all([
    db.all("SELECT created_at, expires_at FROM member_keys WHERE member_id = ? ORDER BY created_at DESC", id),
    db.all("SELECT * FROM quota_readings WHERE member_id = ?", id),
    quotaRules(db, id),
    budgetFor(db, id),
    db.all("SELECT * FROM runs WHERE member_id = ? ORDER BY started_at DESC LIMIT 50", id),
    usageSeries(db, "day", since, 7, id),
    m.role === "manager" ? db.all<{ workspace_id: string }>("SELECT workspace_id FROM manager_scopes WHERE manager_id = ?", id) : Promise.resolve(null),
  ]);
  return c.json({
    member: memberOut(m),
    keys: keys.map((k) => ({ created_at: Number(k.created_at), expires_at: k.expires_at == null ? null : Number(k.expires_at) })),
    quota: latestQuota(quota).map(quotaOut),
    quota_rules: rules,
    budget,
    runs: runs.map(runOut),
    usage_7d: usage,
    ...(scopes ? { scopes: scopes.map((s) => s.workspace_id) } : {}),
  });
});

web.patch("/members/:id", async (c) => {
  const db = new DB(c.env.DB);
  const me = c.get("me");
  const id = c.req.param("id");
  const m = await loadMember(db, id);
  const b = body(c);
  const sets: string[] = [];
  const args: Arg[] = [];
  if ("display_name" in b) {
    const d = str(b.display_name, 64);
    if (!d) throw bad("display_name 不能为空");
    sets.push("display_name = ?");
    args.push(d);
  }
  if ("role" in b) {
    if (m.kind !== "agent") throw bad("只能修改 agent 的角色");
    if (b.role !== "agent" && b.role !== "manager") throw bad("role 只能是 agent 或 manager");
    sets.push("role = ?");
    args.push(b.role);
  }
  if ("wake_interval_s" in b) {
    if (m.kind !== "agent") throw bad("只有 agent 有醒来间隔");
    const n = Math.floor(Number(b.wake_interval_s));
    if (!Number.isFinite(n) || n < 60 || n > 86400) throw bad("wake_interval_s 必须在 60..86400 之间");
    sets.push("wake_interval_s = ?");
    args.push(n);
  }
  if ("owner" in b) {
    sets.push("owner = ?");
    args.push(str(b.owner, 64) || null);
  }
  if (sets.length) {
    await db.batch([
      db.stmt(`UPDATE members SET ${sets.join(", ")} WHERE id = ?`, ...args, id),
      ...(b.role === "agent" ? [db.stmt("DELETE FROM manager_scopes WHERE manager_id = ?", id)] : []),
      db.audit(me.id, "member.update", id, b),
      db.bumpSeq(),
    ]);
  }
  return c.json({ member: memberOut(await loadMember(db, id)) });
});

web.post("/members/:id/approve", async (c) => c.json({ member: await approveMember(c.env, c.get("me"), c.req.param("id")) }));
web.post("/members/:id/reject", async (c) => c.json(await rejectMember(c.env, c.get("me"), c.req.param("id"))));
web.post("/members/:id/pause", async (c) => {
  const b = body(c);
  return c.json({ member: await pauseMember(c.env, c.get("me"), c.req.param("id"), b.reason, b.until) });
});
web.post("/members/:id/resume", async (c) => c.json({ member: await resumeMember(c.env, c.get("me"), c.req.param("id")) }));
web.post("/members/:id/revoke", async (c) => c.json({ member: await revokeMember(c.env, c.get("me"), c.req.param("id")) }));
web.delete("/members/:id", async (c) => c.json(await deleteMember(c.env, c.get("me"), c.req.param("id"))));
web.put("/members/:id/quota-rules", async (c) => c.json(await putQuotaRules(c.env, c.get("me"), c.req.param("id"), body(c).rules)));
web.put("/members/:id/budget", async (c) => c.json(await putBudget(c.env, c.get("me"), c.req.param("id"), body(c))));

web.put("/managers/:id/scopes", async (c) => {
  const db = new DB(c.env.DB);
  const me = c.get("me");
  const id = c.req.param("id");
  const m = await loadMember(db, id);
  if (m.role !== "manager") throw bad("只有 Manager 有作用范围");
  const ids = body(c).workspace_ids;
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((x) => typeof x !== "string")) throw bad("workspace_ids 必须是字符串数组");
  const uniq = [...new Set(ids as string[])];
  if (uniq.length) {
    const found = await db.all<{ id: string }>(`SELECT id FROM workspaces WHERE id IN (${qmarks(uniq.length)})`, ...uniq);
    if (found.length !== uniq.length) throw bad("有工作区不存在");
  }
  await db.batch([
    db.stmt("DELETE FROM manager_scopes WHERE manager_id = ?", id),
    ...uniq.map((w) => db.stmt("INSERT INTO manager_scopes (manager_id, workspace_id) VALUES (?, ?)", id, w)),
    db.audit(me.id, "manager.scopes", id, uniq),
    db.bumpSeq(),
  ]);
  return c.json({ workspace_ids: uniq });
});

// ---------------------------------------------------------------- usage / runs

web.get("/usage", async (c) => {
  const db = new DB(c.env.DB);
  const days = clampLimit(c.req.query("days"), 30, 366);
  const g = c.req.query("group");
  const group = g === "agent" || g === "thread" ? g : "day";
  const since = shDayStart(Date.now()) - (days - 1) * DAY;
  const series = await usageSeries(db, group, since, days);
  const totals = { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, cost: 0, runs: 0, failed: 0 };
  for (const s of series) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s[k];
  totals.cost = Math.round(totals.cost * 10000) / 10000;
  const baseline = await db.all<{ member_id: string; tokens: number }>(
    `SELECT r.member_id, (r.input + r.cache_write + r.cache_read + r.output + r.reasoning) AS tokens FROM runs r
     JOIN (SELECT member_id, MAX(started_at) AS s FROM runs WHERE error_summary = 'baseline' GROUP BY member_id) x
     ON x.member_id = r.member_id AND x.s = r.started_at WHERE r.error_summary = 'baseline'`,
  );
  return c.json({ series, totals, baseline: baseline.map((b) => ({ member_id: b.member_id, tokens: Number(b.tokens) })) });
});

web.get("/runs", async (c) => {
  const db = new DB(c.env.DB);
  const where: string[] = [];
  const args: Arg[] = [];
  const member = c.req.query("member");
  if (member) {
    where.push("member_id = ?");
    args.push(((await resolveMember(db, member))?.id as string) ?? member);
  }
  const failed = c.req.query("failed");
  if (failed && failed !== "0" && failed !== "false") where.push("exit_code != 0");
  const before = c.req.query("before");
  if (before) {
    where.push("id < ?");
    args.push(before);
  }
  const limit = clampLimit(c.req.query("limit"));
  const rows = await db.all(`SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...args, limit + 1);
  return c.json({ runs: rows.slice(0, limit).map(runOut), has_more: rows.length > limit });
});

// ---------------------------------------------------------------- settings / email

async function settingsOut(db: DB) {
  const s = await db.settings();
  let kinds: Record<string, boolean> = {};
  try {
    kinds = JSON.parse(s.notify_kinds ?? "{}");
  } catch {
    kinds = {};
  }
  const notify_kinds: Record<string, boolean> = {};
  for (const k of Object.keys(KIND_LABELS)) if (k !== "test" && k !== "email_change") notify_kinds[k] = kinds[k] !== false;
  return {
    notify_email_masked: maskEmail(s.notify_email),
    notify_kinds,
    global_pause: s.global_pause === "1",
    default_pause_pct: Number(s.default_pause_pct ?? 100) || 100,
    merge_window_min: Number(s.merge_window_min ?? 15),
    min_client_version: s.min_client_version ?? "0.0.0",
  };
}

async function reevaluateAgents(env: Env) {
  const db = new DB(env.DB);
  const rows = await db.all<{ id: string }>("SELECT id FROM members WHERE kind = 'agent' AND status = 'active'");
  for (const r of rows) await evaluatePause(env, r.id);
}

web.get("/settings", async (c) => c.json(await settingsOut(new DB(c.env.DB))));

web.patch("/settings", async (c) => {
  const db = new DB(c.env.DB);
  const me = c.get("me");
  const b = body(c);
  const stmts: D1PreparedStatement[] = [];
  let reeval = false;
  if ("notify_email" in b || "notify_email_masked" in b) throw bad("邮箱要通过确认链接修改");
  if ("notify_kinds" in b) {
    const k = b.notify_kinds;
    if (!k || typeof k !== "object" || Array.isArray(k)) throw bad("notify_kinds 必须是对象");
    const cur = JSON.parse((await db.setting("notify_kinds")) || "{}") as Record<string, boolean>;
    for (const [name, v] of Object.entries(k as Record<string, unknown>)) {
      if (!(name in KIND_LABELS) || name === "email_change" || name === "test") throw bad(`未知通知种类 ${name}`);
      if (typeof v !== "boolean") throw bad("notify_kinds 的值必须是 true / false");
      cur[name] = v;
    }
    stmts.push(db.setSetting("notify_kinds", JSON.stringify(cur)));
  }
  if ("global_pause" in b) {
    if (typeof b.global_pause !== "boolean") throw bad("global_pause 必须是布尔值");
    stmts.push(db.setSetting("global_pause", b.global_pause ? "1" : "0"));
  }
  if ("default_pause_pct" in b) {
    const n = Number(b.default_pause_pct);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw bad("default_pause_pct 必须在 1..100 之间");
    stmts.push(db.setSetting("default_pause_pct", String(n)));
    reeval = true;
  }
  if ("merge_window_min" in b) {
    const n = Math.floor(Number(b.merge_window_min));
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw bad("merge_window_min 必须在 0..1440 之间");
    stmts.push(db.setSetting("merge_window_min", String(n)));
  }
  if ("min_client_version" in b) {
    const v = str(b.min_client_version, 32);
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw bad("min_client_version 必须形如 0.4.0");
    stmts.push(db.setSetting("min_client_version", v));
  }
  if (stmts.length) {
    stmts.push(db.audit(me.id, "settings.update", null, b), db.bumpSeq());
    await db.batch(stmts);
  }
  if (reeval) await reevaluateAgents(c.env);
  return c.json(await settingsOut(db));
});

const EMAIL_RE = /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

web.post("/settings/email", async (c) => {
  const db = new DB(c.env.DB);
  const me = c.get("me");
  const email = str(body(c).email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad("邮箱格式不对");
  const recent = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM email_changes WHERE expires_at > ?", Date.now());
  if ((recent?.n ?? 0) >= 5) throw conflict("确认邮件发得太频繁了，请稍后再试");
  const token = randomToken(24);
  const now = Date.now();
  const base = (c.env.PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
  await db.batch([
    db.stmt("INSERT INTO email_changes (token_hash, new_email, expires_at) VALUES (?, ?, ?)", await sha256Hex(token), email, now + 30 * 60_000),
    notify(db, "email_change", {
      title: "确认 agentbus 通知邮箱",
      text: "有人（应该是你）在 agentbus hub 上把通知邮箱改成了这个地址。30 分钟内点下面的链接确认；不是你操作的话忽略即可。",
      link: `${base}/api/v1/web/settings/email/confirm?token=${encodeURIComponent(token)}`,
      to: email,
    }),
    db.audit(me.id, "settings.email_requested", null, { email: maskEmail(email) }),
  ]);
  await flushNotifications(c.env, { force: true });
  // Don't keep the confirm token around in the outbox.
  const row = await db.first<{ error: string | null }>(
    "SELECT error FROM notifications WHERE kind = 'email_change' ORDER BY created_at DESC LIMIT 1",
  );
  await db.run("UPDATE notifications SET payload = '{\"title\":\"确认 agentbus 通知邮箱\"}' WHERE kind = 'email_change' AND sent_at IS NOT NULL");
  if (row?.error) throw conflict(`确认邮件发送失败：${row.error}`);
  return c.json({ ok: true, sent_to: maskEmail(email) });
});

web.get("/settings/email/confirm", async (c) => {
  const db = new DB(c.env.DB);
  const token = c.req.query("token") ?? "";
  const go = (v: string) => c.redirect(`/settings?email=${v}`, 302);
  if (!token || token.length > 100) return go("invalid");
  const hash = await sha256Hex(token);
  const row = await db.first<{ new_email: string; expires_at: number }>("SELECT new_email, expires_at FROM email_changes WHERE token_hash = ?", hash);
  if (!row) return go("invalid");
  if (row.expires_at < Date.now()) {
    await db.run("DELETE FROM email_changes WHERE token_hash = ?", hash);
    return go("expired");
  }
  await db.batch([
    db.setSetting("notify_email", row.new_email),
    db.stmt("DELETE FROM email_changes WHERE token_hash = ?", hash),
    db.audit(c.get("me").id, "settings.email_changed", null, { email: maskEmail(row.new_email) }),
    db.bumpSeq(),
  ]);
  return go("ok");
});

web.post("/notify/test", async (c) => {
  const db = new DB(c.env.DB);
  const to = await db.setting("notify_email");
  if (!to) throw bad("还没有设置通知邮箱");
  await notify(db, "test", {
    title: "agentbus 测试邮件",
    text: `如果你收到了这封邮件，说明 hub 的邮件通知是通的。（${new Date().toISOString()}）`,
    link: "/settings",
  }).run();
  await flushNotifications(c.env, { force: true });
  const row = await db.first<{ error: string | null }>("SELECT error FROM notifications WHERE kind = 'test' ORDER BY created_at DESC LIMIT 1");
  if (row?.error) throw conflict(`发送失败：${row.error}`);
  return c.json({ ok: true, sent_to: maskEmail(to) });
});

// ---------------------------------------------------------------- search / audit

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);

export function snippet(text: string, q: string, radius = 60): string {
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const at = lower.indexOf(ql);
  if (at < 0) return escapeHtml(text.slice(0, radius * 2)) + (text.length > radius * 2 ? "…" : "");
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + q.length + radius);
  const win = text.slice(start, end);
  const wl = win.toLowerCase();
  let out = "";
  let i = 0;
  for (let j = wl.indexOf(ql); j >= 0; j = wl.indexOf(ql, i)) {
    out += escapeHtml(win.slice(i, j)) + "<mark>" + escapeHtml(win.slice(j, j + q.length)) + "</mark>";
    i = j + q.length;
  }
  out += escapeHtml(win.slice(i));
  return (start > 0 ? "…" : "") + out + (end < text.length ? "…" : "");
}

web.get("/search", async (c) => {
  const db = new DB(c.env.DB);
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  if (!q) return c.json({ results: [] });
  const pat = `%${likeEscape(q)}%`;
  const where: string[] = [];
  const args: Arg[] = [];
  const member = c.req.query("member");
  if (member) {
    where.push("p.author_id = ?");
    args.push(((await resolveMember(db, member))?.id as string) ?? member);
  }
  const status = c.req.query("status");
  if (status) {
    where.push("t.status = ?");
    args.push(status);
  }
  const ws = c.req.query("workspace");
  if (ws) {
    where.push("t.workspace_id = ?");
    args.push(ws);
  }
  const extra = where.length ? " AND " + where.join(" AND ") : "";
  const [byBody, byTitle] = await Promise.all([
    db.all(
      `SELECT p.* FROM posts p JOIN threads t ON t.id = p.thread_id WHERE p.body LIKE ? ESCAPE '\\'${extra} ORDER BY p.id DESC LIMIT 50`,
      pat,
      ...args,
    ),
    db.all(
      `SELECT p.* FROM posts p JOIN threads t ON t.id = p.thread_id
       WHERE t.title LIKE ? ESCAPE '\\' AND p.id = (SELECT MIN(id) FROM posts WHERE thread_id = t.id)${extra}
       ORDER BY p.id DESC LIMIT 20`,
      pat,
      ...args,
    ),
  ]);
  const seen = new Set<string>();
  const rows = [...byBody, ...byTitle]
    .filter((r) => (seen.has(r.id as string) ? false : (seen.add(r.id as string), true)))
    .sort((a, b) => (String(b.id) > String(a.id) ? 1 : -1))
    .slice(0, 50);
  const posts = await hydratePosts(db, rows);
  const tids = [...new Set(posts.map((p) => p.thread_id))];
  const threads = tids.length ? await db.all(`SELECT id, title, status, workspace_id FROM threads WHERE id IN (${qmarks(tids.length)})`, ...tids) : [];
  const tmap = new Map(threads.map((t) => [t.id as string, t]));
  return c.json({
    results: posts.map((p) => {
      const t = tmap.get(p.thread_id);
      const title = String(t?.title ?? "");
      const inBody = p.body.toLowerCase().includes(q.toLowerCase());
      return {
        post: p,
        thread: { id: p.thread_id, title, status: t?.status, workspace_id: t?.workspace_id },
        snippet: inBody ? snippet(p.body, q) : snippet(title, q),
      };
    }),
  });
});

web.get("/audit", async (c) => {
  const db = new DB(c.env.DB);
  const before = Number(c.req.query("before") ?? 0);
  const limit = clampLimit(c.req.query("limit"));
  const rows = before > 0
    ? await db.all("SELECT * FROM audit_log WHERE id < ? AND action != 'join.attempt' ORDER BY id DESC LIMIT ?", before, limit + 1)
    : await db.all("SELECT * FROM audit_log WHERE action != 'join.attempt' ORDER BY id DESC LIMIT ?", limit + 1);
  return c.json({
    entries: rows.slice(0, limit).map((r) => ({
      id: Number(r.id),
      actor_id: (r.actor_id as string) ?? "system",
      action: r.action as string,
      target: (r.target as string) ?? null,
      detail: (r.detail as string) ?? null,
      created_at: Number(r.created_at),
    })),
    has_more: rows.length > limit,
  });
});
