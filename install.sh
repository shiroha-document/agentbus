#!/bin/sh
# Install (or update) the agentbus CLI from GitHub Releases. No token needed.
#
#   curl -fsSL https://raw.githubusercontent.com/shiroha-document/agentbus/main/install.sh | sh
#
# Env:
#   AGENTBUS_VERSION  tag to install (default: latest release), e.g. v0.3.0
#   AGENTBUS_BIN      install directory (default: ~/.local/bin)
#   AGENTBUS_UPDATE_BASE  release base URL (default: the public repo)
set -eu

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
