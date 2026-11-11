/**
 * 待机程序化微动层单测（`src/renderer/src/vrm/micro-motion.ts`）。
 *
 * 覆盖：纯函数幅度/边界/确定性；运行时权重淡入淡出、加性写入不累积、
 * 无 normalized 骨时安全降级、enabled/scale 关闭路径。
 */
import { describe, expect, it } from 'vitest'
import { Object3D, Quaternion, Vector3 } from 'three'

import type { VrmAvatar } from '../src/renderer/src/vrm/runtime-types'
import {
  VrmMicroMotion,
  VRM_MICRO_MOTION_DEFAULTS,
  computeVrmMicroMotionPose
} from '../src/renderer/src/vrm/micro-motion'
import { VrmFootLock } from '../src/renderer/src/vrm/foot-lock'

const DEG = Math.PI / 180
const IDENTITY_QUAT = new Quaternion()

/** 构造带 normalized humanoid 骨的 fake avatar（髋/脊/胸/颈/头链条）。 */
function makeAvatar(): {
  avatar: VrmAvatar
  nodes: Record<'hips' | 'spine' | 'chest' | 'neck' | 'head', Object3D>
} {
  const scene = new Object3D()
  const hips = new Object3D()
  hips.position.set(0, 1.0, 0)
  scene.add(hips)
  const spine = new Object3D()
  spine.position.set(0, 0.12, 0)
  hips.add(spine)
  const chest = new Object3D()
  chest.position.set(0, 0.2, 0)
  spine.add(chest)
  const neck = new Object3D()
  neck.position.set(0, 0.2, 0)
  chest.add(neck)
  const head = new Object3D()
  head.position.set(0, 0.08, 0)
  neck.add(head)
  scene.updateMatrixWorld(true)

  const nodes = { hips, spine, chest, neck, head }
  const avatar = {
    asset: { id: 'micro-motion-test', file: 'vrm/test.vrm', heightMeters: 1.7, expressions: {} },
    vrm: {
      humanoid: {
        getNormalizedBoneNode: (name: string) => (nodes as Record<string, Object3D>)[name] ?? null
      },
      update: () => undefined
    },
    scene,
    capabilities: {},
    restHeightMeters: 1.7,
    restFeetY: 0,
    bodyAspectRatio: 0.5,
    hipsRestHeight: 1.0,
    materialNames: [],
    expressionNames: [],
    textureCount: 0,
    missingTextures: [],
    vertexCount: 0,
    triangleCount: 0,
    dispose: () => undefined
  } as unknown as VrmAvatar
  return { avatar, nodes }
}

describe('computeVrmMicroMotionPose：数值幅度/边界/确定性', () => {
  it('所有分量为有限值，幅度在安全范围内（旋转 ≤3.5°、骨盆位移 ≤17mm）', () => {
    let maxRot = 0
    let maxOffset = 0
    for (let i = 0; i <= 2000; i += 1) {
      const pose = computeVrmMicroMotionPose(i * 0.05)
      for (const key of [
        'hipsRotation',
        'spineRotation',
        'chestRotation',
        'neckRotation',
        'headRotation'
      ] as const) {
        for (const axis of ['x', 'y', 'z'] as const) {
          const value = pose[key][axis]
          expect(Number.isFinite(value)).toBe(true)
          maxRot = Math.max(maxRot, Math.abs(value))
        }
      }
      for (const axis of ['x', 'y', 'z'] as const) {
        const value = pose.hipsOffset[axis]
        expect(Number.isFinite(value)).toBe(true)
        maxOffset = Math.max(maxOffset, Math.abs(value))
      }
    }
    expect(maxRot).toBeGreaterThan(0.5) // 确实在动（不是全 0）
    expect(maxRot).toBeLessThanOrEqual(3.2)
    expect(maxOffset).toBeGreaterThan(0.002) // 骨盆确实有位移
    expect(maxOffset).toBeLessThanOrEqual(0.017)
  })

  it('同一时刻可复现、不同时刻不同；时间/缩放非法时安全回退', () => {
    expect(computeVrmMicroMotionPose(1.234)).toEqual(computeVrmMicroMotionPose(1.234))
    expect(computeVrmMicroMotionPose(1.234)).not.toEqual(computeVrmMicroMotionPose(2.345))

    // NaN/Infinity 时间 → 按 0；非法 scale → 1。
    expect(computeVrmMicroMotionPose(Number.NaN)).toEqual(computeVrmMicroMotionPose(0))
    expect(computeVrmMicroMotionPose(Number.POSITIVE_INFINITY)).toEqual(computeVrmMicroMotionPose(0))
    expect(computeVrmMicroMotionPose(1, Number.NaN)).toEqual(computeVrmMicroMotionPose(1, 1))

    // scale=0 全为 0（注意 0 的符号位可能是 -0，按数值判断）。
    const zero = computeVrmMicroMotionPose(7, 0)
    for (const key of ['hipsRotation', 'spineRotation', 'chestRotation', 'neckRotation', 'headRotation'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) expect(zero[key][axis]).toBeCloseTo(0, 12)
    }
    for (const axis of ['x', 'y', 'z'] as const) expect(zero.hipsOffset[axis]).toBeCloseTo(0, 12)
  })
})

