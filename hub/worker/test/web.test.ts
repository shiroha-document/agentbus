import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { snippet } from "../src/routes/web";
import { newId } from "../src/util";
import { flushNotifications } from "../src/notify";
import { callTriggers, checkOffline, checkUnresponsive, cleanup, runWatchdog, setTriggerFetch } from "../src/watchdog";
import { api, makeAgent, makeEnv, setupJwks, workspace } from "./helpers";

beforeAll(setupJwks);

describe("email change flow", () => {
  it("sends confirm mail, confirms via token, scrubs payload", async () => {
    const env = makeEnv();
    const r = await api(env, "POST", "/settings/email", { email: "New@Example.org" });
    expect(r.status).toBe(200);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].to).toBe("new@example.org");
    const m = env.sent[0].text.match(/token=([A-Za-z0-9_%-]+)/);
    expect(m).toBeTruthy();
    const payload = env.d1.one<{ payload: string }>("SELECT payload FROM notifications WHERE kind = 'email_change'")!.payload;
    expect(payload).not.toContain("token=");

    const bad = await api(env, "GET", "/settings/email/confirm?token=nope");
    expect(bad.status).toBe(302);
    expect(bad.res.headers.get("location")).toBe("/settings?email=invalid");

    const ok = await api(env, "GET", `/settings/email/confirm?token=${m![1]}`);
    expect(ok.status).toBe(302);
    expect(ok.res.headers.get("location")).toBe(`/settings?email=ok&team=${env.teamId}`);
    expect(env.d1.one<{ value: string }>("SELECT value FROM team_settings WHERE team_id = ? AND key = 'notify_email'", env.teamId)!.value).toBe("new@example.org");
    // token is single-use
    const again = await api(env, "GET", `/settings/email/confirm?token=${m![1]}`);
    expect(again.res.headers.get("location")).toBe("/settings?email=invalid");
  });

  it("rejects bad addresses and reports send failure", async () => {
    const env = makeEnv();
    expect((await api(env, "POST", "/settings/email", { email: "not-an-email" })).status).toBe(400);
    env.failMail = true;
    const r = await api(env, "POST", "/settings/email", { email: "a@b.co" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/mail down/);
  });

  it("notify test mail goes to notify_email", async () => {
    const env = makeEnv();
    expect((await api(env, "POST", "/notify/test", {})).status).toBe(400);
    env.d1.x("INSERT INTO team_settings (team_id, key, value) VALUES (?, 'notify_email', 'me@example.org')", env.teamId);
    const r = await api(env, "POST", "/notify/test", {});
    expect(r.status).toBe(200);
    expect(env.sent.at(-1)!.to).toBe("me@example.org");
  });
});

describe("notifications", () => {
  it("merges per kind and honours merge window + disabled kinds", async () => {
    const env = makeEnv();
    env.d1.x("INSERT INTO team_settings (team_id, key, value) VALUES (?, 'notify_email', 'me@example.org')", env.teamId);
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    await makeAgent(env, "bob");
    await makeAgent(env, "carol");
    const now = Date.now();
    await flushNotifications(env, { now });
    // three join_request notifications → one email
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].subject).toContain("3 条");
    expect(env.sent[0].html).not.toContain("<script");

    await makeAgent(env, "dave");
    await flushNotifications(env, { now: now + 60_000 });
    expect(env.sent).toHaveLength(1); // within 15-minute window
    await flushNotifications(env, { now: now + 16 * 60_000 });
    expect(env.sent).toHaveLength(2);

    env.d1.x("UPDATE team_settings SET value = '{\"confirm_request\":false}' WHERE team_id = ? AND key = 'notify_kinds'", env.teamId);
    await a.post({ workspace_id: ws, title: "t", body: "ok?", kind: "confirm" });
    await flushNotifications(env, { now: now + 40 * 60_000 });
    expect(env.sent).toHaveLength(2);
    expect(env.d1.one<{ error: string }>("SELECT error FROM notifications WHERE kind = 'confirm_request'")!.error).toBe("disabled");
  });

  it("confirmation decide posts a system reply and delivers to requester", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    const p = await a.post({ workspace_id: ws, title: "t", body: "deploy?", kind: "confirm" });
    const c = env.d1.one<{ id: string }>("SELECT id FROM confirmations")!;
    const r = await api(env, "POST", `/confirmations/${c.id}`, { decision: "approve", note: "go" });
    expect(r.status).toBe(200);
    expect(r.json.confirmation.status).toBe("approved");
    expect((await api(env, "POST", `/confirmations/${c.id}`, { decision: "reject" })).status).toBe(409);
    expect(env.d1.one<{ reason: string }>("SELECT reason FROM deliveries WHERE member_id = ?", a.id)!.reason).toBe("mention");
    expect(p.status).toBe(200);
  });
});

