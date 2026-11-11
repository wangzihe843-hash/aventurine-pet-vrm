#!/usr/bin/env node
/**
 * 由「VRM 归一化骨 FK + 源动画枪骨世界变换」反推水枪挂载局部变换（dev-only 标定脚本）。
 *
 * 输入：
 *  - assets/vrm/aventurine-tpose.vrm（VRM 1.0，含 humanoidBones 映射与节点 rest TRS）
 *  - tests/tmp/adv-pilot-v3/pipeline/clips/skill01.json（重定向后的 normalized 局部四元数）
 *  - tests/tmp/props/watergun/calib-skill01.json（Blender 导出的枪世界变换 W，three/米制）
 * 输出：每个采样帧的 T = inv(H_v) · W，并统计一致性；写 attach-candidate.json
 *
 * 用法：node scripts/props/calibrate-watergun.mjs [--vrm ...] [--clip ...] [--calib ...] [--out ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf('--' + name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const VRM = arg('vrm', 'assets/vrm/aventurine-tpose.vrm')
const CLIP = arg('clip', 'tests/tmp/adv-pilot-v3/pipeline/clips/skill01.json')
const CALIB = arg('calib', 'tests/tmp/props/watergun/calib-skill01.json')
const OUT = arg('out', 'tests/tmp/props/watergun/attach-candidate.json')

/* --------------------------- 极简 4x4 / 四元数数学 --------------------------- */
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function matFromTRS([tx, ty, tz], [x, y, z, w]) {
  const xx = x * x, yy = y * y, zz = z * z
  const xy = x * y, xz = x * z, yz = y * z
  const wx = w * x, wy = w * y, wz = w * z
  const m = [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), tx,
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), ty,
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), tz,
    0, 0, 0, 1
  ]
  return m
}

function matMul(a, b) {
  const out = new Array(16).fill(0)
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[r * 4 + k] * b[k * 4 + c]
      out[r * 4 + c] = sum
    }
  }
  return out
}

function matInvert(m) {
  const inv = new Array(16).fill(0)
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12]
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix')
  return inv.map((value) => value / det)
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

function quatNormalize(q) {
  const length = Math.hypot(...q) || 1
  return q.map((value) => value / length)
}

function quatConjugate(q) {
  return [-q[0], -q[1], -q[2], q[3]]
}

function quatRotate(q, v) {
  const [x, y, z, w] = q
  const [vx, vy, vz] = v
  const ix = w * vx + y * vz - z * vy
  const iy = w * vy + z * vx - x * vz
  const iz = w * vz + x * vy - y * vx
  const iw = -x * vx - y * vy - z * vz
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]
}

function matDecompose(m) {
  const t = [m[3], m[7], m[11]]
  const sx = Math.hypot(m[0], m[4], m[8])
  const sy = Math.hypot(m[1], m[5], m[9])
  const sz = Math.hypot(m[2], m[6], m[10])
  const r = [m[0] / sx, m[4] / sx, m[8] / sx, m[1] / sy, m[5] / sy, m[9] / sy, m[2] / sz, m[6] / sz, m[10] / sz]
  const trace = r[0] + r[4] + r[8]
  let q
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    q = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4]
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2
    q = [s / 4, (r[1] + r[3]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s]
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2
    q = [(r[1] + r[3]) / s, s / 4, (r[5] + r[7]) / s, (r[6] - r[2]) / s]
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2
    q = [(r[6] + r[2]) / s, (r[5] + r[7]) / s, s / 4, (r[1] - r[3]) / s]
  }
  return { t, q: quatNormalize(q), s: [sx, sy, sz] }
}

/* ------------------------------- 读 VRM rest ------------------------------- */
const vrmBuffer = fs.readFileSync(path.join(ROOT, VRM))
const jsonLength = vrmBuffer.readUInt32LE(12)
const gltf = JSON.parse(vrmBuffer.subarray(20, 20 + jsonLength).toString('utf8'))
const nodes = gltf.nodes ?? []
const parentOf = new Array(nodes.length).fill(-1)
nodes.forEach((node, index) => {
  for (const child of node.children ?? []) parentOf[child] = index
})
const humanBonesRaw = gltf.extensions?.VRMC_vrm?.humanoid?.humanBones ?? gltf.extensions?.VRMC_vrm?.humanoid?.humanoidBones ?? []
const humanoidBones = Array.isArray(humanBonesRaw)
  ? humanBonesRaw
  : Object.entries(humanBonesRaw).map(([bone, value]) => ({ bone, node: value.node }))
if (humanoidBones.length === 0) throw new Error('VRM 缺 VRMC_vrm.humanoid.humanoidBones')
const humanoidByNode = new Map()
for (const entry of humanoidBones) humanoidByNode.set(entry.node, entry.bone)

function rawWorldMatrix(index) {
  const chain = []
  let cursor = index
  while (cursor >= 0) {
    chain.push(cursor)
    cursor = parentOf[cursor]
  }
  let matrix = IDENT
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = nodes[chain[i]]
    const local = matFromTRS(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1])
    matrix = matMul(matrix, local)
  }
  return matrix
}

const restWorld = new Map() // vrm humanoid name -> {pos:[x,y,z]}
const humanoidParent = new Map() // vrm name -> nearest humanoid ancestor name (or null)
for (const entry of humanoidBones) {
  const world = rawWorldMatrix(entry.node)
  restWorld.set(entry.bone, { pos: [world[3], world[7], world[11]] })
  let cursor = parentOf[entry.node]
  let parent = null
  while (cursor >= 0) {
    if (humanoidByNode.has(cursor)) {
      parent = humanoidByNode.get(cursor)
      break
    }
    cursor = parentOf[cursor]
  }
  humanoidParent.set(entry.bone, parent)
}

