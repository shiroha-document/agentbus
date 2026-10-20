import { memo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CheckCircle2, CornerUpLeft, Info, Lock, SmilePlus, XCircle } from "lucide-react";
import { api } from "../api";
import { useAction, qk } from "../queries";
import { parseProgress } from "../lib/progress";
import { formatDateTime, formatDuration, formatRelative, formatTokens, formatUsd, totalTokens } from "../lib/format";
import { cn, REACTION_EMOJI } from "../lib/util";
import type { Member, Post } from "../types";
import { Avatar } from "./ui/Avatar";
import { Tip } from "./ui/Tip";
import { Markdown } from "./Markdown";

interface PostProps {
  post: Post;
  author?: Member;
  members: Map<string, Member>;
  names: ReadonlySet<string>;
  meId?: string;
  replyTo?: Post;
  flash?: boolean;
  onReply?: (p: Post) => void;
}

function UsageFooter({ post }: { post: Post }) {
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
  if (u.model) parts.push(u.model);
  return <div className="tabular mt-2 text-caption text-fg-caption">{parts.join(" · ")}</div>;
}

function ProgressBody({ body, names }: { body: string; names: ReadonlySet<string> }) {
  const parsed = parseProgress(body);
  if (!parsed) return <Markdown names={names}>{body}</Markdown>;
  return (
    <div className="flex flex-col gap-3">
      {parsed.preamble.trim() ? <Markdown names={names}>{parsed.preamble}</Markdown> : null}
      {parsed.sections.map((s) => (
        <section key={s.name}>
          <h4 className="mb-1 text-callout font-semibold text-mint-700">{s.name}</h4>
          {s.body.trim() ? <Markdown names={names}>{s.body}</Markdown> : <p className="text-fg-3">—</p>}
        </section>
      ))}
    </div>
  );
}

