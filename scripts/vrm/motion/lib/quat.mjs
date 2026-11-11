/**
 * 四元数 / 3x3 矩阵纯函数（V3 动作管线 / retarget 数学，环境中立、无依赖）。
 *
 * 约定（与 glTF / three.js / three-vrm 一致）：
 * - 四元数为 `[x, y, z, w]` 数组（单位四元数），矩阵为 3x3 嵌套数组（列向量右乘）；
 * - 旋转作用于列向量：v' = R v，其中 R = mat3FromQuat(q)；
 * - 四元数乘法 qMul(a,b) 对应矩阵乘法 mat(a) * mat(b)（Hamilton，右手系）。
 *
 * 这些函数被 `retarget-hsr.mjs`、`qa.mjs` 与单测共用；不做 IO。
 */

/** @typedef {[number, number, number, number]} Quat */
/** @typedef {[[number,number,number],[number,number,number],[number,number,number]]} Mat3 */

export const QUAT_IDENTITY = Object.freeze([0, 0, 0, 1])

/** @returns {Quat} */
export function qIdentity() {
  return [0, 0, 0, 1]
}

/** @param {number[]} q @returns {Quat} */
export function qNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** @param {number[]} a @param {number[]} b @returns {Quat} */
export function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

/** @param {number[]} q @returns {Quat} */
export function qInvert(q) {
  return [-q[0], -q[1], -q[2], q[3]]
}

/** @param {number[]} a @param {number[]} b */
export function qDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

/** 两个旋转的夹角（度，0–180）。 */
export function qAngleDeg(a, b) {
  const dot = Math.min(1, Math.max(-1, Math.abs(qDot(qNormalize(a), qNormalize(b)))))
  return (Math.acos(dot) * 360) / Math.PI
}

/** 四元数 → 3x3 矩阵。 @param {number[]} q @returns {Mat3} */
export function mat3FromQuat(q) {
  const [x, y, z, w] = qNormalize(q)
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
  ]
}

/** 3x3 矩阵 → 四元数（单位化；处理 trace≤0 的分支）。 @param {Mat3} m @returns {Quat} */
export function quatFromMat3(m) {
  const trace = m[0][0] + m[1][1] + m[2][2]
  let x
  let y
  let z
  let w
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    w = 0.25 * s
    x = (m[2][1] - m[1][2]) / s
    y = (m[0][2] - m[2][0]) / s
    z = (m[1][0] - m[0][1]) / s
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2
    w = (m[2][1] - m[1][2]) / s
    x = 0.25 * s
    y = (m[0][1] + m[1][0]) / s
    z = (m[0][2] + m[2][0]) / s
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2
    w = (m[0][2] - m[2][0]) / s
    x = (m[0][1] + m[1][0]) / s
    y = 0.25 * s
    z = (m[1][2] + m[2][1]) / s
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2
    w = (m[1][0] - m[0][1]) / s
    x = (m[0][2] + m[2][0]) / s
    y = (m[1][2] + m[2][1]) / s
    z = 0.25 * s
  }
  return qNormalize([x, y, z, w])
}

/** @param {Mat3} a @param {Mat3} b @returns {Mat3} */
export function mat3Mul(a, b) {
  /** @type {Mat3} */
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col]
    }
  }
  return out
}

/** @param {Mat3} m @returns {Mat3} */
export function mat3Transpose(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]]
  ]
}

/** 由三个列向量构造矩阵（列 = 基向量）。 */
export function mat3FromColumns(c0, c1, c2) {
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]]
  ]
}

/** @param {Mat3} m @param {number[]} v @returns {[number, number, number]} */
export function mat3MulVec(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
  ]
}

/** @param {number[]} q @param {number[]} v @returns {[number,number,number]} */
export function qRotateVec(q, v) {
  return mat3MulVec(mat3FromQuat(q), v)
}

/** @param {number[]} a 单位向量 @param {number[]} b 单位向量 @returns {Quat} 最短弧 a→b */
export function qSwingFromTo(a, b) {
  const av = normalize3(a)
  const bv = normalize3(b)
  const dot = av[0] * bv[0] + av[1] * bv[1] + av[2] * bv[2]
  if (dot > 1 - 1e-12) return qIdentity()
  if (dot < -1 + 1e-12) {
    // 反向：绕任意与 a 垂直的轴旋转 180°
    const axis = normalize3(orthogonal3(av))
    return [axis[0], axis[1], axis[2], 0]
  }
  const cross = [av[1] * bv[2] - av[2] * bv[1], av[2] * bv[0] - av[0] * bv[2], av[0] * bv[1] - av[1] * bv[0]]
  const q = qNormalize([cross[0], cross[1], cross[2], 1 + dot])
  return q
}

/** @param {number[]} v @returns {[number,number,number]} */
export function normalize3(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** 与 v 垂直的任意单位向量。 */
export function orthogonal3(v) {
  const axis = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return normalize3([
    v[1] * axis[2] - v[2] * axis[1],
    v[2] * axis[0] - v[0] * axis[2],
    v[0] * axis[1] - v[1] * axis[0]
  ])
}

/** 连续化四元数序列：与上一帧点积为负时翻符号（避免 slerp/插值绕远路）。 */
export function makeQuatTrackContinuous(track) {
  /** @type {Quat[]} */
  const out = []
  let prev = null
  for (const q of track) {
    let cur = qNormalize(q)
    if (prev && qDot(prev, cur) < 0) cur = [-cur[0], -cur[1], -cur[2], -cur[3]]
    out.push(cur)
    prev = cur
  }
  return out
}
