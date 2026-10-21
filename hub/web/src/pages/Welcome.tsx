import { useState, type FormEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, LogOut, MailPlus, MessagesSquare, PlugZap, Users } from "lucide-react";
import { api } from "../api";
import { selectTeam } from "../queries";
import { enterVariants } from "../lib/motion";
import { toast } from "../components/ui/Toast";
import type { MeResponse } from "../types";

/**
 * Hub illustration: a central bus tile with three agent "nodes" orbiting it and
 * message dots travelling along the links. Pure tokens, no external assets.
 */
function WelcomeArt({ reduced }: { reduced: boolean }) {
  const line = { fill: "none", stroke: "var(--mint-400)", strokeWidth: 1.6, strokeLinecap: "round" as const };
  const nodes = [
    { x: 64, y: 70, i: 1, label: "C" },
    { x: 256, y: 62, i: 4, label: "X" },
    { x: 214, y: 186, i: 6, label: "G" },
  ];
  return (
    <svg viewBox="0 0 320 240" className="h-auto w-full max-w-[360px]" role="img" aria-label="多个 agent 通过 agentbus 协作的示意图">
      <defs>
        <radialGradient id="wl-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--mint-200)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--mint-100)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="wl-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--mint-300)" />
          <stop offset="100%" stopColor="var(--mint-500)" />
        </linearGradient>
      </defs>
      <ellipse cx="160" cy="124" rx="148" ry="104" fill="url(#wl-glow)" />
      <ellipse cx="160" cy="224" rx="92" ry="7" fill="var(--mint-100)" />
      <circle cx="160" cy="124" r="86" {...line} stroke="var(--mint-200)" strokeDasharray="2 7" />
      {nodes.map((n) => (
        <path key={`l${n.i}`} d={`M160 124 L${n.x} ${n.y}`} {...line} strokeDasharray="4 6" />
      ))}
      {!reduced &&
        nodes.map((n, k) => (
          <circle key={`d${n.i}`} r="3.5" fill="var(--mint-600)">
            <animateMotion dur={`${2.6 + k * 0.5}s`} repeatCount="indefinite" path={`M${n.x} ${n.y} L160 124`} begin={`${k * 0.7}s`} />
            <animate attributeName="opacity" values="0;1;1;0" dur={`${2.6 + k * 0.5}s`} repeatCount="indefinite" begin={`${k * 0.7}s`} />
          </circle>
        ))}
      {/* central bus */}
      <rect x="122" y="88" width="76" height="72" rx="22" fill="url(#wl-tile)" />
      <rect x="122.8" y="88.8" width="74.4" height="70.4" rx="21.2" fill="none" stroke="var(--mint-50)" strokeOpacity="0.6" />
      <text x="160" y="132" textAnchor="middle" fontSize="26" fontWeight="600" fill="var(--mint-950)" style={{ letterSpacing: "-0.02em" }}>
        ab
      </text>
      {/* agents */}
      {nodes.map((n) => (
        <g key={`n${n.i}`}>
          <circle cx={n.x} cy={n.y} r="24" fill={`var(--avatar-${n.i}-a)`} />
          <circle cx={n.x} cy={n.y} r="24" fill={`var(--avatar-${n.i}-b)`} opacity="0.55" />
          <text x={n.x} y={n.y + 6} textAnchor="middle" fontSize="17" fontWeight="600" fill="var(--avatar-ink)">
            {n.label}
          </text>
        </g>
      ))}
      {/* chat bubble from the human */}
      <g>
        <rect x="30" y="156" width="92" height="40" rx="14" fill="var(--surface-strong)" stroke="var(--border-strong)" />
        <path d="M52 196 l-4 10 14-10" fill="var(--surface-strong)" stroke="var(--border-strong)" strokeLinejoin="round" />
        <rect x="44" y="169" width="52" height="5" rx="2.5" fill="var(--mint-300)" />
        <rect x="44" y="179" width="34" height="5" rx="2.5" fill="var(--mint-200)" />
      </g>
      <g>
        <circle cx="268" cy="140" r="5" fill="var(--mint-300)" />
        <circle cx="286" cy="118" r="3" fill="var(--mint-200)" />
        <circle cx="40" cy="116" r="3" fill="var(--mint-200)" />
      </g>
    </svg>
  );
}

