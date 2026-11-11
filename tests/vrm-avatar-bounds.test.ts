/**
 * V1 单测：VRM 躯干宽高比估算（`src/renderer/src/vrm/avatar-bounds.ts`）。
 *
 * 口径来源 `docs/wave2-vrm-runtime-design.md` §4.1：
 *   width ≈ max(|L upperArm.x − R upperArm.x|, 2×|hips.x − L upperLeg.x|×1.6) + 0.08×height
 *   aspect = clamp(width / height, 0.30, 0.90)
 *
 * 重点覆盖边界：缺失骨、单项骨异常、异常 bbox（高度 0/NaN/Infinity/负数）、clamp 上下限。
 * 纯函数模块不 import three/DOM，因此 vitest node 环境可直接跑。
 */
import { describe, expect, it } from 'vitest'

import {
  clampBodyAspectRatio,
  estimateBodyAspectRatio,
  FALLBACK_BODY_ASPECT_RATIO,
  HIPS_WIDTH_FACTOR,
  MAX_BODY_ASPECT_RATIO,
  MIN_BODY_ASPECT_RATIO,
  SHOULDER_SOFT_MARGIN_RATIO
} from '../src/renderer/src/vrm/avatar-bounds'

/** 典型 1.7m 成人 normalized rest 骨坐标（米；左手 +X，右手 −X）。 */
const TYPICAL = {
  heightMeters: 1.7,
  leftUpperArmX: 0.19,
  rightUpperArmX: -0.19,
  hipsX: 0,
  leftUpperLegX: 0.09
}

describe('clampBodyAspectRatio', () => {
  it('区间内原样返回', () => {
    expect(clampBodyAspectRatio(0.355)).toBeCloseTo(0.355, 6)
  })

  it('低于下限钳到 0.30，高于上限钳到 0.90', () => {
    expect(clampBodyAspectRatio(0.05)).toBe(MIN_BODY_ASPECT_RATIO)
    expect(clampBodyAspectRatio(2.5)).toBe(MAX_BODY_ASPECT_RATIO)
  })

  it('非有限数退回兜底值', () => {
    expect(clampBodyAspectRatio(Number.NaN)).toBe(FALLBACK_BODY_ASPECT_RATIO)
    expect(clampBodyAspectRatio(Number.POSITIVE_INFINITY)).toBe(FALLBACK_BODY_ASPECT_RATIO)
    expect(clampBodyAspectRatio(Number.NEGATIVE_INFINITY)).toBe(FALLBACK_BODY_ASPECT_RATIO)
  })
})

