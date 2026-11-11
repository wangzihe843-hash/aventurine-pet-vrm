/**
 * Wave 1.5-Tpose：初始姿态微调库 / CLI（`scripts/unity-bake/lib/pose-tune.mjs` + `tune-pose.mjs`）回归。
 *
 * 关键约束：
 * - 偏移只作用在配置的帧区间，区间内线性淡出到 0；
 * - axisAngle/四元数乘法与 three.js 一致（可被 `q·v·q⁻¹` 验证）；
 * - CLI 幂等：同一份配置重复跑 = 跳过；换配置必须重跑 convert（防止偏移叠加）。
 *
 * 纪律：只在 os.tmpdir() 建临时目录、不读私有 assets、不写 tracked 文件。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  applyRule,
  axisAngleQuat,
  configHash,
  fadeWeight,
  normalizeAxis,
  offsetQuat,
  quatMul,
  quatSlerp,
  validatePoseTuneConfig
} from '../scripts/unity-bake/lib/pose-tune.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TUNE = join(REPO_ROOT, 'scripts', 'unity-bake', 'tune-pose.mjs')

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-pose-tune-test-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** q·v·q⁻¹ */
function rotateVector(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q
  const ix = w * v[0] + y * v[2] - z * v[1]
  const iy = w * v[1] + z * v[0] - x * v[2]
  const iz = w * v[2] + x * v[1] - y * v[0]
  const iw = -x * v[0] - y * v[1] - z * v[2]
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x
  ]
}

function makeClip(frames = 6, bones = ['LeftUpperArm', 'RightUpperArm']): unknown {
  const identityFrames = Array.from({ length: frames }, () => [0, 0, 0, 1])
  const bonesOut: Record<string, { r: number[][] }> = {}
  for (const bone of bones) bonesOut[bone] = { r: identityFrames.map((q) => [...q]) }
  return {
    version: 1,
    clip: 'introStart',
    mood: '',
    loop: false,
    fps: 30,
    duration: (frames - 1) / 30,
    frames,
    bones: bonesOut
  }
}

describe('pose-tune 数学/区间', () => {
  it('axisAngleQuat 与 three.js 旋转一致（+X 绕 Z 转 -90° → -Y）', () => {
    const q = axisAngleQuat([0, 0, 1], -90)
    const v = rotateVector(q, [1, 0, 0])
    expect(v[0]).toBeCloseTo(0, 6)
    expect(v[1]).toBeCloseTo(-1, 6)
    expect(v[2]).toBeCloseTo(0, 6)
  })

  it('quatMul / quatSlerp / offsetQuat 基本性质', () => {
    const identity = [0, 0, 0, 1]
    expect(quatMul(identity, identity)).toEqual(identity)
    const half = quatSlerp(identity, axisAngleQuat([0, 0, 1], -90), 0.5)
    const v = rotateVector(half, [1, 0, 0])
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(v[1]).toBeCloseTo(-Math.SQRT1_2, 6)

    // 两个轴角按列出顺序组合：先 -5°Z 再 -5°X
    const q = offsetQuat([
      { axis: [0, 0, 1], deg: -5 },
      { axis: [1, 0, 0], deg: -5 }
    ])
    expect(Math.hypot(...q)).toBeCloseTo(1, 9)

    // 轴会被归一化
    expect(normalizeAxis([0, 0, 5])).toEqual([0, 0, 1])
    expect(() => normalizeAxis([0, 0, 0])).toThrow()
  })

  it('fadeWeight：起点 1 → 终点 0，区间外 0', () => {
    expect(fadeWeight(0, 0, 8)).toBe(1)
    expect(fadeWeight(4, 0, 8)).toBeCloseTo(0.5, 9)
    expect(fadeWeight(8, 0, 8)).toBe(0)
    expect(fadeWeight(9, 0, 8)).toBe(0)
    expect(fadeWeight(-1, 0, 8)).toBe(0)
  })

  it('applyRule：只改区间内帧、线性淡出、不越界', () => {
    const clip = makeClip() as any
    const rule = {
      clip: 'introStart',
      frames: [0, 2],
      bones: {
        LeftUpperArm: [{ axis: [0, 0, 1], deg: -10 }],
        RightUpperArm: [{ axis: [0, 0, 1], deg: 10 }]
      }
    }
    const { framesChanged } = applyRule(clip, rule)
    // fadeWeight(0)=1、fadeWeight(1)=0.5、fadeWeight(2)=0（continue）→ 2 帧 × 2 骨 = 4
    expect(framesChanged).toBe(4)
    // 左臂第 0 帧：+X 绕 Z 转 -10° → y 分量为负（手臂向下收）
    const left0 = rotateVector(clip.bones.LeftUpperArm.r[0], [1, 0, 0])
    expect(left0[1]).toBeCloseTo(-Math.sin((10 * Math.PI) / 180), 6)
    // 右臂对称
    const right0 = rotateVector(clip.bones.RightUpperArm.r[0], [-1, 0, 0])
    expect(right0[1]).toBeCloseTo(-Math.sin((10 * Math.PI) / 180), 6)
    // 第 1 帧角度一半
    const left1 = rotateVector(clip.bones.LeftUpperArm.r[1], [1, 0, 0])
    expect(left1[1]).toBeCloseTo(-Math.sin((5 * Math.PI) / 180), 6)
    // 区间外不动
    expect(clip.bones.LeftUpperArm.r[3]).toEqual([0, 0, 0, 1])
    expect(clip.bones.LeftUpperArm.r[5]).toEqual([0, 0, 0, 1])
  })

  it('applyRule：帧区间越界/缺骨时报错', () => {
    const clip = makeClip() as any
    expect(() =>
      applyRule(clip, { clip: 'introStart', frames: [0, 99], bones: { LeftUpperArm: [{ axis: [0, 0, 1], deg: 1 }] } })
    ).toThrow(/超出/)
    expect(() =>
      applyRule(clip, { clip: 'introStart', frames: [0, 1], bones: { Nope: [{ axis: [0, 0, 1], deg: 1 }] } })
    ).toThrow(/缺少骨/)
  })

  it('validatePoseTuneConfig 捕获坏配置', () => {
    expect(validatePoseTuneConfig({ version: 1, rules: [] })).not.toEqual([])
    expect(validatePoseTuneConfig({ version: 1, rules: [{ clip: 'x', frames: [0, 1], bones: { B: [{ axis: [0, 0, 1], deg: 1 }] } }] })).toEqual([])
    const badAxis = validatePoseTuneConfig({
      version: 1,
      rules: [{ clip: 'x', frames: [0, 1], bones: { B: [{ axis: [0, 0, 0], deg: 1 }] } }]
    })
    expect(badAxis.join('\n')).toMatch(/axis/)
  })

  it('configHash 稳定且随内容变化', () => {
    const a = { version: 1, rules: [{ clip: 'x', frames: [0, 1], bones: {} }] }
    expect(configHash(a)).toBe(configHash(JSON.parse(JSON.stringify(a))))
    const b = JSON.parse(JSON.stringify(a))
    b.rules[0].frames = [0, 2]
    expect(configHash(b)).not.toBe(configHash(a))
  })
})