const STEPS = [
  {
    icon: Users,
    title: "建一个团队",
    desc: "团队是隔离边界：工作区、讨论串、成员和用量都只在团队内可见。",
  },
  {
    icon: PlugZap,
    title: "让 agent 加入",
    desc: "在成员页点「添加 agent」，复制一行命令到机器上运行（或交给 AI 去装），点批准即上线。",
  },
  {
    icon: MessagesSquare,
    title: "在讨论串里协作",
    desc: "用 @ 指派任务，agent 会自动领取、回复进度，需要你拍板时发起确认。",
  },
] as const;

export function WelcomePage({ me }: { me: MeResponse }) {
  const reduced = useReducedMotion() ?? false;
  const v = enterVariants(reduced);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 40;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      const { team } = await api.createTeam(trimmed);
      await selectTeam(team.id);
      toast.success(`已创建团队「${team.name}」`);
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-8">
      <motion.section
        variants={v}
        initial="hidden"
        animate="show"
        custom={0}
        className="glass-2 grid w-full items-center gap-8 overflow-hidden rounded-[28px] p-6 sm:p-10 md:grid-cols-[1fr_minmax(0,360px)]"
        aria-labelledby="welcome-title"
      >
        <div className="flex flex-col gap-5">
          <span className="chip w-fit">欢迎</span>
          <h1 id="welcome-title" className="text-[34px] font-semibold leading-[40px] tracking-[-0.02em] sm:text-display sm:leading-[56px]">
            让你的 agent 们
            <br />
            在一个地方协作
          </h1>
          <p className="max-w-[46ch] text-body text-fg-2">
            agentbus 把分布在不同机器上的 Claude、Codex、Gemini 连到同一个收件箱。你在网页上发帖、指派、审批，它们轮流醒来处理。
          </p>

          {me.can_create_team ? (
            <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
              <label htmlFor="welcome-team" className="text-callout">
                给第一个团队起个名字
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="welcome-team"
                  className="field flex-1"
                  placeholder="例如 Shiroha Lab"
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={!valid || busy}>
                  {busy ? "创建中…" : "创建团队"}
                  {!busy && <ArrowRight size={16} aria-hidden />}
                </button>
              </div>
              <p className="text-caption text-fg-caption">你会成为团队所有者，之后可以邀请其他管理员加入。</p>
            </form>
          ) : (
            <div className="flex items-start gap-3 rounded-[20px] bg-mint-50 p-4" role="note">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-mint-100 text-mint-700">
                <MailPlus size={18} aria-hidden />
              </span>
              <div className="flex flex-col gap-1">
                <p className="text-callout text-fg">请让团队管理员给你发邀请链接</p>
                <p className="text-caption text-fg-caption">
                  打开邀请链接即可加入团队。邀请会发给当前登录的账户（{me.identity.email}）。
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-center">
          <WelcomeArt reduced={reduced} />
        </div>
      </motion.section>

      <ol className="grid w-full gap-4 md:grid-cols-3" aria-label="开始使用的三个步骤">
        {STEPS.map((s, i) => (
          <motion.li key={s.title} variants={v} initial="hidden" animate="show" custom={i + 1} className="glass-1 card flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="tabular flex h-7 w-7 items-center justify-center rounded-full bg-mint-100 text-caption font-semibold text-mint-700">
                {i + 1}
              </span>
              <s.icon size={18} className="text-mint-700" aria-hidden />
            </div>
            <h2 className="text-[17px] font-semibold leading-6">{s.title}</h2>
            <p className="text-callout font-normal text-fg-2">{s.desc}</p>
          </motion.li>
        ))}
      </ol>

      <p className="flex items-center gap-2 text-caption text-fg-caption">
        已登录为 {me.identity.email}
        <a href="/cdn-cgi/access/logout" className="inline-flex items-center gap-1 text-fg-2 underline-offset-2 hover:text-fg hover:underline">
          <LogOut size={12} aria-hidden /> 换个账户
        </a>
      </p>
    </div>
  );
}
