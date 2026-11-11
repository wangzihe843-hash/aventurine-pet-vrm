/**
 * HSR 官方动画 → VRM clip 数据重定向核心（纯函数，无 IO）。
 *
 * 数据流：
 *   HSR 采样（`extract-hsr-anims.py`：236 骨 × 每帧 armature-space quat/head）
 *     → 每骨世界旋转 delta D = R_pose R_rest⁻¹
 *     → 坐标系对齐 D_vrm = R_align D_hsr R_alignᵀ（R_align 由两侧 rest 骨几何自动求：旧 A-pose 180° / 新 T-pose 0°）
 *     → rest 方向修正（手臂/手/手指）：D_fixed = D_vrm · swing(target rest dir → mapped source rest dir)
 *     → humanoid 52 骨：局部归一化旋转 q = D_parent⁻¹ D_bone（父级 = VRM raw 链上最近 humanoid 祖先）
 *     → 可选 raw 次级骨（旧无 spring 资产）：链映射 + 同一 delta 法 + 相对首帧增量
 *     → Hips 位移（米，减去首帧基准；按 hips 高比缩放）
 *     → 可选脚部 grounding（用归一化骨架正解算脚骨世界高度，逐帧平移 hips）
 *
 * 目标资产有 SpringBone 时（新 T-pose 戏浪，50 链），次级骨交给 VRM spring；raw 留空。
 * 输出 clip JSON 兼容 Wave 1.5 的 `assets/motions/mate/<clip>.json`（22 骨 + Hips.p），
 * 并额外给出 30 根手指骨（V3 扩展，见 docs/vrm-motion-hsr.md）。
 */
import {
  qIdentity,
  qInvert,
  qMul,
  qNormalize,
  qAngleDeg,
  mat3FromQuat,
  quatFromMat3,
  mat3Mul,
  mat3Transpose,
  mat3MulVec,
  qRotateVec,
  makeQuatTrackContinuous
} from './quat.mjs'
import {
  HSR_TO_VRM_HUMANOID,
  HSR_BONE_NEXT,
  UNITY_NAME_BY_VRM,
  CORE_UNITY_BONES,
  resolveHumanoidMapping
} from './humanoid-hsr.mjs'
import { buildRestDirectionFix } from './rest-direction-fix.mjs'

/** 默认参数（CLI 可覆盖）。 */
export const RETARGET_DEFAULTS = Object.freeze({
  fps: 30,
  rawMode: 'relative-to-first-frame',
  hairGain: 1,
  clothGain: 1,
  grounding: 'per-clip',
  maxGroundShiftMeters: 0.2,
  restDirectionFix: true,
  rawEnabled: true,
  rawPolicy: null,
  targetVrm: null,
  targetAvatarId: null
})

/**
 * 默认 source 描述符 = **现有 HSR 行为**（不传 `source` 时 `retargetClip`/`buildAlignment`
 * 自动使用；导出以便测试/其它 CLI 显式复用同一口径）。
 *
 * 可插拔 source 接口（V3.1 新增，全部字段可选、不传即旧行为）：
 *   rest                     源 rest（默认 samples.rest）
 *   hipsBone                 源 hips 骨名（默认 Root_M）
 *   avatar                   clip.avatar 元数据（默认 HSR-Avatar_Aventurine_00）
 *   sourceHeightMeters       默认 samples.sourceHeightMeters
 *   sourceHipsHeightMeters   默认 samples.sourceHipsHeightMeters
 *   resolveMapping(vrmRest)  → { mapping: vrmName→源骨名, notes, upperChestFallback, ... }
 *   expectedHumanoid         源能驱动的 humanoid 名（缺目标骨时告警；默认 HSR 52 骨全表）
 *   boneNext                 源骨解剖链下一根（rest 方向修正；默认 HSR_BONE_NEXT）
 *   restFixPattern           覆盖 rest 修正组（默认上臂/前臂/手/手指）
 *
 * Biped 描述符见 `lib/humanoid-biped.mjs#createBipedSource`。
 *
 * @param {{ rest: any, sourceHeightMeters?: number, sourceHipsHeightMeters?: number }} samples
 */
