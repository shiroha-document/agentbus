import { t as tr } from "./i18n";
import type { QuotaReading } from "../types";

export type QuotaLevel = "ok" | "warn" | "danger" | "unknown";

/** ui-guidelines §7: 0–70% mint, 70–90% warning, ≥90% danger. */
export function quotaLevel(pct: number | null | undefined): QuotaLevel {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "unknown";
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warn";
  return "ok";
}

export function quotaColorVar(level: QuotaLevel): string {
  switch (level) {
    case "danger":
      return "var(--danger)";
    case "warn":
      return "var(--warning)";
    case "unknown":
      return "var(--text-3)";
    default:
      return "var(--mint-500)";
  }
}

export function clampPct(pct: number | null | undefined): number {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

export const WINDOW_LABEL: Record<string, string> = {
  get "5h"() { return tr("5 小时"); },
  get "7d"() { return tr("7 天"); },
  get monthly() { return tr("本月"); },
  get daily() { return tr("今日"); },
  get balance() { return tr("余额"); },
  get "*"() { return tr("全部窗口"); },
};

export function windowLabel(w: string): string {
  return WINDOW_LABEL[w] ?? w;
}

export interface QuotaGroup {
  key: string;
  provider: string;
  account: string | null;
  window: string;
  readings: QuotaReading[]; // 1 normally; 2 when both native and magpie report (quota.source=both)
  /** both sources present and their used_pct differ by more than 5 points */
  divergent: boolean;
}

/** Group readings by provider+account+window so native/magpie pairs render side by side. */
export function groupQuota(readings: QuotaReading[]): QuotaGroup[] {
  const map = new Map<string, QuotaGroup>();
  for (const r of readings) {
    const key = `${r.provider}|${r.account ?? ""}|${r.window}`;
    let g = map.get(key);
    if (!g) {
      g = { key, provider: r.provider, account: r.account, window: r.window, readings: [], divergent: false };
      map.set(key, g);
    }
    g.readings.push(r);
  }
  for (const g of map.values()) {
    const n = g.readings.find((r) => r.source === "native");
    const m = g.readings.find((r) => r.source === "magpie");
    if (n && m && n.used_pct !== null && m.used_pct !== null) g.divergent = Math.abs(n.used_pct - m.used_pct) > 5;
    g.readings.sort((a, b) => (a.source === "native" ? -1 : 1) - (b.source === "native" ? -1 : 1));
  }
  return [...map.values()];
}

/** Highest used_pct across readings (null if none known). */
export function maxQuotaPct(readings: QuotaReading[]): number | null {
  let max: number | null = null;
  for (const r of readings) if (r.used_pct !== null && (max === null || r.used_pct > max)) max = r.used_pct;
  return max;
}
