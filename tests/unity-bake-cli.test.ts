/**
 * U2 三个 CLI 的边界/错误路径回归（**不读私有 assets、不写 tracked 文件**）。
 *
 * 全部用 spawnSync 调用 `scripts/unity-bake/{validate-clips,build-motion-manifest,contact-sheets}.mjs`，
 * fixture 一律写到 `mkdtempSync(os.tmpdir())` 并在 afterAll 清理；参照 tests/scripts.test.ts 风格。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'

import {
  fingerExtraBones,
  makeClip,
  makeSelection,
  makeSelectionBundle,
  makeSelectionClip
} from './fixtures/unity-bake/fixtures'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VALIDATE_CLIPS = join(REPO_ROOT, 'scripts/unity-bake/validate-clips.mjs')
const BUILD_MANIFEST = join(REPO_ROOT, 'scripts/unity-bake/build-motion-manifest.mjs')
const CONTACT_SHEETS = join(REPO_ROOT, 'scripts/unity-bake/contact-sheets.mjs')
const CLI_TIMEOUT_MS = 120_000

const tempDirs: string[] = []
function makeTempDir(prefix = 'unity-bake-cli-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface CliResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(script: string, args: string[] = []): CliResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLI_TIMEOUT_MS
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function detail(result: CliResult): string {
  return `status=${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2))
}

/** 把 { name: clipData } 写成 <dir>/<name>.json + <dir>/index.json。 */
function writeClipDir(dir: string, clips: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  const index: Record<string, unknown> = {}
  for (const [name, clip] of Object.entries(clips)) {
    writeJson(join(dir, `${name}.json`), clip)
    index[name] = { file: `${name}.json` }
  }
  writeJson(join(dir, 'index.json'), { version: 1, clips: index })
}

interface ManifestFixture {
  root: string
  clipsDir: string
  config: string
  out: string
  mirror: string
}

/** 生成一个可构建的 manifest fixture（2 clip：idle + hideLeft）。 */
function makeManifestFixture(): ManifestFixture {
  const root = makeTempDir('unity-bake-manifest-')
  const clipsDir = join(root, 'clips')
  const { selection, clips } = makeSelectionBundle()
  writeClipDir(clipsDir, clips)
  const config = join(root, 'clips.json')
  writeJson(config, selection)
  return {
    root,
    clipsDir,
    config,
    out: join(root, 'mate/manifest.json'),
    mirror: join(root, 'manifest.json')
  }
}

function buildArgs(fixture: ManifestFixture, extra: string[] = []): string[] {
  return [
    '--config',
    fixture.config,
    '--clips-dir',
    fixture.clipsDir,
    '--out',
    fixture.out,
    '--mirror',
    fixture.mirror,
    ...extra
  ]
}

