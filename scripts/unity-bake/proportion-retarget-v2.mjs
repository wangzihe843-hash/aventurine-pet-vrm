#!/usr/bin/env node
/**
 * 比例感知肩/臂重定向 v2 —— dev-only bake CLI
 *
 * 变体：
 *   --variant s2-socket       S2-only，k = kSocket = (L_s/L_t)·(H_t/H_s)（几何归一化；约 0.714）
 *   --variant s2-slope        S2-only，k = 0.80（任务要求的视觉肩线斜率档）
 *   --variant s2-slope-exact  S2-only，k = 由肩线斜率公式数值解（约 0.857；诊断用）
 *   --variant hybrid          idle/gesture/S2；sit/windowLay/hide = S2 + 受限手 IK（保接触）
 *   --variant hybrid-slope    同上，k=0.80
 *   --variant hybrid-source   Hybrid 的 IK 目标改为源归一化绝对手位（仍限 3cm 修正）
 *
 * 只改 6 条手臂轨道（Shoulder/UpperArm/LowerArm）；Hand/手指/UpperChest/腿/hips 原样。
 * 输出只写 --out / --metrics / --summary；不碰 assets/motions/mate 原文件，不做 git 操作。
 *
 * 用法：
 *   node scripts/unity-bake/proportion-retarget-v2.mjs \
 *     --variant s2-socket \
 *     --clips idle,sit1,sitWindow \
 *     --out tests/tmp/lead-proportion-v2/clips-s2-socket \
 *     --metrics tests/tmp/lead-proportion-v2/metrics-s2-socket.json \
 *     --summary tests/tmp/lead-proportion-v2/summary-s2-socket.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

import { parseCliArgs, formatHelp } from './lib/cli-args.mjs'
import { CLIP_BONE_NAMES, CLIP_OPTIONAL_BONES, UNITY_TO_VRM_BONE } from './lib/humanoid-map.mjs'
import { validateClipData } from './lib/clip-validation.mjs'
import {
  ARM_TORSO_BONES,
  quatAngleDeg,
  quatConjugate,
  quatMultiply,
  quatNormalize
} from './lib/proportion-retarget.mjs'
import {
  CLIP_TAGS,
  DEFAULT_GUARDS,
  V2_MODIFIED_BONES,
  deriveS2Coefficients,
  retargetClipV2
} from './lib/proportion-retarget-v2.mjs'
import {
  V3_DEFAULT_GUARDS,
  V3_DEFAULTS,
  retargetClipV3
} from './lib/proportion-retarget-v3.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const DEFAULT_CLIPS = [
  'idle', 'idle2', 'idle3', 'idle4', 'idle5', 'idle6', 'idle7',
  'happy', 'laughing', 'shyPoint', 'pose1', 'pose2', 'pose3',
  'sit1', 'sit2', 'suwari3', 'sitWindow',
  'windowLay8', 'windowLay9', 'windowLay10',
  'hideLeft', 'hideOnce', 'sleep'
].join(',')

const VARIANTS = {
  's2-socket': { mode: 's2', kKind: 'socket', ikTarget: 'contact' },
  's2-slope': { mode: 's2', kKind: 'fixed', k: 0.8, ikTarget: 'contact' },
  's2-slope-exact': { mode: 's2', kKind: 'slope', ikTarget: 'contact' },
  hybrid: { mode: 'hybrid', kKind: 'socket', ikTarget: 'contact' },
  'hybrid-slope': { mode: 'hybrid', kKind: 'fixed', k: 0.8, ikTarget: 'contact' },
  'hybrid-source': { mode: 'hybrid', kKind: 'socket', ikTarget: 'source' },
  // v3：绝对肩高 + 可选受限手 IK（IK 目标 = 原 clip 男体手位）。
  's2-absolute': { mode: 'absolute', kKind: 'socket', ikTarget: 'contact', pipeline: 3, liftFraction: 1, partialIk: 1 },
  'hybrid-absolute': { mode: 'hybrid', kKind: 'socket', ikTarget: 'contact', pipeline: 3, liftFraction: 1, partialIk: 1 },
  'hybrid-absolute-blend': { mode: 'hybrid', kKind: 'socket', ikTarget: 'contact', pipeline: 3, liftFraction: 1, partialIk: 0.7 }
}

const OPTIONS = {
  source: { type: 'string', default: 'refs/Mate-Engine/Assets/MATE ENGINE - Avatar/Zome.vrm', valueHint: 'zome.vrm', description: '源 VRM（Zome）' },
  target: { type: 'string', default: 'assets/vrm/aventurine-tpose.vrm', valueHint: 'avatar.vrm', description: '目标 VRM' },
  clips: { type: 'string', default: DEFAULT_CLIPS, valueHint: 'a,b,c', description: '逗号分隔 clip 名' },
  motions: { type: 'string', default: 'assets/motions/mate', valueHint: 'dir', description: '源 clip 目录' },
  out: { type: 'string', default: 'tests/tmp/lead-proportion-v2/clips', valueHint: 'dir', description: '输出 clip 目录' },
  metrics: { type: 'string', default: 'tests/tmp/lead-proportion-v2/metrics.json', valueHint: 'file', description: '指标 JSON' },
  summary: { type: 'string', default: 'tests/tmp/lead-proportion-v2/summary.md', valueHint: 'file', description: 'Markdown 汇总' },
  variant: { type: 'string', default: 's2-socket', valueHint: Object.keys(VARIANTS).join('|'), description: '变体' },
  k: { type: 'string', valueHint: '0..1', description: '覆盖 k（默认按 variant）' },
  'source-rest': { type: 'string', valueHint: 'rest.json', description: '可选：源 rest JSON（Unity GT；x 取反）' },
  'target-rest': { type: 'string', valueHint: 'rest.json', description: '可选：目标 rest JSON' },
  'max-hand-correction': { type: 'string', valueHint: 'cm', description: 'Hybrid 手修正上限（v2 默认 3cm；v3 默认 4cm）' },
  'max-upperarm-change': { type: 'string', valueHint: 'deg', description: 'Hybrid 上臂方向变化 guard（v2 默认 3°；v3 默认 4°）' },
  'min-elbow': { type: 'string', default: String(DEFAULT_GUARDS.minElbowFlexDeg), valueHint: 'deg', description: 'Hybrid 肘屈下限' },
  'max-elbow': { type: 'string', default: String(DEFAULT_GUARDS.maxElbowFlexDeg), valueHint: 'deg', description: 'Hybrid 肘屈上限' },
  'reach-ratio': { type: 'string', default: String(DEFAULT_GUARDS.reachRatio), valueHint: '0.98', description: 'IK reach clamp' },
  'smooth-passes': { type: 'string', default: String(DEFAULT_GUARDS.weightSmoothPasses), valueHint: '2', description: 'Hybrid 时域平滑 pass 数（每 pass 5-tap）' },
  'lift-fraction': { type: 'string', default: '1', valueHint: '0..1', description: 'v3：绝对抬升量插值（0≈原样，1=全绝对）' },
  'shoulder-cap': { type: 'string', default: String(V3_DEFAULTS.maxShoulderLocalDeg), valueHint: 'deg', description: 'v3：锁骨局部角安全 cap（0=关闭）' },
  'partial-ik': { type: 'string', valueHint: '0..1', description: 'v3：手修正比例（默认 1；blend 变体 0.7）' },
  'no-write': { type: 'boolean', default: false, description: '只算指标，不写 clip 文件' }
}

const HELP = formatHelp({
  command: 'node scripts/unity-bake/proportion-retarget-v2.mjs',
  description: 'S2-only 锁骨预算转移 + 可选受限手 IK（Hybrid）。',
  usage: 'node scripts/unity-bake/proportion-retarget-v2.mjs --variant s2-socket --out DIR --metrics FILE [--clips a,b,c]',
  options: OPTIONS,
  footer: '只写 --out/--metrics/--summary；不覆盖 assets/motions/mate，不做 git add/commit。'
})

/* -------------------------------------------------------------------------- */
/* rest / clip I/O                                                             */
/* -------------------------------------------------------------------------- */

