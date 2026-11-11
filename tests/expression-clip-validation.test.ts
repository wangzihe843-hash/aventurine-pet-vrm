/**
 * V6 表情层：clip 数据工具单测（`scripts/vrm/expression/lib/expression-clip.mjs`）
 *
 * 覆盖：
 * - 与 shared 契约同口径（preset 轨道/别名/默认值/帧数约定/采样 parity）；
 * - 曲线重采样 / 采样 / 建 clip / 建 manifest 条目 / 触发选择；
 * - QA 校验规则（schema/frames/轨道长度/权重越界/loop 接缝/目标模型轨道名）。
 */
import { describe, expect, it } from 'vitest'

import {
  EXPRESSION_CLIP_DEFAULTS,
  EXPRESSION_CLIP_LIMITS,
  EXPRESSION_CLIP_SCHEMA_VERSION,
  EXPRESSION_MANIFEST_SCHEMA_VERSION,
  EXPRESSION_PRESET_TRACKS,
  VRM0_EXPRESSION_ALIASES,
  buildExpressionClip,
  buildExpressionClipEntry,
  buildExpressionManifest,
  expectedFrameCount,
  findExpressionClipEntry,
  normalizeExpressionName,
  resampleCurve,
  sampleCurveAtTime,
  sampleExpressionClip,
  sanitizeExpressionClip,
  validateExpressionClipData
} from '../scripts/vrm/expression/lib/expression-clip.mjs'
import {
  EXPRESSION_CLIP_DEFAULTS as SHARED_DEFAULTS,
  EXPRESSION_CLIP_LIMITS as SHARED_LIMITS,
  EXPRESSION_CLIP_SCHEMA_VERSION as SHARED_CLIP_SCHEMA,
  EXPRESSION_MANIFEST_SCHEMA_VERSION as SHARED_MANIFEST_SCHEMA,
  EXPRESSION_PRESET_TRACKS as SHARED_PRESET_TRACKS,
  VRM0_EXPRESSION_ALIASES as SHARED_VRM0_ALIASES,
  expectedExpressionFrameCount,
  sampleExpressionClip as sharedSampleExpressionClip
} from '@shared/expression-contract'
import type { ExpressionClip } from '@shared/expression-contract'

/** 合法 sample clip：10 帧 @10fps、1s、loop。 */
function makeClip(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: EXPRESSION_CLIP_SCHEMA_VERSION,
    id: 'test/clip',
    source: 'mate',
    fps: 10,
    frames: 10,
    duration: 1,
    loop: true,
    tracks: {
      happy: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
      blink: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    },
    ...overrides
  }
}

describe('expression-clip：与 shared 契约同口径', () => {
  it('schema 版本 / preset 轨道 / 别名 / 默认值 / 上限一致', () => {
    expect(EXPRESSION_CLIP_SCHEMA_VERSION).toBe(SHARED_CLIP_SCHEMA)
    expect(EXPRESSION_MANIFEST_SCHEMA_VERSION).toBe(SHARED_MANIFEST_SCHEMA)
    expect(EXPRESSION_PRESET_TRACKS).toEqual([...SHARED_PRESET_TRACKS])
    expect(VRM0_EXPRESSION_ALIASES).toEqual(SHARED_VRM0_ALIASES)
    expect(EXPRESSION_CLIP_DEFAULTS).toEqual(SHARED_DEFAULTS)
    expect(EXPRESSION_CLIP_LIMITS).toEqual(SHARED_LIMITS)
  })

  it('帧数约定与 shared 完全一致（含边界）', () => {
    for (const [duration, fps, loop] of [
      [10.033333, 30, true],
      [10.033333, 30, false],
      [1, 30, true],
      [1, 30, false],
      [0, 30, true],
      [0, 30, false],
      [2.5, 24, true],
      [2.5, 24, false]
    ] as const) {
      expect(expectedFrameCount(duration, fps, loop)).toBe(
        expectedExpressionFrameCount(duration, fps, loop)
      )
    }
  })

  it('采样 parity：同一 clip 多个时间点结果一致', () => {
    const clip = makeClip() as unknown as ExpressionClip
    for (const time of [0, 0.05, 0.5, 0.95, 1, 2.35, -0.2]) {
      expect(sampleExpressionClip(clip, time)).toEqual(sharedSampleExpressionClip(clip, time))
    }
  })
})

