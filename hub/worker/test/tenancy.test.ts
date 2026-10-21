// Multi-team isolation (hub-api.md §0.1 / §3 / §6 / §7).
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_EMAIL } from "../src/auth";
import { checkFlood } from "../src/core";
import { flushNotifications } from "../src/notify";
import { callTriggers, checkUnresponsive, setTriggerFetch } from "../src/watchdog";
import { newId } from "../src/util";
import {
  ADMIN_EMAIL,
  Agent,
  FakeD1,
  MIGRATIONS,
  api,
  makeAgent,
  makeEnv,
  makeTeam,
  newKey,
  setTeamSetting,
  setupJwks,
  workspace,
  type TestEnv,
} from "./helpers";

beforeAll(setupJwks);

/** Joins are rate limited per IP (all test requests share one); clear the counter. */
const resetJoinRate = (env: TestEnv) => env.d1.x("DELETE FROM audit_log WHERE action = 'join.attempt'");
const tokenOf = (url: string) => url.split("/invite/")[1];

/** Invite `email` into the team `inviter` acts in and accept it; returns the new member id. */
async function joinByInvite(env: TestEnv, inviter: (m: string, p: string, b?: unknown) => ReturnType<typeof api>, email: string) {
  const inv = await inviter("POST", "/invites", {});
  expect(inv.status).toBe(200);
  const acc = await api(env, "POST", "/invites/accept", { token: tokenOf(inv.json.url) }, { email });
  expect(acc.status).toBe(200);
  const me = await api(env, "GET", "/me", undefined, { email, team: acc.json.team.id });
  return me.json.member.id as string;
}

/** Two populated teams in one hub: A (env's, owner admin@) and B (owner other@). */
async function twoTeams() {
  const env = makeEnv();
  // Make A the admin's earliest membership regardless of clock jitter.
  env.d1.x("UPDATE members SET created_at = created_at - 60000 WHERE id = ?", env.team.ownerId);
  const tb = makeTeam(env);

  const wsA = await workspace(env, "alpha-ws");
  const aliceA = await makeAgent(env, "alice");
  const bobA = await makeAgent(env, "bob");
  const mgrA = await makeAgent(env, "mgr", { role: "manager" });
  const pA = await aliceA.post({ workspace_id: wsA, title: "alpha plan", body: "alpha @bob" });
  const tA = pA.json.thread.id as string;
  const cA = await aliceA.post({ thread_id: tA, body: "alpha deploy?", kind: "confirm" });
  const runA = newId("r");
  await aliceA.call("POST", "/runs", { runs: [{ id: runA, started_at: Date.now() - 1000, ended_at: Date.now(), input: 3, output: 3 }] });
  await aliceA.call("POST", "/quota", { readings: [{ provider: "claude", window: "5h", used_pct: 10 }] });
  await api(env, "POST", `/posts/${pA.json.post.id}/reactions`, { emoji: "👍" });
  const invA = (await api(env, "POST", "/invites", {})).json.invite.id as string;
  const jcA = (await api(env, "POST", "/join-codes", { label: "alpha" })).json.code.id as string;

  const wsB = await tb.workspace("zebra-ws");
  const aliceB = await tb.agent("alice");
  const bobB = await tb.agent("bob");
  const pB = await aliceB.post({ workspace_id: wsB, title: "zebra plan", body: "zebra @bob" });
  const tB = pB.json.thread.id as string;
  const cB = await aliceB.post({ thread_id: tB, body: "zebra deploy?", kind: "confirm" });
  const runB = newId("r");
  await aliceB.call("POST", "/runs", { runs: [{ id: runB, started_at: Date.now() - 1000, ended_at: Date.now(), input: 1, output: 1 }] });
  await aliceB.call("POST", "/quota", { readings: [{ provider: "claude", window: "5h", used_pct: 10 }] });
  await tb.api("POST", `/posts/${pB.json.post.id}/reactions`, { emoji: "👍" });
  const invB = (await tb.api("POST", "/invites", {})).json.invite.id as string;
  const jcB = (await tb.api("POST", "/join-codes", { label: "zebra" })).json.code.id as string;
  await tb.api("PUT", `/members/${aliceB.id}/budget`, { daily_tokens: 1000 });

  const confA = env.d1.one<{ id: string }>("SELECT id FROM confirmations WHERE team_id = ?", env.teamId)!.id;
  const confB = env.d1.one<{ id: string }>("SELECT id FROM confirmations WHERE team_id = ?", tb.team.id)!.id;
  const A = {
    id: env.teamId, ws: wsA, thread: tA, post: pA.json.post.id as string, confPost: cA.json.post.id as string, conf: confA,
    alice: aliceA, bob: bobA, mgr: mgrA, run: runA, invite: invA, code: jcA, owner: env.team.ownerId,
  };
  const B = {
    id: tb.team.id, ws: wsB, thread: tB, post: pB.json.post.id as string, confPost: cB.json.post.id as string, conf: confB,
    alice: aliceB, bob: bobB, run: runB, invite: invB, code: jcB, owner: tb.team.ownerId,
  };
  const secretsOf = (t: typeof A | typeof B, marker: string, teamName: string) => [
    marker, teamName, t.id, t.ws, t.thread, t.post, t.confPost, t.conf, t.alice.id, t.bob.id, t.run, t.invite, t.code, t.owner,
  ];
  return { env, tb, A, B, aSecrets: secretsOf(A, "alpha", env.team.name), bSecrets: secretsOf(B, "zebra", tb.team.name) };
}

function expectNoLeak(label: string, json: unknown, secrets: string[]) {
  const s = JSON.stringify(json);
  for (const x of secrets) expect(s.includes(x), `${label} leaks ${x}`).toBe(false);
}

const webPaths = (t: { ws: string; thread: string; alice: Agent }) => [
  "/me", "/dashboard", "/feed", "/workspaces", `/workspaces/${t.ws}`, "/threads", `/threads/${t.thread}`, "/members",
  `/members/${t.alice.id}`, "/usage", "/usage?group=agent", "/usage?group=thread", "/runs", "/audit", "/settings",
  "/search?q=plan", "/search?q=deploy&member=alice", "/invites", "/join-codes", "/changes",
];

// ---------------------------------------------------------------- isolation

