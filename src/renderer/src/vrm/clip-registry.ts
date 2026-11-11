/**
 * VRM humanoid clip 注册表（V1 运行时，Wave 2 / clip-engine）
 *
 * 职责：
 * 1. 从 `pet-asset://assets/motions/` 拉取两份**私有生成清单**（`scripts/vrm/motion/build-app-manifest.mjs` 产出）：
 *    - `app-manifest.json`：冻结契约 `AnimationClipManifest` 形状（只有 mood/salute 槽位，供状态机选片）；
 *    - `app-catalog.json`：运行时扩展格式（全部 clip，含 hide/intro/pose/skill/hit 等一次性片段，
 *      供事件/调试按 id 播放）；
 * 2. clip JSON **懒加载 + Map 缓存**（同一 id 并发请求去重）；
 * 3. 预载常用槽位（idle/walk/sit/sleep/drag/pat）的所有清单条目：`init()` 至少等每个槽位
 *    最高优先级的 clip 就绪（保证 `ready` 后马上有动作可播），其余在后台继续预载
 *    （`whenPreloaded()` 可等待全部完成，测试/调试用）；
 * 4. 失败降级：manifest/clip 缺失、坏 JSON、坏轨道都只 **warn 一次**，不抛异常。
 *
 * 设计见 `docs/wave2-vrm-runtime-design.md` §2.1/§2.2/§2.3/§4.2/§4.3；
 * 对外只暴露 `clip-player.ts` 需要的读取接口，不 import three。
 */
import {
  sanitizeAnimationClipManifest,
  type AnimationClipEntry,
  type AnimationClipManifest,
  type AnimationClipMood
} from '@shared/animation-contract'
import { isSafeAssetReference } from '@shared/vrm'

import { parseClipData, type ParsedClip } from './clip-data'
import { isClipSlotMood } from './humanoid-map'

/* -------------------------------------------------------------------------- */
/* 常量 / 类型                                                                 */
/* -------------------------------------------------------------------------- */

/** app 清单默认基址（`pet-asset://` 的 `assets` host 指向仓库/资源包的 `assets/` 根）。 */
export const DEFAULT_MOTIONS_BASE_URL = 'pet-asset://assets/motions/'
/** 冻结契约 manifest 文件名（相对 motions 根）。 */
export const APP_MANIFEST_FILE = 'app-manifest.json'
/** 运行时扩展 catalog 文件名（相对 motions 根）。 */
export const APP_CATALOG_FILE = 'app-catalog.json'
/** catalog schema 版本。 */
export const APP_CATALOG_VERSION = 1

/**
 * 预载的常用动作槽位（设计 §4.2：idle/walk/sit/sleep/drag/pat 全部条目）。
 * 这些是桌宠常态/交互必然用到的槽位；一次性动作按需加载。
 */
export const COMMON_PRELOAD_SLOTS: readonly AnimationClipMood[] = Object.freeze([
  'idle',
  'walk',
  'sit',
  'sleep',
  'drag',
  'pat'
]) as readonly AnimationClipMood[]

/** 后台预载并发数（本机 protocol 读文件；并发太高会一次性占满内存）。 */
const PRELOAD_CONCURRENCY = 4
/** clip id 合法规则（与 `@shared/animation-contract` 的清洗规则一致）。 */
const CLIP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** clip id 最大长度（与契约一致）。 */
const CLIP_ID_MAX_LENGTH = 64

/** 瞬时 IO 失败退避基准延迟（毫秒）：第 n 次失败后等待 base * 2^(n-1)。 */
export const TRANSIENT_RETRY_BASE_MS = 200
/** 瞬时 IO 失败退避上限（毫秒）。 */
export const TRANSIENT_RETRY_MAX_MS = 5000
/** init 阻塞预载（每槽位最高优先级 clip）的最大尝试次数；确定性失败立即终止、不占次数。 */
export const PRIMARY_PRELOAD_MAX_ATTEMPTS = 3

