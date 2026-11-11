/**
 * 单测：M-2 设置窗收不到 `config-changed` 的修复。
 *
 * 修复前：`AppContext.broadcast()` 只遍历 overlay 注册表，设置窗从未登记为广播目标，
 * 设置页 `src/renderer/src/settings/main.ts` 的 `onConfigChanged` 订阅是死代码。
 *
 * 覆盖：
 * - `createAppContext()` 的广播目标注册表（overlay + 额外窗口、去重、销毁跳过、注销幂等）；
 * - 真实 `openSettingsWindow(ctx)` → 设置窗登记 → `config-changed` 到达设置窗；
 * - 关闭设置窗（用户关闭 / destroySettingsWindow）→ 注销，不再收到广播；
 * - 未注入 ctx 的旧调用保持兼容（不登记、不崩溃）。
 *
 * 用共享 electron-stub 跑真实实现，不启动 Electron；不写磁盘（userData 不在本文件使用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)
// settings-window 只读 `is.dev`；真实包会 require electron，故用最小 stub（测试不需要 dev URL）。
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false, mac: process.platform === 'darwin' } }))

import { IPC_EVENTS } from '@shared/ipc'
import type { PetConfig } from '@shared/types'

import { createAppContext } from '../src/main/app-context'
import {
  destroySettingsWindow,
  getSettingsWindow,
  openSettingsWindow
} from '../src/main/windows/settings-window'
import { FakeBrowserWindow, resetElectronStub } from './helpers/electron-stub'

/** 造一份配置广播 payload（只关心对象同一性/字段，不关心全部键）。 */
function nextConfig(partial: Partial<PetConfig> = {}): PetConfig {
  return { autonomous: false, ...partial } as PetConfig
}

/**
 * 打开设置窗并补齐 electron-stub 未实现的最小化 API（真实实现会调用 isMinimized/restore）。
 * 只在本测试文件内给实例打补丁，不改共享 stub。
 */
function openAndPatch(
  ctx?: Parameters<typeof openSettingsWindow>[0]
): FakeBrowserWindow {
  const win = openSettingsWindow(ctx) as FakeBrowserWindow
  Object.assign(win, { isMinimized: (): boolean => false, restore: (): void => undefined })
  return win
}

/** 取窗口收到的指定 channel 广播。 */
function sentOn(
  win: FakeBrowserWindow,
  channel: string
): Array<{ channel: string; payload: unknown }> {
  return win.webContents.sent.filter((entry) => entry.channel === channel)
}

beforeEach(() => {
  resetElectronStub()
  delete process.env['ELECTRON_RENDERER_URL']
})

afterEach(() => {
  // 设置窗单例在模块级；销毁以隔离用例（也覆盖 closed → 注销路径）。
  destroySettingsWindow()
})

describe('AppContext 广播注册表（M-2 纯逻辑）', () => {
  it('broadcast 覆盖 overlay + 额外目标；注销后不再发送', () => {
    const ctx = createAppContext()
    const overlay = new FakeBrowserWindow()
    const settings = new FakeBrowserWindow()
    ctx.setOverlayWindows([overlay])
    ctx.registerBroadcastTarget?.(settings)

    expect(ctx.getBroadcastTargets?.()).toEqual([overlay, settings])

    const payload = nextConfig()
    ctx.broadcast(IPC_EVENTS.configChanged, payload)
    expect(sentOn(overlay, IPC_EVENTS.configChanged)).toEqual([
      { channel: IPC_EVENTS.configChanged, payload }
    ])
    expect(sentOn(settings, IPC_EVENTS.configChanged)).toEqual([
      { channel: IPC_EVENTS.configChanged, payload }
    ])

    ctx.unregisterBroadcastTarget?.(settings)
    ctx.broadcast(IPC_EVENTS.configChanged, nextConfig({ autonomous: true }))
    expect(sentOn(settings, IPC_EVENTS.configChanged)).toHaveLength(1) // 已注销
    expect(sentOn(overlay, IPC_EVENTS.configChanged)).toHaveLength(2)
  })

  it('重复登记/注销幂等；已销毁窗口不进入广播目标', () => {
    const ctx = createAppContext()
    const overlay = new FakeBrowserWindow()
    const aux = new FakeBrowserWindow()
    ctx.setOverlayWindows([overlay])
    ctx.registerBroadcastTarget?.(aux)
    ctx.registerBroadcastTarget?.(aux)
    ctx.registerBroadcastTarget?.(null)
    expect(ctx.getBroadcastTargets?.()).toEqual([overlay, aux])

    ctx.unregisterBroadcastTarget?.(null) // no-op
    aux.destroy()
    expect(ctx.getBroadcastTargets?.()).toEqual([overlay])
    ctx.broadcast(IPC_EVENTS.configChanged, nextConfig())
    expect(sentOn(aux, IPC_EVENTS.configChanged)).toHaveLength(0) // 销毁后跳过
    ctx.unregisterBroadcastTarget?.(aux) // 幂等
    expect(ctx.getBroadcastTargets?.()).toEqual([overlay])
  })

  it('同一窗口同时登记为 overlay 与额外目标时只广播一次（去重）', () => {
    const ctx = createAppContext()
    const win = new FakeBrowserWindow()
    ctx.setOverlayWindows([win])
    ctx.registerBroadcastTarget?.(win)
    ctx.broadcast(IPC_EVENTS.configChanged, nextConfig())
    expect(sentOn(win, IPC_EVENTS.configChanged)).toHaveLength(1)
  })
})

