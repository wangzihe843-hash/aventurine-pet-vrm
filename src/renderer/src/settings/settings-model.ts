/**
 * 设置面板纯逻辑（Wave 2 B6）—— 不依赖 DOM / Electron，可直接单测。
 *
 * 职责（docs/wave2-integration.md §3-B6）：
 * - `PetConfig` ↔ 表单状态（`SettingsFormState`）双向转换；
 * - 控件变更 → `Partial<PetConfig>`（数值钳制/枚举回退，主进程 `sanitizeConfig` 前先做一层，
 *   保证滑杆显示值与提交值一致）；
 * - 尺寸百分比 → 实际宠物高度 px（基准 `display.bounds.height`，受 `workArea.height` 封顶）；
 * - 权限/DSH 状态的展示文案与样式 tone；
 * - 「恢复默认」payload（显式 `DEFAULT_CONFIG` 全字段）。
 *
 * 约束：不 import 任何 electron / node 内置模块；UI 层（`main.ts`）只做绑定与渲染。
 */
import { CONFIG_LIMITS, DEFAULT_CONFIG } from '@shared/config'
import type {
  AccessibilityStatus,
  AutonomousLevel,
  DisplayInfo,
  DshStatus,
  PetConfig
} from '@shared/types'

/** 表单状态：设置页里可编辑的配置子集（与 `PetConfig` 同名字段一一对应）。 */
export interface SettingsFormState {
  sizePercent: number
  opacity: number
  autonomous: boolean
  autonomousLevel: AutonomousLevel
  mischief: boolean
  dshLink: boolean
  /** 与 DSH 双向保活/强耦合（Wave 3；默认 true） */
  dshCoupling: boolean
  /** 气泡同步 DSH 回复（Wave 3；默认 true） */
  dshBubbleSync: boolean
  fpsCap: number
  launchAtLogin: boolean
  sound: boolean
}

/** 表单字段名集合（`patchForField` 的合法入参）。 */
export type SettingsField = keyof SettingsFormState

/** 屏幕高度基准（只取展示换算需要的两个值，避免 UI 层依赖 Rect）。 */
export interface ScreenMetrics {
  /** `display.bounds.height`（尺寸百分比基准） */
  boundsHeight: number
  /** `display.workArea.height`（宠物高度上限） */
  workAreaHeight: number
}

/**
 * 拿不到屏幕信息时的兜底基准（1080p 常见值：bounds 1080 / workArea 961）。
 * 仅用于展示换算；真实尺寸与摆放始终由主进程/renderer 用实时屏幕数据决定。
 */
export const DEFAULT_SCREEN_METRICS: ScreenMetrics = {
  boundsHeight: 1080,
  workAreaHeight: 961
}

/** 尺寸展示模型（滑杆旁的「50% · 约 540 px」提示）。 */
export interface SizeDescription {
  /** 百分比标签（如 `50%`） */
  label: string
  /** 换算后的宠物高度（CSS px，已受 workArea 封顶） */
  petHeightPx: number
  /** 辅助说明（屏幕上限/近景提示） */
  hint: string
}

/** DSH 状态展示（文案 + tone 用于 CSS class）。 */
export interface DshStatusDescription {
  text: string
  tone: 'online-busy' | 'online-idle' | 'offline' | 'unknown'
}

/** 权限状态展示。 */
export interface PermissionDescription {
  accessibilityText: string
  accessibilityOk: boolean
  notificationsText: string
  notificationsOk: boolean
}

/** 数字钳制辅助：非有限数值回退 `fallback`，否则钳制到闭区间。 */
export function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 尺寸百分比：整数 + 钳制 10–100（非法 → 默认 50）。 */
export function clampSizePercent(value: unknown): number {
  return Math.round(
    clampNumber(
      value,
      CONFIG_LIMITS.sizePercent.min,
      CONFIG_LIMITS.sizePercent.max,
      DEFAULT_CONFIG.sizePercent
    )
  )
}

/** 不透明度：保留两位小数 + 钳制 0.3–1（非法 → 默认 1）。 */
export function clampOpacity(value: unknown): number {
  const clamped = clampNumber(
    value,
    CONFIG_LIMITS.opacity.min,
    CONFIG_LIMITS.opacity.max,
    DEFAULT_CONFIG.opacity
  )
  return Math.round(clamped * 100) / 100
}

/** FPS 上限：向下取整（上限语义，不承诺超过请求值）+ 钳制 5–60（非法 → 默认 30）。 */
export function clampFpsCap(value: unknown): number {
  return Math.floor(
    clampNumber(value, CONFIG_LIMITS.fpsCap.min, CONFIG_LIMITS.fpsCap.max, DEFAULT_CONFIG.fpsCap)
  )
}

