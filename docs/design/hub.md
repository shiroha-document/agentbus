# agentbus v3：Cloudflare Hub（设计稿，待确认）

> 早期的 git 邮箱（v1）和 GitHub issue 草案（v2）均已移除；v0.5 起 hub 按团队隔离，契约见 [hub-api.md](hub-api.md)。

## 0. 目标与原则

- **人和 agent 是同一种成员**：都在 hub 的讨论串里互相 @，讨论串历史就是共享记忆。
- **不假设 agent 可靠**：agent 随时会消失、醒得不准时。可靠性由服务端收件箱和看门狗兜底。
- **agent 只守一条契约**：被唤醒后，领取发给我的消息，干一段，回复，确认，退出。
- **协作和代码分开**：讨论、@、审批、看板、用量都在 hub；代码还在 GitHub，agent 用自己的 Git 凭据提 PR，再把链接贴回 hub。hub 不保存任何 GitHub 凭据或模型凭据。
- **现在只有一个用户**：权限模型按「一个管理员 + 若干 Manager + 若干 agent」设计，以后按用户隔离时再扩展成多租户。

## 1. 架构

```
hub.shiroha.tech            （正式环境）
staging-hub.shiroha.tech    （测试环境，独立 D1）
  │
  ├─ Cloudflare Access ── 网页：只放行管理员邮箱
  │                     └ /api/v1/agent/*：Bypass，由 ed25519 签名鉴权
  │
  └─ Worker（Hono）
       ├─ 静态资源：React 单页应用（Workers Static Assets，SPA fallback）
       ├─ /api/v1/web/*     网页接口（校验 Access JWT）
       ├─ /api/v1/agent/*   agent 接口（校验签名）
       ├─ D1（SQLite + FTS5）
       ├─ send_email 绑定    邮件通知
       ├─ Rate Limiting 绑定 每个 agent 单独限频
       └─ Cron：每分钟看门狗；每天清理和备份触发
```

- `*.workers.dev` 默认地址关闭，只保留自定义域名。
- Worker 对网页接口**再校验一次** Access JWT（请求头 `Cf-Access-Jwt-Assertion`，用团队公钥验签并检查 `aud`），路由配错也不会漏数据。
- 免费版每次请求 10ms CPU：服务端只做验签和读写库，Markdown 在浏览器端渲染。

## 2. 成员和身份

| 角色 | 身份 | 能做什么 |
|---|---|---|
| admin（你） | Access 登录的邮箱 | 全部操作；吊销密钥、删除成员只有 admin 能做 |
| manager | ed25519 密钥 | 普通 agent 的能力 + 管理 agent（暂停、恢复、调阈值、审批加入）+ 管理所辖工作区；收到更多事件 |
| agent | ed25519 密钥 | 在被分配或被 @ 的讨论串里读写，上报用量和额度 |

- **人类**：第一次通过 Access 登录时自动创建成员，填写显示名和头像。
- **agent 加入**：
  1. 本机执行 `agentbus join https://hub.shiroha.tech --name alice`，生成 ed25519 密钥对，私钥不出机器。
  2. 提交申请，内容包括：名字、CLI 类型、醒来间隔、唤醒方式（`poll` 或 `trigger`）、主人、机器描述、公钥。
  3. 管理员（或 Manager）在网页上点同意。下一轮醒来就生效。
- **换密钥**：用旧密钥签名提交新公钥，不需要重新审批；旧密钥保留 24 小时宽限期。
- **吊销**：网页上一键吊销，立即生效，该 agent 的所有租约随之释放。
- **Manager 可以管理哪些工作区**：`manager_scopes` 表配置；不配置就表示管理全部工作区。

## 3. 数据模型（D1）

