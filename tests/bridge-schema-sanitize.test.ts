/**
 * 单测：DSH 桥事件 payload 半白名单清洗（R-24，`src/shared/bridge-schema.ts`）。
 *
 * 覆盖 `sanitizeDshEventPayload()` 的白名单 / 截断 / 类型校验 / 未知键丢弃，
 * 以及 `parseDshEventLine()` 解析后应用清洗（读侧对桥文件零信任）。
 * 同时锁定 `isDshEvent` 语义不变（仍只校验 ts/type/payload 为普通对象）。
 */
import { describe, expect, it } from 'vitest'

import {
  DSH_EVENT_MESSAGE_MAX_CHARS,
  DSH_EVENT_PAYLOAD_KEYS,
  DSH_EVENT_STRING_MAX_CHARS,
  DSH_EVENT_TEXT_MAX_CHARS,
  isDshEvent,
  parseDshEventLine,
  sanitizeDshEventPayload
} from '@shared/bridge-schema'

/* --------------------------------- 白名单常量 --------------------------------- */

describe('R-24 payload 白名单常量', () => {
  it('恰好 11 个字段、顺序冻结、无重复（Wave 3 加 text）', () => {
    expect(DSH_EVENT_PAYLOAD_KEYS).toEqual([
      'agent',
      'status',
      'reason',
      'reasonKind',
      'turn',
      'step',
      'message',
      'text',
      'sessionId',
      'eventType',
      'seq'
    ])
    expect(new Set(DSH_EVENT_PAYLOAD_KEYS).size).toBe(11)
    expect(DSH_EVENT_MESSAGE_MAX_CHARS).toBe(512)
    expect(DSH_EVENT_TEXT_MAX_CHARS).toBe(8000)
    expect(DSH_EVENT_STRING_MAX_CHARS).toBe(256)
  })
})

/* --------------------------------- 清洗行为 --------------------------------- */

