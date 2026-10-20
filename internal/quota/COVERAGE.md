# Quota coverage

Every provider magpie (github.com/yetone/magpie, commit 75e769a9) knows,
and whether agentbus reads its quota natively. Anything marked 未支持 is
still reported when magpie is installed (source auto, magpie or both),
because magpie's `magpie quota --json` cards are converted to readings.

Status:

- 已支持: read natively by this package.
- 未支持: not read natively. magpie still covers it if it can.
- 不适用: has no quota or balance to read (local servers, routing-only
  models, another magpie).

`coverage_test.go` checks that every id in `testdata/magpie_providers.txt`
has a row here, and that every native provider is marked 已支持 (cursor,
which reports `unsupported`, is the one exception).

| magpie id | name | native status | notes |
|---|---|---|---|
| claude | Claude Code | 已支持 | OAuth usage endpoint (`/api/oauth/usage`), with the sign-in from `~/.claude/.credentials.json` or the macOS keychain. Windows 5h, 7d, 7d_opus, 7d_sonnet. magpie uses `claude -p /usage` instead. |
| codex | Codex | 已支持 | `rate_limits` of the newest `token_count` event in `$CODEX_HOME/sessions/**/rollout-*.jsonl`. Timed at the event, so an old session reads stale and auto mode uses magpie's. |
| gemini | Gemini CLI | 已支持 | Code Assist `loadCodeAssist` + `retrieveUserQuota` with `~/.gemini/oauth_creds.json`. The token is not refreshed: once it expires the reading is the error "token expired". |
| cursor | Cursor CLI | 未支持 | Plugin-served in magpie, so there is no reader to port. When installed it gets one reading with Error "unsupported". |
| antigravity | Antigravity | 未支持 | Google sign-in held by the Antigravity app. |
| commandcode-plan | Command Code Plan | 未支持 | Plugin-served in magpie. |
| copilot | Copilot | 未支持 | GitHub sign-in + entitlement API. |
| devin | Devin | 未支持 | Plugin-served in magpie (retired). |
| factory | Factory | 未支持 | Plugin-served in magpie (retired). |
| grok | Grok Build | 未支持 | Plugin-served in magpie (retired). |
| kiro | kiro | 未支持 | Plugin-served in magpie (deprecated). |
| mimo-app | Xiaomi MiMo | 未支持 | Plugin-served in magpie (retired). |
| chatgpt-api | ChatGPT API | 未支持 | Sign in with ChatGPT for API use. No allowance endpoint. |
| qoder | Qoder | 未支持 | Plugin-served in magpie. |
| qoder-cn | Qoder CN | 未支持 | Plugin-served in magpie. |
| workbuddy | WorkBuddy | 未支持 | Plugin-served in magpie. |
| workbuddy-ai | WorkBuddy AI | 未支持 | Plugin-served in magpie. |
| zcode | ZCode | 未支持 | Plugin-served in magpie (retired). |
| zed | Zed | 未支持 | Plugin-served in magpie (retired). |
| anthropic | Anthropic | 未支持 | magpie has no balance method for Anthropic API keys. |
| openai | OpenAI | 未支持 | magpie has no balance method for OpenAI API keys. |
| google | Google Gemini | 未支持 | Gemini API key: no balance endpoint. |
| google-vertex | Google Vertex AI | 未支持 | Billing lives in GCP and is not readable with the key. |
| deepseek | DeepSeek | 未支持 | Balance endpoint. magpie reads it. |
| xai | xAI | 未支持 | |
| moonshot | Kimi | 未支持 | Balance endpoint. magpie reads it. |
| moonshot-cn | Kimi (China) | 未支持 | Balance endpoint. magpie reads it. |
| kimi-code | Kimi Code | 已支持 | `GET api.kimi.ai/coding/v1/usages`. Key from `KIMI_CODE_API_KEY`, kimi-cli's `KIMI_API_KEY`/`KIMI_BASE_URL`, or Claude Code's `ANTHROPIC_BASE_URL` env. |
| kimi-code-cn | Kimi Code (China) | 已支持 | `GET api.kimi.com/coding/v1/usages`. Key from `KIMI_CODE_CN_API_KEY`, kimi-cli's pair, or Claude Code's env. |
| zhipu | Zhipu GLM | 已支持 | GLM Coding Plan: `GET open.bigmodel.cn/api/monitor/usage/quota/limit`. Windows 5h, 7d, mcp_monthly. |
| zai | Z.ai | 已支持 | The same reader at `api.z.ai`. |
| minimax | MiniMax | 已支持 | Coding / Token Plan: `GET api.minimax.io/v1/token_plan/remains`. |
| minimax-cn | MiniMax (China) | 已支持 | The same reader at `api.minimaxi.com`. |
| stepfun | StepFun | 未支持 | Step Plan is readable only with a web sign-in. Balance via magpie. |
| stepfun-cn | StepFun (China) | 未支持 | As stepfun. |
| xiaomi | Xiaomi MiMo | 未支持 | |
| baidu-qianfan | Baidu Qianfan | 未支持 | |
| tencent-cloud | Tencent Cloud | 未支持 | Token Plan is readable only with the account's access key (magpie). |
| huaweicloud | Huawei Cloud MaaS | 未支持 | |
| volcengine | Volcengine Ark | 未支持 | Coding/Agent Plan is readable only with the account's access key (magpie). |
| qwen | Qwen | 未支持 | |
| qwen-cn | Qwen (China) | 未支持 | |
| qwen-token-plan | Qwen Token Plan | 未支持 | |
| bailian-token-plan | Bailian Token Plan | 未支持 | |
| mistral | Mistral | 未支持 | |
| groq | Groq | 未支持 | |
| bedrock | Amazon Bedrock | 未支持 | AWS billing, not readable with the key. |
| bedrock-mantle | Amazon Bedrock (Mantle) | 未支持 | As bedrock. |
| azure | Azure OpenAI | 未支持 | Azure billing, not readable with the key. |
| ollama-cloud | Ollama Cloud | 未支持 | Included allowance. magpie reads it. |
| nous | Nous Portal | 未支持 | |
| openrouter | OpenRouter | 已支持 | `GET openrouter.ai/api/v1/credits`, reported as a USD balance (credits less usage). |
| opencode-go | OpenCode Go | 未支持 | Plan windows. magpie reads them. |
| clinepass | ClinePass | 未支持 | |
| opencode-zen | OpenCode Zen | 未支持 | Balance. magpie reads it. |
| kilo | Kilo Gateway | 未支持 | |
| commandcode | Command Code | 未支持 | Credits balance. magpie reads it. |
| together | Together AI | 未支持 | |
| fireworks | Fireworks | 未支持 | |
| siliconflow | SiliconFlow | 未支持 | Balance endpoint. magpie reads it. |
| nvidia | NVIDIA NIM | 未支持 | |
| modelscope | ModelScope | 未支持 | |
| aihubmix | AiHubMix | 未支持 | Account balance. magpie reads it. |
| pipellm | PipeLLM | 未支持 | |
| 302ai | 302.AI | 未支持 | |
| cherryin | CherryIN | 未支持 | |
| yylx | 鱼鱼连线 | 未支持 | |
| typesafe | TypeSafe Jev | 未支持 | |
| vercel-jev | Jev · Vercel AI Gateway | 未支持 | |
| cloudflare-jev | Cloudflare Workers AI · Jev, Clef | 未支持 | |
| bailian-decision | Bailian Decision Model | 不适用 | Routing (decision) model. No quota of its own. |
| qwen-decision | Qwen Decision Model | 不适用 | Routing (decision) model. No quota of its own. |
| ollama | Ollama | 不适用 | Local server. |
| lmstudio | LM Studio | 不适用 | Local server. |
| omlx | oMLX | 不适用 | Local server. |
| mlx-serve | MLX-Serve | 不适用 | Local server. |
| remote-magpie | Remote magpie | 不适用 | Another computer's magpie. Its quotas are read there. |
