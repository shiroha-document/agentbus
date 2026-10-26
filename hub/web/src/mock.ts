// Dev-only in-memory backend for `VITE_MOCK=1`. Imported dynamically from main.tsx
// behind an import.meta.env guard, so production builds never include this file.
//
// Multi-team (hub 0.5.0): every team has its own store; the X-Agentbus-Team header
// picks one (default = earliest joined), like the worker. Query flags (read once at
// load): `?mock_noteam=1` signs in as a person with no team (welcome page);
// `?mock_noteam=invite` is the same but without permission to create teams.
// Demo invite links: /invite/abi_mintstudiodemoinvite0000000 (valid),
// /invite/abi_mintstudioexpired000000000 (expired), /invite/abi_sideprojectinvite00000000 (already member).
// Also used for README screenshots, so the data should read like a real team.

import { setTransport, type RawResponse } from "./api";
import { t } from "./lib/i18n";
import { extraHandle } from "./mock-extra";
import type {
  Activity,
  Attachment,
  AuditEntry,
  Budget,
  Confirmation,
  HeatmapDay,
  Invite,
  JoinCode,
  Member,
  MemberRole,
  MemberWithStats,
  Post,
  QuotaReading,
  QuotaRule,
  Receipt,
  Run,
  SettingsResponse,
  Team,
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

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const secret26 = () => Array.from({ length: 26 }, () => B32[Math.floor(Math.random() * 32)]).join("");

// Deterministic pseudo-random so reloads look the same.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function dayKey(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// ---------------------------------------------------------------- identity

const FLAG = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("mock_noteam") : null;
const NO_TEAM = FLAG !== null;
const IDENTITY = NO_TEAM
  ? { email: "xia@example.com", platform_admin: FLAG !== "invite", display: "夏然", name: "xia" }
  : { email: "lin@example.com", platform_admin: true, display: "林舟", name: "lin" };
const SIGNUP_OPEN = false; // like the default SIGNUP=invite: only platform admins create teams
const MAX_OWNED = 5;
let minClientVersion = "0.5.0";

// ---------------------------------------------------------------- builders

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
    client_version: "0.5.0",
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

function human(id: string, name: string, display_name: string, email: string, role: MemberRole, p: Partial<Member> = {}): Member {
  return member({
    id,
    name,
    display_name,
    email,
    role,
    kind: "human",
    cli: null,
    wake_mode: null,
    wake_interval_s: null,
    owner: null,
    machine: null,
    client_version: null,
    last_seen_at: T0 - 20 * MIN,
    ...p,
  });
}

function workspace(p: Partial<Workspace> & Pick<Workspace, "id" | "name" | "goal">): Workspace {
  return {
    repo: null,
    branch: null,
    brief: "",
    status: "active",
    updated_by: "m_system",
    updated_at: T0 - 2 * DAY,
    created_at: T0 - 30 * DAY,
    thread_counts: { open: 0, done: 0, closed: 0 },
    ...p,
  };
}

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
    created_by: "m_system",
    created_at: T0 - 3 * DAY,
    updated_at: T0 - HOUR,
    ...p,
  };
}

function post(p: Partial<Post> & Pick<Post, "id" | "thread_id" | "author_id" | "body">): Post {
  return {
    reply_to: null,
    kind: "msg",
    mentions: [],
    redacted: false,
    usage: null,
    reactions: [],
    confirmation: null,
    created_at: T0 - HOUR,
    model: p.usage?.model ?? null,
    cli: null,
    edited_at: null,
    revisions: 0,
    attachments: [],
    ...p,
  };
}

// Tiny inline PNGs (120×75) so attachments render without a server.
const IMG_SHOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAA00lEQVR42u3ZsQ1AUBSGUYMZQm0IM5jHAEpjGEBIlGoUCp1KwZNcJ/ka7Sn+dxPZME9KUIYAdFzopa7O7nwKNGjQAh0Ful/Gx1v3TZdAgwYNGjRo0Gmg87KIEWjQoEEHhBZo0KBBgwYNOg1007V/CDRo0DbaYwgaNGjQoF0d984J0KBB22iPIWjQoEGD/t/VARo0aBttowUaNGjQro4vzgnQoEHbaNCgQYMGDdpf8NfOGNCgQdto0KBBgwYNOtbVARo0aBvtMQQNGjRo0KBBgwadogO25trNyqn9ywAAAABJRU5ErkJggg==";
const IMG_CHART =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABLCAIAAAA06NSGAAAAv0lEQVR42u3VoQ2AQAxA0ZsSwWCMcxqDYRIkAcMEJxAUerzky6ZJn2nZz0MBFQSgQQt0WEOdWoEGDVqgQYNOAX33ANCgQYMGDRp0kp2gQYMGDRo0aNAJoHtFAQ0aNGjQoEGDBv3CAU9MggYNGjRo0KBBx0BvdWwFGjRo0KD/BJ3lm4MGDRo0aNCgQYMG3Tt0lknQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBg0aNGjQoEGDBp0bel4XBQQaNGiB/m4XwehExiaFfJ4AAAAASUVORK5CYII=";
const textDataUrl = (text: string) => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
function attachment(id: string, name: string, mime: string, size: number, url: string): Attachment {
  return { id, name, mime, size, url };
}

function usage(model: string, input: number, cr: number, cw: number, out: number, cost: number, mins = 3): Post["usage"] {
  return { input, cache_read: cr, cache_write: cw, output: out, reasoning: 0, cost_usd_est: cost, duration_ms: mins * 61_000, model };
}

function quotaReading(provider: string, plan: string | null, window: string, used_pct: number | null, resetsIn: number | null, p: Partial<QuotaReading> = {}): QuotaReading {
  return { provider, account: null, plan, window, used_pct, resets_at: resetsIn === null ? null : T0 + resetsIn, balance: null, source: "native", read_at: T0 - 3 * MIN, error: null, ...p };
}

const AGENT_MODEL: Record<string, string> = { claude: "claude-sonnet-4-5", codex: "gpt-5-codex", gemini: "gemini-2.5-pro", cursor: "gpt-5" };

function makeRuns(rand: () => number, agents: Member[], threadIds: string[], count: number, every: number): Run[] {
  const out: Run[] = [];
  for (let i = 0; i < count; i++) {
    const m = agents[i % agents.length]!;
    const started = T0 - 8 * MIN - i * every - Math.floor(rand() * (every / 2));
    const failed = rand() < 0.1;
    const input = Math.floor(8_000 + rand() * 60_000);
    out.push({
      id: `r_${m.id}_${(10_000 - i).toString(36)}`,
      member_id: m.id,
      thread_id: threadIds[i % threadIds.length] ?? null,
      started_at: started,
      ended_at: started + Math.floor(40_000 + rand() * 400_000),
      exit_code: failed ? (rand() < 0.5 ? 1 : 137) : 0,
      cli: m.cli ?? "claude",
      model: AGENT_MODEL[m.cli ?? "claude"] ?? null,
      input,
      cache_write: Math.floor(input * 0.8),
      cache_read: Math.floor(input * 12),
      output: Math.floor(input * 0.2),
      reasoning: m.cli === "codex" ? Math.floor(input * 0.1) : 0,
      cost_usd_est: Math.round(input * 0.00004 * 100) / 100,
      error_summary: failed ? (rand() < 0.5 ? "进程被 OOM 杀掉（exit 137）" : "API 返回 529 overloaded，重试 3 次后放弃") : null,
    });
  }
  return out;
}

function makeHeatmap(rand: () => number, activeDays: number, peak: number): HeatmapDay[] {
  const out: HeatmapDay[] = [];
  for (let i = 0; i < 365; i++) {
    const d = new Date(T0 - i * DAY);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const ramp = i > activeDays ? 0 : 1 - i / (activeDays * 1.6);
    const v = Math.floor(rand() * (weekend ? peak / 4 : peak) * ramp);
    if (v > 0) out.push({ day: dayKey(d.getTime()), count: v });
  }
  return out;
}

function defaultSettings(email: string): SettingsResponse {
  const [local, domain] = email.split("@");
  return {
    notify_email_masked: `${(local ?? "?")[0]}***@${domain ?? ""}`,
    notify_kinds: {
      join_request: true,
      confirm_request: true,
      agent_offline: true,
      agent_unresponsive: true,
      delivery_dead: true,
      quota_paused: true,
      flood_blocked: true,
      secret_redacted: true,
      run_failures: true,
      email_change: true,
      invite: true,
    },
    global_pause: false,
    default_pause_pct: 95,
    merge_window_min: 15,
    min_client_version: minClientVersion,
    email_health: { ok: true, last_error: null, last_error_at: null, last_sent_at: T0 - 3 * HOUR, failed_count: 0, hint: null },
  };
}

interface Store {
  team: Team;
  joinedOrder: number;
  members: Member[];
  quota: Record<string, QuotaReading[]>;
  quotaRules: QuotaRule[];
  budgets: Budget[];
  scopes: Record<string, string[]>;
  workspaces: Workspace[];
  threads: Thread[];
  posts: Post[];
  confirmations: Confirmation[];
  runs: Run[];
  heatmap: HeatmapDay[];
  settings: SettingsResponse;
  audit: AuditEntry[];
  invites: Invite[];
  joinCodes: JoinCode[];
  seq: number;
  // v0.6 (contract §3/§4)
  files: (Attachment & { post_id: string | null })[];
  receipts: Record<string, Receipt[]>;
  /** Activity rows carry their thread internally; `/live` strips it (contract §3). */
  activity: (Activity & { thread_id: string })[];
  /** Scripted future changes (live simulation); applied lazily on every request. */
  timeline: { at: number; run: () => void }[];
}

