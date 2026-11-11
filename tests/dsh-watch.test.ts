/**
 * 单测：DSH 桥文件尾随器（`src/main/desktop/dsh-watch.ts`，Wave 2 B7）。
 *
 * 覆盖（task-7 验收条款）：
 * - status.json：新鲜/过期 TTL 边界/未来 ts/offline:true/缺失/坏 JSON/非普通文件/状态变化去重；
 * - events.jsonl：追加增量、半行、轮转（inode）/截断（size<offset）、超长完整行/超长半行、
 *   脏行跳过、单次读取上限（不一次性读入大文件）、stop 后不再触发；
 * - 目录缺失不抛、首次 warn 且不刷屏、回调异常隔离、env 目录覆盖、轮询周期归一化。
 *
 * 全部用 temp dir + 假时钟/假定时器，**绝不触碰真实 `~/.dsh`**。
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BRIDGE_CONTROL_FILE,
  BRIDGE_EVENTS_FILE,
  BRIDGE_MAX_LINE_BYTES,
  BRIDGE_ONLINE_TTL_MS,
  BRIDGE_STATUS_FILE
} from '@shared/bridge-schema'
import type { DshBridgeControlFile } from '@shared/bridge-schema'
import type { DshEvent, DshStatus } from '@shared/types'

import {
  DSH_POLL_INTERVAL_MS,
  normalizePollMs,
  resolveDshDir,
  createDshWatcher
} from '../src/main/desktop/dsh-watch'
import type { DshWatchLogger, DshWatcher } from '../src/main/desktop/dsh-watch'

/** 测试用轮询周期（fake timers 下推进该值即触发一次轮询）。 */
const POLL_MS = 100

/** 每个用例的临时桥目录。 */
const tempDirs: string[] = []
let dir = ''
let clock = 0
let warn: ReturnType<typeof vi.fn>
let info: ReturnType<typeof vi.fn>
let logger: DshWatchLogger
let watcher: DshWatcher | null = null
let events: DshEvent[] = []
let statuses: DshStatus[] = []
let controls: DshBridgeControlFile[] = []

/** 造一个临时目录（afterEach 统一清理）。 */
function makeTempDir(): string {
  const created = mkdtempSync(join(tmpdir(), 'pet-dsh-watch-'))
  tempDirs.push(created)
  return created
}

/** 创建并订阅 watcher（默认指向 temp dir + 假时钟 + fake logger）。 */
function createWatcher(overrides: Partial<Parameters<typeof createDshWatcher>[0]> = {}): DshWatcher {
  watcher = createDshWatcher({
    dir,
    now: () => clock,
    pollMs: POLL_MS,
    logger,
    ...overrides
  })
  watcher.onEvent((event) => events.push(event))
  watcher.onStatusChanged((status) => statuses.push(status))
  watcher.onControl((control) => controls.push(control))
  return watcher
}

/** 写 status.json（默认新鲜 running 帧；显式字段覆盖）。 */
function writeStatus(partial: Record<string, unknown> = {}): void {
  const frame = {
    ts: clock,
    running: true,
    agents: 1,
    lastEventAt: clock - 1000,
    lastType: 'task/start',
    ...partial
  }
  writeFileSync(join(dir, BRIDGE_STATUS_FILE), JSON.stringify(frame), 'utf8')
}

/** 造一条合法 DshEvent。 */
function makeEvent(partial: Partial<DshEvent> = {}): DshEvent {
  return {
    ts: clock,
    type: 'task/start',
    payload: { agent: 'agent-a', status: 'running' },
    ...partial
  }
}

/** 追加一行事件到 events.jsonl。 */
function appendEvent(event: DshEvent): void {
  appendFileSync(join(dir, BRIDGE_EVENTS_FILE), `${JSON.stringify(event)}\n`, 'utf8')
}

/** 推进 fake timers 触发 n 次轮询。 */
function advancePolls(times = 1): void {
  vi.advanceTimersByTime(POLL_MS * times)
}

/** logger.warn 是否包含指定文案（避免断言具体前缀）。 */
function warnedWith(fragment: string): boolean {
  return warn.mock.calls.some((call: unknown[]) => String(call[0]).includes(fragment))
}

