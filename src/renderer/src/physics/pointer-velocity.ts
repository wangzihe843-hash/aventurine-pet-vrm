/**
 * 指针速度估计（B2 拖拽甩出用）—— 纯逻辑，可单测。
 *
 * 甩出手感的关键在「释放瞬间的初速度」：
 * - 只记录最近 {@link THROW_SAMPLE_WINDOW_MS}（120ms）内的指针样本；
 * - 释放时刻 `nowMs` 视为指针**停在最后位置**（隐式停住样本）：若用户先停住再松手，
 *   估计值会自然衰减到很小 → 不会出现"轻轻放下却飞出去"；
 * - 速度 =(最后位置 − 窗口内最早位置) / (nowMs − 最早样本时间)，再按上限 clamp；
 * - 样本数有硬上限（{@link THROW_MAX_SAMPLES}），异常高频输入也不会让内存/耗时增长。
 */
import type { Point2D } from '../core/wave2-contract'

import {
  THROW_MAX_SAMPLES,
  THROW_MAX_SPEED_PX_PER_SEC,
  THROW_SAMPLE_WINDOW_MS
} from './constants'
import { isFiniteNumber } from './util'

/** 一条指针样本（窗口本地 CSS 像素 + 单调时钟 ms）。 */
export interface PointerSample {
  x: number
  y: number
  t: number
}

/** 把速度向量的模长钳制到上限（方向不变）。 */
export function clampVelocityMagnitude(
  velocity: Point2D,
  maxSpeedPxPerSec: number
): Point2D {
  const speed = Math.hypot(velocity.x, velocity.y)
  if (!Number.isFinite(speed) || speed <= maxSpeedPxPerSec || speed <= 0) {
    return { x: velocity.x, y: velocity.y }
  }
  const scale = maxSpeedPxPerSec / speed
  return { x: velocity.x * scale, y: velocity.y * scale }
}

/** 指针速度估计器（拖拽开始时 reset，拖拽中 push，释放时 estimate）。 */
export class PointerVelocityTracker {
  private readonly windowMs: number
  private readonly maxSamples: number
  private readonly maxSpeedPxPerSec: number
  private samples: PointerSample[] = []

  constructor(
    windowMs: number = THROW_SAMPLE_WINDOW_MS,
    maxSamples: number = THROW_MAX_SAMPLES,
    maxSpeedPxPerSec: number = THROW_MAX_SPEED_PX_PER_SEC
  ) {
    this.windowMs = isFiniteNumber(windowMs) && windowMs > 0 ? windowMs : THROW_SAMPLE_WINDOW_MS
    this.maxSamples =
      isFiniteNumber(maxSamples) && maxSamples >= 2 ? Math.floor(maxSamples) : THROW_MAX_SAMPLES
    this.maxSpeedPxPerSec =
      isFiniteNumber(maxSpeedPxPerSec) && maxSpeedPxPerSec > 0
        ? maxSpeedPxPerSec
        : THROW_MAX_SPEED_PX_PER_SEC
  }

  /** 清空样本（beginDrag / endDrag / teleport 时调用）。 */
  reset(): void {
    this.samples = []
  }

  /**
   * 记录一条指针样本。非法坐标/时间直接忽略；时间回退按「不早于上一样本」处理
   * （防御注入时钟抖动，保证估计结果确定）。
   */
  push(x: number, y: number, nowMs: number): void {
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(nowMs)) return
    const last = this.samples[this.samples.length - 1]
    const t = last && nowMs < last.t ? last.t : nowMs
    this.samples.push({ x, y, t })
    while (this.samples.length > 1 && this.samples[0].t < t - this.windowMs) {
      this.samples.shift()
    }
    while (this.samples.length > this.maxSamples) {
      this.samples.shift()
    }
  }

  /**
   * 估计释放瞬间的指针速度（px/s；窗口本地坐标，y 向下为正）。
   *
   * - 样本为空 / 窗口内没有有效位移 / 时间跨度非正 → `{x:0,y:0}`；
   * - 若最后一条样本早于 `nowMs - windowMs`（用户停住超过窗口才松手）→ 0。
   */
  estimate(nowMs: number): Point2D {
    const count = this.samples.length
    if (count === 0) return { x: 0, y: 0 }
    const last = this.samples[count - 1]
    const tNow = isFiniteNumber(nowMs) && nowMs > last.t ? nowMs : last.t
    const windowStart = tNow - this.windowMs
    if (last.t < windowStart) return { x: 0, y: 0 }
    let first = this.samples[0]
    for (let index = 0; index < count; index += 1) {
      if (this.samples[index].t >= windowStart) {
        first = this.samples[index]
        break
      }
    }
    const dtMs = tNow - first.t
    if (!(dtMs > 0)) return { x: 0, y: 0 }
    const velocity: Point2D = {
      x: ((last.x - first.x) * 1000) / dtMs,
      y: ((last.y - first.y) * 1000) / dtMs
    }
    return clampVelocityMagnitude(velocity, this.maxSpeedPxPerSec)
  }

  /** 当前保留的样本数（调试/性能测试用）。 */
  getSampleCount(): number {
    return this.samples.length
  }
}
