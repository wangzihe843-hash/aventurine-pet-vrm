/**
 * 四元数/向量纯数学工具（**不 import three**，Node 单测零依赖）。
 *
 * 约定（来自 `docs/anim-tech-survey.md` §2.3 实测）：
 * - 骨骼局部轴 = 模型世界轴（PMX 无 rest rotation，初始四元数恒等）；
 * - +x = 角色左、+y = 上、+z = 前（朝镜头/相机）；
 * - 转腿/低头用 x 轴、转身用 y 轴、抬臂/侧弯用 z 轴。
 *
 * 欧拉角合成顺序：**YXZ**（R = Ry · Rx · Rz；作者写「度」，此处转弧度）。
 */
import type { Euler3, Quat, Vec3 } from './types'

/** 恒等四元数。 */
export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 }

/** 零向量。 */
export const ZERO_VEC3: Vec3 = { x: 0, y: 0, z: 0 }

/** 构造四元数。 */
export function quat(x: number, y: number, z: number, w: number): Quat {
  return { x, y, z, w }
}

/** 拷贝（避免共享可变对象）。 */
export function cloneQuat(q: Quat): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w }
}

/** 克隆欧拉角。 */
export function cloneEuler(e: Euler3): Euler3 {
  return { x: e.x, y: e.y, z: e.z }
}

/** 度 → 弧度。 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 弧度 → 度。 */
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

/** 钳制到 [min, max]（NaN 归为 min）。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

/** 线性插值。 */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/**
 * smoothstep 缓动（3t²−2t³）：姿态过渡观感的关键，零成本且可单测。
 * 输入 t 先钳制到 [0,1]。
 */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** 四元数乘法 a·b（先应用 b 的旋转，再应用 a）。 */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  }
}

/** 归一化；模长过小时返回恒等（避免 NaN）。 */
export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(len > 1e-8)) return { x: 0, y: 0, z: 0, w: 1 }
  const inv = 1 / len
  return { x: q.x * inv, y: q.y * inv, z: q.z * inv, w: q.w * inv }
}

/** 共轭（单位四元数即逆）。 */
export function conjugateQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

/** 四元数点积（判断短弧/半球）。 */
export function dotQuat(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
}

/**
 * 球面线性插值（slerp），**始终走短弧**：dot<0 时取反 b（K12，避免手臂绕大圈）。
 * t 钳制到 [0,1]；a/b 不需要预先归一化。
 */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  const amount = clamp(t, 0, 1)
  const an = normalizeQuat(a)
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  const bn = normalizeQuat({ x: bx, y: by, z: bz, w: bw })
  bx = bn.x
  by = bn.y
  bz = bn.z
  bw = bn.w
  let cos = dotQuat(an, bn)
  if (cos < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    cos = -cos
  }
  if (cos > 0.9995) {
    // 近似线性插值 + 归一化（避免 sin 除法在极小角时除零）。
    const x = an.x + (bx - an.x) * amount
    const y = an.y + (by - an.y) * amount
    const z = an.z + (bz - an.z) * amount
    const w = an.w + (bw - an.w) * amount
    return normalizeQuat({ x, y, z, w })
  }
  const theta = Math.acos(clamp(cos, -1, 1)) * amount
  const sinTheta = Math.sin(theta)
  const sinTotal = Math.sin(Math.acos(clamp(cos, -1, 1)))
  const wa = Math.cos(theta) - (cos * sinTheta) / sinTotal
  const wb = sinTheta / sinTotal
  return normalizeQuat({
    x: an.x * wa + bx * wb,
    y: an.y * wa + by * wb,
    z: an.z * wa + bz * wb,
    w: an.w * wa + bw * wb
  })
}

/** 绕单轴构造四元数（弧度为角度单位）。 */
export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const half = angleRad / 2
  const s = Math.sin(half)
  return normalizeQuat({ x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) })
}

/**
 * 欧拉角（YXZ 顺序，**弧度**）→ 四元数。
 * 用 qY·qX·qZ 显式合成，可读性/可测性都优于展开式；姿态表只在启动/改姿态时调用，不在热路径。
 */
export function eulerToQuat(e: Euler3): Quat {
  const qx = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, e.x)
  const qy = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, e.y)
  const qz = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, e.z)
  return normalizeQuat(multiplyQuat(multiplyQuat(qy, qx), qz))
}

