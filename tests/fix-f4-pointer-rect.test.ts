/**
 * 单测：视觉命中矩形换算（F4 / NEW-1 修复 + L2/M-3 hips 横移补偿）。
 *
 * 生产链路：
 * 1. 动画层 `visualOffsetYPx` 是 three 世界 Y 增量（正=视觉向上、负=视觉向下），
 *    屏幕 y 向下 → 命中/气泡矩形 = petRect.y − offset。旧实现写成 +，方向相反。
 * 2. L2（M-3）：foot-lock 的 A（锚点-作者脚位对齐）会平移 normalized hips（≤0.18m ≈56px），
 *    身体视觉横移但 `petRect` 是物理口径 → 命中/气泡必须加 `hipShiftXPx` 横向补偿。
 *    换算：`ppm·(cos(yaw)·shiftX + sin(yaw)·shiftZ)`（`avatar.scene` 局部米 → modelRoot yaw
 *    → 屏幕 CSS px；第三参默认 0 → 旧调用逐位兼容）。
 */
import { describe, expect, it } from 'vitest'

import {
  HIP_SHIFT_EPSILON_PX,
  HIP_SHIFT_MAX_PX,
  hipShiftToScreenXPx,
  offsetPetRectForVisual,
  resolveHipShiftPx,
  resolveVisualOffsetPx,
  VISUAL_OFFSET_EPSILON_PX
} from '../src/renderer/src/interaction/pointer-rect'

const RECT = { x: 1000, y: 200, width: 300, height: 540 }

describe('resolveVisualOffsetPx：非法/噪声偏移归零', () => {
  it('有限数值原样返回（正=视觉向上、负=视觉向下）', () => {
    expect(resolveVisualOffsetPx(-327)).toBe(-327)
    expect(resolveVisualOffsetPx(214)).toBe(214)
  })

  it('NaN/Infinity/null/undefined → 0', () => {
    expect(resolveVisualOffsetPx(Number.NaN)).toBe(0)
    expect(resolveVisualOffsetPx(Number.POSITIVE_INFINITY)).toBe(0)
    expect(resolveVisualOffsetPx(null)).toBe(0)
    expect(resolveVisualOffsetPx(undefined)).toBe(0)
  })

  it(`绝对值 ≤ ${VISUAL_OFFSET_EPSILON_PX}px 的贴地补偿噪声视为 0（不产生独立命中矩形）`, () => {
    expect(resolveVisualOffsetPx(0)).toBe(0)
    expect(resolveVisualOffsetPx(0.4)).toBe(0)
    expect(resolveVisualOffsetPx(-0.4)).toBe(0)
    expect(resolveVisualOffsetPx(0.5)).toBe(0)
    expect(resolveVisualOffsetPx(0.6)).toBe(0.6)
  })
})

