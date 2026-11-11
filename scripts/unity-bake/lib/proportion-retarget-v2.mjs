/**
 * 比例感知肩/臂重定向 v2 —— S2-only 锁骨预算转移 + 受限手 IK（Hybrid）
 *
 * 本库是 B 原型（`proportion-retarget.mjs`）的收敛版：B 的 absolute 模式会把手腕 IK 到
 * 「源绝对位置 × 躯干比例」，但男体臂长只有源 Zome 的 1.22×（躯干 1.43×），sit/window/hide
 * 等 clip 的目标腕经常超出 98% reach，IK 硬拉把上臂方向带偏 15–26°，idle 族出现 A-pose 回归。
 *
 * v2 的主线是 S2-only：
 *   S' = slerp(I, S, k)                 // 每帧锁骨局部旋转按比例 k 压小
 *   A' = S'⁻¹ · S · A                   // 上臂局部旋转补偿 → 手臂 world 朝向逐帧不变
 *   lowerArm / hand / 手指不动
 * 于是：肩点（upperArm 关节点）被抬回、锁骨局部角变小，而手臂/手的世界朝向与手势完全不变；
 * 手的位置只随肩点做整体平移（平移量 = 肩点位移）。
 *
 * k 由源/目标 rest 几何推导（见 `deriveS2Coefficients`）：
 *   - kSocket = (L_s / L_t) · (H_t / H_s)              肩点相对躯干高的归一化位移一致
 *   - kSlope  = 数值解视觉肩线斜率一致（按 §4.2 公式）
 *
 * Hybrid 只对接触类 clip（sit/windowLay/hide）在 S2-only 之后加受限手 IK：
 *   - 目标默认 = 原 clip 在男体上的手位（保住接触/窗沿/膝上语义），可选 = 源归一化绝对位置；
 *   - 修正向量先做 1–2 帧时域平滑，再 clamp ≤3cm；
 *   - guards：上臂方向变化 ≤3°、肘屈 [15°,150°]、98% reach、无 reach clamp；
 *   - 逐帧失败 → 回退 S2-only；权重再做时域平滑。
 * idle 族/手势类/sitWindow/sleep 在 Hybrid 里不用手 IK；sleep 默认整段排除。
 *
 * 纯逻辑：不 import three / DOM / node:*；四元数 `[x,y,z,w]`（Hamilton，a·b = 先 b 后 a）。
 * 只供 dev-only 的 bake CLI 与 tests 使用；不改产品运行时。
 */

import {
  ARM_TORSO_BONES,
  computeTorsoFrame,
  decodeRotationTrack,
  enforceQuatContinuity,
  forwardKinematics,
  frameLocal,
  frameWorld,
  quatAngleDeg,
  quatFromUnitVectors,
  quatInvert,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  quatSlerp,
  solveTwoBoneIK,
  vAdd,
  vDist,
  vDot,
  vLen,
  vNorm,
  vScale,
  vSub
} from './proportion-retarget.mjs'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const IDENTITY_QUAT = Object.freeze([0, 0, 0, 1])
const SIDES = Object.freeze(['Left', 'Right'])
const EPS = 1e-9

/** S2-only 会改写的 4 根骨；lowerArm/hand 不动。 */
export const S2_MODIFIED_BONES = Object.freeze([
  'LeftShoulder', 'LeftUpperArm', 'RightShoulder', 'RightUpperArm'
])

/** 输出 clip 时可能改写的 6 根（Hybrid 会额外改 lowerArm）。 */
export const V2_MODIFIED_BONES = Object.freeze([
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm'
])

/** 候选 clip 的 tag（用于汇总表）。 */
export const CLIP_TAGS = Object.freeze({
  idle: 'idle', idle2: 'idle', idle3: 'idle', idle4: 'idle', idle5: 'idle', idle6: 'idle', idle7: 'idle',
  happy: 'gesture', laughing: 'gesture', shyPoint: 'gesture', pose1: 'gesture', pose2: 'gesture', pose3: 'gesture',
  sit1: 'sit', sit2: 'sit', suwari3: 'sit',
  sitWindow: 'window',
  windowLay8: 'windowLay', windowLay9: 'windowLay', windowLay10: 'windowLay',
  hideLeft: 'hide', hideOnce: 'hide',
  sleep: 'sleep',
  walk: 'walk', walkAlt: 'walk', drag: 'drag', dragFemale: 'drag'
})

/**
 * Hybrid 的逐 clip 策略：
 *   - 's2'        = 只做 S2-only（禁手 IK）
 *   - 'contact-ik'= S2 + 受限 IK，目标 = 原 clip 男体手位（保接触）
 *   - 'source-ik' = S2 + 受限 IK，目标 = 源归一化绝对手位（诊断；修正仍 ≤3cm）
 *   - 'exclude'   = 原样不动
 */
export const HYBRID_POLICY = Object.freeze({
  idle: 's2', idle2: 's2', idle3: 's2', idle4: 's2', idle5: 's2', idle6: 's2', idle7: 's2',
  happy: 's2', laughing: 's2', shyPoint: 's2', pose1: 's2', pose2: 's2', pose3: 's2',
  sit1: 'contact-ik', sit2: 'contact-ik', suwari3: 'contact-ik',
  sitWindow: 's2',
  windowLay8: 'contact-ik', windowLay9: 'contact-ik', windowLay10: 'contact-ik',
  hideLeft: 'contact-ik', hideOnce: 'contact-ik',
  sleep: 'exclude'
})

/** 默认 guards（Hybrid 用手 IK 时）。 */
export const DEFAULT_GUARDS = Object.freeze({
  maxUpperArmDirChangeDeg: 3,
  maxHandCorrectionCm: 3,
  minElbowFlexDeg: 15,
  maxElbowFlexDeg: 150,
  reachRatio: 0.98,
  correctionSmoothPasses: 2,
  weightSmoothPasses: 2
})

/* -------------------------------------------------------------------------- */
/* 小工具                                                                       */
/* -------------------------------------------------------------------------- */

/** @param {number} v @returns {number} */
function clamp01(v) { return Math.max(0, Math.min(1, v)) }

/** @param {number[]} values @returns {number} */
function mean(values) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0 }

/** 一帧的 normalized 局部旋转（缺省/非法 → identity）。 */
function frameQuat(rotations, bone) {
  const q = rotations?.[bone]
  if (!Array.isArray(q) || q.length !== 4) return [0, 0, 0, 1]
  return quatNormalize(q)
}

/** 两向量夹角（度）。 */
function vecAngleDeg(a, b) {
  const na = vNorm(a)
  const nb = vNorm(b)
  const d = Math.max(-1, Math.min(1, vDot(na, nb)))
  return Math.acos(d) * RAD2DEG
}

