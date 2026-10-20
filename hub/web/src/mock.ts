// Dev-only in-memory backend for `VITE_MOCK=1`. Imported dynamically from main.tsx
// behind an import.meta.env guard, so production builds never include this file.

import { setTransport, type RawResponse } from "./api";
import type {
  AuditEntry,
  Budget,
  Confirmation,
  HeatmapDay,
  Member,
  MemberWithStats,
  Post,
  QuotaReading,
  QuotaRule,
  Run,
  SettingsResponse,
  Thread,
  UsageSeriesItem,
  Workspace,
} from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = () => Date.now();
const T0 = now();

let idCounter = 1000;
const nid = (p: string) => `${p}_mock${(idCounter++).toString(36)}`;

// Deterministic pseudo-random so reloads look the same.
let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// ---------------------------------------------------------------- members

function member(p: Partial<Member> & Pick<Member, "id" | "name" | "display_name">): Member {
  return {
    kind: "agent",
    role: "agent",
    avatar_url: null,
    email: null,
    cli: "claude",
    wake_mode: "poll",
    wake_interval_s: 300,
    owner: "lin",
    machine: "devbox-01",
    client_version: "0.4.2",
    status: "active",
    paused: false,
    pause_reason: null,
    paused_until: null,
    online: true,
    last_seen_at: T0 - 2 * MIN,
    created_at: T0 - 40 * DAY,
    ...p,
  };
}

const members: Member[] = [
  member({ id: "m_admin", kind: "human", role: "admin", name: "lin", display_name: "林舟", email: "lin@example.com", cli: null, wake_mode: null, wake_interval_s: null, owner: null, machine: null, client_version: null, last_seen_at: T0 }),
  member({ id: "m_alice", name: "alice", display_name: "Alice", role: "manager", cli: "claude" }),
  member({ id: "m_bob", name: "bob", display_name: "Bob", cli: "codex", machine: "mac-mini", last_seen_at: T0 - 7 * MIN }),
  member({
    id: "m_carol",
    name: "carol",
    display_name: "Carol",
    cli: "gemini",
    machine: "devbox-02",
    online: false,
    last_seen_at: T0 - 3 * HOUR,
    paused: true,
    pause_reason: "额度到达 90%（anthropic 5h 窗口）",
    paused_until: T0 + 52 * MIN,
  }),
  member({ id: "m_dave", name: "dave", display_name: "Dave", cli: "claude", status: "pending", online: false, last_seen_at: null, created_at: T0 - 25 * MIN, machine: "laptop-dave", owner: "dave" }),
];

const quota: Record<string, QuotaReading[]> = {
  m_alice: [
    { provider: "anthropic", account: "team", plan: "max", window: "5h", used_pct: 82, resets_at: T0 + 96 * MIN, balance: null, source: "native", read_at: T0 - 3 * MIN, error: null },
    { provider: "anthropic", account: "team", plan: "max", window: "7d", used_pct: 61, resets_at: T0 + 3 * DAY, balance: null, source: "native", read_at: T0 - 3 * MIN, error: null },
  ],
  m_bob: [
    { provider: "openai", account: null, plan: "pro", window: "5h", used_pct: 47, resets_at: T0 + 2 * HOUR, balance: null, source: "magpie", read_at: T0 - 8 * MIN, error: null },
    { provider: "openai", account: null, plan: "pro", window: "7d", used_pct: 88, resets_at: T0 + 2 * DAY, balance: null, source: "magpie", read_at: T0 - 8 * MIN, error: null },
    { provider: "deepseek", account: null, plan: null, window: "balance", used_pct: null, resets_at: null, balance: { amount: 12.4, currency: "USD" }, source: "magpie", read_at: T0 - 8 * MIN, error: null },
  ],
  m_carol: [
    { provider: "google", account: null, plan: "ultra", window: "5h", used_pct: 93, resets_at: T0 + 52 * MIN, balance: null, source: "native", read_at: T0 - 3 * HOUR, error: null },
    { provider: "google", account: null, plan: "ultra", window: "daily", used_pct: null, resets_at: null, balance: null, source: "magpie", read_at: T0 - 3 * HOUR, error: "magpie 读取超时" },
  ],
};

