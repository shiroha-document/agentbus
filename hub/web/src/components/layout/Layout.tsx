import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronRight,
  Info,
  LineChart,
  LogOut,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  PauseCircle,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { api } from "../../api";
import { qk, useAction, useChangePolling, useMe, useRole, useSettings } from "../../queries";
import { cn } from "../../lib/util";
import { enterVariants, springSoft } from "../../lib/motion";
import { Avatar } from "../ui/Avatar";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";
import { CommandPalette } from "./CommandPalette";
import { AddAgentProvider } from "../AddAgentDialog";
import { CreateTeamDialog, TeamSwitcher, TeamTile, useSwitchTeam } from "./TeamSwitcher";
import { WelcomePage } from "../../pages/Welcome";
import { roleLabel } from "../../lib/team";
import { primaryNav, visibleNav } from "./nav";
import { QueryError } from "./RouteStates";
import { ThemeToggle } from "./ThemeToggle";
import { NewDot, VersionBadge, openChangelog, useChangelog } from "./Changelog";
import { track } from "../../lib/telemetry";

import type { ThreadDetailResponse, WorkspaceDetailResponse } from "../../types";


function isActive(path: string, to: string): boolean {
  if (to === "/") return path === "/";
  if (to === "/workspaces") return path.startsWith("/workspaces") || path.startsWith("/threads");
  return path.startsWith(to);
}

const COLLAPSE_KEY = "agentbus.sidebar.collapsed";

function Sidebar({ collapsed, onToggle, path }: { collapsed: boolean; onToggle: () => void; path: string }) {
  const { isAdmin } = useRole();
  return (
    <motion.aside
      animate={{ width: collapsed ? 72 : 240 }}
      transition={springSoft}
      className="glass-bar fixed inset-y-0 left-0 z-30 hidden flex-col overflow-hidden border-y-0 border-l-0 md:flex"
      aria-label="主导航"
    >
      <div className={cn("flex h-14 items-center", collapsed ? "px-[14px]" : "px-3")}>
        <TeamSwitcher collapsed={collapsed} />
      </div>
      <nav className="mt-3 flex flex-1 flex-col gap-1 px-3">
        {visibleNav(isAdmin).map(({ to, label, icon: Icon }) => {
          const active = isActive(path, to);
          const link = (
            <Link
              key={to}
              to={to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex h-10 items-center gap-3 rounded-[12px] px-3 text-callout transition-colors",
                active ? "text-fg" : "text-fg-2 hover:bg-mint-100 hover:text-fg",
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-[12px] bg-mint-100"
                  transition={springSoft}
                  aria-hidden
                />
              )}
              <Icon size={20} className={cn("relative flex-none", active && "text-mint-700")} aria-hidden />
              {!collapsed && <span className="relative truncate">{label}</span>}
            </Link>
          );
          return collapsed ? (
            <Tip key={to} content={label} side="right">
              {link}
            </Tip>
          ) : (
            link
          );
        })}
      </nav>
      <div className="flex flex-col gap-1 p-3">
        <VersionBadge collapsed={collapsed} />
        <button
          className="btn btn-ghost h-10 w-full justify-start gap-3 px-3"
          onClick={onToggle}
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
        >
          {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          {!collapsed && <span>收起</span>}
        </button>
      </div>
    </motion.aside>
  );
}

