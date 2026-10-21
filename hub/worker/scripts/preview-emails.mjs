#!/usr/bin/env node
// Preview the notification emails without a server:
//   node hub/worker/scripts/preview-emails.mjs [--no-shots]
//
// 1. bundles src/email.ts in-memory with the esbuild that ships with the worker toolchain;
// 2. renders every kind (single + merged, with a team) to /tmp/email-preview/*.html, with
//    EMAIL_ASSET_BASE pointing at the local PNGs (file:///…/docs-site/public/email);
// 3. screenshots each file with Playwright (from hub/e2e): desktop 700px / mobile 375px,
//    light and dark colour scheme → /tmp/email-preview/*.png.
// Pages are opened from file:// and every non-file request is aborted: no network, no server.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..");
const hub = resolve(worker, "..");
const repo = resolve(hub, "..");
const OUT = process.env.EMAIL_PREVIEW_DIR ?? "/tmp/email-preview";
const ASSETS = pathToFileURL(join(repo, "docs-site", "public", "email")).href;
const shots = !process.argv.includes("--no-shots");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

// ---- load email.ts -------------------------------------------------------------------------
const pnpm = join(hub, "node_modules", ".pnpm");
const esbuildDir = readdirSync(pnpm).find((d) => /^esbuild@\d/.test(d));
if (!esbuildDir) throw new Error("esbuild not found under hub/node_modules/.pnpm (run pnpm install in hub/)");
const esbuild = createRequire(join(pnpm, esbuildDir, "node_modules", "esbuild", "package.json"))("esbuild");
const built = await esbuild.build({
  entryPoints: [join(worker, "src", "email.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
await esbuild.stop(); // its long-lived service process otherwise upsets Chromium's pipe transport
const mod = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const { renderEmail, KIND_LABELS } = mod;

// ---- sample data ---------------------------------------------------------------------------
const env = { PUBLIC_URL: "https://hub.example.com", EMAIL_ASSET_BASE: ASSETS };
const team = { id: "tm_01hzexample", name: "星河研发组" };
const S = {
  join_request: [
    { title: "代码审查助手（@reviewer）申请加入", text: "CLI：claude · 唤醒：cron / 300s · 主人：alice@example.com · 机器：mbp-alice", link: "/members/m_rev" },
    { title: "夜班值守（@night-ops）申请加入", text: "CLI：codex · 唤醒：trigger / 600s · 主人：未填 · 机器：ops-box-02", link: "/members/m_ops" },
  ],
  confirm_request: [
    { title: "builder 请求确认：发布 v2.3 到生产环境", text: "准备执行 `wrangler deploy --env production`，会影响所有用户。\n回滚方案：保留上一版本，可一键回退。", link: "/threads/t_rel" },
    { title: "migrator 请求确认：删除 30 天前的日志表", text: "DROP TABLE logs_2026_09；预计释放 12 GB。", link: "/threads/t_db" },
  ],
  agent_offline: [
    { title: "文档机器人（@docs）离线", text: "已经 47 分钟没有任何请求（醒来间隔 300s）。", link: "/members/m_docs" },
    { title: "测试跑手（@tester）离线", text: "已经 92 分钟没有任何请求（醒来间隔 600s）。", link: "/members/m_test" },
  ],
  agent_unresponsive: [
    { title: "代码审查助手（@reviewer）没有回应", text: "讨论串「登录页改版」里的 @ 超过 3 个醒来间隔仍未处理。", link: "/threads/t_login" },
    { title: "builder（@builder）没有回应", text: "讨论串「CI 变慢排查」里的 @ 超过 3 个醒来间隔仍未处理。", link: "/threads/t_ci" },
  ],
  delivery_dead: [
    { title: "@reviewer 的一条消息重试 5 次仍未处理", text: "最后原因：adapter exited with code 137 (OOM killed)", link: "/threads/t_login" },
    { title: "@tester 的一条消息重试 5 次仍未处理", text: "最后原因：context deadline exceeded", link: "/threads/t_ci" },
  ],
  quota_paused: [
    { title: "builder（@builder）已暂停", text: "budget:daily_tokens 2000000/2000000，预计 2026-10-22 00:00 UTC 恢复", link: "/members/m_b" },
    { title: "代码审查助手（@reviewer）已暂停", text: "quota:5h 98%，预计 2026-10-21 18:30 UTC 恢复", link: "/members/m_rev" },
  ],
  flood_blocked: [
    { title: "刷屏拦截：登录页改版", text: "@reviewer ↔ @builder 一小时内来回超过 20 次，已暂停这个讨论串的自动投递。", link: "/threads/t_login" },
    { title: "刷屏拦截：周报草稿", text: "@docs ↔ @writer 一小时内来回超过 20 次，已暂停这个讨论串的自动投递。", link: "/threads/t_weekly" },
  ],
  secret_redacted: [
    { title: "builder 的帖子里扫描到密钥（openai-key, aws-key）", text: "已打码后入库，原文未保存。建议立即轮换相关凭据。", link: "/threads/t_rel" },
    { title: "tester 的帖子里扫描到密钥（github-pat）", text: "已打码后入库，原文未保存。建议立即轮换相关凭据。", link: "/threads/t_ci" },
  ],
  run_failures: [
    { title: "@tester 连续 3 轮运行失败", text: "exit 1：npm ERR! Missing script: \"e2e\"\nexit 1：npm ERR! Missing script: \"e2e\"\nexit 2：permission denied: ./run.sh", link: "/members/m_test" },
    { title: "@docs 连续 3 轮运行失败", text: "exit 127：claude: command not found\nexit 127：claude: command not found\nexit 127：claude: command not found", link: "/members/m_docs" },
  ],
  email_change: [
    { title: "确认 agentbus 通知邮箱", text: "有人（应该是你）在 agentbus hub 上把通知邮箱改成了这个地址。30 分钟内点下面的链接确认；不是你操作的话忽略即可。", link: "https://hub.example.com/api/v1/web/settings/email/confirm?token=Zk3x9Qp_example" },
  ],
  invite: [
    { title: "alice 邀请你加入「星河研发组」", text: "「一起来调教我们的 agent 吧～」", link: "https://hub.example.com/invite/inv_example123" },
  ],
  test: [
    { title: "agentbus 测试邮件", text: "如果你收到了这封邮件，说明 hub 的邮件通知是通的。（2026-10-21T08:00:00.000Z）", link: "/settings" },
  ],
  some_future_kind: [
    { title: "一种模板里还没有的新通知", text: "这里应当使用通用设计。", link: "/threads/t_x" },
    { title: "第二条", link: "/members/m_x" },
  ],
};

mkdirSync(OUT, { recursive: true });
const pages = [];
for (const [kind, items] of Object.entries(S)) {
  if (only && kind !== only) continue;
  const variants = items.length > 1 ? [["single", items.slice(0, 1)], ["merged", items]] : [["single", items]];
  for (const [v, its] of variants) {
    const r = renderEmail(env, kind, its, { team });
    const name = `${kind}-${v}`;
    writeFileSync(join(OUT, `${name}.html`), r.html);
    writeFileSync(join(OUT, `${name}.txt`), `Subject: ${r.subject}\n\n${r.text}`);
    pages.push({ name, html: r.html });
  }
}
console.log(`rendered ${pages.length} emails → ${OUT} (${Object.keys(KIND_LABELS).length} known kinds)`);
if (!shots) process.exit(0);

// ---- screenshots ---------------------------------------------------------------------------
const { chromium } = createRequire(join(hub, "e2e", "package.json"))("@playwright/test");
// Headless Chromium occasionally dies on small/no-swap boxes; launch lean, relaunch per view
// and retry a page once with a fresh browser if the target goes away.
const launch = () => chromium.launch({ args: ["--disable-gpu", "--disable-dev-shm-usage"] });
const views = [
  { tag: "desktop-light", width: 700, scheme: "light" },
  { tag: "desktop-dark", width: 700, scheme: "dark" },
  { tag: "mobile-light", width: 375, scheme: "light" },
  { tag: "mobile-dark", width: 375, scheme: "dark" },
];
async function openView(vw) {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: vw.width, height: 800 }, deviceScaleFactor: 1, colorScheme: vw.scheme });
  // Block anything that isn't a local file / data URL, so previews never touch the network.
  await ctx.route((url) => !/^(file|data|about):/.test(url.href), (r) => r.abort());
  return { browser, page: await ctx.newPage() };
}
for (const vw of views) {
  let s = await openView(vw);
  for (const p of pages) {
    const shoot = async () => {
      // Open the rendered file:// page (not setContent) so file:// images are allowed to load.
      await s.page.goto(pathToFileURL(join(OUT, `${p.name}.html`)).href, { waitUntil: "load" });
      await s.page.screenshot({ path: join(OUT, `${p.name}.${vw.tag}.png`), fullPage: true });
    };
    try {
      await shoot();
    } catch (e) {
      console.warn(`retrying ${p.name}.${vw.tag}: ${String(e.message).split("\n")[0]}`);
      await s.browser.close().catch(() => {});
      s = await openView(vw);
      await shoot();
    }
  }
  await s.browser.close();
}
console.log(`screenshots: ${pages.length * views.length} → ${OUT}`);
