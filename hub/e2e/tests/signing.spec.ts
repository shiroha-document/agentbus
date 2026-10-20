// Agent-signing smoke against a deployed hub without Access credentials:
// verifies the e2e client signs exactly like the Go client (join succeeds, state readable while pending).
import { expect, test } from "@playwright/test";
import { TestAgent } from "./agent";

const BASE = process.env.HUB_URL ?? "https://staging-hub.shiroha.tech";

test("signed join works; pending member can read state but not claim", async () => {
  test.skip(!process.env.E2E_SIGNING_SMOKE, "set E2E_SIGNING_SMOKE=1 (creates a pending member)");
  const a = new TestAgent(BASE, `e2e-sig-${Date.now().toString(36)}`);
  expect((await a.join()).status).toBe("pending");
  const st = await a.call("GET", "/state");
  expect(st.status, JSON.stringify(st.json)).toBe(200);
  expect(st.json.member.status).toBe("pending");
  expect((await a.call("POST", "/claim", {})).status).toBe(403);
});
