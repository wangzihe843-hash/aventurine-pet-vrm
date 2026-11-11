/**
 * V3.1 Biped → VRM 重定向单测（程序化 fixture，不读私有 assets）：
 * - Biped 骨名解析/命名变体（Bip001/Bip01/无前缀、Left/Right、后缀侧标、大小写）；
 * - target-aware 映射：3 节脊柱 → 目标 2 档（spine←Spine、chest←Spine2、Spine1 并入）；
 * - 手指语义：Finger0=拇指（文档证据 + rest 方向打分数值复核）、Finger0..4 × 3 节 → 30 指；
 * - R_align（同向 → identity；180° yaw → 180°）；
 * - retargetClip（可插拔 source）：22 骨契约/52 骨、Hips.p/in-place、grounding、躯干世界旋转合成、
 *   手指局部旋转、rest 方向修正（A-pose 源 → 手腕误差 <2cm）；
 * - 默认 source（不传）== 显式 HSR 描述符（保证现有 HSR 行为不变）；
 * - 源缺骨健壮性（identity 补轨 + 告警）。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- 纯 ESM 无声明（tests 不参与 tsc）
import { buildVrmRest, buildAlignment } from '../scripts/vrm/motion/lib/vrm-rest.mjs'
// @ts-expect-error -- 同上
import {
  retargetClip,
  createHsrSource,
  simulateNormalizedHumanoid
} from '../scripts/vrm/motion/lib/retarget.mjs'
// @ts-expect-error -- 同上
import {
  parseBipedBoneName,
  resolveBipedSkeleton,
  resolveBipedMapping,
  resolveSpineSlots,
  createBipedSource,
  buildBipedMappingReport,
  BIPED_FINGER_LAYOUT
} from '../scripts/vrm/motion/lib/humanoid-biped.mjs'
// @ts-expect-error -- 同上
import { validateClipStructure } from '../scripts/vrm/motion/lib/qa.mjs'
// @ts-expect-error -- 同上
import { UNITY_NAME_BY_VRM } from '../scripts/vrm/motion/lib/humanoid-hsr.mjs'
// @ts-expect-error -- 同上
import { qAngleDeg, qMul, qNormalize } from '../scripts/vrm/motion/lib/quat.mjs'
import {
  makeSyntheticBipedVrm,
  makeSyntheticBipedSamples,
  makeBipedClipDef,
  axisAngleQuat,
  VRM_REST_POSITIONS,
  BIPED_NAME_BY_VRM
} from './fixtures/vrm-motion/biped-fixtures.mjs'
import { makeSyntheticVrm, makeSyntheticHsrSamples, makeClipDef } from './fixtures/vrm-motion/fixtures'

const IDENTITY = [0, 0, 0, 1]

interface SetupOptions {
  includeUpperChest?: boolean
  withFingers?: boolean
  scale?: number
  mirrored?: boolean
  armDownDeg?: number
  frames?: number
}

function setup(options: SetupOptions = {}) {
  const { includeUpperChest = false, withFingers = true, scale, mirrored, armDownDeg, frames = 5 } = options
  const vrmRest = buildVrmRest(makeSyntheticBipedVrm({ includeUpperChest, withFingers }))
  const samples = makeSyntheticBipedSamples({ scale, mirrored, armDownDeg, frames })
  const source = createBipedSource({ samples, strict: true })
  const alignment = buildAlignment({ vrmRest, source })
  return { vrmRest, samples, source, alignment }
}

type Setup = ReturnType<typeof setup>

function runClip(
  fixture: Setup,
  id: string,
  clipDefOverrides: Record<string, unknown> = {},
  options: Record<string, unknown> = {}
) {
  return retargetClip({
    clipId: id,
    clipDef: makeBipedClipDef({ id, ...clipDefOverrides }),
    sampleClip: fixture.samples.clips[id],
    samples: fixture.samples,
    vrmRest: fixture.vrmRest,
    alignment: fixture.alignment,
    secondaryMap: null,
    source: fixture.source,
    options: { rawEnabled: false, rawPolicy: 'spring', ...options }
  })
}

/** 归一化链复合（从 hips 往下乘到目标骨）。 */
function composeWorld(clip: any, frame: number, unityChain: string[]) {
  let result = [0, 0, 0, 1]
  for (const bone of unityChain) {
    const track = clip.bones[bone]
    if (!track) throw new Error(`composeWorld: clip 缺骨 ${bone}`)
    result = qNormalize(qMul(result, track.r[frame]))
  }
  return result
}

