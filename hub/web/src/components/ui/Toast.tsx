import { t as tr, useLanguage, type LocalizedMessage } from "../../lib/i18n";
import { useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { springSoft, reducedFade } from "../../lib/motion";

export type ToastMessage = string | LocalizedMessage | (() => string);
export type ToastKind = "error" | "success" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: ToastMessage;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(message: ToastMessage, kind: ToastKind = "info", ttl = kind === "error" ? 6000 : 3500): void {
  const id = nextId++;
  items = [...items.slice(-3), { id, kind, message }];
  emit();
  window.setTimeout(() => dismiss(id), ttl);
}
toast.error = (e: unknown) => toast(e instanceof Error ? () => e.message : String(e), "error");
toast.success = (m: ToastMessage) => toast(m, "success");

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const ICON = { error: AlertCircle, success: CheckCircle2, info: Info } as const;
const TONE = { error: "text-danger-text", success: "text-mint-700", info: "text-info-text" } as const;

export function Toaster() {
  useLanguage();
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  const reduced = useReducedMotion() ?? false;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:px-6"
      role="region"
      aria-label={tr("通知")}
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {list.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <motion.div
              key={t.id}
              layout={!reduced}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: reducedFade }}
              transition={reduced ? reducedFade : springSoft}
              className="glass-3 pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[16px] px-4 py-3 text-callout"
              role={t.kind === "error" ? "alert" : "status"}
            >
              <Icon size={18} className={`mt-0.5 flex-none ${TONE[t.kind]}`} aria-hidden />
              <p className="flex-1 font-normal text-fg">{typeof t.message === "function" ? t.message() : typeof t.message === "string" ? t.message : tr(t.message.key, t.message.values)}</p>
              <button className="btn btn-ghost btn-sm -mr-2 -mt-1 w-7 px-0" onClick={() => dismiss(t.id)} aria-label={tr("关闭通知")}>
                <X size={14} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
