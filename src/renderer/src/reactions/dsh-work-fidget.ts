/**
 * DSH 工作小动作调度器（V7 / 2026-11-09 用户决策）—— **纯逻辑**，不 import DOM / three / Electron。
 *
 * ## 背景与决策
 * DSH 桥只提供 `agent/status running|idle`（变化时）、`task/start/end/error`、`session/event`
 * 等事件，**没有稳定的「思考结束」低频信号**；`turn/end` 又已有 dshDone 庆祝，逐轮触发会太密集、
 * 和完成动作撞车。用户决策：在「工作模式（DSH online && running）」下**随机 30–60s 播放一次
 * 一次性技能小动作**（`hsr-skill01` / `hsr-skill02`），参考 Mate-Engine 的 idle/dance 随机切换。
 *
 * ## 行为约定
 * - **工作模式** = `status.online === true && status.running === true`（且 `enabled !== false`）；
 * - 首次进入工作模式 / 每次从非工作模式重新进入：随机 `initialDelayMs`（默认 10–20s）后才有
 *   第一次触发，避免「刚开工就跳舞」；
 * - 到点后：随机返回一个候选 clipId，并排下一次 = **触发时刻 nowMs** + 随机 30–60s
 *   （以触发时刻而非原定时刻为基准，避免长时间阻塞后连续补触发）；
 * - `blocked`（拖拽/摸头/菜单/error 倒地等被 Lead 判定为「不该插播」的时刻）：
 *   **返回 null 且不重置计时**——阻塞结束后仍有原有节奏；若阻塞跨过触发点，则顺延到解除阻塞的
 *   那一帧立即触发一次（不会丢节奏、也不会一次补多个）；
 * - 非 online / 非 running / offline / 未传 status：重置计时，下次进入工作重新随机 initial delay；
 * - 时钟回退 / NaN / 脏输入：静默安全（NaN nowMs 直接忽略本次；回退按上次时钟封顶，不提前触发）；
 * - `enabled: false` 或 `clipIds` 为空：完全不调度（update 恒返回 null）。
 *
 * ## Lead 接线示例（main.ts；本模块不碰渲染/动画）
 * ```ts
 * const fidget = new DshWorkFidget()                      // 或注入 seeded random（单测/复现）
 * // 每帧（拿到最新 DshStatus 与「是否阻塞」判断后）：
 * const clipId = fidget.update({ nowMs, status: dshStatus, blocked })
 * if (clipId !== null) vrmAnimator?.playOneShotClip(clipId, { loop: false, fadeSec: 0.2 })
 * ```
 * `blocked` 建议综合：拖拽中 / 摸头反应中 / 右键菜单打开 / B7 的 dshError 反应未过期 /
 * 调试强制姿态等（由 main.ts 决定，本模块不猜）。
 */
import type { DshStatus } from '@shared/types'

/** 工作模式状态（只取调度需要的两个字段，便于单测直接构造）。 */
export type DshWorkFidgetStatus = Pick<DshStatus, 'online' | 'running'>

/** 默认参数（用户决策：30–60s 一次；首次 10–20s；候选 hsr-skill01/02）。 */
export const DSH_WORK_FIDGET_DEFAULTS = Object.freeze({
  /** 两次触发的最小间隔（ms）。 */
  minIntervalMs: 30_000,
  /** 两次触发的最大间隔（ms）。 */
  maxIntervalMs: 60_000,
  /** 首次/重新进入工作模式后的最小延迟（ms）。 */
  initialDelayMinMs: 10_000,
  /** 首次/重新进入工作模式后的最大延迟（ms）。 */
  initialDelayMaxMs: 20_000,
  /** 候选一次性 clip（app-catalog id；Lead 用 `playOneShotClip(id)` 播放）。 */
  clipIds: Object.freeze(['hsr-skill01', 'hsr-skill02']),
  /** 默认启用（Lead 可用 config 决定是否构造/传递 enabled）。 */
  enabled: true
})

/** 构造参数（全部可选；非法值安全回退默认）。 */
export interface DshWorkFidgetOptions {
  /** `[0,1)` 随机源（默认 `Math.random`；单测注入 seeded RNG 复现）。 */
  random?: () => number
  /** 两次触发的最小间隔（ms；默认 30_000）。 */
  minIntervalMs?: number
  /** 两次触发的最大间隔（ms；默认 60_000；小于 min 时按 min 固定）。 */
  maxIntervalMs?: number
  /**
   * 首次/重新进入工作模式后的延迟：数字 = 固定值，`[min, max]` = 区间随机；
   * 缺省 = 默认 10–20s（{@link DSH_WORK_FIDGET_DEFAULTS}）。
   */
  initialDelayMs?: number | readonly [number, number]
  /** 候选 clip id（默认 `['hsr-skill01','hsr-skill02']`；空数组 = 不触发）。 */
  clipIds?: readonly string[]
  /** false = 完全不调度（默认 true）。 */
  enabled?: boolean
}

