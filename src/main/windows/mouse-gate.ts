/**
 * 点击穿透（ignore-mouse）状态机 —— 纯函数（Wave 1 A1）
 *
 * **不得 import electron**：状态机只做布尔状态与延迟调度，真正的
 * `win.setIgnoreMouseEvents(...)` 由调用方通过 `apply` 注入，因此可在 vitest node 环境单测。
 *
 * 为什么需要「单帧延迟保护」（PLAN §5-A1 / §17.5 P1-10；Electron 官方
 * Custom Window Interactions 的 forward 模式）：
 * - overlay 平时整体穿透（ignore=true + forward），renderer 靠 mousemove 做命中检测；
 * - 命中宠物时切回拦截（ignore=false），以接收 click / mouseup；
 * - **从拦截切回穿透如果立即生效，正在进行的 mouseup 会丢给下层应用**（桌宠"吞点击"）；
 *   因此 拦截 → 穿透 延迟约一帧（16ms @60Hz）再应用；
 * - **穿透 → 拦截必须立即生效**：命中检测需要马上接管鼠标，否则第一下点击穿到下层。
 *
 * 合并规则：同一窗口连续快速 toggle 时，以最后一次请求为准；同一目标值重复请求幂等。
 */
/** 一帧延迟（约 60Hz 的 16ms），拦截 → 穿透生效前的保护期。 */
export const IGNORE_MOUSE_FRAME_MS = 16

/** 状态机选项（全部可注入，便于测试）。 */
export interface IgnoreMouseGateOptions {
  /**
   * 状态真正变化时的回调（调用方在这里执行 Electron `win.setIgnoreMouseEvents`）。
   * 纯模块不直接依赖 electron。
   */
  apply?: (ignore: boolean) => void
  /**
   * 延迟调度器：默认 `setTimeout(fn, frameMs)`。
   * 调度器无需返回取消句柄：过期调度由内部 seq 丢弃（测试可注入收集器）。
   */
  schedule?: (fn: () => void) => void
  /** 延迟时长（毫秒），默认 {@link IGNORE_MOUSE_FRAME_MS}（一帧）。 */
  frameMs?: number
}

/** 单个窗口的穿透状态机。 */
export interface IgnoreMouseGate {
  /**
   * 请求切换到目标状态。
   * @returns 目标状态是否**已经生效**：
   *   - `true`：立即生效（拦截）或当前已是目标值（幂等）；
   *   - `false`：已排入下一帧（仅 拦截 → 穿透 的延迟路径）。
   */
  request(ignore: boolean): boolean
  /** 立即应用排队中的状态（窗口即将隐藏 / 销毁等场景强制落地）。 */
  flush(): void
  /** 最近一次已生效的状态；尚未应用过任何状态时为 `null`。 */
  current(): boolean | null
  /** 排队中、尚未生效的目标状态；无排队时为 `null`。 */
  pending(): boolean | null
  /** 丢弃排队中的状态并停止后续调度（窗口销毁时调用；幂等）。 */
  dispose(): void
}

/**
 * 创建单窗口穿透状态机。
 *
 * 初始状态为 `null`（未知）：
 * - 第一次 `request(false)` → 立即拦截；
 * - 第一次 `request(true)` → 按「拦截 → 穿透」保守延迟一帧（窗口初始是否拦截未知，
 *   延迟是无害的；避免极端情况下丢掉 mouseup）。
 */
export function createIgnoreMouseGate(options: IgnoreMouseGateOptions = {}): IgnoreMouseGate {
  const frameMs = Math.max(0, options.frameMs ?? IGNORE_MOUSE_FRAME_MS)
  const schedule: (fn: () => void) => void =
    options.schedule ??
    ((fn: () => void): void => {
      // 全局 setTimeout：便于测试用 vi.useFakeTimers() 精确控制一帧
      setTimeout(fn, frameMs)
    })
  const apply = options.apply

  /** 最近一次已生效状态（null = 未知） */
  let applied: boolean | null = null
  /** 是否有「穿透」请求排队等待下一帧生效（本状态机只会延迟 true） */
  let pendingScheduled = false
  /** 当前有效调度的序号：过期调度在执行时通过序号比对丢弃 */
  let scheduledSeq = 0
  /** 单调递增的调度序号（从 1 开始） */
  let sequence = 0
  /** dispose 后不再应用任何状态 */
  let disposed = false

  /** 真正落地状态（仅在状态变化时调用 apply）。 */
  function settle(value: boolean): void {
    applied = value
    apply?.(value)
  }

  /** 作废排队中的延迟应用（不取消底层定时器，靠序号比对丢弃）。 */
  function cancelPending(): void {
    pendingScheduled = false
    scheduledSeq = 0
  }

  /** 当前已生效状态是否等于目标值（helper 形式避免 TS 对 `applied` 做跨分支收窄）。 */
  function isSettled(target: boolean): boolean {
    return applied === target
  }

  function request(ignore: boolean): boolean {
    const target = ignore === true
    if (disposed) return isSettled(target)

    if (target) {
      // 穿透：已生效 → 幂等；已排队 → 合并（不重复调度）
      if (isSettled(true)) return true
      if (pendingScheduled) return false
      // 「拦截 → 穿透」延迟一帧，避免正在进行的 mouseup 丢给下层应用
      pendingScheduled = true
      const seq = ++sequence
      scheduledSeq = seq
      schedule(() => {
        // 被后续请求（重新拦截 / flush / 新调度）作废的旧任务直接丢弃
        if (seq !== scheduledSeq) return
        pendingScheduled = false
        scheduledSeq = 0
        settle(true)
      })
      // 通常为 false（延迟中）；同步调度器（测试注入）可能已生效
      return isSettled(true)
    }

    // 拦截：立即生效（命中检测需要马上接管鼠标）；并作废排队中的穿透请求，
    // 避免「已重新悬停 → 一帧后又被切回穿透」导致 mouseup 丢失。
    cancelPending()
    if (isSettled(false)) return true
    settle(false)
    return true
  }

  function flush(): void {
    if (disposed || !pendingScheduled) return
    cancelPending()
    settle(true)
  }

  function current(): boolean | null {
    return applied
  }

  function pending(): boolean | null {
    return pendingScheduled ? true : null
  }

  function dispose(): void {
    disposed = true
    cancelPending()
  }

  return { request, flush, current, pending, dispose }
}
