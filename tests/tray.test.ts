/**
 * 单测：菜单栏托盘（`src/main/tray.ts`，Wave 1 M-5）。
 *
 * 通过 `vi.mock('electron')` + 共享 stub 直接跑真实实现：
 * - template image 路径 / `setTemplateImage(true)`（macOS）；
 * - 菜单结构（显示桌宠 checkbox / 设置… disabled / 分隔 / 退出）；
 * - toggle / quit 回调、点击后勾选态重建、`syncVisibility`、`destroy` 幂等；
 * - 图标缺失只 warn 不抛（`new Tray` 仍创建，便于 C4 打包路径排障）。
 */
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)

import {
  createTray,
  getActiveTray,
  syncActiveTrayVisibility
} from '../src/main/tray'
import type { TrayDeps, TrayHandle } from '../src/main/tray'
import { createAppContextStub } from './helpers/app-context-stub'
import {
  electronStub,
  resetElectronStub,
  type FakeMenu,
  type FakeTray
} from './helpers/electron-stub'

/** 取真实 Tray 句柄背后的 FakeTray。 */
function fakeTray(handle: TrayHandle): FakeTray {
  return handle.tray as unknown as FakeTray
}

/** 取当前 context menu 的 template。 */
function menuTemplate(handle: TrayHandle): Array<Record<string, unknown>> {
  const menu = fakeTray(handle).menu as unknown as FakeMenu | null
  if (!menu) throw new Error('tray context menu has not been set')
  return menu.template
}

/** 点击菜单项（模板里 click 是普通函数）。 */
function clickMenu(handle: TrayHandle, index: number): void {
  const entry = menuTemplate(handle)[index]
  const click = entry?.['click']
  if (typeof click !== 'function') throw new Error(`menu item #${index} has no click handler`)
  ;(click as () => void)()
}

interface TrayHarness {
  handle: TrayHandle
  visible: () => boolean
  setVisible: (next: boolean) => void
  onToggleVisible: ReturnType<typeof vi.fn>
  onQuit: ReturnType<typeof vi.fn>
  onShowSettings: ReturnType<typeof vi.fn> | null
}

/** 创建 tray + 可变显隐状态。 */
function createHarness(options: { visible?: boolean; withSettings?: boolean } = {}): TrayHarness {
  let visible = options.visible !== false
  const onToggleVisible = vi.fn((): void => {
    visible = !visible
  })
  const onQuit = vi.fn()
  const onShowSettings = options.withSettings ? vi.fn() : null
  const deps: TrayDeps = {
    ctx: createAppContextStub(),
    isVisible: (): boolean => visible,
    onToggleVisible,
    onQuit,
    ...(onShowSettings ? { onShowSettings } : {})
  }
  const handle = createTray(deps)
  return {
    handle,
    visible: (): boolean => visible,
    setVisible: (next: boolean): void => {
      visible = next
    },
    onToggleVisible,
    onQuit,
    onShowSettings
  }
}

beforeEach(() => {
  resetElectronStub()
})

afterEach(() => {
  getActiveTray()?.destroy()
  vi.restoreAllMocks()
})

describe('tray：图标加载', () => {
  it('dev 路径读取 assets/icons/trayTemplate.png，macOS 标记 template image + tooltip', () => {
    const harness = createHarness()
    const expectedPath = join(electronStub.app.getAppPath(), 'assets', 'icons', 'trayTemplate.png')

    expect(electronStub.nativeImage.createdPaths).toEqual([expectedPath])
    expect(fakeTray(harness.handle).toolTip).toBe('砂金·戏浪')

    const image = electronStub.nativeImage.images[0]
    expect(image?.isEmpty()).toBe(false)
    if (process.platform === 'darwin') {
      expect(image?.setTemplateImageCalls).toEqual([true])
      expect(image?.isTemplateImage()).toBe(true)
    } else {
      expect(image?.setTemplateImageCalls).toEqual([])
    }
  })

  it('图标缺失 / 空图：只 warn 不抛，tray 仍创建（C4 打包路径排障）', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const iconPath = join(electronStub.app.getAppPath(), 'assets', 'icons', 'trayTemplate.png')
    electronStub.nativeImage.emptyPaths.add(iconPath)

    const harness = createHarness()

    expect(consoleWarn).toHaveBeenCalledWith(
      '[tray] failed to load tray icon (empty nativeImage):',
      iconPath
    )
    expect(fakeTray(harness.handle).destroyed).toBe(false)
    expect(electronStub.Tray.instances).toHaveLength(1)
    expect(electronStub.nativeImage.images[0]?.setTemplateImageCalls).toEqual([])
  })
})

