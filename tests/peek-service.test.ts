/**
 * 单测：窥屏服务 / stub provider（`src/main/peek/**`，Wave 3 A7 接口预留）。
 *
 * 覆盖验收点：
 * - `createPeekService({ providers: [] })` → `getStatus()` 全关、与 `PEEK_DEFAULT_STATUS` 同形；
 * - `observe()` 恒 `{ ok: false, reason: 'not-implemented' }`，任何脏输入都不抛；
 * - 注入 provider 也**不被调用**（零采集副作用；stub 不被调用/无 fs 写/无定时器）；
 * - 注入 provider 的 id/version 只出现在 status.provider（不改变全关状态）；
 * - stub provider：capabilities 恒空、observe 恒 not-implemented、dispose 幂等；
 * - 源码静态扫描：不 import electron/node、不含截图/标题/TCC/timer/spawn/写盘 符号。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  PEEK_CAPABILITIES,
  PEEK_DEFAULT_STATUS,
  PEEK_DEFAULT_THROTTLE,
  PEEK_DENY_REASONS,
  PEEK_EMPTY_REDACTION,
  PEEK_PERMISSION_STATES,
  PEEK_TIERS,
  type PeekCapability,
  type PeekObservationRequest,
  type PeekObservationResult,
  type PeekProvider
} from '@shared/peek'
import { createPeekService } from '../src/main/peek/service'
import {
  PEEK_STUB_PROVIDER_ID,
  PEEK_STUB_PROVIDER_VERSION,
  createPeekNotImplementedResult,
  createStubPeekProvider
} from '../src/main/peek/stub-provider'

/* --------------------------------- 夹具 ---------------------------------- */

const VALID_REQUEST: PeekObservationRequest = {
  trigger: 'manual',
  capability: 'screen.peek.metadata',
  requestedAtMs: 1_000,
  foregroundApp: 'Finder'
}

/** 读取仓库内源码（静态扫描用；测试运行 cwd 为仓库根，但用 import.meta.url 更稳）。 */
function readRepoSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

/* ------------------------------- 契约形状 -------------------------------- */

describe('契约形状（A7 冻结面）', () => {
  it('capability / 档位 / 权限 / 拒绝原因 列表非空且唯一', () => {
    for (const list of [
      PEEK_CAPABILITIES,
      PEEK_TIERS,
      PEEK_PERMISSION_STATES,
      PEEK_DENY_REASONS
    ]) {
      expect(list.length).toBeGreaterThan(0)
      expect(new Set(list).size).toBe(list.length)
    }
    expect(PEEK_CAPABILITIES).toEqual([
      'screen.peek.metadata',
      'screen.peek.ocr',
      'screen.peek.vision'
    ])
  })

  it('默认节流与空脱敏摘要形状稳定', () => {
    expect(PEEK_DEFAULT_THROTTLE).toEqual({ minGapMs: 600_000, maxPerHour: 3 })
    expect(PEEK_EMPTY_REDACTION).toEqual({ applied: false, ruleIds: [], truncated: false })
  })
})

/* --------------------------------- 服务状态 ------------------------------- */

describe('createPeekService：默认全关状态', () => {
  it('默认创建（无参）→ getStatus() 与 PEEK_DEFAULT_STATUS 同形', () => {
    const service = createPeekService()
    expect(service.getStatus()).toEqual(PEEK_DEFAULT_STATUS)
  })

  it('createPeekService({ providers: [] }) → 全关、全不可用、notImplemented', () => {
    const status = createPeekService({ providers: [] }).getStatus()
    expect(status.enabled).toBe(false)
    expect(status.tier).toBe('off')
    expect(status.permission).toBe('not-determined')
    expect(status.notImplemented).toBe(true)
    expect(status.provider).toBeNull()
    expect(status.capabilities).toHaveLength(PEEK_CAPABILITIES.length)
    for (const capability of status.capabilities) {
      expect(capability.available).toBe(false)
      expect(capability.reason).toBe('not-implemented')
    }
  })

  it('每次 getStatus() 返回新对象（调用方改动不影响内部状态）', () => {
    const service = createPeekService()
    const first = service.getStatus()
    const second = service.getStatus()
    expect(first).not.toBe(second)
    expect(first.capabilities).not.toBe(second.capabilities)
    expect(first.sensitiveApps).not.toBe(second.sensitiveApps)
    expect(first.throttle).not.toBe(second.throttle)

    const mutable = first as unknown as {
      enabled: boolean
      capabilities: Array<{ available: boolean }>
    }
    mutable.enabled = true
    mutable.capabilities[0]!.available = true
    const third = service.getStatus()
    expect(third.enabled).toBe(false)
    expect(third.capabilities[0]!.available).toBe(false)
  })

  it('脏 options（providers 非数组）不抛，仍返回全关状态', () => {
    const service = createPeekService({
      providers: 'nope' as unknown as readonly PeekProvider[]
    })
    expect(() => service.getStatus()).not.toThrow()
    expect(service.getStatus().provider).toBeNull()
    expect(service.getStatus().enabled).toBe(false)
  })
})

/* --------------------------------- 观察结果 ------------------------------- */

describe('PeekService.observe：恒 not-implemented', () => {
  it('默认调用返回精确的 { ok:false, reason:"not-implemented" }', async () => {
    const service = createPeekService()
    await expect(service.observe()).resolves.toEqual({ ok: false, reason: 'not-implemented' })
    await expect(service.observe(VALID_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'not-implemented'
    })
  })

  it('任何脏输入都不抛，返回同一结果', async () => {
    const service = createPeekService()
    const evil = Object.defineProperty({}, 'capability', {
      get(): never {
        throw new Error('getter 不应被读取')
      }
    })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const dirtyInputs: readonly unknown[] = [
      null,
      undefined,
      42,
      'request',
      [],
      {},
      { capability: 'screen.peek.audio' },
      evil,
      circular,
      { trigger: 'timer', requestedAtMs: Number.NaN }
    ]
    for (const input of dirtyInputs) {
      await expect(service.observe(input)).resolves.toEqual({
        ok: false,
        reason: 'not-implemented'
      })
    }
  })

  it('重复调用结果稳定（无内部状态漂移）', async () => {
    const service = createPeekService()
    const first = await service.observe(VALID_REQUEST)
    const second = await service.observe(VALID_REQUEST)
    expect(second).toEqual(first)
  })
})

