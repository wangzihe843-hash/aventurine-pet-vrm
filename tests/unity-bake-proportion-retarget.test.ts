/**
 * 比例感知肩/臂重定向（`scripts/unity-bake/lib/proportion-retarget.mjs`）单测。
 *
 * 纯函数 fixture 用简化骨架（源：torso 0.33m / 锁骨 0.06m / 臂 0.36m；
 * 目标：torso 0.47m / 锁骨 0.12m / 臂 0.44m），不读私有资产。
 * 末尾一个 `skipIf` 集成用例：若本机存在 Unity GT rest JSON，则用真实 Zome/男体 rest
 * 跑一遍 idle，检查轨道结构/单位化（CI 无私有资产时自动跳过）。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  capQuatAngleFromIdentity,
  computeTorsoFrame,
  decodeRotationTrack,
  deriveProportions,
  enforceQuatContinuity,
  forwardKinematics,
  quatAngleDeg,
  quatFromUnitVectors,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  retargetClip,
  retargetFrame,
  solveTwoBoneIK,
  vAdd,
  vDist,
  vDot,
  vLen,
  vNorm,
  vScale,
  vSub
} from '../scripts/unity-bake/lib/proportion-retarget.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_REST_GT = path.join(REPO, 'tests/tmp/wave15/groundtruth/unity/zome-rest.json')
const TARGET_REST_GT = path.join(REPO, 'tests/tmp/lead-shoulder/gt-male/out/unity/aventurine-tpose-rest.json')

const I = [0, 0, 0, 1]
const qLen = (q: number[]): number => Math.hypot(q[0], q[1], q[2], q[3])
const qDot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]

/** 合成源骨架：torso 0.33m，锁骨 0.06m，臂 0.36m。 */
function sourceRig(): Record<string, number[]> {
  return {
    Hips: [0, 0.83, 0],
    Spine: [0, 0.87, 0],
    Chest: [0, 0.96, 0],
    Neck: [0, 1.12, 0],
    Head: [0, 1.16, 0],
    LeftShoulder: [0.03, 1.1, 0],
    LeftUpperArm: [0.09, 1.08, 0],
    LeftLowerArm: [0.28, 1.08, 0],
    LeftHand: [0.45, 1.08, 0],
    RightShoulder: [-0.03, 1.1, 0],
    RightUpperArm: [-0.09, 1.08, 0],
    RightLowerArm: [-0.28, 1.08, 0],
    RightHand: [-0.45, 1.08, 0]
  }
}

/** 合成目标骨架：torso 0.4745m，锁骨 0.123m，臂 0.443m（接近 aventurine-tpose）。 */
function targetRig(): Record<string, number[]> {
  return {
    Hips: [0, 1.0661, 0],
    Spine: [0, 1.0797, 0],
    Chest: [0, 1.2612, 0],
    Neck: [0, 1.4653, 0],
    Head: [0, 1.5391, 0],
    LeftShoulder: [0.0357, 1.3955, -0.0461],
    LeftUpperArm: [0.1587, 1.3875, -0.0495],
    LeftLowerArm: [0.3894, 1.3875, -0.0495],
    LeftHand: [0.6022, 1.3875, -0.0495],
    RightShoulder: [-0.0357, 1.3955, -0.0461],
    RightUpperArm: [-0.1587, 1.3875, -0.0495],
    RightLowerArm: [-0.3894, 1.3875, -0.0495],
    RightHand: [-0.6022, 1.3875, -0.0495]
  }
}

/** 绕世界 Z 轴旋转（左臂抬高/压低用）。 */
function rotZ(deg: number): number[] {
  const h = (deg * Math.PI) / 180 / 2
  return [0, 0, Math.sin(h), Math.cos(h)]
}
function rotX(deg: number): number[] {
  const h = (deg * Math.PI) / 180 / 2
  return [Math.sin(h), 0, 0, Math.cos(h)]
}
function rotY(deg: number): number[] {
  const h = (deg * Math.PI) / 180 / 2
  return [0, Math.sin(h), 0, Math.cos(h)]
}

