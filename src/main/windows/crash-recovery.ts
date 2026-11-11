/**
 * 生产态 renderer 崩溃 / 无响应恢复策略（R-05）
 *
 * 背景（`docs/code-review-2026-11-10.md` R-05，复核定级 P2）：
 * - 修复前只有 `PET_SMOKE_TEST=1` 的冒烟守护挂 `render-process-gone`（只断言、不恢复），
 *   正常桌面运行中 WebGL renderer 崩溃后窗口永久空白：托盘还在、app 还在跑，宠物消失；
 * - `gpu-process-crashed` 在 Electron 44 已弃用 → 改用 `app.on('child-process-gone')`；
 * - `unresponsive` 全仓无处理：主线程卡死时窗口同样永久无响应。
 *
 * 本模块只做**纯策略**（不 import electron / node:fs）：时钟、定时器、重载函数全部可注入，
 * 单测用假时钟覆盖限流 / 冷却 / 去重边界（`tests/main-crash-recovery.test.ts`）。
 * 真实 Electron 接线在 `src/main/index.ts`：
 * - `hardenWebContents()` 为每个 overlay 挂 `render-process-gone` / `unresponsive` / `responsive`；
 * - `bootstrap()` 在 `app.on('child-process-gone')` 里对 GPU 崩溃调用 `handleGpuProcessGone()`。
 *
 * 策略（全部按 `webContents.id` 隔离，Map 容量有界）：
 * 1. `render-process-gone`：`reason === 'clean-exit'`（窗口正常销毁）不恢复；
 *    其余 reason（crashed / oom / killed / abnormal-exit / launch-failed / integrity-failure /
 *    memory-eviction）→ 计一次限流后 reload；
 * 2. `unresponsive`：延迟 `unresponsiveDelayMs`（5s），期间收到 `responsive` 则取消；
 *    超时仍无响应 → 检查该窗口 5 分钟冷却后 reload；
 * 3. GPU（`child-process-gone` 的 `type === 'GPU'`）：延迟 `gpuRecoveryDelayMs`（1s），
 *    对**调用时存活**的窗口各触发一次限流 reload（GPU 重建后 overlay 常为白屏，需重画）；
 * 4. 限流：同一窗口 10 分钟内最多 `maxReloads`（3）次 reload；超出只记 error 等后续事件，
 *    避免「崩溃 → reload → 再崩溃」把 CPU 打满；
 * 5. 容量：最多跟踪 `maxTrackedTargets`（16）个 webContents；超出按 Map 插入序淘汰最旧条目
 *    （被淘汰窗口下次事件重新获得预算 —— 内存有界优先于绝对精确计数）；
 * 6. `PET_SMOKE_TEST` 下**不挂本策略**（由调用方跳过）：冒烟守护需要 crash 立即 SMOKE_FAIL，
 *    恢复 reload 会干扰 smoke 的加载 watchdog / 退出码。冒烟测试里的 `render-process-gone`
 *    仍由 `attachSmokeWindowGuards()` 负责。
 */

/** 恢复策略参数（测试可注入部分覆盖）。 */
export interface CrashRecoveryPolicy {
  /** 限流窗口：同一 webContents 在该时间窗内最多 reload `maxReloads` 次。 */
  reloadWindowMs: number
  /** 限流窗口内允许的最大 reload 次数。 */
  maxReloads: number
  /** `unresponsive` 后等待多久（期间无 `responsive`）才 reload。 */
  unresponsiveDelayMs: number
  /** `unresponsive` 触发的 reload 冷却（同一窗口，避免反复卡死时连续重载）。 */
  unresponsiveCooldownMs: number
  /** GPU 进程崩溃后延迟多久再触发 overlay reload（给 Chromium 留重建时间）。 */
  gpuRecoveryDelayMs: number
  /**
   * GPU 波去重窗口：GPU 计时器到点时，若同一 webContents 在该窗口内已因 renderer 崩溃
   * 恢复过（同一事故），跳过重复 reload（不重复扣限流预算）。
   * 必须 **大于** `gpuRecoveryDelayMs`，否则永远命不中。
   */
  incidentDedupeMs: number
  /** 最多跟踪的 webContents 数量（Map 容量上界）。 */
  maxTrackedTargets: number
}

