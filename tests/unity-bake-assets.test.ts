/**
 * U2 真实产物集成测试（`assets/motions/mate/**`，私有 gitignore）。
 *
 * 策略：
 * - `index.json` 不存在（干净 checkout / 未跑 U1 导出）→ 整个 describe 跳过；
 * - 存在但 clip 数 < 25（Wave 1.5 未完成）→ 基础数据校验跑、U3 全量断言跳过
 *   （保证 Wave 1.5 进行中 `pnpm test` 仍绿；B lane 完成后自动启用全量断言）；
 * - manifest 由 `build-motion-manifest.mjs` 生成；不存在时相关用例跳过。
 *
 * 本文件只读 assets，不写任何文件。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import { validateClipData } from '../scripts/unity-bake/lib/clip-validation.mjs'
// @ts-expect-error -- 同上
import { CLIP_BONE_NAMES, CLIP_OPTIONAL_BONES, CLIP_REQUIRED_BONES } from '../scripts/unity-bake/lib/humanoid-map.mjs'
// @ts-expect-error -- 同上
import {
  buildMotionManifest,
  validateManifestAgainstSelection
} from '../scripts/unity-bake/lib/motion-manifest.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MATE_DIR = join(REPO_ROOT, 'assets/motions/mate')
const INDEX_FILE = join(MATE_DIR, 'index.json')
const SELECTION_FILE = join(REPO_ROOT, 'scripts/unity-bake/clips.json')
const MANIFEST_CANONICAL = join(MATE_DIR, 'manifest.json')
const MANIFEST_MIRROR = join(REPO_ROOT, 'assets/motions/manifest.json')

interface ClipIndexEntry {
  file: string
  mood?: string | null
  loop?: boolean
  duration?: number
  fps?: number
}

const indexExists = existsSync(INDEX_FILE)
const indexData = indexExists
  ? (JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as { clips?: Record<string, ClipIndexEntry> })
  : null
const clipNames = Object.keys(indexData?.clips ?? {}).sort()
const clipCount = clipNames.length
const wave15Complete = clipCount >= 25
const manifestExists = existsSync(MANIFEST_CANONICAL) && existsSync(MANIFEST_MIRROR)

/**
 * selection 里登记但尚未导出的 clip（Wave 1.5 进行中的正常瞬态：B lane 先改 clips.json，
 * 再由 Lead 统一跑 Unity 导出）。存在缺失时，「selection/manifest 全量一致性」用例跳过，
 * 不把进行中的中间态误报成失败；导出完成后自动启用严格断言。
 */
const selectionClipNames = existsSync(SELECTION_FILE)
  ? ((JSON.parse(readFileSync(SELECTION_FILE, 'utf8')).clips ?? []) as Array<Record<string, unknown>>)
      .map((entry) => String(entry.name))
  : []
const missingSelectionExports = selectionClipNames.filter(
  (name) => !existsSync(join(MATE_DIR, `${name}.json`))
)
const selectionExportsComplete = selectionClipNames.length > 0 && missingSelectionExports.length === 0

function readClip(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(MATE_DIR, `${name}.json`), 'utf8'))
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8'))
}

