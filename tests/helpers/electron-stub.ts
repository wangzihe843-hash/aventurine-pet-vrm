/**
 * 共享 Electron stub（Wave 1 M-5 正式测试基建）。
 *
 * 目的：让 `src/main/windows/overlay-manager.ts` / `src/main/tray.ts` /
 * `src/main/ipc/window.ts` / `src/main/ipc/desktop.ts` 可以在 vitest node 环境里
 * **直接 import 真实实现**跑单测，不启动真实 Electron。
 *
 * 用法（每个测试文件顶部；`vi.mock` 会被 vitest 提升，工厂内动态 import 保证拿到同一份 stub 单例）：
 *
 * ```ts
 * vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)
 *
 * import { electronStub, resetElectronStub } from './helpers/electron-stub'
 * beforeEach(() => resetElectronStub())
 * ```
 *
 * 覆盖的 electron API（按 A1/A4 实际 import 面）：
 * `BrowserWindow`（含 `fromWebContents`、可注入建窗失败）、`screen`、`app`、`Tray`、
 * `Menu`、`nativeImage`、`ipcMain`、`Notification`、`shell`、`systemPreferences`。
 *
 * 只记录调用、不做真实 OS 交互；断言尽量直接读实例上的 `*Calls` 数组，避免 `vi.spyOn`
 * 跨模块作用域问题。
 */
import { EventEmitter } from 'node:events'

/* ---------------------------------- 基础类型 ---------------------------------- */

/** 屏幕 / 窗口矩形（与 electron Rectangle 同形）。 */
export interface StubRect {
  x: number
  y: number
  width: number
  height: number
}

/** `screen.getAllDisplays()` 的显示器夹具（`isPrimary` 仅用于 stub 推导主屏）。 */
export interface StubDisplay {
  id: number
  bounds: StubRect
  workArea: StubRect
  scaleFactor: number
  isPrimary?: boolean
}

/** `setIgnoreMouseEvents` 调用记录。 */
export interface IgnoreMouseCall {
  ignore: boolean
  options?: { forward?: boolean }
}

/** 深拷贝矩形（避免测试改 fixture 污染窗口 / 显示器快照）。 */
function copyRect(rect: StubRect): StubRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

/** 深拷贝显示器。 */
function copyDisplay(display: StubDisplay): StubDisplay {
  return {
    id: display.id,
    bounds: copyRect(display.bounds),
    workArea: copyRect(display.workArea),
    scaleFactor: display.scaleFactor,
    isPrimary: display.isPrimary === true
  }
}

/* --------------------------------- FakeWebContents --------------------------------- */

/** `BrowserWindow.webContents` 的最小桩：EventEmitter + send / isDestroyed。 */
export class FakeWebContents extends EventEmitter {
  /** 是否已销毁（窗口 destroy 时同步置 true）。 */
  destroyed = false
  /** `webContents.send()` 的调用记录（广播断言用）。 */
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  /** `setBackgroundThrottling` 的调用记录（R-15：overlay 显隐节流切换断言用）。 */
  readonly backgroundThrottlingCalls: boolean[] = []
  /** `setWindowOpenHandler` 最近一次注册的 handler（安全加固测试用）。 */
  windowOpenHandler: unknown = null

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error('Object has been destroyed')
    this.sent.push({ channel, payload })
  }

  /**
   * R-15 增补：Electron 44 `webContents.setBackgroundThrottling(allowed)` 的记录桩。
   * 只记录参数，不模拟 Chromium 节流行为；测试断言「隐藏 true / 显示 false」。
   */
  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed)
  }

  setWindowOpenHandler(handler: unknown): unknown {
    this.windowOpenHandler = handler
    return handler
  }

  openDevTools(): void {
    /* no-op */
  }
}

/* --------------------------------- FakeBrowserWindow --------------------------------- */

/** `BrowserWindow` 桩：记录所有构造选项与生命周期调用。 */
export class FakeBrowserWindow extends EventEmitter {
  /** 创建序号（窗口 id 自增）。 */
  static nextId = 1
  /** 当前 stub 生命周期内创建过的全部窗口（按创建顺序）。 */
  static instances: FakeBrowserWindow[] = []
  /** 下一次构造是否抛错（用于「单个显示器建窗失败隔离」测试）。 */
  static failNextCreateWith: Error | null = null
  /** webContents → window 映射（`BrowserWindow.fromWebContents`）。 */
  static readonly byWebContents = new Map<FakeWebContents, FakeBrowserWindow>()

  readonly id: number
  /** 构造时传入的 BrowserWindowConstructorOptions（浅拷贝；webPreferences 深拷贝一层）。 */
  readonly options: Record<string, unknown>
  /** 窗口 webContents 桩。 */
  webContents: FakeWebContents
  /** 当前 bounds（getBounds 返回拷贝）。 */
  readonly bounds: StubRect

