/**
 * 单测：多屏 overlay 窗口管理器（`src/main/windows/overlay-manager.ts`，Wave 1 M-5）。
 *
 * 通过 `vi.mock('electron')` 注入 `tests/helpers/electron-stub.ts`，直接跑真实实现
 * （不启动 Electron），覆盖 A1 验收核心路径：
 * - 每 display 一窗 / frame = workArea（含负坐标）/ focusable:false / 仅 showInactive；
 * - alwaysOnTop(screen-saver) / visibleOnAllWorkspaces / 初始 ignoreMouse(true,{forward})；
 * - did-finish-load 后才显示、重复 load 幂等；
 * - workArea 变化只 setBounds 不重建；显示器移除只关该屏；主屏 fallback；
 * - display-* debounce 200ms 合并、只广播一次、payload 与 sync 同一快照；
 * - destroy 清理监听 / 定时器 / 窗口，setVisible 在 destroy 后不改状态（A1-F7）；
 * - 单显示器建窗失败被隔离，其余屏照常创建且 screens-updated 仍广播（M-5）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DisplayInfo, Rect } from '@shared/types'

vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)

import {
  createOverlayWindowsManager,
  DISPLAY_CHANGE_DEBOUNCE_MS,
  getOverlayConstructOnlySnapshot,
  OVERLAY_WINDOW_CONSTRUCT
} from '../src/main/windows/overlay-manager'
import { createAppContextStub } from './helpers/app-context-stub'
import type { AppContextStub } from './helpers/app-context-stub'
import {
  electronStub,
  resetElectronStub,
  type FakeBrowserWindow
} from './helpers/electron-stub'

/* --------------------------------- 测试夹具 --------------------------------- */

/** 构造矩形。 */
function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

/** 构造 DisplayInfo（bounds 缺省由 workArea 推导，含菜单栏 30px 的典型值）。 */
function makeDisplay(
  id: number,
  workArea: Rect,
  options: { primary?: boolean; bounds?: Rect; scaleFactor?: number } = {}
): DisplayInfo {
  return {
    id,
    bounds: options.bounds ?? rect(workArea.x, 0, workArea.width, workArea.height + 30),
    workArea: { ...workArea },
    scaleFactor: options.scaleFactor ?? 1,
    isPrimary: options.primary === true
  }
}

interface OverlayHarness {
  manager: ReturnType<typeof createOverlayWindowsManager>
  ctx: AppContextStub
  /** 当前显示器快照（`getDisplays` 返回它；测试可直接改）。 */
  displays: DisplayInfo[]
  getDisplaysCalls: number
  /** 非 null 时 `getDisplays` 抛出该错误（验证 debounce 回调 try/catch）。 */
  getDisplaysError: Error | null
  loadContents: ReturnType<typeof vi.fn>
  hardenWebContents: ReturnType<typeof vi.fn>
  onWindowCreated: ReturnType<typeof vi.fn>
  onDidFinishLoad: ReturnType<typeof vi.fn>
}

/** 创建 manager + ctx + deps（getDisplays 返回可变快照）。 */
function createHarness(initialDisplays: DisplayInfo[]): OverlayHarness {
  const ctx = createAppContextStub()
  const state: OverlayHarness = {
    manager: null as unknown as OverlayHarness['manager'],
    ctx,
    displays: initialDisplays,
    getDisplaysCalls: 0,
    getDisplaysError: null,
    loadContents: vi.fn(),
    hardenWebContents: vi.fn(),
    onWindowCreated: vi.fn(),
    onDidFinishLoad: vi.fn()
  }
  state.manager = createOverlayWindowsManager({
    ctx,
    getDisplays: (): DisplayInfo[] => {
      state.getDisplaysCalls += 1
      if (state.getDisplaysError) throw state.getDisplaysError
      return state.displays
    },
    loadContents: state.loadContents,
    hardenWebContents: state.hardenWebContents,
    onWindowCreated: state.onWindowCreated,
    onDidFinishLoad: state.onDidFinishLoad
  })
  return state
}

/** 当前 stub 创建的窗口（按创建顺序）。 */
function createdWindows(): FakeBrowserWindow[] {
  return electronStub.BrowserWindow.instances
}

