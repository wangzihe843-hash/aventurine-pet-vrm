/**
 * 摸头（圆形轨迹）检测（B4；纯逻辑，**不 import DOM/three/electron**，可在 node 单测）。
 *
 * 算法（任务书要求：头部中心 + 半径带 + 累积角度，直线/来回不算，带冷却 + progress）：
 * 1. 以「头中心」为极点（`PET_PAT_CENTER_Y_RATIO` 处），把每个指针采样转为极坐标；
 * 2. 半径必须落在 **半径带** `[minRadiusRatio, maxRadiusRatio] × petRect.height` 内，
 *    太近（贴着中心抖动）或太远（横扫桌面）的采样会清空已累积角度；
 * 3. 相邻采样的角度差取最短弧（-π..π）；单步角过大（如穿过中心附近）视为轨迹断裂，清空累积；
 * 4. 累积用**带符号**角度：顺时针/逆时针都计数，方向来回（左右蹭）会互相抵消 → 不算摸头；
 *    直线轨迹最多只能张角 π，达不到触发阈值（默认 1.6π ≈ 288°），所以也不会误触发；
 * 5. 累积 |角度| ≥ {@link PAT_TRIGGER_ANGLE_RAD} 且有效采样数 ≥ {@link PAT_MIN_SAMPLES}
 *    → 触发一次 pat，进入冷却（默认 1200ms）；progress = |累积角| / 阈值（0–1）；
 * 6. 停手超过 `progressDecayStartMs` 后 progress 线性衰减到 0（转速慢/停顿不会一直攒进度）。
 *
 * 摸头是「悬停画圈」手势，不需要按下鼠标：控制器在 mousemove 且未拖动/菜单未开时喂采样。
 * 冷却结束前不累积新进度；方向切换/断笔不会瞬间清零，但会按带符号抵消。
 */
import type { Rect } from '@shared/types'

import type { Point2D } from '../core/wave2-contract'

/** 头中心在 petRect 中的垂直位置（占高度比例；模型頭骨格距顶 11.3%，取面部中心 13%）。 */
export const PET_PAT_CENTER_Y_RATIO = 0.13

/** 半径带下限（占 petRect 高度比例；避免贴着中心的小抖动）。 */
export const PET_PAT_MIN_RADIUS_RATIO = 0.05

/** 半径带上限（占 petRect 高度比例；避免大范围扫桌被误判成摸头）。 */
export const PET_PAT_MAX_RADIUS_RATIO = 0.28

/** 触发一次摸头所需累积角度（弧度；1.6π ≈ 288°，一次不完整的圆圈也能触发）。 */
export const PAT_TRIGGER_ANGLE_RAD = Math.PI * 1.6

/** 触发所需最少有效采样数（避免两点跳变触发）。 */
export const PAT_MIN_SAMPLES = 8

/** 单步最大角度差（弧度；超过视为轨迹断裂，清空累积）。 */
export const PAT_MAX_STEP_ANGLE_RAD = 1.2

/** 相邻采样最大间隔（ms；断笔过久清空累积）。 */
export const PAT_MAX_SAMPLE_GAP_MS = 350

/** pat 冷却（ms；触发后多久内不再累积/触发）。 */
export const PAT_COOLDOWN_MS = 1200

/** 停手后开始衰减 progress 的延迟（ms）。 */
export const PAT_PROGRESS_DECAY_START_MS = 350

/** progress 衰减到 0 所需时间（ms，从 decayStart 之后算起）。 */
export const PAT_PROGRESS_DECAY_MS = 900

/** 可调参数（控制器/单测可覆盖）。 */
export interface PatTuning {
  centerYRatio: number
  minRadiusRatio: number
  maxRadiusRatio: number
  triggerAngleRad: number
  minSamples: number
  maxStepAngleRad: number
  maxSampleGapMs: number
  cooldownMs: number
  progressDecayStartMs: number
  progressDecayMs: number
}

const DEFAULT_PAT_TUNING: PatTuning = {
  centerYRatio: PET_PAT_CENTER_Y_RATIO,
  minRadiusRatio: PET_PAT_MIN_RADIUS_RATIO,
  maxRadiusRatio: PET_PAT_MAX_RADIUS_RATIO,
  triggerAngleRad: PAT_TRIGGER_ANGLE_RAD,
  minSamples: PAT_MIN_SAMPLES,
  maxStepAngleRad: PAT_MAX_STEP_ANGLE_RAD,
  maxSampleGapMs: PAT_MAX_SAMPLE_GAP_MS,
  cooldownMs: PAT_COOLDOWN_MS,
  progressDecayStartMs: PAT_PROGRESS_DECAY_START_MS,
  progressDecayMs: PAT_PROGRESS_DECAY_MS
}

