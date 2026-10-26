import { t, getLanguage, type Language } from "./i18n";
// The bundled CHANGELOG.md (repo root), imported as text at build time (contract §6).
import raw from "../../../../CHANGELOG.md?raw";
import { parseChangelog, stripTitle, type ChangelogEntry } from "./version";

export const CHANGELOG_MD: string = raw;
export const CHANGELOG_BODY: string = stripTitle(raw);
export const CHANGELOG: ChangelogEntry[] = parseChangelog(raw);

/** Version order and Chinese source remain intact; the selected display body is localized. */
export function getChangelog(language: Language = getLanguage()): { body: string; entries: ChangelogEntry[] } {
  const content = t("changelog.content", [], language);
  return { body: stripTitle(content), entries: parseChangelog(content) };
}
