/**
 * 共享契约扩展 —— 表情 clip / 表情集（V6 表情层，2026-11-08 追加）
 *
 * 与 `animation-contract.ts`（骨骼动作 clip）并列，本文件定义**表情动画**的数据形状：
 * - `ExpressionClip`：逐帧、按 VRM expression 名存放的权重轨道（0..1）；
 * - `ExpressionClipManifest`：表情集 manifest（私有数据 `assets/expressions/**`，gitignore）；
 * - 采样 / 绑定 / 清洗纯函数（`scripts/vrm/expression/**` 工具链与 renderer V6 共用）。
 *
 * 设计取舍（与 `vrm.ts` / `animation-contract.ts` 的既有冻结语义零冲突，纯加法）：
 * - 只描述**数据 + 纯函数**，不 import `electron` / `node:*` / `three` / 第三方运行时依赖
 *   （与 shared 其余文件相同规则，同时被 tsconfig.node/web 检查）；
 * - 表情 clip 的轨道键 = **VRM expression 名**（preset 或自定义名）；业务语义
 *   （`PET_EXPRESSIONS`）→ 具体名字的解析由 `resolvePetExpression()` + avatar manifest 的
 *   `expressions` 字段完成；
 * - 帧数约定沿用骨骼 clip（见 `docs/vrm-contract.md`）：
 *   loop clip = `round(duration*fps)`（**不复制末帧**，末帧直接接回首帧）；
 *   non-loop clip = `round(duration*fps)+1`（末帧包含，便于淡出）；
 * - 权重值域 0..1（VRM expression 权重规范）；清洗时钳制，NaN/Infinity = 丢弃；
 * - manifest 里的 `file` 是 assets 根相对路径或 `pet-asset://` URL（与动作 clip 同一规则）。
 *
 * 数据来源（两套，均在本机私有、不进 git）：
 * - `mate`：Mate-Engine Unity face 动画（VRM0 表达名 blendshape）→ VRM1 preset；
 * - `hsr`：HSR 官方 FBX `Emo_*` 脸骨动画 → 解码为 VRM1 preset 权重。
 */
import {
  PET_EXPRESSIONS,
  VRM_EXPRESSION_PRESETS,
  isSafeAssetReference,
  type PetExpression,
  type VrmExpressionBindings,
  type VrmExpressionPreset
} from './vrm'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 表情集 manifest 的 schema 版本（不兼容变更时递增）。 */
export const EXPRESSION_MANIFEST_SCHEMA_VERSION = 1

/** 表情 clip 数据的 schema 版本（不兼容变更时递增）。 */
export const EXPRESSION_CLIP_SCHEMA_VERSION = 1

/**
 * 表情 clip 来源（数据管线）：
 * - `mate`：Mate-Engine（Unity face 动画，VRM0 表达名 blendshape）；
 * - `hsr`：HSR 官方 FBX（`Emo_*` 脸骨动画，解码为 VRM1 preset 权重）。
 */
export const EXPRESSION_CLIP_SOURCES = ['mate', 'hsr'] as const
export type ExpressionClipSource = (typeof EXPRESSION_CLIP_SOURCES)[number]

/** 是否为合法表情 clip 来源。 */
export function isExpressionClipSource(value: unknown): value is ExpressionClipSource {
  return typeof value === 'string' && (EXPRESSION_CLIP_SOURCES as readonly string[]).includes(value)
}

/**
 * 表情 clip 允许直接出现的 VRM 1.0 preset 轨道名（12 个）。
 *
 * 不含 `neutral`（规范里 `neutral` 不是 VRM 1.0 preset；"无表情" = 全零）与
 * `lookUp/lookDown/lookLeft/lookRight`（注视方向走 lookAt，不占表情层）。
 * 自定义 expression 名（如 `笑い` / `照れ`）也允许，校验器会给 warning（非 preset）。
 */
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
] as const
export type ExpressionPresetTrack = (typeof EXPRESSION_PRESET_TRACKS)[number]

/** 口型 preset（独立于表情语义，供 viseme 层使用）。 */
export const EXPRESSION_MOUTH_PRESETS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const
export type ExpressionMouthPreset = (typeof EXPRESSION_MOUTH_PRESETS)[number]

/** 口型名（与 v1 `animation/viseme.ts` 的 `Viseme` 一致；`ん` = 闭嘴收尾）。 */
export const VISEMES = ['あ', 'い', 'う', 'え', 'お', 'ん'] as const
export type VisemeName = (typeof VISEMES)[number]

