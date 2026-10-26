import { t as tr, useLanguage } from "../lib/i18n";
import { useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import { qk } from "../queries";
import { formatCalendarDay, formatInt, formatTokens, formatUsd, totalTokens } from "../lib/format";
import { cn } from "../lib/util";
import type { UsageGroup, UsageSeriesItem } from "../types";
import { AnimatedNumber } from "../components/ui/AnimatedNumber";
import { EmptyState } from "../components/ui/EmptyState";
import { QueryError } from "../components/layout/RouteStates";
import { useMemberMap } from "../components/threads";
import { RunsTable } from "./MemberDetail";

const SERIES = [
  { key: "input", get label() { return tr("输入"); }, color: "var(--chart-input)" },
  { key: "cache_read", get label() { return tr("缓存读"); }, color: "var(--chart-cache-read)" },
  { key: "cache_write", get label() { return tr("缓存写"); }, color: "var(--chart-cache-write)" },
  { key: "output", get label() { return tr("输出"); }, color: "var(--chart-output)" },
] as const;

const GROUPS: { value: UsageGroup; label: string }[] = [
  { value: "day", get label() { return tr("按天"); } },
  { value: "agent", get label() { return tr("按 agent"); } },
  { value: "thread", get label() { return tr("按讨论串"); } },
];

const RANGES = [7, 30, 90] as const;

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey?: unknown; value?: unknown; color?: string; name?: unknown }[]; label?: unknown }) {
  useLanguage();
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-3 rounded-[14px] px-3 py-2 text-caption">
      <div className="mb-1 font-medium text-fg">{String(label ?? "")}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="tabular flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} aria-hidden />
          <span className="text-fg-2">{String(p.name)}</span>
          <span className="ml-auto pl-3 text-fg">{p.dataKey === "cost" ? formatUsd(Number(p.value)) : formatTokens(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

function UsageChart({ series, group }: { series: UsageSeriesItem[]; group: UsageGroup }) {
  const language = useLanguage();
  const data = useMemo(
    () =>
      series.map((s) => ({
        ...s,
        label: group === "day" ? formatCalendarDay(s.label, true) : s.label,
      })),
    [series, group, language],
  );
  if (data.length === 0) return <EmptyState art="chart" compact title={tr("这段时间没有用量数据")} />;
  const axis = { stroke: "var(--chart-axis)", fontSize: 12, tickLine: false, axisLine: false } as const;
  return (
    <div className="h-[320px] w-full" role="img" aria-label={tr("token 用量和金额趋势图")}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={16} />
          <YAxis yAxisId="t" {...axis} tickFormatter={(v: number) => formatTokens(v)} width={48} />
          <YAxis yAxisId="c" orientation="right" {...axis} tickFormatter={(v: number) => formatUsd(v)} width={56} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--chart-grid)" }} />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--chart-axis)" }} iconType="circle" iconSize={8} />
          {SERIES.map((s) =>
            group === "day" ? (
              <Area
                key={s.key}
                yAxisId="t"
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stackId="tok"
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.55}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            ) : (
              <Bar key={s.key} yAxisId="t" dataKey={s.key} name={s.label} stackId="tok" fill={s.color} maxBarSize={36} isAnimationActive={false} />
            ),
          )}
          <Line
            yAxisId="c"
            type="monotone"
            dataKey="cost"
            name={tr("金额")}
            stroke="var(--chart-cost)"
            strokeWidth={2}
            dot={group !== "day"}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function SeriesTable({ series, group }: { series: UsageSeriesItem[]; group: UsageGroup }) {
  useLanguage();
  const rows = [...series].sort((a, b) => (group === "day" ? b.key.localeCompare(a.key) : totalTokens(b) - totalTokens(a)));
  if (rows.length === 0) return null;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-caption">
        <thead className="text-fg-caption">
          <tr className="border-b border-line">
            <th className="px-2 py-2 font-medium">{group === "day" ? tr("日期") : group === "agent" ? "agent" : tr("讨论串")}</th>
            {SERIES.map((s) => (
              <th key={s.key} className="px-2 py-2 text-right font-medium">
                {s.label}
              </th>
            ))}
            <th className="px-2 py-2 text-right font-medium">{tr("金额")}</th>
            <th className="px-2 py-2 text-right font-medium">{tr("轮次")}</th>
            <th className="px-2 py-2 text-right font-medium">{tr("失败")}</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line last:border-b-0">
              <td className="max-w-[220px] truncate px-2 py-2 text-fg">{group === "day" ? formatCalendarDay(r.label) : r.label}</td>
              {SERIES.map((s) => (
                <td key={s.key} className="px-2 py-2 text-right text-fg-2">
                  {formatTokens(r[s.key])}
                </td>
              ))}
              <td className="px-2 py-2 text-right">{formatUsd(r.cost)}</td>
              <td className="px-2 py-2 text-right">{formatInt(r.runs)}</td>
              <td className={cn("px-2 py-2 text-right", r.failed > 0 && "text-danger-text")}>{formatInt(r.failed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailedRuns() {
  useLanguage();
  const members = useMemberMap();
  const q = useInfiniteQuery({
    queryKey: qk.runs({ failed: true }),
    queryFn: ({ pageParam }) => api.runs({ failed: true, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.has_more ? last.runs[last.runs.length - 1]?.id : undefined),
  });
  const runs = q.data?.pages.flatMap((p) => p.runs) ?? [];
  return (
    <section className="glass-1 card p-5" aria-label={tr("失败的轮次")}>
      <h2 className="mb-3 text-title-2">{tr("失败的轮次")}</h2>
      {q.isPending ? (
        <div className="skeleton h-32" />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <RunsTable runs={runs} showMember memberName={(id) => members.get(id)?.display_name ?? id} />
          {q.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <button className="btn btn-ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? tr("加载中…") : tr("加载更多")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function UsagePage() {
  useLanguage();
  const [group, setGroup] = useState<UsageGroup>("day");
  const [days, setDays] = useState<number>(30);
  const members = useMemberMap();
  const q = useQuery({ queryKey: qk.usage(group, days), queryFn: () => api.usage(group, days), placeholderData: (prev) => prev });
  const totals = q.data?.totals;
  const baseline = q.data?.baseline ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-title-1">{tr("用量")}</h1>
        <div className="ml-auto flex gap-1 rounded-[12px] bg-mint-100/60 p-1" role="group" aria-label={tr("时间范围")}>
          {RANGES.map((r) => (
            <button
              key={r}
              aria-pressed={days === r}
              className={cn("h-8 rounded-[9px] px-3 text-callout transition-colors", days === r ? "bg-surface-solid text-fg shadow-1" : "text-fg-2 hover:text-fg")}
              onClick={() => setDays(r)}
            >
              {r}{" "}{tr("天")}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: tr("总 tokens"), value: totals ? totalTokens(totals) : 0, fmt: formatTokens },
          { label: tr("金额（估算）"), value: totals?.cost ?? 0, fmt: formatUsd },
          { label: tr("轮次"), value: totals?.runs ?? 0, fmt: formatInt },
          { label: tr("失败轮次"), value: totals?.failed ?? 0, fmt: formatInt, danger: (totals?.failed ?? 0) > 0 },
        ].map((s) => (
          <div key={s.label} className="glass-1 card p-5">
            <div className="text-caption text-fg-caption">{s.label}</div>
            <div className={cn("mt-1 text-title-1", s.danger && "text-danger-text")}>
              {totals ? <AnimatedNumber value={s.value} format={s.fmt} /> : <span className="skeleton inline-block h-8 w-20" />}
            </div>
          </div>
        ))}
      </div>

      <Tabs.Root value={group} onValueChange={(v) => setGroup(v as UsageGroup)} className="glass-1 card p-5">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-title-2">{tr("趋势")}</h2>
          <Tabs.List className="ml-auto flex gap-1 rounded-[12px] bg-mint-100/60 p-1" aria-label={tr("分组方式")}>
            {GROUPS.map((g) => (
              <Tabs.Trigger
                key={g.value}
                value={g.value}
                className="h-8 rounded-[9px] px-3 text-callout text-fg-2 transition-colors hover:text-fg data-[state=active]:bg-surface-solid data-[state=active]:text-fg data-[state=active]:shadow-1"
              >
                {g.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </div>
        {GROUPS.map((g) => (
          <Tabs.Content key={g.value} value={g.value} className="flex flex-col gap-5 outline-none">
            {q.isError ? (
              <QueryError error={q.error} onRetry={() => void q.refetch()} />
            ) : !q.data ? (
              <div className="skeleton h-[320px]" />
            ) : (
              <>
                <UsageChart series={q.data.series} group={group} />
                <SeriesTable series={q.data.series} group={group} />
              </>
            )}
          </Tabs.Content>
        ))}
      </Tabs.Root>

      <section className="glass-1 card p-5" aria-label={tr("固定开销")}>
        <h2 className="text-title-2">{tr("固定开销")}</h2>
        <p className="mb-3 mt-1 text-caption text-fg-caption">{tr("每个 agent 每轮的系统提示、工具定义等基础 token（agentbus usage baseline 上报）。")}</p>
        {baseline.length === 0 ? (
          <p className="text-callout font-normal text-fg-3">{tr("还没有基线数据")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(() => {
              const max = Math.max(...baseline.map((b) => b.tokens), 1);
              return [...baseline]
                .sort((a, b) => b.tokens - a.tokens)
                .map((b) => (
                  <li key={b.member_id} className="flex items-center gap-3 text-callout">
                    <span className="w-28 truncate font-normal">{members.get(b.member_id)?.display_name ?? b.member_id}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-mint-100">
                      <span className="block h-full rounded-full bg-mint-500" style={{ width: `${(b.tokens / max) * 100}%` }} />
                    </span>
                    <span className="tabular w-16 text-right text-fg-2">{formatTokens(b.tokens)}</span>
                  </li>
                ));
            })()}
          </ul>
        )}
      </section>

      <FailedRuns />
    </div>
  );
}