beforeEach(() => {
  resetElectronStub()
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* ------------------------------- 构造与几何 ------------------------------- */

describe('overlay manager：每 display 一窗 / frame = workArea', () => {
  const primary = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
  const secondary = makeDisplay(2, rect(-2560, 24, 2560, 1376), {
    bounds: rect(-2560, 0, 2560, 1440)
  })

  it('2 屏 → 2 窗，构造选项 / 置顶 / 工作区 / 初始穿透全部符合 A1 契约', () => {
    const harness = createHarness([primary, secondary])
    harness.manager.sync(harness.displays)

    expect(harness.manager.getWindows()).toHaveLength(2)
    expect(createdWindows()).toHaveLength(2)
    expect(harness.loadContents).toHaveBeenCalledTimes(2)
    expect(harness.hardenWebContents).toHaveBeenCalledTimes(2)
    expect(harness.onWindowCreated).toHaveBeenCalledTimes(2)

    const [first, second] = createdWindows()
    expect(first?.options).toMatchObject({
      x: 0,
      y: 30,
      width: 1920,
      height: 961,
      transparent: true,
      frame: false,
      focusable: false,
      acceptFirstMouse: true,
      hasShadow: false,
      show: false
    })
    // 负坐标显示器：frame 直接用该屏 workArea 的全局坐标
    expect(second?.options).toMatchObject({ x: -2560, y: 24, width: 2560, height: 1376 })
    expect(first?.options['webPreferences']).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    })

    for (const win of createdWindows()) {
      expect(win.alwaysOnTopCalls[0]).toEqual({ flag: true, level: 'screen-saver' })
      expect(win.visibleOnAllWorkspacesCalls[0]).toEqual({
        flag: true,
        options: { visibleOnFullScreen: true }
      })
      // 初始整体穿透：true + forward（mousemove 仍投递给 renderer 做命中检测）
      expect(win.ignoreMouseCalls).toEqual([{ ignore: true, options: { forward: true } }])
      // 禁止 show()/focus()；did-finish-load 前也不显示
      expect(win.showCalls).toBe(0)
      expect(win.focusCalls).toBe(0)
      expect(win.showInactiveCalls).toBe(0)
    }

    // ctx 登记（窗口列表 + 主屏）
    expect(harness.ctx.overlayWindows).toEqual(harness.manager.getWindows())
    expect(harness.ctx.primaryOverlay).toBe(harness.manager.getPrimaryWindow())
  })

  it('重复 sync 同一快照：不重建、不重复 load', () => {
    const harness = createHarness([primary, secondary])
    harness.manager.sync(harness.displays)
    const windowsBefore = [...harness.manager.getWindows()]

    harness.manager.sync(harness.displays)

    expect(harness.manager.getWindows()).toEqual(windowsBefore)
    expect(createdWindows()).toHaveLength(2)
    expect(harness.loadContents).toHaveBeenCalledTimes(2)
  })
})

describe('overlay manager：did-finish-load 后显示（只 showInactive）', () => {
  it('加载完成前不显示；did-finish-load 后 showInactive 一次并回调 onDidFinishLoad', () => {
    const display = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
    const harness = createHarness([display])
    harness.manager.sync(harness.displays)

    const [win] = createdWindows()
    expect(win).toBeDefined()
    expect(win.showInactiveCalls).toBe(0)

    win!.webContents.emit('did-finish-load')
    expect(win!.showInactiveCalls).toBe(1)
    expect(win!.showCalls).toBe(0)
    expect(win!.focusCalls).toBe(0)
    expect(harness.onDidFinishLoad).toHaveBeenCalledWith(win, display)

    // 重复 did-finish-load 幂等（页面 reload 不应重复 showInactive）
    win!.webContents.emit('did-finish-load')
    expect(win!.showInactiveCalls).toBe(1)
  })

  it('隐藏后 setVisible(true) 只对已加载窗口 showInactive；setVisible(false) 调 hide', () => {
    const display = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
    const harness = createHarness([display])
    harness.manager.sync(harness.displays)
    const [win] = createdWindows()

    // 未加载时显示意图 true 也不会 show
    harness.manager.setVisible(true)
    expect(win!.showInactiveCalls).toBe(0)

    win!.webContents.emit('did-finish-load')
    expect(win!.showInactiveCalls).toBe(1)

    harness.manager.setVisible(false)
    expect(harness.manager.isVisible()).toBe(false)
    expect(win!.hideCalls).toBe(1)

    harness.manager.setVisible(true)
    expect(harness.manager.isVisible()).toBe(true)
    expect(win!.showInactiveCalls).toBe(2)
    expect(win!.showCalls).toBe(0)
    expect(win!.focusCalls).toBe(0)

    harness.manager.destroy()
    // A1-F7：destroy 后 setVisible 不得再改写 visible
    harness.manager.setVisible(true)
    expect(harness.manager.isVisible()).toBe(false)
  })

  it('R-15：隐藏前 setBackgroundThrottling(true)，恢复显示时在 show 前置回 false', () => {
    const display = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
    const harness = createHarness([display])
    harness.manager.sync(harness.displays)
    const [win] = createdWindows()
    expect(win).toBeDefined()

    win!.webContents.emit('did-finish-load')
    expect(win!.showInactiveCalls).toBe(1)

    harness.manager.setVisible(false)
    // 隐藏：先切背景节流再 hide（stub 只记录参数，顺序由实现保证）。
    expect(win!.webContents.backgroundThrottlingCalls).toEqual([true])
    expect(win!.hideCalls).toBe(1)

    harness.manager.setVisible(true)
    expect(win!.webContents.backgroundThrottlingCalls).toEqual([true, false])
    expect(win!.isVisible()).toBe(true)
    expect(win!.showInactiveCalls).toBe(2)
    expect(win!.showCalls).toBe(0)
  })

  it('R-15：隐藏期间新建并加载完成的窗口保持节流，恢复显示时才解除', () => {
    const display = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
    const harness = createHarness([display])

    // 托盘先隐藏（此时还没有窗口），随后显示器热插拔创建窗口。
    harness.manager.setVisible(false)
    harness.manager.sync(harness.displays)
    const [win] = createdWindows()
    expect(win).toBeDefined()

    win!.webContents.emit('did-finish-load')
    expect(win!.webContents.backgroundThrottlingCalls).toEqual([true])
    expect(win!.showInactiveCalls).toBe(0)
    expect(win!.isVisible()).toBe(false)

    harness.manager.setVisible(true)
    expect(win!.webContents.backgroundThrottlingCalls).toEqual([true, false])
    expect(win!.showInactiveCalls).toBe(1)
  })
})

