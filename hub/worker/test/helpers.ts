// Test harness: D1 over node:sqlite, signed agent requests, Access JWTs.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { setJwksFetcher, signingString } from "../src/auth";
import { b64encode, newId, secretToken, sha256Hex } from "../src/util";

export const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
export const CLIENT_VERSION = "0.5.0";

type Val = string | number | null | bigint | Uint8Array;

class FakeStmt {
  private args: Val[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...args: unknown[]) {
    const s = new FakeStmt(this.db, this.sql);
    s.args = args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : (a as Val)));
    return s;
  }
  private prep(): StatementSync {
    return this.db.prepare(this.sql);
  }
  private returnsRows() {
    return /^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
  }
  async all<T>() {
    return this.exec<T>();
  }
  exec<T>() {
    if (this.returnsRows()) {
      const rows = this.prep().all(...(this.args as never[])) as T[];
      return { results: rows.map((r) => ({ ...(r as object) }) as T), success: true, meta: { changes: 0 } };
    }
    const r = this.prep().run(...(this.args as never[]));
    return { results: [] as T[], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T>(col?: string) {
    const row = this.prep().get(...(this.args as never[])) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async run() {
    return this.exec();
  }
  async raw() {
    return this.prep()
      .all(...(this.args as never[]))
      .map((r) => Object.values(r as object));
  }
}

export class FakeD1 {
  readonly db = new DatabaseSync(":memory:");
  /** `upTo`: apply only migrations whose file name sorts <= this prefix (e.g. "0001"). */
  constructor(o: { upTo?: string } = {}) {
    for (const f of migrationFiles()) {
      if (o.upTo && f.slice(0, o.upTo.length) > o.upTo) continue;
      this.applyMigration(f);
    }
  }
  applyMigration(file: string) {
    this.db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  prepare(sql: string) {
    return new FakeStmt(this.db, sql);
  }
  async batch(stmts: FakeStmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.exec());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
  /** Synchronous helpers for assertions. */
  q<T = Record<string, unknown>>(sql: string, ...args: Val[]): T[] {
    return this.db.prepare(sql).all(...(args as never[])) as T[];
  }
  one<T = Record<string, unknown>>(sql: string, ...args: Val[]): T | undefined {
    return this.db.prepare(sql).get(...(args as never[])) as T | undefined;
  }
  x(sql: string, ...args: Val[]) {
    return this.db.prepare(sql).run(...(args as never[]));
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql"))
    .sort();
}

export const sha256Sync = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const ADMIN_EMAIL = "admin@example.com";
export const AUD = "aud-test";
export const TEAM = "unit";

export interface SeededTeam {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
  /** Plain join code (abj_…) for this team. */
  joinCode: string;
}

/**
 * Seed a team directly in the DB: owner (human, role owner), default
 * team_settings (no notify_email unless given) and one join code.
 */
export function seedTeam(d1: FakeD1, o: { name?: string; ownerEmail?: string; ownerName?: string; notifyEmail?: string | null } = {}): SeededTeam {
  const now = Date.now();
  const id = newId("o", now);
  const ownerId = newId("m", now);
  const ownerEmail = o.ownerEmail ?? ADMIN_EMAIL;
  const name = o.name ?? "测试团队";
  d1.x("INSERT INTO teams (id, name, owner_id, change_seq, created_at) VALUES (?, ?, ?, 1, ?)", id, name, ownerId, now);
  d1.x(
    "INSERT INTO members (id, team_id, kind, role, name, display_name, email, status, created_at) VALUES (?, ?, 'human', 'owner', ?, ?, ?, 'active', ?)",
    ownerId,
    id,
    o.ownerName ?? "admin-user",
    ownerEmail.split("@")[0],
    ownerEmail,
    now,
  );
  const settings: [string, string][] = [
    ["notify_kinds", "{}"],
    ["global_pause", "0"],
    ["default_pause_pct", "100"],
    ["merge_window_min", "15"],
  ];
  if (o.notifyEmail) settings.push(["notify_email", o.notifyEmail]);
  for (const [k, v] of settings) d1.x("INSERT INTO team_settings (team_id, key, value) VALUES (?, ?, ?)", id, k, v);
  const joinCode = secretToken("abj_");
  d1.x(
    "INSERT INTO join_codes (id, team_id, label, code_hash, prefix, created_by, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?)",
    newId("j", now),
    id,
    sha256Sync(joinCode),
    joinCode.slice(0, 8),
    ownerId,
    now,
  );
  return { id, name, ownerId, ownerEmail, joinCode };
}

export function setTeamSetting(env: { d1: FakeD1 }, teamId: string, key: string, value: string) {
  env.d1.x("INSERT OR REPLACE INTO team_settings (team_id, key, value) VALUES (?, ?, ?)", teamId, key, value);
}

export function makeEnv(over: Partial<Env> = {}) {
  const d1 = new FakeD1();
  const sent: SentMail[] = [];
  const key = new Uint8Array(32).fill(7);
  const team = seedTeam(d1);
  const env: Env & { sent: SentMail[]; d1: FakeD1; failMail?: boolean; team: SeededTeam; teamId: string; joinCode: string } = {
    DB: d1 as unknown as D1Database,
    EMAIL: {
      async send(m: { to: string; subject: string; text: string; html: string }) {
        if (env.failMail) throw new Error("mail down");
        sent.push({ to: m.to, subject: m.subject, text: m.text, html: m.html });
        return { messageId: "x" };
      },
    } as unknown as SendEmail,
    ASSETS: {
      async fetch(req: Request) {
        return new Response(`<html>asset ${new URL(req.url).pathname}</html>`, { headers: { "content-type": "text/html" } });
      },
    } as unknown as Fetcher,
    ACCESS_TEAM: TEAM,
    ACCESS_AUD: AUD,
    ADMIN_EMAILS: ADMIN_EMAIL,
    PUBLIC_URL: "https://hub.test",
    MAIL_FROM: "bot@example.com",
    ENVIRONMENT: "test",
    TRIGGER_KEY: b64encode(key),
    ...over,
    sent,
    d1,
    team,
    teamId: team.id,
    joinCode: team.joinCode,
  };
  return env;
}
export type TestEnv = ReturnType<typeof makeEnv>;

// ---------------------------------------------------------------- agents

export interface AgentKey {
  publicB64: string;
  priv: CryptoKey;
}

export async function newKey(): Promise<AgentKey> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { publicB64: b64encode(raw), priv: kp.privateKey };
}

let nonceN = 0;
export interface SignOpts {
  version?: string;
  ts?: number;
  nonce?: string;
  member?: string;
  tamper?: boolean;
}

export async function signedRequest(key: AgentKey, member: string, method: string, path: string, body?: unknown, o: SignOpts = {}) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? `nonce-${Date.now()}-${++nonceN}-abcdef`;
  const msg = signingString(method, path, ts, nonce, await sha256Hex(raw));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.priv, new TextEncoder().encode(msg)));
  const headers: Record<string, string> = {
    "x-agentbus-version": o.version ?? CLIENT_VERSION,
    "x-agentbus-member": o.member ?? member,
    "x-agentbus-timestamp": ts,
    "x-agentbus-nonce": nonce,
    "x-agentbus-signature": b64encode(sig),
  };
  if (raw) headers["content-type"] = "application/json";
  return new Request(`https://hub.test${path}`, { method, headers, body: o.tamper ? raw + " " : raw || undefined });
}

