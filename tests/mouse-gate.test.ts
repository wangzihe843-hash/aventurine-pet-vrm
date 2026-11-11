/**
 * 单测：点击穿透状态机（`src/main/windows/mouse-gate.ts`，Wave 1 A1）。
 *
 * 覆盖：初始态 / 穿透→拦截立即生效 / 拦截→穿透单帧延迟 / 连续 toggle 合并 /
 * 重复同值幂等 / flush 强制落地 / dispose 丢弃排队 / 自定义 frameMs。
 * 纯状态机不依赖 Electron，可在 vitest node 环境直接跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createIgnoreMouseGate,
  IGNORE_MOUSE_FRAME_MS
} from '../src/main/windows/mouse-gate'
import type { IgnoreMouseGate, IgnoreMouseGateOptions } from '../src/main/windows/mouse-gate'

beforeEach(() => {
  // 默认调度器用全局 setTimeout：用假定时器精确控制「一帧」边界
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 记录 apply 调用的测试夹具。 */
function createHarness(options: Partial<IgnoreMouseGateOptions> = {}): {
  gate: IgnoreMouseGate
  applied: boolean[]
} {
  const applied: boolean[] = []
  const gate = createIgnoreMouseGate({
    apply: (ignore: boolean): void => {
      applied.push(ignore)
    },
    ...options
  })
  return { gate, applied }
}

describe('mouse gate：默认参数', () => {
  it('默认延迟 = 一帧（16ms @60Hz）', () => {
    expect(IGNORE_MOUSE_FRAME_MS).toBe(16)
  })

  it('初始状态：current / pending 均为 null，尚未 apply 过', () => {
    const { gate, applied } = createHarness()
    expect(gate.current()).toBeNull()
    expect(gate.pending()).toBeNull()
    expect(applied).toEqual([])
  })
})

describe('mouse gate：穿透 → 拦截立即生效', () => {
  it('初始态首次 request(false) 立即拦截', () => {
    const { gate, applied } = createHarness()
    expect(gate.request(false)).toBe(true)
    expect(gate.current()).toBe(false)
    expect(gate.pending()).toBeNull()
    expect(applied).toEqual([false])
  })

  it('从已穿透切回拦截立即生效（不等定时器）', () => {
    const { gate, applied } = createHarness()
    gate.request(false)
    gate.request(true)
    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS)
    expect(gate.current()).toBe(true)

    expect(gate.request(false)).toBe(true)
    expect(gate.current()).toBe(false)
    expect(gate.pending()).toBeNull()
    expect(applied).toEqual([false, true, false])
  })
})

describe('mouse gate：拦截 → 穿透延迟一帧（mouseup 保护）', () => {
  it('一帧前不生效、到点生效', () => {
    const { gate, applied } = createHarness()
    gate.request(false)

    expect(gate.request(true)).toBe(false)
    expect(gate.current()).toBe(false)
    expect(gate.pending()).toBe(true)
    expect(applied).toEqual([false])

    // 15ms：仍未生效
    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS - 1)
    expect(gate.current()).toBe(false)
    expect(gate.pending()).toBe(true)
    expect(applied).toEqual([false])

    // 第 16ms：生效
    vi.advanceTimersByTime(1)
    expect(gate.current()).toBe(true)
    expect(gate.pending()).toBeNull()
    expect(applied).toEqual([false, true])
  })

  it('初始态（未知）首次 request(true) 也保守延迟一帧', () => {
    const { gate, applied } = createHarness()
    expect(gate.request(true)).toBe(false)
    expect(gate.current()).toBeNull()
    expect(gate.pending()).toBe(true)
    expect(applied).toEqual([])

    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS)
    expect(gate.current()).toBe(true)
    expect(gate.pending()).toBeNull()
    expect(applied).toEqual([true])
  })

  it('自定义 frameMs 生效', () => {
    const { gate, applied } = createHarness({ frameMs: 8 })
    gate.request(false)
    gate.request(true)

    vi.advanceTimersByTime(7)
    expect(gate.current()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(gate.current()).toBe(true)
    expect(applied).toEqual([false, true])
  })
})