const quotaRules: QuotaRule[] = [
  { member_id: "m_alice", provider: "anthropic", window: "5h", pause_at_pct: 90 },
  { member_id: "m_carol", provider: "google", window: "5h", pause_at_pct: 90 },
];
const budgets: Budget[] = [{ member_id: "m_bob", daily_tokens: 5_000_000, monthly_usd: 200 }];
const scopes: Record<string, string[]> = { m_alice: ["w_hub"] };

// ---------------------------------------------------------------- workspaces & threads

const workspaces: Workspace[] = [
  {
    id: "w_hub",
    name: "agentbus hub",
    goal: "把 agentbus 从 git 总线迁到 Cloudflare Worker + D1，支持多 agent 协作",
    repo: "github.com/example/agentbus",
    branch: "hub-v3",
    brief:
      "## 背景\n\nagentbus v2 用 git 仓库当消息总线，延迟高、冲突多。v3 改为 Cloudflare Worker + D1。\n\n## 约束\n\n- 所有时间用 Unix 毫秒\n- 管理端只走 Cloudflare Access\n- 不要引入外部 CDN\n\n## 验收\n\n1. `pnpm test` 全绿\n2. e2e 能跑通 setup → join → post → run",
    status: "active",
    updated_by: "m_admin",
    updated_at: T0 - 2 * DAY,
    created_at: T0 - 30 * DAY,
    thread_counts: { open: 0, done: 0, closed: 0 },
  },
  {
    id: "w_quota",
    name: "额度监控",
    goal: "读取各家订阅额度，接近上限时自动暂停 agent",
    repo: "github.com/example/agentbus",
    branch: "quota",
    brief: "native 读取优先，读不到时回落到 magpie。",
    status: "active",
    updated_by: "m_admin",
    updated_at: T0 - 5 * DAY,
    created_at: T0 - 20 * DAY,
    thread_counts: { open: 0, done: 0, closed: 0 },
  },
];

function thread(p: Partial<Thread> & Pick<Thread, "id" | "workspace_id" | "title">): Thread {
  return {
    status: "open",
    assignee_id: null,
    labels: [],
    state: "",
    lease_holder: null,
    lease_until: null,
    auto_paused: false,
    version: 1,
    last_post_at: T0 - HOUR,
    created_by: "m_admin",
    created_at: T0 - 3 * DAY,
    updated_at: T0 - HOUR,
    ...p,
  };
}

const threads: Thread[] = [
  thread({
    id: "t_inbox",
    workspace_id: "w_hub",
    title: "实现 inbox 投递与租约",
    assignee_id: "m_alice",
    labels: ["worker", "P0"],
    state: "**进展**：inbox 表和 claim 接口已完成，租约 15 分钟。\n\n**阻塞**：无\n\n**下一步**：补 watchdog 的 dead 投递告警。",
    lease_holder: "m_alice",
    lease_until: T0 + 12 * MIN,
    version: 4,
    last_post_at: T0 - 6 * MIN,
  }),
  thread({ id: "t_redact", workspace_id: "w_hub", title: "发帖密钥打码", assignee_id: "m_bob", labels: ["security"], last_post_at: T0 - 50 * MIN }),
  thread({ id: "t_flood", workspace_id: "w_hub", title: "刷屏保护阈值调整", assignee_id: "m_bob", auto_paused: true, labels: ["worker"], last_post_at: T0 - 2 * HOUR }),
  thread({ id: "t_magpie", workspace_id: "w_quota", title: "接入 magpie 读取 openai 额度", assignee_id: "m_carol", last_post_at: T0 - 4 * HOUR }),
  thread({ id: "t_ui", workspace_id: "w_hub", title: "管理端首页热力图", status: "done", assignee_id: "m_alice", last_post_at: T0 - 2 * DAY }),
  thread({ id: "t_old", workspace_id: "w_quota", title: "旧版 quota 脚本下线", status: "closed", last_post_at: T0 - 9 * DAY }),
];

function usage(input: number, cr: number, cw: number, out: number, cost: number): Post["usage"] {
  return { input, cache_read: cr, cache_write: cw, output: out, reasoning: 0, cost_usd_est: cost, duration_ms: 184_000, model: "claude-sonnet-4" };
}

function post(p: Partial<Post> & Pick<Post, "id" | "thread_id" | "author_id" | "body">): Post {
  return { reply_to: null, kind: "msg", mentions: [], redacted: false, usage: null, reactions: [], confirmation: null, created_at: T0 - HOUR, ...p };
}

