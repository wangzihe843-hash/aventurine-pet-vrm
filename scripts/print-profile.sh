#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# print-profile.sh — 目录路径 → 合法 PET_PROFILE（纯函数式 CLI，不写任何文件）
#
# 背景（M-4）：`pnpm dev:worktree` 过去直接注入 `PET_PROFILE=$(basename "$PWD")`，
# 目录名含空格/中文/首字符非法时会被 app 的 DEV_PROFILE_PATTERN 静默忽略，
# 导致 userData 不隔离、并行窗口 config/log 互相覆盖。
#
# 本脚本与 scripts/worktree-setup.sh 共用 scripts/profile-lib.sh 的规范化实现，
# 输出保证与 app 侧正则完全一致：
#   ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
#
# 用法：
#   scripts/print-profile.sh <目录路径>      # stdout 只输出 profile 值（无其它内容）
#   scripts/print-profile.sh --help
#
# 示例：
#   PET_PROFILE=$(scripts/print-profile.sh "$PWD") pnpm dev
#   # package.json 建议（由 Lead 统一改）：
#   "dev:worktree": "ELECTRON_RUN_AS_NODE= PET_PROFILE=$(bash scripts/print-profile.sh \"$PWD\") electron-vite dev"
#
# 退出码：0 成功；1 路径不存在/不是目录或无法规范化；2 用法错误（缺少/多余参数）。
# 规范：只读（仅统计目录与 git 无关信息），不写任何文件、不创建 worktree。
# ---------------------------------------------------------------------------
set -euo pipefail

readonly SCRIPT_NAME="print-profile"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=profile-lib.sh
source "$SCRIPT_DIR/profile-lib.sh"

die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
用法：scripts/print-profile.sh <目录路径>

把目录名规范化为与 app 侧 DEV_PROFILE_PATTERN 完全一致的 PET_PROFILE
（`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`），与 scripts/worktree-setup.sh 打印的值一致。

规则：
  - 连续非法字符（空格/中文/标点等）→ '-'，去掉首尾 '-'
  - 全为非 ASCII/非法字符 → wt-<cksum>（同一目录稳定）
  - 首字符不是字母/数字 → 前缀 'wt-'（如 _wt → wt-_wt）
  - 截断到 64 字符；无法规范化时报错（非 0）

示例：
  PET_PROFILE=$(scripts/print-profile.sh "$PWD") pnpm dev

选项：
  -h, --help   显示本帮助
USAGE
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
esac

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi

DIR_ARG="$1"
[ -n "$DIR_ARG" ] || die "目录路径为空"
[ -d "$DIR_ARG" ] || die "目录不存在或不是目录：${DIR_ARG}"

# 与 worktree-setup.sh 一致：先解析真实路径再取 basename（软链/相对路径/trailing slash 归一）
RESOLVED_DIR="$(cd "$DIR_ARG" && pwd -P)" || die "无法解析目录路径：${DIR_ARG}"
BASENAME="$(basename "$RESOLVED_DIR")" || die "无法解析目录名：${DIR_ARG}"
[ -n "$BASENAME" ] || die "无法解析目录名（为空）：${DIR_ARG}"

if ! PET_PROFILE="$(normalize_profile_name "$BASENAME")"; then
  die "无法为目录名生成合法 PET_PROFILE（原目录名：${BASENAME}）"
fi

printf '%s\n' "$PET_PROFILE"