describe('设置窗登记为广播目标（M-2 端到端）', () => {
  it('openSettingsWindow(ctx) 后 config-changed 同时到达 overlay 与设置窗', () => {
    const ctx = createAppContext()
    const overlay = new FakeBrowserWindow()
    ctx.setOverlayWindows([overlay])

    const settingsWin = openAndPatch(ctx)
    expect(getSettingsWindow()).toBe(settingsWin)
    expect(ctx.getBroadcastTargets?.()).toContain(settingsWin)

    const payload = nextConfig({ autonomous: false, dshLink: false } as Partial<PetConfig>)
    ctx.broadcast(IPC_EVENTS.configChanged, payload)

    expect(sentOn(overlay, IPC_EVENTS.configChanged)).toHaveLength(1)
    // 修复点：设置页的 onConfigChanged 不再收不到（修复前这里恒为 0）
    expect(sentOn(settingsWin as FakeBrowserWindow, IPC_EVENTS.configChanged)).toEqual([
      { channel: IPC_EVENTS.configChanged, payload }
    ])
  })

  it('设置窗被用户关闭（closed）→ 自动注销，后续广播不再发送', () => {
    const ctx = createAppContext()
    const overlay = new FakeBrowserWindow()
    ctx.setOverlayWindows([overlay])
    const settingsWin = openAndPatch(ctx)

    settingsWin.destroy() // 模拟用户关窗（触发 closed）
    expect(getSettingsWindow()).toBeNull()
    expect(ctx.getBroadcastTargets?.()).toEqual([overlay])

    ctx.broadcast(IPC_EVENTS.configChanged, nextConfig())
    expect(sentOn(settingsWin, IPC_EVENTS.configChanged)).toHaveLength(0)
    expect(sentOn(overlay, IPC_EVENTS.configChanged)).toHaveLength(1)
  })

  it('destroySettingsWindow() → 注销且幂等', () => {
    const ctx = createAppContext()
    const settingsWin = openAndPatch(ctx)
    destroySettingsWindow()
    destroySettingsWindow() // 幂等
    expect(getSettingsWindow()).toBeNull()
    expect(ctx.getBroadcastTargets?.()).not.toContain(settingsWin)
  })

  it('未注入 ctx 的旧调用保持兼容（不登记、不崩溃）', () => {
    const ctx = createAppContext()
    const win = openAndPatch()
    expect(ctx.getBroadcastTargets?.()).toEqual([])
    expect(win.isDestroyed()).toBe(false)
    destroySettingsWindow()
  })

  it('复用已有设置窗时补登记（先无 ctx 创建、后带 ctx 打开）', () => {
    const ctx = createAppContext()
    const settingsWin = openAndPatch()
    expect(ctx.getBroadcastTargets?.()).toEqual([])

    const reopened = openAndPatch(ctx)
    expect(reopened).toBe(settingsWin)
    expect(ctx.getBroadcastTargets?.()).toContain(settingsWin)

    ctx.broadcast(IPC_EVENTS.configChanged, nextConfig())
    expect(sentOn(settingsWin as FakeBrowserWindow, IPC_EVENTS.configChanged)).toHaveLength(1)
    destroySettingsWindow()
  })
})
