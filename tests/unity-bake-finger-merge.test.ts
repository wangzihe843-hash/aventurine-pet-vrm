/**
 * `scripts/unity-bake/merge-finger-tracks.mjs` CLI 回归：
 * GT（Unity worldRot）→ three-vrm normalized 手指 r 的换算公式与输出形状。
 *
 * 用最小 fixture 验证数学：Hips 静止 + 手指骨每帧绕 Y 转 10°：
 *   N = ΔW_parent⁻¹ · ΔW_bone = ΔW_bone（Hips 为 identity）
 *   r = unityToGltf(N) = (x, -y, -z, w)，角度不变 → 第 f 帧夹角 = 10·f°
 * 不读私有 assets、不写 tracked 文件。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MERGE = join(REPO_ROOT, 'scripts/unity-bake/merge-finger-tracks.mjs')
const tempDirs: string[] = []

function makeTempDir(prefix = 'unity-bake-finger-merge-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function run(args: string[]) {
  return spawnSync(process.execPath, [MERGE, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env }
  })
}

/** 绕 Y 轴 deg 度的四元数。 */
function yawQuat(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 180 / 2
  return [0, Math.sin(h), 0, Math.cos(h)]
}
const quatAngleDeg = (q: number[]): number => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI

function flatQuats(quats: number[][]): number[] {
  return quats.flat()
}

describe('merge-finger-tracks.mjs', () => {
  it('Unity worldRot → normalized 手指 r（角度保持、30 指中只合并存在的骨）', () => {
    const root = makeTempDir()
    const gtDir = join(root, 'gt')
    const inDir = join(root, 'in')
    const outDir = join(root, 'out')
    mkdirSync(gtDir, { recursive: true })
    mkdirSync(inDir, { recursive: true })

    const frames = 3
    const rest = {
      version: 1,
      model: 'm',
      bones: [
        { name: 'Hips', worldRot: [0, 0, 0, 1] },
        { name: 'LeftIndexProximal', worldRot: [0, 0, 0, 1] }
      ]
    }
    const gtClip = {
      version: 1,
      clip: 'testclip',
      model: 'm',
      fps: 30,
      duration: 0.1,
      frames,
      bones: [
        { name: 'Hips', worldRot: flatQuats(Array.from({ length: frames }, () => [0, 0, 0, 1])) },
        {
          name: 'LeftIndexProximal',
          worldRot: flatQuats(Array.from({ length: frames }, (_, f) => yawQuat(10 * f)))
        }
      ]
    }
    writeFileSync(join(gtDir, 'm-rest.json'), JSON.stringify(rest))
    writeFileSync(join(gtDir, 'm-testclip.json'), JSON.stringify(gtClip))
    const baked = {
      version: 1,
      clip: 'testclip',
      mood: null,
      loop: true,
      fps: 30,
      duration: 0.1,
      frames,
      space: 'gltf-rh',
      bones: {}
    }
    writeFileSync(join(inDir, 'testclip.json'), JSON.stringify(baked))

    const result = run([
      '--gt', gtDir,
      '--model', 'm',
      '--in', inDir,
      '--out', outDir,
      '--clips', 'testclip',
      '--report', join(root, 'report.json')
    ])
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)

    const out = JSON.parse(readFileSync(join(outDir, 'testclip.json'), 'utf8'))
    expect(out.frames).toBe(frames)
    expect(Object.keys(out.bones)).toEqual(['LeftIndexProximal'])
    const r = out.bones.LeftIndexProximal.r
    expect(r).toHaveLength(frames)
    expect(quatAngleDeg(r[0])).toBeCloseTo(0, 2)
    expect(quatAngleDeg(r[1])).toBeCloseTo(10, 2)
    expect(quatAngleDeg(r[2])).toBeCloseTo(20, 2)

    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'))
    expect(report.clips.testclip.fingerAllMaxBendDeg).toBeCloseTo(20, 1)
  })

  it('frames 不匹配 → 跳过该 clip（不产出文件）', () => {
    const root = makeTempDir()
    const gtDir = join(root, 'gt')
    const inDir = join(root, 'in')
    const outDir = join(root, 'out')
    mkdirSync(gtDir, { recursive: true })
    mkdirSync(inDir, { recursive: true })
    writeFileSync(join(gtDir, 'm-rest.json'), JSON.stringify({ bones: [{ name: 'Hips', worldRot: [0, 0, 0, 1] }] }))
    writeFileSync(
      join(gtDir, 'm-testclip.json'),
      JSON.stringify({ clip: 'testclip', frames: 2, bones: [{ name: 'Hips', worldRot: [0, 0, 0, 1, 0, 0, 0, 1] }] })
    )
    writeFileSync(join(inDir, 'testclip.json'), JSON.stringify({ frames: 3, bones: {} }))
    const result = run(['--gt', gtDir, '--model', 'm', '--in', inDir, '--out', outDir, '--clips', 'testclip'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('frames mismatch')
  })
})