describe('resolveHipShiftPx：hips 横移补偿归一化（L2 / M-3）', () => {
  it('有限数值原样返回（屏幕横向 px，向右为正；典型 0.18m@311.42px/m ≈56px）', () => {
    expect(resolveHipShiftPx(56)).toBe(56)
    expect(resolveHipShiftPx(-56)).toBe(-56)
    expect(resolveHipShiftPx(20.25)).toBe(20.25)
  })

  it('NaN/Infinity/null/undefined → 0（坏快照不得甩飞命中区）', () => {
    expect(resolveHipShiftPx(Number.NaN)).toBe(0)
    expect(resolveHipShiftPx(Number.POSITIVE_INFINITY)).toBe(0)
    expect(resolveHipShiftPx(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(resolveHipShiftPx(null)).toBe(0)
    expect(resolveHipShiftPx(undefined)).toBe(0)
  })

  it(`绝对值 ≤ ${HIP_SHIFT_EPSILON_PX}px 视为噪声 → 0；超过才生效`, () => {
    expect(resolveHipShiftPx(0)).toBe(0)
    expect(resolveHipShiftPx(0.4)).toBe(0)
    expect(resolveHipShiftPx(-0.4)).toBe(0)
    expect(resolveHipShiftPx(0.5)).toBe(0)
    expect(resolveHipShiftPx(0.6)).toBe(0.6)
  })

  it(`钳制到 ±${HIP_SHIFT_MAX_PX}px（超出对齐预算也不甩飞）`, () => {
    expect(resolveHipShiftPx(HIP_SHIFT_MAX_PX)).toBe(HIP_SHIFT_MAX_PX)
    expect(resolveHipShiftPx(HIP_SHIFT_MAX_PX + 0.4)).toBe(HIP_SHIFT_MAX_PX)
    expect(resolveHipShiftPx(120)).toBe(HIP_SHIFT_MAX_PX)
    expect(resolveHipShiftPx(-120)).toBe(-HIP_SHIFT_MAX_PX)
  })
})

describe('hipShiftToScreenXPx：scene 局部米 → 屏幕横向 px（modelRoot yaw 换算）', () => {
  const PPM = 311.42
  const shiftX = 0.18
  const shiftZ = -0.12

  it('yaw=0（front）→ ppm·shiftX（局部 z 不贡献屏幕 x）', () => {
    const px = hipShiftToScreenXPx({ shiftXM: shiftX, shiftZM: shiftZ, yawRad: 0, pixelsPerMeter: PPM })
    expect(px).toBeCloseTo(PPM * shiftX, 6)
    expect(px).toBeCloseTo(56.0556, 3)
  })

  it('yaw=π/2（右侧身 walk）→ ppm·shiftZ（局部 x 转成深度、不再贡献屏幕 x）', () => {
    const px = hipShiftToScreenXPx({
      shiftXM: shiftX,
      shiftZM: shiftZ,
      yawRad: Math.PI / 2,
      pixelsPerMeter: PPM
    })
    expect(px).toBeCloseTo(PPM * shiftZ, 6)
  })

  it('yaw=π（yawOffset=180 的资产）→ −ppm·shiftX', () => {
    const px = hipShiftToScreenXPx({
      shiftXM: shiftX,
      shiftZM: shiftZ,
      yawRad: Math.PI,
      pixelsPerMeter: PPM
    })
    expect(px).toBeCloseTo(-PPM * shiftX, 6)
  })

  it('yaw=−π/2（左侧身 walk）→ −ppm·shiftZ', () => {
    const px = hipShiftToScreenXPx({
      shiftXM: shiftX,
      shiftZM: shiftZ,
      yawRad: -Math.PI / 2,
      pixelsPerMeter: PPM
    })
    expect(px).toBeCloseTo(-PPM * shiftZ, 6)
  })

  it('yaw 只作用于水平分量（0.18m×sin(yaw) 级几何，非缩放）', () => {
    const front = hipShiftToScreenXPx({ shiftXM: 0.1, shiftZM: 0, yawRad: 0, pixelsPerMeter: PPM })
    const side = hipShiftToScreenXPx({ shiftXM: 0.1, shiftZM: 0, yawRad: Math.PI / 2, pixelsPerMeter: PPM })
    expect(front).toBeCloseTo(PPM * 0.1, 6)
    expect(Math.abs(side)).toBeLessThan(1e-9)
  })

  it('非法输入（NaN/Inf/ppm≤0）→ 0', () => {
    expect(
      hipShiftToScreenXPx({ shiftXM: Number.NaN, shiftZM: 0, yawRad: 0, pixelsPerMeter: PPM })
    ).toBe(0)
    expect(
      hipShiftToScreenXPx({ shiftXM: 0, shiftZM: Number.POSITIVE_INFINITY, yawRad: 0, pixelsPerMeter: PPM })
    ).toBe(0)
    expect(
      hipShiftToScreenXPx({ shiftXM: 0.1, shiftZM: 0, yawRad: Number.NaN, pixelsPerMeter: PPM })
    ).toBe(0)
    expect(hipShiftToScreenXPx({ shiftXM: 0.1, shiftZM: 0, yawRad: 0, pixelsPerMeter: 0 })).toBe(0)
    expect(hipShiftToScreenXPx({ shiftXM: 0.1, shiftZM: 0, yawRad: 0, pixelsPerMeter: -1 })).toBe(0)
    expect(
      hipShiftToScreenXPx({ shiftXM: 0.1, shiftZM: 0, yawRad: 0, pixelsPerMeter: Number.NaN })
    ).toBe(0)
  })
})

describe('offsetPetRectForVisual：世界 Y 增量 → 屏幕命中矩形', () => {
  it('offset=-327（视觉下移 327px）→ 命中矩形同步下移 327px', () => {
    const out = offsetPetRectForVisual(RECT, -327)
    expect(out.y).toBe(RECT.y + 327) // 200 → 527
    expect(out).toEqual({ ...RECT, y: 527 })
  })

  it('offset=+327（视觉上移）→ 命中矩形同步上移', () => {
    expect(offsetPetRectForVisual(RECT, 327).y).toBe(RECT.y - 327)
  })

  it('x/width/height 不变，仅 y 跟随视觉偏移', () => {
    const out = offsetPetRectForVisual(RECT, -214)
    expect(out.x).toBe(RECT.x)
    expect(out.width).toBe(RECT.width)
    expect(out.height).toBe(RECT.height)
    expect(out.y).toBe(RECT.y + 214)
  })

  it('0/非法 offset → 原坐标（返回副本，不修改入参）', () => {
    for (const bad of [0, Number.NaN, null, undefined, 0.2]) {
      const out = offsetPetRectForVisual(RECT, bad as number | null | undefined)
      expect(out).toEqual(RECT)
    }
    expect(RECT.y).toBe(200) // 入参未被修改
    const copy = offsetPetRectForVisual(RECT, 0)
    expect(copy).not.toBe(RECT)
  })
})

describe('offsetPetRectForVisual：hips 横移补偿（第三参；默认 0 向后兼容）', () => {
  it('第三参默认/显式 0 时与旧行为逐位相同（回归）', () => {
    for (const offset of [0, -327, 214, Number.NaN]) {
      const legacy = { ...RECT, y: RECT.y - resolveVisualOffsetPx(offset) }
      expect(offsetPetRectForVisual(RECT, offset)).toEqual(legacy)
      expect(offsetPetRectForVisual(RECT, offset, 0)).toEqual(legacy)
    }
    expect(offsetPetRectForVisual(RECT, -327)).toEqual({ ...RECT, y: 527 })
  })

  it('shift=+56 → x+56，y/width/height 不变', () => {
    const out = offsetPetRectForVisual(RECT, 0, 56)
    expect(out.x).toBe(RECT.x + 56)
    expect(out.y).toBe(RECT.y)
    expect(out.width).toBe(RECT.width)
    expect(out.height).toBe(RECT.height)
    expect(RECT.x).toBe(1000) // 入参未被修改
  })

  it('负向 shift（对侧身体横移）→ x 减少', () => {
    expect(offsetPetRectForVisual(RECT, 0, -56).x).toBe(RECT.x - 56)
  })

  it('坐姿 visualOffsetY 与 hipShift 同时生效（正交叠加）', () => {
    const out = offsetPetRectForVisual(RECT, -8.31, 20)
    expect(out.x).toBe(RECT.x + 20)
    expect(out.y).toBeCloseTo(RECT.y + 8.31, 6)
    expect(out.width).toBe(RECT.width)
    expect(out.height).toBe(RECT.height)
  })

  it('噪声/非法/超界 shift → 按 resolveHipShiftPx 归一化（ε→0、钳制 ±96）', () => {
    expect(offsetPetRectForVisual(RECT, 0, 0.4).x).toBe(RECT.x)
    expect(offsetPetRectForVisual(RECT, 0, Number.NaN).x).toBe(RECT.x)
    expect(offsetPetRectForVisual(RECT, 0, 120).x).toBe(RECT.x + HIP_SHIFT_MAX_PX)
    expect(offsetPetRectForVisual(RECT, 0, -120).x).toBe(RECT.x - HIP_SHIFT_MAX_PX)
  })
})