/** 合成一帧：源锁骨 25° 下压 + 15° 后缩，上臂 20°、前臂 30°。 */
function posedRotations(): Record<string, number[]> {
  return {
    LeftShoulder: quatMultiply(rotZ(-25), rotY(-15)),
    LeftUpperArm: quatMultiply(rotZ(-20), rotX(10)),
    LeftLowerArm: rotZ(-60),
    RightShoulder: quatMultiply(rotZ(25), rotY(15)),
    RightUpperArm: quatMultiply(rotZ(20), rotX(10)),
    RightLowerArm: rotZ(60)
  }
}

describe('比例推导 / torso 系', () => {
  it('deriveProportions 给出 torso、锁骨、臂、肩宽比例', () => {
    const p = deriveProportions(sourceRig(), targetRig())
    expect(p.sourceTorsoLengthM).toBeCloseTo(0.33, 6)
    expect(p.targetTorsoLengthM).toBeCloseTo(0.473, 3)
    expect(p.torsoScale).toBeCloseTo(1.434, 2)
    expect(p.sourceClavicleLengthM).toBeCloseTo(0.0632, 4)
    expect(p.targetClavicleLengthM).toBeCloseTo(0.1233, 3)
    expect(p.clavicleScale).toBeCloseTo(1.95, 2)
    expect(p.armScale).toBeCloseTo(1.22, 1)
    expect(p.sourceShoulderHalfWidthM).toBeCloseTo(0.09, 4)
    expect(p.targetShoulderHalfWidthM).toBeCloseTo(0.1587, 4)
  })

  it('torso 系正交、原点 hips、up=hips→head、left=双肩连线', () => {
    const frame = computeTorsoFrame({ positions: sourceRig() })
    expect(frame.origin).toEqual([0, 0.83, 0])
    expect(frame.up).toEqual([0, 1, 0])
    expect(frame.left[0]).toBeCloseTo(1, 6)
    expect(vDot(frame.left, frame.up)).toBeCloseTo(0, 9)
    expect(vDot(frame.forward, frame.up)).toBeCloseTo(0, 9)
    expect(vDot(frame.forward, frame.left)).toBeCloseTo(0, 9)
  })

  it('quatFromUnitVectors / quatRotateVec 基本正确', () => {
    const q = quatFromUnitVectors([1, 0, 0], [0, 1, 0])
    expect(vDist(quatRotateVec(q, [1, 0, 0]), [0, 1, 0])).toBeLessThan(1e-9)
    const q2 = quatFromUnitVectors([0, 1, 0], [0, -1, 0])
    expect(vDist(quatRotateVec(q2, [0, 1, 0]), [0, -1, 0])).toBeLessThan(1e-9)
  })

  it('capQuatAngleFromIdentity 保持轴、限制角', () => {
    const q = rotZ(80)
    const capped = capQuatAngleFromIdentity(q, 30)
    expect(capped.capped).toBe(true)
    expect(capped.quat[2]).toBeGreaterThan(0)
    expect(quatAngleDeg(capped.quat)).toBeCloseTo(30, 6)
    const no = capQuatAngleFromIdentity(rotZ(20), 30)
    expect(no.capped).toBe(false)
  })
})

describe('FK / upperChest 折叠', () => {
  it('identity 时位置=rest、world delta=identity', () => {
    const pose = forwardKinematics(sourceRig(), {})
    for (const [bone, p] of Object.entries(sourceRig())) {
      if (!pose.positions[bone]) continue
      expect(vDist(pose.positions[bone], p)).toBeLessThan(1e-9)
    }
    expect(quatAngleDeg(pose.deltas.Chest)).toBeCloseTo(0, 9)
  })

  it('缺 upperChest 时 q_chest·U 折叠：子骨 world 朝向与虚拟 upperChest 链一致', () => {
    const rotations = {
      Chest: rotX(10),
      UpperChest: rotZ(15),
      LeftShoulder: rotY(8),
      Neck: rotX(4)
    }
    const rest = sourceRig()
    // 无 upperChest：折叠
    const folded = forwardKinematics(rest, rotations)
    // 有 upperChest：在 chest 与 shoulder 之间插一根虚拟骨（位置 chest→neck 中点）
    const restWithUc: Record<string, number[]> = {
      ...rest,
      UpperChest: [
        rest.Chest[0],
        rest.Chest[1] + (rest.Head[1] - rest.Chest[1]) * 0.4,
        rest.Chest[2]
      ]
    }
    const full = forwardKinematics(restWithUc, rotations)
    // full 的 shoulder/neck/head world delta 应与 folded 完全一致（fold α=1）
    for (const bone of ['LeftShoulder', 'RightShoulder', 'Neck', 'Head']) {
      const d = quatMultiply(folded.deltas[bone], [-full.deltas[bone][0], -full.deltas[bone][1], -full.deltas[bone][2], full.deltas[bone][3]])
      expect(quatAngleDeg(d)).toBeLessThan(1e-6)
    }
    // chest 的 world delta 在 full 链里是 q_chest（U 在 UpperChest 节点），folded 里是 q_chest·U——这是 α=1 的定义，不求相等
  })
})

