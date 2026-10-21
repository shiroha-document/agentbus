import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, Cpu, Inbox } from "lucide-react";
import "../../styles/live.css";
import { activityText, formatElapsed, visibleActivity } from "../../lib/live";
import { reducedFade, springSoft } from "../../lib/motion";
import type { Activity, Member } from "../../types";
import { Avatar } from "../ui/Avatar";
import { useNow } from "./useNow";

export function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function Row({ a, member, now }: { a: Activity; member?: Member; now: number }) {
  const name = member?.name ?? a.member_id;
  const text = activityText(a, name);
  return (
    <div className="activity-row" data-stale={a.stale}>
      <Avatar member={member} size={20} />
      {a.state === "running" ? <Cpu size={14} className="spin-slow flex-none text-mint-600" aria-hidden /> : null}
      {a.state === "claimed" ? <Inbox size={14} className="flex-none text-fg-3" aria-hidden /> : null}
      <span className="min-w-0 truncate">{text}</span>
      {a.state === "typing" || a.state === "running" ? <TypingDots /> : null}
      <span className="tabular ml-auto flex-none text-caption text-fg-caption" aria-label={`已用时 ${formatElapsed(a.started_at, now)}`}>
        {formatElapsed(a.started_at, now)}
      </span>
      {a.stale ? (
        <span className="inline-flex flex-none items-center gap-1 text-caption text-warning-text">
          <AlertTriangle size={12} aria-hidden /> 超过 10 分钟没有动静
        </span>
      ) : null}
    </div>
  );
}

/**
 * Bottom bar above the composer: "@agent 已接收 / 正在运行 cursor · gpt-5 / 正在输入…" with an
 * elapsed clock. Only in-progress rows (claimed/running/typing), newest first.
 */
export function ActivityBar({ activity, members }: { activity: Activity[] | undefined; members: Map<string, Member> }) {
  const rows = visibleActivity(activity);
  const reduced = useReducedMotion() ?? false;
  const now = useNow(1000, rows.length > 0);
  const summary = rows.map((a) => activityText(a, members.get(a.member_id)?.name ?? a.member_id)).join("；");
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      <span className="sr-only">{summary}</span>
      <AnimatePresence initial={false}>
        {rows.length > 0 ? (
          <motion.div
            key="bar"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, height: 0 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, height: 0 }}
            transition={reduced ? reducedFade : springSoft}
            className="mb-2 overflow-hidden"
            aria-hidden
          >
            <div className="activity-bar">
              <AnimatePresence initial={false}>
                {rows.map((a) => (
                  <motion.div
                    key={a.member_id}
                    layout={!reduced}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reduced ? reducedFade : { duration: 0.18 }}
                  >
                    <Row a={a} member={members.get(a.member_id)} now={now} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
