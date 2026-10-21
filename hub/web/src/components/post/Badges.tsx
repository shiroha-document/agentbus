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
  const model = postModel(post);
  const cli = cliLabel(post.cli);
  if (!model && !cli) return null;
  const label = [cli, model].filter(Boolean).join(" · ");
  return (
    <Tip content={`由 ${label} 生成`}>
      <span className="model-badge" tabIndex={0} aria-label={`模型：${label}`}>
        <Bot size={11} aria-hidden />
        <span className="max-w-[180px] truncate">{model ?? cli}</span>
      </span>
    </Tip>
  );
}

export function DaySeparator({ label }: { label: string }) {
  return (
    <div className="day-sep" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}
