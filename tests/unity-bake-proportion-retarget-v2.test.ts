/**
 * 比例感知重定向 v2（S2-only + Hybrid）单测。
 *
 * 纯函数 fixture 用简化骨架（源：torso 0.33m / 锁骨 0.063m / 臂 0.36m；
 * 目标：torso 0.473m / 锁骨 0.123m / 臂 0.443m），不读私有资产。
 * 末尾一个 skipIf 集成用例：若本机存在 Unity GT rest JSON，则用真实 Zome/男体 rest 跑 idle。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  forwardKinematics,
  quatAngleDeg,
  quatInvert,
  quatMultiply,
  quatRotateVec,
  vDist,
  vDot,
  vLen,
  vNorm,
  vSub
} from '../scripts/unity-bake/lib/proportion-retarget.mjs'
// @ts-expect-error -- 同上
import {
  DEFAULT_GUARDS,
  HYBRID_POLICY,
  applyS2Frame,
  deriveS2Coefficients,
  retargetClipV2,
  shoulderLineSlope,
  smoothVectors,
  smoothWeights
} from '../scripts/unity-bake/lib/proportion-retarget-v2.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_REST_GT = path.join(REPO, 'tests/tmp/wave15/groundtruth/unity/zome-rest.json')
const TARGET_REST_GT = path.join(REPO, 'tests/tmp/lead-shoulder/gt-male/out/unity/aventurine-tpose-rest.json')

const I = [0, 0, 0, 1]
const qLen = (q: number[]): number => Math.hypot(q[0], q[1], q[2], q[3])
const qDot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]

function sourceRig(): Record<string, number[]> {
  return {
    Hips: [0, 0.83, 0], Spine: [0, 0.87, 0], Chest: [0, 0.96, 0],
    Neck: [0, 1.12, 0], Head: [0, 1.16, 0],
    LeftShoulder: [0.03, 1.1, 0], LeftUpperArm: [0.09, 1.08, 0], LeftLowerArm: [0.28, 1.08, 0], LeftHand: [0.45, 1.08, 0],
    RightShoulder: [-0.03, 1.1, 0], RightUpperArm: [-0.09, 1.08, 0], RightLowerArm: [-0.28, 1.08, 0], RightHand: [-0.45, 1.08, 0]
  }
}

function targetRig(): Record<string, number[]> {
  return {
    Hips: [0, 1.0661, 0], Spine: [0, 1.0797, 0], Chest: [0, 1.2612, 0],
    Neck: [0, 1.4653, 0], Head: [0, 1.5391, 0],
    LeftShoulder: [0.0357, 1.3955, -0.0461], LeftUpperArm: [0.1587, 1.3875, -0.0495],
    LeftLowerArm: [0.3894, 1.3875, -0.0495], LeftHand: [0.6022, 1.3875, -0.0495],
    RightShoulder: [-0.0357, 1.3955, -0.0461], RightUpperArm: [-0.1587, 1.3875, -0.0495],
    RightLowerArm: [-0.3894, 1.3875, -0.0495], RightHand: [-0.6022, 1.3875, -0.0495]
  }
}

function rotZ(deg: number): number[] {
  const h = (deg * Math.PI) / 180 / 2
  return [0, 0, Math.sin(h), Math.cos(h)]
}
function rotY(deg: number): number[] {
  const h = (deg * Math.PI) / 180 / 2
  return [0, Math.sin(h), 0, Math.cos(h)]
}
function rotX(deg: number): number[] {
  const h = (deg * Math.PI) / 180 / 2
  return [Math.sin(h), 0, 0, Math.cos(h)]
}

/** 一帧：源锁骨下压+后缩，上臂/前臂弯曲。 */
function posedRotations(): Record<string, number[]> {
  return {
    LeftShoulder: quatMultiply(rotZ(-25), rotY(-15)),
    LeftUpperArm: quatMultiply(rotZ(-20), rotX(10)),
    LeftLowerArm: rotZ(-60),
    LeftHand: rotX(5),
    RightShoulder: quatMultiply(rotZ(25), rotY(15)),
    RightUpperArm: quatMultiply(rotZ(20), rotX(10)),
    RightLowerArm: rotZ(60),
    RightHand: rotX(5)
  }
}

