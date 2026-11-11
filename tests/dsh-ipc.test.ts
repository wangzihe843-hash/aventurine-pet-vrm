/**
 * 单测：DSH IPC 注册入口（`src/main/ipc/dsh.ts`，Wave 2 B7）。
 *
 * 通过 `vi.mock('electron')` 捕获 `ipcMain.handle` / `app.once`，用 temp dir（env
 * `PET_DSH_DIR` 覆盖）+ fake timers 跑真实 watcher 链路，断言：
 * - 只注册 `pet:dsh-status` 一个 channel；
 * - handler 返回 watcher 缓存状态（默认离线 → 新鲜心跳后在线）；
 * - 事件只在 `online === true` 时 `ctx.broadcast('dsh-event', event)`；
 * - `will-quit` 后停止轮询（不再广播）；
 * - 状态返回副本（调用方改动不影响内部缓存）。
 *
 * **绝不触碰真实 `~/.dsh`**。
 */
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IPC, IPC_EVENTS } from '@shared/ipc'
import type { DshEvent } from '@shared/types'

import type { DshCouplingAlert } from '../src/main/desktop/dsh-lifecycle'
import { DSH_POLL_INTERVAL_MS } from '../src/main/desktop/dsh-watch'
import {
  DSH_SAFE_MODE_FILE,
  createCouplingAlertNotifier,
  formatCouplingAlertText,
  isSafeModeFilePresent,
  registerDshIpc
} from '../src/main/ipc/dsh'
import { createAppContextStub } from './helpers/app-context-stub'
import type { AppContextStub } from './helpers/app-context-stub'

/* ------------------------------ electron mock ------------------------------ */

const electronState = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  onceHandlers: new Map<string, () => void>(),
  onHandlers: new Map<string, ((...args: unknown[]) => void)[]>(),
  quitCalls: 0
}))

vi.mock('electron', () => ({
  app: {
    // 测试环境固定 dev：未打包 + 未设 PET_DSH_COUPLING=1 → 强耦合默认禁用，
    // 因此本文件绝不执行真实 pgrep/open/kill（安全红线）。
    isPackaged: false,
    once(channel: string, listener: () => void): () => void {
      electronState.onceHandlers.set(channel, listener)
      return (): void => {
        electronState.onceHandlers.delete(channel)
      }
    },
    on(channel: string, listener: (...args: unknown[]) => void): () => void {
      const listeners = electronState.onHandlers.get(channel) ?? []
      listeners.push(listener)
      electronState.onHandlers.set(channel, listeners)
      return (): void => {
        const current = electronState.onHandlers.get(channel) ?? []
        electronState.onHandlers.set(
          channel,
          current.filter((entry) => entry !== listener)
        )
      }
    },
    quit(): void {
      electronState.quitCalls += 1
    }
  },
  ipcMain: {
    handle(channel: string, listener: (...args: unknown[]) => unknown): void {
      electronState.handles.set(channel, listener)
    }
  }
}))

/* --------------------------------- harness --------------------------------- */

const tempDirs: string[] = []
let dir = ''
let clock = 0
let ctx: AppContextStub

function makeTempDir(): string {
  const created = mkdtempSync(join(tmpdir(), 'pet-dsh-ipc-'))
  tempDirs.push(created)
  return created
}

/** 写 status.json（默认新鲜 running 帧）。 */
function writeStatus(partial: Record<string, unknown> = {}): void {
  const frame = {
    ts: clock,
    running: true,
    agents: 1,
    lastEventAt: clock - 500,
    lastType: 'task/start',
    ...partial
  }
  writeFileSync(join(dir, 'status.json'), JSON.stringify(frame), 'utf8')
}

/** 追加一条合法桥事件。 */
function appendEvent(partial: Partial<DshEvent> = {}): DshEvent {
  const event: DshEvent = {
    ts: clock,
    type: 'task/start',
    payload: { agent: 'agent-a', status: 'running' },
    ...partial
  }
  appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  return event
}