/** 归一化骨架正解算 frame0 的世界位置。 */
function simulateFrame0(clip: any, vrmRest: any) {
  const tracks = new Map<string, number[][]>()
  for (const [vrmName, unityName] of Object.entries(UNITY_NAME_BY_VRM) as Array<[string, string]>) {
    const track = clip.bones[unityName]?.r
    if (track) tracks.set(vrmName, track.map((q: number[]) => q.slice()))
  }
  const scale = vrmRest.humanoid.hips.position[1] / clip.sourceHipsHeight
  const p = clip.bones.Hips.p[0]
  const sim = simulateNormalizedHumanoid(vrmRest, tracks, 1, [[p[0] * scale, p[1] * scale, p[2] * scale]])
  return sim[0].worldPos
}

function vecSub(a: number[], b: number[]) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function vecLen(v: number[]) {
  return Math.hypot(v[0], v[1], v[2])
}

/** 把一个 Biped rest 的骨名整体改名（验证命名变体匹配）。 */
function renameBipedRest(rest: any, rename: (name: string) => string) {
  const output: any = {}
  for (const [name, info] of Object.entries(rest) as Array<[string, any]>) {
    output[rename(name)] = {
      ...info,
      head: info.head.slice(),
      quat: info.quat.slice(),
      parent: info.parent ? rename(info.parent) : null
    }
  }
  return output
}

