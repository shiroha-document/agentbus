import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, GitBranch, Pencil, Plus, Target } from "lucide-react";
import { api } from "../api";
import { qk, useAction } from "../queries";
import { formatRelative } from "../lib/format";
import { cn } from "../lib/util";
import type { ThreadStatus } from "../types";
import { Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { Markdown } from "../components/Markdown";
import { QueryError, RoutePending } from "../components/layout/RouteStates";
import { NewThreadDialog, ThreadRow, useMemberMap } from "../components/threads";
import { WorkspaceForm } from "./Workspaces";

const FILTERS: { value: ThreadStatus | ""; label: string }[] = [
  { value: "open", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "closed", label: "已关闭" },
  { value: "", label: "全部" },
];

export function WorkspaceDetailPage() {
  const { id } = useParams({ from: "/workspaces/$id" });
  const q = useQuery({ queryKey: qk.workspace(id), queryFn: () => api.workspace(id) });
  const members = useMemberMap();
  const [filter, setFilter] = useState<ThreadStatus | "">("open");
  const [briefOpen, setBriefOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [preview, setPreview] = useState(false);

  const update = useAction((body: Parameters<typeof api.updateWorkspace>[1]) => api.updateWorkspace(id, body), { success: "已保存" });

  if (q.isPending) return <RoutePending />;
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  const { workspace: w, threads } = q.data;
  const list = threads.filter((t) => !filter || t.status === filter).sort((a, b) => b.last_post_at - a.last_post_at);
  const counts = { open: 0, done: 0, closed: 0, "": threads.length } as Record<string, number>;
  for (const t of threads) counts[t.status] = (counts[t.status] ?? 0) + 1;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-title-1">{w.name}</h1>
          {w.status === "archived" ? <span className="chip chip-muted">已归档</span> : null}
          <div className="ml-auto flex gap-2">
            <button className="btn btn-secondary" onClick={() => setEditOpen(true)}>
              <Pencil size={16} aria-hidden /> 编辑
            </button>
            <button
              className="btn btn-ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: w.status === "active" ? "archived" : "active" })}
            >
              {w.status === "active" ? <Archive size={16} aria-hidden /> : <ArchiveRestore size={16} aria-hidden />}
              {w.status === "active" ? "归档" : "取消归档"}
            </button>
          </div>
        </div>
        <p className="flex items-start gap-2 text-body text-fg-2">
          <Target size={18} className="mt-[3px] flex-none text-mint-700" aria-hidden />
          {w.goal}
        </p>
        {w.repo ? (
          <p className="flex items-center gap-2 font-mono text-callout font-normal text-fg-2">
            <GitBranch size={16} className="flex-none text-fg-3" aria-hidden />
            <span className="truncate">{w.repo}</span>
            {w.branch ? <span className="chip chip-muted font-mono">{w.branch}</span> : null}
          </p>
        ) : null}
      </header>

      <section className="glass-1 card p-5" aria-label="Brief">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-title-2">Brief</h2>
          <span className="text-caption text-fg-caption">每轮都会作为上下文发给 agent · 更新于 {formatRelative(w.updated_at)}</span>
          <button
            className="btn btn-ghost btn-sm ml-auto"
            onClick={() => {
              setBrief(w.brief);
              setPreview(false);
              setBriefOpen(true);
            }}
          >
            <Pencil size={14} aria-hidden /> 编辑
          </button>
        </div>
        {w.brief.trim() ? (
          <Markdown>{w.brief}</Markdown>
        ) : (
          <EmptyState
            art="list"
            compact
            title="还没有 brief。写下背景、约定和验收标准，agent 每轮都能看到。"
            action={
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setBrief("");
                  setBriefOpen(true);
                }}
              >
                写 brief
              </button>
            }
          />
        )}
      </section>

      <section className="glass-1 card p-5" aria-label="讨论串">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-title-2">讨论串</h2>
          <div className="flex flex-wrap gap-1 rounded-[12px] bg-mint-100/60 p-1" role="tablist" aria-label="按状态筛选">
            {FILTERS.map((f) => (
              <button
                key={f.value || "all"}
                role="tab"
                aria-selected={filter === f.value}
                className={cn(
                  "h-8 rounded-[9px] px-3 text-callout transition-colors",
                  filter === f.value ? "bg-surface-solid text-fg shadow-1" : "text-fg-2 hover:text-fg",
                )}
                onClick={() => setFilter(f.value)}
              >
                {f.label} <span className="tabular text-fg-caption">{counts[f.value] ?? 0}</span>
              </button>
            ))}
          </div>
          <button className="btn btn-primary ml-auto" onClick={() => setNewOpen(true)} disabled={w.status !== "active"}>
            <Plus size={16} aria-hidden /> 新建讨论串
          </button>
        </div>
        {list.length === 0 ? (
          <EmptyState
            art="threads"
            compact
            title={filter ? "这个状态下没有讨论串" : "还没有讨论串"}
            action={
              w.status === "active" ? (
                <button className="btn btn-secondary" onClick={() => setNewOpen(true)}>
                  新建讨论串
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="-mx-2 flex flex-col">
            {list.map((t) => (
              <ThreadRow key={t.id} thread={t} members={members} />
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={briefOpen}
        onOpenChange={setBriefOpen}
        title="编辑 brief"
        description="Markdown 格式。保存后下一轮生效。"
        wide
        footer={
          <>
            <button className="btn btn-ghost mr-auto" onClick={() => setPreview((p) => !p)}>
              {preview ? "继续编辑" : "预览"}
            </button>
            <button className="btn btn-secondary" onClick={() => setBriefOpen(false)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={update.isPending || brief === w.brief}
              onClick={() => update.mutate({ brief }, { onSuccess: () => setBriefOpen(false) })}
            >
              {update.isPending ? "保存中…" : "保存"}
            </button>
          </>
        }
      >
        {preview ? (
          <div className="min-h-[320px] rounded-[12px] border border-line p-4">
            {brief.trim() ? <Markdown>{brief}</Markdown> : <p className="text-fg-3">（空）</p>}
          </div>
        ) : (
          <textarea
            className="field min-h-[320px] w-full resize-y py-3 font-mono text-callout font-normal"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            aria-label="brief 内容"
            autoFocus
          />
        )}
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen} title="编辑工作区" wide>
        {editOpen ? (
          <WorkspaceForm
            initial={w}
            submitLabel="保存"
            busy={update.isPending}
            onCancel={() => setEditOpen(false)}
            onSubmit={(b) =>
              update.mutate(
                { name: b.name, goal: b.goal, repo: b.repo || null, branch: b.branch || null },
                { onSuccess: () => setEditOpen(false) },
              )
            }
          />
        ) : null}
      </Dialog>

      <NewThreadDialog open={newOpen} onOpenChange={setNewOpen} workspaceId={w.id} />
    </div>
  );
}
