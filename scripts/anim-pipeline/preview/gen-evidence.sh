#!/usr/bin/env bash
# 批量生成「外部 MMD 动作包 × 本 PMX」的观感证据：截图 + 接触表 + 兼容性元数据。
#
# 输出：tests/tmp/preview/<case>/（frames/*.png + contact-sheet.png + metadata.json +
#       compatibility.md + index.md + run.log），tests/tmp 已 gitignore，二进制不入库。
#
# 前提：动作文件在 tests/tmp/motions/（motion-hunt / Lead 下载或转换，gitignore）：
#   - motions/bear_walk.vmd                      第三方真实 VMD（bear 骨架，IK 驱动走路）
#   - motions/converted/{Idle,Taunt,Run_Lfoot,Arms Down}.vmd   Lead 用 reze-rig 把 humanoid FBX 转的 VMD
#   - motions/threejs_r171/vpds/*.vpd             three.js 官方示例 VPD（初音ミク骨架）
# 缺少的文件会自动跳过（只对存在的文件跑）。
#
# 用法：./scripts/anim-pipeline/preview/gen-evidence.sh [case ...]
#   不带参数 = 跑全部；带参数 = 只跑指定 case（见下方 case 名）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

MOTIONS="tests/tmp/motions"
OUT_DIR="tests/tmp/preview"
RUN="$SCRIPT_DIR/run.sh"

FAILED=()
SKIPPED=()
RAN=()

want() {
  local name="$1"
  if [[ $# -eq 0 || ${#ONLY[@]} -eq 0 ]]; then return 0; fi
  local item
  for item in "${ONLY[@]}"; do [[ "$item" == "$name" ]] && return 0; done
  return 1
}

ONLY=("$@")

run_case() {
  local name="$1"
  shift
  if ! want "$name"; then return 0; fi
  echo ""
  echo "=== [gen-evidence] $name ==="
  local start
  start=$(date +%s)
  if "$RUN" "$@" --out "$OUT_DIR/$name"; then
    RAN+=("$name")
    echo "--- [gen-evidence] $name OK ($(($(date +%s) - start))s)"
  else
    FAILED+=("$name")
    echo "--- [gen-evidence] $name FAILED ($(($(date +%s) - start))s)" >&2
  fi
}

need_file() {
  if [[ ! -f "$1" ]]; then
    SKIPPED+=("$2（缺少 $1）")
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------- 1. 第三方走路 VMD
if need_file "$MOTIONS/bear_walk.vmd" bear_walk; then
  # 一个走路周期约 32 帧：0-40 帧覆盖左脚/右脚各一次抬落
  run_case bear_walk --motion "$MOTIONS/bear_walk.vmd" \
    --frames 0,4,8,12,16,20,24,28,32,36,40 --angles front,side,45
  # side 视角连续帧（16 帧 / 2 帧步长）：判断脚掌滚动、滑步、穿模
  run_case bear_walk-side --motion "$MOTIONS/bear_walk.vmd" \
    --frames 0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30 --angles side
  # 对照：关掉 CCDIK（--ik off）后同一组帧，证明「模型自带 4 根足ＩＫ」对动作的影响
  run_case bear_walk-ik-off --motion "$MOTIONS/bear_walk.vmd" \
    --frames 0,4,8,12,16,20,24,28,32,36,40 --angles side --ik off
fi

# ------------------------------------------------------- 2-4. reze-rig 转换的 VMD
if need_file "$MOTIONS/converted/Idle.vmd" Idle; then
  run_case Idle --motion "$MOTIONS/converted/Idle.vmd" \
    --frames 0,10,20,30,40,50,60,70,80,90 --angles front,side,45
fi
if need_file "$MOTIONS/converted/Taunt.vmd" Taunt; then
  run_case Taunt --motion "$MOTIONS/converted/Taunt.vmd" \
    --frames 0,9,18,27,36,45,54,63,72,81 --angles front,side,45
fi
if need_file "$MOTIONS/converted/Run_Lfoot.vmd" Run_Lfoot; then
  run_case Run_Lfoot --motion "$MOTIONS/converted/Run_Lfoot.vmd" \
    --frames 0,2,4,6,8,10,12,14,16,18,20 --angles front,side,45
fi
if need_file "$MOTIONS/converted/Arms Down.vmd" ArmsDown; then
  run_case ArmsDown --motion "$MOTIONS/converted/Arms Down.vmd" \
    --frames 0,1 --angles front,side,45
fi

# ------------------------------------------------------------- 5. VPD 静态姿势
for vpd in 01 05 09; do
  if need_file "$MOTIONS/threejs_r171/vpds/$vpd.vpd" "vpd-$vpd"; then
    run_case "vpd-$vpd" --vpd "$MOTIONS/threejs_r171/vpds/$vpd.vpd" --angles front,side,45
  fi
done
# 内置自造 VPD（真实骨名 + UTF-8）：验证 VPD 管线本身是否可用
run_case synthetic-vpd --synthetic-vpd --angles front,side,45

# ------------------------------------------- 6. （可选）three.js 官方长动作样本
if need_file "$MOTIONS/threejs_r171/wavefile_v2.vmd" wavefile_v2; then
  run_case wavefile_v2 --motion "$MOTIONS/threejs_r171/wavefile_v2.vmd" \
    --frames 0,700,1400,2100,2800 --angles front,side,45
fi

echo ""
echo "================ gen-evidence 汇总 ================"
echo "输出目录：$OUT_DIR"
printf 'OK: %s\n' "${RAN[*]:-（无）}"
printf 'FAILED: %s\n' "${FAILED[*]:-（无）}"
printf 'SKIPPED: %s\n' "${SKIPPED[*]:-（无）}"
[[ ${#FAILED[@]} -eq 0 ]]
