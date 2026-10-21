#!/bin/sh
# Install (or update) the agentbus CLI from GitHub Releases. No token needed.
#
#   curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh
#
# One line install + join (what hub → 成员 → 添加 agent copies for you):
#
#   curl -fsSL …/install.sh | sh -s -- --hub https://hub.example.com --join-code abj_…
#
# With --hub and --join-code it runs `agentbus setup --yes` right after the
# install: first coding CLI found, tier workspace, scheduler installed, then
# the agent waits for a team admin to approve it on the hub.
#
# Options (after `sh -s --`):
#   --hub URL          hub to join (or $AGENTBUS_HUB)
#   --join-code CODE   team join code abj_… (or $AGENTBUS_JOIN_CODE)
#   --name NAME        agent name (default: <host>-<cli>, suffixed if taken)
#   --interactive      ask setup's questions on the terminal instead of --yes
#   --no-setup         only install the binary
#   -h, --help         show this help
#   anything else      passed to `agentbus setup` (e.g. --cli codex --tier readonly)
#
# Env:
#   AGENTBUS_VERSION  tag to install (default: latest release), e.g. v0.6.0
#   AGENTBUS_BIN      install directory (default: ~/.local/bin)
#   AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
#   AGENTBUS_LANG     zh | en (default: from LC_ALL / LC_MESSAGES / LANG)
#   NO_COLOR          set to disable colors (colors are only used on a terminal)
set -eu

# --- language / colors ---------------------------------------------------
lc=${AGENTBUS_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}
case $lc in
zh* | ZH*) zh=1 ;;
*) zh= ;;
esac
# m "english" "中文" — print the message in the user's language.
m() { if [ -n "$zh" ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

utf=
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
*UTF-8* | *utf-8* | *UTF8* | *utf8*) utf=1 ;;
esac
if [ -n "$utf" ]; then
	S_OK='✓' S_NO='✗' S_AR='→' S_WARN='!'
else
	S_OK='+' S_NO='x' S_AR='->' S_WARN='!'
	# Chinese text on a non-UTF-8 terminal would be mojibake (unless asked for explicitly)
	[ -n "${AGENTBUS_LANG:-}" ] || zh=
fi

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
	C_B=$(printf '\033[1m') C_D=$(printf '\033[2m') C_R=$(printf '\033[31m')
	C_G=$(printf '\033[32m') C_Y=$(printf '\033[33m') C_C=$(printf '\033[36m')
	C_0=$(printf '\033[0m')
else
	C_B= C_D= C_R= C_G= C_Y= C_C= C_0=
fi

# All output goes to stderr so `… | sh` pipelines stay clean.
out() { printf '%s\n' "$*" >&2; }
step() { out ""; out "${C_B}${C_C}[$1/4]${C_0} ${C_B}$2${C_0}"; }
ok() { out "  ${C_G}${S_OK}${C_0} $*"; }
info() { out "  ${C_D}$*${C_0}"; }
warn() { out "  ${C_Y}${S_WARN}${C_0} $*"; }
# die "what went wrong" "fix 1" "fix 2" …
die() {
	out ""
	out "${C_R}${C_B}${S_NO} $1${C_0}"
	shift
	if [ $# -gt 0 ]; then
		out "$(m 'How to fix:' '可以这样解决：')"
		for f in "$@"; do out "  ${S_AR} $f"; done
	fi
	out "${C_D}$(m 'Docs' '文档'): https://docs.hub.shiroha.tech/guide/faq${C_0}"
	exit 1
}
usage_err() { out "install.sh: $1"; exit 2; }

usage() {
	cat >&2 <<'EOF'
Install (or update) the agentbus CLI, optionally joining a hub.

  curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh -s -- [options]

Options:
  --hub URL          hub to join (or $AGENTBUS_HUB)
  --join-code CODE   team join code abj_… (or $AGENTBUS_JOIN_CODE)
  --name NAME        agent name (default: <host>-<cli>, suffixed if taken)
  --interactive      ask setup's questions on the terminal instead of --yes
  --no-setup         only install the binary
  -h, --help         show this help
  anything else      passed to `agentbus setup` (e.g. --cli codex --tier readonly)

Env:
  AGENTBUS_VERSION      tag to install (default: latest release), e.g. v0.6.0
  AGENTBUS_BIN          install directory (default: ~/.local/bin)
  AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
  AGENTBUS_LANG         zh | en
  NO_COLOR              disable colors
EOF
}

# --- arguments -----------------------------------------------------------
hub=${AGENTBUS_HUB:-}
code=${AGENTBUS_JOIN_CODE:-}
name=
interactive=
nosetup=
extra=
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
while [ $# -gt 0 ]; do
	case $1 in
	--hub) [ $# -ge 2 ] || usage_err "--hub needs a URL"; hub=$2; shift 2 ;;
	--hub=*) hub=${1#--hub=}; shift ;;
	--join-code) [ $# -ge 2 ] || usage_err "--join-code needs a code"; code=$2; shift 2 ;;
	--join-code=*) code=${1#--join-code=}; shift ;;
	--name) [ $# -ge 2 ] || usage_err "--name needs a value"; name=$2; shift 2 ;;
	--name=*) name=${1#--name=}; shift ;;
	--interactive) interactive=1; shift ;;
	--no-setup) nosetup=1; shift ;;
	--yes) shift ;;
	-h | --help) usage; exit 0 ;;
	*) extra="$extra $(quote "$1")"; shift ;;
	esac