/** 自主活动频率：非法值回退 `normal`。 */
export function normalizeAutonomousLevel(value: unknown): AutonomousLevel {
  return value === 'low' || value === 'normal' || value === 'high'
    ? value
    : DEFAULT_CONFIG.autonomousLevel
}

/** 从完整配置构造表单状态（新对象，修改表单不会污染原配置）。 */
export function formStateFromConfig(config: PetConfig): SettingsFormState {
  return {
    sizePercent: clampSizePercent(config.sizePercent),
    opacity: clampOpacity(config.opacity),
    autonomous: config.autonomous === true,
    autonomousLevel: normalizeAutonomousLevel(config.autonomousLevel),
    mischief: config.mischief === true,
    dshLink: config.dshLink === true,
    // Wave 3 可选键：语义「省略 = 默认 true」，只有显式 false 才展示为关闭。
    dshCoupling: config.dshCoupling !== false,
    dshBubbleSync: config.dshBubbleSync !== false,
    fpsCap: clampFpsCap(config.fpsCap),
    launchAtLogin: config.launchAtLogin === true,
    sound: config.sound === true
  }
}

/** 布尔字段的防御式读取：非 boolean → 默认值。 */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 单个控件变更 → `Partial<PetConfig>`（只含一个显式键，已钳制/枚举回退）。
 * UI 层在 debounce 里把多个 patch 合并成一次 `setConfig`。
 */
export function patchForField(field: SettingsField, value: unknown): Partial<PetConfig> {
  switch (field) {
    case 'sizePercent':
      return { sizePercent: clampSizePercent(value) }
    case 'opacity':
      return { opacity: clampOpacity(value) }
    case 'autonomous':
      return { autonomous: booleanOr(value, DEFAULT_CONFIG.autonomous) }
    case 'autonomousLevel':
      return { autonomousLevel: normalizeAutonomousLevel(value) }
    case 'mischief':
      return { mischief: booleanOr(value, DEFAULT_CONFIG.mischief) }
    case 'dshLink':
      return { dshLink: booleanOr(value, DEFAULT_CONFIG.dshLink) }
    case 'dshCoupling':
      return { dshCoupling: booleanOr(value, DEFAULT_CONFIG.dshCoupling === true) }
    case 'dshBubbleSync':
      return { dshBubbleSync: booleanOr(value, DEFAULT_CONFIG.dshBubbleSync === true) }
    case 'fpsCap':
      return { fpsCap: clampFpsCap(value) }
    case 'launchAtLogin':
      return { launchAtLogin: booleanOr(value, DEFAULT_CONFIG.launchAtLogin) }
    case 'sound':
      return { sound: booleanOr(value, DEFAULT_CONFIG.sound) }
    default:
      // 穷举保护：未知字段不产生任何变更。
      return {}
  }
}

/** 「恢复默认」payload：显式全字段（新对象；`setConfig` 走 sanitize 后整体生效）。 */
export function defaultsPatch(): PetConfig {
  return { ...DEFAULT_CONFIG }
}

/** 从主屏显示器信息取高度基准；显示器列表不可用时回退 `DEFAULT_SCREEN_METRICS`。 */
export function screenMetricsFromDisplays(
  displays: readonly DisplayInfo[] | null | undefined
): ScreenMetrics {
  if (!Array.isArray(displays) || displays.length === 0) return { ...DEFAULT_SCREEN_METRICS }
  const primary = displays.find((display) => display?.isPrimary === true) ?? displays[0]
  return screenMetricsFromDisplay(primary)
}

/** 从单个显示器取高度基准（字段非法时各自回退默认值）。 */
export function screenMetricsFromDisplay(
  display: DisplayInfo | null | undefined
): ScreenMetrics {
  if (!display || typeof display !== 'object') return { ...DEFAULT_SCREEN_METRICS }
  const boundsHeight =
    typeof display.bounds?.height === 'number' && Number.isFinite(display.bounds.height)
      ? display.bounds.height
      : DEFAULT_SCREEN_METRICS.boundsHeight
  const workAreaHeight =
    typeof display.workArea?.height === 'number' && Number.isFinite(display.workArea.height)
      ? display.workArea.height
      : DEFAULT_SCREEN_METRICS.workAreaHeight
  return { boundsHeight, workAreaHeight }
}

/**
 * 尺寸百分比 → 宠物高度 px。
 * 口径与 `renderer/src/model/layout.ts` 一致：`min(sizePercent% × bounds.height, workArea.height)`。
 */
