/**
 * 单测：窥屏闸门 `evaluatePeekGate`（`src/shared/peek.ts`，Wave 3 A7 接口预留）。
 *
 * 覆盖验收点：
 * - 默认关闭：`PEEK_DEFAULT_STATUS` → `disabled`；
 * - fail-closed：脏请求 / 脏状态 / 非法 now → `invalid-request` 且绝不抛异常；
 * - 未授权 / 能力缺失 / 敏感应用 / 节流 → deny + 对应 reason；
 * - 全绿时放行，且 capability → tier 映射正确；
 * - 契约形状（capability/权限/拒绝原因/默认状态）冻结，改契约必须走 Lead 评审。
 */
import { describe, expect, it } from 'vitest'

import {
  PEEK_CAPABILITIES,
  PEEK_CAPABILITY_TIER,
  PEEK_DEFAULT_STATUS,
  PEEK_DEFAULT_THROTTLE,
  PEEK_DENY_REASONS,
  PEEK_PERMISSION_STATES,
  PEEK_TIERS,
  evaluatePeekGate,
  isPeekCapability,
  isPeekDenyReason,
  isPeekObservationTrigger,
  isPeekPermissionState,
  isPeekTier,
  type PeekCapabilityStatus,
  type PeekObservationRequest,
  type PeekStatus
} from '@shared/peek'

/* --------------------------------- 夹具 ---------------------------------- */

const AVAILABLE_CAPABILITIES: readonly PeekCapabilityStatus[] = PEEK_CAPABILITIES.map(
  (capability) => ({ capability, available: true, reason: null })
)

/** 合法状态（全绿）；用例按需覆盖字段。 */
function makeStatus(overrides: Partial<PeekStatus> = {}): PeekStatus {
  return {
    enabled: true,
    tier: 'metadata',
    permission: 'granted',
    capabilities: AVAILABLE_CAPABILITIES,
    provider: { id: 'test-provider', version: '1.0.0' },
    sensitiveApps: ['1Password', 'Bitwarden', '银行'],
    throttle: { minGapMs: 10_000, maxPerHour: 3 },
    lastObservationAtMs: null,
    observationsLastHour: 0,
    notImplemented: false,
    ...overrides
  }
}

/** 合法请求；用例按需覆盖字段。 */
function makeRequest(overrides: Partial<PeekObservationRequest> = {}): PeekObservationRequest {
  return {
    trigger: 'manual',
    capability: 'screen.peek.metadata',
    requestedAtMs: 1_000,
    foregroundApp: 'Finder',
    ...overrides
  }
}

const DEFAULT_REQUEST: PeekObservationRequest = makeRequest()

/* ------------------------------ 契约形状冻结 ------------------------------ */

