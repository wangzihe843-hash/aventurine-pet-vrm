/**
 * B5 桌面感知消费 —— `DesktopSensor`（纯逻辑，无 DOM / Electron / node 内置依赖）。
 *
 * 数据来源（Lead 接线，见 README）：
 *   1. 订阅 `windows-updated`（payload = 完整 `WindowInfo[]`，顺序即 z 序）→ `updateWindows()`；
 *   2. **订阅后先 `invoke('pet:windows')` 取基线**（A4 首次成功轮询只做基线不广播，
 *      native/winlist/README.md「消费方注意」第 1 条）；
 *   3. `pet:window-info` / `screens-updated` / resize → `updateEnvironment()`
 *      （overlay 原点 / 当前显示器 / 视口尺寸 / ownPid）。
 *
 * 每帧 `snapshot(nowMs)` 输出冻结契约 `DesktopSnapshot`（窗口本地坐标表面 + 一次性变化事件），
 * 供 B1 决策「坐窗口上沿 / 跟随移动 / 窗口关闭掉落 / 爬边缘」；transitions 取走即清空。
 *
 * 关键设计：
 * - **窗口 id 记忆 + 宽限期**：`.optionOnScreenOnly` 下窗口最小化 / 切 Space 会从列表消失，
 *   但不算「关闭」；宽限期内保留表面（宠物不瞬移/不误掉），超过 `closeGraceMs` 才报 closed。
 * - **环境变化不产生噪声**：显示器/workArea/ownPid 变化时按新过滤条件静默重建跟踪基线，
 *   不把整屏窗口当成 appeared。
 * - **坐标**：输入全局坐标，所有表面 rect / top 一律换算到 overlay 本地坐标。
 * - **退化输入不抛**：空列表、NaN 时间/坐标、未初始化环境都返回安全值。
 */
import type { DisplayInfo, Rect, WindowInfo } from '@shared/types'

import type {
  DesktopSnapshot,
  DesktopSurface,
  PetSize,
  Point2D,
  WindowTransition
} from '../core/wave2-contract'
import {
  filterWindows,
  MIN_WINDOW_ALPHA,
  MIN_WINDOW_HEIGHT_PX,
  sanitizeWindows,
  type WindowFilterOptions
} from './filter'
import {
  createWindowSurfaces,
  deriveSystemSurfaces,
  finiteOr,
  globalToLocalRect,
  horizontalOverlapWidth,
  isFiniteNumber,
  isValidRect,
  rectContainsPoint,
  sanitizeDisplayInfo,
  sanitizePoint,
  sanitizeSize,
  ZERO_RECT
} from './geometry'
import { coalesceTransitions, sameBounds } from './transitions'

/** 默认「可坐」吸附阈值：脚底与表面上沿 y 差 < 24px（PLAN §11）。 */
export const DEFAULT_SITTABLE_GAP_PX = 24

/**
 * 默认「消失→确认关闭」宽限期（ms）。
 *
 * winlist README「消费方注意」第 2 条：列表消失可能是最小化 / 切 Space / 显示器分离空间，
 * 不应立即当成关闭让宠物落下。宽限期跨越一个 500ms 轮询周期并留余量。
 */
export const DEFAULT_CLOSE_GRACE_MS = 600

/** `DesktopSensor` 构造选项（全部可注入，便于单测）。 */
export interface DesktopSensorOptions {
  /** 可坐吸附阈值（px，默认 {@link DEFAULT_SITTABLE_GAP_PX}）。 */
  sittableGapPx?: number
  /** 窗口从列表消失 → 确认关闭的宽限期（ms，默认 {@link DEFAULT_CLOSE_GRACE_MS}；0 = 立即确认）。 */
  closeGraceMs?: number
  /** 吸附窗口最小高度（px，默认 {@link MIN_WINDOW_HEIGHT_PX}）。 */
  minWindowHeightPx?: number
  /** 吸附窗口最小 alpha（默认 {@link MIN_WINDOW_ALPHA}）。 */
  minWindowAlpha?: number
}

