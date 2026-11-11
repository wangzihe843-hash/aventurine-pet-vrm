/**
 * 拖拽 / 点按状态机（B4；纯逻辑，**不 import DOM/three/electron**，可在 node 单测）。
 *
 * 语义（PLAN §5-B4 / docs/wave2-integration.md §3-B4）：
 * - 左键按下后先进入 `pressed`（候选）状态；位移 < {@link DRAG_THRESHOLD_PX} 时还不算拖动，
 *   这样单击不会被误判成拖动（2–4px 阈值，默认 3px）；
 * - 位移达到阈值 → 进入 `dragging`，此后**即使指针离开宠物矩形也持续拖动**（本模块不关心矩形）；
 * - 拖动中每次移动喂入采样（ring buffer），松手时用最近 ~120ms 的采样估计甩出速度
 *   （按 axis clamp 到 ±4000 px/s，防止瞬移/合成事件造成离谱初速）；
 * - 松手时若从未越过拖动阈值：返回 tap 结果，控制器据此判断是否 poke
 *   （短按 <250ms 且位移小 → poke；长按不触发）。
 *
 * 时间全部由调用方注入（`nowMs`，建议 `performance.now()` 口径），模块内不读时钟。
 */
import type { Point2D } from '../core/wave2-contract'

/** click / drag 判定阈值（CSS px；任务书 2–4px，取中值）。 */
export const DRAG_THRESHOLD_PX = 3

/** poke（戳）最长按压时长（ms）；超过则视为长按，不产生 poke。 */
export const POKE_MAX_DURATION_MS = 250

/** 甩出速度估计的时间窗口（ms；B2 要求最近 100–150ms）。 */
export const THROW_VELOCITY_WINDOW_MS = 120

/** 甩出速度上限（px/s；B2 契约建议 clamp 到 ~4000）。 */
export const MAX_THROW_SPEED_PX_PER_SEC = 4000

/** 速度估计的最小时间差（ms）；两份采样太近时改用更早的采样，避免除零/爆表。 */
export const MIN_THROW_SAMPLE_DT_MS = 8

/** 采样 ring buffer 上限（60fps 下约 1s，足够覆盖 120ms 速度窗口）。 */
export const MAX_DRAG_SAMPLES = 64

/** 一次指针采样（窗口本地 CSS px + 注入时钟毫秒）。 */
export interface DragSample {
  x: number
  y: number
  /** 采样时间（ms；单调递增） */
  t: number
}

/** 可调参数（控制器/单测可覆盖默认值）。 */
export interface DragTuning {
  dragThresholdPx: number
  pokeMaxDurationMs: number
  velocityWindowMs: number
  maxThrowSpeedPxPerSec: number
  maxSamples: number
}

/** 拖动中的一次移动结果。 */
export interface DragMoveResult {
  /** 本次移动是否**刚刚**越过拖动阈值（true = 需要发 dragStart 事件）。 */
  started: boolean
  /** 当前是否处于拖动中（started 之后的所有 move 都为 true）。 */
  dragging: boolean
}

/** 松手结果：拖动结束（甩出）。 */
export interface DragEndDragged {
  kind: 'dragEnd'
  pointer: Point2D
  throwVelocity: Point2D
}

/** 松手结果：短按（是否 poke 由控制器结合按下区域判断）。 */
export interface DragEndTap {
  kind: 'tap'
  pointer: Point2D
  durationMs: number
  displacementPx: number
  /** 是否满足 poke 条件（时长 ≤ pokeMaxDurationMs 且位移 < 拖动阈值）。 */
  isPoke: boolean
}

/** 松手结果：当前没有按下的指针（多点/异常事件）。 */
export interface DragEndNone {
  kind: 'none'
}

/** 松手结果联合类型。 */
export type DragEndResult = DragEndDragged | DragEndTap | DragEndNone

/** 向量长度。 */
function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

/** 数值是否可用于拖拽状态机（有限数）。 */
function isFinitePoint(point: Point2D | null | undefined): point is Point2D {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
}

/** 从采样里找「最近一次不晚于 nowMs」的采样下标（没有则 -1）。 */
function findSampleIndexAtOrBefore(samples: readonly DragSample[], nowMs: number): number {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].t <= nowMs) return index
  }
  return -1
}

