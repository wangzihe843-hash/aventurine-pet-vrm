/**
 * V6 表情层：HSR Emo_ 解码器单测（`scripts/vrm/expression/lib/hsr-face.mjs`）
 *
 * 不读私有 FBX/采样；用程序化合成的「脸骨采样 JSON + 解码配置」验证：
 * - 四元数工具 / 相对中性帧的层特征；
 * - OMP + NNLS 分解（正交基 → 稀疏权重、非负、残差）；
 * - 派生通道 / preset 规则 / 门控 / blink 特殊处理；
 * - `decodeHsrSamples` 的帧数/时长/loop 归一与输出 clip 合法性；
 * - `validateHsrEmoConfig` 对仓库内真实配置零 error。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  buildSampleIndex,
  decomposeLayer,
  decodeHsrSamples,
  decodeFrame,
  deriveChannels,
  layerFeature,
  mat3MulVec,
  nonNegativeLeastSquares,
  qNorm,
  qConj,
  qMul,
  qNormalize,
  qToMat3,
  qToRotVec,
  resolvePresetWeights,
  validateHsrEmoConfig
} from '../scripts/vrm/expression/lib/hsr-face.mjs'
import { validateExpressionClipData } from '../scripts/vrm/expression/lib/expression-clip.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/* -------------------------------------------------------------------------- */
/* 合成采样/配置                                                               */
/* -------------------------------------------------------------------------- */

/** 轴角 → 四元数 [x,y,z,w]。 */
function qFromAxisAngle(axis: number[], angle: number): number[] {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1
  const half = angle / 2
  const sin = Math.sin(half)
  return [(axis[0] / length) * sin, (axis[1] / length) * sin, (axis[2] / length) * sin, Math.cos(half)]
}

const IDENTITY = [0, 0, 0, 1]

/** 合成骨骼 rest（rest 朝向 = identity，特征 ∥ rotvec，便于断言）。 */
function makeRest(bones: string[]): Record<string, object> {
  const rest: Record<string, object> = {}
  for (const bone of bones) {
    rest[bone] = {
      parent: null,
      head: [0, 1.5, 0],
      tail: [0, 1.55, 0],
      length: 0.05,
      quatArmature: IDENTITY,
      quatParentRelative: IDENTITY
    }
  }
  return rest
}

/** 一个合成 take：每帧给定各骨 local 四元数。 */
function makeTake(frames: Array<Record<string, number[]>>, durationSeconds: number) {
  return {
    action: 'synthetic',
    frames: frames.length,
    durationSeconds,
    bones: Object.keys(frames[0] ?? {}),
    data: frames.map((quats, index) => ({ f: index, q: quats, l: {}, s: {}, h: {}, t: {} }))
  }
}

/** 构造一个「校准姿态 = 每层各自一个旋转」的采样集。 */
function makeSamples() {
  const bones = ['browA', 'browB', 'eyeA', 'mouthA', 'gazeA']
  const rest = makeRest(bones)
  const identityFrame = Object.fromEntries(bones.map((bone) => [bone, IDENTITY])) as Record<string, number[]>
  // 校准姿态：每层不同旋转（brow 两骨、eye 一骨、mouth 一骨）
  const browAngry = {
    browA: qFromAxisAngle([1, 0, 0], 0.2),
    browB: qFromAxisAngle([0, 1, 0], 0.1)
  }
  const eyeClose = { eyeA: qFromAxisAngle([0, 0, 1], 0.4) }
  const eyeSmile = { eyeA: qFromAxisAngle([0, 0, 1], 0.2) }
  const mouthOpen = { mouthA: qFromAxisAngle([1, 0, 0], 0.3) }
  const calm = identityFrame
  const merged = (parts: Array<Record<string, number[]>>) => Object.assign({}, identityFrame, ...parts)
  const takes = {
    emo_default: makeTake([identityFrame, identityFrame], 1 / 60),
    cal_brow_angry: makeTake([merged([browAngry]), merged([browAngry])], 1 / 60),
    cal_eye_close: makeTake([merged([eyeClose]), merged([eyeClose])], 1 / 60),
    cal_eye_smile: makeTake([merged([eyeSmile]), merged([eyeSmile])], 1 / 60),
    cal_mouth_open: makeTake([merged([mouthOpen]), merged([mouthOpen])], 1 / 60),
    // 待解码 take：4 帧；前 2 帧保持校准姿态（应解出 angry）后回到中性
    clip_angry: makeTake(
      [
        merged([browAngry, eyeClose, mouthOpen]),
        merged([browAngry, eyeClose, mouthOpen]),
        mouthOpen ? merged([browAngry]) : identityFrame,
        identityFrame
      ],
      3 / 30
    )
  }
  return { schemaVersion: 1, rest, takes, fps: 30, sourceFps: 60 }
}

