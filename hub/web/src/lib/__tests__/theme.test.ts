import { describe, expect, it } from "vitest";
import { THEME_PREFS, nextThemePref, parseThemePref, resolveTheme } from "../theme";
import { routePattern } from "../pageview";

describe("theme", () => {
  it("parses stored preferences, defaulting to system", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("system")).toBe("system");
    expect(parseThemePref(null)).toBe("system");
    expect(parseThemePref("DARK")).toBe("system");
  });

  it("resolves system against the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("cycles light → dark → system → light", () => {
    expect(THEME_PREFS.map(nextThemePref)).toEqual(["dark", "system", "light"]);
  });
});

describe("routePattern (page.view)", () => {
  it("uses the leaf route pattern, never a concrete id", () => {
    expect(routePattern([{ routeId: "__root__" }, { routeId: "/threads/$id", fullPath: "/threads/$id" }])).toBe("/threads/$id");
    expect(routePattern([{ routeId: "__root__" }, { routeId: "/", fullPath: "/" }])).toBe("/");
    expect(routePattern([{ routeId: "__root__" }, { routeId: "/usage", fullPath: "/usage/" }])).toBe("/usage");
  });
  it("collapses unmatched locations", () => {
    expect(routePattern([{ routeId: "__root__" }])).toBe("/404");
    expect(routePattern([])).toBe("/404");
  });
});