describe('契约形状（capability / 档位 / 权限 / 拒绝原因）', () => {
  it('capability 列表与顺序冻结（按 R4 简化后的 3 个能力）', () => {
    expect(PEEK_CAPABILITIES).toEqual([
      'screen.peek.metadata',
      'screen.peek.ocr',
      'screen.peek.vision'
    ])
  })

  it('档位列表冻结（off 在最低位）', () => {
    expect(PEEK_TIERS).toEqual(['off', 'metadata', 'ocr', 'vision'])
  })

  it('权限状态冻结（含平台真实取值，不猜测未知）', () => {
    expect(PEEK_PERMISSION_STATES).toEqual([
      'granted',
      'denied',
      'not-determined',
      'restricted',
      'unsupported',
      'unknown'
    ])
  })

  it('拒绝原因冻结（7 种：默认关闭/fail-closed 出口）', () => {
    expect(PEEK_DENY_REASONS).toEqual([
      'disabled',
      'not-implemented',
      'permission-not-granted',
      'capability-unavailable',
      'sensitive-app',
      'throttled',
      'invalid-request'
    ])
  })

  it('capability → tier 映射冻结', () => {
    expect(PEEK_CAPABILITY_TIER).toEqual({
      'screen.peek.metadata': 'metadata',
      'screen.peek.ocr': 'ocr',
      'screen.peek.vision': 'vision'
    })
  })

  it('默认状态：关闭 + 全部 capability 不可用 + notImplemented', () => {
    expect(PEEK_DEFAULT_STATUS.enabled).toBe(false)
    expect(PEEK_DEFAULT_STATUS.tier).toBe('off')
    expect(PEEK_DEFAULT_STATUS.permission).toBe('not-determined')
    expect(PEEK_DEFAULT_STATUS.notImplemented).toBe(true)
    expect(PEEK_DEFAULT_STATUS.provider).toBeNull()
    expect(PEEK_DEFAULT_STATUS.capabilities).toHaveLength(PEEK_CAPABILITIES.length)
    for (const status of PEEK_DEFAULT_STATUS.capabilities) {
      expect(status.available).toBe(false)
      expect(status.reason).toBe('not-implemented')
    }
    expect(PEEK_DEFAULT_STATUS.throttle).toEqual(PEEK_DEFAULT_THROTTLE)
    expect(PEEK_DEFAULT_THROTTLE).toEqual({ minGapMs: 600_000, maxPerHour: 3 })
  })

  it('默认状态深冻结（调用方不能篡改共享常量）', () => {
    expect(Object.isFrozen(PEEK_DEFAULT_STATUS)).toBe(true)
    expect(Object.isFrozen(PEEK_DEFAULT_STATUS.capabilities)).toBe(true)
    expect(Object.isFrozen(PEEK_DEFAULT_STATUS.sensitiveApps)).toBe(true)
    expect(Object.isFrozen(PEEK_DEFAULT_STATUS.throttle)).toBe(true)
  })

  it('类型守卫接受合法值、拒绝非法值', () => {
    expect(isPeekCapability('screen.peek.ocr')).toBe(true)
    expect(isPeekCapability('screen.peek.audio')).toBe(false)
    expect(isPeekTier('vision')).toBe(true)
    expect(isPeekTier('ambient')).toBe(false)
    expect(isPeekPermissionState('restricted')).toBe(true)
    expect(isPeekPermissionState('maybe')).toBe(false)
    expect(isPeekDenyReason('throttled')).toBe(true)
    expect(isPeekDenyReason('nope')).toBe(false)
    expect(isPeekObservationTrigger('dsh')).toBe(true)
    expect(isPeekObservationTrigger('timer')).toBe(false)
  })
})

/* -------------------------------- 默认关闭 -------------------------------- */

describe('默认关闭（接口层红线）', () => {
  it('PEEK_DEFAULT_STATUS 下任何请求都 disabled', () => {
    expect(evaluatePeekGate(DEFAULT_REQUEST, PEEK_DEFAULT_STATUS, 1_000)).toEqual({
      ok: false,
      reason: 'disabled'
    })
  })

  it('即使权限/能力全绿，enabled=false 仍然 disabled', () => {
    const status = makeStatus({
      enabled: false,
      permission: 'granted',
      capabilities: AVAILABLE_CAPABILITIES
    })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000)).toEqual({
      ok: false,
      reason: 'disabled'
    })
  })

  it('档位 off 也按 disabled 处理', () => {
    expect(
      evaluatePeekGate(DEFAULT_REQUEST, makeStatus({ tier: 'off' }), 1_000)
    ).toEqual({ ok: false, reason: 'disabled' })
  })
})

/* ------------------------------ fail-closed 链路 --------------------------- */

describe('fail-closed 阻断链', () => {
  it('本轮占位状态（notImplemented）→ not-implemented', () => {
    const status = makeStatus({ notImplemented: true })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000)).toEqual({
      ok: false,
      reason: 'not-implemented'
    })
  })

  it.each(PEEK_PERMISSION_STATES.filter((state) => state !== 'granted'))(
    '权限状态 %s → permission-not-granted',
    (permission) => {
      const status = makeStatus({ permission })
      expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000)).toEqual({
        ok: false,
        reason: 'permission-not-granted'
      })
    }
  )

  it('状态中缺少该 capability → capability-unavailable', () => {
    const status = makeStatus({ capabilities: [] })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000)).toEqual({
      ok: false,
      reason: 'capability-unavailable'
    })
  })

  it('capability 声明为不可用 → capability-unavailable', () => {
    const status = makeStatus({
      capabilities: [{ capability: 'screen.peek.metadata', available: false, reason: null }]
    })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000)).toEqual({
      ok: false,
      reason: 'capability-unavailable'
    })
  })

  it('其他 capability 可用但请求的那一个缺失 → capability-unavailable', () => {
    const status = makeStatus({
      capabilities: [{ capability: 'screen.peek.ocr', available: true, reason: null }]
    })
    const request = makeRequest({ capability: 'screen.peek.vision' })
    expect(evaluatePeekGate(request, status, 1_000)).toEqual({
      ok: false,
      reason: 'capability-unavailable'
    })
  })

  it('显式关闭的 capability 不被误判为可用', () => {
    const status = makeStatus({
      capabilities: [
        { capability: 'screen.peek.metadata', available: false, reason: 'permission-not-granted' },
        { capability: 'screen.peek.ocr', available: true, reason: null },
        { capability: 'screen.peek.vision', available: true, reason: null }
      ]
    })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000)).toEqual({
      ok: false,
      reason: 'capability-unavailable'
    })
  })
})

