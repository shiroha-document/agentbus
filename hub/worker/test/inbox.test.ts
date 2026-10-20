import { beforeAll, describe, expect, it } from "vitest";
import { expireLeases } from "../src/watchdog";
import { checkFlood } from "../src/core";
import { thresholdFor } from "../src/pause";
import { redact } from "../src/redact";
import { api, makeAgent, makeEnv, setupJwks, workspace } from "./helpers";

beforeAll(setupJwks);

async function setup() {
  const env = makeEnv();
  const ws = await workspace(env);
  const alice = await makeAgent(env, "alice");
  const bob = await makeAgent(env, "bob");
  return { env, ws, alice, bob };
}

describe("inbox state machine", () => {
  it("mention → claim → ack", async () => {
    const { env, ws, alice, bob } = await setup();
    const p = await alice.post({ workspace_id: ws, title: "task", body: "hi @bob please look" });
    expect(p.status).toBe(200);
    const tid = p.json.thread.id;

    const st = await bob.call("GET", "/state");
    expect(st.json.pending).toBe(1);

    const c = await bob.call("POST", "/claim", {});
    expect(c.status).toBe(200);
    expect(c.json.paused).toBe(false);
    expect(c.json.threads).toHaveLength(1);
    expect(c.json.threads[0].deliveries[0].reason).toBe("mention");
    expect(env.d1.one<{ lease_holder: string }>("SELECT lease_holder FROM threads WHERE id = ?", tid)!.lease_holder).toBe(bob.id);

    // Alice can't claim a thread bob holds even if she gets a delivery.
    const ctx = await bob.call("GET", `/context?thread=${tid}`);
    expect(ctx.status).toBe(200);
    expect(ctx.json.posts).toHaveLength(1);
    expect(ctx.json.deliveries).toHaveLength(1);

    const a = await bob.call("POST", "/ack", { thread_id: tid });
    expect(a.json.acked).toBe(1);
    expect(env.d1.one<{ lease_holder: string | null }>("SELECT lease_holder FROM threads WHERE id = ?", tid)!.lease_holder).toBeNull();
    expect((await bob.call("POST", "/claim", {})).json.threads).toHaveLength(0);
  });

  it("nack 5 times → dead + notification", async () => {
    const { env, ws, alice, bob } = await setup();
    const tid = (await alice.post({ workspace_id: ws, title: "t", body: "@bob" })).json.thread.id;
    for (let i = 0; i < 5; i++) {
      const c = await bob.call("POST", "/claim", {});
      expect(c.json.threads).toHaveLength(1);
      expect((await bob.call("POST", "/nack", { thread_id: tid, reason: `fail ${i}` })).json.released).toBe(1);
    }
    const d = env.d1.one<{ state: string; attempts: number }>("SELECT state, attempts FROM deliveries WHERE member_id = ?", bob.id)!;
    expect(d.state).toBe("dead");
    expect(d.attempts).toBe(5);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'delivery_dead'")).toHaveLength(1);
  });

  it("lease expiry returns delivery to pending, dead at 5", async () => {
    const { env, ws, alice, bob } = await setup();
    const tid = (await alice.post({ workspace_id: ws, title: "t", body: "@bob" })).json.thread.id;
    await bob.call("POST", "/claim", {});
    await expireLeases(env, Date.now() + 3600_000);
    let d = env.d1.one<{ state: string; attempts: number }>("SELECT state, attempts FROM deliveries WHERE member_id = ?", bob.id)!;
    expect(d).toMatchObject({ state: "pending", attempts: 1 });
    expect(env.d1.one<{ lease_holder: string | null }>("SELECT lease_holder FROM threads WHERE id = ?", tid)!.lease_holder).toBeNull();

    env.d1.x("UPDATE deliveries SET attempts = 4, state = 'leased', lease_until = 1 WHERE member_id = ?", bob.id);
    await expireLeases(env, Date.now());
    d = env.d1.one<{ state: string; attempts: number }>("SELECT state, attempts FROM deliveries WHERE member_id = ?", bob.id)!;
    expect(d).toMatchObject({ state: "dead", attempts: 5 });
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'delivery_dead'")).toHaveLength(1);
  });

  it("heartbeat extends the lease", async () => {
    const { ws, alice, bob, env } = await setup();
    const tid = (await alice.post({ workspace_id: ws, title: "t", body: "@bob" })).json.thread.id;
    const c = await bob.call("POST", "/claim", {});
    env.d1.x("UPDATE threads SET lease_until = 5 WHERE id = ?", tid);
    const h = await bob.call("POST", "/heartbeat", { thread_id: tid });
    expect(h.json.lease_until).toBeGreaterThanOrEqual(c.json.threads[0].lease_until);
    expect(env.d1.one<{ lease_until: number }>("SELECT lease_until FROM threads WHERE id = ?", tid)!.lease_until).toBe(h.json.lease_until);
  });

  it("mention beats assign; author gets no delivery; idempotent posts", async () => {
    const { env, ws, alice, bob } = await setup();
    const p = await alice.post({ workspace_id: ws, title: "t", assignee: "bob", body: "hey @bob @alice", idempotency_key: "same" });
    const rows = env.d1.q<{ member_id: string; reason: string }>("SELECT member_id, reason FROM deliveries");
    expect(rows).toEqual([{ member_id: bob.id, reason: "mention" }]);
    const dup = await alice.call("POST", "/posts", { workspace_id: ws, title: "t", body: "hey @bob", idempotency_key: "same" });
    expect(dup.json.duplicate).toBe(true);
    expect(dup.json.post.id).toBe(p.json.post.id);
    expect(env.d1.q("SELECT * FROM deliveries")).toHaveLength(1);
    expect(env.d1.q("SELECT * FROM threads")).toHaveLength(1);
  });

  it("mentions inside code are ignored; pending members get nothing", async () => {
    const { env, ws, alice } = await setup();
    await makeAgent(env, "carol", { approve: false });
    await alice.post({ workspace_id: ws, title: "t", body: "`@bob` ```\n@bob\n``` mail bob@x.com @carol" });
    expect(env.d1.q("SELECT * FROM deliveries")).toHaveLength(0);
  });

  it("closed thread rejects agent posts and clears deliveries", async () => {
    const { env, ws, alice, bob } = await setup();
    const tid = (await alice.post({ workspace_id: ws, title: "t", body: "@bob" })).json.thread.id;
    const r = await alice.call("PATCH", `/threads/${tid}`, { status: "closed" });
    expect(r.status).toBe(200);
    expect(env.d1.one<{ state: string }>("SELECT state FROM deliveries WHERE member_id = ?", bob.id)!.state).toBe("done");
    expect((await bob.post({ thread_id: tid, body: "late" })).status).toBe(409);
    const sys = env.d1.q<{ body: string }>("SELECT body FROM posts WHERE thread_id = ? AND kind = 'system'", tid);
    expect(sys.at(-1)!.body).toContain("关闭了讨论串");
    expect(env.d1.one<{ status: string }>("SELECT status FROM threads WHERE id = ?", tid)!.status).toBe("closed");
  });
});

