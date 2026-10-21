// v0.6 mock endpoints owned by workstream Web-2 (version, events, analytics).
// mock.ts calls extraHandle before its own team routes; return null to fall through.
import type { RawResponse } from "./api";
import type { AnalyticsResponse, TelemetryEvent } from "./types";

export interface ExtraCtx {
  teamId: string;
  admin: boolean;
  method: string;
  p: string[];
  q: URLSearchParams;
  body: Record<string, unknown>;
}

const ok = (data: unknown): RawResponse => ({ status: 200, data });
const err = (status: number, code: string, message: string): RawResponse => ({ status, data: { error: { code, message } } });

/** Events the dev mock has received (inspect from the console: `__agentbusEvents`). */
export const receivedEvents: TelemetryEvent[] = [];

/** Deterministic PRNG so the dashboard is stable across reloads. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function mockAnalytics(teamId: string, days: number, now = Date.now()): AnalyticsResponse {
  const r = rng(hash(`${teamId}:${days}`));
  const daily: AnalyticsResponse["daily"] = [];
  const n0 = new Date(now);
  const today = Date.UTC(n0.getUTCFullYear(), n0.getUTCMonth(), n0.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const t = today - i * 86_400_000;
    const dow = new Date(t).getUTCDay();
    const weekday = dow !== 0 && dow !== 6;
    const growth = 0.6 + 0.4 * ((days - i) / days); // gentle upward trend
    const base = (weekday ? 1 : 0.35) * growth;
    daily.push({
      day: new Date(t).toISOString().slice(0, 10),
      web: Math.round((120 + r() * 90) * base),
      cli: Math.round((260 + r() * 160) * base),
      hub: Math.round((80 + r() * 60) * base),
      posts: Math.round((18 + r() * 22) * base),
    });
  }
  const sum = (k: "web" | "cli" | "hub" | "posts") => daily.reduce((a, d) => a + d[k], 0);
  const web = sum("web");
  const cli = sum("cli");
  const hub = sum("hub");
  const posts = sum("posts");
  const runs = Math.round(cli * 0.42);
  const failed = Math.round(runs * (0.02 + r() * 0.03));
  const share = (total: number, parts: [string, number][]) => parts.map(([k, w]) => [k, Math.round(total * w)] as const);

  const topEvents: AnalyticsResponse["top_events"] = [
    ...share(cli, [
      ["cli.tick", 0.62],
      ["cli.command", 0.33],
      ["cli.setup", 0.03],
      ["cli.update", 0.02],
    ]).map(([name, n]) => ({ name, source: "cli", n })),
    ...share(web, [
      ["page.view", 0.55],
      ["post.create", 0.12],
      ["palette.open", 0.09],
      ["palette.select", 0.07],
      ["thread.jump", 0.06],
      ["composer.mention", 0.05],
      ["confirm.decide", 0.02],
      ["composer.attach", 0.02],
      ["theme.change", 0.01],
      ["changelog.open", 0.01],
    ]).map(([name, n]) => ({ name, source: "web", n })),
    ...share(hub, [
      ["post.create", 0.4],
      ["delivery.claim", 0.27],
      ["delivery.done", 0.25],
      ["confirm.decide", 0.06],
      ["member.join", 0.02],
    ]).map(([name, n]) => ({ name, source: "hub", n })),
  ]
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 20);

  const cmds: [string, number, number, number][] = [
    ["tick", 0.48, 0.01, 8_400],
    ["post", 0.18, 0.004, 620],
    ["inbox", 0.12, 0.002, 340],
    ["status", 0.07, 0, 210],
    ["file get", 0.04, 0.03, 1_250],
    ["doctor", 0.03, 0.08, 2_900],
    ["setup", 0.02, 0.12, 41_000],
    ["usage", 0.02, 0, 480],
    ["update", 0.01, 0.05, 6_200],
  ];
  const cmdTotal = Math.round(cli * 0.33);
  const cli_commands = cmds.map(([cmd, w, f, p50]) => {
    const n = Math.max(1, Math.round(cmdTotal * w));
    return { cmd, n, failed: Math.round(n * f * (0.5 + r())), p50_ms: Math.round(p50 * (0.8 + r() * 0.4)) };
  });

  const pv = Math.round(web * 0.55);
  const pages = share(pv, [
    ["/", 0.34],
    ["/threads/$id", 0.29],
    ["/workspaces/$id", 0.12],
    ["/members", 0.07],
    ["/usage", 0.06],
    ["/workspaces", 0.05],
    ["/settings", 0.03],
    ["/members/$id", 0.02],
    ["/analytics", 0.01],
    ["/about", 0.01],
  ]).map(([path, n]) => ({ path, n }));

  return {
    days,
    totals: {
      events: web + cli + hub,
      active_humans: 3 + Math.round(r() * 2),
      active_agents: 5 + Math.round(r() * 3),
      posts,
      runs,
      failed_runs: failed,
    },
    daily,
    top_events: topEvents,
    cli_commands,
    pages,
    clients: [
      { version: "0.6.0", n: 6 },
      { version: "0.5.3", n: 3 },
      { version: "0.5.1", n: 1 },
    ],
    adapters: [
      { cli: "claude", members: 3, runs: Math.round(runs * 0.46) },
      { cli: "codex", members: 2, runs: Math.round(runs * 0.24) },
      { cli: "traecli", members: 1, runs: Math.round(runs * 0.12) },
      { cli: "gemini", members: 1, runs: Math.round(runs * 0.1) },
      { cli: "dsh", members: 1, runs: Math.round(runs * 0.08) },
    ],
    latency: {
      claim_p50_ms: Math.round(14_000 + r() * 12_000),
      claim_p90_ms: Math.round(62_000 + r() * 50_000),
      reply_p50_ms: Math.round(95_000 + r() * 60_000),
      reply_p90_ms: Math.round(420_000 + r() * 300_000),
    },
    posts_by_kind: share(posts, [
      ["msg", 0.52],
      ["progress", 0.27],
      ["state", 0.09],
      ["confirm", 0.07],
      ["system", 0.05],
    ]).map(([kind, n]) => ({ kind, n })),
  };
}

export function extraHandle(ctx: ExtraCtx): RawResponse | null {
  const { method, p, q, body, admin, teamId } = ctx;

  if (p[0] === "version" && method === "GET") {
    return ok({ server_version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.6.0", min_client_version: "0.5.0" });
  }

  if (p[0] === "events" && method === "POST") {
    const events = Array.isArray(body.events) ? (body.events as TelemetryEvent[]) : [];
    if (events.length > 50) return err(400, "too_many_events", "一次最多 50 个事件");
    receivedEvents.push(...events);
    if (receivedEvents.length > 500) receivedEvents.splice(0, receivedEvents.length - 500);
    if (typeof window !== "undefined") (window as unknown as { __agentbusEvents: TelemetryEvent[] }).__agentbusEvents = receivedEvents;
    return ok({ accepted: events.length });
  }

  if (p[0] === "analytics" && method === "GET") {
    if (!admin) return err(403, "forbidden", "只有团队所有者和管理员可以查看数据统计");
    const d = Number(q.get("days") ?? 30);
    const days = Number.isFinite(d) ? Math.min(90, Math.max(1, Math.round(d))) : 30;
    return ok(mockAnalytics(teamId, days));
  }

  return null;
}
