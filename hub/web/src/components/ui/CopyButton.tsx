import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../../lib/util";
import { toast } from "./Toast";

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / denied permission.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = "复制", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (await writeClipboard(text)) {
      setDone(true);
      window.setTimeout(() => setDone(false), 1600);
    } else {
      toast("复制失败，请手动选择文本复制", "error");
    }
  };
  return (
    <button type="button" className={cn("btn btn-secondary", className)} onClick={() => void copy()} aria-label={label}>
      {done ? <Check size={16} className="text-mint-700" aria-hidden /> : <Copy size={16} aria-hidden />}
      <span aria-live="polite">{done ? "已复制" : label}</span>
    </button>
  );
}

/** One-time secret block: monospace, selectable, with a copy button and a "only shown once" hint. */
export function SecretBlock({ text, hint, multiline }: { text: string; hint: string; multiline?: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-[16px] border border-mint-300 bg-mint-50 p-3">
      <div className="flex items-start gap-2">
        <pre
          className={cn(
            "min-w-0 flex-1 select-all overflow-x-auto rounded-[10px] bg-surface-strong px-3 py-2 font-mono text-caption leading-5 text-fg",
            multiline ? "whitespace-pre" : "whitespace-nowrap",
          )}
          tabIndex={0}
        >
          {text}
        </pre>
        <CopyButton text={text} className="flex-none" />
      </div>
      <p className="text-caption text-fg-caption">{hint}</p>
    </div>
  );
}
