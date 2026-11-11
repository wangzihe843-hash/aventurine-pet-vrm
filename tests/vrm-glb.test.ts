/**
 * W0-5 小修单测：VRM/GLB 数据修复（`src/shared/vrm-glb.ts`）。
 *
 * 覆盖：
 * - MToon 非法贴图引用（无 index / 越界 / 非对象）被移除、合法引用/可选 null 保留；
 * - GLB 容器重新封装的正确性（magic/version/total length/JSON 4 字节对齐/BIN 原样）；
 * - 异常输入（非 GLB / 截断 / 坏 JSON）抛错；非对象 JSON 不抛；
 * - 真实私有资产（存在时）：原始戏浪 VRM 修复出 `珍珠.shadeMultiplyTexture`，
 *   修复后 GLB 可再解析、BIN chunk 字节不变；已修复资产二次修复 0 处。
 * - 二次修复幂等。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { GLB_VERSION, patchVrmGlbBuffer, patchVrmGltfJson } from '@shared/vrm-glb'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const AVENTURINE_ORIGINAL = `${REPO_ROOT}/assets/vrm/星穹铁道—砂金·戏浪(1.0).vrm`
const AVENTURINE_PATCHED = `${REPO_ROOT}/assets/vrm/aventurine-waveflair.vrm`
const hasOriginalAsset = existsSync(AVENTURINE_ORIGINAL)
const hasPatchedAsset = existsSync(AVENTURINE_PATCHED)

/* -------------------------------------------------------------------------- */
/* 测试辅助：构造/解析最小 GLB                                                 */
/* -------------------------------------------------------------------------- */

const MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

function pad4(length: number): number {
  return Math.ceil(length / 4) * 4
}

/** 构造最小合法 GLB（JSON chunk + 可选 BIN chunk）；与 glTF 规范一致做 4 字节对齐。 */
function buildGlb(json: unknown, bin: Uint8Array = new Uint8Array(0)): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const paddedJson = pad4(jsonBytes.length)
  const paddedBin = pad4(bin.length)
  const hasBin = bin.length > 0
  const total = 12 + 8 + paddedJson + (hasBin ? 8 + paddedBin : 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, paddedJson, true)
  view.setUint32(16, CHUNK_JSON, true)
  out.set(jsonBytes, 20)
  out.fill(0x20, 20 + jsonBytes.length, 20 + paddedJson)
  if (hasBin) {
    const offset = 20 + paddedJson
    view.setUint32(offset, paddedBin, true)
    view.setUint32(offset + 4, CHUNK_BIN, true)
    out.set(bin, offset + 8)
  }
  return out
}

/** 从 GLB 中读出 JSON chunk 与第二个 chunk（BIN）字节（按 chunk header 声明的长度）。 */
function readGlbChunks(bytes: Uint8Array): { json: unknown; bin: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)))
  const binOffset = 20 + jsonLength
  if (binOffset + 8 > bytes.length) return { json, bin: null }
  const binLength = view.getUint32(binOffset, true)
  const bin = bytes.subarray(binOffset + 8, binOffset + 8 + binLength)
  return { json, bin }
}

/** MToon 材质测试夹具（2 textures；含各种非法引用）。 */
function makeGltfFixture(): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    textures: [{}, {}],
    materials: [
      {
        name: '珍珠',
        extensions: {
          VRMC_materials_mtoon: {
            shadeMultiplyTexture: {}, // 非法：无 index（W0-4 实测的真实缺陷形态）
            shadingShiftTexture: { index: 1 }, // 合法
            matcapTexture: { index: 99 }, // 非法：越界
            rimMultiplyTexture: null // 可选字段：保留
          }
        }
      },
      {
        name: '颜',
        extensions: { VRMC_materials_mtoon: { shadeMultiplyTexture: { index: 0 } } }
      },
      { name: '无扩展材质', pbrMetallicRoughness: {} }
    ]
  }
}

/* -------------------------------------------------------------------------- */
/* JSON 清洗                                                                   */
/* -------------------------------------------------------------------------- */