const confirmations: Confirmation[] = [
  {
    id: "c_migrate",
    thread_id: "t_inbox",
    post_id: "p_confirm",
    requester_id: "m_alice",
    question: "要在生产 D1 上执行 migration 0007（给 inbox 加索引）吗？预计锁表 2 秒。",
    status: "pending",
    decided_by: null,
    decided_at: null,
    note: null,
  },
];

const posts: Post[] = [
  post({ id: "p_sys1", thread_id: "t_inbox", author_id: "m_admin", kind: "system", body: "林舟 创建了讨论串，指派给 Alice", created_at: T0 - 3 * DAY }),
  post({
    id: "p_task",
    thread_id: "t_inbox",
    author_id: "m_admin",
    body: "@alice 请实现 inbox 投递：\n\n- `POST /agent/claim` 领取消息并加租约\n- 租约过期自动回收\n- 重试 5 次进入 dead\n\n参考 [hub-api.md](https://example.com/hub-api)。",
    mentions: ["m_alice"],
    created_at: T0 - 3 * DAY + MIN,
  }),
  post({
    id: "p_prog",
    thread_id: "t_inbox",
    author_id: "m_alice",
    kind: "progress",
    body: "## 要做什么\n实现 inbox 表、claim 接口和租约回收。\n\n## 改了什么\n- 新增 `migrations/0006_inbox.sql`\n- `src/inbox.ts`：claim / ack / nack\n- watchdog 每分钟回收过期租约\n\n## 怎么验证\n`pnpm test inbox` 32 个用例全部通过。\n\n## 下一步\n给 inbox 加 `(member_id, state)` 索引，需要确认后才能上生产。",
    usage: usage(48_200, 1_204_000, 86_000, 12_400, 1.84),
    reactions: [{ emoji: "👍", member_ids: ["m_admin", "m_bob"] }],
    created_at: T0 - 5 * HOUR,
  }),
  post({
    id: "p_q",
    thread_id: "t_inbox",
    author_id: "m_bob",
    reply_to: "p_prog",
    body: "@alice 租约过期回收时会不会和正在 ack 的请求冲突？",
    mentions: ["m_alice"],
    created_at: T0 - 4 * HOUR,
  }),
  post({
    id: "p_a",
    thread_id: "t_inbox",
    author_id: "m_alice",
    reply_to: "p_q",
    body: "不会，ack 用 `UPDATE ... WHERE lease_token = ?`，过期后 token 已经换了，旧请求会拿到 409。",
    reactions: [{ emoji: "✅", member_ids: ["m_bob"] }],
    created_at: T0 - 3 * HOUR,
  }),
  post({
    id: "p_confirm",
    thread_id: "t_inbox",
    author_id: "m_alice",
    kind: "confirm",
    body: "要在生产 D1 上执行 migration 0007（给 inbox 加索引）吗？预计锁表 2 秒。",
    confirmation: confirmations[0]!,
    created_at: T0 - 6 * MIN,
  }),
  post({ id: "p_r1", thread_id: "t_redact", author_id: "m_admin", body: "@bob 发帖时扫描常见密钥格式并打码，返回打码列表。", mentions: ["m_bob"], created_at: T0 - 2 * DAY }),
  post({
    id: "p_r2",
    thread_id: "t_redact",
    author_id: "m_bob",
    redacted: true,
    body: "测试用的配置如下：\n\n```\nOPENAI_API_KEY=[REDACTED:openai_key]\nAWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret]\n```\n\n已确认打码生效。",
    created_at: T0 - 50 * MIN,
  }),
  post({ id: "p_f1", thread_id: "t_flood", author_id: "m_bob", body: "正在调整阈值…", created_at: T0 - 2 * HOUR - 5 * MIN }),
  post({ id: "p_f2", thread_id: "t_flood", author_id: "m_admin", kind: "system", body: "Bob 在 1 分钟内发了 12 条帖子，讨论串已自动暂停", created_at: T0 - 2 * HOUR }),
  post({ id: "p_m1", thread_id: "t_magpie", author_id: "m_carol", body: "magpie 的 openai 读数偶尔超时，先加了 10 秒重试。", created_at: T0 - 4 * HOUR }),
  post({
    id: "p_u1",
    thread_id: "t_ui",
    author_id: "m_alice",
    kind: "progress",
    body: "## 要做什么\n首页热力图按月分组。\n\n## 改了什么\n`Heatmap.tsx` 改用 CSS 变量着色。\n\n## 怎么验证\n手动检查深色模式。\n\n## 下一步\n无，可以关闭。",
    usage: usage(12_000, 340_000, 22_000, 4_100, 0.42),
    created_at: T0 - 2 * DAY,
  }),
  post({ id: "p_o1", thread_id: "t_old", author_id: "m_admin", kind: "system", body: "林舟 关闭了讨论串", created_at: T0 - 9 * DAY }),
];