/** 每帧输入（时钟与当前 DSH 状态由 Lead 提供）。 */
export interface DshWorkFidgetInput {
  /** 单调时钟毫秒（与 `performance.now()` 同口径）。 */
  nowMs: number
  /** 当前 DSH 状态；null = 未知（按非工作模式处理）。 */
  status: DshWorkFidgetStatus | null
  /** 本帧是否被更高优先级表演阻塞（拖拽/摸头/菜单/error 倒地等；不重置计时）。 */
  blocked: boolean
}

/** 调试快照（挂 `window.__aventurineDebug` / 单测断言用）。 */
export interface DshWorkFidgetSnapshot {
  /** 是否启用调度（构造参数）。 */
  enabled: boolean
  /** 当前是否处于工作模式（上次 update 的结果）。 */
  working: boolean
  /** 上次 update 是否被阻塞（不重置计时）。 */
  blocked: boolean
  /** 距下次触发剩余毫秒（0 = 已到点但被阻塞，等待解除；null = 未排程/不在工作模式）。 */
  nextInMs: number | null
  /** 上次触发时刻（单调时钟 ms；从未触发 null）。 */
  lastFiredAtMs: number | null
  /** 上次返回的 clipId（从未触发 null）。 */
  lastClipId: string | null
  /** 累计触发次数。 */
  firedCount: number
  /** 候选 clip 数（0 = 配置为空，永不触发）。 */
  clipCount: number
}

/** 读取一次随机值并钳制到 `[0, 1)`（防御注入源返回 NaN/越界/抛异常）。 */
function readRandom(random: () => number): number {
  let value: number
  try {
    value = random()
  } catch {
    return 0
  }
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 0.9999999999
  return value
}

/** 闭区间随机整数（ms；min/max 非法时安全回退/交换，不产生 NaN）。 */
function randomInt(random: () => number, min: number, max: number): number {
  const lo = Number.isFinite(min) ? Math.ceil(min) : 0
  const hiRaw = Number.isFinite(max) ? Math.floor(max) : lo
  const hi = hiRaw >= lo ? hiRaw : lo
  if (hi <= lo) return lo
  return lo + Math.floor(readRandom(random) * (hi - lo + 1))
}

/** 正数校验（非法/非正 → fallback）。 */
function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 解析 `initialDelayMs` 选项为 `[min, max]` 区间（非法回退默认 10–20s）。 */
function resolveInitialDelay(
  value: number | readonly [number, number] | undefined
): [number, number] {
  const fallback: [number, number] = [
    DSH_WORK_FIDGET_DEFAULTS.initialDelayMinMs,
    DSH_WORK_FIDGET_DEFAULTS.initialDelayMaxMs
  ]
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return fallback
    return [value, value]
  }
  if (Array.isArray(value) && value.length === 2) {
    const [rawMin, rawMax] = value
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax) || rawMin < 0 || rawMax < 0) {
      return fallback
    }
    return rawMin <= rawMax ? [rawMin, rawMax] : [rawMax, rawMin]
  }
  return fallback
}

/** 清洗候选 clip id：只保留非空字符串并去重（非法 → 默认 hsr-skill01/02）。 */
function sanitizeClipIds(value: readonly string[] | undefined): string[] {
  const source = Array.isArray(value) ? value : DSH_WORK_FIDGET_DEFAULTS.clipIds
  const result: string[] = []
  for (const item of source) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0 || result.includes(trimmed)) continue
    result.push(trimmed)
  }
  return result
}

/**
 * DSH 工作小动作调度器（一个渲染进程一个实例；纯逻辑、确定性可测）。
 *
 * 每次 `update()` 最多返回一个 clipId；调用方负责播放与去重（本模块不碰动画层）。
 * 随机数消耗顺序（seeded 复现依赖）：进入工作模式排 initial delay（1 次）→ 每次触发先选
 * clip（1 次）再排下次间隔（1 次）。
 */
export class DshWorkFidget {
  private readonly random: () => number
  private readonly minIntervalMs: number
  private readonly maxIntervalMs: number
  private readonly initialDelayRange: [number, number]
  private readonly clipIds: string[]
  private readonly enabled: boolean

  /** 下次触发时刻（ms；null = 未排程/不在工作模式）。 */
  private nextFireAtMs: number | null = null
  private lastFiredAtMs: number | null = null
  private lastClipId: string | null = null
  private firedCount = 0
  /** 上次 update 得到的模式状态（快照用）。 */
  private working = false
  private blocked = false
  /** 上次有效时钟（时钟回退保护用；null = 尚未收到有效 update）。 */
  private lastNowMs: number | null = null

