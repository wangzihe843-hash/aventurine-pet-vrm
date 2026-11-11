/**
 * 比例感知重定向 v3（S2-absolute + hybrid-absolute）单测。
 *
 * 纯函数 fixture 与 v2 测试同源（源：torso 0.33m / 锁骨 0.063m / 臂 0.36m；
 * 目标：torso 0.473m / 锁骨 0.123m / 臂 0.443m），不读私有资产。
 * 末尾一个 skipIf 集成用例：若本机存在 Unity GT rest JSON，则用真实 Zome/男体 rest 跑 idle。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  computeTorsoFrame,
  forwardKinematics,
  frameLocal,
  frameWorld,
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
  applyAbsoluteFrame,
  absoluteTargetForSide,
  resolveV3Policy,
  retargetClipV3,
  solveAbsoluteHybridCandidate,
  solveAbsoluteSide
} from '../scripts/unity-bake/lib/proportion-retarget-v3.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_REST_GT = path.join(REPO, 'tests/tmp/wave15/groundtruth/unity/zome-rest.json')
const TARGET_REST_GT = path.join(REPO, 'tests/tmp/lead-shoulder/gt-male/out/unity/aventurine-tpose-rest.json')

const I = [0, 0, 0, 1]
const qDot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
const qLen = (q: number[]): number => Math.hypot(q[0], q[1], q[2], q[3])

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

const GUARDS = {
  maxUpperArmDirChangeDeg: 4,
  maxHandCorrectionCm: 4,
  minElbowFlexDeg: 15,
  maxElbowFlexDeg: 150,
  reachRatio: 0.98
}

function setup(): {
  sourceRest: Record<string, number[]>
  targetRest: Record<string, number[]>
  rotations: Record<string, number[]>
  targetBefore: any
  targetFrame: any
  sourceFrame: any
  sourcePose: any
  absTarget: number[]
} {
  const sourceRest = sourceRig()
  const targetRest = targetRig()
  const rotations = posedRotations()
  const sourcePose = forwardKinematics(sourceRest, rotations)
  const targetBefore = forwardKinematics(targetRest, rotations)
  const sourceFrame = computeTorsoFrame(sourcePose)
  const targetFrame = computeTorsoFrame(targetBefore)
  const absTarget = absoluteTargetForSide({
    side: 'Left',
    sourcePose,
    sourceFrame,
    targetFrame,
    sourceTorsoM: 0.33,
    targetTorsoM: 0.473
  })
  return { sourceRest, targetRest, rotations, targetBefore, targetFrame, sourceFrame, sourcePose, absTarget }
}

describe('绝对目标 / aim', () => {
  it('absoluteTargetForSide = 源 posed torso 归一化 × 目标 torso 长', () => {
    const { sourceRest, targetRest, rotations, sourcePose, sourceFrame, targetFrame } = setup()
    const sourceTorsoM = vDist(sourceRest.Head, sourceRest.Hips)
    const targetTorsoM = vDist(targetRest.Head, targetRest.Hips)
    const expected = frameWorld(
      targetFrame,
      frameLocal(sourceFrame, sourcePose.positions.LeftUpperArm).map((v) => (v / sourceTorsoM) * targetTorsoM)
    )
    const actual = absoluteTargetForSide({
      side: 'Left', sourcePose, sourceFrame, targetFrame, sourceTorsoM, targetTorsoM
    })
    expect(vDist(actual, expected)).toBeLessThan(1e-12)
  })

  it('liftFraction=0 恒等：锁骨/上臂/前臂原样、socket 不动', () => {
    const { targetRest, rotations, targetBefore, targetFrame, absTarget } = setup()
    const out = solveAbsoluteSide({
      side: 'Left', rotations, targetRest, targetBefore, targetFrame,
      absoluteTargetWorld: absTarget, liftFraction: 0
    })
    expect(qDot(out.qShoulder, rotations.LeftShoulder)).toBeCloseTo(1, 12)
    expect(qDot(out.qUpperArm, rotations.LeftUpperArm)).toBeCloseTo(1, 12)
    expect(qDot(out.qLowerArm, rotations.LeftLowerArm)).toBeCloseTo(1, 12)
    expect(vDist(out.socket, targetBefore.positions.LeftUpperArm)).toBeLessThan(1e-9)
    expect(out.actualSocketLiftCm).toBeCloseTo(0, 9)
  })

  it('liftFraction=1：锁骨长度固定，方向指向目标（不可达时方向最优），socket 落球面', () => {
    const { targetRest, rotations, targetBefore, targetFrame, absTarget } = setup()
    const out = solveAbsoluteSide({
      side: 'Left', rotations, targetRest, targetBefore, targetFrame,
      absoluteTargetWorld: absTarget, liftFraction: 1, maxShoulderLocalDeg: 180
    })
    const root = targetBefore.positions.LeftShoulder
    const restLen = vDist(targetRest.LeftUpperArm, targetRest.LeftShoulder)
    expect(vDist(out.socket, root)).toBeCloseTo(restLen, 9)
    const toTarget = vNorm(vSub(absTarget, root))
    const toSocket = vNorm(vSub(out.socket, root))
    // 目标在锁骨长以内时方向应一致；以外时 aim 方向也一致（长度差造成 socketError）。
    expect(vDot(toTarget, toSocket)).toBeCloseTo(1, 9)
    expect(out.socketErrorVsAbsoluteTargetCm).toBeGreaterThan(0.5)
    expect(out.capHit).toBe(false) // 180° cap 下只看 aim 方向
  })

  it('任意 liftFraction：upperArm/lowerArm/hand 的 world 朝向不变', () => {
    const { targetRest, rotations, targetBefore, targetFrame, absTarget } = setup()
    for (const liftFraction of [0, 0.25, 0.5, 0.75, 1]) {
      const out = solveAbsoluteSide({
        side: 'Left', rotations, targetRest, targetBefore, targetFrame,
        absoluteTargetWorld: absTarget, liftFraction, maxShoulderLocalDeg: 90
      })
      const after = forwardKinematics(targetRest, {
        ...rotations,
        LeftShoulder: out.qShoulder,
        LeftUpperArm: out.qUpperArm,
        LeftLowerArm: out.qLowerArm
      })
      for (const bone of ['LeftUpperArm', 'LeftLowerArm', 'LeftHand']) {
        expect(quatAngleDeg(quatMultiply(quatInvert(targetBefore.deltas[bone]), after.deltas[bone]))).toBeLessThan(1e-7)
      }
    }
  })

  it('锁骨头 cap 限制局部角并报告 capHit', () => {
    const { targetRest, rotations, targetBefore, targetFrame, absTarget } = setup()
    const out = solveAbsoluteSide({
      side: 'Left', rotations, targetRest, targetBefore, targetFrame,
      absoluteTargetWorld: absTarget, liftFraction: 1, maxShoulderLocalDeg: 10
    })
    expect(out.capHit).toBe(true)
    expect(out.shoulderLocalAfterDeg).toBeCloseTo(10, 6)
  })
})

describe('clip 级 S2-absolute', () => {
  it('liftFraction 0/0.5/1 的 socket lift 单调增加，f=0 手不动', () => {
    const clip = constantClip(posedRotations(), 6)
    const base = {
      sourceRest: sourceRig(), targetRest: targetRig(), mode: 'absolute', clipName: 'idle'
    }
    const f0 = retargetClipV3(clip, { ...base, liftFraction: 0 })
    const f05 = retargetClipV3(clip, { ...base, liftFraction: 0.5, maxShoulderLocalDeg: 90 })
    const f1 = retargetClipV3(clip, { ...base, liftFraction: 1, maxShoulderLocalDeg: 90 })
    expect(f0.summary.sides.Left.socketLiftCm.max).toBeLessThan(0.01)
    expect(f0.summary.sides.Left.handShiftCm.max).toBeLessThan(0.01)
    expect(f05.summary.sides.Left.socketLiftCm.max).toBeGreaterThan(0)
    expect(f1.summary.sides.Left.socketLiftCm.max).toBeGreaterThan(f05.summary.sides.Left.socketLiftCm.max)
    expect(f1.summary.sides.Left.aPoseBodyHorizontalChangeDeg.max).toBeLessThan(1e-6)
    expect(f1.summary.sides.Left.upperArmWorldDeltaChangeDeg.max).toBeLessThan(1e-6)
  })

  it('输出 6 轨、单位化、连续、无 NaN、loop 首尾一致', () => {
    const clip = constantClip(posedRotations(), 10)
    const out = retargetClipV3(clip, {
      sourceRest: sourceRig(), targetRest: targetRig(), mode: 'absolute', liftFraction: 1, clipName: 'idle'
    })
    const bones = ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']
    for (const bone of bones) {
      expect(out.tracks[bone]).toHaveLength(10)
      for (const q of out.tracks[bone]) {
        expect(qLen(q)).toBeCloseTo(1, 12)
        expect(q.every((v: number) => Number.isFinite(v))).toBe(true)
      }
      for (let i = 1; i < out.tracks[bone].length; i += 1) {
        expect(qDot(out.tracks[bone][i - 1], out.tracks[bone][i])).toBeGreaterThanOrEqual(-1e-12)
      }
    }
    expect(out.tracks.LeftHand).toBeUndefined()
    expect(out.frameMetrics).toHaveLength(10)
    expect(out.summary.sides.Left.handCorrectionFromAbsoluteCm.max).toBeLessThan(1e-6)
  })

  it('白名单策略：idle/gesture 只 absolute，sit1/sitWindow 用 hybrid，sleep 对照，walk 排除', () => {
    expect(resolveV3Policy('idle', 'hybrid')).toBe('absolute')
    expect(resolveV3Policy('happy', 'hybrid')).toBe('absolute')
    expect(resolveV3Policy('sit1', 'hybrid')).toBe('absolute-hybrid')
    expect(resolveV3Policy('sitWindow', 'hybrid')).toBe('absolute-hybrid')
    expect(resolveV3Policy('sleep', 'hybrid')).toBe('absolute')
    expect(resolveV3Policy('walk', 'hybrid')).toBe('exclude')
    expect(resolveV3Policy('sit1', 'absolute')).toBe('absolute')
  })
})

describe('hybrid-absolute 受限手 IK', () => {
  function absPose(liftFraction = 0.2): { poseAbs: any; targetFrame: any; rotations: Record<string, number[]> } {
    const { sourceRest, targetRest, rotations, targetBefore } = setup()
    const abs = applyAbsoluteFrame({ rotations, sourceRest, targetRest, liftFraction, maxShoulderLocalDeg: 90 })
    const poseAbs = forwardKinematics(targetRest, { ...rotations, ...abs.rotations })
    return { poseAbs, targetFrame: computeTorsoFrame(targetBefore), rotations }
  }

  it('零修正 = 接受且不动', () => {
    const { poseAbs, targetFrame } = absPose()
    const cand = solveAbsoluteHybridCandidate({
      side: 'Left', targetRest: targetRig(), poseAbs, targetFrame,
      correction: [0, 0, 0], guards: GUARDS
    })
    expect(cand.accepted).toBe(true)
    expect(cand.correctionCm).toBeCloseTo(0, 9)
  })

  it('小修正通过 guards：体相对上臂变化 ≤4°、手修正 ≤4cm', () => {
    const { poseAbs, targetFrame } = absPose(0.2)
    const before = forwardKinematics(targetRig(), posedRotations())
    const corr = vSub(before.positions.LeftHand, poseAbs.positions.LeftHand)
    const cand = solveAbsoluteHybridCandidate({
      side: 'Left', targetRest: targetRig(), poseAbs, targetFrame, correction: corr, guards: GUARDS
    })
    expect(cand.accepted).toBe(true)
    expect(cand.correctionCm).toBeLessThanOrEqual(GUARDS.maxHandCorrectionCm + 1e-6)
    expect(cand.upperArmDirChangeDeg).toBeLessThanOrEqual(GUARDS.maxUpperArmDirChangeDeg + 1e-6)
    expect(cand.elbowFlexDeg).toBeGreaterThanOrEqual(GUARDS.minElbowFlexDeg - 1e-6)
    expect(cand.elbowFlexDeg).toBeLessThanOrEqual(GUARDS.maxElbowFlexDeg + 1e-6)
  })

  it('guard 回退：上臂角超限 → upperarm-angle，reach 超限 → reach-clamped', () => {
    const { poseAbs, targetFrame } = absPose(0.2)
    const before = forwardKinematics(targetRig(), posedRotations())
    const corr = vSub(before.positions.LeftHand, poseAbs.positions.LeftHand)
    const angle = solveAbsoluteHybridCandidate({
      side: 'Left', targetRest: targetRig(), poseAbs, targetFrame, correction: corr,
      guards: { ...GUARDS, maxUpperArmDirChangeDeg: 0.1 }
    })
    expect(angle.accepted).toBe(false)
    expect(angle.reason).toBe('upperarm-angle')
    const reach = solveAbsoluteHybridCandidate({
      side: 'Left', targetRest: targetRig(), poseAbs, targetFrame,
      correction: [0.6, 0.2, 0], guards: { ...GUARDS, maxUpperArmDirChangeDeg: 180 }
    })
    expect(reach.accepted).toBe(false)
    expect(reach.reason).toBe('reach-clamped')
  })

  it('clip 级：idle 不做 IK；sit1 会做且失败帧回退 absolute', () => {
    const clip = constantClip(posedRotations(), 6)
    const common = { sourceRest: sourceRig(), targetRest: targetRig(), mode: 'hybrid', liftFraction: 1, guards: GUARDS }
    const idle = retargetClipV3(clip, { ...common, clipName: 'idle' })
    expect(idle.hybrid).toBeNull()
    expect(idle.policy).toBe('absolute')
    const sit = retargetClipV3(clip, { ...common, clipName: 'sit1', guards: { ...GUARDS, maxUpperArmDirChangeDeg: 0.1 } })
    expect(sit.hybrid).not.toBeNull()
    expect(sit.hybrid!.acceptedSideFrames).toBe(0)
    expect(sit.summary.sides.Left.handShiftCm.max)
      .toBeGreaterThan(sit.summary.sides.Left.handCorrectionFromAbsoluteCm.max - 1e-9)
  })

  it('partialIk 只修正一部分：1.0 的手浮 ≤ 0.5 的手浮', () => {
    const clip = constantClip(posedRotations(), 6)
    const common = {
      sourceRest: sourceRig(), targetRest: targetRig(), mode: 'hybrid',
      clipName: 'sit1', liftFraction: 1, maxShoulderLocalDeg: 90,
      guards: { ...GUARDS, maxUpperArmDirChangeDeg: 45, maxHandCorrectionCm: 4 }
    }
    const full = retargetClipV3(clip, { ...common, partialIk: 1 })
    const half = retargetClipV3(clip, { ...common, partialIk: 0.5 })
    expect(full.hybrid!.acceptedSideFrames).toBeGreaterThan(0)
    expect(half.hybrid!.acceptedSideFrames).toBeGreaterThan(0)
    expect(full.summary.sides.Left.handShiftCm.max)
      .toBeLessThanOrEqual(half.summary.sides.Left.handShiftCm.max + 1e-9)
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

  it('idle 全片 S2-absolute：肩高误差下降、world 朝向不变、无 cap/NaN', () => {
    const clip = JSON.parse(readFileSync(path.join(REPO, 'assets/motions/mate/idle.json'), 'utf8'))
    const out = retargetClipV3(clip, {
      sourceRest: loadRest(SOURCE_REST_GT),
      targetRest: loadRest(TARGET_REST_GT),
      mode: 'absolute',
      liftFraction: 1,
      clipName: 'idle'
    })
    expect(out.frameMetrics).toHaveLength(clip.frames)
    expect(out.summary.sides.Left.upperArmWorldDeltaChangeDeg.max).toBeLessThan(1e-6)
    expect(Math.abs(out.summary.sides.Left.normHeightErrAfterCm.max))
      .toBeLessThan(Math.abs(out.summary.sides.Left.normHeightErrBeforeCm.max))
    expect(Math.abs(out.summary.sides.Left.normHeightErrAfterCm.max)).toBeLessThan(1)
    expect(out.summary.sides.Left.shoulderCapHit?.count ?? 0).toBe(0)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      for (const q of out.tracks[bone]) {
        expect(qLen(q)).toBeCloseTo(1, 9)
        expect(q.every((v: number) => Number.isFinite(v))).toBe(true)
      }
    }
  })
})
