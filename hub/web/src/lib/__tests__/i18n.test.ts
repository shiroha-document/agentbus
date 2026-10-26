import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Tooltip from "@radix-ui/react-tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePage } from "../../pages/Welcome";
import { agentPrompt, joinSnippet, unixOneLiner, windowsOneLiner, roleLabel } from "../team";
import { formatDate, formatDateTime, formatInt, formatRelative, greeting } from "../format";
import { dayLabel } from "../posts";
import { visibleNav } from "../../components/layout/nav";
import { errorFrom } from "../../api";
import type { MeResponse } from "../../types";

// Dynamic loading allows the first red run to report the missing feature as an assertion.
const i18n = await import("../i18n").catch(() => null);
beforeEach(() => i18n?.setLanguage("en"));
afterEach(() => { vi.unstubAllGlobals(); i18n?.setLanguage("en"); });
function storage(value: string | null = null) {
  const data = new Map(value === null ? [] : [["agentbus.language", value]]);
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, val: string) => { data.set(key, val); } };
}
async function welcome() {
  const me = { identity: { email: "user@example.test" }, can_create_team: true } as MeResponse;
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => createElement(WelcomePage, { me }) });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory(), isServer: true });
  await router.load();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Tooltip.Provider, null, createElement(RouterProvider, { router }))));
}

describe("language preference", () => {
  it("detects simplified Chinese for every zh prefix and English for other browser languages", () => {
    expect(i18n).not.toBeNull();
    for (const lang of ["zh", "zh-CN", "zh-TW", "zh-Hant", "ZH-hk"]) expect(i18n!.createLanguageStore({ browserLanguage: lang, storage: null }).getSnapshot()).toBe("zh");
    for (const lang of ["en-US", "ja", "fr-FR", "", undefined]) expect(i18n!.createLanguageStore({ browserLanguage: lang, storage: null }).getSnapshot()).toBe("en");
  });
  it("honors saved choices and falls back for corrupt or unreadable storage", () => {
    expect(i18n).not.toBeNull();
    expect(i18n!.createLanguageStore({ browserLanguage: "zh", storage: storage("en") }).getSnapshot()).toBe("en");
    expect(i18n!.createLanguageStore({ browserLanguage: "en", storage: storage("zh") }).getSnapshot()).toBe("zh");
    for (const invalid of ["fr", "ZH", "null", "zh-CN", ""]) expect(i18n!.createLanguageStore({ browserLanguage: "zh", storage: storage(invalid) }).getSnapshot()).toBe("zh");
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const store = i18n!.createLanguageStore({ browserLanguage: "en", storage: broken });
    expect(store.getSnapshot()).toBe("en");
    expect(() => store.setLanguage("zh")).not.toThrow();
    expect(store.getSnapshot()).toBe("zh");
  });
  it("persists changes, updates html lang, and synchronously notifies same-tab subscribers", () => {
    expect(i18n).not.toBeNull();
    const kv = storage(), html = { lang: "" };
    const store = i18n!.createLanguageStore({ browserLanguage: "en-US", storage: kv, html });
    expect(html.lang).toBe("en");
    const seen: string[] = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot()));
    store.setLanguage("zh");
    expect(seen).toEqual(["zh"]);
    expect(kv.data.get("agentbus.language")).toBe("zh");
    expect(html.lang).toBe("zh-CN");
    expect(i18n!.createLanguageStore({ browserLanguage: "en", storage: kv }).getSnapshot()).toBe("zh");
    store.setLanguage("zh");
    expect(seen).toEqual(["zh"]);
    off(); store.setLanguage("en"); expect(seen).toEqual(["zh"]);
  });
  it("syncs cross-tab storage changes and safely resolves removed or invalid choices", () => {
    expect(i18n).not.toBeNull();
    const store = i18n!.createLanguageStore({ browserLanguage: "zh-CN", storage: storage("en") });
    store.syncStoredLanguage("zh"); expect(store.getSnapshot()).toBe("zh");
    store.syncStoredLanguage("en"); expect(store.getSnapshot()).toBe("en");
    store.syncStoredLanguage(null); expect(store.getSnapshot()).toBe("zh");
    store.syncStoredLanguage("invalid"); expect(store.getSnapshot()).toBe("zh");
  });
});