/* ------------------------------- 几何同步 / 移除 ------------------------------- */

describe('overlay manager：workArea 变化 / 显示器移除 / 主屏 fallback', () => {
  const primary = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
  const secondary = makeDisplay(2, rect(-2560, 24, 2560, 1376), {
    bounds: rect(-2560, 0, 2560, 1440)
  })

  it('同 id 的 workArea 变化只 setBounds，不重建窗口', () => {
    const harness = createHarness([primary, secondary])
    harness.manager.sync(harness.displays)
    const [win1] = createdWindows()

    const nextPrimary = makeDisplay(1, rect(0, 0, 1920, 991), { primary: true })
    harness.manager.sync([nextPrimary, secondary])

    expect(harness.manager.getWindows()).toHaveLength(2)
    expect(createdWindows()).toHaveLength(2)
    expect(harness.manager.getWindowForDisplay(1)).toBe(win1)
    expect(win1!.setBoundsCalls).toEqual([rect(0, 0, 1920, 991)])
    expect(win1!.getBounds()).toEqual(rect(0, 0, 1920, 991))
  })

  it('显示器移除只关闭该屏窗口，其余窗口保留并更新 ctx', () => {
    const harness = createHarness([primary, secondary])
    harness.manager.sync(harness.displays)
    const [win1, win2] = createdWindows()

    harness.manager.sync([primary])

    expect(harness.manager.getWindows()).toEqual([win1])
    expect(harness.manager.getWindowForDisplay(2)).toBeNull()
    expect(win1!.isDestroyed()).toBe(false)
    expect(win2!.isDestroyed()).toBe(true)
    expect(harness.ctx.overlayWindows).toEqual([win1])
  })

  it('外部意外关闭窗口后：ctx 立即重登记，下一次 sync 重建该屏', () => {
    const harness = createHarness([primary, secondary])
    harness.manager.sync(harness.displays)
    const [win1] = createdWindows()

    win1!.destroy()
    expect(harness.ctx.overlayWindows).toEqual([createdWindows()[1]])
    expect(harness.manager.getWindowForDisplay(1)).toBeNull()

    harness.manager.sync(harness.displays)
    expect(harness.manager.getWindowForDisplay(1)).not.toBeNull()
    expect(createdWindows()).toHaveLength(3)
  })

  it('主屏标记变化 / 主屏移除 → getPrimaryWindow 跟随；无主屏标记时回退第一个', () => {
    const harness = createHarness([primary, secondary])
    harness.manager.sync(harness.displays)
    const [win1, win2] = createdWindows()
    expect(harness.manager.getPrimaryWindow()).toBe(win1)

    const primarySwitched = [makeDisplay(1, primary.workArea), makeDisplay(2, secondary.workArea, { primary: true })]
    harness.manager.sync(primarySwitched)
    expect(harness.manager.getPrimaryWindow()).toBe(win2)

    harness.manager.sync([makeDisplay(1, primary.workArea)])
    expect(harness.manager.getPrimaryWindow()).toBe(win1)
    expect(harness.ctx.primaryOverlay).toBe(win1)

    // 全部无主屏标记 → 回退布局中的第一个显示器
    const noPrimary = [makeDisplay(3, rect(0, 0, 800, 600)), makeDisplay(4, rect(800, 0, 800, 600))]
    const fallbackHarness = createHarness(noPrimary)
    fallbackHarness.manager.sync(noPrimary)
    const fallbackWindows = fallbackHarness.manager.getWindows()
    expect(fallbackHarness.manager.getPrimaryWindow()).toBe(fallbackWindows[0])
  })
})

