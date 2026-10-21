// Full flow against a deployed hub (staging). Web calls pass Access with the e2e service token;
// the hub lets that identity create teams (E2E_SERVICE_TOKEN_ID, hub-api.md §6) so the suite owns
// a team named "e2e" and never touches anyone else's data.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CLIENT_VERSION, SERVER_VERSION, TestAgent } from "./agent";

const BASE = process.env.HUB_URL ?? "https://staging-hub.shiroha.tech";
const TEAM_NAME = "e2e";
const run = Date.now().toString(36);

/** The e2e team id, resolved once per run by `ensureTeam`. */
let teamId = "";

async function web(req: APIRequestContext, method: string, path: string, data?: unknown, team: string | null = teamId) {
  // writes always send JSON: the hub answers 415 to non-JSON writes (CSRF guard)
  const write = method !== "GET" && method !== "HEAD";
  const headers: Record<string, string> = write ? { "content-type": "application/json" } : {};
  if (team) headers["X-Agentbus-Team"] = team;
  const r = await req.fetch(`/api/v1/web${path}`, { method, data: write ? (data ?? {}) : data, headers });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status(), json };
}

/** Find the team named "e2e" among our memberships, or create it (idempotent; max 5 owned). */
async function ensureTeam(req: APIRequestContext): Promise<string> {
  if (teamId) return teamId;
  const me = await web(req, "GET", "/me", undefined, null);
  expect(me.status, JSON.stringify(me.json)).toBe(200);
  const mine = (me.json.teams as { id: string; name: string; role: string }[]).filter((t) => t.name === TEAM_NAME);
  const found = mine.find((t) => t.role === "owner") ?? mine[0];
  if (found) return (teamId = found.id);
  expect(me.json.can_create_team, "service token may not create teams: is E2E_SERVICE_TOKEN_ID set on the hub?").toBe(true);
  const created = await web(req, "POST", "/teams", { name: TEAM_NAME }, null);
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  return (teamId = created.json.team.id);
}

test.describe.configure({ mode: "serial" });

test("healthz reports the server version; unauthenticated requests are rejected", async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: {} });
  const hz = await anon.get("/healthz");
  expect(hz.status()).toBe(200);
  expect((await hz.json()).version).toBe(SERVER_VERSION);
  const page = await anon.get("/", { maxRedirects: 0 });
  // Access either redirects to its login page or the worker answers 401.
  expect([302, 401, 403]).toContain(page.status());
  for (const path of ["/api/v1/web/me", "/api/v1/web/teams"]) {
    const r = await anon.get(path, { maxRedirects: 0 });
    expect([302, 401, 403], path).toContain(r.status());
  }
  const unsigned = await anon.get("/api/v1/agent/state", { headers: { "x-agentbus-version": CLIENT_VERSION } });
  expect(unsigned.status()).toBe(401);
  await anon.dispose();
});

test("PWA: manifest, service worker and icons are served (behind Access)", async ({ request }) => {
  const mf = await request.get("/manifest.webmanifest");
  expect(mf.status()).toBe(200);
  expect(mf.headers()["content-type"]).toContain("application/manifest+json");
  const m = await mf.json();
  expect(m.display).toBe("standalone");
  for (const icon of m.icons as { src: string }[]) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toContain("javascript");
  expect(sw.headers()["cache-control"]).toContain("no-cache");
  const html = await (await request.get("/")).text();
  expect(html).toContain('rel="manifest"');
});

test("two agents: join code → approve → mention → claim → reply → ack → pause", async ({ request }) => {
  test.setTimeout(240_000); // ~40 round trips from a GitHub runner to staging D1, plus cleanup
  const tid0 = await ensureTeam(request);
  const me = await web(request, "GET", "/me");
  expect(me.status, JSON.stringify(me.json)).toBe(200);
  expect(me.json.team?.id).toBe(tid0);
  expect(["owner", "admin"]).toContain(me.json.role);
  // A team id we're not in is refused, not silently replaced.
  expect((await web(request, "GET", "/workspaces", undefined, "o_00000000000000000000000000")).json.error?.code).toBe("not_member");

  // agents self-enroll with a team join code, then wait for approval
  const jc = await web(request, "POST", "/join-codes", { label: `e2e ${run}`, expires_in_days: 1 });
  expect(jc.status, JSON.stringify(jc.json)).toBe(200);
  const secret: string = jc.json.secret;
  expect(secret.startsWith("abj_")).toBe(true);

  const agents: TestAgent[] = [];
  try {
    const bogus = new TestAgent(BASE, `e2e-x-${run}`);
    await expect(bogus.join("abj_definitely-not-valid")).rejects.toThrow(/403.*bad_join_code/);
    const y = new TestAgent(BASE, `e2e-y-${run}`); // signs with its own key, so only the missing code is wrong
    const noCode = await y.call("POST", "/join", { name: y.name, cli: "custom", public_key: y.publicB64 });
    expect(noCode.status).toBe(400);
    expect(noCode.json.error.code).toBe("join_code_required");

    const a = new TestAgent(BASE, `e2e-a-${run}`);
    const b = new TestAgent(BASE, `e2e-b-${run}`);
    const ja = await a.join(secret);
    agents.push(a);
    expect(ja.status).toBe("pending");
    expect(ja.team).toEqual({ id: tid0, name: TEAM_NAME });
    await b.join(secret);
    agents.push(b);
    const pending = await web(request, "GET", "/members");
    expect(JSON.stringify(pending.json)).toContain(a.name);
    expect((await a.call("GET", "/state")).json.member.status).toBe("pending");
    expect((await a.call("POST", "/claim", {})).status).toBe(403);

    for (const ag of [a, b]) expect((await web(request, "POST", `/members/${ag.id}/approve`, {})).status).toBe(200);
    expect((await a.call("GET", "/state")).json.team).toEqual({ id: tid0, name: TEAM_NAME });

    const ws = await web(request, "POST", "/workspaces", { name: `e2e ${run}`, goal: "playwright" });
    expect(ws.status, JSON.stringify(ws.json)).toBe(200);
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

    // leave the board tidy
    await web(request, "PATCH", `/threads/${tid}`, { status: "closed" });
    await web(request, "PATCH", `/workspaces/${wsId}`, { status: "archived" });
  } finally {
    // always revoke this run's agents and join code, even when an assertion above failed
    for (const ag of agents) {
      expect((await web(request, "POST", `/members/${ag.id}/revoke`, {})).status).toBe(200);
      expect((await ag.call("GET", "/state")).status).toBe(401);
      expect((await web(request, "DELETE", `/members/${ag.id}`)).status).toBe(200);
    }
    const del = await web(request, "DELETE", `/join-codes/${jc.json.code.id}`);
    expect(del.status).toBe(200);
    expect(del.json.code.revoked_at).toBeGreaterThan(0);
  }
  await expect(new TestAgent(BASE, `e2e-c-${run}`).join(secret)).rejects.toThrow(/403/);
});

test("web UI renders the dashboard for ?team=<id>", async ({ page, request }) => {
  const id = await ensureTeam(request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?team=${id}`);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByText("需要通过 Cloudflare Access 登录")).toHaveCount(0);
  // the SPA stores the team and strips ?team= from the address bar
  await expect(page).not.toHaveURL(/[?&]team=/);
  await expect(page.getByText(TEAM_NAME, { exact: true }).first()).toBeVisible();
  for (const path of ["/members", "/workspaces", "/usage", "/settings"]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});
