#!/usr/bin/env node
/**
 * V3：HSR 全骨动画 → VRM clip 数据（humanoid 52 骨 + raw 次级骨通道 + 脚部 grounding）
 *
 * 输入：
 * - `tests/tmp/hsr-motion/samples.json`（`extract-hsr-anims.py` 产出，私有临时）
 * - `scripts/vrm/motion/clips.hsr.json`（clip registry：take→id/slot/loop/grounding/priority）
 * - 目标 VRM：默认从 `src/shared/vrm-manifest.json` 取 `aventurine-waveflair`
 *   （当前 = 规范 T-pose 重制版 `assets/vrm/aventurine-tpose.vrm`，面向 +Z/左手 +X/带 SpringBone）
 *
 * 输出（私有资产，gitignore）：
 * - `assets/motions/hsr/<id>.json`（clip 数据；骨骼键与 Wave 1.5 的 mate 集兼容，
 *   另含 30 手指骨；目标模型有 SpringBone 时 raw 留空（rawPolicy=spring））
 * - `tests/tmp/hsr-motion/retarget-report.json`（帧数/映射/grounding/告警报告）
 * - `tests/tmp/hsr-motion/secondary-mapping.json`（VRM 次级链 ↔ HSR 次级链映射表）
 *
 * 用法：
 *   node scripts/vrm/motion/retarget-hsr.mjs \
 *     --samples tests/tmp/hsr-motion/samples.json \
 *     --out assets/motions/hsr \
 *     --report-dir tests/tmp/hsr-motion
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
import { resolveVrmAsset, parseGlbJson, buildVrmRest, buildAlignment, springBoneInfo } from './lib/vrm-rest.mjs'
import { mapSecondaryChains } from './lib/secondary-map.mjs'
import { retargetClip, RETARGET_DEFAULTS } from './lib/retarget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULTS = {
  samples: 'tests/tmp/hsr-motion/samples.json',
  config: 'scripts/vrm/motion/clips.hsr.json',
  out: 'assets/motions/hsr',
  reportDir: 'tests/tmp/hsr-motion',
  'vrm-manifest': 'src/shared/vrm-manifest.json',
  'vrm-asset-id': 'aventurine-waveflair',
  'raw-mode': RETARGET_DEFAULTS.rawMode,
  'hair-gain': String(RETARGET_DEFAULTS.hairGain),
  'cloth-gain': String(RETARGET_DEFAULTS.clothGain),
  'max-ground-shift': String(RETARGET_DEFAULTS.maxGroundShiftMeters),
  raw: 'auto'
}

const OPTIONS = {
  samples: { type: 'string', default: DEFAULTS.samples, valueHint: 'path', description: 'extract-hsr-anims.py 产出的采样 JSON' },
  config: { type: 'string', default: DEFAULTS.config, valueHint: 'path', description: 'clip registry（clips.hsr.json）' },
  out: { type: 'string', default: DEFAULTS.out, valueHint: 'dir', description: 'clip JSON 输出目录（默认 assets/motions/hsr）' },
  'report-dir': { type: 'string', default: DEFAULTS.reportDir, valueHint: 'dir', description: '报告输出目录（tests/tmp，gitignore）' },
  'vrm-manifest': { type: 'string', default: DEFAULTS['vrm-manifest'], valueHint: 'path', description: 'src/shared/vrm-manifest.json' },
  'vrm-asset-id': { type: 'string', default: DEFAULTS['vrm-asset-id'], valueHint: 'id', description: '目标 VRM avatar id' },
  'raw-mode': { type: 'string', default: DEFAULTS['raw-mode'], valueHint: 'mode', description: 'raw 次级骨模式（relative-to-first-frame | absolute）' },
  'hair-gain': { type: 'string', default: DEFAULTS['hair-gain'], valueHint: '0-1', description: '头发摆动增益（1=全量）' },
  'cloth-gain': { type: 'string', default: DEFAULTS['cloth-gain'], valueHint: '0-1', description: '衣摆摆动增益（1=全量）' },
  'max-ground-shift': { type: 'string', default: DEFAULTS['max-ground-shift'], valueHint: 'm', description: 'grounding 单帧最大竖直补偿（米）' },
  raw: {
    type: 'string',
    default: DEFAULTS.raw,
    valueHint: 'auto|off|map',
    description: 'raw 次级骨策略：auto=目标有 SpringBone 时用 spring（raw 留空），否则沿用旧链映射；off=强制不烘 raw；map=强制旧链映射（旧 A-pose 资产）'
  }
}

const HELP = formatHelp({
  command: 'node scripts/vrm/motion/retarget-hsr.mjs',
  description: 'V3：HSR 官方全骨动画 → VRM clip JSON（humanoid 52 骨 + rest 方向修正 + grounding；raw 视目标 spring 而定）。',
  usage: 'node scripts/vrm/motion/retarget-hsr.mjs [--samples <json>] [--out <dir>] [--report-dir <dir>]',
  options: OPTIONS,
  footer: '输出私有资产（gitignore）；报告进 tests/tmp/hsr-motion/。'
})

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function fail(message, code = 1) {
  console.error(`[retarget-hsr] ERROR: ${message}`)
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
    for (const error of errors) console.error(`[retarget-hsr] ${error}`)
    process.exit(2)
  }
  const samplesPath = path.resolve(String(values.samples))
  const configPath = path.resolve(String(values.config))
  if (!fs.existsSync(samplesPath)) fail(`采样文件不存在：${samplesPath}（先跑 extract-hsr-anims.py）`)
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

  const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest })
  const rawPreference = String(values.raw ?? 'auto')
  const rawPolicy =
    rawPreference === 'map'
      ? 'baked'
      : rawPreference === 'off'
        ? spring.present
          ? 'spring'
          : 'none'
        : spring.present
          ? 'spring'
          : 'baked'
  const rawEnabled = rawPolicy === 'baked'
  const secondaryMap = rawEnabled
    ? mapSecondaryChains({
        hsrRest: samples.rest,
        hsrChildren: samples.children,
        vrmRest,
        alignment,
        overrides: config.rawOverrides ?? {}
      })
    : null

  const options = {
    rawMode: String(values['raw-mode']),
    hairGain: readNumberArg(values['hair-gain'], RETARGET_DEFAULTS.hairGain, { min: 0, max: 1 }),
    clothGain: readNumberArg(values['cloth-gain'], RETARGET_DEFAULTS.clothGain, { min: 0, max: 1 }),
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

  if (rawEnabled && (!secondaryMap || secondaryMap.nodeToBone.size === 0)) {
    console.warn('[retarget-hsr] 警告：secondaryMap 为空（头发/衣摆不会动）——检查 VRM 节点命名/分类')
  }
  console.log(
    `[retarget-hsr] target=${path.basename(vrm.file)} yaw=${vrm.manifest?.yawOffsetDeg ?? 0} spring=${spring.chains}链/${spring.colliders}collider` +
      ` rawPolicy=${rawPolicy}${rawEnabled && secondaryMap ? ` mappedNodes=${secondaryMap.nodeToBone.size}` : ''}`
  )

  const reports = []
  const warnings = []
  for (const clipDef of config.clips ?? []) {
    const sampleClip = samples.clips?.[clipDef.id]
    if (!sampleClip) {
      warnings.push(`clip ${clipDef.id}: 采样缺失（extract 时未匹配到 take ${clipDef.takeMatch}），跳过`)
      continue
    }
    const { clip, report } = retargetClip({
      clipId: clipDef.id,
      clipDef,
      sampleClip,
      samples,
      vrmRest,
      alignment,
      secondaryMap,
      options
    })
    const file = path.join(outDir, `${clipDef.id}.json`)
    fs.writeFileSync(file, JSON.stringify(clip))
    reports.push(report)
    console.log(
      `[retarget-hsr] ${clipDef.id.padEnd(12)} frames=${String(report.frames).padStart(3)} humanoid=${report.humanoidBones}` +
        ` raw=${report.rawBones}(${report.rawPolicy}) restFix=${report.restFix.bones}` +
        ` ground=${report.grounding}${report.groundStats ? `(shift ${report.groundStats.maxShiftMeters}m)` : ''}` +
        (report.warnings.length ? ` warnings=${report.warnings.length}` : '')
    )
    for (const warning of report.warnings) console.warn(`[retarget-hsr]   WARN ${warning}`)
  }

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
      sourceHeightMeters: samples.sourceHeightMeters,
      sourceHipsHeightMeters: samples.sourceHipsHeightMeters,
      fps: samples.fps,
      sourceFps: samples.sourceFps
    },
    alignment: {
      quat: alignment.quat.map((value) => Number(value.toFixed(6))),
      upperChestFallback: alignment.upperChestFallback ?? false
    },
    rawPolicy,
    secondary: rawEnabled
      ? {
          mappedNodes: secondaryMap.nodeToBone.size,
          counts: secondaryMap.counts,
          hsrChainCounts: secondaryMap.hsrChainCounts,
          chains: secondaryMap.chainReports,
          warnings: secondaryMap.warnings
        }
      : { mode: rawPolicy, note: 'target VRM 自带 SpringBone；raw 留空，由 three-vrm 物理驱动' },
    restFix: reports.length
      ? {
          appliedClips: reports.filter((item) => item.restFix.applied).length,
          bones: reports[0].restFix.bones,
          maxMismatchDeg: Math.max(...reports.map((item) => item.restFix.maxMismatchDeg)),
          groups: reports[0].restFix.groups
        }
      : { appliedClips: 0, bones: 0, maxMismatchDeg: 0, groups: {} },
    options,
    clips: reports,
    warnings
  }
  fs.writeFileSync(path.join(reportDir, 'retarget-report.json'), JSON.stringify(report, null, 1))
  fs.writeFileSync(
    path.join(reportDir, 'secondary-mapping.json'),
    rawEnabled
      ? JSON.stringify({ chains: secondaryMap.chainReports, counts: secondaryMap.counts, warnings: secondaryMap.warnings }, null, 1)
      : JSON.stringify({ mode: rawPolicy, note: 'raw 未烘焙：目标 VRM 有 SpringBone' }, null, 1)
  )
  console.log(`[retarget-hsr] clips=${reports.length} -> ${toDisplayPath(outDir)}`)
  console.log(`[retarget-hsr] report -> ${toDisplayPath(path.join(reportDir, 'retarget-report.json'))}`)
  console.log(`[retarget-hsr] OK（下一步：node scripts/vrm/motion/validate-hsr-clips.mjs --dir ${toDisplayPath(outDir)}）`)
}

main()
