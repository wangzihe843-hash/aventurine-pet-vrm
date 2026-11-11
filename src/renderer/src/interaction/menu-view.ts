/**
 * 右键菜单的 DOM 视图（B4；**只有本文件接触 DOM**，由控制器调用）。
 *
 * 约束：
 * - 样式全部用**内联 style**（`style-src 'self' 'unsafe-inline'` 允许；不新增 CSS 文件、
 *   不改 A2 的 style.css，符合 Wave 2 文件所有权）；不内联 `<script>`、不 eval（CSP script-src 'self'）；
 * - 视觉与 Lead 的台词气泡（`.pet-bubble`）同一套「米白纸 + 金棕描边」语言；
 * - 挂到 `document.body`（overlay 页面本身透明、`#app` pointer-events:none）；
 * - 菜单内部的事件（mousedown/mouseup/click/contextmenu）在本元素上 stopPropagation，
 *   避免冒泡到 window 被宠物手势误判；菜单外事件仍由控制器/核心处理（点击外部关闭）。
 *
 * 只做渲染，不做状态判断（状态在 `menu-model.ts`）。
 */
import type { PetSize, Point2D } from '../core/wave2-contract'
import type { MenuAction, MenuOpenState } from './menu-model'

/** 菜单点击回调（控制器再转发给 `InteractionCore.selectMenuAction`）。 */
export interface ContextMenuViewHandlers {
  onSelect(action: MenuAction): void
}

/** 视觉参数（与 style.css 的 .pet-bubble 配色一致）。 */
const MENU_STYLE = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
  background: 'rgba(255, 250, 240, 0.97)',
  border: '1px solid rgba(120, 96, 56, 0.4)',
  color: '#1d1a16',
  destructiveColor: '#8b2f24',
  hoverBackground: 'rgba(212, 175, 55, 0.22)',
  separatorColor: 'rgba(120, 96, 56, 0.22)'
} as const

/**
 * 右键菜单 DOM 视图（单例；菜单关闭时元素保留、仅 display:none，重新打开复用）。
 */
export class ContextMenuView {
  private handlers: ContextMenuViewHandlers | null
  private root: HTMLDivElement | null = null
  private itemElements: HTMLElement[] = []
  private visibleFlag = false

  constructor(handlers: ContextMenuViewHandlers) {
    this.handlers = handlers
  }

  /** 菜单当前是否可见。 */
  get visible(): boolean {
    return this.visibleFlag
  }

  /** 根元素（测试/调试用；未创建时 null）。 */
  get element(): HTMLDivElement | null {
    return this.root
  }

