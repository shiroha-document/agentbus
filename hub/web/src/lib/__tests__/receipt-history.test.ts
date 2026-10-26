import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setTransport } from "../../api";
import { setLanguage } from "../i18n";
import { ReceiptTicks } from "../../components/live/ReceiptTicks";
import type { Member, Receipt, ThreadLive } from "../../types";

const apiModule = await import("../../api");
const receiptModule = await import("../../components/live/ReceiptTicks");
const liveModule = await import("../live");
const states = ["sent", "received", "working", "handled", "failed"] as const;
const receipts: Receipt[] = states.map((state, i) => ({ member_id: `m_${i}`, state, at: 1_700_000_000_000 + i * 1000, eta: null }));
const members = new Map(receipts.map((r, i) => [r.member_id, { id: r.member_id, name: `agent${i}`, display_name: `Agent ${i}` } as Member]));

beforeEach(() => setLanguage("en"));
afterEach(() => setTransport(null));

function render(receiptList: Receipt[] | undefined) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
    createElement(Tooltip.Provider, null, createElement(ReceiptTicks, { receipts: receiptList, members, threadId: "t_history", postId: "p_oldest" })),
  ));
}

describe("loaded receipt history", () => {
  it("splits 212 loaded post IDs into batches of at most 100, without losing posts", () => {
    expect(liveModule).toHaveProperty("receiptPostBatches");
    const ids = Array.from({ length: 212 }, (_, i) => `p_${String(i).padStart(3, "0")}`);
    const batches = liveModule.receiptPostBatches([...ids, ids[0]!]);
    expect(batches.map((batch: string[]) => batch.length)).toEqual([100, 100, 12]);
    expect(batches.flat()).toEqual(ids);
    expect(liveModule.receiptPostBatches([])).toEqual([]);
  });

  it("queries all loaded IDs in bounded requests and preserves live activity and newest post", async () => {
    expect(apiModule).toHaveProperty("fetchThreadLive");
    const seen: string[][] = [];
    const activity: ThreadLive["activity"] = [{ member_id: "m_0", state: "running", detail: "warning retained", cli: null, model: null, started_at: 1, updated_at: 2, stale: true }];
    setTransport(async (_method, path) => {
      const ids = new URL(path, "https://example.test").searchParams.get("post_ids")?.split(",") ?? [];
      seen.push(ids);
      return { status: 200, data: { now: 123, receipts: Object.fromEntries(ids.map((id) => [id, [receipts[0]!]])), activity, next_post_id: "p_newest" } };
    });
    const ids = Array.from({ length: 212 }, (_, i) => `p_${i}`);
    const live = await apiModule.fetchThreadLive("t_history", ids);
    expect(seen.map((batch) => batch.length)).toEqual([100, 100, 12]);
    expect(new Set(seen.flat())).toEqual(new Set(ids));
    expect(Object.keys(live.receipts)).toHaveLength(212);
    expect(live.activity).toEqual(activity);
    expect(live.next_post_id).toBe("p_newest");
  });

  it("refreshes an individual post using an explicit one-post query", async () => {
    let requested = "";
    setTransport(async (_method, path) => { requested = path; return { status: 200, data: { receipts: { p_oldest: receipts } } }; });
    const live = await api.threadLive("t_history", ["p_oldest"]);
    expect(new URL(requested, "https://example.test").searchParams.get("post_ids")).toBe("p_oldest");
    expect(live.receipts.p_oldest).toEqual(receipts);
  });
});

describe("receipt controls", () => {
  it("renders a compact count with a native button and a dialog popup", () => {
    const html = render(receipts);
    expect(html).toContain("Received 3/5");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Waiting for @");
  });

  it("hides missing and empty delivery records", () => {
    expect(render(undefined)).toBe("");
    expect(render([])).toBe("");
  });

  it.each(["en", "zh"] as const)("distinguishes mixed received progress from all waiting in %s", (language) => {
    const mixed = [receipts[0]!, { ...receipts[1]!, member_id: "m_1" }, { ...receipts[1]!, member_id: "m_2" }];
    const waiting = mixed.map((receipt) => ({ ...receipt, state: "sent" as const }));
    setLanguage(language);
    const mixedHtml = render(mixed);
    const waitingHtml = render(waiting);
    const receivedLabel = language === "en" ? "Received" : "已接收";
    const waitingLabel = language === "en" ? "Waiting" : "等待接收";
    expect(mixedHtml).toContain(`<span>${receivedLabel} 2/3 · ${waitingLabel}</span>`);
    expect(waitingHtml).toContain(`<span>${receivedLabel} 0/3 · ${waitingLabel}</span>`);
    expect(mixedHtml).toContain('data-state="sent"');
    expect(waitingHtml).toContain('data-state="sent"');
  });

  it("counts working and handled as received while preserving failure visibility without inferring a failed claim", () => {
    expect(render(receipts)).toContain("Received 3/5 · Delivery failed");
    expect(render([receipts[0]!, receipts[4]!])).toContain("Received 0/2 · Delivery failed");
    expect(render([receipts[2]!, receipts[3]!])).toContain("Received 2/2 · Working");
  });

  it("shows named recipients, all five statuses, exact times, and claim meaning in both languages", () => {
    expect(receiptModule).toHaveProperty("ReceiptDetails");
    for (const language of ["en", "zh"] as const) {
      setLanguage(language);
      const html = renderToStaticMarkup(createElement(receiptModule.ReceiptDetails, { receipts, members }));
      for (const member of members.values()) expect(html).toContain(member.name);
      for (const receipt of receipts) expect(html).toContain(new Date(receipt.at).toISOString());
      if (language === "en") {
        for (const label of ["Waiting", "Received", "Working", "Processed", "Delivery failed"]) expect(html).toContain(label);
        expect(html).toContain("agent claimed the delivery");
        expect(html).not.toMatch(/[\u3400-\u9fff]/);
      } else {
        for (const label of ["等待接收", "已接收", "处理中", "已处理", "投递失败"]) expect(html).toContain(label);
        expect(html).toContain("agent 已领取投递任务");
      }
    }
  });
});

it("keeps mock history queries scoped to the requested post IDs", async () => {
  vi.useFakeTimers();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const { installMock } = await import("../../mock");
    installMock();
    const result = api.threadLive("t_long", ["p_l0", "p_task"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(Object.keys((await result).receipts)).toEqual(["p_l0"]);
  } finally {
    vi.useRealTimers();
    info.mockRestore();
  }
});
