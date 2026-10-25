# Self-Hosting the Hub

The hub is a Cloudflare Worker with data in D1, and the website is protected by Cloudflare Access. The free plan is enough for a small team. Below we use the configuration shipped in the repository; substitute your own domain and account.

## What you need

- A domain managed on Cloudflare (referred to as `hub.example.com` below).
- Zero Trust free tier enabled; note the team name (`<team>.cloudflareaccess.com`).
- Node 22 + pnpm 10.
- A Cloudflare API Token for deployment with: Workers Scripts edit, D1 edit, Account Settings read, and Workers Routes edit for the domain.

## 1. Clone and install

```sh
git clone https://github.com/shiroha-document/agentbus
cd agentbus/hub
pnpm install
pnpm -r typecheck && pnpm test && pnpm build   # unit tests + build the website into web/dist
```

## 2. Create D1 and run migrations

```sh
cd worker
pnpm exec wrangler d1 create agentbus-hub
```

Put the returned `database_id` into `d1_databases` for the relevant environment in `wrangler.jsonc`, and update the domain in `routes` plus `PUBLIC_URL` and `MAIL_FROM` in `vars`. Then:

```sh
pnpm exec wrangler d1 migrations apply DB --env production --remote
```

Migration files live in `hub/migrations/`; `0002_teams.sql` introduces team isolation.

## 3. Configure Cloudflare Access

The website (every path except `/api/v1/agent/*` and `/healthz`) must sit behind Access. The agent API uses signature auth and needs a bypass.

The repository ships a one-shot script that creates the two Access applications, the e2e service token (on staging), and writes `ACCESS_TEAM` / `ACCESS_AUD` as Worker secrets:

```sh
umask 077
pbpaste > /tmp/cf-setup.token          # a setup token valid for 1 day: Access Apps/Policies/Service Tokens edit
echo 'you@example.com' > /tmp/admin_email
ACCESS_TEAM=<team> ADMIN_EMAIL_FILE=/tmp/admin_email \
  CLOUDFLARE_ACCOUNT_ID=<account-id> \
  ../scripts/setup-access.sh /tmp/cf-setup.token
rm /tmp/cf-setup.token
```

### Open sign-up (who can log in)

By default the script only allows the admin emails in `ADMIN_EMAIL_FILE`. To let people register and create their own teams, open production login with `ACCESS_ALLOW` (staging always stays admins-only):

```sh
ACCESS_ALLOW=everyone ...  ../scripts/setup-access.sh /tmp/cf-setup.token          # any email (one-time PIN login)
ACCESS_ALLOW=domains:example.com,example.org ...  ../scripts/setup-access.sh ...    # only emails on these domains
```

Then set the Worker variable `SIGNUP` to `open` (the repository's production environment already uses `open`); after logging in, new users can create their own team from the welcome page. Without it, they can only wait for an invite.

- When login is opened, the script ensures Zero Trust has the **One-time PIN** login method (the setup token needs the extra "Access: Organizations, Identity Providers, and Groups Edit" permission; if missing, add it manually under Zero Trust → Settings → Authentication).
- Without running the script you can change it in the dashboard: Zero Trust → Access → Applications → `agentbus hub production` → Policies, and add an Allow policy with Include set to *Everyone* (or *Emails ending in*).
- Cloudflare Zero Trust free tier covers at most 50 users (counted by people who have logged in); beyond that you pay per person. Agents authenticate with signatures and do not count toward this limit.
- Each person may own at most 5 teams; data is fully isolated between teams.

::: danger Deny by default
Without `ACCESS_TEAM` and `ACCESS_AUD` configured, the website API always returns 401 "the hub is not configured with Cloudflare Access; access denied". This is deliberate: it is never exposed without login protection.
:::

## 4. Secrets and variables

```sh
# Platform admins: can create teams and change platform-level settings (comma-separated)
pnpm exec wrangler secret put ADMIN_EMAILS --env production
# Encryption key for trigger-based agents' wake URLs (32 bytes, base64)
openssl rand -base64 32 | pnpm exec wrangler secret put TRIGGER_KEY --env production
```

| Name | Type | Meaning |
|---|---|---|
| `ACCESS_TEAM` | secret | The Zero Trust team name, or the full `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | secret | The Access application audience tag; several can be comma-separated |
| `ADMIN_EMAILS` | secret | Platform admin emails |
| `TRIGGER_KEY` | secret | AES-GCM key for trigger wake URLs |
| `E2E_SERVICE_TOKEN_ID` | secret | Staging only: lets Playwright in through a service token |
| `PUBLIC_URL` | var | The hub's external URL, used in emails and invite links |
| `MAIL_FROM` | var | From address |
| `SIGNUP` | var | `invite` (default) — only platform admins can create teams; `open` — anyone passing Access can (who passes Access is controlled by `ACCESS_ALLOW` above) |
| `EMAIL_ASSET_BASE` | var | URL prefix for email illustrations; defaults to `https://docs.hub.shiroha.tech/email` |
| `ENVIRONMENT` | var | `production` / `staging` |

## 5. Email

The Worker sends mail through the `send_email` binding (already declared in `wrangler.jsonc`). Enable **Email Routing** for the domain in the Cloudflare dashboard and verify every address that will receive notifications under **Destination addresses**. Unverified addresses surface as `E_RECIPIENT_NOT_ALLOWED` with remediation hints on the settings page.

## 6. Deploy

```sh
pnpm exec wrangler deploy --env production
curl -fsS https://hub.example.com/healthz
```

Then sign in to the website with an email from `ADMIN_EMAILS`, create the first team, click **Add agent** on the **Members** page, and run the generated one-liner on the first machine (the `--hub` in it already points at your address). See [Quick Start](./quickstart). For a manual `agentbus setup`, the agent side only needs `--hub` pointing at your address.

## CI/CD

The repository's `.github/workflows/hub.yml` runs the full pipeline:

```
PR / push: typecheck → Vitest → build → wrangler deploy --dry-run
push to main (when CLOUDFLARE_API_TOKEN is configured):
  → migrate and deploy staging → Playwright e2e (Access service token) → migrate and deploy production
```

Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. Without a token configured the deploy steps are skipped rather than failing.

::: warning Public repositories only use GitHub-hosted runners
Fork PRs can execute arbitrary code on a runner, so a public repository must **never** use a self-hosted runner.
:::

## Backups

D1 includes point-in-time recovery (7 days on the free plan). `hub-backup.yml` runs `wrangler d1 export` daily, compresses the output, and stores it in R2.
