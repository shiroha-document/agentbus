import DOMPurify from "dompurify";

/** Allow only http(s), mailto, in-app absolute paths and fragments. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = url.trim();
  if (u.startsWith("#")) return u;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  if (/^(https?:|mailto:)/i.test(u)) return u;
  return null;
}

/**
 * Sanitize a search snippet. The server may wrap hits in <mark>/<b>; everything else is
 * stripped. The result is safe for dangerouslySetInnerHTML.
 */
export function sanitizeSnippet(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["mark", "b", "em"], ALLOWED_ATTR: [] });
}