describe('VrmMicroMotion：运行时权重/加性写入/降级', () => {
  it('启用后 2s 权重≈1，骨旋转/骨盆位置确实变化；停用后权重衰减且不再写骨', () => {
    const { avatar, nodes } = makeAvatar()
    const layer = new VrmMicroMotion(avatar)
    const initialHipsPos = nodes.hips.position.clone()

    for (let i = 0; i < 300; i += 1) layer.update(1 / 60, true)
    expect(layer.getSnapshot().weight).toBeCloseTo(1, 2)
    expect(layer.getSnapshot().applied).toBe(true)
    expect(nodes.hips.quaternion.angleTo(IDENTITY_QUAT)).toBeGreaterThan(0)
    expect(nodes.hips.position.equals(initialHipsPos)).toBe(false)
    expect(nodes.head.quaternion.angleTo(IDENTITY_QUAT)).toBeGreaterThan(0)

    // 停用 3s：权重衰减到 0；记录当前姿势后继续 update 不应再变化（不写骨）。
    for (let i = 0; i < 180; i += 1) layer.update(1 / 60, false)
    expect(layer.getSnapshot().weight).toBeLessThan(0.01)
    const frozenHead = nodes.head.quaternion.clone()
    const frozenHips = nodes.hips.position.clone()
    for (let i = 0; i < 30; i += 1) layer.update(1 / 60, false)
    expect(nodes.head.quaternion.equals(frozenHead)).toBe(true)
    expect(nodes.hips.position.equals(frozenHips)).toBe(true)
  })

  it('enabled=false / scale=0 / 无 normalized 骨：安全降级，不写骨不抛', () => {
    const { avatar, nodes } = makeAvatar()
    const identity = nodes.hips.quaternion.clone()

    const disabled = new VrmMicroMotion(avatar, { enabled: false })
    for (let i = 0; i < 60; i += 1) disabled.update(1 / 60, true)
    expect(nodes.hips.quaternion.equals(identity)).toBe(true)
    expect(disabled.getSnapshot().weight).toBe(0)

    const scaledZero = new VrmMicroMotion(avatar, { scale: 0 })
    for (let i = 0; i < 60; i += 1) scaledZero.update(1 / 60, true)
    expect(nodes.hips.quaternion.equals(identity)).toBe(true)

    const emptyAvatar = {
      ...avatar,
      vrm: { humanoid: { update: () => undefined }, update: () => undefined }
    } as unknown as VrmAvatar
    const noBones = new VrmMicroMotion(emptyAvatar)
    expect(() => {
      for (let i = 0; i < 10; i += 1) noBones.update(1 / 60, true)
    }).not.toThrow()
    expect(noBones.getSnapshot().applied).toBe(false)
  })

  it('加性写入不累积：clip-player 每帧重写绝对姿态时，本层只在该帧姿态上叠加一次', () => {
    const { avatar, nodes } = makeAvatar()
    const layer = new VrmMicroMotion(avatar)
    // 模拟 clip-player：每帧先把 hips 旋转重置为单位四元数，再由微动层叠加。
    const resetAndUpdate = (): void => {
      nodes.hips.quaternion.set(0, 0, 0, 1)
      nodes.hips.position.set(0, 1.0, 0)
      layer.update(1 / 30, true)
    }
    for (let i = 0; i < 90; i += 1) resetAndUpdate()
    const angle = 2 * Math.acos(Math.min(1, Math.abs(nodes.hips.quaternion.w)))
    // 单帧叠加的旋转应远小于 3.5° 上限（不累积成大幅旋转）。
    expect(angle / DEG).toBeLessThan(3.5)
    expect(angle).toBeGreaterThan(0)
    // 竖向 = 微动 bob（≤3mm）+ 软膝基准下沉（8mm）；不随时间累积放大。
    expect(Math.abs(nodes.hips.position.y - 1.0)).toBeLessThanOrEqual(
      VRM_MICRO_MOTION_DEFAULTS.hipsVerticalM + VRM_MICRO_MOTION_DEFAULTS.softKneeDropM + 1e-9
    )
  })
})


