#!/usr/bin/env node
/**
 * 比例感知肩/臂重定向 bake 原型（源视觉姿态保持；只改手臂链，不碰 legs/hips/脚/手指）
 *
 * 用 Zome 女体源 rest + clip normalized 旋转做「源视觉姿态」，按 hips→head 躯干长
 * 归一化后映射到目标男体，再逐帧求锁骨 aim + 两骨手臂 IK；Hand/手指 normalized 旋转
 * 原样保留。输出新 clip JSON（不覆盖 assets/motions/mate 原文件）。
 *
 * 用法：
 *   node scripts/unity-bake/proportion-retarget.mjs \
 *     --source "refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.vrm" \
 *     --target assets/vrm/aventurine-tpose.vrm \
 *     --clips sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4 \
 *     --out tests/tmp/lead-proportion/clips-absolute \
 *     --metrics tests/tmp/lead-proportion/metrics-absolute.json \
 *     --summary tests/tmp/lead-proportion/summary-absolute.md \
 *     --socket-mode chest-displacement
 *
 * `--socket-mode absolute` = 任务 §3 的字面口径（源肩窝绝对位置 × torso 比例）；
 * `--socket-mode chest-displacement`（推荐）= 目标 rest 锁骨向量 + 源锁骨局部旋转位移 × torso 比例；
 * `--socket-mode displacement` = 目标 posed torso 系位移（诊断变体）。三种都只写 tests/tmp。
 *
 * 重要坐标口径：源侧用 canonical Zome rest（`VRMUtils.rotateVRM0` 后的 normalized rest）
 * + clip q **直接**做 FK。这等价于 Unity 在 Zome 上的源姿态（已用 wave15 Unity GT 的
 * hideLeft/idle @ frame 0 验证相对 hips 位置 <1cm）；**不要**用 three-vrm 的 VRM0 场景旋转
 * 重放路径（`rawRest + q` 后再 rotateY(π)）——那样会把不对称 clip 的左右镜像，得到错误的
 * 「源姿态」。
 *
 * 私有资产只读；产出只写 --out / --metrics / --summary。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Vector3, Quaternion } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'
import { CLIP_BONE_NAMES, CLIP_OPTIONAL_BONES, UNITY_TO_VRM_BONE } from './lib/humanoid-map.mjs'
import { validateClipData } from './lib/clip-validation.mjs'
import {
  ARM_TORSO_BONES,
  deriveProportions,
  forwardKinematics,
  quatAngleDeg,
  quatConjugate,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  retargetClip,
  vDist,
  vSub
} from './lib/proportion-retarget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_SOURCE = 'refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.vrm'
const DEFAULT_TARGET = 'assets/vrm/aventurine-tpose.vrm'
const DEFAULT_CLIPS = 'sit1,sit2,windowLay8,windowLay9,windowLay10,sitWindow,sleep,hideLeft,idle,idle4'
const DEFAULT_GT_SOURCE_DIR = 'tests/tmp/wave15/groundtruth/unity'
const DEFAULT_GT_TARGET_DIR = 'tests/tmp/lead-shoulder/gt-male/out/unity'
const GT_SOURCE_PREFIX = 'zome'
const GT_TARGET_PREFIX = 'aventurine-tpose'

const OPTIONS = {
  source: { type: 'string', default: DEFAULT_SOURCE, valueHint: 'zome.vrm', description: '源 VRM 路径（Zome）' },
  target: { type: 'string', default: DEFAULT_TARGET, valueHint: 'avatar.vrm', description: '目标 VRM 路径' },
  clips: { type: 'string', default: DEFAULT_CLIPS, valueHint: 'a,b,c', description: '逗号分隔 clip 名' },
  motions: { type: 'string', default: 'assets/motions/mate', valueHint: 'dir', description: '源 clip 目录' },
  out: { type: 'string', default: 'tests/tmp/lead-proportion/clips', valueHint: 'dir', description: '输出 clip 目录' },
  metrics: { type: 'string', default: 'tests/tmp/lead-proportion/metrics.json', valueHint: 'file', description: '指标 JSON' },
  summary: { type: 'string', default: 'tests/tmp/lead-proportion/summary.md', valueHint: 'file', description: 'Markdown 汇总' },
  'socket-mode': { type: 'string', default: 'absolute', valueHint: 'absolute|chest-displacement|displacement', description: '肩窝期望模式（absolute=任务口径；chest-displacement=备选）' },
  'reach-ratio': { type: 'string', default: '0.98', valueHint: '0.98', description: '不可达时 wrist clamp 比例' },
  'max-shoulder-local': { type: 'string', default: '30', valueHint: 'deg', description: '锁骨局部角安全上限（0=关闭）' },
  'source-rest': { type: 'string', valueHint: 'rest.json', description: '可选：Unity GT rest JSON（x 取反到 canonical）代替解析 VRM' },
  'target-rest': { type: 'string', valueHint: 'rest.json', description: '可选：目标 rest JSON' },
  'gt-source-dir': { type: 'string', default: DEFAULT_GT_SOURCE_DIR, valueHint: 'dir', description: '源 Unity GT 目录' },
  'gt-target-dir': { type: 'string', default: DEFAULT_GT_TARGET_DIR, valueHint: 'dir', description: '目标 Unity GT 目录' },
  'no-gt': { type: 'boolean', default: false, description: '跳过与 Unity GT 的对比' },
  'no-write': { type: 'boolean', default: false, description: '只算指标，不写 clip 文件' }
}

const HELP = formatHelp({
  command: 'node scripts/unity-bake/proportion-retarget.mjs',
  description: '比例感知肩/臂重定向：源 Zome 视觉姿态 → 目标男体期望关节位置 → 锁骨 aim + 两骨 IK。',
  usage: 'node scripts/unity-bake/proportion-retarget.mjs --clips a,b,c --out DIR --metrics FILE [--socket-mode absolute|displacement]',
  options: OPTIONS,
  footer: '只写 --out/--metrics/--summary；不覆盖 assets/motions/mate 原文件，不做 git add/commit。'
})

/* -------------------------------------------------------------------------- */
/* VRM / rest                                                                  */
/* -------------------------------------------------------------------------- */