function constantClip(rotations: Record<string, number[]>, frames = 8, loop = true): any {
  const bones: Record<string, { r: number[][] }> = {}
  for (const [bone, q] of Object.entries(rotations)) {
    bones[bone] = { r: Array.from({ length: frames }, () => [q[0], q[1], q[2], q[3]]) }
  }
  return { frames, loop, fps: 30, bones }
}

describe('S2 系数推导', () => {
  it('kSocket = (L_s/L_t)·(H_t/H_s)', () => {
    const b = deriveS2Coefficients(sourceRig(), targetRig())
    const expected = (b.sourceClavicleM / b.targetClavicleM) * (b.targetTorsoM / b.sourceTorsoM)
    expect(b.kSocket).toBeCloseTo(expected, 9)
    expect(b.kSocket).toBeCloseTo(0.735, 3)
    expect(b.sides.Left.kSocket).toBeCloseTo(b.sides.Right.kSocket, 9)
  })

  it('kSlope 数值解让肩线斜率在 20° 处一致', () => {
    const b = deriveS2Coefficients(sourceRig(), targetRig())
    const s = b.sides.Left
    const sourceSlope = shoulderLineSlope(s.sourceClavicleM, s.sourceShoulderRootHalfWidthM, (20 * Math.PI) / 180)
    const targetSlope = shoulderLineSlope(s.targetClavicleM, s.targetShoulderRootHalfWidthM, (s.kSlopeAt20 * 20 * Math.PI) / 180)
    expect(targetSlope).toBeCloseTo(sourceSlope, 6)
    expect(b.kSlope).toBeGreaterThan(0.8)
    expect(b.kSlope).toBeLessThan(0.95)
  })

  it('真实 rest：kSocket≈0.714、kSlope≈0.857（私有资产，缺则跳过）', () => {
    if (!existsSync(SOURCE_REST_GT) || !existsSync(TARGET_REST_GT)) return
    const rest = (file: string): Record<string, number[]> => {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { bones: Array<{ name: string; worldPos: number[] }> }
      const out: Record<string, number[]> = {}
      for (const bone of data.bones) {
        if (!Array.isArray(bone.worldPos) || bone.worldPos.length < 3) continue
        out[bone.name] = [-bone.worldPos[0], bone.worldPos[1], bone.worldPos[2]]
      }
      return out
    }
    const b = deriveS2Coefficients(rest(SOURCE_REST_GT), rest(TARGET_REST_GT))
    expect(b.kSocket).toBeCloseTo(0.714, 3)
    expect(b.kSlope).toBeCloseTo(0.857, 3)
  })
})

