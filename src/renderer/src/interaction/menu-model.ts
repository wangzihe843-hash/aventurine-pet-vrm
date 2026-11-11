/**
 * 右键菜单模型（B4；纯逻辑，**不 import DOM**，可在 node 单测）。
 *
 * 负责「状态 + 语义」，不负责渲染：DOM 菜单由 `menu-view.ts` 依据本模型渲染，
 * 控制器（`controller.ts`）把 DOM 事件转成本模型的方法调用。
 *
 * 菜单项（固定顺序，`InteractionEvent.menuAction` 的 action 集合）：
 * `settings`（设置…）/ `hide`（隐藏）/ `toggleAutonomous`（自主活动开关，带勾选态）/ `quit`（退出）。
 *
 * 交互规则：
 * - 打开时把锚点（鼠标位置）按视口大小钳制，保证菜单四项全部可见；
 * - 点击菜单外 → 关闭（返回 true，控制器可吞掉这次点击）；
 * - Escape → 关闭；↑/↓ 切换高亮（activeIndex，-1 = 无高亮）；Enter/空格 → 选中高亮项；
 * - 选中/关闭都只改状态，真正的动作执行（打开设置窗/隐藏/退出）由 Lead 消费 `menuAction` 事件。
 */
import type { PetSize, Point2D } from '../core/wave2-contract'

/** 菜单动作（与 `InteractionEvent.menuAction` 的 action 一致）。 */
export type MenuAction = 'settings' | 'hide' | 'toggleAutonomous' | 'quit'

/** 菜单动作顺序（渲染顺序 = 此顺序）。 */
export const MENU_ACTIONS: readonly MenuAction[] = [
  'settings',
  'hide',
  'toggleAutonomous',
  'quit'
]

/** 菜单项类型：普通项 / 开关项。 */
export type MenuItemKind = 'item' | 'toggle'

/** 一个菜单项（视图渲染 + 语义都够用）。 */
export interface MenuItemModel {
  action: MenuAction
  label: string
  kind: MenuItemKind
  /** 开关项的勾选态（`kind === 'toggle'` 时有效）。 */
  checked?: boolean
  /** 是否危险/破坏性动作（退出用红色样式）。 */
  destructive?: boolean
  /** 是否在渲染时于该项上方画分隔线（退出项用）。 */
  separatorBefore?: boolean
}

/** 菜单打开时的完整状态（视图渲染用；position 已按视口钳制）。 */
export interface MenuOpenState {
  open: boolean
  /** 菜单左上角（窗口本地 CSS px，已钳制进视口）。 */
  position: Point2D
  /** 打开锚点（鼠标位置；重新测量尺寸后用于重新钳制）。 */
  anchor: Point2D
  /** 菜单尺寸（CSS px；DOM 测量后回填，缺省为估算值）。 */
  size: PetSize
  items: MenuItemModel[]
  /** 键盘高亮下标（-1 = 无）。 */
  activeIndex: number
}

/** 菜单到窗口边缘的最小安全边距（CSS px）。 */
export const MENU_SAFE_MARGIN_PX = 6

/** DOM 测量前的菜单估算尺寸（CSS px；四项 + padding）。 */
export const DEFAULT_MENU_SIZE: PetSize = { width: 184, height: 148 }

/** 构建菜单项（`autonomous` 影响开关项标签与勾选态）。 */
export function buildMenuItems(options: { autonomous?: boolean } = {}): MenuItemModel[] {
  const autonomous = options.autonomous !== false
  return [
    { action: 'settings', label: '设置…', kind: 'item' },
    { action: 'hide', label: '隐藏桌宠', kind: 'item' },
    {
      action: 'toggleAutonomous',
      label: `自主活动：${autonomous ? '开' : '关'}`,
      kind: 'toggle',
      checked: autonomous
    },
    { action: 'quit', label: '退出', kind: 'item', destructive: true, separatorBefore: true }
  ]
}

