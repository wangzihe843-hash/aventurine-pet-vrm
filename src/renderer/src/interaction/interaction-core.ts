/**
 * 交互核心编排（B4；纯逻辑，**不 import DOM/three/electron**，可在 node 单测）。
 *
 * 这一层把「区域命中 / 拖拽状态机 / 摸头检测 / 注视平滑 / 右键菜单模型」组合成
 * docs/wave2-integration.md §3-B4 约定的输入输出：
 * - 输入：指针按下/移动/抬起/离开窗口、右键、键盘（ESC/方向键/Enter）、每帧 tick；
 * - 输出：`InteractionSnapshot`（每帧给 B1/main.ts）+ `InteractionEvent[]`（每帧 drain 给
 *   B1/B2/B3/Lead）+ `onLookTarget`（注视目标）+ `onMenuAction`（菜单动作）。
 *
 * DOM 层 `controller.ts` 只做「Window 事件 ↔ 本类方法」的适配 + 菜单渲染；
 * 因此本文件可在 vitest node 环境用合成事件序列完整测试。
 *
 * 时间：所有方法可传 `nowMs`（建议 `performance.now()` 口径）；未传时用注入的 `now()`，
 * 再退回全局 `performance.now()`。模块内不做任何真实计时/随机。
 */
import type { Rect } from '@shared/types'

import type {
  InteractionEvent,
  InteractionSnapshot,
  Point2D,
  PokeRegion
} from '../core/wave2-contract'
import { DragMachine, type DragTuning } from './drag-machine'
import { LookTracker, type LookTuning } from './look-tracker'
import {
  buildMenuItems,
  ContextMenuModel,
  DEFAULT_MENU_SIZE,
  type MenuAction,
  type MenuOpenState
} from './menu-model'
import { PatDetector, type PatTuning } from './pat-detector'
import { hitTestRegion } from './regions'

/** 事件队列上限（Lead 忘记 drain 时不会无限增长）。 */
export const MAX_PENDING_INTERACTION_EVENTS = 256

/** 注视目标回调的「变化死区」（px）：小于该变化的平滑推进不重复回调。 */
export const LOOK_EMIT_DEADBAND_PX = 0.5

/** 交互调参（控制器可选覆盖；缺省用各模块默认值）。 */
export interface InteractionTuning {
  drag?: Partial<DragTuning>
  pat?: Partial<PatTuning>
  look?: Partial<LookTuning>
}

/** 交互核心构造选项（与 `InteractionControllerOptions` 同源，去掉 DOM 相关内容）。 */
export interface InteractionCoreOptions {
  /** 当前宠物矩形（窗口本地 CSS px；null = 未渲染/不可交互）。 */
  getPetRect(): Rect | null
  /** 当前宠物高度（CSS px；用于「宠物是否就绪」的交叉校验）。 */
  getPetHeightPx(): number
  /** 交互是否启用（例如设置窗打开/非主屏时为 false）。 */
  isEnabled(): boolean
  /** 注入时钟（默认 performance.now）。 */
  now?(): number
  /** 注视目标变化回调（已做死区 + 平滑；null = 不注视）。 */
  onLookTarget?(target: Point2D | null): void
  /** 菜单动作回调（与 `menuAction` 事件同时发出，二选一消费即可）。 */
  onMenuAction?(action: MenuAction): void
  /** 读取自主活动开关（决定菜单开关项标签/勾选态；缺省视为开）。 */
  getAutonomous?(): boolean
  /** 视口尺寸（右键菜单钳制用；缺省 0×0 → 菜单只受 margin 约束）。 */
  getViewport?(): { width: number; height: number }
  /** 菜单初始尺寸估算（DOM 测量前；缺省 {@link DEFAULT_MENU_SIZE}）。 */
  initialMenuSize?: { width: number; height: number }
  /** 调参覆盖。 */
  tuning?: InteractionTuning
}

/** 默认时钟（不依赖 DOM；Node 22 / 浏览器都有 performance）。 */
function fallbackNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return 0
}

/** 点是否可用于交互（有限数）。 */
function isFinitePoint(point: Point2D | null | undefined): point is Point2D {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
}

