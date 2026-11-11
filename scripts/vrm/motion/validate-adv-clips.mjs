#!/usr/bin/env node
/**
 * V3.2 adv：Biped 动作集 clip 数据 QA（结构 + 指标 + PASS/WARN/FAIL），并可选跑 Wave 1.5 的
 * `clip-validation.mjs`（22 骨校验）做双保险。
 *
 * 由 `validate-hsr-clips.mjs` 泛化而来，**只改默认路径/文案与动作集标识**；
 * 校验逻辑全部复用 `lib/qa.mjs#gradeClip`（该模块与动作集无关：22 核心骨 + 30 手指 + raw +
 * grounding + 循环接缝 + 帧跳变，契约来自 `src/shared/animation-contract.ts`）。
 *
 * 用法：
 *   node scripts/vrm/motion/validate-adv-clips.mjs --dir assets/motions/adv \
 *     --json tests/tmp/adv-motion/validation-report.json [--unity-validator false]
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
const SET = 'adv'
const DEFAULTS = {
  dir: `assets/motions/${SET}`,
  json: `tests/tmp/${SET}-motion/validation-report.json`,
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
  command: 'node scripts/vrm/motion/validate-adv-clips.mjs',
  description: 'V3.2：校验 adv（3ds Max Biped）clip 结构/指标/贴地/次级骨，输出 PASS/WARN/FAIL 报告。',
  usage: 'node scripts/vrm/motion/validate-adv-clips.mjs [--dir <dir>] [--json <path>] [--unity-validator=false]',
  options: OPTIONS,
  footer: `FAIL 会以 exit 1 结束；报告默认 ${DEFAULTS.json}。--unity-validator=false 可跳过 U-lane 22 骨校验。`
})

function fail(message, code = 1) {
  console.error(`[validate-adv] ERROR: ${message}`)
  process.exit(code)
}

// ---- loop clip 的循环接缝口径修正（v3 pilot G3，docs/pilot-v3-comparison-2026-11-09 §6）----
// loop clip 不存重复末帧，loopSeam 天然 ≈ 1 帧步进；旧口径按绝对 2°/6° 判会把
// 「seam 小于同 clip 自身帧间跳变」的正常循环误报 WARN（walk: seam 5.7° vs maxJump 9.5°）。
// 新判据（仅 loop clip，不修改共享 lib/qa.mjs 以保持 HSR 行为不变）：
//   seam ≤ max(2°, 1.2 × 该 clip 自身 maxFrameJump) 视为正常（撤销旧口径的接缝告警/错误）；
//   超过该阈值时仍按旧绝对档位报 WARN(>2°)/FAIL(>6°)，避免真正的循环断裂被放过。
const LOOP_SEAM_ABS_WARN_DEG = 2
const LOOP_SEAM_ABS_FAIL_DEG = 6
const LOOP_SEAM_JUMP_FACTOR = 1.2

function isSeamMessage(message) {
  return String(message).startsWith('循环接缝')
}

function applyLoopSeamCriterion(result, clip) {
  const metrics = result?.metrics
  if (!metrics || metrics.loopSeamDeg === null || metrics.loopSeamDeg === undefined) return result
  if (!clip || clip.loop !== true) return result
  const jump = Number(metrics.maxFrameJumpDeg) || 0
  const thresholdDeg = Math.max(LOOP_SEAM_ABS_WARN_DEG, LOOP_SEAM_JUMP_FACTOR * jump)
  const seam = Number(metrics.loopSeamDeg)
  const withinTolerance = seam <= thresholdDeg + 1e-9
  if (withinTolerance) {
    result.errors = result.errors.filter((message) => !isSeamMessage(message))
    result.warnings = result.warnings.filter((message) => !isSeamMessage(message))
    result.status = result.errors.length > 0 ? 'FAIL' : result.warnings.length > 0 ? 'WARN' : 'PASS'
  }
  result.loopSeam = {
    criterion: 'loopSeam <= max(2, 1.2*maxFrameJump)',
    thresholdDeg: Number(thresholdDeg.toFixed(2)),
    absoluteWarnDeg: LOOP_SEAM_ABS_WARN_DEG,
    absoluteFailDeg: LOOP_SEAM_ABS_FAIL_DEG,
    withinTolerance,
    suppressed: withinTolerance && seam > LOOP_SEAM_ABS_WARN_DEG
  }
  return result
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    return
  }
  for (const error of errors) console.error(`[validate-adv] ${error}`)
  if (errors.length > 0) process.exit(2)

  const clipsDir = path.resolve(String(values.dir))
  if (!fs.existsSync(clipsDir)) fail(`目录不存在：${clipsDir}（先跑 retarget-adv.mjs）`)
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
  if (files.length === 0) fail(`目录内没有 clip JSON：${clipsDir}`)
  const results = []
  let unityErrors = 0
  let unityWarns = 0
  for (const file of files) {
    const clip = JSON.parse(fs.readFileSync(path.join(clipsDir, file), 'utf8'))
    const result = gradeClip(clip, vrmRest)
    applyLoopSeamCriterion(result, clip)
    let unity = null
    if (values['unity-validator'] !== false) {
      unity = validateClipData(clip)
      unityErrors += unity.errors.length
      unityWarns += unity.warnings.length
    }
    results.push({ clip: file.replace(/\.json$/, ''), ...result, unity })
  }

  const report = {
    generatedAt: new Date().toISOString(),
    set: SET,
    dir: path.relative(process.cwd(), clipsDir),
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
      loopSeam: item.loopSeam ?? null,
      unity: item.unity
    }))
  }
  const jsonPath = path.resolve(String(values.json))
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 1))

  console.log(formatResults(results))
  console.log(
    `[validate-adv] set=${SET} target=${path.basename(vrm.file)} yaw=${vrm.manifest?.yawOffsetDeg ?? 0}` +
      ` spring=${spring.chains}链 humanoid=${Object.keys(vrmRest.humanoid).length}`
  )
  console.log(
    `[validate-adv] ${results.length} clip: PASS ${report.summary.pass} / WARN ${report.summary.warn} / FAIL ${report.summary.fail}` +
      (values['unity-validator'] !== false
        ? `（U-lane validator: ${unityErrors} errors / ${unityWarns} warnings；额外手指骨会产生 warning）`
        : '（U-lane validator: 已跳过）')
  )
  console.log(`[validate-adv] 报告：${path.relative(process.cwd(), jsonPath)}`)
  if (report.summary.fail > 0) process.exit(1)
}

main()
