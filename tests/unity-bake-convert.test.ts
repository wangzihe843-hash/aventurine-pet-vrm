/**
 * Wave 1.5：`scripts/unity-bake/convert-clips.mjs` 的归一化前提护栏回归。
 *
 * 背景（调研结论）：采样用 avatar 的 rest 局部旋转必须是 identity（合成 T-pose 骨架），
 * 此时 `qNorm = inverse(rest) * localRotation` 才等于 VRM normalized 旋转；否则写进
 * normalized 骨骼会「能播但姿势静默偏差」。convert-clips 现在会检测并中止（可用
 * `--allow-non-identity-rest` 显式放行）。
 *
 * 纪律：只在 os.tmpdir() 建临时目录、不读私有 assets、不写 tracked 文件。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONVERT = join(REPO_ROOT, 'scripts', 'unity-bake', 'convert-clips.mjs')

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-convert-test-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 构造一份 ClipExporter 形状的最小原始导出（2 骨 × 2 帧，rest 可指定）。 */
function makeRawClip(options: { rest: number[][] }): unknown {
  const frames = 2
  const identity = [0, 0, 0, 1]
  return {
    version: 1,
    clip: 'unit-test-clip',
    mood: 'idle',
    loop: true,
    fps: 30,
    duration: frames / 30,
    avatar: 'unit-test-avatar',
    sourceHeight: 1.7,
    space: 'unity-lh',
    frames,
    bones: [
      {
        name: 'Hips',
        rest: options.rest[0],
        rot: [...identity, ...identity],
        pos: [0, 0, 0, 0, 0.01, 0]
      },
      {
        name: 'Spine',
        rest: options.rest[1],
        rot: [...identity, ...identity]
      }
    ]
  }
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runConvert(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [CONVERT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

describe('convert-clips 归一化前提护栏', () => {
  it('合成 T-pose（rest=identity）正常转换，并写出 sourceHipsHeight', () => {
    const dir = makeTempDir()
    const inDir = join(dir, 'out')
    const outDir = join(dir, 'converted')
    mkdirSync(inDir, { recursive: true })
    writeFileSync(
      join(inDir, 'unit-test-clip.json'),
      JSON.stringify(makeRawClip({ rest: [[0, 0, 0, 1], [0, 0, 0, 1]] }))
    )

    const result = runConvert(['--in', inDir, '--out', outDir, '--axis', 'z'])
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('done: 1 clip(s)')

    const converted = JSON.parse(readFileSync(join(outDir, 'unit-test-clip.json'), 'utf8'))
    expect(converted.space).toBe('gltf-rh')
    // Hips 位移缩放基准必须显式写出（播放侧按 hips 高比缩放，不再用 bbox 身高）。
    expect(converted.sourceHipsHeight).toBe(1)
    expect(converted.frames).toBe(2)
    expect(Object.keys(converted.bones).sort()).toEqual(['Hips', 'Spine'])
  })

  it('rest 非 identity 时中止（防止 qNorm 被误当 normalized 旋转）', () => {
    const dir = makeTempDir()
    const inDir = join(dir, 'out')
    const outDir = join(dir, 'converted')
    mkdirSync(inDir, { recursive: true })
    // 45° 绕 Y 的 rest —— 真实 avatar 采样时可能出现，但不是 normalized 前提。
    const y45 = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]
    writeFileSync(
      join(inDir, 'bad-rest.json'),
      JSON.stringify(makeRawClip({ rest: [y45, [0, 0, 0, 1]] }))
    )

    const result = runConvert(['--in', inDir, '--out', outDir])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('rest 局部旋转不是 identity')
    expect(result.stderr).toContain('--allow-non-identity-rest')
  })

  it('显式 --allow-non-identity-rest 时放行（带 warning）', () => {
    const dir = makeTempDir()
    const inDir = join(dir, 'out')
    const outDir = join(dir, 'converted')
    mkdirSync(inDir, { recursive: true })
    const y45 = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]
    writeFileSync(
      join(inDir, 'bad-rest.json'),
      JSON.stringify(makeRawClip({ rest: [y45, [0, 0, 0, 1]] }))
    )

    const result = runConvert(['--in', inDir, '--out', outDir, '--allow-non-identity-rest'])
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0)
    expect(result.stderr).toContain('已放行')
  })
})
