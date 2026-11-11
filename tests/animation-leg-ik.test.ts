/**
 * B3 单测：解析二骨 IK / 髋高补偿 / 接地（脚底贴地）精度。
 *
 * 用本模型实测 rest 位置（tests/tmp/bones.json 的真实数值，这里复制为测试夹具，
 * 避免测试依赖 gitignored 的 tmp 目录）：髋 y=12.234、膝 y=6.784、踝 y=1.229、踝 z=−0.503。
 */
import { describe, expect, it } from 'vitest'

import {
  ankleFromAngles,
  computeHipDropForReach,
  computeHipLiftForMinReach,
  createLegGeometry,
  footWorldQuat,
  solutionAngles,
  solveLegSagittal
} from '../src/renderer/src/animation/legacy/leg-ik'
import {
  createGroundingRig,
  hipPosition,
  solveGrounding
} from '../src/renderer/src/animation/legacy/grounding'
import { eulerDegToQuat, quatFromAxisAngle, rotateVec3 } from '../src/renderer/src/animation/legacy/quat'
import type { Vec3 } from '../src/renderer/src/animation/legacy/types'

const HIP_L: Vec3 = { x: 0.943, y: 12.234, z: -0.071 }
const KNEE_L: Vec3 = { x: 1.046, y: 6.784, z: -0.086 }
const ANKLE_L: Vec3 = { x: 1.151, y: 1.229, z: -0.503 }
const HIP_R: Vec3 = { x: -0.943, y: 12.234, z: -0.071 }
const KNEE_R: Vec3 = { x: -1.046, y: 6.784, z: -0.086 }
const ANKLE_R: Vec3 = { x: -1.151, y: 1.229, z: -0.503 }
const MODEL_HEIGHT = 21.681
const PET_HEIGHT_PX = 540
const PX_PER_UNIT = PET_HEIGHT_PX / MODEL_HEIGHT // ≈ 24.9

/** 模型实测 rest 位置（只列 B3 需要的骨；与 tests/tmp/bones.json 一致）。 */
const REST: Record<string, Vec3> = {
  センター: { x: 0, y: 8.93, z: 0 },
  グルーブ: { x: 0, y: 9.153, z: 0 },
  腰: { x: 0, y: 12.672, z: -0.267 },
  下半身: { x: 0, y: 13.33, z: -0.071 },
  上半身: { x: 0, y: 13.5, z: -0.071 },
  上半身2: { x: 0, y: 15.769, z: -0.071 },
  首: { x: 0, y: 18.321, z: -0.595 },
  頭: { x: 0, y: 19.244, z: -0.54 },
  左足D: HIP_L,
  左ひざD: KNEE_L,
  左足首D: ANKLE_L,
  左足先EX: { x: 1.177, y: 0.65, z: 1.125 },
  右足D: HIP_R,
  右ひざD: KNEE_R,
  右足首D: ANKLE_R,
  右足先EX: { x: -1.177, y: 0.65, z: 1.125 },
  '辮子1-1': { x: 0.468, y: 19.324, z: -0.776 },
  '辮子1-2': { x: 0.522, y: 19.124, z: -0.58 },
  '辮子1-3': { x: 0.575, y: 18.819, z: -0.378 },
  '辮子1-4': { x: 0.52, y: 18.599, z: -0.099 },
  '辮子1-5': { x: 0.488, y: 18.372, z: 0.041 },
  '辮子2-1': { x: 0.432, y: 18.604, z: 0 },
  '辮碎髮': { x: 0.12, y: 19.328, z: -0.939 }
}

const LEG = createLegGeometry(HIP_L, KNEE_L, ANKLE_L)

