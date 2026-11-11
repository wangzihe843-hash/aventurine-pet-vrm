/**
 * 单测：B4 注视目标跟踪（`src/renderer/src/interaction/look-tracker.ts`）。
 *
 * 覆盖：首次吸附、指数低通平滑（τ=100ms）、死区抖动忽略、离开窗口 → null、
 * 2.5s 无移动回落、长暂停 dt 钳制、reset、参数覆盖。
 */
import { describe, expect, it } from 'vitest'

import {
  LOOK_DEADZONE_PX,
  LOOK_IDLE_RELEASE_MS,
  LOOK_TIME_CONSTANT_MS,
  LookTracker
} from '../src/renderer/src/interaction/look-tracker'

describe('LookTracker：平滑与死区', () => {
  it('首次进入窗口直接吸附到指针位置（不从 0,0 滑过去）', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 400, y: 300 }, 0)
    expect(tracker.sample(0)).toEqual({ x: 400, y: 300 })
    expect(tracker.lastMoveAtMs).toBe(0)
  })

  it('τ=100ms 时 100ms 后走完 63.2% 距离（与帧率无关的指数平滑）', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 100, y: 100 }, 0)
    tracker.sample(0)
    tracker.pointerMove({ x: 200, y: 100 }, 0)
    const after100 = tracker.sample(100)
    expect(after100).not.toBeNull()
    expect(after100!.x).toBeCloseTo(100 + 100 * (1 - Math.exp(-1)), 3)
    expect(after100!.y).toBeCloseTo(100, 6)
    // 再推进 100ms → 剩余距离的 63.2%
    const expected = 100 + 100 * (1 - Math.exp(-1))
    const after200 = tracker.sample(200)!
    expect(after200.x).toBeCloseTo(expected + (200 - expected) * (1 - Math.exp(-1)), 3)
    // 长时间（线性多步）收敛到 200
    tracker.sample(300)
    tracker.sample(400)
    tracker.sample(500)
    expect(tracker.target!.x).toBeGreaterThan(199)
    expect(tracker.target!.x).toBeLessThanOrEqual(200)
  })

  it(`死区：位移 < ${LOOK_DEADZONE_PX}px 的抖动被忽略（目标不变）`, () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 100, y: 100 }, 0)
    tracker.sample(0)
    tracker.pointerMove({ x: 100 + LOOK_DEADZONE_PX - 0.2, y: 100 }, 16)
    expect(tracker.rawGoal).toEqual({ x: 100, y: 100 })
    const result = tracker.sample(16)
    expect(result).not.toBeNull()
    expect(result!.x).toBeCloseTo(100, 6)
    // 超过死区才更新目标
    tracker.pointerMove({ x: 100 + LOOK_DEADZONE_PX + 1, y: 100 }, 32)
    expect(tracker.rawGoal).toEqual({ x: 100 + LOOK_DEADZONE_PX + 1, y: 100 })
  })

  it('长暂停 dt 钳制到 100ms：不会一帧跳到目标', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 0, y: 0 }, 0)
    tracker.sample(0)
    tracker.pointerMove({ x: 1000, y: 0 }, 4000) // 4s 后的新目标
    const result = tracker.sample(5000) // 距上次采样 1000ms → dt 被钳到 100ms
    expect(result).not.toBeNull()
    expect(result!.x).toBeCloseTo(1000 * (1 - Math.exp(-1)), 2)
  })

  it('参数覆盖：timeConstantMs=200 时 100ms 走 39.3%', () => {
    const tracker = new LookTracker({ timeConstantMs: 200 })
    tracker.pointerMove({ x: 0, y: 0 }, 0)
    tracker.sample(0)
    tracker.pointerMove({ x: 100, y: 0 }, 0)
    const result = tracker.sample(100)
    expect(result!.x).toBeCloseTo(100 * (1 - Math.exp(-0.5)), 3)
  })
})

describe('LookTracker：离开 / 长时间不动回落 / 复位', () => {
  it('指针离开窗口 → null（rawGoal 也清空）', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 400, y: 300 }, 0)
    tracker.sample(0)
    tracker.pointerMove(null, 16)
    expect(tracker.sample(16)).toBeNull()
    expect(tracker.rawGoal).toBeNull()
    expect(tracker.target).toBeNull()
  })

  it(`超过 ${LOOK_IDLE_RELEASE_MS}ms 无有效移动 → 回落为 null；再次移动恢复跟踪`, () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 400, y: 300 }, 0)
    expect(tracker.sample(LOOK_IDLE_RELEASE_MS)).not.toBeNull() // 边界仍跟踪
    expect(tracker.sample(LOOK_IDLE_RELEASE_MS + 1)).toBeNull()
    tracker.pointerMove({ x: 500, y: 300 }, LOOK_IDLE_RELEASE_MS + 100)
    expect(tracker.sample(LOOK_IDLE_RELEASE_MS + 100)).not.toBeNull()
  })

  it('死区内抖动不刷新"最后移动时间"（手停住也会按时回落）', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 400, y: 300 }, 0)
    tracker.sample(0)
    tracker.pointerMove({ x: 400.5, y: 300 }, LOOK_IDLE_RELEASE_MS + 50)
    expect(tracker.sample(LOOK_IDLE_RELEASE_MS + 50)).toBeNull()
  })

  it('非法指针坐标按离开处理（不抛、不产生 NaN 目标）', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 400, y: 300 }, 0)
    tracker.sample(0)
    tracker.pointerMove({ x: Number.NaN, y: 300 }, 16)
    expect(tracker.sample(16)).toBeNull()
  })

  it('reset 清空状态', () => {
    const tracker = new LookTracker()
    tracker.pointerMove({ x: 400, y: 300 }, 0)
    tracker.sample(0)
    tracker.reset()
    expect(tracker.sample(16)).toBeNull()
    expect(tracker.lastMoveAtMs).toBeNull()
    expect(tracker.target).toBeNull()
  })

  it('默认参数：τ≈100ms、死区≈1.5px、回落≈2.5s', () => {
    expect(LOOK_TIME_CONSTANT_MS).toBe(100)
    expect(LOOK_DEADZONE_PX).toBe(1.5)
    expect(LOOK_IDLE_RELEASE_MS).toBe(2500)
  })
})
