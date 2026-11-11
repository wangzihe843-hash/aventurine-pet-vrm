/**
 * U2 motion manifest 构建 / 一致性校验单测。
 *
 * 全部用 `tests/fixtures/unity-bake/fixtures.ts` 的程序化 selection + clip 数据，
 * 不读私有 assets、不写文件（fs 由 CLI 负责，lib 是纯 ESM）。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  MOTION_MANIFEST_DEFAULTS,
  MOTION_MANIFEST_SCHEMA_VERSION,
  MOTION_MANIFEST_SOURCE,
  MOTION_PRIORITY_RANGE,
  MOTION_TIME_SCALE_RANGE,
  buildMotionManifest,
  validateManifestAgainstSelection
} from '../scripts/unity-bake/lib/motion-manifest.mjs'
import {
  makeClip,
  makeSelection,
  makeSelectionBundle,
  makeSelectionClip
} from './fixtures/unity-bake/fixtures'

const GENERATED_AT = '2026-11-08T00:00:00.000Z'

interface BuildResult {
  manifest: Record<string, any>
  coverage: Record<string, number>
  errors: string[]
  warnings: string[]
}

function build(
  selection: unknown,
  clips: unknown,
  generatedAt: string = GENERATED_AT
): BuildResult {
  return buildMotionManifest({ selection, clips, generatedAt }) as BuildResult
}

function expectError(result: { errors: string[] }, fragment: string): void {
  expect(
    result.errors.some((message) => message.includes(fragment)),
    `期望 errors 包含「${fragment}」，实际：\n${result.errors.join('\n')}`
  ).toBe(true)
}

function expectWarning(result: { warnings: string[] }, fragment: string): void {
  expect(
    result.warnings.some((message) => message.includes(fragment)),
    `期望 warnings 包含「${fragment}」，实际：\n${result.warnings.join('\n')}`
  ).toBe(true)
}

describe('buildMotionManifest：成功构建', () => {
  it('两个 clip（状态机槽位 + 事件类 null 槽位）构建成功且无警告', () => {
    const { selection, clips } = makeSelectionBundle()
    const result = build(selection, clips)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.manifest.schemaVersion).toBe(MOTION_MANIFEST_SCHEMA_VERSION)
    expect(result.manifest.set).toBe('mate')
    expect(result.manifest.generatedAt).toBe(GENERATED_AT)
    expect(result.manifest.source).toEqual(MOTION_MANIFEST_SOURCE)
    expect(result.manifest.defaults).toEqual(MOTION_MANIFEST_DEFAULTS)
    expect(result.manifest.checks.ok).toBe(true)
    expect(result.manifest.checks.errors).toEqual([])
    expect(result.coverage).toEqual({ idle: 1, hiding: 1 })
    expect(result.manifest.coverage).toEqual({ idle: 1, hiding: 1 })
    expect(result.manifest.clips).toHaveLength(2)
    expect(result.manifest.clips[0]).toEqual({
      id: 'idle',
      file: 'mate/idle.json',
      slot: 'idle',
      tags: ['idle'],
      loop: true,
      timeScale: 1,
      priority: 0,
      duration: 6 / 30,
      fps: 30,
      frames: 6,
      sourcePath: 'PET_IDLE/PET_IDLE.anim'
    })
    expect(result.manifest.clips[1].slot).toBeNull()
    expect(result.manifest.clips[1].id).toBe('hideLeft')
  })

  it('source 授权/再分发字段与契约一致（私有、禁止再分发）', () => {
    expect(MOTION_MANIFEST_SOURCE).toEqual({
      name: 'Mate-Engine',
      attribution: 'Shiny',
      license: 'MateEngine Pro License v2.1',
      redistribution: 'forbidden-local-only'
    })
    expect(MOTION_MANIFEST_DEFAULTS).toEqual({
      loop: true,
      timeScale: 1,
      fadeInSec: 0.15,
      fadeOutSec: 0.2,
      rootMotion: 'inPlace'
    })
  })

  it('mood → slot 映射：合法槽位 / 空串 null / 缺省 null', () => {
    const clips = { idle: makeClip({ clip: 'idle', frames: 6 }) }
    const base = { requirements: { idle: 1 }, clips: [] as Array<Record<string, unknown>> }
    for (const [mood, expectedSlot] of [
      ['idle', 'idle'],
      ['pat', 'pat'],
      ['salute', 'salute'],
      ['', null],
      [undefined, null]
    ] as const) {
      const entry = makeSelectionClip({ tags: ['idle'] })
      if (mood === undefined) delete entry.mood
      else entry.mood = mood
      const result = build(makeSelection({ ...base, clips: [entry] }), clips)
      expect(result.errors, `mood=${String(mood)}`).toEqual([])
      expect(result.manifest.clips[0].slot, `mood=${String(mood)}`).toBe(expectedSlot)
    }
  })

  it('coverage 按 tags 计数（一个 clip 可计多个 tag）', () => {
    const clips = { idle: makeClip({ clip: 'idle', frames: 6 }) }
    const selection = makeSelection({
      requirements: { idle: 1, pose: 1 },
      clips: [makeSelectionClip({ tags: ['idle', 'pose'] })]
    })
    const result = build(selection, clips)
    expect(result.errors).toEqual([])
    expect(result.coverage).toEqual({ idle: 1, pose: 1 })
  })

  it('generatedAt 缺省为可解析的 ISO 时间', () => {
    const { selection, clips } = makeSelectionBundle()
    const result = buildMotionManifest({ selection, clips }) as BuildResult
    expect(Number.isNaN(Date.parse(result.manifest.generatedAt))).toBe(false)
  })

  it('timeScale / priority 边界值合法', () => {
    const clips = { idle: makeClip({ clip: 'idle', frames: 6 }) }
    const selection = makeSelection({
      requirements: { idle: 1 },
      clips: [
        makeSelectionClip({
          tags: ['idle'],
          timeScale: MOTION_TIME_SCALE_RANGE.min,
          priority: MOTION_PRIORITY_RANGE.min
        })
      ]
    })
    const result = build(selection, clips)
    expect(result.errors).toEqual([])
    expect(result.manifest.clips[0].timeScale).toBe(MOTION_TIME_SCALE_RANGE.min)
    expect(result.manifest.clips[0].priority).toBe(MOTION_PRIORITY_RANGE.min)
  })
})

describe('buildMotionManifest：selection 字段校验', () => {
  const clips = { idle: makeClip({ clip: 'idle', frames: 6 }) }
  const buildWithEntry = (overrides: Record<string, unknown>, requirements = { idle: 1 }) =>
    build(
      makeSelection({
        requirements,
        clips: [makeSelectionClip({ tags: ['idle'], ...overrides })]
      }),
      clips
    )

  it('id 重复 → error', () => {
    const result = build(
      makeSelection({
        requirements: { idle: 1 },
        clips: [makeSelectionClip({ tags: ['idle'] }), makeSelectionClip({ tags: ['idle'] })]
      }),
      clips
    )
    expect(result.manifest.checks.ok).toBe(false)
    expectError(result, '重复')
  })

  it('id 非法字符 / 首字符为点 → error', () => {
    expectError(buildWithEntry({ name: 'bad name!' }), '非法')
    expectError(buildWithEntry({ name: '.hidden' }), '非法')
  })

  it('id 超长（>64）→ error', () => {
    const result = buildWithEntry({ name: 'a'.repeat(65) })
    expectError(result, '超长')
  })

  it('mood 非空但不在契约槽位 → error（事件类必须用 ""）', () => {
    const result = buildWithEntry({ mood: 'hiding' })
    expect(result.manifest.checks.ok).toBe(false)
    expectError(result, 'mood')
    expectError(result, '事件类')
  })

  it('tag 不在 requirements 键内 → error', () => {
    const result = buildWithEntry({ tags: ['dance'] })
    expectError(result, 'tag "dance"')
  })

  it('tags 不是数组 → error', () => {
    const result = buildWithEntry({ tags: 'idle' })
    expectError(result, 'tags 必须是数组')
  })

  it('tag 重复 → warning（覆盖只计一次）', () => {
    const result = buildWithEntry({ tags: ['idle', 'idle'] })
    expect(result.errors).toEqual([])
    expectWarning(result, '重复')
    expect(result.coverage.idle).toBe(1)
  })

  it('loop / timeScale / priority 非布尔或越界 → error', () => {
    expectError(buildWithEntry({ loop: 'yes' }), 'loop 必须是布尔值')
    expectError(buildWithEntry({ timeScale: 0.05 }), 'timeScale')
    expectError(buildWithEntry({ timeScale: 5 }), 'timeScale')
    expectError(buildWithEntry({ timeScale: '1' }), 'timeScale')
    expectError(buildWithEntry({ priority: 101 }), 'priority')
    expectError(buildWithEntry({ priority: -101 }), 'priority')
    expectError(buildWithEntry({ priority: 1.5 }), 'priority')
  })

  it('loop/timeScale/priority/note/tags 缺失 → warning + 默认值', () => {
    const entry = makeSelectionClip({ tags: ['idle'] })
    for (const key of ['loop', 'timeScale', 'priority', 'note', 'tags']) delete entry[key]
    // requirements.idle=0：本测试只关心「字段缺失 → warning + 默认值」，避免触发覆盖不足。
    const result = build(makeSelection({ requirements: { idle: 0 }, clips: [entry] }), clips)
    expect(result.errors).toEqual([])
    expectWarning(result, 'loop 缺失')
    expectWarning(result, 'timeScale 缺失')
    expectWarning(result, 'priority 缺失')
    expectWarning(result, 'note 缺失')
    expectWarning(result, 'tags 缺失')
    expect(result.manifest.clips[0].loop).toBe(true)
    expect(result.manifest.clips[0].timeScale).toBe(1)
    expect(result.manifest.clips[0].priority).toBe(0)
  })

  it('requirements 非法（负数/非整数/缺失/为空）→ error', () => {
    const entry = makeSelectionClip({ tags: ['idle'] })
    const cases = [
      makeSelection({ requirements: { idle: -1 }, clips: [entry] }),
      makeSelection({ requirements: { idle: 1.5 }, clips: [entry] }),
      { motionSet: 'mate', clips: [entry] } as unknown,
      makeSelection({ requirements: {}, clips: [entry] })
    ]
    for (const selection of cases) {
      const result = build(selection, clips)
      expect(result.errors.length, JSON.stringify(selection)).toBeGreaterThan(0)
      expect(result.manifest.checks.ok).toBe(false)
    }
  })

  it('selection 非对象 / clips 非数组 → error 且返回空 clips manifest', () => {
    for (const selection of [null, 42, 'x', { requirements: { idle: 1 } }] as unknown[]) {
      const result = build(selection, clips)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.manifest.clips).toEqual([])
      expect(result.manifest.checks.ok).toBe(false)
    }
  })

  it('motionSet 非字符串 → error；合法值写入 set', () => {
    const selection = makeSelection({
      requirements: { idle: 1 },
      clips: [makeSelectionClip({ tags: ['idle'] })]
    })
    selection.motionSet = 42
    expectError(build(selection, clips), 'motionSet')
    selection.motionSet = 'pet'
    const result = build(selection, clips)
    expect(result.errors).toEqual([])
    expect(result.manifest.set).toBe('pet')
    expect(result.manifest.clips[0].file).toBe('pet/idle.json')
  })
})

describe('buildMotionManifest：clip 数据校验', () => {
  it('selection 引用的 clip 数据缺失 → error', () => {
    const { selection } = makeSelectionBundle()
    const result = build(selection, {})
    expectError(result, '找不到 clip 数据')
  })

  it('clip 数据无效（version 非 1）→ error 带 clip 前缀', () => {
    const { selection } = makeSelectionBundle()
    const result = build(selection, { idle: makeClip({ clip: 'idle', version: 2 }), hideLeft: makeClip({ clip: 'hideLeft', frames: 6 }) })
    expect(result.manifest.checks.ok).toBe(false)
    expectError(result, 'clip "idle": version')
  })

  it('clip.loop / clip.fps / clip 名与 selection 不一致 → warning', () => {
    const selection = makeSelection({
      requirements: { idle: 1 },
      clips: [makeSelectionClip({ tags: ['idle'] })]
    })
    const clip = makeClip({ clip: 'other', frames: 6, loop: false, fps: 24 })
    const result = build(selection, { idle: clip })
    expect(result.errors).toEqual([])
    expectWarning(result, 'loop=false')
    expectWarning(result, 'fps')
    expectWarning(result, 'clip 字段为 "other"')
    expect(result.manifest.clips[0].loop).toBe(true) // manifest 以 selection 为准
  })

  it('coverage 不足 → error（含 tag 与缺口）', () => {
    const clips = { idle: makeClip({ clip: 'idle', frames: 6 }) }
    const selection = makeSelection({
      requirements: { idle: 2 },
      clips: [makeSelectionClip({ tags: ['idle'] })]
    })
    const result = build(selection, clips)
    expectError(result, '覆盖不足')
    expectError(result, 'idle')
  })
})

describe('validateManifestAgainstSelection', () => {
  const { selection, clips } = makeSelectionBundle()
  const fresh = build(selection, clips)
  const check = (manifest: unknown, sel: unknown = selection, clipMap: unknown = clips) =>
    validateManifestAgainstSelection(manifest, sel, clipMap) as {
      ok: boolean
      errors: string[]
      warnings: string[]
    }

  it('刚构建的 manifest 一致 → ok', () => {
    const result = check(fresh.manifest)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('只差 generatedAt（时点）不影响一致性（以磁盘值为基准重建）', () => {
    const other = build(selection, clips, '2020-01-01T00:00:00.000Z')
    const result = check(other.manifest)
    expect(result.ok).toBe(true)
  })

  it('字段被篡改（priority/duration）→ error', () => {
    const tampered = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
    tampered.clips[0].priority = 5
    expect(check(tampered).ok).toBe(false)
    expectError(check(tampered), '不一致')

    const tamperedDuration = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
    tamperedDuration.clips[1].duration = 99
    expect(check(tamperedDuration).ok).toBe(false)
  })

  it('缺 clip / 多 clip → error', () => {
    const missing = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
    missing.clips = missing.clips.slice(0, 1)
    const missingResult = check(missing)
    expectError(missingResult, '缺少 clip')
    expectError(missingResult, '数量')

    const extra = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
    extra.clips.push({ ...extra.clips[0], id: 'ghost' })
    expectError(check(extra), '多余 clip')
  })

  it('coverage 被篡改 → error', () => {
    const tampered = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
    tampered.coverage = { idle: 99 }
    expectError(check(tampered), 'coverage')
  })

  it('schemaVersion 非 1 → error', () => {
    const tampered = { ...fresh.manifest, schemaVersion: 2 }
    const result = check(tampered)
    expect(result.ok).toBe(false)
    expectError(result, 'schemaVersion')
  })

  it('manifest 非对象 → error', () => {
    for (const value of [null, 42, 'x', []]) {
      const result = check(value)
      expect(result.ok).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })

  it('磁盘 checks.ok=false → error', () => {
    const tampered = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
    tampered.checks = { ok: false, errors: [], warnings: [] }
    expectError(check(tampered), 'checks.ok=false')
  })

  it('set/source/defaults 不一致 → error', () => {
    for (const mutate of [
      (manifest: Record<string, any>) => (manifest.set = 'other'),
      (manifest: Record<string, any>) => (manifest.source = { name: 'X' }),
      (manifest: Record<string, any>) => (manifest.defaults = { loop: false })
    ]) {
      const tampered = JSON.parse(JSON.stringify(fresh.manifest)) as Record<string, any>
      mutate(tampered)
      expect(check(tampered).ok).toBe(false)
    }
  })

  it('selection / clip 数据本身无效 → 不一致（errors 透传）', () => {
    const badSelection = { ...selection, clips: [{ ...(selection.clips as any[])[0], mood: 'dancing' }] }
    const result = check(fresh.manifest, badSelection)
    expect(result.ok).toBe(false)
    expectError(result, 'mood')

    const badClips = { ...(clips as Record<string, unknown>), idle: makeClip({ clip: 'idle', version: 2 }) }
    const result2 = check(fresh.manifest, selection, badClips)
    expect(result2.ok).toBe(false)
    expectError(result2, 'version')
  })
})
