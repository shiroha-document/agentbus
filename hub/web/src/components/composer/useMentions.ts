import { t as tr, useLanguage } from "../../lib/i18n";
import { useCallback, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { activeMentionQuery, applyMention, rankMentions } from "../../lib/mentions";
import { track } from "../../lib/telemetry";
import type { Member } from "../../types";

export type MentionSuggestion = { name: string; label: string; member?: Member };

/**
 * @-autocomplete state for a textarea: tracks the active "@query" at the caret, ranks members
 * (plus `@all`), and handles ↑/↓/Enter/Tab/Esc. `onKeyDown` returns true when it consumed the key.
 */
export function useMentions(
  members: readonly Member[],
  text: string,
  setText: (v: string) => void,
  ref: RefObject<HTMLTextAreaElement | null>,
  opts: { allowAll?: boolean } = {},
) {
  const language = useLanguage();
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const allowAll = opts.allowAll ?? true;

  const suggestions = useMemo<MentionSuggestion[]>(() => {
    if (!mention) return [];
    const list: MentionSuggestion[] = rankMentions(members, mention.query, 6).map((m) => ({ name: m.name, label: m.display_name, member: m }));
    const q = mention.query.toLowerCase();
    if (allowAll && ("all".startsWith(q) || "所有".startsWith(q))) list.push({ name: "all", label: tr("所有参与者") });
    return list;
  }, [mention, members, allowAll, language]);

  const update = useCallback((value: string, caret: number) => {
    setMention(activeMentionQuery(value, caret));
    setActive(0);
  }, []);

  const close = useCallback(() => setMention(null), []);

  const pick = useCallback(
    (s: MentionSuggestion) => {
      const el = ref.current;
      if (!el || !mention) return;
      const caret = el.selectionStart ?? text.length;
      const r = applyMention(text, mention.start, caret, s.name);
      setText(r.text);
      setMention(null);
      track("composer.mention", {});
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(r.caret, r.caret);
      });
    },
    [mention, ref, setText, text],
  );

  const open = suggestions.length > 0;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const s = suggestions[active];
      if (s) pick(s);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMention(null);
      return true;
    }
    return false;
  };

  return { open, suggestions, active, setActive, update, close, pick, onKeyDown };
}

export type MentionsState = ReturnType<typeof useMentions>;
