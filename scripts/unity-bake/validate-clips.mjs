#!/usr/bin/env node
/**
 * U2 clip 数据校验 CLI（Wave 1.5 / U2）
 *
 *   node scripts/unity-bake/validate-clips.mjs [--dir assets/motions/mate]
 *        [--config scripts/unity-bake/clips.json] [--json assets/motions/validation-report.json]
 *
 * 行为：
 * - 扫描 `--dir` 下所有 `*.json`（跳过 index.json / manifest.json / 非 clip 形状的 JSON），
 *   逐个跑 `lib/clip-validation.mjs` 的 `validateClipData`；
 * - 打印 PASS/WARN/FAIL 表（含帧数/时长/最大帧跳变/Hips 位移等关键指标）；
 * - 写 JSON 报告（默认 `assets/motions/validation-report.json`，私有资产，gitignore）；
 * - 任一条有 error → exit 1；只有 warning → exit 0。
 * - `--config` 存在时额外交叉检查 selection 与磁盘 clip 的登记关系（缺失/多余 = warning）。
 *
 * 本 CLI 只读 clip 数据、只写报告 JSON；不碰 Unity/私有 VRM/网络。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'
import { validateClipData } from './lib/clip-validation.mjs'
import { CLIP_OPTIONAL_BONES } from './lib/humanoid-map.mjs'

const DEFAULTS = {
  dir: 'assets/motions/mate',
  config: 'scripts/unity-bake/clips.json',
  json: 'assets/motions/validation-report.json'
}

const OPTIONS = {
  dir: {
    type: 'string',
    default: DEFAULTS.dir,
    valueHint: 'dir',
    description: 'clip JSON 目录'
  },
  config: {
    type: 'string',
    default: DEFAULTS.config,
    valueHint: 'path',
    description: 'selection 配置；不存在时只警告'
  },
  json: {
    type: 'string',
    default: DEFAULTS.json,
    valueHint: 'path',
    description: '校验报告输出路径'
  }
}

const HELP = formatHelp({
  command: 'node scripts/unity-bake/validate-clips.mjs',
  description:
    'U2：校验 assets/motions/<set>/*.json clip 数据的结构/四元数/连续性/Hips 位移/循环接缝。',
  usage: 'node scripts/unity-bake/validate-clips.mjs [--dir <dir>] [--config <path>] [--json <path>]',
  options: OPTIONS,
  footer: '退出码：0 = 无 error（可有 warning）；1 = 有 error 或运行失败。'
})

/** 已知不是 clip 的 JSON 文件名。 */
const NON_CLIP_FILES = new Set(['index.json', 'manifest.json', 'validation-report.json'])

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message) {
  console.error(`[validate-clips] ${message}`)
  process.exit(1)
}

