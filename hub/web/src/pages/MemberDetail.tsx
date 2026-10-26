import { t as tr, useLanguage, localized } from "../lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Ban, KeyRound, Pause, Play, Plus, Trash2, UserMinus, X } from "lucide-react";
import { api } from "../api";
import { qk, useAction, useMe, useRole, useWorkspaces } from "../queries";
import { formatDateTime, formatDuration, formatRelative, formatTokens, formatUsd, totalTokens } from "../lib/format";
import { groupQuota, windowLabel } from "../lib/quota";
import { cn } from "../lib/util";
import { roleLabel } from "../lib/team";
import type { MemberDetailResponse, QuotaRule, Run } from "../types";
import { Avatar } from "../components/ui/Avatar";
import { ConfirmDialog, Dialog } from "../components/ui/Dialog";
import { EmptyState } from "../components/ui/EmptyState";
import { QuotaRing } from "../components/ui/QuotaRing";
import { StatusDot, presenceOf } from "../components/ui/StatusDot";
import { QueryError, RoutePending } from "../components/layout/RouteStates";

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  useLanguage();
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 className="text-callout font-semibold text-fg">{title}</h3>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

type RuleDraft = Omit<QuotaRule, "member_id"> & { key: number };

function QuotaRulesEditor({ data, readOnly }: { data: MemberDetailResponse; readOnly?: boolean }) {
  useLanguage();
  const id = data.member.id;
  const toDraft = (rules: QuotaRule[]): RuleDraft[] => rules.map((r, i) => ({ provider: r.provider, window: r.window, pause_at_pct: r.pause_at_pct, key: i }));
  const [rules, setRules] = useState<RuleDraft[]>(() => toDraft(data.quota_rules));
  const [nextKey, setNextKey] = useState(data.quota_rules.length);
  useEffect(() => {
    setRules(toDraft(data.quota_rules));
  }, [data.quota_rules]);
  const save = useAction(
    () => api.putQuotaRules(id, rules.map(({ provider, window, pause_at_pct }) => ({ provider: provider.trim() || "*", window: window.trim() || "*", pause_at_pct }))),
    { success: localized("阈值已保存"), invalidate: [qk.member(id), qk.members] },
  );
  const providers = useMemo(() => [...new Set(["*", ...data.quota.map((q) => q.provider)])], [data.quota]);
  const windows = useMemo(() => [...new Set(["*", ...data.quota.map((q) => q.window)])], [data.quota]);
  const dirty = JSON.stringify(rules.map(({ key: _k, ...r }) => r)) !== JSON.stringify(data.quota_rules.map(({ member_id: _m, ...r }) => r));
  const set = (key: number, patch: Partial<RuleDraft>) => setRules((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <Section
      title={tr("额度暂停阈值")}
      action={
        readOnly ? null : (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setRules((rs) => [...rs, { provider: providers[1] ?? "*", window: "*", pause_at_pct: 100, key: nextKey }]);
              setNextKey((k) => k + 1);
            }}
          >
            <Plus size={14} aria-hidden />{" "}{tr("添加规则")}</button>
        )
      }
    >
      <fieldset disabled={readOnly} className="contents">
      <p className="text-caption text-fg-caption">{tr("任一读数达到阈值就暂停，到重置时间自动恢复。匹配优先级：精确 > provider/* > */*，默认 100%。")}</p>
      <datalist id="quota-providers">
        {providers.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <datalist id="quota-windows">
        {windows.map((w) => (
          <option key={w} value={w}>
            {windowLabel(w)}
          </option>
        ))}
      </datalist>
      {rules.length === 0 ? <p className="text-callout font-normal text-fg-3">{tr("没有规则，使用默认阈值。")}</p> : null}
      {rules.map((r) => (
        <div key={r.key} className="flex flex-col gap-2 rounded-[14px] border border-line p-3">
          <div className="flex items-center gap-2">
            <input
              className="field h-9 min-h-0 flex-1 py-0 text-callout"
              list="quota-providers"
              value={r.provider}
              onChange={(e) => set(r.key, { provider: e.target.value })}
              aria-label={tr("provider.label")}
              placeholder="provider"
            />
            <input
              className="field h-9 min-h-0 w-28 py-0 text-callout"
              list="quota-windows"
              value={r.window}
              onChange={(e) => set(r.key, { window: e.target.value })}
              aria-label={tr("窗口")}
              placeholder={tr("窗口")}
            />
            <button
              className="btn btn-ghost btn-icon h-9 w-9"
              aria-label={tr("删除规则")}
              onClick={() => setRules((rs) => rs.filter((x) => x.key !== r.key))}
            >
              <X size={16} />
            </button>
          </div>
          <label className="flex items-center gap-3">
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={r.pause_at_pct}
              onChange={(e) => set(r.key, { pause_at_pct: Number(e.target.value) })}
              className="h-2 flex-1 accent-[var(--mint-500)]"
              aria-label={tr("{0}/{1} 暂停阈值", [r.provider, r.window])}
            />
            <span className="tabular w-12 text-right text-callout">{r.pause_at_pct}%</span>
          </label>
        </div>
      ))}
      </fieldset>
      {dirty && !readOnly ? (
        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary btn-sm" onClick={() => setRules(toDraft(data.quota_rules))}>{tr("还原")}</button>
          <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(undefined)}>{tr("保存阈值")}</button>
        </div>
      ) : null}
    </Section>
  );
}

