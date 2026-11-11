/**
 * `scripts/dsh-canary-lib.mjs` 的单测。
 *
 * 该库是 canary 的断言核心：它决定「DSH 更新后桥事件/文本/control 契约是否仍然匹配」。
 * 这里用真实 canary 产物样例（2026-11-09，DSH 0.2.2-rc.1）+ 手工破坏的变体 + Wave 3 v2
 * 成功回合/control 样例，覆盖每一类断言；并与 app 侧共享契约 `@shared/bridge-schema`
 * 做交叉校验，防止 canary 与 app 对同一份文件契约的理解漂移。
 */
import { describe, expect, it } from 'vitest'

import {
  DIAGNOSTIC_MESSAGE_MAX_CHARS,
  INSTALL_SCHEMA_VERSION,
  MAX_CONTROL_BYTES,
  MAX_DIAGNOSTIC_BYTES,
  MAX_EVENT_LINE_BYTES,
  MAX_INSTALL_BYTES,
  parseCompat,
  parseControlFile,
  parseDiagnostic,
  parseEventsFile,
  parseInstallManifest,
  parseStatusFile,
  validateCanaryArtifacts,
  validateCompatControlFrames,
  validateCompatStatus,
  validateControlArtifacts,
  validateDiagnostic,
  validateInstallManifest
} from '../scripts/dsh-canary-lib.mjs'
import { DSH_EVENT_TYPES } from '../bridge/dsh-aventurine-bridge/lib/constants.js'
import {
  BRIDGE_CONTROL_MAX_BYTES,
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_DIAGNOSTIC_MAX_BYTES,
  BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  BRIDGE_INSTALL_MAX_BYTES,
  BRIDGE_INSTALL_SCHEMA_VERSION,
  DSH_EVENT_TEXT_MAX_CHARS,
  isDshBridgeStatusFile,
  parseDshBridgeCompat,
  parseDshBridgeControlFile,
  parseDshBridgeDiagnostic,
  parseDshBridgeInstallManifest,
  parseDshEventLine
} from '@shared/bridge-schema'

/** 真实 canary 失败回合产物（字段值来自 2026-11-09 实跑）。 */
const REAL_STATUS = JSON.stringify({
  ts: 1794228889084,
  running: false,
  agents: 0,
  lastEventAt: 1794228889064,
  lastType: 'task/end',
  offline: true
})

const REAL_EVENTS = [
  JSON.stringify({
    ts: 1794228873776,
    type: 'task/start',
    payload: { agent: 'session-277ca679-9113-4959-b7f2-8a933cbf9be5', status: 'running' }
  }),
  JSON.stringify({
    ts: 1794228889063,
    type: 'task/error',
    payload: {
      agent: 'session-277ca679-9113-4959-b7f2-8a933cbf9be5',
      reasonKind: 'error',
      turn: 1,
      step: 1,
      message: 'DeepSeek Messages transport failed'
    }
  }),
  JSON.stringify({
    ts: 1794228889064,
    type: 'task/end',
    payload: { agent: 'session-277ca679-9113-4959-b7f2-8a933cbf9be5', status: 'idle' }
  })
].join('\n')

/** 便捷入口：跑一次校验并返回 errors。 */
function validate({ statusText = REAL_STATUS, eventsText = REAL_EVENTS, expectError = true } = {}) {
  return validateCanaryArtifacts({ statusText, eventsText, allowedTypes: DSH_EVENT_TYPES, expectError })
}

/** 从真实样例派生一个新 events 文本（每条事件是对象，便于改字段/顺序）。 */
function eventsWith(mutator) {
  const events = REAL_EVENTS.split('\n').map((line) => JSON.parse(line))
  mutator(events)
  return events.map((event) => JSON.stringify(event)).join('\n')
}

describe('parseStatusFile / parseEventsFile', () => {
  it('解析真实 canary 产物：status 为对象、events 逐行解析为 3 条', () => {
    const status = parseStatusFile(REAL_STATUS)
    expect(status.ok).toBe(true)
    if (status.ok) expect(status.status.offline).toBe(true)

    const events = parseEventsFile(REAL_EVENTS)
    expect(events.ok).toBe(true)
    if (events.ok) expect(events.events.map((event) => event.type)).toEqual(['task/start', 'task/error', 'task/end'])
  })

  it('非法 JSON / 非对象 / 超长行都返回结构化错误而不是抛异常', () => {
    expect(parseStatusFile('{oops').ok).toBe(false)
    expect(parseStatusFile('[]').ok).toBe(false)
    expect(parseEventsFile('{"ts":1,"type":"task/start"}\nnot-json').ok).toBe(false)

    const giant = JSON.stringify({ ts: 1, type: 'task/start', payload: { message: 'x'.repeat(MAX_EVENT_LINE_BYTES) } })
    const tooLarge = parseEventsFile(giant)
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) expect(tooLarge.error).toContain('上限')
  })
})

