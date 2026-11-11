/**
 * 比例感知肩/臂重定向（源视觉姿态保持）——纯 ESM 数学库
 *
 * 背景（`docs/research/mate-female-to-male-joint-plan-2026-11-11.md` §2.2/§4.2/§4.3）：
 * 源 Zome 女体的锁骨只有 6.16cm，目标男体 12.34cm；同一段 clip 的锁骨旋转在男体上
 * 造成约 2× 的肩点（upperArm 关节点）位移。本库把「源 clip 在源几何上的视觉姿态」
 * 逐帧映射到目标 torso 坐标，再只改手臂链（Shoulder/UpperArm/LowerArm）把目标肩点/
 * 手腕拉回按身体比例缩放后的位置：
 *
 *  1. 源侧用 canonical 源 rest + 归一化旋转做 FK（不经过 three-vrm 的 VRM0 场景旋转，
 *     见脚本注释：那会把不对称 clip 镜像；本库的源姿态是 Unity GT 意义上的源姿态）；
 *  2. 关节位置表达在源 torso 系（hips 原点、hips→head 为上轴、双肩连线为横轴），
 *     除以源 rest torso 长（hips→head）；
 *  3. 目标期望关节位置 = 目标 torso 系 × (源归一化位置 × 目标 rest torso 长)；
 *     肩窝可选 absolute 或 displacement 模式（见 `socketMode`）；
 *  4. 锁骨：swing 到期望肩窝方向（长度固定，不可达/超长时方向最优，可选角度上限）；
 *  5. 上臂/前臂：两骨 IK 到期望手腕（98% reach clamp、肘屈 [10°,150°]、pole 取源肘）；
 *  6. 上臂/前臂 world 旋转 = 「源方向 → 目标方向」的 swing × 源 world 旋转，保留源
 *     twist；Hand/手指 normalized 旋转原样保留（手部世界朝向只随前臂 swing 变化）。
 *
 * 纯逻辑：不 import three / DOM / node:* / Electron。四元数约定 `[x,y,z,w]`（Hamilton，
 * `a·b` = 先 b 后 a；与 three.js `a.multiply(b)` 一致）。
 */

/* -------------------------------------------------------------------------- */
/* 骨骼链 / 常量                                                               */
/* -------------------------------------------------------------------------- */

/** 22 核心 humanoid 骨（Unity HumanBodyBones 命名，与 clip JSON 的 `bones` 键一致）。 */
export const CORE_BONES = Object.freeze([
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'
])

/** 本库会改写的骨骼（每侧 3 根；Hand 及手指保留）。 */
export const RETARGETED_BONES = Object.freeze([
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm'
])

/** 手臂链 + 源姿态映射需要的骨（不含腿/脚）。 */
export const ARM_TORSO_BONES = Object.freeze([
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand'
])

const SIDES = Object.freeze(['Left', 'Right'])
const IDENTITY_QUAT = Object.freeze([0, 0, 0, 1])
const EPS = 1e-9

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

/** 默认父母映射（含 UpperChest；目标/源缺该骨时由 `effectiveParents()` 折叠到 Chest）。 */
export const BONE_PARENT = Object.freeze({
  Hips: null,
  Spine: 'Hips',
  Chest: 'Spine',
  UpperChest: 'Chest',
  Neck: 'UpperChest',
  Head: 'Neck',
  LeftShoulder: 'UpperChest',
  LeftUpperArm: 'LeftShoulder',
  LeftLowerArm: 'LeftUpperArm',
  LeftHand: 'LeftLowerArm',
  RightShoulder: 'UpperChest',
  RightUpperArm: 'RightShoulder',
  RightLowerArm: 'RightUpperArm',
  RightHand: 'RightLowerArm',
  LeftUpperLeg: 'Hips',
  LeftLowerLeg: 'LeftUpperLeg',
  LeftFoot: 'LeftLowerLeg',
  LeftToes: 'LeftFoot',
  RightUpperLeg: 'Hips',
  RightLowerLeg: 'RightUpperLeg',
  RightFoot: 'RightLowerLeg',
  RightToes: 'RightFoot'
})

/* -------------------------------------------------------------------------- */
/* 向量                                                                        */
/* -------------------------------------------------------------------------- */

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {[number, number, number, number]} Quat4 */

/** @param {number[]} a @param {number[]} b @returns {Vec3} */
export function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
/** @param {number[]} a @param {number[]} b @returns {Vec3} */
export function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
/** @param {number[]} a @param {number} s @returns {Vec3} */
export function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s] }
/** @param {number[]} a @param {number[]} b @returns {number} */
export function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
/** @param {number[]} a @param {number[]} b @returns {Vec3} */
export function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
/** @param {number[]} a @returns {number} */
export function vLen(a) { return Math.hypot(a[0], a[1], a[2]) }
/** @param {number[]} a @returns {Vec3} */
export function vNorm(a) {
  const l = vLen(a)
  return l < EPS ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
/** @param {number[]} a @param {number[]} b @returns {number} */
export function vDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) }
/**
 * 以 `axis` 为轴去掉 `v` 的平行分量（返回垂直分量）。
 * @param {number[]} v @param {number[]} axis 单位向量 @returns {Vec3}
 */
export function vReject(v, axis) { return vSub(v, vScale(axis, vDot(v, axis))) }

/* -------------------------------------------------------------------------- */
/* 四元数                                                                      */
/* -------------------------------------------------------------------------- */

/** @returns {Quat4} */
export function quatIdentity() { return [0, 0, 0, 1] }