beforeEach(() => {
  vi.useFakeTimers()
  dir = makeTempDir()
  clock = 1_700_000_000_000
  warn = vi.fn()
  info = vi.fn()
  logger = { warn, info }
  watcher = null
  events = []
  statuses = []
  controls = []
})

afterEach(() => {
  watcher?.stop()
  watcher = null
  delete process.env['PET_DSH_DIR']
  vi.useRealTimers()
  for (const created of tempDirs.splice(0)) rmSync(created, { recursive: true, force: true })
})

/* ============================ 目录与周期解析 ============================ */

describe('目录 / 周期解析（纯函数）', () => {
  it('显式 dir 优先于 env；空串回退', () => {
    expect(resolveDshDir({ dir: '/tmp/explicit', envDir: '/tmp/env' })).toBe('/tmp/explicit')
    expect(resolveDshDir({ dir: '  ', envDir: '/tmp/env' })).toBe('/tmp/env')
  })

  it('env 为空时回退默认 ~/.dsh/aventurine-pet', () => {
    const resolved = resolveDshDir({ dir: '', envDir: '' })
    expect(resolved).toBe(join(homedir(), '.dsh', 'aventurine-pet'))
    expect(resolved.endsWith(join('.dsh', 'aventurine-pet'))).toBe(true)
  })

  it('支持 ~ / ~/ 展开', () => {
    expect(resolveDshDir({ dir: '~' })).toBe(homedir())
    expect(resolveDshDir({ dir: '~/pet-bridge-test' })).toBe(join(homedir(), 'pet-bridge-test'))
    expect(resolveDshDir({ dir: 'relative/no-expand' })).toBe('relative/no-expand')
    expect(join(homedir(), 'pet-bridge-test').includes(sep)).toBe(true)
  })

  it('normalizePollMs：缺省/非法回退默认，越界钳制', () => {
    expect(normalizePollMs(undefined)).toBe(DSH_POLL_INTERVAL_MS)
    expect(normalizePollMs(0)).toBe(DSH_POLL_INTERVAL_MS)
    expect(normalizePollMs(-5)).toBe(DSH_POLL_INTERVAL_MS)
    expect(normalizePollMs(Number.NaN)).toBe(DSH_POLL_INTERVAL_MS)
    expect(normalizePollMs(1)).toBe(50)
    expect(normalizePollMs(1_000_000)).toBe(60_000)
    expect(normalizePollMs(500.7)).toBe(500)
    expect(normalizePollMs(POLL_MS)).toBe(POLL_MS)
  })

  it('watcher.dir 暴露实际使用的目录（env 覆盖）', () => {
    process.env['PET_DSH_DIR'] = dir
    const fromEnv = createDshWatcher({ now: () => clock, pollMs: POLL_MS, logger })
    expect(fromEnv.dir).toBe(dir)
    fromEnv.stop()
  })
})

/* ============================== status.json ============================== */

