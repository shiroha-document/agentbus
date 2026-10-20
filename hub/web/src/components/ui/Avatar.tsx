import { useState } from "react";
import { avatarGradient, avatarInitial } from "../../lib/avatar";
import { cn } from "../../lib/util";
import type { Member } from "../../types";

interface Props {
  member?: Pick<Member, "name" | "display_name" | "avatar_url"> | null;
  size?: number;
  className?: string;
  ring?: boolean;
}

export function Avatar({ member, size = 32, className, ring }: Props) {
  const [broken, setBroken] = useState(false);
  const name = member?.name ?? "?";
  const label = member?.display_name || name;
  const g = avatarGradient(name);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) };
  const url = member?.avatar_url;
  if (url && !broken && /^https:\/\//.test(url)) {
    return (
      <img
        src={url}
        alt={label}
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={cn("flex-none rounded-full object-cover", ring && "ring-2 ring-surface-strong", className)}
        style={style}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex flex-none select-none items-center justify-center rounded-full font-semibold",
        ring && "ring-2 ring-surface-strong",
        className,
      )}
      style={{
        ...style,
        backgroundImage: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`,
        color: "var(--avatar-ink)",
      }}
    >
      {avatarInitial(member?.display_name ?? "", name)}
    </span>
  );
}
