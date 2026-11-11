/**
 * V1 clip 播放链路单测 fixture（**合成数据，不读私有 assets**）。
 *
 * 提供：
 * - `makeClipJson()`：任意形状/帧数/grounding 的 clip JSON（nested / flat 两种轨道形状）；
 * - `yawQuat()` / `trackNested()` / `trackFlat()`：四元数/轨道小工具；
 * - `makeFakeAvatar()`：最小 three 场景 + fake `VrmAvatar`（normalized 骨节点直接就是 raw 节点，
 *   所以 `getWorldPosition()` 能真实反映骨骼旋转链；贴地/交叉淡入测试不需要 WebGL）。
 *
 * 只供电 clip-engine 的 `tests/vrm-clip-*.test.ts` 使用。
 */
import { Group, Object3D, Vector3 } from 'three'

import {
  CLIP_BONE_NAMES,
  UNITY_TO_VRM_BONE,
  type UnityHumanoidBone
} from '../../../src/renderer/src/vrm/humanoid-map'
import type { VrmAvatar } from '../../../src/renderer/src/vrm/runtime-types'

/* -------------------------------------------------------------------------- */
/* 四元数 / 轨道小工具                                                          */
/* -------------------------------------------------------------------------- */

/** 四元数 `[x,y,z,w]`。 */
export type FixtureQuat = [number, number, number, number]
/** 位移 `[x,y,z]`（米）。 */
export type FixtureVec3 = [number, number, number]

/** 单位四元数。 */
export function identityQuat(): FixtureQuat {
  return [0, 0, 0, 1]
}

/** 绕 Y 轴旋转 `deg` 度的四元数。 */
export function yawQuat(deg: number): FixtureQuat {
  const half = (deg * Math.PI) / 180 / 2
  return [0, Math.sin(half), 0, Math.cos(half)]
}

/** 绕 X 轴旋转 `deg` 度的四元数。 */
export function pitchQuat(deg: number): FixtureQuat {
  const half = (deg * Math.PI) / 180 / 2
  return [Math.sin(half), 0, 0, Math.cos(half)]
}

/** 单骨轨道输入（与 clip JSON 相同形状；`r` 支持 nested/flat）。 */
export interface FixtureBoneTrack {
  r: number[] | number[][]
  p?: number[] | number[][]
}

/** nested 形状轨道（`r = [[x,y,z,w],…]`）。 */
export function trackNested(
  quats: readonly FixtureQuat[],
  positions?: readonly FixtureVec3[]
): FixtureBoneTrack {
  const track: FixtureBoneTrack = { r: quats.map((quat) => [...quat] as FixtureQuat) }
  if (positions !== undefined) track.p = positions.map((position) => [...position] as FixtureVec3)
  return track
}

/** flat 形状轨道（`r = [x,y,z,w,…]`，历史文档口径）。 */
export function trackFlat(
  quats: readonly FixtureQuat[],
  positions?: readonly FixtureVec3[]
): FixtureBoneTrack {
  const track: FixtureBoneTrack = { r: quats.flatMap((quat) => [...quat]) }
  if (positions !== undefined) track.p = positions.flatMap((position) => [...position])
  return track
}

/* -------------------------------------------------------------------------- */
/* clip JSON 构造                                                              */
/* -------------------------------------------------------------------------- */

export interface MakeClipOptions {
  clip?: string
  fps?: number
  frames?: number
  loop?: boolean
  grounding?: 'feet' | 'none'
  sourceHipsHeight?: number
  sourceHeight?: number
  /** 是否写 `space` 字段（默认写 `gltf-rh`；传 undefined 可测缺失分支）。 */
  space?: string | null
  bones?: Record<string, FixtureBoneTrack>
  /** 覆盖任意顶层字段（测试坏数据用）。 */
  extra?: Record<string, unknown>
}

/** 默认骨骼集：Hips（含位移）+ 一根手臂（旋转）。 */
export function defaultFixtureBones(frames: number): Record<string, FixtureBoneTrack> {
  const identity = Array.from({ length: frames }, () => identityQuat())
  return {
    Hips: trackNested(
      identity,
      Array.from({ length: frames }, () => [0, 0, 0] as FixtureVec3)
    ),
    LeftUpperArm: trackNested(identity)
  }
}

/** 构造一个最小但合法的 clip JSON。 */
export function makeClipJson(options: MakeClipOptions = {}): Record<string, unknown> {
  const frames = options.frames ?? 2
  const fps = options.fps ?? 1
  const bones = options.bones ?? defaultFixtureBones(frames)
  const json: Record<string, unknown> = {
    version: 1,
    clip: options.clip ?? 'idle',
    loop: options.loop ?? true,
    fps,
    duration: frames / fps,
    frames,
    sourceHeight: options.sourceHeight ?? 1.7,
    sourceHipsHeight: options.sourceHipsHeight ?? 1,
    bones
  }
  if (options.space === null) {
    // 不写 space 字段（测「缺失按 gltf-rh」分支）
  } else {
    json.space = options.space ?? 'gltf-rh'
  }
  if (options.grounding !== undefined) json.grounding = options.grounding
  if (options.extra !== undefined) Object.assign(json, options.extra)
  return json
}

/* -------------------------------------------------------------------------- */
/* fake VrmAvatar                                                              */
/* -------------------------------------------------------------------------- */

