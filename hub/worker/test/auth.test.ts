import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/index";
import { signingString, verifyEd25519 } from "../src/auth";
import { sha256Hex } from "../src/util";
import { Agent, api, jwt, makeAgent, makeEnv, newKey, setupJwks, signedRequest, web, workspace } from "./helpers";

const vec = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testdata", "sig-vector.json"), "utf8"));

beforeAll(setupJwks);

describe("signature vector", () => {
  it("matches the shared test vector", async () => {
    expect(await sha256Hex(vec.body)).toBe(vec.body_sha256_hex);
    const s = signingString(vec.method, vec.path_with_query, vec.timestamp, vec.nonce, vec.body_sha256_hex);
    expect(s).toBe(vec.signing_string);
    expect(await verifyEd25519(vec.public_key_b64, s, vec.signature_b64)).toBe(true);
    expect(await verifyEd25519(vec.public_key_b64, s + "x", vec.signature_b64)).toBe(false);
  });
});

describe("agent auth", () => {
  it("rejects old clients with 426", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    const r = await a.call("GET", "/state", undefined, { version: "0.3.1" });
    expect(r.status).toBe(426);
    expect(r.json.error.code).toBe("client_too_old");
  });

  it("rejects clock skew, bad signature, tampered body, replay", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    expect((await a.call("GET", "/state", undefined, { ts: Math.floor(Date.now() / 1000) - 400 })).status).toBe(401);

    const other = await newKey();
    const forged = new Agent(env, "alice", other);
    forged.id = a.id;
    expect((await forged.call("GET", "/state")).status).toBe(401);

    const ws = await workspace(env);
    const t = await a.call("POST", "/posts", { workspace_id: ws, title: "x", body: "hi", idempotency_key: "k1" }, { tamper: true });
    expect(t.status).toBe(401);

    const nonce = "fixed-nonce-0123456789";
    expect((await a.call("GET", "/state", undefined, { nonce })).status).toBe(200);
    const again = await a.call("GET", "/state", undefined, { nonce });
    expect(again.status).toBe(401);
    expect(again.json.error.message).toMatch(/nonce/);
  });

  it("rejects short nonces and missing headers", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    expect((await a.call("GET", "/state", undefined, { nonce: "short" })).status).toBe(401);
    const res = await app.request("https://hub.test/api/v1/agent/state", { headers: { "x-agentbus-version": "0.5.0" } }, env);
    expect(res.status).toBe(401);
  });

  it("join → pending may only read state; duplicate key returns same member", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "bob", { approve: false });
    const st = await a.call("GET", "/state");
    expect(st.status).toBe(200);
    expect(st.json.member.status).toBe("pending");
    expect((await a.call("POST", "/claim", {})).status).toBe(403);

    const again = await a.call("POST", "/join", { name: "bob2", cli: "claude", public_key: a.key.publicB64 }, { member: "join" });
    expect(again.status).toBe(200);
    expect(again.json.member_id).toBe(a.id);

    // join notification queued
    expect(env.d1.one<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'join_request'")!.n).toBe(1);
  });

  it("join validates name and key signature", async () => {
    const env = makeEnv();
    const k = await newKey();
    const k2 = await newKey();
    const bad = await signedRequest(k, "join", "POST", "/api/v1/agent/join", { name: "x1", cli: "c", public_key: k2.publicB64 });
    expect((await app.request(bad, undefined, env)).status).toBe(401);
    const a = new Agent(env, "all", k);
    const r = await a.call("POST", "/join", { join_code: env.joinCode, name: "all", cli: "claude", public_key: k.publicB64 });
    expect(r.status).toBe(400);
    await makeAgent(env, "dup");
    const b = new Agent(env, "dup", await newKey());
    const r2 = await b.call("POST", "/join", { join_code: env.joinCode, name: "dup", cli: "claude", public_key: b.key.publicB64 });
    expect(r2.status).toBe(409);
  });

  it("revoked members are rejected", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    expect((await api(env, "POST", `/members/${a.id}/revoke`, {})).status).toBe(200);
    expect((await a.call("GET", "/state")).status).toBe(401);
  });

  it("key rotation keeps old key valid for a day", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    const nk = await newKey();
    expect((await a.call("POST", "/keys/rotate", { new_public_key: nk.publicB64 })).status).toBe(200);
    expect((await a.call("GET", "/state")).status).toBe(200);
    const b = new Agent(env, "alice", nk);
    b.id = a.id;
    expect((await b.call("GET", "/state")).status).toBe(200);
  });

  it("unknown agent path is a JSON 404", async () => {
    const env = makeEnv();
    const a = await makeAgent(env, "alice");
    const r = await a.call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });
});

