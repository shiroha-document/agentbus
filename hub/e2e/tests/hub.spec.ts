import { expect, test, type APIRequestContext } from "@playwright/test";
import { CLIENT_VERSION, TestAgent } from "./agent";

const BASE = process.env.HUB_URL ?? "https://staging-hub.shiroha.tech";
const run = Date.now().toString(36);

async function web(req: APIRequestContext, method: string, path: string, data?: unknown) {
  // writes always send JSON: the hub answers 415 to non-JSON writes (CSRF guard)
  const write = method !== "GET" && method !== "HEAD";
  const r = await req.fetch(`/api/v1/web${path}`, {
    method,
    data: write ? (data ?? {}) : data,
    headers: write ? { "content-type": "application/json" } : {},
  });
  const text = await r.text();
  return { status: r.status(), json: text ? JSON.parse(text) : null };
}

test.describe.configure({ mode: "serial" });

test("unauthenticated requests are rejected", async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: {} });
  const page = await anon.get("/", { maxRedirects: 0 });
  // Access either redirects to its login page or the worker answers 401.
  expect([302, 401, 403]).toContain(page.status());
  const api = await anon.get("/api/v1/web/me", { maxRedirects: 0 });
  expect([302, 401, 403]).toContain(api.status());
  const hz = await anon.get("/healthz");
  expect(hz.status()).toBe(200);
  expect((await hz.json()).version).toBe(CLIENT_VERSION);
  const unsigned = await anon.get("/api/v1/agent/state", { headers: { "x-agentbus-version": CLIENT_VERSION } });
  expect(unsigned.status()).toBe(401);
  await anon.dispose();
});

test("two agents: join → approve → mention → claim → reply → ack → pause", async ({ request }) => {
  const me = await web(request, "GET", "/me");
  expect(me.status, JSON.stringify(me.json)).toBe(200);
  expect(["owner", "admin"]).toContain(me.json.role);
  expect(me.json.team?.id).toBeTruthy();

  // agents self-enroll with a team join code, then wait for approval
  const jc = await web(request, "POST", "/join-codes", { label: `e2e ${run}`, expires_in_days: 1 });
  expect(jc.status, JSON.stringify(jc.json)).toBe(200);
  const secret: string = jc.json.secret;
  expect(secret.startsWith("abj_")).toBe(true);

  const bogus = new TestAgent(BASE, `e2e-x-${run}`);
  await expect(bogus.join("abj_definitely-not-valid")).rejects.toThrow(/403/);

  const a = new TestAgent(BASE, `e2e-a-${run}`);
  const b = new TestAgent(BASE, `e2e-b-${run}`);
  const ja = await a.join(secret);
  expect(ja.status).toBe("pending");
  expect(ja.team.id).toBe(me.json.team.id);
  await b.join(secret);
  const pending = await web(request, "GET", "/members");
  expect(JSON.stringify(pending.json)).toContain(a.name);
  expect((await a.call("POST", "/claim", {})).status).toBe(403);

  for (const ag of [a, b]) expect((await web(request, "POST", `/members/${ag.id}/approve`, {})).status).toBe(200);

  const ws = await web(request, "POST", "/workspaces", { name: `e2e ${run}`, goal: "playwright" });
  expect(ws.status).toBe(200);
  const wsId = ws.json.workspace.id;

  const p = await a.post({ workspace_id: wsId, title: `e2e ${run}`, body: `@${b.name} please reply` });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  const tid = p.json.thread.id;

  const st = await b.call("GET", "/state");
  expect(st.json.pending).toBeGreaterThanOrEqual(1);
  const c = await b.call("POST", "/claim", {});
  expect(c.json.paused).toBe(false);
  expect(c.json.threads.map((t: any) => t.thread_id)).toContain(tid);

  // lease expiry would redeliver; here we nack once to exercise the redelivery path
  expect((await b.call("POST", "/nack", { thread_id: tid, reason: "e2e retry" })).json.released).toBe(1);
  const c2 = await b.call("POST", "/claim", {});
  expect(c2.json.threads.map((t: any) => t.thread_id)).toContain(tid);

  const reply = await b.post({ thread_id: tid, body: "done", reply_to: p.json.post.id });
  expect(reply.status, JSON.stringify(reply.json)).toBe(200);
  expect((await b.call("POST", "/ack", { thread_id: tid })).json.acked).toBeGreaterThanOrEqual(1);

  // alice got the reply
  const ca = await a.call("POST", "/claim", {});
  const th = ca.json.threads.find((t: any) => t.thread_id === tid);
  expect(th?.deliveries[0].reason).toBe("reply");
  await a.call("POST", "/ack", { thread_id: tid });

  // the web view shows both posts
  const view = await web(request, "GET", `/threads/${tid}`);
  expect(view.status).toBe(200);
  expect(view.json.posts.length).toBeGreaterThanOrEqual(2);

  // manual pause blocks claims, resume lifts it
  expect((await web(request, "POST", `/members/${b.id}/pause`, { reason: "e2e" })).status).toBe(200);
  expect((await b.call("POST", "/claim", {})).json.paused).toBe(true);
  expect((await web(request, "POST", `/members/${b.id}/resume`, {})).status).toBe(200);
  expect((await b.call("POST", "/claim", {})).json.paused).toBe(false);

  // cleanup: close thread, archive workspace, revoke + delete agents
  await web(request, "PATCH", `/threads/${tid}`, { status: "closed" });
  await web(request, "PATCH", `/workspaces/${wsId}`, { status: "archived" });
  for (const ag of [a, b]) {
    expect((await web(request, "POST", `/members/${ag.id}/revoke`, {})).status).toBe(200);
    expect((await ag.call("GET", "/state")).status).toBe(401);
    expect((await web(request, "DELETE", `/members/${ag.id}`)).status).toBe(200);
  }
  expect((await web(request, "DELETE", `/join-codes/${jc.json.code.id}`)).status).toBe(200);
  await expect(new TestAgent(BASE, `e2e-c-${run}`).join(secret)).rejects.toThrow(/403/);
});

test("web UI renders the dashboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByText("需要通过 Cloudflare Access 登录")).toHaveCount(0);
  for (const path of ["/members", "/workspaces", "/usage", "/settings"]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});
