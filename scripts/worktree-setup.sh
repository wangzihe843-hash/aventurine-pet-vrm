#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# worktree-setup.sh — 给新建的 git worktree 建立「依赖 + 私有资产」软链
#
# 背景：`git worktree add` 只 checkout 受版本控制的文件。本项目里
#   - `node_modules/`（.gitignore）
#   - `assets/model/**`（私有模型，.gitignore；含 optimized/ 贴图与 PMX）
# 不会出现在新 worktree，导致 A2/A3 等窗口无法加载模型、所有窗口都得重装依赖。
# 本脚本把这两样从**主工作树**软链过去，并打印 dev 用的 PET_PROFILE。
#
# 用法：
#   scripts/worktree-setup.sh <worktree-path>
#   scripts/worktree-setup.sh --help
#
# 约定（Wave 1 并行规则，见 PLAN §6 / §17.5）：
#   - 可在主工作树或任意 linked worktree 里执行；主工作树路径由
#     `git rev-parse --git-common-dir` 自动解析，不依赖当前目录。
#   - 脚本幂等：重复执行只会把软链指向当前主工作树，不会破坏已存在的数据。
#   - 禁止在 worktree 内 `pnpm install`（重复下载 Electron）或
#     `pnpm assets:prepare`（会改写 tracked 的 src/shared/assets-manifest.json）。
#   - `node_modules` / `assets/model` 若已是**真实目录**（非软链），脚本拒绝覆盖并报错。
#   - 目标必须是 linked worktree 的**根目录**且与本仓库同源；传入主工作树的子目录
#     （如 `scripts/`）或其它仓库的 worktree 会直接报错（独立复验 MED-1）。
#   - 打印的 PET_PROFILE 与 app 侧 `DEV_PROFILE_PATTERN` 完全一致
#     （`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`），避免 app 静默忽略导致 userData 不隔离（MED-6）。
# ---------------------------------------------------------------------------
set -euo pipefail

readonly SCRIPT_NAME="worktree-setup"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# PET_PROFILE 规范化唯一实现（与 scripts/print-profile.sh 共用）；规则与 app 侧
# DEV_PROFILE_PATTERN 完全一致：非法字符→'-'、全非法→wt-<cksum>、
# 首字符非法→前缀 'wt-'、截断 64。见 scripts/profile-lib.sh。
# shellcheck source=profile-lib.sh
source "$SCRIPT_DIR/profile-lib.sh"

log() { printf '[%s] %s\n' "$SCRIPT_NAME" "$*"; }
warn() { printf '[%s] WARN: %s\n' "$SCRIPT_NAME" "$*" >&2; }
die() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
用法：scripts/worktree-setup.sh <worktree-path>

给新建的 git worktree 建立：
  1) node_modules  -> 主工作树/node_modules   （软链，禁止在 worktree 里 pnpm install）
  2) assets/model  -> 主工作树/assets/model   （软链，私有模型不进 git）
并打印该 worktree 的 PET_PROFILE 用法（dev 下隔离 userData）。

示例：
  git worktree add ../wt-a2 -b feat/a2-render
  scripts/worktree-setup.sh ../wt-a2
  cd ../wt-a2 && pnpm dev:worktree

选项：
  -h, --help   显示本帮助
USAGE
}

# --- 参数 -------------------------------------------------------------------
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
WORKTREE_ARG="$1"
[ -n "$WORKTREE_ARG" ] || die "worktree 路径为空"
[ -d "$WORKTREE_ARG" ] || die "worktree 路径不存在或不是目录：${WORKTREE_ARG}（先执行 git worktree add）"

# --- 解析主工作树（git common dir 的父目录） --------------------------------
COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
  die "当前目录不在 git 仓库中：$REPO_ROOT"
[ -d "$COMMON_DIR" ] || die "无法解析 git common dir（${COMMON_DIR}）"
MAIN_WT="$(cd "$(dirname "$COMMON_DIR")" && pwd -P)"
[ -d "$MAIN_WT/.git" ] || die "主工作树解析失败（$MAIN_WT 下没有 .git）"

# --- 规范化目标 worktree ----------------------------------------------------
WORKTREE="$(cd "$WORKTREE_ARG" && pwd -P)"
git -C "$WORKTREE" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "目标不是 git worktree：$WORKTREE"
[ "$WORKTREE" = "$MAIN_WT" ] &&
  die "目标是主工作树（${MAIN_WT}），无需执行本脚本；请传入 linked worktree 路径"

# --- 目标必须是 worktree 根，且与本仓库同源 --------------------------------
# 仅 `rev-parse --is-inside-work-tree` 会放过主工作树的子目录（如 scripts/）和
# 其它仓库的 worktree，导致脚本向错误位置注入软链（独立复验 MED-1）。
TARGET_TOP="$(git -C "$WORKTREE" rev-parse --show-toplevel 2>/dev/null)" ||
  die "无法解析目标 worktree 根目录：$WORKTREE"