function readSelection(configPath, explicit) {
  if (!fs.existsSync(configPath)) {
    if (explicit) fail(`selection 配置不存在：${configPath}`)
    console.warn(`[validate-clips] 警告：selection 配置不存在，跳过交叉检查：${configPath}`)
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    fail(`selection 配置解析失败（${configPath}）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function selectionNames(selection) {
  if (!selection || typeof selection !== 'object' || !Array.isArray(selection.clips)) return []
  return selection.clips
    .map((entry) => (entry && typeof entry.name === 'string' ? entry.name : null))
    .filter((name) => name !== null)
}

function formatMetrics(result) {
  const stats = result.stats
  const parts = []
  const frames = typeof stats.frames === 'number' ? stats.frames : '?'
  const duration = typeof stats.duration === 'number' ? `${stats.duration.toFixed(2)}s` : '?s'
  parts.push(`frames=${frames}`, duration)
  if (typeof stats.maxFrameJumpDeg === 'number') {
    parts.push(`maxJump=${stats.maxFrameJumpDeg.toFixed(1)}°`)
  }
  if (typeof stats.hipsTravel === 'number') {
    parts.push(`hipsTravel=${stats.hipsTravel.toFixed(2)}m`)
  }
  if (typeof stats.loopSeamMaxAngleDeg === 'number') {
    parts.push(`loopSeam=${stats.loopSeamMaxAngleDeg.toFixed(2)}°`)
  }
  parts.push(`warn=${result.warnings.length}`)
  return parts.join('  ')
}

function main() {
  const { values, errors, sawHelp, provided } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[validate-clips] 参数错误：${error}`)
    console.error(HELP)
    process.exit(2)
  }

  const dir = path.resolve(String(values.dir))
  const configPath = path.resolve(String(values.config))
  const jsonPath = path.resolve(String(values.json))
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`clip 目录不存在：${dir}`)
  }

  const selection = readSelection(configPath, provided.has('config'))
  const selected = new Set(selectionNames(selection))
  const jsonExclude = path.relative(dir, jsonPath)

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .filter((file) => !NON_CLIP_FILES.has(file))
    .filter((file) => file !== jsonExclude)
    .sort()

  if (files.length === 0) fail(`目录里没有 clip JSON：${dir}`)

  const results = []
  const skipped = []
  for (const file of files) {
    const fullPath = path.join(dir, file)
    const name = file.slice(0, -'.json'.length)
    let clip
    try {
      clip = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    } catch (error) {
      results.push({
        name,
        file: toDisplayPath(fullPath),
        ok: false,
        errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
        stats: {}
      })
      continue
    }
    if (
      !clip ||
      typeof clip !== 'object' ||
      Array.isArray(clip) ||
      typeof clip.bones !== 'object' ||
      clip.bones === null
    ) {
      skipped.push({ file, reason: '不是 clip 数据（无 bones 对象）' })
      continue
    }
    const result = validateClipData(clip, { optionalBones: CLIP_OPTIONAL_BONES })
    results.push({
      name,
      file: toDisplayPath(fullPath),
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      stats: result.stats
    })
  }

  // ---------- 打印 PASS/WARN/FAIL 表 ----------
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length), ...skipped.map((s) => s.file.length))
  let pass = 0
  let warn = 0
  let failCount = 0
  for (const result of results) {
    const status = !result.ok ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS'
    if (status === 'PASS') pass += 1
    else if (status === 'WARN') warn += 1
    else failCount += 1
    const metrics = formatMetrics(result)
    console.log(`[${status}] ${result.name.padEnd(nameWidth)}  ${metrics}`)
    for (const error of result.errors) console.log(`         ✗ ${error}`)
    for (const warning of result.warnings) console.log(`         ! ${warning}`)
  }
  for (const entry of skipped) {
    console.log(`[SKIP] ${entry.file.padEnd(nameWidth)}  ${entry.reason}`)
  }

  // ---------- selection 交叉检查 ----------
  const crossCheck = []
  if (selection !== null) {
    const diskNames = new Set(results.map((r) => r.name))
    for (const name of selected) {
      if (!diskNames.has(name)) crossCheck.push(`selection 中的 clip "${name}" 在目录中不存在`)
    }
    for (const name of diskNames) {
      if (!selected.has(name)) crossCheck.push(`目录中的 clip "${name}" 未在 selection 中登记`)
    }
  }

  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0)
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0)
  console.log('')
  console.log(
    `[validate-clips] ${results.length} clip: PASS ${pass} / WARN ${warn} / FAIL ${failCount}` +
      `（errors ${totalErrors}, warnings ${totalWarnings}, skipped ${skipped.length}）`
  )
  for (const message of crossCheck) console.log(`         ! ${message}`)

  // ---------- 写报告 ----------
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    dir: toDisplayPath(dir),
    config: fs.existsSync(configPath) ? toDisplayPath(configPath) : null,
    summary: {
      total: results.length,
      pass,
      warn,
      fail: failCount,
      errors: totalErrors,
      warnings: totalWarnings,
      skipped: skipped.length,
      ok: failCount === 0
    },
    crossCheck,
    clips: results,
    skipped
  }
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`[validate-clips] 报告已写入：${toDisplayPath(jsonPath)}`)

  process.exit(failCount > 0 ? 1 : 0)
}

main()
