#!/usr/bin/env node
/**
 * V6 表情层：Mate-Engine 面部动画 → 表情 clip JSON（dev-only）
 *
 *   node scripts/vrm/expression/extract-mate-face.mjs \
 *     --anim-dir "refs/Mate-Engine/Assets/MATE ENGINE - Animations" \
 *     --config scripts/vrm/expression/config/mate-face.json \
 *     --out assets/expressions/mate [--check] [--json report.json]
 *
 * 输入私有（refs/Mate-Engine 本地克隆，不提交）；输出 `assets/expressions/mate/**`（gitignore）。
 * `--check` 只读：重新生成后与磁盘文件逐字节对比，任何差异 → exit 1（幂等护栏）。
 * `--json <path>` 写逐 clip 统计报告（source 时长/轨道/被丢弃 attribute）。
 *
 * 退出码：0 成功；1 生成/校验失败；2 非法参数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
import { validateExpressionClipData } from './lib/expression-clip.mjs'
import {
  extractMateFaceClipsBundle,
  readMateFaceConfig,
  validateMateFaceConfig
} from './lib/mate-face.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const OPTIONS = {
  'anim-dir': {
    type: 'string',
    default: 'refs/Mate-Engine/Assets/MATE ENGINE - Animations',
    valueHint: 'dir',
    description: 'Mate-Engine 动画目录（Unity .anim；私有 refs，只读）'
  },
  config: {
    type: 'string',
    default: 'scripts/vrm/expression/config/mate-face.json',
    valueHint: 'path',
    description: 'clip 配置（id/file/fps/loop/triggers/tags/priority/scale）'
  },
  out: {
    type: 'string',
    default: 'assets/expressions/mate',
    valueHint: 'dir',
    description: '输出目录（私有资产，gitignore）'
  },
  check: { type: 'boolean', default: false, description: '只读：重新生成后与磁盘对比，不一致 exit 1' },
  json: { type: 'string', default: '', valueHint: 'path', description: '写逐 clip 统计报告 JSON' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/expression/extract-mate-face.mjs',
  description: 'V6 表情层：把 Mate-Engine 的 Unity .anim face 曲线提取为 VRM1 preset 表情 clip JSON。',
  usage: 'node scripts/vrm/expression/extract-mate-face.mjs [--anim-dir <dir>] [--config <path>] [--out <dir>] [--check]',
  options: OPTIONS,
  footer: '输出：<out>/<clipId>.json（私有，gitignore）；`--check` 幂等对比。'
})

function fail(message, code = 1) {
  console.error(`[extract-mate-face] ERROR: ${message}`)
  process.exit(code)
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

/** 稳定序列化（2 空格缩进 + 末行换行；与 build 脚本一致）。 */
export function serializeClipFile(clip) {
  return JSON.stringify(clip, null, 2) + '\n'
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
  const animDir = path.resolve(ROOT, String(values['anim-dir']))
  const configPath = path.resolve(ROOT, String(values.config))
  const outDir = path.resolve(ROOT, String(values.out))
  const check = values.check === true

  if (!fs.existsSync(animDir)) fail(`anim-dir 不存在：${toDisplayPath(animDir)}`)
  if (!fs.existsSync(configPath)) fail(`config 不存在：${toDisplayPath(configPath)}`)

  let config
  try {
    config = readMateFaceConfig(configPath)
  } catch (error) {
    fail(`config JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const { errors: configErrors } = validateMateFaceConfig(config)
  if (configErrors.length > 0) fail(`config 非法：\n  - ${configErrors.join('\n  - ')}`)

  const { clips, reports, errors: extractErrors } = extractMateFaceClipsBundle({
    animDir,
    config,
    readFile: (filePath) => fs.readFileSync(filePath, 'utf8')
  })
  if (extractErrors.length > 0) fail(`提取失败：\n  - ${extractErrors.join('\n  - ')}`)

  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  const mismatches = []
  const validationErrors = []
  for (const { clip } of clips) {
    const target = path.join(outDir, `${clip.id}.json`)
    const serialized = serializeClipFile(clip)
    if (check) {
      if (!fs.existsSync(target)) {
        mismatches.push(`${clip.id}：缺少输出文件 ${toDisplayPath(target)}`)
      } else if (fs.readFileSync(target, 'utf8') !== serialized) {
        mismatches.push(`${clip.id}：输出与重新生成不一致`)
      }
    } else {
      fs.writeFileSync(target, serialized)
    }
    written.push({ id: clip.id, file: path.relative(outDir, target), frames: clip.frames, trackCount: Object.keys(clip.tracks).length })
    const validation = validateExpressionClipData(clip, { label: `mate/${clip.id}` })
    if (!validation.ok) validationErrors.push(...validation.errors)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    animDir: toDisplayPath(animDir),
    config: toDisplayPath(configPath),
    out: toDisplayPath(outDir),
    clips: written,
    stats: reports,
    ignored: {
      note: 'FACE_INTIME 与 FACE_DRAG 数值完全相同；FACE_SMILE 1 与 FACE_SMILE 完全相同；未重复导出。',
      duplicates: ['FACE_LAYER/FACE_INTIME.anim', 'PET_MISC/FACE_SMILE 1.anim']
    }
  }
  if (values.json) {
    const jsonPath = path.resolve(ROOT, String(values.json))
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n')
  }

  if (check) {
    if (mismatches.length > 0) fail(`--check 不一致：\n  - ${mismatches.join('\n  - ')}`)
    process.stdout.write(`[extract-mate-face] CHECK OK：${written.length} clip 与磁盘一致（${toDisplayPath(outDir)}）\n`)
  } else {
    process.stdout.write(`[extract-mate-face] OK：写出 ${written.length} clip → ${toDisplayPath(outDir)}\n`)
    for (const item of written) {
      process.stdout.write(`  - ${item.id.padEnd(14)} frames=${String(item.frames).padStart(4)} tracks=${item.trackCount}\n`)
    }
  }
  if (validationErrors.length > 0) fail(`生成数据自检失败：\n  - ${validationErrors.join('\n  - ')}`)
  process.exit(0)
}

main()
