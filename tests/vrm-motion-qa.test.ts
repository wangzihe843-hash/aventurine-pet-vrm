/**
 * V3 clip QA 单测：结构校验/指标/分级（PASS/WARN/FAIL）。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- 纯 ESM 无声明
import { buildVrmRest, buildAlignment } from '../scripts/vrm/motion/lib/vrm-rest.mjs'
// @ts-expect-error -- 同上
import { retargetClip } from '../scripts/vrm/motion/lib/retarget.mjs'
// @ts-expect-error -- 同上
import { gradeClip, computeClipMetrics, validateClipStructure } from '../scripts/vrm/motion/lib/qa.mjs'
import { makeSyntheticVrm, makeSyntheticHsrSamples, makeClipDef } from './fixtures/vrm-motion/fixtures'

function buildFixture() {
  const vrm = makeSyntheticVrm()
  const rest = buildVrmRest(vrm)
  const samples = makeSyntheticHsrSamples({ frames: 4 })
  const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
  const secondaryMap = { nodeToBone: new Map(), chainReports: [], counts: { hairNodes: 0, clothNodes: 0 }, warnings: [] }
  const { clip } = retargetClip({
    clipId: 'test',
    clipDef: makeClipDef({ loop: false }),
    sampleClip: samples.clips.test,
    samples,
    vrmRest: rest,
    alignment,
    secondaryMap,
    options: { grounding: 'per-clip' }
  })
  return { rest, clip }
}

describe('validateClipStructure', () => {
  it('合法 clip：无 errors/warnings', () => {
    const { rest, clip } = buildFixture()
    const result = validateClipStructure(clip, rest)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.stats.humanoidBones).toBe(22)
    expect(result.stats.frames).toBe(4)
  })

  it('缺核心骨 / 四元数未单位化 / 首帧 p 非零 → errors', () => {
    const { rest, clip } = buildFixture()
    const missing = JSON.parse(JSON.stringify(clip))
    delete missing.bones.LeftHand
    expect(validateClipStructure(missing, rest).errors.some((e: string) => e.includes('LeftHand'))).toBe(true)

    const nonUnit = JSON.parse(JSON.stringify(clip))
    nonUnit.bones.Spine.r[1] = [0, 0, 0, 2]
    expect(validateClipStructure(nonUnit, rest).errors.some((e: string) => e.includes('单位化'))).toBe(true)

    const badHips = JSON.parse(JSON.stringify(clip))
    badHips.bones.Hips.p[0] = [0.2, 0, 0]
    expect(validateClipStructure(badHips, rest).errors.some((e: string) => e.includes('首帧未归零'))).toBe(true)
  })

  it('frames/duration 不一致 / raw 帧数错误 → errors', () => {
    const { rest, clip } = buildFixture()
    const badFrames = JSON.parse(JSON.stringify(clip))
    badFrames.frames = clip.frames + 1
    expect(validateClipStructure(badFrames, rest).errors.some((e: string) => e.includes('frames'))).toBe(true)

    const badRaw = JSON.parse(JSON.stringify(clip))
    badRaw.raw = { '後髪1-1': { r: [[0, 0, 0, 1]] } }
    expect(validateClipStructure(badRaw, rest).errors.some((e: string) => e.includes('raw.後髪1-1'))).toBe(true)
  })

  it('raw 未知节点 → warning', () => {
    const { rest, clip } = buildFixture()
    const unknownRaw = JSON.parse(JSON.stringify(clip))
    unknownRaw.raw = {
      '不存在的节点': { r: Array.from({ length: clip.frames }, () => [0, 0, 0, 1]) }
    }
    const result = validateClipStructure(unknownRaw, rest)
    expect(result.errors).toEqual([])
    expect(result.warnings.some((w: string) => w.includes('不在目标 VRM 中'))).toBe(true)
  })
})

describe('computeClipMetrics', () => {
  it('给出帧跳变/Hips/贴地指标', () => {
    const { rest, clip } = buildFixture()
    const metrics = computeClipMetrics(clip, rest)
    expect(metrics.frames).toBe(4)
    expect(metrics.maxFrameJumpDeg).toBeGreaterThan(0)
    expect(metrics.hipsTravelMeters).toBeCloseTo(0, 4) // 水平位移被 in-place 归零
    expect(metrics.ground?.footErrorMinMeters).not.toBeUndefined()
    expect(metrics.ground?.footErrorMaxMeters).not.toBeUndefined()
  })
})

describe('gradeClip', () => {
  it('合法 clip（无 raw 通道）→ PASS', () => {
    const { rest, clip } = buildFixture()
    const clean = { ...clip }
    delete clean.raw
    const result = gradeClip(clean, rest)
    expect(result.errors).toEqual([])
    expect(result.warnings.filter((warning: string) => !warning.includes('raw'))).toEqual([])
  })

  it('结构错误 → FAIL', () => {
    const { rest, clip } = buildFixture()
    const broken = JSON.parse(JSON.stringify(clip))
    broken.bones.Hips.p[0] = [0.5, 0, 0]
    expect(gradeClip(broken, rest).status).toBe('FAIL')
  })
})
describe('T-pose/spring 策略', () => {
  it('rawPolicy=spring 且无 raw → 不报 raw 警告', () => {
    const { rest, clip } = buildFixture()
    const springClip = JSON.parse(JSON.stringify(clip))
    delete springClip.raw
    springClip.rawPolicy = 'spring'
    const result = gradeClip(springClip, rest)
    expect(result.errors).toEqual([])
    expect(result.warnings.filter((warning: string) => warning.includes('raw'))).toEqual([])
  })

  it('目标无 upperChest（新 T-pose 戏浪）：UpperChest identity 轨道不报错', () => {
    const vrm = makeSyntheticVrm({ includeUpperChest: false })
    const rest = buildVrmRest(vrm)
    const samples = makeSyntheticHsrSamples({ frames: 3 })
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    const { clip } = retargetClip({
      clipId: 'test',
      clipDef: makeClipDef({ loop: false, grounding: 'none' }),
      sampleClip: samples.clips.test,
      samples,
      vrmRest: rest,
      alignment,
      secondaryMap: null,
      options: { rawEnabled: false, rawPolicy: 'spring', grounding: 'none' }
    })
    expect(clip.bones.UpperChest).toBeTruthy()
    const result = gradeClip(clip, rest)
    expect(result.errors).toEqual([])
    expect(result.warnings.filter((warning: string) => warning.includes('UpperChest'))).toEqual([])
  })
})
