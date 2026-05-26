#!/bin/bash
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
ESBUILD="$PKG_DIR/node_modules/.bin/esbuild"
mkdir -p "$PKG_DIR/dist"
if [ -f "$ESBUILD" ]; then
  $ESBUILD "$PKG_DIR/index.ts" \
    --bundle --format=esm --outfile="$PKG_DIR/dist/index.js" \
    --platform=node --target=node22 \
    --external:@lancedb/lancedb-linux-x64-gnu \
    --external:@lancedb \
    --external:lance \
    --external:node:fs \
    --external:node:path \
    --external:node:os \
    --external:node:util \
    --external:node:crypto \
    2>/dev/null
  echo "[postinstall] memory-lancedb-pro dist rebuilt"
fi
