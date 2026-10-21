// Web analytics (埋点), contract docs/design/v06-contract.md §5.
//
// Callers only use `track(name, props)`. Events are validated against the worker's rules,
// stamped with `at` / client_version / os, queued in memory (≤ 200) and flushed every 15 s
// through api.events (≤ 50 per call) and when the page is hidden (fetch keepalive).
// Opt-out: localStorage["agentbus.telemetry"] === "off". Never throws; inert in tests.
import { API_BASE, api } from "../api";
import type { TelemetryEvent } from "../types";
import { getStoredTeam, teamHeaders } from "./team";

export type TrackProps = Record<string, string | number | boolean>;

export const TELEMETRY_KEY = "agentbus.telemetry";
export const NAME_RE = /^[a-z][a-z0-9_.]{1,48}$/;
export const PROP_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_PROPS = 20;
export const MAX_STRING = 200;
export const MAX_QUEUE = 200;
export const BATCH = 50;
export const FLUSH_MS = 15_000;

/** Validates a name + props. Returns null when the event must be dropped. */
export function sanitizeEvent(name: unknown, props: unknown): { name: string; props: TrackProps } | null {
  if (typeof name !== "string" || !NAME_RE.test(name)) return null;
  const out: TrackProps = {};
  let n = 0;
  if (props && typeof props === "object") {
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (n >= MAX_PROPS) break;
      if (!PROP_KEY_RE.test(k)) continue;
      if (typeof v === "string") out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
      else if (typeof v === "boolean") out[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      else continue;
      n++;
    }
  }
  return { name, props: out };
}

/** Coarse OS family only (never the full UA string). */
export function detectOs(nav: { userAgent?: string; userAgentData?: { platform?: string } } | undefined): string {
  if (!nav) return "unknown";
  const s = `${nav.userAgentData?.platform ?? ""} ${nav.userAgent ?? ""}`.toLowerCase();
  if (/iphone|ipad|ipod|\bios\b/.test(s)) return "ios";
  if (/android/.test(s)) return "android";
  if (/cros|chrome os|chromeos/.test(s)) return "chromeos";
  if (/mac/.test(s)) return "macos";
  if (/win/.test(s)) return "windows";
  if (/linux|x11/.test(s)) return "linux";
  return "other";
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function telemetryEnabled(storage: KV | null = browserStorage()): boolean {
  try {
    return storage?.getItem(TELEMETRY_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setTelemetryEnabled(on: boolean, storage: KV | null = browserStorage()): void {
  try {
    if (on) storage?.removeItem(TELEMETRY_KEY);
    else storage?.setItem(TELEMETRY_KEY, "off");
  } catch {
    /* ignore */
  }
  if (!on) defaultClient?.clear();
}

export interface TelemetryDeps {
  storage: KV | null;
  /** Regular flush (through the api layer). */
  send: (events: TelemetryEvent[]) => Promise<unknown>;
  /** Page-hide flush: must survive unload (fetch keepalive). */
  sendKeepalive: (events: TelemetryEvent[]) => void;
  now: () => number;
  version: string;
  os: string;
}

export interface TelemetryClient {
  track(name: string, props?: TrackProps): void;
  /** Drains the queue in batches. Network / 5xx failures are re-queued (bounded); 4xx are dropped. */
  flush(): Promise<void>;
  /** Synchronous best-effort flush of everything queued (page hidden). */
  flushKeepalive(): void;
  clear(): void;
  size(): number;
}

export function createTelemetry(deps: TelemetryDeps): TelemetryClient {
  let queue: TelemetryEvent[] = [];
  let inflight = false;

  const setQueue = (q: TelemetryEvent[]) => {
    queue = q.length > MAX_QUEUE ? q.slice(q.length - MAX_QUEUE) : q; // keep the newest
  };

  return {
    track(name, props = {}) {
      try {
        if (!telemetryEnabled(deps.storage)) return;
        const ev = sanitizeEvent(name, props);
        if (!ev) return;
        const e: TelemetryEvent = { name: ev.name, at: deps.now(), client_version: deps.version, os: deps.os };
        if (Object.keys(ev.props).length) e.props = ev.props;
        setQueue([...queue, e]);
      } catch {
        /* never throw */
      }
    },
    async flush() {
      if (inflight || queue.length === 0) return;
      if (!telemetryEnabled(deps.storage)) {
        queue = [];
        return;
      }
      inflight = true;
      try {
        // Drain in ≤ 50-event calls; stop at the first failure.
        while (queue.length > 0) {
          const batch = queue.slice(0, BATCH);
          queue = queue.slice(batch.length);
          try {
            await deps.send(batch);
          } catch (err) {
            const status = (err as { status?: number } | null)?.status ?? 0;
            if (!(status >= 400 && status < 500)) setQueue([...batch, ...queue]);
            break;
          }
        }
      } finally {
        inflight = false;
      }
    },
    flushKeepalive() {
      try {
        if (queue.length === 0) return;
        const all = queue;
        queue = [];
        if (!telemetryEnabled(deps.storage)) return;
        for (let i = 0; i < all.length; i += BATCH) deps.sendKeepalive(all.slice(i, i + BATCH));
      } catch {
        /* never throw */
      }
    },
    clear() {
      queue = [];
    },
    size() {
      return queue.length;
    },
  };
}

/** The keepalive request: same headers as the api layer (JSON body + X-Agentbus-Team). */
export function keepaliveRequest(events: TelemetryEvent[], team: string | null): [string, RequestInit] {
  return [
    `${API_BASE}/events`,
    {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...teamHeaders(team) },
      body: JSON.stringify({ events }),
    },
  ];
}

// ---------------------------------------------------------------- default client

function browserStorage(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const isTest = import.meta.env.MODE === "test" || !!import.meta.env.VITEST;
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const isMock = import.meta.env.VITE_MOCK === "1";

let defaultClient: TelemetryClient | null = null;

function init(): TelemetryClient | null {
  if (defaultClient || isTest || !isBrowser) return defaultClient;
  const client = createTelemetry({
    storage: browserStorage(),
    send: (events) => api.events(events),
    sendKeepalive: (events) => {
      // The dev mock has no server: go through the api transport instead.
      if (isMock) {
        void api.events(events).catch(() => {});
        return;
      }
      const [url, req] = keepaliveRequest(events, getStoredTeam());
      void fetch(url, req).catch(() => {});
    },
    now: () => Date.now(),
    version: __APP_VERSION__,
    os: detectOs(navigator as Navigator & { userAgentData?: { platform?: string } }),
  });
  window.setInterval(() => void client.flush(), FLUSH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") client.flushKeepalive();
  });
  window.addEventListener("pagehide", () => client.flushKeepalive());
  defaultClient = client;
  return client;
}

export function track(name: string, props: TrackProps = {}): void {
  try {
    init()?.track(name, props);
  } catch {
    /* never throw */
  }
}
