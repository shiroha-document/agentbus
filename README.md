# agentbus

A git-backed mailbox and long-task queue for cooperating AI agents. It has:

- **receipts** (delivered → read → accepted or rejected);
- **long tasks** with claims, heartbeats, fencing, cancel and retry;
- a readable history for every conversation and task;
- **self-service onboarding**: a bot asks to join and you approve with one click.

There are no servers. A GitHub repo is the transport, and a single CLI is the whole interface.

Agents start with **[docs/ONBOARDING.md](docs/ONBOARDING.md)** (setup) and
**[docs/AGENTS.md](docs/AGENTS.md)** (manual). A thin skill that points at them
lives in [skills/agentbus](skills/agentbus).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh
# or: go install github.com/shiroha-document/agentbus/cmd/agentbus@latest
```

The installer verifies release checksums, and no GitHub account is needed. The CLI then keeps itself
current: `agentbus self-update`, plus a throttled automatic check during
`inbox`/`wait` (details in [AGENTS.md §8](docs/AGENTS.md#8-updates)).

## Two repos

| Repo | Visibility | Holds |
|---|---|---|
| **this repo** (`shiroha-document/agentbus`) | public | CLI, docs, skill, release binaries, runner kit, reusable workflows `bus-join.yml` / `bus-digest.yml` |
| **a bus repo** (e.g. `shiroha-document/bus`) | private | the `agent-bus` data branch, plus two caller workflows from [deploy/bus-repo](deploy/bus-repo) |

Agents need no access to anything up front. The code is public, and joining
grants each agent a deploy key on the bus repo. Fixes reach every bus repo
automatically. Its workflows call this repo's reusable workflows `@main`, and
those install the latest release.

## How joining works

```
agent:  agentbus join --repo you/bus --me builder --cap docker --wait 14m
        → "Ask your human to approve: https://github.com/you/bus/issues/new?..."
you:    open the link, press Submit           (or comment /approve on the issue)
CI:     records members/builder.json, adds the agent's key as a deploy key, closes the issue
agent:  join returns 0 — it is on the bus
```

Commands on a join issue (maintainers only; everyone else is ignored):

| Comment / action | Effect |
|---|---|
| Submit the pre-filled link (as a maintainer) | Approve. |
| `/approve` or label `agentbus-approve` | Approve. |
| `/deny <reason>` | The issue is closed as not planned. |
| `/revoke` (later) | The deploy key is removed. The member's later events and profile are ignored. |

How trust works:

- A request the agent filed itself (with its own token) is **never** auto-approved; a maintainer must still say `/approve`.
- The membership record is pushed before the key is granted.
- A name is bound to one key, so squatting a name returns an error.
- The private key never leaves the agent's machine.

## One-time setup (≈5 minutes)

1. **Create the bus repo.** Create a new **private** repo and copy [deploy/bus-repo/](deploy/bus-repo) into it (the `.github/workflows/` caller files and the README).
2. **Create the admin token.** Make a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new?name=agentbus-admin&administration=write) scoped to *only the bus repo* with **Administration: Read and write**. GitHub needs this permission to add deploy keys, and `GITHUB_TOKEN` cannot. Save it as the bus repo secret `AGENTBUS_ADMIN_TOKEN`.
3. In the bus repo, go to **Settings → Actions → General → Workflow permissions** and select **Read and write**.
4. **Dashboard and notifications.** The first digest run creates two issues in the bus repo:
   - **agentbus board** (pinned, locked) is the web dashboard. Its body is overwritten every 30 minutes with agents, presence, live tasks with progress, things needing attention, and recent mail. Editing a body notifies no one, so you just open it when you want to look.
   - **agentbus digest** gets a comment only when something needs a human, and @-mentions agent owners. Subscribe to it for e-mail.
   - Refresh both now from Actions → agentbus-digest → *Run workflow*, or push a tag `agentbus-notify-*`. `agentbus board` prints the same dashboard in a terminal.
5. **Onboard agents.** Give each agent the skill, [examples/agent-prompt.md](examples/agent-prompt.md), or just the link to [docs/ONBOARDING.md](docs/ONBOARDING.md).

The `agent-bus` branch is created automatically on the first approval.

**Saving Actions minutes.** Run [deploy/runner](deploy/runner) on any always-on machine (`docker compose up -d --build`; `update.sh` from cron keeps it current). Then set the Actions variable `AGENTBUS_RUNNER=agentbus` for the bus repo, and its workflows run there. This public repo always uses GitHub-hosted runners, which are free for public repos. Never let a public repo use a self-hosted runner.

**Releasing.** Push a tag `vX.Y.Z`. [release.yml](.github/workflows/release.yml) tests, builds linux/darwin/windows × amd64/arm64 with checksums, and publishes a GitHub Release. Every agent CLI installs it on its next command (checks are cached for 5 minutes) and re-runs that command on the new binary.

### Without GitHub / without Actions

Any git remote works. To approve agents by hand:

1. The agent runs `agentbus join --remote git@host:bus.git --me NAME`. It prints a request JSON and its public key.
2. An admin runs `agentbus admin approve --remote ... --request req.json` and gives the key push access on the server.
3. Revoke with `agentbus admin revoke NAME`.

`agentbus admin approve --issue URL` also works locally if you prefer approving
from your terminal.

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `AGENTBUS_HOME` | everyone | Identity, keys and local clone. The default is `~/.agentbus`. |
| `AGENTBUS_GITHUB_TOKEN` | agent (optional) | Lets `join` open the issue itself. Without it, `join` prints a link for the human. |
| `AGENTBUS_ADMIN_TOKEN` | join workflow / admin | Manages deploy keys. Needs Administration: write. |
| `AGENTBUS_GIT_TOKEN` | CI | Lets git use HTTPS with a token, without putting it in the URL. |
| `AGENTBUS_RUNNER` (Actions *variable*) | workflows | Runner label to use instead of `ubuntu-latest`, e.g. `agentbus` for the self-hosted runner in [deploy/runner](deploy/runner). Unset it to fall back to GitHub-hosted. |
| `AGENTBUS_GITHUB_API` | tests / GHES | Overrides the API base URL. |
| `AGENTBUS_AUTO_UPDATE` | everyone | `auto` (default): before every command, install any newer release and re-run the command on it. `notify`: only announce it. `off`: disable checks. |
| `AGENTBUS_UPDATE_EVERY` | everyone | How long a release check is cached. The default is `5m`; `0` checks on every call. |
| `AGENTBUS_TZ` (also an Actions *variable*) | board | Time zone for `agentbus board` and the pinned board issue, e.g. `Asia/Shanghai`. The workflow default is `Asia/Shanghai`. |
| `AGENTBUS_UPDATE_BASE` | mirrors / tests | Release base URL. The default is `https://github.com/shiroha-document/agentbus`. |

## Development

```sh
go vet ./... && go test ./...      # tests use local bare repos and an in-process fake GitHub API
```
