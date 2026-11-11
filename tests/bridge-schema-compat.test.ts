/**
 * 单测：DSH 桥契约的兼容性增量（`src/shared/bridge-schema.ts`，2026-11-11 v2）。
 *
 * 覆盖 compat 块 / 安装清单 `install.json` / 故障诊断 `bridge-error.json` 的解析与
 * 向后兼容规则；所有非法输入都必须返回 null 或整帧无效，绝不抛异常。
 */
import { describe, expect, it } from 'vitest'

import {
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_DIAGNOSTIC_MAX_BYTES,
  BRIDGE_INSTALL_MAX_BYTES,
  BRIDGE_INSTALL_SCHEMA_VERSION,
  BRIDGE_LEGACY_DSH_RANGE,
  BRIDGE_PLUGIN_MIN_SUPPORTED,
  BRIDGE_PLUGIN_VERSION,
  isDshBridgeControlFile,
  isDshBridgeStatusFile,
  parseDshBridgeCompat,
  parseDshBridgeDiagnostic,
  parseDshBridgeInstallManifest
} from '../src/shared/bridge-schema'

const VALID_COMPAT = {
  bridgeVersion: 4,
  controlSchema: 1,
  dshRange: '>=0.2.2-rc.1 <0.3.0'
} as const

function controlFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: BRIDGE_CONTROL_SCHEMA_VERSION,
    ts: 1_794_376_241_734,
    action: 'attached',
    dshPid: 98123,
    bridgeVersion: BRIDGE_PLUGIN_VERSION,
    compat: { ...VALID_COMPAT },
    ...extra
  }
}

function statusFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: 1_794_376_241_734,
    running: true,
    agents: 1,
    lastEventAt: 1_794_376_240_000,
    lastType: 'session/event',
    offline: false,
    compat: { ...VALID_COMPAT },
    ...extra
  }
}

function installManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: BRIDGE_INSTALL_SCHEMA_VERSION,
    installedAt: 1_794_371_618_741,
    installMethod: 'live-copy-insert',
    bridgeEntry: '/tmp/work/live-bridge/rev-1/lib/index.js',
    bridgePackageName: 'dsh-aventurine-bridge',
    bridgePackageVersion: '0.2.0',
    bridgeVersion: BRIDGE_PLUGIN_VERSION,
    controlSchema: BRIDGE_CONTROL_SCHEMA_VERSION,
    dshRange: '>=0.2.2-rc.1 <0.3.0',
    dshVersionAtInstall: '0.2.2-rc.1',
    petAppPath: '/tmp/AventurinePet.app',
    petBundleId: 'com.aventurine.pet',
    ...extra
  }
}

describe('契约常量', () => {
  it('v4 兼容契约常量固定（改动需同步 bridge/lib/constants.js 的 parity 测试）', () => {
    expect(BRIDGE_PLUGIN_VERSION).toBe(4)
    expect(BRIDGE_PLUGIN_MIN_SUPPORTED).toBe(3)
    expect(BRIDGE_LEGACY_DSH_RANGE).toBe('>=0.2.2-rc.1 <0.3.0')
    expect(BRIDGE_INSTALL_SCHEMA_VERSION).toBe(1)
    expect(BRIDGE_PLUGIN_MIN_SUPPORTED).toBeLessThan(BRIDGE_PLUGIN_VERSION)
  })
})

describe('parseDshBridgeCompat', () => {
  it('合法 compat 原样解析（dshRange 去首尾空白）', () => {
    expect(parseDshBridgeCompat({ ...VALID_COMPAT, dshRange: '  >=0.2.2-rc.1 <0.3.0  ' })).toEqual(
      VALID_COMPAT
    )
    expect(parseDshBridgeCompat({ bridgeVersion: 4, controlSchema: 1, dshRange: null })).toEqual({
      bridgeVersion: 4,
      controlSchema: 1,
      dshRange: null
    })
  })

  it('非法形状 → null', () => {
    for (const value of [
      undefined,
      null,
      'compat',
      [],
      {},
      { bridgeVersion: 0, controlSchema: 1, dshRange: null },
      { bridgeVersion: 1.5, controlSchema: 1, dshRange: null },
      { bridgeVersion: 4, controlSchema: -1, dshRange: null },
      { bridgeVersion: 4, controlSchema: 1, dshRange: 42 }
    ]) {
      expect(parseDshBridgeCompat(value)).toBeNull()
    }
    // 空串是"未声明范围"的脏写法：宽松归一为 null（后续兼容判定按 range-missing 降级），不整块拒绝。
    expect(parseDshBridgeCompat({ bridgeVersion: 4, controlSchema: 1, dshRange: '' })).toEqual({
      bridgeVersion: 4,
      controlSchema: 1,
      dshRange: null
    })
  })
})

