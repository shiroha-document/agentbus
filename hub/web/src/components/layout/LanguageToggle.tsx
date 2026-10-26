import { Languages } from "lucide-react";
import { setLanguage, t, useLanguage, type Language } from "../../lib/i18n";

/** Available before sign-in and in browser preferences. Switching preserves page state. */
export function LanguageToggle() {
  const language = useLanguage();
  const choices: readonly Language[] = ["zh", "en"];
  return (
    <div role="radiogroup" aria-label={t("language.label")} className="inline-flex items-center gap-1 rounded-[12px] bg-mint-100/60 p-1">
      <Languages size={16} className="mx-1 text-fg-2" aria-hidden />
      {choices.map((choice) => (
        <button key={choice} type="button" role="radio" aria-checked={language === choice} data-language={choice}
          tabIndex={language === choice ? 0 : -1}
          onClick={() => setLanguage(choice)}
          onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              const next = language === "zh" ? "en" : "zh";
              setLanguage(next);
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-language="${next}"]`)?.focus();
            }
          }}
          className={`min-h-8 rounded-[9px] px-2 text-caption transition-colors ${language === choice ? "bg-surface-solid text-fg shadow-1" : "text-fg-2 hover:text-fg"}`}>
          {t(choice === "zh" ? "language.chinese" : "language.english")}
        </button>
      ))}
    </div>
  );
}
