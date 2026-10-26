import { beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/util";
import { api, makeAgent, makeEnv, makeTeam, setupJwks, workspace } from "./helpers";

beforeAll(setupJwks);

async function history(count = 105) {
  const env = makeEnv();
  const ws = await workspace(env);
  const recipient = await makeAgent(env, "recipient");
  const thread = await api(env, "POST", "/threads", { workspace_id: ws, title: "History", body: "Start" });
  const tid = thread.json.thread.id as string;
  const base = Date.now() - 3600_000;
  const ids = Array.from({ length: count }, (_, i) => newId("p", base + i));
  ids.forEach((id, i) => {
    env.d1.x("INSERT INTO posts (id, team_id, thread_id, author_id, body, created_at) VALUES (?, ?, ?, ?, 'History', ?)", id, env.teamId, tid, env.team.ownerId, base + i);
    env.d1.x("INSERT INTO deliveries (id, team_id, thread_id, post_id, member_id, reason, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'mention', 'pending', ?, ?)", newId("d"), env.teamId, tid, id, recipient.id, base + i, base + i);
  });
  return { env, tid, ids, recipient, newest: thread.json.post.id as string };
}

describe("history delivery receipt batches", () => {
  it("returns exactly the requested 100 historical posts", async () => {
    const { env, tid, ids } = await history();
    const r = await api(env, "GET", `/threads/${tid}/live?post_ids=${ids.slice(0, 100).join(",")}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.receipts).sort()).toEqual(ids.slice(0, 100).sort());
    expect(r.res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves a 100-post batch within D1's 100 SQL bind parameter limit", async () => {
    const { env, tid, ids } = await history(100);
    const prepare = env.d1.prepare.bind(env.d1);
    env.d1.prepare = (sql) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        if (args.length > 100) throw new Error("Too many SQL variables: D1 supports 100 bound parameters");
        return bind(...args);
      };
      return statement;
    };
    const r = await api(env, "GET", `/threads/${tid}/live?post_ids=${ids.join(",")}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.receipts)).toHaveLength(100);
  });

  it("rejects more than 100 IDs before deduplication", async () => {
    const { env, tid, ids } = await history(1);
    const r = await api(env, "GET", `/threads/${tid}/live?post_ids=${Array(101).fill(ids[0]).join(",")}`);
    expect(r.status).toBe(400);
  });

  it("rejects empty, malformed, and repeated batch parameters", async () => {
    const { env, tid, ids } = await history(1);
    for (const query of ["post_ids=", "post_ids=p_one,", "post_ids=bad%20id", `post_ids=${ids[0]}&post_ids=${ids[0]}`]) {
      expect((await api(env, "GET", `/threads/${tid}/live?${query}`)).status).toBe(400);
    }
  });

  it("keeps the most recent 30 delivery posts without a batch parameter", async () => {
    const { env, tid, ids, newest } = await history();
    const r = await api(env, "GET", `/threads/${tid}/live`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.receipts).sort()).toEqual(ids.slice(-30).sort());
    expect(r.json.next_post_id).toBe(newest);
  });

  it("scopes both delivery and post records to the authorized team and thread", async () => {
    const { env, tid, ids } = await history(2);
    const ws = await workspace(env, "Another workspace");
    const otherThread = await api(env, "POST", "/threads", { workspace_id: ws, title: "Other", body: "@recipient Other" });
    const foreign = makeTeam(env);
    const foreignRecipient = await foreign.agent("foreign");
    const foreignPost = await foreign.api("POST", "/threads", { workspace_id: await foreign.workspace(), title: "Private", body: "@foreign Private" });
    // Even inconsistent delivery rows must not expose a post from another scope.
    for (const pid of [otherThread.json.post.id, foreignPost.json.post.id]) {
      env.d1.x("INSERT INTO deliveries (id, team_id, thread_id, post_id, member_id, reason, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'mention', 'done', 1, 1)", newId("d"), env.teamId, tid, pid, env.team.ownerId);
    }
    const batch = [ids[0], otherThread.json.post.id, foreignPost.json.post.id, "p_unknown"];
    const r = await api(env, "GET", `/threads/${tid}/live?post_ids=${batch.join(",")}`);
    expect(Object.keys(r.json.receipts)).toEqual([ids[0]]);
    expect(JSON.stringify(r.json)).not.toContain(foreignRecipient.id);
    expect((await api(env, "GET", `/threads/${foreignPost.json.thread.id}/live?post_ids=${foreignPost.json.post.id}`)).status).toBe(404);
  });

  it("returns all five states to a member who did not author the post, with activity intact", async () => {
    const { env, tid, ids, newest } = await history(1);
    env.d1.x("DELETE FROM deliveries WHERE post_id = ?", ids[0]);
    const expected = ["sent", "received", "working", "handled", "failed"];
    const members = [];
    for (const [i, state] of ["pending", "leased", "leased", "done", "dead"].entries()) {
      const member = await makeAgent(env, `recipient${i}`);
      members.push(member.id);
      env.d1.x("INSERT INTO deliveries (id, team_id, thread_id, post_id, member_id, reason, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'mention', ?, ?, ?)", newId("d"), env.teamId, tid, ids[0], member.id, state, i, 10 + i);
    }
    const now = Date.now();
    env.d1.x("INSERT INTO activity (team_id, thread_id, member_id, state, started_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)", env.teamId, tid, members[2]!, now, now);
    env.d1.x("INSERT INTO activity (team_id, thread_id, member_id, state, detail, started_at, updated_at) VALUES (?, ?, ?, 'claimed', 'stale warning', ?, ?)", env.teamId, tid, members[1]!, now - 11 * 60_000, now - 11 * 60_000);
    env.d1.x("INSERT INTO members (id, team_id, kind, role, name, display_name, email, status, created_at) VALUES ('m_viewer', ?, 'human', 'member', 'viewer', 'Viewer', 'viewer@example.test', 'active', ?)", env.teamId, now);
    const r = await api(env, "GET", `/threads/${tid}/live?post_ids=${ids[0]},${newest}`, undefined, { email: "viewer@example.test" });
    expect(r.status).toBe(200);
    expect(r.json.receipts[ids[0]!].map((receipt: { state: string }) => receipt.state)).toEqual(expected);
    expect(r.json.receipts[ids[0]!].map((receipt: { at: number }) => receipt.at)).toEqual([10, 11, 12, 13, 14]);
    expect(r.json.receipts[newest]).toBeUndefined();
    expect(r.json.activity).toEqual(expect.arrayContaining([expect.objectContaining({ state: "running", stale: false }), expect.objectContaining({ detail: "stale warning", stale: true })]));
    expect(r.json.next_post_id).toBe(newest);
  });
});
