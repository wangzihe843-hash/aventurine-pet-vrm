/**
 * A6 单测：资源清单（M0-3）结构回归 —— 只读取被 git 跟踪的
 * `src/shared/assets-manifest.json`，不依赖私有 `assets/model/` 是否存在（CI / 新 clone 可跑）。
 *
 * 冻结要点：20 张贴图（3 张 4096x2048 -> 2048x1024 降采样 + 17 张字节原样拷贝）、
 * 9 个未引用文件、PMX counts、missing=[]；清单 schema 不扩展。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AssetsManifest, TextureManifestEntry } from '@shared/types'

const MANIFEST_PATH = fileURLToPath(new URL('../src/shared/assets-manifest.json', import.meta.url))
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as AssetsManifest

const EXPECTED_RESIZED_SOURCES = [
  'Avatar_AventurineW_00_Body_Color_A_LA.png',
  '衣.png',
  '衣N.png'
]

const EXPECTED_UNREFERENCED = [
  '1.png',
  '31.bmp',
  'Matcap_14.png',
  'Matcap_30.png',
  'h.png',
  'hair5_s.png',
  'mc3.png',
  'toon5.png',
  '水枪.png'
]

const TEXTURE_ENTRY_KEYS = [
  'index',
  'name',
  'source',
  'optimized',
  'resized',
  'sourceWidth',
  'sourceHeight',
  'width',
  'height',
  'sourceBytes',
  'bytes',
  'sourceSha256',
  'sha256'
].sort()

const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * F-10：PMX 纹理表允许重复引用同一张贴图（同一文件出现在多个 texture 索引）。
 * 管线按「引用索引」展开 manifest.textures，因此 optimized 名可以合法重复；唯一性
 * 断言必须针对**去重后的产物**，而不是条目数（旧断言在未来出现重复引用时会误报）。
 * 同名（大小写不敏感）条目必须指向完全相同的产物（source/hash/尺寸/字节）。
 */
const ARTIFACT_FIELDS = [
  'source',
  'optimized',
  'resized',
  'sourceWidth',
  'sourceHeight',
  'width',
  'height',
  'sourceBytes',
  'bytes',
  'sourceSha256',
  'sha256'
] as const

type TextureArtifact = Pick<TextureManifestEntry, (typeof ARTIFACT_FIELDS)[number]>

function artifactSignature(entry: TextureArtifact): string {
  return JSON.stringify(ARTIFACT_FIELDS.map((field) => entry[field]))
}

function groupByOptimizedName<T extends { optimized: string }>(entries: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const key = entry.optimized.toLowerCase()
    const group = groups.get(key)
    if (group) {
      group.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }
  return groups
}

describe('assets-manifest：顶层结构（冻结 schema，不扩展）', () => {
  it('顶层键集合冻结', () => {
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'schemaVersion',
        'generatedAt',
        'sourceDir',
        'outputDir',
        'maxEdge',
        'pmx',
        'textures',
        'unreferencedFiles'
      ].sort()
    )
  })

  it('版本/目录/阈值冻结，generatedAt 为合法 ISO 时间', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.sourceDir).toBe('assets/model')
    expect(manifest.outputDir).toBe('assets/model/optimized')
    expect(manifest.maxEdge).toBe(2048)
    expect(typeof manifest.generatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false)
  })
})

describe('assets-manifest：PMX 元数据', () => {
  it('来源/大小/哈希/名称合法，missingTextures 为空', () => {
    expect(manifest.pmx.file.endsWith('.pmx')).toBe(true)
    expect(manifest.pmx.bytes).toBeGreaterThan(0)
    expect(manifest.pmx.sha256).toMatch(SHA256_RE)
    expect(manifest.pmx.version).toBe(2)
    expect(typeof manifest.pmx.modelName).toBe('string')
    expect(manifest.pmx.modelName.length).toBeGreaterThan(0)
    expect(manifest.pmx.missingTextures).toEqual([])
  })

  it('counts 冻结（私有模型已解析出的真实数值）', () => {
    expect(manifest.pmx.counts).toEqual({
      vertices: 32966,
      faces: 51829,
      materials: 39,
      bones: 382,
      morphs: 85,
      rigidBodies: 284,
      constraints: 318,
      textures: 20
    })
  })

  it('textureReferences 与贴图条目数量一致（20）', () => {
    expect(manifest.pmx.textureReferences).toHaveLength(20)
    expect(manifest.pmx.counts.textures).toBe(manifest.pmx.textureReferences.length)
    expect(manifest.pmx.counts.textures).toBe(manifest.textures.length)
    for (const ref of manifest.pmx.textureReferences) {
      expect(typeof ref).toBe('string')
      expect(ref.length).toBeGreaterThan(0)
    }
  })
})

