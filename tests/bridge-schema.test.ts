/**
 * A6 单测：DSH 桥文件契约（M0-2 / bridge-schema.ts）。
 *
 * 重点覆盖 M0-2 复核后加固的语义：
 * - 未来 ts 不算 online；`offline:true` 显式离线；TTL 边界；
 * - 任意脏输入解析返回 null 不抛异常；>64KB 行（含多字节 UTF-8）直接丢弃。
 */
import { describe, expect, it } from 'vitest'

import {
  BRIDGE_CONTROL_FILE,
  BRIDGE_CONTROL_MAX_BYTES,
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_DIR_NAME,
  BRIDGE_EVENTS_FILE,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_MAX_LINE_BYTES,
  BRIDGE_ONLINE_TTL_MS,
  BRIDGE_ROTATE_BYTES,
  BRIDGE_STATUS_FILE,
  DSH_EVENT_TYPES,
  isBridgeLineTooLong,
  isDshBridgeControlFile,
  isDshBridgeStatusFile,
  isDshEvent,
  isDshEventType,
  parseDshBridgeControlFile,
  parseDshEventLine,
  toDshStatus,
  utf8ByteLength
} from '@shared/bridge-schema'
import type { DshBridgeControlFile, DshBridgeStatusFile } from '@shared/bridge-schema'

function makeStatusFile(overrides: Partial<DshBridgeStatusFile> = {}): DshBridgeStatusFile {
  return {
    ts: 1_000_000,
    running: true,
    agents: 2,
    lastEventAt: 999_000,
    lastType: 'task/start',
    ...overrides
  }
}

describe('桥文件常量冻结', () => {
  it('目录/文件名/周期/TTL/轮转/行上限均为冻结值', () => {
    expect(BRIDGE_DIR_NAME).toBe('aventurine-pet')
    expect(BRIDGE_STATUS_FILE).toBe('status.json')
    expect(BRIDGE_EVENTS_FILE).toBe('events.jsonl')
    expect(BRIDGE_HEARTBEAT_MS).toBe(5000)
    expect(BRIDGE_ONLINE_TTL_MS).toBe(30_000)
    expect(BRIDGE_ROTATE_BYTES).toBe(5 * 1024 * 1024)
    expect(BRIDGE_MAX_LINE_BYTES).toBe(64 * 1024)
    // Wave 3 新增：生命周期控制帧（加法式契约）
    expect(BRIDGE_CONTROL_FILE).toBe('control.json')
    expect(BRIDGE_CONTROL_SCHEMA_VERSION).toBe(1)
    expect(BRIDGE_CONTROL_MAX_BYTES).toBe(4096)
  })

  it('DSH_EVENT_TYPES 恰好 5 个类型、顺序与 §8 一致、无重复', () => {
    expect(DSH_EVENT_TYPES).toEqual([
      'agent/status',
      'task/start',
      'task/end',
      'task/error',
      'session/event'
    ])
    expect(new Set(DSH_EVENT_TYPES).size).toBe(DSH_EVENT_TYPES.length)
    for (const type of DSH_EVENT_TYPES) {
      expect(isDshEventType(type)).toBe(true)
    }
    expect(isDshEventType('unknown/type')).toBe(false)
    expect(isDshEventType(null)).toBe(false)
    expect(isDshEventType(42)).toBe(false)
  })
})