/** 从 VRM 读 canonical normalized rest（VRM0 先 rotateVRM0；只取世界位置）。 */
async function loadVrmRest(file) {
  const buf = readFileSync(file)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)).replace(/\u0000+$/g, '').trim())
  // 去掉贴图/材质，避免 Node 下 GLTFLoader 加载纹理
  delete json.images
  delete json.textures
  delete json.samplers
  for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) delete prim.material
  const binLenPos = 12 + 8 + jsonLen
  const binLen = view.getUint32(binLenPos, true)
  const binStart = binLenPos + 8
  const bin = buf.subarray(binStart, binStart + binLen)
  const textBytes = new TextEncoder().encode(JSON.stringify(json))
  const pad4 = (n) => Math.ceil(n / 4) * 4
  const paddedText = pad4(textBytes.length)
  const paddedBin = pad4(bin.length)
  const total = 12 + 8 + paddedText + 8 + paddedBin
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true)
  dv.setUint32(12, paddedText, true); dv.setUint32(16, 0x4e4f534a, true)
  out.set(textBytes, 20); out.fill(0x20, 20 + textBytes.length, 20 + paddedText)
  const binOff = 20 + paddedText
  dv.setUint32(binOff, paddedBin, true); dv.setUint32(binOff + 4, 0x004e4942, true)
  out.set(bin, binOff + 8)
  const vrm = await new Promise((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.parse(out.buffer, ROOT + '/', (gltf) => resolve(gltf.userData.vrm), reject)
  })
  if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm)
  vrm.scene.updateMatrixWorld(true)
  const rest = {}
  for (const bone of CLIP_BONE_NAMES) {
    const node = vrm.humanoid.getNormalizedBoneNode(UNITY_TO_VRM_BONE[bone])
    if (!node) continue
    const p = new Vector3()
    node.getWorldPosition(p)
    rest[bone] = [p.x, p.y, p.z]
  }
  return rest
}

/** 读 Unity GT rest JSON → canonical rest（Unity → three：x 取反，y/z 不变）。 */
function loadRestJson(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const rest = {}
  for (const bone of data.bones ?? []) {
    if (!Array.isArray(bone.worldPos) || bone.worldPos.length < 3) continue
    rest[bone.name] = [-bone.worldPos[0], bone.worldPos[1], bone.worldPos[2]]
  }
  return rest
}

/* -------------------------------------------------------------------------- */
/* clip / JSON                                                                 */
/* -------------------------------------------------------------------------- */

