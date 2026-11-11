/**
 * Wave 2.5 / D4b 单测：VMD 激活时的 additive look-at（头/颈/眼球跟随鼠标）。
 *
 * 两部分：
 * 1. **纯逻辑 `vmd-look-at.ts`**（Node 直接跑）：无目标/死区、左右符号、facing ±90° 局部化、
 *    ±31°（含 pitch）钳制、90ms 平滑与逐层 lag、头/颈 30% + 眼 100% 缩放、强制注视、
 *    NaN/缺失输入安全、无累积（同输入连续帧只收敛不叠加）。
 * 2. **driver 集成（mock helper/mesh/B3 + 真实 three Quaternion/Euler）**：
 *    additive 右乘顺序（`final = clipBase × delta`）、每帧不累积、无目标平滑归零、
 *    facing/身体 Y 转角局部化、debugSetGaze 生效、贴地/骨骼写入分工不受影响。
 *
 * 注：本文件不依赖私有模型资产（不需要 tests/tmp/**），任何环境都会执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AnimationClip, Bone, Euler, Group, Object3D } from 'three'
import type { SkinnedMesh } from 'three'
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { Parser } from 'mmd-parser'
import { describe, expect, it } from 'vitest'

import type { AnimationDebugSnapshot, AnimationInput } from '../src/renderer/src/core/wave2-contract'
import type { PetAnimator } from '../src/renderer/src/animation/legacy/scene-bridge'
import { createHybridAnimator } from '../src/renderer/src/animation/legacy/external/vmd-driver'
import type { MotionClipDef } from '../src/renderer/src/animation/legacy/external/manifest'
import { processVmdData, type VmdClipInfo } from '../src/renderer/src/animation/legacy/external/vmd-clip'
import {
  resolveVmdLookAtTarget,
  VmdLookAtController,
  VMD_LOOK_AT_EYE_SCALE,
  VMD_LOOK_AT_HEAD_SCALE,
  type VmdLookAtInput
} from '../src/renderer/src/animation/legacy/external/vmd-look-at'
import {
  distributeGaze,
  GAZE_LIMITS
} from '../src/renderer/src/animation/legacy/look-at'

/* ========================================================================== */
/* 夹具                                                                        */
/* ========================================================================== */

const rad = (deg: number): number => (deg * Math.PI) / 180
const deg = (value: number): number => (value * 180) / Math.PI
const YAW_31 = rad(31)

/** B3 默认宠物矩形（窗口本地 px、y 向下）：headCenter = (150, 54)、depth = 486。 */
const PET_RECT = { x: 0, y: 0, width: 300, height: 540 }
const HEAD_CENTER = { x: PET_RECT.x + PET_RECT.width / 2, y: PET_RECT.y + PET_RECT.height * 0.1 }

/** 鼠标到头部中心的近似世界注视角（不钳制、不局部化；用于和控制器输出对照）。 */
function rawGazeOf(pointer: { x: number; y: number }): { yaw: number; pitch: number } {
  const depth = Math.max(60, PET_RECT.height * 0.9)
  let dx = pointer.x - HEAD_CENTER.x
  let dy = pointer.y - HEAD_CENTER.y
  const dist = Math.hypot(dx, dy)
  if (dist < 40) return { yaw: 0, pitch: 0 }
  const scale = (dist - 40) / dist
  dx *= scale
  dy *= scale
  return { yaw: Math.atan2(dx, depth), pitch: Math.atan2(dy, depth) }
}

function makeInput(overrides: Partial<VmdLookAtInput> = {}): VmdLookAtInput {
  return {
    lookTarget: null,
    petRect: PET_RECT,
    facing: 'front',
    dt: 1 / 30,
    nowMs: 1000,
    bodyYawRad: 0,
    ...overrides
  }
}

/** 用固定 dt 连续 update 到收敛（默认 120 帧 = 4s @30fps）。 */
function settle(
  controller: VmdLookAtController,
  base: Partial<VmdLookAtInput> = {},
  frames = 120
): ReturnType<VmdLookAtController['update']> {
  let result = controller.update(makeInput(base))
  let nowMs = Number(base.nowMs ?? 1000)
  for (let frame = 1; frame < frames; frame += 1) {
    nowMs += (base.dt ?? 1 / 30) * 1000
    result = controller.update(makeInput({ ...base, nowMs }))
  }
  return result
}

/** 鼠标在头部右侧（远）：世界 yaw 约 59° → 钳制 31°。 */
const FAR_RIGHT = { x: 1000, y: HEAD_CENTER.y }
/** 鼠标在头部左侧（远）。 */
const FAR_LEFT = { x: -700, y: HEAD_CENTER.y }
/** 鼠标轻微偏右：世界 yaw 约 7°（未钳制）。 */
const NEAR_RIGHT = { x: HEAD_CENTER.x + 100, y: HEAD_CENTER.y }

/* ========================================================================== */
/* 1) 纯逻辑：VmdLookAtController                                              */
/* ========================================================================== */

