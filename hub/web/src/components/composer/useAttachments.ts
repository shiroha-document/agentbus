import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { isInlineImage, mimeGroup, validateFiles } from "../../lib/attachments";
import { track } from "../../lib/telemetry";
import type { Attachment } from "../../types";
import { toast } from "../ui/Toast";

export interface PendingAttachment {
  key: string;
  name: string;
  mime: string;
  size: number;
  /** blob: URL for local image previews. */
  preview: string | null;
  status: "uploading" | "done" | "error";
  /** 0..1 — fetch() has no upload progress, so this eases towards 0.9 until the hub answers. */
  progress: number;
  attachment?: Attachment;
  error?: string;
}

let seq = 0;

/**
 * Composer attachments: validation (≤ 6, ≤ 10 MB, Chinese toasts), upload via `api.upload`
 * with per-file status, previews, remove, and the ids to send with the post.
 */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const timers = useRef(new Map<string, number>());

  const patch = useCallback((key: string, p: Partial<PendingAttachment>) => {
    setItems((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));
  }, []);

  const stopTimer = (key: string) => {
    const t = timers.current.get(key);
    if (t !== undefined) window.clearInterval(t);
    timers.current.delete(key);
  };

  const add = useCallback(
    (input: FileList | File[] | null | undefined) => {
      const files = input ? Array.from(input) : [];
      if (files.length === 0) return;
      const live = itemsRef.current.filter((x) => x.status !== "error").length;
      const { ok, errors } = validateFiles(files, live);
      errors.forEach((e) => toast(e, "error"));
      for (const file of ok) {
        const key = `att-${++seq}`;
        const mime = file.type || "application/octet-stream";
        const preview = isInlineImage(mime) && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
        track("composer.attach", { mime_group: mimeGroup(mime, file.name) });
        setItems((list) => [...list, { key, name: file.name, mime, size: file.size, preview, status: "uploading", progress: 0.05 }]);
        timers.current.set(
          key,
          window.setInterval(() => {
            setItems((list) => list.map((x) => (x.key === key && x.status === "uploading" ? { ...x, progress: x.progress + (0.9 - x.progress) * 0.25 } : x)));
          }, 250),
        );
        api
          .upload(file)
          .then((r) => {
            stopTimer(key);
            patch(key, { status: "done", progress: 1, attachment: r.attachment });
          })
          .catch((e: unknown) => {
            stopTimer(key);
            const msg = e instanceof Error ? e.message : String(e);
            patch(key, { status: "error", progress: 0, error: msg });
            toast(`「${file.name}」上传失败：${msg}`, "error");
          });
      }
    },
    [patch],
  );

  const remove = useCallback((key: string) => {
    stopTimer(key);
    setItems((list) => {
      const it = list.find((x) => x.key === key);
      if (it?.preview) URL.revokeObjectURL(it.preview);
      return list.filter((x) => x.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    for (const k of timers.current.keys()) stopTimer(k);
    setItems((list) => {
      list.forEach((x) => x.preview && URL.revokeObjectURL(x.preview));
      return [];
    });
  }, []);

  useEffect(
    () => () => {
      for (const t of timers.current.values()) window.clearInterval(t);
      itemsRef.current.forEach((x) => x.preview && URL.revokeObjectURL(x.preview));
    },
    [],
  );

  const ids = items.flatMap((x) => (x.status === "done" && x.attachment ? [x.attachment.id] : []));
  const uploading = items.some((x) => x.status === "uploading");
  return { items, add, remove, clear, ids, uploading };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;
