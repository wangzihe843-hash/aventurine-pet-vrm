/**
 * B5 桌面感知 —— 窗口过滤（纯函数，无 DOM / Electron / node 内置依赖）。
 *
 * 过滤规则（PLAN §11「窗口吸附」）：
 *   `layer === 0`（普通应用窗口；菜单栏 / Dock / 面板等系统窗口 layer > 0）、
 *   `alpha > 0.01`、`height > 80`、`onScreen === true`；
 * 额外排除：
 *   - 宠物自身进程窗口（`ownPid`）与已知 overlay 窗口 id（`overlayWindowIds`，第二保险；
 *     overlay 的 layer=1000 通常已被 layer 规则过滤）；
 *   - 与当前 overlay 所在显示器 `display.bounds` 无交集的窗口（多屏：每个 overlay 只感知自己屏）；
 *   - 结构非法（字段缺失 / NaN / 零负尺寸）的项。
 *
 * `sanitizeWindows` 是消费侧防御：主进程 A4 已严格校验，但 `windows-updated` payload 来自
 * 主进程转发，renderer 仍应保证「脏输入不抛、不产生 NaN 表面」。工具窗口/系统窗口通过
 * layer + 最小高度 + 最小 alpha 规则自然过滤，不维护应用白/黑名单。
 */
import type { Rect, WindowInfo } from '@shared/types'

import { isFiniteNumber, isValidRect, rectsIntersect, sanitizeRect } from './geometry'

/** 普通应用窗口的 CGWindowLayer（桌面感知只消费这一层）。 */
export const NORMAL_WINDOW_LAYER = 0

/** 吸附窗口最小高度（px）：低于此值的工具条/小面板不作为站立面。 */
export const MIN_WINDOW_HEIGHT_PX = 80

/** 吸附窗口最小不透明度（严格大于该值才可见）。 */
export const MIN_WINDOW_ALPHA = 0.01

/** `isEligibleWindow` / `filterWindows` 的选项。 */
export interface WindowFilterOptions {
  /** 宠物自身进程 pid（overlay 窗口所属进程），命中即排除。 */
  ownPid?: number
  /** 已知的宠物 overlay 窗口 id（ownPid 之外的第二保险）。 */
  overlayWindowIds?: readonly number[]
  /** 当前 overlay 所在显示器的全局 bounds；提供时只保留与其有交集的窗口。 */
  displayBounds?: Rect | null
  /** 最小窗口高度（px），默认 {@link MIN_WINDOW_HEIGHT_PX}。 */
  minHeightPx?: number
  /** 最小 alpha（严格大于），默认 {@link MIN_WINDOW_ALPHA}。 */
  minAlpha?: number
  /** 必需 layer，默认 {@link NORMAL_WINDOW_LAYER}。 */
  requiredLayer?: number
}

/**
 * 把 `pet:windows` / `windows-updated` 的原始 payload 归一化为合法 `WindowInfo[]`：
 * - 非数组 / 数组项非对象 / 字段类型不对 / bounds 非有限数 / 宽高 <= 0 → 丢弃该项；
 * - id 重复时保留第一项（CGWindowList 理论上不会重复，防御 fake 输入）；
 * - 顺序原样保留（CGWindowList 前→后，z 序有意义，不能排序）。
 */
export function sanitizeWindows(input: unknown): WindowInfo[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<number>()
  const windows: WindowInfo[] = []
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Partial<WindowInfo>
    if (!isFiniteNumber(raw.id) || !Number.isInteger(raw.id)) continue
    if (!isFiniteNumber(raw.pid) || !Number.isInteger(raw.pid)) continue
    if (typeof raw.owner !== 'string') continue
    if (!isFiniteNumber(raw.layer)) continue
    if (!isFiniteNumber(raw.alpha)) continue
    if (typeof raw.onScreen !== 'boolean') continue
    if (!isValidRect(raw.bounds)) continue
    const bounds = sanitizeRect(raw.bounds)
    if (bounds.width <= 0 || bounds.height <= 0) continue
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    windows.push({
      id: raw.id,
      pid: raw.pid,
      owner: raw.owner,
      layer: raw.layer,
      alpha: raw.alpha,
      bounds,
      onScreen: raw.onScreen
    })
  }
  return windows
}

/** 单个窗口是否可作为桌面表面（过滤规则见文件头注释）。 */
export function isEligibleWindow(
  window: WindowInfo,
  options: WindowFilterOptions = {}
): boolean {
  if (!window || typeof window !== 'object') return false
  if (!isFiniteNumber(window.id) || !isFiniteNumber(window.pid)) return false
  if (!isFiniteNumber(window.layer) || !isFiniteNumber(window.alpha)) return false
  if (!isValidRect(window.bounds)) return false
  if (window.onScreen !== true) return false

  const requiredLayer = isFiniteNumber(options.requiredLayer)
    ? options.requiredLayer
    : NORMAL_WINDOW_LAYER
  if (window.layer !== requiredLayer) return false

  const minAlpha = isFiniteNumber(options.minAlpha) ? options.minAlpha : MIN_WINDOW_ALPHA
  if (!(window.alpha > minAlpha)) return false

  const minHeight = isFiniteNumber(options.minHeightPx)
    ? options.minHeightPx
    : MIN_WINDOW_HEIGHT_PX
  if (!(window.bounds.height > minHeight)) return false
  if (!(window.bounds.width > 0)) return false

  if (isFiniteNumber(options.ownPid) && window.pid === options.ownPid) return false
  if (options.overlayWindowIds && options.overlayWindowIds.includes(window.id)) return false

  const displayBounds = options.displayBounds
  if (displayBounds && isValidRect(displayBounds) && !rectsIntersect(window.bounds, displayBounds)) {
    return false
  }
  return true
}

/** 过滤窗口列表（顺序保留：前→后即 CGWindowList 的 z 序）。 */
export function filterWindows(
  windows: readonly WindowInfo[],
  options: WindowFilterOptions = {}
): WindowInfo[] {
  if (!Array.isArray(windows)) return []
  return windows.filter((window) => isEligibleWindow(window, options))
}
