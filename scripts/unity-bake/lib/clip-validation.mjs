/**
 * Unity 烘焙 clip 数据校验（Wave 1.5 / U2）
 *
 * 纯 ESM：不 import node 内置模块/three，可被 Node CLI、vitest、浏览器直接使用。
 * 输入是 `assets/motions/<set>/<clip>.json`（U1/U2 导出 + convert-clips.mjs 转换后的
 * 形状），详见 `scripts/unity-bake/README.md` 的「输出 schema」。
 *
 * 骨骼轨道支持两种 JSON 形状（convert-clips.mjs 当前输出 nested；历史文档写 flat）：
 * - nested：`r = [[x,y,z,w], ...]`（长度 = frames）、`p = [[dx,dy,dz], ...]`（长度 = frames）；
 * - flat：  `r = [x,y,z,w, ...]`（长度 = frames*4）、`p = [dx,dy,dz, ...]`（长度 = frames*3）。
 * 校验按实际形状检查长度与元素，两种都合法。
 *
 * 核心 API：
 * - `validateClipData(clip, options?) → { ok, errors, warnings, stats }`
 * - `computeRotationMetrics(bones, frames)`：四元数模长/跳变/首末帧差统计
 * - `computeHipsStats(bones, frames)`：Hips 位移统计
 *
 * 规则（错误 = 数据不可用；警告 = 可用但天然度可疑，交给 C lane 人工复核）：
 * - `version === 1`、`space === 'gltf-rh'`、`loop` 布尔、`fps > 0`、`frames` 正整数、`duration > 0`；
 * - `frames` 与 `duration*fps` 一致：loop 期望 `round(duration*fps)`，非 loop 期望
 *   `round(duration*fps)+1`（末帧包含语义）；容差默认 ±1 帧，用于吸收 Unity
 *   `Mathf.RoundToInt`（banker's rounding）与 JS `Math.round` 在 .5 边界的差异；
 * - `bones` 含 22 个必需骨（缺一 = error；传入自定义 `requiredBones` 时，其余已知骨
 *   视为可选骨，缺失 = warning）；未知骨 = warning（播放时忽略）；
 * - 每骨 `r` 长度/元素合法、全有限、四元数模长 ≈1（默认容差 1e-3）；
 * - 相邻帧四元数 dot ≥ 0（连续性，违反 = error）；相邻帧夹角 >60°（默认）= warning；
 * - 仅 Hips 允许 `p`；长度/元素合法、全有限、首帧 ≈0（默认 1e-3m）；单帧位移 >0.1m /
 *   总位移 >25m / loop 首末水平漂移 >0.1m = warning；
 * - loop clip 末帧与首帧**几乎完全相同**（全部骨差 <0.01°）= warning（疑似重复帧，
 *   播循环时会有 1 帧停顿）；接缝差 >45° = warning（循环顿挫）；
 * - 非 loop clip 最后两帧几乎相同（<0.01°）= warning（结尾僵住）。
 *
 * 说明：`p` 是「相对首帧」的位移（convert-clips.mjs `--hips-mode relative`），因此
 * 首帧归零是 hard check；坐/躺的绝对高度由 app 摆放，不在数据校验范围。
 */
import {
  CLIP_BONE_NAMES,
  UNITY_TO_VRM_BONE,
  CLIP_REQUIRED_BONES
} from './humanoid-map.mjs'

/** 默认阈值；单测可用 `options.limits` 覆盖（不建议生产覆盖）。 */
export const CLIP_VALIDATION_LIMITS = Object.freeze({
  /** 四元数模长允许偏差。 */
  quatNormTolerance: 1e-3,
  /** frames 与 duration*fps 的允许偏差（帧）；见文件头 .5 舍入说明。 */
  frameCountToleranceFrames: 1,
  /** 相邻帧旋转角超过该值 → warning（度）。 */
  frameJumpWarnDeg: 60,
  /** Hips p 首帧模长允许偏差（米）。 */
  hipsFirstFrameToleranceMeters: 1e-3,
  /** Hips 单帧位移上限（米）→ warning。 */
  hipsMaxStepMeters: 0.1,
  /** Hips 总路径长度上限（米）→ warning。 */
  hipsMaxTravelMeters: 25,
  /** loop clip 首末帧最大差小于该值 → warning（疑似重复帧，度）。 */
  loopDuplicateSeamDeg: 0.01,
  /** loop clip 首末帧最大差大于该值 → warning（循环接缝跳变，度）。 */
  loopSeamJumpWarnDeg: 45,
  /** 非 loop clip 最后两帧最大差小于该值 → warning（度）。 */
  nonLoopEndHoldDeg: 0.01,
  /** loop clip 首末 Hips 水平位置差上限（米）→ warning。 */
  loopHipsNetDriftMeters: 0.1
})

