import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Env, Me } from "./env";
import { DB } from "./db";
import { HttpError, b64decode, b64urlDecode, cmpVersion, sha256Hex, NAME_RE, RESERVED_NAMES, newId } from "./util";

const MAX_BODY = 256 * 1024;
const SKEW_S = 300;
const NONCE_TTL_MS = 10 * 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function signingString(method: string, pathWithQuery: string, ts: string, nonce: string, bodyShaHex: string) {
  return `agentbus-v1\n${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodyShaHex}`;
}

export async function verifyEd25519(publicKeyB64: string, message: string, sigB64: string): Promise<boolean> {
  try {
    const raw = b64decode(publicKeyB64);
    const sig = b64decode(sigB64);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export function isValidPublicKey(b64: unknown): b64 is string {
  if (typeof b64 !== "string") return false;
  try {
    return b64decode(b64).length === 32;
  } catch {
    return false;
  }
}

async function readBody(c: Context<AppEnv>): Promise<string> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, "bad_request", "请求体过大");
  const text = c.req.method === "GET" || c.req.method === "HEAD" ? "" : await c.req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "bad_request", "请求体过大");
  return text;
}

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_request", "请求体不是合法 JSON");
  }
}

const unauthorized = (msg = "签名校验失败") => new HttpError(401, "unauthorized", msg);

/**
 * Agent auth (hub-api.md §2): version → time → member active → signature →
 * nonce → rate limit. Pending members may only call GET /agent/state;
 * `join` requests are verified against the public key in the body.
 */
export const agentAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const db = new DB(c.env.DB);
  const url = new URL(c.req.url);
  const pathWithQuery = url.pathname + url.search;

  const minVer = (await db.setting("min_client_version")) ?? "0.0.0";
  const ver = c.req.header("x-agentbus-version") ?? "";
  if (!ver || cmpVersion(ver, minVer) < 0) {
    throw new HttpError(426, "client_too_old", `客户端版本 ${ver || "未知"} 过旧，最低要求 ${minVer}`, {
      upgrade: "agentbus self-update",
    });
  }

  const memberId = c.req.header("x-agentbus-member") ?? "";
  const ts = c.req.header("x-agentbus-timestamp") ?? "";
  const nonce = c.req.header("x-agentbus-nonce") ?? "";
  const sig = c.req.header("x-agentbus-signature") ?? "";
  if (!memberId || !/^\d{1,12}$/.test(ts) || !NONCE_RE.test(nonce) || !sig) throw unauthorized("缺少签名头");
  const now = Date.now();
  if (Math.abs(now / 1000 - Number(ts)) > SKEW_S) throw unauthorized("时间戳偏差超过 300 秒，请校准本机时间");

  const raw = await readBody(c);
  const body = parseBody(raw);
  const msg = signingString(c.req.method, pathWithQuery, ts, nonce, await sha256Hex(raw));

  let me: Me;
  const isJoin = memberId === "join";
  if (isJoin) {
    if (!(c.req.method === "POST" && url.pathname === "/api/v1/agent/join")) throw unauthorized();
    const pk = (body as { public_key?: unknown }).public_key;
    if (!isValidPublicKey(pk)) throw new HttpError(400, "bad_request", "public_key 必须是 32 字节 ed25519 公钥（base64）");
    if (!(await verifyEd25519(pk, msg, sig))) throw unauthorized();
    me = { id: "join", kind: "agent", role: "agent", name: "", status: "join" };
  } else {
    const m = await db.first<Me & { last_seen_at: number | null; offline_notified: number; client_version: string | null }>(
      "SELECT id, kind, role, name, status, last_seen_at, offline_notified, client_version FROM members WHERE id = ? AND kind = 'agent'",
      memberId,
    );
    if (!m || (m.status !== "active" && m.status !== "pending")) throw unauthorized("成员不存在或已被吊销");
    const keys = await db.all<{ public_key: string }>(
      "SELECT public_key FROM member_keys WHERE member_id = ? AND (expires_at IS NULL OR expires_at > ?)",
      memberId,
      now,
    );
    let ok = false;
    for (const k of keys) {
      if (await verifyEd25519(k.public_key, msg, sig)) {
        ok = true;
        break;
      }
    }
    if (!ok) throw unauthorized();
    if (m.status === "pending" && !(c.req.method === "GET" && url.pathname === "/api/v1/agent/state")) {
      throw new HttpError(403, "forbidden", "等待管理员在网页上批准");
    }
    me = { id: m.id, kind: m.kind, role: m.role, name: m.name, status: m.status };
    if (m.last_seen_at === null || now - m.last_seen_at > 30_000 || m.offline_notified || m.client_version !== ver) {
      await db.run(
        "UPDATE members SET last_seen_at = ?, offline_notified = 0, client_version = ? WHERE id = ?",
        now,
        ver,
        m.id,
      );
    }
  }

  const fresh = await db.run(
    "INSERT OR IGNORE INTO nonces (member_id, nonce, expires_at) VALUES (?, ?, ?)",
    me.id,
    nonce,
    now + NONCE_TTL_MS,
  );
  if (!fresh) throw unauthorized("nonce 重复（疑似重放）");

  if (!isJoin && c.env.RL) {
    const r = await c.env.RL.limit({ key: me.id });
    if (!r.success) throw new HttpError(429, "rate_limited", "请求过于频繁（每分钟 60 次）");
  }

  c.set("me", me);
  c.set("rawBody", raw);
  c.set("body", body);
  await next();
};

