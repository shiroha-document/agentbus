import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { MembersPage } from "../../pages/Members";
import { MemberDetail } from "../../pages/MemberDetail";
import { PostItem } from "../../components/PostItem";
import { qk } from "../../queries";
import { setLanguage } from "../i18n";
import type { MemberWithStats, MemberDetailResponse, Post, Run } from "../../types";

const at = 1_792_990_800_000;
const latestRun = { id: "r-test", member_id: "m-test", thread_id: null, started_at: at - 60_000, ended_at: at - 59_000,
  exit_code: 0, cli: "custom-CLI", model: "latest-run-model", input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0, cost_usd_est: null, error_summary: null } satisfies Run;
const member = { id: "m-test", name: "helper", display_name: "Helper", kind: "agent", role: "agent", avatar_url: null, status: "active",
  cli: "manual", quota: [], last_run: latestRun, today: { tokens: 0, cost: 0 }, created_at: at, online: true,
  email: null, wake_mode: "poll", wake_interval_s: 300, owner: null, machine: null, client_version: null,
  paused: false, pause_reason: null, paused_until: null, last_seen_at: at } satisfies MemberWithStats;
type Report = { model: string; cli: string | null; source: "activity" | "last_run"; at: number } | null;

async function renderMember(detail: boolean, report: Report | undefined, lastRun: Run | null = latestRun) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const m = { ...member, last_run: lastRun, ...(report !== undefined ? { reported_model: report } : {}) };
  client.setQueryData(qk.me, { member: null, role: null, identity: { email: "viewer@example.test", platform_admin: false } });
  client.setQueryData(qk.members, { members: [m] });
  client.setQueryData(qk.member(m.id), { member: m, keys: [], quota: [], quota_rules: [], budget: null,
    runs: lastRun ? [lastRun] : [], usage_7d: null } satisfies MemberDetailResponse);
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => root, path: "/members", component: detail ? () => createElement(MemberDetail, { id: m.id }) : MembersPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/members"] }), isServer: true });
  await router.load();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Tooltip.Provider, null, createElement(RouterProvider, { router }))));
}

describe.each([false, true])("reported model on member detail=%s", (detail) => {
  it.each(["zh", "en"] as const)("shows raw reported model, source and timestamp in %s", async (language) => {
    setLanguage(language);
    const html = await renderMember(detail, { model: "raw-模型-v2", cli: "custom-CLI", source: "activity", at });
    expect(html).toContain(language === "zh" ? "上报模型" : "Reported model");
    expect(html).toContain(language === "zh" ? "活动上报" : "Activity report");
    expect(html).toContain("raw-模型-v2");
    expect(html).toContain("custom-CLI");
    expect(html).toContain(`dateTime="${new Date(at).toISOString()}"`);
    expect(html).toContain(language === "zh" ? "可能来自 CLI 配置或前一轮推导" : "may come from CLI configuration or a previous run");
  });
  it("shows latest run source and time with an older API response", async () => {
    const html = await renderMember(detail, undefined);
    expect(html).toContain("上报模型");
    expect(html).toContain("最近使用");
    expect(html).toContain("latest-run-model");
    expect(html).toContain(`dateTime="${new Date(latestRun.started_at).toISOString()}"`);
  });
  it.each(["zh", "en"] as const)("shows an explicit missing model in %s", async (language) => {
    setLanguage(language);
    const html = await renderMember(detail, null, null);
    expect(html).toContain(language === "zh" ? "尚未上报" : "Not reported yet");
  });
  it("replaces the displayed member model when refreshed data switches models", async () => {
    expect(await renderMember(detail, { model: "first-model", cli: null, source: "activity", at })).toContain("first-model");
    const html = await renderMember(detail, { model: "second-model", cli: null, source: "activity", at: at + 1000 });
    expect(html).toContain("second-model");
    expect(html).not.toContain("first-model");
  });
});

it("keeps historical post and usage models independent of the member's current report", () => {
  const author = { ...member, reported_model: { model: "current-model", cli: "current-cli", source: "activity" as const, at } };
  const post = { id: "p-test", thread_id: "t-test", author_id: author.id, reply_to: null, body: "History", kind: "msg", mentions: [],
    redacted: false, reactions: [], confirmation: null, created_at: at, cli: "old-cli", model: "post-model",
    usage: { input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0, cost_usd_est: null, duration_ms: 0, model: "usage-model" } } satisfies Post;
  const render = (p: Post) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Tooltip.Provider, null,
    createElement(PostItem, { post: p, author, members: new Map([[author.id, author]]), names: new Set([author.name]), onReply: () => undefined }))));
  expect(render(post)).toContain("post-model");
  expect(render({ ...post, model: null })).toContain("usage-model");
  expect(render({ ...post, model: null, usage: null })).not.toContain("current-model");
  expect(render(post)).not.toContain("current-model");
});

beforeEach(() => setLanguage("zh"));
