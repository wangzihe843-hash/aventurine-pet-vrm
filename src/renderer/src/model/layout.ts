/**
 * 宠物尺寸 / 位置换算（纯函数，**不 import three**，可在 vitest node 环境直接单测）。
 *
 * 口径（PLAN §17.3-2 / §17.5 P1-7；覆盖 D6/§11 的旧冲突写法）：
 * - 尺寸基准：`display.bounds.height`（1080p 下 30% ≈ 324px、50% = 540px；与 workArea 无关）；
 *   但 100% 时 bounds（1080）大于 workArea（961），实际高度按 `workArea.height` 封顶，
 *   保证宠物不出窗（尺寸上限 100%，仍用 bounds 百分比语义）；
 * - 定位/渲染基准：`display.workArea`（overlay frame = workArea），脚底贴 workArea 底边；
 * - 窗口本地坐标 = 屏幕全局坐标 − `windowInfo.bounds` 原点（主屏上 y 通常从 30 起，不是 0）；
 *   **`windowInfo` 必须是最新一次 `pet:window-info` 的结果**（H-1：screens-updated / resize
 *   后 workArea 原点可能变化，A1 只 setBounds 不重建页面，不得用启动时快照）；
 * - Wave 1 只有主屏渲染宠物：用 `windowInfo.displayId` 对比 `DisplayInfo.isPrimary`。
 *
 * 说明：本模块只做「窗口内 CSS 像素」的换算；DPR 只影响 canvas backing store，
 * 不参与这里的任何数值（PLAN §17.3-2：命中检测/渲染坐标只用 DIP/CSS 像素）。
 */
import { CONFIG_LIMITS } from '@shared/config'
import type { DisplayInfo, OverlayWindowInfo, PetPosition, Rect } from '@shared/types'

/** 二维尺寸（CSS 像素）。 */
export interface Size2D {
  width: number
  height: number
}

/** 水平锚点：corner → 贴 workArea 右边缘；free → 居中（B2/B4 接管自由拖动前的占位行为）。 */
export type LayoutAnchor = 'right' | 'center'

/** `computePetLayout` 的输入（全部为冻结契约里的可序列化结构）。 */
export interface LayoutInput {
  sizePercent: number
  position: PetPosition
  windowInfo: Pick<OverlayWindowInfo, 'bounds' | 'displayId'>
  displays: readonly DisplayInfo[]
  /** 渲染窗口的 CSS 像素尺寸（= #app 的 clientWidth/clientHeight）。 */
  viewport: Size2D
}

/** 一次布局计算的结果（窗口本地坐标，CSS 像素，左上原点、y 向下）。 */
export interface PetLayout {
  /** 是否渲染宠物（Wave 1 仅主屏）。 */
  renderPet: boolean
  /** 窗口所在显示器；无匹配时为 null。 */
  display: DisplayInfo | null
  /** 窗口是否在主屏（= display.isPrimary）。 */
  isPrimaryDisplay: boolean
  /** 宠物（模型全身）目标高度，CSS 像素。 */
  petHeightPx: number
  /** 水平锚点。 */
  anchor: LayoutAnchor
  /** 贴右边缘时宠物矩形右边缘的本地 x（= workArea 右边缘 − margin）。 */
  rightEdgeX: number
  /** 居中时宠物矩形中心的本地 x。 */
  centerX: number
  /** 脚底本地 y（= workArea 底边换算到窗口本地坐标）。 */
  feetY: number
  /** 水平边距，CSS 像素。 */
  marginPx: number
}

/**
 * 模型未加载（或加载失败）时用于调试统计/首帧布局的宽高比占位值。
 *
 * 取真实模型（`assets/model/optimized/星穹铁道—砂金·戏浪.pmx`）的**绑定姿势**宽高比
 * ≈ 0.7373（A2 审查复算：基础 bbox 0.73729003）。旧值 0.5 会让加载期的
 * `stats().petRect` 比实际窄 47%（F15）。
 *
 * 注意：含全部 morph target 的 union bbox 宽高比是 0.7304（见 `model/bounding.ts`），
 * 只能用于「表情不出框」参考，不能当缩放/占位基准。
 */
export const FALLBACK_MODEL_ASPECT = 0.7373

/** 右下角边距：workArea 短边的 2%，限制在 8–32px（1080p ≈ 19px）。 */
const CORNER_MARGIN_RATIO = 0.02
const MIN_CORNER_MARGIN_PX = 8
const MAX_CORNER_MARGIN_PX = 32

/** 数值钳制（NaN / Infinity 回退到 fallback）。 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 把 sizePercent 钳制到契约区间 [10, 100]（@shared/config 的 CONFIG_LIMITS 为单一来源）。 */
export function clampSizePercent(sizePercent: number): number {
  return clampNumber(
    sizePercent,
    CONFIG_LIMITS.sizePercent.min,
    CONFIG_LIMITS.sizePercent.max,
    CONFIG_LIMITS.sizePercent.min
  )
}

