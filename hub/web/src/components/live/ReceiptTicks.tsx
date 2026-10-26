import { t as tr, useLanguage } from "../../lib/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { Check, X } from "lucide-react";
import "../../styles/live.css";
import { api } from "../../api";
import { LIVE_FAST_MS, LIVE_SLOW_MS, qk } from "../../queries";
import { formatDateTime } from "../../lib/format";
import { RECEIPT_LABEL, isLiveActive, summarizeReceipts, summaryStateFromCounts } from "../../lib/live";
import type { FeedItem, Member, Receipt, ReceiptState } from "../../types";
import { Tip } from "../ui/Tip";

/** One tick = awaiting claim, two = claimed, two mint = handled. */
export function Ticks({ state }: { state: ReceiptState }) {
  useLanguage();
  const double = state !== "sent" && state !== "failed";
  return (
    <span className="receipt-ticks" aria-hidden>
      <Check strokeWidth={3} />
      {double ? <Check strokeWidth={3} /> : null}
    </span>
  );
}

const STATE_ORDER: Record<ReceiptState, number> = { failed: 0, sent: 1, received: 2, working: 3, handled: 4 };

/** Recipient names, delivery status and the time that status was recorded. */
export function ReceiptDetails({ receipts, members }: { receipts: readonly Receipt[]; members: Map<string, Member> }) {
  useLanguage();
  const sorted = [...receipts].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  return (
    <>
      <p className="text-caption text-fg-caption">{tr("已接收表示 agent 已领取投递任务。")}</p>
      {sorted.length ? (
        <ul className="mt-3 flex max-h-72 flex-col gap-3 overflow-y-auto">
          {sorted.map((r) => {
            const member = members.get(r.member_id);
            return (
              <li key={r.member_id} className="flex items-start gap-2">
                <span className="receipt mt-0.5" data-state={r.state}><Ticks state={r.state} /></span>
                <div className="min-w-0 flex-1">
                  <div className="break-words text-callout">{member?.display_name ?? r.member_id}{member ? <span className="text-fg-caption"> · @{member.name}</span> : null}</div>
                  <div className="flex flex-wrap gap-x-2 text-caption text-fg-caption">
                    <span>{RECEIPT_LABEL[r.state]}</span>
                    <time dateTime={new Date(r.at).toISOString()}>{formatDateTime(r.at)}</time>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : <p className="mt-3 text-caption text-fg-caption">{tr("没有投递记录")}</p>}
    </>
  );
}

/** A compact receipt count for any viewer; opening it refreshes this post only. */
export function ReceiptTicks({ receipts, members, threadId, postId }: {
  receipts: Receipt[] | undefined;
  members: Map<string, Member>;
  threadId: string;
  postId: string;
}) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: qk.threadReceipt(threadId, postId),
    queryFn: () => api.threadLive(threadId, [postId]),
    enabled: open,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchInterval: (query) => isLiveActive(query.state.data) ? LIVE_FAST_MS : LIVE_SLOW_MS,
    refetchIntervalInBackground: false,
  });
  const sum = summarizeReceipts(receipts);
  if (!sum) return null;
  const received = sum.counts.received + sum.counts.working + sum.counts.handled;
  const text = `${tr("已接收 {0}/{1}", [received, sum.total])} · ${RECEIPT_LABEL[sum.state]}`;
  const current = detail.isSuccess ? detail.data.receipts[postId] ?? [] : receipts ?? [];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="receipt tabular px-2" style={{ minHeight: 40 }} data-state={sum.state} aria-label={tr("送达状态：{0}", [text])}>
          <Ticks state={sum.state} />
          <span>{text}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={6} collisionPadding={12}
          className="glass-3 z-[70] w-[min(360px,calc(100vw-24px))] rounded-[12px] p-3 text-fg outline-none"
          aria-label={tr("投递回执")} aria-busy={detail.isFetching}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-callout font-semibold">{tr("投递回执")}</span>
            <Popover.Close asChild><button type="button" className="btn btn-ghost btn-icon min-h-10" aria-label={tr("关闭")}><X size={16} aria-hidden /></button></Popover.Close>
          </div>
          {detail.isFetching ? <p role="status" className="mb-2 text-caption text-fg-caption">{tr("加载中…")}</p> : null}
          {detail.isError ? (
            <div role="alert" className="mb-2 flex items-center gap-2 text-caption text-danger-text">
              <span>{tr("刷新回执失败")}</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void detail.refetch()}>{tr("重试")}</button>
            </div>
          ) : null}
          <ReceiptDetails receipts={current} members={members} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Tiny tick on home feed items (from `receipts_summary`). */
export function FeedTick({ summary }: { summary: FeedItem["receipts_summary"] }) {
  useLanguage();
  const state = summaryStateFromCounts(summary);
  if (!state || !summary) return null;
  const total = summary.sent + summary.received + summary.working + summary.handled;
  const label = state === "handled" ? tr("{0} 人已处理", [total]) : tr("{0}（{1}/{2} 已处理）", [RECEIPT_LABEL[state], summary.handled, total]);
  return (
    <Tip content={label}>
      <span className="feed-tick receipt" data-state={state} role="img" aria-label={label} tabIndex={0}>
        <Ticks state={state} />
      </span>
    </Tip>
  );
}
