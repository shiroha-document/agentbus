// One-click agent onboarding: opening the dialog mints a join code, shows a
// single paste-and-run line (or an AI prompt) and watches for the new agent so
// it can be approved right here. Mounted once in the app shell; any page opens
// it with useAddAgent().

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AppWindow, Check, CircleCheck, KeyRound, Loader2, RefreshCw, Sparkles, Terminal, X } from "lucide-react";
import { api } from "../api";
import { qk, useAction, useRole } from "../queries";
import { agentPrompt, unixOneLiner, windowsOneLiner } from "../lib/team";
import { formatDateTime } from "../lib/format";
import { reducedFade, springSoft } from "../lib/motion";
import { cn } from "../lib/util";
import { cliLabel } from "../lib/cli";
import { track } from "../lib/telemetry";
import type { Member } from "../types";
import { Dialog } from "./ui/Dialog";
import { Avatar } from "./ui/Avatar";
import { toast } from "./ui/Toast";
import { writeClipboard } from "./ui/CopyButton";

/** Quick codes live 7 days and are reusable, so one dialog can onboard several machines. */
export const QUICK_CODE_DAYS = 7;
export const QUICK_CODE_LABEL = "一键接入";

type Tab = "unix" | "windows" | "ai";

interface QuickCode {
  team: string;
  id: string;
  secret: string;
  expiresAt: number | null;
}

// Kept in memory only (never storage): reopening the dialog in the same tab
// reuses the code instead of minting a new one each time.
let cached: QuickCode | null = null;

const Ctx = createContext<() => void>(() => {});

/** Opens the "add agent" dialog. */
export function useAddAgent(): () => void {
  return useContext(Ctx);
}

export function AddAgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <AddAgentDialog open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  );
}

function defaultTab(): Tab {
  return typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent) ? "windows" : "unix";
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function AddAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { isAdmin, team } = useRole();
  useEffect(() => {
    if (open) track("agent.add_open", {});
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="添加 agent"
      description={isAdmin ? "复制一行命令到要接入的机器上运行，或者把提示词交给那台机器上的 AI 编码助手。" : undefined}
    >
      {!open ? null : isAdmin && team ? (
        <AddAgentBody teamId={team.id} teamName={team.name} onClose={() => onOpenChange(false)} />
      ) : (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-mint-100 text-mint-700">
            <KeyRound size={22} aria-hidden />
          </span>
          <p className="max-w-sm text-callout text-fg-2">只有团队所有者或管理员可以添加 agent。请联系管理员，在「成员 → 添加 agent」里复制接入命令给你。</p>
        </div>
      )}
    </Dialog>
  );
}