describe("localized installation", () => {
  it("writes an English prompt with compatible commands and English documentation", () => {
    const prompt = agentPrompt("https://hub.example.test/", "abj_example", "研究小组", "en");
    for (const s of ["Please", "研究小组", "agentbus inbox", "agentbus ack --thread", "agentbus heartbeat --thread", "--cli manual", "--lang en", "AGENTBUS_LANG='en'", "/en/guide/onboarding"]) expect(prompt).toContain(s);
    expect(prompt).not.toContain("请帮我");
  });
  it("explicitly sets the installer and CLI language on copied commands", () => {
    expect(unixOneLiner("https://hub.test", "abj_example", "en")).toContain("AGENTBUS_LANG=en sh -s -- --lang en");
    expect(windowsOneLiner("https://hub.test", "abj_example", "zh")).toContain("$env:AGENTBUS_LANG='zh'");
    expect(joinSnippet("https://hub.test", "abj_example", "en")).toContain("agentbus --lang en setup");
  });
});

describe("web language coverage", () => {
  it("renders English welcome copy and a language control before team creation", async () => {
    const html = await welcome();
    expect(html).toContain("Create team"); expect(html).toContain('aria-label="Language"'); expect(html).toContain("English"); expect(html).toContain("user@example.test"); expect(html).not.toMatch(/[\u3400-\u9fff]/);
  });
  it("reacts to a changed preference across navigation and labels", async () => {
    expect(visibleNav(true).find((n) => n.to === "/settings")?.label).toBe("Settings"); expect(roleLabel("owner")).toBe("Owner"); expect(i18n).not.toBeNull();
    i18n!.setLanguage("zh"); expect(visibleNav(true).find((n) => n.to === "/settings")?.label).toBe("设置"); expect(roleLabel("owner")).toBe("所有者"); expect(await welcome()).toContain("创建团队");
  });
  it("localizes known API errors and preserves unknown server messages", () => {
    expect(errorFrom(403, { error: { code: "forbidden", message: "需要管理员" } }).message).toBe("You do not have permission to perform this action.");
    expect(errorFrom(503, { error: { code: "extension_error", message: "原始错误 detail" } }).message).toBe("原始错误 detail"); expect(errorFrom(502, null).message).toContain("HTTP 502");
  });
  it("uses the chosen Intl locale for dates and numbers and translates relative labels", () => {
    const date = new Date(2026, 9, 20, 15, 0), opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
    expect(formatDate(date.getTime())).toBe(new Intl.DateTimeFormat("en-US", opts).format(date)); expect(formatDateTime(date.getTime())).toContain("2026"); expect(formatInt(12345)).toBe(new Intl.NumberFormat("en-US").format(12345)); expect(formatRelative(date.getTime() - 10_000, date.getTime())).toBe("Just now"); expect(greeting(new Date(2026, 0, 1, 8))).toBe("Good morning"); expect(dayLabel(date.getTime(), date.getTime())).toBe("Today");
    i18n!.setLanguage("zh"); expect(formatDate(date.getTime())).toBe(new Intl.DateTimeFormat("zh-CN", opts).format(date)); expect(dayLabel(date.getTime(), date.getTime())).toBe("今天");
  });
});

describe("secondary language surfaces", () => {
  it("offers a language control in Settings preferences", async () => {
    const { PreferencesSection } = await import("../../pages/settings/PreferencesSection");
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: "/", component: PreferencesSection });
    const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory(), isServer: true });
    await router.load();
    const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(RouterProvider, { router })));
    expect(html).toContain("Preferences");
    expect(html).toContain('aria-label="Language"');
    expect(html).toContain("Choose the interface language for this browser.");
    expect(html).not.toMatch(/[\u3400-\u9fff]/);
  });
  it("provides English release notes and localized documentation destinations", async () => {
    const notes = await import("../changelog");
    expect(notes).toHaveProperty("getChangelog");
    const en = notes.getChangelog("en");
    expect(en.body).toContain("## v0.7.0");
    expect(en.body).toContain("Self-driven mode");
    expect(en.body).not.toMatch(/[\u3400-\u9fff]/);
    const zh = notes.getChangelog("zh");
    expect(zh.body).toContain("自驱模式");
    expect(i18n!.docsUrl("guide/onboarding", "en")).toBe("https://docs.hub.shiroha.tech/en/guide/onboarding");
    expect(i18n!.docsUrl("guide/onboarding", "zh")).toBe("https://docs.hub.shiroha.tech/guide/onboarding");
  });
  it("keeps an existing known error reactive and an unknown error unchanged", () => {
    const known = errorFrom(403, { error: { code: "forbidden", message: "原始权限消息" } });
    const unknown = errorFrom(400, { error: { code: "custom_code", message: "原始错误 ${not_a_parameter}" } });
    expect(known.message).toContain("permission");
    i18n!.setLanguage("zh");
    expect(known.message).toContain("没有权限");
    expect(unknown.message).toBe("原始错误 ${not_a_parameter}");
  });
});