describe('patchVrmGltfJson：MToon 非法贴图引用', () => {
  it('移除无 index / 越界引用，保留合法引用与可选 null', () => {
    const fixture = makeGltfFixture()
    const result = patchVrmGltfJson(fixture)
    expect(result.patches.map((patch) => `${patch.material}.${patch.key}`)).toEqual([
      '珍珠.shadeMultiplyTexture',
      '珍珠.matcapTexture'
    ])
    const mtoon = (
      (fixture.materials as Array<Record<string, unknown>>)[0].extensions as Record<
        string,
        Record<string, unknown>
      >
    ).VRMC_materials_mtoon
    expect(mtoon).toEqual({
      shadingShiftTexture: { index: 1 },
      rimMultiplyTexture: null
    })
    // 合法材质不动
    expect(result.patches.every((patch) => patch.material !== '颜')).toBe(true)
  })

  it('幂等：二次清洗不再产生 patch', () => {
    const fixture = makeGltfFixture()
    patchVrmGltfJson(fixture)
    expect(patchVrmGltfJson(fixture).patches).toEqual([])
  })

  it('非对象 / 空对象 / 没有 MToon 扩展：不抛异常、0 patch', () => {
    for (const input of [null, undefined, 42, 'x', [], {}, { materials: [] }]) {
      const result = patchVrmGltfJson(input)
      expect(result.patches).toEqual([])
    }
    expect(patchVrmGltfJson({ materials: [{ name: 'x' }] }).patches).toEqual([])
  })

  it('textures 缺失/为空时，任何非 null 的贴图引用都视为非法移除', () => {
    const result = patchVrmGltfJson({
      materials: [
        { name: 'm', extensions: { VRMC_materials_mtoon: { shadeMultiplyTexture: { index: 0 } } } }
      ]
    })
    expect(result.patches).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* GLB 重新封装                                                                */
/* -------------------------------------------------------------------------- */

describe('patchVrmGlbBuffer：GLB 容器修复', () => {
  it('修复 JSON 并保持 BIN chunk 逐字节不变、头部长度正确、JSON 4 字节对齐', () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
    const glb = buildGlb(makeGltfFixture(), bin)
    const result = patchVrmGlbBuffer(glb)
    expect(result.patches).toHaveLength(2)

    const view = new DataView(result.data.buffer, result.data.byteOffset, result.data.byteLength)
    expect(view.getUint32(0, true)).toBe(MAGIC)
    expect(view.getUint32(4, true)).toBe(GLB_VERSION)
    expect(view.getUint32(8, true)).toBe(result.data.byteLength)
    expect(view.getUint32(12, true) % 4).toBe(0)
    expect(view.getUint32(16, true)).toBe(CHUNK_JSON)

    const { json, bin: outBin } = readGlbChunks(result.data)
    expect(outBin).not.toBeNull()
    // chunk 长度按 4 字节对齐，内容用 0 填充（glTF 规范）
    expect(Array.from(outBin ?? [])).toEqual([...Array.from(bin), 0])
    const materials = (json as { materials: Array<Record<string, unknown>> }).materials
    const mtoon = (
      materials[0].extensions as Record<string, Record<string, unknown>>
    ).VRMC_materials_mtoon
    expect(mtoon['shadeMultiplyTexture']).toBeUndefined()
    expect(mtoon['shadingShiftTexture']).toEqual({ index: 1 })
    expect(result.data).not.toBe(glb)
  })

  it('二次修复幂等（0 patch，BIN 不变）', () => {
    const glb = buildGlb(makeGltfFixture(), new Uint8Array([9, 9, 9, 9]))
    const first = patchVrmGlbBuffer(glb)
    const second = patchVrmGlbBuffer(first.data)
    expect(second.patches).toEqual([])
    expect(Array.from(readGlbChunks(second.data).bin ?? [])).toEqual([9, 9, 9, 9])
  })

  it('非法输入抛错（bad magic / 非 v2 / 截断 / 坏 JSON）', () => {
    expect(() => patchVrmGlbBuffer(new Uint8Array(0))).toThrow(/长度/)
    const badMagic = buildGlb(makeGltfFixture())
    badMagic[0] = 0
    expect(() => patchVrmGlbBuffer(badMagic)).toThrow(/magic/)
    const badVersion = buildGlb(makeGltfFixture())
    new DataView(badVersion.buffer).setUint32(4, 1, true)
    expect(() => patchVrmGlbBuffer(badVersion)).toThrow(/版本/)
    const truncated = buildGlb(makeGltfFixture()).subarray(0, 22)
    expect(() => patchVrmGlbBuffer(truncated)).toThrow(/长度不一致/)
    const badJson = buildGlb(makeGltfFixture())
    new DataView(badJson.buffer).setUint32(12, 8, true) // JSON chunk 只留 8 字节（非法 JSON）
    expect(() => patchVrmGlbBuffer(badJson)).toThrow(/JSON/)
  })

  it('接受 ArrayBuffer 输入（V1 loader fetch arrayBuffer 后直接传入）', () => {
    const glb = buildGlb(makeGltfFixture())
    const arrayBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength)
    const result = patchVrmGlbBuffer(arrayBuffer as ArrayBuffer)
    expect(result.patches).toHaveLength(2)
  })
})

/* -------------------------------------------------------------------------- */
/* 真实私有资产（存在时）                                                      */
/* -------------------------------------------------------------------------- */

describe.skipIf(!hasOriginalAsset)('真实戏浪 VRM：原始资产修复', () => {
  it('移除 珍珠.shadeMultiplyTexture 非法引用，GLB 可重解析且 BIN 不变', () => {
    const original = readFileSync(AVENTURINE_ORIGINAL)
    const result = patchVrmGlbBuffer(original)
    const pearlPatch = result.patches.find((patch) => patch.material === '珍珠')
    expect(pearlPatch).toBeDefined()
    expect(pearlPatch?.key).toBe('shadeMultiplyTexture')
    expect(result.patches).toHaveLength(1) // 该资产只有这一处非法贴图引用

    const { json, bin } = readGlbChunks(result.data)
    expect((json as { materials: unknown[] }).materials).toHaveLength(39)
    expect(bin).not.toBeNull()
    // BIN chunk 与原始文件逐字节相同 → 几何/贴图/动画数据未被修改
    const originalBin = readGlbChunks(original).bin
    expect(bin?.length).toBe(originalBin?.length)
    expect(Buffer.from(bin ?? []).equals(Buffer.from(originalBin ?? []))).toBe(true)
  })
})

describe.skipIf(!hasPatchedAsset)('真实戏浪 VRM：修复后资产', () => {
  it('已修复的本地副本二次修复 0 处（数据修复已生效）', () => {
    const patched = readFileSync(AVENTURINE_PATCHED)
    expect(patchVrmGlbBuffer(patched).patches).toEqual([])
  })
})