describe("redaction", () => {
  it("masks keys before storage and posts a system notice", async () => {
    const { env, ws, alice } = await setup();
    const key = "sk-ant-api03-" + "A".repeat(40);
    const p = await alice.post({ workspace_id: ws, title: "t", body: `my key is ${key}` });
    expect(p.json.redacted).toContain("anthropic-key");
    const bodies = env.d1.q<{ body: string; kind: string }>("SELECT body, kind FROM posts ORDER BY rowid");
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.body.includes(key))).toBe(false);
    expect(bodies.find((b) => b.kind !== "system")!.body).toContain("[已打码:anthropic-key]");
    expect(bodies.filter((b) => b.kind === "system")).toHaveLength(1);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'secret_redacted'")).toHaveLength(1);
    // alice receives the system notice (reply to her post outranks event)
    expect(env.d1.one<{ reason: string }>("SELECT reason FROM deliveries WHERE member_id = ?", alice.id)!.reason).toBe("reply");
  });

  it("redact() unit cases", () => {
    expect(redact("token=abcdefgh1234").text).toBe("token=[已打码:secret-assignment]");
    expect(redact("https://u:pass123@host/x").text).toBe("https://u:[已打码:url-password]@host/x");
    expect(redact("Authorization: Bearer abcdefghijkl").text).toBe("Authorization: Bearer [已打码:auth-header]");
    expect(redact("ghp_" + "a".repeat(36)).kinds).toEqual(["github-token"]);
    expect(redact("nothing secret here").kinds).toEqual([]);
  });
});