/** 从 VRM 读 canonical normalized rest（VRM0 先 rotateVRM0）。 */
async function loadVrmRest(file) {
  const buf = readFileSync(file)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const jsonLen = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)).replace(/\u0000+$/g, '').trim())
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

function loadRestJson(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const rest = {}
  for (const bone of data.bones ?? []) {
    if (!Array.isArray(bone.worldPos) || bone.worldPos.length < 3) continue
    rest[bone.name] = [-bone.worldPos[0], bone.worldPos[1], bone.worldPos[2]]
  }
  return rest
}

function readClip(file) {
  const clip = JSON.parse(readFileSync(file, 'utf8'))
  if (!Number.isInteger(clip?.frames) || clip.frames <= 0) throw new Error(`clip.frames 非法：${file}`)
  return clip
}

function encodeNested(quats) {
  return quats.map((q) => [q[0], q[1], q[2], q[3]])
}

/* -------------------------------------------------------------------------- */
/* 汇总                                                                        */
/* -------------------------------------------------------------------------- */

const fmt = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—')
const maxOf = (arr) => (arr.length ? Math.max(...arr) : 0)
const minOf = (arr) => (arr.length ? Math.min(...arr) : 0)
const meanOf = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0)

function sideAgg(summary, key, fn = 'max') {
  const vals = []
  for (const side of ['Left', 'Right']) {
    const v = summary?.sides?.[side]?.[key]?.[fn]
    if (Number.isFinite(v)) vals.push(v)
  }
  return vals.length ? Math.max(...vals) : null
}

function sideMin(summary, key) {
  const vals = []
  for (const side of ['Left', 'Right']) {
    const v = summary?.sides?.[side]?.[key]?.min
    if (Number.isFinite(v)) vals.push(v)
  }
  return vals.length ? Math.min(...vals) : null
}

