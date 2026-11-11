/**
 * 单测：悬停命中 → 点击穿透状态机（`src/renderer/src/interaction/pointer-gate.ts`，M-3）。
 *
 * 覆盖：命中矩形边界（半开区间）/ 状态去抖（仅在目标状态变化时下发）/
 * clickThrough=false 恒拦截 / 非主屏或宠物隐藏时穿透 / 指针离开窗口 / 命中矩形随布局热更。
 * 纯逻辑不依赖 Electron/DOM，可在 vitest node 环境直接跑。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import {
  computePointerHitRect,
  hitTestPetRect,
  PointerGate,
  type PointerGateConfig
} from '../src/renderer/src/interaction/pointer-gate'

/** 宠物命中矩形（窗口本地 CSS px，y 向下）：100×200，位于右下角。 */
const PET_RECT: Rect = { x: 1700, y: 600, width: 100, height: 200 }

/** 记录 setIgnoreMouse 调用的测试夹具。 */
function createHarness(
  initialConfig: Partial<PointerGateConfig> = {}
): { gate: PointerGate; applied: boolean[] } {
  const applied: boolean[] = []
  const gate: PointerGate = new PointerGate(
    (ignore: boolean): void => {
      applied.push(ignore)
    },
    { rect: PET_RECT, clickThrough: true, renderPet: true, ...initialConfig }
  )
  return { gate, applied }
}

