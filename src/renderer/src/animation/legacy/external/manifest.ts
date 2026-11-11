/**
 * 外部 MMD 动作清单（`motion-index.json`）解析与校验 —— **纯函数**（不 import three/DOM）。
 *
 * 清单由「动作素材」侧生成，放 `assets/model/optimized/motion-index.json`，运行期用
 * `fetch(buildPetAssetUrl('motion-index.json'))` 读取（协议只接受**单段文件名**，见
 * `src/main/protocol-path.ts` 的 M-2 契约，所以 `file` 必须是单段名字）。
 *
 * 格式（唯一约定，Wave 2.5 / D1）：
 * ```json
 * { "schemaVersion": 1, "clips": [
 *   { "id": "idle", "file": "motion-idle.vmd", "moods": ["idle"], "loop": true, "ik": "on",
 *     "nominalSpeedPxPerSec": null, "crossfadeMs": 200, "grounding": "feet",
 *     "seatedAnchor": "feet", "source": "..." }
 * ] }
 * ```
 *
 * 设计原则（与 B3 的防御性风格一致）：
 * - **未知字段忽略**（向前兼容，动作队友加字段不破坏旧客户端）；
 * - **非法项跳过 + 返回告警**（不抛错、不阻塞渲染；调用方把 warnings console.warn 即可）；
 * - 清单缺失/为空/版本不认识 → 返回**空清单**，调用方回退 B3 程序化姿态。
 */

import type { PetMood } from '@shared/types'

/** 运行期清单文件名（`assets/model/optimized/` 下，单段文件名；与动作侧约定）。 */
export const MOTION_MANIFEST_FILE = 'motion-index.json'

/** 支持的清单 schema 版本（不匹配则整份忽略并告警）。 */
export const MOTION_SCHEMA_VERSION = 1

/** 外部动作类型：D1 只接 VMD；`vpd` 预留给后续静态姿势通道。 */
export type ExternalClipKind = 'vmd' | 'vpd'

/** 足ＩＫ 模式：`on` = 启用模型自带足ＩＫ CCDIK；`off` = 纯 FK。 */
export type IkMode = 'on' | 'off'

/**
 * 贴地补偿模式（Wave 2.5 / D4）：
 * - `feet`（默认）：每帧把「最低脚骨世界坐标」对齐到 bind pose 脚底高度（站/走/跑等脚着地动作）；
 * - `none`：不做脚底补偿（坐姿/倚靠等「脚悬垂或踩在坐面上」动作——clip 自己把 センター 降到
 *   坐面高度，强行按脚底贴面会把角色整体抬高到座位之上，观感错误）。
 */
export type GroundingMode = 'feet' | 'none'

/**
 * 坐姿锚点（Wave 2.5 / D5，用户实机反馈）：
 * - `feet`（默认）：脚底贴放表面（站/走/普通坐姿）；
 * - `hips`：**臀部贴表面**、腿悬垂（窗沿坐专用）——播放期间把 `下半身` 骨对齐到摆放线的
 *   世界高度（仅在高于底部、非地面表面时生效），并让 hit/bubble 跟随视觉偏移。
 */
export type SeatedAnchor = 'feet' | 'hips'

/** 交叉淡化默认/钳制范围（毫秒；与 B3 现有过渡风格一致）。 */
export const DEFAULT_CROSSFADE_MS = 200
export const MIN_CROSSFADE_MS = 120
export const MAX_CROSSFADE_MS = 250

/** 一条外部动作 clip 定义（校验后的强类型，运行期只读）。 */
export interface MotionClipDef {
  /** clip id（唯一；如 `idle` / `walk` / `taunt`）。 */
  id: string
  /** VMD 文件名（`assets/model/optimized/` 下的**单段**文件名，不含目录）。 */
  file: string
  /** 该 clip 服务的 `PetMood`（可多个；`walk` 也是 PetMood 之一）。 */
  moods: readonly PetMood[]
  /** 是否循环播放（默认 true；false = 播完回退 B3）。 */
  loop: boolean
  /** 足ＩＫ 模式（通过 `helper.enable('ik', ...)` 全局设定；r171 不消费 VMD 的 IK 开关段）。 */
  ik: IkMode
  /**
   * 走路类 clip 的「原地步态对应的宠物移动速度」（px/s）。
   * 非 null 时按 `当前水平速度 / nominal` 调 `mixer.timeScale`（钳制 0.5–1.6）。
   */
  nominalSpeedPxPerSec: number | null
  /** 切换淡入时长（毫秒；运行时再夹到 120–250ms）。 */
  crossfadeMs: number
  /** 贴地补偿模式（默认 `feet`；坐姿类用 `none`，见 `GroundingMode`）。 */
  grounding: GroundingMode
  /** 坐姿锚点（默认 `feet`；窗沿坐用 `hips`，见 `SeatedAnchor`）。 */
  seatedAnchor: SeatedAnchor
  /** 要剔除的骨骼轨道（PMX 骨名；例如外部动作的脚趾 `足先EX` 轨道会造成脚趾上翘）。 */
  suppressBones: readonly string[]
  /** 极短/静态坐姿时叠加的微量程序化摆动（避免像冻结的姿势）。 */
  microSway: boolean
  /**
   * 坐姿锚点微调（模型单位；正 = 锚点位置取在锚定骨上方，视觉整体下移）。
   * 用于把「骨盆中心对齐窗沿」微调成「臀底贴窗沿」；默认 0。
   */
  seatedAnchorOffsetUnits: number
  /** 来源/作者/许可（仅本地记录，不参与播放）。 */
  source: string | null
}