function buildMetricRow(result, coefficients) {
  const summary = result.summary
  const sides = ['Left', 'Right']
  const all = (key, fn = 'max') => {
    const vals = []
    for (const side of sides) {
      const v = summary?.sides?.[side]?.[key]?.[fn]
      if (Number.isFinite(v)) vals.push(v)
    }
    return vals
  }
  const maxAll = (key) => (all(key).length ? Math.max(...all(key)) : null)
  const minAll = (key) => (all(key, 'min').length ? Math.min(...all(key, 'min')) : null)
  const meanAll = (key) => meanOf(all(key, 'mean'))
  return {
    shoulderLocalBeforeMaxDeg: maxAll('shoulderLocalDegBefore'),
    shoulderLocalAfterMaxDeg: maxAll('shoulderLocalDegAfter'),
    shoulderLocalAfterMeanDeg: meanAll('shoulderLocalDegAfter'),
    socketLiftMinCm: minAll('socketLiftCm'),
    socketLiftMaxCm: maxAll('socketLiftCm'),
    socketLiftMeanCm: meanAll('socketLiftCm'),
    socketShiftMaxCm: maxAll('socketShiftCm'),
    socketShiftXcm: maxAll('socketShiftXcm'),
    socketShiftYcm: maxAll('socketShiftYcm'),
    socketShiftZcm: maxAll('socketShiftZcm'),
    socketErrorVsSourceAbsMaxCm: maxAll('socketErrorVsSourceAbsCm'),
    handShiftMaxCm: maxAll('handShiftCm'),
    handShiftMeanCm: meanAll('handShiftCm'),
    handShiftYcm: maxAll('handShiftYcm'),
    upperArmWorldDeltaChangeMaxDeg: maxAll('upperArmWorldDeltaChangeDeg'),
    lowerArmWorldDeltaChangeMaxDeg: maxAll('lowerArmWorldDeltaChangeDeg'),
    handWorldDeltaChangeMaxDeg: maxAll('handWorldDeltaChangeDeg'),
    upperArmDirChangeMaxDeg: maxAll('upperArmDirChangeDeg'),
    aPoseBodyHorizontalChangeMaxDeg: maxAll('aPoseBodyHorizontalChangeDeg'),
    aPoseWorldHorizontalChangeMaxDeg: maxAll('aPoseWorldHorizontalChangeDeg'),
    normHeightErrBeforeMaxCm: maxAll('normHeightErrBeforeCm'),
    normHeightErrAfterMaxCm: maxAll('normHeightErrAfterCm'),
    normHeightErrBeforeMeanCm: meanAll('normHeightErrBeforeCm'),
    normHeightErrAfterMeanCm: meanAll('normHeightErrAfterCm'),
    socketDropNormErrBeforeMaxCm: maxAll('socketDropNormErrBeforeCm'),
    socketDropNormErrAfterMaxCm: maxAll('socketDropNormErrAfterCm'),
    socketDropNormErrBeforeMeanCm: meanAll('socketDropNormErrBeforeCm'),
    socketDropNormErrAfterMeanCm: meanAll('socketDropNormErrAfterCm'),
    clavicleDispNormErrBeforeMaxCm: maxAll('clavicleDispNormErrBeforeCm'),
    clavicleDispNormErrAfterMaxCm: maxAll('clavicleDispNormErrAfterCm'),
    socketHeightAboveChestSourceMinCm: minAll('socketHeightAboveChestSourceCm'),
    socketHeightAboveChestSourceMaxCm: maxAll('socketHeightAboveChestSourceCm'),
    socketHeightAboveChestBeforeMaxCm: maxAll('socketHeightAboveChestBeforeCm'),
    socketHeightAboveChestAfterMaxCm: maxAll('socketHeightAboveChestAfterCm'),
    clavicleElevationDiffSourceBeforeMaxDeg: maxAll('clavicleElevationDiffSourceBeforeDeg'),
    clavicleElevationDiffSourceAfterMaxDeg: maxAll('clavicleElevationDiffSourceAfterDeg'),
    shoulderSlopeDiffSourceBeforeMax: maxAll('shoulderSlopeDiffSourceBefore'),
    shoulderSlopeDiffSourceAfterMax: maxAll('shoulderSlopeDiffSourceAfter'),
    elbowFlexAfterMinDeg: minAll('elbowFlexAfterDeg'),
    elbowFlexAfterMaxDeg: maxAll('elbowFlexAfterDeg'),
    hybridAcceptedFrames: result.hybrid?.acceptedFrames ?? 0,
    hybridCandidateFrames: result.hybrid?.candidateFrames ?? 0,
    hybridMaxCorrectionCm: result.trackStats?.hybrid?.maxCorrectionCm ?? 0,
    hybridMaxUpperArmChangeDeg: result.trackStats?.hybrid?.maxUpperArmChangeDeg ?? 0,
    hybridElbowFlexRangeDeg: result.trackStats?.hybrid?.elbowFlexRangeDeg ?? null,
    // v3 专属口径（v2 结果里没有这些 key，值保持 null）。
    absoluteTargetLiftMaxCm: maxAll('absoluteTargetLiftCm'),
    absoluteTargetLiftMinCm: minAll('absoluteTargetLiftCm'),
    socketErrorVsAbsoluteTargetMaxCm: maxAll('socketErrorVsAbsoluteTargetCm'),
    socketErrorVsInterpolatedTargetMaxCm: maxAll('socketErrorVsInterpolatedTargetCm'),
    shoulderCapSideFrames: (summary?.sides?.Left?.shoulderCapHit?.count ?? 0) + (summary?.sides?.Right?.shoulderCapHit?.count ?? 0),
    upperArmBodyDirChangeMaxDeg: maxAll('upperArmBodyDirChangeDeg'),
    handFloatMaxCm: maxAll('handFloatCm'),
    handCorrectionFromAbsoluteMaxCm: maxAll('handCorrectionFromAbsoluteCm'),
    // 分侧（v3 推荐表用；v2 结果里为 null）
    handShiftLeftMaxCm: summary?.sides?.Left?.handShiftCm?.max ?? null,
    handShiftRightMaxCm: summary?.sides?.Right?.handShiftCm?.max ?? null,
    handCorrectionLeftMaxCm: summary?.sides?.Left?.handCorrectionFromAbsoluteCm?.max ?? null,
    handCorrectionRightMaxCm: summary?.sides?.Right?.handCorrectionFromAbsoluteCm?.max ?? null,
    upperArmBodyDirChangeLeftMaxDeg: summary?.sides?.Left?.upperArmBodyDirChangeDeg?.max ?? null,
    upperArmBodyDirChangeRightMaxDeg: summary?.sides?.Right?.upperArmBodyDirChangeDeg?.max ?? null,
    aPoseBodyHorizontalChangeLeftMaxDeg: summary?.sides?.Left?.aPoseBodyHorizontalChangeDeg?.max ?? null,
    aPoseBodyHorizontalChangeRightMaxDeg: summary?.sides?.Right?.aPoseBodyHorizontalChangeDeg?.max ?? null,
    normHeightErrAfterLeftMaxCm: summary?.sides?.Left?.normHeightErrAfterCm?.max ?? null,
    normHeightErrAfterRightMaxCm: summary?.sides?.Right?.normHeightErrAfterCm?.max ?? null,
    socketLiftLeftMinCm: summary?.sides?.Left?.socketLiftCm?.min ?? null,
    socketLiftRightMinCm: summary?.sides?.Right?.socketLiftCm?.min ?? null,
    socketLiftLeftMaxCm: summary?.sides?.Left?.socketLiftCm?.max ?? null,
    socketLiftRightMaxCm: summary?.sides?.Right?.socketLiftCm?.max ?? null,
    coefficients
  }
}