/**
 * 用最近 `windowMs` 内的采样估计指针速度（px/s；y 向下为正）。
 *
 * - 基准采样 = 时间窗口内最早的采样；若窗口内只有一个采样，则退化为「最后一个采样与它的前一个」；
 * - 时间差 < {@link MIN_THROW_SAMPLE_DT_MS} 时继续向前找，避免除零；找不到返回 (0,0)；
 * - 速度向量按 {@link MAX_THROW_SPEED_PX_PER_SEC} 做**整体**钳制（保持方向）。
 *
 * 纯函数，便于用合成轨迹做单测（拖拽松手、甩出）。
 */
export function estimateThrowVelocity(
  samples: readonly DragSample[],
  nowMs: number,
  windowMs: number = THROW_VELOCITY_WINDOW_MS,
  maxSpeedPxPerSec: number = MAX_THROW_SPEED_PX_PER_SEC
): Point2D {
  if (samples.length < 2) return { x: 0, y: 0 }
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : THROW_VELOCITY_WINDOW_MS
  const endIndex = findSampleIndexAtOrBefore(samples, nowMs)
  const lastIndex = endIndex >= 0 ? endIndex : samples.length - 1
  const end = samples[lastIndex]
  if (!end) return { x: 0, y: 0 }

  // 窗口内最早的采样（最靠近 end 的那个方向）；不是直接找 t >= now-window 的第一个。
  let baseIndex = lastIndex
  const windowStart = end.t - window
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    if (samples[index].t >= windowStart) baseIndex = index
    else break
  }
  if (baseIndex === lastIndex) baseIndex = Math.max(0, lastIndex - 1)

  const base = samples[baseIndex]
  if (!base) return { x: 0, y: 0 }
  let dtMs = end.t - base.t
  // 采样太近（抖动/同一帧多次 move）→ 继续向前找最早可用基准，最多回退到最旧采样。
  let fallbackIndex = baseIndex
  while (dtMs < MIN_THROW_SAMPLE_DT_MS && fallbackIndex > 0) {
    fallbackIndex -= 1
    dtMs = end.t - samples[fallbackIndex].t
  }
  if (dtMs < MIN_THROW_SAMPLE_DT_MS) return { x: 0, y: 0 }
  let vx = ((end.x - samples[fallbackIndex].x) / dtMs) * 1000
  let vy = ((end.y - samples[fallbackIndex].y) / dtMs) * 1000
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) return { x: 0, y: 0 }
  const speed = Math.hypot(vx, vy)
  const maxSpeed =
    Number.isFinite(maxSpeedPxPerSec) && maxSpeedPxPerSec > 0
      ? maxSpeedPxPerSec
      : MAX_THROW_SPEED_PX_PER_SEC
  if (speed > maxSpeed && speed > 0) {
    const scale = maxSpeed / speed
    vx *= scale
    vy *= scale
  }
  return { x: vx, y: vy }
}

/**
 * 拖拽状态机（每个指针/每个交互控制器一个实例）。
 *
 * 使用顺序：`begin()` → 多次 `move()` → `end()`；取消/失焦时用 `cancel()`。
 * 所有方法对非法输入/乱序调用都安全（返回 none / no-op），不会抛错。
 */
export class DragMachine {
  private readonly tuning: DragTuning
  private samples: DragSample[] = []
  private startPoint: Point2D | null = null
  private startTimeMs = 0
  private draggingFlag = false

  constructor(tuning: Partial<DragTuning> = {}) {
    this.tuning = {
      dragThresholdPx: sanitizePositive(tuning.dragThresholdPx, DRAG_THRESHOLD_PX),
      pokeMaxDurationMs: sanitizePositive(tuning.pokeMaxDurationMs, POKE_MAX_DURATION_MS),
      velocityWindowMs: sanitizePositive(tuning.velocityWindowMs, THROW_VELOCITY_WINDOW_MS),
      maxThrowSpeedPxPerSec: sanitizePositive(
        tuning.maxThrowSpeedPxPerSec,
        MAX_THROW_SPEED_PX_PER_SEC
      ),
      maxSamples: Math.max(2, Math.round(sanitizePositive(tuning.maxSamples, MAX_DRAG_SAMPLES)))
    }
  }

  /** 当前是否有按下的指针（候选点击或拖动中）。 */
  get pressed(): boolean {
    return this.startPoint !== null
  }

  /** 当前是否已经进入拖动状态。 */
  get dragging(): boolean {
    return this.draggingFlag
  }

  /** 按下点（窗口本地 px；未按下时 null）。 */
  get pressStart(): Point2D | null {
    return this.startPoint ? { ...this.startPoint } : null
  }

