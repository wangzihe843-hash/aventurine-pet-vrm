/**
 * 冻结共享契约 —— IPC 通道与 API 表面（M0-2）
 *
 * 规则：
 * - 环境中立纯 TS，禁止 import electron / node: 内置模块 / 第三方运行时依赖。
 * - preload 只暴露白名单（本文件里的 IPC / IPC_EVENTS）。
 * - 主进程 Wave1+ 只负责 `ipcMain.handle(IPC.xxx, ...)` 与
 *   `webContents.send(IPC_EVENTS.xxx, payload)`；channel 名不得私自变更。
 * - 冻结后改动需经 Lead / M0 负责人。
 */
import type {
  AccessibilityStatus,
  DisplayInfo,
  DshEvent,
  DshStatus,
  OverlayWindowInfo,
  PetConfig,
  Rect,
  WindowInfo
} from './types'

/** 渲染进程 → 主进程（invoke/handle）通道名。 */
export const IPC = {
  getConfig: 'pet:get-config',
  setConfig: 'pet:set-config',
  screenInfo: 'pet:screen-info',
  windows: 'pet:windows',
  setIgnoreMouse: 'pet:set-ignore-mouse',
  windowInfo: 'pet:window-info',
  accessibilityStatus: 'pet:accessibility-status',
  openAccessibilitySettings: 'pet:open-accessibility-settings',
  /**
   * R-21 契约占位（**不要删除**）：Wave 3 C1（真实拖动其它窗口）尚未实现 —— 主进程没有
   * `ipcMain.handle`，当前 renderer 也无调用点。`tests/shared-contract.test.ts` 冻结了
   * PetApi 键集合（含本键），删除会直接让契约测试失败；调用会在 renderer 侧 reject
   * `No handler registered`，属预期（Wave 3 补 handler 后自然可用）。
   */
  moveWindow: 'pet:move-window',
  dshStatus: 'pet:dsh-status',
  /**
   * R-21 契约占位（**不要删除**）：Wave 3 C3（系统通知）尚未实现 —— 主进程没有 handler，
   * 当前 renderer 无调用点；契约键被 `tests/shared-contract.test.ts` 冻结，见 `moveWindow` 同上。
   */
  notify: 'pet:notify',
  showSettings: 'pet:show-settings',
  quit: 'pet:quit',
  setVisible: 'pet:set-visible'
} as const

/** 主进程 → 渲染进程（webContents.send / ipcRenderer.on）事件通道名。 */
export const IPC_EVENTS = {
  windowsUpdated: 'windows-updated',
  dshEvent: 'dsh-event',
  configChanged: 'config-changed',
  /** 显示器拓扑/工作区变化（分辨率、Dock/菜单栏自动隐藏、插拔屏）时推送最新 DisplayInfo[]。 */
  screensUpdated: 'screens-updated'
} as const

/** 所有 invoke/handle 通道的联合类型。 */
export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 所有主→渲染事件通道的联合类型。 */
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

/**
 * `pet:move-window` 的参数占位。
 * Wave3 C1（真实拖动其它窗口）可能扩展该结构（例如增加动画/时长/插值标记）。
 */
export interface MoveWindowPayload {
  windowId: number
  bounds: Rect
}

/**
 * 每个 invoke 通道的参数元组与返回类型。
 * `args` 为传给 `ipcRenderer.invoke(channel, ...args)` 的参数列表。
 */
export interface IpcInvokeMap {
  'pet:get-config': { args: []; result: PetConfig }
  /** 允许传 Partial：主进程用 sanitizeConfig 合并/钳制后返回最终配置 */
  'pet:set-config': { args: [config: Partial<PetConfig>]; result: PetConfig }
  'pet:screen-info': { args: []; result: DisplayInfo[] }
  'pet:windows': { args: []; result: WindowInfo[] }
  'pet:set-ignore-mouse': { args: [ignore: boolean]; result: void }
  'pet:window-info': { args: []; result: OverlayWindowInfo }
  'pet:accessibility-status': { args: []; result: AccessibilityStatus }
  'pet:open-accessibility-settings': { args: []; result: void }
  /** Wave3 C1 可能扩展 payload 结构 */
  'pet:move-window': { args: [payload: MoveWindowPayload]; result: void }
  'pet:dsh-status': { args: []; result: DshStatus }
  'pet:notify': { args: [title: string, body: string]; result: void }
  'pet:show-settings': { args: []; result: void }
  'pet:quit': { args: []; result: void }
  'pet:set-visible': { args: [visible: boolean]; result: void }
}

/** 每个主→渲染事件的 payload 类型。 */
export interface IpcEventMap {
  'windows-updated': WindowInfo[]
  'dsh-event': DshEvent
  'config-changed': PetConfig
  'screens-updated': DisplayInfo[]
}

export type IpcInvokeArgs<K extends IpcChannel> = IpcInvokeMap[K]['args']
export type IpcInvokeResult<K extends IpcChannel> = IpcInvokeMap[K]['result']
export type IpcEventPayload<K extends IpcEventChannel> = IpcEventMap[K]

/** 事件订阅返回的取消订阅函数。 */
export type Unsubscribe = () => void

/**
 * preload 通过 contextBridge 暴露给渲染进程的 `window.api` 表面。
 * Wave0 由 preload 完整实现（纯转发），Wave1+ 只需在 main 侧补 handler。
 */
export interface PetApi {
  // ---- invoke ----
  getConfig(): Promise<PetConfig>
  setConfig(config: Partial<PetConfig>): Promise<PetConfig>
  getScreenInfo(): Promise<DisplayInfo[]>
  getWindows(): Promise<WindowInfo[]>
  setIgnoreMouse(ignore: boolean): Promise<void>
  getWindowInfo(): Promise<OverlayWindowInfo>
  getAccessibilityStatus(): Promise<AccessibilityStatus>
  openAccessibilitySettings(): Promise<void>
  /** R-21 占位契约：Wave3 C1 未实现（主进程无 handler、renderer 无调用点），键被 shared-contract 冻结。 */
  moveWindow(payload: MoveWindowPayload): Promise<void>
  getDshStatus(): Promise<DshStatus>
  /** R-21 占位契约：Wave3 C3 未实现（主进程无 handler、renderer 无调用点），键被 shared-contract 冻结。 */
  notify(title: string, body: string): Promise<void>
  showSettings(): Promise<void>
  quit(): Promise<void>
  setVisible(visible: boolean): Promise<void>

  // ---- 事件订阅（返回取消订阅函数） ----
  onWindowsUpdated(callback: (windows: WindowInfo[]) => void): Unsubscribe
  onDshEvent(callback: (event: DshEvent) => void): Unsubscribe
  onConfigChanged(callback: (config: PetConfig) => void): Unsubscribe
  /** 显示器拓扑/workArea 变化（分辨率、Dock/菜单栏自动隐藏、插拔屏）。 */
  onScreensUpdated(callback: (displays: DisplayInfo[]) => void): Unsubscribe
}