function buildFrameSeries(result) {
  const out = {}
  for (const side of ['Left', 'Right']) {
    const pick = (key) => result.frameMetrics.map((row) => {
      const v = row.sides?.[side]?.[key]
      if (typeof v === 'boolean') return v ? 1 : 0
      return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null
    })
    out[side] = {
      socketLiftCm: pick('socketLiftCm'),
      socketShiftCm: pick('socketShiftCm'),
      handShiftCm: pick('handShiftCm'),
      shoulderLocalDegBefore: pick('shoulderLocalDegBefore'),
      shoulderLocalDegAfter: pick('shoulderLocalDegAfter'),
      upperArmDirChangeDeg: pick('upperArmDirChangeDeg'),
      aPoseBodyHorizontalChangeDeg: pick('aPoseBodyHorizontalChangeDeg'),
      normHeightErrAfterCm: pick('normHeightErrAfterCm'),
      socketDropNormErrAfterCm: pick('socketDropNormErrAfterCm'),
      clavicleDispNormErrAfterCm: pick('clavicleDispNormErrAfterCm'),
      clavicleElevationSourceDeg: pick('clavicleElevationSourceDeg'),
      clavicleElevationAfterDeg: pick('clavicleElevationAfterDeg'),
      hybridWeight: pick('hybridWeight'),
      hybridCorrectionCm: pick('hybridCorrectionCm'),
      // v3
      absoluteTargetLiftCm: pick('absoluteTargetLiftCm'),
      actualSocketLiftCm: pick('actualSocketLiftCm'),
      socketErrorVsAbsoluteTargetCm: pick('socketErrorVsAbsoluteTargetCm'),
      shoulderCapHit: pick('shoulderCapHit'),
      upperArmBodyDirChangeDeg: pick('upperArmBodyDirChangeDeg'),
      handFloatCm: pick('handFloatCm'),
      handCorrectionFromAbsoluteCm: pick('handCorrectionFromAbsoluteCm')
    }
  }
  return out
}