/** catalog 单条 clip（`docs/wave2-vrm-runtime-design.md` §4.3）。 */
export interface AppCatalogClip {
  /** 稳定 id（app 层唯一；生成器用 `<set>-<clip>` 避免 mate/hsr 同名冲突）。 */
  id: string
  /** 来源动作集（`mate` / `hsr`）。 */
  set: string
  /** clip JSON 路径（**相对 `assets/motions/`**，如 `mate/idle.json`）。 */
  file: string
  /** 是否循环（catalog 播放默认）。 */
  loop: boolean
  /** clip 时长（秒；来自源 manifest 的 duration）。 */
  duration: number
  /** 语义标签（`idle`/`walk`/`sit`/`interaction`/`sleep`/`hiding`/`intro`/`pose`/`react`/`skill`/`show`/`weak`…）。 */
  tags: string[]
  /** 绑定的动作槽位（一次性片段为 null）。 */
  mood: AnimationClipMood | null
}

/** catalog 文件形状（`{ version: 1, clips: [...] }`）。 */
export interface AppCatalog {
  version: number
  clips: AppCatalogClip[]
}

/** 可播放条目：manifest 条目（mood 必填）+ catalog 条目（mood 可为 null）的统一视图。 */
export type PlayableClipEntry = Omit<AnimationClipEntry, 'mood'> & {
  /** 一次性片段为 null（manifest 条目恒为合法槽位）。 */
  mood: AnimationClipMood | null
}

/**
 * clip 的额外元信息（`ParsedClip` 只表达「归一化后的数据口径」，这里补充原始 JSON 事实）。
 *
 * 用途（V5 pose grounding 兜底）：mate 集 clip JSON **没有** `grounding` 字段（数据未标注），
 * 而 hsr 集每条都显式写了 `grounding: 'feet' | 'none'`。播放器据此区分：
 * - 未标注（`groundingDeclared=false`）→ 允许用「姿态最低骨」兜底贴地；
 * - 显式 `'none'` → 数据作者明确标记不贴地（如空中技能），不做兜底。
 */
export interface ClipMeta {
  /** clip JSON 是否**显式**给出合法 `grounding` 字段（'feet'/'none'）。 */
  groundingDeclared: boolean
}

