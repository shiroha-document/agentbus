import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bot, Clock, ExternalLink, RefreshCw, UserPlus } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { api } from "../api";
import { qk, useAction, useMembers } from "../queries";
import { formatDuration, formatRelative, formatTokens, formatUsd, totalTokens } from "../lib/format";
import { groupQuota } from "../lib/quota";
import { enterVariants } from "../lib/motion";
import { cn, ROLE_LABEL } from "../lib/util";
import type { MemberWithStats } from "../types";
import { Avatar } from "../components/ui/Avatar";
import { Drawer } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { QuotaRing } from "../components/ui/QuotaRing";
import { StatusDot, presenceOf } from "../components/ui/StatusDot";
import { QueryError } from "../components/layout/RouteStates";
import { MemberDetail } from "./MemberDetail";

function AgentCard({ m, onOpen }: { m: MemberWithStats; onOpen: () => void }) {
  const groups = groupQuota(m.quota);
  const run = m.last_run;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="glass-1 card card-hover flex h-full w-full flex-col gap-4 p-5 text-left"
      aria-label={`查看 ${m.display_name} 详情`}
    >
      <div className="flex items-center gap-3">
        <Avatar member={m} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-semibold text-fg">{m.display_name}</span>
            {m.role === "manager" ? <span className="chip flex-none">{ROLE_LABEL.manager}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-caption text-fg-caption">
            <span>@{m.name}</span>
            {m.cli ? <span>· {m.cli}</span> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <StatusDot state={presenceOf(m)} />
          <span className="text-caption text-fg-caption">{m.last_seen_at ? formatRelative(m.last_seen_at) : "从未在线"}</span>
        </div>
      </div>

      {m.paused && m.pause_reason ? (
        <div className="line-clamp-1 rounded-[10px] bg-mint-50 px-3 py-1.5 text-caption text-warning-text">
          {m.pause_reason}
          {m.paused_until ? ` · ${formatRelative(m.paused_until)}恢复` : ""}
        </div>
      ) : null}

      {groups.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {groups.map((g) => (
            <QuotaRing key={g.key} group={g} size={52} />
          ))}
        </div>
      ) : (
        <p className="text-caption text-fg-caption">还没有额度读数</p>
      )}

      <div className="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-3 text-caption">
        <div>
          <div className="text-fg-caption">今日</div>
          <div className="tabular text-callout text-fg">
            {formatTokens(m.today.tokens)} · {formatUsd(m.today.cost)}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-fg-caption">最近一轮</div>
          {run ? (
            <div className={cn("tabular truncate text-callout", run.exit_code === 0 ? "text-fg" : "text-danger-text")}>
              {formatRelative(run.started_at)} · {run.exit_code === 0 ? formatTokens(totalTokens(run)) : `失败 ${run.exit_code}`}
              <span className="text-fg-caption"> · {formatDuration(run.ended_at - run.started_at)}</span>
            </div>
          ) : (
            <div className="text-callout text-fg-3">—</div>
          )}
        </div>
      </div>
    </button>
  );
}

function PendingJoins({ list }: { list: MemberWithStats[] }) {
  const inv = [qk.members, qk.dashboard];
  const approve = useAction((id: string) => api.approveMember(id), { success: "已同意加入", invalidate: inv });
  const reject = useAction((id: string) => api.rejectMember(id), { success: "已拒绝", invalidate: inv });
  return (
    <section className="glass-1 card border-l-[3px] border-l-mint-500 p-5" aria-label="加入申请">
      <h2 className="mb-3 flex items-center gap-2 text-title-2">
        <UserPlus size={20} className="text-mint-700" aria-hidden /> 加入申请
        <span className="chip">{list.length}</span>
      </h2>
      <ul className="flex flex-col divide-y divide-line">
        {list.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
            <Avatar member={m} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-callout">
                {m.display_name} <span className="text-fg-caption">@{m.name}</span>
              </div>
              <div className="truncate text-caption text-fg-caption">
                {[m.cli, m.machine && `机器 ${m.machine}`, m.owner && `负责人 ${m.owner}`, m.client_version && `v${m.client_version}`]
                  .filter(Boolean)
                  .join(" · ")}{" "}
                · {formatRelative(m.created_at)}申请
              </div>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <button className="btn btn-primary btn-lg flex-1 sm:h-9 sm:flex-none" disabled={approve.isPending} onClick={() => approve.mutate(m.id)}>
                同意
              </button>
              <button className="btn btn-secondary btn-lg flex-1 sm:h-9 sm:flex-none" disabled={reject.isPending} onClick={() => reject.mutate(m.id)}>
                拒绝
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MembersPage() {
  const reduced = useReducedMotion() ?? false;
  const v = enterVariants(reduced);
  const q = useMembers();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const all = q.data?.members ?? [];
  const pending = all.filter((m) => m.status === "pending");
  const agents = all
    .filter((m) => m.kind === "agent" && m.status !== "pending" && (showRevoked || m.status !== "revoked"))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const humans = all.filter((m) => m.kind === "human");
  const revokedCount = all.filter((m) => m.status === "revoked").length;
  const openMember = all.find((m) => m.id === openId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-title-1">成员</h1>
        {q.data ? (
          <span className="text-callout font-normal text-fg-2">
            {all.filter((m) => m.kind === "agent" && m.online && m.status === "active").length} 个 agent 在线
          </span>
        ) : null}
        {revokedCount > 0 ? (
          <label className="ml-auto flex items-center gap-2 text-callout text-fg-2">
            <input type="checkbox" className="h-4 w-4 accent-[var(--mint-500)]" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
            显示已吊销（{revokedCount}）
          </label>
        ) : null}
      </div>

      {q.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-64" />
          ))}
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          {pending.length > 0 ? <PendingJoins list={pending} /> : null}
          {agents.length === 0 ? (
            <div className="glass-1 card">
              <EmptyState
                art="agents"
                title="还没有 agent。在机器上运行 agentbus setup，加入申请会出现在这里。"
                action={
                  <button className="btn btn-secondary" onClick={() => void q.refetch()} disabled={q.isFetching}>
                    <RefreshCw size={16} aria-hidden /> 刷新
                  </button>
                }
              />
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((m, i) => (
                <motion.div key={m.id} variants={v} initial="hidden" animate="show" custom={i}>
                  <AgentCard m={m} onOpen={() => setOpenId(m.id)} />
                </motion.div>
              ))}
            </div>
          )}
          {humans.length > 0 ? (
            <section className="glass-1 card p-5" aria-label="管理员">
              <h2 className="mb-3 flex items-center gap-2 text-title-2">
                <Bot size={20} className="text-mint-700" aria-hidden /> 管理员
              </h2>
              <ul className="flex flex-wrap gap-4">
                {humans.map((m) => (
                  <li key={m.id} className="flex items-center gap-2">
                    <Avatar member={m} size={28} />
                    <span className="text-callout">{m.display_name}</span>
                    <span className="flex items-center gap-1 text-caption text-fg-caption">
                      <Clock size={12} aria-hidden />
                      {m.last_seen_at ? formatRelative(m.last_seen_at) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <Drawer open={!!openId} onOpenChange={(o) => !o && setOpenId(null)} title={openMember?.display_name ?? "成员详情"}>
        {openId ? (
          <>
            <MemberDetail id={openId} onGone={() => setOpenId(null)} />
            <Link to="/members/$id" params={{ id: openId }} className="btn btn-ghost mt-6">
              <ExternalLink size={16} aria-hidden /> 在单独页面打开
            </Link>
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
