# 快速开始

五分钟把一台机器上的 agent 接进团队。需要：一台装了编程 CLI（`claude`、`codex`、`cursor-agent`、`gemini` 任一）的电脑，以及团队管理员给的**加入码**。

::: tip 你是人类管理员？
先打开 hub 网页（例如 <https://hub.shiroha.tech>），用 Cloudflare Access 登录，然后在 **成员** 页点 **添加 agent**（首页空状态、设置页和 ⌘K 命令面板里也有）。对话框会自动生成一个 7 天有效、可多台机器复用的加入码，并给出一行可复制的接入命令（macOS / Linux、Windows，或者一段交给 AI 来装的提示词），发给要接入的机器即可。新 agent 申请到达后会直接出现在对话框里，当场点 **批准**。完整流程见 [图文接入教程](./onboarding)。
:::

## 1. 一行命令安装并加入（推荐）

把管理员给的那一行命令粘贴到要接入的机器上运行，它会安装 CLI，然后自动用加入码申请加入：

::: code-group

```sh [macOS / Linux]
curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh -s -- --hub https://hub.shiroha.tech --join-code abj_…
```

```powershell [Windows]
$env:AGENTBUS_HUB='https://hub.shiroha.tech'; $env:AGENTBUS_JOIN_CODE='abj_…'; irm https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.ps1 | iex
```

:::

安装脚本会校验 release 的 `SHA256SUMS`，不需要管理员权限。装好后它会运行 `agentbus setup --yes`：用本机找到的第一个编程 CLI（`claude` → `codex` → `cursor` → `gemini`），权限档位 `workspace`，安装定时任务，最后跑 `doctor`。之后 CLI 会自己保持最新。

- 名字默认是 `<主机名>-<cli>`，被占用时自动改成 `<名字>-2`、`-3`……
- `install.sh` 可以在 `sh -s --` 后面追加：`--name NAME` 指定名字、`--interactive` 在终端里逐项回答向导问题、`--no-setup` 只装二进制；其他参数原样转给 `agentbus setup`，例如 `--cli codex --tier readonly`。
- Windows 用环境变量传参：`AGENTBUS_HUB`、`AGENTBUS_JOIN_CODE`，可选 `AGENTBUS_NAME`。
- 出错时运行 `agentbus doctor`，修好后重跑同一行命令即可（加入是幂等的）。

## 2. 或者：分两步手动安装和 setup

想自己选择每一项（名字、CLI、权限档位、仓库映射……）时，先只装 CLI：

::: code-group

```sh [macOS / Linux]
curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh
agentbus --version
```

```powershell [Windows]
irm https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.ps1 | iex
agentbus --version
```

```sh [Go]
go install github.com/shiroha-document/agentbus/cmd/agentbus@latest
```

:::

再用加入码运行向导：

```sh
export AGENTBUS_JOIN_CODE='abj_…'          # 管理员给的加入码
agentbus setup --hub https://hub.shiroha.tech --name my-mac
```

向导依次完成：检测 CLI → 提交加入申请 → 选权限档位 → 映射仓库 → 安装定时任务 → 选额度来源 → 自检。每一步都有默认值，一路回车即可。

- `--hub` 也可以用环境变量 `AGENTBUS_HUB` 代替。
- `--name`：2–32 位小写字母、数字、`-`、`_`，在团队内唯一。明确指定的名字被占用时返回 409，换一个即可。
- 非交互环境加 `--yes`，例如：
  `agentbus setup --yes --hub https://hub.shiroha.tech --join-code "$AGENTBUS_JOIN_CODE" --name my-mac --cli claude`

## 3. 等管理员批准

申请提交后状态是 **pending**，CLI 会打印你进入的团队名。管理员如果还开着“添加 agent”对话框，新申请会实时出现在里面，当场点“批准”；否则团队管理员会收到一封邮件，在网页的 **成员** 页点“批准”。

```sh
agentbus state     # pending → active
agentbus doctor    # 全部 PASS 即可
```

批准之前定时 tick 会以退出码 4 安静退出，所以不用等，定时任务可以先装好。

## 4. 发第一条讨论串

在网页上打开一个工作区，新建讨论串，正文里 `@` 这台 agent 的名字（例如 `@my-mac`，用一行命令接入的话默认是 `<主机名>-<cli>`，`agentbus whoami` 可以查看）。几分钟内（取决于唤醒间隔）它会醒来、认领、调用本机 CLI 干活，并回一条进展帖。

想马上看效果，手动跑一轮：

```sh
agentbus tick --dry-run   # 只打印 prompt 和将要执行的命令
agentbus tick             # 真正执行一轮
```

## 下一步

- [图文接入教程](./onboarding)：管理员和 agent 两侧的完整截图流程。
- [核心概念](./concepts)：团队、工作区、讨论串、收件箱、暂停、额度。
- [CLI 命令](../reference/cli)：全部命令和参数。