describe('validate-clips.mjs', () => {
  it('--help exit 0 且输出用法', () => {
    const result = run(VALIDATE_CLIPS, ['--help'])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('用法')
    expect(result.stdout).toContain('--dir')
  })

  it('未知参数 exit 2 且输出 usage', () => {
    const result = run(VALIDATE_CLIPS, ['--nope'])
    expect(result.status, detail(result)).toBe(2)
    expect(result.stderr).toContain('未知参数')
  })

  it('clip 目录不存在 exit 1', () => {
    const root = makeTempDir('unity-bake-validate-')
    const result = run(VALIDATE_CLIPS, [
      '--dir',
      join(root, 'missing'),
      '--json',
      join(root, 'report.json')
    ])
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('不存在')
  })

  it('合法 fixture：exit 0、PASS 表、报告 summary.ok', () => {
    const root = makeTempDir('unity-bake-validate-')
    const clipsDir = join(root, 'clips')
    const report = join(root, 'report.json')
    const config = join(root, 'clips.json')
    const clips = {
      idle: makeClip({ clip: 'idle', frames: 6, extraBones: fingerExtraBones(6) }),
      hideLeft: makeClip({ clip: 'hideLeft', frames: 6, extraBones: fingerExtraBones(6) })
    }
    writeClipDir(clipsDir, clips)
    writeJson(
      config,
      makeSelection({
        requirements: { idle: 1, hiding: 1 },
        clips: [
          makeSelectionClip({ tags: ['idle'] }),
          makeSelectionClip({ name: 'hideLeft', mood: '', tags: ['hiding'] })
        ]
      })
    )
    const result = run(VALIDATE_CLIPS, ['--dir', clipsDir, '--json', report, '--config', config])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('[PASS] idle')
    expect(result.stdout).toContain('[PASS] hideLeft')
    const parsed = JSON.parse(readFileSync(report, 'utf8'))
    expect(parsed.summary).toMatchObject({ total: 2, pass: 2, warn: 0, fail: 0, ok: true })
    expect(parsed.clips[0].stats.frames).toBe(6)
  })

  it('含非法 clip：exit 1、FAIL 行、报告 errors', () => {
    const root = makeTempDir('unity-bake-validate-')
    const clipsDir = join(root, 'clips')
    const report = join(root, 'report.json')
    const config = join(root, 'clips.json')
    writeClipDir(clipsDir, {
      idle: makeClip({ clip: 'idle', frames: 6, extraBones: fingerExtraBones(6) }),
      broken: makeClip({ clip: 'broken', version: 2, extraBones: fingerExtraBones(5) })
    })
    writeJson(config, makeSelection({ requirements: { idle: 0 }, clips: [] }))
    const result = run(VALIDATE_CLIPS, ['--dir', clipsDir, '--json', report, '--config', config])
    expect(result.status, detail(result)).toBe(1)
    expect(result.stdout).toContain('[FAIL] broken')
    const parsed = JSON.parse(readFileSync(report, 'utf8'))
    expect(parsed.summary.fail).toBe(1)
    expect(parsed.summary.ok).toBe(false)
    expect(parsed.clips.find((clip: any) => clip.name === 'broken').errors.length).toBeGreaterThan(0)
  })

  it('非 clip JSON（无 bones）跳过不报错', () => {
    const root = makeTempDir('unity-bake-validate-')
    const clipsDir = join(root, 'clips')
    const report = join(root, 'report.json')
    const config = join(root, 'clips.json')
    writeClipDir(clipsDir, { idle: makeClip({ clip: 'idle', frames: 6, extraBones: fingerExtraBones(6) }) })
    writeJson(join(clipsDir, 'notes.json'), { hello: 'world' })
    writeJson(config, makeSelection({ requirements: { idle: 0 }, clips: [] }))
    const result = run(VALIDATE_CLIPS, ['--dir', clipsDir, '--json', report, '--config', config])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('[SKIP] notes.json')
  })

  it('selection 交叉检查：配置里多出的 clip → warning（不影响 exit 0）', () => {
    const root = makeTempDir('unity-bake-validate-')
    const clipsDir = join(root, 'clips')
    const report = join(root, 'report.json')
    const config = join(root, 'clips.json')
    writeClipDir(clipsDir, { idle: makeClip({ clip: 'idle', frames: 6, extraBones: fingerExtraBones(6) }) })
    writeJson(
      config,
      makeSelection({
        requirements: { idle: 1 },
        clips: [
          makeSelectionClip({ tags: ['idle'] }),
          makeSelectionClip({ name: 'ghost', tags: ['idle'] })
        ]
      })
    )
    const result = run(VALIDATE_CLIPS, ['--dir', clipsDir, '--json', report, '--config', config])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('"ghost" 在目录中不存在')
  })

  it('显式 --config 指向不存在文件 → exit 1', () => {
    const root = makeTempDir('unity-bake-validate-')
    const clipsDir = join(root, 'clips')
    writeClipDir(clipsDir, { idle: makeClip({ clip: 'idle', frames: 6, extraBones: fingerExtraBones(6) }) })
    const result = run(VALIDATE_CLIPS, [
      '--dir',
      clipsDir,
      '--json',
      join(root, 'report.json'),
      '--config',
      join(root, 'no-such-config.json')
    ])
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('不存在')
  })
})

