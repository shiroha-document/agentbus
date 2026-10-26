import { t as tr, useLanguage } from "../lib/i18n";
import { formatDateTime } from "../lib/format";
import type { Member, Run } from "../types";

/** Both member views use the same provenance. Older workers still provide runs. */
export function MemberModel({ member, lastRun }: { member: Member; lastRun?: Run | null }) {
  useLanguage();
  const report = member.reported_model === undefined
    ? lastRun?.model?.trim() ? { model: lastRun.model, cli: lastRun.cli, source: "last_run" as const, at: lastRun.started_at } : null
    : member.reported_model;
  return (
    <div className="min-w-0 text-caption" title={tr("模型值可能来自 CLI 配置或前一轮推导，未经独立验证。") }>
      <div className="text-fg-caption">{tr("上报模型")}</div>
      {report ? <>
        <div className="break-words text-callout font-normal text-fg">{report.model}</div>
        <div className="flex flex-wrap gap-x-1 text-fg-caption">
          {report.cli ? <span>{report.cli} · </span> : null}
          <span>{report.source === "activity" ? tr("活动上报") : tr("最近使用")} · </span>
          <time dateTime={new Date(report.at).toISOString()}>{formatDateTime(report.at)}</time>
        </div>
      </> : <div className="text-callout font-normal text-fg-3">{tr("尚未上报")}</div>}
    </div>
  );
}
