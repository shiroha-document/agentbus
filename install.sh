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
#   anything else      passed to `agentbus setup` (e.g. --cli codex --tier readonly)
#
# Env:
#   AGENTBUS_VERSION  tag to install (default: latest release), e.g. v0.3.0
#   AGENTBUS_BIN      install directory (default: ~/.local/bin)
#   AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
set -eu

hub=${AGENTBUS_HUB:-}
code=${AGENTBUS_JOIN_CODE:-}
name=
interactive=
nosetup=
extra=
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
while [ $# -gt 0 ]; do
	case $1 in
	--hub) [ $# -ge 2 ] || { echo "install.sh: --hub needs a URL" >&2; exit 2; }; hub=$2; shift 2 ;;
	--hub=*) hub=${1#--hub=}; shift ;;
	--join-code) [ $# -ge 2 ] || { echo "install.sh: --join-code needs a code" >&2; exit 2; }; code=$2; shift 2 ;;
	--join-code=*) code=${1#--join-code=}; shift ;;
	--name) [ $# -ge 2 ] || { echo "install.sh: --name needs a value" >&2; exit 2; }; name=$2; shift 2 ;;
	--name=*) name=${1#--name=}; shift ;;
	--interactive) interactive=1; shift ;;
	--no-setup) nosetup=1; shift ;;
	--yes) shift ;;
	*) extra="$extra $(quote "$1")"; shift ;;
	esac
done

BASE=${AGENTBUS_UPDATE_BASE:-https://github.com/shiroha-document/agentbus}
BIN=${AGENTBUS_BIN:-$HOME/.local/bin}
VER=${AGENTBUS_VERSION:-latest}

say() { printf 'install.sh: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $os in
linux | darwin) ;;
mingw* | msys* | cygwin*) os=windows ;;
*) die "unsupported OS $os; use: go install github.com/shiroha-document/agentbus/cmd/agentbus@latest" ;;
esac
arch=$(uname -m)
case $arch in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) die "unsupported CPU $arch; use: go install github.com/shiroha-document/agentbus/cmd/agentbus@latest" ;;
esac
asset=agentbus-$os-$arch
exe=agentbus
if [ "$os" = windows ]; then
	asset=$asset.exe
	exe=agentbus.exe
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
	die "need curl or wget"
fi
if command -v sha256sum >/dev/null 2>&1; then
	sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	die "need sha256sum or shasum"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS" || die "no release found at $url"
fetch "$url/$asset" "$tmp/$asset" || die "release has no $asset"
want=$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || die "SHA256SUMS does not list $asset"
got=$(sha "$tmp/$asset")
[ "$got" = "$want" ] || die "checksum mismatch for $asset"
chmod 755 "$tmp/$asset"
newver=$("$tmp/$asset" --version) || die "downloaded binary does not run on this machine"

mkdir -p "$BIN"
mv -f "$tmp/$asset" "$BIN/$exe"
say "installed agentbus $newver to $BIN/$exe"
case ":$PATH:" in
*":$BIN:"*) ;;
*) say "note: $BIN is not on PATH; add it, e.g. echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile" ;;
esac

# --- join the hub team (one-line onboarding) ---
[ -z "$nosetup" ] || exit 0
if [ -z "$hub" ] && [ -z "$code" ]; then
	say "next: agentbus setup --hub https://<your hub> --join-code abj_…  (hub → 成员 → 添加 agent)"
	exit 0
fi
[ -n "$hub" ] || die "--join-code given without --hub URL"
[ -n "$code" ] || die "--hub given without --join-code abj_… (hub → 成员 → 添加 agent)"
set -- setup --hub "$hub" --join-code "$code"
[ -z "$name" ] || set -- "$@" --name "$name"
if [ -n "$extra" ]; then
	eval "set -- \"\$@\" $extra"
fi
say "joining $hub …"
if [ -n "$interactive" ] && [ -r /dev/tty ]; then
	"$BIN/$exe" "$@" </dev/tty || die "setup reported a problem above; fix it, then run: $BIN/$exe doctor"
else
	"$BIN/$exe" "$@" --yes </dev/null || die "setup reported a problem above; fix it, then run: $BIN/$exe doctor"
fi
say "done. A team admin approves this agent on the hub; check with: $BIN/$exe status"