describe('两骨 IK', () => {
  const root = [0, 0, 0]
  const l1 = 0.23
  const l2 = 0.21

  it('可达目标：wrist 精确、骨长保持、pole 侧正确', () => {
    const target = [0.2, -0.2, 0.1]
    const pole = [0, 0.2, 0.3]
    const out = solveTwoBoneIK({ root, target, polePoint: pole, l1, l2 })
    expect(out.clamped).toBe(false)
    expect(vDist(out.wrist, target)).toBeLessThan(1e-9)
    expect(vDist(root, out.elbow)).toBeCloseTo(l1, 9)
    expect(vDist(out.elbow, out.wrist)).toBeCloseTo(l2, 9)
    // 肘在 pole 侧：源肘（pole）相对 root→target 轴的垂直分量与 elbow 同向
    const axis = vNorm(vSub(target, root))
    const polePerp = vNorm(vSub(vSub(pole, root), vScale(axis, vDot(vSub(pole, root), axis))))
    const elbowPerp = vSub(out.elbow, vAdd(root, vScale(axis, vDot(vSub(out.elbow, root), axis))))
    expect(vDot(polePerp, elbowPerp)).toBeGreaterThan(0)
  })

  it('不可达：clamp 到 98% reach、肘屈约 23°、wrist 在目标方向', () => {
    const target = [2, 0, 0]
    const out = solveTwoBoneIK({ root, target, polePoint: [0, 0.2, 0.3], l1, l2 })
    expect(out.clamped).toBe(true)
    expect(vLen(out.wrist)).toBeCloseTo(0.98 * (l1 + l2), 9)
    expect(vNorm(out.wrist)[0]).toBeCloseTo(1, 6)
    expect(out.flexDeg).toBeGreaterThan(20)
    expect(out.flexDeg).toBeLessThan(26)
  })

  it('过近：min 屈肘限制生效', () => {
    const target = [0.01, 0, 0]
    const out = solveTwoBoneIK({ root, target, polePoint: [0, 0.2, 0.3], l1, l2, maxElbowFlexDeg: 150 })
    expect(out.clamped).toBe(true)
    expect(vLen(out.wrist)).toBeGreaterThan(0.1)
    expect(out.flexDeg).toBeLessThanOrEqual(150.001)
  })
})

