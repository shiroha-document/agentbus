export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, "bad_request", msg);
export const forbidden = (msg = "没有权限") => new HttpError(403, "forbidden", msg);
export const notFound = (what = "对象") => new HttpError(404, "not_found", `${what}不存在`);
export const conflict = (msg: string) => new HttpError(409, "conflict", msg);

const ALPHA = "0123456789abcdefghjkmnpqrstvwxyz";

/** `<prefix>_<26 base32>`; first 10 chars encode the ms timestamp, so ids sort by time.
 * Ids created in the same millisecond (same isolate) increment the random part, so they stay ordered. */
let lastMs = -1;
const lastRand = new Uint8Array(16);
export function newId(prefix: string, ms = Date.now()): string {
  const out: string[] = new Array(26);
  let t = ms;
  for (let i = 9; i >= 0; i--) {
    out[i] = ALPHA[t % 32];
    t = Math.floor(t / 32);
  }
  if (ms === lastMs) {
    for (let i = 15; i >= 0; i--) {
      lastRand[i] = (lastRand[i] + 1) & 31;
      if (lastRand[i] !== 0) break;
    }
  } else {
    crypto.getRandomValues(lastRand);
    for (let i = 0; i < 16; i++) lastRand[i] &= 31;
    lastRand[0] &= 15; // headroom so increments never wrap in practice
    lastMs = ms;
  }
  for (let i = 0; i < 16; i++) out[10 + i] = ALPHA[lastRand[i]];
  return `${prefix}_${out.join("")}`;
}

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const RESERVED_NAMES = new Set(["all", "system", "join", "admin", "e2e", "everyone", "here"]);

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64decode(s);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 24): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Compare dotted versions; pre-release suffixes ("-dev") are ignored. */
export function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---- Asia/Shanghai calendar (UTC+8, no DST)
const SH = 8 * 3600_000;
const DAY = 86400_000;
export function shDayStart(ms: number): number {
  return Math.floor((ms + SH) / DAY) * DAY - SH;
}
export function shNextDay(ms: number): number {
  return shDayStart(ms) + DAY;
}
export function shMonthStart(ms: number): number {
  const d = new Date(ms + SH);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - SH;
}
export function shNextMonth(ms: number): number {
  const d = new Date(ms + SH);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - SH;
}
export function shDayKey(ms: number): string {
  return new Date(ms + SH).toISOString().slice(0, 10);
}

export function clampLimit(v: string | undefined, def = 50, max = 200): number {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function parseJsonArray(s: unknown): string[] {
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function maskEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const [user, domain] = e.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}