describe('Biped 骨名解析（命名变体）', () => {
  it('标准 Bip001 命名', () => {
    const pelvis = parseBipedBoneName('Bip001 Pelvis')
    expect(pelvis.kind).toBe('pelvis')
    expect(pelvis.prefix).toBe('Bip001')
    expect(pelvis.side).toBeNull()
    const clavicle = parseBipedBoneName('Bip001 L Clavicle')
    expect(clavicle).toMatchObject({ kind: 'clavicle', side: 'left' })
    expect(parseBipedBoneName('Bip001 R Thigh')).toMatchObject({ kind: 'thigh', side: 'right' })
    expect(parseBipedBoneName('Bip001 Spine')).toMatchObject({ kind: 'spine', index: 0 })
    expect(parseBipedBoneName('Bip001 Spine1')).toMatchObject({ kind: 'spine', index: 1 })
    expect(parseBipedBoneName('Bip001 Spine2')).toMatchObject({ kind: 'spine', index: 2 })
    expect(parseBipedBoneName('Bip001 Toe0')).toMatchObject({ kind: 'toe', index: 0 })
  })

  it('手指链：Finger0/01/02 = 拇指三节；Finger1/11/12 = 食指三节', () => {
    expect(parseBipedBoneName('Bip001 L Finger0')).toMatchObject({ kind: 'finger', chain: 0, link: 0, side: 'left' })
    expect(parseBipedBoneName('Bip001 L Finger01')).toMatchObject({ kind: 'finger', chain: 0, link: 1 })
    expect(parseBipedBoneName('Bip001 L Finger02')).toMatchObject({ kind: 'finger', chain: 0, link: 2 })
    expect(parseBipedBoneName('Bip001 L Finger1')).toMatchObject({ kind: 'finger', chain: 1, link: 0 })
    expect(parseBipedBoneName('Bip001 L Finger11')).toMatchObject({ kind: 'finger', chain: 1, link: 1 })
    expect(parseBipedBoneName('Bip001 L Finger12')).toMatchObject({ kind: 'finger', chain: 1, link: 2 })
    expect(parseBipedBoneName('Bip001 L Finger41')).toMatchObject({ kind: 'finger', chain: 4, link: 1 })
    // 分隔符变体
    expect(parseBipedBoneName('Bip001 L Finger0_1')).toMatchObject({ kind: 'finger', chain: 0, link: 1 })
    expect(parseBipedBoneName('Bip001 L Finger0Link2')).toMatchObject({ kind: 'finger', chain: 0, link: 2 })
  })

  it('命名变体：Bip01 / 无前缀 / Left-Right / 后缀侧标 / 大小写', () => {
    expect(parseBipedBoneName('Bip01 Pelvis')).toMatchObject({ kind: 'pelvis', prefix: 'Bip01' })
    expect(parseBipedBoneName('Pelvis')).toMatchObject({ kind: 'pelvis', prefix: null })
    expect(parseBipedBoneName('Bip01 Left UpperArm')).toMatchObject({ kind: 'upperArm', side: 'left' })
    expect(parseBipedBoneName('Bip01 Thigh_R')).toMatchObject({ kind: 'thigh', side: 'right' })
    expect(parseBipedBoneName('Bip01 Clavicle.L')).toMatchObject({ kind: 'clavicle', side: 'left' })
    expect(parseBipedBoneName('bip01 pelvis')).toMatchObject({ kind: 'pelvis' })
    expect(parseBipedBoneName('Bip01 L_Hand')).toMatchObject({ kind: 'hand', side: 'left' })
    // Biped COM / Footsteps / Nub 属于可忽略骨
    expect(parseBipedBoneName('Bip001')).toMatchObject({ kind: 'root' })
    expect(parseBipedBoneName('Bip001 Footsteps')).toMatchObject({ kind: 'ignored' })
    expect(parseBipedBoneName('Bip001 L Finger0Nub')).toMatchObject({ kind: 'ignored' })
    expect(parseBipedBoneName('Bip001 HeadNub')).toMatchObject({ kind: 'ignored' })
  })

  it('整骨架改名后仍能解析出 52 根 humanoid 源骨', () => {
    const samples = makeSyntheticBipedSamples()
    const variants: Array<[string, (name: string) => string]> = [
      ['Bip001→Bip01 + Left/Right', (name) => name.replace(/^Bip001 L /, 'Bip01 Left ').replace(/^Bip001 R /, 'Bip01 Right ').replace(/^Bip001 /, 'Bip01 ')],
      ['去前缀', (name) => name.replace(/^Bip001 /, '')],
      ['全小写', (name) => name.toLowerCase()],
      ['后缀侧标', (name) => name.replace(/^Bip001 ([LR]) /, (_all, side: string) => `Bip001 ${side === 'L' ? 'Left' : 'Right'} `).replace(/^Bip001 (Left|Right) (\w+)$/, 'Bip001 $2_$1')]
    ]
    for (const [label, rename] of variants) {
      const rest = renameBipedRest(samples.rest, rename)
      const skeleton = resolveBipedSkeleton(rest)
      expect(skeleton.pelvis, label).toBeTruthy()
      expect(skeleton.spineLinks.length, label).toBe(3)
      expect(skeleton.arms.left.upperArm, label).toMatch(/UpperArm|upperarm/)
      const source = createBipedSource({ samples: { ...samples, rest }, strict: true })
      const mapping = source.resolveMapping(buildVrmRest(makeSyntheticBipedVrm()))
      expect(Object.keys(mapping.mapping).length, label).toBe(51)
    }
  })
})

