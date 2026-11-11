/**
 * 接地（脚底贴地）组装：解析二骨 IK + 髋高补偿 + 脚掌贴平 + 脚底误差（**纯函数**）。
 *
 * v3 扩展（自然站姿 / 3/4 侧身 / contrapposto）：
 * - `センター` 现在允许绕 Y 旋转（3/4 侧身）与绕 Z 翻滚（睡姿），并可横向平移（承重脚换重心）；
 *   髋位置 = センター原点 + qCenter·(下半身 rest 偏移) + (qCenter·qPelvis)·(足D rest 偏移)，
 *   所以重心侧移 + 骨盆倾斜会自动变成「一条腿承重、另一条腿软弯」；
 * - 脚目标支持横向张开（`spread`）：大腿在矢状面解算后，再加绕 Z 的侧摆角把脚移到目标 x；
 * - 脚掌世界朝向 = qX(俯仰) · qY(朝向)；脚掌贴平（俯仰 0）时鞋底水平。
 */
import {
  clamp,
  conjugateQuat,
  multiplyQuat,
  normalizeQuat,
  quatFromAxisAngle,
  rotateVec3
} from './quat'
import {
  ankleFromAngles,
  createLegGeometry,
  footWorldQuat,
  solutionAngles,
  solveLegSagittal,
  type LegGeometry,
  type LegIkSolution
} from './leg-ik'
import type { Quat, Vec3 } from './types'

/** 一条腿的接地几何（rest 位置 + 矢状面长度/角度）。 */
export interface GroundingLeg {
  geometry: LegGeometry
  hipRest: Vec3
  ankleRest: Vec3
}

/** 接地所需骨架几何（由 rest 骨骼世界位置构建一次）。 */
export interface GroundingRig {
  centerRest: Vec3
  pelvisRest: Vec3
  legs: { left: GroundingLeg; right: GroundingLeg }
}

/** 脚目标偏移（模型单位 / 度）。 */
export interface GroundingFootOffset {
  forward?: number
  lift?: number
  yawDeg?: number
  pitchDeg?: number
  /** 横向张开（正 = 向外；左腿 +x、右腿 −x）。 */
  spread?: number
}

/** 接地输入。 */
export interface GroundingInput {
  rig: GroundingRig
  /** 骨盆（下半身）最终局部四元数（姿态层输出）。 */
  pelvisQuat: Quat
  /** `センター.position.y` 偏移（正数抬高、负数压低）。 */
  centerYOffset: number
  /** `センター.position.x` 偏移（正数 = 角色左侧；承重脚换重心用）。 */
  centerXOffset?: number
  /** `センター` 世界旋转（Y = 3/4 侧身，Z = 睡姿翻滚；默认恒等）。 */
  centerQuat?: Quat
  /** 额外下蹲脉冲（模型单位；落地/被戳时由反应层给）。 */
  crouchPulse?: number
  leftFoot?: GroundingFootOffset
  rightFoot?: GroundingFootOffset
  /** 模型单位 → CSS 像素（= petRect.height / 模型 bind 高度）。 */
  pxPerUnit: number
  /** 脚掌贴平软系数（0 = 完全贴平；默认 0）。 */
  footSoft?: number
  /** 身体 3/4 朝向（度；用于身体坐标系；脚目标位置也随它旋转）。 */
  bodyYawDeg?: number
  /** 脚尖基准朝向（度；默认 = bodyYawDeg；传 0 表示脚尖朝镜头）。 */
  footYawBaseDeg?: number
}

/** 接地输出。 */
export interface GroundingResult {
  /** 最终 `センター.position.y` 偏移（含髋高补偿后的值）。 */
  centerYOffset: number
  /** `センター.position.x` 偏移（原样返回，供 scene-bridge 写回）。 */
  centerXOffset: number
  /** 脚底贴地误差（CSS px；站/走 < 2 才算过）。 */
  footErrorPx: number
  /** 6 根 D 链骨局部四元数。 */
  rotations: Map<string, Quat>
  solutions: { left: LegIkSolution; right: LegIkSolution }
  compensation: { drop: number; lift: number }
}

/** 由 rest 骨骼世界位置构建接地几何（缺骨时返回 null，由调用方降级）。 */
export function createGroundingRig(rest: Readonly<Record<string, Vec3>>): GroundingRig | null {
  const centerRest = rest['センター']
  const pelvisRest = rest['下半身']
  const left = buildLeg(rest['左足D'], rest['左ひざD'], rest['左足首D'])
  const right = buildLeg(rest['右足D'], rest['右ひざD'], rest['右足首D'])
  if (!centerRest || !pelvisRest || !left || !right) return null
  return {
    centerRest: { ...centerRest },
    pelvisRest: { ...pelvisRest },
    legs: { left, right }
  }
}

function buildLeg(hip?: Vec3, knee?: Vec3, ankle?: Vec3): GroundingLeg | null {
  if (!hip || !knee || !ankle) return null
  return {
    geometry: createLegGeometry(hip, knee, ankle),
    hipRest: { ...hip },
    ankleRest: { ...ankle }
  }
}

