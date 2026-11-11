/**
 * VRM humanoid clip 数据解析与采样（V1 运行时，Wave 2 / clip-engine）
 *
 * **纯逻辑模块**：不 import three / DOM / Electron / node:*，因此可在 Node 单测里直接
 * 用合成 clip JSON 验证（`tests/vrm-clip-data.test.ts`）。运行时由 `clip-player.ts`
 * 消费，把结果写进 three-vrm 的 normalized humanoid 骨骼。
 *
 * 数据口径（`docs/wave2-vrm-runtime-design.md` §2.2、`docs/vrm-motion-hsr.md` §2）：
 * - clip JSON 支持 `r`（相对 rest 的归一化局部旋转四元数 `[x,y,z,w]`）与仅 Hips 的
 *   `p`（米、已减首帧基准、in-place）；两者都兼容 **nested**（`[[x,y,z,w],…]`）与
 *   **flat**（`[x,y,z,w,…]`）两种数组形状；
 * - 播放时 Hips 位移缩放 = `avatar.hipsRestHeight / clip.sourceHipsHeight`
 *   （官方 three-vrm Mixamo 例 / UniVRM Vrm10Retarget 口径；见 clip-viewer.js L440–470）；
 * - `grounding === 'feet'` 的贴地由播放器按「每 clip 常量补偿」处理，本模块只透传字段。
 *
 * 解析策略：**永不抛异常**；坏数据只产生 error（clip 不可用 → 播放器保持当前/降级）
 * 或 warning（可用但可疑）。错误信息为中文，便于 registry 统一 warn 一次。
 */

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

import { normalizeClipBoneName } from './humanoid-map'

/** 归一化局部旋转四元数（`[x, y, z, w]`，gltf-rh）。 */
export type Quat4 = [number, number, number, number]
/** 三维向量（米）。 */
export type Vec3 = [number, number, number]

/** 单根骨的解析后轨道（Float64Array，按帧连续存储，避免逐帧嵌套数组的开销）。 */
export interface ParsedBoneTrack {
  /** 归一化旋转：长度 = `frames * 4`，元素顺序 `x,y,z,w`。 */
  readonly rotations: Float64Array
  /** Hips 位移：长度 = `frames * 3`（米，相对首帧）；非 Hips / 无 p 时为 null。 */
  readonly positions: Float64Array | null
}

/** 解析后的 clip（运行时播放只需要这些字段）。 */
export interface ParsedClip {
  /** clip 名（JSON 的 `clip` 字段；缺省空串）。 */
  readonly clip: string
  /** 帧率（1/秒）。 */
  readonly fps: number
  /** 帧数（>= 1）。 */
  readonly frames: number
  /** 时长（秒；缺失时按 `frames / fps` 回填）。 */
  readonly duration: number
  /** 是否循环（JSON 字段；实际播放以 manifest 条目为准）。 */
  readonly loop: boolean
  /** 源骨架 hips 高度（米；Hips.p 缩放基准）。 */
  readonly sourceHipsHeight: number
  /** 源骨架身高（米；仅调试/校验参考，缺失为 null）。 */
  readonly sourceHeight: number | null
  /** 贴地策略：`feet` = 播放器按首帧脚骨常量补偿；`none` = 不补偿。 */
  readonly grounding: 'feet' | 'none'
  /** 次级骨策略：`spring` = 不写 raw（three-vrm SpringBone 驱动）；`baked` = 数据含 raw（V1 忽略）。 */
  readonly rawPolicy: 'spring' | 'baked'
  /** Unity HumanBodyBones 名 → 轨道。 */
  readonly bones: ReadonlyMap<string, ParsedBoneTrack>
}

/** 解析结果（`value === null` 表示 clip 不可用）。 */
export interface ClipParseResult {
  value: ParsedClip | null
  /** 数据错误（clip 不可用）。 */
  errors: string[]
  /** 数据可疑但可播放（未知骨/字段缺省等）。 */
  warnings: string[]
}

/** 当前帧插值信息：第 `f0`/`f1` 帧之间按 `a`（0–1）插值。 */
export interface ClipFrameIndex {
  f0: number
  f1: number
  /** 帧间权重（0–1）。 */
  a: number
}