  constructor(options: DshWorkFidgetOptions = {}) {
    const input = options ?? {}
    this.random = typeof input.random === 'function' ? input.random : Math.random
    this.minIntervalMs = finitePositive(
      input.minIntervalMs,
      DSH_WORK_FIDGET_DEFAULTS.minIntervalMs
    )
    const rawMax = finitePositive(input.maxIntervalMs, DSH_WORK_FIDGET_DEFAULTS.maxIntervalMs)
    this.maxIntervalMs = rawMax >= this.minIntervalMs ? rawMax : this.minIntervalMs
    this.initialDelayRange = resolveInitialDelay(input.initialDelayMs)
    this.clipIds = sanitizeClipIds(input.clipIds)
    this.enabled = input.enabled !== false
  }

  /**
   * 每帧调用：到达触发点时返回一个一次性 clipId（否则 null）。
   *
   * 语义要点（详见文件头注释）：
   * - 非工作模式 → 重置计时并返回 null；
   * - 工作模式 + blocked → 返回 null 但不重置计时（到点后可顺延到解除阻塞时触发）；
   * - 到点 → 返回随机 clipId 并排下一次（nowMs + 30–60s 随机）；同一帧只触发一次。
   */
  update(input: DshWorkFidgetInput): string | null {
    if (!input || typeof input !== 'object') return null
    const rawNowMs = input.nowMs
    if (!Number.isFinite(rawNowMs)) return null

    // 时钟回退保护：不提前触发，也不重排（封顶到上次时钟）。
    const nowMs =
      this.lastNowMs !== null && rawNowMs < this.lastNowMs ? this.lastNowMs : rawNowMs
    this.lastNowMs = nowMs
    this.blocked = input.blocked === true

    const status = input.status
    const working =
      this.enabled &&
      this.clipIds.length > 0 &&
      !!status &&
      status.online === true &&
      status.running === true

    if (!working) {
      // 非 online / 非 running / 未知状态：重置计时（保留历史触发统计供调试面查看）。
      this.working = false
      this.nextFireAtMs = null
      return null
    }

    if (this.nextFireAtMs === null) {
      // 首次进入工作模式（或每次重新进入）：随机 initial delay，避免刚开工就表演。
      this.working = true
      const delay = randomInt(this.random, this.initialDelayRange[0], this.initialDelayRange[1])
      this.nextFireAtMs = nowMs + delay
      return null
    }

    this.working = true
    // 阻塞中：本次不触发、也不重置计时（到点后可顺延到解除阻塞时）。
    if (this.blocked) return null
    if (nowMs < this.nextFireAtMs) return null

    // 到达触发点：选 clip（避免连续两次相同）→ 以当前时刻为基准排下一次。
    const clipId = this.pickClipId()
    this.lastFiredAtMs = nowMs
    this.lastClipId = clipId
    this.firedCount += 1
    const interval = randomInt(this.random, this.minIntervalMs, this.maxIntervalMs)
    this.nextFireAtMs = nowMs + interval
    return clipId
  }

  /** 清空调度与统计（DSH 离线/关闭联动/Lead 复位时用；之后从 initial delay 重新开始）。 */
  reset(): void {
    this.nextFireAtMs = null
    this.lastFiredAtMs = null
    this.lastClipId = null
    this.firedCount = 0
    this.working = false
    this.blocked = false
    this.lastNowMs = null
  }

  /**
   * 调试快照。
   *
   * @param nowMs 可选当前时钟（传则精确计算 nextInMs；缺省用上次 update 的时钟）
   */
  getSnapshot(nowMs?: number): DshWorkFidgetSnapshot {
    const lastNow = this.lastNowMs
    const reference =
      typeof nowMs === 'number' && Number.isFinite(nowMs)
        ? lastNow !== null
          ? Math.max(nowMs, lastNow)
          : nowMs
        : lastNow
    const nextInMs =
      this.nextFireAtMs === null || reference === null
        ? null
        : Math.max(0, Math.round(this.nextFireAtMs - reference))
    return {
      enabled: this.enabled,
      working: this.working,
      blocked: this.blocked,
      nextInMs,
      lastFiredAtMs: this.lastFiredAtMs,
      lastClipId: this.lastClipId,
      firedCount: this.firedCount,
      clipCount: this.clipIds.length
    }
  }

  /** 随机选一条候选 clip；候选 >1 时保证与上次不同（读取 1 次随机数）。 */
  private pickClipId(): string {
    const count = this.clipIds.length
    let index = Math.min(count - 1, Math.floor(readRandom(this.random) * count))
    if (count > 1 && this.clipIds[index] === this.lastClipId) {
      index = (index + 1) % count
    }
    return this.clipIds[index] as string
  }
}