/** 四元数 `[x,y,z,w]` 的模长。 */
export function quatNorm(q) {
  return Math.hypot(q[0], q[1], q[2], q[3])
}

/** 四元数点积（`[x,y,z,w]`）。 */
export function quatDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/**
 * 两个四元数之间的旋转角（度，0–180）。用 |dot| 处理 q 与 -q 等价（不关心符号）。
 * 非有限输入返回 NaN。
 */
export function quatAngleDeg(a, b) {
  const d = Math.abs(quatDot(a, b))
  if (!Number.isFinite(d)) return NaN
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFiniteVec(value, length) {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber)
}

/**
 * 分析 `r` 轨道形状。
 * @param {unknown} r
 * @returns {{
 *   shape: 'missing' | 'nested' | 'flat' | 'unsupported',
 *   frames: number,
 *   length: number,
 *   badIndex: number | null,
 *   quatAt: (frame: number) => number[] | null
 * }}
 */
function analyzeRotationTrack(r) {
  const base = { shape: 'missing', frames: 0, length: 0, badIndex: null, quatAt: () => null }
  if (r === undefined || r === null) return base
  if (!Array.isArray(r)) return { ...base, shape: 'unsupported', length: -1 }
  const length = r.length
  if (length === 0) return { ...base, shape: 'nested', length: 0 }

  if (Array.isArray(r[0])) {
    let badIndex = null
    for (let f = 0; f < length; f += 1) {
      if (!isFiniteVec(r[f], 4)) {
        badIndex = f
        break
      }
    }
    return {
      shape: 'nested',
      frames: length,
      length,
      badIndex,
      quatAt: (frame) => (isFiniteVec(r[frame], 4) ? r[frame] : null)
    }
  }
  if (isFiniteNumber(r[0])) {
    let badIndex = null
    for (let i = 0; i < length; i += 1) {
      if (!isFiniteNumber(r[i])) {
        badIndex = i
        break
      }
    }
    return {
      shape: 'flat',
      frames: Math.floor(length / 4),
      length,
      badIndex,
      quatAt: (frame) => {
        const i = frame * 4
        return i + 3 < length ? [r[i], r[i + 1], r[i + 2], r[i + 3]] : null
      }
    }
  }
  return { ...base, shape: 'unsupported', length }
}

/**
 * 分析 `p` 轨道形状。
 * @param {unknown} p
 * @returns {{
 *   shape: 'missing' | 'nested' | 'flat' | 'unsupported',
 *   frames: number,
 *   length: number,
 *   badIndex: number | null,
 *   vecAt: (frame: number) => number[] | null
 * }}
 */
function analyzePositionTrack(p) {
  const base = { shape: 'missing', frames: 0, length: 0, badIndex: null, vecAt: () => null }
  if (p === undefined || p === null) return base
  if (!Array.isArray(p)) return { ...base, shape: 'unsupported', length: -1 }
  const length = p.length
  if (length === 0) return { ...base, shape: 'nested', length: 0 }
  if (Array.isArray(p[0])) {
    let badIndex = null
    for (let f = 0; f < length; f += 1) {
      if (!isFiniteVec(p[f], 3)) {
        badIndex = f
        break
      }
    }
    return {
      shape: 'nested',
      frames: length,
      length,
      badIndex,
      vecAt: (frame) => (isFiniteVec(p[frame], 3) ? p[frame] : null)
    }
  }
  if (isFiniteNumber(p[0])) {
    let badIndex = null
    for (let i = 0; i < length; i += 1) {
      if (!isFiniteNumber(p[i])) {
        badIndex = i
        break
      }
    }
    return {
      shape: 'flat',
      frames: Math.floor(length / 3),
      length,
      badIndex,
      vecAt: (frame) => {
        const i = frame * 3
        return i + 2 < length ? [p[i], p[i + 1], p[i + 2]] : null
      }
    }
  }
  return { ...base, shape: 'unsupported', length }
}

