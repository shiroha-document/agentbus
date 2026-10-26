import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it("initializes even when accessing window.localStorage throws", async () => {
  const browser = { navigator: { language: "zh-TW" }, addEventListener: vi.fn(), get localStorage() { throw new Error("denied"); } };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", { documentElement: { lang: "" } });
  vi.resetModules();
  const fresh = await import("../i18n");
  expect(fresh.getLanguage()).toBe("zh");
  fresh.setLanguage("en");
  expect(fresh.getLanguage()).toBe("en");
  expect(document.documentElement.lang).toBe("en");
});