describe('status.json 轮询与新鲜度', () => {
  it('新鲜心跳 → online，并透传 running/lastEventAt/lastType', () => {
    writeStatus({})
    createWatcher().start()

    expect(events).toEqual([])
    // 默认离线 → 在线：算一次状态变化
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ online: true, running: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it('TTL 边界：now - ts === TTL 不算 online，TTL-1 算 online', () => {
    writeStatus({ ts: clock - BRIDGE_ONLINE_TTL_MS })
    const w = createWatcher()
    w.start()
    expect(w.getStatus()).toMatchObject({ online: false, running: true })
    // 离线时仍透传 running/lastEventAt/lastType → 相对默认值算一次变化
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ online: false, running: true, lastType: 'task/start' })

    writeStatus({ ts: clock - BRIDGE_ONLINE_TTL_MS + 1 })
    advancePolls()
    expect(w.getStatus()).toMatchObject({
      online: true,
      running: true,
      lastEventAt: clock - 1000,
      lastType: 'task/start'
    })
    expect(statuses).toHaveLength(2)
    expect(statuses[1]).toMatchObject({ online: true, running: true })
  })

  it('未来时间戳不算 online（时钟回拨/伪造防御）', () => {
    writeStatus({ ts: clock + 5000 })
    const w = createWatcher()
    w.start()
    expect(w.getStatus()).toMatchObject({ online: false, running: true })
    expect(w.getStatus().lastEventAt).toBe(clock - 1000) // offline 仍透传原始字段
  })

  it('offline:true 即使 ts 新鲜也判离线，并透传 running/lastType', () => {
    writeStatus({ offline: true, running: true, lastType: 'task/end' })
    const w = createWatcher()
    w.start()
    expect(w.getStatus()).toEqual({
      online: false,
      running: true,
      lastEventAt: clock - 1000,
      lastType: 'task/end'
    })
  })

  it('状态变化只在字段实际变化时通知（去重）', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    expect(w.getStatus().online).toBe(true)
    expect(statuses).toHaveLength(1) // 默认离线 → 在线

    advancePolls(3) // 心跳内容不变
    expect(statuses).toHaveLength(1)

    writeStatus({ ts: clock - 60_000 }) // 转为过期
    advancePolls()
    expect(statuses).toHaveLength(2)
    expect(statuses[1]?.online).toBe(false)

    advancePolls(2) // 仍然过期
    expect(statuses).toHaveLength(2)
  })

  it('订阅取消后不再收到状态变化', () => {
    const w = createWatcher() // 无 status.json：默认离线，启动不产生状态变化
    const seen: DshStatus[] = []
    const off = w.onStatusChanged((status) => seen.push(status))
    w.start()
    expect(seen).toHaveLength(0)

    writeStatus({})
    advancePolls()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.online).toBe(true)

    off()
    writeStatus({ offline: true })
    advancePolls()
    expect(seen).toHaveLength(1) // 取消后不再收到
  })

  it('status.json 缺失：离线默认值 + 首次 warn（后续轮询不刷屏）', () => {
    const w = createWatcher()
    expect(() => w.start()).not.toThrow()
    expect(w.getStatus()).toEqual({
      online: false,
      running: false,
      lastEventAt: 0,
      lastType: null
    })
    expect(warnedWith('status.json not found')).toBe(true)
    const countAfterStart = warn.mock.calls.length

    advancePolls(5)
    expect(warn.mock.calls.length).toBe(countAfterStart) // 只 warn 一次
  })

  it('坏 JSON → 离线 + warn；恢复健康后再次损坏可再 warn 一次', () => {
    writeFileSync(join(dir, BRIDGE_STATUS_FILE), '{not json', 'utf8')
    const w = createWatcher()
    w.start()
    expect(w.getStatus().online).toBe(false)
    expect(warnedWith('status.json unreadable')).toBe(true)

    writeStatus({}) // 恢复健康（重置告警标记）
    advancePolls()
    expect(w.getStatus().online).toBe(true)

    writeFileSync(join(dir, BRIDGE_STATUS_FILE), '[]', 'utf8') // 合法 JSON 但 schema 不对
    advancePolls()
    expect(w.getStatus().online).toBe(false)
    expect(warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('status.json')).length).toBe(2)
  })

  it('status.json 是目录（非普通文件）→ 离线且不抛', () => {
    mkdirSync(join(dir, BRIDGE_STATUS_FILE))
    const w = createWatcher()
    expect(() => w.start()).not.toThrow()
    expect(w.getStatus().online).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})

/* ============================== events.jsonl ============================== */