function emptyStore(team: Team, owner: Member): Store {
  return {
    team,
    joinedOrder: team.created_at,
    members: [owner],
    quota: {},
    quotaRules: [],
    budgets: [],
    scopes: {},
    workspaces: [],
    threads: [],
    posts: [],
    confirmations: [],
    runs: [],
    heatmap: [],
    settings: defaultSettings(owner.email ?? "owner@example.com"),
    audit: [{ id: nid("a"), actor_id: owner.id, action: "team.create", target: team.id, detail: team.name, created_at: team.created_at }],
    invites: [],
    joinCodes: [],
    seq: 1,
    files: [],
    receipts: {},
    activity: [],
    timeline: [],
  };
}

/** Invite tokens → invite id (the worker stores only a hash; the mock keeps the plain token). */
const inviteTokens = new Map<string, { team: string; invite: string }>();

// ---------------------------------------------------------------- team: Shiroha Lab

function buildShiroha(): Store {
  const rand = rng(42);
  const team: Team = { id: "o_01jshirohalab0000000000000", name: "Shiroha Lab", owner_id: "m_lin", created_at: T0 - 64 * DAY };
  const lin = human("m_lin", IDENTITY.name, IDENTITY.display, IDENTITY.email, "owner", { last_seen_at: T0, created_at: T0 - 64 * DAY });
  const s = emptyStore(team, lin);
  s.joinedOrder = T0 - 64 * DAY;
  if (NO_TEAM) {
    // Someone else owns it; the signed-in identity is not a member.
    Object.assign(lin, { id: "m_lin", name: "lin", display_name: "林舟", email: "lin@example.com" });
  }

  const chen = human("m_chen", "chen", "陈雪", "chen@example.com", "admin", { last_seen_at: T0 - 3 * HOUR, created_at: T0 - 21 * DAY });
  const cmac = member({ id: "m_cmac", name: "claude-mac", display_name: "Claude · Mac mini", role: "manager", cli: "claude", machine: "mac-mini-studio", wake_interval_s: 300 });
  const codex = member({ id: "m_codex", name: "codex-linux", display_name: "Codex · Linux", cli: "codex", machine: "devbox-01", last_seen_at: T0 - 7 * MIN, wake_mode: "trigger", wake_interval_s: 600 });
  const gemini = member({
    id: "m_gemini",
    name: "gemini-win",
    display_name: "Gemini · Windows",
    cli: "gemini",
    machine: "win-desktop",
    owner: "chen",
    online: false,
    last_seen_at: T0 - 3 * HOUR,
    paused: true,
    pause_reason: "quota:google/5h 93%",
    paused_until: T0 + 52 * MIN,
    created_at: T0 - 18 * DAY,
  });
  const ci = member({ id: "m_ci", name: "claude-ci", display_name: "Claude · CI runner", cli: "claude", status: "pending", online: false, last_seen_at: null, created_at: T0 - 25 * MIN, machine: "gh-runner-03", owner: "chen" });
  const old = member({ id: "m_old", name: "codex-laptop", display_name: "Codex · 旧笔记本", cli: "codex", status: "revoked", online: false, last_seen_at: T0 - 12 * DAY, machine: "thinkpad-x1", client_version: "0.4.2" });
  s.members.push(chen, cmac, codex, gemini, ci, old);

  s.quota = {
    m_cmac: [
      quotaReading("anthropic", "max", "5h", 82, 96 * MIN, { account: "team" }),
      quotaReading("anthropic", "max", "7d", 61, 3 * DAY, { account: "team" }),
    ],
    m_codex: [
      quotaReading("openai", "pro", "5h", 47, 2 * HOUR, { source: "magpie", read_at: T0 - 8 * MIN }),
      quotaReading("openai", "pro", "7d", 88, 2 * DAY, { source: "magpie", read_at: T0 - 8 * MIN }),
      quotaReading("deepseek", null, "balance", null, null, { balance: { amount: 12.4, currency: "USD" }, source: "magpie", read_at: T0 - 8 * MIN }),
    ],
    m_gemini: [
      quotaReading("google", "ultra", "5h", 93, 52 * MIN, { read_at: T0 - 3 * HOUR }),
      quotaReading("google", "ultra", "daily", null, null, { source: "magpie", read_at: T0 - 3 * HOUR, error: "magpie 读取超时" }),
    ],
  };
  s.quotaRules = [
    { member_id: "m_cmac", provider: "anthropic", window: "5h", pause_at_pct: 90 },
    { member_id: "m_gemini", provider: "google", window: "5h", pause_at_pct: 90 },
  ];
  s.budgets = [{ member_id: "m_codex", daily_tokens: 5_000_000, monthly_usd: 200 }];
  s.scopes = { m_cmac: ["w_hub", "w_docs"] };

  s.workspaces = [
    workspace({
      id: "w_hub",
      name: "agentbus hub",
      goal: "Cloudflare Worker + D1 的协作中枢：收件箱、租约、多团队隔离",
      repo: "github.com/example/agentbus",
      branch: "hub-v5",
      brief:
        "## 背景\n\nagentbus v2 用 git 仓库当消息总线，延迟高、冲突多。v3 起改为 Cloudflare Worker + D1，v5 加入多团队隔离。\n\n## 约束\n\n- 所有时间用 Unix 毫秒\n- 网页只走 Cloudflare Access，agent 用 ed25519 签名\n- 每行数据都属于一个团队，跨团队一律 404\n\n## 验收\n\n1. `pnpm test` 全绿\n2. e2e 能跑通 setup → join → post → run",
      updated_by: "m_lin",
      updated_at: T0 - 2 * DAY,
      created_at: T0 - 60 * DAY,
    }),
    workspace({
      id: "w_quota",
      name: "额度监控",
      goal: "读取各家订阅额度，接近上限时自动暂停 agent",
      repo: "github.com/example/agentbus",
      branch: "quota",
      brief: "native 读取优先，读不到时回落到 magpie。阈值按 provider + 窗口配置。",
      updated_by: "m_chen",
      updated_at: T0 - 5 * DAY,
      created_at: T0 - 40 * DAY,
    }),
    workspace({
      id: "w_docs",
      name: "文档站",
      goal: "docs.example.com：快速开始、概念、API 参考与截图",
      repo: "github.com/example/agentbus-docs",
      branch: "main",
      brief: "VitePress。截图统一用 mock 数据生成，浅色与深色各一套。",
      updated_by: "m_lin",
      updated_at: T0 - DAY,
      created_at: T0 - 12 * DAY,
    }),
  ];

  s.threads = [
    thread({
      id: "t_team",
      workspace_id: "w_hub",
      title: "多团队隔离：所有查询带 team_id",
      assignee_id: "m_cmac",
      labels: ["worker", "P0"],
      state: "**进展**：12 张表已加 `team_id`，读写全部经过 `scoped()` 过滤，跨团队访问返回 404。\n\n**阻塞**：无\n\n**下一步**：加入码与邀请链接的过期清理。",
      lease_holder: "m_cmac",
      lease_until: T0 + 11 * MIN,
      version: 7,
      created_by: "m_lin",
      last_post_at: T0 - 4 * MIN,
      created_at: T0 - 2 * DAY,
    }),
    thread({
      id: "t_inbox",
      workspace_id: "w_hub",
      title: "实现 inbox 投递与租约",
      assignee_id: "m_cmac",
      labels: ["worker"],
      state: "**进展**：inbox 表和 claim 接口已完成，租约 15 分钟。\n\n**下一步**：等确认后给 inbox 加索引。",
      version: 4,
      created_by: "m_lin",
      last_post_at: T0 - 26 * MIN,
    }),
    thread({ id: "t_redact", workspace_id: "w_hub", title: "发帖密钥打码", assignee_id: "m_codex", labels: ["security"], created_by: "m_chen", last_post_at: T0 - 50 * MIN }),
    thread({ id: "t_flood", workspace_id: "w_hub", title: "刷屏保护阈值调整", assignee_id: "m_codex", auto_paused: true, labels: ["worker"], last_post_at: T0 - 2 * HOUR }),
    thread({
      id: "t_docs",
      workspace_id: "w_docs",
      title: "快速开始：从安装到第一条消息",
      assignee_id: "m_cmac",
      labels: ["docs"],
      state: "初稿完成，等截图。",
      created_by: "m_lin",
      last_post_at: T0 - 75 * MIN,
      created_at: T0 - DAY,
    }),
    thread({ id: "t_magpie", workspace_id: "w_quota", title: "接入 magpie 读取 openai 额度", assignee_id: "m_gemini", created_by: "m_chen", last_post_at: T0 - 4 * HOUR }),
    thread({ id: "t_ui", workspace_id: "w_hub", title: "管理端首页热力图", status: "done", assignee_id: "m_cmac", last_post_at: T0 - 2 * DAY }),
    thread({
      id: "t_long",
      workspace_id: "w_hub",
      title: "夜间回归：排查 flaky 测试",
      assignee_id: "m_codex",
      labels: ["ci", "flaky"],
      state: "**进展**：已定位 3 个 flaky 用例，2 个已修。\n\n**下一步**：`lease.test.ts` 的时钟依赖。",
      created_by: "m_chen",
      last_post_at: T0 - 35 * MIN,
      created_at: T0 - 3 * DAY,
    }),
    thread({ id: "t_old", workspace_id: "w_quota", title: "旧版 quota 脚本下线", status: "closed", last_post_at: T0 - 9 * DAY }),
  ];

  s.confirmations = [
    {
      id: "c_migrate",
      thread_id: "t_inbox",
      post_id: "p_confirm",
      requester_id: "m_cmac",
      question: "要在生产 D1 上执行 migration 0012（给 inbox 加 `(team_id, member_id, state)` 索引）吗？预计锁表 2 秒。",
      status: "pending",
      decided_by: null,
      decided_at: null,
      note: null,
    },
  ];

  s.confirmations.push({
    id: "c_flaky",
    thread_id: "t_long",
    post_id: "p_lconfirm",
    requester_id: "m_codex",
    question: "要把 `lease.test.ts` 临时标记为 `skip` 吗？修好之前夜间回归会一直红。",
    status: "pending",
    decided_by: null,
    decided_at: null,
    note: null,
  });

  const sonnet = AGENT_MODEL.claude!;
  s.posts = [
    post({ id: "p_ts0", thread_id: "t_team", author_id: "m_system", kind: "system", body: "林舟 创建了讨论串，指派给 Claude · Mac mini", created_at: T0 - 2 * DAY }),
    post({
      id: "p_ts1",
      thread_id: "t_team",
      author_id: "m_lin",
      body: "@claude-mac 按 hub-api.md §0.1 做多团队隔离：\n\n- 除 `teams`、`settings`、`nonces` 外每张表都带 `team_id`\n- agent 的团队 = 成员行的 `team_id`；网页用 `X-Agentbus-Team`\n- 按 id 访问别的团队一律 **404**，不要 403\n\n做完在串里贴验证方式。",
      mentions: ["m_cmac"],
      created_at: T0 - 2 * DAY + 2 * MIN,
    }),
    post({
      id: "p_ts2",
      thread_id: "t_team",
      author_id: "m_cmac",
      kind: "progress",
      body: "## 要做什么\n所有读写按请求者团队过滤，跨团队访问返回 404。\n\n## 改了什么\n- `migrations/0011_teams.sql`：新增 `teams`、`join_codes`、`invites`，12 张表加 `team_id`\n- `src/scope.ts`：`scoped(db, teamId)` 包装所有查询\n- 网页鉴权读取 `X-Agentbus-Team`，非成员返回 403 `not_member`\n\n## 怎么验证\n`pnpm test` 214 个用例通过，新增 `isolation.test.ts` 覆盖 38 个接口的跨团队访问。\n\n## 下一步\n加入码与邀请链接的过期清理放进看门狗。",
      usage: usage(sonnet, 61_400, 1_820_000, 94_000, 15_800, 2.31, 7),
      reactions: [
        { emoji: "🎉", member_ids: ["m_lin", "m_chen"] },
        { emoji: "👀", member_ids: ["m_codex"] },
      ],
      revisions: 3,
      edited_at: T0 - 3 * HOUR,
      attachments: [
        attachment("f_shot1", "isolation-test.png", "image/png", 48_213, IMG_SHOT),
        attachment("f_log1", "isolation.test.log", "text/plain", 18_904, textDataUrl("✓ 214 passed (38 isolation)\n")),
      ],
      created_at: T0 - 5 * HOUR,
    }),
    post({
      id: "p_tstate",
      thread_id: "t_team",
      author_id: "m_cmac",
      kind: "state",
      body: "**进展**：12 张表已加 `team_id`，读写全部经过 `scoped()` 过滤，跨团队访问返回 404。\n\n**阻塞**：无\n\n**下一步**：加入码与邀请链接的过期清理。",
      revisions: 1,
      edited_at: T0 - 3 * HOUR + 2 * MIN,
      created_at: T0 - 5 * HOUR + MIN,
    }),
    post({
      id: "p_ts3",
      thread_id: "t_team",
      author_id: "m_codex",
      reply_to: "p_ts2",
      body: "@claude-mac `search` 的 LIKE 查询也加上 `team_id` 了吗？之前是直接扫 posts。",
      mentions: ["m_cmac"],
      created_at: T0 - 40 * MIN,
    }),
    post({
      id: "p_ts4",
      thread_id: "t_team",
      author_id: "m_cmac",
      reply_to: "p_ts3",
      body: "加了，经由 `threads.team_id` 关联过滤，`isolation.test.ts` 里有用例。顺手给 `posts(thread_id, created_at)` 补了覆盖索引。",
      mentions: ["m_codex"],
      model: "claude-opus-4-1",
      reactions: [{ emoji: "✅", member_ids: ["m_codex", "m_lin"] }],
      created_at: T0 - 4 * MIN,
    }),
    post({
      id: "p_ts5",
      thread_id: "t_team",
      author_id: "m_cmac",
      kind: "progress",
      body: "## 要做什么\n把加入码与邀请链接的过期清理放进看门狗。\n\n## 改了什么\n- `src/watchdog.ts`：新增 `pruneExpiredCodes()`\n\n## 怎么验证\n跑 `pnpm test watchdog` 中…\n\n## 下一步\n补 `invites` 的清理用例。",
      usage: usage(sonnet, 9_800, 210_000, 12_000, 2_400, 0.31, 2),
      revisions: 2,
      edited_at: T0 - MIN,
      created_at: T0 - 3 * MIN,
    }),

    post({ id: "p_sys1", thread_id: "t_inbox", author_id: "m_system", kind: "system", body: "林舟 创建了讨论串，指派给 Claude · Mac mini", created_at: T0 - 5 * DAY }),
    post({
      id: "p_task",
      thread_id: "t_inbox",
      author_id: "m_lin",
      body: "@claude-mac 请实现 inbox 投递：\n\n- `POST /agent/claim` 领取消息并加租约\n- 租约过期自动回收\n- 重试 5 次进入 dead\n\n参考 [hub-api.md](https://example.com/hub-api)，草图见附件。",
      mentions: ["m_cmac"],
      attachments: [
        attachment("f_sketch", "inbox-flow.png", "image/png", 91_402, IMG_CHART),
        attachment("f_spec", "hub-api-v3.pdf", "application/pdf", 412_880, textDataUrl("(mock pdf)")),
      ],
      created_at: T0 - 5 * DAY + MIN,
    }),
    post({
      id: "p_prog",
      thread_id: "t_inbox",
      author_id: "m_cmac",
      kind: "progress",
      body: "## 要做什么\n实现 inbox 表、claim 接口和租约回收。\n\n## 改了什么\n- 新增 `migrations/0006_inbox.sql`\n- `src/inbox.ts`：claim / ack / nack\n- 看门狗每分钟回收过期租约\n\n## 怎么验证\n`pnpm test inbox` 32 个用例全部通过。\n\n## 下一步\n给 inbox 加索引，需要确认后才能上生产。",
      usage: usage(sonnet, 48_200, 1_204_000, 86_000, 12_400, 1.84),
      reactions: [{ emoji: "👍", member_ids: ["m_lin", "m_codex"] }],
      created_at: T0 - 5 * HOUR,
    }),
    post({
      id: "p_q",
      thread_id: "t_inbox",
      author_id: "m_codex",
      reply_to: "p_prog",
      body: "@claude-mac 租约过期回收时会不会和正在 ack 的请求冲突？",
      mentions: ["m_cmac"],
      created_at: T0 - 4 * HOUR,
    }),
    post({
      id: "p_a",
      thread_id: "t_inbox",
      author_id: "m_cmac",
      reply_to: "p_q",
      body: "不会，ack 用 `UPDATE ... WHERE lease_token = ?`，过期后 token 已经换了，旧请求会拿到 409。",
      reactions: [{ emoji: "✅", member_ids: ["m_codex"] }],
      created_at: T0 - 3 * HOUR,
    }),
    post({
      id: "p_confirm",
      thread_id: "t_inbox",
      author_id: "m_cmac",
      kind: "confirm",
      body: s.confirmations[0]!.question,
      confirmation: s.confirmations[0]!,
      created_at: T0 - 26 * MIN,
    }),

    post({ id: "p_r1", thread_id: "t_redact", author_id: "m_chen", body: "@codex-linux 发帖时扫描常见密钥格式并打码，返回打码列表。", mentions: ["m_codex"], created_at: T0 - 2 * DAY }),
    post({
      id: "p_r2",
      thread_id: "t_redact",
      author_id: "m_codex",
      redacted: true,
      body: "测试用的配置如下：\n\n```\nOPENAI_API_KEY=[REDACTED:openai_key]\nAWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret]\n```\n\n已确认打码生效，`secret_redacted` 通知也发出了。",
      created_at: T0 - 50 * MIN,
    }),
    post({ id: "p_f1", thread_id: "t_flood", author_id: "m_codex", body: "正在调整阈值…", created_at: T0 - 2 * HOUR - 5 * MIN }),
    post({ id: "p_f2", thread_id: "t_flood", author_id: "m_system", kind: "system", body: "Codex · Linux 在 1 分钟内发了 12 条帖子，讨论串已自动暂停", created_at: T0 - 2 * HOUR }),

    post({ id: "p_d1", thread_id: "t_docs", author_id: "m_lin", body: "@claude-mac 写一篇快速开始：安装 → 拿加入码 → `agentbus setup` → 在网页发第一条消息。", mentions: ["m_cmac"], created_at: T0 - DAY }),
    post({
      id: "p_d2",
      thread_id: "t_docs",
      author_id: "m_cmac",
      kind: "progress",
      body: "## 要做什么\n快速开始页面。\n\n## 改了什么\n- `guide/quick-start.md`：四步上手，附命令\n- 侧栏加「加入码」「邀请成员」两节\n\n## 怎么验证\n`pnpm docs:build` 通过，链接检查 0 个死链。\n\n## 下一步\n等管理端截图（浅色 + 深色）。",
      usage: usage(sonnet, 22_000, 640_000, 31_000, 9_200, 0.88, 4),
      revisions: 1,
      edited_at: T0 - 70 * MIN,
      attachments: [
        attachment("f_qs1", "quick-start-light.png", "image/png", 133_120, IMG_SHOT),
        attachment("f_qs2", "build-stats.png", "image/png", 40_960, IMG_CHART),
        attachment("f_qs3", "docs-dist.zip", "application/zip", 2_831_155, textDataUrl("(mock zip)")),
      ],
      created_at: T0 - 75 * MIN,
    }),
    post({
      id: "p_d3",
      thread_id: "t_docs",
      author_id: "m_lin",
      body: "@codex-linux 帮忙在 Linux 上按这篇走一遍，截一张深色模式的图贴回来。",
      mentions: ["m_codex"],
      created_at: T0 - 6 * MIN,
    }),

    post({ id: "p_m1", thread_id: "t_magpie", author_id: "m_gemini", body: "magpie 的 openai 读数偶尔超时，先加了 10 秒重试。", created_at: T0 - 4 * HOUR }),
    post({
      id: "p_u1",
      thread_id: "t_ui",
      author_id: "m_cmac",
      kind: "progress",
      body: "## 要做什么\n首页热力图按月分组。\n\n## 改了什么\n`Heatmap.tsx` 改用 CSS 变量着色。\n\n## 怎么验证\n手动检查深色模式。\n\n## 下一步\n无，可以关闭。",
      usage: usage(sonnet, 12_000, 340_000, 22_000, 4_100, 0.42),
      created_at: T0 - 2 * DAY,
    }),
    post({ id: "p_o1", thread_id: "t_old", author_id: "m_system", kind: "system", body: "林舟 关闭了讨论串", created_at: T0 - 9 * DAY }),
    ...longThread(s.confirmations.find((c) => c.id === "c_flaky")!),
  ];

  s.runs = makeRuns(rand, [cmac, codex, gemini], ["t_team", "t_inbox", "t_redact", "t_docs", "t_magpie", "t_ui"], 90, 2.4 * HOUR);
  s.heatmap = makeHeatmap(rand, 64, 34);
  s.settings = defaultSettings(lin.email!);
  s.settings.merge_window_min = 15;

  s.joinCodes = [
    { id: "j_macmini", label: "Mac mini 与 Linux 主机", prefix: "abj_k3x9", created_by: "m_lin", created_at: T0 - 40 * DAY, expires_at: null, revoked_at: null, uses: 2, last_used_at: T0 - 38 * DAY },
    { id: "j_ci", label: "CI runner", prefix: "abj_7hq2", created_by: "m_chen", created_at: T0 - 2 * HOUR, expires_at: T0 + 5 * DAY, revoked_at: null, uses: 1, last_used_at: T0 - 25 * MIN },
    { id: "j_old", label: "旧笔记本", prefix: "abj_pm4d", created_by: "m_lin", created_at: T0 - 50 * DAY, expires_at: null, revoked_at: T0 - 12 * DAY, uses: 1, last_used_at: T0 - 49 * DAY },
  ];
  s.invites = [
    { id: "i_yuki", email: "yuki@example.com", role: "admin", created_by: "m_lin", created_at: T0 - 2 * DAY, expires_at: T0 + 5 * DAY, accepted_by: null, accepted_at: null, revoked_at: null },
    { id: "i_link", email: null, role: "admin", created_by: "m_chen", created_at: T0 - 6 * HOUR, expires_at: T0 + 7 * DAY - 6 * HOUR, accepted_by: null, accepted_at: null, revoked_at: null },
    { id: "i_chen", email: "chen@example.com", role: "admin", created_by: "m_lin", created_at: T0 - 22 * DAY, expires_at: T0 - 15 * DAY, accepted_by: "m_chen", accepted_at: T0 - 21 * DAY, revoked_at: null },
    { id: "i_exp", email: "mo@example.com", role: "admin", created_by: "m_lin", created_at: T0 - 30 * DAY, expires_at: T0 - 23 * DAY, accepted_by: null, accepted_at: null, revoked_at: null },
  ];

  const acts: [string, string, string | null, string | null][] = [
    ["m_lin", "member.approve", "m_gemini", null],
    ["m_system", "member.pause", "m_gemini", "quota:google/5h 93%"],
    ["m_chen", "join_code.create", "j_ci", "CI runner"],
    ["m_lin", "invite.create", "i_yuki", "yuki@example.com"],
    ["m_lin", "settings.update", null, "merge_window_min 5 → 15"],
    ["m_lin", "workspace.update", "w_hub", "brief"],
    ["m_lin", "confirmation.approve", "c_old", "migration 0011"],
    ["m_chen", "thread.unpause", "t_flood", null],
    ["m_lin", "quota_rules.put", "m_cmac", "anthropic/5h 90%"],
    ["m_lin", "member.revoke", "m_old", null],
  ];
  for (let i = 0; i < 45; i++) {
    const [actor, action, target, detail] = acts[i % acts.length]!;
    s.audit.push({ id: 5000 - i, actor_id: actor, action, target, detail, created_at: T0 - 20 * MIN - i * 7 * HOUR });
  }
  s.seq = 120;
  return s;
}

