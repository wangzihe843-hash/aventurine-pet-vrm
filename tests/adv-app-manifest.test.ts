/**
 * task-9：`scripts/vrm/motion/build-app-manifest.mjs` 对 **adv**（3ds Max Biped 新动作集）的可选接入测试。
 *
 * 覆盖：
 * 1. 常量：`SOURCE_SETS` 含 adv（末尾）、`OPTIONAL_SOURCE_SETS = ['adv']`、adv 无 priority override；
 * 2. 纯函数 `buildAppManifests`：adv 源 manifest 的 slot 映射（slot 非 null → app-manifest，
 *    null → catalog）、`adv-<id>` / `adv/<id>.json` 命名、priority 直取源 manifest；
 * 3. adv 源缺省：与只传 mate/hsr 的产物**逐字节一致**（不影响既有输出），`skippedOptionalSets` 记录；
 * 4. 合成 fixture CLI 集成：临时目录里构造 mate/hsr/adv 三套 manifest + clip 文件（**不碰私有 assets/**），
 *    跑真实 CLI 生成 → `--check` PASS → 篡改产物 → `--check` FAIL；
 * 5. adv 缺省 CLI：跳过提示、产物无 adv 条目、等于纯函数序列化结果；
 * 6. adv clip 文件缺失 → 构建 error（keep 现有「清单/文件漂移」校验）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/vrm/motion/build-app-manifest.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  buildAppManifests,
  OPTIONAL_SOURCE_SETS,
  PRIORITY_OVERRIDES,
  SOURCE_SETS
} from '../scripts/vrm/motion/build-app-manifest.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI_PATH = path.join(REPO_ROOT, 'scripts/vrm/motion/build-app-manifest.mjs')
/** fixture 根目录（gitignored；每个用例一个随机子目录，结束后清理）。 */
const TMP_ROOT = path.join(REPO_ROOT, 'tests', 'tmp', 'adv-app-manifest')

/** @type {string[]} */
const createdDirs = []

