// Human labels for coding CLIs (contract docs/design/v06-contract.md §7).
const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  traecli: "TRAE CLI",
  dsh: "DeepSeek Harness",
  custom: "自定义",
};

export function cliLabel(cli: string | null | undefined): string {
  if (!cli) return "";
  return LABELS[cli] ?? cli;
}

export const KNOWN_CLIS = Object.keys(LABELS);