function makeConfig() {
  return {
    schemaVersion: 1,
    sampling: { fps: 30, sourceFps: 60, neutralTake: 'emo_default', takes: [] },
    layers: { brow: ['browA', 'browB'], eye: ['eyeA'], mouth: ['mouthA'], gaze: ['gazeA'] },
    calibration: [
      { channel: 'brow_angry', take: 'cal_brow_angry', frame: 0, layer: 'brow' },
      { channel: 'eye_close01', take: 'cal_eye_close', frame: 0, layer: 'eye' },
      { channel: 'eye_close02', take: 'cal_eye_smile', frame: 0, layer: 'eye' },
      { channel: 'mouth_open', take: 'cal_mouth_open', frame: 0, layer: 'mouth' }
    ],
    decomposition: { maxBases: 2, residualTolerance: 0.03, correlationFloor: 0.02 },
    derived: {
      eye_smile: { op: 'max', inputs: ['eye_close02'] }
    },
    presetRules: {
      angry: [
        ['brow_angry', 0.6],
        ['eye_close01', 0.4]
      ],
      happy: [['eye_smile', 1.0]]
    },
    presetGates: { happy: ['brow_angry'] },
    clips: [
      {
        id: 'testAngry',
        take: 'clip_angry',
        loop: true,
        fadeInSec: 0.1,
        fadeOutSec: 0.2,
        triggers: ['angry'],
        tags: ['test'],
        note: 'synthetic'
      }
    ]
  }
}

/* -------------------------------------------------------------------------- */
/* 测试                                                                        */
/* -------------------------------------------------------------------------- */

describe('hsr-face：四元数工具', () => {
  it('qMul / qConj / qNormalize / qToRotVec', () => {
    const a = qFromAxisAngle([0, 0, 1], Math.PI / 3)
    expect(qNorm(qMul(a, qConj(a)))).toBeCloseTo(1, 9)
    const roundTrip = qMul(a, qConj(a))
    expect(roundTrip[3]).toBeCloseTo(1, 9)
    const rotVec = qToRotVec(a)
    expect(rotVec[0]).toBeCloseTo(0, 9)
    expect(rotVec[1]).toBeCloseTo(0, 9)
    expect(rotVec[2]).toBeCloseTo(Math.PI / 3, 9)
    expect(qToRotVec([0, 0, 0, 1])).toEqual([0, 0, 0])
    // 最短弧：-q 与 q 等价
    const negated = qNormalize([-a[0], -a[1], -a[2], -a[3]])
    expect(qToRotVec(negated)[2]).toBeCloseTo(Math.PI / 3, 9)
  })

  it('qToMat3 / mat3MulVec：绕 Z 转 90° 把 +X 转到 +Y', () => {
    const mat = qToMat3(qFromAxisAngle([0, 0, 1], Math.PI / 2))
    const out = mat3MulVec(mat, [1, 0, 0])
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[1]).toBeCloseTo(1, 6)
    expect(out[2]).toBeCloseTo(0, 6)
  })
})

