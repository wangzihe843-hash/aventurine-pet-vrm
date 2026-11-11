/**
 * 窗口 / 显示器 / 窗口动作相关 IPC（Wave 1 A1 续填）
 *
 * 已注册（冻结契约 `src/shared/ipc.ts`）：
 * - `pet:window-info`（Lead 预置，A1 不得删除）：overlay 自身信息（bounds / displayId），
 *   renderer 用它做「屏幕全局坐标 → 窗口本地坐标」换算（overlay 原点 = workArea 原点，y 通常不是 0）。
 * - `pet:screen-info`（Lead 预置）：全部显示器的 bounds / workArea / scaleFactor。
 * - `pet:set-ignore-mouse`（A1）：点击穿透切换——`ignore=true` 经 mouse-gate **延迟一帧**生效
 *   （避免正在进行中的 mouseup 丢失），`ignore=false` **立即**拦截（命中检测需要马上接管鼠标）。
 * - `pet:set-visible`（A1）：全部 overlay 隐藏 / `showInactive()` 显示，并同步托盘勾选状态。
 * - `pet:quit`（A1）：下一 tick `app.quit()`，先让 invoke 的 Promise 正常返回。
 * - `pet:accessibility-status` / `pet:open-accessibility-settings`（A1）：辅助功能权限状态与深链引导。
 *
 * 归属边界（PLAN §17.5 P1-10 / 独立复验 MED-3）：
 * - `pet:windows` 由 A4 在 `ipc/desktop.ts` 注册；`pet:move-window` 归 Wave 3 C1；
 * - `pet:get-config` / `pet:set-config` 归 A3；`pet:notify` / `pet:show-settings` / `pet:dsh-status`
 *   由后续 Wave 任务注册 —— 本文件**不得**注册，避免 `ipcMain.handle` 重复注册崩溃。
 *
 * `getDisplayInfos()` 同时供 `src/main/index.ts` / overlay-manager 使用（显示器快照单一来源）。
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { IPC } from '@shared/ipc'
import type { AccessibilityStatus, DisplayInfo, OverlayWindowInfo, Rect } from '@shared/types'
import type { AppContext } from '../app-context'
import { syncActiveTrayVisibility } from '../tray'
import { createIgnoreMouseGate } from '../windows/mouse-gate'
import type { IgnoreMouseGate } from '../windows/mouse-gate'
import { getActiveOverlayWindowsManager } from '../windows/overlay-manager'

/**
 * macOS 辅助功能设置深链（PLAN §10）。
 * 注意：非 macOS 平台该 URL 无意义；本机目标平台为 macOS（PLAN §17.1）。
 */
const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/**
 * 每个窗口一个穿透状态机：连续快速 toggle 时合并，
 * 拦截 → 穿透 延迟一帧（mouseup 保护），穿透 → 拦截 立即生效。
 * 用 WeakMap 持有，窗口销毁后可被 GC（未销毁窗口的延迟任务最多存活一帧）。
 * 窗口 `closed` 时主动 dispose（A1-F6），避免延迟任务在窗口销毁后继续跑。
 */
const ignoreMouseGates = new WeakMap<BrowserWindow, IgnoreMouseGate>()

/**
 * 每个窗口「最近一次**实际**执行成功的 setIgnoreMouseEvents 状态」（A1-F6 冒烟断言用）。
 * - 只在 `applyIgnoreMouse` 成功后写入；
 * - 窗口 closed 时清空；从未通过本模块切换过（例如 overlay 建窗初始穿透）时为 null。
 */
const ignoreMouseApplied = new WeakMap<BrowserWindow, boolean>()

/** 取窗口最近一次实际应用的穿透状态；未应用过 / 窗口已关闭清理后返回 null。 */
export function getIgnoreMouseAppliedState(win: BrowserWindow): boolean | null {
  return ignoreMouseApplied.get(win) ?? null
}

/** Electron Rectangle → 冻结契约 Rect（显式拷贝，不把 Electron 内部对象透出到 renderer）。 */
function toRect(rect: Electron.Rectangle): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/** 执行真正的穿透切换（monitor：单帧延迟由 mouse-gate 负责），并记录「实际已应用」状态。 */
function applyIgnoreMouse(win: BrowserWindow, ignore: boolean): void {
  if (win.isDestroyed()) return
  try {
    if (ignore) {
      // forward：穿透期间仍把 mousemove 投递给 renderer，供命中检测决定何时切回拦截
      win.setIgnoreMouseEvents(true, { forward: true })
    } else {
      win.setIgnoreMouseEvents(false)
    }
    ignoreMouseApplied.set(win, ignore)
  } catch (error) {
    // 窗口在 isDestroyed 检查后恰好销毁等极窄竞态：不要冒泡成 unhandled（延迟任务在 timer 里）。
    console.warn('[window] failed to apply setIgnoreMouseEvents:', error)
  }
}