function readClip(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`clip 解析失败：${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Number.isInteger(parsed?.frames) || parsed.frames <= 0) throw new Error(`clip.frames 非法：${file}`)
  return parsed
}

/** 编码为 nested 四元数数组（与 mate 原始数据形状一致）。 */
function encodeNested(quats) {
  return quats.map((q) => [q[0], q[1], q[2], q[3]])
}

/** 单条轨道的单位化最大误差 / 相邻帧最大角 / loop seam（仅用于 modified bones）。 */
function trackStats(quats, loop) {
  let unitMax = 0
  let jumpMax = 0
  for (const q of quats) unitMax = Math.max(unitMax, Math.abs(Math.hypot(...q) - 1))
  for (let i = 1; i < quats.length; i += 1) jumpMax = Math.max(jumpMax, quatAngleDeg(quatMultiply(quatConjugate(quats[i - 1]), quats[i])))
  const seam = loop && quats.length > 1
    ? quatAngleDeg(quatMultiply(quatConjugate(quats[0]), quats[quats.length - 1]))
    : null
  return { unitMax, jumpMax, seam }
}

/* -------------------------------------------------------------------------- */
/* Unity GT 对比（hips-local，去掉 root placement / 全局常量旋转）              */
/* -------------------------------------------------------------------------- */

const GT_BONES = ['Hips', 'Chest', 'Neck', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand']

const mapPos = (p) => [-p[0], p[1], p[2]]
/** M = diag(-1,1,1)（det=-1）：axis' = det·M·axis = (ax, -ay, -az)。 */
const mapQuat = (q) => [q[0], -q[1], -q[2], q[3]]

function readGt(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const bones = new Map()
  for (const b of data.bones ?? []) bones.set(b.name, b)
  return { frames: data.frames ?? 1, bones }
}

function gtVec(bone, worldPos, f) {
  const arr = bone?.worldPos
  if (!Array.isArray(arr)) return null
  const i = arr.length === 3 ? 0 : f * 3
  return [arr[i], arr[i + 1], arr[i + 2]]
}

function gtQuat(bone, worldRot, f) {
  const arr = bone?.worldRot
  if (!Array.isArray(arr)) return null
  const i = arr.length === 4 ? 0 : f * 4
  return [arr[i], arr[i + 1], arr[i + 2], arr[i + 3]]
}

/** 把 pose（世界位置/world delta）转成 hips-local；返回 Map bone → {pos, rotLocal}。 */
function hipsLocal(pose, bones = GT_BONES) {
  const hipsPos = pose.positions.Hips
  const hipsQuat = pose.deltas.Hips
  const inv = quatConjugate(hipsQuat)
  const out = new Map()
  for (const bone of bones) {
    const p = pose.positions[bone]
    const d = pose.deltas[bone]
    if (!p || !d) continue
    out.set(bone, {
      pos: quatRotateVec(inv, vSub(p, hipsPos)),
      rot: quatMultiply(inv, d)
    })
  }
  return out
}

/** GT clip → hips-local（Unity → canonical three，再按 GT hips 去 root）。 */
function gtHipsLocal(gt, f, bones = GT_BONES) {
  const hipsPosRaw = gtVec(gt.bones.get('Hips'), 'worldPos', f)
  const hipsRotRaw = gtQuat(gt.bones.get('Hips'), 'worldRot', f)
  if (!hipsPosRaw || !hipsRotRaw) return null
  const hipsPos = mapPos(hipsPosRaw)
  const hipsQuat = quatNormalize(mapQuat(hipsRotRaw))
  const inv = quatConjugate(hipsQuat)
  const out = new Map()
  for (const bone of bones) {
    const b = gt.bones.get(bone)
    const pRaw = gtVec(b, 'worldPos', f)
    const qRaw = gtQuat(b, 'worldRot', f)
    if (!pRaw || !qRaw) continue
    out.set(bone, {
      pos: quatRotateVec(inv, vSub(mapPos(pRaw), hipsPos)),
      rot: quatMultiply(inv, quatNormalize(mapQuat(qRaw)))
    })
  }
  return out
}

/** 对一段 pose 与 GT 逐帧比 hips-local 位置/旋转；返回 summary（无 GT 返回 null）。 */
function comparePoseToGt(poseAtFrame, gt, frames, label) {
  const n = Math.min(frames, gt.frames)
  const stride = Math.max(1, Math.floor(n / 12))
  const perBone = {}
  for (const bone of GT_BONES) perBone[bone] = { rot: [], pos: [] }
  let samples = 0
  for (let f = 0; f < n; f += stride) {
    const ours = poseAtFrame(f)
    const theirs = gtHipsLocal(gt, f)
    if (!ours || !theirs) continue
    samples += 1
    for (const bone of GT_BONES) {
      const a = ours.get(bone)
      const b = theirs.get(bone)
      if (!a || !b) continue
      perBone[bone].rot.push(quatAngleDeg(quatMultiply(quatConjugate(b.rot), a.rot)))
      perBone[bone].pos.push(vDist(a.pos, b.pos) * 100)
    }
  }
  const summary = {}
  for (const bone of GT_BONES) {
    const r = perBone[bone].rot
    const p = perBone[bone].pos
    if (r.length === 0) continue
    const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
    summary[bone] = {
      rotMeanDeg: mean(r),
      rotMaxDeg: Math.max(...r),
      posMeanCm: mean(p),
      posMaxCm: Math.max(...p)
    }
  }
  return { label, samples, bones: summary }
}

function pickGtSummary(cmp, bones = ['Chest', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand']) {
  if (!cmp) return null
  const out = {}
  for (const bone of bones) if (cmp.bones[bone]) out[bone] = cmp.bones[bone]
  return out
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0)
const maxOf = (arr) => (arr.length ? Math.max(...arr) : 0)
const fmt = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—')

async function main() {
  const { values, errors, sawHelp } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) { console.log(HELP); process.exit(0) }
  if (errors.length) { console.error(errors.join('\n')); console.error('\n' + HELP); process.exit(2) }

  const socketMode = String(values['socket-mode'])
  if (!['absolute', 'chest-displacement', 'displacement'].includes(socketMode)) {
    console.error(`--socket-mode 只接受 absolute|chest-displacement|displacement（收到 ${socketMode}）`)
    process.exit(2)
  }
  const reachRatio = Number(values['reach-ratio'])
  const maxShoulderLocal = Number(values['max-shoulder-local'])
  if (!Number.isFinite(reachRatio) || reachRatio <= 0 || reachRatio > 1) {
    console.error(`--reach-ratio 必须在 (0,1]（收到 ${values['reach-ratio']}）`)
    process.exit(2)
  }
  if (!Number.isFinite(maxShoulderLocal) || maxShoulderLocal < 0) {
    console.error(`--max-shoulder-local 必须 ≥0（收到 ${values['max-shoulder-local']}）`)
    process.exit(2)
  }

  const sourcePath = path.resolve(ROOT, String(values.source))
  const targetPath = path.resolve(ROOT, String(values.target))
  const sourceRestPath = values['source-rest'] ? path.resolve(ROOT, String(values['source-rest'])) : null
  const targetRestPath = values['target-rest'] ? path.resolve(ROOT, String(values['target-rest'])) : null
  if (!sourceRestPath && !existsSync(sourcePath)) { console.error(`源 VRM 不存在：${sourcePath}`); process.exit(1) }
  if (!targetRestPath && !existsSync(targetPath)) { console.error(`目标 VRM 不存在：${targetPath}`); process.exit(1) }
  if (sourceRestPath && !existsSync(sourceRestPath)) { console.error(`源 rest JSON 不存在：${sourceRestPath}`); process.exit(1) }
  if (targetRestPath && !existsSync(targetRestPath)) { console.error(`目标 rest JSON 不存在：${targetRestPath}`); process.exit(1) }

  console.log(`[proportion] source=${sourceRestPath ?? path.relative(ROOT, sourcePath)}`)
  console.log(`[proportion] target=${targetRestPath ?? path.relative(ROOT, targetPath)}`)
  console.log(`[proportion] socket=${socketMode}, reach=${reachRatio}, maxShoulderLocal=${maxShoulderLocal || 'off'}`)

  const sourceRest = sourceRestPath ? loadRestJson(sourceRestPath) : await loadVrmRest(sourcePath)
  const targetRest = targetRestPath ? loadRestJson(targetRestPath) : await loadVrmRest(targetPath)
  const proportions = deriveProportions(sourceRest, targetRest)
  console.log(`[proportion] torso ${fmt(proportions.sourceTorsoLengthM * 100, 1)}cm → ${fmt(proportions.targetTorsoLengthM * 100, 1)}cm ` +
    `(scale ${fmt(proportions.torsoScale, 3)}); clavicle ${fmt(proportions.sourceClavicleLengthM * 100, 1)}→${fmt(proportions.targetClavicleLengthM * 100, 1)}cm ` +
    `(${fmt(proportions.clavicleScale, 2)}×); arm ${fmt(proportions.armScale, 2)}×`)

  const clips = String(values.clips).split(',').map((s) => s.trim()).filter(Boolean)
  if (clips.length === 0) { console.error('没有 clip'); process.exit(2) }
  const motionsDir = path.resolve(ROOT, String(values.motions))
  const outDir = path.resolve(ROOT, String(values.out))
  const metricsFile = path.resolve(ROOT, String(values.metrics))
  const summaryFile = path.resolve(ROOT, String(values.summary))
  if (!values['no-write']) mkdirSync(outDir, { recursive: true })
  mkdirSync(path.dirname(metricsFile), { recursive: true })
  mkdirSync(path.dirname(summaryFile), { recursive: true })

  const noGt = values['no-gt'] === true
  const gtSourceDir = path.resolve(ROOT, String(values['gt-source-dir']))
  const gtTargetDir = path.resolve(ROOT, String(values['gt-target-dir']))

  const results = []
  for (const clipName of clips) {
    const file = path.join(motionsDir, `${clipName}.json`)
    if (!existsSync(file)) { console.error(`[proportion] 缺 clip：${file}`); process.exit(1) }
    const clip = readClip(file)
    const startedAt = Date.now()
    const retargeted = retargetClip(clip, {
      sourceRest,
      targetRest,
      options: {
        socketMode,
        reachRatio,
        minElbowFlexDeg: 10,
        maxElbowFlexDeg: 150,
        maxShoulderLocalDeg: maxShoulderLocal
      }
    })
    const frames = clip.frames
    const loop = clip.loop === true

    // 原 clip 的 FK：用于 before/after 统计
    const sourceTracks = {}
    for (const bone of ARM_TORSO_BONES) sourceTracks[bone] = new Array(frames)
    for (let f = 0; f < frames; f += 1) {
      for (const bone of ARM_TORSO_BONES) {
        const track = clip.bones?.[bone]?.r
        let q = [0, 0, 0, 1]
        if (Array.isArray(track)) {
          const nested = Array.isArray(track[0])
          const raw = nested ? track[f] : track.slice(f * 4, f * 4 + 4)
          if (Array.isArray(raw) && raw.length === 4 && raw.every((v) => typeof v === 'number' && Number.isFinite(v))) q = quatNormalize(raw)
        }
        sourceTracks[bone][f] = q
      }
    }
    const originalRotationsAt = (f) => Object.fromEntries(ARM_TORSO_BONES.map((b) => [b, sourceTracks[b][f]]))
    const afterRotationsAt = (f) => {
      const rotations = originalRotationsAt(f)
      for (const bone of Object.keys(retargeted.tracks)) rotations[bone] = retargeted.tracks[bone][f]
      return rotations
    }

    // 输出 clip
    const outClip = JSON.parse(JSON.stringify(clip))
    for (const bone of Object.keys(retargeted.tracks)) {
      if (!outClip.bones[bone]) outClip.bones[bone] = {}
      outClip.bones[bone].r = encodeNested(retargeted.tracks[bone])
    }
    outClip.proportionRetarget = {
      version: 1,
      tool: 'scripts/unity-bake/proportion-retarget.mjs',
      source: path.relative(ROOT, sourcePath),
      target: path.relative(ROOT, targetPath),
      socketMode,
      reachRatio,
      maxShoulderLocalDeg: maxShoulderLocal,
      torsoScale: proportions.torsoScale,
      sourceTorsoLengthM: proportions.sourceTorsoLengthM,
      targetTorsoLengthM: proportions.targetTorsoLengthM,
      clavicleScale: proportions.clavicleScale,
      armScale: proportions.armScale,
      generatedAt: new Date().toISOString()
    }

    // 校验输出
    const validation = validateClipData(outClip, { optionalBones: CLIP_OPTIONAL_BONES })
    // 轨道级检查
    const modified = ['LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'RightShoulder', 'RightUpperArm', 'RightLowerArm']
    const trackChecks = {}
    let unitMax = 0
    let jumpMax = 0
    let seamBeforeMax = 0
    let seamAfterMax = 0
    for (const bone of modified) {
      const after = trackStats(retargeted.tracks[bone], loop)
      const before = trackStats(sourceTracks[bone], loop)
      trackChecks[bone] = { after, before }
      unitMax = Math.max(unitMax, after.unitMax)
      jumpMax = Math.max(jumpMax, after.jumpMax)
      if (after.seam !== null) seamAfterMax = Math.max(seamAfterMax, after.seam)
      if (before.seam !== null) seamBeforeMax = Math.max(seamBeforeMax, before.seam)
    }

    // 汇总逐帧指标
    const summary = retargeted.summary
    const left = summary.sides.Left
    const right = summary.sides.Right
    const sideAgg = (key) => Math.max(left[key]?.max ?? 0, right[key]?.max ?? 0)
    const reachClampedFrames = retargeted.frameMetrics.reduce((n, row) =>
      n + (row.sides.Left.reachClamped ? 1 : 0) + (row.sides.Right.reachClamped ? 1 : 0), 0)
    const shoulderCappedFrames = retargeted.frameMetrics.reduce((n, row) =>
      n + (row.sides.Left.shoulderCapped ? 1 : 0) + (row.sides.Right.shoulderCapped ? 1 : 0), 0)

    // 与 Unity GT 对比（hips-local）
    let gtSource = null
    let gtTargetBefore = null
    let gtTargetAfter = null
    if (!noGt) {
      const srcGtFile = path.join(gtSourceDir, `${GT_SOURCE_PREFIX}-${clipName}.json`)
      const tgtGtFile = path.join(gtTargetDir, `${GT_TARGET_PREFIX}-${clipName}.json`)
      if (existsSync(srcGtFile)) {
        const gt = readGt(srcGtFile)
        gtSource = comparePoseToGt((f) => hipsLocal(forwardKinematics(sourceRest, originalRotationsAt(f))), gt, frames, 'source')
      }
      if (existsSync(tgtGtFile)) {
        const gt = readGt(tgtGtFile)
        gtTargetBefore = comparePoseToGt((f) => hipsLocal(forwardKinematics(targetRest, originalRotationsAt(f))), gt, frames, 'target-before')
        gtTargetAfter = comparePoseToGt((f) => hipsLocal(forwardKinematics(targetRest, afterRotationsAt(f))), gt, frames, 'target-after')
      }
    }

    const row = {
      clip: clipName,
      frames,
      loop,
      durationSec: clip.duration ?? null,
      computeMs: Date.now() - startedAt,
      validation: {
        ok: validation.ok,
        errors: validation.errors,
        warnings: validation.warnings,
        stats: validation.stats
      },
      tracks: {
        unitMaxError: unitMax,
        frameJumpMaxDeg: jumpMax,
        loopSeamBeforeMaxDeg: loop ? seamBeforeMax : null,
        loopSeamAfterMaxDeg: loop ? seamAfterMax : null,
        perBone: trackChecks
      },
      metrics: {
        shoulderLocalAfterMaxDeg: sideAgg('shoulderLocalDegAfter'),
        shoulderLocalSourceMaxDeg: sideAgg('shoulderLocalDegSource'),
        shoulderLocalBeforeMaxDeg: sideAgg('shoulderLocalDegBefore'),
        socketLiftMaxCm: Math.max(left.socketLiftCm.max, right.socketLiftCm.max),
        socketLiftMinCm: Math.min(left.socketLiftCm.min, right.socketLiftCm.min),
        socketErrorMaxCm: Math.max(left.socketErrorCm.max, right.socketErrorCm.max),
        socketHeightErrMaxCm: Math.max(
          ...retargeted.frameMetrics.flatMap((r) => ['Left', 'Right'].map((s) =>
            Math.abs(r.sides[s].socketHeightAboveChestAfterCm - r.sides[s].socketHeightAboveChestExpectedCm)))
        ),
        socketHalfWidthErrMaxCm: Math.max(
          ...retargeted.frameMetrics.flatMap((r) => ['Left', 'Right'].map((s) =>
            Math.abs(r.sides[s].socketHalfWidthAfterCm - r.sides[s].socketHalfWidthExpectedCm)))
        ),
        handErrorMaxCm: Math.max(left.handErrorCm.max, right.handErrorCm.max),
        handErrorMeanCm: (left.handErrorCm.mean + right.handErrorCm.mean) / 2,
        handShiftMaxCm: Math.max(left.handShiftCm.max, right.handShiftCm.max),
        armDirChangeMaxDeg: Math.max(left.upperArmDirChangeDeg.max, right.upperArmDirChangeDeg.max),
        armDirVsSourceMaxDeg: Math.max(left.upperArmDirVsSourceDeg.max, right.upperArmDirVsSourceDeg.max),
        handWorldDeltaMaxDeg: Math.max(left.handWorldDeltaDeg.max, right.handWorldDeltaDeg.max),
        elbowFlexAfterRange: [Math.min(left.elbowFlexDegAfter.min, right.elbowFlexDegAfter.min), Math.max(left.elbowFlexDegAfter.max, right.elbowFlexDegAfter.max)],
        reachClampedFrames,
        shoulderCappedFrames,
        aPoseHorizontalAngleChangeMaxDeg: Math.max(left.upperArmHorizontalAngleChangeDeg.max, right.upperArmHorizontalAngleChangeDeg.max),
        aPoseWorldHorizontalAngleChangeMaxDeg: Math.max(left.upperArmWorldHorizontalAngleChangeDeg.max, right.upperArmWorldHorizontalAngleChangeDeg.max),
        handTorsoAxisDistMinCm: Math.min(left.handTorsoAxisDistCm.min, right.handTorsoAxisDistCm.min),
        handTorsoAxisDistMaxCm: Math.max(left.handTorsoAxisDistCm.max, right.handTorsoAxisDistCm.max),
        handChestDistMinCm: Math.min(left.handChestDistCm.min, right.handChestDistCm.min),
        handChestDistMaxCm: Math.max(left.handChestDistCm.max, right.handChestDistCm.max)
      },
      gtSource: pickGtSummary(gtSource),
      gtTarget: {
        before: pickGtSummary(gtTargetBefore),
        after: pickGtSummary(gtTargetAfter)
      },
      proportions
    }
    results.push(row)

    if (!values['no-write']) {
      writeFileSync(path.join(outDir, `${clipName}.json`), JSON.stringify(outClip, null, 2) + '\n')
    }
    console.log(
      `[proportion] ${clipName.padEnd(12)} ${String(frames).padStart(4)}f ${String(row.computeMs).padStart(5)}ms ` +
      `socketLift ${fmt(row.metrics.socketLiftMinCm, 1)}..${fmt(row.metrics.socketLiftMaxCm, 1)}cm ` +
      `handErr ${fmt(row.metrics.handErrorMeanCm, 2)}cm(max ${fmt(row.metrics.handErrorMaxCm, 2)}) ` +
      `shoulder ${fmt(row.metrics.shoulderLocalBeforeMaxDeg, 1)}→${fmt(row.metrics.shoulderLocalAfterMaxDeg, 1)}°(src ${fmt(row.metrics.shoulderLocalSourceMaxDeg, 1)}) ` +
      `clamp ${row.metrics.reachClampedFrames}/${frames * 2} cap ${row.metrics.shoulderCappedFrames} ` +
      `valid=${validation.ok ? 'ok' : 'ERR'}`
    )
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    tool: 'scripts/unity-bake/proportion-retarget.mjs',
    options: {
      source: path.relative(ROOT, sourcePath),
      target: path.relative(ROOT, targetPath),
      sourceRest: sourceRestPath ? path.relative(ROOT, sourceRestPath) : null,
      targetRest: targetRestPath ? path.relative(ROOT, targetRestPath) : null,
      clips,
      socketMode,
      reachRatio,
      maxShoulderLocalDeg: maxShoulderLocal,
      out: path.relative(ROOT, outDir),
      gtSourceDir: noGt ? null : path.relative(ROOT, gtSourceDir),
      gtTargetDir: noGt ? null : path.relative(ROOT, gtTargetDir)
    },
    proportions,
    clips: results
  }
  writeFileSync(metricsFile, JSON.stringify(payload, null, 2) + '\n')
  writeFileSync(summaryFile, renderSummary(payload) + '\n')
  console.log(`[proportion] wrote ${results.length} clips → ${path.relative(ROOT, outDir) || '.'}`)
  console.log(`[proportion] metrics → ${path.relative(ROOT, metricsFile)}`)
  console.log(`[proportion] summary → ${path.relative(ROOT, summaryFile)}`)
}

function renderSummary(payload) {
  const p = payload.proportions
  const lines = []
  lines.push('# 比例感知肩/臂重定向（prototype）— 汇总')
  lines.push('')
  lines.push(`生成：${payload.generatedAt}；socketMode=\`${payload.options.socketMode}\`；` +
    `reachRatio=${payload.options.reachRatio}；maxShoulderLocal=${payload.options.maxShoulderLocalDeg}°（0=off）。`)
  lines.push('')
  lines.push('## 源/目标比例')
  lines.push('')
  lines.push('| 项 | 源 Zome | 目标男体 | 比例 |')
  lines.push('|---|---:|---:|---:|')
  lines.push(`| hips→head | ${fmt(p.sourceTorsoLengthM * 100, 2)}cm | ${fmt(p.targetTorsoLengthM * 100, 2)}cm | ${fmt(p.torsoScale, 3)}× |`)
  lines.push(`| 锁骨 | ${fmt(p.sourceClavicleLengthM * 100, 2)}cm | ${fmt(p.targetClavicleLengthM * 100, 2)}cm | ${fmt(p.clavicleScale, 2)}× |`)
  lines.push(`| 臂（upperArm→hand） | ${fmt(p.sourceArmLengthM * 100, 2)}cm | ${fmt(p.targetArmLengthM * 100, 2)}cm | ${fmt(p.armScale, 2)}× |`)
  lines.push(`| 肩点半宽 | ${fmt(p.sourceShoulderHalfWidthM * 100, 2)}cm | ${fmt(p.targetShoulderHalfWidthM * 100, 2)}cm | ${fmt(p.shoulderWidthScale, 2)}× |`)
  lines.push('')
  lines.push('## 逐 clip 指标')
  lines.push('')
  lines.push('| clip | 帧 | socket lift | 锁骨后(源) | 肩窝高误差 | 肩宽误差 | 手位误差 mean/max | 手位移 max | 手-躯干轴 cm | 上臂方向变化 | 手 world 变化 | reach clamp | 肩 cap | A-pose 体水平角变化 | A-pose 世界水平角变化 | loopSeam 前→后 | 单位化 err | 校验 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  for (const row of payload.clips) {
    const m = row.metrics
    lines.push([
      row.clip,
      row.frames,
      `${fmt(m.socketLiftMinCm, 1)}..${fmt(m.socketLiftMaxCm, 1)}cm`,
      `${fmt(m.shoulderLocalBeforeMaxDeg, 1)}→${fmt(m.shoulderLocalAfterMaxDeg, 1)}°(src ${fmt(m.shoulderLocalSourceMaxDeg, 1)})`,
      `${fmt(m.socketHeightErrMaxCm, 1)}cm`,
      `${fmt(m.socketHalfWidthErrMaxCm, 1)}cm`,
      `${fmt(m.handErrorMeanCm, 1)}/${fmt(m.handErrorMaxCm, 1)}cm`,
      `${fmt(m.handShiftMaxCm, 1)}cm`,
      `${fmt(m.handTorsoAxisDistMinCm, 1)}–${fmt(m.handTorsoAxisDistMaxCm, 1)}cm`,
      `${fmt(m.armDirChangeMaxDeg, 1)}°`,
      `${fmt(m.handWorldDeltaMaxDeg, 1)}°`,
      `${m.reachClampedFrames}/${row.frames * 2}`,
      `${m.shoulderCappedFrames}/${row.frames * 2}`,
      `${fmt(m.aPoseHorizontalAngleChangeMaxDeg, 1)}°`,
      `${fmt(m.aPoseWorldHorizontalAngleChangeMaxDeg, 1)}°`,
      row.tracks.loopSeamBeforeMaxDeg === null ? '—' : `${fmt(row.tracks.loopSeamBeforeMaxDeg, 2)}→${fmt(row.tracks.loopSeamAfterMaxDeg, 2)}°`,
      fmt(row.tracks.unitMaxError, 6),
      row.validation.ok ? 'ok' : `ERR(${row.validation.errors.length})`
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  lines.push('')
  lines.push('## 与 Unity GT（hips-local）')
  lines.push('')
  lines.push('`E_rot` / `E_hand`（cm）是相对 Unity 在对应 avatar 上播原 `.anim` 的 hips-local 差异；`target before` = 原 baked clip 在男体上的结果，`target after` = 本文重定向后的结果。**源 GT E_rot 非 0 是已知 baked clip 与 Unity 源 avatar 的肩部 fidelity 差（10–15°，§2.3），不是本次 FK 错**；源 GT E_pos 才是 FK 几何的 sanity check（应 <1–2cm）。')
  lines.push('')
  lines.push('| clip | 源 GT E_pos max | 源 GT E_rot mean/max | 男体 before E_hand | 男体 after E_hand | 男体 before E_rot(上臂) | 男体 after E_rot(上臂) |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const row of payload.clips) {
    const src = row.gtSource
    const before = row.gtTarget?.before
    const after = row.gtTarget?.after
    const agg = (obj, key) => {
      if (!obj) return null
      const vals = Object.values(obj).map((b) => b[key]).filter((v) => Number.isFinite(v))
      return vals.length ? { mean: vals.reduce((s, v) => s + v, 0) / vals.length, max: Math.max(...vals) } : null
    }
    const srcRot = agg(src, 'rotMaxDeg')
    const srcPos = src ? agg(src, 'posMaxCm') : null
    const bHand = before?.LeftHand?.posMaxCm ?? null
    const bHandR = before?.RightHand?.posMaxCm ?? null
    const aHand = after?.LeftHand?.posMaxCm ?? null
    const aHandR = after?.RightHand?.posMaxCm ?? null
    const bUa = Math.max(before?.LeftUpperArm?.rotMaxDeg ?? 0, before?.RightUpperArm?.rotMaxDeg ?? 0)
    const aUa = Math.max(after?.LeftUpperArm?.rotMaxDeg ?? 0, after?.RightUpperArm?.rotMaxDeg ?? 0)
    lines.push(`| ${row.clip} | ${srcPos ? `${fmt(srcPos.max, 2)}cm` : '—'} | ${srcRot ? `${fmt(srcRot.mean, 1)}/${fmt(srcRot.max, 1)}°` : '—'} | ${bHand === null ? '—' : `${fmt(Math.max(bHand, bHandR ?? 0), 1)}cm`} | ${aHand === null ? '—' : `${fmt(Math.max(aHand, aHandR ?? 0), 1)}cm`} | ${before ? `${fmt(bUa, 1)}°` : '—'} | ${after ? `${fmt(aUa, 1)}°` : '—'} |`)
  }
  lines.push('')
  lines.push('## 口径 / 风险')
  lines.push('')
  lines.push('- `socket lift` = 修正后 upperArm 关节点在目标 torso 系里相对修正前抬升；正数=抬肩（修溜肩）。')
  lines.push('- `锁骨后(源)` = 修正后最大锁骨局部角（源值）；`cap` = 超过安全上限的帧。')
  lines.push('- `肩窝高误差/肩宽误差` = 修正后 vs 目标映射期望（absolute 模式下期望是「源绝对位置×torso 比例」，可能短于/远于目标锁骨长）。')
  lines.push('- `手位误差` = 修正后 Hand 关节 vs 源绝对映射期望；不可达时按 98% reach clamp，误差会变大（身体比例差，不是管线错）。')
  lines.push('- `A-pose 水平角变化` = upperArm 骨段与 torso 水平面夹角的变化；idle 族应 ≤5°（任务闸门，见下行）。')
  lines.push('- `loopSeam` 只统计被改写的 6 根骨；单位化 err 应为 ~1e-16。')
  const idle = payload.clips.find((r) => r.clip === 'idle')
  if (idle) lines.push(`- **idle A-pose 水平角变化 = ${fmt(idle.metrics.aPoseHorizontalAngleChangeMaxDeg, 2)}°（体相对）/ ${fmt(idle.metrics.aPoseWorldHorizontalAngleChangeMaxDeg, 2)}°（世界）**；闸门 ≤5°：${idle.metrics.aPoseHorizontalAngleChangeMaxDeg <= 5 ? 'PASS' : 'FAIL（体相对）/ 见报告讨论'}。`)
  lines.push('- 源侧 FK 用 canonical Zome rest + clip q 直接计算（等价 Unity 源姿态）；不从 three-vrm VRM0 raw replay 取源（会镜像不对称 clip）。')
  lines.push('- sleep 的锁骨/手臂在躺姿下几何病态，建议单独 A/B；`cap` 帧数会显示是否触发安全上限。')
  return lines.join('\n')
}

main().catch((error) => {
  console.error('[proportion] FAIL:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