describe('VmdLookAtController：无目标 / 死区 / 符号', () => {
  it('无目标 → 全 0、lookYaw=null、active=false', () => {
    const controller = new VmdLookAtController()
    const result = controller.update(makeInput({ lookTarget: null }))
    expect(result.gaze).toEqual({ yaw: 0, pitch: 0 })
    expect(result.neck).toEqual({ x: 0, y: 0, z: 0 })
    expect(result.head).toEqual({ x: 0, y: 0, z: 0 })
    expect(result.eye).toEqual({ x: 0, y: 0, z: 0 })
    expect(result.lookYaw).toBeNull()
    expect(result.active).toBe(false)
    expect(settle(controller).lookYaw).toBeNull()
  })

  it('死区（头部中心 ±40px）内不转', () => {
    const controller = new VmdLookAtController()
    const result = settle(controller, { lookTarget: { x: HEAD_CENTER.x + 20, y: HEAD_CENTER.y + 10 } })
    expect(result.gaze).toEqual({ yaw: 0, pitch: 0 })
    // B3 语义：死区内仍有鼠标目标 → active=true，lookYaw=0（不是 null）
    expect(result.lookYaw).toBe(0)
  })

  it('鼠标在右侧 → yaw 正；左侧 → yaw 负（与 pointerToGaze/B3 同号）', () => {
    const right = settle(new VmdLookAtController(), { lookTarget: FAR_RIGHT })
    const left = settle(new VmdLookAtController(), { lookTarget: FAR_LEFT })
    expect(right.gaze.yaw).toBeGreaterThan(0)
    expect(left.gaze.yaw).toBeLessThan(0)
    expect(right.lookYaw).toBeGreaterThan(0)
    expect(left.lookYaw).toBeLessThan(0)
  })

  it('近处目标角度=pointerToGaze 的原角（未钳制时精确）', () => {
    const controller = new VmdLookAtController()
    const result = settle(controller, { lookTarget: NEAR_RIGHT })
    expect(result.gaze.yaw).toBeCloseTo(rawGazeOf(NEAR_RIGHT).yaw, 4)
    expect(result.lookYaw).toBeCloseTo(rawGazeOf(NEAR_RIGHT).yaw / GAZE_LIMITS.yawAbs, 4)
  })
})

describe('VmdLookAtController：facing ±90° 局部化', () => {
  it('facing=front：远处右侧 → 钳制 +31°；facing=right：同一鼠标 → 局部角约 0', () => {
    const front = settle(new VmdLookAtController(), { lookTarget: FAR_RIGHT, facing: 'front' })
    // 极远鼠标（世界 yaw → 90°）：facing=right（root +90°）时局部角 ≈ 0
    const farFarRight = { x: 1e9, y: HEAD_CENTER.y }
    const right = settle(new VmdLookAtController(), { lookTarget: farFarRight, facing: 'right' })
    expect(front.gaze.yaw).toBeCloseTo(YAW_31, 3)
    // 模型已右转 90°：正右方的鼠标 ≈ 正前方 → 局部角 ≈ 0
    expect(Math.abs(right.gaze.yaw)).toBeLessThan(0.01)
  })

  it('bodyYawRad（センター 3/4 侧身）从注视角里减掉', () => {
    const noBody = settle(new VmdLookAtController(), { lookTarget: NEAR_RIGHT, bodyYawRad: 0 })
    const withBody = settle(new VmdLookAtController(), {
      lookTarget: NEAR_RIGHT,
      bodyYawRad: rad(30)
    })
    expect(noBody.gaze.yaw - withBody.gaze.yaw).toBeCloseTo(rad(30), 4)
    expect(withBody.gaze.yaw).toBeLessThan(0)
  })
})

describe('VmdLookAtController：±31° / pitch 钳制', () => {
  it('yaw 钳制在 ±31°', () => {
    const right = settle(new VmdLookAtController(), { lookTarget: FAR_RIGHT })
    const left = settle(new VmdLookAtController(), { lookTarget: FAR_LEFT })
    expect(right.gaze.yaw).toBeCloseTo(GAZE_LIMITS.yawAbs, 4)
    expect(left.gaze.yaw).toBeCloseTo(-GAZE_LIMITS.yawAbs, 4)
    expect(Math.abs(right.lookYaw!)).toBeCloseTo(1, 4)
  })

  it('pitch 钳制在 [−20°, +26°]（屏幕下 → 低头正；上 → 抬头负）', () => {
    const below = settle(new VmdLookAtController(), {
      lookTarget: { x: HEAD_CENTER.x, y: HEAD_CENTER.y + 1e6 }
    })
    const above = settle(new VmdLookAtController(), {
      lookTarget: { x: HEAD_CENTER.x, y: HEAD_CENTER.y - 1e6 }
    })
    expect(below.gaze.pitch).toBeCloseTo(GAZE_LIMITS.pitchMax, 4) // +26°
    expect(above.gaze.pitch).toBeCloseTo(GAZE_LIMITS.pitchMin, 4) // −20°
  })
})

