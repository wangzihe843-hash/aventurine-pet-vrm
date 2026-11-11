/**
 * 单测：canvas 像素比预算（`src/renderer/src/scene/pixel-ratio.ts`，F08 回归）。
 *
 * 目标口径：
 * - 1080p@1x 仍是 2x 超采样（画质补丁 95fd70e 的实机效果不回退）；
 * - 1440p@1x ≤1.5x、4K@1x =1x（backing store 不超 4K 像素预算）；
 * - Retina（DPR≥1.5）按原生 dpr，不额外超采样，上限 2；
 * - 非法输入不产生 NaN/0/超大 buffer。
 */
import { describe, expect, it } from 'vitest'

import {
  computePixelRatio,
  PIXEL_BUDGET_PX,
  PIXEL_RATIO_MAX,
  PIXEL_RATIO_MIN
} from '../src/renderer/src/scene/pixel-ratio'

/** 常用屏幕 CSS 尺寸。 */
const SCREENS = {
  hd: { width: 1280, height: 720 },
  fhd: { width: 1920, height: 1080 },
  qhd: { width: 2560, height: 1440 },
  uhd4k: { width: 3840, height: 2160 },
  uhd5k: { width: 5120, height: 2880 }
} as const

describe('computePixelRatio：1x 屏像素预算', () => {
  it('1080p@1x → 2x 超采样（保持画质补丁的实机效果）', () => {
    expect(computePixelRatio(1, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
  })

  it('1440p@1x → 1.5x；4K@1x → 1x', () => {
    expect(computePixelRatio(1, SCREENS.qhd.width, SCREENS.qhd.height)).toBeCloseTo(1.5, 2)
    expect(computePixelRatio(1, SCREENS.uhd4k.width, SCREENS.uhd4k.height)).toBe(1)
  })

  it('更大的 1x 屏（5K）→ 下限 1x（不再超采样）', () => {
    expect(computePixelRatio(1, SCREENS.uhd5k.width, SCREENS.uhd5k.height)).toBe(PIXEL_RATIO_MIN)
  })

  it('小屏仍超采样但不超过 2x', () => {
    expect(computePixelRatio(1, SCREENS.hd.width, SCREENS.hd.height)).toBe(PIXEL_RATIO_MAX)
  })

  it('1x 屏的 backing store 不突破 4K 预算（CSS 本身超预算时降到下限 1x）', () => {
    for (const screen of Object.values(SCREENS)) {
      const ratio = computePixelRatio(1, screen.width, screen.height)
      const cssPixels = screen.width * screen.height
      const backingPixels = (screen.width * ratio) * (screen.height * ratio)
      if (cssPixels <= PIXEL_BUDGET_PX) {
        expect(backingPixels).toBeLessThanOrEqual(PIXEL_BUDGET_PX + 1)
      } else {
        // 5K 等 1x 巨屏：已到下限，不能反向降采样
        expect(ratio).toBe(PIXEL_RATIO_MIN)
      }
      expect(ratio).toBeGreaterThanOrEqual(PIXEL_RATIO_MIN)
      expect(ratio).toBeLessThanOrEqual(PIXEL_RATIO_MAX)
    }
  })
})

describe('computePixelRatio：Retina / 缩放屏', () => {
  it('DPR=2 按原生 2x 渲染（不额外超采样），1080p/1440p 结果都是 2', () => {
    expect(computePixelRatio(2, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
    expect(computePixelRatio(2, SCREENS.qhd.width, SCREENS.qhd.height)).toBe(2)
  })

  it('DPR=3 上限 2（不跟随 3x 造 9 倍 buffer）', () => {
    expect(computePixelRatio(3, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
  })

  it('DPR=1.5（缩放屏）按 1.5x 原生渲染', () => {
    expect(computePixelRatio(1.5, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(1.5)
  })
})

describe('computePixelRatio：非法输入兜底', () => {
  it('DPR 非法（NaN/0/负数）按 1 处理', () => {
    expect(computePixelRatio(Number.NaN, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
    expect(computePixelRatio(0, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
    expect(computePixelRatio(-1, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
  })

  it('视口尺寸非法时退回不超采样、且结果有限', () => {
    for (const [width, height] of [
      [0, 0],
      [Number.NaN, 1080],
      [-100, 100],
      [Number.POSITIVE_INFINITY, 1080]
    ] as const) {
      const ratio = computePixelRatio(1, width, height)
      expect(Number.isFinite(ratio)).toBe(true)
      expect(ratio).toBeGreaterThanOrEqual(PIXEL_RATIO_MIN)
      expect(ratio).toBeLessThanOrEqual(PIXEL_RATIO_MAX)
    }
    expect(computePixelRatio(1, 0, 0)).toBe(1)
  })

  it('DPR<1（极端缩小显示）不反向降采样到 1x 以下', () => {
    expect(computePixelRatio(0.5, SCREENS.fhd.width, SCREENS.fhd.height)).toBe(2)
  })
})
