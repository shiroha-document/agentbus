import { t as tr, useLanguage } from "../lib/i18n";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDownToLine, ArrowUpToLine, History, Hourglass, Lock, PauseOctagon, Plus, Tag, X } from "lucide-react";
import { api, type ThreadPatch } from "../api";
import { qk, useAction, useMe, useThreadLive } from "../queries";
import { formatRelative } from "../lib/format";
import { arriveVariants, reducedFade, springSnappy } from "../lib/motion";
import { buildRows, mergeOlder, nextPendingConfirm, supersededProgress } from "../lib/posts";
import { track } from "../lib/telemetry";
import type { Member, Post, ThreadStatus } from "../types";
import { EmptyState } from "../components/ui/EmptyState";
import { toast } from "../components/ui/Toast";
import { StatePanel } from "../components/thread/StatePanel";
import { PostItem } from "../components/PostItem";
import { Composer } from "../components/Composer";
import { ActivityBar } from "../components/live/ActivityBar";
import { ReceiptTicks } from "../components/live/ReceiptTicks";
import { useNow } from "../components/live/useNow";
import { DaySeparator } from "../components/post/Badges";
import { QueryError, RoutePending } from "../components/layout/RouteStates";
import { StatusChip, leaseText, useMemberMap } from "../components/threads";

