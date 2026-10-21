# Quota coverage

Every provider id in `testdata/magpie_providers.txt` (the provider list of
magpie, github.com/yetone/magpie, commit 75e769a9, which this package's
readers were ported from), and whether agentbus reads its quota or balance.
agentbus no longer runs magpie: a provider marked 未支持 is not reported.

Status:

- 已支持: read by this package, with credentials already on the machine
  (a sign-in file, an API key in the environment, Claude Code's
  `ANTHROPIC_BASE_URL` env or settings, or OpenCode's `auth.json`).
- 未支持: not read. The note says why.
- 不适用: has no quota or balance to read (local servers, routing-only
  models, another magpie).

`coverage_test.go` checks that every id in `testdata/magpie_providers.txt`
has a row here, and that every native provider is marked 已支持 (cursor,
which reports `unsupported`, is the one exception).

| provider id | name | native status | notes |
|---|---|---|---|
| claude | Claude Code | 已支持 | OAuth usage endpoint (`/api/oauth/usage`), with the sign-in from `~/.claude/.credentials.json` or the macOS keychain. Windows 5h, 7d, 7d_opus, 7d_sonnet. |
| codex | Codex | 已支持 | `rate_limits` of the newest `token_count` event in `$CODEX_HOME/sessions/**/rollout-*.jsonl`. Timed at the event, so an old session reads as old. |
| gemini | Gemini CLI | 已支持 | Code Assist `loadCodeAssist` + `retrieveUserQuota` with `~/.gemini/oauth_creds.json`. The token is not refreshed: once it expires the reading is the error "token expired". |
| cursor | Cursor CLI | 未支持 | Plugin-served in magpie, so there is no reader to port. When installed it gets one reading with Error "unsupported". |
| antigravity | Antigravity | 未支持 | Google sign-in held by the Antigravity app; magpie reads it only through its own Google sign-in, nothing on disk to reuse. |
| commandcode-plan | Command Code Plan | 已支持 | `GET api.commandcode.ai/alpha/billing/credits` with the CLI's key from `~/.commandcode/auth.json`. Windows 5h, 7d (used/cap); the credits balance on an account without a plan. |
| copilot | Copilot | 已支持 | `GET api.github.com/copilot_internal/user` with the GitHub token from `~/.config/github-copilot/apps.json` / `hosts.json` or the Copilot CLI's `~/.copilot/config.json` (keychain-only sign-ins are not read). Windows premium_monthly, chat_monthly, completions_monthly. |
| devin | Devin | 未支持 | Plugin-served in magpie (retired): no reader to port. |
| factory | Factory | 未支持 | Plugin-served in magpie (retired): no reader to port. |
| grok | Grok Build | 未支持 | Plugin-served in magpie (retired): no reader to port. |
| kiro | kiro | 未支持 | Plugin-served in magpie (deprecated): no reader to port. |
| mimo-app | Xiaomi MiMo | 未支持 | Plugin-served in magpie (retired): no reader to port. |
| chatgpt-api | ChatGPT API | 未支持 | Sign in with ChatGPT for API use. No allowance endpoint. |
| qoder | Qoder | 未支持 | Plugin-served in magpie: no reader to port. |
| qoder-cn | Qoder CN | 未支持 | Plugin-served in magpie: no reader to port. |
| workbuddy | WorkBuddy | 未支持 | Plugin-served in magpie: no reader to port. |
| workbuddy-ai | WorkBuddy AI | 未支持 | Plugin-served in magpie: no reader to port. |
| zcode | ZCode | 未支持 | Plugin-served in magpie (retired): no reader to port. |
| zed | Zed | 未支持 | Plugin-served in magpie (retired): no reader to port. |
| anthropic | Anthropic | 未支持 | No balance endpoint for an Anthropic API key. |
| openai | OpenAI | 未支持 | No balance endpoint for an OpenAI API key. |
| google | Google Gemini | 未支持 | Gemini API key: no balance endpoint. |
| google-vertex | Google Vertex AI | 未支持 | Billing lives in GCP and is not readable with the key. |
| deepseek | DeepSeek | 已支持 | `GET api.deepseek.com/user/balance`, one balance per currency. Key from `DEEPSEEK_API_KEY`, Claude Code's env or OpenCode. |
| xai | xAI | 未支持 | No balance endpoint for an API key (magpie has none). |
| moonshot | Kimi | 已支持 | `GET api.moonshot.ai/v1/users/me/balance`, USD. Key from `MOONSHOT_GLOBAL_API_KEY`, `MOONSHOT_API_KEY` (by `MOONSHOT_BASE_URL`), Claude Code's env or OpenCode. |
| moonshot-cn | Kimi (China) | 已支持 | `GET api.moonshot.cn/v1/users/me/balance`, CNY. |
| kimi-code | Kimi Code | 已支持 | `GET api.kimi.ai/coding/v1/usages`. Key from `KIMI_CODE_API_KEY`, kimi-cli's `KIMI_API_KEY`/`KIMI_BASE_URL`, or Claude Code's `ANTHROPIC_BASE_URL` env. |
| kimi-code-cn | Kimi Code (China) | 已支持 | `GET api.kimi.com/coding/v1/usages`. Key from `KIMI_CODE_CN_API_KEY`, kimi-cli's pair, or Claude Code's env. |
| zhipu | Zhipu GLM | 已支持 | GLM Coding Plan: `GET open.bigmodel.cn/api/monitor/usage/quota/limit`. Windows 5h, 7d, mcp_monthly. |
| zai | Z.ai | 已支持 | The same reader at `api.z.ai`. |
| minimax | MiniMax | 已支持 | Coding / Token Plan: `GET api.minimax.io/v1/token_plan/remains`. |
| minimax-cn | MiniMax (China) | 已支持 | The same reader at `api.minimaxi.com`. |
| stepfun | StepFun | 已支持 | `GET api.stepfun.ai/v1/accounts`, the USD balance. The Step Plan's own windows need a web sign-in and are not read. |
| stepfun-cn | StepFun (China) | 已支持 | `GET api.stepfun.com/v1/accounts`, CNY. Key from `STEPFUN_CN_API_KEY` or `STEPFUN_API_KEY`. |
| xiaomi | Xiaomi MiMo | 未支持 | No balance or quota endpoint for a key. |
| baidu-qianfan | Baidu Qianfan | 未支持 | No balance or quota endpoint for a key. |
| tencent-cloud | Tencent Cloud | 未支持 | Token Plan is readable only with the account's SecretId/SecretKey, not the API key. |
| huaweicloud | Huawei Cloud MaaS | 未支持 | No balance or quota endpoint for a key. |
| volcengine | Volcengine Ark | 未支持 | Coding/Agent Plan is readable only with the account's AK/SK, not the API key. |
| qwen | Qwen | 未支持 | No balance or quota endpoint for a key. |
| qwen-cn | Qwen (China) | 未支持 | No balance or quota endpoint for a key. |
| qwen-token-plan | Qwen Token Plan | 未支持 | No balance or quota endpoint for a key. |
| bailian-token-plan | Bailian Token Plan | 未支持 | No balance or quota endpoint for a key. |
| mistral | Mistral | 未支持 | No balance or quota endpoint for a key. |
| groq | Groq | 未支持 | No balance or quota endpoint for a key. |
| bedrock | Amazon Bedrock | 未支持 | AWS billing, not readable with the key. |
| bedrock-mantle | Amazon Bedrock (Mantle) | 未支持 | As bedrock. |
| azure | Azure OpenAI | 未支持 | Azure billing, not readable with the key. |
| ollama-cloud | Ollama Cloud | 已支持 | `GET ollama.com/api/balance`: session and 7d windows, the included allowance (monthly) and bought credits (USD balance). Key from `OLLAMA_API_KEY` or OpenCode. |
| nous | Nous Portal | 未支持 | No balance or quota endpoint for a key. |
| openrouter | OpenRouter | 已支持 | `GET openrouter.ai/api/v1/credits`, reported as a USD balance (credits less usage). |
| opencode-go | OpenCode Go | 已支持 | `GET opencode.ai/zen/go/v1/usage`: windows 5h, 7d, monthly. Key from `OPENCODE_GO_API_KEY`, OpenCode, or Claude Code on `opencode.ai/zen/go`. |
| clinepass | ClinePass | 已支持 | `GET api.cline.bot/api/v1/users/me/plan/usage-limits` (5h, 7d, monthly) and the account's credits. Key from `CLINE_API_KEY`. |
| opencode-zen | OpenCode Zen | 未支持 | The Zen balance is shown only in OpenCode's web console; no key endpoint. |
| kilo | Kilo Gateway | 未支持 | No balance endpoint for a key. |
| commandcode | Command Code | 已支持 | The same credits endpoint with `COMMANDCODE_API_KEY` (or Claude Code's env): the USD credits balance. |
| together | Together AI | 未支持 | No balance or quota endpoint for a key. |
| fireworks | Fireworks | 未支持 | No balance or quota endpoint for a key. |
| siliconflow | SiliconFlow | 已支持 | `GET api.siliconflow.cn/v1/user/info`, CNY. SiliconFlow retired the endpoint on 2026-08-14; a 410 or code 20092 reads as "SiliconFlow retired its balance query". |
| nvidia | NVIDIA NIM | 未支持 | No balance or quota endpoint for a key. |
| modelscope | ModelScope | 未支持 | No balance or quota endpoint for a key. |
| aihubmix | AiHubMix | 已支持 | `GET aihubmix.com/api/user/self` with `AIHUBMIX_ACCESS_TOKEN` (account balance), else `/dashboard/billing/remain` with `AIHUBMIX_API_KEY` (the key's own limit). |
| pipellm | PipeLLM | 未支持 | No balance or quota endpoint for a key. |
| 302ai | 302.AI | 未支持 | No balance or quota endpoint for a key. |
| cherryin | CherryIN | 未支持 | No balance or quota endpoint for a key. |
| yylx | 鱼鱼连线 | 未支持 | No balance or quota endpoint for a key. |
| typesafe | TypeSafe Jev | 未支持 | No balance or quota endpoint for a key. |
| vercel-jev | Jev · Vercel AI Gateway | 未支持 | No balance or quota endpoint for a key. |
| cloudflare-jev | Cloudflare Workers AI · Jev, Clef | 未支持 | No balance or quota endpoint for a key. |
| bailian-decision | Bailian Decision Model | 不适用 | Routing (decision) model. No quota of its own. |
| qwen-decision | Qwen Decision Model | 不适用 | Routing (decision) model. No quota of its own. |
| ollama | Ollama | 不适用 | Local server. |
| lmstudio | LM Studio | 不适用 | Local server. |
| omlx | oMLX | 不适用 | Local server. |
| mlx-serve | MLX-Serve | 不适用 | Local server. |
| remote-magpie | Remote magpie | 不适用 | Another computer's magpie. Its quotas are read there. |
