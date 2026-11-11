#!/usr/bin/env node
/**
 * V3：HSR clip 数据 QA（结构 + 指标 + PASS/WARN/FAIL），并可选跑 Wave 1.5 的
 * `clip-validation.mjs`（22 骨校验）做双保险。
 *
 * 用法：
 *   node scripts/vrm/motion/validate-hsr-clips.mjs --dir assets/motions/hsr \
 *     --json tests/tmp/hsr-motion/validation-report.json [--unity-validator]
 *
 * 退出码：0 = 无 FAIL（可有 WARN）；1 = 有 FAIL；2 = 参数错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
// @ts-expect-error -- U-lane 纯 ESM 无声明；双保险校验用
import { validateClipData } from '../../unity-bake/lib/clip-validation.mjs'
import { resolveVrmAsset, parseGlbJson, buildVrmRest, springBoneInfo } from './lib/vrm-rest.mjs'
import { gradeClip, formatResults } from './lib/qa.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULTS = {
  dir: 'assets/motions/hsr',
  json: 'tests/tmp/hsr-motion/validation-report.json',
  'vrm-manifest': 'src/shared/vrm-manifest.json',
  'vrm-asset-id': 'aventurine-waveflair'
}
const OPTIONS = {
  dir: { type: 'string', default: DEFAULTS.dir, valueHint: 'dir', description: 'clip JSON 目录' },
  json: { type: 'string', default: DEFAULTS.json, valueHint: 'path', description: 'JSON 报告输出' },
  'vrm-manifest': { type: 'string', default: DEFAULTS['vrm-manifest'], valueHint: 'path', description: 'vrm-manifest.json' },
  'vrm-asset-id': { type: 'string', default: DEFAULTS['vrm-asset-id'], valueHint: 'id', description: '目标 VRM avatar id' },
  'unity-validator': { type: 'boolean', default: true, description: '同时跑 U-lane 的 22 骨校验（默认开）' }
}
const HELP = formatHelp({
  command: 'node scripts/vrm/motion/validate-hsr-clips.mjs',
  description: 'V3：校验 HSR clip 结构/指标/贴地/次级骨，输出 PASS/WARN/FAIL 报告。',
  usage: 'node scripts/vrm/motion/validate-hsr-clips.mjs [--dir <dir>] [--json <path>]',
  options: OPTIONS,
  footer: 'FAIL 会以 exit 1 结束；报告默认 tests/tmp/hsr-motion/validation-report.json。'
})

function fail(message, code = 1) {
  console.error(`[validate-hsr] ERROR: ${message}`)
  process.exit(code)
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    return
  }
  for (const error of errors) console.error(`[validate-hsr] ${error}`)
  if (errors.length > 0) process.exit(2)

  const clipsDir = path.resolve(String(values.dir))
  if (!fs.existsSync(clipsDir)) fail(`目录不存在：${clipsDir}`)
  const vrm = resolveVrmAsset(
    path.resolve(String(values['vrm-manifest'])),
    path.join(ROOT, 'assets'),
    String(values['vrm-asset-id'])
  )
  const { json } = parseGlbJson(vrm.file)
  const vrmRest = buildVrmRest(json)
  const spring = springBoneInfo(json)

  const files = fs
    .readdirSync(clipsDir)
    .filter((file) => file.endsWith('.json') && file !== 'manifest.json' && file !== 'index.json')
    .sort()
  const results = []
  let unityErrors = 0
  let unityWarns = 0
  for (const file of files) {
    const clip = JSON.parse(fs.readFileSync(path.join(clipsDir, file), 'utf8'))
    const result = gradeClip(clip, vrmRest)
    let unity = null
    if (values['unity-validator'] !== false) {
      // `hipsBase:'rest'` 的 clip（跪/趴/起身/受击）首帧 Hips.p 本来就是「绝对髋高偏移」，
      // 不适用 Wave 1.5 的「首帧归零」契约；放宽到 1m（跪姿 ~0.5m）以做量级兜底。
      unity = validateClipData(
        clip,
        clip.hipsBase === 'rest' ? { limits: { hipsFirstFrameToleranceMeters: 1.0 } } : undefined
      )
      unityErrors += unity.errors.length
      unityWarns += unity.warnings.length
    }
    results.push({ clip: file.replace(/\.json$/, ''), ...result, unity })
  }

  const report = {
    generatedAt: new Date().toISOString(),
    target: {
      avatarId: vrm.avatarId,
      file: path.relative(process.cwd(), vrm.file),
      yawOffsetDeg: vrm.manifest?.yawOffsetDeg ?? null,
      heightMeters: vrm.heightMeters ?? null,
      humanoidBones: Object.keys(vrmRest.humanoid).length,
      upperChestFallback: !vrmRest.humanoid.upperChest,
      spring
    },
    limits: undefined,
    summary: {
      total: results.length,
      pass: results.filter((item) => item.status === 'PASS').length,
      warn: results.filter((item) => item.status === 'WARN').length,
      fail: results.filter((item) => item.status === 'FAIL').length,
      unityValidator: { errors: unityErrors, warnings: unityWarns }
    },
    clips: results.map((item) => ({
      clip: item.clip,
      status: item.status,
      errors: item.errors,
      warnings: item.warnings,
      validation: item.validation,
      metrics: item.metrics,
      unity: item.unity
    }))
  }
  const jsonPath = path.resolve(String(values.json))
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1))

  console.log(formatResults(results))
  console.log(
    `[validate-hsr] target=${path.basename(vrm.file)} yaw=${vrm.manifest?.yawOffsetDeg ?? 0} spring=${spring.chains}链 humanoid=${Object.keys(vrmRest.humanoid).length}`
  )
  console.log(
    `[validate-hsr] ${results.length} clip: PASS ${report.summary.pass} / WARN ${report.summary.warn} / FAIL ${report.summary.fail}` +
      (values['unity-validator'] !== false ? `（U-lane validator: ${unityErrors} errors / ${unityWarns} warnings；额外手指骨会产生 warning）` : '')
  )
  console.log(`[validate-hsr] 报告：${path.relative(process.cwd(), jsonPath)}`)
  if (report.summary.fail > 0) process.exit(1)
}

main()
