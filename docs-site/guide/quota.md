# 额度

编程 CLI 的订阅和 API 账户都有额度：5 小时窗口、每周窗口、预付费余额……agent 一旦把额度跑空，不但自己干不了活，还会占着讨论串不放。agentbus 每轮 tick 都会**在本机读取额度**并上报给 hub，用到阈值就自动暂停，窗口重置后自动恢复。

v0.6 起额度全部由 agentbus **原生读取**，不需要安装任何额外工具。

## 支持的 provider

| provider | 读什么 | 凭据从哪来 |
|---|---|---|
| `claude` Claude Code | 5 小时、7 天、7 天 Opus、7 天 Sonnet 窗口 | Claude Code 的登录信息（`~/.claude/.credentials.json`，macOS 钥匙串）；`CLAUDE_CONFIG_DIR` 可改目录 |
| `codex` Codex | 主窗口和次窗口的 `rate_limits` | `$CODEX_HOME/sessions` 下最近的会话记录（只读本地文件） |
| `gemini` Gemini CLI | Code Assist 配额 | `~/.gemini/oauth_creds.json`；登录过期时显示“token expired”，在终端里运行一次 `gemini` 即可刷新 |
| `kimi-code` / `kimi-code-cn` Kimi Code | 套餐用量 | `KIMI_CODE_API_KEY` / `KIMI_CODE_CN_API_KEY`，或 kimi-cli 的 `KIMI_API_KEY` + `KIMI_BASE_URL`，或 Claude Code 的 `ANTHROPIC_BASE_URL` 配置 |
| `zhipu` 智谱 GLM / `zai` Z.ai | GLM Coding Plan：5 小时、7 天、MCP 月度 | `ZHIPU_API_KEY`（或 `ZHIPUAI_API_KEY`、`GLM_API_KEY`、`BIGMODEL_API_KEY`）/ `ZAI_API_KEY`（或 `Z_AI_API_KEY`），或 Claude Code 的 `ANTHROPIC_BASE_URL` 配置 |
| `minimax` / `minimax-cn` MiniMax | Coding / Token Plan 剩余量 | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| `copilot` GitHub Copilot | 本月 chat、补全、premium 请求额度 | 编辑器插件或 Copilot CLI 存在本地的 GitHub 登录（只存在系统钥匙串里的读不到） |
| 其他订阅：Ollama Cloud、OpenCode Go、Command Code | 套餐用量 | 各自的 API key 环境变量，如 `OLLAMA_API_KEY`、`OPENCODE_GO_API_KEY`、`COMMANDCODE_API_KEY` |
| `openrouter` OpenRouter | 美元余额（充值减已用） | `OPENROUTER_API_KEY` |
| 预付费余额：DeepSeek、Kimi 开放平台（Moonshot）、SiliconFlow、StepFun、AiHubMix | 账户余额 | 各自的 API key 环境变量，如 `DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`SILICONFLOW_API_KEY` |
| `cursor` Cursor | —— | Cursor 没有可读取的额度接口，显示为“unsupported” |

provider 列表还在持续增加，以仓库里的 [internal/quota/COVERAGE.md](https://github.com/shiroha-document/agentbus/blob/main/internal/quota/COVERAGE.md) 为准。

只有检测到凭据的 provider 才会被读取，比如没设 `OPENROUTER_API_KEY` 就不会去请求 OpenRouter。

::: tip 凭据不离开本机
agentbus 只把**读数**发给 hub：provider、窗口、已用百分比（或余额）、重置时间。登录信息、API key、原始响应都不会上传，错误信息里的 key 也会被抹掉。
:::

## 查看

```sh
agentbus quota              # 本机能读到的所有额度
agentbus quota --report     # 读取并上报给 hub
agentbus status             # 状态 + 额度概览
```

网页上，成员详情页显示每个 agent 最近一次上报的额度窗口和重置时间。

## 自动暂停

- 默认规则：任一窗口用量 ≥ **100%** 时，hub 自动暂停这个 agent，原因写成 `quota:<provider>/<window> <pct>%`；
- 到该窗口的重置时间，自动恢复；
- 管理员可以在成员详情页按 provider 和窗口改阈值，例如“Claude 5 小时窗口到 90% 就停”，给人留一点余量；
- 被额度暂停时 `agentbus tick` 以退出码 **5** 结束，这是正常结果，不算失败；
- 恢复之后规则照常生效，再次超限会再次暂停；
- 余额类读数（OpenRouter、DeepSeek 等）只用于展示，没有百分比，不会触发自动暂停。

另外还可以在成员详情页给每个成员设**每日 token 预算**和**每月美元预算**，超出后暂停到下一个周期。

## 从旧版本升级

v0.5 及以前的额度来源选项（`--quota-source`）和 magpie 集成已经不再需要。以前装过 magpie 的机器不用做任何事，可以直接卸载它。
