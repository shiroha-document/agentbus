import { useState } from "react";
import { Bot } from "lucide-react";
import { avatarGradient, avatarInitial } from "../../lib/avatar";
import { cn } from "../../lib/util";
import type { Member } from "../../types";

interface Props {
  member?: Pick<Member, "name" | "display_name" | "avatar_url"> & Partial<Pick<Member, "kind">> | null;
  size?: number;
  className?: string;
  ring?: boolean;
}

export function Avatar({ member, size = 32, className, ring }: Props) {
  const name = member?.name ?? "?";
  const label = member?.display_name || name;
  const kind = member?.kind;
  const knownKind = kind === "human" || kind === "agent" ? kind : undefined;
  const g = avatarGradient(name);
  return (
    <span
      role="img"
      aria-label={knownKind ? `${knownKind} · ${label}` : label}
      className={cn(
        "relative inline-flex flex-none select-none items-center justify-center font-semibold",
        knownKind === "human" && "rounded-full",
        !knownKind && "rounded-md bg-surface-strong text-fg-3",
        ring && "ring-2 ring-surface-strong",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.42)),
        ...(knownKind === "agent" ? { borderRadius: Math.min(8, size * 0.25) } : {}),
        ...(knownKind ? {
          backgroundImage: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`,
          color: "var(--avatar-ink)",
        } : {}),
      }}
    >
      <AvatarContent key={member?.avatar_url ?? ""} url={member?.avatar_url} agent={knownKind === "agent"} size={size}
        initial={avatarInitial(member?.display_name ?? "", name)} />
    </span>
  );
}

/** The URL key resets a failed image when the member changes their avatar. */
function AvatarContent({ url, agent, size, initial }: { url?: string | null; agent: boolean; size: number; initial: string }) {
  const [broken, setBroken] = useState(false);
  let valid = false;
  if (url) {
    try {
      valid = new URL(url).protocol === "https:";
    } catch {
      // Invalid URLs use the same category fallback as a failed image.
    }
  }
  if (!url || !valid || broken) return agent ? <Bot size={Math.round(size * 0.62)} aria-hidden /> : initial;
  const markerSize = size <= 20 ? 8 : Math.max(12, Math.round(size * 0.34));
  return (
    <>
      <img src={url} alt="" aria-hidden width={size} height={size} referrerPolicy="no-referrer"
        onError={() => setBroken(true)} className="h-full w-full object-cover [border-radius:inherit]" />
      {agent ? (
        <span className="absolute -bottom-0.5 -right-0.5 inline-flex items-center justify-center rounded-sm bg-surface-strong text-fg ring-1 ring-surface"
          style={{ width: markerSize + 2, height: markerSize + 2 }} aria-hidden>
          <Bot size={markerSize} strokeWidth={2.5} />
        </span>
      ) : null}
    </>
  );
}