it("localizes avatar category labels while preserving member names", async () => {
  const { Avatar } = await import("../../components/ui/Avatar");
  const member = { name: "alice", display_name: "小林", avatar_url: null, kind: "human" } as const;
  i18n!.setLanguage("zh");
  const zh = renderToStaticMarkup(createElement(Avatar, { member }));
  expect(zh).toContain('aria-label="人类 · 小林"');
  i18n!.setLanguage("en");
  expect(renderToStaticMarkup(createElement(Avatar, { member }))).toContain('aria-label="human · 小林"');
});

it("updates a toast’s system template after switching and leaves user text untouched", async () => {
  const { toast, Toaster } = await import("../../components/ui/Toast");
  vi.stubGlobal("window", { setTimeout: () => 0 });
  expect(i18n).toHaveProperty("localized");
  toast.success(i18n!.localized("已创建团队「{0}」", ["我的 {0} 小组"]));
  toast("原始文字 {1}");
  vi.unstubAllGlobals();
  let html = renderToStaticMarkup(createElement(Toaster));
  expect(html).toContain("Created team");
  expect(html).toContain("我的 {0} 小组");
  i18n!.setLanguage("zh");
  html = renderToStaticMarkup(createElement(Toaster));
  expect(html).toContain("已创建团队");
  expect(html).toContain("原始文字 {1}");
});

it("updates the composer keyboard hint when the preference changes", async () => {
  const editor = await import("../../components/composer/RichEditor");
  expect(editor).toHaveProperty("sendHint");
  expect(editor.sendHint()).toContain("to send");
  i18n!.setLanguage("zh");
  expect(editor.sendHint()).toContain("发送");
});

it("preserves unknown error messages even for object prototype names", () => {
  for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const error = errorFrom(400, { error: { code, message: "原始错误 detail" } });
    expect(error.message).toBe("原始错误 detail");
    i18n!.setLanguage("zh");
    expect(error.message).toBe("原始错误 detail");
    i18n!.setLanguage("en");
  }
});

it("localizes a known error when the server omits its optional message", () => {
  expect(errorFrom(403, { error: { code: "forbidden" } }).message).toContain("permission");
});

it("keeps attachment validation toasts reactive while preserving filenames", async () => {
  const { validateFiles } = await import("../attachments");
  const { toast, Toaster } = await import("../../components/ui/Toast");
  const validation = validateFiles([{ name: "我的 {0} 文件.txt", size: 0 }], 0);
  expect(validation).toHaveProperty("messages");
  vi.stubGlobal("window", { setTimeout: () => 0 });
  toast(validation.messages[0]!, "error");
  vi.unstubAllGlobals();
  expect(renderToStaticMarkup(createElement(Toaster))).toContain("empty file");
  i18n!.setLanguage("zh");
  const html = renderToStaticMarkup(createElement(Toaster));
  expect(html).toContain("是空文件");
  expect(html).toContain("我的 {0} 文件.txt");
});

it("localizes newly generated quick-code labels without changing existing labels", async () => {
  const dialog = await import("../../components/AddAgentDialog");
  expect(dialog).toHaveProperty("quickCodeLabel");
  const date = new Date(2026, 9, 20, 15, 0);
  expect(dialog.quickCodeLabel(date)).toContain("Quick setup");
  expect(dialog.quickCodeLabel(date)).not.toMatch(/[\u3400-\u9fff]/);
  i18n!.setLanguage("zh");
  expect(dialog.quickCodeLabel(date)).toContain("一键接入");
});