describe('retargetFrame / retargetClip', () => {
  it('锁骨 rest 方向一致时，absolute 模式的局部锁骨角按锁骨长度比压小', () => {
    // 源/目标锁骨都水平，长度 6cm vs 12cm；源锁骨下压 25°，目标只需约 12° 就能得到同样的肩点位移
    const source = sourceRig()
    source.LeftShoulder = [0.03, 1.1, 0]
    source.LeftUpperArm = [0.09, 1.1, 0]
    const target = targetRig()
    target.LeftShoulder = [0.0357, 1.3955, 0]
    target.LeftUpperArm = [0.1587, 1.3955, 0]
    target.RightShoulder = [-0.0357, 1.3955, 0]
    target.RightUpperArm = [-0.1587, 1.3955, 0]
    const out = retargetFrame({
      sourceRest: source,
      targetRest: target,
      rotations: { LeftShoulder: rotZ(-25) }
    })
    const left = out.metrics.sides.Left
    expect(left.shoulderLocalDegSource).toBeCloseTo(25, 4)
    expect(left.shoulderLocalDegAfter).toBeLessThan(16)
    expect(left.socketLiftCm).toBeGreaterThan(0.5)
  })

  it('chest-displacement 模式：源锁骨旋转按 torso/锁骨比例压小；源锁骨为 0 时目标也为 0', () => {
    const source = sourceRig()
    source.LeftShoulder = [0.03, 1.1, 0]
    source.LeftUpperArm = [0.09, 1.1, 0]
    const target = targetRig()
    target.LeftShoulder = [0.0357, 1.3955, 0]
    target.LeftUpperArm = [0.1587, 1.3955, 0]
    target.RightShoulder = [-0.0357, 1.3955, 0]
    target.RightUpperArm = [-0.1587, 1.3955, 0]
    const posed = retargetFrame({
      sourceRest: source,
      targetRest: target,
      rotations: { LeftShoulder: rotZ(-25) },
      options: { socketMode: 'chest-displacement' }
    })
    const m = posed.metrics.sides.Left
    expect(m.shoulderLocalDegSource).toBeCloseTo(25, 4)
    expect(m.shoulderLocalDegAfter).toBeGreaterThan(10)
    expect(m.shoulderLocalDegAfter).toBeLessThan(20)
    expect(m.socketLiftCm).toBeGreaterThan(0)

    const rest = retargetFrame({
      sourceRest: source,
      targetRest: target,
      rotations: {},
      options: { socketMode: 'chest-displacement' }
    })
    expect(rest.metrics.sides.Left.shoulderLocalDegAfter).toBeLessThan(1e-6)
    expect(rest.metrics.sides.Left.socketLiftCm).toBeCloseTo(0, 6)
  })

  it('absolute 模式：源锁骨旋转被按比例压小，手可达时手位误差 <1cm', () => {
    const rotations = posedRotations()
    const out = retargetFrame({ sourceRest: sourceRig(), targetRest: targetRig(), rotations })
    const left = out.metrics.sides.Left
    expect(left.shoulderLocalDegSource).toBeGreaterThan(20)
    expect(left.shoulderLocalDegAfter).toBeLessThan(90)
    expect(left.socketLiftCm).toBeGreaterThan(0)
    expect(left.handErrorCm).toBeLessThan(1)
    expect(left.reachClamped).toBe(false)
    // 只改 3 根/侧；Hand 不变
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      expect(qLen(out.rotations[bone])).toBeCloseTo(1, 9)
    }
    expect(out.rotations.Hand).toBeUndefined()
    // 修改后的 FK 位置：手应接近期望
    const after = forwardKinematics(targetRig(), { ...rotations, ...out.rotations })
    const expected = out.debug.sides.Left.expected.hand
    expect(vDist(after.positions.LeftHand, expected)).toBeLessThan(0.01)
    expect(vDist(after.positions.LeftUpperArm, out.debug.sides.Left.expected.upperArm)).toBeLessThan(0.1)
  })

  it('displacement 模式：identity 旋转时肩窝回到目标 rest（不产生额外肩旋转）', () => {
    const out = retargetFrame({ sourceRest: sourceRig(), targetRest: targetRig(), rotations: {}, options: { socketMode: 'displacement' } })
    const left = out.metrics.sides.Left
    expect(left.socketLiftCm).toBeCloseTo(0, 6)
    expect(left.socketErrorCm).toBeLessThan(1e-6)
    // identity 时肩局部角 = 0（目标 rest 锁骨方向不变）
    expect(left.shoulderLocalDegAfter).toBeLessThan(1e-6)
  })

  it('不可达手目标：clamp 98% reach，不产生 NaN，肩局部角受安全上限约束', () => {
    const rotations = posedRotations()
    // 把源手拉远：源 rest 手更远 → 目标绝对期望超出 reach
    const source = sourceRig()
    source.LeftHand = [1.2, 1.08, 0]
    source.RightHand = [-1.2, 1.08, 0]
    const out = retargetFrame({
      sourceRest: source,
      targetRest: targetRig(),
      rotations,
      options: { maxShoulderLocalDeg: 30 }
    })
    const left = out.metrics.sides.Left
    expect(left.reachClamped).toBe(true)
    expect(left.shoulderLocalDegAfter).toBeLessThanOrEqual(30.001)
    expect(Number.isFinite(left.handErrorCm)).toBe(true)
    expect(left.handErrorCm).toBeGreaterThan(1)
  })

  it('retargetClip：轨道长度/单位化/相邻帧符号连续/Hand 轨道未被改写', () => {
    const frames = 5
    const clip = {
      frames,
      bones: {
        LeftShoulder: { r: Array.from({ length: frames }, () => rotZ(-25)) },
        LeftUpperArm: { r: Array.from({ length: frames }, () => rotZ(-20)) },
        LeftLowerArm: { r: Array.from({ length: frames }, () => rotX(30)) },
        LeftHand: { r: Array.from({ length: frames }, () => rotX(5)) },
        RightShoulder: { r: Array.from({ length: frames }, () => rotZ(25)) },
        RightUpperArm: { r: Array.from({ length: frames }, () => rotZ(20)) },
        RightLowerArm: { r: Array.from({ length: frames }, () => rotX(30)) }
      }
    }
    const out = retargetClip(clip, { sourceRest: sourceRig(), targetRest: targetRig() })
    expect(out.frameMetrics).toHaveLength(frames)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      expect(out.tracks[bone]).toHaveLength(frames)
      for (const q of out.tracks[bone]) expect(qLen(q)).toBeCloseTo(1, 9)
      for (let i = 1; i < frames; i += 1) {
        const d = qDot(out.tracks[bone][i - 1], out.tracks[bone][i])
        expect(d).toBeGreaterThanOrEqual(-1e-12)
      }
    }
    expect(out.tracks.LeftHand).toBeUndefined()
    expect(out.tracks.LeftIndexProximal).toBeUndefined()
    expect(out.proportions.torsoScale).toBeCloseTo(1.434, 2)
  })

  it('decodeRotationTrack / enforceQuatContinuity 兼容 nested/flat', () => {
    const nested = decodeRotationTrack([[0, 0, 0, 1], [0, 0, 1, 0]], 2)
    expect(nested[1][2]).toBeCloseTo(1, 9)
    const flat = decodeRotationTrack([0, 0, 0, 1, 0, 0, 1, 0], 2)
    expect(flat[1][2]).toBeCloseTo(1, 9)
    const cont = enforceQuatContinuity([[0, 0, 0, 1], [0, 0, 0, -1]])
    expect(qDot(cont[0], cont[1])).toBeGreaterThan(0)
  })
})