/* -------------------------------------------------------------------------- */
/* 与真实 foot-lock 的集成：微动必须由 IK 补偿、脚不能滑                         */
/* -------------------------------------------------------------------------- */

/** 真实 VRM normalized rig 的 rest 比例（取自本机 aventurine-tpose.vrm，见脚滑报告）。 */
const REST = {
  hips: [0, 1.0661, -0.0056] as const,
  upperFromHips: [0.0754, -0.0877, 0] as const,
  lowerFromUpper: [0.0083, -0.4358, -0.0013] as const,
  footFromLower: [0.0083, -0.4443, -0.0334] as const,
  heightMeters: 1.734,
  restFeetY: 0.0007
}

function makeLockRig(): {
  avatar: VrmAvatar
  scene: Object3D
  hips: Object3D
  nodes: Record<string, Object3D>
  left: { upper: Object3D; lower: Object3D; foot: Object3D }
  right: { upper: Object3D; lower: Object3D; foot: Object3D }
} {
  const scene = new Object3D()
  const hips = new Object3D()
  hips.position.set(...REST.hips)
  scene.add(hips)
  const nodes: Record<string, Object3D> = { hips }
  // 微动层要写的躯干链（不影响 foot-lock，只保证节点存在）。
  const spine = new Object3D(); spine.position.set(0, 0.12, 0); hips.add(spine); nodes.spine = spine
  const chest = new Object3D(); chest.position.set(0, 0.2, 0); spine.add(chest); nodes.chest = chest
  const neck = new Object3D(); neck.position.set(0, 0.2, 0); chest.add(neck); nodes.neck = neck
  const head = new Object3D(); head.position.set(0, 0.08, 0); neck.add(head); nodes.head = head

  const makeLeg = (side: 'left' | 'right', sign: number) => {
    const upper = new Object3D()
    upper.position.set(sign * REST.upperFromHips[0], REST.upperFromHips[1], REST.upperFromHips[2])
    hips.add(upper)
    const lower = new Object3D()
    lower.position.set(sign * REST.lowerFromUpper[0], REST.lowerFromUpper[1], REST.lowerFromUpper[2])
    upper.add(lower)
    const foot = new Object3D()
    foot.position.set(sign * REST.footFromLower[0], REST.footFromLower[1], REST.footFromLower[2])
    lower.add(foot)
    nodes[`${side}UpperLeg`] = upper
    nodes[`${side}LowerLeg`] = lower
    nodes[`${side}Foot`] = foot
    return { upper, lower, foot }
  }
  const left = makeLeg('left', 1)
  const right = makeLeg('right', -1)
  scene.updateMatrixWorld(true)
  const avatar = {
    asset: { id: 'micro-motion-lock-test', file: 'vrm/test.vrm', heightMeters: REST.heightMeters, expressions: {} },
    vrm: { humanoid: { getNormalizedBoneNode: (name: string) => nodes[name] ?? null }, update: () => undefined },
    scene,
    capabilities: {},
    restHeightMeters: REST.heightMeters,
    restFeetY: REST.restFeetY,
    bodyAspectRatio: 0.5,
    hipsRestHeight: REST.hips[1],
    materialNames: [],
    expressionNames: [],
    textureCount: 0,
    missingTextures: [],
    vertexCount: 0,
    triangleCount: 0,
    dispose: () => undefined
  } as unknown as VrmAvatar
  return { avatar, scene, hips, nodes, left, right }
}