describe('S2 单帧恒等式', () => {
  it('k=1 原样、k=0 锁骨回 rest 且上臂补偿 = S·A', () => {
    const rotations = posedRotations()
    const b = deriveS2Coefficients(sourceRig(), targetRig())
    const out1 = applyS2Frame(rotations, 1)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'RightShoulder', 'RightUpperArm']) {
      expect(qDot(out1.rotations[bone], rotations[bone])).toBeCloseTo(1, 12)
    }
    const out0 = applyS2Frame(rotations, 0)
    expect(qDot(out0.rotations.LeftShoulder, I)).toBeCloseTo(1, 12)
    const expectedUA = quatMultiply(rotations.LeftShoulder, rotations.LeftUpperArm)
    expect(qDot(out0.rotations.LeftUpperArm, expectedUA)).toBeCloseTo(1, 12)
    expect(b.kSocket).toBeGreaterThan(0)
  })

  it('任意 k：upperArm/lowerArm/hand world 朝向不变；肘/手平移 = 肩点平移', () => {
    const rotations = posedRotations()
    const target = targetRig()
    const before = forwardKinematics(target, rotations)
    for (const k of [0, 0.3, 0.714, 0.8, 1]) {
      const s2 = applyS2Frame(rotations, k)
      const after = forwardKinematics(target, { ...rotations, ...s2.rotations })
      for (const bone of ['LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightLowerArm', 'RightHand']) {
        expect(quatAngleDeg(quatMultiply(quatInvert(before.deltas[bone]), after.deltas[bone]))).toBeLessThan(1e-8)
      }
      for (const [socket, elbow, hand] of [
        ['LeftUpperArm', 'LeftLowerArm', 'LeftHand'],
        ['RightUpperArm', 'RightLowerArm', 'RightHand']
      ]) {
        const socketShift = vSub(after.positions[socket], before.positions[socket])
        expect(vDist(vSub(after.positions[elbow], before.positions[elbow]), socketShift)).toBeLessThan(1e-9)
        expect(vDist(vSub(after.positions[hand], before.positions[hand]), socketShift)).toBeLessThan(1e-9)
      }
    }
  })

  it('锁骨局部角按 k 缩小（q/-q 等价）', () => {
    const rotations = posedRotations()
    const s2 = applyS2Frame(rotations, 0.714)
    expect(s2.sides.Left.shoulderDegAfter).toBeCloseTo(s2.sides.Left.shoulderDegBefore * 0.714, 6)
    expect(s2.sides.Left.upperArmDegAfter).toBeGreaterThan(0)
    expect(qLen(s2.rotations.LeftUpperArm)).toBeCloseTo(1, 12)
  })
})

describe('clip 级 S2-only', () => {
  it('轨道长度/单位化/连续性/未改 Hand，指标改善', () => {
    const clip = constantClip(posedRotations(), 12)
    const b = deriveS2Coefficients(sourceRig(), targetRig())
    const out = retargetClipV2(clip, {
      sourceRest: sourceRig(),
      targetRest: targetRig(),
      mode: 's2',
      k: b.kSocket,
      clipName: 'idle'
    })
    expect(out.excluded).toBe(false)
    expect(out.frameMetrics).toHaveLength(12)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      expect(out.tracks[bone]).toHaveLength(12)
      for (const q of out.tracks[bone]) {
        expect(qLen(q)).toBeCloseTo(1, 12)
        expect(q.every((v: number) => Number.isFinite(v))).toBe(true)
      }
    }
    expect(out.tracks.LeftHand).toBeUndefined()
    expect(out.summary.sides.Left.socketLiftCm.mean).toBeGreaterThan(0)
    expect(out.summary.sides.Left.socketDropNormErrAfterCm.max)
      .toBeLessThan(out.summary.sides.Left.socketDropNormErrBeforeCm.max)
    expect(out.summary.sides.Left.aPoseBodyHorizontalChangeDeg.max).toBeLessThan(1e-8)
    // S2 下手上移 = 肩点上移
    expect(out.summary.sides.Left.handShiftCm.max)
      .toBeCloseTo(out.summary.sides.Left.socketShiftCm.max, 6)
  })

  it('Hybrid 的 sleep 默认排除、原样返回', () => {
    const clip = constantClip(posedRotations(), 5)
    const out = retargetClipV2(clip, {
      sourceRest: sourceRig(),
      targetRest: targetRig(),
      mode: 'hybrid',
      k: 0.714,
      clipName: 'sleep'
    })
    expect(out.policy).toBe('exclude')
    expect(out.excluded).toBe(true)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      expect(qDot(out.tracks[bone][0], clip.bones[bone].r[0])).toBeCloseTo(1, 12)
    }
  })

  it('Hybrid idle 策略只做 S2（禁手 IK）', () => {
    const clip = constantClip(posedRotations(), 5)
    const out = retargetClipV2(clip, {
      sourceRest: sourceRig(),
      targetRest: targetRig(),
      mode: 'hybrid',
      k: 0.714,
      clipName: 'idle'
    })
    expect(out.policy).toBe('s2')
    expect(out.hybrid).toBeNull()
  })
})

