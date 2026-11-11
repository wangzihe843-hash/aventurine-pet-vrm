/**
 * V3 HSR clip QA：结构校验 + 数据指标 + PASS/WARN/FAIL 分级（纯函数，无 IO）。
 *
 * 与 Wave 1.5 的 `scripts/unity-bake/lib/clip-validation.mjs` 互补：
 * - 该模块校验 22 骨 + Hips；本模块额外校验 30 手指骨、raw 次级骨通道、
 *   相对首帧增量、脚部 grounding 残差与头发/衣摆运动量；
 * - U-lane 的 validator 也可直接跑本管线输出（额外骨只产生 warning），见 CLI。
 */
import {
  qAngleDeg,
  qDot,
  qNormalize,
  mat3FromQuat
} from './quat.mjs'
import { CORE_UNITY_BONES, UNITY_NAME_BY_VRM } from './humanoid-hsr.mjs'
import { simulateNormalizedHumanoid } from './retarget.mjs'
import { classifyVrmSecondaryNode } from './secondary-map.mjs'

export const CLIP_QA_LIMITS = Object.freeze({
  quatNormTolerance: 1e-3,
  loopSeamWarnDeg: 2,
  loopSeamFailDeg: 6,
  frameJumpWarnDeg: 75,
  frameJumpFailDeg: 150,
  hipsFirstOffsetMax: 1e-3,
  /** `hipsBase:'rest'` 时首帧最大绝对髋偏移（米；跪姿约 0.5m，留余量）。 */
  hipsRestOffsetMax: 1.0,
  groundPenetrationWarnMeters: 0.03,
  groundFloatWarnMeters: 0.06,
  rawRelativeFirstFrameMaxDeg: 0.5,
  rawMissingWarnRatio: 0.05,
  minRawBones: 1
})

const CORE_BONE_SET = new Set(CORE_UNITY_BONES)

const UNITY_TO_VRM = Object.freeze(
  Object.fromEntries(Object.entries(UNITY_NAME_BY_VRM).map(([vrm, unity]) => [unity, vrm]))
)

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function hipsCount(p) {
  if (!Array.isArray(p)) return -1
  if (Array.isArray(p[0])) return p.length
  return Math.floor(p.length / 3)
}

function hipsAt(p, frame) {
  if (Array.isArray(p[frame])) return p[frame]
  const base = frame * 3
  return [p[base], p[base + 1], p[base + 2]]
}

function trackLength(track) {
  if (!Array.isArray(track?.r)) return -1
  const first = track.r[0]
  if (Array.isArray(first)) return track.r.length
  return Math.floor(track.r.length / 4)
}

function quatAt(track, frame) {
  const entry = track.r[frame]
  if (Array.isArray(entry)) return [entry[0], entry[1], entry[2], entry[3]]
  const base = frame * 4
  return [track.r[base], track.r[base + 1], track.r[base + 2], track.r[base + 3]]
}

