/**
 * 悬停命中 → 点击穿透切换（M-3 修复；纯逻辑，**不 import electron/three/DOM**，可在 node 单测）。
 *
 * 语义（PLAN §5-A1 / §17.5 P1-10）：
 * - overlay 窗口默认整体穿透（`setIgnoreMouseEvents(true, { forward: true })`），
 *   renderer 靠转发进来的 `mousemove` 做命中检测；
 * - 鼠标进入宠物矩形 → 切回拦截（ignore=false），以接收 click / mouseup；
 * - 鼠标离开矩形 / 离开窗口 → 恢复穿透；
 * - `clickThrough=false`（用户关闭默认穿透）→ 窗口内**恒定拦截**，与鼠标位置无关；
 * - 非主屏 / 宠物未渲染（rect 无效）→ **恒定穿透**（不能拦截透明空窗的输入）；
 * - B4 扩展 `forceIntercept`：拖动中 / 右键菜单打开时为 true → **强制拦截**
 *   （即使指针已离开宠物矩形，也要收到后续 mouseup / 菜单点击），优先级见 {@link PointerGateConfig}。
 *
 * 与主进程 `mouse-gate.ts` 的分工：主进程状态机已做「拦截 → 穿透延迟一帧（16ms）」
 * 的 mouseup 保护，renderer **不再额外延迟**；本模块只在目标状态**变化**时调用一次
 * 注入的 `setIgnoreMouse`，避免 IPC 抖动。
 *
 * 命中坐标是**窗口本地 CSS 像素**（与 `stats().petRect` 同一坐标系），DPR 不参与。
 */
import type { Rect } from '@shared/types'

/** 指针位置（窗口本地 CSS 像素，左上原点、y 向下）。 */
export interface PointerPoint {
  x: number
  y: number
}

/** 命中矩形时的鼠标状态（rect / 配置 / 是否渲染宠物）。 */
export interface PointerGateConfig {
  /** 宠物命中矩形（窗口本地 CSS px，y 向下）；null / 零面积 = 不可命中。 */
  rect: Rect | null
  /** 配置 `clickThrough`：true = 默认穿透，仅命中宠物时拦截；false = 恒拦截。 */
  clickThrough: boolean
  /** 是否渲染宠物（非主屏 / scene 未就绪 → false）。 */
  renderPet: boolean
  /**
   * B4 扩展：**强制拦截**（拖动中 / 右键菜单打开时由 main.ts 置 true）。
   *
   * 拖动/菜单期间指针可能离开宠物命中矩形（例如甩到桌面空地、菜单展开到宠物外），
   * 若仍按「仅悬停拦截」会切回穿透、丢失后续 mouseup/菜单点击 → 因此需要强制保持拦截。
   * 优先级：`renderPet=false`（透明空窗，永远穿透）> `forceIntercept` > `clickThrough=false` > 悬停命中。
   */
  forceIntercept: boolean
}

/**
 * 命中检测：窗口本地坐标 (clientX, clientY) 是否落在宠物矩形内。
 *
 * 采用半开区间 `[x, x+width) × [y, y+height)`：
 * - 左上边界命中的点算命中、右下边界（恰好等于 x+width / y+height）算未命中，
 *   相邻矩形不会重复命中；
 * - 非有限坐标 / 非法矩形（宽高 ≤ 0）一律不命中。
 */
export function hitTestPetRect(
  rect: Rect | null | undefined,
  clientX: number,
  clientY: number
): boolean {
  if (!rect) return false
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
  if (!(rect.width > 0) || !(rect.height > 0)) return false
  const { x, y, width, height } = rect
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return clientX >= x && clientX < x + width && clientY >= y && clientY < y + height
}

/**
 * 从模型渲染包围盒推导「指针命中矩形」。
 *
 * 背景（手工验收发现）：Wave 1 的 `computePetRect` 是**模型渲染包围盒**（含 T-pose 手臂、
 * 衣服/饰品的透明边缘），约 398×540 @50%。若直接拿整个包围盒做命中，右侧桌面图标
 * （位于包围盒内的透明区域）会被整片拦截（用户实测 PDF 图标点不开）。
 *
 * 临时策略（B4 会改为像素级命中）：命中区收缩为**躯干中心带**——宽度 = min(包围盒宽, 高×0.5)，
 * 水平居中、垂直保持全身。这样悬停躯干/头/腿仍会拦截（Wave 1 验收项可演示），
 * 但包围盒两侧的透明边缘（手臂外、桌面图标区）恢复点击穿透。
 */
