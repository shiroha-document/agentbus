// Agent-signing smoke against a deployed hub without Access credentials:
// verifies the e2e client signs exactly like the Go client (join with a team join code succeeds, state readable while pending).
import { expect, test } from "@playwright/test";
import { TestAgent } from "./agent";

const BASE = process.env.HUB_URL ?? "https://staging-hub.shiroha.tech";

test("signed join works; pending member can read state but not claim", async () => {
  const code = process.env.E2E_JOIN_CODE;
  test.skip(!code, "set E2E_JOIN_CODE=abj_… (creates a pending member in that team)");
  const a = new TestAgent(BASE, `e2e-sig-${Date.now().toString(36)}`);
  expect((await a.join(code!)).status).toBe("pending");
  const st = await a.call("GET", "/state");
  expect(st.status, JSON.stringify(st.json)).toBe(200);
  expect(st.json.member.status).toBe("pending");
  expect((await a.call("POST", "/claim", {})).status).toBe(403);
});
