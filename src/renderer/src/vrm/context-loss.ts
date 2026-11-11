/**
 * WebGL context 丢失后的页面重载限流（B-02 补强，纯函数 node 可测）。
 *
 * 背景：B-02 让 renderer 在 WebGL context 丢失后延迟 1.5s `window.location.reload()` 恢复；
 * 二次复核指出：若 GPU/上下文持续损坏，每次重载后立刻再次 context lost 会形成无限重载循环
 * （每次都是完整页面重载 + VRM 资源重新加载），因此需要跨 reload 的限流。
 *
 * 设计：
 * - 计数存 `sessionStorage`（同一窗口/标签页跨 reload 保留，关窗即清空，不会污染正常重启）；
 * - 窗口 10 分钟内最多重载 3 次（与 main 进程 crash-recovery 的 10min/3 次口径一致）；
 * - 只有「本次重载已被允许」才写入计数；被限流时**不写**，避免持续丢失把计数越推越长；
 * - 存储不可用/内容损坏一律视为「允许重载」：恢复路径不能因为限流自身故障而失效。
 *
 * 不依赖 DOM：storage 由调用方注入（生产用 `window.sessionStorage`），单测用内存 fake。
 */

/** 重载限流存储最小面（`window.sessionStorage` 结构兼容）。 */
export interface ContextLossReloadStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** sessionStorage 键（带命名空间，避免与其它页面状态冲突）。 */
export const CONTEXT_LOSS_RELOAD_STORAGE_KEY = 'pet:webgl-context-loss-reloads'

/** 时间窗内允许的最大重载次数。 */
export const CONTEXT_LOSS_RELOAD_MAX = 3

/** 限流时间窗（毫秒；10 分钟）。 */
export const CONTEXT_LOSS_RELOAD_WINDOW_MS = 10 * 60_000

/** 读取并清洗历史时间戳（非数组/非有限数/未来时间/窗外时间一律丢弃）。 */
function readTimestamps(storage: ContextLossReloadStorage, nowMs: number): number[] {
  const raw = storage.getItem(CONTEXT_LOSS_RELOAD_STORAGE_KEY)
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const windowStart = nowMs - CONTEXT_LOSS_RELOAD_WINDOW_MS
  const timestamps: number[] = []
  for (const value of parsed) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    // 只保留「窗内且不晚于当前时刻」的时间戳：未来时间戳（时钟回拨/篡改）不参与限流。
    if (value > windowStart && value <= nowMs) timestamps.push(value)
  }
  return timestamps
}

/**
 * 是否允许本次 context-lost 触发的页面重载。
 *
 * @param nowMs 当前时间（`Date.now()`；单测注入）
 * @param storage 跨 reload 计数存储（生产 `window.sessionStorage`）
 * @returns true = 允许重载（已计数）；false = 已达 10 分钟 3 次上限，应跳过本次重载
 */
export function shouldReloadAfterContextLoss(
  nowMs: number,
  storage: ContextLossReloadStorage
): boolean {
  try {
    const timestamps = readTimestamps(storage, nowMs)
    if (timestamps.length >= CONTEXT_LOSS_RELOAD_MAX) return false
    timestamps.push(nowMs)
    storage.setItem(CONTEXT_LOSS_RELOAD_STORAGE_KEY, JSON.stringify(timestamps))
    return true
  } catch {
    // 存储不可用（隐私模式/配额异常）不能阻断恢复路径：放行重载。
    return true
  }
}
