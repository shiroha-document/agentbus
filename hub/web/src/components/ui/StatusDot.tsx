import type { Member } from "../../types";
import { cn } from "../../lib/util";

export type PresenceState = "online" | "offline" | "paused" | "revoked" | "pending";

export function presenceOf(m: Pick<Member, "status" | "paused" | "online">): PresenceState {
  if (m.status === "revoked") return "revoked";
  if (m.status === "pending") return "pending";
  if (m.paused) return "paused";
  return m.online ? "online" : "offline";
}

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  online: "在线",
  offline: "离线",
  paused: "已暂停",
  revoked: "已吊销",
  pending: "待审批",
};

/** Status dot always paired with a text label (a11y: never colour-only). */
export function StatusDot({
  state,
  showLabel = true,
  className,
}: {
  state: PresenceState;
  showLabel?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption text-fg-caption", className)}>
      <span className="status-dot" data-state={state} aria-hidden />
      {showLabel ? <span>{PRESENCE_LABEL[state]}</span> : <span className="sr-only">{PRESENCE_LABEL[state]}</span>}
    </span>
  );
}
