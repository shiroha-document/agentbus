import { useState } from "react";
import { ChevronLeft, ChevronRight, Download, File, FileArchive, FileText, FileType2, Image as ImageIcon } from "lucide-react";
import "../../styles/live.css";
import { attachmentHref, formatBytes, isInlineImage, mimeGroup, type MimeGroup } from "../../lib/attachments";
import { cn } from "../../lib/util";
import type { Attachment } from "../../types";
import { Dialog } from "../ui/Dialog";

const ICON: Record<MimeGroup, typeof File> = { image: ImageIcon, text: FileText, pdf: FileType2, archive: FileArchive, other: File };

export function MimeIcon({ mime, name, size = 16, className }: { mime: string; name?: string; size?: number; className?: string }) {
  const Icon = ICON[mimeGroup(mime, name)];
  return <Icon size={size} className={className} aria-hidden />;
}

/** One file chip: mime icon, name, size, download link. */
export function FileChip({ att }: { att: Attachment }) {
  const href = attachmentHref(att.url);
  const body = (
    <>
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-mint-100 text-mint-700">
        <MimeIcon mime={att.mime} name={att.name} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-callout text-fg">{att.name}</span>
        <span className="tabular block text-caption text-fg-caption">{formatBytes(att.size)}</span>
      </span>
      {href ? <Download size={16} className="flex-none text-fg-3" aria-hidden /> : null}
    </>
  );
  const cls = "flex min-h-[48px] w-full max-w-[280px] items-center gap-2.5 rounded-[14px] border border-line bg-surface px-2.5 py-1.5";
  if (!href) return <div className={cls}>{body}</div>;
  return (
    <a
      href={href}
      download={att.name}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, "transition-colors hover:bg-mint-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]")}
      aria-label={`下载 ${att.name}（${formatBytes(att.size)}）`}
    >
      {body}
    </a>
  );
}

/** Image grid (click → lightbox) + file chips. */
export function Attachments({ list }: { list: Attachment[] | undefined }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!list || list.length === 0) return null;
  const images = list.filter((a) => isInlineImage(a.mime) && attachmentHref(a.url));
  const files = list.filter((a) => !images.includes(a));
  const cur = open === null ? undefined : images[open];
  const step = (d: number) => setOpen((i) => (i === null ? i : (i + d + images.length) % images.length));
  return (
    <div className="mt-2 flex flex-col gap-2">
      {images.length > 0 ? (
        <div className={cn("grid max-w-[520px] gap-1.5", images.length === 1 ? "grid-cols-1" : images.length === 2 || images.length === 4 ? "grid-cols-2" : "grid-cols-3")}>
          {images.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={cn("att-thumb", images.length === 1 ? "aspect-[16/10] max-h-[320px]" : "aspect-square")}
              onClick={() => setOpen(i)}
              aria-label={`查看图片 ${a.name}`}
            >
              <img src={attachmentHref(a.url)!} alt={a.name} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {files.map((a) => (
            <FileChip key={a.id} att={a} />
          ))}
        </div>
      ) : null}
      <Dialog
        open={!!cur}
        onOpenChange={(o) => !o && setOpen(null)}
        title={cur?.name ?? "图片"}
        description={cur ? `${formatBytes(cur.size)}${images.length > 1 ? ` · 第 ${open! + 1} / ${images.length} 张` : ""}` : undefined}
        wide
        footer={
          cur ? (
            <>
              {images.length > 1 ? (
                <>
                  <button className="btn btn-secondary" onClick={() => step(-1)} aria-label="上一张">
                    <ChevronLeft size={16} aria-hidden /> 上一张
                  </button>
                  <button className="btn btn-secondary" onClick={() => step(1)} aria-label="下一张">
                    下一张 <ChevronRight size={16} aria-hidden />
                  </button>
                </>
              ) : null}
              <a className="btn btn-primary" href={attachmentHref(cur.url)!} download={cur.name} target="_blank" rel="noopener noreferrer">
                <Download size={16} aria-hidden /> 下载
              </a>
            </>
          ) : null
        }
      >
        {cur ? (
          <div
            className="flex justify-center"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") step(-1);
              if (e.key === "ArrowRight") step(1);
            }}
          >
            <img src={attachmentHref(cur.url)!} alt={cur.name} className="max-h-[65dvh] w-auto max-w-full rounded-[12px] object-contain" />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