describe('estimateBodyAspectRatio', () => {
  it('肩/髋骨齐全：按 max(肩宽, 髋宽×2×1.6)+0.08h 估算', () => {
    const result = estimateBodyAspectRatio(TYPICAL)
    const shoulderSpan = 0.38
    const hipsSpan = 2 * 0.09 * HIPS_WIDTH_FACTOR
    const expectedWidth = Math.max(shoulderSpan, hipsSpan) + TYPICAL.heightMeters * SHOULDER_SOFT_MARGIN_RATIO
    expect(result.source).toBe('shoulders+hips')
    expect(result.clamped).toBe(false)
    expect(result.torsoWidthMeters).toBeCloseTo(expectedWidth, 6)
    expect(result.ratio).toBeCloseTo(expectedWidth / TYPICAL.heightMeters, 6)
    // 估算值落在坐/站姿势的合理躯干宽高比区间。
    expect(result.ratio).toBeGreaterThan(0.25)
    expect(result.ratio).toBeLessThan(0.45)
  })

  it('髋宽主导时（肩骨缺失）用髋/腿骨估算', () => {
    const result = estimateBodyAspectRatio({
      heightMeters: 1.7,
      hipsX: 0,
      leftUpperLegX: 0.09
    })
    const expectedWidth = 0.18 * HIPS_WIDTH_FACTOR + 1.7 * SHOULDER_SOFT_MARGIN_RATIO
    expect(result.source).toBe('hips')
    expect(result.torsoWidthMeters).toBeCloseTo(expectedWidth, 6)
    // 0.288 + 0.136 = 0.424 / 1.7 ≈ 0.2494 → 低于下限，被 clamp 到 0.30。
    expect(result.clamped).toBe(true)
    expect(result.ratio).toBe(MIN_BODY_ASPECT_RATIO)
  })

  it('肩宽主导时（髋骨缺失）用肩骨估算', () => {
    const result = estimateBodyAspectRatio({
      heightMeters: 1.7,
      leftUpperArmX: 0.19,
      rightUpperArmX: -0.19
    })
    expect(result.source).toBe('shoulders')
    expect(result.ratio).toBeCloseTo((0.38 + 0.136) / 1.7, 6)
  })

  it('全部骨缺失 → 兜底值、source=fallback、无 torsoWidth', () => {
    const result = estimateBodyAspectRatio({ heightMeters: 1.7 })
    expect(result.source).toBe('fallback')
    expect(result.ratio).toBe(FALLBACK_BODY_ASPECT_RATIO)
    expect(result.clamped).toBe(false)
    expect(result.torsoWidthMeters).toBeNull()
  })

  it('骨坐标含 NaN/Infinity 视同缺失', () => {
    const result = estimateBodyAspectRatio({
      heightMeters: 1.7,
      leftUpperArmX: Number.NaN,
      rightUpperArmX: -0.19,
      hipsX: 0,
      leftUpperLegX: Number.POSITIVE_INFINITY
    })
    expect(result.source).toBe('fallback')
    expect(result.ratio).toBe(FALLBACK_BODY_ASPECT_RATIO)
  })

  it('左右肩同名点（间距 0）不算有效数据 → fallback', () => {
    const result = estimateBodyAspectRatio({
      heightMeters: 1.7,
      leftUpperArmX: 0.2,
      rightUpperArmX: 0.2
    })
    expect(result.source).toBe('fallback')
  })

  it('异常 bbox：height 为 0/负数/NaN/Infinity → fallback', () => {
    for (const heightMeters of [0, -1.7, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = estimateBodyAspectRatio({ ...TYPICAL, heightMeters })
      expect(result.source, `height=${String(heightMeters)}`).toBe('fallback')
      expect(result.ratio, `height=${String(heightMeters)}`).toBe(FALLBACK_BODY_ASPECT_RATIO)
    }
  })

  it('异常 bbox：身高极小导致肩宽数据越界（> 1×身高）时忽略该来源', () => {
    // 0.2m 的 bbox 配 0.38m 肩宽 = 1.9×身高，明显异常；只剩髋宽（0.288m > 0.2m，也异常）→ fallback。
    const result = estimateBodyAspectRatio({ ...TYPICAL, heightMeters: 0.2 })
    expect(result.source).toBe('fallback')
  })

  it('单项骨跨度 > 1×身高时忽略该项，使用另一项', () => {
    const result = estimateBodyAspectRatio({
      heightMeters: 1.7,
      // 肩宽异常（0.38×10 = 3.8 > 1.7）→ 忽略肩，只剩髋宽 0.288 < 1.7。
      leftUpperArmX: 1.9,
      rightUpperArmX: -1.9,
      hipsX: 0,
      leftUpperLegX: 0.09
    })
    expect(result.source).toBe('hips')
    expect(result.torsoWidthMeters).toBeCloseTo(0.288 + 0.136, 6)
  })

  it('原始比值超过上限时 clamp 到 0.90 且 clamped=true', () => {
    // 0.3m 身高 + 0.25m 肩宽（< 1×身高，合法）→ 0.25+0.024=0.274 / 0.3 ≈ 0.913 → clamp 0.90。
    const result = estimateBodyAspectRatio({
      heightMeters: 0.3,
      leftUpperArmX: 0.125,
      rightUpperArmX: -0.125
    })
    expect(result.clamped).toBe(true)
    expect(result.ratio).toBe(MAX_BODY_ASPECT_RATIO)
    expect(result.torsoWidthMeters).toBeCloseTo(0.274, 6)
  })

  it('坐标符号相反但间距相同 → 结果一致（VRM0 rotateVRM0 绕 Y 翻转不影响）', () => {
    const normal = estimateBodyAspectRatio(TYPICAL)
    const flipped = estimateBodyAspectRatio({
      ...TYPICAL,
      leftUpperArmX: -0.19,
      rightUpperArmX: 0.19,
      hipsX: -0,
      leftUpperLegX: -0.09
    })
    expect(flipped.ratio).toBeCloseTo(normal.ratio, 6)
    expect(flipped.source).toBe(normal.source)
  })
})