/** 结构校验。 */
export function validateClipStructure(clip, vrmRest) {
  const errors = []
  const warnings = []
  const stats = { humanoidBones: 0, rawBones: 0, frames: null }
  if (!clip || typeof clip !== 'object') return { errors: ['clip 不是对象'], warnings, stats }
  if (clip.version !== 1) errors.push(`version 必须是 1（实际 ${JSON.stringify(clip.version)}）`)
  if (clip.space !== 'gltf-rh') errors.push(`space 必须是 'gltf-rh'（实际 ${JSON.stringify(clip.space)}）`)
  if (typeof clip.loop !== 'boolean') errors.push('loop 必须是布尔值')
  if (!isFiniteNumber(clip.fps) || clip.fps <= 0) errors.push('fps 必须是正有限数')
  if (!Number.isInteger(clip.frames) || clip.frames <= 0) errors.push('frames 必须是正整数')
  if (!isFiniteNumber(clip.duration) || clip.duration <= 0) errors.push('duration 必须是正有限数')
  if (!isFiniteNumber(clip.sourceHipsHeight) || clip.sourceHipsHeight <= 0) {
    errors.push('sourceHipsHeight 必须是正有限数（Hips 位移缩放基准）')
  }
  const frames = Number.isInteger(clip.frames) ? clip.frames : 0
  stats.frames = frames
  if (frames > 0 && clip.fps > 0 && clip.duration > 0) {
    const expected = Math.round(clip.duration * clip.fps) + (clip.loop ? 0 : 1)
    if (expected !== frames) errors.push(`frames=${frames} 与 duration*fps 期望 ${expected} 不一致`)
  }
  if (!clip.bones || typeof clip.bones !== 'object') {
    errors.push('bones 必须是对象')
    return { errors, warnings, stats }
  }
  for (const bone of CORE_UNITY_BONES) {
    if (!Object.prototype.hasOwnProperty.call(clip.bones, bone)) errors.push(`缺少核心 humanoid 骨 ${bone}`)
  }
  let maxQuatNormError = 0
  let minAdjacentDot = 1
  for (const [bone, track] of Object.entries(clip.bones)) {
    if (!UNITY_TO_VRM[bone]) {
      warnings.push(`未知 humanoid 骨 ${bone}（不在 HSR→VRM 映射内）`)
      continue
    }
    if (trackLength(track) !== frames) {
      errors.push(`${bone}: r 帧数 ${trackLength(track)} ≠ frames ${frames}`)
      continue
    }
    let prev = null
    for (let frame = 0; frame < frames; frame += 1) {
      const q = quatAt(track, frame)
      if (!q.every(isFiniteNumber)) {
        errors.push(`${bone}: frame ${frame} 四元数含非有限值`)
        break
      }
      const norm = Math.hypot(q[0], q[1], q[2], q[3])
      maxQuatNormError = Math.max(maxQuatNormError, Math.abs(norm - 1))
      if (prev) minAdjacentDot = Math.min(minAdjacentDot, qDot(prev, q))
      prev = q
    }
    if (bone === 'Hips' && Array.isArray(track.p)) {
      const count = hipsCount(track.p)
      if (count !== frames) errors.push(`Hips.p 帧数 ${count} ≠ frames ${frames}`)
      else {
        const p0 = hipsAt(track.p, 0)
        const first = Math.hypot(p0[0], p0[1], p0[2])
        if (clip.hipsBase === 'rest') {
          // `rest` 基准 = 相对源 rest 髋高的绝对偏移（跪/趴/起身/受击），首帧本来就不为 0；
          // 只校验量级合理（跪姿下沉量 ~0.5m，超过阈值说明数据可疑）。
          if (first > CLIP_QA_LIMITS.hipsRestOffsetMax) {
            errors.push(`Hips.p rest 基准首帧偏移异常（|p0|=${first.toFixed(5)}m）`)
          }
        } else if (first > CLIP_QA_LIMITS.hipsFirstOffsetMax) {
          errors.push(`Hips.p 首帧未归零（|p0|=${first.toFixed(5)}m）`)
        }
      }
    }
  }
  if (maxQuatNormError > CLIP_QA_LIMITS.quatNormTolerance) {
    errors.push(`四元数未单位化（最大误差 ${maxQuatNormError.toExponential(2)}）`)
  }
  if (minAdjacentDot < 0) warnings.push(`存在相邻帧四元数符号翻转（min dot=${minAdjacentDot.toFixed(3)}）`)
  // 目标 VRM 缺 upperChest（新 T-pose 戏浪）：clip 仍写满 22 骨契约，该轨道必须是 identity
  if (!vrmRest?.humanoid?.upperChest && clip.bones.UpperChest) {
    const track = clip.bones.UpperChest
    let nonIdentity = 0
    for (let frame = 0; frame < frames; frame += 1) {
      const q = quatAt(track, frame)
      if (qAngleDeg(q, [0, 0, 0, 1]) > 1e-3) nonIdentity += 1
    }
    if (nonIdentity > 0) {
      warnings.push(`目标 VRM 无 humanoid upperChest，但 UpperChest 轨道有 ${nonIdentity} 帧非 identity（播放时会被忽略）`)
    }
  }
  stats.humanoidBones = Object.keys(clip.bones).length

  if (clip.raw !== undefined) {
    if (!clip.raw || typeof clip.raw !== 'object') errors.push('raw 必须是对象')
    else {
      const knownNames = vrmRest?.nameToNodes instanceof Map ? vrmRest.nameToNodes : new Map()
      let relativeViolation = 0
      let maxQuatNormErrorRaw = 0
      for (const [nodeName, track] of Object.entries(clip.raw)) {
        if (knownNames.size > 0 && !knownNames.has(nodeName)) warnings.push(`raw 节点 ${nodeName} 不在目标 VRM 中`)
        if (trackLength(track) !== frames) {
          errors.push(`raw.${nodeName}: r 帧数 ${trackLength(track)} ≠ frames ${frames}`)
          continue
        }
        let prev = null
        for (let frame = 0; frame < frames; frame += 1) {
          const q = quatAt(track, frame)
          if (!q.every(isFiniteNumber)) {
            errors.push(`raw.${nodeName}: frame ${frame} 四元数含非有限值`)
            break
          }
          const norm = Math.hypot(q[0], q[1], q[2], q[3])
          maxQuatNormErrorRaw = Math.max(maxQuatNormErrorRaw, Math.abs(norm - 1))
          if (prev) minAdjacentDot = Math.min(minAdjacentDot, qDot(prev, q))
          prev = q
        }
        const first = quatAt(track, 0)
        if (qAngleDeg(first, [0, 0, 0, 1]) > CLIP_QA_LIMITS.rawRelativeFirstFrameMaxDeg) relativeViolation += 1
      }
      if (relativeViolation > 0) {
        warnings.push(`${relativeViolation} 条 raw 轨道首帧未对齐 rest（相对首帧增量模式应≈identity）`)
      }
      if (maxQuatNormErrorRaw > CLIP_QA_LIMITS.quatNormTolerance) {
        errors.push(`raw 四元数未单位化（最大误差 ${maxQuatNormErrorRaw.toExponential(2)}）`)
      }
      stats.rawBones = Object.keys(clip.raw).length
    }
  } else if (clip.rawPolicy !== 'spring') {
    warnings.push(`clip 没有 raw 通道，且 rawPolicy=${JSON.stringify(clip.rawPolicy)}（预期 spring 或 baked）`)
  }
  return { errors, warnings, stats }
}