/** @param {number[]} q @returns {Quat4} */
export function quatNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3])
  return l < EPS ? [0, 0, 0, 1] : [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

/** Hamilton 乘法 a·b（先 b 后 a）。 @param {number[]} a @param {number[]} b @returns {Quat4} */
export function quatMultiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

/** 共轭（单位四元数即逆）。 @param {number[]} q @returns {Quat4} */
export function quatConjugate(q) { return [-q[0], -q[1], -q[2], q[3]] }

/** 单位四元数逆（非单位输入先归一化）。 @param {number[]} q @returns {Quat4} */
export function quatInvert(q) { return quatConjugate(quatNormalize(q)) }

/** 用四元数旋转向量。 @param {number[]} q @param {number[]} v @returns {Vec3} */
export function quatRotateVec(q, v) {
  const [x, y, z, w] = q
  const [vx, vy, vz] = v
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx)
  ]
}

/** 旋转角（弧度，[0,π]；q/-q 等价）。 @param {number[]} q @returns {number} */
export function quatAngleRad(q) {
  const n = quatNormalize(q)
  return 2 * Math.acos(Math.min(1, Math.abs(n[3])))
}

/** 旋转角（度）。 @param {number[]} q @returns {number} */
export function quatAngleDeg(q) { return quatAngleRad(q) * RAD2DEG }

/** 两个世界旋转的夹角（度，q/-q 等价）。 @param {number[]} a @param {number[]} b @returns {number} */
export function quatDeltaDeg(a, b) {
  return quatAngleDeg(quatMultiply(quatInvert(a), b))
}

/** 轴角 → 四元数。 @param {number[]} axis @param {number} deg @returns {Quat4} */
export function quatFromAxisAngleDeg(axis, deg) {
  const n = vNorm(axis)
  if (vLen(n) < 0.5) return [0, 0, 0, 1]
  const half = (deg * DEG2RAD) / 2
  const s = Math.sin(half)
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(half)]
}

/**
 * 最短弧旋转：把单位向量 `from` 转到 `to`。
 * 平行 → identity；反平行 → 选一个正交轴转 180°（确定性，避免 NaN）。
 * @param {number[]} from @param {number[]} to @returns {Quat4}
 */
export function quatFromUnitVectors(from, to) {
  const f = vNorm(from)
  const t = vNorm(to)
  if (vLen(f) < 0.5 || vLen(t) < 0.5) return [0, 0, 0, 1]
  const d = vDot(f, t)
  if (d > 1 - 1e-12) return [0, 0, 0, 1]
  if (d < -1 + 1e-12) {
    // 选与 f 最不平行的坐标轴构造正交轴
    const helper = Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const axis = vNorm(vCross(f, helper))
    return [axis[0], axis[1], axis[2], 0]
  }
  const c = vCross(f, t)
  return quatNormalize([c[0], c[1], c[2], 1 + d])
}

/** 球面插值（最短路径）。 @param {number[]} a @param {number[]} b @param {number} t @returns {Quat4} */
export function quatSlerp(a, b, t) {
  const aa = quatNormalize(a)
  let bb = quatNormalize(b)
  let d = aa[0] * bb[0] + aa[1] * bb[1] + aa[2] * bb[2] + aa[3] * bb[3]
  if (d < 0) { d = -d; bb = [-bb[0], -bb[1], -bb[2], -bb[3]] }
  if (d > 0.9995) {
    return quatNormalize(aa.map((v, i) => v + (bb[i] - v) * t))
  }
  const theta0 = Math.acos(Math.min(1, d))
  const theta = theta0 * t
  const s0 = Math.sin(theta0)
  const sA = Math.sin(theta0 - theta) / s0
  const sB = Math.sin(theta) / s0
  return quatNormalize(aa.map((v, i) => v * sA + bb[i] * sB))
}

/**
 * 把四元数限制在 identity 附近 `maxDeg` 以内（轴不变，角度 slerp 压小）。
 * @param {number[]} q @param {number} maxDeg @returns {{quat:Quat4, capped:boolean, angleDeg:number}}
 */
export function capQuatAngleFromIdentity(q, maxDeg) {
  const angle = quatAngleDeg(q)
  if (!Number.isFinite(maxDeg) || maxDeg <= 0 || angle <= maxDeg + 1e-9) {
    return { quat: quatNormalize(q), capped: false, angleDeg: angle }
  }
  return { quat: quatSlerp(IDENTITY_QUAT, q, maxDeg / angle), capped: true, angleDeg: maxDeg }
}

/* -------------------------------------------------------------------------- */
/* 骨架 / FK                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 构造有效父母映射：骨架没有 UpperChest 时，把 Neck/左右 Shoulder 挂到 Chest。
 * @param {Record<string, number[]>} rest
 * @returns {Record<string, string|null>}
 */
export function effectiveParents(rest) {
  const hasUpperChest = Array.isArray(rest?.UpperChest)
  const parents = { ...BONE_PARENT }
  if (!hasUpperChest) {
    parents.Neck = 'Chest'
    parents.LeftShoulder = 'Chest'
    parents.RightShoulder = 'Chest'
  }
  return parents
}

/**
 * 取一帧 normalized 旋转（缺省 identity；非有限回退 identity）。
 * @param {Record<string, number[]>} rotations
 * @param {string} bone
 * @returns {Quat4}
 */
function frameQuat(rotations, bone) {
  const q = rotations?.[bone]
  if (!Array.isArray(q) || q.length !== 4) return [0, 0, 0, 1]
  return quatNormalize(q)
}