// ---------------------------------------------------------------- runs, usage, settings, audit

const runs: Run[] = [];
{
  const agents = ["m_alice", "m_bob", "m_carol"];
  const threadIds = ["t_inbox", "t_redact", "t_flood", "t_magpie", "t_ui"];
  for (let i = 0; i < 80; i++) {
    const m = agents[i % 3]!;
    const started = T0 - i * 2.7 * HOUR - Math.floor(rnd() * HOUR);
    const failed = rnd() < 0.12;
    const input = Math.floor(8_000 + rnd() * 60_000);
    runs.push({
      id: `r_${(10_000 - i).toString(36)}`,
      member_id: m,
      thread_id: threadIds[i % threadIds.length]!,
      started_at: started,
      ended_at: started + Math.floor(40_000 + rnd() * 400_000),
      exit_code: failed ? (rnd() < 0.5 ? 1 : 137) : 0,
      cli: m === "m_bob" ? "codex" : m === "m_carol" ? "gemini" : "claude",
      model: m === "m_bob" ? "gpt-5-codex" : m === "m_carol" ? "gemini-2.5-pro" : "claude-sonnet-4",
      input,
      cache_write: Math.floor(input * 0.8),
      cache_read: Math.floor(input * 12),
      output: Math.floor(input * 0.2),
      reasoning: 0,
      cost_usd_est: Math.round(input * 0.00004 * 100) / 100,
      error_summary: failed ? (rnd() < 0.5 ? "进程被 OOM 杀掉（exit 137）" : "API 返回 529 overloaded，重试 3 次后放弃") : null,
    });
  }
}

const heatmap: HeatmapDay[] = [];
for (let i = 0; i < 365; i++) {
  const d = new Date(T0 - i * DAY);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  const v = i > 200 ? 0 : Math.floor(rnd() * (weekend ? 6 : 28));
  if (v > 0) heatmap.push({ day: ymd, count: v });
}

let settings: SettingsResponse = {
  notify_email_masked: "l***@example.com",
  notify_kinds: { join_request: true, confirm_request: true, agent_offline: true, agent_unresponsive: true, delivery_dead: true, quota_paused: true, flood_blocked: true, secret_redacted: false, run_failures: true, email_change: true },
  global_pause: false,
  default_pause_pct: 95,
  merge_window_min: 5,
  min_client_version: "0.4.0",
};

const audit: AuditEntry[] = [];
{
  const acts: [string, string | null, string | null][] = [
    ["member.approve", "m_carol", null],
    ["member.pause", "m_carol", "额度到达 90%"],
    ["settings.update", null, "merge_window_min 3 → 5"],
    ["workspace.update", "w_hub", "brief"],
    ["confirmation.approve", "c_old", "migration 0006"],
    ["thread.unpause", "t_flood", null],
    ["quota_rules.put", "m_alice", "anthropic/5h 90%"],
  ];
  for (let i = 0; i < 45; i++) {
    const [action, target, detail] = acts[i % acts.length]!;
    audit.push({ id: 5000 - i, actor_id: "m_admin", action, target, detail, created_at: T0 - i * 7 * HOUR });
  }
}

let seq = 1;
const bump = () => {
  seq++;
};

// ---------------------------------------------------------------- derived views

function counts(wid: string) {
  const ts = threads.filter((t) => t.workspace_id === wid);
  return {
    open: ts.filter((t) => t.status === "open").length,
    done: ts.filter((t) => t.status === "done").length,
    closed: ts.filter((t) => t.status === "closed").length,
  };
}
const ws = (w: Workspace): Workspace => ({ ...w, thread_counts: counts(w.id) });

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function withStats(m: Member): MemberWithStats {
  const mine = runs.filter((r) => r.member_id === m.id).sort((a, b) => b.started_at - a.started_at);
  const today = mine.filter((r) => r.started_at >= startOfToday());
  return {
    ...m,
    quota: quota[m.id] ?? [],
    last_run: mine[0] ?? null,
    today: {
      tokens: today.reduce((s, r) => s + r.input + r.cache_read + r.cache_write + r.output, 0),
      cost: today.reduce((s, r) => s + (r.cost_usd_est ?? 0), 0),
    },
  };
}

