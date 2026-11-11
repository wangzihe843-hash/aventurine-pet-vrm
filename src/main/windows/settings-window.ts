/**
 * 设置窗（Wave 2 开工前置，Lead-owned 集成模块）
 *
 * 职责：创建 / 复用唯一的普通设置窗口（focusable、不透明、非置顶、无穿透），加载
 * renderer 第二入口 `settings.html`（B6 负责页面实现，见 PLAN §7 / §19.6）。
 *
 * 设计要点：
 * - **单例**：重复调用 `openSettingsWindow()` 只聚焦已有窗口，不重复创建；
 * - 普通窗口语义：可聚焦、有标题栏、可缩放（宽度/高度有下限）；**不**使用 overlay 的
 *   `transparent/screen-saver/focusable:false` 选项，否则用户无法在设置里输入/操作；
 * - **广播目标（M-2）**：创建时登记到 `AppContext.registerBroadcastTarget()`，
 *   `closed` 时注销 —— 设置页因此能收到 `config-changed`（外部改配置后同步 UI）；
 * - 安全：沿用全项目基线（sandbox + contextIsolation + nodeIntegration:false + 同一 preload
 *   白名单）；navigation / window.open 在本模块内直接拒绝（不依赖 index.ts 的实现细节，
 *   避免循环依赖）；
 * - 生命周期：`closed` 清空单例引用并注销广播目标；`will-quit` 由 `src/main/index.ts`
 *   调 `destroySettingsWindow()`；
 * - 加载路径：dev 走 `ELECTRON_RENDERER_URL/settings.html`（electron-vite 多页入口），
 *   生产走 `out/renderer/settings.html`；
 * - 日志（L-4）：可选注入共享 logger（`src/main/logger.ts`），未注入时回退 console
 *   （保持既有测试/调用方兼容）。
 */
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'node:path'

import type { AppContext } from '../app-context'
import { maskUrl } from '../security/renderer-network-guard'

/** preload 路径（与 overlay-manager 一致：out/main/../preload/index.js）。 */
const PRELOAD_PATH = join(__dirname, '../preload/index.js')

/** 设置窗默认/最小尺寸（DPR 无关，CSS 像素）。 */
const SETTINGS_WINDOW_WIDTH = 460
const SETTINGS_WINDOW_HEIGHT = 720
const SETTINGS_WINDOW_MIN_WIDTH = 380
const SETTINGS_WINDOW_MIN_HEIGHT = 520

/**
 * 设置窗日志接口（与 `src/main/logger.ts` 的 Logger 结构兼容；只需 warn/error）。
 * 保持结构类型而非 import Logger：避免本模块对 logger 实现的硬依赖。
 */
export interface SettingsWindowLogger {
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

/** 当前设置窗单例（关闭后置 null）。 */
let settingsWindow: BrowserWindow | null = null

/** 登记广播目标时使用的上下文（closed 时从这里注销；M-2）。 */
let settingsWindowContext: AppContext | null = null

/** 取当前设置窗（不存在 / 已销毁时返回 null）；供冒烟/测试断言。 */
export function getSettingsWindow(): BrowserWindow | null {
  if (settingsWindow && settingsWindow.isDestroyed()) settingsWindow = null
  return settingsWindow
}

/** 未注入 logger 时的 console 回退（保持旧行为；logger.warn/error 签名兼容）。 */
function consoleLogger(): SettingsWindowLogger {
  return {
    warn(message: string, meta?: unknown): void {
      if (meta === undefined) console.warn(message)
      else console.warn(message, meta)
    },
    error(message: string, meta?: unknown): void {
      if (meta === undefined) console.error(message)
      else console.error(message, meta)
    }
  }
}

/** 设置窗内的最小安全硬化：拒绝导航与 window.open（与 overlay 基线一致）。 */
function hardenSettingsContents(win: BrowserWindow, logger: SettingsWindowLogger): void {
  const denyNavigation = (event: { preventDefault: () => void }, url: string): void => {
    event.preventDefault()
    // R-22：只记 protocol/origin，避免完整 URL（可能含 query token）写进 main.log。
    logger.warn(`[settings] blocked navigation: ${maskUrl(url)}`)
  }
  win.webContents.on('will-navigate', denyNavigation)
  win.webContents.on('will-redirect', denyNavigation)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/**
 * R-05：设置窗的崩溃 / 无响应**只记日志，不自动 reload**（自行判断后的取舍）。
 *
 * - 设置窗是用户按需打开的普通窗口，崩溃后重开一次即可恢复；reload 会丢表单输入，
 *   反而制造「输入被清空」的 bug 体验；
 * - overlay 的自动恢复（限流 reload / GPU 兜底）由 `hardenWebContents` + `crash-recovery`
 *   负责，设置窗不再维护第二套限流状态，避免两处策略漂移；
 * - `clean-exit`（窗口正常关闭）不记 error，避免正常退出路径刷日志。
 */
function attachSettingsCrashLogging(win: BrowserWindow, logger: SettingsWindowLogger): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason ?? 'unknown'
    if (reason === 'clean-exit') return
    logger.error(
      `[settings] renderer gone: reason=${reason}; window must be closed and reopened`
    )
  })
  win.webContents.on('unresponsive', () => {
    logger.warn('[settings] renderer unresponsive; close and reopen the settings window')
  })
}