done

BASE=${AGENTBUS_UPDATE_BASE:-https://github.com/shiroha-document/agentbus}
BIN=${AGENTBUS_BIN:-$HOME/.local/bin}
VER=${AGENTBUS_VERSION:-latest}
GOINSTALL='go install github.com/shiroha-document/agentbus/cmd/agentbus@latest'

out ""
out "${C_B}${C_C}  agentbus${C_0} ${C_D}— $(m 'one bus for your coding agents' '让你的 coding agent 在同一条总线上协作')${C_0}"
out "${C_D}  $(m 'installer' '安装脚本') · ${VER} · ${BASE}${C_0}"

# --- platform ------------------------------------------------------------
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $os in
linux | darwin) ;;
mingw* | msys* | cygwin*) os=windows ;;
*) die "$(m "unsupported OS: $os" "不支持的系统：$os")" \
	"$(m "build from source: $GOINSTALL" "用 Go 从源码安装：$GOINSTALL")" ;;
esac
arch=$(uname -m)
case $arch in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) die "$(m "unsupported CPU: $arch" "不支持的 CPU：$arch")" \
	"$(m "build from source: $GOINSTALL" "用 Go 从源码安装：$GOINSTALL")" ;;
esac
asset=agentbus-$os-$arch
exe=agentbus
if [ "$os" = windows ]; then
	asset=$asset.exe
	exe=agentbus.exe
	info "$(m 'tip: on native Windows PowerShell use install.ps1 instead' '提示：原生 Windows PowerShell 请改用 install.ps1')"
fi

if [ "$VER" = latest ]; then
	url=$BASE/releases/latest/download
else
	url=$BASE/releases/download/$VER
fi

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -q -O "$2" "$1"; }
else
	die "$(m 'need curl or wget' '需要 curl 或 wget')" \
		"$(m 'Debian/Ubuntu: sudo apt-get install -y curl' 'Debian/Ubuntu：sudo apt-get install -y curl')" \
		"$(m 'macOS: curl is preinstalled; check your PATH' 'macOS：系统自带 curl，检查 PATH')"
fi
if command -v sha256sum >/dev/null 2>&1; then
	sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	die "$(m 'need sha256sum or shasum' '需要 sha256sum 或 shasum')" \
		"$(m 'Debian/Ubuntu: sudo apt-get install -y coreutils' 'Debian/Ubuntu：sudo apt-get install -y coreutils')"
fi

# --- 1/4 download --------------------------------------------------------
step 1 "$(m 'Download' '下载')"
info "$os/$arch · $asset"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" || die "$(m "no release found at $url" "在 $url 找不到发布包")" \
	"$(m 'check your network / proxy: curl -I https://github.com' '检查网络或代理：curl -I https://github.com')" \
	"$(m "check the tag: AGENTBUS_VERSION=$VER (e.g. v0.6.0, or unset for latest)" "检查版本号：AGENTBUS_VERSION=$VER（如 v0.6.0，留空 = 最新版）")"
