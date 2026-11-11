/**
 * Mate-Engine 面部动画 → 表情 clip（纯 ESM，dev-only）
 *
 * 输入是 Unity `.anim`（YAML）里的 `m_FloatCurves`（blendshape 曲线；属性名 = VRM 0.x 表达名：
 * joy/angry/sorrow/fun/neutral/blink/blink_l/blink_r/a/i/u/e/o 等），输出 V6 表情 clip 数据
 * （`src/shared/expression-contract.ts`：逐帧 VRM1 expression 权重）。
 *
 * 为什么不用 Unity 采样：这些是纯 blendshape 曲线（classID 114），YAML 里直接可读，
 * 不需要 Unity 工程；且源帧率 60fps、关键帧稀疏，直接解析 + 重采样最准确。
 *
 * 关键口径（与 `docs/expression-mapping.md` 一致）：
 * - `neutral` 在 VRM 1.0 不是 preset（无表情 = 全零）→ 轨道丢弃；
 * - `fun` → `relaxed`（three-vrm v0compat 口径）；
 * - 权重 0..1，源数据有 >1 的音量（如 PET_TALKING 的 A 到 1.0），clamp 到 1；
 * - 帧数约定 loop = round(duration*fps)（不复制末帧）/ non-loop = +1（末帧包含）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  EXPRESSION_CLIP_DEFAULTS,
  EXPRESSION_CLIP_LIMITS,
  buildExpressionClip,
  expectedFrameCount,
  isPresetTrack,
  normalizeExpressionName,
  resampleCurve,
  sampleCurveAtTime
} from './expression-clip.mjs'

/* -------------------------------------------------------------------------- */
/* YAML 解析                                                                   */
/* -------------------------------------------------------------------------- */

const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?'
/** 关键帧块：time/value + 可选 inSlope/outSlope（Unity `.anim` m_Curve 序列化）。 */
const KEYFRAME_RE = new RegExp(
  `time:\\s*(${NUMBER})\\s*\\n\\s*value:\\s*(${NUMBER})` +
    `(?:\\s*\\n\\s*inSlope:\\s*(${NUMBER}))?` +
    `(?:\\s*\\n\\s*outSlope:\\s*(${NUMBER}))?`,
  'g'
)

/**
 * 从 Unity `.anim` 文本里解析 `m_FloatCurves` 块。
 *
 * @param {string} text
 * @returns {{
 *   name: string | null,
 *   sampleRate: number,
 *   wrapMode: number | null,
 *   stopTime: number | null,
 *   duration: number,
 *   loopTime: boolean | null,
 *   curves: Record<string, Array<[number, number]>>,
 *   warnings: string[]
 * }}
 */
export function parseUnityAnimationClip(text) {
  const warnings = []
  if (typeof text !== 'string' || text.length === 0) {
    return { name: null, sampleRate: 60, wrapMode: null, stopTime: null, duration: 0, loopTime: null, curves: {}, warnings: ['空文本'] }
  }
  const nameMatch = /m_Name:\s*(.+)/.exec(text)
  const sampleRate = readNumberField(text, 'm_SampleRate') ?? 60
  const wrapMode = readNumberField(text, 'm_WrapMode')
  const stopTime = readNumberField(text, 'm_StopTime')
  const loopTimeRaw = /\bm_LoopTime:\s*(\d+)/.exec(text)
  const loopTime = loopTimeRaw ? loopTimeRaw[1] === '1' : null
  const start = text.indexOf('\n  m_FloatCurves:')
  if (start < 0) {
    warnings.push('没有 m_FloatCurves 块（不是 blendshape 动画？）')
    return {
      name: nameMatch ? nameMatch[1].trim() : null,
      sampleRate,
      wrapMode,
      stopTime,
      duration: stopTime ?? 0,
      loopTime,
      curves: {},
      warnings
    }
  }
  const blockStart = start + '\n  m_FloatCurves:'.length
  const endCandidates = [
    text.indexOf('\n  m_PPtrCurves:', blockStart),
    text.indexOf('\n  m_SampleRate:', blockStart)
  ].filter((index) => index >= 0)
  const blockEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length
  const block = text.slice(blockStart, blockEnd)
  const chunks = block.split(/\n  - /).slice(1)
  /** @type {Record<string, Array<[number, number]>>} */
  const curves = {}
  for (const chunk of chunks) {
    const attributeMatch = /^[^\n]*?\n?\s*attribute:\s*(.+?)\s*$/m.exec(chunk)
    const attribute = attributeMatch ? attributeMatch[1].trim() : ''
    if (attribute.length === 0) continue
    /** @type {Array<[number, number] | [number, number, number, number]>} */
    const points = []
    KEYFRAME_RE.lastIndex = 0
    let match
    while ((match = KEYFRAME_RE.exec(chunk)) !== null) {
      const time = Number(match[1])
      const value = Number(match[2])
      if (!Number.isFinite(time) || !Number.isFinite(value)) continue
      const inSlope = Number(match[3])
      const outSlope = Number(match[4])
      if (Number.isFinite(inSlope) && Number.isFinite(outSlope)) {
        points.push([time, value, inSlope, outSlope])
      } else {
        points.push([time, value])
      }
    }
    if (points.length === 0) continue
    points.sort((a, b) => a[0] - b[0])
    // 同一 attribute 出现多条时合并（保守取首个；Unity 导出的 face clip 不会重复）。
    if (!curves[attribute]) curves[attribute] = points
    else warnings.push(`重复 attribute：${attribute}（保留首条）`)
  }
  const duration =
    stopTime !== null && stopTime > 0
      ? stopTime
      : Object.values(curves).reduce((max, points) => Math.max(max, points[points.length - 1][0]), 0)
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    sampleRate,
    wrapMode,
    stopTime,
    duration,
    loopTime,
    curves,
    warnings
  }
}