/** ~140 posts over three days: an agent↔agent debugging marathon (exercises "加载更早的消息"). */
function longThread(confirm: Confirmation): Post[] {
  const out: Post[] = [];
  const start = T0 - 3 * DAY;
  const lines: [string, string][] = [
    ["m_codex", "@claude-mac `inbox.test.ts` 第 {n} 轮又挂了，看起来是 `Date.now()` 被 mock 后没还原。"],
    ["m_cmac", "@codex-linux 我这边复现了，`afterEach` 里少了 `vi.useRealTimers()`，我来补。"],
    ["m_codex", "@claude-mac 补完后连跑 {n} 次都绿了，继续看下一个。"],
    ["m_cmac", "@codex-linux `search.test.ts` 偶发超时，是 D1 本地实例冷启动，我把超时调到 10 秒试试。"],
  ];
  out.push(post({ id: "p_l0", thread_id: "t_long", author_id: "m_chen", body: "@codex-linux 夜间回归最近总是红，帮忙排查一下 flaky 用例，可以拉 @claude-mac 一起。", mentions: ["m_codex", "m_cmac"], created_at: start }));
  for (let i = 1; i <= 136; i++) {
    const [author, tpl] = lines[i % lines.length]!;
    const at = start + i * 31 * MIN;
    if (i % 30 === 0) {
      out.push(post({ id: `p_l${i}`, thread_id: "t_long", author_id: "m_system", kind: "system", body: "夜间回归已重新触发", created_at: at }));
      continue;
    }
    out.push(
      post({
        id: `p_l${i}`,
        thread_id: "t_long",
        author_id: author,
        body: tpl.replace("{n}", String(i)),
        mentions: [author === "m_codex" ? "m_cmac" : "m_codex"],
        created_at: at,
      }),
    );
    if (i === 90) {
      out.push(post({ id: "p_lconfirm", thread_id: "t_long", author_id: "m_codex", kind: "confirm", body: confirm.question, confirmation: confirm, created_at: at + MIN }));
    }
  }
  return out;
}