fetch "$url/$asset" "$tmp/$asset" || die "$(m "release has no $asset" "发布包里没有 $asset")" \
	"$(m 'this platform may not be built for that tag; try the latest release' '该版本可能没有这个平台的构建，试试最新版')" \
	"$(m "or build from source: $GOINSTALL" "或者用 Go 从源码安装：$GOINSTALL")"
ok "$(m 'downloaded' '已下载') $asset"

# --- 2/4 verify ----------------------------------------------------------
step 2 "$(m 'Verify' '校验')"
want=$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "$(m "SHA256SUMS does not list $asset" "SHA256SUMS 里没有 $asset")" \
	"$(m 'the release may still be uploading; wait a minute and retry' '发布可能还在上传，等一分钟再试')"
got=$(sha "$tmp/$asset")
[ "$got" = "$want" ] || die "$(m "checksum mismatch for $asset" "$asset 的校验和不匹配")" \
	"$(m 'the download was corrupted or intercepted; retry, ideally without a MITM proxy' '下载可能损坏或被代理篡改，请重试（最好绕过中间人代理）')"
ok "SHA-256 $(printf '%s' "$got" | cut -c1-12)…"
chmod 755 "$tmp/$asset"
newver=$("$tmp/$asset" --version) || die "$(m 'downloaded binary does not run on this machine' '下载的程序无法在本机运行')" \
	"$(m 'if /tmp is mounted noexec: TMPDIR=$HOME/tmp sh install.sh' '如果 /tmp 挂载为 noexec：TMPDIR=$HOME/tmp sh install.sh')" \
	"$(m "or build from source: $GOINSTALL" "或者用 Go 从源码安装：$GOINSTALL")"
ok "$(m 'self-test' '自检'): $newver"

# --- 3/4 install ---------------------------------------------------------
step 3 "$(m 'Install' '安装')"
prev=
if [ -x "$BIN/$exe" ]; then
	prev=$("$BIN/$exe" --version 2>/dev/null || true)
fi
mkdir -p "$BIN" || die "$(m "cannot create $BIN" "无法创建目录 $BIN")" \
	"$(m 'pick another directory: AGENTBUS_BIN=$HOME/bin' '换一个目录：AGENTBUS_BIN=$HOME/bin')"
mv -f "$tmp/$asset" "$BIN/$exe" || die "$(m "cannot write $BIN/$exe" "无法写入 $BIN/$exe")" \
	"$(m 'pick another directory: AGENTBUS_BIN=$HOME/bin' '换一个目录：AGENTBUS_BIN=$HOME/bin')"
if [ -n "$prev" ] && [ "$prev" != "$newver" ]; then
	ok "$(m 'updated' '已更新') $prev ${S_AR} $newver  ${C_D}$BIN/$exe${C_0}"
else
	ok "$(m 'installed' '已安装') agentbus $newver  ${C_D}$BIN/$exe${C_0}"
fi
onpath=1
case ":$PATH:" in
*":$BIN:"*) ;;
*)
	onpath=
	case ${SHELL:-} in
	*zsh) rc='~/.zshrc' ;;
	*bash) rc='~/.bashrc' ;;
	*) rc='~/.profile' ;;
	esac
	warn "$(m "$BIN is not on PATH; add it:" "$BIN 不在 PATH 里，加上它：")"
	out "      echo 'export PATH=\"$BIN:\$PATH\"' >> $rc && . $rc"
	;;
esac
ab=agentbus
[ -n "$onpath" ] || ab=$BIN/$exe

