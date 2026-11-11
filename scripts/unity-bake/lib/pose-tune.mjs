/**
 * U2/U3 动作数据「姿态微调」库（初始站姿手臂收拢等）
 *
 * 作用对象是 `assets/motions/<set>/<clip>.json` 的 **normalized 骨骼旋转** `r`（VRM T-pose 相对量）。
 * 在指定帧区间内，对指定骨施加一个「模型空间轴角旋转」偏移，并线性淡出到 0：
 *
 *   N'(f) = slerp(identity, E, w(f)) · N(f)
 *
 * - 对 upperArm 这类骨，pre-multiply 等价于在父骨骼（肩/胸）当前朝向的局部系里绕关节加一个
 *   世界方向的小旋转；目标模型是规范 T-pose（rest world = identity）时，E 的轴即模型轴：
 *   模型面向 +Z（VRM 1.0）、左手 +X、右手 -X。
 * - 只适合做几度级「微调」；不是通用重定向修正。
 *
 * 约定：clip JSON 若已有 `poseTune` 字段，说明已被某个配置处理过：
 *   - configHash 相同 → 幂等跳过；
 *   - configHash 不同 → 报错，要求先重跑 convert-clips 再用新配置（避免叠加偏移）。
 */

/** @typedef {{x:number,y:number,z:number,w:number}} Quat */

const DEG2RAD = Math.PI / 180

/** @param {number[]} axis @returns {number[]} */
export function normalizeAxis(axis) {
  if (!Array.isArray(axis) || axis.length !== 3 || axis.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`axis 必须是 3 个有限数字的数组：${JSON.stringify(axis)}`)
  }
  const len = Math.hypot(...axis)
  if (len < 1e-9) throw new Error('axis 不能是零向量')
  return axis.map((v) => v / len)
}

/** 轴角 → 单位四元数 [x,y,z,w] @param {number[]} axis @param {number} deg @returns {number[]} */
export function axisAngleQuat(axis, deg) {
  const a = normalizeAxis(axis)
  const half = (deg * DEG2RAD) / 2
  const s = Math.sin(half)
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(half)]
}

/** 四元数乘法 a·b（先 b 后 a，与 three.js Quaternion.multiply 一致） @param {number[]} a @param {number[]} b @returns {number[]} */
export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

/** 单位四元数归一化（输入异常模长时兜底） @param {number[]} q @returns {number[]} */
export function quatNorm(q) {
  const len = Math.hypot(...q)
  if (len < 1e-9) return [0, 0, 0, 1]
  return q.map((v) => v / len)
}

/** slerp：t=0 → a，t=1 → b（最短路径） @param {number[]} a @param {number[]} b @param {number} t @returns {number[]} */
export function quatSlerp(a, b, t) {
  const aa = quatNorm(a)
  const bb = quatNorm(b)
  let d = aa[0] * bb[0] + aa[1] * bb[1] + aa[2] * bb[2] + aa[3] * bb[3]
  let b2 = bb.slice()
  if (d < 0) {
    d = -d
    b2 = b2.map((v) => -v)
  }
  if (d > 0.9995) {
    // 近平行：线性插值足够，避免 numerically unstable
    return quatNorm(aa.map((v, i) => v + (b2[i] - v) * t))
  }
  const theta0 = Math.acos(Math.max(-1, Math.min(1, d)))
  const theta = theta0 * t
  const sin0 = Math.sin(theta0)
  const sA = Math.sin(theta0 - theta) / sin0
  const sB = Math.sin(theta) / sin0
  return quatNorm(aa.map((v, i) => v * sA + b2[i] * sB))
}

/**
 * 一帧一个「轴角列表」的偏移 → 四元数（按列出顺序：先列出的先作用）。
 * @param {{axis:number[],deg:number}[]} parts
 * @returns {number[]} 单位四元数
 */
export function offsetQuat(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return [0, 0, 0, 1]
  let q = [0, 0, 0, 1]
  for (const part of parts) {
    if (typeof part?.deg !== 'number' || !Number.isFinite(part.deg)) {
      throw new Error(`偏移项缺少有限 deg：${JSON.stringify(part)}`)
    }
    q = quatMul(q, axisAngleQuat(part.axis, part.deg))
  }
  return quatNorm(q)
}