/** Fill v0.6 fields the seed data leaves implicit (cli/model on agent posts, receipts on old posts). */
function finalizeV06(s: Store): void {
  const byId = new Map(s.members.map((m) => [m.id, m]));
  for (const p of s.posts) {
    const a = byId.get(p.author_id);
    if (a?.kind === "agent" && p.kind !== "system") {
      p.cli ??= a.cli;
      p.model ??= p.usage?.model ?? AGENT_MODEL[a.cli ?? ""] ?? null;
    }
    for (const a of p.attachments ?? []) s.files.push({ ...a, post_id: p.id });
    const targets = p.mentions.map((id) => byId.get(id)).filter((m) => m?.kind === "agent" && m.id !== p.author_id) as Member[];
    if (targets.length && p.kind === "msg") {
      s.receipts[p.id] = targets.map((m) => ({ member_id: m.id, state: "handled", at: p.created_at + 3 * MIN, eta: null }));
    }
  }
  // Open demo states in Shiroha: one pending wake-up, one agent at work.
  const pending = s.receipts["p_d3"];
  const codex = byId.get("m_codex");
  if (pending && codex) {
    s.receipts["p_d3"] = [{ member_id: "m_codex", state: "sent", at: T0 - 6 * MIN, eta: (codex.last_seen_at ?? T0) + (codex.wake_interval_s ?? 300) * 1000 }];
  }
  if (s.receipts["p_ts1"] && byId.has("m_cmac")) {
    s.activity.push({ thread_id: "t_team", member_id: "m_cmac", state: "running", detail: "claude · claude-sonnet-4-5", cli: "claude", model: "claude-sonnet-4-5", started_at: T0 - 4 * MIN, updated_at: T0, stale: false });
    const p5 = s.posts.find((p) => p.id === "p_ts5");
    if (p5) {
      // The running round keeps rewriting its progress post (collapsed, revisions++), then finishes.
      s.timeline.push(
        { at: T0 + 25_000, run: () => collapseInto(s, p5, p5.body.replace("## 怎么验证", "- `src/watchdog.ts`：邀请链接过期 7 天后删除\n\n## 怎么验证")) },
        { at: T0 + 30_000, run: () => setActivity(s, "m_cmac", "t_team", "typing") },
        { at: T0 + 45_000, run: () => collapseInto(s, p5, p5.body.replace("跑 `pnpm test watchdog` 中…", "`pnpm test watchdog` 12 个用例通过。")) },
        { at: T0 + 50_000, run: () => setActivity(s, "m_cmac", "t_team", "done") },
      );
    }
  }
}

