/**
 * B3 单测：v3「自然度」——contrapposto 站姿 / 3/4 侧身 / 静态半握手 / 换承重脚 / 待机变体轴向。
 */
import { describe, expect, it } from 'vitest'

import { BASE_POSE_META, BASE_POSES, BASE_POSE_IDS, ALL_GESTURES, sampleGesture } from '../src/renderer/src/animation/legacy/poses'
import {
  computeMicroMotion,
  DEFAULT_MICRO_SCALE,
  GESTURE_FINGER_CURL_BOOST,
  MICRO_FINGER_BONES
} from '../src/renderer/src/animation/legacy/micro-motion'
import { AnimationPipeline, type PipelineRig } from '../src/renderer/src/animation/legacy/pipeline'
import type { AnimationInput } from '../src/renderer/src/core/wave2-contract'
import type { Vec3 } from '../src/renderer/src/animation/legacy/types'

const REST: Record<string, Vec3> = {
  センター: { x: 0, y: 8.93, z: 0 },
  下半身: { x: 0, y: 13.33, z: -0.071 },
  上半身: { x: 0, y: 13.5, z: -0.071 },
  上半身2: { x: 0, y: 15.769, z: -0.071 },
  首: { x: 0, y: 18.321, z: -0.595 },
  頭: { x: 0, y: 19.244, z: -0.54 },
  左足D: { x: 0.943, y: 12.234, z: -0.071 },
  左ひざD: { x: 1.046, y: 6.784, z: -0.086 },
  左足首D: { x: 1.151, y: 1.229, z: -0.503 },
  右足D: { x: -0.943, y: 12.234, z: -0.071 },
  右ひざD: { x: -1.046, y: 6.784, z: -0.086 },
  右足首D: { x: -1.151, y: 1.229, z: -0.503 },
  '辮子1-1': { x: 0.468, y: 19.324, z: -0.776 },
  '辮子1-2': { x: 0.522, y: 19.124, z: -0.58 },
  '辮子1-3': { x: 0.575, y: 18.819, z: -0.378 },
  '辮子1-4': { x: 0.52, y: 18.599, z: -0.099 },
  '辮子1-5': { x: 0.488, y: 18.372, z: 0.041 },
  '辮子2-1': { x: 0.432, y: 18.604, z: 0 },
  '辮碎髮': { x: 0.12, y: 19.328, z: -0.939 }
}
const RIG: PipelineRig = { restPositions: REST, modelHeight: 21.681, missingBones: [] }

function makeInput(overrides: Partial<AnimationInput> = {}, dt = 1 / 60): AnimationInput {
  const motion = {
    feet: { x: 300, y: 740 },
    velocity: { x: 0, y: 0 },
    facing: 'front' as const,
    grounded: true,
    surfaceId: 'screen-bottom',
    airborne: false
  }
  return {
    dt,
    mood: 'idle',
    motion,
    facing: 'front',
    lookTarget: null,
    petRect: { x: 100, y: 200, width: 398, height: 540 },
    viewportHeight: 961,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides,
    motion: { ...motion, ...(overrides.motion ?? {}) }
  }
}

