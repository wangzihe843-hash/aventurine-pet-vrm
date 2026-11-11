/**
 * V3 HSR→VRM 重定向核心单测（程序化 fixture，不读私有 assets）：
 * - VRM rest 解析 / humanoid 有效父级 / 180° 对齐；
 * - 世界旋转 delta → 归一化局部旋转 的复合正确性；
 * - in-place 位移（水平归零、首帧 p=0）；
 * - 脚部 grounding 把最低脚骨拉回 rest 高度；
 * - loop / 非 loop 帧数约定。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- 纯 ESM 无声明（tests 不参与 tsc）
import { buildVrmRest, buildAlignment } from '../scripts/vrm/motion/lib/vrm-rest.mjs'
// @ts-expect-error -- 同上
import {
  retargetClip,
  clipFrameCount,
  applyFootGrounding,
  simulateNormalizedHumanoid,
  worldDeltaMatrix,
  applyAlignment,
  isRestLikeReferenceFrame
} from '../scripts/vrm/motion/lib/retarget.mjs'
// @ts-expect-error -- 同上
import { qAngleDeg, qNormalize } from '../scripts/vrm/motion/lib/quat.mjs'
// @ts-expect-error -- 同上
import { UNITY_NAME_BY_VRM, HSR_TO_VRM_HUMANOID, resolveHumanoidMapping } from '../scripts/vrm/motion/lib/humanoid-hsr.mjs'
import {
  makeSyntheticVrm,
  makeSyntheticHsrSamples,
  makeClipDef,
  composeQuat,
  yawQuat,
  type SyntheticVrm
} from './fixtures/vrm-motion/fixtures'

function buildRest(vrm: SyntheticVrm) {
  return buildVrmRest(vrm)
}

describe('VRM rest 解析', () => {
  it('解析 humanoid 与 effectiveParent', () => {
    const rest = buildRest(makeSyntheticVrm())
    expect(Object.keys(rest.humanoid)).toHaveLength(22)
    expect(rest.effectiveParent.leftUpperLeg).toBe('hips')
    expect(rest.effectiveParent.spine).toBe('hips')
    expect(rest.effectiveParent.leftLowerArm).toBe('leftUpperArm')
    expect(rest.humanoid.hips.nodeName).toBe('hips')
  })
})

describe('坐标系对齐 R_align', () => {
  it('同坐标系 rest → 单位旋转', () => {
    const rest = buildRest(makeSyntheticVrm())
    const samples = makeSyntheticHsrSamples()
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    expect(qAngleDeg(alignment.quat, [0, 0, 0, 1])).toBeLessThan(0.01)
  })

  it('HSR rest 镜像 180° yaw → R_align = 180° about Y', () => {
    const rest = buildRest(makeSyntheticVrm())
    const samples = makeSyntheticHsrSamples({ mirrored: true })
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    expect(qAngleDeg(alignment.quat, [0, 1, 0, 0])).toBeLessThan(0.01)
    // 映射 right/up/forward
    const mapped = alignment.matrix.map((row) => [row[0], row[1], row[2]])
    expect(mapped[0][0]).toBeCloseTo(-1, 5)
    expect(mapped[1][1]).toBeCloseTo(1, 5)
    expect(mapped[2][2]).toBeCloseTo(-1, 5)
  })
})

describe('retargetClip', () => {
  it('世界 delta 复合正确 + 首帧 Hips.p 归零 + 水平位移归零', () => {
    const vrm = makeSyntheticVrm()
    const rest = buildRest(vrm)
    const samples = makeSyntheticHsrSamples({ frames: 3 })
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    const secondaryMap = { nodeToBone: new Map(), chainReports: [], counts: { hairNodes: 0, clothNodes: 0 }, warnings: [] }
    const { clip } = retargetClip({
      clipId: 'test',
      clipDef: makeClipDef({ loop: false }), // 3 帧都能用上
      sampleClip: samples.clips.test,
      samples,
      vrmRest: rest,
      alignment,
      secondaryMap,
      options: { grounding: 'per-clip' }
    })
    expect(clip.frames).toBe(3)
    expect(clip.loop).toBe(false)
    expect(Object.keys(clip.bones)).toHaveLength(22)
    const p0 = clip.bones.Hips.p[0]
    expect(Math.hypot(p0[0], p0[1], p0[2])).toBeLessThan(1e-4)
    for (const frame of [0, 1, 2]) {
      const p = clip.bones.Hips.p[frame]
      expect(p[0]).toBeCloseTo(0, 4)
      expect(p[2]).toBeCloseTo(0, 4)
    }
    // 所有骨每帧绕 Y 旋转（源数据: frame*10°），复合后 LeftHand 世界旋转应为 frame*10°
    for (const frame of [0, 1, 2]) {
      const chain = ['LeftHand', 'LeftLowerArm', 'LeftUpperArm', 'LeftShoulder', 'UpperChest', 'Chest', 'Spine', 'Hips']
      const quats = chain.map((bone) => clip.bones[bone].r[frame])
      const composed = composeQuat(quats)
      const expected = [0, Math.sin((frame * 10 * Math.PI) / 180 / 2), 0, Math.cos((frame * 10 * Math.PI) / 180 / 2)]
      expect(qAngleDeg(composed, expected)).toBeLessThan(0.5)
    }
    // q 单位化
    for (const bone of Object.values(clip.bones) as Array<{ r: number[][] }>) {
      for (const q of bone.r) expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(1e-4)
    }
  })

  it('镜像源经过 R_align 后与未镜像源产出一致', () => {
    const vrm = makeSyntheticVrm()
    const rest = buildRest(vrm)
    const secondaryMap = { nodeToBone: new Map(), chainReports: [], counts: { hairNodes: 0, clothNodes: 0 }, warnings: [] }
    const run = (mirrored: boolean) => {
      const samples = makeSyntheticHsrSamples({ frames: 3, mirrored })
      const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
      return retargetClip({
        clipId: 'test',
        clipDef: makeClipDef({ loop: false }),
        sampleClip: samples.clips.test,
        samples,
        vrmRest: rest,
        alignment,
        secondaryMap,
        options: { grounding: 'per-clip' }
      }).clip
    }
    const plain = run(false)
    const mirrored = run(true)
    for (const frame of [0, 1, 2]) {
      for (const bone of ['Hips', 'Spine', 'LeftUpperArm', 'RightLowerArm', 'LeftHand']) {
        const a = plain.bones[bone].r[frame]
        const b = mirrored.bones[bone].r[frame]
        expect(qAngleDeg(a, b)).toBeLessThan(0.5)
      }
    }
  })
})

describe('clipFrameCount', () => {
  it('loop 与非 loop 的帧数约定', () => {
    expect(clipFrameCount({ loop: true, duration: 2, fps: 30 })).toBe(60)
    expect(clipFrameCount({ loop: false, duration: 2, fps: 30 })).toBe(61)
    expect(clipFrameCount({ loop: false, duration: 1.5, fps: 30 })).toBe(46)
  })
})

describe('脚部 grounding', () => {
  it('把最低脚骨误差收敛为常数（相对首帧），且不改水平位移', () => {
    const rest = buildRest(makeSyntheticVrm())
    const names = rest.humanoidOrder
    const frames = 5
    // 所有骨 identity；左/右脚绕 X 轴逐步旋转（抬脚），hips p 为 0
    const tracks = new Map(names.map((name) => [name, Array.from({ length: frames }, () => [0, 0, 0, 1])]))
    const footTrack = Array.from({ length: frames }, (_unused, frame) => {
      const angle = (frame * 12 * Math.PI) / 180
      return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]
    })
    tracks.set('leftFoot', footTrack)
    const hipsP = Array.from({ length: frames }, () => [0, 0, 0])
    const result = applyFootGrounding({
      vrmRest: rest,
      tracksByVrmName: tracks,
      frames,
      hipsP,
      sourceHipsHeightMeters: 0.95
    })
    // 相对首帧：首帧 p 保持 0
    expect(result.hipsP[0][0]).toBeCloseTo(0, 6)
    expect(result.hipsP[0][1]).toBeCloseTo(0, 6)
    expect(result.stats.footErrorAfter.max - result.stats.footErrorAfter.min).toBeLessThan(1e-4)
    // 重新正解算验证：脚部误差为常数（无穿地/悬空抖动）
    const scale = result.scale
    const scaledP = result.hipsP.map((p) => [p[0] * scale, p[1] * scale, p[2] * scale])
    const simulated = simulateNormalizedHumanoid(rest, tracks, frames, scaledP)
    const footBones = ['leftFoot', 'leftToes', 'rightFoot', 'rightToes']
    const restY = footBones.map((name) => rest.humanoid[name].position[1])
    const errors = []
    for (let frame = 0; frame < frames; frame += 1) {
      let minDelta = Infinity
      footBones.forEach((name, index) => {
        const position = simulated[frame].worldPos.get(name)
        minDelta = Math.min(minDelta, position[1] - restY[index])
      })
      errors.push(minDelta)
    }
    expect(Math.max(...errors) - Math.min(...errors)).toBeLessThan(1e-4)
  })
})

describe('Hips 基准 hipsBase=rest（跪/趴/起身/受击）', () => {
  const secondaryMap = {
    nodeToBone: new Map(),
    chainReports: [],
    counts: { hairNodes: 0, clothNodes: 0 },
    warnings: []
  }

  /** 复制 fixture 采样并把 Hips 世界高度改为「跪姿/起身」曲线（首帧不再是站立）。 */
  function makeDeepHipsSamples(offsets: number[]) {
    const samples = makeSyntheticHsrSamples({ frames: offsets.length })
    const data = samples.clips.test.data
    const restY = samples.rest.Root_M.head[1]
    data.forEach((frame, index) => {
      frame.h.Root_M = [frame.h.Root_M[0], restY + offsets[index], frame.h.Root_M[2]]
    })
    return samples
  }

  it('rest 基准保留绝对髋高偏移（首帧不为 0），first-frame 基准则首帧归零', () => {
    const vrm = makeSyntheticVrm()
    const rest = buildRest(vrm)
    const samples = makeDeepHipsSamples([-0.4, -0.35, -0.3])
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    const run = (hipsBase: string) =>
      retargetClip({
        clipId: 'test',
        clipDef: makeClipDef({ loop: false, grounding: 'none', hipsBase }),
        sampleClip: samples.clips.test,
        samples,
        vrmRest: rest,
        alignment,
        secondaryMap,
        options: { grounding: 'per-clip' }
      }).clip
    const relative = run('first-frame')
    const absolute = run('rest')
    expect(relative.bones.Hips.p[0][1]).toBeCloseTo(0, 6)
    expect(absolute.bones.Hips.p[0][1]).toBeCloseTo(-0.4, 4)
    expect(absolute.bones.Hips.p[2][1]).toBeCloseTo(-0.3, 4)
    // 水平位移仍然原地化
    for (const p of absolute.bones.Hips.p) {
      expect(p[0]).toBeCloseTo(0, 6)
      expect(p[2]).toBeCloseTo(0, 6)
    }
    // clip 显式记录 hipsBase，供 QA/播放侧识别
    expect(absolute.hipsBase).toBe('rest')
    expect(relative.hipsBase).toBeUndefined()
  })

  it('rest 基准下 0.535m 的起身位移不被 staging 启发式误清（first-frame 仍按 0.5m 阈值）', () => {
    const vrm = makeSyntheticVrm()
    const rest = buildRest(vrm)
    // 0.55m 高度范围：真实起身量级（revive 0.535m），不是 HSR staging（数米）
    const samples = makeDeepHipsSamples([-0.5, -0.2, 0.05])
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    const run = (hipsBase: string) =>
      retargetClip({
        clipId: 'test',
        clipDef: makeClipDef({ loop: false, grounding: 'none', hipsBase }),
        sampleClip: samples.clips.test,
        samples,
        vrmRest: rest,
        alignment,
        secondaryMap,
        options: { grounding: 'per-clip' }
      }).clip
    const absolute = run('rest')
    expect(absolute.bones.Hips.p[0][1]).toBeCloseTo(-0.5, 4)
    expect(absolute.bones.Hips.p[2][1]).toBeCloseTo(0.05, 4)
    // first-frame 基准：范围 0.55 > 0.5 → 按 staging 归零（旧行为保持）
    const relative = run('first-frame')
    expect(Math.max(...relative.bones.Hips.p.map((p: number[]) => Math.abs(p[1])))).toBe(0)
  })
})

