import { memo, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowRight, CornerUpLeft, Info, Lock, SmilePlus } from "lucide-react";
import "../styles/live.css";
import { api } from "../api";
import { useAction, qk } from "../queries";
import { cliLabel } from "../lib/cli";
import { formatDateTime, formatRelative } from "../lib/format";
import { agentPeer } from "../lib/posts";
import { cn, REACTION_EMOJI } from "../lib/util";
import type { Member, Post } from "../types";
import { Avatar } from "./ui/Avatar";
import { Tip } from "./ui/Tip";
import { Markdown } from "./Markdown";
import { Attachments } from "./post/Attachments";
import { ModelBadge, postModel } from "./post/Badges";
import { ConfirmCard, ProgressCard, StateCard, UsageFooter } from "./post/Cards";

interface PostProps {
  post: Post;
  author?: Member;
  members: Map<string, Member>;
  names: ReadonlySet<string>;
  meId?: string;
  replyTo?: Post;
  flash?: boolean;
  onReply?: (p: Post) => void;
  /** Continues the previous post's group (same author, < 5 min): no avatar/header. */
  compact?: boolean;
  /** Older progress round replaced by a newer one from the same agent: starts folded. */
  superseded?: boolean;
  /** Extra line under the post (delivery receipts on my own posts). */
  footer?: ReactNode;
}

function ReactionBar({ post, meId, members }: { post: Post; meId?: string; members: Map<string, Member> }) {
  const react = useAction((emoji: string) => api.react(post.id, emoji), { invalidate: [qk.thread(post.thread_id)] });
  const list = post.reactions.filter((r) => r.member_ids.length > 0);
  return (
    <>
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
        <Popover.Trigger
          className={cn(
            "btn btn-ghost h-7 min-h-0 w-7 rounded-full px-0 text-fg-3",
            list.length === 0 && "opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100",
          )}
          aria-label="添加表情回执"
        >
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
    </>
  );
}

function ReplyQuote({ post, replyTo, members }: { post: Post; replyTo?: Post; members: Map<string, Member> }) {
  if (!post.reply_to) return null;
  const replyAuthor = replyTo ? members.get(replyTo.author_id) : undefined;
  return (
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
  );
}

function TimeStamp({ ts, className }: { ts: number; className?: string }) {
  return (
    <Tip content={formatDateTime(ts)}>
      <time className={cn("tabular text-caption text-fg-caption", className)} dateTime={new Date(ts).toISOString()} tabIndex={0}>
        {formatRelative(ts)}
      </time>
    </Tip>
  );
}

const KIND_LABEL: Record<string, string> = { confirm: "确认请求", state: "状态更新", progress: "进度", msg: "帖子" };

function PostItemImpl({ post, author, members, names, meId, replyTo, flash, onReply, compact, superseded, footer }: PostProps) {
  if (post.kind === "system") {
    return (
      <div id={`post-${post.id}`} className={cn("flex scroll-mt-24 justify-center px-4 py-1.5", flash && "new-post-flash rounded-full")}>
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-0.5 text-center text-caption text-fg-caption">
          <Info size={12} className="flex-none text-info-text" aria-hidden />
          <span>{post.body}</span>
          <span aria-hidden>·</span>
          <time dateTime={new Date(post.created_at).toISOString()}>{formatRelative(post.created_at)}</time>
        </span>
      </div>
    );
  }

  const peer = agentPeer(post, members, replyTo);
  const name = author?.display_name ?? post.author_id;
  const isAgent = author?.kind === "agent";
  const showCompact = !!compact && post.kind !== "confirm" && post.kind !== "state";
  const cli = isAgent && !postModel(post) ? cliLabel(post.cli ?? author?.cli) : "";

  let content: ReactNode;
  if (post.kind === "confirm") content = <ConfirmCard post={post} members={members} names={names} />;
  else if (post.kind === "state") content = <StateCard post={post} names={names} author={author} />;
  else if (post.kind === "progress") content = <ProgressCard post={post} names={names} superseded={superseded} />;
  else
    content = (
      <div className={cn("text-fg", !showCompact && "mt-0.5")}>
        <Markdown names={names}>{post.body}</Markdown>
        <UsageFooter post={post} />
      </div>
    );

  const kindLabel = peer ? "agent 之间的对话" : (KIND_LABEL[post.kind] ?? "帖子");

  return (
    <article
      id={`post-${post.id}`}
      className={cn(
        "group flex scroll-mt-24 gap-3 rounded-[16px] px-2",
        showCompact ? "py-1" : "pb-2 pt-3",
        peer && "agent-exchange my-0.5",
        flash && "new-post-flash",
      )}
      aria-label={`${name} 的${kindLabel}`}
      data-kind={post.kind}
    >
      <div className="flex w-9 flex-none justify-center">
        {showCompact ? (
          <time
            className="tabular invisible mt-1 text-[10px] leading-4 text-fg-caption group-focus-within:visible group-hover:visible"
            dateTime={new Date(post.created_at).toISOString()}
          >
            {new Date(post.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </time>
        ) : (
          <Avatar member={author} size={36} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {showCompact ? null : (
          <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-callout font-semibold text-fg">{name}</span>
            {author ? <span className="text-caption text-fg-caption">@{author.name}</span> : null}
            {cli ? <span className="text-caption text-fg-caption">· {cli}</span> : null}
            {isAgent ? <ModelBadge post={post} /> : null}
            {peer ? (
              <span className="inline-flex items-center gap-1 text-caption text-fg-2">
                <ArrowRight size={12} aria-hidden />
                <Avatar member={peer} size={16} />
                <span className="max-w-[140px] truncate">
                  <span className="sr-only">发给 </span>
                  {peer.display_name}
                </span>
              </span>
            ) : null}
            {post.redacted ? (
              <span className="chip chip-danger">
                <Lock size={11} aria-hidden /> 已打码
              </span>
            ) : null}
            <TimeStamp ts={post.created_at} className="ml-auto" />
          </header>
        )}
        <ReplyQuote post={post} replyTo={replyTo} members={members} />
        {content}
        <Attachments list={post.attachments} />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ReactionBar post={post} meId={meId} members={members} />
          {onReply ? (
            <button
              className="btn btn-ghost h-7 min-h-0 px-2 text-caption text-fg-3 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
              onClick={() => onReply(post)}
            >
              <CornerUpLeft size={14} aria-hidden /> 回复
            </button>
          ) : null}
          {footer ? <div className="ml-auto">{footer}</div> : null}
        </div>
      </div>
    </article>
  );
}

export const PostItem = memo(PostItemImpl);