/** 单位轴旋转。 */
function rotX(angle: number): Quat {
  return quatFromAxisAngle({ x: 1, y: 0, z: 0 }, angle)
}
function rotZ(angle: number): Quat {
  return quatFromAxisAngle({ x: 0, y: 0, z: 1 }, angle)
}

/** 兼容两种重心参数：数字（只给 y）/ `{x,y}`。 */
function normalizeCenterOffset(
  offset: number | { x?: number; y?: number }
): { x: number; y: number } {
  if (typeof offset === 'number') return { x: 0, y: offset }
  return { x: offset.x ?? 0, y: offset.y ?? 0 }
}

/**
 * 计算一条腿的髋关节模型空间位置（含 センター 的平移 + 旋转）。
 * 链条：センター（平移/旋转）→ 下半身（骨盆旋转）→ 腰キャンセル → 足D。
 */
export function hipPosition(
  rig: GroundingRig,
  leg: GroundingLeg,
  pelvisQuat: Quat,
  centerOffset: number | { x?: number; y?: number },
  centerQuat: Quat = { x: 0, y: 0, z: 0, w: 1 }
): Vec3 {
  const offset = normalizeCenterOffset(centerOffset)
  const centerOrigin = {
    x: rig.centerRest.x + offset.x,
    y: rig.centerRest.y + offset.y,
    z: rig.centerRest.z
  }
  const pelvisOrigin = {
    x: centerOrigin.x,
    y: centerOrigin.y,
    z: centerOrigin.z
  }
  const pelvisRelative = {
    x: rig.pelvisRest.x - rig.centerRest.x,
    y: rig.pelvisRest.y - rig.centerRest.y,
    z: rig.pelvisRest.z - rig.centerRest.z
  }
  const pelvisRotated = rotateVec3(centerQuat, pelvisRelative)
  pelvisOrigin.x += pelvisRotated.x
  pelvisOrigin.y += pelvisRotated.y
  pelvisOrigin.z += pelvisRotated.z

  const hipRelative = {
    x: leg.hipRest.x - rig.pelvisRest.x,
    y: leg.hipRest.y - rig.pelvisRest.y,
    z: leg.hipRest.z - rig.pelvisRest.z
  }
  const worldParent = normalizeQuat(multiplyQuat(centerQuat, pelvisQuat))
  const hipRotated = rotateVec3(worldParent, hipRelative)
  return {
    x: pelvisOrigin.x + hipRotated.x,
    y: pelvisOrigin.y + hipRotated.y,
    z: pelvisOrigin.z + hipRotated.z
  }
}

/**
 * 踝目标 = 身体坐标系里的踝 rest 位置 + 目标偏移，再随 センター 的 yaw 旋转到世界。
 * 这样「3/4 侧身」时双脚跟着身体转，腿不会被固定世界坐标拧到髋前/髋后。
 */
function targetAnkle(
  rig: GroundingRig,
  offset: GroundingFootOffset | undefined,
  outwardSign: number,
  centerQuat: Quat,
  centerXOffset: number
): { x: number; y: number; z: number; yawDeg: number; pitchDeg: number; spread: number } {
  const spread = (offset?.spread ?? 0) * outwardSign
  const leg = outwardSign > 0 ? rig.legs.left : rig.legs.right
  const relative = {
    x: leg.ankleRest.x - rig.centerRest.x,
    y: leg.ankleRest.y - rig.centerRest.y,
    z: leg.ankleRest.z - rig.centerRest.z
  }
  const rotated = rotateVec3(centerQuat, relative)
  const bodyOffset = rotateVec3(centerQuat, {
    x: spread,
    y: offset?.lift ?? 0,
    z: offset?.forward ?? 0
  })
  return {
    x: rig.centerRest.x + centerXOffset + rotated.x + bodyOffset.x,
    y: rig.centerRest.y + rotated.y + bodyOffset.y,
    z: rig.centerRest.z + rotated.z + bodyOffset.z,
    yawDeg: offset?.yawDeg ?? 0,
    pitchDeg: offset?.pitchDeg ?? 0,
    spread
  }
}

/**
 * 解算接地：髋高补偿 → 逐腿二骨 IK → 侧摆补偿 → 脚掌贴平；输出 D 链局部四元数与脚底误差。
 */
