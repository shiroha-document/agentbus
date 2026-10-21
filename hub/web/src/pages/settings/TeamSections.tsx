// Team-management sections of the settings page (hub-api.md §6): team name,
// member invites, agent join codes and the owner/member danger zone.

import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Building2, ChevronDown, KeyRound, LogOut, MailPlus, Plus, Trash2, UserCog, UserPlus } from "lucide-react";
import { api } from "../../api";
import { qk, selectTeam, useAction, useMe, useMembers, useRole } from "../../queries";
import { formatDateTime, formatRelative } from "../../lib/format";
import { easeOut, reducedFade } from "../../lib/motion";
import {
  deleteConfirmMatches,
  INVITE_STATUS_LABEL,
  inviteStatus,
  joinCodeStatus,
  unixOneLiner,
  roleLabel,
  type InviteStatus,
  type JoinCodeStatus,
} from "../../lib/team";
import { cn } from "../../lib/util";
import type { Invite, JoinCode } from "../../types";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { CopyButton, SecretBlock } from "../../components/ui/CopyButton";
import { EmptyState } from "../../components/ui/EmptyState";
import { toast } from "../../components/ui/Toast";
import { QueryError } from "../../components/layout/RouteStates";
import { TeamTile } from "../../components/layout/TeamSwitcher";
import { useMemberMap } from "../../components/threads";
import { useAddAgent } from "../../components/AddAgentDialog";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SectionTitle({ id, icon: Icon, children }: { id: string; icon: typeof Building2; children: React.ReactNode }) {
  return (
    <h2 id={id} className="flex items-center gap-2 text-title-2">
      <Icon size={20} className="text-mint-700" aria-hidden /> {children}
    </h2>
  );
}

