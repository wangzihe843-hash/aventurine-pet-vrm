/**
 * HSR Emo_ 脸骨动画 → VRM 1.0 preset 表情 clip（纯函数，dev-only）
 *
 * 输入 = `sample-hsr-emo.py` 产出的脸骨采样 JSON（73 根脸骨、30fps 逐帧 local 四元数），
 * 输出 = 本仓库 `ExpressionClip` 数据（VRM1 preset 权重轨道）。
 *
 * 解码思路（参考 ARKitMapper 的组合子范式 + 本机实测校准，详见 `docs/expression-mapping.md`）：
 * 1. **相对中性帧**：中性 = `emo_default` 首帧；每根骨算 local 四元数增量，转到 armature 空间
 *    得到旋转向量（axis*angle），拼成该「层」（眉/眼/口/注视）的特征向量；
 * 2. **校准基 + 稀疏非负分解（OMP + NNLS）**：用 5 个 PhotoGraph 姿态 + 3 个 Close 眼型 +
 *    受击眼型作为各层基姿态；每帧求 ≤3 个基姿态的非负线性组合（表情层本质是离散姿态混合，
 *    普通 NNLS 在共线基上会把权重摊开；OMP 先选最相关基再拟合，得到稀疏、幅度≈1 的层强度）；
 * 3. **层强度 → VRM preset**：按目标模型 preset 的 morph 组合（眉/眼/口各占权重）加权求和，
 *    带互斥门控（怒眉/困扰眉下不判定 happy/surprised/relaxed），眨眼通道特殊处理
 *    （笑眼闭眼只在 happy 未成立时计入 blink）。
 *
 * 设计目标：**用模型自带 preset 表情**（用户要求），不搬 HSR 的 73 骨脸骨/材质；
 * 目标模型没有 jaw 骨、没有舌头 morph → 张嘴/舌头信息只能落到 `aa/ih/ou/ee/oh` 或丢弃。
 */
import {
  buildExpressionClip,
  expectedFrameCount,
  isPresetTrack,
  sanitizeExpressionClip
} from './expression-clip.mjs'

/* -------------------------------------------------------------------------- */
/* 四元数 / 矩阵工具（[x,y,z,w]）                                                */
/* -------------------------------------------------------------------------- */

/** 四元数模长。 */
export function qNorm(q) {
  return Math.hypot(q[0], q[1], q[2], q[3])
}

/** 归一化（零四元数 → identity）。 */
export function qNormalize(q) {
  const n = qNorm(q)
  if (!(n > 1e-12)) return [0, 0, 0, 1]
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** 四元数乘法 a*b（Hamilton 积）。 */
export function qMul(a, b) {
  const [x1, y1, z1, w1] = a
  const [x2, y2, z2, w2] = b
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2
  ]
}

/** 共轭（逆，单位四元数）。 */
export function qConj(q) {
  return [-q[0], -q[1], -q[2], q[3]]
}

/** 四元数 → 旋转向量（axis*angle，取最短弧）。 */
export function qToRotVec(q) {
  const n = qNormalize(q)
  const w = n[3] < 0 ? -n[3] : n[3]
  const sx = n[3] < 0 ? -n[0] : n[0]
  const sy = n[3] < 0 ? -n[1] : n[1]
  const sz = n[3] < 0 ? -n[2] : n[2]
  const s = Math.hypot(sx, sy, sz)
  if (!(s > 1e-12)) return [0, 0, 0]
  const angle = 2 * Math.atan2(s, w)
  return [(sx / s) * angle, (sy / s) * angle, (sz / s) * angle]
}

/** 四元数 → 3x3 旋转矩阵（行主序，armature 空间 rest 朝向）。 */
export function qToMat3(q) {
  const [x, y, z, w] = qNormalize(q)
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ]
}

/** 3x3 矩阵乘向量。 */
export function mat3MulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

/** 向量点积 / 模长 / 线性组合。 */
export function dot(a, b) {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index]
  return sum
}
export function norm(a) {
  return Math.sqrt(dot(a, a))
}
function axpy(target, alpha, x) {
  for (let index = 0; index < target.length; index += 1) target[index] += alpha * x[index]
  return target
}

