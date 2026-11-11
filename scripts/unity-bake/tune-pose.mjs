#!/usr/bin/env node
/**
 * U2/U3 动作数据「姿态微调」CLI（初始站姿手臂收拢等）
 *
 * 输入：convert-clips.mjs 产出的 normalized clip JSON（默认 assets/motions/mate/*.json）
 * 配置：scripts/unity-bake/pose-tune.json（规则：clip + 帧区间 + 骨骼轴角偏移）
 * 输出：原地写回 clip JSON，并在顶层加 `poseTune` 幂等标记。
 *
 * 用法：
 *   node scripts/unity-bake/tune-pose.mjs [--dir assets/motions/mate] [--config scripts/unity-bake/pose-tune.json] [--check]
 *
 * 处理顺序（run-export.sh 已接好）：convert-clips（每次覆盖重写）→ tune-pose → validate/manifest。
 * 之所以放在 convert 之后：convert 每次都会重写原始数据，tune 幂等标记只用于防止对同一份数据重复叠加。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { applyRule, configHash, validatePoseTuneConfig } from './lib/pose-tune.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const dir = path.resolve(ROOT, arg('dir', 'assets/motions/mate'))
const configPath = path.resolve(ROOT, arg('config', 'scripts/unity-bake/pose-tune.json'))
const checkOnly = has('check')

function fail(msg, code = 1) {
  console.error(`[tune-pose] ${msg}`)
  process.exit(code)
}

if (!fs.existsSync(dir)) fail(`数据目录不存在：${dir}（先跑 convert-clips.mjs）`)
if (!fs.existsSync(configPath)) fail(`配置不存在：${configPath}`)

let config
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
} catch (e) {
  fail(`配置文件不是合法 JSON：${configPath}：${e.message}`)
}
const configErrors = validatePoseTuneConfig(config)
if (configErrors.length > 0) fail(`配置校验失败：\n- ${configErrors.join('\n- ')}`)

const hash = configHash(config)
const byClip = new Map()
for (const rule of config.rules) {
  if (byClip.has(rule.clip)) fail(`同一 clip 出现多条规则：${rule.clip}（合并成一条）`)
  byClip.set(rule.clip, rule)
}

let applied = 0
let skipped = 0
let changedFrames = 0
for (const [clipName, rule] of byClip) {
  const file = path.join(dir, `${clipName}.json`)
  if (!fs.existsSync(file)) fail(`配置引用的 clip 不存在：${file}`)
  const clip = JSON.parse(fs.readFileSync(file, 'utf8'))
  const marker = clip.poseTune
  if (marker) {
    if (marker.configHash === hash) {
      skipped++
      continue
    }
    fail(
      `clip ${clipName} 已应用过另一份 poseTune 配置（${marker.configHash} ≠ ${hash}）；` +
        `为避免偏移叠加，请先重跑 convert-clips.mjs 再用新配置 tune。`
    )
  }
  const { framesChanged } = applyRule(clip, rule)
  clip.poseTune = {
    version: 1,
    configHash: hash,
    clip: clipName,
    frames: rule.frames,
    bones: Object.keys(rule.bones),
    appliedAt: new Date().toISOString(),
    note: 'normalized 旋转的微小姿态偏移；config 源见 scripts/unity-bake/pose-tune.json'
  }
  if (!checkOnly) fs.writeFileSync(file, JSON.stringify(clip))
  applied++
  changedFrames += framesChanged
  console.log(`[tune-pose] ${clipName}: 帧 ${rule.frames[0]}–${rule.frames[1]}，骨骼 ${Object.keys(rule.bones).join('/')}，${framesChanged} 帧已调整`)
}
console.log(
  `[tune-pose] ${checkOnly ? 'check' : 'done'}：applied ${applied} / skipped ${skipped} clip，共 ${changedFrames} 帧，config=${path.relative(ROOT, configPath)}（${hash}）`
)
