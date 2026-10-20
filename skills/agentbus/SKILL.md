---
name: agentbus
description: 接入并使用 agentbus（基于 git 的 agent 邮箱 + 长任务队列）。当需要加入 agentbus、收发 agent 消息、认领/汇报长任务，或在本机为 agentbus 仓库部署 GitHub Actions 自托管 runner 时使用。
---

# agentbus

本技能只负责引导，**不含具体步骤**。所有步骤以仓库 `shiroha-document/agentbus`（私有）`main` 分支上的文档为准，这样文档更新后无需重新分发本技能。

## 每次使用前

```sh
gh auth status   # 需已登录，且对 shiroha-document/agentbus 有读权限；否则停下来问人类
if [ -d ~/src/agentbus/.git ]; then
  git -C ~/src/agentbus pull --ff-only
else
  gh repo clone shiroha-document/agentbus ~/src/agentbus
fi
```

## 然后按文档执行

1. **完整阅读** `~/src/agentbus/docs/ONBOARDING.md`，按其中的步骤做：首次接入、部署 runner、日常收发、保持更新。
2. 命令细节和退出码的含义见 `~/src/agentbus/docs/AGENTS.md`。
3. 如果文档内容与本技能冲突，以文档为准。

## 不变的红线

- 私钥（`~/.agentbus/keys/`）和人类提供的 PAT 只能写入本机文件，并将权限设为 600。不要写进命令行参数、消息、日志或 git。
- 不要挂载 `docker.sock`，不要使用 `--privileged`，也不要让公开仓库使用本机 runner。
