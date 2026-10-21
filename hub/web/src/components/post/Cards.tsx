import { useId, useState } from "react";
import { CheckCircle2, ChevronDown, Clock, Hourglass, ListChecks, Target, XCircle } from "lucide-react";
import "../../styles/live.css";
import { api } from "../../api";
import { qk, useAction } from "../../queries";
import { formatDateTime, formatDuration, formatRelative, formatTokens, formatUsd, totalTokens } from "../../lib/format";
import { parseProgress } from "../../lib/progress";
import { track } from "../../lib/telemetry";
import { cn } from "../../lib/util";
import type { Member, Post } from "../../types";
import { Markdown } from "../Markdown";
import { Tip } from "../ui/Tip";

export function UsageFooter({ post }: { post: Post }) {
  const u = post.usage;
  if (!u) return null;
  const parts = [
    `${formatTokens(totalTokens(u))} tokens`,
    `输入 ${formatTokens(u.input)}`,
    `缓存读 ${formatTokens(u.cache_read)}`,
    `缓存写 ${formatTokens(u.cache_write)}`,
    `输出 ${formatTokens(u.output)}`,
  ];
  if (u.cost_usd_est !== null) parts.push(`约 ${formatUsd(u.cost_usd_est)}`);
  if (u.duration_ms) parts.push(formatDuration(u.duration_ms));
  return <div className="tabular mt-2 text-caption text-fg-caption">{parts.join(" · ")}</div>;
}

/** "已更新 3 次 · 最后更新 2 分钟前" for collapsed progress/state posts. */
export function revisionText(post: Post, now: number = Date.now()): string | null {
  const n = post.revisions ?? 0;
  if (n <= 0) return null;
  const last = post.edited_at ?? post.created_at;
  return `已更新 ${n} 次 · 最后更新 ${formatRelative(last, now)}`;
}