/** 数值钳制（非法输入 → min）。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (min > max) return min
  return Math.min(max, Math.max(min, value))
}

/** 尺寸是否合法（有限且为正），否则用默认。 */
function sanitizeSize(size: PetSize | null | undefined): PetSize {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return { ...DEFAULT_MENU_SIZE }
  }
  return {
    width: Math.max(1, size.width),
    height: Math.max(1, size.height)
  }
}

/**
 * 计算菜单左上角：以锚点为默认位置，贴到窗口右/下边缘时向左/上回退，
 * 保证菜单整体在视口内（含 `marginPx` 安全边距）。
 */
export function clampMenuPosition(
  anchor: Point2D,
  size: PetSize,
  viewport: PetSize,
  marginPx: number = MENU_SAFE_MARGIN_PX
): Point2D {
  const safeSize = sanitizeSize(size)
  const margin =
    Number.isFinite(marginPx) && marginPx >= 0 ? marginPx : MENU_SAFE_MARGIN_PX
  const viewportWidth =
    viewport && Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 0
  const viewportHeight =
    viewport && Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 0
  const anchorX = Number.isFinite(anchor?.x) ? anchor.x : margin
  const anchorY = Number.isFinite(anchor?.y) ? anchor.y : margin
  const maxX = Math.max(margin, viewportWidth - safeSize.width - margin)
  const maxY = Math.max(margin, viewportHeight - safeSize.height - margin)
  return {
    x: clamp(anchorX, margin, maxX),
    y: clamp(anchorY, margin, maxY)
  }
}

/**
 * 右键菜单状态机（纯逻辑）。
 *
 * 视图/控制器需要的能力：`open` / `close` / `updateSize`（DOM 实测后重新钳制）/
 * `containsPoint`（判断点击是否在菜单内）/ `select` / `handleKey` / `pointerDownOutside`。
 */
export class ContextMenuModel {
  private state: MenuOpenState | null = null
  private readonly marginPx: number
  /** 打开菜单时的视口尺寸（DOM 实测尺寸回填后重新钳制位置用）。 */
  private viewport: PetSize = { width: 0, height: 0 }

  constructor(options: { marginPx?: number } = {}) {
    this.marginPx =
      Number.isFinite(options.marginPx) && (options.marginPx as number) >= 0
        ? (options.marginPx as number)
        : MENU_SAFE_MARGIN_PX
  }

  /** 菜单是否打开。 */
  get isOpen(): boolean {
    return this.state !== null
  }

  /** 当前状态只读拷贝（未打开时 null）。 */
  get currentState(): MenuOpenState | null {
    return this.state ? cloneState(this.state) : null
  }

  /** 当前高亮下标（-1 = 无；未打开时 -1）。 */
  get activeIndex(): number {
    return this.state ? this.state.activeIndex : -1
  }

  /** 以鼠标位置为锚点打开菜单（已打开时重新定位，保持高亮不变）。 */
  open(
    anchor: Point2D,
    viewport: PetSize,
    size: PetSize = DEFAULT_MENU_SIZE,
    items: MenuItemModel[] = buildMenuItems()
  ): MenuOpenState {
    const safeItems = items.length > 0 ? items.map((item) => ({ ...item })) : buildMenuItems()
    const safeSize = sanitizeSize(size)
    const safeAnchor: Point2D = {
      x: Number.isFinite(anchor?.x) ? anchor.x : this.marginPx,
      y: Number.isFinite(anchor?.y) ? anchor.y : this.marginPx
    }
    const activeIndex = this.state
      ? Math.min(this.state.activeIndex, safeItems.length - 1)
      : -1
    this.viewport = sanitizeSize(viewport)
    this.state = {
      open: true,
      anchor: safeAnchor,
      position: clampMenuPosition(safeAnchor, safeSize, viewport, this.marginPx),
      size: safeSize,
      items: safeItems,
      activeIndex
    }
    return cloneState(this.state)
  }