export const POINTER_HIT_WIDTH_PER_HEIGHT = 0.5

export function computePointerHitRect(rect: Rect | null | undefined): Rect | null {
  if (!rect) return null
  const { x, y, width, height } = rect
  if (!(width > 0) || !(height > 0)) return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const hitWidth = Math.min(width, Math.max(1, height * POINTER_HIT_WIDTH_PER_HEIGHT))
  return { x: x + (width - hitWidth) / 2, y, width: hitWidth, height }
}

/**
 * 穿透状态机：把「鼠标位置 + 命中矩形 + 配置」归约为 ignore-mouse 目标值，
 * 且**只在变化时**调用注入的 `setIgnoreMouse`（调用方负责真正发 IPC）。
 */
export class PointerGate {
  private readonly setIgnoreMouse: (ignore: boolean) => void
  private config: PointerGateConfig
  private pointer: PointerPoint | null = null
  /** 最近一次已下发的状态（null = 尚未下发过）。 */
  private applied: boolean | null = null

  constructor(
    setIgnoreMouse: (ignore: boolean) => void,
    initialConfig: Partial<PointerGateConfig> = {}
  ) {
    this.setIgnoreMouse = setIgnoreMouse
    this.config = {
      rect: initialConfig.rect ?? null,
      clickThrough: initialConfig.clickThrough ?? true,
      renderPet: initialConfig.renderPet ?? false,
      forceIntercept: initialConfig.forceIntercept ?? false
    }
  }

  /** 最近一次已下发的 ignore-mouse 状态；尚未下发过为 null。 */
  get ignoreMouse(): boolean | null {
    return this.applied
  }

  /** 当前是否处于「拦截鼠标」状态（true = 已下发 ignore=false）。 */
  get intercepting(): boolean {
    return this.applied === false
  }

  /** 当前配置快照（测试/调试用；只读拷贝）。 */
  get currentConfig(): PointerGateConfig {
    return { ...this.config }
  }

  /**
   * 更新命中矩形 / 配置 / 可见性（布局、屏幕、配置热更后调用）。
   * 若鼠标当前在窗口内会立即按新状态重算；状态未变化时不下发。
   */
  update(patch: Partial<PointerGateConfig>): void {
    this.config = { ...this.config, ...patch }
    this.applyDesired()
  }

  /** 鼠标在窗口内移动（clientX/clientY = 窗口本地 CSS 像素）。非法坐标按离开处理。 */
  pointerMove(clientX: number, clientY: number): void {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      this.pointerLeave()
      return
    }
    this.pointer = { x: clientX, y: clientY }
    this.applyDesired()
  }

  /** 鼠标离开窗口（转发模式下也用来兜底「移出宠物」）。 */
  pointerLeave(): void {
    this.pointer = null
    this.applyDesired()
  }

  /** 仅计算目标状态，不下发（测试/调试用）。 */
  desiredIgnoreMouse(): boolean {
    const { rect, clickThrough, renderPet, forceIntercept } = this.config
    // 非主屏 / 宠物未渲染：透明空窗永远穿透，不吞下层输入。
    if (!renderPet) return true
    // B4：拖动中 / 右键菜单打开 → 强制拦截（即使指针已不在宠物矩形内）。
    if (forceIntercept) return false
    // clickThrough=false：用户要求窗口恒定拦截（与鼠标位置无关）。
    if (!clickThrough) return false
    // 默认穿透：只有当鼠标当前命中宠物矩形时才拦截。
    if (this.pointer === null) return true
    return !hitTestPetRect(rect, this.pointer.x, this.pointer.y)
  }

  /** 状态真正变化时下发一次（去抖：重复状态不重复调用注入函数）。 */
  private applyDesired(): void {
    const next = this.desiredIgnoreMouse()
    if (next === this.applied) return
    this.applied = next
    this.setIgnoreMouse(next)
  }
}