/** First meaningful line of a progress post (for the folded summary). */
function progressSummary(body: string): string {
  const parsed = parseProgress(body);
  const pick = parsed?.sections.find((s) => s.name === "改了什么" && s.body.trim()) ?? parsed?.sections.find((s) => s.body.trim());
  const text = pick?.body ?? body;
  const line = text.split(/\r?\n/).map((l) => l.replace(/^[\s>#*-]+/, "").trim()).find(Boolean) ?? "";
  return line.replace(/[`*_]/g, "").slice(0, 140);
}

function ProgressBody({ body, names }: { body: string; names: ReadonlySet<string> }) {
  const parsed = parseProgress(body);
  if (!parsed) return <Markdown names={names}>{body}</Markdown>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {parsed.preamble.trim() ? (
        <div className="sm:col-span-2">
          <Markdown names={names}>{parsed.preamble}</Markdown>
        </div>
      ) : null}
      {parsed.sections.map((s) => (
        <section key={s.name} className="min-w-0">
          <h4 className="mb-1 text-caption font-semibold text-mint-700">{s.name}</h4>
          {s.body.trim() ? <Markdown names={names}>{s.body}</Markdown> : <p className="text-fg-3">—</p>}
        </section>
      ))}
    </div>
  );
}

/**
 * Compact "进度" card. Collapsible; older rounds that a newer progress post from the same agent
 * replaces start folded (`superseded`).
 */
export function ProgressCard({ post, names, superseded }: { post: Post; names: ReadonlySet<string>; superseded?: boolean }) {
  const [open, setOpen] = useState(!superseded);
  const bodyId = useId();
  const rev = revisionText(post);
  return (
    <div className={cn("mt-1 rounded-[16px] border border-line bg-mint-50", superseded && "opacity-80")}>
      <button
        type="button"
        className="flex min-h-[40px] w-full items-center gap-2 rounded-[16px] px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <ListChecks size={16} className="flex-none text-mint-700" aria-hidden />
        <span className="text-callout font-semibold text-mint-700">进度</span>
        {superseded ? <span className="chip chip-muted">已被新进度取代</span> : null}
        {!open ? <span className="min-w-0 flex-1 truncate text-caption text-fg-2">{progressSummary(post.body)}</span> : <span className="flex-1" />}
        {rev ? (
          <Tip content={post.edited_at ? `最后更新于 ${formatDateTime(post.edited_at)}` : rev}>
            <span className="tabular hidden flex-none items-center gap-1 text-caption text-fg-caption sm:inline-flex">
              <Clock size={12} aria-hidden /> {rev}
            </span>
          </Tip>
        ) : null}
        <ChevronDown size={16} className={cn("flex-none text-fg-3 transition-transform", open && "rotate-180")} aria-hidden />
        <span className="sr-only">{open ? "收起进度" : "展开进度"}</span>
      </button>
      {open ? (
        <div id={bodyId} className="px-4 pb-3">
          {rev ? <div className="tabular mb-2 text-caption text-fg-caption sm:hidden">{rev}</div> : null}
          <ProgressBody body={post.body} names={names} />
          <UsageFooter post={post} />
        </div>
      ) : null}
    </div>
  );
}

/** Pinned-looking "目标 / 状态更新" card (kind=state; created when the thread state changes). */
export function StateCard({ post, names, author }: { post: Post; names: ReadonlySet<string>; author?: Member }) {
  const rev = revisionText(post);
  return (
    <section className="state-card mt-1 rounded-[18px] p-4" aria-label="目标 / 状态更新">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-info-text">
          <Target size={15} aria-hidden />
        </span>
        <span className="text-callout font-semibold text-fg">目标 / 状态更新</span>
        {author ? <span className="text-caption text-fg-caption">由 {author.display_name} 更新</span> : null}
        {rev ? <span className="tabular ml-auto text-caption text-fg-caption">{rev}</span> : null}
      </div>
      <div className="text-callout text-fg-2">
        <Markdown names={names}>{post.body}</Markdown>
      </div>
    </section>
  );
}

/** Confirmation waiting for a human: prominent, pulses while pending. */
export function ConfirmCard({ post, members, names }: { post: Post; members: Map<string, Member>; names?: ReadonlySet<string> }) {
  const c = post.confirmation;
  const decide = useAction((d: "approve" | "reject") => api.decide(c!.id, d), {
    success: "已处理",
    invalidate: [qk.thread(post.thread_id), qk.dashboard],
  });
  const pending = !c || c.status === "pending";
  const go = (d: "approve" | "reject") => {
    track("confirm.decide", { decision: d });
    decide.mutate(d);
  };
  return (
    <section
      className="confirm-card mt-1 overflow-hidden rounded-[18px] p-4"
      data-pending={pending}
      aria-label={pending ? "等待你确认" : "确认请求"}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-caption font-semibold text-warning-text">
        <Hourglass size={14} aria-hidden />
        {pending ? "等待你确认" : "确认请求"}
        {pending ? <span className="font-normal text-fg-caption">· agent 在等你的决定后继续</span> : null}
      </div>
      <div className="text-body text-fg">
        <Markdown names={names}>{c?.question ?? post.body}</Markdown>
      </div>
      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-primary btn-lg sm:h-9" disabled={!c || decide.isPending} onClick={() => go("approve")}>
            <CheckCircle2 size={16} aria-hidden /> 同意
          </button>
          <button className="btn btn-secondary btn-lg sm:h-9" disabled={!c || decide.isPending} onClick={() => go("reject")}>
            <XCircle size={16} aria-hidden /> 拒绝
          </button>
        </div>
      ) : (
        <div className={cn("mt-3 inline-flex flex-wrap items-center gap-1.5 text-callout", c.status === "approved" ? "text-mint-700" : "text-danger-text")}>
          {c.status === "approved" ? <CheckCircle2 size={16} aria-hidden /> : <XCircle size={16} aria-hidden />}
          {c.status === "approved" ? "已同意" : "已拒绝"}
          {c.decided_by ? ` · ${members.get(c.decided_by)?.display_name ?? c.decided_by}` : ""}
          {c.decided_at ? <span className="text-caption text-fg-caption"> · {formatRelative(c.decided_at)}</span> : null}
          {c.note ? <span className="text-fg-2">：{c.note}</span> : null}
        </div>
      )}
    </section>
  );
}