/* -------------------------------------------------------------------------- */
/* 默认值 / 常量                                                               */
/* -------------------------------------------------------------------------- */

/** 源骨架 hips 高度缺省值（米）：U1 的 ClipExporter 合成骨架 hips 高度 = 1.0。 */
export const DEFAULT_SOURCE_HIPS_HEIGHT = 1

/** 合法贴地策略。 */
const GROUNDING_VALUES = ['feet', 'none'] as const
/** 合法次级骨策略。 */
const RAW_POLICY_VALUES = ['spring', 'baked'] as const

/** 是否有限数字。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 是否普通对象（非 null / 非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* -------------------------------------------------------------------------- */
/* 数组轨道解析（nested / flat 两种形状）                                        */
/* -------------------------------------------------------------------------- */

interface TrackShapeInfo {
  shape: 'nested' | 'flat'
  /** 实际可读帧数（`length / components` 向下取整或 nested 长度）。 */
  availableFrames: number
  /** 首个非法元素信息（null = 全部合法）。 */
  badElement: string | null
}

/**
 * 探测轨道形状并校验元素（只校验前 `maxFrames` 帧，避免异常大数组的线性扫描）。
 * 空数组/非数组返回 null。
 */
function analyzeTrack(
  raw: unknown,
  components: 3 | 4,
  maxFrames: number
): TrackShapeInfo | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const first = raw[0]
  if (Array.isArray(first)) {
    // nested：[[...], ...]
    let badElement: string | null = null
    const limit = Math.min(raw.length, maxFrames)
    for (let frame = 0; frame < limit; frame += 1) {
      const entry = raw[frame] as unknown
      if (
        !Array.isArray(entry) ||
        entry.length !== components ||
        !entry.every(isFiniteNumber)
      ) {
        badElement = `第 ${frame} 帧不是长度 ${components} 的有限数字数组`
        return { shape: 'nested', availableFrames: raw.length, badElement }
      }
    }
    return { shape: 'nested', availableFrames: raw.length, badElement }
  }
  if (isFiniteNumber(first)) {
    // flat：[x,y,z,w, x,y,z,w, ...]
    const limit = Math.min(raw.length, maxFrames * components)
    let badElement: string | null = null
    for (let index = 0; index < limit; index += 1) {
      if (!isFiniteNumber(raw[index])) {
        badElement = `第 ${index} 个元素不是有限数字`
        return { shape: 'flat', availableFrames: Math.floor(raw.length / components), badElement }
      }
    }
    return {
      shape: 'flat',
      availableFrames: Math.floor(raw.length / components),
      badElement
    }
  }
  return { shape: 'flat', availableFrames: 0, badElement: '数组元素既不是数字也不是数组' }
}

/**
 * 把原始轨道转成 Float64Array（长度 = `frames * components`）。
 * @returns 目标数组；数据不可用时 null（错误写进 `errors`）。
 */
function buildTrackArray(
  raw: unknown,
  components: 3 | 4,
  frames: number,
  label: string,
  warnings: string[]
): Float64Array | null {
  const info = analyzeTrack(raw, components, frames)
  if (info === null) return null
  const requiredLength = frames * components
  if (info.badElement !== null) {
    warnings.push(`${label}: ${info.badElement}（已丢弃该轨道）`)
    return null
  }
  if (info.shape === 'nested') {
    if (info.availableFrames < frames) return null
    if (info.availableFrames > frames) {
      warnings.push(`${label}: 帧数 ${info.availableFrames} 多于 clip.frames=${frames}，忽略多余帧`)
    }
    const out = new Float64Array(requiredLength)
    for (let frame = 0; frame < frames; frame += 1) {
      const entry = (raw as unknown[])[frame] as number[]
      out[frame * components] = entry[0]
      out[frame * components + 1] = entry[1]
      out[frame * components + 2] = entry[2]
      if (components === 4) out[frame * components + 3] = entry[3]
    }
    return out
  }
  const flat = raw as number[]
  if (flat.length < requiredLength) return null
  if (flat.length > requiredLength) {
    warnings.push(`${label}: 平铺长度 ${flat.length} 多于期望 ${requiredLength}，忽略多余元素`)
  }
  const out = new Float64Array(requiredLength)
  for (let index = 0; index < requiredLength; index += 1) out[index] = flat[index]
  return out
}