describe.skipIf(!indexExists)('U2 真实产物：assets/motions/mate（私有，缺失时跳过）', () => {
  it('index.json 存在且包含若干 clip', () => {
    expect(indexData?.clips).toBeTruthy()
    expect(clipCount).toBeGreaterThan(0)
  })

  it('index 登记的每个 clip 文件存在且通过 validateClipData（error 数 = 0）', () => {
    const failures: string[] = []
    for (const name of clipNames) {
      const entry = indexData?.clips?.[name]
      const file = join(MATE_DIR, entry?.file ?? `${name}.json`)
      if (!existsSync(file)) {
        failures.push(`${name}: 文件不存在 ${file}`)
        continue
      }
      expect(statSync(file).size, `${name}: 文件为空`).toBeGreaterThan(0)
      const result = validateClipData(readClip(name))
      if (!result.ok) failures.push(`${name}: ${result.errors.join('; ')}`)
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('index 元数据与 clip 数据一致（file / fps / loop / duration≈frames/fps）', () => {
    for (const name of clipNames) {
      const entry = indexData?.clips?.[name]
      const clip = readClip(name)
      expect(clip.clip, `${name}: clip 名`).toBe(name)
      expect(clip.fps, `${name}: fps`).toBe(entry?.fps)
      expect(clip.loop, `${name}: loop`).toBe(entry?.loop)
      if (typeof entry?.duration === 'number') {
        expect(clip.duration, `${name}: duration`).toBeCloseTo(entry.duration, 5)
      }
      const expectedFrames = clip.loop
        ? Math.round(clip.duration * clip.fps)
        : Math.round(clip.duration * clip.fps) + 1
      // 容差 ±1 帧（Unity Mathf.RoundToInt vs JS Math.round 在 .5 边界）
      expect(Math.abs(clip.frames - expectedFrames), `${name}: frames 一致性`).toBeLessThanOrEqual(1)
    }
  })

  it('全部 clip 都是 22 核心骨 + 30 手指（52）/ 30fps / 四元数单位化', () => {
    const expectedBones = [...CLIP_REQUIRED_BONES, ...CLIP_OPTIONAL_BONES]
    for (const name of clipNames) {
      const clip = readClip(name)
      expect(clip.version, `${name}: version`).toBe(1)
      expect(clip.space, `${name}: space`).toBe('gltf-rh')
      const boneNames = Object.keys(clip.bones)
      expect(boneNames, `${name}: bones`).toHaveLength(expectedBones.length)
      expect(boneNames.sort(), `${name}: bones 集合`).toEqual([...expectedBones].sort())
      for (const bone of boneNames) {
        expect(CLIP_BONE_NAMES, `${name}: 未知骨 ${bone}`).toContain(bone)
      }
      expect(clip.fps, `${name}: fps`).toBe(30)
      const result = validateClipData(clip, { optionalBones: CLIP_OPTIONAL_BONES })
      expect(result.errors, `${name}: errors`).toEqual([])
      expect(result.warnings, `${name}: warnings`).toEqual([])
      expect(result.stats.quatNorm.min, `${name}: quatNorm.min`).toBeCloseTo(1, 3)
      expect(result.stats.quatNorm.max, `${name}: quatNorm.max`).toBeCloseTo(1, 3)
    }
  })

  it.skipIf(!wave15Complete)('clip 数量在 Wave 1.5 目标区间 25–35', () => {
    expect(clipCount).toBeGreaterThanOrEqual(25)
    expect(clipCount).toBeLessThanOrEqual(35)
  })

  it.skipIf(!wave15Complete || !selectionExportsComplete)(
    'clips.json selection 的每个 clip 都有导出文件',
    () => {
      expect(missingSelectionExports, `缺少导出：${missingSelectionExports.join(', ')}`).toEqual([])
      expect(indexData?.clips && Object.keys(indexData.clips).length).toBeGreaterThanOrEqual(
        selectionClipNames.length
      )
    }
  )

  it.skipIf(!wave15Complete || !selectionExportsComplete)(
    'selection + 全部 clip 数据构建 manifest 无 error（requirements 覆盖达标）',
    () => {
    const selection = readJson(SELECTION_FILE)
    const clips: Record<string, unknown> = {}
    for (const name of clipNames) clips[name] = readClip(name)
    const built = buildMotionManifest({
      selection,
      clips,
      generatedAt: new Date().toISOString()
    }) as { errors: string[]; manifest: Record<string, any> }
    expect(built.errors, built.errors.join('\n')).toEqual([])
    // 覆盖下限是构建期 error 而非 warning：无 error 即达标；再显式核对每个 requirement。
    const requirements = (selection.requirements ?? {}) as Record<string, number>
    for (const [tag, required] of Object.entries(requirements)) {
      expect(built.manifest.coverage[tag] ?? 0, `coverage ${tag}`).toBeGreaterThanOrEqual(required)
    }
  }
  )

  it.skipIf(!manifestExists)('磁盘 manifest 与 selection/clip 数据一致（--check 等价）', () => {
    const selection = readJson(SELECTION_FILE)
    const clips: Record<string, unknown> = {}
    for (const name of clipNames) clips[name] = readClip(name)
    const manifest = readJson(MANIFEST_CANONICAL)
    const result = validateManifestAgainstSelection(manifest, selection, clips) as {
      ok: boolean
      errors: string[]
    }
    expect(result.errors, result.errors.join('\n')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it.skipIf(!manifestExists)('canonical 与镜像 manifest 内容一致', () => {
    expect(readJson(MANIFEST_CANONICAL)).toEqual(readJson(MANIFEST_MIRROR))
  })

  it.skipIf(!manifestExists)('manifest 条目数与 clip 数一致、slot 合法、file 指向存在的 JSON', () => {
    const manifest = readJson(MANIFEST_CANONICAL)
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.clips).toHaveLength(clipCount)
    const ids = (manifest.clips as Array<Record<string, any>>).map((clip) => clip.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const clip of manifest.clips as Array<Record<string, any>>) {
      expect(clip.file, `${clip.id}: file`).toBe(`mate/${clip.id}.json`)
      expect(existsSync(join(MATE_DIR, `${clip.id}.json`)), `${clip.id}: 文件`).toBe(true)
      expect(clip.file.startsWith('mate/'), `${clip.id}: file 前缀`).toBe(true)
      if (clip.slot !== null) {
        expect(
          [
            'idle',
            'walk',
            'climb',
            'sit',
            'sleep',
            'drag',
            'fall',
            'pat',
            'grabWindow',
            'dshBusy',
            'dshDone',
            'dshError',
            'salute'
          ],
          `${clip.id}: slot ${clip.slot}`
        ).toContain(clip.slot)
      }
    }
  })
})
