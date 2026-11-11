/**
 * 冻结共享契约 —— 动画（humanoid clip）契约（W0-3）
 *
 * Phase 3 动画路线：VRM humanoid 标准动作（glTF/VRMA clip，Blender 重定向产出）由
 * `AnimationMixer` 播放；缺失的 clip 回退程序化 additive 层或 v1 legacy 路径。
 *
 * 本文件定义：
 * - 动画后端 flag（`PET_ANIM_BACKEND`）与解析规则（env > 配置 > 默认 vrm）；
 * - motion manifest（`src/shared/motion-manifest.json` / 未来的 `assets/motions/<set>/manifest.json`）
 *   的条目与清洗规则；
 * - mood → clip 选择纯函数（`findAnimationClip`），供 clip-player 消费。
 *
 * 规则（与 `src/shared/types.ts` 相同）：
 * - 环境中立纯 TS：不得 import `electron` / `node:*` / `three` / 第三方运行时依赖；
 * - **冻结后不得擅改**：字段/枚举/默认值变更必须走 Lead 评审（PLAN §7/§8/§13）；
 * - `file` 语义与 VRM manifest 相同（assets 根相对路径或 `pet-asset://` URL），
 *   实际存在性由 renderer 侧 loader 检查：**文件缺失 = 该 clip 不可用（回退），不报错崩溃**。
 *
 * 相关契约：`src/shared/vrm.ts`（模型侧）、`src/shared/config.ts`（`animBackend`/`motionSet`）、
 * `docs/vrm-contract.md`。
 */
import {
  ANIMATION_BACKENDS,
  PET_MOODS,
  type AnimationBackend,
  type SanitizeResult
} from './types'
import { isSafeAssetReference } from './vrm'

/** 重新导出基础类型，便于使用方只 import 本模块。 */
export type { AnimationBackend } from './types'

/** motion manifest 的 schema 版本（不兼容变更时递增）。 */
export const ANIMATION_MANIFEST_SCHEMA_VERSION = 1

/** 动画后端环境变量名；值 `vrm` / `legacy-pmx`（优先级：env > 配置 > 默认 vrm）。 */
export const ANIMATION_BACKEND_ENV = 'PET_ANIM_BACKEND'

/** 默认动作集 id（`PetConfig.motionSet` 默认值；对应 `assets/motions/default/`）。 */
export const DEFAULT_MOTION_SET_ID = 'default'

/** 动作集 id 最大长度（与 `src/shared/config.ts` 的清洗规则共用）。 */
export const MOTION_SET_ID_MAX_LENGTH = 64

/**
 * clip 可绑定的「动作槽位」：
 * - `PetMood` 全集（状态机直接驱动）；
 * - `salute`：V3 验收要求的一次性敬礼/打招呼动作（不改变 PetMood 契约）。
 *
 * 新增槽位 = 契约变更（需 Lead 评审；尽量避免，优先用同 mood 多 clip + priority）。
 */
export const ANIMATION_CLIP_MOODS = [...PET_MOODS, 'salute'] as const

/** 动作槽位（mood 或一次性动作）。 */
export type AnimationClipMood = (typeof ANIMATION_CLIP_MOODS)[number]

/** 是否为合法动作槽位。 */
export function isAnimationClipMood(value: unknown): value is AnimationClipMood {
  return (
    typeof value === 'string' && (ANIMATION_CLIP_MOODS as readonly string[]).includes(value)
  )
}

/* -------------------------------------------------------------------------- */
/* clip 条目                                                                   */
/* -------------------------------------------------------------------------- */

/** 归一化后的 clip 默认参数（写进契约，player 实现不再各自拍脑袋）。 */
export const ANIMATION_CLIP_DEFAULTS = {
  loop: true,
  timeScale: 1,
  fadeInSec: 0.15,
  fadeOutSec: 0.2,
  priority: 0
} as const

/** 允许的播放速率区间（timeScale）。 */
export const ANIMATION_CLIP_TIME_SCALE_RANGE = { min: 0.1, max: 4 } as const
/** 允许的淡入/淡出时长区间（秒）。 */
export const ANIMATION_CLIP_FADE_RANGE = { min: 0, max: 2 } as const
/** priority 合法区间（整数）。 */
const MIN_CLIP_PRIORITY = -100
const MAX_CLIP_PRIORITY = 100

/** manifest 中手写的 clip 条目（JSON 形状；可省略字段由清洗回填默认值）。 */
export interface AnimationClipEntryInput {
  id: string
  mood: AnimationClipMood
  file: string
  loop?: boolean
  timeScale?: number
  fadeInSec?: number
  fadeOutSec?: number
  rootMotion?: 'inPlace'
  priority?: number
}

