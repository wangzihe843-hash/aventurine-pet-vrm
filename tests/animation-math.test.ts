/**
 * B3 单测：四元数/混合/姿态过渡/姿态数据合法性（纯函数，Node 环境）。
 *
 * 覆盖 survey §7.1 清单：quat/slerp 短弧、blend 层顺序/mask/additive、pose-machine 打断、
 * 姿态表白名单/禁用骨/角度范围、12 个 mood 对应的姿态数据合法。
 */
import { describe, expect, it } from 'vitest'

import {
  eulerDegToQuat,
  eulerToQuat,
  multiplyQuat,
  normalizeQuat,
  quatToRotationVector,
  rotationVectorToQuat,
  slerpQuat,
  smoothstep,
  damp,
  quatFromAxisAngle,
  rotateVec3,
  quatFromUnitVectors,
  dotQuat
} from '../src/renderer/src/animation/legacy/quat'
import { LAYER_ORDER, blendLayers, blendPoseMaps, scaleQuatAngle } from '../src/renderer/src/animation/legacy/blend'
import { PoseMachine, clonePose } from '../src/renderer/src/animation/legacy/pose-machine'
import {
  BASE_POSES,
  BASE_POSE_META,
  BASE_POSE_IDS,
  ALL_GESTURES,
  IDLE_VARIANTS,
  poseDefToQuats,
  sampleGesture
} from '../src/renderer/src/animation/legacy/poses'
import {
  FORBIDDEN_BONES,
  POSE_CONTROLLED_BONES,
  POSE_ANGLE_LIMIT_DEG,
  validatePoseDef,
  validatePoseTable
} from '../src/renderer/src/animation/legacy/skeleton'
import type { PoseQuats } from '../src/renderer/src/animation/legacy/types'

const DEG = Math.PI / 180
const EPS = 1e-6

function quatAngleDeg(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }): number {
  const d = Math.min(1, Math.abs(dotQuat(normalizeQuat(a), normalizeQuat(b))))
  return (2 * Math.acos(d)) / DEG
}

describe('quat：坐标系/欧拉角/slerp 短弧', () => {
  it('欧拉角（度）→ 四元数：单轴 90°/180° 与恒等', () => {
    const identity = eulerDegToQuat({})
    expect(identity.x).toBeCloseTo(0, 12)
    expect(identity.y).toBeCloseTo(0, 12)
    expect(identity.z).toBeCloseTo(0, 12)
    expect(identity.w).toBeCloseTo(1, 12)

    // 绕 Z +90°：右手系 → (0,0,sin45,cos45)
    const z90 = eulerDegToQuat({ z: 90 })
    expect(z90.x).toBeCloseTo(0, 9)
    expect(z90.y).toBeCloseTo(0, 9)
    expect(z90.z).toBeCloseTo(Math.SQRT1_2, 9)
    expect(z90.w).toBeCloseTo(Math.SQRT1_2, 9)

    // 绕 X +90°：验证「腿前摆 = X 负角 / 低头 = X 正角」的轴定义
    const x90 = eulerDegToQuat({ x: 90 })
    expect(x90.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(x90.w).toBeCloseTo(Math.SQRT1_2, 9)

    // 绕 X +180°：方向 (−Y) 应转到 +Y（低头翻过去）
    const x180 = eulerDegToQuat({ x: 180 })
    const dir = rotateVec3(x180, { x: 0, y: -1, z: 0 })
    expect(dir.y).toBeCloseTo(1, 9)
    expect(dir.z).toBeCloseTo(0, 9)
  })

  it('slerp：端点 / t=0.5 单位长度 / 短弧（dot<0 取反）', () => {
    const a = eulerDegToQuat({ z: 0 })
    const b = eulerDegToQuat({ z: 90 })
    const start = slerpQuat(a, b, 0)
    expect(quatAngleDeg(start, a)).toBeLessThan(0.01)
    const end = slerpQuat(a, b, 1)
    expect(quatAngleDeg(end, b)).toBeLessThan(0.01)
    const mid = slerpQuat(a, b, 0.5)
    expect(Math.hypot(mid.x, mid.y, mid.z, mid.w)).toBeCloseTo(1, 9)
    expect(quatAngleDeg(mid, a)).toBeCloseTo(45, 3)

    // b 取反（同一朝向的另一半空间）→ 仍走短弧（中点接近 a 而不是绕远路）
    const negB = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }
    const shortArc = slerpQuat(a, negB, 0.5)
    expect(quatAngleDeg(shortArc, a)).toBeCloseTo(45, 3)
  })

  it('四元数乘法/归一化/旋转向量往返', () => {
    const rx90 = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2)
    const twice = multiplyQuat(rx90, rx90)
    expect(quatAngleDeg(twice, eulerDegToQuat({ x: 180 }))).toBeLessThan(0.01)
    const degenerate = normalizeQuat({ x: 0, y: 0, z: 0, w: 0 })
    expect(degenerate.w).toBe(1)
    const q = eulerToQuat({ x: 0.2, y: -0.3, z: 0.15 })
    const rv = quatToRotationVector(q)
    const back = rotationVectorToQuat(rv)
    expect(quatAngleDeg(back, q)).toBeLessThan(0.01)
    // 单位向量 → 四元数：把 −Y 转到 −Z
    const align = quatFromUnitVectors({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 })
    const aligned = rotateVec3(align, { x: 0, y: -1, z: 0 })
    expect(aligned.z).toBeCloseTo(-1, 9)
  })

  it('smoothstep / damp：端点与收敛性（τ=90ms 时 3τ 后误差 <5%）', () => {
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12)
    expect(smoothstep(1)).toBe(1)
    expect(smoothstep(2)).toBe(1)
    expect(damp(0, 1, 0.27, 0.09)).toBeGreaterThan(0.94)
    expect(damp(0, 1, 0.27, 0.09)).toBeLessThan(0.96)
    expect(damp(0, 1, 0, 0.09)).toBe(0)
  })
})