/* ------------------------------- 读 clip ------------------------------- */
const clip = JSON.parse(fs.readFileSync(path.join(ROOT, CLIP), 'utf8'))
// Unity 风格键名 → VRM humanoid 名（复用现有映射表）
const { UNITY_NAME_BY_VRM } = await import(path.join(ROOT, 'scripts/vrm/motion/lib/humanoid-hsr.mjs'))
const unityToVrm = new Map(Object.entries(UNITY_NAME_BY_VRM).map(([vrm, unity]) => [unity, vrm]))
const localTracks = new Map() // vrm name -> {r:[quat...], p?:[vec...]}
for (const [unityName, data] of Object.entries(clip.bones ?? {})) {
  const vrmName = unityToVrm.get(unityName)
  if (vrmName) localTracks.set(vrmName, data)
}
const hipsRest = restWorld.get('hips')?.pos
if (!hipsRest) throw new Error('VRM rest 缺 hips')
const hipsTrack = localTracks.get('hips')
const hipsScale = hipsRest[1] / (clip.sourceHipsHeight || 1)

const handChain = ['hips', 'spine', 'chest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']
for (const bone of handChain) {
  if (!humanoidParent.has(bone) && bone !== 'hips') throw new Error(`VRM 缺 humanoid 骨 ${bone}`)
}

function handWorldAt(frame) {
  const world = new Map()
  for (const bone of handChain) {
    const parent = humanoidParent.get(bone)
    const track = localTracks.get(bone)
    const qLocal = track ? quatNormalize(track.r[frame]) : [0, 0, 0, 1]
    let qWorld = qLocal
    let position
    if (bone === 'hips') {
      const p = hipsTrack?.p?.[frame]
      position = [hipsRest[0] + (p?.[0] ?? 0) * hipsScale, hipsRest[1] + (p?.[1] ?? 0) * hipsScale, hipsRest[2] + (p?.[2] ?? 0) * hipsScale]
    } else {
      const parentWorld = world.get(parent)
      if (!parentWorld) throw new Error(`humanoid 链缺 ${parent}`)
      const restOffset = [
        restWorld.get(bone).pos[0] - restWorld.get(parent).pos[0],
        restWorld.get(bone).pos[1] - restWorld.get(parent).pos[1],
        restWorld.get(bone).pos[2] - restWorld.get(parent).pos[2]
      ]
      const rotated = quatRotate(parentWorld.q, restOffset)
      position = [parentWorld.p[0] + rotated[0], parentWorld.p[1] + rotated[1], parentWorld.p[2] + rotated[2]]
      qWorld = quatMul(parentWorld.q, qLocal)
    }
    if (bone !== 'hips') qWorld = quatMul(world.get(parent).q, qLocal)
    world.set(bone, { q: quatNormalize(qWorld), p: position })
  }
  return world.get('rightHand')
}

/* --------------------------- 由 W 反推 T 并统计一致性 --------------------------- */
const calib = JSON.parse(fs.readFileSync(path.join(ROOT, CALIB), 'utf8'))
const samples = []
for (const sample of calib.samples) {
  const frame = sample.clipIndex
  const hand = handWorldAt(frame)
  const H = matFromTRS(hand.p, hand.q)
  const W = sample.W
  const T = matMul(matInvert(H), W)
  const decomposed = matDecompose(T)
  samples.push({
    clipIndex: frame,
    sourceFrame: sample.sourceFrame,
    position: decomposed.t.map((v) => Number(v.toFixed(6))),
    quaternion: decomposed.q.map((v) => Number(v.toFixed(6))),
    scale: decomposed.s.map((v) => Number(v.toFixed(4)))
  })
}

function averageQuat(list) {
  const reference = list[0]
  const acc = [0, 0, 0, 0]
  for (const q of list) {
    const dot = q[0] * reference[0] + q[1] * reference[1] + q[2] * reference[2] + q[3] * reference[3]
    const sign = dot < 0 ? -1 : 1
    for (let i = 0; i < 4; i += 1) acc[i] += q[i] * sign
  }
  return quatNormalize(acc)
}

const positions = samples.map((s) => s.position)
const quats = samples.map((s) => s.quaternion)
const meanPos = [0, 1, 2].map((axis) => positions.reduce((sum, p) => sum + p[axis], 0) / positions.length)
const meanQuat = averageQuat(quats)
let maxAngle = 0
for (const q of quats) {
  const dot = Math.min(1, Math.abs(q[0] * meanQuat[0] + q[1] * meanQuat[1] + q[2] * meanQuat[2] + q[3] * meanQuat[3]))
  maxAngle = Math.max(maxAngle, (2 * Math.acos(dot) * 180) / Math.PI)
}
const posSpread = [0, 1, 2].map((axis) => Math.max(...positions.map((p) => p[axis])) - Math.min(...positions.map((p) => p[axis])))

const result = {
  source: { vrm: VRM, clip: CLIP, calib: CALIB },
  note: 'T = inv(VRM rightHand normalized world) · W（源动画枪世界变换）；单位米、three 坐标；挂到归一化 rightHand 的局部变换',
  samples,
  consistency: {
    meanPosition: meanPos.map((v) => Number(v.toFixed(6))),
    meanQuaternion: meanQuat.map((v) => Number(v.toFixed(6))),
    maxAngleDeviationDeg: Number(maxAngle.toFixed(2)),
    positionSpreadMeters: posSpread.map((v) => Number(v.toFixed(4)))
  }
}
fs.mkdirSync(path.dirname(path.join(ROOT, OUT)), { recursive: true })
fs.writeFileSync(path.join(ROOT, OUT), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result.consistency, null, 2))
console.log('wrote', OUT)