/** 归一化后的 clip 条目（所有字段必有值，可直接消费）。 */
export interface AnimationClipEntry {
  /** 稳定 id（manifest 内唯一，如 `walk-default`）；同 mood 多 clip 时用于日志/调试。 */
  id: string
  /** 绑定的动作槽位（mood / salute）。 */
  mood: AnimationClipMood
  /** 资产引用（assets 根相对路径或 `pet-asset://` URL；`.glb` / `.vrma`）。 */
  file: string
  /** 是否循环播放。 */
  loop: boolean
  /** 播放速率（0.1–4；1 = 原速）。 */
  timeScale: number
  /** 淡入时长（秒，0–2）。 */
  fadeInSec: number
  /** 淡出时长（秒，0–2）。 */
  fadeOutSec: number
  /** 根运动：`inPlace` = 原地播放（桌宠位移由 physics 层负责，禁止 clip 自带位移）。 */
  rootMotion: 'inPlace' | null
  /** 同 mood 多 clip 时的优先级（高者优先；范围 -100–100，默认 0）。 */
  priority: number
}

/** 归一化 motion manifest（`sanitizeAnimationClipManifest` 的输出）。 */
export interface AnimationClipManifest {
  schemaVersion: 1
  clips: AnimationClipEntry[]
}

/** manifest 文件（JSON）的输入形状。 */
export interface AnimationClipManifestInput {
  schemaVersion: 1
  clips?: AnimationClipEntryInput[]
}

/** 空 manifest（无动作资产时的安全缺省；调用方回退 legacy/程序化）。 */
export const EMPTY_ANIMATION_CLIP_MANIFEST: AnimationClipManifest = {
  schemaVersion: ANIMATION_MANIFEST_SCHEMA_VERSION,
  clips: []
}

/** 单个 manifest 允许的 clip 数量上限（防御异常大的输入）。 */
const MAX_CLIPS = 256
/** clip id 最大长度。 */
const MAX_CLIP_ID_LENGTH = 64

/* -------------------------------------------------------------------------- */
/* 后端 flag                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 解析动画后端 flag（`PET_ANIM_BACKEND` 的值或配置值）；非法/缺失返回 null。
 * 大小写敏感（env 值先 trim）。
 */
export function parseAnimationBackend(value: unknown): AnimationBackend | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return (ANIMATION_BACKENDS as readonly string[]).includes(trimmed)
    ? (trimmed as AnimationBackend)
    : null
}

/**
 * 决定最终动画后端：**环境变量 > 配置 > 默认 `vrm`**（PLAN D4/§4）。
 * @param environmentValue `process.env.PET_ANIM_BACKEND`（可为 undefined/非法）
 * @param configured `PetConfig.animBackend`（已 sanitize，仍做一次防御校验）
 */
export function resolveAnimationBackend(
  environmentValue: unknown,
  configured: AnimationBackend
): AnimationBackend {
  return (
    parseAnimationBackend(environmentValue) ??
    parseAnimationBackend(configured) ??
    'vrm'
  )
}

/* -------------------------------------------------------------------------- */
/* manifest 清洗 / 选择                                                        */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function readTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return null
  return trimmed
}

/** 清洗单个 clip 条目；非法返回 null（并写 warning）。 */
function sanitizeClip(
  input: unknown,
  index: number,
  warnings: string[]
): AnimationClipEntry | null {
  const label = `clips[${index}]`
  if (!isRecord(input)) {
    warnings.push(`${label}：期望对象，已丢弃`)
    return null
  }

  const id = readTrimmedString(input['id'], MAX_CLIP_ID_LENGTH)
  if (id === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    warnings.push(`${label}.id：缺失或非法（需 [A-Za-z0-9._-]，首字符非点），已丢弃`)
    return null
  }

  const mood = input['mood']
  if (!isAnimationClipMood(mood)) {
    warnings.push(`${label}.mood：非法动作槽位 ${String(mood)}，已丢弃`)
    return null
  }

  const file = typeof input['file'] === 'string' ? input['file'].trim() : ''
  if (!isSafeAssetReference(file)) {
    warnings.push(`${label}.file：缺失或不是安全的 assets 相对路径/pet-asset URL，已丢弃`)
    return null
  }

  let loop: boolean = ANIMATION_CLIP_DEFAULTS.loop
  if (typeof input['loop'] === 'boolean') loop = input['loop']
  else if (input['loop'] !== undefined) warnings.push(`${label}.loop：非布尔值，按 true 处理`)

  const rawTimeScale = readFiniteNumber(input['timeScale'])
  let timeScale: number = ANIMATION_CLIP_DEFAULTS.timeScale
  if (rawTimeScale !== null) {
    timeScale = clampNumber(
      rawTimeScale,
      ANIMATION_CLIP_TIME_SCALE_RANGE.min,
      ANIMATION_CLIP_TIME_SCALE_RANGE.max
    )
    if (timeScale !== rawTimeScale) {
      warnings.push(`${label}.timeScale：越界，已钳制到 ${timeScale}`)
    }
  } else if (input['timeScale'] !== undefined) {
    warnings.push(`${label}.timeScale：非法，按 1 处理`)
  }

  const readFade = (key: 'fadeInSec' | 'fadeOutSec', fallback: number): number => {
    const raw = readFiniteNumber(input[key])
    if (raw === null) {
      if (input[key] !== undefined) warnings.push(`${label}.${key}：非法，按 ${fallback}s 处理`)
      return fallback
    }
    const clamped = clampNumber(raw, ANIMATION_CLIP_FADE_RANGE.min, ANIMATION_CLIP_FADE_RANGE.max)
    if (clamped !== raw) warnings.push(`${label}.${key}：越界，已钳制到 ${clamped}s`)
    return clamped
  }
  const fadeInSec = readFade('fadeInSec', ANIMATION_CLIP_DEFAULTS.fadeInSec)
  const fadeOutSec = readFade('fadeOutSec', ANIMATION_CLIP_DEFAULTS.fadeOutSec)

  let rootMotion: 'inPlace' | null = null
  if (input['rootMotion'] !== undefined) {
    if (input['rootMotion'] === 'inPlace') rootMotion = 'inPlace'
    else warnings.push(`${label}.rootMotion：非法值 ${String(input['rootMotion'])}，已忽略`)
  }

  const rawPriority = readFiniteNumber(input['priority'])
  let priority: number = ANIMATION_CLIP_DEFAULTS.priority
  if (rawPriority !== null) {
    priority = Math.round(clampNumber(rawPriority, MIN_CLIP_PRIORITY, MAX_CLIP_PRIORITY))
    if (priority !== rawPriority) {
      warnings.push(`${label}.priority：越界，已钳制到 ${priority}`)
    }
  } else if (input['priority'] !== undefined) {
    warnings.push(`${label}.priority：非法，按 0 处理`)
  }

  return { id, mood, file, loop, timeScale, fadeInSec, fadeOutSec, rootMotion, priority }
}