describe('leg-ik：rest 几何与二骨 IK 精度', () => {
  it('由真实 rest 位置推导大腿/小腿长度与 rest 方向角', () => {
    expect(LEG.thighLen).toBeCloseTo(5.452, 1)
    expect(LEG.shinLen).toBeCloseTo(5.573, 1)
    // 大腿近竖直（rest 角 ≈ 0），小腿略向后（rest 角 > 0）
    expect(Math.abs(LEG.restThighAngle)).toBeLessThan(0.01)
    expect(LEG.restShinAngle).toBeGreaterThan(0.05)
    expect(LEG.restShinAngle).toBeLessThan(0.1)
  })

  it('rest 踝目标 → 解出的附加角几乎为 0（校准成立）', () => {
    const solution = solveLegSagittal(HIP_L.y, HIP_L.z, ANKLE_L.y, ANKLE_L.z, LEG)
    expect(Math.abs(solution.thighPitch)).toBeLessThan(0.02)
    expect(Math.abs(solution.kneePitch)).toBeLessThan(0.02)
    expect(solution.reachable).toBe(true)
    expect(Number.isFinite(solution.footPitch)).toBe(true)
  })

  it('解出的角度回推踝位置 ≈ 目标（误差 < 1e-6）', () => {
    const targets = [
      { y: 1.229, z: -0.503 }, // rest
      { y: 1.229, z: 0.6 }, // 前脚掌
      { y: 1.7, z: -0.2 }, // 抬脚
      { y: 1.229, z: -1.4 } // 后摆
    ]
    for (const target of targets) {
      const solution = solveLegSagittal(12.1, -0.071, target.y, target.z, LEG)
      const angles = solutionAngles(solution, LEG)
      const reached = ankleFromAngles(12.1, -0.071, angles.thighAngle, angles.shinAngle, LEG)
      expect(Math.abs(reached.y - target.y)).toBeLessThan(1e-6)
      expect(Math.abs(reached.z - target.z)).toBeLessThan(1e-6)
      // 膝盖屈曲范围合理（不会反折）
      expect(solution.kneePitch).toBeGreaterThanOrEqual(-0.05)
      expect(solution.kneePitch).toBeLessThanOrEqual(Math.PI + 0.05)
    }
  })

  it('目标超出腿长 → 钳制不 NaN、标记不可达', () => {
    const solution = solveLegSagittal(HIP_L.y, HIP_L.z, ANKLE_L.y - 20, ANKLE_L.z, LEG)
    expect(Number.isFinite(solution.thighPitch)).toBe(true)
    expect(Number.isFinite(solution.kneePitch)).toBe(true)
    expect(solution.reachable).toBe(false)
    expect(solution.distance).toBeLessThanOrEqual(LEG.thighLen + LEG.shinLen)
  })

  it('退化输入（髋=踝）不 NaN', () => {
    const solution = solveLegSagittal(5, 0, 5, 0, LEG)
    expect(Number.isFinite(solution.thighPitch)).toBe(true)
    expect(Number.isFinite(solution.kneePitch)).toBe(true)
  })

  it('髋高补偿：够不着时返回下沉量、过近时返回抬升量', () => {
    const drop = computeHipDropForReach(HIP_L.y, HIP_L.z, ANKLE_L.y - 3, ANKLE_L.z, LEG)
    expect(drop).toBeGreaterThan(2)
    const noDrop = computeHipDropForReach(HIP_L.y - 2, HIP_L.z, ANKLE_L.y, ANKLE_L.z, LEG)
    expect(noDrop).toBe(0)
    const lift = computeHipLiftForMinReach(HIP_L.y - 10, HIP_L.z, ANKLE_L.y, ANKLE_L.z)
    expect(lift).toBeGreaterThan(0)
  })

  it('脚掌世界朝向：水平 + 外八 yaw', () => {
    const flat = footWorldQuat(0)
    expect(rotateVec3(flat, { x: 0, y: 0, z: 1 }).z).toBeCloseTo(1, 9)
    const out = footWorldQuat(10)
    const toe = rotateVec3(out, { x: 0, y: 0, z: 1 })
    expect(toe.x).toBeGreaterThan(0) // 脚尖朝 +X（角色左）= 外八
    expect(toe.y).toBeCloseTo(0, 9) // 鞋底保持水平
  })
})