describe('target-aware 映射（3 节脊柱 → 2 档 / upperChest）', () => {
  it('目标无 upperChest：spine←Spine、chest←Spine2、Spine1 并入 chest、UpperChest identity', () => {
    const { vrmRest } = setup()
    const skeleton = resolveBipedSkeleton(makeSyntheticBipedSamples().rest)
    const info = resolveBipedMapping(vrmRest, skeleton)
    expect(info.upperChestFallback).toBe(true)
    expect(info.mapping.spine).toBe('Bip001 Spine')
    expect(info.mapping.chest).toBe('Bip001 Spine2')
    expect(info.mapping.upperChest).toBeUndefined()
    expect(info.spine.merged).toEqual(['Bip001 Spine1'])
    expect(info.notes.join(' ')).toContain('并入 chest')
  })

  it('目标有 upperChest：spine←Spine、chest←Spine1、upperChest←Spine2（1:1 分布）', () => {
    const vrmRest = buildVrmRest(makeSyntheticBipedVrm({ includeUpperChest: true }))
    const skeleton = resolveBipedSkeleton(makeSyntheticBipedSamples().rest)
    const info = resolveBipedMapping(vrmRest, skeleton)
    expect(info.upperChestFallback).toBe(false)
    expect(info.mapping.spine).toBe('Bip001 Spine')
    expect(info.mapping.chest).toBe('Bip001 Spine1')
    expect(info.mapping.upperChest).toBe('Bip001 Spine2')
    expect(info.spine.merged).toEqual([])
  })

  it('resolveSpineSlots 的边界：1/2/3/5 节脊柱', () => {
    expect(resolveSpineSlots(['S0'], false).chest).toBe('S0')
    expect(resolveSpineSlots(['S0', 'S1'], false).merged).toEqual([])
    expect(resolveSpineSlots(['S0', 'S1', 'S2'], false).merged).toEqual(['S1'])
    const five = resolveSpineSlots(['S0', 'S1', 'S2', 'S3', 'S4'], false)
    expect(five.spine).toBe('S0')
    expect(five.chest).toBe('S4')
    expect(five.merged).toEqual(['S1', 'S2', 'S3'])
  })

  it('22 核心骨 + 30 手指全部映射；非 humanoid 骨被忽略', () => {
    const fixture = setup()
    const info = fixture.source.resolveMapping(fixture.vrmRest)
    expect(Object.keys(info.mapping).length).toBe(51) // 21 core（无 upperChest）+ 30 手指
    expect(info.mapping.leftThumbMetacarpal).toBe('Bip001 L Finger0')
    expect(info.mapping.leftIndexDistal).toBe('Bip001 L Finger12')
    expect(info.mapping.rightLittleProximal).toBe('Bip001 R Finger4')
    expect(fixture.source.skeleton.ignored).toContain('Bip001 Footsteps')
    expect(fixture.source.skeleton.ignored).toContain('Bip001 L Finger0Nub')
  })

  it('手指语义证据：Finger0=拇指（rest 方向打分：拇指赋值显著优于拇指→食指错配）', () => {
    const fixture = setup()
    const report = buildBipedMappingReport({ source: fixture.source, vrmRest: fixture.vrmRest, alignment: fixture.alignment })
    expect(BIPED_FINGER_LAYOUT[0].vrm[0]).toBe('ThumbMetacarpal')
    expect(report.fingers.assignment.left.chosenIsBest).toBe(true)
    expect(report.fingers.assignment.left.thumbVsIndexDeg).toBeGreaterThan(20)
    expect(report.fingers.assignment.chosenMeanDeg).toBeLessThan(2)
    expect(report.fingers.layout['0'].label).toBe('thumb')
  })
})

describe('R_align（源/目标 rest 几何）', () => {
  it('同向 Y-up 骨架 → identity', () => {
    const { alignment } = setup()
    expect(qAngleDeg(alignment.quat, IDENTITY)).toBeLessThan(0.01)
  })

  it('源 rest 绕 Y 180° → R_align = 180° yaw', () => {
    const fixture = setup({ mirrored: true })
    expect(qAngleDeg(fixture.alignment.quat, [0, 1, 0, 0])).toBeLessThan(0.01)
    expect(fixture.alignment.matrix[0][0]).toBeCloseTo(-1, 5)
    expect(fixture.alignment.matrix[1][1]).toBeCloseTo(1, 5)
    expect(fixture.alignment.matrix[2][2]).toBeCloseTo(-1, 5)
  })

  it('镜像源与未镜像源 retarget 后产出一致', () => {
    const plain = setup({ mirrored: false })
    const mirrored = setup({ mirrored: true })
    const clipA = runClip(plain, 'idle', { grounding: 'none' }).clip
    const clipB = runClip(mirrored, 'idle', { grounding: 'none' }).clip
    for (const frame of [0, 1, 2]) {
      for (const bone of ['Hips', 'Spine', 'Chest', 'LeftUpperArm', 'RightLowerArm', 'LeftHand']) {
        expect(qAngleDeg(clipA.bones[bone].r[frame], clipB.bones[bone].r[frame]), bone).toBeLessThan(0.5)
      }
    }
  })
})

