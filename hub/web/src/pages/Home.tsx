import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { AlertCircle, ArrowRight, Coins, MailWarning, MessageSquareText, Send, Sparkles, Terminal, UserPlus, Zap } from "lucide-react";
import { api } from "../api";
import { qk, useAction, useMe, useRole, useWorkspaces } from "../queries";
import { useAddAgent } from "../components/AddAgentDialog";
import { buildHeatmap } from "../lib/heatmap";
import { formatInt, formatRelative, formatTokens, formatUsd, greeting } from "../lib/format";
import { enterVariants } from "../lib/motion";
import { cn } from "../lib/util";
import type { DashboardResponse, FeedItem, Member } from "../types";
import { Avatar } from "../components/ui/Avatar";
import { AnimatedNumber } from "../components/ui/AnimatedNumber";
import { EmptyState } from "../components/ui/EmptyState";
import { Tip } from "../components/ui/Tip";
import { Markdown } from "../components/Markdown";
import { QueryError } from "../components/layout/RouteStates";
import { ThreadCard, useMemberMap } from "../components/threads";

const PAGE = 30;

function QuickPost() {
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const active = (workspaces.data?.workspaces ?? []).filter((w) => w.status === "active");
  const [ws, setWs] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const wsId = ws || active[0]?.id || "";
  const create = useAction(
    () => {
      const text = body.trim();
      const firstLine = text.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 80);
      return api.createThread({ workspace_id: wsId, title: title.trim() || firstLine, body: text });
    },
    { success: "已发布" },
  );
  const submit = () => {
    if (!wsId || !body.trim() || create.isPending) return;
    create.mutate(undefined, {
      onSuccess: (r) => {
        setBody("");
        setTitle("");
        void navigate({ to: "/threads/$id", params: { id: r.thread.id } });
      },
    });
  };
  return (
    <form
      className="glass-3 rounded-[28px] p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-label="快速发帖"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <select
          className="field sm:w-48"
          value={wsId}
          onChange={(e) => setWs(e.target.value)}
          aria-label="选择工作区"
          disabled={active.length === 0}
        >
          {active.length === 0 ? <option value="">还没有工作区</option> : null}
          {active.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <input
          className="field flex-1"
          placeholder="标题（可选，默认取正文第一行）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          aria-label="标题"
        />
      </div>
      <textarea
        className="field mt-3 min-h-[96px] resize-y py-3 text-body"
        placeholder="给 agent 布置点什么？用 @名字 指派，⌘/Ctrl + Enter 发送"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        aria-label="内容"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-caption text-fg-caption">支持 Markdown；会新建一个讨论串</span>
        <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={!wsId || !body.trim() || create.isPending}>
          <Send size={16} aria-hidden />
          {create.isPending ? "发送中…" : "发布"}
        </button>
      </div>
      {active.length === 0 && workspaces.isSuccess ? (
        <p className="mt-2 text-caption text-fg-caption">
          先去{" "}
          <Link to="/workspaces" className="text-mint-700 underline">
            创建一个工作区
          </Link>
          。
        </p>
      ) : null}
    </form>
  );
}

function StatChips({ stats }: { stats: DashboardResponse["stats"] }) {
  const items = [
    {
      icon: Zap,
      label: "在线 agent",
      value: <><AnimatedNumber value={stats.agents_online} /> / {formatInt(stats.agents_total)}</>,
    },
    { icon: MessageSquareText, label: "今日帖子", value: <AnimatedNumber value={stats.posts_today} format={formatInt} /> },
    {
      icon: Coins,
      label: "今日用量",
      value: (
        <>
          <AnimatedNumber value={stats.tokens_today} format={formatTokens} /> ·{" "}
          <AnimatedNumber value={stats.cost_today} format={formatUsd} />
        </>
      ),
    },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ icon: Icon, label, value }) => (
        <div key={label} className="glass-1 flex h-10 items-center gap-2 rounded-full px-4 text-callout">
          <Icon size={16} className="text-mint-700" aria-hidden />
          <span className="text-fg-2">{label}</span>
          <span className="tabular font-semibold text-fg">{value}</span>
        </div>
      ))}
    </div>
  );
}

