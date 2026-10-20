import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { SERVER_VERSION } from "./env";
import { accessAuth, agentAuth } from "./auth";
import { agent } from "./routes/agent";
import { web } from "./routes/web";
import { runWatchdog } from "./watchdog";
import { HttpError } from "./util";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Radix / motion set element style attributes at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status as 400);
  }
  console.error("unhandled", err);
  return c.json({ error: { code: "internal", message: "服务器内部错误" } }, 500);
});

app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-frame-options", "DENY");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (!h.has("content-security-policy")) h.set("content-security-policy", CSP);
  if (c.req.path.startsWith("/api/") && !h.has("cache-control")) h.set("cache-control", "no-store");
});

// Unauthenticated liveness probe; reveals nothing but the version.
app.get("/healthz", (c) => c.json({ ok: true, version: SERVER_VERSION }));

app.use("/api/v1/agent/*", agentAuth);
app.route("/api/v1/agent", agent);
app.all("/api/v1/agent/*", () => {
  throw new HttpError(404, "not_found", "接口不存在");
});

app.use("*", accessAuth);
app.route("/api/v1/web", web);
app.all("/api/*", () => {
  throw new HttpError(404, "not_found", "接口不存在");
});

app.all("*", async (c) => {
  if (!c.env.ASSETS) return c.text("assets not configured", 500);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("method not allowed", 405);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  const p = c.req.path;
  if (p.startsWith("/assets/")) out.headers.set("cache-control", "public, max-age=31536000, immutable");
  else out.headers.set("cache-control", "no-cache");
  return out;
});

export async function scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(runWatchdog(env));
}

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
