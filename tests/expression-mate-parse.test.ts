/**
 * V6 表情层：Mate-Engine `.anim` 解析/映射/配置单测（fixture 驱动，不读私有 assets）。
 *
 * 覆盖：
 * - Unity `.anim` YAML `m_FloatCurves` 解析（attribute + 关键帧 + 元数据）；
 * - VRM0 表达名 → VRM1 preset 映射（neutral 丢弃 / fun→relaxed / 大小写）；
 * - 重采样到 30fps、loop/non-loop 帧数、越界 clamp、全零轨道裁剪；
 * - 配置校验（重复 id / 非法 file / 缺省值）；
 * - 别名表与 `src/shared/expression-contract.ts` 一致。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  extractMateFaceClip,
  extractMateFaceClipsBundle,
  mapMateAttributeToTrack,
  parseUnityAnimationClip,
  validateMateFaceConfig,
  MATE_FACE_ALIASES
} from '../scripts/vrm/expression/lib/mate-face.mjs'
import { VRM0_EXPRESSION_ALIASES } from '../src/shared/expression-contract'
import type { ExpressionClip } from '../src/shared/expression-contract'

const FIXTURES = fileURLToPath(new URL('./fixtures/expression', import.meta.url))
const faceAnim = readFileSync(`${FIXTURES}/anim/FACE_TEST.anim`, 'utf8')
const petAnim = readFileSync(`${FIXTURES}/anim/PET_TEST.anim`, 'utf8')
const config = JSON.parse(readFileSync(`${FIXTURES}/mate-face-config.json`, 'utf8'))

describe('expression-mate：Unity .anim 解析', () => {
  it('FACE_TEST：m_Name/sampleRate/stopTime/loopTime + 3 条 blendshape 曲线', () => {
    const parsed = parseUnityAnimationClip(faceAnim)
    expect(parsed.name).toBe('FACE_TEST')
    expect(parsed.sampleRate).toBe(60)
    expect(parsed.stopTime).toBe(1)
    expect(parsed.duration).toBe(1)
    expect(parsed.loopTime).toBe(true)
    expect(Object.keys(parsed.curves).sort()).toEqual(['Blink', 'Joy', 'Neutral'])
    expect(parsed.curves.Joy).toEqual([
      [0, 0.2, 0, 0],
      [0.5, 1, 0, 0],
      [1, 0.2, 0, 0]
    ])
    expect(parsed.warnings).toEqual([])
  })

  it('PET_TEST：非 loop 源；O 源值 1.4 保留原值（映射阶段再 clamp）', () => {
    const parsed = parseUnityAnimationClip(petAnim)
    expect(parsed.loopTime).toBe(false)
    expect(parsed.curves.O).toEqual([
      [0, 0, 0, 0],
      [1, 1.4, 0, 0]
    ])
    expect(parsed.curves.Angry).toEqual([
      [0, 1, 0, 0],
      [1, 1, 0, 0]
    ])
  })

  it('无 m_FloatCurves / 空文本 → 空曲线 + warning（不抛）', () => {
    expect(parseUnityAnimationClip('AnimationClip:\n  m_Name: X\n').curves).toEqual({})
    expect(parseUnityAnimationClip('').warnings.length).toBeGreaterThan(0)
    expect(parseUnityAnimationClip(null).curves).toEqual({})
  })
})

describe('expression-mate：attribute → 目标 expression 映射', () => {
  it('VRM0 名映射（大小写不敏感）、neutral 丢弃、blendShape.* 丢弃、未知 null', () => {
    expect(mapMateAttributeToTrack('Joy')).toEqual({ track: 'happy' })
    expect(mapMateAttributeToTrack('SORROW')).toEqual({ track: 'sad' })
    expect(mapMateAttributeToTrack('Blink_L')).toEqual({ track: 'blinkLeft' })
    expect(mapMateAttributeToTrack('a')).toEqual({ track: 'aa' })
    expect(mapMateAttributeToTrack('Neutral').track).toBeNull()
    expect(mapMateAttributeToTrack('blendShape.まばたき').track).toBeNull()
    expect(mapMateAttributeToTrack('Head Nod Down-Up').track).toBeNull()
    expect(mapMateAttributeToTrack('').track).toBeNull()
    // 已是 VRM1 preset 名也接受
    expect(mapMateAttributeToTrack('surprised')).toEqual({ track: 'surprised' })
  })

  it('别名表与 shared VRM0_EXPRESSION_ALIASES 对齐（mate 覆盖全部 VRM0 名）', () => {
    for (const [source, target] of Object.entries(MATE_FACE_ALIASES)) {
      expect(VRM0_EXPRESSION_ALIASES[source], `别名 ${source}`).toBe(target)
    }
    // shared 里的 VRM0 源名（小写）必须都能在 mate 别名表里查到（VRM1 自名不强求）。
    const vrm0SourceNames = [
      'joy',
      'angry',
      'sorrow',
      'fun',
      'neutral',
      'blink',
      'blink_l',
      'blink_r',
      'a',
      'i',
      'u',
      'e',
      'o'
    ]
    for (const source of vrm0SourceNames) {
      expect(MATE_FACE_ALIASES[source], `shared 别名 ${source}`).toBe(
        VRM0_EXPRESSION_ALIASES[source]
      )
    }
  })
})

describe('expression-mate：clip 提取（重采样/帧数/clamp/裁剪）', () => {
  it('FACE_TEST loop：30 帧 (1s@30fps)、Joy→happy、Blink→blink、Neutral 丢弃', () => {
    const { clip, stats } = extractMateFaceClip(faceAnim, {
      id: 'faceTest',
      sourceFile: 'anim/FACE_TEST.anim',
      fps: 30,
      loop: true
    })
    expect(clip.fps).toBe(30)
    expect(clip.frames).toBe(30)
    expect(clip.duration).toBe(1)
    expect(clip.loop).toBe(true)
    expect(Object.keys(clip.tracks).sort()).toEqual(['blink', 'happy'])
    expect(clip.tracks.happy).toHaveLength(30)
    // 中点约 1.0
    expect(clip.tracks.happy[15]).toBe(1)
    expect(clip.tracks.happy[14]).toBeGreaterThan(0.9)
    expect(clip.tracks.blink[0]).toBe(0)
    expect(clip.tracks.blink[14]).toBeGreaterThan(0.9)
    expect(stats.usedTracks).toEqual(
      expect.arrayContaining([
        { attribute: 'Joy', track: 'happy' },
        { attribute: 'Blink', track: 'blink' }
      ])
    )
    expect(stats.droppedAttributes.some((item: { attribute: string }) => item.attribute === 'Neutral')).toBe(true)
  })

  it('PET_TEST 非 loop：31 帧、A→aa、Angry→angry、O 源 1.4 clamp 到 1', () => {
    const { clip } = extractMateFaceClip(petAnim, { id: 'petTest', fps: 30, loop: false })
    expect(clip.frames).toBe(31)
    expect(clip.loop).toBe(false)
    expect(Object.keys(clip.tracks).sort()).toEqual(['aa', 'angry', 'oh'])
    expect(clip.tracks.angry.every((value: number) => value === 1)).toBe(true)
    // A 源 max 0.8 → aa；O 源 1.4 越界 clamp 到 1 → oh
    expect(Math.max(...clip.tracks.aa)).toBe(0.8)
    expect(Math.max(...clip.tracks.oh)).toBe(1)
    expect(clip.tracks.aa[clip.tracks.aa.length - 1]).toBe(0)
  })

  it('scale 作用到所有轨道（0.5 = 半强度）', () => {
    const { clip } = extractMateFaceClip(petAnim, { id: 'scaled', fps: 30, loop: false, scale: 0.5 })
    expect(Math.max(...clip.tracks.angry)).toBe(0.5)
    expect(Math.max(...clip.tracks.aa)).toBe(0.4)
  })

  it('duration 非法/曲线为空 → 抛错（CLI 转成 exit 1）', () => {
    expect(() => extractMateFaceClip('AnimationClip:\n  m_Name: X\n', { id: 'x' })).toThrow(/duration/)
  })

  it('生成 clip 与 shared sanitize 后的形状兼容（可直接被 V6 消费）', () => {
    const { clip } = extractMateFaceClip(faceAnim, { id: 'faceTest', fps: 30, loop: true })
    const typed = clip as unknown as ExpressionClip
    expect(typed.schemaVersion).toBe(1)
    expect(typed.source).toBe('mate')
    expect(typeof typed.tracks.happy[0]).toBe('number')
  })
})

describe('expression-mate：配置校验 / 批量', () => {
  it('合法配置解析并回填默认值', () => {
    const { clips, errors } = validateMateFaceConfig(config)
    expect(errors).toEqual([])
    expect(clips).toHaveLength(2)
    expect(clips[0].id).toBe('faceTest')
    expect(clips[1].loop).toBe(false)
    expect(clips[1].priority).toBe(2)
  })

  it('配置错误：重复 id / 非法 file / 缺 id / 非对象', () => {
    const { clips, errors } = validateMateFaceConfig({
      clips: [
        { id: 'a', file: 'X.anim' },
        { id: 'a', file: 'Y.anim' },
        { id: 'b', file: '/abs.anim' },
        { id: 'c', file: '../escape.anim' },
        { file: 'no-id.anim' },
        'nope'
      ]
    })
    expect(clips.map((item: { id: string }) => item.id)).toEqual(['a'])
    expect(errors.length).toBeGreaterThanOrEqual(5)
  })

  it('extractMateFaceClipsBundle：注入 readFile，逐 clip 提取 + 报告', () => {
    const files: Record<string, string> = {
      'FACE_TEST.anim': faceAnim,
      'PET_TEST.anim': petAnim
    }
    const bundle = extractMateFaceClipsBundle({
      animDir: 'fake-dir',
      config,
      readFile: (filePath: string) => {
        const base = filePath.split('/').pop() ?? ''
        if (!(base in files)) throw new Error(`not found: ${filePath}`)
        return files[base]!
      }
    })
    expect(bundle.errors).toEqual([])
    expect(bundle.clips.map((item: { clip: { id: string } }) => item.clip.id)).toEqual(['faceTest', 'petTest'])
    expect(bundle.reports).toHaveLength(2)
    expect(bundle.reports[0].trackCount).toBe(2)
  })

  it('extractMateFaceClipsBundle：文件缺失 → errors（不抛）', () => {
    const bundle = extractMateFaceClipsBundle({
      animDir: 'fake-dir',
      config,
      readFile: () => {
        throw new Error('boom')
      }
    })
    expect(bundle.clips).toEqual([])
    expect(bundle.errors).toHaveLength(2)
  })
})
