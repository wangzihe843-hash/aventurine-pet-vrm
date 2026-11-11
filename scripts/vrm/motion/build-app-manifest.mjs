#!/usr/bin/env node
/**
 * 生成 app 层私有动作清单（Wave 2 / V1，clip-engine）
 *
 *   node scripts/vrm/motion/build-app-manifest.mjs            # 构建并写盘
 *   node scripts/vrm/motion/build-app-manifest.mjs --check    # 只校验磁盘产物与现状一致（幂等）
 *
 * 输入（私有，gitignore）：
 * - `assets/motions/mate/manifest.json`（Wave 1.5，29 clip；**必需**）
 * - `assets/motions/hsr/manifest.json`（Wave 1.5-V3，14 clip；**必需**）
 * - `assets/motions/adv/manifest.json`（3ds Max Biped 新动作集；**可选**——文件不存在时整集跳过，
 *   不报错、不影响 mate/hsr 产物字节；真实数据到位后由 `build-adv-manifest.mjs` 生成）
 *
 * 输出（私有生成物，由本脚本维护、不入 git）：
 * - `assets/motions/app-manifest.json`：**冻结契约** `AnimationClipManifest` 形状
 *   （`src/shared/animation-contract.ts`），只放 mood/salute 槽位，`file` 相对 `assets/motions/`；
 * - `assets/motions/app-catalog.json`：运行时扩展格式（设计 §4.3），列出全部 clip
 *   （含 hide/intro/pose/skill/hit 等一次性片段），供事件/调试按 id 播放。
 *
 * 映射规则（设计 §2.3）：
 * - `slot ∈ CLIP_SLOT_MOODS`（= PET_MOODS + salute）且非 null 的 clip 直接进 app-manifest，
 *   其余（slot=null 的一次性片段）只进 catalog；
 * - `pat ← happy/laughing/shyPoint` 已由源 manifest 的 `slot:"pat"` 表达，直接透传；
 * - app 层 id 统一加 `<set>-` 前缀（mate/hsr 有同名 clip：`idle`/`idle2`；adv 同样加 `adv-` 前缀）；
 * - priority / loop / timeScale / fade 沿用源 manifest（缺省回填源 defaults 或契约默认值）；
 * - adv 首期不设 priority override、不加 mood 别名（选片待 user 确认；见 task-9 / docs/adv-app-integration.md）。
 *
 * 幂等：产物不含 generatedAt 等时间戳，`--check` 逐字节比较生成文本。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { formatHelp, parseCliArgs } from '../../unity-bake/lib/cli-args.mjs'

/** app-manifest schema 版本（= 冻结契契约 `ANIMATION_MANIFEST_SCHEMA_VERSION`）。 */
export const APP_MANIFEST_SCHEMA_VERSION = 1
/** app-catalog schema 版本（设计 §4.3）。 */
export const APP_CATALOG_VERSION = 1
/** app 清单文件名（相对 motions 根）。 */
export const APP_MANIFEST_FILE = 'app-manifest.json'
export const APP_CATALOG_FILE = 'app-catalog.json'
/** 源动作集（固定顺序保证产物确定；adv 追加在末尾，缺省时不影响既有 mate/hsr 产物字节）。 */
export const SOURCE_SETS = Object.freeze(['mate', 'hsr', 'adv'])
/**
 * **可选**源动作集：源 manifest 允许不存在，缺省时整集跳过（不报错、不产出任何条目）。
 * - `adv`（3ds Max Biped 新动作集）：真实数据未到位时 `assets/motions/adv/manifest.json` 可缺失；
 *   到位后同一生成器自动纳入（catalog 全收 + slot 非 null 进 app-manifest），无需改代码。
 * - mate/hsr 仍是**必需**源：缺 manifest 直接 fail（防私有资产未准备时静默产出残缺清单）。
 */
export const OPTIONAL_SOURCE_SETS = Object.freeze(['adv'])
const OPTIONAL_SOURCE_SET_LOOKUP = new Set(OPTIONAL_SOURCE_SETS)
/** 合法动作槽位（= `src/shared/animation-contract.ts` 的 `ANIMATION_CLIP_MOODS`：
 * PET_MOODS 全集 + salute）。**改契约需同步改这里**（脚本不能 import TS 契约）。
 */