/** 指标：旋转/循环接缝/帧跳变/Hips/贴地/raw 运动量。 */
export function computeClipMetrics(clip, vrmRest) {
  const frames = clip.frames
  const metrics = {
    frames,
    fps: clip.fps,
    duration: clip.duration,
    loop: Boolean(clip.loop),
    maxFrameJumpDeg: 0,
    maxFrameJumpBone: null,
    maxFrameJumpFrame: null,
    loopSeamDeg: null,
    hipsTravelMeters: 0,
    hipsLateralDriftMeters: 0,
    hipsHeightRangeMeters: 0,
    ground: null,
    raw: null,
    fingerMaxDeg: 0,
    coreMaxDeg: 0
  }
  const tracks = new Map()
  for (const [unityName, track] of Object.entries(clip.bones ?? {})) {
    const vrmName = UNITY_TO_VRM[unityName]
    if (!vrmName) continue
    const quats = []
    for (let frame = 0; frame < frames; frame += 1) quats.push(quatAt(track, frame))
    tracks.set(vrmName, quats)
    let jump = 0
    let jumpFrame = null
    for (let frame = 1; frame < frames; frame += 1) {
      const angle = qAngleDeg(quats[frame - 1], quats[frame])
      if (angle > jump) {
        jump = angle
        jumpFrame = frame
      }
    }
    const isFinger = !CORE_BONE_SET.has(unityName) && /Thumb|Index|Middle|Ring|Little/.test(unityName)
    if (isFinger) metrics.fingerMaxDeg = Math.max(metrics.fingerMaxDeg, jump)
    else metrics.coreMaxDeg = Math.max(metrics.coreMaxDeg, jump)
    if (jump > metrics.maxFrameJumpDeg) {
      metrics.maxFrameJumpDeg = Number(jump.toFixed(2))
      metrics.maxFrameJumpBone = unityName
      metrics.maxFrameJumpFrame = jumpFrame
    }
    if (metrics.loop && frames > 1) {
      const seam = qAngleDeg(quats[frames - 1], quats[0])
      metrics.loopSeamDeg = Math.max(metrics.loopSeamDeg ?? 0, seam)
    }
  }
  if (metrics.loopSeamDeg !== null) metrics.loopSeamDeg = Number(metrics.loopSeamDeg.toFixed(2))

  // Hips 位移统计（米，source 单位≈米）
  const hips = clip.bones?.Hips
  if (hips && Array.isArray(hips.p) && hipsCount(hips.p) === frames) {
    let travel = 0
    let lateral = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let frame = 0; frame < frames; frame += 1) {
      const p = hipsAt(hips.p, frame)
      if (frame > 0) {
        const prev = hipsAt(hips.p, frame - 1)
        travel += Math.hypot(p[0] - prev[0], p[2] - prev[2])
        lateral = Math.max(lateral, Math.hypot(p[0], p[2]))
      }
      minY = Math.min(minY, p[1])
      maxY = Math.max(maxY, p[1])
    }
    metrics.hipsTravelMeters = Number(travel.toFixed(4))
    metrics.hipsLateralDriftMeters = Number(lateral.toFixed(4))
    metrics.hipsHeightRangeMeters = Number((maxY - minY).toFixed(4))
  }

  // 贴地：用归一化骨架正解算脚骨世界高度
  if (vrmRest && tracks.has('hips')) {
    const scale = (vrmRest.humanoid.hips?.position?.[1] ?? 1) / (clip.sourceHipsHeight || 1)
    const framesP = []
    for (let frame = 0; frame < frames; frame += 1) {
      const p = hips?.p ? hipsAt(hips.p, frame) : [0, 0, 0]
      framesP.push([p[0] * scale, p[1] * scale, p[2] * scale])
    }
    const simulated = simulateNormalizedHumanoid(vrmRest, tracks, frames, framesP)
    const footBones = ['leftFoot', 'leftToes', 'rightFoot', 'rightToes'].filter(
      (name) => vrmRest.humanoid[name] && tracks.has(name)
    )
    if (footBones.length > 0) {
      const restY = footBones.map((name) => vrmRest.humanoid[name].position[1])
      let minError = Infinity
      let maxError = -Infinity
      for (let frame = 0; frame < frames; frame += 1) {
        let minDelta = Infinity
        footBones.forEach((name, index) => {
          const pos = simulated[frame].worldPos.get(name)
          if (pos) minDelta = Math.min(minDelta, pos[1] - restY[index])
        })
        if (!Number.isFinite(minDelta)) continue
        minError = Math.min(minError, minDelta)
        maxError = Math.max(maxError, minDelta)
      }
      metrics.ground = {
        mode: clip.grounding ?? 'none',
        footErrorMinMeters: Number.isFinite(minError) ? Number(minError.toFixed(4)) : null,
        footErrorMaxMeters: Number.isFinite(maxError) ? Number(maxError.toFixed(4)) : null,
        penetrationMeters: Number.isFinite(minError) ? Number(Math.max(0, -minError).toFixed(4)) : null,
        floatMeters: Number.isFinite(maxError) ? Number(Math.max(0, maxError).toFixed(4)) : null
      }
    }
  }

  if (!clip.raw && clip.rawPolicy === 'spring') {
    metrics.raw = { policy: 'spring', bones: 0, categories: { hair: 0, cloth: 0, other: 0 }, maxSwingDeg: { hair: 0, cloth: 0, other: 0 }, firstFrameViolations: 0 }
  }
  // raw 次级骨运动量
  if (clip.raw && typeof clip.raw === 'object') {
    const categories = { hair: 0, cloth: 0, other: 0 }
    const maxDeg = { hair: 0, cloth: 0, other: 0 }
    let firstFrameViolation = 0
    for (const [nodeName, track] of Object.entries(clip.raw)) {
      const category = classifyVrmSecondaryNode(nodeName)
      categories[category] = (categories[category] ?? 0) + 1
      const first = quatAt(track, 0)
      if (qAngleDeg(first, [0, 0, 0, 1]) > CLIP_QA_LIMITS.rawRelativeFirstFrameMaxDeg) firstFrameViolation += 1
      let maxAngle = 0
      for (let frame = 1; frame < frames; frame += 1) {
        maxAngle = Math.max(maxAngle, qAngleDeg(quatAt(track, frame - 1), quatAt(track, frame)))
      }
      // 相对首帧的总摆幅
      let swing = 0
      for (let frame = 0; frame < frames; frame += 1) swing = Math.max(swing, qAngleDeg(first, quatAt(track, frame)))
      maxDeg[category] = Math.max(maxDeg[category], swing)
    }
    metrics.raw = {
      bones: Object.keys(clip.raw).length,
      categories,
      maxSwingDeg: {
        hair: Number(maxDeg.hair.toFixed(1)),
        cloth: Number(maxDeg.cloth.toFixed(1)),
        other: Number(maxDeg.other.toFixed(1))
      },
      firstFrameViolations: firstFrameViolation
    }
  }
  return metrics
}