/* ------------------------------- display 变化 debounce ------------------------------- */

describe('overlay manager：display-* watcher', () => {
  const d1 = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
  const d2 = makeDisplay(2, rect(-1280, 0, 1280, 800))
  const d3 = makeDisplay(3, rect(1920, 0, 1280, 800))

  it('200ms debounce 合并多次 display-added，只 sync 一次 + 广播一次', () => {
    vi.useFakeTimers()
    const harness = createHarness([d1, d2])
    harness.manager.sync(harness.displays)
    harness.manager.startDisplayWatchers()
    const getCallsBefore = harness.getDisplaysCalls

    harness.displays = [d1, d2, d3]
    electronStub.screen.emit('display-added')
    electronStub.screen.emit('display-added')
    electronStub.screen.emit('display-added')

    vi.advanceTimersByTime(DISPLAY_CHANGE_DEBOUNCE_MS - 1)
    expect(harness.manager.getWindows()).toHaveLength(2)
    expect(harness.ctx.broadcasts).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(harness.manager.getWindows()).toHaveLength(3)
    expect(harness.getDisplaysCalls).toBe(getCallsBefore + 1)
    expect(harness.ctx.broadcasts).toEqual([
      { channel: 'screens-updated', payload: [d1, d2, d3] }
    ])

    // 合并后不会再有第二次广播
    vi.advanceTimersByTime(1000)
    expect(harness.ctx.broadcasts).toHaveLength(1)
  })

  it('display-metrics-changed：workArea 变化只 setBounds，仍广播一次同一份快照', () => {
    vi.useFakeTimers()
    const harness = createHarness([d1, d2])
    harness.manager.sync(harness.displays)
    harness.manager.startDisplayWatchers()
    const [win1] = createdWindows()

    const moved = makeDisplay(1, rect(0, 0, 1920, 991), { primary: true })
    harness.displays = [moved, d2]
    electronStub.screen.emit('display-metrics-changed')
    vi.advanceTimersByTime(DISPLAY_CHANGE_DEBOUNCE_MS)

    expect(createdWindows()).toHaveLength(2)
    expect(harness.manager.getWindowForDisplay(1)).toBe(win1)
    expect(win1!.setBoundsCalls).toEqual([rect(0, 0, 1920, 991)])
    expect(harness.ctx.broadcasts).toEqual([
      { channel: 'screens-updated', payload: [moved, d2] }
    ])
  })

  it('单显示器建窗失败被隔离：其余屏照常创建，screens-updated 仍广播', () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = createHarness([d1, d2])
    harness.manager.sync(harness.displays)
    harness.manager.startDisplayWatchers()

    harness.displays = [d1, d2, d3]
    electronStub.failNextWindowCreation(new Error('simulated BrowserWindow failure'))
    electronStub.screen.emit('display-added')
    vi.advanceTimersByTime(DISPLAY_CHANGE_DEBOUNCE_MS)

    // 失败屏被跳过，d1/d2 窗口保留
    expect(harness.manager.getWindows()).toHaveLength(2)
    expect(harness.manager.getWindowForDisplay(3)).toBeNull()
    expect(harness.ctx.overlayWindows).toHaveLength(2)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('display 3'),
      expect.any(Error)
    )
    // 仍然广播（消费方拿到完整显示器快照，失败屏下次事件重试）
    expect(harness.ctx.broadcasts).toEqual([
      { channel: 'screens-updated', payload: [d1, d2, d3] }
    ])

    // 下一个事件重试：这次成功建窗
    electronStub.screen.emit('display-added')
    vi.advanceTimersByTime(DISPLAY_CHANGE_DEBOUNCE_MS)
    expect(harness.manager.getWindowForDisplay(3)).not.toBeNull()
    expect(harness.manager.getWindows()).toHaveLength(3)
  })

  it('首次 sync 时某屏建窗失败也不影响其余屏', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = createHarness([d1, d2])
    electronStub.failNextWindowCreation(new Error('boom'))
    // 第一个 display 失败 → 第二个仍应创建
    harness.manager.sync(harness.displays)

    expect(harness.manager.getWindows()).toHaveLength(1)
    expect(harness.manager.getWindowForDisplay(1)).toBeNull()
    expect(harness.manager.getWindowForDisplay(2)).not.toBeNull()
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('debounce 回调内 getDisplays 抛错：被 try/catch 捕获，不冒泡、不广播', () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = createHarness([d1])
    harness.manager.sync(harness.displays)
    harness.manager.startDisplayWatchers()

    harness.getDisplaysError = new Error('screen API failed')
    electronStub.screen.emit('display-added')

    expect(() => vi.advanceTimersByTime(DISPLAY_CHANGE_DEBOUNCE_MS)).not.toThrow()
    expect(harness.ctx.broadcasts).toHaveLength(0)
    expect(consoleError).toHaveBeenCalledWith(
      '[overlay] display change handler failed:',
      expect.any(Error)
    )
  })

  it('sync 内部异常（ctx / 布局）被 try/catch 兜住，不冒泡', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = createHarness([d1])
    harness.ctx.setOverlayWindows = (): void => {
      throw new Error('ctx registration failed')
    }
    expect(() => harness.manager.sync(harness.displays)).not.toThrow()
    expect(consoleError).toHaveBeenCalledWith(
      '[overlay] failed to sync overlay windows:',
      expect.any(Error)
    )
  })
})