  readonly ignoreMouseCalls: IgnoreMouseCall[] = []
  readonly setBoundsCalls: StubRect[] = []
  readonly alwaysOnTopCalls: Array<{ flag: boolean; level?: string }> = []
  readonly visibleOnAllWorkspacesCalls: Array<{
    flag: boolean
    options?: Record<string, unknown>
  }> = []
  readonly loadCalls: string[] = []

  showCalls = 0
  showInactiveCalls = 0
  hideCalls = 0
  focusCalls = 0
  destroyCalls = 0

  private destroyedFlag = false
  private visibleFlag = false
  private alwaysOnTopFlag = false
  private visibleOnAllWorkspacesFlag = false

  constructor(options: Record<string, unknown> = {}) {
    super()
    const failure = FakeBrowserWindow.failNextCreateWith
    if (failure) {
      FakeBrowserWindow.failNextCreateWith = null
      throw failure
    }
    this.id = FakeBrowserWindow.nextId
    FakeBrowserWindow.nextId += 1
    this.options = {
      ...options,
      webPreferences: { ...((options['webPreferences'] as Record<string, unknown>) ?? {}) }
    }
    this.bounds = {
      x: Number(options['x'] ?? 0),
      y: Number(options['y'] ?? 0),
      width: Number(options['width'] ?? 800),
      height: Number(options['height'] ?? 600)
    }
    this.webContents = new FakeWebContents()
    FakeBrowserWindow.instances.push(this)
    FakeBrowserWindow.byWebContents.set(this.webContents, this)
  }

  /** 按 webContents 反查窗口（真实 `BrowserWindow.fromWebContents` 语义）。 */
  static fromWebContents(webContents: unknown): FakeBrowserWindow | null {
    return FakeBrowserWindow.byWebContents.get(webContents as FakeWebContents) ?? null
  }

  isDestroyed(): boolean {
    return this.destroyedFlag
  }

  destroy(): void {
    if (this.destroyedFlag) return
    this.destroyedFlag = true
    this.destroyCalls += 1
    this.visibleFlag = false
    this.webContents.destroyed = true
    this.emit('closed')
  }

  close(): void {
    this.destroy()
  }

  isVisible(): boolean {
    return this.visibleFlag && !this.destroyedFlag
  }

  show(): void {
    this.showCalls += 1
    this.visibleFlag = true
  }

  /** 只应被 overlay-manager 使用；show() 的调用次数单独记录以便断言「禁止 show」。 */
  showInactive(): void {
    this.showInactiveCalls += 1
    this.visibleFlag = true
  }

  hide(): void {
    this.hideCalls += 1
    this.visibleFlag = false
  }

  focus(): void {
    this.focusCalls += 1
  }

  getBounds(): StubRect {
    return copyRect(this.bounds)
  }

  setBounds(rect: StubRect): void {
    this.setBoundsCalls.push(copyRect(rect))
    this.bounds.x = rect.x
    this.bounds.y = rect.y
    this.bounds.width = rect.width
    this.bounds.height = rect.height
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.alwaysOnTopFlag = flag
    this.alwaysOnTopCalls.push({ flag, level })
  }

  isAlwaysOnTop(): boolean {
    return this.alwaysOnTopFlag
  }

  setVisibleOnAllWorkspaces(flag: boolean, options?: Record<string, unknown>): void {
    this.visibleOnAllWorkspacesFlag = flag
    this.visibleOnAllWorkspacesCalls.push({
      flag,
      options: options ? { ...options } : undefined
    })
  }

  isVisibleOnAllWorkspaces(): boolean {
    return this.visibleOnAllWorkspacesFlag
  }

  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
    this.ignoreMouseCalls.push({
      ignore,
      options: options ? { ...options } : undefined
    })
  }

  loadURL(url: string): Promise<void> {
    this.loadCalls.push(url)
    return Promise.resolve()
  }

  loadFile(file: string): Promise<void> {
    this.loadCalls.push(file)
    return Promise.resolve()
  }

  setSkipTaskbar(): void {
    /* 构造期配置已覆盖，运行时无调用 */
  }

  setResizable(): void {
    /* no-op */
  }
}

/* ------------------------------------ FakeScreen ------------------------------------ */

/** `screen` 桩：维护显示器列表并转发 EventEmitter（display-* 事件）。 */
export class FakeScreen extends EventEmitter {
  private displays: StubDisplay[] = []
  private primaryId: number | null = null

  /** 设置显示器快照；主屏按 `isPrimary` 推导，缺省取第一个。 */
  setDisplays(displays: StubDisplay[]): void {
    this.displays = displays.map(copyDisplay)
    this.primaryId = displays.find((display) => display.isPrimary === true)?.id ?? displays[0]?.id ?? null
  }

