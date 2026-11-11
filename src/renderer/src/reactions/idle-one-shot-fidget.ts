/**
 * 闲时一次性小动作调度器（2026-11-10 用户要求）—— **纯逻辑**，不 import DOM / three / Electron。
 *
 * ## 背景与决策
 * 用户 2026-11-10 要求把 adv 系列里「动作本身不同、且不依赖缺失配件 / 不切镜」的社交/展示动作
 * 接进现有动作系列，方式照 hsr 的 DSH 工作小动作（`dsh-work-fidget.ts`）：**空闲（mood=idle）时
 * 每 2–5 分钟随机播一条一次性动作，播完回 idle**。
 *
 * 候选（2026-11-10 用户两轮确认：动作不同 + “看起来问题不大”的保留）：
 * - 社交单段：`adv-talk01`（3.37s，说话单段）、`adv-talk02`（3.5s）、`adv-bye01`（3.23s，挥手告别）；
 * - 待机展示（一次性）：`adv-idleShow` / `adv-idleShow2`（Idle_Show 01/02，抛硬币等，5.53s）；
 * - 手机/耳机 loop 段（整段播一轮）：`adv-lookAtPhone`（6s）、`adv-watchphone01loop`（6s）、
 *   `adv-useheadphone01loop`（2s）。
 *
 * 明确不接（用户要求）：
 * - 缺大件场景道具的 `build02*` / `forerake02*` / `useprop01/02`（沙堡/耙子等，行为像空手比划）；
 * - `injured01*`（受伤语义负面）、`alert01*`（悬空 0.088m）、`adv-standby2`（一次性战斗待机变体）；
 * - 社交 AS/BS/Hand 过渡段：会停在**半姿态**，留给未来的序列器；
 * - skill 类动作已由 DSH 工作小动作（`dsh-work-fidget.ts`）负责，本模块不重复接。
 *
 * ## 与 DSH 工作小动作互斥
 * 两者都是「一次性动作」调度器，同一帧最多只允许一个 one-shot 触发。互斥由 Lead（main.ts）
 * 协调：DSH 工作小动作命中后，本调度器当帧按 `blocked` 处理。本模块自身不 import、不感知 DSH。
 *
 * ## 行为约定
 * - **空闲** = `idle === true` 且 `enabled !== false` 且候选非空；
 * - 首次进入 / 每次从非空闲重新进入空闲：随机 `initialDelayMs`（默认 40–90s）后才有第一次触发，
 *   避免「刚回 idle 就表演」；
 * - 到点后：随机返回一个候选 clipId（候选 >1 时避免连续两次相同），并排下一次 = **触发时刻
 *   nowMs** + 随机 120–300s（以触发时刻为基准，避免长时间阻塞后连续补触发）；
 * - `blocked`（拖拽/菜单/DSH 反应/pat/drag/sleep/已有一次性动作在播等）：**返回 null 且不重置
 *   计时**——阻塞结束后仍有原有节奏；若阻塞跨过触发点，则顺延到解除阻塞的那一帧立即触发一次；
 * - 非空闲（`idle !== true`）：**重置计时**，下次重新进入空闲重新随机 initial delay；
 * - `enabled: false` 或 `clipIds` 为空：完全不调度（update 恒返回 null）；
 * - 时钟回退 / NaN / 脏输入：静默安全（NaN nowMs 直接忽略本次；回退按上次时钟封顶，不提前触发）。
 *
 * ## Lead 接线示例（main.ts；本模块不碰渲染/动画）
 * ```ts
 * const fidget = new IdleOneShotFidget()          // 或注入 seeded random（单测/复现）
 * // 每帧（拿到 mood 与「是否阻塞」判断后）：
 * const clipId = fidget.update({ nowMs, idle: mood === 'idle', blocked })
 * if (clipId !== null) vrmAnimator?.playOneShotClip(clipId, { loop: false, fadeSec: 0.25 })
 * ```
 * `blocked` 建议综合：拖拽中 / 摸头反应中 / 右键菜单打开 / DSH 反应未过期 / 已有一次性或手动
 * clip 在播 / 同一帧 DSH 工作小动作已触发（由 main.ts 决定，本模块不猜）。
 */