/**
 * 对一帧做 FK：`D_b = D_parent · q_b`，`p_b = p_parent + D_parent · (rest_b - rest_parent)`。
 *
 * 缺 UpperChest 时按 α=1 折叠：`q_chest' = q_chest · U`（子骨 world 朝向精确不变）。
 * 输入/输出不修改入参。
 *
 * @param {Record<string, number[]>} rest 骨名 → rest 世界位置（米）
 * @param {Record<string, number[]>} rotations 骨名 → normalized 旋转（相对 rest）
 * @param {object} [options]
 * @param {boolean} [options.foldUpperChest=true] 目标/源缺 upperChest 时是否折叠
 * @param {Record<string, string|null>} [options.parents]
 * @returns {{positions: Record<string, Vec3>, deltas: Record<string, Quat4>, rotations: Record<string,Quat4>, hasUpperChest:boolean}}
 */
export function forwardKinematics(rest, rotations, options = {}) {
  if (!rest || typeof rest !== 'object') throw new Error('rest 必须是骨名 → 位置的对象')
  const parents = options.parents ?? effectiveParents(rest)
  const hasUpperChest = Array.isArray(rest.UpperChest)
  const fold = options.foldUpperChest !== false
  const effective = {}
  for (const bone of ARM_TORSO_BONES) {
    effective[bone] = frameQuat(rotations, bone)
  }
  if (!hasUpperChest && fold) {
    // q_chest' = q_chest · U（右乘）；UpperChest 本身不再作为节点参与 FK
    effective.Chest = quatMultiply(effective.Chest, effective.UpperChest)
  }

  const positions = {}
  const deltas = {}
  const order = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
    'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
    'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand']
  for (const bone of order) {
    if (!Array.isArray(rest[bone])) continue
    if (bone === 'UpperChest' && !hasUpperChest) continue
    const parent = parents[bone] ?? null
    const parentDelta = parent && deltas[parent] ? deltas[parent] : IDENTITY_QUAT
    const delta = quatNormalize(quatMultiply(parentDelta, effective[bone]))
    deltas[bone] = delta
    if (!parent || !Array.isArray(rest[parent]) || !positions[parent]) {
      positions[bone] = [rest[bone][0], rest[bone][1], rest[bone][2]]
    } else {
      const offset = vSub(rest[bone], rest[parent])
      positions[bone] = vAdd(positions[parent], quatRotateVec(parentDelta, offset))
    }
  }
  return { positions, deltas, rotations: effective, hasUpperChest }
}

/**
 * 由 hips / head / 双肩根构造 torso 正交系。
 * 列向量为 [left, up, forward]（right-handed，forward = left × up）。
 * 双肩线退化时回退到 upperArm 连线；再退化回退到世界轴。
 *
 * @param {{positions: Record<string, Vec3>}} pose
 * @returns {{origin: Vec3, left: Vec3, up: Vec3, forward: Vec3, basis: [Vec3,Vec3,Vec3], valid: boolean}}
 */
export function computeTorsoFrame(pose) {
  const p = pose.positions
  const hips = p.Hips
  const head = p.Head
  const up = vNorm(vSub(head, hips))
  let left = [1, 0, 0]
  let valid = false
  for (const [a, b] of [['LeftShoulder', 'RightShoulder'], ['LeftUpperArm', 'RightUpperArm']]) {
    if (!p[a] || !p[b]) continue
    const raw = vSub(p[a], p[b])
    const proj = vReject(raw, up)
    if (vLen(proj) > 1e-6) {
      left = vNorm(proj)
      valid = true
      break
    }
  }
  if (!valid) {
    // 双肩线退化（极端姿势/缺失骨）：取与 up 最不平行的世界轴
    const helper = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
    left = vNorm(vReject(helper, up))
  }
  let forward = vCross(left, up)
  if (vLen(forward) < 1e-6) {
    // up 与 left 平行（异常）：构造任意正交
    forward = vNorm(vCross(up, [0, 0, 1]))
    if (vLen(forward) < 1e-6) forward = [0, 0, 1]
  } else {
    forward = vNorm(forward)
  }
  // 重新正交化 left，消除数值误差
  const left2 = vNorm(vCross(up, forward))
  return { origin: hips, left: left2, up, forward, basis: [left2, up, forward], valid }
}

/** 世界点 → torso 系坐标（米）。 @param {ReturnType<typeof computeTorsoFrame>} frame @param {number[]} point */
export function frameLocal(frame, point) {
  const d = vSub(point, frame.origin)
  return [vDot(d, frame.left), vDot(d, frame.up), vDot(d, frame.forward)]
}

/** torso 系坐标（米）→ 世界点。 @param {ReturnType<typeof computeTorsoFrame>} frame @param {number[]} local */
export function frameWorld(frame, local) {
  return vAdd(frame.origin, vAdd(vScale(frame.left, local[0]), vAdd(vScale(frame.up, local[1]), vScale(frame.forward, local[2]))))
}

/**
 * 由源/目标 rest 推导比例参数。
 * @param {Record<string, number[]>} sourceRest
 * @param {Record<string, number[]>} targetRest
 */