/** 设置窗加载地址：dev 用 electron-vite dev server 的多页入口，生产用构建产物。 */
function loadSettingsPage(win: BrowserWindow, logger: SettingsWindowLogger): void {
  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  const loading =
    is.dev && devRendererUrl
      ? win.loadURL(new URL('settings.html', ensureTrailingSlash(devRendererUrl)).toString())
      : win.loadFile(join(__dirname, '../renderer/settings.html'))

  void loading.catch((error: unknown) => {
    logger.error('[settings] failed to load settings page:', error)
  })
}

/** 保证 dev server URL 以 `/` 结尾，`new URL('settings.html', base)` 才能正确拼接。 */
function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * 打开（或聚焦）设置窗。
 *
 * - 已存在且未销毁：`show()` + `focus()` 后直接返回（顺带补登记广播目标，M-2）；
 * - 不存在：创建普通 BrowserWindow，`ready-to-show` 后再显示（避免白屏闪烁）；
 * - 不激活 app/Dock：本项目为 accessory 激活策略，普通窗口仍可正常聚焦与输入。
 *
 * @param ctx 应用上下文（可选；传入后设置窗成为 `config-changed` 等广播的目标）
 * @param logger 共享日志（可选；L-4，未传时回退 console）
 */
export function openSettingsWindow(
  ctx?: AppContext,
  logger?: SettingsWindowLogger
): BrowserWindow {
  const log = logger ?? consoleLogger()
  const existing = getSettingsWindow()
  if (existing) {
    // M-2：旧调用方可能先无 ctx 创建，后续带 ctx 复用 —— 这里补登记（幂等）。
    if (ctx) {
      settingsWindowContext = ctx
      ctx.registerBroadcastTarget?.(existing)
    }
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: SETTINGS_WINDOW_MIN_WIDTH,
    minHeight: SETTINGS_WINDOW_MIN_HEIGHT,
    title: '砂金·戏浪 — 设置',
    show: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#15161a',
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  })
  settingsWindow = win
  settingsWindowContext = ctx ?? null
  // M-2：设置窗登记为广播目标 —— 否则 config-changed 只发 overlay，设置页 onConfigChanged 是死代码。
  ctx?.registerBroadcastTarget?.(win)

  hardenSettingsContents(win, log)
  attachSettingsCrashLogging(win, log)
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    // M-2：窗口关闭即注销广播目标（destroySettingsWindow / 用户关窗 / 异常关闭都走这里）。
    settingsWindowContext?.unregisterBroadcastTarget?.(win)
    settingsWindowContext = null
    if (settingsWindow === win) settingsWindow = null
  })

  loadSettingsPage(win, log)
  return win
}

/** 销毁设置窗（app 退出时由 index.ts 调用；幂等）。 */
export function destroySettingsWindow(): void {
  const win = getSettingsWindow()
  settingsWindow = null
  if (win) {
    if (!win.isDestroyed()) win.destroy()
  }
}