/** 口型名 → VRM mouth preset（`ん` = 不出权重，闭口）。 */
export const VISEME_TO_EXPRESSION: Readonly<Record<VisemeName, ExpressionMouthPreset | null>> = {
  あ: 'aa',
  い: 'ih',
  う: 'ou',
  え: 'ee',
  お: 'oh',
  ん: null
}

/**
 * VRM 0.x 表达名 → VRM 1.0 preset 名（three-vrm `v0compat` 的归一化口径，手写一份用于数据管线：
 * 源数据是 Unity `.anim` 里的 VRM0 blendshape 名，工具链不经过 three-vrm）。
 *
 * `neutral` 不是 VRM 1.0 preset（无表情 = 全零），映射为 `null` 由调用方丢弃；
 * `fun` 在 VRM 0.x 语义是"开心/有趣"，归一到 `relaxed`（three-vrm v0compat 同口径）。
 */
export const VRM0_EXPRESSION_ALIASES: Readonly<Record<string, ExpressionPresetTrack | null>> = {
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

/** 表情 clip / manifest 的默认值（与 `ANIMATION_CLIP_DEFAULTS` 风格一致）。 */
export const EXPRESSION_CLIP_DEFAULTS = {
  loop: false,
  fps: 30,
  priority: 0,
  fadeInSec: 0.12,
  fadeOutSec: 0.2
} as const

/** 淡入/淡出合法区间（秒；0 = 无过渡，2s 足以覆盖 Mate-Engine 最慢的 1s Head Pat 过渡）。 */
export const EXPRESSION_CLIP_FADE_RANGE = { min: 0, max: 2 } as const

/** 表情 clip / manifest 的防御上限（清洗时钳制，异常输入不崩）。 */
export const EXPRESSION_CLIP_LIMITS = {
  /** 单 manifest 最多 clip 数。 */
  maxClips: 256,
  /** 单 clip 最多帧数（6000 帧 @30fps = 200s）。 */
  maxFrames: 6000,
  /** fps 合法区间。 */
  minFps: 1,
  maxFps: 120,
  /** 单 clip 时长上限（秒）。 */
  maxDurationSec: 600,
  /** 单 clip 最多轨道数。 */
  maxTracks: 32,
  /** 表情/触发名最大长度。 */
  maxNameLength: 64,
  /** 每条 clip 最多 trigger/tag 数。 */
  maxTags: 16,
  /** clip 文件引用最大长度（与 asset reference 上限一致）。 */
  maxFileLength: 512
} as const

/* -------------------------------------------------------------------------- */
/* 表情 clip                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 一个表情 clip：逐帧权重轨道。
 *
 * 轨道键 = VRM expression 名；值 = 每帧权重（长度必须 = `frames`，值域 0..1）。
 * 只保存非恒零轨道（工具链负责裁剪），因此 `tracks` 可能为空对象（= 全零表情）。
 */
export interface ExpressionClip {
  schemaVersion: 1
  /** 稳定 id（manifest 内唯一；如 `mate/faceDrag` / `hsr/photoAngry`）。 */
  id: string
  /** 数据来源管线。 */
  source: ExpressionClipSource
  /** 源文件（如 `FACE_LAYER/FACE_DRAG.anim` / `Emo_...PhotoGraph_Angry`）。 */
  sourceFile?: string
  /** 帧率（Hz；默认 30）。 */
  fps: number
  /** 帧数（正整数；见文件头的 loop/non-loop 约定）。 */
  frames: number
  /** 时长（秒；= frames/fps 或源时长）。 */
  duration: number
  /** 是否循环。 */
  loop: boolean
  /** 轨道：VRM expression 名 → 每帧权重。 */
  tracks: Record<string, readonly number[]>
  /** 进入该 clip 的淡入时长（秒；缺省用 `EXPRESSION_CLIP_DEFAULTS.fadeInSec`）。 */
  fadeInSec?: number
  /** 离开该 clip 的淡出时长（秒；缺省用 `EXPRESSION_CLIP_DEFAULTS.fadeOutSec`）。 */
  fadeOutSec?: number
  /** 备注（来源/限制/人工判断）。 */
  notes?: string
}

/** JSON 手写的 clip 输入形状（`frames`/`duration` 可省略，由 track 长度推导）。 */
export interface ExpressionClipInput {
  schemaVersion?: number
  id: string
  source?: string
  sourceFile?: string
  fps?: number
  frames?: number
  duration?: number
  loop?: boolean
  tracks: Record<string, readonly number[]>
  fadeInSec?: number
  fadeOutSec?: number
  notes?: string
}

/** 清洗结果（永不抛异常，问题写 warnings）。 */
export interface ExpressionClipSanitizeResult {
  clip: ExpressionClip | null
  warnings: string[]
}

/* -------------------------------------------------------------------------- */
/* 表情集 manifest                                                             */
/* -------------------------------------------------------------------------- */

/** manifest 里的单条 clip 描述（app/加载器消费；文件是私有资产）。 */
export interface ExpressionClipEntry {
  /** 稳定 id（唯一）。 */
  id: string
  /** 数据来源管线。 */
  set: ExpressionClipSource
  /** assets 根相对路径或 `pet-asset://` URL。 */
  file: string
  /** 是否循环。 */
  loop: boolean
  /** 帧率（Hz）。 */
  fps: number
  /** 帧数。 */
  frames: number
  /** 时长（秒）。 */
  duration: number
  /** 选择优先级（同 trigger 高者优先；同优先级取靠前者）。 */
  priority: number
  /** 淡入时长（秒；来自源状态机过渡，如 Mate-Engine Head Pat 1.0s / Drag 0.2s）。 */
  fadeInSec: number
  /** 淡出时长（秒）。 */
  fadeOutSec: number
  /** 触发键（行为/事件名：`drag` / `pet` / `talk` / `idle` / `happy` / `sad` / `angry` / `surprised` / `shy` / `gentle` / `trouble` / `blink`…）。 */
  triggers: readonly string[]
  /** 标签（分类/检索：`face` / `emotion` / `viseme` / `loop`…）。 */
  tags: readonly string[]
  /** 备注。 */
  note?: string
}

/** JSON 手写的 manifest 条目形状（除 id/file 外可省略，清洗回填默认）。 */
export interface ExpressionClipEntryInput {
  id: string
  file: string
  set?: string
  loop?: boolean
  fps?: number
  frames?: number
  duration?: number
  priority?: number
  fadeInSec?: number
  fadeOutSec?: number
  triggers?: readonly string[]
  tags?: readonly string[]
  note?: string
}

/** 表情集 manifest（`assets/expressions/manifest.json` 的消费形状）。 */
export interface ExpressionClipManifest {
  schemaVersion: 1
  /** 生成时间（ISO；工具链写入，可选）。 */
  generatedAt?: string
  /** clip 列表（清洗后保证 id 唯一）。 */
  clips: ExpressionClipEntry[]
}

/** manifest 文件（JSON）的输入形状。 */
export interface ExpressionClipManifestInput {
  schemaVersion?: number
  generatedAt?: string
  clips?: readonly ExpressionClipEntryInput[]
}

/** 空 manifest（无私有表情资产时的安全缺省；调用方回退 preset 表/无表情）。 */
export const EMPTY_EXPRESSION_CLIP_MANIFEST: ExpressionClipManifest = {
  schemaVersion: EXPRESSION_MANIFEST_SCHEMA_VERSION,
  clips: []
}

/* -------------------------------------------------------------------------- */
/* 纯函数：名字/绑定                                                            */
/* -------------------------------------------------------------------------- */

/** 是否为合法 VRM 1.0 preset 名（含 `neutral` / lookAt preset，按契约全集判断）。 */
export function isVrmExpressionPresetName(value: unknown): value is VrmExpressionPreset {
  return typeof value === 'string' && (VRM_EXPRESSION_PRESETS as readonly string[]).includes(value)
}

/** 是否为允许出现在表情 clip 里的 preset 轨道名。 */
export function isExpressionPresetTrack(value: unknown): value is ExpressionPresetTrack {
  return typeof value === 'string' && (EXPRESSION_PRESET_TRACKS as readonly string[]).includes(value)
}

/** 是否为合法 viseme 名。 */
export function isVisemeName(value: unknown): value is VisemeName {
  return typeof value === 'string' && (VISEMES as readonly string[]).includes(value)
}

/** 表情/触发/标签名的宽松校验：非空、≤64 字符、无控制字符（允许日文等自定义 expression 名）。 */
export function isExpressionName(value: unknown, maxLength = EXPRESSION_CLIP_LIMITS.maxNameLength): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(trimmed)
}

