import { t as tr, useLanguage, localized } from "../lib/i18n";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Clock, Lock, PauseOctagon, UserRound } from "lucide-react";
import { api } from "../api";
import { useAction, useMembers, useWorkspaces } from "../queries";
import { formatRelative, formatUntil } from "../lib/format";
import { cn, THREAD_STATUS_LABEL } from "../lib/util";
import type { Member, Thread, ThreadStatus } from "../types";
import { Avatar } from "./ui/Avatar";
import { Dialog } from "./ui/Dialog";

export function useMemberMap(extra?: Member[]): Map<string, Member> {
  const { data } = useMembers();
  return useMemo(() => {
    const m = new Map<string, Member>();
    for (const x of data?.members ?? []) m.set(x.id, x);
    for (const x of extra ?? []) m.set(x.id, x);
    return m;
  }, [data, extra]);
}

export function StatusChip({ status }: { status: ThreadStatus }) {
  useLanguage();
  return (
    <span className={cn("chip", status === "open" ? "" : status === "done" ? "chip-info" : "chip-muted")}>
      {THREAD_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** "alice 正在处理 · 剩 12 分钟" — only while the lease is live. */
export function leaseText(t: Pick<Thread, "lease_holder" | "lease_until">, members: Map<string, Member>, now = Date.now()): string | null {
  if (!t.lease_holder || !t.lease_until || t.lease_until <= now) return null;
  const who = members.get(t.lease_holder);
  return tr("{0} 正在处理 · 剩 {1}", [who?.display_name || who?.name || t.lease_holder, formatUntil(t.lease_until, now)]);
}

/** Compact card for the horizontal 进行中 row on the home page. */
export function ThreadCard({ thread, members, workspaceName }: { thread: Thread; members: Map<string, Member>; workspaceName?: string }) {
  useLanguage();
  const assignee = thread.assignee_id ? members.get(thread.assignee_id) : undefined;
  const lease = leaseText(thread, members);
  return (
    <Link
      to="/threads/$id"
      params={{ id: thread.id }}
      className="glass-1 card card-hover flex w-[280px] flex-none snap-start flex-col gap-3 p-5"
    >
      <div className="flex items-center gap-2 text-caption text-fg-caption">
        <span className="truncate">{workspaceName ?? tr("工作区")}</span>
        <span className="ml-auto flex-none">{formatRelative(thread.last_post_at)}</span>
      </div>
      <div className="line-clamp-2 min-h-[48px] text-body font-semibold text-fg">{thread.title}</div>
      <div className="flex items-center gap-2 text-caption text-fg-2">
        {assignee ? (
          <>
            <Avatar member={assignee} size={20} />
            <span className="truncate">{assignee.display_name}</span>
          </>
        ) : (
          <span className="text-fg-caption">{tr("未指派")}</span>
        )}
        {thread.auto_paused ? (
          <span className="chip chip-warning ml-auto">
            <PauseOctagon size={12} aria-hidden />{" "}{tr("已拦截")}</span>
        ) : null}
      </div>
      {lease ? (
        <div className="flex items-center gap-1.5 text-caption text-mint-700">
          <Lock size={12} aria-hidden />
          <span className="truncate">{lease}</span>
        </div>
      ) : null}
    </Link>
  );
}

/** Full-width row for workspace thread lists. */
export function ThreadRow({ thread, members }: { thread: Thread; members: Map<string, Member> }) {
  useLanguage();
  const assignee = thread.assignee_id ? members.get(thread.assignee_id) : undefined;
  const lease = leaseText(thread, members);
  return (
    <Link
      to="/threads/$id"
      params={{ id: thread.id }}
      className="flex min-h-[56px] items-center gap-3 rounded-[14px] px-3 py-3 transition-colors hover:bg-mint-100"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-fg">{thread.title}</span>
          {thread.auto_paused ? (
            <span className="chip chip-warning flex-none">
              <PauseOctagon size={12} aria-hidden />{" "}{tr("已拦截")}</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-caption">
          <span className="inline-flex items-center gap-1">
            <Clock size={12} aria-hidden />
            {formatRelative(thread.last_post_at)}
          </span>
          {lease ? (
            <span className="inline-flex items-center gap-1 text-mint-700">
              <Lock size={12} aria-hidden />
              {lease}
            </span>
          ) : null}
          {thread.labels.map((l) => (
            <span key={l} className="chip chip-muted">
              {l}
            </span>
          ))}
        </div>
      </div>
      <span className="hidden items-center gap-1.5 text-caption text-fg-2 sm:inline-flex">
        {assignee ? <Avatar member={assignee} size={20} /> : <UserRound size={14} aria-hidden />}
        {assignee ? assignee.display_name : tr("未指派")}
      </span>
      <StatusChip status={thread.status} />
    </Link>
  );
}

/** New thread dialog (workspace page + empty states). */
export function NewThreadDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId?: string;
}) {
  useLanguage();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const members = useMembers();
  const [ws, setWs] = useState(workspaceId ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const create = useAction(
    () => api.createThread({ workspace_id: workspaceId ?? ws, title: title.trim(), body: body.trim(), assignee: assignee || undefined }),
    { success: localized("讨论串已创建") },
  );
  const target = workspaceId ?? ws;
  const valid = target && title.trim() && body.trim();
  const submit = () => {
    if (!valid) return;
    create.mutate(undefined, {
      onSuccess: (r) => {
        onOpenChange(false);
        setTitle("");
        setBody("");
        setAssignee("");
        void navigate({ to: "/threads/$id", params: { id: r.thread.id } });
      },
    });
  };
  const agents = (members.data?.members ?? []).filter((m) => m.kind === "agent" && m.status === "active");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr("新建讨论串")}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={() => onOpenChange(false)}>{tr("取消")}</button>
          <button className="btn btn-primary" disabled={!valid || create.isPending} onClick={submit}>
            {create.isPending ? tr("创建中…") : tr("创建")}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!workspaceId && (
          <label className="flex flex-col gap-1.5">
            <span className="text-callout text-fg-2">{tr("工作区")}</span>
            <select className="field" value={ws} onChange={(e) => setWs(e.target.value)} required>
              <option value="">{tr("选择工作区")}</option>
              {(workspaces.data?.workspaces ?? [])
                .filter((w) => w.status === "active")
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-callout text-fg-2">{tr("标题")}</span>
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-callout text-fg-2">{tr("内容（支持 Markdown，用 @名字 提及成员）")}</span>
          <textarea
            className="field min-h-[140px] resize-y py-2.5"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            required
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-callout text-fg-2">{tr("负责人（可选）")}</span>
          <select className="field" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{tr("不指派")}</option>
            {agents.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}（@{m.name}）
              </option>
            ))}
          </select>
        </label>
      </form>
    </Dialog>
  );
}
