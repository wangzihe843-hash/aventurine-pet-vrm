/**
 * 单测：桌宠侧兼容判定纯函数（`src/main/desktop/dsh-compat.ts`，2026-11-11 兼容性安全 v2）。
 *
 * 覆盖计划 §6.1 的判定规则与评审 E5/E7：
 * - v4 运行时 compat 双向（范围内 ok / 范围外 incompatible / `0.3.0-rc.1` prerelease 边界）；
 * - v3 legacy 回退 `BRIDGE_LEGACY_DSH_RANGE`（能验证 ok；范围外 incompatible）；
 * - 桥版本上下界、control schema 不匹配；
 * - DSH 版本未知 / 范围不可解析 / 版本不可解析 → unverified（不猜兼容）；
 * - 安装清单仅在运行时信号缺失时兜底；运行时/清单版本不一致只写 detail 不改 status；
 * - 任意脏输入不抛异常。
 */
import { describe, expect, it } from 'vitest'

import {
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_LEGACY_DSH_RANGE,
  BRIDGE_PLUGIN_MIN_SUPPORTED,
  BRIDGE_PLUGIN_VERSION,
  type DshBridgeInstallManifest
} from '@shared/bridge-schema'

import { evaluateCouplingCompat, type CouplingCompatInput } from '../src/main/desktop/dsh-compat'

/** 现网桥声明范围（v3/v4 一致）。 */
const RANGE = '>=0.2.2-rc.1 <0.3.0'

/** 造 v4 运行时 compat 输入。 */
function v4Input(overrides: Partial<CouplingCompatInput> = {}): CouplingCompatInput {
  return {
    dshVersion: '0.2.2-rc.1',
    bridgeVersion: 4,
    controlSchema: 1,
    dshRange: RANGE,
    ...overrides
  }
}

/** 造 v3 legacy 输入（无 compat：bridgeVersion 来自 control 顶层，controlSchema 由调用方按帧解析补 1）。 */
function legacyInput(overrides: Partial<CouplingCompatInput> = {}): CouplingCompatInput {
  return {
    dshVersion: '0.2.2-rc.1',
    bridgeVersion: 3,
    controlSchema: 1,
    dshRange: null,
    ...overrides
  }
}

/** 造安装清单（默认 v4 兼容现网 DSH）。 */
function manifest(overrides: Partial<DshBridgeInstallManifest> = {}): DshBridgeInstallManifest {
  return {
    schemaVersion: 1,
    installedAt: 1_794_371_618_741,
    installMethod: 'live-copy-insert',
    bridgeEntry: '/tmp/live-bridge/rev-1/lib/index.js',
    bridgePackageName: 'dsh-aventurine-bridge',
    bridgePackageVersion: '0.2.0',
    bridgeVersion: 4,
    controlSchema: 1,
    dshRange: RANGE,
    dshVersionAtInstall: '0.2.2-rc.1',
    ...overrides
  }
}