function AddAgentBody({ teamId, teamName, onClose }: { teamId: string; teamName: string; onClose: () => void }) {
  const reduced = useReducedMotion() ?? false;
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [code, setCode] = useState<QuickCode | null>(() =>
    cached && cached.team === teamId && (cached.expiresAt === null || cached.expiresAt > Date.now() + 3600_000) ? cached : null,
  );
  const create = useAction(
    () => api.createJoinCode({ label: `${QUICK_CODE_LABEL} · ${stamp()}`, expires_in_days: QUICK_CODE_DAYS }),
    { invalidate: [qk.joinCodes] },
  );
  const mint = useCallback(() => {
    create.mutate(undefined, {
      onSuccess: (r) => {
        const c = { team: teamId, id: r.code.id, secret: r.secret, expiresAt: r.code.expires_at };
        cached = c;
        setCode(c);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);
  const started = useRef(false);
  useEffect(() => {
    if (!code && !started.current) {
      started.current = true;
      mint();
    }
  }, [code, mint]);

  const origin = window.location.origin;
  const text = !code
    ? ""
    : tab === "unix"
      ? unixOneLiner(origin, code.secret)
      : tab === "windows"
        ? windowsOneLiner(origin, code.secret)
        : agentPrompt(origin, code.secret, teamName);

  const tabs: { value: Tab; label: string; icon: typeof Terminal }[] = [
    { value: "unix", label: "macOS / Linux", icon: Terminal },
    { value: "windows", label: "Windows", icon: AppWindow },
    { value: "ai", label: "交给 AI 来装", icon: Sparkles },
  ];

  return (
    <div className="flex flex-col gap-5 pb-2">
      <section aria-label="接入命令" className="flex flex-col gap-3">
        <StepTitle n={1}>{tab === "ai" ? "把提示词粘贴给要接入的 agent：Claude Code / Codex / Cursor 等编程 CLI，或 OpenAI dot 这类自己定时唤醒的 agent" : "在要接入的机器上，打开终端粘贴运行"}</StepTitle>
        <div className="flex flex-wrap gap-1 self-start rounded-[12px] bg-mint-100/60 p-1" role="tablist" aria-label="接入方式">
          {tabs.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              role="tab"
              type="button"
              aria-selected={tab === value}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-callout transition-colors",
                tab === value ? "bg-surface-solid text-fg shadow-1" : "text-fg-2 hover:text-fg",
              )}
              onClick={() => setTab(value)}
            >
              <Icon size={14} aria-hidden /> {label}
            </button>
          ))}
        </div>

        {create.isError && !code ? (
          <div className="flex items-center gap-3 rounded-[16px] border border-line bg-surface-strong p-4 text-callout">
            <X size={18} className="flex-none text-danger-text" aria-hidden />
            <span className="flex-1 text-fg-2">生成接入命令失败：{(create.error as Error).message}</span>
            <button className="btn btn-secondary btn-sm" onClick={mint}>
              <RefreshCw size={14} aria-hidden /> 重试
            </button>
          </div>
        ) : (
          <CommandCard text={text} loading={!code} multiline={tab === "ai"} copyLabel={tab === "ai" ? "复制提示词" : "复制命令"} />
        )}

        <p className="text-caption text-fg-caption">
          {tab === "ai"
            ? "AI 会自己安装 agentbus、加入团队；不能被命令行启动的 agent（如 OpenAI dot）会用自驱模式，在自己的定时任务里运行 agentbus inbox 领消息。遇到问题会运行 agentbus doctor 排查。"
            : tab === "windows"
              ? "在 PowerShell 里运行，不需要管理员权限。会安装 agentbus、加入团队并装好定时任务；检测到多个编程 CLI 时会让你选。"
              : "会安装 agentbus、加入团队并装好定时任务；检测到多个编程 CLI 时会让你选（也可以在命令末尾加 --cli codex 指定）。"}
        </p>
      </section>

      <section aria-label="等待连接" className="flex flex-col gap-3">
        <StepTitle n={2}>等它出现在这里，点批准就上线了</StepTitle>
        <Arrivals reduced={reduced} />
      </section>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-caption text-fg-caption">
        <KeyRound size={14} aria-hidden />
        {code ? (
          <span>
            加入码 <span className="font-mono">{code.secret.slice(0, 8)}…</span> 可在多台机器上重复使用，
            {code.expiresAt ? `${formatDateTime(code.expiresAt)} 前有效` : "长期有效"}
          </span>
        ) : (
          <span>正在生成加入码…</span>
        )}
        <span className="ml-auto flex gap-3">
          <button
            type="button"
            className="text-mint-700 hover:underline disabled:opacity-40"
            onClick={() => {
              cached = null;
              setCode(null);
              mint();
            }}
            disabled={create.isPending}
          >
            换一个新的
          </button>
          <button
            type="button"
            className="text-mint-700 hover:underline"
            onClick={() => {
              onClose();
              void navigate({ to: "/settings", hash: "join-codes" });
            }}
          >
            管理加入码
          </button>
        </span>
      </footer>
      <span className="sr-only" aria-live="polite">
        {code ? "接入命令已生成" : ""}
      </span>
    </div>
  );
}

function StepTitle({ n, children }: { n: number; children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2.5 text-callout font-semibold text-fg">
      <span
        className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-caption font-semibold"
        style={{ backgroundImage: "linear-gradient(135deg, var(--mint-300), var(--mint-500))", color: "var(--mint-950)" }}
        aria-hidden
      >
        {n}
      </span>
      {children}
    </h3>
  );
}

