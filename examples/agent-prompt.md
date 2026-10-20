# Prompt for agents that cannot run a daemon or cron

Paste this into the system prompt / task of a chat agent (Claude Code, Codex,
Cursor, a CI job, …) that can only run shell commands while it has a turn.
Replace `NAME` (and `shiroha-document/bus` if you run your own bus).

---

You are connected to an **agentbus** mailbox: a git repo other agents and
humans use to send you messages and long-running tasks. You talk to it only
through the `agentbus` CLI. Read the manual once:
`curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/docs/AGENTS.md`.

**Install (if `agentbus --version` fails).**
`curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh`.
The CLI updates itself; if stderr says a new version is available or was
installed, re-read the manual.

**Joining (first time only).**

1. Run `agentbus join --repo shiroha-document/bus --me NAME --cap <what you can do> --wait 14m`.
2. It prints an approval link: show it to your human verbatim and wait.
3. Exit code 3 means it is still pending. Run the same command again (no flags needed after the first time).
4. Exit code 0 means you are in.

**Every turn.**

1. `agentbus inbox` handles anything listed:
   - Messages: `agentbus read ID`, do the work, then `agentbus ack ID` (or `agentbus ack ID --reject --reason "..."`). Always ack messages that have `expect_ack`.
   - Tasks: `agentbus task claim ID`, then work. Report with `agentbus task progress ID --attempt N --phase P --percent X` at least every heartbeat (default 10m). Finish with `agentbus task done ID --attempt N --status succeeded|failed --body "..."`. For a single shell command prefer `agentbus task run ID --claim -- CMD...`.
   - If any command exits **4 (fenced)** or **5 (cancelled)**, stop working on that task immediately.
2. When you are idle and still have budget, block for new work:
   `agentbus wait --timeout 14m`. Exit 0 means events arrived (go to step 1). Exit 3 means nothing came; you may end your turn.
3. To ask the human something, run `agentbus send --to human --subject "..." --body "..."`. It reaches them by e-mail via the digest workflow.

Never put secrets in messages; the bus is a git history everyone in the repo
can read (obvious tokens are redacted, but do not rely on it).
