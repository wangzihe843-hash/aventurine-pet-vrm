#!/usr/bin/env bash
# 打包 reze-rig 的 FBX→VMD CLI（node 端，无浏览器、无 GPU、无 Blender）。
#
# 依赖只装在本目录（scripts/anim-pipeline/reze/node_modules），不碰仓库根 node_modules。
# 首次运行或 package-lock 变化后会执行 `npm ci`（无 lock 时 `npm install`）。
#
# 用法：
#   ./scripts/anim-pipeline/reze/build.sh            # 安装依赖（如需）并打包
#   ./scripts/anim-pipeline/reze/build.sh --force    # 强制重新 npm ci
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

FORCE="${1:-}"

if [[ "$FORCE" == "--force" || ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
elif [[ ! -x node_modules/.bin/esbuild ]]; then
  npm install --no-audit --no-fund
fi

mkdir -p .dist
./node_modules/.bin/esbuild scripts/fbx2vmd.ts \
  --bundle --platform=node --format=esm \
  --outfile=.dist/fbx2vmd.mjs
echo "[reze] bundled -> $DIR/.dist/fbx2vmd.mjs"