export const CLIP_SLOT_MOODS = Object.freeze([
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
  'dshError',
  'salute'
])
/** clip id 合法规则（与 animation-contract 的清洗规则一致）。 */
const CLIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** app 层 id 最大长度（含 `<set>-` 前缀；契约上限 64）。 */
const APP_CLIP_ID_MAX_LENGTH = 64
/**
 * app 层优先级覆盖（V5 实机验收，按 `<set>` + 源 clip id 生效；只影响 app-manifest）。
 *
 * 背景：mate 集 `sit` 组里 `sitWindow`/`windowLay*` 是「窗沿躺」姿势，不是地面坐姿；
 * 直接按源 priority（sitWindow=0 最高）会让 mood=sit 播放横躺动画并悬空。
 * 规则：
 * - 地面坐姿：`sit1`(10) > `sit2`(9) > `suwari3`(8)；
 * - 窗沿躺 `sitWindow`/`windowLay*` 降到 -10 以下：仍保留在 app-manifest（将来「窗沿躺」
 *   特殊动作可按 id 播放），但 clip-player 的待机变体轮换阈值是 -9，不会轮到它们；
 * - walk/walkAlt（Mate-Engine 女性向步态）降到 -10/-11：男角色主走路改由 HSR 官方
 *   `adv-walk`（priority 5）承担；两者仍在 catalog/app-manifest 里可按 id 回退，但不再
 *   参与 walk 变体轮换，避免 HSR 官方走路与 Mate 女性步态来回切；
 * - catalog 不含 priority，全部 clip 不变。
 */
export const PRIORITY_OVERRIDES = Object.freeze({
  mate: Object.freeze({
    sit1: 10,
    sit2: 9,
    suwari3: 8,
    sitWindow: -10,
    windowLay8: -11,
    windowLay9: -12,
    windowLay10: -13,
    /**
     * Mate 女性向 idle（PET_IDLE*）降为 catalog-only：男角色 idle 池只保留 HSR/adv 官方动作。
     * 2026-11-09 用户验收：Husbando HUS_IDLE01 及候选 02–09 的“直臂下垂”观感被判定偏 A-pose/不符人设，
     * 因此 Mate idle 保留数据（可按 id 回退/给女性模型用）但不参与 mood 变体轮换（阈值 -9）。
     */
    idle: -10,
    idle2: -11,
    idle3: -12,
    idle4: -13,
    idle5: -14,
    idle6: -15,
    idle7: -16,
    walk: -10,
    walkAlt: -11
  }),
  // adv（task-9）：首期**不启用** override —— priority 直接取源 manifest（由 adv registry 决定）。
  // 真实数据验收后若需要压/抬槽位冲突（如新主 idle 与 hsr-idle 同为 10），在这里补表即可，
  // 生成器规则不变；空表不会产生「覆盖表未命中」warning。
  adv: Object.freeze({})
})

/**
 * 「catalog 一次性/展示 clip → mood 槽位」别名（V7 dsh* + V11 pose 稀有变体）。
 *
 * 背景：B1/B7 会发 `mood=dshBusy/dshDone/dshError`（PetMood 契约合法），mate/hsr 源 manifest
 * 没有绑定这些槽位的 clip；idle 也需要「低概率展示动作」。这里用 catalog 里已有的
 * 展示/一次性 clip「起别名」追加进 app-manifest（**不复制文件、不重复下载**，catalog 不变）：
 * - dshBusy：hsr Common_IdleShow（8.37s 循环）→ 安静/专注待机；B1 在 DSH 任务期间保持该 mood；
 * - dshDone：mate PET_HAPPY（6.55s，非循环）→ 开心庆祝，播完由 player 回当前 mood；
 * - dshError：hsr State_Stun（1.83s，**loop=true**）→ 长时间受击/倒地；「倒地不动」由动画层
 *   保持该 mood 的时长实现（clip 层循环播放），hitL 只留 catalog 不接线；
 * - idle 稀有条目：mate pose1/2/3 → idle 变体，priority -7/-8/-8，loop=true，
 *   fade 0.8/1.0；clip-player 的稀有权重（priority ≤ -7 权重 0.3）让它们约 7% 概率/次轮换。
 *
 * 别名 id = `<set>-<clip>-<mood>`（避免与 catalog 既有 `<set>-<clip>` id 冲突）；
 * 同一 clip 可以同时在 catalog（原 id）与 app-manifest（别名 id）中出现，这是预期行为。
 */
