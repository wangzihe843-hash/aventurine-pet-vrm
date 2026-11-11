/**
 * settings IPC registrar 单测（R-34）：`registerSettingsIpc` 的注册面与调用路径。
 *
 * - 内联 fake `ipcMain`，复刻 Electron「同一 channel 重复注册抛错」语义；
 * - `openSettingsWindow` 用文件内 `vi.mock` 替换（不依赖真实 BrowserWindow）；
 * - AppContext 复用只读 helper `tests/helpers/app-context-stub.ts`。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { IPC } from '@shared/ipc'

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle(channel: string, listener: (...args: unknown[]) => unknown): void {
      if (electronState.handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      electronState.handlers.set(channel, listener)
    }
  }
}))

vi.mock('../src/main/windows/settings-window', () => ({
  openSettingsWindow: vi.fn()
}))

import type { SettingsWindowLogger } from '../src/main/windows/settings-window'
import { openSettingsWindow } from '../src/main/windows/settings-window'
import { registerSettingsIpc } from '../src/main/ipc/settings'
import { createAppContextStub } from './helpers/app-context-stub'

beforeEach(() => {
  electronState.handlers.clear()
  vi.mocked(openSettingsWindow).mockClear()
})

describe('registerSettingsIpc', () => {
  it('只注册 pet:show-settings 一个 channel', () => {
    registerSettingsIpc(createAppContextStub())

    expect([...electronState.handlers.keys()]).toEqual([IPC.showSettings])
    expect(electronState.handlers.size).toBe(1)
  })

  it('handler 被 invoke 时调用 openSettingsWindow(ctx, logger)', () => {
    const ctx = createAppContextStub()
    const logger: SettingsWindowLogger = { warn: vi.fn(), error: vi.fn() }
    registerSettingsIpc(ctx, logger)

    const listener = electronState.handlers.get(IPC.showSettings)
    expect(listener).toBeTypeOf('function')
    const result = listener?.()

    expect(openSettingsWindow).toHaveBeenCalledTimes(1)
    expect(openSettingsWindow).toHaveBeenCalledWith(ctx, logger)
    expect(result).toBeUndefined()
  })

  it('未注入 logger 时以 undefined 透传（兼容既有调用方）', () => {
    const ctx = createAppContextStub()
    registerSettingsIpc(ctx)

    electronState.handlers.get(IPC.showSettings)?.()

    expect(openSettingsWindow).toHaveBeenCalledWith(ctx, undefined)
  })

  it('同一 channel 重复注册抛错，且不覆盖首个 handler', () => {
    const ctx = createAppContextStub()
    registerSettingsIpc(ctx)
    const firstHandler = electronState.handlers.get(IPC.showSettings)

    expect(() => registerSettingsIpc(ctx)).toThrow(/second handler/)
    expect(electronState.handlers.size).toBe(1)
    expect(electronState.handlers.get(IPC.showSettings)).toBe(firstHandler)
  })
})
