#!/usr/bin/env node
/**
 * V3.2 adv：由 Biped 动作集 clip 数据 + clip registry 构建 motion manifest（与 HSR 版同构，
 * 额外带 `channels`（humanoid/raw 骨数）、`grounding`、`sourceFile`（来源 FBX，registry 溯源）
 * 与动作集级 `stats`（slot/grounding/loop/channels 统计）字段）。
 *
 * 与 `build-hsr-manifest.mjs` 的区别只在「动作集身份」与默认路径：
 * - `set: "adv"`、`file: "adv/<id>.json"`；
 * - 22 核心骨契约使用**本文件内的独立常量**（不 import `lib/humanoid-hsr.mjs`，避免动作集耦合；
 *   契约本身与 HSR 完全一致，见 `src/shared/animation-contract.ts`）；
 * - 默认目录 `assets/motions/adv`（私有 gitignore）、registry `clips.adv.json`、
 *   报告 `tests/tmp/adv-motion/manifest-report.json`。
 *
 * 输出（本机私有动作集）：
 * - `assets/motions/adv/manifest.json`（canonical；`set: "adv"`）
 * - `assets/motions/adv/index.json`（id → 文件/时长/槽位，预览器/加载器用）
 * - `tests/tmp/adv-motion/manifest-report.json`（构建报告：coverage + slot/grounding/loop/channels 统计）
 *
 * 用法：
 *   node scripts/vrm/motion/build-adv-manifest.mjs [--dir assets/motions/adv] [--check]
 *   node scripts/vrm/motion/build-adv-manifest.mjs --dir work/adv-biped/tooling/clips \
 *     --config work/adv-biped/tooling/configs/clips.fixture.json \
 *     --report work/adv-biped/tooling/manifest-report.json
 *
 * 退出码：0 = 成功/一致；1 = 构建失败或 --check 不一致；2 = 参数错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
import { CONTRACT_CLIP_SLOTS } from '../../unity-bake/lib/humanoid-map.mjs'

/** 动作集标识（manifest.set / file 前缀 / index.set）。 */
const SET = 'adv'
const DEFAULTS = {
  dir: `assets/motions/${SET}`,
  config: `scripts/vrm/motion/clips.${SET}.json`,
  report: `tests/tmp/${SET}-motion/manifest-report.json`
}
const OPTIONS = {
  dir: { type: 'string', default: DEFAULTS.dir, valueHint: 'dir', description: 'clip JSON 目录' },
  config: { type: 'string', default: DEFAULTS.config, valueHint: 'path', description: 'clip registry（clips.adv.json）' },
  report: { type: 'string', default: DEFAULTS.report, valueHint: 'path', description: '构建报告 JSON（tests/tmp）' },
  check: { type: 'boolean', default: false, description: '只校验磁盘 manifest/index 与当前数据是否一致（不写盘）' }
}
const HELP = formatHelp({
  command: 'node scripts/vrm/motion/build-adv-manifest.mjs',
  description: 'V3.2：构建 adv（3ds Max Biped）动作集 manifest + index（私有 assets/motions/adv）。',
  usage: 'node scripts/vrm/motion/build-adv-manifest.mjs [--dir <dir>] [--config <json>] [--report <path>] [--check]',
  options: OPTIONS,
  footer:
    'manifest.set = "adv"；file 相对 assets/motions/（adv/<id>.json）；--check 只比对不写盘（clips/coverage/source/stats + index）。'
})

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 22 核心骨契约（Unity humanoid 风格 clip 键名）。
 * 刻意不 import `lib/humanoid-hsr.mjs`：adv 动作集与 HSR 动作集同契约但不同管线，
 * 独立常量避免「改 HSR 命名模块 → 连带影响 adv manifest」这类隐性耦合。
 * 与 `src/shared/animation-contract.ts` / Wave 1.5 `humanoid-map.mjs` 的 22 骨一致。
 */
const CORE_UNITY_BONES = Object.freeze([
  'Hips',
  'Spine',
  'Chest',
  'UpperChest',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
  'LeftUpperLeg',
  'LeftLowerLeg',
  'LeftFoot',
  'LeftToes',
  'RightUpperLeg',
  'RightLowerLeg',
  'RightFoot',
  'RightToes'
])

function fail(message, code = 1) {
  console.error(`[build-adv-manifest] ERROR: ${message}`)
  process.exit(code)
}

function toDisplayPath(target) {
  const rel = path.relative(process.cwd(), target)
  return rel && !rel.startsWith('..') ? rel : target
}

