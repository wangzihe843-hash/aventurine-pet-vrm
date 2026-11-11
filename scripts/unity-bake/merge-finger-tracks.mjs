#!/usr/bin/env node
/**
 * 把 Unity GT 手指探针数据合并进已烘焙的 mate clip JSON（22 骨 → 22 + 30 手指 = 52 骨）。
 *
 * 背景（2026-11-08）：Wave 1.5 的动作数据只采了 22 根核心骨，源 .anim 里的 40 条手指
 * muscle 曲线被丢掉。本脚本回头用 Unity+UniVRM（真实 VRM avatar）逐帧采样 worldRot，
 * 按 three-vrm normalized humanoid 语义换算手指 normalized 旋转：
 *   ΔW_b = W_pose_b · W_rest_b⁻¹
 *   N_b  = ΔW_parent⁻¹ · ΔW_b        （parent = normalized humanoid 父骨）
 *   r    = unityToGltf(N_b)          （与 convert-clips 的 --axis x 同一映射）
 * 其中 ΔW/ N 的推导与验证见 work/finger-probe-analyze2.py：
 * 同模型 body22 骨与已烘焙 r 的平均误差 0.5–0.6°，跨模型（Zome/戏浪）手指 N 差 0.44°。
 *
 * 用法：
 *   node scripts/unity-bake/merge-finger-tracks.mjs \
 *     --gt work/finger-probe/out/unity --model zome \
 *     --in assets/motions/mate --out work/finger-trial/clips \
 *     [--clips idle,idle5,happy,drag] [--report work/finger-trial/report.json]
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]
const qnorm = (q) => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]]
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
const qAngleDeg = (q) => (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI
const qAngleBetweenDeg = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(qdot(a, b)))) * 180) / Math.PI

/** Unity 左手系 → glTF 右手系（--axis x，与 convert-clips.mjs 完全一致）。 */
const unityToGltfQuat = (q) => qnorm([q[0], -q[1], -q[2], q[3]])

/** Unity HumanBodyBones 名 → normalized humanoid 父骨名（VRM normalized 父链）。 */
const PARENT = {
  Hips: null, Spine: 'Hips', Chest: 'Spine', UpperChest: 'Chest',
  Neck: 'UpperChest', Head: 'Neck',
  LeftShoulder: 'UpperChest', LeftUpperArm: 'LeftShoulder',
  LeftLowerArm: 'LeftUpperArm', LeftHand: 'LeftLowerArm',
  RightShoulder: 'UpperChest', RightUpperArm: 'RightShoulder',
  RightLowerArm: 'RightUpperArm', RightHand: 'RightLowerArm',
  LeftUpperLeg: 'Hips', LeftLowerLeg: 'LeftUpperLeg',
  LeftFoot: 'LeftLowerLeg', LeftToes: 'LeftFoot',
  RightUpperLeg: 'Hips', RightLowerLeg: 'RightUpperLeg',
  RightFoot: 'RightLowerLeg', RightToes: 'RightFoot',
  LeftEye: 'Head', RightEye: 'Head', Jaw: 'Head'
}
for (const side of ['Left', 'Right']) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    for (const [i, seg] of ['Proximal', 'Intermediate', 'Distal'].entries()) {
      PARENT[`${side}${finger}${seg}`] = i === 0 ? `${side}Hand` : `${side}${finger}${i === 1 ? 'Proximal' : 'Intermediate'}`
    }
  }
}

const FINGER_RE = /Thumb|Index|Middle|Ring|Little/
const isFinger = (name) => FINGER_RE.test(name)
const BODY22 = [
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'
]
/** 受「目标缺 upperChest」影响的骨：normalized parent 在缺 upperChest 的模型上会落到 chest。 */
const UPPERCHEST_DEP = new Set(['Neck', 'LeftShoulder', 'RightShoulder'])

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