describe('R-24 sanitizeDshEventPayload：白名单 / 截断 / 类型', () => {
  it('全部合法标量原样保留', () => {
    const payload = {
      agent: 'agent-a',
      status: 'running',
      reason: 'disposed',
      reasonKind: 'error',
      turn: 2,
      step: 3,
      message: 'boom',
      text: 'assistant 回复正文',
      sessionId: 'session-1',
      eventType: 'turn/end',
      seq: 16
    }
    expect(sanitizeDshEventPayload(payload)).toEqual(payload)
  })

  it('未知键：结构化值（对象/数组/null）丢弃，JSON 标量保留（兼容历史夹具）', () => {
    const sanitized = sanitizeDshEventPayload({
      agent: 'agent-a',
      task: 'x', // 标量：保留（bridge-schema / dsh-watch 历史夹具依赖）
      data: { message: { content: '正文' } },
      toolCallId: 'call-1', // 标量：保留
      result: { content: '工具输出正文' },
      error: { message: 'secret' },
      nested: [[1, 2]],
      empty: null
    } as Record<string, unknown>)

    expect(sanitized).toEqual({
      agent: 'agent-a',
      task: 'x',
      toolCallId: 'call-1'
    })
    expect(sanitized).not.toHaveProperty('data')
    expect(sanitized).not.toHaveProperty('result')
    expect(sanitized).not.toHaveProperty('error')
    expect(sanitized).not.toHaveProperty('nested')
    expect(sanitized).not.toHaveProperty('empty')
  })

  it('原型污染危险键永远丢弃（__proto__ / prototype / constructor）', () => {
    // JSON.parse 会产生自有 `__proto__` 属性（不是原型赋值）。
    const payload = JSON.parse(
      '{"agent":"a","__proto__":{"polluted":true},"constructor":"x","prototype":"y"}'
    ) as Record<string, unknown>
    const sanitized = sanitizeDshEventPayload(payload)

    expect(sanitized).toEqual({ agent: 'a' })
    expect(Object.prototype.hasOwnProperty.call(sanitized, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('字符串超长截断：message ≤ 512、text ≤ 8000、其余 ≤ 256', () => {
    const sanitized = sanitizeDshEventPayload({
      message: 'm'.repeat(DSH_EVENT_MESSAGE_MAX_CHARS + 100),
      text: 't'.repeat(DSH_EVENT_TEXT_MAX_CHARS + 100),
      agent: 'a'.repeat(DSH_EVENT_STRING_MAX_CHARS + 100),
      sessionId: 's'.repeat(DSH_EVENT_STRING_MAX_CHARS + 1)
    })
    expect(sanitized['message']).toHaveLength(DSH_EVENT_MESSAGE_MAX_CHARS)
    expect(sanitized['text']).toHaveLength(DSH_EVENT_TEXT_MAX_CHARS)
    expect(sanitized['agent']).toHaveLength(DSH_EVENT_STRING_MAX_CHARS)
    expect(sanitized['sessionId']).toHaveLength(DSH_EVENT_STRING_MAX_CHARS)
    // 未超长的边界值不截断
    expect(
      sanitizeDshEventPayload({ message: 'm'.repeat(DSH_EVENT_MESSAGE_MAX_CHARS) })['message']
    ).toHaveLength(DSH_EVENT_MESSAGE_MAX_CHARS)
    expect(
      sanitizeDshEventPayload({ text: 't'.repeat(DSH_EVENT_TEXT_MAX_CHARS) })['text']
    ).toHaveLength(DSH_EVENT_TEXT_MAX_CHARS)
  })

  it('text 空串丢弃、正常 text 保留（气泡同步字段）', () => {
    expect(sanitizeDshEventPayload({ text: '', agent: 'a' })).toEqual({ agent: 'a' })
    expect(sanitizeDshEventPayload({ text: '好的，我来处理。', eventType: 'assistant/message' })).toEqual({
      text: '好的，我来处理。',
      eventType: 'assistant/message'
    })
  })

  it('空字符串丢弃，其余合法字符串保留', () => {
    expect(
      sanitizeDshEventPayload({ agent: '', status: 'running', message: '', text: '', sessionId: '' })
    ).toEqual({ status: 'running' })
  })

  it('turn/step/seq 只接受有限安全整数：浮点 / NaN / Infinity / 字符串 / null 丢弃', () => {
    const sanitized = sanitizeDshEventPayload({
      turn: 2,
      step: 3.5,
      seq: Number.NaN
    })
    expect(sanitized).toEqual({ turn: 2 })

    expect(sanitizeDshEventPayload({ turn: Number.POSITIVE_INFINITY })).toEqual({})
    expect(sanitizeDshEventPayload({ turn: Number.MAX_SAFE_INTEGER + 2 })).toEqual({})
    expect(sanitizeDshEventPayload({ turn: '2' })).toEqual({})
    expect(sanitizeDshEventPayload({ turn: null })).toEqual({})
    expect(sanitizeDshEventPayload({ turn: true })).toEqual({})
    expect(sanitizeDshEventPayload({ seq: -1, step: 0 })).toEqual({ seq: -1, step: 0 })
  })

  it('字符串字段收到非字符串类型时丢弃', () => {
    expect(
      sanitizeDshEventPayload({
        agent: 42,
        status: ['running'],
        message: { text: 'hi' },
        reasonKind: false,
        sessionId: null
      })
    ).toEqual({})
  })

  it('非普通对象输入 → {}（数组 / null / 字符串 / undefined）且不抛异常', () => {
    expect(sanitizeDshEventPayload(null as unknown as Record<string, unknown>)).toEqual({})
    expect(sanitizeDshEventPayload([] as unknown as Record<string, unknown>)).toEqual({})
    expect(sanitizeDshEventPayload('x' as unknown as Record<string, unknown>)).toEqual({})
    expect(sanitizeDshEventPayload(undefined as unknown as Record<string, unknown>)).toEqual({})
  })

  it('返回新对象，不修改入参', () => {
    const payload = { agent: 'agent-a', task: 'x' }
    const sanitized = sanitizeDshEventPayload(payload)
    expect(sanitized).not.toBe(payload)
    expect(payload).toEqual({ agent: 'agent-a', task: 'x' })
  })
})

/* ----------------------------- parse 时应用清洗 ----------------------------- */

describe('R-24 parseDshEventLine：解析成功后 payload 走白名单清洗', () => {
  it('插件真实形状（session/event 安全标量）原样保留', () => {
    const event = {
      ts: 123456,
      type: 'session/event',
      payload: {
        sessionId: 'session-1',
        eventType: 'assistant/message',
        seq: 9,
        turn: 1,
        step: 2,
        reasonKind: 'completed'
      }
    }
    expect(parseDshEventLine(JSON.stringify(event))).toEqual(event)
  })

  it('task/error 的 agent/turn/step/reasonKind/message 保留（renderer 消费字段兼容）', () => {
    const event = {
      ts: 1,
      type: 'task/error',
      payload: {
        agent: 'agent-1',
        turn: 1,
        step: 1,
        reasonKind: 'error',
        message: 'llm-deepseek: no API key for provider route'
      }
    }
    expect(parseDshEventLine(JSON.stringify(event))).toEqual(event)
  })

  it('未知键在 parse 阶段清洗：结构化值丢弃、标量保留、事件仍有效', () => {
    const line = JSON.stringify({
      ts: 1,
      type: 'task/start',
      payload: {
        agent: 'agent-a',
        status: 'running',
        data: { secret: '不该透传' },
        task: 'x'
      }
    })
    const parsed = parseDshEventLine(line)
    expect(parsed).not.toBeNull()
    // 结构化 `data` 被丢弃；历史标量字段 `task` 保留（既有契约测试依赖 payload 往返）。
    expect(parsed?.payload).toEqual({ agent: 'agent-a', status: 'running', task: 'x' })
  })

  it('超长 message 在 parse 阶段截断（不整行丢弃）', () => {
    const parsed = parseDshEventLine(
      JSON.stringify({
        ts: 1,
        type: 'task/error',
        payload: { agent: 'a', message: 'x'.repeat(2_000) }
      })
    )
    expect(typeof parsed?.payload['message']).toBe('string')
    expect((parsed?.payload['message'] as string).length).toBe(DSH_EVENT_MESSAGE_MAX_CHARS)
  })

  it('非法事件仍返回 null（isDshEvent 语义不变）', () => {
    expect(parseDshEventLine(JSON.stringify({ ts: 1, type: 'nope', payload: {} }))).toBeNull()
    expect(parseDshEventLine(JSON.stringify({ ts: 1, type: 'task/start', payload: [] }))).toBeNull()
    // isDshEvent 本身仍接受「payload 是任意普通对象」，白名单只在 parse 时应用。
    expect(isDshEvent({ ts: 1, type: 'task/start', payload: { task: 'x' } })).toBe(true)
  })

  it('清洗后的 payload 不再含结构化字段（含 >64KB 行仍按原契约丢弃）', () => {
    const huge = JSON.stringify({
      ts: 1,
      type: 'session/event',
      payload: { pad: 'x'.repeat(65 * 1024) }
    })
    expect(parseDshEventLine(huge)).toBeNull()

    const parsed = parseDshEventLine(
      JSON.stringify({
        ts: 1,
        type: 'session/event',
        payload: { pad: 'x', seq: 1, data: { nested: true } }
      })
    )
    expect(parsed?.payload).toEqual({ seq: 1, pad: 'x' })
    expect(parsed?.payload).not.toHaveProperty('data')
  })
})
