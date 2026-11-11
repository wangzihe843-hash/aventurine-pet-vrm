#!/usr/bin/env bash
# U1/U2 v1 一键脚本（最小工程模式）：
#   1) 用 Unity 6000.2.6f2 创建/复用 work/AventurineBakeProj 空工程
#   2) 只拷贝 Mate-Engine 的 .anim 到 Assets/Clips/MateAnimations（不导入 2.4G 工程）
#   3) 注入 Editor/ClipExporter.cs，用合成 humanoid 骨架逐帧采样
#   4) Node 转 glTF 右手系 clip
#
# 导出执行器（2026-11-08 起）：
#   - 优先用 Unity Hub 自带 CLI：`unity run <project> --timeout … --no-tail -- -executeMethod … -logFile …`
#     （batchmode/quit 由 CLI 自动加，参数经 `--` 转发给编辑器；CLI 从 PATH 或 ~/.unity/bin/unity 发现，
#      并确认支持 `run` 子命令）
#   - CLI 不可用时回退为直接调用 Unity 二进制：`$UNITY_EDITOR` 或 Hub 默认安装路径（-batchmode -nographics -quit）
#   - 走 CLI 时先做授权 preflight：`unity license --json` 解析 data[]，要求存在 product 以 "Unity" 开头、
#     expires 非空且为未来时间的条目；无有效授权 → 打印错误并 exit 1（不静默继续）
#
# 可选环境变量：
#   PROJECT=...           工程路径（默认 work/AventurineBakeProj）
#   CFG=...               clips.json 路径
#   OUT=...               原始导出目录
#   UNITY_EDITOR=...      直接指定 Unity 可执行文件（回退路径）
#   UNITY_RUN_TIMEOUT=... CLI `unity run --timeout` 秒数（默认 900；0 表示不限制由 CLI 决定）
#   AVENTURINE_EXPORT_DRY_RUN=1
#                         只打印将删除的工程目录、不实际 rm -rf（用于守卫自测）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${PROJECT:-$ROOT/work/AventurineBakeProj}"
CFG="${CFG:-$ROOT/scripts/unity-bake/clips.json}"
OUT="${OUT:-$ROOT/scripts/unity-bake/out}"
LOG_DIR="$ROOT/scripts/unity-bake/logs"
LOG="${LOG_FILE:-$LOG_DIR/export-$(date +%Y%m%d-%H%M%S).log}"
SRC_ANIM="$ROOT/refs/Mate-Engine/Assets/MATE ENGINE - Animations"
mkdir -p "$OUT" "$LOG_DIR"

