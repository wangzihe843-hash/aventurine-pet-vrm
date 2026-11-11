#!/usr/bin/env bash
# 动作预览器启动入口（Electron 主进程）。
#
# 重要：本机环境变量里可能带着 ELECTRON_RUN_AS_NODE=1（DSH agent 环境），
# 它会让 electron 退化成纯 Node，导致 main.cjs 里 require('electron') 拿到二进制路径。
# 这里显式 unset，保证以真正 Electron 主进程启动。
#
# 用法（仓库根目录）：
#   ./scripts/anim-pipeline/preview/run.sh --help
#   ./scripts/anim-pipeline/preview/run.sh --motion tests/tmp/motions/converted/Idle.vmd \
#     --frames 0,30,60,90 --angles front,side,45,back
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -x "$REPO_ROOT/node_modules/.bin/electron" ]]; then
  echo "[preview] ERROR: 未找到 node_modules/.bin/electron（先在仓库根目录 pnpm install）" >&2
  exit 2
fi

exec env -u ELECTRON_RUN_AS_NODE "$REPO_ROOT/node_modules/.bin/electron" \
  "$SCRIPT_DIR/main.cjs" "$@"