describe('retargetClip（Biped source）', () => {
  it('clip 结构：52 骨（22 契约 + 30 手指）、Hips.p 首帧归零、元数据来自 source', () => {
    const fixture = setup()
    const { clip } = runClip(fixture, 'idle', { grounding: 'none' }, {
      targetVrm: 'assets/vrm/aventurine-tpose.vrm',
      targetAvatarId: 'aventurine-waveflair'
    })
    expect(clip.version).toBe(1)
    expect(clip.space).toBe('gltf-rh')
    expect(clip.frames).toBe(5)
    expect(clip.loop).toBe(true)
    expect(clip.duration).toBeCloseTo(5 / 30, 6)
    expect(clip.avatar).toBe('Avatar_AventurineW_00')
    expect(clip.targetAvatarId).toBeTruthy()
    expect(clip.sourceHipsHeight).toBeCloseTo(0.95949, 4)
    expect(Object.keys(clip.bones).length).toBe(52) // 21 core + UpperChest(identity) + 30 手指
    expect(clip.bones.UpperChest).toBeTruthy()
    for (const q of clip.bones.UpperChest.r) expect(q).toEqual(IDENTITY)
    expect(clip.bones.Hips.p.length).toBe(5)
    const p0 = clip.bones.Hips.p[0]
    expect(Math.hypot(p0[0], p0[1], p0[2])).toBeLessThan(1e-6)
    const structure = validateClipStructure(clip, fixture.vrmRest)
    expect(structure.errors).toEqual([])
    expect(structure.stats.humanoidBones).toBe(52)
  })

  it('in-place：水平位移归零、竖直位移保留（grounding=none）', () => {
    const fixture = setup()
    const { clip } = runClip(fixture, 'idle', { grounding: 'none' })
    clip.bones.Hips.p.forEach((p: number[], frame: number) => {
      expect(p[0]).toBeCloseTo(0, 6)
      expect(p[2]).toBeCloseTo(0, 6)
      expect(p[1]).toBeCloseTo(frame * 0.005, 6)
    })
  })

  it('grounding=feet：竖直 bob 被抵消（脚贴 rest 高度），scale = targetHips/sourceHips', () => {
    const fixture = setup()
    const { clip, report } = runClip(fixture, 'idle', { grounding: 'feet' })
    expect(clip.grounding).toBe('feet')
    expect(report.groundStats).toBeTruthy()
    expect(report.groundStats.scale).toBeCloseTo(1.0661103 / 0.95949, 3)
    for (const p of clip.bones.Hips.p) expect(Math.abs(p[1])).toBeLessThan(1e-6)
    expect(report.groundStats.footErrorAfter.max - report.groundStats.footErrorAfter.min).toBeLessThan(0.005)
  })

  it('grounding=none 显式标注时不做贴地补偿', () => {
    const fixture = setup()
    const { clip, report } = runClip(fixture, 'idle', { grounding: 'none' })
    expect(clip.grounding).toBe('none')
    expect(report.groundStats).toBeNull()
  })

  it('世界旋转合成：手臂链世界朝向 == 源骨世界旋转（10°/帧）', () => {
    const fixture = setup()
    const { clip } = runClip(fixture, 'idle', { grounding: 'none' })
    for (const frame of [0, 1, 2, 3, 4]) {
      const world = composeWorld(clip, frame, ['Hips', 'Spine', 'Chest', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm'])
      expect(qAngleDeg(world, axisAngleQuat([0, 0, 1], frame * 10))).toBeLessThan(0.1)
    }
  })

  it('躯干映射：spine←Spine、chest←Spine2（Spine1 旋转并入 chest 局部）', () => {
    const fixture = setup()
    const { clip } = runClip(fixture, 'torso', { grounding: 'none' })
    for (const frame of [1, 2, 3]) {
      const spineWorld = composeWorld(clip, frame, ['Hips', 'Spine'])
      expect(qAngleDeg(spineWorld, axisAngleQuat([0, 1, 0], frame * 10)), `spine@${frame}`).toBeLessThan(0.1)
      const chestWorld = composeWorld(clip, frame, ['Hips', 'Spine', 'Chest'])
      expect(qAngleDeg(chestWorld, axisAngleQuat([0, 1, 0], frame * 40)), `chest@${frame}`).toBeLessThan(0.1)
      // chest 局部旋转 = Spine2 − Spine = 30°/帧（含 Spine1 的 10°/帧 + Spine2 的 20°/帧）
      expect(qAngleDeg(clip.bones.Chest.r[frame], IDENTITY)).toBeCloseTo(frame * 30, 1)
    }
  })

  it('手指映射：30 轨道齐全，局部旋转按链逐节递增', () => {
    const fixture = setup()
    const { clip } = runClip(fixture, 'fingers', { grounding: 'none' })
    const fingerBones = Object.keys(clip.bones).filter((name) => /Thumb|Index|Middle|Ring|Little/.test(name))
    expect(fingerBones.length).toBe(30)
    const frame = 4
    const bend = (frame / 4) * 30
    for (const bone of ['LeftThumbMetacarpal', 'LeftIndexProximal', 'LeftIndexIntermediate', 'LeftIndexDistal', 'RightLittleDistal']) {
      expect(qAngleDeg(clip.bones[bone].r[frame], IDENTITY), bone).toBeCloseTo(bend, 1)
    }
    // 拇指三节都来自 Biped Finger0 链
    expect(clip.bones.LeftThumbMetacarpal).toBeTruthy()
    expect(clip.bones.RightThumbDistal).toBeTruthy()
  })

  it('rest 方向修正：A-pose 源（手臂下斜 40°）→ 修正后手腕误差 <2cm', () => {
    const fixture = setup({ armDownDeg: 40, scale: 1 })
    const run = (restDirectionFix: boolean) => runClip(fixture, 'idle', { grounding: 'none' }, { restDirectionFix }).clip
    const wristError = (clip: any) => {
      const worldPos = simulateFrame0(clip, fixture.vrmRest)
      const targetVec = vecSub(worldPos.get('leftHand'), worldPos.get('leftUpperArm'))
      const sourceRest = fixture.samples.rest
      const expectedVec = vecSub(sourceRest['Bip001 L Hand'].head, sourceRest['Bip001 L UpperArm'].head)
      return vecLen(vecSub(targetVec, expectedVec))
    }
    const without = wristError(run(false))
    const withFix = wristError(run(true))
    expect(without).toBeGreaterThan(0.1)
    expect(withFix).toBeLessThan(0.02)
    expect(withFix).toBeLessThan(without / 5)
    // 修正表覆盖上臂/前臂/手/手指
    const withReport = runClip(fixture, 'idle', { grounding: 'none' })
    expect(withReport.report.restFix.bones).toBeGreaterThan(30)
    expect(withReport.report.restFix.groups.upperArm.corrected).toBe(2)
  })

  it('采样器可对单 clip 覆盖 sourceFps（混合帧率源容错，纯增量字段）', () => {
    const fixture = setup({ frames: 10 })
    const clipDef = makeBipedClipDef({ id: 'idle', grounding: 'none' })
    const base = fixture.samples.clips.idle
    const { clip } = retargetClip({
      clipId: 'idle',
      clipDef,
      sampleClip: { ...base, sourceFps: 60 }, // 源声明 60fps → 时长减半（10/60 s）
      samples: fixture.samples,
      vrmRest: fixture.vrmRest,
      alignment: fixture.alignment,
      secondaryMap: null,
      source: fixture.source,
      options: { rawEnabled: false, rawPolicy: 'spring' }
    })
    expect(clip.frames).toBe(5)
    expect(clip.duration).toBeCloseTo(5 / 30, 6)
  })

  it('目标无手指骨时只写 22 骨，且告警说明目标缺手指', () => {
    const fixture = setup({ withFingers: false })
    const { clip, report } = runClip(fixture, 'idle', { grounding: 'none' })
    expect(Object.keys(clip.bones).length).toBe(22)
    expect(report.warnings.some((warning: string) => warning.includes('目标 VRM 缺少 humanoid 骨'))).toBe(true)
  })

  it('源缺 Neck 骨（非严格模式）→ 22 骨契约仍完整（identity 补轨 + 告警）', () => {
    const samples = makeSyntheticBipedSamples()
    const rest: any = {}
    for (const [name, info] of Object.entries(samples.rest) as Array<[string, any]>) {
      if (name === 'Bip001 Neck') continue
      rest[name] = { ...info, head: info.head.slice(), quat: info.quat.slice() }
    }
    // 断开 Neck 的父链引用（Head 的 parent 指向已删除的 Neck 不影响映射，但保持数据自洽）
    const vrmRest = buildVrmRest(makeSyntheticBipedVrm())
    const source = createBipedSource({ samples: { ...samples, rest }, strict: false })
    const alignment = buildAlignment({ vrmRest, source })
    const { clip, report } = retargetClip({
      clipId: 'idle',
      clipDef: makeBipedClipDef({ id: 'idle', grounding: 'none' }),
      sampleClip: samples.clips.idle,
      samples: { ...samples, rest },
      vrmRest,
      alignment,
      secondaryMap: null,
      source,
      options: { rawEnabled: false, rawPolicy: 'spring' }
    })
    expect(Object.keys(clip.bones).length).toBe(52)
    expect(clip.bones.Neck).toBeTruthy()
    for (const q of clip.bones.Neck.r) expect(q).toEqual(IDENTITY)
    expect(report.warnings.some((warning: string) => warning.includes('identity'))).toBe(true)
  })
})

/**
 * 把整个源采样旋转到一个新坐标系（rest head、rest quat、每帧 q/h 全部共轭），
 * 用来验证 R_align 对源坐标系的补偿：物理动作不变 → 重定向输出应逐骨一致。
 */
function rotateSamplesFrame(samples: any, frameQuat: number[]) {
  const rotateVec = (v: number[]) => {
    // 通过四元数旋转向量（避免手写轴映射出错）
    const [x, y, z, w] = frameQuat
    const dot = x * v[0] + y * v[1] + z * v[2]
    const cross = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]]
    return [
      2 * dot * x + (w * w - x * x - y * y - z * z) * v[0] + 2 * w * cross[0],
      2 * dot * y + (w * w - x * x - y * y - z * z) * v[1] + 2 * w * cross[1],
      2 * dot * z + (w * w - x * x - y * y - z * z) * v[2] + 2 * w * cross[2]
    ]
  }
  const rest: any = {}
  for (const [name, info] of Object.entries(samples.rest) as Array<[string, any]>) {
    rest[name] = { ...info, head: rotateVec(info.head), quat: qMul(frameQuat, info.quat) }
  }
  const children: any = {}
  for (const [name, kids] of Object.entries(samples.children ?? {})) children[name] = [...(kids as string[])]
  const clips: any = {}
  for (const [id, clip] of Object.entries(samples.clips) as Array<[string, any]>) {
    clips[id] = {
      ...clip,
      data: clip.data.map((frame: any) => ({
        f: frame.f,
        q: Object.fromEntries(Object.entries(frame.q).map(([bone, quat]) => [bone, qMul(frameQuat, quat as number[])])),
        h: Object.fromEntries(Object.entries(frame.h).map(([bone, head]) => [bone, rotateVec(head as number[])]))
      }))
    }
  }
  return { ...samples, rest, children, clips }
}

