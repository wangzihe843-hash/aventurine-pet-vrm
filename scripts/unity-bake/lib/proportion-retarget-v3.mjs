/**
 * 比例感知肩/臂重定向 v3 —— S2-absolute（绝对肩高）+ 受限手 IK（hybrid-absolute）
 *
 * 背景：v2（S2-only）只修「动画造成的肩点下坠」，不修男女 rest 肩高差，归一化肩高
 * 仍比源低 3–4cm。v3 把 upperArm 关节点逐帧 aim 到「源 canonical posed 位置 / 源 torso 长
 * × 目标 torso 长」的绝对目标；锁骨长度固定，目标不可达时方向最优；上臂局部旋转补偿
 * 使 upperArm/lowerArm/hand 的 **world 朝向逐帧不变**（不碰手、不碰手指/手势）。
 *
 * 公式（每侧、每帧）：
 *   A_abs = F_t( (F_s(p_s^UA) / H_s) · H_t )                  // 源 posed 归一化 × 目标 torso 长
 *   P_t   = lerp_local_before→abs(A_abs; f)                   // f = --lift-fraction
 *   d     = normalize(P_t - p^Shoulder)                       // 目标锁骨方向
 *   S'    = S · quatFromUnitVectors(r, S⁻¹ · F_p⁻¹(d))        // 保留源 twist；f=0 时 S'=S
 *   socket= p^Shoulder + (F_p · S') · (p_rest^UA - p_rest^Shoulder)
 *   A'    = S'⁻¹ · S · A                                      // 手臂 world 朝向不变
 *   L'    = L, Hand/手指不动
 * 可选 cap：|S'| ≤ --shoulder-cap（默认 45°；cap 触发帧会计数）。
 *
 * hybrid-absolute 在 S2-absolute 之后加受限手 IK：
 *   目标 = 原 clip 在男体上的手世界位置（保接触/手势位），不是源绝对手位；
 *   correction 先按 --partial-ik 缩放、≤ --max-hand-correction（默认 4cm），再做 5-tap
 *   环形平滑；guards：上臂体相对方向变化 ≤ --max-upperarm-change（默认 4°）、reach 98%、
 *   肘屈 [15,150]；逐帧失败回退 S2-absolute；权重同样 5-tap 平滑。
 *
 * 纯逻辑：不 import three / DOM / node:*；四元数 `[x,y,z,w]`（Hamilton，a·b = 先 b 后 a）。
 * 只供 dev-only bake CLI 与 tests 使用；不改产品运行时。
 */

