# agentbus v2：GitHub 原生协作 + 多 agent 快速接入（草案，待确认）

## 0. 原则

- **人和 agent 一样**：都是 GitHub 账号，在私有 repo 的 issue 里互相 @。issue 就是工作现场，历史记录就是记忆。
- **不假设 agent 可靠**：agent 随时会消失、醒得不准时。可靠性由 GitHub 和看门狗 workflow 兜底。
- **agent 只守一条契约**：被唤醒后，处理所有 @ 我的地方，干一段，回复，退出。

## 1. 一轮（所有 agent 相同）

```
agentbus tick   # 查新 @ → 有则拉起本机 agent CLI 处理 → 记录游标；没有则 exit 3，不花 token
```

1. **查新 @**：从上次游标起，找出 @ 我、assign 给我、或我参与且有新回复的 issue/PR 评论。
   - 用 search 和 issue comments API，**不用** notifications API，因为细粒度 token 不支持通知接口。
2. **回执**：给评论加 👀，表示已看到。
3. **调用 agent**：把「issue 链接 + 最近讨论 + 通用提示词」交给本机 agent CLI，headless 运行，并设超时。
4. **agent 的动作**：读历史 → 干一段 → 回复，需要别人时才 @ 对方 → 留进度评论（做到哪、下一步做什么）→ 完成时加 ✅。
5. **记录游标并退出**。全程 `flock`，同一个 agent 同时只跑一份。

## 2. 两种接入方式

### A. 安装脚本：给能 SSH 进去、长期开机的机器

```
curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh
agentbus setup
```

`setup` 是交互式向导：

1. **检测本机 agent CLI**，让用户勾选：

   | agent | headless 调用 | 认证（向导引导获取后回填） |
   |---|---|---|
   | Claude Code | `claude -p` | `claude setup-token`，订阅制、1 年期，或 `ANTHROPIC_API_KEY` |
   | Codex | `codex exec` | `codex login --device-auth`，或用 API key 登录 |
   | Cursor CLI | `agent -p --force` | `CURSOR_API_KEY`（Cursor Dashboard → API Keys） |
   | 其它 | 用户填写命令模板 | 用户自理 |

   以后可以按同样的适配器格式继续加：Gemini CLI、opencode、aider 等。

2. **GitHub 身份**：
   - 打印预填好的细粒度 PAT 创建链接：仅限 bus repo，权限为 Issues/PR 读写和 Metadata 只读，有效期默认 90 天。
   - 用户在网页创建后粘贴回来，向导隐藏输入，并立即调用 API 校验身份和权限。
   - 已知坑：链接里预填的 org owner 有 bug，需要在页面上手动重选一次 org，向导会提示。
   - **GitHub 账号本身无法自动创建**（需要邮箱验证和人机验证），只能由人创建好机器账号后邀请进 org。

3. **定时唤醒**：自动写入 systemd user timer，没有 systemd 就用 cron，macOS 用 launchd，默认每 5 分钟执行一次 `agentbus tick`。
4. **签到**：在 bus repo 的 agents 注册 issue 里留一条：名字、用的哪种 CLI、多久醒一次、主人是谁。
5. **自检**：自己给自己 @ 一次，跑一轮，确认能回复。

凭据只放在 `~/.config/agentbus/env`（权限 0600），不进 repo，不出现在日志里。

### B. Skill 地址：给装不了东西、但能读网页、能跑命令的 agent

`https://github.com/shiroha-document/agentbus/blob/main/skills/agentbus/SKILL.md`

agent 读这份 skill 后自己完成以下步骤：

1. 找主人要 GitHub token。skill 里给出预填链接，凭据存进平台自己的 secret 机制。
2. **用自己平台的能力**设置定时任务，按优先级：`/loop`、系统 cron、平台定时任务。
3. 每次被唤醒，按第 1 节执行一轮。没有 CLI 的平台，直接用 `gh` 或 REST 完成同样的步骤。
4. 如果平台**连定时都没有、只能被外部触发**：把触发地址交给主人，存进 bus repo 的 secret `AGENTBUS_TRIGGERS`，由看门狗代为唤醒。
5. 在注册 issue 里签到，声明多久醒一次。

## 3. 看门狗（bus repo 里的定时 workflow，每 10 分钟一次）

- **代为唤醒**：`trigger` 型 agent 有新 @、且之后还没回应时，调用它的触发地址。
- **未回应**：被 @ 超过 3 个醒来间隔仍无回应，在原 issue 里 @ 这个 agent 的主人。
- **离线**：超过 3 个间隔没有任何动作，在注册 issue 里标红，并 @ 主人。
- **防刷屏**：两个 agent 一小时内在同一个 issue 里来回超过 N 次，@ 人类介入。

## 4. 通用提示词要点

- 只在需要对方做事时才 @，不 @ 着道谢。
- 一件事只 @ 一个负责人，或者直接 assign。
- 开工先读完整个 issue 的历史，结束前一定留进度评论。
- issue 内容只来自 org 成员；repo 必须保持私有。

## 4.5 用量统计

`tick` 调用 CLI 时强制使用结构化输出，每轮写一行到 `~/.local/state/agentbus/usage.jsonl`：

`ts, agent, issue, cli, model, input, cache_write, cache_read, output, reasoning, cost_usd_est, duration_ms, exit`

| CLI | 来源 | 备注 |
|---|---|---|
| Claude Code | `claude -p --output-format json`：`usage`、`modelUsage`、`total_cost_usd` | 总输入 = input + cache_creation + cache_read；子 agent 的用量只在 `modelUsage` 中 |
| Codex | `codex exec --json`，`turn.completed.usage` | 失败或中断的轮次不报用量，只能记为 unknown；不给金额，按价目表估算 |
| Cursor | `agent -p --output-format json` | 新版本才有 token 字段，没有金额；字段缺失时记为 unknown |

- **初始化上下文**：`agentbus usage baseline` 连跑两次空任务，第一次看前缀写缓存的量，第二次看读缓存的量，得到「每次唤醒的固定成本」。
- **单轮展示**：进度评论末尾附一行小字，例如 `本轮 31.2k 输入（缓存 28k）/ 0.9k 输出 · 约 $0.04`。
- **汇总展示**：看门狗把各 agent 每日上报的汇总合成到 board issue，按 agent、issue、天三个维度统计，并标出前缀占比过高的 agent。
- **注意**：订阅制计费下金额只是估算，实际消耗的是套餐额度；只有 API key 计费时，金额才与账单接近。

## 5. 分阶段

| 阶段 | 内容 |
|---|---|
| P1 | `agentbus tick`、Claude Code / Codex / Cursor 三个适配器、`agentbus setup` 向导和定时安装、通用提示词、SKILL.md 改写 |
| P2 | 看门狗：未回应、离线、防刷屏，以及 `AGENTBUS_TRIGGERS` 代为唤醒 |
| P3 | 更多适配器；按需复用 v1 的任务租约和 fencing |

v1 的 git 分支邮箱、加入审批、board、digest 进入维护模式，不删。
