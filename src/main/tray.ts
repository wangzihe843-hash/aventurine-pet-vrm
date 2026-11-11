/**
 * 菜单栏托盘（Wave 1 A1）
 *
 * 职责（PLAN §5-A1 / §17.5 P1-8 / P1-10）：
 * - 消费 `assets/icons/trayTemplate.png`（**template image**：纯黑 + alpha，
 *   macOS 深浅色菜单栏自动反色；@2x 由 nativeImage 按文件名约定自动加载）；
 * - 菜单：显示桌宠（checkbox，与 overlay 显隐状态同步）/ 设置…（Wave 2 B6 占位）/
 *   分隔 / 退出；
 * - macOS 上 Tray 实例必须被持有引用（本模块 `activeHandle` + 返回的 handle），否则会被 GC；
 * - 图标缺失 / 损坏只 warn 不抛（占位图标已随仓库提供，缺失属异常但不阻塞启动）。
 *
 * 集成接线（Lead 在 `src/main/index.ts` 完成）：
 * `createTray({ ctx, isVisible, onToggleVisible, onQuit })`，并可选在退出时 `trayHandle.destroy()`。
 */
import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from './app-context'

/** 托盘图标文件名（template image；@2x 由 Electron 按命名约定自动匹配）。 */
const TRAY_ICON_FILE = 'trayTemplate.png'

/**
 * 托盘日志接口（L-4；与 `src/main/logger.ts` 的 Logger 结构兼容，避免硬依赖）。
 * 未注入时回退 console.warn（保持既有测试/调用方行为）。
 */
export interface TrayLogger {
  warn(message: string, meta?: unknown): void
}

/** 托盘 tooltip（app 显示名，见 PLAN §0）。 */
const TRAY_TOOLTIP = '砂金·戏浪'

/** 托盘依赖（由 `src/main/index.ts` 注入管理器状态与退出逻辑）。 */
export interface TrayDeps {
  /** 进程级应用上下文（保留给后续菜单项使用，如打开设置窗）。 */
  ctx: AppContext
  /** 当前 overlay 是否处于显示状态（菜单勾选态）。 */
  isVisible(): boolean
  /** 用户点击「显示桌宠」：切换显隐（实现方负责调 manager.setVisible）。 */
  onToggleVisible(): void
  /** 用户点击「设置…」：打开设置窗（Wave 2 B6；Lead 在集成窗口接线）。 */
  onShowSettings?: () => void
  /** 用户点击「退出」：正常退出 app（实现方负责 app.quit）。 */
  onQuit(): void
  /** 进程级 logger（L-4 接线；可选，未注入时回退 console.warn）。 */
  logger?: TrayLogger
}

/** 托盘句柄（tray 实例 + 状态同步 + 销毁）。 */
export interface TrayHandle {
  tray: Tray
  /** 按最新 `isVisible()` 重建菜单以同步勾选状态（托盘自身 toggle / pet:set-visible 后调用）。 */
  syncVisibility(): void
  /** 销毁托盘并释放 active 引用（幂等）。 */
  destroy(): void
}

/** 当前活跃托盘句柄（模块级强引用：macOS 上 Tray 被 GC 会导致图标消失）。 */
let activeHandle: TrayHandle | null = null

/** 取当前活跃托盘实例；未创建时返回 null。 */
export function getActiveTray(): Tray | null {
  return activeHandle ? activeHandle.tray : null
}

/** 同步当前托盘的菜单勾选状态（`pet:set-visible` 等外部显隐操作后调用）。 */
export function syncActiveTrayVisibility(): void {
  activeHandle?.syncVisibility()
}

/**
 * 托盘图标路径：
 * - dev：`<appPath>/assets/icons/trayTemplate.png`（electron-vite dev 下 appPath = 项目根）；
 * - packaged：`<resourcesPath>/assets/icons/trayTemplate.png`，不存在时回退 appPath。
 */
function resolveTrayIconPath(logger?: TrayLogger): string {
  const appPathIcon = join(app.getAppPath(), 'assets', 'icons', TRAY_ICON_FILE)
  if (!app.isPackaged) return appPathIcon
  const resourcesIcon = join(process.resourcesPath, 'assets', 'icons', TRAY_ICON_FILE)
  if (existsSync(resourcesIcon)) return resourcesIcon
  if (logger) logger.warn('[tray] packaged tray icon missing, fallback to appPath:', resourcesIcon)
  else console.warn('[tray] packaged tray icon missing, fallback to appPath:', resourcesIcon)
  return appPathIcon
}

/** 加载 template image；缺失 / 损坏只 warn 不抛。 */
function loadTrayIcon(logger?: TrayLogger): NativeImage {
  const iconPath = resolveTrayIconPath(logger)
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // 不抛：托盘异常不应阻塞 app 启动（正式图标应随仓库 / 打包产物存在）
    if (logger) logger.warn('[tray] failed to load tray icon (empty nativeImage):', iconPath)
    else console.warn('[tray] failed to load tray icon (empty nativeImage):', iconPath)
    return image
  }
  if (process.platform === 'darwin') {
    // macOS template image：黑色像素随菜单栏深 / 浅色自动反色
    image.setTemplateImage(true)
  }
  return image
}

/**
 * 创建托盘（只应在 app ready 之后调用一次）。
 * 重复创建会替换 active 引用（正常流程不会发生）。
 */
export function createTray(deps: TrayDeps): TrayHandle {
  const tray = new Tray(loadTrayIcon(deps.logger))
  tray.setToolTip(TRAY_TOOLTIP)

  let destroyed = false

  /** 构建菜单（勾选态在构建时从 deps.isVisible() 读取）。 */
  function buildMenu(): Menu {
    return Menu.buildFromTemplate([
      {
        label: '显示桌宠',
        type: 'checkbox',
        checked: deps.isVisible(),
        click: () => {
          deps.onToggleVisible()
          // 托盘自身点击后，按实际状态重建菜单同步勾选
          syncVisibility()
        }
      },
      // 设置窗归 Wave 2 B6（focusable 普通窗 + settings.html）；菜单项由 Lead 接线（未注入
      // 回调时保持禁用，保证老调用方/单测兼容）。
      {
        label: '设置…',
        enabled: typeof deps.onShowSettings === 'function',
        click: () => {
          deps.onShowSettings?.()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          deps.onQuit()
        }
      }
    ])
  }

  /** 重建并应用菜单：MenuItem.checked 直接改属性在 macOS 上不可靠，统一重建。 */
  function syncVisibility(): void {
    if (destroyed) return
    tray.setContextMenu(buildMenu())
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    if (activeHandle === handle) activeHandle = null
    tray.destroy()
  }

  const handle: TrayHandle = { tray, syncVisibility, destroy }
  activeHandle = handle
  syncVisibility()
  return handle
}
