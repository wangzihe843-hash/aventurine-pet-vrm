/**
 * 单测：`pointer-gate.ts` 的 B4 扩展 `forceIntercept`（拖动中/右键菜单打开时强制拦截）。
 *
 * 既有语义与既有测试（`tests/pointer-gate.test.ts`）保持不变；本文件只覆盖新增字段与优先级：
 * `renderPet=false`（永远穿透）> `forceIntercept`（强制拦截）> `clickThrough=false` > 悬停命中。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import {
  PointerGate,
  type PointerGateConfig
} from '../src/renderer/src/interaction/pointer-gate'

/** 宠物命中矩形：100×200，位于右下角。 */
const PET_RECT: Rect = { x: 1700, y: 600, width: 100, height: 200 }

/** 记录 setIgnoreMouse 调用的测试夹具。 */
function createHarness(initialConfig: Partial<PointerGateConfig> = {}): {
  gate: PointerGate
  applied: boolean[]
} {
  const applied: boolean[] = []
  const gate = new PointerGate(
    (ignore: boolean) => {
      applied.push(ignore)
    },
    { rect: PET_RECT, clickThrough: true, renderPet: true, ...initialConfig }
  )
  return { gate, applied }
}

describe('PointerGate.forceIntercept：B4 拖动/菜单强制拦截', () => {
  it('默认 forceIntercept=false，保持既有「仅悬停拦截」语义', () => {
    const { gate, applied } = createHarness()
    expect(gate.currentConfig.forceIntercept).toBe(false)
    gate.update({})
    expect(applied).toEqual([true])
    gate.pointerMove(1750, 700)
    expect(applied).toEqual([true, false])
    gate.pointerMove(10, 10)
    expect(applied).toEqual([true, false, true])
  })

  it('forceIntercept=true：指针在宠物外也保持拦截（拖动甩到空地/菜单展开到宠物外）', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    expect(applied).toEqual([true]) // 初始穿透
    gate.update({ forceIntercept: true })
    expect(applied).toEqual([true, false]) // 指针不在窗口内也强制拦截

    gate.pointerMove(10, 10) // 远离宠物
    gate.pointerMove(0, 0)
    expect(applied).toEqual([true, false]) // 状态不变，不重复下发
    expect(gate.intercepting).toBe(true)

    gate.pointerLeave() // 离开窗口仍保持拦截（等待 mouseup）
    expect(applied).toEqual([true, false])
    expect(gate.intercepting).toBe(true)
  })

  it('拖动/菜单结束（forceIntercept=false）→ 立即恢复「仅悬停拦截」', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    gate.pointerMove(1750, 700) // 悬停命中 → 拦截
    gate.update({ forceIntercept: true })
    expect(applied).toEqual([true, false]) // 状态未变，不重复下发
    gate.pointerMove(10, 10) // 拖动中移出宠物，保持拦截
    expect(applied).toEqual([true, false])
    gate.update({ forceIntercept: false }) // 松手
    expect(applied).toEqual([true, false, true]) // 指针在宠物外 → 恢复穿透
    expect(gate.intercepting).toBe(false)
  })

  it('菜单打开时指针在宠物外：forceIntercept 让窗口接管点击（供「点击外部关闭」）', () => {
    const { gate, applied } = createHarness()
    gate.update({})
    gate.pointerMove(10, 10) // 宠物外 → 穿透
    gate.update({ forceIntercept: true })
    expect(applied).toEqual([true, false])
    gate.pointerMove(20, 20)
    expect(applied).toEqual([true, false])
  })

  it('优先级：renderPet=false 永远穿透（即使 forceIntercept=true）', () => {
    const { gate, applied } = createHarness({ renderPet: false, forceIntercept: true })
    gate.update({})
    gate.pointerMove(1750, 700)
    expect(applied).toEqual([true])
    expect(gate.desiredIgnoreMouse()).toBe(true)
  })

  it('优先级：forceIntercept 与 clickThrough=false 同时为拦截，且热更互不影响', () => {
    const { gate, applied } = createHarness({ clickThrough: false })
    gate.update({})
    gate.pointerMove(10, 10)
    expect(applied).toEqual([false])
    gate.update({ forceIntercept: true })
    gate.pointerMove(10, 10)
    expect(applied).toEqual([false]) // 已是拦截状态，不重复下发
    gate.update({ forceIntercept: false, clickThrough: true })
    expect(applied).toEqual([false, true]) // 指针在宠物外 → 穿透
  })

  it('currentConfig 暴露完整字段（含 forceIntercept），update 局部热更', () => {
    const { gate } = createHarness()
    const config = gate.currentConfig
    expect(config).toMatchObject({ rect: PET_RECT, clickThrough: true, renderPet: true })
    gate.update({ forceIntercept: true })
    expect(gate.currentConfig.forceIntercept).toBe(true)
    expect(gate.currentConfig.rect).toEqual(PET_RECT)
  })
})