/**
 * 把任意输入清洗为可消费的 `AnimationClipManifest`。**永不抛异常**；
 * 非法条目被丢弃并在 `warnings` 里说明。
 *
 * 规则：
 * - `schemaVersion` 必须为 1，否则返回空 manifest；
 * - clip 按 `id` 去重（保留第一个，重复项丢弃并 warning）；
 * - `mood` 必须是 `ANIMATION_CLIP_MOODS` 之一（未知槽位丢弃并 warning）；
 * - `file` 必须通过 `isSafeAssetReference`；
 * - 缺省值见 `ANIMATION_CLIP_DEFAULTS`；数值越界钳制。
 */
export function sanitizeAnimationClipManifest(
  input: unknown
): SanitizeResult<AnimationClipManifest> {
  const warnings: string[] = []
  const empty: AnimationClipManifest = {
    schemaVersion: ANIMATION_MANIFEST_SCHEMA_VERSION,
    clips: []
  }

  if (!isRecord(input)) {
    warnings.push('motion manifest：期望对象，已回退空 manifest')
    return { value: empty, warnings }
  }
  if (input['schemaVersion'] !== ANIMATION_MANIFEST_SCHEMA_VERSION) {
    warnings.push(
      `motion manifest.schemaVersion：期望 ${ANIMATION_MANIFEST_SCHEMA_VERSION}，实际 ${String(
        input['schemaVersion']
      )}，已回退空 manifest`
    )
    return { value: empty, warnings }
  }

  const rawClips = input['clips']
  if (!Array.isArray(rawClips)) {
    if (rawClips !== undefined) warnings.push('motion manifest.clips：期望数组，已按空处理')
    return {
      value: { schemaVersion: ANIMATION_MANIFEST_SCHEMA_VERSION, clips: [] },
      warnings
    }
  }

  const clips: AnimationClipEntry[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < rawClips.length && clips.length < MAX_CLIPS; index += 1) {
    const clip = sanitizeClip(rawClips[index], index, warnings)
    if (clip === null) continue
    if (seenIds.has(clip.id)) {
      warnings.push(`clips[${index}].id：重复 id "${clip.id}"，已丢弃`)
      continue
    }
    seenIds.add(clip.id)
    clips.push(clip)
  }

  return {
    value: { schemaVersion: ANIMATION_MANIFEST_SCHEMA_VERSION, clips },
    warnings
  }
}

/**
 * 为某个动作槽位选择 clip：priority 高者优先，priority 相同取 manifest 中靠前者；
 * 没有匹配返回 null（调用方回退程序化/legacy）。
 */
export function findAnimationClip(
  manifest: AnimationClipManifest,
  mood: AnimationClipMood
): AnimationClipEntry | null {
  let best: AnimationClipEntry | null = null
  for (const clip of manifest.clips) {
    if (clip.mood !== mood) continue
    if (best === null || clip.priority > best.priority) best = clip
  }
  return best
}

/** 该槽位是否有可用 clip（`findAnimationClip` 的布尔版本）。 */
export function hasAnimationClip(
  manifest: AnimationClipManifest,
  mood: AnimationClipMood
): boolean {
  return findAnimationClip(manifest, mood) !== null
}