describe('events.jsonl 增量尾随', () => {
  it('启动时已有历史行不回放（M-1：EOF 基线）；启动后追加只读新增行', () => {
    writeStatus({})
    appendEvent(makeEvent({ type: 'task/start' }))
    appendEvent(makeEvent({ type: 'task/end', payload: { agent: 'agent-a', status: 'idle' } }))

    const w = createWatcher()
    w.start()
    // M-1 修复：首轮从 EOF 开始 —— 启动前的历史事件不得当新事件分发（旧测试断言会重放）。
    expect(events).toEqual([])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('events baseline'))

    advancePolls(3)
    expect(events).toHaveLength(0) // 后续轮询也不会把历史补发

    appendEvent(makeEvent({ type: 'task/error', payload: { agent: 'agent-a', turn: 2 } }))
    advancePolls()
    expect(events.map((event) => event.type)).toEqual(['task/error'])
    expect(events[0]?.payload).toEqual({ agent: 'agent-a', turn: 2 })

    advancePolls(2)
    expect(events).toHaveLength(1) // 没有新增 → 不重复
  })

  it('启动时文件不存在 → 基线 0；之后创建并写入的新事件照常读取', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    expect(events).toHaveLength(0)

    // 文件在本进程启动后才创建：里面的行都是新事件，不能因基线而丢失。
    appendEvent(makeEvent({ type: 'task/start' }))
    advancePolls()
    expect(events.map((event) => event.type)).toEqual(['task/start'])
  })

  it('半行留到下次：只写一半时不触发，补齐换行后才触发', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()

    const line = JSON.stringify(makeEvent({ type: 'task/end', payload: { agent: 'a' } }))
    const splitAt = Math.floor(line.length / 2)
    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), line.slice(0, splitAt), 'utf8')
    advancePolls()
    expect(events).toHaveLength(0)

    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), `${line.slice(splitAt)}\n`, 'utf8')
    advancePolls()
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('task/end')
  })

  it('跨轮询的半行 + 多次追加按顺序拼接', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    const lineA = `${JSON.stringify(makeEvent({ type: 'task/start' }))}`
    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), lineA.slice(0, 10), 'utf8')
    advancePolls()
    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), lineA.slice(10), 'utf8')
    advancePolls(2)
    expect(events).toHaveLength(0) // 没有换行 → 仍不完整

    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), '\n', 'utf8')
    advancePolls()
    expect(events).toHaveLength(1)
  })

  it('截断（size < offset）→ 游标归零重新读', () => {
    writeStatus({})
    // 启动前的历史行只用于建立 EOF 基线（不回放）
    appendEvent(makeEvent({ type: 'task/start' }))
    const w = createWatcher()
    w.start()
    expect(events).toHaveLength(0)

    appendEvent(makeEvent({ type: 'task/end', payload: { agent: 'agent-a', status: 'idle' } }))
    advancePolls()
    expect(events).toHaveLength(1)

    // 同 inode 覆盖成更短内容（模拟手工/异常截断）
    const sizeBefore = statSync(join(dir, BRIDGE_EVENTS_FILE)).size
    const replacement = makeEvent({
      type: 'task/error',
      payload: { agent: 'agent-a', turn: 1 }
    })
    writeFileSync(join(dir, BRIDGE_EVENTS_FILE), `${JSON.stringify(replacement)}\n`, 'utf8')
    expect(statSync(join(dir, BRIDGE_EVENTS_FILE)).size).toBeLessThan(sizeBefore)
    advancePolls()

    // 截断后从头读新内容（旧历史已被覆盖，不再重复旧行）
    expect(events).toHaveLength(2)
    expect(events[1]?.type).toBe('task/error')
  })

  it('轮转（inode 变化，新文件比旧游标更大）→ 游标归零不丢新事件', () => {
    if (process.platform === 'win32') return // Windows 无稳定 inode
    writeStatus({})
    appendEvent(makeEvent({ type: 'task/start' })) // 启动前历史（EOF 基线忽略）
    const w = createWatcher()
    w.start()
    expect(events).toHaveLength(0)

    // 模拟桥插件 5MB 轮转：旧文件 rename 成 .1，新文件从 0 开始写两条（字节数 > 旧 offset）
    renameSync(join(dir, BRIDGE_EVENTS_FILE), join(dir, `${BRIDGE_EVENTS_FILE}.1`))
    appendEvent(makeEvent({ type: 'task/end', payload: { agent: 'a', status: 'idle' } }))
    appendEvent(makeEvent({ type: 'task/error', payload: { agent: 'a', turn: 1 } }))
    const newSize = statSync(join(dir, BRIDGE_EVENTS_FILE)).size
    expect(newSize).toBeGreaterThan(1)

    advancePolls()
    expect(events.map((event) => event.type)).toEqual(['task/end', 'task/error'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('超长完整行（>64KB）丢弃，后续合法行照常触发', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()

    const oversized = {
      ts: clock,
      type: 'session/event',
      payload: { pad: 'x'.repeat(BRIDGE_MAX_LINE_BYTES) }
    }
    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), `${JSON.stringify(oversized)}\n`, 'utf8')
    appendEvent(makeEvent({ type: 'task/start' }))
    advancePolls()

    expect(events.map((event) => event.type)).toEqual(['task/start'])
    expect(warnedWith('line dropped')).toBe(true)
    expect(warn.mock.calls.length).toBe(1) // 超长行只 warn 一次
  })

  it('超长半行（无换行 >64KB）不撑爆 pending；下一个换行后恢复', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()

    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), 'x'.repeat(BRIDGE_MAX_LINE_BYTES + 1024), 'utf8')
    advancePolls(2)
    expect(events).toHaveLength(0)
    expect(warnedWith('line dropped')).toBe(true)

    // 补一个换行结束超长行，再写合法行
    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), '\n', 'utf8')
    appendEvent(makeEvent({ type: 'task/end', payload: { agent: 'a' } }))
    advancePolls()
    expect(events.map((event) => event.type)).toEqual(['task/end'])
  })

  it('脏行（空行/非 JSON/字段缺失）跳过，不抛、后续正常', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()

    appendFileSync(join(dir, BRIDGE_EVENTS_FILE), '\nnot-json\n[]\n{"ts":"x","type":"task/start","payload":{}}\n', 'utf8')
    const valid = makeEvent({ type: 'task/start' })
    appendEvent(valid)
    advancePolls()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(valid)
    expect(warnedWith('invalid events.jsonl line')).toBe(true)
  })

  it('单次轮询读取量有上限：大积压分多次读完，顺序不丢', () => {
    writeStatus({})
    const w = createWatcher()
    w.start() // 启动时无 events.jsonl → 基线 0
    expect(events).toHaveLength(0)

    const total = 4000
    const lines: string[] = []
    for (let index = 0; index < total; index += 1) {
      lines.push(
        JSON.stringify({
          ts: clock,
          type: 'session/event',
          payload: { i: index, pad: '0123456789abcdefghijklmnopqrstuvwxyz' }
        })
      )
    }
    const text = `${lines.join('\n')}\n`
    writeFileSync(join(dir, BRIDGE_EVENTS_FILE), text, 'utf8')
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(256 * 1024)

    advancePolls()
    const firstPollCount = events.length
    expect(firstPollCount).toBeGreaterThan(0)
    expect(firstPollCount).toBeLessThan(total) // 尚未一次读完

    advancePolls(3)
    expect(events).toHaveLength(total)
    // 顺序完整（i 从 0 递增）
    const indices = events.map((event) => (event.payload as { i: number }).i)
    expect(indices[0]).toBe(0)
    expect(indices[indices.length - 1]).toBe(total - 1)
    expect(indices.every((value, index) => value === index)).toBe(true)
  })

  it('events.jsonl 缺失/是目录：不抛，status 仍可用', () => {
    writeStatus({})
    mkdirSync(join(dir, BRIDGE_EVENTS_FILE))
    const w = createWatcher()
    expect(() => w.start()).not.toThrow()
    expect(w.getStatus().online).toBe(true)
    advancePolls()
    expect(warnedWith('events.jsonl')).toBe(true)
    expect(events).toHaveLength(0)
  })
})