/** 注册表构造参数（由 clip-player / 单测注入）。 */
export interface ClipRegistryOptions {
  /** 私有 JSON 文本拉取（默认 `fetch(url, { cache: 'no-store' })`）。 */
  fetchText?: (url: string) => Promise<string>
  /**
   * 动作集 id（默认 `default`）。当前 app 清单固定在 `assets/motions/` 根
   * （设计 §2.1）；保留该参数供日志/未来多 set 扩展。
   */
  motionSet?: string
  /** 清单基址（默认 `pet-asset://assets/motions/`；单测可注入）。 */
  baseUrl?: string
  /** 当前时间戳（毫秒；默认 `Date.now()`；单测注入假时钟以验证冷却窗口）。 */
  now?: () => number
  /** 等待指定毫秒数（默认 `setTimeout` 包装；单测可注入可推进时钟的假 sleep）。 */
  sleep?: (delayMs: number) => Promise<void>
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 拼接 URL：clip 已经是绝对 URL（pet-asset/http(s)）时原样使用。 */
function joinUrl(baseUrl: string, file: string): string {
  if (/^(?:pet-asset|https?):\/\//i.test(file)) return file
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${base}${file.replace(/^\/+/, '')}`
}

/**
 * 把任意输入清洗为 `AppCatalog`。**永不抛异常**；非法条目丢弃并写 warning。
 * 规则与 `sanitizeAnimationClipManifest` 对齐：id 唯一、file 安全、mood 合法/null、数值有限。
 */
export function sanitizeAppCatalog(input: unknown): {
  value: AppCatalog
  warnings: string[]
} {
  const warnings: string[] = []
  const empty: AppCatalog = { version: APP_CATALOG_VERSION, clips: [] }
  if (!isRecord(input)) {
    warnings.push('app-catalog：期望对象，已回退空 catalog')
    return { value: empty, warnings }
  }
  if (input['version'] !== APP_CATALOG_VERSION) {
    warnings.push(
      `app-catalog.version：期望 ${APP_CATALOG_VERSION}，实际 ${String(
        input['version']
      )}，已回退空 catalog`
    )
    return { value: empty, warnings }
  }
  const rawClips = input['clips']
  if (!Array.isArray(rawClips)) {
    warnings.push('app-catalog.clips：期望数组，已按空处理')
    return { value: empty, warnings }
  }

  const clips: AppCatalogClip[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < rawClips.length; index += 1) {
    const raw = rawClips[index]
    const label = `app-catalog.clips[${index}]`
    if (!isRecord(raw)) {
      warnings.push(`${label}：期望对象，已丢弃`)
      continue
    }
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : ''
    if (id.length === 0 || id.length > CLIP_ID_MAX_LENGTH || !CLIP_ID_PATTERN.test(id)) {
      warnings.push(`${label}.id：缺失/非法，已丢弃`)
      continue
    }
    if (seenIds.has(id)) {
      warnings.push(`${label}.id：重复 id "${id}"，已丢弃`)
      continue
    }
    const set = typeof raw['set'] === 'string' ? raw['set'].trim() : ''
    if (set.length === 0) {
      warnings.push(`${label}.set：缺失/非法，已丢弃`)
      continue
    }
    const file = typeof raw['file'] === 'string' ? raw['file'].trim() : ''
    if (!isSafeAssetReference(file)) {
      warnings.push(`${label}.file：不是安全的 assets 相对路径，已丢弃`)
      continue
    }
    let loop = false
    if (typeof raw['loop'] === 'boolean') loop = raw['loop']
    else warnings.push(`${label}.loop：非布尔值，按 false 处理`)
    let duration = 0
    if (isFiniteNumber(raw['duration']) && raw['duration'] >= 0) duration = raw['duration']
    else warnings.push(`${label}.duration：非法，按 0 处理`)
    const tags: string[] = []
    if (Array.isArray(raw['tags'])) {
      const seenTags = new Set<string>()
      for (const tag of raw['tags']) {
        if (typeof tag !== 'string' || tag.trim().length === 0) continue
        const trimmed = tag.trim()
        if (seenTags.has(trimmed)) continue
        seenTags.add(trimmed)
        tags.push(trimmed)
      }
    } else if (raw['tags'] !== undefined) {
      warnings.push(`${label}.tags：期望字符串数组，已按空处理`)
    }
    let mood: AnimationClipMood | null = null
    if (raw['mood'] !== null && raw['mood'] !== undefined) {
      if (isClipSlotMood(raw['mood'])) mood = raw['mood']
      else warnings.push(`${label}.mood：非法动作槽位 ${String(raw['mood'])}，按 null 处理`)
    }
    seenIds.add(id)
    clips.push({ id, set, file, loop, duration, tags, mood })
  }
  return { value: { version: APP_CATALOG_VERSION, clips }, warnings }
}

/* -------------------------------------------------------------------------- */
/* 注册表                                                                      */
/* -------------------------------------------------------------------------- */

/** 默认 fetchText：`fetch(..., { cache: 'no-store' })` + HTTP 状态检查。 */
async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}（${url}）`)
  }
  return response.text()
}

/**
 * clip 注册表（`clip-player` 持有；单测可注入 `fetchText` 假实现，不依赖 DOM/Electron）。
 */
export class ClipRegistry {
  private readonly fetchText: (url: string) => Promise<string>
  private readonly now: () => number
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly baseUrl: string
  private readonly motionSet: string
  private readonly manifestUrl: string
  private readonly catalogUrl: string

  /** 去重后的 warning（`console.warn` 每条只打一次）。 */
  private readonly warningSet = new Set<string>()
  private readonly warningList: string[] = []
  /** 已解析的 clip 缓存（id → ParsedClip）。 */
  private readonly clipCache = new Map<string, ParsedClip>()
  /** 进行中的 clip 请求（id → Promise，避免同一 clip 并发重复拉取）。 */
  private readonly pendingLoads = new Map<string, Promise<ParsedClip | null>>()
  /** 确定性坏数据的 clip id（未知 id / 坏 JSON / 坏轨道：永久不重试、不再重复 warning）。 */
  private readonly brokenIds = new Set<string>()
  /**
   * 瞬时 IO 失败的 clip id 状态（`fetchText` reject：可恢复，冷却后允许重新尝试；
   * 永不进 `brokenIds`）。`attempts` 累计瞬时失败次数，`cooldownUntil` 为冷却截止戳。
   */
  private readonly transientState = new Map<string, { attempts: number; cooldownUntil: number }>()
  /** clip 元信息（原始 JSON 事实；key = ParsedClip 对象，随缓存一起失效）。 */
  private readonly clipMeta = new WeakMap<ParsedClip, ClipMeta>()

