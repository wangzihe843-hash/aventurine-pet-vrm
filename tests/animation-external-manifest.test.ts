/**
 * Wave 2.5 / D1 单测：外部动作清单 `motion-index.json` 的纯函数解析/校验。
 *
 * 覆盖任务书要求：合法清单、缺字段、未知字段忽略、非法 clip 跳过、空清单、版本不符、
 * mood 过滤、文件名单段校验、默认值（loop/ik/nominal/crossfade）。不依赖 three/DOM。
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CROSSFADE_MS,
  isSingleSegmentVmdFileName,
  MOTION_SCHEMA_VERSION,
  parseMotionIndex,
  PET_MOODS,
  type MotionClipDef
} from '../src/renderer/src/animation/legacy/external/manifest'

/** 合法最小清单。 */
function validClip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'idle',
    file: 'motion-idle.vmd',
    moods: ['idle'],
    ...overrides
  }
}

function validManifest(clips: unknown[] = [validClip()]): Record<string, unknown> {
  return { schemaVersion: 1, clips }
}

/** 取第一条 clip（断言辅助；不存在时直接失败）。 */
function firstClip(clips: readonly MotionClipDef[]): MotionClipDef {
  expect(clips.length).toBeGreaterThan(0)
  return clips[0]!
}

describe('parseMotionIndex：合法清单', () => {
  it('解析最小合法清单并应用默认值（loop=true / ik=on / nominal=null / crossfade=200）', () => {
    const { manifest, warnings } = parseMotionIndex(validManifest())
    expect(warnings).toEqual([])
    expect(manifest.schemaVersion).toBe(MOTION_SCHEMA_VERSION)
    expect(manifest.clips).toHaveLength(1)
    const clip = firstClip(manifest.clips)
    expect(clip).toEqual({
      id: 'idle',
      file: 'motion-idle.vmd',
      moods: ['idle'],
      loop: true,
      ik: 'on',
      nominalSpeedPxPerSec: null,
      crossfadeMs: DEFAULT_CROSSFADE_MS,
      grounding: 'feet',
      seatedAnchor: 'feet',
      seatedAnchorOffsetUnits: 0,
      suppressBones: [],
      microSway: false,
      source: null
    })
  })

  it('解析全字段 clip（walk 速度匹配/ik off/loop false/source）', () => {
    const { manifest, warnings } = parseMotionIndex(
      validManifest([
        validClip({
          id: 'walk',
          file: 'motion-walk.vmd',
          moods: ['walk'],
          loop: false,
          ik: 'off',
          nominalSpeedPxPerSec: 90,
          crossfadeMs: 180,
          source: 'Mixamo Walking / 本地自用'
        })
      ])
    )
    expect(warnings).toEqual([])
    const clip = firstClip(manifest.clips)
    expect(clip.loop).toBe(false)
    expect(clip.ik).toBe('off')
    expect(clip.nominalSpeedPxPerSec).toBe(90)
    expect(clip.crossfadeMs).toBe(180)
    expect(clip.source).toBe('Mixamo Walking / 本地自用')
  })

  it('多个 moods / 多个 clip 顺序保留（manifest 顺序 = 优先级）', () => {
    const { manifest } = parseMotionIndex(
      validManifest([
        validClip({ id: 'idle2', file: 'motion-idle2.vmd', moods: ['idle', 'pat', 'dshDone'] }),
        validClip({ id: 'walk', file: 'motion-walk.vmd', moods: ['walk'] })
      ])
    )
    expect(manifest.clips.map((clip) => clip.id)).toEqual(['idle2', 'walk'])
    expect(manifest.clips[0]!.moods).toEqual(['idle', 'pat', 'dshDone'])
  })

  it('未知字段忽略（不产生告警、不影响解析）', () => {
    const { manifest, warnings } = parseMotionIndex({
      schemaVersion: 1,
      generatedAt: '2026-11-08',
      foo: { bar: 1 },
      clips: [validClip({ priority: 10, notes: 'x', blendMode: 'additive' })]
    })
    expect(warnings).toEqual([])
    expect(manifest.clips).toHaveLength(1)
    expect(manifest.clips[0]!.id).toBe('idle')
  })

  it('moods 去重 + 覆盖全部 PetMood 取值', () => {
    const { manifest, warnings } = parseMotionIndex(
      validManifest([validClip({ id: 'all', moods: [...PET_MOODS, 'idle'] })])
    )
    expect(warnings).toEqual([])
    expect(manifest.clips[0]!.moods).toEqual([...PET_MOODS])
  })

  it('缺 schemaVersion 时按当前版本解析（可选字段前向兼容）', () => {
    const { manifest, warnings } = parseMotionIndex({ clips: [validClip()] })
    expect(warnings).toEqual([])
    expect(manifest.clips).toHaveLength(1)
  })
})

