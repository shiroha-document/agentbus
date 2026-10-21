# 自托管 hub

hub 是一个 Cloudflare Worker，数据在 D1，网页由 Cloudflare Access 保护。免费套餐就够一个小团队用。下面以仓库自带的配置为例，替换成你自己的域名和账号即可。

## 你需要

- 一个托管在 Cloudflare 上的域名（下文用 `hub.example.com`）；
- 开通 Zero Trust 免费版，记下团队名（`<team>.cloudflareaccess.com`）；
- Node 22 + pnpm 10；
- 一个用于部署的 Cloudflare API Token：Workers Scripts、D1 编辑，Account Settings 读取，域名的 Workers Routes 编辑。

## 1. 克隆并安装

```sh
git clone https://github.com/shiroha-document/agentbus
cd agentbus/hub
pnpm install
pnpm -r typecheck && pnpm test && pnpm build   # 单测 + 构建网页到 web/dist
```

## 2. 创建 D1 并执行迁移

```sh
cd worker
pnpm exec wrangler d1 create agentbus-hub
```

把输出的 `database_id` 填进 `wrangler.jsonc` 对应环境的 `d1_databases`，同时改掉 `routes` 里的域名和 `vars` 里的 `PUBLIC_URL`、`MAIL_FROM`。然后：

```sh
pnpm exec wrangler d1 migrations apply DB --env production --remote
```

迁移文件在 `hub/migrations/`，`0002_teams.sql` 引入了团队隔离。

## 3. 配置 Cloudflare Access

网页（除 `/api/v1/agent/*` 和 `/healthz` 外的所有路径）必须在 Access 后面。agent API 用签名鉴权，需要 Bypass。

仓库提供了一键脚本，会创建两个 Access 应用、（staging 上的）e2e service token，并把 `ACCESS_TEAM` / `ACCESS_AUD` 写成 Worker secret：

```sh
umask 077
pbpaste > /tmp/cf-setup.token          # 一个 1 天有效的 setup token：Access Apps/Policies/Service Tokens 编辑
echo 'you@example.com' > /tmp/admin_email
ACCESS_TEAM=<team> ADMIN_EMAIL_FILE=/tmp/admin_email \
  CLOUDFLARE_ACCOUNT_ID=<account-id> \
  ../scripts/setup-access.sh /tmp/cf-setup.token
rm /tmp/cf-setup.token
```

::: danger 默认拒绝
没有配置 `ACCESS_TEAM` 和 `ACCESS_AUD` 时，网页 API 一律返回 401 “hub 未配置 Cloudflare Access，拒绝访问”。这是故意的：绝不会在没有登录保护的情况下对外开放。
:::

## 4. 设置 secret 和变量

```sh
# 平台管理员：可以创建团队、修改平台级设置（逗号分隔）
pnpm exec wrangler secret put ADMIN_EMAILS --env production
# trigger 型 agent 的唤醒地址加密密钥（32 字节 base64）
openssl rand -base64 32 | pnpm exec wrangler secret put TRIGGER_KEY --env production
```

| 名称 | 类型 | 说明 |
|---|---|---|
| `ACCESS_TEAM` | secret | Zero Trust 团队名，或完整的 `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | secret | Access 应用的 audience tag，可以逗号分隔多个 |
| `ADMIN_EMAILS` | secret | 平台管理员邮箱 |
| `TRIGGER_KEY` | secret | trigger 唤醒地址的 AES-GCM 密钥 |
| `E2E_SERVICE_TOKEN_ID` | secret | 仅 staging：允许 Playwright 用 service token 进门 |
| `PUBLIC_URL` | var | hub 的外部地址，用于邮件和邀请链接 |
| `MAIL_FROM` | var | 发件地址 |
| `SIGNUP` | var | `invite`（默认）只有平台管理员能建团队；`open` 任何通过 Access 的人都能建 |
| `EMAIL_ASSET_BASE` | var | 邮件插画的地址前缀，默认 `https://docs.hub.shiroha.tech/email` |
| `ENVIRONMENT` | var | `production` / `staging` |

## 5. 邮件

Worker 通过 `send_email` 绑定发信（`wrangler.jsonc` 里已经声明）。在 Cloudflare 控制台为域名开通 **Email Routing**，并在 **Destination addresses** 里验证所有会收通知的邮箱。没验证的地址会在设置页显示 `E_RECIPIENT_NOT_ALLOWED` 和处理提示。

## 6. 部署

```sh
pnpm exec wrangler deploy --env production
curl -fsS https://hub.example.com/healthz
```

然后用 `ADMIN_EMAILS` 里的邮箱登录网页，创建第一个团队，生成加入码，按 [快速开始](./quickstart) 接入第一台机器。agent 侧只需要把 `--hub` 指向你的地址。

## CI/CD

仓库的 `.github/workflows/hub.yml` 做了完整流水线：

```
PR / push：类型检查 → Vitest → 构建 → wrangler deploy --dry-run
push 到 main（且配置了 CLOUDFLARE_API_TOKEN）：
  → 迁移并部署 staging → Playwright e2e（Access service token）→ 迁移并部署 production
```

需要的仓库 secret：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`。没配 token 时部署步骤会被跳过，而不是失败。

::: warning 公开仓库只用 GitHub 托管 runner
fork 来的 PR 可以在 runner 上执行任意代码，所以公开仓库**绝不能**使用自托管 runner。
:::

## 备份

D1 自带时间点恢复（免费版 7 天）。`hub-backup.yml` 每天执行 `wrangler d1 export`，压缩后存到 R2。