export function solveGrounding(input: GroundingInput): GroundingResult {
  const rig = input.rig
  const pelvisQuat = normalizeQuat(input.pelvisQuat)
  const centerQuat = normalizeQuat(input.centerQuat ?? { x: 0, y: 0, z: 0, w: 1 })
  const centerXOffset = input.centerXOffset ?? 0
  const bodyYawDeg = input.bodyYawDeg ?? 0
  const footYawBaseDeg = input.footYawBaseDeg ?? bodyYawDeg
  const worldParent = normalizeQuat(multiplyQuat(centerQuat, pelvisQuat))
  const worldParentInv = conjugateQuat(worldParent)
  const targets = {
    left: targetAnkle(rig, input.leftFoot, 1, centerQuat, centerXOffset),
    right: targetAnkle(rig, input.rightFoot, -1, centerQuat, centerXOffset)
  }

  let centerYOffset = input.centerYOffset - Math.max(0, input.crouchPulse ?? 0)
  const offsetOf = (y: number): { x: number; y: number } => ({ x: centerXOffset, y })

  const lateralFor = (
    hip: Vec3,
    target: { x: number; y: number; z: number },
    geometry: LegGeometry
  ): { angle: number; cos: number } => {
    const legLength = Math.max(0.2, geometry.thighLen + geometry.shinLen)
    const angle = Math.asin(clamp((target.x - hip.x) / legLength, -0.55, 0.55))
    return { angle, cos: Math.max(0.5, Math.cos(angle)) }
  }
  const sagittalDistance = (
    hip: Vec3,
    target: { x: number; y: number; z: number },
    geometry: LegGeometry
  ): number => {
    // 侧摆会把腿的竖向投影压到 cos(θ)：解算目标 y 要按 1/cos 放大。
    const { cos } = lateralFor(hip, target, geometry)
    const dy = (target.y - hip.y) / cos
    const dz = target.z - hip.z
    return Math.hypot(dy, dz)
  }

  // ① 压低：两条腿里「够不着」最严重的那条决定补偿量（含侧摆压缩）。
  let drop = 0
  for (const side of ['left', 'right'] as const) {
    const leg = rig.legs[side]
    const hip = hipPosition(rig, leg, pelvisQuat, offsetOf(centerYOffset), centerQuat)
    const target = targets[side]
    const distance = sagittalDistance(hip, target, leg.geometry)
    const maxReach = (leg.geometry.thighLen + leg.geometry.shinLen) * 0.995
    drop = Math.max(drop, distance - maxReach)
  }
  centerYOffset -= drop

  // ② 抬升：避免髋部低于踝目标太多导致膝盖反折（同样按侧摆压缩后的距离）。
  let lift = 0
  for (const side of ['left', 'right'] as const) {
    const leg = rig.legs[side]
    const hip = hipPosition(rig, leg, pelvisQuat, offsetOf(centerYOffset), centerQuat)
    const target = targets[side]
    const distance = sagittalDistance(hip, target, leg.geometry)
    lift = Math.max(lift, 1.4 - distance)
  }
  centerYOffset += lift

  const rotations = new Map<string, Quat>()
  const solutions: { left: LegIkSolution; right: LegIkSolution } = {
    left: solveLegSagittal(0, 0, 0, 0, rig.legs.left.geometry),
    right: solveLegSagittal(0, 0, 0, 0, rig.legs.right.geometry)
  }
  let footErrorModel = 0

  for (const side of ['left', 'right'] as const) {
    const leg = rig.legs[side]
    const hip = hipPosition(rig, leg, pelvisQuat, offsetOf(centerYOffset), centerQuat)
    const target = targets[side]
    // 侧摆：大腿绕 Z 旋 θz，把踝横向移到目标 x。绕 Z 会缩短竖向投影 → 先修正 y 目标，
    // 否则重心侧移会把脚「抬高」几像素（contrapposto 的贴地误差来源）。
    const { angle: lateralAngle, cos: cosLateral } = lateralFor(hip, target, leg.geometry)
    const ankleYAdjusted = hip.y + (target.y - hip.y) / cosLateral
    const solution = solveLegSagittal(hip.y, hip.z, ankleYAdjusted, target.z, leg.geometry)
    solutions[side] = solution

    const angles = solutionAngles(solution, leg.geometry)
    const reached = ankleFromAngles(hip.y, hip.z, angles.thighAngle, angles.shinAngle, leg.geometry)
    // 侧摆绕 Z 会把腿的竖向投影压到 cos(θ) → 实际踝 y 要乘回 cos，才是「脚底贴地误差」。
    const reachedYAfterLateral = hip.y + (reached.y - hip.y) * cosLateral
    footErrorModel = Math.max(footErrorModel, Math.abs(reachedYAfterLateral - target.y))

    const thighWorld = multiplyQuat(rotZ(lateralAngle), rotX(solution.thighPitch))
    const thighLocal = multiplyQuat(worldParentInv, thighWorld)
    const shinLocal = rotX(solution.kneePitch)
    // 脚掌世界朝向：保持水平 + 脚尖朝身体前方（外八），脚跟着地时叠俯仰。
    const yawWorld = footYawBaseDeg + target.yawDeg
    const footWorld = footWorldQuat(yawWorld, target.pitchDeg)
    const shinWorld = normalizeQuat(multiplyQuat(thighWorld, shinLocal))
    const footLocal = normalizeQuat(multiplyQuat(conjugateQuat(shinWorld), footWorld))

    const thighName = side === 'left' ? '左足D' : '右足D'
    const shinName = side === 'left' ? '左ひざD' : '右ひざD'
    const footName = side === 'left' ? '左足首D' : '右足首D'
    rotations.set(thighName, normalizeQuat(thighLocal))
    rotations.set(shinName, normalizeQuat(shinLocal))
    rotations.set(footName, footLocal)
  }

  return {
    centerYOffset,
    centerXOffset,
    footErrorPx: footErrorModel * Math.max(0, input.pxPerUnit),
    rotations,
    solutions,
    compensation: { drop, lift }
  }
}