/**
 * 源表达名 → 目标 VRM expression 名：
 * - 先小写匹配 `VRM0_EXPRESSION_ALIASES`（VRM0 名 → VRM1 preset；`neutral` → null）；
 * - 若已是 VRM1 preset 名 / 合法自定义名，原样保留（去首尾空白）；
 * - 非法返回 null。
 */
export function normalizeExpressionName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > EXPRESSION_CLIP_LIMITS.maxNameLength) return null
  const alias = VRM0_EXPRESSION_ALIASES[trimmed.toLowerCase()]
  if (alias !== undefined) return alias
  return isExpressionName(trimmed) ? trimmed : null
}

/**
 * 业务表情 → 模型上的 VRM expression 名（avatar manifest 的 `expressions` 绑定）。
 * 缺绑定 / 绑定非法 → null（调用方跳过，不崩；与 `vrm.ts` 契约一致）。
 */
export function resolvePetExpression(
  bindings: VrmExpressionBindings | null | undefined,
  expression: PetExpression | string
): string | null {
  if (!bindings || typeof bindings !== 'object') return null
  if (!(PET_EXPRESSIONS as readonly string[]).includes(expression)) return null
  const bound = (bindings as Record<string, unknown>)[expression]
  return isExpressionName(bound) ? bound : null
}

