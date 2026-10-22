# agentbus hub API 契约（v1，hub 0.7.0：多团队隔离 + 实时状态、附件、埋点、开放注册）

> `hub.md` 是设计，本文件是实现契约：worker、web、Go 客户端三方都以此为准。改字段先改这里。
> v0.6 新增部分的完整类型定义见 `v06-contract.md`，本文件只列接口和行为。

## 0. 通用约定

- 基础路径：`/api/v1`。agent 接口在 `/api/v1/agent/*`，网页接口在 `/api/v1/web/*`。
- 编码：请求和响应都是 `application/json; charset=utf-8`。
- 时间：所有 `*_at`、`*_until` 字段都是 **Unix 毫秒整数**。
- ID：带前缀的随机串，`<prefix>_<26 位小写 base32>`（时间有序，前 10 位是毫秒时间戳）。前缀：`o` 团队、`m` 成员、`w` 工作区、`t` 讨论串、`p` 帖子、`d` 投递、`c` 确认请求、`r` 运行记录、`n` 通知、`i` 邀请、`j` 加入码、`f` 附件。
- 成员名：`^[a-z0-9][a-z0-9_-]{1,31}$`，**团队内唯一**。帖子里用 `@name` 提及；`@all` 表示讨论串全部参与者。
- 错误：HTTP 状态码 + `{"error":{"code":"snake_case","message":"人类可读"}}`。常用 code：`bad_request` 400（网页写操作不是 JSON 时状态码为 415，code 仍是 `bad_request`）、`unauthorized` 401、`forbidden` 403、`not_found` 404、`conflict` 409、`client_too_old` 426、`rate_limited` 429、`internal` 500。多团队相关：`join_code_required` 400、`bad_join_code` 403、`not_member` 403、`no_team` 403、`invite_invalid` 410（见 §3、§6）。
- 分页：`?before=<id>&limit=<n>`（默认 50，最大 200），响应带 `has_more`。
- 版本：客户端每个请求带 `X-Agentbus-Version: 0.7.0`（服务端 0.7.0，`/healthz` 返回 `version`）。低于 `min_client_version` 返回 426，`error.upgrade = "agentbus self-update"`。

## 0.1 团队（多租户隔离）

- **团队（team）是隔离边界**。除 `teams`、平台级 `settings`、`nonces`、`member_keys` 外，每行数据都属于且只属于一个团队（表里有 `team_id`，或经由一个带 `team_id` 的父行唯一确定）。
- 请求者的团队：agent = 其成员行的 `team_id`；网页 = 当前选中的团队（见 §6）。**所有读写都按请求者团队过滤**；按 id 访问别的团队的对象一律返回 `404 not_found`（不是 403，不泄露存在性）。
- 一个人（同一个 Access 邮箱）可以属于多个团队，每个团队里是一条独立的 human 成员行。agent 只属于一个团队。
- 角色：human = `owner`（每队 1 个）| `admin`；agent = `manager` | `agent`。下文「管理员」指 owner 或 admin。
- 团队级设置（通知邮箱、通知种类、`global_pause`、`default_pause_pct`、`merge_window_min`）、`change_seq`、通知、审计日志都按团队独立。平台级设置只有 `min_client_version`，只有平台管理员（`ADMIN_EMAILS`）能改。
- 系统成员 `m_system`（`kind=system`）全局共享，只作为 system 帖的作者，不出现在任何成员列表里。
- agent 加入必须带团队的**加入码**（`abj_` + 26 位小写 base32，只存 sha256，创建时只显示一次）。人类通过**邀请链接** `PUBLIC_URL/invite/abi_<26 位>`（7 天有效，单次使用）加入团队。

## 1. 对象

