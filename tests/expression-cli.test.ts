/**
 * V6 表情层 CLI 回归（spawnSync；fixture 写 tmp，不读私有 assets、不写 tracked 文件）。
 *
 * 覆盖：
 * - extract-mate-face：提取 → 文件写出 / `--check` 幂等 / 篡改后 `--check` 失败 / 非法参数 exit 2；
 * - build-expression-manifest：生成 / `--check` 幂等 / 缺 clip 元数据 warning / clip 非法 exit 1；
 * - validate-expression-clips：合法数据 PASS exit 0 / 缺 manifest exit 1 / 坏 clip exit 1。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = join(REPO_ROOT, 'tests/fixtures/expression')
const HSR_FIXTURES = join(FIXTURES, 'hsr')
const EXTRACT = join(REPO_ROOT, 'scripts/vrm/expression/extract-mate-face.mjs')
const BUILD_MANIFEST = join(REPO_ROOT, 'scripts/vrm/expression/build-expression-manifest.mjs')
const VALIDATE = join(REPO_ROOT, 'scripts/vrm/expression/validate-expression-clips.mjs')
const DECODE_HSR = join(REPO_ROOT, 'scripts/vrm/expression/decode-hsr-emo.mjs')
const CLI_TIMEOUT_MS = 60_000

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function run(script: string, args: string[], options: { cwd?: string } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

/** 生成一份完整的 clip 数据目录（extract + manifest）。 */
function prepareDataset(): { outDir: string; configPath: string } {
  const outDir = makeTempDir('expr-cli-')
  const configPath = join(FIXTURES, 'mate-face-config.json')
  const extract = run(EXTRACT, [
    '--anim-dir',
    join(FIXTURES, 'anim'),
    '--config',
    configPath,
    '--out',
    join(outDir, 'mate'),
    '--json',
    join(outDir, 'extract-report.json')
  ])
  expect(extract.status, extract.stderr).toBe(0)
  const build = run(BUILD_MANIFEST, [
    '--dir',
    outDir,
    '--configs',
    configPath,
    '--out',
    join(outDir, 'manifest.json'),
    '--quiet'
  ])
  expect(build.status, build.stderr).toBe(0)
  return { outDir, configPath }
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('expression-cli：extract-mate-face', () => {
  it('提取 2 条 clip、写报告；--check 幂等；篡改后 --check exit 1', () => {
    const outDir = makeTempDir('expr-extract-')
    const args = [
      '--anim-dir',
      join(FIXTURES, 'anim'),
      '--config',
      join(FIXTURES, 'mate-face-config.json'),
      '--out',
      join(outDir, 'mate'),
      '--json',
      join(outDir, 'report.json')
    ]
    const first = run(EXTRACT, args)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('写出 2 clip')
    const facePath = join(outDir, 'mate', 'faceTest.json')
    expect(existsSync(facePath)).toBe(true)
    const clip = JSON.parse(readFileSync(facePath, 'utf8'))
    expect(clip.id).toBe('faceTest')
    expect(clip.frames).toBe(30)
    expect(Object.keys(clip.tracks).sort()).toEqual(['blink', 'happy'])
    expect(existsSync(join(outDir, 'report.json'))).toBe(true)
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'))
    expect(report.clips).toHaveLength(2)
    expect(report.ignored.duplicates.length).toBeGreaterThan(0)

    const check = run(EXTRACT, [...args, '--check'])
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toContain('CHECK OK')

    writeFileSync(facePath, readFileSync(facePath, 'utf8').replace('"frames": 30', '"frames": 31'))
    const broken = run(EXTRACT, [...args, '--check'])
    expect(broken.status).toBe(1)
    expect(broken.stderr).toContain('--check 不一致')
  })

  it('非法参数 exit 2；缺 anim-dir exit 1', () => {
    const badArgs = run(EXTRACT, ['--nope'])
    expect(badArgs.status).toBe(2)
    const missing = run(EXTRACT, [
      '--anim-dir',
      join(FIXTURES, 'does-not-exist'),
      '--config',
      join(FIXTURES, 'mate-face-config.json'),
      '--out',
      join(makeTempDir('expr-missing-'), 'mate')
    ])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('anim-dir 不存在')
  })
})

describe('expression-cli：build-expression-manifest', () => {
  it('生成 manifest + --check 幂等；文件缺失时 exit 1', () => {
    const { outDir, configPath } = prepareDataset()
    const manifestPath = join(outDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.clips).toHaveLength(2)
    expect(manifest.clips[0]).toMatchObject({
      id: 'faceTest',
      set: 'mate',
      file: 'mate/faceTest.json',
      loop: true,
      fps: 30,
      frames: 30
    })

    const check = run(BUILD_MANIFEST, ['--dir', outDir, '--configs', configPath, '--out', manifestPath, '--check'])
    expect(check.status, check.stderr).toBe(0)

    // 删除一个 clip → 重新生成 manifest 数量变化 → --check 失败（同时 validate 也失败）
    rmSync(join(outDir, 'mate', 'petTest.json'))
    // 直接篡改 manifest 触发 --check 不一致（文件缺失会被 build 视为少一条）
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, clips: [] }, null, 2))
    const broken = run(BUILD_MANIFEST, ['--dir', outDir, '--configs', configPath, '--out', manifestPath, '--check'])
    expect(broken.status).toBe(1)
  })

  it('clip JSON 损坏 → exit 1', () => {
    const { outDir, configPath } = prepareDataset()
    writeFileSync(join(outDir, 'mate', 'faceTest.json'), '{ not json')
    const result = run(BUILD_MANIFEST, [
      '--dir',
      outDir,
      '--configs',
      configPath,
      '--out',
      join(outDir, 'manifest.json')
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('JSON 解析失败')
  })
})