describe('blend：分层混合（顺序/mask/additive/覆盖）', () => {
  it('层顺序常量锁死', () => {
    expect([...LAYER_ORDER]).toEqual(['base', 'breath', 'overlay', 'lookAt', 'spring'])
  })

  it('两覆盖层 0.5 权重 → 中间姿态（slerp 中点）', () => {
    const a: PoseQuats = new Map([['頭', eulerDegToQuat({ y: 0 })]])
    const b: PoseQuats = new Map([['頭', eulerDegToQuat({ y: 60 })]])
    const out = blendLayers([
      { id: 'base', pose: a, weight: 1 },
      { id: 'overlay', pose: b, weight: 0.5 }
    ])
    expect(quatAngleDeg(out.get('頭')!, eulerDegToQuat({ y: 30 }))).toBeLessThan(0.05)
  })

  it('mask 外的骨不受层影响；mask 内的骨生效', () => {
    const layer: PoseQuats = new Map([
      ['頭', eulerDegToQuat({ y: 20 })],
      ['左足D', eulerDegToQuat({ x: 20 })]
    ])
    const out = blendLayers([
      { id: 'base', pose: new Map(), weight: 1 },
      { id: 'overlay', pose: layer, weight: 1, mask: new Set(['頭']) }
    ])
    expect(out.has('頭')).toBe(true)
    expect(out.has('左足D')).toBe(false)
  })

  it('additive 层：weight=0 不改变；weight=1 等价乘算；角度按权重缩放', () => {
    const base: PoseQuats = new Map([['首', eulerDegToQuat({ x: 10 })]])
    const zero = blendLayers([
      { id: 'base', pose: base, weight: 1 },
      { id: 'lookAt', pose: new Map([['首', eulerDegToQuat({ x: 20 })]]), weight: 0, additive: true }
    ])
    expect(quatAngleDeg(zero.get('首')!, eulerDegToQuat({ x: 10 }))).toBeLessThan(0.01)
    const full = blendLayers([
      { id: 'base', pose: base, weight: 1 },
      { id: 'lookAt', pose: new Map([['首', eulerDegToQuat({ x: 20 })]]), weight: 1, additive: true }
    ])
    expect(quatAngleDeg(full.get('首')!, eulerDegToQuat({ x: 30 }))).toBeLessThan(0.05)
    const half = scaleQuatAngle(eulerDegToQuat({ x: 20 }), 0.5)
    expect(quatAngleDeg(half, eulerDegToQuat({ x: 10 }))).toBeLessThan(0.05)
  })

  it('层顺序不同结果不同（锁死观感）', () => {
    const base: PoseQuats = new Map([['腕', eulerDegToQuat({ z: 0 })]])
    const overlay: PoseQuats = new Map([['腕', eulerDegToQuat({ z: 40 })]])
    const additive: PoseQuats = new Map([['腕', eulerDegToQuat({ x: 20 })]])
    const orderA = blendLayers([
      { id: 'base', pose: base, weight: 1 },
      { id: 'overlay', pose: overlay, weight: 1 },
      { id: 'lookAt', pose: additive, weight: 1, additive: true }
    ])
    const orderB = blendLayers([
      { id: 'base', pose: base, weight: 1 },
      { id: 'lookAt', pose: additive, weight: 1, additive: true },
      { id: 'overlay', pose: overlay, weight: 1 }
    ])
    // additive 在覆盖之前：覆盖层会覆盖掉 additive 的轴分量，结果不同。
    expect(quatAngleDeg(orderA.get('腕')!, orderB.get('腕')!)).toBeGreaterThan(1)
  })

  it('blendPoseMaps：并集骨、缺省骨从恒等插值', () => {
    const from: PoseQuats = new Map([['頭', eulerDegToQuat({ y: 30 })]])
    const to: PoseQuats = new Map([
      ['頭', eulerDegToQuat({ y: 60 })],
      ['首', eulerDegToQuat({ x: 10 })]
    ])
    const out = blendPoseMaps(from, to, 0.5)
    expect(out.has('頭')).toBe(true)
    expect(out.has('首')).toBe(true)
    expect(quatAngleDeg(out.get('頭')!, eulerDegToQuat({ y: 45 }))).toBeLessThan(0.05)
    expect(quatAngleDeg(out.get('首')!, eulerDegToQuat({ x: 5 }))).toBeLessThan(0.05)
  })
})

