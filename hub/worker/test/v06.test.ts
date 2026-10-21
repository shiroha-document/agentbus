import { beforeAll, describe, expect, it } from "vitest";
import { cleanEvent, percentile } from "../src/analytics";
import { sanitizeFileName } from "../src/files";
import { cleanup, resetEventsPrune } from "../src/watchdog";
import { newId } from "../src/util";
import { api, makeAgent, makeEnv, makeTeam, setupJwks, webRaw, workspace, type TestEnv } from "./helpers";

beforeAll(setupJwks);

const upload = (env: TestEnv, bytes: Uint8Array, name: string, mime: string, extra: Record<string, string> = {}, o = {}) =>
  webRaw(env, "POST", "/uploads", bytes, { "content-type": mime, "x-file-name": encodeURIComponent(name), "x-agentbus-upload": "1", ...extra }, o);

function addHuman(env: TestEnv, role: string, email: string) {
  const id = newId("m");
  env.d1.x(
    "INSERT INTO members (id, team_id, kind, role, name, display_name, email, status, created_at) VALUES (?, ?, 'human', ?, ?, ?, ?, 'active', ?)",
    id,
    env.teamId,
    role,
    email.split("@")[0],
    email.split("@")[0],
    email,
    Date.now(),
  );
  return id;
}