/** 取已注册的 invoke handler（不存在 → fail）。 */
function getHandler(): (...args: unknown[]) => unknown {
  const handler = electronState.handles.get(IPC.dshStatus)
  if (!handler) throw new Error(`未注册 channel: ${IPC.dshStatus}`)
  return handler
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  electronState.handles.clear()
  electronState.onceHandlers.clear()
  electronState.onHandlers.clear()
  electronState.quitCalls = 0
  // 确保强耦合在单测中始终禁用（dev 默认 + 无 PET_DSH_COUPLING），不触发真实进程操作。
  delete process.env['PET_DSH_COUPLING']
  delete process.env['PET_DSH_COUPLING_DISABLE']
  delete process.env['PET_DSH_TEST_HOOKS']
  dir = makeTempDir()
  // watcher 使用真实 Date.now()（生产路径未注入时钟），因此夹具 ts 也取真实时间。
  clock = Date.now()
  process.env['PET_DSH_DIR'] = dir
  ctx = createAppContextStub()
})

afterEach(() => {
  delete process.env['PET_DSH_DIR']
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const created of tempDirs.splice(0)) rmSync(created, { recursive: true, force: true })
})

/* ---------------------------------- tests ---------------------------------- */

describe('registerDshIpc：channel 与状态', () => {
  it('只注册 pet:dsh-status 且默认离线；不注册其它 channel', () => {
    registerDshIpc(ctx)

    expect([...electronState.handles.keys()]).toEqual([IPC.dshStatus])
    const handler = getHandler()
    expect(handler({})).toEqual({
      online: false,
      running: false,
      lastEventAt: 0,
      lastType: null
    })
    // 启动轮询一次 + 注册 will-quit（watcher 不阻止退出）
    expect(electronState.onceHandlers.has('will-quit')).toBe(true)
  })

  it('新鲜 status.json → handler 返回 online（poll 周期推进后）', () => {
    registerDshIpc(ctx)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(false)

    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    const status = getHandler()({}) as Record<string, unknown>
    expect(status).toMatchObject({
      online: true,
      running: true,
      lastEventAt: clock - 500,
      lastType: 'task/start'
    })
  })

  it('handler 返回副本：调用方修改不影响缓存', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)

    const first = getHandler()({}) as Record<string, unknown>
    first['online'] = false
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(true)
  })

  it('TTL 过期/offline:true → handler 返回离线', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(true)

    writeStatus({ ts: clock - 60_000 })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(false)

    writeStatus({ offline: true })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(false)
  })
})

describe('registerDshIpc：dsh-event 广播', () => {
  it('online 时转发事件（channel/payload 精确匹配）', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(0)

    const event = appendEvent({ type: 'task/start' })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)

    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]).toEqual({ channel: IPC_EVENTS.dshEvent, payload: event })
  })

  it('L-4：注入 logger 后 watcher 告警走共享实例（不落 console.warn）', () => {
    const logger = { warn: vi.fn(), info: vi.fn() }
    registerDshIpc(ctx, logger)
    // 无 status.json 的首次轮询会 warn 一次（默认回退 console.warn；注入后走 logger）
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('status.json not found'))
  })

  it('M-1：注册前的历史事件不回放，注册后新增才广播（EOF 基线）', () => {
    // 桥目录里已有上次会话遗留的历史事件（修复前会在注册瞬间被当新事件广播）
    appendEvent({
      ts: clock - 3_600_000,
      type: 'task/end',
      payload: { agent: 'agent-old', status: 'idle' }
    })
    writeStatus()
    registerDshIpc(ctx)
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(0)

    const fresh = appendEvent({ type: 'task/start' })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]).toEqual({ channel: IPC_EVENTS.dshEvent, payload: fresh })
  })

  it('离线时收到的新事件不转发（避免陈旧事件误触发）', () => {
    registerDshIpc(ctx)
    // 冷启动无 status.json → 离线
    appendEvent({ type: 'task/start' })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(0)

    // 心跳过期：事件继续写也不得广播
    writeStatus({ ts: clock - 60_000 })
    appendEvent({ type: 'task/end', payload: { agent: 'a', status: 'idle' } })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(0)
  })

  it('由在线转离线后，不再转发新事件', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    appendEvent({ type: 'task/start' })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)

    writeStatus({ offline: true })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    appendEvent({ type: 'task/error', payload: { agent: 'a', turn: 1 } })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect(ctx.broadcasts).toHaveLength(1)
  })

  it('will-quit 后停止轮询：后续事件/状态不再广播', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    const quit = electronState.onceHandlers.get('will-quit')
    expect(quit).toBeTypeOf('function')
    quit?.()

    appendEvent({ type: 'task/start' })
    writeStatus({ running: false, lastType: 'task/end' })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS * 5)

    expect(ctx.broadcasts).toHaveLength(0)
  })

  it('status.json 被删除 → 离线；再次出现且新鲜 → 恢复在线', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(true)

    unlinkSync(join(dir, 'status.json'))
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(false)

    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(true)
  })
})

