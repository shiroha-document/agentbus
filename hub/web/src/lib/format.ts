import { t as tr, getLocale, getLanguage } from "./i18n";
// Number and time formatting follow the browser’s selected interface language.

/** Compact token count: 950, 1.2k, 34k, 1.2M, 3.4B. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 1000) return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(n);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [base, suffix] of units) {
    if (a >= base) {
      const v = a / base;
      const digits = v >= 100 ? 0 : v >= 10 ? 1 : 1;
      let s = v.toFixed(digits);
      if (s.includes(".")) s = s.replace(/\.0$/, "");
      // 999.95k would print "1000k"; roll over to next unit.
      if (Number(s) >= 1000 && suffix !== "B") return formatTokens(n < 0 ? -base * 1000 : base * 1000);
      return sign + s + suffix;
    }
  }
  return sign + String(a);
}

/** US dollars: $0, $0.0042, $0.12, $12.30, $1,234. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const digits = n === 0 || Math.abs(n) >= 1000 ? 0 : Math.abs(n) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(getLocale(), {
    style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(n);
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(n);
}

export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(n / 100);
}

/** Duration in ms → "850ms" / "12s" / "3分20秒" / "1小时5分". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return tr("{0}秒", [s]);
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? tr("{0}分{1}秒", [m, s % 60]) : tr("{0}分钟", [m]);
  const h = Math.floor(m / 60);
  return m % 60 ? tr("{0}小时{1}分", [h, m % 60]) : tr("{0}小时", [h]);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Relative past time: 刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:02 / 3 天前 / 2026-01-05. */
export function formatRelative(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return tr("从未");
  const diff = now - ts;
  if (diff < 0) return formatUntil(ts, now);
  if (diff < 45_000) return tr("刚刚");
  if (diff < HOUR) {
    const minutes = Math.max(1, Math.round(diff / MIN));
    return getLanguage() === "en" ? new Intl.RelativeTimeFormat(getLocale()).format(-minutes, "minute") : tr("{0} 分钟前", [minutes]);
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    return getLanguage() === "en" ? new Intl.RelativeTimeFormat(getLocale()).format(-hours, "hour") : tr("{0} 小时前", [hours]);
  }
  const d = new Date(ts);
  const n = new Date(now);
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= startOfToday - DAY) return tr("昨天 {0}:{1}", [pad(d.getHours()), pad(d.getMinutes())]);
  if (diff < 7 * DAY) {
    const days = Math.floor(diff / DAY);
    return getLanguage() === "en" ? new Intl.RelativeTimeFormat(getLocale()).format(-days, "day") : tr("{0} 天前", [days]);
  }
  return formatDate(ts);
}

/** Time remaining until ts: "剩 12 分钟" style without the 剩 prefix: 12 分钟 / 2 小时 5 分 / 3 天. */
export function formatUntil(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  if (diff <= 0) return tr("已到期");
  if (diff < MIN) return tr("不到 1 分钟");
  if (diff < HOUR) return tr("{0} 分钟", [Math.ceil(diff / MIN)]);
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    const m = Math.round((diff % HOUR) / MIN);
    return m ? tr("{0} 小时 {1} 分", [h, m]) : tr("{0} 小时", [h]);
  }
  const d = Math.floor(diff / DAY);
  const h = Math.round((diff % DAY) / HOUR);
  return h ? tr("{0} 天 {1} 小时", [d, h]) : tr("{0} 天", [d]);
}

export function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}

/** API calendar dates are local days, not UTC instants. Unknown labels pass through. */
export function formatCalendarDay(day: string, compact = false): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return day;
  const date = new Date(`${day}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(parts[1]) || date.getMonth() + 1 !== Number(parts[2]) || date.getDate() !== Number(parts[3])) return day;
  return compact ? new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" }).format(date) : formatDate(date.getTime());
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  return `${formatDate(ts)} ${formatTime(ts)}`;
}

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(ts);
}

export function greeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return tr("早上好");
  if (h >= 12 && h < 18) return tr("下午好");
  return tr("晚上好");
}

export function totalTokens(u: { input: number; cache_read: number; cache_write: number; output: number }): number {
  return u.input + u.cache_read + u.cache_write + u.output;
}
