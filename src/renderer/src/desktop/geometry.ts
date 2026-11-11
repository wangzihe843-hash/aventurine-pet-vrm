/**
 * B5 桌面感知 —— 坐标系换算 + 桌面表面几何（纯函数，无 DOM / Electron / node 内置依赖）。
 *
 * 坐标口径（docs/wave2-integration.md §1、PLAN §17.3-2）：
 * - 输入 `WindowInfo.bounds` / `DisplayInfo.bounds|workArea` 是**屏幕全局**逻辑像素；
 * - 本模块输出一律是 **overlay 窗口本地 CSS 像素**：`local = global − overlayOrigin`
 *   （overlay frame = 主屏 display.workArea，主屏上 origin.y 通常是 30，不是 0）；
 * - DPR 不参与任何换算（只影响 canvas backing store）。
 *
 * 菜单栏 / Dock 区域一律由 `display.bounds` 与 `display.workArea` 的**差集**推导
 * （上差 = 菜单栏、下/左/右差 = Dock），**禁止硬编码 30/24px**（PLAN §11）。
 * 差集为 0 时表示该项自动隐藏（或不存在），对应表面不生成。
 */
import type { DisplayInfo, Rect, WindowInfo } from '@shared/types'

import type { DesktopSurface, PetSize, Point2D } from '../core/wave2-contract'

/** 本地坐标原点（overlay 窗口左上角的全局坐标）。 */
export const ZERO_POINT: Point2D = { x: 0, y: 0 }

/** 零矩形（退化输入兜底；`DesktopSnapshot.workArea/screenBounds` 未初始化时使用）。 */
export const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

/** 菜单栏表面 id（菜单栏底边 = workArea 顶边；workArea 在 overlay 内即本地 y=0 附近）。 */
export const MENUBAR_SURFACE_ID = 'menubar'
/** 底部 Dock 表面 id（Dock 顶边 = workArea 底边）。 */
export const DOCK_BOTTOM_SURFACE_ID = 'dock-bottom'
/** 左侧 Dock 表面 id（Dock 内边缘 = workArea 左边缘）。 */
export const DOCK_LEFT_SURFACE_ID = 'dock-left'
/** 右侧 Dock 表面 id（Dock 内边缘 = workArea 右边缘）。 */
export const DOCK_RIGHT_SURFACE_ID = 'dock-right'
/** 地面表面 id（workArea 底边；总是提供）。 */
export const SCREEN_BOTTOM_SURFACE_ID = 'screen-bottom'

/** 是否为有限数字（JSON 无法表达 NaN/Infinity，但注入的 fake / 异常输入仍要防御）。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 有限数字原样返回，否则回退 fallback（配置项防御）。 */
export function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback
}

/** 非负有限数字（负数 / 非法一律钳制为 0 或 fallback）。 */
export function nonNegativeOr(value: unknown, fallback: number): number {
  const finite = finiteOr(value, fallback)
  return finite < 0 ? 0 : finite
}

/** 矩形是否所有字段均为有限数且宽高 >= 0（用于区分「合法输入」与「需要兜底」）。 */
export function isValidRect(rect: unknown): rect is Rect {
  if (typeof rect !== 'object' || rect === null) return false
  const raw = rect as Partial<Rect>
  return (
    isFiniteNumber(raw.x) &&
    isFiniteNumber(raw.y) &&
    isFiniteNumber(raw.width) &&
    isFiniteNumber(raw.height) &&
    raw.width >= 0 &&
    raw.height >= 0
  )
}

/** 把任意输入归一化为安全矩形：逐字段回退 fallback，宽高钳制 >= 0；绝不抛。 */
export function sanitizeRect(value: unknown, fallback: Rect = ZERO_RECT): Rect {
  const base = isValidRect(fallback) ? fallback : ZERO_RECT
  if (typeof value !== 'object' || value === null) return { ...base }
  const raw = value as Partial<Rect>
  return {
    x: finiteOr(raw.x, base.x),
    y: finiteOr(raw.y, base.y),
    width: nonNegativeOr(raw.width, base.width),
    height: nonNegativeOr(raw.height, base.height)
  }
}

