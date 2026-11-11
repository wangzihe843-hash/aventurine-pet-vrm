/**
 * Wave 2.5：VPD（静态姿势）→ VMD（单帧静态动作）转换器回归测试。
 *
 * 覆盖：
 * - cp932（Shift-JIS）VPD：自动编码检测 + 日文骨名写回 VMD 后能被 mmd-parser 正确读回；
 * - UTF-8 VPD（手写/工具导出变体）；
 * - 科学计数法数字、零四元数归一化、重复骨骼保留最后一个；
 * - `--frame` / `--out` / `--help` / 非法输入退出码。
 *
 * 说明：VMD 是二进制（骨名 Shift-JIS），测试用转换器自身导出的 `encodeTextToShiftJis`
 * 生成 cp932 fixture，再用 mmd-parser（与 three r171 MMDLoader 同源）读回校验。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Parser } from 'mmd-parser'
import { afterAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONVERTER = join(REPO_ROOT, 'scripts', 'anim-pipeline', 'reze', 'vpd2vmd.mjs')
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'vpd2vmd-'))

// 动态 import 转换器拿到 encodeTextToShiftJis（ESM，路径含中文 → 用 pathToFileURL）。
const converterModule = await import(pathToFileURL(CONVERTER).href)

function vpdFixture(): string {
  return `Vocaloid Pose Data file

TestModel.osm;		// 親ファイル名
3;				// 総ポーズボーン数

Bone0{センター,1.5,2.25,-3.0,0.0,0.0,0.0,1.0}
Bone1{上半身,0.0,0.0,0.0,8.7e-05,0.13052619,0.0,0.99144486}
Bone2{頭,0.0,0.125,0.0,-0.08715574,0.0,0.0,0.9961947}
`
}

function runConverter(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CONVERTER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function parseVmd(filePath: string) {
  const buffer = readFileSync(filePath)
  const parser = new Parser()
  return parser.parseVmd(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

describe('vpd2vmd：cp932/UTF-8 → 单帧 VMD', () => {
  it('cp932 VPD → VMD：日文骨名/位移/四元数/科学计数法往返正确', () => {
    const input = join(TEMP_ROOT, 'cp932.vpd')
    const output = join(TEMP_ROOT, 'cp932.vmd')
    writeFileSync(input, Buffer.from(converterModule.encodeTextToShiftJis(vpdFixture())))

    const result = runConverter([input, '--out', output])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[vpd2vmd] OK')
    expect(result.stdout).toContain('encoding=shift_jis')

    const vmd = parseVmd(output)
    expect(vmd.motions).toHaveLength(3)
    const byName = new Map(vmd.motions.map((motion: { boneName: string }) => [motion.boneName, motion]))
    expect([...byName.keys()].sort()).toEqual(['センター', '上半身', '頭'].sort())

    const center = byName.get('センター') as { position: number[]; rotation: number[]; frameNum: number }
    expect(center.frameNum).toBe(0)
    expect(center.position[0]).toBeCloseTo(1.5, 5)
    expect(center.position[1]).toBeCloseTo(2.25, 5)
    expect(center.position[2]).toBeCloseTo(-3.0, 5)
    expect(center.rotation[3]).toBeCloseTo(1, 6)

    const upper = byName.get('上半身') as { rotation: number[] }
    // 源码是科学计数法 8.7e-05 → 读回应一致（四元数已归一化，误差 < 1e-4）
    expect(upper.rotation[0]).toBeCloseTo(8.7e-5, 5)
    expect(upper.rotation[1]).toBeCloseTo(0.13052619, 5)
    expect(upper.rotation[3]).toBeCloseTo(0.99144486, 5)
  })

  it('UTF-8 VPD（手写）自动识别并转换', () => {
    const input = join(TEMP_ROOT, 'utf8.vpd')
    const output = join(TEMP_ROOT, 'utf8.vmd')
    writeFileSync(input, Buffer.from(vpdFixture(), 'utf8'))
    const result = runConverter([input, '--out', output])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('encoding=utf-8')
    const vmd = parseVmd(output)
    expect(vmd.motions.map((motion: { boneName: string }) => motion.boneName).sort()).toEqual(
      ['センター', '上半身', '頭'].sort()
    )
  })

  it('Blender MMD Tools 多行 VPD 变体（; 与 // 注释）也能解析', () => {
    const text = `Vocaloid Pose Data file

TestModel.osm;		// 親ファイル名
2;				// 総ポーズボーン数

Bone0{センター
  0.0,0.75,0.0;				// trans x,y,z
  0.0,0.0,0.0,1.0;			// Quaternion x,y,z,w
}

Bone1{頭
  0.0,0.0,0.0;				// trans x,y,z
  -0.043380431830883026,-0.1044289842247963,-0.004559466615319252,0.9935753345489502;	// Quaternion
}
`
    const input = join(TEMP_ROOT, 'blender-format.vpd')
    const output = join(TEMP_ROOT, 'blender-format.vmd')
    writeFileSync(input, Buffer.from(text, 'utf8'))
    const result = runConverter([input, '--out', output])
    expect(result.status).toBe(0)
    const vmd = parseVmd(output)
    const byName = new Map(vmd.motions.map((motion: { boneName: string }) => [motion.boneName, motion]))
    const center = byName.get('センター') as { position: number[] }
    expect(center.position[1]).toBeCloseTo(0.75, 6)
    const head = byName.get('頭') as { rotation: number[] }
    expect(head.rotation[1]).toBeCloseTo(-0.10442898, 5)
  })

  it('--frame 写入指定帧号；默认输出路径与输入同名 .vmd', () => {
    const input = join(TEMP_ROOT, 'frame.vpd')
    writeFileSync(input, Buffer.from(vpdFixture(), 'utf8'))
    const result = runConverter([input, '--frame', '7'])
    expect(result.status).toBe(0)
    const vmd = parseVmd(join(TEMP_ROOT, 'frame.vmd'))
    expect(vmd.motions.every((motion: { frameNum: number }) => motion.frameNum === 7)).toBe(true)
  })

  it('零四元数（0,0,0,0）归一化为单位四元数', () => {
    const text = `Vocaloid Pose Data file

Zero.osm;
1;

Bone0{センター,0,0,0,0,0,0,0}
`
    const input = join(TEMP_ROOT, 'zero.vpd')
    const output = join(TEMP_ROOT, 'zero.vmd')
    writeFileSync(input, Buffer.from(text, 'utf8'))
    expect(runConverter([input, '--out', output]).status).toBe(0)
    const vmd = parseVmd(output)
    expect(vmd.motions[0].rotation).toEqual([0, 0, 0, 1])
  })
})

describe('vpd2vmd：CLI 边界', () => {
  it('非法输入文件 → 退出码 2 + 清晰报错（不写半成品）', () => {
    const input = join(TEMP_ROOT, 'not-vpd.vpd')
    writeFileSync(input, 'hello world\n')
    const result = runConverter([input])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('VPD')
  })

  it('文件不存在 → 退出码 2', () => {
    const result = runConverter([join(TEMP_ROOT, 'missing.vpd')])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不存在')
  })

  it('--help → 退出码 0 并打印用法', () => {
    const result = runConverter(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('vpd2vmd')
  })

  it('骨骼块缺失/字段不足 → 退出码 2', () => {
    const input = join(TEMP_ROOT, 'bad-bones.vpd')
    writeFileSync(input, 'Vocaloid Pose Data file\n\nX.osm;\n1;\n\nBone0{センター,0,0}\n')
    const result = runConverter([input])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('字段不足')
  })
})
