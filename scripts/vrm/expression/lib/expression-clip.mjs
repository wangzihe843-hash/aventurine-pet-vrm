/**
 * 表情 clip 数据工具（V6 表情层，dev-only）
 *
 * 纯 ESM：不 import node 内置模块/three，可被 Node CLI、vitest、浏览器（preview viewer）直接使用。
 *
 * 数据形状与 `src/shared/expression-contract.ts` 对齐（两边必须保持同一口径，单测在
 * `tests/expression-clip-validation.test.ts` 里对拍）：
 * ```
 * {
 *   schemaVersion: 1,
 *   id: 'mate/faceDrag',
 *   source: 'mate' | 'hsr',
 *   sourceFile: 'FACE_LAYER/FACE_DRAG.anim',
 *   fps: 30,
 *   frames: 301,          // loop: round(duration*fps)；non-loop: +1
 *   duration: 10.033333,
 *   loop: true,
 *   tracks: { sad: [1,1,...], oh: [0,0.1,...] },   // 每帧 0..1
 *   notes: '...'
 * }
 * ```
 *
 * 核心 API：
 * - `sanitizeExpressionClip(raw, label?)` → `{ clip, warnings }`（清洗 + 回填默认值，永不抛）
 * - `validateExpressionClipData(raw, options?)` → `{ ok, errors, warnings, stats }`（QA 用）
 * - `sampleExpressionClip(clip, timeSec)` → `Record<name, weight>`（与 shared 同口径）
 * - `findExpressionClipEntry(manifest, trigger)` / `buildExpressionManifest(clips, opts)`
 * - `resampleCurve(points, fps, frames)`（源曲线秒→目标帧）
 */

/** clip 数据 schema 版本。 */
export const EXPRESSION_CLIP_SCHEMA_VERSION = 1
/** manifest schema 版本。 */
export const EXPRESSION_MANIFEST_SCHEMA_VERSION = 1
/** 合法来源。 */
export const EXPRESSION_CLIP_SOURCES = ['mate', 'hsr']

/** 允许直接出现的 VRM 1.0 preset 轨道（与 shared 一致）。 */
export const EXPRESSION_PRESET_TRACKS = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight'
]

/** VRM 0.x 表达名 → VRM 1.0 preset（与 shared `VRM0_EXPRESSION_ALIASES` 一致）。 */
export const VRM0_EXPRESSION_ALIASES = {
  joy: 'happy',
  happy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  sad: 'sad',
  fun: 'relaxed',
  relaxed: 'relaxed',
  surprised: 'surprised',
  neutral: null,
  blink: 'blink',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  blinkleft: 'blinkLeft',
  blinkright: 'blinkRight',
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'ee',
  o: 'oh',
  aa: 'aa',
  ih: 'ih',
  ou: 'ou',
  ee: 'ee',
  oh: 'oh'
}

/** 默认值。 */
export const EXPRESSION_CLIP_DEFAULTS = {
  loop: false,
  fps: 30,
  priority: 0,
  fadeInSec: 0.12,
  fadeOutSec: 0.2
}

/** 淡入/淡出合法区间（秒；与 shared 一致）。 */
export const EXPRESSION_CLIP_FADE_RANGE = { min: 0, max: 2 }

/** 防御上限（与 shared 一致）。 */
export const EXPRESSION_CLIP_LIMITS = {
  maxClips: 256,
  maxFrames: 6000,
  minFps: 1,
  maxFps: 120,
  maxDurationSec: 600,
  maxTracks: 32,
  maxNameLength: 64,
  maxTags: 16,
  maxFileLength: 512
}

/** 校验阈值（QA 用；可在 options.limits 覆盖）。 */
export const EXPRESSION_VALIDATION_LIMITS = {
  /** frames 与 duration*fps 的允许偏差（帧）。 */
  frameCountToleranceFrames: 1,
  /** 权重合法区间。 */
  minWeight: 0,
  maxWeight: 1,
  /** clip 总时长上限（秒）。 */
  maxDurationSec: 600,
  /** loop clip 首末帧差 > 该值 → warning（循环顿挫）。 */
  loopSeamWarn: 0.5,
  /** 非 loop clip 最后两帧相同（差 < 该值）→ 不告警（表情保持常见）。 */
  endHoldWarn: 0.0
}