/**
 * 帧数约定（与引擎侧一致）：
 * - loop：`round(duration*fps)`（不复制末帧；至少 1）；
 * - non-loop：`round(duration*fps)+1`（末帧包含；至少 2）。
 */
export function expectedExpressionFrameCount(duration: number, fps: number, loop: boolean): number {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : EXPRESSION_CLIP_DEFAULTS.fps
  const rounded = Math.round(safeDuration * safeFps)
  if (loop) return Math.max(1, rounded)
  return Math.max(2, rounded + 1)
}

/* -------------------------------------------------------------------------- */
/* 纯函数：清洗                                                                 */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function clampFade(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(EXPRESSION_CLIP_FADE_RANGE.max, Math.max(EXPRESSION_CLIP_FADE_RANGE.min, value))
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return null
  return trimmed
}

/**
 * 清洗单个表情 clip（**永不抛异常**）。
 *
 * 规则：
 * - `id` 必填（非法 → 返回 null）；
 * - `fps` 缺省 30、钳制 1..120；`frames` 缺省由轨道长度推导、钳制 1..6000；
 * - `duration` 缺省 `frames/fps`、钳制 >0..600；与 `frames/fps` 偏差 >1 帧记 warning；
 * - 轨道名非法（空/控制字符/过长）丢弃；轨道长度与 `frames` 不一致 → 丢弃该轨道 + warning；
 * - 权重非有限 → 0；越界 → 钳制 0..1；全零轨道保留（工具链会裁剪，播放端无副作用）；
 * - 至少要有 1 条合法轨道（允许空 `tracks` 的"全零表情"：`tracks: {}` 返回合法 clip）。
 */
