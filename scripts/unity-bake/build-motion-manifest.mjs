#!/usr/bin/env node
/**
 * U2 motion manifest 构建 CLI（Wave 1.5 / U2）
 *
 *   node scripts/unity-bake/build-motion-manifest.mjs            # 构建并写盘
 *   node scripts/unity-bake/build-motion-manifest.mjs --check    # 只校验磁盘 manifest 与现状一致
 *
 * 输出（同内容，互为镜像）：
 * - `assets/motions/mate/manifest.json`（canonical，PLAN U3 路径）
 * - `assets/motions/manifest.json`（宽路径，满足 PLAN U3/U10 的 `assets/motions/manifest.json`）
 *
 * 行为：
 * - 读取 `--config`（默认 scripts/unity-bake/clips.json，B lane 维护的 selection）；
 * - 按 selection 的 clip name 读 `--clips-dir`（默认 assets/motions/mate）下 `<name>.json`；
 * - 交给 `lib/motion-manifest.mjs` 的 `buildMotionManifest` 校验/构建；
 * - 构建：有 error → 打印后 exit 1（不写盘）；否则写两个 manifest 路径；
 * - `--check`：不写盘，校验磁盘上两个 manifest 是否与当前 selection/clip 数据一致 → exit 1 = 不一致。
 * - `--help`；非法参数 exit 2。
 *
 * 资产是私有的（.gitignore），本 CLI 不 git add/commit。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'
import {
  buildMotionManifest,
  validateManifestAgainstSelection
} from './lib/motion-manifest.mjs'

const DEFAULTS = {
  config: 'scripts/unity-bake/clips.json',
  clipsDir: 'assets/motions/mate',
  out: 'assets/motions/mate/manifest.json',
  mirror: 'assets/motions/manifest.json'
}

const OPTIONS = {
  config: {
    type: 'string',
    default: DEFAULTS.config,
    valueHint: 'path',
    description: 'selection 配置'
  },
  'clips-dir': {
    type: 'string',
    default: DEFAULTS.clipsDir,
    valueHint: 'dir',
    description: 'clip JSON 目录'
  },
  out: {
    type: 'string',
    default: DEFAULTS.out,
    valueHint: 'path',
    description: 'canonical manifest 输出'
  },
  mirror: {
    type: 'string',
    default: DEFAULTS.mirror,
    valueHint: 'path',
    description: '镜像 manifest 输出'
  },
  check: {
    type: 'boolean',
    default: false,
    description: '只校验磁盘 manifest 与当前 selection/clips 一致（不写盘）'
  }
}

const HELP = formatHelp({
  command: 'node scripts/unity-bake/build-motion-manifest.mjs',
  description:
    'U2：由 clips.json selection + assets/motions/mate/*.json 生成/校验 motion manifest。',
  usage:
    'node scripts/unity-bake/build-motion-manifest.mjs [--config <path>] [--clips-dir <dir>] ' +
    '[--out <path>] [--mirror <path>] [--check]',
  options: OPTIONS,
  footer:
    '退出码：0 = 成功/一致；1 = 构建错误或 --check 不一致；2 = 参数错误。\n' +
    '构建成功时写 canonical 与镜像两份同内容 manifest（私有资产，不提交）。'
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message) {
  console.error(`[manifest] ${message}`)
  process.exit(1)
}

function readSelection(configPath) {
  if (!fs.existsSync(configPath)) fail(`selection 配置不存在：${configPath}`)
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    fail(
      `selection 配置解析失败（${configPath}）：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** 按 selection 的 clip name 读取 clip 数据；读不到的交给 builder 报错。 */