function lockInput() {
  return {
    dt: 1 / 30,
    mood: 'idle',
    motion: {
      feet: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      facing: 'front',
      grounded: true,
      surfaceId: 'screen-bottom',
      airborne: false
    },
    facing: 'front',
    lookTarget: null,
    petRect: { x: 0, y: 0, width: 200, height: 540 },
    viewportHeight: 900,
    dragging: false,
    events: [],
    bubbleText: null
  } as never
}

const worldPos = (object: Object3D): Vector3 => {
  object.updateWorldMatrix(true, false)
  return object.getWorldPosition(new Vector3())
}

const angleBetween = (a: Vector3, b: Vector3): number =>
  (Math.acos(Math.max(-1, Math.min(1, a.clone().normalize().dot(b.clone().normalize())))) * 180) / Math.PI

describe('VrmMicroMotion × VrmFootLock 集成：腰动但脚不滑', () => {
  /**
   * 生产口径：作者站姿不是左右对称 rest（真实 idle clip 有非对称站姿/膝角，
   * 如 hsr-idle 左踝 x=0.273m / 右踝 x=−0.039m）。这里用「左腿外展 + 左右不同膝屈」
   * 构造非对称作者站姿——v2 的 g 距离保持解在这种真实几何下不会退化。
   */
  const AUTHOR_POSE = {
    leftUpperZ: 0.12,
    rightUpperZ: -0.03,
    leftLowerX: 0.06,
    rightLowerX: 0.14
  } as const

  interface MicroRun {
    maxDrift: number
    maxFootError: number
    maxPelvisDrop: number
    baseBendL: number
    baseBendR: number
    maxBendDeviation: number
    maxShiftHoriz: number
    minResidual: number
    maxResidual: number
    modeAlways3d: boolean
  }

  function runMicroLock(mode: '3d' | 'mean'): MicroRun {
    const rig = makeLockRig()
    const lock = new VrmFootLock(rig.avatar, mode === 'mean' ? { stanceAlignMode: 'mean' } : {})
    const micro = new VrmMicroMotion(rig.avatar)
    const resetPose = (): void => {
      // 模拟 clip-player 每帧重写绝对姿态（hips + 腿归位后叠加作者站姿差异）。
      rig.hips.position.set(...REST.hips)
      rig.hips.quaternion.identity()
      for (const key of ['left', 'right'] as const) {
        rig[key].upper.quaternion.identity()
        rig[key].lower.quaternion.identity()
        rig[key].foot.quaternion.identity()
      }
      rig.left.upper.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), AUTHOR_POSE.leftUpperZ)
      rig.right.upper.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), AUTHOR_POSE.rightUpperZ)
      rig.left.lower.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), AUTHOR_POSE.leftLowerX)
      rig.right.lower.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), AUTHOR_POSE.rightLowerX)
    }
    const step = (withMicro: boolean): void => {
      resetPose()
      if (withMicro) micro.update(1 / 30, true)
      rig.scene.updateMatrixWorld(true)
      lock.update(lockInput())
    }
    const kneeOf = (side: 'left' | 'right'): number => {
      const upper = worldPos(rig[side].upper)
      const knee = worldPos(rig[side].lower)
      const ankle = worldPos(rig[side].foot)
      return 180 - angleBetween(upper.sub(knee), ankle.sub(knee))
    }

    // 先让 foot-lock 建立锚点（不带微动），并记录「作者膝角」基线。
    for (let i = 0; i < 60; i += 1) step(false)
    const baseLeft = worldPos(rig.left.foot).clone()
    const baseRight = worldPos(rig.right.foot).clone()
    const baseBendL = kneeOf('left')
    const baseBendR = kneeOf('right')

    let maxDriftLeft = 0
    let maxDriftRight = 0
    let maxFootError = 0
    let maxPelvisDrop = 0
    let maxBendDeviation = 0
    let maxShiftHoriz = 0
    let minResidual = Infinity
    let maxResidual = 0
    let modeAlways3d = true
    for (let i = 0; i < 90; i += 1) {
      step(true)
      const left = worldPos(rig.left.foot)
      const right = worldPos(rig.right.foot)
      maxDriftLeft = Math.max(maxDriftLeft, left.distanceTo(baseLeft))
      maxDriftRight = Math.max(maxDriftRight, right.distanceTo(baseRight))
      const snap = lock.getSnapshot() as unknown as {
        pelvisDropM?: number | null
        leftFootErrorM?: number | null
        rightFootErrorM?: number | null
        leftPinned?: boolean
        rightPinned?: boolean
        hipShiftXM?: number | null
        hipShiftZM?: number | null
        stanceSolveResidualM?: number | null
        stanceAlignMode?: string
      }
      maxFootError = Math.max(
        maxFootError,
        Math.abs(snap.leftFootErrorM ?? 0),
        Math.abs(snap.rightFootErrorM ?? 0)
      )
      maxPelvisDrop = Math.max(maxPelvisDrop, snap.pelvisDropM ?? 0)
      maxShiftHoriz = Math.max(
        maxShiftHoriz,
        Math.hypot(snap.hipShiftXM ?? 0, snap.hipShiftZM ?? 0)
      )
      const residual = snap.stanceSolveResidualM ?? 0
      minResidual = Math.min(minResidual, residual)
      maxResidual = Math.max(maxResidual, residual)
      if (snap.stanceAlignMode !== '3d') modeAlways3d = false
      expect(snap.leftPinned).toBe(true)
      expect(snap.rightPinned).toBe(true)
      // 运行时膝角 = 作者膝角（v2 的 g 应保持作者腿形；微动只是「腰会动」）。
      maxBendDeviation = Math.max(
        maxBendDeviation,
        Math.abs(kneeOf('left') - baseBendL),
        Math.abs(kneeOf('right') - baseBendR)
      )
    }
    return {
      maxDrift: Math.max(maxDriftLeft, maxDriftRight),
      maxFootError,
      maxPelvisDrop,
      baseBendL,
      baseBendR,
      maxBendDeviation,
      maxShiftHoriz,
      minResidual,
      maxResidual,
      modeAlways3d
    }
  }

  it('v2（3d 默认）：微动下脚漂移 ≤2mm、踝误差 ≤3mm、pelvisDrop=0，膝角保持作者（±1°）', () => {
    const result = runMicroLock('3d')
    // 接受口径（research 报告 §7）：脚漂移 ≤2mm、踝误差 ≤3mm。
    expect(result.maxDrift).toBeLessThanOrEqual(0.002)
    expect(result.maxFootError).toBeLessThanOrEqual(0.003)
    // g：δ 把微动的骨盆平移/旋转在骨盆层抵消 → 不再叠 pelvisDrop、也不再额外弯膝。
    expect(result.maxPelvisDrop).toBe(0)
    expect(result.modeAlways3d).toBe(true)
    expect(result.maxBendDeviation).toBeLessThanOrEqual(1)
    // δ 有界（真实 idle clip 需求上界 0.088m；这里应远小于水平钳制 0.10m）。
    expect(result.maxShiftHoriz).toBeLessThan(0.1)
    expect(result.maxResidual).toBeLessThan(0.0005)
  })

  it('v2（mean 回退通道）：旧 A 行为保留——微动让膝部产生弯曲（>+2°）、pelvisDrop ≤4cm', () => {
    const result = runMicroLock('mean')
    expect(result.maxDrift).toBeLessThanOrEqual(0.002)
    expect(result.maxFootError).toBeLessThanOrEqual(0.003)
    expect(result.maxPelvisDrop).toBeLessThanOrEqual(0.04)
    // 旧 A 不改 δy，微动的软膝下沉由 IK 吸收 → 膝明显更弯（research 实测 7.7°→15.6°）。
    expect(result.maxBendDeviation).toBeGreaterThan(2)
  })
})
