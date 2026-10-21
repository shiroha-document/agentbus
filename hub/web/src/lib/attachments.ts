// Attachment helpers (contract §4): ≤ 6 files per post, ≤ 10 MB each.
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type MimeGroup = "image" | "text" | "pdf" | "archive" | "other";

const ARCHIVE = /(zip|x-tar|gzip|x-7z|x-rar|x-bzip|x-xz|compressed)/;
const TEXTISH = /^(application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|sql)|text\/)/;

export function mimeGroup(mime: string, name = ""): MimeGroup {
  const m = (mime || "").toLowerCase();
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (ARCHIVE.test(m) || ["zip", "tar", "gz", "tgz", "7z", "rar", "xz", "bz2"].includes(ext)) return "archive";
  if (TEXTISH.test(m) || ["md", "txt", "log", "json", "yaml", "yml", "csv", "ts", "tsx", "js", "go", "py", "rs", "sh", "toml", "diff", "patch"].includes(ext))
    return "text";
  return "other";
}

/** Images the hub serves inline (contract §4) — SVG never is. */
export function isInlineImage(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/i.test(mime);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Split picked files into accepted ones and Chinese error messages, given how many are
 * already attached.
 */
export function validateFiles<T extends { name: string; size: number }>(files: readonly T[], existing: number): { ok: T[]; errors: string[] } {
  const ok: T[] = [];
  const errors: string[] = [];
  let tooMany = 0;
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`「${f.name}」超过 10 MB，无法上传`);
      continue;
    }
    if (f.size === 0) {
      errors.push(`「${f.name}」是空文件`);
      continue;
    }
    if (existing + ok.length >= MAX_ATTACHMENTS) {
      tooMany++;
      continue;
    }
    ok.push(f);
  }
  if (tooMany) errors.push(`每条消息最多 ${MAX_ATTACHMENTS} 个附件，已忽略 ${tooMany} 个`);
  return { ok, errors };
}

const SAFE_DATA_URL = /^data:(image\/(png|jpeg|gif|webp)(;base64)?|text\/plain(;charset=utf-8)?(;base64)?),/i;

/**
 * Attachment URL safe to put in href/src: the hub's relative `/api/v1/web/files/<id>`,
 * http(s), or (mock / previews) a raster-image or plain-text data URL. Anything else → null.
 */
export function attachmentHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^blob:/i.test(u)) return u;
  if (SAFE_DATA_URL.test(u)) return u;
  return null;
}