describe('tray：菜单结构与勾选', () => {
  it('菜单恰为「显示桌宠 checkbox / 设置… disabled / 分隔 / 退出」（未注入 onShowSettings）', () => {
    const harness = createHarness({ visible: true })
    const template = menuTemplate(harness.handle)

    expect(template).toHaveLength(4)
    expect(template[0]).toMatchObject({ label: '显示桌宠', type: 'checkbox', checked: true })
    expect(template[1]).toMatchObject({ label: '设置…', enabled: false })
    expect(template[2]).toMatchObject({ type: 'separator' })
    expect(template[3]).toMatchObject({ label: '退出' })
    expect(typeof template[0]?.['click']).toBe('function')
    expect(typeof template[3]?.['click']).toBe('function')
  })

  it('Wave 2：注入 onShowSettings 后「设置…」启用，点击触发回调', () => {
    const harness = createHarness({ visible: true, withSettings: true })
    const template = menuTemplate(harness.handle)

    expect(template[1]).toMatchObject({ label: '设置…', enabled: true })
    clickMenu(harness.handle, 1)
    expect(harness.onShowSettings).toHaveBeenCalledTimes(1)
  })

  it('初始隐藏态：checkbox 未勾选', () => {
    const harness = createHarness({ visible: false })
    expect(menuTemplate(harness.handle)[0]).toMatchObject({ checked: false })
  })

  it('点击「显示桌宠」触发 onToggleVisible，并按实际状态重建勾选', () => {
    const harness = createHarness({ visible: true })
    const menuSetBefore = fakeTray(harness.handle).menuSetCalls.length

    clickMenu(harness.handle, 0)

    expect(harness.onToggleVisible).toHaveBeenCalledTimes(1)
    expect(harness.visible()).toBe(false)
    expect(fakeTray(harness.handle).menuSetCalls.length).toBe(menuSetBefore + 1)
    expect(menuTemplate(harness.handle)[0]).toMatchObject({ checked: false })
  })

  it('点击「退出」触发 onQuit', () => {
    const harness = createHarness()
    clickMenu(harness.handle, 3)
    expect(harness.onQuit).toHaveBeenCalledTimes(1)
  })

  it('外部 syncVisibility：按 deps.isVisible() 重建勾选态', () => {
    const harness = createHarness({ visible: true })
    const menuSetBefore = fakeTray(harness.handle).menuSetCalls.length

    harness.setVisible(false)
    harness.handle.syncVisibility()
    expect(fakeTray(harness.handle).menuSetCalls.length).toBe(menuSetBefore + 1)
    expect(menuTemplate(harness.handle)[0]).toMatchObject({ checked: false })

    harness.setVisible(true)
    syncActiveTrayVisibility()
    expect(menuTemplate(harness.handle)[0]).toMatchObject({ checked: true })
  })
})

describe('tray：生命周期', () => {
  it('getActiveTray / syncActiveTrayVisibility 指向当前活跃托盘', () => {
    const harness = createHarness()
    expect(getActiveTray()).toBe(harness.handle.tray)
  })

  it('destroy：销毁 tray、清空 active 引用、幂等，destroy 后 syncVisibility 不再重建菜单', () => {
    const harness = createHarness()
    const fake = fakeTray(harness.handle)
    const menuSetBefore = fake.menuSetCalls.length

    harness.handle.destroy()
    expect(fake.destroyed).toBe(true)
    expect(fake.destroyCalls).toBe(1)
    expect(getActiveTray()).toBeNull()

    harness.handle.syncVisibility()
    expect(fake.menuSetCalls.length).toBe(menuSetBefore)
    expect(() => harness.handle.destroy()).not.toThrow()
    expect(fake.destroyCalls).toBe(1)

    // 无活跃托盘时外部同步是 no-op
    expect(() => syncActiveTrayVisibility()).not.toThrow()
  })
})
