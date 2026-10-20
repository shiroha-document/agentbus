import { useMemo, useRef, useState } from "react";
import { CornerUpLeft, Send, X } from "lucide-react";
import { api } from "../api";
import { qk, useAction } from "../queries";
import { activeMentionQuery, applyMention } from "../lib/mentions";
import { cn } from "../lib/util";
import type { Member, Post } from "../types";
import { Avatar } from "./ui/Avatar";
import { toast } from "./ui/Toast";

interface Props {
  threadId: string;
  members: Member[];
  replyTo: Post | null;
  replyAuthor?: Member;
  onClearReply: () => void;
  onSent?: (p: Post) => void;
  disabled?: boolean;
}

type Suggestion = { name: string; label: string; member?: Member };

export function Composer({ threadId, members, replyTo, replyAuthor, onClearReply, onSent, disabled }: Props) {
  const [text, setText] = useState("");
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const send = useAction(
    () => api.createPost({ thread_id: threadId, body: text.trim(), reply_to: replyTo?.id }),
    { invalidate: [qk.thread(threadId), qk.feed, qk.dashboard] },
  );

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const list: Suggestion[] = members
      .filter((m) => m.status === "active" && (m.name.startsWith(q) || m.display_name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 6)
      .map((m) => ({ name: m.name, label: m.display_name, member: m }));
    if ("all".startsWith(q)) list.push({ name: "all", label: "所有参与者" });
    return list;
  }, [mention, members]);

  const updateMention = (value: string, caret: number) => {
    setMention(activeMentionQuery(value, caret));
    setActive(0);
  };

  const pick = (s: Suggestion) => {
    const el = ref.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? text.length;
    const r = applyMention(text, mention.start, caret, s.name);
    setText(r.text);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  const submit = () => {
    if (!text.trim() || send.isPending || disabled) return;
    send.mutate(undefined, {
      onSuccess: (r) => {
        setText("");
        setMention(null);
        onClearReply();
        if (r.redacted?.length) toast(`发送内容里的密钥已自动打码：${r.redacted.join("、")}`, "info", 6000);
        onSent?.(r.post);
      },
    });
  };

  const open = suggestions.length > 0;

  return (
    <div className="glass-3 rounded-[24px] p-3">
      {replyTo ? (
        <div className="mb-2 flex items-center gap-2 rounded-[12px] bg-mint-50 px-3 py-1.5 text-caption text-fg-2">
          <CornerUpLeft size={12} aria-hidden />
          <span className="line-clamp-1 flex-1">
            回复 <span className="font-medium">{replyAuthor?.display_name ?? replyTo.author_id}</span>：{replyTo.body.slice(0, 120)}
          </span>
          <button className="btn btn-ghost h-6 min-h-0 w-6 px-0" onClick={onClearReply} aria-label="取消回复">
            <X size={14} />
          </button>
        </div>
      ) : null}
      <div className="relative">
        {open ? (
          <ul
            id="mention-list"
            role="listbox"
            aria-label="提及成员"
            className="glass-3 absolute bottom-full left-0 z-20 mb-2 w-72 max-w-full overflow-hidden rounded-[16px] p-1"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.name}
                id={`mention-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn(
                  "flex min-h-[40px] cursor-pointer items-center gap-2 rounded-[12px] px-2.5 text-callout",
                  i === active ? "bg-mint-100" : "",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {s.member ? (
                  <Avatar member={s.member} size={22} />
                ) : (
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-mint-200 text-caption">@</span>
                )}
                <span className="truncate">{s.label}</span>
                <span className="ml-auto text-caption text-fg-caption">@{s.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={ref}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => updateMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setMention(null)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => (a + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
                e.preventDefault();
                const s = suggestions[active];
                if (s) pick(s);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder={disabled ? "讨论串已关闭" : "写点什么… 用 @ 提及成员"}
          className="block max-h-[40vh] min-h-[84px] w-full resize-y bg-transparent px-2 py-1.5 text-body outline-none placeholder:text-fg-3"
          aria-label="回复内容"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? "mention-list" : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open ? `mention-opt-${active}` : undefined}
        />
      </div>
      <div className="flex items-center gap-2 px-1 pt-1">
        <span className="text-caption text-fg-caption">Markdown · {isMac ? "⌘" : "Ctrl"} + Enter 发送</span>
        <button className="btn btn-primary btn-lg ml-auto sm:h-9" disabled={!text.trim() || send.isPending || disabled} onClick={submit}>
          <Send size={16} aria-hidden />
          {send.isPending ? "发送中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