import {
  ARM_TORSO_BONES,
  capQuatAngleFromIdentity,
  computeTorsoFrame,
  decodeRotationTrack,
  effectiveParents,
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
import {
  V2_MODIFIED_BONES,
  attachHybridStats,
  buildTrackStats,
  computeFrameMetrics,
  deriveS2Coefficients,
  smoothVectors,
  smoothWeights,
  summarizeFrameMetrics
} from './proportion-retarget-v2.mjs'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const EPS = 1e-9
const SIDES = Object.freeze(['Left', 'Right'])

/** v3 改写的 6 根骨与 v2 相同；lowerArm 只在 hybrid 手 IK 时改写。 */
export const V3_MODIFIED_BONES = V2_MODIFIED_BONES

/** v3 白名单 + 默认策略。 */
export const V3_CLIP_POLICY = Object.freeze({
  idle: 'absolute', idle2: 'absolute', idle3: 'absolute', idle4: 'absolute',
  idle5: 'absolute', idle6: 'absolute', idle7: 'absolute',
  happy: 'absolute', laughing: 'absolute', shyPoint: 'absolute',
  pose1: 'absolute', pose2: 'absolute', pose3: 'absolute',
  sit1: 'absolute-hybrid', sit2: 'absolute-hybrid', suwari3: 'absolute-hybrid',
  sitWindow: 'absolute-hybrid',
  windowLay8: 'absolute-hybrid', windowLay9: 'absolute-hybrid', windowLay10: 'absolute-hybrid',
  hideLeft: 'absolute-hybrid', hideOnce: 'absolute-hybrid',
  // sleep 只作对照：s2-absolute 跑出来但不建议上线；hybrid 模式下也只做 absolute。
  sleep: 'absolute'
})

/** v3 默认 guards（task 口径：上臂体相对 ≤4°、手修正 ≤4cm）。 */
export const V3_DEFAULT_GUARDS = Object.freeze({
  maxUpperArmDirChangeDeg: 4,
  maxHandCorrectionCm: 4,
  minElbowFlexDeg: 15,
  maxElbowFlexDeg: 150,
  reachRatio: 0.98,
  correctionSmoothPasses: 2,
  weightSmoothPasses: 2
})

export const V3_DEFAULTS = Object.freeze({
  liftFraction: 1,
  maxShoulderLocalDeg: 45,
  partialIk: 1
})

/* -------------------------------------------------------------------------- */
/* 小工具                                                                       */
/* -------------------------------------------------------------------------- */

function clamp01(v) { return Math.max(0, Math.min(1, v)) }

function frameQuat(rotations, bone) {
  const q = rotations?.[bone]
  if (!Array.isArray(q) || q.length !== 4) return [0, 0, 0, 1]
  return quatNormalize(q)
}

function vecAngleDeg(a, b) {
  const na = vNorm(a)
  const nb = vNorm(b)
  if (vLen(na) < EPS || vLen(nb) < EPS) return 0
  return Math.acos(Math.max(-1, Math.min(1, vDot(na, nb)))) * RAD2DEG
}

/** 世界方向 → 目标 torso 系方向（单位）。 */
function bodyDirection(frame, dir) {
  return vNorm([vDot(dir, frame.left), vDot(dir, frame.up), vDot(dir, frame.forward)])
}

function jointFlexDeg(root, mid, end) {
  const u = vNorm(vSub(mid, root))
  const f = vNorm(vSub(end, mid))
  return Math.acos(Math.max(-1, Math.min(1, vDot(u, f)))) * RAD2DEG
}

/**
 * v3 的 clip 策略解析：
 *   - 'exclude' 原样；
 *   - mode='absolute' 时所有非 exclude clip 都只做 S2-absolute（接触类也不做手 IK）；
 *   - mode='hybrid' 时用策略表（absolute / absolute-hybrid）。
 */
export function resolveV3Policy(clipName, mode, override) {
  const table = override ?? V3_CLIP_POLICY
  const policy = table[clipName] ?? 'exclude'
  if (policy === 'exclude') return 'exclude'
  if (mode === 'absolute') return 'absolute'
  return policy === 'absolute-hybrid' ? 'absolute-hybrid' : 'absolute'
}

/* -------------------------------------------------------------------------- */
/* 绝对肩高 aim                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 源 canonical posed upperArm 关节点的「躯干归一化位置 × 目标 torso 长」绝对目标（世界）。
 * @param {object} p
 * @param {string} p.side
 * @param {object} p.sourcePose
 * @param {object} p.sourceFrame
 * @param {object} p.targetFrame
 * @param {number} p.sourceTorsoM
 * @param {number} p.targetTorsoM
 * @returns {number[]}
 */
export function absoluteTargetForSide(p) {
  const { side, sourcePose, sourceFrame, targetFrame, sourceTorsoM, targetTorsoM } = p
  const upperArm = `${side}UpperArm`
  const sourceLocal = frameLocal(sourceFrame, sourcePose.positions[upperArm])
  const normalized = vScale(sourceLocal, 1 / Math.max(EPS, sourceTorsoM))
  return frameWorld(targetFrame, vScale(normalized, targetTorsoM))
}

/**
 * 单侧 S2-absolute：aim 锁骨 + 上臂 world 朝向补偿。
 *
 * @param {object} p
 * @param {string} p.side
 * @param {Record<string,number[]>} p.rotations 本帧 normalized 旋转（Unity 骨名）
 * @param {Record<string,number[]>} p.targetRest 目标 rest（米）
 * @param {object} p.targetBefore 原 clip 在目标上的 FK
 * @param {object} p.targetFrame 原 clip 的目标 torso 系
 * @param {number[]} p.absoluteTargetWorld 绝对目标（世界）
 * @param {number} [p.liftFraction=1] 0..1，对「原肩点 → 绝对目标」的 torso 系位移插值
 * @param {number} [p.maxShoulderLocalDeg=45] 锁骨局部角 cap；≤0 = 关闭
 * @returns {object}
 */
export function solveAbsoluteSide(p) {
  const {
    side, rotations, targetRest, targetBefore, targetFrame,
    absoluteTargetWorld, liftFraction = 1, maxShoulderLocalDeg = 45
  } = p
  const shoulder = `${side}Shoulder`
  const upperArm = `${side}UpperArm`
  const lowerArm = `${side}LowerArm`
  const qS = frameQuat(rotations, shoulder)
  const qA = frameQuat(rotations, upperArm)
  const qL = frameQuat(rotations, lowerArm)

  const restOffset = vSub(targetRest[upperArm], targetRest[shoulder])
  const clavicleLength = vLen(restOffset)
  const restDir = vNorm(restOffset)
  const shoulderRoot = targetBefore.positions[shoulder]
  const beforeSocket = targetBefore.positions[upperArm]
  const beforeLocal = frameLocal(targetFrame, beforeSocket)
  const absoluteLocal = frameLocal(targetFrame, absoluteTargetWorld)
  const ratio = clamp01(Number.isFinite(liftFraction) ? liftFraction : 1)
  const targetLocal = vAdd(beforeLocal, vScale(vSub(absoluteLocal, beforeLocal), ratio))
  const interpolatedTargetWorld = frameWorld(targetFrame, targetLocal)

  const parent = effectiveParents(targetRest)[shoulder] ?? 'Chest'
  const parentDelta = targetBefore.deltas[parent] ?? targetBefore.deltas.Chest
  const parentInv = quatInvert(parentDelta)
  const toTarget = vSub(interpolatedTargetWorld, shoulderRoot)
  let desiredLocalDir = vNorm(quatRotateVec(parentInv, toTarget))
  if (vLen(desiredLocalDir) < 0.5) {
    // 目标与肩根重合：回退到原锁骨方向（尽量不改变肩姿）。
    desiredLocalDir = vNorm(quatRotateVec(parentInv, vSub(beforeSocket, shoulderRoot)))
  }
  if (vLen(desiredLocalDir) < 0.5) desiredLocalDir = restDir

  // 保 twist 的 aim：S' = S · align(r, S⁻¹·d)。目标=原方向时 S'=S（lift-fraction=0 恒等）。
  const localRestTarget = quatRotateVec(quatInvert(qS), desiredLocalDir)
  const qAlign = quatFromUnitVectors(restDir, localRestTarget)
  let qShoulder = quatNormalize(quatMultiply(qS, qAlign))
  const cap = capQuatAngleFromIdentity(qShoulder, maxShoulderLocalDeg)
  const capHit = cap.capped
  qShoulder = cap.quat

  const deltaShoulder = quatNormalize(quatMultiply(parentDelta, qShoulder))
  const socket = vAdd(shoulderRoot, quatRotateVec(deltaShoulder, restOffset))
  // 上臂局部补偿：world DUpperArm' = parentDelta·S'·A' 与 DUpperArm = parentDelta·S·A 相等。
  const qUpperArm = quatNormalize(quatMultiply(quatInvert(qShoulder), quatMultiply(qS, qA)))

  const socketLocal = frameLocal(targetFrame, socket)
  return {
    qShoulder,
    qUpperArm,
    qLowerArm: qL,
    shoulderRoot,
    socket,
    restDir,
    clavicleLength,
    parentDelta,
    desiredLocalDir,
    absoluteTargetWorld,
    interpolatedTargetWorld,
    absoluteTargetLocal: absoluteLocal,
    beforeLocal,
    interpolatedTargetLocal: targetLocal,
    socketLocal,
    shoulderLocalBeforeDeg: quatAngleDeg(qS),
    shoulderLocalAfterDeg: quatAngleDeg(qShoulder),
    shoulderAimAddedDeg: quatAngleDeg(quatMultiply(quatInvert(qS), qShoulder)),
    capHit,
    absoluteTargetLiftCm: (absoluteLocal[1] - beforeLocal[1]) * 100,
    interpolatedTargetLiftCm: (targetLocal[1] - beforeLocal[1]) * 100,
    actualSocketLiftCm: (socketLocal[1] - beforeLocal[1]) * 100,
    socketErrorVsAbsoluteTargetCm: vDist(socket, absoluteTargetWorld) * 100,
    socketErrorVsInterpolatedTargetCm: vDist(socket, interpolatedTargetWorld) * 100
  }
}

/**
 * 单帧 S2-absolute（双侧便捷入口；内部按需 FK）。
 * @param {object} input
 * @param {Record<string,number[]>} input.rotations
 * @param {Record<string,number[]>} input.sourceRest
 * @param {Record<string,number[]>} input.targetRest
 * @param {number} [input.liftFraction=1]
 * @param {number} [input.maxShoulderLocalDeg=45]
 * @returns {{rotations: Record<string,[number,number,number,number]>, sides: object}}
 */
export function applyAbsoluteFrame(input) {
  const { rotations, sourceRest, targetRest, liftFraction = 1, maxShoulderLocalDeg = 45 } = input
  const coefficients = deriveS2Coefficients(sourceRest, targetRest)
  const sourcePose = forwardKinematics(sourceRest, rotations)
  const targetBefore = forwardKinematics(targetRest, rotations)
  const sourceFrame = computeTorsoFrame(sourcePose)
  const targetFrame = computeTorsoFrame(targetBefore)
  const out = {}
  const sides = {}
  for (const side of SIDES) {
    const absoluteTargetWorld = absoluteTargetForSide({
      side, sourcePose, sourceFrame, targetFrame,
      sourceTorsoM: coefficients.sourceTorsoM, targetTorsoM: coefficients.targetTorsoM
    })
    const solved = solveAbsoluteSide({
      side, rotations, targetRest, targetBefore, targetFrame,
      absoluteTargetWorld, liftFraction, maxShoulderLocalDeg
    })
    out[`${side}Shoulder`] = solved.qShoulder
    out[`${side}UpperArm`] = solved.qUpperArm
    out[`${side}LowerArm`] = solved.qLowerArm
    sides[side] = solved
  }
  return { rotations: out, sides }
}

/* -------------------------------------------------------------------------- */
/* hybrid-absolute 受限手 IK                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 单侧 hybrid-absolute 手 IK 候选。
 *
 * correction 是「原 clip 手位 − S2-absolute 手位」的已平滑/已限制修正向量（米）。
 *
 * @param {object} p
 * @param {string} p.side
 * @param {Record<string,number[]>} p.targetRest
 * @param {object} p.poseAbs S2-absolute 后的目标 FK
 * @param {object} p.targetFrame 目标 torso 系
 * @param {number[]} p.correction 已平滑的修正向量（米）
 * @param {object} p.guards
 * @param {number} [p.desiredCorrectionCm] 诊断用：平滑前期望修正（cm）
 * @returns {object}
 */
export function solveAbsoluteHybridCandidate(p) {
  const { side, targetRest, poseAbs, targetFrame, correction, guards, desiredCorrectionCm } = p
  const shoulder = `${side}Shoulder`
  const upperArm = `${side}UpperArm`
  const lowerArm = `${side}LowerArm`
  const hand = `${side}Hand`
  const qShoulder = frameQuat(poseAbs.rotations, shoulder)
  const qUpperArmAbs = frameQuat(poseAbs.rotations, upperArm)
  const qLowerArmAbs = frameQuat(poseAbs.rotations, lowerArm)
  const socket = poseAbs.positions[upperArm]
  const elbowAbs = poseAbs.positions[lowerArm]
  const handAbs = poseAbs.positions[hand]
  const correctionCm = vLen(correction) * 100

  if (correctionCm < 1e-6) {
    return {
      accepted: true,
      reason: null,
      qShoulder,
      qUpperArm: qUpperArmAbs,
      qLowerArm: qLowerArmAbs,
      correctionCm: 0,
      upperArmDirChangeDeg: 0,
      upperArmWorldDirChangeDeg: 0,
      elbowFlexDeg: jointFlexDeg(socket, elbowAbs, handAbs),
      desiredCorrectionCm: desiredCorrectionCm ?? 0,
      targetWrist: handAbs,
      wrist: handAbs
    }
  }

  const targetWrist = vAdd(handAbs, correction)
  const l1 = vDist(targetRest[upperArm], targetRest[lowerArm])
  const l2 = vDist(targetRest[lowerArm], targetRest[hand])
  const ik = solveTwoBoneIK({
    root: socket,
    target: targetWrist,
    polePoint: elbowAbs,
    fallbackUp: targetFrame.up,
    l1,
    l2,
    reachRatio: guards.reachRatio,
    minElbowFlexDeg: guards.minElbowFlexDeg,
    maxElbowFlexDeg: guards.maxElbowFlexDeg
  })

  const uAbs = vNorm(vSub(elbowAbs, socket))
  const uIk = vNorm(vSub(ik.elbow, socket))
  const upperArmWorldDirChangeDeg = vecAngleDeg(uAbs, uIk)
  const upperArmDirChangeDeg = vecAngleDeg(
    bodyDirection(targetFrame, uAbs),
    bodyDirection(targetFrame, uIk)
  )
  const actualCorrectionCm = vDist(ik.wrist, handAbs) * 100
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
      upperArmWorldDirChangeDeg,
      elbowFlexDeg: flex,
      desiredCorrectionCm: desiredCorrectionCm ?? correctionCm,
      targetWrist,
      wrist: ik.wrist
    }
  }

  const DShoulder = poseAbs.deltas[shoulder]
  const DUpperArmAbs = poseAbs.deltas[upperArm]
  const DLowerArmAbs = poseAbs.deltas[lowerArm]
  const fAbs = vNorm(vSub(handAbs, elbowAbs))
  const fIk = vNorm(vSub(ik.wrist, ik.elbow))
  const DUpperArmIk = quatMultiply(quatFromUnitVectors(uAbs, uIk), DUpperArmAbs)
  const DLowerArmIk = quatMultiply(quatFromUnitVectors(fAbs, fIk), DLowerArmAbs)
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
    upperArmWorldDirChangeDeg,
    elbowFlexDeg: flex,
    desiredCorrectionCm: desiredCorrectionCm ?? correctionCm,
    targetWrist,
    wrist: ik.wrist
  }
}

