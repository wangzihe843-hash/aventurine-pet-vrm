/**
 * U2 clip 数据校验规则的单测：每条规则都覆盖「合法正例 + 非法反例」。
 *
 * 数据全部来自 `tests/fixtures/unity-bake/fixtures.ts` 的程序化 fixture，
 * 不读私有 assets、不写任何文件。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  CLIP_VALIDATION_LIMITS,
  computeHipsStats,
  computeRotationMetrics,
  validateClipData
} from '../scripts/unity-bake/lib/clip-validation.mjs'
// @ts-expect-error -- 同上
import { CLIP_OPTIONAL_BONES, CLIP_REQUIRED_BONES } from '../scripts/unity-bake/lib/humanoid-map.mjs'
import {
  axisAngleQuat,
  fingerExtraBones,
  identityQuat,
  makeClip,
  toFlatClip,
  type Quat
} from './fixtures/unity-bake/fixtures'

interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  stats: Record<string, any>
}

const validate = (clip: Record<string, unknown>, options?: Record<string, unknown>): ValidationResult =>
  validateClipData(clip, options) as ValidationResult

/** 构造 n 帧四元数数组（nested 形状）。 */
const quatFrames = (frames: number, at: (frame: number) => Quat = () => identityQuat()): Quat[] =>
  Array.from({ length: frames }, (_value, frame) => at(frame))

/** 断言 errors 里有一条包含 fragment 的消息。 */
function expectError(result: ValidationResult, fragment: string): void {
  const matched = result.errors.some((message) => message.includes(fragment))
  expect(
    matched,
    `期望 errors 包含「${fragment}」，实际：\n${result.errors.join('\n')}`
  ).toBe(true)
}

/** 断言 warnings 里有一条包含 fragment 的消息。 */
function expectWarning(result: ValidationResult, fragment: string): void {
  const matched = result.warnings.some((message) => message.includes(fragment))
  expect(
    matched,
    `期望 warnings 包含「${fragment}」，实际：\n${result.warnings.join('\n')}`
  ).toBe(true)
}