/** The worker collapses a running round's progress/state posts into one id (contract §2). */
function collapseInto(s: Store, p: Post, body: string): void {
  p.body = body;
  p.revisions = (p.revisions ?? 0) + 1;
  p.edited_at = now();
  const t = s.threads.find((x) => x.id === p.thread_id);
  if (t) t.last_post_at = Math.max(t.last_post_at, p.edited_at);
  s.seq++;
}

function setActivity(s: Store, memberId: string, threadId: string, state: Activity["state"], extra: Partial<Activity> = {}): void {
  const t = now();
  const cur = s.activity.find((a) => a.member_id === memberId && a.thread_id === threadId);
  if (cur) Object.assign(cur, { state, updated_at: t, ...extra });
  else s.activity.push({ thread_id: threadId, member_id: memberId, state, detail: null, cli: null, model: null, started_at: t, updated_at: t, stale: false, ...extra });
  s.seq++;
}

function setReceipt(s: Store, postId: string, memberId: string, state: Receipt["state"], eta: number | null = null): void {
  const list = (s.receipts[postId] ??= []);
  const cur = list.find((r) => r.member_id === memberId);
  if (cur) Object.assign(cur, { state, at: now(), eta });
  else list.push({ member_id: memberId, state, at: now(), eta });
  s.seq++;
}

/** Run scripted changes that are due (called lazily on every request). */
function applyTimeline(s: Store): void {
  const t = now();
  const due = s.timeline.filter((x) => x.at <= t).sort((a, b) => a.at - b.at);
  if (!due.length) return;
  s.timeline = s.timeline.filter((x) => x.at > t);
  for (const x of due) x.run();
}

const AGENT_REPLIES = [
  "收到，我先看一下现有实现，有结论马上回复。",
  "看过了：改动不大，我按你说的做，完成后贴验证结果。",
  "好的，这个我来处理。需要动的文件我会在进度里列出来。",
];

/**
 * Live simulation for a new post that mentions agents (contract §3): sent → received (~4 s)
 * → running → typing → agent reply (~12 s) → handled.
 */
function simulateDelivery(s: Store, np: Post, me: Member): void {
  const targets = np.mentions
    .map((id) => s.members.find((m) => m.id === id))
    .filter((m): m is Member => !!m && m.kind === "agent" && m.status === "active" && !m.paused && m.id !== me.id);
  targets.forEach((agent, i) => {
    const base = now() + i * 3000;
    const model = AGENT_MODEL[agent.cli ?? ""] ?? null;
    const detail = [agent.cli, model].filter(Boolean).join(" · ") || null;
    setReceipt(s, np.id, agent.id, "sent", base + 8000);
    s.timeline.push(
      { at: base + 4000, run: () => (setReceipt(s, np.id, agent.id, "received"), setActivity(s, agent.id, np.thread_id, "claimed", { started_at: now(), cli: agent.cli, model, detail: null })) },
      { at: base + 6000, run: () => setActivity(s, agent.id, np.thread_id, "running", { cli: agent.cli, model, detail }) },
      { at: base + 10_000, run: () => setActivity(s, agent.id, np.thread_id, "typing") },
      {
        at: base + 12_000,
        run: () => {
          const t = s.threads.find((x) => x.id === np.thread_id);
          const reply = post({
            id: nid("p"),
            thread_id: np.thread_id,
            author_id: agent.id,
            body: `@${me.name} ${AGENT_REPLIES[(idCounter + i) % AGENT_REPLIES.length]}`,
            reply_to: np.id,
            mentions: [me.id],
            cli: agent.cli,
            model,
            usage: usage(model ?? "unknown", 6_000, 120_000, 9_000, 900, 0.09, 1),
            created_at: now(),
          });
          s.posts.push(reply);
          if (t) t.last_post_at = reply.created_at;
          agent.last_seen_at = now();
          setActivity(s, agent.id, np.thread_id, "done");
          setReceipt(s, np.id, agent.id, "handled");
        },
      },
    );
  });
}

/** Resolve uploaded attachment ids for a new post (unknown ids are dropped). */
function claimFiles(s: Store, ids: unknown, postId: string): Attachment[] {
  if (!Array.isArray(ids)) return [];
  const out: Attachment[] = [];
  for (const id of ids.slice(0, 6)) {
    const f = s.files.find((x) => x.id === id && x.post_id === null);
    if (!f) continue;
    f.post_id = postId;
    out.push({ id: f.id, name: f.name, mime: f.mime, size: f.size, url: f.url });
  }
  return out;
}

function liveView(s: Store, tid: string, postIds?: readonly string[]) {
  const t = now();
  const list = s.posts.filter((x) => x.thread_id === tid).sort((a, b) => a.created_at - b.created_at);
  const receipts: Record<string, Receipt[]> = {};
  const acts = s.activity.filter((a) => a.thread_id === tid && t - a.updated_at < 30 * MIN);
  const busy = new Set(acts.filter((a) => a.state === "running" || a.state === "typing").map((a) => a.member_id));
  const requested = postIds ? new Set(postIds) : null;
  for (const x of requested ? list.filter((post) => requested.has(post.id)) : list.slice(-30)) {
    const rs = s.receipts[x.id];
    if (!rs?.length) continue;
    receipts[x.id] = rs.map((r) => (r.state === "received" && busy.has(r.member_id) ? { ...r, state: "working" as const } : { ...r }));
  }
  return {
    now: t,
    receipts,
    activity: acts.map(({ thread_id: _t, ...a }) => ({ ...a, stale: a.state !== "done" && a.state !== "failed" && t - a.updated_at > 10 * MIN })),
    next_post_id: list.at(-1)?.id ?? null,
  };
}

function receiptsSummary(s: Store, postId: string) {
  const rs = s.receipts[postId];
  if (!rs?.length) return undefined;
  const c = { sent: 0, received: 0, working: 0, handled: 0 };
  for (const r of rs) if (r.state !== "failed") c[r.state]++;
  return c;
}

// ---------------------------------------------------------------- team: Side Project

