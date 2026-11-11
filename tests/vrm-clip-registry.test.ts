/**
 * V1 clip-engine：`src/renderer/src/vrm/clip-registry.ts` 单测（注入假 fetchText，不碰 DOM/Electron）。
 *
 * 覆盖：app-manifest 清洗、app-catalog 扩展格式清洗、mood → 条目排序、按 id 懒加载 + 缓存、
 * 失败降级（缺失/坏 JSON 只 warn 一次）、预载（常用槽位全部条目）、dispose 幂等。
 */
import { existsSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { sanitizeAnimationClipManifest } from '@shared/animation-contract'

import {
  APP_CATALOG_VERSION,
  ClipRegistry,
  COMMON_PRELOAD_SLOTS,
  DEFAULT_MOTIONS_BASE_URL,
  PRIMARY_PRELOAD_MAX_ATTEMPTS,
  TRANSIENT_RETRY_MAX_MS,
  sanitizeAppCatalog,
  type ClipRegistryOptions
} from '../src/renderer/src/vrm/clip-registry'
import { makeClipJson } from './fixtures/vrm-motion/clip-fixtures'
// @ts-expect-error -- scripts/vrm/motion/build-app-manifest.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import { buildAppManifests } from '../scripts/vrm/motion/build-app-manifest.mjs'

/* -------------------------------------------------------------------------- */
/* 假 fetchText / 假清单                                                       */
/* -------------------------------------------------------------------------- */

interface FakeFetcher {
  fetchText(url: string): Promise<string>
  counts: Map<string, number>
  urls: string[]
}

/** 由「相对 motions 根的路径 → JSON 文本」构造假 fetchText（按完整 URL 计数）。 */
function makeFakeFetcher(files: Record<string, unknown>): FakeFetcher {
  const counts = new Map<string, number>()
  const urls: string[] = []
  const fetchText = async (url: string): Promise<string> => {
    urls.push(url)
    counts.set(url, (counts.get(url) ?? 0) + 1)
    const relative = url.startsWith(DEFAULT_MOTIONS_BASE_URL)
      ? url.slice(DEFAULT_MOTIONS_BASE_URL.length)
      : url
    if (!(relative in files)) throw new Error(`404 ${url}`)
    const value = files[relative]
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { fetchText, counts, urls }
}

const CLIP_FILE_PATHS = {
  idleHsr: 'hsr/idle.json',
  idleMate: 'mate/idle.json',
  walk: 'mate/walk.json',
  sit: 'mate/sitWindow.json',
  sleep: 'mate/sleep.json',
  drag: 'mate/drag.json',
  happy: 'mate/happy.json',
  skill: 'hsr/skill01.json'
} as const

/** 一份典型生成物：manifest 只有 mood 槽位，catalog 含全部 clip。 */
function makeSourceFiles(): Record<string, unknown> {
  const clipFiles: Record<string, unknown> = {}
  for (const path of Object.values(CLIP_FILE_PATHS)) {
    clipFiles[path] = makeClipJson({ clip: path.split('/')[1].replace('.json', '') })
  }
  const manifest = {
    schemaVersion: 1,
    clips: [
      { id: 'hsr-idle', mood: 'idle', file: CLIP_FILE_PATHS.idleHsr, loop: true, priority: 10 },
      { id: 'mate-idle', mood: 'idle', file: CLIP_FILE_PATHS.idleMate, loop: true, priority: 0 },
      { id: 'mate-walk', mood: 'walk', file: CLIP_FILE_PATHS.walk, loop: true, priority: 0 },
      { id: 'mate-sitWindow', mood: 'sit', file: CLIP_FILE_PATHS.sit, loop: true, priority: 0 },
      { id: 'mate-sleep', mood: 'sleep', file: CLIP_FILE_PATHS.sleep, loop: true, priority: 0 },
      { id: 'mate-drag', mood: 'drag', file: CLIP_FILE_PATHS.drag, loop: false, priority: 0 },
      { id: 'mate-happy', mood: 'pat', file: CLIP_FILE_PATHS.happy, loop: false, priority: 0 }
    ]
  }
  const catalog = {
    version: APP_CATALOG_VERSION,
    clips: [
      ...manifest.clips.map((clip) => ({
        id: clip.id,
        set: clip.id.startsWith('hsr-') ? 'hsr' : 'mate',
        file: clip.file,
        loop: clip.loop,
        duration: 1,
        tags: clip.mood === 'idle' ? ['idle'] : [clip.mood],
        mood: clip.mood
      })),
      {
        id: 'hsr-skill01',
        set: 'hsr',
        file: CLIP_FILE_PATHS.skill,
        loop: false,
        duration: 2.2,
        tags: ['skill'],
        mood: null
      },
      {
        id: 'hsr-hitL',
        set: 'hsr',
        file: CLIP_FILE_PATHS.skill,
        loop: false,
        duration: 1.5,
        tags: ['react'],
        mood: null
      }
    ]
  }
  return { 'app-manifest.json': manifest, 'app-catalog.json': catalog, ...clipFiles }
}

function makeRegistry(
  files: Record<string, unknown>,
  overrides: Partial<ClipRegistryOptions> = {}
): { registry: ClipRegistry; fetcher: FakeFetcher } {
  const fetcher = makeFakeFetcher(files)
  const registry = new ClipRegistry({ fetchText: fetcher.fetchText, ...overrides })
  return { registry, fetcher }
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                        */
/* -------------------------------------------------------------------------- */

describe('clip-registry：manifest / catalog 加载', () => {
  it('init 拉取并清洗两份清单（manifest 保持冻结契约形状）', async () => {
    const { registry, fetcher } = makeRegistry(makeSourceFiles())
    await registry.init()
    expect(registry.ready).toBe(true)
    expect(registry.manifest.schemaVersion).toBe(1)
    expect(registry.manifest.clips).toHaveLength(7)
    expect(registry.catalog.version).toBe(APP_CATALOG_VERSION)
    expect(registry.catalog.clips).toHaveLength(9)
    // 两份清单各拉一次
    expect(fetcher.counts.get(`${DEFAULT_MOTIONS_BASE_URL}app-manifest.json`)).toBe(1)
    expect(fetcher.counts.get(`${DEFAULT_MOTIONS_BASE_URL}app-catalog.json`)).toBe(1)
  })

  it('entriesForMood 按 priority 降序；getPlayableEntry 覆盖 manifest + catalog', async () => {
    const { registry } = makeRegistry(makeSourceFiles())
    await registry.init()
    const idle = registry.entriesForMood('idle')
    expect(idle.map((entry) => entry.id)).toEqual(['hsr-idle', 'mate-idle'])
    expect(registry.entriesForMood('walk').map((entry) => entry.id)).toEqual(['mate-walk'])
    expect(registry.entriesForMood('climb')).toEqual([])
    const skill = registry.getPlayableEntry('hsr-skill01')
    expect(skill).not.toBeNull()
    expect(skill!.mood).toBeNull()
    expect(skill!.file).toBe(CLIP_FILE_PATHS.skill)
    expect(registry.getPlayableEntry('nope')).toBeNull()
    expect(registry.catalogByTag('react').map((clip) => clip.id)).toEqual(['hsr-hitL'])
  })

  it('预载常用槽位：init 后每个槽位最高优先级已就绪，whenPreloaded 后全部条目加载', async () => {
    const { registry, fetcher } = makeRegistry(makeSourceFiles())
    await registry.init()
    // init 只阻塞等待每槽位最高优先级（idle=hsr-idle、walk、sit、sleep、drag、pat）
    expect(registry.loadedClipCount).toBeGreaterThanOrEqual(COMMON_PRELOAD_SLOTS.length)
    expect(registry.getLoadedClip('hsr-idle')).not.toBeNull()
    expect(registry.getLoadedClip('mate-walk')).not.toBeNull()
    await registry.whenPreloaded()
    // 常用槽位全部条目（manifest 7 条）都应在缓存里
    expect(registry.loadedClipCount).toBe(7)
    for (const path of Object.values(CLIP_FILE_PATHS)) {
      const url = `${DEFAULT_MOTIONS_BASE_URL}${path}`
      // skill01 与 hitL 共用同一文件，按需加载不在预载范围
      if (path === CLIP_FILE_PATHS.skill) continue
      expect(fetcher.counts.get(url)).toBe(1)
    }
  })
})

describe('clip-registry：懒加载 / 缓存 / 失败降级', () => {
  it('按需加载 catalog 一次性 clip，重复请求命中缓存（只 fetch 一次）', async () => {
    const { registry, fetcher } = makeRegistry(makeSourceFiles())
    await registry.init()
    const before = registry.loadedClipCount
    const first = await registry.loadClip('hsr-hitL')
    expect(first).not.toBeNull()
    expect(registry.getLoadedClip('hsr-hitL')).not.toBeNull()
    expect(registry.loadedClipCount).toBe(before + 1)
    const second = await registry.loadClip('hsr-hitL')
    expect(second).toBe(first)
    const url = `${DEFAULT_MOTIONS_BASE_URL}${CLIP_FILE_PATHS.skill}`
    // skill01 预载过同一文件（未预载）→ hitL 拉一次
    expect(fetcher.counts.get(url)).toBe(1)
  })

  it('并发请求同一 clip 去重（同一个 Promise）', async () => {
    const { registry, fetcher } = makeRegistry(makeSourceFiles())
    await registry.init()
    const url = `${DEFAULT_MOTIONS_BASE_URL}${CLIP_FILE_PATHS.skill}`
    const [a, b] = await Promise.all([registry.loadClip('hsr-skill01'), registry.loadClip('hsr-skill01')])
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(fetcher.counts.get(url)).toBe(1)
  })

  it('未知 id 返回 null 且只 warn 一次', async () => {
    const { registry } = makeRegistry(makeSourceFiles())
    await registry.init()
    const before = registry.warnings.length
    expect(await registry.loadClip('unknown-id')).toBeNull()
    expect(await registry.loadClip('unknown-id')).toBeNull()
    expect(registry.warnings.length).toBe(before + 1)
    expect(registry.warnings.some((warning) => warning.includes('unknown-id'))).toBe(true)
  })

  it('坏 JSON / 坏 clip 数据只 warn 一次且不重试', async () => {
    const files = makeSourceFiles()
    files['hsr/broken.json'] = '{ not json'
    files['mate/badVersion.json'] = JSON.stringify(makeClipJson({ extra: { version: 2 } }))
    const catalog = files['app-catalog.json'] as { clips: unknown[] }
    catalog.clips.push(
      { id: 'hsr-broken', set: 'hsr', file: 'hsr/broken.json', loop: false, duration: 1, tags: [], mood: null },
      { id: 'mate-badVersion', set: 'mate', file: 'mate/badVersion.json', loop: false, duration: 1, tags: [], mood: null }
    )
    const { registry, fetcher } = makeRegistry(files)
    await registry.init()
    expect(await registry.loadClip('hsr-broken')).toBeNull()
    expect(await registry.loadClip('hsr-broken')).toBeNull()
    expect(fetcher.counts.get(`${DEFAULT_MOTIONS_BASE_URL}hsr/broken.json`)).toBe(1)
    expect(await registry.loadClip('mate-badVersion')).toBeNull()
    const warnings = registry.warnings
    expect(warnings.filter((warning) => warning.includes('hsr-broken')).length).toBe(1)
    expect(warnings.filter((warning) => warning.includes('mate-badVersion')).length).toBe(1)
  })

  it('manifest 缺失/坏 JSON：init 不抛，ready=false，无动作可播（仍然可用 catalog 手动加载?）', async () => {
    const files = makeSourceFiles()
    delete files['app-manifest.json']
    const { registry } = makeRegistry(files)
    await expect(registry.init()).resolves.toBeUndefined()
    expect(registry.ready).toBe(false)
    expect(registry.manifest.clips).toEqual([])
    // catalog 仍加载成功
    expect(registry.catalog.clips.length).toBeGreaterThan(0)
    // 未知 manifest id 的懒加载仍受控返回 null
    expect(await registry.loadClip('hsr-skill01')).not.toBeNull()
  })

  it('manifest schemaVersion 非法 → ready=false（坏 manifest 降级）', async () => {
    const files = makeSourceFiles()
    files['app-manifest.json'] = { schemaVersion: 2, clips: [] }
    const { registry } = makeRegistry(files)
    await registry.init()
    expect(registry.ready).toBe(false)
    expect(registry.manifest.clips).toEqual([])
  })

  it('getClipMeta：区分「显式 grounding」与「数据未标注」（V5 pose grounding 兜底依据）', async () => {
    const files = makeSourceFiles()
    const catalog = files['app-catalog.json'] as { clips: unknown[] }
    catalog.clips.push(
      {
        id: 'mate-explicitNone',
        set: 'mate',
        file: 'mate/explicitNone.json',
        loop: false,
        duration: 1,
        tags: [],
        mood: null
      },
      {
        id: 'mate-undeclared',
        set: 'mate',
        file: 'mate/undeclared.json',
        loop: false,
        duration: 1,
        tags: [],
        mood: null
      }
    )
    files['mate/explicitNone.json'] = makeClipJson({ grounding: 'none' })
    files['mate/undeclared.json'] = makeClipJson({})
    const { registry } = makeRegistry(files)
    await registry.init()
    const explicit = await registry.loadClip('mate-explicitNone')
    const undeclared = await registry.loadClip('mate-undeclared')
    expect(registry.getClipMeta(explicit)?.groundingDeclared).toBe(true)
    expect(registry.getClipMeta(undeclared)?.groundingDeclared).toBe(false)
    expect(registry.getClipMeta(null)).toBeNull()
    // manifest 里的 preload clip：fixtures 未写 grounding → 未标注
    expect(registry.getClipMeta(registry.getLoadedClip('hsr-idle'))?.groundingDeclared).toBe(false)
  })

  it('dispose 后 loadClip 返回 null；init 幂等、可重复调用', async () => {
    const { registry } = makeRegistry(makeSourceFiles())
    const first = registry.init()
    const second = registry.init()
    expect(first).toBe(second)
    await first
    registry.dispose()
    expect(await registry.loadClip('hsr-idle')).toBeNull()
    await expect(registry.init()).resolves.toBeUndefined()
  })

  it('R-20：dispose 期间 in-flight 的 clip 完成后不再回填缓存', async () => {
    const files = makeSourceFiles()
    const fetcher = makeFakeFetcher(files)
    let releaseClip: (text: string) => void = () => {}
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const registry = new ClipRegistry({
      fetchText: (url) => {
        // 只挂起目标 clip 的拉取，manifest/catalog/preload 走正常假 fetch。
        if (url.endsWith(CLIP_FILE_PATHS.skill)) {
          return new Promise<string>((resolve) => {
            releaseClip = resolve
            markStarted()
          })
        }
        return fetcher.fetchText(url)
      }
    })
    await registry.init()
    // 等后台预载全部结束，排除其它 clip 在 dispose 后回填干扰本用例断言。
    await registry.whenPreloaded()

    const pending = registry.loadClip('hsr-skill01')
    await started
    registry.dispose()
    // dispose 之后才让 in-flight 请求完成：结果必须被丢弃，缓存不得重新长回来。
    releaseClip(JSON.stringify(makeClipJson({ clip: 'skill01' })))
    await expect(pending).resolves.toBeNull()
    expect(registry.loadedClipCount).toBe(0)
    expect(registry.getLoadedClip('hsr-skill01')).toBeNull()
  })
})

describe('clip-registry：瞬时失败可恢复 / primary 有限重试 / 确定性坏数据永久 broken（回归）', () => {
  /** 可控时钟：`now` 读 t；`sleep` 把时钟推进对应退避时长（与 ClipRegistryOptions 冻结契约一致）。 */
  function makeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
    let t = 0
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      advance: (ms: number) => {
        t += ms
      }
    }
  }

  /** 前 failTimes 次拉取 transientUrl 抛错（模拟瞬时 IO 故障），其后走正常假 fetch。 */
  function makeTransientFetcher(
    files: Record<string, unknown>,
    transientUrl: string,
    failTimes: number
  ): FakeFetcher {
    const base = makeFakeFetcher(files)
    let failuresLeft = failTimes
    const fetchText = async (url: string): Promise<string> => {
      base.counts.set(url, (base.counts.get(url) ?? 0) + 1)
      base.urls.push(url)
      if (url === transientUrl && failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error('simulated transient IO failure: network blip')
      }
      // 复用 base 的文件查找逻辑；计数已在上方统一记录，避免重复 +1。
      const relative = url.startsWith(DEFAULT_MOTIONS_BASE_URL)
        ? url.slice(DEFAULT_MOTIONS_BASE_URL.length)
        : url
      if (!(relative in files)) throw new Error(`404 ${url}`)
      const value = files[relative]
      return typeof value === 'string' ? value : JSON.stringify(value)
    }
    return { fetchText, counts: base.counts, urls: base.urls }
  }

  it('瞬时拉取失败：冷却期内不重 fetch，越过冷却后可恢复并缓存（不永久熔断）', async () => {
    const files = makeSourceFiles()
    files['mate/transient.json'] = makeClipJson({ clip: 'transient' })
    const catalog = files['app-catalog.json'] as { clips: unknown[] }
    catalog.clips.push({
      id: 'mate-transient',
      set: 'mate',
      file: 'mate/transient.json',
      loop: true,
      duration: 1,
      tags: ['walk'],
      mood: null
    })
    const transientUrl = `${DEFAULT_MOTIONS_BASE_URL}mate/transient.json`
    const clock = makeClock()
    const fetcher = makeTransientFetcher(files, transientUrl, 1)
    const registry = new ClipRegistry({ fetchText: fetcher.fetchText, now: clock.now, sleep: clock.sleep })
    await registry.init()

    // 首次拉取瞬时失败 → null，只 fetch 1 次。
    expect(await registry.loadClip('mate-transient')).toBeNull()
    expect(fetcher.counts.get(transientUrl)).toBe(1)

    // 冷却窗口内立即再试 → 直接短路 null，不产生新 fetch。
    expect(await registry.loadClip('mate-transient')).toBeNull()
    expect(fetcher.counts.get(transientUrl)).toBe(1)

    // 推进时钟远超冷却窗口 → 重试成功并写入缓存。
    clock.advance(TRANSIENT_RETRY_MAX_MS)
    const recovered = await registry.loadClip('mate-transient')
    expect(recovered).not.toBeNull()
    expect(registry.getLoadedClip('mate-transient')).not.toBeNull()
    expect(fetcher.counts.get(transientUrl)).toBe(2)

    // 后续调用稳定命中缓存、不再 fetch（证明没有被永久熔断）。
    const again = await registry.loadClip('mate-transient')
    expect(again).toBe(recovered)
    expect(fetcher.counts.get(transientUrl)).toBe(2)
  })

  it('doInit primary 有限重试：首拉失败后重试成功，attempts ≤ PRIMARY_PRELOAD_MAX_ATTEMPTS', async () => {
    const files = makeSourceFiles()
    const walkUrl = `${DEFAULT_MOTIONS_BASE_URL}${CLIP_FILE_PATHS.walk}`
    const clock = makeClock()
    const fetcher = makeTransientFetcher(files, walkUrl, 1)
    const registry = new ClipRegistry({ fetchText: fetcher.fetchText, now: clock.now, sleep: clock.sleep })
    await registry.init()

    expect(registry.ready).toBe(true)
    expect(registry.getLoadedClip('mate-walk')).not.toBeNull()
    const attempts = fetcher.counts.get(walkUrl) ?? 0
    // 至少重试过一次（首拉失败 → 后续成功），总尝试次数不超过上限（含首次）。
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(attempts).toBeLessThanOrEqual(PRIMARY_PRELOAD_MAX_ATTEMPTS)
  })

  it('确定性坏数据（坏 JSON / parseClipData=null）：时钟远超冷却后仍永久 broken，只 fetch 1 次、warn 1 条', async () => {
    const files = makeSourceFiles()
    files['hsr/broken.json'] = '{ not json'
    files['mate/badVersion.json'] = JSON.stringify(makeClipJson({ extra: { version: 2 } }))
    const catalog = files['app-catalog.json'] as { clips: unknown[] }
    catalog.clips.push(
      { id: 'hsr-broken', set: 'hsr', file: 'hsr/broken.json', loop: false, duration: 1, tags: [], mood: null },
      { id: 'mate-badVersion', set: 'mate', file: 'mate/badVersion.json', loop: false, duration: 1, tags: [], mood: null }
    )
    const clock = makeClock()
    const { registry, fetcher } = makeRegistry(files, { now: clock.now, sleep: clock.sleep })
    await registry.init()

    const cases = [
      { id: 'hsr-broken', url: `${DEFAULT_MOTIONS_BASE_URL}hsr/broken.json` },
      { id: 'mate-badVersion', url: `${DEFAULT_MOTIONS_BASE_URL}mate/badVersion.json` }
    ] as const

    for (const { id, url } of cases) {
      const warningsBefore = registry.warnings.filter((warning) => warning.includes(id)).length
      // 反复加载，每轮把时钟推进到远超瞬时冷却窗口；确定性坏数据必须始终不重试。
      for (let round = 0; round < 3; round += 1) {
        clock.advance(TRANSIENT_RETRY_MAX_MS * 10)
        expect(await registry.loadClip(id)).toBeNull()
      }
      expect(fetcher.counts.get(url)).toBe(1)
      expect(registry.warnings.filter((warning) => warning.includes(id)).length).toBe(warningsBefore + 1)
    }
  })
})

describe('clip-registry：sanitizeAppCatalog 扩展格式清洗', () => {
  it('丢弃非法条目并 warning，保留合法条目', () => {
    const result = sanitizeAppCatalog({
      version: 1,
      clips: [
        { id: 'ok', set: 'mate', file: 'mate/idle.json', loop: true, duration: 3, tags: ['idle', 'idle'], mood: 'idle' },
        { id: 'bad id', set: 'mate', file: 'mate/idle.json', loop: true, duration: 3, tags: [], mood: null },
        { id: 'dup', set: 'mate', file: 'mate/idle.json', loop: true, duration: 3, tags: [], mood: null },
        { id: 'dup', set: 'mate', file: 'mate/idle.json', loop: true, duration: 3, tags: [], mood: null },
        { id: 'badfile', set: 'mate', file: '../escape.json', loop: true, duration: 3, tags: [], mood: null },
        { id: 'badmood', set: 'hsr', file: 'hsr/skill01.json', loop: false, duration: 2, tags: ['skill'], mood: 'nope' }
      ]
    })
    expect(result.value.version).toBe(1)
    expect(result.value.clips.map((clip) => clip.id)).toEqual(['ok', 'dup', 'badmood'])
    expect(result.value.clips[0].tags).toEqual(['idle'])
    expect(result.value.clips[2].mood).toBeNull()
    expect(result.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('version 非法 / 非对象 → 空 catalog + warning', () => {
    expect(sanitizeAppCatalog(null).value.clips).toEqual([])
    expect(sanitizeAppCatalog({ version: 2, clips: [] }).value.clips).toEqual([])
    expect(sanitizeAppCatalog(null).warnings.length).toBeGreaterThan(0)
  })
})


describe('app 清单生成器：build-app-manifest.mjs（映射规则）', () => {
  /** 合成 mate/hsr 源 manifest（形状与 assets/motions/<set>/manifest.json 一致）。 */
  function makeSources() {
    return {
      mate: {
        schemaVersion: 1,
        defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
        clips: [
          { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 0, duration: 2.45 },
          { id: 'walk', slot: 'walk', tags: ['walk'], loop: true, priority: 0, duration: 1.4 },
          { id: 'hideLeft', slot: null, tags: ['hiding'], loop: true, priority: 0, duration: 8 }
        ]
      },
      hsr: {
        schemaVersion: 1,
        defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
        clips: [
          { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 10, duration: 2 },
          { id: 'skill01', slot: null, tags: ['skill'], loop: false, priority: 0, duration: 2.2 }
        ]
      }
    }
  }

  it('有效槽位进 app-manifest；全部 clip 进 catalog；id 加 set 前缀避免同名冲突', () => {
    const built = buildAppManifests({ sources: makeSources(), aliases: false })
    expect(built.errors).toEqual([])
    expect(built.appManifest.schemaVersion).toBe(1)
    expect(built.appManifest.clips.map((clip) => clip.id)).toEqual([
      'mate-idle',
      'mate-walk',
      'hsr-idle'
    ])
    // 同名 idle 不冲突：mate-idle / hsr-idle；priority 原样保留
    const hsrIdle = built.appManifest.clips.find((clip) => clip.id === 'hsr-idle')!
    expect(hsrIdle).toEqual({
      id: 'hsr-idle',
      mood: 'idle',
      file: 'hsr/idle.json',
      loop: true,
      timeScale: 1,
      fadeInSec: 0.15,
      fadeOutSec: 0.2,
      rootMotion: 'inPlace',
      priority: 10
    })
    expect(built.catalog.version).toBe(1)
    expect(built.catalog.clips.map((clip) => clip.id)).toEqual([
      'mate-idle',
      'mate-walk',
      'mate-hideLeft',
      'hsr-idle',
      'hsr-skill01'
    ])
    const oneShots = built.catalog.clips.filter((clip) => clip.mood === null)
    expect(oneShots.map((clip) => clip.id)).toEqual(['mate-hideLeft', 'hsr-skill01'])
    expect(built.stats.appClipCount).toBe(3)
    expect(built.stats.catalogClipCount).toBe(5)
    expect(built.stats.oneShotCount).toBe(2)
    expect(built.stats.moodCounts).toEqual({ idle: 2, walk: 1 })
  })

  it('产物确定（构建两次内容一致，可 --check 逐字节比较）', () => {
    const a = buildAppManifests({ sources: makeSources(), aliases: false })
    const b = buildAppManifests({ sources: makeSources(), aliases: false })
    expect(JSON.stringify(a.appManifest)).toBe(JSON.stringify(b.appManifest))
    expect(JSON.stringify(a.catalog)).toBe(JSON.stringify(b.catalog))
  })

  it('非法槽位 / 重复 id / 非法源 manifest → errors（不写盘）', () => {
    const sources = makeSources()
    sources.mate.clips.push({ id: 'badSlot', slot: 'not-a-mood', tags: [] })
    sources.mate.clips.push({ id: 'idle', slot: 'idle', tags: [] }) // 重复 id
    const built = buildAppManifests({ sources: { mate: sources.mate }, aliases: false })
    expect(built.errors.length).toBeGreaterThanOrEqual(2)
    expect(built.errors.some((error: string) => error.includes('非法动作槽位'))).toBe(true)
    expect(built.errors.some((error: string) => error.includes('重复 id'))).toBe(true)
    const broken = buildAppManifests({ sources: { mate: { schemaVersion: 2 } }, aliases: false })
    expect(broken.errors.length).toBeGreaterThan(0)
  })

  it('clip 文件缺失（clipExists 回调 false）→ error', () => {
    const built = buildAppManifests({
      sources: makeSources(),
      clipExists: (file: string) => file !== 'hsr/skill01.json',
      aliases: false
    })
    expect(built.errors.some((error: string) => error.includes('hsr/skill01.json'))).toBe(true)
  })
})


describe('app 清单生成器：V5 sit 优先级覆盖（地面坐姿优先）', () => {
  function makeSitSources() {
    return {
      mate: {
        schemaVersion: 1,
        defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
        clips: [
          { id: 'sitWindow', slot: 'sit', tags: ['sit'], loop: true, priority: 0, duration: 19.96 },
          { id: 'windowLay8', slot: 'sit', tags: ['sit'], loop: true, priority: -1, duration: 2.4 },
          { id: 'windowLay9', slot: 'sit', tags: ['sit'], loop: true, priority: -2, duration: 2.05 },
          { id: 'windowLay10', slot: 'sit', tags: ['sit'], loop: true, priority: -3, duration: 3.02 },
          { id: 'sit2', slot: 'sit', tags: ['sit'], loop: true, priority: -4, duration: 6.47 },
          { id: 'suwari3', slot: 'sit', tags: ['sit'], loop: true, priority: -5, duration: 2.85 },
          { id: 'sit1', slot: 'sit', tags: ['sit'], loop: true, priority: -6, duration: 3.17 }
        ]
      }
    }
  }

  it('sit 组覆盖为 sit1(10) > sit2(9) > suwari3(8)；sitWindow/windowLay* 降到 -10 以下', () => {
    const built = buildAppManifests({ sources: makeSitSources(), sets: ['mate'], aliases: false })
    expect(built.errors).toEqual([])
    const priorities = Object.fromEntries(
      built.appManifest.clips.map((clip) => [clip.id, clip.priority])
    )
    expect(priorities).toMatchObject({
      'mate-sit1': 10,
      'mate-sit2': 9,
      'mate-suwari3': 8,
      'mate-sitWindow': -10,
      'mate-windowLay8': -11,
      'mate-windowLay9': -12,
      'mate-windowLay10': -13
    })
    // app-manifest 排序仍按源 manifest 顺序（播放器按 priority 排序选片）
    expect(built.appManifest.clips.map((clip) => clip.id)).toContain('mate-sitWindow')
    // catalog 保留全部 7 条 sit 且不含 priority 字段
    const sitCatalog = built.catalog.clips.filter((clip) => clip.mood === 'sit')
    expect(sitCatalog).toHaveLength(7)
    for (const clip of sitCatalog) expect(clip).not.toHaveProperty('priority')
    expect(built.stats.moodCounts).toEqual({ sit: 7 })
  })

  it('优先级覆盖表未命中的源 clip 只 warning（数据漂移提示）', () => {
    const sources = makeSitSources()
    sources.mate.clips = sources.mate.clips.filter((clip) => clip.id !== 'suwari3')
    const built = buildAppManifests({ sources, sets: ['mate'], aliases: false })
    expect(built.warnings.some((warning: string) => warning.includes('mate/suwari3'))).toBe(true)
  })
})


describe('app 清单生成器：V13 男性适配（Mate walk 降级、drag 男女版并列）', () => {
  function makeMaleSources() {
    return {
      mate: {
        schemaVersion: 1,
        defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
        clips: [
          { id: 'walk', slot: 'walk', tags: ['walk'], loop: true, priority: 0, duration: 1.42 },
          { id: 'walkAlt', slot: 'walk', tags: ['walk'], loop: true, priority: -2, duration: 1.42 },
          { id: 'drag', slot: 'drag', tags: ['interaction'], loop: false, priority: 0, duration: 4.5 },
          { id: 'dragFemale', slot: 'drag', tags: ['interaction'], loop: false, priority: 0, duration: 12.78 }
        ]
      }
    }
  }

  it('mate walk/walkAlt 降到 -10/-11（HSR adv-walk 主走），drag 男女版同 priority 0', () => {
    const built = buildAppManifests({ sources: makeMaleSources(), sets: ['mate'], aliases: false })
    expect(built.errors).toEqual([])
    const priorities = Object.fromEntries(
      built.appManifest.clips.map((clip) => [clip.id, clip.priority])
    )
    expect(priorities).toMatchObject({
      'mate-walk': -10,
      'mate-walkAlt': -11,
      'mate-drag': 0,
      'mate-dragFemale': 0
    })
    const drag = built.appManifest.clips
      .filter((clip) => clip.mood === 'drag')
      .sort((a, b) => b.priority - a.priority)
    expect(drag.map((clip) => clip.id)).toEqual(['mate-drag', 'mate-dragFemale'])
    // catalog 保留全部 4 条可手动播放
    expect(built.catalog.clips.map((clip) => clip.id).sort()).toEqual([
      'mate-drag',
      'mate-dragFemale',
      'mate-walk',
      'mate-walkAlt'
    ])
  })
})


describe('app 清单生成器：V7 DSH mood 别名（catalog clip → dshBusy/dshDone/dshError）', () => {
  /** 包含别名源 clip 的合成 mate/hsr manifest。 */
  function makeAliasSources() {
    return {
      mate: {
        schemaVersion: 1,
        defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
        clips: [
          { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 0, duration: 2 },
          { id: 'happy', slot: 'pat', tags: ['interaction'], loop: false, priority: 0, duration: 6.55 },
          { id: 'pose1', slot: null, tags: ['pose'], loop: true, priority: 0, duration: 6.8 },
          { id: 'pose2', slot: null, tags: ['pose'], loop: true, priority: 0, duration: 6.8 },
          { id: 'pose3', slot: null, tags: ['pose'], loop: true, priority: 0, duration: 5 }
        ]
      },
      hsr: {
        schemaVersion: 1,
        defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
        clips: [
          { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 10, duration: 2 },
          { id: 'commonIdle', slot: 'idle', tags: ['idle', 'show'], loop: true, priority: 3, duration: 8.37 },
          { id: 'hitL', slot: null, tags: ['react'], loop: false, priority: 0, duration: 1.57 },
          { id: 'stun', slot: null, tags: ['react'], loop: false, priority: 0, duration: 1.8 }
        ]
      }
    }
  }

  it('默认追加 6 条别名（dsh* 3 + pose* 3）：id/mood/loop/priority/fade 正确、file 相对 motions 根', () => {
    const built = buildAppManifests({ sources: makeAliasSources() })
    expect(built.errors).toEqual([])
    const aliases = built.appManifest.clips.filter(
      (clip) => String(clip.id).includes('-dsh') || String(clip.id).includes('-idle') && String(clip.id).includes('pose')
    )
    expect(aliases).toEqual([
      {
        id: 'hsr-commonIdle-dshBusy',
        mood: 'dshBusy',
        file: 'hsr/commonIdle.json',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.3,
        fadeOutSec: 0.3,
        rootMotion: 'inPlace',
        priority: 0
      },
      {
        id: 'mate-happy-dshDone',
        mood: 'dshDone',
        file: 'mate/happy.json',
        loop: false,
        timeScale: 1,
        fadeInSec: 0.15,
        fadeOutSec: 0.3,
        rootMotion: 'inPlace',
        priority: 0
      },
      {
        id: 'hsr-stun-dshError',
        mood: 'dshError',
        file: 'hsr/stun.json',
        loop: true, // V11：stun 循环播放，hitL 只留 catalog
        timeScale: 1,
        fadeInSec: 0.15,
        fadeOutSec: 0.25,
        rootMotion: 'inPlace',
        priority: 0
      },
      {
        id: 'mate-pose1-idle',
        mood: 'idle',
        file: 'mate/pose1.json',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.8,
        fadeOutSec: 1,
        rootMotion: 'inPlace',
        priority: -10
      },
      {
        id: 'mate-pose2-idle',
        mood: 'idle',
        file: 'mate/pose2.json',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.8,
        fadeOutSec: 1,
        rootMotion: 'inPlace',
        priority: -11
      },
      {
        id: 'mate-pose3-idle',
        mood: 'idle',
        file: 'mate/pose3.json',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.8,
        fadeOutSec: 1,
        rootMotion: 'inPlace',
        priority: -12
      }
    ])
    // 基础 mood 条目（mate-idle/mate-happy/hsr-idle/hsr-commonIdle）+ 6 别名 = 10
    expect(built.stats.appClipCount).toBe(10)
    expect(built.stats.moodAliasCount).toBe(6)
    expect(built.stats.moodCounts).toMatchObject({
      idle: 6, // 3 基础 idle + pose1/2/3
      pat: 1,
      dshBusy: 1,
      dshDone: 1,
      dshError: 1
    })
    // catalog 不变：只含源 manifest 的 9 条（别名不加进 catalog）
    expect(built.catalog.clips.map((clip) => clip.id)).toEqual([
      'mate-idle',
      'mate-happy',
      'mate-pose1',
      'mate-pose2',
      'mate-pose3',
      'hsr-idle',
      'hsr-commonIdle',
      'hsr-hitL',
      'hsr-stun'
    ])
    expect(built.catalog.clips.some((clip) => String(clip.id).includes('-dsh'))).toBe(false)
    expect(built.catalog.clips.some((clip) => String(clip.id).endsWith('-idle') && !['mate-idle', 'hsr-idle'].includes(String(clip.id)))).toBe(false)
  })

  it('别名源 clip 缺失 → error（配置/源 manifest 漂移）', () => {
    const sources = makeAliasSources()
    sources.hsr.clips = sources.hsr.clips.filter((clip) => clip.id !== 'commonIdle')
    const built = buildAppManifests({ sources })
    expect(built.errors.some((error: string) => error.includes('commonIdle'))).toBe(true)
    expect(built.errors.some((error: string) => error.includes('dshBusy'))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* 真实私有生成物集成断言（assets/motions/app-*.json 缺失时跳过）               */
/* -------------------------------------------------------------------------- */

const APP_MANIFEST_PATH = new URL('../assets/motions/app-manifest.json', import.meta.url)
const APP_CATALOG_PATH = new URL('../assets/motions/app-catalog.json', import.meta.url)
const privateAppManifestsExist =
  existsSync(APP_MANIFEST_PATH) && existsSync(APP_CATALOG_PATH)

describe.skipIf(!privateAppManifestsExist)(
  '真实 app 生成物：40 条（含 adv 5 条 + 2 条 adv dsh 别名、drag 男女版 2 条）/ catalog 181 条',
  () => {
    it('app-manifest 40 条且 dshBusy/dshDone 各 2 条、dshError 1 条（冻结契约可清洗）', () => {
      const raw = JSON.parse(readFileSync(APP_MANIFEST_PATH, 'utf8'))
      const sanitized = sanitizeAnimationClipManifest(raw)
      expect(sanitized.warnings).toEqual([])
      expect(sanitized.value.clips).toHaveLength(40)
      const dsh = sanitized.value.clips.filter((clip) => clip.mood.startsWith('dsh'))
      expect(dsh.map((clip) => clip.id)).toEqual([
        'hsr-commonIdle-dshBusy',
        'mate-happy-dshDone',
        'hsr-stun-dshError',
        'adv-think01-dshBusy',
        'adv-snap01loop-dshDone'
      ])
      expect(dsh.map((clip) => clip.loop)).toEqual([true, false, true, true, true])
      expect(dsh.every((clip) => clip.priority === 0)).toBe(true)
      const dshError = dsh[2]
      expect(dshError.file).toBe('hsr/stun.json')
      expect(dshError.fadeInSec).toBeCloseTo(0.15)
      expect(dshError.fadeOutSec).toBeCloseTo(0.25)
      // V11：pose1-3 作为 idle 稀有变体（priority -7/-8/-8，loop=true，fade 0.8/1.0）
      const poses = sanitized.value.clips
        .filter((clip) => clip.id.startsWith('mate-pose'))
        .sort((a, b) => a.id.localeCompare(b.id))
      expect(poses.map((clip) => clip.id)).toEqual([
        'mate-pose1-idle',
        'mate-pose2-idle',
        'mate-pose3-idle'
      ])
      expect(poses.map((clip) => clip.mood)).toEqual(['idle', 'idle', 'idle'])
      expect(poses.map((clip) => clip.priority)).toEqual([-10, -11, -12])
      expect(poses.every((clip) => clip.loop === true)).toBe(true)
      expect(poses.every((clip) => clip.fadeInSec === 0.8 && clip.fadeOutSec === 1)).toBe(true)
      // idle 池排序：13 普通变体（10…-6）在前，3 条 pose 稀有变体在最后
      const idle = sanitized.value.clips
        .filter((clip) => clip.mood === 'idle')
        .sort((a, b) => b.priority - a.priority)
      expect(idle).toHaveLength(19)
      expect(idle.slice(-3).map((clip) => clip.id)).toEqual([
        'mate-idle5',
        'mate-idle6',
        'mate-idle7'
      ])
      // 2026-11-10：adv-idle 的 priority 10 与 hsr-idle 同级（app 播放器同分随机二选一）
      expect(idle.find((clip) => clip.id === 'adv-idle').priority).toBe(10)
      // 2026-11-09 男性适配：app idle 自动池只保留 HSR/adv 男性 idle（男角色），
      // Mate 女性向 idle/pose 全部降到 -10 以下（catalog-only，可按 id 回放/留给女性 profile）
      // 2026-11-10：adv-commonIdle 与 hsr-commonIdle 同一条动画 → 已移出 idle 槽（活跃池少 1 条）
      // 2026-11-10 用户改口：明确要求「不要把 adv 移出 idle 轮换」→ adv 的
      // think01/worry01/scratchHead01 三条稀有变体（-7/-8/-8）重新回到活跃池（共 9 条）。
      expect(
        idle
          .filter((clip) => clip.priority >= -9)
          .map((clip) => clip.id)
          .sort()
      ).toEqual([
        'adv-idle',
        'adv-scratchHead01',
        'adv-think01',
        'adv-worry01',
        'hsr-commonIdle',
        'hsr-idle',
        'hsr-idle2',
        'hsr-idleShow',
        'hsr-idleShow2'
      ])
      // 每个 file 都指向真实存在的私有 clip
      for (const clip of sanitized.value.clips) {
        expect(existsSync(new URL(`../assets/motions/${clip.file}`, import.meta.url))).toBe(true)
      }
      // sit 默认顺序：sit1 > sit2 > suwari3 > 窗沿躺（-10 以下）
      const sit = sanitized.value.clips
        .filter((clip) => clip.mood === 'sit')
        .sort((a, b) => b.priority - a.priority)
      expect(sit.map((clip) => clip.id)).toEqual([
        'mate-sit1',
        'mate-sit2',
        'mate-suwari3',
        'mate-sitWindow',
        'mate-windowLay8',
        'mate-windowLay9',
        'mate-windowLay10'
      ])
      expect(sit[3].priority!).toBeLessThan(-9)
      // V13：drag 男女版同 priority（播放器随机二选一）；mate walk 降级，walk 主选只剩 adv-walk
      const drag = sanitized.value.clips
        .filter((clip) => clip.mood === 'drag')
        .sort((a, b) => b.priority - a.priority)
      expect(drag.map((clip) => clip.id)).toEqual(['mate-drag', 'mate-dragFemale'])
      expect(drag.every((clip) => clip.priority === 0)).toBe(true)
      const walk = sanitized.value.clips.filter((clip) => clip.mood === 'walk')
      expect(walk.map((clip) => clip.id).sort()).toEqual(['adv-walk', 'mate-walk', 'mate-walkAlt'])
      const activeWalk = walk.filter((clip) => clip.priority >= -9)
      expect(activeWalk.map((clip) => clip.id)).toEqual(['adv-walk'])
    })

    it('catalog 181 条不变（全部一次性 clip 仍可按 id 播放）', () => {
      const raw = JSON.parse(readFileSync(APP_CATALOG_PATH, 'utf8'))
      expect(raw.version).toBe(1)
      expect(raw.clips).toHaveLength(181)
      expect(raw.clips.some((clip: { id: string }) => clip.id.includes('-dsh'))).toBe(false)
      // V11：catalog-only 手动播放目标仍在 catalog（registry entryById 覆盖）
      const catalogIds = new Set(raw.clips.map((clip: { id: string }) => clip.id))
      for (const id of ['hsr-skill01', 'hsr-skill02', 'hsr-breaked', 'hsr-revive']) {
        expect(catalogIds.has(id), `${id} 不在 app-catalog`).toBe(true)
      }
      // hitL 只留 catalog（dshError 已改 stun）
      expect(catalogIds.has('hsr-hitL')).toBe(true)
    })
  }
)
