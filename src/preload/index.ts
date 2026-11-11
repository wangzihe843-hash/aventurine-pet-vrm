/**
 * preload 入口 —— Wave 0 一次性完整实现冻结契约 `PetApi`（src/shared/ipc.ts）
 *
 * 之后 Wave1+ 各任务只需要在主进程补 `ipcMain.handle` / `webContents.send`，
 * 不需要再改本文件（如需扩展契约，先走 Lead 评审）。
 *
 * 暴露（严格白名单，遵循 PLAN §4 / §7：renderer 只能看到一个受限 API）：
 * - `window.api`：PetApi 白名单转发层（唯一的桥接面）
 *
 * 不暴露 `window.electron` / 原始 `ipcRenderer` / `process.env`：
 * 那些会把任意 IPC channel 与宿主环境变量暴露给渲染进程，超出白名单范围。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC, IPC_EVENTS } from '@shared/ipc'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeArgs,
  IpcInvokeResult,
  PetApi,
  Unsubscribe
} from '@shared/ipc'

/** 类型安全的 invoke 转发：channel 与参数/返回值在编译期对齐 IpcInvokeMap。 */
function invoke<K extends IpcChannel>(
  channel: K,
  ...args: IpcInvokeArgs<K>
): Promise<IpcInvokeResult<K>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcInvokeResult<K>>
}

/** 类型安全的事件订阅：返回取消订阅函数。 */
function subscribe<K extends IpcEventChannel>(
  channel: K,
  callback: (payload: IpcEventPayload<K>) => void
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: IpcEventPayload<K>): void => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** 冻结契约的前端转发实现（纯转发，无业务逻辑）。 */
const petApi: PetApi = {
  getConfig: () => invoke(IPC.getConfig),
  setConfig: (config) => invoke(IPC.setConfig, config),
  getScreenInfo: () => invoke(IPC.screenInfo),
  getWindows: () => invoke(IPC.windows),
  setIgnoreMouse: (ignore) => invoke(IPC.setIgnoreMouse, ignore),
  getWindowInfo: () => invoke(IPC.windowInfo),
  getAccessibilityStatus: () => invoke(IPC.accessibilityStatus),
  openAccessibilitySettings: () => invoke(IPC.openAccessibilitySettings),
  // R-21 占位契约（不要删除）：Wave 3 C1 未实现 —— main 无 handler、当前 renderer 无调用点；
  // 键集合被 tests/shared-contract.test.ts 冻结。调用会 reject `No handler registered`（预期）。
  moveWindow: (payload) => invoke(IPC.moveWindow, payload),
  getDshStatus: () => invoke(IPC.dshStatus),
  // R-21 占位契约（不要删除）：Wave 3 C3 未实现 —— main 无 handler、当前 renderer 无调用点。
  notify: (title, body) => invoke(IPC.notify, title, body),
  showSettings: () => invoke(IPC.showSettings),
  quit: () => invoke(IPC.quit),
  setVisible: (visible) => invoke(IPC.setVisible, visible),

  onWindowsUpdated: (callback) => subscribe(IPC_EVENTS.windowsUpdated, callback),
  onDshEvent: (callback) => subscribe(IPC_EVENTS.dshEvent, callback),
  onConfigChanged: (callback) => subscribe(IPC_EVENTS.configChanged, callback),
  onScreensUpdated: (callback) => subscribe(IPC_EVENTS.screensUpdated, callback)
}

// contextIsolation 开启时（本项目始终开启）通过 contextBridge 暴露唯一白名单 API。
// R-26：关闭 contextIsolation 属于安全配置错误，必须 **fail-fast**（不再静默把 petApi 挂到
// window 上）。两个 BrowserWindow 都硬编码 `contextIsolation: true`，所以该分支实际不可达；
// 一旦未来误关，preload 直接抛错会让错误在启动时暴露，而不是静默退化成全局对象。
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', petApi)
  } catch (error) {
    console.error('[preload] contextBridge expose failed:', error)
  }
} else {
  console.error(
    '[preload] contextIsolation is disabled; refusing to expose window.api without context isolation'
  )
  throw new Error(
    '[preload] contextIsolation 必须开启：拒绝在未隔离的上下文暴露 window.api（请检查 BrowserWindow webPreferences）'
  )
}