/** 校验后的清单（clips 为空 = 无可用外部动作）。 */
export interface MotionManifest {
  schemaVersion: typeof MOTION_SCHEMA_VERSION
  clips: readonly MotionClipDef[]
}

/** 解析结果：`manifest` 永远可用（失败 = 空清单），`warnings` 供 console.warn/调试面。 */
export interface ParseMotionIndexResult {
  manifest: MotionManifest
  warnings: string[]
}

/** 全部合法 `PetMood` 值（清单 `moods` 的取值域；与 `@shared/types` 的联合类型保持同步）。 */
export const PET_MOODS: readonly PetMood[] = [
  'idle',
  'walk',
  'climb',
  'sit',
  'sleep',
  'drag',
  'fall',
  'pat',
  'grabWindow',
  'dshBusy',
  'dshDone',
  'dshError'
]

/** 空清单（无可播放外部动作；调用方回退 B3）。 */
export function emptyMotionManifest(): MotionManifest {
  return { schemaVersion: MOTION_SCHEMA_VERSION, clips: [] }
}

/**
 * 校验 `file` 是「单段 .vmd 文件名」：非空、不含路径分隔符/冒号/NUL、不是 `.`/`..`、扩展名 .vmd。
 * 与 `pet-asset://model/<单段文件名>` 协议契约（M-2）一致，避免清单把 URL 指向根外。
 */