function CommandCard({ text, loading, multiline, copyLabel }: { text: string; loading: boolean; multiline: boolean; copyLabel: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => setDone(false), [text]);
  const copy = async () => {
    if (!text) return;
    if (await writeClipboard(text)) {
      setDone(true);
      window.setTimeout(() => setDone(false), 1800);
    } else {
      toast("复制失败，请手动选择文本复制", "error");
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border border-mint-300 bg-mint-50 p-3 sm:flex-row sm:items-stretch">
      {loading ? (
        <div className="flex min-h-[44px] flex-1 items-center gap-2 rounded-[12px] bg-surface-strong px-3 text-callout text-fg-3" aria-busy="true">
          <Loader2 size={16} className="animate-spin" aria-hidden /> 正在生成专属接入命令…
        </div>
      ) : (
        <pre
          className={cn(
            "min-w-0 flex-1 select-all overflow-auto rounded-[12px] bg-surface-strong px-3 py-2.5 font-mono text-caption leading-5 text-fg",
            multiline ? "max-h-56 whitespace-pre-wrap break-words" : "whitespace-pre-wrap break-all",
          )}
          tabIndex={0}
          aria-label="接入命令"
        >
          {text}
        </pre>
      )}
      <button type="button" className="btn btn-primary btn-lg flex-none sm:self-center" onClick={() => void copy()} disabled={loading}>
        {done ? <Check size={18} aria-hidden /> : <CopyIcon />}
        <span aria-live="polite">{done ? "已复制" : copyLabel}</span>
      </button>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/**
 * Agents that showed up since the dialog opened: snapshot the member ids on
 * first load, then poll /members every 3s and list the newcomers.
 */
function Arrivals({ reduced }: { reduced: boolean }) {
  const q = useQuery({ queryKey: qk.members, queryFn: api.members, refetchInterval: 3000 });
  const known = useRef<Set<string> | null>(null);
  const openedAt = useRef(Date.now());
  const [seen, setSeen] = useState<Member[]>([]);
  useEffect(() => {
    const list = q.data?.members;
    if (!list) return;
    if (!known.current) {
      known.current = new Set(list.map((m) => m.id));
    }
    const fresh = list.filter((m) => m.kind === "agent" && (!known.current!.has(m.id) || m.created_at >= openedAt.current));
    setSeen((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of fresh) byId.set(m.id, m);
      // keep rejected ones out once they disappear from the list
      const live = new Set(list.map((m) => m.id));
      return [...byId.values()].filter((m) => live.has(m.id)).map((m) => list.find((x) => x.id === m.id) ?? m);
    });
  }, [q.data]);

  const pendingOthers = useMemo(
    () => (q.data?.members ?? []).filter((m) => m.status === "pending" && !seen.some((x) => x.id === m.id)).length,
    [q.data, seen],
  );

  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {seen.map((m) => (
          <motion.div
            key={m.id}
            layout={!reduced}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={reduced ? reducedFade : springSoft}
          >
            <ArrivalRow m={m} />
          </motion.div>
        ))}
      </AnimatePresence>
      {seen.length === 0 ? (
        <div className="flex items-center gap-3 rounded-[16px] border border-dashed border-line px-4 py-3.5">
          <Radar reduced={reduced} />
          <div className="min-w-0 flex-1">
            <div className="text-callout text-fg">等待 agent 连接…</div>
            <div className="text-caption text-fg-caption">
              命令跑完后几秒内会出现在这里{pendingOthers > 0 ? `；另有 ${pendingOthers} 个早先的申请在成员页等待审批` : ""}。
            </div>
          </div>
        </div>
      ) : (
        <p className="text-caption text-fg-caption">还有别的机器？用同一行命令继续接入即可。</p>
      )}
    </div>
  );
}

function ArrivalRow({ m }: { m: Member }) {
  const approve = useAction(api.approveMember, { success: `${m.display_name || m.name} 已上线`, invalidate: [qk.members, qk.dashboard] });
  const reject = useAction(api.rejectMember, { success: "已拒绝", invalidate: [qk.members, qk.dashboard] });
  const busy = approve.isPending || reject.isPending;
  const active = m.status === "active";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-[16px] border px-4 py-3 transition-colors",
        active ? "border-mint-300 bg-mint-50" : "border-line bg-surface-strong",
      )}
    >
      <Avatar member={m} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-callout font-semibold text-fg">{m.display_name || m.name}</span>
          <span className="text-caption text-fg-caption">@{m.name}</span>
        </div>
        <div className="truncate text-caption text-fg-caption">{[cliLabel(m.cli), m.machine, m.owner].filter(Boolean).join(" · ") || "新 agent"}</div>
      </div>
      {active ? (
        <span className="flex items-center gap-1.5 text-callout font-medium text-mint-700">
          <CircleCheck size={18} aria-hidden /> 已上线
        </span>
      ) : m.status === "pending" ? (
        <div className="flex gap-2">
          <button className="btn btn-ghost btn-sm" onClick={() => reject.mutate(m.id)} disabled={busy}>
            拒绝
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => approve.mutate(m.id)} disabled={busy}>
            {approve.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />} 批准
          </button>
        </div>
      ) : (
        <span className="chip chip-muted">{m.status}</span>
      )}
    </div>
  );
}

/** Small pulsing radar: "listening". Static ring under reduced motion. */
function Radar({ reduced }: { reduced: boolean }) {
  return (
    <span className="relative flex h-9 w-9 flex-none items-center justify-center" aria-hidden>
      {!reduced
        ? [0, 1].map((i) => (
            <motion.span
              key={i}
              className="absolute inset-0 rounded-full border border-mint-400"
              initial={{ scale: 0.4, opacity: 0.8 }}
              animate={{ scale: 1.15, opacity: 0 }}
              transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.9, ease: "easeOut" }}
            />
          ))
        : <span className="absolute inset-0 rounded-full border border-mint-300" />}
      <span className="h-2.5 w-2.5 rounded-full bg-mint-500" />
    </span>
  );
}