/**
 * 描述轨道期望长度（用于错误信息）。
 * @param {'nested' | 'flat'} shape
 * @param {number} frames
 * @param {number} components 4（r）或 3（p）
 */
function expectedTrackLength(shape, frames, components) {
  return shape === 'flat' ? frames * components : frames
}

/**
 * 四元数全局统计 + 相邻帧连续性 + 首末帧差。
 *
 * @param {unknown} bones clip JSON 的 `bones`
 * @param {number} frames 期望帧数（非法时按各骨可用长度退化计算）
 * @returns {{
 *   frameCount: number,
 *   quatNorm: { min: number | null, max: number | null, mean: number | null, count: number },
 *   maxFrameJumpDeg: number | null,
 *   maxFrameJumpBone: string | null,
 *   maxFrameJumpFrame: number | null,
 *   minAdjacentDot: number | null,
 *   firstLastMaxAngleDeg: number | null,
 *   firstLastBone: string | null
 * }}
 */
export function computeRotationMetrics(bones, frames) {
  const validFrames = Number.isInteger(frames) && frames > 0 ? frames : 0
  let normMin = Infinity
  let normMax = -Infinity
  let normSum = 0
  let normCount = 0
  let maxJump = 0
  let maxJumpBone = null
  let maxJumpFrame = null
  let minDot = Infinity
  let firstLastMax = 0
  let firstLastBone = null

  const tracks = isRecord(bones) ? Object.entries(bones) : []
  for (const [boneName, track] of tracks) {
    if (!isRecord(track)) continue
    const rot = analyzeRotationTrack(track.r)
    if (rot.shape === 'missing' || rot.shape === 'unsupported') continue
    const usable = validFrames > 0 ? Math.min(validFrames, rot.frames) : rot.frames
    let prev = null
    for (let f = 0; f < usable; f += 1) {
      const q = rot.quatAt(f)
      if (q === null) {
        prev = null
        continue
      }
      const n = quatNorm(q)
      normMin = Math.min(normMin, n)
      normMax = Math.max(normMax, n)
      normSum += n
      normCount += 1
      if (prev !== null) {
        const dot = quatDot(q, prev)
        if (dot < minDot) minDot = dot
        const angle = quatAngleDeg(q, prev)
        if (Number.isFinite(angle) && angle > maxJump) {
          maxJump = angle
          maxJumpBone = boneName
          maxJumpFrame = f
        }
      }
      prev = q
    }
    if (usable >= 2) {
      const first = rot.quatAt(0)
      const last = rot.quatAt(usable - 1)
      if (first !== null && last !== null) {
        const angle = quatAngleDeg(first, last)
        if (Number.isFinite(angle) && angle > firstLastMax) {
          firstLastMax = angle
          firstLastBone = boneName
        }
      }
    }
  }

  return {
    frameCount: normCount,
    quatNorm: {
      min: normCount > 0 ? normMin : null,
      max: normCount > 0 ? normMax : null,
      mean: normCount > 0 ? normSum / normCount : null,
      count: normCount
    },
    maxFrameJumpDeg: normCount > 1 ? maxJump : null,
    maxFrameJumpBone: maxJumpBone,
    maxFrameJumpFrame: maxJumpFrame,
    minAdjacentDot: normCount > 1 ? minDot : null,
    firstLastMaxAngleDeg: normCount > 1 ? firstLastMax : null,
    firstLastBone
  }
}

/**
 * Hips 位移统计（`p`，单位米；坐标 = glTF 右手系，Y 上）。
 * 水平面 = XZ。缺失/非法 p 时各字段为 null。
 *
 * @param {unknown} bones
 * @param {number} frames
 * @returns {{
 *   hasHipsPosition: boolean,
 *   hipsTravel: number | null,
 *   hipsMaxStep: number | null,
 *   hipsLateralDrift: number | null,
 *   hipsHeightRange: number | null,
 *   hipsNetDrift: number | null,
 *   hipsFirstOffset: number | null
 * }}
 */