/** 头中心（窗口本地 px；petRect 顶部下 13% 处、水平居中）。 */
export function getPatCenter(petRect: Rect | null | undefined): Point2D | null {
  if (!isValidRect(petRect)) return null
  return {
    x: petRect.x + petRect.width / 2,
    y: petRect.y + petRect.height * PET_PAT_CENTER_Y_RATIO
  }
}

/** 半径带（px；随宠物高度缩放）。 */
export function getPatRadiusBand(petRect: Rect | null | undefined): {
  minPx: number
  maxPx: number
} | null {
  if (!isValidRect(petRect)) return null
  const height = petRect.height
  return {
    minPx: height * PET_PAT_MIN_RADIUS_RATIO,
    maxPx: height * PET_PAT_MAX_RADIUS_RATIO
  }
}

/** 把角度归一到 (-π, π]。 */
export function normalizeAngleRad(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

/** 矩形是否可用（有限且宽高为正）。 */
function isValidRect(rect: Rect | null | undefined): rect is Rect {
  if (!rect) return false
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

/** 正数校验（非法/非正 → fallback）。 */
function sanitizePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
}

/**
 * 摸头轨迹检测器（纯逻辑，一个控制器一个实例）。
 *
 * - `sample(petRect, pointer, nowMs)`：喂一次指针采样；返回 true = 本次采样触发了 pat；
 * - `progress(nowMs)`：当前圆圈进度 0–1（含停手衰减，供 `InteractionSnapshot.patProgress`）；
 * - `reset()`：清空（拖拽/点击/离开窗口时调用）。
 */
export class PatDetector {
  private readonly tuning: PatTuning
  /** 带符号累积角度（弧度）。 */
  private accumulatedRad = 0
  /** 当前连续有效采样数。 */
  private sampleCount = 0
  private lastAngleRad: number | null = null
  private lastSampleAtMs: number | null = null
  private cooldownUntilMs = 0
  private lastTriggerTimeMs: number | null = null

  constructor(tuning: Partial<PatTuning> = {}) {
    this.tuning = {
      centerYRatio: sanitizePositive(tuning.centerYRatio, DEFAULT_PAT_TUNING.centerYRatio),
      minRadiusRatio: sanitizePositive(tuning.minRadiusRatio, DEFAULT_PAT_TUNING.minRadiusRatio),
      maxRadiusRatio: sanitizePositive(tuning.maxRadiusRatio, DEFAULT_PAT_TUNING.maxRadiusRatio),
      triggerAngleRad: sanitizePositive(
        tuning.triggerAngleRad,
        DEFAULT_PAT_TUNING.triggerAngleRad
      ),
      minSamples: Math.max(2, Math.round(sanitizePositive(tuning.minSamples, PAT_MIN_SAMPLES))),
      maxStepAngleRad: sanitizePositive(
        tuning.maxStepAngleRad,
        DEFAULT_PAT_TUNING.maxStepAngleRad
      ),
      maxSampleGapMs: sanitizePositive(
        tuning.maxSampleGapMs,
        DEFAULT_PAT_TUNING.maxSampleGapMs
      ),
      cooldownMs: sanitizePositive(tuning.cooldownMs, DEFAULT_PAT_TUNING.cooldownMs),
      progressDecayStartMs: sanitizePositive(
        tuning.progressDecayStartMs,
        DEFAULT_PAT_TUNING.progressDecayStartMs
      ),
      progressDecayMs: sanitizePositive(
        tuning.progressDecayMs,
        DEFAULT_PAT_TUNING.progressDecayMs
      )
    }
  }

  /** 当前调参（测试/调试用只读拷贝）。 */
  get currentTuning(): PatTuning {
    return { ...this.tuning }
  }

  /** 是否处于冷却中。 */
  isCoolingDown(nowMs: number): boolean {
    return Number.isFinite(nowMs) && nowMs < this.cooldownUntilMs
  }

  /** 最近一次触发时间（ms；从未触发为 null）。 */
  get lastTriggerAtMs(): number | null {
    return this.lastTriggerTimeMs
  }

  /** 带符号累积角度（弧度；测试/调试用）。 */
  get accumulatedAngleRad(): number {
    return this.accumulatedRad
  }

  /**
   * 喂一次指针采样。
   *
   * @param petRect 当前宠物矩形（null/非法 → 清空并返回 false）
   * @param pointer 指针位置（窗口本地 px；null → 断笔，清空连续累积）
   * @param nowMs 注入时钟（ms）
   * @returns 本次采样是否触发摸头
   */
  sample(
    petRect: Rect | null | undefined,
    pointer: Point2D | null | undefined,
    nowMs: number
  ): boolean {
    if (!Number.isFinite(nowMs)) return false
    if (!isValidRect(petRect) || !pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) {
      this.breakStroke(false)
      this.lastSampleAtMs = Number.isFinite(nowMs) ? nowMs : this.lastSampleAtMs
      return false
    }

    const centerX = petRect.x + petRect.width / 2
    const centerY = petRect.y + petRect.height * this.tuning.centerYRatio
    const radius = Math.hypot(pointer.x - centerX, pointer.y - centerY)
    const minRadius = petRect.height * this.tuning.minRadiusRatio
    const maxRadius = petRect.height * this.tuning.maxRadiusRatio

    // 冷却期：只记录采样时间，不累积（避免冷却结束瞬间用旧轨迹触发第二次）。
    if (nowMs < this.cooldownUntilMs) {
      this.lastSampleAtMs = nowMs
      this.lastAngleRad = Math.atan2(pointer.y - centerY, pointer.x - centerX)
      return false
    }

    // 半径带外 → 轨迹无效（清空连续累积）。
    if (radius < minRadius || radius > maxRadius) {
      this.breakStroke(true)
      this.lastSampleAtMs = nowMs
      return false
    }

    // 断笔过久 → 清空连续累积。
    if (this.lastSampleAtMs !== null && nowMs - this.lastSampleAtMs > this.tuning.maxSampleGapMs) {
      this.breakStroke(false)
    }

    const angle = Math.atan2(pointer.y - centerY, pointer.x - centerX)
    if (this.lastAngleRad === null) {
      this.lastAngleRad = angle
      this.lastSampleAtMs = nowMs
      return false
    }

    const delta = normalizeAngleRad(angle - this.lastAngleRad)
    this.lastAngleRad = angle
    this.lastSampleAtMs = nowMs

    // 单步角过大（穿过中心/瞬移/合成事件）→ 轨迹断裂。
    if (Math.abs(delta) > this.tuning.maxStepAngleRad) {
      this.accumulatedRad = 0
      this.sampleCount = 0
      return false
    }
    this.accumulatedRad += delta
    this.sampleCount += 1

    if (
      this.sampleCount >= this.tuning.minSamples &&
      Math.abs(this.accumulatedRad) >= this.tuning.triggerAngleRad
    ) {
      this.accumulatedRad = 0
      this.sampleCount = 0
      this.cooldownUntilMs = nowMs + this.tuning.cooldownMs
      this.lastTriggerTimeMs = nowMs
      return true
    }
    return false
  }

  /**
   * 当前摸头进度 0–1（含停手衰减；触发/冷却期间为 0）。
   * 衰减：停手超过 decayStart 后，在 decayMs 内从当前比例线性降到 0。
   */
  progress(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0
    if (nowMs < this.cooldownUntilMs) return 0
    const raw = Math.abs(this.accumulatedRad) / this.tuning.triggerAngleRad
    if (!(raw > 0)) return 0
    let factor = 1
    if (this.lastSampleAtMs !== null) {
      const idleMs = nowMs - this.lastSampleAtMs
      if (idleMs > this.tuning.progressDecayStartMs) {
        const decayed = (idleMs - this.tuning.progressDecayStartMs) / this.tuning.progressDecayMs
        factor = Math.max(0, 1 - decayed)
      }
    }
    return Math.min(1, Math.max(0, raw * factor))
  }

  /** 清空检测器（拖拽/点击/离开窗口/禁用时调用）。 */
  reset(): void {
    this.accumulatedRad = 0
    this.sampleCount = 0
    this.lastAngleRad = null
    this.lastSampleAtMs = null
    this.cooldownUntilMs = 0
    this.lastTriggerTimeMs = null
  }

  /** 断笔：清空连续累积与角度参考；保留冷却与最近触发时间。 */
  private breakStroke(clearSampleTime: boolean): void {
    this.accumulatedRad = 0
    this.sampleCount = 0
    this.lastAngleRad = null
    if (clearSampleTime) this.lastSampleAtMs = null
  }
}
