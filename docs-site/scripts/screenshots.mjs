#!/usr/bin/env node
// Screenshots of the hub web UI for the README and the docs site.
//
// No server is started: the SPA is built in mock mode (VITE_MOCK=1, in-memory API) and
// served to headless Chromium through page.route() from the build directory, under the
// fake origin https://hub.test. Nothing listens on a port.
//
// Usage (from the repo root or anywhere):
//   export PATH=$HOME/.npm-global/bin:$PATH
//   node docs-site/scripts/screenshots.mjs            # build + capture (light and dark)
//   node docs-site/scripts/screenshots.mjs --no-build # reuse an existing /tmp/web-mock
//   node docs-site/scripts/screenshots.mjs --light    # light mode only
//
// Env:
//   WEB_MOCK_DIR   build output dir (default /tmp/web-mock)
//   PLAYWRIGHT     path to the playwright package (default hub/e2e's copy)
//
// Output: docs-site/public/screenshots/<name>-<light|dark>.png at 1440x900 @2x.
// Idempotent: every run rebuilds and overwrites the same files. If ImageMagick
// (`convert`) is on PATH the PNGs are stripped and recompressed losslessly.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const webDir = join(repo, "hub/web");
const outDir = process.env.WEB_MOCK_DIR || "/tmp/web-mock";
const shotDir = join(repo, "docs-site/public/screenshots");
const args = new Set(process.argv.slice(2));
const ORIGIN = "https://hub.test";

const pages = [
  { name: "home", path: "/", ready: "main" },
  { name: "thread", path: "/threads/t_inbox", ready: "main" },
  { name: "members", path: "/members", ready: "main" },
  { name: "usage", path: "/usage", ready: "main" },
  { name: "settings", path: "/settings", ready: "main" },
];
const schemes = args.has("--light") ? ["light"] : ["light", "dark"];

// ---------------------------------------------------------------- 1. build
if (!args.has("--no-build")) {
  console.log(`building hub/web in mock mode -> ${outDir}`);
  execFileSync("pnpm", ["-s", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: webDir,
    env: { ...process.env, VITE_MOCK: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
if (!existsSync(join(outDir, "index.html"))) {
  console.error(`no ${outDir}/index.html; run without --no-build`);
  process.exit(1);
}

// ---------------------------------------------------------------- 2. playwright
const require = createRequire(import.meta.url);
const pwPath =
  process.env.PLAYWRIGHT ||
  [
    join(repo, "hub/e2e/node_modules/playwright"),
    join(repo, "hub/e2e/node_modules/@playwright/test"),
  ].find((p) => existsSync(p));
if (!pwPath) {
  console.error("playwright not found; run `pnpm install` in hub/ first (or set PLAYWRIGHT)");
  process.exit(1);
}
const { chromium } = require(pwPath);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function fileFor(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const p = join(outDir, rel);
  if (p.startsWith(outDir) && existsSync(p) && statSync(p).isFile()) return p;
  return join(outDir, "index.html"); // SPA fallback
}

mkdirSync(shotDir, { recursive: true });
const written = [];

// One short-lived browser per shot. Headless Chromium occasionally hits a renderer/GPU
// CHECK on these backdrop-filter heavy pages at 2x, sometimes taking the whole browser
// down, so each attempt is fully isolated and retried.
async function capture(p, scheme, file) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    await ctx.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort(); // never touch the real network
      const f = fileFor(url.pathname);
      await route.fulfill({
        status: 200,
        headers: { "content-type": types[extname(f)] || "application/octet-stream" },
        body: readFileSync(f),
      });
    });
    const page = await ctx.newPage();
    await page.goto(ORIGIN + p.path, { waitUntil: "load" });
    await page.waitForSelector(p.ready, { timeout: 15000 });
    // mock API answers after 120-300 ms; let lazy routes, charts and rings settle
    await page.waitForTimeout(1800);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: file, animations: "disabled" });
  } finally {
    await browser.close().catch(() => {});
  }
}

for (const scheme of schemes) {
  for (const p of pages) {
    const file = join(shotDir, `${p.name}-${scheme}.png`);
    for (let attempt = 1; ; attempt++) {
      try {
        await capture(p, scheme, file);
        break;
      } catch (err) {
        if (attempt >= 8) throw err;
        console.log(`  ${p.name}-${scheme}: retry ${attempt} (${String(err.message).split("\n")[0]})`);
      }
    }
    written.push(file);
    console.log(`  ${p.name}-${scheme}.png`);
  }
}

// ---------------------------------------------------------------- 3. optimize (lossless)
const hasConvert = spawnSync("convert", ["-version"], { stdio: "ignore" }).status === 0;
if (hasConvert) {
  for (const f of written) {
    const tmp = f + ".tmp.png";
    // -quality 95 = zlib level 9 + adaptive filtering; -strip drops metadata
    const r = spawnSync("convert", [f, "-strip", "-define", "png:compression-level=9", "-quality", "95", tmp]);
    if (r.status === 0 && existsSync(tmp) && statSync(tmp).size < statSync(f).size) renameSync(tmp, f);
    else if (existsSync(tmp)) spawnSync("rm", ["-f", tmp]);
  }
}
console.log(`wrote ${written.length} screenshots to ${shotDir}`);
