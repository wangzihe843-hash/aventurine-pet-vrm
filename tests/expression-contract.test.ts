/**
 * V6 表情层契约单测：`src/shared/expression-contract.ts`
 *
 * 冻结护栏：
 * - 轨道名/别名/口型映射与 `src/shared/vrm.ts` 的 VRM preset 全集一致；
 * - 帧数约定 loop = round(duration*fps)、non-loop = round+1；
 * - `sanitizeExpressionClip` / `sanitizeExpressionClipManifest` 脏输入不抛异常、钳制/丢弃行为稳定；
 * - `sampleExpressionClip` 线性插值 + loop 回绕 + non-loop 钳制；
 * - `findExpressionClip` 的 priority 选择规则；
 * - 合并/缩放纯函数不产生 NaN/越界。
 */
import { describe, expect, it } from 'vitest'

import {
  EMPTY_EXPRESSION_CLIP_MANIFEST,
  EXPRESSION_CLIP_DEFAULTS,
  EXPRESSION_CLIP_FADE_RANGE,
  EXPRESSION_CLIP_LIMITS,
  EXPRESSION_CLIP_SCHEMA_VERSION,
  EXPRESSION_CLIP_SOURCES,
  EXPRESSION_MANIFEST_SCHEMA_VERSION,
  EXPRESSION_MOUTH_PRESETS,
  EXPRESSION_PRESET_TRACKS,
  VISEME_TO_EXPRESSION,
  VISEMES,
  expectedExpressionFrameCount,
  expressionClipDuration,
  findExpressionClip,
  hasExpressionClip,
  isExpressionClipSource,
  isExpressionPresetTrack,
  isExpressionName,
  isVisemeName,
  mergeExpressionWeightsMax,
  normalizeExpressionName,
  resolvePetExpression,
  sampleExpressionClip,
  sanitizeExpressionClip,
  sanitizeExpressionClipManifest,
  sanitizeExpressionWeights,
  scaleExpressionWeights
} from '@shared/expression-contract'
import { PET_EXPRESSIONS, VRM_EXPRESSION_PRESETS } from '@shared/vrm'
import type { ExpressionClip, ExpressionClipManifest } from '@shared/expression-contract'