export function isSingleSegmentVmdFileName(file: string): boolean {
  if (typeof file !== 'string') return false
  const value = file.trim()
  if (value.length === 0) return false
  if (value === '.' || value === '..') return false
  if (/[/\\:\0]/.test(value)) return false
  return value.toLowerCase().endsWith('.vmd')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 解析单条 clip；非法返回 null 并写 warning（指数组下标便于定位清单）。 */
function parseClipEntry(raw: unknown, index: number, warnings: string[]): MotionClipDef | null {
  const where = `clips[${index}]`
  if (!isRecord(raw)) {
    warnings.push(`${where} 不是对象，已跳过`)
    return null
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id.length === 0) {
    warnings.push(`${where} 缺少非空字符串 id，已跳过`)
    return null
  }
  const tag = `${where}（${id}）`

  const file = typeof raw.file === 'string' ? raw.file.trim() : ''
  if (!isSingleSegmentVmdFileName(file)) {
    warnings.push(`${tag} file 非法（必须是单段 .vmd 文件名），已跳过`)
    return null
  }

  const rawMoods = raw.moods
  if (rawMoods !== undefined && !Array.isArray(rawMoods)) {
    warnings.push(`${tag} moods 不是数组，按空处理`)
  }
  const moods: PetMood[] = []
  const unknownMoods: string[] = []
  if (Array.isArray(rawMoods)) {
    for (const item of rawMoods) {
      if (typeof item !== 'string' || !(PET_MOODS as readonly string[]).includes(item)) {
        unknownMoods.push(typeof item === 'string' ? item : String(item))
        continue
      }
      const mood = item as PetMood
      if (!moods.includes(mood)) moods.push(mood)
    }
  }
  if (unknownMoods.length > 0) {
    warnings.push(`${tag} 忽略未知 mood：${unknownMoods.join('、')}`)
  }
  if (moods.length === 0) {
    warnings.push(`${tag} 没有可用 mood，已跳过`)
    return null
  }

  let loop = true
  if (raw.loop !== undefined) {
    if (typeof raw.loop === 'boolean') loop = raw.loop
    else warnings.push(`${tag} loop 不是布尔值，使用默认 true`)
  }

  let ik: IkMode = 'on'
  if (raw.ik !== undefined) {
    if (raw.ik === 'on' || raw.ik === 'off') ik = raw.ik
    else warnings.push(`${tag} ik 非法（只能是 "on"/"off"），使用默认 "on"`)
  }

  let nominalSpeedPxPerSec: number | null = null
  if (raw.nominalSpeedPxPerSec !== undefined && raw.nominalSpeedPxPerSec !== null) {
    if (isFiniteNumber(raw.nominalSpeedPxPerSec) && raw.nominalSpeedPxPerSec > 0) {
      nominalSpeedPxPerSec = raw.nominalSpeedPxPerSec
    } else {
      warnings.push(`${tag} nominalSpeedPxPerSec 非法（需正数或 null），按 null 处理`)
    }
  }

  let crossfadeMs = DEFAULT_CROSSFADE_MS
  if (raw.crossfadeMs !== undefined && raw.crossfadeMs !== null) {
    if (isFiniteNumber(raw.crossfadeMs) && raw.crossfadeMs >= 0) {
      crossfadeMs = Math.round(raw.crossfadeMs)
    } else {
      warnings.push(`${tag} crossfadeMs 非法（需非负数字），使用默认 ${DEFAULT_CROSSFADE_MS}`)
    }
  }

  let grounding: GroundingMode = 'feet'
  if (raw.grounding !== undefined) {
    if (raw.grounding === 'feet' || raw.grounding === 'none') grounding = raw.grounding
    else warnings.push(`${tag} grounding 非法（只能是 "feet"/"none"），使用默认 "feet"`)
  }

  let seatedAnchor: SeatedAnchor = 'feet'
  if (raw.seatedAnchor !== undefined) {
    if (raw.seatedAnchor === 'feet' || raw.seatedAnchor === 'hips') seatedAnchor = raw.seatedAnchor
    else warnings.push(`${tag} seatedAnchor 非法（只能是 "feet"/"hips"），使用默认 "feet"`)
  }

  let suppressBones: string[] = []
  if (raw.suppressBones !== undefined) {
    if (Array.isArray(raw.suppressBones)) {
      suppressBones = raw.suppressBones
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim())
        .slice(0, 64)
      if (suppressBones.length !== raw.suppressBones.length) {
        warnings.push(`${tag} suppressBones 含非法项，已忽略（只保留非空字符串）`)
      }
    } else {
      warnings.push(`${tag} suppressBones 需为字符串数组，已忽略`)
    }
  }

  let microSway = false
  if (raw.microSway !== undefined) {
    if (typeof raw.microSway === 'boolean') microSway = raw.microSway
    else warnings.push(`${tag} microSway 需为布尔值，已忽略`)
  }

  let seatedAnchorOffsetUnits = 0
  if (raw.seatedAnchorOffsetUnits !== undefined) {
    if (typeof raw.seatedAnchorOffsetUnits === 'number' && Number.isFinite(raw.seatedAnchorOffsetUnits)) {
      seatedAnchorOffsetUnits = Math.max(-10, Math.min(10, raw.seatedAnchorOffsetUnits))
    } else {
      warnings.push(`${tag} seatedAnchorOffsetUnits 非法（需有限数），使用默认 0`)
    }
  }

  const source =
    typeof raw.source === 'string' && raw.source.trim().length > 0 ? raw.source.trim() : null

  return {
    id,
    file,
    moods,
    loop,
    ik,
    nominalSpeedPxPerSec,
    crossfadeMs,
    grounding,
    seatedAnchor,
    seatedAnchorOffsetUnits,
    suppressBones,
    microSway,
    source
  }
}

/**
 * 解析运行期动作清单（输入 = `JSON.parse` 后的任意值；不做 IO，Node 可单测）。
 *
 * 任何非法输入都返回**空清单 + 告警**，不抛错：动作素材缺失/写坏时 app 必须完全回退 B3。
 */
export function parseMotionIndex(raw: unknown): ParseMotionIndexResult {
  const warnings: string[] = []
  if (raw === null || raw === undefined) {
    warnings.push('motion-index 缺失或为空')
    return { manifest: emptyMotionManifest(), warnings }
  }
  if (!isRecord(raw)) {
    warnings.push('motion-index 顶层不是对象')
    return { manifest: emptyMotionManifest(), warnings }
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== MOTION_SCHEMA_VERSION) {
    warnings.push(
      `motion-index schemaVersion=${String(raw.schemaVersion)} 不受支持（期望 ${MOTION_SCHEMA_VERSION}）`
    )
    return { manifest: emptyMotionManifest(), warnings }
  }
  if (!Array.isArray(raw.clips)) {
    warnings.push('motion-index.clips 不是数组')
    return { manifest: emptyMotionManifest(), warnings }
  }

  const clips: MotionClipDef[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < raw.clips.length; index += 1) {
    const def = parseClipEntry(raw.clips[index], index, warnings)
    if (!def) continue
    if (seenIds.has(def.id)) {
      warnings.push(`clips[${index}]（${def.id}）id 重复，已跳过`)
      continue
    }
    seenIds.add(def.id)
    clips.push(def)
  }
  if (clips.length === 0) warnings.push('motion-index 没有可用 clip（回退 B3 程序化姿态）')

  return { manifest: { schemaVersion: MOTION_SCHEMA_VERSION, clips }, warnings }
}
