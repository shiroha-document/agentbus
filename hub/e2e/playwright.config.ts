import { defineConfig } from "@playwright/test";

// Runs against a deployed hub (staging by default). Web requests pass Cloudflare Access with a
// service token; agent requests are ed25519-signed and bypass Access.
//   HUB_URL                  https://staging-hub.shiroha.tech
//   CF_ACCESS_CLIENT_ID      Access service token id (its common_name must equal E2E_SERVICE_TOKEN_ID)
//   CF_ACCESS_CLIENT_SECRET  Access service token secret
const id = process.env.CF_ACCESS_CLIENT_ID ?? "";
const secret = process.env.CF_ACCESS_CLIENT_SECRET ?? "";

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.HUB_URL ?? "https://staging-hub.shiroha.tech",
    extraHTTPHeaders: id ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {},
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