describe('assets-manifest：贴图条目', () => {
  it('恰好 20 条，index 连续 0..19，字段集合冻结', () => {
    expect(manifest.textures).toHaveLength(20)
    manifest.textures.forEach((entry: TextureManifestEntry, index: number) => {
      expect(entry.index).toBe(index)
      expect(Object.keys(entry).sort()).toEqual(TEXTURE_ENTRY_KEYS)
    })
  })

  it('3 张 4096x2048 贴图降采样为 2048x1024，源/输出字节与哈希形状合法', () => {
    const resized = manifest.textures.filter((entry) => entry.resized)
    expect(resized).toHaveLength(3)
    expect(resized.map((entry) => entry.source).sort()).toEqual(EXPECTED_RESIZED_SOURCES)
    for (const entry of resized) {
      expect(entry.sourceWidth).toBe(4096)
      expect(entry.sourceHeight).toBe(2048)
      expect(entry.width).toBe(2048)
      expect(entry.height).toBe(1024)
      expect(entry.sourceSha256).toMatch(SHA256_RE)
      expect(entry.sha256).toMatch(SHA256_RE)
      expect(entry.sourceBytes).toBeGreaterThan(0)
      expect(entry.bytes).toBeGreaterThan(0)
      // 降采样后重新编码：输出字节数应小于源文件
      expect(entry.bytes).toBeLessThan(entry.sourceBytes)
    }
  })

  it('其余 17 张按字节原样拷贝：sha256 === sourceSha256 且尺寸/字节一致', () => {
    const copied = manifest.textures.filter((entry) => !entry.resized)
    expect(copied).toHaveLength(17)
    for (const entry of copied) {
      expect(entry.sha256).toBe(entry.sourceSha256)
      expect(entry.bytes).toBe(entry.sourceBytes)
      expect(entry.width).toBe(entry.sourceWidth)
      expect(entry.height).toBe(entry.sourceHeight)
      expect(entry.sourceBytes).toBeGreaterThan(0)
      // 未降采样贴图的最大边也必须不超过 manifest.maxEdge
      expect(Math.max(entry.width, entry.height)).toBeLessThanOrEqual(manifest.maxEdge)
    }
  })

  it('全部条目：按 optimized 名去重后唯一（大小写不敏感）、哈希格式合法', () => {
    const groups = groupByOptimizedName(manifest.textures)
    // 去重后的产物数不可能超过纹理引用条目数；每个产物的所有引用必须指向同一份文件。
    expect(groups.size).toBeLessThanOrEqual(manifest.textures.length)
    for (const [optimizedName, group] of groups) {
      const signatures = new Set(group.map((entry) => artifactSignature(entry)))
      expect(signatures.size, `optimized=${optimizedName} 的同名引用指向了不同产物`).toBe(1)
    }
    // 大小写不敏感去重后没有「仅大小写不同」的名字（兼容 macOS 默认文件系统）。
    const exactNames = new Set(manifest.textures.map((entry) => entry.optimized))
    expect(exactNames.size).toBe(groups.size)
    for (const entry of manifest.textures) {
      expect(typeof entry.name).toBe('string')
      expect(typeof entry.source).toBe('string')
      expect(typeof entry.optimized).toBe('string')
      expect(entry.sourceSha256).toMatch(SHA256_RE)
      expect(entry.sha256).toMatch(SHA256_RE)
      expect(Number.isInteger(entry.width)).toBe(true)
      expect(Number.isInteger(entry.height)).toBe(true)
    }
  })

  it('重复引用样例：同一贴图被多个纹理索引引用时，去重后只算一个 optimized 产物（纯样例，不依赖私有模型）', () => {
    const baseSample: Omit<TextureManifestEntry, 'index' | 'name'> = {
      source: '衣.png',
      optimized: '衣.png',
      resized: false,
      sourceWidth: 1024,
      sourceHeight: 1024,
      width: 1024,
      height: 1024,
      sourceBytes: 1234,
      bytes: 1234,
      sourceSha256: 'a'.repeat(64),
      sha256: 'a'.repeat(64)
    }
    // 纹理槽 0/1 重复引用同一文件（未来模型的合法形态），槽 2 引用另一文件。
    const sample: TextureManifestEntry[] = [
      { ...baseSample, index: 0, name: '衣.png' },
      { ...baseSample, index: 1, name: '衣.png' },
      { ...baseSample, index: 2, name: '衣N.png', source: '衣N.png', optimized: '衣N.png' }
    ]

    const groups = groupByOptimizedName(sample)
    expect(sample).toHaveLength(3)
    expect(groups.size).toBe(2)
    expect([...groups.keys()].sort()).toEqual(['衣.png', '衣n.png'].sort())
    expect(groups.get('衣.png')).toHaveLength(2)
    expect(new Set(groups.get('衣.png')!.map((entry) => artifactSignature(entry))).size).toBe(1)
  })
})

describe('assets-manifest：未引用文件', () => {
  it('9 个未引用图片（排序、唯一、均带图片扩展名）', () => {
    expect(manifest.unreferencedFiles).toHaveLength(9)
    expect(manifest.unreferencedFiles).toEqual(EXPECTED_UNREFERENCED)
    expect([...manifest.unreferencedFiles].sort()).toEqual(manifest.unreferencedFiles)
    expect(new Set(manifest.unreferencedFiles).size).toBe(manifest.unreferencedFiles.length)
    for (const name of manifest.unreferencedFiles) {
      expect(name.toLowerCase()).toMatch(/\.(png|bmp|jpg|jpeg|tga|dds|gif)$/)
    }
  })
})
