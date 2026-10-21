import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Clock, LinkIcon, LogIn, UserCheck } from "lucide-react";
import { api, ApiError } from "../api";
import { selectTeam, useMe } from "../queries";
import { formatDateTime, formatUntil } from "../lib/format";
import { enterVariants } from "../lib/motion";
import { TeamTile } from "../components/layout/TeamSwitcher";
import { toast } from "../components/ui/Toast";
import { QueryError } from "../components/layout/RouteStates";

function Card({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion() ?? false;
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <motion.section
        variants={enterVariants(reduced)}
        initial="hidden"
        animate="show"
        custom={0}
        className="glass-3 flex w-full max-w-[440px] flex-col items-center gap-4 rounded-[28px] p-8 text-center sm:p-10"
      >
        {children}
      </motion.section>
    </div>
  );
}

function Problem({ icon: Icon, title, desc }: { icon: typeof Clock; title: string; desc: string }) {
  const me = useMe();
  return (
    <Card>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-warning-bg text-warning-text">
        <Icon size={24} aria-hidden />
      </span>
      <h1 className="text-title-1">{title}</h1>
      <p className="text-fg-2">{desc}</p>
      <Link to="/" className="btn btn-secondary btn-lg mt-2">
        {me.data?.team ? "回到我的团队" : "返回首页"}
      </Link>
    </Card>
  );
}

export function InvitePage() {
  const { token } = useParams({ from: "/invite/$token" });
  const navigate = useNavigate();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => api.invitePreview(token),
    retry: false,
    staleTime: 0,
  });

  const enter = async (teamId: string) => {
    await navigate({ to: "/" });
    await selectTeam(teamId);
  };

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { team } = await api.acceptInvite(token);
      await enter(team.id);
      toast.success(`已加入「${team.name}」`);
    } catch (e) {
      toast.error(e);
      setBusy(false);
      void preview.refetch();
    }
  };

  if (preview.isPending) {
    return (
      <Card>
        <div className="skeleton h-16 w-16 rounded-[20px]" />
        <div className="skeleton h-8 w-56" />
        <div className="skeleton h-5 w-64" />
        <div className="skeleton mt-2 h-11 w-full" />
      </Card>
    );
  }

  if (preview.isError) {
    const e = preview.error;
    if (e instanceof ApiError && (e.status === 404 || e.status === 400 || e.status === 410)) {
      return <Problem icon={LinkIcon} title="邀请链接无效" desc="链接可能拼写有误，或已经被管理员删除。请让团队管理员重新发一个邀请链接。" />;
    }
    return (
      <div className="mt-16">
        <QueryError error={e} onRetry={() => void preview.refetch()} />
      </div>
    );
  }

  const p = preview.data;

  if (p.already_member) {
    return (
      <Card>
        <TeamTile id={p.team.id} name={p.team.name} size={64} />
        <span className="chip">
          <UserCheck size={12} aria-hidden /> 已是成员
        </span>
        <h1 className="text-title-1">你已经在「{p.team.name}」里了</h1>
        <p className="text-fg-2">不需要再接受这个邀请，直接进入团队即可。</p>
        <button className="btn btn-primary btn-lg mt-2 w-full" onClick={() => void enter(p.team.id)}>
          进入团队 <ArrowRight size={16} aria-hidden />
        </button>
      </Card>
    );
  }

  if (!p.valid) {
    const expired = p.expires_at <= Date.now();
    return expired ? (
      <Problem icon={Clock} title="邀请链接已过期" desc={`这个邀请已于 ${formatDateTime(p.expires_at)} 过期。请让 ${p.inviter.display_name} 重新发一个。`} />
    ) : (
      <Problem icon={LinkIcon} title="邀请链接已失效" desc={`这个邀请已经被使用或被作废。邀请链接只能使用一次，请让 ${p.inviter.display_name} 重新发一个。`} />
    );
  }

  return (
    <Card>
      <TeamTile id={p.team.id} name={p.team.name} size={64} />
      <p className="text-callout font-normal text-fg-2">
        <span className="text-fg">{p.inviter.display_name}</span>
        <span className="text-fg-caption"> @{p.inviter.name}</span> 邀请你加入
      </p>
      <h1 className="text-title-1">{p.team.name}</h1>
      <p className="text-fg-2">加入后你会成为团队管理员，可以查看讨论串、审批 agent 和管理设置。</p>
      <button className="btn btn-primary btn-lg mt-2 w-full" disabled={busy || me.isPending} onClick={() => void accept()}>
        <LogIn size={16} aria-hidden /> {busy ? "加入中…" : "接受邀请并加入"}
      </button>
      <p className="flex items-center gap-1.5 text-caption text-fg-caption">
        <Clock size={12} aria-hidden /> {formatUntil(p.expires_at)}后失效 · 以 {me.data?.identity.email ?? "当前账户"} 加入
      </p>
    </Card>
  );
}
