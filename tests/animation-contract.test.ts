/**
 * W0-3 契约单测：动画（humanoid clip）契约（`src/shared/animation-contract.ts` +
 * `src/shared/motion-manifest.json`）。
 *
 * 冻结护栏：
 * - 动作槽位 = PetMood 全集 + `salute`（不新增 PetMood 语义）；
 * - 后端 flag：env > config > 默认 vrm；
 * - `sanitizeAnimationClipManifest` 对脏输入不抛异常，缺省值/钳制/去重行为冻结；
 * - `findAnimationClip` 的 priority 选择规则冻结；
 * - 提交的 `motion-manifest.json` 零 warning（W0 阶段为空集，V3 填充数据）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  ANIMATION_BACKEND_ENV,
  ANIMATION_CLIP_DEFAULTS,
  ANIMATION_CLIP_FADE_RANGE,
  ANIMATION_CLIP_MOODS,
  ANIMATION_CLIP_TIME_SCALE_RANGE,
  ANIMATION_MANIFEST_SCHEMA_VERSION,
  DEFAULT_MOTION_SET_ID,
  EMPTY_ANIMATION_CLIP_MANIFEST,
  MOTION_SET_ID_MAX_LENGTH,
  findAnimationClip,
  hasAnimationClip,
  isAnimationClipMood,
  parseAnimationBackend,
  resolveAnimationBackend,
  sanitizeAnimationClipManifest
} from '@shared/animation-contract'
import { ANIMATION_BACKENDS, PET_MOODS } from '@shared/types'
import type { AnimationClipManifestInput } from '@shared/animation-contract'
import type { AnimationBackend } from '@shared/types'

const MOTION_MANIFEST_PATH = fileURLToPath(
  new URL('../src/shared/motion-manifest.json', import.meta.url)
)

function readCommittedMotionManifest(): unknown {
  return JSON.parse(readFileSync(MOTION_MANIFEST_PATH, 'utf8'))
}

describe('动作槽位契约（PetMood 全集 + salute）', () => {
  it('槽位 = 12 个 PetMood + salute；唯一、无重复', () => {
    expect(ANIMATION_CLIP_MOODS).toHaveLength(PET_MOODS.length + 1)
    expect(ANIMATION_CLIP_MOODS).toEqual([...PET_MOODS, 'salute'])
    expect(new Set(ANIMATION_CLIP_MOODS).size).toBe(ANIMATION_CLIP_MOODS.length)
  })

  it('isAnimationClipMood 只接受白名单', () => {
    for (const mood of ANIMATION_CLIP_MOODS) expect(isAnimationClipMood(mood)).toBe(true)
    expect(isAnimationClipMood('run')).toBe(false)
    expect(isAnimationClipMood('Salute')).toBe(false)
    expect(isAnimationClipMood(undefined)).toBe(false)
  })
})

describe('动画后端 flag（env > config > 默认 vrm）', () => {
  it('常量与默认动作集冻结', () => {
    expect(ANIMATION_BACKENDS).toEqual(['vrm', 'legacy-pmx'])
    expect(ANIMATION_BACKEND_ENV).toBe('PET_ANIM_BACKEND')
    expect(DEFAULT_MOTION_SET_ID).toBe('default')
    expect(MOTION_SET_ID_MAX_LENGTH).toBe(64)
  })

  it('parseAnimationBackend：非法/缺失返回 null', () => {
    expect(parseAnimationBackend('vrm')).toBe('vrm')
    expect(parseAnimationBackend(' legacy-pmx ')).toBe('legacy-pmx')
    expect(parseAnimationBackend('VMD')).toBeNull()
    expect(parseAnimationBackend(undefined)).toBeNull()
  })

  it('resolveAnimationBackend 优先级', () => {
    expect(resolveAnimationBackend('legacy-pmx', 'vrm')).toBe('legacy-pmx')
    expect(resolveAnimationBackend(undefined, 'legacy-pmx')).toBe('legacy-pmx')
    expect(resolveAnimationBackend('nope', 'legacy-pmx')).toBe('legacy-pmx')
    expect(resolveAnimationBackend(undefined, 'nope' as never)).toBe('vrm')
  })
})

describe('clip 默认参数冻结', () => {
  it('loop=true / timeScale=1 / fade 0.15,0.2 / priority=0', () => {
    expect(ANIMATION_CLIP_DEFAULTS).toEqual({
      loop: true,
      timeScale: 1,
      fadeInSec: 0.15,
      fadeOutSec: 0.2,
      priority: 0
    })
    expect(ANIMATION_CLIP_TIME_SCALE_RANGE).toEqual({ min: 0.1, max: 4 })
    expect(ANIMATION_CLIP_FADE_RANGE).toEqual({ min: 0, max: 2 })
  })
})

describe('sanitizeAnimationClipManifest：提交的 motion-manifest.json', () => {
  it('零 warning，W0 阶段 clips 为空（V3 填充数据，不改契约）', () => {
    const result = sanitizeAnimationClipManifest(readCommittedMotionManifest())
    expect(result.warnings).toEqual([])
    expect(result.value.schemaVersion).toBe(ANIMATION_MANIFEST_SCHEMA_VERSION)
    expect(result.value.clips).toEqual([])
  })
})

describe('sanitizeAnimationClipManifest：合法条目归一化', () => {
  it('省略可选字段 → 回填默认值（rootMotion null = 未声明）', () => {
    const result = sanitizeAnimationClipManifest({
      schemaVersion: 1,
      clips: [{ id: 'idle-soft', mood: 'idle', file: 'motions/default/idle.glb' }]
    })
    expect(result.warnings).toEqual([])
    expect(result.value.clips).toEqual([
      {
        id: 'idle-soft',
        mood: 'idle',
        file: 'motions/default/idle.glb',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.15,
        fadeOutSec: 0.2,
        rootMotion: null,
        priority: 0
      }
    ])
  })

  it('显式字段透传（含 salute 槽位 / inPlace / loop=false / priority）', () => {
    const result = sanitizeAnimationClipManifest({
      schemaVersion: 1,
      clips: [
        {
          id: 'salute-a',
          mood: 'salute',
          file: 'motions/default/salute.vrma',
          loop: false,
          timeScale: 1.25,
          fadeInSec: 0.3,
          fadeOutSec: 0.4,
          rootMotion: 'inPlace',
          priority: 10
        }
      ]
    })
    expect(result.warnings).toEqual([])
    expect(result.value.clips[0]).toMatchObject({
      id: 'salute-a',
      mood: 'salute',
      loop: false,
      timeScale: 1.25,
      fadeInSec: 0.3,
      fadeOutSec: 0.4,
      rootMotion: 'inPlace',
      priority: 10
    })
  })
})

describe('sanitizeAnimationClipManifest：脏输入与钳制', () => {
  it('非对象 / schemaVersion 非 1 → 空 manifest + warning，不抛异常', () => {
    for (const bad of [undefined, null, 3, 'x', [], { schemaVersion: 2 }]) {
      const result = sanitizeAnimationClipManifest(bad)
      expect(result.value).toEqual(EMPTY_ANIMATION_CLIP_MANIFEST)
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })

  it('clips 缺省 → 空数组且无 warning；clips 非数组 → 空数组 + warning', () => {
    const absent = sanitizeAnimationClipManifest({ schemaVersion: 1 })
    expect(absent.value.clips).toEqual([])
    expect(absent.warnings).toEqual([])
    const wrong = sanitizeAnimationClipManifest({ schemaVersion: 1, clips: {} })
    expect(wrong.value.clips).toEqual([])
    expect(wrong.warnings.length).toBeGreaterThan(0)
  })

  it('非法 clip（坏 id / 未知 mood / 不安全 file / 非对象）丢弃，其余保留', () => {
    const result = sanitizeAnimationClipManifest({
      schemaVersion: 1,
      clips: [
        null,
        { id: '..bad', mood: 'idle', file: 'motions/a.glb' },
        { id: 'bad-mood', mood: 'run', file: 'motions/a.glb' },
        { id: 'bad-file', mood: 'idle', file: '/etc/passwd' },
        { id: 'good', mood: 'walk', file: 'motions/walk.glb' }
      ]
    })
    expect(result.value.clips.map((clip) => clip.id)).toEqual(['good'])
    expect(result.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('重复 id 只保留第一个', () => {
    const result = sanitizeAnimationClipManifest({
      schemaVersion: 1,
      clips: [
        { id: 'dup', mood: 'idle', file: 'motions/a.glb' },
        { id: 'dup', mood: 'walk', file: 'motions/b.glb' }
      ]
    })
    expect(result.value.clips).toHaveLength(1)
    expect(result.value.clips[0].mood).toBe('idle')
    expect(result.warnings.some((warning) => warning.includes('重复'))).toBe(true)
  })

  it('数值越界钳制：timeScale [0.1,4]、fade [0,2]、priority [-100,100]', () => {
    const result = sanitizeAnimationClipManifest({
      schemaVersion: 1,
      clips: [
        {
          id: 'clamp',
          mood: 'walk',
          file: 'motions/w.glb',
          timeScale: 99,
          fadeInSec: -1,
          fadeOutSec: 9,
          priority: 500
        }
      ]
    })
    const clip = result.value.clips[0]
    expect(clip.timeScale).toBe(4)
    expect(clip.fadeInSec).toBe(0)
    expect(clip.fadeOutSec).toBe(2)
    expect(clip.priority).toBe(100)
    expect(result.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('rootMotion 只接受 inPlace；非法值忽略为 null + warning', () => {
    const result = sanitizeAnimationClipManifest({
      schemaVersion: 1,
      clips: [{ id: 'x', mood: 'walk', file: 'motions/w.glb', rootMotion: 'root' }]
    })
    expect(result.value.clips[0].rootMotion).toBeNull()
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('任意 JSON 垃圾输入不抛异常', () => {
    const samples: AnimationClipManifestInput[] = [{ schemaVersion: 1, clips: [] }]
    expect(() => sanitizeAnimationClipManifest(samples)).not.toThrow()
    expect(() =>
      sanitizeAnimationClipManifest(JSON.parse('{"schemaVersion":1,"clips":[1,"x",[]]}'))
    ).not.toThrow()
  })
})

describe('findAnimationClip：priority 高者优先，同优先级取靠前者', () => {
  const manifest = sanitizeAnimationClipManifest({
    schemaVersion: 1,
    clips: [
      { id: 'walk-a', mood: 'walk', file: 'motions/walk-a.glb' },
      { id: 'walk-b', mood: 'walk', file: 'motions/walk-b.glb', priority: 5 },
      { id: 'walk-c', mood: 'walk', file: 'motions/walk-c.glb', priority: 5 },
      { id: 'idle-a', mood: 'idle', file: 'motions/idle.glb' }
    ]
  }).value

  it('返回最高 priority（同优先级先出现者）', () => {
    expect(findAnimationClip(manifest, 'walk')?.id).toBe('walk-b')
    expect(findAnimationClip(manifest, 'idle')?.id).toBe('idle-a')
  })

  it('无匹配槽位 → null；hasAnimationClip 同步', () => {
    expect(findAnimationClip(manifest, 'sleep')).toBeNull()
    expect(hasAnimationClip(manifest, 'sleep')).toBe(false)
    expect(hasAnimationClip(manifest, 'walk')).toBe(true)
  })

  it('空 manifest 永不命中', () => {
    for (const mood of ANIMATION_CLIP_MOODS) {
      expect(findAnimationClip(EMPTY_ANIMATION_CLIP_MANIFEST, mood)).toBeNull()
    }
  })
})

describe('后端类型可赋给配置类型（编译期锚点）', () => {
  it('AnimationBackend 与配置项同型', () => {
    const backend: AnimationBackend = 'vrm'
    const resolved: AnimationBackend = resolveAnimationBackend(undefined, backend)
    expect(resolved).toBe('vrm')
    expect(ANIMATION_BACKENDS).toContain(resolved)
  })
})