describe('VmdLookAtController：平滑（90ms）与逐层 lag', () => {
  it('首帧位移 = 目标的 1−e^(−dt/τ)（τ=90ms，dt=90ms → 0.632）', () => {
    const controller = new VmdLookAtController()
    const target = resolveVmdLookAtTarget({ lookTarget: NEAR_RIGHT, petRect: PET_RECT, facing: 'front' })
    const result = controller.update(makeInput({ lookTarget: NEAR_RIGHT, dt: 0.09, nowMs: 1000 }))
    const expectedRatio = 1 - Math.exp(-0.09 / 0.09)
    expect(result.gaze.yaw).toBeCloseTo(target.target.yaw * expectedRatio, 5)
  })

  it('持续输入收敛到目标（4s 后误差 <0.1%）；眼比头/颈先到（逐层 lag）', () => {
    const controller = new VmdLookAtController()
    const target = resolveVmdLookAtTarget({ lookTarget: FAR_RIGHT, petRect: PET_RECT, facing: 'front' })
    // 前几帧：眼（τ=50ms）收敛比例应大于颈（τ=120ms）/头（τ=170ms）
    let first = controller.update(makeInput({ lookTarget: FAR_RIGHT, nowMs: 1000 }))
    let nowMs = 1000
    for (let frame = 1; frame < 3; frame += 1) {
      nowMs += 33.3
      first = controller.update(makeInput({ lookTarget: FAR_RIGHT, nowMs }))
    }
    const eyeFraction = first.eye.y / (distributeGaze(target.target).eye.y * VMD_LOOK_AT_EYE_SCALE)
    const headFraction = first.head.y / (distributeGaze(target.target).head.y * VMD_LOOK_AT_HEAD_SCALE)
    expect(eyeFraction).toBeGreaterThan(headFraction)

    const settled = settle(controller, { lookTarget: FAR_RIGHT })
    expect(settled.gaze.yaw).toBeCloseTo(target.target.yaw, 3)
  })

  it('鼠标离开后 2.5s 内平滑回落，之后 lookYaw=null', () => {
    const controller = new VmdLookAtController()
    let nowMs = 1000
    for (let frame = 0; frame < 90; frame += 1) {
      controller.update(makeInput({ lookTarget: FAR_RIGHT, nowMs }))
      nowMs += 33.3
    }
    expect(controller.update(makeInput({ lookTarget: null, nowMs })).lookYaw).not.toBeNull()
    // 2.5s 后仍 active（回落窗口）→ 再往后彻底归零
    nowMs += 2600
    let result = controller.update(makeInput({ lookTarget: null, nowMs }))
    for (let frame = 0; frame < 120; frame += 1) {
      nowMs += 33.3
      result = controller.update(makeInput({ lookTarget: null, nowMs }))
    }
    expect(Math.abs(result.gaze.yaw)).toBeLessThan(1e-6)
    expect(result.lookYaw).toBeNull()
    expect(result.active).toBe(false)
  })
})

describe('VmdLookAtController：additive 缩放（头/颈 30%、眼 100%）', () => {
  it('钳制到 31° 时：颈/头 = distributeGaze×0.3，眼 = distributeGaze×1.0，且 z=0', () => {
    const result = settle(new VmdLookAtController(), { lookTarget: FAR_RIGHT })
    const distribution = distributeGaze({ yaw: GAZE_LIMITS.yawAbs, pitch: 0 })
    expect(result.neck.y).toBeCloseTo(distribution.neck.y * VMD_LOOK_AT_HEAD_SCALE, 4)
    expect(result.head.y).toBeCloseTo(distribution.head.y * VMD_LOOK_AT_HEAD_SCALE, 4)
    expect(result.eye.y).toBeCloseTo(distribution.eye.y * VMD_LOOK_AT_EYE_SCALE, 4)
    expect(result.neck.z).toBe(0)
    expect(result.head.z).toBe(0)
    expect(result.eye.z).toBe(0)
    // 眼球 additive 角度应大于头/颈（眼负责主要跟随）
    expect(Math.abs(result.eye.y)).toBeGreaterThan(Math.abs(result.head.y))
    expect(VMD_LOOK_AT_HEAD_SCALE).toBe(0.3)
    expect(VMD_LOOK_AT_EYE_SCALE).toBe(1)
  })
})

