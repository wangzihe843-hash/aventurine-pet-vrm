/**
 * 宠物台词气泡（Wave 2 集成层，Lead-owned）
 *
 * 职责：把 B1/B7 产出的台词文本渲染成 overlay 窗口内的 DOM 气泡；不参与 3D、不抢焦点、
 * 不拦截鼠标（pointer-events: none）。只做展示与位置计算，**去重/持续时长由调用方 main.ts
 * 决定**（同一句在显示期间不重复 show 即可；`show` 可刷新计时）。
 *
 * 设计约束（PLAN §11/§19）：
 * - 气泡在宠物头顶上方，水平居中于宠物矩形，四边留 8px 安全边距（不贴窗口边缘/菜单栏）；
 * - 文本用 `textContent`（绝不 innerHTML，避免注入）；超长文本按 CSS 自动换行；
 * - 生命周期：`show()` 时按持续时长挂**独立定时器**过期（02 L-8：不依赖渲染帧；
 *   `update(nowMs)` 保留为时钟注入/定时器节流时的兜底）；`hide()` 先透明播 CSS 淡出，
 *   过渡结束后才 `visibility:hidden`（02 L-2：旧实现同帧 hidden 会让 opacity 过渡完全不播）；
 * - 性能：只在文本变化时做一次 `getBoundingClientRect` 测量并缓存；`place()` 在宠物矩形/
 *   视口不变时不重算、不写 style（02 L-3：旧实现每帧强制 reflow）；
 * - 与 B3 的「口型同步」解耦：B3 需要知道当前是否在说话 → main.ts 把 bubble.visible / text 传给
 *   `AnimationInput.bubbleText`（由 main.ts 组装，不直接引用本模块也可）。
 */
import type { Rect } from '@shared/types'

/** 气泡默认持续时长（ms）。 */
export const BUBBLE_DEFAULT_LIFETIME_MS = 4200

/** 气泡淡出时长（ms；与 style.css `.pet-bubble { transition: opacity 160ms ease }` 对齐 + 余量）。 */
export const BUBBLE_FADE_OUT_MS = 200

/** 文本测量失败时的兜底高度（CSS px）。 */
const BUBBLE_FALLBACK_HEIGHT_PX = 24

/** 气泡最大宽度（CSS px；官方语音有长句，340px 约 25–28 字/行，避免过高）。 */
export const BUBBLE_MAX_WIDTH_PX = 340

/** 气泡与宠物头顶的间距（px）。 */
const BUBBLE_GAP_PX = 10

/** 气泡距窗口边缘的最小安全边距（px）。 */
const BUBBLE_SAFE_MARGIN_PX = 8

/** 视口尺寸（CSS px）。 */
export interface BubbleViewport {
  width: number
  height: number
}

/** 气泡几何（窗口本地 CSS px、y 向下；供单测/调试）。 */
export interface BubbleRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 气泡位置计算（纯函数）：宠物矩形 → 气泡左上角；保证不出窗口、**尽量不盖住宠物**。
 *
 * 2026-11-10 用户反馈「趴下时头明明没顶到屏幕顶端，头还是被截掉了」：
 * 根因不是动画，而是气泡摆放——宠物坐在高窗沿/躺在窗沿时 `petRect.y` 可能为负（超出屏幕顶），
 * 旧逻辑把气泡回落到 `petRect.y + 8` 再钳到窗口内 → 气泡压住宠物头部/身体，看起来像"头被裁"。
 *
 * 新策略（按优先级）：
 * 1. **头顶上方**（放得下就保持原行为，水平居中）；
 * 2. **宠物侧面**（头顶被屏幕顶挡住时，放到左右侧、与宠物矩形水平分离）；
 * 3. **宠物下方**（两侧也没空间时的最后不遮挡方案）；
 * 4. 极端兜底：贴窗口顶（可能重叠，保证气泡可见）。
 */