/* ============================== 生命周期/异常 ============================== */

describe('生命周期与异常隔离', () => {
  it('stop 后不再触发事件/状态；幂等；isRunning 正确', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    expect(w.isRunning()).toBe(true)

    const statusCountBeforeStop = statuses.length

    w.stop()
    w.stop()
    expect(w.isRunning()).toBe(false)
    expect(w.getStatus().online).toBe(true)

    appendEvent(makeEvent({ type: 'task/start' }))
    writeStatus({ ts: clock - 60_000 })
    advancePolls(3)
    expect(events).toHaveLength(0)
    expect(statuses).toHaveLength(statusCountBeforeStop)
  })

  it('start 幂等：重复调用不会叠加多个定时器导致重复事件', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    w.start()
    w.start()
    appendEvent(makeEvent({ type: 'task/start' }))
    advancePolls()
    expect(events).toHaveLength(1)
  })

  it('回调抛错被隔离：其它回调仍收到，轮询继续', () => {
    writeStatus({})
    const w = createWatcher()
    const received: DshEvent[] = []
    w.onEvent(() => {
      throw new Error('listener boom')
    })
    w.onEvent((event) => received.push(event))
    w.onStatusChanged(() => {
      throw new Error('status listener boom')
    })
    w.start()

    appendEvent(makeEvent({ type: 'task/start' }))
    advancePolls()
    expect(received).toHaveLength(1)

    appendEvent(makeEvent({ type: 'task/end', payload: { agent: 'a' } }))
    advancePolls()
    expect(received).toHaveLength(2)
    expect(warnedWith('listener failed')).toBe(true)
  })

  it('无事件时 reaction 语义：getStatus 返回副本，调用方改动不影响内部缓存', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    const snapshot = w.getStatus()
    snapshot.online = false
    expect(w.getStatus().online).toBe(true)
  })

  it('logger.info 记录启动基线/轮转/截断（可选接口存在时）', () => {
    writeStatus({})
    appendEvent(makeEvent({ type: 'task/start' })) // 启动前历史 → 建立 EOF 基线
    const w = createWatcher()
    w.start()
    expect(info.mock.calls.some((call: unknown[]) => String(call[0]).includes('events baseline'))).toBe(
      true
    )
    writeFileSync(join(dir, BRIDGE_EVENTS_FILE), '', 'utf8')
    advancePolls()
    expect(
      info.mock.calls.some((call: unknown[]) => String(call[0]).includes('cursor reset'))
    ).toBe(true)
  })
})

