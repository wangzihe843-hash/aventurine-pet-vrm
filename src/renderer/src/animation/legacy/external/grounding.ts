/**
 * 外部动作的**脚底贴地纯计算**（不 import three；坐标都是标量，Node 可单测）。
 *
 * 背景（`docs/research/vmd-preview-tool.md` §4 A1 / §5 K6）：
 * VMD 动作的 `センター` Y 位移与脚部 FK/IK 姿态会让整体浮空/穿地（Idle 实测浮空约 20px@540px、
 * Taunt 13px、Run 34px），而 `modelRoot` 的摆放归 Lead 的 PetScene 所有，B3 不能写。
 * 做法：每帧按「脚骨世界最低点」相对 **bind pose 脚底** 的漂移，给 `mesh.position.y`
 * （SkinnedMesh 自身局部平移，不改 PetScene 的 root）做整体补偿；补偿后残余误差供冒烟断言。
 *
 * 纯函数只做标量换算，three 世界坐标采样在 `vmd-driver.ts`（便于 Node 单测公式本身）。
 */

/** 贴地残余误差的冒烟阈值（CSS px；与 B3 `footErrorPx` 站/走断言同口径）。 */
export const FOOT_GROUND_TOLERANCE_PX = 2

function safeScale(scaleY: number): number {
  return Number.isFinite(scaleY) && Math.abs(scaleY) > 1e-9 ? scaleY : 1
}

/**
 * 脚底「应有」的世界 Y：bind pose 脚底局部 Y × modelRoot 世界缩放 + modelRoot 世界 Y。
 * （PetScene 世界单位 = CSS 像素、y 向上；rotation 绕 Y 不影响高度。）
 */
export function expectedFootGroundWorldY(
  restFootMinLocalY: number,
  rootScaleY: number,
  rootWorldY: number
): number {
  const rest = Number.isFinite(restFootMinLocalY) ? restFootMinLocalY : 0
  const worldY = Number.isFinite(rootWorldY) ? rootWorldY : 0
  return rest * safeScale(rootScaleY) + worldY
}

/**
 * 整体贴地补偿量（`mesh.position.y` 的**增量**，模型局部单位）：
 * 把当前脚底世界 Y 拉回应有地面高度 → `-(current - expected) / scaleY`。
 *
 * 说明：动作理想情况下脚始终贴地，这个量 ≈ 0；VMD 整体浮空/穿地时它把整个人抬/压回去。
 */
export function groundingOffsetLocalY(
  currentFootMinWorldY: number,
  expectedWorldY: number,
  rootScaleY: number
): number {
  if (!Number.isFinite(currentFootMinWorldY) || !Number.isFinite(expectedWorldY)) return 0
  const offset = -(currentFootMinWorldY - expectedWorldY) / safeScale(rootScaleY)
  // 归一化 -0（便于调试快照/断言；-0 在 JSON/Object.is 里不友好）
  return offset === 0 ? 0 : offset
}

/** 补偿后的残余贴地误差（世界单位 = CSS px；取绝对值）。 */
export function footGroundingErrorPx(
  currentFootMinWorldY: number,
  expectedWorldY: number
): number {
  if (!Number.isFinite(currentFootMinWorldY) || !Number.isFinite(expectedWorldY)) return Number.NaN
  return Math.abs(currentFootMinWorldY - expectedWorldY)
}

/** 从一组脚骨世界 Y 里取最低点；空/全非法 → null。 */
export function lowestFootWorldY(values: readonly number[]): number | null {
  let min = Number.POSITIVE_INFINITY
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (value < min) min = value
  }
  return Number.isFinite(min) ? min : null
}