function BottomTabs({ path }: { path: string }) {
  return (
    <nav
      className="glass-bar fixed inset-x-0 bottom-0 z-30 flex border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label="主导航"
    >
      {primaryNav().map(({ to, label, icon: Icon }) => {
        const active = isActive(path, to);
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
              active ? "text-mint-700" : "text-fg-2",
            )}
          >
            <Icon size={20} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

interface Crumb {
  label: string;
  to?: string;
  params?: Record<string, string>;
}

function useCrumbs(path: string): Crumb[] {
  const parts = path.split("/").filter(Boolean);
  const section = parts[0];
  const id = parts[1] ? decodeURIComponent(parts[1]) : undefined;
  // Subscribe (without fetching) to cached detail data so names replace placeholders.
  const wsId = section === "workspaces" && id ? id : "";
  const thId = section === "threads" && id ? id : "";
  const wsQ = useQuery<WorkspaceDetailResponse>({ queryKey: qk.workspace(wsId), queryFn: () => api.workspace(wsId), enabled: false });
  const thQ = useQuery<ThreadDetailResponse>({ queryKey: qk.thread(thId), queryFn: () => api.thread(thId), enabled: false });
  const home: Crumb = { label: "动态", to: "/" };
  if (parts.length === 0) return [{ label: "动态" }];
  switch (section) {
    case "workspaces": {
      if (!id) return [home, { label: "工作区" }];
      const ws = wsQ.data?.workspace;
      return [home, { label: "工作区", to: "/workspaces" }, { label: ws?.name ?? "工作区详情" }];
    }
    case "threads": {
      const t = thQ.data;
      const out: Crumb[] = [home, { label: "工作区", to: "/workspaces" }];
      if (t) out.push({ label: t.workspace.name, to: "/workspaces/$id", params: { id: t.workspace.id } });
      out.push({ label: t?.thread.title ?? "讨论串" });
      return out;
    }
    case "members":
      return id ? [home, { label: "成员", to: "/members" }, { label: "成员详情" }] : [home, { label: "成员" }];
    case "usage":
      return [home, { label: "用量" }];
    case "settings":
      return [home, { label: "设置" }];
    case "analytics":
      return [home, { label: "数据统计" }];
    case "about":
      return [home, { label: "关于 agentbus" }];
    default:
      return [home];
  }
}

function Breadcrumb({ path }: { path: string }) {
  const crumbs = useCrumbs(path);
  return (
    <nav aria-label="面包屑" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1 text-callout">
        {crumbs.map((c, i) => (
          <li key={i} className={cn("flex min-w-0 items-center gap-1", i < crumbs.length - 1 && "hidden sm:flex")}>
            {i > 0 && <ChevronRight size={14} className="flex-none text-fg-3" aria-hidden />}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to} params={c.params as never} className="truncate text-fg-2 hover:text-fg">
                {c.label}
              </Link>
            ) : (
              <span className="truncate text-fg" aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function GlobalPause() {
  const { isAdmin } = useRole();
  const { data } = useSettings();
  const toggle = useAction((v: boolean) => api.updateSettings({ global_pause: v }), {
    invalidate: [qk.settings, qk.members, qk.dashboard],
  });
  const on = toggle.isPending ? (toggle.variables ?? false) : (data?.global_pause ?? false);
  return (
    <Tip content={on ? "全局暂停中：所有 agent 不会领取新消息" : "全局暂停：让所有 agent 停止领取消息"}>
      <label
        className={cn(
          "flex h-9 items-center gap-2 rounded-[12px] px-2.5 text-callout",
          on ? "chip-warning h-9 rounded-[12px]" : "text-fg-2",
        )}
      >
        <PauseCircle size={16} aria-hidden className="hidden sm:block" />
        <span className="hidden lg:inline">{on ? "全局暂停中" : "全局暂停"}</span>
        <Switch
          checked={on}
          disabled={!data || !isAdmin || toggle.isPending}
          onCheckedChange={(v) => toggle.mutate(v)}
          label="全局暂停"
          tone="warning"
        />
      </label>
    </Tip>
  );
}

const menuItemCls =
  "flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] px-3 py-1.5 text-callout outline-none data-[highlighted]:bg-mint-100";

function AvatarMenu() {
  const { data } = useMe();
  const me = data?.member;
  const switchTeam = useSwitchTeam();
  const [creating, setCreating] = useState(false);
  const teams = data?.teams ?? [];
  const { isAdmin } = useRole();
  const { unseen } = useChangelog();
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="relative flex h-9 w-9 items-center justify-center rounded-full" aria-label={unseen ? "账户菜单（有新的更新日志）" : "账户菜单"}>
          <Avatar member={me} size={32} />
          {unseen ? (
            <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg)] bg-mint-500 md:hidden" aria-hidden />
          ) : null}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={8} className="glass-3 z-50 min-w-[240px] rounded-[16px] p-1.5">
            <div className="px-3 py-2">
              <div className="text-callout text-fg">{me?.display_name ?? data?.identity.email ?? "我"}</div>
              <div className="truncate text-caption text-fg-caption">{data?.identity.email ?? me?.name ?? ""}</div>
            </div>
            {teams.length > 0 ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Label className="px-3 pb-1 pt-1.5 text-caption text-fg-caption">切换团队</DropdownMenu.Label>
                {teams.map((t) => {
                  const current = t.id === data?.team?.id;
                  return (
                    <DropdownMenu.Item key={t.id} className={menuItemCls} onSelect={() => !current && void switchTeam(t.id)}>
                      <TeamTile id={t.id} name={t.name} size={22} />
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      <span className="text-caption font-normal text-fg-caption">{roleLabel(t.role)}</span>
                      {current ? <Check size={14} className="text-mint-700" aria-label="当前团队" /> : null}
                    </DropdownMenu.Item>
                  );
                })}
                {data?.can_create_team ? (
                  <DropdownMenu.Item className={menuItemCls} onSelect={() => setCreating(true)}>
                    <Plus size={16} className="text-fg-2" aria-hidden /> 创建团队
                  </DropdownMenu.Item>
                ) : null}
              </>
            ) : null}
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item asChild>
              <Link to="/settings" className={menuItemCls}>
                <Settings size={16} aria-hidden /> 设置
              </Link>
            </DropdownMenu.Item>
            {isAdmin ? (
              <DropdownMenu.Item asChild>
                <Link to="/analytics" className={menuItemCls}>
                  <LineChart size={16} aria-hidden /> 数据统计
                </Link>
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Item asChild>
              <Link to="/about" className={menuItemCls}>
                <Info size={16} aria-hidden /> 关于 agentbus
              </Link>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItemCls} onSelect={openChangelog}>
              <Sparkles size={16} aria-hidden />
              <span className="flex-1">更新日志</span>
              <span className="tabular text-caption text-fg-caption">v{__APP_VERSION__}</span>
              {unseen ? <NewDot /> : null}
            </DropdownMenu.Item>
            <DropdownMenu.Item asChild>
              <a href="/cdn-cgi/access/logout" className={cn(menuItemCls, "text-danger-text")}>
                <LogOut size={16} aria-hidden /> 退出登录
              </a>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <CreateTeamDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** Minimal frame for pages that work without a current team (invite links). */
function BareShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-2.5 px-5 md:px-8">
        <span
          className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] text-caption font-semibold"
          style={{ backgroundImage: "linear-gradient(135deg, var(--mint-300), var(--mint-500))", color: "var(--mint-950)" }}
          aria-hidden
        >
          ab
        </span>
        <span className="flex-1 text-[17px] font-semibold tracking-tight">agentbus hub</span>
        <ThemeToggle />
      </header>
      <main id="main" className="mx-auto flex w-full max-w-[1080px] flex-1 flex-col px-4 pb-12 md:px-8">
        {children}
      </main>
    </div>
  );
}

function BootSkeleton() {
  return (
    <div className="min-h-dvh md:pl-[240px]" aria-busy="true" aria-label="加载中">
      <div className="glass-bar fixed inset-y-0 left-0 hidden w-[240px] border-y-0 border-l-0 md:block" />
      <div className="mx-auto max-w-[1200px] space-y-4 px-4 pt-20 md:px-8">
        <div className="skeleton h-10 w-72" />
        <div className="skeleton h-28 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="skeleton h-40" />
          <div className="skeleton h-40" />
        </div>
      </div>
    </div>
  );
}

/**
 * Root route component. Decides between:
 *  - /invite/$token → bare frame (works with or without a team);
 *  - no team yet (me.team === null) → welcome page, and no team-scoped request is made;
 *  - otherwise the full app shell.
 */
export function Layout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const me = useMe();
  if (path.startsWith("/invite/") || (path === "/about" && me.data && !me.data.team)) {
    return (
      <BareShell>
        <Outlet />
      </BareShell>
    );
  }
  if (me.isPending) return <BootSkeleton />;
  if (me.isError) {
    return (
      <BareShell>
        <div className="mt-16">
          <QueryError error={me.error} onRetry={() => void me.refetch()} />
        </div>
      </BareShell>
    );
  }
  if (!me.data.team) {
    return (
      <BareShell>
        <WelcomePage me={me.data} />
      </BareShell>
    );
  }
  return <Shell path={path} teamId={me.data.team.id} />;
}

function Shell({ path, teamId }: { path: string; teamId: string }) {
  useChangePolling();
  const reduced = useReducedMotion() ?? false;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [paletteOpen, setPaletteOpenState] = useState(false);
  const paletteRef = useRef(false);
  const setPaletteOpen = useCallback((o: boolean, via?: "key" | "click") => {
    if (o && !paletteRef.current && via) track("palette.open", { via });
    paletteRef.current = o;
    setPaletteOpenState(o);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteRef.current, "key");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen]);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const variants = enterVariants(reduced);

  return (
    <AddAgentProvider>
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:btn focus:btn-primary">
        跳到正文
      </a>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} path={path} />
      <div
        className="flex min-h-dvh flex-col transition-[padding] duration-300 ease-smooth md:pl-[var(--sidebar-w)]"
        style={{ ["--sidebar-w" as string]: collapsed ? "72px" : "240px" }}
      >
        <header className="glass-bar sticky top-0 z-20 flex h-14 items-center gap-3 border-x-0 border-t-0 px-4 md:px-8">
          <Breadcrumb path={path} />
          <button
            className="btn btn-secondary h-9 w-9 px-0 sm:w-auto sm:min-w-[200px] sm:justify-start sm:px-3"
            onClick={() => setPaletteOpen(true, "click")}
            aria-label="搜索"
            aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          >
            <Search size={16} aria-hidden />
            <span className="hidden flex-1 text-left font-normal text-fg-3 sm:inline">搜索帖子…</span>
            <kbd className="hidden rounded-[6px] border border-line px-1.5 text-caption text-fg-caption sm:inline">
              {isMac ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
          <ThemeToggle />
          <GlobalPause />
          <AvatarMenu />
        </header>
        <main id="main" className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-28 pt-6 md:px-8 md:pb-12 md:pt-8">
          <motion.div key={`${teamId}${path}`} variants={variants} initial="hidden" animate="show" custom={0}>
            <Outlet />
          </motion.div>
        </main>
      </div>
      <BottomTabs path={path} />
      <CommandPalette open={paletteOpen} onOpenChange={(o) => setPaletteOpen(o)} />
    </div>
    </AddAgentProvider>
  );
}