export function createHsrSource(samples) {
  return {
    name: 'hsr',
    rest: samples.rest,
    hipsBone: 'Root_M',
    avatar: 'HSR-Avatar_Aventurine_00',
    sourceHeightMeters: samples.sourceHeightMeters,
    sourceHipsHeightMeters: samples.sourceHipsHeightMeters,
    resolveMapping: resolveHumanoidMapping,
    expectedHumanoid: Object.keys(HSR_TO_VRM_HUMANOID),
    boneNext: HSR_BONE_NEXT,
    leftShoulderBone: 'Scapula_L',
    rightShoulderBone: 'Scapula_R',
    upBone: 'Chest_M'
  }
}

const IDENTITY3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1]
]

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function scale3(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k]
}

function roundQuat(q) {
  return [round(q[0], 7), round(q[1], 7), round(q[2], 7), round(q[3], 7)]
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 世界旋转 delta：D = R_pose · R_rest⁻¹（矩阵）。 */
export function worldDeltaMatrix(poseQuat, restQuat) {
  return mat3Mul(mat3FromQuat(poseQuat), mat3Transpose(mat3FromQuat(restQuat)))
}

/** 坐标系对齐：R · D · Rᵀ。 */
export function applyAlignment(matrix, delta) {
  return mat3Mul(mat3Mul(matrix, delta), mat3Transpose(matrix))
}

/** 从父级 D_parent 与目标 D_bone 求局部归一化旋转。 */
function localNormalizedQuat(parentDelta, boneDelta) {
  if (!parentDelta) return quatFromMat3(boneDelta)
  return quatFromMat3(mat3Mul(mat3Transpose(parentDelta), boneDelta))
}

/** 生成 clip 帧数（Wave 1.5 约定：loop = round(duration*fps)；非 loop = +1 末帧）。 */
export function clipFrameCount({ loop, duration, fps }) {
  return loop ? Math.round(duration * fps) : Math.round(duration * fps) + 1
}

/**
 * 参考姿势帧判定：用于剔除导出器在 take 首帧塞入的 T-pose 参考帧。
 *
 * 规则：该帧必须**整体接近 rest**（大多数骨相对 rest 的旋转偏差很小）才算参考帧。
 * 真实动作的首帧（例：受击/眩晕 take 的「站立持板 → 受击弯腰」合法 snap）偏差很大，
 * 不能当参考帧裁掉——2026-11-09 用户反馈「扔下触发 stun 时突然起跳」的根因之一就是
 * 旧启发式误裁了 stun/hitL 的首帧，使 Hips 首帧基准落在动作中段（见 `clips.hsr.json`
 * 的 `hipsBase` 与 `docs/research/stun-break-hips-fix.md`）。
 *
 * @param {{ q?: Record<string, number[]> }} frame 采样帧
 * @param {Record<string, { quat: number[] }>} rest 源 rest
 * @returns {boolean} true = 接近 rest，可当作参考帧丢弃
 */
export function isRestLikeReferenceFrame(
  frame,
  rest,
  { meanDeg = 12, smallDeg = 20, smallRatio = 0.8 } = {}
) {
  let total = 0
  let sum = 0
  let small = 0
  for (const bone of Object.keys(rest)) {
    const pose = frame?.q?.[bone]
    const restQuat = rest[bone]?.quat
    if (!pose || !restQuat) continue
    const angle = qAngleDeg(pose, restQuat)
    total += 1
    sum += angle
    if (angle <= smallDeg) small += 1
  }
  if (total === 0) return false
  return sum / total <= meanDeg && small / total >= smallRatio
}

/**
 * 用归一化 humanoid 轨道正解算世界位置/朝向（离线 grounding / QA 用）。
 *
 * @param {any} vrmRest `buildVrmRest` 结果
 * @param {Map<string, Array<number[]>>} tracksByVrmName VRM humanoid 名 → 每帧归一化局部四元数
 * @param {number} frames
 * @param {number[][]} hipsP 每帧 Hips 位移（米，已按 hips 高比缩放）
 * @returns {Array<Map<string, { position: number[], rotation: number[] }>>}
 */
export function simulateNormalizedHumanoid(vrmRest, tracksByVrmName, frames, hipsP) {
  const names = vrmRest.humanoidOrder.filter((name) => tracksByVrmName.has(name) && vrmRest.humanoid[name])
  const offsets = new Map()
  for (const name of names) {
    const parent = vrmRest.effectiveParent[name]
    const own = vrmRest.humanoid[name].position
    if (!parent || !vrmRest.humanoid[parent]) {
      offsets.set(name, own.slice())
    } else {
      offsets.set(name, sub3(own, vrmRest.humanoid[parent].position))
    }
  }
  const restHips = vrmRest.humanoid.hips.position
  const framesData = []
  for (let frame = 0; frame < frames; frame += 1) {
    const worldRot = new Map()
    const worldPos = new Map()
    for (const name of names) {
      const parent = vrmRest.effectiveParent[name]
      const localQuat = tracksByVrmName.get(name)[frame] ?? qIdentity()
      if (!parent || !worldRot.has(parent)) {
        worldRot.set(name, qNormalize(localQuat))
        const hipsOffset = hipsP[frame] ?? [0, 0, 0]
        worldPos.set(name, name === 'hips' ? add3(restHips, hipsOffset) : offsets.get(name).slice())
      } else {
        const parentRot = worldRot.get(parent)
        worldRot.set(name, qNormalize(qMul(parentRot, localQuat)))
        worldPos.set(name, add3(worldPos.get(parent), qRotateVec(parentRot, offsets.get(name))))
      }
    }
    framesData.push({ worldRot, worldPos })
  }
  return framesData
}

/** 脚部 grounding：逐帧平移 hips，使最低脚骨回到 rest 高度（不穿地/不悬空）。 */
export function applyFootGrounding({
  vrmRest,
  tracksByVrmName,
  frames,
  hipsP,
  sourceHipsHeightMeters,
  maxShiftMeters = RETARGET_DEFAULTS.maxGroundShiftMeters
}) {
  const hipsRestY = vrmRest.humanoid.hips.position[1]
  const scale = hipsRestY / (sourceHipsHeightMeters || hipsRestY)
  const footBones = ['leftFoot', 'leftToes', 'rightFoot', 'rightToes'].filter((name) => vrmRest.humanoid[name])
  const restFootY = footBones.map((name) => vrmRest.humanoid[name].position[1])
  const scaledP = hipsP.map((p) => scale3(p, scale))
  const simulated = simulateNormalizedHumanoid(vrmRest, tracksByVrmName, frames, scaledP)
  const shifts = []
  const footErrorsBefore = []
  let maxShift = 0
  let clampedFrames = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const pose = simulated[frame]
    let minDelta = Infinity
    footBones.forEach((name, index) => {
      const position = pose.worldPos.get(name)
      if (!position) return
      minDelta = Math.min(minDelta, position[1] - restFootY[index])
    })
    if (!Number.isFinite(minDelta)) minDelta = 0
    footErrorsBefore.push(minDelta)
    let shift = -minDelta
    if (Math.abs(shift) > maxShiftMeters) {
      shift = Math.sign(shift) * maxShiftMeters
      clampedFrames += 1
    }
    maxShift = Math.max(maxShift, Math.abs(shift))
    shifts.push(shift)
  }
  // 保持「Hips.p 首帧归零」的 Wave 1.5 约定：grounding 只施加相对首帧的竖直补偿，
  // 首帧残差 = -shift[0]（常数偏移，通常 <1cm，由 app 场景摆放/贴地逻辑兜底）。
  const firstShift = shifts[0] ?? 0
  const adjustedP = hipsP.map((p, frame) => [
    p[0],
    p[1] + (shifts[frame] - firstShift) / scale,
    p[2]
  ])
  const footErrorsAfter = footErrorsBefore.map((error, frame) => error + shifts[frame] - firstShift)
  return {
    hipsP: adjustedP,
    scale,
    stats: {
      scale: round(scale, 6),
      maxShiftMeters: round(maxShift, 4),
      firstFrameShiftMeters: round(firstShift, 4),
      clampedFrames,
      footErrorBefore: {
        min: round(Math.min(...footErrorsBefore), 5),
        max: round(Math.max(...footErrorsBefore), 5)
      },
      footErrorAfter: {
        min: round(Math.min(...footErrorsAfter), 5),
        max: round(Math.max(...footErrorsAfter), 5)
      }
    }
  }
}