describe('expression-clip：曲线采样/重采样', () => {
  it('sampleCurveAtTime：线性插值 + 首尾外推钳制', () => {
    const points = [
      [0, 0],
      [1, 1],
      [2, 0.5]
    ] as Array<[number, number]>
    expect(sampleCurveAtTime(points, -1)).toBe(0)
    expect(sampleCurveAtTime(points, 0)).toBe(0)
    expect(sampleCurveAtTime(points, 0.5)).toBe(0.5)
    expect(sampleCurveAtTime(points, 1.5)).toBe(0.75)
    expect(sampleCurveAtTime(points, 9)).toBe(0.5)
    expect(sampleCurveAtTime([], 0)).toBe(0)
  })

  it('sampleCurveAtTime：带存盘斜率 = 三次 Hermite（Unity .anim 语义）', () => {
    // 0→1 缓动（两端斜率为 0）：t=0.25 时 Hermite = 0.5（smoothstep），线性也是 0.5；
    // 取 t=0.125 区分：Hermite = 3x²-2x³ | x=0.25 → 0.15625，线性 = 0.25。
    const points = [
      [0, 0, 0, 0],
      [0.5, 1, 0, 0]
    ] as Array<[number, number, number, number]>
    expect(sampleCurveAtTime(points, 0.125)).toBeCloseTo(0.15625, 6)
    expect(sampleCurveAtTime(points, 0.25)).toBeCloseTo(0.5, 6)
    // 非零斜率（Linear 段）：h10/h11 项生效，结果与线性插值不同
    const linear = [
      [0, 0, 2, 2],
      [1, 1, 2, 2]
    ] as Array<[number, number, number, number]>
    expect(sampleCurveAtTime(linear, 0.5)).toBeCloseTo(0.5, 6)
    expect(sampleCurveAtTime(linear, 0.25)).toBeCloseTo(0.34375, 6)
    // 与纯线性点（2 元组）结果不同
    const tuple2 = [
      [0, 0],
      [1, 1]
    ] as Array<[number, number]>
    expect(sampleCurveAtTime(tuple2, 0.25)).toBeCloseTo(0.25, 6)
  })

  it('resampleCurve：逐帧值 + clamp 0..1 + 长度', () => {
    const points = [
      [0, 0],
      [0.5, 1.4],
      [1, -0.2]
    ] as Array<[number, number]>
    const frames = resampleCurve(points, 10, 11)
    expect(frames).toHaveLength(11)
    expect(frames[0]).toBe(0)
    expect(frames[5]).toBe(1)
    expect(frames[10]).toBe(0)
    for (const value of frames) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

describe('expression-clip：构建', () => {
  it('buildExpressionClip：自动 frames/duration、去全零轨道、4 位小数', () => {
    const clip = buildExpressionClip({
      id: 'mate/test',
      source: 'mate',
      fps: 10,
      loop: true,
      tracks: {
        happy: [0, 0.123456, 1],
        blink: [0, 0, 0],
        sad: [0.5, 0.5, 0.5]
      }
    })
    expect(clip.schemaVersion).toBe(1)
    expect(clip.frames).toBe(3)
    expect(clip.duration).toBeCloseTo(0.3, 6)
    expect(clip.tracks.happy).toEqual([0, 0.1235, 1])
    expect(clip.tracks.blink).toBeUndefined()
    expect(clip.tracks.sad).toEqual([0.5, 0.5, 0.5])
  })

  it('buildExpressionClip：无轨道 / 长度不齐 → 抛错', () => {
    expect(() => buildExpressionClip({ id: 'x', source: 'mate', tracks: {} })).toThrow(/没有任何轨道/)
    expect(() =>
      buildExpressionClip({ id: 'x', source: 'mate', tracks: { happy: [0, 1], sad: [0] } })
    ).toThrow(/长度/)
  })

  it('sanitizeExpressionClip：缓存默认值/丢弃坏轨道（CLI 读文件用）', () => {
    const { clip, warnings } = sanitizeExpressionClip({
      id: 'dirty',
      fps: 10,
      frames: 2,
      duration: 0.2,
      loop: true,
      tracks: { happy: [1.4, -1], bad: [0], sad: [0, 0.5] }
    })
    expect(clip).not.toBeNull()
    expect(clip!.tracks.happy).toEqual([1, 0])
    expect(clip!.tracks.bad).toBeUndefined()
    expect(clip!.tracks.sad).toEqual([0, 0.5])
    expect(warnings.length).toBeGreaterThanOrEqual(1)
  })
})

describe('expression-clip：QA 校验', () => {
  it('合法 clip → ok，无 error/warning；stats 含轨道统计（loop 接缝小）', () => {
    const { clip } = sanitizeExpressionClip({
      id: 'test/loop-clean',
      source: 'mate',
      fps: 10,
      frames: 10,
      duration: 1,
      loop: true,
      tracks: { happy: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.4, 0.3, 0.2, 0.1] }
    })
    const result = validateExpressionClipData(clip)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.stats.trackCount).toBe(1)
    expect(result.stats.tracks.happy.max).toBe(0.5)
    // loop 接缝 = |末帧 0.1 - 首帧 0| = 0.1
    expect(result.stats.loopSeam).toBeCloseTo(0.1, 3)
  })

  it('loop 接缝过大 → warning', () => {
    const result = validateExpressionClipData(makeClip())
    expect(result.ok).toBe(true)
    expect(result.stats.loopSeam).toBeCloseTo(1, 3)
    expect(result.warnings.some((warning: string) => warning.includes('接缝'))).toBe(true)
  })

  it('错误：schemaVersion/source/frames 一致性', () => {
    const bad = validateExpressionClipData({
      schemaVersion: 2,
      id: 'bad',
      source: 'unity',
      fps: 10,
      frames: 5,
      duration: 1,
      loop: true,
      tracks: { happy: [0, 1, 0, 1, 0] }
    })
    expect(bad.ok).toBe(false)
    expect(bad.errors.some((error: string) => error.includes('schemaVersion'))).toBe(true)
    expect(bad.errors.some((error: string) => error.includes('source'))).toBe(true)
    expect(bad.errors.some((error: string) => error.includes('frames='))).toBe(true)
  })

  it('错误：轨道长度不匹配 / 权重越界', () => {
    const badLength = validateExpressionClipData({
      schemaVersion: 1,
      id: 'bad-length',
      source: 'mate',
      fps: 10,
      frames: 5,
      duration: 0.5,
      loop: true,
      tracks: { happy: [0, 1, 0] }
    })
    expect(badLength.ok).toBe(false)
    expect(badLength.errors.some((error: string) => error.includes('长度'))).toBe(true)

    const badWeight = validateExpressionClipData({
      schemaVersion: 1,
      id: 'bad-weight',
      source: 'mate',
      fps: 10,
      frames: 5,
      duration: 0.5,
      loop: true,
      tracks: { happy: [0, 2, 0, 1, 0] }
    })
    expect(badWeight.ok).toBe(false)
    expect(badWeight.errors.some((error: string) => error.includes('越界'))).toBe(true)
  })

  it('warning：未知轨道 / 非 preset 自定义轨道 / loop 接缝过大', () => {
    const result = validateExpressionClipData({
      schemaVersion: 1,
      id: 'warn',
      source: 'hsr',
      fps: 10,
      frames: 3,
      duration: 0.3,
      loop: true,
      tracks: {
        happy: [0, 0, 1],
        'custom名': [0, 0, 0]
      }
    })
    expect(result.ok).toBe(true)
    expect(result.warnings.some((warning: string) => warning.includes('不是 VRM1 preset'))).toBe(true)
    expect(result.warnings.some((warning: string) => warning.includes('接缝'))).toBe(true)

    const known = validateExpressionClipData(
      {
        schemaVersion: 1,
        id: 'known',
        source: 'hsr',
        fps: 10,
        frames: 2,
        duration: 0.2,
        loop: false,
        tracks: { notOnModel: [0, 1] }
      },
      { knownExpressionNames: ['happy', 'sad'] }
    )
    expect(known.warnings.some((warning: string) => warning.includes('不在目标模型'))).toBe(true)
  })

  it('非对象 / 缺 id → ok=false（不抛）', () => {
    expect(validateExpressionClipData(null).ok).toBe(false)
    expect(validateExpressionClipData({}).ok).toBe(false)
  })
})

describe('expression-clip：manifest 条目/选择', () => {
  it('buildExpressionClipEntry / findExpressionClipEntry 优先级规则', () => {
    const clip = buildExpressionClip({
      id: 'faceDrag',
      source: 'mate',
      fps: 10,
      loop: true,
      tracks: { sad: [1, 1] }
    })
    const entry = buildExpressionClipEntry(clip, {
      file: 'mate/faceDrag.json',
      triggers: ['drag', ' ', 'drag'],
      tags: ['reaction'],
      priority: 10,
      note: 'note'
    })
    expect(entry.file).toBe('mate/faceDrag.json')
    expect(entry.set).toBe('mate')
    expect(entry.loop).toBe(true)
    expect(entry.triggers).toEqual(['drag', 'drag'])
    expect(entry.note).toBe('note')

    const manifest = buildExpressionManifest([
      { ...entry, id: 'low', priority: 0 },
      { ...entry, id: 'high', priority: 5 }
    ])
    expect(manifest.schemaVersion).toBe(1)
    expect(typeof manifest.generatedAt).toBe('string')
    expect(findExpressionClipEntry(manifest, 'drag')!.id).toBe('high')
    expect(findExpressionClipEntry(manifest, 'high')!.id).toBe('high')
    expect(findExpressionClipEntry(manifest, 'nope')).toBeNull()
    expect(findExpressionClipEntry(null, 'drag')).toBeNull()
  })

  it('normalizeExpressionName 边界', () => {
    expect(normalizeExpressionName('Joy')).toBe('happy')
    expect(normalizeExpressionName('neutral')).toBeNull()
    expect(normalizeExpressionName('  sad  ')).toBe('sad')
    expect(normalizeExpressionName('')).toBeNull()
    expect(normalizeExpressionName('x'.repeat(65))).toBeNull()
  })
})
