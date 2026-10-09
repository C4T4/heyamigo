#!/bin/bash
# HeyAmigo installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/scripts/install.sh | bash
#
# Downloads the newest GitHub release for this computer into ~/.local.
# Override the location with HEYAMIGO_PREFIX.

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it, then run this again." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "Node.js $(node -v) is too old. HeyAmigo needs Node 18 or newer." >&2
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64) target=linux-arm64 ;;
  *)
    echo "No HeyAmigo build for $(uname -s) $(uname -m)." >&2
    exit 1
    ;;
esac

prefix="${HEYAMIGO_PREFIX:-$HOME/.local}"
archive_name="heyamigo-${target}.tar.gz"
meta="$(mktemp)"
archive="$(mktemp)"
stage="$(mktemp -d)"
trap 'rm -rf "$meta" "$archive" "$stage"' EXIT

echo "Looking up the latest HeyAmigo release for ${target}"
curl -fsSL \
  -A heyamigo-install \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/C4T4/heyamigo/releases/latest" \
  -o "$meta"

url="$(node -e '
const fs = require("fs")
const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const name = process.argv[2]
const asset = (release.assets || []).find((item) => item.name === name)
if (!asset) {
  console.error("Release " + (release.tag_name || "(unknown)") + " has no " + name)
  process.exit(1)
}
process.stdout.write(asset.browser_download_url)
' "$meta" "$archive_name")"

echo "Downloading ${url}"
curl -fL --retry 3 -A heyamigo-install -o "$archive" "$url"
tar -xzf "$archive" -C "$stage"
if [ ! -f "$stage/heyamigo/dist/cli/index.js" ]; then
  echo "The download did not contain HeyAmigo." >&2
  exit 1
fi

mkdir -p "$prefix/lib" "$prefix/bin"
rm -rf "$prefix/lib/heyamigo"
mv "$stage/heyamigo" "$prefix/lib/heyamigo"

cat > "$prefix/bin/heyamigo" << EOF
#!/bin/sh
exec node "$prefix/lib/heyamigo/dist/cli/index.js" "\$@"
EOF
cat > "$prefix/bin/heyamigo-client" << EOF
#!/bin/sh
exec node "$prefix/lib/heyamigo/scripts/portable-client.mjs" "\$@"
EOF
chmod +x "$prefix/bin/heyamigo" "$prefix/bin/heyamigo-client"

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

echo "HeyAmigo $("$prefix/bin/heyamigo" --version) installed."
if [ "${HEYAMIGO_UPDATE:-}" = "1" ]; then
  echo "Restart the bot:"
  echo "  heyamigo restart"
else
  echo "Next: heyamigo setup"
fi