function LabelsEditor({ labels, onChange, busy }: { labels: string[]; onChange: (l: string[]) => void; busy: boolean }) {
  useLanguage();
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState("");
  const add = () => {
    const l = v.trim();
    setV("");
    setAdding(false);
    if (l && !labels.includes(l)) onChange([...labels, l]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((l) => (
        <span key={l} className="chip chip-muted gap-1 pr-1">
          {l}
          <button
            className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-mint-200"
            aria-label={tr("移除标签 {0}", [l])}
            disabled={busy}
            onClick={() => onChange(labels.filter((x) => x !== l))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="field h-7 min-h-0 w-28 rounded-full px-2.5 py-0 text-caption"
          value={v}
          autoFocus
          maxLength={32}
          onChange={(e) => setV(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
            if (e.key === "Escape") {
              setV("");
              setAdding(false);
            }
          }}
          aria-label={tr("新标签")}
        />
      ) : (
        <button className="btn btn-ghost h-7 min-h-0 rounded-full px-2 text-caption" onClick={() => setAdding(true)} disabled={busy}>
          <Plus size={12} aria-hidden />{" "}{tr("标签")}</button>
      )}
    </div>
  );
}

/** Distance (px) from the bottom that still counts as "at the bottom". */
const NEAR_BOTTOM = 240;

function scrollToBottom(smooth: boolean) {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function JumpButtons({
  atBottom,
  unread,
  pendingConfirms,
  onBottom,
  onTop,
  onConfirm,
}: {
  atBottom: boolean;
  unread: number;
  pendingConfirms: number;
  onBottom: () => void;
  onTop: () => void;
  onConfirm: () => void;
}) {
  useLanguage();
  const reduced = useReducedMotion() ?? false;
  const show = !atBottom || pendingConfirms > 0;
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="jump"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96 }}
          transition={reduced ? reducedFade : springSnappy}
          className="pointer-events-none absolute bottom-full right-2 mb-2 flex flex-col items-end gap-2"
          role="group"
          aria-label={tr("快速跳转")}
        >
          {pendingConfirms > 0 ? (
            <button type="button" className="glass-3 btn pointer-events-auto h-9 min-h-0 rounded-full px-3 text-callout text-warning-text" onClick={onConfirm}>
              <Hourglass size={14} aria-hidden />{" "}{tr("下一个待确认")}<span className="tabular chip chip-warning h-5 min-h-0 px-1.5">{pendingConfirms}</span>
            </button>
          ) : null}
          {!atBottom ? (
            <div className="flex gap-2">
              <button type="button" className="glass-3 btn btn-icon pointer-events-auto h-9 min-h-0 w-9 rounded-full" onClick={onTop} aria-label={tr("跳到顶部")}>
                <ArrowUpToLine size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="glass-3 btn pointer-events-auto relative h-9 min-h-0 rounded-full px-3 text-callout"
                onClick={onBottom}
                aria-label={unread > 0 ? tr("跳到底部，有 {0} 条新消息", [unread]) : tr("跳到底部")}
              >
                <ArrowDownToLine size={16} aria-hidden />{" "}{tr("跳到底部")}{unread > 0 ? (
                  <span className="tabular absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-mint-600 px-1 text-[11px] font-semibold text-white" aria-hidden>
                    {unread > 99 ? "99+" : unread}
                  </span>
                ) : null}
              </button>
            </div>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function ThreadPage() {
  useLanguage();
  const { id } = useParams({ from: "/threads/$id" });
  // Keyed so paging, scroll and "seen" tracking reset when moving between threads.
  return <ThreadView key={id} id={id} />;
}

function ThreadView({ id }: { id: string }) {
  const language = useLanguage();
  const hash = useRouterState({ select: (s) => s.location.hash });
  const reduced = useReducedMotion() ?? false;
  const arrive = arriveVariants(reduced);
  const q = useQuery({ queryKey: qk.thread(id), queryFn: () => api.thread(id) });
  const me = useMe();
  const meId = me.data?.member?.id;
  const now = useNow(30_000);
  const memberMap = useMemberMap(q.data?.members);
  const names = useMemo(() => new Set([...memberMap.values()].map((m) => m.name)), [memberMap]);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [older, setOlder] = useState<Post[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const seen = useRef<Set<string> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const listTop = useRef<HTMLElement>(null);
  const scrolledHash = useRef<string | null>(null);
  const openedAtBottom = useRef(false);
  const stickNext = useRef(false);
  const anchor = useRef<{ height: number; y: number } | null>(null);
  const lastConfirm = useRef<string | null>(null);

  const patch = useAction((body: ThreadPatch) => api.updateThread(id, body), {
    invalidate: [qk.thread(id), ["threads"], ["workspace"], qk.dashboard],
  });

  const latest = q.data?.posts;
  const posts = useMemo(() => (latest ? (older.length ? mergeOlder(older, latest) : latest) : undefined), [older, latest]);
  const hasMore = olderHasMore ?? q.data?.has_more ?? false;
  const newestId = latest ? (latest[latest.length - 1]?.id ?? null) : undefined;
  const loadedPostIds = useMemo(() => posts?.map((p) => p.id).sort(), [posts]);
  const { live, boost } = useThreadLive(id, newestId, loadedPostIds);

  // Once older pages are loaded, posts that slide out of the newest-100 window move into
  // `older` so the list never develops a gap.
  const prevLatest = useRef<Post[] | undefined>(undefined);
  useEffect(() => {
    const prev = prevLatest.current;
    prevLatest.current = latest;
    if (!prev || !latest) return;
    const ids = new Set(latest.map((p) => p.id));
    const dropped = prev.filter((p) => !ids.has(p.id));
    if (dropped.length) setOlder((cur) => (cur.length ? mergeOlder(dropped, cur) : cur));
  }, [latest]);

  // Is the bottom of the list on screen?
  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setAtBottom(entries.some((e) => e.isIntersecting)), {
      rootMargin: `0px 0px ${NEAR_BOTTOM}px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [q.isSuccess]);
  useEffect(() => {
    if (atBottom) setUnread(0);
  }, [atBottom]);

  // Track which posts are new since first render: slide in + flash, follow or count as unread.
  useEffect(() => {
    if (!posts) return;
    if (seen.current === null) {
      seen.current = new Set(posts.map((p) => p.id));
      return;
    }
    const added = posts.filter((p) => !seen.current!.has(p.id));
    if (added.length === 0) return;
    added.forEach((p) => seen.current!.add(p.id));
    setFresh((f) => new Set([...f, ...added.map((p) => p.id)]));
    const mine = added.some((p) => p.author_id === meId);
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM;
    if (nearBottom || mine || stickNext.current) {
      stickNext.current = false;
      requestAnimationFrame(() => scrollToBottom(!reduced));
    } else {
      setUnread((n) => n + added.filter((p) => p.author_id !== meId && p.kind !== "system").length);
    }
  }, [posts, reduced, meId]);

  // Open at the newest message (unless a #post-<id> link asked for a specific one).
  useLayoutEffect(() => {
    if (!posts || openedAtBottom.current) return;
    openedAtBottom.current = true;
    if (!hash) scrollToBottom(false);
  }, [posts, hash]);

  // Keep the viewport still when older posts are prepended.
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    window.scrollTo({ top: a.y + (document.documentElement.scrollHeight - a.height), behavior: "auto" });
  }, [older]);

  // Scroll to #post-<id> once the posts are rendered.
  useEffect(() => {
    if (!posts || !hash || scrolledHash.current === hash) return;
    const el = document.getElementById(hash);
    if (el) {
      scrolledHash.current = hash;
      el.scrollIntoView({ block: "center" });
      el.classList.add("new-post-flash");
    }
  }, [posts, hash]);

  const postById = useMemo(() => new Map((posts ?? []).map((p) => [p.id, p])), [posts]);
  const rows = useMemo(() => buildRows(posts ?? [], now), [posts, now, language]);
  const superseded = useMemo(() => supersededProgress(posts ?? []), [posts]);
  const pendingConfirms = useMemo(() => (posts ?? []).filter((p) => p.kind === "confirm" && p.confirmation?.status === "pending").length, [posts]);

  const loadOlder = async () => {
    const first = posts?.[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await api.thread(id, first.id);
      r.posts.forEach((p) => seen.current?.add(p.id));
      anchor.current = { height: document.documentElement.scrollHeight, y: window.scrollY };
      setOlder((cur) => mergeOlder(r.posts, cur));
      setOlderHasMore(!!r.has_more && r.posts.length > 0);
    } catch (e) {
      toast.error(e);
    } finally {
      setLoadingOlder(false);
    }
  };

  const jumpBottom = () => {
    track("thread.jump", { to: "bottom" });
    setUnread(0);
    scrollToBottom(!reduced);
  };
  const jumpTop = () => {
    track("thread.jump", { to: "top" });
    listTop.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };
  const jumpConfirm = () => {
    if (!posts) return;
    const i = nextPendingConfirm(posts, lastConfirm.current);
    const p = i >= 0 ? posts[i] : undefined;
    if (!p) return;
    track("thread.jump", { to: "confirm" });
    lastConfirm.current = p.id;
    const el = document.getElementById(`post-${p.id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    el.classList.remove("new-post-flash");
    void el.offsetWidth;
    el.classList.add("new-post-flash");
    el.querySelector<HTMLButtonElement>(".confirm-card button")?.focus({ preventScroll: true });
  };

  if (q.isPending) return <RoutePending />;
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;

  const { thread: t, workspace: w } = q.data;
  const all = posts ?? [];
  const lease = leaseText(t, memberMap, now);
  const agents = [...memberMap.values()].filter((m) => m.status === "active" && m.kind === "agent");
  const assignee = t.assignee_id ? memberMap.get(t.assignee_id) : undefined;
  const update = (body: ThreadPatch) => patch.mutate({ ...body, version: t.version });
  const participants: Member[] = q.data.members.length ? q.data.members : [...memberMap.values()];

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-3">
            <h1 className="min-w-0 flex-1 text-title-1 [overflow-wrap:anywhere]">{t.title}</h1>
            <StatusChip status={t.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-caption">
            <Link to="/workspaces/$id" params={{ id: w.id }} className="hover:text-fg">
              {w.name}
            </Link>
            <span>{tr("创建于")}{" "}{formatRelative(t.created_at)}</span>
            <span className="tabular">{hasMore ? tr("已加载 {0} 条帖子", [all.length]) : tr("{0} 条帖子", [all.length])}</span>
            {lease ? (
              <span className="inline-flex items-center gap-1 text-mint-700">
                <Lock size={12} aria-hidden />
                {lease}
              </span>
            ) : null}
          </div>
        </header>

        <StatePanel key={t.state} state={t.state} busy={patch.isPending} onSave={(s) => update({ state: s })} />

        <AnimatePresence initial={false}>
          {t.auto_paused ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="glass-1 card flex flex-wrap items-center gap-3 border-l-[3px] border-l-warning p-4" role="alert">
                <PauseOctagon size={20} className="flex-none text-warning-text" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-callout font-semibold">{tr("这个讨论串因刷屏被自动暂停")}</div>
                  <div className="text-caption text-fg-caption">{tr("agent 短时间内发帖过多。解除前不会再投递新消息。")}</div>
                </div>
                <button className="btn btn-primary btn-lg sm:h-9" disabled={patch.isPending} onClick={() => update({ auto_paused: false })}>{tr("解除")}</button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <section ref={listTop} className="glass-1 card scroll-mt-24 px-3 py-2 sm:px-4" aria-label={tr("帖子")}>
          {hasMore ? (
            <div className="flex justify-center py-2">
              <button className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={() => void loadOlder()} aria-busy={loadingOlder}>
                <History size={14} aria-hidden />
                {loadingOlder ? tr("加载中…") : tr("加载更早的消息")}
              </button>
            </div>
          ) : all.length > 0 && older.length > 0 ? (
            <p className="py-2 text-center text-caption text-fg-caption">{tr("已经到最早的消息了")}</p>
          ) : null}
          {all.length === 0 ? (
            <EmptyState art="inbox" compact title={tr("还没有帖子")} />
          ) : (
            <div className="flex flex-col">
              {rows.map((row) => {
                if (row.type === "day") return <DaySeparator key={row.key} label={row.label} />;
                const p = row.post;
                const isFresh = fresh.has(p.id);
                const receipts = live?.receipts[p.id];
                const node = (
                  <>
                    <PostItem
                      post={p}
                      author={memberMap.get(p.author_id)}
                      members={memberMap}
                      names={names}
                      meId={meId}
                      replyTo={p.reply_to ? postById.get(p.reply_to) : undefined}
                      flash={isFresh}
                      compact={row.compact}
                      superseded={superseded.has(p.id)}
                      onReply={t.status === "closed" ? undefined : setReplyTo}
                    />
                    {receipts?.length ? (
                      <div className="flex justify-end px-2 pb-1">
                        <ReceiptTicks receipts={receipts} members={memberMap} threadId={id} postId={p.id} />
                      </div>
                    ) : null}
                  </>
                );
                return isFresh ? (
                  <motion.div key={p.id} variants={arrive} initial="hidden" animate="show">
                    {node}
                  </motion.div>
                ) : (
                  <div key={p.id}>{node}</div>
                );
              })}
            </div>
          )}
          <div ref={bottom} aria-hidden />
        </section>

        <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-10 md:bottom-4">
          <JumpButtons
            atBottom={atBottom}
            unread={unread}
            pendingConfirms={pendingConfirms}
            onBottom={jumpBottom}
            onTop={jumpTop}
            onConfirm={jumpConfirm}
          />
          <ActivityBar activity={live?.activity} members={memberMap} />
          <Composer
            threadId={t.id}
            members={participants.concat(agents.filter((a) => !participants.some((p) => p.id === a.id)))}
            replyTo={replyTo}
            replyAuthor={replyTo ? memberMap.get(replyTo.author_id) : undefined}
            onClearReply={() => setReplyTo(null)}
            onSent={() => {
              stickNext.current = true;
              boost();
              requestAnimationFrame(() => scrollToBottom(!reduced));
            }}
            disabled={t.status === "closed"}
          />
        </div>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-20" aria-label={tr("讨论串信息")}>
        <section className="glass-1 card flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-caption">{tr("状态")}</span>
            <select
              className="field"
              value={t.status}
              disabled={patch.isPending}
              onChange={(e) => update({ status: e.target.value as ThreadStatus })}
            >
              <option value="open">{tr("进行中")}</option>
              <option value="done">{tr("已完成")}</option>
              <option value="closed">{tr("已关闭")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-caption">{tr("负责人")}</span>
            <select
              className="field"
              value={t.assignee_id ?? ""}
              disabled={patch.isPending}
              onChange={(e) => update({ assignee: e.target.value || null })}
            >
              <option value="">{tr("未指派")}</option>
              {assignee && !agents.some((a) => a.id === assignee.id) ? (
                <option value={assignee.id}>{assignee.display_name}</option>
              ) : null}
              {agents.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}（@{m.name}）
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="inline-flex items-center gap-1 text-caption text-fg-caption">
              <Tag size={12} aria-hidden />{" "}{tr("标签")}</span>
            <LabelsEditor labels={t.labels} busy={patch.isPending} onChange={(labels) => update({ labels })} />
          </div>
          <div className="flex flex-col gap-1 text-caption text-fg-caption">
            <span>{tr("租约")}</span>
            <span className={lease ? "text-mint-700" : ""}>{lease ?? tr("当前没有 agent 在处理")}</span>
          </div>
        </section>
      </aside>
    </div>
  );
}