describe('smoothWeights / smoothVectors', () => {
  it('impulse 被扩散，总能量近似保持', () => {
    const values = [0, 0, 0, 1, 0, 0, 0]
    const out = smoothWeights(values, false, 1)
    expect(out[3]).toBeLessThan(1)
    expect(out[3]).toBeGreaterThan(0.3)
    expect(out[2]).toBeGreaterThan(0)
    expect(out[4]).toBeGreaterThan(0)
    const sum = out.reduce((s, v) => s + v, 0)
    expect(sum).toBeGreaterThan(0.98)
    expect(sum).toBeLessThan(1.02)
  })

  it('loop 平滑跨首尾环绕；非 loop 边缘 clamp', () => {
    const loop = smoothWeights([1, 0, 0, 0, 0, 0], true, 1)
    expect(loop[0]).toBeLessThan(1)
    expect(loop[loop.length - 1]).toBeGreaterThan(0)
    const noLoop = smoothWeights([1, 0, 0, 0, 0, 0], false, 1)
    expect(noLoop[0]).toBeGreaterThan(loop[0])
    expect(noLoop[5]).toBe(0)
  })

  it('smoothVectors 保持 null 语义并平滑非空向量', () => {
    const v = [[0, 0, 0], null, [0.03, 0, 0], [0.03, 0, 0], null, [0, 0, 0]]
    const out = smoothVectors(v as any, false, 1)
    expect(out[1]).toBeNull()
    expect(out[2]![0]).toBeGreaterThan(0)
    expect(out[2]![0]).toBeLessThan(0.03)
  })
})

describe('Hybrid guards / 平滑', () => {
  it('小 k（修正小）时通过 guards，手回到原位附近；上臂方向变化 ≤3°', () => {
    const clip = constantClip(posedRotations(), 8)
    const out = retargetClipV2(clip, {
      sourceRest: sourceRig(),
      targetRest: targetRig(),
      mode: 'hybrid',
      k: 0.9,
      clipName: 'sit1'
    })
    expect(out.hybrid).not.toBeNull()
    expect(out.hybrid!.acceptedFrames).toBeGreaterThan(0)
    const m = out.summary.sides.Left
    expect(m.upperArmDirChangeDeg.max).toBeLessThanOrEqual(DEFAULT_GUARDS.maxUpperArmDirChangeDeg + 0.06)
    expect(m.handShiftCm.max).toBeLessThanOrEqual(DEFAULT_GUARDS.maxHandCorrectionCm + 0.06)
    expect(m.elbowFlexAfterDeg.min).toBeGreaterThanOrEqual(DEFAULT_GUARDS.minElbowFlexDeg - 0.6)
    expect(m.elbowFlexAfterDeg.max).toBeLessThanOrEqual(DEFAULT_GUARDS.maxElbowFlexDeg + 0.6)
  })

  it('锁骨角跨阈值：部分帧通过、部分帧回退 S2-only', () => {
    const frames = 10
    const bones: Record<string, { r: number[][] }> = {}
    for (let f = 0; f < frames; f += 1) {
      const deg = f < 5 ? 5 : 30
      const rotations = {
        LeftShoulder: quatMultiply(rotZ(-deg), rotY(-10)),
        LeftUpperArm: rotZ(-10),
        LeftLowerArm: rotZ(-30),
        RightShoulder: quatMultiply(rotZ(deg), rotY(10)),
        RightUpperArm: rotZ(10),
        RightLowerArm: rotZ(30)
      }
      for (const [bone, q] of Object.entries(rotations)) {
        if (!bones[bone]) bones[bone] = { r: [] }
        bones[bone].r.push([q[0], q[1], q[2], q[3]])
      }
    }
    const clip = { frames, loop: false, fps: 30, bones }
    const out = retargetClipV2(clip, {
      sourceRest: sourceRig(),
      targetRest: targetRig(),
      mode: 'hybrid',
      k: 0.85,
      clipName: 'sit1'
    })
    expect(out.hybrid!.acceptedSideFrames).toBeGreaterThan(0)
    expect(out.hybrid!.rejectedSideFrames).toBeGreaterThan(0)
    const m = out.summary.sides.Left
    // 回退帧 = S2-only：手臂 world 朝向不变
    expect(m.upperArmWorldDeltaChangeDeg.max).toBeLessThanOrEqual(DEFAULT_GUARDS.maxUpperArmDirChangeDeg + 0.06)
    // 输出仍然单位化/连续
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm']) {
      for (let i = 1; i < frames; i += 1) {
        expect(qDot(out.tracks[bone][i - 1], out.tracks[bone][i])).toBeGreaterThanOrEqual(-1e-12)
      }
    }
  })

  it('平滑后帧跳不超过 max(6°, 原 clip 帧跳+0.1)', () => {
    const frames = 20
    const bones: Record<string, { r: number[][] }> = {}
    for (let f = 0; f < frames; f += 1) {
      const deg = f < 10 ? -30 : -10
      const value = quatMultiply(rotZ(deg), rotY(-15))
      for (const [bone, q] of Object.entries({
        LeftShoulder: value,
        LeftUpperArm: rotZ(-20),
        LeftLowerArm: rotZ(-60),
        RightShoulder: quatMultiply(rotZ(-deg), rotY(15)),
        RightUpperArm: rotZ(20),
        RightLowerArm: rotZ(60)
      })) {
        if (!bones[bone]) bones[bone] = { r: [] }
        bones[bone].r.push([q[0], q[1], q[2], q[3]])
      }
    }
    const clip = { frames, loop: false, fps: 30, bones }
    const out = retargetClipV2(clip, {
      sourceRest: sourceRig(),
      targetRest: targetRig(),
      mode: 'hybrid',
      k: 0.714,
      clipName: 'sit1'
    })
    const before = Math.max(
      ...['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']
        .map((bone) => {
          let m = 0
          for (let i = 1; i < frames; i += 1) {
            m = Math.max(m, quatAngleDeg(quatMultiply(quatInvert(clip.bones[bone].r[i - 1]), clip.bones[bone].r[i])))
          }
          return m
        })
    )
    expect(out.trackStats.frameJumpMaxDeg).toBeLessThanOrEqual(Math.max(6, before + 0.1) + 0.05)
  })
})