describe("search", () => {
  it("newId is monotonic within a millisecond", () => {
    const ids = Array.from({ length: 500 }, () => newId("p", 1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
  });
  it("snippet escapes HTML and marks matches", () => {
    expect(snippet("a <b>hello</b> world", "hello")).toBe("a &lt;b&gt;<mark>hello</mark>&lt;/b&gt; world");
    expect(snippet("Foo foo FOO", "foo")).toBe("<mark>Foo</mark> <mark>foo</mark> <mark>FOO</mark>");
    const long = "x".repeat(200) + "needle" + "y".repeat(200);
    const s = snippet(long, "needle");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("<mark>needle</mark>");
  });

  it("finds posts by body and title; LIKE wildcards are literal", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    await a.post({ workspace_id: ws, title: "Deploy pipeline", body: "first post" });
    await a.post({ workspace_id: ws, title: "other", body: "100% done with migration" });
    await a.post({ workspace_id: ws, title: "third", body: "100 x done" });
    const byTitle = await api(env, "GET", "/search?q=pipeline");
    expect(byTitle.json.results).toHaveLength(1);
    expect(byTitle.json.results[0].snippet).toContain("<mark>pipeline</mark>");
    const pct = await api(env, "GET", `/search?q=${encodeURIComponent("100%")}`);
    expect(pct.json.results).toHaveLength(1);
    expect(pct.json.results[0].post.body).toContain("100% done");
    expect((await api(env, "GET", "/search?q=")).json.results).toEqual([]);
    expect((await api(env, "GET", "/search?q=done&member=alice")).json.results).toHaveLength(2);
  });
});

describe("web API smoke", () => {
  it("dashboard, members, threads, workspace detail, usage, runs, audit, settings", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const a = await makeAgent(env, "alice");
    const t = await api(env, "POST", "/threads", { workspace_id: ws, title: "human thread", body: "@alice go", assignee: "alice" });
    expect(t.status).toBe(200);
    const runs = await a.call("POST", "/runs", {
      runs: [{ id: "r_" + "0".repeat(26), started_at: Date.now() - 1000, ended_at: Date.now(), exit_code: 0, input: 10, output: 5, cost_usd_est: 0.01 }],
    });
    expect(runs.json.accepted).toBe(1);
    for (const p of ["/dashboard", "/members", `/members/${a.id}`, "/threads", `/threads/${t.json.thread.id}`, `/workspaces/${ws}`, "/workspaces", "/usage", "/runs", "/audit", "/settings", "/feed", "/changes"]) {
      const r = await api(env, "GET", p);
      expect(r.status, p).toBe(200);
    }
    const post = await api(env, "POST", "/posts", { thread_id: t.json.thread.id, body: "follow up" });
    expect(post.status).toBe(200);
    const re = await api(env, "POST", `/posts/${post.json.post.id}/reactions`, { emoji: "👍" });
    expect(re.status).toBe(200);
    expect(re.json.reactions.length).toBe(1);
    const role = await api(env, "PATCH", `/members/${a.id}`, { role: "manager" });
    expect(role.json.member.role).toBe("manager");
    expect((await api(env, "DELETE", `/members/${a.id}`)).status).toBeLessThan(500);
  });
});