describe('toDshStatus：在线判定', () => {
  const now = 1_000_000

  it('文件不存在/为空 → 全量离线默认值', () => {
    const offline = { online: false, running: false, lastEventAt: 0, lastType: null }
    expect(toDshStatus(null, now)).toEqual(offline)
    expect(toDshStatus(undefined, now)).toEqual(offline)
  })

  it('心跳新鲜（0 <= now-ts < TTL）→ online', () => {
    expect(toDshStatus(makeStatusFile({ ts: now }), now).online).toBe(true)
    expect(toDshStatus(makeStatusFile({ ts: now - 1 }), now).online).toBe(true)
    expect(toDshStatus(makeStatusFile({ ts: now - (BRIDGE_ONLINE_TTL_MS - 1) }), now).online).toBe(
      true
    )
  })

  it('TTL 边界：now-ts === TTL 时判离线', () => {
    expect(toDshStatus(makeStatusFile({ ts: now - BRIDGE_ONLINE_TTL_MS }), now).online).toBe(false)
    expect(
      toDshStatus(makeStatusFile({ ts: now - BRIDGE_ONLINE_TTL_MS - 1 }), now).online
    ).toBe(false)
  })

  it('未来时间戳（时钟回拨/伪造）不算 online', () => {
    expect(toDshStatus(makeStatusFile({ ts: now + 1 }), now).online).toBe(false)
    expect(toDshStatus(makeStatusFile({ ts: now + 60_000 }), now).online).toBe(false)
  })

  it('非法 now（NaN/Infinity）判离线', () => {
    const file = makeStatusFile({ ts: now })
    expect(toDshStatus(file, Number.NaN).online).toBe(false)
    expect(toDshStatus(file, Infinity).online).toBe(false)
  })

  it('offline:true 即使心跳新鲜也判离线，且 running/lastEventAt/lastType 原样透传', () => {
    const file = makeStatusFile({ ts: now, offline: true, running: true })
    const status = toDshStatus(file, now)
    expect(status).toEqual({
      online: false,
      running: true,
      lastEventAt: file.lastEventAt,
      lastType: 'task/start'
    })
  })

  it('offline 缺省或为 false 时按心跳新鲜度判断', () => {
    expect(toDshStatus(makeStatusFile({ ts: now, offline: undefined }), now).online).toBe(true)
    expect(toDshStatus(makeStatusFile({ ts: now, offline: false }), now).online).toBe(true)
  })
})

describe('isDshBridgeStatusFile：status.json 结构校验（含 offline 字段）', () => {
  it('合法文件（offline 缺省/true/false）均通过', () => {
    expect(isDshBridgeStatusFile(makeStatusFile())).toBe(true)
    expect(isDshBridgeStatusFile(makeStatusFile({ offline: true }))).toBe(true)
    expect(isDshBridgeStatusFile(makeStatusFile({ offline: false }))).toBe(true)
    expect(isDshBridgeStatusFile(makeStatusFile({ lastType: null }))).toBe(true)
  })

  it('offline 不是 boolean → 拒绝', () => {
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), offline: 'true' })).toBe(false)
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), offline: 1 })).toBe(false)
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), offline: {} })).toBe(false)
  })

  it('缺字段/类型错误/非普通对象 → 拒绝', () => {
    expect(isDshBridgeStatusFile(null)).toBe(false)
    expect(isDshBridgeStatusFile([])).toBe(false)
    expect(isDshBridgeStatusFile('status')).toBe(false)
    expect(isDshBridgeStatusFile({})).toBe(false)
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), ts: '1000' })).toBe(false)
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), ts: Number.NaN })).toBe(false)
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), running: 'yes' })).toBe(false)
    expect(isDshBridgeStatusFile({ ...makeStatusFile(), lastType: 'nope' })).toBe(false)
  })
})

