import { getLocale } from "./i18n";
import type { HeatmapDay } from "../types";

// GitHub-style heatmap layout: columns are weeks (Mon..Sun rows), grouped by month labels.

export interface HeatCell {
  day: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  inRange: boolean;
}

export interface HeatLayout {
  weeks: HeatCell[][]; // each week has 7 cells, Monday first
  months: { label: string; col: number }[];
  max: number;
  total: number;
}

function ymd(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r > 0.75) return 4;
  if (r > 0.5) return 3;
  if (r > 0.25) return 2;
  return 1;
}

/** Build a grid ending at `end` (inclusive) spanning `days` days. */
export function buildHeatmap(data: HeatmapDay[], end: Date = new Date(), days = 365): HeatLayout {
  const counts = new Map<string, number>();
  for (const d of data) counts.set(d.day, (counts.get(d.day) ?? 0) + d.count);
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const first = new Date(last);
  first.setDate(first.getDate() - (days - 1));
  // Align start to Monday.
  const start = new Date(first);
  const dow = (start.getDay() + 6) % 7; // 0 = Monday
  start.setDate(start.getDate() - dow);

  let max = 0;
  let total = 0;
  for (const [k, v] of counts) {
    const t = new Date(`${k}T00:00:00`).getTime();
    if (t >= first.getTime() && t <= last.getTime()) {
      max = Math.max(max, v);
      total += v;
    }
  }

  const weeks: HeatCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const cur = new Date(start);
  while (cur.getTime() <= last.getTime()) {
    const week: HeatCell[] = [];
    for (let i = 0; i < 7; i++) {
      const key = ymd(cur);
      const inRange = cur.getTime() >= first.getTime() && cur.getTime() <= last.getTime();
      const count = inRange ? (counts.get(key) ?? 0) : 0;
      week.push({ day: key, count, level: inRange ? heatLevel(count, max) : 0, inRange });
      // A month is labelled on the column containing its 1st day; the very first
      // column is labelled with the month of its first in-range day.
      if (inRange && (cur.getDate() === 1 || weeks.length === 0) && !months.some((m) => m.col === weeks.length)) {
        months.push({ label: new Intl.DateTimeFormat(getLocale(), { month: "short" }).format(cur), col: weeks.length });
      }
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  // Drop a leading label if it would collide with the next one.
  if (months.length > 1 && months[1]!.col - months[0]!.col < 3) months.shift();
  return { weeks, months, max, total };
}