describe("web auth (fail closed)", () => {
  it("no token → 401 text for pages, JSON for API", async () => {
    const env = makeEnv();
    const page = await web(env, "GET", "/", undefined, { token: null });
    expect(page.status).toBe(401);
    expect(page.res.headers.get("content-type")).toMatch(/text\/plain/);
    const a = await api(env, "GET", "/me", undefined, { token: null });
    expect(a.status).toBe(401);
    expect(a.json.error.code).toBe("unauthorized");
  });

  it("rejects wrong aud / iss / expired / unconfigured service token / bad alg", async () => {
    const env = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      await jwt({ email: "admin@example.com", aud: ["other"] }),
      await jwt({ email: "admin@example.com", iss: "https://evil.cloudflareaccess.com" }),
      await jwt({ email: "admin@example.com", exp: now - 120 }),
      await jwt({ common_name: "svc" }),
      await jwt({ email: "admin@example.com" }, { kid: "unknown" }),
      "a.b.c",
    ];
    for (const token of cases) expect((await api(env, "GET", "/me", undefined, { token })).status).toBe(401);
    // Any Access email is accepted; without a team it only sees the welcome state.
    const other = await api(env, "GET", "/me", undefined, { email: "someone@example.com" });
    expect(other.status).toBe(200);
    expect(other.json.team).toBeNull();
    expect(other.json.teams).toEqual([]);
  });

  it("missing ACCESS config rejects everything", async () => {
    const env = makeEnv({ ACCESS_AUD: undefined });
    expect((await api(env, "GET", "/me")).status).toBe(401);
    expect((await web(env, "GET", "/")).status).toBe(401);
  });

  it("admin login sees its team as owner; service token works only when configured", async () => {
    const env = makeEnv({ E2E_SERVICE_TOKEN_ID: "svc-id" });
    const me = await api(env, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.json.member.role).toBe("owner");
    expect(me.json.role).toBe("owner");
    expect(me.json.identity.platform_admin).toBe(true);
    expect(me.json.member.name).toBe("admin-user"); // "admin" is reserved
    const svc = await api(env, "GET", "/me", undefined, { token: await jwt({ common_name: "svc-id" }) });
    expect(svc.status).toBe(200);
    expect(svc.json.team).toBeNull(); // service identity has no team until it creates one
    const created = await api(env, "POST", "/teams", { name: "e2e" }, { token: await jwt({ common_name: "svc-id" }) });
    expect(created.status).toBe(403); // not a platform admin under SIGNUP=invite
    const env2 = makeEnv({ E2E_SERVICE_TOKEN_ID: "svc-id", SIGNUP: "open" });
    const svcTok = await jwt({ common_name: "svc-id" });
    expect((await api(env2, "POST", "/teams", { name: "e2e" }, { token: svcTok })).status).toBe(200);
    const svc2 = await api(env2, "GET", "/me", undefined, { token: svcTok });
    expect(svc2.json.member.name).toBe("e2e");
    expect(svc2.json.identity.email).toMatch(/@agentbus\.invalid$/);
  });

  it("writes need application/json", async () => {
    const env = makeEnv();
    const r = await api(env, "POST", "/workspaces", { name: "x" }, { ct: "text/plain" });
    expect(r.status).toBe(415);
  });

  it("security headers + SPA fallback + healthz", async () => {
    const env = makeEnv();
    const page = await web(env, "GET", "/threads/abc");
    expect(page.status).toBe(200);
    expect(page.json).toContain("asset /threads/abc");
    const h = page.res.headers;
    expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("cache-control")).toBe("no-cache");
    const asset = await web(env, "GET", "/assets/app.js");
    expect(asset.res.headers.get("cache-control")).toContain("immutable");
    expect((await web(env, "POST", "/x", {})).status).toBe(405);
    const me = await api(env, "GET", "/me");
    expect(me.res.headers.get("cache-control")).toBe("no-store");
    const hz = await web(env, "GET", "/healthz", undefined, { token: null });
    expect(hz.status).toBe(200);
    expect(hz.json.version).toBe("0.5.0");
  });
});
