#!/usr/bin/env bash
# reze-rig CLI 包装：humanoid FBX（Mixamo / UE / Unity / 3ds Max Biped / CC 命名）
# → 以本项目 PMX 为 target 的 MMD VMD（30fps，可选脚 IK / 原地化）。
#
# 用法（仓库根目录或任意目录；参数原样透传给上游 CLI）：
#   ./scripts/anim-pipeline/reze/convert.sh <fbx 或目录...> \
#     --target-pmx "assets/model/optimized/星穹铁道—砂金·戏浪.pmx" \
#     --in-place --out "tests/tmp/motions/free/vmd"
#
# 常用参数（详见 scripts/fbx2vmd.ts 顶部注释）：
#   --target-pmx <pmx>   以该 PMX 实测骨骼世界坐标/比例/morph 表作重定向目标（强烈建议）
#   --in-place           清掉センター水平位移（保留竖直 bob）→ 桌宠原地走
#   --no-foot-ik         不生成 足ＩＫ 位移轨道（纯 FK；默认生成，走路/坐下建议默认开）
#   --bind-ref <idle.fbx> Unity/UE 每次导出嵌入「循环中段」当 rest 时，用 idle 作 bind 参考
#   --out <dir>          输出目录（默认 input 同目录；本管线约定写 tests/tmp/motions/free/vmd）
#
# 注意：产物 VMD 只用于本机个人使用，不得提交/再分发（授权见 docs/research/motion-free-pipeline.md）。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$DIR/.dist/fbx2vmd.mjs" ]]; then
  "$DIR/build.sh"
fi

exec node "$DIR/.dist/fbx2vmd.mjs" "$@"
