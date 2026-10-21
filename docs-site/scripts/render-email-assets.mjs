#!/usr/bin/env node
// Render the notification-email artwork (docs-site/email-src/*.svg) to @2x PNGs in
// docs-site/public/email/ — email clients (Gmail, Outlook) don't render SVG.
//
//   node docs-site/scripts/render-email-assets.mjs
//
// Needs: Playwright from hub/e2e (chromium headless shell in ~/.cache/ms-playwright) and
// python3 + Pillow for palette quantisation (keeps every PNG well under 60 KB).
// No network access, no servers: each SVG is inlined with page.setContent.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const SRC = join(root, "docs-site", "email-src");
const OUT = join(root, "docs-site", "public", "email");
const SCALE = 2;

const require = createRequire(join(root, "hub", "e2e", "package.json"));
const { chromium } = require("@playwright/test");

const files = readdirSync(SRC).filter((f) => f.endsWith(".svg")).sort();
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: SCALE });
const written = [];
for (const f of files) {
  const svg = readFileSync(join(SRC, f), "utf8");
  const w = Number(/width="(\d+)"/.exec(svg)?.[1]);
  const h = Number(/height="(\d+)"/.exec(svg)?.[1]);
  if (!w || !h) throw new Error(`${f}: root <svg> needs width/height`);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`,
  );
  const out = join(OUT, f.replace(/\.svg$/, ".png"));
  await page.locator("svg").first().screenshot({ path: out, omitBackground: true });
  written.push(out);
}
await browser.close();

// Palette-quantise (RGBA-aware) — the artwork is flat, so small palettes are visually lossless.
const py = `
import sys
from PIL import Image
for p in sys.argv[1:]:
    im = Image.open(p).convert("RGBA")
    icon = "/icon-" in p
    # Heroes have soft halos: 256 colours + dithering avoids visible banding rings.
    q = im.quantize(colors=64 if icon else 256, method=Image.Quantize.FASTOCTREE,
                    dither=Image.Dither.NONE if icon else Image.Dither.FLOYDSTEINBERG)
    q.save(p, optimize=True)
`;
execFileSync("python3", ["-c", py, ...written], { stdio: "inherit" });

let total = 0;
for (const p of written) {
  const kb = statSync(p).size / 1024;
  total += kb;
  console.log(`${p.slice(root.length + 1).padEnd(52)} ${kb.toFixed(1).padStart(6)} KB`);
  if (kb > 60) console.warn(`  ! over 60 KB budget`);
}
console.log(`${written.length} files, ${total.toFixed(1)} KB total`);
