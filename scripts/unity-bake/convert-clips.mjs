#!/usr/bin/env node
/**
 * U2 v1：Unity(左手系) 原始导出 → glTF(右手系) clip JSON
 *
 * 输入：scripts/unity-bake/out/<clip>.json（由 Editor/ClipExporter.cs 生成）
 * 输出：assets/motions/mate/<clip>.json + index.json（私有，gitignore）
 *
 * 用法：
 *   node scripts/unity-bake/convert-clips.mjs [--in dir] [--out dir] [--axis x|z] [--yaw deg] [--debug]
 *
 * 坐标说明（W1.5-Tpose 更新，见 docs/vrm-tpose-repair.md）：
 *   Unity  X右 / Y上 / Z前（左手，面向 +Z 时左手 -X）
 *   glTF   X右 / Y上 / Z朝观察者（右手；标准 VRM1 面向 +Z、左手 +X）
 *   反射轴由目标模型朝向决定：
 *     --axis x（默认，当前目标）：标准 VRM1（面向 +Z、左手 +X）
 *     --axis z：面向 -Z / VRM0 风格旧资产（canary、Zome、旧 waveflair）
 *   两者相差一个绕 Y 的 180° 约定；选错会左右镜像（手臂朝上/扭曲）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0) {
    const v = process.argv[i + 1]
    if (v === undefined || v.startsWith('--')) return true
    return v
  }
  return fallback
}

const inDir = path.resolve(arg('in', 'scripts/unity-bake/out'))
const outDir = path.resolve(arg('out', 'assets/motions/mate'))
const axis = arg('axis', 'x') === 'z' ? 'z' : 'x'
const yawDeg = Number(arg('yaw', '0')) || 0
const hipsMode = arg('hips-mode', 'relative') // relative | raw | none
const debug = Boolean(arg('debug', false))
// 归一化前提校验：采样用的 avatar 必须 T-pose、且各骨 rest 局部旋转≈identity，
// 否则 ``qNorm = inverse(rest) * localRotation`` 不是 VRM normalized 旋转（写 normalized 骨骼会静默错）。
// 见 Wave 1.5 调研：scripts/unity-bake/ClipExporter.cs 的合成骨架 rest=I 才成立；
// 若用 avatarPrefabPath 对真实 avatar 采样，请先用 --allow-non-identity-rest 显式放行并自行做 N = W_rest · q · W_rest⁻¹。
const allowNonIdentityRest = Boolean(arg('allow-non-identity-rest', false))
const REST_IDENTITY_TOLERANCE_DEG = 0.5

function quatAngleFromIdentityDeg(q) {
  const w = Math.min(1, Math.abs(q[3] / (Math.hypot(q[0], q[1], q[2], q[3]) || 1)))
  return (2 * Math.acos(w) * 180) / Math.PI
}

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]
const qNorm = (q) => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}
const qYaw = (deg) => {
  const h = (deg * Math.PI) / 180 / 2
  return [0, Math.sin(h), 0, Math.cos(h)]
}

function unityToGltfQuat(q) {
  // 反射 X： (x, -y, -z, w)
  let out = axis === 'x' ? [q[0], -q[1], -q[2], q[3]] : [q[0], -q[1], -q[2], q[3]]
  // 反射 Z 备选： ( -x, -y, z, w )
  if (axis === 'z') out = [-q[0], -q[1], q[2], q[3]]
  out = qNorm(out)
  if (yawDeg) out = qNorm(qMul(qYaw(yawDeg), out))
  return out
}

function unityToGltfVec(v) {
  if (axis === 'x') return [-v[0], v[1], v[2]]
  return [v[0], v[1], -v[2]]
}

function fixContinuity(quats) {
  const out = []
  let prev = null
  for (const q of quats) {
    let cur = q
    if (prev && prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2] + prev[3] * cur[3] < 0) {
      cur = cur.map((x) => -x)
    }
    out.push(cur)
    prev = cur
  }
  return out
}

if (!fs.existsSync(inDir)) {
  console.error(`[convert] input dir not found: ${inDir}`)
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })

const files = fs.readdirSync(inDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
let converted = 0
const index = {}

for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(inDir, file), 'utf8'))
  if (!raw || !Array.isArray(raw.bones)) {
    console.warn(`[convert] skip ${file}: not a clip export`)
    continue
  }
  if (raw.space !== 'unity-lh') console.warn(`[convert] ${file}: unexpected space=${raw.space}`)

  // 归一化前提：所有骨的采样 rest 局部旋转必须≈identity（合成 T-pose 骨架）。
  // 违反时 qNorm 不再是 normalized 旋转，继续转换会得到「能播但姿势静默偏差」的数据。
  const nonIdentityRest = []
  for (const b of raw.bones) {
    if (!Array.isArray(b.rest) || b.rest.length < 4) continue
    const angle = quatAngleFromIdentityDeg(b.rest)
    if (angle > REST_IDENTITY_TOLERANCE_DEG) nonIdentityRest.push(`${b.name}: rest 偏离 identity ${angle.toFixed(2)}°`)
  }
  if (nonIdentityRest.length > 0) {
    const message =
      `[convert] ${file}: 采样 avatar 的 rest 局部旋转不是 identity（${nonIdentityRest.length} 骨），` +
      `qNorm 不等于 VRM normalized 旋转。\n  ${nonIdentityRest.slice(0, 8).join('\n  ')}` +
      (nonIdentityRest.length > 8 ? `\n  …共 ${nonIdentityRest.length} 条` : '')
    if (!allowNonIdentityRest) {
      console.error(message)
      console.error('[convert] 中止。修复：用合成 T-pose 骨架采样（syntheticAvatar=true），或先自己把 qNorm 转成 normalized（--allow-non-identity-rest 可显式放行，风险自负）。')
      process.exit(1)
    }
    console.warn(message)
    console.warn('[convert] --allow-non-identity-rest：已放行（输出可能不是 normalized 空间，请自行验证）。')
  }

  const frames = raw.frames || Math.min(...raw.bones.map((b) => Math.floor(b.rot.length / 4)))
  const bones = {}
  for (const b of raw.bones) {
    const qs = []
    for (let f = 0; f < frames; f++) {
      const q = unityToGltfQuat([b.rot[f * 4], b.rot[f * 4 + 1], b.rot[f * 4 + 2], b.rot[f * 4 + 3]])
      qs.push(q)
    }
    const entry = { r: fixContinuity(qs) }
    if (Array.isArray(b.pos) && b.pos.length >= frames * 3) {
      const ps = []
      for (let f = 0; f < frames; f++) {
        const v = unityToGltfVec([b.pos[f * 3], b.pos[f * 3 + 1], b.pos[f * 3 + 2]])
        ps.push(v.map((x) => Number(x.toFixed(6))))
      }
      if (hipsMode === 'relative' && ps.length > 0) {
        const base = ps[0]
        for (let i = 0; i < ps.length; i++) ps[i] = ps[i].map((x, k) => Number((x - base[k]).toFixed(6)))
      }
      entry.p = hipsMode === 'none' ? undefined : ps
    }
    bones[b.name] = entry
  }

  const out = {
    version: 1,
    clip: raw.clip,
    mood: raw.mood || null,
    loop: Boolean(raw.loop),
    fps: raw.fps || 30,
    duration: raw.duration,
    sourceHeight: raw.sourceHeight || 1.7,
    // Hips 位移缩放基准（官方 three-vrm/UniVRM 用 hips/COM 高比，不用 bbox 高）：
    // ClipExporter 合成骨架 hips localPosition=(0,1,0) 米，故源 hips 高 = 1.0m。
    // 播放器可用 ``目标模型 normalizedRestPose.hips.position[1] / sourceHipsHeight`` 缩放 p。
    sourceHipsHeight: raw.sourceHipsHeight || 1.0,
    space: 'gltf-rh',
    frames,
    sourceClip: raw.clip,
    avatar: raw.avatar,
    bones
  }
  const outFile = path.join(outDir, `${raw.clip.replace(/[^\w.-]+/g, '_')}.json`)
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
  index[raw.clip] = { file: path.basename(outFile), mood: out.mood, loop: out.loop, duration: out.duration, fps: out.fps }
  converted++
  if (debug) console.log(`[convert] ${file} -> ${outFile} (${frames}f)`)
}

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), clips: index }, null, 2))
console.log(`[convert] done: ${converted} clip(s) -> ${outDir} (axis=${axis}, yaw=${yawDeg})`)