# Coding CLIs agentbus can drive (see `agentbus setup --cli …`).
out ""
out "  ${C_B}$(m 'Coding CLIs on this machine' '本机检测到的 coding CLI')${C_0}"
found=
detect() { # label bin...
	label=$1
	shift
	for b in "$@"; do
		if command -v "$b" >/dev/null 2>&1; then
			out "    ${C_G}${S_OK}${C_0} $label ${C_D}($b)${C_0}"
			[ -n "$found" ] || found=$b
			return 0
		fi
	done
	out "    ${C_D}${S_NO} $label${C_0}"
	return 0
}
detect 'Claude Code' claude
detect 'Codex' codex
detect 'Cursor' cursor-agent agent
detect 'Gemini CLI' gemini
detect 'TRAE CLI' traecli trae-cli
detect 'DeepSeek Harness' dsh
if [ -z "$found" ]; then
	warn "$(m 'no supported coding CLI found; install one first (or use --cli custom --template …)' '没有找到支持的 coding CLI，请先安装一个（或用 --cli custom --template …）')"
	info "https://docs.hub.shiroha.tech/guide/clis"
fi

# --- 4/4 join the hub team (one-line onboarding) -------------------------
if [ -n "$nosetup" ]; then
	out ""
	ok "$(m 'done (--no-setup). Join later with:' '完成（--no-setup）。之后接入：')"
	out "      $ab setup --hub https://<hub> --join-code abj_…"
	exit 0
fi
step 4 "$(m 'Join a hub' '接入 hub')"
if [ -z "$hub" ] && [ -z "$code" ]; then
	info "$(m 'no --hub / --join-code given, skipping' '未提供 --hub / --join-code，跳过')"
	out ""
	out "  ${C_B}$(m 'Next steps' '下一步')${C_0}"
	out "    1. $(m 'open your hub → Members → Add agent, copy the join code' '打开 hub → 成员 → 添加 agent，复制加入码')"
	out "    2. $ab setup --hub https://<your hub> --join-code abj_…"
	out "    3. $ab doctor"
	exit 0
fi
[ -n "$hub" ] || die "$(m '--join-code given without --hub URL' '给了 --join-code 但没有 --hub URL')" \
	"$(m 'add --hub https://<your hub> (or export AGENTBUS_HUB)' '加上 --hub https://<你的 hub>（或设置 AGENTBUS_HUB）')"
[ -n "$code" ] || die "$(m '--hub given without --join-code abj_…' '给了 --hub 但没有 --join-code abj_…')" \
	"$(m 'hub → Members → Add agent gives you a join code' '在 hub → 成员 → 添加 agent 里拿加入码')"
set -- setup --hub "$hub" --join-code "$code"
[ -z "$name" ] || set -- "$@" --name "$name"
if [ -n "$extra" ]; then
	eval "set -- \"\$@\" $extra"
fi
info "hub  $hub"
info "$(m 'code' '加入码') $(printf '%s' "$code" | cut -c1-8)…"
[ -z "$name" ] || info "$(m 'name' '名字') $name"
out ""
setup_fail() {
	die "$(m 'setup reported a problem (see above)' 'setup 报告了问题（见上方输出）')" \
		"$(m "diagnose: $BIN/$exe doctor" "诊断：$BIN/$exe doctor")" \
		"$(m 'bad_join_code / 403: the code expired or was revoked; get a new one in hub → Members → Add agent' 'bad_join_code / 403：加入码过期或被撤销，到 hub → 成员 → 添加 agent 重新获取')" \
		"$(m 'name taken / 409: pass another --name' '名字被占用 / 409：换一个 --name')" \
		"$(m "re-run just the join: $BIN/$exe setup --hub $hub --join-code …" "只重跑接入：$BIN/$exe setup --hub $hub --join-code …")"
}
if [ -n "$interactive" ] && [ -r /dev/tty ]; then
	"$BIN/$exe" "$@" </dev/tty || setup_fail
else
	"$BIN/$exe" "$@" --yes </dev/null || setup_fail
fi
out ""
ok "${C_B}$(m 'done' '完成')${C_0}"
out ""
out "  ${C_B}$(m 'Next steps' '下一步')${C_0}"
out "    1. $(m 'a team admin approves this agent on the hub (Members)' '团队管理员在 hub 的「成员」页批准这个 agent')"
out "    2. $(m 'check:' '查看状态：') $ab status    $(m 'diagnose:' '诊断：') $ab doctor"
out "    3. $(m 'then @ it in any thread on the hub' '然后在 hub 的任意线程里 @ 它')"
