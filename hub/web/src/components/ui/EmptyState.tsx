import type { ReactNode } from "react";
import { cn } from "../../lib/util";

type Art = "inbox" | "threads" | "agents" | "chart" | "search" | "folder" | "list";

/** Small mint line illustrations for empty states (inline SVG, no external assets). */
function Illustration({ art }: { art: Art }) {
  const common = {
    fill: "none",
    stroke: "var(--mint-500)",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg width="120" height="88" viewBox="0 0 120 88" aria-hidden>
      <ellipse cx="60" cy="78" rx="40" ry="5" fill="var(--mint-100)" />
      {art === "inbox" && (
        <g {...common}>
          <path d="M28 46 38 22h44l10 24v20a4 4 0 0 1-4 4H32a4 4 0 0 1-4-4z" />
          <path d="M28 46h18l4 8h20l4-8h18" />
          <path d="M52 30h16M50 37h20" stroke="var(--mint-300)" />
        </g>
      )}
      {art === "threads" && (
        <g {...common}>
          <rect x="26" y="18" width="52" height="32" rx="10" />
          <path d="M38 50v10l10-10" />
          <rect x="54" y="34" width="42" height="26" rx="9" fill="var(--mint-50)" />
          <path d="M84 60v8l-8-8" />
          <path d="M36 30h28M36 38h18M64 45h22" stroke="var(--mint-300)" />
        </g>
      )}
      {art === "agents" && (
        <g {...common}>
          <rect x="34" y="24" width="52" height="38" rx="14" />
          <path d="M60 24v-8M56 14h8" />
          <circle cx="49" cy="42" r="3" />
          <circle cx="71" cy="42" r="3" />
          <path d="M52 52c4 3 12 3 16 0" stroke="var(--mint-300)" />
          <path d="M34 40h-6M86 40h6" />
        </g>
      )}
      {art === "chart" && (
        <g {...common}>
          <path d="M26 66h70M26 66V18" />
          <path d="M30 56 46 44l12 8 18-20 14 8" />
          <path d="M30 62 46 54l12 4 18-10 14 4" stroke="var(--mint-300)" />
        </g>
      )}
      {art === "search" && (
        <g {...common}>
          <circle cx="54" cy="40" r="18" />
          <path d="m67 53 16 16" />
          <path d="M46 40h16" stroke="var(--mint-300)" />
        </g>
      )}
      {art === "folder" && (
        <g {...common}>
          <path d="M26 28a4 4 0 0 1 4-4h18l6 6h36a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H30a4 4 0 0 1-4-4z" />
          <path d="M26 38h68" stroke="var(--mint-300)" />
        </g>
      )}
      {art === "list" && (
        <g {...common}>
          <rect x="30" y="16" width="60" height="52" rx="10" />
          <path d="M42 30h36M42 42h36M42 54h22" stroke="var(--mint-300)" />
        </g>
      )}
    </svg>
  );
}

export function EmptyState({
  art = "inbox",
  title,
  action,
  className,
  compact,
}: {
  art?: Art;
  title: string;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "py-6" : "py-12", className)}>
      <Illustration art={art} />
      <p className="text-callout font-normal text-fg-2">{title}</p>
      {action}
    </div>
  );
}
