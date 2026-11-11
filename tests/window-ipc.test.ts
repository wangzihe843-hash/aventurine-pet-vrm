/**
 * 单测：窗口 / 显示器 / 窗口动作 IPC（`src/main/ipc/window.ts`，Wave 1 M-5）。
 *
 * 通过 `vi.mock('electron')` + 共享 stub 直接注册真实 handler：
 * - 7 个 channel 恰好注册一次（重复注册与真实 Electron 一样抛错）；
 * - `pet:window-info` / `pet:screen-info` 的序列化结构与 sender 缺失降级；
 * - `pet:set-ignore-mouse` 延迟语义（false 立即 / true 延迟一帧 + forward）；
 * - `pet:set-visible` hide / showInactive（禁止 show/focus）+ 托盘勾选同步；
 * - `pet:quit` 下一 tick 才 app.quit；
 * - accessibility 状态映射 / 深链；
 * - A1-F6：窗口 closed 时 dispose mouse-gate；setVisible(false) 前 flush 排队状态；
 * - `getIgnoreMouseAppliedState()` 记录「实际已应用」状态（Lead 冒烟断言 hover 闭环用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC } from '@shared/ipc'
import type { DisplayInfo } from '@shared/types'

vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)

import {
  getDisplayInfos,
  getIgnoreMouseAppliedState,
  registerWindowIpc
} from '../src/main/ipc/window'
import { createTray, getActiveTray } from '../src/main/tray'
import { createOverlayWindowsManager, getActiveOverlayWindowsManager } from '../src/main/windows/overlay-manager'
import { createAppContextStub } from './helpers/app-context-stub'
import type { AppContextStub } from './helpers/app-context-stub'
import {
  electronStub,
  resetElectronStub,
  type FakeBrowserWindow,
  type FakeMenu
} from './helpers/electron-stub'

/** 构造矩形。 */
function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height }
}

/** 构造 DisplayInfo。 */
function makeDisplay(id: number, workArea: ReturnType<typeof rect>, primary = false): DisplayInfo {
  return {
    id,
    bounds: rect(workArea.x, 0, workArea.width, workArea.height + 30),
    workArea,
    scaleFactor: 1,
    isPrimary: primary
  }
}

/** 创建 fake 窗口并返回 stub 实例（webContents 已登记到 fromWebContents）。 */
function createWindow(options: Record<string, unknown> = {}): FakeBrowserWindow {
  return new electronStub.BrowserWindow(options) as FakeBrowserWindow
}

/** 构造 sender event（真实 handler 只读 `event.sender`）。 */
function eventFor(win: FakeBrowserWindow | null): { sender: unknown } {
  return { sender: win ? win.webContents : {} }
}

/** 取已注册 handler。 */
function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = electronStub.ipcMain.handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler
}

/** 读取当前托盘菜单模板。 */
function trayTemplate(): Array<Record<string, unknown>> {
  const tray = getActiveTray()
  if (!tray) throw new Error('tray not created')
  const fakeTray = tray as unknown as { menu: FakeMenu | null }
  if (!fakeTray.menu) throw new Error('tray menu not set')
  return fakeTray.menu.template
}

let ctx: AppContextStub

beforeEach(() => {
  getActiveOverlayWindowsManager()?.destroy()
  getActiveTray()?.destroy()
  resetElectronStub()
  ctx = createAppContextStub()
  vi.useFakeTimers()
})