describe('VmdLookAtController：强制注视 / NaN / 缺失输入安全', () => {
  it('setForced(25,0) → gaze.yaw≈25°、lookYaw≈0.806；NaN 清除后回落', () => {
    const controller = new VmdLookAtController()
    controller.setForced(25, 0)
    expect(controller.isForced).toBe(true)
    const settled = settle(controller, { lookTarget: null })
    expect(settled.gaze.yaw).toBeCloseTo(rad(25), 3)
    expect(settled.lookYaw).toBeCloseTo(25 / 31, 3)

    controller.setForced(Number.NaN, Number.NaN)
    expect(controller.isForced).toBe(false)
    let nowMs = 6000
    let result = controller.update(makeInput({ lookTarget: null, nowMs }))
    for (let frame = 0; frame < 240; frame += 1) {
      nowMs += 33.3
      result = controller.update(makeInput({ lookTarget: null, nowMs }))
    }
    expect(Math.abs(result.gaze.yaw)).toBeLessThan(1e-3)
    expect(result.lookYaw).toBeNull()
  })

  it('NaN 鼠标 / 缺失 petRect / NaN dt·nowMs → 不抛错、输出全有限', () => {
    const controller = new VmdLookAtController()
    const nanPointer = controller.update(
      makeInput({ lookTarget: { x: Number.NaN, y: Number.NaN }, dt: Number.NaN, nowMs: Number.NaN })
    )
    expect(nanPointer.gaze).toEqual({ yaw: 0, pitch: 0 })

    const noRect = settle(controller, { petRect: null, lookTarget: FAR_RIGHT })
    expect(noRect.gaze).toEqual({ yaw: 0, pitch: 0 })
    expect(noRect.lookYaw).toBeNull()
    expect(Number.isFinite(noRect.neck.y)).toBe(true)

    const partialRect = settle(new VmdLookAtController(), {
      petRect: { x: Number.NaN, y: 0, width: Number.NaN, height: 0 },
      lookTarget: NEAR_RIGHT
    })
    expect(Number.isFinite(partialRect.gaze.yaw)).toBe(true)
  })

  it('同一输入连续 update 只收敛不叠加（无累积）', () => {
    const controller = new VmdLookAtController()
    const target = rawGazeOf(NEAR_RIGHT).yaw
    let nowMs = 1000
    let prev = 0
    const samples: number[] = []
    for (let frame = 0; frame < 10; frame += 1) {
      const result = controller.update(makeInput({ lookTarget: NEAR_RIGHT, nowMs }))
      expect(result.gaze.yaw).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(result.gaze.yaw).toBeLessThanOrEqual(target + 1e-9)
      prev = result.gaze.yaw
      samples.push(result.gaze.yaw)
      nowMs += 33.3
    }
    // 单调收敛 → 第 10 帧不应超过第 1 帧的 3 倍（若是累积会线性变大）
    expect(samples[9]!).toBeLessThan(samples[0]! * 4)
  })
})

/* ========================================================================== */
/* 2) driver 集成：additive 右乘 / 不累积 / 归零 / 局部化 / debugSetGaze        */
/* ========================================================================== */

interface DriverRig {
  mesh: SkinnedMesh
  root: Group
  bones: Record<string, Bone>
  allBones: Bone[]
}

function createDriverRig(): DriverRig {
  const root = new Group()
  const mesh = new Object3D() as unknown as SkinnedMesh
  const bones: Record<string, Bone> = {}
  const allBones: Bone[] = []
  const addBone = (name: string, position: [number, number, number]): Bone => {
    const bone = new Bone()
    bone.name = name
    bone.position.set(...position)
    mesh.add(bone)
    bones[name] = bone
    allBones.push(bone)
    return bone
  }
  addBone('センター', [0, 8.93, 0])
  addBone('首', [0, 18.32, -0.595])
  addBone('頭', [0, 19.24, -0.54])
  addBone('左目先', [0.5, 19.5, 0.55])
  addBone('右目先', [-0.5, 19.5, 0.55])
  addBone('左足首D', [-1, 1.2, 0])
  addBone('右足首D', [1, 1.2, 0])
  const mutable = mesh as unknown as {
    isSkinnedMesh: boolean
    skeleton: unknown
    pose: () => void
  }
  mutable.isSkinnedMesh = true
  mutable.skeleton = {
    bones: allBones,
    getBoneByName: (name: string) => bones[name] ?? null
  }
  mutable.pose = () => {
    for (const bone of allBones) bone.quaternion.identity()
  }
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.updateMatrixWorld(true)
  return { mesh, root, bones, allBones }
}

interface FakeMixerLike {
  time: number
  timeScale: number
  _actions: Array<{ time: number; setLoop: () => void; clampWhenFinished: boolean }>
}

interface FakeHelper {
  enabled: Record<string, boolean>
  meshes: object[]
  objects: WeakMap<object, { mixer?: FakeMixerLike }>
  /** 模拟 clip 每帧写入的基准姿态（首/頭 非 identity；目先 不写 → 保持 bind）。 */
  clipNeck: Euler
  clipHead: Euler
  clipCenterYaw: number
  enable(key: string, enabled: boolean): FakeHelper
  add(object: object, params?: { animation?: unknown }): FakeHelper
  remove(object: object): FakeHelper
  update(delta: number): FakeHelper
}

function createFakeHelper(rig: DriverRig): FakeHelper {
  const helper: FakeHelper = {
    enabled: { ik: true, grant: true },
    meshes: [],
    objects: new WeakMap(),
    clipNeck: new Euler(0.1, -0.08, 0.02, 'YXZ'),
    clipHead: new Euler(0.06, 0.12, -0.01, 'YXZ'),
    clipCenterYaw: 0,
    enable(key, enabled) {
      helper.enabled[key] = enabled
      return helper
    },
    add(object, params) {
      if (helper.meshes.includes(object)) throw new Error('helper: mesh already added')
      helper.meshes.push(object)
      helper.objects.set(object, {
        mixer: params?.animation
          ? {
              time: 0,
              timeScale: 1,
              _actions: [{ time: 0, setLoop: () => undefined, clampWhenFinished: false }]
            }
          : undefined
      })
      return helper
    },
    remove(object) {
      const index = helper.meshes.indexOf(object)
      if (index < 0) throw new Error('helper: mesh not added')
      helper.meshes.splice(index, 1)
      helper.objects.delete(object)
      return helper
    },
    update(delta) {
      const mesh = helper.meshes[0]
      const entry = mesh ? helper.objects.get(mesh) : undefined
      if (entry?.mixer) {
        entry.mixer.time += delta
        entry.mixer._actions[0]!.time += delta
        // 模拟 mixer 每帧「绝对写」clip 基准姿态（helper._restoreBones + mixer 的等价效果）。
        rig.bones['センター']!.quaternion.setFromEuler(new Euler(0, helper.clipCenterYaw, 0, 'YXZ'))
        rig.bones['首']!.quaternion.setFromEuler(helper.clipNeck)
        rig.bones['頭']!.quaternion.setFromEuler(helper.clipHead)
        rig.bones['左目先']!.quaternion.identity()
        rig.bones['右目先']!.quaternion.identity()
        rig.bones['左足首D']!.position.set(-1, 1.2, 0)
        rig.bones['右足首D']!.position.set(1, 1.2, 0)
      }
      return helper
    }
  }
  return helper
}