describe("post model + collapse", () => {
  it("progress posts by the same author collapse within 6h; other kinds and authors don't", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    const b = await makeAgent(env, "bob");
    const first = await a.post({ workspace_id: ws, title: "t", body: "@bob start", kind: "msg", model: "claude-opus-4" });
    expect(first.status).toBe(200);
    const tid = first.json.thread.id;
    expect(first.json.post).toMatchObject({ kind: "msg", model: "claude-opus-4", cli: "claude", edited_at: null, revisions: 0, attachments: [] });
    expect(env.d1.q("SELECT * FROM deliveries WHERE member_id = ?", b.id)).toHaveLength(1);

    const p1 = await a.post({ thread_id: tid, body: "step 1 @bob", kind: "progress", usage: { input: 1, output: 2, model: "gpt-5" } });
    expect(p1.json.collapsed).toBeFalsy();
    expect(p1.json.post.model).toBe("gpt-5"); // from usage
    const p2 = await a.post({ thread_id: tid, body: "step 2 @bob", kind: "progress", cli: "codex", model: "o3" });
    expect(p2.status).toBe(200);
    expect(p2.json.collapsed).toBe(true);
    expect(p2.json.post.id).toBe(p1.json.post.id);
    expect(p2.json.post).toMatchObject({ body: "step 2 @bob", revisions: 1, cli: "codex", model: "o3", created_at: p1.json.post.created_at });
    expect(p2.json.post.edited_at).toBeGreaterThan(0);
    // no new delivery for the collapsed write
    expect(env.d1.q("SELECT * FROM deliveries WHERE member_id = ?", b.id)).toHaveLength(2);
    expect(env.d1.q("SELECT * FROM posts WHERE thread_id = ?", tid)).toHaveLength(2);

    // another author in between breaks the chain
    await b.post({ thread_id: tid, body: "ok", kind: "msg" });
    const p3 = await a.post({ thread_id: tid, body: "step 3", kind: "progress" });
    expect(p3.json.collapsed).toBeFalsy();
    // older than 6h → new post
    env.d1.x("UPDATE posts SET created_at = ? WHERE id = ?", Date.now() - 7 * 3600_000, p3.json.post.id);
    const p4 = await a.post({ thread_id: tid, body: "step 4", kind: "progress" });
    expect(p4.json.collapsed).toBeFalsy();
    expect(p4.json.post.id).not.toBe(p3.json.post.id);

    // the same idempotency key on a fresh post still returns duplicate
    const k = await a.post({ thread_id: tid, body: "msg", kind: "msg", idempotency_key: "same" });
    const k2 = await a.post({ thread_id: tid, body: "msg", kind: "msg", idempotency_key: "same" });
    expect(k2.json.duplicate).toBe(true);
    expect(k2.json.post.id).toBe(k.json.post.id);
    // users cannot send kind state
    expect((await a.post({ thread_id: tid, body: "x", kind: "state" })).status).toBe(400);
    // over-long model is cut to 64
    const long = await a.post({ thread_id: tid, body: "m", model: "x".repeat(100) });
    expect(long.json.post.model).toHaveLength(64);
  });

  it("runs back-fill the model of posts written during the run", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    const start = Date.now() - 5000;
    const p = await a.post({ workspace_id: ws, title: "t", body: "hi" });
    const tid = p.json.thread.id;
    expect(p.json.post.model).toBeNull();
    const r = await a.call("POST", "/runs", {
      runs: [{ id: "r_" + "1".repeat(26), thread_id: tid, started_at: start, ended_at: start + 1000, model: "sonnet-4.5" }],
    });
    expect(r.json.accepted).toBe(1);
    expect(env.d1.one<{ model: string }>("SELECT model FROM posts WHERE id = ?", p.json.post.id)!.model).toBe("sonnet-4.5");
  });

  it("state changes create a quiet kind:state post, collapsed per author", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    const b = await makeAgent(env, "bob");
    const t = await api(env, "POST", "/threads", { workspace_id: ws, title: "goal", body: "go @bob", assignee: "alice" });
    const tid = t.json.thread.id;
    const nDeliveries = env.d1.q("SELECT * FROM deliveries").length;
    const nNotif = env.d1.q("SELECT * FROM notifications").length;
    expect((await a.call("PATCH", `/threads/${tid}`, { state: "目标：A" })).status).toBe(200);
    expect((await a.call("PATCH", `/threads/${tid}`, { state: "目标：B" })).status).toBe(200);
    const states = env.d1.q<{ body: string; revisions: number; author_id: string }>("SELECT body, revisions, author_id FROM posts WHERE kind = 'state'");
    expect(states).toEqual([{ body: "目标：B", revisions: 1, author_id: a.id }]);
    // unchanged state → nothing new
    await a.call("PATCH", `/threads/${tid}`, { state: "目标：B" });
    expect(env.d1.one<{ revisions: number }>("SELECT revisions FROM posts WHERE kind = 'state'")!.revisions).toBe(1);
    // different author → new state post
    await api(env, "PATCH", `/threads/${tid}`, { state: "目标：C" });
    expect(env.d1.q("SELECT * FROM posts WHERE kind = 'state'")).toHaveLength(2);
    expect(env.d1.q("SELECT * FROM deliveries")).toHaveLength(nDeliveries);
    expect(env.d1.q("SELECT * FROM notifications")).toHaveLength(nNotif);
    const view = await api(env, "GET", `/threads/${tid}`);
    expect(view.json.posts.at(-1)).toMatchObject({ kind: "state", body: "目标：C" });
    expect(b.id).toBeTruthy();
  });
});