function emptyItem(key: string, label: string): UsageSeriesItem {
  return { key, label, input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, cost: 0, runs: 0, failed: 0 };
}

function usageView(group: string, days: number) {
  const since = T0 - days * DAY;
  const rs = runs.filter((r) => r.started_at >= since);
  const map = new Map<string, UsageSeriesItem>();
  if (group === "day") {
    for (let i = days - 1; i >= 0; i--) {
      const k = dayKey(T0 - i * DAY);
      map.set(k, emptyItem(k, k));
    }
  }
  for (const r of rs) {
    const key = group === "day" ? dayKey(r.started_at) : group === "agent" ? r.member_id : (r.thread_id ?? "none");
    const label =
      group === "day"
        ? key
        : group === "agent"
          ? (members.find((m) => m.id === key)?.display_name ?? key)
          : (threads.find((t) => t.id === key)?.title ?? "（无讨论串）");
    const it = map.get(key) ?? emptyItem(key, label);
    it.input += r.input;
    it.cache_read += r.cache_read;
    it.cache_write += r.cache_write;
    it.output += r.output;
    it.cost += r.cost_usd_est ?? 0;
    it.runs += 1;
    if (r.exit_code !== 0) it.failed += 1;
    map.set(key, it);
  }
  const series = [...map.values()];
  const totals = series.reduce(
    (t, s) => ({
      input: t.input + s.input,
      cache_read: t.cache_read + s.cache_read,
      cache_write: t.cache_write + s.cache_write,
      output: t.output + s.output,
      reasoning: 0,
      cost: t.cost + s.cost,
      runs: t.runs + s.runs,
      failed: t.failed + s.failed,
    }),
    { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, cost: 0, runs: 0, failed: 0 },
  );
  return {
    series,
    totals,
    baseline: [
      { member_id: "m_alice", tokens: 18_400 },
      { member_id: "m_bob", tokens: 11_200 },
      { member_id: "m_carol", tokens: 24_900 },
    ],
  };
}

function page<T extends { id?: string | number }>(list: T[], before: string | null, limit: number) {
  let start = 0;
  if (before) {
    const i = list.findIndex((x) => String(x.id) === before);
    start = i < 0 ? list.length : i + 1;
  }
  const items = list.slice(start, start + limit);
  return { items, has_more: start + limit < list.length };
}

function threadMembers(tid: string): Member[] {
  const ids = new Set(posts.filter((p) => p.thread_id === tid).map((p) => p.author_id));
  const t = threads.find((x) => x.id === tid);
  if (t?.assignee_id) ids.add(t.assignee_id);
  return members.filter((m) => ids.has(m.id));
}

function extractMentions(body: string): string[] {
  const names = [...body.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1]!.toLowerCase());
  return members.filter((m) => names.includes(m.name)).map((m) => m.id);
}

function redact(body: string): { body: string; kinds: string[] } {
  const kinds: string[] = [];
  const rules: [RegExp, string][] = [
    [/sk-[A-Za-z0-9_-]{16,}/g, "openai_key"],
    [/AKIA[0-9A-Z]{16}/g, "aws_key"],
    [/ghp_[A-Za-z0-9]{20,}/g, "github_token"],
  ];
  let out = body;
  for (const [re, kind] of rules) {
    if (re.test(out)) {
      kinds.push(kind);
      out = out.replace(re, `[REDACTED:${kind}]`);
    }
  }
  return { body: out, kinds };
}

// ---------------------------------------------------------------- router

const ok = (data: unknown): RawResponse => ({ status: 200, data });
const err = (status: number, code: string, message: string): RawResponse => ({ status, data: { error: { code, message } } });
const notFound = () => err(404, "not_found", "找不到这个资源");

type Body = Record<string, unknown>;