/** 构造一个合法 clip（10 帧 @10fps、1s、loop）。 */
function makeClip(overrides: Partial<ExpressionClip> = {}): ExpressionClip {
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

function makeManifest(): ExpressionClipManifest {
  return {
    schemaVersion: EXPRESSION_MANIFEST_SCHEMA_VERSION,
    generatedAt: '2026-11-08T00:00:00.000Z',
    clips: [
      {
        id: 'mate/drag',
        set: 'mate',
        file: 'expressions/mate/drag.json',
        loop: true,
        fps: 30,
        frames: 301,
        duration: 10.033333,
        priority: 0,
        triggers: ['drag'],
        tags: ['reaction']
      },
      {
        id: 'mate/dragAlt',
        set: 'mate',
        file: 'expressions/mate/dragAlt.json',
        loop: true,
        fps: 30,
        frames: 301,
        duration: 10.033333,
        priority: 5,
        triggers: ['drag'],
        tags: ['reaction']
      },
      {
        id: 'hsr/photoAngry',
        set: 'hsr',
        file: 'expressions/hsr/photoAngry.json',
        loop: false,
        fps: 30,
        frames: 61,
        duration: 2,
        priority: 0,
        triggers: ['angry', 'photo'],
        tags: ['emotion']
      }
    ]
  }
}

describe('expression-contract：常量一致性', () => {
  it('preset 轨道 ⊂ VRM preset 全集，且不含 neutral/lookAt', () => {
    for (const name of EXPRESSION_PRESET_TRACKS) {
      expect(VRM_EXPRESSION_PRESETS as readonly string[]).toContain(name)
    }
    expect(EXPRESSION_PRESET_TRACKS as readonly string[]).not.toContain('neutral')
    expect(EXPRESSION_PRESET_TRACKS as readonly string[]).not.toContain('lookLeft')
    expect(EXPRESSION_PRESET_TRACKS).toHaveLength(13)
  })

  it('口型 preset 是 preset 轨道子集，且 mouth preset 与 viseme 映射一致', () => {
    for (const name of EXPRESSION_MOUTH_PRESETS) {
      expect(EXPRESSION_PRESET_TRACKS as readonly string[]).toContain(name)
    }
    for (const viseme of VISEMES) {
      const mapped = VISEME_TO_EXPRESSION[viseme]
      if (mapped !== null) expect(EXPRESSION_MOUTH_PRESETS as readonly string[]).toContain(mapped)
    }
    expect(VISEME_TO_EXPRESSION['あ']).toBe('aa')
    expect(VISEME_TO_EXPRESSION['い']).toBe('ih')
    expect(VISEME_TO_EXPRESSION['う']).toBe('ou')
    expect(VISEME_TO_EXPRESSION['え']).toBe('ee')
    expect(VISEME_TO_EXPRESSION['お']).toBe('oh')
    expect(VISEME_TO_EXPRESSION['ん']).toBeNull()
  })

  it('schema 版本 = 1、默认值/上限合理、空 manifest 形状合法', () => {
    expect(EXPRESSION_CLIP_SCHEMA_VERSION).toBe(1)
    expect(EXPRESSION_MANIFEST_SCHEMA_VERSION).toBe(1)
    expect(EXPRESSION_CLIP_DEFAULTS.fps).toBe(30)
    expect(EXPRESSION_CLIP_LIMITS.maxFrames).toBeGreaterThan(0)
    expect(EMPTY_EXPRESSION_CLIP_MANIFEST.clips).toEqual([])
    expect(EMPTY_EXPRESSION_CLIP_MANIFEST.schemaVersion).toBe(EXPRESSION_MANIFEST_SCHEMA_VERSION)
    expect(EXPRESSION_CLIP_SOURCES).toEqual(['mate', 'hsr'])
    expect(PET_EXPRESSIONS).toContain('happy')
  })
})

describe('expression-contract：名字/绑定', () => {
  it('normalizeExpressionName：VRM0 别名归一化、VRM1 原样、非法 null', () => {
    expect(normalizeExpressionName('joy')).toBe('happy')
    expect(normalizeExpressionName('Sorrow')).toBe('sad')
    expect(normalizeExpressionName('fun')).toBe('relaxed')
    expect(normalizeExpressionName('blink_l')).toBe('blinkLeft')
    expect(normalizeExpressionName('Blink_R')).toBe('blinkRight')
    expect(normalizeExpressionName('A')).toBe('aa')
    expect(normalizeExpressionName('o')).toBe('oh')
    expect(normalizeExpressionName('neutral')).toBeNull()
    expect(normalizeExpressionName('happy')).toBe('happy')
    expect(normalizeExpressionName('  aa  ')).toBe('aa')
    expect(normalizeExpressionName('笑い')).toBe('笑い')
    expect(normalizeExpressionName('')).toBeNull()
    expect(normalizeExpressionName('bad\u0000name')).toBeNull()
    expect(normalizeExpressionName(null)).toBeNull()
    expect(normalizeExpressionName('x'.repeat(65))).toBeNull()
  })

  it('isExpressionClipSource / isExpressionPresetTrack / isVisemeName / isExpressionName', () => {
    expect(isExpressionClipSource('mate')).toBe(true)
    expect(isExpressionClipSource('hsr')).toBe(true)
    expect(isExpressionClipSource('unity')).toBe(false)
    expect(isExpressionPresetTrack('blink')).toBe(true)
    expect(isExpressionPresetTrack('neutral')).toBe(false)
    expect(isVisemeName('あ')).toBe(true)
    expect(isVisemeName('x')).toBe(false)
    expect(isExpressionName('笑い')).toBe(true)
    expect(isExpressionName('   ')).toBe(false)
    expect(isExpressionName(42)).toBe(false)
  })

  it('resolvePetExpression：只解析合法业务表情 + 合法绑定值', () => {
    const bindings = { blink: 'blink', happy: 'happy', neutral: 'neutral' }
    expect(resolvePetExpression(bindings, 'happy')).toBe('happy')
    expect(resolvePetExpression(bindings, 'blink')).toBe('blink')
    expect(resolvePetExpression(bindings, 'neutral')).toBe('neutral')
    expect(resolvePetExpression(bindings, 'sad')).toBeNull()
    expect(resolvePetExpression(bindings, 'notAExpression')).toBeNull()
    expect(resolvePetExpression({ blink: '   ' }, 'blink')).toBeNull()
    expect(resolvePetExpression(null, 'happy')).toBeNull()
    expect(resolvePetExpression({ happy: 42 as unknown as string }, 'happy')).toBeNull()
  })
})

describe('expression-contract：帧数约定', () => {
  it('loop = round(duration*fps)，non-loop = +1', () => {
    expect(expectedExpressionFrameCount(10.033333, 30, true)).toBe(301)
    expect(expectedExpressionFrameCount(10.033333, 30, false)).toBe(302)
    expect(expectedExpressionFrameCount(1, 30, true)).toBe(30)
    expect(expectedExpressionFrameCount(1, 30, false)).toBe(31)
    // 极端输入防御：至少 1/2 帧
    expect(expectedExpressionFrameCount(0, 30, true)).toBe(1)
    expect(expectedExpressionFrameCount(0, 30, false)).toBe(2)
    expect(expectedExpressionFrameCount(Number.NaN, 0, false)).toBe(
      Math.max(2, Math.round(0 * EXPRESSION_CLIP_DEFAULTS.fps) + 1)
    )
  })
})

describe('expression-contract：sanitizeExpressionClip', () => {
  it('合法 clip 原样通过（放行空 tracks 的全零表情）', () => {
    const { clip, warnings } = sanitizeExpressionClip(makeClip())
    expect(warnings).toEqual([])
    expect(clip).not.toBeNull()
    expect(clip!.id).toBe('test/clip')
    expect(clip!.tracks.happy).toHaveLength(10)
    expect(clip!.frames).toBe(10)

    const blank = sanitizeExpressionClip({
      id: 'blank',
      source: 'hsr',
      fps: 30,
      frames: 3,
      duration: 0.1,
      loop: false,
      tracks: {}
    })
    expect(blank.clip).not.toBeNull()
    expect(blank.clip!.tracks).toEqual({})
  })

  it('缺 id / 非对象 → null + warning（不抛）', () => {
    expect(sanitizeExpressionClip({ tracks: {} }).clip).toBeNull()
    expect(sanitizeExpressionClip(null).clip).toBeNull()
    expect(sanitizeExpressionClip([1, 2]).clip).toBeNull()
    expect(sanitizeExpressionClip({ id: 'ok', tracks: 'nope' }).clip).not.toBeNull()
  })

  it('缺省值回填：fps=30、frames 由轨道推导、duration=frames/fps、loop=false', () => {
    const { clip } = sanitizeExpressionClip({
      id: 'derived',
      tracks: { happy: [0, 0.5, 1, 0.5, 0] }
    })
    expect(clip!.fps).toBe(EXPRESSION_CLIP_DEFAULTS.fps)
    expect(clip!.frames).toBe(5)
    expect(clip!.duration).toBeCloseTo(5 / 30, 6)
    expect(clip!.loop).toBe(false)
    expect(clip!.source).toBe('mate')
  })

  it('越界权重钳制、NaN → 0、长度不匹配轨道丢弃、非法名丢弃', () => {
    const { clip, warnings } = sanitizeExpressionClip({
      id: 'dirty',
      fps: 10,
      frames: 4,
      duration: 0.4,
      loop: true,
      tracks: {
        happy: [2, -1, Number.NaN, 0.5],
        sad: [0, 1],
        'bad\u0000': [0, 0, 0, 0],
        blink: [0.5, 0.5, 0.5, 0.5]
      }
    })
    expect(clip).not.toBeNull()
    expect(clip!.tracks.happy).toEqual([1, 0, 0, 0.5])
    expect(clip!.tracks.sad).toBeUndefined()
    expect(Object.keys(clip!.tracks)).not.toContain('bad\u0000')
    expect(clip!.tracks.blink).toHaveLength(4)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('非 preset 自定义 expression 轨道：保留 + warning', () => {
    const { clip, warnings } = sanitizeExpressionClip({
      id: 'custom',
      fps: 10,
      frames: 2,
      duration: 0.2,
      loop: true,
      tracks: { 笑い: [0, 1] }
    })
    expect(clip!.tracks['笑い']).toEqual([0, 1])
    expect(warnings.some((w) => w.includes('不是 VRM 1.0 preset'))).toBe(true)
  })

  it('fps/frames 钳制到合法区间', () => {
    const { clip } = sanitizeExpressionClip({
      id: 'clamped',
      fps: 999,
      frames: 999999,
      duration: 5000,
      loop: true,
      tracks: { happy: [0, 1] }
    })
    expect(clip!.fps).toBe(EXPRESSION_CLIP_LIMITS.maxFps)
    expect(clip!.frames).toBe(EXPRESSION_CLIP_LIMITS.maxFrames)
    expect(clip!.duration).toBe(EXPRESSION_CLIP_LIMITS.maxDurationSec)
  })

  it('duration 与 frames/fps 的容差：偏差 ≤1 帧不 warning', () => {
    const exact = sanitizeExpressionClip(makeClip())
    expect(exact.warnings).toEqual([])
    const off = sanitizeExpressionClip(makeClip({ duration: 1.2 }))
    expect(off.warnings.some((w) => w.includes('不一致'))).toBe(true)
  })
})

describe('expression-contract：sanitizeExpressionClipManifest', () => {
  it('合法 manifest 通过', () => {
    const { manifest, warnings } = sanitizeExpressionClipManifest(makeManifest())
    expect(warnings).toEqual([])
    expect(manifest.clips).toHaveLength(3)
    expect(manifest.clips[0]!.file).toBe('expressions/mate/drag.json')
    expect(manifest.generatedAt).toBe('2026-11-08T00:00:00.000Z')
  })

  it('脏条目：缺 id/非法 file/重复 id 丢弃，set 回填 mate', () => {
    const { manifest, warnings } = sanitizeExpressionClipManifest({
      clips: [
        { id: 'ok', file: 'expressions/ok.json' },
        { file: 'expressions/no-id.json' },
        { id: 'bad-file', file: '/abs/path.json' },
        { id: 'bad-file2', file: '../escape.json' },
        { id: 'ok', file: 'expressions/dup.json' },
        { id: 'weird', file: 'expressions/weird.json', set: 'nope', triggers: 'not-array' },
        'not-an-object'
      ]
    })
    expect(manifest.clips.map((clip) => clip.id)).toEqual(['ok', 'weird'])
    expect(manifest.clips[1]!.set).toBe('mate')
    expect(manifest.clips[1]!.triggers).toEqual([])
    expect(warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('triggers/tags 清洗：去空、去重、限长', () => {
    const { manifest } = sanitizeExpressionClipManifest({
      clips: [
        {
          id: 'good',
          file: 'expressions/good.json',
          triggers: ['drag', ' drag ', '', 'x'.repeat(80), 42, 'pet'],
          tags: ['a', 'a', 'b']
        }
      ]
    })
    expect(manifest.clips[0]!.triggers).toEqual(['drag', 'pet'])
    expect(manifest.clips[0]!.tags).toEqual(['a', 'b'])
  })

  it('非对象输入 → 空 manifest + warning（不抛）', () => {
    expect(sanitizeExpressionClipManifest(null).manifest.clips).toEqual([])
    expect(sanitizeExpressionClipManifest('x').warnings).toHaveLength(1)
  })
})

describe('expression-contract：淡入淡出字段', () => {
  it('sanitizeExpressionClip：fade 字段回填/钳制到 0..2s', () => {
    const withFade = sanitizeExpressionClip({ ...makeClip(), fadeInSec: 0.5, fadeOutSec: 3 }).clip
    expect(withFade!.fadeInSec).toBe(0.5)
    expect(withFade!.fadeOutSec).toBe(EXPRESSION_CLIP_FADE_RANGE.max)
    const negative = sanitizeExpressionClip({ ...makeClip(), fadeInSec: -1 }).clip
    expect(negative!.fadeInSec).toBe(0)
    const noFade = sanitizeExpressionClip(makeClip()).clip
    expect(noFade!.fadeInSec).toBeUndefined()
  })

  it('sanitizeExpressionClipManifest：fade 缺省回填 defaults，非法回填 0', () => {
    const { manifest } = sanitizeExpressionClipManifest({
      clips: [
        { id: 'a', file: 'expressions/mate/a.json' },
        { id: 'b', file: 'expressions/mate/b.json', fadeInSec: 1.0, fadeOutSec: 99 }
      ]
    })
    expect(manifest.clips[0]!.fadeInSec).toBe(EXPRESSION_CLIP_DEFAULTS.fadeInSec)
    expect(manifest.clips[0]!.fadeOutSec).toBe(EXPRESSION_CLIP_DEFAULTS.fadeOutSec)
    expect(manifest.clips[1]!.fadeInSec).toBe(1.0)
    expect(manifest.clips[1]!.fadeOutSec).toBe(EXPRESSION_CLIP_FADE_RANGE.max)
  })
})

describe('expression-contract：选择', () => {
  it('findExpressionClip：priority 高者优先，同优先级取靠前者，trigger/id 均匹配', () => {
    const manifest = makeManifest()
    expect(findExpressionClip(manifest, 'drag')!.id).toBe('mate/dragAlt')
    expect(findExpressionClip(manifest, 'angry')!.id).toBe('hsr/photoAngry')
    expect(findExpressionClip(manifest, 'photo')!.id).toBe('hsr/photoAngry')
    expect(findExpressionClip(manifest, 'mate/drag')!.id).toBe('mate/drag')
    expect(findExpressionClip(manifest, 'nope')).toBeNull()
    expect(findExpressionClip(null, 'drag')).toBeNull()
    expect(findExpressionClip(manifest, '  ')).toBeNull()
    expect(hasExpressionClip(manifest, 'drag')).toBe(true)
    expect(hasExpressionClip(manifest, 'nope')).toBe(false)
  })
})

describe('expression-contract：采样', () => {
  it('线性插值 + loop 末帧→首帧回绕', () => {
    const clip = makeClip()
    expect(sampleExpressionClip(clip, 0)).toEqual({ blink: 1 })
    expect(sampleExpressionClip(clip, 0.05).happy).toBeCloseTo(0.05, 4)
    // 0.95s 在末帧(0.9)→首帧(0.0) 之间：happy 0.9→0 半程 = 0.45；blink 0→1 半程 = 0.5
    expect(sampleExpressionClip(clip, 0.95).happy).toBeCloseTo(0.45, 4)
    expect(sampleExpressionClip(clip, 0.95).blink).toBeCloseTo(0.5, 4)
    // loop 回绕：t=1s == t=0s
    expect(sampleExpressionClip(clip, 1).blink).toBeCloseTo(1, 4)
    // 负时间 / 超过 duration 也回绕
    expect(sampleExpressionClip(clip, -0.05).happy).toBeCloseTo(0.45, 4)
    expect(sampleExpressionClip(clip, 2.05).happy).toBeCloseTo(0.05, 4)
  })

  it('non-loop：时间钳制、末帧保持', () => {
    const clip = makeClip({ loop: false, frames: 11, duration: 1, tracks: { happy: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] } })
    expect(sampleExpressionClip(clip, -5)).toEqual({})
    expect(sampleExpressionClip(clip, 0.5).happy).toBeCloseTo(0.5, 4)
    expect(sampleExpressionClip(clip, 99).happy).toBe(1)
  })

  it('只输出 >1e-4 的轨道，结果四舍五入到 4 位', () => {
    const clip = makeClip({
      tracks: { happy: [0.00001, 0.123456], blink: [0, 0] }
    })
    const at0 = sampleExpressionClip(clip, 0)
    expect(at0).toEqual({})
    expect(sampleExpressionClip(clip, 0.1).happy).toBe(0.1235)
  })

  it('expressionClipDuration：非法 duration 时回退 frames/fps', () => {
    expect(expressionClipDuration(null)).toBe(0)
    expect(expressionClipDuration(makeClip())).toBe(1)
    expect(expressionClipDuration(makeClip({ duration: 0 }))).toBe(1)
  })
})

describe('expression-contract：混合/缩放', () => {
  it('mergeExpressionWeightsMax：同 expression 取 max、过滤非法值', () => {
    const merged = mergeExpressionWeightsMax(
      { happy: 0.4, aa: 0.2, blank: 0 },
      { happy: 0.9, sad: 0.3, aa: Number.NaN, 'bad\u0000': 0.5 }
    )
    expect(merged).toEqual({ happy: 0.9, aa: 0.2, sad: 0.3 })
  })

  it('scaleExpressionWeights：整体缩放 + clamp', () => {
    expect(scaleExpressionWeights({ happy: 0.5, aa: 1 }, 0.85)).toEqual({ happy: 0.425, aa: 0.85 })
    expect(scaleExpressionWeights({ happy: 0.5 }, 3)).toEqual({ happy: 1 })
    expect(scaleExpressionWeights({ happy: 0.5 }, Number.NaN)).toEqual({})
  })

  it('sanitizeExpressionWeights：Record 与 Map 均可', () => {
    const map = new Map<string, number>([
      ['happy', 1.5],
      ['sad', -1],
      ['ok', 0.25],
      ['', 0.5]
    ])
    expect(sanitizeExpressionWeights(map)).toEqual({ happy: 1, ok: 0.25 })
  })
})
