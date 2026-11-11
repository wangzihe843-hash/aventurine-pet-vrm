/**
 * 单测：`pet:windows` 轮询 / 广播（`src/main/ipc/desktop.ts`，Wave 1 M-6 / A4-F01）。
 *
 * 通过 `vi.mock('electron')`（ipcMain/app）+ mock winlist helper + fake timers，
 * 直接跑真实 `registerDesktopIpc`，覆盖 A4 验收里此前无仓库内测试的链路：
 * - 注册 `pet:windows` 且返回缓存（首次成功前为 []）；
 * - 首次成功轮询只做基线，不广播；
 * - 同列表不广播；变化广播恰 1 次且 payload 正确；
 * - 失败保留旧缓存、不广播空列表；连续失败只 warn 一次；
 * - 轮询在途不叠加（助手超过一个轮询周期未返回时不会堆积 spawn）；
 * - poll 内异常（helper reject / broadcast 抛）不产生 unhandled rejection（A4-F05）；
 * - will-quit 清定时器、之后不再 spawn。
 */
import { IPC } from '@shared/ipc'
import type { WindowInfo } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./helpers/electron-stub')).electronStub.module)

const winlistMock = vi.hoisted(() => ({
  list: vi.fn(),
  lastError: vi.fn()
}))

vi.mock('../src/main/desktop/winlist', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as Record<string, unknown>),
    createWinlistHelper: () => ({ list: winlistMock.list, lastError: winlistMock.lastError })
  }
})

import { POLL_INTERVAL_MS, registerDesktopIpc } from '../src/main/ipc/desktop'
import { createAppContextStub } from './helpers/app-context-stub'
import type { AppContextStub } from './helpers/app-context-stub'
import { electronStub, resetElectronStub } from './helpers/electron-stub'

/* --------------------------------- 测试数据 --------------------------------- */

const WINDOW_A: WindowInfo = {
  id: 42,
  pid: 501,
  owner: '访达',
  layer: 0,
  alpha: 1,
  bounds: { x: 0, y: 30, width: 800, height: 600 },
  onScreen: true
}

const WINDOW_B: WindowInfo = {
  id: 857,
  pid: 19674,
  owner: 'DeepSeek Harness',
  layer: 0,
  alpha: 1,
  bounds: { x: 323, y: 89, width: 1280, height: 820 },
  onScreen: true
}

/** 深拷贝窗口列表（模拟 helper 每次返回新对象）。 */
function cloneWindows(windows: WindowInfo[]): WindowInfo[] {
  return windows.map((window) => ({ ...window, bounds: { ...window.bounds } }))
}

interface PollResponse {
  windows?: WindowInfo[]
  /** 非空表示本轮助手失败（list 返回 []，lastError 返回该值）。 */
  error?: string | null
}

/* ------------------------------- 测试 harness ------------------------------- */

let ctx: AppContextStub
let responses: PollResponse[]
let currentError: string | null

/** 排队一次 `helper.list()` 的返回（按调用顺序消费）。 */
function queue(...items: PollResponse[]): void {
  responses.push(...items)
}

/** 刷新微任务（poll 的 await 链）。 */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/** 等一次轮询 / 指定时间（fake timers）。 */
async function settle(ms = 0): Promise<void> {
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms)
  else await flushMicrotasks()
}

/** 注册 desktop IPC 并返回 `pet:windows` handler。 */
function register(): () => WindowInfo[] {
  registerDesktopIpc(ctx)
  const handler = electronStub.ipcMain.handlers.get(IPC.windows)
  if (!handler) throw new Error('pet:windows handler not registered')
  return handler as () => WindowInfo[]
}

beforeEach(() => {
  resetElectronStub()
  vi.useFakeTimers()
  ctx = createAppContextStub()
  responses = []
  currentError = null

  winlistMock.list.mockReset()
  winlistMock.lastError.mockReset()
  winlistMock.list.mockImplementation(async (): Promise<WindowInfo[]> => {
    const response = responses.shift() ?? { windows: [] }
    currentError = response.error ?? null
    return response.windows ?? []
  })
  winlistMock.lastError.mockImplementation((): string | null => currentError)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* --------------------------------- 用例 --------------------------------- */

describe('registerDesktopIpc：注册与首轮基线', () => {
  it('只注册 pet:windows；首次成功轮询前 handler 返回 []', async () => {
    queue({ windows: [WINDOW_A] })
    const handler = register()

    expect(electronStub.ipcMain.handlers.size).toBe(1)
    expect(handler()).toEqual([])

    await settle()
    expect(handler()).toEqual([WINDOW_A])
  })

  it('首次成功轮询只做基线，不广播 windows-updated', async () => {
    queue({ windows: [WINDOW_A, WINDOW_B] })
    register()
    await settle()

    expect(ctx.broadcasts).toHaveLength(0)
  })

  it('同列表不广播（不同对象实例、内容相同）', async () => {
    queue({ windows: [WINDOW_A, WINDOW_B] })
    register()
    await settle()

    queue({ windows: cloneWindows([WINDOW_A, WINDOW_B]) })
    await settle(POLL_INTERVAL_MS)

    expect(ctx.broadcasts).toHaveLength(0)
  })

  it('列表变化广播恰 1 次，payload 为完整新列表', async () => {
    queue({ windows: [WINDOW_A] })
    register()
    await settle()

    queue({ windows: [WINDOW_A, WINDOW_B] })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]).toEqual({
      channel: 'windows-updated',
      payload: [WINDOW_A, WINDOW_B]
    })

    // 之后同列表的下一拍不重复广播
    queue({ windows: cloneWindows([WINDOW_A, WINDOW_B]) })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)

    // 再变化 → 第二次广播
    queue({ windows: [WINDOW_B] })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(2)
    expect(ctx.broadcasts[1]).toEqual({ channel: 'windows-updated', payload: [WINDOW_B] })
  })
})