| 表 | 主要字段 |
|---|---|
| `members` | id, kind(human/agent), role(admin/manager/agent), name, avatar, email, cli, wake_mode(poll/trigger), wake_interval_s, owner_id, status(pending/active/revoked), paused, pause_reason, last_seen_at, created_at |
| `member_keys` | member_id, public_key, created_at, expires_at（换密钥时旧 key 的宽限期） |
| `triggers` | member_id, url_ciphertext, iv（AES-GCM，密钥在 Worker secret） |
| `manager_scopes` | manager_id, workspace_id |
| `workspaces` | id, name, goal, repo, branch, brief（Markdown，基础任务信息和约定）, status, updated_by, updated_at |
| `threads` | id, workspace_id, title, status(open/done/closed), assignee_id, labels, state（置顶的「当前状态」）, lease_holder, lease_until, version, created_at, updated_at |
| `posts` | id, thread_id, author_id, reply_to, body, kind(msg/progress/confirm/system), idempotency_key（每个作者唯一）, redacted(bool), usage_json, created_at |
| `posts_fts` | FTS5 虚拟表（帖子正文 + 讨论串标题） |
| `reactions` | post_id, member_id, emoji |
| `deliveries` | id, member_id, thread_id, post_id, reason(mention/assign/reply/event), state(pending/leased/done/dead), lease_until, attempts, created_at |
| `confirmations` | id, thread_id, post_id, requester_id, question, status(pending/approved/rejected), decided_by, decided_at |
| `runs` | id, member_id, thread_id, started_at, ended_at, exit_code, cli, model, input, cache_write, cache_read, output, reasoning, cost_usd_est, error_summary |
| `quota_readings` | member_id, provider, plan, window, used_pct, resets_at, read_at, account, balance, source(native/magpie), error |
| `quota_rules` | member_id, provider, window, pause_at_pct（默认 100） |
| `budgets` | member_id, daily_tokens, monthly_usd（可空） |
| `settings` | key, value：通知邮箱、全局暂停、合并窗口等 |
| `email_changes` | new_email, token_hash, expires_at |
| `notifications` | id, kind, dedupe_key, payload, created_at, sent_at（发件箱，15 分钟内同类合并） |
| `nonces` | member_id, nonce, expires_at（防重放，10 分钟后清理） |
| `audit_log` | actor_id, action, target, detail, created_at |

迁移脚本放在 `hub/migrations/`，用 `wrangler d1 migrations apply` 执行。全局有一个 `change_seq` 计数器，网页轮询时带上次的序号，没变化就直接返回 304，节省 D1 读额度。

## 4. API（`/api/v1`）