export class Agent {
  id = "";
  constructor(
    readonly env: TestEnv,
    readonly name: string,
    readonly key: AgentKey,
  ) {}
  async call(method: string, path: string, body?: unknown, o: SignOpts = {}) {
    const req = await signedRequest(this.key, this.id || "join", method, `/api/v1/agent${path}`, body, o);
    const res = await app.request(req, undefined, this.env);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, res };
  }
  async post(body: Record<string, unknown>) {
    return this.call("POST", "/posts", { idempotency_key: `k-${Math.random()}`, ...body });
  }
}

/** Join (with the env's or `opts.team`'s join code) + approve an agent directly in the DB. */
export async function makeAgent(
  env: TestEnv,
  name: string,
  opts: { role?: string; approve?: boolean; join?: Record<string, unknown>; team?: SeededTeam } = {},
) {
  const a = new Agent(env, name, await newKey());
  const r = await a.call("POST", "/join", {
    join_code: (opts.team ?? env.team).joinCode,
    name,
    cli: "claude",
    wake_mode: "poll",
    wake_interval_s: 300,
    public_key: a.key.publicB64,
    client_version: CLIENT_VERSION,
    ...opts.join,
  });
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.json)}`);
  a.id = r.json.member_id;
  if (opts.approve !== false) env.d1.x("UPDATE members SET status = 'active' WHERE id = ?", a.id);
  if (opts.role) env.d1.x("UPDATE members SET role = ? WHERE id = ?", opts.role, a.id);
  return a;
}

// ---------------------------------------------------------------- Access JWT

const b64url = (b: Uint8Array | string) =>
  b64encode(typeof b === "string" ? new TextEncoder().encode(b) : b)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

let rsa: CryptoKeyPair | null = null;
const KID = "kid-1";

export async function setupJwks() {
  rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey;
  setJwksFetcher(async () => ({ keys: [{ kid: KID, kty: "RSA", n: jwk.n!, e: jwk.e! }] }));
}

export async function jwt(claims: Record<string, unknown>, o: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: o.alg ?? "RS256", kid: o.kid ?? KID }));
  const payload = b64url(
    JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], exp: now + 600, iat: now, ...claims }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key ?? rsa!.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

export async function adminToken() {
  return jwt({ email: ADMIN_EMAIL });
}

export interface WebOpts {
  token?: string | null;
  ct?: string;
  /** Act as this Access email (ignored when `token` is given). */
  email?: string;
  /** X-Agentbus-Team header. */
  team?: string;
}

export async function web(env: TestEnv, method: string, path: string, body?: unknown, o: WebOpts = {}) {
  const headers: Record<string, string> = {};
  const token = o.token === undefined ? (o.email ? await jwt({ email: o.email }) : await adminToken()) : o.token;
  if (token) headers["cf-access-jwt-assertion"] = token;
  if (o.team) headers["x-agentbus-team"] = o.team;
  // Like the SPA: every write carries a JSON body (the worker answers 415 otherwise).
  const write = method !== "GET" && method !== "HEAD";
  if (body === undefined && write && !o.ct) body = {};
  if (body !== undefined) headers["content-type"] = o.ct ?? "application/json";
  const res = await app.request(
    `https://hub.test${path}`,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