describe('pose-machine：smoothstep 过渡 / 可打断', () => {
  const poseA: PoseQuats = new Map([['頭', eulerDegToQuat({ y: 0 })]])
  const poseB: PoseQuats = new Map([['頭', eulerDegToQuat({ y: 90 })]])

  it('t=0 输出 from、t=1 输出 to、progress 单调到 1', () => {
    const machine = new PoseMachine()
    machine.setTarget('a', poseA, 0.25)
    machine.update(0, 'a', poseA)
    const first = clonePose(machine.currentPose)
    expect(quatAngleDeg(first.get('頭')!, poseA.get('頭')!)).toBeLessThan(0.01)
    const midProgressList: number[] = []
    machine.setTarget('b', poseB, 0.25, true)
    for (let i = 0; i < 10; i += 1) {
      machine.update(0.025, 'b', poseB)
      midProgressList.push(machine.progress)
    }
    expect(machine.progress).toBeCloseTo(1, 6)
    expect(machine.currentPose.get('頭')).toBeDefined()
    expect(quatAngleDeg(machine.currentPose.get('頭')!, poseB.get('頭')!)).toBeLessThan(0.01)
    // progress 单调不减
    for (let i = 1; i < midProgressList.length; i += 1) {
      expect(midProgressList[i]!).toBeGreaterThanOrEqual(midProgressList[i - 1]! - EPS)
    }
  })

  it('打断后 from = 当前输出（视觉连续，不跳变）', () => {
    const machine = new PoseMachine()
    machine.setTarget('a', poseA, 0.2, true)
    for (let i = 0; i < 3; i += 1) machine.update(0.02, 'a', poseA)
    machine.setTarget('b', poseB, 0.2, true)
    machine.update(0.02, 'b', poseB)
    const afterInterrupt = machine.currentPose
    // 打断瞬间（t≈0.1s）应远未到 poseB（90°），而是从半途开始
    expect(quatAngleDeg(afterInterrupt.get('頭')!, poseA.get('頭')!)).toBeLessThan(30)
    machine.update(0.5, 'b', poseB)
    expect(quatAngleDeg(machine.currentPose.get('頭')!, poseB.get('頭')!)).toBeLessThan(0.01)
  })
})

