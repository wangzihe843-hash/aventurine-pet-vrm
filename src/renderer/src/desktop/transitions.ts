/**
 * B5 桌面感知 —— 窗口列表变化事件（纯函数，无 DOM / Electron / node 内置依赖）。
 *
 * 两个纯函数：
 * - `diffWindowLists`：两份 `WindowInfo[]` 的「同帧 diff」（appeared / closed / moved）；
 * - `coalesceTransitions`：按窗口 id 合并去重 —— **同一窗口同类事件只保留一次**，
 *   连续 moved 的 delta 相加（一帧内多次 `updateWindows` 的位移合并成一个 delta），
 *   `appeared + closed` 净效果取消（窗口从未在这一帧里被消费方看到），
 *   `appeared + moved` 只报 appeared（出现位置就是最终位置）。
 *
 * 说明：真实 `DesktopSensor` 用「窗口 id 记忆 + 宽限期」跟踪，本模块的 diff 供
 * 单测 / B1 复算 / Lead 排查使用，语义与 sensor 一致（moved delta 为位置增量，
 * 全局坐标差与本地坐标差相同，平移不改变 delta）。
 */
import type { Rect, WindowInfo } from '@shared/types'

import type { WindowTransition } from '../core/wave2-contract'

/** 两个矩形是否完全一致（位置 + 尺寸；用于判断 moved / resize）。 */
export function sameBounds(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** `diffWindowLists` 选项。 */
export interface DiffWindowOptions {
  /**
   * 仅尺寸变化（位置没变）时是否也报 `moved`（delta = {0,0}）。
   * 默认 true：尺寸变化意味着窗口表面拓扑变化，B1 需要重新评估跟随/落点。
   */
  emitOnResize?: boolean
}

/**
 * 比较两份窗口列表，产出原始 transition 列表（未去重；同一窗口可能出现多条）。
 *
 * 顺序：先按 next 顺序产出 appeared，再按 next 顺序产出 moved，最后按 previous 顺序
 * 产出 closed（确定性，便于单测断言）。同一 id 重复出现时只取第一项。
 */
export function diffWindowLists(
  previous: readonly WindowInfo[],
  next: readonly WindowInfo[],
  options: DiffWindowOptions = {}
): WindowTransition[] {
  const emitOnResize = options.emitOnResize ?? true
  const previousById = new Map<number, WindowInfo>()
  for (const window of previous ?? []) {
    if (window && !previousById.has(window.id)) previousById.set(window.id, window)
  }
  const nextById = new Map<number, WindowInfo>()
  for (const window of next ?? []) {
    if (window && !nextById.has(window.id)) nextById.set(window.id, window)
  }

  const events: WindowTransition[] = []
  for (const window of nextById.values()) {
    const before = previousById.get(window.id)
    if (!before) {
      events.push({ kind: 'appeared', windowId: window.id })
      continue
    }
    if (sameBounds(before.bounds, window.bounds)) continue
    const delta = {
      x: window.bounds.x - before.bounds.x,
      y: window.bounds.y - before.bounds.y
    }
    if (delta.x === 0 && delta.y === 0 && !emitOnResize) continue
    events.push({ kind: 'moved', windowId: window.id, delta })
  }
  for (const window of previousById.values()) {
    if (!nextById.has(window.id)) events.push({ kind: 'closed', windowId: window.id })
  }
  return events
}

/** 事件对象深拷贝（避免调用方修改 coalesce 返回值时污染内部缓存）。 */
function cloneTransition(transition: WindowTransition): WindowTransition {
  if (transition.kind === 'moved') {
    return { kind: 'moved', windowId: transition.windowId, delta: { ...transition.delta } }
  }
  return { kind: transition.kind, windowId: transition.windowId }
}

/**
 * 合并同一窗口的多次变化（一帧内去重）：
 * - `moved + moved` → 单个 moved，delta 相加；
 * - `appeared + moved` → appeared（出现位置即最终位置）；
 * - `moved + closed` → closed（最终结果才是消费方关心的）；
 * - `appeared + closed` → 删除（窗口在这个窗口期内净变化为「从未出现」）；
 * - `closed + appeared` → appeared（窗口 id 复用 / 同帧重开，视为新窗口）。
 *
 * 输出顺序 = 每个窗口**第一次**出现的事件顺序（删除的项跳过）。
 */
export function coalesceTransitions(
  events: readonly WindowTransition[]
): WindowTransition[] {
  const order: number[] = []
  const byId = new Map<number, WindowTransition>()

  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue
    const existing = byId.get(event.windowId)
    if (!existing) {
      byId.set(event.windowId, cloneTransition(event))
      order.push(event.windowId)
      continue
    }

    switch (event.kind) {
      case 'appeared':
        // 先 closed 后 appeared：id 复用/重开，最终以 appeared 为准；其余情况保持已有事件。
        if (existing.kind === 'closed') byId.set(event.windowId, cloneTransition(event))
        break
      case 'closed':
        // 先 appeared 后 closed：净效果为「没有出现」，直接删除。
        if (existing.kind === 'appeared') {
          byId.delete(event.windowId)
        } else {
          byId.set(event.windowId, cloneTransition(event))
        }
        break
      case 'moved': {
        if (existing.kind === 'moved') {
          byId.set(event.windowId, {
            kind: 'moved',
            windowId: event.windowId,
            delta: {
              x: existing.delta.x + event.delta.x,
              y: existing.delta.y + event.delta.y
            }
          })
        } else if (existing.kind === 'closed') {
          // 已关闭的窗口之后的 moved 无意义（防御异常输入），保留 closed。
        } else {
          // appeared 已覆盖位置信息，忽略后续 moved。
        }
        break
      }
      default:
        break
    }
  }

  const result: WindowTransition[] = []
  for (const windowId of order) {
    const transition = byId.get(windowId)
    if (transition) result.push(cloneTransition(transition))
  }
  return result
}