/** 把任意输入归一化为安全点；非法字段回退 fallback，绝不抛（负坐标合法保留）。 */
export function sanitizePoint(value: unknown, fallback: Point2D = ZERO_POINT): Point2D {
  const base = fallback && typeof fallback === 'object' ? fallback : ZERO_POINT
  if (typeof value !== 'object' || value === null) return { ...base }
  const raw = value as Partial<Point2D>
  return { x: finiteOr(raw.x, base.x), y: finiteOr(raw.y, base.y) }
}

/** 把任意输入归一化为安全尺寸（宽高钳制 >= 0）；绝不抛。 */
export function sanitizeSize(value: unknown, fallback: PetSize = { width: 0, height: 0 }): PetSize {
  const base = fallback && typeof fallback === 'object' ? fallback : { width: 0, height: 0 }
  if (typeof value !== 'object' || value === null) return { ...base }
  const raw = value as Partial<PetSize>
  return {
    width: nonNegativeOr(raw.width, base.width),
    height: nonNegativeOr(raw.height, base.height)
  }
}

/**
 * 全局坐标点 → overlay 本地坐标点：`local = global − origin`。
 * 非法输入按 0 处理（不抛；单测覆盖 NaN/负坐标）。
 */
export function globalToLocalPoint(point: Point2D, origin: Point2D): Point2D {
  const local = sanitizePoint(point)
  const base = sanitizePoint(origin)
  return { x: local.x - base.x, y: local.y - base.y }
}

/**
 * 全局坐标矩形 → overlay 本地坐标矩形：只平移原点，宽高不变
 * （窗口可能有一部分在屏幕外，负坐标合法保留，由 B2 的 workArea 约束负责）。
 */
export function globalToLocalRect(rect: Rect, origin: Point2D): Rect {
  const local = sanitizeRect(rect)
  const base = sanitizePoint(origin)
  return {
    x: local.x - base.x,
    y: local.y - base.y,
    width: local.width,
    height: local.height
  }
}

/**
 * 两个矩形是否有**正面积交集**（边缘恰好相接不算；零/负尺寸视为不相交）。
 * B5 用它过滤「不在当前 overlay 所在显示器上」的窗口。
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  const left = sanitizeRect(a)
  const right = sanitizeRect(b)
  if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) return false
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  )
}

/**
 * 点是否落在矩形内（边界含）。非法输入返回 false。
 *
 * B5 `findPlacementTarget` 用它判断「宠物身体中心压在哪个窗口上」（松手放置目标）。
 */
