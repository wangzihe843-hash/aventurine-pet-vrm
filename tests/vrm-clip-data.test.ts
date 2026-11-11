/**
 * V1 clip-engine：`src/renderer/src/vrm/clip-data.ts` 纯逻辑测试（合成 clip，不读私有 assets）。
 *
 * 覆盖：解析（version/fps/frames/bones.r 形状、nested/flat、缺省回填、坏数据降级）、
 * 帧索引（loop 取模 / one-shot 末帧钳制）、逐帧 slerp 采样、Hips.p 缩放、贴地/次生字段。
 */
import { describe, expect, it } from 'vitest'

import {
  clipDurationSec,
  DEFAULT_SOURCE_HIPS_HEIGHT,
  frameIndex,
  hipsPositionScale,
  isBoneTrackNonIdentity,
  lerpVec3,
  parseClipData,
  readBoneRotationAtFrame,
  sampleBoneRotation,
  sampleScaledHipsPosition,
  slerpQuat,
  smoothstep,
  type Quat4,
  type Vec3
} from '../src/renderer/src/vrm/clip-data'
import {
  identityQuat,
  makeClipJson,
  pitchQuat,
  trackFlat,
  trackNested,
  yawQuat
} from './fixtures/vrm-motion/clip-fixtures'

/** 解析成功断言辅助（返回非空 clip）。 */
function parseOk(json: unknown) {
  const result = parseClipData(json)
  expect(result.errors).toEqual([])
  expect(result.value).not.toBeNull()
  return result.value!
}

/** 浮点近似断言辅助。 */
function expectClose(actual: number, expected: number, epsilon = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThan(epsilon)
}