describe('mouse gate：连续快速 toggle 合并', () => {
  it('重复 request(true) 合并为一次调度，到点只 apply 一次', () => {
    const scheduled: Array<() => void> = []
    const { gate, applied } = createHarness({
      schedule: (fn: () => void): void => {
        scheduled.push(fn)
      }
    })
    gate.request(false)

    expect(gate.request(true)).toBe(false)
    expect(gate.request(true)).toBe(false)
    expect(gate.request(true)).toBe(false)
    expect(scheduled).toHaveLength(1)
    expect(gate.pending()).toBe(true)

    // 执行排队的任务（等价于一帧到点）
    for (const fn of scheduled) fn()
    expect(gate.current()).toBe(true)
    expect(applied).toEqual([false, true])
  })

  it('排队中重新拦截：立即生效并作废延迟任务（mouseup 不能丢）', () => {
    const scheduled: Array<() => void> = []
    const { gate, applied } = createHarness({
      schedule: (fn: () => void): void => {
        scheduled.push(fn)
      }
    })
    gate.request(false)

    // 拦截 → 穿透排队中
    expect(gate.request(true)).toBe(false)
    expect(gate.pending()).toBe(true)
    expect(scheduled).toHaveLength(1)

    // 用户又悬停回宠物：立即回到拦截，穿透请求作废
    expect(gate.request(false)).toBe(true)
    expect(gate.current()).toBe(false)
    expect(gate.pending()).toBeNull()

    // 过期任务执行也不应再切到穿透
    for (const fn of scheduled) fn()
    expect(gate.current()).toBe(false)
    expect(applied).toEqual([false])
  })

  it('拦截 → 穿透 → 拦截 → 穿透：只有最后一次调度生效，旧任务被 seq 丢弃', () => {
    const { gate, applied } = createHarness()
    gate.request(false)

    gate.request(true) // 第 1 次穿透调度
    gate.request(false) // 取消
    gate.request(true) // 第 2 次穿透调度

    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS)
    expect(gate.current()).toBe(true)
    expect(gate.pending()).toBeNull()
    // 两个定时器都在本帧到点，但旧任务被序号作废，只应用了一次 true
    expect(applied).toEqual([false, true])
  })

  it('重复同值幂等：已生效后再次请求不重复 apply', () => {
    const { gate, applied } = createHarness()
    gate.request(false)
    expect(gate.request(false)).toBe(true)
    expect(gate.request(false)).toBe(true)
    expect(applied).toEqual([false])

    gate.request(true)
    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS)
    expect(gate.request(true)).toBe(true)
    expect(gate.request(true)).toBe(true)
    expect(applied).toEqual([false, true])
  })
})

describe('mouse gate：flush / dispose', () => {
  it('flush 立即应用排队状态，并作废延迟任务（不会重复 apply）', () => {
    const { gate, applied } = createHarness()
    gate.request(false)
    gate.request(true)
    expect(gate.pending()).toBe(true)

    gate.flush()
    expect(gate.current()).toBe(true)
    expect(gate.pending()).toBeNull()
    expect(applied).toEqual([false, true])

    // 原定时器到点不应再次应用
    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS)
    expect(applied).toEqual([false, true])
  })

  it('无排队时 flush 是 no-op', () => {
    const { gate, applied } = createHarness()
    gate.request(false)
    gate.flush()
    expect(applied).toEqual([false])
    expect(gate.current()).toBe(false)
  })

  it('dispose 丢弃排队状态：窗口销毁后不再 apply', () => {
    const { gate, applied } = createHarness()
    gate.request(false)
    gate.request(true)
    expect(gate.pending()).toBe(true)

    gate.dispose()
    expect(gate.pending()).toBeNull()

    // 过期定时器到点不应应用
    vi.advanceTimersByTime(IGNORE_MOUSE_FRAME_MS)
    expect(gate.current()).toBe(false)
    expect(applied).toEqual([false])

    // dispose 后请求不再改变状态
    expect(gate.request(true)).toBe(false)
    expect(gate.current()).toBe(false)
  })
})