/** fake humanoid 接口（只实现 player 用到的子集）。 */
export interface FakeHumanoid {
  getNormalizedBoneNode(name: string): Object3D | null
  getRawBoneNode(name: string): Object3D | null
  normalizedRestPose: Record<string, { rotation: number[]; position?: number[] }>
  update(): void
}

export interface FakeAvatarHandle {
  avatar: VrmAvatar
  scene: Group
  nodes: Map<string, Object3D>
  humanoid: FakeHumanoid
  /** `humanoid.update()` 调用次数（断言 player 是否负责同步）。 */
  updateCount(): number
  /** rest 姿势下最低脚骨的世界 y（相对 scene 局部坐标；贴地目标基准）。 */
  restMinFootLocalY: number
}

export interface MakeFakeAvatarOptions {
  /** 模拟目标模型缺失的 normalized 骨（VRM 名，如 `upperChest`）。 */
  missingVrmBones?: readonly string[]
  /** normalized rest hips 高度（米，默认 1）。 */
  hipsRestHeight?: number
}

/** 腿链局部偏移（foot 骨 joint 在 y=0.02 左右，模拟真实模型 bbox 脚底略低于骨点）。 */
const LEG_CHAIN: Readonly<Record<string, { parent: string; position: FixtureVec3 }>> = {
  leftUpperLeg: { parent: 'hips', position: [0.1, 0, 0] },
  leftLowerLeg: { parent: 'leftUpperLeg', position: [0, -0.45, 0] },
  leftFoot: { parent: 'leftLowerLeg', position: [0, -0.45, 0] },
  leftToes: { parent: 'leftFoot', position: [0, -0.08, 0.1] },
  rightUpperLeg: { parent: 'hips', position: [-0.1, 0, 0] },
  rightLowerLeg: { parent: 'rightUpperLeg', position: [0, -0.45, 0] },
  rightFoot: { parent: 'rightLowerLeg', position: [0, -0.45, 0] },
  rightToes: { parent: 'rightFoot', position: [0, -0.08, 0.1] }
}

/**
 * 构造 fake `VrmAvatar`：
 * - `scene` 下是 normalized humanoid 骨节点树（腿链有真实父子关系，脚骨世界 y 随旋转变化）；
 * - fake humanoid 的 normalized 节点 == raw 节点（`humanoid.update()` 只计数），
 *   因此 `getRawBoneNode('leftFoot').getWorldPosition()` 能真实反映姿势；
 * - 其余骨（头/手/手指…）平铺在 scene 下，只用于写 quaternion。
 */
export function makeFakeAvatar(options: MakeFakeAvatarOptions = {}): FakeAvatarHandle {
  const hipsRestHeight = options.hipsRestHeight ?? 1
  const missing = new Set(options.missingVrmBones ?? [])
  const scene = new Group()
  scene.name = 'fake-vrm-scene'
  const nodes = new Map<string, Object3D>()
  let humanoidUpdateCount = 0

  const createNode = (name: string, parent: Object3D, position: FixtureVec3): Object3D => {
    const node = new Object3D()
    node.name = name
    node.position.set(position[0], position[1], position[2])
    parent.add(node)
    nodes.set(name, node)
    return node
  }

  const allVrmNames = Array.from(
    new Set(CLIP_BONE_NAMES.map((unityBone) => UNITY_TO_VRM_BONE[unityBone]))
  )
  const hips = createNode('hips', scene, [0, hipsRestHeight, 0])
  const inLegChain = new Set(Object.keys(LEG_CHAIN))
  for (const [vrmName, chain] of Object.entries(LEG_CHAIN)) {
    if (missing.has(vrmName)) continue
    const parent = nodes.get(chain.parent) ?? hips
    createNode(vrmName, parent, chain.position)
  }
  for (const vrmName of allVrmNames) {
    if (vrmName === 'hips' || inLegChain.has(vrmName) || missing.has(vrmName)) continue
    createNode(vrmName, scene, [0, hipsRestHeight, 0])
  }

  const humanoid: FakeHumanoid = {
    getNormalizedBoneNode: (name: string) => nodes.get(name) ?? null,
    getRawBoneNode: (name: string) => nodes.get(name) ?? null,
    normalizedRestPose: {
      hips: { rotation: [0, 0, 0, 1], position: [0, hipsRestHeight, 0] }
    },
    update: () => {
      humanoidUpdateCount += 1
    }
  }

  scene.updateWorldMatrix(true, true)
  const tmpFootPosition = new Vector3()
  let restMinFootLocalY = Infinity
  for (const footName of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) {
    const node = nodes.get(footName)
    if (!node) continue
    node.getWorldPosition(tmpFootPosition)
    scene.worldToLocal(tmpFootPosition)
    restMinFootLocalY = Math.min(restMinFootLocalY, tmpFootPosition.y)
  }
  if (!Number.isFinite(restMinFootLocalY)) restMinFootLocalY = 0

  const avatar = {
    asset: {},
    vrm: { humanoid, update: () => {}, scene },
    scene,
    capabilities: {},
    restHeightMeters: 1.7,
    restFeetY: 0,
    bodyAspectRatio: 0.5,
    hipsRestHeight,
    materialNames: [],
    expressionNames: [],
    textureCount: 0,
    missingTextures: [],
    vertexCount: 0,
    triangleCount: 0,
    dispose: () => {}
  } as unknown as VrmAvatar

  return {
    avatar,
    scene,
    nodes,
    humanoid,
    updateCount: () => humanoidUpdateCount,
    restMinFootLocalY
  }
}