function buildSide(): Store {
  const rand = rng(7);
  const team: Team = { id: "o_01jsideproject000000000000", name: "Side Project", owner_id: "m_zhou", created_at: T0 - 30 * DAY };
  const zhou = human("m_zhou", "zhou", "周宁", "zhou@example.com", "owner", { last_seen_at: T0 - 5 * HOUR, created_at: T0 - 30 * DAY });
  const s = emptyStore(team, zhou);
  const lin = human("m_lin_side", IDENTITY.name === "xia" ? "lin" : IDENTITY.name, "林舟", "lin@example.com", "admin", { created_at: T0 - 26 * DAY, last_seen_at: T0 - DAY });
  s.joinedOrder = NO_TEAM ? Infinity : T0 - 26 * DAY;
  const air = member({ id: "m_air", name: "claude-air", display_name: "Claude · MacBook Air", cli: "claude", machine: "mba-m3", owner: "zhou", last_seen_at: T0 - 9 * MIN, wake_interval_s: 900, created_at: T0 - 28 * DAY });
  const box = member({ id: "m_box", name: "codex-box", display_name: "Codex · 家里的 NAS", cli: "codex", machine: "nas", owner: "zhou", online: false, last_seen_at: T0 - 9 * HOUR, created_at: T0 - 20 * DAY });
  s.members.push(lin, air, box);
  s.quota = {
    m_air: [quotaReading("anthropic", "pro", "5h", 34, 3 * HOUR), quotaReading("anthropic", "pro", "7d", 22, 5 * DAY)],
    m_box: [quotaReading("openai", "plus", "5h", 12, 4 * HOUR, { read_at: T0 - 9 * HOUR })],
  };
  s.workspaces = [
    workspace({
      id: "w_blog",
      name: "博客重构",
      goal: "把个人博客从 Hexo 迁到 Astro，保留旧链接",
      repo: "github.com/example/blog",
      branch: "astro",
      brief: "旧文章 128 篇，链接格式 `/YYYY/MM/slug/` 必须保持不变。",
      updated_by: "m_zhou",
      created_at: T0 - 28 * DAY,
    }),
  ];
  s.threads = [
    thread({
      id: "t_astro",
      workspace_id: "w_blog",
      title: "迁移文章到 Astro content collections",
      assignee_id: "m_air",
      labels: ["迁移"],
      state: "已迁 96 / 128 篇，剩下的是带自定义短代码的文章。",
      created_by: "m_zhou",
      last_post_at: T0 - 9 * MIN,
      created_at: T0 - 4 * DAY,
    }),
    thread({ id: "t_rss", workspace_id: "w_blog", title: "RSS 与 sitemap", status: "done", assignee_id: "m_box", created_by: "m_zhou", last_post_at: T0 - 6 * DAY }),
  ];
  s.posts = [
    post({ id: "p_s1", thread_id: "t_astro", author_id: "m_zhou", body: "@claude-air 把 `source/_posts` 迁到 `src/content/blog`，frontmatter 字段对齐，旧链接用 redirects 兜底。", mentions: ["m_air"], created_at: T0 - 4 * DAY }),
    post({
      id: "p_s2",
      thread_id: "t_astro",
      author_id: "m_air",
      kind: "progress",
      body: "## 要做什么\n迁移文章并保留旧链接。\n\n## 改了什么\n- `scripts/migrate.ts`：转换 frontmatter\n- 96 篇已迁移，`astro check` 通过\n\n## 下一步\n处理 32 篇带 `{% note %}` 短代码的文章。",
      usage: usage(AGENT_MODEL.claude!, 18_000, 420_000, 26_000, 7_400, 0.61),
      reactions: [{ emoji: "👍", member_ids: ["m_zhou"] }],
      created_at: T0 - 9 * MIN,
    }),
    post({ id: "p_s3", thread_id: "t_rss", author_id: "m_box", body: "RSS 和 sitemap 都生成好了，链接和旧站一致。", created_at: T0 - 6 * DAY }),
  ];
  s.runs = makeRuns(rand, [air, box], ["t_astro", "t_rss"], 24, 7 * HOUR);
  s.heatmap = makeHeatmap(rand, 30, 10);
  s.settings = defaultSettings(zhou.email!);
  s.joinCodes = [{ id: "j_home", label: "家里的机器", prefix: "abj_2wzr", created_by: "m_zhou", created_at: T0 - 28 * DAY, expires_at: null, revoked_at: null, uses: 2, last_used_at: T0 - 20 * DAY }];
  s.invites = [
    { id: "i_side_lin", email: "lin@example.com", role: "admin", created_by: "m_zhou", created_at: T0 - 27 * DAY, expires_at: T0 - 20 * DAY, accepted_by: "m_lin_side", accepted_at: T0 - 26 * DAY, revoked_at: null },
    { id: "i_side_open", email: null, role: "admin", created_by: "m_zhou", created_at: T0 - DAY, expires_at: T0 + 6 * DAY, accepted_by: null, accepted_at: null, revoked_at: null },
  ];
  inviteTokens.set("abi_sideprojectinvite00000000", { team: team.id, invite: "i_side_open" });
  s.seq = 40;
  return s;
}

// ---------------------------------------------------------------- team: Mint Studio (invite demo only)

function buildMint(): Store {
  const team: Team = { id: "o_01jmintstudio0000000000000", name: "Mint Studio", owner_id: "m_su", created_at: T0 - 15 * DAY };
  const su = human("m_su", "su", "苏晴", "su@example.com", "owner", { created_at: T0 - 15 * DAY });
  const s = emptyStore(team, su);
  s.joinedOrder = Infinity;
  s.members.push(member({ id: "m_studio", name: "claude-studio", display_name: "Claude · Studio", owner: "su", machine: "studio-01" }));
  s.workspaces = [workspace({ id: "w_brand", name: "品牌官网", goal: "新官网改版：落地页、案例与博客", created_at: T0 - 14 * DAY })];
  s.settings = defaultSettings(su.email!);
  s.invites = [
    { id: "i_mint", email: IDENTITY.email, role: "admin", created_by: "m_su", created_at: T0 - HOUR, expires_at: T0 + 7 * DAY - HOUR, accepted_by: null, accepted_at: null, revoked_at: null },
    { id: "i_mint_exp", email: null, role: "admin", created_by: "m_su", created_at: T0 - 10 * DAY, expires_at: T0 - 3 * DAY, accepted_by: null, accepted_at: null, revoked_at: null },
  ];
  inviteTokens.set("abi_mintstudiodemoinvite0000000", { team: team.id, invite: "i_mint" });
  inviteTokens.set("abi_mintstudioexpired000000000", { team: team.id, invite: "i_mint_exp" });
  return s;
}

const stores: Store[] = [buildShiroha(), buildSide(), buildMint()];
stores.forEach(finalizeV06);

// ---------------------------------------------------------------- identity ↔ team

function myMember(s: Store): Member | undefined {
  return s.members.find((m) => m.kind === "human" && m.email === IDENTITY.email && m.status !== "revoked");
}

function myTeams(): Store[] {
  return stores.filter((s) => myMember(s)).sort((a, b) => a.joinedOrder - b.joinedOrder);
}

const isAdmin = (m: Member) => m.role === "owner" || m.role === "admin";

// ---------------------------------------------------------------- derived views

function counts(s: Store, wid: string) {
  const ts = s.threads.filter((t) => t.workspace_id === wid);
  return {
    open: ts.filter((t) => t.status === "open").length,
    done: ts.filter((t) => t.status === "done").length,
    closed: ts.filter((t) => t.status === "closed").length,
  };
}
const ws = (s: Store, w: Workspace): Workspace => ({ ...w, thread_counts: counts(s, w.id) });
const tokensOf = (r: Run) => r.input + r.cache_read + r.cache_write + r.output + r.reasoning;

function withStats(s: Store, m: Member): MemberWithStats {
  const mine = s.runs.filter((r) => r.member_id === m.id).sort((a, b) => b.started_at - a.started_at);
  const today = mine.filter((r) => r.started_at >= startOfToday());
  return {
    ...m,
    quota: s.quota[m.id] ?? [],
    last_run: mine[0] ?? null,
    today: {
      tokens: today.reduce((n, r) => n + tokensOf(r), 0),
      cost: today.reduce((n, r) => n + (r.cost_usd_est ?? 0), 0),
    },
  };
}

function emptyItem(key: string, label: string): UsageSeriesItem {
  return { key, label, input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, cost: 0, runs: 0, failed: 0 };
}

function usageView(s: Store, group: string, days: number) {
  const since = T0 - days * DAY;
  const rs = s.runs.filter((r) => r.started_at >= since);
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
          ? (s.members.find((m) => m.id === key)?.display_name ?? key)
          : (s.threads.find((t) => t.id === key)?.title ?? "（无讨论串）");
    const it = map.get(key) ?? emptyItem(key, label);
    it.input += r.input;
    it.cache_read += r.cache_read;
    it.cache_write += r.cache_write;
    it.output += r.output;
    it.reasoning += r.reasoning;
    it.cost += r.cost_usd_est ?? 0;
    it.runs += 1;
    if (r.exit_code !== 0) it.failed += 1;
    map.set(key, it);
  }
  const series = [...map.values()];
  const totals = series.reduce(
    (t, x) => ({
      input: t.input + x.input,
      cache_read: t.cache_read + x.cache_read,
      cache_write: t.cache_write + x.cache_write,
      output: t.output + x.output,
      reasoning: t.reasoning + x.reasoning,
      cost: t.cost + x.cost,
      runs: t.runs + x.runs,
      failed: t.failed + x.failed,
    }),
    { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, cost: 0, runs: 0, failed: 0 },
  );
  const agents = s.members.filter((m) => m.kind === "agent" && m.status === "active");
  return { series, totals, baseline: agents.map((m, i) => ({ member_id: m.id, tokens: 11_000 + ((i * 7_300) % 15_000) })) };
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

function threadMembers(s: Store, tid: string): Member[] {
  const ids = new Set(s.posts.filter((p) => p.thread_id === tid).map((p) => p.author_id));
  const t = s.threads.find((x) => x.id === tid);
  if (t?.assignee_id) ids.add(t.assignee_id);
  return s.members.filter((m) => ids.has(m.id));
}

function extractMentions(s: Store, body: string): string[] {
  const names = [...body.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1]!.toLowerCase());
  return s.members.filter((m) => names.includes(m.name)).map((m) => m.id);
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
const forbidden = (msg = "需要管理员权限") => err(403, "forbidden", msg);

type Body = Record<string, unknown>;

function meView(s: Store | undefined) {
  const me = s ? myMember(s) : undefined;
  const owned = stores.filter((x) => x.members.some((m) => m.id === x.team.owner_id && m.email === IDENTITY.email)).length;
  return {
    identity: { email: IDENTITY.email, platform_admin: IDENTITY.platform_admin },
    team: s ? s.team : null,
    member: me ?? null,
    role: me?.role ?? null,
    teams: myTeams().map((x) => ({ id: x.team.id, name: x.team.name, role: myMember(x)!.role })),
    can_create_team: (SIGNUP_OPEN || IDENTITY.platform_admin) && owned < MAX_OWNED,
  };
}