TARGET_TOP="$(cd "$TARGET_TOP" && pwd -P)"
[ "$TARGET_TOP" = "$WORKTREE" ] ||
  die "目标不是 worktree 根：${WORKTREE}（实际根目录：${TARGET_TOP}）。请传入 'git worktree add' 创建的根目录"

TARGET_COMMON="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
  die "无法解析目标 worktree 的 git common dir：$WORKTREE"
TARGET_COMMON="$(cd "$TARGET_COMMON" && pwd -P)"
MAIN_COMMON="$(cd "$COMMON_DIR" && pwd -P)"
[ "$TARGET_COMMON" = "$MAIN_COMMON" ] ||
  die "目标 worktree 不属于本仓库：${WORKTREE}（common dir: ${TARGET_COMMON} ≠ ${MAIN_COMMON}）"

# --- 主工作树前置检查 -------------------------------------------------------
[ -d "$MAIN_WT/node_modules" ] ||
  die "主工作树缺少 node_modules：请先在主工作树执行 'pnpm install'（不要在新 worktree 里装）"
[ -d "$MAIN_WT/assets/model" ] ||
  die "主工作树缺少 assets/model（私有模型资产）：请确认模型已解包到 '$MAIN_WT/assets/model'"
if [ ! -d "$MAIN_WT/assets/model/optimized" ]; then
  warn "主工作树没有 assets/model/optimized/（贴图/PMX 产物）"
  warn "  A2/A3 需要它：请由 Lead 在主工作树执行 'pnpm assets:prepare'，不要在 worktree 里执行"
fi

# --- 软链（幂等，不覆盖真实目录） -------------------------------------------
link_dir() {
  local source_path="$1" link_path="$2" label="$3"
  [ -e "$source_path" ] || [ -L "$source_path" ] || die "软链源不存在：$source_path"
  if [ -e "$link_path" ] && [ ! -L "$link_path" ]; then
    die "$label 在目标 worktree 中已是真实目录：${link_path}（请手动删除后再执行本脚本，或确认它是否是误装的依赖/误拷的模型）"
  fi
  mkdir -p "$(dirname "$link_path")"
  ln -sfn "$source_path" "$link_path"
  [ -e "$link_path" ] || die "软链创建失败：$link_path -> $source_path"
  log "linked $label: $link_path -> $source_path"
}

link_dir "$MAIN_WT/node_modules" "$WORKTREE/node_modules" "node_modules"
link_dir "$MAIN_WT/assets/model" "$WORKTREE/assets/model" "assets/model"

# --- PET_PROFILE：dev 下隔离 userData（appData/aventurine-pet-<profile>） ---
# 必须与 app 侧 src/main/index.ts 的 DEV_PROFILE_PATTERN 完全一致：
#   ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$   （首字符必须字母/数字，总长 ≤64）
# 否则 app 会静默忽略 PET_PROFILE → userData 回退共享目录、并行窗口互相覆盖（MED-6）。
WORKTREE_BASENAME="$(basename "$WORKTREE")"
# 规范化实现与 print-profile.sh 共用 scripts/profile-lib.sh，避免两处规则漂移（M-4）：
#   _wt → wt-_wt；全非 ASCII → wt-<cksum>；超长截断 64；首字符非法补 'wt-'。
if ! PET_PROFILE="$(normalize_profile_name "$WORKTREE_BASENAME")"; then
  die "无法为目录名生成合法 PET_PROFILE（原目录名：${WORKTREE_BASENAME}）"
fi
if [ "$PET_PROFILE" != "$WORKTREE_BASENAME" ]; then
  warn "目录名不适合直接作为 PET_PROFILE，已规范化为：${PET_PROFILE}（原：${WORKTREE_BASENAME}；与 app 侧正则一致）"
fi

cat <<EOF

[$SCRIPT_NAME] setup 完成：$WORKTREE

  node_modules -> $MAIN_WT/node_modules
  assets/model -> $MAIN_WT/assets/model

  PET_PROFILE=$PET_PROFILE
  dev 下 userData 会隔离到：~/Library/Application Support/aventurine-pet-$PET_PROFILE
  （config/log 不与其他并行窗口互相覆盖）

  启动开发（二选一）：
    cd "$WORKTREE" && pnpm dev:worktree   # 脚本内自动 PET_PROFILE=\$(basename "\$PWD")
    cd "$WORKTREE" && PET_PROFILE=$PET_PROFILE pnpm dev

  注意：
    - 不要在本 worktree 执行 pnpm install（会重复下载 Electron）
    - 不要在本 worktree 执行 pnpm assets:prepare（会改写 tracked 的 manifest）
    - 同一时刻建议只跑 1 个实例做人工视觉验收（多实例会抢 GPU/CPU）
EOF
