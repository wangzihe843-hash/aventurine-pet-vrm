/**
 * 交互控制器（B4 的 DOM 层；**本文件负责 Window 事件绑定与右键菜单渲染**）。
 *
 * 职责边界：
 * - 本文件只做「DOM 事件 → `InteractionCore`（纯逻辑）方法」的适配、右键菜单 DOM 视图的
 *   创建/定位/销毁，以及 `drainEvents` 时把事件转发给 `onEvents`；
 * - 命中/拖拽/摸头/戳/注视/菜单状态全部在 `interaction-core.ts`（可单测）；
 * - 与既有 `pointer-gate.ts` 的关系：**并行共存**。main.ts 已挂的 mousemove/mouseleave 监听
 *   继续驱动 PointerGate；本控制器只**新增**自己的监听，不 remove、不 stopPropagation
 *   （菜单内部事件除外），因此不会破坏 Wave 1 的悬停穿透逻辑。
 *
 * Lead 接线（详见 `interaction/README.md`）：
 * ```ts
 * const interaction = new InteractionController({
 *   getPetRect: () => (currentLayout?.renderPet ? currentRect : null),
 *   getPetHeightPx: () => currentLayout?.petHeightPx ?? 0,
 *   isEnabled: () => true,
 *   onLookTarget: (target) => { lookTarget = target },      // 给 B1/B3
 *   onMenuAction: (action) => { 执行设置/隐藏/退出 },        // 或消费 menuAction 事件
 *   getAutonomous: () => config.autonomous
 * })
 * interaction.attach(window)
 * // 每帧：
 * const snapshot = interaction.getSnapshot()
 * const events = interaction.drainEvents()
 * pointerGate.update({ forceIntercept: snapshot.dragging || interaction.isMenuOpen() })
 * ```
 */
import type { Rect } from '@shared/types'

import type {
  InteractionEvent,
  InteractionSnapshot,
  Point2D
} from '../core/wave2-contract'
import { InteractionCore, type InteractionTuning } from './interaction-core'
import type { MenuAction, MenuOpenState } from './menu-model'
import { ContextMenuView } from './menu-view'

/** 控制器构造选项（docs/wave2-integration.md §3-B4 冻结签名 + 可选扩展字段）。 */
export interface InteractionControllerOptions {
  /** 当前宠物矩形（窗口本地 CSS px；null = 不可交互）。 */
  getPetRect(): Rect | null
  /** 当前宠物高度（CSS px；宠物未就绪时返回 0 可关闭摸头检测）。 */
  getPetHeightPx(): number
  /** 交互是否启用（例如设置面板打开/非主屏时可关闭）。 */
  isEnabled(): boolean
  /** 事件回调（可选；与 `drainEvents()` 二选一，**不要同时消费**，否则会重复处理）。 */
  onEvents?(events: InteractionEvent[]): void
  /** 注视目标回调（窗口本地 px；null = 不注视）。 */
  onLookTarget(target: Point2D | null): void
  /** 菜单动作回调（可选；`menuAction` 事件同样会发出）。 */
  onMenuAction?(action: MenuAction): void
  /** 读取自主活动开关（决定菜单开关项标签/勾选态；缺省视为开）。 */
  getAutonomous?(): boolean
  /** 注入时钟（ms；缺省 performance.now）。 */
  now?(): number
  /** 调参覆盖（拖拽阈值/摸头冷却等；缺省用各模块默认值）。 */
  tuning?: InteractionTuning
}

/** 控制器内部保存的 DOM 监听（detach 时逐一移除）。 */
interface BoundListener {
  type: keyof WindowEventMap
  handler: (event: Event) => void
}

/**
 * 交互控制器（单例；overlay 页每个 renderer 一个）。
 *
 * 生命周期：`attach(window)` 一次 → 每帧 `getSnapshot()` / `drainEvents()` → 退出/热重载
 * `detach()`（或 `destroy()`）。
 */
export class InteractionController {
  private readonly options: InteractionControllerOptions
  private readonly core: InteractionCore
  private readonly menuView: ContextMenuView
  private readonly listeners: BoundListener[]
  private target: Window | null = null

  constructor(options: InteractionControllerOptions) {
    this.options = options
    this.core = new InteractionCore({
      getPetRect: () => options.getPetRect(),
      getPetHeightPx: () => options.getPetHeightPx(),
      isEnabled: () => options.isEnabled(),
      now: () => this.now(),
      onLookTarget: (target) => options.onLookTarget(target),
      onMenuAction: options.onMenuAction ? (action) => options.onMenuAction?.(action) : undefined,
      getAutonomous: options.getAutonomous ? () => options.getAutonomous?.() ?? true : undefined,
      getViewport: () => this.viewport(),
      tuning: options.tuning
    })
    this.menuView = new ContextMenuView({
      onSelect: (action) => this.handleMenuSelect(action)
    })
    this.listeners = [
      { type: 'mousemove', handler: (event) => this.handleMouseMove(event as MouseEvent) },
      { type: 'mousedown', handler: (event) => this.handleMouseDown(event as MouseEvent) },
      { type: 'mouseup', handler: (event) => this.handleMouseUp(event as MouseEvent) },
      { type: 'mouseleave', handler: (event) => this.handleMouseLeave(event as MouseEvent) },
      { type: 'contextmenu', handler: (event) => this.handleContextMenu(event as MouseEvent) },
      { type: 'keydown', handler: (event) => this.handleKeyDown(event as KeyboardEvent) }
    ]
  }