/** 尺寸清洗（非法 → 默认估算值）。 */
function sanitizeSize(
  size: { width: number; height: number } | null | undefined
): { width: number; height: number } {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return { ...DEFAULT_MENU_SIZE }
  }
  return { width: Math.max(1, size.width), height: Math.max(1, size.height) }
}

/**
 * 交互核心（纯逻辑）。控制器持有一个实例；单测可直接驱动其方法。
 *
 * 事件语义速查（完整说明见 `interaction/README.md`）：
 * | 事件 | 触发 |
 * |---|---|
 * | `hoverEnter` / `hoverLeave` | 指针进入/离开宠物区域（菜单打开/拖动中视为离开） |
 * | `dragStart` | 左键按下后位移越过拖动阈值（默认 3px） |
 * | `dragMove` | 拖动中每次指针移动（pointer 为窗口本地 px） |
 * | `dragEnd` | 拖动松手；`throwVelocity` 为最近 ~120ms 指针速度估计（px/s） |
 * | `poke` | 短按（<250ms）且位移小；按按下位置分 head/body/leg |
 * | `pat` | 头部圆形轨迹累计角度达标（带冷却） |
 * | `menuAction` | 右键菜单项被选中 |
 */
export class InteractionCore {
  private readonly options: InteractionCoreOptions
  private readonly drag: DragMachine
  private readonly pat: PatDetector
  private readonly look: LookTracker
  private readonly menu = new ContextMenuModel()

  private pointer: Point2D | null = null
  private hovering = false
  /** 本次按下命中的区域（poke 用；null = 按在宠物外/无按下）。 */
  private pressRegion: PokeRegion | null = null
  private pendingEvents: InteractionEvent[] = []
  private lastEmittedLook: Point2D | null = null
  private menuSize: { width: number; height: number }

  constructor(options: InteractionCoreOptions) {
    this.options = options
    this.drag = new DragMachine(options.tuning?.drag)
    this.pat = new PatDetector(options.tuning?.pat)
    this.look = new LookTracker(options.tuning?.look)
    this.menuSize = sanitizeSize(options.initialMenuSize)
  }

  /* ------------------------------ 状态查询 ------------------------------ */

  /** 当前交互快照（每帧给 B1/main.ts；`patProgress` 按当前时钟计算含衰减）。 */
  getSnapshot(): InteractionSnapshot {
    const now = this.resolveNow()
    return {
      pointer: this.pointer ? { x: this.pointer.x, y: this.pointer.y } : null,
      hoveringPet: this.hovering && !this.menu.isOpen,
      dragging: this.drag.dragging,
      patProgress: roundTo(this.pat.progress(now), 3)
    }
  }

  /** 取走并清空本帧事件（Lead/main.ts 每帧调用一次）。 */
  drainEvents(): InteractionEvent[] {
    const events = this.pendingEvents
    this.pendingEvents = []
    return events
  }

  /** 右键菜单是否打开（main.ts 用它保持点击拦截）。 */
  isMenuOpen(): boolean {
    return this.menu.isOpen
  }

  /** 当前菜单状态（视图渲染/调试用；未打开为 null）。 */
  getMenuState(): MenuOpenState | null {
    return this.menu.currentState
  }

  /** 摸头检测器（调试/单测用；不要在外部改状态）。 */
  get patDetector(): PatDetector {
    return this.pat
  }

  /** 拖拽状态机（调试/单测用）。 */
  get dragMachine(): DragMachine {
    return this.drag
  }

  /** 注视跟踪器（调试/单测用）。 */
  get lookTracker(): LookTracker {
    return this.look
  }

  /* ------------------------------ 指针输入 ------------------------------ */

