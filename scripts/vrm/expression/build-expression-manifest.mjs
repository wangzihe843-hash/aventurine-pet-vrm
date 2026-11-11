#!/usr/bin/env node
/**
 * V6 表情层：生成表情集 manifest（dev-only）
 *
 *   node scripts/vrm/expression/build-expression-manifest.mjs \
 *     --dir assets/expressions \
 *     --configs scripts/vrm/expression/config/mate-face.json,scripts/vrm/expression/config/hsr-emo.json \
 *     --out assets/expressions/manifest.json [--check]
 *
 * 数据来源：
 * - clip 文件：`<dir>/<set>/<id>.json`（由 extract/decode 脚本生成；私有资产 gitignore）；
 * - 触发/标签/优先级/备注：各管线配置（`clips[].id` 对齐）；
 * - manifest 条目里的 file = `<set>/<id>.json`（assets 根相对路径，V6 loader 用 pet-asset 读取）。
 *
 * `--check` 只读：重新生成后与磁盘 manifest 对比（忽略 generatedAt），不一致 → exit 1。
 *
 * 退出码：0 成功；1 生成/校验失败；2 非法参数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatHelp, parseCliArgs } from '../../unity-bake/lib/cli-args.mjs'
import {
  buildExpressionClipEntry,
  buildExpressionManifest,
  EXPRESSION_CLIP_SOURCES,
  validateExpressionClipData
} from './lib/expression-clip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const OPTIONS = {
  dir: { type: 'string', default: 'assets/expressions', valueHint: 'dir', description: '表情 clip 根目录（<set>/*.json）' },
  configs: {
    type: 'string',
    default: 'scripts/vrm/expression/config/mate-face.json',
    valueHint: 'a,b',
    description: '逗号分隔的管线配置（clips[].id / triggers / tags / priority / note）'
  },
  out: {
    type: 'string',
    default: 'assets/expressions/manifest.json',
    valueHint: 'path',
    description: 'manifest 输出路径（私有资产）'
  },
  check: { type: 'boolean', default: false, description: '只读：重新生成后与磁盘 manifest 对比，不一致 exit 1' },
  quiet: { type: 'boolean', default: false, description: '只打印汇总行' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/expression/build-expression-manifest.mjs',
  description: 'V6 表情层：扫描 clip 数据 + 管线配置，生成 assets/expressions/manifest.json。',
  usage: 'node scripts/vrm/expression/build-expression-manifest.mjs [--dir <dir>] [--configs <a,b>] [--out <path>] [--check]',
  options: OPTIONS,
  footer: '输出：manifest.json（schemaVersion=1, clips[]）；`--check` 幂等对比。'
})

function fail(message, code = 1) {
  console.error(`[build-expression-manifest] ERROR: ${message}`)
  process.exit(code)
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function listClips(dir) {
  const clips = []
  if (!fs.existsSync(dir)) return clips
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    if (!EXPRESSION_CLIP_SOURCES.includes(entry.name)) {
      console.error(`[build-expression-manifest] WARN：忽略未知 set 目录 ${entry.name}/`)
      continue
    }
    const sub = path.join(dir, entry.name)
    for (const file of fs.readdirSync(sub)) {
      if (!file.endsWith('.json')) continue
      const id = file.replace(/\.json$/, '')
      clips.push({ set: entry.name, id, file: `${entry.name}/${file}`, path: path.join(sub, file) })
    }
  }
  return clips.sort((a, b) => (a.set === b.set ? a.id.localeCompare(b.id) : a.set.localeCompare(b.set)))
}

/** 读取并合并配置里的 clip 元数据（id → config）。 */
function loadConfigMetadata(configPaths) {
  const metadata = new Map()
  const warnings = []
  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) {
      warnings.push(`配置不存在，跳过：${toDisplayPath(configPath)}`)
      continue
    }
    let config
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (error) {
      throw new Error(`配置 JSON 解析失败（${toDisplayPath(configPath)}）：${error instanceof Error ? error.message : String(error)}`)
    }
    const clips = Array.isArray(config?.clips) ? config.clips : []
    for (const item of clips) {
      if (typeof item?.id !== 'string' || item.id.length === 0) continue
      if (metadata.has(item.id)) {
        warnings.push(`配置 id 重复（${item.id}，来自 ${toDisplayPath(configPath)}），后者覆盖前者`)
      }
      metadata.set(item.id, item)
    }
  }
  return { metadata, warnings }
}