/** 欧拉角（**度**，分量可省略）→ 四元数。 */
export function eulerDegToQuat(e: { x?: number; y?: number; z?: number }): Quat {
  return eulerToQuat({
    x: degToRad(e.x ?? 0),
    y: degToRad(e.y ?? 0),
    z: degToRad(e.z ?? 0)
  })
}

/** 用四元数旋转向量（q·v·q⁻¹）。 */
export function rotateVec3(q: Quat, v: Vec3): Vec3 {
  const qn = normalizeQuat(q)
  const ux = qn.x
  const uy = qn.y
  const uz = qn.z
  const uw = qn.w
  const vx = v.x
  const vy = v.y
  const vz = v.z
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (uy * vz - uz * vy)
  const ty = 2 * (uz * vx - ux * vz)
  const tz = 2 * (ux * vy - uy * vx)
  return {
    x: vx + uw * tx + (uy * tz - uz * ty),
    y: vy + uw * ty + (uz * tx - ux * tz),
    z: vz + uw * tz + (ux * ty - uy * tx)
  }
}

/** 向量加。 */
export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

/** 向量减。 */
export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

/** 向量缩放。 */
export function scaleVec3(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}

/** 向量点积。 */
export function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** 向量叉积。 */
export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  }
}

/** 向量长度。 */
export function lengthVec3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z)
}

/** 归一化向量；零向量返回 (0,0,0)。 */
export function normalizeVec3(v: Vec3): Vec3 {
  const len = lengthVec3(v)
  if (!(len > 1e-8)) return { x: 0, y: 0, z: 0 }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** 两个单位向量之间的最短弧四元数（用于弹簧把 rest 方向转到目标方向）。 */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const fr = normalizeVec3(from)
  const tr = normalizeVec3(to)
  const d = clamp(dotVec3(fr, tr), -1, 1)
  if (d > 0.999999) return { x: 0, y: 0, z: 0, w: 1 }
  if (d < -0.999999) {
    // 反向：任取一个正交轴旋转 180°。
    let axis = crossVec3(fr, { x: 1, y: 0, z: 0 })
    if (lengthVec3(axis) < 1e-6) axis = crossVec3(fr, { x: 0, y: 1, z: 0 })
    return quatFromAxisAngle(normalizeVec3(axis), Math.PI)
  }
  const c = crossVec3(fr, tr)
  return normalizeQuat({ x: c.x, y: c.y, z: c.z, w: 1 + d })
}

/** 四元数 → 旋转向量（轴 × 角，弧度；log map，用于弹簧刚度回拉）。 */
export function quatToRotationVector(q: Quat): Vec3 {
  const qn = normalizeQuat(q)
  // 统一到 w ≥ 0 的半球（最短旋转）。
  const sign = qn.w < 0 ? -1 : 1
  const x = qn.x * sign
  const y = qn.y * sign
  const z = qn.z * sign
  const w = qn.w * sign
  const sinHalf = Math.hypot(x, y, z)
  if (sinHalf < 1e-9) return { x: 2 * x, y: 2 * y, z: 2 * z }
  const angle = 2 * Math.atan2(sinHalf, w)
  const scale = angle / sinHalf
  return { x: x * scale, y: y * scale, z: z * scale }
}

/** 旋转向量 → 四元数（exp map；用于弹簧角速度积分）。 */
export function rotationVectorToQuat(rv: Vec3): Quat {
  const angle = lengthVec3(rv)
  if (angle < 1e-9) {
    return normalizeQuat({ x: rv.x / 2, y: rv.y / 2, z: rv.z / 2, w: 1 })
  }
  const half = angle / 2
  const s = Math.sin(half) / angle
  return { x: rv.x * s, y: rv.y * s, z: rv.z * s, w: Math.cos(half) }
}

/**
 * 指数平滑（一阶低通）：`prev + (next−prev) * (1 − e^(−dt/τ))`。
 * 用于注视（τ=90ms）与层权重过渡；与帧率无关，可单测收敛性。
 */
export function damp(prev: number, next: number, dt: number, tau: number): number {
  if (!(tau > 1e-6)) return next
  const alpha = 1 - Math.exp(-Math.max(0, dt) / tau)
  return prev + (next - prev) * alpha
}

/** 对 `GazeTarget` 做指数平滑。 */
export function dampGaze(
  prev: { yaw: number; pitch: number },
  next: { yaw: number; pitch: number },
  dt: number,
  tau = 0.09
): { yaw: number; pitch: number } {
  return {
    yaw: damp(prev.yaw, next.yaw, dt, tau),
    pitch: damp(prev.pitch, next.pitch, dt, tau)
  }
}
