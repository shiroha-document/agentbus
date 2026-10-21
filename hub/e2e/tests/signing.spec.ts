// Agent-signing smoke against a deployed hub: verifies the e2e client signs exactly like the Go
// client (join with a team join code succeeds, state readable while pending, claim refused).
// The join code comes from E2E_JOIN_CODE, or — with the Access service token configured — from a
// short-lived code created in the suite's own "e2e" team (and revoked afterwards).
import { expect, test } from "@playwright/test";
import { TestAgent } from "./agent";

const BASE = process.env.HUB_URL ?? "https://staging-hub.shiroha.tech";
const HAS_TOKEN = !!process.env.CF_ACCESS_CLIENT_ID;

test("signed join works; pending member can read state but not claim", async ({ request }) => {
  test.skip(!process.env.E2E_JOIN_CODE && !HAS_TOKEN, "set E2E_JOIN_CODE=abj_… or CF_ACCESS_CLIENT_ID/SECRET");
  let code = process.env.E2E_JOIN_CODE ?? "";
  let cleanup: (() => Promise<void>) | null = null;

  if (!code) {
    const json = { "content-type": "application/json" };
    const me = await (await request.get("/api/v1/web/me")).json();
    let team: string | undefined = me.teams?.find((t: { name: string }) => t.name === "e2e")?.id;
    if (!team) {
      const r = await request.post("/api/v1/web/teams", { data: { name: "e2e" }, headers: json });
      expect(r.status(), await r.text()).toBe(200);
      team = (await r.json()).team.id as string;
    }
    const hdr = { ...json, "X-Agentbus-Team": team };
    const jc = await request.post("/api/v1/web/join-codes", { data: { label: "e2e signing", expires_in_days: 1 }, headers: hdr });
    expect(jc.status(), await jc.text()).toBe(200);
    const body = await jc.json();
    code = body.secret;
    cleanup = async () => {
      expect((await request.delete(`/api/v1/web/join-codes/${body.code.id}`, { data: {}, headers: hdr })).status()).toBe(200);
    };
  }

  const a = new TestAgent(BASE, `e2e-sig-${Date.now().toString(36)}`);
  try {
    expect((await a.join(code)).status).toBe("pending");
    const st = await a.call("GET", "/state");
    expect(st.status, JSON.stringify(st.json)).toBe(200);
    expect(st.json.member.status).toBe("pending");
    expect((await a.call("POST", "/claim", {})).status).toBe(403);
  } finally {
    if (cleanup && a.id !== "join") {
      const hdr = { "content-type": "application/json", "X-Agentbus-Team": (await a.call("GET", "/state")).json.team.id };
      await request.post(`/api/v1/web/members/${a.id}/reject`, { data: {}, headers: hdr });
    }
    await cleanup?.();
  }
});
