// AES-GCM for trigger URLs; key is the TRIGGER_KEY secret (base64, 32 bytes).
import type { Env } from "./env";
import { b64decode, b64encode } from "./util";

async function key(env: Env): Promise<CryptoKey> {
  if (!env.TRIGGER_KEY) throw new Error("TRIGGER_KEY not configured");
  const raw = b64decode(env.TRIGGER_KEY);
  if (raw.length !== 32) throw new Error("TRIGGER_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptUrl(env: Env, url: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(url)));
  return { ciphertext: b64encode(ct), iv: b64encode(iv) };
}

export async function decryptUrl(env: Env, ciphertext: string, iv: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, await key(env), b64decode(ciphertext));
  return new TextDecoder().decode(pt);
}

export function validTriggerUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2000) return false;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password;
  } catch {
    return false;
  }
}
