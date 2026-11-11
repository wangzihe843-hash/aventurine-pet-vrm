/**
 * 单测：描边像素宽度自适应（`src/renderer/src/scene/outline-thickness.ts`，纯函数）。
 *
 * 口径（PLAN §19.11）：
 * - 屏幕空间恒定像素：宽度与窗口宽高比 / DPR / 模型缩放解耦（横竖同宽由 vendored shader 保证）；
 * - 随宠物屏幕高度轻度自适应：0.22% × petHeightPx，钳制 [0.6, 1.6] CSS px；
 * - 每材质保留 PMX edgeSize 的相对粗细（0.4–1.03 → ratio 0.39–1），下限 0.45px。
 */
import { describe, expect, it } from 'vitest'

import {
  computeMaterialOutlinePx,
  computeOutlineBasePx,
  computeOutlineEdgeRatio,
  OUTLINE_BASE_MAX_PX,
  OUTLINE_BASE_MIN_PX,
  OUTLINE_EDGE_REFERENCE,
  OUTLINE_MATERIAL_MIN_PX,
  OUTLINE_PX_PER_PET_PX
} from '../src/renderer/src/scene/outline-thickness'

describe('computeOutlineBasePx：随宠物高度自适应 + 钳制', () => {
  it('30% / 50% / 100%（1080p → 324 / 540 / 961px）对应 ≈0.71 / 1.19 / 1.6px', () => {
    expect(computeOutlineBasePx(324)).toBeCloseTo(0.7128, 4)
    expect(computeOutlineBasePx(540)).toBeCloseTo(1.188, 4)
    // 100% 封顶后 961px → 2.11 被上限钳制到 1.6
    expect(computeOutlineBasePx(961)).toBe(OUTLINE_BASE_MAX_PX)
  })

  it('极小宠物 / 非法输入：回退下限 0.6px（不消失）', () => {
    expect(computeOutlineBasePx(10)).toBe(OUTLINE_BASE_MIN_PX)
    expect(computeOutlineBasePx(0)).toBe(OUTLINE_BASE_MIN_PX)
    expect(computeOutlineBasePx(-5)).toBe(OUTLINE_BASE_MIN_PX)
    expect(computeOutlineBasePx(Number.NaN)).toBe(OUTLINE_BASE_MIN_PX)
    expect(computeOutlineBasePx(Number.POSITIVE_INFINITY)).toBe(OUTLINE_BASE_MIN_PX)
  })

  it('单调不减：宠物越大基础宽度不会变小（钳制区间内）', () => {
    const samples = [100, 200, 300, 400, 500, 600, 700]
    const widths = samples.map((height) => computeOutlineBasePx(height))
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index]).toBeGreaterThanOrEqual(widths[index - 1])
    }
  })
})

describe('computeMaterialOutlinePx：保留 PMX 各材质相对粗细', () => {
  it('540px 宠物：edgeSize 1.03 / 0.618 / 0.4 → ≈1.19 / ≈0.71 / ≈0.46px', () => {
    expect(computeMaterialOutlinePx(540, 1.03)).toBeCloseTo(1.188, 3)
    expect(computeMaterialOutlinePx(540, 0.618)).toBeCloseTo(0.7128, 3)
    expect(computeMaterialOutlinePx(540, 0.4)).toBeCloseTo(0.4614, 3)
  })

  it('最细材质不低于 0.45px，最粗不超过 1.6px', () => {
    expect(computeMaterialOutlinePx(10, 0.4)).toBe(OUTLINE_MATERIAL_MIN_PX)
    expect(computeMaterialOutlinePx(2000, 1.03)).toBe(OUTLINE_BASE_MAX_PX)
    for (const edgeSize of [0.4, 0.618, 0.90125, 1.03]) {
      const width = computeMaterialOutlinePx(961, edgeSize)
      expect(width).toBeGreaterThanOrEqual(OUTLINE_MATERIAL_MIN_PX)
      expect(width).toBeLessThanOrEqual(OUTLINE_BASE_MAX_PX)
    }
  })

  it('非法 edgeSize：回退为参考值（= 基础宽度），不产生 NaN', () => {
    expect(computeMaterialOutlinePx(540, Number.NaN)).toBeCloseTo(computeOutlineBasePx(540), 6)
    expect(computeMaterialOutlinePx(540, 0)).toBeCloseTo(computeOutlineBasePx(540), 6)
    expect(computeMaterialOutlinePx(540, -1)).toBeCloseTo(computeOutlineBasePx(540), 6)
  })
})

describe('computeOutlineEdgeRatio：edgeSize 归一化', () => {
  it('1.03 → 1，0.618 → ≈0.6，0.4 → ≈0.388', () => {
    expect(computeOutlineEdgeRatio(OUTLINE_EDGE_REFERENCE)).toBe(1)
    expect(computeOutlineEdgeRatio(0.618)).toBeCloseTo(0.6, 3)
    expect(computeOutlineEdgeRatio(0.4)).toBeCloseTo(0.3883, 3)
  })

  it('非法/过小/过大输入被钳制到 [0.25, 1]', () => {
    expect(computeOutlineEdgeRatio(Number.NaN)).toBe(1)
    expect(computeOutlineEdgeRatio(0)).toBe(1)
    expect(computeOutlineEdgeRatio(-2)).toBe(1)
    expect(computeOutlineEdgeRatio(0.1)).toBe(0.25)
    expect(computeOutlineEdgeRatio(9.9)).toBe(1)
  })
})