  /**
   * 左键/右键按下。
   *
   * - 菜单打开时：点菜单外 → 关闭菜单并吞掉本次按下（不开始拖拽/戳）；
   * - 左键按在宠物区域 → 进入拖拽候选（位移越过阈值后才算拖动）；
   * - 右键（`button === 'right'`）不在这里处理，由 `contextMenu()` 打开菜单。
   */
  pointerDown(pointer: Point2D, button: 'left' | 'right' = 'left', nowMs?: number): void {
    if (!isFinitePoint(pointer)) return
    if (!this.options.isEnabled()) {
      this.suspend(this.resolveNow(nowMs))
      return
    }
    const now = this.resolveNow(nowMs)
    this.pointer = { x: pointer.x, y: pointer.y }
    // 菜单打开：点击外部关闭；点击菜单内部由 DOM 菜单视图自己处理。
    if (this.menu.isOpen) {
      if (this.menu.pointerDownOutside(pointer)) {
        this.afterMenuClosed()
      }
      return
    }
    if (button !== 'left') return
    const rect = this.options.getPetRect()
    const region = hitTestRegion(rect, pointer)
    this.pressRegion = region
    if (region === null) return
    // 按下即视为悬停（合成 mousedown 场景下可能没有前置 mousemove）。
    this.setHovering(true)
    this.pat.reset()
    this.drag.begin(pointer, now)
  }

  /** 指针移动：拖拽跟随 / 悬停切换 / 摸头轨迹 / 注视目标。 */
  pointerMove(pointer: Point2D, nowMs?: number): void {
    if (!isFinitePoint(pointer)) return
    if (!this.options.isEnabled()) {
      this.suspend(this.resolveNow(nowMs))
      return
    }
    const now = this.resolveNow(nowMs)
    this.pointer = { x: pointer.x, y: pointer.y }

    // 菜单打开时：宠物手势暂停（指针在菜单上移动只影响菜单高亮）。
    if (this.menu.isOpen) return

    // 1) 拖拽候选 / 拖动中：持续跟随（离开宠物矩形也继续）。
    if (this.drag.pressed) {
      const result = this.drag.move(pointer, now)
      if (result.started) {
        this.setHovering(false)
        this.emit({ kind: 'dragStart', pointer: { x: pointer.x, y: pointer.y } })
      } else if (result.dragging) {
        this.emit({ kind: 'dragMove', pointer: { x: pointer.x, y: pointer.y } })
      }
      this.followLook(pointer, now)
      return
    }

    // 2) 悬停切换（hoverEnter / hoverLeave）。
    const rect = this.options.getPetRect()
    const region = hitTestRegion(rect, pointer)
    this.setHovering(region !== null)

    // 3) 摸头圆形轨迹（悬停画圈；宠物高度无效时不做）。
    const petHeight = this.options.getPetHeightPx()
    if (Number.isFinite(petHeight) && petHeight > 0) {
      if (this.pat.sample(rect, pointer, now)) this.emit({ kind: 'pat' })
    }

    // 4) 注视目标（平滑跟随）。
    this.followLook(pointer, now)
  }

  /** 指针抬起：结束拖拽（甩出）或判定 poke。 */
  pointerUp(pointer: Point2D, nowMs?: number): void {
    if (!isFinitePoint(pointer)) return
    if (!this.options.isEnabled()) {
      this.suspend(this.resolveNow(nowMs))
      return
    }
    const now = this.resolveNow(nowMs)
    this.pointer = { x: pointer.x, y: pointer.y }
    if (this.menu.isOpen) return

    const result = this.drag.end(pointer, now)
    if (result.kind === 'dragEnd') {
      this.emit({
        kind: 'dragEnd',
        pointer: { x: result.pointer.x, y: result.pointer.y },
        throwVelocity: { ...result.throwVelocity }
      })
      this.refreshHover(pointer)
    } else if (result.kind === 'tap') {
      if (result.isPoke && this.pressRegion !== null) {
        this.emit({ kind: 'poke', region: this.pressRegion })
      }
      this.refreshHover(pointer)
    }
    this.pressRegion = null
    this.followLook(pointer, now)
  }

  /** 指针离开窗口：清空悬停/注视/摸头进度；拖动中视为松手（防止卡住）。 */
  pointerLeave(nowMs?: number): void {
    const now = this.resolveNow(nowMs)
    this.pointer = null
    if (this.drag.pressed) {
      const result = this.drag.end(null, now)
      if (result.kind === 'dragEnd') {
        this.emit({
          kind: 'dragEnd',
          pointer: { x: result.pointer.x, y: result.pointer.y },
          throwVelocity: { ...result.throwVelocity }
        })
      }
    }
    this.pressRegion = null
    this.setHovering(false)
    this.pat.reset()
    this.look.pointerMove(null, now)
    this.emitLookTarget(now, true)
  }

