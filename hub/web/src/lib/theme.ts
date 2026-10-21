// Light / dark / system theme. The preference lives in localStorage["agentbus.theme"];
// <html data-theme> always carries the RESOLVED theme (light|dark) so CSS only needs one
// selector. public/theme-init.js applies the same logic before first paint.
import { useSyncExternalStore } from "react";
import { track } from "./telemetry";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "agentbus.theme";
export const THEME_PREFS: readonly ThemePref[] = ["light", "dark", "system"];
export const THEME_LABEL: Record<ThemePref, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

export function parseThemePref(v: unknown): ThemePref {
  return v === "light" || v === "dark" ? v : "system";
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

/** light → dark → system → light (command palette "切换主题"). */
export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === "light" ? "dark" : pref === "dark" ? "system" : "light";
}

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";

function readPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function media(): MediaQueryList | null {
  return hasDom && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
}

interface Snapshot {
  pref: ThemePref;
  resolved: ResolvedTheme;
}

let snap: Snapshot = { pref: "system", resolved: "light" };
const listeners = new Set<() => void>();
let installed = false;

function apply(): void {
  const pref = readPref();
  const resolved = resolveTheme(pref, media()?.matches ?? false);
  if (hasDom) {
    const el = document.documentElement;
    el.dataset.theme = resolved;
    el.style.colorScheme = resolved;
  }
  if (pref !== snap.pref || resolved !== snap.resolved) {
    snap = { pref, resolved };
    listeners.forEach((fn) => fn());
  }
}

function install(): void {
  if (installed || !hasDom) return;
  installed = true;
  apply();
  media()?.addEventListener?.("change", apply);
  // Another tab changed the preference.
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY) apply();
  });
}

export function getTheme(): Snapshot {
  install();
  return snap;
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage disabled: still apply for this page */
  }
  const before = snap.pref;
  install();
  apply();
  if (hasDom && snap.pref !== pref) {
    // Storage failed — apply in-memory.
    const resolved = resolveTheme(pref, media()?.matches ?? false);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    snap = { pref, resolved };
    listeners.forEach((fn) => fn());
  }
  if (before !== pref) track("theme.change", { theme: pref });
}

function subscribe(fn: () => void): () => void {
  install();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const serverSnap: Snapshot = { pref: "system", resolved: "light" };

export function useTheme(): Snapshot & { setPref: (p: ThemePref) => void } {
  const s = useSyncExternalStore(subscribe, getTheme, () => serverSnap);
  return { ...s, setPref: setThemePref };
}