/** 分级：PASS / WARN / FAIL。 */
export function gradeClip(clip, vrmRest) {
  const validation = validateClipStructure(clip, vrmRest)
  const metrics = computeClipMetrics(clip, vrmRest)
  const errors = [...validation.errors]
  const warnings = [...validation.warnings]
  const limits = CLIP_QA_LIMITS
  if (metrics.loopSeamDeg !== null) {
    if (metrics.loopSeamDeg > limits.loopSeamFailDeg) errors.push(`循环接缝 ${metrics.loopSeamDeg}° > ${limits.loopSeamFailDeg}°`)
    else if (metrics.loopSeamDeg > limits.loopSeamWarnDeg) warnings.push(`循环接缝 ${metrics.loopSeamDeg}° > ${limits.loopSeamWarnDeg}°`)
  }
  if (metrics.maxFrameJumpDeg > limits.frameJumpFailDeg) {
    errors.push(`帧跳变 ${metrics.maxFrameJumpDeg}°（${metrics.maxFrameJumpBone} @${metrics.maxFrameJumpFrame}）`)
  } else if (metrics.maxFrameJumpDeg > limits.frameJumpWarnDeg) {
    warnings.push(`帧跳变 ${metrics.maxFrameJumpDeg}°（${metrics.maxFrameJumpBone} @${metrics.maxFrameJumpFrame}）`)
  }
  if (metrics.ground && clip.grounding === 'feet') {
    if ((metrics.ground.penetrationMeters ?? 0) > limits.groundPenetrationWarnMeters) {
      warnings.push(`贴地：穿地 ${metrics.ground.penetrationMeters}m > ${limits.groundPenetrationWarnMeters}m`)
    }
    if ((metrics.ground.floatMeters ?? 0) > limits.groundFloatWarnMeters) {
      warnings.push(`贴地：悬空 ${metrics.ground.floatMeters}m > ${limits.groundFloatWarnMeters}m`)
    }
  }
  if (metrics.raw) {
    const springPolicy = metrics.raw.policy === 'spring'
    if (metrics.raw.bones === 0 && !springPolicy) warnings.push('raw 次级骨为空（头发/衣摆不会动）')
    if (metrics.raw.firstFrameViolations > 0) {
      warnings.push(`${metrics.raw.firstFrameViolations} 条 raw 轨道首帧非 identity`)
    }
  }
  const status = errors.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS'
  return { status, errors, warnings, validation: validation.stats, metrics }
}

/** 校验结果表（CLI 打印）。 */
export function formatResults(results) {
  const lines = []
  const header = ['clip', 'frames', 'humanoid', 'raw', 'maxJump', 'loopSeam', 'ground(m)', 'status']
  lines.push(header.join('\t'))
  for (const item of results) {
    const m = item.metrics
    const ground = m.ground
      ? `${m.ground.footErrorMinMeters ?? '-'}..${m.ground.footErrorMaxMeters ?? '-'}`
      : '-'
    lines.push(
      [
        item.clip,
        m.frames,
        item.validation.humanoidBones,
        item.validation.rawBones,
        `${m.maxFrameJumpDeg}°`,
        m.loopSeamDeg === null ? '-' : `${m.loopSeamDeg}°`,
        ground,
        item.status
      ].join('\t')
    )
    for (const error of item.errors) lines.push(`  FAIL ${error}`)
    for (const warning of item.warnings) lines.push(`  WARN ${warning}`)
  }
  return lines.join('\n')
}
