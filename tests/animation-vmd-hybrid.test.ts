/**
 * Wave 2.5 / D1 单测：外部 VMD 动作层 + B3 混合驱动。
 *
 * 三部分：
 * 1. **纯逻辑**：clip 选择 / 播放速率钳制 / 淡入时长 / 脚底贴地公式（Node 直接跑）；
 * 2. **真实 VMD → AnimationClip**：用 `tests/tmp/motions/converted/{Idle,Taunt}.vmd` +
 *    `tests/tmp/bones.json` 在 Node 里走 MMDLoader.animationBuilder（不需要 WebGL），
 *    断言 30fps/时长/in-place センター X/Z 归零/Y bob 保留/剥 morph/B3 基准重挂；
 * 3. **混合门面**：轻量 mock 的 helper/mesh/B3（真实 three Object3D/Bone 数学），覆盖
 *    VMD 激活、B3 只写 morph、IK on/off、walk 时间缩放、贴地补偿、无 clip 回退、
 *    manifest/clip 加载失败回退、运行时异常回退、setPose 暂停/恢复。
 *
 * 依赖私有资产的用例用 `describe.skipIf`：无 `tests/tmp/**` 时自动跳过（CI/干净检出仍绿）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AnimationClip,
  Bone,
  Group,
  LoopOnce,
  LoopRepeat,
  NumberKeyframeTrack,
  Object3D,
  Vector3,
  VectorKeyframeTrack
} from 'three'
import type { KeyframeTrack, SkinnedMesh } from 'three'
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import type { MMDAnimationHelper as MmdHelperType } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'
import { Parser } from 'mmd-parser'
import { describe, expect, it } from 'vitest'

import type { AnimationDebugSnapshot, AnimationInput } from '../src/renderer/src/core/wave2-contract'
import type { PetAnimator } from '../src/renderer/src/animation/legacy/scene-bridge'
import {
  createHybridAnimator,
  type CreateHybridAnimatorOptions
} from '../src/renderer/src/animation/legacy/external/vmd-driver'
import type { MotionClipDef } from '../src/renderer/src/animation/legacy/external/manifest'
import {
  processVmdData,
  setHelperIkMode,
  type VmdClipInfo
} from '../src/renderer/src/animation/legacy/external/vmd-clip'
import {
  clampCrossfadeMs,
  horizontalSpeedOf,
  isIkEnabled,
  resolvePlaybackRate,
  selectClipForMood
} from '../src/renderer/src/animation/legacy/external/selection'
import {
  expectedFootGroundWorldY,
  footGroundingErrorPx,
  groundingOffsetLocalY,
  lowestFootWorldY
} from '../src/renderer/src/animation/legacy/external/grounding'
import { isSingleSegmentVmdFileName, parseMotionIndex } from '../src/renderer/src/animation/legacy/external/manifest'

/* ========================================================================== */
/* 夹具                                                                        */
/* ========================================================================== */

const BONES_JSON = fileURLToPath(new URL('./tmp/bones.json', import.meta.url))
const IDLE_VMD = fileURLToPath(new URL('./tmp/motions/converted/Idle.vmd', import.meta.url))
const TAUNT_VMD = fileURLToPath(new URL('./tmp/motions/converted/Taunt.vmd', import.meta.url))
const HAS_VMD_FIXTURES = fs.existsSync(BONES_JSON) && fs.existsSync(IDLE_VMD)
const HAS_TAUNT_FIXTURE = fs.existsSync(TAUNT_VMD)
/** 生产清单/VMD（`assets/model/optimized/**` 是 gitignore 的本地动作资产；干净检出时跳过）。 */
const PROD_MANIFEST = fileURLToPath(new URL('../assets/model/optimized/motion-index.json', import.meta.url))
const HAS_PROD_MOTION = fs.existsSync(PROD_MANIFEST) && fs.existsSync(BONES_JSON)

/** 一份合法 manifest（idle 循环 + ik on）。 */
function manifestWithClips(clips: Array<Record<string, unknown>>): unknown {
  return {
    schemaVersion: 1,
    clips: clips.map((clip) => ({ file: `motion-${String(clip.id ?? 'idle')}.vmd`, ...clip }))
  }
}

const IDLE_MANIFEST = manifestWithClips([
  { id: 'idle', file: 'motion-idle.vmd', moods: ['idle'], loop: true, ik: 'on' }
])

function makeClipInfo(def: MotionClipDef, durationSec = 2): VmdClipInfo {
  return {
    def,
    clip: new AnimationClip(def.id, durationSec, []),
    url: `pet-asset://model/${def.file}`,
    durationSec,
    frameRate: 30,
    frameCount: Math.round(durationSec * 30),
    trackCount: 0,
    boneTrackCount: 0,
    strippedMorphTrackCount: 0,
    rebasedPositionTrackCount: 0,
    inPlace: true,
    ik: def.ik
  }
}

/** 真实 three 对象的最小「蒙皮骨架」：Bone 层级挂在 Object3D(mesh) 下（不需要 WebGL 几何）。 */
interface FakeRig {
  mesh: SkinnedMesh
  root: Group
  center: Bone
  feet: Bone[]
}

const REST_FOOT_Y = 1.2

function createFakeRig(): FakeRig {
  const root = new Group()
  const mesh = new Object3D() as unknown as SkinnedMesh
  ;(mesh as unknown as { name: string }).name = 'fake-skinned-mesh'
  const center = new Bone()
  center.name = 'センター'
  center.position.set(0, 8.93, 0)
  const left = new Bone()
  left.name = '左足首D'
  left.position.set(-1, REST_FOOT_Y, 0)
  const right = new Bone()
  right.name = '右足首D'
  right.position.set(1, REST_FOOT_Y, 0)
  mesh.add(center, left, right)
  const bones = [center, left, right]
  ;(mesh as unknown as { skeleton: unknown }).skeleton = {
    bones,
    getBoneByName: (name: string) => bones.find((bone) => bone.name === name) ?? null
  }
  // SkinnedMesh.pose()：测试里只需把四元数复位（activate/deactivate 会调用）。
  ;(mesh as unknown as { pose: () => void }).pose = () => {
    for (const bone of bones) bone.quaternion.identity()
  }
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.updateMatrixWorld(true)
  return { mesh, root, center, feet: [left, right] }
}