/** 骨段方向与「水平面」的夹角（度；B 的 A-pose 口径）。 */
function horizontalAngleDeg(dir, up) {
  return Math.asin(Math.min(1, Math.abs(vDot(vNorm(dir), vNorm(up))))) * RAD2DEG
}

/** 两骨夹角（度）。 */
function jointFlexDeg(root, mid, end) {
  const u = vNorm(vSub(mid, root))
  const f = vNorm(vSub(end, mid))
  return Math.acos(Math.max(-1, Math.min(1, vDot(u, f)))) * RAD2DEG
}

/** 逐骨统计：单位化最大误差 / 相邻帧最大角 / loop seam。 */
export function trackStats(quats, loop) {
  let unitMax = 0
  let jumpMax = 0
  for (const q of quats) unitMax = Math.max(unitMax, Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1))
  for (let i = 1; i < quats.length; i += 1) {
    jumpMax = Math.max(jumpMax, quatAngleDeg(quatMultiply(quatInvert(quats[i - 1]), quats[i])))
  }
  const seam = loop && quats.length > 1
    ? quatAngleDeg(quatMultiply(quatInvert(quats[0]), quats[quats.length - 1]))
    : null
  return { unitMax, jumpMax, seam }
}

/* -------------------------------------------------------------------------- */
/* k 推导：S2-only 的锁骨角度缩放系数                                          */
/* -------------------------------------------------------------------------- */

/**
 * 肩线视觉斜率：drop / (shoulderRootHalfWidth + L·cosθ)。
 * @param {number} L 锁骨长（米）
 * @param {number} half 锁骨根（Shoulder 关节）到身体中线距离（米）
 * @param {number} theta 锁骨下压角（弧度）
 * @returns {number}
 */
export function shoulderLineSlope(L, half, theta) {
  const denom = half + L * Math.cos(theta)
  return denom > EPS ? (L * Math.sin(theta)) / denom : 0
}