describe('tune-pose CLI', () => {
  function runTune(dir: string, config: unknown): { status: number | null; stdout: string; stderr: string } {
    const configPath = join(dir, 'pose-tune.json')
    writeFileSync(configPath, JSON.stringify(config))
    const result = spawnSync(process.execPath, [TUNE, '--dir', join(dir, 'clips'), '--config', configPath], {
      encoding: 'utf8'
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  function makeConfig(frames: [number, number], deg = -5): unknown {
    return {
      version: 1,
      rules: [
        {
          clip: 'introStart',
          frames,
          bones: { LeftUpperArm: [{ axis: [0, 0, 1], deg }] }
        }
      ]
    }
  }

  function prepareDir(): string {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'clips'), { recursive: true })
    writeFileSync(join(dir, 'clips', 'introStart.json'), JSON.stringify(makeClip()))
    return dir
  }

  it('写入 poseTune 标记；同配置重跑 = 幂等跳过；换配置 = 报错要求重跑 convert', () => {
    const dir = prepareDir()
    const config = makeConfig([0, 2])
    const first = runTune(dir, config)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('applied 1')
    const tuned = JSON.parse(readFileSync(join(dir, 'clips', 'introStart.json'), 'utf8'))
    expect(tuned.poseTune.configHash).toBe(configHash(config))
    // 左臂第 0 帧已旋转（-5° 绕 Z → z 分量 sin(-2.5°)≈-0.0436）
    expect(tuned.bones.LeftUpperArm.r[0][2]).toBeLessThan(-0.04)

    const second = runTune(dir, config)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('skipped 1')
    // 没有被二次叠加（同一 hash 的 marker 保留、旋转不继续增大）
    const tunedAgain = JSON.parse(readFileSync(join(dir, 'clips', 'introStart.json'), 'utf8'))
    expect(tunedAgain.bones.LeftUpperArm.r[0]).toEqual(tuned.bones.LeftUpperArm.r[0])

    const third = runTune(dir, makeConfig([0, 3], -6))
    expect(third.status).not.toBe(0)
    expect(third.stderr).toContain('先重跑 convert-clips')
  })
})