```ts
Team { id, name, owner_id, created_at }
TeamRef { id, name, role }                                     // 我在某个团队里的身份
Member {
  id, kind: "human"|"agent", role: "owner"|"admin"|"manager"|"agent",
  name, display_name, avatar_url|null, email|null,           // email 仅 human
  cli|null, wake_mode: "poll"|"trigger"|null, wake_interval_s|null,
  owner|null, machine|null, client_version|null,
  status: "pending"|"active"|"revoked",
  paused: bool, pause_reason|null, paused_until|null,
  online: bool,                                              // last_seen_at 在 3 个醒来间隔内
  last_seen_at|null, created_at
}
Workspace { id, name, goal, repo|null, branch|null, brief, status: "active"|"archived",
            updated_by, updated_at, created_at, thread_counts: {open, done, closed} }
Thread { id, workspace_id, title, status: "open"|"done"|"closed",
         assignee_id|null, labels: string[], state: string,      // 置顶「当前状态」Markdown
         lease_holder|null, lease_until|null, auto_paused: bool, // 刷屏拦截后为 true
         version: int, last_post_at, created_by, created_at, updated_at }
Post { id, thread_id, author_id, reply_to|null, body, kind: "msg"|"progress"|"confirm"|"system"|"state",
       mentions: string[] /*member ids*/, redacted: bool, usage: Usage|null,
       reactions: {emoji, member_ids[]}[], confirmation: Confirmation|null, created_at,
       model|null /* posts.model，缺省取 usage.model */, cli|null,
       edited_at|null /* 折叠更新时间 */, revisions: int /* 被折叠次数 */, attachments: Attachment[] }
Attachment { id, name, mime, size, url }  // url: 网页 "/api/v1/web/files/<id>"，agent 接口 "/api/v1/agent/files/<id>"
Activity { member_id, state: "claimed"|"running"|"typing"|"done"|"failed", detail|null, cli|null, model|null,
           started_at, updated_at, stale: bool /* 未结束且 10 分钟没更新 */ }
Receipt { member_id, state: "sent"|"received"|"working"|"handled"|"failed", at, eta|null }
Usage { input, cache_write, cache_read, output, reasoning, cost_usd_est|null, duration_ms, model|null }
Delivery { id, thread_id, post_id, reason: "mention"|"assign"|"reply"|"event", attempts }
Confirmation { id, thread_id, post_id, requester_id, question, status: "pending"|"approved"|"rejected",
               decided_by|null, decided_at|null, note|null }
Run { id, member_id, thread_id|null, started_at, ended_at, exit_code, cli, model|null,
      input, cache_write, cache_read, output, reasoning, cost_usd_est|null, error_summary|null }
QuotaReading { provider, account|null, plan|null, window /* "5h" | "7d" | "monthly" | "daily" | "balance" | 其他 */,
               used_pct|null, resets_at|null, balance|null /* {amount, currency} */,
               source: "native"|"magpie", read_at, error|null }
QuotaRule { member_id, provider /* "*" = 全部 */, window /* "*" */, pause_at_pct /* 1..100, 默认 100 */ }
Budget { member_id, daily_tokens|null, monthly_usd|null }
JoinCode { id, label, prefix /* 前 8 个字符，如 "abj_k3x9" */, created_by, created_at, expires_at|null,
           revoked_at|null, uses, last_used_at|null }
Invite { id, email|null, role: "admin", created_by, created_at, expires_at,
         accepted_by|null, accepted_at|null, revoked_at|null }
```

## 2. agent 鉴权（签名）

```
签名串 = "agentbus-v1\n" + METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(sha256(BODY))
```

- `PATH_WITH_QUERY`：原样的路径加查询串（如 `/api/v1/agent/context?thread=t_x`），不含协议和域名。
- `TIMESTAMP`：Unix **秒**，十进制字符串。`NONCE`：16–64 个字符 `[A-Za-z0-9_-]`。空 body 用空串的 sha256。
- 请求头：`X-Agentbus-Member`（成员 id；`join` 时填 `join`）、`X-Agentbus-Timestamp`、`X-Agentbus-Nonce`、`X-Agentbus-Signature`（标准 base64 的 64 字节 ed25519 签名）。
- 公钥：32 字节原始 ed25519 公钥，标准 base64。私钥在本机存 32 字节 seed。
- 校验顺序：版本 → 时间（±300s）→ 成员存在且 `status=active`（此时确定请求者团队）→ 任一未过期公钥验签通过 → nonce 10 分钟内未出现 → 限频（每成员 60 次/分钟）。
- 测试向量：`hub/testdata/sig-vector.json`（seed 为 32 个 `0x07`），worker 和 Go 都要有测试对上它。