export function sanitizeExpressionClip(input: unknown, label = 'expressionClip'): ExpressionClipSanitizeResult {
  const warnings: string[] = []
  if (!isRecord(input)) {
    warnings.push(`${label}：期望对象，已忽略`)
    return { clip: null, warnings }
  }
  const id = readTrimmedString(input.id, EXPRESSION_CLIP_LIMITS.maxNameLength)
  if (id === null) {
    warnings.push(`${label}：缺少合法 id，已忽略`)
    return { clip: null, warnings }
  }
  const source = isExpressionClipSource(input.source) ? input.source : 'mate'
  if (!isExpressionClipSource(input.source)) warnings.push(`${label}(${id})：source 非法，按 mate 处理`)

  const rawTracks = isRecord(input.tracks) ? input.tracks : {}
  const trackNames = Object.keys(rawTracks).slice(0, EXPRESSION_CLIP_LIMITS.maxTracks)
  if (Object.keys(rawTracks).length > EXPRESSION_CLIP_LIMITS.maxTracks) {
    warnings.push(`${label}(${id})：轨道数超过上限 ${EXPRESSION_CLIP_LIMITS.maxTracks}，多余已丢弃`)
  }
  let derivedFrames = 0
  for (const name of trackNames) {
    const values = rawTracks[name]
    if (Array.isArray(values) && values.length > derivedFrames) derivedFrames = values.length
  }

  const fpsValue = readFiniteNumber(input.fps) ?? EXPRESSION_CLIP_DEFAULTS.fps
  const fps = Math.min(
    EXPRESSION_CLIP_LIMITS.maxFps,
    Math.max(EXPRESSION_CLIP_LIMITS.minFps, fpsValue)
  )
  const framesValue = readFiniteNumber(input.frames) ?? derivedFrames
  const frames = Math.min(
    EXPRESSION_CLIP_LIMITS.maxFrames,
    Math.max(1, Math.round(framesValue))
  )
  if (!Number.isFinite(framesValue) || framesValue < 1) warnings.push(`${label}(${id})：frames 非法，已按 ${frames} 处理`)

  const loop = typeof input.loop === 'boolean' ? input.loop : EXPRESSION_CLIP_DEFAULTS.loop
  const durationValue = readFiniteNumber(input.duration) ?? frames / fps
  const duration = Math.min(
    EXPRESSION_CLIP_LIMITS.maxDurationSec,
    Math.max(1 / fps, durationValue)
  )
  const expected = expectedExpressionFrameCount(duration, fps, loop)
  if (Math.abs(expected - frames) > 1) {
    warnings.push(`${label}(${id})：frames=${frames} 与 duration*fps=${expected} 不一致（>1 帧）`)
  }

  const tracks: Record<string, readonly number[]> = {}
  for (const rawName of trackNames) {
    const name = normalizeExpressionName(rawName)
    if (name === null) {
      warnings.push(`${label}(${id})：轨道名非法，已丢弃（${String(rawName).slice(0, 32)}）`)
      continue
    }
    const values = rawTracks[rawName]
    if (!Array.isArray(values) || values.length === 0) {
      warnings.push(`${label}(${id})：轨道 ${name} 不是非空数组，已丢弃`)
      continue
    }
    if (values.length !== frames) {
      warnings.push(`${label}(${id})：轨道 ${name} 长度 ${values.length} ≠ frames ${frames}，已丢弃`)
      continue
    }
    const out = new Array<number>(frames)
    for (let index = 0; index < frames; index += 1) {
      const numeric = typeof values[index] === 'number' ? values[index] : Number.NaN
      out[index] = clamp01(numeric)
    }
    if (!isExpressionPresetTrack(name)) {
      warnings.push(`${label}(${id})：轨道 ${name} 不是 VRM 1.0 preset（自定义 expression，播放端需存在）`)
    }
    tracks[name] = out
  }

  const clip: ExpressionClip = {
    schemaVersion: EXPRESSION_CLIP_SCHEMA_VERSION,
    id,
    source,
    fps,
    frames,
    duration,
    loop,
    tracks
  }
  const sourceFile = readTrimmedString(input.sourceFile, EXPRESSION_CLIP_LIMITS.maxFileLength)
  if (sourceFile !== null) clip.sourceFile = sourceFile
  const fadeIn = readFiniteNumber(input.fadeInSec)
  if (fadeIn !== null) {
    clip.fadeInSec = Math.min(EXPRESSION_CLIP_FADE_RANGE.max, Math.max(EXPRESSION_CLIP_FADE_RANGE.min, fadeIn))
  }
  const fadeOut = readFiniteNumber(input.fadeOutSec)
  if (fadeOut !== null) {
    clip.fadeOutSec = Math.min(EXPRESSION_CLIP_FADE_RANGE.max, Math.max(EXPRESSION_CLIP_FADE_RANGE.min, fadeOut))
  }
  const notes = readTrimmedString(input.notes, 500)
  if (notes !== null) clip.notes = notes
  return { clip, warnings }
}

/**
 * 清洗表情集 manifest（**永不抛异常**）。
 *
 * 规则：非法 clip 条目丢弃；id 重复保留第一个；`file` 用 `isSafeAssetReference` 校验
 * （防目录穿越/绝对路径注入）；枚举/数值/数组全部回填默认或钳制；trim 后为空丢弃。
 */