function readNumberField(text, field) {
  const match = new RegExp(`${field}:\\s*([+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`).exec(text)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/* -------------------------------------------------------------------------- */
/* clip 提取                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 源 attribute → 目标表达式名（`null` = 丢弃）。
 * 支持：
 * - VRM0 表达名（Joy/Sorrow/…，大小写不敏感）→ VRM1 preset；
 * - 已是 VRM1 preset / 合法自定义名 → 原样；
 * - `blendShape.<name>`（别的 avatar 的 MMD morph）→ 丢弃 + reason。
 *
 * @param {string} attribute
 * @param {Record<string, string | null>} [aliases]
 * @returns {{ track: string | null, reason?: string }}
 */
export function mapMateAttributeToTrack(attribute, aliases = undefined) {
  const trimmed = String(attribute ?? '').trim()
  if (trimmed.length === 0) return { track: null, reason: '空 attribute' }
  if (trimmed.startsWith('blendShape.')) {
    return { track: null, reason: `非 VRM 表达（${trimmed}）` }
  }
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, trimmed.toLowerCase())) {
    return { track: aliases[trimmed.toLowerCase()] }
  }
  const normalized = normalizeExpressionName(trimmed)
  // Mate-Engine 的 face 动画只应出现 VRM0 表达名；`m_FloatCurves` 里同文件还可能有
  // humanoid muscle（"Head Nod Down-Up" 等）与 raw 骨曲线 → 只接受 VRM1 preset，
  // 其它一律视为非表情通道丢弃（避免肌肉名被当自定义 expression）。
  if (normalized !== null && isPresetTrack(normalized)) return { track: normalized }
  return { track: null, reason: `非表情 attribute（${trimmed}）` }
}

/**
 * 从 `.anim` 文本提取表情 clip（源曲线 → 30fps 逐帧权重）。
 *
 * @param {string} text `.anim` 文本
 * @param {{
 *   id: string, sourceFile?: string, fps?: number, loop?: boolean,
 *   aliases?: Record<string, string | null>, notes?: string,
 *   durationOverride?: number, scale?: number, fadeInSec?: number, fadeOutSec?: number
 * }} options
 * @returns {{ clip: object, stats: object }}
 */
