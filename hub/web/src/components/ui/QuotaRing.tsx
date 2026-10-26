import { t as tr, useLanguage } from "../../lib/i18n";
import { motion, useReducedMotion } from "motion/react";
import type { QuotaGroup } from "../../lib/quota";
import { clampPct, quotaColorVar, quotaLevel, windowLabel } from "../../lib/quota";
import { formatPct, formatUntil, formatRelative } from "../../lib/format";
import { cn } from "../../lib/util";
import { Tip } from "./Tip";

interface RingProps {
  pct: number | null;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}

/** Circular progress ring. Fills from 0 on first mount over 600ms. */
export function Ring({ pct, size = 56, stroke = 5, children }: RingProps) {
  useLanguage();
  const reduced = useReducedMotion() ?? false;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = clampPct(pct) / 100;
  const color = quotaColorVar(quotaLevel(pct));
  return (
    <div className="relative inline-flex flex-none items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--mint-200)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - value) }}
          transition={reduced ? { duration: 0.12 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

/** One provider/window: ring + label + source badge(s). */
export function QuotaRing({ group, size = 56 }: { group: QuotaGroup; size?: number }) {
  useLanguage();
  const primary = group.readings[0]!;
  const pct = primary.used_pct;
  const level = quotaLevel(pct);
  const isBalance = primary.window === "balance" || (pct === null && primary.balance);
  const tipLines = group.readings.map((r) => {
    const parts = [`${r.source === "native" ? tr("原生") : "magpie"}：${r.used_pct !== null ? formatPct(r.used_pct) : r.balance ? `${r.balance.amount} ${r.balance.currency}` : tr("未知")}`];
    if (r.resets_at) parts.push(tr("{0}后重置", [formatUntil(r.resets_at)]));
    parts.push(tr("读取于 {0}", [formatRelative(r.read_at)]));
    if (r.error) parts.push(tr("错误：{0}", [r.error]));
    return parts.join(" · ");
  });
  return (
    <Tip
      content={
        <div className="space-y-0.5">
          <div className="font-medium">
            {group.provider}
            {group.account ? ` · ${group.account}` : ""}
            {primary.plan ? ` · ${primary.plan}` : ""} · {windowLabel(group.window)}
          </div>
          {tipLines.map((l) => (
            <div key={l}>{l}</div>
          ))}
          {group.divergent ? <div className="text-warning-text">{tr("两个来源读数相差超过 5 个百分点")}</div> : null}
        </div>
      }
    >
      <div
        className="flex w-[76px] flex-col items-center gap-1.5 rounded-[14px] px-1 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-mint-500"
        tabIndex={0}
        aria-label={tr("{0} {1} 已用 {2}", [group.provider, windowLabel(group.window), pct === null ? tr("未知") : formatPct(pct)])}
      >
        <div className="relative">
          <Ring pct={isBalance ? null : pct} size={size}>
            <span
              className={cn(
                "tabular text-callout",
                level === "danger" ? "text-danger-text" : level === "warn" ? "text-warning-text" : "text-fg",
              )}
            >
              {isBalance && primary.balance
                ? `${Math.round(primary.balance.amount)}`
                : pct === null
                  ? "?"
                  : `${Math.round(pct)}`}
              {!isBalance && pct !== null ? <span className="text-[10px] text-fg-caption">%</span> : null}
            </span>
          </Ring>
          <span className="absolute -bottom-0.5 -right-1.5 flex gap-0.5">
            {group.readings.map((r) => (
              <span
                key={r.source}
                className={cn(
                  "rounded-full px-1 text-[9px] font-semibold leading-[14px]",
                  group.divergent ? "chip-warning" : "bg-surface-strong text-fg-2 ring-1 ring-line",
                )}
                title={r.source === "native" ? tr("原生读数") : tr("magpie 读数")}
              >
                {r.source === "native" ? tr("原生") : "mp"}
              </span>
            ))}
          </span>
        </div>
        <div className="max-w-full truncate text-center text-caption text-fg-caption">
          <span className="text-fg-2">{group.provider}</span> {windowLabel(group.window)}
        </div>
      </div>
    </Tip>
  );
}
