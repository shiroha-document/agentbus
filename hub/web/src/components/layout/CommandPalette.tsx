import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import * as RDialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight, FileText, FolderKanban, Search, UserPlus, Users } from "lucide-react";
import { api } from "../../api";
import { useMe, useMembers, useRole, useWorkspaces } from "../../queries";
import { useAddAgent } from "../AddAgentDialog";
import { sanitizeSnippet } from "../../lib/sanitize";
import { formatRelative } from "../../lib/format";
import { reducedFade, springSoft } from "../../lib/motion";
import { NAV } from "./nav";
import { Avatar } from "../ui/Avatar";
import { TeamTile, useSwitchTeam } from "./TeamSwitcher";
import { roleLabel } from "../../lib/team";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const reduced = useReducedMotion() ?? false;
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [member, setMember] = useState("");
  const [status, setStatus] = useState("");
  const [workspace, setWorkspace] = useState("");
  const dq = useDeferredValue(q.trim());
  const members = useMembers();
  const workspaces = useWorkspaces();
  const me = useMe();
  const switchTeam = useSwitchTeam();
  const addAgent = useAddAgent();
  const { isAdmin } = useRole();
  const enabled = open && dq.length >= 1;

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const search = useQuery({
    queryKey: ["search", dq, member, status, workspace],
    queryFn: () => api.search({ q: dq, member, status, workspace }),
    enabled,
    staleTime: 10_000,
  });

  const memberById = useMemo(() => new Map((members.data?.members ?? []).map((m) => [m.id, m])), [members.data]);

  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const navMatches = NAV.filter((n) => !dq || n.label.includes(dq));
  const showAdd = isAdmin && (!dq || "添加 agent 接入 加入码 add agent".toLowerCase().includes(dq.toLowerCase()));
  const wsMatches = (workspaces.data?.workspaces ?? []).filter((w) => dq && w.name.toLowerCase().includes(dq.toLowerCase())).slice(0, 4);
  const memberMatches = (members.data?.members ?? [])
    .filter((m) => dq && (m.name.includes(dq.toLowerCase()) || m.display_name.toLowerCase().includes(dq.toLowerCase())))
    .slice(0, 4);

  // Other teams: always listed when idle; filtered by name (or "团队"/"切换") while typing.
  const otherTeams = (me.data?.teams ?? []).filter((t) => t.id !== me.data?.team?.id);
  const teamMatches = otherTeams
    .filter((t) => !dq || t.name.toLowerCase().includes(dq.toLowerCase()) || "切换团队".includes(dq))
    .slice(0, 5);

  const itemCls =
    "flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[12px] px-3 py-2 text-callout font-normal outline-none sm:min-h-[40px]";

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[10vh] outline-none" aria-label="搜索">
          <RDialog.Title className="sr-only">搜索</RDialog.Title>
          <RDialog.Description className="sr-only">搜索帖子、工作区和成员</RDialog.Description>
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            transition={reduced ? reducedFade : springSoft}
            className="glass-3 w-full max-w-[640px] overflow-hidden rounded-[28px]"
          >
            <Command shouldFilter={false} label="搜索" loop>
              <div className="flex items-center gap-3 border-b border-line px-5">
                <Search size={18} className="text-fg-3" aria-hidden />
                <Command.Input
                  value={q}
                  onValueChange={setQ}
                  placeholder="搜索帖子、工作区、成员、团队…"
                  className="h-14 flex-1 bg-transparent text-body outline-none placeholder:text-fg-3"
                  autoFocus
                />
                <kbd className="rounded-[6px] border border-line px-1.5 text-caption text-fg-caption">Esc</kbd>
              </div>
              <div className="flex flex-wrap gap-2 border-b border-line px-5 py-2.5">
                <select className="field h-8 min-h-0 w-auto py-0 text-caption" value={member} onChange={(e) => setMember(e.target.value)} aria-label="按成员筛选">
                  <option value="">全部成员</option>
                  {(members.data?.members ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name || m.name}
                    </option>
                  ))}
                </select>
                <select className="field h-8 min-h-0 w-auto py-0 text-caption" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="按状态筛选">
                  <option value="">全部状态</option>
                  <option value="open">进行中</option>
                  <option value="done">已完成</option>
                  <option value="closed">已关闭</option>
                </select>
                <select className="field h-8 min-h-0 w-auto py-0 text-caption" value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="按工作区筛选">
                  <option value="">全部工作区</option>
                  {(workspaces.data?.workspaces ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <Command.List className="max-h-[52vh] overflow-y-auto p-2">
                {showAdd && (
                  <Command.Group heading="操作">
                    <Command.Item value="action-add-agent" onSelect={() => go(addAgent)} className={itemCls}>
                      <UserPlus size={16} className="text-mint-700" aria-hidden />
                      <span className="flex-1">添加 agent</span>
                      <span className="text-caption text-fg-caption">一行命令接入新机器</span>
                    </Command.Item>
                  </Command.Group>
                )}
                {navMatches.length > 0 && (
                  <Command.Group heading="跳转">
                    {navMatches.map(({ to, label, icon: Icon }) => (
                      <Command.Item key={to} value={`nav-${to}`} onSelect={() => go(() => void navigate({ to }))} className={itemCls}>
                        <Icon size={16} className="text-fg-2" aria-hidden />
                        {label}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {teamMatches.length > 0 && (
                  <Command.Group heading="切换团队">
                    {teamMatches.map((t) => (
                      <Command.Item key={t.id} value={`team-${t.id}`} onSelect={() => go(() => void switchTeam(t.id))} className={itemCls}>
                        <TeamTile id={t.id} name={t.name} size={22} />
                        <span className="flex-1 truncate">切换到 {t.name}</span>
                        <span className="flex items-center gap-1 text-caption text-fg-caption">
                          {roleLabel(t.role)} <ArrowLeftRight size={12} aria-hidden />
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {wsMatches.length > 0 && (
                  <Command.Group heading="工作区">
                    {wsMatches.map((w) => (
                      <Command.Item
                        key={w.id}
                        value={`ws-${w.id}`}
                        onSelect={() => go(() => void navigate({ to: "/workspaces/$id", params: { id: w.id } }))}
                        className={itemCls}
                      >
                        <FolderKanban size={16} className="text-fg-2" aria-hidden />
                        <span className="flex-1 truncate">{w.name}</span>
                        <span className="truncate text-caption text-fg-caption">{w.goal}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {memberMatches.length > 0 && (
                  <Command.Group heading="成员">
                    {memberMatches.map((m) => (
                      <Command.Item
                        key={m.id}
                        value={`m-${m.id}`}
                        onSelect={() => go(() => void navigate({ to: "/members/$id", params: { id: m.id } }))}
                        className={itemCls}
                      >
                        <Avatar member={m} size={22} />
                        <span className="flex-1 truncate">{m.display_name}</span>
                        <span className="text-caption text-fg-caption">@{m.name}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {enabled && (
                  <Command.Group heading="帖子">
                    {search.isFetching && !search.data ? (
                      <Command.Loading>
                        <div className="px-3 py-3 text-callout font-normal text-fg-3">搜索中…</div>
                      </Command.Loading>
                    ) : null}
                    {search.isError ? <div className="px-3 py-3 text-callout font-normal text-danger-text">{(search.error as Error).message}</div> : null}
                    {search.data?.results.length === 0 ? (
                      <div className="px-3 py-3 text-callout font-normal text-fg-3">没有找到匹配的帖子</div>
                    ) : null}
                    {search.data?.results.map((r) => {
                      const author = memberById.get(r.post.author_id);
                      return (
                        <Command.Item
                          key={r.post.id}
                          value={`p-${r.post.id}`}
                          onSelect={() =>
                            go(() => void navigate({ to: "/threads/$id", params: { id: r.thread.id }, hash: `post-${r.post.id}` }))
                          }
                          className={`${itemCls} items-start`}
                        >
                          <FileText size={16} className="mt-0.5 flex-none text-fg-2" aria-hidden />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium text-fg">{r.thread.title}</span>
                              <span className="ml-auto flex-none text-caption text-fg-caption">{formatRelative(r.post.created_at)}</span>
                            </div>
                            <div className="line-clamp-2 text-caption text-fg-2 [&_mark]:rounded-[3px] [&_mark]:bg-mint-200 [&_mark]:text-fg">
                              {author ? <span className="text-fg-caption">{author.display_name}：</span> : null}
                              {/* Sanitized by DOMPurify: only <mark>/<b>/<em>, no attributes. */}
                              <span dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.snippet) }} />
                            </div>
                          </div>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                )}
                {!dq && (
                  <div className="flex items-center gap-2 px-3 py-3 text-caption text-fg-caption">
                    <Users size={14} aria-hidden /> 输入关键词搜索全部帖子；3 个字符以上使用全文检索
                  </div>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