/* -------------------------------------------------------------------------- */
/* 解析                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 解析一个 clip JSON。**永不抛异常**。
 *
 * 硬性错误（`value === null`）：不是对象 / `version !== 1` / `fps` 非正 / `frames` 非正整数 /
 * `bones` 非对象 / 任何骨缺 `r` 或 `r` 形状非法 / `space` 显式给出但不是 `gltf-rh`。
 * 其余问题按 warning 处理（未知骨忽略、非 Hips 的 `p` 忽略、缺省字段回填）。
 */
export function parseClipData(input: unknown): ClipParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  const fail = (): ClipParseResult => ({ value: null, errors, warnings })

  if (!isRecord(input)) {
    errors.push('clip 数据不是对象')
    return fail()
  }
  if (input['version'] !== 1) {
    errors.push(`version 必须是 1（实际 ${JSON.stringify(input['version'])}）`)
  }
  const fps = input['fps']
  if (!isFiniteNumber(fps) || fps <= 0) {
    errors.push(`fps 必须是正有限数（实际 ${JSON.stringify(fps)}）`)
  }
  const framesRaw = input['frames']
  if (!Number.isInteger(framesRaw) || (framesRaw as number) <= 0) {
    errors.push(`frames 必须是正整数（实际 ${JSON.stringify(framesRaw)}）`)
  }
  const space = input['space']
  if (space !== undefined && space !== 'gltf-rh') {
    errors.push(`space 必须是 'gltf-rh'（实际 ${JSON.stringify(space)}）`)
  } else if (space === undefined) {
    warnings.push("space 缺失，按 'gltf-rh' 处理")
  }
  const bonesRaw = input['bones']
  if (!isRecord(bonesRaw)) {
    errors.push('bones 必须是对象')
  }
  if (errors.length > 0) return fail()

  const frames = framesRaw as number
  const safeFps = fps as number

  // ---- 基础字段（缺省回填） ----
  let loop = false
  if (typeof input['loop'] === 'boolean') loop = input['loop']
  else warnings.push('loop 缺失/非布尔，按 false 处理')

  let duration = frames / safeFps
  const durationRaw = input['duration']
  if (isFiniteNumber(durationRaw) && durationRaw > 0) duration = durationRaw
  else if (durationRaw !== undefined) warnings.push('duration 非法，按 frames/fps 回填')

  let sourceHipsHeight = DEFAULT_SOURCE_HIPS_HEIGHT
  const sourceHipsHeightRaw = input['sourceHipsHeight']
  if (isFiniteNumber(sourceHipsHeightRaw) && sourceHipsHeightRaw > 0) {
    sourceHipsHeight = sourceHipsHeightRaw
  } else if (sourceHipsHeightRaw !== undefined) {
    warnings.push(
      `sourceHipsHeight 非法，按 ${DEFAULT_SOURCE_HIPS_HEIGHT} 处理（Hips.p 缩放基准）`
    )
  }

  const sourceHeightRaw = input['sourceHeight']
  const sourceHeight = isFiniteNumber(sourceHeightRaw) && sourceHeightRaw > 0 ? sourceHeightRaw : null
  if (sourceHeightRaw !== undefined && sourceHeight === null) {
    warnings.push('sourceHeight 非法，忽略')
  }

  let grounding: ParsedClip['grounding'] = 'none'
  const groundingRaw = input['grounding']
  if (typeof groundingRaw === 'string') {
    if ((GROUNDING_VALUES as readonly string[]).includes(groundingRaw)) {
      grounding = groundingRaw as ParsedClip['grounding']
    } else {
      warnings.push(`grounding 非法值 ${JSON.stringify(groundingRaw)}，按 'none' 处理`)
    }
  }

  const rawExists =
    isRecord(input['raw']) && Object.keys(input['raw'] as Record<string, unknown>).length > 0
  let rawPolicy: ParsedClip['rawPolicy'] = rawExists ? 'baked' : 'spring'
  const rawPolicyRaw = input['rawPolicy']
  if (typeof rawPolicyRaw === 'string') {
    if ((RAW_POLICY_VALUES as readonly string[]).includes(rawPolicyRaw)) {
      rawPolicy = rawPolicyRaw as ParsedClip['rawPolicy']
    } else {
      warnings.push(`rawPolicy 非法值 ${JSON.stringify(rawPolicyRaw)}，按推导值 ${rawPolicy} 处理`)
    }
  }

  let clipName = ''
  if (typeof input['clip'] === 'string' && input['clip'].trim().length > 0) {
    clipName = input['clip'].trim()
  } else {
    warnings.push('clip 名缺失，按空串处理（仅影响调试显示）')
  }

  // ---- bones ----
  const bones = new Map<string, ParsedBoneTrack>()
  const rawBoneNames = Object.keys(bonesRaw as Record<string, unknown>)
  for (const [rawBoneName, trackRaw] of Object.entries(bonesRaw as Record<string, unknown>)) {
    if (!isRecord(trackRaw)) {
      warnings.push(`${rawBoneName}: 轨道不是对象，已忽略`)
      continue
    }
    // 骨名归一到 Unity 规范键：mate 集是 Unity 名；HSR 集拇指是「VRM 风格」
    // （LeftThumbMetacarpal/Proximal/Distal），见 humanoid-map.ts 的 normalizeClipBoneName。
    const boneName = normalizeClipBoneName(rawBoneName, rawBoneNames)
    if (bones.has(boneName)) {
      warnings.push(`${rawBoneName}: 归一后与已存在的 ${boneName} 重复，已忽略`)
      continue
    }
    const rotations = buildTrackArray(
      trackRaw['r'],
      4,
      frames,
      `${boneName}.r`,
      warnings
    )
    if (rotations === null) {
      // r 缺失/形状非法 = 该骨不可用（不拖垮整个 clip：播放时按 rest 处理）
      warnings.push(`${boneName}: 缺少可解析的 r（长度应 = frames${frames} 或 frames*4），按 rest 处理`)
      continue
    }
    let positions: Float64Array | null = null
    if (trackRaw['p'] !== undefined) {
      if (boneName !== 'Hips') {
        warnings.push(`${boneName}: 只有 Hips 允许 p（位移），已忽略`)
      } else {
        positions = buildTrackArray(trackRaw['p'], 3, frames, 'Hips.p', warnings)
        if (positions === null) warnings.push('Hips.p: 形状非法，忽略位移')
      }
    }
    bones.set(boneName, { rotations, positions })
  }
  if (bones.size === 0) {
    errors.push('bones 中没有任何可解析的骨骼轨道')
    return fail()
  }

  return {
    value: {
      clip: clipName,
      fps: safeFps,
      frames,
      duration,
      loop,
      sourceHipsHeight,
      sourceHeight,
      grounding,
      rawPolicy,
      bones
    },
    errors,
    warnings
  }
}