/* ------------------------------- destroy / 幂等 ------------------------------- */

describe('overlay manager：destroy 清理', () => {
  const d1 = makeDisplay(1, rect(0, 30, 1920, 961), { primary: true })
  const d2 = makeDisplay(2, rect(-1280, 0, 1280, 800))

  it('销毁全部窗口、移除 screen / app 监听、清 pending timer；幂等', () => {
    vi.useFakeTimers()
    const harness = createHarness([d1, d2])
    harness.manager.sync(harness.displays)
    harness.manager.startDisplayWatchers()
    const [win1, win2] = createdWindows()

    expect(electronStub.screen.listenerCount('display-added')).toBe(1)
    expect(electronStub.screen.listenerCount('display-removed')).toBe(1)
    expect(electronStub.screen.listenerCount('display-metrics-changed')).toBe(1)
    expect(electronStub.app.listenerCount('will-quit')).toBe(1)

    // 制造一个 pending debounce，再 destroy：计时器到点不得广播
    harness.displays = [d1, d2, makeDisplay(3, rect(1920, 0, 1280, 800))]
    electronStub.screen.emit('display-added')

    harness.manager.destroy()
    expect(win1!.isDestroyed()).toBe(true)
    expect(win2!.isDestroyed()).toBe(true)
    expect(harness.manager.getWindows()).toEqual([])
    expect(harness.ctx.overlayWindows).toEqual([])
    expect(harness.ctx.primaryOverlay).toBeNull()
    expect(electronStub.screen.listenerCount('display-added')).toBe(0)
    expect(electronStub.screen.listenerCount('display-removed')).toBe(0)
    expect(electronStub.screen.listenerCount('display-metrics-changed')).toBe(0)
    expect(electronStub.app.listenerCount('will-quit')).toBe(0)

    vi.advanceTimersByTime(1000)
    expect(harness.ctx.broadcasts).toHaveLength(0)

    // 幂等 + destroy 后 sync no-op
    expect(() => harness.manager.destroy()).not.toThrow()
    harness.manager.sync([d1])
    expect(harness.manager.getWindows()).toEqual([])
  })
})

/* --------------------------- constructOnly 快照（M-6） --------------------------- */

describe('getOverlayConstructOnlySnapshot：构造期配置单源', () => {
  it('由 OVERLAY_WINDOW_CONSTRUCT 派生，返回新对象', () => {
    const snapshot = getOverlayConstructOnlySnapshot()
    expect(snapshot).toEqual({
      transparent: true,
      ignoreMouse: true,
      sandbox: true,
      backgroundThrottling: false,
      textureCrossOrigin: 'anonymous'
    })
    expect(OVERLAY_WINDOW_CONSTRUCT).toMatchObject(snapshot)

    // 返回副本：改动不会污染共享常量
    snapshot.transparent = false
    expect(getOverlayConstructOnlySnapshot().transparent).toBe(true)
  })
})