export function extractMateFaceClip(text, options) {
  const parsed = parseUnityAnimationClip(text)
  const fps = Math.min(
    EXPRESSION_CLIP_LIMITS.maxFps,
    Math.max(EXPRESSION_CLIP_LIMITS.minFps, options.fps ?? EXPRESSION_CLIP_DEFAULTS.fps)
  )
  const loop = options.loop === true
  const duration = options.durationOverride ?? parsed.duration
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`extractMateFaceClip(${options.id})：源动画 duration 非法（${parsed.duration}）`)
  }
  const frames = expectedFrameCount(duration, fps, loop)
  const scale = Number.isFinite(options.scale) && options.scale >= 0 ? options.scale : 1
  /** @type {Record<string, number[]>} */
  const tracks = {}
  const used = []
  const dropped = []
  for (const [attribute, points] of Object.entries(parsed.curves)) {
    const { track, reason } = mapMateAttributeToTrack(attribute, options.aliases)
    if (track === null) {
      dropped.push({ attribute, reason: reason ?? '未映射' })
      continue
    }
    const sampled = resampleCurve(points, fps, frames).map((value) =>
      Math.round(Math.min(1, Math.max(0, value * scale)) * 10000) / 10000
    )
    if (tracks[track]) {
      // 同一目标轨道来自多个源表达（如 Joy + happy）：逐帧取 max。
      tracks[track] = tracks[track].map((value, index) => Math.max(value, sampled[index] ?? 0))
      dropped.push({ attribute, reason: `合并进 ${track}（取 max）` })
      continue
    }
    tracks[track] = sampled
    used.push({ attribute, track })
  }
  const clip = buildExpressionClip({
    id: options.id,
    source: 'mate',
    sourceFile: options.sourceFile ?? parsed.name ?? options.id,
    fps,
    duration,
    loop,
    tracks,
    fadeInSec: options.fadeInSec,
    fadeOutSec: options.fadeOutSec,
    notes: options.notes
  })
  return {
    clip,
    stats: {
      id: options.id,
      sourceDuration: parsed.duration,
      sourceSampleRate: parsed.sampleRate,
      sourceLoopTime: parsed.loopTime,
      fps,
      frames,
      loop,
      usedTracks: used,
      droppedAttributes: dropped,
      trackCount: Object.keys(clip.tracks).length,
      warnings: parsed.warnings
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 配置 / 批量                                                                  */
/* -------------------------------------------------------------------------- */

/** 默认别名（VRM0 → VRM1；与 shared 对齐；显式列出便于审阅）。 */
export const MATE_FACE_ALIASES = Object.freeze({
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
  o: 'oh'
})

/**
 * 校验 mate-face 配置（`scripts/vrm/expression/config/mate-face.json`）。
 * @param {unknown} config
 * @returns {{ clips: Array<object>, errors: string[] }}
 */
export function validateMateFaceConfig(config) {
  const errors = []
  const clips = []
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { clips: [], errors: ['配置必须是对象'] }
  }
  const rawClips = Array.isArray(config.clips) ? config.clips : []
  const seen = new Set()
  for (const [index, raw] of rawClips.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`clips[${index}] 不是对象`)
      continue
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id.length === 0) {
      errors.push(`clips[${index}] 缺 id`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`clips[${index}] id 重复：${id}`)
      continue
    }
    const file = typeof raw.file === 'string' ? raw.file.trim() : ''
    if (file.length === 0 || file.startsWith('/') || file.includes('..')) {
      errors.push(`clips[${index}](${id}) file 非法：${String(raw.file)}`)
      continue
    }
    const triggers = Array.isArray(raw.triggers)
      ? raw.triggers.filter((item) => typeof item === 'string' && item.trim().length > 0)
      : []
    clips.push({
      id,
      file,
      fps: Number.isFinite(raw.fps) ? raw.fps : EXPRESSION_CLIP_DEFAULTS.fps,
      loop: raw.loop === true,
      priority: Number.isFinite(raw.priority) ? raw.priority : EXPRESSION_CLIP_DEFAULTS.priority,
      triggers,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((item) => typeof item === 'string') : [],
      scale: Number.isFinite(raw.scale) && raw.scale >= 0 ? raw.scale : 1,
      fadeInSec: Number.isFinite(raw.fadeInSec) ? raw.fadeInSec : undefined,
      fadeOutSec: Number.isFinite(raw.fadeOutSec) ? raw.fadeOutSec : undefined,
      note: typeof raw.note === 'string' ? raw.note : undefined
    })
    seen.add(id)
  }
  return { clips, errors }
}

/**
 * 批量提取：读配置里每个 `.anim` 文件 → clip 列表。
 * @param {{
 *   animDir: string,
 *   config: object,
 *   readFile?: (filePath: string) => string
 * }} options
 * @returns {{ clips: Array<{ clip: object, config: object }>, reports: Array<object>, errors: string[] }}
 */
export function extractMateFaceClipsBundle(options) {
  const readFile = options.readFile ?? ((filePath) => readFileSync(filePath, 'utf8'))
  const { clips: configs, errors: configErrors } = validateMateFaceConfig(options.config)
  const errors = [...configErrors]
  const clips = []
  const reports = []
  for (const config of configs) {
    const filePath = path.join(options.animDir, config.file)
    let text
    try {
      text = readFile(filePath)
    } catch (error) {
      errors.push(`读取失败 ${config.file}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      const { clip, stats } = extractMateFaceClip(text, {
        id: config.id,
        sourceFile: config.file,
        fps: config.fps,
        loop: config.loop,
        aliases: MATE_FACE_ALIASES,
        notes: config.note,
        scale: config.scale,
        fadeInSec: config.fadeInSec,
        fadeOutSec: config.fadeOutSec
      })
      clips.push({ clip, config })
      reports.push(stats)
    } catch (error) {
      errors.push(`提取失败 ${config.id}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { clips, reports, errors }
}

/** 读配置 JSON（只读；JSON 解析失败抛出）。 */
export function readMateFaceConfig(configPath) {
  return JSON.parse(readFileSync(configPath, 'utf8'))
}

/** 采样源曲线在指定时间的值（供单测/预览对拍）。 */
export { sampleCurveAtTime }
