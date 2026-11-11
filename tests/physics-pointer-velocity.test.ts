/**
 * 单测：拖拽甩出速度估计（`src/renderer/src/physics/pointer-velocity.ts`）。
 *
 * 覆盖：速度上限 clamp、匀速合成轨迹估计、释放时"隐式停住"衰减、停住超时归零、
 * 时间回退/非法样本防御、样本数硬上限（O(1) 内存）、reset。
 */
import { describe, expect, it } from 'vitest'

import {
  clampVelocityMagnitude,
  PointerVelocityTracker,
  THROW_MAX_SAMPLES,
  THROW_MAX_SPEED_PX_PER_SEC
} from '../src/renderer/src/physics/index'

describe('clampVelocityMagnitude', () => {
  it('模长未超上限时原样返回（方向/大小不变）', () => {
    expect(clampVelocityMagnitude({ x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4 })
    expect(clampVelocityMagnitude({ x: -30, y: 40 }, 50)).toEqual({ x: -30, y: 40 })
  })

  it('超上限按比例缩放、方向不变', () => {
    const clamped = clampVelocityMagnitude({ x: 3000, y: 4000 }, 4000)
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(4000, 6)
    expect(clamped.x).toBeCloseTo(2400, 6)
    expect(clamped.y).toBeCloseTo(3200, 6)
  })

  it('零向量/无限上限不产生 NaN，不改变输入', () => {
    expect(clampVelocityMagnitude({ x: 0, y: 0 }, 4000)).toEqual({ x: 0, y: 0 })
    expect(clampVelocityMagnitude({ x: 5, y: 0 }, Number.POSITIVE_INFINITY)).toEqual({ x: 5, y: 0 })
  })
})

describe('PointerVelocityTracker', () => {
  it('无样本 → 零速度', () => {
    const tracker = new PointerVelocityTracker()
    expect(tracker.estimate(0)).toEqual({ x: 0, y: 0 })
  })

  it('单样本（时间跨度为 0）→ 零速度', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(100, 200, 1000)
    expect(tracker.estimate(1000)).toEqual({ x: 0, y: 0 })
  })

  it('匀速合成轨迹：120ms 窗口内估计出真实速度', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(100, 200, 1000)
    tracker.push(110, 200, 1010)
    tracker.push(120, 200, 1020)
    tracker.push(130, 200, 1030)
    const velocity = tracker.estimate(1030)
    expect(velocity.x).toBeCloseTo(1000, 6) // 30px / 30ms
    expect(velocity.y).toBeCloseTo(0, 6)
  })

  it('释放时刻视为停在最后位置：停住越久估计越小（不会轻轻放下却飞出去）', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(100, 200, 1000)
    tracker.push(110, 200, 1010)
    tracker.push(120, 200, 1020)
    tracker.push(130, 200, 1030)
    // 30ms 迟滞 → 位移 30px / 50ms
    expect(tracker.estimate(1050).x).toBeCloseTo(600, 6)
    // 60ms 迟滞 → 位移 30px / 80ms
    expect(tracker.estimate(1080).x).toBeCloseTo(375, 6)
    // 停住超过窗口（120ms）→ 0
    expect(tracker.estimate(1200)).toEqual({ x: 0, y: 0 })
  })

  it('速度估计上限 clamp 到 4000px/s', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(0, 0, 0)
    tracker.push(1000, 0, 10)
    const velocity = tracker.estimate(10)
    expect(velocity.x).toBeCloseTo(THROW_MAX_SPEED_PX_PER_SEC, 6)
  })

  it('时间回退按「不早于上一样本」处理：不产生负跨度/NaN', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(0, 0, 100)
    tracker.push(1000, 0, 50) // 注入时钟抖动：时间倒退
    expect(tracker.getSampleCount()).toBe(2)
    const velocity = tracker.estimate(100)
    expect(Number.isFinite(velocity.x)).toBe(true)
    expect(velocity.x).toBe(0)
  })

  it('非法坐标/时间样本被忽略', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(Number.NaN, 0, 0)
    tracker.push(0, Number.POSITIVE_INFINITY, 0)
    tracker.push(0, 0, Number.NaN)
    expect(tracker.getSampleCount()).toBe(0)
    expect(tracker.estimate(0)).toEqual({ x: 0, y: 0 })
  })

  it('长时间高频输入：样本数有硬上限（内存/耗时恒定）', () => {
    const tracker = new PointerVelocityTracker()
    for (let index = 0; index <= 5000; index += 1) {
      tracker.push(index % 10, 0, index)
    }
    expect(tracker.getSampleCount()).toBeLessThanOrEqual(THROW_MAX_SAMPLES)
    expect(tracker.getSampleCount()).toBeGreaterThan(1)
    const velocity = tracker.estimate(5000)
    expect(Number.isFinite(velocity.x)).toBe(true)
    expect(Math.abs(velocity.x)).toBeLessThanOrEqual(THROW_MAX_SPEED_PX_PER_SEC)
  })

  it('reset 清空样本', () => {
    const tracker = new PointerVelocityTracker()
    tracker.push(0, 0, 0)
    tracker.push(10, 0, 10)
    tracker.reset()
    expect(tracker.getSampleCount()).toBe(0)
    expect(tracker.estimate(10)).toEqual({ x: 0, y: 0 })
  })
})