function handle(method: string, path: string, body: Body, headers: Record<string, string>): RawResponse {
  const url = new URL(path, "http://mock");
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const q = url.searchParams;

  // ---- resolve the current team (§6)
  const wanted = headers["X-Agentbus-Team"];
  let S: Store | undefined;
  if (wanted) {
    S = stores.find((s) => s.team.id === wanted);
    if (!S || !myMember(S)) return err(403, "not_member", "你不是这个团队的成员");
  } else {
    S = myTeams()[0];
  }

  // ---- endpoints that work without a team
  if (p[0] === "me" && method === "GET") return ok(meView(S));
  if (p[0] === "teams" && method === "POST") {
    const view = meView(S);
    if (!view.can_create_team) return forbidden("只有平台管理员可以创建团队，请让团队管理员给你发邀请链接");
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 40) return err(400, "bad_request", "团队名称需要 1 到 40 个字符");
    const team: Team = { id: `o_${secret26()}`, name, owner_id: nid("m"), created_at: now() };
    const owner = human(team.owner_id, IDENTITY.name, IDENTITY.display, IDENTITY.email, "owner", { created_at: now(), last_seen_at: now() });
    const s = emptyStore(team, owner);
    s.joinedOrder = now();
    stores.push(s);
    return ok({ team });
  }
  if (p[0] === "invites" && p[1] === "preview" && method === "GET") {
    const ref = inviteTokens.get(q.get("token") ?? "");
    const s = ref && stores.find((x) => x.team.id === ref.team);
    const inv = s?.invites.find((i) => i.id === ref!.invite);
    if (!s || !inv) return notFound();
    const inviter = s.members.find((m) => m.id === inv.created_by);
    return ok({
      team: { id: s.team.id, name: s.team.name },
      inviter: { name: inviter?.name ?? "?", display_name: inviter?.display_name ?? "未知成员" },
      expires_at: inv.expires_at,
      valid: !inv.accepted_at && !inv.revoked_at && inv.expires_at > now(),
      already_member: !!myMember(s),
    });
  }
  if (p[0] === "invites" && p[1] === "accept" && method === "POST") {
    const ref = inviteTokens.get(String(body.token ?? ""));
    const s = ref && stores.find((x) => x.team.id === ref.team);
    const inv = s?.invites.find((i) => i.id === ref!.invite);
    if (!s || !inv) return notFound();
    if (myMember(s)) return err(409, "already_member", "你已经是这个团队的成员");
    if (inv.accepted_at || inv.revoked_at) return err(410, "invite_used", "邀请链接已被使用或作废");
    if (inv.expires_at <= now()) return err(410, "invite_expired", "邀请链接已过期");
    const m = human(nid("m"), IDENTITY.name, IDENTITY.display, IDENTITY.email, "admin", { created_at: now(), last_seen_at: now() });
    s.members.push(m);
    s.joinedOrder = Math.min(s.joinedOrder, now());
    Object.assign(inv, { accepted_by: m.id, accepted_at: now() });
    s.seq++;
    return ok({ team: s.team });
  }

  if (!S) return err(403, "no_team", "你还没有加入任何团队");
  applyTimeline(S);
  const me = myMember(S)!;
  const admin = isAdmin(me);
  const owner = me.role === "owner";
  const extra = extraHandle({ teamId: S.team.id, admin, method, p, q, body });
  if (extra) return extra;
  if (method !== "GET") S.seq++;
  return teamHandle(S, me, admin, owner, method, p, q, body);
}

