/* agentbus hub service worker — installable PWA + offline app shell.
 *
 * Deliberately tiny and conservative:
 *   - /api/*, /healthz, non-GET and cross-origin requests are never touched (always live, never cached).
 *   - Page navigations are network-first; the last good HTML shell is kept so the app still opens
 *     offline. Redirects (e.g. Cloudflare Access sending you to log in) are passed through untouched
 *     and never cached.
 *   - /assets/* are content-hashed and immutable: cache-first, capped so old builds age out.
 */
const SHELL = "agentbus-shell-v1";
const ASSETS = "agentbus-assets-v1";
const KEEP = [SHELL, ASSETS];
const MAX_ASSETS = 80;
const STATIC = ["/favicon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/manifest.webmanifest", "/manifest.zh.webmanifest", "/theme-init.js"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

function cacheable(res) {
  return res && res.ok && res.type === "basic" && !res.redirected;
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    if (cacheable(res) && (res.headers.get("content-type") || "").includes("text/html")) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put("/", copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const shell = await caches.match("/", { cacheName: SHELL });
    if (shell) return shell;
    throw err;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request, { cacheName: ASSETS });
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) {
    const copy = res.clone();
    caches
      .open(ASSETS)
      .then(async (c) => {
        await c.put(request, copy);
        await trim(c);
      })
      .catch(() => {});
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  const live = fetch(request)
    .then((res) => {
      if (cacheable(res)) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => hit);
  return hit || live;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/api/") || p === "/healthz" || p === "/sw.js") return;
  if (req.mode === "navigate") return event.respondWith(navigate(req));
  if (p.startsWith("/assets/")) return event.respondWith(cacheFirst(req));
  if (STATIC.includes(p)) return event.respondWith(staleWhileRevalidate(req));
});
