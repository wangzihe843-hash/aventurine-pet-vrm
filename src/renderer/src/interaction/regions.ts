/**
 * 宠物身体区域命中（B4；纯逻辑，**不 import DOM/three/electron**，可在 node 单测）。
 *
 * 坐标系：全部为**窗口本地 CSS 像素**（origin = overlay 窗口左上角，x→右、y→下），
 * 与 `model/layout.ts` 的 `petRect`、`interaction/pointer-gate.ts` 完全同口径。
 *
 * ## 区域划分依据（按 petRect 高度比例，从顶到底）
 *
 * 任务书建议「头 ≈ 顶部 12–30% 带」，但本仓库模型的**绑定姿势实测**（A2 数据：
 * `pmx.bones` + 顶点 bbox，高 21.681 MMD 单位）显示：
 * - `頭` 骨骼在距顶 **11.3%**、`首` 在 15.5%、`左肩` 在 19.6%、`上半身` 在 37.8%；
 * - 50% 尺寸（540px）实机截图的 alpha 剪影：头部窄段 0–17%，肩/手臂最宽段 17–44%；
 * - 因此「头」实际覆盖矩形**顶部 0–30%**：任务书写的 12–30% 只是头的下半部分，
 *   如果只取 12–30%，摸头轨迹（圆心在头中心、半径带跨过 0–25%）会有一半落在区域外。
 *
 * 实现取舍（见 README「参数」节）：头 = **顶部 0–30% 且水平方向收窄到中间 44%**（头形略收窄）；
 * 躯干 = 30–55%；腿 = 55–100%。这样任务书里的 12–30% 带完全落在 head 内，同时覆盖真实头顶。
 *
 * `hitTestRegion` 对宠物矩形内**任意点**返回区域（头部带但水平超出收窄范围的点归为 body，
 * 即肩/手臂），只有矩形外/null/非法输入返回 null——与 pointer-gate 的半开区间命中语义一致。
 */
import type { Rect } from '@shared/types'

import type { Point2D, PokeRegion } from '../core/wave2-contract'

/**
 * 区域分带比例（相对 petRect 顶部的 0–1 归一化 y）。
 *
 * - `headBottom = 0.30`：实测头部（含发顶）+ 颈部过渡带的下边界；
 * - `bodyBottom = 0.55`：躯干下边界（髋部 ≈ 38.6%、膝 ≈ 68.8%，取大腿中段 55%）；
 * - 头水平收窄 `[0.28, 0.72]`（模型头部剪影约 0.37–0.66，留一点容错）。
 */
export const REGION_RATIOS = {
  /** 头部带下边界（含）；头部带实际从矩形顶部 0 开始。 */
  headBottom: 0.3,
  /** 躯干带下边界（含）；之下为腿。 */
  bodyBottom: 0.55,
  /** 头部水平收窄范围（占 petRect 宽度的比例）。 */
  headXMin: 0.28,
  headXMax: 0.72
} as const

/** 归一化到宠物矩形的点（0–1，左上原点、y 向下）。 */
export interface NormalizedPetPoint {
  /** 水平归一化坐标（0 = 左边缘，1 = 右边缘）。 */
  nx: number
  /** 垂直归一化坐标（0 = 矩形顶部，1 = 底部）。 */
  ny: number
}

/** 矩形是否可用于区域命中（有限且宽高为正）。 */
function isValidRect(rect: Rect | null | undefined): rect is Rect {
  if (!rect) return false
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

/**
 * 把窗口本地坐标归一化到宠物矩形。
 *
 * 采用与 `hitTestPetRect` 一致的**半开区间** `[0,1) × [0,1)`：
 * 正好落在右边缘/下边缘的点视为矩形外（相邻矩形不重复命中）；非法输入返回 null。
 */
export function normalizePetPoint(
  petRect: Rect | null | undefined,
  point: Point2D | null | undefined
): NormalizedPetPoint | null {
  if (!isValidRect(petRect)) return null
  if (!point) return null
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  const nx = (point.x - petRect.x) / petRect.width
  const ny = (point.y - petRect.y) / petRect.height
  if (nx < 0 || nx >= 1 || ny < 0 || ny >= 1) return null
  return { nx, ny }
}

/**
 * 区域命中：返回点所属的 `PokeRegion`，矩形外/非法输入返回 null。
 *
 * 水平方向只有头部带需要收窄；收窄范围外的点（肩/手臂）归为 `body`，
 * 保证「点在宠物矩形内就一定能被戳到/拖到」（拖动不依赖区域，但 poke 需要 region）。
 */
export function hitTestRegion(
  petRect: Rect | null | undefined,
  point: Point2D | null | undefined
): PokeRegion | null {
  const normalized = normalizePetPoint(petRect, point)
  if (!normalized) return null
  const { nx, ny } = normalized
  if (ny < REGION_RATIOS.headBottom) {
    const inHeadSpan = nx >= REGION_RATIOS.headXMin && nx < REGION_RATIOS.headXMax
    return inHeadSpan ? 'head' : 'body'
  }
  if (ny < REGION_RATIOS.bodyBottom) return 'body'
  return 'leg'
}

/** 是否落在「头部带」（不含水平收窄；用于摸头/悬停等对头顶更宽容的判定）。 */
export function hitTestHeadBand(
  petRect: Rect | null | undefined,
  point: Point2D | null | undefined
): boolean {
  const normalized = normalizePetPoint(petRect, point)
  return normalized !== null && normalized.ny < REGION_RATIOS.headBottom
}

/** 是否落在收窄后的「头形」内（水平 + 垂直都满足）。 */
export function hitTestHeadShape(
  petRect: Rect | null | undefined,
  point: Point2D | null | undefined
): boolean {
  return hitTestRegion(petRect, point) === 'head'
}

/**
 * 区域矩形（窗口本地 px；调试/单测用）。非法区域或矩形返回 null。
 * 头部返回**收窄后**的矩形；躯干/腿返回矩形全宽。
 */
export function regionBounds(
  petRect: Rect | null | undefined,
  region: PokeRegion
): Rect | null {
  if (!isValidRect(petRect)) return null
  const { x, y, width, height } = petRect
  if (region === 'head') {
    const left = x + width * REGION_RATIOS.headXMin
    return {
      x: left,
      y,
      width: width * (REGION_RATIOS.headXMax - REGION_RATIOS.headXMin),
      height: height * REGION_RATIOS.headBottom
    }
  }
  if (region === 'body') {
    return {
      x,
      y: y + height * REGION_RATIOS.headBottom,
      width,
      height: height * (REGION_RATIOS.bodyBottom - REGION_RATIOS.headBottom)
    }
  }
  return {
    x,
    y: y + height * REGION_RATIOS.bodyBottom,
    width,
    height: height * (1 - REGION_RATIOS.bodyBottom)
  }
}