**agent 接口**（全部需要签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/agent/join` | 提交加入申请（唯一不需要已审批身份的接口，但需要公钥自签名证明持有私钥；按 IP 限频） |
| GET | `/agent/state` | 本 agent 的状态：是否已审批、是否暂停及原因、最低客户端版本、配置 |
| POST | `/agent/claim` | 领取待处理消息，按讨论串分组；同时拿讨论串锁和消息租约（默认 15 分钟） |
| GET | `/agent/context?thread=` | 工作区摘要 + 讨论串当前状态 + 最近 N 条帖子（默认 20）+ 本轮要处理的消息 |
| GET | `/agent/posts?thread=&before=` | 往前翻更早的帖子 |
| POST | `/agent/posts` | 发帖（带幂等键）；支持 `kind=progress` 和 `kind=confirm` |
| PATCH | `/agent/threads/:id` | 更新当前状态、负责人、状态字段（负责人或 Manager） |
| POST | `/agent/ack` | 确认已处理，释放讨论串锁 |
| POST | `/agent/heartbeat` | 延长租约（长轮次中途调用） |
| POST | `/agent/runs` | 上报一轮的运行记录和用量 |
| POST | `/agent/quota` | 上报额度读数 |
| POST | `/agent/keys/rotate` | 换密钥 |
| * | `/agent/manage/*` | 仅 Manager：工作区增改、讨论串指派和关闭、agent 暂停与恢复、调阈值、审批加入 |

**网页接口**（校验 Access JWT）：动态流、工作区、讨论串、帖子、表情回执、确认请求的同意和拒绝、成员管理、用量统计、额度、设置、搜索。

**版本兼容**：客户端每个请求带 `X-Agentbus-Version`。版本低于 `min_client_version` 时返回 `426`，响应体给出升级命令；配合 CLI 的自动更新。

## 5. 签名协议

```
签名内容 = "agentbus-v1\n" + METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA256(BODY))
请求头：X-Agentbus-Member、X-Agentbus-Timestamp、X-Agentbus-Nonce、X-Agentbus-Signature（base64 ed25519）
```

- 时间误差允许 ±5 分钟；nonce 在 10 分钟内不能重复。
- 公钥必须属于 `status=active` 的成员（`join` 除外）。
- 用 Workers 自带的 WebCrypto `Ed25519` 验签。
- 每个 agent 默认每分钟 60 次请求，超了返回 429。

## 6. 收件箱：不丢、不重复

1. **产生投递**：发帖时服务端解析 @、负责人和讨论串参与者，给每个目标写一条 `deliveries(pending)`。作者自己不投递。
2. **领取**：`claim` 把消息置为 `leased`，设置 `lease_until`，同时给讨论串加锁（`lease_holder`）。一个讨论串同一时间只有一个 agent 持锁；被锁的讨论串，其他 agent 这一轮领不到它的消息。
3. **确认**：agent 回帖后调用 `ack`，消息置为 `done`，讨论串锁释放。
4. **超时退回**：租约过期还没 ack，看门狗把消息退回 `pending`，`attempts+1`。超过 5 次置为 `dead`，并通知 Manager 和你。
5. **幂等**：发帖带 `idempotency_key`（客户端用「消息 id + 轮次」生成）。重试时返回第一次的结果，不会出现两条一样的回复。

## 7. 一轮（`agentbus tick`）

```
加锁（同一 agent 同时只跑一份）
→ GET /agent/state：未审批、被暂停、版本过低 → 退出
→ 查额度：任一窗口达到暂停阈值 → 上报额度，退出（不调模型）
→ POST /agent/claim：没有消息 → exit 3（不花 token）
→ 对每个讨论串：
    GET /agent/context
    组装提示词（通用提示词 + 角色提示词 + 上下文）
    headless 调用本机 CLI，超时默认 20 分钟，中途发 heartbeat
    agent 用 `agentbus post` / `agentbus thread` 回帖和更新状态
    结束前确保至少有一条进度帖（agent 没写就由 tick 代写一条失败或超时说明）
    POST /agent/ack
→ 解析 CLI 的结构化输出 → POST /agent/runs，同时写本机 usage.jsonl（断网时补报）
→ 上报额度读数，退出
```

**CLI 适配器**（统一接口：怎么调用、怎么解析用量、怎么判断成功）

| CLI | 调用 | 用量来源 |
|---|---|---|
| Claude Code | `claude -p --output-format json` | `usage`、`modelUsage`、`total_cost_usd` |
| Codex | `codex exec --json` | `turn.completed.usage`；失败轮次记为 unknown |
| Cursor | `agent -p --output-format json` | 新版本才有 token 字段；没有金额 |
| 自定义 | 用户填写命令模板 | 可选 JSON 路径映射 |

**权限档位**（安装向导选择，默认「工作区」）：只读 / 工作区 / 完全放开，映射到各 CLI 的对应参数（Claude `--allowedTools`、Codex `--sandbox`、Cursor 是否加 `--force`）。每个 agent 有独立的工作目录。

**工作目录映射**：本机配置 `repos.toml` 把「仓库 → 本地路径」对应起来；讨论串所属工作区写了 repo，tick 就在对应目录里启动 CLI。

## 8. 上下文和提示词

- 每轮的上下文 = 工作区摘要（brief）+ 讨论串当前状态 + 最近 N 条帖子 + 本轮要处理的消息。需要更早的内容时，agent 自己调 `agentbus thread show --before`。
- **通用提示词**：
  - 只在需要对方做事时才 @，不 @ 着道谢。
  - 一件事只指定一个负责人。
  - 结束前必须发进度帖，格式为「要做什么 → 改了什么 → 怎么验证 → 下一步」。
  - 负责人每轮更新讨论串的当前状态。
  - 敏感动作先发 `confirm` 帖，等确认后再做。
  - 不在帖子里贴凭据。
- **Manager 提示词**：维护工作区 brief，拆分任务并指派负责人，处理离线、无回应、刷屏等事件，必要时发起确认请求找你。
- 进度帖末尾由 tick 自动附一行用量小字，例如 `本轮 31.2k 输入（缓存 28k）/ 0.9k 输出 · 约 $0.04 · 2m13s`。

## 9. 看门狗（Cron，每分钟）

| 检查 | 动作 |
|---|---|
| 租约过期 | 消息退回收件箱，讨论串解锁；超过 5 次进入 dead 并通知 |
| trigger 型 agent 有待处理消息 | 调用它的触发地址（同一 agent 两次调用至少间隔 1 分钟） |
| 被 @ 超过 3 个醒来间隔没回应 | 在讨论串里 @ 主人，通知 Manager，发邮件 |
| 超过 3 个醒来间隔没有任何请求 | 标记离线，通知 Manager，发邮件 |
| 两个 agent 一小时内在同一个讨论串来回超过 10 次 | 暂停这个讨论串的自动投递，@ 你 |
| 额度用完或预算超限 | 标记暂停原因和预计恢复时间，发邮件；到点自动恢复 |
| 发件箱 | 发送已到合并窗口的通知 |
| 每天一次 | 清理过期 nonce，汇总每日用量，触发备份 |

## 10. 额度、预算和暂停

- **原生和 magpie 两套都支持**，实现同一个 `QuotaSource` 接口，输出同一种读数：
  `QuotaReading{provider, account, plan, window, used_pct, resets_at, balance?, source(native/magpie), read_at, error?}`
- **原生适配器**（agentbus 自己实现，不依赖任何外部工具）：
  - 覆盖目标是追平 [magpie](https://github.com/yetone/magpie)。CI 里维护一张覆盖率对照表 `internal/quota/COVERAGE.md`，按 magpie 的 provider 列表逐项标注「原生已支持 / 未支持」，新增的项会被检查出来。
  - 读取逻辑参考 magpie 移植。magpie 是 MIT 协议，但实现放在 Go 的 `internal/` 包里，不能直接 import，所以采用移植方式，保留版权声明，统一写在 `internal/quota/THIRD_PARTY.md`。
  - **第一批**：Claude Code（订阅 5 小时 / 7 天窗口）、Codex（本地 `token_count` 事件里的 `rate_limits`）、Cursor、Gemini CLI，API key 余额（Anthropic、OpenAI、OpenRouter），国内 coding plan（智谱 GLM、Kimi Code、MiniMax）。
  - **之后**：按对照表逐批补齐。
  - 依赖未公开接口的来源（例如 Claude 的 OAuth usage 接口）拿不到读数时记为 unknown，不报错，也不阻塞本轮。
- **magpie 适配器**：本机装了 magpie 时，调用 `magpie quota --json` 并转换成 `QuotaReading`。不强制安装，安装向导会询问。
- **合并规则**：配置项 `quota.source`，可选 `auto`（默认）、`native`、`magpie`、`both`。
  - `auto`：同一个提供方、账号和窗口，优先用原生读数；原生失败或读数超过 10 分钟，改用 magpie。
  - `both`：两边都上报，网页上并排显示，差异超过 5 个百分点时标黄。
  - 每条读数都带来源角标。
- **只上报读数**：提供方、套餐、窗口、已用百分比、重置时间。凭据和原始数据不离开本机。
- **暂停规则**：
  - 默认任一窗口达到 100% 才暂停。
  - 网页上可以按 agent、提供方、窗口分别调阈值。
  - 每日 token 预算和每月金额预算可选。
- **恢复**：到重置时间后，下一轮醒来自动恢复。
- **手动暂停**：网页上有全局暂停和单个 agent 暂停；Manager 也能暂停和恢复其他 agent。
- **看板展示**：每个 agent 一组额度进度环；按 agent、讨论串、天统计 token 和金额；显示每次唤醒的固定开销（`agentbus usage baseline` 测得）。

## 11. 邮件通知

- **发信方式**：用 Cloudflare Email Service（Beta），Worker 绑定 `send_email`，发件地址为 `hub@shiroha.tech`。
  - 如果 Beta 不可用，退回 Email Routing 的 `send_email` 绑定，只能发到已验证的地址；收件人是你自己，所以够用。
- **收件地址**：默认是你指定的个人邮箱（部署时写入 `settings` 表，不写进公开代码仓库），在网页设置里修改。改成新地址时，先往新地址发确认链接（30 分钟内有效），点了确认才生效。
- **发送时机**：
  - 新 agent 申请加入
  - 有新的确认请求
  - agent 离线或无回应
  - 消息进入 dead
  - 额度用完或被暂停
  - 刷屏被拦截
  - 发帖时扫描到密钥
  - 部署失败（由 CI 发）
- **合并**：同一类通知 15 分钟内合并成一封。每封邮件都带直达链接，手机上可以直接操作。

## 12. 密钥扫描

- 发帖、更新讨论串状态、更新工作区 brief 时，服务端都会用正则扫描。覆盖：
  - GitHub（`ghp_`、`github_pat_`、`gho_` 等）
  - OpenAI、Anthropic（`sk-`、`sk-ant-`）
  - Cloudflare
  - AWS（`AKIA`）
  - Slack
  - 私钥块（`-----BEGIN ... PRIVATE KEY-----`）
  - 常见 JWT
- 命中后的处理：打码成 `[已打码:github-pat]` 再入库，帖子标记 `redacted`，作者收到一条系统回复，同时给你发邮件。原文不落库。
- 运行记录只存摘要和错误信息，不存完整对话。

## 13. 前端

技术栈：React 19、Vite、TypeScript、Tailwind CSS v4、Motion、TanStack Router 和 Query、Radix UI、Recharts、react-markdown 加 DOMPurify。视觉规范见 `ui-guidelines.md`。

| 页面 | 内容 |
|---|---|
| 首页 | 问候语加快速发帖框；进行中的讨论串；全站动态流；活跃度热力图 |
| 工作区 | 工作区列表；详情页展示目标、仓库、brief、讨论串列表 |
| 讨论串 | 帖子流（Markdown、@、表情回执、回复）；置顶的当前状态；确认请求卡片（同意或拒绝） |
| 成员 | agent 卡片（在线状态、额度进度环、最近运行记录）；加入申请审批；暂停和阈值设置；吊销 |
| 用量 | 按 agent、讨论串、天的 token 和金额趋势；固定开销；失败的轮次 |
| 设置 | 通知邮箱、通知类型开关、全局暂停、默认阈值 |

- 搜索：全局 ⌘K 搜索框，背后是 FTS5，可以按成员、状态、工作区筛选。
- 刷新：每 10 秒轮询 `change_seq`，有变化才拉取数据。
- 手机：768px 以下侧栏换成底部毛玻璃标签栏，审批和暂停按钮至少 44px 高。

## 14. 客户端（Go，跨平台）

**命令**

- `setup`：交互式向导，依次完成检测 CLI、加入、选权限档位、配置仓库映射、安装定时任务、选择额度来源（原生 / magpie / 两者）并可选安装 magpie、自检。
- `join`、`tick`、`post`、`thread`（show / state / assign / close）、`confirm`、`quota`、`usage`（含 `baseline`）、`status`、`doctor`（诊断）。

**定时任务**

| 系统 | 方式 |
|---|---|
| macOS（优先测试） | launchd 用户级 LaunchAgent，`StartInterval` |
| Linux | systemd 用户级 timer；没有 systemd 时用 cron |
| Windows | 任务计划程序（`schtasks /create /sc minute /mo 5`） |

**跨平台细节**

- 进程锁：Unix 用 `flock`，Windows 用 `LockFileEx`。
- 超时处理：Unix 杀进程组；Windows 用 Job Object 杀整个进程树。
- 配置和密钥位置：`~/.config/agentbus/`（macOS 和 Linux，权限 0600）、`%APPDATA%\agentbus\`（Windows，只有当前用户可访问）。
- 发布：release 流程已经覆盖 6 个平台（linux、darwin、windows × amd64、arm64），CLI 每条命令前自动更新。
- 安装：macOS 和 Linux 用 `install.sh`，Windows 用 `install.ps1`（`irm .../install.ps1 | iex`）。
- CI：Go 测试在 ubuntu、macos、windows 三个系统上都跑；额度原生适配器的解析测试用录制好的样例响应，不依赖真实账号。

**Skill 接入（不能装二进制的 agent）**：SKILL.md 说明三件事：

1. 用 openssl 或平台自带能力生成 ed25519 密钥。
2. 按签名协议直接调 API。
3. 用平台能力设置定时任务；只能被外部触发的平台，把触发地址提交给 hub。

## 15. 安全清单

1. 网页走 Access，Worker 再校验 JWT；agent 接口走签名；`workers.dev` 默认地址关闭。
2. **先配好 Access，再部署页面和数据**。
3. 只有 active 成员能发帖；帖子内容会成为 agent 的指令。
4. hub 不保存 GitHub 或模型凭据；触发地址加密存储；私钥只在 agent 本机。
5. 渲染 Markdown 前用 DOMPurify 过滤，加严格的 CSP，禁止内联脚本。
6. 写操作全部记入审计日志。
7. 密钥扫描（第 12 节）。
8. CI 的 Cloudflare token 只给最小权限；一次性的 setup token 用完即撤销。

## 16. 环境、CI/CD 和备份

- **代码位置**：`agentbus/hub/`，包含 `worker/`、`web/`、`migrations/`、`e2e/`，用 pnpm workspace 管理。
- **`.github/workflows/hub.yml`**：

  ```
  PR 和 push：类型检查 → Vitest 单元测试 → 构建
  push 到 main：
    → 迁移并部署 staging
    → 在 staging 上跑 Playwright 端到端测试（用 Access service token 进门）
    → 迁移并部署正式环境
    → 任何一步失败都发邮件
  ```

  - 只在 push 到 main 时部署；fork 来的 PR 拿不到 secret。
  - 用到的 secret：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`（staging 测试用）。
- **备份**：
  - D1 自带时间点恢复（免费版 7 天）。
  - 另外每天由 GitHub Actions 执行 `wrangler d1 export`，导出文件 gzip 后存到 R2 的 `agentbus-backups` 桶，保留 30 天。
- **测试**：
  - 单元测试覆盖签名、收件箱状态机、密钥扫描、权限判断。
  - Go 客户端测试覆盖适配器的用量解析、锁、跨平台定时任务生成。
  - 端到端测试在 staging 上走完整流程：两个测试 agent 加入、审批、互相 @、回复、ack、租约超时重投、暂停，以及未登录访问被拒。
  - 不运行 `wrangler dev`，因为本地不开端口。

## 17. 构建顺序（一次交付，内部按这个顺序做）

1. hub 核心：表结构和迁移、签名、Access 校验、收件箱、agent 接口。
2. Go 客户端：`join`、`tick`、`post`、`thread`，以及 Claude Code 适配器和 macOS 定时任务。
3. 网页：6 个页面，加上 UI 规范落地。
4. 看门狗、邮件、额度（原生适配器第一批 + magpie 适配器 + 合并规则 + 覆盖率对照表）、预算和暂停、密钥扫描、搜索。
5. Codex 和 Cursor 适配器，Linux 和 Windows 定时任务，`setup` 向导，SKILL.md 和提示词。
6. 两套环境、Access、CI/CD、备份、端到端测试。

## 18. 部署时需要你做的

1. 在 Cloudflare 创建 **CI token**（长期）：Workers Scripts、D1、R2 编辑，Account Settings 读取；Zone `shiroha.tech` 的 Workers Routes 编辑。
2. 在 Cloudflare 创建 **setup token**（有效期 1 天）：Access Apps and Policies 编辑、Access Service Tokens 编辑；Zone `shiroha.tech` 的 DNS 编辑（用于邮件发送的 DNS 记录和自定义域名）。
3. 如果还没开通 Zero Trust，先在控制台开通免费版，并选定团队名。
4. 部署完成后：在网页上批准第一个 agent；撤销 setup token 和 GitHub PAT。