describe('clip-data：clip JSON 解析', () => {
  it('解析 nested 轨道（Hips.r/p + 手臂 r）', () => {
    const json = makeClipJson({
      clip: 'idle',
      fps: 30,
      frames: 3,
      bones: {
        Hips: trackNested(
          [identityQuat(), identityQuat(), identityQuat()],
          [
            [0, 0, 0],
            [0, 0.1, 0],
            [0, 0.2, 0]
          ]
        ),
        LeftUpperArm: trackNested([identityQuat(), yawQuat(10), yawQuat(20)])
      }
    })
    const clip = parseOk(json)
    expect(clip.clip).toBe('idle')
    expect(clip.fps).toBe(30)
    expect(clip.frames).toBe(3)
    expect(clip.loop).toBe(true)
    expect(clip.sourceHipsHeight).toBe(1)
    expect(clip.grounding).toBe('none')
    expect(clip.rawPolicy).toBe('spring')
    expect(clip.bones.size).toBe(2)
    const hips = clip.bones.get('Hips')!
    expect(hips.rotations).toBeInstanceOf(Float64Array)
    expect(hips.rotations).toHaveLength(3 * 4)
    expect(hips.positions).toBeInstanceOf(Float64Array)
    expect(hips.positions).toHaveLength(3 * 3)
    // 手臂没有 p
    expect(clip.bones.get('LeftUpperArm')!.positions).toBeNull()
    // 采样首帧
    const out: Quat4 = [0, 0, 0, 1]
    expect(readBoneRotationAtFrame(clip, 'LeftUpperArm', 0, out)).toBe(true)
    expect(out).toEqual(identityQuat())
  })

  it('nested 与 flat 两种形状解析结果一致', () => {
    const quats = [identityQuat(), yawQuat(30), yawQuat(60)]
    const positions: Vec3[] = [
      [0, 0, 0],
      [0.01, 0.02, 0.03],
      [0.02, 0.04, 0.06]
    ]
    const nested = parseOk(
      makeClipJson({
        frames: 3,
        bones: { Hips: trackNested(quats, positions) }
      })
    )
    const flat = parseOk(
      makeClipJson({
        frames: 3,
        bones: { Hips: trackFlat(quats, positions) }
      })
    )
    expect(Array.from(nested.bones.get('Hips')!.rotations)).toEqual(
      Array.from(flat.bones.get('Hips')!.rotations)
    )
    expect(Array.from(nested.bones.get('Hips')!.positions!)).toEqual(
      Array.from(flat.bones.get('Hips')!.positions!)
    )
    for (const timeSec of [0, 0.4, 0.7, 2.9]) {
      const a: Quat4 = [0, 0, 0, 1]
      const b: Quat4 = [0, 0, 0, 1]
      expect(sampleBoneRotation(nested, 'Hips', timeSec, a)).toBe(true)
      expect(sampleBoneRotation(flat, 'Hips', timeSec, b)).toBe(true)
      for (let index = 0; index < 4; index += 1) expectClose(a[index], b[index])
    }
  })

  it('缺省字段回填：duration=frames/fps、grounding=none、sourceHipsHeight=1，space 缺失仅 warning', () => {
    const result = parseClipData(
      makeClipJson({
        frames: 4,
        fps: 2,
        space: null,
        sourceHipsHeight: undefined as never,
        grounding: undefined
      })
    )
    expect(result.value).not.toBeNull()
    expect(result.value!.duration).toBe(2)
    expect(result.value!.grounding).toBe('none')
    expect(result.value!.sourceHipsHeight).toBe(DEFAULT_SOURCE_HIPS_HEIGHT)
    expect(result.warnings.some((warning) => warning.includes('space'))).toBe(true)
  })

  it('读取 grounding=feet 与 rawPolicy=baked（raw 存在时推导）', () => {
    const json = makeClipJson({
      grounding: 'feet',
      extra: { raw: { Hair: { r: [[0, 0, 0, 1], [0, 0, 0, 1]] } } }
    })
    const clip = parseOk(json)
    expect(clip.grounding).toBe('feet')
    expect(clip.rawPolicy).toBe('baked')
  })

  it('硬错误：version/fps/frames/bones/space 非法 → value=null', () => {
    expect(parseClipData(null).value).toBeNull()
    expect(parseClipData(makeClipJson({ extra: { version: 2 } })).value).toBeNull()
    expect(parseClipData(makeClipJson({ extra: { fps: 0 } })).value).toBeNull()
    expect(parseClipData(makeClipJson({ extra: { frames: 0 } })).value).toBeNull()
    expect(parseClipData(makeClipJson({ extra: { bones: null } })).value).toBeNull()
    expect(parseClipData(makeClipJson({ extra: { space: 'unity-lhs' } })).value).toBeNull()
    // 所有骨都不可解析 = 错误
    expect(
      parseClipData(makeClipJson({ frames: 2, bones: { Hips: { r: [0, 0, 0] } } })).value
    ).toBeNull()
  })

  it('单根骨 r 形状非法 → 该骨 warning 跳过，clip 仍可用', () => {
    const result = parseClipData(
      makeClipJson({
        frames: 2,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          LeftUpperArm: { r: [0, 0, 1] }
        }
      })
    )
    expect(result.value).not.toBeNull()
    expect(result.value!.bones.has('LeftUpperArm')).toBe(false)
    expect(result.value!.bones.has('Hips')).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('LeftUpperArm'))).toBe(true)
  })

  it('非 Hips 的 p 被忽略并 warning；未知骨骼不报错', () => {
    const result = parseClipData(
      makeClipJson({
        frames: 2,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          LeftUpperArm: trackNested([identityQuat(), identityQuat()], [
            [0, 0, 0],
            [0, 0, 0]
          ]),
          MysteryBone: trackNested([identityQuat(), identityQuat()])
        }
      })
    )
    expect(result.value).not.toBeNull()
    expect(
      result.warnings.some((warning) => warning.includes('LeftUpperArm') && warning.includes('p'))
    ).toBe(true)
    expect(result.value!.bones.get('LeftUpperArm')!.positions).toBeNull()
    // 未知骨也保留在 Map（player 的 missingBones 会报告它）
    expect(result.value!.bones.has('MysteryBone')).toBe(true)
  })

  it('HSR 风格拇指骨名归一为 Unity 规范键（LeftThumbMetacarpal/Proximal/Distal）', () => {
    const clip = parseOk(
      makeClipJson({
        frames: 2,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          LeftThumbMetacarpal: trackNested([identityQuat(), yawQuat(10)]), // → LeftThumbProximal
          LeftThumbProximal: trackNested([identityQuat(), yawQuat(20)]), // → LeftThumbIntermediate
          LeftThumbDistal: trackNested([identityQuat(), yawQuat(30)])
        }
      })
    )
    expect(clip.bones.has('LeftThumbMetacarpal')).toBe(false)
    expect(clip.bones.has('LeftThumbProximal')).toBe(true)
    expect(clip.bones.has('LeftThumbIntermediate')).toBe(true)
    expect(clip.bones.has('LeftThumbDistal')).toBe(true)
    const out: Quat4 = [0, 0, 0, 1]
    expect(sampleBoneRotation(clip, 'LeftThumbProximal', 1, out)).toBe(true)
    const expected = yawQuat(10)
    for (let index = 0; index < 4; index += 1) expectClose(out[index], expected[index], 1e-5)
    expect(sampleBoneRotation(clip, 'LeftThumbIntermediate', 1, out)).toBe(true)
  })

  it('浮点 flat 长度尾部多余元素只 warning，不丢 clip', () => {
    const result = parseClipData(
      makeClipJson({
        frames: 1,
        bones: { Hips: { r: [0, 0, 0, 1, 9, 9, 9, 9] } }
      })
    )
    expect(result.value).not.toBeNull()
    expect(result.warnings.some((warning) => warning.includes('平铺长度'))).toBe(true)
  })
})