/* -------------------------------------------------------------------------- */
/* 帧索引 / 时长 / Hips 缩放                                                    */
/* -------------------------------------------------------------------------- */

/** clip 一个循环的时长（秒，= `frames / fps`；与参考实现 `frameIndex` 同口径）。 */
export function clipDurationSec(clip: Pick<ParsedClip, 'frames' | 'fps'>): number {
  if (!isFiniteNumber(clip.fps) || clip.fps <= 0 || !isFiniteNumber(clip.frames)) return 0
  return clip.frames / clip.fps
}

/**
 * 时间（秒）→ 帧间插值信息。
 *
 * 与参考实现（`scripts/unity-bake/clip-viewer.js` L181–190、
 * `scripts/vrm/motion/viewer.js` L105–114）一致：
 * - loop：先按 `frames / fps` 取模（负数也安全）；
 * - one-shot：时间钳制到 `[0, (frames-1)/fps]`（末帧包含语义，与数据校验的
 *   `round(duration*fps)+1` 一致），播完停在最后一帧。
 */
export function frameIndex(
  clip: Pick<ParsedClip, 'frames' | 'fps' | 'loop'>,
  timeSec: number
): ClipFrameIndex {
  const frames = Number.isFinite(clip.frames) ? Math.max(1, Math.floor(clip.frames)) : 1
  const fps = isFiniteNumber(clip.fps) && clip.fps > 0 ? clip.fps : 1
  const dur = frames / fps
  const t = Number.isFinite(timeSec) ? timeSec : 0
  const local = clip.loop
    ? ((t % dur) + dur) % dur
    : Math.min(Math.max(t, 0), (frames - 1) / fps)
  const f = local * fps
  const f0 = Math.min(frames - 1, Math.max(0, Math.floor(f)))
  const f1 = Math.min(f0 + 1, frames - 1)
  return { f0, f1, a: Math.min(1, Math.max(0, f - f0)) }
}

