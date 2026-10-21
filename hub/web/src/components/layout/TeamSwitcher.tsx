import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
import { api } from "../../api";
import { selectTeam, useMe } from "../../queries";
import { avatarGradient } from "../../lib/avatar";
import { roleLabel, teamInitial } from "../../lib/team";
import { reducedFade, springSnappy } from "../../lib/motion";
import { cn } from "../../lib/util";
import { Dialog } from "../ui/Dialog";
import { toast } from "../ui/Toast";

/** Square gradient tile with the team's initial(s). Gradient is keyed by team id so renames keep the colour. */
export function TeamTile({ id, name, size = 36, className }: { id: string; name: string; size?: number; className?: string }) {
  const g = avatarGradient(id);
  const initial = teamInitial(name);
  return (
    <span
      aria-hidden
      className={cn("flex flex-none select-none items-center justify-center font-semibold tracking-tight", className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        fontSize: Math.max(11, Math.round(size * (initial.length > 1 ? 0.36 : 0.44))),
        backgroundImage: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})`,
        color: "var(--avatar-ink)",
      }}
    >
      {initial}
    </span>
  );
}

/** Switch team: leave the current (team-scoped) URL first, then reset caches under the new header. */
export function useSwitchTeam() {
  const navigate = useNavigate();
  return async (id: string) => {
    await navigate({ to: "/" });
    await selectTeam(id);
  };
}

export function CreateTeamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const switchTeam = useSwitchTeam();
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 40;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      const { team } = await api.createTeam(trimmed);
      onOpenChange(false);
      setName("");
      await switchTeam(team.id);
      toast.success(`已创建团队「${team.name}」`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="创建团队"
      description="团队之间的数据完全隔离。你会成为新团队的所有者。"
      footer={
        <>
          <button className="btn btn-secondary btn-lg sm:h-9" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button className="btn btn-primary btn-lg sm:h-9" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建"}
          </button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1.5 pb-1">
        <label htmlFor="new-team-name" className="text-callout">
          团队名称
        </label>
        <input
          id="new-team-name"
          className="field"
          value={name}
          maxLength={40}
          placeholder="例如 Shiroha Lab"
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

const rowCls =
  "flex min-h-[44px] w-full items-center gap-3 rounded-[12px] px-2.5 py-1.5 text-left text-callout outline-none transition-colors hover:bg-mint-100 focus-visible:bg-mint-100 sm:min-h-[40px]";

/** Sidebar header: current team tile + name/role; popover lists my teams, create team and team settings. */
export function TeamSwitcher({ collapsed }: { collapsed: boolean }) {
  const { data } = useMe();
  const reduced = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const switchTeam = useSwitchTeam();
  const team = data?.team;
  const teams = data?.teams ?? [];
  if (!team) return null;

  const pick = (id: string) => {
    setOpen(false);
    if (id !== team.id) void switchTeam(id);
  };

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={cn(
            "flex h-11 w-full min-w-0 items-center gap-2.5 rounded-[12px] text-left outline-none transition-colors hover:bg-mint-100 focus-visible:bg-mint-100 data-[state=open]:bg-mint-100",
            collapsed ? "justify-center px-0" : "px-1.5",
          )}
          aria-label={`当前团队：${team.name}，切换团队`}
        >
          <TeamTile id={team.id} name={team.name} size={34} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold leading-5 tracking-tight text-fg">{team.name}</span>
                <span className="block truncate text-caption text-fg-caption">{roleLabel(data?.role)}</span>
              </span>
              <ChevronsUpDown size={16} className="flex-none text-fg-3" aria-hidden />
            </>
          )}
        </Popover.Trigger>
        <AnimatePresence>
          {open && (
            <Popover.Portal forceMount>
              <Popover.Content asChild forceMount side="bottom" align="start" sideOffset={6} collisionPadding={12}>
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
                  animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
                  transition={reduced ? reducedFade : springSnappy}
                  style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
                  className="glass-3 z-50 w-[264px] rounded-[20px] p-1.5"
                >
                  <div className="px-2.5 pb-1 pt-1.5 text-caption text-fg-caption">我的团队</div>
                  <ul aria-label="切换团队" className="flex max-h-[50vh] flex-col overflow-y-auto">
                    {teams.map((t) => {
                      const current = t.id === team.id;
                      return (
                        <li key={t.id}>
                          <button className={rowCls} aria-current={current ? "true" : undefined} onClick={() => pick(t.id)}>
                            <TeamTile id={t.id} name={t.name} size={28} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-fg">{t.name}</span>
                              <span className="block truncate text-caption font-normal text-fg-caption">{roleLabel(t.role)}</span>
                            </span>
                            {current ? <Check size={16} className="flex-none text-mint-700" aria-label="当前团队" /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="my-1 h-px bg-line" />
                  {data?.can_create_team ? (
                    <button
                      className={rowCls}
                      onClick={() => {
                        setOpen(false);
                        setCreating(true);
                      }}
                    >
                      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[9px] border border-dashed border-line-strong text-fg-2">
                        <Plus size={15} aria-hidden />
                      </span>
                      创建团队
                    </button>
                  ) : null}
                  <Link to="/settings" hash="team" className={rowCls} onClick={() => setOpen(false)}>
                    <span className="flex h-7 w-7 flex-none items-center justify-center text-fg-2">
                      <Settings size={16} aria-hidden />
                    </span>
                    团队设置
                  </Link>
                </motion.div>
              </Popover.Content>
            </Popover.Portal>
          )}
        </AnimatePresence>
      </Popover.Root>
      <CreateTeamDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
