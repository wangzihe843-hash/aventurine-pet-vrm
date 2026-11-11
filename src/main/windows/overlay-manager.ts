/**
 * 多屏 overlay 窗口管理器（Wave 1 A1）
 *
 * 职责（PLAN §5-A1 / §17.3-2 / §17.5 P1-5/P1-6 / §18.3）：
 * - **每个显示器一个**透明置顶 overlay 窗口，frame = 该显示器 `workArea`
 *   （禁止所有屏包围矩形的单窗口写法：负坐标 / 上下错位 / 工作区空洞都会错位）；
 * - 监听 `display-added` / `display-removed` / `display-metrics-changed`（debounce 200ms）
 *   → 增窗 / 关窗 / `setBounds`，并广播 `screens-updated`（A2 订阅重算尺寸）；
 * - 窗口登记到 `AppContext`（`setOverlayWindows` / `setPrimaryOverlay`），
 *   供 `ctx.broadcast`、`pet:set-visible`、`pet:window-info` 等使用；
 * - **不抢焦点**：`focusable:false` + 只允许 `showInactive()`（禁止 `show()` / `focus()`），
 *   层级 `screen-saver`、所有 Space / 全屏空间可见、默认 `ignoreMouse(forward)` 穿透；
 * - 创建窗口 / 加载 renderer / 安全加固由 `src/main/index.ts` 通过 deps 注入，
 *   A1 不改集成文件（PLAN §7）。
 *
 * 集成接线（Lead 在 `src/main/index.ts` 完成，见交付报告）：
 * 1. `const overlayManager = createOverlayWindowsManager({ ctx, getDisplays, loadContents, hardenWebContents, onWindowCreated, onDidFinishLoad })`
 * 2. `overlayManager.sync(getDisplayInfos())` + `overlayManager.startDisplayWatchers()`
 * 3. 退出时 `overlayManager.destroy()`（或依赖内部 `will-quit` 兜底清理）
 */
import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IPC_EVENTS } from '@shared/ipc'
import type { DisplayInfo } from '@shared/types'
import type { AppContext } from '../app-context'
import { computeOverlayLayouts } from './layout'

/** 显示器变化去抖（PLAN §17.3-2 定 200ms；与 Wave 0.5 行为一致） */
export const DISPLAY_CHANGE_DEBOUNCE_MS = 200

/** preload 路径（与 `src/main/index.ts` 既有写法一致：out/main/../preload/index.js） */
const PRELOAD_PATH = join(__dirname, '../preload/index.js')

/**
 * overlay 窗口构造 / 初始穿透 / 渲染契约的**共享常量（单一来源）**。
 *
 * - `transparent` / `sandbox` / `backgroundThrottling`：`createOverlayWindow()` 的 BrowserWindow
 *   选项（本文件直接引用，避免字面量漂移）；
 * - `ignoreMouse`：窗口创建后的初始穿透态（true + forward）；
 * - `textureCrossOrigin`：A2 renderer 加载贴图的 CORS 约定（`Image.crossOrigin`），
 *   主进程无窗口级 getter，作为构造契约快照的一部分由 `getOverlayConstructOnlySnapshot()`
 *   提供给冒烟断言（Lead 用其替换 `src/main/index.ts` 的 constructOnly 字面量）。
 */
export const OVERLAY_WINDOW_CONSTRUCT = {
  transparent: true,
  ignoreMouse: true,
  sandbox: true,
  /**
   * 构造期显式 false：桌宠**可见**时需要稳定帧率（窗口失焦 / 被遮挡不降频，见 PLAN §10）。
   * 隐藏时必须切回节流（R-15：隐藏后 Chromium 降 RAF，避免 VRM 每帧 humanoid/IK 空跑 GPU）：
   * `setVisible(false)` → `webContents.setBackgroundThrottling(true)`；
   * `setVisible(true)` 在 `showInactive()` 前置回 false。运行时切换见 `applyBackgroundThrottling`。
   */
  backgroundThrottling: false,
  textureCrossOrigin: 'anonymous'
} as const

/** 冒烟用构造期配置快照（Electron 无公开 getter 的字段；全部由共享常量派生）。 */
export interface OverlayConstructOnlySnapshot {
  transparent: boolean
  ignoreMouse: boolean
  sandbox: boolean
  backgroundThrottling: boolean
  textureCrossOrigin: 'anonymous'
}