/* -------------------------------------------------------------------------- */
/* 采样数据索引                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 从采样 JSON 建索引（中性帧 / rest 旋转矩阵 / 各 take 的帧数据）。
 * @param {object} samples `emo-face-samples.json`
 * @param {{ neutralTake?: string, neutralFrame?: number }} [options]
 */
export function buildSampleIndex(samples, options = {}) {
  const neutralTake = options.neutralTake ?? 'emo_default'
  const neutralFrame = options.neutralFrame ?? 0
  const takes = samples.takes ?? {}
  if (!takes[neutralTake]) throw new Error(`采样缺少中性 take：${neutralTake}`)
  const neutralData = takes[neutralTake].data ?? []
  const neutral = neutralData[neutralFrame]?.q ?? neutralData[0]?.q ?? {}
  /** @type {Record<string, number[]>} bone → 3x3 rest rotation */
  const restRot = {}
  for (const [bone, info] of Object.entries(samples.rest ?? {})) {
    if (info && Array.isArray(info.quatArmature)) restRot[bone] = qToMat3(info.quatArmature)
  }
  return { takes, neutral, restRot, neutralTake, neutralFrame }
}

/** 单帧某层旋转向量（长度 = 3 × 层骨数）。 */
export function layerFeature(index, takeId, frameIdx, layerBones) {
  const take = index.takes[takeId]
  if (!take) throw new Error(`采样缺少 take：${takeId}`)
  const frame = take.data?.[frameIdx]
  if (!frame) throw new Error(`take ${takeId} 缺第 ${frameIdx} 帧`)
  const out = new Array(layerBones.length * 3).fill(0)
  for (let boneIndex = 0; boneIndex < layerBones.length; boneIndex += 1) {
    const bone = layerBones[boneIndex]
    const qf = frame.q?.[bone]
    const qn = index.neutral[bone]
    const rot = index.restRot[bone]
    if (!qf || !qn || !rot) continue
    // 相对中性的 local 增量 → armature 空间旋转向量
    const dq = qMul(qConj(qn), qf)
    const rotVec = qToRotVec(dq)
    const world = mat3MulVec(rot, rotVec)
    out[boneIndex * 3] = world[0]
    out[boneIndex * 3 + 1] = world[1]
    out[boneIndex * 3 + 2] = world[2]
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* OMP + NNLS：每层稀疏非负分解                                                   */
/* -------------------------------------------------------------------------- */

/** 解 k×k 线性方程组（Gauss-Jordan；奇异时加 ridge）。 */
function solveLinearSystem(matrix, rhs) {
  const k = rhs.length
  const a = matrix.map((row) => row.slice())
  const b = rhs.slice()
  for (let col = 0; col < k; col += 1) {
    let pivot = col
    for (let row = col + 1; row < k; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) continue
    if (pivot !== col) {
      const tmpRow = a[col]
      a[col] = a[pivot]
      a[pivot] = tmpRow
      const tmpB = b[col]
      b[col] = b[pivot]
      b[pivot] = tmpB
    }
    const diag = a[col][col]
    for (let row = 0; row < k; row += 1) {
      if (row === col) continue
      const factor = a[row][col] / diag
      if (factor === 0) continue
      for (let inner = col; inner < k; inner += 1) a[row][inner] -= factor * a[col][inner]
      b[row] -= factor * b[col]
    }
  }
  const out = new Array(k).fill(0)
  for (let index = 0; index < k; index += 1) {
    out[index] = Math.abs(a[index][index]) > 1e-12 ? b[index] / a[index][index] : 0
  }
  return out
}

/**
 * 小型非负最小二乘 `min ||A·w − b||, w ∈ [0, 1.5]`（列数 ≤9）。
 * 与参考实现一致：最小二乘解 + 投影梯度迭代（步长 0.5/max(1, ||A||₂²)）。
 * @param {number[][]} columns A 的列向量（每列长度 = 特征维度）
 * @param {number[]} target b
 */
export function nonNegativeLeastSquares(columns, target) {
  const k = columns.length
  if (k === 0) return []
  // 正规方程 G = A^T A, c = A^T b
  const g = Array.from({ length: k }, () => new Array(k).fill(0))
  const c = new Array(k).fill(0)
  for (let row = 0; row < k; row += 1) {
    c[row] = dot(columns[row], target)
    for (let col = 0; col < k; col += 1) g[row][col] = dot(columns[row], columns[col])
  }
  let ridge = 0
  for (let index = 0; index < k; index += 1) ridge = Math.max(ridge, Math.abs(g[index][index]))
  const regularization = Math.max(1e-12, ridge * 1e-10)
  for (let index = 0; index < k; index += 1) g[index][index] += regularization
  let weights = solveLinearSystem(g, c)
  const clip = (value) => Math.min(1.5, Math.max(0, value))
  weights = weights.map(clip)
  // 投影梯度精修（与参考实现的迭代截断等价，收敛到同一非负解）
  // ||A||₂² ≈ λmax(G)：幂迭代 8 次估计
  let lambda = 1
  let vector = new Array(k).fill(1 / Math.sqrt(k))
  for (let iter = 0; iter < 8; iter += 1) {
    const next = new Array(k).fill(0)
    for (let row = 0; row < k; row += 1) {
      let sum = 0
      for (let col = 0; col < k; col += 1) sum += g[row][col] * vector[col]
      next[row] = sum
    }
    const length = norm(next)
    if (!(length > 1e-12)) break
    lambda = length
    vector = next.map((value) => value / length)
  }
  const step = 0.5 / Math.max(1, lambda)
  for (let iter = 0; iter < 40; iter += 1) {
    const gradient = new Array(k).fill(0)
    for (let row = 0; row < k; row += 1) {
      let sum = 0
      for (let col = 0; col < k; col += 1) sum += g[row][col] * weights[col]
      gradient[row] = sum - c[row]
    }
    const next = weights.map((value, index) => clip(value - step * gradient[index]))
    let delta = 0
    for (let index = 0; index < k; index += 1) delta = Math.max(delta, Math.abs(next[index] - weights[index]))
    weights = next
    if (delta < 1e-10) break
  }
  return weights
}

/**
 * OMP + NNLS：每层最多 `maxBases` 个基姿态的非负组合（稀疏可解释）。
 * @param {Array<{name: string, vector: number[]}>} bases 该层基姿态
 * @param {number[]} feature 该帧层特征向量
 * @param {{ maxBases?: number, residualTolerance?: number, correlationFloor?: number }} [options]
 * @returns {{ weights: Record<string, number>, residual: number, selected: string[] }}
 */
export function decomposeLayer(bases, feature, options = {}) {
  const maxBases = options.maxBases ?? 3
  const residualTolerance = options.residualTolerance ?? 0.03
  const correlationFloor = options.correlationFloor ?? 0.02
  const us = bases.map((basis) => basis.vector)
  const names = bases.map((basis) => basis.name)
  const featureNorm = norm(feature)
  const weights = new Array(us.length).fill(0)
  if (us.length === 0 || !(featureNorm > 1e-12)) {
    return { weights: Object.fromEntries(names.map((name) => [name, 0])), residual: 0, selected: [] }
  }
  const columnNorms = us.map((column) => Math.max(1e-12, norm(column)))
  const unitColumns = us.map((column, index) => column.map((value) => value / columnNorms[index]))
  const selected = []
  let residualVector = feature.slice()
  for (let step = 0; step < maxBases; step += 1) {
    let best = -1
    let bestCorr = -Infinity
    for (let index = 0; index < us.length; index += 1) {
      if (selected.includes(index)) continue
      const corr = dot(unitColumns[index], residualVector)
      if (corr > bestCorr) {
        bestCorr = corr
        best = index
      }
    }
    if (best < 0 || bestCorr <= correlationFloor * featureNorm) break
    selected.push(best)
    const selectedColumns = selected.map((index) => us[index])
    const solved = nonNegativeLeastSquares(selectedColumns, feature)
    const approximation = new Array(feature.length).fill(0)
    for (let index = 0; index < selected.length; index += 1) axpy(approximation, solved[index], selectedColumns[index])
    residualVector = feature.map((value, index) => value - approximation[index])
    if (norm(residualVector) <= residualTolerance * featureNorm) break
  }
  if (selected.length > 0) {
    const selectedColumns = selected.map((index) => us[index])
    const solved = nonNegativeLeastSquares(selectedColumns, feature)
    selected.forEach((baseIndex, index) => {
      weights[baseIndex] = solved[index] ?? 0
    })
  }
  const approximation = new Array(feature.length).fill(0)
  for (let index = 0; index < weights.length; index += 1) axpy(approximation, weights[index], us[index])
  let errorSquared = 0
  for (let index = 0; index < feature.length; index += 1) {
    const diff = feature[index] - approximation[index]
    errorSquared += diff * diff
  }
  return {
    weights: Object.fromEntries(names.map((name, index) => [name, weights[index]])),
    residual: Math.sqrt(errorSquared) / Math.max(featureNorm, 1e-12),
    selected: selected.map((index) => names[index])
  }
}

/* -------------------------------------------------------------------------- */
/* 配置校验 / 解码                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 校验 hsr-emo 配置（`scripts/vrm/expression/config/hsr-emo.json`）。
 * @param {unknown} config
 * @returns {{ errors: string[], config: object | null }}
 */
export function validateHsrEmoConfig(config) {
  const errors = []
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { errors: ['配置必须是对象'], config: null }
  }
  const layers = config.layers
  if (typeof layers !== 'object' || layers === null) errors.push('缺少 layers')
  for (const layer of ['brow', 'eye', 'mouth']) {
    if (!Array.isArray(layers?.[layer]) || layers[layer].length === 0) errors.push(`layers.${layer} 必须是非空数组`)
  }
  const calibration = Array.isArray(config.calibration) ? config.calibration : []
  if (calibration.length === 0) errors.push('calibration 为空')
  for (const [index, entry] of calibration.entries()) {
    if (typeof entry?.channel !== 'string' || entry.channel.length === 0) errors.push(`calibration[${index}] 缺 channel`)
    if (typeof entry?.take !== 'string') errors.push(`calibration[${index}] 缺 take`)
    if (!['brow', 'eye', 'mouth'].includes(entry?.layer)) errors.push(`calibration[${index}] layer 非法`)
    if (!Number.isInteger(entry?.frame) || entry.frame < 0) errors.push(`calibration[${index}] frame 非法`)
  }
  const presetRules = config.presetRules
  if (typeof presetRules !== 'object' || presetRules === null) errors.push('缺少 presetRules')
  for (const [preset, rules] of Object.entries(presetRules ?? {})) {
    if (!isPresetTrack(preset)) errors.push(`presetRules.${preset} 不是 VRM1 preset 轨道`)
    if (!Array.isArray(rules)) {
      errors.push(`presetRules.${preset} 必须是 [channel, coefficient] 数组`)
      continue
    }
    for (const rule of rules) {
      if (!Array.isArray(rule) || rule.length !== 2 || typeof rule[0] !== 'string' || !Number.isFinite(rule[1])) {
        errors.push(`presetRules.${preset} 规则非法`)
      }
    }
  }
  const clips = Array.isArray(config.clips) ? config.clips : []
  if (clips.length === 0) errors.push('clips 为空')
  const seen = new Set()
  for (const [index, clip] of clips.entries()) {
    if (typeof clip?.id !== 'string' || clip.id.length === 0) errors.push(`clips[${index}] 缺 id`)
    else if (seen.has(clip.id)) errors.push(`clips[${index}] id 重复：${clip.id}`)
    if (typeof clip?.take !== 'string' || clip.take.length === 0) errors.push(`clips[${index}] 缺 take`)
    if (typeof clip?.loop !== 'boolean') errors.push(`clips[${index}] loop 必须为布尔值`)
    if (clip?.id) seen.add(clip.id)
  }
  const neutralTake = config.sampling?.neutralTake ?? 'emo_default'
  if (typeof neutralTake !== 'string' || neutralTake.length === 0) errors.push('sampling.neutralTake 非法')
  const fps = config.sampling?.fps ?? 30
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) errors.push('sampling.fps 非法')
  return { errors, config: errors.length === 0 ? config : null }
}