# >>> safe-rm guard (R-10) >>>
# `rm -rf "$PROJECT"` 的守卫：PROJECT 可被环境变量覆盖，必须限制在
#   $ROOT/work/ 或 $HOME/.cache/ 下，且字面路径与 realpath 双重校验。
# 返回 0=通过；非 0=拒绝（调用方 exit 1）。
ensure_safe_remove_target() {
  local target="${1:-}" resolved parent root_real home_real
  if [ -z "$target" ] || [ "$target" = "/" ]; then
    echo "[export] 拒绝删除：路径为空或为根目录（PROJECT='${target}'）" >&2
    return 1
  fi
  case "$target" in
    /*) ;;
    *)
      echo "[export] 拒绝删除：PROJECT 必须是绝对路径（当前: ${target}）" >&2
      return 1
      ;;
  esac
  case "$target" in
    *"/../"*|*"/..")
      echo "[export] 拒绝删除：路径不得包含 '..'（当前: ${target}）" >&2
      return 1
      ;;
  esac

  # realpath：目录已存在则直接解析；否则解析父目录 + basename（调用点在 mkdir -p 之后）。
  if [ -e "$target" ]; then
    resolved="$(cd "$target" && pwd -P)" || return 1
  else
    parent="$(dirname "$target")"
    if [ ! -d "$parent" ]; then
      echo "[export] 拒绝删除：无法解析父目录 realpath（当前: ${target}）" >&2
      return 1
    fi
    resolved="$(cd "$parent" && pwd -P)/$(basename "$target")" || return 1
  fi
  root_real="$(cd "$ROOT" && pwd -P)"
  home_real="$(cd "$HOME" && pwd -P)"

  # 双检：字面路径 + realpath 都必须落在白名单前缀下（防 symlink 逃逸）。
  case "$target" in
    "$ROOT/work/"*|"$HOME/.cache/"*) ;;
    *)
      echo "[export] 拒绝删除：字面路径不在 \$ROOT/work/ 或 \$HOME/.cache/ 下（当前: ${target}）" >&2
      return 1
      ;;
  esac
  case "$resolved" in
    "$root_real/work/"*|"$home_real/.cache/"*) ;;
    *)
      echo "[export] 拒绝删除：realpath 不在 \$ROOT/work/ 或 \$HOME/.cache/ 下（resolved: ${resolved}）" >&2
      return 1
      ;;
  esac

  echo "[export] 删除目标校验通过: $target (realpath: $resolved)"
  return 0
}

# 校验 → 打印 → TTY 下 5s 倒计时（可 Ctrl-C）→ rm -rf。
remove_project_dir() {
  local target="${1:-}"
  ensure_safe_remove_target "$target" || exit 1
  if [ "${AVENTURINE_EXPORT_DRY_RUN:-0}" = "1" ]; then
    echo "[export] DRY_RUN=1，跳过 rm -rf: $target"
    return 0
  fi
  echo "[export] 即将删除工程目录: $target"
  if [ -t 0 ]; then
    echo "[export] 5 秒内可按 Ctrl-C 取消..."
    sleep 5
  fi
  rm -rf -- "$target"
}
# <<< safe-rm guard (R-10) <<<

# 回退路径：直接找 Unity 二进制
find_unity() {
  if [ -n "${UNITY_EDITOR:-}" ] && [ -x "${UNITY_EDITOR}" ]; then echo "$UNITY_EDITOR"; return 0; fi
  for p in \
    "/Applications/Unity/Hub/Editor/6000.2.6f2/Unity.app/Contents/MacOS/Unity" \
    "$HOME/Applications/Unity/Hub/Editor/6000.2.6f2/Unity.app/Contents/MacOS/Unity" \
    /Applications/Unity/Hub/Editor/6000.2.*/Unity.app/Contents/MacOS/Unity; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

# 首选：Unity Hub 自带 CLI（PATH 或 ~/.unity/bin；需支持 run 子命令）
find_unity_cli() {
  local cand
  for cand in "$(command -v unity 2>/dev/null || true)" "$HOME/.unity/bin/unity"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    "$cand" run --help >/dev/null 2>&1 || continue
    printf '%s\n' "$cand"
    return 0
  done
  return 1
}

# 授权 preflight（仅 CLI 模式）：data[] 中 product 以 Unity 开头 + expires 非空 + 未来时间
check_unity_license() {
  local cli="$1" json
  if ! json="$("$cli" license --json 2>/dev/null)"; then
    echo "[export] 无法读取 Unity 授权状态（unity license --json 失败）"
    return 1
  fi
  if ! printf '%s' "$json" | node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let j
  try { j = JSON.parse(s) } catch { console.error("license JSON 解析失败"); process.exit(1) }
  const now = Date.now()
  const list = Array.isArray(j.data) ? j.data : []
  const valid = list.filter((x) => x && typeof x.product === "string" && x.product.startsWith("Unity")
    && typeof x.expires === "string" && x.expires.trim() !== ""
    && Number.isFinite(Date.parse(x.expires)) && Date.parse(x.expires) > now)
  if (valid.length === 0) {
    console.error("没有有效的 Unity 授权（product 以 Unity 开头且 expires 为未来时间）")
    process.exit(1)
  }
  for (const v of valid) console.log(`授权有效: ${v.product}（${v.type || "?"}）expires=${v.expires}`)
  process.exit(0)
})
'; then
    echo "[export] Unity 授权 preflight 失败：请先激活 Unity Personal/Pro（unity license 查看）"
    echo "[export] license --json 原始输出（截断）：$(printf '%s' "$json" | head -c 400)"
    return 1
  fi
  return 0
}