/** 解「目标锁骨下压 θ_t 使肩线斜率 = targetSlope」。 */
function solveThetaForSlope(Lt, halfT, targetSlope) {
  let lo = 1e-6
  let hi = Math.PI / 2 - 1e-6
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2
    if (shoulderLineSlope(Lt, halfT, mid) < targetSlope) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 数值解 k，使 θ_t = k·θ_s 在 θ_s∈[10°,40°] 上肩线斜率最接近源。
 * 同时给出 20° 处的精确解（计划 §4.2 的「20°→16°」就是这一档）。
 */
function solveSlopeCoefficient(Ls, Lt, halfS, halfT) {
  const thetas = [10, 15, 20, 25, 30, 35, 40].map((d) => d * DEG2RAD)
  let best = null
  for (let i = 4000; i <= 11000; i += 1) {
    const k = i / 10000
    let err = 0
    for (const theta of thetas) {
      const target = shoulderLineSlope(Ls, halfS, theta)
      const got = shoulderLineSlope(Lt, halfT, k * theta)
      const d = got - target
      err += d * d
    }
    if (best === null || err < best.err) best = { k, err }
  }
  const target20 = shoulderLineSlope(Ls, halfS, 20 * DEG2RAD)
  const kAt20 = solveThetaForSlope(Lt, halfT, target20) / (20 * DEG2RAD)
  return {
    k: best.k,
    kAt20,
    slopeRms: Math.sqrt(best.err / thetas.length),
    slopeAt20Source: target20,
    slopeAt20Target: shoulderLineSlope(Lt, halfT, best.k * 20 * DEG2RAD)
  }
}

/**
 * 由源/目标 rest 推导 S2 的 k 两档。
 *
 * @param {Record<string, number[]>} sourceRest canonical 源 rest（米）
 * @param {Record<string, number[]>} targetRest 目标 rest（米）
 * @returns {object}
 */
export function deriveS2Coefficients(sourceRest, targetRest) {
  if (!sourceRest?.Head || !targetRest?.Head) throw new Error('deriveS2Coefficients 需要 Head')
  const sourceTorsoM = vDist(sourceRest.Head, sourceRest.Hips)
  const targetTorsoM = vDist(targetRest.Head, targetRest.Hips)
  const sourceFrame = computeTorsoFrame({ positions: sourceRest })
  const targetFrame = computeTorsoFrame({ positions: targetRest })
  const sides = {}
  for (const side of SIDES) {
    const shoulder = `${side}Shoulder`
    const upperArm = `${side}UpperArm`
    const Ls = vDist(sourceRest[upperArm], sourceRest[shoulder])
    const Lt = vDist(targetRest[upperArm], targetRest[shoulder])
    const halfS = Math.abs(frameLocal(sourceFrame, sourceRest[shoulder])[0])
    const halfT = Math.abs(frameLocal(targetFrame, targetRest[shoulder])[0])
    const kSocket = (Ls / Lt) * (targetTorsoM / sourceTorsoM)
    const slope = solveSlopeCoefficient(Ls, Lt, halfS, halfT)
    sides[side] = {
      sourceClavicleM: Ls,
      targetClavicleM: Lt,
      clavicleScale: Lt / Ls,
      sourceShoulderRootHalfWidthM: halfS,
      targetShoulderRootHalfWidthM: halfT,
      kSocket,
      kSlope: slope.k,
      kSlopeAt20: slope.kAt20,
      kSlopeRms: slope.slopeRms
    }
  }
  return {
    sourceTorsoM,
    targetTorsoM,
    torsoScale: targetTorsoM / sourceTorsoM,
    sourceClavicleM: mean(SIDES.map((s) => sides[s].sourceClavicleM)),
    targetClavicleM: mean(SIDES.map((s) => sides[s].targetClavicleM)),
    clavicleScale: mean(SIDES.map((s) => sides[s].clavicleScale)),
    sourceShoulderRootHalfWidthM: mean(SIDES.map((s) => sides[s].sourceShoulderRootHalfWidthM)),
    targetShoulderRootHalfWidthM: mean(SIDES.map((s) => sides[s].targetShoulderRootHalfWidthM)),
    kSocket: mean(SIDES.map((s) => sides[s].kSocket)),
    kSlope: mean(SIDES.map((s) => sides[s].kSlope)),
    kSlopeAt20: mean(SIDES.map((s) => sides[s].kSlopeAt20)),
    sides
  }
}

/* -------------------------------------------------------------------------- */
/* S2-only 单帧                                                                */
/* -------------------------------------------------------------------------- */

/**
 * S2-only：只改锁骨/上臂局部旋转，保证 upperArm 及其下游 world 朝向不变。
 *
 * @param {Record<string, number[]>} rotations 本帧 normalized 旋转
 * @param {number} k 锁骨角度缩放系数 [0,1]
 * @returns {{rotations: Record<string,[number,number,number,number]>, sides: object}}
 */
export function applyS2Frame(rotations, k) {
  const kk = clamp01(Number.isFinite(k) ? k : 0)
  const out = {}
  const sides = {}
  for (const side of SIDES) {
    const shoulder = `${side}Shoulder`
    const upperArm = `${side}UpperArm`
    const qS = frameQuat(rotations, shoulder)
    const qA = frameQuat(rotations, upperArm)
    const qS2 = quatSlerp(IDENTITY_QUAT, qS, kk)
    const qA2 = quatNormalize(quatMultiply(quatInvert(qS2), quatMultiply(qS, qA)))
    out[shoulder] = qS2
    out[upperArm] = qA2
    sides[side] = {
      shoulderDegBefore: quatAngleDeg(qS),
      shoulderDegAfter: quatAngleDeg(qS2),
      upperArmDegBefore: quatAngleDeg(qA),
      upperArmDegAfter: quatAngleDeg(qA2)
    }
  }
  return { rotations: out, sides }
}

/* -------------------------------------------------------------------------- */
/* 时域平滑                                                                    */
/* -------------------------------------------------------------------------- */

/** 5-tap 二项式核（[1,4,6,4,1]/16），约 1–2 帧平滑。 */
const SMOOTH_KERNEL = Object.freeze([1, 4, 6, 4, 1])

function neighborIndex(i, d, n, loop) {
  let j = i + d
  if (loop) return ((j % n) + n) % n
  if (j < 0 || j >= n) return null
  return j
}

/**
 * 平滑标量序列（weights）。
 * @param {number[]} values
 * @param {boolean} loop
 * @param {number} passes
 * @returns {number[]}
 */
export function smoothWeights(values, loop, passes = 2) {
  let arr = values.slice()
  const n = arr.length
  if (n === 0) return arr
  for (let p = 0; p < Math.max(0, passes); p += 1) {
    const out = new Array(n)
    for (let i = 0; i < n; i += 1) {
      let sum = 0
      let norm = 0
      for (let d = -2; d <= 2; d += 1) {
        const j = neighborIndex(i, d, n, loop)
        if (j === null) continue
        const w = SMOOTH_KERNEL[d + 2]
        sum += arr[j] * w
        norm += w
      }
      out[i] = norm > 0 ? sum / norm : arr[i]
    }
    arr = out
  }
  return arr
}

/**
 * 平滑三维改正向量序列（null = 该帧不做手 IK）。
 * @param {Array<number[]|null>} vectors
 * @param {boolean} loop
 * @param {number} passes
 * @returns {Array<number[]|null>}
 */
export function smoothVectors(vectors, loop, passes = 2) {
  let arr = vectors.map((v) => (Array.isArray(v) && v.length === 3 ? [v[0], v[1], v[2]] : null))
  const n = arr.length
  if (n === 0) return arr
  for (let p = 0; p < Math.max(0, passes); p += 1) {
    const out = new Array(n)
    for (let i = 0; i < n; i += 1) {
      let sum = [0, 0, 0]
      let norm = 0
      for (let d = -2; d <= 2; d += 1) {
        const j = neighborIndex(i, d, n, loop)
        if (j === null) continue
        const v = arr[j]
        if (!v) continue
        const w = SMOOTH_KERNEL[d + 2]
        sum = vAdd(sum, vScale(v, w))
        norm += w
      }
      out[i] = arr[i] === null ? null : (norm > 0 ? vScale(sum, 1 / norm) : null)
    }
    arr = out
  }
  return arr
}

/* -------------------------------------------------------------------------- */
/* Hybrid 手 IK                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 受限手 IK 单帧候选。
 *
 * 目标：S2-only 的 socket 抬升会让整条手臂平移；接触类 clip 希望手留在原地
 * （contact），或向源归一化绝对位置靠近（source，最多 3cm）。
 *
 * @param {object} p
 * @param {string} p.side
 * @param {Record<string,number[]>} p.targetRest
 * @param {object} p.sourcePose
 * @param {object} p.targetBefore
 * @param {object} p.targetS2
 * @param {object} p.sourceFrame
 * @param {object} p.targetFrame
 * @param {{sourceTorsoM:number,targetTorsoM:number}} p.coefficients
 * @param {'contact'|'source'} p.ikTarget
 * @param {number[]} p.correction 已平滑/已 clamp 的改正向量（米）
 * @param {object} p.guards
 * @returns {{accepted:boolean, reason:string|null, qShoulder:number[], qUpperArm:number[]|null, qLowerArm:number[]|null, correctionCm:number, upperArmDirChangeDeg:number, elbowFlexDeg:number, desiredCorrectionCm:number, targetWrist:number[]|null}}
 */
export function solveHybridCandidate(p) {
  const { side, targetRest, targetBefore, targetS2, sourcePose, sourceFrame, targetFrame, coefficients, ikTarget, correction, guards } = p
  const shoulder = `${side}Shoulder`
  const upperArm = `${side}UpperArm`
  const lowerArm = `${side}LowerArm`
  const hand = `${side}Hand`
  const socketS2 = targetS2.positions[upperArm]
  const elbowS2 = targetS2.positions[lowerArm]
  const handS2 = targetS2.positions[hand]
  const qShoulder = targetS2.rotations[shoulder]
  const qUpperArmS2 = targetS2.rotations[upperArm]
  const qLowerArmS2 = targetS2.rotations[lowerArm]

  // 期望手位（诊断用；实际改正向量由外部平滑后传入）
  let desiredHand = targetBefore.positions[hand]
  if (ikTarget === 'source') {
    const sourceNorm = frameLocal(sourceFrame, sourcePose.positions[hand]).map((v) => v / coefficients.sourceTorsoM)
    desiredHand = frameWorld(targetFrame, sourceNorm.map((v) => v * coefficients.targetTorsoM))
  }
  const rawCorrection = vSub(desiredHand, handS2)
  const rawCorrectionCm = vLen(rawCorrection) * 100
  const correctionCm = vLen(correction) * 100

  if (correctionCm < 1e-6) {
    return {
      accepted: true,
      reason: null,
      qShoulder,
      qUpperArm: qUpperArmS2,
      qLowerArm: qLowerArmS2,
      correctionCm: 0,
      upperArmDirChangeDeg: 0,
      elbowFlexDeg: jointFlexDeg(socketS2, elbowS2, handS2),
      desiredCorrectionCm: rawCorrectionCm,
      targetWrist: handS2
    }
  }

  const targetWrist = vAdd(handS2, correction)
  const l1 = vDist(targetRest[upperArm], targetRest[lowerArm])
  const l2 = vDist(targetRest[lowerArm], targetRest[hand])
  const ik = solveTwoBoneIK({
    root: socketS2,
    target: targetWrist,
    polePoint: elbowS2,
    fallbackUp: targetFrame.up,
    l1,
    l2,
    reachRatio: guards.reachRatio,
    minElbowFlexDeg: guards.minElbowFlexDeg,
    maxElbowFlexDeg: guards.maxElbowFlexDeg
  })

  const uS2 = vNorm(vSub(elbowS2, socketS2))
  const uIk = vNorm(vSub(ik.elbow, socketS2))
  const upperArmDirChangeDeg = vecAngleDeg(uS2, uIk)
  const actualCorrectionCm = vDist(ik.wrist, handS2) * 100
  const flex = ik.flexDeg

  let reason = null
  if (ik.clamped) reason = 'reach-clamped'
  else if (flex < guards.minElbowFlexDeg - 1e-6 || flex > guards.maxElbowFlexDeg + 1e-6) reason = 'elbow-range'
  else if (upperArmDirChangeDeg > guards.maxUpperArmDirChangeDeg + 1e-6) reason = 'upperarm-angle'
  else if (actualCorrectionCm > guards.maxHandCorrectionCm + 1e-6) reason = 'hand-correction'

  if (reason !== null) {
    return {
      accepted: false,
      reason,
      qShoulder,
      qUpperArm: null,
      qLowerArm: null,
      correctionCm: actualCorrectionCm,
      upperArmDirChangeDeg,
      elbowFlexDeg: flex,
      desiredCorrectionCm: rawCorrectionCm,
      targetWrist
    }
  }

  // 手臂 world 旋转：在 S2 的世界 delta 上叠加「S2 骨段方向 → IK 骨段方向」的 swing，保 twist
  const DShoulder = targetS2.deltas[shoulder]
  const DUpperArmS2 = targetS2.deltas[upperArm]
  const DLowerArmS2 = targetS2.deltas[lowerArm]
  const fS2 = vNorm(vSub(handS2, elbowS2))
  const fIk = vNorm(vSub(ik.wrist, ik.elbow))
  const DUpperArmIk = quatMultiply(quatFromUnitVectors(uS2, uIk), DUpperArmS2)
  const DLowerArmIk = quatMultiply(quatFromUnitVectors(fS2, fIk), DLowerArmS2)
  const qUpperArm = quatNormalize(quatMultiply(quatInvert(DShoulder), DUpperArmIk))
  const qLowerArm = quatNormalize(quatMultiply(quatInvert(DUpperArmIk), DLowerArmIk))

  return {
    accepted: true,
    reason: null,
    qShoulder,
    qUpperArm,
    qLowerArm,
    correctionCm: actualCorrectionCm,
    upperArmDirChangeDeg,
    elbowFlexDeg: flex,
    desiredCorrectionCm: rawCorrectionCm,
    targetWrist
  }
}

/* -------------------------------------------------------------------------- */
/* clip 级 v2                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 解析 clip 的 Hybrid 策略。
 * @param {string} clipName
 * @param {'s2'|'hybrid'} mode
 * @param {'contact'|'source'} ikTarget
 * @param {Record<string,string>} [override]
 */
export function resolvePolicy(clipName, mode, ikTarget = 'contact', override) {
  if (mode === 's2') return 's2'
  const table = override ?? HYBRID_POLICY
  const policy = table[clipName] ?? 's2'
  if (policy === 'contact-ik' || policy === 'source-ik') {
    if (ikTarget === 'source') return 'source-ik'
    return 'contact-ik'
  }
  return policy
}

/** 汇总逐帧指标（max/mean/min/p95；与 B 的口径一致）。 */
export function summarizeFrameMetrics(frameMetrics) {
  if (!Array.isArray(frameMetrics) || frameMetrics.length === 0) return null
  const keys = Object.keys(frameMetrics[0].sides.Left)
  const out = { frames: frameMetrics.length, sides: {} }
  for (const side of SIDES) {
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
      if (typeof frameMetrics[0].sides[side][key] === 'boolean') {
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

/**
 * 对整段 clip 做 v2 重定向（S2-only 或 Hybrid）。
 *
 * @param {any} clip clip JSON（frames / bones[b].r / loop）
 * @param {object} config
 * @param {Record<string, number[]>} config.sourceRest
 * @param {Record<string, number[]>} config.targetRest
 * @param {'s2'|'hybrid'} config.mode
 * @param {number} config.k
 * @param {'contact'|'source'} [config.ikTarget='contact']
 * @param {Record<string,string>} [config.policy]
 * @param {object} [config.guards]
 * @returns {object}
 */
export function retargetClipV2(clip, config) {
  const frames = Number(clip?.frames)
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`clip.frames 非法：${clip?.frames}`)
  const { sourceRest, targetRest } = config
  const mode = config.mode === 'hybrid' ? 'hybrid' : 's2'
  const k = clamp01(Number.isFinite(config.k) ? config.k : 1)
  const ikTarget = config.ikTarget === 'source' ? 'source' : 'contact'
  const guards = { ...DEFAULT_GUARDS, ...(config.guards ?? {}) }
  const loop = clip?.loop === true
  const policy = resolvePolicy(config.clipName ?? '', mode, ikTarget, config.policy)
  const coefficients = deriveS2Coefficients(sourceRest, targetRest)
  const sourceTorsoM = coefficients.sourceTorsoM
  const targetTorsoM = coefficients.targetTorsoM

  // 解码
  const sourceTracks = {}
  for (const bone of ARM_TORSO_BONES) sourceTracks[bone] = decodeRotationTrack(clip?.bones?.[bone]?.r, frames)
  const original = {}
  for (const bone of V2_MODIFIED_BONES) original[bone] = sourceTracks[bone].slice()

  if (policy === 'exclude') {
    const tracks = Object.fromEntries(V2_MODIFIED_BONES.map((b) => [b, original[b].slice()]))
    for (const bone of V2_MODIFIED_BONES) tracks[bone] = enforceQuatContinuity(tracks[bone])
    return {
      tracks,
      coefficients,
      policy,
      excluded: true,
      frameMetrics: [],
      summary: null,
      trackStats: buildTrackStats(original, tracks, loop),
      hybrid: null
    }
  }

  // 逐帧基础数据 + S2
  const base = new Array(frames)
  for (let f = 0; f < frames; f += 1) {
    const rotations = {}
    for (const bone of ARM_TORSO_BONES) rotations[bone] = sourceTracks[bone][f]
    const sourcePose = forwardKinematics(sourceRest, rotations)
    const targetBefore = forwardKinematics(targetRest, rotations)
    const sourceFrame = computeTorsoFrame(sourcePose)
    const targetFrame = computeTorsoFrame(targetBefore)
    const s2 = applyS2Frame(rotations, k)
    base[f] = { rotations, sourcePose, targetBefore, sourceFrame, targetFrame, s2 }
  }

  const useIk = mode === 'hybrid' && (policy === 'contact-ik' || policy === 'source-ik')
  let corrections = null
  let candidates = null
  if (useIk) {
    // 原始改正向量（每帧每侧）
    const raw = { Left: new Array(frames).fill(null), Right: new Array(frames).fill(null) }
    const targetS2 = new Array(frames)
    for (let f = 0; f < frames; f += 1) {
      const b = base[f]
      const rotationsS2 = { ...b.rotations, ...b.s2.rotations }
      const poseS2 = forwardKinematics(targetRest, rotationsS2)
      targetS2[f] = poseS2
      for (const side of SIDES) {
        const hand = `${side}Hand`
        const handS2 = poseS2.positions[hand]
        let desired = b.targetBefore.positions[hand]
        if (ikTarget === 'source') {
          const sourceNorm = frameLocal(b.sourceFrame, b.sourcePose.positions[hand]).map((v) => v / sourceTorsoM)
          desired = frameWorld(b.targetFrame, sourceNorm.map((v) => v * targetTorsoM))
        }
        const corr = vSub(desired, handS2)
        const len = vLen(corr)
        raw[side][f] = len > guards.maxHandCorrectionCm / 100
          ? vScale(vNorm(corr), guards.maxHandCorrectionCm / 100)
          : corr
      }
    }
    corrections = {
      Left: smoothVectors(raw.Left, loop, guards.correctionSmoothPasses),
      Right: smoothVectors(raw.Right, loop, guards.correctionSmoothPasses)
    }
    candidates = { Left: new Array(frames).fill(null), Right: new Array(frames).fill(null) }
    for (let f = 0; f < frames; f += 1) {
      for (const side of SIDES) {
        const corr = corrections[side][f]
        if (!corr) continue
        candidates[side][f] = solveHybridCandidate({
          side,
          targetRest,
          targetBefore: base[f].targetBefore,
          targetS2: targetS2[f],
          sourcePose: base[f].sourcePose,
          sourceFrame: base[f].sourceFrame,
          targetFrame: base[f].targetFrame,
          coefficients,
          ikTarget,
          correction: corr,
          guards
        })
      }
    }
  }

  // 权重（accepted = 1，fallback = 0），再做 5-tap 平滑
  const rawWeights = { Left: new Array(frames).fill(0), Right: new Array(frames).fill(0) }
  if (useIk) {
    for (const side of SIDES) {
      for (let f = 0; f < frames; f += 1) rawWeights[side][f] = candidates[side][f]?.accepted ? 1 : 0
    }
  }

  const buildFinal = (weightPasses) => {
    const weights = {
      Left: smoothWeights(rawWeights.Left, loop, useIk ? weightPasses : 0),
      Right: smoothWeights(rawWeights.Right, loop, useIk ? weightPasses : 0)
    }
    const tracks = {}
    for (const bone of V2_MODIFIED_BONES) tracks[bone] = new Array(frames)
    const hybridInfo = new Array(frames)
    for (let f = 0; f < frames; f += 1) {
      const info = { frame: f, sides: {} }
      for (const side of SIDES) {
        const shoulder = `${side}Shoulder`
        const upperArm = `${side}UpperArm`
        const lowerArm = `${side}LowerArm`
        const qS2 = base[f].s2.rotations[shoulder]
        const qA2 = base[f].s2.rotations[upperArm]
        const qL0 = original[lowerArm][f]
        tracks[shoulder][f] = qS2
        let qA = qA2
        let qL = qL0
        let weight = 0
        const cand = useIk ? candidates[side][f] : null
        let finalInfo = { accepted: false, weight: 0, correctionCm: 0, upperArmDirChangeDeg: 0, elbowFlexDeg: 0, fallback: !useIk, reason: cand?.reason ?? (useIk ? 'no-candidate' : null) }
        if (useIk && cand?.accepted && weights[side][f] > 1e-6) {
          weight = clamp01(weights[side][f])
          const safe = blendWeightSafe({ targetRest, base: base[f], cand, weight, side, guards })
          weight = safe.weight
          qA = safe.qUpperArm
          qL = safe.qLowerArm
          finalInfo = {
            accepted: weight > 1e-6,
            weight,
            correctionCm: safe.correctionCm,
            upperArmDirChangeDeg: safe.upperArmDirChangeDeg,
            elbowFlexDeg: safe.elbowFlexDeg,
            fallback: weight <= 1e-6,
            reason: weight <= 1e-6 ? 'blend-guard' : null
          }
        }
        tracks[upperArm][f] = qA
        tracks[lowerArm][f] = qL
        info.sides[side] = finalInfo
      }
      hybridInfo[f] = info
    }
    for (const bone of V2_MODIFIED_BONES) {
      for (let f = 0; f < frames; f += 1) {
        if (!Array.isArray(tracks[bone][f])) throw new Error(`内部错误：${bone} 帧 ${f} 无输出四元数`)
      }
      tracks[bone] = enforceQuatContinuity(tracks[bone])
    }
    return { tracks, weights, hybridInfo }
  }

  // 帧跳闸门：若 hybrid 让局部轨道相邻帧角超过 6°（且原 clip 未超），加强平滑
  const beforeStats = buildTrackStats(original, original, loop)
  const jumpTarget = Math.max(6, beforeStats.frameJumpMaxDeg + 0.01)
  let final = null
  for (const passes of [guards.weightSmoothPasses, guards.weightSmoothPasses + 2, guards.weightSmoothPasses + 4]) {
    final = buildFinal(passes)
    const stats = buildTrackStats(original, final.tracks, loop)
    if (!useIk || stats.frameJumpMaxDeg <= jumpTarget + 0.05) break
  }

  const frameMetrics = computeFrameMetrics({
    frames,
    sourceRest,
    targetRest,
    sourceTracks,
    beforeTracks: original,
    afterTracks: final.tracks,
    sourceTorsoM,
    targetTorsoM,
    hybridInfo: final.hybridInfo
  })

  const trackStats = buildTrackStats(original, final.tracks, loop)
  if (useIk) attachHybridStats(trackStats, final.hybridInfo)

  return {
    tracks: final.tracks,
    coefficients,
    policy,
    excluded: false,
    frameMetrics,
    summary: summarizeFrameMetrics(frameMetrics),
    trackStats,
    hybrid: useIk
      ? {
          ikTarget,
          weights: final.weights,
          acceptedFrames: SIDES.reduce((n, s) => n + final.hybridInfo.filter((row) => row.sides[s]?.accepted).length, 0),
          rejectedFrames: SIDES.reduce((n, s) => n + final.hybridInfo.filter((row) => !row.sides[s]?.accepted).length, 0),
          acceptedSideFrames: final.hybridInfo.reduce((n, row) => n + SIDES.filter((s) => row.sides[s]?.accepted).length, 0),
          rejectedSideFrames: final.hybridInfo.reduce((n, row) => n + SIDES.filter((s) => !row.sides[s]?.accepted).length, 0),
          candidateFrames: frames * SIDES.length,
          frameInfo: final.hybridInfo
        }
      : null
  }
}

/** 检查 final 混合权重是否满足 guards；不满足则二分降权。 */
function blendWeightSafe({ targetRest, base, cand, weight, side, guards }) {
  const shoulder = `${side}Shoulder`
  const upperArm = `${side}UpperArm`
  const lowerArm = `${side}LowerArm`
  const hand = `${side}Hand`
  const qS = base.s2.rotations[shoulder]
  const qA2 = base.s2.rotations[upperArm]
  const qL0 = base.rotations[lowerArm]
  const socket = base.targetBefore.positions[upperArm]
  const handS2 = (() => {
    const poseS2 = forwardKinematics(targetRest, { ...base.rotations, ...base.s2.rotations })
    return poseS2.positions[hand]
  })()

  const evaluate = (w) => {
    const qA = quatSlerp(qA2, cand.qUpperArm, w)
    const qL = quatSlerp(qL0, cand.qLowerArm, w)
    const pose = forwardKinematics(targetRest, {
      ...base.rotations,
      [shoulder]: qS,
      [upperArm]: qA,
      [lowerArm]: qL
    })
    const elbow = pose.positions[lowerArm]
    const wrist = pose.positions[hand]
    const correctionCm = vDist(wrist, handS2) * 100
    const upperArmDirChangeDeg = vecAngleDeg(
      vSub(base.targetBefore.positions[lowerArm], socket),
      vSub(elbow, socket)
    )
    const elbowFlexDeg = jointFlexDeg(socket, elbow, wrist)
    const ok = correctionCm <= guards.maxHandCorrectionCm + 0.05 &&
      upperArmDirChangeDeg <= guards.maxUpperArmDirChangeDeg + 0.05 &&
      elbowFlexDeg >= guards.minElbowFlexDeg - 0.5 &&
      elbowFlexDeg <= guards.maxElbowFlexDeg + 0.5
    return { ok, qA, qL, correctionCm, upperArmDirChangeDeg, elbowFlexDeg }
  }

  let result = evaluate(weight)
  if (result.ok || weight <= 1e-6) {
    return { ...result, qUpperArm: result.qA, qLowerArm: result.qL, weight }
  }
  let lo = 0
  let hi = weight
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2
    const r = evaluate(mid)
    if (r.ok) lo = mid
    else hi = mid
  }
  result = evaluate(lo)
  return { ...result, qUpperArm: result.qA, qLowerArm: result.qL, weight: lo }
}

/* -------------------------------------------------------------------------- */
/* 指标                                                                        */
/* -------------------------------------------------------------------------- */

/** 汇总 before/after 的轨道统计。导出供 v3 复用（行为与 v2 完全一致）。 */
export function buildTrackStats(beforeTracks, afterTracks, loop) {
  const perBone = {}
  let unitMax = 0
  let frameJumpMaxDeg = 0
  let frameJumpBeforeMaxDeg = 0
  let seamBeforeMaxDeg = 0
  let seamAfterMaxDeg = 0
  for (const bone of V2_MODIFIED_BONES) {
    const after = trackStats(afterTracks[bone], loop)
    const before = trackStats(beforeTracks[bone], loop)
    perBone[bone] = { after, before }
    unitMax = Math.max(unitMax, after.unitMax)
    frameJumpMaxDeg = Math.max(frameJumpMaxDeg, after.jumpMax)
    frameJumpBeforeMaxDeg = Math.max(frameJumpBeforeMaxDeg, before.jumpMax)
    if (after.seam !== null) seamAfterMaxDeg = Math.max(seamAfterMaxDeg, after.seam)
    if (before.seam !== null) seamBeforeMaxDeg = Math.max(seamBeforeMaxDeg, before.seam)
  }
  return {
    unitMaxError: unitMax,
    frameJumpMaxDeg,
    frameJumpBeforeMaxDeg,
    loopSeamBeforeMaxDeg: loop ? seamBeforeMaxDeg : null,
    loopSeamAfterMaxDeg: loop ? seamAfterMaxDeg : null,
    perBone
  }
}

export function attachHybridStats(trackStats, hybridInfo) {
  let accepted = 0
  let rejected = 0
  let maxCorrectionCm = 0
  let maxUpperArmChangeDeg = 0
  let minElbow = Infinity
  let maxElbow = -Infinity
  for (const row of hybridInfo ?? []) {
    for (const side of SIDES) {
      const info = row.sides[side]
      if (!info) continue
      if (!info.accepted) { rejected += 1; continue }
      accepted += 1
      maxCorrectionCm = Math.max(maxCorrectionCm, info.correctionCm)
      maxUpperArmChangeDeg = Math.max(maxUpperArmChangeDeg, info.upperArmDirChangeDeg)
      minElbow = Math.min(minElbow, info.elbowFlexDeg)
      maxElbow = Math.max(maxElbow, info.elbowFlexDeg)
    }
  }
  trackStats.hybrid = {
    acceptedSideFrames: accepted,
    rejectedSideFrames: rejected,
    maxCorrectionCm,
    maxUpperArmChangeDeg,
    elbowFlexRangeDeg: [minElbow === Infinity ? null : minElbow, maxElbow === -Infinity ? null : maxElbow]
  }
}

/**
 * 逐帧指标（S2 / Hybrid 共用）。
 *
 * 主要口径：
 * - socketLiftCm：目标 torso 系里肩点相对修正前抬升；
 * - handShiftCm：手世界位置变化（S2 下恒等于 socket 平移）；
 * - armWorldDeltaChangeDeg：upperArm/lowerArm/hand world 朝向变化；
 * - aPoseBodyHorizontalChangeDeg：upperArm 与目标躯干水平面的夹角变化（idle 闸门）；
 * - socketNormHeightSource/Before/After：肩点相对 hips 的高度 / 躯干长；
 * - clavicleElevation*：锁骨在 torso 系里的仰角（视觉肩线）；
 * - shoulderSlope*：drop / 肩点半宽（视觉肩线斜率）。
 */
export function computeFrameMetrics(p) {
  const {
    frames, sourceRest, targetRest, sourceTracks,
    sourceTorsoM, targetTorsoM, hybridInfo, extraSides
  } = p
  // 注意：beforeTracks/afterTracks 都只包含被改写的骨；未改写骨从 sourceTracks 取。
  const beforeTracks = p.beforeTracks
  const afterTracks = p.afterTracks
  const sourceRestFrame = computeTorsoFrame({ positions: sourceRest })
  const targetRestFrame = computeTorsoFrame({ positions: targetRest })
  const rows = new Array(frames)
  for (let f = 0; f < frames; f += 1) {
    const rotBefore = {}
    for (const bone of ARM_TORSO_BONES) rotBefore[bone] = sourceTracks[bone][f]
    const rotAfter = { ...rotBefore }
    for (const bone of V2_MODIFIED_BONES) rotAfter[bone] = afterTracks[bone][f]
    const sourcePose = forwardKinematics(sourceRest, rotBefore)
    const beforePose = forwardKinematics(targetRest, rotBefore)
    const afterPose = forwardKinematics(targetRest, rotAfter)
    const sourceFrame = computeTorsoFrame(sourcePose)
    const targetFrame = computeTorsoFrame(beforePose)
    const sides = {}
    for (const side of SIDES) {
      const shoulder = `${side}Shoulder`
      const upperArm = `${side}UpperArm`
      const lowerArm = `${side}LowerArm`
      const hand = `${side}Hand`
      const socketBefore = beforePose.positions[upperArm]
      const socketAfter = afterPose.positions[upperArm]
      const elbowBefore = beforePose.positions[lowerArm]
      const elbowAfter = afterPose.positions[lowerArm]
      const handBefore = beforePose.positions[hand]
      const handAfter = afterPose.positions[hand]

      const socketBeforeLocal = frameLocal(targetFrame, socketBefore)
      const socketAfterLocal = frameLocal(targetFrame, socketAfter)
      const chestLocal = frameLocal(targetFrame, beforePose.positions.Chest)
      const socketLiftCm = (socketAfterLocal[1] - socketBeforeLocal[1]) * 100
      const socketShiftCm = vDist(socketAfter, socketBefore) * 100
      const socketShiftVecCm = vScale(vSub(socketAfter, socketBefore), 100)
      const handShiftCm = vDist(handAfter, handBefore) * 100
      const handShiftVecCm = vScale(vSub(handAfter, handBefore), 100)

      const shoulderLocalBefore = quatAngleDeg(frameQuat(rotBefore, shoulder))
      const shoulderLocalAfter = quatAngleDeg(frameQuat(rotAfter, shoulder))
      const upperArmLocalBefore = quatAngleDeg(frameQuat(rotBefore, upperArm))
      const upperArmLocalAfter = quatAngleDeg(frameQuat(rotAfter, upperArm))

      const upperArmWorldDeltaChangeDeg = quatDeltaDeg(beforePose.deltas[upperArm], afterPose.deltas[upperArm])
      const lowerArmWorldDeltaChangeDeg = quatDeltaDeg(beforePose.deltas[lowerArm], afterPose.deltas[lowerArm])
      const handWorldDeltaChangeDeg = quatDeltaDeg(beforePose.deltas[hand], afterPose.deltas[hand])

      const dirBefore = vNorm(vSub(elbowBefore, socketBefore))
      const dirAfter = vNorm(vSub(elbowAfter, socketAfter))
      const upperArmDirChangeDeg = vecAngleDeg(dirBefore, dirAfter)
      const horizBefore = horizontalAngleDeg(dirBefore, targetFrame.up)
      const horizAfter = horizontalAngleDeg(dirAfter, targetFrame.up)
      const worldHorizBefore = horizontalAngleDeg(dirBefore, [0, 1, 0])
      const worldHorizAfter = horizontalAngleDeg(dirAfter, [0, 1, 0])

      const elbowFlexBefore = jointFlexDeg(socketBefore, elbowBefore, handBefore)
      const elbowFlexAfter = jointFlexDeg(socketAfter, elbowAfter, handAfter)

      // 源归一化：肩点相对 hips 的高度 / 躯干长
      const sourceUpperLocal = frameLocal(sourceFrame, sourcePose.positions[upperArm])
      const beforeUpperLocal = frameLocal(targetFrame, socketBefore)
      const afterUpperLocal = frameLocal(targetFrame, socketAfter)
      const socketNormHeightSource = sourceUpperLocal[1] / sourceTorsoM
      const socketNormHeightBefore = beforeUpperLocal[1] / targetTorsoM
      const socketNormHeightAfter = afterUpperLocal[1] / targetTorsoM
      const normHeightErrBeforeCm = (socketNormHeightBefore - socketNormHeightSource) * targetTorsoM * 100
      const normHeightErrAfterCm = (socketNormHeightAfter - socketNormHeightSource) * targetTorsoM * 100

      // 肩点相对 chest 的高度（cm）
      const sourceChestLocal = frameLocal(sourceFrame, sourcePose.positions.Chest)
      const socketHeightAboveChestSourceCm = (sourceUpperLocal[1] - sourceChestLocal[1]) * 100
      const socketHeightAboveChestBeforeCm = (beforeUpperLocal[1] - chestLocal[1]) * 100
      const socketHeightAboveChestAfterCm = (afterUpperLocal[1] - chestLocal[1]) * 100

      // ---- S2 的核心口径：动画造成的肩点「下坠量」按躯干长归一化后与源一致 ----
      const sourceRestUpperLocal = frameLocal(sourceRestFrame, sourceRest[upperArm])
      const sourceRestChestLocal = frameLocal(sourceRestFrame, sourceRest.Chest)
      const targetRestUpperLocal = frameLocal(targetRestFrame, targetRest[upperArm])
      const targetRestChestLocal = frameLocal(targetRestFrame, targetRest.Chest)
      const sourceRestHeight = sourceRestUpperLocal[1] - sourceRestChestLocal[1]
      const targetRestHeight = targetRestUpperLocal[1] - targetRestChestLocal[1]
      const sourceDropCm = ((sourceUpperLocal[1] - sourceChestLocal[1]) - sourceRestHeight) * 100
      const beforeDropCm = ((beforeUpperLocal[1] - chestLocal[1]) - targetRestHeight) * 100
      const afterDropCm = ((afterUpperLocal[1] - chestLocal[1]) - targetRestHeight) * 100
      const socketDropNormSource = sourceDropCm / (sourceTorsoM * 100)
      const socketDropNormBefore = beforeDropCm / (targetTorsoM * 100)
      const socketDropNormAfter = afterDropCm / (targetTorsoM * 100)
      const socketDropNormErrBeforeCm = Math.abs(socketDropNormBefore - socketDropNormSource) * targetTorsoM * 100
      const socketDropNormErrAfterCm = Math.abs(socketDropNormAfter - socketDropNormSource) * targetTorsoM * 100

      // 锁骨局部旋转造成的位移（在各自 rest torso 系里；纯 rest 几何，排除 chest 动画）
      const sourceClavRestLocal = vSub(
        frameLocal(sourceRestFrame, sourceRest[upperArm]),
        frameLocal(sourceRestFrame, sourceRest[shoulder])
      )
      const targetClavRestLocal = vSub(
        frameLocal(targetRestFrame, targetRest[upperArm]),
        frameLocal(targetRestFrame, targetRest[shoulder])
      )
      const qSBeforeLocal = frameQuat(rotBefore, shoulder)
      const qSAfterLocal = frameQuat(rotAfter, shoulder)
      const sourceDispLocal = vSub(quatRotateVec(qSBeforeLocal, sourceClavRestLocal), sourceClavRestLocal)
      const beforeDispLocal = vSub(quatRotateVec(qSBeforeLocal, targetClavRestLocal), targetClavRestLocal)
      const afterDispLocal = vSub(quatRotateVec(qSAfterLocal, targetClavRestLocal), targetClavRestLocal)
      const clavicleDispNormSource = vLen(sourceDispLocal) / sourceTorsoM
      const clavicleDispNormBefore = vLen(beforeDispLocal) / targetTorsoM
      const clavicleDispNormAfter = vLen(afterDispLocal) / targetTorsoM
      const clavicleDispNormErrBeforeCm = vLen(vSub(
        vScale(beforeDispLocal, 1 / targetTorsoM),
        vScale(sourceDispLocal, 1 / sourceTorsoM)
      )) * targetTorsoM * 100
      const clavicleDispNormErrAfterCm = vLen(vSub(
        vScale(afterDispLocal, 1 / targetTorsoM),
        vScale(sourceDispLocal, 1 / sourceTorsoM)
      )) * targetTorsoM * 100

      // 锁骨仰角（torso 系）
      const clavBefore = vSub(frameLocal(targetFrame, socketBefore), frameLocal(targetFrame, beforePose.positions[shoulder]))
      const clavAfter = vSub(frameLocal(targetFrame, socketAfter), frameLocal(targetFrame, afterPose.positions[shoulder]))
      const sourceClav = vSub(sourceUpperLocal, frameLocal(sourceFrame, sourcePose.positions[shoulder]))
      const elev = (v) => Math.atan2(v[1], Math.abs(v[0]) + EPS) * RAD2DEG
      const clavicleElevationSourceDeg = elev(sourceClav)
      const clavicleElevationBeforeDeg = elev(clavBefore)
      const clavicleElevationAfterDeg = elev(clavAfter)

      // 视觉肩线斜率 = drop / 肩点半宽（分母下限 2cm，避免躺姿 x→0 时爆炸）
      const slopeOf = (chestY, socketLocal) => {
        const drop = chestY - socketLocal[1]
        return drop / Math.max(0.02, Math.abs(socketLocal[0]))
      }
      const shoulderSlopeSource = slopeOf(sourceChestLocal[1], sourceUpperLocal)
      const shoulderSlopeBefore = slopeOf(chestLocal[1], beforeUpperLocal)
      const shoulderSlopeAfter = slopeOf(chestLocal[1], afterUpperLocal)

      // 与源归一化绝对期望的误差（B absolute 的口径，仅诊断）
      const sourceNorm = frameLocal(sourceFrame, sourcePose.positions[upperArm]).map((v) => v / sourceTorsoM)
      const expectedAbs = frameWorld(targetFrame, sourceNorm.map((v) => v * targetTorsoM))
      const socketErrorVsSourceAbsCm = vDist(socketAfter, expectedAbs) * 100

      const guard = hybridInfo?.[f]?.sides?.[side] ?? null
      const extra = extraSides?.[f]?.sides?.[side] ?? null
      sides[side] = {
        ...(extra ?? {}),
        socketLiftCm,
        socketShiftCm,
        socketShiftXcm: socketShiftVecCm[0],
        socketShiftYcm: socketShiftVecCm[1],
        socketShiftZcm: socketShiftVecCm[2],
        socketErrorVsSourceAbsCm,
        handShiftCm,
        handShiftXcm: handShiftVecCm[0],
        handShiftYcm: handShiftVecCm[1],
        handShiftZcm: handShiftVecCm[2],
        shoulderLocalDegBefore: shoulderLocalBefore,
        shoulderLocalDegAfter: shoulderLocalAfter,
        upperArmLocalDegBefore: upperArmLocalBefore,
        upperArmLocalDegAfter: upperArmLocalAfter,
        upperArmWorldDeltaChangeDeg,
        lowerArmWorldDeltaChangeDeg,
        handWorldDeltaChangeDeg,
        upperArmDirChangeDeg,
        aPoseBodyHorizontalBeforeDeg: horizBefore,
        aPoseBodyHorizontalAfterDeg: horizAfter,
        aPoseBodyHorizontalChangeDeg: Math.abs(horizAfter - horizBefore),
        aPoseWorldHorizontalBeforeDeg: worldHorizBefore,
        aPoseWorldHorizontalAfterDeg: worldHorizAfter,
        aPoseWorldHorizontalChangeDeg: Math.abs(worldHorizAfter - worldHorizBefore),
        elbowFlexBeforeDeg: elbowFlexBefore,
        elbowFlexAfterDeg: elbowFlexAfter,
        socketNormHeightSource,
        socketNormHeightBefore,
        socketNormHeightAfter,
        normHeightErrBeforeCm,
        normHeightErrAfterCm,
        socketHeightAboveChestSourceCm,
        socketHeightAboveChestBeforeCm,
        socketHeightAboveChestAfterCm,
        socketDropNormSource,
        socketDropNormBefore,
        socketDropNormAfter,
        socketDropNormErrBeforeCm,
        socketDropNormErrAfterCm,
        clavicleDispNormSource,
        clavicleDispNormBefore,
        clavicleDispNormAfter,
        clavicleDispNormErrBeforeCm,
        clavicleDispNormErrAfterCm,
        clavicleElevationSourceDeg,
        clavicleElevationBeforeDeg,
        clavicleElevationAfterDeg,
        clavicleElevationDiffSourceBeforeDeg: Math.abs(clavicleElevationBeforeDeg - clavicleElevationSourceDeg),
        clavicleElevationDiffSourceAfterDeg: Math.abs(clavicleElevationAfterDeg - clavicleElevationSourceDeg),
        shoulderSlopeSource,
        shoulderSlopeBefore,
        shoulderSlopeAfter,
        shoulderSlopeDiffSourceBefore: Math.abs(shoulderSlopeBefore - shoulderSlopeSource),
        shoulderSlopeDiffSourceAfter: Math.abs(shoulderSlopeAfter - shoulderSlopeSource),
        hybridWeight: guard?.weight ?? 0,
        hybridAccepted: guard?.accepted ?? false,
        hybridCorrectionCm: guard?.correctionCm ?? 0
      }
    }
    rows[f] = { frame: f, sides }
  }
  return rows
}

/** 四元数夹角（度；q/-q 等价）。 */
function quatDeltaDeg(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  return quatAngleDeg(quatMultiply(quatInvert(a), b))
}