describe("live status", () => {
  it("activity + receipts: sent → received → working → handled; team scoped", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const bob = await makeAgent(env, "bob");
    const t = await api(env, "POST", "/threads", { workspace_id: ws, title: "t", body: "@bob please" });
    const tid = t.json.thread.id;
    const pid = t.json.post.id;
    env.d1.x("UPDATE members SET last_seen_at = 1000 WHERE id = ?", bob.id);

    let live = await api(env, "GET", `/threads/${tid}/live`);
    expect(live.status).toBe(200);
    expect(live.res.headers.get("cache-control")).toBe("no-store");
    expect(live.json.next_post_id).toBe(pid);
    expect(live.json.receipts[pid]).toEqual([{ member_id: bob.id, state: "sent", at: expect.any(Number), eta: 1000 + 300_000 }]);
    const feed = await api(env, "GET", "/feed");
    expect(feed.json.items[0].receipts_summary).toEqual({ sent: 1, received: 0, working: 0, handled: 0 });

    const cl = await bob.call("POST", "/claim", {});
    expect(cl.json.threads).toHaveLength(1);
    live = await api(env, "GET", `/threads/${tid}/live`);
    expect(live.json.receipts[pid][0].state).toBe("received");
    expect(live.json.activity).toEqual([
      expect.objectContaining({ member_id: bob.id, state: "claimed", detail: null, stale: false }),
    ]);
    expect(env.d1.q("SELECT * FROM events WHERE name = 'delivery.claim'")).toHaveLength(1);

    const seq = env.d1.one<{ change_seq: number }>("SELECT change_seq FROM teams WHERE id = ?", env.teamId)!.change_seq;
    expect((await bob.call("POST", "/activity", { thread_id: tid, state: "running", detail: "claude · opus", model: "opus" })).status).toBe(200);
    expect(env.d1.one<{ change_seq: number }>("SELECT change_seq FROM teams WHERE id = ?", env.teamId)!.change_seq).toBe(seq);
    live = await api(env, "GET", `/threads/${tid}/live`);
    expect(live.json.receipts[pid][0].state).toBe("working");
    expect(live.json.activity[0]).toMatchObject({ state: "running", detail: "claude · opus", model: "opus" });
    expect((await api(env, "GET", "/feed")).json.items[0].receipts_summary.working).toBe(1);

    // validation
    expect((await bob.call("POST", "/activity", { thread_id: tid, state: "sleeping" })).status).toBe(400);
    expect((await bob.call("POST", "/activity", { thread_id: tid, state: "typing", detail: "x".repeat(201) })).status).toBe(400);
    expect((await bob.call("POST", "/activity", { thread_id: "t_nope", state: "typing" })).status).toBe(404);

    // stale after 10 min without updates; heartbeat refreshes
    env.d1.x("UPDATE activity SET updated_at = ? WHERE member_id = ?", Date.now() - 11 * 60_000, bob.id);
    expect((await api(env, "GET", `/threads/${tid}/live`)).json.activity[0].stale).toBe(true);
    await bob.call("POST", "/heartbeat", { thread_id: tid });
    expect((await api(env, "GET", `/threads/${tid}/live`)).json.activity[0].stale).toBe(false);

    await bob.call("POST", "/ack", { thread_id: tid });
    live = await api(env, "GET", `/threads/${tid}/live`);
    expect(live.json.receipts[pid][0].state).toBe("handled");
    expect(live.json.activity[0].state).toBe("done");
    expect(env.d1.q("SELECT * FROM events WHERE name = 'delivery.done'")).toHaveLength(1);

    const other = makeTeam(env);
    expect((await other.api("GET", `/threads/${tid}/live`)).status).toBe(404);
  });

  it("thread pages: has_more + before", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const t = await api(env, "POST", "/threads", { workspace_id: ws, title: "t", body: "p0" });
    const tid = t.json.thread.id;
    const now = Date.now();
    for (let i = 1; i <= 230; i++) {
      env.d1.x(
        "INSERT INTO posts (id, team_id, thread_id, author_id, body, kind, created_at) VALUES (?, ?, ?, ?, ?, 'msg', ?)",
        newId("p", now + i),
        env.teamId,
        tid,
        env.team.ownerId,
        `p${i}`,
        now + i,
      );
    }
    const first = await api(env, "GET", `/threads/${tid}`);
    expect(first.json.posts).toHaveLength(200);
    expect(first.json.has_more).toBe(true);
    expect(first.json.posts.at(-1).body).toBe("p230");
    const ids = first.json.posts.map((p: { id: string }) => p.id);
    expect([...ids].sort()).toEqual(ids);
    const older = await api(env, "GET", `/threads/${tid}?before=${first.json.posts[0].id}`);
    expect(older.json.posts).toHaveLength(31);
    expect(older.json.has_more).toBe(false);
    expect(older.json.posts[0].body).toBe("p0");
    expect(older.json.posts.at(-1).body).toBe("p30");
    const mid = await api(env, "GET", `/threads/${tid}?before=${first.json.posts[150].id}`);
    expect(mid.json.posts).toHaveLength(100);
    expect(mid.json.has_more).toBe(true);
  });
});