describe("team isolation: reads", () => {
  it("no web GET in one team returns another team's rows", async () => {
    const { env, tb, A, B, aSecrets, bSecrets } = await twoTeams();
    for (const p of webPaths(A)) {
      const r = await api(env, "GET", p);
      expect(r.status, p).toBe(200);
      expectNoLeak(`A ${p}`, r.json, bSecrets);
    }
    for (const p of webPaths(B)) {
      const r = await tb.api("GET", p);
      expect(r.status, p).toBe(200);
      expectNoLeak(`B ${p}`, r.json, aSecrets);
    }
    // Sanity: the loops really saw data.
    expect((await api(env, "GET", "/search?q=plan")).json.results).toHaveLength(1);
    expect((await api(env, "GET", "/search?q=zebra")).json.results).toEqual([]);
    expect((await api(env, "GET", "/members")).json.members.map((m: { name: string }) => m.name).sort()).toEqual(["admin-user", "alice", "bob", "mgr"]);
    expect((await tb.api("GET", "/members")).json.members.map((m: { name: string }) => m.name).sort()).toEqual(["admin-user", "alice", "bob"]);
    expect((await api(env, "GET", "/runs")).json.runs.map((r: { id: string }) => r.id)).toEqual([A.run]);
    expect((await tb.api("GET", "/invites")).json.invites.map((i: { id: string }) => i.id)).toEqual([B.invite]);
  });

  it("no agent GET returns another team's rows; same agent name lives in both teams", async () => {
    const { env, A, B, bSecrets, aSecrets } = await twoTeams();
    expect(A.alice.id).not.toBe(B.alice.id);
    const paths = (t: typeof A | typeof B) => ["/state", "/threads", "/threads?mine=1", "/workspaces", `/workspaces/${t.ws}`, `/context?thread=${t.thread}`, `/posts?thread=${t.thread}`];
    for (const p of paths(A)) {
      const r = await A.alice.call("GET", p);
      expect(r.status, p).toBe(200);
      expectNoLeak(`agent A ${p}`, r.json, bSecrets);
    }
    for (const p of paths(B)) {
      const r = await B.alice.call("GET", p);
      expect(r.status, p).toBe(200);
      expectNoLeak(`agent B ${p}`, r.json, aSecrets);
    }
    const mm = await A.mgr.call("GET", "/manage/members");
    expect(mm.status).toBe(200);
    expectNoLeak("manage/members", mm.json, bSecrets);
    expect((await A.alice.call("GET", "/state")).json.team).toEqual({ id: A.id, name: env.team.name });
    expect((await B.alice.call("GET", "/state")).json.team).toEqual({ id: B.id, name: "第二团队" });
    // "@bob" in each team only reached that team's bob.
    const claimA = await A.bob.call("POST", "/claim", {});
    expect(claimA.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([A.thread]);
    const claimB = await B.bob.call("POST", "/claim", {});
    expect(claimB.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([B.thread]);
    expect(env.d1.q("SELECT * FROM deliveries WHERE member_id = ? AND thread_id = ?", A.bob.id, B.thread)).toHaveLength(0);
  });
});

describe("team isolation: writes", () => {
  it("web writes on another team's ids are 404 and change nothing", async () => {
    const { env, A, B } = await twoTeams();
    const before = env.d1.one<{ n: number }>("SELECT change_seq AS n FROM teams WHERE id = ?", B.id)!.n;
    const cases: [string, string, unknown][] = [
      ["GET", `/threads/${B.thread}`, undefined],
      ["GET", `/workspaces/${B.ws}`, undefined],
      ["GET", `/members/${B.alice.id}`, undefined],
      ["PATCH", `/workspaces/${B.ws}`, { goal: "hijack" }],
      ["PATCH", `/threads/${B.thread}`, { status: "closed" }],
      ["POST", "/threads", { workspace_id: B.ws, title: "x", body: "y" }],
      ["POST", "/posts", { thread_id: B.thread, body: "hijack" }],
      ["POST", `/posts/${B.post}/reactions`, { emoji: "👎" }],
      ["POST", `/confirmations/${B.conf}`, { decision: "approve" }],
      ["PATCH", `/members/${B.alice.id}`, { display_name: "pwned" }],
      ["POST", `/members/${B.alice.id}/approve`, {}],
      ["POST", `/members/${B.alice.id}/reject`, {}],
      ["POST", `/members/${B.alice.id}/pause`, { reason: "x" }],
      ["POST", `/members/${B.alice.id}/resume`, {}],
      ["POST", `/members/${B.alice.id}/revoke`, {}],
      ["DELETE", `/members/${B.alice.id}`, undefined],
      ["PUT", `/members/${B.alice.id}/quota-rules`, { rules: [] }],
      ["PUT", `/members/${B.alice.id}/budget`, { daily_tokens: 1 }],
      ["PUT", `/managers/${B.alice.id}/scopes`, { workspace_ids: [] }],
      ["DELETE", `/invites/${B.invite}`, undefined],
      ["DELETE", `/join-codes/${B.code}`, undefined],
    ];
    for (const [m, p, b] of cases) {
      const r = await api(env, m, p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // Workspace ids from another team are rejected in scopes.
    expect((await api(env, "PUT", `/managers/${A.mgr.id}/scopes`, { workspace_ids: [B.ws] })).status).toBe(400);
    expect(env.d1.one<{ n: number }>("SELECT change_seq AS n FROM teams WHERE id = ?", B.id)!.n).toBe(before);
    expect(env.d1.one<{ status: string; display_name: string; paused: number }>("SELECT status, display_name, paused FROM members WHERE id = ?", B.alice.id)).toMatchObject({
      status: "active",
      display_name: "alice",
      paused: 0,
    });
    expect(env.d1.one<{ status: string }>("SELECT status FROM confirmations WHERE id = ?", B.conf)!.status).toBe("pending");
    expect(env.d1.one<{ revoked_at: number | null }>("SELECT revoked_at FROM invites WHERE id = ?", B.invite)!.revoked_at).toBeNull();
    expect(env.d1.one<{ revoked_at: number | null }>("SELECT revoked_at FROM join_codes WHERE id = ?", B.code)!.revoked_at).toBeNull();
    // Renaming A leaves B alone.
    expect((await api(env, "PATCH", "/team", { name: "改名了" })).json.team.name).toBe("改名了");
    expect(env.d1.one<{ name: string }>("SELECT name FROM teams WHERE id = ?", B.id)!.name).toBe("第二团队");
  });

  it("agent writes on another team's ids are 404 / no-ops", async () => {
    const { env, A, B } = await twoTeams();
    const a = A.alice;
    for (const [m, p, b] of [
      ["GET", `/context?thread=${B.thread}`, undefined],
      ["GET", `/posts?thread=${B.thread}`, undefined],
      ["GET", `/workspaces/${B.ws}`, undefined],
      ["POST", "/posts", { thread_id: B.thread, body: "hi", idempotency_key: "x1" }],
      ["POST", "/posts", { workspace_id: B.ws, title: "t", body: "hi", idempotency_key: "x2" }],
      ["PATCH", `/threads/${B.thread}`, { status: "done" }],
    ] as [string, string, unknown][]) {
      const r = await a.call(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await a.call("POST", "/posts", { thread_id: A.thread, body: "re", reply_to: B.post, idempotency_key: "x3" })).status).toBe(400);
    expect((await a.post({ workspace_id: A.ws, title: "t", body: "x", assignee: B.bob.id })).status).toBe(400);
    expect((await a.call("POST", "/ack", { thread_id: B.thread })).json.acked).toBe(0);
    const mgr = A.mgr;
    expect((await mgr.call("POST", `/manage/members/${B.alice.id}/pause`, { reason: "x" })).status).toBe(404);
    expect((await mgr.call("PATCH", `/manage/workspaces/${B.ws}`, { goal: "g" })).status).toBe(404);
    expect(env.d1.one<{ status: string }>("SELECT status FROM threads WHERE id = ?", B.thread)!.status).toBe("open");
    expect(env.d1.q("SELECT * FROM posts WHERE thread_id = ? AND author_id = ?", B.thread, a.id)).toHaveLength(0);
  });
});

// Regressions from the isolation audit: rows that reference another team's ids
// (crafted directly in the DB, or sent by a client) must never pull that team's data in.
describe("isolation audit regressions", () => {
  /** A post row in team A that (wrongly) points at B's thread / is written by B's agent. */
  const crossPost = (env: TestEnv, o: { team: string; thread: string; author: string; body: string; idem?: string; at?: number }) => {
    const id = newId("p");
    env.d1.x(
      "INSERT INTO posts (id, team_id, thread_id, author_id, kind, body, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'message', ?, ?, ?)",
      id, o.team, o.thread, o.author, o.body, o.idem ?? null, o.at ?? Date.now(),
    );
    return id;
  };

  it("POST /agent/runs drops another team's thread_id", async () => {
    const { env, A, B } = await twoTeams();
    const id = newId("r");
    const r = await A.alice.call("POST", "/runs", {
      runs: [{ id, thread_id: B.thread, started_at: Date.now() - 500, ended_at: Date.now(), input: 1, output: 1 }],
    });
    expect(r.status).toBe(200);
    expect(env.d1.one("SELECT team_id, thread_id FROM runs WHERE id = ?", id)).toEqual({ team_id: A.id, thread_id: null });
    const own = newId("r");
    await A.alice.call("POST", "/runs", { runs: [{ id: own, thread_id: A.thread, started_at: Date.now() - 500, ended_at: Date.now() }] });
    expect(env.d1.one("SELECT thread_id FROM runs WHERE id = ?", own)).toEqual({ thread_id: A.thread });
    expect(JSON.stringify((await api(env, "GET", "/usage?group=thread")).json)).not.toContain("zebra");
  });

  it("/feed and /search never resolve another team's thread from a post row", async () => {
    const { env, A, B, bSecrets } = await twoTeams();
    crossPost(env, { team: A.id, thread: B.thread, author: A.alice.id, body: "alpha needle" });
    const feed = await api(env, "GET", "/feed");
    expect(feed.status).toBe(200);
    expectNoLeak("feed", feed.json, bSecrets.filter((s) => s !== B.thread));
    const search = await api(env, "GET", "/search?q=needle");
    expect(search.json.results).toEqual([]);
    // The thread view only lists that thread's own-team posts.
    expect((await api(env, "GET", `/threads/${A.thread}`)).json.posts.every((p: { thread_id: string }) => p.thread_id === A.thread)).toBe(true);
  });

  it("flood check ignores authors from another team", async () => {
    const { env, A, B } = await twoTeams();
    const t0 = Date.now() - 30 * 60_000;
    for (let i = 0; i < 30; i++)
      crossPost(env, { team: A.id, thread: A.thread, author: i % 2 ? A.alice.id : B.alice.id, body: `ping ${i}`, at: t0 + i * 1000 });
    expect(await checkFlood(env, A.id, A.thread)).toBe(false);
    expect(env.d1.one("SELECT auto_paused FROM threads WHERE id = ?", A.thread)).toEqual({ auto_paused: 0 });
    // Same pattern between two agents of A does trip it (sanity).
    for (let i = 0; i < 30; i++)
      crossPost(env, { team: A.id, thread: A.thread, author: i % 2 ? A.alice.id : A.bob.id, body: `pong ${i}`, at: t0 + 60_000 + i * 1000 });
    expect(await checkFlood(env, A.id, A.thread)).toBe(true);
  });

  it("idempotency replays are looked up in the author's team only", async () => {
    const { env, A, B } = await twoTeams();
    // Normal replay inside the team returns the original post.
    const first = await A.alice.call("POST", "/posts", { thread_id: A.thread, body: "fresh", idempotency_key: "k-own" });
    const again = await A.alice.call("POST", "/posts", { thread_id: A.thread, body: "fresh", idempotency_key: "k-own" });
    expect(again.json.post.id).toBe(first.json.post.id);
    // A (corrupt) row in B with the same author+key is never returned. Member ids are per team, so
    // the UNIQUE (author_id, idempotency_key) index makes this unreachable in practice.
    const foreign = crossPost(env, { team: B.id, thread: B.thread, author: A.alice.id, body: "zebra secret", idem: "k-x" });
    const r = await A.alice.call("POST", "/posts", { thread_id: A.thread, body: "other", idempotency_key: "k-x" });
    expect(JSON.stringify(r.json)).not.toContain(foreign);
    expect(JSON.stringify(r.json)).not.toContain("zebra");
  });

  it("deciding a confirmation names the requester from the same team", async () => {
    const { env, A } = await twoTeams();
    const r = await api(env, "POST", `/confirmations/${A.conf}`, { decision: "approve", note: "ok" });
    expect(r.status).toBe(200);
    expect(env.d1.one("SELECT status, team_id FROM confirmations WHERE id = ?", A.conf)).toEqual({ status: "approved", team_id: A.id });
  });

  it("deleting a revoked member removes its reactions too", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const alice = await makeAgent(env, "alice");
    const p = (await alice.post({ workspace_id: ws, title: "t", body: "x" })).json.post.id as string;
    const bobId = await joinByInvite(env, (m, q, b) => api(env, m, q, b), "bob-human@example.com");
    expect((await api(env, "POST", `/posts/${p}/reactions`, { emoji: "👍" }, { email: "bob-human@example.com" })).status).toBe(200);
    expect((await api(env, "POST", `/members/${bobId}/revoke`, {})).status).toBe(200);
    expect((await api(env, "DELETE", `/members/${bobId}`)).status).toBe(200);
    expect(env.d1.q("SELECT * FROM reactions WHERE member_id = ?", bobId)).toHaveLength(0);
    expect(env.d1.q("SELECT * FROM members WHERE id = ?", bobId)).toHaveLength(0);
  });

  it("PATCH /me (profile, avatar) changes only the current team's row of a multi-team human", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    const myB = await joinByInvite(env, tb.api, ADMIN_EMAIL);
    const r = await api(env, "PATCH", "/me", { display_name: "甲队的我", avatar_url: "https://example.com/a.png" }, { team: env.teamId });
    expect(r.status).toBe(200);
    expect(env.d1.one("SELECT display_name, avatar_url FROM members WHERE id = ?", env.team.ownerId)).toEqual({
      display_name: "甲队的我",
      avatar_url: "https://example.com/a.png",
    });
    expect(env.d1.one<{ display_name: string; avatar_url: string | null }>("SELECT display_name, avatar_url FROM members WHERE id = ?", myB)).toMatchObject({
      avatar_url: null,
    });
    expect(env.d1.one<{ display_name: string }>("SELECT display_name FROM members WHERE id = ?", myB)!.display_name).not.toBe("甲队的我");
  });

  it("an email-change token applies to the team it was requested in", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    await joinByInvite(env, tb.api, ADMIN_EMAIL);
    setTeamSetting(env, env.teamId, "notify_email", "a-notify@example.com");
    // Requested while acting in B …
    expect((await api(env, "POST", "/settings/email", { email: "b-new@example.com" }, { team: tb.team.id })).status).toBe(200);
    const token = env.sent.at(-1)!.text.match(/token=([A-Za-z0-9_%-]+)/)![1];
    // … confirmed while the browser has A selected: B changes, A doesn't.
    const ok = await api(env, "GET", `/settings/email/confirm?token=${token}`, undefined, { team: env.teamId });
    expect(ok.res.headers.get("location")).toBe(`/settings?email=ok&team=${tb.team.id}`);
    const val = (t: string) => env.d1.one<{ value: string }>("SELECT value FROM team_settings WHERE team_id = ? AND key = 'notify_email'", t)?.value;
    expect(val(tb.team.id)).toBe("b-new@example.com");
    expect(val(env.teamId)).toBe("a-notify@example.com");
    expect(env.d1.q("SELECT * FROM audit_log WHERE action = 'settings.email_changed' AND team_id = ?", env.teamId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- join codes

describe("join codes", () => {
  it("create / list / use / revoke / expire; missing and wrong codes", async () => {
    const env = makeEnv();
    const c = await api(env, "POST", "/join-codes", { label: "ci", expires_in_days: 7 });
    expect(c.status).toBe(200);
    expect(c.json.secret).toMatch(/^abj_[0-9a-z]{26}$/);
    expect(c.json.code.prefix).toBe(c.json.secret.slice(0, 8));
    expect(c.json.code.expires_at).toBeGreaterThan(Date.now() + 6 * 86400_000);
    const list = await api(env, "GET", "/join-codes");
    expect(JSON.stringify(list.json)).not.toContain(c.json.secret);
    expect(JSON.stringify(list.json)).not.toContain("code_hash");
    for (const bad of [0, -1, 400, "x"]) expect((await api(env, "POST", "/join-codes", { expires_in_days: bad })).status).toBe(400);

    const a = await makeAgent(env, "alice", { join: { join_code: c.json.secret }, approve: false });
    const st = await a.call("GET", "/state"); // pending agents may read state
    expect(st.status).toBe(200);
    expect(st.json.team).toEqual({ id: env.teamId, name: env.team.name });
    expect(env.d1.one<{ uses: number; last_used_at: number }>("SELECT uses, last_used_at FROM join_codes WHERE id = ?", c.json.code.id)).toMatchObject({ uses: 1 });

    // Same key again: idempotent, no join_code needed.
    const again = await new Agent(env, "alice", a.key).call("POST", "/join", { public_key: a.key.publicB64, name: "alice", cli: "claude" });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ member_id: a.id, status: "pending", team: { id: env.teamId, name: env.team.name } });

    const miss = makeAgent(env, "nocode", { join: { join_code: undefined } });
    await expect(miss).rejects.toThrow(/400.*join_code_required/);
    await expect(makeAgent(env, "wrong", { join: { join_code: "abj_" + "x".repeat(26) } })).rejects.toThrow(/403.*bad_join_code/);
    await expect(makeAgent(env, "junk", { join: { join_code: "hello" } })).rejects.toThrow(/403.*bad_join_code/);

    expect((await api(env, "DELETE", `/join-codes/${c.json.code.id}`)).json.code.revoked_at).toBeGreaterThan(0);
    await expect(makeAgent(env, "late", { join: { join_code: c.json.secret } })).rejects.toThrow(/403.*bad_join_code/);

    env.d1.x("UPDATE join_codes SET expires_at = ? WHERE code_hash <> ''", Date.now() - 60_000);
    await expect(makeAgent(env, "expired")).rejects.toThrow(/403.*bad_join_code/);
    expect(env.d1.q("SELECT * FROM members WHERE name IN ('nocode', 'wrong', 'junk', 'late', 'expired')")).toHaveLength(0);
  });

  it("a team's code joins that team; names are unique per team only", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    const a = await makeAgent(env, "alice");
    const b = await tb.agent("alice");
    expect((await a.call("GET", "/state")).json.team.id).toBe(env.teamId);
    expect((await b.call("GET", "/state")).json.team.id).toBe(tb.team.id);
    await expect(makeAgent(env, "alice")).rejects.toThrow(/409/);
    await expect(tb.agent("alice")).rejects.toThrow(/409/);
    // Mentions resolve inside the team.
    const ws = await workspace(env);
    await makeAgent(env, "bob");
    const bobB = await tb.agent("bob");
    await a.post({ workspace_id: ws, title: "t", body: "@bob @alice" });
    expect(env.d1.q("SELECT * FROM deliveries WHERE member_id IN (?, ?)", bobB.id, b.id)).toHaveLength(0);
    // join_request notifications land in the right team.
    expect(env.d1.q("SELECT * FROM notifications WHERE team_id = ? AND kind = 'join_request'", tb.team.id)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- invites

describe("invites", () => {
  it("create → email → preview → accept; single use; revoke; expiry", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    await tb.agent("alice"); // queues a join_request for B
    const bad = await tb.api("POST", "/invites", { email: "not-an-email" });
    expect(bad.status).toBe(400);

    const inv = await tb.api("POST", "/invites", { email: "Invitee@Example.com" });
    expect(inv.status).toBe(200);
    expect(inv.json.url).toMatch(/^https:\/\/hub\.test\/invite\/abi_[0-9a-z]{26}$/);
    expect(inv.json.email_error).toBeNull();
    expect(inv.json.invite).toMatchObject({ email: "invitee@example.com", role: "admin", accepted_at: null, revoked_at: null });
    const token = tokenOf(inv.json.url);
    const mail = env.sent.at(-1)!;
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.subject).toContain("第二团队");
    expect(mail.text).toContain(inv.json.url);
    expect(env.sent).toHaveLength(1); // only the invite; B's join_request waits for its own flush
    expect(env.d1.q("SELECT * FROM notifications WHERE team_id = ? AND kind = 'join_request' AND sent_at IS NULL", tb.team.id)).toHaveLength(1);
    const stored = env.d1.one<{ payload: string }>("SELECT payload FROM notifications WHERE kind = 'invite'")!.payload;
    expect(stored).not.toContain(token);
    expect(JSON.stringify((await tb.api("GET", "/invites")).json)).not.toContain(token);

    const who = { email: "invitee@example.com" };
    expect((await api(env, "GET", "/workspaces", undefined, who)).json.error.code).toBe("no_team");
    const pv = await api(env, "GET", `/invites/preview?token=${token}`, undefined, who);
    expect(pv.status).toBe(200);
    expect(pv.json).toMatchObject({ team: { id: tb.team.id, name: "第二团队" }, inviter: { display_name: "other" }, valid: true, already_member: false });
    expect((await api(env, "GET", "/invites/preview?token=abi_nope", undefined, who)).status).toBe(404);

    const acc = await api(env, "POST", "/invites/accept", { token }, who);
    expect(acc.status).toBe(200);
    expect(acc.json.team).toEqual({ id: tb.team.id, name: "第二团队" });
    const me = await api(env, "GET", "/me", undefined, who);
    expect(me.json.team.id).toBe(tb.team.id);
    expect(me.json.role).toBe("admin");
    expect(me.json.member).toMatchObject({ kind: "human", role: "admin", name: "invitee" });
    expect(me.json.teams).toEqual([{ id: tb.team.id, name: "第二团队", role: "admin" }]);
    expect((await api(env, "GET", `/invites/preview?token=${token}`, undefined, who)).json).toMatchObject({ valid: false, already_member: true });

    // Accepting again as a member is a no-op; anyone else gets 410.
    expect((await api(env, "POST", "/invites/accept", { token }, who)).json.already_member).toBe(true);
    const reuse = await api(env, "POST", "/invites/accept", { token }, { email: "late@example.com" });
    expect(reuse.status).toBe(410);
    expect(reuse.json.error.code).toBe("invite_invalid");
    const listed = (await tb.api("GET", "/invites")).json.invites.find((i: { id: string }) => i.id === inv.json.invite.id);
    expect(listed.accepted_by).toBe(me.json.member.id);

    // Revoked.
    const r2 = await tb.api("POST", "/invites", {});
    expect(r2.json.email_error).toBeUndefined();
    expect((await tb.api("DELETE", `/invites/${r2.json.invite.id}`)).json.invite.revoked_at).toBeGreaterThan(0);
    expect((await api(env, "GET", `/invites/preview?token=${tokenOf(r2.json.url)}`, undefined, { email: "late@example.com" })).json.valid).toBe(false);
    expect((await api(env, "POST", "/invites/accept", { token: tokenOf(r2.json.url) }, { email: "late@example.com" })).status).toBe(410);

    // Expired.
    const r3 = await tb.api("POST", "/invites", {});
    env.d1.x("UPDATE invites SET expires_at = 1 WHERE id = ?", r3.json.invite.id);
    expect((await api(env, "POST", "/invites/accept", { token: tokenOf(r3.json.url) }, { email: "late@example.com" })).status).toBe(410);
    expect((await api(env, "GET", "/me", undefined, { email: "late@example.com" })).json.teams).toEqual([]);
    expect(env.d1.q("SELECT * FROM audit_log WHERE team_id = ? AND action = 'invite.accept'", tb.team.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- current team

describe("current team selection", () => {
  it("X-Agentbus-Team switches teams; non-members get 403 not_member", async () => {
    const env = makeEnv();
    env.d1.x("UPDATE members SET created_at = created_at - 60000 WHERE id = ?", env.team.ownerId);
    const wsA = await workspace(env, "alpha");
    const tb = makeTeam(env);
    const wsB = await tb.workspace("zebra");
    const tc = makeTeam(env, { name: "第三团队", ownerEmail: "carol@example.com" });
    const myB = await joinByInvite(env, tb.api, ADMIN_EMAIL);

    const me = await api(env, "GET", "/me");
    expect(me.json.team.id).toBe(env.teamId); // earliest membership
    expect(me.json.role).toBe("owner");
    expect(me.json.teams).toEqual([
      { id: env.teamId, name: env.team.name, role: "owner" },
      { id: tb.team.id, name: "第二团队", role: "admin" },
    ]);
    const meB = await api(env, "GET", "/me", undefined, { team: tb.team.id });
    expect(meB.json.team.id).toBe(tb.team.id);
    expect(meB.json.role).toBe("admin");
    expect(meB.json.member.id).toBe(myB);
    const wsList = (o: { team?: string }) => api(env, "GET", "/workspaces", undefined, o).then((r) => r.json.workspaces.map((w: { id: string }) => w.id));
    expect(await wsList({})).toEqual([wsA]);
    expect(await wsList({ team: tb.team.id })).toEqual([wsB]);
    expect(await wsList({ team: env.teamId })).toEqual([wsA]);

    for (const t of [tc.team.id, "o_doesnotexist"]) {
      const r = await api(env, "GET", "/workspaces", undefined, { team: t });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("not_member");
      expect((await api(env, "GET", "/me", undefined, { team: t })).json.error.code).toBe("not_member");
    }
    // Writes go to the header's team.
    await api(env, "POST", "/workspaces", { name: "via-header" }, { team: tb.team.id });
    expect(env.d1.one<{ team_id: string }>("SELECT team_id FROM workspaces WHERE name = 'via-header'")!.team_id).toBe(tb.team.id);

    // An admin (non-owner) cannot do owner-only things in B.
    expect((await api(env, "POST", "/team/transfer", { member_id: myB }, { team: tb.team.id })).status).toBe(403);
    expect((await api(env, "DELETE", "/team", { confirm: "第二团队" }, { team: tb.team.id })).status).toBe(403);
    expect((await api(env, "POST", `/members/${tb.team.ownerId}/revoke`, {}, { team: tb.team.id })).status).toBe(403);
    expect((await api(env, "PATCH", `/members/${tb.team.ownerId}`, { display_name: "x" }, { team: tb.team.id })).status).toBe(403);

    // Leave B → no longer a member; rejoin via a new invite reuses the row.
    expect((await api(env, "POST", "/team/leave", {}, { team: tb.team.id })).status).toBe(200);
    expect((await api(env, "GET", "/workspaces", undefined, { team: tb.team.id })).json.error.code).toBe("not_member");
    expect((await api(env, "GET", "/me")).json.teams).toHaveLength(1);
    const again = await joinByInvite(env, tb.api, ADMIN_EMAIL);
    expect(again).toBe(myB);
    expect(env.d1.one<{ status: string; role: string }>("SELECT status, role FROM members WHERE id = ?", myB)).toEqual({ status: "active", role: "admin" });
  });

  it("team-less identities only reach the allowlist", async () => {
    const env = makeEnv();
    const who = { email: "lonely@example.com" };
    const me = await api(env, "GET", "/me", undefined, who);
    expect(me.status).toBe(200);
    expect(me.json).toEqual({
      identity: { email: "lonely@example.com", platform_admin: false },
      team: null,
      member: null,
      role: null,
      teams: [],
      can_create_team: false,
    });
    for (const [m, p, b] of [
      ["GET", "/workspaces"], ["GET", "/dashboard"], ["GET", "/settings"], ["GET", "/changes"], ["GET", "/members"],
      ["GET", "/invites"], ["GET", "/join-codes"], ["GET", "/audit"], ["POST", "/workspaces", { name: "x" }],
      ["POST", "/join-codes", {}], ["PATCH", "/team", { name: "x" }], ["POST", "/team/leave", {}], ["DELETE", "/team", { confirm: "x" }],
      ["PATCH", "/me", { display_name: "x" }],
    ] as [string, string, unknown?][]) {
      const r = await api(env, m, p, b, who);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.error.code, `${m} ${p}`).toBe("no_team");
    }
    expect((await api(env, "GET", "/invites/preview?token=x", undefined, who)).status).toBe(404);
    expect((await api(env, "POST", "/invites/accept", { token: "x" }, who)).status).toBe(404);
    expect((await api(env, "GET", "/settings/email/confirm?token=x", undefined, who)).status).toBe(302);
    const create = await api(env, "POST", "/teams", { name: "mine" }, who);
    expect(create.status).toBe(403);
    expect(create.json.error.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------- signup / ownership

describe("team creation and ownership", () => {
  it("SIGNUP=invite: only platform admins create teams; SIGNUP=open: anyone, max 5 owned", async () => {
    const env = makeEnv();
    const me = await api(env, "GET", "/me");
    expect(me.json.identity.platform_admin).toBe(true);
    expect(me.json.can_create_team).toBe(true);
    const t = await api(env, "POST", "/teams", { name: "  平台新队  " });
    expect(t.status).toBe(200);
    expect(t.json.team).toMatchObject({ name: "平台新队" });
    const meT = await api(env, "GET", "/me", undefined, { team: t.json.team.id });
    expect(meT.json.role).toBe("owner");
    expect(t.json.team.owner_id).toBe(meT.json.member.id);
    expect(env.d1.one<{ value: string }>("SELECT value FROM team_settings WHERE team_id = ? AND key = 'notify_email'", t.json.team.id)!.value).toBe(ADMIN_EMAIL);
    expect((await api(env, "GET", "/me")).json.teams).toHaveLength(2);

    const open = makeEnv({ SIGNUP: "open" });
    const who = { email: "founder@example.com" };
    expect((await api(open, "GET", "/me", undefined, who)).json.can_create_team).toBe(true);
    expect((await api(open, "POST", "/teams", { name: "   " }, who)).status).toBe(400);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = await api(open, "POST", "/teams", { name: `队${i}` }, who);
      expect(r.status).toBe(200);
      ids.push(r.json.team.id);
    }
    const sixth = await api(open, "POST", "/teams", { name: "队6" }, who);
    expect(sixth.status).toBe(409);
    const meF = await api(open, "GET", "/me", undefined, who);
    expect(meF.json.can_create_team).toBe(false);
    expect(meF.json.teams.map((x: { id: string }) => x.id).sort()).toEqual([...ids].sort());
    expect(meF.json.teams.every((x: { role: string }) => x.role === "owner")).toBe(true);

    // Transfer to someone already owning 5 teams is refused.
    const target = await joinByInvite(open, (m, p, b) => api(open, m, p, b), who.email);
    const tr = await api(open, "POST", "/team/transfer", { member_id: target });
    expect(tr.status).toBe(409);
  });

  it("transfer, leave, owner guards", async () => {
    const env = makeEnv();
    const agentM = await makeAgent(env, "alice");
    const bobId = await joinByInvite(env, (m, p, b) => api(env, m, p, b), "bob-human@example.com");
    const bob = { email: "bob-human@example.com" };

    expect((await api(env, "POST", "/team/leave", {})).status).toBe(403); // owner can't leave
    expect((await api(env, "POST", "/team/transfer", { member_id: env.team.ownerId }, bob)).status).toBe(403);
    expect((await api(env, "DELETE", "/team", { confirm: env.team.name }, bob)).status).toBe(403);
    expect((await api(env, "PATCH", "/team", { name: "admin 可以改名" }, bob)).status).toBe(200);
    expect((await api(env, "POST", `/members/${env.team.ownerId}/revoke`, {}, bob)).status).toBe(403);
    expect((await api(env, "POST", `/members/${bobId}/revoke`, {})).status).toBe(200); // owner removes a human
    // ... and the removed human can come back through a new invite.
    expect(await joinByInvite(env, (m, p, b) => api(env, m, p, b), bob.email)).toBe(bobId);

    expect((await api(env, "POST", "/team/transfer", { member_id: agentM.id })).status).toBe(400);
    expect((await api(env, "POST", "/team/transfer", { member_id: env.team.ownerId })).status).toBe(400);
    expect((await api(env, "POST", "/team/transfer", { member_id: "m_nope" })).status).toBe(404);
    const tr = await api(env, "POST", "/team/transfer", { member_id: bobId });
    expect(tr.status).toBe(200);
    expect(tr.json.team.owner_id).toBe(bobId);
    expect((await api(env, "GET", "/me")).json.role).toBe("admin");
    expect((await api(env, "GET", "/me", undefined, bob)).json.role).toBe("owner");
    expect((await api(env, "PATCH", `/members/${bobId}`, { role: "admin" })).status).toBe(403);

    // The old owner can now leave; it ends up team-less.
    expect((await api(env, "POST", "/team/leave", {})).status).toBe(200);
    const after = await api(env, "GET", "/me");
    expect(after.json.team).toBeNull();
    expect(after.json.teams).toEqual([]);
    expect((await api(env, "GET", "/workspaces")).json.error.code).toBe("no_team");
  });

  it("DELETE /team removes every row of that team and nothing else", async () => {
    const { env, tb, A, B } = await twoTeams();
    const tables = [
      "workspaces", "threads", "posts", "deliveries", "confirmations", "runs", "notifications", "audit_log",
      "join_codes", "invites", "team_settings", "members",
    ];
    const countA = () => Object.fromEntries(tables.map((t) => [t, env.d1.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE team_id = ?`, A.id)!.n]));
    const aBefore = countA();
    const bMembers = env.d1.q<{ id: string }>("SELECT id FROM members WHERE team_id = ?", B.id).map((r) => r.id);
    expect(bMembers.length).toBe(3);

    expect((await tb.api("DELETE", "/team", { confirm: "wrong" })).status).toBe(400);
    const del = await tb.api("DELETE", "/team", { confirm: "第二团队" });
    expect(del.status).toBe(200);

    for (const t of tables) expect(env.d1.q(`SELECT * FROM ${t} WHERE team_id = ?`, B.id), t).toHaveLength(0);
    expect(env.d1.q("SELECT * FROM teams WHERE id = ?", B.id)).toHaveLength(0);
    const inB = bMembers.map(() => "?").join(",");
    for (const t of ["member_keys", "triggers", "quota_readings", "quota_rules", "budgets", "nonces", "thread_members", "reactions"]) {
      expect(env.d1.q(`SELECT * FROM ${t} WHERE member_id IN (${inB})`, ...bMembers), t).toHaveLength(0);
    }
    expect(env.d1.q("SELECT * FROM audit_log WHERE action = 'team.delete' AND target = ? AND team_id IS NULL", B.id)).toHaveLength(1);
    expect(countA()).toEqual(aBefore);
    expect(env.d1.q("SELECT * FROM reactions WHERE post_id = ?", A.post)).toHaveLength(1);

    // B's agents are gone; its owner is team-less; A keeps working.
    expect((await B.alice.call("GET", "/state")).status).toBe(401);
    expect((await tb.api("GET", "/me", undefined, { team: undefined })).json.team).toBeNull();
    expect((await A.alice.call("GET", "/state")).status).toBe(200);
  });
});

// ---------------------------------------------------------------- change_seq / notifications

describe("per-team change_seq", () => {
  it("activity in one team doesn't wake the other team's pollers", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    const wsA = await workspace(env);
    const seqA = (await api(env, "GET", "/changes")).json.seq as number;
    const seqB = (await tb.api("GET", "/changes")).json.seq as number;
    await tb.workspace("b2");
    const alice = await makeAgent(env, "alice");
    expect((await tb.api("GET", "/changes")).json.seq).toBeGreaterThan(seqB);
    const seqA2 = (await api(env, "GET", "/changes")).json.seq as number;
    expect(seqA2).toBeGreaterThan(seqA); // alice's join bumped A
    await tb.api("POST", "/workspaces", { name: "b3" });
    await tb.api("PATCH", "/settings", { merge_window_min: 5 });
    expect((await api(env, "GET", `/changes?since=${seqA2}`)).status).toBe(304);
    await alice.post({ workspace_id: wsA, title: "t", body: "x" });
    expect((await api(env, "GET", `/changes?since=${seqA2}`)).status).toBe(200);
  });
});

describe("per-team notifications", () => {
  it("each team mails its own notify_email, merged per team, with its own window", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    const tc = makeTeam(env, { name: "无邮箱团队", ownerEmail: "carol@example.com" });
    setTeamSetting(env, env.teamId, "notify_email", "a-notify@example.com");
    setTeamSetting(env, tb.team.id, "notify_email", "b-notify@example.com");
    await makeAgent(env, "alice");
    await makeAgent(env, "bob");
    await tb.agent("alice");
    await tc.agent("alice");
    const now = Date.now() - 60_000;
    await flushNotifications(env, { now });
    expect(env.sent).toHaveLength(2);
    const toA = env.sent.find((m) => m.to === "a-notify@example.com")!;
    const toB = env.sent.find((m) => m.to === "b-notify@example.com")!;
    expect(toA.subject).toContain(env.team.name);
    expect(toA.subject).toContain("2 条");
    expect(toB.subject).toContain("第二团队");
    expect(toB.subject).not.toContain("条）");
    expect(toB.text).toContain(`team=${tb.team.id}`);
    expect(toA.text).not.toContain(tb.team.id);
    // Team C has no address: its row fails without touching A/B.
    expect(env.d1.one<{ error: string }>("SELECT error FROM notifications WHERE team_id = ?", tc.team.id)!.error).toBe("notify_email not set");
    expect((await tc.api("GET", "/settings")).json.email_health.ok).toBe(false);
    expect((await api(env, "GET", "/settings")).json.email_health.ok).toBe(true);
    expect((await tb.api("GET", "/settings")).json.email_health.ok).toBe(true);

    // Windows are per team: B opts out of merging, A still waits.
    await tb.api("PATCH", "/settings", { merge_window_min: 0 });
    resetJoinRate(env);
    await makeAgent(env, "carol");
    await tb.agent("bob");
    await flushNotifications(env, { now: now + 60_000 });
    expect(env.sent.filter((m) => m.to === "b-notify@example.com")).toHaveLength(2);
    expect(env.sent.filter((m) => m.to === "a-notify@example.com")).toHaveLength(1);
    await flushNotifications(env, { now: now + 16 * 60_000 });
    expect(env.sent.filter((m) => m.to === "a-notify@example.com")).toHaveLength(2);
    // flushNotifications({team}) only touches that team.
    resetJoinRate(env);
    await makeAgent(env, "dave");
    await tb.agent("carol");
    await flushNotifications(env, { now: now + 40 * 60_000, team: tb.team.id });
    expect(env.d1.q("SELECT * FROM notifications WHERE team_id = ? AND sent_at IS NULL", env.teamId)).toHaveLength(1);
    expect(env.d1.q("SELECT * FROM notifications WHERE team_id = ? AND sent_at IS NULL", tb.team.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- watchdog

describe("watchdog with one team paused", () => {
  afterEach(() => setTriggerFetch((u, i) => fetch(u, i)));

  it("global_pause is per team: claim, triggers and unresponsive alerts", async () => {
    const env = makeEnv();
    const tb = makeTeam(env);
    const calls: string[] = [];
    setTriggerFetch(async (url) => {
      calls.push(url);
      return new Response("ok");
    });
    const wsA = await workspace(env);
    const wsB = await tb.workspace();
    const aliceA = await makeAgent(env, "alice");
    const trigA = await makeAgent(env, "trig", { join: { wake_mode: "trigger", trigger_url: "https://example.com/a" } });
    const aliceB = await tb.agent("alice");
    const trigB = await tb.agent("trig", { join: { wake_mode: "trigger", trigger_url: "https://example.com/b" } });
    const tA = (await aliceA.post({ workspace_id: wsA, title: "t", body: "@trig" })).json.thread.id;
    const tB = (await aliceB.post({ workspace_id: wsB, title: "t", body: "@trig" })).json.thread.id;

    expect((await tb.api("PATCH", "/settings", { global_pause: true })).json.global_pause).toBe(true);
    expect((await api(env, "GET", "/settings")).json.global_pause).toBe(false);
    expect((await trigB.call("GET", "/state")).json.global_pause).toBe(true);
    expect((await trigA.call("GET", "/state")).json.global_pause).toBe(false);

    const now = Date.now();
    expect(await callTriggers(env, now)).toBe(1);
    expect(calls).toEqual(["https://example.com/a"]);

    env.d1.x("UPDATE deliveries SET created_at = ?", now - 3600_000);
    expect(await checkUnresponsive(env, now)).toBe(1);
    expect(env.d1.q("SELECT * FROM posts WHERE thread_id = ? AND kind = 'system'", tA)).toHaveLength(1);
    expect(env.d1.q("SELECT * FROM posts WHERE thread_id = ? AND kind = 'system'", tB)).toHaveLength(0);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'agent_unresponsive' AND team_id = ?", env.teamId)).toHaveLength(1);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'agent_unresponsive' AND team_id = ?", tb.team.id)).toHaveLength(0);

    const cB = await trigB.call("POST", "/claim", {});
    expect(cB.json).toMatchObject({ threads: [], paused: true, pause_reason: "global" });
    const cA = await trigA.call("POST", "/claim", {});
    expect(cA.json.paused).toBe(false);
    expect(cA.json.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([tA]);

    await tb.api("PATCH", "/settings", { global_pause: false });
    expect(await callTriggers(env, now + 61_000)).toBe(1);
    expect(calls.at(-1)).toBe("https://example.com/b");
    expect(await checkUnresponsive(env, now)).toBe(1);
    expect(env.d1.q("SELECT * FROM posts WHERE thread_id = ? AND kind = 'system'", tB)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- migration

describe("0002 migration of legacy single-tenant data", () => {
  it("moves everything into one 默认团队 and keeps agents and admins working", async () => {
    const d1 = new FakeD1({ upTo: "0001" });
    expect(d1.q("SELECT name FROM sqlite_master WHERE name = 'teams'")).toHaveLength(0);
    const key = await newKey();
    const now = Date.now();
    d1.x("UPDATE settings SET value = '42' WHERE key = 'change_seq'");
    d1.x("UPDATE settings SET value = '1' WHERE key = 'global_pause'");
    d1.x("INSERT INTO settings (key, value) VALUES ('notify_email', 'legacy-notify@example.com')");
    const human = (id: string, email: string, status: string, at: number) =>
      d1.x("INSERT INTO members (id, kind, role, name, display_name, email, status, created_at) VALUES (?, 'human', 'admin', ?, ?, ?, ?, ?)", id, email.split("@")[0], email.split("@")[0], email, status, at);
    human("m_old", "gone@example.com", "revoked", 10);
    human("m_admin", ADMIN_EMAIL, "active", 20);
    human("m_second", "second@example.com", "active", 30);
    d1.x("INSERT INTO members (id, kind, role, name, display_name, cli, wake_mode, wake_interval_s, status, created_at) VALUES ('m_alice', 'agent', 'manager', 'alice', 'alice', 'claude', 'poll', 300, 'active', 40)");
    d1.x("INSERT INTO member_keys (member_id, public_key, created_at) VALUES ('m_alice', ?, 40)", key.publicB64);
    d1.x("INSERT INTO workspaces (id, name, updated_at, created_at) VALUES ('w_1', 'legacy', 1, 1)");
    d1.x("INSERT INTO threads (id, workspace_id, title, created_by, created_at, updated_at) VALUES ('t_1', 'w_1', 'old', 'm_alice', 1, 1)");
    d1.x("INSERT INTO posts (id, thread_id, author_id, body, created_at) VALUES ('p_1', 't_1', 'm_alice', 'hello', 1)");
    d1.x("INSERT INTO deliveries (id, member_id, thread_id, post_id, reason, state, created_at, updated_at) VALUES ('d_1', 'm_alice', 't_1', 'p_1', 'mention', 'done', 1, 1)");
    d1.x("INSERT INTO confirmations (id, thread_id, post_id, requester_id, question) VALUES ('c_1', 't_1', 'p_1', 'm_alice', 'q')");
    d1.x("INSERT INTO runs (id, member_id, started_at, ended_at, created_at) VALUES ('r_1', 'm_alice', 1, 1, 1)");
    d1.x("INSERT INTO notifications (id, kind, dedupe_key, payload, created_at) VALUES ('n_1', 'join_request', 'k', '{\"title\":\"x\"}', 1)");
    d1.x("INSERT INTO audit_log (actor_id, action, created_at) VALUES ('m_admin', 'legacy.action', 1)");
    d1.x("INSERT INTO email_changes (token_hash, new_email, expires_at) VALUES ('h', 'new@example.com', ?)", now + 60_000);

    d1.applyMigration("0002_teams.sql");

    const LEGACY = "o_0000000000000000000000000l";
    expect(d1.q("SELECT id, name, owner_id, change_seq FROM teams")).toEqual([{ id: LEGACY, name: "默认团队", owner_id: "m_admin", change_seq: 42 }]);
    expect(d1.q("SELECT id, role, team_id FROM members WHERE kind = 'human' ORDER BY id")).toEqual([
      { id: "m_admin", role: "owner", team_id: LEGACY },
      { id: "m_old", role: "admin", team_id: LEGACY },
      { id: "m_second", role: "admin", team_id: LEGACY },
    ]);
    expect(d1.one("SELECT role, team_id FROM members WHERE id = 'm_alice'")).toEqual({ role: "manager", team_id: LEGACY });
    expect(d1.one("SELECT team_id FROM members WHERE id = 'm_system'")).toEqual({ team_id: null });
    for (const t of ["workspaces", "threads", "posts", "deliveries", "confirmations", "runs", "notifications", "audit_log", "email_changes"]) {
      expect(d1.q(`SELECT * FROM ${t} WHERE team_id IS NOT ?`, LEGACY), t).toHaveLength(0);
    }
    const ts = Object.fromEntries(d1.q<{ key: string; value: string }>("SELECT key, value FROM team_settings WHERE team_id = ?", LEGACY).map((r) => [r.key, r.value]));
    expect(ts).toMatchObject({ notify_email: "legacy-notify@example.com", global_pause: "1", default_pause_pct: "100", merge_window_min: "15", notify_kinds: "{}" });
    expect(d1.q("SELECT key FROM settings ORDER BY key")).toEqual([{ key: "min_client_version" }]);
    expect(d1.one("SELECT value FROM settings WHERE key = 'min_client_version'")).toEqual({ value: "0.5.0" });
    // Per-team uniqueness: the same name can now exist in another team.
    d1.x("INSERT INTO members (id, team_id, kind, role, name, display_name, status, created_at) VALUES ('m_x', 'o_other', 'agent', 'agent', 'alice', 'alice', 'active', 1)");

    // The migrated hub serves the legacy agent and admin.
    const env = makeEnv();
    Object.assign(env, { DB: d1 as unknown as D1Database, d1 });
    const alice = new Agent(env, "alice", key);
    alice.id = "m_alice";
    const st = await alice.call("GET", "/state");
    expect(st.status).toBe(200);
    expect(st.json.team).toEqual({ id: LEGACY, name: "默认团队" });
    expect(st.json.global_pause).toBe(true);
    const me = await api(env, "GET", "/me");
    expect(me.json.team).toMatchObject({ id: LEGACY, name: "默认团队", owner_id: "m_admin" });
    expect(me.json.role).toBe("owner");
    expect((await api(env, "GET", "/threads")).json.threads.map((t: { id: string }) => t.id)).toEqual(["t_1"]);
    expect((await api(env, "GET", "/changes")).json.seq).toBe(42);
    expect((await api(env, "GET", "/me", undefined, { email: "gone@example.com" })).json.teams).toEqual([]);
  });

  it("a hub nobody ever logged into gets no team", () => {
    const d1 = new FakeD1({ upTo: "0001" });
    d1.x("INSERT INTO members (id, kind, role, name, display_name, status, created_at) VALUES ('m_a', 'agent', 'agent', 'a1', 'a1', 'pending', 1)");
    d1.applyMigration("0002_teams.sql");
    expect(d1.q("SELECT * FROM teams")).toHaveLength(0);
    expect(d1.q("SELECT * FROM team_settings")).toHaveLength(0);
    expect(d1.one("SELECT team_id FROM members WHERE id = 'm_a'")).toEqual({ team_id: null });
  });

  const LEGACY = "o_0000000000000000000000000l";
  const teamSettings = (d1: FakeD1, team: string) =>
    Object.fromEntries(d1.q<{ key: string; value: string }>("SELECT key, value FROM team_settings WHERE team_id = ?", team).map((r) => [r.key, r.value]));
  const indexes = (d1: FakeD1) =>
    d1.q<{ name: string; tbl_name: string }>("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name");

  it("the migration file avoids D1-unsafe statements", () => {
    const sql = readFileSync(join(MIGRATIONS, "0002_teams.sql"), "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/PRAGMA\s+foreign_keys/i);
    expect(sql).not.toMatch(/\bTEMP(ORARY)?\b/i);
    expect(sql).not.toMatch(/\bVIRTUAL\b/i);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT)\b/i);
  });

  it("applies cleanly to an empty database", () => {
    const d1 = new FakeD1(); // 0001 + 0002 on nothing
    expect(d1.q("SELECT * FROM teams")).toEqual([]);
    expect(d1.q("SELECT * FROM team_settings")).toEqual([]);
    expect(d1.q("SELECT id, team_id FROM members")).toEqual([{ id: "m_system", team_id: null }]);
    expect(d1.q("SELECT key, value FROM settings")).toEqual([{ key: "min_client_version", value: "0.5.0" }]);
    expect(d1.q("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    // Every pre-0002 index still exists (members had none; its UNIQUEs became per-team) plus the team indexes.
    const names = indexes(d1).map((i) => i.name);
    for (const n of [
      "threads_ws", "threads_lease", "posts_thread", "posts_created", "deliveries_member", "deliveries_state", "confirmations_status",
      "runs_member", "runs_started", "notifications_unsent", "notifications_dedupe",
      "members_team", "members_email", "workspaces_team", "threads_team", "posts_team", "deliveries_team", "confirmations_team",
      "runs_team", "audit_team", "join_codes_team", "invites_team",
    ]) expect(names, n).toContain(n);
    const before = new FakeD1({ upTo: "0001" });
    for (const i of indexes(before)) expect(names, i.name).toContain(i.name);
    // Per-team uniqueness on the rebuilt members table.
    d1.x("INSERT INTO members (id, team_id, kind, role, name, display_name, status, created_at) VALUES ('m_1', 'o_a', 'agent', 'agent', 'x', 'x', 'active', 1)");
    d1.x("INSERT INTO members (id, team_id, kind, role, name, display_name, status, created_at) VALUES ('m_2', 'o_b', 'agent', 'agent', 'x', 'x', 'active', 1)");
    expect(() => d1.x("INSERT INTO members (id, team_id, kind, role, name, display_name, status, created_at) VALUES ('m_3', 'o_a', 'agent', 'agent', 'x', 'x', 'active', 1)")).toThrow(/UNIQUE/);
  });

  it("prod-shaped data: one human admin + m_system, no workspaces", async () => {
    const d1 = new FakeD1({ upTo: "0001" });
    d1.x("UPDATE settings SET value = '7' WHERE key = 'change_seq'");
    d1.x("UPDATE settings SET value = '{\"join_request\":false}' WHERE key = 'notify_kinds'");
    d1.x("INSERT INTO settings (key, value) VALUES ('notify_email', 'ops@example.com')");
    d1.x("INSERT INTO members (id, kind, role, name, display_name, email, status, created_at) VALUES ('m_admin', 'human', 'admin', 'admin-user', 'admin', ?, 'active', 100)", ADMIN_EMAIL);
    d1.x("INSERT INTO audit_log (actor_id, action, created_at) VALUES ('m_admin', 'settings.update', 5)");
    d1.applyMigration("0002_teams.sql");

    expect(d1.q("SELECT id, name, owner_id, change_seq, created_at FROM teams")).toEqual([
      { id: LEGACY, name: "默认团队", owner_id: "m_admin", change_seq: 7, created_at: 100 },
    ]);
    expect(d1.q("SELECT id, team_id, role FROM members ORDER BY id")).toEqual([
      { id: "m_admin", team_id: LEGACY, role: "owner" },
      { id: "m_system", team_id: null, role: "agent" },
    ]);
    expect(teamSettings(d1, LEGACY)).toEqual({
      notify_email: "ops@example.com",
      notify_kinds: '{"join_request":false}',
      global_pause: "0",
      default_pause_pct: "100",
      merge_window_min: "15",
    });
    expect(d1.q("SELECT key, value FROM settings")).toEqual([{ key: "min_client_version", value: "0.5.0" }]);
    expect(d1.q("SELECT team_id FROM audit_log")).toEqual([{ team_id: LEGACY }]);
    expect(d1.q("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

    const env = makeEnv();
    Object.assign(env, { DB: d1 as unknown as D1Database, d1 });
    const me = await api(env, "GET", "/me");
    expect(me.json).toMatchObject({ role: "owner", team: { id: LEGACY, name: "默认团队" } });
    expect((await api(env, "GET", "/changes")).json.seq).toBe(7);
    const settings = (await api(env, "GET", "/settings")).json;
    expect(settings.notify_email_masked).toMatch(/^o.*@example\.com$/);
    expect(settings.notify_kinds.join_request).toBe(false);
    // A 0.4 client is now told to upgrade.
    const old = await new Agent(env, "x", await newKey()).call("GET", "/state", undefined, { version: "0.4.9", member: "m_x" });
    expect(old.status).toBe(426);
  });

  it("staging-shaped data: 6 members incl. the e2e identity, 2 workspaces, 2 threads, 5 posts", async () => {
    const d1 = new FakeD1({ upTo: "0001" });
    d1.x("UPDATE settings SET value = '311' WHERE key = 'change_seq'");
    d1.x("INSERT INTO settings (key, value) VALUES ('notify_email', 'staging-notify@example.com')");
    const key = await newKey();
    const ins = (id: string, kind: string, role: string, name: string, email: string | null, status: string, at: number) =>
      d1.x("INSERT INTO members (id, kind, role, name, display_name, email, cli, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, kind, role, name, name, email, kind === "agent" ? "claude" : null, status, at);
    // The e2e service identity logged in first; it must not become the owner.
    ins("m_e2e", "human", "admin", "e2e", E2E_EMAIL, "active", 10);
    ins("m_admin", "human", "admin", "admin-user", ADMIN_EMAIL, "active", 20);
    ins("m_a", "agent", "manager", "alice", null, "active", 30);
    ins("m_b", "agent", "agent", "bob", null, "active", 31);
    ins("m_c", "agent", "agent", "carol", null, "pending", 32);
    ins("m_d", "agent", "agent", "dave", null, "revoked", 33);
    d1.x("INSERT INTO member_keys (member_id, public_key, created_at) VALUES ('m_a', ?, 30)", key.publicB64);
    d1.x("INSERT INTO manager_scopes (manager_id, workspace_id) VALUES ('m_a', 'w_1')");
    for (const w of ["w_1", "w_2"]) d1.x("INSERT INTO workspaces (id, name, updated_at, created_at) VALUES (?, ?, 1, 1)", w, w);
    for (const [t, w] of [["t_1", "w_1"], ["t_2", "w_2"]]) {
      d1.x("INSERT INTO threads (id, workspace_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, 'm_a', 1, 1)", t, w, `title ${t}`);
      d1.x("INSERT INTO thread_members (thread_id, member_id) VALUES (?, 'm_a'), (?, 'm_b')", t, t);
    }
    for (const [p, t, a] of [["p_1", "t_1", "m_a"], ["p_2", "t_1", "m_b"], ["p_3", "t_1", "m_a"], ["p_4", "t_2", "m_a"], ["p_5", "t_2", "m_admin"]])
      d1.x("INSERT INTO posts (id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, 'hello', 1)", p, t, a);
    d1.x("INSERT INTO reactions (post_id, member_id, emoji) VALUES ('p_1', 'm_admin', '👍')");
    d1.x("INSERT INTO deliveries (id, member_id, thread_id, post_id, reason, state, created_at, updated_at) VALUES ('d_1', 'm_b', 't_1', 'p_1', 'mention', 'pending', 1, 1)");
    d1.x("INSERT INTO runs (id, member_id, thread_id, started_at, ended_at, created_at) VALUES ('r_1', 'm_a', 't_1', 1, 1, 1)");
    d1.x("INSERT INTO notifications (id, kind, dedupe_key, payload, created_at) VALUES ('n_1', 'join_request', 'join:m_c', '{\"title\":\"x\"}', 1)");
    const idxBefore = indexes(d1).map((i) => i.name);
    d1.applyMigration("0002_teams.sql");

    expect(d1.q("SELECT id, owner_id, change_seq FROM teams")).toEqual([{ id: LEGACY, owner_id: "m_admin", change_seq: 311 }]);
    expect(d1.q("SELECT id, role, status FROM members WHERE kind = 'human' ORDER BY id")).toEqual([
      { id: "m_admin", role: "owner", status: "active" },
      { id: "m_e2e", role: "admin", status: "active" },
    ]);
    expect(d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE team_id = ?", LEGACY)!.n).toBe(6);
    expect(d1.q("SELECT id, status, role FROM members WHERE kind = 'agent' ORDER BY id")).toEqual([
      { id: "m_a", status: "active", role: "manager" },
      { id: "m_b", status: "active", role: "agent" },
      { id: "m_c", status: "pending", role: "agent" },
      { id: "m_d", status: "revoked", role: "agent" },
    ]);
    const count = (t: string) => d1.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE team_id = ?`, LEGACY)!.n;
    expect({ ws: count("workspaces"), threads: count("threads"), posts: count("posts"), deliveries: count("deliveries"), runs: count("runs"), notifications: count("notifications") })
      .toEqual({ ws: 2, threads: 2, posts: 5, deliveries: 1, runs: 1, notifications: 1 });
    // Member-keyed children are untouched.
    expect(d1.q("SELECT * FROM thread_members")).toHaveLength(4);
    expect(d1.q("SELECT * FROM reactions")).toHaveLength(1);
    expect(d1.q("SELECT * FROM manager_scopes")).toHaveLength(1);
    expect(teamSettings(d1, LEGACY)).toMatchObject({ notify_email: "staging-notify@example.com", notify_kinds: "{}" });
    expect(d1.one("SELECT value FROM settings WHERE key = 'min_client_version'")).toEqual({ value: "0.5.0" });
    expect(d1.q("SELECT * FROM settings WHERE key = 'change_seq'")).toEqual([]);
    for (const n of idxBefore) expect(indexes(d1).map((i) => i.name), n).toContain(n);
    expect(d1.q("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

    // change_seq is per team from here on: a new team starts at 1 and activity in it leaves 默认团队 alone.
    const env = makeEnv();
    Object.assign(env, { DB: d1 as unknown as D1Database, d1 });
    const created = await api(env, "POST", "/teams", { name: "e2e" });
    expect(created.status).toBe(200);
    const fresh = created.json.team.id as string;
    expect(d1.one("SELECT change_seq FROM teams WHERE id = ?", fresh)).toEqual({ change_seq: 1 });
    await api(env, "POST", "/workspaces", { name: "fresh-ws" }, { team: fresh });
    expect(d1.one("SELECT change_seq FROM teams WHERE id = ?", LEGACY)).toEqual({ change_seq: 311 });
    expect((await api(env, "GET", "/changes", undefined, { team: LEGACY })).json.seq).toBe(311);
    // The legacy agent keeps working and sees only 默认团队.
    const alice = new Agent(env, "alice", key);
    alice.id = "m_a";
    const st = await alice.call("GET", "/state");
    expect(st.json.team).toEqual({ id: LEGACY, name: "默认团队" });
    expect((await alice.call("GET", "/workspaces")).json.workspaces.map((w: { id: string }) => w.id).sort()).toEqual(["w_1", "w_2"]);
  });
});