export const MOOD_CLIP_ALIASES = Object.freeze([
  {
    set: 'hsr',
    clip: 'commonIdle',
    mood: 'dshBusy',
    loop: true,
    priority: 0,
    timeScale: 1,
    fadeInSec: 0.3,
    fadeOutSec: 0.3,
    note: 'DSH 任务进行中：安静待机（hsr Common_IdleShow 循环，B1 保持该 mood 期间循环播放）'
  },
  {
    set: 'mate',
    clip: 'happy',
    mood: 'dshDone',
    loop: false,
    priority: 0,
    timeScale: 1,
    fadeInSec: 0.15,
    fadeOutSec: 0.3,
    note: 'DSH 任务完成：mate PET_HAPPY 开心动作（非循环，播完回 mood）'
  },
  {
    set: 'hsr',
    clip: 'stun',
    mood: 'dshError',
    loop: true,
    priority: 0,
    timeScale: 1,
    fadeInSec: 0.15,
    fadeOutSec: 0.25,
    note: 'DSH 任务出错/受挫：HSR State_Stun（1.83s 循环；倒地不动由动画层保持 mood 时长实现）'
  },
  {
    set: 'adv',
    clip: 'think01',
    mood: 'dshBusy',
    loop: true,
    priority: 0,
    timeScale: 1,
    fadeInSec: 0.3,
    fadeOutSec: 0.3,
    note: 'DSH 任务进行中：adv Think01 思考待机循环（与 hsr-commonIdle 同分随机；2026-11-10 用户要求）'
  },
  {
    set: 'adv',
    clip: 'snap01loop',
    mood: 'dshDone',
    loop: true,
    priority: 0,
    timeScale: 1,
    fadeInSec: 0.15,
    fadeOutSec: 0.3,
    note: 'DSH 任务完成：adv Snap01 打响指庆祝（loop 段在 2.5s mood 窗口内被截断，同 mate-happy 先例）'
  },
  // idle 稀有展示变体：2026-11-09 男性适配验收后先降为 catalog-only（priority ≤ -10，
  // 不参与 idle 变体轮换）；女性向 pose 数据仍在 catalog，可按 id 播放/后续女性 profile 恢复。
  {
    set: 'mate',
    clip: 'pose1',
    mood: 'idle',
    loop: true,
    priority: -10,
    timeScale: 1,
    fadeInSec: 0.8,
    fadeOutSec: 1.0,
    note: 'idle 稀有展示动作 1（6.8s 循环；当前 catalog-only，避免男角色 idle 池混入女性向 pose）'
  },
  {
    set: 'mate',
    clip: 'pose2',
    mood: 'idle',
    loop: true,
    priority: -11,
    timeScale: 1,
    fadeInSec: 0.8,
    fadeOutSec: 1.0,
    note: 'idle 稀有展示动作 2（6.8s 循环；当前 catalog-only）'
  },
  {
    set: 'mate',
    clip: 'pose3',
    mood: 'idle',
    loop: true,
    priority: -12,
    timeScale: 1,
    fadeInSec: 0.8,
    fadeOutSec: 1.0,
    note: 'idle 稀有展示动作 3（5.0s 循环；当前 catalog-only）'
  }
])

/**
 * 扩展说明（task-9）：MOOD_CLIP_ALIASES 的结构对任意源集通用（`set` 必须在生成时的 `sets` 内），
 * 未来给 adv 接线只需追加一条
 *   `{ set: 'adv', clip: '<adv 源 clip id>', mood: '<CLIP_SLOT_MOODS 之一>', loop, priority, fadeInSec, fadeOutSec, note }`：
 * - 源 clip 必须已在 `adv/manifest.json` 登记（否则构建 error，防清单/文件漂移）；
 * - app 层 id = `adv-<clip>-<mood>`，与 catalog 的 `adv-<clip>` id 不冲突；同一 clip 可同时
 *   出现在 catalog（原 id）与 app-manifest（别名 id）；
 * - **2026-11-10：adv 已加 2 条 dsh 别名**（`dshBusy`←`think01`、`dshDone`←`snap01loop`，按用户要求）；
 *   其余动作→mood 绑定（`dshError`/idle 稀有变体等）仍按 `docs/adv-clip-selection.md`
 *   需 user 实机确认后再接线（见 `docs/adv-app-integration.md`）。
 */