const hasRealRest = existsSync(SOURCE_REST_GT) && existsSync(TARGET_REST_GT)
describe.skipIf(!hasRealRest)('真实 rest 集成（私有资产，CI 跳过）', () => {
  function loadRest(file: string): Record<string, number[]> {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { bones: Array<{ name: string; worldPos: number[] }> }
    const out: Record<string, number[]> = {}
    for (const bone of data.bones) {
      if (!Array.isArray(bone.worldPos) || bone.worldPos.length < 3) continue
      out[bone.name] = [-bone.worldPos[0], bone.worldPos[1], bone.worldPos[2]]
    }
    return out
  }

  it('idle 全片 S2：无 NaN / world 朝向不变 / 下坠误差下降', () => {
    const clip = JSON.parse(readFileSync(path.join(REPO, 'assets/motions/mate/idle.json'), 'utf8'))
    const b = deriveS2Coefficients(loadRest(SOURCE_REST_GT), loadRest(TARGET_REST_GT))
    const out = retargetClipV2(clip, {
      sourceRest: loadRest(SOURCE_REST_GT),
      targetRest: loadRest(TARGET_REST_GT),
      mode: 's2',
      k: b.kSocket,
      clipName: 'idle'
    })
    expect(out.frameMetrics).toHaveLength(clip.frames)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      for (const q of out.tracks[bone]) {
        expect(qLen(q)).toBeCloseTo(1, 9)
        expect(q.every((v: number) => Number.isFinite(v))).toBe(true)
      }
    }
    expect(out.summary.sides.Left.upperArmWorldDeltaChangeDeg.max).toBeLessThan(1e-6)
    expect(out.summary.sides.Left.socketDropNormErrAfterCm.max)
      .toBeLessThan(out.summary.sides.Left.socketDropNormErrBeforeCm.max)
    expect(out.summary.sides.Left.aPoseBodyHorizontalChangeDeg.max).toBeLessThan(1e-6)
  })
})