describe('validateCanaryArtifacts：通过路径', () => {
  it('真实失败回合产物通过全部断言（事件序列 + agent + 离线帧对齐）', () => {
    const result = validate()
    expect(result.errors).toEqual([])
    expect(result.summary.types).toEqual(['task/start', 'task/error', 'task/end'])
    expect(result.summary.agents).toEqual(['session-277ca679-9113-4959-b7f2-8a933cbf9be5'])
    expect(result.summary.lastType).toBe('task/end')
  })

  it('成功回合（无 task/error）在 expectError=false 时通过', () => {
    const eventsText = eventsWith((events) => {
      events.splice(1, 1) // 移除 task/error
    })
    const statusText = JSON.stringify({
      ts: 1794228889085,
      running: false,
      agents: 0,
      lastEventAt: 1794228889065,
      lastType: 'task/end',
      offline: true
    })
    const events = eventsText.split('\n').map((line) => JSON.parse(line))
    events.at(-1).ts = 1794228889065
    const text = events.map((event) => JSON.stringify(event)).join('\n')

    const result = validate({ statusText, eventsText: text, expectError: false })
    expect(result.errors).toEqual([])
    expect(result.summary.types).toEqual(['task/start', 'task/end'])
  })
})

describe('validateCanaryArtifacts：失败路径（每条断言都有独立防卫）', () => {
  it('缺少 task/error（DSH 失败信号没被映射）→ 报错', () => {
    const eventsText = eventsWith((events) => {
      events.splice(1, 1)
    })
    const result = validate({ eventsText })
    expect(result.errors.some((error) => error.includes('task/error'))).toBe(true)
  })

  it('离线帧不是 offline:true → 报错', () => {
    const result = validate({
      statusText: JSON.stringify({ ...JSON.parse(REAL_STATUS), offline: false })
    })
    expect(result.errors.some((error) => error.includes('offline'))).toBe(true)
  })

  it('status.lastType 不是 task/end → 报错', () => {
    const result = validate({
      statusText: JSON.stringify({ ...JSON.parse(REAL_STATUS), lastType: 'task/start' })
    })
    expect(result.errors.some((error) => error.includes('lastType'))).toBe(true)
  })

  it('事件顺序错误（end 在 error 之前）→ 报错', () => {
    const eventsText = eventsWith((events) => {
      const [start, error, end] = events
      events.splice(0, 3, start, end, error)
    })
    const result = validate({ eventsText })
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('未知事件类型（不在桥白名单）→ 报错', () => {
    const eventsText = eventsWith((events) => {
      events[0].type = 'agent/state'
    })
    const result = validate({ eventsText })
    expect(result.errors.some((error) => error.includes('白名单'))).toBe(true)
  })

  it('payload 不是对象 → 报错', () => {
    const eventsText = eventsWith((events) => {
      events[1].payload = 'not-an-object'
    })
    const result = validate({ eventsText })
    expect(result.errors.some((error) => error.includes('payload'))).toBe(true)
  })

  it('同一回合的 agent 不一致 → 报错', () => {
    const eventsText = eventsWith((events) => {
      events[2].payload.agent = 'session-other'
    })
    const result = validate({ eventsText })
    expect(result.errors.some((error) => error.includes('agent 不一致'))).toBe(true)
  })

  it('status.lastEventAt 与文件尾事件不对齐 → 报错', () => {
    const result = validate({
      statusText: JSON.stringify({ ...JSON.parse(REAL_STATUS), lastEventAt: 1794228889000 })
    })
    expect(result.errors.some((error) => error.includes('lastEventAt'))).toBe(true)
  })

  it('task/error.payload.reasonKind 不是 error → 报错', () => {
    const eventsText = eventsWith((events) => {
      events[1].payload.reasonKind = 'completed'
    })
    const result = validate({ eventsText })
    expect(result.errors.some((error) => error.includes('reasonKind'))).toBe(true)
  })

  it('task/error.message 超过 512 字符 → 报错（隐私/64KB 行上限约束）', () => {
    const eventsText = eventsWith((events) => {
      events[1].payload.message = 'x'.repeat(513)
    })
    const result = validate({ eventsText })
    expect(result.errors.some((error) => error.includes('message'))).toBe(true)
  })
})

describe('与 app 侧共享契约的交叉校验（canary 不能偏离 src/shared/bridge-schema.ts）', () => {
  it('真实 status.json 同时被 app 契约接受', () => {
    expect(isDshBridgeStatusFile(JSON.parse(REAL_STATUS))).toBe(true)
  })

  it('真实 events.jsonl 每一行都能被 app 契约解析', () => {
    for (const line of REAL_EVENTS.split('\n')) {
      expect(parseDshEventLine(line)).not.toBeNull()
    }
  })

  it('canary 校验接受的 events，app 契约也必须能解析（防止 canary 放宽到 app 不认识）', () => {
    const result = validate()
    expect(result.errors).toEqual([])
    for (const event of result.events) {
      expect(parseDshEventLine(JSON.stringify(event))).not.toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Wave 3 v2 fixtures：成功回合（assistant/message + text）与 control.json 生命周期。
// 形状来自 DSH 0.2.2-rc.1 实测（审计 §2.4/§2.6）：一步结束时 append 一条
// assistant/message，桥从 data.message.content 的 text 块提取 payload.text。
// ---------------------------------------------------------------------------

const SUCCESS_AGENT = 'session-canary-ok-0001'
const MOCK_ASSISTANT_TEXT = 'canary-mock: 桥文本透传 OK。'

/** 成功回合的桥事件序列：task/start → assistant/message(text) → turn/end → task/end。 */
function successEvents(text = MOCK_ASSISTANT_TEXT): Array<Record<string, unknown>> {
  return [
    { ts: 1794228889100, type: 'task/start', payload: { agent: SUCCESS_AGENT, status: 'running' } },
    {
      ts: 1794228889200,
      type: 'session/event',
      payload: {
        sessionId: SUCCESS_AGENT,
        eventType: 'assistant/message',
        seq: 15,
        turn: 1,
        step: 1,
        text
      }
    },
    {
      ts: 1794228889210,
      type: 'session/event',
      payload: {
        sessionId: SUCCESS_AGENT,
        eventType: 'turn/end',
        seq: 25,
        turn: 1,
        reasonKind: 'completed'
      }
    },
    { ts: 1794228889300, type: 'task/end', payload: { agent: SUCCESS_AGENT, status: 'idle' } }
  ]
}

function successEventsText(events = successEvents()): string {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

const SUCCESS_STATUS = JSON.stringify({
  ts: 1794228889400,
  running: false,
  agents: 0,
  lastEventAt: 1794228889300,
  lastType: 'task/end',
  offline: true
})

const ATTACHED_CONTROL = JSON.stringify({
  schemaVersion: 1,
  ts: 1794228889000,
  action: 'attached',
  dshPid: 4321
})

const DETACHED_CONTROL = JSON.stringify({
  schemaVersion: 1,
  ts: 1794228889500,
  action: 'detached',
  dshPid: 4321
})

describe('parseControlFile：control.json 形状解析（脏输入绝不抛）', () => {
  it('解析真实 attached/detached 帧：schemaVersion/ts/action/dshPid 都合法', () => {
    const attached = parseControlFile(ATTACHED_CONTROL)
    expect(attached.ok).toBe(true)
    if (attached.ok) {
      expect(attached.control.action).toBe('attached')
      expect(attached.control.schemaVersion).toBe(1)
      expect(attached.control.dshPid).toBe(4321)
    }

    const detached = parseControlFile(DETACHED_CONTROL)
    expect(detached.ok).toBe(true)
    if (detached.ok) expect(detached.control.action).toBe('detached')
  })

  it('非字符串 / 非 JSON / 非对象 / 超长 → 结构化错误而不是抛异常', () => {
    const cases: unknown[] = [
      null,
      undefined,
      42,
      '',
      '{oops',
      '[]',
      '"attached"',
      'x'.repeat(MAX_CONTROL_BYTES + 1)
    ]
    for (const input of cases) {
      const result = parseControlFile(input)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
    }
  })

  it('schemaVersion / ts / action / dshPid 脏字段各自返回错误', () => {
    const base = JSON.parse(DETACHED_CONTROL) as Record<string, unknown>
    const variants: Array<Record<string, unknown>> = [
      { ...base, schemaVersion: 0 },
      { ...base, schemaVersion: 1.5 },
      { ...base, schemaVersion: '1' },
      { ...base, ts: -1 },
      { ...base, ts: 'now' },
      { ...base, action: 'online' },
      { ...base, action: undefined },
      { ...base, dshPid: 0 },
      { ...base, dshPid: -3 },
      { ...base, dshPid: 1.25 }
    ]
    for (const variant of variants) {
      expect(parseControlFile(JSON.stringify(variant)).ok).toBe(false)
    }
    // dshPid 可选：缺失仍合法。
    const noPid = { ...base }
    delete noPid.dshPid
    expect(parseControlFile(JSON.stringify(noPid)).ok).toBe(true)
  })

  it('canary 的 control 上限/版本常量与共享契约一致', () => {
    expect(MAX_CONTROL_BYTES).toBe(BRIDGE_CONTROL_MAX_BYTES)
    expect(JSON.parse(DETACHED_CONTROL).schemaVersion).toBe(BRIDGE_CONTROL_SCHEMA_VERSION)
  })
})

describe('validateControlArtifacts：attached → detached 生命周期断言', () => {
  it('最终 detached + 观察到 attached→detached：全部通过', () => {
    const result = validateControlArtifacts({
      controlText: DETACHED_CONTROL,
      observedActions: ['attached', 'detached'],
      expectedSchemaVersion: BRIDGE_CONTROL_SCHEMA_VERSION
    })
    expect(result.errors).toEqual([])
    expect(result.control?.action).toBe('detached')
    expect(result.observedActions).toEqual(['attached', 'detached'])
  })

  it('缺少 attached（未观察到 apply）/ 缺少 detached（未观察到 dispose）→ 报错', () => {
    expect(
      validateControlArtifacts({ controlText: DETACHED_CONTROL, observedActions: ['detached'] }).errors.some(
        (error) => error.includes('attached')
      )
    ).toBe(true)
    expect(
      validateControlArtifacts({ controlText: DETACHED_CONTROL, observedActions: [] }).errors.some(
        (error) => error.includes('detached')
      )
    ).toBe(true)
  })

  it('生命周期顺序错误（detached 早于 attached）→ 报错', () => {
    const result = validateControlArtifacts({
      controlText: DETACHED_CONTROL,
      observedActions: ['detached', 'attached', 'detached']
    })
    expect(result.errors.some((error) => error.includes('顺序错误'))).toBe(true)
  })

  it('最终帧仍是 attached（SIGKILL/崩溃未跑 disposer）→ 报错', () => {
    const result = validateControlArtifacts({
      controlText: ATTACHED_CONTROL,
      observedActions: ['attached']
    })
    expect(result.errors.some((error) => error.includes("'detached'"))).toBe(true)
  })

  it('schemaVersion 与共享契约不一致 → 报错', () => {
    const mismatched = JSON.stringify({ ...JSON.parse(DETACHED_CONTROL), schemaVersion: 2 })
    const result = validateControlArtifacts({
      controlText: mismatched,
      observedActions: ['attached', 'detached'],
      expectedSchemaVersion: 1
    })
    expect(result.errors.some((error) => error.includes('schemaVersion'))).toBe(true)
  })

  it('最后观察到的不是 detached → 报错；control 缺失 → 报错但不抛', () => {
    expect(
      validateControlArtifacts({
        controlText: DETACHED_CONTROL,
        observedActions: ['attached', 'detached', 'attached']
      }).errors.some((error) => error.includes('最后观察到'))
    ).toBe(true)
    expect(() => validateControlArtifacts({ controlText: null })).not.toThrow()
    expect(validateControlArtifacts({ controlText: null }).errors.length).toBeGreaterThan(0)
  })
})

describe('validateCanaryArtifacts：v2 成功回合 assistant 文本断言', () => {
  it('成功回合带 text：requireAssistantText + expectedText 精确匹配通过', () => {
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: successEventsText(),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true,
      expectedText: MOCK_ASSISTANT_TEXT,
      maxTextChars: DSH_EVENT_TEXT_MAX_CHARS
    })
    expect(result.errors).toEqual([])
    expect(result.summary.types).toEqual(['task/start', 'session/event', 'session/event', 'task/end'])
    expect(result.summary.texts).toEqual([MOCK_ASSISTANT_TEXT])
  })

  it('缺少 assistant/message → 报错（文本没透传）', () => {
    const events = successEvents().filter(
      (event) => (event.payload as Record<string, unknown>).eventType !== 'assistant/message'
    )
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: events.map((event) => JSON.stringify(event)).join('\n'),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true
    })
    expect(result.errors.some((error) => error.includes('assistant/message'))).toBe(true)
  })

  it('assistant/message 存在但没有 text → 报错（提取失效）', () => {
    const events = successEvents()
    delete (events[1].payload as Record<string, unknown>).text
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: events.map((event) => JSON.stringify(event)).join('\n'),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true
    })
    expect(result.errors.some((error) => error.includes('payload.text'))).toBe(true)
  })

  it('expectedText 与 mock 注入文本不一致 → 报错', () => {
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: successEventsText(),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true,
      expectedText: '别的文本'
    })
    expect(result.errors.some((error) => error.includes('不一致'))).toBe(true)
  })

  it('text 超过 maxTextChars 上限 → 报错', () => {
    const longText = 'y'.repeat(DSH_EVENT_TEXT_MAX_CHARS + 1)
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: successEventsText(successEvents(longText)),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true,
      maxTextChars: DSH_EVENT_TEXT_MAX_CHARS
    })
    expect(result.errors.some((error) => error.includes('上限'))).toBe(true)
  })

  it('隐私断言：forbiddenSubstrings（user 输入 / reasoning 哨兵）出现在 events 原文 → 报错', () => {
    const events = successEvents('回答里混进了 user-input-sentinel')
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: successEventsText(events),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true,
      forbiddenSubstrings: ['user-input-sentinel']
    })
    expect(result.errors.some((error) => error.includes('隐私文本'))).toBe(true)
  })

  it('向后兼容：不传 v2 可选参数时行为与旧版一致（失败回合样例仍通过）', () => {
    const result = validate()
    expect(result.errors).toEqual([])
    expect(result.summary.texts).toEqual([])
  })
})