/**
 * 环境更新输入（窗口本地坐标的基准）。
 *
 * `ownPid` / `overlayWindowIds` 用于排除宠物自身窗口；`overlayWindowIds` 是本模块的
 * 可选扩展（Lead 可从 `pet:window-info.id` 传入，作为 ownPid 之外的第二保险）。
 */
export interface DesktopSensorEnvironment {
  /** overlay 窗口左上角的屏幕全局坐标（`OverlayWindowInfo.bounds` 的 x/y）。 */
  overlayOrigin: Point2D
  /** 当前 overlay 所在显示器（`screens-updated` 里按 displayId 匹配的 DisplayInfo）。 */
  display: DisplayInfo
  /** overlay 窗口本地尺寸（CSS px，= #app clientWidth/clientHeight）。 */
  viewport: PetSize
  /** 宠物自身进程 pid（排除 overlay 窗口）。 */
  ownPid?: number
  /** 可选扩展：宠物自身 overlay 窗口 id 列表（第二保险）。 */
  overlayWindowIds?: readonly number[]
}

/** 已归一化的环境（内部状态；全局 + 本地两套矩形）。 */
interface ResolvedEnvironment {
  overlayOrigin: Point2D
  viewport: PetSize
  /** 显示器全局 bounds。 */
  screenBounds: Rect
  /** 显示器全局 workArea。 */
  workArea: Rect
  /** 显示器 bounds 换算到 overlay 本地。 */
  localScreenBounds: Rect
  /** 显示器 workArea 换算到 overlay 本地（正常等于视口）。 */
  localWorkArea: Rect
  ownPid?: number
  overlayWindowIds: readonly number[]
}

/** 单个被跟踪窗口（含宽限期状态）。 */
interface TrackedWindow {
  /** 最近一次见到的窗口信息（局部字段不修改，整体替换）。 */
  info: WindowInfo
  /** 最近一次在列表中出现的时间（单调时钟 ms）。 */
  lastSeenMs: number
  /** 从列表消失的起始时间；null = 当前仍在列表中。 */
  missingSinceMs: number | null
}

/**
 * 「放置到窗口上」目标（松手时由 B2/集成层消费）。
 *
 * 背景（2026-11-09 实机 bug）：宠物被拎起来松手后只会"下落穿越窗沿"才停，而用户最自然的
 * 操作是"把它放到窗口上"——松手时身体已经压在窗口区域里、根本不会穿越上沿，于是直接掉到屏幕底。
 * 集成层用本结构找到松手点下方最前面的窗口，再决定：吸附到它可见的上沿（能坐）或原地站定（沿太高）。
 */
export interface PlacementTarget {
  /** 目标窗口 id（与 `DesktopSurface.windowId` 同口径）。 */
  windowId: number
  /** 目标窗口在 overlay 本地坐标下的**完整矩形**（不做遮挡裁剪）。 */
  windowRect: Rect
  /** 该窗口当前**可见**的顶边表面（顶边被前层完全遮挡 / 窄条时为 null）。 */
  topSurface: DesktopSurface | null
}

/** 环境等价判断（避免每帧重复重建基线；也用于判断是否需要静默 rebaseline）。 */
function samePoint(a: Point2D, b: Point2D): boolean {
  return a.x === b.x && a.y === b.y
}

