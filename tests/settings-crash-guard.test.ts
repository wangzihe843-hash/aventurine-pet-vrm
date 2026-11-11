/**
 * 单测：设置窗崩溃 / 无响应只记日志（R-05）+ 导航拒绝日志脱敏（R-22）。
 *
 * 设置窗与 overlay 的恢复策略不同：设置窗崩溃**不自动 reload**（避免清空用户正在编辑的
 * 表单），只记 error/warn；本文件锁定该行为，并顺带覆盖 `settings-window.ts` 的
 * `denyNavigation` 只记录脱敏 URL。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)
// settings-window 只读 `is.dev`；测试不需要 dev server URL。
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false, mac: process.platform === 'darwin' } }))

import {
  destroySettingsWindow,
  getSettingsWindow,
  openSettingsWindow
} from '../src/main/windows/settings-window'
import type { SettingsWindowLogger } from '../src/main/windows/settings-window'
import { resetElectronStub, type FakeBrowserWindow } from './helpers/electron-stub'

interface LoggerSpy extends SettingsWindowLogger {
  warnings: string[]
  errors: string[]
}

function createLoggerSpy(): LoggerSpy {
  const warnings: string[] = []
  const errors: string[] = []
  return {
    warnings,
    errors,
    warn(message: string): void {
      warnings.push(message)
    },
    error(message: string): void {
      errors.push(message)
    }
  }
}

/** 打开设置窗（stub），补齐复用路径需要的最小化 API，返回窗口与日志记录。 */
function openSettings(): { win: FakeBrowserWindow; logger: LoggerSpy } {
  const logger = createLoggerSpy()
  const win = openSettingsWindow(undefined, logger) as FakeBrowserWindow
  Object.assign(win, { isMinimized: (): boolean => false, restore: (): void => undefined })
  return { win, logger }
}

beforeEach(() => {
  resetElectronStub()
  delete process.env['ELECTRON_RENDERER_URL']
})

afterEach(() => {
  destroySettingsWindow()
  vi.restoreAllMocks()
})

describe('R-05 设置窗崩溃 / 无响应：只记日志、不自动 reload', () => {
  it('render-process-gone（非 clean-exit）记 error，且不调用 reload', () => {
    const { win, logger } = openSettings()

    // FakeWebContents 没有 reload 方法：若实现自动 reload，这里会抛 TypeError。
    expect(() =>
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 })
    ).not.toThrow()

    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]).toContain('[settings]')
    expect(logger.errors[0]).toContain('reason=crashed')
  })

  it('clean-exit 不记 error（正常关闭 / 重载路径）', () => {
    const { win, logger } = openSettings()
    win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(logger.errors).toEqual([])
  })

  it('unresponsive 记 warn', () => {
    const { win, logger } = openSettings()
    win.webContents.emit('unresponsive')
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('unresponsive')
  })

  it('设置窗仍被安全硬化：导航拒绝且日志只记脱敏 URL（R-22）', () => {
    const { win, logger } = openSettings()
    const event = { preventDefault: vi.fn() }

    expect(() =>
      win.webContents.emit(
        'will-navigate',
        event,
        'https://evil.example/steal?sessionToken=TOP_SECRET'
      )
    ).not.toThrow()

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('https://evil.example')
    expect(logger.warnings[0]).not.toContain('TOP_SECRET')
    expect(logger.warnings[0]).not.toContain('sessionToken')
    // 非法 URL 记占位符（不抛异常）。
    win.webContents.emit('will-redirect', { preventDefault: vi.fn() }, 'not a url')
    expect(logger.warnings[1]).toContain('<invalid-url>')
  })

  it('设置窗单例：重复打开复用同一窗口，crash 监听不会重复挂（不重复记日志）', () => {
    const { win, logger } = openSettings()
    openSettingsWindow(undefined, logger)
    expect(getSettingsWindow()).toBe(win)

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(logger.errors).toHaveLength(1)
  })
})