export function deriveProportions(sourceRest, targetRest) {
  const sourceTorso = vDist(sourceRest.Head, sourceRest.Hips)
  const targetTorso = vDist(targetRest.Head, targetRest.Hips)
  const sourceFrame = computeTorsoFrame({ positions: sourceRest })
  const targetFrame = computeTorsoFrame({ positions: targetRest })
  const halfWidth = (rest, frame) => {
    const l = frameLocal(frame, rest.LeftUpperArm)
    return Math.abs(l[0])
  }
  const clavicle = (rest) => vDist(rest.LeftUpperArm, rest.LeftShoulder)
  const arm = (rest) => vDist(rest.LeftUpperArm, rest.LeftLowerArm) + vDist(rest.LeftLowerArm, rest.LeftHand)
  const value = (v) => (Number.isFinite(v) ? v : null)
  return {
    sourceTorsoLengthM: sourceTorso,
    targetTorsoLengthM: targetTorso,
    /** 目标归一化位置比例 = targetTorso / sourceTorso */
    torsoScale: sourceTorso > EPS ? targetTorso / sourceTorso : 1,
    sourceClavicleLengthM: clavicle(sourceRest),
    targetClavicleLengthM: clavicle(targetRest),
    clavicleScale: clavicle(sourceRest) > EPS ? clavicle(targetRest) / clavicle(sourceRest) : null,
    sourceArmLengthM: arm(sourceRest),
    targetArmLengthM: arm(targetRest),
    armScale: arm(sourceRest) > EPS ? arm(targetRest) / arm(sourceRest) : null,
    sourceShoulderHalfWidthM: halfWidth(sourceRest, sourceFrame),
    targetShoulderHalfWidthM: halfWidth(targetRest, targetFrame),
    shoulderWidthScale: halfWidth(sourceRest, sourceFrame) > EPS
      ? halfWidth(targetRest, targetFrame) / halfWidth(sourceRest, sourceFrame)
      : null,
    sourceHipsToHead: value(sourceTorso),
    targetHipsToHead: value(targetTorso)
  }
}

/* -------------------------------------------------------------------------- */
/* 两骨 IK                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 两骨 IK：root → elbow → wrist。长度固定，目标距离 clamp 到 [dMin, 0.98*(l1+l2)]，
 * 肘屈限制 [minElbowFlexDeg, maxElbowFlexDeg]；pole 方向取 `polePoint-root` 在
 * 「root→target」法平面上的投影（源肘位置）。
 *
 * @param {object} p
 * @param {number[]} p.root
 * @param {number[]} p.target 期望 wrist
 * @param {number[]} [p.polePoint] 源肘（世界）位置，用于确定弯曲平面
 * @param {number[]} [p.fallbackUp] pole 退化时的参考上方向
 * @param {number} p.l1 上臂长
 * @param {number} p.l2 前臂长
 * @param {number} [p.reachRatio=0.98]
 * @param {number} [p.minElbowFlexDeg=10]
 * @param {number} [p.maxElbowFlexDeg=150]
 * @returns {{elbow:Vec3, wrist:Vec3, distance:number, desiredDistance:number, clamped:boolean, flexDeg:number}}
 */
export function solveTwoBoneIK(p) {
  const l1 = Math.max(0, p.l1)
  const l2 = Math.max(0, p.l2)
  const reachRatio = Number.isFinite(p.reachRatio) ? Math.min(1, Math.max(0.5, p.reachRatio)) : 0.98
  const minFlex = Number.isFinite(p.minElbowFlexDeg) ? p.minElbowFlexDeg : 10
  const maxFlex = Number.isFinite(p.maxElbowFlexDeg) ? p.maxElbowFlexDeg : 150
  const toTarget = vSub(p.target, p.root)
  const desired = vLen(toTarget)
  const axis0 = desired > EPS ? vScale(toTarget, 1 / desired) : vNorm(p.fallbackUp ?? [0, 1, 0])
  const flexToDistance = (deg) => Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(deg * DEG2RAD)))
  const dFromMinFlex = flexToDistance(minFlex) // 直臂端（10° 屈）
  const dFromMaxFlex = flexToDistance(maxFlex) // 深屈端（150° 屈）
  const fullReach = l1 + l2
  // 可达（≤ fullReach）时用精确目标（仅受 minFlex 限制）；只有真正不可达才退到 reachRatio 的
  // 软上限（任务要求 98%），避免「可达但接近伸直」也被无谓缩短。
  const dMax = desired > fullReach + 1e-9
    ? Math.min(dFromMinFlex, reachRatio * fullReach)
    : dFromMinFlex
  const dMin = Math.max(Math.abs(l1 - l2) * 1.001, dFromMaxFlex)
  const d = Math.min(dMax, Math.max(dMin, desired))
  const axis = desired > EPS ? axis0 : vNorm(p.fallbackUp ?? [0, 1, 0])
  const wrist = vAdd(p.root, vScale(axis, d))
  const a = d > EPS ? (l1 * l1 - l2 * l2 + d * d) / (2 * d) : 0
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  // pole：源肘方向去掉轴向分量
  let pole = p.polePoint ? vSub(p.polePoint, p.root) : [0, 0, 0]
  let perp = vReject(pole, axis)
  if (vLen(perp) < 1e-6) {
    const up = p.fallbackUp ?? [0, 1, 0]
    perp = vReject(up, axis)
    if (vLen(perp) < 1e-6) perp = vReject([0, 0, 1], axis)
    if (vLen(perp) < 1e-6) perp = vReject([1, 0, 0], axis)
  }
  perp = vNorm(perp)
  const elbow = vAdd(vAdd(p.root, vScale(axis, a)), vScale(perp, h))
  const upperDir = vNorm(vSub(elbow, p.root))
  const foreDir = vNorm(vSub(wrist, elbow))
  const flexDeg = Math.acos(Math.min(1, Math.max(-1, vDot(upperDir, foreDir)))) * RAD2DEG
  return { elbow, wrist, distance: d, desiredDistance: desired, clamped: Math.abs(d - desired) > 1e-6, flexDeg }
}

