/**
 * 单测：dev 截图回环退出码决策（`src/main/dev-capture-exit.ts`，M-9 修复）。
 *
 * 覆盖：全好 → exit 0；renderer 未就绪 / 姿态被跳过 / 无截图 / 捕获异常 → exit 1；
 * 判定优先级；非法统计值（NaN/负数/小数）归一化；`error` 空串/undefined 不误判失败。
 */
import { describe, expect, it } from 'vitest'

import { decideDevCaptureExit } from '../src/main/dev-capture-exit'
import type { DevCaptureStats } from '../src/main/dev-capture-exit'

/** 全好基线。 */
function good(overrides: Partial<DevCaptureStats> = {}): DevCaptureStats {
  return { ready: true, captured: 3, skipped: 0, failed: 0, error: null, ...overrides }
}

describe('decideDevCaptureExit：成功路径', () => {
  it('ready + 有截图 + 0 skipped/failed → OK / exit 0', () => {
    expect(decideDevCaptureExit(good())).toEqual({ ok: true, exitCode: 0, reason: null })
  })

  it('error 为 undefined / 空串不算失败（调用方未传异常字段）', () => {
    expect(decideDevCaptureExit(good({ error: undefined })).ok).toBe(true)
    expect(decideDevCaptureExit(good({ error: '' })).ok).toBe(true)
  })

  it('多张截图全部成功仍 OK', () => {
    expect(decideDevCaptureExit(good({ captured: 7 })).exitCode).toBe(0)
  })
})

describe('decideDevCaptureExit：失败路径（必须非 0 退出）', () => {
  it('renderer 未就绪 → renderer-not-ready / exit 1', () => {
    expect(decideDevCaptureExit(good({ ready: false }))).toEqual({
      ok: false,
      exitCode: 1,
      reason: 'renderer-not-ready'
    })
  })

  it('有姿态被跳过（debugSetPose false）→ poses-skipped / exit 1', () => {
    expect(decideDevCaptureExit(good({ skipped: 2 }))).toEqual({
      ok: false,
      exitCode: 1,
      reason: 'poses-skipped'
    })
  })

  it('捕获过程没有成功截图 → no-captures / exit 1', () => {
    expect(decideDevCaptureExit(good({ captured: 0 }))).toEqual({
      ok: false,
      exitCode: 1,
      reason: 'no-captures'
    })
  })

  it('顶层异常 → capture-error / exit 1（即使 ready 且有截图）', () => {
    expect(decideDevCaptureExit(good({ error: 'capturePage failed' }))).toEqual({
      ok: false,
      exitCode: 1,
      reason: 'capture-error'
    })
  })

  it('failed 计数 > 0 → capture-error / exit 1', () => {
    expect(decideDevCaptureExit(good({ failed: 1 })).reason).toBe('capture-error')
  })

  it('判定优先级：异常 > ready > skipped > captured', () => {
    expect(
      decideDevCaptureExit({ ready: false, captured: 0, skipped: 1, failed: 2, error: 'boom' }).reason
    ).toBe('capture-error')
    expect(decideDevCaptureExit({ ready: false, captured: 0, skipped: 1, failed: 0 }).reason).toBe(
      'renderer-not-ready'
    )
    expect(decideDevCaptureExit({ ready: true, captured: 0, skipped: 1, failed: 0 }).reason).toBe(
      'poses-skipped'
    )
  })
})

describe('decideDevCaptureExit：统计值归一化（防御脏输入）', () => {
  it('NaN / 负数 / 小数按 0 或向下取整处理', () => {
    expect(decideDevCaptureExit(good({ captured: Number.NaN })).reason).toBe('no-captures')
    expect(decideDevCaptureExit(good({ captured: -3 })).reason).toBe('no-captures')
    expect(decideDevCaptureExit(good({ skipped: -1 })).ok).toBe(true)
    expect(decideDevCaptureExit(good({ failed: Number.NaN })).ok).toBe(true)
    expect(decideDevCaptureExit(good({ captured: 1.9 })).exitCode).toBe(0)
    expect(decideDevCaptureExit(good({ skipped: 1.9 })).reason).toBe('poses-skipped')
  })
})