describe('registerDesktopIpc：助手失败降级', () => {
  it('失败保留旧缓存、不广播空列表；连续失败只 warn 一次；恢复后变化正常广播', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    queue({ windows: [WINDOW_A] })
    register()
    await settle()

    queue({ windows: [], error: 'helper missing' })
    await settle(POLL_INTERVAL_MS)
    queue({ windows: [], error: 'helper timeout after 2000ms' })
    await settle(POLL_INTERVAL_MS)

    expect(ctx.broadcasts).toHaveLength(0)
    expect(registerHandlerCache()).toEqual([WINDOW_A])
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleWarn.mock.calls[0]?.[0]).toContain('helper missing')

    // 恢复且列表未变 → 不广播
    queue({ windows: cloneWindows([WINDOW_A]), error: null })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(0)
    expect(consoleWarn).toHaveBeenCalledTimes(1)

    // 恢复后真正变化 → 正常广播
    queue({ windows: [WINDOW_A, WINDOW_B] })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]?.payload).toEqual([WINDOW_A, WINDOW_B])
  })

  /** 读取当前 handler 返回值（缓存）；helper 便于上面断言里少写一行。 */
  function registerHandlerCache(): WindowInfo[] {
    return (electronStub.ipcMain.handlers.get(IPC.windows) as () => WindowInfo[])()
  }
})

describe('registerDesktopIpc：轮询在途 / 清理 / 异常', () => {
  it('轮询在途时不叠加 spawn（助手超过一个轮询周期未返回）', async () => {
    let resolveFirst: ((windows: WindowInfo[]) => void) | null = null
    winlistMock.list.mockImplementationOnce(
      () =>
        new Promise<WindowInfo[]>((resolve) => {
          resolveFirst = resolve
        })
    )
    register()

    // 首轮未返回时连续多个轮询节拍都只应有一个在途调用
    await vi.advanceTimersByTimeAsync(1500)
    expect(winlistMock.list).toHaveBeenCalledTimes(1)

    resolveFirst!([WINDOW_A])
    await flushMicrotasks()
    expect((electronStub.ipcMain.handlers.get(IPC.windows) as () => WindowInfo[])()).toEqual([
      WINDOW_A
    ])

    // 下一拍才再次 spawn（返回同列表 → 只更新缓存，不广播）
    queue({ windows: cloneWindows([WINDOW_A]) })
    await settle(POLL_INTERVAL_MS)
    expect(winlistMock.list).toHaveBeenCalledTimes(2)
    expect(ctx.broadcasts).toHaveLength(0)
  })

  it('helper reject（F05）：不产生 unhandled rejection，只 warn；下一拍继续轮询', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    queue({ windows: [WINDOW_A] })
    register()
    await settle()

    winlistMock.list.mockRejectedValueOnce(new Error('unexpected helper crash'))
    await settle(POLL_INTERVAL_MS)
    expect(consoleWarn).toHaveBeenCalledWith('[desktop] winlist poll failed: unexpected helper crash')
    expect(ctx.broadcasts).toHaveLength(0)

    queue({ windows: [WINDOW_A, WINDOW_B] })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]?.payload).toEqual([WINDOW_A, WINDOW_B])
  })

  it('broadcast 抛错（F05）：被 poll 兜底捕获并 warn，不中断后续轮询', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    queue({ windows: [WINDOW_A] })
    register()
    await settle()

    const originalBroadcast = ctx.broadcast
    ctx.broadcast = (): void => {
      throw new Error('webContents send failed')
    }
    queue({ windows: [WINDOW_A, WINDOW_B] })
    await settle(POLL_INTERVAL_MS)
    expect(consoleWarn).toHaveBeenCalledWith(
      '[desktop] winlist poll failed: webContents send failed'
    )

    // 恢复后下一拍仍能广播（说明 polling 标志在 finally 中复位）
    ctx.broadcast = originalBroadcast
    queue({ windows: [WINDOW_A] })
    await settle(POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]?.payload).toEqual([WINDOW_A])
  })

  it('will-quit 清理定时器：之后不再 spawn，handler 仍返回最后缓存', async () => {
    queue({ windows: [WINDOW_A] })
    register()
    await settle()
    expect(winlistMock.list).toHaveBeenCalledTimes(1)

    electronStub.app.emit('will-quit')
    await vi.advanceTimersByTimeAsync(3000)

    expect(winlistMock.list).toHaveBeenCalledTimes(1)
    expect(electronStub.app.listenerCount('will-quit')).toBe(0)
    expect((electronStub.ipcMain.handlers.get(IPC.windows) as () => WindowInfo[])()).toEqual([
      WINDOW_A
    ])
  })
})
