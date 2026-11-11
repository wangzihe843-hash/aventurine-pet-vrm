/**
 * canvas backing store 像素比（F08；纯函数，不依赖 three/DOM，可在 node 单测）。
 *
 * 背景：原实现 `min(max(dpr,1) * 2, 2)` 在 1x 大屏上恒 2x 超采样（backing store 面积 ×4）：
 * 1080p@1x 已实测正常，但 1440p/4K@1x 的 GPU 内存/填充率有风险（C4 前处理）。
 *
 * 策略（像素预算）：
 * - DPR≥1.5（Retina/缩放屏）：按原生 dpr 渲染（不超采样），上限 2 —— 这是系统标准行为，
 *   不存在额外预算风险；
 * - DPR<1.5（普通 1x 屏）：在 `PIXEL_BUDGET_PX ≈ 4K（3840×2160）` 的 backing store 预算内
 *   尽量超采样，1080p@1x → 2x（面积 = 预算）、1440p@1x → 1.5x、4K@1x → 1x、更大 → 1x。
 *
 * 预算公式：`ratio = sqrt(PIXEL_BUDGET / (cssWidth × cssHeight))`，钳制到 [1, 2]。
 * 这样「backing store 像素数 ≈ min(4 × CSS 面积, 预算)」，大屏不会突破目标显存/填充率。
 */

/** 超采样上限（DPR 只影响 backing store，投影坐标仍是 CSS px）。 */
export const PIXEL_RATIO_MAX = 2

/** 下限：不允许低于 CSS 像素（避免 1x 大屏反向降采样导致发虚）。 */
export const PIXEL_RATIO_MIN = 1

/** backing store 像素预算 ≈ 4K（3840×2160 = 8,294,400 px）。 */
export const PIXEL_BUDGET_PX = 3840 * 2160

/**
 * 计算 canvas pixelRatio。
 *
 * @param devicePixelRatio `window.devicePixelRatio`（非法值按 1 处理）
 * @param viewportWidth    CSS 像素宽（#app clientWidth）
 * @param viewportHeight   CSS 像素高（#app clientHeight）
 * @returns [1, 2] 区间内的有限数；视口尺寸非法时退回安全值（不超采样）。
 */
export function computePixelRatio(
  devicePixelRatio: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.max(devicePixelRatio, 1) : 1
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0

  // 视口未知：不超采样（最多按原生 dpr，且 ≤2），避免异常大 buffer。
  if (width <= 0 || height <= 0) return Math.min(PIXEL_RATIO_MAX, dpr)

  // Retina / 缩放屏：原生 dpr（不超采样），上限 2。
  if (dpr >= 1.5) return Math.min(dpr, PIXEL_RATIO_MAX)

  // 1x 屏：像素预算内尽量超采样（1080p→2x / 1440p→1.5x / 4K→1x）。
  const budgetRatio = Math.sqrt(PIXEL_BUDGET_PX / (width * height))
  const ratio = Math.min(PIXEL_RATIO_MAX, Math.max(PIXEL_RATIO_MIN, budgetRatio))
  // 保留 2 位小数：避免 1366×768 这类尺寸得到 2.81→2 之外的过长小数传给 GPU。
  return Math.round(ratio * 100) / 100
}