function loadClips(selection, clipsDir) {
  const clips = {}
  const problems = []
  const entries =
    selection && typeof selection === 'object' && Array.isArray(selection.clips)
      ? selection.clips
      : []
  if (!fs.existsSync(clipsDir) || !fs.statSync(clipsDir).isDirectory()) {
    fail(`clip 目录不存在：${clipsDir}`)
  }
  for (const entry of entries) {
    const name = entry && typeof entry.name === 'string' ? entry.name : null
    if (name === null) continue
    const file = path.join(clipsDir, `${name}.json`)
    if (!fs.existsSync(file)) continue
    try {
      clips[name] = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(
        `clip "${name}" JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { clips, problems }
}

function readDiskManifest(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { path: targetPath, manifest: null, error: `manifest 不存在：${toDisplayPath(targetPath)}` }
  }
  try {
    return {
      path: targetPath,
      manifest: JSON.parse(fs.readFileSync(targetPath, 'utf8')),
      error: null
    }
  } catch (error) {
    return {
      path: targetPath,
      manifest: null,
      error: `manifest JSON 解析失败（${toDisplayPath(targetPath)}）：${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

function printCoverage(coverage, selection) {
  const requirements =
    selection && typeof selection === 'object' && selection.requirements
      ? selection.requirements
      : {}
  for (const [tag, count] of Object.entries(coverage)) {
    const required = requirements[tag]
    console.log(
      `[manifest] coverage ${tag.padEnd(12)} ${String(count).padStart(2)}` +
        (typeof required === 'number' ? ` / 下限 ${required}` : '')
    )
  }
}

function runCheck({ selection, clips, outPath, mirrorPath }) {
  const errors = []
  const warnings = []
  const outDisk = readDiskManifest(outPath)
  const mirrorDisk = readDiskManifest(mirrorPath)
  for (const disk of [outDisk, mirrorDisk]) {
    if (disk.error) {
      errors.push(disk.error)
      continue
    }
    const result = validateManifestAgainstSelection(disk.manifest, selection, clips)
    for (const message of result.errors) errors.push(`${toDisplayPath(disk.path)}: ${message}`)
    warnings.push(...result.warnings)
  }
  if (outDisk.manifest !== null && mirrorDisk.manifest !== null) {
    if (JSON.stringify(outDisk.manifest) !== JSON.stringify(mirrorDisk.manifest)) {
      errors.push('canonical manifest 与镜像 manifest 内容不一致（需重新构建）')
    }
  }

  if (errors.length > 0) {
    console.error(`[manifest] --check FAIL：${errors.length} 个错误`)
    for (const message of errors) console.error(`  ✗ ${message}`)
    process.exit(1)
  }
  console.log(
    `[manifest] --check PASS：${outDisk.manifest.clips.length} clips 与 selection/clip 数据一致` +
      `（canonical=${toDisplayPath(outPath)}, mirror=${toDisplayPath(mirrorPath)}）`
  )
  if (warnings.length > 0) {
    for (const message of warnings) console.log(`  ! ${message}`)
  }
  process.exit(0)
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    process.exit(0)
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[manifest] 参数错误：${error}`)
    console.error(HELP)
    process.exit(2)
  }

  const configPath = path.resolve(String(values.config))
  const clipsDir = path.resolve(String(values['clips-dir']))
  const outPath = path.resolve(String(values.out))
  const mirrorPath = path.resolve(String(values.mirror))
  const check = values.check === true

  const selection = readSelection(configPath)
  const { clips, problems } = loadClips(selection, clipsDir)
  const generatedAt = new Date().toISOString()
  const built = buildMotionManifest({ selection, clips, generatedAt })
  const extraErrors = problems
  const errorsAll = [...extraErrors, ...built.errors]

  if (check) {
    if (errorsAll.length > 0) {
      console.error(`[manifest] --check FAIL：selection/clip 数据自身有 ${errorsAll.length} 个错误`)
      for (const message of errorsAll) console.error(`  ✗ ${message}`)
      process.exit(1)
    }
    runCheck({ selection, clips, outPath, mirrorPath })
    return
  }

  printCoverage(built.coverage, selection)
  if (built.warnings.length > 0) {
    console.log(`[manifest] warnings ${built.warnings.length}：`)
    for (const message of built.warnings) console.log(`  ! ${message}`)
  }
  if (errorsAll.length > 0) {
    console.error(`[manifest] FAIL：${errorsAll.length} 个错误（不写盘）`)
    for (const message of errorsAll) console.error(`  ✗ ${message}`)
    process.exit(1)
  }

  const manifest = built.manifest
  const text = JSON.stringify(manifest, null, 2) + '\n'
  for (const target of [outPath, mirrorPath]) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
  console.log(`[manifest] OK：${manifest.clips.length} clips，coverage 达标`)
  console.log(`[manifest] 写入：${toDisplayPath(outPath)}`)
  console.log(`[manifest] 写入：${toDisplayPath(mirrorPath)}`)
  process.exit(0)
}

main()