describe('v2 成功回合产物与 app 侧共享契约交叉校验', () => {
  it('成功回合 status/events 每行都被 app 契约接受，且 payload.text 保留（≤8000）', () => {
    expect(isDshBridgeStatusFile(JSON.parse(SUCCESS_STATUS))).toBe(true)
    for (const line of successEventsText().split('\n')) {
      const event = parseDshEventLine(line)
      expect(event).not.toBeNull()
      if (event !== null && event.payload.eventType === 'assistant/message') {
        expect(event.payload.text).toBe(MOCK_ASSISTANT_TEXT)
      }
    }
  })

  it('canary 接受的成功回合 events，app 契约也必须能解析（含 text 字段）', () => {
    const result = validateCanaryArtifacts({
      statusText: SUCCESS_STATUS,
      eventsText: successEventsText(),
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true,
      expectedText: MOCK_ASSISTANT_TEXT,
      maxTextChars: DSH_EVENT_TEXT_MAX_CHARS
    })
    expect(result.errors).toEqual([])
    for (const event of result.events) {
      expect(parseDshEventLine(JSON.stringify(event))).not.toBeNull()
    }
  })

  it('canary 接受的 control 帧，app 契约也必须能解析（同一 schema）', () => {
    const result = validateControlArtifacts({
      controlText: DETACHED_CONTROL,
      observedActions: ['attached', 'detached'],
      expectedSchemaVersion: BRIDGE_CONTROL_SCHEMA_VERSION
    })
    expect(result.errors).toEqual([])
    expect(parseDshBridgeControlFile(DETACHED_CONTROL)).not.toBeNull()
    expect(parseDshBridgeControlFile(ATTACHED_CONTROL)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// v4 兼容性契约（计划 §3.2/§3.3/§3.4、§5.1 C3/C6）：compat / install.json / bridge-error.json。
// canary 侧校验器必须与 app 侧共享契约 `@shared/bridge-schema` 语义一致（独立实现 + 交叉校验）。
// ---------------------------------------------------------------------------

/** 计划 §3.3 的安装清单样例（字段值与真实激活脚本写入一致）。 */
const IMAGE_INSTALL_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  installedAt: 1794371618741,
  installMethod: 'live-copy-insert',
  bridgeEntry: '/repo/work/live-bridge/rev-1794371618691/lib/index.js',
  bridgePackageName: 'dsh-aventurine-bridge',
  bridgePackageVersion: '0.2.0',
  bridgeVersion: 4,
  controlSchema: 1,
  dshRange: '>=0.2.2-rc.1 <0.3.0',
  dshVersionAtInstall: '0.2.2-rc.1',
  petAppPath: '/repo/dist/mac-arm64/AventurinePet.app',
  petBundleId: 'com.aventurine.pet'
})

/** 计划 §3.4 的桥故障诊断样例。 */
const REAL_DIAGNOSTIC = JSON.stringify({
  schemaVersion: 1,
  ts: 1794376241734,
  phase: 'apply',
  message: 'Error: bridge dir not writable: /tmp/bridge (EACCES)',
  bridgeVersion: 4,
  dshRange: '>=0.2.2-rc.1 <0.3.0'
})

/** attached 帧（v4：顶层 bridgeVersion + compat）。 */
const V4_ATTACHED_CONTROL = JSON.stringify({
  schemaVersion: 1,
  ts: 1794376241734,
  action: 'attached',
  dshPid: 98123,
  bridgeVersion: 4,
  compat: { bridgeVersion: 4, controlSchema: 1, dshRange: '>=0.2.2-rc.1 <0.3.0' }
})

const V4_DETACHED_CONTROL = JSON.stringify({
  ...JSON.parse(V4_ATTACHED_CONTROL),
  ts: 1794376242734,
  action: 'detached'
})

/** v4 status 心跳/离线帧（含 compat）。 */
const V4_STATUS = JSON.stringify({
  ts: 1794376242734,
  running: false,
  agents: 0,
  lastEventAt: 1794376242000,
  lastType: 'task/end',
  offline: true,
  compat: { bridgeVersion: 4, controlSchema: 1, dshRange: '>=0.2.2-rc.1 <0.3.0' }
})

describe('canary 侧 v4 常量与共享契约一致', () => {
  it('字节上限 / schema 版本 / 诊断 message 上限都来自同一契约', () => {
    expect(MAX_INSTALL_BYTES).toBe(BRIDGE_INSTALL_MAX_BYTES)
    expect(MAX_DIAGNOSTIC_BYTES).toBe(BRIDGE_DIAGNOSTIC_MAX_BYTES)
    expect(INSTALL_SCHEMA_VERSION).toBe(BRIDGE_INSTALL_SCHEMA_VERSION)
    expect(DIAGNOSTIC_MESSAGE_MAX_CHARS).toBe(BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS)
  })
})

describe('parseCompat：与共享契约 parseDshBridgeCompat 交叉校验', () => {
  const cases: unknown[] = [
    { bridgeVersion: 4, controlSchema: 1, dshRange: '>=0.2.2-rc.1 <0.3.0' },
    { bridgeVersion: 4, controlSchema: 1, dshRange: null },
    { bridgeVersion: 4, controlSchema: 1 },
    { bridgeVersion: 4, controlSchema: 1, dshRange: '   ' },
    { bridgeVersion: 0, controlSchema: 1, dshRange: '>=0.2.2' },
    { bridgeVersion: 1.5, controlSchema: 1, dshRange: '>=0.2.2' },
    { bridgeVersion: '4', controlSchema: 1, dshRange: '>=0.2.2' },
    { bridgeVersion: 4, controlSchema: 0, dshRange: '>=0.2.2' },
    { bridgeVersion: 4, controlSchema: 1, dshRange: 42 },
    null,
    [],
    'compat'
  ]
  it.each(cases)('输入 %j 时两侧结果一致', (value) => {
    expect(parseCompat(value)).toEqual(parseDshBridgeCompat(value))
  })
})

describe('parseInstallManifest：与共享契约 parseDshBridgeInstallManifest 交叉校验', () => {
  const variants: Array<[string, unknown]> = [
    ['计划样例', JSON.parse(IMAGE_INSTALL_MANIFEST)],
    ['installMethod 非法 → unknown', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), installMethod: 'weird' }],
    ['可选字段全缺', (() => {
      const base = JSON.parse(IMAGE_INSTALL_MANIFEST)
      delete base.dshVersionAtInstall
      delete base.petAppPath
      delete base.petBundleId
      return base
    })()],
    ['dshRange 缺失 → null', (() => {
      const base = JSON.parse(IMAGE_INSTALL_MANIFEST)
      delete base.dshRange
      return base
    })()],
    ['schemaVersion 不对', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), schemaVersion: 2 }],
    ['installedAt 负数', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), installedAt: -1 }],
    ['缺 bridgeEntry', (() => {
      const base = JSON.parse(IMAGE_INSTALL_MANIFEST)
      delete base.bridgeEntry
      return base
    })()],
    ['bridgeVersion 字符串', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), bridgeVersion: '4' }],
    ['controlSchema 为 0', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), controlSchema: 0 }],
    ['dshRange 非字符串', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), dshRange: 42 }],
    ['可选字段脏值 → null', { ...JSON.parse(IMAGE_INSTALL_MANIFEST), petAppPath: '   ', petBundleId: 7 }]
  ]
  it.each(variants)('%s：两个解析器结果一致', (_label, value) => {
    const text = JSON.stringify(value)
    expect(parseInstallManifest(text)).toEqual(parseDshBridgeInstallManifest(text))
  })

  it('非法 JSON / 非对象 / 超大文本 → 两侧都返回 null', () => {
    const cases = ['{oops', '[]', '"x"', null, 42, 'x'.repeat(MAX_INSTALL_BYTES + 1)]
    for (const text of cases) {
      expect(parseInstallManifest(text)).toBeNull()
      expect(parseDshBridgeInstallManifest(text)).toBeNull()
    }
  })

  it('计划样例被解析出全部字段（activation 写清单的形状基线）', () => {
    const manifest = parseInstallManifest(IMAGE_INSTALL_MANIFEST)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      installMethod: 'live-copy-insert',
      bridgePackageName: 'dsh-aventurine-bridge',
      bridgeVersion: 4,
      controlSchema: 1,
      dshRange: '>=0.2.2-rc.1 <0.3.0',
      dshVersionAtInstall: '0.2.2-rc.1',
      petBundleId: 'com.aventurine.pet'
    })
  })
})