/**
 * Hips 位移缩放系数 = `hipsRestHeight / sourceHipsHeight`（米 → 米）。
 * 目标 hips 高度非法/缺失时回退 1；源 hips 高度非正时回退 1。
 */
export function hipsPositionScale(
  clip: Pick<ParsedClip, 'sourceHipsHeight'>,
  hipsRestHeightMeters: number
): number {
  const source =
    isFiniteNumber(clip.sourceHipsHeight) && clip.sourceHipsHeight > 0
      ? clip.sourceHipsHeight
      : 1
  const rest =
    isFiniteNumber(hipsRestHeightMeters) && hipsRestHeightMeters > 0
      ? hipsRestHeightMeters
      : 1
  return rest / source
}

/* -------------------------------------------------------------------------- */
/* 四元数 / 向量插值                                                            */
/* -------------------------------------------------------------------------- */

/** 把 `[x,y,z,w]` 归一化（零四元数回退单位四元数）。 */
function normalizeQuat(q: Quat4): Quat4 {
  const length = Math.hypot(q[0], q[1], q[2], q[3])
  if (length < 1e-12) {
    q[0] = 0
    q[1] = 0
    q[2] = 0
    q[3] = 1
    return q
  }
  q[0] /= length
  q[1] /= length
  q[2] /= length
  q[3] /= length
  return q
}

/**
 * 四元数短弧球面插值：`out = slerp(a, b, t)`（处理 q/-q 等价与近似线性区间）。
 * 数组必须长度 >= 4；返回 `out`。
 */
export function slerpQuat(a: readonly number[], b: readonly number[], t: number, out: Quat4): Quat4 {
  const aa = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  let bx = b[0]
  let by = b[1]
  let bz = b[2]
  let bw = b[3]
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  // 短弧：q 与 -q 表示同一旋转，取夹角小的一侧，避免 360° 绕远路。
  if (dot < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    dot = -dot
  }
  let scale0: number
  let scale1: number
  if (dot > 0.9995) {
    // 夹角极小：线性插值后归一化（避免 sin 除法数值噪声）。
    scale0 = 1 - aa
    scale1 = aa
  } else {
    const theta = Math.acos(Math.min(1, Math.max(-1, dot)))
    const sinTheta = Math.sin(theta)
    scale0 = Math.sin((1 - aa) * theta) / sinTheta
    scale1 = Math.sin(aa * theta) / sinTheta
  }
  out[0] = a[0] * scale0 + bx * scale1
  out[1] = a[1] * scale0 + by * scale1
  out[2] = a[2] * scale0 + bz * scale1
  out[3] = a[3] * scale0 + bw * scale1
  return normalizeQuat(out)
}

/** 线性插值：`out = a + (b - a) * t`（长度 >= 3 的数组均可）。 */
export function lerpVec3(
  a: readonly number[],
  b: readonly number[],
  t: number,
  out: Vec3
): Vec3 {
  const aa = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  out[0] = a[0] + (b[0] - a[0]) * aa
  out[1] = a[1] + (b[1] - a[1]) * aa
  out[2] = a[2] + (b[2] - a[2]) * aa
  return out
}

/** smoothstep（0→0，1→1，中点平滑；交叉淡入用）。 */
export function smoothstep(t: number): number {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  return x * x * (3 - 2 * x)
}

/* -------------------------------------------------------------------------- */
/* 采样                                                                        */
/* -------------------------------------------------------------------------- */

/** 读取某骨第 `frame` 帧的旋转；越界/无轨道返回 false。 */
export function readBoneRotationAtFrame(
  clip: ParsedClip,
  unityBoneName: string,
  frame: number,
  out: Quat4
): boolean {
  const track = clip.bones.get(unityBoneName)
  if (track === undefined) return false
  const index = Math.trunc(frame)
  if (!Number.isFinite(index) || index < 0 || index >= clip.frames) return false
  const base = index * 4
  out[0] = track.rotations[base]
  out[1] = track.rotations[base + 1]
  out[2] = track.rotations[base + 2]
  out[3] = track.rotations[base + 3]
  return true
}