it("localizes API calendar dates without treating member content as dates", async () => {
  const format = await import("../format");
  expect(format).toHaveProperty("formatCalendarDay");
  expect(format.formatCalendarDay("2026-10-20")).toBe("10/20/2026");
  expect(format.formatCalendarDay("2026-10-20", true)).toBe("Oct 20");
  for (const text of ["研究小组", "2026-02-30", "unknown"]) expect(format.formatCalendarDay(text)).toBe(text);
  i18n!.setLanguage("zh");
  expect(format.formatCalendarDay("2026-10-20")).toBe("2026/10/20");
  expect(format.formatCalendarDay("2026-10-20", true)).toBe("10月20日");
});

it("translates known email-health hints and preserves unknown diagnostic messages", () => {
  expect(i18n).toHaveProperty("systemText");
  const hint = "还没有设置通知邮箱，提醒邮件都被丢弃了。请在设置页填写通知邮箱。";
  expect(i18n!.systemText(hint)).toContain("notification email");
  expect(i18n!.systemText("原始未知诊断 ${0}")).toBe("原始未知诊断 ${0}");
  i18n!.setLanguage("zh");
  expect(i18n!.systemText(hint)).toBe(hint);
});

it("keeps the mock onboarding flow working for English quick codes", async () => {
  const { quickCodeLabel } = await import("../../components/AddAgentDialog");
  const { api, setTransport } = await import("../../api");
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    const { installMock } = await import("../../mock");
    installMock();
    const created = api.createJoinCode({ label: quickCodeLabel(), expires_in_days: 7 });
    await vi.advanceTimersByTimeAsync(300);
    expect((await created).code.label).toContain("Quick setup");
    await vi.advanceTimersByTimeAsync(10_000);
    const members = api.members();
    await vi.advanceTimersByTimeAsync(300);
    expect((await members).members.some((member) => member.name === "mac-mini-claude")).toBe(true);
  } finally {
    setTransport(null);
    vi.useRealTimers();
    info.mockRestore();
  }
});

it("finds localized navigation labels regardless of English search capitalization", async () => {
  const nav = await import("../../components/layout/nav");
  expect(nav).toHaveProperty("matchingNav");
  expect(nav).toHaveProperty("matchesSearch");
  expect(nav.matchesSearch("My TEAM", "team")).toBe(true);
  for (const query of ["settings", "SeTtInGs", " SETTINGS "]) {
    expect(nav.matchingNav(true, query).some((item) => item.to === "/settings")).toBe(true);
  }
  expect(nav.matchingNav(false, "analytics")).toEqual([]);
  i18n!.setLanguage("zh");
  expect(nav.matchingNav(true, "设置").some((item) => item.to === "/settings")).toBe(true);
});

it("localizes conflict mail prefixes while retaining actionable backend diagnostics", () => {
  const diagnostic = "E_RECIPIENT_NOT_ALLOWED: verify 收件地址 ${0}";
  const confirmation = errorFrom(409, { error: { code: "conflict", message: `确认邮件发送失败：${diagnostic}` } });
  const testMail = errorFrom(409, { error: { code: "conflict", message: `发送失败：${diagnostic}` } });
  expect(confirmation.message).toBe(`Confirmation email failed: ${diagnostic}`);
  expect(testMail.message).toBe(`Email sending failed: ${diagnostic}`);
  i18n!.setLanguage("zh");
  expect(confirmation.message).toBe(`确认邮件发送失败：${diagnostic}`);
  expect(testMail.message).toBe(`发送失败：${diagnostic}`);
});

it("keeps meaningful conflict messages and uses neutral fallback copy", () => {
  const detail = "自定义冲突诊断 ${0}";
  expect(errorFrom(409, { error: { code: "conflict", message: detail } }).message).toBe(detail);
  const generic = errorFrom(409, { error: { code: "conflict" } });
  expect(generic.message).not.toMatch(/data has changed|refresh/i);
  expect(generic.message).toContain("completed");
});

it("retains localized revocation guidance for invite and join-code limits", () => {
  for (const message of ["未使用的邀请太多了，请先作废一些", "有效的加入码太多了，请先作废一些"]) {
    const error = errorFrom(409, { error: { code: "conflict", message } });
    expect(error.message).toMatch(/revoke/i);
    i18n!.setLanguage("zh");
    expect(error.message).toBe(message);
    i18n!.setLanguage("en");
  }
});