/**
 * 名字归一化：VRM0 别名 → VRM1 preset；已是合法名则原样；非法返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeExpressionName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > EXPRESSION_CLIP_LIMITS.maxNameLength) return null
  if (Object.prototype.hasOwnProperty.call(VRM0_EXPRESSION_ALIASES, trimmed.toLowerCase())) {
    return VRM0_EXPRESSION_ALIASES[trimmed.toLowerCase()]
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

/** 是否为 preset 轨道名。 */
export function isPresetTrack(name) {
  return EXPRESSION_PRESET_TRACKS.includes(name)
}

/**
 * 帧数约定：loop = round(duration*fps)、non-loop = round+1（至少 1/2 帧）。
 * @param {number} duration 秒
 * @param {number} fps
 * @param {boolean} loop
 * @returns {number}
 */
export function expectedFrameCount(duration, fps, loop) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : EXPRESSION_CLIP_DEFAULTS.fps
  const rounded = Math.round(safeDuration * safeFps)
  return loop ? Math.max(1, rounded) : Math.max(2, rounded + 1)
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function clampFade(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(EXPRESSION_CLIP_FADE_RANGE.max, Math.max(EXPRESSION_CLIP_FADE_RANGE.min, value))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readTrimmedString(value, maxLength) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return null
  return trimmed
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * 采样源曲线在 `timeSec` 处的值。
 *
 * 支持两种关键帧形状：
 * - `[tSec, value]`：线性插值；
 * - `[tSec, value, inSlope, outSlope]`：**三次 Hermite**（Unity `.anim` 的存盘切线语义：
 *   `m_Curve[].inSlope/outSlope` 是 dy/dx，ClampedAuto(136) 的切线已在存盘时算好，
 *   峰值/谷值为 0；Linear(69) 的斜率即线性段斜率）。这是 Unity 运行时实际求值方式，
 *   比线性插值更贴近 Mate-Engine 原版缓动（实测最大差 0.096 权重，见 mate lane 交叉验证）。
 *
 * 超出范围：首帧前 = 首值；末帧后 = 末值（Unity m_PreInfinity=2 Constant）。
 *
 * @param {Array<[number, number] | [number, number, number, number]>} points
 * @param {number} timeSec
 * @returns {number}
 */
export function sampleCurveAtTime(points, timeSec) {
  if (!Array.isArray(points) || points.length === 0) return 0
  const time = Number.isFinite(timeSec) ? timeSec : 0
  if (time <= points[0][0]) return points[0][1]
  const last = points[points.length - 1]
  if (time >= last[0]) return last[1]
  // 二分查找区间起点
  let low = 0
  let high = points.length - 1
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (points[mid][0] <= time) low = mid
    else high = mid
  }
  const p0 = points[low]
  const p1 = points[high]
  const [t0, v0] = p0
  const [t1, v1] = p1
  if (t1 <= t0) return v1
  const ratio = (time - t0) / (t1 - t0)
  if (p0.length >= 4 && p1.length >= 4) {
    // Hermite：s0 = p0.outSlope，s1 = p1.inSlope；h = 区间时长。
    const h = t1 - t0
    const s0 = Number.isFinite(p0[3]) ? p0[3] : 0
    const s1 = Number.isFinite(p1[2]) ? p1[2] : 0
    const x = ratio
    const x2 = x * x
    const x3 = x2 * x
    const h00 = 2 * x3 - 3 * x2 + 1
    const h10 = x3 - 2 * x2 + x
    const h01 = -2 * x3 + 3 * x2
    const h11 = x3 - x2
    return h00 * v0 + h10 * h * s0 + h01 * v1 + h11 * h * s1
  }
  return v0 + (v1 - v0) * ratio
}

/**
 * 把「关键帧曲线」重采样为逐帧数组。
 * @param {Array<[number, number]>} points 关键帧（秒，升序）
 * @param {number} fps 目标帧率
 * @param {number} frames 目标帧数
 * @returns {number[]}
 */
export function resampleCurve(points, fps, frames) {
  const out = new Array(Math.max(1, Math.round(frames)))
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : EXPRESSION_CLIP_DEFAULTS.fps
  for (let index = 0; index < out.length; index += 1) {
    out[index] = round4(clamp01(sampleCurveAtTime(points, index / safeFps)))
  }
  return out
}