  getAllDisplays(): StubDisplay[] {
    return this.displays.map(copyDisplay)
  }

  getPrimaryDisplay(): StubDisplay {
    const primary = this.displays.find((display) => display.id === this.primaryId) ?? this.displays[0]
    if (!primary) {
      const empty: StubRect = { x: 0, y: 0, width: 0, height: 0 }
      return { id: -1, bounds: empty, workArea: empty, scaleFactor: 1, isPrimary: true }
    }
    return { ...copyDisplay(primary), isPrimary: true }
  }

  /** 按矩形覆盖面积最大者匹配显示器（与 Electron 语义接近，足够测试使用）。 */
  getDisplayMatching(rect: StubRect): StubDisplay {
    if (this.displays.length === 0) return this.getPrimaryDisplay()
    let best = this.displays[0]
    let bestArea = -1
    for (const display of this.displays) {
      const area = overlapArea(rect, display.bounds)
      if (area > bestArea) {
        best = display
        bestArea = area
      }
    }
    return copyDisplay(best)
  }

  /** 清空监听器与显示器（测试间隔离）。 */
  reset(): void {
    this.removeAllListeners()
    this.displays = []
    this.primaryId = null
  }
}

/** 两个矩形的交叠面积（无交叠为 0）。 */
function overlapArea(a: StubRect, b: StubRect): number {
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return 0
  return (right - left) * (bottom - top)
}

/* ------------------------------------- FakeApp ------------------------------------- */

/** `app` 桩：EventEmitter（will-quit）+ 路径 / 退出记录。 */
export class FakeApp extends EventEmitter {
  isPackaged = false
  appPath = process.cwd()
  quitCalls = 0
  readonly exitCalls: Array<number | undefined> = []
  readonly activationPolicies: string[] = []
  readonly dock = {
    hideCalls: 0,
    showCalls: 0,
    hide(): void {
      this.hideCalls += 1
    },
    show(): void {
      this.showCalls += 1
    }
  }

  getAppPath(): string {
    return this.appPath
  }

  getPath(name: string): string {
    return `/tmp/aventurine-pet-test/${name}`
  }

  getVersion(): string {
    return '0.0.0-test'
  }

  getName(): string {
    return 'aventurine-pet-test'
  }

  setName(): void {
    /* no-op */
  }

