// Team isolation (hub-api.md §0.1), join codes (§3) and team management (§6).
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN_EMAIL, Agent, CLIENT_VERSION, api, makeAgent, makeEnv, makeTeam, newKey, workspace, type TestEnv } from "./helpers";
import { setupJwks } from "./helpers";

beforeAll(setupJwks);

async function joinWith(env: TestEnv, name: string, joinCode: string | undefined) {
  const a = new Agent(env, name, await newKey());
  const r = await a.call("POST", "/join", {
    ...(joinCode === undefined ? {} : { join_code: joinCode }),
    name,
    cli: "claude",
    wake_mode: "poll",
    wake_interval_s: 300,
    public_key: a.key.publicB64,
    client_version: CLIENT_VERSION,
  });
  if (r.status === 200) a.id = r.json.member_id;
  return { a, r };
}

/** Two teams, each with a workspace, an agent and a thread. */
async function twoTeams() {
  const env = makeEnv();
  const wsA = await workspace(env, "alpha");
  const alice = await makeAgent(env, "alice");
  const ta = await alice.post({ workspace_id: wsA, title: "A secret", body: "hello from team A" });
  expect(ta.status).toBe(200);

  const B = makeTeam(env);
  const wsB = await B.workspace("beta");
  const bob = await B.agent("bob");
  const tb = await bob.post({ workspace_id: wsB, title: "B secret", body: "hello from team B" });
  expect(tb.status).toBe(200);
  return { env, B, wsA, wsB, alice, bob, threadA: ta.json.thread.id as string, postA: ta.json.post.id as string, threadB: tb.json.thread.id as string };
}