function BudgetEditor({ data, readOnly }: { data: MemberDetailResponse; readOnly?: boolean }) {
  useLanguage();
  const id = data.member.id;
  const [tokens, setTokens] = useState(data.budget?.daily_tokens?.toString() ?? "");
  const [usd, setUsd] = useState(data.budget?.monthly_usd?.toString() ?? "");
  useEffect(() => {
    setTokens(data.budget?.daily_tokens?.toString() ?? "");
    setUsd(data.budget?.monthly_usd?.toString() ?? "");
  }, [data.budget]);
  const save = useAction(
    () =>
      api.putBudget(id, {
        daily_tokens: tokens.trim() ? Math.max(0, Math.round(Number(tokens))) : null,
        monthly_usd: usd.trim() ? Math.max(0, Number(usd)) : null,
      }),
    { success: localized("预算已保存"), invalidate: [qk.member(id)] },
  );
  const invalid = (tokens.trim() && !Number.isFinite(Number(tokens))) || (usd.trim() && !Number.isFinite(Number(usd)));
  const dirty = tokens !== (data.budget?.daily_tokens?.toString() ?? "") || usd !== (data.budget?.monthly_usd?.toString() ?? "");
  return (
    <Section title={tr("预算")}>
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-caption">{tr("每日 token 上限")}</span>
          <input className="field tabular" inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder={tr("不限")} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption text-fg-caption">{tr("每月金额上限（USD）")}</span>
          <input className="field tabular" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} placeholder={tr("不限")} />
        </label>
      </fieldset>
      {dirty && !readOnly ? (
        <div className="flex justify-end">
          <button className="btn btn-primary btn-sm" disabled={!!invalid || save.isPending} onClick={() => save.mutate(undefined)}>{tr("保存预算")}</button>
        </div>
      ) : null}
    </Section>
  );
}

function ScopesEditor({ data }: { data: MemberDetailResponse }) {
  useLanguage();
  const id = data.member.id;
  const ws = useWorkspaces();
  const [sel, setSel] = useState<Set<string>>(() => new Set(data.scopes ?? []));
  useEffect(() => setSel(new Set(data.scopes ?? [])), [data.scopes]);
  const save = useAction(() => api.putScopes(id, [...sel]), { success: localized("作用范围已保存"), invalidate: [qk.member(id)] });
  return (
    <Section title={tr("Manager 作用范围")}>
      <p className="text-caption text-fg-caption">{tr("不勾选任何工作区 = 可以管理全部。")}</p>
      <div className="flex flex-col gap-1">
        {(ws.data?.workspaces ?? []).map((w) => (
          <label key={w.id} className="flex min-h-[40px] items-center gap-3 rounded-[12px] px-2 hover:bg-mint-100">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--mint-500)]"
              checked={sel.has(w.id)}
              onChange={(e) =>
                setSel((s) => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(w.id);
                  else n.delete(w.id);
                  return n;
                })
              }
            />
            <span className="text-callout font-normal">{w.name}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(undefined)}>{tr("保存范围")}</button>
      </div>
    </Section>
  );
}