/** 源 defaults / 契约默认值（`ANIMATION_CLIP_DEFAULTS`）。 */
const FALLBACK_DEFAULTS = Object.freeze({
  loop: true,
  timeScale: 1,
  fadeInSec: 0.15,
  fadeOutSec: 0.2,
  rootMotion: 'inPlace'
})

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 由一个源 manifest（mate/hsr/adv）的 clip 列表构建 app 层条目。
 * 三条源集共用同一套契约/字段规则（只差 set 前缀与 priority override 表）。
 * @param {unknown} sourceManifest
 * @param {string} set
 * @param {(file: string) => boolean} [clipExists] 可选：校验 file 对应磁盘文件存在
 */
function buildSetEntries(sourceManifest, set, clipExists) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {Array<Record<string, unknown>>} */
  const appClips = []
  /** @type {Array<Record<string, unknown>>} */
  const catalogClips = []
  /** 已命中的优先级覆盖（用于检测覆盖表指向不存在的 clip）。 */
  const usedOverrides = new Set()

  if (!isRecord(sourceManifest)) {
    errors.push(`${set}/manifest.json 不是对象`)
    return { appClips, catalogClips, errors, warnings, usedOverrides }
  }
  const defaults = isRecord(sourceManifest.defaults) ? sourceManifest.defaults : {}
  const readDefault = (key) => {
    const value = defaults[key]
    if (key === 'loop') return typeof value === 'boolean' ? value : FALLBACK_DEFAULTS.loop
    if (key === 'rootMotion') return value === 'inPlace' ? 'inPlace' : FALLBACK_DEFAULTS.rootMotion
    return isFiniteNumber(value) ? value : FALLBACK_DEFAULTS[key]
  }
  const sources = Array.isArray(sourceManifest.clips) ? sourceManifest.clips : null
  if (sources === null) {
    errors.push(`${set}/manifest.json 缺少 clips 数组`)
    return { appClips, catalogClips, errors, warnings, usedOverrides }
  }
  if (sources.length === 0) errors.push(`${set}/manifest.json clips 为空`)
  if (sourceManifest.schemaVersion !== 1) {
    errors.push(
      `${set}/manifest.json schemaVersion 期望 1（实际 ${JSON.stringify(sourceManifest.schemaVersion)}）`
    )
  }

  const seenIds = new Set()
  for (let index = 0; index < sources.length; index += 1) {
    const clip = sources[index]
    const label = `${set}/manifest.json clips[${index}]`
    if (!isRecord(clip)) {
      errors.push(`${label}：期望对象`)
      continue
    }
    const id = typeof clip.id === 'string' ? clip.id.trim() : ''
    if (id.length === 0 || !CLIP_ID_PATTERN.test(id)) {
      errors.push(`${label}.id：缺失/非法（实际 ${JSON.stringify(clip.id)}）`)
      continue
    }
    if (seenIds.has(id)) {
      errors.push(`${label}.id：重复 id "${id}"`)
      continue
    }
    seenIds.add(id)
    const appId = `${set}-${id}`
    if (appId.length > APP_CLIP_ID_MAX_LENGTH) {
      errors.push(`${label}.id：app 层 id "${appId}" 超长（>${APP_CLIP_ID_MAX_LENGTH}）`)
      continue
    }

    // 槽位：null/缺省 = 一次性片段（只进 catalog）；非法槽位 = error（防源数据漂移）
    let mood = null
    if (clip.slot !== null && clip.slot !== undefined) {
      if (typeof clip.slot === 'string' && CLIP_SLOT_MOODS.includes(clip.slot)) {
        mood = clip.slot
      } else {
        errors.push(`${label}.slot：非法动作槽位 ${JSON.stringify(clip.slot)}`)
        continue
      }
    }

    const file = `${set}/${id}.json`
    if (typeof clip.file === 'string' && clip.file !== file) {
      warnings.push(`${label}.file："${clip.file}" 与约定 "${file}" 不同（以约定为准）`)
    }
    if (typeof clipExists === 'function' && !clipExists(file)) {
      errors.push(`${label}：clip 文件不存在 ${file}（先跑 unity-bake / V3 管线）`)
      continue
    }

    // 数值字段（越界/非法只 warning + 回填，不中断构建）
    let loop = readDefault('loop')
    if (typeof clip.loop === 'boolean') loop = clip.loop
    else if (clip.loop !== undefined) warnings.push(`${label}.loop：非布尔，按 ${loop} 处理`)

    let timeScale = readDefault('timeScale')
    if (isFiniteNumber(clip.timeScale) && clip.timeScale > 0) timeScale = clip.timeScale
    else if (clip.timeScale !== undefined) {
      warnings.push(`${label}.timeScale：非法，按 ${timeScale} 处理`)
    }

    let fadeInSec = readDefault('fadeInSec')
    if (isFiniteNumber(clip.fadeInSec) && clip.fadeInSec >= 0) fadeInSec = clip.fadeInSec
    else if (clip.fadeInSec !== undefined) {
      warnings.push(`${label}.fadeInSec：非法，按 ${fadeInSec}s 处理`)
    }
    let fadeOutSec = readDefault('fadeOutSec')
    if (isFiniteNumber(clip.fadeOutSec) && clip.fadeOutSec >= 0) fadeOutSec = clip.fadeOutSec
    else if (clip.fadeOutSec !== undefined) {
      warnings.push(`${label}.fadeOutSec：非法，按 ${fadeOutSec}s 处理`)
    }

    let rootMotion = readDefault('rootMotion')
    if (clip.rootMotion === 'inPlace') rootMotion = 'inPlace'
    else if (clip.rootMotion !== undefined) {
      warnings.push(`${label}.rootMotion：非法，按 ${rootMotion} 处理`)
    }

    let priority = 0
    if (Number.isInteger(clip.priority)) priority = clip.priority
    else if (clip.priority !== undefined) warnings.push(`${label}.priority：非整数，按 0 处理`)
    // V5 优先级覆盖（mate sit：地面坐姿优先；窗沿躺降到 -10 以下）
    const override = PRIORITY_OVERRIDES[set]?.[id]
    if (typeof override === 'number') {
      priority = override // 预期内的覆盖，无需 warning（未命中的覆盖表项才 warning）
      usedOverrides.add(`${set}/${id}`)
    }

    const duration = isFiniteNumber(clip.duration) && clip.duration >= 0 ? clip.duration : null
    if (duration === null) warnings.push(`${label}.duration：缺失/非法（catalog 按 0 处理）`)

    /** @type {string[]} */
    const tags = []
    if (Array.isArray(clip.tags)) {
      for (const tag of clip.tags) {
        if (typeof tag === 'string' && tag.trim().length > 0 && !tags.includes(tag.trim())) {
          tags.push(tag.trim())
        }
      }
    } else if (clip.tags !== undefined) {
      warnings.push(`${label}.tags：期望字符串数组，已忽略`)
    }

    catalogClips.push({
      id: appId,
      set,
      file,
      loop,
      duration: duration ?? 0,
      tags,
      mood
    })
    if (mood !== null) {
      appClips.push({ id: appId, mood, file, loop, timeScale, fadeInSec, fadeOutSec, rootMotion, priority })
    }
  }
  return { appClips, catalogClips, errors, warnings, usedOverrides }
}

