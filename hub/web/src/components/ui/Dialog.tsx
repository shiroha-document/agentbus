import { t as tr, useLanguage } from "../../lib/i18n";
import * as RDialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { reducedFade, springSoft } from "../../lib/motion";
import { cn } from "../../lib/util";

interface DialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: DialogProps) {
  useLanguage();
  const reduced = useReducedMotion() ?? false;
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content
          aria-describedby={description ? undefined : undefined}
          className="fixed inset-0 z-50 flex items-end justify-center p-0 outline-none sm:items-center sm:p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) onOpenChange(false);
          }}
        >
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            transition={reduced ? reducedFade : springSoft}
            className={cn(
              "glass-3 flex max-h-[90dvh] w-full flex-col rounded-t-[28px] sm:rounded-[28px]",
              wide ? "sm:max-w-2xl" : "sm:max-w-md",
            )}
          >
            <div className="flex items-start gap-3 px-6 pb-2 pt-6">
              <div className="flex-1">
                <RDialog.Title className="text-title-2 text-fg">{title}</RDialog.Title>
                {description ? (
                  <RDialog.Description className="mt-1 text-callout font-normal text-fg-2">{description}</RDialog.Description>
                ) : (
                  <RDialog.Description className="sr-only">{title}</RDialog.Description>
                )}
              </div>
              <RDialog.Close className="btn btn-ghost btn-icon -mr-2 -mt-1" aria-label={tr("关闭")}>
                <X size={18} />
              </RDialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">{children}</div>
            {footer ? <div className="flex flex-wrap justify-end gap-2 px-6 pb-6 pt-3">{footer}</div> : <div className="h-4" />}
          </motion.div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Right-side drawer (glass-3) — used for member detail. */
export function Drawer({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  useLanguage();
  const reduced = useReducedMotion() ?? false;
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="overlay" />
        <RDialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] outline-none">
          <motion.div
            initial={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { x: 0, opacity: 1 }}
            transition={reduced ? reducedFade : springSoft}
            className="glass-3 flex h-full w-full flex-col rounded-none md:my-3 md:mr-3 md:h-[calc(100%-24px)] md:rounded-[28px]"
          >
            <div className="flex items-center gap-3 px-6 pb-3 pt-5">
              <RDialog.Title className="flex-1 text-title-2">{title}</RDialog.Title>
              <RDialog.Description className="sr-only">{title}</RDialog.Description>
              <RDialog.Close className="btn btn-ghost btn-icon -mr-2" aria-label={tr("关闭")}>
                <X size={18} />
              </RDialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">{children}</div>
          </motion.div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  useLanguage();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <button className="btn btn-secondary btn-lg sm:h-9" onClick={() => onOpenChange(false)}>{tr("取消")}</button>
          <button
            className={cn("btn btn-lg sm:h-9", danger ? "btn-danger-solid" : "btn-primary")}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
