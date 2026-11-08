#!/bin/sh
# Installs or updates Runtrace for this user on macOS or Linux, then starts it and opens the dashboard.
#   curl -fsSL https://github.com/Dytschgo/runtrace/releases/latest/download/install.sh | sh
# The program goes in ~/.local/bin (or RUNTRACE_BIN); settings and data in the system's per-user app data folder.
set -eu
repo="Dytschgo/runtrace"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
  *) echo "Runtrace has no release for $(uname -s) $(uname -m) yet. Build it from source: https://github.com/$repo" >&2; exit 1 ;;
esac
asset="runtrace-$target"
# RUNTRACE_RELEASE_BASE and RUNTRACE_NO_OPEN exist for testing and scripted installs.
base="${RUNTRACE_RELEASE_BASE:-https://github.com/$repo/releases/latest/download}"
dir="${RUNTRACE_BIN:-$HOME/.local/bin}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Runtrace..."
curl -fsSL -o "$tmp/$asset" "$base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
want="$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | head -n1 | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
if [ -z "$want" ] || [ "$got" != "$want" ]; then echo "The download does not match its published checksum. Nothing was installed." >&2; exit 1; fi
mkdir -p "$dir"
[ -x "$dir/runtrace" ] && "$dir/runtrace" stop >/dev/null 2>&1 || true
install -m 755 "$tmp/$asset" "$dir/runtrace"
if [ -n "${RUNTRACE_NO_OPEN:-}" ]; then "$dir/runtrace" start; else "$dir/runtrace" start --open; fi
echo
echo "Runtrace is installed. Useful commands: runtrace status, runtrace stop, runtrace update, runtrace autostart on"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH to use the runtrace command from anywhere." ;; esac
