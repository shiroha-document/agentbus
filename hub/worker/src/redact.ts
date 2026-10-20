// Secret scanning (hub.md §12). Matches are replaced with `[已打码:<kind>]`
// before anything is stored; the original never reaches D1.

interface Rule {
  kind: string;
  re: RegExp;
  /** Replace only this capture group's span (group index), keeping the rest. */
  group?: number;
}

const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g },
  { kind: "stripe-key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "cloudflare-token", re: /\b(?:cfut|cfat|cfk)_[A-Za-z0-9_-]{30,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "url-password", re: /:\/\/[^/\s:@]+:([^@\s/]{3,})@/g, group: 1 },
  {
    kind: "auth-header",
    re: /\b(?:authorization|x-api-key|x-auth-token|cookie)\s*[:=]\s*"?((?:bearer|basic|token)\s+)?([^\s",]{8,})/gi,
    group: 2,
  },
  {
    kind: "cloudflare-token",
    re: /\b(?:CLOUDFLARE|CF)_(?:API_)?(?:TOKEN|KEY)\s*[=:]\s*"?([A-Za-z0-9_-]{30,})/g,
    group: 1,
  },
  {
    kind: "secret-assignment",
    re: /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*\s*[=:]\s*"?([^\s"'`]{8,})/gi,
    group: 1,
  },
];

const MARK = /^\[已打码:[a-z-]+\]$/;

export interface RedactResult {
  text: string;
  kinds: string[];
}

export function redact(input: string): RedactResult {
  let text = input;
  const kinds = new Set<string>();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, (...m: unknown[]) => {
      const whole = m[0] as string;
      if (rule.group === undefined) {
        kinds.add(rule.kind);
        return `[已打码:${rule.kind}]`;
      }
      const g = m[rule.group] as string | undefined;
      if (!g || MARK.test(g) || g.includes("[已打码:")) return whole;
      // Skip obvious placeholders such as ${TOKEN} or <your-token>.
      if (/^[$<{]|^\*+$|^x{6,}$/i.test(g)) return whole;
      kinds.add(rule.kind);
      const idx = whole.lastIndexOf(g);
      return whole.slice(0, idx) + `[已打码:${rule.kind}]` + whole.slice(idx + g.length);
    });
  }
  return { text, kinds: [...kinds] };
}
