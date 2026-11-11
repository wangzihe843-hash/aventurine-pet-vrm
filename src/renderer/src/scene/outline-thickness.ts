/**
 * 描边像素宽度自适应（纯函数，**不 import three / DOM**，可在 vitest node 环境单测）。
 *
 * 口径（PLAN §19.11「描边方案 B」）：
 * - 使用 `scene/outline-effect-screen.ts`（vendored 屏幕空间 OutlineEffect）时，
 *   `outlineThickness` 的单位是 **CSS 像素**，横竖方向同宽；
 * - 目标宽度随宠物屏幕高度**轻度自适应**：`petHeightPx * 0.0022`，再钳制到
 *   `[0.6, 1.6]px` —— 30%（324px）≈0.71px、50%（540px）≈1.19px、100%（961px）≈1.6px，
 *   视觉上都保持细线且比例相近（实测旧实现竖边 1.65px / 横边 3.3px 偏粗）；
 * - 每个材质保留 PMX 作者的相对粗细（edgeSize 0.4–1.03，按 1.03 归一化），
 *   并给一个下限 0.45px 防止最细材质在低分屏上消失。
 */

/** 目标描边宽度 / 宠物屏幕高度：0.22%（540px 宠 ≈ 1.19px）。 */
export const OUTLINE_PX_PER_PET_PX = 0.0022

/** 基础描边像素宽度下限（宠物很小时不再变细，避免消失）。 */
export const OUTLINE_BASE_MIN_PX = 0.6

/** 基础描边像素宽度上限（宠物很大时不再变粗，避免出屏感）。 */
export const OUTLINE_BASE_MAX_PX = 1.6

/** 单个材质描边像素宽度下限（保留作者粗细差异的前提下保证可见）。 */
export const OUTLINE_MATERIAL_MIN_PX = 0.45

/** PMX 模型里最大的 edgeSize（用于把 0.4–1.03 的 edgeSize 归一化成 0–1 比例）。 */
export const OUTLINE_EDGE_REFERENCE = 1.03

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 基础描边宽度（CSS 像素）：按宠物屏幕高度自适应并钳制到 [0.6, 1.6]。
 * 非有限 / <=0 的输入返回下限（调用方在宠物未摆放时应自行跳过写厚度）。
 */
export function computeOutlineBasePx(petHeightPx: number): number {
  const height = Number.isFinite(petHeightPx) && petHeightPx > 0 ? petHeightPx : 0
  return clamp(height * OUTLINE_PX_PER_PET_PX, OUTLINE_BASE_MIN_PX, OUTLINE_BASE_MAX_PX)
}

/**
 * 某材质的描边宽度（CSS 像素）：基础宽度 × 作者相对粗细（edgeSize / 1.03），
 * 钳制到 [0.45, 1.6]。非法 edgeSize（NaN/<=0）回退为基础宽度。
 */
export function computeMaterialOutlinePx(petHeightPx: number, edgeSize: number): number {
  const basePx = computeOutlineBasePx(petHeightPx)
  const safeEdgeSize =
    Number.isFinite(edgeSize) && edgeSize > 0 ? edgeSize : OUTLINE_EDGE_REFERENCE
  const ratio = clamp(safeEdgeSize / OUTLINE_EDGE_REFERENCE, 0.25, 1)
  return clamp(basePx * ratio, OUTLINE_MATERIAL_MIN_PX, OUTLINE_BASE_MAX_PX)
}

/** edgeSize → 归一化相对粗细（0.25–1；非有限/<=0 视为 1），供调试面/测试。 */
export function computeOutlineEdgeRatio(edgeSize: number): number {
  const safeEdgeSize =
    Number.isFinite(edgeSize) && edgeSize > 0 ? edgeSize : OUTLINE_EDGE_REFERENCE
  return clamp(safeEdgeSize / OUTLINE_EDGE_REFERENCE, 0.25, 1)
}