/**
 * 检查 final 混合权重是否仍满足 guards；不满足则二分降权（与 v2 同思路，基座换成 absolute）。
 */
function blendAbsoluteWeightSafe({ targetRest, base, cand, weight, side, guards }) {
  const shoulder = `${side}Shoulder`
  const upperArm = `${side}UpperArm`
  const lowerArm = `${side}LowerArm`
  const hand = `${side}Hand`
  const qS = base.absolute.rotations[shoulder]
  const qA2 = base.absolute.rotations[upperArm]
  const qL0 = base.rotations[lowerArm]
  const socketAbs = base.poseAbs.positions[upperArm]
  const elbowAbs = base.poseAbs.positions[lowerArm]
  const handAbs = base.poseAbs.positions[hand]
  const uAbs = vNorm(vSub(elbowAbs, socketAbs))

  const evaluate = (w) => {
    const qA = quatSlerp(qA2, cand.qUpperArm, w)
    const qL = quatSlerp(qL0, cand.qLowerArm, w)
    const pose = forwardKinematics(targetRest, {
      ...base.rotations,
      ...base.absolute.rotations,
      [upperArm]: qA,
      [lowerArm]: qL
    })
    const elbow = pose.positions[lowerArm]
    const wrist = pose.positions[hand]
    const correctionCm = vDist(wrist, handAbs) * 100
    const uIk = vNorm(vSub(elbow, socketAbs))
    const upperArmDirChangeDeg = vecAngleDeg(
      bodyDirection(base.targetFrame, uAbs),
      bodyDirection(base.targetFrame, uIk)
    )
    const elbowFlexDeg = jointFlexDeg(socketAbs, elbow, wrist)
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
    if (evaluate(mid).ok) lo = mid
    else hi = mid
  }
  result = evaluate(lo)
  return { ...result, qUpperArm: result.qA, qLowerArm: result.qL, weight: lo }
}