// ---------------------------------------------------------------- Access JWT

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}
let jwksCache: { team: string; keys: Jwk[]; at: number } | null = null;
let jwksFetcher: (url: string) => Promise<{ keys: Jwk[] }> = async (url) => {
  const r = await fetch(url, { cf: { cacheTtl: 600 } } as RequestInit);
  if (!r.ok) throw new Error(`certs ${r.status}`);
  return (await r.json()) as { keys: Jwk[] };
};

/** Tests only. */
export function setJwksFetcher(f: typeof jwksFetcher) {
  jwksFetcher = f;
  jwksCache = null;
}

export function accessDomain(team: string): string {
  const t = team.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return t.includes(".") ? t : `${t}.cloudflareaccess.com`;
}

async function getKeys(team: string, force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.team === team && now - jwksCache.at < 10 * 60_000) return jwksCache.keys;
  const data = await jwksFetcher(`https://${accessDomain(team)}/cdn-cgi/access/certs`);
  jwksCache = { team, keys: data.keys ?? [], at: now };
  return jwksCache.keys;
}

interface Claims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  common_name?: string;
  sub?: string;
}

export async function verifyAccessJwt(env: Env, token: string): Promise<Claims | null> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let keys = await getKeys(env.ACCESS_TEAM);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(env.ACCESS_TEAM, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp < now - 30) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) return null;
  if (claims.iss !== `https://${accessDomain(env.ACCESS_TEAM)}`) return null;
  const auds = env.ACCESS_AUD.split(",").map((s) => s.trim()).filter(Boolean);
  const tokenAuds = Array.isArray(claims.aud) ? claims.aud : [claims.aud ?? ""];
  if (!tokenAuds.some((a) => auds.includes(a))) return null;
  return claims;
}

function cookieToken(c: Context<AppEnv>): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

/** Resolve (and on first login create) the human admin for verified claims. */
export async function humanFor(env: Env, claims: Claims): Promise<Me | null> {
  const db = new DB(env.DB);
  const admins = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  let email: string;
  let preferred: string;
  if (claims.email) {
    email = claims.email.toLowerCase();
    if (!admins.includes(email)) return null;
    preferred = email.split("@")[0];
  } else if (claims.common_name) {
    if (!env.E2E_SERVICE_TOKEN_ID || claims.common_name !== env.E2E_SERVICE_TOKEN_ID) return null;
    email = "e2e@service-token.invalid";
    preferred = "e2e";
  } else {
    return null;
  }
  const existing = await db.first<Me>(
    "SELECT id, kind, role, name, status FROM members WHERE email = ? AND kind = 'human'",
    email,
  );
  if (existing) return existing.status === "revoked" ? null : existing;

  let base = preferred
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 28);
  if (!NAME_RE.test(base) || (RESERVED_NAMES.has(base) && base !== "e2e")) base = "admin-user";
  let name = base;
  for (let i = 2; await db.first("SELECT 1 FROM members WHERE name = ?", name); i++) name = `${base}-${i}`;
  const id = newId("m");
  const now = Date.now();
  await db.batch([
    db.stmt(
      "INSERT INTO members (id, kind, role, name, display_name, email, status, created_at) VALUES (?, 'human', 'admin', ?, ?, ?, 'active', ?)",
      id,
      name,
      preferred,
      email,
      now,
    ),
    db.audit(id, "admin.first_login", id, { email }),
    db.bumpSeq(),
  ]);
  return { id, kind: "human", role: "admin", name, status: "active" };
}

/** Web auth (hub-api.md §6): Access JWT on everything outside /api/v1/agent/*, fail closed. */
export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.req.header("cf-access-jwt-assertion") ?? cookieToken(c);
  const isApi = new URL(c.req.url).pathname.startsWith("/api/");
  const deny = (msg: string) => {
    if (isApi) throw new HttpError(401, "unauthorized", msg);
    return c.text(`401 ${msg}`, 401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  };
  if (!c.env.ACCESS_TEAM || !c.env.ACCESS_AUD) return deny("hub 未配置 Cloudflare Access，拒绝访问");
  if (!token) return deny("需要通过 Cloudflare Access 登录");
  let claims: Claims | null = null;
  try {
    claims = await verifyAccessJwt(c.env, token);
  } catch {
    claims = null;
  }
  if (!claims) return deny("Access 令牌无效或已过期");
  const me = await humanFor(c.env, claims);
  if (!me) return deny("该账号不在管理员名单里");
  c.set("me", me);

  if (isApi) {
    const m = c.req.method;
    if (m !== "GET" && m !== "HEAD") {
      const ct = c.req.header("content-type") ?? "";
      if (!ct.toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "bad_request", "写操作必须使用 Content-Type: application/json");
      }
    }
    const raw = await readBody(c);
    c.set("rawBody", raw);
    c.set("body", parseBody(raw));
  }
  await next();
};