export function RunsTable({ runs, showMember, memberName }: { runs: Run[]; showMember?: boolean; memberName?: (id: string) => string }) {
  useLanguage();
  if (runs.length === 0) return <EmptyState art="list" compact title={tr("还没有运行记录")} />;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-caption">
        <thead className="text-fg-caption">
          <tr className="border-b border-line">
            <th className="px-2 py-2 font-medium">{tr("开始")}</th>
            {showMember ? <th className="px-2 py-2 font-medium">{tr("成员")}</th> : null}
            <th className="px-2 py-2 font-medium">{tr("讨论串")}</th>
            <th className="px-2 py-2 font-medium">{tr("模型")}</th>
            <th className="px-2 py-2 text-right font-medium">tokens</th>
            <th className="px-2 py-2 text-right font-medium">{tr("金额")}</th>
            <th className="px-2 py-2 text-right font-medium">{tr("耗时")}</th>
            <th className="px-2 py-2 font-medium">{tr("结果")}</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-b-0">
              <td className="whitespace-nowrap px-2 py-2 text-fg-2" title={formatDateTime(r.started_at)}>
                {formatRelative(r.started_at)}
              </td>
              {showMember ? <td className="px-2 py-2">{memberName?.(r.member_id) ?? r.member_id}</td> : null}
              <td className="max-w-[160px] truncate px-2 py-2">
                {r.thread_id ? (
                  <Link to="/threads/$id" params={{ id: r.thread_id }} className="text-mint-700 hover:underline">
                    {r.thread_id.slice(0, 10)}
                  </Link>
                ) : (
                  <span className="text-fg-3">—</span>
                )}
              </td>
              <td className="max-w-[140px] truncate px-2 py-2 text-fg-2">{r.model ?? r.cli}</td>
              <td className="px-2 py-2 text-right">{formatTokens(totalTokens(r))}</td>
              <td className="px-2 py-2 text-right">{formatUsd(r.cost_usd_est)}</td>
              <td className="px-2 py-2 text-right">{formatDuration(r.ended_at - r.started_at)}</td>
              <td className="px-2 py-2">
                {r.exit_code === 0 ? (
                  <span className="chip">{tr("成功")}</span>
                ) : (
                  <span className="chip chip-danger" title={r.error_summary ?? undefined}>{tr("失败")}{" "}{r.exit_code}
                  </span>
                )}
                {r.exit_code !== 0 && r.error_summary ? (
                  <div className="mt-1 line-clamp-2 max-w-[240px] text-fg-caption">{r.error_summary}</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function usage7d(u: MemberDetailResponse["usage_7d"]): { tokens: number; cost: number } | null {
  if (!u) return null;
  if (Array.isArray(u)) return u.reduce((a, x) => ({ tokens: a.tokens + totalTokens(x), cost: a.cost + x.cost }), { tokens: 0, cost: 0 });
  return u;
}

/** Member detail panel — used in the drawer on /members and on /members/$id. */
export function MemberDetail({ id, onGone }: { id: string; onGone?: () => void }) {
  useLanguage();
  const q = useQuery({ queryKey: qk.member(id), queryFn: () => api.member(id) });
  const { isAdmin, isOwner } = useRole();
  const selfId = useMe().data?.member?.id;
  const [pauseOpen, setPauseOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const inv = [qk.member(id), qk.members, qk.dashboard];
  const pause = useAction(
    () => api.pauseMember(id, reason.trim() || tr("手动暂停"), until ? new Date(until).getTime() : undefined),
    { success: localized("已暂停"), invalidate: inv },
  );
  const resume = useAction(() => api.resumeMember(id), { success: localized("已恢复"), invalidate: inv });
  const role = useAction((r: "agent" | "manager") => api.updateMember(id, { role: r }), { success: localized("角色已更新"), invalidate: inv });
  const revoke = useAction(() => api.revokeMember(id), { success: localized("已吊销"), invalidate: inv });
  const removeHuman = useAction(() => api.revokeMember(id), { success: localized("已移出团队"), invalidate: inv });
  const [removeOpen, setRemoveOpen] = useState(false);
  const del = useAction(() => api.deleteMember(id), { success: localized("已删除"), invalidate: [qk.members] });
  const approve = useAction(() => api.approveMember(id), { success: localized("已同意加入"), invalidate: inv });
  const reject = useAction(() => api.rejectMember(id), { success: localized("已拒绝"), invalidate: inv });

  if (q.isPending) return <RoutePending />;
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const m = d.member;
  const state = presenceOf(m);
  const u7 = usage7d(d.usage_7d);
  const groups = groupQuota(d.quota);
  const isAgent = m.kind === "agent";
  // Contract: revoking a human is owner-only and never targets the owner (nor yourself — use 退出团队).
  const canRemoveHuman = !isAgent && isOwner && m.status === "active" && m.role !== "owner" && m.id !== selfId;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <Avatar member={m} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-title-2">{m.display_name}</h2>
            <span className={cn("chip", m.role === "owner" || m.role === "manager" ? "" : "chip-muted")}>{roleLabel(m.role)}</span>
            {m.id === selfId ? <span className="text-caption text-fg-caption">{tr("（我）")}</span> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-caption">
            <span>@{m.name}</span>
            <StatusDot state={state} />
            <span>{m.last_seen_at ? tr("最后在线 {0}", [formatRelative(m.last_seen_at)]) : tr("从未在线")}</span>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption sm:grid-cols-3">
        {[
          ["CLI", m.cli],
          [tr("机器"), m.machine],
          [tr("负责人"), m.owner],
          [tr("唤醒"), m.wake_mode ? `${m.wake_mode === "poll" ? tr("轮询") : tr("触发")}${m.wake_interval_s ? tr(" · {0} 分钟", [Math.round(m.wake_interval_s / 60)]) : ""}` : null],
          [tr("客户端版本"), m.client_version],
          [tr("加入时间"), formatDateTime(m.created_at)],
        ].map(([k, v]) => (
          <div key={k as string} className="min-w-0">
            <dt className="text-fg-caption">{k}</dt>
            <dd className="truncate text-callout font-normal text-fg">{v || "—"}</dd>
          </div>
        ))}
      </dl>

      {m.paused ? (
        <div className="rounded-[14px] border border-line border-l-[3px] border-l-warning bg-surface-strong px-4 py-3 text-callout">
          <div className="font-semibold">{tr("已暂停")}</div>
          <div className="font-normal text-fg-2">
            {m.pause_reason ?? tr("无原因")}
            {m.paused_until ? tr(" · {0} 自动恢复", [formatDateTime(m.paused_until)]) : ""}
          </div>
        </div>
      ) : null}

      {!isAgent ? (
        <p className="text-caption text-fg-caption">
          {m.role === "owner" ? tr("团队所有者，可以移交所有权、删除团队、移出管理员。") : tr("团队管理员，可以审批 agent、管理设置和邀请。")}
          {canRemoveHuman ? null : m.status === "active" && m.role !== "owner" && !isOwner ? tr(" 只有所有者能移出管理员。") : ""}
        </p>
      ) : null}

      {canRemoveHuman ? (
        <div className="flex">
          <button className="btn btn-danger btn-lg sm:h-10" onClick={() => setRemoveOpen(true)}>
            <UserMinus size={16} aria-hidden />{" "}{tr("移出团队")}</button>
        </div>
      ) : null}

      {m.status === "pending" && isAdmin ? (
        <div className="flex gap-2">
          <button className="btn btn-primary btn-lg flex-1" disabled={approve.isPending} onClick={() => approve.mutate(undefined)}>{tr("同意加入")}</button>
          <button className="btn btn-secondary btn-lg flex-1" disabled={reject.isPending} onClick={() => reject.mutate(undefined)}>{tr("拒绝")}</button>
        </div>
      ) : null}

      {m.status === "active" && isAgent && isAdmin ? (
        <div className="flex flex-wrap gap-2">
          {m.paused ? (
            <button className="btn btn-primary btn-lg sm:h-10" disabled={resume.isPending} onClick={() => resume.mutate(undefined)}>
              <Play size={16} aria-hidden />{" "}{tr("恢复")}</button>
          ) : (
            <button className="btn btn-secondary btn-lg sm:h-10" onClick={() => setPauseOpen(true)}>
              <Pause size={16} aria-hidden />{" "}{tr("暂停")}</button>
          )}
          <label className="flex items-center gap-2 text-callout">
            <span className="text-fg-2">{tr("角色")}</span>
            <select
              className="field h-11 w-auto sm:h-10"
              value={m.role === "manager" ? "manager" : "agent"}
              disabled={role.isPending}
              onChange={(e) => role.mutate(e.target.value as "agent" | "manager")}
            >
              <option value="agent">{tr("role.agent")}</option>
              <option value="manager">{tr("role.manager")}</option>
            </select>
          </label>
          <button className="btn btn-danger btn-lg ml-auto sm:h-10" onClick={() => setRevokeOpen(true)}>
            <Ban size={16} aria-hidden />{" "}{tr("吊销")}</button>
        </div>
      ) : null}

      {m.status === "revoked" && isAdmin ? (
        <div className="flex">
          <button className="btn btn-danger-solid btn-lg sm:h-10" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={16} aria-hidden />{" "}{tr("删除成员")}</button>
        </div>
      ) : null}

      {isAgent ? (
        <>
          <Section title={tr("额度")}>
            {groups.length === 0 ? (
              <p className="text-callout font-normal text-fg-3">{tr("还没有额度读数")}</p>
            ) : (
              <div className="flex flex-wrap gap-4">
                {groups.map((g) => (
                  <QuotaRing key={g.key} group={g} />
                ))}
              </div>
            )}
            {u7 ? (
              <p className="tabular text-caption text-fg-caption">{tr("近 7 天：")}{formatTokens(u7.tokens)} tokens · {formatUsd(u7.cost)}
              </p>
            ) : null}
          </Section>
          {m.status !== "revoked" ? (
            <>
              <QuotaRulesEditor data={d} readOnly={!isAdmin} />
              <BudgetEditor data={d} readOnly={!isAdmin} />
            </>
          ) : null}
          {m.role === "manager" && isAdmin ? <ScopesEditor data={d} /> : null}
          <Section title={tr("密钥")}>
            {d.keys.length === 0 ? (
              <p className="text-callout font-normal text-fg-3">{tr("没有有效公钥")}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {d.keys.map((k, i) => (
                  <li key={i} className="flex items-center gap-2 text-caption">
                    <KeyRound size={14} className="text-fg-3" aria-hidden />
                    <span className="text-fg-2">{tr("创建于")}{" "}{formatDateTime(k.created_at)}</span>
                    {k.expires_at ? (
                      <span className="chip chip-warning">{k.expires_at > Date.now() ? tr("{0} 过期", [formatDateTime(k.expires_at)]) : tr("已过期")}</span>
                    ) : (
                      <span className="chip">{tr("长期有效")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={tr("最近运行")}>
            <RunsTable runs={d.runs} />
          </Section>
        </>
      ) : null}

      <Dialog
        open={pauseOpen}
        onOpenChange={setPauseOpen}
        title={tr("暂停 {0}", [m.display_name])}
        description={tr("暂停后不会再领取新消息，已领取的会继续处理完。")}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setPauseOpen(false)}>{tr("取消")}</button>
            <button
              className="btn btn-primary"
              disabled={pause.isPending}
              onClick={() => pause.mutate(undefined, { onSuccess: () => setPauseOpen(false) })}
            >{tr("暂停")}</button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-callout text-fg-2">{tr("原因")}</span>
            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr("例如：等待需求确认")} autoFocus />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-callout text-fg-2">{tr("自动恢复时间（可选）")}</span>
            <input className="field" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
      </Dialog>

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={tr("吊销 {0}？", [m.display_name])}
        description={tr("吊销后它的公钥全部失效，未完成的租约会退回。这个操作不能撤销，只能让它重新申请加入。")}
        confirmLabel={tr("吊销")}
        danger
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate(undefined, { onSuccess: () => setRevokeOpen(false) })}
      />
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={tr("把 {0} 移出团队？", [m.display_name])}
        description={tr("对方会立即失去这个团队的访问权限，历史帖子会保留。之后可以重新发邀请链接让对方回来。")}
        confirmLabel={tr("移出")}
        danger
        busy={removeHuman.isPending}
        onConfirm={() => removeHuman.mutate(undefined, { onSuccess: () => setRemoveOpen(false) })}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={tr("删除 {0}？", [m.display_name])}
        description={tr("成员记录会被删除，历史帖子会保留但作者显示为未知成员。")}
        confirmLabel={tr("删除")}
        danger
        busy={del.isPending}
        onConfirm={() =>
          del.mutate(undefined, {
            onSuccess: () => {
              setDeleteOpen(false);
              onGone?.();
            },
          })
        }
      />
    </div>
  );
}

export function MemberDetailRoutePage() {
  useLanguage();
  const { id } = useParams({ from: "/members/$id" });
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link to="/members" className={cn("btn btn-ghost -ml-3 self-start")}>
        <ArrowLeft size={16} aria-hidden />{" "}{tr("成员")}</Link>
      <div className="glass-1 card p-5 sm:p-6">
        <MemberDetail id={id} onGone={() => void navigate({ to: "/members" })} />
      </div>
    </div>
  );
}
