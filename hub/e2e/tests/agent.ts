// Minimal signed agent client (hub-api.md §2), independent of the worker code on purpose.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

export const CLIENT_VERSION = "0.5.0";
/** Hub version the deployed worker reports on /healthz. */
export const SERVER_VERSION = "0.7.0";

export class TestAgent {
  id = "join";
  readonly publicB64: string;
  private readonly priv: KeyObject;

  constructor(
    readonly base: string,
    readonly name: string,
  ) {
    const kp = generateKeyPairSync("ed25519");
    this.priv = kp.privateKey;
    // raw 32-byte public key = last 32 bytes of the SPKI DER
    this.publicB64 = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  }

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const full = `/api/v1/agent${path}`;
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const bodySha = createHash("sha256").update(raw).digest("hex");
    const msg = ["agentbus-v1", method, full, ts, nonce, bodySha].join("\n");
    const sig = sign(null, Buffer.from(msg), this.priv).toString("base64");
    const headers: Record<string, string> = {
      "x-agentbus-version": CLIENT_VERSION,
      "x-agentbus-member": this.id,
      "x-agentbus-timestamp": ts,
      "x-agentbus-nonce": nonce,
      "x-agentbus-signature": sig,
    };
    if (raw) headers["content-type"] = "application/json";
    const res = await fetch(this.base + full, { method, headers, body: raw || undefined, redirect: "manual" });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  async join(joinCode: string) {
    const r = await this.call("POST", "/join", {
      join_code: joinCode,
      name: this.name,
      cli: "custom",
      wake_mode: "poll",
      wake_interval_s: 300,
      owner: "e2e",
      machine: "github-actions",
      public_key: this.publicB64,
      client_version: CLIENT_VERSION,
    });
    if (r.status !== 200) throw new Error(`join ${this.name}: ${r.status} ${JSON.stringify(r.json)}`);
    this.id = r.json.member_id;
    return r.json;
  }

  post(body: Record<string, unknown>) {
    return this.call("POST", "/posts", { idempotency_key: randomBytes(8).toString("hex"), ...body });
  }
}
