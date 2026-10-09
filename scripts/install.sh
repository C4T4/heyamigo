#!/bin/bash
# HeyAmigo installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/scripts/install.sh | bash
#
# Installs the heyamigo command into ~/.local without sudo.
# Override the location with HEYAMIGO_PREFIX.

set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it, then run this again." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "Node.js $(node -v) is too old. HeyAmigo needs Node 18 or newer." >&2
  exit 1
fi

prefix="${HEYAMIGO_PREFIX:-$HOME/.local}"
mkdir -p "$prefix"

echo "Installing HeyAmigo into $prefix"
npm install -g --prefix "$prefix" @c4t4/heyamigo@latest

bin="$prefix/bin/heyamigo"
if [ ! -x "$bin" ]; then
  echo "The install finished, but $bin is not there." >&2
  exit 1
fi

case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *)
    shell_name="$(basename "${SHELL:-}")"
    rc=""
    case "$shell_name" in
      zsh) rc="$HOME/.zshrc" ;;
      bash) rc="$HOME/.bashrc" ;;
    esac
    if [ -n "$rc" ] && ! grep -qs "heyamigo installer" "$rc" 2>/dev/null; then
      printf '\n# >>> heyamigo installer >>>\nexport PATH="%s/bin:$PATH"\n# <<< heyamigo installer <<<\n' "$prefix" >> "$rc"
      echo "Added $prefix/bin to PATH in $rc. Open a new terminal before using heyamigo."
    elif [ -z "$rc" ]; then
      echo "Add $prefix/bin to your PATH before using heyamigo:"
      echo "  export PATH=\"$prefix/bin:\$PATH\""
    fi
    ;;
esac

echo "HeyAmigo $("$bin" --version) installed."
if [ "${HEYAMIGO_UPDATE:-}" = "1" ]; then
  echo "Restart the bot:"
  echo "  heyamigo restart"
else
  echo "Next: heyamigo setup"
fi