export const api = (env: TestEnv, method: string, path: string, body?: unknown, o?: WebOpts) =>
  web(env, method, `/api/v1/web${path}`, body, o);

/** A second team in the same env, owned by `ownerEmail`; returns helpers acting in it. */
export function makeTeam(env: TestEnv, o: { name?: string; ownerEmail?: string; ownerName?: string; notifyEmail?: string | null } = {}) {
  const team = seedTeam(env.d1, { name: o.name ?? "第二团队", ownerEmail: o.ownerEmail ?? "other@example.com", ...o });
  const opts = { email: team.ownerEmail, team: team.id };
  return {
    team,
    api: (method: string, path: string, body?: unknown, extra: WebOpts = {}) => api(env, method, path, body, { ...opts, ...extra }),
    agent: (name: string, aopts: Parameters<typeof makeAgent>[2] = {}) => makeAgent(env, name, { ...aopts, team }),
    workspace: async (name = "ws2") => {
      const r = await api(env, "POST", "/workspaces", { name }, opts);
      if (r.status !== 200) throw new Error(JSON.stringify(r.json));
      return r.json.workspace.id as string;
    },
  };
}

export async function workspace(env: TestEnv, name = "ws") {
  const r = await api(env, "POST", "/workspaces", { name });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  return r.json.workspace.id as string;
}