describe('control.json 兼容性增量（加法式）', () => {
  it('v4 帧带 compat 合法；v3 legacy 帧无 compat 也合法（向后兼容）', () => {
    expect(isDshBridgeControlFile(controlFrame())).toBe(true)
    const legacy = { schemaVersion: 1, ts: 1, action: 'attached', dshPid: 1, bridgeVersion: 3 }
    expect(isDshBridgeControlFile(legacy)).toBe(true)
  })

  it('compat 存在但形状非法 → 整帧无效（fail-safe：不带病使用）', () => {
    expect(isDshBridgeControlFile(controlFrame({ compat: { bridgeVersion: 4 } }))).toBe(false)
    expect(isDshBridgeControlFile(controlFrame({ compat: 'bad' }))).toBe(false)
  })
})

describe('status.json 兼容性增量', () => {
  it('带 compat 合法；无 compat 的旧心跳也合法', () => {
    expect(isDshBridgeStatusFile(statusFrame())).toBe(true)
    expect(isDshBridgeStatusFile(statusFrame({ compat: undefined }))).toBe(true)
  })

  it('compat 存在但非法 → 整帧无效（按离线降级）', () => {
    expect(isDshBridgeStatusFile(statusFrame({ compat: { bridgeVersion: 4, controlSchema: 0 } }))).toBe(
      false
    )
  })

  it('compat 不影响既有必填字段校验', () => {
    expect(isDshBridgeStatusFile(statusFrame({ ts: 'bad' }))).toBe(false)
  })
})

describe('parseDshBridgeInstallManifest', () => {
  it('合法清单解析（可选字段缺省 → null）', () => {
    const parsed = parseDshBridgeInstallManifest(JSON.stringify(installManifest()))
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      installMethod: 'live-copy-insert',
      bridgePackageName: 'dsh-aventurine-bridge',
      bridgeVersion: 4,
      dshRange: '>=0.2.2-rc.1 <0.3.0'
    })
    const minimal = parseDshBridgeInstallManifest(
      JSON.stringify({
        schemaVersion: 1,
        installedAt: 1,
        bridgeEntry: '/x/lib/index.js',
        bridgePackageName: 'dsh-aventurine-bridge',
        bridgePackageVersion: '0.2.0',
        bridgeVersion: 4,
        controlSchema: 1,
        dshRange: null
      })
    )
    expect(minimal).toMatchObject({ dshVersionAtInstall: null, petAppPath: null, petBundleId: null })
  })

  it('installMethod 非法 → unknown（不因此拒绝整份清单）', () => {
    const parsed = parseDshBridgeInstallManifest(
      JSON.stringify(installManifest({ installMethod: 'copy-paste' }))
    )
    expect(parsed?.installMethod).toBe('unknown')
  })

  it('坏输入 → null（含超长 / schemaVersion 不匹配 / 必填缺失）', () => {
    expect(parseDshBridgeInstallManifest(undefined)).toBeNull()
    expect(parseDshBridgeInstallManifest('not json')).toBeNull()
    expect(parseDshBridgeInstallManifest(JSON.stringify(installManifest({ schemaVersion: 2 })))).toBeNull()
    expect(
      parseDshBridgeInstallManifest(JSON.stringify(installManifest({ bridgePackageName: '' })))
    ).toBeNull()
    const oversized = `${JSON.stringify(installManifest())}${' '.repeat(BRIDGE_INSTALL_MAX_BYTES)}`
    expect(parseDshBridgeInstallManifest(oversized)).toBeNull()
  })
})

describe('parseDshBridgeDiagnostic', () => {
  it('合法诊断解析（message 截断到上限）', () => {
    const parsed = parseDshBridgeDiagnostic(
      JSON.stringify({
        schemaVersion: 1,
        ts: 1,
        phase: 'apply',
        message: 'Error: boom',
        bridgeVersion: 4,
        dshRange: null
      })
    )
    expect(parsed).toMatchObject({ phase: 'apply', message: 'Error: boom', bridgeVersion: 4 })

    const long = parseDshBridgeDiagnostic(
      JSON.stringify({ schemaVersion: 1, ts: 1, phase: 'apply', message: 'x'.repeat(5000) })
    )
    expect(long?.message.length).toBeLessThanOrEqual(1024)
  })

  it('坏输入 → null', () => {
    expect(parseDshBridgeDiagnostic(undefined)).toBeNull()
    expect(parseDshBridgeDiagnostic(JSON.stringify({ schemaVersion: 2, ts: 1, phase: 'a', message: 'b' }))).toBeNull()
    expect(parseDshBridgeDiagnostic(JSON.stringify({ schemaVersion: 1, ts: 1, phase: '', message: 'b' }))).toBeNull()
    const oversized = JSON.stringify({
      schemaVersion: 1,
      ts: 1,
      phase: 'apply',
      message: 'x'.repeat(BRIDGE_DIAGNOSTIC_MAX_BYTES)
    })
    expect(parseDshBridgeDiagnostic(oversized)).toBeNull()
  })
})