afterEach(() => {
  getActiveOverlayWindowsManager()?.destroy()
  getActiveTray()?.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* ------------------------------- 注册与只读信息 ------------------------------- */

describe('registerWindowIpc：channel 注册', () => {
  it('A1 的 7 个 channel 恰好注册一次；重复注册抛错（与真实 Electron 一致）', () => {
    registerWindowIpc(ctx)

    const expected = [
      IPC.windowInfo,
      IPC.screenInfo,
      IPC.setIgnoreMouse,
      IPC.setVisible,
      IPC.quit,
      IPC.accessibilityStatus,
      IPC.openAccessibilitySettings
    ]
    expect([...electronStub.ipcMain.handlers.keys()].sort()).toEqual([...expected].sort())
    expect(electronStub.ipcMain.handlers.size).toBe(7)

    // 未越权注册其它领域的 channel
    for (const forbidden of [
      IPC.windows,
      IPC.moveWindow,
      IPC.notify,
      IPC.showSettings,
      IPC.dshStatus,
      IPC.getConfig,
      IPC.setConfig
    ]) {
      expect(electronStub.ipcMain.handlers.has(forbidden)).toBe(false)
    }

    expect(() => registerWindowIpc(ctx)).toThrow(/second handler/)
  })
})

describe('pet:window-info / pet:screen-info', () => {
  it('window-info 返回窗口 id / 拷贝的 bounds / 匹配显示器 id', async () => {
    const primary = makeDisplay(1, rect(0, 30, 1920, 961), true)
    electronStub.screen.setDisplays([primary])
    registerWindowIpc(ctx)

    const win = createWindow({ x: 0, y: 30, width: 1920, height: 961 })
    expect(win.id).toBeGreaterThan(0)

    const info = (await electronStub.ipcMain.invoke(IPC.windowInfo, eventFor(win))) as {
      id: number
      bounds: ReturnType<typeof rect>
      displayId: number
    }
    expect(info).toEqual({
      id: win.id,
      bounds: rect(0, 30, 1920, 961),
      displayId: 1
    })
    // 返回的是拷贝：renderer 改它不影响真实窗口
    info.bounds.x = 999
    expect(win.getBounds().x).toBe(0)
  })

  it('window-info / set-ignore-mouse：sender 没有 BrowserWindow 时抛错', async () => {
    registerWindowIpc(ctx)
    await expect(
      electronStub.ipcMain.invoke(IPC.windowInfo, eventFor(null))
    ).rejects.toThrow('sender has no BrowserWindow')
    await expect(
      electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(null), false)
    ).rejects.toThrow('sender has no BrowserWindow')
  })

  it('screen-info 返回全部显示器（bounds / workArea / scaleFactor / isPrimary）', async () => {
    const primary = makeDisplay(1, rect(0, 30, 1920, 961), true)
    const secondary = makeDisplay(2, rect(-1280, 0, 1280, 800))
    electronStub.screen.setDisplays([primary, secondary])
    registerWindowIpc(ctx)

    const info = (await electronStub.ipcMain.invoke(IPC.screenInfo, {})) as DisplayInfo[]
    expect(info).toEqual([
      {
        id: 1,
        bounds: rect(0, 0, 1920, 991),
        workArea: rect(0, 30, 1920, 961),
        scaleFactor: 1,
        isPrimary: true
      },
      {
        id: 2,
        bounds: rect(-1280, 0, 1280, 830),
        workArea: rect(-1280, 0, 1280, 800),
        scaleFactor: 1,
        isPrimary: false
      }
    ])
    expect(getDisplayInfos()).toEqual(info)
  })
})

/* ------------------------------- 穿透状态机 ------------------------------- */

describe('pet:set-ignore-mouse：延迟语义 + 实际应用状态', () => {
  it('false 立即拦截；true 延迟 16ms 且带 forward；记录实际应用状态', async () => {
    registerWindowIpc(ctx)
    const win = createWindow()
    expect(getIgnoreMouseAppliedState(win)).toBeNull()

    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), false)
    expect(win.ignoreMouseCalls).toEqual([{ ignore: false, options: undefined }])
    expect(getIgnoreMouseAppliedState(win)).toBe(false)

    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), true)
    // 拦截 → 穿透延迟一帧：15ms 前保持拦截
    expect(win.ignoreMouseCalls).toHaveLength(1)
    expect(getIgnoreMouseAppliedState(win)).toBe(false)

    vi.advanceTimersByTime(15)
    expect(win.ignoreMouseCalls).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(win.ignoreMouseCalls).toEqual([
      { ignore: false, options: undefined },
      { ignore: true, options: { forward: true } }
    ])
    expect(getIgnoreMouseAppliedState(win)).toBe(true)

    // 幂等：重复 true 不再 apply
    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), true)
    vi.advanceTimersByTime(16)
    expect(win.ignoreMouseCalls).toHaveLength(2)
  })

  it('A1-F6：窗口 closed 时 dispose gate 并清理应用状态，排队任务不再生效', async () => {
    registerWindowIpc(ctx)
    const win = createWindow()
    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), false)
    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), true)
    expect(win.ignoreMouseCalls).toHaveLength(1)

    win.destroy()
    expect(getIgnoreMouseAppliedState(win)).toBeNull()
    vi.advanceTimersByTime(16)
    expect(win.ignoreMouseCalls).toHaveLength(1)
  })
})

/* ------------------------------- 显隐 / 托盘 ------------------------------- */

