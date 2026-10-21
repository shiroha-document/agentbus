// Attachments in R2 (v06-contract §4).
import type { Context } from "hono";
import type { AppEnv, Me } from "./env";
import { DB, attachmentOut, qmarks, type UrlBase } from "./db";
import { HttpError, bad, newId, notFound } from "./util";

export const MAX_ATTACHMENTS = 6;
const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Strip path parts and control chars from a client file name; ≤ 200 chars. */
export function sanitizeFileName(raw: string | undefined | null): string {
  let s = raw ?? "";
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as sent */
  }
  s = s.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (s === "." || s === "..") s = "";
  return s.slice(0, 200) || "file";
}

function cleanMime(ct: string | undefined): string {
  const m = (ct ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(m) && m.length <= 100 ? m : "application/octet-stream";
}

function bucket(c: Context<AppEnv>): R2Bucket {
  if (!c.env.FILES) throw new HttpError(503, "unavailable", "hub 未配置附件存储（R2）");
  return c.env.FILES;
}

/** POST /web/uploads, /agent/uploads → { attachment }. */
export async function handleUpload(c: Context<AppEnv>, base: UrlBase) {
  const me = c.get("me");
  if (!me.team_id) throw notFound("团队");
  const bytes = c.get("rawBytes");
  if (!bytes || !bytes.byteLength) throw bad("附件内容为空");
  const files = bucket(c);
  const db = new DB(c.env.DB, me.team_id);
  const now = Date.now();
  const id = newId("f", now);
  const key = `${me.team_id}/${id}`;
  const name = sanitizeFileName(c.req.header("x-file-name"));
  const mime = cleanMime(c.req.header("content-type"));
  await files.put(key, bytes, { httpMetadata: { contentType: mime } });
  const row = { id, team_id: me.team_id, uploader_id: me.id, r2_key: key, name, mime, size: bytes.byteLength, created_at: now };
  try {
    await db.run(
      "INSERT INTO attachments (id, team_id, uploader_id, post_id, r2_key, name, mime, size, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)",
      id,
      me.team_id,
      me.id,
      key,
      name,
      mime,
      row.size,
      now,
    );
  } catch (e) {
    await files.delete(key).catch(() => {});
    throw e;
  }
  return c.json({ attachment: attachmentOut(row, base) });
}

/** GET /web/files/:id, /agent/files/:id — team-scoped download. */
export async function handleDownload(c: Context<AppEnv>) {
  const me = c.get("me");
  const id = c.req.param("id") ?? "";
  const row = me.team_id
    ? await new DB(c.env.DB, me.team_id).first<{ r2_key: string; name: string; mime: string; size: number }>(
        "SELECT r2_key, name, mime, size FROM attachments WHERE id = ? AND team_id = ?",
        id,
        me.team_id,
      )
    : null;
  if (!row) throw notFound("附件");
  const obj = await bucket(c).get(row.r2_key);
  if (!obj) throw notFound("附件");
  const inline = INLINE_MIME.has(row.mime);
  const headers = new Headers({
    "content-type": inline ? row.mime : "application/octet-stream",
    "content-disposition": inline ? "inline" : `attachment; filename*=UTF-8''${encodeRFC5987(row.name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=86400",
    "content-length": String(row.size),
  });
  return new Response(obj.body, { status: 200, headers });
}

function encodeRFC5987(s: string) {
  return encodeURIComponent(s).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}

/** Validate attachment ids for a new post; returns the clean id list. */
export async function checkAttachments(db: DB, me: Me, ids: unknown): Promise<string[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw bad("attachments 必须是附件 id 数组");
  const list = [...new Set(ids as string[])];
  if (list.length > MAX_ATTACHMENTS) throw bad(`每条帖子最多 ${MAX_ATTACHMENTS} 个附件`);
  if (!list.length) return [];
  const rows = await db.all<{ id: string; post_id: string | null }>(
    `SELECT id, post_id FROM attachments WHERE id IN (${qmarks(list.length)}) AND team_id = ?`,
    ...list,
    me.team_id,
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of list) {
    const r = found.get(id);
    if (!r) throw bad(`附件 ${id} 不存在`);
    if (r.post_id) throw bad(`附件 ${id} 已经用在别的帖子里了`);
  }
  return list;
}