describe("permissions", () => {
  it("agents can't lift flood pause or post system", async () => {
    const { ws, alice } = await setup();
    const tid = (await alice.post({ workspace_id: ws, title: "t", body: "x" })).json.thread.id;
    expect((await alice.call("PATCH", `/threads/${tid}`, { auto_paused: false })).status).toBe(403);
    expect((await alice.post({ thread_id: tid, body: "x", kind: "system" })).status).toBe(400);
  });

  it("non-participants can't patch assigned threads; version conflict → 409", async () => {
    const { env, ws, alice, bob } = await setup();
    const carol = await makeAgent(env, "carol");
    const t = (await alice.post({ workspace_id: ws, title: "t", assignee: "bob", body: "x" })).json.thread;
    expect((await carol.call("PATCH", `/threads/${t.id}`, { state: "hijack" })).status).toBe(403);
    expect((await bob.call("PATCH", `/threads/${t.id}`, { state: "s1", version: t.version })).status).toBe(200);
    const stale = await bob.call("PATCH", `/threads/${t.id}`, { state: "s2", version: t.version });
    expect(stale.status).toBe(409);
    expect(stale.json.error.thread.version).toBe(t.version + 1);
  });

  it("manager routes need manager role; scoped managers see only their workspaces", async () => {
    const { env, ws, alice } = await setup();
    expect((await alice.call("GET", "/manage/members")).status).toBe(403);
    const mgr = await makeAgent(env, "boss", { role: "manager" });
    expect((await mgr.call("GET", "/manage/members")).status).toBe(200);
    const ws2 = await workspace(env, "other");
    const scoped = await api(env, "PUT", `/managers/${mgr.id}/scopes`, { workspace_ids: [ws] });
    expect(scoped.status).toBe(200);
    expect((await mgr.call("PATCH", `/manage/workspaces/${ws}`, { goal: "g" })).status).toBe(200);
    expect((await mgr.call("PATCH", `/manage/workspaces/${ws2}`, { goal: "g" })).status).toBe(403);
    // manager can approve agents but not other managers
    const pend = await makeAgent(env, "newbie", { approve: false });
    expect((await mgr.call("POST", `/manage/members/${pend.id}/approve`)).status).toBe(200);
    const mgr2 = await makeAgent(env, "boss2", { role: "manager" });
    expect((await mgr.call("POST", `/manage/members/${mgr2.id}/pause`, { reason: "x" })).status).toBe(403);
    // new workspace by scoped manager is added to its scope
    const nw = await mgr.call("POST", "/manage/workspaces", { name: "mine" });
    expect(nw.status).toBe(200);
    expect(env.d1.q("SELECT * FROM manager_scopes WHERE manager_id = ?", mgr.id)).toHaveLength(2);
  });
});

describe("pause", () => {
  it("thresholdFor picks the most specific rule", () => {
    const rules = [
      { provider: "*", window: "*", pause_at_pct: 90 },
      { provider: "claude", window: "*", pause_at_pct: 80 },
      { provider: "claude", window: "5h", pause_at_pct: 70 },
      { provider: "*", window: "7d", pause_at_pct: 60 },
    ];
    expect(thresholdFor(rules, "claude", "5h", 100)).toBe(70);
    expect(thresholdFor(rules, "claude", "7d", 100)).toBe(80);
    expect(thresholdFor(rules, "codex", "7d", 100)).toBe(60);
    expect(thresholdFor(rules, "codex", "5h", 100)).toBe(90);
    expect(thresholdFor([], "codex", "5h", 100)).toBe(100);
  });

  it("quota at threshold blocks claim; reset window resumes", async () => {
    const { env, ws, alice, bob } = await setup();
    await alice.post({ workspace_id: ws, title: "t", body: "@bob" });
    const resets = Date.now() + 3600_000;
    const q = await bob.call("POST", "/quota", { readings: [{ provider: "claude", window: "5h", used_pct: 99, resets_at: resets }] });
    expect(q.json.paused).toBe(false);
    expect((await api(env, "PUT", `/members/${bob.id}/quota-rules`, { rules: [{ provider: "claude", window: "5h", pause_at_pct: 95 }] })).status).toBe(200);
    const c = await bob.call("POST", "/claim", {});
    expect(c.json.paused).toBe(true);
    expect(c.json.pause_reason).toMatch(/quota:claude\/5h/);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'quota_paused'")).toHaveLength(1);

    await bob.call("POST", "/quota", { readings: [{ provider: "claude", window: "5h", used_pct: 10, resets_at: resets }] });
    const c2 = await bob.call("POST", "/claim", {});
    expect(c2.json.paused).toBe(false);
    expect(c2.json.threads).toHaveLength(1);
  });

  it("manual pause and global pause", async () => {
    const { env, bob } = await setup();
    expect((await api(env, "POST", `/members/${bob.id}/pause`, { reason: "maint" })).status).toBe(200);
    expect((await bob.call("POST", "/claim", {})).json.paused).toBe(true);
    await api(env, "POST", `/members/${bob.id}/resume`, {});
    expect((await bob.call("POST", "/claim", {})).json.paused).toBe(false);
    expect((await api(env, "PATCH", "/settings", { global_pause: true })).status).toBe(200);
    const c = await bob.call("POST", "/claim", {});
    expect(c.json.paused).toBe(true);
    expect(c.json.pause_reason).toBe("global");
  });
});

describe("flood", () => {
  it("more than 10 alternations auto-pauses the thread", async () => {
    const { env, ws, alice, bob } = await setup();
    const tid = (await alice.post({ workspace_id: ws, title: "t", body: "start" })).json.thread.id;
    for (let i = 0; i < 11; i++) {
      const who = i % 2 === 0 ? bob : alice;
      await who.post({ thread_id: tid, body: `msg ${i}` });
    }
    const t = env.d1.one<{ auto_paused: number }>("SELECT auto_paused FROM threads WHERE id = ?", tid)!;
    expect(t.auto_paused).toBe(1);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'flood_blocked'")).toHaveLength(1);
    expect(await checkFlood(env, tid)).toBe(false);
    // admin lifts it
    const r = await api(env, "PATCH", `/threads/${tid}`, { auto_paused: false });
    expect(r.status).toBe(200);
    expect(r.json.thread.auto_paused).toBe(false);
  });
});