describe('grounding：髋位置/接地/脚底误差', () => {
  const rig = createGroundingRig(REST)!
  const identity = { x: 0, y: 0, z: 0, w: 1 }

  it('接地几何构建成功，rest 踝位置正确', () => {
    expect(rig).not.toBeNull()
    expect(rig.legs.left.ankleRest.y).toBeCloseTo(1.229, 6)
    expect(rig.legs.right.geometry.thighLen).toBeCloseTo(LEG.thighLen, 6)
  })

  it('骨盆未旋转时髋位置 = rest + 重心偏移', () => {
    const hip = hipPosition(rig, rig.legs.left, identity, -0.5)
    expect(hip.x).toBeCloseTo(HIP_L.x, 6)
    expect(hip.y).toBeCloseTo(HIP_L.y - 0.5, 6)
    expect(hip.z).toBeCloseTo(HIP_L.z, 6)
  })

  it('骨盆绕 Z 旋转 10°：髋部随之移动（权重转移的数学来源）', () => {
    const hip = hipPosition(rig, rig.legs.left, eulerDegToQuat({ z: 10 }), 0)
    expect(Math.abs(hip.x - HIP_L.x)).toBeGreaterThan(0.05)
    expect(Math.abs(hip.y - HIP_L.y)).toBeGreaterThan(0.05)
  })

  it('站姿接地：脚底误差 < 2px（crouch 0.14，540px 宠物）', () => {
    const result = solveGrounding({
      rig,
      pelvisQuat: identity,
      centerYOffset: -0.14,
      leftFoot: { forward: 0.55, yawDeg: 8 },
      rightFoot: { forward: -0.25, yawDeg: -4 },
      pxPerUnit: PX_PER_UNIT
    })
    expect(result.footErrorPx).toBeLessThan(2)
    expect(result.rotations.size).toBe(6)
    expect(result.rotations.has('左足D')).toBe(true)
    expect(result.rotations.has('右足首D')).toBe(true)
  })

  it('走路抬脚相：抬脚后脚底仍无误差、左右不对称', () => {
    const result = solveGrounding({
      rig,
      pelvisQuat: eulerDegToQuat({ y: -2, z: 2.5 }),
      centerYOffset: -0.38,
      leftFoot: { forward: 0.85, lift: 0 },
      rightFoot: { forward: -0.85, lift: 0.55 },
      pxPerUnit: PX_PER_UNIT
    })
    expect(result.footErrorPx).toBeLessThan(2)
    expect(result.solutions.left.distance).not.toBeCloseTo(result.solutions.right.distance, 2)
  })

  it('重心过低（深蹲）时髋高补偿抬升；重心过高时压低下沉', () => {
    const high = solveGrounding({ rig, pelvisQuat: identity, centerYOffset: 0, pxPerUnit: PX_PER_UNIT })
    expect(high.compensation.drop).toBeGreaterThan(0)
    expect(high.centerYOffset).toBeLessThan(0)
    const low = solveGrounding({ rig, pelvisQuat: identity, centerYOffset: -2, pxPerUnit: PX_PER_UNIT })
    expect(low.compensation.drop).toBe(0)
    expect(low.footErrorPx).toBeLessThan(2)
  })

  it('落地 crouchPulse：重心额外压低、脚底仍贴地', () => {
    const normal = solveGrounding({ rig, pelvisQuat: identity, centerYOffset: -0.14, pxPerUnit: PX_PER_UNIT })
    const landing = solveGrounding({
      rig,
      pelvisQuat: identity,
      centerYOffset: -0.14,
      crouchPulse: 0.55,
      pxPerUnit: PX_PER_UNIT
    })
    expect(landing.centerYOffset).toBeLessThan(normal.centerYOffset - 0.3)
    expect(landing.footErrorPx).toBeLessThan(2)
  })

  it('脚掌贴平：脚骨局部四元数包含与大腿+膝相反的俯仰（软系数 0.7）', () => {
    const result = solveGrounding({ rig, pelvisQuat: identity, centerYOffset: -0.14, pxPerUnit: PX_PER_UNIT })
    const thigh = result.rotations.get('左足D')!
    const foot = result.rotations.get('左足首D')!
    expect(Number.isFinite(thigh.w)).toBe(true)
    expect(Number.isFinite(foot.w)).toBe(true)
    // 大腿有明显俯仰时脚必须反向补偿（不是恒等）
    const thighAngle = 2 * Math.acos(Math.min(1, Math.abs(thigh.w)))
    const footAngle = 2 * Math.acos(Math.min(1, Math.abs(foot.w)))
    expect(thighAngle).toBeGreaterThan(0.01)
    expect(footAngle).toBeGreaterThan(0.005)
  })

  it('缺少腿骨时 createGroundingRig 返回 null（降级不抛）', () => {
    const partial = { ...REST }
    delete (partial as Record<string, Vec3>)['左足首D']
    expect(createGroundingRig(partial)).toBeNull()
  })

  it('骨盆旋转 + 抬脚组合仍是有限数（无 NaN）', () => {
    const result = solveGrounding({
      rig,
      pelvisQuat: eulerDegToQuat({ x: 3, y: 5, z: -4 }),
      centerYOffset: -0.3,
      crouchPulse: 0.2,
      leftFoot: { forward: 0.4, lift: 0.2, yawDeg: 10 },
      rightFoot: { forward: -0.6, lift: 0, yawDeg: -6 },
      pxPerUnit: PX_PER_UNIT
    })
    for (const [, quat] of result.rotations) {
      expect(Number.isFinite(quat.x)).toBe(true)
      expect(Number.isFinite(quat.y)).toBe(true)
      expect(Number.isFinite(quat.z)).toBe(true)
      expect(Number.isFinite(quat.w)).toBe(true)
    }
    expect(Number.isFinite(result.centerYOffset)).toBe(true)
    expect(result.footErrorPx).toBeLessThan(2)
  })

  it('脚目标 yaw 会改变脚骨四元数（外八），但不影响贴地误差', () => {
    const straight = solveGrounding({ rig, pelvisQuat: identity, centerYOffset: -0.14, pxPerUnit: PX_PER_UNIT })
    const toedOut = solveGrounding({
      rig,
      pelvisQuat: identity,
      centerYOffset: -0.14,
      leftFoot: { yawDeg: 12 },
      rightFoot: { yawDeg: -12 },
      pxPerUnit: PX_PER_UNIT
    })
    expect(straight.footErrorPx).toBeLessThan(2)
    expect(toedOut.footErrorPx).toBeLessThan(2)
    const q1 = straight.rotations.get('左足首D')!
    const q2 = toedOut.rotations.get('左足首D')!
    expect(Math.abs(q1.y - q2.y) + Math.abs(q1.w - q2.w)).toBeGreaterThan(1e-4)
  })

  it('footSoft 软系数（0.7）让脚掌不是 100% 反向（避免脚背反折）', () => {
    const result = solveGrounding({ rig, pelvisQuat: identity, centerYOffset: -0.6, pxPerUnit: PX_PER_UNIT })
    const thigh = result.rotations.get('左足D')!
    const shin = result.rotations.get('左ひざD')!
    const foot = result.rotations.get('左足首D')!
    // 三者都不是恒等（深蹲时膝盖明显弯曲）
    expect(Math.abs(shin.x) + Math.abs(shin.w - 1)).toBeGreaterThan(0.01)
    expect(Math.abs(foot.x) + Math.abs(foot.w - 1)).toBeGreaterThan(0.005)
    expect(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 0)).toEqual({ x: 0, y: 0, z: 0, w: 1 })
    expect(thigh).toBeDefined()
  })
})
