// Version badge + changelog dialog (contract §6). One dialog instance is mounted by the layout;
// anything (palette, About page, badge) opens it through `openChangelog()`.
import { lazy, Suspense, useSyncExternalStore } from "react";
import { Sparkles } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Tip } from "../ui/Tip";
import { cn } from "../../lib/util";
import { track } from "../../lib/telemetry";
import { APP_VERSION, SEEN_VERSION_KEY, hasUnseenVersion } from "../../lib/version";
import { CHANGELOG_BODY } from "../../lib/changelog";

const Markdown = lazy(() => import("../Markdown"));

// ---------------------------------------------------------------- store

interface State {
  open: boolean;
  unseen: boolean;
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_VERSION_KEY);
  } catch {
    return APP_VERSION; // storage disabled: never nag
  }
}

let state: State = { open: false, unseen: hasUnseenVersion(APP_VERSION, readSeen()) };
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getState = () => state;

export function openChangelog(): void {
  try {
    localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION);
  } catch {
    /* ignore */
  }
  track("changelog.open", {});
  set({ open: true, unseen: false });
}

export function useChangelog(): State & { setOpen: (o: boolean) => void } {
  const s = useSyncExternalStore(subscribe, getState, getState);
  return { ...s, setOpen: (o) => (o ? openChangelog() : set({ open: false })) };
}

// ---------------------------------------------------------------- UI

export function ChangelogDialog() {
  const { open, setOpen } = useChangelog();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="更新日志"
      description={`当前版本 v${APP_VERSION}`}
      wide
    >
      <Suspense fallback={<div className="skeleton h-40 w-full" aria-label="加载中" />}>
        <Markdown className="changelog pb-2">{CHANGELOG_BODY || "暂无更新日志"}</Markdown>
      </Suspense>
    </Dialog>
  );
}

/** "新" dot next to anything that opens the changelog. */
export function NewDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex h-[18px] items-center rounded-full bg-mint-500 px-1.5 text-[11px] font-semibold leading-none text-[var(--mint-950)]", className)}
    >
      新
    </span>
  );
}

/** Sidebar footer badge: `v0.6.0` (+ "新" when the changelog of this version wasn't opened yet). */
export function VersionBadge({ collapsed }: { collapsed?: boolean }) {
  const { unseen } = useChangelog();
  const label = unseen ? `版本 v${APP_VERSION}，有新的更新日志` : `版本 v${APP_VERSION}，查看更新日志`;
  const btn = (
    <button
      type="button"
      onClick={openChangelog}
      aria-label={label}
      className={cn(
        "relative flex h-9 w-full items-center gap-2 rounded-[12px] text-caption text-fg-caption transition-colors hover:bg-mint-100 hover:text-fg",
        collapsed ? "justify-center px-0" : "px-3",
      )}
    >
      <Sparkles size={collapsed ? 18 : 14} aria-hidden className={unseen ? "text-mint-700" : undefined} />
      {!collapsed && <span className="tabular flex-1 text-left">v{APP_VERSION}</span>}
      {unseen && !collapsed && <NewDot />}
      {unseen && collapsed && <span className="absolute right-2.5 top-1.5 h-2 w-2 rounded-full bg-mint-500" aria-hidden />}
    </button>
  );
  return collapsed ? (
    <Tip content={unseen ? `v${APP_VERSION} · 有更新` : `v${APP_VERSION} · 更新日志`} side="right">
      {btn}
    </Tip>
  ) : (
    btn
  );
}