  isReady(): boolean {
    return true
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  quit(): void {
    this.quitCalls += 1
  }

  exit(code?: number): void {
    this.exitCalls.push(code)
  }

  setActivationPolicy(policy: string): boolean {
    this.activationPolicies.push(policy)
    return true
  }

  reset(): void {
    this.removeAllListeners()
    this.quitCalls = 0
    this.exitCalls.length = 0
    this.activationPolicies.length = 0
    this.dock.hideCalls = 0
    this.dock.showCalls = 0
    this.isPackaged = false
    this.appPath = process.cwd()
  }
}

/* ------------------------------------ FakeIpcMain ------------------------------------ */

/** `ipcMain` 桩：与真实 Electron 一样，同一 channel 重复 handle 会抛错。 */
export class FakeIpcMain {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  /** 直接触发 handler（测试不模拟完整 IPC 编解码）。 */
  async invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for '${channel}'`)
    return await handler(event, ...args)
  }
}

/* ------------------------------------- FakeTray ------------------------------------- */

/** `Tray` 桩：记录 tooltip / context menu / destroy。 */
export class FakeTray {
  static instances: FakeTray[] = []

  readonly image: unknown
  readonly menuSetCalls: unknown[] = []
  toolTip: string | null = null
  menu: unknown = null
  destroyCalls = 0
  destroyed = false

  constructor(image: unknown) {
    this.image = image
    FakeTray.instances.push(this)
  }

  setToolTip(toolTip: string): void {
    this.toolTip = toolTip
  }

  setContextMenu(menu: unknown): void {
    this.menu = menu
    this.menuSetCalls.push(menu)
  }

  getBounds(): StubRect {
    return { x: 0, y: 0, width: 32, height: 30 }
  }

  destroy(): void {
    this.destroyed = true
    this.destroyCalls += 1
  }
}

/* ------------------------------------- FakeMenu ------------------------------------- */

/** `Menu` 桩：`buildFromTemplate` 返回带 template 的对象，测试直接检查菜单结构。 */
export class FakeMenu {
  static instances: FakeMenu[] = []

  constructor(readonly template: Array<Record<string, unknown>>) {
    FakeMenu.instances.push(this)
  }

  static buildFromTemplate(template: Array<Record<string, unknown>>): FakeMenu {
    return new FakeMenu(template)
  }
}

/* ---------------------------------- FakeNativeImage ---------------------------------- */

/** `nativeImage` 返回的图像桩。 */
export class FakeNativeImage {
  readonly setTemplateImageCalls: boolean[] = []
  private template = false

  constructor(
    readonly sourcePath: string | null,
    private readonly empty: boolean = false
  ) {}

  isEmpty(): boolean {
    return this.empty
  }

  setTemplateImage(value: boolean): void {
    this.template = value
    this.setTemplateImageCalls.push(value)
  }

  isTemplateImage(): boolean {
    return this.template
  }

  getSize(): { width: number; height: number } {
    return { width: 16, height: 16 }
  }
}

/** `nativeImage` 工厂桩。 */
export class FakeNativeImageModule {
  readonly createdPaths: string[] = []
  readonly images: FakeNativeImage[] = []
  /** 这些路径返回空图像（模拟图标缺失）。 */
  readonly emptyPaths = new Set<string>()

  createFromPath(filePath: string): FakeNativeImage {
    this.createdPaths.push(filePath)
    const image = new FakeNativeImage(filePath, this.emptyPaths.has(filePath))
    this.images.push(image)
    return image
  }

  createEmpty(): FakeNativeImage {
    const image = new FakeNativeImage(null, true)
    this.images.push(image)
    return image
  }

  createFromNamedImage(name: string): FakeNativeImage {
    return this.createFromPath(`named:${name}`)
  }

  reset(): void {
    this.createdPaths.length = 0
    this.images.length = 0
    this.emptyPaths.clear()
  }
}

/* --------------------------------- FakeNotification --------------------------------- */

/** `Notification` 桩（只用到 `isSupported()`）。 */
export class FakeNotification {
  static supported = true

  static isSupported(): boolean {
    return FakeNotification.supported
  }
}

/* ------------------------------------ FakeShell ------------------------------------ */

/** `shell` 桩。 */
export class FakeShellModule {
  readonly openExternalCalls: string[] = []

  async openExternal(url: string): Promise<void> {
    this.openExternalCalls.push(url)
  }

  reset(): void {
    this.openExternalCalls.length = 0
  }
}

/* ------------------------------- FakeSystemPreferences ------------------------------- */

/** `systemPreferences` 桩。 */
export class FakeSystemPreferences {
  trusted = true
  /** `isTrustedAccessibilityClient(prompt)` 的调用参数记录。 */
  readonly trustQueries: boolean[] = []

  isTrustedAccessibilityClient(prompt: boolean): boolean {
    this.trustQueries.push(prompt)
    return this.trusted
  }

  reset(): void {
    this.trusted = true
    this.trustQueries.length = 0
  }
}

/* ----------------------------------- 单例 / 导出 ----------------------------------- */

/**
 * 全局单例 stub。测试文件通过 `vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)`
 * 注入；`beforeEach(() => resetElectronStub())` 清理全部记录。
 */
class ElectronStub {
  readonly app = new FakeApp()
  readonly screen = new FakeScreen()
  readonly ipcMain = new FakeIpcMain()
  readonly nativeImage = new FakeNativeImageModule()
  readonly shell = new FakeShellModule()
  readonly systemPreferences = new FakeSystemPreferences()
  /** 类本身（`electronStub.BrowserWindow.instances` / `failNextCreateWith` 断言用）。 */
  readonly BrowserWindow = FakeBrowserWindow
  readonly Tray = FakeTray
  readonly Menu = FakeMenu
  readonly Notification = FakeNotification

  /** mock factory 返回的 electron 模块命名导出。 */
  readonly module: Record<string, unknown> = {
    app: this.app,
    screen: this.screen,
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Menu: FakeMenu,
    nativeImage: this.nativeImage,
    ipcMain: this.ipcMain,
    Notification: FakeNotification,
    shell: this.shell,
    systemPreferences: this.systemPreferences
  }

  /** 让下一次 `new BrowserWindow()` 抛错（只生效一次）。 */
  failNextWindowCreation(error: Error = new Error('BrowserWindow creation failed')): void {
    FakeBrowserWindow.failNextCreateWith = error
  }

  /** 清理所有静态记录与监听器（测试 beforeEach 调用）。 */
  reset(): void {
    FakeBrowserWindow.instances = []
    FakeBrowserWindow.nextId = 1
    FakeBrowserWindow.failNextCreateWith = null
    FakeBrowserWindow.byWebContents.clear()

    FakeTray.instances = []
    FakeMenu.instances = []
    FakeNotification.supported = true

    this.ipcMain.handlers.clear()
    this.nativeImage.reset()
    this.shell.reset()
    this.systemPreferences.reset()
    this.screen.reset()
    this.app.reset()
  }
}

export const electronStub = new ElectronStub()

/** `electronStub.reset()` 的语义化别名。 */
export function resetElectronStub(): void {
  electronStub.reset()
}

/** 便捷：当前 stub 创建的窗口列表（含已销毁）。 */
export function stubWindows(): FakeBrowserWindow[] {
  return FakeBrowserWindow.instances
}