  /** 渲染并显示菜单（`state` 来自 `ContextMenuModel.open/updateSize`）。 */
  render(state: MenuOpenState): void {
    const root = this.ensureRoot()
    root.textContent = ''
    this.itemElements = []
    for (const item of state.items) {
      const element = document.createElement('div')
      element.setAttribute('role', 'menuitem')
      element.tabIndex = -1
      element.dataset.action = item.action
      element.style.display = 'flex'
      element.style.alignItems = 'center'
      element.style.justifyContent = 'space-between'
      element.style.gap = '16px'
      element.style.padding = '6px 10px'
      element.style.borderRadius = '7px'
      element.style.cursor = 'default'
      element.style.whiteSpace = 'nowrap'
      element.style.fontSize = '13px'
      element.style.lineHeight = '1.3'
      element.style.color = item.destructive ? MENU_STYLE.destructiveColor : MENU_STYLE.color
      if (item.separatorBefore) {
        element.style.borderTop = `1px solid ${MENU_STYLE.separatorColor}`
        element.style.marginTop = '4px'
        element.style.paddingTop = '7px'
        element.style.borderTopLeftRadius = '0'
        element.style.borderTopRightRadius = '0'
      }

      const label = document.createElement('span')
      label.textContent = item.label
      element.appendChild(label)

      if (item.kind === 'toggle') {
        const check = document.createElement('span')
        check.textContent = item.checked ? '✓' : ''
        check.setAttribute('aria-hidden', 'true')
        check.style.color = 'rgba(120, 96, 56, 0.9)'
        check.style.fontSize = '12px'
        check.style.minWidth = '10px'
        check.style.textAlign = 'right'
        element.appendChild(check)
        element.setAttribute('role', 'menuitemcheckbox')
        element.setAttribute('aria-checked', item.checked ? 'true' : 'false')
      }

      element.addEventListener('mouseenter', () => this.applyHover(element, true))
      element.addEventListener('mouseleave', () => this.applyHover(element, false))
      element.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!this.visibleFlag) return
        this.handlers?.onSelect(item.action)
      })
      root.appendChild(element)
      this.itemElements.push(element)
    }
    this.visibleFlag = true
    root.style.display = 'flex'
    if (state.activeIndex >= 0 && this.itemElements[state.activeIndex]) {
      this.setActiveIndex(state.activeIndex)
    }
    this.position(state.position)
  }

  /** 更新菜单左上角位置（窗口本地 CSS px；已由模型钳制进视口）。 */
  position(position: Point2D): void {
    if (!this.root) return
    this.root.style.left = `${Math.round(position.x)}px`
    this.root.style.top = `${Math.round(position.y)}px`
  }

  /** 键盘高亮（-1 = 取消全部高亮）。 */
  setActiveIndex(index: number): void {
    for (let i = 0; i < this.itemElements.length; i += 1) {
      this.itemElements[i].style.background = i === index ? MENU_STYLE.hoverBackground : ''
    }
  }

  /** 实测菜单尺寸（用于位置重新钳制；不可见/未创建时 null）。 */
  measure(): PetSize | null {
    if (!this.root || !this.visibleFlag) return null
    const rect = this.root.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return { width: rect.width, height: rect.height }
  }

  /** 隐藏菜单（保留元素复用）。 */
  hide(): void {
    this.visibleFlag = false
    if (this.root) this.root.style.display = 'none'
  }

  /** 事件目标是否落在菜单内（控制器用来忽略菜单上的宠物手势）。 */
  contains(target: EventTarget | null): boolean {
    if (!this.root || !target) return false
    return typeof Node !== 'undefined' && target instanceof Node && this.root.contains(target)
  }

  /** 销毁 DOM（控制器 detach 时调用）。 */
  destroy(): void {
    this.root?.remove()
    this.root = null
    this.itemElements = []
    this.visibleFlag = false
    this.handlers = null
  }

  /** 懒创建根节点（只创建一次，事件监听绑在根上防冒泡）。 */
  private ensureRoot(): HTMLDivElement {
    if (this.root) return this.root
    const root = document.createElement('div')
    root.className = 'pet-context-menu'
    root.setAttribute('role', 'menu')
    root.style.position = 'fixed'
    root.style.display = 'flex'
    root.style.flexDirection = 'column'
    root.style.minWidth = '168px'
    root.style.padding = '5px'
    root.style.boxSizing = 'border-box'
    root.style.background = MENU_STYLE.background
    root.style.border = MENU_STYLE.border
    root.style.borderRadius = '10px'
    root.style.boxShadow = '0 6px 20px rgba(30, 24, 14, 0.22)'
    root.style.color = MENU_STYLE.color
    root.style.fontFamily = MENU_STYLE.fontFamily
    root.style.fontSize = '13px'
    root.style.zIndex = '2147483000'
    root.style.pointerEvents = 'auto'
    root.style.userSelect = 'none'
    root.style.setProperty('-webkit-app-region', 'no-drag')
    root.style.display = 'none'
    // 菜单自身的鼠标事件不冒泡到 window（避免被宠物手势/穿透状态机误判）。
    for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu'] as const) {
      root.addEventListener(type, (event: Event) => {
        event.stopPropagation()
        if (type === 'contextmenu') event.preventDefault()
      })
    }
    document.body.appendChild(root)
    this.root = root
    return root
  }

  /** 悬停高亮。 */
  private applyHover(element: HTMLElement, hovered: boolean): void {
    element.style.background = hovered ? MENU_STYLE.hoverBackground : ''
  }
}