/** 轻量 helper mock（结构 = MMDAnimationHelper 的 driver 用到的子集）。 */
interface FakeHelper {
  enabled: Record<string, boolean>
  meshes: object[]
  objects: WeakMap<object, { mixer?: FakeMixer }>
  footOffsetY: number
  failNextUpdate: boolean
  enable(key: string, enabled: boolean): FakeHelper
  add(object: object, params?: { animation?: unknown }): FakeHelper
  remove(object: object): FakeHelper
  update(delta: number): FakeHelper
}

interface FakeMixer {
  time: number
  timeScale: number
  _actions: Array<{ time: number; setLoop: () => void; clampWhenFinished: boolean }>
}

function createFakeHelper(rig: FakeRig): FakeHelper {
  const helper: FakeHelper = {
    enabled: { ik: true, grant: true },
    meshes: [],
    objects: new WeakMap(),
    footOffsetY: 0,
    failNextUpdate: false,
    enable(key, enabled) {
      helper.enabled[key] = enabled
      return helper
    },
    add(object, params) {
      if (helper.meshes.includes(object)) throw new Error('helper: mesh already added')
      helper.meshes.push(object)
      const mixer: FakeMixer | undefined = params?.animation
        ? {
            time: 0,
            timeScale: 1,
            _actions: [{ time: 0, setLoop: () => undefined, clampWhenFinished: false }]
          }
        : undefined
      helper.objects.set(object, { mixer })
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
      if (helper.failNextUpdate) {
        helper.failNextUpdate = false
        throw new Error('helper.update 模拟运行时失败')
      }
      const mesh = helper.meshes[0]
      const entry = mesh ? helper.objects.get(mesh) : undefined
      if (entry?.mixer) {
        entry.mixer.time += delta
        entry.mixer._actions[0]!.time += delta
        // 模拟 VMD 让角色整体浮空（贴地补偿测试）
        for (const foot of rig.feet) foot.position.y = REST_FOOT_Y + helper.footOffsetY
      }
      return helper
    }
  }
  return helper
}

/** 轻量 B3 mock（只记录调用/快照；不发警告、不需要真实 PMX）。 */
interface FakeB3 {
  updates: number
  boneWriteEnabled: boolean
  lastInput: AnimationInput | undefined
  snapshot: AnimationDebugSnapshot
  animator: PetAnimator
}