  /* ------------------------------ 右键菜单 ------------------------------ */

  /**
   * 右键：打开/重新定位菜单。
   *
   * @returns 菜单状态（控制器据此渲染 DOM）；不需要打开时返回 null
   */
  contextMenu(pointer: Point2D, nowMs?: number): MenuOpenState | null {
    if (!isFinitePoint(pointer)) return null
    if (!this.options.isEnabled()) return null
    const now = this.resolveNow(nowMs)
    this.pointer = { x: pointer.x, y: pointer.y }
    const rect = this.options.getPetRect()
    const region = hitTestRegion(rect, pointer)
    if (!this.menu.isOpen && region === null) return null
    // 右键打断摸头/拖拽候选（不会在右键时继续左键拖动）。
    // M-8：已进入拖动时必须先发 dragEnd（速度 0 收尾），否则 main.ts/B2 收不到结束事件，
    // 物理会永久停在 dragging（悬空/无重力/不能落地）；仅按下候选（未拖动）时静默取消。
    this.pat.reset()
    this.cancelDragWithEvent(now)
    this.pressRegion = null
    if (this.hovering) this.setHovering(false)
    // 菜单展开时宠物看向菜单（最后一个指针位置）。
    this.followLook(pointer, now)
    const viewport = this.options.getViewport?.() ?? { width: 0, height: 0 }
    this.menu.setViewport(viewport)
    const items = buildMenuItems({
      autonomous: this.options.getAutonomous?.() ?? true
    })
    return this.menu.open(pointer, viewport, this.menuSize, items)
  }

  /** DOM 实测菜单尺寸回填 → 重新钳制位置（返回新状态；菜单未打开为 null）。 */
  setMenuSize(size: { width: number; height: number }): MenuOpenState | null {
    this.menuSize = sanitizeSize(size)
    return this.menu.updateSize(this.menuSize)
  }

  /** 选中菜单动作（DOM 菜单点击/键盘 Enter 调用）：发事件 + 回调；成功返回 true。 */
  selectMenuAction(action: MenuAction): boolean {
    const selected = this.menu.select(action)
    if (!selected) return false
    this.emit({ kind: 'menuAction', action: selected })
    this.options.onMenuAction?.(selected)
    this.afterMenuClosed()
    return true
  }

  /** 关闭菜单（点击外部/ESC/禁用）。 */
  closeMenu(): void {
    if (!this.menu.isOpen) return
    this.menu.close()
    this.afterMenuClosed()
  }

  /**
   * 键盘处理（仅菜单打开时有效）：ESC 关闭、↑/↓ 移动高亮、Enter/空格选中。
   *
   * @returns `'close'` = 已关闭；`MenuAction` = 选中动作；null = 未处理/仅移动高亮
   */
  handleKey(key: string): MenuAction | 'close' | null {
    if (!this.menu.isOpen) return null
    const result = this.menu.handleKey(key)
    if (result === 'close') {
      this.afterMenuClosed()
      return 'close'
    }
    if (result) {
      this.emit({ kind: 'menuAction', action: result })
      this.options.onMenuAction?.(result)
      this.afterMenuClosed()
      return result
    }
    return null
  }

  /* ------------------------------ 每帧推进 ------------------------------ */

  /**
   * 每帧推进（main.ts 在 drainEvents 前调用一次）：
   * 推进注视平滑 + 处理「交互被禁用」的收尾（发 dragEnd/hoverLeave/注视 null）。
   */
  tick(nowMs?: number): void {
    const now = this.resolveNow(nowMs)
    if (!this.options.isEnabled()) {
      this.suspend(now)
      return
    }
    if (this.menu.isOpen) return
    this.emitLookTarget(now)
  }