describe('build-motion-manifest.mjs', () => {
  it('--help exit 0 且输出用法', () => {
    const result = run(BUILD_MANIFEST, ['--help'])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('用法')
    expect(result.stdout).toContain('--check')
  })

  it('未知参数 exit 2', () => {
    const result = run(BUILD_MANIFEST, ['--bogus'])
    expect(result.status, detail(result)).toBe(2)
  })

  it('构建：写 canonical + mirror 两份同内容 manifest，--check 通过', () => {
    const fixture = makeManifestFixture()
    const buildResult = run(BUILD_MANIFEST, buildArgs(fixture))
    expect(buildResult.status, detail(buildResult)).toBe(0)
    expect(buildResult.stdout).toContain('coverage idle')
    expect(buildResult.stdout).toContain('coverage hiding')
    expect(existsSync(fixture.out)).toBe(true)
    expect(existsSync(fixture.mirror)).toBe(true)
    const outManifest = JSON.parse(readFileSync(fixture.out, 'utf8'))
    const mirrorManifest = JSON.parse(readFileSync(fixture.mirror, 'utf8'))
    expect(outManifest).toEqual(mirrorManifest)
    expect(outManifest.clips).toHaveLength(2)
    expect(outManifest.checks.ok).toBe(true)

    const checkResult = run(BUILD_MANIFEST, buildArgs(fixture, ['--check']))
    expect(checkResult.status, detail(checkResult)).toBe(0)
    expect(checkResult.stdout).toContain('--check PASS')
  })

  it('--check：manifest 被篡改 → exit 1', () => {
    const fixture = makeManifestFixture()
    expect(run(BUILD_MANIFEST, buildArgs(fixture)).status).toBe(0)
    const manifest = JSON.parse(readFileSync(fixture.out, 'utf8'))
    manifest.clips[0].priority = 9
    writeJson(fixture.out, manifest)
    const result = run(BUILD_MANIFEST, buildArgs(fixture, ['--check']))
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('不一致')
  })

  it('--check：manifest 缺失 → exit 1', () => {
    const fixture = makeManifestFixture()
    const result = run(BUILD_MANIFEST, buildArgs(fixture, ['--check']))
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('不存在')
  })

  it('selection 有 error 时构建 exit 1 且不写盘', () => {
    const fixture = makeManifestFixture()
    const brokenSelection = {
      fps: 30,
      motionSet: 'mate',
      requirements: { idle: 1 },
      clips: [makeSelectionClip({ mood: 'dancing', tags: ['idle'] })]
    }
    writeJson(fixture.config, brokenSelection)
    const result = run(BUILD_MANIFEST, buildArgs(fixture))
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('mood')
    expect(existsSync(fixture.out)).toBe(false)
    expect(existsSync(fixture.mirror)).toBe(false)
  })

  it('coverage 不足时构建 exit 1', () => {
    const fixture = makeManifestFixture()
    const selection = makeSelection({
      requirements: { idle: 1, sleep: 9999 },
      clips: [makeSelectionClip({ tags: ['idle'] })]
    })
    writeJson(fixture.config, selection)
    const result = run(BUILD_MANIFEST, buildArgs(fixture))
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('覆盖不足')
  })
})

describe('contact-sheets.mjs', () => {
  /** 生成一张纯色 PNG 预览帧。 */
  async function writePng(file: string, color: string): Promise<void> {
    mkdirSync(join(file, '..'), { recursive: true })
    await sharp({ create: { width: 60, height: 80, channels: 3, background: color } })
      .png()
      .toFile(file)
  }

  it('--help exit 0 且输出用法', () => {
    const result = run(CONTACT_SHEETS, ['--help'])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('用法')
  })

  it('未知参数 exit 2；目录不存在 exit 1', () => {
    expect(run(CONTACT_SHEETS, ['--bogus']).status).toBe(2)
    const root = makeTempDir('unity-bake-sheets-')
    const result = run(CONTACT_SHEETS, ['--dir', join(root, 'missing')])
    expect(result.status, detail(result)).toBe(1)
    expect(result.stderr).toContain('不存在')
  })

  it('生成每 clip 4 帧接触表 + 全 clip 首帧总览 JPG', async () => {
    const root = makeTempDir('unity-bake-sheets-')
    const dir = join(root, 'preview')
    const out = join(root, 'sheets')
    for (const [clip, color] of [
      ['idle', '#ff0000'],
      ['walk', '#00ff00']
    ] as const) {
      for (const pct of ['000', '025', '050', '075']) {
        await writePng(join(dir, `${clip}-${pct}.png`), color)
      }
    }
    const result = run(CONTACT_SHEETS, ['--dir', dir, '--out', out])
    expect(result.status, detail(result)).toBe(0)
    expect(result.stdout).toContain('2 clip 接触表')
    const idleSheet = join(out, 'idle-sheet.jpg')
    const overview = join(out, 'contact-firstframes.jpg')
    expect(existsSync(idleSheet)).toBe(true)
    expect(existsSync(overview)).toBe(true)
    const sheetMeta = await sharp(idleSheet).metadata()
    expect(sheetMeta.format).toBe('jpeg')
    // 4 帧 60x80 → 4:3 横向拼接后宽度 = 4 × 270（height=360 等比），高度 360
    expect(sheetMeta.height).toBe(360)
    expect(sheetMeta.width).toBe(4 * 270)
    const overviewMeta = await sharp(overview).metadata()
    expect(overviewMeta.format).toBe('jpeg')
    expect(overviewMeta.height).toBe(200)
  })
})