/**
 * 宠物高度：`clamp(sizePercent, 10, 100) / 100 × display.bounds.height`，
 * 再按可选 `maxHeightPx` 封顶（布局层传入 `display.workArea.height`，
 * 保证 100% 时宠物不出窗；默认不封顶，便于单测 bounds 语义）。
 * 非有限/异常输入按 10% 兜底，保证调用方永远拿到正数。
 */
export function computePetHeightPx(
  sizePercent: number,
  boundsHeight: number,
  maxHeightPx: number = Number.POSITIVE_INFINITY
): number {
  const percent = clampSizePercent(sizePercent)
  const height = Number.isFinite(boundsHeight) && boundsHeight > 0 ? boundsHeight : 0
  const rawHeight = (percent / 100) * height
  const cap =
    Number.isFinite(maxHeightPx) && maxHeightPx > 0 && maxHeightPx < rawHeight
      ? maxHeightPx
      : rawHeight
  return Math.max(0, cap)
}

/** 找到 overlay 窗口所在显示器（按 displayId 精确匹配）；找不到返回 null。 */
export function findWindowDisplay(
  windowInfo: Pick<OverlayWindowInfo, 'displayId'>,
  displays: readonly DisplayInfo[]
): DisplayInfo | null {
  return displays.find((display) => display.id === windowInfo.displayId) ?? null
}

/** 计算右下角水平边距（workArea 短边的 2%，钳制到 8–32px）。 */
export function computeCornerMarginPx(display: DisplayInfo | null): number {
  if (!display) return MIN_CORNER_MARGIN_PX
  const shortEdge = Math.min(display.workArea.width, display.workArea.height)
  const margin = Math.round(shortEdge * CORNER_MARGIN_RATIO)
  return clampNumber(margin, MIN_CORNER_MARGIN_PX, MAX_CORNER_MARGIN_PX, MIN_CORNER_MARGIN_PX)
}

/**
 * 计算宠物布局。
 *
 * - 非主屏 / 屏幕信息缺失：`renderPet=false`（透明空场景，Wave 1 其余屏不渲染宠物）；
 * - 脚底 y：`display.workArea` 底边全局坐标 − 窗口 bounds 原点，再钳制进视口；
 * - 贴右 x：`display.workArea` 右边缘全局坐标 − 窗口 bounds 原点 − margin，再钳制进视口。
 *
 * 所有全局 → 本地换算都显式做「减窗口原点」，不假设窗口原点为 (0,0)。
 */
export function computePetLayout(input: LayoutInput): PetLayout {
  const display = findWindowDisplay(input.windowInfo, input.displays)
  const isPrimaryDisplay = display?.isPrimary === true
  const renderPet = isPrimaryDisplay
  const anchor: LayoutAnchor = input.position === 'free' ? 'center' : 'right'

  if (!display || !renderPet) {
    return {
      renderPet,
      display,
      isPrimaryDisplay,
      petHeightPx: 0,
      anchor,
      rightEdgeX: 0,
      centerX: 0,
      feetY: 0,
      marginPx: 0
    }
  }

  const { workArea } = display
  // 100% 放开后：bounds 百分比可能大于 overlay 窗口高度 → 用 workArea.height 封顶，宠物不出窗。
  const petHeightPx = computePetHeightPx(
    input.sizePercent,
    display.bounds.height,
    workArea.height
  )
  const marginPx = computeCornerMarginPx(display)
  const windowX = input.windowInfo.bounds.x
  const windowY = input.windowInfo.bounds.y
  const viewportWidth = Math.max(0, input.viewport.width)
  const viewportHeight = Math.max(0, input.viewport.height)

  // 全局 → 窗口本地：减窗口原点（主屏上窗口 y=30 时，workArea 底边本地 y 仍是视口高度）。
  const localRightEdge = workArea.x + workArea.width - windowX
  const localCenterX = workArea.x + workArea.width / 2 - windowX
  const localBottom = workArea.y + workArea.height - windowY

  return {
    renderPet,
    display,
    isPrimaryDisplay,
    petHeightPx,
    anchor,
    rightEdgeX: clampNumber(localRightEdge - marginPx, 0, viewportWidth, viewportWidth),
    centerX: clampNumber(localCenterX, 0, viewportWidth, viewportWidth / 2),
    feetY: clampNumber(localBottom, 0, viewportHeight, viewportHeight),
    marginPx
  }
}

/**
 * 结合模型宽高比，算出宠物在窗口本地坐标中的矩形（CSS 像素，左上原点、y 向下）。
 * 宽高比非法（模型未加载/异常）时使用 {@link FALLBACK_MODEL_ASPECT}。
 */
export function computePetRect(layout: PetLayout, aspectRatio: number): Rect {
  if (!layout.renderPet || layout.petHeightPx <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const aspect =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : FALLBACK_MODEL_ASPECT
  const width = layout.petHeightPx * aspect
  const x = layout.anchor === 'right' ? layout.rightEdgeX - width : layout.centerX - width / 2
  return { x, y: layout.feetY - layout.petHeightPx, width, height: layout.petHeightPx }
}