/**
 * 采样表情 clip（与 `src/shared/expression-contract.ts` 的 `sampleExpressionClip` 同口径）。
 * @param {object} clip
 * @param {number} timeSec
 * @returns {Record<string, number>}
 */
export function sampleExpressionClip(clip, timeSec) {
  const out = {}
  if (!isRecord(clip) || !isRecord(clip.tracks)) return out
  const frames = Math.max(1, Math.round(clip.frames ?? 1))
  const fps = Math.max(EXPRESSION_CLIP_LIMITS.minFps, Number(clip.fps) || EXPRESSION_CLIP_DEFAULTS.fps)
  const duration = Number(clip.duration) > 0 ? Number(clip.duration) : frames / fps
  let time = Number.isFinite(timeSec) ? timeSec : 0
  if (clip.loop) time = ((time % duration) + duration) % duration
  else time = Math.min(Math.max(0, time), duration)
  const position = time * fps
  const index0 = Math.min(frames - 1, Math.max(0, Math.floor(position)))
  let index1 = index0 + 1
  if (index1 >= frames) index1 = clip.loop ? 0 : frames - 1
  const fraction = Math.min(1, Math.max(0, position - index0))
  for (const [name, track] of Object.entries(clip.tracks)) {
    if (!Array.isArray(track) || track.length === 0) continue
    const value0 = track[index0] ?? track[track.length - 1] ?? 0
    const value1 = track[index1] ?? value0
    const weight = clamp01(value0 + (value1 - value0) * fraction)
    if (weight > 1e-4) out[name] = round4(weight)
  }
  return out
}

/**
 * 清洗单个 clip（永不抛）：非法/缺失字段回填默认，轨道长度不匹配丢弃，权重 clamp。
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {{clip: object | null, warnings: string[]}}
 */
export function sanitizeExpressionClip(raw, label = 'expressionClip') {
  const warnings = []
  if (!isRecord(raw)) {
    warnings.push(`${label}：期望对象，已忽略`)
    return { clip: null, warnings }
  }
  const id = readTrimmedString(raw.id, EXPRESSION_CLIP_LIMITS.maxNameLength)
  if (id === null) {
    warnings.push(`${label}：缺少合法 id，已忽略`)
    return { clip: null, warnings }
  }
  const source = EXPRESSION_CLIP_SOURCES.includes(raw.source) ? raw.source : 'mate'
  if (!EXPRESSION_CLIP_SOURCES.includes(raw.source)) warnings.push(`${label}(${id})：source 非法，按 mate 处理`)
  const rawTracks = isRecord(raw.tracks) ? raw.tracks : {}
  const trackNames = Object.keys(rawTracks).slice(0, EXPRESSION_CLIP_LIMITS.maxTracks)
  let derivedFrames = 0
  for (const name of trackNames) {
    const values = rawTracks[name]
    if (Array.isArray(values) && values.length > derivedFrames) derivedFrames = values.length
  }
  const fps = Math.min(
    EXPRESSION_CLIP_LIMITS.maxFps,
    Math.max(EXPRESSION_CLIP_LIMITS.minFps, readFiniteNumber(raw.fps) ?? EXPRESSION_CLIP_DEFAULTS.fps)
  )
  const frames = Math.min(
    EXPRESSION_CLIP_LIMITS.maxFrames,
    Math.max(1, Math.round(readFiniteNumber(raw.frames) ?? derivedFrames))
  )
  const loop = typeof raw.loop === 'boolean' ? raw.loop : EXPRESSION_CLIP_DEFAULTS.loop
  const duration = Math.min(
    EXPRESSION_CLIP_LIMITS.maxDurationSec,
    Math.max(1 / fps, readFiniteNumber(raw.duration) ?? frames / fps)
  )
  const tracks = {}
  for (const rawName of trackNames) {
    const name = normalizeExpressionName(rawName)
    if (name === null) {
      warnings.push(`${label}(${id})：轨道名非法，已丢弃（${String(rawName).slice(0, 32)}）`)
      continue
    }
    const values = rawTracks[rawName]
    if (!Array.isArray(values) || values.length !== frames) {
      warnings.push(`${label}(${id})：轨道 ${name} 长度不合法（${Array.isArray(values) ? values.length : -1} ≠ ${frames}），已丢弃`)
      continue
    }
    const out = new Array(frames)
    for (let index = 0; index < frames; index += 1) out[index] = round4(clamp01(values[index]))
    tracks[name] = out
  }
  const clip = {
    schemaVersion: EXPRESSION_CLIP_SCHEMA_VERSION,
    id,
    source,
    fps,
    frames,
    duration,
    loop,
    tracks
  }
  const sourceFile = readTrimmedString(raw.sourceFile, EXPRESSION_CLIP_LIMITS.maxFileLength)
  if (sourceFile !== null) clip.sourceFile = sourceFile
  const fadeIn = readFiniteNumber(raw.fadeInSec)
  if (fadeIn !== null) clip.fadeInSec = clampFade(fadeIn)
  const fadeOut = readFiniteNumber(raw.fadeOutSec)
  if (fadeOut !== null) clip.fadeOutSec = clampFade(fadeOut)
  const notes = readTrimmedString(raw.notes, 500)
  if (notes !== null) clip.notes = notes
  return { clip, warnings }
}