/* -------------------------------- 敏感应用 -------------------------------- */

describe('敏感应用闸门', () => {
  it('应用名大小写不敏感命中敏感名单', () => {
    const status = makeStatus()
    expect(
      evaluatePeekGate(makeRequest({ foregroundApp: '1password' }), status, 1_000)
    ).toEqual({ ok: false, reason: 'sensitive-app' })
    expect(
      evaluatePeekGate(makeRequest({ foregroundApp: 'BITWARDEN' }), status, 1_000)
    ).toEqual({ ok: false, reason: 'sensitive-app' })
  })

  it('子串命中（含中文）也算敏感', () => {
    const status = makeStatus()
    expect(
      evaluatePeekGate(makeRequest({ foregroundApp: '招商银行 App' }), status, 1_000)
    ).toEqual({ ok: false, reason: 'sensitive-app' })
  })

  it('普通应用不命中；未知 app 不因空值被误杀（未来规则引擎另评）', () => {
    const status = makeStatus()
    const decision = evaluatePeekGate(
      makeRequest({ foregroundApp: 'Visual Studio Code' }),
      status,
      1_000
    )
    expect(decision).toEqual({
      ok: true,
      capability: 'screen.peek.metadata',
      tier: 'metadata'
    })
    expect(
      evaluatePeekGate(makeRequest({ foregroundApp: null }), status, 1_000)
    ).toEqual({ ok: true, capability: 'screen.peek.metadata', tier: 'metadata' })
    expect(
      evaluatePeekGate(makeRequest({ foregroundApp: '   ' }), status, 1_000)
    ).toEqual({ ok: true, capability: 'screen.peek.metadata', tier: 'metadata' })
  })

  it('敏感名单为空 → 不阻断', () => {
    const status = makeStatus({ sensitiveApps: [] })
    expect(evaluatePeekGate(makeRequest({ foregroundApp: '1Password' }), status, 1_000)).toEqual(
      { ok: true, capability: 'screen.peek.metadata', tier: 'metadata' }
    )
  })
})

/* ---------------------------------- 节流 ---------------------------------- */

describe('节流（minGap / 每小时上限 / 时钟回拨）', () => {
  it('首次观察（无历史）不节流', () => {
    const status = makeStatus({ lastObservationAtMs: null, observationsLastHour: 0 })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 1_000).ok).toBe(true)
  })

  it('最小间隔内 → throttled', () => {
    const status = makeStatus({ lastObservationAtMs: 95_000 })
    // now - last = 5000 < minGap 10000
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 100_000)).toEqual({
      ok: false,
      reason: 'throttled'
    })
  })

  it('恰好等于最小间隔 → 放行（边界 open）', () => {
    const status = makeStatus({ lastObservationAtMs: 90_000 })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 100_000).ok).toBe(true)
  })

  it('时钟回拨（now 早于上次观察）→ throttled（不猜测）', () => {
    const status = makeStatus({ lastObservationAtMs: 120_000 })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 100_000)).toEqual({
      ok: false,
      reason: 'throttled'
    })
  })

  it('本小时观察数达到上限 → throttled', () => {
    const status = makeStatus({ observationsLastHour: 3 })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 100_000)).toEqual({
      ok: false,
      reason: 'throttled'
    })
  })

  it('上限为 0 → 一律 throttled（fail-closed）', () => {
    const status = makeStatus({ throttle: { minGapMs: 0, maxPerHour: 0 } })
    expect(evaluatePeekGate(DEFAULT_REQUEST, status, 100_000)).toEqual({
      ok: false,
      reason: 'throttled'
    })
  })
})