function Reveal({ show, children }: { show: boolean; children: React.ReactNode }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={reduced ? reducedFade : easeOut}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------- 团队

export function TeamSection() {
  const { data } = useMe();
  const { isAdmin } = useRole();
  const team = data?.team;
  const [name, setName] = useState(team?.name ?? "");
  const rename = useAction((n: string) => api.updateTeam(n), { success: "团队名称已更新", invalidate: [qk.me] });
  if (!team) return null;
  const trimmed = name.trim();
  const dirty = trimmed !== team.name;
  const valid = trimmed.length > 0 && trimmed.length <= 40;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty && valid && !rename.isPending) rename.mutate(trimmed);
  };
  return (
    <section id="team" className="glass-1 card scroll-mt-20 p-5" aria-labelledby="s-team">
      <div className="mb-4 flex items-center gap-4">
        <TeamTile id={team.id} name={trimmed || team.name} size={48} />
        <div className="min-w-0 flex-1">
          <SectionTitle id="s-team" icon={Building2}>
            团队
          </SectionTitle>
          <p className="mt-0.5 text-caption text-fg-caption">
            你的身份：{roleLabel(data?.role)} · 创建于 {formatDateTime(team.created_at)} · <span className="font-mono">{team.id}</span>
          </p>
        </div>
      </div>
      {isAdmin ? (
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1.5">
            <span className="text-callout">团队名称</span>
            <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-invalid={!valid} />
          </label>
          <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={!dirty || !valid || rename.isPending}>
            {rename.isPending ? "保存中…" : "重命名"}
          </button>
        </form>
      ) : (
        <p className="text-callout font-normal text-fg-2">
          团队名称：<span className="text-fg">{team.name}</span>。只有管理员可以修改团队设置。
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 成员邀请

const INVITE_CHIP: Record<InviteStatus, string> = {
  pending: "chip",
  accepted: "chip chip-info",
  revoked: "chip chip-muted",
  expired: "chip chip-muted",
};

export function InvitesSection() {
  const members = useMemberMap();
  const q = useQuery({ queryKey: qk.invites, queryFn: api.invites });
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<{ url: string; email: string | null } | null>(null);
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const create = useAction((e: string) => api.createInvite(e || undefined), { invalidate: [qk.invites] });
  const revoke = useAction((id: string) => api.revokeInvite(id), { success: "邀请已作废", invalidate: [qk.invites] });
  const trimmed = email.trim();
  const valid = trimmed === "" || EMAIL_RE.test(trimmed);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || create.isPending) return;
    create.mutate(trimmed, {
      onSuccess: (r) => {
        setCreated({ url: r.url, email: r.invite.email });
        setEmail("");
      },
    });
  };

  const invites = q.data?.invites ?? [];
  return (
    <section id="invites" className="glass-1 card scroll-mt-20 p-5" aria-labelledby="s-invites">
      <SectionTitle id="s-invites" icon={MailPlus}>
        成员邀请
      </SectionTitle>
      <p className="mb-4 mt-1 text-callout font-normal text-fg-2">邀请其他人以管理员身份加入团队。链接 7 天内有效，只能使用一次。</p>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          className="field flex-1"
          placeholder="对方邮箱（可选，填写后会发一封邀请邮件）"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="被邀请人邮箱（可选）"
          aria-invalid={!valid}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={!valid || create.isPending}>
          <Plus size={16} aria-hidden /> {create.isPending ? "生成中…" : "生成邀请链接"}
        </button>
      </form>
      {!valid ? <p className="mt-1.5 text-caption text-danger-text">邮箱格式不正确</p> : null}
      <Reveal show={!!created}>
        {created ? (
          <div className="mt-3">
            <SecretBlock
              text={created.url}
              hint={
                created.email
                  ? `邀请邮件已发送到 ${created.email}。链接只显示这一次，关闭后无法再查看。`
                  : "把链接发给对方。链接只显示这一次，关闭后无法再查看。"
              }
            />
            <div className="mt-2 flex justify-end">
              <button className="btn btn-ghost" onClick={() => setCreated(null)}>
                我已保存，关闭
              </button>
            </div>
          </div>
        ) : null}
      </Reveal>

      <div className="mt-4">
        {q.isPending ? (
          <div className="skeleton h-28" />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        ) : invites.length === 0 ? (
          <EmptyState art="inbox" compact title="还没有发出过邀请" />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {invites.map((inv) => {
              const st = inviteStatus(inv);
              const by = members.get(inv.created_by)?.display_name ?? inv.created_by;
              const who = inv.accepted_by ? members.get(inv.accepted_by)?.display_name : null;
              return (
                <li key={inv.id} className="flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("truncate text-callout", inv.email ? "text-fg" : "text-fg-2")}>{inv.email ?? "通用链接"}</span>
                      <span className={INVITE_CHIP[st]}>{INVITE_STATUS_LABEL[st]}</span>
                    </div>
                    <div className="text-caption text-fg-caption">
                      {by} 创建于 {formatRelative(inv.created_at)}
                      {st === "pending" ? ` · ${formatDateTime(inv.expires_at)} 过期` : ""}
                      {st === "accepted" ? ` · ${who ?? "对方"}已于 ${formatRelative(inv.accepted_at)} 加入` : ""}
                    </div>
                  </div>
                  {st === "pending" ? (
                    <button className="btn btn-danger btn-sm" onClick={() => setRevoking(inv)}>
                      作废
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="作废这个邀请？"
        description={revoking?.email ? `发给 ${revoking.email} 的邀请链接将立即失效。` : "这个邀请链接将立即失效。"}
        confirmLabel="作废"
        danger
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Agent 加入码

const CODE_CHIP: Record<JoinCodeStatus, { cls: string; label: string }> = {
  active: { cls: "chip", label: "可用" },
  revoked: { cls: "chip chip-muted", label: "已作废" },
  expired: { cls: "chip chip-muted", label: "已过期" },
};

const EXPIRY_OPTIONS = [
  { v: "", label: "永不过期" },
  { v: "1", label: "1 天" },
  { v: "7", label: "7 天" },
  { v: "30", label: "30 天" },
  { v: "90", label: "90 天" },
];

export function JoinCodesSection() {
  const members = useMemberMap();
  const q = useQuery({ queryKey: qk.joinCodes, queryFn: api.joinCodes });
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("");
  const [created, setCreated] = useState<{ code: JoinCode; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<JoinCode | null>(null);
  const [manual, setManual] = useState(false);
  const addAgent = useAddAgent();
  const create = useAction(
    (b: { label?: string; expires_in_days?: number }) => api.createJoinCode(b),
    { invalidate: [qk.joinCodes] },
  );
  const revoke = useAction((id: string) => api.revokeJoinCode(id), { success: "加入码已作废", invalidate: [qk.joinCodes] });
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const body: { label?: string; expires_in_days?: number } = {};
    if (label.trim()) body.label = label.trim();
    if (days) body.expires_in_days = Number(days);
    create.mutate(body, {
      onSuccess: (r) => {
        setCreated(r);
        setLabel("");
      },
    });
  };

  const codes = q.data?.codes ?? [];
  return (
    <section id="join-codes" className="glass-1 card scroll-mt-20 p-5" aria-labelledby="s-codes">
      <SectionTitle id="s-codes" icon={KeyRound}>
        Agent 加入码
      </SectionTitle>
      <p className="mb-4 mt-1 text-callout font-normal text-fg-2">
        agent 用加入码申请加入这个团队，申请后仍需要你审批。加入码可以重复使用，泄露后请立即作废。
      </p>
      <div className="flex flex-col gap-3 rounded-[18px] border border-mint-300 bg-mint-50 p-4 sm:flex-row sm:items-center">
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-mint-100 text-mint-700">
          <UserPlus size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-callout font-semibold text-fg">一键添加 agent</div>
          <div className="text-caption text-fg-caption">自动生成 7 天有效的加入码，给你一行安装 + 加入的命令或 AI 提示词，并在弹窗里直接审批。</div>
        </div>
        <button type="button" className="btn btn-primary flex-none" onClick={addAgent}>
          <UserPlus size={16} aria-hidden /> 添加 agent
        </button>
      </div>
      <button
        type="button"
        className="mt-3 flex items-center gap-1 text-callout text-fg-2 hover:text-fg"
        aria-expanded={manual || !!created}
        onClick={() => setManual((m) => !m)}
      >
        <ChevronDown size={16} className={cn("transition-transform", (manual || created) && "rotate-180")} aria-hidden />
        手动生成加入码（自定义备注和有效期）
      </button>
      <Reveal show={manual || !!created}>
      <form onSubmit={submit} className="mt-3 grid gap-2 sm:grid-cols-[1fr_160px_auto]">
        <input
          className="field"
          placeholder="备注（可选），例如 “办公室 Mac mini”"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="加入码备注"
        />
        <select className="field" value={days} onChange={(e) => setDays(e.target.value)} aria-label="有效期">
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.v ? `${o.label}后过期` : o.label}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={create.isPending}>
          <Plus size={16} aria-hidden /> {create.isPending ? "生成中…" : "生成加入码"}
        </button>
      </form>
      </Reveal>
      <Reveal show={!!created}>
        {created ? (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-callout">
              在要加入的机器上运行
              {created.code.label ? <span className="font-normal text-fg-2">（{created.code.label}）</span> : null}：
            </p>
            <SecretBlock
              multiline
              text={unixOneLiner(origin, created.secret)}
              hint="一行命令安装并加入（macOS / Linux）。加入码只显示这一次，关闭后只能看到前 8 位；Windows 和 AI 提示词请用上面的「添加 agent」。"
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <CopyButton text={created.secret} label="只复制加入码" className="btn-sm" />
              <button className="btn btn-ghost" onClick={() => setCreated(null)}>
                我已保存，关闭
              </button>
            </div>
          </div>
        ) : null}
      </Reveal>

      <div className="mt-4">
        {q.isPending ? (
          <div className="skeleton h-28" />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        ) : codes.length === 0 ? (
          <EmptyState art="agents" compact title="还没有加入码。生成一个，就能把第一台机器上的 agent 接进来。" />
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-caption">
              <thead className="text-fg-caption">
                <tr className="border-b border-line">
                  <th className="px-2 py-2 font-medium">加入码</th>
                  <th className="px-2 py-2 font-medium">备注</th>
                  <th className="px-2 py-2 text-right font-medium">使用次数</th>
                  <th className="px-2 py-2 font-medium">最近使用</th>
                  <th className="px-2 py-2 font-medium">有效期</th>
                  <th className="px-2 py-2" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => {
                  const st = joinCodeStatus(c);
                  return (
                    <tr key={c.id} className={cn("border-b border-line align-middle last:border-b-0", st !== "active" && "text-fg-3")}>
                      <td className="whitespace-nowrap px-2 py-2.5">
                        <span className="font-mono text-fg">{c.prefix}…</span> <span className={CODE_CHIP[st].cls}>{CODE_CHIP[st].label}</span>
                      </td>
                      <td className="max-w-[200px] px-2 py-2.5">
                        <div className="truncate text-fg-2">{c.label || "—"}</div>
                        <div className="truncate text-fg-caption">{members.get(c.created_by)?.display_name ?? c.created_by}</div>
                      </td>
                      <td className="tabular px-2 py-2.5 text-right text-fg">{c.uses}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-fg-2">{c.last_used_at ? formatRelative(c.last_used_at) : "从未"}</td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-fg-2">
                        {st === "revoked" ? "—" : c.expires_at ? formatDateTime(c.expires_at) : "永久"}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        {st === "active" ? (
                          <button className="btn btn-danger btn-sm" onClick={() => setRevoking(c)}>
                            作废
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="作废这个加入码？"
        description={`${revoking?.prefix ?? ""}… 之后不能再用来申请加入。已经加入的 agent 不受影响。`}
        confirmLabel="作废"
        danger
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })}
      />
    </section>
  );
}

// ---------------------------------------------------------------- 危险操作

function useLeaveCurrentTeam() {
  const navigate = useNavigate();
  return async () => {
    await navigate({ to: "/" });
    await selectTeam(null);
  };
}

function TransferDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const me = useMe();
  const members = useMembers();
  const [target, setTarget] = useState("");
  const transfer = useAction((id: string) => api.transferTeam(id), { success: "已移交所有权", invalidate: [qk.me, qk.members] });
  const candidates = (members.data?.members ?? []).filter(
    (m) => m.kind === "human" && m.status === "active" && m.id !== me.data?.member?.id,
  );
  const picked = candidates.find((m) => m.id === target);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="移交团队所有权"
      description="对方成为所有者，你变为管理员。每个团队只有一位所有者，移交后只有新所有者能再移交或删除团队。"
      footer={
        <>
          <button className="btn btn-secondary btn-lg sm:h-9" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            className="btn btn-danger-solid btn-lg sm:h-9"
            disabled={!picked || transfer.isPending}
            onClick={() => picked && transfer.mutate(picked.id, { onSuccess: () => onOpenChange(false) })}
          >
            {transfer.isPending ? "移交中…" : picked ? `移交给 ${picked.display_name}` : "移交"}
          </button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="pb-2 text-callout font-normal text-fg-2">团队里还没有其他管理员。先在「成员邀请」里邀请一位，等对方加入后再移交。</p>
      ) : (
        <label className="flex flex-col gap-1.5 pb-2">
          <span className="text-callout">新所有者</span>
          <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">选择一位管理员…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}（{m.email ?? `@${m.name}`}）
              </option>
            ))}
          </select>
        </label>
      )}
    </Dialog>
  );
}

function DeleteTeamDialog({ open, onOpenChange, teamName }: { open: boolean; onOpenChange: (o: boolean) => void; teamName: string }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const leave = useLeaveCurrentTeam();
  const ok = deleteConfirmMatches(teamName, input);
  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      await api.deleteTeam(teamName);
      onOpenChange(false);
      await leave();
      toast.success(`团队「${teamName}」已删除`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setInput("");
        onOpenChange(o);
      }}
      title="删除团队"
      description={
        <>
          这会永久删除「<span className="font-semibold text-fg">{teamName}</span>」的全部工作区、讨论串、帖子、成员、用量记录和设置，所有 agent
          立即失去访问权限。<span className="text-danger-text">此操作无法撤销。</span>
        </>
      }
      footer={
        <>
          <button className="btn btn-secondary btn-lg sm:h-9" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button className="btn btn-danger-solid btn-lg sm:h-9" disabled={!ok || busy} onClick={() => void run()}>
            {busy ? "删除中…" : "永久删除团队"}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-1.5 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label htmlFor="delete-team-confirm" className="text-callout">
          输入团队名称 <span className="font-mono text-fg">{teamName}</span> 确认
        </label>
        <input
          id="delete-team-confirm"
          className="field"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={input !== "" && !ok}
        />
      </form>
    </Dialog>
  );
}

export function DangerSection() {
  const { team, isOwner } = useRole();
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const leaveNav = useLeaveCurrentTeam();
  if (!team) return null;

  const leave = async () => {
    setLeaving(true);
    try {
      await api.leaveTeam();
      setLeaveOpen(false);
      await leaveNav();
      toast.success(`已退出「${team.name}」`);
    } catch (e) {
      toast.error(e);
    } finally {
      setLeaving(false);
    }
  };

  const row = "flex flex-wrap items-center gap-3 py-3";
  return (
    <section
      id="danger"
      className="glass-1 card scroll-mt-20 border border-danger-bg p-5"
      aria-labelledby="s-danger"
    >
      <h2 id="s-danger" className="mb-1 flex items-center gap-2 text-title-2 text-danger-text">
        <AlertTriangle size={20} aria-hidden /> 危险操作
      </h2>
      <div className="flex flex-col divide-y divide-line">
        {isOwner ? (
          <>
            <div className={row}>
              <div className="min-w-0 flex-1">
                <div className="text-callout">移交所有权</div>
                <div className="text-caption text-fg-caption">把所有者身份交给团队里的另一位管理员，你会变为管理员。</div>
              </div>
              <button className="btn btn-secondary" onClick={() => setTransferOpen(true)}>
                <UserCog size={16} aria-hidden /> 移交…
              </button>
            </div>
            <div className={row}>
              <div className="min-w-0 flex-1">
                <div className="text-callout">删除团队</div>
                <div className="text-caption text-fg-caption">永久删除这个团队和它的全部数据。所有者不能退出团队，只能移交或删除。</div>
              </div>
              <button className="btn btn-danger" onClick={() => setDeleteOpen(true)}>
                <Trash2 size={16} aria-hidden /> 删除团队…
              </button>
            </div>
          </>
        ) : (
          <div className={row}>
            <div className="min-w-0 flex-1">
              <div className="text-callout">退出团队</div>
              <div className="text-caption text-fg-caption">退出后你将无法访问「{team.name}」，需要重新被邀请才能回来。</div>
            </div>
            <button className="btn btn-danger" onClick={() => setLeaveOpen(true)}>
              <LogOut size={16} aria-hidden /> 退出团队…
            </button>
          </div>
        )}
      </div>
      {isOwner ? (
        <>
          <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} />
          <DeleteTeamDialog open={deleteOpen} onOpenChange={setDeleteOpen} teamName={team.name} />
        </>
      ) : (
        <ConfirmDialog
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
          title={`退出「${team.name}」？`}
          description="退出后你将无法访问这个团队的任何内容，需要管理员重新邀请才能回来。"
          confirmLabel={leaving ? "退出中…" : "退出团队"}
          danger
          busy={leaving}
          onConfirm={() => void leave()}
        />
      )}
    </section>
  );
}