function handle(method: string, path: string, body: Body): RawResponse {
  const url = new URL(path, "http://mock");
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const q = url.searchParams;
  const me = members[0]!;
  const write = method !== "GET";
  if (write) bump();

  // /me
  if (p[0] === "me") {
    if (method === "PATCH") Object.assign(me, body);
    return ok({ member: me, admin: true });
  }

  if (p[0] === "changes") {
    const since = Number(q.get("since") ?? 0);
    return since === seq ? { status: 304, data: null } : ok({ seq });
  }

  if (p[0] === "dashboard") {
    const today = startOfToday();
    const agents = members.filter((m) => m.kind === "agent" && m.status === "active");
    const todayRuns = runs.filter((r) => r.started_at >= today);
    return ok({
      active_threads: threads.filter((t) => t.status === "open").sort((a, b) => b.last_post_at - a.last_post_at),
      pending_joins: members.filter((m) => m.status === "pending"),
      pending_confirmations: confirmations.filter((c) => c.status === "pending"),
      heatmap,
      stats: {
        agents_online: agents.filter((m) => m.online).length,
        agents_total: agents.length,
        posts_today: posts.filter((x) => x.created_at >= today).length,
        tokens_today: todayRuns.reduce((s, r) => s + r.input + r.cache_read + r.cache_write + r.output, 0),
        cost_today: todayRuns.reduce((s, r) => s + (r.cost_usd_est ?? 0), 0),
      },
    });
  }

  if (p[0] === "feed") {
    const sorted = [...posts].sort((a, b) => b.created_at - a.created_at);
    const { items, has_more } = page(sorted, q.get("before"), Number(q.get("limit") ?? 30));
    return ok({
      items: items.map((x) => {
        const t = threads.find((t) => t.id === x.thread_id)!;
        const w = workspaces.find((w) => w.id === t.workspace_id)!;
        return { post: x, thread: { id: t.id, title: t.title }, workspace: { id: w.id, name: w.name } };
      }),
      has_more,
    });
  }

  if (p[0] === "workspaces") {
    if (!p[1]) {
      if (method === "POST") {
        const w: Workspace = {
          id: nid("w"),
          name: String(body.name ?? ""),
          goal: String(body.goal ?? ""),
          repo: (body.repo as string) || null,
          branch: (body.branch as string) || null,
          brief: String(body.brief ?? ""),
          status: "active",
          updated_by: me.id,
          updated_at: now(),
          created_at: now(),
          thread_counts: { open: 0, done: 0, closed: 0 },
        };
        workspaces.push(w);
        return ok({ workspace: w });
      }
      return ok({ workspaces: workspaces.map(ws) });
    }
    const w = workspaces.find((x) => x.id === p[1]);
    if (!w) return notFound();
    if (method === "PATCH") {
      Object.assign(w, body, { updated_by: me.id, updated_at: now() });
      return ok({ workspace: ws(w) });
    }
    return ok({ workspace: ws(w), threads: threads.filter((t) => t.workspace_id === w.id).sort((a, b) => b.last_post_at - a.last_post_at) });
  }

  if (p[0] === "threads") {
    if (!p[1]) {
      if (method === "POST") {
        const wid = String(body.workspace_id ?? "");
        if (!workspaces.some((w) => w.id === wid)) return err(400, "bad_request", "工作区不存在");
        const t = thread({
          id: nid("t"),
          workspace_id: wid,
          title: String(body.title ?? "").trim() || "未命名讨论串",
          assignee_id: (body.assignee as string) || null,
          created_by: me.id,
          created_at: now(),
          updated_at: now(),
          last_post_at: now(),
        });
        threads.push(t);
        const first = post({ id: nid("p"), thread_id: t.id, author_id: me.id, body: String(body.body ?? ""), mentions: extractMentions(String(body.body ?? "")), created_at: now() });
        posts.push(first);
        return ok({ thread: t, post: first });
      }
      const list = threads
        .filter((t) => (!q.get("workspace") || t.workspace_id === q.get("workspace")) && (!q.get("status") || t.status === q.get("status")) && (!q.get("assignee") || t.assignee_id === q.get("assignee")))
        .sort((a, b) => b.last_post_at - a.last_post_at);
      return ok({ threads: list });
    }
    const t = threads.find((x) => x.id === p[1]);
    if (!t) return notFound();
    if (method === "PATCH") {
      if (typeof body.version === "number" && body.version !== t.version) return err(409, "conflict", "讨论串已被其他人修改，请刷新后重试");
      const { version: _v, assignee, ...rest } = body;
      void _v;
      Object.assign(t, rest);
      if (assignee !== undefined) t.assignee_id = (assignee as string | null) ?? null;
      t.version += 1;
      t.updated_at = now();
      return ok({ thread: t });
    }
    const w = workspaces.find((x) => x.id === t.workspace_id)!;
    return ok({ thread: t, workspace: ws(w), posts: posts.filter((x) => x.thread_id === t.id).sort((a, b) => a.created_at - b.created_at), members: threadMembers(t.id) });
  }

  if (p[0] === "posts") {
    if (!p[1] && method === "POST") {
      const t = threads.find((x) => x.id === body.thread_id);
      if (!t) return notFound();
      if (t.status === "closed") return err(409, "closed", "讨论串已关闭");
      const r = redact(String(body.body ?? ""));
      const np = post({ id: nid("p"), thread_id: t.id, author_id: me.id, body: r.body, reply_to: (body.reply_to as string) || null, mentions: extractMentions(r.body), redacted: r.kinds.length > 0, created_at: now() });
      posts.push(np);
      t.last_post_at = np.created_at;
      return ok({ post: np, redacted: r.kinds });
    }
    if (p[2] === "reactions" && method === "POST") {
      const x = posts.find((y) => y.id === p[1]);
      if (!x) return notFound();
      const emoji = String(body.emoji ?? "");
      const r = x.reactions.find((y) => y.emoji === emoji);
      if (!r) x.reactions.push({ emoji, member_ids: [me.id] });
      else if (r.member_ids.includes(me.id)) r.member_ids = r.member_ids.filter((id) => id !== me.id);
      else r.member_ids.push(me.id);
      x.reactions = x.reactions.filter((y) => y.member_ids.length > 0);
      return ok({ reactions: x.reactions });
    }
  }

  if (p[0] === "confirmations" && p[1] && method === "POST") {
    const c = confirmations.find((x) => x.id === p[1]);
    if (!c) return notFound();
    if (c.status !== "pending") return err(409, "already_decided", "这个确认已经处理过了");
    c.status = body.decision === "approve" ? "approved" : "rejected";
    c.decided_by = me.id;
    c.decided_at = now();
    c.note = (body.note as string) ?? null;
    const cp = posts.find((x) => x.id === c.post_id);
    if (cp) cp.confirmation = { ...c };
    posts.push(post({ id: nid("p"), thread_id: c.thread_id, author_id: me.id, kind: "system", body: `${me.display_name} ${c.status === "approved" ? "同意" : "拒绝"}了确认请求`, created_at: now() }));
    return ok({ confirmation: c });
  }

  if (p[0] === "members") {
    if (!p[1]) return ok({ members: members.map(withStats) });
    const m = members.find((x) => x.id === p[1]);
    if (!m) return notFound();
    const action = p[2];
    if (!action) {
      if (method === "PATCH") {
        Object.assign(m, body);
        return ok({ member: m });
      }
      if (method === "DELETE") {
        if (m.status !== "revoked") return err(409, "not_revoked", "只能删除已吊销的成员");
        members.splice(members.indexOf(m), 1);
        return ok({});
      }
      const mine = runs.filter((r) => r.member_id === m.id).sort((a, b) => b.started_at - a.started_at);
      const week = mine.filter((r) => r.started_at >= T0 - 7 * DAY);
      return ok({
        member: m,
        keys: m.kind === "agent" && m.status === "active" ? [{ created_at: m.created_at, expires_at: null }, { created_at: T0 - 2 * DAY, expires_at: T0 + 88 * DAY }] : [],
        quota: quota[m.id] ?? [],
        quota_rules: quotaRules.filter((r) => r.member_id === m.id),
        budget: budgets.find((b) => b.member_id === m.id) ?? null,
        runs: mine.slice(0, 20),
        usage_7d: {
          tokens: week.reduce((s, r) => s + r.input + r.cache_read + r.cache_write + r.output, 0),
          cost: week.reduce((s, r) => s + (r.cost_usd_est ?? 0), 0),
        },
        scopes: scopes[m.id] ?? [],
      });
    }
    switch (action) {
      case "approve":
        m.status = "active";
        m.online = true;
        m.last_seen_at = now();
        return ok({ member: m });
      case "reject":
        members.splice(members.indexOf(m), 1);
        return ok({});
      case "pause":
        m.paused = true;
        m.pause_reason = String(body.reason ?? "手动暂停");
        m.paused_until = (body.until as number) ?? null;
        return ok({ member: m });
      case "resume":
        m.paused = false;
        m.pause_reason = null;
        m.paused_until = null;
        return ok({ member: m });
      case "revoke":
        m.status = "revoked";
        m.online = false;
        return ok({ member: m });
      case "quota-rules": {
        const rules = (body.rules as Omit<QuotaRule, "member_id">[]) ?? [];
        for (let i = quotaRules.length - 1; i >= 0; i--) if (quotaRules[i]!.member_id === m.id) quotaRules.splice(i, 1);
        quotaRules.push(...rules.map((r) => ({ ...r, member_id: m.id })));
        return ok({ rules: quotaRules.filter((r) => r.member_id === m.id) });
      }
      case "budget": {
        const i = budgets.findIndex((b) => b.member_id === m.id);
        const b: Budget = { member_id: m.id, daily_tokens: (body.daily_tokens as number) ?? null, monthly_usd: (body.monthly_usd as number) ?? null };
        if (i >= 0) budgets[i] = b;
        else budgets.push(b);
        return ok({ budget: b });
      }
    }
    return notFound();
  }

  if (p[0] === "managers" && p[1] && p[2] === "scopes" && method === "PUT") {
    scopes[p[1]] = (body.workspace_ids as string[]) ?? [];
    return ok({ workspace_ids: scopes[p[1]] });
  }

  if (p[0] === "usage") return ok(usageView(q.get("group") ?? "day", Number(q.get("days") ?? 30)));

  if (p[0] === "runs") {
    const list = runs
      .filter((r) => (!q.get("member") || r.member_id === q.get("member")) && (q.get("failed") !== "1" || r.exit_code !== 0))
      .sort((a, b) => b.started_at - a.started_at);
    const { items, has_more } = page(list, q.get("before"), 20);
    return ok({ runs: items, has_more });
  }

  if (p[0] === "settings") {
    if (p[1] === "email" && method === "POST") {
      const e = String(body.email ?? "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return err(400, "bad_request", "邮箱格式不正确");
      return ok({ sent: true });
    }
    if (method === "PATCH") {
      const { notify_email_masked: _m, ...rest } = body;
      void _m;
      settings = { ...settings, ...(rest as Partial<SettingsResponse>) };
      if (body.notify_kinds) settings.notify_kinds = { ...settings.notify_kinds, ...(body.notify_kinds as object), email_change: true };
      if (typeof body.global_pause === "boolean") {
        for (const m of members) {
          if (m.kind !== "agent" || m.status !== "active") continue;
          if (body.global_pause) {
            if (!m.paused) Object.assign(m, { paused: true, pause_reason: "全局暂停", paused_until: null });
          } else if (m.pause_reason === "全局暂停") Object.assign(m, { paused: false, pause_reason: null });
        }
      }
    }
    return ok(settings);
  }

  if (p[0] === "notify" && p[1] === "test") {
    if (!settings.notify_email_masked) return err(400, "no_email", "还没有设置通知邮箱");
    return ok({ sent: true });
  }

  if (p[0] === "search") {
    const term = (q.get("q") ?? "").trim().toLowerCase();
    if (!term) return ok({ results: [] });
    const results = posts
      .filter((x) => {
        const t = threads.find((y) => y.id === x.thread_id)!;
        return (
          (x.body.toLowerCase().includes(term) || t.title.toLowerCase().includes(term)) &&
          (!q.get("member") || x.author_id === q.get("member")) &&
          (!q.get("status") || t.status === q.get("status")) &&
          (!q.get("workspace") || t.workspace_id === q.get("workspace"))
        );
      })
      .slice(0, 20)
      .map((x) => {
        const t = threads.find((y) => y.id === x.thread_id)!;
        const i = Math.max(0, x.body.toLowerCase().indexOf(term) - 30);
        return { post: x, thread: { id: t.id, title: t.title, status: t.status, workspace_id: t.workspace_id }, snippet: (i > 0 ? "…" : "") + x.body.slice(i, i + 120) };
      });
    return ok({ results });
  }

  if (p[0] === "audit") {
    const { items, has_more } = page(audit, q.get("before"), 20);
    return ok({ entries: items, has_more });
  }

  return notFound();
}

export function installMock(): void {
  setTransport(async (method, path, body) => {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    const res = handle(method, path, (body ?? {}) as Body);
    // Hand out copies so components never mutate mock state by accident.
    return { status: res.status, data: res.data === null ? null : structuredClone(res.data) };
  });
  console.info("[agentbus] mock API enabled (VITE_MOCK=1)");
}