/** 默认参数（用户决策：2–5 分钟一次；首次 40–90s；候选见 clipIds：社交单段 + 抛硬币展示 + 手机/耳机 loop 段）。 */
export const IDLE_ONE_SHOT_FIDGET_DEFAULTS = Object.freeze({
  /** 两次触发的最小间隔（ms）。 */
  minIntervalMs: 120_000,
  /** 两次触发的最大间隔（ms）。 */
  maxIntervalMs: 300_000,
  /** 首次/重新进入空闲后的最小延迟（ms）。 */
  initialDelayMinMs: 40_000,
  /** 首次/重新进入空闲后的最大延迟（ms）。 */
  initialDelayMaxMs: 90_000,
  /** 候选一次性 clip（app-catalog id；Lead 用 `playOneShotClip(id)` 播放）。 */
  clipIds: Object.freeze([
    'adv-talk01',
    'adv-talk02',
    'adv-bye01',
    'adv-idleShow',
    'adv-idleShow2',
    'adv-lookAtPhone',
    'adv-watchphone01loop',
    'adv-useheadphone01loop'
  ]),
  /** 默认启用（Lead 可用 config 决定是否构造/传递 enabled）。 */
  enabled: true
})

/** 构造参数（全部可选；非法值安全回退默认）。 */
export interface IdleOneShotFidgetOptions {
  /** `[0,1)` 随机源（默认 `Math.random`；单测注入 seeded RNG 复现）。 */
  random?: () => number
  /** 两次触发的最小间隔（ms；默认 120_000）。 */
  minIntervalMs?: number
  /** 两次触发的最大间隔（ms；默认 300_000；小于 min 时按 min 固定）。 */
  maxIntervalMs?: number
  /**
   * 首次/重新进入空闲后的延迟：数字 = 固定值，`[min, max]` = 区间随机；
   * 缺省 = 默认 40–90s（{@link IDLE_ONE_SHOT_FIDGET_DEFAULTS}）。
   */
  initialDelayMs?: number | readonly [number, number]
  /** 候选 clip id（默认见 {@link IDLE_ONE_SHOT_FIDGET_DEFAULTS.clipIds}；空数组 = 不触发）。 */
  clipIds?: readonly string[]
  /** false = 完全不调度（默认 true）。 */
  enabled?: boolean
}

/** 每帧输入（时钟与当前空闲/阻塞状态由 Lead 提供）。 */
export interface IdleOneShotFidgetInput {
  /** 单调时钟毫秒（与 `performance.now()` 同口径）。 */
  nowMs: number
  /** 当前是否空闲（mood=idle；false = 计时重置）。 */
  idle: boolean
  /** 本帧是否被更高优先级表演阻塞（拖拽/菜单/DSH 反应/已有一次性动作等；不重置计时）。 */
  blocked: boolean
}