export function computeBubblePosition(
  petRect: Rect,
  viewport: BubbleViewport,
  bubbleSize: { width: number; height: number }
): { x: number; y: number } {
  const safeWidth = Math.max(1, bubbleSize.width)
  const safeHeight = Math.max(1, bubbleSize.height)
  const margin = BUBBLE_SAFE_MARGIN_PX
  const maxX = Math.max(margin, viewport.width - safeWidth - margin)
  const maxY = Math.max(margin, viewport.height - safeHeight - margin)
  const centeredX = petRect.x + petRect.width / 2 - safeWidth / 2
  const aboveY = petRect.y - BUBBLE_GAP_PX - safeHeight

  // 1) 头顶放得下 → 正常居中摆放（不改变旧行为）。
  if (aboveY >= margin) {
    return { x: clamp(centeredX, margin, maxX), y: clamp(aboveY, margin, maxY) }
  }

  // 2) 头顶放不下（宠物贴顶 / 坐在高窗沿 / 躺在窗沿）→ 放左右侧面，避免盖住宠物。
  const rightX = petRect.x + petRect.width + BUBBLE_GAP_PX
  const leftX = petRect.x - BUBBLE_GAP_PX - safeWidth
  const rightFits = rightX <= viewport.width - margin
  const leftFits = leftX >= margin
  if (rightFits || leftFits) {
    // 两侧都放得下时选剩余空间更大的一侧；只有一侧放得下就用那侧。
    const rightRoom = viewport.width - margin - (rightX + safeWidth)
    const leftRoom = leftX - margin
    const useRight = rightFits && (!leftFits || rightRoom >= leftRoom)
    const x = useRight ? rightX : leftX
    // 竖直方向与宠物顶部对齐（宠物顶出屏时贴安全边距）。
    const y = clamp(petRect.y + BUBBLE_GAP_PX, margin, maxY)
    return { x: clamp(x, margin, maxX), y }
  }

  // 3) 两侧都放不下 → 放到宠物下方（与宠物矩形竖直分离）。
  const belowY = petRect.y + petRect.height + BUBBLE_GAP_PX
  if (belowY <= maxY) {
    return { x: clamp(centeredX, margin, maxX), y: belowY }
  }

  // 4) 极端兜底：贴窗口顶（可能重叠，但至少可见）。
  return { x: clamp(centeredX, margin, maxX), y: clamp(petRect.y + margin, margin, maxY) }
}

/** 数值钳制（非有限值回落 min）。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (min > max) return min
  return Math.min(max, Math.max(min, value))
}

/** 气泡控制器选项。 */
export interface BubbleViewOptions {
  /** 容器（#app）；不传则惰性创建并挂到 document.body。 */
  container?: HTMLElement
  /** 最大宽度（CSS px）。 */
  maxWidthPx?: number
}

/** 台词气泡视图（单例；main.ts 持有一个实例）。 */
export class BubbleView {
  private readonly element: HTMLDivElement
  private readonly maxWidthPx: number
  private visibleFlag = false
  private currentText = ''
  private expiresAtMs = 0
  /** 最近一次摆放的宠物矩形（用于气泡跟随宠物移动；null = 尚未摆放）。 */
  private lastPetRect: Rect | null = null
  private lastViewport: BubbleViewport | null = null
  /** 缓存的文本测量尺寸（仅在文本变化时重测，避免每帧强制 reflow）。 */
  private measuredWidth = 0
  private measuredHeight = 0
  /** 淡出结束后隐藏 visibility 的定时器（保证 opacity 过渡真正播放）。 */
  private fadeOutTimer: ReturnType<typeof setTimeout> | null = null
  /** 自驱动过期定时器（02 L-8：不依赖渲染帧）。 */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次写入的样式坐标（宠物/视口不变时避免每帧写 style）。 */
  private lastWrittenX: number | null = null
  private lastWrittenY: number | null = null

  constructor(options: BubbleViewOptions = {}) {
    const container = options.container ?? document.body
    this.maxWidthPx = options.maxWidthPx ?? BUBBLE_MAX_WIDTH_PX

    const element = document.createElement('div')
    element.className = 'pet-bubble'
    element.setAttribute('role', 'status')
    element.setAttribute('aria-live', 'polite')
    element.style.position = 'absolute'
    element.style.pointerEvents = 'none'
    element.style.maxWidth = `${this.maxWidthPx}px`
    element.style.opacity = '0'
    element.style.visibility = 'hidden'
    element.style.zIndex = '10'
    container.appendChild(element)
    this.element = element
  }

  /** 当前是否有可见气泡。 */
  get visible(): boolean {
    return this.visibleFlag
  }

  /** 当前气泡文本（不可见时为空字符串）。 */
  get text(): string {
    return this.visibleFlag ? this.currentText : ''
  }