function renderSummaryV3(payload) {
  const lines = []
  const o = payload.options
  const c = payload.coefficients
  lines.push(`# 比例感知肩/臂重定向 v3 — ${payload.variant}`)
  lines.push('')
  lines.push(`生成：${payload.generatedAt}；mode=\`${payload.mode}\`；liftFraction=${fmt(payload.liftFraction, 2)}；` +
    `shoulderCap=${o.guards.maxShoulderLocalDeg ?? '—'}°；partialIk=${fmt(payload.partialIk, 2)}；` +
    `maxHandCorrection=${o.guards.maxHandCorrectionCm}cm；maxUpperArmChange=${o.guards.maxUpperArmDirChangeDeg}°；` +
    `reach=${o.guards.reachRatio}；elbow=[${o.guards.minElbowFlexDeg},${o.guards.maxElbowFlexDeg}]°。`)
  lines.push('')
  lines.push('## 公式')
  lines.push('')
  lines.push('```text')
  lines.push('A_abs = F_t( (F_s(p_s^UA) / H_s) · H_t )        // 源 canonical torso 归一化 × 目标 torso 长')
  lines.push('P_t   = lerp_local( p_before^UA, A_abs, liftFraction )')
  lines.push('S\'    = S · align( r, S⁻¹ · F_p⁻¹( normalize(P_t − p^Shoulder) ) )')
  lines.push('A\'    = S\'⁻¹ · S · A                          // 手臂 world 朝向不变')
  lines.push('```')
  lines.push('')
  lines.push('## 源/目标比例')
  lines.push('')
  lines.push('| 项 | 源 Zome | 目标男体 | 比例 |')
  lines.push('|---|---:|---:|---:|')
  lines.push(`| hips→head | ${fmt(c.sourceTorsoM * 100)}cm | ${fmt(c.targetTorsoM * 100)}cm | ${fmt(c.torsoScale, 3)}× |`)
  lines.push(`| 锁骨 | ${fmt(c.sourceClavicleM * 100)}cm | ${fmt(c.targetClavicleM * 100)}cm | ${fmt(c.clavicleScale, 2)}× |`)
  lines.push('')
  lines.push('## 肩/锁骨指标')
  lines.push('')
  lines.push('| clip | tag | policy | 帧 | cap | 锁骨局部 before→after | abs 目标抬升 | socket 实抬 | socket 对 abs 目标误差 | 归一化肩高误差 before→after | 动画下坠误差 before→after | 锁骨位移误差 before→after | A-pose 体相对变化 |')
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const row of payload.clips) {
    const m = row.metrics
    if (row.excluded) {
      lines.push(`| ${row.clip} | ${row.tag} | exclude | ${row.frames} | — | — | — | — | — | — | — | — | — |`)
      continue
    }
    lines.push([
      row.clip,
      row.tag,
      row.policy,
      row.frames,
      m.shoulderCapSideFrames === null ? '—' : `${m.shoulderCapSideFrames}`,
      `${fmt(m.shoulderLocalBeforeMaxDeg, 1)}→${fmt(m.shoulderLocalAfterMaxDeg, 1)}°`,
      `${fmt(m.absoluteTargetLiftMinCm, 1)}..${fmt(m.absoluteTargetLiftMaxCm, 1)}cm`,
      `${fmt(m.socketLiftMinCm, 1)}..${fmt(m.socketLiftMaxCm, 1)}cm`,
      `${fmt(m.socketErrorVsAbsoluteTargetMaxCm, 2)}cm`,
      `${fmt(m.normHeightErrBeforeMaxCm, 1)}→${fmt(m.normHeightErrAfterMaxCm, 1)}cm`,
      `${fmt(m.socketDropNormErrBeforeMaxCm, 1)}→${fmt(m.socketDropNormErrAfterMaxCm, 1)}cm`,
      `${fmt(m.clavicleDispNormErrBeforeMaxCm, 1)}→${fmt(m.clavicleDispNormErrAfterMaxCm, 1)}cm`,
      `${fmt(m.aPoseBodyHorizontalChangeMaxDeg, 2)}°`
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  lines.push('')
  lines.push('## 手/连续性/校验')
  lines.push('')
  lines.push('| clip | 手 world 位移 L / R | 手修正 L / R | 上臂体相对变化 | 上臂 world 变化 | 肘屈 after | loopSeam 前→后 | 帧跳 前→后 | Hybrid 接受 | 校验 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  for (const row of payload.clips) {
    const m = row.metrics
    const t = row.trackStats
    const hybrid = row.hybrid
    if (row.excluded) {
      lines.push(`| ${row.clip} | — | — | — | — | — | — | — | — | ${row.validation.ok ? 'ok' : `ERR(${row.validation.errors.length})`} |`)
      continue
    }
    const handPair = (left, right) => `${fmt(left, 1)} / ${fmt(right, 1)}cm`
    lines.push([
      row.clip,
      handPair(m.handShiftLeftMaxCm, m.handShiftRightMaxCm),
      handPair(m.handCorrectionLeftMaxCm, m.handCorrectionRightMaxCm),
      `${fmt(m.upperArmBodyDirChangeMaxDeg, 2)}°`,
      `${fmt(m.upperArmWorldDeltaChangeMaxDeg, 2)}°`,
      `${fmt(m.elbowFlexAfterMinDeg, 1)}..${fmt(m.elbowFlexAfterMaxDeg, 1)}°`,
      t.loopSeamBeforeMaxDeg === null ? '—' : `${fmt(t.loopSeamBeforeMaxDeg, 2)}→${fmt(t.loopSeamAfterMaxDeg, 2)}°`,
      `${fmt(t.frameJumpBeforeMaxDeg, 2)}→${fmt(t.frameJumpMaxDeg, 2)}°`,
      hybrid ? `${hybrid.acceptedSideFrames}/${hybrid.candidateFrames}` : '—',
      row.validation.ok ? 'ok' : `ERR(${row.validation.errors.length})`
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  lines.push('')
  lines.push('## 口径')
  lines.push('')
  lines.push('- `abs 目标抬升` = 源 canonical posed upperArm 归一化位置 × 目标 torso 长，在目标 torso 系里相对原肩点的 y 抬升；`socket 实抬` = 修正后实际 y 抬升（锁骨长度固定，不可达只保方向）。')
  lines.push('- `socket 对 abs 目标误差` = 修正后 socket 与绝对目标的世界距离；锁骨长度固定导致不可达时为正，属预期。')
  lines.push('- `A-pose 体相对变化` = 上臂与目标躯干水平面的夹角变化；s2-absolute-only 应 ≈0（只平移手臂，不改 world 朝向）。')
  lines.push('- `手 world 位移` = 最终手位相对原 clip 手位的距离；s2-absolute-only 等于肩点位移，hybrid 应显著变小。')
  lines.push('- `手修正` = 最终手位相对 S2-absolute 手位的距离；hybrid 的 IK 修正量。')
  lines.push('- `上臂体相对变化` = 上臂方向在目标 torso 系里 relative-to-body 的变化；hybrid 的 guard 口径。')
  lines.push('- `cap` = 锁骨局部角超过 `--shoulder-cap` 的 side-frame 数（上限 frames×2）。')
  lines.push('- 源参考与 v2 一致：canonical Zome（`source-canonical-reference.mjs`），不做 VRM0 raw replay。')
  return lines.join('\n')
}

function renderSummary(payload) {
  if (payload.pipeline === 3) return renderSummaryV3(payload)
  const lines = []
  const o = payload.options
  lines.push(`# 比例感知肩/臂重定向 v2 — ${payload.variant}`)
  lines.push('')
  lines.push(`生成：${payload.generatedAt}；mode=\`${payload.mode}\`；k=${fmt(payload.k, 4)}（${payload.kSource}）；` +
    `ikTarget=\`${o.ikTarget}\`；maxHandCorrection=${o.guards.maxHandCorrectionCm}cm；` +
    `maxUpperArmChange=${o.guards.maxUpperArmDirChangeDeg}°；reach=${o.guards.reachRatio}；` +
    `elbow=[${o.guards.minElbowFlexDeg},${o.guards.maxElbowFlexDeg}]°。`)
  lines.push('')
  lines.push('## 源/目标比例 & k')
  lines.push('')
  const c = payload.coefficients
  lines.push('| 项 | 源 Zome | 目标男体 | 比例 |')
  lines.push('|---|---:|---:|---:|')
  lines.push(`| hips→head | ${fmt(c.sourceTorsoM * 100)}cm | ${fmt(c.targetTorsoM * 100)}cm | ${fmt(c.torsoScale, 3)}× |`)
  lines.push(`| 锁骨 | ${fmt(c.sourceClavicleM * 100)}cm | ${fmt(c.targetClavicleM * 100)}cm | ${fmt(c.clavicleScale, 2)}× |`)
  lines.push(`| 肩根半宽 | ${fmt(c.sourceShoulderRootHalfWidthM * 100)}cm | ${fmt(c.targetShoulderRootHalfWidthM * 100)}cm | — |`)
  lines.push('')
  lines.push(`- **kSocket**（肩点归一化位移）= ${fmt(c.kSocket, 4)}；**kSlope**（肩线斜率数值解）= ${fmt(c.kSlope, 4)}；kSlope@20° = ${fmt(c.kSlopeAt20, 4)}。`)
  lines.push('')
  lines.push('## 逐 clip 指标')
  lines.push('')
  lines.push('| clip | tag | policy | 帧 | 锁骨局部 before→after (src) | socket lift | 手位移 max | 上臂 world 变化 | 上臂方向变化 | A-pose 体水平变化 | 归一化肩高误差 | 下坠归一化误差 | 锁骨位移归一化误差 | 锁骨仰角差 | 肩线斜率差 | loopSeam 前→后 | 帧跳 前→后 | Hybrid 接受 | 校验 |')
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  for (const row of payload.clips) {
    const m = row.metrics
    const t = row.trackStats
    const hybrid = row.hybrid
    lines.push([
      row.clip,
      row.tag,
      row.policy,
      row.frames,
      `${fmt(m.shoulderLocalBeforeMaxDeg, 1)}→${fmt(m.shoulderLocalAfterMaxDeg, 1)}°`,
      `${fmt(m.socketLiftMinCm, 1)}..${fmt(m.socketLiftMaxCm, 1)}cm`,
      `${fmt(m.handShiftMaxCm, 1)}cm`,
      `${fmt(m.upperArmWorldDeltaChangeMaxDeg, 2)}°`,
      `${fmt(m.upperArmDirChangeMaxDeg, 2)}°`,
      `${fmt(m.aPoseBodyHorizontalChangeMaxDeg, 2)}°`,
      `${fmt(m.normHeightErrBeforeMaxCm, 1)}→${fmt(m.normHeightErrAfterMaxCm, 1)}cm`,
      `${fmt(m.socketDropNormErrBeforeMaxCm, 1)}→${fmt(m.socketDropNormErrAfterMaxCm, 1)}cm`,
      `${fmt(m.clavicleDispNormErrBeforeMaxCm, 1)}→${fmt(m.clavicleDispNormErrAfterMaxCm, 1)}cm`,
      `${fmt(m.clavicleElevationDiffSourceBeforeMaxDeg, 1)}→${fmt(m.clavicleElevationDiffSourceAfterMaxDeg, 1)}°`,
      `${fmt(m.shoulderSlopeDiffSourceBeforeMax, 3)}→${fmt(m.shoulderSlopeDiffSourceAfterMax, 3)}`,
      t.loopSeamBeforeMaxDeg === null ? '—' : `${fmt(t.loopSeamBeforeMaxDeg, 2)}→${fmt(t.loopSeamAfterMaxDeg, 2)}°`,
      `${fmt(t.frameJumpBeforeMaxDeg, 2)}→${fmt(t.frameJumpMaxDeg, 2)}°`,
      hybrid ? `${hybrid.acceptedFrames}/${hybrid.candidateFrames}` : '—',
      row.validation.ok ? 'ok' : `ERR(${row.validation.errors.length})`
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  lines.push('')
  lines.push('## 口径')
  lines.push('')
  lines.push('- `socket lift` = after−before 的 upperArm 关节点在**目标 torso 系**里的 y 抬升；正数 = 抬肩。')
  lines.push('- `手位移` = Hand 关节世界位置变化；S2-only 下它恒等于 socket 平移（下游骨段 world 朝向不变）。')
  lines.push('- `上臂 world 变化` = S2 前后 upperArm world delta 夹角；S2-only 应为 0，Hybrid 只随 IK 修正变。')
  lines.push('- `A-pose 体水平变化` = upperArm 骨段与目标躯干水平面夹角的变化；S2-only 应为 0。')
  lines.push('- `归一化肩高误差` = 肩点相对 hips 的高度 / 躯干长，与源 canonical 同帧的差（×目标躯干长 → cm）；它包含男女 rest 肩高差，S2 只修动画位移，不能完全归零。')
  lines.push('- `下坠归一化误差` = (posed 肩高 − rest 肩高)/躯干长 与源同帧的差；这是 S2 的直接目标，k 合适时应接近 0。')
  lines.push('- `锁骨位移归一化误差` = 纯锁骨局部旋转造成的位移向量（在各自 rest torso 系）归一化后与源的差；进一步排除 chest 动画/rest 肩高差，用于校验 k 推导。')
  lines.push('- `锁骨仰角差` / `肩线斜率差` = 与源 canonical 同帧的绝对差；S2 的目标就是让它们变小。')
  lines.push('- `Hybrid 接受` = 通过 guards 并保留手 IK 的 side-frame 数；未通过逐帧回退 S2-only。')
  lines.push('- sleep 在 Hybrid 里默认 `exclude`（原样），S2 变体仍会跑出来仅供对照。')
  lines.push('- 源参考用 B 的 canonical Zome 机制（`source-canonical-reference.mjs`，q\'=(-x,y,-z,w)）；不依赖 three-vrm VRM0 raw replay。')
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const { values, errors, sawHelp, provided } = parseCliArgs(process.argv.slice(2), OPTIONS)
  if (sawHelp) { console.log(HELP); process.exit(0) }
  if (errors.length) { console.error(errors.join('\n')); console.error('\n' + HELP); process.exit(2) }

  const variant = String(values.variant)
  const spec = VARIANTS[variant]
  if (!spec) { console.error(`未知 variant：${variant}（可选 ${Object.keys(VARIANTS).join(', ')}）`); process.exit(2) }
  const isV3 = spec.pipeline === 3
  const pickNumber = (name, fallback) => (provided.has(name) ? Number(values[name]) : fallback)
  const guards = {
    maxHandCorrectionCm: pickNumber('max-hand-correction', isV3 ? V3_DEFAULT_GUARDS.maxHandCorrectionCm : DEFAULT_GUARDS.maxHandCorrectionCm),
    maxUpperArmDirChangeDeg: pickNumber('max-upperarm-change', isV3 ? V3_DEFAULT_GUARDS.maxUpperArmDirChangeDeg : DEFAULT_GUARDS.maxUpperArmDirChangeDeg),
    minElbowFlexDeg: Number(values['min-elbow']),
    maxElbowFlexDeg: Number(values['max-elbow']),
    reachRatio: Number(values['reach-ratio']),
    weightSmoothPasses: Number(values['smooth-passes']),
    correctionSmoothPasses: Number(values['smooth-passes'])
  }
  for (const [key, value] of Object.entries(guards)) {
    if (!Number.isFinite(value) || value < 0) { console.error(`${key} 非法：${value}`); process.exit(2) }
  }
  if (guards.reachRatio <= 0 || guards.reachRatio > 1) { console.error('reach-ratio 必须在 (0,1]'); process.exit(2) }
  let liftFraction = 1
  let maxShoulderLocalDeg = V3_DEFAULTS.maxShoulderLocalDeg
  let partialIk = 1
  if (isV3) {
    liftFraction = provided.has('lift-fraction') ? Number(values['lift-fraction']) : (spec.liftFraction ?? 1)
    if (!Number.isFinite(liftFraction) || liftFraction < 0 || liftFraction > 1) {
      console.error(`--lift-fraction 必须在 [0,1]（收到 ${values['lift-fraction']}）`); process.exit(2)
    }
    maxShoulderLocalDeg = provided.has('shoulder-cap') ? Number(values['shoulder-cap']) : V3_DEFAULTS.maxShoulderLocalDeg
    if (!Number.isFinite(maxShoulderLocalDeg) || maxShoulderLocalDeg < 0) {
      console.error(`--shoulder-cap 必须 ≥0（0=关闭；收到 ${values['shoulder-cap']}）`); process.exit(2)
    }
    partialIk = provided.has('partial-ik') ? Number(values['partial-ik']) : (spec.partialIk ?? 1)
    if (!Number.isFinite(partialIk) || partialIk < 0 || partialIk > 1) {
      console.error(`--partial-ik 必须在 [0,1]（收到 ${values['partial-ik']}）`); process.exit(2)
    }
  }

  const sourceRestPath = values['source-rest'] ? path.resolve(ROOT, String(values['source-rest'])) : null
  const targetRestPath = values['target-rest'] ? path.resolve(ROOT, String(values['target-rest'])) : null
  const sourcePath = path.resolve(ROOT, String(values.source))
  const targetPath = path.resolve(ROOT, String(values.target))
  if (!sourceRestPath && !existsSync(sourcePath)) { console.error(`源 VRM 不存在：${sourcePath}`); process.exit(1) }
  if (!targetRestPath && !existsSync(targetPath)) { console.error(`目标 VRM 不存在：${targetPath}`); process.exit(1) }
  if (sourceRestPath && !existsSync(sourceRestPath)) { console.error(`源 rest 不存在：${sourceRestPath}`); process.exit(1) }
  if (targetRestPath && !existsSync(targetRestPath)) { console.error(`目标 rest 不存在：${targetRestPath}`); process.exit(1) }

  console.log(`[v2] variant=${variant} mode=${spec.mode} ikTarget=${spec.ikTarget}`)
  const sourceRest = sourceRestPath ? loadRestJson(sourceRestPath) : await loadVrmRest(sourcePath)
  const targetRest = targetRestPath ? loadRestJson(targetRestPath) : await loadVrmRest(targetPath)
  const coefficients = deriveS2Coefficients(sourceRest, targetRest)
  let k = spec.kKind === 'fixed' ? spec.k : spec.kKind === 'slope' ? coefficients.kSlope : coefficients.kSocket
  let kSource = spec.kKind === 'fixed' ? `fixed ${spec.k}` : spec.kKind === 'slope' ? 'kSlope（肩线公式数值解）' : 'kSocket'
  if (values.k !== undefined) {
    const parsed = Number(values.k)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) { console.error(`--k 必须在 [0,1]（收到 ${values.k}）`); process.exit(2) }
    k = parsed
    kSource = 'CLI --k'
  }
  console.log(`[v2] torso ${fmt(coefficients.sourceTorsoM * 100, 1)}→${fmt(coefficients.targetTorsoM * 100, 1)}cm; ` +
    `clavicle ${fmt(coefficients.sourceClavicleM * 100, 2)}→${fmt(coefficients.targetClavicleM * 100, 2)}cm; ` +
    `kSocket=${fmt(coefficients.kSocket, 4)} kSlope=${fmt(coefficients.kSlope, 4)} using k=${fmt(k, 4)} (${kSource})`)

  const clips = String(values.clips).split(',').map((s) => s.trim()).filter(Boolean)
  if (clips.length === 0) { console.error('没有 clip'); process.exit(2) }
  const motionsDir = path.resolve(ROOT, String(values.motions))
  const outDir = path.resolve(ROOT, String(values.out))
  const metricsFile = path.resolve(ROOT, String(values.metrics))
  const summaryFile = path.resolve(ROOT, String(values.summary))
  if (!values['no-write']) mkdirSync(outDir, { recursive: true })
  mkdirSync(path.dirname(metricsFile), { recursive: true })
  mkdirSync(path.dirname(summaryFile), { recursive: true })

  const rows = []
  for (const clipName of clips) {
    const file = path.join(motionsDir, `${clipName}.json`)
    if (!existsSync(file)) { console.error(`缺 clip：${file}`); process.exit(1) }
    const clip = readClip(file)
    const startedAt = Date.now()
    const result = isV3
      ? retargetClipV3(clip, {
          sourceRest,
          targetRest,
          mode: spec.mode,
          liftFraction,
          maxShoulderLocalDeg,
          partialIk,
          clipName,
          guards
        })
      : retargetClipV2(clip, {
          sourceRest,
          targetRest,
          mode: spec.mode,
          k,
          ikTarget: spec.ikTarget,
          clipName,
          guards
        })
    const frames = clip.frames
    const loop = clip.loop === true
    const outClip = JSON.parse(JSON.stringify(clip))
    for (const bone of V2_MODIFIED_BONES) {
      if (!outClip.bones[bone]) outClip.bones[bone] = {}
      outClip.bones[bone].r = encodeNested(result.tracks[bone])
    }
    if (isV3) {
      outClip.proportionRetargetV3 = {
        version: 3,
        tool: 'scripts/unity-bake/proportion-retarget-v2.mjs',
        variant,
        mode: spec.mode,
        liftFraction,
        maxShoulderLocalDeg,
        partialIk,
        policy: result.policy,
        excluded: result.excluded,
        guards,
        source: path.relative(ROOT, sourcePath),
        target: path.relative(ROOT, targetPath),
        torsoScale: coefficients.torsoScale,
        clavicleScale: coefficients.clavicleScale,
        generatedAt: new Date().toISOString()
      }
    } else {
      outClip.proportionRetargetV2 = {
        version: 2,
        tool: 'scripts/unity-bake/proportion-retarget-v2.mjs',
        variant,
        mode: spec.mode,
        k,
        kSource,
        ikTarget: spec.ikTarget,
        policy: result.policy,
        excluded: result.excluded,
        guards,
        source: path.relative(ROOT, sourcePath),
        target: path.relative(ROOT, targetPath),
        torsoScale: coefficients.torsoScale,
        clavicleScale: coefficients.clavicleScale,
        kSocket: coefficients.kSocket,
        kSlope: coefficients.kSlope,
        generatedAt: new Date().toISOString()
      }
    }
    const validation = validateClipData(outClip, { optionalBones: CLIP_OPTIONAL_BONES })
    const metricRow = buildMetricRow(result, coefficients)
    const row = {
      clip: clipName,
      tag: CLIP_TAGS[clipName] ?? 'other',
      frames,
      durationSec: clip.duration ?? null,
      loop,
      computeMs: Date.now() - startedAt,
      pipeline: isV3 ? 3 : 2,
      policy: result.policy,
      excluded: result.excluded,
      k: isV3 ? null : k,
      liftFraction: isV3 ? result.liftFraction : null,
      maxShoulderLocalDeg: isV3 ? result.maxShoulderLocalDeg : null,
      partialIk: isV3 ? result.partialIk : null,
      absolute: result.absolute ?? null,
      metrics: metricRow,
      trackStats: result.trackStats,
      hybrid: result.hybrid
        ? {
            ikTarget: result.hybrid.ikTarget,
            acceptedFrames: result.hybrid.acceptedFrames,
            candidateFrames: result.hybrid.candidateFrames,
            acceptedSideFrames: result.trackStats.hybrid?.acceptedSideFrames ?? 0,
            rejectedSideFrames: result.trackStats.hybrid?.rejectedSideFrames ?? 0,
            maxCorrectionCm: result.trackStats.hybrid?.maxCorrectionCm ?? 0,
            maxUpperArmChangeDeg: result.trackStats.hybrid?.maxUpperArmChangeDeg ?? 0,
            elbowFlexRangeDeg: result.trackStats.hybrid?.elbowFlexRangeDeg ?? null
          }
        : null,
      validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings, stats: validation.stats },
      frameSeries: buildFrameSeries(result)
    }
    rows.push(row)
    if (!values['no-write']) {
      writeFileSync(path.join(outDir, `${clipName}.json`), JSON.stringify(outClip, null, 2) + '\n')
    }
    const m = row.metrics
    console.log(
      `[${isV3 ? 'v3' : 'v2'}] ${clipName.padEnd(12)} ${String(frames).padStart(4)}f ${String(row.computeMs).padStart(5)}ms ` +
      `policy=${row.policy.padEnd(14)} shoulder ${fmt(m.shoulderLocalBeforeMaxDeg, 1)}→${fmt(m.shoulderLocalAfterMaxDeg, 1)}° ` +
      `lift ${fmt(m.socketLiftMinCm, 1)}..${fmt(m.socketLiftMaxCm, 1)}cm handShift ${fmt(m.handShiftMaxCm, 1)}cm ` +
      `armWorld ${fmt(m.upperArmWorldDeltaChangeMaxDeg, 3)}° aPose ${fmt(m.aPoseBodyHorizontalChangeMaxDeg, 2)}° ` +
      `jump ${fmt(row.trackStats.frameJumpBeforeMaxDeg, 1)}→${fmt(row.trackStats.frameJumpMaxDeg, 1)}° ` +
      `hybrid ${row.hybrid ? `${row.hybrid.acceptedSideFrames}/${row.hybrid.candidateFrames}` : '—'} ` +
      `valid=${validation.ok ? 'ok' : 'ERR'}`
    )
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    tool: 'scripts/unity-bake/proportion-retarget-v2.mjs',
    pipeline: isV3 ? 3 : 2,
    variant,
    mode: spec.mode,
    k: isV3 ? null : k,
    kSource: isV3 ? null : kSource,
    liftFraction: isV3 ? liftFraction : null,
    maxShoulderLocalDeg: isV3 ? maxShoulderLocalDeg : null,
    partialIk: isV3 ? partialIk : null,
    coefficients,
    options: {
      source: path.relative(ROOT, sourcePath),
      target: path.relative(ROOT, targetPath),
      sourceRest: sourceRestPath ? path.relative(ROOT, sourceRestPath) : null,
      targetRest: targetRestPath ? path.relative(ROOT, targetRestPath) : null,
      clips,
      ikTarget: spec.ikTarget,
      guards: isV3 ? { ...guards, maxShoulderLocalDeg } : guards,
      out: path.relative(ROOT, outDir)
    },
    clips: rows
  }
  writeFileSync(metricsFile, JSON.stringify(payload, null, 2) + '\n')
  writeFileSync(summaryFile, renderSummary(payload) + '\n')
  console.log(`[v2] wrote ${rows.length} clips → ${path.relative(ROOT, outDir) || '.'}`)
  console.log(`[v2] metrics → ${path.relative(ROOT, metricsFile)}`)
  console.log(`[v2] summary → ${path.relative(ROOT, summaryFile)}`)
}

main().catch((error) => {
  console.error('[v2] FAIL:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