/** 调试快照（挂 `window.__aventurineDebug` / 单测断言用）。 */
export interface IdleOneShotFidgetSnapshot {
  /** 是否启用调度（构造参数）。 */
  enabled: boolean
  /** 当前是否处于空闲调度（上次 update 的结果）。 */
  idle: boolean
  /** 上次 update 是否被阻塞（不重置计时）。 */
  blocked: boolean
  /** 距下次触发剩余毫秒（0 = 已到点但被阻塞，等待解除；null = 未排程/非空闲）。 */
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

/** 解析 `initialDelayMs` 选项为 `[min, max]` 区间（非法回退默认 40–90s）。 */
function resolveInitialDelay(
  value: number | readonly [number, number] | undefined
): [number, number] {
  const fallback: [number, number] = [
    IDLE_ONE_SHOT_FIDGET_DEFAULTS.initialDelayMinMs,
    IDLE_ONE_SHOT_FIDGET_DEFAULTS.initialDelayMaxMs
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

/** 清洗候选 clip id：只保留非空字符串并去重（非法 → 默认 adv-talk01/talk02/bye01）。 */
function sanitizeClipIds(value: readonly string[] | undefined): string[] {
  const source = Array.isArray(value) ? value : IDLE_ONE_SHOT_FIDGET_DEFAULTS.clipIds
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
 * 闲时一次性小动作调度器（一个渲染进程一个实例；纯逻辑、确定性可测）。
 *
 * 每次 `update()` 最多返回一个 clipId；调用方负责播放与去重（本模块不碰动画层）。
 * 随机数消耗顺序（seeded 复现依赖）：进入空闲排 initial delay（1 次）→ 每次触发先选
 * clip（1 次）再排下次间隔（1 次）。
 */
export class IdleOneShotFidget {
  private readonly random: () => number
  private readonly minIntervalMs: number
  private readonly maxIntervalMs: number
  private readonly initialDelayRange: [number, number]
  private readonly clipIds: string[]
  private readonly enabled: boolean

  /** 下次触发时刻（ms；null = 未排程/非空闲）。 */
  private nextFireAtMs: number | null = null
  private lastFiredAtMs: number | null = null
  private lastClipId: string | null = null
  private firedCount = 0
  /** 上次 update 得到的空闲状态（快照用）。 */
  private idle = false
  private blocked = false
  /** 上次有效时钟（时钟回退保护用；null = 尚未收到有效 update）。 */
  private lastNowMs: number | null = null

  constructor(options: IdleOneShotFidgetOptions = {}) {
    const input = options ?? {}
    this.random = typeof input.random === 'function' ? input.random : Math.random
    this.minIntervalMs = finitePositive(
      input.minIntervalMs,
      IDLE_ONE_SHOT_FIDGET_DEFAULTS.minIntervalMs
    )
    const rawMax = finitePositive(input.maxIntervalMs, IDLE_ONE_SHOT_FIDGET_DEFAULTS.maxIntervalMs)
    this.maxIntervalMs = rawMax >= this.minIntervalMs ? rawMax : this.minIntervalMs
    this.initialDelayRange = resolveInitialDelay(input.initialDelayMs)
    this.clipIds = sanitizeClipIds(input.clipIds)
    this.enabled = input.enabled !== false
  }

  /**
   * 每帧调用：到达触发点时返回一个一次性 clipId（否则 null）。
   *
   * 语义要点（详见文件头注释）：
   * - 非空闲 / 关闭 / 无候选 → 重置计时并返回 null；
   * - 空闲 + blocked → 返回 null 但不重置计时（到点后可顺延到解除阻塞时触发）；
   * - 到点 → 返回随机 clipId 并排下一次（nowMs + 120–300s 随机）；同一帧只触发一次。
   */
  update(input: IdleOneShotFidgetInput): string | null {
    if (!input || typeof input !== 'object') return null
    const rawNowMs = input.nowMs
    if (!Number.isFinite(rawNowMs)) return null

    // 时钟回退保护：不提前触发，也不重排（封顶到上次时钟）。
    const nowMs =
      this.lastNowMs !== null && rawNowMs < this.lastNowMs ? this.lastNowMs : rawNowMs
    this.lastNowMs = nowMs
    this.blocked = input.blocked === true

    const scheduling = this.enabled && this.clipIds.length > 0
    if (!scheduling || input.idle !== true) {
      // 非空闲 / 关闭 / 无候选：重置计时（保留历史触发统计供调试面查看）。
      this.idle = false
      this.nextFireAtMs = null
      return null
    }

    if (this.nextFireAtMs === null) {
      // 首次进入空闲（或每次重新进入）：随机 initial delay，避免刚回 idle 就表演。
      this.idle = true
      const delay = randomInt(this.random, this.initialDelayRange[0], this.initialDelayRange[1])
      this.nextFireAtMs = nowMs + delay
      return null
    }

    this.idle = true
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

  /** 清空调度与统计（Lead 复位/关闭联动时用；之后从 initial delay 重新开始）。 */
  reset(): void {
    this.nextFireAtMs = null
    this.lastFiredAtMs = null
    this.lastClipId = null
    this.firedCount = 0
    this.idle = false
    this.blocked = false
    this.lastNowMs = null
  }

  /**
   * 调试快照。
   *
   * @param nowMs 可选当前时钟（传则精确计算 nextInMs；缺省用上次 update 的时钟）
   */
  getSnapshot(nowMs?: number): IdleOneShotFidgetSnapshot {
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
      idle: this.idle,
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