describe('stand v3：contrapposto + 3/4 侧身 + 插兜预备', () => {
  it('stand meta：重心横移、3/4 侧身、软膝、双脚前后差/外八', () => {
    const meta = BASE_POSE_META.stand!
    expect(meta.centerX).toBeGreaterThan(0.5)
    expect(meta.centerYawDeg).toBeGreaterThanOrEqual(7)
    expect(meta.centerYawDeg).toBeLessThanOrEqual(10)
    expect(meta.crouch).toBeGreaterThanOrEqual(0.2)
    expect(meta.foot?.left?.forward).not.toBe(meta.foot?.right?.forward)
    expect(meta.foot?.left?.yawDeg).toBeGreaterThan(0)
  })

  it('stand 姿态：肩一高一低、上半身反扭、双臂自然垂在身体两侧（非叉腰/背手）', () => {
    const stand = BASE_POSES.stand!
    expect((stand['左肩']?.z ?? 0) - (stand['右肩']?.z ?? 0)).toBeGreaterThan(2)
    expect(Math.abs(stand['上半身']?.y ?? 0)).toBeGreaterThan(1)
    expect(Math.abs(stand['下半身']?.z ?? 0)).toBeGreaterThan(2)
    // 自然垂臂：上臂接近竖直（Z 大幅收向身体）、肘只微屈（不是叉腰的深折）
    expect(Math.abs(stand['左腕']?.z ?? 0)).toBeGreaterThan(40)
    expect(Math.abs(stand['右腕']?.z ?? 0)).toBeGreaterThan(40)
    expect(Math.abs(stand['左ひじ']?.x ?? 0)).toBeLessThan(25)
    expect(Math.abs(stand['右ひじ']?.x ?? 0)).toBeLessThan(25)
    // 左右镜像：腕 Z 符号相反、大小接近（允许轻微不对称）
    expect(Math.sign(stand['左腕']?.z ?? 0)).toBe(-Math.sign(stand['右腕']?.z ?? 1))
    expect(
      Math.abs(Math.abs(stand['左腕']?.z ?? 0) - Math.abs(stand['右腕']?.z ?? 0))
    ).toBeLessThan(6)
  })

  it('其他站立类姿态也带 3/4 侧身（walk/pat/busy/sad/celebrate）', () => {
    for (const id of ['walk', 'pat', 'busy', 'sad', 'celebrate']) {
      expect(BASE_POSE_META[id]?.centerYawDeg ?? 0).toBeGreaterThan(2)
      expect(BASE_POSE_IDS).toContain(id)
    }
  })

  it('默认手部自然放松（轻微弧 4–16°，不是握拳也不是五指大张）', () => {
    const motion = computeMicroMotion(3.3, DEFAULT_MICRO_SCALE)
    for (const bone of [...MICRO_FINGER_BONES.left, ...MICRO_FINGER_BONES.right]) {
      const z = Math.abs(motion[bone]?.z ?? 0)
      expect(z).toBeGreaterThanOrEqual(2)
      expect(z).toBeLessThanOrEqual(16)
    }
    // 左右镜像（弯曲方向相反）
    expect(Math.sign(motion['左人指１']!.z!)).toBe(-Math.sign(motion['右人指１']!.z!))
  })

  it('只有明确手势才加大手指弯曲（抛硬币/整理衣领），敬礼/伸懒腰保持放松', () => {
    const base = computeMicroMotion(3.3, DEFAULT_MICRO_SCALE)
    const pinch = computeMicroMotion(3.3, DEFAULT_MICRO_SCALE, { fingerCurlExtraDeg: 26 })
    const middleBase = Math.abs(base['左中指２']!.z ?? 0)
    const middlePinch = Math.abs(pinch['左中指２']!.z ?? 0)
    expect(middlePinch).toBeGreaterThan(middleBase + 15)
    // 手势 boost 表：硬币/整理 > 0，敬礼/伸懒腰接近 0
    expect(GESTURE_FINGER_CURL_BOOST.coinRoll).toBeGreaterThan(20)
    expect(GESTURE_FINGER_CURL_BOOST.adjustCuff).toBeGreaterThan(8)
    expect(GESTURE_FINGER_CURL_BOOST.salute ?? 0).toBeLessThanOrEqual(4)
    expect(GESTURE_FINGER_CURL_BOOST.stretch ?? 0).toBeLessThanOrEqual(4)
  })
})

describe('pipeline v3：换承重脚 / センター 3/4 侧身 / 贴地', () => {
  it('センター 带 3/4 侧身旋转（Y≠0），并随时间平滑生效', () => {
    const pipeline = new AnimationPipeline(RIG, { random: () => 0.5 })
    let now = 1000
    let frame = pipeline.update(makeInput(), now)
    for (let i = 0; i < 90; i += 1) {
      now += 1000 / 60
      frame = pipeline.update(makeInput(), now)
    }
    const yaw = (2 * Math.atan2(frame.centerQuaternion.y, frame.centerQuaternion.w) * 180) / Math.PI
    expect(Math.abs(yaw)).toBeGreaterThan(5)
    expect(Math.abs(yaw)).toBeLessThan(12)
  })

  it('横向重心随时间变化（换承重脚），脚仍贴地且无 NaN', () => {
    let seed = 7
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    const pipeline = new AnimationPipeline(RIG, { random })
    let now = 1000
    const samples: number[] = []
    for (let i = 0; i < 1200; i += 1) {
      now += 1000 / 60
      const frame = pipeline.update(makeInput(), now)
      expect(Number.isFinite(frame.centerOffsetX)).toBe(true)
      expect(frame.debug.footErrorPx!).toBeLessThan(2)
      if (i % 120 === 0) samples.push(frame.centerOffsetX)
    }
    const spread = Math.max(...samples) - Math.min(...samples)
    expect(spread).toBeGreaterThan(0.1)
  })

  it('待机变体轴向：伸懒腰手臂举过头顶（Z ±120 级）、整理衣领手在胸前（Y 前摆）', () => {
    const stretch = ALL_GESTURES.find((gesture) => gesture.id === 'stretch')!
    const stretchMid = sampleGesture(stretch, 0.85)
    // 手臂举过头顶：四元数绕 Z 的角度应接近 90–140°
    const armZ = (2 * Math.acos(Math.min(1, Math.abs(stretchMid.get('左腕')!.w)))) * (180 / Math.PI)
    expect(armZ).toBeGreaterThan(90)
    expect(armZ).toBeLessThan(160)

    const adjust = ALL_GESTURES.find((gesture) => gesture.id === 'adjustCuff')!
    const adjustMid = sampleGesture(adjust, 0.55)
    const leftArm = adjustMid.get('左腕')!
    // 前摆（Y 轴分量显著）才是「手到胸前」；若只有 Z 会变成侧平举
    expect(Math.abs(leftArm.y)).toBeGreaterThan(0.2)
  })
})
