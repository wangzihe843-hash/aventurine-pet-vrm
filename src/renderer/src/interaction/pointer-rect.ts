/**
 * 视觉命中矩形换算（F4 / NEW-1 修复；纯函数，不 import DOM/three，可单测）。
 *
 * 背景：窗沿坐（`seatedAnchor='hips'`）等场景下，动画层（vmd-driver）会给网格叠加
 * `mesh.position.y` 位移，把模型**视觉**整体移动；该增量以 `visualOffsetYPx`
 * （CSS px，three 世界 Y 方向：**正 = 视觉向上、负 = 视觉向下**）暴露到调试快照。
 * 而 `petRect` 仍是物理口径（脚底/包围盒），命中矩形、点击拦截带、气泡都必须跟随
 * 视觉位置。屏幕坐标 y 向下，因此换算为 `rect.y - visualOffsetYPx`。
 *
 * 历史 bug（NEW-1）：Consumer 曾写成 `rect.y + visualOffsetYPx`，与 producer 方向相反，
 * 窗沿坐时命中区被抬高 2×|offset|（实测 offset≈-214px → 错位≈428px），宠物看得见点不到。
 */
import type { Rect } from '@shared/types'

/** 视觉偏移生效阈值（CSS px；更小的值视为贴地补偿噪声，不产生独立命中矩形）。 */
export const VISUAL_OFFSET_EPSILON_PX = 0.5

/**
 * 归一化动画层视觉偏移：非法/非有限/绝对值 ≤ 阈值 → 0（= 不偏移）。
 *
 * @param offset `AnimationDebugSnapshot.visualOffsetYPx`（three 世界 Y 增量，正=向上）
 */
export function resolveVisualOffsetPx(offset: number | null | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0
  return Math.abs(offset) > VISUAL_OFFSET_EPSILON_PX ? offset : 0
}

/* -------------------------------------------------------------------------- */
/* L2（M-3）：foot-lock hips 水平对齐 → 命中/气泡横向补偿                        */
/* -------------------------------------------------------------------------- */

/**
 * hips 横移补偿的生效阈值（CSS px；更小视为平滑/像素级噪声 → 不产生独立命中矩形）。
 * 与 `VISUAL_OFFSET_EPSILON_PX` 同口径：`hipShift` 以 τ=0.3s 平滑，相邻帧最多约 14px，
 * 0.5px 以内不改变命中矩形。
 */
export const HIP_SHIFT_EPSILON_PX = 0.5
/**
 * hips 横移补偿的钳制上限（CSS px）。
 * `foot-lock` 的 hips 对齐预算 `MAX_HIP_SHIFT_M = 0.18m`，540px 宠物 @311.42px/m ≈ 56px；
 * 96px 留 ~1.7× 裕量（更大尺寸宠物/异常快照也不会把命中区甩出宠物附近）。
 */
export const HIP_SHIFT_MAX_PX = 96

/**
 * 归一化 hips 横移补偿：非法/非有限 → 0；钳制 ±`HIP_SHIFT_MAX_PX`；绝对值 ≤ ε → 0。
 *
 * @param value 屏幕横向补偿（CSS px，向右为正；来自 `PetView.getHipShiftScreenXPx()`）
 */
export function resolveHipShiftPx(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const clamped = Math.max(-HIP_SHIFT_MAX_PX, Math.min(HIP_SHIFT_MAX_PX, value))
  return Math.abs(clamped) > HIP_SHIFT_EPSILON_PX ? clamped : 0
}

/**
 * hips 水平对齐（scene 局部米）→ 屏幕横向 CSS px（向右为正）。
 *
 * 推导（REPORT §5.1）：`hipShift` 是 `avatar.scene` 局部米制向量，`avatar.scene` 是
 * `modelRoot` 的 identity 子节点 → scene-local = modelRoot-local；正交相机正视 →
 * 世界 x 直接映射屏幕 x，且 `CSS px/m = pixelsPerMeter`（= 宠物 rect.height / restHeight）。
 * `modelRoot.rotation.y = modelYawOffsetRad + facingYawCurrent`：
 *
 *   screenX = ppm · (cos(yaw)·shiftX + sin(yaw)·shiftZ)
 *
 * - front（yaw=0）→ `ppm·shiftX`；
 * - 侧身 ±90° → 局部 z 映射到屏幕 x（cos=0），局部 x 转成深度不再贡献屏幕 x；
 * - yaw=180°（yawOffset=180 的资产）→ `−ppm·shiftX`；
 * - hipShift 恒 y=0 → 与竖向 `visualOffsetYPx` 正交，可同时叠加。
 *
 * 非法输入（NaN/Inf/ppm≤0）→ 0（宁可不补偿，也不能把命中区甩飞）。
 */
export function hipShiftToScreenXPx(input: {
  shiftXM: number
  shiftZM: number
  yawRad: number
  pixelsPerMeter: number
}): number {
  const { shiftXM, shiftZM, yawRad, pixelsPerMeter } = input
  if (
    !Number.isFinite(shiftXM) ||
    !Number.isFinite(shiftZM) ||
    !Number.isFinite(yawRad) ||
    !Number.isFinite(pixelsPerMeter) ||
    !(pixelsPerMeter > 0)
  ) {
    return 0
  }
  return pixelsPerMeter * (Math.cos(yawRad) * shiftXM + Math.sin(yawRad) * shiftZM)
}

/**
 * 把物理口径 `petRect` 换算为「视觉命中矩形」（窗口本地 CSS px、y 向下）。
 *
 * 视觉位移是 three 世界 Y 增量（向上为正），屏幕方向相反 → `y - offset`：
 * - `offset = -327`（视觉下移 327px）→ `y += 327`（命中矩形同步下移 327px）；
 * - `offset = 0/非法` → 原坐标（返回副本，不修改入参）。
 *
 * 第三参 `shiftXPx`（L2 / M-3）：foot-lock 的 hips 水平对齐让身体视觉横移（≤0.18m≈56px），
 * 命中/气泡必须同步横移；默认 0 → 旧调用逐位兼容（`x + 0` 不改坐标）。
 * 坐姿 `visualOffsetY` 与 hipShift 正交，可同时生效。
 */
export function offsetPetRectForVisual(
  rect: Rect,
  visualOffsetY: number | null | undefined,
  shiftXPx = 0
): Rect {
  const offset = resolveVisualOffsetPx(visualOffsetY)
  const shiftX = resolveHipShiftPx(shiftXPx)
  return { ...rect, x: rect.x + shiftX, y: rect.y - offset }
}