/**
 * 权重曲线：帧 f ∈ [start, end] 内从 1 线性淡出到 0；区间外 = 0。
 * @param {number} f @param {number} start @param {number} end @returns {number}
 */
export function fadeWeight(f, start, end) {
  if (f < start || f > end) return 0
  if (end === start) return 1
  return Math.max(0, Math.min(1, 1 - (f - start) / (end - start)))
}

/**
 * 对单个 clip 应用一条规则；返回被修改的帧数。
 * @param {any} clip clip JSON（nested r：[[x,y,z,w]…]）
 * @param {{clip:string, frames:[number,number], bones:Record<string,{axis:number[],deg:number}[]>}} rule
 * @returns {{framesChanged:number, bones:string[]}}
 */
export function applyRule(clip, rule) {
  const fp = rule?.frames
  if (!Array.isArray(fp) || fp.length !== 2 || !Number.isInteger(fp[0]) || !Number.isInteger(fp[1])) {
    throw new Error(`规则 frames 必须是 [startFrame, endFrame] 整数：${JSON.stringify(fp)}`)
  }
  const [start, end] = fp
  const frames = clip?.frames
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('clip.frames 非法')
  if (start < 0 || end < start || end >= frames) {
    throw new Error(`规则帧区间 [${start},${end}] 超出 clip ${rule.clip} 的 [0,${frames - 1}]`)
  }
  const bones = Object.keys(rule.bones ?? {})
  if (bones.length === 0) throw new Error(`规则 ${rule.clip} 没有 bones`)
  let framesChanged = 0
  for (const bone of bones) {
    const track = clip?.bones?.[bone]
    if (!track || !Array.isArray(track.r)) throw new Error(`clip ${rule.clip} 缺少骨 ${bone} 的 r 轨道`)
    if (track.r.length !== frames) throw new Error(`clip ${rule.clip} 骨 ${bone} r 长度 ≠ frames`)
    const parts = rule.bones[bone]
    const full = offsetQuat(parts)
    for (let f = start; f <= end; f++) {
      const w = fadeWeight(f, start, end)
      if (w === 0) continue
      const rot = track.r[f]
      if (!Array.isArray(rot) || rot.length !== 4) throw new Error(`clip ${rule.clip} 骨 ${bone} 帧 ${f} r 非法`)
      const e = quatSlerp([0, 0, 0, 1], full, w)
      const out = quatNorm(quatMul(e, rot))
      track.r[f] = out
      framesChanged++
    }
  }
  return { framesChanged, bones }
}

/** 配置指纹（幂等标记用） @param {unknown} config @returns {string} */
export function configHash(config) {
  const text = JSON.stringify(config)
  // FNV-1a 32bit（无需引 node:crypto，浏览器/Node 都能跑）
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `fnv1a-${h.toString(16).padStart(8, '0')}`
}

/** 规则校验：返回错误信息数组（空 = 合法） @param {any} config */
export function validatePoseTuneConfig(config) {
  const errors = []
  if (!config || typeof config !== 'object') return ['配置必须是对象']
  if (config.version !== 1) errors.push('version 必须为 1')
  if (!Array.isArray(config.rules) || config.rules.length === 0) errors.push('rules 必须是非空数组')
  for (const [i, rule] of (config.rules ?? []).entries()) {
    if (!rule || typeof rule !== 'object') {
      errors.push(`rules[${i}] 必须是对象`)
      continue
    }
    if (typeof rule.clip !== 'string' || !rule.clip) errors.push(`rules[${i}].clip 必须是非空字符串`)
    if (!Array.isArray(rule.frames) || rule.frames.length !== 2) errors.push(`rules[${i}].frames 必须是 [start,end]`)
    if (!rule.bones || typeof rule.bones !== 'object') errors.push(`rules[${i}].bones 必须是对象`)
    for (const [bone, parts] of Object.entries(rule.bones ?? {})) {
      if (!Array.isArray(parts) || parts.length === 0) {
        errors.push(`rules[${i}].bones.${bone} 必须是非空数组`)
        continue
      }
      for (const part of parts) {
        try {
          normalizeAxis(part?.axis)
        } catch (e) {
          errors.push(`rules[${i}].bones.${bone}: ${e.message}`)
        }
        if (typeof part?.deg !== 'number' || !Number.isFinite(part.deg)) errors.push(`rules[${i}].bones.${bone}: deg 非法`)
      }
    }
  }
  return errors
}