  private manifestValue: AnimationClipManifest = { schemaVersion: 1, clips: [] }
  private catalogValue: AppCatalog = { version: APP_CATALOG_VERSION, clips: [] }
  /** mood → manifest 条目（按 priority 降序；同 priority 保持清单顺序）。 */
  private readonly entriesByMood = new Map<AnimationClipMood, AnimationClipEntry[]>()
  /** id → 可播放条目（manifest 优先，其次 catalog）。 */
  private readonly entryById = new Map<string, PlayableClipEntry>()

  /** app-manifest 是否成功解析（schema 合法；不要求至少一条 clip 可用）。 */
  private manifestLoaded = false
  private initPromise: Promise<void> | null = null
  private fullPreloadPromise: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(options: ClipRegistryOptions = {}) {
    this.fetchText = options.fetchText ?? defaultFetchText
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const base = options.baseUrl ?? DEFAULT_MOTIONS_BASE_URL
    this.baseUrl = base.endsWith('/') ? base : `${base}/`
    this.motionSet = options.motionSet ?? 'default'
    this.manifestUrl = joinUrl(this.baseUrl, APP_MANIFEST_FILE)
    this.catalogUrl = joinUrl(this.baseUrl, APP_CATALOG_FILE)
  }

  /** 动作集 id（日志/调试用；当前清单固定在 motions 根）。 */
  get motionSetId(): string {
    return this.motionSet
  }

  /** 清单是否已成功加载（不要求有可播放 clip；player 组合 `loadedClipCount` 判断 ready）。 */
  get ready(): boolean {
    return this.manifestLoaded
  }

  /** 归一化后的 app-manifest（冻结契约形状）。 */
  get manifest(): AnimationClipManifest {
    return this.manifestValue
  }

  /** 归一化后的 app-catalog。 */
  get catalog(): AppCatalog {
    return this.catalogValue
  }

  /** 已去重 warning 列表（调试/测试断言用）。 */
  get warnings(): readonly string[] {
    return this.warningList
  }

  /** 已加载 clip 数。 */
  get loadedClipCount(): number {
    return this.clipCache.size
  }

  /** 全部 catalog 条目。 */
  get catalogClips(): readonly AppCatalogClip[] {
    return this.catalogValue.clips
  }

  /** 某槽位的 manifest 条目（按 priority 降序；同 priority 保持清单顺序）。 */
  entriesForMood(mood: AnimationClipMood): readonly AnimationClipEntry[] {
    return this.entriesByMood.get(mood) ?? []
  }

  /** catalog 中带某 tag 的条目（事件映射用）。 */
  catalogByTag(tag: string): readonly AppCatalogClip[] {
    return this.catalogValue.clips.filter((clip) => clip.tags.includes(tag))
  }

  /** 任意 id → 可播放条目（manifest 优先，其次 catalog；未知返回 null）。 */
  getPlayableEntry(id: string): PlayableClipEntry | null {
    return this.entryById.get(id) ?? null
  }

  /** 已缓存的 clip（未加载返回 null）。 */
  getLoadedClip(id: string): ParsedClip | null {
    return this.clipCache.get(id) ?? null
  }

  /**
   * clip 的额外元信息（未加载/未知 clip 返回 null）。
   * 见 `ClipMeta`：区分「数据未标注 grounding」与「显式 grounding:'none'」。
   */
  getClipMeta(clip: ParsedClip | null | undefined): ClipMeta | null {
    if (clip === null || clip === undefined) return null
    return this.clipMeta.get(clip) ?? null
  }