/* --------------------------------- 放行路径 -------------------------------- */

describe('放行路径（未来 provider 接线参考）', () => {
  it('metadata / ocr / vision 全绿时放行并返回对应 tier', () => {
    const status = makeStatus({
      tier: 'vision',
      capabilities: AVAILABLE_CAPABILITIES
    })
    expect(
      evaluatePeekGate(makeRequest({ capability: 'screen.peek.metadata' }), status, 1_000)
    ).toEqual({ ok: true, capability: 'screen.peek.metadata', tier: 'metadata' })
    expect(
      evaluatePeekGate(makeRequest({ capability: 'screen.peek.ocr' }), status, 1_000)
    ).toEqual({ ok: true, capability: 'screen.peek.ocr', tier: 'ocr' })
    expect(
      evaluatePeekGate(makeRequest({ capability: 'screen.peek.vision' }), status, 1_000)
    ).toEqual({ ok: true, capability: 'screen.peek.vision', tier: 'vision' })
  })
})

/* ------------------------------- 脏输入不抛 -------------------------------- */

describe('fail-closed：脏输入不抛异常', () => {
  const MALFORMED_REQUESTS: readonly unknown[] = [
    null,
    undefined,
    42,
    'request',
    [],
    {},
    { ...makeRequest(), trigger: 'timer' },
    { ...makeRequest(), capability: 'screen.peek.audio' },
    { ...makeRequest(), requestedAtMs: Number.NaN },
    { ...makeRequest(), requestedAtMs: '1000' },
    { ...makeRequest(), foregroundApp: 42 }
  ]

  it.each(MALFORMED_REQUESTS)('脏请求 %j → invalid-request 且不抛', (malformed) => {
    const status = makeStatus()
    expect(() => evaluatePeekGate(malformed as PeekObservationRequest, status, 1_000)).not.toThrow()
    expect(evaluatePeekGate(malformed as PeekObservationRequest, status, 1_000)).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
  })

  const MALFORMED_STATUSES: readonly unknown[] = [
    null,
    undefined,
    42,
    'status',
    [],
    {},
    { ...makeStatus(), enabled: 'yes' },
    { ...makeStatus(), tier: 'ambient' },
    { ...makeStatus(), permission: 'maybe' },
    { ...makeStatus(), capabilities: 'nope' },
    { ...makeStatus(), capabilities: [{ capability: 'screen.peek.ocr', available: 'yes', reason: null }] },
    { ...makeStatus(), provider: { id: '', version: 'x' } },
    { ...makeStatus(), sensitiveApps: 'nope' },
    { ...makeStatus(), throttle: { minGapMs: Number.NaN, maxPerHour: 1 } },
    { ...makeStatus(), lastObservationAtMs: Number.POSITIVE_INFINITY },
    { ...makeStatus(), observationsLastHour: -1 },
    { ...makeStatus(), notImplemented: 'no' }
  ]

  it.each(MALFORMED_STATUSES)('脏状态 %j → invalid-request 且不抛', (malformed) => {
    expect(() =>
      evaluatePeekGate(DEFAULT_REQUEST, malformed as PeekStatus, 1_000)
    ).not.toThrow()
    expect(evaluatePeekGate(DEFAULT_REQUEST, malformed as PeekStatus, 1_000)).toEqual({
      ok: false,
      reason: 'invalid-request'
    })
  })

  it('非法 now → invalid-request 且不抛', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1000']) {
      expect(() => evaluatePeekGate(DEFAULT_REQUEST, makeStatus(), now as number)).not.toThrow()
      expect(evaluatePeekGate(DEFAULT_REQUEST, makeStatus(), now as number)).toEqual({
        ok: false,
        reason: 'invalid-request'
      })
    }
  })

  it('同一输入重复调用结果稳定（纯函数、无副作用）', () => {
    const request = makeRequest({ capability: 'screen.peek.ocr' })
    const status = makeStatus()
    const before = JSON.stringify({ request, status })
    const first = evaluatePeekGate(request, status, 1_000)
    const second = evaluatePeekGate(request, status, 1_000)
    expect(second).toEqual(first)
    expect(JSON.stringify({ request, status })).toBe(before)
  })
})