describe("attachments", () => {
  it("upload needs the CSRF header, caps at 10MB, attaches to a post, serves safe headers", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const noHdr = await webRaw(env, "POST", "/uploads", png, { "content-type": "image/png", "x-file-name": "a.png" });
    expect(noHdr.status).toBe(403);
    const big = await upload(env, new Uint8Array(10 * 1024 * 1024 + 1), "big.bin", "application/octet-stream");
    expect(big.status).toBe(413);
    // JSON-only rule still applies elsewhere
    expect((await webRaw(env, "POST", "/posts", png, { "content-type": "image/png", "x-agentbus-upload": "1" })).status).toBe(415);

    const up = await upload(env, png, "../../截图 1.png", "image/png");
    expect(up.status).toBe(200);
    const att = up.json.attachment;
    expect(att).toMatchObject({ name: "截图 1.png", mime: "image/png", size: 7 });
    expect(att.id).toMatch(/^f_[0-9a-z]{26}$/);
    expect(att.url).toBe(`/api/v1/web/files/${att.id}`);
    expect(env.r2.objects.has(`${env.teamId}/${att.id}`)).toBe(true);

    const svg = (await upload(env, new TextEncoder().encode("<svg onload=alert(1)>"), "x.svg", "image/svg+xml")).json.attachment;

    const t = await api(env, "POST", "/threads", { workspace_id: ws, title: "t", body: "看图", attachments: [att.id, svg.id] });
    expect(t.status).toBe(200);
    expect(t.json.post.attachments.map((x: { id: string }) => x.id)).toEqual([att.id, svg.id]);
    expect(env.d1.one<{ post_id: string }>("SELECT post_id FROM attachments WHERE id = ?", att.id)!.post_id).toBe(t.json.post.id);
    // already used
    expect((await api(env, "POST", "/posts", { thread_id: t.json.thread.id, body: "again", attachments: [att.id] })).status).toBe(400);
    // too many
    expect((await api(env, "POST", "/posts", { thread_id: t.json.thread.id, body: "x", attachments: Array.from({ length: 7 }, (_, i) => `f_${i}`) })).status).toBe(400);

    const dl = await api(env, "GET", `/files/${att.id}`);
    expect(dl.status).toBe(200);
    expect(dl.res.headers.get("content-type")).toBe("image/png");
    expect(dl.res.headers.get("content-disposition")).toBe("inline");
    expect(dl.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.res.headers.get("cache-control")).toBe("private, max-age=86400");

    const s = await api(env, "GET", `/files/${svg.id}`);
    expect(s.res.headers.get("content-type")).toBe("application/octet-stream");
    expect(s.res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''x.svg");

    const other = makeTeam(env);
    expect((await other.api("GET", `/files/${att.id}`)).status).toBe(404);
    const otherUp = await upload(env, png, "o.png", "image/png", {}, { email: other.team.ownerEmail, team: other.team.id });
    expect(otherUp.status).toBe(200);
    // another team's attachment cannot be used
    expect((await api(env, "POST", "/posts", { thread_id: t.json.thread.id, body: "x", attachments: [otherUp.json.attachment.id] })).status).toBe(400);
  });

  it("agent upload is signed over the raw bytes; agent posts get agent URLs", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    const bytes = new TextEncoder().encode("log line\n");
    const headers = { "content-type": "text/plain", "x-file-name": "run.log" };
    const bad = await a.call("POST", "/uploads", { bytes, headers }, { tamper: true });
    expect(bad.status).toBe(401);
    const up = await a.call("POST", "/uploads", { bytes, headers });
    expect(up.status).toBe(200);
    const att = up.json.attachment;
    expect(att.url).toBe(`/api/v1/agent/files/${att.id}`);
    const p = await a.post({ workspace_id: ws, title: "t", body: "日志", attachments: [att.id] });
    expect(p.json.post.attachments[0]).toMatchObject({ id: att.id, name: "run.log", url: `/api/v1/agent/files/${att.id}` });
    const ctx = await a.call("GET", `/context?thread=${p.json.thread.id}`);
    expect(ctx.json.posts[0].attachments[0].url).toBe(`/api/v1/agent/files/${att.id}`);
    const web = await api(env, "GET", `/threads/${p.json.thread.id}`);
    expect(web.json.posts[0].attachments[0].url).toBe(`/api/v1/web/files/${att.id}`);
    const dl = await a.call("GET", `/files/${att.id}`);
    expect(dl.status).toBe(200);
    expect(dl.json).toBe("log line\n");
    expect(dl.res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''run.log");
    const big = await a.call("POST", "/uploads", { bytes: new Uint8Array(10 * 1024 * 1024 + 1), headers });
    expect(big.status).toBe(413);
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName("a%2Fb%5Cc.txt")).toBe("c.txt");
    expect(sanitizeFileName("x\u0000y\nz")).toBe("xyz");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName("%E0%A4%A")).toBe("%E0%A4%A");
    expect(sanitizeFileName("n".repeat(300))).toHaveLength(200);
  });
});

