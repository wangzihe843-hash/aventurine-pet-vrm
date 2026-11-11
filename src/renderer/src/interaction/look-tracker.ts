/**
 * 注视目标跟踪（B4；纯逻辑，**不 import DOM/three/electron**，可在 node 单测）。
 *
 * 产出 `lookTarget`（窗口本地 CSS px）供 B1/B3 的 look-at 使用：
 * - **死区**：原始指针抖动小于 {@link LOOK_DEADZONE_PX} 时忽略（不刷新目标、不算"移动"）；
 * - **低通平滑**：指数平滑，时间常数 τ ≈ {@link LOOK_TIME_CONSTANT_MS}，用
 *   `1 - exp(-dt/τ)` 保证与帧率无关（30fps/60fps 一致）；dt 上限 {@link LOOK_MAX_STEP_MS}
 *   防止切后台/长暂停后一帧跳到位；
 * - **离开窗口**：`pointerMove(null)` → 立即返回 null（B1 据此让宠物视线回落）；
 * - **长时间不动回落**：最近一次有效移动超过 {@link LOOK_IDLE_RELEASE_MS} 后返回 null
 *   （"假装没在看"），再次移动即恢复跟踪。
 *
 * 时间由调用方注入；模块内不读时钟。
 */
import type { Point2D } from '../core/wave2-contract'

/** 死区半径（CSS px）：小于该位移的指针抖动被忽略。 */
export const LOOK_DEADZONE_PX = 1.5

/** 低通时间常数 τ（ms；≈100ms 的跟手延迟，桌宠注视更自然）。 */
export const LOOK_TIME_CONSTANT_MS = 100

/** 单次平滑推进的最大 dt（ms；防止长暂停后一帧跳到目标）。 */
export const LOOK_MAX_STEP_MS = 100

/** 长时间无移动后回落为"不注视"（ms）。 */
export const LOOK_IDLE_RELEASE_MS = 2500

/** 可调参数。 */
export interface LookTuning {
  deadzonePx: number
  timeConstantMs: number
  maxStepMs: number
  idleReleaseMs: number
}

const DEFAULT_LOOK_TUNING: LookTuning = {
  deadzonePx: LOOK_DEADZONE_PX,
  timeConstantMs: LOOK_TIME_CONSTANT_MS,
  maxStepMs: LOOK_MAX_STEP_MS,
  idleReleaseMs: LOOK_IDLE_RELEASE_MS
}

/** 正数校验（非法/非正 → fallback）。 */
function sanitizePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
}

/**
 * 注视目标跟踪器（一个控制器一个实例）。
 *
 * 使用方式：DOM `mousemove` 时调用 `pointerMove`；每帧（或每次事件后）调用 `sample(nowMs)`
 * 取当前平滑后的注视目标。`sample` 只在有有效目标时返回点，否则返回 null。
 */
export class LookTracker {
  private readonly tuning: LookTuning
  /** 原始（去死区后的）目标。 */
  private rawTarget: Point2D | null = null
  /** 平滑后的目标。 */
  private smoothed: Point2D | null = null
  private lastSampleAtMs: number | null = null
  /** 最近一次"有效移动"时间（死区内的抖动不算移动）。 */
  private lastMoveTimeMs: number | null = null

  constructor(tuning: Partial<LookTuning> = {}) {
    this.tuning = {
      deadzonePx: sanitizePositive(tuning.deadzonePx, DEFAULT_LOOK_TUNING.deadzonePx),
      timeConstantMs: sanitizePositive(tuning.timeConstantMs, DEFAULT_LOOK_TUNING.timeConstantMs),
      maxStepMs: sanitizePositive(tuning.maxStepMs, DEFAULT_LOOK_TUNING.maxStepMs),
      idleReleaseMs: sanitizePositive(tuning.idleReleaseMs, DEFAULT_LOOK_TUNING.idleReleaseMs)
    }
  }

  /** 当前调参（测试/调试用只读拷贝）。 */
  get currentTuning(): LookTuning {
    return { ...this.tuning }
  }

  /** 最近一次有效移动时间（ms；从未移动为 null）。 */
  get lastMoveAtMs(): number | null {
    return this.lastMoveTimeMs
  }

  /** 原始目标（未平滑；null = 无目标）。 */
  get rawGoal(): Point2D | null {
    return this.rawTarget ? { ...this.rawTarget } : null
  }

  /** 平滑后的目标（不触发时间推进；null = 无目标/无采样）。 */
  get target(): Point2D | null {
    return this.smoothed ? { ...this.smoothed } : null
  }

  /**
   * 指针移动（null = 离开窗口/禁用）。
   *
   * 死区内的抖动只更新采样时间、不改变目标（也不刷新"最后移动时间"，
   * 这样手停在原地 2.5s 后会如设计那样回落为不注视）。
   */
  pointerMove(pointer: Point2D | null, nowMs: number): void {
    if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
      this.rawTarget = null
      this.smoothed = null
      this.lastSampleAtMs = null
      this.lastMoveTimeMs = null
      return
    }
    const time = Number.isFinite(nowMs) ? nowMs : (this.lastSampleAtMs ?? 0)
    if (!this.rawTarget || !this.smoothed) {
      // 首次进入窗口：直接吸附到指针位置，避免从 (0,0) 滑过去。
      this.rawTarget = { x: pointer.x, y: pointer.y }
      this.smoothed = { x: pointer.x, y: pointer.y }
      this.lastSampleAtMs = time
      this.lastMoveTimeMs = time
      return
    }
    const moved = Math.hypot(pointer.x - this.rawTarget.x, pointer.y - this.rawTarget.y)
    if (moved < this.tuning.deadzonePx) return
    this.rawTarget = { x: pointer.x, y: pointer.y }
    this.lastMoveTimeMs = time
  }

  /**
   * 推进平滑并返回当前注视目标。
   *
   * @returns 平滑后的窗口本地 CSS px；离开窗口 / 超过 idleReleaseMs 无移动时为 null
   */
  sample(nowMs: number): Point2D | null {
    if (!this.rawTarget || !this.smoothed) return null
    const now = Number.isFinite(nowMs) ? nowMs : (this.lastSampleAtMs ?? 0)
    if (this.lastMoveTimeMs !== null && now - this.lastMoveTimeMs > this.tuning.idleReleaseMs) {
      return null
    }
    const last = this.lastSampleAtMs
    this.lastSampleAtMs = now
    if (last === null) return { ...this.smoothed }
    const dt = Math.min(
      this.tuning.maxStepMs,
      Math.max(0, now - last)
    )
    if (dt <= 0) return { ...this.smoothed }
    const alpha = 1 - Math.exp(-dt / this.tuning.timeConstantMs)
    this.smoothed = {
      x: this.smoothed.x + (this.rawTarget.x - this.smoothed.x) * alpha,
      y: this.smoothed.y + (this.rawTarget.y - this.smoothed.y) * alpha
    }
    return { ...this.smoothed }
  }

  /** 清空状态（禁用/断线时调用）。 */
  reset(): void {
    this.rawTarget = null
    this.smoothed = null
    this.lastSampleAtMs = null
    this.lastMoveTimeMs = null
  }
}