describe('parseMotionIndex：缺字段 / 非法项跳过', () => {
  it('缺 id → 跳过并告警', () => {
    const { manifest, warnings } = parseMotionIndex(validManifest([validClip({ id: undefined })]))
    expect(manifest.clips).toEqual([])
    expect(warnings.join('\n')).toContain('缺少非空字符串 id')
  })

  it('缺 file → 跳过并告警', () => {
    const { manifest, warnings } = parseMotionIndex(validManifest([validClip({ file: undefined })]))
    expect(manifest.clips).toEqual([])
    expect(warnings.join('\n')).toContain('file 非法')
  })

  it('缺 moods/空 moods → 跳过并告警', () => {
    for (const moods of [undefined, [], 'idle']) {
      const { manifest, warnings } = parseMotionIndex(validManifest([validClip({ moods })]))
      expect(manifest.clips).toEqual([])
      expect(warnings.join('\n')).toContain('mood')
    }
  })

  it('相对/多段/非 vmd 文件名 → 跳过（协议只接受单段文件名）', () => {
    const badFiles = ['../evil.vmd', 'optimized/motion-idle.vmd', 'motion-idle.vpd', 'idle', 'a:b.vmd', 'a\\b.vmd']
    for (const file of badFiles) {
      const { manifest, warnings } = parseMotionIndex(validManifest([validClip({ file })]))
      expect(manifest.clips, `file=${file}`).toEqual([])
      expect(warnings.join('\n')).toContain('file 非法')
    }
  })

  it('未知 mood 被过滤；仍有已知 mood 时 clip 保留（告警）', () => {
    const { manifest, warnings } = parseMotionIndex(
      validManifest([validClip({ moods: ['idle', 'sleepy', '跳舞', 42] })])
    )
    expect(manifest.clips).toHaveLength(1)
    expect(manifest.clips[0]!.moods).toEqual(['idle'])
    expect(warnings.join('\n')).toContain('未知 mood')
  })

  it('非对象 clip / 非对象数组项 → 跳过并告警', () => {
    const { manifest, warnings } = parseMotionIndex(validManifest([null, 42, 'idle', validClip()]))
    expect(manifest.clips).toHaveLength(1)
    expect(manifest.clips[0]!.id).toBe('idle')
    expect(warnings.filter((warning) => warning.includes('不是对象'))).toHaveLength(3)
  })

  it('id 重复 → 后一条跳过（保留 manifest 顺序第一条）', () => {
    const { manifest, warnings } = parseMotionIndex(
      validManifest([
        validClip({ id: 'idle', file: 'motion-idle.vmd' }),
        validClip({ id: 'idle', file: 'motion-idle2.vmd' })
      ])
    )
    expect(manifest.clips).toHaveLength(1)
    expect(manifest.clips[0]!.file).toBe('motion-idle.vmd')
    expect(warnings.join('\n')).toContain('id 重复')
  })

  it('非法 loop/ik/nominal/crossfade → 回默认值并告警（不整条丢弃）', () => {
    const { manifest, warnings } = parseMotionIndex(
      validManifest([
        validClip({ loop: 'yes', ik: 'maybe', nominalSpeedPxPerSec: -3, crossfadeMs: 'fast' })
      ])
    )
    expect(manifest.clips).toHaveLength(1)
    const clip = firstClip(manifest.clips)
    expect(clip.loop).toBe(true)
    expect(clip.ik).toBe('on')
    expect(clip.nominalSpeedPxPerSec).toBeNull()
    expect(clip.crossfadeMs).toBe(DEFAULT_CROSSFADE_MS)
    expect(warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('nominalSpeedPxPerSec 允许 null（非走路类）且不为 0/负数', () => {
    const { manifest, warnings } = parseMotionIndex(
      validManifest([validClip({ nominalSpeedPxPerSec: null })])
    )
    expect(warnings).toEqual([])
    expect(manifest.clips[0]!.nominalSpeedPxPerSec).toBeNull()
  })

  it('crossfadeMs 非负整数化（0 允许，运行时再夹 120–250）', () => {
    const { manifest } = parseMotionIndex(validManifest([validClip({ crossfadeMs: 0 })]))
    expect(manifest.clips[0]!.crossfadeMs).toBe(0)
  })
})

describe('parseMotionIndex：空清单 / 非法顶层', () => {
  it('undefined/null → 空清单 + 告警', () => {
    for (const raw of [undefined, null]) {
      const { manifest, warnings } = parseMotionIndex(raw)
      expect(manifest.clips).toEqual([])
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  it('顶层不是对象（数组/字符串/数字）→ 空清单 + 告警', () => {
    for (const raw of [[], 'idle', 1, true]) {
      const { manifest, warnings } = parseMotionIndex(raw as unknown)
      expect(manifest.clips).toEqual([])
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  it('schemaVersion 不支持 → 整份忽略并告警', () => {
    const { manifest, warnings } = parseMotionIndex({ schemaVersion: 2, clips: [validClip()] })
    expect(manifest.clips).toEqual([])
    expect(warnings.join('\n')).toContain('不受支持')
  })

  it('clips 不是数组 → 空清单 + 告警', () => {
    const { manifest, warnings } = parseMotionIndex({ schemaVersion: 1, clips: {} })
    expect(manifest.clips).toEqual([])
    expect(warnings.join('\n')).toContain('clips 不是数组')
  })

  it('空 clips 数组 → 空清单 + 告警（回退 B3）', () => {
    const { manifest, warnings } = parseMotionIndex({ schemaVersion: 1, clips: [] })
    expect(manifest.clips).toEqual([])
    expect(warnings.join('\n')).toContain('没有可用 clip')
  })

  it('全部 clip 非法 → 空清单 + 告警（不抛错）', () => {
    const { manifest, warnings } = parseMotionIndex(validManifest([{}, validClip({ file: '../x.vmd' })]))
    expect(manifest.clips).toEqual([])
    expect(warnings.join('\n')).toContain('没有可用 clip')
  })
})

describe('isSingleSegmentVmdFileName', () => {
  it('接受单段 .vmd（含 CJK/空格）', () => {
    expect(isSingleSegmentVmdFileName('motion-idle.vmd')).toBe(true)
    expect(isSingleSegmentVmdFileName('动作 待机.VMD')).toBe(true)
    expect(isSingleSegmentVmdFileName(' motion-idle.vmd ')).toBe(true)
  })

  it('拒绝空/目录/其它扩展名/非法字符', () => {
    for (const file of ['', ' ', '.', '..', 'a/b.vmd', 'a\\b.vmd', 'a:b.vmd', 'idle.vpd', 'idle', 'x\0.vmd']) {
      expect(isSingleSegmentVmdFileName(file), `file=${JSON.stringify(file)}`).toBe(false)
    }
  })
})


describe('grounding：贴地补偿模式（D4）', () => {
  it('缺省为 feet（站/走等脚着地动作）', () => {
    const { manifest, warnings } = parseMotionIndex({
      schemaVersion: 1,
      clips: [{ id: 'idle', file: 'a.vmd', moods: ['idle'] }]
    })
    expect(warnings).toEqual([])
    expect(manifest.clips[0]!.grounding).toBe('feet')
  })

  it('允许 none（坐姿/悬垂腿等不做脚底补偿）', () => {
    const { manifest, warnings } = parseMotionIndex({
      schemaVersion: 1,
      clips: [{ id: 'sit', file: 'a.vmd', moods: ['sit'], grounding: 'none' }]
    })
    expect(warnings).toEqual([])
    expect(manifest.clips[0]!.grounding).toBe('none')
  })

  it('非法值 → 默认 feet + 告警（不丢弃 clip）', () => {
    const { manifest, warnings } = parseMotionIndex({
      schemaVersion: 1,
      clips: [{ id: 'sit', file: 'a.vmd', moods: ['sit'], grounding: 'seat' }]
    })
    expect(manifest.clips).toHaveLength(1)
    expect(manifest.clips[0]!.grounding).toBe('feet')
    expect(warnings.some((w) => w.includes('grounding'))).toBe(true)
  })
})
