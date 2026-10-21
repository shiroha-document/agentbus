# Third-party notice

Parts of this package are ported from **magpie**
(https://github.com/yetone/magpie, commit
75e769a9f9b419f805b925f147146eff179111b9), which is under the MIT License
below. A port here means the endpoints, request shapes and reply parsing were
rewritten in this package's own types. No magpie code is imported or linked.

## Files ported

| agentbus file (internal/quota/) | magpie file(s) | what was taken |
|---|---|---|
| claude.go | internal/provider/account.go, internal/provider/claude_limits.go | where Claude Code keeps its sign-in (`.credentials.json` / `claudeAiOauth`), hex-encoded keychain values, the usage window keys (`five_hour`, `seven_day`, `seven_day_opus`, …) |
| claude_keychain_darwin.go | internal/provider/account.go, internal/provider/claude_dirs.go | the keychain item name `Claude Code-credentials` and its suffix for a `CLAUDE_CONFIG_DIR` |
| codex.go | internal/gateway/codex_limits.go, internal/sessions/codex.go, internal/provider/subscription_usage.go | the `rate_limits` shape (`primary`/`secondary`, `used_percent`, `window_minutes`, `resets_at`), the rollout layout, `limit_id` filtering, rounding the window length |
| plans.go | internal/provider/planquota.go | the Zhipu / Z.ai, Kimi Code and MiniMax plan endpoints and their reply parsing |
| openrouter.go | internal/provider/balance.go | the OpenRouter credits endpoint and balance arithmetic |
| gemini.go | internal/provider/google.go | the Code Assist `loadCodeAssist` / `retrieveUserQuota` calls and bucket parsing |
| balances.go | internal/provider/balance.go | the DeepSeek, Moonshot, SiliconFlow, StepFun and AiHubMix balance endpoints and their reply parsing |
| subscriptions.go | internal/provider/ollama_usage.go, internal/provider/planquota.go, internal/provider/commandcode_plan.go, internal/provider/opencode_client.go | the Ollama Cloud balance, OpenCode Go usage (and its session headers) and Command Code credits endpoints, plan names and reply parsing |
| copilot.go | internal/provider/subscription_usage.go, internal/provider/account.go, internal/provider/copilot_cli.go, internal/provider/copilot_entitlement.go, internal/provider/copilot_accounts.go | where the Copilot plugins and CLI keep their GitHub token, the `copilot_internal/user` request headers, plan labels and quota snapshot parsing |
| cline.go | internal/provider/cline_usage.go, internal/provider/cline.go | the ClinePass usage-limits and credits endpoints, the Cline client headers and the `{success, data}` envelope |
| keys.go | internal/provider/import_opencode.go | OpenCode's `auth.json` location and entry shape |
| windows.go | internal/provider/subscription_usage.go | window naming ("5 hours", "7 days · Opus" …) |

The rest of this package (quota.go, provider.go, httpx.go, the rest of
keys.go, cursor.go, claude_keychain_other.go and the tests) is original to
agentbus. magpie itself is no longer run.

## License

```
MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