describe('isDshEvent / parseDshEventLine：解析与脏输入', () => {
  it('isDshEvent：合法事件通过，非法字段拒绝', () => {
    expect(isDshEvent({ ts: 1, type: 'task/start', payload: {} })).toBe(true)
    expect(isDshEvent({ ts: 1, type: 'session/event', payload: { a: 1 } })).toBe(true)
    expect(isDshEvent({ ts: 1, type: 'task/start', payload: [] })).toBe(false)
    expect(isDshEvent({ ts: Number.NaN, type: 'task/start', payload: {} })).toBe(false)
    expect(isDshEvent({ ts: 1, type: 'task/start', payload: null })).toBe(false)
    expect(isDshEvent(null)).toBe(false)
  })

  it('parseDshEventLine：合法行解析为对象（允许首尾空白/换行）', () => {
    const event = { ts: 123456, type: 'task/start', payload: { task: 'x' } }
    expect(parseDshEventLine(JSON.stringify(event))).toEqual(event)
    expect(parseDshEventLine(`\n  ${JSON.stringify(event)}  \n`)).toEqual(event)
    expect(parseDshEventLine(`\r\n${JSON.stringify(event)}\r\n`)).toEqual(event)
  })

  it('parseDshEventLine：空行/半行/非 JSON/非对象/字段缺失/未知类型 → null（不抛异常）', () => {
    expect(parseDshEventLine('')).toBeNull()
    expect(parseDshEventLine('   ')).toBeNull()
    expect(parseDshEventLine('\n\t\r')).toBeNull()
    expect(parseDshEventLine('not json at all')).toBeNull()
    expect(parseDshEventLine('{"ts":1,"type":"task/sta')).toBeNull()
    expect(parseDshEventLine('null')).toBeNull()
    expect(parseDshEventLine('[1,2,3]')).toBeNull()
    expect(parseDshEventLine('"str"')).toBeNull()
    expect(parseDshEventLine('42')).toBeNull()
    expect(parseDshEventLine('{"ts":1}')).toBeNull()
    expect(parseDshEventLine('{"ts":1,"type":"nope","payload":{}}')).toBeNull()
    expect(parseDshEventLine('{"ts":"1","type":"task/start","payload":{}}')).toBeNull()
    expect(parseDshEventLine('{"ts":1,"type":"task/start","payload":[]}')).toBeNull()
    expect(parseDshEventLine(undefined as unknown as string)).toBeNull()
    expect(parseDshEventLine(null as unknown as string)).toBeNull()
  })
})

describe('utf8ByteLength / isBridgeLineTooLong：64KB 行上限', () => {
  it('UTF-8 字节数计算覆盖 1/2/3/4 字节 code point', () => {
    expect(utf8ByteLength('')).toBe(0)
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('中')).toBe(3)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('aé中😀')).toBe(1 + 2 + 3 + 4)
  })

  it('边界：恰好 64KB 不算超长，多 1 字节算超长', () => {
    expect(isBridgeLineTooLong('a'.repeat(BRIDGE_MAX_LINE_BYTES))).toBe(false)
    expect(isBridgeLineTooLong('a'.repeat(BRIDGE_MAX_LINE_BYTES + 1))).toBe(true)
    expect(isBridgeLineTooLong('中'.repeat(21_845))).toBe(false) // 65535 字节
    expect(isBridgeLineTooLong('中'.repeat(21_846))).toBe(true) // 65538 字节
  })

  it('超长（多字节）合法 JSON 行被 parseDshEventLine 丢弃', () => {
    const pad = '中'.repeat(22_000) // ~66KB 多字节
    const line = JSON.stringify({ ts: 1, type: 'task/start', payload: { pad } })
    expect(utf8ByteLength(line)).toBeGreaterThan(BRIDGE_MAX_LINE_BYTES)
    expect(parseDshEventLine(line)).toBeNull()
  })

  it('未超长的有效 JSON 行正常解析', () => {
    const line = JSON.stringify({ ts: 1, type: 'task/start', payload: { pad: 'x'.repeat(1024) } })
    expect(parseDshEventLine(line)).toEqual({
      ts: 1,
      type: 'task/start',
      payload: { pad: 'x'.repeat(1024) }
    })
  })
})

describe('utf8ByteLength：与真实 UTF-8 编码字节数一致（含代理对边界，LOW-7）', () => {
  it('常见 / 边界 / 未配对代理项均与 Buffer.byteLength 一致', () => {
    const samples = [
      '',
      'abc',
      'é',
      '中',
      '😀',
      'aé中😀',
      '\uD800', // 未配对高位代理
      '\uDC00', // 未配对低位代理
      '中'.repeat(100),
      '😀'.repeat(50)
    ]
    for (const sample of samples) {
      expect(utf8ByteLength(sample), JSON.stringify(sample)).toBe(Buffer.byteLength(sample, 'utf8'))
    }
  })
})