/**
 * 构造 clip（管线内部用：已知 id/source/fps/tracks；自动算 frames/duration、去全零轨道）。
 * @param {{
 *   id: string, source: string, tracks: Record<string, number[]>, fps?: number,
 *   duration?: number, loop?: boolean, sourceFile?: string, notes?: string,
 *   dropZeroTracks?: boolean
 * }} options
 * @returns {object}
 */
export function buildExpressionClip(options) {
  const fps = Math.min(
    EXPRESSION_CLIP_LIMITS.maxFps,
    Math.max(EXPRESSION_CLIP_LIMITS.minFps, readFiniteNumber(options.fps) ?? EXPRESSION_CLIP_DEFAULTS.fps)
  )
  const loop = typeof options.loop === 'boolean' ? options.loop : EXPRESSION_CLIP_DEFAULTS.loop
  const rawTracks = isRecord(options.tracks) ? options.tracks : {}
  let frames = 0
  for (const values of Object.values(rawTracks)) {
    if (Array.isArray(values)) frames = Math.max(frames, values.length)
  }
  if (frames === 0) throw new Error(`buildExpressionClip(${options.id})：没有任何轨道`)
  const duration = readFiniteNumber(options.duration) ?? frames / fps
  const dropZero = options.dropZeroTracks !== false
  const tracks = {}
  for (const [rawName, values] of Object.entries(rawTracks)) {
    const name = normalizeExpressionName(rawName)
    if (name === null) continue
    if (!Array.isArray(values) || values.length !== frames) {
      throw new Error(`buildExpressionClip(${options.id})：轨道 ${name} 长度 ${Array.isArray(values) ? values.length : -1} ≠ ${frames}`)
    }
    const out = values.map((value) => round4(clamp01(value)))
    if (dropZero && !out.some((value) => value > 1e-4)) continue
    tracks[name] = out
  }
  const clip = {
    schemaVersion: EXPRESSION_CLIP_SCHEMA_VERSION,
    id: String(options.id),
    source: String(options.source ?? 'mate'),
    fps,
    frames,
    duration: Math.round(duration * 1000000) / 1000000,
    loop,
    tracks
  }
  if (typeof options.sourceFile === 'string' && options.sourceFile.length > 0) clip.sourceFile = options.sourceFile
  const fadeIn = readFiniteNumber(options.fadeInSec)
  if (fadeIn !== null) clip.fadeInSec = clampFade(fadeIn)
  const fadeOut = readFiniteNumber(options.fadeOutSec)
  if (fadeOut !== null) clip.fadeOutSec = clampFade(fadeOut)
  if (typeof options.notes === 'string' && options.notes.length > 0) clip.notes = options.notes
  return clip
}

/**
 * QA 校验单个 clip（错误 = 数据不可用；warning = 可用但可疑）。
 * @param {unknown} raw
 * @param {{ label?: string, knownExpressionNames?: Iterable<string>, limits?: object }} [options]
 * @returns {{ ok: boolean, errors: string[], warnings: string[], stats: object }}
 */
