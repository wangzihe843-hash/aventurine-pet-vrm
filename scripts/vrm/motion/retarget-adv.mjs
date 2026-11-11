#!/usr/bin/env node
/**
 * V3.1：3ds Max Biped 官方动作 → VRM clip 数据（可插拔 source 的 Biped 实例）。
 *
 * 与 `retarget-hsr.mjs` 相同的编排/输出契约（22 核心骨 + 30 手指 + Hips.p + grounding），
 * 区别只在 **source 描述符**：
 * - 源 = `extract-biped-anims.py` 采样的 `tests/tmp/adv-motion/samples.json`（Biped 骨名
 *   `Bip001 Pelvis/Spine/.../L Finger0..4`，schema 与 HSR samples.json 完全一致）；
 * - 映射/参考骨/解剖链由 `lib/humanoid-biped.mjs#createBipedSource` 提供（target-aware：
 *   目标无 upperChest 时 spine←Spine、chest←Spine2，Spine1 并入 chest 的世界旋转）；
 * - 重定向数学（world-delta / R_align / rest-direction-fix / effectiveParent 归一化 /
 *   in-place / grounding）全部复用 `lib/retarget.mjs`，不重复实现。
 *
 * 输入：
 * - `tests/tmp/adv-motion/samples.json`（task-5 采样器产出，私有临时）
 * - `scripts/vrm/motion/clips.adv.json`（clip registry：take→id/slot/loop/grounding/priority）
 * - 目标 VRM：默认从 `src/shared/vrm-manifest.json` 取 `aventurine-waveflair`
 *   （= `assets/vrm/aventurine-tpose.vrm`，规范 T-pose、面向 +Z、53 humanoid 骨、无 upperChest、
 *   SpringBone 50 链；与 HSR 管线同一目标）。
 *
 * 输出（私有资产，gitignore）：
 * - `assets/motions/adv/<id>.json`（clip 数据；raw 留空 rawPolicy=spring 由 three-vrm 物理驱动）
 * - `tests/tmp/adv-motion/retarget-report.json`（逐 clip 报告 + 数据门禁分级）
 * - `tests/tmp/adv-motion/mapping-report.json`（Biped→VRM 映射表 + rest 方向差 + 指链赋值打分）
 *
 * 用法：
 *   node scripts/vrm/motion/retarget-adv.mjs \
 *     --samples tests/tmp/adv-motion/samples.json \
 *     --out assets/motions/adv \
 *     --report-dir tests/tmp/adv-motion
 *
 * 合成数据端到端（真实 FBX 未到时可跑）：
 *   node work/adv-biped/retarget/make-synthetic-samples.mjs \
 *     --out tests/tmp/adv-motion/synthetic/samples.json
 *   node scripts/vrm/motion/retarget-adv.mjs \
 *     --samples tests/tmp/adv-motion/synthetic/samples.json \
 *     --out tests/tmp/adv-motion/synthetic/clips \
 *     --report-dir tests/tmp/adv-motion/synthetic
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
import { resolveVrmAsset, parseGlbJson, buildVrmRest, buildAlignment, springBoneInfo } from './lib/vrm-rest.mjs'
import { retargetClip, RETARGET_DEFAULTS } from './lib/retarget.mjs'
import { createBipedSource, buildBipedMappingReport } from './lib/humanoid-biped.mjs'
import { gradeClip } from './lib/qa.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULTS = {
  samples: 'tests/tmp/adv-motion/samples.json',
  config: 'scripts/vrm/motion/clips.adv.json',
  out: 'assets/motions/adv',
  reportDir: 'tests/tmp/adv-motion',
  'vrm-manifest': 'src/shared/vrm-manifest.json',
  'vrm-asset-id': 'aventurine-waveflair',
  'raw-mode': RETARGET_DEFAULTS.rawMode,
  'max-ground-shift': String(RETARGET_DEFAULTS.maxGroundShiftMeters),
  raw: 'auto',
  only: ''
}

const OPTIONS = {
  samples: { type: 'string', default: DEFAULTS.samples, valueHint: 'path', description: 'extract-biped-anims.py 产出的采样 JSON' },
  config: { type: 'string', default: DEFAULTS.config, valueHint: 'path', description: 'clip registry（clips.adv.json）' },
  out: { type: 'string', default: DEFAULTS.out, valueHint: 'dir', description: 'clip JSON 输出目录（默认 assets/motions/adv）' },
  'report-dir': { type: 'string', default: DEFAULTS.reportDir, valueHint: 'dir', description: '报告输出目录（tests/tmp，gitignore）' },
  'vrm-manifest': { type: 'string', default: DEFAULTS['vrm-manifest'], valueHint: 'path', description: 'src/shared/vrm-manifest.json' },
  'vrm-asset-id': { type: 'string', default: DEFAULTS['vrm-asset-id'], valueHint: 'id', description: '目标 VRM avatar id' },
  'raw-mode': { type: 'string', default: DEFAULTS['raw-mode'], valueHint: 'mode', description: 'raw 次级骨模式（Biped 暂不支持 baked，仅 spring）' },
  'max-ground-shift': { type: 'string', default: DEFAULTS['max-ground-shift'], valueHint: 'm', description: 'grounding 单帧最大竖直补偿（米）' },
  raw: {
    type: 'string',
    default: DEFAULTS.raw,
    valueHint: 'auto|off',
    description: 'raw 次级骨策略：auto=目标有 SpringBone 时用 spring（raw 留空）；Biped 无 secondary-chain 映射，off=不烘 raw'
  },
  only: { type: 'string', default: DEFAULTS.only, valueHint: 'id1,id2', description: '只处理指定 clip id（逗号分隔；dry-run 单 clip 用）' }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/motion/retarget-adv.mjs',
  description: 'V3.1：3ds Max Biped 全骨动画 → VRM clip JSON（可插拔 source；rest 方向修正 + grounding；raw=spring）。',
  usage: 'node scripts/vrm/motion/retarget-adv.mjs [--samples <json>] [--out <dir>] [--report-dir <dir>] [--only id1,id2]',
  options: OPTIONS,
  footer: '输出私有资产（gitignore）；报告进 tests/tmp/adv-motion/。映射/回归/限制见 work/adv-biped/RETARGET-REPORT.md。'
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message, code = 1) {
  console.error(`[retarget-adv] ERROR: ${message}`)
  process.exit(code)
}

function readNumberArg(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) return fallback
  return number
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    return
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[retarget-adv] ${error}`)
    process.exit(2)
  }
  const samplesPath = path.resolve(String(values.samples))
  const configPath = path.resolve(String(values.config))
  if (!fs.existsSync(samplesPath)) {
    fail(`采样文件不存在：${samplesPath}（先跑 extract-biped-anims.py；真实 FBX 未到时可先用 work/adv-biped/retarget/make-synthetic-samples.mjs 生成合成 samples）`)
  }
  if (!fs.existsSync(configPath)) fail(`config 不存在：${configPath}`)

  const samples = JSON.parse(fs.readFileSync(samplesPath, 'utf8'))
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const vrm = resolveVrmAsset(
    path.resolve(String(values['vrm-manifest'])),
    path.join(ROOT, 'assets'),
    String(values['vrm-asset-id'])
  )
  if (!fs.existsSync(vrm.file)) fail(`目标 VRM 不存在：${vrm.file}`)
  const { json } = parseGlbJson(vrm.file)
  if (!json.extensions?.VRMC_vrm) fail('目标 VRM 不是 VRM 1.0（缺 VRMC_vrm 扩展）')
  const vrmRest = buildVrmRest(json)
  const spring = springBoneInfo(json)

  // ---------- source 描述符（Biped） ----------
  let source
  try {
    source = createBipedSource({ samples, strict: true })
  } catch (error) {
    fail(`Biped source 解析失败：${error.message}`)
  }
  for (const warning of source.warnings) console.warn(`[retarget-adv] WARN(source) ${warning}`)

  const alignment = buildAlignment({ vrmRest, source })
  const mappingReport = buildBipedMappingReport({ source, vrmRest, alignment, samplesPath: toDisplayPath(samplesPath) })
  mappingReport.target.avatarId = vrm.avatarId

  const rawPreference = String(values.raw ?? 'auto')
  if (rawPreference === 'map') {
    console.warn('[retarget-adv] --raw map 暂不支持（Biped 无 secondary-chain 映射）：按目标 spring 处理')
  }
  const rawPolicy = spring.present ? 'spring' : 'none'
  const rawEnabled = false // Biped 管线：目标有 SpringBone → raw 留空；无 spring 资产待后续再做 raw chain 映射

  const options = {
    rawMode: String(values['raw-mode']),
    hairGain: RETARGET_DEFAULTS.hairGain,
    clothGain: RETARGET_DEFAULTS.clothGain,
    maxGroundShiftMeters: readNumberArg(values['max-ground-shift'], RETARGET_DEFAULTS.maxGroundShiftMeters, { min: 0, max: 1 }),
    rawEnabled,
    rawPolicy,
    targetVrm: path.relative(ROOT, vrm.file).split(path.sep).join('/'),
    targetAvatarId: vrm.avatarId
  }

  const outDir = path.resolve(String(values.out))
  const reportDir = path.resolve(String(values['report-dir']))
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(reportDir, { recursive: true })
  fs.writeFileSync(path.join(reportDir, 'mapping-report.json'), JSON.stringify(mappingReport, null, 1))

  const only = String(values.only ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const clipDefs = (config.clips ?? []).filter((clipDef) => only.length === 0 || only.includes(clipDef.id))
  if (clipDefs.length === 0) fail(`config 里没有可处理的 clip（only=${only.join(',') || '(空)'}）`)

  console.log(
    `[retarget-adv] source=biped bones=${mappingReport.source.boneCount} -> target=${path.basename(vrm.file)}` +
      ` humanoid=${mappingReport.target.humanoidBones} spring=${spring.chains}链/${spring.colliders}collider rawPolicy=${rawPolicy}`
  )
  console.log(
    `[retarget-adv] mapping: mapped=${mappingReport.mappingStats.mappedBones} restFixMismatchMax=${mappingReport.mappingStats.restDirectionMismatch.maxDeg}°` +
      (mappingReport.fingers.assignment
        ? ` fingerAssign(chosen mean=${mappingReport.fingers.assignment.chosenMeanDeg}°, thumbVsIndex=${mappingReport.fingers.assignment.thumbVsIndexDeg}°)`
        : '')
  )

  const reports = []
  const warnings = []
  const grades = []
  for (const clipDef of clipDefs) {
    const sampleClip = samples.clips?.[clipDef.id]
    if (!sampleClip) {
      warnings.push(`clip ${clipDef.id}: 采样缺失（extract 未匹配到 take ${clipDef.takeMatch}），跳过`)
      continue
    }
    let retargeted
    try {
      retargeted = retargetClip({
        clipId: clipDef.id,
        clipDef,
        sampleClip,
        samples,
        vrmRest,
        alignment,
        secondaryMap: null,
        options,
        source
      })
    } catch (error) {
      // 单条 clip 数据坏（帧数不足/缺 hips 采样等）不应中断整批：记 FAIL 继续，最终 exit 1。
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`clip ${clipDef.id}: 重定向失败：${message}`)
      grades.push({ clip: clipDef.id, status: 'FAIL', errors: [message], warnings: [] })
      console.error(`[retarget-adv] FAIL ${clipDef.id}: ${message}`)
      continue
    }
    const { clip, report } = retargeted
    const file = path.join(outDir, `${clipDef.id}.json`)
    fs.writeFileSync(file, JSON.stringify(clip))
    const grade = gradeClip(clip, vrmRest)
    grades.push({ clip: clipDef.id, status: grade.status, errors: grade.errors, warnings: grade.warnings, metrics: grade.metrics })
    reports.push(report)
    console.log(
      `[retarget-adv] ${clipDef.id.padEnd(14)} frames=${String(report.frames).padStart(3)} humanoid=${report.humanoidBones}` +
        ` restFix=${report.restFix.bones} ground=${report.grounding}` +
        (report.groundStats ? `(shift ${report.groundStats.maxShiftMeters}m)` : '') +
        ` grade=${grade.status}` +
        (report.warnings.length ? ` warnings=${report.warnings.length}` : '')
    )
    for (const warning of report.warnings) console.warn(`[retarget-adv]   WARN ${warning}`)
    for (const error of grade.errors) console.warn(`[retarget-adv]   GRADE-FAIL ${error}`)
  }

  if (reports.length === 0) {
    const detail = warnings.length > 0 ? `；跳过原因：${warnings.slice(0, 3).join(' / ')}` : ''
    fail(`没有任何 clip 产出（samples.clips 为空 or 配置 id 全不匹配）${detail}`)
  }

  const gradeCounts = grades.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1
      return acc
    },
    { PASS: 0, WARN: 0, FAIL: 0 }
  )
  const report = {
    generatedAt: new Date().toISOString(),
    samples: toDisplayPath(samplesPath),
    target: {
      avatarId: vrm.avatarId,
      file: toDisplayPath(vrm.file),
      yawOffsetDeg: vrm.manifest?.yawOffsetDeg ?? null,
      heightMeters: vrm.heightMeters ?? null,
      humanoidBones: Object.keys(vrmRest.humanoid).length,
      spring
    },
    source: {
      name: source.name,
      avatar: source.avatar,
      bones: mappingReport.source.boneCount,
      humanoidSourceBones: mappingReport.source.humanoidSourceBones,
      fingerChains: mappingReport.source.fingerChains,
      hipsBone: source.hipsBone,
      upBone: source.upBone,
      restBones: Object.keys(source.rest).length,
      sourceHeightMeters: source.sourceHeightMeters,
      sourceHipsHeightMeters: source.sourceHipsHeightMeters,
      sourceFps: samples.sourceFps ?? null,
      fps: samples.fps ?? null
    },
    alignment: {
      quat: alignment.quat.map((value) => Number(value.toFixed(6))),
      upperChestFallback: alignment.upperChestFallback ?? false
    },
    mapping: {
      report: toDisplayPath(path.join(reportDir, 'mapping-report.json')),
      mappedBones: mappingReport.mappingStats.mappedBones,
      restDirectionMismatch: mappingReport.mappingStats.restDirectionMismatch,
      spine: mappingReport.spine,
      fingerAssignment: mappingReport.fingers.assignment
    },
    rawPolicy,
    options,
    grades: { counts: gradeCounts, items: grades.map(({ clip, status, errors, warnings: gradeWarnings }) => ({ clip, status, errors, warnings: gradeWarnings })) },
    clips: reports,
    warnings
  }
  fs.writeFileSync(path.join(reportDir, 'retarget-report.json'), JSON.stringify(report, null, 1))

  console.log(
    `[retarget-adv] clips=${reports.length} grade: PASS ${gradeCounts.PASS} / WARN ${gradeCounts.WARN} / FAIL ${gradeCounts.FAIL} -> ${toDisplayPath(outDir)}`
  )
  console.log(`[retarget-adv] mapping -> ${toDisplayPath(path.join(reportDir, 'mapping-report.json'))}`)
  console.log(`[retarget-adv] report  -> ${toDisplayPath(path.join(reportDir, 'retarget-report.json'))}`)
  if (warnings.length > 0) {
    for (const warning of warnings) console.warn(`[retarget-adv] WARN ${warning}`)
  }
  if (gradeCounts.FAIL > 0) {
    console.error(`[retarget-adv] 有 ${gradeCounts.FAIL} 条 clip 数据门禁 FAIL：先修数据/映射，再进 manifest`)
    process.exitCode = 1
  } else {
    console.log(`[retarget-adv] OK（门禁通过；下一步：validate-hsr-clips --dir ${toDisplayPath(outDir)} 双保险）`)
  }
}

main()