describe('源坐标系不变性（Z-up 源 / 整体旋转）', () => {
  it('源 rest/pose 整体旋转 90°X（Y-up → Z-up）→ R_align 补偿，输出逐骨一致', () => {
    const yUp = setup()
    const frameQuat = axisAngleQuat([1, 0, 0], 90) // Y-up → Z-up
    const zUpSamples = rotateSamplesFrame(makeSyntheticBipedSamples(), frameQuat)
    const zUpSource = createBipedSource({ samples: zUpSamples, strict: true })
    const zUpVrmRest = yUp.vrmRest
    const zUpAlignment = buildAlignment({ vrmRest: zUpVrmRest, source: zUpSource })
    // 源 up 轴变成 +Z → R_align 应含 90° 绕 X 的补偿（±方向取决于轴构造约定）
    expect(qAngleDeg(zUpAlignment.quat, IDENTITY)).toBeCloseTo(90, 0)
    const run = (fixture: any) => runClip(fixture, 'idle', { grounding: 'none' }).clip
    const base = run(yUp)
    const zUp = retargetClip({
      clipId: 'idle',
      clipDef: makeBipedClipDef({ id: 'idle', grounding: 'none' }),
      sampleClip: zUpSamples.clips.idle,
      samples: zUpSamples,
      vrmRest: zUpVrmRest,
      alignment: zUpAlignment,
      secondaryMap: null,
      source: zUpSource,
      options: { rawEnabled: false, rawPolicy: 'spring' }
    }).clip
    for (const bone of Object.keys(base.bones)) {
      const a = base.bones[bone].r
      const b = zUp.bones[bone].r
      for (let frame = 0; frame < a.length; frame += 1) {
        expect(qAngleDeg(a[frame], b[frame]), `${bone}@${frame}`).toBeLessThan(0.01)
      }
    }
    for (let frame = 0; frame < base.bones.Hips.p.length; frame += 1) {
      expect(Math.hypot(
        base.bones.Hips.p[frame][0] - zUp.bones.Hips.p[frame][0],
        base.bones.Hips.p[frame][1] - zUp.bones.Hips.p[frame][1],
        base.bones.Hips.p[frame][2] - zUp.bones.Hips.p[frame][2]
      )).toBeLessThan(1e-5)
    }
  })
})