/* -------------------------------------------------------------------------- */
/* 单帧重定向                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 把源 clip 一帧重定向到目标（只算手臂链；Hand 旋转保持 clip 原值）。
 *
 * @param {object} input
 * @param {Record<string, number[]>} input.sourceRest canonical 源 rest 位置（米）
 * @param {Record<string, number[]>} input.targetRest 目标 rest 位置（米）
 * @param {Record<string, number[]>} input.rotations 本帧 normalized 旋转（Unity 骨名；可含 UpperChest）
 * @param {object} [input.options]
 * @param {'absolute'|'chest-displacement'|'displacement'} [input.options.socketMode='absolute']
 *   - absolute：目标期望肩窝 = 源肩窝按 torso 长归一化后的绝对位置（任务 §3 口径）；
 *   - chest-displacement（推荐）：目标期望肩窝 = 目标 rest 肩窝 + 目标 chest 系里
 *     (R_srcShoulder − I)·v_rest_src × torsoScale 的方向；R_srcShoulder = clip 的源锁骨局部
 *     旋转，v_rest_src = 源 rest 锁骨向量。即把「源锁骨旋转造成的肩点位移」按 torso 长比例
 *     重新缩放，再交给目标固定长度的锁骨；目标锁骨 2× 长时局部角自然按 0.5×torsoScale 压小。
 *     该模式对躺姿/零锁骨旋转 clip 都稳定（见 docs 报告）。
 *   - displacement：目标期望肩窝 = 目标 posed torso 系里 rest 肩窝 + 源姿态位移 × torsoScale
 *     （诊断用；对 torso 系姿态敏感）。
 * @param {number} [input.options.reachRatio=0.98]
 * @param {number} [input.options.minElbowFlexDeg=10]
 * @param {number} [input.options.maxElbowFlexDeg=150]
 * @param {number} [input.options.maxShoulderLocalDeg=0] 0/缺省 = 不限制；>0 = 锁骨局部角安全上限
 * @returns {{rotations: Record<string,Quat4>, metrics: object, debug: object}}
 */