/** 派生通道（如 eye_smile = max(close02, close03)）。 */
export function deriveChannels(channels, derived) {
  const out = { ...channels }
  for (const [name, rule] of Object.entries(derived ?? {})) {
    const inputs = Array.isArray(rule?.inputs) ? rule.inputs : []
    const op = rule?.op ?? 'max'
    const values = inputs.map((input) => out[input] ?? 0)
    if (values.length === 0) {
      out[name] = 0
      continue
    }
    out[name] = op === 'min' ? Math.min(...values) : op === 'mean' ? values.reduce((a, b) => a + b, 0) / values.length : Math.max(...values)
  }
  return out
}

/** 门控乘子：存在更强的其它通道时压低（防过渡帧误亮）。 */
function gateMultiplier(channels, gateChannels) {
  let maxValue = 0
  for (const name of gateChannels ?? []) maxValue = Math.max(maxValue, channels[name] ?? 0)
  return Math.min(1, Math.max(0, 1 - maxValue))
}

/**
 * 层强度 → preset 权重（0..1）。
 * @param {Record<string, number>} channels
 * @param {object} config hsr-emo 配置
 */
export function resolvePresetWeights(channels, config) {
  const derived = deriveChannels(channels, config.derived)
  const presets = {}
  const gates = config.presetGates ?? {}
  for (const [preset, rules] of Object.entries(config.presetRules ?? {})) {
    let value = 0
    for (const [channel, coefficient] of rules) value += coefficient * (derived[channel] ?? 0)
    value *= gateMultiplier(derived, gates[preset])
    presets[preset] = Math.min(1, Math.max(0, value))
  }
  // 眨眼通道：正常闭眼 + 受击紧闭眼 + （happy 未成立时的）笑眼闭眼
  const happyGate = gateMultiplier(derived, gates.happy ?? [])
  const closedAny = Math.max(
    derived.eye_close01 ?? 0,
    Math.min(1, derived.eye_battle ?? 0),
    (1 - happyGate) * Math.max(derived.eye_close02 ?? 0, derived.eye_close03 ?? 0)
  )
  presets.blink = Math.min(1, Math.max(0, closedAny))
  return presets
}

