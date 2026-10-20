import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Lock } from "lucide-react";
import { splitMentions, splitRedactions } from "../lib/mentions";
import { safeUrl } from "../lib/sanitize";

// Minimal hast shapes (avoid depending on @types/hast directly).
interface HText {
  type: "text";
  value: string;
}
interface HElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HNode[];
}
interface HOther {
  type: string;
  children?: HNode[];
}
type HNode = HText | HElement | HOther;

const SKIP_TAGS = new Set(["code", "pre", "a"]);

function splitText(value: string, names: ReadonlySet<string> | undefined): HNode[] {
  const out: HNode[] = [];
  for (const r of splitRedactions(value)) {
    if (r.type === "redacted") {
      out.push({
        type: "element",
        tagName: "span",
        properties: { dataRedacted: r.label },
        children: [{ type: "text", value: r.label }],
      });
      continue;
    }
    for (const s of splitMentions(r.text, names)) {
      if (s.type === "text") out.push({ type: "text", value: s.text });
      else
        out.push({
          type: "element",
          tagName: "span",
          properties: { dataMention: s.name, dataKnown: s.known ? "1" : "0" },
          children: [{ type: "text", value: `@${s.name}` }],
        });
    }
  }
  return out;
}

function walk(node: HNode, names: ReadonlySet<string> | undefined): void {
  if (!("children" in node) || !node.children) return;
  if (node.type === "element" && SKIP_TAGS.has((node as HElement).tagName)) return;
  const next: HNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") next.push(...splitText((child as HText).value, names));
    else {
      walk(child, names);
      next.push(child);
    }
  }
  node.children = next;
}

/** rehype plugin: turns @mentions and [已打码:x] markers in text into tagged spans. */
function rehypeMentions(options: { names?: ReadonlySet<string> }) {
  return (tree: HNode) => walk(tree, options.names);
}

const components: Components = {
  a: ({ href, children }) => {
    const url = safeUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const url = typeof src === "string" ? safeUrl(src) : null;
    if (!url || !url.startsWith("https://")) return <span>{alt ? `[图片：${alt}]` : "[图片]"}</span>;
    return <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
  },
  span: ({ node: _node, children, ...props }) => {
    const p = props as Record<string, unknown>;
    if (typeof p["data-redacted"] === "string") {
      return (
        <span className="redacted" title="此处密钥已被服务端打码">
          <Lock size={12} aria-hidden />
          已打码:{String(p["data-redacted"])}
        </span>
      );
    }
    if (typeof p["data-mention"] === "string") {
      return <span className={p["data-known"] === "1" ? "mention" : "mention mention-unknown"}>{children}</span>;
    }
    return <span>{children}</span>;
  },
};

function MarkdownImpl({ children, names, className }: { children: string; names?: ReadonlySet<string>; className?: string }) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeMentions, { names }]]}
        components={components}
        skipHtml
        urlTransform={(url) => safeUrl(url) ?? ""}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
export default Markdown;