function readClip(dir, id) {
  const file = path.join(dir, `${id}.json`)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 生成报告用的分组统计：slot / grounding / loop / channels / tags。
 * 与 `coverage`（tag 计数，供给 requirements 门禁）分开，避免改变 manifest 既有语义。
 */
function buildStats(entries) {
  const slots = {}
  const grounding = {}
  const loop = { loop: 0, once: 0 }
  const channels = { humanoid: 0, raw: 0, clipsWithRaw: 0 }
  for (const entry of entries) {
    const slotKey = entry.slot ?? 'null'
    slots[slotKey] = (slots[slotKey] ?? 0) + 1
    const groundingKey = entry.grounding ?? 'none'
    grounding[groundingKey] = (grounding[groundingKey] ?? 0) + 1
    if (entry.loop) loop.loop += 1
    else loop.once += 1
    channels.humanoid += entry.channels.humanoid
    channels.raw += entry.channels.raw
    if (entry.channels.raw > 0) channels.clipsWithRaw += 1
  }
  return { slots, grounding, loop, channels }
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    return
  }
  for (const error of errors) console.error(`[build-adv-manifest] ${error}`)
  if (errors.length > 0) process.exit(2)

  const clipsDir = path.resolve(String(values.dir))
  const configPath = path.resolve(String(values.config))
  const reportPath = path.resolve(String(values.report))
  const checkOnly = values.check === true

  if (!fs.existsSync(clipsDir)) fail(`clip 目录不存在：${clipsDir}（先跑 retarget-adv.mjs）`)
  if (!fs.existsSync(configPath)) fail(`config 不存在：${configPath}`)
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    fail(`config.schemaVersion 期望 1（实际 ${JSON.stringify(config.schemaVersion)}）`)
  }

  const buildErrors = []
  const buildWarnings = []
  const entries = []
  const index = {}
  const coverage = {}
  /** @type {string | null} */
  let targetVrm = null
  /** @type {string | null} */
  let rawPolicy = null
  for (const key of Object.keys(config.requirements ?? {})) coverage[key] = 0

  for (const clipDef of config.clips ?? []) {
    const id = clipDef.id
    if (!ID_PATTERN.test(id)) {
      buildErrors.push(`clip id 非法：${JSON.stringify(id)}`)
      continue
    }
    if (clipDef.slot !== undefined && clipDef.slot !== null && !CONTRACT_CLIP_SLOTS.includes(clipDef.slot)) {
      buildErrors.push(`${id}: slot 非法：${JSON.stringify(clipDef.slot)}`)
      continue
    }
    const clip = readClip(clipsDir, id)
    if (!clip) {
      buildWarnings.push(`${id}: 磁盘缺少 clip 文件，跳过（retarget 未产出 / 采样未匹配 take）`)
      continue
    }
    if (!clip.bones || !clip.bones.Hips) {
      buildErrors.push(`${id}: clip 缺 bones/Hips`)
      continue
    }
    if (clip.clip !== undefined && clip.clip !== id) {
      buildWarnings.push(`${id}: clip.clip 字段为 ${JSON.stringify(clip.clip)}，与 registry id 不一致`)
    }
    const missingCore = CORE_UNITY_BONES.filter((bone) => !clip.bones[bone])
    if (missingCore.length > 0) buildErrors.push(`${id}: 缺核心骨 ${missingCore.join(',')}`)
    const humanoidBones = Object.keys(clip.bones).length
    const rawBones = clip.raw ? Object.keys(clip.raw).length : 0
    targetVrm = targetVrm ?? clip.targetVrm ?? null
    rawPolicy = rawPolicy ?? clip.rawPolicy ?? null
    const entry = {
      id,
      file: `${SET}/${id}.json`,
      slot: clipDef.slot ?? null,
      tags: Array.isArray(clipDef.tags) ? clipDef.tags.slice() : [],
      loop: Boolean(clip.loop),
      timeScale: clipDef.timeScale ?? 1,
      priority: clipDef.priority ?? 0,
      duration: clip.duration,
      fps: clip.fps,
      frames: clip.frames,
      sourcePath: clip.sourceClip,
      sourceFile: clipDef.file ?? null,
      channels: { humanoid: humanoidBones, raw: rawBones },
      rawPolicy: clip.rawPolicy ?? null,
      grounding: clip.grounding ?? 'none',
      note: clipDef.note ?? ''
    }
    entries.push(entry)
    index[id] = {
      file: entry.file,
      slot: entry.slot,
      loop: entry.loop,
      duration: entry.duration,
      fps: entry.fps,
      frames: entry.frames
    }
    for (const tag of entry.tags) coverage[tag] = (coverage[tag] ?? 0) + 1
  }

  for (const [tag, minimum] of Object.entries(config.requirements ?? {})) {
    if ((coverage[tag] ?? 0) < minimum) {
      buildErrors.push(`覆盖不足：tag "${tag}" 需要 ≥${minimum}，实际 ${coverage[tag] ?? 0}`)
    }
  }
  if (entries.length === 0) buildErrors.push('没有任何可用 clip（目录/registry 检查）')

  const stats = buildStats(entries)
  const manifest = {
    schemaVersion: 1,
    set: SET,
    generatedAt: new Date().toISOString(),
    source: {
      ...(config.source ?? {}),
      targetVrm: targetVrm ? `assets/vrm/${path.basename(targetVrm)}` : null,
      rawPolicy,
      restFixNote:
        'humanoid 上臂/前臂/手/手指按目标 rest 方向做 per-bone swing 修正；' +
        'Biped 三节脊柱 target-aware：目标无 upperChest 时 spine←第一接、chest←最后一接（中间节的世界旋转并入 chest），' +
        'clip 里 UpperChest 轨道为 identity'
    },
    defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
    clips: entries,
    coverage,
    stats,
    checks: { ok: buildErrors.length === 0, errors: buildErrors, warnings: buildWarnings }
  }
  const indexDoc = {
    version: 1,
    set: SET,
    generatedAt: manifest.generatedAt,
    clips: index
  }

  const manifestPath = path.join(clipsDir, 'manifest.json')
  const indexPath = path.join(clipsDir, 'index.json')
  if (checkOnly) {
    if (!fs.existsSync(manifestPath)) fail(`manifest 不存在（--check）：${toDisplayPath(manifestPath)}`)
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const sameClips = JSON.stringify(existing.clips) === JSON.stringify(manifest.clips)
    const sameCoverage = JSON.stringify(existing.coverage) === JSON.stringify(manifest.coverage)
    const sameSource = JSON.stringify(existing.source) === JSON.stringify(manifest.source)
    const sameStats = JSON.stringify(existing.stats) === JSON.stringify(manifest.stats)
    if (!sameClips || !sameCoverage || !sameSource || !sameStats) {
      fail(
        'manifest 与当前数据不一致（--check）：需重新构建（去掉 --check 跑一次）；' +
          `${sameClips ? '' : ' clips 不同'}${sameCoverage ? '' : ' coverage 不同'}` +
          `${sameSource ? '' : ' source 不同'}${sameStats ? '' : ' stats 不同'}`
      )
    }
    if (existing.set !== SET) fail(`磁盘 manifest.set=${JSON.stringify(existing.set)} ≠ ${JSON.stringify(SET)}`)
    if (!fs.existsSync(indexPath)) fail(`index 不存在（--check）：${toDisplayPath(indexPath)}`)
    const existingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    const sameIndex = JSON.stringify(existingIndex.clips) === JSON.stringify(indexDoc.clips)
    if (!sameIndex) fail('index.json 与当前数据不一致（--check）')
    if (!manifest.checks.ok) fail(`manifest 校验失败：${buildErrors.join('；')}`)
    console.log(
      `[build-adv-manifest] check OK（manifest + index 与数据一致；clips=${entries.length} coverage=${JSON.stringify(coverage)}）`
    )
    return
  }

  if (!manifest.checks.ok) {
    for (const error of buildErrors) console.error(`[build-adv-manifest] ${error}`)
    fail(`构建失败（${buildErrors.length} errors / ${buildWarnings.length} warnings），未写盘`)
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(indexPath, JSON.stringify(indexDoc, null, 2))
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        ok: true,
        set: SET,
        generatedAt: manifest.generatedAt,
        dir: toDisplayPath(clipsDir),
        config: toDisplayPath(configPath),
        clips: entries.length,
        coverage,
        stats,
        errors: buildErrors,
        warnings: buildWarnings
      },
      null,
      1
    )
  )
  console.log(
    `[build-adv-manifest] OK set=${SET} clips=${entries.length} coverage=${JSON.stringify(coverage)}` +
      ` loop=${stats.loop.loop}/${stats.loop.once} grounding=${JSON.stringify(stats.grounding)}` +
      ` -> ${toDisplayPath(manifestPath)}`
  )
  for (const warning of buildWarnings) console.warn(`[build-adv-manifest] WARN ${warning}`)
}

main()