describe('参考帧裁剪启发式（T-pose 参考帧 vs 真实受击 snap）', () => {
  const secondaryMap = {
    nodeToBone: new Map(),
    chainReports: [],
    counts: { hairNodes: 0, clothNodes: 0 },
    warnings: []
  }

  function runTrim(firstAngleDeg: number, nextAngleDeg: number) {
    const vrm = makeSyntheticVrm()
    const rest = buildRest(vrm)
    const samples = makeSyntheticHsrSamples({ frames: 4 })
    const data = samples.clips.test.data
    data.forEach((frame, index) => {
      const angle = index === 0 ? firstAngleDeg : nextAngleDeg
      const rotation = yawQuat(angle)
      for (const bone of Object.keys(frame.q)) frame.q[bone] = rotation
    })
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    return retargetClip({
      clipId: 'test',
      clipDef: makeClipDef({ loop: false, grounding: 'none' }),
      sampleClip: samples.clips.test,
      samples,
      vrmRest: rest,
      alignment,
      secondaryMap,
      options: { grounding: 'per-clip' }
    }).report
  }

  it('参考帧判定：接近 rest 才算参考帧', () => {
    const rest = { A: { quat: [0, 0, 0, 1] }, B: { quat: [0, 0, 0, 1] } }
    expect(isRestLikeReferenceFrame({ q: { A: [0, 0, 0, 1], B: [0, 0, 0, 1] } }, rest)).toBe(true)
    expect(isRestLikeReferenceFrame({ q: { A: yawQuat(90), B: yawQuat(90) } }, rest)).toBe(false)
    expect(isRestLikeReferenceFrame({ q: {} }, {})).toBe(false)
  })

  it('首帧接近 rest 且次帧大幅跳变 → 视为参考帧裁掉', () => {
    expect(runTrim(0, 90).trimmedReferenceFrames).toBe(1)
  })

  it('首帧本身就是真实动作（偏差大）→ 不裁（受击 snap 不应被吃掉）', () => {
    expect(runTrim(60, 150).trimmedReferenceFrames).toBe(0)
  })
})