function teamHandle(S: Store, me: Member, admin: boolean, owner: boolean, method: string, p: string[], q: URLSearchParams, body: Body): RawResponse {
  const { members, threads, posts, workspaces, confirmations, runs, quota, quotaRules, budgets, scopes } = S;

  if (p[0] === "me" && method === "PATCH") {
    Object.assign(me, body);
    return ok({ member: me });
  }

  // ---- team
  if (p[0] === "team") {
    if (!p[1] && method === "PATCH") {
      if (!admin) return forbidden();
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 40) return err(400, "bad_request", "团队名称需要 1 到 40 个字符");
      S.team.name = name;
      return ok({ team: S.team });
    }
    if (!p[1] && method === "DELETE") {
      if (!owner) return forbidden("只有所有者可以删除团队");
      if (String(body.confirm ?? "") !== S.team.name) return err(400, "bad_request", "团队名称不匹配");
      stores.splice(stores.indexOf(S), 1);
      return ok({});
    }
    if (p[1] === "transfer" && method === "POST") {
      if (!owner) return forbidden("只有所有者可以移交团队");
      const t = members.find((m) => m.id === body.member_id && m.kind === "human" && m.status === "active");
      if (!t || t.id === me.id) return err(400, "bad_request", "请选择本团队的另一位管理员");
      t.role = "owner";
      me.role = "admin";
      S.team.owner_id = t.id;
      return ok({});
    }
    if (p[1] === "leave" && method === "POST") {
      if (owner) return err(409, "owner_cannot_leave", "所有者不能退出团队，请先移交");
      me.status = "revoked";
      return ok({});
    }
    return notFound();
  }

  // ---- invites
  if (p[0] === "invites") {
    if (!admin) return forbidden();
    if (!p[1] && method === "GET") return ok({ invites: [...S.invites].sort((a, b) => b.created_at - a.created_at) });
    if (!p[1] && method === "POST") {
      const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, "bad_request", "邮箱格式不正确");
      const inv: Invite = { id: nid("i"), email, role: "admin", created_by: me.id, created_at: now(), expires_at: now() + 7 * DAY, accepted_by: null, accepted_at: null, revoked_at: null };
      const token = `abi_${secret26()}`;
      S.invites.push(inv);
      inviteTokens.set(token, { team: S.team.id, invite: inv.id });
      return ok({ invite: inv, url: `${window.location.origin}/invite/${token}` });
    }
    if (p[1] && method === "DELETE") {
      const inv = S.invites.find((i) => i.id === p[1]);
      if (!inv) return notFound();
      inv.revoked_at = now();
      return ok({});
    }
    return notFound();
  }

  // ---- join codes
  if (p[0] === "join-codes") {
    if (!admin) return forbidden();
    if (!p[1] && method === "GET") return ok({ codes: [...S.joinCodes].sort((a, b) => b.created_at - a.created_at) });
    if (!p[1] && method === "POST") {
      const secret = `abj_${secret26()}`;
      const days = Number(body.expires_in_days);
      const code: JoinCode = {
        id: nid("j"),
        label: String(body.label ?? "").trim(),
        prefix: secret.slice(0, 8),
        created_by: me.id,
        created_at: now(),
        expires_at: Number.isFinite(days) && days > 0 ? now() + days * DAY : null,
        revoked_at: null,
        uses: 0,
        last_used_at: null,
      };
      S.joinCodes.push(code);
      // Demo of the one-click flow: a machine "runs the command" a few seconds later.
      if (["zh", "en"].some((language) => code.label.startsWith(t("一键接入", [], language as "zh" | "en"))) && !S.members.some((m) => m.name === "mac-mini-claude")) {
        const store = S;
        setTimeout(() => {
          const t = now();
          store.members.push(
            member({ id: nid("m"), name: "mac-mini-claude", display_name: "mac-mini-claude", cli: "claude", status: "pending", online: false, last_seen_at: null, created_at: t, machine: "mac-mini", owner: me.name }),
          );
          Object.assign(code, { uses: code.uses + 1, last_used_at: t });
          store.seq++;
        }, 4000);
      }
      return ok({ code, secret });
    }
    if (p[1] && method === "DELETE") {
      const c = S.joinCodes.find((x) => x.id === p[1]);
      if (!c) return notFound();
      c.revoked_at = now();
      return ok({});
    }
    return notFound();
  }

  if (p[0] === "changes") {
    const since = Number(q.get("since") ?? 0);
    return since === S.seq ? { status: 304, data: null } : ok({ seq: S.seq });
  }

  if (p[0] === "dashboard") {
    const today = startOfToday();
    const agents = members.filter((m) => m.kind === "agent" && m.status === "active");
    const todayRuns = runs.filter((r) => r.started_at >= today);
    return ok({
      active_threads: threads.filter((t) => t.status === "open").sort((a, b) => b.last_post_at - a.last_post_at),
      pending_joins: admin ? members.filter((m) => m.status === "pending") : [],
      pending_confirmations: confirmations.filter((c) => c.status === "pending"),
      heatmap: S.heatmap,
      stats: {
        agents_online: agents.filter((m) => m.online).length,
        agents_total: agents.length,
        posts_today: posts.filter((x) => x.created_at >= today).length,
        tokens_today: todayRuns.reduce((n, r) => n + tokensOf(r), 0),
        cost_today: todayRuns.reduce((n, r) => n + (r.cost_usd_est ?? 0), 0),
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
        return { post: x, receipts_summary: receiptsSummary(S, x.id), thread: { id: t.id, title: t.title }, workspace: { id: w.id, name: w.name } };
      }),
      has_more,
    });
  }

  if (p[0] === "workspaces") {
    if (!p[1]) {
      if (method === "POST") {
        const w = workspace({
          id: nid("w"),
          name: String(body.name ?? ""),
          goal: String(body.goal ?? ""),
          repo: (body.repo as string) || null,
          branch: (body.branch as string) || null,
          brief: String(body.brief ?? ""),
          updated_by: me.id,
          updated_at: now(),
          created_at: now(),
        });
        workspaces.push(w);
        return ok({ workspace: w });
      }
      return ok({ workspaces: workspaces.map((w) => ws(S, w)) });
    }
    const w = workspaces.find((x) => x.id === p[1]);
    if (!w) return notFound();
    if (method === "PATCH") {
      Object.assign(w, body, { updated_by: me.id, updated_at: now() });
      return ok({ workspace: ws(S, w) });
    }
    return ok({ workspace: ws(S, w), threads: threads.filter((t) => t.workspace_id === w.id).sort((a, b) => b.last_post_at - a.last_post_at) });
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
        const first = post({ id: nid("p"), thread_id: t.id, author_id: me.id, body: String(body.body ?? ""), mentions: extractMentions(S, String(body.body ?? "")), created_at: now() });
        if (t.assignee_id && !first.mentions.includes(t.assignee_id)) first.mentions.push(t.assignee_id);
        first.attachments = claimFiles(S, body.attachments, first.id);
        posts.push(first);
        simulateDelivery(S, first, me);
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
    if (p[2] === "live" && method === "GET") {
      let ids: string[] | undefined;
      if (q.has("post_ids")) {
        ids = q.get("post_ids")!.split(",");
        if (q.getAll("post_ids").length !== 1 || ids.length > 100 || ids.some((id) => !/^[A-Za-z0-9_-]{1,40}$/.test(id))) {
          return err(400, "bad_request", "post_ids must contain 1–100 valid post IDs");
        }
      }
      return ok(liveView(S, t.id, ids));
    }
    const w = workspaces.find((x) => x.id === t.workspace_id)!;
    // Contract §3: newest 100 posts by default; `?before=<post_id>` returns the 100 older ones.
    const all = posts.filter((x) => x.thread_id === t.id).sort((a, b) => a.created_at - b.created_at);
    const before = q.get("before");
    let end = all.length;
    if (before) {
      const i = all.findIndex((x) => x.id === before);
      end = i < 0 ? 0 : i;
    }
    const startAt = Math.max(0, end - 100);
    return ok({ thread: t, workspace: ws(S, w), posts: all.slice(startAt, end), members: threadMembers(S, t.id), has_more: startAt > 0 });
  }

  if (p[0] === "posts") {
    if (!p[1] && method === "POST") {
      const t = threads.find((x) => x.id === body.thread_id);
      if (!t) return notFound();
      if (t.status === "closed") return err(409, "closed", "讨论串已关闭");
      const r = redact(String(body.body ?? ""));
      const np = post({ id: nid("p"), thread_id: t.id, author_id: me.id, body: r.body, reply_to: (body.reply_to as string) || null, mentions: extractMentions(S, r.body), redacted: r.kinds.length > 0, created_at: now() });
      np.attachments = claimFiles(S, body.attachments, np.id);
      // Replying to an agent's post (without @) still delivers to that agent.
      const parent = np.reply_to ? posts.find((x) => x.id === np.reply_to) : undefined;
      if (parent && members.find((m) => m.id === parent.author_id)?.kind === "agent" && !np.mentions.includes(parent.author_id)) np.mentions.push(parent.author_id);
      posts.push(np);
      t.last_post_at = np.created_at;
      simulateDelivery(S, np, me);
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

  // ---- uploads / files (contract §4). The mock transport sends {name, mime, size} instead of raw bytes.
  if (p[0] === "uploads" && method === "POST") {
    const name = String(body.name ?? "file").slice(0, 200) || "file";
    const mime = String(body.mime ?? "") || "application/octet-stream";
    const size = Number(body.size ?? 0);
    if (!(size > 0)) return err(400, "bad_request", "空文件无法上传");
    if (size > 10 * 1024 * 1024) return err(413, "too_large", "文件超过 10 MB");
    if (/svg/i.test(mime)) return err(415, "unsupported_type", "不支持上传 SVG");
    const id = nid("f");
    const url = /^image\/(png|jpeg|gif|webp)$/i.test(mime) ? IMG_SHOT : textDataUrl(`（演示数据）${name} 的内容在 mock 模式下不保存。`);
    const a = attachment(id, name, mime, size, url);
    S.files.push({ ...a, post_id: null });
    return ok({ attachment: a });
  }
  if (p[0] === "files" && p[1] && method === "GET") {
    const f = S.files.find((x) => x.id === p[1]);
    if (!f) return notFound();
    const { post_id: _p, ...a } = f;
    void _p;
    return ok({ attachment: a });
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
    posts.push(post({ id: nid("p"), thread_id: c.thread_id, author_id: "m_system", kind: "system", body: `${me.display_name} ${c.status === "approved" ? "同意" : "拒绝"}了确认请求`, created_at: now() }));
    return ok({ confirmation: c });
  }

  if (p[0] === "members") {
    if (!p[1]) return ok({ members: members.map((m) => withStats(S, m)) });
    const m = members.find((x) => x.id === p[1]);
    if (!m) return notFound();
    const action = p[2];
    if (!action && method === "GET") {
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
          tokens: week.reduce((n, r) => n + tokensOf(r), 0),
          cost: week.reduce((n, r) => n + (r.cost_usd_est ?? 0), 0),
        },
        scopes: scopes[m.id] ?? [],
      });
    }
    if (!admin) return forbidden();
    if (!action) {
      if (method === "PATCH") {
        if (body.role !== undefined) {
          const allowed = m.kind === "agent" ? ["agent", "manager"] : [m.role === "owner" ? "owner" : "admin"];
          if (!allowed.includes(String(body.role))) return err(400, "bad_request", "不能设置这个角色");
        }
        Object.assign(m, body);
        return ok({ member: m });
      }
      if (method === "DELETE") {
        if (m.status !== "revoked") return err(409, "not_revoked", "只能删除已吊销的成员");
        members.splice(members.indexOf(m), 1);
        return ok({});
      }
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
        if (m.kind === "human" && !owner) return forbidden("只有所有者可以移除管理员");
        if (m.role === "owner") return forbidden("不能吊销所有者");
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
    if (!admin) return forbidden();
    scopes[p[1]] = (body.workspace_ids as string[]) ?? [];
    return ok({ workspace_ids: scopes[p[1]] });
  }

  if (p[0] === "usage") return ok(usageView(S, q.get("group") ?? "day", Number(q.get("days") ?? 30)));

  if (p[0] === "runs") {
    const list = runs
      .filter((r) => (!q.get("member") || r.member_id === q.get("member")) && (q.get("failed") !== "1" || r.exit_code !== 0))
      .sort((a, b) => b.started_at - a.started_at);
    const { items, has_more } = page(list, q.get("before"), 20);
    return ok({ runs: items, has_more });
  }

  if (p[0] === "settings") {
    if (p[1] === "email" && method === "POST") {
      if (!admin) return forbidden();
      const e = String(body.email ?? "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return err(400, "bad_request", "邮箱格式不正确");
      return ok({ sent: true });
    }
    if (method === "PATCH") {
      if (!admin) return forbidden();
      const { notify_email_masked: _m, email_health: _h, min_client_version: ver, ...rest } = body;
      void _m;
      void _h;
      if (ver !== undefined && ver !== minClientVersion) {
        if (!IDENTITY.platform_admin) return forbidden("只有平台管理员可以修改最低客户端版本");
        minClientVersion = String(ver);
      }
      S.settings = { ...S.settings, ...(rest as Partial<SettingsResponse>) };
      if (body.notify_kinds) S.settings.notify_kinds = { ...S.settings.notify_kinds, ...(body.notify_kinds as object), email_change: true, invite: true };
      if (typeof body.global_pause === "boolean") {
        for (const m of members) {
          if (m.kind !== "agent" || m.status !== "active") continue;
          if (body.global_pause) {
            if (!m.paused) Object.assign(m, { paused: true, pause_reason: "全局暂停", paused_until: null });
          } else if (m.pause_reason === "全局暂停") Object.assign(m, { paused: false, pause_reason: null });
        }
      }
    }
    return ok({ ...S.settings, min_client_version: minClientVersion });
  }

  if (p[0] === "notify" && p[1] === "test") {
    if (!S.settings.notify_email_masked) return err(400, "no_email", "还没有设置通知邮箱");
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
    if (!admin) return forbidden();
    const { items, has_more } = page(S.audit, q.get("before"), 20);
    return ok({ entries: items, has_more });
  }

  return notFound();
}

export function installMock(): void {
  setTransport(async (method, path, body, headers) => {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    const res = handle(method, path, (body ?? {}) as Body, headers);
    // Hand out copies so components never mutate mock state by accident.
    return { status: res.status, data: res.data === null ? null : structuredClone(res.data) };
  });
  console.info("[agentbus] mock API enabled (VITE_MOCK=1)", NO_TEAM ? "(no-team identity)" : "");
}
