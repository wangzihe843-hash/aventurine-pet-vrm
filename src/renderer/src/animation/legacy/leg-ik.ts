/**
 * 解析二骨 IK（矢状面）+ 髋高补偿 + 脚掌贴平（**纯函数**，不 import three）。
 *
 * 背景（`docs/anim-tech-survey.md` §2.7.2）：
 * - 模型腿的可见网格权重全在 D 链（`足D/ひざD/足首D`），所以直接解 FK 角度写 D 链；
 * - 矢状面近似：髋→踝目标在 (y,z) 平面内解（x 忽略；站/走时 x 偏移 < 1px，验收只看 y 方向贴地误差）；
 * - 角度约定与实测轴符号一致：方向角 θ 的段方向 = (−cosθ, −sinθ)（y 向下为负、z 向前为正），
 *   **θ 增大 = 腿向后摆**（survey §2.3：腿前摆 = 绕 X 负角）；
 * - rest 姿态本身不竖直（大腿近乎 −Y，小腿略向后 −Z），所以解算先算 rest 方向角，
 *   返回的是**相对 rest 的附加角**，rest 姿态（0,0）恰好落在 bind pose 踝点 → 单测可锁死。
 *
 * 本模块只做数学；hip/踝坐标来源、膝朝向、脚掌软系数在 `grounding.ts` 组装。
 */
import { clamp } from './quat'
import type { Quat, Vec3 } from './types'

/** 一条腿的几何常量（由骨架 rest 位置推出；模型单位）。 */
export interface LegGeometry {
  /** 大腿在矢状面的长度（hypot(Δy, Δz)）。 */
  thighLen: number
  /** 小腿在矢状面的长度。 */
  shinLen: number
  /** 大腿 rest 方向角（弧度；方向 (−cosθ, −sinθ)）。 */
  restThighAngle: number
  /** 小腿 rest 方向角（弧度）。 */
  restShinAngle: number
  /** 髋关节 rest 位置（模型空间，y 向上）。 */
  hipRest: Vec3
  /** 踝关节 rest 位置（模型空间）。 */
  ankleRest: Vec3
}

/** 二骨 IK 解算结果（角度均为「相对 rest 的附加旋转」，弧度）。 */
export interface LegIkSolution {
  /** 大腿附加俯仰（绕 X；写 `足D` 的局部增量）。 */
  thighPitch: number
  /** 膝附加屈曲（绕 X；写 `ひざD` 的局部增量）。 */
  kneePitch: number
  /** 脚掌保持水平的踝附加俯仰（`足首D` 局部；已含软系数在 grounding 里乘）。 */
  footPitch: number
  /** 目标距离（矢状面）。 */
  distance: number
  /** 目标是否可达（不可达时角度已钳制到腿长上限）。 */
  reachable: boolean
}

/** 段方向：θ 方向的单位向量在 (y,z) 平面的分量。 */
function segmentDirection(angle: number): { y: number; z: number } {
  return { y: -Math.cos(angle), z: -Math.sin(angle) }
}

/**
 * 由 rest 关节位置推导一条腿的矢状面几何（纯函数；单测可直接喂真实 rest 数据）。
 * 顺序：hip（足D）→ knee（ひざD）→ ankle（足首D）。
 */
export function createLegGeometry(hipRest: Vec3, kneeRest: Vec3, ankleRest: Vec3): LegGeometry {
  const thighY = kneeRest.y - hipRest.y
  const thighZ = kneeRest.z - hipRest.z
  const shinY = ankleRest.y - kneeRest.y
  const shinZ = ankleRest.z - kneeRest.z
  return {
    thighLen: Math.hypot(thighY, thighZ),
    shinLen: Math.hypot(shinY, shinZ),
    restThighAngle: Math.atan2(-thighZ, -thighY),
    restShinAngle: Math.atan2(-shinZ, -shinY),
    hipRest: { ...hipRest },
    ankleRest: { ...ankleRest }
  }
}

/**
 * 矢状面二骨 IK：给定髋位置与踝目标（模型空间 y/z），求相对 rest 的大腿/膝附加角。
 *
 * 推导（膝朝前 = 膝关节在髋→踝连线前方）：
 * - α = 髋→踝连线方向角；β = 余弦定理的髋角；β2 = 踝角；
 * - 大腿角 = α − β，小腿角 = α + β2，膝屈曲 φ = β + β2；
 * - 返回 thighPitch = (α−β) − restThighAngle，kneePitch = φ − (restShinAngle − restThighAngle)。
 */
