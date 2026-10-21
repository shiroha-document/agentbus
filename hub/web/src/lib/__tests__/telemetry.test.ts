import { describe, expect, it, vi } from "vitest";
import {
  BATCH,
  MAX_QUEUE,
  TELEMETRY_KEY,
  createTelemetry,
  detectOs,
  keepaliveRequest,
  sanitizeEvent,
  setTelemetryEnabled,
  telemetryEnabled,
  track,
  type KV,
  type TelemetryDeps,
} from "../telemetry";
import type { TelemetryEvent } from "../../types";

function memStorage(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

function deps(over: Partial<TelemetryDeps> = {}): TelemetryDeps & { sent: TelemetryEvent[][]; kept: TelemetryEvent[][] } {
  const sent: TelemetryEvent[][] = [];
  const kept: TelemetryEvent[][] = [];
  return {
    sent,
    kept,
    storage: memStorage(),
    send: async (ev) => {
      sent.push(ev);
    },
    sendKeepalive: (ev) => {
      kept.push(ev);
    },
    now: () => 1_700_000_000_000,
    version: "0.6.0",
    os: "macos",
    ...over,
  };
}

describe("sanitizeEvent", () => {
  it("accepts contract-shaped names", () => {
    expect(sanitizeEvent("page.view", { path: "/threads/$id" })).toEqual({ name: "page.view", props: { path: "/threads/$id" } });
    expect(sanitizeEvent("agent.add_open", {})).toEqual({ name: "agent.add_open", props: {} });
  });

  it("drops invalid names", () => {
    for (const n of ["", "a", "Page.view", "1abc", "page view", "page-view", `a${"b".repeat(49)}`, 42, null]) {
      expect(sanitizeEvent(n, {})).toBeNull();
    }
    expect(sanitizeEvent(`a${"b".repeat(48)}`, {})).not.toBeNull();
  });

  it("filters prop keys, types and lengths", () => {
    const r = sanitizeEvent("x.y", {
      ok: "v",
      Bad: 1,
      "with-dash": 1,
      n: 3,
      inf: Infinity,
      nan: NaN,
      b: false,
      obj: { a: 1 },
      arr: [1],
      long: "x".repeat(250),
      und: undefined,
    });
    expect(r?.props).toEqual({ ok: "v", n: 3, b: false, long: "x".repeat(200) });
  });

  it("keeps at most 20 props", () => {
    const props = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeEvent("x.y", props)!.props)).toHaveLength(20);
  });
});

describe("detectOs", () => {
  it.each([
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }, "macos"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, "windows"],
    [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }, "linux"],
    [{ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }, "ios"],
    [{ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }, "android"],
    [{ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)" }, "chromeos"],
    [{ userAgentData: { platform: "Windows" }, userAgent: "" }, "windows"],
    [{ userAgent: "curl/8" }, "other"],
  ])("%j → %s", (nav, os) => {
    expect(detectOs(nav)).toBe(os);
  });
  it("handles a missing navigator", () => expect(detectOs(undefined)).toBe("unknown"));
});

describe("opt-out", () => {
  it("reads and writes localStorage['agentbus.telemetry']", () => {
    const s = memStorage();
    expect(telemetryEnabled(s)).toBe(true);
    setTelemetryEnabled(false, s);
    expect(s.data[TELEMETRY_KEY]).toBe("off");
    expect(telemetryEnabled(s)).toBe(false);
    setTelemetryEnabled(true, s);
    expect(TELEMETRY_KEY in s.data).toBe(false);
    expect(telemetryEnabled(s)).toBe(true);
  });

  it("does not queue or send when off", async () => {
    const d = deps({ storage: memStorage({ [TELEMETRY_KEY]: "off" }) });
    const t = createTelemetry(d);
    t.track("page.view", { path: "/" });
    expect(t.size()).toBe(0);
    await t.flush();
    expect(d.sent).toHaveLength(0);
  });

  it("drops the queue if turned off before a flush", async () => {
    const storage = memStorage();
    const d = deps({ storage });
    const t = createTelemetry(d);
    t.track("page.view", { path: "/" });
    storage.setItem(TELEMETRY_KEY, "off");
    await t.flush();
    t.flushKeepalive();
    expect(d.sent).toHaveLength(0);
    expect(d.kept).toHaveLength(0);
    expect(t.size()).toBe(0);
  });

  it("an unreadable storage counts as enabled and never throws", () => {
    const broken: KV = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(telemetryEnabled(broken)).toBe(true);
    expect(() => setTelemetryEnabled(false, broken)).not.toThrow();
  });
});