/**
 * 构建「mood ← catalog clip」别名条目（见 `MOOD_CLIP_ALIASES`）。
 * 源 clip 必须在对应 set 的源 manifest 中登记（否则 error，防止清单/文件漂移）。
 */
function buildMoodAliases({ sources, sets, clipExists }) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {Array<Record<string, unknown>>} */
  const appClips = []
  const sourceSets = isRecord(sources) ? sources : {}

  for (const alias of MOOD_CLIP_ALIASES) {
    const label = `mood 别名 ${alias.set}/${alias.clip}→${alias.mood}`
    if (!sets.includes(alias.set)) continue
    if (!CLIP_SLOT_MOODS.includes(alias.mood)) {
      errors.push(`${label}：mood ${JSON.stringify(alias.mood)} 不在 CLIP_SLOT_MOODS`)
      continue
    }
    const source = sourceSets[alias.set]
    // 可选源（adv）整集缺省：该集别名同样跳过（与直映射一致，避免把「可选源未提供」误报为源 clip 缺失）。
    if (source === undefined && OPTIONAL_SOURCE_SET_LOOKUP.has(alias.set)) continue
    const clips = isRecord(source) && Array.isArray(source.clips) ? source.clips : []
    const sourceClip = clips.find(
      (clip) => isRecord(clip) && typeof clip.id === 'string' && clip.id === alias.clip
    )
    if (sourceClip === undefined) {
      errors.push(`${label}：源 manifest 中找不到 clip "${alias.clip}"`)
      continue
    }
    const file = `${alias.set}/${alias.clip}.json`
    if (typeof clipExists === 'function' && !clipExists(file)) {
      errors.push(`${label}：clip 文件不存在 ${file}`)
      continue
    }
    const id = `${alias.set}-${alias.clip}-${alias.mood}`
    if (id.length > APP_CLIP_ID_MAX_LENGTH) {
      errors.push(`${label}：app 层 id "${id}" 超长（>${APP_CLIP_ID_MAX_LENGTH}）`)
      continue
    }
    appClips.push({
      id,
      mood: alias.mood,
      file,
      loop: alias.loop === true,
      timeScale: isFiniteNumber(alias.timeScale) && alias.timeScale > 0 ? alias.timeScale : 1,
      fadeInSec: isFiniteNumber(alias.fadeInSec) && alias.fadeInSec >= 0 ? alias.fadeInSec : 0.15,
      fadeOutSec: isFiniteNumber(alias.fadeOutSec) && alias.fadeOutSec >= 0 ? alias.fadeOutSec : 0.2,
      rootMotion: 'inPlace',
      priority: Number.isInteger(alias.priority) ? alias.priority : 0
    })
  }
  return { appClips, errors, warnings }
}