/**
 * 主重定向：单条 HSR clip → VRM clip 数据。
 *
 * @param {{
 *   clipId: string,
 *   clipDef: any,
 *   sampleClip: any,
 *   samples: any,
 *   vrmRest: any,
 *   alignment: { matrix: number[][], quat: number[], inverseQuat: number[] },
 *   secondaryMap?: { nodeToBone: Map<number, string>, chainReports: any[], counts: any, warnings: string[] } | null,
 *   options?: Partial<typeof RETARGET_DEFAULTS>,
 *   source?: any | null // 可插拔 source 描述符（默认 null = HSR 现有行为）
 * }} args
 */
export function retargetClip({
  clipId,
  clipDef,
  sampleClip,
  samples,
  vrmRest,
  alignment,
  secondaryMap,
  options = {},
  source = null
}) {
  const opts = { ...RETARGET_DEFAULTS, ...options }
  const sourceInfo = source ?? createHsrSource(samples)
  const sourceRest = sourceInfo.rest ?? samples.rest
  if (!sourceRest || typeof sourceRest !== 'object') {
    throw new Error(`clip ${clipId}: source.rest 缺失（无法做世界 delta 重定向）`)
  }
  const hipsBone = sourceInfo.hipsBone ?? 'Root_M'
  if (!sourceRest[hipsBone]) {
    throw new Error(`clip ${clipId}: source rest 缺少 hips 骨 ${JSON.stringify(hipsBone)}`)
  }
  const fps = samples.fps ?? opts.fps
  // 源帧率：默认全局 samples.sourceFps；若采样器检测到单个 take/FBX 与全局不一致，
  // 可在该 clip 对象里增写 `sourceFps`（纯增量、可缺省；schema 扩展需 Lead 对齐，见 RETARGET-REPORT）。
  const srcFps = sampleClip.sourceFps ?? samples.sourceFps ?? 60
  const sourceHipsHeight = sourceInfo.sourceHipsHeightMeters ?? samples.sourceHipsHeightMeters
  const [srcStart, srcEnd] = sampleClip.srcFrames
  const loop = Boolean(clipDef.loop)
  const duration = (srcEnd - srcStart) / srcFps
  let durationUsed = duration
  let frames = clipFrameCount({ loop, duration, fps })
  const hsrRest = sourceRest
  const hsrBoneNames = Object.keys(hsrRest)
  // 部分 HSR 战斗 take 在首帧带「参考姿势（T-pose）」关键帧：首帧→次帧多数骨 45°+ 跳变。
  // 这种帧是导出产物而非动作内容，直接丢弃（最多丢 2 帧，loop clip 不丢）。
  // 仅对 HSR 源启用：3ds Max Biped 的 bake 首帧就是有效动作内容（受击/眩晕等 take 的
  // 第一帧本来就带大幅 snap），误裁会吃掉真实动作的前 1–2 帧（2026-11-09 v3 验收发现）。
  let data = sampleClip.data.slice()
  let trimmedFrames = 0
  if (!loop && sourceInfo.name === 'hsr') {
    while (data.length > 2 && trimmedFrames < 2) {
      const a = data[trimmedFrames]
      const b = data[trimmedFrames + 1]
      let bigJumps = 0
      let total = 0
      for (const bone of Object.keys(hsrRest)) {
        if (!a.q[bone] || !b.q[bone]) continue
        total += 1
        if (qAngleDeg(a.q[bone], b.q[bone]) > 45) bigJumps += 1
      }
      // 参考帧判定：被丢弃的帧必须**本身接近 rest**（导出器塞入的 T-pose 参考帧）；
      // 受击/眩晕 take 的首帧是真实动作（站立 → 受击 snap），偏差大 → 不裁。
      if (total > 0 && bigJumps / total > 0.15 && isRestLikeReferenceFrame(a, hsrRest)) {
        trimmedFrames += 1
      } else break
    }
  }
  if (trimmedFrames > 0) {
    data = data.slice(trimmedFrames)
    const firstTime = data[0].f
    const shiftedDuration = (srcEnd - firstTime) / srcFps
    frames = clipFrameCount({ loop, duration: shiftedDuration, fps })
    data = data.slice(0, frames)
    durationUsed = shiftedDuration
  }
  if (data.length < frames) {
    throw new Error(`clip ${clipId}: 采样帧不够（需要 ${frames}，只有 ${data.length}）`)
  }
  data = data.slice(0, frames)

  const warnings = []

  // ---------- 1. 每帧 HSR 世界 delta ----------
  /** @type {Array<Map<string, number[][]>>} */
  const deltas = data.map((frame) => {
    const map = new Map()
    for (const bone of hsrBoneNames) {
      const pose = frame.q[bone]
      const rest = hsrRest[bone].quat
      if (!pose || !rest) continue
      map.set(bone, worldDeltaMatrix(pose, rest))
    }
    return map
  })

  // ---------- 1.5 目标 humanoid 映射（target-aware）+ rest 方向修正 ----------
  const mappingInfo = (sourceInfo.resolveMapping ?? resolveHumanoidMapping)(vrmRest)
  const mapping = mappingInfo.mapping
  const humanoidVrmNames = Object.keys(mapping)
  const expectedHumanoid = sourceInfo.expectedHumanoid ?? Object.keys(HSR_TO_VRM_HUMANOID)
  const missingHumanoid = expectedHumanoid.filter(
    (name) => !vrmRest.humanoid[name] && !(name === 'upperChest' && mappingInfo.upperChestFallback)
  )
  if (missingHumanoid.length > 0) {
    warnings.push(`目标 VRM 缺少 humanoid 骨：${missingHumanoid.join(', ')}（已跳过）`)
  }
  const restFix = opts.restDirectionFix
    ? buildRestDirectionFix({
        hsrRest,
        vrmRest,
        mapping,
        alignment,
        pattern: sourceInfo.restFixPattern ?? undefined,
        sourceNext: sourceInfo.boneNext ?? undefined
      })
    : { corrections: new Map(), rows: [], groups: {}, stats: { bones: 0, maxMismatchDeg: 0, applied: false } }
  /** @type {Map<string, number[][]>} */
  const restFixMatrix = new Map([...restFix.corrections].map(([name, correction]) => [name, mat3FromQuat(correction.quat)]))

  // ---------- 2. humanoid 归一化轨道 ----------
  /** @type {Map<string, number[][]>} */
  const humanoidTracks = new Map()
  /** @type {Array<Map<string, number[][]>>} */
  const targetDByFrame = []
  for (let frame = 0; frame < frames; frame += 1) {
    const dt = new Map()
    for (const vrmName of humanoidVrmNames) {
      const hsrBone = mapping[vrmName]
      const delta = deltas[frame].get(hsrBone)
      if (!delta) continue
      let target = applyAlignment(alignment.matrix, delta)
      const correction = restFixMatrix.get(vrmName)
      if (correction) target = mat3Mul(target, correction)
      dt.set(vrmName, target)
    }
    targetDByFrame.push(dt)
  }
  for (const vrmName of humanoidVrmNames) {
    humanoidTracks.set(vrmName, [])
  }
  for (let frame = 0; frame < frames; frame += 1) {
    const dt = targetDByFrame[frame]
    for (const vrmName of vrmRest.humanoidOrder) {
      if (!dt.has(vrmName)) continue
      const parent = vrmRest.effectiveParent[vrmName]
      const parentDelta = parent && dt.has(parent) ? dt.get(parent) : null
      humanoidTracks.get(vrmName).push(localNormalizedQuat(parentDelta, dt.get(vrmName)))
    }
  }
  // 目标缺 upperChest（新 T-pose 戏浪）：clip 仍写满 22 骨契约；该轨道为 identity（播放器跳过缺失骨）。
  if (mappingInfo.upperChestFallback) {
    humanoidTracks.set('upperChest', Array.from({ length: frames }, () => [0, 0, 0, 1]))
  }
  // 可插拔 source 的健壮性：目标有、但源没映射到（或某帧没采样到）的 humanoid 骨补 identity 轨道，
  // 保证 22 骨/52 骨契约完整（播放器按 normalized 名取骨，identity = 保持 rest）。
  // HSR 数据完整时不会触发（回归测试保证与旧行为逐字节一致）。
  const identityFilled = []
  for (const vrmName of Object.keys(UNITY_NAME_BY_VRM)) {
    if (!vrmRest.humanoid[vrmName]) continue
    const track = humanoidTracks.get(vrmName)
    if (track && track.length === frames) continue
    humanoidTracks.set(vrmName, Array.from({ length: frames }, () => [0, 0, 0, 1]))
    identityFilled.push(vrmName)
  }
  if (identityFilled.length > 0) {
    warnings.push(`源映射缺 ${identityFilled.length} 根 humanoid 骨的轨道（写 identity 满足契约）：${identityFilled.join(', ')}`)
  }
  // 连续性 + 单位化
  for (const [name, track] of humanoidTracks) {
    humanoidTracks.set(name, makeQuatTrackContinuous(track))
  }

  // ---------- 3. raw 次级骨轨道（旧无 spring 资产；新 T-pose 用 VRM SpringBone） ----------
  const rawPolicy = opts.rawPolicy ?? (opts.rawEnabled && secondaryMap ? 'baked' : 'none')
  const rawEnabled = rawPolicy === 'baked'
  /** @type {Map<number, number[][]>} */
  let rawTracksByNode = new Map()
  /** @type {Map<number, string>} */
  let rawNodeNameOf = new Map()
  const duplicateNames = new Set()
  if (rawEnabled) {
    /** @type {Map<number, number[][]>} */
    const rawTracksByNode = new Map()
    const rawNodeNames = []
    const duplicateNames = new Set()
    const seenRawName = new Set()
    for (const [nodeIndex] of secondaryMap.nodeToBone) {
      const name = vrmRest.nodes[nodeIndex]?.name
      if (typeof name !== 'string') continue
      if (seenRawName.has(name)) {
        duplicateNames.add(name)
        continue
      }
      seenRawName.add(name)
      rawNodeNames.push(name)
      rawTracksByNode.set(nodeIndex, [])
    }
    const rawNodeNameOf = new Map([...rawTracksByNode.keys()].map((index) => [index, vrmRest.nodes[index].name]))
    for (let frame = 0; frame < frames; frame += 1) {
      /** @type {Map<number, number[][]>} */
      const nodeD = new Map()
      let previousD = IDENTITY3
      for (const nodeIndex of vrmRest.order) {
        const parentIndex = vrmRest.parents[nodeIndex]
        const parentD = parentIndex >= 0 ? nodeD.get(parentIndex) ?? previousD : IDENTITY3
        const humanoidName = vrmRest.humanoidNameByNode.get(nodeIndex)
        if (humanoidName) {
          const dt = targetDByFrame[frame].get(humanoidName)
          nodeD.set(nodeIndex, dt ?? parentD)
          previousD = nodeD.get(nodeIndex)
          continue
        }
        const hsrBone = secondaryMap.nodeToBone.get(nodeIndex)
        if (hsrBone && rawTracksByNode.has(nodeIndex)) {
          const delta = deltas[frame].get(hsrBone)
          if (delta) {
            const target = applyAlignment(alignment.matrix, delta)
            const q = quatFromMat3(mat3Mul(mat3Transpose(parentD), target))
            rawTracksByNode.get(nodeIndex).push(q)
            nodeD.set(nodeIndex, target)
            previousD = target
            continue
          }
        }
        nodeD.set(nodeIndex, parentD)
        previousD = parentD
      }
    }
    // 连续性
    for (const [nodeIndex, track] of rawTracksByNode) {
      rawTracksByNode.set(nodeIndex, makeQuatTrackContinuous(track))
    }
    // 相对首帧（去掉 rest 姿态差异造成的常量偏移；首帧=模型原样，只叠加摆动）
    if (opts.rawMode === 'relative-to-first-frame') {
      for (const [nodeIndex, track] of rawTracksByNode) {
        const firstInverse = qInvert(track[0])
        const name = rawNodeNameOf.get(nodeIndex) ?? ''
        const gain = /褲腿|外衣|腰|內襯/.test(name) ? opts.clothGain : opts.hairGain
        rawTracksByNode.set(
          nodeIndex,
          track.map((q) => {
            const relative = qNormalize(qMul(q, firstInverse))
            if (gain === 1) return relative
            const angle = qAngleDeg(relative, qIdentity()) * (Math.PI / 180)
            if (angle < 1e-6) return qIdentity()
            const axis = qNormalize([relative[0], relative[1], relative[2]])
            const half = (angle * gain) / 2
            return [axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half), Math.cos(half)]
          })
        )
      }
    }
  }

  // ---------- 4. Hips 位移 + 脚部 grounding ----------
  /**
   * Hips 基准（`clipDef.hipsBase`，默认 `first-frame`）：
   * - `first-frame`：Hips.p = 相对**本 clip 首帧**的位移（原地 locomotion 契约，首帧归零）；
   * - `rest`：Hips.p = 相对**源 rest 髋高**的世界高度偏移 = VRMA / three-vrm 的「绝对髋高」语义。
   *
   * 跪/趴/起身/受击等「整体高度会变」的 clip 必须用 `rest`。用首帧相对会出两类 bug：
   * - 首帧本身就是下蹲/跪姿（breaked/revive）→ 绝对下沉量被当成 0，腰停在站立髋高，
   *   腿折叠在下方 = 悬空「蜷起来」；revive 的起身竖直位移也会被 staging 启发式误清；
   * - 首帧被裁过（stun/hitL）→ 基准落在动作中段的受击帧，后续反而向上抬 = 「突然起跳」。
   * 站立/locomotion clip 保持 `first-frame`（原地化契约不变）。
   */
  const hipsBase = clipDef.hipsBase ?? sourceInfo.hipsBase ?? 'first-frame'
  const restHips = hsrRest[hipsBone].head
  const rawHipsP = data.map((frame) => {
    const hips = frame.h?.[hipsBone]
    if (!hips) throw new Error(`clip ${clipId}: 采样帧 ${frame.f} 缺少 hips 骨 ${hipsBone} 的世界位置`)
    return scale3(sub3(hips, restHips), 1)
  })
  const firstHipsP = rawHipsP[0]
  let hipsP =
    hipsBase === 'rest' ? rawHipsP.map((p) => [...p]) : rawHipsP.map((p) => sub3(p, firstHipsP))
  // 转换到 VRM 坐标（R_align 作用在位移上）
  hipsP = hipsP.map((p) => mat3MulVec(alignment.matrix, p))

  // 桌宠约定 rootMotion=inPlace：去掉水平位移；若竖直位移范围异常大（HSR 过场/大招的
  // staging 位移），整段视为 staging 并把位移归零（旋转仍保留）。
  const translationMode = clipDef.translation ?? 'inPlace'
  let translationStats = null
  if (translationMode === 'inPlace') {
    const heightValues = hipsP.map((p) => p[1])
    const heightRange = Math.max(...heightValues) - Math.min(...heightValues)
    // rest 基准下 p 就是真实绝对高度变化：起身/倒地 ≤1m（revive 0.535m 必须保留），
    // 而 HSR staging 位移一般数米（skill03 16.3m / passiveSkill 7.4m），用 1m 阈值区分。
    const stagingZeroed = heightRange > (hipsBase === 'rest' ? 1 : 0.5)
    hipsP = hipsP.map((p) => (stagingZeroed ? [0, 0, 0] : [0, p[1], 0]))
    translationStats = {
      mode: translationMode,
      strippedHorizontal: true,
      heightRangeBeforeMeters: round(heightRange, 4),
      stagingZeroed,
      hipsBase
    }
  }

  let groundStats = null
  const grounding = clipDef.grounding === 'feet' && opts.grounding !== 'none'
  if (grounding) {
    const grounded = applyFootGrounding({
      vrmRest,
      tracksByVrmName: humanoidTracks,
      frames,
      hipsP,
      sourceHipsHeightMeters: sourceHipsHeight,
      maxShiftMeters: opts.maxGroundShiftMeters
    })
    hipsP = grounded.hipsP
    groundStats = grounded.stats
  }

  // ---------- 5. 组装 clip ----------
  const bones = {}
  for (const vrmName of Object.keys(UNITY_NAME_BY_VRM)) {
    const track = humanoidTracks.get(vrmName)
    if (!track) continue
    bones[UNITY_NAME_BY_VRM[vrmName]] = { r: track.map(roundQuat) }
  }
  const hipsEntry = bones.Hips
  if (hipsEntry) hipsEntry.p = hipsP.map((p) => [round(p[0], 6), round(p[1], 6), round(p[2], 6)])

  const raw = rawEnabled ? {} : undefined
  if (rawEnabled) {
    for (const [nodeIndex, track] of rawTracksByNode) {
      const name = rawNodeNameOf.get(nodeIndex)
      raw[name] = { r: track.map(roundQuat) }
    }
  }

  const storedDuration = loop ? frames / fps : (frames - 1) / fps
  const clip = {
    version: 1,
    clip: clipId,
    mood: clipDef.slot ?? null,
    loop,
    fps,
    duration: round(storedDuration, 6),
    sourceHeight: sourceInfo.sourceHeightMeters ?? samples.sourceHeightMeters,
    sourceHipsHeight: sourceHipsHeight,
    space: 'gltf-rh',
    frames,
    sourceClip: sampleClip.action,
    avatar: sourceInfo.avatar ?? 'HSR-Avatar_Aventurine_00',
    targetVrm: opts.targetVrm ?? null,
    targetAvatarId: opts.targetAvatarId ?? null,
    grounding: grounding ? 'feet' : 'none',
    /** Hips.p 语义（`first-frame` 时省略 = Wave 1.5 契约；`rest` 时显式写入，供 QA/播放侧识别）。 */
    ...(hipsBase === 'rest' ? { hipsBase: 'rest' } : {}),
    rawPolicy,
    bones
  }
  if (rawEnabled) {
    clip.raw = raw
    clip.rawMeta = {
      mapped: Object.keys(raw).length,
      mode: opts.rawMode,
      policy: rawPolicy,
      duplicatesSkipped: [...duplicateNames]
    }
  } else {
    clip.rawMeta = { mapped: 0, mode: null, policy: rawPolicy }
  }

  const report = {
    clip: clipId,
    frames,
    duration: round(storedDuration, 3),
    sourceDuration: round(durationUsed, 3),
    translation: translationStats,
    trimmedReferenceFrames: trimmedFrames,
    loop,
    humanoidBones: Object.keys(bones).length,
    coreBonesPresent: CORE_UNITY_BONES.filter((name) => bones[name]).length,
    upperChestFallback: mappingInfo.upperChestFallback,
    mappingNotes: mappingInfo.notes,
    restFix: {
      applied: restFix.stats.applied,
      bones: restFix.stats.bones,
      maxMismatchDeg: restFix.stats.maxMismatchDeg,
      groups: restFix.groups
    },
    rawPolicy,
    rawBones: rawEnabled ? Object.keys(raw).length : 0,
    rawChains: secondaryMap?.chainReports?.length ?? 0,
    rawCounts: secondaryMap?.counts ?? { hairNodes: 0, clothNodes: 0 },
    grounding: clip.grounding,
    groundStats,
    warnings: [...warnings, ...(secondaryMap?.warnings ?? [])]
  }
  return { clip, report }
}