describe("cross-team isolation (web)", () => {
  it("reads of another team's objects are 404, lists never leak", async () => {
    const { env, B, wsA, alice, threadA, postA } = await twoTeams();
    for (const p of [`/threads/${threadA}`, `/workspaces/${wsA}`, `/members/${alice.id}`]) {
      expect((await B.api("GET", p)).status, p).toBe(404);
    }
    const lists = await Promise.all(["/threads", "/workspaces", "/members", "/feed", "/dashboard", "/runs", "/audit"].map((p) => B.api("GET", p)));
    for (const r of lists) {
      expect(r.status).toBe(200);
      const s = JSON.stringify(r.json);
      expect(s).not.toContain(threadA);
      expect(s).not.toContain(alice.id);
      expect(s).not.toContain("A secret");
    }
    const search = await B.api("GET", "/search?q=hello");
    expect(JSON.stringify(search.json)).toContain("team B");
    expect(JSON.stringify(search.json)).not.toContain("team A");
    // and the other way around
    const mine = await api(env, "GET", "/search?q=hello");
    expect(JSON.stringify(mine.json)).not.toContain("team B");
    void postA;
  });

  it("writes to another team's objects are 404 and change nothing", async () => {
    const { env, B, wsA, alice, threadA, postA } = await twoTeams();
    const attempts: [string, string, unknown?][] = [
      ["POST", "/posts", { thread_id: threadA, body: "intrusion" }],
      ["POST", "/threads", { workspace_id: wsA, title: "x", body: "intrusion" }],
      ["PATCH", `/threads/${threadA}`, { status: "closed" }],
      ["PATCH", `/workspaces/${wsA}`, { status: "archived" }],
      ["POST", `/posts/${postA}/reactions`, { emoji: "👍" }],
      ["POST", `/members/${alice.id}/pause`, { reason: "x" }],
      ["POST", `/members/${alice.id}/resume`, {}],
      ["POST", `/members/${alice.id}/revoke`, {}],
      ["PATCH", `/members/${alice.id}`, { role: "manager" }],
      ["DELETE", `/members/${alice.id}`],
    ];
    for (const [m, p, b] of attempts) {
      const r = await B.api(m, p, b);
      expect(r.status, `${m} ${p} ${JSON.stringify(r.json)}`).toBe(404);
    }
    const t = env.d1.one<{ status: string }>("SELECT status FROM threads WHERE id = ?", threadA)!;
    expect(t.status).toBe("open");
    const a = env.d1.one<{ status: string; paused: number; role: string }>("SELECT status, paused, role FROM members WHERE id = ?", alice.id)!;
    expect(a).toMatchObject({ status: "active", paused: 0, role: "agent" });
    expect(env.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE body = 'intrusion'")!.n).toBe(0);
    expect(env.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM reactions WHERE post_id = ?", postA)!.n).toBe(0);
  });

  it("settings are per team", async () => {
    const { env, B } = await twoTeams();
    expect((await B.api("PATCH", "/settings", { global_pause: true })).status).toBe(200);
    expect((await B.api("GET", "/settings")).json.global_pause).toBe(true);
    expect((await api(env, "GET", "/settings")).json.global_pause).toBe(false);
  });

  it("X-Agentbus-Team must be one of your teams", async () => {
    const { env, B } = await twoTeams();
    const r = await api(env, "GET", "/threads", undefined, { team: B.team.id });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("not_member");
    const ok = await api(env, "GET", "/threads", undefined, { team: env.teamId });
    expect(ok.status).toBe(200);
  });
});

describe("cross-team isolation (agent)", () => {
  it("an agent cannot read, post into or claim another team's threads", async () => {
    const { bob, threadA, wsA, postA } = await twoTeams();
    expect((await bob.call("GET", `/posts?thread=${threadA}`)).status).toBe(404);
    expect((await bob.call("GET", `/workspaces/${wsA}`)).status).toBe(404);
    expect((await bob.call("PATCH", `/threads/${threadA}`, { status: "closed" })).status).toBe(404);
    expect((await bob.post({ thread_id: threadA, body: "intrusion" })).status).toBe(404);
    expect((await bob.post({ thread_id: threadA, body: "x", reply_to: postA })).status).toBe(404);
    const th = await bob.call("GET", "/threads");
    expect(JSON.stringify(th.json)).not.toContain(threadA);
    const ws = await bob.call("GET", "/workspaces");
    expect(JSON.stringify(ws.json)).not.toContain(wsA);
  });

  it("@mentions only resolve inside the author's team", async () => {
    const { env, bob, wsB } = await twoTeams();
    // alice exists only in team A; bob mentioning @alice in team B must not deliver anything to her
    const r = await bob.post({ workspace_id: wsB, title: "ping", body: "@alice are you there?" });
    expect(r.status).toBe(200);
    const alice = env.d1.one<{ id: string }>("SELECT id FROM members WHERE name = 'alice' AND team_id = ?", env.teamId)!;
    expect(env.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE member_id = ? AND thread_id = ?", alice.id, r.json.thread.id)!.n).toBe(0);
  });

  it("the same agent name can exist in two teams", async () => {
    const env = makeEnv();
    const B = makeTeam(env);
    const a1 = await makeAgent(env, "worker");
    const a2 = await B.agent("worker");
    expect(a1.id).not.toBe(a2.id);
    expect((await a1.call("GET", "/state")).json.member.id).toBe(a1.id);
    expect((await a2.call("GET", "/state")).json.member.id).toBe(a2.id);
  });
});

describe("join codes", () => {
  it("join requires a valid code and lands pending in that code's team", async () => {
    const env = makeEnv();
    const B = makeTeam(env);
    const missing = await joinWith(env, "nocode", undefined);
    expect(missing.r.status).toBe(400);
    expect(missing.r.json.error.code).toBe("join_code_required");
    const bad = await joinWith(env, "badcode", "abj_00000000000000000000000000");
    expect(bad.r.status).toBe(403);
    expect(bad.r.json.error.code).toBe("bad_join_code");

    const ok = await joinWith(env, "newbie", B.team.joinCode);
    expect(ok.r.status).toBe(200);
    expect(ok.r.json).toMatchObject({ status: "pending", team: { id: B.team.id, name: B.team.name } });
    // visible as pending in team B only
    const inB = await B.api("GET", "/members");
    expect(JSON.stringify(inB.json)).toContain(ok.a.id);
    const inA = await api(env, "GET", "/members");
    expect(JSON.stringify(inA.json)).not.toContain(ok.a.id);
    // team A's admin cannot approve it
    expect((await api(env, "POST", `/members/${ok.a.id}/approve`, {})).status).toBe(404);
    expect((await B.api("POST", `/members/${ok.a.id}/approve`, {})).status).toBe(200);
    expect((await ok.a.call("GET", "/state")).json.member.status).toBe("active");
  });

  it("create → list (no secret) → use → revoke", async () => {
    const env = makeEnv();
    const c = await api(env, "POST", "/join-codes", { label: "laptop", expires_in_days: 7 });
    expect(c.status).toBe(200);
    const secret: string = c.json.secret;
    expect(secret).toMatch(/^abj_/);
    expect(c.json.code).toMatchObject({ label: "laptop", prefix: secret.slice(0, 8), uses: 0, revoked_at: null });
    expect(c.json.code.expires_at).toBeGreaterThan(Date.now());

    const list = await api(env, "GET", "/join-codes");
    expect(list.json.codes.length).toBe(2); // seeded + new
    expect(JSON.stringify(list.json)).not.toContain(secret);
    expect(env.d1.q("SELECT 1 FROM join_codes WHERE code_hash = ? OR prefix = ?", secret, secret).length).toBe(0);

    expect((await joinWith(env, "laptop-1", secret)).r.status).toBe(200);
    const used = (await api(env, "GET", "/join-codes")).json.codes.find((x: any) => x.id === c.json.code.id);
    expect(used.uses).toBe(1);
    expect(used.last_used_at).toBeTruthy();

    expect((await api(env, "DELETE", `/join-codes/${c.json.code.id}`)).json.code.revoked_at).toBeTruthy();
    expect((await joinWith(env, "laptop-2", secret)).r.status).toBe(403);
  });

  it("expired codes are rejected; bad expiry is 400", async () => {
    const env = makeEnv();
    const c = await api(env, "POST", "/join-codes", { expires_in_days: 1 });
    env.d1.x("UPDATE join_codes SET expires_at = ? WHERE id = ?", Date.now() - 1, c.json.code.id);
    expect((await joinWith(env, "late", c.json.secret)).r.status).toBe(403);
    expect((await api(env, "POST", "/join-codes", { expires_in_days: 0 })).status).toBe(400);
    expect((await api(env, "POST", "/join-codes", { expires_in_days: 9999 })).status).toBe(400);
  });

  it("at most 50 active codes; expired and revoked ones do not count", async () => {
    const env = makeEnv();
    const live = env.d1.q("SELECT COUNT(*) AS n FROM join_codes WHERE revoked_at IS NULL")[0].n as number;
    for (let i = live; i < 50; i++) expect((await api(env, "POST", "/join-codes", { label: `c${i}` })).status).toBe(200);
    expect((await api(env, "POST", "/join-codes", {})).status).toBe(409);
    // one expires, another is revoked: two slots free up
    const codes = (await api(env, "GET", "/join-codes")).json.codes;
    env.d1.x("UPDATE join_codes SET expires_at = ? WHERE id = ?", Date.now() - 1, codes[0].id);
    expect((await api(env, "DELETE", `/join-codes/${codes[1].id}`)).status).toBe(200);
    expect((await api(env, "POST", "/join-codes", { label: "again" })).status).toBe(200);
    expect((await api(env, "POST", "/join-codes", { label: "again2" })).status).toBe(200);
    expect((await api(env, "POST", "/join-codes", {})).status).toBe(409);
  });

  it("join codes are admin-only and team-scoped", async () => {
    const env = makeEnv();
    const B = makeTeam(env);
    const mine = await api(env, "POST", "/join-codes", {});
    expect((await B.api("DELETE", `/join-codes/${mine.json.code.id}`)).status).toBe(404);
    expect(JSON.stringify((await B.api("GET", "/join-codes")).json)).not.toContain(mine.json.code.id);
    // an agent's signed requests never reach the web API; a manager human would need an Access identity,
    // so check the role gate via a demoted human
    env.d1.x("UPDATE members SET role = 'manager' WHERE id = ?", env.team.ownerId);
    expect((await api(env, "POST", "/join-codes", {})).status).toBe(403);
    expect((await api(env, "GET", "/join-codes")).status).toBe(403);
  });
});

describe("teams and invites", () => {
  it("/me lists every team and the current one follows the header", async () => {
    const env = makeEnv();
    const B = makeTeam(env, { ownerEmail: ADMIN_EMAIL, ownerName: "admin-b" });
    const me = await api(env, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.json.teams.map((t: any) => t.id).sort()).toEqual([env.teamId, B.team.id].sort());
    expect(me.json.team.id).toBe(env.teamId);
    const meB = await api(env, "GET", "/me", undefined, { team: B.team.id });
    expect(meB.json.team.id).toBe(B.team.id);
    expect(meB.json.role).toBe("owner");
  });

  it("team-less identities can only see /me, create (if allowed) or accept invites", async () => {
    const env = makeEnv();
    const stranger = { email: "stranger@example.com" };
    const me = await api(env, "GET", "/me", undefined, stranger);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ team: null, member: null, teams: [], can_create_team: false });
    const dash = await api(env, "GET", "/dashboard", undefined, stranger);
    expect(dash.status).toBe(403);
    expect(dash.json.error.code).toBe("no_team");
    // SIGNUP=invite (default): only platform admins may create teams
    expect((await api(env, "POST", "/teams", { name: "mine" }, stranger)).status).toBe(403);
  });

  it("SIGNUP=open lets anyone past Access create a team, capped per owner", async () => {
    const env = makeEnv({ SIGNUP: "open" });
    const who = { email: "founder@example.com" };
    const r = await api(env, "POST", "/teams", { name: "新团队" }, who);
    expect(r.status).toBe(200);
    const id = r.json.team.id;
    const me = await api(env, "GET", "/me", undefined, { ...who, team: id });
    expect(me.json).toMatchObject({ role: "owner", team: { id, name: "新团队" } });
    // new team is empty and has its notify_email set to the creator
    expect((await api(env, "GET", "/members", undefined, { ...who, team: id })).json.members.length).toBe(1);
    expect(env.d1.one<{ value: string }>("SELECT value FROM team_settings WHERE team_id = ? AND key = 'notify_email'", id)!.value).toBe(who.email);
    for (let i = 0; i < 4; i++) expect((await api(env, "POST", "/teams", { name: `t${i}` }, who)).status).toBe(200);
    expect((await api(env, "POST", "/teams", { name: "too many" }, who)).status).toBe(409);
    expect((await api(env, "POST", "/teams", { name: "  " }, { email: "x@example.com" })).status).toBe(400);
  });

  it("invite link: preview → accept → admin of that team; single use; revocable", async () => {
    const env = makeEnv();
    const inv = await api(env, "POST", "/invites", {});
    expect(inv.status).toBe(200);
    const token = (inv.json.url as string).split("/invite/")[1];
    expect(token).toMatch(/^abi_/);
    const guest = { email: "guest@example.com" };

    const pv = await api(env, "GET", `/invites/preview?token=${token}`, undefined, guest);
    expect(pv.json).toMatchObject({ team: { id: env.teamId }, valid: true, already_member: false });

    const acc = await api(env, "POST", "/invites/accept", { token }, guest);
    expect(acc.status).toBe(200);
    const me = await api(env, "GET", "/me", undefined, guest);
    expect(me.json).toMatchObject({ role: "admin", team: { id: env.teamId } });

    // used up
    const again = await api(env, "POST", "/invites/accept", { token }, { email: "other@example.com" });
    expect(again.status).toBe(410);
    // already-member accept is idempotent
    expect((await api(env, "POST", "/invites/accept", { token }, guest)).json.already_member).toBe(true);

    const inv2 = await api(env, "POST", "/invites", {});
    expect((await api(env, "DELETE", `/invites/${inv2.json.invite.id}`)).status).toBe(200);
    const t2 = (inv2.json.url as string).split("/invite/")[1];
    expect((await api(env, "POST", "/invites/accept", { token: t2 }, { email: "late@example.com" })).status).toBe(410);
    expect((await api(env, "GET", "/invites/preview?token=abi_nope", undefined, guest)).status).toBe(404);
  });

  it("emailed invites send a styled mail and never keep the token in the outbox", async () => {
    const env = makeEnv();
    const r = await api(env, "POST", "/invites", { email: "friend@example.com" });
    expect(r.status).toBe(200);
    expect(r.json.email_error).toBeNull();
    const mail = env.sent.find((m) => m.to === "friend@example.com")!;
    expect(mail).toBeTruthy();
    expect(mail.html).toContain(r.json.url);
    const token = (r.json.url as string).split("/invite/")[1];
    expect(JSON.stringify(env.d1.q("SELECT payload FROM notifications WHERE kind = 'invite'"))).not.toContain(token);
  });

  it("rename, transfer, leave, delete", async () => {
    const env = makeEnv();
    // second human via invite
    const inv = await api(env, "POST", "/invites", {});
    const guest = { email: "second@example.com" };
    await api(env, "POST", "/invites/accept", { token: (inv.json.url as string).split("/invite/")[1] }, guest);
    const second = env.d1.one<{ id: string }>("SELECT id FROM members WHERE email = ?", guest.email)!;

    expect((await api(env, "PATCH", "/team", { name: "改名了" })).json.team.name).toBe("改名了");
    expect((await api(env, "POST", "/team/leave", {})).status).toBe(403); // owner can't leave
    expect((await api(env, "POST", "/team/transfer", { member_id: second.id })).json.team.owner_id).toBe(second.id);
    expect((await api(env, "POST", "/team/leave", {})).status).toBe(200);
    expect((await api(env, "GET", "/dashboard")).status).toBe(403); // now team-less

    const ws = await api(env, "POST", "/workspaces", { name: "doomed" }, guest);
    expect(ws.status).toBe(200);
    expect((await api(env, "DELETE", "/team", { confirm: "wrong" }, guest)).status).toBe(400);
    expect((await api(env, "DELETE", "/team", { confirm: "改名了" }, guest)).status).toBe(200);
    for (const t of ["teams", "members", "workspaces", "join_codes", "team_settings"]) {
      expect(env.d1.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "teams" ? "id" : "team_id"} = ?`, env.teamId)!.n, t).toBe(0);
    }
  });

  it("deleting one team leaves the other untouched", async () => {
    const { env, B, threadA } = await twoTeams();
    expect((await B.api("DELETE", "/team", { confirm: B.team.name })).status).toBe(200);
    expect((await api(env, "GET", `/threads/${threadA}`)).status).toBe(200);
    expect(env.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM teams")!.n).toBe(1);
  });
});