function Banners({ data }: { data: DashboardResponse }) {
  const approve = useAction((id: string) => api.approveMember(id), { success: "已同意加入" });
  const reject = useAction((id: string) => api.rejectMember(id), { success: "已拒绝" });
  const joins = data.pending_joins;
  const confirms = data.pending_confirmations;
  const mail = data.email_health && !data.email_health.ok ? data.email_health : null;
  if (joins.length === 0 && confirms.length === 0 && !mail) return null;
  return (
    <div className="flex flex-col gap-3">
      {mail && (
        <section className="glass-1 card flex flex-col gap-2 border-l-[3px] border-l-danger p-5" role="alert" aria-label="邮件通知发送失败">
          <div className="flex items-center gap-2 text-callout">
            <MailWarning size={16} className="text-danger-text" aria-hidden />
            <span className="font-semibold">
              邮件通知发送失败{mail.failed_count > 1 ? `（${mail.failed_count} 批未送达）` : ""}，你可能错过了提醒
            </span>
            <Link to="/settings" className="ml-auto inline-flex items-center gap-1 text-mint-700 hover:underline">
              去设置 <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          {mail.hint ? <p className="text-callout font-normal text-fg-2">{mail.hint}</p> : null}
          {mail.last_error ? (
            <p className="truncate text-caption text-fg-caption">
              {mail.last_error_at ? formatRelative(mail.last_error_at) + " · " : ""}
              {mail.last_error}
            </p>
          ) : null}
        </section>
      )}
      {joins.length > 0 && (
        <section className="glass-1 card flex flex-col gap-3 border-l-[3px] border-l-mint-500 p-5" aria-label="待审批的加入申请">
          <div className="flex items-center gap-2 text-callout">
            <UserPlus size={16} className="text-mint-700" aria-hidden />
            <span className="font-semibold">{joins.length} 个 agent 申请加入</span>
            <Link to="/members" className="ml-auto inline-flex items-center gap-1 text-mint-700 hover:underline">
              去成员页 <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          {joins.slice(0, 3).map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3">
              <Avatar member={m} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-callout">
                  {m.display_name} <span className="text-fg-caption">@{m.name}</span>
                </div>
                <div className="truncate text-caption text-fg-caption">
                  {[m.cli, m.machine, m.owner].filter(Boolean).join(" · ")} · {formatRelative(m.created_at)}
                </div>
              </div>
              <button className="btn btn-primary btn-sm" disabled={approve.isPending} onClick={() => approve.mutate(m.id)}>
                同意
              </button>
              <button className="btn btn-secondary btn-sm" disabled={reject.isPending} onClick={() => reject.mutate(m.id)}>
                拒绝
              </button>
            </div>
          ))}
        </section>
      )}
      {confirms.length > 0 && (
        <section className="glass-1 card flex flex-col gap-2 border-l-[3px] border-l-warning p-5" aria-label="待你确认的请求">
          <div className="flex items-center gap-2 text-callout">
            <AlertCircle size={16} className="text-warning-text" aria-hidden />
            <span className="font-semibold">{confirms.length} 个确认请求等你处理</span>
          </div>
          {confirms.slice(0, 4).map((c) => (
            <Link
              key={c.id}
              to="/threads/$id"
              params={{ id: c.thread_id }}
              hash={`post-${c.post_id}`}
              className="flex min-h-[40px] items-center gap-2 rounded-[12px] px-2 text-callout font-normal hover:bg-mint-100"
            >
              <span className="line-clamp-1 flex-1 text-fg">{c.question}</span>
              <ArrowRight size={14} className="flex-none text-fg-3" aria-hidden />
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}

function Heatmap({ data }: { data: DashboardResponse["heatmap"] }) {
  const layout = useMemo(() => buildHeatmap(data, new Date(), 365), [data]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Show the most recent weeks first.
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [layout]);
  const CELL = 11;
  const GAP = 3;
  return (
    <section className="glass-1 card p-5" aria-label="活跃度热力图">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-title-2">活跃度</h2>
        <span className="text-caption text-fg-caption">近一年 {formatInt(layout.total)} 条帖子</span>
      </div>
      <div ref={scroller} className="scroll-x overflow-x-auto pb-1">
        <div className="relative" style={{ width: layout.weeks.length * (CELL + GAP) }}>
          <div className="relative mb-1 h-4 text-caption text-fg-caption">
            {layout.months.map((m) => (
              <span key={`${m.label}-${m.col}`} className="absolute" style={{ left: m.col * (CELL + GAP) }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="flex" style={{ gap: GAP }} role="img" aria-label={`近一年共 ${layout.total} 条帖子`}>
            {layout.weeks.map((w, i) => (
              <div key={i} className="flex flex-col" style={{ gap: GAP }}>
                {w.map((c) => (
                  <Tip key={c.day} content={c.inRange ? `${c.day} · ${c.count} 条` : c.day}>
                    <span
                      className={cn("block rounded-[3px]", !c.inRange && "opacity-0")}
                      style={{ width: CELL, height: CELL, background: `var(--heat-${c.level})` }}
                    />
                  </Tip>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-caption text-fg-caption">
        少
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="block h-[11px] w-[11px] rounded-[3px]" style={{ background: `var(--heat-${l})` }} aria-hidden />
        ))}
        多
      </div>
    </section>
  );
}

function FeedEntry({ item, author, names }: { item: FeedItem; author?: Member; names: ReadonlySet<string> }) {
  const p = item.post;
  return (
    <article className="flex gap-3 px-1 py-4">
      <Avatar member={author} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-callout">
          <span className="font-semibold text-fg">{author?.display_name ?? "未知成员"}</span>
          <span className="text-caption text-fg-caption">
            在{" "}
            <Link to="/workspaces/$id" params={{ id: item.workspace.id }} className="hover:text-fg">
              {item.workspace.name}
            </Link>
          </span>
          <span className="ml-auto text-caption text-fg-caption">{formatRelative(p.created_at)}</span>
        </div>
        <Link
          to="/threads/$id"
          params={{ id: item.thread.id }}
          hash={`post-${p.id}`}
          className="mt-0.5 block truncate text-callout text-mint-700 hover:underline"
        >
          {item.thread.title}
        </Link>
        {p.kind === "system" ? (
          <p className="mt-1 text-caption text-fg-caption">{p.body}</p>
        ) : (
          <div className={cn("mt-1 max-h-[7.5rem] overflow-hidden text-fg-2", p.kind === "progress" && "rounded-[12px] bg-mint-50 px-3 py-2")}>
            {p.kind === "confirm" ? <span className="chip chip-warning mb-1">确认请求</span> : null}
            <Markdown names={names}>{p.body}</Markdown>
          </div>
        )}
      </div>
    </article>
  );
}

function Feed() {
  const members = useMemberMap();
  const names = useMemo(() => new Set([...members.values()].map((m) => m.name)), [members]);
  const feed = useInfiniteQuery({
    queryKey: qk.feed,
    queryFn: ({ pageParam }) => api.feed(pageParam, PAGE),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.has_more ? last.items[last.items.length - 1]?.post.id : undefined),
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="glass-1 card p-5" aria-label="动态">
      <h2 className="text-title-2">动态</h2>
      {feed.isPending ? (
        <div className="mt-4 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-20" />
          ))}
        </div>
      ) : feed.isError ? (
        <div className="mt-4">
          <QueryError error={feed.error} onRetry={() => void feed.refetch()} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState art="inbox" title="还没有任何动态。在上面发第一个帖子吧。" compact />
      ) : (
        <div className="divide-y divide-line">
          {items.map((it) => (
            <FeedEntry key={it.post.id} item={it} author={members.get(it.post.author_id)} names={names} />
          ))}
        </div>
      )}
      <div ref={sentinel} />
      {feed.hasNextPage ? (
        <div className="mt-2 flex justify-center">
          <button className="btn btn-ghost" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : items.length > 0 ? (
        <p className="mt-3 text-center text-caption text-fg-caption">没有更早的动态了</p>
      ) : null}
    </section>
  );
}

/** First-run call to action: the team has no agent yet. */
function FirstAgentCta() {
  const addAgent = useAddAgent();
  const { isAdmin } = useRole();
  return (
    <section className="glass-1 card relative overflow-hidden p-6" aria-labelledby="first-agent">
      <div
        className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(circle, var(--mint-300), transparent 70%)" }}
        aria-hidden
      />
      <div className="relative flex flex-col gap-5 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <h2 id="first-agent" className="text-title-2">接入第一个 agent</h2>
          <p className="mt-1 text-callout font-normal text-fg-2">
            {isAdmin
              ? "复制一行命令到任意一台装了 Claude Code / Codex / Cursor / Gemini 的机器上运行，或者把提示词丢给它，它会自己装好并加入。"
              : "请团队管理员在「成员 → 添加 agent」里复制接入命令。"}
          </p>
          <ul className="mt-3 flex flex-wrap gap-2 text-caption text-fg-2">
            <li className="chip chip-muted">
              <Terminal size={12} aria-hidden /> 一行命令安装 + 加入
            </li>
            <li className="chip chip-muted">
              <Sparkles size={12} aria-hidden /> 或交给 AI 来装
            </li>
            <li className="chip chip-muted">
              <UserPlus size={12} aria-hidden /> 弹窗里直接批准
            </li>
          </ul>
        </div>
        {isAdmin ? (
          <button className="btn btn-primary btn-lg flex-none" onClick={addAgent}>
            <UserPlus size={18} aria-hidden /> 添加 agent
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function HomePage() {
  const reduced = useReducedMotion() ?? false;
  const v = enterVariants(reduced);
  const me = useMe();
  const dash = useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard });
  const members = useMemberMap();
  const workspaces = useWorkspaces();
  const wsName = useMemo(() => new Map((workspaces.data?.workspaces ?? []).map((w) => [w.id, w.name])), [workspaces.data]);
  const [hour, setHour] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setHour(new Date()), 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);
  const d = dash.data;

  return (
    <div className="flex flex-col gap-8">
      <motion.header variants={v} initial="hidden" animate="show" custom={0} className="flex flex-col gap-4">
        <h1 className="text-[34px] font-semibold leading-[40px] tracking-[-0.02em] sm:text-display">
          {greeting(hour)}，{me.data?.member?.display_name ?? "你好"}
        </h1>
        {d ? <StatChips stats={d.stats} /> : <div className="skeleton h-10 w-80 max-w-full rounded-full" />}
      </motion.header>

      <motion.div variants={v} initial="hidden" animate="show" custom={1}>
        <QuickPost />
      </motion.div>

      {dash.isError ? <QueryError error={dash.error} onRetry={() => void dash.refetch()} /> : null}
      {d ? <Banners data={d} /> : null}
      {d && d.stats.agents_total === 0 ? <FirstAgentCta /> : null}

      <motion.section variants={v} initial="hidden" animate="show" custom={2} aria-label="进行中的讨论串">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-title-2">进行中</h2>
          {d ? <span className="text-caption text-fg-caption">{d.active_threads.length} 个讨论串</span> : null}
        </div>
        {!d ? (
          <div className="flex gap-4 overflow-hidden">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-40 w-[280px] flex-none" />
            ))}
          </div>
        ) : d.active_threads.length === 0 ? (
          <div className="glass-1 card">
            <EmptyState art="threads" title="现在没有进行中的讨论串" compact />
          </div>
        ) : (
          <div className="scroll-x -mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 md:-mx-1 md:px-1">
            {d.active_threads.map((t) => (
              <ThreadCard key={t.id} thread={t} members={members} workspaceName={wsName.get(t.workspace_id)} />
            ))}
          </div>
        )}
      </motion.section>

      <motion.div variants={v} initial="hidden" animate="show" custom={3} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        <div className="order-2 lg:order-1">
          <Feed />
        </div>
        <div className="order-1 lg:sticky lg:top-20 lg:order-2">
          {d ? <Heatmap data={d.heatmap} /> : <div className="skeleton h-48" />}
        </div>
      </motion.div>
    </div>
  );
}
