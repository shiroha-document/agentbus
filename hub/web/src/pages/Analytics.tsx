// 数据统计 (owner / admin only): product analytics from the events table (contract §5).
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Bot, Clock3, LineChart as LineIcon, MessageSquare, PlayCircle, ShieldAlert, Terminal, Users, XCircle } from "lucide-react";
import { api, ApiError } from "../api";
import { useRole } from "../queries";
import { formatDuration, formatInt } from "../lib/format";
import { cliLabel } from "../lib/cli";
import { cn } from "../lib/util";
import { telemetryEnabled } from "../lib/telemetry";
import type { AnalyticsResponse } from "../types";
import { AnimatedNumber } from "../components/ui/AnimatedNumber";
import { EmptyState } from "../components/ui/EmptyState";
import { QueryError } from "../components/layout/RouteStates";

const RANGES = [7, 30, 90] as const;

const SOURCES = [
  { key: "web", label: "网页", color: "var(--chart-input)" },
  { key: "cli", label: "命令行", color: "var(--chart-cache-write)" },
  { key: "hub", label: "服务端", color: "var(--chart-cache-read)" },
] as const;

const SOURCE_LABEL: Record<string, string> = { web: "网页", cli: "命令行", hub: "服务端" };

/** Readable hints for the event names in contract §5 (unknown names are shown raw). */
const EVENT_LABEL: Record<string, string> = {
  "page.view": "页面浏览",
  "post.create": "发帖",
  "composer.mention": "输入框 @",
  "composer.attach": "添加附件",
  "palette.open": "打开搜索",
  "palette.select": "搜索选择",
  "theme.change": "切换主题",
  "pwa.installed": "安装为应用",
  "pwa.prompt": "安装提示",
  "thread.jump": "讨论串跳转",
  "confirm.decide": "处理确认",
  "changelog.open": "查看更新日志",
  "agent.add_open": "打开添加 agent",
  "cli.command": "CLI 命令",
  "cli.tick": "CLI 轮询",
  "cli.setup": "CLI 初始化",
  "cli.update": "CLI 自动更新",
  "delivery.claim": "agent 领取消息",
  "delivery.done": "agent 完成投递",
  "member.join": "成员加入",
};

const KIND_LABEL: Record<string, string> = { msg: "消息", progress: "进度", confirm: "确认", system: "系统", state: "目标 / 状态" };

const PAGE_LABEL: Record<string, string> = {
  "/": "动态",
  "/workspaces": "工作区",
  "/workspaces/$id": "工作区详情",
  "/threads/$id": "讨论串",
  "/members": "成员",
  "/members/$id": "成员详情",
  "/usage": "用量",
  "/analytics": "数据统计",
  "/settings": "设置",
  "/about": "关于",
  "/invite/$token": "邀请链接",
};

// ---------------------------------------------------------------- building blocks

