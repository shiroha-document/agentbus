import { useRef, useState } from "react";
import { CornerUpLeft, Send, X } from "lucide-react";
import { api } from "../api";
import { qk, useAction } from "../queries";
import { extractMentions } from "../lib/mentions";
import { track } from "../lib/telemetry";
import type { Member, Post } from "../types";
import { toast } from "./ui/Toast";
import { AttachButton, AttachmentTray, DropHint, RichEditor, SEND_HINT, useDropZone } from "./composer/RichEditor";
import { useAttachments } from "./composer/useAttachments";

interface Props {
  threadId: string;
  members: Member[];
  replyTo: Post | null;
  replyAuthor?: Member;
  onClearReply: () => void;
  onSent?: (p: Post) => void;
  disabled?: boolean;
}

export function Composer({ threadId, members, replyTo, replyAuthor, onClearReply, onSent, disabled }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachments = useAttachments();
  const drop = useDropZone(attachments, disabled);

  const send = useAction(
    () =>
      api.createPost({
        thread_id: threadId,
        body: text.trim(),
        reply_to: replyTo?.id,
        ...(attachments.ids.length ? { attachments: attachments.ids } : {}),
      }),
    { invalidate: [qk.thread(threadId), qk.feed, qk.dashboard] },
  );

  const canSend = !!text.trim() && !send.isPending && !disabled && !attachments.uploading;

  const submit = () => {
    if (!canSend) {
      if (attachments.uploading && text.trim()) toast("附件还在上传，稍等一下再发送", "info");
      return;
    }
    const nAtt = attachments.ids.length;
    const nMentions = extractMentions(text).length;
    const reply = !!replyTo;
    send.mutate(undefined, {
      onSuccess: (r) => {
        track("post.create", { surface: "thread", attachments: nAtt, mentions: nMentions, reply });
        setText("");
        attachments.clear();
        onClearReply();
        if (r.redacted?.length) toast(`发送内容里的密钥已自动打码：${r.redacted.join("、")}`, "info", 6000);
        onSent?.(r.post);
      },
    });
  };

  return (
    <div className="glass-3 relative rounded-[24px] p-3" {...drop.handlers}>
      <DropHint show={drop.dragging} />
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
      <RichEditor
        value={text}
        onChange={setText}
        members={members}
        attachments={attachments}
        onSubmit={submit}
        disabled={disabled}
        textareaRef={ref}
        placeholder={disabled ? "讨论串已关闭" : "写点什么… 用 @ 提及成员，可粘贴或拖入图片和文件"}
        ariaLabel="回复内容"
        className="max-h-[40vh] min-h-[84px]"
      />
      <AttachmentTray attachments={attachments} />
      <div className="flex items-center gap-2 px-1 pt-1">
        <AttachButton attachments={attachments} disabled={disabled} />
        <span className="hidden text-caption text-fg-caption sm:inline">Markdown · {SEND_HINT}</span>
        <button className="btn btn-primary btn-lg ml-auto sm:h-9" disabled={!canSend} onClick={submit}>
          <Send size={16} aria-hidden />
          {send.isPending ? "发送中…" : attachments.uploading ? "上传中…" : "发送"}
        </button>
      </div>
    </div>
  );
}
