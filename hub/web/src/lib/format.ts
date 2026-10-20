// Number / time formatting helpers. Pure, locale-stable (zh-CN copy).

/** Compact token count: 950, 1.2k, 34k, 1.2M, 3.4B. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 1000) return sign + String(Math.round(a));
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
  if (n === 0) return "$0";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a < 0.01) return `${sign}$${a.toFixed(4)}`;
  if (a < 1000) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function formatPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}

/** Duration in ms → "850ms" / "12s" / "3分20秒" / "1小时5分". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}分${s % 60}秒` : `${m}分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}小时${m % 60}分` : `${h}小时`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Relative past time: 刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:02 / 3 天前 / 2026-01-05. */
export function formatRelative(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "从未";
  const diff = now - ts;
  if (diff < 0) return formatUntil(ts, now);
  if (diff < 45_000) return "刚刚";
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MIN))} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  const d = new Date(ts);
  const n = new Date(now);
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (ts >= startOfToday - DAY) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return formatDate(ts);
}

/** Time remaining until ts: "剩 12 分钟" style without the 剩 prefix: 12 分钟 / 2 小时 5 分 / 3 天. */
export function formatUntil(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  if (diff <= 0) return "已到期";
  if (diff < MIN) return "不到 1 分钟";
  if (diff < HOUR) return `${Math.ceil(diff / MIN)} 分钟`;
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    const m = Math.round((diff % HOUR) / MIN);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  const d = Math.floor(diff / DAY);
  const h = Math.round((diff % DAY) / HOUR);
  return h ? `${d} 天 ${h} 小时` : `${d} 天`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return "—";
  const d = new Date(ts);
  return `${formatDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function greeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "早上好";
  if (h >= 12 && h < 18) return "下午好";
  return "晚上好";
}

export function totalTokens(u: { input: number; cache_read: number; cache_write: number; output: number }): number {
  return u.input + u.cache_read + u.cache_write + u.output;
}