  /** 绑定 window 事件（重复 attach 同一 target 幂等；换 target 会先 detach 旧 target）。 */
  attach(target: Window): void {
    if (this.target === target) return
    if (this.target) this.detach()
    this.target = target
    for (const listener of this.listeners) {
      target.addEventListener(listener.type, listener.handler)
    }
  }

  /** 解绑 window 事件并复位内部状态（不销毁菜单 DOM，下一次 attach 可复用；退出时用 destroy）。 */
  detach(): void {
    const target = this.target
    if (target) {
      for (const listener of this.listeners) {
        target.removeEventListener(listener.type, listener.handler)
      }
    }
    this.target = null
    this.menuView.hide()
    this.core.reset()
  }

  /** 解绑并销毁菜单 DOM（renderer 卸载/热重载时调用）。 */
  destroy(): void {
    this.detach()
    this.menuView.destroy()
  }

  /** 当前交互快照（每帧给 B1/main.ts；字段见 `InteractionSnapshot`）。 */
  getSnapshot(): InteractionSnapshot {
    return this.core.getSnapshot()
  }

  /**
   * 每帧调用：推进注视平滑 → 同步菜单可见性 → 取走并清空本帧事件。
   * 若构造时给了 `onEvents`，本帧事件也会回调一次（与返回值相同，勿重复消费）。
   */
  drainEvents(): InteractionEvent[] {
    this.core.tick(this.now())
    this.syncMenuVisibility()
    const events = this.core.drainEvents()
    if (events.length > 0) this.options.onEvents?.(events)
    return events
  }

  /** 右键菜单是否打开（main.ts 用它保持点击拦截：`pointerGate.update({ forceIntercept })`）。 */
  isMenuOpen(): boolean {
    return this.core.isMenuOpen()
  }

  /* ------------------------------ DOM 事件适配 ------------------------------ */

  private handleMouseMove(event: MouseEvent): void {
    this.core.pointerMove(this.pointOf(event), this.timeOf(event))
  }

  private handleMouseDown(event: MouseEvent): void {
    // 菜单内部的按下由菜单视图自己处理（视图已在根节点 stopPropagation，这里再兜底一次）。
    if (this.menuView.contains(event.target)) return
    const button = event.button === 2 ? 'right' : event.button === 0 ? 'left' : null
    if (!button) return
    this.core.pointerDown(this.pointOf(event), button, this.timeOf(event))
    // 点击菜单外关闭菜单：立即隐藏 DOM（不等下一帧 drain 同步）。
    if (!this.core.isMenuOpen()) this.menuView.hide()
  }

  private handleMouseUp(event: MouseEvent): void {
    if (this.menuView.contains(event.target)) return
    this.core.pointerUp(this.pointOf(event), this.timeOf(event))
  }

  private handleMouseLeave(_event: MouseEvent): void {
    this.core.pointerLeave(this.now())
    // 指针离开窗口时关闭右键菜单（鼠标已不可能点到菜单项）。
    this.core.closeMenu()
    this.menuView.hide()
  }

  private handleContextMenu(event: MouseEvent): void {
    event.preventDefault()
    if (this.menuView.contains(event.target)) return
    const state = this.core.contextMenu(this.pointOf(event), this.timeOf(event))
    if (state) {
      this.renderMenu(state)
      return
    }
    // 宠物外右键：不打开菜单；若菜单已打开则关闭。
    this.menuView.hide()
    this.core.closeMenu()
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.core.isMenuOpen()) return
    const result = this.core.handleKey(event.key)
    if (result === 'close' || result) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (result !== null) {
      this.menuView.hide()
      return
    }
    // 方向键：刷新高亮。
    const state = this.core.getMenuState()
    this.menuView.setActiveIndex(state ? state.activeIndex : -1)
  }

  /* ------------------------------ 菜单 ------------------------------ */

  /** 菜单项被点击：核心负责发事件/回调并关闭模型状态，视图负责隐藏。 */
  private handleMenuSelect(action: MenuAction): void {
    const selected = this.core.selectMenuAction(action)
    if (selected) this.menuView.hide()
  }

  /** 渲染菜单：先渲染，再按 DOM 实测尺寸重新钳制位置。 */
  private renderMenu(state: MenuOpenState): void {
    if (!state) return
    this.menuView.render(state)
    const measured = this.menuView.measure()
    if (!measured) return
    const updated = this.core.setMenuSize(measured)
    if (updated) {
      this.menuView.position(updated.position)
      this.menuView.setActiveIndex(updated.activeIndex)
    }
  }

  /** 每帧同步菜单可见性（核心状态与 DOM 不一致时纠正）。 */
  private syncMenuVisibility(): void {
    if (this.menuView.visible && !this.core.isMenuOpen()) {
      this.menuView.hide()
    }
  }

  /* ------------------------------ 辅助 ------------------------------ */

  /** 事件坐标 → 窗口本地 CSS px。 */
  private pointOf(event: MouseEvent): Point2D {
    return { x: event.clientX, y: event.clientY }
  }

  /** 事件时间戳（MouseEvent.timeStamp 与 performance.now 同口径）；异常时用注入时钟。 */
  private timeOf(event: MouseEvent): number {
    const stamp = event.timeStamp
    if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) return stamp
    return this.now()
  }

  /** 当前时钟（注入优先）。 */
  private now(): number {
    const injected = this.options.now?.()
    if (Number.isFinite(injected)) return injected as number
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }
    return 0
  }

  /** 窗口视口尺寸（右键菜单位置钳制用）。 */
  private viewport(): { width: number; height: number } {
    if (typeof window === 'undefined') return { width: 0, height: 0 }
    return { width: window.innerWidth, height: window.innerHeight }
  }
}