/** 去掉 generatedAt 后比较（--check 用）。 */
function comparableManifest(manifest) {
  const { generatedAt, ...rest } = manifest
  void generatedAt
  return JSON.stringify(rest, null, 2) + '\n'
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
  const outPath = path.resolve(ROOT, String(values.out))
  const check = values.check === true
  const quiet = values.quiet === true
  const configPaths = String(values.configs)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(ROOT, item))
  if (!fs.existsSync(dir)) fail(`clip 目录不存在：${toDisplayPath(dir)}`)

  const clips = listClips(dir)
  if (clips.length === 0) fail(`目录下没有 <set>/*.json clip 文件：${toDisplayPath(dir)}`)

  let metadata
  let metadataWarnings
  try {
    const loaded = loadConfigMetadata(configPaths)
    metadata = loaded.metadata
    metadataWarnings = loaded.warnings
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  for (const warning of metadataWarnings) console.error(`[build-expression-manifest] WARN：${warning}`)

  const entries = []
  const problems = []
  for (const file of clips) {
    let clip
    try {
      clip = JSON.parse(fs.readFileSync(file.path, 'utf8'))
    } catch (error) {
      problems.push(`${file.set}/${file.id}：JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    const validation = validateExpressionClipData(clip, { label: `${file.set}/${file.id}` })
    if (!validation.ok) {
      problems.push(`${file.set}/${file.id}：${validation.errors.join('；')}`)
      continue
    }
    if (clip.source !== file.set) {
      problems.push(`${file.set}/${file.id}：clip.source=${clip.source} 与所在 set 目录不一致`)
      continue
    }
    const config = metadata.get(file.id)
    if (!config) {
      console.error(`[build-expression-manifest] WARN：clip ${file.set}/${file.id} 没有配置元数据（triggers/tags 为空）`)
    }
    entries.push(
      buildExpressionClipEntry(clip, {
        file: file.file,
        triggers: Array.isArray(config?.triggers) ? config.triggers : [],
        tags: Array.isArray(config?.tags) ? config.tags : [],
        priority: Number.isFinite(config?.priority) ? config.priority : 0,
        note: typeof config?.note === 'string' ? config.note : undefined
      })
    )
  }
  if (problems.length > 0) fail(`clip 数据不合格：\n  - ${problems.join('\n  - ')}`)

  const manifest = buildExpressionManifest(entries)
  if (check) {
    if (!fs.existsSync(outPath)) fail(`--check 失败：manifest 不存在（${toDisplayPath(outPath)}）`)
    const currentRaw = fs.readFileSync(outPath, 'utf8')
    let current
    try {
      current = JSON.parse(currentRaw)
    } catch (error) {
      fail(`--check 失败：现有 manifest JSON 解析失败（${error instanceof Error ? error.message : String(error)}）`)
    }
    if (comparableManifest(current) !== comparableManifest(manifest)) {
      fail(`--check 失败：manifest 与重新生成不一致（${toDisplayPath(outPath)}）`)
    }
    process.stdout.write(`[build-expression-manifest] CHECK OK：${entries.length} clip（${toDisplayPath(outPath)}）\n`)
    process.exit(0)
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  if (!quiet) {
    const bySet = {}
    for (const entry of entries) bySet[entry.set] = (bySet[entry.set] ?? 0) + 1
    process.stdout.write(`[build-expression-manifest] OK：${entries.length} clip → ${toDisplayPath(outPath)}（${JSON.stringify(bySet)}）\n`)
    for (const entry of entries) {
      process.stdout.write(`  - ${entry.file.padEnd(26)} triggers=[${entry.triggers.join(',')}] priority=${entry.priority}\n`)
    }
  }
  process.exit(0)
}

main()