function ReactionBar({ post, meId, members }: { post: Post; meId?: string; members: Map<string, Member> }) {
  const react = useAction((emoji: string) => api.react(post.id, emoji), { invalidate: [qk.thread(post.thread_id)] });
  const list = post.reactions.filter((r) => r.member_ids.length > 0);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {list.map((r) => {
        const mine = !!meId && r.member_ids.includes(meId);
        const who = r.member_ids.map((id) => members.get(id)?.display_name ?? id).join("、");
        return (
          <Tip key={r.emoji} content={who}>
            <button
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-caption transition-colors",
                mine ? "border-mint-500 bg-mint-100 text-fg" : "border-line text-fg-2 hover:bg-mint-100",
              )}
              aria-pressed={mine}
              aria-label={`${r.emoji} ${r.member_ids.length}`}
              disabled={react.isPending}
              onClick={() => react.mutate(r.emoji)}
            >
              <span aria-hidden>{r.emoji}</span>
              <span className="tabular">{r.member_ids.length}</span>
            </button>
          </Tip>
        );
      })}
      <Popover.Root>
        <Popover.Trigger className="btn btn-ghost h-7 min-h-0 w-7 rounded-full px-0 text-fg-3" aria-label="添加表情回执">
          <SmilePlus size={16} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="top" sideOffset={6} className="glass-3 z-50 flex gap-1 rounded-full p-1.5">
            {REACTION_EMOJI.map((e) => (
              <Popover.Close key={e} asChild>
                <button
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[18px] hover:bg-mint-100"
                  onClick={() => react.mutate(e)}
                  aria-label={`回执 ${e}`}
                >
                  {e}
                </button>
              </Popover.Close>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function ConfirmCard({ post, members }: { post: Post; members: Map<string, Member> }) {
  const c = post.confirmation;
  const decide = useAction((d: "approve" | "reject") => api.decide(c!.id, d), {
    success: "已处理",
    invalidate: [qk.thread(post.thread_id), qk.dashboard],
  });
  return (
    <div className="mt-1 overflow-hidden rounded-[16px] border border-line border-l-[3px] border-l-warning bg-surface-strong p-4">
      <div className="mb-1 text-caption font-medium text-warning-text">确认请求</div>
      <div className="text-body text-fg">
        <Markdown>{c?.question ?? post.body}</Markdown>
      </div>
      {!c || c.status === "pending" ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn btn-primary btn-lg sm:h-9"
            disabled={!c || decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            <CheckCircle2 size={16} aria-hidden /> 同意
          </button>
          <button
            className="btn btn-secondary btn-lg sm:h-9"
            disabled={!c || decide.isPending}
            onClick={() => decide.mutate("reject")}
          >
            <XCircle size={16} aria-hidden /> 拒绝
          </button>
        </div>
      ) : (
        <div className={cn("mt-3 inline-flex items-center gap-1.5 text-callout", c.status === "approved" ? "text-mint-700" : "text-danger-text")}>
          {c.status === "approved" ? <CheckCircle2 size={16} aria-hidden /> : <XCircle size={16} aria-hidden />}
          {c.status === "approved" ? "已同意" : "已拒绝"}
          {c.decided_by ? ` · ${members.get(c.decided_by)?.display_name ?? c.decided_by}` : ""}
          {c.decided_at ? <span className="text-caption text-fg-caption"> · {formatRelative(c.decided_at)}</span> : null}
          {c.note ? <span className="text-fg-2">：{c.note}</span> : null}
        </div>
      )}
    </div>
  );
}

function PostItemImpl({ post, author, members, names, meId, replyTo, flash, onReply }: PostProps) {
  if (post.kind === "system") {
    return (
      <div id={`post-${post.id}`} className={cn("flex justify-center px-4 py-1.5", flash && "new-post-flash rounded-full")}>
        <span className="inline-flex max-w-full items-center gap-1.5 text-center text-caption text-fg-caption">
          <Info size={12} className="flex-none text-info-text" aria-hidden />
          <span>{post.body}</span>
          <span aria-hidden>·</span>
          <time dateTime={new Date(post.created_at).toISOString()}>{formatRelative(post.created_at)}</time>
        </span>
      </div>
    );
  }
  const replyAuthor = replyTo ? members.get(replyTo.author_id) : undefined;
  return (
    <article
      id={`post-${post.id}`}
      className={cn("group flex scroll-mt-24 gap-3 rounded-[16px] px-2 py-3", flash && "new-post-flash")}
      aria-label={`${author?.display_name ?? "未知成员"} 的帖子`}
    >
      <Avatar member={author} size={36} />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-callout font-semibold text-fg">{author?.display_name ?? post.author_id}</span>
          {author ? <span className="text-caption text-fg-caption">@{author.name}</span> : null}
          {post.kind === "progress" ? <span className="chip">进度</span> : null}
          {post.redacted ? (
            <span className="chip chip-danger">
              <Lock size={11} aria-hidden /> 已打码
            </span>
          ) : null}
          <Tip content={formatDateTime(post.created_at)}>
            <time className="ml-auto text-caption text-fg-caption" dateTime={new Date(post.created_at).toISOString()}>
              {formatRelative(post.created_at)}
            </time>
          </Tip>
        </header>
        {post.reply_to ? (
          <a
            href={`#post-${post.reply_to}`}
            className="mt-1 flex max-w-full items-start gap-1.5 rounded-[10px] border-l-2 border-mint-300 bg-mint-50 px-2.5 py-1.5 text-caption text-fg-2 hover:bg-mint-100"
          >
            <CornerUpLeft size={12} className="mt-0.5 flex-none" aria-hidden />
            <span className="line-clamp-2">
              {replyTo ? (
                <>
                  <span className="font-medium">{replyAuthor?.display_name ?? replyTo.author_id}：</span>
                  {replyTo.body.slice(0, 200)}
                </>
              ) : (
                "回复的帖子不在当前列表中"
              )}
            </span>
          </a>
        ) : null}
        {post.kind === "confirm" ? (
          <ConfirmCard post={post} members={members} />
        ) : post.kind === "progress" ? (
          <div className="mt-1 rounded-[16px] bg-mint-50 p-4">
            <ProgressBody body={post.body} names={names} />
            <UsageFooter post={post} />
          </div>
        ) : (
          <div className="mt-1 text-fg">
            <Markdown names={names}>{post.body}</Markdown>
            <UsageFooter post={post} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <ReactionBar post={post} meId={meId} members={members} />
          {onReply ? (
            <button
              className="btn btn-ghost mt-2 h-7 min-h-0 px-2 text-caption text-fg-3 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
              onClick={() => onReply(post)}
            >
              <CornerUpLeft size={14} aria-hidden /> 回复
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export const PostItem = memo(PostItemImpl);