describe('registerDshIpc：强耦合生命周期接线（默认禁用，零真实进程操作）', () => {
  it('注册 app.on("before-quit")；耦合未启用时放行（不 preventDefault、不 app.quit）', () => {
    registerDshIpc(ctx)
    const handlers = electronState.onHandlers.get('before-quit') ?? []
    expect(handlers).toHaveLength(1)

    const event = { preventDefault: vi.fn() }
    handlers[0]?.(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(electronState.quitCalls).toBe(0)
  })

  it('will-quit 同时停止 watcher 与 lifecycle（不残留轮询、不级联退出）', () => {
    registerDshIpc(ctx)
    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(true)

    const quit = electronState.onceHandlers.get('will-quit')
    expect(quit).toBeTypeOf('function')
    quit?.()

    appendEvent({ type: 'task/start' })
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS * 5)
    expect(ctx.broadcasts).toHaveLength(0)
    expect(electronState.quitCalls).toBe(0)
  })

  it('control.json 帧不会破坏 IPC 语义（默认禁用时安全忽略）', () => {
    registerDshIpc(ctx)
    writeFileSync(
      join(dir, 'control.json'),
      JSON.stringify({ schemaVersion: 1, ts: clock, action: 'detached', dshPid: 1 }),
      'utf8'
    )
    // detached 在禁用状态下不得请求退出、不得终止任何进程。
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS * 5)
    expect(electronState.quitCalls).toBe(0)

    writeStatus()
    vi.advanceTimersByTime(DSH_POLL_INTERVAL_MS)
    expect((getHandler()({}) as Record<string, unknown>)['online']).toBe(true)
  })
})

/* --------------------- v2：耦合告警（dialog/Notification 接线） --------------------- */

/** 造一个 DEGRADED 告警（字段与 plan §2.4 一致）。 */
function degradedAlert(overrides: Partial<DshCouplingAlert> = {}): DshCouplingAlert {
  return {
    kind: 'degraded',
    code: 'compat-incompatible',
    reason: 'DSH 版本 0.3.0 不满足桥声明范围 >=0.2.2-rc.1 <0.3.0',
    dshVersion: '0.3.0',
    bridgeVersion: 4,
    dshRange: '>=0.2.2-rc.1 <0.3.0',
    state: 'DEGRADED',
    ...overrides
  }
}

/** 造一个 recovered 告警。 */
function recoveredAlert(overrides: Partial<DshCouplingAlert> = {}): DshCouplingAlert {
  return {
    kind: 'recovered',
    code: 'compat-incompatible',
    reason: '握手恢复，联动语义恢复',
    dshVersion: '0.2.2-rc.1',
    bridgeVersion: 4,
    dshRange: '>=0.2.2-rc.1 <0.3.0',
    state: 'PAIRED',
    ...overrides
  }
}

