// @mention tokenizer — used by the post renderer and the composer.
// Member names follow ^[a-z0-9][a-z0-9_-]{1,31}$; `@all` addresses every participant.

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; name: string; known: boolean };

const MENTION_RE = /(^|[^A-Za-z0-9_@.-])@([a-z0-9][a-z0-9_-]{1,31})(?![A-Za-z0-9_-])/g;

/**
 * Split text into plain/mention segments. A mention must be preceded by start or a
 * non-word character (so emails like a@b.com are not matched). `known` is true when the
 * name is in `names` or is "all".
 */
export function splitMentions(text: string, names?: ReadonlySet<string>): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    const lead = m[1] ?? "";
    const name = m[2] ?? "";
    const start = m.index + lead.length;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "mention", name, known: name === "all" || (names ? names.has(name) : true) });
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export function extractMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const s of splitMentions(text)) if (s.type === "mention") seen.add(s.name);
  return [...seen];
}

/**
 * Detect an in-progress "@query" right before the caret, for autocomplete.
 * Returns the query (possibly empty) and the index of the "@" or null.
 */
export function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  // The query may also be part of a display name (uppercase / CJK), e.g. "@陈" or "@Claude".
  const m = /(^|[^A-Za-z0-9_@.-])@([\p{L}\p{N}_-]{0,32})$/u.exec(before);
  if (!m) return null;
  const query = m[2] ?? "";
  return { query, start: caret - query.length - 1 };
}

export interface MentionCandidate {
  name: string;
  display_name: string;
  kind?: string;
  status?: string;
}

/**
 * Rank members for the "@query" popup: exact name > name prefix > display-name prefix >
 * substring (name or display name). Agents before humans on ties, then by name. Only
 * active members are offered.
 */
export function rankMentions<T extends MentionCandidate>(members: readonly T[], query: string, limit = 6): T[] {
  const q = query.toLowerCase();
  const score = (m: T): number => {
    const n = m.name.toLowerCase();
    const d = m.display_name.toLowerCase();
    if (!q) return 1;
    if (n === q) return 4;
    if (n.startsWith(q)) return 3;
    if (d.startsWith(q)) return 2;
    if (n.includes(q) || d.includes(q)) return 1;
    return 0;
  };
  return members
    .filter((m) => (m.status ?? "active") === "active")
    .map((m) => ({ m, s: score(m) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(b.m.kind === "agent") - Number(a.m.kind === "agent") || a.m.name.localeCompare(b.m.name))
    .slice(0, limit)
    .map((x) => x.m);
}

/** Replace the active "@query" with "@name " and return the new text and caret. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

/** Redaction markers inserted by the server: [已打码:github-pat]. */
export const REDACTION_RE = /\[已打码:([A-Za-z0-9_.-]+)\]/g;

export type RedactionSegment = { type: "text"; text: string } | { type: "redacted"; label: string };

export function splitRedactions(text: string): RedactionSegment[] {
  const out: RedactionSegment[] = [];
  let last = 0;
  REDACTION_RE.lastIndex = 0;
  for (let m = REDACTION_RE.exec(text); m; m = REDACTION_RE.exec(text)) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "redacted", label: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