describe("createTelemetry", () => {
  it("stamps at / client_version / os and omits empty props", async () => {
    const d = deps();
    const t = createTelemetry(d);
    t.track("changelog.open");
    t.track("theme.change", { theme: "dark" });
    t.track("Bad Name", {});
    await t.flush();
    expect(d.sent).toEqual([
      [
        { name: "changelog.open", at: 1_700_000_000_000, client_version: "0.6.0", os: "macos" },
        { name: "theme.change", at: 1_700_000_000_000, client_version: "0.6.0", os: "macos", props: { theme: "dark" } },
      ],
    ]);
    expect(t.size()).toBe(0);
  });

  it("caps the queue at 200, keeping the newest", () => {
    const t = createTelemetry(deps());
    for (let i = 0; i < MAX_QUEUE + 37; i++) t.track("page.view", { i });
    expect(t.size()).toBe(MAX_QUEUE);
  });

  it("flushes in batches of at most 50", async () => {
    const d = deps();
    const t = createTelemetry(d);
    for (let i = 0; i < 120; i++) t.track("page.view", { i });
    await t.flush();
    expect(d.sent.map((b) => b.length)).toEqual([BATCH, BATCH, 20]);
    expect(d.sent[0]![0]!.props).toEqual({ i: 0 });
    expect(d.sent[2]![19]!.props).toEqual({ i: 119 });
  });

  it("re-queues on network / 5xx failures and stops", async () => {
    let calls = 0;
    const d = deps({
      send: async () => {
        calls++;
        throw Object.assign(new Error("boom"), { status: 503 });
      },
    });
    const t = createTelemetry(d);
    for (let i = 0; i < 70; i++) t.track("page.view", { i });
    await t.flush();
    expect(calls).toBe(1);
    expect(t.size()).toBe(70);

    // Network error (no status) behaves the same.
    const d2 = deps({ send: () => Promise.reject(new TypeError("Failed to fetch")) });
    const t2 = createTelemetry(d2);
    t2.track("page.view", {});
    await t2.flush();
    expect(t2.size()).toBe(1);
  });

  it("drops a batch rejected with 4xx", async () => {
    const d = deps({ send: () => Promise.reject(Object.assign(new Error("bad"), { status: 400 })) });
    const t = createTelemetry(d);
    for (let i = 0; i < 60; i++) t.track("page.view", { i });
    await t.flush();
    expect(t.size()).toBe(10); // first batch dropped, the rest waits for the next flush
  });

  it("does not run two flushes at once", async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>((r) => (release = r)));
    const t = createTelemetry(deps({ send }));
    t.track("page.view", {});
    const a = t.flush();
    await t.flush();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await a;
  });

  it("flushKeepalive sends everything synchronously in batches", () => {
    const d = deps();
    const t = createTelemetry(d);
    for (let i = 0; i < 75; i++) t.track("page.view", { i });
    t.flushKeepalive();
    expect(d.kept.map((b) => b.length)).toEqual([50, 25]);
    expect(t.size()).toBe(0);
    t.flushKeepalive();
    expect(d.kept).toHaveLength(2);
  });

  it("never throws, even if the clock does", () => {
    const t = createTelemetry(
      deps({
        now: () => {
          throw new Error("x");
        },
      }),
    );
    expect(() => t.track("page.view", {})).not.toThrow();
  });
});

describe("keepaliveRequest", () => {
  it("posts JSON with keepalive and the team header", () => {
    const ev: TelemetryEvent[] = [{ name: "page.view", props: { path: "/" } }];
    const [url, init] = keepaliveRequest(ev, "o_abc123");
    expect(url).toBe("/api/v1/web/events");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "X-Agentbus-Team": "o_abc123" });
    expect(JSON.parse(String(init.body))).toEqual({ events: ev });
  });

  it("omits the team header without a team", () => {
    const [, init] = keepaliveRequest([], null);
    expect(init.headers).not.toHaveProperty("X-Agentbus-Team");
  });
});

describe("track (default client)", () => {
  it("is inert under test and never touches fetch", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(() => track("page.view", { path: "/" })).not.toThrow();
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