interface FakeB3 {
  boneWriteEnabled: boolean
  animator: PetAnimator
}

function createFakeB3(): FakeB3 {
  const state: FakeB3 = { boneWriteEnabled: true, animator: null as unknown as PetAnimator }
  state.animator = {
    update(): void {
      /* no-op（VMD 激活时只写 morph；测试不关心） */
    },
    getDebugSnapshot(): AnimationDebugSnapshot {
      return {
        pose: 'stand',
        poseWeight: 1,
        activeLayers: 1,
        gesture: null,
        blink: 0,
        smile: 0,
        mouthOpen: 0,
        lookYaw: null,
        missingBones: []
      }
    },
    setPose(): boolean {
      return true
    },
    setGaze(): void {
      /* no-op */
    },
    setBoneWriteEnabled(enabled: boolean): void {
      state.boneWriteEnabled = enabled
    }
  }
  return state
}

function makeClipInfo(def: MotionClipDef): VmdClipInfo {
  return {
    def,
    clip: new AnimationClip(def.id, 2, []),
    url: `pet-asset://model/${def.file}`,
    durationSec: 2,
    frameRate: 30,
    frameCount: 60,
    trackCount: 0,
    boneTrackCount: 0,
    strippedMorphTrackCount: 0,
    rebasedPositionTrackCount: 0,
    inPlace: true,
    ik: def.ik
  }
}

const IDLE_DEF: MotionClipDef = {
  id: 'idle',
  file: 'motion-idle.vmd',
  moods: ['idle'],
  loop: true,
  ik: 'on',
  nominalSpeedPxPerSec: null,
  crossfadeMs: 200,
  source: null
}

function makeAnimationInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
  return {
    dt: 1 / 30,
    mood: 'idle',
    motion: {
      feet: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      facing: 'front',
      grounded: true,
      surfaceId: null,
      airborne: false
    },
    facing: 'front',
    lookTarget: null,
    petRect: { ...PET_RECT },
    viewportHeight: 1080,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides
  }
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

interface DriverFixture {
  driver: ReturnType<typeof createHybridAnimator>
  rig: DriverRig
  helper: FakeHelper
  b3: FakeB3
  clock: { ms: number }
}

function createDriverFixture(): DriverFixture {
  const rig = createDriverRig()
  const helper = createFakeHelper(rig)
  const b3 = createFakeB3()
  const clock = { ms: 1000 }
  const driver = createHybridAnimator({
    mesh: rig.mesh,
    root: rig.root,
    helper: helper as unknown as MMDAnimationHelper,
    b3: b3.animator,
    loadManifest: async () => ({
      schemaVersion: 1,
      clips: [{ id: 'idle', file: 'motion-idle.vmd', moods: ['idle'], loop: true, ik: 'on' }]
    }),
    loadClip: async (def: MotionClipDef) => makeClipInfo(def),
    manifestRetryCount: 0,
    now: () => clock.ms
  })
  return { driver, rig, helper, b3, clock }
}

/** 激活 VMD 并推进若干帧。 */
async function activateAndRun(
  fixture: DriverFixture,
  frames: number,
  inputOverrides: Partial<AnimationInput> = {}
): Promise<AnimationDebugSnapshot> {
  fixture.driver.update(makeAnimationInput(inputOverrides))
  await flushAsync()
  for (let frame = 0; frame < frames; frame += 1) {
    fixture.driver.update(makeAnimationInput(inputOverrides))
    fixture.clock.ms += 1000 / 30
  }
  return fixture.driver.getDebugSnapshot()
}

/** 四元数夹角（弧度）。 */
function quaternionAngle(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number }
): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return 2 * Math.acos(Math.min(1, dot))
}