export function retargetFrame(input) {
  const { sourceRest, targetRest, rotations } = input
  const options = input.options ?? {}
  const socketMode = options.socketMode === 'displacement' || options.socketMode === 'chest-displacement'
    ? options.socketMode
    : 'absolute'
  const reachRatio = Number.isFinite(options.reachRatio) ? options.reachRatio : 0.98
  const minElbowFlexDeg = Number.isFinite(options.minElbowFlexDeg) ? options.minElbowFlexDeg : 10
  const maxElbowFlexDeg = Number.isFinite(options.maxElbowFlexDeg) ? options.maxElbowFlexDeg : 150
  const maxShoulderLocalDeg = Number.isFinite(options.maxShoulderLocalDeg) ? options.maxShoulderLocalDeg : 0

  const proportions = deriveProportions(sourceRest, targetRest)
  const scale = proportions.torsoScale
  const sourcePose = forwardKinematics(sourceRest, rotations)
  const targetBefore = forwardKinematics(targetRest, rotations)
  const sourceFrame = computeTorsoFrame(sourcePose)
  const targetFrame = computeTorsoFrame(targetBefore)
  const sourceRestFrame = computeTorsoFrame({ positions: sourceRest })
  const targetRestFrame = computeTorsoFrame({ positions: targetRest })

  const solved = {}
  for (const bone of RETARGETED_BONES) solved[bone] = frameQuat(rotations, bone)

  const metrics = { sides: {} }
  const debug = { sides: {} }

  for (const side of SIDES) {
    const shoulder = `${side}Shoulder`
    const upperArm = `${side}UpperArm`
    const lowerArm = `${side}LowerArm`
    const hand = `${side}Hand`

    const sourceShoulderPos = sourcePose.positions[shoulder]
    const sourceUpperArmPos = sourcePose.positions[upperArm]
    const sourceLowerArmPos = sourcePose.positions[lowerArm]
    const sourceHandPos = sourcePose.positions[hand]
    if (!sourceUpperArmPos || !sourceLowerArmPos || !sourceHandPos) {
      throw new Error(`源 rest 缺手臂骨：${side}`)
    }

    // 源关节 → 源 torso 系（米），/源 torso 长 → 归一化
    const norm = (p) => frameLocal(sourceFrame, p).map((v) => v / proportions.sourceTorsoLengthM)
    const expectedAbsolute = (p) => frameWorld(targetFrame, norm(p).map((v) => v * proportions.targetTorsoLengthM))

    const expectedUpperArmAbs = expectedAbsolute(sourceUpperArmPos)
    const expectedElbowAbs = expectedAbsolute(sourceLowerArmPos)
    const expectedHandAbs = expectedAbsolute(sourceHandPos)
    const expectedChestAbs = expectedAbsolute(sourcePose.positions.Chest)

    if (!targetBefore.positions[shoulder]) throw new Error(`目标 rest 缺 ${shoulder}`)
    const shoulderRoot = targetBefore.positions[shoulder]
    const restOffset = vSub(targetRest[upperArm], targetRest[shoulder])
    const clavicleLength = vLen(restOffset)
    const restDir = vNorm(restOffset)

    let expectedUpperArm = expectedUpperArmAbs
    if (socketMode === 'displacement') {
      const srcLocal = frameLocal(sourceFrame, sourceUpperArmPos)
      const srcRestLocal = frameLocal(sourceRestFrame, sourceRest[upperArm])
      const tgtRestLocal = frameLocal(targetRestFrame, targetRest[upperArm])
      const dispLocal = tgtRestLocal.map((v, i) => v + (srcLocal[i] - srcRestLocal[i]) * scale)
      expectedUpperArm = frameWorld(targetFrame, dispLocal)
      // 注意：expectedElbowAbs / expectedHandAbs 仍用 absolute（手/肘是目标地标，不是 rest 位移）
    } else if (socketMode === 'chest-displacement') {
      // 目标 chest 系：target rest 锁骨向量 + 源锁骨局部旋转造成的位移 × torsoScale
      const qSrcShoulder = frameQuat(rotations, shoulder)
      const srcRestClavicle = vSub(sourceRest[upperArm], sourceRest[shoulder])
      const srcDisp = vSub(quatRotateVec(qSrcShoulder, srcRestClavicle), srcRestClavicle)
      const desiredLocal = vAdd(restOffset, vScale(srcDisp, scale))
      const dirWorld = quatRotateVec(targetBefore.deltas.Chest, vNorm(desiredLocal))
      expectedUpperArm = vAdd(shoulderRoot, vScale(dirWorld, clavicleLength))
    }

    // ---- 锁骨 aim ----
    // 关键：锁骨局部旋转 q_shoulder 的父级是 chest（或 upperChest），要先解出 chest-local 方向：
    //   clavicle_world_dir = D_parent · q_shoulder · restDir
    // 只对 D_parent·restDir → desired_world_dir 做 world swing 会错把 chest 旋转算进 q_shoulder
    // （躺姿/坐姿 chest 转 30–90° 时会把局部角放大到 30–100°）。
    const shoulderParent = effectiveParents(targetRest)[shoulder] ?? 'Chest'
    const parentDelta = targetBefore.deltas[shoulderParent] ?? targetBefore.deltas.Chest
    const parentInv = quatConjugate(parentDelta)
    const desiredVec = vSub(expectedUpperArm, shoulderRoot)
    const desiredLen = vLen(desiredVec)
    const desiredWorldDir = desiredLen > EPS ? vScale(desiredVec, 1 / desiredLen) : quatRotateVec(parentDelta, restDir)
    const desiredLocalDir = vNorm(quatRotateVec(parentInv, desiredWorldDir))
    let qShoulder = quatFromUnitVectors(restDir, desiredLocalDir)
    let capInfo = { capped: false, angleDeg: quatAngleDeg(qShoulder) }
    if (maxShoulderLocalDeg > 0 && capInfo.angleDeg > maxShoulderLocalDeg + 1e-6) {
      const capped = capQuatAngleFromIdentity(qShoulder, maxShoulderLocalDeg)
      qShoulder = capped.quat
      capInfo = { capped: true, angleDeg: maxShoulderLocalDeg }
    }
    const deltaShoulder = quatNormalize(quatMultiply(parentDelta, qShoulder))
    const aimDir = vNorm(quatRotateVec(deltaShoulder, restDir))
    const socket = vAdd(shoulderRoot, vScale(aimDir, clavicleLength))

    // ---- 手臂 IK ----
    const l1 = vDist(targetRest[upperArm], targetRest[lowerArm])
    const l2 = vDist(targetRest[lowerArm], targetRest[hand])
    const ik = solveTwoBoneIK({
      root: socket,
      target: expectedHandAbs,
      polePoint: expectedElbowAbs,
      fallbackUp: targetFrame.up,
      l1,
      l2,
      reachRatio,
      minElbowFlexDeg,
      maxElbowFlexDeg
    })

    // ---- world 旋转（源方向 → 目标方向的 swing × 源 world 旋转，保留 twist）----
    const sourceUpperDir = vNorm(vSub(sourceLowerArmPos, sourceUpperArmPos))
    const sourceForeDir = vNorm(vSub(sourceHandPos, sourceLowerArmPos))
    const targetUpperDir = vNorm(vSub(ik.elbow, socket))
    const targetForeDir = vNorm(vSub(ik.wrist, ik.elbow))
    const deltaUpperArm = quatMultiply(quatFromUnitVectors(sourceUpperDir, targetUpperDir), sourcePose.deltas[upperArm])
    const deltaLowerArm = quatMultiply(quatFromUnitVectors(sourceForeDir, targetForeDir), sourcePose.deltas[lowerArm])
    const qUpperArm = quatNormalize(quatMultiply(quatInvert(deltaShoulder), deltaUpperArm))
    const qLowerArm = quatNormalize(quatMultiply(quatInvert(deltaUpperArm), deltaLowerArm))
    solved[shoulder] = qShoulder
    solved[upperArm] = qUpperArm
    solved[lowerArm] = qLowerArm

    // ---- 应用后 FK（用于指标；Hand 保持原 normalized 旋转）----
    const afterRotations = {}
    for (const bone of ARM_TORSO_BONES) afterRotations[bone] = frameQuat(rotations, bone)
    afterRotations[shoulder] = qShoulder
    afterRotations[upperArm] = qUpperArm
    afterRotations[lowerArm] = qLowerArm
    const targetAfter = forwardKinematics(targetRest, afterRotations)
    const socketAfter = targetAfter.positions[upperArm]
    const handAfter = targetAfter.positions[hand]
    const handBefore = targetBefore.positions[hand]
    const socketBefore = targetBefore.positions[upperArm]

    // ---- 指标 ----
    const local = (p) => frameLocal(targetFrame, p)
    const chestLocal = local(targetBefore.positions.Chest)
    const expectedLocalUpperArm = local(expectedUpperArm)
    const expectedLocalHand = local(expectedHandAbs)
    const beforeLocalUpperArm = local(socketBefore)
    const afterLocalUpperArm = local(socketAfter)
    const afterLocalHand = local(handAfter)
    const beforeLocalHand = local(handBefore)
    const socketHeight = (v) => (v[1] - chestLocal[1]) * 100
    const socketWidth = (v) => Math.abs(v[0]) * 100
    const sourceChestNorm = frameLocal(sourceFrame, sourcePose.positions.Chest).map((v) => v / proportions.sourceTorsoLengthM)
    const sourceUpperNorm = norm(sourceUpperArmPos)
    const sourceScaledHeight = (sourceUpperNorm[1] - sourceChestNorm[1]) * proportions.targetTorsoLengthM * 100

    const torsoLen = proportions.targetTorsoLengthM
    const handRelChestBefore = vScale(vSub(beforeLocalHand, chestLocal), 1 / torsoLen)
    const handRelChestAfter = vScale(vSub(afterLocalHand, chestLocal), 1 / torsoLen)
    const handRelChestExpected = vScale(vSub(expectedLocalHand, chestLocal), 1 / torsoLen)
    const handRelChestErr = vLen(vSub(handRelChestAfter, handRelChestExpected)) * 100 // 归一化误差 → cm（× torso 长）
    const handRelChestErrCm = vLen(vSub(afterLocalHand, expectedLocalHand)) * 100

    const handTorsoDist = (() => {
      // 到手到 hips→head 线段的距离
      const a = targetBefore.positions.Hips
      const b = targetBefore.positions.Head
      const ab = vSub(b, a)
      const t = Math.max(0, Math.min(1, vDot(vSub(handAfter, a), ab) / Math.max(EPS, vDot(ab, ab))))
      return vDist(handAfter, vAdd(a, vScale(ab, t))) * 100
    })()
    const handChestDist = vDist(handAfter, targetBefore.positions.Chest) * 100

    const up = targetFrame.up
    const horizontalAngle = (dir, axis) => Math.asin(Math.min(1, Math.abs(vDot(dir, axis)))) * RAD2DEG
    const beforeUpperDir = vNorm(vSub(targetBefore.positions[lowerArm], socketBefore))
    const afterUpperDir = vNorm(vSub(targetAfter.positions[lowerArm], socketAfter))
    const sourceUpperDirForAngle = sourceUpperDir
    const worldUp = [0, 1, 0]

    metrics.sides[side] = {
      shoulderLocalDegBefore: quatAngleDeg(frameQuat(rotations, shoulder)),
      shoulderLocalDegAfter: quatAngleDeg(qShoulder),
      shoulderLocalDegSource: quatAngleDeg(frameQuat(rotations, shoulder)),
      shoulderCapped: capInfo.capped,
      aimAngleFromRestDeg: quatAngleDeg(qShoulder),
      socketDesiredDistanceCm: desiredLen * 100,
      clavicleLengthCm: clavicleLength * 100,
      socketErrorCm: vDist(socketAfter, expectedUpperArm) * 100,
      socketAimClamped: Math.abs(desiredLen - clavicleLength) > 1e-6,
      socketLiftCm: (afterLocalUpperArm[1] - beforeLocalUpperArm[1]) * 100,
      socketHeightAboveChestBeforeCm: socketHeight(beforeLocalUpperArm),
      socketHeightAboveChestAfterCm: socketHeight(afterLocalUpperArm),
      socketHeightAboveChestExpectedCm: socketHeight(expectedLocalUpperArm),
      socketHeightAboveChestAbsExpectedCm: socketHeight(local(expectedUpperArmAbs)),
      socketHeightAboveChestSourceScaledCm: sourceScaledHeight,
      socketHalfWidthBeforeCm: socketWidth(beforeLocalUpperArm),
      socketHalfWidthAfterCm: socketWidth(afterLocalUpperArm),
      socketHalfWidthExpectedCm: socketWidth(expectedLocalUpperArm),
      socketHalfWidthAbsExpectedCm: socketWidth(local(expectedUpperArmAbs)),
      socketHalfWidthSourceScaledCm: Math.abs(sourceUpperNorm[0]) * torsoLen * 100,
      handErrorCm: vDist(handAfter, expectedHandAbs) * 100,
      handRelChestErrNorm: handRelChestErr,
      handRelChestErrCm,
      handShiftCm: vDist(handAfter, handBefore) * 100,
      reachClamped: ik.clamped,
      targetDistanceCmd: ik.desiredDistance * 100,
      armReachCm: (l1 + l2) * 100,
      elbowFlexDegBefore: (() => {
        const u = vNorm(vSub(targetBefore.positions[lowerArm], socketBefore))
        const f = vNorm(vSub(handBefore, targetBefore.positions[lowerArm]))
        return Math.acos(Math.min(1, Math.max(-1, vDot(u, f)))) * RAD2DEG
      })(),
      elbowFlexDegAfter: ik.flexDeg,
      elbowFlexDegSource: (() => {
        const u = sourceUpperDir
        const f = sourceForeDir
        return Math.acos(Math.min(1, Math.max(-1, vDot(u, f)))) * RAD2DEG
      })(),
      upperArmDirChangeDeg: Math.acos(Math.min(1, Math.max(-1, vDot(beforeUpperDir, afterUpperDir)))) * RAD2DEG,
      upperArmDirVsSourceDeg: Math.acos(Math.min(1, Math.max(-1, vDot(afterUpperDir, sourceUpperDirForAngle)))) * RAD2DEG,
      upperArmWorldDeltaDeg: quatDeltaDeg(sourcePose.deltas[upperArm], targetAfter.deltas[upperArm]),
      lowerArmWorldDeltaDeg: quatDeltaDeg(sourcePose.deltas[lowerArm], targetAfter.deltas[lowerArm]),
      handWorldDeltaDeg: quatDeltaDeg(sourcePose.deltas[hand], targetAfter.deltas[hand]),
      upperArmHorizontalAngleBeforeDeg: horizontalAngle(beforeUpperDir, up),
      upperArmHorizontalAngleAfterDeg: horizontalAngle(afterUpperDir, up),
      upperArmHorizontalAngleChangeDeg: Math.abs(horizontalAngle(afterUpperDir, up) - horizontalAngle(beforeUpperDir, up)),
      upperArmWorldHorizontalAngleBeforeDeg: horizontalAngle(beforeUpperDir, worldUp),
      upperArmWorldHorizontalAngleAfterDeg: horizontalAngle(afterUpperDir, worldUp),
      upperArmWorldHorizontalAngleChangeDeg: Math.abs(horizontalAngle(afterUpperDir, worldUp) - horizontalAngle(beforeUpperDir, worldUp)),
      handTorsoAxisDistCm: handTorsoDist,
      handChestDistCm: handChestDist
    }
    debug.sides[side] = {
      source: { shoulder: sourceShoulderPos, upperArm: sourceUpperArmPos, lowerArm: sourceLowerArmPos, hand: sourceHandPos },
      sourceNormalized: { upperArm: norm(sourceUpperArmPos), lowerArm: norm(sourceLowerArmPos), hand: norm(sourceHandPos) },
      expected: { upperArm: expectedUpperArm, elbow: expectedElbowAbs, hand: expectedHandAbs, chest: expectedChestAbs },
      before: { upperArm: socketBefore, hand: handBefore },
      after: { upperArm: socketAfter, elbow: ik.elbow, hand: handAfter },
      shoulderRoot
    }
  }

  return { rotations: solved, metrics, debug, proportions }
}

