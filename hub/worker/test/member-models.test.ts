import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api, makeAgent, makeEnv, makeTeam, setupJwks, workspace, type TestEnv } from "./helpers";
import { newId } from "../src/util";

const now = 1_792_990_800_000;
beforeAll(setupJwks);
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

function activity(env: TestEnv, member: string, thread: string, model: string | null, at = now, state = "running", team = env.teamId) {
  env.d1.x("INSERT INTO activity (team_id, member_id, thread_id, state, cli, model, started_at, updated_at) VALUES (?, ?, ?, ?, 'raw-cli', ?, ?, ?)",
    team, member, thread, state, model, at - 1000, at);
}
function run(env: TestEnv, member: string, model: string | null, at = now - 60_000, team = env.teamId) {
  const id = newId("r");
  env.d1.x("INSERT INTO runs (id, team_id, member_id, cli, model, started_at, ended_at, created_at) VALUES (?, ?, ?, 'run-cli', ?, ?, ?, ?)",
    id, team, member, model, at, at + 1000, now);
  return id;
}
async function reported(env: TestEnv, id: string, expected: unknown) {
  const list = await api(env, "GET", "/members");
  const detail = await api(env, "GET", `/members/${id}`);
  expect(list.status).toBe(200);
  expect(detail.status).toBe(200);
  expect(list.json.members.find((m: { id: string }) => m.id === id).reported_model).toEqual(expected);
  expect(detail.json.member.reported_model).toEqual(expected);
}

describe("member reported model provenance", () => {
  it.each(["claimed", "running", "typing"])("prefers fresh %s activity over the latest run on list and detail", async (state) => {
    const env = makeEnv(), agent = await makeAgent(env, "model-agent");
    run(env, agent.id, "previous-model");
    activity(env, agent.id, "fresh-thread", "reported-model", now - 5000, state);
    await reported(env, agent.id, { model: "reported-model", cli: "raw-cli", source: "activity", at: now - 5000 });
  });

  it("chooses the newest active model row, excluding blank models, done and failed activity", async () => {
    const env = makeEnv(), agent = await makeAgent(env, "model-agent");
    activity(env, agent.id, "old", "older-model", now - 5000);
    activity(env, agent.id, "new", "newest-model", now - 4000, "typing");
    activity(env, agent.id, "empty", "", now - 3000);
    activity(env, agent.id, "done", "done-model", now - 2000, "done");
    activity(env, agent.id, "failed", "failed-model", now - 1000, "failed");
    await reported(env, agent.id, { model: "newest-model", cli: "raw-cli", source: "activity", at: now - 4000 });
  });

  it.each([10 * 60_000 + 1, 31 * 60_000])("falls back to the latest run for activity aged %i ms", async (age) => {
    const env = makeEnv(), agent = await makeAgent(env, "model-agent");
    run(env, agent.id, "latest-run-model");
    activity(env, agent.id, "stale", "stale-model", now - age);
    await reported(env, agent.id, { model: "latest-run-model", cli: "run-cli", source: "last_run", at: now - 60_000 });
  });

  it("keeps activity at the existing ten-minute non-stale boundary", async () => {
    const env = makeEnv(), agent = await makeAgent(env, "model-agent");
    activity(env, agent.id, "boundary", "boundary-model", now - 10 * 60_000);
    await reported(env, agent.id, { model: "boundary-model", cli: "raw-cli", source: "activity", at: now - 10 * 60_000 });
  });

  it("uses the existing latest run by start time and keeps old run models historical", async () => {
    const env = makeEnv(), agent = await makeAgent(env, "model-agent");
    run(env, agent.id, "latest", now - 60_000);
    run(env, agent.id, "older", now - 120_000);
    await reported(env, agent.id, { model: "latest", cli: "run-cli", source: "last_run", at: now - 60_000 });
    run(env, agent.id, null, now - 1000);
    await reported(env, agent.id, null);
  });

  it("returns no reported model when a member has no model data", async () => {
    const env = makeEnv(), agent = await makeAgent(env, "manual-agent", { join: { cli: "manual" } });
    activity(env, agent.id, "absent", null);
    await reported(env, agent.id, null);
  });

  it("reflects a model switch without replacing a historical post model", async () => {
    const env = makeEnv(), agent = await makeAgent(env, "model-agent"), ws = await workspace(env);
    const post = await agent.post({ workspace_id: ws, title: "Models", body: "Historical reply", model: "historical-model" });
    const tid = post.json.post.thread_id;
    expect((await agent.call("POST", "/activity", { thread_id: tid, state: "running", cli: "raw-cli", model: "first-model" })).status).toBe(200);
    await reported(env, agent.id, { model: "first-model", cli: "raw-cli", source: "activity", at: now });
    expect((await agent.call("POST", "/activity", { thread_id: tid, state: "typing", model: "switched-model" })).status).toBe(200);
    await reported(env, agent.id, { model: "switched-model", cli: "raw-cli", source: "activity", at: now });
    expect((await api(env, "GET", `/threads/${tid}`)).json.posts[0].model).toBe("historical-model");
  });

  it("excludes foreign-team activity/runs and human model data", async () => {
    const env = makeEnv(), agent = await makeAgent(env, "local-agent"), other = makeTeam(env);
    const foreign = await other.agent("foreign-agent");
    activity(env, foreign.id, "foreign", "foreign-model", now, "running", other.team.id);
    // Even inconsistent rows carrying a local id cannot escape the explicit team scope.
    activity(env, agent.id, "foreign-local-id", "foreign-model", now, "running", other.team.id);
    run(env, agent.id, "foreign-run-model", now, other.team.id);
    activity(env, env.team.ownerId, "human", "human-model");
    run(env, env.team.ownerId, "human-run-model");
    await reported(env, agent.id, null);
    await reported(env, env.team.ownerId, null);
    const list = await api(env, "GET", "/members");
    expect(JSON.stringify(list.json)).not.toContain("foreign-model");
    expect(list.json.members.map((m: { id: string }) => m.id)).not.toContain(foreign.id);
    expect((await api(env, "GET", `/members/${foreign.id}`)).status).toBe(404);
  });
});
