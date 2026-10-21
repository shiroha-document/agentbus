import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Lock, Pencil, Pin, PauseOctagon, Plus, Tag, X } from "lucide-react";
import { api, type ThreadPatch } from "../api";
import { qk, useAction, useMe } from "../queries";
import { formatRelative } from "../lib/format";
import { arriveVariants } from "../lib/motion";
import type { Member, Post, ThreadStatus } from "../types";
import { EmptyState } from "../components/ui/EmptyState";
import { Markdown } from "../components/Markdown";
import { PostItem } from "../components/PostItem";
import { Composer } from "../components/Composer";
import { QueryError, RoutePending } from "../components/layout/RouteStates";
import { StatusChip, leaseText, useMemberMap } from "../components/threads";

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function LabelsEditor({ labels, onChange, busy }: { labels: string[]; onChange: (l: string[]) => void; busy: boolean }) {
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
            aria-label={`移除标签 ${l}`}
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
          aria-label="新标签"
        />
      ) : (
        <button className="btn btn-ghost h-7 min-h-0 rounded-full px-2 text-caption" onClick={() => setAdding(true)} disabled={busy}>
          <Plus size={12} aria-hidden /> 标签
        </button>
      )}
    </div>
  );
}

function StatePanel({ state, onSave, busy }: { state: string; onSave: (s: string) => void; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(state);
  return (
    <section className="glass-1 card p-5" aria-label="当前状态">
      <div className="mb-2 flex items-center gap-2">
        <Pin size={16} className="text-mint-700" aria-hidden />
        <h2 className="text-callout font-semibold">当前状态</h2>
        {!editing ? (
          <button
            className="btn btn-ghost btn-sm ml-auto"
            onClick={() => {
              setV(state);
              setEditing(true);
            }}
          >
            <Pencil size={14} aria-hidden /> 编辑
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            className="field min-h-[140px] resize-y py-2.5 text-callout font-normal"
            value={v}
            onChange={(e) => setV(e.target.value)}
            autoFocus
            aria-label="当前状态内容"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                onSave(v);
                setEditing(false);
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || v === state}
              onClick={() => {
                onSave(v);
                setEditing(false);
              }}
            >
              保存
            </button>
          </div>
        </div>
      ) : state.trim() ? (
        <div className="text-callout font-normal text-fg-2">
          <Markdown>{state}</Markdown>
        </div>
      ) : (
        <p className="text-callout font-normal text-fg-3">还没有记录。负责人会在这里总结进展、阻塞和下一步。</p>
      )}
    </section>
  );
}

export function ThreadPage() {
  const { id } = useParams({ from: "/threads/$id" });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const reduced = useReducedMotion() ?? false;
  const arrive = arriveVariants(reduced);
  const q = useQuery({ queryKey: qk.thread(id), queryFn: () => api.thread(id) });
  const me = useMe();
  const now = useNow();
  const memberMap = useMemberMap(q.data?.members);
  const names = useMemo(() => new Set([...memberMap.values()].map((m) => m.name)), [memberMap]);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const seen = useRef<Set<string> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scrolledHash = useRef<string | null>(null);

  const patch = useAction((body: ThreadPatch) => api.updateThread(id, body), {
    invalidate: [qk.thread(id), ["threads"], ["workspace"], qk.dashboard],
  });

  // Track which posts are new since first render so they slide in + flash.
  const posts = q.data?.posts;
  useEffect(() => {
    if (!posts) return;
    if (seen.current === null) {
      seen.current = new Set(posts.map((p) => p.id));
      return;
    }
    const added = posts.filter((p) => !seen.current!.has(p.id)).map((p) => p.id);
    if (added.length === 0) return;
    added.forEach((x) => seen.current!.add(x));
    setFresh((f) => new Set([...f, ...added]));
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 320;
    if (nearBottom) requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" }));
  }, [posts, reduced]);

  // Reset per-thread tracking on navigation between threads.
  useEffect(() => {
    seen.current = null;
    setFresh(new Set());
    setReplyTo(null);
    scrolledHash.current = null;
  }, [id]);

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

  if (q.isPending) return <RoutePending />;
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;

  const { thread: t, workspace: w } = q.data;
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
            <span>创建于 {formatRelative(t.created_at)}</span>
            <span>{q.data.posts.length} 条帖子</span>
            {lease ? (
              <span className="inline-flex items-center gap-1 text-mint-700">
                <Lock size={12} aria-hidden />
                {lease}
              </span>
            ) : null}
          </div>
        </header>

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
                  <div className="text-callout font-semibold">这个讨论串因刷屏被自动暂停</div>
                  <div className="text-caption text-fg-caption">agent 短时间内发帖过多。解除前不会再投递新消息。</div>
                </div>
                <button className="btn btn-primary btn-lg sm:h-9" disabled={patch.isPending} onClick={() => update({ auto_paused: false })}>
                  解除
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="lg:hidden">
          <StatePanel key={t.state} state={t.state} busy={patch.isPending} onSave={(s) => update({ state: s })} />
        </div>

        <section className="glass-1 card px-3 py-2 sm:px-4" aria-label="帖子">
          {q.data.posts.length === 0 ? (
            <EmptyState art="inbox" compact title="还没有帖子" />
          ) : (
            <div className="flex flex-col">
              {q.data.posts.map((p) => {
                const isFresh = fresh.has(p.id);
                const node = (
                  <PostItem
                    post={p}
                    author={memberMap.get(p.author_id)}
                    members={memberMap}
                    names={names}
                    meId={me.data?.member?.id}
                    replyTo={p.reply_to ? postById.get(p.reply_to) : undefined}
                    flash={isFresh}
                    onReply={t.status === "closed" ? undefined : setReplyTo}
                  />
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
          <div ref={bottom} />
        </section>

        <div className="sticky bottom-[calc(76px+env(safe-area-inset-bottom))] z-10 md:bottom-4">
          <Composer
            threadId={t.id}
            members={participants.concat(agents.filter((a) => !participants.some((p) => p.id === a.id)))}
            replyTo={replyTo}
            replyAuthor={replyTo ? memberMap.get(replyTo.author_id) : undefined}
            onClearReply={() => setReplyTo(null)}
            disabled={t.status === "closed"}
          />
        </div>
      </div>

      <aside className="flex flex-col gap-4 lg:sticky lg:top-20" aria-label="讨论串信息">
        <div className="hidden lg:block">
          <StatePanel key={t.state} state={t.state} busy={patch.isPending} onSave={(s) => update({ state: s })} />
        </div>
        <section className="glass-1 card flex flex-col gap-4 p-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-caption">状态</span>
            <select
              className="field"
              value={t.status}
              disabled={patch.isPending}
              onChange={(e) => update({ status: e.target.value as ThreadStatus })}
            >
              <option value="open">进行中</option>
              <option value="done">已完成</option>
              <option value="closed">已关闭</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption text-fg-caption">负责人</span>
            <select
              className="field"
              value={t.assignee_id ?? ""}
              disabled={patch.isPending}
              onChange={(e) => update({ assignee: e.target.value || null })}
            >
              <option value="">未指派</option>
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
              <Tag size={12} aria-hidden /> 标签
            </span>
            <LabelsEditor labels={t.labels} busy={patch.isPending} onChange={(labels) => update({ labels })} />
          </div>
          <div className="flex flex-col gap-1 text-caption text-fg-caption">
            <span>租约</span>
            <span className={lease ? "text-mint-700" : ""}>{lease ?? "当前没有 agent 在处理"}</span>
          </div>
        </section>
      </aside>
    </div>
  );
}
