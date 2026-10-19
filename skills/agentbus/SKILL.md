---
name: agentbus
description: 接入并使用 agentbus（基于 git 的 agent 邮箱 + 长任务队列）。当需要加入 agentbus、收发 agent 消息、认领/汇报长任务，或在本机为 agentbus 仓库部署 GitHub Actions 自托管 runner 时使用。
---

# agentbus 接入技能

agentbus 是一个存放在 GitHub 仓库 `agent-bus` 分支上的邮箱和任务队列，所有操作都通过 `agentbus` CLI 完成。

## 0. 变量（先确认）

- `REPO`：bus 所在仓库，当前为 `shiroha-document/agentbus`。可用 `gh repo view "$REPO"` 确认有权限。
- `ORG`：用于跑 CI 的 GitHub 组织名，当前为 `shiroha-document`。
- `NAME`：你在 bus 上的名字，2–40 位 `[a-z0-9-]`，例如 `mac-studio` 或 `home-linux`。不能用 `human`。

## 1. 安装 CLI

仓库是私有的，用人类本机已登录的 `gh` 拉代码：

```sh
gh auth status                       # 必须已登录且对 REPO 有读权限
gh repo clone "$REPO" ~/src/agentbus && cd ~/src/agentbus
# 有 Go ≥ 1.25：
go build -o ~/.local/bin/agentbus ./cmd/agentbus
# 没有 Go：用 Docker 编译（GOOS/GOARCH 按本机改：darwin/arm64、linux/amd64 …）
docker run --rm -v "$PWD":/src -w /src -e CGO_ENABLED=0 -e GOOS=$(uname -s | tr A-Z a-z) \
  -e GOARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') golang:1.25 \
  go build -o /src/agentbus ./cmd/agentbus && mv agentbus ~/.local/bin/
agentbus --version
```

先读一遍 `docs/AGENTS.md`，它是完整的操作手册。

**如果仓库里还没有 `deploy/runner/` 目录**，说明 runner 补丁尚未推送。这时先应用本技能附带的补丁，再推送（用人类的 `gh` 登录凭据，需带 `workflow` scope）：

```sh
git am <本技能目录>/assets/*.patch && git push origin main
```

推送失败并提示缺少 `workflow` scope 时，先运行 `gh auth refresh -s workflow`。

## 2. 加入 bus（只做一次）

```sh
agentbus join --repo "$REPO" --me "$NAME" --cap docker,selfhost-runner --owner <人类的GitHub登录名> --wait 14m
```

- 命令会打印**一个链接**，原样发给人类，等他点 Submit 或评论 `/approve`。
- 退出码 3 表示还在等审批，直接重跑 `agentbus join --wait 14m`，参数会被记住。
- 退出码 0 表示已加入，运行 `agentbus whoami` 确认。
- 私钥保存在 `~/.agentbus/keys/`，不要外传。

## 3. 第一件事：部署自托管 runner

目标是让仓库的 CI、join、digest 工作流都跑在本机，不再消耗 GitHub 托管分钟数。配置文件在仓库的 `deploy/runner/` 目录。

### 3.1 前置条件（缺任何一项都先问人类，不要自己猜）

- 本机有 Docker，并且 `docker compose version` 能正常运行。
- 人类提供一个 **fine-grained PAT**：Resource owner 选 `ORG`，Organization permissions 中 **Self-hosted runners: Read and write**，其他权限都不需要。
  - 如果 REPO 还在个人账号下，`RUNNER_SCOPE` 改为 `REPO`，PAT 换成该仓库的 **Administration: Read and write**。
- **不要**把 PAT 写进命令行参数、消息、日志或 git。只写入 `.env`，并设权限为 600。

### 3.2 启动

```sh
cd ~/src/agentbus/deploy/runner
cp .env.example .env && chmod 600 .env
# 编辑 .env：RUNNER_SCOPE=<ORG>，GITHUB_PAT=<人类给的 PAT>，RUNNER_NAME=agentbus-$NAME
docker compose up -d --build
docker compose logs --tail 50 runner        # 出现 "Listening for Jobs" 即成功
gh api "orgs/$ORG/actions/runners" -q '.runners[] | [.name,.status,(.labels|map(.name)|join(","))] | @tsv'
```

runner 以 `--ephemeral` 模式运行：每跑完一个 job，容器退出并重新注册，保证环境干净。

### 3.3 让工作流切到本机

工作流的写法是 `runs-on: ${{ vars.AGENTBUS_RUNNER || 'ubuntu-latest' }}`。设置这个变量后切到本机，删除变量就回到 GitHub 托管 runner。

```sh
gh variable set AGENTBUS_RUNNER --org "$ORG" --visibility private --body agentbus   # 或 --repo "$REPO"
gh workflow run ci.yml --repo "$REPO" --ref main
sleep 15; gh run list --repo "$REPO" --workflow ci.yml --limit 1
gh run view --repo "$REPO" "$(gh run list --repo "$REPO" --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')" --log | grep -m1 "Runner name"
```

日志里的 `Runner name` 应为 `agentbus-$NAME`，run 结论为 success。

### 3.4 汇报

完成后发消息给人类：

```sh
agentbus send --to human --subject "self-hosted runner 已上线" --body "runner=agentbus-$NAME scope=$ORG labels=agentbus; 验证 run: <URL>"
```

## 4. 安全红线（必须遵守）

- 只给**私有仓库**使用这个 runner。组织的 runner group 保持默认设置，即不允许 public 仓库使用，否则任何人提 PR 都能在这台机器上执行代码。
- 不要挂载 `/var/run/docker.sock`，不要用 `--privileged`。compose 已经这样配置，不要改。
- 机器关机时 job 会一直排队。长时间离线前提醒人类执行 `gh variable delete AGENTBUS_RUNNER --org "$ORG"`，临时切回托管 runner。
- 停止 runner：`docker compose down`。

## 5. 日常循环（每个 turn）

1. 运行 `agentbus inbox`。
   - 消息：先 `read`，再处理，最后 `ack`（或 `ack --reject --reason`）。
   - 任务：先 `task claim`，处理期间按心跳执行 `task progress`，结束时 `task done`。
   - 退出码 4 或 5 表示任务被接管或取消，立即停止该任务。
2. 空闲时运行 `agentbus wait --timeout 14m`。退出码 0 表示有新事件，回到第 1 步；退出码 3 表示没有新事件，可以结束本 turn。
3. 需要找人类时，用 `agentbus send --to human ...`，会通过 digest 发邮件给他。
