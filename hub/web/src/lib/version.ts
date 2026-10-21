// Version + changelog helpers (contract §6).

export const SEEN_VERSION_KEY = "agentbus.seen_version";
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** Compares x.y.z[-pre] versions. Pre-releases sort before their release. Unparseable → 0 parts. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([\w.]+))?/.exec(v.trim());
    if (!m) return { nums: [0, 0, 0], pre: "" };
    return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? "" };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** "新" dot: the running version is newer than the last one whose changelog the user opened. */
export function hasUnseenVersion(current: string, seen: string | null | undefined): boolean {
  if (!seen) return true;
  return compareVersions(current, seen) > 0;
}

export interface ChangelogEntry {
  version: string;
  date: string | null;
  /** Markdown body below the heading (without the heading itself). */
  body: string;
}

/** Splits a Keep-a-Changelog file on `## vX.Y.Z — date` headings (newest first, as written). */
export function parseChangelog(md: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  const buf: string[] = [];
  const close = () => {
    if (cur) {
      cur.body = buf.join("\n").trim();
      out.push(cur);
    }
    buf.length = 0;
  };
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+\[?v?(\d+\.\d+\.\d+[\w.-]*)\]?\s*(?:[—–-]+\s*(.+))?\s*$/.exec(line);
    if (m) {
      close();
      cur = { version: m[1]!, date: m[2]?.trim() || null, body: "" };
      continue;
    }
    if (cur) buf.push(line);
  }
  close();
  return out;
}

/** The changelog without its top-level `# 更新日志` title (the dialog has its own). */
export function stripTitle(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n+/, "");
}

/** First few bullet lines of an entry, for the About page excerpt. */
export function excerpt(body: string, maxLines = 6): string {
  const lines = body.split("\n").filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || /^###\s+/.test(l));
  return lines.slice(0, maxLines).join("\n");
}