describe('worldDeltaMatrix / applyAlignment', () => {
  it('D = pose · restᵀ；对齐保持旋转角', () => {
    const rest = [0, 0, 0, 1]
    const pose = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] // 90° yaw
    const delta = worldDeltaMatrix(pose, rest)
    const aligned = applyAlignment(
      [
        [-1, 0, 0],
        [0, 1, 0],
        [0, 0, -1]
      ],
      delta
    )
    // 180°yaw 共轭 90°yaw = 90°yaw（旋转角不变）
    const trace = aligned[0][0] + aligned[1][1] + aligned[2][2]
    const angle = (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI
    expect(angle).toBeCloseTo(90, 5)
    expect(qNormalize([0, 0, 0, 1])).toEqual([0, 0, 0, 1])
  })
})
function makeNoUpperChestFixture({ armDownDeg = 0 } = {}) {
  const vrm = makeSyntheticVrm({ includeUpperChest: false })
  const rest = buildVrmRest(vrm)
  const samples = makeSyntheticHsrSamples({ frames: 3, armDownDeg })
  const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
  return { vrm, rest, samples, alignment }
}

describe('T-pose 目标适配（无 upperChest）', () => {
  it('alignment 回退用 chest 定义 up 轴 → identity', () => {
    const { alignment } = makeNoUpperChestFixture()
    expect(alignment.upperChestFallback).toBe(true)
    expect(qAngleDeg(alignment.quat, [0, 0, 0, 1])).toBeLessThan(0.01)
  })

  it('resolveHumanoidMapping：spine←Spine1_M、chest←Chest_M、无 upperChest', () => {
    const { rest } = makeNoUpperChestFixture()
    const info = resolveHumanoidMapping(rest)
    expect(info.mapping.spine).toBe('Spine1_M')
    expect(info.mapping.chest).toBe('Chest_M')
    expect(info.mapping.upperChest).toBeUndefined()
    expect(info.upperChestFallback).toBe(true)
    expect(info.notes.length).toBeGreaterThan(0)
  })

  it('retarget 后 22 骨契约完整、UpperChest 为 identity', () => {
    const { rest, samples, alignment } = makeNoUpperChestFixture()
    const { clip } = retargetClip({
      clipId: 'test',
      clipDef: makeClipDef({ loop: false }),
      sampleClip: samples.clips.test,
      samples,
      vrmRest: rest,
      alignment,
      secondaryMap: null,
      options: { rawEnabled: false, rawPolicy: 'spring' }
    })
    expect(clip.frames).toBe(3)
    expect(Object.keys(clip.bones)).toHaveLength(22)
    expect(clip.raw).toBeUndefined()
    expect(clip.rawPolicy).toBe('spring')
    for (const q of clip.bones.UpperChest.r) expect(q).toEqual([0, 0, 0, 1])
    expect(clip.bones.Chest).toBeTruthy()
  })
})