function Section({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  const id = `an-${title}`;
  return (
    <section className={cn("glass-1 card p-5", className)} aria-labelledby={id}>
      <h2 id={id} className="text-title-2">
        {title}
      </h2>
      {hint ? <p className="mt-1 text-caption text-fg-caption">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Kpi({ label, value, icon: Icon, danger, sub }: { label: string; value: number | undefined; icon: typeof Users; danger?: boolean; sub?: string }) {
  return (
    <div className="glass-1 card p-5">
      <div className="flex items-center gap-1.5 text-caption text-fg-caption">
        <Icon size={14} aria-hidden /> {label}
      </div>
      <div className={cn("mt-1 text-title-1", danger && "text-danger-text")}>
        {value === undefined ? <span className="skeleton inline-block h-8 w-16" /> : <AnimatedNumber value={value} format={formatInt} />}
      </div>
      {sub ? <div className="mt-0.5 text-caption text-fg-caption">{sub}</div> : null}
    </div>
  );
}

/** Horizontal share bars (pages, clients, kinds). */
function BarList({ rows, empty }: { rows: { key: string; label: ReactNode; sub?: string; n: number }[]; empty: string }) {
  if (rows.length === 0) return <p className="text-callout font-normal text-fg-3">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.n), 1);
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="text-callout">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-normal text-fg">{r.label}</span>
            {r.sub ? <span className="truncate font-mono text-caption text-fg-caption">{r.sub}</span> : null}
            <span className="tabular flex-none text-fg-2">{formatInt(r.n)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-mint-100" aria-hidden>
            <div className="h-full rounded-full bg-mint-500" style={{ width: `${Math.max(2, (r.n / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cn("px-2 py-2 font-medium", right && "text-right")}>{children}</th>;
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey?: unknown; value?: unknown; color?: string; name?: unknown }[]; label?: unknown }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-3 rounded-[14px] px-3 py-2 text-caption">
      <div className="mb-1 font-medium text-fg">{String(label ?? "")}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="tabular flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} aria-hidden />
          <span className="text-fg-2">{String(p.name)}</span>
          <span className="ml-auto pl-3 text-fg">{formatInt(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

function DailyChart({ daily }: { daily: AnalyticsResponse["daily"] }) {
  const data = useMemo(() => daily.map((d) => ({ ...d, label: d.day.replace(/^\d{4}-/, "") })), [daily]);
  const empty = data.every((d) => d.web + d.cli + d.hub + d.posts === 0);
  if (data.length === 0 || empty) return <EmptyState art="chart" compact title="这段时间还没有事件" />;
  const axis = { stroke: "var(--chart-axis)", fontSize: 12, tickLine: false, axisLine: false } as const;
  return (
    <div className="h-[300px] w-full" role="img" aria-label="每日事件数（按来源）与发帖数趋势图">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={16} />
          <YAxis yAxisId="e" {...axis} width={44} tickFormatter={(v: number) => formatInt(v)} />
          <YAxis yAxisId="p" orientation="right" {...axis} width={36} tickFormatter={(v: number) => formatInt(v)} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--chart-grid)" }} />
          <Legend wrapperStyle={{ fontSize: 12, color: "var(--chart-axis)" }} iconType="circle" iconSize={8} />
          {SOURCES.map((s) => (
            <Bar key={s.key} yAxisId="e" dataKey={s.key} name={s.label} stackId="ev" fill={s.color} maxBarSize={28} isAnimationActive={false} />
          ))}
          <Line yAxisId="p" type="monotone" dataKey="posts" name="发帖" stroke="var(--chart-cost)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function LatencyTile({ label, p50, p90, hint }: { label: string; p50: number | null; p90: number | null; hint: string }) {
  return (
    <div className="rounded-[16px] bg-mint-50 p-4">
      <div className="flex items-center gap-1.5 text-caption text-fg-caption">
        <Clock3 size={14} aria-hidden /> {label}
      </div>
      <div className="mt-2 flex items-baseline gap-4">
        <div>
          <div className="text-caption text-fg-caption">P50</div>
          <div className="tabular text-title-2">{formatDuration(p50)}</div>
        </div>
        <div>
          <div className="text-caption text-fg-caption">P90</div>
          <div className="tabular text-title-2 text-fg-2">{formatDuration(p90)}</div>
        </div>
      </div>
      <p className="mt-2 text-caption text-fg-caption">{hint}</p>
    </div>
  );
}

function Forbidden() {
  return (
    <div className="glass-1 card flex flex-col items-center gap-3 px-6 py-14 text-center" role="status">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-mint-100 text-mint-700">
        <ShieldAlert size={26} aria-hidden />
      </span>
      <h2 className="text-title-2">只有团队所有者和管理员可以查看数据统计</h2>
      <p className="max-w-md text-callout font-normal text-fg-2">
        统计包含整个团队的使用情况。如果你需要这些数据，请联系团队管理员为你调整角色。
      </p>
      <Link to="/" className="btn btn-secondary mt-1">
        回到动态
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------- page

export function AnalyticsPage() {
  const { isAdmin, role } = useRole();
  const [days, setDays] = useState<number>(30);
  const q = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => api.analytics(days),
    enabled: isAdmin,
    placeholderData: (prev) => prev,
  });
  const forbidden = (role !== null && !isAdmin) || (q.error instanceof ApiError && q.error.status === 403);
  const d = q.data;
  const t = d?.totals;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-title-1">数据统计</h1>
          <p className="mt-0.5 text-callout font-normal text-fg-2">团队怎么使用 agentbus：活跃度、命令、页面和响应速度。</p>
        </div>
        {!forbidden && (
          <div className="ml-auto flex gap-1 rounded-[12px] bg-mint-100/60 p-1" role="group" aria-label="时间范围">
            {RANGES.map((r) => (
              <button
                key={r}
                aria-pressed={days === r}
                className={cn("h-8 rounded-[9px] px-3 text-callout transition-colors", days === r ? "bg-surface-solid text-fg shadow-1" : "text-fg-2 hover:text-fg")}
                onClick={() => setDays(r)}
              >
                {r} 天
              </button>
            ))}
          </div>
        )}
      </div>

      {forbidden ? (
        <Forbidden />
      ) : q.isError && !d ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {!telemetryEnabled() && (
            <p className="chip chip-info self-start">你已在「设置 → 偏好」关闭匿名使用统计，你自己的网页操作不会计入。</p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="事件" value={t?.events} icon={Activity} />
            <Kpi label="活跃成员" value={t?.active_humans} icon={Users} />
            <Kpi label="活跃 agent" value={t?.active_agents} icon={Bot} />
            <Kpi label="帖子" value={t?.posts} icon={MessageSquare} />
            <Kpi label="运行轮次" value={t?.runs} icon={PlayCircle} />
            <Kpi
              label="失败轮次"
              value={t?.failed_runs}
              icon={XCircle}
              danger={(t?.failed_runs ?? 0) > 0}
              sub={t && t.runs > 0 ? `失败率 ${((t.failed_runs / t.runs) * 100).toFixed(1)}%` : undefined}
            />
          </div>

          <Section title="每日趋势" hint="柱：按来源统计的事件数；线：发帖数（UTC 日期）">
            {d ? <DailyChart daily={d.daily} /> : <div className="skeleton h-[300px]" />}
          </Section>

          <Section title="响应速度" hint="衡量 agent 多快接手、多快回复">
            {d ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <LatencyTile label="领取延迟" p50={d.latency.claim_p50_ms} p90={d.latency.claim_p90_ms} hint="消息投递创建 → agent 领取" />
                <LatencyTile label="回复延迟" p50={d.latency.reply_p50_ms} p90={d.latency.reply_p90_ms} hint="成员发帖 → 被 @ 的 agent 首次回复" />
              </div>
            ) : (
              <div className="skeleton h-32" />
            )}
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title="热门事件" hint="前 20 个事件名">
              {!d ? (
                <div className="skeleton h-48" />
              ) : d.top_events.length === 0 ? (
                <p className="text-callout font-normal text-fg-3">还没有事件</p>
              ) : (
                <div className="-mx-1 overflow-x-auto">
                  <table className="w-full min-w-[360px] text-left text-caption">
                    <thead className="text-fg-caption">
                      <tr className="border-b border-line">
                        <Th>事件</Th>
                        <Th>来源</Th>
                        <Th right>次数</Th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {d.top_events.map((e) => (
                        <tr key={`${e.source}:${e.name}`} className="border-b border-line last:border-b-0">
                          <td className="px-2 py-2">
                            <div className="font-mono text-fg">{e.name}</div>
                            {EVENT_LABEL[e.name] ? <div className="text-fg-caption">{EVENT_LABEL[e.name]}</div> : null}
                          </td>
                          <td className="px-2 py-2">
                            <span className="chip chip-muted">{SOURCE_LABEL[e.source] ?? e.source}</span>
                          </td>
                          <td className="px-2 py-2 text-right text-fg">{formatInt(e.n)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title="CLI 命令" hint="agentbus 子命令的调用次数、失败率和耗时中位数">
              {!d ? (
                <div className="skeleton h-48" />
              ) : d.cli_commands.length === 0 ? (
                <p className="text-callout font-normal text-fg-3">还没有 CLI 上报（需要 agentbus v0.6 及以上）</p>
              ) : (
                <div className="-mx-1 overflow-x-auto">
                  <table className="w-full min-w-[360px] text-left text-caption">
                    <thead className="text-fg-caption">
                      <tr className="border-b border-line">
                        <Th>命令</Th>
                        <Th right>次数</Th>
                        <Th right>失败率</Th>
                        <Th right>P50 耗时</Th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {d.cli_commands.map((c) => {
                        const pct = c.n > 0 ? (c.failed / c.n) * 100 : 0;
                        return (
                          <tr key={c.cmd} className="border-b border-line last:border-b-0">
                            <td className="px-2 py-2">
                              <span className="inline-flex items-center gap-1.5 font-mono text-fg">
                                <Terminal size={12} className="text-fg-3" aria-hidden />
                                agentbus {c.cmd}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right text-fg">{formatInt(c.n)}</td>
                            <td className={cn("px-2 py-2 text-right", pct >= 5 ? "text-danger-text" : "text-fg-2")}>
                              {c.failed > 0 ? `${pct.toFixed(1)}%` : "0%"}
                            </td>
                            <td className="px-2 py-2 text-right text-fg-2">{formatDuration(c.p50_ms)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title="页面浏览" hint="按路由统计，不含具体 id">
              {d ? (
                <BarList
                  empty="还没有页面浏览"
                  rows={d.pages.map((p) => ({ key: p.path, label: PAGE_LABEL[p.path] ?? p.path, sub: p.path, n: p.n }))}
                />
              ) : (
                <div className="skeleton h-40" />
              )}
            </Section>

            <Section title="客户端版本" hint="每个版本的去重成员数（网页与 CLI）">
              {d ? (
                <BarList
                  empty="还没有版本数据"
                  rows={d.clients.map((c) => ({ key: c.version, label: <span className="font-mono">v{c.version.replace(/^v/, "")}</span>, n: c.n }))}
                />
              ) : (
                <div className="skeleton h-40" />
              )}
            </Section>

            <Section title="编程 CLI" hint="agent 使用的编程 CLI">
              {!d ? (
                <div className="skeleton h-40" />
              ) : d.adapters.length === 0 ? (
                <p className="text-callout font-normal text-fg-3">还没有 agent 上报</p>
              ) : (
                <div className="-mx-1 overflow-x-auto">
                  <table className="w-full min-w-[320px] text-left text-caption">
                    <thead className="text-fg-caption">
                      <tr className="border-b border-line">
                        <Th>CLI</Th>
                        <Th right>agent 数</Th>
                        <Th right>运行轮次</Th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {d.adapters.map((a) => (
                        <tr key={a.cli} className="border-b border-line last:border-b-0">
                          <td className="px-2 py-2 text-fg">{cliLabel(a.cli) || "未知"}</td>
                          <td className="px-2 py-2 text-right text-fg-2">{formatInt(a.members)}</td>
                          <td className="px-2 py-2 text-right text-fg">{formatInt(a.runs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title="帖子类型">
              {d ? (
                <BarList
                  empty="还没有帖子"
                  rows={d.posts_by_kind.map((k) => ({ key: k.kind, label: KIND_LABEL[k.kind] ?? k.kind, n: k.n }))}
                />
              ) : (
                <div className="skeleton h-40" />
              )}
            </Section>
          </div>

          <p className="flex items-center gap-1.5 text-caption text-fg-caption">
            <LineIcon size={14} aria-hidden />
            统计只记录事件名与少量匿名属性，不包含帖子内容、邮箱、令牌或文件名；原始事件保留 90 天。
          </p>
        </>
      )}
    </div>
  );
}