describe('pet:set-visible：hide / showInactive + 托盘勾选', () => {
  it('manager 未初始化时降级到 ctx 窗口；只 hide / showInactive（禁止 show/focus）', async () => {
    registerWindowIpc(ctx)
    const win = createWindow()
    ctx.setOverlayWindows([win as never])

    await electronStub.ipcMain.invoke(IPC.setVisible, {}, false)
    expect(win.hideCalls).toBe(1)
    expect(win.showInactiveCalls).toBe(0)

    await electronStub.ipcMain.invoke(IPC.setVisible, {}, true)
    expect(win.showInactiveCalls).toBe(1)
    expect(win.showCalls).toBe(0)
    expect(win.focusCalls).toBe(0)
  })

  it('A1-F6：setVisible(false) 前 flush 排队中的穿透状态', async () => {
    registerWindowIpc(ctx)
    const win = createWindow()
    ctx.setOverlayWindows([win as never])

    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), false)
    await electronStub.ipcMain.invoke(IPC.setIgnoreMouse, eventFor(win), true)
    expect(win.ignoreMouseCalls).toHaveLength(1) // true 仍在排队

    await electronStub.ipcMain.invoke(IPC.setVisible, {}, false)
    // flush 在 hide 前落地 true；之后定时器到点不重复 apply
    expect(win.ignoreMouseCalls).toEqual([
      { ignore: false, options: undefined },
      { ignore: true, options: { forward: true } }
    ])
    expect(win.hideCalls).toBe(1)
    vi.advanceTimersByTime(16)
    expect(win.ignoreMouseCalls).toHaveLength(2)
  })

  it('manager 已初始化时走 manager.setVisible，并同步重建托盘勾选', async () => {
    const display = makeDisplay(1, rect(0, 30, 1920, 961), true)
    const manager = createOverlayWindowsManager({
      ctx,
      getDisplays: (): DisplayInfo[] => [display],
      loadContents: () => {},
      hardenWebContents: () => {}
    })
    manager.sync([display])
    const win = manager.getWindows()[0] as unknown as FakeBrowserWindow
    win.webContents.emit('did-finish-load')

    createTray({
      ctx,
      isVisible: (): boolean => manager.isVisible(),
      onToggleVisible: (): void => manager.setVisible(!manager.isVisible()),
      onQuit: () => {}
    })
    registerWindowIpc(ctx)

    await electronStub.ipcMain.invoke(IPC.setVisible, {}, false)
    expect(win.hideCalls).toBe(1)
    expect(trayTemplate()[0]).toMatchObject({ checked: false })

    await electronStub.ipcMain.invoke(IPC.setVisible, {}, true)
    expect(win.showInactiveCalls).toBe(2) // did-finish-load 1 次 + setVisible(true) 1 次
    expect(win.showCalls).toBe(0)
    expect(win.focusCalls).toBe(0)
    expect(trayTemplate()[0]).toMatchObject({ checked: true })
  })
})

/* ------------------------------- quit / accessibility ------------------------------- */

describe('pet:quit / accessibility', () => {
  it('quit 不在当前 tick 退出，下一 tick 才 app.quit（先让 invoke resolve）', () => {
    registerWindowIpc(ctx)
    const handler = handlerFor(IPC.quit)

    handler({})
    expect(electronStub.app.quitCalls).toBe(0)

    vi.runAllTimers()
    expect(electronStub.app.quitCalls).toBe(1)
  })

  it('accessibility-status 映射当前权限 / 通知支持状态（查询不弹系统提示）', async () => {
    registerWindowIpc(ctx)

    electronStub.systemPreferences.trusted = true
    electronStub.Notification.supported = true
    expect(await electronStub.ipcMain.invoke(IPC.accessibilityStatus, {})).toEqual({
      accessibility: true,
      notifications: 'unknown'
    })
    expect(electronStub.systemPreferences.trustQueries).toEqual([false])

    electronStub.systemPreferences.trusted = false
    electronStub.Notification.supported = false
    expect(await electronStub.ipcMain.invoke(IPC.accessibilityStatus, {})).toEqual({
      accessibility: false,
      notifications: 'unsupported'
    })
  })

  it('open-accessibility-settings 打开 macOS 辅助功能深链', async () => {
    registerWindowIpc(ctx)
    await electronStub.ipcMain.invoke(IPC.openAccessibilitySettings, {})
    expect(electronStub.shell.openExternalCalls).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    ])
  })
})