/* -------------------------------------------------------------------------- */
/* clip 级                                                                     */
/* -------------------------------------------------------------------------- */

/** 解码 nested/flat 旋转轨道为 Quat4 数组（非法/缺帧回退 identity）。 */
export function decodeRotationTrack(track, frames) {
  const out = new Array(frames)
  if (!Array.isArray(track) || track.length === 0) {
    for (let i = 0; i < frames; i += 1) out[i] = [0, 0, 0, 1]
    return out
  }
  const nested = Array.isArray(track[0])
  for (let i = 0; i < frames; i += 1) {
    const q = nested ? track[i] : track.slice(i * 4, i * 4 + 4)
    if (!Array.isArray(q) || q.length !== 4 || q.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      out[i] = [0, 0, 0, 1]
    } else out[i] = quatNormalize(q)
  }
  return out
}

/** 四元数序列符号连续化（相邻 dot < 0 时取反），返回副本。 */
export function enforceQuatContinuity(quats) {
  const out = quats.map((q) => quatNormalize(q))
  for (let i = 1; i < out.length; i += 1) {
    const d = out[i - 1][0] * out[i][0] + out[i - 1][1] * out[i][1] + out[i - 1][2] * out[i][2] + out[i - 1][3] * out[i][3]
    if (d < 0) out[i] = [-out[i][0], -out[i][1], -out[i][2], -out[i][3]]
  }
  return out
}

