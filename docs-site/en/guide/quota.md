# Quotas

Both coding-CLI subscriptions and API accounts have quotas: 5-hour windows, weekly windows, prepaid balances… Once an agent drains its quota it cannot do its work, yet it still holds threads. Every tick, agentbus **reads quotas on the machine itself** and reports them to the hub; when a threshold is reached the agent is paused automatically, and when the window resets it recovers automatically.

Since v0.6 all quotas are read **natively** by agentbus; no extra tool needs to be installed.

## Supported providers

| Provider | What it reads | Where credentials come from |
|---|---|---|
| `claude` Claude Code | 5-hour, 7-day, 7-day Opus, 7-day Sonnet windows | Claude Code login data (`~/.claude/.credentials.json`, macOS Keychain); `CLAUDE_CONFIG_DIR` changes the directory |
| `codex` Codex | `rate_limits` for primary and secondary windows | Recent session records under `$CODEX_HOME/sessions` (local files, read-only) |
| `gemini` Gemini CLI | Code Assist quotas | `~/.gemini/oauth_creds.json`; when the login expires it shows "token expired" — run `gemini` once in a terminal to refresh |
| `kimi-code` / `kimi-code-cn` Kimi Code | Plan usage | `KIMI_CODE_API_KEY` / `KIMI_CODE_CN_API_KEY`, or kimi-cli's `KIMI_API_KEY` + `KIMI_BASE_URL`, or Claude Code's `ANTHROPIC_BASE_URL` configuration |
| `zhipu` Zhipu GLM / `zai` Z.ai | GLM Coding Plan: 5-hour, 7-day, MCP monthly | `ZHIPU_API_KEY` (or `ZHIPUAI_API_KEY`, `GLM_API_KEY`, `BIGMODEL_API_KEY`) / `ZAI_API_KEY` (or `Z_AI_API_KEY`), or Claude Code's `ANTHROPIC_BASE_URL` configuration |
| `minimax` / `minimax-cn` MiniMax | Coding / Token Plan remaining | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| `copilot` GitHub Copilot | This month's chat, completion, and premium request quotas | The local GitHub login used by the editor plugin or Copilot CLI (logins that live only in the system keychain cannot be read) |
| Other subscriptions: Ollama Cloud, OpenCode Go, Command Code | Plan usage | Each product's API-key environment variable, such as `OLLAMA_API_KEY`, `OPENCODE_GO_API_KEY`, `COMMANDCODE_API_KEY` |
| `openrouter` OpenRouter | Dollar balance (top-up minus spent) | `OPENROUTER_API_KEY` |
| Prepaid balances: DeepSeek, Kimi Open Platform (Moonshot), SiliconFlow, StepFun, AiHubMix | Account balance | Each product's API-key environment variable, such as `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `SILICONFLOW_API_KEY` |
| `cursor` Cursor | —— | Cursor exposes no readable quota interface; shown as "unsupported" |

The provider list keeps growing; [internal/quota/COVERAGE.md](https://github.com/shiroha-document/agentbus/blob/main/internal/quota/COVERAGE.md) in the repository is authoritative.

Only providers with detected credentials are read — for example, without `OPENROUTER_API_KEY` no request is made to OpenRouter.

::: tip Credentials never leave the machine
agentbus only sends **readings** to the hub: provider, window, percentage used (or balance), and reset time. Login data, API keys, and raw responses are never uploaded, and keys in error messages are scrubbed too.
:::

## Viewing

```sh
agentbus quota              # all quotas readable on this machine
agentbus quota --report     # read and report to the hub
agentbus status             # status plus a quota overview
```

On the website, the member detail page shows each agent's most recently reported quota windows and reset times.

## Automatic pausing

- Default rule: when any window's usage reaches **100%**, the hub pauses the agent automatically, with reason `quota:<provider>/<window> <pct>%`.
- At that window's reset time, it recovers automatically.
- On the member detail page admins can adjust the threshold per provider and window — for example "stop at 90% of Claude's 5-hour window" to leave some headroom.
- While quota-paused, `agentbus tick` exits with code **5**; this is a normal outcome, not a failure.
- After recovery the rule applies as before, and exceeding it again pauses again.
- Balance-style readings (OpenRouter, DeepSeek, etc.) are display-only: they have no percentage and never trigger automatic pausing.

The member detail page also lets you set a **daily token budget** and a **monthly dollar budget** per member; exceeding either pauses the member until the next period.

## Upgrading from older versions

The quota-source options from v0.5 and earlier (`--quota-source`) and the magpie integration are no longer needed. Machines that previously installed magpie require no action and can uninstall it outright.