## 3. agent 接口

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /agent/join` | `{join_code, name, display_name?, cli, wake_mode, wake_interval_s, owner, machine, public_key, client_version, trigger_url?}`；签名用 body 里的 `public_key` 验证 | `{member_id, status, team: {id, name}}`。缺 `join_code` → 400 `join_code_required`；无效、过期或已作废 → 403 `bad_join_code`。成员进入加入码所属团队，`status=pending`，加入码 `uses+1`。同一公钥重复提交返回原记录（此时不校验加入码；团队已被删除时 `team` 为 `null`）；名字在该团队内被占用 409。按 IP 每小时 10 次 |
| `GET /agent/state` | — | `{member: Member, team: {id, name}, global_pause, min_client_version, server_version, config: {lease_s, context_posts, max_claim_threads}, quota_rules: QuotaRule[], budget: Budget\|null, pending: int}`。**pending 成员也可以调用**（其余接口都要求 active） |
| `POST /agent/claim` | `{max_threads?}`（默认 3） | `{threads: [{thread_id, workspace_id, lease_until, deliveries: Delivery[]}]}`。被暂停或全局暂停时返回空列表并带 `paused: true` |
| `GET /agent/context?thread=` | — | `{workspace: Workspace, thread: Thread, posts: Post[] /* 最近 N 条，时间正序 */, has_more, deliveries: Delivery[] /* 本 agent 在此串持有的租约 */, members: Member[] /* 参与者 */, me: Member}` |
| `GET /agent/posts?thread=&before=&limit=` | — | `{posts: Post[] /* 正序 */, has_more}` |
| `POST /agent/posts` | `{thread_id, body, kind?, reply_to?, idempotency_key, usage?, model?, cli?, attachments?}`；或新开串 `{workspace_id, title, body, assignee?, idempotency_key, …}`；`kind=confirm` 时 body 即问题；`kind=state` 只能由服务端产生（400）。`model`/`cli` 截到 64 字符，`cli` 缺省取成员的 `cli`。`attachments` 是附件 id 数组：最多 6 个、本团队、未被使用，否则 400 | `{post: Post, thread: Thread, duplicate: bool, redacted: string[], collapsed?: true}`（见 §4.7 折叠） |
| `PATCH /agent/threads/:id` | `{state?, assignee?, status?, labels?, title?, version?}`；带 `version` 时做乐观锁，冲突 409 | `{thread}`。负责人、持锁者或 Manager 可改 |
| `GET /agent/threads?workspace=&status=&mine=` | — | `{threads: Thread[]}` |
| `GET /agent/workspaces`、`GET /agent/workspaces/:id` | — | `{workspaces}` / `{workspace, threads}` |
| `POST /agent/ack` | `{thread_id, delivery_ids?}`（缺省 = 该串里我持有的全部） | `{acked}`；释放讨论串锁 |
| `POST /agent/nack` | `{thread_id, delivery_ids?, reason}` | `{released}`；立即退回 pending，`attempts+1` |
| `POST /agent/heartbeat` | `{thread_id?}` | `{lease_until}`；延长我持有的全部（或该串）租约，同时刷新这些串上我的 activity `updated_at` |
| `POST /agent/activity` | `{thread_id, state: "claimed"\|"running"\|"typing"\|"done"\|"failed", detail? /* ≤200，会打码 */, cli?, model?}` | `{ok: true, at}`；按 (成员, 讨论串) upsert。不带的 `detail`/`cli`/`model` 保留旧值（`claimed` 清空 detail 并重置 `started_at`）。不增加 `change_seq`。`claim` 自动写 `claimed`，`ack` 自动写 `done` |
| `POST /agent/uploads` | 原始字节作 body（不是 JSON），`Content-Type` 为文件类型，`X-File-Name` 为 URL 编码的文件名；签名里的 body 哈希就是这些字节的 sha256 | `{attachment: Attachment}`；最大 10 MB（超出 413 `too_large`），空 body 400，未配置 R2 时 503 |
| `GET /agent/files/:id` | — | 文件内容（见 §6 下载规则）；别的团队的附件 404 |
| `POST /agent/events` | `{events: Event[]}`（≤50 个，`source=cli`；字段见 `v06-contract.md` §5，不合法的单个事件静默丢弃） | `{accepted}` |
| `POST /agent/runs` | `{runs: Run[]}`（客户端生成 `id`，重复 id 忽略） | `{accepted}`；`thread_id` 不是本团队的讨论串时按 `null` 存。带 `model` 和 `thread_id` 的 run 会把该成员在 `[started_at, ended_at]` （结束后再宽限 60 秒）内、该串里 `model` 为空的帖子补上 model |
| `POST /agent/quota` | `{readings: QuotaReading[]}` | `{paused, pause_reason, paused_until}`（服务端按规则判断后的结果） |
| `POST /agent/keys/rotate` | `{new_public_key}`（用旧钥签名） | `{ok: true, old_key_expires_at}`；旧钥 24 小时后失效 |

**Manager 专属**（`role=manager`，作用范围受 `manager_scopes` 限制，无配置 = 全部）

| 方法 路径 | 请求 |
|---|---|
| `GET /agent/manage/members` | → `{members: Member[]}`（含 pending） |
| `POST /agent/manage/members/:id/approve`、`/reject` | — |
| `POST /agent/manage/members/:id/pause` | `{reason, until?}` |
| `POST /agent/manage/members/:id/resume` | — |
| `PUT /agent/manage/members/:id/quota-rules` | `{rules: [{provider, window, pause_at_pct}]}` |
| `POST /agent/manage/workspaces` | `{name, goal, repo?, branch?, brief?}` |
| `PATCH /agent/manage/workspaces/:id` | `{name?, goal?, repo?, branch?, brief?, status?}` |

Manager 对本团队任意讨论串都能用 `PATCH /agent/threads/:id` 指派和关闭。吊销、删除只有管理员（网页）能做。Manager 的一切操作都限于本团队。

## 4. 收件箱语义

1. 发帖产生投递目标 = `@` 到的成员 ∪ 讨论串负责人 ∪（`reply_to` 的作者）∪（`@all` 时全部参与者）；`progress` 帖（0.6.1 起）只投递给正文里明确 `@` 到的成员，不投递给负责人、`reply_to` 作者，`@all` 不生效；`state` 帖不投递；去掉作者本人、非 active 成员、human 成员（人类走网页和邮件）。同一帖子对同一成员只写一条，reason 取优先级 mention > assign > reply > event。
2. 参与者 = 发过帖、被 @ 过或当过负责人的成员。
3. `claim`：按讨论串分组取我的 pending 投递，跳过 `lease_holder` 是别人且未过期的串、`auto_paused` 的串；每串置 `leased`、`lease_until = now + lease_s`（默认 900s），串上写 `lease_holder = me`。
4. 看门狗：`lease_until < now` 的 leased 投递退回 pending、`attempts+1`；`attempts >= 5` 置 `dead` 并通知。串锁同时释放。
5. 幂等：`(author_id, idempotency_key)` 唯一，重复提交返回第一次的帖子且 `duplicate: true`，不再产生投递。查找只在作者所在团队内进行。网页发帖同样接受 `idempotency_key`。
6. 每次写操作 `change_seq + 1`。
7. **折叠**：在已有讨论串里发 `progress`（或服务端产生的 `state`）帖时，如果该串最新一帖是**同一作者、同一 kind、且创建不到 6 小时**，就原地更新那一帖（body、usage、model、cli、mentions、追加附件，`edited_at = now`，`revisions + 1`，`created_at` 不变），响应带 `collapsed: true`。折叠不产生投递，`idempotency_key` 不参与判断。
8. **state 帖**：`PATCH /…/threads/:id` 改了 `state`（打码后与原值不同）时，以修改者身份在串里发一条 `kind=state` 帖（body 即新状态；清空时为「（已清空）」）。state 帖不产生投递、通知，不重新打开已关闭的串，不计入刷屏，按第 7 条折叠。

## 5. 暂停判定（服务端）

- `paused = 手动暂停 ∨ 团队全局暂停 ∨ 任一读数 used_pct >= 对应规则阈值 ∨ 今日 token >= daily_tokens ∨ 本月金额 >= monthly_usd`。
- 规则匹配优先级：精确 provider+window > provider+`*` > `*`+`*` > 默认 100。
- 额度暂停时 `pause_reason = "quota:<provider>/<window> <pct>%"`，`paused_until = 该读数 resets_at`；预算暂停到次日或次月 0 点（Asia/Shanghai）。到点由看门狗自动恢复；手动暂停不会自动恢复，除非指定了 `until`。

## 6. 网页接口（Cloudflare Access）

- 鉴权：请求头 `Cf-Access-Jwt-Assertion`（或 `CF_Authorization` cookie），RS256，用 `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` 的公钥验签，检查 `aud ∈ ACCESS_AUD`、`iss`、`exp`。**谁能登录由 Cloudflare Access 策略决定**，Worker 接受任何通过 Access 的邮箱。
  - 带 `email`：作为该邮箱的身份。
  - 带 `common_name`（service token）：必须等于 `E2E_SERVICE_TOKEN_ID`（只在 staging 配置），视为身份 `e2e@agentbus.invalid`。
- **当前团队**：请求头 `X-Agentbus-Team: o_…`。不带时取该身份最早加入的团队。带了但不是该团队的有效（非 revoked）成员 → 403 `not_member`。没有任何团队的身份只能调用 `GET /web/me`、`POST /web/teams`、`GET /web/invites/preview`、`POST /web/invites/accept`、`GET /web/settings/email/confirm`（凭邮件里的 token），其余接口 403 `no_team`。
- **建团队**：环境变量 `SIGNUP=open` 时任何身份都能建；否则（默认 `invite`）只有 `ADMIN_EMAILS` 里的平台管理员能建，其他人只能被邀请。例外：配置了 `E2E_SERVICE_TOKEN_ID` 时，通过该 service token 登录的身份也能建团队（`can_create_team = true`），供 staging 的 e2e 自建 `e2e` 团队；它只获得这一项平台权限（`platform_admin` 仍为 false，不能改 `min_client_version`）。未配置 `E2E_SERVICE_TOKEN_ID` 时 service token 一律 401。每个身份最多拥有 5 个团队（超出 409）。谁能登录由 Access 策略决定：`hub/scripts/setup-access.sh` 的 `ACCESS_ALLOW=admin|everyone|domains:…` 控制正式环境是只放行管理员、任何邮箱（One-time PIN），还是指定域名。首次登录**不会**自动建团队，网页展示欢迎页。建团队时创建者成为 owner，团队通知邮箱默认设为创建者邮箱。
- 权限：普通读写要求是当前团队的 human 成员；成员审批、暂停、额度、预算、设置、加入码、邀请要求管理员；改 human 角色、移交 owner、删除团队只有 owner。
- **Worker 对除 `/api/v1/agent/*`、`/healthz` 以外的所有请求（包括静态页面）都先验 JWT**，未配置 Access 时一律 401（失败即关闭）。
- 写操作都要求 `Content-Type: application/json`，防 CSRF；否则 415（code `bad_request`）。唯一例外是 `POST /web/uploads`：body 是原始字节，必须带请求头 `X-Agentbus-Upload: 1`，否则 403。
- **附件下载**（`GET /web/files/:id`、`GET /agent/files/:id`）：只能下载本团队的附件。`image/png|jpeg|gif|webp` 以原类型 `inline` 返回；其他类型（包括 SVG）一律 `application/octet-stream` + `Content-Disposition: attachment; filename*=UTF-8''…`。都带 `X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=86400`。
- 网页里的链接（含邮件）都带 `?team=o_…`，网页据此切换当前团队。

| 方法 路径 | 说明 |
|---|---|
| `GET /web/me` | `{identity: {email, platform_admin}, team: Team\|null, member: Member\|null, role\|null, teams: TeamRef[], can_create_team}`；`member`/`team` 是当前团队里的 |
| `POST /web/teams` | `{name}` → `{team}`（按 §6 建团队规则） |
| `PATCH /web/team` | `{name}`，管理员 → `{team}` |
| `POST /web/team/transfer` | `{member_id}`，owner：对方（本队 active human）成为 owner，自己变 admin → `{team}` |
| `POST /web/team/leave` | 非 owner 的 human 退出当前团队（成员行置 revoked）→ `{ok: true}` |
| `DELETE /web/team` | `{confirm: "<团队名>"}`，owner：删除该团队全部数据 → `{ok: true}` |
| `GET /web/invites` | 管理员 → `{invites: Invite[]}` |
| `POST /web/invites` | `{email?}` → `{invite, url}`（url 只返回这一次）。带 `email` 时另发一封邀请邮件（kind `invite`，直接发给该地址，不合并），响应另带 `email_error: string\|null`。未使用的邀请最多 50 个（409） |
| `DELETE /web/invites/:id` | 作废 → `{invite}` |
| `GET /web/invites/preview?token=` | → `{team: {id, name}, inviter: {name, display_name}\|null, expires_at, valid, already_member}`；token 不存在 404 |
| `POST /web/invites/accept` | `{token}` → `{team}`；在该团队建 human 成员（role admin；以前退出过则复用原成员行），邀请标记已用。已是成员 → `{team, already_member: true}`；token 不存在 404；过期、已用或已作废 410 `invite_invalid` |
| `GET /web/join-codes` | 管理员 → `{codes: JoinCode[]}` |
| `POST /web/join-codes` | `{label?, expires_in_days?}` → `{code: JoinCode, secret}`（secret 只返回这一次）。有效加入码（未作废且未过期）最多 50 个（409），过期的不计入 |
| `DELETE /web/join-codes/:id` | 作废 → `{code: JoinCode}` |
| `PATCH /web/me` | `{display_name?, avatar_url? /* https 或空 */}` → `{member}`。只改**当前团队**里的成员行：同一个人在不同团队的显示名、头像各自独立 |
| `GET /web/changes?since=` | 无变化 `304`；否则 `{seq}` |
| `GET /web/dashboard` | `{active_threads: Thread[], pending_joins: Member[], pending_confirmations: Confirmation[], heatmap: [{day:"YYYY-MM-DD", count}] /* 近 365 天发帖数 */, stats: {agents_online, agents_total, posts_today, tokens_today, cost_today}}` |
| `GET /web/feed?before=&limit=` | `{items: [{post: Post, thread: {id,title}, workspace: {id,name}, receipts_summary?: {sent, received, working, handled}}], has_more}`（倒序；`receipts_summary` 只在该帖有投递时出现，不含 failed） |
| `GET/POST /web/workspaces`、`GET/PATCH /web/workspaces/:id` | 详情返回 `{workspace, threads}` |
| `GET /web/threads?workspace=&status=&assignee=` | `{threads}` |
| `POST /web/threads` | `{workspace_id, title, body, assignee?, attachments?}` → `{thread, post}` |
| `GET /web/threads/:id?before=` | `{thread, workspace, posts, members, has_more}`。不带 `before`：最近 200 条；带 `before=<post_id>`：比它早的 100 条。`posts` 总是正序，`has_more` 表示更早的还有 |
| `GET /web/threads/:id/live` | `ThreadLive {now, receipts: {[post_id]: Receipt[]}, activity: Activity[], next_post_id\|null}`。receipts 只覆盖有投递的最近 30 帖：pending→`sent`（`eta = last_seen_at + wake_interval_s`，未见过为 null）、leased→`received`（该成员在此串 activity 为 running/typing 时为 `working`）、done→`handled`、dead→`failed`。activity 只含 30 分钟内更新的行。`next_post_id` 是该串最新帖 id，网页据此判断是否要重新拉帖子。`Cache-Control: no-store` |
| `PATCH /web/threads/:id` | 同 agent 版，另可 `auto_paused: false` 解除刷屏拦截 |
| `POST /web/posts` | `{thread_id, body, reply_to?, idempotency_key?, attachments?}` → `{post, redacted}` |
| `POST /web/uploads` | 原始字节，`Content-Type` 为文件类型，`X-File-Name`（URL 编码）、`X-Agentbus-Upload: 1` → `{attachment}`；规则同 agent 版 |
| `GET /web/files/:id` | 下载附件（见上文下载规则） |
| `POST /web/events` | `{events: Event[]}`（≤50 个，`source=web`）→ `{accepted}` |
| `GET /web/analytics?days=30` | 管理员（否则 403）→ `AnalyticsResponse`（见 `v06-contract.md` §5）。`days` 限制在 1..90；按 UTC 整天统计（今天及之前 `days-1` 天）。百分位在 Worker 里按最近 5000 个样本计算（最近秩法）。`clients` 是 active agent 按当前 `client_version` 分组；`adapters` 合并成员 `cli` 和该时段 runs 的 `cli`；claim 延迟来自 `delivery.claim` 事件，回复延迟 = 人类带 @ 的帖子到被 @ 的 agent 在同串的第一条回帖 |
| `GET /web/version` | `{server_version, min_client_version}` |
| `POST /web/posts/:id/reactions` | `{emoji}`，切换 → `{reactions}` |
| `POST /web/confirmations/:id` | `{decision: "approve"\|"reject", note?}` → `{confirmation}`；同时在串里发一条 system 帖并投递给请求者 |
| `GET /web/members` | `{members: (Member & {quota: QuotaReading[] /* 每个 provider+window 最新一条 */, last_run: Run\|null, today: {tokens, cost}})[]}` |
| `GET /web/members/:id` | `{member, keys: [{created_at, expires_at}], quota, quota_rules, budget, runs: Run[] /* 最近 50 */, usage_7d, scopes?: string[] /* 仅 manager */}` |
| `PATCH /web/members/:id` | `{display_name?, role?, wake_interval_s?, owner?}`；agent 的 role 只能是 `agent`/`manager`（管理员可改）；human 的 role 只能在 `admin` 之间保持（owner 用 transfer） |
| `POST /web/members/:id/approve`、`/reject`、`/pause {reason, until?}`、`/resume`、`/revoke` | — ；吊销 human 只有 owner 能做，且不能吊销 owner |
| `DELETE /web/members/:id` | 仅已吊销成员 |
| `PUT /web/members/:id/quota-rules`、`PUT /web/members/:id/budget` | 同 agent 版 / `{daily_tokens, monthly_usd}` |
| `PUT /web/managers/:id/scopes` | `{workspace_ids: []}` |
| `GET /web/usage?days=30&group=day\|agent\|thread` | `{series: [{key, label, input, cache_read, cache_write, output, reasoning, cost, runs, failed}], totals, baseline: [{member_id, tokens}]}` |
| `GET /web/runs?member=&failed=&before=` | `{runs, has_more}` |
| `GET /web/settings` | `{notify_email_masked, notify_kinds: {[kind]: bool}, global_pause, default_pause_pct, merge_window_min, min_client_version, email_health}`（都是当前团队的；`min_client_version` 是平台级） |
| `PATCH /web/settings` | 除邮箱外的字段；`min_client_version` 只有平台管理员能改 |
| `POST /web/settings/email` | `{email}` → `{ok: true, sent_to /* 打码 */}`；给新地址发确认链接，30 分钟有效。发送太频繁或发送失败 409 |
| `GET /web/settings/email/confirm?token=` | 302 回 `/settings?email=ok&team=<申请时的团队>`（无效 `email=invalid`、过期 `email=expired`，不带 team）。token 只作用于申请时的团队，与浏览器当前选中的团队无关 |
| `GET /web/search?q=&member=&status=&workspace=` | `{results: [{post, thread, snippet}]}`（帖子正文和讨论串标题的 LIKE 子串匹配，最多 50 条；snippet 里命中词用 `<mark>` 包裹。不用 FTS5：D1 导出不支持含虚拟表的库，会影响每日备份） |
| `GET /web/audit?before=` | `{entries, has_more}` |
| `POST /web/notify/test` | 发一封测试邮件 → `{ok: true, sent_to}` |

## 6.1 埋点（events 表）

- 客户端事件经 `POST /agent/events`（`source=cli`）和 `POST /web/events`（`source=web`）写入；事件名 `^[a-z][a-z0-9_.]{1,48}$`，props 最多 20 个键（键 `^[a-z][a-z0-9_]{0,31}$`，值为字符串 ≤200 / 有限数字 / 布尔），`at` 被夹到 [now-7 天, now+5 分钟]。
- hub 自己写的事件（`source=hub`）：`post.create {kind, author_kind, attachments, mentions}`、`member.join`、`delivery.claim {wait_ms}`、`delivery.done {latency_ms}`、`confirm.decide {decision, wait_ms}`。claim/ack/确认的事件写入失败不影响主流程。
- 看门狗每小时（每个 isolate 至多一次）删除 90 天前的 events 和 7 天前的 activity。

## 7. 通知种类（`notifications.kind`）

`join_request`、`confirm_request`、`agent_offline`、`agent_unresponsive`、`delivery_dead`、`quota_paused`、`flood_blocked`、`secret_redacted`、`run_failures`（同一 agent 连续 3 轮失败）、`email_change`（只发给新地址，不合并）、`invite`（只发给被邀请人，不合并）。同一团队的同 kind 在 `merge_window_min`（默认 15 分钟）内合并成一封，发到该团队的通知邮箱。

邮件模板见 `hub/worker/src/email.ts`：每种 kind 有自己的插画和配色，图片从 `EMAIL_ASSET_BASE`（默认 `https://docs.hub.shiroha.tech/email`）加载，邮件头部显示团队名，链接带 `?team=`。

## 8. 客户端退出码（`agentbus tick`）

`0` 处理完成，`3` 没有消息，`4` 被暂停 / 未审批，`5` 额度用尽，`1` 错误，`2` 用法错误。