describe('姿态数据合法性（R1 自动化防线）', () => {
  it('姿态表 + 手势全部通过自检', () => {
    const result = validatePoseTable(BASE_POSES, BASE_POSE_META, ALL_GESTURES)
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('12 个核心姿态；每个姿态都有 meta；stand 必含双臂（防 A-pose 回归）', () => {
    expect(BASE_POSE_IDS.length).toBeGreaterThanOrEqual(12)
    for (const id of BASE_POSE_IDS) {
      expect(BASE_POSE_META[id]).toBeDefined()
      const def = BASE_POSES[id]!
      expect(Object.keys(def).length).toBeGreaterThan(0)
      for (const bone of Object.keys(def)) {
        expect(POSE_CONTROLLED_BONES).toContain(bone)
        expect(FORBIDDEN_BONES).not.toContain(bone)
      }
    }
    for (const bone of ['左腕', '右腕', '首', '頭', '上半身', '下半身']) {
      expect(Object.keys(BASE_POSES.stand!)).toContain(bone)
    }
  })

  it('姿态角在 ±170° 内、无 NaN（腿/手臂大幅姿态仍合法）', () => {
    for (const [id, def] of Object.entries(BASE_POSES)) {
      for (const [bone, euler] of Object.entries(def)) {
        for (const axis of ['x', 'y', 'z'] as const) {
          const value = euler[axis]
          if (value === undefined) continue
          expect(Number.isFinite(value), `${id}.${bone}.${axis}`).toBe(true)
          expect(Math.abs(value)).toBeLessThanOrEqual(POSE_ANGLE_LIMIT_DEG)
        }
      }
    }
  })

  it('validatePoseDef 能抓住禁用骨/未知骨/超范围', () => {
    expect(validatePoseDef('bad-ik', { 左足: { x: 10 } }).ok).toBe(false)
    expect(validatePoseDef('bad-eye', { 両目: { y: 10 } }).ok).toBe(false)
    expect(validatePoseDef('bad-unknown', { 不存在的骨: { x: 1 } }).ok).toBe(false)
    expect(validatePoseDef('bad-range', { 左腕: { z: 200 } }).ok).toBe(false)
    expect(validatePoseDef('ok', { 左腕: { z: -24 } }).ok).toBe(true)
  })

  it('姿态定义转四元数：非零骨都有 quat，未列出的骨不出现', () => {
    const stand = poseDefToQuats(BASE_POSES.stand!)
    expect(stand.has('左腕')).toBe(true)
    expect(stand.has('右腕')).toBe(true)
    expect(stand.has('左足D')).toBe(false)
    const arm = stand.get('左腕')!
    expect(Number.isFinite(arm.w)).toBe(true)
  })

  it('待机变体 4–6 个、权重合计 100、id 唯一、有冷却（brief §4.2）', () => {
    expect(IDLE_VARIANTS.length).toBeGreaterThanOrEqual(4)
    expect(IDLE_VARIANTS.length).toBeLessThanOrEqual(6)
    const ids = IDLE_VARIANTS.map((variant) => variant.gesture.id)
    expect(new Set(ids).size).toBe(ids.length)
    const total = IDLE_VARIANTS.reduce((sum, variant) => sum + variant.weight, 0)
    expect(total).toBe(100)
    for (const variant of IDLE_VARIANTS) {
      expect(variant.cooldownSec).toBeGreaterThan(0)
      expect(variant.gesture.duration).toBeGreaterThan(1)
      expect(variant.gesture.mask).toBeDefined()
    }
    // 用户要求：不做女性化动作——待机变体只允许「空手硬币/整理/伸懒腰/远眺/敬礼」类
    expect(ids).toEqual(
      expect.arrayContaining(['coinRoll', 'coinToss', 'adjustCuff', 'stretch', 'gazeAway', 'salute'])
    )
  })

  it('关键帧采样：t=0 为恒等、t=duration 回到恒等（手势回基础姿态）', () => {
    const gesture = ALL_GESTURES.find((item) => item.id === 'patReact')!
    const start = sampleGesture(gesture, 0)
    expect(start.size).toBeGreaterThan(0)
    const end = sampleGesture(gesture, gesture.duration)
    for (const [, q] of end) {
      expect(quatAngleDeg(q, { x: 0, y: 0, z: 0, w: 1 })).toBeLessThan(0.01)
    }
    // 中途头/肩有偏移
    const mid = sampleGesture(gesture, 0.18)
    expect(quatAngleDeg(mid.get('頭')!, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(1)
  })
})