export function sanitizeExpressionClipManifest(input: unknown): {
  manifest: ExpressionClipManifest
  warnings: string[]
} {
  const warnings: string[] = []
  if (!isRecord(input)) {
    warnings.push('expressionManifest：期望对象，已忽略')
    return { manifest: { ...EMPTY_EXPRESSION_CLIP_MANIFEST, clips: [] }, warnings }
  }
  const rawClips = Array.isArray(input.clips) ? input.clips : []
  const clips: ExpressionClipEntry[] = []
  const seen = new Set<string>()
  for (const [index, raw] of rawClips.slice(0, EXPRESSION_CLIP_LIMITS.maxClips).entries()) {
    if (!isRecord(raw)) {
      warnings.push(`expressionManifest：第 ${index} 条 clip 不是对象，已丢弃`)
      continue
    }
    const id = readTrimmedString(raw.id, EXPRESSION_CLIP_LIMITS.maxNameLength)
    if (id === null) {
      warnings.push(`expressionManifest：第 ${index} 条 clip 缺 id，已丢弃`)
      continue
    }
    if (seen.has(id)) {
      warnings.push(`expressionManifest：clip id 重复（${id}），后者已丢弃`)
      continue
    }
    const file = readTrimmedString(raw.file, EXPRESSION_CLIP_LIMITS.maxFileLength)
    if (file === null || !isSafeAssetReference(file)) {
      warnings.push(`expressionManifest：clip ${id} 的 file 非法，已丢弃`)
      continue
    }
    const set = isExpressionClipSource(raw.set) ? raw.set : 'mate'
    if (!isExpressionClipSource(raw.set)) warnings.push(`expressionManifest：clip ${id} 的 set 非法，按 mate 处理`)
    const fpsValue = readFiniteNumber(raw.fps) ?? EXPRESSION_CLIP_DEFAULTS.fps
    const fps = Math.min(EXPRESSION_CLIP_LIMITS.maxFps, Math.max(EXPRESSION_CLIP_LIMITS.minFps, fpsValue))
    const loop = typeof raw.loop === 'boolean' ? raw.loop : EXPRESSION_CLIP_DEFAULTS.loop
    const framesValue = readFiniteNumber(raw.frames)
    const frames = Math.min(
      EXPRESSION_CLIP_LIMITS.maxFrames,
      Math.max(1, Math.round(framesValue ?? 1))
    )
    const durationValue = readFiniteNumber(raw.duration) ?? (Number.isFinite(framesValue) ? frames / fps : 0)
    const duration = Math.min(
      EXPRESSION_CLIP_LIMITS.maxDurationSec,
      Math.max(1 / fps, durationValue)
    )
    const priorityValue = readFiniteNumber(raw.priority) ?? EXPRESSION_CLIP_DEFAULTS.priority
    const fadeInValue = readFiniteNumber(raw.fadeInSec) ?? EXPRESSION_CLIP_DEFAULTS.fadeInSec
    const fadeOutValue = readFiniteNumber(raw.fadeOutSec) ?? EXPRESSION_CLIP_DEFAULTS.fadeOutSec
    const triggers = readStringArray(raw.triggers)
    const tags = readStringArray(raw.tags)
    const entry: ExpressionClipEntry = {
      id,
      set,
      file,
      loop,
      fps,
      frames,
      duration,
      priority: Math.round(priorityValue),
      fadeInSec: clampFade(fadeInValue),
      fadeOutSec: clampFade(fadeOutValue),
      triggers,
      tags
    }
    const note = readTrimmedString(raw.note, 500)
    if (note !== null) entry.note = note
    seen.add(id)
    clips.push(entry)
  }
  if (rawClips.length > EXPRESSION_CLIP_LIMITS.maxClips) {
    warnings.push(`expressionManifest：clip 数超过上限 ${EXPRESSION_CLIP_LIMITS.maxClips}，多余已丢弃`)
  }
  const manifest: ExpressionClipManifest = {
    schemaVersion: EXPRESSION_MANIFEST_SCHEMA_VERSION,
    clips
  }
  const generatedAt = readTrimmedString(input.generatedAt, 64)
  if (generatedAt !== null) manifest.generatedAt = generatedAt
  return { manifest, warnings }
}

/** 字符串数组清洗（去空、去重、限长、最多 `maxTags` 个）。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value.slice(0, EXPRESSION_CLIP_LIMITS.maxTags)) {
    const name = readTrimmedString(item, EXPRESSION_CLIP_LIMITS.maxNameLength)
    if (name === null || out.includes(name)) continue
    out.push(name)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* 纯函数：选择 / 采样 / 混合                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 按触发键选择表情 clip：triggers 包含该键（或 id 等于该键）的条目里，
 * **priority 高者优先，同优先级取靠前者**；没有匹配 → null（调用方回退）。
 */
