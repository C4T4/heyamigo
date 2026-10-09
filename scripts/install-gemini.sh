#!/bin/bash
# Gemini CLI installer for HeyAmigo.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/C4T4/heyamigo/main/scripts/install-gemini.sh | bash
#
# Downloads gemini-cli-bundle.zip from Google's newest stable GitHub release
# into ~/.local. Node.js 20 or newer is required. No npm. No Homebrew.
# Override the location with GEMINI_PREFIX.

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Gemini CLI needs Node.js 20 or newer. Install it, then run this again." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Gemini CLI needs Node.js 20 or newer. This machine has $(node -v)." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "No Gemini CLI install for $(uname -s)." >&2
    exit 1
    ;;
esac

prefix="${GEMINI_PREFIX:-$HOME/.local}"
meta="$(mktemp)"
archive="$(mktemp)"
stage="$(mktemp -d)"
trap 'rm -rf "$meta" "$archive" "$stage"' EXIT

echo "Looking up the latest Gemini CLI release"
curl -fsSL \
  -A heyamigo-install \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/google-gemini/gemini-cli/releases/latest" \
  -o "$meta"

url="$(node -e '
const fs = require("fs")
const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const name = "gemini-cli-bundle.zip"
const asset = (release.assets || []).find((item) => item.name === name)
if (!asset) {
  console.error("Release " + (release.tag_name || "(unknown)") + " has no " + name)
  process.exit(1)
}
process.stdout.write(asset.browser_download_url)
' "$meta")"

echo "Downloading ${url}"
curl -fL --retry 3 -A heyamigo-install -o "$archive" "$url"
unzip -q -o "$archive" -d "$stage"
if [ ! -f "$stage/gemini.js" ]; then
  echo "The download did not contain Gemini CLI." >&2
  exit 1
fi

lib="$prefix/lib/gemini-cli"
mkdir -p "$prefix/bin" "$prefix/lib"
rm -rf "$lib"
mkdir -p "$lib"
cp -a "$stage"/. "$lib"/
# The release zip has no package.json. Node otherwise parses gemini.js
# as CommonJS and refuses the ESM bundle.
printf '%s\n' '{"type":"module"}' > "$lib/package.json"
chmod +x "$lib/gemini.js"
rm -f "$prefix/bin/gemini"
cat > "$prefix/bin/gemini" << EOF
#!/bin/sh
exec node "$lib/gemini.js" "\$@"
EOF
chmod +x "$prefix/bin/gemini"

case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *)
    echo "Add $prefix/bin to your PATH before using gemini:"
    echo "  export PATH=\"$prefix/bin:\$PATH\""
    ;;
esac

echo "Gemini CLI installed: $("$prefix/bin/gemini" --version)"