/** 取（或惰性创建）该窗口的穿透状态机。 */
function getIgnoreMouseGate(win: BrowserWindow): IgnoreMouseGate {
  const existing = ignoreMouseGates.get(win)
  if (existing) return existing
  const gate = createIgnoreMouseGate({
    apply: (ignore: boolean): void => applyIgnoreMouse(win, ignore)
  })
  ignoreMouseGates.set(win, gate)
  // A1-F6：窗口关闭时丢弃排队状态并清理记录（避免销毁后延迟 apply / 状态泄漏）。
  win.once('closed', () => {
    gate.dispose()
    ignoreMouseGates.delete(win)
    ignoreMouseApplied.delete(win)
  })
  return gate
}

/** 隐藏窗口前落地排队中的穿透切换（A1-F6；避免 hide 后仍有一帧延迟任务改状态）。 */
function flushIgnoreMouseGates(windows: BrowserWindow[]): void {
  for (const win of windows) ignoreMouseGates.get(win)?.flush()
}

/** 全部 overlay 显隐：优先走 manager（含未加载窗口的显示意图），manager 未初始化时降级。 */
function setOverlaysVisible(ctx: AppContext, visible: boolean): void {
  const manager = getActiveOverlayWindowsManager()
  const windows = manager ? manager.getWindows() : ctx.getOverlayWindows()
  // A1-F6：隐藏前先落地排队中的穿透切换（避免 hide 之后延迟任务再改一次状态）。
  if (!visible) flushIgnoreMouseGates(windows)

  if (manager) {
    manager.setVisible(visible)
  } else {
    for (const win of windows) {
      if (win.isDestroyed()) continue
      // 显示一律 showInactive：不激活 app、不抢前台焦点（禁止 show()/focus()）
      if (visible) win.showInactive()
      else win.hide()
    }
  }
  // 托盘勾选态同步（托盘未创建时为 no-op）
  syncActiveTrayVisibility()
}

/**
 * 全部显示器的可序列化快照。
 * 顺序与 `screen.getAllDisplays()` 一致；`workArea` 是 overlay 几何与渲染坐标基准（PLAN §17.3-2）。
 */
export function getDisplayInfos(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    bounds: toRect(display.bounds),
    workArea: toRect(display.workArea),
    scaleFactor: display.scaleFactor,
    isPrimary: display.id === primaryId
  }))
}

/** 注册窗口 / 显示器 / 窗口动作领域的 invoke handler（ready 后由 `ipc/index.ts` 聚合调用一次）。 */
export function registerWindowIpc(ctx: AppContext): void {
  // ---------------- Lead 预置、冻结的只读 handler（A1 保留，不得删除） ----------------
  ipcMain.handle(IPC.windowInfo, (event): OverlayWindowInfo => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('pet:window-info: sender has no BrowserWindow')
    const bounds = toRect(win.getBounds())
    const display = screen.getDisplayMatching(bounds)
    return { id: win.id, bounds, displayId: display.id }
  })

  ipcMain.handle(IPC.screenInfo, (): DisplayInfo[] => getDisplayInfos())

  // ---------------- Wave 1 A1：窗口动作 / 系统集成 ----------------
  ipcMain.handle(IPC.setIgnoreMouse, (event, ignore: boolean): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('pet:set-ignore-mouse: sender has no BrowserWindow')
    getIgnoreMouseGate(win).request(ignore === true)
  })

  ipcMain.handle(IPC.setVisible, (_event, visible: boolean): void => {
    setOverlaysVisible(ctx, visible === true)
  })

  ipcMain.handle(IPC.quit, (): void => {
    // 先让 invoke 的 Promise 正常 resolve（renderer 不会收到 "Object has been destroyed"），
    // 下一 tick 再退出 app（与托盘「退出」语义一致）
    setImmediate(() => {
      app.quit()
    })
  })

  ipcMain.handle(
    IPC.accessibilityStatus,
    (): AccessibilityStatus => ({
      // false = 只查询当前信任状态，不弹系统授权提示
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      // R-25（复核结论：不修功能）：Electron 44 **没有**通知授权查询 API ——
      // `Notification.getSettings()` 不存在，`systemPreferences` 也没有
      // `getNotificationSettings()`（已核对 node_modules/electron/electron.d.ts）。
      // `Notification.isSupported()` 只能回答「平台是否支持通知」，在 macOS 恒 true，
      // 因此 'unknown' 是当前唯一诚实的值；不要为了「看起来能查询」伪造 granted/denied。
      // 等 Electron 提供正式 API 后再映射真实授权状态（届时只需改这一行）。
      notifications: Notification.isSupported() ? 'unknown' : 'unsupported'
    })
  )

  ipcMain.handle(IPC.openAccessibilitySettings, async (): Promise<void> => {
    await shell.openExternal(ACCESSIBILITY_SETTINGS_URL)
  })
}