export function findExpressionClip(
  manifest: ExpressionClipManifest | null | undefined,
  trigger: string
): ExpressionClipEntry | null {
  if (!manifest || !Array.isArray(manifest.clips) || typeof trigger !== 'string') return null
  const target = trigger.trim()
  if (target.length === 0) return null
  let best: ExpressionClipEntry | null = null
  let bestPriority = -Infinity
  for (const clip of manifest.clips) {
    const matches = clip.id === target || clip.triggers.includes(target)
    if (!matches) continue
    if (clip.priority > bestPriority) {
      best = clip
      bestPriority = clip.priority
    }
  }
  return best
}

/** 是否存在某触发键的表情 clip。 */
export function hasExpressionClip(
  manifest: ExpressionClipManifest | null | undefined,
  trigger: string
): boolean {
  return findExpressionClip(manifest, trigger) !== null
}

/**
 * 采样表情 clip：`timeSec` 时刻的各 expression 权重（线性插值，0..1）。
 *
 * - loop：时间按 `duration` 回绕，末帧与首帧插值；
 * - non-loop：时间钳制到 `[0, duration]`，末帧后保持；
 * - 返回**新对象**（只含 >0 的轨道，已 clamp/round 到 4 位小数，便于稳定断言）。
 */
export function sampleExpressionClip(
  clip: ExpressionClip,
  timeSec: number
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!clip || !isRecord(clip.tracks)) return out
  const frames = Math.max(1, Math.round(clip.frames))
  const fps = Math.max(EXPRESSION_CLIP_LIMITS.minFps, clip.fps)
  const duration = clip.duration > 0 ? clip.duration : frames / fps
  let time = Number.isFinite(timeSec) ? timeSec : 0
  if (clip.loop) {
    time = ((time % duration) + duration) % duration
  } else {
    time = Math.min(Math.max(0, time), duration)
  }
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
    if (weight > 1e-4) out[name] = Math.round(weight * 10000) / 10000
  }
  return out
}

/** 表情权重 Map/Record 的深拷贝（只含 0..1 有限值）。 */
export function sanitizeExpressionWeights(
  weights: Readonly<Record<string, number>> | Map<string, number> | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!weights) return out
  const entries = weights instanceof Map ? weights.entries() : Object.entries(weights)
  for (const [name, raw] of entries) {
    const weight = clamp01(typeof raw === 'number' ? raw : Number.NaN)
    if (!isExpressionName(name) || weight <= 0) continue
    out[name] = weight
  }
  return out
}

/**
 * 把 `source` 的权重按 **max** 规则合并进 `target`（返回新对象）：
 * 同 expression 取较大值（等价 MMD 表情"取 max"口径，避免叠加过冲）。
 */
export function mergeExpressionWeightsMax(
  target: Readonly<Record<string, number>>,
  source: Readonly<Record<string, number>>
): Record<string, number> {
  const out: Record<string, number> = sanitizeExpressionWeights(target)
  for (const [name, raw] of Object.entries(sanitizeExpressionWeights(source))) {
    out[name] = Math.max(out[name] ?? 0, raw)
  }
  return out
}

/**
 * 对权重表做整体缩放（如"说话时情绪表情 ×0.85"），返回新对象；结果 clamp 0..1。
 */
export function scaleExpressionWeights(
  weights: Readonly<Record<string, number>>,
  factor: number
): Record<string, number> {
  const safeFactor = Number.isFinite(factor) ? Math.max(0, factor) : 0
  const out: Record<string, number> = {}
  for (const [name, value] of Object.entries(weights)) {
    const scaled = clamp01(value * safeFactor)
    if (scaled > 0) out[name] = scaled
  }
  return out
}

/** 表情 clip 时长（秒；防御非法值）。 */
export function expressionClipDuration(clip: ExpressionClip | null | undefined): number {
  if (!clip) return 0
  if (Number.isFinite(clip.duration) && clip.duration > 0) return clip.duration
  const frames = Number.isFinite(clip.frames) ? clip.frames : 0
  const fps = Number.isFinite(clip.fps) && clip.fps > 0 ? clip.fps : EXPRESSION_CLIP_DEFAULTS.fps
  return frames > 0 ? frames / fps : 0
}