export function rectContainsPoint(rect: Rect, point: Point2D): boolean {
  if (!isValidRect(rect)) return false
  if (!isFiniteNumber(point?.x) || !isFiniteNumber(point?.y)) return false
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** 两个矩形在 x 轴上的重叠宽度（无重叠 = 0；非法输入返回 0）。 */
export function horizontalOverlapWidth(a: Rect, b: Rect): number {
  if (!isValidRect(a) || !isValidRect(b)) return 0
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
}

/** 显示器 bounds 与 workArea 的差集（菜单栏 / Dock 占用的像素；负差钳制为 0）。 */
export interface DisplayInsets {
  /** 上差：菜单栏高度（自动隐藏时为 0）。 */
  top: number
  /** 下差：底部 Dock 高度（Dock 自动隐藏 / 在侧边时为 0）。 */
  bottom: number
  /** 左差：左侧 Dock 宽度。 */
  left: number
  /** 右差：右侧 Dock 宽度。 */
  right: number
}

/** 推导显示器四周被系统 UI 占用的像素（菜单栏 / Dock），不做任何硬编码。 */
export function computeDisplayInsets(bounds: Rect, workArea: Rect): DisplayInsets {
  const screen = sanitizeRect(bounds)
  const work = sanitizeRect(workArea)
  return {
    top: Math.max(0, work.y - screen.y),
    bottom: Math.max(0, screen.y + screen.height - (work.y + work.height)),
    left: Math.max(0, work.x - screen.x),
    right: Math.max(0, screen.x + screen.width - (work.x + work.width))
  }
}

/** 水平表面矩形（高 1px 的占位条：B2 只用 top 判定落点，rect 供可视化/调试）。 */
function horizontalSurface(
  id: string,
  kind: DesktopSurface['kind'],
  x: number,
  top: number,
  width: number,
  options: { sittable: boolean; climbable: boolean }
): DesktopSurface {
  return {
    id,
    kind,
    rect: { x, y: top, width, height: 1 },
    top,
    sittable: options.sittable,
    climbable: options.climbable
  }
}

/**
 * 由 overlay 本地的 `display.bounds` / `display.workArea` 推导系统表面：
 *
 * 1. **菜单栏**：上差 > 0 → 表面位于 workArea 顶边（菜单栏底边），可坐；
 * 2. **Dock**：下差 / 左差 / 右差 > 0 → Dock 表面位于 workArea 对应内边缘
 *    （底部 Dock 可坐；侧边 Dock 可坐 + 可爬），底部 Dock 排在 `screen-bottom` 之前
 *    （契约要求「Dock 优先级更高」）；
 * 3. **地面 `screen-bottom`**：始终提供（workArea 底边），作为最后兜底。
 *
 * 顺序即快照里的「前→后」：菜单栏 → Dock → 地面（窗口表面由调用方排在更前面）。
 * 输入退化为非法时按 `ZERO_RECT` 处理并仍返回 `screen-bottom`（不抛）。
 */
export function deriveSystemSurfaces(
  screenBoundsLocal: Rect,
  workAreaLocal: Rect
): DesktopSurface[] {
  const screen = sanitizeRect(screenBoundsLocal)
  const workArea = isValidRect(workAreaLocal)
    ? sanitizeRect(workAreaLocal)
    : { ...screen }
  const insets = computeDisplayInsets(screen, workArea)
  const surfaces: DesktopSurface[] = []

  if (insets.top > 0) {
    surfaces.push(
      horizontalSurface(
        MENUBAR_SURFACE_ID,
        'menubar',
        workArea.x,
        workArea.y,
        workArea.width,
        { sittable: true, climbable: false }
      )
    )
  }

  if (insets.bottom > 0) {
    surfaces.push(
      horizontalSurface(
        DOCK_BOTTOM_SURFACE_ID,
        'dock',
        workArea.x,
        workArea.y + workArea.height,
        workArea.width,
        { sittable: true, climbable: false }
      )
    )
  }

  // 侧边 Dock：竖条表面，top = workArea 顶边（宠物可站在 Dock 内上角 / 沿内边缘爬）。
  if (insets.left > 0) {
    surfaces.push({
      id: DOCK_LEFT_SURFACE_ID,
      kind: 'dock',
      rect: { x: workArea.x, y: workArea.y, width: 1, height: workArea.height },
      top: workArea.y,
      sittable: true,
      climbable: true
    })
  }
  if (insets.right > 0) {
    surfaces.push({
      id: DOCK_RIGHT_SURFACE_ID,
      kind: 'dock',
      rect: {
        x: workArea.x + workArea.width - 1,
        y: workArea.y,
        width: 1,
        height: workArea.height
      },
      top: workArea.y,
      sittable: true,
      climbable: true
    })
  }

  // 地面总是提供（即使 workArea 退化；空矩形也比抛异常/缺表面好）。
  surfaces.push(
    horizontalSurface(
      SCREEN_BOTTOM_SURFACE_ID,
      'screen-bottom',
      workArea.x,
      workArea.y + workArea.height,
      workArea.width,
      { sittable: true, climbable: false }
    )
  )
  return surfaces
}

/**
 * 一个其它应用窗口 → 它的桌面表面（本地坐标）：
 * - `win-<id>-top`：`window-top`，rect 高度 1px 占位、`top = 本地 bounds.y`，可坐不可爬；
 * - `win-<id>-left` / `win-<id>-right`：`window-side`，1px 宽竖条、可沿边缘爬（不可坐）。
 *
 * 窗口完全离开屏幕（宽高非法 / 为 0）时返回空数组；部分在屏（负坐标）照常生成，
 * 由 B2 的 workArea 约束决定宠物实际能走到哪。
 */
export function createWindowSurfaces(
  window: WindowInfo,
  overlayOrigin: Point2D,
  frontWindows: readonly WindowInfo[] = []
): DesktopSurface[] {
  const local = globalToLocalRect(window?.bounds, overlayOrigin)
  if (local.width <= 0 || local.height <= 0) return []
  const windowId = finiteOr(window?.id, 0)
  const prefix = `win-${windowId}`
  // 2026-11-08 用户反馈：不能坐「被前层窗口挡住顶边」的窗口（否则会在屏幕中间虚空坐下）。
  // 只保留顶边线未被 z 序更前窗口遮住的部分（可见区间），每个区间一个 window-top 表面；
  // 完全被遮住 → 不生成 top 表面（该窗口不可坐）。
  const visibleTopSegments = visibleTopEdgeSegments(local, frontWindows, overlayOrigin)
  const surfaces: DesktopSurface[] = visibleTopSegments.map((segment, index) => ({
    id: `${prefix}-top${index === 0 ? '' : `-${index}`}`,
    kind: 'window-top',
    rect: { x: segment.x, y: local.y, width: segment.width, height: 1 },
    top: local.y,
    windowId,
    sittable: true,
    climbable: false
  }))
  return [
    ...surfaces,
    {
      id: `${prefix}-left`,
      kind: 'window-side',
      rect: { x: local.x, y: local.y, width: 1, height: local.height },
      top: local.y,
      windowId,
      sittable: false,
      climbable: true
    },
    {
      id: `${prefix}-right`,
      kind: 'window-side',
      rect: {
        x: local.x + local.width - 1,
        y: local.y,
        width: 1,
        height: local.height
      },
      top: local.y,
      windowId,
      sittable: false,
      climbable: true
    }
  ]
}

/**
 * 计算窗口顶边的**可见区间**（被 z 序更前的窗口遮住的部分剔除）。
 *
 * 判定：前层窗口 O 遮挡顶边点 (x, window.top) ⇔ O 的 rect 覆盖该点（含边界）。
 * 返回按 x 升序的可见区间；完全被遮住时返回空数组。
 */
export function visibleTopEdgeSegments(
  windowLocalRect: Rect,
  frontWindows: readonly WindowInfo[],
  overlayOrigin: Point2D
): Array<{ x: number; width: number }> {
  const edgeY = windowLocalRect.y
  const left = windowLocalRect.x
  const right = windowLocalRect.x + windowLocalRect.width
  if (!(right > left)) return []
  // 收集前层窗口覆盖到的 x 区间（只保留确实盖住 edgeY 的窗口）。
  const covered: Array<[number, number]> = []
  for (const front of frontWindows) {
    if (!front) continue
    const rect = globalToLocalRect(front.bounds, overlayOrigin)
    if (rect.width <= 0 || rect.height <= 0) continue
    if (edgeY < rect.y || edgeY > rect.y + rect.height) continue
    const start = Math.max(left, rect.x)
    const end = Math.min(right, rect.x + rect.width)
    if (end > start) covered.push([start, end])
  }
  if (covered.length === 0) return [{ x: left, width: right - left }]
  covered.sort((a, b) => a[0] - b[0])
  const segments: Array<{ x: number; width: number }> = []
  let cursor = left
  for (const [start, end] of covered) {
    if (start > cursor) segments.push({ x: cursor, width: start - cursor })
    cursor = Math.max(cursor, end)
    if (cursor >= right) break
  }
  if (cursor < right) segments.push({ x: cursor, width: right - cursor })
  return segments.filter((segment) => segment.width > 0.5)
}

/** 一份经验证的显示器信息（内部使用；非法字段已归一化）。 */
export function sanitizeDisplayInfo(
  display: DisplayInfo | null | undefined
): DisplayInfo | null {
  if (!display || typeof display !== 'object') return null
  if (!isFiniteNumber(display.id)) return null
  if (!isValidRect(display.bounds) || !isValidRect(display.workArea)) return null
  return {
    id: display.id,
    bounds: sanitizeRect(display.bounds),
    workArea: sanitizeRect(display.workArea),
    scaleFactor:
      isFiniteNumber(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1,
    isPrimary: display.isPrimary === true
  }
}