/**
 * 取 overlay 构造期配置快照（单一来源，供 Lead 冒烟替换 `constructOnly` 字面量）。
 * 每次返回新对象，调用方修改不会污染共享常量。
 */
export function getOverlayConstructOnlySnapshot(): OverlayConstructOnlySnapshot {
  return {
    transparent: OVERLAY_WINDOW_CONSTRUCT.transparent,
    ignoreMouse: OVERLAY_WINDOW_CONSTRUCT.ignoreMouse,
    sandbox: OVERLAY_WINDOW_CONSTRUCT.sandbox,
    backgroundThrottling: OVERLAY_WINDOW_CONSTRUCT.backgroundThrottling,
    textureCrossOrigin: OVERLAY_WINDOW_CONSTRUCT.textureCrossOrigin
  }
}

/** overlay 管理器依赖（集成逻辑由 `src/main/index.ts` 注入）。 */
export interface OverlayWindowDeps {
  /** 进程级应用上下文（overlay 注册表 + 广播）。 */
  ctx: AppContext
  /** 最新显示器快照（注入 `ipc/window.getDisplayInfos`，避免模块循环依赖）。 */
  getDisplays(): DisplayInfo[]
  /** 加载 renderer（dev server / loadFile），由 index.ts 提供。 */
  loadContents(win: BrowserWindow): void
  /** 安全加固（导航 / 重定向 / 新窗口拒绝），由 index.ts 提供。 */
  hardenWebContents(win: BrowserWindow): void
  /** 窗口创建后、加固 / 加载前的回调（冒烟守护 / 生命周期挂载点）。 */
  onWindowCreated?(win: BrowserWindow, display: DisplayInfo): void
  /** 每次 `did-finish-load` 后的回调（冒烟报告挂载点；可能多次触发，由调用方去重）。 */
  onDidFinishLoad?(win: BrowserWindow, display: DisplayInfo): void
}

/** 多屏 overlay 窗口管理器（`src/main/index.ts` 进程内创建一次）。 */
export interface OverlayWindowsManager {
  /** 按显示器快照同步窗口：新显示器建窗、已移除显示器关窗、workArea 变化 setBounds。 */
  sync(displays: DisplayInfo[]): void
  /** 监听显示器拓扑 / 工作区变化（debounce 200ms → sync + 广播 screens-updated）。 */
  startDisplayWatchers(): void
  /** 当前存活的全部 overlay 窗口（顺序沿用显示器快照顺序）。 */
  getWindows(): BrowserWindow[]
  /** 指定显示器的 overlay 窗口；不存在 / 已销毁时返回 null。 */
  getWindowForDisplay(displayId: number): BrowserWindow | null
  /** 主显示器 overlay（无主屏标记时回退第一个存活窗口）。 */
  getPrimaryWindow(): BrowserWindow | null
  /** 显示 / 隐藏全部 overlay（显示只走 `showInactive()`，禁止 show()/focus()）。 */
  setVisible(visible: boolean): void
  /** 当前显示意图（默认 true；`setVisible` 后更新）。 */
  isVisible(): boolean
  /** 销毁全部窗口、移除显示器监听、清理定时器（幂等；app 退出时调用）。 */
  destroy(): void
}

interface OverlayEntry {
  win: BrowserWindow
  display: DisplayInfo
}

/** 当前活跃管理器（`pet:set-visible` 等 handler 通过 getter 使用；未创建时为 null）。 */
let activeManager: OverlayWindowsManager | null = null

/** 取当前活跃管理器；未创建（如冒烟骨架路径）时返回 null，调用方需降级。 */
export function getActiveOverlayWindowsManager(): OverlayWindowsManager | null {
  return activeManager
}

