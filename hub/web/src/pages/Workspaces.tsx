import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { FolderKanban, GitBranch, Plus } from "lucide-react";
import { api } from "../api";
import { useAction, useWorkspaces } from "../queries";
import { formatRelative } from "../lib/format";
import { enterVariants } from "../lib/motion";
import type { Workspace } from "../types";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { QueryError } from "../components/layout/RouteStates";

export function WorkspaceForm({
  initial,
  onSubmit,
  busy,
  submitLabel,
  onCancel,
}: {
  initial?: Partial<Workspace>;
  onSubmit: (v: { name: string; goal: string; repo: string; branch: string; brief: string }) => void;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [repo, setRepo] = useState(initial?.repo ?? "");
  const [branch, setBranch] = useState(initial?.branch ?? "");
  const [brief, setBrief] = useState(initial?.brief ?? "");
  const valid = name.trim() && goal.trim();
  return (
    <form
      className="flex flex-col gap-4 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ name: name.trim(), goal: goal.trim(), repo: repo.trim(), branch: branch.trim(), brief });
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-callout text-fg-2">名称</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-callout text-fg-2">目标</span>
        <input className="field" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={300} required />
      </label>
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <label className="flex flex-col gap-1.5">
          <span className="text-callout text-fg-2">仓库（可选）</span>
          <input className="field" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="github.com/org/repo" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-callout text-fg-2">分支（可选）</span>
          <input className="field" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
        </label>
      </div>
      {initial === undefined && (
        <label className="flex flex-col gap-1.5">
          <span className="text-callout text-fg-2">Brief（可选，Markdown）</span>
          <textarea className="field min-h-[120px] resize-y py-2.5 font-mono text-callout" value={brief} onChange={(e) => setBrief(e.target.value)} />
        </label>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
          {busy ? "保存中…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function WorkspaceCard({ w }: { w: Workspace }) {
  return (
    <Link to="/workspaces/$id" params={{ id: w.id }} className="glass-1 card card-hover flex h-full flex-col gap-3 p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[12px] bg-mint-100 text-mint-700">
          <FolderKanban size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-title-2">{w.name}</h2>
            {w.status === "archived" ? <span className="chip chip-muted flex-none">已归档</span> : null}
          </div>
          <p className="mt-1 line-clamp-2 text-callout font-normal text-fg-2">{w.goal}</p>
        </div>
      </div>
      {w.repo ? (
        <div className="flex items-center gap-1.5 truncate font-mono text-caption text-fg-caption">
          <GitBranch size={12} aria-hidden />
          <span className="truncate">
            {w.repo}
            {w.branch ? `@${w.branch}` : ""}
          </span>
        </div>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 text-caption">
        <span className="chip">进行中 {w.thread_counts.open}</span>
        <span className="chip chip-info">已完成 {w.thread_counts.done}</span>
        <span className="chip chip-muted">已关闭 {w.thread_counts.closed}</span>
        <span className="ml-auto text-fg-caption">更新于 {formatRelative(w.updated_at)}</span>
      </div>
    </Link>
  );
}

export function WorkspacesPage() {
  const reduced = useReducedMotion() ?? false;
  const v = enterVariants(reduced);
  const navigate = useNavigate();
  const ws = useWorkspaces();
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const create = useAction(
    (b: { name: string; goal: string; repo: string; branch: string; brief: string }) =>
      api.createWorkspace({ name: b.name, goal: b.goal, repo: b.repo || undefined, branch: b.branch || undefined, brief: b.brief || undefined }),
    { success: "工作区已创建" },
  );
  const all = ws.data?.workspaces ?? [];
  const list = all.filter((w) => showArchived || w.status === "active");
  const archivedCount = all.filter((w) => w.status === "archived").length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-title-1">工作区</h1>
        {archivedCount > 0 ? (
          <label className="ml-2 flex items-center gap-2 text-callout text-fg-2">
            <input type="checkbox" className="h-4 w-4 accent-[var(--mint-500)]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            显示已归档（{archivedCount}）
          </label>
        ) : null}
        <button className="btn btn-primary ml-auto" onClick={() => setOpen(true)}>
          <Plus size={16} aria-hidden /> 新建工作区
        </button>
      </div>
      {ws.isPending ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-44" />
          ))}
        </div>
      ) : ws.isError ? (
        <QueryError error={ws.error} onRetry={() => void ws.refetch()} />
      ) : list.length === 0 ? (
        <div className="glass-1 card">
          <EmptyState
            art="folder"
            title="还没有工作区。工作区对应一个目标和一个仓库，agent 在里面开讨论串协作。"
            action={
              <button className="btn btn-primary" onClick={() => setOpen(true)}>
                <Plus size={16} aria-hidden /> 新建工作区
              </button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((w, i) => (
            <motion.div key={w.id} variants={v} initial="hidden" animate="show" custom={i}>
              <WorkspaceCard w={w} />
            </motion.div>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="新建工作区" wide>
        {open ? (
          <WorkspaceForm
            submitLabel="创建"
            busy={create.isPending}
            onCancel={() => setOpen(false)}
            onSubmit={(b) =>
              create.mutate(b, {
                onSuccess: (r) => {
                  setOpen(false);
                  void navigate({ to: "/workspaces/$id", params: { id: r.workspace.id } });
                },
              })
            }
          />
        ) : null}
      </Dialog>
    </div>
  );
}
