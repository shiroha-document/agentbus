import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isIOS, shouldRegisterSW } from "../pwa";
import { THEME_COLOR } from "../theme";

const pub = (f: string) => new URL(`../../../public/${f}`, import.meta.url);

describe("PWA manifest", () => {
  const m = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));

  it("is installable (name, start_url, standalone, 192+512 icons, maskable)", () => {
    expect(m.name).toBe("agentbus hub");
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    for (const i of m.icons) expect(existsSync(pub(i.src.slice(1)))).toBe(true);
  });

  it("colours match the light theme background", () => {
    expect(m.theme_color).toBe(THEME_COLOR.light);
    expect(m.background_color).toBe(THEME_COLOR.light);
  });

  it("index.html links it with credentials (Cloudflare Access) plus theme-color + apple icon", () => {
    const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
    expect(html).toMatch(/<link rel="manifest" href="\/manifest.webmanifest" crossorigin="use-credentials"/);
    expect(html).toContain(`<meta name="theme-color" content="${THEME_COLOR.light}"`);
    expect(html).toContain('rel="apple-touch-icon"');
    const init = readFileSync(pub("theme-init.js"), "utf8");
    expect(init).toContain(THEME_COLOR.dark);
  });
});

describe("service worker", () => {
  const sw = readFileSync(pub("sw.js"), "utf8");
  it("never intercepts the API, healthz or non-GET requests", () => {
    expect(sw).toMatch(/p\.startsWith\("\/api\/"\)[^\n]*return;/);
    expect(sw).toContain('p === "/healthz"');
    expect(sw).toMatch(/req\.method !== "GET"\) return;/);
    expect(sw).toMatch(/url\.origin !== self\.location\.origin\) return;/);
  });
  it("does not cache redirects (Access login) or opaque responses", () => {
    expect(sw).toContain("!res.redirected");
    expect(sw).toContain('res.type === "basic"');
  });
});

describe("pwa helpers", () => {
  it("registers only in secure production non-mock builds", () => {
    const nav = { serviceWorker: {} };
    expect(shouldRegisterSW({ prod: true, mock: false }, nav, true)).toBe(true);
    expect(shouldRegisterSW({ prod: false, mock: false }, nav, true)).toBe(false);
    expect(shouldRegisterSW({ prod: true, mock: true }, nav, true)).toBe(false);
    expect(shouldRegisterSW({ prod: true, mock: false }, nav, false)).toBe(false);
    expect(shouldRegisterSW({ prod: true, mock: false }, {}, true)).toBe(false);
    expect(shouldRegisterSW({ prod: true, mock: false }, undefined, true)).toBe(false);
  });
  it("detects iOS incl. iPadOS desktop UA", () => {
    expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe(true);
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIOS("Mozilla/5.0 (Linux; Android 15)", 5)).toBe(false);
  });
});

describe("localized PWA metadata", () => {
  it("matches the dictionary in both languages without changing installed app identity", async () => {
    const { t, manifestUrl } = await import("../i18n");
    const en = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));
    expect(en.lang).toBe("en");
    expect(en.description).toBe(t("manifest.description", [], "en"));
    expect(manifestUrl("en")).toBe("/manifest.webmanifest");
    const zh = JSON.parse(readFileSync(pub("manifest.zh.webmanifest"), "utf8"));
    expect(zh.lang).toBe("zh-CN");
    expect(zh.description).toBe(t("manifest.description", [], "zh"));
    expect(manifestUrl("zh")).toBe("/manifest.zh.webmanifest");
    for (const field of ["id", "start_url", "scope", "name", "short_name", "icons"]) expect(zh[field]).toEqual(en[field]);
    for (const [index, key] of ["动态", "工作区", "成员"].entries()) {
      expect(en.shortcuts[index].name).toBe(t(key as "动态" | "工作区" | "成员", [], "en"));
      expect(zh.shortcuts[index].name).toBe(t(key as "动态" | "工作区" | "成员", [], "zh"));
      expect(zh.shortcuts[index].url).toBe(en.shortcuts[index].url);
    }
  });
});