/* ---------------------- Wave 3：control.json 生命周期控制帧 ---------------------- */

function makeControl(overrides: Partial<DshBridgeControlFile> = {}): DshBridgeControlFile {
  return { schemaVersion: 1, ts: 1_000_000, action: 'attached', dshPid: 12345, ...overrides }
}

describe('isDshBridgeControlFile：control.json 结构校验（Wave 3 冻结）', () => {
  it('合法帧（attached/detached、dshPid 可选）通过', () => {
    expect(isDshBridgeControlFile(makeControl())).toBe(true)
    expect(isDshBridgeControlFile(makeControl({ action: 'detached' }))).toBe(true)
    expect(isDshBridgeControlFile(makeControl({ dshPid: undefined }))).toBe(true)
  })

  it('schemaVersion 不匹配 / 缺字段 / action 非法 → 拒绝', () => {
    expect(isDshBridgeControlFile(makeControl({ schemaVersion: 2 }))).toBe(false)
    expect(isDshBridgeControlFile({ ts: 1, action: 'attached' })).toBe(false)
    expect(isDshBridgeControlFile(makeControl({ action: 'unknown' as never }))).toBe(false)
    expect(isDshBridgeControlFile(makeControl({ ts: Number.NaN }))).toBe(false)
    expect(isDshBridgeControlFile(null)).toBe(false)
    expect(isDshBridgeControlFile([])).toBe(false)
    expect(isDshBridgeControlFile('frame')).toBe(false)
  })

  it('dshPid 非法（0/负数/浮点/字符串）→ 拒绝', () => {
    expect(isDshBridgeControlFile(makeControl({ dshPid: 0 }))).toBe(false)
    expect(isDshBridgeControlFile(makeControl({ dshPid: -1 }))).toBe(false)
    expect(isDshBridgeControlFile(makeControl({ dshPid: 1.5 }))).toBe(false)
    expect(isDshBridgeControlFile(makeControl({ dshPid: '123' as never }))).toBe(false)
  })
})

describe('parseDshBridgeControlFile：脏输入一律 null、不抛异常', () => {
  it('合法 JSON 帧解析成功', () => {
    expect(parseDshBridgeControlFile(JSON.stringify(makeControl()))).toEqual(makeControl())
    expect(
      parseDshBridgeControlFile(JSON.stringify(makeControl({ action: 'detached', dshPid: 1 })))
    ).toEqual(makeControl({ action: 'detached', dshPid: 1 }))
  })

  it('空串 / 半行 / 非 JSON / 非对象 / 版本不符 / 超 4KB → null', () => {
    expect(parseDshBridgeControlFile('')).toBeNull()
    expect(parseDshBridgeControlFile('   ')).toBeNull()
    expect(parseDshBridgeControlFile('{"schemaVersion":1,"ts":1,"act')).toBeNull()
    expect(parseDshBridgeControlFile('null')).toBeNull()
    expect(parseDshBridgeControlFile('[]')).toBeNull()
    expect(parseDshBridgeControlFile('"attached"')).toBeNull()
    expect(
      parseDshBridgeControlFile(JSON.stringify(makeControl({ schemaVersion: 99 })))
    ).toBeNull()
    const huge = JSON.stringify({ ...makeControl(), pad: 'x'.repeat(BRIDGE_CONTROL_MAX_BYTES) })
    expect(parseDshBridgeControlFile(huge)).toBeNull()
  })

  it('非字符串输入返回 null（防御调用点传错类型）', () => {
    expect(parseDshBridgeControlFile(null)).toBeNull()
    expect(parseDshBridgeControlFile(undefined)).toBeNull()
    expect(parseDshBridgeControlFile(42)).toBeNull()
    expect(parseDshBridgeControlFile({})).toBeNull()
  })
})
