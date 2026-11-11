#!/usr/bin/env node
/**
 * V3：由 HSR clip 数据 + clip registry 构建 motion manifest（与 Wave 1.5 的 mate manifest 同构，
 * 额外带 `channels`（humanoid/raw 骨数）与 `grounding` 字段）。
 *
 * 输出（本机私有动作集）：
 * - `assets/motions/hsr/manifest.json`（canonical；`set: "hsr"`）
 * - `assets/motions/hsr/index.json`（id → 文件/时长/槽位，预览器/加载器用）
 * - `tests/tmp/hsr-motion/manifest-report.json`（构建报告）
 *
 * 用法：
 *   node scripts/vrm/motion/build-hsr-manifest.mjs [--dir assets/motions/hsr] [--check]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseCliArgs, formatHelp } from '../../unity-bake/lib/cli-args.mjs'
import { CONTRACT_CLIP_SLOTS } from '../../unity-bake/lib/humanoid-map.mjs'
import { CORE_UNITY_BONES } from './lib/humanoid-hsr.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DEFAULTS = {
  dir: 'assets/motions/hsr',
  config: 'scripts/vrm/motion/clips.hsr.json',
  report: 'tests/tmp/hsr-motion/manifest-report.json'
}
const OPTIONS = {
  dir: { type: 'string', default: DEFAULTS.dir, valueHint: 'dir', description: 'clip JSON 目录' },
  config: { type: 'string', default: DEFAULTS.config, valueHint: 'path', description: 'clip registry' },
  report: { type: 'string', default: DEFAULTS.report, valueHint: 'path', description: '构建报告 JSON（tests/tmp）' },
  check: { type: 'boolean', default: false, description: '只校验磁盘 manifest 与当前数据是否一致（不写盘）' }
}
const HELP = formatHelp({
  command: 'node scripts/vrm/motion/build-hsr-manifest.mjs',
  description: 'V3：构建 HSR 动作集 manifest + index（私有 assets/motions/hsr）。',
  usage: 'node scripts/vrm/motion/build-hsr-manifest.mjs [--dir <dir>] [--config <json>] [--check]',
  options: OPTIONS,
  footer: 'manifest.set = "hsr"；file 相对 assets/motions/；--check 只比对不写盘。'
})

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function fail(message, code = 1) {
  console.error(`[build-hsr-manifest] ERROR: ${message}`)
  process.exit(code)
}

function readClip(dir, id) {
  const file = path.join(dir, `${id}.json`)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) {
    console.log(HELP)
    return
  }
  for (const error of errors) console.error(`[build-hsr-manifest] ${error}`)
  if (errors.length > 0) process.exit(2)

  const clipsDir = path.resolve(String(values.dir))
  const config = JSON.parse(fs.readFileSync(path.resolve(String(values.config)), 'utf8'))
  const reportPath = path.resolve(String(values.report))
  const checkOnly = values.check === true

  if (!fs.existsSync(clipsDir)) fail(`clip 目录不存在：${clipsDir}`)

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
      buildErrors.push(`clip id 非法：${id}`)
      continue
    }
    if (clipDef.slot !== null && !CONTRACT_CLIP_SLOTS.includes(clipDef.slot)) {
      buildErrors.push(`${id}: slot 非法：${JSON.stringify(clipDef.slot)}`)
      continue
    }
    const clip = readClip(clipsDir, id)
    if (!clip) {
      buildWarnings.push(`${id}: 磁盘缺少 clip 文件，跳过`)
      continue
    }
    if (!clip.bones || !clip.bones.Hips) {
      buildErrors.push(`${id}: clip 缺 bones/Hips`)
      continue
    }
    const missingCore = CORE_UNITY_BONES.filter((bone) => !clip.bones[bone])
    if (missingCore.length > 0) buildErrors.push(`${id}: 缺核心骨 ${missingCore.join(',')}`)
    const humanoidBones = Object.keys(clip.bones).length
    const rawBones = clip.raw ? Object.keys(clip.raw).length : 0
    targetVrm = targetVrm ?? clip.targetVrm ?? null
    rawPolicy = rawPolicy ?? clip.rawPolicy ?? null
    const entry = {
      id,
      file: `hsr/${id}.json`,
      slot: clipDef.slot ?? null,
      tags: Array.isArray(clipDef.tags) ? clipDef.tags.slice() : [],
      loop: Boolean(clip.loop),
      timeScale: clipDef.timeScale ?? 1,
      priority: clipDef.priority ?? 0,
      duration: clip.duration,
      fps: clip.fps,
      frames: clip.frames,
      sourcePath: clip.sourceClip,
      channels: { humanoid: humanoidBones, raw: rawBones },
      rawPolicy: clip.rawPolicy ?? null,
      grounding: clip.grounding ?? 'none',
      note: clipDef.note ?? ''
    }
    entries.push(entry)
    index[id] = { file: entry.file, slot: entry.slot, loop: entry.loop, duration: entry.duration, fps: entry.fps, frames: entry.frames }
    for (const tag of entry.tags) coverage[tag] = (coverage[tag] ?? 0) + 1
  }

  for (const [tag, minimum] of Object.entries(config.requirements ?? {})) {
    if ((coverage[tag] ?? 0) < minimum) buildErrors.push(`覆盖不足：tag "${tag}" 需要 ≥${minimum}，实际 ${coverage[tag] ?? 0}`)
  }

  const manifest = {
    schemaVersion: 1,
    set: 'hsr',
    generatedAt: new Date().toISOString(),
    source: {
      ...(config.source ?? {}),
      targetVrm: targetVrm ? `assets/vrm/${path.basename(targetVrm)}` : null,
      rawPolicy,
      restFixNote:
        'humanoid 上臂/前臂/手/手指按目标 rest 方向做 per-bone swing 修正；' +
        '目标无 upperChest 时 chest←HSR Chest_M（Spine2_M 并入 chest，clip 里 UpperChest 轨道为 identity）'
    },
    defaults: { loop: true, timeScale: 1, fadeInSec: 0.15, fadeOutSec: 0.2, rootMotion: 'inPlace' },
    clips: entries,
    coverage,
    checks: { ok: buildErrors.length === 0, errors: buildErrors, warnings: buildWarnings }
  }

  const manifestPath = path.join(clipsDir, 'manifest.json')
  const indexPath = path.join(clipsDir, 'index.json')
  if (checkOnly) {
    if (!fs.existsSync(manifestPath)) fail('manifest 不存在（--check）')
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const sameClips = JSON.stringify(existing.clips) === JSON.stringify(manifest.clips)
    const sameCoverage = JSON.stringify(existing.coverage) === JSON.stringify(manifest.coverage)
    if (!sameClips || !sameCoverage) fail('manifest 与当前数据不一致（--check）')
    if (!manifest.checks.ok) fail(`manifest 校验失败：${buildErrors.join('；')}`)
    console.log('[build-hsr-manifest] check OK（manifest 与数据一致）')
    return
  }
  if (!manifest.checks.ok) {
    for (const error of buildErrors) console.error(`[build-hsr-manifest] ${error}`)
    fail(`构建失败（${buildErrors.length} errors / ${buildWarnings.length} warnings），未写盘`)
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, set: 'hsr', generatedAt: manifest.generatedAt, clips: index }, null, 2))
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ ok: true, errors: buildErrors, warnings: buildWarnings, coverage, clips: entries.length }, null, 1))
  console.log(`[build-hsr-manifest] OK clips=${entries.length} coverage=${JSON.stringify(coverage)} -> ${path.relative(process.cwd(), manifestPath)}`)
  for (const warning of buildWarnings) console.warn(`[build-hsr-manifest] WARN ${warning}`)
}

main()