/* ================================ control.json ============================== */

/** control 文件 mtime 递增序号（fake timers 下 Date.now 冻结，用 utimes 保证签名变化）。 */
let controlMtimeSeq = 0

/** 写一帧合法 control.json 并强制推进 mtime（保证 mtime+size 签名变化）。 */
function writeControlFrame(partial: Partial<DshBridgeControlFile> = {}): DshBridgeControlFile {
  const frame: DshBridgeControlFile = {
    schemaVersion: 1,
    ts: clock,
    action: 'attached',
    dshPid: 12345,
    ...partial
  }
  writeRawControl(JSON.stringify(frame))
  return frame
}

/** 写原始文本到 control.json（脏数据/超限用），并强制推进 mtime。 */
function writeRawControl(text: string): void {
  const path = join(dir, BRIDGE_CONTROL_FILE)
  writeFileSync(path, text, 'utf8')
  controlMtimeSeq += 1
  const stamp = new Date(1_700_000_000_000 + controlMtimeSeq * 1000)
  utimesSync(path, stamp, stamp)
}

describe('control.json 轮询（Wave 3 A3）', () => {
  it('启动即读取 control.json 并通知 attached 控制帧', () => {
    writeStatus({})
    const frame = writeControlFrame({ action: 'attached' })
    const w = createWatcher()
    w.start()

    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ action: 'attached', ts: clock, dshPid: 12345 })
    expect(w.getControl()).toMatchObject(frame)
    expect(warn).not.toHaveBeenCalled()
  })

  it('轮询拾取新的 detached 控制帧（mtime 变化才读）', () => {
    writeStatus({})
    createWatcher().start()
    writeControlFrame({ action: 'attached', ts: clock })
    advancePolls()
    expect(controls.map((frame) => frame.action)).toEqual(['attached'])

    writeControlFrame({ action: 'detached', ts: clock + 1 })
    advancePolls()
    expect(controls.map((frame) => frame.action)).toEqual(['attached', 'detached'])
  })

  it('mtime+size 未变 → 跳过读取，不重复通知', () => {
    writeStatus({})
    const w = createWatcher()
    const attachedPath = writeControlFrame({ action: 'attached' })
    w.start()
    expect(controls).toHaveLength(1)

    // 原样重写并恢复完全相同的 atime/mtime：签名不变 → 不读、不通知。
    const stats = statSync(join(dir, BRIDGE_CONTROL_FILE))
    writeFileSync(join(dir, BRIDGE_CONTROL_FILE), JSON.stringify(attachedPath), 'utf8')
    utimesSync(join(dir, BRIDGE_CONTROL_FILE), stats.atime, stats.mtime)
    advancePolls(3)

    expect(controls).toHaveLength(1)
  })

  it('同 action+ts 去重：mtime 变化但内容相同 → 只通知一次', () => {
    writeStatus({})
    createWatcher().start()
    writeControlFrame({ action: 'attached', ts: clock })
    advancePolls()
    expect(controls).toHaveLength(1)

    writeControlFrame({ action: 'attached', ts: clock }) // 相同 action+ts，mtime 已推进
    advancePolls()
    expect(controls).toHaveLength(1)
  })

  it('脏 JSON 忽略且不抛；恢复合法帧后继续通知（首次 warn 不刷屏）', () => {
    writeStatus({})
    writeRawControl('{ not json')
    const w = createWatcher()
    expect(() => w.start()).not.toThrow()
    expect(controls).toHaveLength(0)
    expect(warnedWith('control.json')).toBe(true)

    writeRawControl('{"schemaVersion":99,"ts":1,"action":"attached"}')
    advancePolls()
    expect(controls).toHaveLength(0)

    writeControlFrame({ action: 'detached', ts: clock + 2 })
    advancePolls()
    expect(controls.map((frame) => frame.action)).toEqual(['detached'])
    expect(w.getControl()?.action).toBe('detached')
  })

  it('超过 64KB 的 control.json 被忽略（防御伪造/超大文件）', () => {
    writeStatus({})
    writeRawControl(`{"padding":"${'x'.repeat(70_000)}"}`)
    const w = createWatcher()
    w.start()
    expect(controls).toHaveLength(0)
    expect(warnedWith('too large')).toBe(true)
  })

  it('control.json 缺失：静默（不 warn、不通知）', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    expect(controls).toHaveLength(0)
    expect(warnedWith('control.json')).toBe(false)
    advancePolls(3)
    expect(controls).toHaveLength(0)
  })

  it('非普通文件 → 忽略 + 首次 warn', () => {
    writeStatus({})
    mkdirSync(join(dir, BRIDGE_CONTROL_FILE))
    const w = createWatcher()
    w.start()
    expect(controls).toHaveLength(0)
    expect(warnedWith('not a regular file')).toBe(true)
  })

  it('onControl 取消订阅后不再通知；getControl 返回副本', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    const received: DshBridgeControlFile[] = []
    const unsubscribe = w.onControl((frame) => received.push(frame))
    writeControlFrame({ action: 'attached', ts: clock + 1 })
    advancePolls()
    expect(received).toHaveLength(1)

    unsubscribe()
    writeControlFrame({ action: 'detached', ts: clock + 2 })
    advancePolls()
    expect(received).toHaveLength(1)
    expect(controls.map((frame) => frame.action)).toEqual(['attached', 'detached'])

    const snapshot = w.getControl()
    expect(snapshot).not.toBeNull()
    if (snapshot) snapshot.action = 'attached' // 改副本不影响内部缓存
    expect(w.getControl()?.action).toBe('detached')
  })

  it('start 幂等：重复 start 不会重复通知控制帧', () => {
    writeStatus({})
    writeControlFrame({ action: 'attached', ts: clock })
    const w = createWatcher()
    w.start()
    w.start()
    w.start()
    advancePolls(2)
    expect(controls).toHaveLength(1)
  })

  it('stop 后不再通知 control 帧', () => {
    writeStatus({})
    const w = createWatcher()
    w.start()
    writeControlFrame({ action: 'attached', ts: clock + 1 })
    advancePolls()
    expect(controls).toHaveLength(1)

    w.stop()
    writeControlFrame({ action: 'detached', ts: clock + 2 })
    advancePolls(3)
    expect(controls).toHaveLength(1)
  })
})