/**
 * 构建两份 app 清单（纯函数，便于单测）。
 *
 * @param {{
 *   sources: Record<string, unknown>,
 *   sets?: readonly string[],
 *   clipExists?: (file: string) => boolean,
 *   aliases?: boolean
 * }} input（`aliases=false` 关闭 MOOD_CLIP_ALIASES 追加，仅供单测）
 * @returns {{
 *   appManifest: { schemaVersion: number, clips: Array<Record<string, unknown>> },
 *   catalog: { version: number, clips: Array<Record<string, unknown>> },
 *   stats: Record<string, unknown>,
 *   errors: string[],
 *   warnings: string[],
 *   skippedOptionalSets: string[]
 * }}
 */
export function buildAppManifests({ sources, sets = SOURCE_SETS, clipExists, aliases = true } = {}) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {Array<Record<string, unknown>>} */
  const appClips = []
  /** @type {Array<Record<string, unknown>>} */
  const catalogClips = []
  const sourceSets = isRecord(sources) ? sources : {}
  /**
   * 缺省跳过的可选源集（供 CLI/测试识别；不影响产物，也不产生 error）。
   * @type {string[]}
   */
  const skippedOptionalSets = []

  const usedOverrides = new Set()
  for (const set of sets) {
    // 可选源（adv）缺省：整集跳过。判定依据是「调用方没提供该集」（generate 只在文件存在时载入），
    // 因此不影响既有 mate/hsr 产物；若提供了但内容非法，仍按必需源规则报 error（防静默残缺）。
    if (sourceSets[set] === undefined && OPTIONAL_SOURCE_SET_LOOKUP.has(set)) {
      skippedOptionalSets.push(set)
      continue
    }
    const built = buildSetEntries(sourceSets[set], set, clipExists)
    for (const message of built.errors) errors.push(message)
    for (const message of built.warnings) warnings.push(message)
    for (const key of built.usedOverrides) usedOverrides.add(key)
    appClips.push(...built.appClips)
    catalogClips.push(...built.catalogClips)
  }
  // 覆盖表指向不存在的 clip = 源 manifest 漂移，warning 提示（不阻断构建）
  for (const set of sets) {
    for (const id of Object.keys(PRIORITY_OVERRIDES[set] ?? {})) {
      if (!usedOverrides.has(`${set}/${id}`)) {
        warnings.push(`优先级覆盖表 ${set}/${id} 未命中源 manifest（数据漂移？）`)
      }
    }
  }

  // V7：catalog clip → mood 别名（dshBusy/dshDone/dshError），追加进 app-manifest。
  // 单测可用 `aliases:false` 关掉（只测源 manifest 直映射规则）；CLI 恒为 true。
  const aliasBuilt =
    aliases === false
      ? { appClips: [], errors: [], warnings: [] }
      : buildMoodAliases({ sources: sourceSets, sets, clipExists })
  for (const message of aliasBuilt.errors) errors.push(message)
  for (const message of aliasBuilt.warnings) warnings.push(message)
  appClips.push(...aliasBuilt.appClips)

  // catalog 的 app 层 id 必须唯一（跨 set 同名 clip 靠前缀区分）
  const seenAppIds = new Set()
  for (const clip of catalogClips) {
    const id = String(clip.id)
    if (seenAppIds.has(id)) errors.push(`app 层 id 重复：${id}`)
    seenAppIds.add(id)
  }
  // app-manifest 的 id 也必须唯一（含 mood 别名 id）
  const seenAppManifestIds = new Set()
  for (const clip of appClips) {
    const id = String(clip.id)
    if (seenAppManifestIds.has(id)) errors.push(`app-manifest id 重复：${id}`)
    seenAppManifestIds.add(id)
  }

  /** @type {Record<string, number>} */
  const moodCounts = {}
  for (const clip of appClips) {
    const mood = String(clip.mood)
    moodCounts[mood] = (moodCounts[mood] ?? 0) + 1
  }
  /** @type {Record<string, number>} */
  const setCounts = {}
  for (const clip of catalogClips) {
    const set = String(clip.set)
    setCounts[set] = (setCounts[set] ?? 0) + 1
  }
  const oneShotBySet = {}
  for (const clip of catalogClips) {
    if (clip.mood !== null) continue
    const set = String(clip.set)
    oneShotBySet[set] = (oneShotBySet[set] ?? 0) + 1
  }

  return {
    appManifest: { schemaVersion: APP_MANIFEST_SCHEMA_VERSION, clips: appClips },
    catalog: { version: APP_CATALOG_VERSION, clips: catalogClips },
    stats: {
      appClipCount: appClips.length,
      /** V7：由 catalog clip 起的 mood 别名数（dshBusy/dshDone/dshError）。 */
      moodAliasCount: aliasBuilt.appClips.length,
      catalogClipCount: catalogClips.length,
      oneShotCount: catalogClips.filter((clip) => clip.mood === null).length,
      moodCounts,
      setCounts,
      oneShotBySet
    },
    errors,
    warnings,
    skippedOptionalSets
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const DEFAULTS = {
  motionsDir: 'assets/motions'
}

const OPTIONS = {
  'motions-dir': {
    type: 'string',
    default: DEFAULTS.motionsDir,
    valueHint: 'dir',
    description: 'motions 私有资产根目录（含 mate/hsr/adv 子目录；adv 可选）'
  },
  manifest: {
    type: 'string',
    default: '',
    valueHint: 'path',
    description: `app-manifest 输出（默认 <motions-dir>/${APP_MANIFEST_FILE}）`
  },
  catalog: {
    type: 'string',
    default: '',
    valueHint: 'path',
    description: `app-catalog 输出（默认 <motions-dir>/${APP_CATALOG_FILE}）`
  },
  check: {
    type: 'boolean',
    default: false,
    description: '只校验磁盘产物与当前源 manifest 一致（不写盘；幂等）'
  }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/motion/build-app-manifest.mjs',
  description:
    'Wave 2 / V1：由 assets/motions/{mate,hsr}(+可选 adv)/manifest.json 生成 app 层 app-manifest.json + app-catalog.json（私有生成物）。',
  usage:
    'node scripts/vrm/motion/build-app-manifest.mjs [--motions-dir <dir>] [--manifest <path>] ' +
    '[--catalog <path>] [--check]',
  options: OPTIONS,
  footer:
    '退出码：0 = 成功/一致；1 = 构建错误或 --check 不一致；2 = 参数错误。\n' +
    '产物不含时间戳（内容确定），--check 逐字节比较，可安全用于 CI/提交前校验（需私有 assets）。\n' +
    'adv 源 manifest 缺省（assets/motions/adv/manifest.json 不存在）时自动跳过，不影响 mate/hsr 产物字节。'
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message) {
  console.error(`[app-manifest] ${message}`)
  process.exit(1)
}

/** 读 JSON 文件；失败返回 null（warnings 由调用方打印）。 */
function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} 不存在：${toDisplayPath(filePath)}（私有资产未生成？）`)
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`${label} JSON 解析失败（${toDisplayPath(filePath)}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function printStats(stats) {
  console.log(
    `[app-manifest] app-manifest：${stats.appClipCount} clips（mood/salute 槽位；` +
      `含 ${stats.moodAliasCount} 条 catalog→mood 别名）`
  )
  const moodText = Object.entries(stats.moodCounts)
    .map(([mood, count]) => `${mood} ${count}`)
    .join(' / ')
  console.log(`[app-manifest] 槽位分布：${moodText || '（无）'}`)
  console.log(
    `[app-manifest] app-catalog：${stats.catalogClipCount} clips（一次性 ${stats.oneShotCount}：` +
      `${Object.entries(stats.oneShotBySet)
        .map(([set, count]) => `${set} ${count}`)
        .join(' / ')}）`
  )
  console.log(
    `[app-manifest] 来源：${Object.entries(stats.setCounts)
      .map(([set, count]) => `${set} ${count}`)
      .join(' / ')}`
  )
}

