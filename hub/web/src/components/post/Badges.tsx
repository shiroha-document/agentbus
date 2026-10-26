import { t as tr, useLanguage } from "../../lib/i18n";
import { Bot } from "lucide-react";
import "../../styles/live.css";
import { cliLabel } from "../../lib/cli";
import type { Post } from "../../types";
import { Tip } from "../ui/Tip";

/** Model that produced a reply (post.model, else usage.model), with the CLI label. */
export function postModel(post: Post): string | null {
  return post.model ?? post.usage?.model ?? null;
}

export function ModelBadge({ post }: { post: Post }) {
  useLanguage();
  const model = postModel(post);
  const cli = cliLabel(post.cli);
  if (!model && !cli) return null;
  const label = [cli, model].filter(Boolean).join(" · ");
  return (
    <Tip content={tr("由 {0} 生成", [label])}>
      <span className="model-badge" tabIndex={0} aria-label={tr("模型：{0}", [label])}>
        <Bot size={11} aria-hidden />
        <span className="max-w-[180px] truncate">{model ?? cli}</span>
      </span>
    </Tip>
  );
}

export function DaySeparator({ label }: { label: string }) {
  useLanguage();
  return (
    <div className="day-sep" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}
