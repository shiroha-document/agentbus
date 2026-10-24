#!/usr/bin/env python3
"""Scan the agentbus CLI for newly added user-facing English literals.

The first batch of zh/en work covered the output sites listed in
docs/cli-i18n-notes.md. This helper flags print-style calls in cmd/ whose
English literal is not wrapped in i18n.Pick, so reviewers do not regress the
coverage. It is a heuristic, not a type checker:

  * only cmd/ is scanned (internal/ packages keep searchable English
    diagnostics; the CLI boundary translates the common ones);
  * JSON keys/values, flag help and command syntax are intentionally English;
  * lines containing i18n.Pick are skipped;
  * matches are grouped by file; exit 2 only when run with --strict and at
    least one candidate is found, so CI can adopt it deliberately after the
    allowlist (false positives) is reviewed.

Usage: scripts/check-cli-i18n.py [--strict]
"""
import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]

# fmt.Print*/Fprint*/Println with a double-quoted literal as the format/first
# argument (the leading text is what a human sees).
PRINT_RE = re.compile(
    r"""(?:fmt\.)?(?:Fprint(?:f|ln)?|Print(?:f|ln)?)\s*\([^)]*?"([A-Za-z][^"\\]*(?:\\.[^"\\]*)*)""")

# literals that are structural by nature, not prose
ALLOW_SUBSTR = (
    "\t",            # table header cells are scanned separately below
    "%s\\n",         # bare template lines without words are rare; allow "\n" etc.
)
HEADER_RE = re.compile(r"\\t")


def literals_in(text: str):
    for m in PRINT_RE.finditer(text):
        yield m.group(1), m.start()


def main() -> int:
    strict = "--strict" in sys.argv[1:]
    findings = []
    for p in sorted((ROOT / "cmd").rglob("*.go")):
        if p.name.endswith("_test.go"):
            continue
        lines = p.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines, 1):
            if "i18n.Pick" in line or "i18n." in line:
                continue
            if not re.search(r"(fmt\.)?(F?Print(f|ln)?)\s*\(", line):
                continue
            for lit, _ in literals_in(line):
                words = re.findall(r"[A-Za-z]{2,}", lit)
                if len(words) < 2:
                    continue
                # allow table-header lines handled elsewhere / pure format
                if HEADER_RE.search(lit) and " " not in lit.strip():
                    continue
                findings.append((p.relative_to_root() if hasattr(p, "relative_to_root") else p.relative_to(ROOT), i, lit.strip()))
    if findings:
        print("possible untranslated user-facing literals in cmd/:")
        for f, i, lit in findings:
            print(f"  {f}:{i}: {lit[:80]}")
        print(f"\n{len(findings)} candidate(s); wrap in i18n.Pick(en, zh) or justify in the PR.")
        return 2 if strict else 0
    print("no untranslated print literals found in cmd/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