describe('validateClipData：合法数据', () => {
  it('默认 fixture（22 骨 / 5 帧 / loop / 缓变四元数）PASS 且无警告', () => {
    const result = validate(makeClip({ frames: 5 }))
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.stats.frames).toBe(5)
    expect(result.stats.boneCount).toBe(22)
    expect(result.stats.missingBones).toEqual([])
    expect(result.stats.hasHipsPosition).toBe(true)
    expect(result.stats.quatNorm.min).toBeCloseTo(1, 6)
    expect(result.stats.quatNorm.max).toBeCloseTo(1, 6)
    expect(result.stats.quatNorm.mean).toBeCloseTo(1, 6)
    expect(result.stats.maxFrameJumpDeg).toBeCloseTo(0.5, 3)
  })

  it('flat 平铺形状（r 长度 = frames*4、p 长度 = frames*3）同样 PASS', () => {
    const flat = toFlatClip(makeClip({ frames: 6 }))
    const hips = (flat.bones as Record<string, { r: number[]; p: number[] }>).Hips
    expect(hips.r).toHaveLength(6 * 4)
    expect(hips.p).toHaveLength(6 * 3)
    const result = validate(flat)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('非 loop clip 允许 frames = round(duration*fps)+1（含真实 happy.json 的舍入形态）', () => {
    const result = validate(
      makeClip({ loop: false, frames: 197, fps: 30, duration: 6.55 })
    )
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('非 loop 允许 round(duration*fps)（C#/JS .5 舍入差异容差 ±1 帧）', () => {
    // duration*fps = 196.5000…，JS round = 197；exporter C# banker's round 会得 196→ +1 = 197
    const result = validate(makeClip({ loop: false, frames: 197, fps: 30, duration: 197 / 30 }))
    expect(result.errors).toEqual([])
  })

  it('stats 输出四元数模长/帧跳变/循环接缝/Hips 位移', () => {
    const result = validate(makeClip({ frames: 5 }))
    expect(result.stats.loopSeamMaxAngleDeg).toBeCloseTo(2, 3) // 0.5° → 2.5°，首末差 2°
    expect(result.stats.maxFrameJumpBone).toBeTruthy()
    expect(result.stats.hipsTravel).toBeCloseTo(0, 6)
    expect(result.stats.hipsMaxStep).toBeCloseTo(0, 6)
    expect(result.stats.hipsLateralDrift).toBeCloseTo(0, 6)
  })
})

describe('validateClipData：顶层字段', () => {
  it.each([
    ['version 非 1', makeClip({ version: 2 }), 'version'],
    ['space 非 gltf-rh', makeClip({ space: 'unity-lh' }), 'space'],
    ['fps 为 0', makeClip({ fps: 0 }), 'fps'],
    ['fps 为负', makeClip({ fps: -30 }), 'fps'],
    ['fps 为字符串', makeClip({ fps: '30' as unknown as number }), 'fps'],
    ['frames 为 0', makeClip({ frames: 0 }), 'frames'],
    ['frames 为小数', makeClip({ frames: 5.5 }), 'frames'],
    ['frames 为字符串', makeClip({ frames: '5' as unknown as number }), 'frames'],
    ['duration 为 0', makeClip({ duration: 0 }), 'duration']
  ])('%s → error', (_label, clip, fragment) => {
    const result = validate(clip as Record<string, unknown>)
    expect(result.ok).toBe(false)
    expectError(result, fragment)
  })

  it('loop 缺失 / 非布尔 → error（player 需要明确循环语义）', () => {
    const missing = makeClip() as Record<string, unknown>
    delete missing.loop
    expectError(validate(missing), 'loop')
    const bad = validate(makeClip({ loop: 'yes' as unknown as boolean }))
    expect(bad.ok).toBe(false)
    expectError(bad, 'loop')
  })

  it('frames 与 duration*fps 不一致（loop）→ error', () => {
    const result = validate(makeClip({ loop: true, frames: 5, fps: 30, duration: 1 }))
    expect(result.ok).toBe(false)
    expectError(result, 'frames 与 duration*fps 不一致')
  })

  it('frames 与 duration*fps 不一致（非 loop）→ error', () => {
    const result = validate(makeClip({ loop: false, frames: 100, fps: 30, duration: 6.55 }))
    expect(result.ok).toBe(false)
    expectError(result, '非 loop')
  })
})

describe('validateClipData：骨骼集合', () => {
  it('缺任一必需骨 → error', () => {
    const result = validate(makeClip({ omitBones: ['Neck'] }))
    expect(result.ok).toBe(false)
    expectError(result, '缺少必需骨骼 Neck')
    expect(result.stats.missingBones).toEqual(['Neck'])
  })

  it('requiredBones 收窄后，显式 optionalBones 缺失 → warning（不阻断）', () => {
    const requiredBones = CLIP_REQUIRED_BONES.filter((bone: string) => bone !== 'Neck')
    const result = validate(makeClip({ omitBones: ['Neck'] }), { requiredBones, optionalBones: ['Neck'] })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expectWarning(result, '可选骨骼 Neck 缺失')
  })

  it('30 手指齐全 + optionalBones=CLIP_OPTIONAL_BONES → 无警告；缺一根 → warning', () => {
    const withFingers = makeClip({ extraBones: fingerExtraBones(5) })
    const ok = validate(withFingers, { optionalBones: CLIP_OPTIONAL_BONES })
    expect(ok.errors).toEqual([])
    expect(ok.warnings).toEqual([])

    const missingOne = makeClip({ extraBones: fingerExtraBones(5) })
    const bones = (missingOne as { bones: Record<string, unknown> }).bones
    delete bones.LeftThumbProximal
    const bad = validate(missingOne, { optionalBones: CLIP_OPTIONAL_BONES })
    expect(bad.ok).toBe(true)
    expectWarning(bad, '可选骨骼 LeftThumbProximal 缺失')
  })

  it('显式 optionalBones 缺失 → warning', () => {
    const requiredBones = CLIP_REQUIRED_BONES.filter((bone: string) => bone !== 'RightToes')
    const result = validate(makeClip({ omitBones: ['RightToes'] }), {
      requiredBones,
      optionalBones: ['RightToes']
    })
    expect(result.ok).toBe(true)
    expectWarning(result, '可选骨骼 RightToes 缺失')
  })

  it('未知骨骼 → warning（播放时忽略）', () => {
    const result = validate(
      makeClip({ extraBones: { Tail: { r: quatFrames(5) } } })
    )
    expect(result.ok).toBe(true)
    expectWarning(result, '未知骨骼 Tail')
    expect(result.stats.extraBones).toEqual(['Tail'])
  })
})

describe('validateClipData：r 轨道', () => {
  it('nested r 帧数与 frames 不一致 → error', () => {
    const result = validate(makeClip({ bones: { Hips: { r: quatFrames(4), p: quatFrames(5).map(() => [0, 0, 0]) } } }))
    expect(result.ok).toBe(false)
    expectError(result, 'Hips: r 长度 4')
  })

  it('flat r 长度不是 frames*4 → error', () => {
    const flat = toFlatClip(makeClip())
    const hips = (flat.bones as Record<string, { r: number[] }>).Hips
    flat.bones = { ...(flat.bones as Record<string, unknown>), Hips: { r: hips.r.slice(0, hips.r.length - 1) } }
    const result = validate(flat)
    expect(result.ok).toBe(false)
    expectError(result, 'frames*4')
  })

  it('r 含 NaN → error', () => {
    const r = quatFrames(5)
    r[2] = [Number.NaN, 0, 0, 1]
    const result = validate(makeClip({ bones: { Spine: { r } } }))
    expect(result.ok).toBe(false)
    expectError(result, '非有限值')
  })

  it('四元数模长偏离 1 超过 1e-3 → error', () => {
    const r = quatFrames(5, () => [0, 0, 0, 1.1])
    const result = validate(makeClip({ bones: { Spine: { r } } }))
    expect(result.ok).toBe(false)
    expectError(result, '四元数模长越界')
  })

  it('相邻帧四元数 dot<0（符号翻转）→ error', () => {
    const r = quatFrames(5, (frame) => (frame === 1 ? [0, 0, 0, -1] : identityQuat()))
    const result = validate(makeClip({ bones: { Neck: { r } } }))
    expect(result.ok).toBe(false)
    expectError(result, 'dot<0')
  })

  it('相邻帧旋转跳变 >60° → warning（数据仍 ok）', () => {
    const r = quatFrames(5, (frame) => (frame >= 1 ? axisAngleQuat([0, 0, 1], 90) : identityQuat()))
    const result = validate(makeClip({ bones: { Neck: { r } } }))
    expect(result.ok).toBe(true)
    expectWarning(result, '相邻帧旋转跳变')
  })

  it('limits 可覆盖阈值（单测用）', () => {
    const result = validate(makeClip(), { limits: { frameJumpWarnDeg: 0.1 } })
    expect(result.ok).toBe(true)
    expectWarning(result, '相邻帧旋转跳变')
  })
})

describe('validateClipData：Hips 位移 p', () => {
  it('非 Hips 骨带 p → error', () => {
    const result = validate(
      makeClip({
        bones: {
          Spine: { r: quatFrames(5), p: quatFrames(5).map(() => [0, 0, 0]) }
        }
      })
    )
    expect(result.ok).toBe(false)
    expectError(result, '只有 Hips 允许 p')
  })

  it('p 长度与 frames 不一致 → error', () => {
    const result = validate(makeClip({ bones: { Hips: { r: quatFrames(5), p: [[0, 0, 0]] } } }))
    expect(result.ok).toBe(false)
    expectError(result, 'Hips: p 长度')
  })

  it('p 含非有限值 → error', () => {
    const p = [[0, 0, 0], [Number.POSITIVE_INFINITY, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const result = validate(makeClip({ bones: { Hips: { r: quatFrames(5), p } } }))
    expect(result.ok).toBe(false)
    expectError(result, 'Hips: p[1]')
  })

  it('p 首帧未归零 → error', () => {
    const result = validate(makeClip({ hipsAt: () => [0.5, 0, 0] }))
    expect(result.ok).toBe(false)
    expectError(result, 'p 首帧未归零')
  })

  it('Hips 单帧位移 >0.1m → warning', () => {
    const result = validate(makeClip({ hipsAt: (frame) => (frame === 1 ? [0.5, 0, 0] : [0, 0, 0]) }))
    expect(result.ok).toBe(true)
    expectWarning(result, '单帧位移')
  })

  it('Hips 总位移 >25m → warning', () => {
    const result = validate(makeClip({ hipsAt: (frame) => [frame * 10, 0, 0] }))
    expect(result.ok).toBe(true)
    expectWarning(result, '总位移')
  })

  it('loop clip Hips 首末水平漂移 >0.1m → warning', () => {
    const result = validate(
      makeClip({ hipsAt: (frame) => (frame === 4 ? [0.5, 0, 0] : [0, 0, 0]) })
    )
    expect(result.ok).toBe(true)
    expectWarning(result, '水平漂移')
  })
})

describe('validateClipData：循环/非循环首末帧', () => {
  it('loop clip 末帧与首帧几乎相同 → warning（疑似重复帧）', () => {
    const result = validate(makeClip({ frames: 5, quatAt: () => identityQuat() }))
    expect(result.ok).toBe(true)
    expectWarning(result, '末帧与首帧几乎完全相同')
    expect(result.stats.loopSeamMaxAngleDeg).toBeCloseTo(0, 6)
  })

  it('loop 接缝跳变 >45° → warning（循环顿挫）', () => {
    const result = validate(
      makeClip({
        frames: 3,
        quatAt: (boneName, frame) => (frame === 2 ? axisAngleQuat([0, 1, 0], 80) : identityQuat())
      })
    )
    expect(result.ok).toBe(true)
    expectWarning(result, 'loop 接缝跳变')
  })

  it('非 loop clip 最后两帧几乎相同 → warning（结尾僵住）', () => {
    const result = validate(makeClip({ loop: false, frames: 4, quatAt: () => identityQuat() }))
    expect(result.ok).toBe(true)
    expectWarning(result, '最后两帧几乎相同')
  })

  it('非 loop 首末统计保留 firstLastMaxAngleDeg，loopSeamMaxAngleDeg 为 null', () => {
    const result = validate(makeClip({ loop: false, frames: 4 }))
    expect(result.stats.loopSeamMaxAngleDeg).toBeNull()
    expect(typeof result.stats.firstLastMaxAngleDeg).toBe('number')
  })
})

describe('computeRotationMetrics', () => {
  it('nested 与 flat 形状结果一致', () => {
    const clip = makeClip({ frames: 6 })
    const nested = computeRotationMetrics(clip.bones, 6) as Record<string, any>
    const flat = computeRotationMetrics((toFlatClip(clip).bones as unknown), 6) as Record<string, any>
    expect(nested.frameCount).toBe(22 * 6)
    expect(flat.frameCount).toBe(22 * 6)
    expect(flat.maxFrameJumpDeg).toBeCloseTo(nested.maxFrameJumpDeg, 9)
    expect(flat.firstLastMaxAngleDeg).toBeCloseTo(nested.firstLastMaxAngleDeg, 9)
    expect(nested.quatNorm.mean).toBeCloseTo(1, 9)
    expect(nested.maxFrameJumpDeg).toBeCloseTo(0.5, 3)
    expect(nested.firstLastMaxAngleDeg).toBeCloseTo(2.5, 3)
  })

  it('空/非法 bones 返回 null 字段而不抛异常', () => {
    const result = computeRotationMetrics({}, 5) as Record<string, any>
    expect(result.frameCount).toBe(0)
    expect(result.quatNorm.min).toBeNull()
    expect(result.maxFrameJumpDeg).toBeNull()
    expect(result.firstLastMaxAngleDeg).toBeNull()
  })
})

describe('computeHipsStats', () => {
  it('路径长度 / 单帧步长 / 侧向漂移 / 首末漂移', () => {
    const clip = makeClip({ hipsAt: (frame) => [frame * 0.1, 0, 0] })
    const stats = computeHipsStats(clip.bones, 5) as Record<string, any>
    expect(stats.hasHipsPosition).toBe(true)
    expect(stats.hipsTravel).toBeCloseTo(0.4, 6)
    expect(stats.hipsMaxStep).toBeCloseTo(0.1, 6)
    expect(stats.hipsLateralDrift).toBeCloseTo(0.4, 6)
    expect(stats.hipsNetDrift).toBeCloseTo(0.4, 6)
    expect(stats.hipsFirstOffset).toBeCloseTo(0, 6)
  })

  it('无 p 时字段为 null', () => {
    const clip = makeClip() as Record<string, any>
    delete clip.bones.Hips.p
    const stats = computeHipsStats(clip.bones, 5) as Record<string, any>
    expect(stats.hasHipsPosition).toBe(false)
    expect(stats.hipsTravel).toBeNull()
  })

  it('flat p 形状也支持', () => {
    const clip = toFlatClip(makeClip({ hipsAt: (frame) => [frame * 0.1, 0, 0] }))
    const stats = computeHipsStats(clip.bones, 5) as Record<string, any>
    expect(stats.hipsTravel).toBeCloseTo(0.4, 6)
  })
})

describe('CLIP_VALIDATION_LIMITS', () => {
  it('默认阈值是预期值（单测/文档依赖这些数字）', () => {
    expect(CLIP_VALIDATION_LIMITS.quatNormTolerance).toBe(1e-3)
    expect(CLIP_VALIDATION_LIMITS.frameJumpWarnDeg).toBe(60)
    expect(CLIP_VALIDATION_LIMITS.hipsFirstFrameToleranceMeters).toBe(1e-3)
    expect(CLIP_VALIDATION_LIMITS.loopDuplicateSeamDeg).toBe(0.01)
  })
})
