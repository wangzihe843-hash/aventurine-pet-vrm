/**
 * M-11 回归：`src/main/ipc/config.ts` 的 userData 容错。
 *
 * 场景：`app.getPath('userData')` 返回一个**普通文件路径**（mkdirSync 必然失败），
 * 断言 `registerConfigIpc` 不抛（bootstrap 不会 app.exit(1)），且 `pet:get-config` /
 * `pet:set-config` 仍可内存态读写 + 广播；另验证正常可写目录仍真实落盘。
 *
 * 通过 `vi.mock('electron')` 捕获 `ipcMain.handle` 的 listener；`AppContext` 用最小 fake
 * （只有 `broadcast` 被 config 模块使用）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONFIG_VERSION, DEFAULT_CONFIG } from '@shared/config'
import { IPC, IPC_EVENTS } from '@shared/ipc'
import type { AppContext } from '../src/main/app-context'
import type { Logger } from '../src/main/logger'

const electronState = vi.hoisted(() => ({
  userDataPath: '',
  getPathError: null as Error | null,
  handles: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath(name: string): string {
      if (electronState.getPathError) throw electronState.getPathError
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
      return electronState.userDataPath
    }
  },
  ipcMain: {
    handle(channel: string, listener: (...args: unknown[]) => unknown): void {
      electronState.handles.set(channel, listener)
    }
  }
}))

import { registerConfigIpc } from '../src/main/ipc/config'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-ipc-config-'))
  tempDirs.push(dir)
  return dir
}

function makeCtx(): { ctx: AppContext; broadcast: ReturnType<typeof vi.fn> } {
  const broadcast = vi.fn()
  return { ctx: { broadcast } as unknown as AppContext, broadcast }
}

function getListener(channel: string): (...args: unknown[]) => unknown {
  const listener = electronState.handles.get(channel)
  if (!listener) throw new Error(`ipcMain.handle 未注册 channel: ${channel}`)
  return listener
}

afterEach(() => {
  vi.doUnmock('../src/main/config-store')
  vi.resetModules()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  electronState.handles.clear()
  electronState.getPathError = null
})

describe('userData 不可用（mkdirSync 失败）：注册不抛、IPC 降级为内存态', () => {
  it('userData 是普通文件 → registerConfigIpc 不抛且 get/set 仍可用', () => {
    const base = makeTempDir()
    const fileAsUserData = join(base, 'user-data-is-a-file')
    writeFileSync(fileAsUserData, 'not a directory', 'utf8')
    electronState.userDataPath = fileAsUserData

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx, broadcast } = makeCtx()

    // 修复前：mkdirSync 抛错 → registerIpcHandlers 抛 → bootstrap catch → app.exit(1)。
    expect(() => registerConfigIpc(ctx)).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('无法创建 userData 目录'),
      expect.anything()
    )
    expect(electronState.handles.has(IPC.getConfig)).toBe(true)
    expect(electronState.handles.has(IPC.setConfig)).toBe(true)

    const get = getListener(IPC.getConfig)
    expect(get({})).toEqual(DEFAULT_CONFIG)

    const set = getListener(IPC.setConfig)
    const next = set({}, { sizePercent: 40, opacity: 9 }) as Record<string, unknown>
    expect(next['sizePercent']).toBe(40)
    expect(next['opacity']).toBe(1) // sanitizeConfig 钳制
    expect(broadcast).toHaveBeenCalledWith(IPC_EVENTS.configChanged, next)
    expect(get({})).toEqual(next) // 内存态已更新（写盘失败不影响本次运行）

    // 文件路径用户目录下不可能真正写出 config.json
    expect(existsSync(join(fileAsUserData, 'config.json'))).toBe(false)
    // 日志写失败由 logger 内部兜底（console.error），同样不得抛出。
    expect(errorSpy).toHaveBeenCalled()
  })

  it('userData 可写 → 正常落盘 config.json 与 logs/main.log，且无降级告警', () => {
    const dir = makeTempDir()
    electronState.userDataPath = dir
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = makeCtx()

    expect(() => registerConfigIpc(ctx)).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()

    const set = getListener(IPC.setConfig)
    set({}, { fpsCap: 60 })

    const payload = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      version: number
      config: Record<string, unknown>
    }
    expect(payload.version).toBe(CONFIG_VERSION)
    expect(payload.config['fpsCap']).toBe(60)
    expect(existsSync(join(dir, 'logs', 'main.log'))).toBe(true)
  })
})

describe('store 构造异常：降级为纯内存配置（最后防线）', () => {
  it('createConfigStore 抛错时仍注册成功，get/set/广播可用', async () => {
    // 用动态模块图 mock 掉真实 store 的构造，验证 ipc 层的兜底分支。
    vi.resetModules()
    vi.doMock('../src/main/config-store', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/main/config-store')>()
      return {
        ...actual,
        createConfigStore: (): never => {
          throw new Error('store init boom')
        }
      }
    })

    const dir = makeTempDir()
    electronState.userDataPath = dir
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, broadcast } = makeCtx()
    const { registerConfigIpc: registerFresh } = await import('../src/main/ipc/config')

    expect(() => registerFresh(ctx)).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('降级为内存配置'),
      expect.anything()
    )

    const get = getListener(IPC.getConfig)
    expect(get({})).toEqual(DEFAULT_CONFIG)
    const set = getListener(IPC.setConfig)
    const next = set({}, { autonomousLevel: 'high' }) as Record<string, unknown>
    expect(next['autonomousLevel']).toBe('high')
    expect(broadcast).toHaveBeenCalledWith(IPC_EVENTS.configChanged, next)
    expect(get({})).toEqual(next)
    // 纯内存：不落盘
    expect(existsSync(join(dir, 'config.json'))).toBe(false)
  })
})

describe('L-3：注入进程级 logger 时复用同一实例（不再自建第二个 Logger）', () => {
  it('不创建 logs/main.log；config-store 使用注入实例写盘', () => {
    const dir = makeTempDir()
    electronState.userDataPath = dir
    const { ctx } = makeCtx()
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      filePath: join(dir, 'logs', 'main.log')
    } as unknown as Logger

    expect(() => registerConfigIpc(ctx, logger)).not.toThrow()
    // 复用注入实例：注册 / launchAtLogin 摘要走同一个 logger
    expect(logger.info).toHaveBeenCalledWith('[config] 配置 IPC 已注册', expect.anything())
    expect(logger.info).toHaveBeenCalledWith('[config] launchAtLogin 应用结果', expect.anything())
    // 未注入时才自建 logger；注入后不得再创建第二个 main.log 实例
    expect(existsSync(join(dir, 'logs', 'main.log'))).toBe(false)

    // config-store 正常落盘（logger 仅影响日志，不影响配置写盘）
    getListener(IPC.setConfig)({}, { fpsCap: 30 })
    const payload = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      config: Record<string, unknown>
    }
    expect(payload.config['fpsCap']).toBe(30)
  })
})