export function computeHipsStats(bones, frames) {
  const empty = {
    hasHipsPosition: false,
    hipsTravel: null,
    hipsMaxStep: null,
    hipsLateralDrift: null,
    hipsHeightRange: null,
    hipsNetDrift: null,
    hipsFirstOffset: null
  }
  if (!isRecord(bones) || !isRecord(bones.Hips)) return empty
  const pos = analyzePositionTrack(bones.Hips.p)
  if (pos.shape === 'missing' || pos.shape === 'unsupported' || pos.badIndex !== null || pos.frames < 1) {
    return empty
  }
  const validFrames = Number.isInteger(frames) && frames > 0 ? frames : 0
  const usable = validFrames > 0 ? Math.min(validFrames, pos.frames) : pos.frames
  if (usable < 1) return empty

  const first = pos.vecAt(0)
  let travel = 0
  let maxStep = 0
  let lateral = 0
  let yMin = first[1]
  let yMax = first[1]
  let prev = first
  for (let f = 0; f < usable; f += 1) {
    const cur = pos.vecAt(f)
    if (cur === null) return empty
    yMin = Math.min(yMin, cur[1])
    yMax = Math.max(yMax, cur[1])
    lateral = Math.max(lateral, Math.hypot(cur[0] - first[0], cur[2] - first[2]))
    if (f > 0) {
      const step = Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2])
      travel += step
      maxStep = Math.max(maxStep, step)
    }
    prev = cur
  }
  const last = prev
  return {
    hasHipsPosition: true,
    hipsTravel: travel,
    hipsMaxStep: maxStep,
    hipsLateralDrift: lateral,
    hipsHeightRange: yMax - yMin,
    hipsNetDrift: Math.hypot(last[0] - first[0], last[2] - first[2]),
    hipsFirstOffset: Math.hypot(first[0], first[1], first[2])
  }
}

/**
 * 校验单个 clip JSON。
 *
 * @param {unknown} clip
 * @param {{
 *   requiredBones?: readonly string[],
 *   optionalBones?: readonly string[],
 *   limits?: Partial<typeof CLIP_VALIDATION_LIMITS>
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   stats: Record<string, unknown>
 * }}
 */
