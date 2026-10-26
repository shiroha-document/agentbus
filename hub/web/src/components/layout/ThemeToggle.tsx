import { t as tr, useLanguage } from "../../lib/i18n";
// Header theme switcher: 浅色 / 深色 / 跟随系统 (radio menu).
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { THEME_LABEL, THEME_PREFS, useTheme, type ThemePref } from "../../lib/theme";
import { Tip } from "../ui/Tip";

export const THEME_ICON: Record<ThemePref, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

const itemCls =
  "flex min-h-9 cursor-pointer items-center gap-2 rounded-[10px] px-3 py-1.5 text-callout outline-none data-[highlighted]:bg-mint-100";

export function ThemeToggle() {
  useLanguage();
  const { pref, resolved, setPref } = useTheme();
  // The trigger shows what is on screen; "system" gets its own icon so the choice is visible.
  const Icon = pref === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
  return (
    <DropdownMenu.Root>
      <Tip content={tr("主题：{0}", [THEME_LABEL[pref]])}>
        <DropdownMenu.Trigger className="btn btn-ghost btn-icon h-9 w-9" aria-label={tr("切换主题（当前：{0}）", [THEME_LABEL[pref]])}>
          <Icon size={18} aria-hidden />
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="glass-3 z-50 min-w-[168px] rounded-[16px] p-1.5">
          <DropdownMenu.Label className="px-3 pb-1 pt-1.5 text-caption text-fg-caption">{tr("外观")}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
            {THEME_PREFS.map((p) => {
              const I = THEME_ICON[p];
              return (
                <DropdownMenu.RadioItem key={p} value={p} className={itemCls}>
                  <I size={16} className="text-fg-2" aria-hidden />
                  <span className="flex-1">{THEME_LABEL[p]}</span>
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} className="text-mint-700" aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Segmented control (Settings → 偏好). */
export function ThemeSegmented() {
  useLanguage();
  const { pref, setPref } = useTheme();
  return (
    <div role="radiogroup" aria-label={tr("外观主题")} className="inline-flex rounded-[12px] bg-mint-100/60 p-1">
      {THEME_PREFS.map((p) => {
        const I = THEME_ICON[p];
        const on = p === pref;
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setPref(p)}
            onKeyDown={(e) => {
              const i = THEME_PREFS.indexOf(pref);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                setPref(THEME_PREFS[(i + 1) % THEME_PREFS.length]!);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                setPref(THEME_PREFS[(i + THEME_PREFS.length - 1) % THEME_PREFS.length]!);
              }
            }}
            tabIndex={on ? 0 : -1}
            className={
              "flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-callout transition-colors " +
              (on ? "bg-surface-solid text-fg shadow-1" : "text-fg-2 hover:text-fg")
            }
          >
            <I size={15} aria-hidden />
            {THEME_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}
