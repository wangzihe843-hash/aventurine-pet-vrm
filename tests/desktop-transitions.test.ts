/**
 * 单测：B5 桌面感知 —— 窗口变化事件（`desktop/transitions.ts`）。
 *
 * 覆盖：
 * - `diffWindowLists`：appeared / closed / moved{delta}、resize（delta {0,0}）、顺序确定性；
 * - `coalesceTransitions`：同窗口同类事件只报一次、一次帧内 moved delta 相加、
 *   `appeared+closed` 净效果取消、`moved+closed` → closed、`closed+appeared` → appeared。
 */
import { describe, expect, it } from 'vitest'

import type { WindowInfo } from '../src/shared/types'
import {
  coalesceTransitions,
  diffWindowLists,
  sameBounds
} from '../src/renderer/src/desktop/transitions'

/** 构造窗口测试数据。 */
function makeWindow(id: number, bounds: Partial<WindowInfo['bounds']> = {}): WindowInfo {
  return {
    id,
    pid: 100,
    owner: `window-${id}`,
    layer: 0,
    alpha: 1,
    bounds: { x: 100, y: 130, width: 800, height: 600, ...bounds },
    onScreen: true
  }
}

describe('sameBounds', () => {
  it('位置 + 尺寸完全一致为 true，任一字段不同为 false', () => {
    const a = { x: 10, y: 20, width: 300, height: 400 }
    expect(sameBounds(a, { ...a })).toBe(true)
    expect(sameBounds(a, { ...a, x: 11 })).toBe(false)
    expect(sameBounds(a, { ...a, y: 21 })).toBe(false)
    expect(sameBounds(a, { ...a, width: 301 })).toBe(false)
    expect(sameBounds(a, { ...a, height: 401 })).toBe(false)
  })
})

describe('diffWindowLists', () => {
  it('新窗口 → appeared；相同列表 → 无事件', () => {
    const window = makeWindow(1)
    expect(diffWindowLists([], [window])).toEqual([{ kind: 'appeared', windowId: 1 }])
    expect(diffWindowLists([window], [window])).toEqual([])
  })

  it('消失窗口 → closed', () => {
    const a = makeWindow(1)
    const b = makeWindow(2, { x: 500 })
    expect(diffWindowLists([a, b], [a])).toEqual([{ kind: 'closed', windowId: 2 }])
  })

  it('位置变化 → moved，delta 为全局坐标差（可为负）', () => {
    const before = makeWindow(1)
    const after = makeWindow(1, { x: 160, y: 90 })
    expect(diffWindowLists([before], [after])).toEqual([
      { kind: 'moved', windowId: 1, delta: { x: 60, y: -40 } }
    ])
  })

  it('仅尺寸变化 → moved delta {0,0}（B1 需重新评估落点）', () => {
    const before = makeWindow(1)
    const after = makeWindow(1, { width: 1000 })
    expect(diffWindowLists([before], [after])).toEqual([
      { kind: 'moved', windowId: 1, delta: { x: 0, y: 0 } }
    ])
  })

  it('emitOnResize=false 时纯 resize 不产生事件', () => {
    const before = makeWindow(1)
    const after = makeWindow(1, { width: 1000 })
    expect(diffWindowLists([before], [after], { emitOnResize: false })).toEqual([])
    // 位置 + 尺寸都变时仍报 moved（delta 只含位置差）
    const both = makeWindow(1, { x: 200, width: 1000 })
    expect(diffWindowLists([before], [both], { emitOnResize: false })).toEqual([
      { kind: 'moved', windowId: 1, delta: { x: 100, y: 0 } }
    ])
  })

  it('顺序确定性：appeared（next 顺序）→ moved（next 顺序）→ closed（previous 顺序）', () => {
    const a = makeWindow(1)
    const b = makeWindow(2, { x: 400 })
    const c = makeWindow(3, { x: 900 })
    const bMoved = makeWindow(2, { x: 450 })
    const events = diffWindowLists([a, b], [bMoved, c])
    expect(events).toEqual([
      { kind: 'moved', windowId: 2, delta: { x: 50, y: 0 } },
      { kind: 'appeared', windowId: 3 },
      { kind: 'closed', windowId: 1 }
    ])
  })

  it('重复 id 只取第一项（防御 fake 输入）', () => {
    const window = makeWindow(1)
    expect(diffWindowLists([], [window, window])).toEqual([
      { kind: 'appeared', windowId: 1 }
    ])
  })

  it('空输入不抛', () => {
    expect(diffWindowLists([], [])).toEqual([])
    expect(diffWindowLists(undefined as unknown as WindowInfo[], [])).toEqual([])
    expect(diffWindowLists([], undefined as unknown as WindowInfo[])).toEqual([])
  })
})

describe('coalesceTransitions（同帧去重 / delta 合并）', () => {
  it('空输入 → []', () => {
    expect(coalesceTransitions([])).toEqual([])
    expect(coalesceTransitions(undefined as unknown as [])).toEqual([])
  })

  it('同一窗口两次 moved → 单个 moved，delta 相加', () => {
    const merged = coalesceTransitions([
      { kind: 'moved', windowId: 7, delta: { x: 10, y: 2 } },
      { kind: 'moved', windowId: 7, delta: { x: -3, y: 5 } }
    ])
    expect(merged).toEqual([{ kind: 'moved', windowId: 7, delta: { x: 7, y: 7 } }])
  })

  it('appeared + moved → 只报 appeared（出现位置即最终位置）', () => {
    expect(
      coalesceTransitions([
        { kind: 'appeared', windowId: 7 },
        { kind: 'moved', windowId: 7, delta: { x: 40, y: 0 } }
      ])
    ).toEqual([{ kind: 'appeared', windowId: 7 }])
  })

  it('appeared + closed → 净效果取消（窗口未被消费方看到）', () => {
    expect(
      coalesceTransitions([
        { kind: 'appeared', windowId: 7 },
        { kind: 'closed', windowId: 7 }
      ])
    ).toEqual([])
  })

  it('moved + closed → 只报 closed', () => {
    expect(
      coalesceTransitions([
        { kind: 'moved', windowId: 7, delta: { x: 10, y: 0 } },
        { kind: 'closed', windowId: 7 }
      ])
    ).toEqual([{ kind: 'closed', windowId: 7 }])
  })

  it('closed + appeared → 视为 appeared（id 复用 / 同帧重开）', () => {
    expect(
      coalesceTransitions([
        { kind: 'closed', windowId: 7 },
        { kind: 'appeared', windowId: 7 }
      ])
    ).toEqual([{ kind: 'appeared', windowId: 7 }])
  })

  it('多窗口顺序按首次出现，互不干扰', () => {
    const merged = coalesceTransitions([
      { kind: 'appeared', windowId: 5 },
      { kind: 'moved', windowId: 2, delta: { x: 1, y: 1 } },
      { kind: 'moved', windowId: 2, delta: { x: 2, y: 2 } },
      { kind: 'appeared', windowId: 1 }
    ])
    expect(merged.map((event) => event.windowId)).toEqual([5, 2, 1])
    expect(merged[1]).toEqual({ kind: 'moved', windowId: 2, delta: { x: 3, y: 3 } })
  })

  it('返回副本：修改结果不污染输入事件', () => {
    const input = [{ kind: 'moved' as const, windowId: 1, delta: { x: 1, y: 2 } }]
    const output = coalesceTransitions(input)
    if (output[0].kind === 'moved') output[0].delta.x = 999
    expect(input[0].delta.x).toBe(1)
    expect(output[0]).not.toBe(input[0])
  })
})