describe('evaluateCouplingCompat：v4 运行时 compat', () => {
  it('DSH 0.2.2-rc.1 落在声明范围内 → ok', () => {
    const result = evaluateCouplingCompat(v4Input())
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ok')
    expect(result.bridgeVersion).toBe(4)
    expect(result.dshRange).toBe(RANGE)
    expect(result.detail).toContain('0.2.2-rc.1')
  })

  it('DSH 0.3.0 超出声明范围 → incompatible/version-out-of-range（detail 带版本与范围）', () => {
    const result = evaluateCouplingCompat(v4Input({ dshVersion: '0.3.0' }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('version-out-of-range')
    expect(result.detail).toContain('0.3.0')
    expect(result.detail).toContain(RANGE)
  })

  it('E7：0.3.0-rc.1 在 includePrerelease 语义下仍满足 <0.3.0 → ok', () => {
    const result = evaluateCouplingCompat(v4Input({ dshVersion: '0.3.0-rc.1' }))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ok')
  })

  it('v4 未声明 dshRange → incompatible/range-missing（不回退 legacy）', () => {
    const result = evaluateCouplingCompat(v4Input({ dshRange: null }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('range-missing')
    expect(result.dshRange).toBeNull()
  })
})

describe('evaluateCouplingCompat：桥版本 / schema 上下界', () => {
  it('桥版本未知且无安装清单 → unverified/no-bridge', () => {
    const result = evaluateCouplingCompat(
      v4Input({ bridgeVersion: null, controlSchema: null, dshRange: null })
    )
    expect(result.status).toBe('unverified')
    expect(result.code).toBe('no-bridge')
    expect(result.bridgeVersion).toBeNull()
  })

  it(`桥版本低于最低支持（v${BRIDGE_PLUGIN_MIN_SUPPORTED}）→ incompatible/bridge-too-old`, () => {
    const result = evaluateCouplingCompat(v4Input({ bridgeVersion: 2 }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('bridge-too-old')
  })

  it(`桥版本高于桌宠已知（v${BRIDGE_PLUGIN_VERSION}）→ incompatible/bridge-too-new`, () => {
    const result = evaluateCouplingCompat(v4Input({ bridgeVersion: 5 }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('bridge-too-new')
  })

  it('control schema 不匹配 → incompatible/schema-mismatch', () => {
    const result = evaluateCouplingCompat(v4Input({ controlSchema: 2 }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('schema-mismatch')
  })

  it('control schema 未知（null）→ incompatible/schema-mismatch（不得猜兼容）', () => {
    const result = evaluateCouplingCompat(v4Input({ controlSchema: null }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('schema-mismatch')
  })
})

describe('evaluateCouplingCompat：v3 legacy 回退（E5）', () => {
  it('v3 无 compat + DSH 0.2.2-rc.1 → ok，范围回退 BRIDGE_LEGACY_DSH_RANGE', () => {
    const result = evaluateCouplingCompat(legacyInput())
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ok')
    expect(result.bridgeVersion).toBe(3)
    expect(result.dshRange).toBe(BRIDGE_LEGACY_DSH_RANGE)
    expect(result.detail).toContain(BRIDGE_LEGACY_DSH_RANGE)
  })

  it('v3 legacy + DSH 0.3.0 → incompatible/version-out-of-range', () => {
    const result = evaluateCouplingCompat(legacyInput({ dshVersion: '0.3.0' }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('version-out-of-range')
    expect(result.dshRange).toBe(BRIDGE_LEGACY_DSH_RANGE)
  })

  it('v3 但安装清单/运行时给出了显式范围 → 优先用显式范围', () => {
    const result = evaluateCouplingCompat(legacyInput({ dshRange: '>=0.3.0 <0.4.0' }))
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('version-out-of-range')
    expect(result.dshRange).toBe('>=0.3.0 <0.4.0')
  })
})

describe('evaluateCouplingCompat：不可验证（不猜兼容）', () => {
  it('DSH 版本未知 → unverified/dsh-version-unknown', () => {
    const result = evaluateCouplingCompat(v4Input({ dshVersion: null }))
    expect(result.status).toBe('unverified')
    expect(result.code).toBe('dsh-version-unknown')
  })

  it('DSH 版本为空白字符串 → unverified/dsh-version-unknown', () => {
    const result = evaluateCouplingCompat(v4Input({ dshVersion: '   ' }))
    expect(result.status).toBe('unverified')
    expect(result.code).toBe('dsh-version-unknown')
  })

  it('桥范围非法（未知语法）→ unverified/range-unparsable', () => {
    const result = evaluateCouplingCompat(v4Input({ dshRange: 'not-a-range!!' }))
    expect(result.status).toBe('unverified')
    expect(result.code).toBe('range-unparsable')
  })

  it('DSH 版本非法（非 semver）→ unverified/range-unparsable', () => {
    const result = evaluateCouplingCompat(v4Input({ dshVersion: 'version-two' }))
    expect(result.status).toBe('unverified')
    expect(result.code).toBe('range-unparsable')
  })
})

describe('evaluateCouplingCompat：安装清单兜底', () => {
  it('运行时 compat 缺失 + 清单声明 v4 兼容范围 → ok（E6 静态可解释通道）', () => {
    const result = evaluateCouplingCompat({
      dshVersion: '0.2.2-rc.1',
      bridgeVersion: null,
      controlSchema: null,
      dshRange: null,
      installManifest: manifest()
    })
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ok')
    expect(result.bridgeVersion).toBe(4)
    expect(result.detail).toContain('安装清单兜底')
  })

  it('运行时 compat 缺失 + 清单声明范围不含当前 DSH → incompatible/version-out-of-range', () => {
    const result = evaluateCouplingCompat({
      dshVersion: '0.3.0',
      bridgeVersion: null,
      controlSchema: null,
      dshRange: null,
      installManifest: manifest()
    })
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('version-out-of-range')
  })

  it('运行时 compat 缺失 + 清单自身 bridgeVersion 过低 → incompatible/bridge-too-old', () => {
    const result = evaluateCouplingCompat({
      dshVersion: '0.2.2-rc.1',
      bridgeVersion: null,
      controlSchema: null,
      dshRange: null,
      installManifest: manifest({ bridgeVersion: 2 })
    })
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('bridge-too-old')
  })

  it('运行时兼容信号存在时，清单只做 detail 记录（不改变 status）', () => {
    const result = evaluateCouplingCompat(v4Input({ installManifest: manifest({ bridgeVersion: 3 }) }))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('ok')
    expect(result.detail).toContain('不一致')
  })

  it('运行时 v4 明确 range-missing 时不能被清单悄悄"救活"', () => {
    const result = evaluateCouplingCompat(
      v4Input({ dshRange: null, installManifest: manifest() })
    )
    expect(result.status).toBe('incompatible')
    expect(result.code).toBe('range-missing')
  })
})

describe('evaluateCouplingCompat：纯函数健壮性', () => {
  it('任意脏输入不抛异常（null/undefined/数字/对象）', () => {
    const garbage = [
      {},
      { dshVersion: 1, bridgeVersion: '4', controlSchema: [], dshRange: 42 },
      { dshVersion: null, bridgeVersion: null, controlSchema: null, dshRange: null },
      { dshVersion: '0.2.2', bridgeVersion: -1, controlSchema: 0, dshRange: '' }
    ]
    for (const input of garbage) {
      expect(() => evaluateCouplingCompat(input as unknown as CouplingCompatInput)).not.toThrow()
    }
    const result = evaluateCouplingCompat({
      dshVersion: '0.2.2',
      bridgeVersion: -1,
      controlSchema: 0,
      dshRange: ''
    })
    expect(result.status).toBe('unverified')
    expect(result.code).toBe('no-bridge')
  })

  it('BRIDGE_CONTROL_SCHEMA_VERSION 与规则一致（当前为 1）', () => {
    expect(BRIDGE_CONTROL_SCHEMA_VERSION).toBe(1)
  })
})