function nearestParent(name, present) {
  let p = PARENT[name]
  while (p != null && !present.has(p)) p = PARENT[p]
  return p
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listGtClips(gtDir) {
  const out = {}
  for (const fn of fs.readdirSync(gtDir)) {
    if (!fn.endsWith('.json') || fn.endsWith('-rest.json')) continue
    const d = readJson(path.join(gtDir, fn))
    if (d && typeof d.clip === 'string' && Array.isArray(d.bones)) out[d.clip] = d
  }
  return out
}

/** 计算每帧 normalized 旋转（Unity 坐标系），输出 glTF r 数组。 */
function normalizedTrack(gtClip, rest, boneName, frames) {
  const present = new Set(Object.keys(rest))
  const raw = Object.fromEntries(gtClip.bones.map((b) => [b.name, b.worldRot]))
  if (!raw[boneName]) return null
  const parent = nearestParent(boneName, present)
  const restOwn = rest[boneName]
  const restParent = parent ? rest[parent] : null
  const prev = []
  let prevQ = null
  for (let f = 0; f < frames; f++) {
    const w = raw[boneName].slice(f * 4, f * 4 + 4)
    const dw = qmul(w, qinv(restOwn))
    const dp = parent ? qmul(raw[parent].slice(f * 4, f * 4 + 4), qinv(restParent)) : [0, 0, 0, 1]
    let n = qmul(qinv(dp), dw)
    if (prevQ && qdot(prevQ, n) < 0) n = n.map((x) => -x)
    prevQ = n
    const g = unityToGltfQuat(n)
    prev.push(g.map((x) => Number(x.toFixed(6))))
  }
  return prev
}

function main() {
  const gtDir = path.resolve(String(arg('gt', 'work/finger-probe/out/unity')))
  const model = String(arg('model', 'zome'))
  const inDir = path.resolve(String(arg('in', 'assets/motions/mate')))
  const outDir = path.resolve(String(arg('out', 'work/finger-trial/clips')))
  const clipFilter = String(arg('clips', '') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const reportPath = arg('report', null)

  const restFile = path.join(gtDir, `${model}-rest.json`)
  if (!fs.existsSync(restFile)) throw new Error(`GT rest not found: ${restFile}`)
  const restGt = readJson(restFile)
  const rest = Object.fromEntries(restGt.bones.map((b) => [b.name, b.worldRot]))
  const present = new Set(Object.keys(rest))
  const gtClips = listGtClips(gtDir)
  fs.mkdirSync(outDir, { recursive: true })

  const report = { gtDir, model, inDir, outDir, clips: {} }
  let merged = 0
  for (const [name, gt] of Object.entries(gtClips)) {
    if (clipFilter.length && !clipFilter.includes(name)) continue
    const bakedPath = path.join(inDir, `${name}.json`)
    if (!fs.existsSync(bakedPath)) {
      console.log(`[merge] skip ${name}: no baked clip ${bakedPath}`)
      continue
    }
    const baked = readJson(bakedPath)
    if (baked.frames !== gt.frames) {
      console.log(`[merge] skip ${name}: frames mismatch baked=${baked.frames} gt=${gt.frames}`)
      continue
    }
    const frames = gt.frames
    const clip = JSON.parse(JSON.stringify(baked))
    const fingerStats = {}
    for (const bone of present) {
      if (!isFinger(bone)) continue
      const r = normalizedTrack(gt, rest, bone, frames)
      if (!r) continue
      clip.bones[bone] = { r }
      const bend = r.map((q) => qAngleDeg(q))
      let maxMove = 0
      for (let f = 0; f < frames; f++) maxMove = Math.max(maxMove, qAngleBetweenDeg(r[0], r[f]))
      fingerStats[bone] = { maxBendDeg: Number(Math.max(...bend).toFixed(2)), maxMoveDeg: Number(maxMove.toFixed(2)) }
    }
    // 护栏：用同一公式重算 body22，与已烘焙 r 对比（跳过 upperChest 相关骨）
    const bodyDiffs = []
    for (const bone of BODY22) {
      if (!present.has(bone) || bone === 'UpperChest' || UPPERCHEST_DEP.has(bone)) continue
      if (!baked.bones[bone] || !baked.bones[bone].r) continue
      const r = normalizedTrack(gt, rest, bone, frames)
      if (!r) continue
      for (let f = 0; f < frames; f++) bodyDiffs.push(qAngleBetweenDeg(r[f], baked.bones[bone].r[f]))
    }
    const bodyMean = bodyDiffs.reduce((a, b) => a + b, 0) / Math.max(1, bodyDiffs.length)
    const bodyMax = bodyDiffs.reduce((a, b) => Math.max(a, b), 0)
    if (bodyMean > 5) console.warn(`[merge] WARN ${name}: body22 校验平均差 ${bodyMean.toFixed(2)}°（>5°，请检查 GT/model）`)
    clip.fingerSource = { tool: 'merge-finger-tracks.mjs', model, gtFrames: frames }
    const outFile = path.join(outDir, `${name}.json`)
    fs.writeFileSync(outFile, JSON.stringify(clip, null, 2))
    const allBend = Math.max(...Object.values(fingerStats).map((s) => s.maxBendDeg))
    const allMove = Math.max(...Object.values(fingerStats).map((s) => s.maxMoveDeg))
    report.clips[name] = { frames, body22MeanDiffDeg: Number(bodyMean.toFixed(2)), body22MaxDiffDeg: Number(bodyMax.toFixed(2)),
      fingerAllMaxBendDeg: allBend, fingerAllMaxMoveDeg: allMove, fingerStats }
    console.log(`[merge] ${name}: +30 finger tracks (${frames}f), body22 diff mean=${bodyMean.toFixed(2)}° max=${bodyMax.toFixed(2)}°, ` +
      `finger bend≤${allBend.toFixed(1)}° move≤${allMove.toFixed(1)}° -> ${outFile}`)
    merged += 1
  }
  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(String(reportPath))), { recursive: true })
    fs.writeFileSync(String(reportPath), JSON.stringify(report, null, 2))
  }
  console.log(`[merge] done: ${merged} clip(s) -> ${outDir}`)
}

main()