describe("watchdog", () => {
  afterEach(() => setTriggerFetch((u, i) => fetch(u, i)));

  it("offline once until seen again", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    env.d1.x("UPDATE members SET last_seen_at = ? WHERE id = ?", Date.now() - 3600_000, a.id);
    expect(await checkOffline(env, Date.now())).toBe(1);
    expect(await checkOffline(env, Date.now())).toBe(0);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'agent_offline'")).toHaveLength(1);
    await a.call("GET", "/state");
    expect(env.d1.one<{ offline_notified: number }>("SELECT offline_notified FROM members WHERE id = ?", a.id)!.offline_notified).toBe(0);
  });

  it("unresponsive mention → system post @owner + notification, once", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    await api(env, "GET", "/me"); // create admin human
    const a = await makeAgent(env, "alice");
    const b = await makeAgent(env, "bob", { join: { owner: "Admin@Example.com" } });
    const tid = (await a.post({ workspace_id: ws, title: "t", body: "@bob" })).json.thread.id;
    env.d1.x("UPDATE deliveries SET created_at = ? WHERE member_id = ?", Date.now() - 3600_000, b.id);
    expect(await checkUnresponsive(env, Date.now())).toBe(1);
    expect(await checkUnresponsive(env, Date.now())).toBe(0);
    const sys = env.d1.one<{ body: string }>("SELECT body FROM posts WHERE thread_id = ? AND kind = 'system'", tid)!;
    expect(sys.body).toMatch(/^@admin-user /);
    expect(env.d1.q("SELECT * FROM notifications WHERE kind = 'agent_unresponsive'")).toHaveLength(1);
    // bob should not be re-mentioned by the system post
    expect(env.d1.q("SELECT * FROM deliveries WHERE member_id = ?", b.id)).toHaveLength(1);
  });

  it("calls trigger URLs at most once a minute", async () => {
    const env = makeEnv();
    const ws = await workspace(env);
    const calls: { url: string; body: string }[] = [];
    setTriggerFetch(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response("ok");
    });
    const a = await makeAgent(env, "alice");
    await makeAgent(env, "trig", { join: { wake_mode: "trigger", trigger_url: "https://example.com/hook?k=s3cret" } });
    expect(env.d1.one<{ url_ciphertext: string }>("SELECT url_ciphertext FROM triggers")!.url_ciphertext).not.toContain("example");
    const now = Date.now();
    expect(await callTriggers(env, now)).toBe(0); // nothing pending
    await a.post({ workspace_id: ws, title: "t", body: "@trig" });
    expect(await callTriggers(env, now)).toBe(1);
    expect(calls[0].url).toBe("https://example.com/hook?k=s3cret");
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: "wake", member: "trig" });
    expect(await callTriggers(env, now + 30_000)).toBe(0);
    expect(await callTriggers(env, now + 61_000)).toBe(1);
  });

  it("join with trigger mode requires https url", async () => {
    const env = makeEnv();
    await expect(makeAgent(env, "t1", { join: { wake_mode: "trigger" } })).rejects.toThrow(/400/);
    await expect(makeAgent(env, "t2", { join: { wake_mode: "trigger", trigger_url: "http://x" } })).rejects.toThrow(/400/);
  });

  it("cleanup removes expired rows; runWatchdog survives step errors", async () => {
    const env = makeEnv();
    env.d1.x("INSERT INTO nonces (member_id, nonce, expires_at) VALUES ('m', 'n', 1)");
    env.d1.x("INSERT INTO email_changes (token_hash, new_email, expires_at) VALUES ('h', 'x@y.z', 1)");
    await cleanup(env, Date.now());
    expect(env.d1.q("SELECT * FROM nonces")).toHaveLength(0);
    expect(env.d1.q("SELECT * FROM email_changes")).toHaveLength(0);
    const errors = await runWatchdog(env);
    expect(errors).toEqual({});
    const broken = makeEnv();
    broken.d1.db.exec("DROP TABLE triggers");
    const e2 = await runWatchdog(broken);
    expect(Object.keys(e2)).toEqual(["triggers"]);
  });
});

describe("email health", () => {
  it("flags failed deliveries with a hint and clears after a success", async () => {
    const env = makeEnv();
    env.d1.x("INSERT INTO team_settings (team_id, key, value) VALUES (?, 'notify_email', 'me@example.org')", env.teamId);
    let s = await api(env, "GET", "/settings");
    expect(s.json.email_health.ok).toBe(true);

    await makeAgent(env, "alice");
    env.failMail = true;
    (env.EMAIL as unknown as { send: (m: unknown) => Promise<unknown> }).send = async () => {
      throw Object.assign(new Error("destination address is not a verified address"), { code: "E_RECIPIENT_NOT_ALLOWED" });
    };
    // A minute in the past: the sandbox wall clock can step back a few ms.
    const now = Date.now() - 60_000;
    await flushNotifications(env, { now });
    s = await api(env, "GET", "/settings");
    expect(s.json.email_health.ok).toBe(false);
    expect(s.json.email_health.failed_count).toBe(1);
    expect(s.json.email_health.last_error).toMatch(/E_RECIPIENT_NOT_ALLOWED/);
    expect(s.json.email_health.hint).toMatch(/Email Routing/);
    const d = await api(env, "GET", "/dashboard");
    expect(d.json.email_health.ok).toBe(false);

    const sent: string[] = [];
    (env.EMAIL as unknown as { send: (m: { to: string }) => Promise<unknown> }).send = async (m) => {
      sent.push(m.to);
      return { messageId: "y" };
    };
    expect((await api(env, "POST", "/notify/test", {})).status).toBe(200);
    expect(sent).toHaveLength(1);
    s = await api(env, "GET", "/settings");
    expect(s.json.email_health.ok).toBe(true);
    expect(s.json.email_health.hint).toBeNull();
  });

  it("disabled kinds and missing address are not confused", async () => {
    const env = makeEnv();
    await makeAgent(env, "alice");
    await flushNotifications(env);
    const s = await api(env, "GET", "/settings");
    expect(s.json.email_health.ok).toBe(false);
    expect(s.json.email_health.hint).toMatch(/通知邮箱/);
  });
});
