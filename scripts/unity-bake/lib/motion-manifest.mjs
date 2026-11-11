/**
 * motion manifest 构建与一致性校验（Wave 1.5 / U2）
 *
 * 纯 ESM：不 import node 内置模块（fs 留给 CLI），可单测/浏览器复用。
 *
 * 输入：
 * - `selection` = `scripts/unity-bake/clips.json`（B lane 维护的新 schema）：
 *   `{ fps, motionSet, requirements: {tag: 下限数量}, clips: [{name, path, mood, tags,
 *   loop, timeScale, priority, note}] }`；
 * - `clips` = 已读入的 clip JSON，按 name 索引的普通对象（`{ [name]: clipData }`）。
 *
 * 输出 manifest（写入 `assets/motions/mate/manifest.json`，canonical）：
 * ```
 * { schemaVersion: 1, set, generatedAt,
 *   source: {name:'Mate-Engine', attribution:'Shiny', license:'MateEngine Pro License v2.1',
 *            redistribution:'forbidden-local-only'},
 *   defaults: {loop:true, timeScale:1, fadeInSec:0.15, fadeOutSec:0.2, rootMotion:'inPlace'},
 *   clips: [{id, file:'mate/<id>.json', slot, tags, loop, timeScale, priority,
 *            duration, fps, frames, sourcePath}],
 *   coverage: {tag: count},
 *   checks: {ok, errors, warnings} }
 * ```
 *
 * 设计要点：
 * - `slot` 来自 selection 的 `mood`：合法动作槽位（`CONTRACT_CLIP_SLOTS`）原样写入；
 *   `mood === ''`（事件类片段：intro/hiding/talking/hover/pose…）= `null`；
 *   非空但非法槽位 = error（防止 B lane 配置漂移）；
 * - 每个 clip 都跑 `validateClipData`，其 errors/warnings 以 `clip "<id>":` 前缀并入；
 * - `requirements` 的键即合法 tag 全集；实际覆盖数 < 下限 = error；
 * - `checks.ok === false` 时 CLI 不写盘（避免产出半残 manifest）。
 */
import { validateClipData } from './clip-validation.mjs'
import { CONTRACT_CLIP_SLOTS, isContractClipSlot } from './humanoid-map.mjs'

/** manifest schema 版本（不兼容变更时递增）。 */
export const MOTION_MANIFEST_SCHEMA_VERSION = 1

/** 资产来源/授权（Mate-Engine 动作私有使用，不随 app 分发）。 */
export const MOTION_MANIFEST_SOURCE = Object.freeze({
  name: 'Mate-Engine',
  attribution: 'Shiny',
  license: 'MateEngine Pro License v2.1',
  redistribution: 'forbidden-local-only'
})

/** clip 播放默认值（与 `src/shared/animation-contract.ts` 的 ANIMATION_CLIP_DEFAULTS 对齐）。 */
export const MOTION_MANIFEST_DEFAULTS = Object.freeze({
  loop: true,
  timeScale: 1,
  fadeInSec: 0.15,
  fadeOutSec: 0.2,
  rootMotion: 'inPlace'
})

/** clip id 规则（与 animation-contract 的清洗规则一致）。 */
export const MOTION_CLIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** clip id 最大长度（与 animation-contract 的 MAX_CLIP_ID_LENGTH 一致）。 */
export const MOTION_CLIP_ID_MAX_LENGTH = 64
/** timeScale 合法区间（与 ANIMATION_CLIP_TIME_SCALE_RANGE 一致）。 */
export const MOTION_TIME_SCALE_RANGE = Object.freeze({ min: 0.1, max: 4 })
/** priority 合法区间（与 animation-contract 内部常量一致，整数）。 */
export const MOTION_PRIORITY_RANGE = Object.freeze({ min: -100, max: 100 })

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 由 selection + clip 数据构建 manifest。
 *
 * @param {{
 *   selection: unknown,
 *   clips: unknown,
 *   generatedAt?: string,
 *   limits?: object
 * }} input
 * @returns {{
 *   manifest: {
 *     schemaVersion: number,
 *     set: string,
 *     generatedAt: string,
 *     source: typeof MOTION_MANIFEST_SOURCE,
 *     defaults: typeof MOTION_MANIFEST_DEFAULTS,
 *     clips: Array<Record<string, unknown>>,
 *     coverage: Record<string, number>,
 *     checks: { ok: boolean, errors: string[], warnings: string[] }
 *   },
 *   coverage: Record<string, number>,
 *   errors: string[],
 *   warnings: string[]
 * }}
 */
