import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CheckCircle2, Mail, MailWarning, PauseOctagon, Send, SlidersHorizontal, Bell, ScrollText, X } from "lucide-react";
import { api } from "../api";
import { qk, useAction, useMe, useRole, useSettings } from "../queries";
import { formatDateTime } from "../lib/format";
import { NOTIFY_KIND_LABEL, NOTIFY_KIND_LOCKED, NOTIFY_KIND_ORDER } from "../lib/util";
import type { EmailHealth, SettingsPatch, SettingsResponse } from "../types";
import { Switch } from "../components/ui/Switch";
import { EmptyState } from "../components/ui/EmptyState";
import { QueryError } from "../components/layout/RouteStates";
import { useMemberMap } from "../components/threads";
import { DangerSection, InvitesSection, JoinCodesSection, TeamSection } from "./settings/TeamSections";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailHealthNotice({ h }: { h?: EmailHealth }) {
  if (!h) return null;
  if (h.ok) {
    return h.last_sent_at ? (
      <p className="mb-4 flex items-center gap-1.5 text-caption text-fg-caption">
        <CheckCircle2 size={14} className="text-mint-700" aria-hidden /> 最近一次成功发送：{formatDateTime(h.last_sent_at)}
      </p>
    ) : null;
  }
  return (
    <div className="mb-4 flex flex-col gap-1.5 rounded-[12px] border-l-[3px] border-l-danger bg-danger-bg px-3 py-2" role="alert">
      <div className="flex items-center gap-1.5 text-callout font-semibold text-danger-text">
        <MailWarning size={16} aria-hidden /> 邮件通知发送失败
        {h.failed_count > 1 ? <span className="font-normal">（{h.failed_count} 批未送达）</span> : null}
      </div>
      {h.hint ? <p className="text-callout font-normal text-fg-2">{h.hint}</p> : null}
      <p className="break-all text-caption text-fg-caption">
        {h.last_error_at ? formatDateTime(h.last_error_at) + " · " : ""}
        {h.last_error}
        {h.last_sent_at ? ` · 上次成功：${formatDateTime(h.last_sent_at)}` : ""}
      </p>
    </div>
  );
}

function EmailSection({ masked, health }: { masked: string | null; health?: EmailHealth }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const change = useAction((e: string) => api.changeEmail(e), { invalidate: [qk.settings] });
  const valid = EMAIL_RE.test(email.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || change.isPending) return;
    const target = email.trim();
    change.mutate(target, {
      onSuccess: () => {
        setSentTo(target);
        setEmail("");
      },
    });
  };
  return (
    <section className="glass-1 card p-5" aria-labelledby="s-email">
      <h2 id="s-email" className="mb-1 flex items-center gap-2 text-title-2">
        <Mail size={20} className="text-mint-700" aria-hidden /> 通知邮箱
      </h2>
      <p className="mb-4 text-callout font-normal text-fg-2">
        当前：<span className="tabular font-medium text-fg">{masked ?? "未设置"}</span>
      </p>
      <EmailHealthNotice h={health} />
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          className="field flex-1"
          placeholder="新的邮箱地址"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="新的通知邮箱"
          autoComplete="email"
        />
        <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={!valid || change.isPending}>
          {change.isPending ? "发送中…" : "更换邮箱"}
        </button>
      </form>
      {sentTo ? (
        <p className="mt-3 rounded-[12px] bg-mint-50 px-3 py-2 text-callout font-normal text-fg-2" role="status">
          确认邮件已发送到新地址（{sentTo}），30 分钟内点击邮件里的链接完成更换。
        </p>
      ) : (
        <p className="mt-3 text-caption text-fg-caption">更换后会向新地址发送确认链接，确认前仍使用当前邮箱。</p>
      )}
    </section>
  );
}

