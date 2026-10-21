import { Check } from "lucide-react";
import "../../styles/live.css";
import { formatRelative } from "../../lib/format";
import { RECEIPT_LABEL, receiptText, summarizeReceipts, summaryStateFromCounts } from "../../lib/live";
import type { FeedItem, Member, Receipt, ReceiptState } from "../../types";
import { Tip } from "../ui/Tip";
import { useNow } from "./useNow";

/** Telegram-style ticks: one grey tick = sent, two = read, two mint = handled. */
export function Ticks({ state }: { state: ReceiptState }) {
  const double = state !== "sent" && state !== "failed";
  return (
    <span className="receipt-ticks" aria-hidden>
      <Check strokeWidth={3} />
      {double ? <Check strokeWidth={3} /> : null}
    </span>
  );
}

const STATE_ORDER: Record<ReceiptState, number> = { failed: 0, sent: 1, received: 2, working: 3, handled: 4 };

/**
 * Delivery receipts under one of my posts: aggregate ticks + a short line ("等待 @x 唤醒 ·
 * 预计 1:05" / "已读" / "已处理"), and a tooltip listing every recipient with a time.
 */
export function ReceiptTicks({ receipts, members }: { receipts: Receipt[] | undefined; members: Map<string, Member> }) {
  const sum = summarizeReceipts(receipts);
  const counting = !!sum && sum.state === "sent" && sum.eta !== null;
  const now = useNow(1000, counting);
  if (!sum || !receipts) return null;
  const nameOf = (id: string) => members.get(id)?.name ?? id;
  const sorted = [...receipts].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  const lead = sorted[0]!;
  let text: string;
  if (sum.total === 1) text = receiptText(lead, nameOf(lead.member_id), now);
  else if (sum.state === "sent") text = receiptText({ ...lead, eta: sum.eta }, nameOf(lead.member_id), now) + ` 等 ${sum.total} 人`;
  else if (sum.state === "handled") text = `${sum.total} 人已处理`;
  else if (sum.state === "failed") text = `${sum.counts.failed} 人投递失败`;
  else text = `${RECEIPT_LABEL[sum.state]} · ${sum.counts.handled}/${sum.total} 已处理`;

  const detail = (
    <ul className="flex min-w-[180px] flex-col gap-1">
      {sorted.map((r) => (
        <li key={r.member_id} className="flex items-center gap-2">
          <span className="receipt" data-state={r.state}>
            <Ticks state={r.state} />
          </span>
          <span className="flex-1 truncate">@{nameOf(r.member_id)}</span>
          <span className="text-fg-caption">
            {RECEIPT_LABEL[r.state]} · {formatRelative(r.at, now)}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <Tip content={detail} side="top">
      <button type="button" className="receipt tabular" data-state={sum.state} aria-label={`送达状态：${text}`}>
        <Ticks state={sum.state} />
        <span aria-live="polite">{text}</span>
      </button>
    </Tip>
  );
}

/** Tiny tick on home feed items (from `receipts_summary`). */
export function FeedTick({ summary }: { summary: FeedItem["receipts_summary"] }) {
  const state = summaryStateFromCounts(summary);
  if (!state || !summary) return null;
  const total = summary.sent + summary.received + summary.working + summary.handled;
  const label = state === "handled" ? `${total} 人已处理` : `${RECEIPT_LABEL[state]}（${summary.handled}/${total} 已处理）`;
  return (
    <Tip content={label}>
      <span className="feed-tick receipt" data-state={state} role="img" aria-label={label} tabIndex={0}>
        <Ticks state={state} />
      </span>
    </Tip>
  );
}