describe('driver 集成：VMD 激活时 additive look-at', () => {
  it('无目标时骨骼保持 clip 基准（additive≈0）', async () => {
    const fixture = createDriverFixture()
    await activateAndRun(fixture, 30, { lookTarget: null })
    const snapshot = fixture.driver.getDebugSnapshot()
    expect(snapshot.source).toBe('vmd')
    const baseNeck = new Bone()
    baseNeck.quaternion.setFromEuler(fixture.helper.clipNeck)
    const baseHead = new Bone()
    baseHead.quaternion.setFromEuler(fixture.helper.clipHead)
    expect(quaternionAngle(fixture.rig.bones['首']!.quaternion, baseNeck.quaternion)).toBeLessThan(1e-6)
    expect(quaternionAngle(fixture.rig.bones['頭']!.quaternion, baseHead.quaternion)).toBeLessThan(1e-6)
    expect(snapshot.lookYaw).toBeNull()
    expect(snapshot.gaze ?? null).toBeNull()
  })

  it('鼠标在右侧：final = clipBase × Δ（右乘、局部空间），眼/头/颈方向为正且不累积', async () => {
    const fixture = createDriverFixture()
    const snapshot = await activateAndRun(fixture, 60, { lookTarget: FAR_RIGHT })
    expect(snapshot.source).toBe('vmd')
    // 调试面 gaze 反映实际 additive（override B3 快照）
    expect(snapshot.gaze).not.toBeNull()
    expect(snapshot.gaze!.yaw).toBeGreaterThan(0)
    expect(snapshot.lookYaw).toBeGreaterThan(0)

    // 右乘语义：Δ = clipBase⁻¹ × final；Δ 应主要是绕局部 Y 的正旋转，且角度量级符合 30%/100% 缩放。
    const baseNeck = new Bone()
    baseNeck.quaternion.setFromEuler(fixture.helper.clipNeck)
    const deltaNeck = baseNeck.quaternion.clone().invert().multiply(fixture.rig.bones['首']!.quaternion)
    const neckEuler = new Euler().setFromQuaternion(deltaNeck, 'YXZ')
    expect(quaternionAngle(deltaNeck, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.005)
    expect(Math.abs(neckEuler.y)).toBeGreaterThan(Math.abs(neckEuler.x))
    expect(neckEuler.y).toBeGreaterThan(0)

    const baseHead = new Bone()
    baseHead.quaternion.setFromEuler(fixture.helper.clipHead)
    const deltaHead = baseHead.quaternion.clone().invert().multiply(fixture.rig.bones['頭']!.quaternion)
    expect(quaternionAngle(deltaHead, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.005)

    // 眼球（目先）只由 look-at 叠加（clip 无轨道）→ 应有明显旋转
    const eyeDelta = fixture.rig.bones['左目先']!.quaternion.clone()
    expect(quaternionAngle(eyeDelta, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.01)
    expect(fixture.rig.bones['右目先']!.quaternion.equals(fixture.rig.bones['左目先']!.quaternion)).toBe(true)

    // 不累积：再跑两帧，姿态稳定（Δ 不再增大）
    const angleAfter60 = quaternionAngle(fixture.rig.bones['首']!.quaternion, baseNeck.quaternion)
    await activateAndRun(fixture, 2, { lookTarget: FAR_RIGHT })
    const angleAfter62 = quaternionAngle(fixture.rig.bones['首']!.quaternion, baseNeck.quaternion)
    expect(Math.abs(angleAfter62 - angleAfter60)).toBeLessThan(1e-3)
  })

  it('鼠标离开：additive 平滑衰减回 clip 基准，lookYaw/gaze 归 null', async () => {
    const fixture = createDriverFixture()
    const withTarget = await activateAndRun(fixture, 60, { lookTarget: FAR_RIGHT })
    expect(withTarget.lookYaw).not.toBeNull()

    // 撤掉目标后跑 5s（> 2.5s 回落窗口 + 平滑）
    const after = await activateAndRun(fixture, 160, { lookTarget: null })
    const baseNeck = new Bone()
    baseNeck.quaternion.setFromEuler(fixture.helper.clipNeck)
    expect(quaternionAngle(fixture.rig.bones['首']!.quaternion, baseNeck.quaternion)).toBeLessThan(0.01)
    expect(after.lookYaw).toBeNull()
    expect(after.gaze ?? null).toBeNull()
  })

  it('facing=right 时世界坐标鼠标被局部化（同一鼠标不再右转）', async () => {
    const front = createDriverFixture()
    const frontSnapshot = await activateAndRun(front, 60, { lookTarget: { x: 1000, y: 54 }, facing: 'front' })
    expect(frontSnapshot.gaze!.yaw).toBeCloseTo(GAZE_LIMITS.yawAbs, 2)

    // 极远鼠标（世界 yaw → +90°）：facing=right 时局部角 ≈ 0
    const right = createDriverFixture()
    const rightSnapshot = await activateAndRun(right, 60, {
      lookTarget: { x: 1e9, y: 54 },
      facing: 'right',
      motion: { ...makeAnimationInput().motion, facing: 'right' }
    })
    expect(Math.abs(rightSnapshot.gaze!.yaw)).toBeLessThan(0.05)
  })

  it('clip センター 有 3/4 侧身（Y 0.5rad）时注视角减去身体转角', async () => {
    const noBody = createDriverFixture()
    const noBodySnapshot = await activateAndRun(noBody, 60, { lookTarget: NEAR_RIGHT })
    expect(noBodySnapshot.gaze!.yaw).toBeGreaterThan(0)

    const withBody = createDriverFixture()
    withBody.helper.clipCenterYaw = 0.5
    const withBodySnapshot = await activateAndRun(withBody, 60, { lookTarget: NEAR_RIGHT })
    expect(withBodySnapshot.gaze!.yaw).toBeLessThan(noBodySnapshot.gaze!.yaw - 0.3)
  })

  it('debugSetGaze 强制注视在 VMD 下生效（眼/头有旋转；NaN 清除后回落）', async () => {
    const fixture = createDriverFixture()
    fixture.driver.update(makeAnimationInput({ lookTarget: null }))
    await flushAsync()
    fixture.helper.update(1 / 30)
    fixture.driver.setGaze(25, 0)
    const snapshot = await activateAndRun(fixture, 60, { lookTarget: null })
    expect(snapshot.gaze).not.toBeNull()
    expect(snapshot.gaze!.yaw).toBeCloseTo(rad(25), 2)
    expect(snapshot.lookYaw).toBeCloseTo(25 / 31, 2)
    const baseNeck = new Bone()
    baseNeck.quaternion.setFromEuler(fixture.helper.clipNeck)
    expect(quaternionAngle(fixture.rig.bones['首']!.quaternion, baseNeck.quaternion)).toBeGreaterThan(0.005)

    fixture.driver.setGaze(Number.NaN, Number.NaN)
    const after = await activateAndRun(fixture, 160, { lookTarget: null })
    expect(after.lookYaw).toBeNull()
  })

  it('look-at 只动 首/頭/目先：センター/foot 骨与贴地误差不受影响', async () => {
    const fixture = createDriverFixture()
    const snapshot = await activateAndRun(fixture, 60, { lookTarget: FAR_RIGHT })
    const centerEuler = new Euler().setFromQuaternion(fixture.rig.bones['センター']!.quaternion, 'YXZ')
    expect(centerEuler.y).toBeCloseTo(0, 6)
    expect(
      quaternionAngle(fixture.rig.bones['左足首D']!.quaternion, { x: 0, y: 0, z: 0, w: 1 })
    ).toBeLessThan(1e-9)
    // 贴地补偿后残余误差仍 <2px（look-at 未污染脚底测量）
    expect(snapshot.externalFootErrorPx).not.toBeNull()
    expect(snapshot.externalFootErrorPx!).toBeLessThan(2)
    expect(fixture.b3.boneWriteEnabled).toBe(false) // B3 仍是只写 morph
  })
})

/* ========================================================================== */
/* 3) 真实 MMDAnimationHelper + 生产 Idle.vmd：真实 helper 的备份/恢复语义下      */
/*    additive 不累积（mock helper 无法覆盖的真实链路；无资产时跳过）             */
/* ========================================================================== */

const BONES_JSON = fileURLToPath(new URL('./tmp/bones.json', import.meta.url))
const PROD_IDLE_VMD = fileURLToPath(
  new URL('../assets/model/optimized/motion-idle.vmd', import.meta.url)
)
const CONVERTED_IDLE_VMD = fileURLToPath(
  new URL('./tmp/motions/converted/Idle.vmd', import.meta.url)
)
const REAL_LOOK_AT_VMD = fs.existsSync(PROD_IDLE_VMD)
  ? PROD_IDLE_VMD
  : fs.existsSync(CONVERTED_IDLE_VMD)
    ? CONVERTED_IDLE_VMD
    : null
const HAS_REAL_LOOK_AT_FIXTURES = fs.existsSync(BONES_JSON) && REAL_LOOK_AT_VMD !== null

/** 真实 PMX 骨架（骨名/rest 位置/父子层级）的假 SkinnedMesh，可被真实 MMDAnimationHelper 驱动。 */
function createRealLookAtRig(): {
  mesh: SkinnedMesh
  root: Group
  bone: (name: string) => Bone | null
} {
  const data = JSON.parse(fs.readFileSync(BONES_JSON, 'utf8')) as {
    bones: Array<{ name: string; position: number[]; parentIndex: number }>
  }
  const allBones = data.bones.map((entry) => {
    const bone = new Bone()
    bone.name = entry.name
    bone.position.fromArray(entry.position)
    return bone
  })
  data.bones.forEach((entry, index) => {
    const parent = entry.parentIndex
    if (parent >= 0 && allBones[parent]) allBones[parent]!.add(allBones[index]!)
  })
  const root = new Group()
  const mesh = new Object3D() as unknown as SkinnedMesh
  const mutable = mesh as unknown as {
    isSkinnedMesh: boolean
    skeleton: unknown
    geometry: unknown
    pose: () => void
  }
  mutable.isSkinnedMesh = true
  data.bones.forEach((entry, index) => {
    if (entry.parentIndex < 0) mesh.add(allBones[index]!)
  })
  const boneByName = (name: string): Bone | null =>
    allBones.find((candidate) => candidate.name === name) ?? null
  mutable.skeleton = { bones: allBones, getBoneByName: boneByName }
  mutable.geometry = {
    userData: {
      MMD: {
        format: 'pmx',
        iks: [],
        grants: [],
        bones: data.bones.map((entry) => ({ name: entry.name, pos: entry.position.slice(0, 3) }))
      }
    }
  }
  mutable.pose = () => {
    data.bones.forEach((entry, index) => {
      const bone = allBones[index]!
      bone.quaternion.identity()
      bone.position.fromArray(entry.position)
    })
  }
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.updateMatrixWorld(true)
  return { mesh, root, bone: boneByName }
}

/** 用真实 MMDLoader/MMDAnimationHelper 创建 driver（两套独立实例用于 A/B 对照）。 */
function createRealLookAtDriver(clock: { ms: number }): {
  driver: ReturnType<typeof createHybridAnimator>
  rig: ReturnType<typeof createRealLookAtRig>
  helper: MMDAnimationHelper
} {
  const rig = createRealLookAtRig()
  const helper = new MMDAnimationHelper()
  helper.add(rig.mesh, { physics: false }) // 模拟 PetScene 装载 PMX 时先 add
  const b3 = createFakeB3()
  const loader = new MMDLoader()
  const file = path.basename(REAL_LOOK_AT_VMD!)
  const driver = createHybridAnimator({
    mesh: rig.mesh,
    root: rig.root,
    helper,
    b3: b3.animator,
    loadManifest: async () => ({
      schemaVersion: 1,
      clips: [{ id: 'idle', file, moods: ['idle'], loop: true, ik: 'on' }]
    }),
    loadClip: async (def: MotionClipDef) => {
      const buffer = fs.readFileSync(REAL_LOOK_AT_VMD!)
      const vmd = new Parser().parseVmd(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
        true
      )
      return processVmdData(
        vmd as object,
        rig.mesh,
        def,
        `pet-asset://model/${def.file}`,
        loader,
        { inPlace: true }
      )
    },
    manifestRetryCount: 0,
    now: () => clock.ms
  })
  return { driver, rig, helper }
}

describe.skipIf(!HAS_REAL_LOOK_AT_FIXTURES)(
  '真实 MMDAnimationHelper + Idle.vmd：additive 在真实备份/恢复语义下不累积',
  () => {
    it('A/B 对照：鼠标右移 → 首/頭/目先有 additive；连续帧增益稳定；脚底/センター不受影响', async () => {
      // A = 有鼠标目标；B = 无目标（基线）。两套独立 rig/helper/clip，同一时钟逐帧对齐推进。
      const clockA = { ms: 1000 }
      const clockB = { ms: 1000 }
      const a = createRealLookAtDriver(clockA)
      const b = createRealLookAtDriver(clockB)

      // 首帧让 manifest/clip 异步就绪
      a.driver.update(makeAnimationInput({ lookTarget: null }))
      b.driver.update(makeAnimationInput({ lookTarget: null }))
      await flushAsync()

      const frame = 1 / 30
      for (let index = 0; index < 90; index += 1) {
        a.driver.update(makeAnimationInput({ lookTarget: FAR_RIGHT }))
        b.driver.update(makeAnimationInput({ lookTarget: null }))
        clockA.ms += frame * 1000
        clockB.ms += frame * 1000
      }
      expect(a.driver.getDebugSnapshot().source).toBe('vmd')
      expect(a.driver.getDebugSnapshot().lookYaw).not.toBeNull()
      expect(b.driver.getDebugSnapshot().lookYaw).toBeNull()

      const headA = a.rig.bone('頭')!
      const headB = b.rig.bone('頭')!
      const neckA = a.rig.bone('首')!
      const neckB = b.rig.bone('首')!
      const eyeA = a.rig.bone('左目先')!
      const eyeB = b.rig.bone('右目先')!

      // 同一剪辑同一帧 → 基线姿态相同；差异即 additive。
      const headDelta = headB.quaternion.clone().invert().multiply(headA.quaternion)
      const neckDelta = neckB.quaternion.clone().invert().multiply(neckA.quaternion)
      expect(quaternionAngle(headDelta, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.01)
      expect(quaternionAngle(neckDelta, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.005)
      expect(quaternionAngle(eyeA.quaternion, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.02)
      expect(quaternionAngle(eyeB.quaternion, { x: 0, y: 0, z: 0, w: 1 })).toBeLessThan(1e-6)

      // 真实 helper 每帧 `_restoreBones` 从备份恢复（备份 = 叠加前的 clip 姿态）→ 再叠一帧不会变 2 倍。
      const headDeltaAngle = quaternionAngle(headDelta, { x: 0, y: 0, z: 0, w: 1 })
      for (let index = 0; index < 3; index += 1) {
        a.driver.update(makeAnimationInput({ lookTarget: FAR_RIGHT }))
        b.driver.update(makeAnimationInput({ lookTarget: null }))
        clockA.ms += frame * 1000
        clockB.ms += frame * 1000
      }
      const headDeltaAfter = quaternionAngle(
        headB.quaternion.clone().invert().multiply(headA.quaternion),
        { x: 0, y: 0, z: 0, w: 1 }
      )
      expect(Math.abs(headDeltaAfter - headDeltaAngle)).toBeLessThan(0.01)

      // look-at 不写 センター/脚骨；贴地补偿残余仍 <2px。
      const centerA = a.rig.bone('センター')!
      expect(Math.abs(centerA.position.x)).toBeLessThan(1e-6)
      expect(Math.abs(centerA.position.z)).toBeLessThan(1e-6)
      const snapshotA = a.driver.getDebugSnapshot()
      expect(snapshotA.externalFootErrorPx).not.toBeNull()
      expect(snapshotA.externalFootErrorPx!).toBeLessThan(2)
    })
  }
)