/* ------------------------------ 零采集副作用 ------------------------------ */

describe('零采集副作用：注入 provider 也不被调用', () => {
  function createSpyProvider(): {
    readonly provider: PeekProvider
    readonly capabilities: ReturnType<typeof vi.fn>
    readonly observe: ReturnType<typeof vi.fn>
    readonly dispose: ReturnType<typeof vi.fn>
  } {
    const capabilities = vi.fn((): readonly PeekCapability[] => PEEK_CAPABILITIES)
    const observe = vi.fn(
      async (): Promise<PeekObservationResult> => ({ ok: false, reason: 'not-implemented' })
    )
    const dispose = vi.fn()
    return {
      provider: { id: 'spy-provider', version: '9.9.9', capabilities, observe, dispose },
      capabilities,
      observe,
      dispose
    }
  }

  it('getStatus() 只读 provider 身份，不调用其方法；状态仍全关', () => {
    const { provider, capabilities, observe, dispose } = createSpyProvider()
    const service = createPeekService({ providers: [provider] })
    const status = service.getStatus()
    expect(status.enabled).toBe(false)
    expect(status.tier).toBe('off')
    expect(status.notImplemented).toBe(true)
    expect(status.provider).toEqual({ id: 'spy-provider', version: '9.9.9' })
    expect(capabilities).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('observe() / dispose() 不触发任何 provider 采集', async () => {
    const { provider, capabilities, observe, dispose } = createSpyProvider()
    const service = createPeekService({ providers: [provider] })
    await expect(service.observe(VALID_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'not-implemented'
    })
    service.dispose()
    service.dispose()
    expect(capabilities).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })
})

/* -------------------------------- stub provider --------------------------- */

describe('stub provider：永不采集、永不抛异常', () => {
  it('身份与能力声明冻结：id/version 固定，capabilities 恒空', () => {
    const stub = createStubPeekProvider()
    expect(stub.id).toBe(PEEK_STUB_PROVIDER_ID)
    expect(stub.id).toBe('stub')
    expect(stub.version).toBe(PEEK_STUB_PROVIDER_VERSION)
    expect(stub.capabilities()).toEqual([])
    expect(PEEK_CAPABILITIES.length).toBeGreaterThan(0) // stub 不声明任何能力
  })

  it('observe() 恒 not-implemented（合法请求 / 脏请求 / dispose 后均如此）', async () => {
    const stub = createStubPeekProvider()
    await expect(stub.observe(VALID_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'not-implemented'
    })
    await expect(
      stub.observe(null as unknown as PeekObservationRequest)
    ).resolves.toEqual({ ok: false, reason: 'not-implemented' })
    expect(() => stub.dispose?.()).not.toThrow()
    expect(() => stub.dispose?.()).not.toThrow()
    await expect(stub.observe(VALID_REQUEST)).resolves.toEqual({
      ok: false,
      reason: 'not-implemented'
    })
  })

  it('createPeekNotImplementedResult 每次返回新对象（无共享可变引用）', () => {
    const first = createPeekNotImplementedResult()
    const second = createPeekNotImplementedResult()
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first).toEqual({ ok: false, reason: 'not-implemented' })
  })
})

/* ------------------------- 静态扫描：无采集依赖 --------------------------- */

interface ForbiddenSourcePattern {
  readonly label: string
  readonly pattern: RegExp
}

/** 采集/TCC/副作用相关符号（源码扫描；只针对 A7 新增的三个模块）。 */
const FORBIDDEN_SOURCE_PATTERNS: readonly ForbiddenSourcePattern[] = [
  { label: 'electron import', pattern: /from\s+['"]electron['"]/ },
  { label: 'node: import', pattern: /from\s+['"]node:/ },
  { label: 'child_process', pattern: /child_process/ },
  { label: 'TCC prompt', pattern: /askForMediaAccess/ },
  { label: 'window title', pattern: /kCGWindowName/ },
  { label: 'capture API', pattern: /\b(capturePage|desktopCapturer|getUserMedia)\b/ },
  { label: 'timer', pattern: /\bset(Interval|Timeout)\s*\(/ },
  { label: 'fs write', pattern: /(writeFile|appendFile|createWriteStream)\s*\(/ },
  { label: 'spawn', pattern: /\b(spawn|execFile|execSync)\s*\(/ }
]

const SCANNED_SOURCES: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'src/shared/peek.ts', source: readRepoSource('../src/shared/peek.ts') },
  { name: 'src/main/peek/service.ts', source: readRepoSource('../src/main/peek/service.ts') },
  {
    name: 'src/main/peek/stub-provider.ts',
    source: readRepoSource('../src/main/peek/stub-provider.ts')
  }
]

const SCAN_CASES = SCANNED_SOURCES.flatMap(({ name, source }) =>
  FORBIDDEN_SOURCE_PATTERNS.map(({ label, pattern }) => ({ name, source, label, pattern }))
)

describe('静态扫描：A7 模块不含采集/TCC/fs/timer/spawn 依赖', () => {
  it.each(SCAN_CASES)('$name 不含 $label', ({ source, pattern }) => {
    expect(pattern.test(source)).toBe(false)
  })
})