export function validateExpressionClipData(raw, options = {}) {
  const label = options.label ?? 'expressionClip'
  const limits = { ...EXPRESSION_VALIDATION_LIMITS, ...(options.limits ?? {}) }
  const errors = []
  const warnings = []
  const known = options.knownExpressionNames ? new Set(options.knownExpressionNames) : null
  if (!isRecord(raw)) {
    return { ok: false, errors: [`${label}：不是对象`], warnings, stats: {} }
  }
  if (raw.schemaVersion !== EXPRESSION_CLIP_SCHEMA_VERSION) errors.push(`${label}：schemaVersion 必须为 ${EXPRESSION_CLIP_SCHEMA_VERSION}`)
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0) errors.push(`${label}：缺少 id`)
  if (!EXPRESSION_CLIP_SOURCES.includes(raw.source)) errors.push(`${label}：source 非法（${String(raw.source)}）`)
  const fps = readFiniteNumber(raw.fps)
  const fpsValid = fps !== null && fps >= EXPRESSION_CLIP_LIMITS.minFps && fps <= EXPRESSION_CLIP_LIMITS.maxFps
  if (!fpsValid) errors.push(`${label}：fps 非法（${String(raw.fps)}）`)
  const frames = readFiniteNumber(raw.frames)
  const framesValid = frames !== null && Number.isInteger(frames) && frames >= 1 && frames <= EXPRESSION_CLIP_LIMITS.maxFrames
  if (!framesValid) errors.push(`${label}：frames 非法（${String(raw.frames)}）`)
  const duration = readFiniteNumber(raw.duration)
  const durationValid = duration !== null && duration > 0 && duration <= limits.maxDurationSec
  if (!durationValid) errors.push(`${label}：duration 非法（${String(raw.duration)}）`)
  if (typeof raw.loop !== 'boolean') errors.push(`${label}：loop 必须为布尔值`)
  for (const field of ['fadeInSec', 'fadeOutSec']) {
    if (raw[field] === undefined) continue
    const value = readFiniteNumber(raw[field])
    if (value === null || value < EXPRESSION_CLIP_FADE_RANGE.min || value > EXPRESSION_CLIP_FADE_RANGE.max) {
      errors.push(`${label}：${field} 非法（${String(raw[field])}）`)
    }
  }
  if (fpsValid && framesValid && durationValid && typeof raw.loop === 'boolean') {
    const expected = expectedFrameCount(duration, fps, raw.loop)
    if (Math.abs(expected - frames) > limits.frameCountToleranceFrames) {
      errors.push(`${label}：frames=${frames} 与 duration*fps=${expected} 不一致（>${limits.frameCountToleranceFrames} 帧）`)
    }
  }
  const tracks = isRecord(raw.tracks) ? raw.tracks : null
  if (tracks === null) {
    errors.push(`${label}：tracks 必须是对象`)
  }
  const stats = {
    id,
    source: raw.source,
    fps,
    frames,
    duration,
    loop: raw.loop,
    trackCount: 0,
    tracks: {},
    maxWeight: 0,
    activeTracks: 0
  }
  if (tracks !== null && frames !== null && Number.isInteger(frames)) {
    const names = Object.keys(tracks)
    if (names.length > EXPRESSION_CLIP_LIMITS.maxTracks) warnings.push(`${label}：轨道数 ${names.length} 超过上限 ${EXPRESSION_CLIP_LIMITS.maxTracks}`)
    for (const rawName of names) {
      const name = normalizeExpressionName(rawName)
      if (name === null) {
        errors.push(`${label}：轨道名非法（${String(rawName).slice(0, 32)}）`)
        continue
      }
      if (known !== null && !known.has(name)) warnings.push(`${label}：轨道 ${name} 不在目标模型 expression 清单里（播放端会跳过）`)
      else if (!isPresetTrack(name)) warnings.push(`${label}：轨道 ${name} 不是 VRM1 preset（自定义 expression）`)
      const values = tracks[rawName]
      if (!Array.isArray(values)) {
        errors.push(`${label}：轨道 ${name} 不是数组`)
        continue
      }
      if (frames !== null && Number.isInteger(frames) && values.length !== frames) {
        errors.push(`${label}：轨道 ${name} 长度 ${values.length} ≠ frames ${frames}`)
        continue
      }
      let min = Infinity
      let max = -Infinity
      let sum = 0
      let finite = true
      for (const value of values) {
        if (!Number.isFinite(value)) {
          finite = false
          break
        }
        if (value < limits.minWeight - 1e-9 || value > limits.maxWeight + 1e-9) {
          errors.push(`${label}：轨道 ${name} 权重越界（${value}）`)
          break
        }
        if (value < min) min = value
        if (value > max) max = value
        sum += value
      }
      if (!finite) {
        errors.push(`${label}：轨道 ${name} 含非有限值`)
        continue
      }
      if (min === Infinity) min = 0
      if (max === -Infinity) max = 0
      stats.trackCount += 1
      const trackStats = {
        min: round4(min),
        max: round4(max),
        mean: round4(values.length > 0 ? sum / values.length : 0),
        range: round4(max - min)
      }
      stats.tracks[name] = trackStats
      if (trackStats.max > stats.maxWeight) stats.maxWeight = trackStats.max
      if (trackStats.range > 1e-4) stats.activeTracks += 1
    }
    // loop 接缝检查（全部轨道首末帧差）
    if (raw.loop === true) {
      let seam = 0
      for (const [name, values] of Object.entries(stats.tracks)) {
        const track = tracks[name]
        if (!Array.isArray(track) || track.length < 2) continue
        const diff = Math.abs(track[track.length - 1] - track[0])
        if (diff > seam) seam = diff
      }
      stats.loopSeam = round4(seam)
      if (seam > limits.loopSeamWarn) warnings.push(`${label}：loop 接缝跳变 ${seam.toFixed(2)}（首末帧差过大，循环会顿挫）`)
    }
  }
  return { ok: errors.length === 0, errors, warnings, stats }
}