/** 可选源缺省跳过的提示（只影响 console，不影响产物字节）。 */
function printSkippedOptionalSets(skippedOptionalSets) {
  if (!Array.isArray(skippedOptionalSets) || skippedOptionalSets.length === 0) return
  console.log(
    `[app-manifest] 可选源缺省跳过：${skippedOptionalSets.join(' / ')}` +
      '（源 manifest 不存在；产物不含该集，mate/hsr 产物不受影响）'
  )
}

function generate(motionsDir) {
  const sources = {}
  for (const set of SOURCE_SETS) {
    const manifestPath = path.join(motionsDir, set, 'manifest.json')
    // 可选源（adv）manifest 缺省：不载入 → buildAppManifests 记入 skippedOptionalSets，
    // 产物与只有 mate/hsr 时逐字节一致；文件存在但内容非法仍按必需源规则报 error。
    if (!fs.existsSync(manifestPath) && OPTIONAL_SOURCE_SET_LOOKUP.has(set)) continue
    sources[set] = readJson(manifestPath, `${set}/manifest.json`)
  }
  return buildAppManifests({
    sources,
    clipExists: (file) => fs.existsSync(path.join(motionsDir, file))
  })
}

function runCheck({ generated, manifestPath, catalogPath }) {
  const expectedManifest = JSON.stringify(generated.appManifest, null, 2) + '\n'
  const expectedCatalog = JSON.stringify(generated.catalog, null, 2) + '\n'
  /** @type {string[]} */
  const problems = []
  for (const [filePath, expected, label] of [
    [manifestPath, expectedManifest, 'app-manifest'],
    [catalogPath, expectedCatalog, 'app-catalog']
  ]) {
    if (!fs.existsSync(filePath)) {
      problems.push(`${label} 不存在：${toDisplayPath(filePath)}（跑一次构建命令）`)
      continue
    }
    const actual = fs.readFileSync(filePath, 'utf8')
    if (actual !== expected) {
      problems.push(`${label} 与当前源 manifest 不一致（需重新构建）：${toDisplayPath(filePath)}`)
    }
  }
  if (problems.length > 0) {
    console.error(`[app-manifest] --check FAIL：${problems.length} 个问题`)
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    process.exit(1)
  }
  printStats(generated.stats)
  printSkippedOptionalSets(generated.skippedOptionalSets)
  console.log(
    `[app-manifest] --check PASS：产物与源 manifest 一致（${toDisplayPath(manifestPath)}, ${toDisplayPath(catalogPath)}）`
  )
  process.exit(0)
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[app-manifest] 参数错误：${error}`)
    console.error(HELP)
    process.exit(2)
  }

  const motionsDir = path.resolve(String(values['motions-dir']))
  const manifestPath = values.manifest
    ? path.resolve(String(values.manifest))
    : path.join(motionsDir, APP_MANIFEST_FILE)
  const catalogPath = values.catalog
    ? path.resolve(String(values.catalog))
    : path.join(motionsDir, APP_CATALOG_FILE)
  const check = values.check === true

  const generated = generate(motionsDir)
  if (generated.warnings.length > 0) {
    console.log(`[app-manifest] warning ${generated.warnings.length}：`)
    for (const warning of generated.warnings) console.log(`  ! ${warning}`)
  }
  if (generated.errors.length > 0) {
    console.error(`[app-manifest] FAIL：${generated.errors.length} 个错误（不写盘）`)
    for (const error of generated.errors) console.error(`  ✗ ${error}`)
    process.exit(1)
  }

  if (check) {
    runCheck({ generated, manifestPath, catalogPath })
    return
  }

  const manifestText = JSON.stringify(generated.appManifest, null, 2) + '\n'
  const catalogText = JSON.stringify(generated.catalog, null, 2) + '\n'
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true })
  fs.writeFileSync(manifestPath, manifestText)
  fs.writeFileSync(catalogPath, catalogText)
  printStats(generated.stats)
  printSkippedOptionalSets(generated.skippedOptionalSets)
  console.log(`[app-manifest] 写入：${toDisplayPath(manifestPath)}`)
  console.log(`[app-manifest] 写入：${toDisplayPath(catalogPath)}`)
  process.exit(0)
}

/** 仅当直接执行时跑 CLI（被测试 import 时只导出纯函数）。 */
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (invokedPath !== '' && import.meta.url === invokedPath) {
  main()
}