/* -------------------------------------------------------------------------- */
/* 指标（v3 额外口径）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 逐帧额外指标：绝对目标抬升、socket 对绝对目标误差、上臂体相对方向变化、
 * 手相对 S2-absolute 的修正量、手浮（相对原 clip）等。
 */
function computeV3ExtraSides({ frames, sourceRest, targetRest, base, afterTracks }) {
  const out = new Array(frames)
  for (let f = 0; f < frames; f += 1) {
    const rotAfter = { ...base[f].rotations }
    for (const bone of V3_MODIFIED_BONES) rotAfter[bone] = afterTracks[bone][f]
    const afterPose = forwardKinematics(targetRest, rotAfter)
    const beforePose = base[f].targetBefore
    const targetFrame = base[f].targetFrame
    const sides = {}
    for (const side of SIDES) {
      const shoulder = `${side}Shoulder`
      const upperArm = `${side}UpperArm`
      const lowerArm = `${side}LowerArm`
      const hand = `${side}Hand`
      const abs = base[f].absolute.sides[side]
      const socketBefore = beforePose.positions[upperArm]
      const socketAfter = afterPose.positions[upperArm]
      const elbowBefore = beforePose.positions[lowerArm]
      const elbowAfter = afterPose.positions[lowerArm]
      const handBefore = beforePose.positions[hand]
      const handAfter = afterPose.positions[hand]
      const handAbs = base[f].poseAbs.positions[hand]
      const socketBeforeLocal = frameLocal(targetFrame, socketBefore)
      const socketAfterLocal = frameLocal(targetFrame, socketAfter)
      const dirBefore = vNorm(vSub(elbowBefore, socketBefore))
      const dirAfter = vNorm(vSub(elbowAfter, socketAfter))
      const bodyBefore = bodyDirection(targetFrame, dirBefore)
      const bodyAfter = bodyDirection(targetFrame, dirAfter)
      sides[side] = {
        absoluteTargetLiftCm: abs.absoluteTargetLiftCm,
        interpolatedTargetLiftCm: abs.interpolatedTargetLiftCm,
        actualSocketLiftCm: (socketAfterLocal[1] - socketBeforeLocal[1]) * 100,
        socketErrorVsAbsoluteTargetCm: vDist(socketAfter, abs.absoluteTargetWorld) * 100,
        socketErrorVsInterpolatedTargetCm: vDist(socketAfter, abs.interpolatedTargetWorld) * 100,
        shoulderCapHit: abs.capHit,
        shoulderAimAddedDeg: abs.shoulderAimAddedDeg,
        upperArmBodyDirChangeDeg: vecAngleDeg(bodyBefore, bodyAfter),
        upperArmBodyHorizontalChangeDeg: Math.abs(
          Math.asin(Math.min(1, Math.abs(vDot(bodyAfter, [0, 1, 0])))) * RAD2DEG -
          Math.asin(Math.min(1, Math.abs(vDot(bodyBefore, [0, 1, 0])))) * RAD2DEG
        ),
        handFloatCm: vDist(handAfter, handBefore) * 100,
        handCorrectionFromAbsoluteCm: vDist(handAfter, handAbs) * 100,
        handCorrectionFromBeforeCm: vDist(handAfter, handBefore) * 100
      }
    }
    out[f] = { frame: f, sides }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* clip 级                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 对整段 clip 做 v3 重定向。
 *
 * @param {any} clip clip JSON
 * @param {object} config
 * @param {Record<string,number[]>} config.sourceRest
 * @param {Record<string,number[]>} config.targetRest
 * @param {'absolute'|'hybrid'} config.mode
 * @param {number} [config.liftFraction=1] 0..1
 * @param {number} [config.maxShoulderLocalDeg=45] ≤0 = off
 * @param {number} [config.partialIk=1] hybrid 手修正比例 0..1
 * @param {Record<string,string>} [config.policy] 覆盖 clip 策略
 * @param {object} [config.guards]
 * @returns {object}
 */
export function retargetClipV3(clip, config) {
  const frames = Number(clip?.frames)
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`clip.frames 非法：${clip?.frames}`)
  const { sourceRest, targetRest } = config
  const mode = config.mode === 'hybrid' ? 'hybrid' : 'absolute'
  const liftFraction = clamp01(Number.isFinite(config.liftFraction) ? config.liftFraction : 1)
  const maxShoulderLocalDeg = Number.isFinite(config.maxShoulderLocalDeg) ? config.maxShoulderLocalDeg : 45
  const partialIk = clamp01(Number.isFinite(config.partialIk) ? config.partialIk : 1)
  const guards = { ...V3_DEFAULT_GUARDS, ...(config.guards ?? {}) }
  const loop = clip?.loop === true
  const policy = resolveV3Policy(config.clipName ?? '', mode, config.policy)
  const coefficients = deriveS2Coefficients(sourceRest, targetRest)
  const sourceTorsoM = coefficients.sourceTorsoM
  const targetTorsoM = coefficients.targetTorsoM

  const sourceTracks = {}
  for (const bone of ARM_TORSO_BONES) sourceTracks[bone] = decodeRotationTrack(clip?.bones?.[bone]?.r, frames)
  const original = {}
  for (const bone of V3_MODIFIED_BONES) original[bone] = sourceTracks[bone].slice()

  if (policy === 'exclude') {
    const tracks = Object.fromEntries(V3_MODIFIED_BONES.map((b) => [b, enforceQuatContinuity(original[b].slice())]))
    return {
      tracks,
      coefficients,
      policy,
      excluded: true,
      mode,
      liftFraction,
      maxShoulderLocalDeg,
      partialIk,
      frameMetrics: [],
      summary: null,
      trackStats: buildTrackStats(original, tracks, loop),
      hybrid: null,
      absolute: {
        liftFraction,
        maxShoulderLocalDeg,
        capSideFrames: 0,
        candidateSideFrames: 0
      }
    }
  }

  // 逐帧：源/目标 FK + S2-absolute + poseAbs
  const base = new Array(frames)
  for (let f = 0; f < frames; f += 1) {
    const rotations = {}
    for (const bone of ARM_TORSO_BONES) rotations[bone] = sourceTracks[bone][f]
    const sourcePose = forwardKinematics(sourceRest, rotations)
    const targetBefore = forwardKinematics(targetRest, rotations)
    const sourceFrame = computeTorsoFrame(sourcePose)
    const targetFrame = computeTorsoFrame(targetBefore)
    const absoluteRotations = {}
    const sides = {}
    for (const side of SIDES) {
      const absoluteTargetWorld = absoluteTargetForSide({
        side, sourcePose, sourceFrame, targetFrame, sourceTorsoM, targetTorsoM
      })
      const solved = solveAbsoluteSide({
        side, rotations, targetRest, targetBefore, targetFrame,
        absoluteTargetWorld, liftFraction, maxShoulderLocalDeg
      })
      sides[side] = solved
      absoluteRotations[`${side}Shoulder`] = solved.qShoulder
      absoluteRotations[`${side}UpperArm`] = solved.qUpperArm
      absoluteRotations[`${side}LowerArm`] = solved.qLowerArm
    }
    const poseAbs = forwardKinematics(targetRest, { ...rotations, ...absoluteRotations })
    base[f] = { rotations, sourcePose, targetBefore, sourceFrame, targetFrame, absolute: { rotations: absoluteRotations, sides }, poseAbs }
  }

  const useIk = mode === 'hybrid' && policy === 'absolute-hybrid' && partialIk > 1e-9
  let corrections = null
  let candidates = null
  if (useIk) {
    const raw = { Left: new Array(frames).fill(null), Right: new Array(frames).fill(null) }
    for (let f = 0; f < frames; f += 1) {
      for (const side of SIDES) {
        const hand = `${side}Hand`
        const handAbs = base[f].poseAbs.positions[hand]
        const desired = base[f].targetBefore.positions[hand]
        let corr = vScale(vSub(desired, handAbs), partialIk)
        const len = vLen(corr)
        if (len > guards.maxHandCorrectionCm / 100) {
          corr = vScale(vNorm(corr), guards.maxHandCorrectionCm / 100)
        }
        raw[side][f] = corr
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
        candidates[side][f] = solveAbsoluteHybridCandidate({
          side,
          targetRest,
          poseAbs: base[f].poseAbs,
          targetFrame: base[f].targetFrame,
          correction: corr,
          desiredCorrectionCm: vLen(vSub(base[f].targetBefore.positions[`${side}Hand`], base[f].poseAbs.positions[`${side}Hand`])) * 100,
          guards
        })
      }
    }
  }

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
    for (const bone of V3_MODIFIED_BONES) tracks[bone] = new Array(frames)
    const hybridInfo = new Array(frames)
    for (let f = 0; f < frames; f += 1) {
      const info = { frame: f, sides: {} }
      for (const side of SIDES) {
        const shoulder = `${side}Shoulder`
        const upperArm = `${side}UpperArm`
        const lowerArm = `${side}LowerArm`
        const qS = base[f].absolute.rotations[shoulder]
        const qA2 = base[f].absolute.rotations[upperArm]
        const qL0 = base[f].rotations[lowerArm]
        tracks[shoulder][f] = qS
        let qA = qA2
        let qL = qL0
        let weight = 0
        const cand = useIk ? candidates[side][f] : null
        let finalInfo = {
          accepted: false,
          weight: 0,
          correctionCm: 0,
          upperArmDirChangeDeg: 0,
          upperArmWorldDirChangeDeg: 0,
          elbowFlexDeg: 0,
          fallback: !useIk,
          reason: cand?.reason ?? (useIk ? 'no-candidate' : null)
        }
        if (useIk && cand?.accepted && weights[side][f] > 1e-6) {
          weight = clamp01(weights[side][f])
          const safe = blendAbsoluteWeightSafe({
            targetRest, base: base[f], cand, weight, side, guards
          })
          weight = safe.weight
          qA = safe.qUpperArm
          qL = safe.qLowerArm
          finalInfo = {
            accepted: weight > 1e-6,
            weight,
            correctionCm: safe.correctionCm,
            upperArmDirChangeDeg: safe.upperArmDirChangeDeg,
            upperArmWorldDirChangeDeg: cand.upperArmWorldDirChangeDeg,
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
    for (const bone of V3_MODIFIED_BONES) {
      for (let f = 0; f < frames; f += 1) {
        if (!Array.isArray(tracks[bone][f])) throw new Error(`内部错误：${bone} 帧 ${f} 无输出四元数`)
      }
      tracks[bone] = enforceQuatContinuity(tracks[bone])
    }
    return { tracks, weights, hybridInfo }
  }

  const beforeStats = buildTrackStats(original, original, loop)
  const jumpTarget = Math.max(6, beforeStats.frameJumpMaxDeg + 0.01)
  let final = null
  for (const passes of [guards.weightSmoothPasses, guards.weightSmoothPasses + 2, guards.weightSmoothPasses + 4]) {
    final = buildFinal(passes)
    const stats = buildTrackStats(original, final.tracks, loop)
    if (!useIk || stats.frameJumpMaxDeg <= jumpTarget + 0.05) break
  }

  const extraSides = computeV3ExtraSides({
    frames, sourceRest, targetRest, base, afterTracks: final.tracks
  })
  const frameMetrics = computeFrameMetrics({
    frames,
    sourceRest,
    targetRest,
    sourceTracks,
    beforeTracks: original,
    afterTracks: final.tracks,
    sourceTorsoM,
    targetTorsoM,
    hybridInfo: final.hybridInfo,
    extraSides
  })
  const trackStats = buildTrackStats(original, final.tracks, loop)
  if (useIk) attachHybridStats(trackStats, final.hybridInfo)

  let capSideFrames = 0
  for (let f = 0; f < frames; f += 1) {
    for (const side of SIDES) if (base[f].absolute.sides[side].capHit) capSideFrames += 1
  }

  return {
    tracks: final.tracks,
    coefficients,
    policy,
    excluded: false,
    mode,
    liftFraction,
    maxShoulderLocalDeg,
    partialIk,
    frameMetrics,
    summary: summarizeFrameMetrics(frameMetrics),
    trackStats,
    hybrid: useIk
      ? {
          ikTarget: 'before',
          partialIk,
          weights: final.weights,
          acceptedFrames: SIDES.reduce((n, s) => n + final.hybridInfo.filter((row) => row.sides[s]?.accepted).length, 0),
          rejectedFrames: SIDES.reduce((n, s) => n + final.hybridInfo.filter((row) => !row.sides[s]?.accepted).length, 0),
          acceptedSideFrames: final.hybridInfo.reduce((n, row) => n + SIDES.filter((s) => row.sides[s]?.accepted).length, 0),
          rejectedSideFrames: final.hybridInfo.reduce((n, row) => n + SIDES.filter((s) => !row.sides[s]?.accepted).length, 0),
          candidateFrames: frames * SIDES.length,
          frameInfo: final.hybridInfo
        }
      : null,
    absolute: {
      liftFraction,
      maxShoulderLocalDeg,
      partialIk,
      capSideFrames,
      candidateSideFrames: frames * SIDES.length
    }
  }
}

export { SIDES as V3_SIDES, clamp01 as clampUnit }
