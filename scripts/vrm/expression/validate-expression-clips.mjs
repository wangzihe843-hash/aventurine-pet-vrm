#!/usr/bin/env node
/**
 * V6 表情层：表情 clip 数据集校验（dev-only）
 *
 *   node scripts/vrm/expression/validate-expression-clips.mjs \
 *     --dir assets/expressions \
 *     --vrm assets/vrm/aventurine-tpose.vrm \
 *     --json tests/tmp/expr/validation-report.json
 *
 * 校验内容：
 * 1. 目录下每个 `*.json` clip（除 manifest.json）→ schema/帧数/轨道/权重/loop 接缝；
 * 2. manifest 与文件一一对应、file 引用存在、元数据（frames/duration/fps/loop）一致；
 * 3. 若给 `--vrm`：轨道名必须存在于目标模型 expression（preset 或 custom），否则 error
 *    （播放端会跳过 = 数据无效）；不给则只按 VRM1 preset 名单校验（未知轨道 → warning）。
 *
 * 退出码：0 = 无 FAIL；1 = 有 FAIL；2 = 非法参数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatHelp, parseCliArgs } from '../../unity-bake/lib/cli-args.mjs'
import { findExpressionClipEntry, validateExpressionClipData } from './lib/expression-clip.mjs'
import { readVrmExpressionInventory } from './lib/vrm-expressions.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const OPTIONS = {
  dir: {
    type: 'string',
    default: 'assets/expressions',
    valueHint: 'dir',
    description: '表情 clip 根目录（含 <set>/*.json 与 manifest.json；私有资产）'
  },
  vrm: {
    type: 'string',
    default: '',
    valueHint: 'path',
    description: '目标 VRM（校验轨道名是否真实存在；缺省只按 VRM1 preset 名单）'
  },
  json: { type: 'string', default: '', valueHint: 'path', description: '写 JSON 校验报告' },
  quiet: { type: 'boolean', default: false, description: '只打印汇总行' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/expression/validate-expression-clips.mjs',
  description: 'V6 表情层：校验表情 clip 数据 + manifest（schema/帧数/权重/目标模型 expression 名）。',
  usage: 'node scripts/vrm/expression/validate-expression-clips.mjs [--dir <dir>] [--vrm <path>] [--json <path>]',
  options: OPTIONS,
  footer: '输出：PASS/WARN/FAIL 表 + 可选 JSON 报告；退出码 0/1/2。'
})

function fail(message, code = 1) {
  console.error(`[validate-expression-clips] ERROR: ${message}`)
  process.exit(code)
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function listClipFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const sub = path.join(dir, entry.name)
    for (const file of fs.readdirSync(sub)) {
      if (!file.endsWith('.json') || file === 'manifest.json') continue
      out.push({ set: entry.name, id: file.replace(/\.json$/, ''), path: path.join(sub, file) })
    }
  }
  return out.sort((a, b) => (a.set === b.set ? a.id.localeCompare(b.id) : a.set.localeCompare(b.set)))
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.stderr.write('\n' + HELP)
    process.exit(2)
  }
  const dir = path.resolve(ROOT, String(values.dir))
  const quiet = values.quiet === true
  if (!fs.existsSync(dir)) fail(`目录不存在：${toDisplayPath(dir)}`)
  const manifestPath = path.join(dir, 'manifest.json')
  const files = listClipFiles(dir)
  if (files.length === 0) fail(`目录下没有 clip 文件（${toDisplayPath(dir)}）`)

  /** @type {string[] | null} */
  let knownExpressionNames = null
  let vrmInventory = null
  if (values.vrm) {
    const vrmPath = path.resolve(ROOT, String(values.vrm))
    if (!fs.existsSync(vrmPath)) fail(`VRM 不存在：${toDisplayPath(vrmPath)}`)
    vrmInventory = readVrmExpressionInventory(vrmPath)
    knownExpressionNames = vrmInventory.all
    if (!vrmInventory.hasExpressionManager) fail(`VRM 没有可用 expression（${toDisplayPath(vrmPath)}）`)
  }

  const results = []
  let failCount = 0
  let warnCount = 0
  let passCount = 0
  for (const file of files) {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file.path, 'utf8'))
    } catch (error) {
      results.push({ file: `${file.set}/${file.id}.json`, ok: false, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`], warnings: [] })
      failCount += 1
      continue
    }
    const validation = validateExpressionClipData(raw, {
      label: `${file.set}/${file.id}`,
      knownExpressionNames: knownExpressionNames ?? undefined
    })
    const label = `${file.set}/${file.id}`
    results.push({ file: label, ok: validation.ok, errors: validation.errors, warnings: validation.warnings, stats: validation.stats })
    if (!validation.ok) failCount += 1
    else if (validation.warnings.length > 0) warnCount += 1
    else passCount += 1
  }

  // manifest 校验
  const manifestProblems = []
  let manifestEntries = []
  if (fs.existsSync(manifestPath)) {
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      manifestProblems.push(`manifest JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
      manifest = null
    }
    if (manifest) {
      if (manifest.schemaVersion !== 1) manifestProblems.push('manifest.schemaVersion 必须为 1')
      manifestEntries = Array.isArray(manifest.clips) ? manifest.clips : []
      const seenIds = new Set()
      const filesByRel = new Map(files.map((file) => [path.relative(dir, file.path).split(path.sep).join('/'), file]))
      const referenced = new Set()
      for (const entry of manifestEntries) {
        if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
          manifestProblems.push('manifest 条目缺 id')
          continue
        }
        if (seenIds.has(entry.id)) manifestProblems.push(`manifest id 重复：${entry.id}`)
        seenIds.add(entry.id)
        if (typeof entry.file !== 'string' || !filesByRel.has(entry.file)) {
          manifestProblems.push(`manifest 条目 ${entry.id} 的 file 指向不存在的 clip：${String(entry.file)}`)
          continue
        }
        referenced.add(entry.file)
        const file = filesByRel.get(entry.file)
        try {
          const clip = JSON.parse(fs.readFileSync(file.path, 'utf8'))
          for (const field of ['loop', 'fps', 'frames', 'duration']) {
            if (entry[field] !== clip[field]) {
              manifestProblems.push(`manifest 条目 ${entry.id} 的 ${field}（${entry[field]}）与 clip 数据（${clip[field]}）不一致`)
            }
          }
          if (entry.set !== clip.source) manifestProblems.push(`manifest 条目 ${entry.id} 的 set（${entry.set}）与 clip.source（${clip.source}）不一致`)
        } catch {
          manifestProblems.push(`manifest 条目 ${entry.id} 引用的 clip 无法解析`)
        }
      }
      for (const [rel] of filesByRel) {
        if (!referenced.has(rel)) manifestProblems.push(`clip 文件 ${rel} 没有对应的 manifest 条目`)
      }
      // 触发键一致性（manifest 与运行时 trigger 表）：只做提示
    }
  } else {
    manifestProblems.push('缺少 manifest.json（先跑 build-expression-manifest.mjs）')
  }
  if (manifestProblems.length > 0) failCount += 1

  // 目标模型 rollup
  const trackUnion = new Set()
  for (const result of results) {
    for (const track of Object.keys(result.stats?.tracks ?? {})) trackUnion.add(track)
  }
  const missingTracks = knownExpressionNames
    ? [...trackUnion].filter((name) => !knownExpressionNames.includes(name))
    : []

  const report = {
    generatedAt: new Date().toISOString(),
    dir: toDisplayPath(dir),
    vrm: values.vrm ? toDisplayPath(path.resolve(ROOT, String(values.vrm))) : null,
    vrmInventory: vrmInventory
      ? { specVersion: vrmInventory.specVersion, presetCount: vrmInventory.presets.length, customCount: vrmInventory.customs.length }
      : null,
    summary: { files: files.length, pass: passCount, warn: warnCount, fail: failCount },
    trackUnion: [...trackUnion].sort(),
    missingTracks,
    manifest: { path: toDisplayPath(manifestPath), entries: manifestEntries.length, problems: manifestProblems },
    results
  }
  if (values.json) {
    const jsonPath = path.resolve(ROOT, String(values.json))
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n')
  }

  if (!quiet) {
    for (const result of results) {
      const status = !result.ok ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS'
      process.stdout.write(`  ${status}  ${result.file}`)
      if (result.ok && result.warnings.length === 0) {
        const stats = result.stats ?? {}
        process.stdout.write(`  (${stats.trackCount ?? 0} tracks, max ${(stats.maxWeight ?? 0).toFixed(2)})`)
      }
      process.stdout.write('\n')
      for (const error of result.errors ?? []) process.stdout.write(`        - ${error}\n`)
      for (const warning of result.warnings ?? []) process.stdout.write(`        ~ ${warning}\n`)
    }
    for (const problem of manifestProblems) process.stdout.write(`  MANIFEST  - ${problem}\n`)
  }

  process.stdout.write(
    `\n[validate-expression-clips] ${files.length} files：PASS ${passCount} / WARN ${warnCount} / FAIL ${failCount}` +
      (vrmInventory ? ` | target "${path.basename(String(values.vrm))}" presets=${vrmInventory.presets.length} customs=${vrmInventory.customs.length}` : '') +
      '\n'
  )
  if (missingTracks.length > 0) {
    process.stdout.write(`  [FAIL] 目标模型缺少轨道：${missingTracks.join(', ')}\n`)
  }
  process.exit(failCount > 0 ? 1 : 0)
}

main()
