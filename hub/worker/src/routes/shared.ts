// Workspace logic shared by the web (admin) and manage (manager) routers.
import type { Env, Me } from "../env";
import { DB, WORKSPACE_SELECT, threadOut, workspaceOut } from "../db";
import { notify } from "../notify";
import { redact } from "../redact";
import { bad, newId, notFound } from "../util";

type Body = Record<string, unknown>;

const MAX_BRIEF = 32_000;

function clean(b: Body, partial: boolean) {
  const out: Record<string, string | null> = {};
  const kinds = new Set<string>();
  const text = (k: string, max: number, required: boolean) => {
    if (!(k in b)) {
      if (required && !partial) throw bad(`需要 ${k}`);
      return;
    }
    const v = b[k];
    if (v !== null && typeof v !== "string") throw bad(`${k} 必须是字符串`);
    const s = (v ?? "").trim();
    if (required && !s) throw bad(`${k} 不能为空`);
    if (s.length > max) throw bad(`${k} 超过 ${max} 个字符`);
    const r = redact(s);
    r.kinds.forEach((x) => kinds.add(x));
    out[k] = r.text;
  };
  text("name", 80, true);
  text("goal", 2000, false);
  text("brief", MAX_BRIEF, false);
  for (const k of ["repo", "branch"] as const) {
    if (!(k in b)) continue;
    const v = b[k];
    if (v === null || v === "") {
      out[k] = null;
      continue;
    }
    if (typeof v !== "string") throw bad(`${k} 必须是字符串`);
    const s = v.trim();
    if (k === "repo" && (s.length > 300 || !/^[A-Za-z0-9._:/@~+-]+$/.test(s))) throw bad("repo 格式不对（例如 owner/name 或 https 地址）");
    if (k === "branch" && (s.length > 200 || !/^[A-Za-z0-9._/+-]+$/.test(s))) throw bad("branch 格式不对");
    if (/:\/\/[^/]*@/.test(s)) throw bad("repo 地址里不能带凭据");
    out[k] = s;
  }
  if ("status" in b) {
    if (b.status !== "active" && b.status !== "archived") throw bad("status 只能是 active 或 archived");
    out.status = b.status;
  }
  return { fields: out, kinds: [...kinds] };
}

function redactNotice(db: DB, me: Me, id: string, kinds: string[]) {
  return notify(db, "secret_redacted", {
    title: `${me.name} 编辑工作区时扫描到密钥（${kinds.join(", ")}）`,
    text: "已打码后保存。建议立即轮换相关凭据。",
    link: `/workspaces/${id}`,
  });
}

async function loadWorkspace(db: DB, id: string) {
  const w = await db.first(`${WORKSPACE_SELECT} WHERE w.id = ? AND w.team_id = ?`, id, db.team);
  if (!w) throw notFound("工作区");
  return workspaceOut(w);
}

export async function createWorkspace(env: Env, me: Me, b: Body) {
  const db = new DB(env.DB, me.team_id);
  const { fields: f, kinds } = clean(b, false);
  if (f.status) throw bad("新建时不能指定 status");
  const now = Date.now();
  const id = newId("w", now);
  const stmts = [
    db.stmt(
      "INSERT INTO workspaces (id, team_id, name, goal, repo, branch, brief, status, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
      id,
      me.team_id,
      f.name!,
      f.goal ?? "",
      f.repo ?? null,
      f.branch ?? null,
      f.brief ?? "",
      me.id,
      now,
      now,
    ),
    db.audit(me.id, "workspace.create", id, { name: f.name }),
    db.bumpSeq(),
  ];
  if (kinds.length) stmts.push(redactNotice(db, me, id, kinds));
  await db.batch(stmts);
  return loadWorkspace(db, id);
}

export async function updateWorkspace(env: Env, me: Me, id: string, b: Body) {
  const db = new DB(env.DB, me.team_id);
  await loadWorkspace(db, id);
  const { fields: f, kinds } = clean(b, true);
  const keys = Object.keys(f);
  if (!keys.length) return loadWorkspace(db, id);
  const now = Date.now();
  const stmts = [
    db.stmt(
      `UPDATE workspaces SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_by = ?, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => f[k]),
      me.id,
      now,
      id,
    ),
    db.audit(me.id, "workspace.update", id, { fields: keys }),
    db.bumpSeq(),
  ];
  if (kinds.length) stmts.push(redactNotice(db, me, id, kinds));
  await db.batch(stmts);
  return loadWorkspace(db, id);
}

export async function workspaceDetail(db: DB, id: string) {
  const workspace = await loadWorkspace(db, id);
  const rows = await db.all(
    "SELECT * FROM threads WHERE workspace_id = ? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, COALESCE(last_post_at, created_at) DESC LIMIT 500",
    id,
  );
  return { workspace, threads: rows.map(threadOut) };
}