describe('validateInstallManifest：激活脚本自检 / 桌宠静态判定证据', () => {
  it('合法清单通过，期望值匹配时没有错误', () => {
    const result = validateInstallManifest(IMAGE_INSTALL_MANIFEST, {
      expectedBridgeEntry: '/repo/work/live-bridge/rev-1794371618691/lib/index.js',
      expectedBridgeVersion: 4,
      expectedControlSchema: 1,
      expectedDshRange: '>=0.2.2-rc.1 <0.3.0',
      expectedPetAppPath: '/repo/dist/mac-arm64/AventurinePet.app',
      expectedInstallMethod: 'live-copy-insert'
    })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('字段不匹配/坏清单 → 结构化错误而不抛异常', () => {
    const mismatched = validateInstallManifest(IMAGE_INSTALL_MANIFEST, {
      expectedBridgeVersion: 3,
      expectedDshRange: '<0.2.0',
      expectedBridgeEntry: '/other/index.js'
    })
    expect(mismatched.ok).toBe(false)
    expect(mismatched.errors.length).toBeGreaterThanOrEqual(3)

    expect(() => validateInstallManifest('{bad')).not.toThrow()
    expect(validateInstallManifest('{bad').errors.length).toBeGreaterThan(0)
    expect(validateInstallManifest(null).ok).toBe(false)
  })
})

describe('parseDiagnostic：与共享契约 parseDshBridgeDiagnostic 交叉校验', () => {
  const variants: Array<[string, unknown]> = [
    ['计划样例', JSON.parse(REAL_DIAGNOSTIC)],
    ['可选字段缺失', { schemaVersion: 1, ts: 1, phase: 'apply', message: 'boom' }],
    ['schemaVersion 不对', { ...JSON.parse(REAL_DIAGNOSTIC), schemaVersion: 0 }],
    ['phase 空串', { ...JSON.parse(REAL_DIAGNOSTIC), phase: '  ' }],
    ['message 缺失', (() => {
      const base = JSON.parse(REAL_DIAGNOSTIC)
      delete base.message
      return base
    })()],
    ['bridgeVersion 字符串', { ...JSON.parse(REAL_DIAGNOSTIC), bridgeVersion: '4' }],
    ['dshRange 非字符串', { ...JSON.parse(REAL_DIAGNOSTIC), dshRange: 7 }],
    ['message 超长 → 截断', { ...JSON.parse(REAL_DIAGNOSTIC), message: 'x'.repeat(2000) }]
  ]
  it.each(variants)('%s：两个解析器结果一致（含 1024 字符截断）', (_label, value) => {
    const text = JSON.stringify(value)
    expect(parseDiagnostic(text)).toEqual(parseDshBridgeDiagnostic(text))
  })

  it('非法 JSON / 超大文本 → 两侧都返回 null', () => {
    for (const text of ['nope', '[]', 'x'.repeat(MAX_DIAGNOSTIC_BYTES + 1)]) {
      expect(parseDiagnostic(text)).toBeNull()
      expect(parseDshBridgeDiagnostic(text)).toBeNull()
    }
  })
})

describe('validateDiagnostic：C6 桥 apply 失败诊断断言', () => {
  it('合法诊断 + 期望 phase/version/range 匹配 → 通过', () => {
    const result = validateDiagnostic(REAL_DIAGNOSTIC, {
      expectedPhase: 'apply',
      expectedBridgeVersion: 4,
      expectedDshRange: '>=0.2.2-rc.1 <0.3.0'
    })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.diagnostic?.message).toContain('not writable')
  })

  it('缺文件 / phase 不对 / version 不对 → 报错但不抛', () => {
    expect(validateDiagnostic(null).ok).toBe(false)
    expect(validateDiagnostic(REAL_DIAGNOSTIC, { expectedPhase: 'heartbeat' }).ok).toBe(false)
    expect(validateDiagnostic(REAL_DIAGNOSTIC, { expectedBridgeVersion: 3 }).ok).toBe(false)
    expect(() => validateDiagnostic(undefined)).not.toThrow()
  })
})

describe('v4 control/status compat 帧解析', () => {
  it('带 compat 的 control 帧：canary 与共享契约都接受；compat 原样保留', () => {
    const parsed = parseControlFile(V4_ATTACHED_CONTROL)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.control.bridgeVersion).toBe(4)
      expect(parseCompat(parsed.control.compat)).toEqual({
        bridgeVersion: 4,
        controlSchema: 1,
        dshRange: '>=0.2.2-rc.1 <0.3.0'
      })
    }
    expect(parseDshBridgeControlFile(V4_ATTACHED_CONTROL)).not.toBeNull()
  })

  it('compat 形状非法 → 整帧无效（canary 与共享契约同规则）', () => {
    const badCompat = JSON.stringify({
      ...JSON.parse(V4_ATTACHED_CONTROL),
      compat: { bridgeVersion: 4, controlSchema: 1, dshRange: 42 }
    })
    expect(parseControlFile(badCompat).ok).toBe(false)
    expect(parseDshBridgeControlFile(badCompat)).toBeNull()

    const missingCompatField = JSON.stringify({
      ...JSON.parse(V4_ATTACHED_CONTROL),
      compat: { bridgeVersion: 4 }
    })
    expect(parseControlFile(missingCompatField).ok).toBe(false)
    expect(parseDshBridgeControlFile(missingCompatField)).toBeNull()
  })
})