function NotifySection({ s }: { s: SettingsResponse }) {
  const save = useAction((body: SettingsPatch) => api.updateSettings(body), { invalidate: [qk.settings] });
  const qc = useQueryClient();
  const test = useAction(() => api.testNotify(), { success: "测试邮件已发送" });
  const runTest = () => test.mutate(undefined, { onSettled: () => void qc.invalidateQueries() });
  const pendingKinds = save.isPending ? save.variables?.notify_kinds : undefined;
  const kinds = { ...s.notify_kinds, ...pendingKinds };
  return (
    <section className="glass-1 card p-5" aria-labelledby="s-notify">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="s-notify" className="flex items-center gap-2 text-title-2">
          <Bell size={20} className="text-mint-700" aria-hidden /> 通知种类
        </h2>
        <button className="btn btn-secondary ml-auto" disabled={test.isPending || !s.notify_email_masked} onClick={runTest}>
          <Send size={16} aria-hidden /> {test.isPending ? "发送中…" : "发送测试邮件"}
        </button>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {NOTIFY_KIND_ORDER.map((k) => {
          const meta = NOTIFY_KIND_LABEL[k]!;
          const locked = NOTIFY_KIND_LOCKED.has(k);
          const on = locked ? true : kinds[k] !== false;
          const id = `notify-${k}`;
          return (
            <li key={k} className="flex min-h-[56px] items-center gap-3 py-2">
              <label htmlFor={id} className="min-w-0 flex-1">
                <div className="text-callout">{meta.title}</div>
                <div className="text-caption text-fg-caption">{meta.desc}</div>
              </label>
              <Switch
                id={id}
                label={meta.title}
                checked={on}
                disabled={locked || save.isPending}
                onCheckedChange={(v) => save.mutate({ notify_kinds: { ...s.notify_kinds, [k]: v } })}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RuntimeSection({ s, platformAdmin }: { s: SettingsResponse; platformAdmin: boolean }) {
  const [pct, setPct] = useState(s.default_pause_pct);
  const [merge, setMerge] = useState(String(s.merge_window_min));
  const [minVer, setMinVer] = useState(s.min_client_version);
  const pause = useAction((v: boolean) => api.updateSettings({ global_pause: v }), {
    success: undefined,
    invalidate: [qk.settings, qk.members, qk.dashboard],
  });
  const save = useAction((body: SettingsPatch) => api.updateSettings(body), { success: "已保存", invalidate: [qk.settings] });
  const mergeNum = Number(merge);
  const mergeOk = merge.trim() !== "" && Number.isInteger(mergeNum) && mergeNum >= 0 && mergeNum <= 1440;
  const verOk = minVer.trim() === "" || /^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(minVer.trim());
  const verDirty = platformAdmin && minVer.trim() !== s.min_client_version;
  const dirty = pct !== s.default_pause_pct || mergeNum !== s.merge_window_min || verDirty;
  const globalOn = pause.isPending ? (pause.variables ?? s.global_pause) : s.global_pause;

  return (
    <>
      <section className="glass-1 card flex flex-wrap items-center gap-4 p-5" aria-labelledby="s-pause">
        <PauseOctagon size={24} className={globalOn ? "text-warning-text" : "text-mint-700"} aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="s-pause" className="text-title-2">
            全局暂停
          </h2>
          <p className="text-caption text-fg-caption">
            {globalOn ? "所有 agent 已暂停，不会领取新消息。" : "打开后所有 agent 停止领取新消息，正在进行的轮次会跑完。"}
          </p>
        </div>
        <Switch label="全局暂停" tone="warning" checked={globalOn} disabled={pause.isPending} onCheckedChange={(v) => pause.mutate(v)} />
      </section>

      <section className="glass-1 card p-5" aria-labelledby="s-runtime">
        <h2 id="s-runtime" className="mb-4 flex items-center gap-2 text-title-2">
          <SlidersHorizontal size={20} className="text-mint-700" aria-hidden /> 运行参数
        </h2>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty || !mergeOk || !verOk) return;
            const body: SettingsPatch = { default_pause_pct: pct, merge_window_min: mergeNum };
            // min_client_version is platform-wide: only platform admins send it.
            if (verDirty) body.min_client_version = minVer.trim();
            save.mutate(body);
          }}
        >
          <label className="flex flex-col gap-2">
            <span className="flex items-baseline justify-between text-callout">
              默认额度暂停线
              <span className="tabular text-title-2 text-fg">{pct}%</span>
            </span>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="w-full accent-[var(--mint-500)]"
              aria-valuetext={`${pct}%`}
            />
            <span className="text-caption text-fg-caption">没有单独设置规则的额度窗口，用到这个百分比时自动暂停 agent。100% 表示不提前暂停。</span>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-callout">消息合并窗口（分钟）</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={1440}
                className="field tabular"
                value={merge}
                onChange={(e) => setMerge(e.target.value)}
                aria-invalid={!mergeOk}
              />
              <span className={mergeOk ? "text-caption text-fg-caption" : "text-caption text-danger-text"}>
                {mergeOk ? "同一讨论串在窗口内的多条消息合并成一次投递。" : "请输入 0 到 1440 之间的整数"}
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-callout">最低客户端版本</span>
              <input
                className="field tabular"
                placeholder="例如 0.5.0"
                value={minVer}
                onChange={(e) => setMinVer(e.target.value)}
                aria-invalid={!verOk}
                spellCheck={false}
                disabled={!platformAdmin}
              />
              <span className={verOk ? "text-caption text-fg-caption" : "text-caption text-danger-text"}>
                {!verOk
                  ? "版本号格式应为 x.y.z"
                  : platformAdmin
                    ? "平台级设置，对所有团队生效。低于此版本的 agentbus 会被要求升级，留空表示不限制。"
                    : "平台级设置，只有平台管理员可以修改。"}
              </span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            {dirty ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setPct(s.default_pause_pct);
                  setMerge(String(s.merge_window_min));
                  setMinVer(s.min_client_version);
                }}
              >
                还原
              </button>
            ) : null}
            <button type="submit" className="btn btn-primary btn-lg sm:h-10" disabled={!dirty || !mergeOk || !verOk || save.isPending}>
              {save.isPending ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}

function AuditLog() {
  const members = useMemberMap();
  const q = useInfiniteQuery({
    queryKey: qk.audit,
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => {
      const id = last.entries[last.entries.length - 1]?.id;
      return last.has_more && id !== undefined ? String(id) : undefined;
    },
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <section className="glass-1 card p-5" aria-labelledby="s-audit">
      <h2 id="s-audit" className="mb-3 flex items-center gap-2 text-title-2">
        <ScrollText size={20} className="text-mint-700" aria-hidden /> 审计日志
      </h2>
      {q.isPending ? (
        <div className="skeleton h-40" />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState art="list" compact title="还没有审计记录" />
      ) : (
        <>
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-caption">
              <thead className="text-fg-caption">
                <tr className="border-b border-line">
                  <th className="px-2 py-2 font-medium">时间</th>
                  <th className="px-2 py-2 font-medium">操作人</th>
                  <th className="px-2 py-2 font-medium">操作</th>
                  <th className="px-2 py-2 font-medium">对象</th>
                  <th className="px-2 py-2 font-medium">详情</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.id ?? `${e.created_at}-${i}`} className="border-b border-line align-top last:border-b-0">
                    <td className="tabular whitespace-nowrap px-2 py-2 text-fg-2">{formatDateTime(e.created_at)}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-fg">{members.get(e.actor_id)?.display_name ?? e.actor_id}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-fg">{e.action}</td>
                    <td className="max-w-[180px] truncate px-2 py-2 text-fg-2">
                      {e.target ? (members.get(e.target)?.display_name ?? e.target) : "—"}
                    </td>
                    <td className="max-w-[320px] break-words px-2 py-2 text-fg-2">{e.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {q.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <button className="btn btn-ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? "加载中…" : "加载更多"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function SettingsPage() {
  const search = useSearch({ from: "/settings" });
  const navigate = useNavigate();
  const { isAdmin, platformAdmin } = useRole();
  const me = useMe();
  const teamId = me.data?.team?.id ?? "";
  const emailOk = search.email === "ok";
  const emailFailed = search.email !== undefined && !emailOk;
  const dismiss = () => void navigate({ to: "/settings", search: {}, replace: true });

  // Deep link from the team switcher (/settings#team): scroll once the section exists.
  // Sections above load asynchronously, so wait until the settings query settles (admins) before scrolling.
  const ready = useIsFetching() === 0 && !me.isPending;
  const scrolled = useRef(false);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id || !ready || scrolled.current) return;
    const t = window.setTimeout(() => {
      scrolled.current = true;
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [ready]);

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6">
      <h1 className="text-title-1">设置</h1>

      {emailOk || emailFailed ? (
        <div
          className={
            emailOk
              ? "glass-1 card flex items-center gap-3 border-l-[3px] border-l-mint-500 p-4"
              : "glass-1 card flex items-center gap-3 border-l-[3px] border-l-danger p-4"
          }
          role="status"
        >
          <CheckCircle2 size={20} className={emailOk ? "flex-none text-mint-700" : "flex-none text-danger-text"} aria-hidden />
          <span className="flex-1 text-callout">{emailOk ? "通知邮箱已更换，之后的通知会发到新地址。" : "邮箱确认链接无效或已过期，请重新发起更换。"}</span>
          <button className="btn btn-ghost btn-icon" onClick={dismiss} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      ) : null}

      <TeamSection key={teamId} />

      {isAdmin ? (
        <>
          <InvitesSection />
          <JoinCodesSection />
          <SettingsBody platformAdmin={platformAdmin} />
          <AuditLog />
        </>
      ) : (
        <p className="glass-1 card text-callout font-normal text-fg-2">
          通知、运行参数、邀请和加入码只有团队管理员可以查看和修改。
        </p>
      )}

      <DangerSection />
    </div>
  );
}

function SettingsBody({ platformAdmin }: { platformAdmin: boolean }) {
  const q = useSettings();
  if (q.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <div className="skeleton h-36" />
        <div className="skeleton h-80" />
      </div>
    );
  }
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <EmailSection masked={q.data.notify_email_masked} health={q.data.email_health} />
      <RuntimeSection
        key={`${q.data.default_pause_pct}|${q.data.merge_window_min}|${q.data.min_client_version}`}
        s={q.data}
        platformAdmin={platformAdmin}
      />
      <NotifySection s={q.data} />
    </>
  );
}
