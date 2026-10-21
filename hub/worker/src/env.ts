export interface Env {
  DB: D1Database;
  /** Cloudflare Email Service / Email Routing send_email binding. */
  EMAIL?: SendEmail;
  /** Per-member request limit (60/min). */
  RL?: RateLimit;
  /** Static SPA (web/dist). */
  ASSETS?: Fetcher;

  /** Zero Trust team name ("shiroha") or full domain ("shiroha.cloudflareaccess.com"). */
  ACCESS_TEAM?: string;
  /** Comma-separated Access application audience tags. */
  ACCESS_AUD?: string;
  /** Comma-separated admin emails. */
  ADMIN_EMAILS?: string;
  /** Service token client id allowed as admin "e2e" (staging only). */
  E2E_SERVICE_TOKEN_ID?: string;
  /** https://hub.example.com, used in email links. */
  PUBLIC_URL?: string;
  /** Sender address for notifications. */
  MAIL_FROM?: string;
  /** "open": anyone past Access can create a team; "invite" (default): only ADMIN_EMAILS. */
  SIGNUP?: string;
  /** Base URL of public email images (default https://docs.shiroha.tech/email). */
  EMAIL_ASSET_BASE?: string;
  /** "production" | "staging" | "test". */
  ENVIRONMENT?: string;
  /** base64 32-byte AES-GCM key for trigger URLs (secret). */
  TRIGGER_KEY?: string;
}

export interface Me {
  id: string;
  kind: "human" | "agent" | "system";
  role: "admin" | "manager" | "agent";
  name: string;
  status: string;
}

export type Vars = { me: Me; body: unknown; rawBody: string };
export type AppEnv = { Bindings: Env; Variables: Vars };

export const SERVER_VERSION = "0.4.0";