describe('validateCompatControlFrames：C3 attached + bridgeVersion=4 + compat.dshRange', () => {
  const attachedFrame = JSON.parse(V4_ATTACHED_CONTROL) as Record<string, unknown>
  const detachedFrame = JSON.parse(V4_DETACHED_CONTROL) as Record<string, unknown>

  it('attached→detached + compat 正确 → 无错误', () => {
    const result = validateCompatControlFrames({
      frames: [attachedFrame, detachedFrame],
      expectedBridgeVersion: 4,
      expectedControlSchema: 1,
      expectedDshRange: '>=0.2.2-rc.1 <0.3.0'
    })
    expect(result.errors).toEqual([])
    expect(result.attached).toBe(attachedFrame)
    expect(result.compat?.dshRange).toBe('>=0.2.2-rc.1 <0.3.0')
  })

  it('v3 帧（无 compat）在 requireCompat 时报错；降级 requireCompat=false 时只缺 compat 不报', () => {
    const v3Attached = { schemaVersion: 1, ts: 1, action: 'attached', dshPid: 1, bridgeVersion: 3 }
    const strict = validateCompatControlFrames({ frames: [v3Attached, detachedFrame] })
    expect(strict.errors.some((error: string) => error.includes('compat'))).toBe(true)

    const tolerant = validateCompatControlFrames({
      frames: [v3Attached, detachedFrame],
      requireCompat: false,
      expectedBridgeVersion: 3
    })
    expect(tolerant.errors).toEqual([])
  })

  it('compat.dshRange / bridgeVersion / controlSchema 不符 → 各自报错', () => {
    const result = validateCompatControlFrames({
      frames: [attachedFrame, detachedFrame],
      expectedBridgeVersion: 4,
      expectedControlSchema: 1,
      expectedDshRange: '<0.2.0'
    })
    expect(result.errors.some((error: string) => error.includes('dshRange'))).toBe(true)

    const wrongVersion = validateCompatControlFrames({
      frames: [attachedFrame, detachedFrame],
      expectedBridgeVersion: 5
    })
    expect(wrongVersion.errors.some((error: string) => error.includes('bridgeVersion'))).toBe(true)
  })

  it('缺少 attached / 最后不是 detached / 帧形状坏 → 报错', () => {
    expect(validateCompatControlFrames({ frames: [detachedFrame] }).errors.length).toBeGreaterThan(0)
    expect(
      validateCompatControlFrames({
        frames: [attachedFrame],
        expectedBridgeVersion: 4,
        expectedDshRange: '>=0.2.2-rc.1 <0.3.0'
      }).errors.some((error: string) => error.includes('最后观察'))
    ).toBe(true)
    expect(validateCompatControlFrames({ frames: [{ action: 'attached' }] }).errors.length).toBeGreaterThan(0)
    expect(() => validateCompatControlFrames({} as never)).not.toThrow()
  })
})

describe('validateCompatStatus：C3 status 心跳带 compat', () => {
  it('v4 离线心跳帧（offline + compat）通过', () => {
    const result = validateCompatStatus({
      statusText: V4_STATUS,
      expectedBridgeVersion: 4,
      expectedControlSchema: 1,
      expectedDshRange: '>=0.2.2-rc.1 <0.3.0'
    })
    expect(result.errors).toEqual([])
    expect(result.compat?.dshRange).toBe('>=0.2.2-rc.1 <0.3.0')
  })

  it('v3 心跳（无 compat）/ 缺 status / compat 值不符 → 报错', () => {
    const v3Status = JSON.stringify({
      ts: 1,
      running: false,
      agents: 0,
      lastEventAt: 0,
      lastType: null,
      offline: true
    })
    expect(validateCompatStatus({ statusText: v3Status }).errors.some((error: string) => error.includes('compat'))).toBe(true)
    expect(validateCompatStatus({ statusText: null }).errors.length).toBeGreaterThan(0)
    expect(
      validateCompatStatus({ statusText: V4_STATUS, expectedDshRange: '<0.2.0' }).errors.some((error: string) =>
        error.includes('dshRange')
      )
    ).toBe(true)
  })
})
