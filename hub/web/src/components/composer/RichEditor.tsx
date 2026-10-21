import { useId, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { AlertCircle, Paperclip, X } from "lucide-react";
import "../../styles/live.css";
import { cliLabel } from "../../lib/cli";
import { formatBytes, MAX_ATTACHMENTS } from "../../lib/attachments";
import { cn } from "../../lib/util";
import type { Member } from "../../types";
import { Avatar } from "../ui/Avatar";
import { StatusDot, presenceOf } from "../ui/StatusDot";
import { MimeIcon } from "../post/Attachments";
import type { AttachmentsState } from "./useAttachments";
import { useMentions } from "./useMentions";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const SEND_HINT = `${isMac ? "⌘" : "Ctrl"} + Enter 发送`;

/** Drag-and-drop files onto a container; render `<DropHint />` while `dragging`. */
export function useDropZone(attachments: AttachmentsState, disabled?: boolean) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      attachments.add(e.dataTransfer.files);
    },
  };
  return { dragging, handlers };
}

export function DropHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="drop-hint" aria-hidden>
      <Paperclip size={18} className="mr-2" /> 松开即可添加附件
    </div>
  );
}

/** Paperclip button + hidden file input. */
export function AttachButton({ attachments, disabled }: { attachments: AttachmentsState; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const full = attachments.items.filter((x) => x.status !== "error").length >= MAX_ATTACHMENTS;
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          attachments.add(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="btn btn-ghost btn-icon h-9 min-h-0 w-9 text-fg-2"
        disabled={disabled || full}
        onClick={() => input.current?.click()}
        aria-label={full ? `最多 ${MAX_ATTACHMENTS} 个附件` : "添加附件（图片或文件，单个不超过 10 MB）"}
        title={full ? `最多 ${MAX_ATTACHMENTS} 个附件` : "添加附件"}
      >
        <Paperclip size={18} aria-hidden />
      </button>
    </>
  );
}

/** Previews of picked files with upload progress and a remove button. */
export function AttachmentTray({ attachments }: { attachments: AttachmentsState }) {
  if (attachments.items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-1 pb-1 pt-2" aria-label="待发送的附件">
      {attachments.items.map((a) => (
        <li
          key={a.key}
          className={cn(
            "relative flex h-14 max-w-[220px] items-center gap-2 overflow-hidden rounded-[12px] border bg-surface pr-8",
            a.status === "error" ? "border-danger" : "border-line",
            a.preview ? "pl-0" : "pl-2.5",
          )}
        >
          {a.preview ? (
            <img src={a.preview} alt="" className="h-14 w-14 flex-none object-cover" />
          ) : (
            <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-mint-100 text-mint-700">
              <MimeIcon mime={a.mime} name={a.name} />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-caption text-fg">{a.name}</span>
            <span className={cn("tabular block text-[11px] leading-4", a.status === "error" ? "text-danger-text" : "text-fg-caption")}>
              {a.status === "uploading" ? (
                `上传中 ${Math.round(a.progress * 100)}%`
              ) : a.status === "error" ? (
                <span className="inline-flex items-center gap-1">
                  <AlertCircle size={11} aria-hidden /> 上传失败
                </span>
              ) : (
                formatBytes(a.size)
              )}
            </span>
          </span>
          {a.status === "uploading" ? (
            <span
              className="att-progress"
              style={{ width: `${Math.round(a.progress * 100)}%` }}
              role="progressbar"
              aria-label={`${a.name} 上传进度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(a.progress * 100)}
            />
          ) : null}
          <button
            type="button"
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-surface-strong text-fg-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            onClick={() => attachments.remove(a.key)}
            aria-label={`移除附件 ${a.name}`}
          >
            <X size={12} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

interface EditorProps {
  value: string;
  onChange: (v: string) => void;
  members: readonly Member[];
  attachments: AttachmentsState;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Offer `@all` (thread replies). */
  allowAll?: boolean;
  /** Where the mention popup opens. */
  popup?: "above" | "below";
  children?: ReactNode;
}

/**
 * Textarea with @-autocomplete (avatar, display name, CLI, online dot; ↑/↓/Enter/Tab/Esc),
 * paste-to-attach and ⌘/Ctrl+Enter submit. Shared by the thread composer and home QuickPost.
 */
export function RichEditor({
  value,
  onChange,
  members,
  attachments,
  onSubmit,
  disabled,
  placeholder,
  ariaLabel,
  className,
  textareaRef,
  allowAll = true,
  popup = "above",
}: EditorProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  const listId = useId();
  const m = useMentions(members, value, onChange, ref, { allowAll });
  const optId = (i: number) => `${listId}-opt-${i}`;
  return (
    <div className="relative">
      {m.open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="提及成员"
          className={cn(
            "glass-3 absolute left-0 z-30 w-80 max-w-full overflow-hidden rounded-[16px] p-1",
            popup === "above" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          {m.suggestions.map((s, i) => (
            <li
              key={s.name}
              id={optId(i)}
              role="option"
              aria-selected={i === m.active}
              className={cn("flex min-h-[44px] cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 text-callout", i === m.active && "bg-mint-100")}
              onMouseDown={(e) => {
                e.preventDefault();
                m.pick(s);
              }}
              onMouseEnter={() => m.setActive(i)}
            >
              {s.member ? (
                <span className="relative flex-none">
                  <Avatar member={s.member} size={26} />
                </span>
              ) : (
                <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-mint-200 text-caption">@</span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{s.label}</span>
                <span className="block truncate text-caption text-fg-caption">
                  @{s.name}
                  {s.member?.kind === "agent" && s.member.cli ? ` · ${cliLabel(s.member.cli)}` : ""}
                  {s.member?.kind === "human" ? " · 成员" : ""}
                </span>
              </span>
              {s.member?.kind === "agent" ? <StatusDot state={presenceOf(s.member)} className="flex-none" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          m.update(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => m.update(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onBlur={m.close}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length > 0) {
            e.preventDefault();
            attachments.add(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (m.onKeyDown(e)) return;
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={3}
        placeholder={placeholder}
        className={cn("block w-full resize-y bg-transparent px-2 py-1.5 text-body outline-none placeholder:text-fg-3", className)}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={m.open}
        aria-controls={m.open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={m.open ? optId(m.active) : undefined}
      />
    </div>
  );
}