describe('clip-data：帧索引（loop 取模 / one-shot 末帧钳制）', () => {
  const clipMeta = { frames: 4, fps: 2, loop: true } // 一个循环 = 2s

  it('loop：时间取模后线性落帧', () => {
    expect(frameIndex(clipMeta, 0)).toEqual({ f0: 0, f1: 1, a: 0 })
    expect(frameIndex(clipMeta, 0.25)).toEqual({ f0: 0, f1: 1, a: 0.5 })
    expect(frameIndex(clipMeta, 2.75)).toEqual({ f0: 1, f1: 2, a: 0.5 })
    expect(frameIndex(clipMeta, -0.5)).toEqual({ f0: 3, f1: 3, a: 0 })
    // 恰好一个循环 = 首帧
    expect(frameIndex(clipMeta, 2)).toEqual({ f0: 0, f1: 1, a: 0 })
  })

  it('one-shot：钳制到 [0, (frames-1)/fps]（末帧包含）', () => {
    const oneShot = { frames: 4, fps: 2, loop: false }
    expect(frameIndex(oneShot, -3)).toEqual({ f0: 0, f1: 1, a: 0 })
    expect(frameIndex(oneShot, 100)).toEqual({ f0: 3, f1: 3, a: 0 })
    expect(frameIndex(oneShot, 1.25)).toEqual({ f0: 2, f1: 3, a: 0.5 })
  })

  it('单帧 clip 安全', () => {
    expect(frameIndex({ frames: 1, fps: 30, loop: true }, 0)).toEqual({ f0: 0, f1: 0, a: 0 })
    expect(frameIndex({ frames: 1, fps: 30, loop: false }, 99)).toEqual({ f0: 0, f1: 0, a: 0 })
    expect(clipDurationSec({ frames: 1, fps: 30 })).toBeCloseTo(1 / 30)
  })
})

