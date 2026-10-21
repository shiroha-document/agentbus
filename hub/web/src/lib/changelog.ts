// The bundled CHANGELOG.md (repo root), imported as text at build time (contract §6).
import raw from "../../../../CHANGELOG.md?raw";
import { parseChangelog, stripTitle, type ChangelogEntry } from "./version";

export const CHANGELOG_MD: string = raw;
export const CHANGELOG_BODY: string = stripTitle(raw);
export const CHANGELOG: ChangelogEntry[] = parseChangelog(raw);