function makeTmpDir() {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(path.join(TMP_ROOT, 'run-'))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* 合成源 manifest / clip 文件                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULTS = { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' }

/** 源 clip 文件内容（生成器只校验存在性，内容用最小合法结构示意）。 */
function clipJsonBody(name) {
  return JSON.stringify({
    version: 1,
    clip: name,
    space: 'gltf-rh',
    loop: true,
    fps: 30,
    frames: 60,
    duration: 2,
    sourceHipsHeight: 1,
    bones: {}
  })
}

/** mate 源（含 V7 别名所需的 happy / pose1..3）。 */
function makeMateManifest() {
  return {
    schemaVersion: 1,
    defaults: DEFAULTS,
    clips: [
      { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 0, duration: 2.45 },
      { id: 'walk', slot: 'walk', tags: ['walk'], loop: true, priority: 0, duration: 1.4 },
      { id: 'sit1', slot: 'sit', tags: ['sit'], loop: true, priority: -6, duration: 3.17 },
      { id: 'happy', slot: 'pat', tags: ['pat'], loop: false, priority: 0, duration: 6.55 },
      { id: 'pose1', slot: null, tags: ['pose'], loop: true, priority: 0, duration: 6.8 },
      { id: 'pose2', slot: null, tags: ['pose'], loop: true, priority: 0, duration: 6.8 },
      { id: 'pose3', slot: null, tags: ['pose'], loop: true, priority: 0, duration: 5.0 }
    ]
  }
}

/** hsr 源（含 V7 别名所需的 commonIdle / stun）。 */
function makeHsrManifest() {
  return {
    schemaVersion: 1,
    defaults: DEFAULTS,
    clips: [
      { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 10, duration: 2 },
      { id: 'commonIdle', slot: 'idle', tags: ['idle', 'show'], loop: true, priority: 3, duration: 8.37 },
      { id: 'stun', slot: null, tags: ['react'], loop: true, priority: 0, duration: 1.83 },
      { id: 'skill01', slot: null, tags: ['skill'], loop: false, priority: 0, duration: 2.2 }
    ]
  }
}

/**
 * adv 源（模拟 `build-adv-manifest.mjs` 的产出形状）：3 条 slot 非 null（idle/walk → app-manifest），
 * 8 条 slot=null（一次性/表演/技能 + dsh 别名源 → 仅 catalog）；priority 由源 manifest 直取，不走 override。
 */
function makeAdvManifest() {
  return {
    schemaVersion: 1,
    set: 'adv',
    defaults: DEFAULTS,
    source: { name: 'SYNTHETIC adv fixture（测试用，非真实动作）', targetVrm: 'assets/vrm/aventurine-tpose.vrm' },
    clips: [
      { id: 'idle', slot: 'idle', tags: ['idle'], loop: true, priority: 10, duration: 2.0 },
      { id: 'walk', slot: 'walk', tags: ['walk'], loop: true, priority: 10, duration: 1.5 },
      { id: 'idleShow', slot: 'idle', tags: ['idle', 'show'], loop: true, priority: 8, duration: 10.3 },
      { id: 'skill01', slot: null, tags: ['skill'], loop: false, priority: 0, duration: 2.2 },
      { id: 'die', slot: null, tags: ['react', 'death'], loop: false, priority: 0, duration: 2.5 },
      { id: 'run', slot: null, tags: ['walk', 'run'], loop: true, priority: 0, duration: 1.2 },
      { id: 'talk01', slot: null, tags: ['social'], loop: false, priority: 0, duration: 3.0 },
      { id: 'stunLoop', slot: null, tags: ['react'], loop: true, priority: 0, duration: 1.8 },
      { id: 'revive', slot: null, tags: ['react'], loop: false, priority: 0, duration: 1.5 },
      // 2026-11-10：catalog-only dsh 别名源（dshBusy←think01、dshDone←snap01loop）
      { id: 'think01', slot: null, tags: ['idle', 'social'], loop: true, priority: -7, duration: 2.8 },
      { id: 'snap01loop', slot: null, tags: ['social'], loop: true, priority: 0, duration: 3.43 }
    ]
  }
}

/** 纯函数用 sources（adv 可选）。 */
function makeSources({ adv = false } = {}) {
  /** @type {Record<string, any>} */
  const sources = { mate: makeMateManifest(), hsr: makeHsrManifest() }
  if (adv) sources.adv = makeAdvManifest()
  return sources
}

/** 把一套源 manifest 及其 clip 文件写到 `<root>/<set>/` 下。 */
function writeSource(root, set, manifest) {
  const setDir = path.join(root, set)
  mkdirSync(setDir, { recursive: true })
  writeFileSync(path.join(setDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const clip of manifest.clips) {
    writeFileSync(path.join(setDir, `${clip.id}.json`), clipJsonBody(clip.id))
  }
}

/** 构造 `<root>/<motions>/` 磁盘 fixture（adv 可选）。 */
function writeMotionsDir(root, { adv = false } = {}) {
  writeSource(root, 'mate', makeMateManifest())
  writeSource(root, 'hsr', makeHsrManifest())
  if (adv) writeSource(root, 'adv', makeAdvManifest())
}

/* -------------------------------------------------------------------------- */
/* CLI 调用                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args, { allowFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error
    if (!allowFail) throw error
    const stdout = typeof failed?.stdout === 'string' ? failed.stdout : ''
    const stderr = typeof failed?.stderr === 'string' ? failed.stderr : ''
    return { status: typeof failed?.status === 'number' ? failed.status : 1, stdout, stderr }
  }
}

/** 生成 → 返回输出文件路径与解析结果。 */
function buildToTmp(motionsRoot, outRoot) {
  const manifestPath = path.join(outRoot, 'app-manifest.json')
  const catalogPath = path.join(outRoot, 'app-catalog.json')
  const result = runCli([
    '--motions-dir',
    motionsRoot,
    '--manifest',
    manifestPath,
    '--catalog',
    catalogPath
  ])
  return {
    result,
    manifestPath,
    catalogPath,
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
    catalog: JSON.parse(readFileSync(catalogPath, 'utf8'))
  }
}

/** 从对象数组里取 id 列表（测试断言常用）。 */
function ids(clips) {
  return clips.map((clip) => clip.id)
}

/* -------------------------------------------------------------------------- */
/* 1. 常量 / 注册表                                                            */
/* -------------------------------------------------------------------------- */

describe('build-app-manifest：adv 源集注册（task-9）', () => {
  it('SOURCE_SETS 末尾追加 adv；adv 是可选源；adv 无 priority override（首期不启用）', () => {
    expect(SOURCE_SETS).toEqual(['mate', 'hsr', 'adv'])
    expect(OPTIONAL_SOURCE_SETS).toEqual(['adv'])
    expect(PRIORITY_OVERRIDES.adv).toEqual({})
    // 未命中表项不产生 warning 的机制依赖「空表」：明确断言 adv 没有覆盖项
    expect(Object.keys(PRIORITY_OVERRIDES.adv)).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* 2. 纯函数：adv 源 manifest 映射                                             */
/* -------------------------------------------------------------------------- */

describe('build-app-manifest 纯函数：adv 源 manifest 映射', () => {
  it('slot 非 null 的 adv clip 进 app-manifest（adv-<id> / adv/<id>.json / priority 直取源）', () => {
    const built = buildAppManifests({ sources: makeSources({ adv: true }), aliases: false })
    expect(built.errors).toEqual([])
    expect(built.skippedOptionalSets).toEqual([])

    const advAppClips = built.appManifest.clips.filter((clip) => String(clip.id).startsWith('adv-'))
    expect(ids(advAppClips)).toEqual(['adv-idle', 'adv-walk', 'adv-idleShow'])
    expect(advAppClips[0]).toEqual({
      id: 'adv-idle',
      mood: 'idle',
      file: 'adv/idle.json',
      loop: true,
      timeScale: 1,
      fadeInSec: 0.15,
      fadeOutSec: 0.2,
      rootMotion: 'inPlace',
      priority: 10
    })
    // priority 由源 manifest 直取（adv-idleShow=8），不经过 PRIORITY_OVERRIDES
    expect(advAppClips.find((clip) => clip.id === 'adv-idleShow').priority).toBe(8)
  })

  it('slot=null 的 adv clip 只进 catalog（mood=null、set=adv、file 正确）；全部 adv clip 都在 catalog', () => {
    const built = buildAppManifests({ sources: makeSources({ adv: true }), aliases: false })
    const advCatalog = built.catalog.clips.filter((clip) => clip.set === 'adv')
    expect(ids(advCatalog)).toEqual([
      'adv-idle',
      'adv-walk',
      'adv-idleShow',
      'adv-skill01',
      'adv-die',
      'adv-run',
      'adv-talk01',
      'adv-stunLoop',
      'adv-revive',
      'adv-think01',
      'adv-snap01loop'
    ])
    for (const clip of advCatalog) {
      expect(clip.file).toBe(`adv/${String(clip.id).slice('adv-'.length)}.json`)
    }
    const oneShots = advCatalog.filter((clip) => clip.mood === null)
    expect(ids(oneShots)).toEqual([
      'adv-skill01',
      'adv-die',
      'adv-run',
      'adv-talk01',
      'adv-stunLoop',
      'adv-revive',
      'adv-think01',
      'adv-snap01loop'
    ])
    expect(built.stats.setCounts.adv).toBe(11)
    expect(built.stats.oneShotBySet.adv).toBe(8)
  })

  it('adv 缺省：产物与只传 mate/hsr 时逐字节一致，且 skippedOptionalSets=["adv"]', () => {
    const withOptionalSkip = buildAppManifests({ sources: makeSources({ adv: false }) })
    const explicitMateHsr = buildAppManifests({ sources: makeSources({ adv: false }), sets: ['mate', 'hsr'] })
    expect(withOptionalSkip.skippedOptionalSets).toEqual(['adv'])
    expect(explicitMateHsr.skippedOptionalSets).toEqual([])
    expect(withOptionalSkip.errors).toEqual(explicitMateHsr.errors)
    expect(withOptionalSkip.warnings).toEqual(explicitMateHsr.warnings)
    expect(JSON.stringify(withOptionalSkip.appManifest)).toBe(JSON.stringify(explicitMateHsr.appManifest))
    expect(JSON.stringify(withOptionalSkip.catalog)).toBe(JSON.stringify(explicitMateHsr.catalog))
    // 缺省 adv 不产生任何 adv 条目
    expect(withOptionalSkip.appManifest.clips.some((clip) => String(clip.id).startsWith('adv-'))).toBe(false)
    expect(withOptionalSkip.catalog.clips.some((clip) => clip.set === 'adv')).toBe(false)
  })

  it('adv 出现非法槽位 / clip 文件缺失 → error（与 mate/hsr 同契约，防静默残缺）', () => {
    const badSlotSources = makeSources({ adv: true })
    badSlotSources.adv.clips.push({ id: 'badSlot', slot: 'not-a-mood', tags: [] })
    const badSlot = buildAppManifests({ sources: badSlotSources, aliases: false })
    expect(badSlot.errors.some((error) => error.includes('adv/manifest.json') && error.includes('非法动作槽位'))).toBe(
      true
    )

    const built = buildAppManifests({
      sources: makeSources({ adv: true }),
      aliases: false,
      clipExists: (file) => file !== 'adv/skill01.json'
    })
    expect(built.errors.some((error) => error.includes('adv/skill01.json'))).toBe(true)
  })

  it('adv 别名 2 条加入（与既有 6 条共 8 条）：id/mood 正确、catalog 不变', () => {
    const built = buildAppManifests({ sources: makeSources({ adv: true }) })
    expect(built.errors).toEqual([])
    expect(built.stats.moodAliasCount).toBe(8)
    const aliasIds = ids(built.appManifest.clips).filter(
      (id) => !/^(mate|hsr|adv)-(idle|idleShow|walk|sit1|happy|commonIdle)$/.test(id)
    )
    expect(aliasIds).toEqual([
      'hsr-commonIdle-dshBusy',
      'mate-happy-dshDone',
      'hsr-stun-dshError',
      'adv-think01-dshBusy',
      'adv-snap01loop-dshDone',
      'mate-pose1-idle',
      'mate-pose2-idle',
      'mate-pose3-idle'
    ])
    const advDsh = built.appManifest.clips.filter((clip) => String(clip.id).startsWith('adv-') && clip.mood.startsWith('dsh'))
    expect(advDsh).toEqual([
      {
        id: 'adv-think01-dshBusy',
        mood: 'dshBusy',
        file: 'adv/think01.json',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.3,
        fadeOutSec: 0.3,
        rootMotion: 'inPlace',
        priority: 0
      },
      {
        id: 'adv-snap01loop-dshDone',
        mood: 'dshDone',
        file: 'adv/snap01loop.json',
        loop: true,
        timeScale: 1,
        fadeInSec: 0.15,
        fadeOutSec: 0.3,
        rootMotion: 'inPlace',
        priority: 0
      }
    ])
    // catalog 不因别名变化
    expect(built.catalog.clips.some((clip) => String(clip.id).includes('-dsh'))).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* 3. CLI 集成：合成 mate/hsr/adv 三套 fixture（不碰私有 assets）              */
/* -------------------------------------------------------------------------- */

describe('build-app-manifest CLI：adv 存在路径（合成 fixture + --check）', () => {
  it('生成：adv 进 app-manifest / catalog，--check PASS', () => {
    const root = makeTmpDir()
    const motionsRoot = path.join(root, 'motions')
    writeMotionsDir(motionsRoot, { adv: true })

    const { manifest, catalog, result } = buildToTmp(motionsRoot, path.join(root, 'out'))
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('可选源缺省跳过')

    // app-manifest：adv slot 非 null 的 3 条（追加在 mate/hsr 条目之后、mood 别名之前）
    expect(ids(manifest.clips)).toEqual([
      'mate-idle',
      'mate-walk',
      'mate-sit1',
      'mate-happy',
      'hsr-idle',
      'hsr-commonIdle',
      'adv-idle',
      'adv-walk',
      'adv-idleShow',
      'hsr-commonIdle-dshBusy',
      'mate-happy-dshDone',
      'hsr-stun-dshError',
      'adv-think01-dshBusy',
      'adv-snap01loop-dshDone',
      'mate-pose1-idle',
      'mate-pose2-idle',
      'mate-pose3-idle'
    ])
    const advIdle = manifest.clips.find((clip) => clip.id === 'adv-idle')
    expect(advIdle).toMatchObject({ mood: 'idle', file: 'adv/idle.json', loop: true, priority: 10 })

    // catalog：全部 adv clip（含一次性），set/file/mood 正确
    const advCatalog = catalog.clips.filter((clip) => clip.set === 'adv')
    expect(advCatalog).toHaveLength(11)
    expect(ids(advCatalog.filter((clip) => clip.mood === null))).toEqual([
      'adv-skill01',
      'adv-die',
      'adv-run',
      'adv-talk01',
      'adv-stunLoop',
      'adv-revive',
      'adv-think01',
      'adv-snap01loop'
    ])
    for (const clip of advCatalog) expect(clip.file.startsWith('adv/')).toBe(true)

    // --check：幂等 PASS（不写盘）
    const check = runCli([
      '--motions-dir',
      motionsRoot,
      '--manifest',
      path.join(root, 'out', 'app-manifest.json'),
      '--catalog',
      path.join(root, 'out', 'app-catalog.json'),
      '--check'
    ])
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('--check PASS')
  })

  it('--check 篡改检测：产物被改动 → exit 1', () => {
    const root = makeTmpDir()
    const motionsRoot = path.join(root, 'motions')
    writeMotionsDir(motionsRoot, { adv: true })
    const outRoot = path.join(root, 'out')
    buildToTmp(motionsRoot, outRoot)

    const manifestPath = path.join(outRoot, 'app-manifest.json')
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + ' ')

    const check = runCli(
      ['--motions-dir', motionsRoot, '--manifest', manifestPath, '--catalog', path.join(outRoot, 'app-catalog.json'), '--check'],
      { allowFail: true }
    )
    expect(check.status).toBe(1)
    expect(check.stderr).toContain('--check FAIL')
  })

  it('adv 源 manifest 缺省：跳过提示 + 无 adv 条目 + 产物等于纯函数序列化', () => {
    const root = makeTmpDir()
    const motionsRoot = path.join(root, 'motions')
    writeMotionsDir(motionsRoot, { adv: false })

    const { manifest, catalog, result, manifestPath, catalogPath } = buildToTmp(motionsRoot, path.join(root, 'out'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('可选源缺省跳过：adv')
    expect(manifest.clips.every((clip) => !String(clip.id).startsWith('adv-'))).toBe(true)
    expect(catalog.clips.every((clip) => clip.set !== 'adv')).toBe(true)

    // 与纯函数（默认 sets 含 adv，但 sources 无 adv）序列化逐字节一致
    const pure = buildAppManifests({ sources: makeSources({ adv: false }) })
    expect(readFileSync(manifestPath, 'utf8')).toBe(JSON.stringify(pure.appManifest, null, 2) + '\n')
    expect(readFileSync(catalogPath, 'utf8')).toBe(JSON.stringify(pure.catalog, null, 2) + '\n')

    const check = runCli(
      ['--motions-dir', motionsRoot, '--manifest', manifestPath, '--catalog', catalogPath, '--check']
    )
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('可选源缺省跳过：adv')
  })

  it('adv clip 文件缺失 → exit 1（清单/文件漂移不静默）', () => {
    const root = makeTmpDir()
    const motionsRoot = path.join(root, 'motions')
    writeMotionsDir(motionsRoot, { adv: true })
    rmSync(path.join(motionsRoot, 'adv', 'idle.json'))

    const result = runCli(
      [
        '--motions-dir',
        motionsRoot,
        '--manifest',
        path.join(root, 'out', 'app-manifest.json'),
        '--catalog',
        path.join(root, 'out', 'app-catalog.json')
      ],
      { allowFail: true }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('adv/idle.json')
  })
})