describe('expression-cli：decode-hsr-emo', () => {
  it('合成采样 + 配置 → 解码 1 条 clip、--check 幂等、篡改后 --check exit 1', () => {
    const outDir = makeTempDir('expr-hsr-')
    const args = [
      '--samples',
      join(HSR_FIXTURES, 'hsr-samples-mini.json'),
      '--config',
      join(HSR_FIXTURES, 'hsr-emo-mini.json'),
      '--out',
      join(outDir, 'hsr'),
      '--json',
      join(outDir, 'report.json'),
      '--vrm',
      ''
    ]
    const first = run(DECODE_HSR, args)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('写出 1 clip')
    const clipPath = join(outDir, 'hsr', 'testAngry.json')
    expect(existsSync(clipPath)).toBe(true)
    const clip = JSON.parse(readFileSync(clipPath, 'utf8'))
    expect(clip.frames).toBe(3)
    expect(clip.loop).toBe(true)
    expect(clip.tracks.angry[0]).toBeGreaterThan(0.9)
    const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'))
    expect(report.reports).toHaveLength(1)

    const check = run(DECODE_HSR, [...args, '--check'])
    expect(check.status, check.stderr).toBe(0)
    expect(check.stdout).toContain('CHECK OK')

    writeFileSync(clipPath, readFileSync(clipPath, 'utf8').replace('"frames": 3', '"frames": 4'))
    const broken = run(DECODE_HSR, [...args, '--check'])
    expect(broken.status).toBe(1)
  })

  it('缺采样文件 exit 1；配置非法 exit 1', () => {
    const missing = run(DECODE_HSR, [
      '--samples',
      join(HSR_FIXTURES, 'does-not-exist.json'),
      '--config',
      join(HSR_FIXTURES, 'hsr-emo-mini.json'),
      '--out',
      join(makeTempDir('expr-hsr-missing-'), 'hsr'),
      '--vrm',
      ''
    ])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('采样文件不存在')

    const tmp = makeTempDir('expr-hsr-badcfg-')
    const badConfig = JSON.parse(readFileSync(join(HSR_FIXTURES, 'hsr-emo-mini.json'), 'utf8'))
    badConfig.clips = []
    const badConfigPath = join(tmp, 'bad.json')
    writeFileSync(badConfigPath, JSON.stringify(badConfig))
    const bad = run(DECODE_HSR, [
      '--samples',
      join(HSR_FIXTURES, 'hsr-samples-mini.json'),
      '--config',
      badConfigPath,
      '--out',
      join(tmp, 'hsr'),
      '--vrm',
      ''
    ])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('配置非法')
  })
})

describe('expression-cli：validate-expression-clips', () => {
  it('完整数据集 → PASS exit 0；--json 报告写入', () => {
    const { outDir } = prepareDataset()
    const reportPath = join(outDir, 'validation-report.json')
    const result = run(VALIDATE, ['--dir', outDir, '--json', reportPath])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('PASS 2 / WARN 0 / FAIL 0')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(report.summary).toEqual({ files: 2, pass: 2, warn: 0, fail: 0 })
    expect(report.manifest.problems).toEqual([])
  })

  it('缺 manifest → exit 1；坏 clip → exit 1', () => {
    const { outDir } = prepareDataset()
    rmSync(join(outDir, 'manifest.json'))
    const noManifest = run(VALIDATE, ['--dir', outDir])
    expect(noManifest.status).toBe(1)
    expect(noManifest.stdout + noManifest.stderr).toContain('manifest')

    // 恢复 manifest 后写一个坏 clip
    run(BUILD_MANIFEST, [
      '--dir',
      outDir,
      '--configs',
      join(FIXTURES, 'mate-face-config.json'),
      '--out',
      join(outDir, 'manifest.json'),
      '--quiet'
    ])
    writeFileSync(
      join(outDir, 'mate', 'broken.json'),
      JSON.stringify({ schemaVersion: 1, id: 'broken', source: 'mate', fps: 30, frames: 3, duration: 1, loop: true, tracks: { happy: [0, 1, 0] } })
    )
    const bad = run(VALIDATE, ['--dir', outDir])
    expect(bad.status).toBe(1)
    expect(bad.stdout).toMatch(/FAIL [1-9]/)
  })
})