describe('rest 方向修正（源 A-pose / 目标 T-pose）', () => {
  function wristError(clip: any, rest: any, samples: any) {
    const tracks = new Map()
    for (const [vrmName, unity] of Object.entries(UNITY_NAME_BY_VRM) as Array<[string, string]>) {
      const track = clip.bones[unity]?.r
      if (track) tracks.set(vrmName, track.map((q: number[]) => q.slice()))
    }
    const framesP = clip.bones.Hips.p.map((p: number[]) => [p[0] * 0.737, p[1] * 0.737, p[2] * 0.737])
    const sim = simulateNormalizedHumanoid(rest, tracks, clip.frames, framesP)
    const pose = sim[0].worldPos
    const targetVec = [
      pose.get('leftHand')[0] - pose.get('leftShoulder')[0],
      pose.get('leftHand')[1] - pose.get('leftShoulder')[1],
      pose.get('leftHand')[2] - pose.get('leftShoulder')[2]
    ]
    const src = samples.clips.test.data[0].h
    const anchor = HSR_TO_VRM_HUMANOID.leftShoulder
    const expected = [
      src.Wrist_L[0] - src[anchor][0],
      src.Wrist_L[1] - src[anchor][1],
      src.Wrist_L[2] - src[anchor][2]
    ]
    return Math.hypot(targetVec[0] - expected[0], targetVec[1] - expected[1], targetVec[2] - expected[2])
  }

  it('修正后手腕位置贴合源（无修正时偏差 >10cm）', () => {
    const { rest, samples, alignment } = makeNoUpperChestFixture({ armDownDeg: 40 })
    const run = (restDirectionFix: boolean) =>
      retargetClip({
        clipId: 'test',
        clipDef: makeClipDef({ loop: false, grounding: 'none' }),
        sampleClip: samples.clips.test,
        samples,
        vrmRest: rest,
        alignment,
        secondaryMap: null,
        options: { rawEnabled: false, rawPolicy: 'spring', restDirectionFix, grounding: 'none' }
      }).clip
    const without = wristError(run(false), rest, samples)
    const withFix = wristError(run(true), rest, samples)
    expect(without).toBeGreaterThan(0.1)
    expect(withFix).toBeLessThan(0.02)
    expect(withFix).toBeLessThan(without / 5)
  })
})