describe('clip-data：四元数 slerp / 采样', () => {
  it('identity → yaw90 的中点 = yaw45（短弧球面插值）', () => {
    const out: Quat4 = [0, 0, 0, 1]
    slerpQuat(identityQuat(), yawQuat(90), 0.5, out)
    const expected = yawQuat(45)
    for (let index = 0; index < 4; index += 1) expectClose(out[index], expected[index])
  })

  it('q 与 -q 等价（短弧不会绕 360°）', () => {
    const out: Quat4 = [0, 0, 0, 1]
    slerpQuat(yawQuat(0), yawQuat(360), 0.5, out)
    // -identity 与 identity 等价，短弧结果为 ±identity（w 绝对值 1）
    expectClose(Math.abs(out[3]), 1)
  })

  it('sampleBoneRotation：第 f0/f1 帧之间 slerp；未覆盖骨返回 false', () => {
    const clip = parseOk(
      makeClipJson({
        frames: 2,
        fps: 2,
        loop: false,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          Head: trackNested([identityQuat(), yawQuat(90)])
        }
      })
    )
    const out: Quat4 = [0, 0, 0, 1]
    expect(sampleBoneRotation(clip, 'Head', 0.25, out)).toBe(true) // 0.25s = 帧 0.5
    const expected = yawQuat(45)
    for (let index = 0; index < 4; index += 1) expectClose(out[index], expected[index], 1e-5)
    expect(sampleBoneRotation(clip, 'LeftHand', 0, out)).toBe(false)
  })

  it('sampleBoneRotation 对 loop 回绕到首帧（末→首帧插值）', () => {
    const clip = parseOk(
      makeClipJson({
        frames: 2,
        fps: 1,
        loop: true,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          Head: trackNested([identityQuat(), yawQuat(90)])
        }
      })
    )
    const out: Quat4 = [0, 0, 0, 1]
    expect(sampleBoneRotation(clip, 'Head', 2.5, out)).toBe(true) // 2.5s → 取模回 0.5s（帧 0.5）
    const expected = yawQuat(45)
    for (let index = 0; index < 4; index += 1) expectClose(out[index], expected[index], 1e-5)
  })
})

describe('clip-data：Hips.p 缩放与贴地相关字段', () => {
  it('Hips.p 缩放 = p * hipsRestHeight / sourceHipsHeight', () => {
    const clip = parseOk(
      makeClipJson({
        frames: 2,
        fps: 1,
        sourceHipsHeight: 0.95,
        bones: {
          Hips: trackNested(
            [identityQuat(), identityQuat()],
            [
              [0, 0, 0],
              [0, 0.1, 0]
            ]
          )
        }
      })
    )
    const out: Vec3 = [0, 0, 0]
    expect(sampleScaledHipsPosition(clip, 1, 1.066, out)).toBe(true)
    const scale = 1.066 / 0.95
    expectClose(out[1], 0.1 * scale)
    expect(hipsPositionScale(clip, 1.066)).toBeCloseTo(scale)
  })

  it('无 Hips.p / 非法 hips 高度时的安全回退', () => {
    const clip = parseOk(
      makeClipJson({
        frames: 1,
        bones: { Hips: trackNested([identityQuat()]) }
      })
    )
    const out: Vec3 = [9, 9, 9]
    expect(sampleScaledHipsPosition(clip, 0, 1, out)).toBe(false)
    expect(out).toEqual([9, 9, 9])
    expect(hipsPositionScale(clip, 0)).toBe(1)
    expect(hipsPositionScale({ sourceHipsHeight: 0 }, 1)).toBe(1)
  })

  it('isBoneTrackNonIdentity：identity=false，有旋转=true（upperChest 缺失过滤用）', () => {
    const clip = parseOk(
      makeClipJson({
        frames: 3,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat(), identityQuat()]),
          UpperChest: trackNested([identityQuat(), identityQuat(), identityQuat()]),
          Head: trackNested([identityQuat(), pitchQuat(20), pitchQuat(-20)])
        }
      })
    )
    expect(isBoneTrackNonIdentity(clip, 'UpperChest')).toBe(false)
    expect(isBoneTrackNonIdentity(clip, 'Head')).toBe(true)
    expect(isBoneTrackNonIdentity(clip, 'Missing')).toBe(false)
  })
})

describe('clip-data：插值小工具', () => {
  it('smoothstep 端点/中点', () => {
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(0.5)).toBe(0.5)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(2)).toBe(1)
  })

  it('lerpVec3 逐分量线性插值', () => {
    const out: Vec3 = [0, 0, 0]
    lerpVec3([0, 1, 2], [2, 3, 4], 0.25, out)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(1.5)
    expect(out[2]).toBeCloseTo(2.5)
  })
})
