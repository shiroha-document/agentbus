// PWA: service-worker registration + the "install as app" prompt (Chromium's beforeinstallprompt).
// iOS Safari has no prompt API — the settings page shows "分享 → 添加到主屏幕" instead.
import { useSyncExternalStore } from "react";
import { track } from "./telemetry";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState = "installed" | "available" | "ios" | "unsupported";

const hasDom = typeof window !== "undefined" && typeof navigator !== "undefined";

/** Should the service worker be registered here? Not in dev, mock mode, or insecure contexts. */
export function shouldRegisterSW(env: { prod: boolean; mock: boolean }, nav: { serviceWorker?: unknown } | undefined, secure: boolean): boolean {
  return env.prod && !env.mock && secure && !!nav && "serviceWorker" in nav;
}

export function registerServiceWorker(): void {
  if (!hasDom) return;
  const ok = shouldRegisterSW({ prod: import.meta.env.PROD, mock: import.meta.env.VITE_MOCK === "1" }, navigator, window.isSecureContext);
  if (!ok) return;
  const go = () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* PWA is progressive: the site works the same without it */
    });
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

/** iPhone / iPad Safari (iPadOS reports as Mac with touch). */
export function isIOS(ua: string, maxTouchPoints: number): boolean {
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (!hasDom) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
let wired = false;

function emit() {
  listeners.forEach((fn) => fn());
}

function wire() {
  if (wired || !hasDom) return;
  wired = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own button in settings instead of the mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    track("pwa.installed", {});
    emit();
  });
}

export function installState(): InstallState {
  wire();
  if (installed || isStandalone()) return "installed";
  if (deferred) return "available";
  if (hasDom && isIOS(navigator.userAgent, navigator.maxTouchPoints || 0)) return "ios";
  return "unsupported";
}

export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  track("pwa.prompt", { outcome });
  emit();
  return outcome === "accepted";
}

function subscribe(fn: () => void) {
  wire();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, installState, () => "unsupported" as InstallState);
}

// Capture the event as early as possible (it can fire before React mounts).
wire();