/**
 * 对整段 clip 做比例感知手臂重定向（纯函数）。
 *
 * @param {any} clip clip JSON（需要 `frames`、`bones[].r`）
 * @param {{sourceRest:Record<string,number[]>, targetRest:Record<string,number[]>, options?:object}} config
 * @returns {{tracks:Record<string,Quat4[]>, frameMetrics:object[], summary:object, proportions:object}}
 */
export function retargetClip(clip, config) {
  const frames = Number(clip?.frames)
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`clip.frames 非法：${clip?.frames}`)
  const sourceTracks = {}
  for (const bone of ARM_TORSO_BONES) {
    const raw = clip?.bones?.[bone]?.r
    sourceTracks[bone] = decodeRotationTrack(raw, frames)
  }
  const tracks = Object.fromEntries(RETARGETED_BONES.map((b) => [b, new Array(frames)]))
  const frameMetrics = new Array(frames)
  const proportions = deriveProportions(config.sourceRest, config.targetRest)
  for (let f = 0; f < frames; f += 1) {
    const rotations = { UpperChest: sourceTracks.UpperChest[f] }
    for (const bone of ARM_TORSO_BONES) rotations[bone] = sourceTracks[bone][f]
    const result = retargetFrame({
      sourceRest: config.sourceRest,
      targetRest: config.targetRest,
      rotations,
      options: config.options
    })
    for (const bone of RETARGETED_BONES) tracks[bone][f] = result.rotations[bone]
    frameMetrics[f] = { frame: f, sides: result.metrics.sides }
  }
  for (const bone of RETARGETED_BONES) tracks[bone] = enforceQuatContinuity(tracks[bone])
  return { tracks, frameMetrics, summary: summarizeRetarget(frameMetrics), proportions }
}

/** 汇总逐帧指标（max / mean；口径见 docs/report）。 */
export function summarizeRetarget(frameMetrics) {
  if (!Array.isArray(frameMetrics) || frameMetrics.length === 0) return null
  const sides = ['Left', 'Right']
  const keys = Object.keys(frameMetrics[0].sides.Left)
  const out = { frames: frameMetrics.length, sides: {} }
  for (const side of sides) {
    const sideOut = {}
    for (const key of keys) {
      const values = []
      for (const row of frameMetrics) {
        const m = row.sides[side]
        if (!m) continue
        const v = m[key]
        if (typeof v === 'number' && Number.isFinite(v)) values.push(v)
        else if (typeof v === 'boolean') values.push(v ? 1 : 0)
      }
      if (values.length === 0) continue
      const isBoolean = typeof frameMetrics[0].sides[side][key] === 'boolean'
      if (isBoolean) {
        sideOut[key] = { count: values.reduce((s, v) => s + v, 0) }
      } else {
        const sorted = [...values].sort((a, b) => a - b)
        sideOut[key] = {
          max: sorted[sorted.length - 1],
          mean: values.reduce((s, v) => s + v, 0) / values.length,
          min: sorted[0],
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
        }
      }
    }
    out.sides[side] = sideOut
  }
  return out
}