describe('默认 source = HSR 现有行为（不传 source 逐值一致）', () => {
  it('retargetClip 默认路径 == 显式 createHsrSource', () => {
    const vrmRest = buildVrmRest(makeSyntheticVrm())
    const samples = makeSyntheticHsrSamples({ frames: 3 })
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest })
    const run = (source: any) =>
      retargetClip({
        clipId: 'test',
        clipDef: makeClipDef({ loop: false }),
        sampleClip: samples.clips.test,
        samples,
        vrmRest,
        alignment,
        secondaryMap: null,
        source,
        options: { rawEnabled: false, rawPolicy: 'spring' }
      }).clip
    expect(run(null)).toEqual(run(createHsrSource(samples)))
  })

  it('buildAlignment 默认路径 == 显式 HSR 参考骨（数值逐位一致）', () => {
    const vrmRest = buildVrmRest(makeSyntheticVrm())
    const samples = makeSyntheticHsrSamples()
    const defaultAlign = buildAlignment({ hsrRest: samples.rest, vrmRest })
    const explicit = buildAlignment({ vrmRest, source: createHsrSource(samples) })
    expect(explicit.matrix).toEqual(defaultAlign.matrix)
    expect(explicit.quat).toEqual(defaultAlign.quat)
  })

  it('映射报告输出 source/ignored/rest 方向差（供 CLI 写盘）', () => {
    const fixture = setup()
    const report = buildBipedMappingReport({
      source: fixture.source,
      vrmRest: fixture.vrmRest,
      alignment: fixture.alignment,
      samplesPath: 'synthetic'
    })
    expect(report.source.hipsBone).toBe('Bip001 Pelvis')
    expect(report.source.upBone).toBe('Bip001 Spine2')
    expect(report.mapping.length).toBe(51)
    expect(report.mappingStats.restDirectionMismatch.maxDeg).toBeLessThan(1)
    expect(report.ignoredBones.length).toBeGreaterThan(0)
    expect(report.spine.upperChestFallback).toBe(true)
    expect(report.spine.slots).toEqual({ spine: 'Bip001 Spine', chest: 'Bip001 Spine2', upperChest: null })
    expect(report.fingers.assignment.left.chosenIsBest).toBe(true)
    expect(VRM_REST_POSITIONS.leftHand[0]).toBeGreaterThan(0)
    expect(BIPED_NAME_BY_VRM.leftToes).toBe('Bip001 L Toe0')
  })
})