function sameSize(a: PetSize, b: PetSize): boolean {
  return a.width === b.width && a.height === b.height
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function sameEnvironment(a: ResolvedEnvironment, b: ResolvedEnvironment): boolean {
  if (a.ownPid !== b.ownPid) return false
  if (a.overlayWindowIds.length !== b.overlayWindowIds.length) return false
  for (let index = 0; index < a.overlayWindowIds.length; index += 1) {
    if (a.overlayWindowIds[index] !== b.overlayWindowIds[index]) return false
  }
  return (
    samePoint(a.overlayOrigin, b.overlayOrigin) &&
    sameSize(a.viewport, b.viewport) &&
    sameRect(a.screenBounds, b.screenBounds) &&
    sameRect(a.workArea, b.workArea)
  )
}

/** 复制矩形（返回快照时避免调用方改到内部状态）。 */
function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/**
 * 桌面感知器：维护窗口列表 / 环境 / 宽限期跟踪状态，产出 `DesktopSnapshot`。
 *
 * 用法（Lead 每帧）：
 * ```ts
 * sensor.updateEnvironment({ overlayOrigin, display, viewport, ownPid })
 * sensor.updateWindows(windows, nowMs)          // windows-updated + 基线 invoke
 * const desktop = sensor.snapshot(nowMs)        // 交给 B1
 * ```
 */
export class DesktopSensor {
  private readonly sittableGapPx: number
  private readonly closeGraceMs: number
  private readonly minWindowHeightPx: number
  private readonly minWindowAlpha: number

  /** 当前环境；null = 尚未 updateEnvironment（snapshot 返回空表面/零矩形）。 */
  private environment: ResolvedEnvironment | null = null
  /** 最近一次收到的窗口列表（已归一化；顺序 = CGWindowList 前→后）。 */
  private rawWindows: WindowInfo[] = []
  /** 被跟踪窗口（含宽限期内暂时消失的窗口）。 */
  private tracked = new Map<number, TrackedWindow>()
  /** 待消费的一次性变化事件（已按窗口 id 去重/合并）。 */
  private pendingTransitions: WindowTransition[] = []
  /** 第一份窗口列表只做基线（不产生 appeared 噪声，与 A4「首次轮询只做基线」对齐）。 */
  private baselineDone = false

  constructor(options: DesktopSensorOptions = {}) {
    this.sittableGapPx = Math.max(0, finiteOr(options.sittableGapPx, DEFAULT_SITTABLE_GAP_PX))
    this.closeGraceMs = Math.max(0, finiteOr(options.closeGraceMs, DEFAULT_CLOSE_GRACE_MS))
    this.minWindowHeightPx = Math.max(
      0,
      finiteOr(options.minWindowHeightPx, MIN_WINDOW_HEIGHT_PX)
    )
    this.minWindowAlpha = Math.max(0, finiteOr(options.minWindowAlpha, MIN_WINDOW_ALPHA))
  }

  /**
   * 更新环境（overlay 原点 / 显示器 / 视口 / 自身 pid）。
   *
   * 显示器信息非法时退化为「overlay 视口 = 整个工作区」（仍提供 screen-bottom 地面），
   * 保证单测/启动早期调用不抛。环境无实际变化时是 no-op（可安全每帧调用）。
   */
  updateEnvironment(environment: DesktopSensorEnvironment): void {
    const resolved = this.resolveEnvironment(environment)
    const previous = this.environment
    this.environment = resolved
    if (previous && sameEnvironment(previous, resolved)) return
    // 环境（显示器 / 自身 pid）可能在窗口基线之后才到达：按新过滤条件静默重建基线，
    // 不把「换了显示器」误报成整屏窗口 appeared/closed。
    this.rebaseline()
  }

  /**
   * 更新窗口列表（`windows-updated` payload 或 `pet:windows` 基线）。
   *
   * - 首份列表只做基线，不产生 transitions；
   * - 按 window id 做 diff：新出现 → `appeared`、位置/尺寸变化 → `moved{delta}`；
   * - 消失的窗口先进入宽限期（`closeGraceMs`），由后续 `snapshot(nowMs)` 确认 `closed`；
   * - 同一窗口同类事件合并（一帧内多次调用 delta 相加）。
   */
  updateWindows(windows: WindowInfo[], nowMs: number): void {
    const now = finiteOr(nowMs, 0)
    this.rawWindows = sanitizeWindows(windows)
    const eligible = filterWindows(this.rawWindows, this.filterOptions())

    const events: WindowTransition[] = []
    const seen = new Set<number>()
    for (const window of eligible) {
      seen.add(window.id)
      const tracked = this.tracked.get(window.id)
      if (!tracked) {
        this.tracked.set(window.id, { info: window, lastSeenMs: now, missingSinceMs: null })
        if (this.baselineDone) events.push({ kind: 'appeared', windowId: window.id })
        continue
      }
      const previousBounds = tracked.info.bounds
      const wasMissing = tracked.missingSinceMs !== null
      tracked.info = window
      tracked.lastSeenMs = now
      tracked.missingSinceMs = null
      if (!sameBounds(previousBounds, window.bounds)) {
        // delta 用全局坐标差；坐标平移不改变增量，本地消费方可直接用。
        events.push({
          kind: 'moved',
          windowId: window.id,
          delta: {
            x: window.bounds.x - previousBounds.x,
            y: window.bounds.y - previousBounds.y
          }
        })
      } else if (wasMissing) {
        // 宽限期内原样回来：不产生事件（表面一直保留，宠物无需反应）。
      }
    }

    for (const [windowId, tracked] of this.tracked) {
      if (seen.has(windowId)) continue
      if (tracked.missingSinceMs === null) tracked.missingSinceMs = now
    }

    this.baselineDone = true
    if (events.length > 0) {
      this.pendingTransitions = coalesceTransitions([...this.pendingTransitions, ...events])
    }
  }

  /**
   * 当前桌面快照（每帧调用一次）。
   *
   * - 先推进宽限期（超时窗口 → `closed` 并从表面移除）；
   * - `surfaces` 按前→后排序：窗口表面（CGWindowList 顺序）→ 菜单栏 → Dock → 地面；
   * - `transitions` 为自上次 snapshot 以来的变化，**取走后清空**；
   * - 未 updateEnvironment 时 surfaces 为空、workArea/screenBounds 为零矩形（不抛）。
   */
  snapshot(nowMs: number): DesktopSnapshot {
    const now = finiteOr(nowMs, 0)
    this.expireMissingWindows(now)
    const surfaces = this.buildSurfaces()
    const transitions = this.pendingTransitions
    this.pendingTransitions = []
    const environment = this.environment
    return {
      surfaces,
      transitions,
      workArea: environment ? cloneRect(environment.localWorkArea) : cloneRect(ZERO_RECT),
      screenBounds: environment ? cloneRect(environment.localScreenBounds) : cloneRect(ZERO_RECT)
    }
  }

  /**
   * 找宠物脚底附近可坐的表面（B1 便利方法）：
   * - `|feet.y − surface.top| < sittableGapPx`（默认 24px）；
   * - `feet.x` 落在 surface.rect 水平范围内；
   * - 表面宽度不小于宠物宽度的一半（太窄的工具窗口不坐，B2 亦会做碰撞）；
   * - 按 surfaces 前→后顺序扫描 → **优先前台窗口**（窗口表面排在系统表面之前）。
   *
   * 环境未初始化 / 输入非法时返回 null。
   */
  findSittableSurface(feet: Point2D, petSize: PetSize): DesktopSurface | null {
    if (!this.environment) return null
    if (!isFiniteNumber(feet?.x) || !isFiniteNumber(feet?.y)) return null
    const petWidth = Math.max(0, finiteOr(petSize?.width, 0))
    const minSurfaceWidth = petWidth * 0.5
    for (const surface of this.buildSurfaces()) {
      if (!surface.sittable) continue
      if (surface.rect.width < minSurfaceWidth) continue
      if (Math.abs(feet.y - surface.top) >= this.sittableGapPx) continue
      if (feet.x < surface.rect.x || feet.x > surface.rect.x + surface.rect.width) continue
      return surface
    }
    return null
  }

  /** 可爬表面候选（window-side 左右边缘；侧边 Dock 内边缘也计入）。 */
  getClimbSurfaces(): DesktopSurface[] {
    return this.buildSurfaces().filter((surface) => surface.climbable)
  }

  /**
   * 找「松手放置」目标：宠物身体中心压在最前面的哪个窗口上（B2 吸附窗沿 / 原地站定用）。
   *
   * - 按当前窗口列表**前→后**扫描，取第一个包含宠物中心点的窗口（= 松手点最前面的窗口）；
   * - 同时给出该窗口**当前可见**的顶边表面（遮挡裁剪后可能为 null → 不能吸上去坐）；
   * - 环境未初始化 / 输入非法 → null（调用方回退普通物理：甩出/自由落体）。
   *
   * 注意：只做只读计算（不消费 transitions），可在拖拽松手瞬间（帧外）安全调用。
   */
  findPlacementTarget(petRect: Rect): PlacementTarget | null {
    const environment = this.environment
    if (!environment || !isValidRect(petRect)) return null
    const center: Point2D = {
      x: petRect.x + petRect.width / 2,
      y: petRect.y + petRect.height / 2
    }
    if (!isFiniteNumber(center.x) || !isFiniteNumber(center.y)) return null
    const visible = filterWindows(this.rawWindows, this.filterOptions())
    if (visible.length === 0) return null
    // 列表顺序 = CGWindowList 前→后：前面的窗口都是本窗口的前层（决定顶边可见段）。
    const frontWindows: WindowInfo[] = []
    for (const window of visible) {
      const localRect = globalToLocalRect(window.bounds, environment.overlayOrigin)
      if (!rectContainsPoint(localRect, center)) {
        frontWindows.push(window)
        continue
      }
      let topSurface: DesktopSurface | null = null
      let bestOverlap = 0
      for (const surface of createWindowSurfaces(window, environment.overlayOrigin, frontWindows)) {
        if (surface.kind !== 'window-top') continue
        const overlap = horizontalOverlapWidth(surface.rect, petRect)
        if (overlap <= 0) continue
        if (topSurface === null || overlap > bestOverlap) {
          topSurface = surface
          bestOverlap = overlap
        }
      }
      return { windowId: window.id, windowRect: localRect, topSurface }
    }
    return null
  }

  /** 按窗口 id 取当前 `window-top` 表面（B1 跟随窗口移动时重新锚定用）；未知返回 null。 */
  getTrackedWindowSurface(windowId: number): DesktopSurface | null {
    if (!isFiniteNumber(windowId) || !this.environment) return null
    const surfaces = this.buildSurfaces()
    return (
      surfaces.find(
        (surface) => surface.kind === 'window-top' && surface.windowId === windowId
      ) ?? null
    )
  }

  /** 当前过滤选项（来自环境 + 构造配置）。 */
  private filterOptions(): WindowFilterOptions {
    const environment = this.environment
    return {
      ownPid: environment?.ownPid,
      overlayWindowIds: environment?.overlayWindowIds,
      displayBounds: environment?.screenBounds ?? null,
      minHeightPx: this.minWindowHeightPx,
      minAlpha: this.minWindowAlpha
    }
  }

  /** 归一化环境输入（非法字段兜底，绝不抛）。 */
  private resolveEnvironment(environment: DesktopSensorEnvironment): ResolvedEnvironment {
    const input = environment ?? ({} as DesktopSensorEnvironment)
    const overlayOrigin = sanitizePoint(input.overlayOrigin)
    const viewport = sanitizeSize(input.viewport)
    const display = sanitizeDisplayInfo(input.display)

    let screenBounds: Rect
    let workArea: Rect
    if (display) {
      screenBounds = display.bounds
      workArea = display.workArea
    } else {
      // 显示器未知：假定 overlay 视口就是工作区，仍能提供地面表面（启动早期防御）。
      screenBounds = {
        x: overlayOrigin.x,
        y: overlayOrigin.y,
        width: viewport.width,
        height: viewport.height
      }
      workArea = { ...screenBounds }
    }

    return {
      overlayOrigin,
      viewport,
      screenBounds,
      workArea,
      localScreenBounds: globalToLocalRect(screenBounds, overlayOrigin),
      localWorkArea: globalToLocalRect(workArea, overlayOrigin),
      ownPid:
        isFiniteNumber(input.ownPid) && Number.isInteger(input.ownPid) ? input.ownPid : undefined,
      overlayWindowIds: Array.isArray(input.overlayWindowIds)
        ? input.overlayWindowIds.filter((id) => isFiniteNumber(id) && Number.isInteger(id))
        : []
    }
  }

  /**
   * 按当前过滤条件静默重建跟踪基线（环境变化时调用）：
   * 丢弃不再可见的窗口、补上当前可见窗口，全部不产生 transitions；
   * 同时丢弃已不可见窗口的待消费事件，避免误报。
   */
  private rebaseline(): void {
    const eligible = filterWindows(this.rawWindows, this.filterOptions())
    const next = new Map<number, TrackedWindow>()
    const eligibleIds = new Set<number>()
    for (const window of eligible) {
      eligibleIds.add(window.id)
      const existing = this.tracked.get(window.id)
      next.set(window.id, {
        info: window,
        lastSeenMs: existing?.lastSeenMs ?? 0,
        missingSinceMs: null
      })
    }
    this.tracked = next
    if (this.pendingTransitions.length > 0) {
      this.pendingTransitions = this.pendingTransitions.filter((transition) =>
        eligibleIds.has(transition.windowId)
      )
    }
  }

  /** 推进「消失→关闭」宽限期：超时窗口移出跟踪集合并追加 closed 事件。 */
  private expireMissingWindows(nowMs: number): void {
    const closed: WindowTransition[] = []
    for (const [windowId, tracked] of this.tracked) {
      if (tracked.missingSinceMs === null) continue
      if (nowMs - tracked.missingSinceMs >= this.closeGraceMs) {
        this.tracked.delete(windowId)
        closed.push({ kind: 'closed', windowId })
      }
    }
    if (closed.length > 0) {
      this.pendingTransitions = coalesceTransitions([
        ...this.pendingTransitions,
        ...closed
      ])
    }
  }

  /** 构建当前表面列表（前→后；宽限期窗口保留在窗口表面末尾）。 */
  private buildSurfaces(): DesktopSurface[] {
    const environment = this.environment
    if (!environment) return []
    const surfaces: DesktopSurface[] = []
    const visible = filterWindows(this.rawWindows, this.filterOptions())
    const visibleIds = new Set<number>()
    // 列表顺序 = CGWindowList 前→后：前面的窗口都是前层，会遮挡本窗口顶边。
    // 增量累计前层窗口（N-6：不再每窗 `visible.slice(0, index)`，去掉 O(N²) 数组分配）。
    const frontWindows: WindowInfo[] = []
    for (const window of visible) {
      visibleIds.add(window.id)
      const tracked = this.tracked.get(window.id)
      surfaces.push(
        ...createWindowSurfaces(tracked?.info ?? window, environment.overlayOrigin, frontWindows)
      )
      frontWindows.push(window)
    }
    // 宽限期内暂时从列表消失的窗口（最小化 / 切 Space）仍保留完整顶边几何，避免宠物误掉/瞬移。
    // N-5：但它们在屏幕上已不可见（可能被前层遮挡），顶边不可作为 B1 的新坐/爬目标——
    // 保留几何用于 B2 支撑，`window-top` 置 sittable=false，与 D6a「被挡住的顶边不能坐」一致。
    for (const [windowId, tracked] of this.tracked) {
      if (visibleIds.has(windowId)) continue
      if (tracked.missingSinceMs === null) continue
      surfaces.push(
        ...createWindowSurfaces(tracked.info, environment.overlayOrigin).map((surface) =>
          surface.kind === 'window-top' ? { ...surface, sittable: false } : surface
        )
      )
    }
    surfaces.push(
      ...deriveSystemSurfaces(environment.localScreenBounds, environment.localWorkArea)
    )
    return surfaces
  }
}