/** 读取某骨第 `frame` 帧的 Hips 位移（米，未缩放）；无位移返回 false。 */
export function readHipsPositionAtFrame(
  clip: ParsedClip,
  frame: number,
  out: Vec3
): boolean {
  const track = clip.bones.get('Hips')
  if (track === undefined || track.positions === null) return false
  const index = Math.trunc(frame)
  if (!Number.isFinite(index) || index < 0 || index >= clip.frames) return false
  const base = index * 3
  out[0] = track.positions[base]
  out[1] = track.positions[base + 1]
  out[2] = track.positions[base + 2]
  return true
}

/** 临时四元数（采样函数内部复用；非重入使用即可）。 */
const tmpQuatB: Quat4 = [0, 0, 0, 1]

/**
 * 采样某骨在 `timeSec` 的归一化旋转（帧间 slerp）。
 * @returns clip 未覆盖该骨时 false（调用方按 rest 处理）。
 */
export function sampleBoneRotation(
  clip: ParsedClip,
  unityBoneName: string,
  timeSec: number,
  out: Quat4
): boolean {
  const track = clip.bones.get(unityBoneName)
  if (track === undefined) return false
  const { f0, f1, a } = frameIndex(clip, timeSec)
  // 直接从解析后的轨道读两帧（避免走 Map 二次查询）。
  const i0 = f0 * 4
  out[0] = track.rotations[i0]
  out[1] = track.rotations[i0 + 1]
  out[2] = track.rotations[i0 + 2]
  out[3] = track.rotations[i0 + 3]
  if (a <= 0 || f1 === f0) return true
  const i1 = f1 * 4
  tmpQuatB[0] = track.rotations[i1]
  tmpQuatB[1] = track.rotations[i1 + 1]
  tmpQuatB[2] = track.rotations[i1 + 2]
  tmpQuatB[3] = track.rotations[i1 + 3]
  slerpQuat(out, tmpQuatB, a, out)
  return true
}

/**
 * 采样 Hips 在 `timeSec` 的位移（米、**已按 `hipsRestHeight / sourceHipsHeight` 缩放**）。
 * @returns 该 clip 没有 Hips.p 时 false（调用方不写位移）。
 */
export function sampleScaledHipsPosition(
  clip: ParsedClip,
  timeSec: number,
  hipsRestHeightMeters: number,
  out: Vec3
): boolean {
  const track = clip.bones.get('Hips')
  if (track === undefined || track.positions === null) return false
  const { f0, f1, a } = frameIndex(clip, timeSec)
  const i0 = f0 * 3
  let x = track.positions[i0]
  let y = track.positions[i0 + 1]
  let z = track.positions[i0 + 2]
  if (a > 0 && f1 !== f0) {
    const i1 = f1 * 3
    x += (track.positions[i1] - x) * a
    y += (track.positions[i1 + 1] - y) * a
    z += (track.positions[i1 + 2] - z) * a
  }
  const scale = hipsPositionScale(clip, hipsRestHeightMeters)
  out[0] = x * scale
  out[1] = y * scale
  out[2] = z * scale
  return true
}

/**
 * 判断某骨轨道在整段 clip 内是否明显偏离 identity（用于 missingBones 过滤：
 * 目标模型缺 upperChest 时 clip 该轨道为 identity，跳过不算"缺骨"）。
 * @param toleranceDeg 允许的最大旋转角（度；默认 0.5°）
 */
export function isBoneTrackNonIdentity(
  clip: ParsedClip,
  unityBoneName: string,
  toleranceDeg = 0.5
): boolean {
  const track = clip.bones.get(unityBoneName)
  if (track === undefined) return false
  const toleranceRad = (Math.max(0, toleranceDeg) * Math.PI) / 180
  for (let frame = 0; frame < clip.frames; frame += 1) {
    const index = frame * 4
    const w = Math.min(1, Math.abs(track.rotations[index + 3]))
    const angle = 2 * Math.acos(w)
    if (angle > toleranceRad) return true
  }
  return false
}