describe("analytics", () => {
  it("validates events and drops invalid ones", async () => {
    const now = Date.now();
    expect(cleanEvent({ name: "Bad" })).toBeNull();
    expect(cleanEvent({ name: "a" })).toBeNull();
    expect(cleanEvent({ name: "x".repeat(50) })).toBeNull();
    const e = cleanEvent(
      { name: "cli.command", at: now - 30 * 86400_000, props: { cmd: "post", Bad: 1, nested: { a: 1 }, s: "y".repeat(300), ok: true }, ok: false, duration_ms: 12.7 },
      now,
    )!;
    expect(e.props).toEqual({ cmd: "post", s: "y".repeat(200), ok: true });
    expect(e.at).toBe(now - 7 * 86400_000);
    expect(e.ok).toBe(0);
    expect(e.duration_ms).toBe(12);
    expect(cleanEvent({ name: "a.b", at: now + 3600_000 }, now)!.at).toBe(now + 5 * 60_000);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(cleanEvent({ name: "a.b", props: many })!.props)).toHaveLength(20);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeNull();

    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    const r = await a.call("POST", "/events", { events: [{ name: "cli.command", props: { cmd: "tick" }, duration_ms: 50, ok: true, client_version: "0.6.0", os: "linux" }, { name: "BAD" }] });
    expect(r.json).toEqual({ accepted: 1 });
    expect(env.d1.one("SELECT source, member_id, team_id, client_version, os, ok FROM events WHERE name = 'cli.command'")).toEqual({
      source: "cli",
      member_id: a.id,
      team_id: env.teamId,
      client_version: "0.6.0",
      os: "linux",
      ok: 1,
    });
    expect((await a.call("POST", "/events", { events: Array.from({ length: 51 }, () => ({ name: "a.b" })) })).status).toBe(400);
    const w = await api(env, "POST", "/events", { events: [{ name: "page.view", props: { path: "/threads/$id" } }] });
    expect(w.json).toEqual({ accepted: 1 });
    expect(env.d1.one<{ source: string }>("SELECT source FROM events WHERE name = 'page.view'")!.source).toBe("web");
    expect(env.d1.q("SELECT * FROM events WHERE name = 'member.join' AND source = 'hub'")).toHaveLength(1);
  });

  it("analytics shape, admin only; confirm.decide event; prune", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    await api(env, "GET", "/me");
    const a = await makeAgent(env, "alice");
    const t = await api(env, "POST", "/threads", { workspace_id: ws, title: "t", body: "@alice go" });
    await a.call("POST", "/claim", {});
    await a.post({ thread_id: t.json.thread.id, body: "done", kind: "confirm" });
    await a.call("POST", "/ack", { thread_id: t.json.thread.id });
    await a.call("POST", "/events", {
      events: [
        { name: "cli.command", props: { cmd: "tick" }, duration_ms: 100, ok: true, client_version: "0.6.0" },
        { name: "cli.command", props: { cmd: "tick" }, duration_ms: 300, ok: false },
      ],
    });
    await api(env, "POST", "/events", { events: [{ name: "page.view", props: { path: "/" } }] });
    await a.call("POST", "/runs", { runs: [{ id: "r_" + "2".repeat(26), started_at: Date.now() - 100, ended_at: Date.now(), exit_code: 1, cli: "claude" }] });
    const c = env.d1.one<{ id: string }>("SELECT id FROM confirmations")!;
    await api(env, "POST", `/confirmations/${c.id}`, { decision: "approve" });
    expect(JSON.parse(env.d1.one<{ props: string }>("SELECT props FROM events WHERE name = 'confirm.decide'")!.props)).toMatchObject({ decision: "approve" });

    const r = await api(env, "GET", "/analytics?days=500");
    expect(r.status).toBe(200);
    const s = r.json;
    expect(s.days).toBe(90);
    expect(s.daily).toHaveLength(90);
    expect(s.daily.at(-1)).toEqual({ day: new Date().toISOString().slice(0, 10), web: 1, cli: 2, hub: expect.any(Number), posts: expect.any(Number) });
    expect(s.totals).toMatchObject({ active_humans: 1, active_agents: 1, runs: 1, failed_runs: 1 });
    expect(s.totals.posts).toBeGreaterThanOrEqual(3);
    expect(s.cli_commands).toEqual([{ cmd: "tick", n: 2, failed: 1, p50_ms: 100 }]);
    expect(s.pages).toEqual([{ path: "/", n: 1 }]);
    expect(s.clients).toEqual([{ version: "0.5.0", n: 1 }]);
    expect(s.adapters).toEqual([{ cli: "claude", members: 1, runs: 1 }]);
    expect(s.latency.claim_p50_ms).toEqual(expect.any(Number));
    expect(s.latency.reply_p50_ms).toEqual(expect.any(Number));
    expect(s.top_events.length).toBeGreaterThan(3);
    expect(s.posts_by_kind).toEqual(expect.arrayContaining([{ kind: "confirm", n: 1 }]));
    expect((await api(env, "GET", "/analytics?days=0")).json.days).toBe(1);

    addHuman(env, "manager", "mgr@example.com");
    expect((await api(env, "GET", "/analytics", undefined, { email: "mgr@example.com" })).status).toBe(403);

    env.d1.x("INSERT INTO events (team_id, source, name, created_at) VALUES (?, 'web', 'old.one', ?)", env.teamId, Date.now() - 91 * 86400_000);
    resetEventsPrune();
    await cleanup(env, Date.now());
    expect(env.d1.q("SELECT * FROM events WHERE name = 'old.one'")).toHaveLength(0);
  });

  it("version endpoint", async () => {
    const env = makeEnv();
    let v = await api(env, "GET", "/version");
    expect(v.json).toEqual({ server_version: "0.6.0", min_client_version: "0.5.0" }); // seeded by 0002
    env.d1.x("UPDATE settings SET value = '0.6.1' WHERE key = 'min_client_version'");
    v = await api(env, "GET", "/version");
    expect(v.json.min_client_version).toBe("0.6.1");
    env.d1.x("DELETE FROM settings WHERE key = 'min_client_version'");
    expect((await api(env, "GET", "/version")).json.min_client_version).toBe("0.0.0");
  });
});