UNITY_CLI="$(find_unity_cli || true)"
UNITY=""
if [ -n "$UNITY_CLI" ]; then
  echo "[export] unity cli: $UNITY_CLI"
  check_unity_license "$UNITY_CLI" || exit 1
else
  if ! UNITY="$(find_unity)"; then
    echo "[export] 找不到 unity CLI，也找不到 Unity 6000.2.6f2；设置 UNITY_EDITOR=/path/to/Unity"
    exit 1
  fi
  echo "[export] unity: $UNITY"
fi

# 1) 最小工程
if [ ! -f "$PROJECT/ProjectSettings/ProjectVersion.txt" ]; then
  echo "[export] 创建空工程: $PROJECT"
  mkdir -p "$(dirname "$PROJECT")"
  remove_project_dir "$PROJECT"
  "$UNITY" -batchmode -nographics -quit -createProject "$PROJECT" -logFile "$LOG_DIR/create-project.log" || {
    echo "[export] 创建工程失败，看 $LOG_DIR/create-project.log"; exit 1; }
fi

# 2) 只拷 .anim（保持目录结构）
mkdir -p "$PROJECT/Assets/Clips/MateAnimations"
if [ ! -d "$SRC_ANIM" ]; then
  echo "[export] 缺少 $SRC_ANIM"; exit 1
fi
rsync -a --include='*/' --include='*.anim' --exclude='*' "$SRC_ANIM/" "$PROJECT/Assets/Clips/MateAnimations/"
echo "[export] 拷贝 .anim 数量: $(find "$PROJECT/Assets/Clips/MateAnimations" -name '*.anim' | wc -l | tr -d ' ')"

# 3) 注入采样脚本
mkdir -p "$PROJECT/Assets/Editor/AventurineBake"
cp "$ROOT/scripts/unity-bake/Editor/ClipExporter.cs" "$PROJECT/Assets/Editor/AventurineBake/ClipExporter.cs"

# 4) 采样（首次会导入 128 个 .anim 并编译脚本，可能需要几分钟）
set +e
if [ -n "$UNITY_CLI" ]; then
  AVENTURINE_BAKE_CONFIG="$CFG" AVENTURINE_BAKE_OUT="$OUT" \
    "$UNITY_CLI" run "$PROJECT" --timeout "${UNITY_RUN_TIMEOUT:-900}" --no-tail -- \
    -executeMethod AventurineBake.ClipExporter.Run -logFile "$LOG"
  CODE=$?
else
  AVENTURINE_BAKE_CONFIG="$CFG" AVENTURINE_BAKE_OUT="$OUT" \
    "$UNITY" -batchmode -nographics -quit \
    -projectPath "$PROJECT" \
    -executeMethod AventurineBake.ClipExporter.Run \
    -logFile "$LOG"
  CODE=$?
fi
set -e

if [ $CODE -ne 0 ]; then
  echo "[export] Unity 退出码 ${CODE}；日志尾部："
  tail -n 80 "$LOG" 2>/dev/null || true
  exit $CODE
fi

echo "[export] 原始导出完成 → $OUT"
# 坐标反射轴（2026-11-08 Wave 1.5-Tpose 更新）：
#   目标 VRM 是标准 VRM 1.0（面向 +Z、左手 +X）：Unity（左手系，面向 +Z 时左手 -X）
#   到 VRM1 需要反射 X 轴 → `--axis x`。
#   旧资产（VRM0 风格/面向 -Z，如 canary、Zome、aventurine-waveflair.vrm）对应的是
#   `--axis z`（第一版数据）；两者相差一个绕 Y 的 180° 约定，播放时需按模型约定选择。
node "$ROOT/scripts/unity-bake/convert-clips.mjs" --in "$OUT" --out "$ROOT/assets/motions/mate" --axis x --hips-mode relative
# 初始姿态微调（规则在 pose-tune.json：只动 introStart 起始站立段的手臂；见 docs/vrm-tpose-repair.md §6）
node "$ROOT/scripts/unity-bake/tune-pose.mjs"
echo "[export] 完成。clip JSON 在 assets/motions/mate/（私有，不提交）"
