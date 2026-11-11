/**
 * overlay 布局计算 —— 纯函数（Wave 1 A1）
 *
 * **不得 import electron**：便于在 vitest（node 环境）直接单测，也避免 main 模块循环依赖。
 * （type-only 的 `@shared/types` 在编译期被擦除，不影响 node 运行。）
 *
 * 口径（PLAN §17.3-2 / §18.3）：
 * - **每个显示器一个 overlay 窗口**，窗口 frame = 该显示器的 `workArea`
 *   （不覆盖菜单栏 / Dock；macOS 27 + Electron 44 对全屏 borderless 透明窗的约束见 §17.3-2）；
 * - 禁止用「所有显示器包围矩形」建一个超大窗口（负坐标 / 上下错位 / 工作区空洞都会错位）；
 * - `isPrimary` 只透传输入值（由 overlay-manager 决定无主屏标记时的 fallback）。
 */
import type { DisplayInfo, Rect } from '@shared/types'

/** 单个显示器的 overlay 布局（一 display 一项）。 */
export interface OverlayLayout {
  /** 显示器 id（Electron `Display.id`，进程内唯一） */
  displayId: number
  /** overlay 窗口 frame（全局 DIP；= 该显示器 `workArea`，显式拷贝，不共享引用） */
  frame: Rect
  /** 是否主显示器 overlay（透传 `DisplayInfo.isPrimary`） */
  isPrimary: boolean
}

/** 显式拷贝矩形：调用方修改 layout.frame 不应污染显示器快照。 */
function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/**
 * 由显示器快照计算每屏 overlay 布局。
 *
 * 防御行为：
 * - 空输入 → `[]`（无显示器时不建任何窗口）；
 * - 重复 displayId → 保留**首次出现**（Electron 理论不会重复，但显示器变化去抖期间
 *   可能拿到旧快照；首次出现的是调用方给的最新列表中最靠前的一项，行为确定）。
 */
export function computeOverlayLayouts(displays: DisplayInfo[]): OverlayLayout[] {
  const layouts: OverlayLayout[] = []
  const seenDisplayIds = new Set<number>()

  for (const display of displays) {
    if (seenDisplayIds.has(display.id)) continue
    seenDisplayIds.add(display.id)
    layouts.push({
      displayId: display.id,
      frame: copyRect(display.workArea),
      isPrimary: display.isPrimary === true
    })
  }

  return layouts
}