describe('formatCouplingAlertText：文案含原因码/版本/范围/逃生指引（计划 §2.4）', () => {
  it('degraded 文案含原因码、DSH 版本、桥范围、DSH 本体不受影响 + runbook', () => {
    const text = formatCouplingAlertText(degradedAlert())
    expect(text.title).toContain('桌宠联动降级')
    expect(text.message).toContain('compat-incompatible')
    expect(text.detail).toContain('compat-incompatible')
    expect(text.detail).toContain('0.3.0')
    expect(text.detail).toContain('v4')
    expect(text.detail).toContain('>=0.2.2-rc.1 <0.3.0')
    expect(text.detail).toContain('DSH 本体不受影响，可正常打开/关闭')
    expect(text.detail).toContain('docs/pet-dsh-coupling-runbook.md')
  })

  it('未知版本/范围也能生成可读文案（不抛、显示"未知"）', () => {
    const text = formatCouplingAlertText(
      degradedAlert({ dshVersion: null, bridgeVersion: null, dshRange: null, code: 'bridge-lost' })
    )
    expect(text.detail).toContain('DSH 版本：未知')
    expect(text.detail).toContain('桥版本：未知')
    expect(text.detail).toContain('桥期望 DSH 范围：未知')
  })

  it('recovered 文案是恢复语义（不再要求修复）', () => {
    const text = formatCouplingAlertText(recoveredAlert())
    expect(text.title).toContain('已恢复')
    expect(text.message).toContain('联动已恢复')
    expect(text.detail).toContain('docs/pet-dsh-coupling-runbook.md')
  })
})

describe('createCouplingAlertNotifier：同原因 modal 去重 / 恢复只通知 / SILENT 静默', () => {
  it('degraded：写日志 + 弹一次 modal + 发通知；同原因第二次只发通知', () => {
    const showDialog = vi.fn()
    const showNotification = vi.fn()
    const logger = { warn: vi.fn() }
    const notify = createCouplingAlertNotifier({
      env: {},
      logger,
      showDialog,
      showNotification
    })

    notify(degradedAlert())
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(showDialog).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledTimes(1)

    // 同一次 app 运行同原因不再弹 modal（重复降级/重复告警去噪）
    notify(degradedAlert())
    expect(showDialog).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledTimes(2)

    // 不同原因照常弹一次
    notify(degradedAlert({ code: 'bridge-lost', state: 'DEGRADED' }))
    expect(showDialog).toHaveBeenCalledTimes(2)
  })

  it('recovered：只写日志 + 通知，不弹 modal', () => {
    const showDialog = vi.fn()
    const showNotification = vi.fn()
    const logger = { warn: vi.fn() }
    const notify = createCouplingAlertNotifier({ env: {}, logger, showDialog, showNotification })

    notify(recoveredAlert())
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(showDialog).not.toHaveBeenCalled()
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('PET_DSH_COUPLING_SILENT_ALERTS=1 → 只写日志，不弹窗不通知（E2E 静默）', () => {
    const showDialog = vi.fn()
    const showNotification = vi.fn()
    const logger = { warn: vi.fn() }
    const notify = createCouplingAlertNotifier({
      env: { PET_DSH_COUPLING_SILENT_ALERTS: '1' },
      logger,
      showDialog,
      showNotification
    })

    notify(degradedAlert())
    notify(recoveredAlert())
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(showDialog).not.toHaveBeenCalled()
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('dialog/notification/logger 抛错都静默（告警失败不能影响主流程）', () => {
    const notify = createCouplingAlertNotifier({
      env: {},
      logger: {
        warn: () => {
          throw new Error('log boom')
        }
      },
      showDialog: () => {
        throw new Error('dialog boom')
      },
      showNotification: () => {
        throw new Error('notification boom')
      }
    })
    expect(() => notify(degradedAlert())).not.toThrow()
  })
})

describe('isSafeModeFilePresent：~/.dsh/aventurine-pet/safe-mode 逃生阀', () => {
  it('文件存在 → true；不存在 → false（只看指定目录，不碰真实 ~/.dsh）', () => {
    const safeModeDir = makeTempDir()
    expect(isSafeModeFilePresent(safeModeDir)).toBe(false)
    writeFileSync(join(safeModeDir, DSH_SAFE_MODE_FILE), '', 'utf8')
    expect(isSafeModeFilePresent(safeModeDir)).toBe(true)
  })

  it('exists 抛错 → false（不抛）', () => {
    expect(
      isSafeModeFilePresent('/whatever', () => {
        throw new Error('fs boom')
      })
    ).toBe(false)
  })
})
