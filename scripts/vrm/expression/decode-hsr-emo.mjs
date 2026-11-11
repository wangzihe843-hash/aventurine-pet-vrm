#!/usr/bin/env node
/**
 * V6 表情层：HSR Emo_ 脸骨动画 → VRM1 preset 表情 clip（dev-only）
 *
 *   node scripts/vrm/expression/decode-hsr-emo.mjs \
 *     --samples assets/expressions/_samples/emo-face-samples.json \
 *     --config scripts/vrm/expression/config/hsr-emo.json \
 *     --out assets/expressions/hsr [--vrm assets/vrm/aventurine-tpose.vrm] [--check] [--json report.json]
 *
 * 输入私有（HSR 官方 FBX 采样，gitignore）；输出 `assets/expressions/hsr/**`（gitignore）。
 * `--check` 只读：重新生成后与磁盘文件逐字节对比，不一致 → exit 1（幂等护栏）。
 *
 * 退出码：0 成功；1 生成/校验失败；2 非法参数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatHelp, parseCliArgs } from '../../unity-bake/lib/cli-args.mjs'
import { validateExpressionClipData } from './lib/expression-clip.mjs'
import { decodeHsrSamples, validateHsrEmoConfig } from './lib/hsr-face.mjs'
import { readVrmExpressionInventory } from './lib/vrm-expressions.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const OPTIONS = {
  samples: {
    type: 'string',
    default: 'assets/expressions/_samples/emo-face-samples.json',
    valueHint: 'path',
    description: 'sample-hsr-emo.py 产出的脸骨采样 JSON（私有）'
  },
  config: {
    type: 'string',
    default: 'scripts/vrm/expression/config/hsr-emo.json',
    valueHint: 'path',
    description: '解码配置（层/校准基/preset 规则/导出 clip 清单）'
  },
  out: {
    type: 'string',
    default: 'assets/expressions/hsr',
    valueHint: 'dir',
    description: '输出目录（私有资产，gitignore）'
  },
  vrm: {
    type: 'string',
    default: 'assets/vrm/aventurine-tpose.vrm',
    valueHint: 'path',
    description: '目标 VRM（校验轨道名真实存在；缺省跳过）'
  },
  json: { type: 'string', default: '', valueHint: 'path', description: '写逐 clip 解码报告 JSON' },
  check: { type: 'boolean', default: false, description: '只读：重新生成后与磁盘对比，不一致 exit 1' },
  quiet: { type: 'boolean', default: false, description: '只打印汇总行' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/expression/decode-hsr-emo.mjs',
  description: 'V6 表情层：HSR Emo_ 脸骨动画解码为 VRM1 preset 表情 clip（OMP+NNLS → preset 权重）。',
  usage: 'node scripts/vrm/expression/decode-hsr-emo.mjs [--samples <path>] [--config <path>] [--out <dir>] [--vrm <path>] [--check]',
  options: OPTIONS,
  footer: '输出：<out>/<clipId>.json（私有，gitignore）；`--check` 幂等对比。'
})

function fail(message, code = 1) {
  console.error(`[decode-hsr-emo] ERROR: ${message}`)
  process.exit(code)
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function serializeClipFile(clip) {
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
  const samplesPath = path.resolve(ROOT, String(values.samples))
  const configPath = path.resolve(ROOT, String(values.config))
  const outDir = path.resolve(ROOT, String(values.out))
  const check = values.check === true
  const quiet = values.quiet === true
  if (!fs.existsSync(samplesPath)) fail(`采样文件不存在：${toDisplayPath(samplesPath)}（先跑 sample-hsr-emo.py）`)
  if (!fs.existsSync(configPath)) fail(`配置不存在：${toDisplayPath(configPath)}`)

  let samples
  let config
  try {
    samples = JSON.parse(fs.readFileSync(samplesPath, 'utf8'))
  } catch (error) {
    fail(`采样 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    fail(`配置 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const configCheck = validateHsrEmoConfig(config)
  if (configCheck.errors.length > 0) fail(`配置非法：\n  - ${configCheck.errors.join('\n  - ')}`)

  let knownExpressionNames
  let vrmInventory = null
  if (values.vrm) {
    const vrmPath = path.resolve(ROOT, String(values.vrm))
    if (fs.existsSync(vrmPath)) {
      vrmInventory = readVrmExpressionInventory(vrmPath)
      knownExpressionNames = vrmInventory.all
      if (!vrmInventory.hasExpressionManager) fail(`目标 VRM 没有可用 expression：${toDisplayPath(vrmPath)}`)
    } else {
      console.error(`[decode-hsr-emo] WARN：目标 VRM 不存在，跳过轨道名校验（${toDisplayPath(vrmPath)}）`)
    }
  }

  const { clips, reports, errors: decodeErrors } = decodeHsrSamples(samples, config)
  if (decodeErrors.length > 0) fail(`解码失败：\n  - ${decodeErrors.join('\n  - ')}`)
  if (clips.length === 0) fail('没有解码出任何 clip（检查 config.clips）')

  const validationErrors = []
  for (const { clip } of clips) {
    const validation = validateExpressionClipData(clip, {
      label: `hsr/${clip.id}`,
      knownExpressionNames: knownExpressionNames ?? undefined
    })
    if (!validation.ok) validationErrors.push(...validation.errors)
  }
  if (validationErrors.length > 0) fail(`生成数据自检失败：\n  - ${validationErrors.join('\n  - ')}`)

  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  const mismatches = []
  for (const { clip } of clips) {
    const target = path.join(outDir, `${clip.id}.json`)
    const serialized = serializeClipFile(clip)
    if (check) {
      if (!fs.existsSync(target)) mismatches.push(`${clip.id}：缺少输出文件 ${toDisplayPath(target)}`)
      else if (fs.readFileSync(target, 'utf8') !== serialized) mismatches.push(`${clip.id}：输出与重新生成不一致`)
    } else {
      fs.writeFileSync(target, serialized)
    }
    written.push({
      id: clip.id,
      file: path.relative(outDir, target),
      frames: clip.frames,
      duration: clip.duration,
      loop: clip.loop,
      trackCount: Object.keys(clip.tracks).length
    })
  }

  if (values.json) {
    const jsonPath = path.resolve(ROOT, String(values.json))
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          samples: toDisplayPath(samplesPath),
          config: toDisplayPath(configPath),
          out: toDisplayPath(outDir),
          vrm: values.vrm ? toDisplayPath(path.resolve(ROOT, String(values.vrm))) : null,
          clips: written,
          reports
        },
        null,
        2
      ) + '\n'
    )
  }

  if (check) {
    if (mismatches.length > 0) fail(`--check 不一致：\n  - ${mismatches.join('\n  - ')}`)
    process.stdout.write(`[decode-hsr-emo] CHECK OK：${written.length} clip 与磁盘一致（${toDisplayPath(outDir)}）\n`)
  } else {
    process.stdout.write(`[decode-hsr-emo] OK：写出 ${written.length} clip → ${toDisplayPath(outDir)}\n`)
    if (!quiet) {
      for (const item of written) {
        process.stdout.write(
          `  - ${item.id.padEnd(16)} frames=${String(item.frames).padStart(4)} dur=${item.duration.toFixed(3)}s loop=${item.loop ? 'Y' : 'N'} tracks=${item.trackCount}\n`
        )
      }
      if (vrmInventory) {
        process.stdout.write(
          `  target "${path.basename(String(values.vrm))}" presets=${vrmInventory.presets.length} customs=${vrmInventory.customs.length}\n`
        )
      }
    }
  }
  process.exit(0)
}

main()