export function validateClipData(clip, options = {}) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {Record<string, unknown>} */
  const stats = {
    version: null,
    space: null,
    fps: null,
    frames: null,
    duration: null,
    frameDurationSec: null,
    boneCount: 0,
    missingBones: [],
    extraBones: [],
    quatNorm: { min: null, max: null, mean: null, count: 0 },
    minAdjacentDot: null,
    maxFrameJumpDeg: null,
    maxFrameJumpBone: null,
    maxFrameJumpFrame: null,
    firstLastMaxAngleDeg: null,
    loopSeamMaxAngleDeg: null,
    hasHipsPosition: false,
    hipsTravel: null,
    hipsMaxStep: null,
    hipsLateralDrift: null,
    hipsHeightRange: null,
    hipsNetDrift: null,
    hipsFirstOffset: null
  }
  const result = () => ({ ok: errors.length === 0, errors, warnings, stats })

  if (!isRecord(clip)) {
    errors.push('clip 数据不是对象')
    return result()
  }

  const limits = { ...CLIP_VALIDATION_LIMITS, ...(options.limits ?? {}) }
  const requiredBones = Array.isArray(options.requiredBones)
    ? options.requiredBones
    : CLIP_REQUIRED_BONES

  // ---------- 顶层字段 ----------
  stats.version = clip.version ?? null
  stats.space = clip.space ?? null
  if (clip.version !== 1) {
    errors.push(`version 必须是 1（实际 ${JSON.stringify(clip.version)}）`)
  }
  if (clip.space !== 'gltf-rh') {
    errors.push(`space 必须是 'gltf-rh'（实际 ${JSON.stringify(clip.space)}；Unity 左手系数据需要先过 convert-clips.mjs）`)
  }
  if (typeof clip.loop !== 'boolean') {
    errors.push(`loop 必须是布尔值（实际 ${JSON.stringify(clip.loop)}）`)
  }

  const fpsValid = isFiniteNumber(clip.fps) && clip.fps > 0
  if (fpsValid) stats.fps = clip.fps
  else errors.push(`fps 必须是正有限数（实际 ${JSON.stringify(clip.fps)}）`)

  const framesValid = Number.isInteger(clip.frames) && clip.frames > 0
  if (framesValid) stats.frames = clip.frames
  else errors.push(`frames 必须是正整数（实际 ${JSON.stringify(clip.frames)}）`)

  const durationValid = isFiniteNumber(clip.duration) && clip.duration > 0
  if (durationValid) stats.duration = clip.duration
  else errors.push(`duration 必须是正有限数（实际 ${JSON.stringify(clip.duration)}）`)

  const loop = clip.loop === true
  const frames = framesValid ? clip.frames : 0

  // frames ↔ duration*fps
  if (framesValid && fpsValid && durationValid) {
    const product = clip.duration * clip.fps
    const expected = Math.round(product) + (loop ? 0 : 1)
    const tolerance = limits.frameCountToleranceFrames
    if (Math.abs(clip.frames - expected) > tolerance) {
      errors.push(
        `frames 与 duration*fps 不一致：frames=${clip.frames}，期望 ≈${expected}` +
          `（duration=${clip.duration}, fps=${clip.fps}${loop ? '' : '，非 loop 末帧包含 +1'}，容差 ±${tolerance} 帧）`
      )
    }
    stats.frameDurationSec = clip.duration / clip.frames
  }

  // ---------- bones ----------
  const bones = clip.bones
  if (!isRecord(bones)) {
    errors.push('bones 必须是对象')
    return result()
  }
  const presentBones = Object.keys(bones)
  stats.boneCount = presentBones.length

  const requiredSet = new Set(requiredBones)
  const knownSet = new Set(CLIP_BONE_NAMES)
  /**
   * 可选骨：只有显式传入时才检查并提示缺失（默认 [] = 不提示），
   * 避免 22 骨老数据在 CLIP_BONE_NAMES 扩到 52（+30 手指）后被 30 条 warning 淹没。
   * 需要「手指必须齐全」的验收（如 mate 集）由 CLI 传 CLIP_OPTIONAL_BONES。
   */
  const optionalBones = Array.isArray(options.optionalBones) ? options.optionalBones : []
  const optionalSet = new Set(optionalBones)

  const missingBones = requiredBones.filter((b) => !Object.prototype.hasOwnProperty.call(bones, b))
  for (const b of missingBones) {
    errors.push(`缺少必需骨骼 ${b}（VRM ${UNITY_TO_VRM_BONE[b] ?? '?'}）`)
  }
  for (const b of optionalBones) {
    if (!Object.prototype.hasOwnProperty.call(bones, b)) warnings.push(`可选骨骼 ${b} 缺失（不影响播放，仅提示）`)
  }
  const extraBones = presentBones.filter((b) => !knownSet.has(b))
  for (const b of extraBones) {
    warnings.push(`未知骨骼 ${b}（不在 Unity↔VRM 映射内，播放时忽略）`)
  }
  stats.missingBones = missingBones
  stats.extraBones = extraBones

  const expectedRLength = framesValid ? frames * 4 : null
  const expectedPFlatLength = framesValid ? frames * 3 : null
  const frameJumpWarnDeg = limits.frameJumpWarnDeg
  const perBone = new Map() // boneName -> { maxJump, maxJumpFrame, minDot, dotBreakFrame }

  for (const boneName of presentBones) {
    const track = bones[boneName]
    if (!isRecord(track)) {
      errors.push(`${boneName}: 骨骼数据必须是对象`)
      continue
    }
    const rot = analyzeRotationTrack(track.r)
    if (rot.shape === 'missing') {
      errors.push(`${boneName}: 缺少 r 数组`)
    } else if (rot.shape === 'unsupported') {
      errors.push(`${boneName}: r 格式不支持（应为 [[x,y,z,w], ...] 或平铺 [x,y,z,w, ...]）`)
    } else {
      if (framesValid) {
        const expected = expectedTrackLength(rot.shape, frames, 4)
        if (rot.length !== expected) {
          errors.push(
            `${boneName}: r 长度 ${rot.length}，期望 ${rot.shape === 'flat' ? 'frames*4' : 'frames'}=${expected}`
          )
        }
        if (rot.shape === 'flat' && rot.length % 4 !== 0) {
          errors.push(`${boneName}: 平铺 r 长度 ${rot.length} 不是 4 的倍数`)
        }
      }
      if (rot.badIndex !== null) {
        errors.push(
          `${boneName}: r[${rot.badIndex}] 非法（${rot.shape === 'nested' ? '应为长度 4 的有限四元数数组；含非有限值或长度不为 4' : '应为有限数；含非有限值'}）`
        )
      } else {
        const usable = framesValid ? Math.min(frames, rot.frames) : rot.frames
        let normMin = Infinity
        let normMax = -Infinity
        for (let f = 0; f < usable; f += 1) {
          const q = rot.quatAt(f)
          if (q === null) continue
          const norm = quatNorm(q)
          normMin = Math.min(normMin, norm)
          normMax = Math.max(normMax, norm)
        }
        if (normMin !== Infinity) {
          if (
            Math.abs(normMin - 1) > limits.quatNormTolerance ||
            Math.abs(normMax - 1) > limits.quatNormTolerance
          ) {
            errors.push(
              `${boneName}: 四元数模长越界 [${normMin.toFixed(6)}, ${normMax.toFixed(6)}]，` +
                `容差 ±${limits.quatNormTolerance}`
            )
          }
        }
        // 相邻帧连续性
        const info = { maxJump: 0, maxJumpFrame: null, minDot: Infinity, dotBreakFrame: null }
        let prev = null
        for (let f = 0; f < usable; f += 1) {
          const q = rot.quatAt(f)
          if (q === null) {
            prev = null
            continue
          }
          if (prev !== null) {
            const dot = quatDot(q, prev)
            if (dot < info.minDot) info.minDot = dot
            if (dot < 0 && info.dotBreakFrame === null) info.dotBreakFrame = f
            const angle = quatAngleDeg(q, prev)
            if (Number.isFinite(angle) && angle > info.maxJump) {
              info.maxJump = angle
              info.maxJumpFrame = f
            }
          }
          prev = q
        }
        perBone.set(boneName, info)
      }
    }

    // 位移只允许 Hips
    if (boneName !== 'Hips' && track.p !== undefined) {
      errors.push(`${boneName}: 只有 Hips 允许 p（位移）`)
    }
  }

  // ---------- Hips p ----------
  const hipsTrack = isRecord(bones.Hips) ? bones.Hips : null
  if (hipsTrack && hipsTrack.p !== undefined) {
    const pos = analyzePositionTrack(hipsTrack.p)
    if (pos.shape === 'missing') {
      errors.push('Hips: p 必须是数组（[[dx,dy,dz], ...] 或平铺）')
    } else if (pos.shape === 'unsupported') {
      errors.push('Hips: p 格式不支持（应为 [[dx,dy,dz], ...] 或平铺 [dx,dy,dz, ...]）')
    } else {
      if (framesValid && pos.length !== expectedTrackLength(pos.shape, frames, 3)) {
        errors.push(
          `Hips: p 长度 ${pos.length}，期望 ${pos.shape === 'flat' ? 'frames*3' : 'frames'}=` +
            `${expectedTrackLength(pos.shape, frames, 3)}`
        )
      }
      if (pos.shape === 'flat' && pos.length % 3 !== 0) {
        errors.push(`Hips: 平铺 p 长度 ${pos.length} 不是 3 的倍数`)
      }
      if (pos.badIndex !== null) {
        errors.push(
          `Hips: p[${pos.badIndex}] 非法（${pos.shape === 'nested' ? '应为长度 3 的有限位移数组；含非有限值或长度不为 3' : '应为有限数；含非有限值'}）`
        )
      } else if (pos.frames >= 1) {
        const first = pos.vecAt(0)
        const firstOffset = Math.hypot(first[0], first[1], first[2])
        if (firstOffset > limits.hipsFirstFrameToleranceMeters) {
          errors.push(
            `Hips: p 首帧未归零（模长 ${firstOffset.toFixed(6)}m > ${limits.hipsFirstFrameToleranceMeters}m；` +
              `应使用 convert-clips.mjs --hips-mode relative）`
          )
        }
      }
    }
  }

  // ---------- 统计 ----------
  const rotation = computeRotationMetrics(bones, frames)
  const hips = computeHipsStats(bones, frames)
  Object.assign(stats, {
    quatNorm: rotation.quatNorm,
    minAdjacentDot: rotation.minAdjacentDot,
    maxFrameJumpDeg: rotation.maxFrameJumpDeg,
    maxFrameJumpBone: rotation.maxFrameJumpBone,
    maxFrameJumpFrame: rotation.maxFrameJumpFrame,
    firstLastMaxAngleDeg: rotation.firstLastMaxAngleDeg,
    loopSeamMaxAngleDeg: loop ? rotation.firstLastMaxAngleDeg : null,
    hasHipsPosition: hips.hasHipsPosition,
    hipsTravel: hips.hipsTravel,
    hipsMaxStep: hips.hipsMaxStep,
    hipsLateralDrift: hips.hipsLateralDrift,
    hipsHeightRange: hips.hipsHeightRange,
    hipsNetDrift: hips.hipsNetDrift,
    hipsFirstOffset: hips.hipsFirstOffset
  })

  // ---------- 连续性问题（按骨聚合，避免刷屏） ----------
  for (const [boneName, info] of perBone) {
    if (info.dotBreakFrame !== null) {
      errors.push(
        `${boneName}: 相邻帧四元数 dot<0（第 ${info.dotBreakFrame - 1}→${info.dotBreakFrame} 帧，` +
          `四元数符号翻转；convert-clips.mjs 的连续性修复未生效）`
      )
    }
    if (info.maxJump > frameJumpWarnDeg) {
      warnings.push(
        `${boneName}: 相邻帧旋转跳变 ${info.maxJump.toFixed(1)}° > ${frameJumpWarnDeg}°` +
          `（第 ${info.maxJumpFrame - 1}→${info.maxJumpFrame} 帧）`
      )
    }
  }

  // ---------- Hips 位移 warning ----------
  if (hips.hasHipsPosition) {
    if (hips.hipsMaxStep !== null && hips.hipsMaxStep > limits.hipsMaxStepMeters) {
      warnings.push(
        `Hips: 单帧位移 ${hips.hipsMaxStep.toFixed(3)}m > ${limits.hipsMaxStepMeters}m（疑似瞬移）`
      )
    }
    if (hips.hipsTravel !== null && hips.hipsTravel > limits.hipsMaxTravelMeters) {
      warnings.push(`Hips: 总位移 ${hips.hipsTravel.toFixed(2)}m > ${limits.hipsMaxTravelMeters}m`)
    }
    if (
      loop &&
      hips.hipsNetDrift !== null &&
      hips.hipsNetDrift > limits.loopHipsNetDriftMeters
    ) {
      warnings.push(
        `Hips: loop clip 首末水平漂移 ${hips.hipsNetDrift.toFixed(3)}m > ${limits.loopHipsNetDriftMeters}m（循环会滑移）`
      )
    }
  }

  // ---------- 首末帧（loop 重复帧 / 非 loop 结尾僵住） ----------
  if (framesValid && frames >= 2 && rotation.firstLastMaxAngleDeg !== null) {
    if (loop) {
      if (rotation.firstLastMaxAngleDeg < limits.loopDuplicateSeamDeg) {
        warnings.push(
          `loop clip 末帧与首帧几乎完全相同（最大差 ${rotation.firstLastMaxAngleDeg.toFixed(4)}° < ` +
            `${limits.loopDuplicateSeamDeg}°，疑似重复帧，循环播放会多停 1 帧）`
        )
      } else if (rotation.firstLastMaxAngleDeg > limits.loopSeamJumpWarnDeg) {
        warnings.push(
          `loop 接缝跳变 ${rotation.firstLastMaxAngleDeg.toFixed(1)}° > ${limits.loopSeamJumpWarnDeg}°` +
            `（骨 ${rotation.firstLastBone}，循环播放会顿挫）`
        )
      }
    } else {
      let endHoldMax = -1
      let endHoldBone = null
      for (const boneName of presentBones) {
        const track = bones[boneName]
        if (!isRecord(track)) continue
        const rot = analyzeRotationTrack(track.r)
        if (rot.shape === 'missing' || rot.shape === 'unsupported') continue
        const usable = Math.min(frames, rot.frames)
        if (usable < 2) continue
        const last = rot.quatAt(usable - 1)
        const prev = rot.quatAt(usable - 2)
        if (last === null || prev === null) continue
        const angle = quatAngleDeg(last, prev)
        if (Number.isFinite(angle) && angle > endHoldMax) {
          endHoldMax = angle
          endHoldBone = boneName
        }
      }
      if (endHoldBone !== null && endHoldMax < limits.nonLoopEndHoldDeg) {
        warnings.push(
          `非 loop clip 最后两帧几乎相同（最大差 ${endHoldMax.toFixed(4)}° < ` +
            `${limits.nonLoopEndHoldDeg}°，结尾停在僵直姿势）`
        )
      }
    }
  }

  return result()
}