  /**
   * 初始化：拉 app-manifest + app-catalog → 预载每个常用槽位的最高优先级 clip
   * （保证 ready 后立刻能播）→ 后台继续预载其余条目（`whenPreloaded()` 可等待）。
   * 失败只降级不抛（`ready` 保持 false / 清单为空）。
   */
  init(): Promise<void> {
    if (this.initPromise !== null) return this.initPromise
    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (this.disposed) return
    await this.loadManifest()
    await this.loadCatalog()
    if (this.disposed) return

    // 先把预载链挂上（测试/调试可 await 全部完成），再等「每槽位最高优先级」就绪。
    const commonIds = this.commonPreloadIds()
    const primaryIds = this.primaryPreloadIds()
    const restIds = commonIds.filter((id) => !primaryIds.includes(id))
    const primaryLoads = primaryIds.map((id) => this.loadPrimaryClip(id))
    this.fullPreloadPromise = Promise.allSettled(primaryLoads)
      .then(() => this.preloadEntries(restIds))
      .then(() => undefined)
      .catch(() => undefined)
    await Promise.allSettled(primaryLoads)
  }

  /** 常用槽位（COMMON_PRELOAD_SLOTS）在 manifest 里的全部条目 id（去重，保持优先级顺序）。 */
  private commonPreloadIds(): string[] {
    const ids: string[] = []
    for (const slot of COMMON_PRELOAD_SLOTS) {
      for (const entry of this.entriesForMood(slot)) {
        if (!ids.includes(entry.id)) ids.push(entry.id)
      }
    }
    return ids
  }

  /** 每槽位最高优先级的 clip id（`init` 阻塞等待这批就绪）。 */
  private primaryPreloadIds(): string[] {
    const ids: string[] = []
    for (const slot of COMMON_PRELOAD_SLOTS) {
      const first = this.entriesForMood(slot)[0]
      if (first !== undefined && !ids.includes(first.id)) ids.push(first.id)
    }
    return ids
  }

  /** 预载全部常用条目完成（init 返回后仍在后台跑；失败也 resolve）。 */
  whenPreloaded(): Promise<void> {
    return this.fullPreloadPromise
  }

  /** 预载常用槽位的全部条目（重复调用命中缓存；返回成功缓存的条目数）。 */
  async preloadCommon(): Promise<number> {
    const ids = this.commonPreloadIds()
    await this.preloadEntries(ids)
    return ids.filter((id) => this.clipCache.has(id)).length
  }