export function solveLegSagittal(
  hipY: number,
  hipZ: number,
  ankleY: number,
  ankleZ: number,
  geometry: LegGeometry
): LegIkSolution {
  const { thighLen, shinLen } = geometry
  const dy = ankleY - hipY
  const dz = ankleZ - hipZ
  const rawDistance = Math.hypot(dy, dz)
  const maxReach = Math.max(1e-6, thighLen + shinLen - 1e-4)
  const minReach = Math.max(1e-6, Math.abs(thighLen - shinLen) + 1e-4)
  const distance = clamp(rawDistance, minReach, maxReach)
  const reachable = Math.abs(distance - rawDistance) < 1e-6

  // 方向角：段方向 (−cosθ, −sinθ) 与 (dy,dz)/distance 对齐。
  const alpha = Math.atan2(-dz / Math.max(1e-9, distance), -dy / Math.max(1e-9, distance))
  const cosBeta = clamp(
    (thighLen * thighLen + distance * distance - shinLen * shinLen) /
      (2 * thighLen * distance),
    -1,
    1
  )
  const cosBeta2 = clamp(
    (shinLen * shinLen + distance * distance - thighLen * thighLen) /
      (2 * shinLen * distance),
    -1,
    1
  )
  const beta = Math.acos(cosBeta)
  const beta2 = Math.acos(cosBeta2)
  const flexion = beta + beta2
  const thighAngle = alpha - beta
  const shinAngle = alpha + beta2 // = thighAngle + flexion

  return {
    thighPitch: thighAngle - geometry.restThighAngle,
    kneePitch: flexion - (geometry.restShinAngle - geometry.restThighAngle),
    footPitch: shinAngle,
    distance,
    reachable
  }
}

/** 解算结果对应的大腿/小腿世界方向角（调试/单测用）。 */
export function solutionAngles(
  solution: LegIkSolution,
  geometry: LegGeometry
): { thighAngle: number; shinAngle: number } {
  return {
    thighAngle: geometry.restThighAngle + solution.thighPitch,
    shinAngle: geometry.restShinAngle + solution.thighPitch + solution.kneePitch
  }
}

/** 由解算角度回推踝位置（FK；单测验证「解出的角度使 |hip−ankle| ≈ 目标距离」）。 */
export function ankleFromAngles(
  hipY: number,
  hipZ: number,
  thighAngle: number,
  shinAngle: number,
  geometry: LegGeometry
): { y: number; z: number } {
  const thigh = segmentDirection(thighAngle)
  const shin = segmentDirection(shinAngle)
  return {
    y: hipY + thigh.y * geometry.thighLen + shin.y * geometry.shinLen,
    z: hipZ + thigh.z * geometry.thighLen + shin.z * geometry.shinLen
  }
}

/**
 * 髋高补偿：目标距离超过腿长时，把重心向下压 `distance − maxReach`。
 * 返回需要额外下沉的模型单位（≥ 0）。
 */
export function computeHipDropForReach(
  hipY: number,
  hipZ: number,
  ankleY: number,
  ankleZ: number,
  geometry: LegGeometry,
  softLimit = 0.995
): number {
  const distance = Math.hypot(ankleY - hipY, ankleZ - hipZ)
  const maxReach = (geometry.thighLen + geometry.shinLen) * softLimit
  return Math.max(0, distance - maxReach)
}

/** 目标过近时需要的抬升量（避免膝盖「反折」/退化；返回 ≥ 0）。 */
export function computeHipLiftForMinReach(
  hipY: number,
  hipZ: number,
  ankleY: number,
  ankleZ: number,
  minDistance = 1.4
): number {
  const distance = Math.hypot(ankleY - hipY, ankleZ - hipZ)
  return Math.max(0, minDistance - distance)
}

/**
 * 目标脚在世界空间的朝向：先绕 X 俯仰（脚跟着地/脚尖蹬离），再绕 Y 外八 yaw。
 * 返回脚骨**世界**四元数（相对 rest 的附加旋转）；pitch=yaw=0 时 = 恒等（鞋底贴平）。
 */
export function footWorldQuat(yawDeg: number, pitchDeg = 0): Quat {
  const pitch = (pitchDeg * Math.PI) / 180
  const yaw = (yawDeg * Math.PI) / 180
  const sx = Math.sin(pitch / 2)
  const cx = Math.cos(pitch / 2)
  const sy = Math.sin(yaw / 2)
  const cy = Math.cos(yaw / 2)
  // q = qx * qy：先 yaw、再在模型前向平面内 pitch（pitch=0 → 纯 yaw）
  return { x: sx * cy, y: cx * sy, z: sx * sy, w: cx * cy }
}