/** 矩形比较（只比较 location/size；不依赖 electron 的类型实现）。 */
function rectEquals(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

/**
 * 创建多屏 overlay 窗口管理器（app ready 后调用一次）。
 * 若已有活跃管理器，新的创建会替换 active 引用（正常情况下不会同时存在两个）。
 */
export function createOverlayWindowsManager(deps: OverlayWindowDeps): OverlayWindowsManager {
  /** displayId → 窗口 / 显示器快照 */
  const entries = new Map<number, OverlayEntry>()
  /** `did-finish-load` 已完成的窗口（隐藏状态下新建的窗口不在加载完成前显示） */
  const loadedWindows = new WeakSet<BrowserWindow>()

  /** 主显示器 id（由最近一次 sync 的布局决定；无标记时回退第一个窗口） */
  let primaryDisplayId: number | null = null
  /** 显示意图（托盘勾选 / `pet:set-visible` 的持久状态；默认显示） */
  let visible = true
  /** destroy 后所有入口变空操作（幂等） */
  let destroyed = false
  /** 显示器监听只挂一次 */
  let watchersAttached = false
  /** 显示器变化去抖定时器 */
  let displayChangeTimer: ReturnType<typeof setTimeout> | null = null
  /** 移除显示器监听（destroy 时调用） */
  let detachDisplayWatchers: (() => void) | null = null
  /** will-quit 兜底清理 */
  const onWillQuit = (): void => {
    destroy()
  }

  /** 存活窗口条目（按 Map 插入顺序 = 显示器快照顺序）。 */
  function aliveEntries(): OverlayEntry[] {
    return [...entries.values()].filter((entry) => !entry.win.isDestroyed())
  }

  function getPrimaryWindow(): BrowserWindow | null {
    if (primaryDisplayId !== null) {
      const entry = entries.get(primaryDisplayId)
      if (entry && !entry.win.isDestroyed()) return entry.win
    }
    const fallback = aliveEntries()[0]
    return fallback ? fallback.win : null
  }

  /**
   * R-15：按显隐状态切换 `webContents` 背景节流。
   *
   * - 隐藏时传 `visible=false` → `setBackgroundThrottling(true)`，Chromium 对隐藏窗口降 RAF，
   *   renderer 的 VRM 每帧 humanoid/foot-lock 不再空跑；
   * - 显示前传 `visible=true` → `setBackgroundThrottling(false)`，恢复 30fps 稳定帧率
   *   （构造选项仍是 `backgroundThrottling:false`，见 `OVERLAY_WINDOW_CONSTRUCT` 注释）。
   *
   * 窗口 / webContents 可能在调用前销毁（显示器热插拔 / 托盘快速切换），双重守卫后静默返回。
   */
  function applyBackgroundThrottling(win: BrowserWindow, visibleNow: boolean): void {
    if (win.isDestroyed()) return
    const contents = win.webContents
    if (!contents || contents.isDestroyed()) return
    contents.setBackgroundThrottling(!visibleNow)
  }

  /**
   * 显示窗口：**只走 `showInactive()`**（不激活 app、不抢前台焦点；禁止 show()/focus()）。
   * 已可见时幂等 —— 等价于「did-finish-load 后只显示一次」的去重，
   * 同时允许「隐藏后再次显示」正常生效（隐藏时 visible 意图为 false）。
   */
  function showInactiveIfNeeded(win: BrowserWindow): void {
    if (!visible || destroyed || win.isDestroyed()) return
    if (win.isVisible()) return
    win.showInactive()
  }

  /** 把当前窗口列表登记到 AppContext（closed / sync / destroy 后调用）。 */
  function registerWithContext(): void {
    const wins = aliveEntries().map((entry) => entry.win)
    deps.ctx.setOverlayWindows(wins)
    deps.ctx.setPrimaryOverlay(getPrimaryWindow())
  }

  /** 创建单个显示器的 overlay 窗口（选项严格按 PLAN §17.3-2 / §10 / §17.5 P1-5）。 */
  function createOverlayWindow(display: DisplayInfo): BrowserWindow {
    const { workArea } = display

    const win = new BrowserWindow({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
      // 透明置顶浮层（无边框 / 无阴影 / 全透明背景）
      transparent: OVERLAY_WINDOW_CONSTRUCT.transparent,
      frame: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      // 桌宠不参与焦点：永不成为 key window，不响应 Cmd+Tab、不抢前台输入
      focusable: false,
      // 穿透态下首次点击也不被 AppKit 吞掉（配合 ignoreMouse forward）
      acceptFirstMouse: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: OVERLAY_WINDOW_CONSTRUCT.sandbox,
        contextIsolation: true,
        nodeIntegration: false,
        // 桌宠需要稳定帧率：窗口不可见 / 失焦时不节流（PLAN §10）
        backgroundThrottling: OVERLAY_WINDOW_CONSTRUCT.backgroundThrottling
      }
    })

    try {
      // 置顶到最高常规层级（全屏应用之上），并在所有桌面空间 / 全屏空间中可见
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      // Wave 1 默认整体穿透；命中宠物时由 `pet:set-ignore-mouse` 切成拦截（A2 消费）
      win.setIgnoreMouseEvents(OVERLAY_WINDOW_CONSTRUCT.ignoreMouse, { forward: true })

      // 集成顺序固定：onWindowCreated → hardenWebContents → loadContents → attach 事件
      deps.onWindowCreated?.(win, display)
      deps.hardenWebContents(win)
      deps.loadContents(win)

      /** 回调里取最新显示器快照（created 之后到 did-finish-load 之间可能有 workArea 更新）。 */
      const currentDisplay = (): DisplayInfo => {
        const entry = entries.get(display.id)
        return entry && entry.win === win ? entry.display : display
      }

      win.webContents.on('did-finish-load', () => {
        loadedWindows.add(win)
        showInactiveIfNeeded(win)
        // R-15：隐藏期间新建并加载完成的窗口（显示器热插拔）保持背景节流，
        // 避免「构造期 false + 一直不显示」导致隐藏窗口仍按 30fps 空跑。
        if (!visible) applyBackgroundThrottling(win, false)
        deps.onDidFinishLoad?.(win, currentDisplay())
      })

      win.on('closed', () => {
        loadedWindows.delete(win)
        const entry = entries.get(display.id)
        if (entry && entry.win === win) entries.delete(display.id)
        // 窗口被意外关闭（如 renderer crash 后手动 close）时重新登记注册表
        if (!destroyed) registerWithContext()
      })
    } catch (error) {
      // 建窗后、登记前失败（Harden / loadContents / 事件挂载）：销毁半成品窗口再交给
      // sync() 的显示器级隔离处理，避免孤儿窗口泄漏。
      if (!win.isDestroyed()) win.destroy()
      throw error
    }

    return win
  }

  /** 关闭窗口：destroy 不触发 beforeunload，避免退出时卡在未加载页面。 */
  function closeWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    win.destroy()
  }

  function sync(displays: DisplayInfo[]): void {
    if (destroyed) return

    try {
      syncWindows(displays)
    } catch (error) {
      // 兜底：sync 自身（布局 / 广播 / ctx 登记）异常不能冒泡到 setTimeout 回调，
      // 否则生产模式会变成 uncaughtException（显示器热插拔期间尤其危险）。
      console.error('[overlay] failed to sync overlay windows:', error)
    }
  }

  /** sync 的实际实现；单个显示器建窗失败在循环内隔离，不影响其余显示器。 */
  function syncWindows(displays: DisplayInfo[]): void {
    const layouts = computeOverlayLayouts(displays)
    // 显示器快照去重（与 computeOverlayLayouts 一致：首次出现优先）
    const displayById = new Map<number, DisplayInfo>()
    for (const display of displays) {
      if (!displayById.has(display.id)) displayById.set(display.id, display)
    }

    const nextDisplayIds: number[] = []
    for (const layout of layouts) {
      const display = displayById.get(layout.displayId)
      if (!display) continue
      nextDisplayIds.push(display.id)

      const existing = entries.get(display.id)
      if (existing && !existing.win.isDestroyed()) {
        // 同 id 仍在：不重建窗口，只同步 workArea 变化与显示器快照
        if (!rectEquals(existing.win.getBounds(), display.workArea)) {
          existing.win.setBounds({
            x: display.workArea.x,
            y: display.workArea.y,
            width: display.workArea.width,
            height: display.workArea.height
          })
        }
        existing.display = display
        continue
      }

      try {
        const win = createOverlayWindow(display)
        entries.set(display.id, { win, display })
      } catch (error) {
        // 单屏建窗失败（资源 / Electron 时序异常）只跳过该屏：其余显示器继续处理，
        // 调用方（display watcher）仍会广播 screens-updated，失败屏在下次事件重试。
        console.error(
          `[overlay] failed to create overlay window for display ${display.id}; skipping`,
          error
        )
        // 清掉可能残留的已销毁旧条目，避免后续 isDestroyed 分支反复命中。
        const stale = entries.get(display.id)
        if (stale && stale.win.isDestroyed()) entries.delete(display.id)
      }
    }

    // 移除已消失显示器的窗口：**先建新窗再关旧窗**，避免出现 0 窗口的瞬时窗口期
    // （macOS 上 window-all-closed 可能因此提前退出 app，PLAN §17.5 P1-10 LOW-13）
    const nextDisplayIdSet = new Set(nextDisplayIds)
    for (const [displayId, entry] of [...entries]) {
      if (nextDisplayIdSet.has(displayId)) continue
      entries.delete(displayId)
      closeWindow(entry.win)
    }

    // 主屏变化（或主屏被移除）→ 重算 primary
    const primaryLayout = layouts.find((layout) => layout.isPrimary)
    primaryDisplayId = primaryLayout ? primaryLayout.displayId : (layouts[0]?.displayId ?? null)

    registerWithContext()
  }

  function setVisible(nextVisible: boolean): void {
    // A1-F7：destroy 后不得再改写 visible 状态（isVisible 应与「无存活窗口」一致）。
    if (destroyed) return
    visible = nextVisible === true
    for (const entry of aliveEntries()) {
      if (visible) {
        // R-15：显示前先关掉背景节流（showInactive 之前），否则恢复显示后仍被 Chromium 降频。
        applyBackgroundThrottling(entry.win, true)
        // 未加载完成的窗口等 did-finish-load 再显示，避免闪出未渲染的透明空窗
        if (loadedWindows.has(entry.win)) showInactiveIfNeeded(entry.win)
      } else {
        // R-15：隐藏前打开背景节流（先改 webContents 再 hide，避免隐藏瞬间仍在全速渲染）。
        applyBackgroundThrottling(entry.win, false)
        entry.win.hide()
      }
    }
  }

  function startDisplayWatchers(): void {
    if (watchersAttached || destroyed) return
    watchersAttached = true

    const onDisplayChanged = (): void => {
      if (destroyed) return
      if (displayChangeTimer) clearTimeout(displayChangeTimer)
      displayChangeTimer = setTimeout(() => {
        displayChangeTimer = null
        if (destroyed) return
        try {
          // 同一份快照同时用于重建与广播，保证 renderer 与主进程几何一致
          const displays = deps.getDisplays()
          // sync 内部已做显示器级隔离；这里再兜底广播 / 快照异常。
          sync(displays)
          deps.ctx.broadcast(IPC_EVENTS.screensUpdated, displays)
        } catch (error) {
          console.error('[overlay] display change handler failed:', error)
        }
      }, DISPLAY_CHANGE_DEBOUNCE_MS)
    }

    screen.on('display-added', onDisplayChanged)
    screen.on('display-removed', onDisplayChanged)
    screen.on('display-metrics-changed', onDisplayChanged)

    detachDisplayWatchers = (): void => {
      screen.removeListener('display-added', onDisplayChanged)
      screen.removeListener('display-removed', onDisplayChanged)
      screen.removeListener('display-metrics-changed', onDisplayChanged)
      if (displayChangeTimer) {
        clearTimeout(displayChangeTimer)
        displayChangeTimer = null
      }
    }

    // app 退出兜底：即使 index.ts 没显式 destroy，也清理监听 / 定时器（幂等）
    app.once('will-quit', onWillQuit)
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    visible = false

    app.removeListener('will-quit', onWillQuit)
    if (detachDisplayWatchers) {
      detachDisplayWatchers()
      detachDisplayWatchers = null
    }
    if (displayChangeTimer) {
      clearTimeout(displayChangeTimer)
      displayChangeTimer = null
    }

    const wins = aliveEntries().map((entry) => entry.win)
    entries.clear()
    primaryDisplayId = null
    for (const win of wins) closeWindow(win)

    deps.ctx.setOverlayWindows([])
    deps.ctx.setPrimaryOverlay(null)

    if (activeManager === manager) activeManager = null
  }

  const manager: OverlayWindowsManager = {
    sync,
    startDisplayWatchers,
    getWindows: () => aliveEntries().map((entry) => entry.win),
    getWindowForDisplay(displayId: number): BrowserWindow | null {
      const entry = entries.get(displayId)
      return entry && !entry.win.isDestroyed() ? entry.win : null
    },
    getPrimaryWindow,
    setVisible,
    isVisible: () => visible,
    destroy
  }

  activeManager = manager
  return manager
}