  /** 并发预载一组 id（失败只 warn 一次，不抛）。 */
  private async preloadEntries(ids: readonly string[]): Promise<void> {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        const index = cursor
        cursor += 1
        await this.loadClip(ids[index])
      }
    }
    const workers: Promise<void>[] = []
    const count = Math.min(PRELOAD_CONCURRENCY, Math.max(1, ids.length))
    for (let index = 0; index < count; index += 1) workers.push(worker())
    await Promise.all(workers)
  }

  /**
   * 懒加载某 id 的 clip 数据（缓存/并发去重）。
   *
   * 失败分类：
   * - 确定性坏数据（未知 id / 坏 JSON / 坏轨道）→ 进 `brokenIds`，永久返回 null；
   * - 瞬时 IO 失败（`fetchText` reject）→ 记入瞬时冷却状态；冷却窗口内直接返回 null、
   *   不发新请求，冷却结束后允许重新尝试。
   * @returns 解析后的 clip；失败 → null（warn 一次）
   */
  loadClip(id: string): Promise<ParsedClip | null> {
    if (this.disposed) return Promise.resolve(null)
    const cached = this.clipCache.get(id)
    if (cached !== undefined) return Promise.resolve(cached)
    if (this.brokenIds.has(id)) return Promise.resolve(null)
    const transient = this.transientState.get(id)
    if (transient !== undefined && this.now() < transient.cooldownUntil) {
      return Promise.resolve(null)
    }
    return this.enqueueLoad(id)
  }

  /** 并发去重后入队单次「fetch+parse」尝试（不做冷却闸门；公开 `loadClip` 与 primary 重试复用）。 */
  private enqueueLoad(id: string): Promise<ParsedClip | null> {
    const pending = this.pendingLoads.get(id)
    if (pending !== undefined) return pending
    const promise = this.fetchAndParseClip(id).finally(() => {
      this.pendingLoads.delete(id)
    })
    this.pendingLoads.set(id, promise)
    return promise
  }

  /**
   * init 阻塞预载用：绕过瞬时冷却闸门的有限重试包装。
   *
   * - 复用 `pendingLoads` 并发去重；确定性失败（已进 `brokenIds`）立即终止、不占重试次数；
   * - 每次瞬时失败后按指数退避 sleep，醒来与重试前检查 `disposed`；
   * - 尝试次数耗尽后仍按 `allSettled` 语义放行、不抛异常。
   */
  private async loadPrimaryClip(id: string): Promise<ParsedClip | null> {
    for (let attempt = 1; attempt <= PRIMARY_PRELOAD_MAX_ATTEMPTS; attempt += 1) {
      if (this.disposed) return null
      const cached = this.clipCache.get(id)
      if (cached !== undefined) return cached
      if (this.brokenIds.has(id)) return null
      const result = await this.enqueueLoad(id)
      if (result !== null) return result
      // 确定性坏数据：不重试。
      if (this.brokenIds.has(id)) return null
      // 瞬时失败：退避后再试；最后一次失败不再 sleep。
      if (attempt < PRIMARY_PRELOAD_MAX_ATTEMPTS) {
        await this.sleep(this.backoffDelay(attempt))
        if (this.disposed) return null
      }
    }
    return null
  }

  private async fetchAndParseClip(id: string): Promise<ParsedClip | null> {
    const entry = this.entryById.get(id)
    if (entry === undefined) {
      this.warnOnce(
        `未知 clip id "${id}"（不在 app-manifest/app-catalog 中，确定性坏数据，已永久忽略）`
      )
      this.brokenIds.add(id)
      return null
    }
    const url = joinUrl(this.baseUrl, entry.file)
    let text: string
    try {
      text = await this.fetchText(url)
    } catch (error) {
      this.recordTransientFailure(id, url, error)
      return null
    }
    if (this.disposed) return null
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      this.warnOnce(`clip "${id}" JSON 解析失败：${errorMessage(error)}（确定性坏数据，已永久忽略）`)
      this.brokenIds.add(id)
      return null
    }
    const result = parseClipData(json)
    if (result.value === null) {
      this.warnOnce(
        `clip "${id}" 数据不可用：${result.errors.slice(0, 3).join('；')}${
          result.errors.length > 3 ? ` 等 ${result.errors.length} 项` : ''
        }（确定性坏数据，已永久忽略）`
      )
      this.brokenIds.add(id)
      return null
    }
    for (const warning of result.warnings) {
      this.warnOnce(`clip "${id}": ${warning}`)
    }
    // R-20：await 结束后、回填缓存前再确认一次未 dispose。当前拉取后没有其他 await，
    // 但 dispose 语义要求「销毁后缓存不得重新长回来」（clip-player.dispose → registry.dispose）。
    if (this.disposed) return null
    // 原始 JSON 事实：grounding 字段是否显式给出（'feet'/'none' 才算标注；缺失/非法 = 未标注）。
    const grounding = isRecord(json) ? json['grounding'] : undefined
    this.clipMeta.set(result.value, {
      groundingDeclared: grounding === 'feet' || grounding === 'none'
    })
    // 成功：清除之前的瞬时失败状态，正常回填缓存。
    this.transientState.delete(id)
    this.clipCache.set(id, result.value)
    return result.value
  }

  /** 记录一次瞬时 IO 失败：累计 attempts、按指数退避设定冷却截止戳；不进 `brokenIds`。 */
  private recordTransientFailure(id: string, url: string, error: unknown): void {
    const state = this.transientState.get(id) ?? { attempts: 0, cooldownUntil: 0 }
    state.attempts += 1
    state.cooldownUntil = this.now() + this.backoffDelay(state.attempts)
    this.transientState.set(id, state)
    this.warnOnce(
      `clip "${id}" 拉取失败（${url}）：${errorMessage(error)}，瞬时 IO 失败，冷却后将重试`
    )
  }

  /** 第 n 次瞬时失败后的退避延迟（毫秒，指数退避、封顶）。 */
  private backoffDelay(attempts: number): number {
    return Math.min(TRANSIENT_RETRY_BASE_MS * 2 ** (attempts - 1), TRANSIENT_RETRY_MAX_MS)
  }

  private async loadManifest(): Promise<void> {
    let text: string
    try {
      text = await this.fetchText(this.manifestUrl)
    } catch (error) {
      this.warnOnce(`app-manifest 拉取失败（${this.manifestUrl}）：${errorMessage(error)}，降级为无动作`)
      return
    }
    if (this.disposed) return
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      this.warnOnce(`app-manifest JSON 解析失败：${errorMessage(error)}，降级为无动作`)
      return
    }
    const sanitized = sanitizeAnimationClipManifest(json)
    for (const warning of sanitized.warnings) this.warnOnce(`app-manifest: ${warning}`)
    this.manifestValue = sanitized.value
    // schemaVersion 不合法 = 坏 manifest（sanitize 会回退空清单 → ready 保持 false）。
    this.manifestLoaded = isRecord(json) && json['schemaVersion'] === 1
    if (!this.manifestLoaded) {
      this.warnOnce('app-manifest.schemaVersion 非法，已按空清单降级（player ready=false）')
    }
    this.rebuildIndexes()
  }

  private async loadCatalog(): Promise<void> {
    let text: string
    try {
      text = await this.fetchText(this.catalogUrl)
    } catch (error) {
      this.warnOnce(`app-catalog 拉取失败（${this.catalogUrl}）：${errorMessage(error)}，降级为仅清单动作`)
      return
    }
    if (this.disposed) return
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      this.warnOnce(`app-catalog JSON 解析失败：${errorMessage(error)}，降级为仅清单动作`)
      return
    }
    const sanitized = sanitizeAppCatalog(json)
    for (const warning of sanitized.warnings) this.warnOnce(`app-catalog: ${warning}`)
    this.catalogValue = sanitized.value
    this.rebuildIndexes()
  }

  /** 重建 mood → entries（priority 降序、同 priority 保持清单顺序）与 id → 条目索引。 */
  private rebuildIndexes(): void {
    this.entriesByMood.clear()
    this.entryById.clear()
    // 1) manifest 条目（有 mood：状态机选片入口，也是 manual/事件按 id 播放的来源）
    for (const entry of this.manifestValue.clips) {
      const list = this.entriesByMood.get(entry.mood) ?? []
      list.push(entry)
      this.entriesByMood.set(entry.mood, list)
      this.entryById.set(entry.id, { ...entry })
    }
    for (const list of this.entriesByMood.values()) {
      // 稳定排序：priority 高在前；同 priority 保持 manifest 顺序（findAnimationClip 语义）。
      list.sort((a, b) => b.priority - a.priority)
    }
    // 2) catalog 条目（补全一次性片段；manifest 已存在的 id 不覆盖）
    for (const clip of this.catalogValue.clips) {
      if (this.entryById.has(clip.id)) continue
      this.entryById.set(clip.id, {
        id: clip.id,
        mood: clip.mood,
        file: clip.file,
        loop: clip.loop,
        timeScale: 1,
        fadeInSec: 0.15,
        fadeOutSec: 0.2,
        rootMotion: 'inPlace',
        priority: 0
      })
    }
  }

  /** 记录并打印一次 warning（同一条消息只打一次，避免每帧刷屏）。 */
  private warnOnce(message: string): void {
    const text = `[vrm-clip-registry] ${message}`
    if (this.warningSet.has(message)) return
    this.warningSet.add(message)
    this.warningList.push(message)
    console.warn(text)
  }

  /** 释放缓存（可重复调用；in-flight 结果会被丢弃）。 */
  dispose(): void {
    this.disposed = true
    this.clipCache.clear()
    this.pendingLoads.clear()
    this.brokenIds.clear()
    this.transientState.clear()
    this.entriesByMood.clear()
    this.entryById.clear()
  }
}

/** 统一提取错误信息文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
