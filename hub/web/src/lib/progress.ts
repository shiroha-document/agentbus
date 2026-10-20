// Parses progress posts into the four canonical sections (ui-guidelines §7):
// 要做什么 / 改了什么 / 怎么验证 / 下一步. Accepts markdown headings ("## 改了什么"),
// bold labels ("**改了什么**"), or "改了什么：..." lines. Returns null when fewer than
// two sections are found, so the caller can fall back to plain markdown.

export const PROGRESS_SECTIONS = ["要做什么", "改了什么", "怎么验证", "下一步"] as const;
export type ProgressSectionName = (typeof PROGRESS_SECTIONS)[number];

export interface ProgressSection {
  name: ProgressSectionName;
  body: string;
}

export interface ParsedProgress {
  preamble: string;
  sections: ProgressSection[];
}

const ALIASES: Record<string, ProgressSectionName> = {
  要做什么: "要做什么",
  目标: "要做什么",
  改了什么: "改了什么",
  做了什么: "改了什么",
  变更: "改了什么",
  怎么验证: "怎么验证",
  如何验证: "怎么验证",
  验证: "怎么验证",
  下一步: "下一步",
  后续: "下一步",
};

const HEADER_RE =
  /^\s{0,3}(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?\s*(要做什么|目标|改了什么|做了什么|变更|怎么验证|如何验证|验证|下一步|后续)\s*(?:\*\*|__)?\s*(?:[:：]\s*(?:\*\*|__)?\s*(.*))?$/;

export function parseProgress(body: string): ParsedProgress | null {
  const lines = body.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: { name: ProgressSectionName; lines: string[] }[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADER_RE.exec(line);
    if (m) {
      const name = ALIASES[m[1] ?? ""];
      if (name) {
        sections.push({ name, lines: m[2] ? [m[2]] : [] });
        continue;
      }
    }
    const cur = sections[sections.length - 1];
    if (cur) cur.lines.push(line);
    else preamble.push(line);
  }
  // Merge duplicates (keep first occurrence order).
  const merged: ProgressSection[] = [];
  for (const s of sections) {
    const existing = merged.find((x) => x.name === s.name);
    const text = s.lines.join("\n").trim();
    if (existing) existing.body = [existing.body, text].filter(Boolean).join("\n\n");
    else merged.push({ name: s.name, body: text });
  }
  if (merged.length < 2) return null;
  return { preamble: preamble.join("\n").trim(), sections: merged };
}