  /** 按下到当前的时间（调用方传入 nowMs；未按下时 0）。 */
  pressElapsedMs(nowMs: number): number {
    if (!this.startPoint || !Number.isFinite(nowMs)) return 0
    return Math.max(0, nowMs - this.startTimeMs)
  }

  /** 当前调参（测试/调试用只读拷贝）。 */
  get currentTuning(): DragTuning {
    return { ...this.tuning }
  }

  /** 最近一次采样（窗口本地 px；无采样时 null）。 */
  get lastSample(): DragSample | null {
    const last = this.samples[this.samples.length - 1]
    return last ? { ...last } : null
  }

  /** 左键按下：进入候选状态。重复按下（已有状态）忽略。 */
  begin(pointer: Point2D, nowMs: number): void {
    if (this.startPoint) return
    if (!isFinitePoint(pointer) || !Number.isFinite(nowMs)) return
    this.startPoint = { x: pointer.x, y: pointer.y }
    this.startTimeMs = nowMs
    this.draggingFlag = false
    this.samples = [{ x: pointer.x, y: pointer.y, t: nowMs }]
  }

  /** 指针移动：低于阈值只记采样；越过阈值返回 `started=true`（只需发一次 dragStart）。 */
  move(pointer: Point2D, nowMs: number): DragMoveResult {
    if (!this.startPoint) return { started: false, dragging: false }
    if (!isFinitePoint(pointer) || !Number.isFinite(nowMs)) {
      return { started: false, dragging: this.draggingFlag }
    }
    this.pushSample(pointer, nowMs)
    if (this.draggingFlag) return { started: false, dragging: true }
    const moved = distance(pointer.x, pointer.y, this.startPoint.x, this.startPoint.y)
    if (moved >= this.tuning.dragThresholdPx) {
      this.draggingFlag = true
      return { started: true, dragging: true }
    }
    return { started: false, dragging: false }
  }

  /**
   * 松手：拖动中 → dragEnd（含甩出速度）；否则 → tap（含是否是 poke）。
   * 没有按下状态时返回 `{kind:'none'}`，调用方无需再做分支。
   */
  end(pointer: Point2D | null, nowMs: number): DragEndResult {
    if (!this.startPoint) return { kind: 'none' }
    const endPoint = isFinitePoint(pointer) ? pointer : this.lastSample
    const endTime = Number.isFinite(nowMs) ? nowMs : (this.lastSample?.t ?? this.startTimeMs)
    const safePoint: Point2D = endPoint
      ? { x: endPoint.x, y: endPoint.y }
      : { x: this.startPoint.x, y: this.startPoint.y }
    if (Number.isFinite(endPoint?.x) && Number.isFinite(endPoint?.y)) {
      this.pushSample(safePoint, endTime)
    }

    if (this.draggingFlag) {
      const throwVelocity = estimateThrowVelocity(
        this.samples,
        endTime,
        this.tuning.velocityWindowMs,
        this.tuning.maxThrowSpeedPxPerSec
      )
      this.reset()
      return { kind: 'dragEnd', pointer: safePoint, throwVelocity }
    }

    const durationMs = Math.max(0, endTime - this.startTimeMs)
    const displacementPx = distance(
      safePoint.x,
      safePoint.y,
      this.startPoint.x,
      this.startPoint.y
    )
    const isPoke =
      durationMs <= this.tuning.pokeMaxDurationMs &&
      displacementPx < this.tuning.dragThresholdPx
    this.reset()
    return { kind: 'tap', pointer: safePoint, durationMs, displacementPx, isPoke }
  }

  /** 取消（失焦/窗口隐藏/菜单打开等）：清空状态，不产生事件。 */
  cancel(): void {
    this.reset()
  }

  /** 清空内部状态。 */
  private reset(): void {
    this.startPoint = null
    this.startTimeMs = 0
    this.draggingFlag = false
    this.samples = []
  }

  /** 记录采样（裁剪到 ring buffer 上限；时间不单调时直接覆盖最后一项）。 */
  private pushSample(pointer: Point2D, nowMs: number): void {
    const sample: DragSample = { x: pointer.x, y: pointer.y, t: nowMs }
    const last = this.samples[this.samples.length - 1]
    if (last && sample.t < last.t) {
      this.samples[this.samples.length - 1] = sample
      return
    }
    this.samples.push(sample)
    if (this.samples.length > this.tuning.maxSamples) {
      this.samples.splice(0, this.samples.length - this.tuning.maxSamples)
    }
  }
}

/** 正数参数校验（非法/非正 → fallback）。 */
function sanitizePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
}
