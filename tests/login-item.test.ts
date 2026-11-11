/**
 * login-item 单测（R-13）：`applyLaunchAtLogin` 的 dev 跳过 / packaged 启停 /
 * 系统 API 抛错 / 非 darwin 平台分支。
 *
 * 内联 `vi.mock('electron')`（不改共享 electron-stub）：`app.isPackaged` 用 getter 暴露，
 * `app.setLoginItemSettings` 用 mock。平台通过重定义 `process.platform` 模拟并在 afterEach 恢复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  setLoginItemSettings: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return electronState.isPackaged
    },
    setLoginItemSettings: electronState.setLoginItemSettings
  }
}))

import { applyLaunchAtLogin } from '../src/main/login-item'

/** `process.platform` 是 data property（非 getter），用 defineProperty 模拟并恢复。 */
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
  if (!originalPlatform) throw new Error('process.platform descriptor 不存在')
  Object.defineProperty(process, 'platform', { ...originalPlatform, value })
}

beforeEach(() => {
  electronState.isPackaged = false
  electronState.setLoginItemSettings.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('applyLaunchAtLogin', () => {
  it('dev（!isPackaged）：跳过系统写入，applied=false / reason=dev', () => {
    setPlatform('darwin')
    electronState.isPackaged = false

    const result = applyLaunchAtLogin(true)

    expect(result).toEqual({ enabled: true, applied: false, reason: 'dev' })
    expect(electronState.setLoginItemSettings).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dev 模式跳过登录项写入'))
  })

  it('packaged darwin enabled=true：调用 setLoginItemSettings({openAtLogin:true})', () => {
    setPlatform('darwin')
    electronState.isPackaged = true

    const result = applyLaunchAtLogin(true)

    expect(result).toEqual({ enabled: true, applied: true })
    expect(electronState.setLoginItemSettings).toHaveBeenCalledTimes(1)
    expect(electronState.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  })

  it('packaged darwin enabled=false：调用 setLoginItemSettings({openAtLogin:false})', () => {
    setPlatform('darwin')
    electronState.isPackaged = true

    const result = applyLaunchAtLogin(false)

    expect(result).toEqual({ enabled: false, applied: true })
    expect(electronState.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  })

  it('系统 API 抛错：返回 applied=false / reason=error，且不向外抛', () => {
    setPlatform('darwin')
    electronState.isPackaged = true
    electronState.setLoginItemSettings.mockImplementation(() => {
      throw new Error('login item unavailable')
    })

    expect(() => applyLaunchAtLogin(true)).not.toThrow()
    expect(electronState.setLoginItemSettings).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('写入登录项失败'),
      expect.any(Error)
    )
    expect(applyLaunchAtLogin(true)).toEqual({
      enabled: true,
      applied: false,
      reason: 'error'
    })
    expect(electronState.setLoginItemSettings).toHaveBeenCalledTimes(2)
  })

  it('packaged 非 darwin：不调用系统 API，reason=unsupported-platform', () => {
    setPlatform('linux')
    electronState.isPackaged = true

    const result = applyLaunchAtLogin(true)

    expect(result).toEqual({
      enabled: true,
      applied: false,
      reason: 'unsupported-platform'
    })
    expect(electronState.setLoginItemSettings).not.toHaveBeenCalled()
  })
})