/** 冻结默认策略（与 R-05 修复约定一致：10 分钟 3 次 / 5s 等待 / 5 分钟冷却 / 1s GPU 延迟）。 */
export const CRASH_RECOVERY_POLICY: Readonly<CrashRecoveryPolicy> = Object.freeze({
  reloadWindowMs: 10 * 60_000,
  maxReloads: 3,
  unresponsiveDelayMs: 5_000,
  unresponsiveCooldownMs: 5 * 60_000,
  gpuRecoveryDelayMs: 1_000,
  incidentDedupeMs: 2_000,
  maxTrackedTargets: 16
})

/**
 * 恢复策略需要的 webContents 最小面。
 * Electron `WebContents` 结构兼容（`id` / `isDestroyed()` / `reload()`），
 * 因此接线时可直接传 `win.webContents`，单测传假对象即可，无需 mock electron。
 */
export interface CrashRecoveryTarget {
  readonly id: number
  isDestroyed(): boolean
  reload(): void
}

/** 日志最小面（与 `src/main/logger.ts` 的 Logger 结构兼容；info 可选）。 */
export interface CrashRecoveryLogger {
  info?(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

/** 可注入定时器（默认 globalThis；单测用假时钟）。 */
export interface CrashRecoveryTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** `createCrashRecovery` 选项。 */
export interface CrashRecoveryOptions {
  /** 时间源（默认 `Date.now`；单测注入假时钟）。 */
  now?: () => number
  /** 日志接收器（可选；未注入时静默，仅在测试/极简路径出现）。 */
  logger?: CrashRecoveryLogger
  /** 定时器（默认 globalThis；单测注入假时钟）。 */
  timers?: CrashRecoveryTimers
  /** 覆盖默认策略的部分字段。 */
  policy?: Partial<CrashRecoveryPolicy>
}

/** 恢复动作来源（只用于日志可读性）。 */
export type CrashRecoveryReason = 'render-process-gone' | 'unresponsive' | 'gpu-process-gone'

/** 恢复策略实例（`src/main/index.ts` 进程内创建一次）。 */
export interface CrashRecovery {
  /**
   * 处理 `webContents.on('render-process-gone')`。
   * @returns 是否真的触发了 reload（clean-exit / 已销毁 / 限流超限时为 false）
   */
  handleRenderProcessGone(
    target: CrashRecoveryTarget,
    details: { reason?: string } | null | undefined
  ): boolean
  /**
   * 处理 `webContents.on('unresponsive')`：延迟后仍无 `responsive` 才 reload。
   * @returns 是否成功排入延迟检查（重复事件去重 / 已销毁时为 false）
   */
  handleUnresponsive(target: CrashRecoveryTarget): boolean
  /** 处理 `webContents.on('responsive')`：取消尚未触发的 unresponsive 恢复。 */
  handleResponsive(target: CrashRecoveryTarget): void
  /**
   * 处理 GPU 进程崩溃（`app.on('child-process-gone')` 中 `type === 'GPU'`）：
   * 延迟 `gpuRecoveryDelayMs` 后对调用时传入的存活窗口各触发一次限流 reload。
   * 同一波崩溃只排一个定时器（去重）；`reason === 'clean-exit'`（正常退出）不恢复；
   * 同波内已因 renderer 崩溃恢复过的窗口按 `incidentDedupeMs` 跳过，避免重复 reload。
   */
  handleGpuProcessGone(
    targets: readonly CrashRecoveryTarget[],
    details?: { reason?: string } | null
  ): void
  /** 清理全部定时器与状态（app 退出；幂等）。 */
  dispose(): void
  /** 当前跟踪的 webContents 数量（≤ `maxTrackedTargets`；排障 / 测试断言）。 */
  readonly trackedCount: number
}

/** 默认定时器实现（node / Electron 主进程均可用）。 */
const DEFAULT_TIMERS: CrashRecoveryTimers = {
  setTimeout(callback: () => void, ms: number): unknown {
    return globalThis.setTimeout(callback, ms)
  },
  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }
}

/** 单个 webContents 的恢复状态。 */
interface TargetState {
  /** 限流窗口内的 reload 时间戳（毫秒，按注入时钟）。 */
  reloads: number[]
  /** 尚未触发的 unresponsive 延迟定时器句柄（null = 无）。 */
  unresponsiveTimer: unknown
  /** 最近一次由 unresponsive 触发的 reload 时间（5 分钟冷却用；null = 从未）。 */
  lastUnresponsiveReloadAt: number | null
  /** 最近一次成功 reload 的时间（GPU 波去重用；null = 从未）。 */
  lastReloadAt: number | null
}

/**
 * 创建恢复策略实例（进程内单例；测试每次新建）。
 *
 * 所有方法都不抛异常：reload 失败只记 error（窗口可能在检查后恰好销毁），
 * 崩溃恢复路径本身绝不能再成为 uncaughtException 来源。
 */
export function createCrashRecovery(options: CrashRecoveryOptions = {}): CrashRecovery {
  const now = options.now ?? ((): number => Date.now())
  const logger = options.logger
  const timers = options.timers ?? DEFAULT_TIMERS
  const policy: CrashRecoveryPolicy = { ...CRASH_RECOVERY_POLICY, ...options.policy }

  const states = new Map<number, TargetState>()
  /** GPU 恢复定时器（同一波只排一个；null = 无）。 */
  let gpuTimer: unknown = null
  let disposed = false

  /** 清掉单个目标的 unresponsive 定时器（保留限流历史）。 */
  function clearUnresponsiveTimer(state: TargetState): void {
    if (state.unresponsiveTimer === null) return
    timers.clearTimeout(state.unresponsiveTimer)
    state.unresponsiveTimer = null
  }

  /** 丢弃限流窗口外的旧时间戳（只保留「最近 10 分钟」）。 */
  function pruneReloads(state: TargetState, at: number): void {
    state.reloads = state.reloads.filter((timestamp) => at - timestamp < policy.reloadWindowMs)
  }

  /** 容量淘汰：按 Map 插入序丢掉最旧、且不是本次要保留的条目。 */
  function evictOldest(keepId: number): void {
    for (const [id, state] of states) {
      if (id === keepId) continue
      clearUnresponsiveTimer(state)
      states.delete(id)
      return
    }
  }

  /** 取（或惰性创建）目标状态；超过容量时淘汰最旧条目，保证 Map 有界。 */
  function getState(id: number): TargetState {
    const existing = states.get(id)
    if (existing) return existing
    const state: TargetState = {
      reloads: [],
      unresponsiveTimer: null,
      lastUnresponsiveReloadAt: null,
      lastReloadAt: null
    }
    states.set(id, state)
    if (states.size > policy.maxTrackedTargets) evictOldest(id)
    return state
  }

  /**
   * 限流判定 + 执行 reload。
   * @returns 是否已发起 reload（销毁 / 超限 / reload 抛错时为 false）
   */
  function tryReload(
    target: CrashRecoveryTarget,
    state: TargetState,
    at: number,
    reason: CrashRecoveryReason
  ): boolean {
    if (disposed || target.isDestroyed()) return false
    pruneReloads(state, at)
    if (state.reloads.length >= policy.maxReloads) {
      logger?.error(
        `[crash] ${reason}: reload budget exhausted ` +
          `(${policy.maxReloads} per ${policy.reloadWindowMs}ms) for webContents ${target.id}; ` +
          `leaving window for user/tray action`
      )
      return false
    }
    // 任一来源真正 reload 时，作废该目标 pending 的 unresponsive 延迟检查：避免同一次事故
    // 在 5s 后再被 unresponsive 路径二次 reload（重复扣预算/重复加载资源）。
    clearUnresponsiveTimer(state)
    state.reloads.push(at)
    try {
      // 先记录再 reload：即使 reload 同步抛错也占用预算，避免异常路径下无限重试。
      target.reload()
    } catch (error) {
      logger?.error(`[crash] ${reason}: reload failed for webContents ${target.id}`, error)
      return false
    }
    state.lastReloadAt = at
    logger?.warn(
      `[crash] ${reason}: reloaded webContents ${target.id} ` +
        `(${state.reloads.length}/${policy.maxReloads} in current window)`
    )
    return true
  }

  function handleRenderProcessGone(
    target: CrashRecoveryTarget,
    details: { reason?: string } | null | undefined
  ): boolean {
    if (disposed || !target || target.isDestroyed()) return false
    const reason = details?.reason ?? 'unknown'
    if (reason === 'clean-exit') {
      // 正常销毁（窗口关闭 / reload 自身）不恢复，否则会与显隐/重建流程打架。
      logger?.info?.(`[crash] render-process-gone: clean-exit for webContents ${target.id}; no reload`)
      return false
    }
    logger?.error(
      `[crash] render-process-gone: reason=${reason} for webContents ${target.id}; attempting recovery`
    )
    return tryReload(target, getState(target.id), now(), 'render-process-gone')
  }

  function handleUnresponsive(target: CrashRecoveryTarget): boolean {
    if (disposed || !target || target.isDestroyed()) return false
    const state = getState(target.id)
    // 已有一个待触发的延迟检查：合并（避免卡死期间事件刷屏排队多次 reload）。
    if (state.unresponsiveTimer !== null) return false
    logger?.warn(
      `[crash] unresponsive: webContents ${target.id}; waiting ${policy.unresponsiveDelayMs}ms ` +
        `for a 'responsive' event before reloading`
    )
    state.unresponsiveTimer = timers.setTimeout(() => {
      state.unresponsiveTimer = null
      if (disposed || target.isDestroyed()) return
      const at = now()
      if (
        state.lastUnresponsiveReloadAt !== null &&
        at - state.lastUnresponsiveReloadAt < policy.unresponsiveCooldownMs
      ) {
        logger?.warn(
          `[crash] unresponsive: cooldown active for webContents ${target.id} ` +
            `(${policy.unresponsiveCooldownMs}ms); skip reload`
        )
        return
      }
      if (!tryReload(target, state, at, 'unresponsive')) return
      state.lastUnresponsiveReloadAt = at
    }, policy.unresponsiveDelayMs)
    return true
  }

  function handleResponsive(target: CrashRecoveryTarget): void {
    if (disposed || !target) return
    const state = states.get(target.id)
    if (!state || state.unresponsiveTimer === null) return
    clearUnresponsiveTimer(state)
    logger?.info?.(`[crash] responsive: webContents ${target.id} recovered; cancel pending reload`)
  }

  function handleGpuProcessGone(
    targets: readonly CrashRecoveryTarget[],
    details?: { reason?: string } | null
  ): void {
    if (disposed) return
    // GPU 进程正常退出（如 Chromium 重建 GPU 进程/关闭 GPU）不需要 reload overlay。
    const reason = details?.reason ?? 'unknown'
    if (reason === 'clean-exit') {
      logger?.info?.('[crash] gpu-process-gone: clean-exit; skip recovery reload')
      return
    }
    // 同一波 GPU 崩溃（1s 内可能多次）只排一个定时器。
    if (gpuTimer !== null) return
    const alive = (targets ?? []).filter((target) => target && !target.isDestroyed())
    if (alive.length === 0) return
    logger?.warn(
      `[crash] gpu-process-gone: scheduling recovery reload in ${policy.gpuRecoveryDelayMs}ms ` +
        `for ${alive.length} overlay window(s)`
    )
    gpuTimer = timers.setTimeout(() => {
      gpuTimer = null
      if (disposed) return
      let reloaded = 0
      let skipped = 0
      for (const target of alive) {
        if (!target || target.isDestroyed()) continue
        const at = now()
        const state = getState(target.id)
        // 同一事故去重：GPU 崩溃常伴随 renderer 崩溃，renderer 侧已 reload 过（且刚发生
        // < incidentDedupeMs）就不再重复 reload/重复扣预算。
        if (state.lastReloadAt !== null && at - state.lastReloadAt < policy.incidentDedupeMs) {
          skipped += 1
          continue
        }
        if (tryReload(target, state, at, 'gpu-process-gone')) reloaded += 1
      }
      logger?.warn(
        `[crash] gpu-process-gone: recovery finished ` +
          `(${reloaded}/${alive.length} window(s) reloaded, ${skipped} recent reload(s) skipped)`
      )
    }, policy.gpuRecoveryDelayMs)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    if (gpuTimer !== null) {
      timers.clearTimeout(gpuTimer)
      gpuTimer = null
    }
    for (const state of states.values()) clearUnresponsiveTimer(state)
    states.clear()
  }

  return {
    handleRenderProcessGone,
    handleUnresponsive,
    handleResponsive,
    handleGpuProcessGone,
    dispose,
    get trackedCount(): number {
      return states.size
    }
  }
}