describe('hsr-face：层特征', () => {
  it('相对中性帧的层特征 = rest 旋转矩阵 × local 旋转向量', () => {
    const samples = makeSamples()
    const index = buildSampleIndex(samples)
    const feature = layerFeature(index, 'cal_brow_angry', 0, ['browA', 'browB'])
    expect(feature).toHaveLength(6)
    expect(feature[0]).toBeCloseTo(0.2, 6)
    expect(feature[4]).toBeCloseTo(0.1, 6)
    expect(layerFeature(index, 'emo_default', 0, ['browA', 'browB'])).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('hsr-face：NNLS / OMP 分解', () => {
  it('nonNegativeLeastSquares：正交基 → 精确投影；负方向 → 0', () => {
    const columns = [
      [1, 0],
      [0, 1]
    ]
    expect(nonNegativeLeastSquares(columns, [0.8, 0.5])).toEqual([
      expect.closeTo(0.8, 6),
      expect.closeTo(0.5, 6)
    ])
    const clamped = nonNegativeLeastSquares(
      [
        [1, 0],
        [0, 1]
      ],
      [-2, 3]
    )
    expect(clamped[0]).toBe(0)
    expect(clamped[1]).toBeCloseTo(1.5, 6) // 权重上限 1.5
  })

  it('decomposeLayer：同姿态 → 权重≈1、选中对应基、残差≈0', () => {
    const samples = makeSamples()
    const index = buildSampleIndex(samples)
    const bases = [
      { name: 'brow_angry', vector: layerFeature(index, 'cal_brow_angry', 0, ['browA', 'browB']) },
      { name: 'brow_other', vector: layerFeature(index, 'cal_mouth_open', 0, ['browA', 'browB']) }
    ]
    const feature = layerFeature(index, 'clip_angry', 0, ['browA', 'browB'])
    const result = decomposeLayer(bases.filter((basis) => basis.vector.some((value) => Math.abs(value) > 1e-6)), feature)
    expect(result.weights.brow_angry).toBeCloseTo(1, 3)
    expect(result.residual).toBeLessThan(1e-6)
    // 无能量特征 → 全 0
    const zero = decomposeLayer(bases, [0, 0, 0, 0, 0, 0])
    expect(zero.weights.brow_angry).toBe(0)
    expect(zero.residual).toBe(0)
  })
})

describe('hsr-face：派生通道 / preset 规则 / 门控', () => {
  it('deriveChannels：max 组合', () => {
    expect(deriveChannels({ eye_close: 0.6, eye_shy: 0.9 }, { eye_smile_wide: { op: 'max', inputs: ['eye_close', 'eye_shy'] } })).toMatchObject({
      eye_smile_wide: 0.9
    })
  })

  it('resolvePresetWeights：规则加权 + 门控 + blink 特殊处理', () => {
    const config = makeConfig()
    const angryLike = resolvePresetWeights({ brow_angry: 1, eye_close01: 1, mouth_open: 0.5 }, config)
    expect(angryLike.angry).toBeCloseTo(1, 6) // 0.6*1 + 0.4*1 = 1
    // brow_angry 存在 → happy 被门控压 0；eye_close 计入 blink
    expect(angryLike.happy).toBe(0)
    expect(angryLike.blink).toBeCloseTo(1, 6)

    const smile = resolvePresetWeights({ eye_close02: 1 }, config)
    expect(smile.happy).toBeCloseTo(1, 6)
    expect(smile.blink).toBe(0) // happy 成立时笑眼不算眨眼
  })

  it('真实配置（scripts/vrm/expression/config/hsr-emo.json）零 error，且每条 clip 的 take 都在 sampling 清单里', () => {
    const config = JSON.parse(readFileSync(`${REPO_ROOT}/scripts/vrm/expression/config/hsr-emo.json`, 'utf8'))
    const result = validateHsrEmoConfig(config)
    expect(result.errors).toEqual([])
    const sampled = new Set(config.sampling.takes.map((take: { id: string }) => take.id))
    for (const clip of config.clips) expect(sampled.has(clip.take), clip.id).toBe(true)
    // 每条 preset 规则引用的通道都必须在 calibration/derived 里定义
    const channels = new Set([
      ...config.calibration.map((entry: { channel: string }) => entry.channel),
      ...Object.keys(config.derived ?? {})
    ])
    for (const [preset, rules] of Object.entries(config.presetRules)) {
      for (const [channel] of rules as Array<[string, number]>) expect(channels.has(channel), `${preset}:${channel}`).toBe(true)
    }
  })
})

describe('hsr-face：整条解码', () => {
  it('decodeFrame：校准姿态解出对应 preset', () => {
    const samples = makeSamples()
    const config = makeConfig()
    const validated = validateHsrEmoConfig(config)
    expect(validated.errors).toEqual([])
    // 手工注入 bases（与 decodeHsrSamples 内部一致）
    const index = buildSampleIndex(samples)
    const bases: Record<string, Array<{ name: string; vector: number[] }>> = { brow: [], eye: [], mouth: [] }
    for (const entry of config.calibration) {
      bases[entry.layer].push({ name: entry.channel, vector: layerFeature(index, entry.take, entry.frame, (config.layers as Record<string, string[]>)[entry.layer]) })
    }
    const decoded = decodeFrame(index, { ...config, __bases: bases }, 'clip_angry', 0)
    expect(decoded.presets.angry).toBeGreaterThan(0.9)
    expect(decoded.channels.gaze).toBeCloseTo(0, 6)
  })

  it('decodeHsrSamples：4 源帧 loop → 契约帧数 3、duration=frames/fps、输出可过 QA', () => {
    const { clips, reports, errors } = decodeHsrSamples(makeSamples(), makeConfig())
    expect(errors).toEqual([])
    expect(clips).toHaveLength(1)
    const clip = clips[0].clip
    expect(clip.loop).toBe(true)
    expect(clip.frames).toBe(3) // 源 4 帧，loop 期望 round(0.1*30)=3 → 去掉末帧
    expect(clip.duration).toBeCloseTo(3 / 30, 6)
    expect(Object.keys(clip.tracks)).toContain('angry')
    expect(clip.tracks.angry[0]).toBeGreaterThan(0.9)
    expect(clip.fadeInSec).toBe(0.1)
    const validation = validateExpressionClipData(clip)
    expect(validation.ok, validation.errors.join('；')).toBe(true)
    expect(reports[0].residualMean.brow).toBeLessThan(0.1)
  })

  it('无效配置 / 缺 take → errors（不抛）', () => {
    expect(decodeHsrSamples(makeSamples(), {}).errors.length).toBeGreaterThan(0)
    const config = makeConfig()
    config.clips[0].take = 'missing_take'
    const result = decodeHsrSamples(makeSamples(), config)
    expect(result.clips).toEqual([])
    expect(result.errors.some((error: string) => error.includes('missing_take'))).toBe(true)
  })
})