/**
 * 拼接一个 clip 的 manifest 条目（不含 file；由调用方给相对路径）。
 * @param {object} clip
 * @param {{ file: string, triggers?: string[], tags?: string[], priority?: number, note?: string }} options
 * @returns {object}
 */
export function buildExpressionClipEntry(clip, options) {
  const entry = {
    id: clip.id,
    set: clip.source,
    file: options.file,
    loop: clip.loop === true,
    fps: clip.fps,
    frames: clip.frames,
    duration: clip.duration,
    priority: Math.round(readFiniteNumber(options.priority) ?? EXPRESSION_CLIP_DEFAULTS.priority),
    fadeInSec: clampFade(
      readFiniteNumber(options.fadeInSec) ?? (clip.fadeInSec ?? EXPRESSION_CLIP_DEFAULTS.fadeInSec)
    ),
    fadeOutSec: clampFade(
      readFiniteNumber(options.fadeOutSec) ?? (clip.fadeOutSec ?? EXPRESSION_CLIP_DEFAULTS.fadeOutSec)
    ),
    triggers: (options.triggers ?? []).filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()),
    tags: (options.tags ?? []).filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
  }
  if (typeof options.note === 'string' && options.note.length > 0) entry.note = options.note
  return entry
}

/**
 * 按触发键选择 manifest 条目：priority 高者优先，同优先级取靠前者。
 * @param {object | null | undefined} manifest
 * @param {string} trigger
 * @returns {object | null}
 */
export function findExpressionClipEntry(manifest, trigger) {
  if (!isRecord(manifest) || !Array.isArray(manifest.clips) || typeof trigger !== 'string') return null
  const target = trigger.trim()
  if (target.length === 0) return null
  let best = null
  let bestPriority = -Infinity
  for (const clip of manifest.clips) {
    if (!isRecord(clip)) continue
    const triggers = Array.isArray(clip.triggers) ? clip.triggers : []
    if (clip.id !== target && !triggers.includes(target)) continue
    const priority = readFiniteNumber(clip.priority) ?? 0
    if (priority > bestPriority) {
      best = clip
      bestPriority = priority
    }
  }
  return best
}

/**
 * 生成表情集 manifest（`assets/expressions/manifest.json` 形状）。
 * @param {Array<object>} entries
 * @param {{ generatedAt?: string }} [options]
 * @returns {object}
 */
export function buildExpressionManifest(entries, options = {}) {
  return {
    schemaVersion: EXPRESSION_MANIFEST_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    clips: entries
  }
}
