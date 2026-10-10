#!/bin/bash
# Pack the already-built app and its production node_modules for this machine.
# Run after `npm ci`, `npm run build`, and `npm prune --omit=dev`.
set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Linux-aarch64) target=linux-arm64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  *)
    echo "No release build for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

if [ ! -f dist/cli/index.js ] || [ ! -d node_modules/better-sqlite3 ]; then
  echo "Build the app and install production dependencies before packing." >&2
  exit 1
fi

stage="$(mktemp -d)"
dest="$stage/heyamigo"
mkdir -p "$dest/config" "$dest/scripts" "$dest/docs"
cp package.json LICENSE README.md "$dest/"
cp -R dist migrations node_modules "$dest/"
cp config/config.example.json config/access.example.json \
  config/memory-instructions.md config/import-instructions.md \
  config/import-instructions.HOWTO.md config/pack.example.json \
  config/mcp.example.json "$dest/config/"
cp -R config/personalities config/mandatory "$dest/config/"
cp scripts/portable-client.mjs scripts/start-browser.sh "$dest/scripts/"
cp docs/portable-client.md docs/attach-existing-client.md "$dest/docs/"

archive="$PWD/heyamigo-${target}.tar.gz"
tar -C "$stage" -czf "$archive" heyamigo
rm -rf "$stage"
echo "Packed $archive"