  /** 显示台词（若已可见则刷新文本与计时）。 */
  show(text: string, nowMs: number, lifetimeMs = BUBBLE_DEFAULT_LIFETIME_MS): void {
    const normalized = typeof text === 'string' ? text.trim() : ''
    if (normalized.length === 0) {
      this.hide()
      return
    }
    const lifetime = Number.isFinite(lifetimeMs)
      ? Math.max(500, lifetimeMs)
      : BUBBLE_DEFAULT_LIFETIME_MS
    const textChanged = !this.visibleFlag || normalized !== this.currentText
    if (textChanged) {
      this.element.textContent = normalized
      this.currentText = normalized
      // 文本变化会改变气泡尺寸：标脏，下一次 applyPosition 重测（之后复用缓存）。
      this.measuredWidth = 0
      this.measuredHeight = 0
    }
    this.visibleFlag = true
    this.expiresAtMs = nowMs + lifetime
    // 取消上一次淡出，重新显示（淡出中途再次说话不会闪回 hidden）。
    if (this.fadeOutTimer !== null) {
      clearTimeout(this.fadeOutTimer)
      this.fadeOutTimer = null
    }
    this.element.style.visibility = 'visible'
    this.element.style.opacity = '1'
    // 02 L-8：独立定时器驱动过期，不依赖渲染帧是否还在跑；update(nowMs) 仅作兜底。
    this.scheduleExpiry(lifetime)
    this.applyPosition()
    // 文本变化会改变气泡尺寸，下一帧（重新布局后）再精确定位一次。
    if (textChanged && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        this.measuredWidth = 0
        this.measuredHeight = 0
        this.applyPosition()
      })
    }
  }

  /**
   * 每帧调用：过期后隐藏（CSS opacity 过渡负责淡出）。
   * 正常过期由 `show()` 挂的定时器驱动；本方法是**兜底**（调用方时钟注入/定时器被节流时）。
   */
  update(nowMs: number): void {
    if (!this.visibleFlag) return
    if (Number.isFinite(nowMs) && nowMs >= this.expiresAtMs) this.hide()
  }

  /** 更新宠物矩形/视口（布局或宠物移动后调用；气泡跟随）。 */
  place(petRect: Rect, viewport: BubbleViewport): void {
    const previousPetRect = this.lastPetRect
    const previousViewport = this.lastViewport
    this.lastPetRect = { ...petRect }
    this.lastViewport = { ...viewport }
    // 宠物静止/视口未变时不做任何重算与 style 写入（02 L-3：旧实现每帧强制 reflow）。
    if (
      previousPetRect &&
      previousViewport &&
      previousPetRect.x === petRect.x &&
      previousPetRect.y === petRect.y &&
      previousPetRect.width === petRect.width &&
      previousPetRect.height === petRect.height &&
      previousViewport.width === viewport.width &&
      previousViewport.height === viewport.height
    ) {
      return
    }
    this.applyPosition()
  }

  /** 隐藏：先播 opacity 淡出，过渡结束后再 `visibility:hidden`（02 L-2）。 */
  hide(): void {
    if (!this.visibleFlag) return
    this.visibleFlag = false
    this.currentText = ''
    this.clearExpiryTimer()
    this.element.style.opacity = '0'
    // 旧实现同一帧写 visibility:hidden，浏览器不会为「已不可见」的元素播放 opacity 过渡。
    if (this.fadeOutTimer !== null) clearTimeout(this.fadeOutTimer)
    this.fadeOutTimer = setTimeout(() => {
      this.fadeOutTimer = null
      if (!this.visibleFlag) this.element.style.visibility = 'hidden'
    }, BUBBLE_FADE_OUT_MS)
  }

  /** 气泡在窗口本地坐标中的矩形（调试/冒烟用；不可见时为 null）。 */
  rect(): BubbleRect | null {
    if (!this.visibleFlag) return null
    const rect = this.element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  /** 移除 DOM（app 退出/热重载时调用）。 */
  destroy(): void {
    this.clearExpiryTimer()
    if (this.fadeOutTimer !== null) {
      clearTimeout(this.fadeOutTimer)
      this.fadeOutTimer = null
    }
    this.element.remove()
    this.visibleFlag = false
    this.currentText = ''
    this.measuredWidth = 0
    this.measuredHeight = 0
  }

  /** 挂过期定时器（重复调用会先清掉旧定时器）。 */
  private scheduleExpiry(lifetimeMs: number): void {
    this.clearExpiryTimer()
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      this.hide()
    }, lifetimeMs)
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
  }

  /** 测量文本尺寸（只在文本变化/首次摆放时调用；缓存供后续复用）。 */
  private measure(): void {
    const measured = this.element.getBoundingClientRect()
    const fallbackWidth = this.lastPetRect
      ? Math.min(this.maxWidthPx, this.lastPetRect.width)
      : this.maxWidthPx
    this.measuredWidth = measured.width > 0 ? measured.width : fallbackWidth
    this.measuredHeight = measured.height > 0 ? measured.height : BUBBLE_FALLBACK_HEIGHT_PX
  }

  /** 按最近一次的宠物矩形与视口摆放气泡（幂等：尺寸已缓存，坐标未变时不写 style）。 */
  private applyPosition(): void {
    if (!this.visibleFlag || !this.lastPetRect || !this.lastViewport) return
    if (this.measuredWidth <= 0 || this.measuredHeight <= 0) this.measure()
    const position = computeBubblePosition(this.lastPetRect, this.lastViewport, {
      width: this.measuredWidth,
      height: this.measuredHeight
    })
    const x = Math.round(position.x)
    const y = Math.round(position.y)
    if (x === this.lastWrittenX && y === this.lastWrittenY) return
    this.lastWrittenX = x
    this.lastWrittenY = y
    this.element.style.left = `${x}px`
    this.element.style.top = `${y}px`
  }
}