export function computePetHeightPx(
  sizePercent: unknown,
  metrics: ScreenMetrics = DEFAULT_SCREEN_METRICS
): number {
  const percent = clampSizePercent(sizePercent)
  const boundsHeight =
    typeof metrics.boundsHeight === 'number' && Number.isFinite(metrics.boundsHeight)
      ? metrics.boundsHeight
      : DEFAULT_SCREEN_METRICS.boundsHeight
  const workAreaHeight =
    typeof metrics.workAreaHeight === 'number' && Number.isFinite(metrics.workAreaHeight)
      ? metrics.workAreaHeight
      : DEFAULT_SCREEN_METRICS.workAreaHeight
  const raw = Math.round((percent / 100) * boundsHeight)
  return Math.max(1, Math.min(raw, Math.round(workAreaHeight)))
}

/**
 * 当前屏幕可达的最大尺寸百分比：`ceil(workArea / bounds × 100)`（1–100）。
 * 取 ceil 是因为该百分比下 `computePetHeightPx` 恰好被 workArea 封顶（如 1080p 下 89% → 961px）。
 */
export function maxSizePercent(metrics: ScreenMetrics = DEFAULT_SCREEN_METRICS): number {
  const bounds = metrics.boundsHeight > 0 ? metrics.boundsHeight : DEFAULT_SCREEN_METRICS.boundsHeight
  const workArea =
    metrics.workAreaHeight > 0 ? metrics.workAreaHeight : DEFAULT_SCREEN_METRICS.workAreaHeight
  return Math.min(100, Math.max(1, Math.ceil((workArea / bounds) * 100)))
}

/** 尺寸展示模型（滑杆旁的百分比 + 换算 px + 近景/上限提示）。 */
export function describeSize(
  sizePercent: unknown,
  metrics: ScreenMetrics = DEFAULT_SCREEN_METRICS
): SizeDescription {
  const percent = clampSizePercent(sizePercent)
  const petHeightPx = computePetHeightPx(percent, metrics)
  const maxPercent = maxSizePercent(metrics)
  const maxHeightPx = computePetHeightPx(maxPercent, metrics)

  let hint: string
  if (percent >= maxPercent) {
    hint = `当前屏幕上限定为 ${maxPercent}%（约 ${maxHeightPx} px）`
  } else if (percent >= 70) {
    hint = `近景模式 · 屏幕最高约 ${maxPercent}%`
  } else {
    hint = `屏幕最高可到 ${maxPercent}%`
  }
  return { label: `${percent}%`, petHeightPx, hint }
}

/** 不透明度展示（`100%` / `65%`）。 */
export function formatOpacityPercent(opacity: unknown): string {
  return `${Math.round(clampOpacity(opacity) * 100)}%`
}

/** FPS 展示（`30 FPS`）。 */
export function formatFps(fps: unknown): string {
  return `${clampFpsCap(fps)} FPS`
}

/**
 * DSH 状态展示（Wave 3 §7 文案）：online 时显示「已连接（运行中/空闲）」，
 * 离线显示「未连接（安装桥插件后生效）」；只以 `online` 判断是否连接。
 */
export function describeDshStatus(status: DshStatus | null | undefined): DshStatusDescription {
  if (!status || typeof status !== 'object') {
    return { text: '未知（主进程未响应）', tone: 'unknown' }
  }
  if (status.online !== true) {
    return { text: '未连接（安装桥插件后生效）', tone: 'offline' }
  }
  return status.running === true
    ? { text: '已连接（运行中）', tone: 'online-busy' }
    : { text: '已连接（空闲）', tone: 'online-idle' }
}

/** 权限状态展示（accessibility / notifications 分开）。 */
export function describePermissions(
  status: AccessibilityStatus | null | undefined
): PermissionDescription {
  const accessibilityOk = status?.accessibility === true
  const notifications = status?.notifications
  let notificationsText: string
  let notificationsOk = false
  switch (notifications) {
    case 'granted':
      notificationsText = '已允许'
      notificationsOk = true
      break
    case 'denied':
      notificationsText = '已拒绝'
      break
    case 'unsupported':
      notificationsText = '系统不支持'
      break
    case 'unknown':
      notificationsText = '未知'
      break
    default:
      notificationsText = '未知'
      break
  }
  return {
    accessibilityText: status ? (accessibilityOk ? '已授权' : '未授权') : '未知',
    accessibilityOk,
    notificationsText,
    notificationsOk
  }
}

/**
 * IPC/加载错误 → 简短可读文案（不把堆栈塞进设置页；过长截断）。
 * 主进程失败时 `window.api.*` 会 reject，错误对象可能是 Error 也可能是任意值。
 */
export function formatErrorText(error: unknown, maxLength = 120): string {
  let text: string
  if (error instanceof Error && error.message.trim().length > 0) {
    text = error.message.trim()
  } else if (typeof error === 'string' && error.trim().length > 0) {
    text = error.trim()
  } else {
    text = '未知错误'
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}
