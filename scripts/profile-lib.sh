#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# profile-lib.sh — PET_PROFILE 规范化的唯一实现
#
# 被以下脚本 source（不要直接执行）：
#   - scripts/worktree-setup.sh  （创建 worktree 软链后打印 PET_PROFILE）
#   - scripts/print-profile.sh   （任意目录路径 → PET_PROFILE，供 package.json 复用）
#
# 背景（MED-6 / M-4）：dev 下 app 用 PET_PROFILE 把 userData 隔离到
# `appData/aventurine-pet-<profile>`，但 app 只接受与
# `src/main/index.ts` 的 DEV_PROFILE_PATTERN 完全匹配的 profile：
#
#   ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
#
# 非法值会被 app 静默忽略（回退共享 userData）。因此 dev:worktree 不能直接注入
# `basename "$PWD"`，必须走本文件的同一套规范化规则（工作目录名可能含空格/中文/
# 首字符非法等）。
#
# 规范化规则（顺序固定，worktree-setup.sh 历史行为保持不变）：
#   1) 连续非法字节替换为单个 '-'，再去掉首尾 '-'；
#      合法字符集与 app 正则一致：A-Z a-z 0-9 . _ -
#   2) 规范化结果为空（目录名全为非 ASCII/非法字符）→ `wt-<cksum>`
#      （cksum 输入为原始 basename，同一目录每次结果稳定）
#   3) 首字符不是 [A-Za-z0-9] → 前缀 `wt-`（如 `_wt` → `wt-_wt`、`. wt` → `wt-.wt`）
#   4) 截断到 64 字符（app 正则上限）
#   5) 最终用与 app 相同的正则自校验；任何一步失败返回非 0（调用方负责报错）
#
# 注意：本文件定义函数，source 时不产生任何输出/副作用。
# ---------------------------------------------------------------------------

# normalize_profile_name <raw-basename>
#   成功：stdout 输出规范化后的 profile（不带换行），return 0
#   失败：不输出，return 1
normalize_profile_name() {
  local raw="${1-}"
  local sanitized

  sanitized="$(
    printf '%s' "$raw" |
      LC_ALL=C tr -cs 'A-Za-z0-9._-' '-' |
      LC_ALL=C sed 's/^-*//; s/-*$//'
  )" || return 1

  if [ -z "$sanitized" ]; then
    local checksum
    checksum="$(printf '%s' "$raw" | cksum | awk '{print $1}')" || return 1
    [ -n "$checksum" ] || return 1
    sanitized="wt-${checksum}"
  fi

  case "$sanitized" in
    [A-Za-z0-9]*) : ;;
    *) sanitized="wt-${sanitized}" ;;
  esac

  local profile
  profile="$(printf '%s' "$sanitized" | LC_ALL=C cut -c1-64)" || return 1

  # 与 app 侧 DEV_PROFILE_PATTERN 完全相同（LC_ALL=C 保证按字节/ASCII 语义匹配）
  printf '%s' "$profile" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' || return 1

  printf '%s' "$profile"
}