  /** 全部状态复位（detach/测试用；会清空事件队列）。 */
  reset(): void {
    this.drag.cancel()
    this.pat.reset()
    this.look.reset()
    this.menu.close()
    this.pointer = null
    this.hovering = false
    this.pressRegion = null
    this.pendingEvents = []
    if (this.lastEmittedLook !== null) {
      this.lastEmittedLook = null
      this.options.onLookTarget?.(null)
    }
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  /** 解析时间：优先显式传入 → 注入时钟 → 全局 performance.now。 */
  private resolveNow(nowMs?: number): number {
    if (Number.isFinite(nowMs)) return nowMs as number
    const injected = this.options.now?.()
    return Number.isFinite(injected) ? (injected as number) : fallbackNow()
  }

  /** 注视跟随：更新 tracker 目标 + 推进平滑 + 回调。 */
  private followLook(pointer: Point2D, now: number): void {
    this.look.pointerMove(pointer, now)
    this.emitLookTarget(now)
  }

  /** 推进平滑并触发 `onLookTarget`（带输出死区）。 */
  private emitLookTarget(now: number, force = false): void {
    const target = this.look.sample(now)
    if (target === null) {
      // 只在由「有目标」变「无目标」时回调一次 null，避免每帧重复回调。
      if (this.lastEmittedLook !== null) {
        this.lastEmittedLook = null
        this.options.onLookTarget?.(null)
      }
      return
    }
    const last = this.lastEmittedLook
    if (!force && last) {
      const moved = Math.hypot(target.x - last.x, target.y - last.y)
      if (moved < LOOK_EMIT_DEADBAND_PX) return
    }
    this.lastEmittedLook = { x: target.x, y: target.y }
    this.options.onLookTarget?.({ x: target.x, y: target.y })
  }

  /** 设置悬停状态（仅在变化时发事件）。 */
  private setHovering(next: boolean): void {
    if (this.hovering === next) return
    this.hovering = next
    this.emit(next ? { kind: 'hoverEnter' } : { kind: 'hoverLeave' })
  }

  /** 按当前指针位置重新计算悬停（拖动结束/菜单关闭后调用）。 */
  private refreshHover(pointer: Point2D): void {
    const region = hitTestRegion(this.options.getPetRect(), pointer)
    this.setHovering(region !== null)
  }

  /** 菜单关闭后的收尾：指针仍悬停在宠物上则补发 hoverEnter。 */
  private afterMenuClosed(): void {
    if (!this.pointer) return
    this.refreshHover(this.pointer)
  }

  /**
   * 取消拖拽（右键打断/打开菜单等）：
   * - 已进入拖动 → 先 `end()` 产生 dragEnd 事件（甩出速度强制 0，避免右键把宠物甩飞），
   *   让 main.ts 转发 `runtime.endDrag` → B2 退出 dragging；
   * - 仅按下候选（未越过拖动阈值）→ 静默清状态，不产生 dragEnd（避免凭空播放结束表演）。
   */
  private cancelDragWithEvent(now: number): void {
    if (!this.drag.dragging) {
      this.drag.cancel()
      return
    }
    const result = this.drag.end(null, now)
    if (result.kind === 'dragEnd') {
      this.emit({
        kind: 'dragEnd',
        pointer: { x: result.pointer.x, y: result.pointer.y },
        throwVelocity: { x: 0, y: 0 }
      })
    }
  }

  /** 交互被禁用/失焦：收尾所有进行中的手势。 */
  private suspend(now: number): void {
    if (this.drag.pressed) {
      const result = this.drag.end(null, now)
      if (result.kind === 'dragEnd') {
        this.emit({
          kind: 'dragEnd',
          pointer: { x: result.pointer.x, y: result.pointer.y },
          throwVelocity: { ...result.throwVelocity }
        })
      }
    }
    this.pressRegion = null
    this.setHovering(false)
    this.pat.reset()
    if (this.menu.isOpen) this.menu.close()
    this.look.pointerMove(null, now)
    this.emitLookTarget(now, true)
  }

  /** 记录一个事件（同时裁剪队列上限）。 */
  private emit(event: InteractionEvent): void {
    this.pendingEvents.push(event)
    if (this.pendingEvents.length > MAX_PENDING_INTERACTION_EVENTS) {
      this.pendingEvents.splice(0, this.pendingEvents.length - MAX_PENDING_INTERACTION_EVENTS)
    }
  }
}

/** 保留 digits 位小数（避免快照里出现长浮点）。 */
function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