describe('hitTestPetRect：命中边界', () => {
  it('矩形内部命中', () => {
    expect(hitTestPetRect(PET_RECT, 1750, 700)).toBe(true)
  })

  it('半开区间：左上边界算命中，右下边界算未命中（相邻矩形不重复命中）', () => {
    expect(hitTestPetRect(PET_RECT, PET_RECT.x, PET_RECT.y)).toBe(true)
    expect(hitTestPetRect(PET_RECT, PET_RECT.x + PET_RECT.width - 0.01, PET_RECT.y + PET_RECT.height - 0.01)).toBe(true)
    expect(hitTestPetRect(PET_RECT, PET_RECT.x + PET_RECT.width, PET_RECT.y)).toBe(false)
    expect(hitTestPetRect(PET_RECT, PET_RECT.x, PET_RECT.y + PET_RECT.height)).toBe(false)
  })

  it('矩形外 / 非法矩形 / 非法坐标不命中', () => {
    expect(hitTestPetRect(PET_RECT, 0, 0)).toBe(false)
    expect(hitTestPetRect(null, 1750, 700)).toBe(false)
    expect(hitTestPetRect({ x: 0, y: 0, width: 0, height: 0 }, 0, 0)).toBe(false)
    expect(hitTestPetRect({ x: 0, y: 0, width: Number.NaN, height: 10 }, 1, 1)).toBe(false)
    expect(hitTestPetRect(PET_RECT, Number.NaN, 700)).toBe(false)
    expect(hitTestPetRect(PET_RECT, 1750, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('PointerGate：默认穿透 + 悬停拦截 + 状态去抖', () => {
  it('首次 update 在指针不在窗口内时下发穿透（ignore=true）', () => {
    const { gate, applied } = createHarness()
    expect(gate.ignoreMouse).toBeNull()
    expect(gate.intercepting).toBe(false)
    gate.update({})
    expect(applied).toEqual([true])
    expect(gate.ignoreMouse).toBe(true)
    expect(gate.intercepting).toBe(false)
  })

  it('鼠标进入宠物 → 拦截；重复移动/重复 update 不重复下发（仅状态变化时调用）', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    expect(applied).toEqual([true])

    gate.pointerMove(1750, 700) // 命中
    expect(applied).toEqual([true, false])
    expect(gate.intercepting).toBe(true)

    gate.pointerMove(1760, 710) // 仍在矩形内：状态不变
    gate.update({ rect: { ...PET_RECT } }) // 布局重算但矩形没变：状态不变
    expect(applied).toEqual([true, false])
  })

  it('鼠标移出宠物矩形 → 恢复穿透', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    gate.pointerMove(1750, 700)
    gate.pointerMove(10, 10) // 矩形外
    expect(applied).toEqual([true, false, true])
    expect(gate.intercepting).toBe(false)
  })

  it('鼠标离开窗口 → 穿透（即使之前悬停拦截）', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    gate.pointerMove(1750, 700)
    gate.pointerLeave()
    expect(applied).toEqual([true, false, true])
  })

  it('指针在矩形内时布局热更（矩形移开）→ 立即恢复穿透', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    gate.pointerMove(1750, 700)
    gate.update({ rect: { x: 0, y: 0, width: 10, height: 10 } })
    expect(applied).toEqual([true, false, true])
  })

  it('宠物矩形无效（加载前 / 零尺寸）时不拦截', () => {
    const { gate, applied } = createHarness({ rect: null })
    gate.update({})
    gate.pointerMove(1750, 700)
    // 第一次 update 跟首次下发合并：只有一次 true
    expect(applied).toEqual([true])
    expect(gate.desiredIgnoreMouse()).toBe(true)
  })
})

describe('PointerGate：clickThrough=false 恒定拦截', () => {
  it('无论鼠标在哪/是否离开窗口都保持拦截，且只下发一次', () => {
    const { gate, applied } = createHarness({ clickThrough: false })
    gate.update({})
    gate.pointerMove(10, 10) // 矩形外也拦截
    gate.pointerMove(1750, 700)
    gate.pointerLeave()
    expect(applied).toEqual([false])
    expect(gate.intercepting).toBe(true)
  })

  it('配置热更 clickThrough=true 后恢复「仅悬停拦截」', () => {
    const { gate, applied } = createHarness({ clickThrough: false })
    gate.update({})
    gate.pointerMove(10, 10)
    gate.update({ clickThrough: true })
    // 指针当前在矩形外 → 穿透
    expect(applied).toEqual([false, true])
    gate.pointerMove(1750, 700)
    expect(applied).toEqual([false, true, false])
  })
})

describe('PointerGate：非主屏 / 宠物隐藏恒穿透', () => {
  it('renderPet=false 时即使鼠标在矩形内也穿透，且优先于 clickThrough=false', () => {
    const { gate, applied } = createHarness({ renderPet: false, clickThrough: false })
    gate.update({})
    gate.pointerMove(1750, 700)
    expect(applied).toEqual([true])
    expect(gate.desiredIgnoreMouse()).toBe(true)
  })

  it('渲染开关翻转（主屏拓扑变化）时状态随之切换', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    gate.pointerMove(1750, 700)
    gate.update({ renderPet: false }) // 变成非主屏
    expect(applied).toEqual([true, false, true])
    gate.update({ renderPet: true }) // 再变回主屏（指针仍在矩形内）
    expect(applied).toEqual([true, false, true, false])
  })
})

describe('computePointerHitRect：躯干中心带（手工验收修复）', () => {
  it('宽包围盒（T-pose 398×540 @50%）收缩为高×0.5 的居中带，两侧透明边可穿透', () => {
    const bbox: Rect = { x: 1502.9, y: 421, width: 398.1, height: 540 }
    const hit = computePointerHitRect(bbox)
    expect(hit).not.toBeNull()
    expect(hit!.height).toBe(540)
    expect(hit!.width).toBeCloseTo(270, 5)
    // 水平居中：中心不变
    expect(hit!.x + hit!.width / 2).toBeCloseTo(bbox.x + bbox.width / 2, 5)
    // 躯干中心命中；模型包围盒右侧边缘（桌面图标区）不再命中
    expect(hitTestPetRect(hit, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2)).toBe(true)
    expect(hitTestPetRect(hit, 1870, 685)).toBe(false)
  })
  it('窄包围盒（自然姿态）不放大：宽度取 min(包围盒宽, 高×0.5)', () => {
    const narrow: Rect = { x: 1700, y: 500, width: 120, height: 540 }
    const hit = computePointerHitRect(narrow)
    expect(hit!.width).toBe(120)
    expect(hit!.x).toBe(1700)
  })
  it('非法/空矩形返回 null（不拦截）', () => {
    expect(computePointerHitRect(null)).toBeNull()
    expect(computePointerHitRect({ x: 0, y: 0, width: 0, height: 100 })).toBeNull()
    expect(computePointerHitRect({ x: 0, y: 0, width: 100, height: -1 })).toBeNull()
  })
})