function createFakeB3(): FakeB3 {
  const state: FakeB3 = {
    updates: 0,
    boneWriteEnabled: true,
    lastInput: undefined,
    snapshot: {
      pose: 'stand',
      poseWeight: 1,
      activeLayers: 1,
      gesture: null,
      blink: 0,
      smile: 0,
      mouthOpen: 0,
      lookYaw: null,
      missingBones: []
    },
    animator: null as unknown as PetAnimator
  }
  state.animator = {
    update(input: AnimationInput): void {
      state.updates += 1
      state.lastInput = input
    },
    getDebugSnapshot(): AnimationDebugSnapshot {
      return state.snapshot
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

function makeInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
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
    petRect: { x: 0, y: 0, width: 300, height: 540 },
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
  rig: FakeRig
  helper: FakeHelper
  b3: FakeB3
  clock: { ms: number }
}

function createDriverFixture(overrides: Partial<CreateHybridAnimatorOptions> = {}): DriverFixture {
  const rig = createFakeRig()
  const helper = createFakeHelper(rig)
  const b3 = createFakeB3()
  const clock = { ms: 1000 }
  const driver = createHybridAnimator({
    mesh: rig.mesh,
    root: rig.root,
    helper: helper as unknown as MmdHelperType,
    b3: b3.animator,
    loadManifest: async () => IDLE_MANIFEST,
    loadClip: async (def: MotionClipDef) => makeClipInfo(def),
    manifestRetryCount: 0,
    now: () => clock.ms,
    ...overrides
  })
  return { driver, rig, helper, b3, clock }
}

/* ========================================================================== */
/* 1) 纯逻辑                                                                   */
/* ========================================================================== */

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

const WALK_DEF: MotionClipDef = {
  id: 'walk',
  file: 'motion-walk.vmd',
  moods: ['walk'],
  loop: true,
  ik: 'on',
  nominalSpeedPxPerSec: 100,
  crossfadeMs: 200,
  source: null
}

describe('selectClipForMood：mood → clip', () => {
  const manifest = parseMotionIndex(
    manifestWithClips([
      { id: 'walk', moods: ['walk'], nominalSpeedPxPerSec: 100 },
      { id: 'idle', moods: ['idle', 'pat'] },
      { id: 'idle2', moods: ['idle'] }
    ])
  ).manifest

  it('无清单/空清单 → null（回退 B3）', () => {
    expect(selectClipForMood(null, 'idle')).toBeNull()
    expect(selectClipForMood(undefined, 'idle')).toBeNull()
    expect(selectClipForMood({ schemaVersion: 1, clips: [] }, 'idle')).toBeNull()
  })

  it('按 manifest 顺序取第一个 mood 匹配（优先级）', () => {
    expect(selectClipForMood(manifest, 'idle')?.id).toBe('idle')
    expect(selectClipForMood(manifest, 'pat')?.id).toBe('idle')
    expect(selectClipForMood(manifest, 'walk')?.id).toBe('walk')
  })

  it('无匹配 mood → null', () => {
    expect(selectClipForMood(manifest, 'sleep')).toBeNull()
    expect(selectClipForMood(manifest, 'drag')).toBeNull()
  })
})

describe('resolvePlaybackRate：walk 时间缩放钳制', () => {
  it('非 walk（nominal=null）→ 1', () => {
    expect(resolvePlaybackRate(null, 120)).toBe(1)
    expect(resolvePlaybackRate(0, 120)).toBe(1)
    expect(resolvePlaybackRate(Number.NaN, 120)).toBe(1)
  })

  it('按速度比例缩放并钳制在 [0.5, 1.6]', () => {
    expect(resolvePlaybackRate(100, 100)).toBeCloseTo(1)
    expect(resolvePlaybackRate(100, 150)).toBeCloseTo(1.5)
    expect(resolvePlaybackRate(100, 50)).toBeCloseTo(0.5)
    expect(resolvePlaybackRate(100, 10)).toBe(0.5) // 下限
    expect(resolvePlaybackRate(100, 500)).toBe(1.6) // 上限
    expect(resolvePlaybackRate(100, 0)).toBe(0.5)
  })

  it('非法速度按 0 处理（→ 下限）', () => {
    expect(resolvePlaybackRate(100, Number.NaN)).toBe(0.5)
    expect(resolvePlaybackRate(100, -50)).toBe(0.5)
  })
})

describe('horizontalSpeedOf / clampCrossfadeMs / isIkEnabled', () => {
  it('horizontalSpeedOf：模长 + 非法值兜底', () => {
    expect(horizontalSpeedOf({ x: 3, y: 4 })).toBeCloseTo(5)
    expect(horizontalSpeedOf({ x: 0, y: 0 })).toBe(0)
    expect(horizontalSpeedOf(null)).toBe(0)
    expect(horizontalSpeedOf(undefined)).toBe(0)
    expect(horizontalSpeedOf({ x: Number.NaN, y: 2 })).toBe(2)
  })

  it('clampCrossfadeMs：默认 200 / 夹到 [120, 250] / 0 保留', () => {
    expect(clampCrossfadeMs(undefined)).toBe(200)
    expect(clampCrossfadeMs(Number.NaN)).toBe(200)
    expect(clampCrossfadeMs(200)).toBe(200)
    expect(clampCrossfadeMs(50)).toBe(120)
    expect(clampCrossfadeMs(400)).toBe(250)
    expect(clampCrossfadeMs(0)).toBe(0)
  })

  it('isIkEnabled：只有 off 关闭（缺省 = on）', () => {
    expect(isIkEnabled('on')).toBe(true)
    expect(isIkEnabled('off')).toBe(false)
    expect(isIkEnabled(null)).toBe(true)
    expect(isIkEnabled(undefined)).toBe(true)
  })
})

describe('贴地纯计算（grounding.ts）', () => {
  it('expectedFootGroundWorldY：局部 Y × 世界缩放 + root 世界 Y', () => {
    expect(expectedFootGroundWorldY(1.2, 25, 300)).toBeCloseTo(330)
    expect(expectedFootGroundWorldY(1.2, 1, 0)).toBeCloseTo(1.2)
    expect(expectedFootGroundWorldY(Number.NaN, 1, 0)).toBeCloseTo(0)
  })

  it('groundingOffsetLocalY：把脚底拉回地面的 mesh.position.y 增量', () => {
    expect(groundingOffsetLocalY(1.5, 1.2, 1)).toBeCloseTo(-0.3)
    expect(groundingOffsetLocalY(1.2, 1.2, 1)).toBe(0)
    // 世界缩放下要换算回模型局部单位
    expect(groundingOffsetLocalY(30, 24, 25)).toBeCloseTo(-0.24)
    expect(groundingOffsetLocalY(Number.NaN, 1, 1)).toBe(0)
  })

  it('footGroundingErrorPx：补偿后残余（绝对值；非法输入 NaN）', () => {
    expect(footGroundingErrorPx(1.2, 1.2)).toBe(0)
    expect(footGroundingErrorPx(0.9, 1.2)).toBeCloseTo(0.3)
    expect(footGroundingErrorPx(1.2, 1.2 + 0.5)).toBeCloseTo(0.5)
    expect(Number.isNaN(footGroundingErrorPx(Number.NaN, 1.2))).toBe(true)
  })

  it('lowestFootWorldY：取最低点 / 空与全非法 → null', () => {
    expect(lowestFootWorldY([1.2, 0.4, 2.1])).toBeCloseTo(0.4)
    expect(lowestFootWorldY([])).toBeNull()
    expect(lowestFootWorldY([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull()
  })
})

/* ========================================================================== */
/* 2) 真实 VMD → AnimationClip（Node，无 WebGL）                                 */
/* ========================================================================== */

interface BonesJson {
  bones: Array<{ name: string; position: number[] }>
}

/** 用真实 PMX 骨名/rest 位置造最小骨架（track 构建只需要 name + position + getBoneByName）。 */
function createMeshFromBonesJson(): { mesh: SkinnedMesh; bones: Map<string, number[]> } {
  const data = JSON.parse(fs.readFileSync(BONES_JSON, 'utf8')) as BonesJson
  const positions = new Map<string, number[]>()
  const bones = data.bones.map((entry) => {
    positions.set(entry.name, entry.position.slice(0, 3))
    const bone = new Bone()
    bone.name = entry.name
    bone.position.fromArray(entry.position)
    return bone
  })
  const fake = {
    skeleton: {
      bones,
      getBoneByName: (name: string) => bones.find((bone) => bone.name === name) ?? null
    },
    morphTargetDictionary: {},
    geometry: {
      userData: {
        MMD: {
          bones: data.bones.map((entry) => ({ name: entry.name, pos: entry.position.slice(0, 3) }))
        }
      }
    }
  }
  return { mesh: fake as unknown as SkinnedMesh, bones: positions }
}

/** 用真实 PMX 骨名/rest 位置/父子层级造「可被 MMDAnimationHelper 驱动」的假 SkinnedMesh（无 WebGL）。 */
function createRealSkinnedRig(): {
  mesh: SkinnedMesh
  root: Group
  feet: Bone[]
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
    name: string
    skeleton: unknown
    geometry: unknown
    pose: () => void
  }
  mutable.isSkinnedMesh = true
  mutable.name = 'fake-real-skinned-mesh'
  for (const entry of data.bones) {
    if (entry.parentIndex < 0) mesh.add(allBones[data.bones.indexOf(entry)]!)
  }
  const boneByName = (name: string): Bone | null =>
    allBones.find((candidate) => candidate.name === name) ?? null
  mutable.skeleton = {
    bones: allBones,
    getBoneByName: boneByName
  }
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
  const feet = ['左足首D', '右足首D', '左足先EX', '右足先EX', '左つま先', '右つま先', '左足首', '右足首', '左足D', '右足D']
    .map((name) => boneByName(name))
    .filter((bone): bone is Bone => bone !== null)
  return { mesh, root, feet, bone: boneByName }
}

/** 两个四元数的夹角（弧度）。 */
function quaternionAngle(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return 2 * Math.acos(Math.min(1, dot))
}

function readVmd(file: string): object {
  const buffer = fs.readFileSync(file)
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const parser = new Parser()
  return parser.parseVmd(arrayBuffer as ArrayBuffer, true) as object
}

function findTrack(
  clip: AnimationClip,
  boneName: string,
  property: 'position' | 'quaternion'
): KeyframeTrack | undefined {
  return clip.tracks.find((track) => track.name === `.bones[${boneName}].${property}`)
}

function numberValues(track: KeyframeTrack): number[] {
  return Array.from(track.values as ArrayLike<number>)
}

describe.skipIf(!HAS_VMD_FIXTURES)('真实 VMD 处理（Idle.vmd，Node / MMDLoader.animationBuilder）', () => {
  const loader = new MMDLoader()

  function buildIdleInfo(inPlace: boolean): VmdClipInfo {
    const { mesh } = createMeshFromBonesJson()
    const def: MotionClipDef = { ...IDLE_DEF, id: 'idle', file: 'motion-idle.vmd' }
    return processVmdData(readVmd(IDLE_VMD), mesh, def, 'pet-asset://model/motion-idle.vmd', loader, {
      inPlace,
      stripMorphTracks: true
    })
  }

  it('时长/帧率/轨道数：Idle 3.00s、30fps、54 骨 × (position+quaternion)、morph 全剥', () => {
    const info = buildIdleInfo(true)
    expect(info.durationSec).toBeCloseTo(3.0, 5)
    expect(info.frameRate).toBe(30)
    expect(info.frameCount).toBe(90)
    expect(info.boneTrackCount).toBe(108)
    expect(info.trackCount).toBe(108)
    expect(info.strippedMorphTrackCount).toBe(0) // 转换产物本身 morph=0
    expect(info.clip.name).toBe('idle')
    expect(info.clip.duration).toBeCloseTo(3.0, 5)
  })

  it('in-place：センター X/Z 归零、Y bob 保留（不是死值）', () => {
    const info = buildIdleInfo(true)
    const track = findTrack(info.clip, 'センター', 'position')
    expect(track).toBeDefined()
    const values = numberValues(track!)
    const xs: number[] = []
    const ys: number[] = []
    const zs: number[] = []
    for (let index = 0; index + 2 < values.length; index += 3) {
      xs.push(values[index]!)
      ys.push(values[index + 1]!)
      zs.push(values[index + 2]!)
    }
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-6)
    expect(Math.max(...zs.map(Math.abs))).toBeLessThan(1e-6)
    // センター Y bob（VMD 偏移约 0.60–0.69 + rest 8.93）
    expect(Math.min(...ys)).toBeGreaterThan(9.0)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.05)
  })

  it('不 in-place 时保留原始水平 root motion（对照组）', () => {
    const info = buildIdleInfo(false)
    const track = findTrack(info.clip, 'センター', 'position')
    const values = numberValues(track!)
    const xs: number[] = []
    for (let index = 0; index + 2 < values.length; index += 3) xs.push(values[index]!)
    expect(Math.min(...xs)).toBeLessThan(-0.05)
  })

  it('足ＩＫ/足首/腕等 54 骨存活，头/手轨道存在（骨名匹配本 PMX）', () => {
    const info = buildIdleInfo(true)
    for (const bone of ['センター', '頭', '首', '上半身', '左腕', '右腕', '左足ＩＫ', '左足首']) {
      expect(findTrack(info.clip, bone, 'quaternion'), bone).toBeDefined()
    }
  })

  it('setHelperIkMode：on → enable("ik", true)；off → false', () => {
    const calls: Array<[string, boolean]> = []
    const helper = {
      enable(key: string, enabled: boolean) {
        calls.push([key, enabled])
        return helper
      }
    }
    expect(setHelperIkMode(helper, 'on')).toBe(true)
    expect(setHelperIkMode(helper, 'off')).toBe(false)
    expect(calls).toEqual([
      ['ik', true],
      ['ik', false]
    ])
  })
})

describe.skipIf(!HAS_VMD_FIXTURES || !HAS_TAUNT_FIXTURE)('真实 VMD 处理（Taunt.vmd 水平 root motion 归零）', () => {
  it('Taunt in-place 后 センター X/Z = rest（对齐"原地动作"约定）', () => {
    const loader = new MMDLoader()
    const { mesh } = createMeshFromBonesJson()
    const def: MotionClipDef = { ...IDLE_DEF, id: 'taunt', file: 'motion-taunt.vmd' }
    const info = processVmdData(readVmd(TAUNT_VMD), mesh, def, 'pet-asset://model/motion-taunt.vmd', loader, {
      inPlace: true
    })
    const track = findTrack(info.clip, 'センター', 'position')
    expect(track).toBeDefined()
    const values = numberValues(track!)
    for (let index = 0; index + 2 < values.length; index += 3) {
      expect(Math.abs(values[index]!)).toBeLessThan(1e-6)
      expect(Math.abs(values[index + 2]!)).toBeLessThan(1e-6)
    }
  })
})

describe('processVmdData：B3 基准重挂 / morph 剥离 / 无轨道报错（mock builder）', () => {
  /** 构造一个带「build 时 live 基准」行为的 mock loader（模拟 B3 正在写 センター.position 的时机）。 */
  function createMockLoader(options: {
    liveCenterY?: number
    trackValues?: number[] | null
    withMorphTrack?: boolean
  }): { loader: MMDLoader; mesh: SkinnedMesh } {
    const mesh = new Object3D() as unknown as SkinnedMesh
    const center = new Bone()
    center.name = 'センター'
    center.position.set(0, options.liveCenterY ?? 8.93, 0)
    const bones = [center]
    ;(mesh as unknown as { skeleton: unknown }).skeleton = {
      bones,
      getBoneByName: (name: string) => bones.find((bone) => bone.name === name) ?? null
    }
    ;(mesh as unknown as { geometry: unknown }).geometry = {
      userData: { MMD: { bones: [{ name: 'センター', pos: [0, 8.93, 0] }] } }
    }
    ;(mesh as unknown as { pose: () => void }).pose = () => undefined

    const build = (): AnimationClip => {
      const values = options.trackValues ?? [0, 8.93 + 0.69, 0, 0, 8.93 + 0.6, 0]
      const tracks: KeyframeTrack[] = [
        new VectorKeyframeTrack('.bones[センター].position', [0, 1], values)
      ]
      if (options.withMorphTrack) {
        tracks.push(new NumberKeyframeTrack('.morphTargetInfluences[0]', [0, 1], [0.5, 0.5]))
      }
      return new AnimationClip('', -1, tracks)
    }
    const fakeLoader = { animationBuilder: { build } }
    return { loader: fakeLoader as unknown as MMDLoader, mesh }
  }

  it('把 build 时 live 基准换成 PMX rest 基准（センター Y bob 不变、X/Z 归零）', () => {
    // live 基准 = rest + 0.5（模拟 B3 已把 センター 抬高 0.5）；轨道值 = live + VMD 偏移
    const { loader, mesh } = createMockLoader({
      liveCenterY: 8.93 + 0.5,
      trackValues: [0.4, 8.93 + 0.5 + 0.69, -0.3, 0, 8.93 + 0.5 + 0.6, 0]
    })
    const def: MotionClipDef = { ...IDLE_DEF }
    const info = processVmdData({} as object, mesh, def, 'pet-asset://model/motion-idle.vmd', loader)
    expect(info.rebasedPositionTrackCount).toBe(1)
    const track = findTrack(info.clip, 'センター', 'position')!
    const values = numberValues(track)
    // VectorKeyframeTrack 内部是 Float32Array（有 float32 精度），逐项近似比较
    expect(values[0]).toBeCloseTo(0, 6)
    expect(values[1]).toBeCloseTo(8.93 + 0.69, 4)
    expect(values[2]).toBeCloseTo(0, 6)
    expect(values[3]).toBeCloseTo(0, 6)
    expect(values[4]).toBeCloseTo(8.93 + 0.6, 4)
    expect(values[5]).toBeCloseTo(0, 6)
  })

  it('剥掉 VMD morph 轨道（表情由 B3 统一驱动）', () => {
    const { loader, mesh } = createMockLoader({ withMorphTrack: true })
    const def: MotionClipDef = { ...IDLE_DEF }
    const info = processVmdData({} as object, mesh, def, 'pet-asset://model/motion-idle.vmd', loader)
    expect(info.strippedMorphTrackCount).toBe(1)
    expect(info.trackCount).toBe(1)
    expect(info.clip.tracks.some((track) => track.name.includes('morphTargetInfluences'))).toBe(false)
  })

  it('stripMorphTracks=false 时保留 morph 轨道（调试对照）', () => {
    const { loader, mesh } = createMockLoader({ withMorphTrack: true })
    const def: MotionClipDef = { ...IDLE_DEF }
    const info = processVmdData({} as object, mesh, def, 'pet-asset://model/motion-idle.vmd', loader, {
      stripMorphTracks: false
    })
    expect(info.trackCount).toBe(2)
  })

  it('没有骨骼轨道 → 抛出可读错误（由 driver 捕获回退）', () => {
    const mesh = new Object3D() as unknown as SkinnedMesh
    ;(mesh as unknown as { skeleton: unknown }).skeleton = {
      bones: [],
      getBoneByName: () => null
    }
    ;(mesh as unknown as { geometry: unknown }).geometry = { userData: {} }
    const build = (): AnimationClip => new AnimationClip('', -1, [])
    const loader = { animationBuilder: { build } } as unknown as MMDLoader
    const def: MotionClipDef = { ...IDLE_DEF }
    expect(() =>
      processVmdData({} as object, mesh, def, 'pet-asset://model/motion-idle.vmd', loader)
    ).toThrow(/没有可用骨骼轨道/)
  })
})

describe.skipIf(!HAS_PROD_MOTION)('生产清单 + 最终 VMD（assets/model/optimized，本地 gitignore 资产）', () => {
  const optimizedDir = path.dirname(PROD_MANIFEST)
  // 2026-11-09：旧 PMX 自定义动作资产（VMD + motion-index）已按用户要求删除；本 describe 由
  // HAS_PROD_MOTION 跳过，但常量初始化不能 eagerly 读文件（否则 suite 收集阶段 ENOENT）。
  const parsed = HAS_PROD_MOTION
    ? parseMotionIndex(JSON.parse(fs.readFileSync(PROD_MANIFEST, 'utf8')) as unknown)
    : (null as unknown as ReturnType<typeof parseMotionIndex>)

  it('生产 motion-index.json 解析零告警、clip 文件都是 optimized 下的单段 .vmd 且存在', () => {
    expect(parsed.warnings).toEqual([])
    expect(parsed.manifest.clips.length).toBeGreaterThanOrEqual(2)
    for (const clip of parsed.manifest.clips) {
      expect(isSingleSegmentVmdFileName(clip.file), clip.file).toBe(true)
      expect(fs.existsSync(path.join(optimizedDir, clip.file)), clip.file).toBe(true)
    }
    const ids = parsed.manifest.clips.map((clip) => clip.id)
    expect(ids).toContain('idle')
    expect(ids).toContain('walk')
    const walk = parsed.manifest.clips.find((clip) => clip.id === 'walk')!
    expect(walk.nominalSpeedPxPerSec).toBeGreaterThan(0)
  })

  it('生产 VMD 可被 processVmdData 处理：时长/轨道有效、センター X/Z in-place 归零、无 NaN', () => {
    const loader = new MMDLoader()
    for (const def of parsed.manifest.clips) {
      const { mesh } = createMeshFromBonesJson()
      const info = processVmdData(
        readVmd(path.join(optimizedDir, def.file)),
        mesh,
        def,
        `pet-asset://model/${def.file}`,
        loader,
        { inPlace: true }
      )
      // 单帧静态姿势（如坐姿单帧）最短 0.2s；其余动作应更长
      expect(info.durationSec, def.id).toBeGreaterThanOrEqual(0.2)
      expect(Number.isFinite(info.clip.duration), def.id).toBe(true)
      expect(info.boneTrackCount, def.id).toBeGreaterThan(0)
      const centerPosition = findTrack(info.clip, 'センター', 'position')
      if (centerPosition) {
        const values = numberValues(centerPosition)
        for (let index = 0; index + 2 < values.length; index += 3) {
          expect(Number.isFinite(values[index]!), def.id).toBe(true)
          expect(Math.abs(values[index]!), def.id).toBeLessThan(1e-6)
          expect(Math.abs(values[index + 2]!), def.id).toBeLessThan(1e-6)
        }
      }
      for (const track of info.clip.tracks) {
        const values = numberValues(track)
        expect(values.every((value) => Number.isFinite(value)), `${def.id}:${track.name}`).toBe(true)
      }
    }
  })

  it('真实 MMDAnimationHelper + 处理后 Idle clip：逐帧 helper.update 真的驱动骨骼（K1 回归）', () => {
    const rig = createRealSkinnedRig()
    const loader = new MMDLoader()
    const def: MotionClipDef = { ...IDLE_DEF, file: 'motion-idle.vmd' }
    const info = processVmdData(
      readVmd(path.join(optimizedDir, def.file)),
      rig.mesh,
      def,
      'pet-asset://model/motion-idle.vmd',
      loader,
      { inPlace: true }
    )
    const helper = new MMDAnimationHelper()
    helper.add(rig.mesh, { animation: info.clip, physics: false })
    const arm = rig.bone('左腕')!
    const head = rig.bone('頭')!
    const center = rig.bone('センター')!
    const before = {
      arm: arm.quaternion.clone(),
      head: head.quaternion.clone(),
      center: center.position.clone()
    }
    for (let frame = 0; frame < 30; frame += 1) helper.update(1 / 30)
    // K1 回归：时间在动、骨架也在动（不是 PropertyMixer 跳写导致的 rest 姿势）
    expect(quaternionAngle(before.arm, arm.quaternion)).toBeGreaterThan(0.01)
    expect(quaternionAngle(before.head, head.quaternion)).toBeGreaterThan(0.01)
    // in-place 生效：センター X/Z = rest（0），Y bob 保留（≠ bind 8.93）
    expect(Math.abs(center.position.x)).toBeLessThan(1e-6)
    expect(Math.abs(center.position.z)).toBeLessThan(1e-6)
    expect(Math.abs(center.position.y - 8.93)).toBeGreaterThan(0.1)
    // mixer 时间 ≈ 30 帧 = 1s（逐帧 update 路径）
    const mixer = helper.objects.get(rig.mesh)?.mixer
    expect(mixer).toBeDefined()
    expect(mixer!.time).toBeCloseTo(1, 1)
  })

  it('混合门面 + 真实 MMDAnimationHelper + 生产清单：激活 idle / 退出 sleep / 再激活 / 切 walk 均不抛错', async () => {
    const rig = createRealSkinnedRig()
    const helper = new MMDAnimationHelper()
    helper.add(rig.mesh, { physics: false }) // 模拟 PetScene 装载 PMX 时先 add
    const b3 = createFakeB3()
    const loader = new MMDLoader()
    const rawManifest = JSON.parse(fs.readFileSync(PROD_MANIFEST, 'utf8')) as unknown
    const clock = { ms: 1000 }
    const driver = createHybridAnimator({
      mesh: rig.mesh,
      root: rig.root,
      helper,
      b3: b3.animator,
      loadManifest: async () => rawManifest,
      loadClip: async (def: MotionClipDef) =>
        processVmdData(
          readVmd(path.join(optimizedDir, def.file)),
          rig.mesh,
          def,
          `pet-asset://model/${def.file}`,
          loader,
          { inPlace: true }
        ),
      manifestRetryCount: 0,
      now: () => clock.ms
    })

    driver.update(makeInput())
    await flushAsync() // 清单 + 串行预加载 idle/walk/taunt
    for (let frame = 0; frame < 60; frame += 1) {
      driver.update(makeInput())
      clock.ms += 1000 / 30
    }
    const idleSnapshot = driver.getDebugSnapshot()
    expect(idleSnapshot.source).toBe('vmd')
    expect(idleSnapshot.clipId).toBe('idle')
    expect(idleSnapshot.externalIk).toBe('on')
    expect(idleSnapshot.externalFootErrorPx).not.toBeNull()
    expect(idleSnapshot.externalFootErrorPx!).toBeLessThan(2)
    expect(b3.boneWriteEnabled).toBe(false)
    // 循环 clip：mixer action 被 configureAction 设为 LoopRepeat（r171 私有 _actions 可用性回归）
    expect(helper.objects.get(rig.mesh)!.mixer!._actions[0]!.loop).toBe(LoopRepeat)
    // 真实 helper 驱动后骨骼离开 bind（左腕/頭 有 VMD 内容）
    expect(quaternionAngle(rig.bone('左腕')!.quaternion, { x: 0, y: 0, z: 0, w: 1 })).toBeGreaterThan(0.01)
    expect(Math.abs(rig.bone('センター')!.position.x)).toBeLessThan(1e-6)

    // sleep 无 clip → 退出 VMD、真实 helper.remove / mesh.pose 生命周期不抛错
    driver.update(makeInput({ mood: 'sleep' }))
    expect(driver.getDebugSnapshot().source).toBe('procedural')
    expect(b3.boneWriteEnabled).toBe(true)
    expect(helper.objects.get(rig.mesh)).toBeUndefined()

    // 回 idle → 重新 remove/add 挂载（真实 helper 不允许重复 add，覆盖该回归）
    expect(() => driver.update(makeInput())).not.toThrow()
    expect(driver.getDebugSnapshot().source).toBe('vmd')
    expect(driver.getDebugSnapshot().clipId).toBe('idle')

    // 切 walk（清单已预加载）→ clipId=walk、速度 0 时 playbackRate 钳到 0.5
    driver.update(makeInput({ mood: 'walk' }))
    expect(driver.getDebugSnapshot().source).toBe('vmd')
    expect(driver.getDebugSnapshot().clipId).toBe('walk')
    expect(driver.getExternalState().playbackRate).toBeCloseTo(0.5)
    expect(driver.getExternalState().disabledReason).toBeNull()

    // dshDone → 一次性 Salute（loop=false）：LoopOnce 播完自动回退 B3（r171 pause/clamp 路径回归）
    // 2026-11-08 起 pat 不再有 VMD clip（taunt 已移除，摸头改由 B3 程序化反应表现）。
    driver.update(makeInput({ mood: 'dshDone' }))
    expect(driver.getDebugSnapshot().source).toBe('vmd')
    expect(driver.getDebugSnapshot().clipId).toBe('salute')
    expect(helper.objects.get(rig.mesh)!.mixer!._actions[0]!.loop).toBe(LoopOnce)
    let oneShotFinished = false
    for (let frame = 0; frame < 150 && !oneShotFinished; frame += 1) {
      driver.update(makeInput({ mood: 'dshDone' }))
      clock.ms += 1000 / 30
      oneShotFinished = driver.getDebugSnapshot().source === 'procedural'
    }
    expect(oneShotFinished).toBe(true)
    expect(b3.boneWriteEnabled).toBe(true)
  })
})

/* ========================================================================== */
/* 3) 混合门面（mock helper/mesh/B3）                                           */
/* ========================================================================== */

describe('createHybridAnimator：VMD 激活 / B3 分工 / IK / 时间缩放 / 回退', () => {
  it('manifest 就绪后按 idle 激活 VMD：source/clipId/clipTimeSec/externalIk，B3 骨骼写入关闭', async () => {
    const { driver, helper, b3 } = createDriverFixture()

    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('procedural')

    await flushAsync()
    driver.update(makeInput())

    const snapshot = driver.getDebugSnapshot()
    expect(snapshot.source).toBe('vmd')
    expect(snapshot.clipId).toBe('idle')
    expect(snapshot.externalIk).toBe('on')
    expect(typeof snapshot.clipTimeSec).toBe('number')
    expect(snapshot.clipTimeSec!).toBeGreaterThanOrEqual(0)
    expect(snapshot.externalFootErrorPx).toBe(0)
    expect(b3.boneWriteEnabled).toBe(false)
    expect(helper.enabled.ik).toBe(true)
    expect(helper.meshes).toHaveLength(1)
    const state = driver.getExternalState()
    expect(state.activeClipId).toBe('idle')
    expect(state.loadedClipIds).toEqual(['idle'])
    expect(state.disabledReason).toBeNull()
  })

  it('mood 无 VMD clip（sleep）→ 退出 clip、B3 恢复骨骼写入、快照回 procedural', async () => {
    const { driver, helper, b3 } = createDriverFixture()
    driver.update(makeInput())
    await flushAsync()
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')

    driver.update(makeInput({ mood: 'sleep' }))
    const snapshot = driver.getDebugSnapshot()
    expect(snapshot.source).toBe('procedural')
    expect(snapshot.clipId).toBeNull()
    expect(snapshot.clipTimeSec).toBeNull()
    expect(snapshot.externalFootErrorPx).toBeNull()
    expect(snapshot.externalIk).toBeNull()
    expect(b3.boneWriteEnabled).toBe(true)
    expect(helper.meshes).toHaveLength(0)

    // 回到 idle 会重新激活（helper.remove/add 生命周期正确）
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')
    expect(helper.meshes).toHaveLength(1)
  })

  it('manifest ik=off → helper.enable("ik", false)，externalIk="off"', async () => {
    const { driver, helper } = createDriverFixture({
      loadManifest: async () =>
        manifestWithClips([{ id: 'idle', file: 'motion-idle.vmd', moods: ['idle'], ik: 'off' }])
    })
    driver.update(makeInput())
    await flushAsync()
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')
    expect(driver.getDebugSnapshot().externalIk).toBe('off')
    expect(helper.enabled.ik).toBe(false)
  })

  it('walk clip：按水平速度调 mixer.timeScale（1.5 / 钳制 0.5），并暴露 playbackRate', async () => {
    const { driver, helper, rig } = createDriverFixture({
      loadManifest: async () =>
        manifestWithClips([
          {
            id: 'walk',
            file: 'motion-walk.vmd',
            moods: ['walk'],
            nominalSpeedPxPerSec: 100,
            crossfadeMs: 200
          }
        ])
    })
    await flushAsync()

    driver.update(
      makeInput({
        mood: 'walk',
        motion: { ...makeInput().motion, velocity: { x: 150, y: 0 } }
      })
    )
    const mixer = helper.objects.get(rig.mesh)!.mixer!
    expect(mixer.timeScale).toBeCloseTo(1.5)
    expect(driver.getExternalState().playbackRate).toBeCloseTo(1.5)

    driver.update(
      makeInput({
        mood: 'walk',
        motion: { ...makeInput().motion, velocity: { x: 20, y: 0 } }
      })
    )
    expect(mixer.timeScale).toBeCloseTo(0.5)
  })

  it('脚底动态贴地：VMD 整体浮空 0.5 单位 → mesh.position.y 补偿 -0.5、残余误差 <0.1px', async () => {
    const { driver, helper, rig, clock } = createDriverFixture()
    helper.footOffsetY = 0.5 // 模拟 VMD 让脚整体浮空（rest 脚底 1.2 → 1.7）

    driver.update(makeInput()) // manifest 未就绪帧
    await flushAsync()
    for (let frame = 0; frame < 20; frame += 1) {
      driver.update(makeInput())
      clock.ms += 1000 / 60
    }

    const snapshot = driver.getDebugSnapshot()
    expect(snapshot.source).toBe('vmd')
    expect(rig.mesh.position.y).toBeCloseTo(-0.5, 2)
    expect(snapshot.externalFootErrorPx).not.toBeNull()
    expect(snapshot.externalFootErrorPx!).toBeLessThan(0.1)
  })

  it('manifest 加载失败 → 不抛错、完全回退 B3（warnings 记录，disabledReason 仍 null）', async () => {
    const { driver, b3 } = createDriverFixture({
      loadManifest: async () => {
        throw new Error('HTTP 404')
      }
    })
    expect(() => driver.update(makeInput())).not.toThrow()
    await flushAsync()
    expect(() => driver.update(makeInput())).not.toThrow()
    const snapshot = driver.getDebugSnapshot()
    expect(snapshot.source).toBe('procedural')
    expect(b3.boneWriteEnabled).toBe(true)
    const state = driver.getExternalState()
    expect(state.manifestLoaded).toBe(false)
    expect(state.warnings.join('\n')).toContain('motion-index 加载失败')
    expect(state.disabledReason).toBeNull()
  })

  it('clip 加载失败 → 该 mood 回退 B3、warnings 记录，不抛错', async () => {
    const { driver } = createDriverFixture({
      loadClip: async () => {
        throw new Error('VMD 解析失败')
      }
    })
    driver.update(makeInput())
    await flushAsync()
    driver.update(makeInput())
    const snapshot = driver.getDebugSnapshot()
    expect(snapshot.source).toBe('procedural')
    const state = driver.getExternalState()
    expect(state.warnings.join('\n')).toContain('clip idle 加载失败')
    expect(state.loadedClipIds).toEqual([])
  })

  it('运行时异常（helper.update 抛错）→ 当帧回退 B3、记录 disabledReason、后续帧不再崩', async () => {
    const { driver, helper, b3, rig } = createDriverFixture()
    driver.update(makeInput())
    await flushAsync()
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')

    helper.failNextUpdate = true
    expect(() => driver.update(makeInput())).not.toThrow()
    const snapshot = driver.getDebugSnapshot()
    expect(snapshot.source).toBe('procedural')
    expect(b3.boneWriteEnabled).toBe(true)
    expect(rig.mesh.position.y).toBe(0) // mesh 原始 Y 恢复（不污染 PetScene 摆放）
    const state = driver.getExternalState()
    expect(state.disabledReason).not.toBeNull()
    expect(state.warnings.length).toBe(0) // manifest/clip 本身没错 → 只有运行时 disabledReason

    // 后续帧继续 B3，不再抛错
    expect(() => driver.update(makeInput())).not.toThrow()
    expect(driver.getDebugSnapshot().source).toBe('procedural')
  })

  it('setPose(非 auto) 暂停外部动作（便于截图 A/B），setPose("auto") 恢复 VMD', async () => {
    const { driver } = createDriverFixture()
    driver.update(makeInput())
    await flushAsync()
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')

    expect(driver.setPose('sit', 300)).toBe(true)
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('procedural')
    expect(driver.getExternalState().externalSuspended).toBe(true)

    expect(driver.setPose('auto')).toBe(true)
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')
    expect(driver.getExternalState().externalSuspended).toBe(false)
  })

  it('loop=false 的 clip 播完自动回退 B3，且同一 mood 不反复重播（mood 切走后可再触发）', async () => {
    const { driver, clock } = createDriverFixture({
      loadManifest: async () =>
        manifestWithClips([{ id: 'taunt', file: 'motion-taunt.vmd', moods: ['idle'], loop: false }]),
      loadClip: async (def: MotionClipDef) => makeClipInfo(def, 0.1) // 0.1s 一次性短 clip
    })
    driver.update(makeInput())
    await flushAsync()
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')

    // 假 helper 的 action.time 按 dt 推进；播完 0.1s 后回退（多跑几帧确保越过结束点）
    for (let frame = 0; frame < 10; frame += 1) {
      driver.update(makeInput())
      clock.ms += 1000 / 30
      if (driver.getDebugSnapshot().source === 'procedural') break
    }
    expect(driver.getDebugSnapshot().source).toBe('procedural')
    // 同一 mood 继续不重播
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('procedural')
    // mood 切走（sleep 无 clip）再切回 idle → 允许再次触发
    driver.update(makeInput({ mood: 'sleep' }))
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')
  })

  it('非法输入（dt=NaN / mood 缺失）不抛错、不产生 NaN 快照', async () => {
    const { driver } = createDriverFixture()
    driver.update(makeInput())
    await flushAsync()
    const weird = makeInput()
    ;(weird as { dt: number }).dt = Number.NaN
    ;(weird as { mood?: string }).mood = undefined
    expect(() => driver.update(weird)).not.toThrow()
    const snapshot = driver.getDebugSnapshot()
    // mood 缺失按 idle 处理（与 B3 sanitize 口径一致）→ idle clip 已就绪则仍可激活
    expect(snapshot.source).toBe('vmd')
    expect(Number.isNaN(snapshot.clipTimeSec ?? 0)).toBe(false)
  })

  it('externalEnabled=false → 纯 B3（不加载 manifest、快照 procedural）', async () => {
    let manifestLoaded = false
    const { driver } = createDriverFixture({
      externalEnabled: false,
      loadManifest: async () => {
        manifestLoaded = true
        return IDLE_MANIFEST
      }
    })
    await flushAsync()
    driver.update(makeInput())
    expect(manifestLoaded).toBe(false)
    expect(driver.getDebugSnapshot().source).toBe('procedural')
    expect(driver.getExternalState().externalEnabled).toBe(false)
  })

  it('clip 未就绪前先走 B3（不阻塞渲染），就绪后自动淡入激活', async () => {
    let resolveClip: ((info: VmdClipInfo) => void) | null = null
    const { driver, clock } = createDriverFixture({
      loadClip: (def) =>
        new Promise<VmdClipInfo>((resolve) => {
          resolveClip = () => resolve(makeClipInfo(def))
        })
    })
    driver.update(makeInput())
    await flushAsync() // manifest 就绪，clip 仍 pending
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('procedural')
    expect(driver.getExternalState().warnings).toEqual([])

    // 手动完成加载 → 下一帧自动激活
    expect(resolveClip).not.toBeNull()
    resolveClip!(makeClipInfo({ ...IDLE_DEF }))
    await flushAsync()
    clock.ms += 33
    driver.update(makeInput())
    expect(driver.getDebugSnapshot().source).toBe('vmd')
  })
})