const hasRealRest = existsSync(SOURCE_REST_GT) && existsSync(TARGET_REST_GT)
describe.skipIf(!hasRealRest)('真实 rest 集成（私有资产，CI 跳过）', () => {
  function loadRest(file: string): Record<string, number[]> {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { bones: Array<{ name: string; worldPos: number[] }> }
    const out: Record<string, number[]> = {}
    for (const bone of data.bones) {
      if (!Array.isArray(bone.worldPos) || bone.worldPos.length < 3) continue
      // Unity → canonical three：x 取反（与 preview / three-vrm rotateVRM0 后的 rest 一致）
      out[bone.name] = [-bone.worldPos[0], bone.worldPos[1], bone.worldPos[2]]
    }
    return out
  }

  it('idle 全片 retarget 不产生 NaN / 单位化 / 轨道长度正确', () => {
    const clipPath = path.join(REPO, 'assets/motions/mate/idle.json')
    const clip = JSON.parse(readFileSync(clipPath, 'utf8'))
    const out = retargetClip(clip, {
      sourceRest: loadRest(SOURCE_REST_GT),
      targetRest: loadRest(TARGET_REST_GT),
      options: { maxShoulderLocalDeg: 30 }
    })
    expect(out.frameMetrics).toHaveLength(clip.frames)
    for (const bone of ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']) {
      expect(out.tracks[bone]).toHaveLength(clip.frames)
      for (const q of out.tracks[bone]) {
        expect(qLen(q)).toBeCloseTo(1, 9)
        expect(q.every((v) => Number.isFinite(v))).toBe(true)
      }
    }
    expect(out.summary).not.toBeNull()
    expect(out.summary.frames).toBe(clip.frames)
  })
})
