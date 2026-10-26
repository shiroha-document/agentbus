import { t as tr, useLanguage } from "../../lib/i18n";
import { useId, useState } from "react";
import { ChevronDown, Pencil, Target } from "lucide-react";
import { cn } from "../../lib/util";
import { Markdown } from "../Markdown";

/** The thread's current state is separate from retained state-update posts. */
export function StatePanel({ state, onSave, busy }: { state: string; onSave: (s: string) => void; busy: boolean }) {
  useLanguage();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(state);
  const bodyId = useId();
  const summary = state.split(/\r?\n/).map((line) => line.replace(/^[\s>#*-]+/, "").replace(/[`*_]/g, "").trim()).find(Boolean) ?? "";
  const save = () => {
    if (busy || value === state) return;
    onSave(value);
    setEditing(false);
  };

  return (
    <section className="glass-1 card px-4 py-3" aria-label={tr("当前状态")}>
      <div className="flex flex-wrap items-center gap-2">
        <Target size={16} className="text-mint-700" aria-hidden />
        <h2 className="text-callout font-semibold">{tr("当前状态")}</h2>
        {!editing ? (
          <>
            {state.trim() ? (
              <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}
                className="btn btn-ghost min-h-10 px-2 text-caption text-fg-2">
                {open ? tr("收起全文") : tr("展开全文")}
                <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost ml-auto min-h-10 px-2 text-caption" disabled={busy}
              onClick={() => { setValue(state); setEditing(true); }}>
              <Pencil size={14} aria-hidden />{" "}{tr("编辑")}</button>
          </>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea className="field min-h-[140px] resize-y py-2.5 text-callout font-normal" value={value}
            onChange={(e) => setValue(e.target.value)} autoFocus aria-label={tr("当前状态内容")}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); }
            }} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary min-h-10" onClick={() => setEditing(false)}>{tr("取消")}</button>
            <button type="button" className="btn btn-primary min-h-10" disabled={busy || value === state} onClick={save}>{tr("保存")}</button>
          </div>
        </div>
      ) : state.trim() ? (
        <>
          {!open ? <p className="line-clamp-2 text-callout font-normal text-fg-2 [overflow-wrap:anywhere]">{summary}</p> : null}
          <div id={bodyId} hidden={!open} className="mt-2 text-callout font-normal text-fg-2">
            {open ? <Markdown>{state}</Markdown> : null}
          </div>
        </>
      ) : (
        <p className="text-callout font-normal text-fg-3">{tr("还没有记录。负责人会在这里总结进展、阻塞和下一步。")}</p>
      )}
    </section>
  );
}
