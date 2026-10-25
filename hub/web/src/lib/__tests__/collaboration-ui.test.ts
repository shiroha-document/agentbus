import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { Avatar } from "../../components/ui/Avatar";
import { PostItem } from "../../components/PostItem";
import { ThreadPage } from "../../pages/Thread";
import { qk } from "../../queries";
import type { Member, Post, ThreadDetailResponse } from "../../types";

const author = {
  id: "m-agent", name: "helper", display_name: "Helper", kind: "agent", avatar_url: null, status: "active",
} as Member;
const statePost: Post = {
  id: "retained-state", thread_id: "t-test", author_id: author.id, reply_to: null, body: "Retained state detail",
  kind: "state", mentions: [], redacted: false, usage: null, reactions: [{ emoji: "👍", member_ids: [author.id] }],
  confirmation: null, created_at: 1_700_000_000_000, edited_at: 1_700_000_060_000, revisions: 2,
};

function renderPost(post = statePost) {
  const client = new QueryClient();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(Tooltip.Provider, null, createElement(PostItem, {
      post, author, members: new Map([[author.id, author]]), names: new Set([author.name]), flash: true,
      onReply: () => undefined,
    })),
  ));
}

async function renderThread(state: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const detail: ThreadDetailResponse = {
    thread: { id: "t-test", title: "Test thread", workspace_id: "w-test", state, status: "open", labels: [],
      assignee_id: null, lease_holder: null, lease_until: null, auto_paused: false, version: 1,
      created_by: author.id, created_at: statePost.created_at, updated_at: statePost.edited_at!, last_post_at: statePost.created_at },
    workspace: { id: "w-test", name: "Workspace", goal: "", repo: null, branch: null, brief: "", status: "active",
      updated_by: author.id, updated_at: statePost.created_at, created_at: statePost.created_at,
      thread_counts: { open: 1, done: 0, closed: 0 } }, members: [author], posts: [statePost], has_more: false,
  };
  client.setQueryData(qk.thread("t-test"), detail);
  client.setQueryData(qk.me, { member: null });
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => root, path: "/threads/$id", component: ThreadPage });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/threads/t-test"] }), isServer: true });
  await router.load();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(Tooltip.Provider, null, createElement(RouterProvider, { router })),
  ));
}

describe("category avatars", () => {
  it("gives known humans a circular avatar and category in the accessible name", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { member: { ...author, kind: "human", display_name: "Alice" } }));
    expect(html).toContain("rounded-full");
    expect(html).toMatch(/aria-label="[^"]*human[^"]*Alice/);
  });
  it("keeps uploaded agent avatars visibly square with a robot marker at 16px", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { member: { ...author, avatar_url: "https://example.test/avatar.png" }, size: 16 }));
    expect(html).toMatch(/aria-label="[^"]*agent[^"]*Helper/);
    expect(html).toContain("lucide-bot");
    expect(html).toContain("border-radius:4px");
    expect(html).toContain("https://example.test/avatar.png");
  });
  it("keeps partial members neutral instead of inferring their category from a name", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { member: { name: "robot", display_name: "Robot", avatar_url: null } }));
    expect(html).toContain('aria-label="Robot"');
    expect(html).not.toContain("lucide-bot");
    expect(html).not.toContain("linear-gradient");
  });
  it("uses the fallback for an invalid HTTPS image URL", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { member: { ...author, avatar_url: "https://" } }));
    expect(html).not.toContain("<img");
    expect(html).toContain("lucide-bot");
  });
});

describe("compact state updates", () => {
  it("retains its anchor and metadata while hiding the body until a native button is toggled", () => {
    const html = renderPost();
    expect(html).toContain('id="post-retained-state"');
    expect(html).toContain("new-post-flash");
    expect(html).toContain("状态已更新");
    expect(html).toContain("Helper");
    expect(html).toContain("已更新 2 次");
    expect(html).toContain(new Date(statePost.edited_at!).toISOString());
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-expanded="false"/);
    expect(html).not.toContain("Retained state detail");
  });
  it("has no normal chat avatar, header, or reaction area and keeps a reply action", () => {
    const html = renderPost();
    expect(html).not.toContain("<header");
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("添加表情回执");
    expect(html).toContain("回复");
  });
  it("preserves reply quotes targeting earlier posts", () => {
    const html = renderPost({ ...statePost, reply_to: "earlier" });
    expect(html).toContain('href="#post-earlier"');
  });
});

describe("current thread state", () => {
  it("renders a sole compact panel between the thread header and stream", async () => {
    const html = await renderThread("Current summary\n\nFull current detail");
    expect(html.match(/aria-label="当前状态"/g)).toHaveLength(1);
    const panel = html.indexOf('aria-label="当前状态"');
    expect(panel).toBeGreaterThan(html.indexOf("</header>"));
    expect(panel).toBeLessThan(html.indexOf('aria-label="帖子"'));
    expect(html).toContain("Current summary");
    expect(html).not.toContain("Full current detail");
    expect(html).toContain('aria-expanded="false"');
  });
  it("provides empty-state guidance and existing edit action", async () => {
    const html = await renderThread("");
    expect(html).toContain("还没有记录");
    expect(html).toContain("编辑");
  });
});