/** 一帧的层强度 + preset 权重（解码主函数）。 */
export function decodeFrame(index, config, takeId, frameIdx) {
  const channels = {}
  const residuals = {}
  const bases = config.__bases
  for (const layer of ['brow', 'eye', 'mouth']) {
    const layerBases = bases[layer]
    const feature = layerFeature(index, takeId, frameIdx, config.layers[layer])
    const result = decomposeLayer(layerBases, feature, config.decomposition ?? {})
    Object.assign(channels, result.weights)
    residuals[layer] = result.residual
  }
  // 注视通道：眼/眼球骨旋转向量模长（rad）；只作诊断，不驱动表情
  const gazeFeature = layerFeature(index, takeId, frameIdx, config.layers.gaze ?? [])
  channels.gaze = norm(gazeFeature)
  const presets = resolvePresetWeights(channels, config)
  return { channels, presets, residuals }
}

/**
 * 全量解码：采样 JSON → 每个配置 clip 的 `ExpressionClip`。
 * @param {object} samples `emo-face-samples.json`
 * @param {object} config `hsr-emo.json`
 * @returns {{ clips: Array<{ clip: object, config: object, report: object }>, reports: Array<object>, errors: string[] }}
 */
export function decodeHsrSamples(samples, config) {
  const { errors, config: valid } = validateHsrEmoConfig(config)
  if (errors.length > 0) return { clips: [], reports: [], errors }
  const index = buildSampleIndex(samples, { neutralTake: valid.sampling?.neutralTake ?? 'emo_default' })
  // 校准基（每层）
  const bases = { brow: [], eye: [], mouth: [] }
  for (const entry of valid.calibration) {
    const layerBones = valid.layers[entry.layer]
    try {
      const vector = layerFeature(index, entry.take, entry.frame, layerBones)
      if (norm(vector) > 1e-9) bases[entry.layer].push({ name: entry.channel, vector })
    } catch (error) {
      return { clips: [], reports: [], errors: [`校准姿态不可用 ${entry.channel}：${error instanceof Error ? error.message : String(error)}`] }
    }
  }
  const internalConfig = { ...valid, __bases: bases }
  const fps = valid.sampling?.fps ?? 30
  const clips = []
  const reports = []
  const decodeErrors = []
  for (const clipConfig of valid.clips) {
    const take = index.takes[clipConfig.take]
    if (!take) {
      decodeErrors.push(`clip ${clipConfig.id} 引用的 take 不存在：${clipConfig.take}`)
      continue
    }
    const sourceFrames = take.data.length
    const duration = take.durationSeconds
    const loop = clipConfig.loop === true
    const expected = expectedFrameCount(duration, fps, loop)
    // 采样含首末两端（frames = round+1）；loop clip 去掉末帧（= 首帧）以满足契约帧数。
    let useFrames = sourceFrames
    if (loop && sourceFrames === expected + 1) useFrames = expected
    if (!loop && sourceFrames === expected) useFrames = expected
    const frameCount = Math.min(useFrames, expected)
    /** @type {Record<string, number[]>} */
    const trackValues = {}
    const channelMean = {}
    const residualMean = { brow: 0, eye: 0, mouth: 0 }
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const decoded = decodeFrame(index, internalConfig, clipConfig.take, frameIndex)
      for (const [preset, value] of Object.entries(decoded.presets)) {
        const cap = clipConfig.presetCaps?.[preset]
        const weighted = Math.min(value, Number.isFinite(cap) ? cap : 1)
        if (!trackValues[preset]) trackValues[preset] = []
        trackValues[preset].push(weighted)
        channelMean[preset] = (channelMean[preset] ?? 0) + weighted
      }
      for (const layer of ['brow', 'eye', 'mouth']) residualMean[layer] += decoded.residuals[layer] ?? 0
    }
    for (const preset of Object.keys(channelMean)) channelMean[preset] /= Math.max(1, frameCount)
    for (const layer of ['brow', 'eye', 'mouth']) residualMean[layer] /= Math.max(1, frameCount)
    // loop clip 的 duration 按「帧数/fps」归一（静态姿态源采样只有 2 帧/0.0167s，
    // 直接用源时长会得到 1 帧 0.0167s 的过短 clip；契约要求 duration ≈ frames/fps）。
    const clipDuration = loop ? frameCount / fps : duration
    let clip
    try {
      clip = buildExpressionClip({
        id: clipConfig.id,
        source: 'hsr',
        sourceFile: take.action,
        fps,
        duration: clipDuration,
        loop,
        tracks: trackValues,
        fadeInSec: clipConfig.fadeInSec,
        fadeOutSec: clipConfig.fadeOutSec,
        notes: clipConfig.note
      })
    } catch (error) {
      decodeErrors.push(`clip ${clipConfig.id} 构建失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    clips.push({ clip, config: clipConfig })
    reports.push({
      id: clipConfig.id,
      take: clipConfig.take,
      action: take.action,
      loop,
      fps,
      frames: clip.frames,
      duration: clip.duration,
      sourceFrames,
      expectedFrames: expected,
      tracks: Object.fromEntries(Object.entries(clip.tracks).map(([name, values]) => [name, {
        max: Math.max(...values),
        mean: values.reduce((a, b) => a + b, 0) / values.length
      }])),
      presetMean: channelMean,
      residualMean
    })
  }
  return { clips, reports, errors: decodeErrors }
}