  /** DOM 实测尺寸回填 → 按新尺寸重新钳制位置（返回新状态；未打开时 null）。 */
  updateSize(size: PetSize): MenuOpenState | null {
    if (!this.state) return null
    const safeSize = sanitizeSize(size)
    this.state.size = safeSize
    this.state.position = clampMenuPosition(
      this.state.anchor,
      safeSize,
      this.viewport,
      this.marginPx
    )
    return cloneState(this.state)
  }

  /** 记录打开时的视口尺寸（`open` 会自行记录；此方法供控制器在尺寸变化后主动更新）。 */
  setViewport(viewport: PetSize): void {
    this.viewport = sanitizeSize(viewport)
  }

  /** 关闭菜单（幂等）。 */
  close(): void {
    this.state = null
  }

  /** 菜单矩形是否包含某点（用于「点击菜单外 → 关闭」判定）。 */
  containsPoint(pointer: Point2D | null | undefined): boolean {
    if (!this.state || !pointer) return false
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false
    const { position, size } = this.state
    return (
      pointer.x >= position.x &&
      pointer.x < position.x + size.width &&
      pointer.y >= position.y &&
      pointer.y < position.y + size.height
    )
  }

  /** 设置键盘高亮下标（越界 → -1；返回实际下标）。 */
  setActiveIndex(index: number): number {
    if (!this.state) return -1
    const count = this.state.items.length
    if (!Number.isFinite(index) || index < 0 || index >= count) {
      this.state.activeIndex = -1
    } else {
      this.state.activeIndex = Math.floor(index)
    }
    return this.state.activeIndex
  }

  /** 键盘上下移动高亮（循环；从 -1 开始：向下到 0、向上到末项；返回新下标）。 */
  moveActive(delta: number): number {
    if (!this.state || this.state.items.length === 0) return -1
    const count = this.state.items.length
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
    if (step === 0) return this.state.activeIndex
    const current = this.state.activeIndex
    const next = current < 0 ? (step > 0 ? 0 : count - 1) : ((current + step) % count + count) % count
    this.state.activeIndex = next
    return next
  }

  /**
   * 选中某个 action：若菜单打开且 action 在菜单项里 → 关闭菜单并返回该 action；
   * 否则返回 null（不改变状态）。
   */
  select(action: MenuAction): MenuAction | null {
    if (!this.state) return null
    const matched = this.state.items.find((item) => item.action === action)
    if (!matched) return null
    this.state = null
    return matched.action
  }

  /** 选中当前高亮项（无高亮 → null）。 */
  selectActive(): MenuAction | null {
    if (!this.state || this.state.activeIndex < 0) return null
    const item = this.state.items[this.state.activeIndex]
    return item ? this.select(item.action) : null
  }

  /**
   * 键盘处理：Escape 关闭；ArrowUp/ArrowDown 移动高亮；Enter/Space 选中高亮项。
   *
   * @returns `'close'` = 已关闭；`MenuAction` = 选中动作（已关闭）；`null` = 未处理/仅移动高亮
   */
  handleKey(key: string): MenuAction | 'close' | null {
    if (!this.state) return null
    if (key === 'Escape' || key === 'Esc') {
      this.close()
      return 'close'
    }
    if (key === 'ArrowDown') {
      this.moveActive(1)
      return null
    }
    if (key === 'ArrowUp') {
      this.moveActive(-1)
      return null
    }
    if (key === 'Enter' || key === ' ') {
      return this.selectActive()
    }
    return null
  }

  /**
   * 左键按下：点在菜单外 → 关闭并返回 true（控制器应吞掉这次点击）；
   * 点在菜单内/菜单未打开 → false，状态不变。
   */
  pointerDownOutside(pointer: Point2D | null | undefined): boolean {
    if (!this.state) return false
    if (this.containsPoint(pointer)) return false
    this.close()
    return true
  }

}

/** 深拷贝（防止视图/调用方改到内部状态）。 */
function cloneState(state: MenuOpenState): MenuOpenState {
  return {
    open: state.open,
    position: { ...state.position },
    anchor: { ...state.anchor },
    size: { ...state.size },
    items: state.items.map((item) => ({ ...item })),
    activeIndex: state.activeIndex
  }
}
