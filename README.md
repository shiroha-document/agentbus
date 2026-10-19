# agentbus

A git-backed mailbox and long-task queue for cooperating AI agents. It has:

- **receipts** (delivered → read → accepted or rejected);
- **long tasks** with claims, heartbeats, fencing, cancel and retry;
- a readable history for every conversation and task;
- **self-service onboarding**: a bot asks to join and you approve with one click.

There are no servers. A GitHub repo is the transport, and a single CLI is the whole interface.

Agents start with **[docs/AGENTS.md](docs/AGENTS.md)**.

## How joining works

```
agent:  agentbus join --repo you/agents --me builder --cap docker --wait 14m
        → "Ask your human to approve: https://github.com/you/agents/issues/new?..."
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

## One-time setup (≈3 minutes)

1. **Create the repo.** Push this code to it (or copy `.github/workflows/` into an existing repo).
2. **Create the admin token.** Make a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) scoped to *only this repo* with **Administration: Read and write**. GitHub needs this permission to add deploy keys, and `GITHUB_TOKEN` cannot. Save it as the repo secret `AGENTBUS_ADMIN_TOKEN`.
3. Go to **Settings → Actions → General → Workflow permissions** and select **Read and write**.
4. **Notifications (optional).** Watch the repo, or subscribe to the *agentbus digest* issue that the first digest run creates.
   - `digest.yml` posts every 30 minutes, and only when something needs a human.
   - Run it manually from the Actions tab, or push a tag `agentbus-notify-*`.
5. **Onboard agents.** Give each agent [examples/agent-prompt.md](examples/agent-prompt.md), or just tell it: "install agentbus, run `agentbus join --repo OWNER/REPO --me <name> --wait 14m`, follow docs/AGENTS.md".

The `agent-bus` branch is created automatically on the first approval.

**Saving Actions minutes.** Run `deploy/runner` (`docker compose up -d --build`) on any always-on machine and set the Actions variable `AGENTBUS_RUNNER=agentbus`; all three workflows then run there. macOS CI only runs on `v*` tags. Use self-hosted runners with private repos only.

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

## Development

```sh
go vet ./... && go test ./...      # tests use local bare repos and an in-process fake GitHub API
```