export function buildMotionManifest({ selection, clips, generatedAt, limits } = {}) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  const clipMap = isRecord(clips) ? clips : {}

  let generated = new Date().toISOString()
  if (generatedAt !== undefined) {
    if (typeof generatedAt === 'string' && generatedAt.length > 0) {
      generated = generatedAt
      if (Number.isNaN(Date.parse(generated))) errors.push(`generatedAt 不是可解析的时间字符串：${generated}`)
    } else {
      errors.push(`generatedAt 必须是 ISO 字符串（实际 ${JSON.stringify(generatedAt)}）`)
    }
  }

  const skeleton = () => ({
    schemaVersion: MOTION_MANIFEST_SCHEMA_VERSION,
    set: 'mate',
    generatedAt: generated,
    source: MOTION_MANIFEST_SOURCE,
    defaults: MOTION_MANIFEST_DEFAULTS,
    clips: [],
    coverage: {},
    checks: { ok: false, errors, warnings }
  })

  if (!isRecord(selection)) {
    errors.push('selection 不是对象（期望 scripts/unity-bake/clips.json 的内容）')
    return { manifest: skeleton(), coverage: {}, errors, warnings }
  }

  const set =
    typeof selection.motionSet === 'string' && selection.motionSet.trim().length > 0
      ? selection.motionSet.trim()
      : 'mate'
  if (typeof selection.motionSet === 'string' && selection.motionSet.trim() !== selection.motionSet) {
    warnings.push(`selection.motionSet 含首尾空白，已 trim 为 "${set}"`)
  } else if (selection.motionSet !== undefined && typeof selection.motionSet !== 'string') {
    errors.push(`selection.motionSet 必须是字符串（实际 ${JSON.stringify(selection.motionSet)}）`)
  }

  let selectionFps = null
  if (selection.fps !== undefined) {
    const fps = readNumber(selection.fps)
    if (fps === null || fps <= 0) errors.push(`selection.fps 必须是正有限数（实际 ${JSON.stringify(selection.fps)}）`)
    else selectionFps = fps
  }

  // ---------- requirements ----------
  const requirements = {}
  if (!isRecord(selection.requirements)) {
    errors.push('selection.requirements 必须是对象（{tag: 下限数量}）')
  } else {
    for (const [tag, value] of Object.entries(selection.requirements)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        errors.push(`requirements.${tag} 必须是非负整数（实际 ${JSON.stringify(value)}）`)
        continue
      }
      requirements[tag] = value
    }
    if (Object.keys(requirements).length === 0) {
      errors.push('selection.requirements 为空，无法定义 tag 全集与覆盖下限')
    }
  }
  const requirementKeys = new Set(Object.keys(requirements))
  /** @type {Record<string, number>} */
  const coverage = {}
  for (const tag of requirementKeys) coverage[tag] = 0

  // ---------- clips ----------
  const rawEntries = selection.clips
  /** @type {Array<Record<string, unknown>>} */
  const manifestClips = []
  if (!Array.isArray(rawEntries)) {
    errors.push('selection.clips 必须是数组')
  } else if (rawEntries.length === 0) {
    errors.push('selection.clips 为空')
  }
  const entries = Array.isArray(rawEntries) ? rawEntries : []
  const seenIds = new Set()

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const label = `clips[${index}]`
    if (!isRecord(entry)) {
      errors.push(`${label}: 必须是对象`)
      continue
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name.length === 0) {
      errors.push(`${label}.name 缺失或为空`)
      continue
    }
    const idLabel = `clip "${name}"`
    if (!MOTION_CLIP_ID_PATTERN.test(name)) {
      errors.push(`${label}.name "${name}" 非法（需匹配 ${MOTION_CLIP_ID_PATTERN}）`)
      continue
    }
    if (name.length > MOTION_CLIP_ID_MAX_LENGTH) {
      errors.push(`${label}.name 超长（${name.length} > ${MOTION_CLIP_ID_MAX_LENGTH}）`)
      continue
    }
    if (seenIds.has(name)) {
      errors.push(`${label}.name "${name}" 重复（id 必须唯一）`)
      continue
    }
    seenIds.add(name)

    const sourcePath = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (sourcePath.length === 0) errors.push(`${idLabel}: path 缺失或为空`)

    // mood → slot
    let slot = null
    if (entry.mood === undefined || entry.mood === null || entry.mood === '') {
      slot = null
    } else if (typeof entry.mood === 'string' && isContractClipSlot(entry.mood)) {
      slot = entry.mood
    } else {
      errors.push(
        `${idLabel}: mood ${JSON.stringify(entry.mood)} 非法（必须是 ${CONTRACT_CLIP_SLOTS.join('/')} 之一；` +
          `事件类片段（intro/hiding/talking/hover/pose）请用 ""）`
      )
    }

    // tags
    /** @type {string[]} */
    const tags = []
    if (entry.tags === undefined) {
      warnings.push(`${idLabel}: tags 缺失，按 [] 处理`)
    } else if (!Array.isArray(entry.tags)) {
      errors.push(`${idLabel}: tags 必须是数组`)
    } else {
      const seenTags = new Set()
      for (const tag of entry.tags) {
        if (typeof tag !== 'string' || tag.length === 0) {
          errors.push(`${idLabel}: tag 必须是非空字符串（实际 ${JSON.stringify(tag)}）`)
          continue
        }
        if (!requirementKeys.has(tag)) {
          errors.push(
            `${idLabel}: tag "${tag}" 不在 requirements 的键内（允许：${[...requirementKeys].join('/') || '无'}）`
          )
          continue
        }
        if (seenTags.has(tag)) {
          warnings.push(`${idLabel}: tag "${tag}" 重复`)
          continue
        }
        seenTags.add(tag)
        tags.push(tag)
      }
    }

    // loop
    let loop = MOTION_MANIFEST_DEFAULTS.loop
    if (entry.loop === undefined) {
      warnings.push(`${idLabel}: loop 缺失，按 ${loop} 处理`)
    } else if (typeof entry.loop !== 'boolean') {
      errors.push(`${idLabel}: loop 必须是布尔值（实际 ${JSON.stringify(entry.loop)}）`)
    } else {
      loop = entry.loop
    }

    // timeScale
    let timeScale = MOTION_MANIFEST_DEFAULTS.timeScale
    if (entry.timeScale === undefined) {
      warnings.push(`${idLabel}: timeScale 缺失，按 ${timeScale} 处理`)
    } else {
      const value = readNumber(entry.timeScale)
      if (value === null) {
        errors.push(`${idLabel}: timeScale 必须是数字（实际 ${JSON.stringify(entry.timeScale)}）`)
      } else if (value < MOTION_TIME_SCALE_RANGE.min || value > MOTION_TIME_SCALE_RANGE.max) {
        errors.push(
          `${idLabel}: timeScale ${value} 越界（合法 ${MOTION_TIME_SCALE_RANGE.min}–${MOTION_TIME_SCALE_RANGE.max}）`
        )
      } else {
        timeScale = value
      }
    }

    // priority
    let priority = 0
    if (entry.priority === undefined) {
      warnings.push(`${idLabel}: priority 缺失，按 0 处理`)
    } else {
      const value = readNumber(entry.priority)
      if (
        value === null ||
        !Number.isInteger(value) ||
        value < MOTION_PRIORITY_RANGE.min ||
        value > MOTION_PRIORITY_RANGE.max
      ) {
        errors.push(
          `${idLabel}: priority ${JSON.stringify(entry.priority)} 非法（整数 ${MOTION_PRIORITY_RANGE.min}–${MOTION_PRIORITY_RANGE.max}）`
        )
      } else {
        priority = value
      }
    }

    if (typeof entry.note !== 'string' || entry.note.trim().length === 0) {
      warnings.push(`${idLabel}: note 缺失/为空（建议写一句中文来源说明）`)
    }

    // clip 数据
    const data = clipMap[name]
    if (data === undefined || data === null) {
      errors.push(`${idLabel}: 磁盘上找不到 clip 数据（${name}.json）`)
    } else {
      const validation = validateClipData(data, limits ? { limits } : {})
      for (const message of validation.errors) errors.push(`${idLabel}: ${message}`)
      for (const message of validation.warnings) warnings.push(`${idLabel}: ${message}`)
      if (isRecord(data)) {
        if (typeof data.clip === 'string' && data.clip !== name) {
          warnings.push(`${idLabel}: clip JSON 的 clip 字段为 "${data.clip}"，与 id 不一致`)
        }
        if (typeof data.loop === 'boolean' && data.loop !== loop) {
          warnings.push(
            `${idLabel}: clip JSON loop=${data.loop} 与 selection.loop=${loop} 不一致（manifest 以 selection 为准）`
          )
        }
        if (
          selectionFps !== null &&
          typeof data.fps === 'number' &&
          Math.abs(data.fps - selectionFps) > 1e-6
        ) {
          warnings.push(`${idLabel}: clip fps=${data.fps} 与 selection.fps=${selectionFps} 不一致`)
        }
      }
    }

    for (const tag of tags) coverage[tag] += 1

    const duration = isRecord(data) ? readNumber(data.duration) : null
    const fps = isRecord(data) ? readNumber(data.fps) : selectionFps
    const frames = isRecord(data) && Number.isInteger(data.frames) ? data.frames : null
    manifestClips.push({
      id: name,
      file: `${set}/${name}.json`,
      slot,
      tags,
      loop,
      timeScale,
      priority,
      duration,
      fps: fps ?? selectionFps,
      frames,
      sourcePath
    })
  }

  // ---------- coverage 下限 ----------
  for (const [tag, required] of Object.entries(requirements)) {
    const actual = coverage[tag] ?? 0
    if (actual < required) {
      errors.push(`覆盖不足：tag "${tag}" 需要 ≥${required}，实际 ${actual}`)
    }
  }

  const manifest = {
    schemaVersion: MOTION_MANIFEST_SCHEMA_VERSION,
    set,
    generatedAt: generated,
    source: MOTION_MANIFEST_SOURCE,
    defaults: MOTION_MANIFEST_DEFAULTS,
    clips: manifestClips,
    coverage,
    checks: { ok: errors.length === 0, errors, warnings }
  }
  return { manifest, coverage, errors, warnings }
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 校验磁盘上的 manifest 是否与「当前 selection + clip 数据」一致（供 `--check`）。
 * 忽略 `generatedAt` 的时点差异（以磁盘值为准重建），但要求结构/条目/coverage 完全一致。
 *
 * @param {unknown} manifest 磁盘读到的 manifest
 * @param {unknown} selection
 * @param {unknown} clips 按 name 索引的 clip 数据
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateManifestAgainstSelection(manifest, selection, clips) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []

  if (!isRecord(manifest)) {
    return { ok: false, errors: ['manifest 不是对象'], warnings }
  }
  if (manifest.schemaVersion !== MOTION_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `manifest.schemaVersion 期望 ${MOTION_MANIFEST_SCHEMA_VERSION}（实际 ${JSON.stringify(manifest.schemaVersion)}）`
      ],
      warnings
    }
  }

  const diskGeneratedAt = typeof manifest.generatedAt === 'string' ? manifest.generatedAt : undefined
  if (typeof manifest.generatedAt !== 'string' || manifest.generatedAt.length === 0) {
    errors.push('manifest.generatedAt 缺失或不是字符串')
  }
  const built = buildMotionManifest({
    selection,
    clips,
    generatedAt: diskGeneratedAt
  })
  for (const message of built.errors) errors.push(message)
  for (const message of built.warnings) warnings.push(message)

  const expected = built.manifest
  if (built.errors.length > 0) {
    // selection/clip 本身有问题时无法做「磁盘 vs 现状」的等价比较。
    return { ok: false, errors, warnings }
  }

  if (isRecord(manifest.checks) && manifest.checks.ok === false) {
    errors.push('磁盘 manifest 的 checks.ok=false（构建时存在错误，不应发布）')
  }

  if (manifest.set !== expected.set) {
    errors.push(`manifest.set 期望 "${expected.set}"（实际 ${JSON.stringify(manifest.set)}）`)
  }
  if (!jsonEqual(manifest.source, expected.source)) {
    errors.push('manifest.source 与当前生成规则不一致')
  }
  if (!jsonEqual(manifest.defaults, expected.defaults)) {
    errors.push('manifest.defaults 与当前生成规则不一致')
  }

  const diskClips = Array.isArray(manifest.clips) ? manifest.clips : null
  if (diskClips === null) {
    errors.push('manifest.clips 必须是数组')
  } else {
    if (diskClips.length !== expected.clips.length) {
      errors.push(`manifest.clips 数量 ${diskClips.length} 与 selection 期望 ${expected.clips.length} 不一致`)
    }
    const byId = new Map()
    for (const clip of diskClips) {
      if (isRecord(clip) && typeof clip.id === 'string') byId.set(clip.id, clip)
    }
    for (const expectedClip of expected.clips) {
      const id = String(expectedClip.id)
      const diskClip = byId.get(id)
      if (diskClip === undefined) {
        errors.push(`manifest 缺少 clip "${id}"（selection 中存在）`)
        continue
      }
      if (!jsonEqual(diskClip, expectedClip)) {
        errors.push(`manifest 中 clip "${id}" 字段与 selection/clip 现状不一致（需重新构建）`)
      }
      byId.delete(id)
    }
    for (const extraId of byId.keys()) {
      errors.push(`manifest 含多余 clip "${extraId}"（selection 中不存在）`)
    }
  }

  if (!jsonEqual(manifest.coverage, expected.coverage)) {
    errors.push(
      `manifest.coverage 与 selection 期望不一致（期望 ${JSON.stringify(expected.coverage)}，` +
        `实际 ${JSON.stringify(manifest.coverage)}）`
    )
  }

  return { ok: errors.length === 0, errors, warnings }
}
