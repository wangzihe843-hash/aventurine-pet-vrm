/**
 * V3 动作管线单测 fixture：**程序化**合成最小 VRM 1.0 骨架 + HSR 采样数据。
 * 不读私有 assets、不写文件（与 Wave 1.5 的 unity-bake fixtures 同风格）。
 */
import { HSR_TO_VRM_HUMANOID } from '../../../scripts/vrm/motion/lib/humanoid-hsr.mjs'

// @ts-expect-error -- 纯 ESM 无声明
import { qMul, qNormalize } from '../../../scripts/vrm/motion/lib/quat.mjs'

export interface Quat {
  [index: number]: number
}

export interface VrmNode {
  name: string
  translation: number[]
  children?: number[]
}

export interface SyntheticVrm {
  nodes: VrmNode[]
  extensions: { VRMC_vrm: { humanoid: { humanBones: Record<string, { node: number }> } } }
}

export const CORE_HUMANOID_POSITIONS: Record<string, [number, number, number]> = {
  hips: [0, 0.7, 0],
  spine: [0, 0.9, 0],
  chest: [0, 1.0, 0],
  upperChest: [0, 1.1, 0],
  neck: [0, 1.22, 0],
  head: [0, 1.3, 0],
  leftShoulder: [0.03, 1.16, 0],
  leftUpperArm: [0.16, 1.16, 0],
  leftLowerArm: [0.38, 1.16, 0],
  leftHand: [0.56, 1.16, 0],
  rightShoulder: [-0.03, 1.16, 0],
  rightUpperArm: [-0.16, 1.16, 0],
  rightLowerArm: [-0.38, 1.16, 0],
  rightHand: [-0.56, 1.16, 0],
  leftUpperLeg: [0.09, 0.68, 0],
  leftLowerLeg: [0.09, 0.38, 0],
  leftFoot: [0.09, 0.08, 0],
  leftToes: [0.09, 0.02, 0.1],
  rightUpperLeg: [-0.09, 0.68, 0],
  rightLowerLeg: [-0.09, 0.38, 0],
  rightFoot: [-0.09, 0.08, 0],
  rightToes: [-0.09, 0.02, 0.1]
}

const CHILDREN: Record<string, string[]> = {
  hips: ['spine', 'leftUpperLeg', 'rightUpperLeg'],
  spine: ['chest'],
  chest: ['upperChest'],
  upperChest: ['neck', 'leftShoulder', 'rightShoulder', '外衣_0_2'],
  neck: ['head'],
  head: ['後髪1-1'],
  leftShoulder: ['leftUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  leftLowerArm: ['leftHand'],
  rightShoulder: ['rightUpperArm'],
  rightUpperArm: ['rightLowerArm'],
  rightLowerArm: ['rightHand'],
  leftUpperLeg: ['leftLowerLeg'],
  leftLowerLeg: ['leftFoot'],
  leftFoot: ['leftToes'],
  rightUpperLeg: ['rightLowerLeg'],
  rightLowerLeg: ['rightFoot'],
  rightFoot: ['rightToes'],
  '後髪1-1': ['後髪1-2'],
  '外衣_0_2': ['外衣_1_2']
}

const EXTRA_POSITIONS: Record<string, [number, number, number]> = {
  '後髪1-1': [0.05, 1.33, -0.02],
  '後髪1-2': [0.06, 1.27, -0.03],
  外衣_0_2: [0.05, 1.05, -0.03],
  外衣_1_2: [0.05, 1.0, -0.05]
}

/**
 * 合成最小 VRM 1.0（22 核心 humanoid + 2 段头发链 + 2 段衣摆链）。
 * @param options.mirrorHsr 给 HSR 侧位置加 180° yaw（用于对齐测试）
 */
export function makeSyntheticVrm({ includeUpperChest = true }: { includeUpperChest?: boolean } = {}): SyntheticVrm {
  const nodes: VrmNode[] = []
  const indexOf = new Map<string, number>()
  /** 世界坐标（CORE_HUMANOID_POSITIONS 语义）；glTF 节点 translation 是相对父级的局部值。 */
  const worldOf = new Map<string, [number, number, number]>()
  const parentOf = new Map<string, string | null>()
  /** 可选 upperChest：目标缺 upperChest 时把它的子节点挂到 chest 下（模拟新 T-pose 戏浪）。 */
  const childrenMap: Record<string, string[]> = {}
  for (const [parentName, childNames] of Object.entries(CHILDREN)) {
    if (!includeUpperChest && parentName === 'upperChest') continue
    childrenMap[parentName] = childNames.slice()
  }
  if (!includeUpperChest) {
    childrenMap.chest = [...(CHILDREN.upperChest ?? [])]
  }
  for (const [parentName, childNames] of Object.entries(childrenMap)) {
    for (const childName of childNames) parentOf.set(childName, parentName)
  }
  const positions: Record<string, [number, number, number]> = { ...CORE_HUMANOID_POSITIONS, ...EXTRA_POSITIONS }
  if (!includeUpperChest) delete positions.upperChest
  for (const [name, position] of Object.entries(positions)) {
    worldOf.set(name, position)
    const parentName = parentOf.get(name) ?? null
    const parentWorld = parentName ? worldOf.get(parentName) : null
    if (parentName && !parentWorld) throw new Error(`fixture: 父级 ${parentName} 必须先于 ${name}`)
    const translation: [number, number, number] = parentWorld
      ? [position[0] - parentWorld[0], position[1] - parentWorld[1], position[2] - parentWorld[2]]
      : position.slice()
    indexOf.set(name, nodes.length)
    nodes.push({ name, translation })
  }
  for (const [parentName, childNames] of Object.entries(childrenMap)) {
    const parent = nodes[indexOf.get(parentName)!]
    if (!parent) continue
    parent.children = childNames.map((name) => indexOf.get(name)!)
  }
  const humanBones: Record<string, { node: number }> = {}
  for (const name of Object.keys(positions)) {
    if (!Object.prototype.hasOwnProperty.call(CORE_HUMANOID_POSITIONS, name)) continue
    humanBones[name] = { node: indexOf.get(name)! }
  }
  return {
    nodes,
    extensions: { VRMC_vrm: { humanoid: { humanBones } } }
  }
}

/** 把 VRM rest 位置镜像到 HSR armature 坐标（180° yaw），用于对齐测试。 */
export function mirrorPosition(position: [number, number, number]): [number, number, number] {
  return [-position[0], position[1], -position[2]]
}

export interface HsrSampleBone {
  quat: [number, number, number, number]
  head: [number, number, number]
  parent: string | null
}

export interface HsrClipData {
  f: number
  q: Record<string, [number, number, number, number]>
  h: Record<string, [number, number, number]>
}

export interface SyntheticHsrSamples {
  sourceFps: number
  fps: number
  sourceHeightMeters: number
  sourceHipsHeightMeters: number
  rest: Record<string, HsrSampleBone>
  children: Record<string, string[]>
  clips: Record<string, { action: string; srcFrames: [number, number]; frames: number; data: HsrClipData[] }>
}

/**
 * 合成 HSR 采样：
 * - rest 位置 = VRM 对应 humanoid 位置（或 180° 镜像，用于对齐测试）；
 * - 附加 HairFL_00/01_JNT、CoatL_a_00/01_JNT 次级骨；
 * - 每帧所有骨绕 Y 轴旋转 0/10/20°…（可预测），Hips 世界位置带 ±0.05m 竖向 bob 与水平位移。
 */
export function makeSyntheticHsrSamples({ mirrored = false, frames = 3, armDownDeg = 0 } = {}): SyntheticHsrSamples {
  const rest: Record<string, HsrSampleBone> = {}
  const children: Record<string, string[]> = {}
  const vrmToHsr = new Map<string, string>(Object.entries(HSR_TO_VRM_HUMANOID))
  const hsrParent = new Map<string, string>()
  for (const [parentVrm, childVrms] of Object.entries(CHILDREN)) {
    const parentHsr = vrmToHsr.get(parentVrm)
    if (!parentHsr) continue
    children[parentHsr] = children[parentHsr] ?? []
    for (const childVrm of childVrms) {
      const childHsr = vrmToHsr.get(childVrm)
      if (!childHsr) continue
      children[parentHsr].push(childHsr)
      hsrParent.set(childHsr, parentHsr)
    }
  }
  /** 把手臂链绕肩关节在 XY 平面旋转（模拟源侧 A-pose 下斜；目标保持 T-pose）。 */
  const rotateArmPoint = (position: [number, number, number], side: 'left' | 'right') => {
    if (!armDownDeg) return position
    const origin = side === 'left' ? CORE_HUMANOID_POSITIONS.leftUpperArm : CORE_HUMANOID_POSITIONS.rightUpperArm
    const sign = side === 'left' ? -1 : 1
    const angle = (armDownDeg * Math.PI) / 180 * sign
    const dx = position[0] - origin[0]
    const dy = position[1] - origin[1]
    return [origin[0] + dx * Math.cos(angle) - dy * Math.sin(angle), origin[1] + dx * Math.sin(angle) + dy * Math.cos(angle), position[2]]
  }
  // A-pose 差异只发生在肩关节以下（锁骨/肩点保持水平；与真实 HSR/VRM 的肩部 rest 方向差异 0° 一致）
  const ARM_BONES = new Set(['leftLowerArm', 'leftHand', 'rightLowerArm', 'rightHand'])
  for (const [vrmName, hsrName] of vrmToHsr) {
    const position = CORE_HUMANOID_POSITIONS[vrmName]
    if (!position) continue
    const posed = ARM_BONES.has(vrmName)
      ? rotateArmPoint(position, vrmName.startsWith('left') ? 'left' : 'right')
      : position
    const head = mirrored ? mirrorPosition(posed) : posed
    rest[hsrName] = { quat: [0, 0, 0, 1], head, parent: hsrParent.get(hsrName) ?? null }
  }
  const extra: Record<string, { head: [number, number, number]; parent: string }> = {
    HairFL_00_JNT: { head: EXTRA_POSITIONS['後髪1-1'], parent: 'Head_M' },
    HairFL_01_JNT: { head: EXTRA_POSITIONS['後髪1-2'], parent: 'HairFL_00_JNT' },
    CoatL_a_00_JNT: { head: EXTRA_POSITIONS['外衣_0_2'], parent: 'Chest_M' },
    CoatL_a_01_JNT: { head: EXTRA_POSITIONS['外衣_1_2'], parent: 'CoatL_a_00_JNT' }
  }
  for (const [name, info] of Object.entries(extra)) {
    rest[name] = { quat: [0, 0, 0, 1], head: mirrored ? mirrorPosition(info.head) : info.head, parent: info.parent }
    children[name] = []
    children[info.parent] = children[info.parent] ?? []
    children[info.parent].push(name)
  }

  const data: HsrClipData[] = []
  const hipsRest = rest.Root_M.head
  for (let frame = 0; frame < frames; frame += 1) {
    const angle = (frame * 10 * Math.PI) / 180
    const rotation: [number, number, number, number] = [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]
    const q: Record<string, [number, number, number, number]> = {}
    const h: Record<string, [number, number, number]> = {}
    for (const bone of Object.keys(rest)) {
      q[bone] = rotation
      h[bone] = rest[bone].head.slice() as [number, number, number]
    }
    // Hips：水平漂移 0.2m + 竖向 bob 0.05m（用于 in-place/grounding 测试）
    h.Root_M = [hipsRest[0] + frame * 0.1, hipsRest[1] + frame * 0.025, hipsRest[2] + frame * 0.05]
    data.push({ f: 1 + frame * 2, q, h })
  }
  return {
    sourceFps: 60,
    fps: 30,
    sourceHeightMeters: 1.7,
    sourceHipsHeightMeters: 0.95,
    rest,
    children,
    clips: {
      test: { action: 'test-clip', srcFrames: [1, 1 + (frames - 1) * 2], frames, data }
    }
  }
}

/** 构造 clipDef。 */
export function makeClipDef(overrides: Record<string, unknown> = {}) {
  return { id: 'test', loop: true, slot: 'idle', grounding: 'feet', ...overrides }
}

/** 复合旋转（用于断言）。 */
export function composeQuat(quats: number[][]): number[] {
  let result = [0, 0, 0, 1]
  for (const quat of quats) result = qMul(result, quat)
  return qNormalize(result)
}

/** 绕 Y 轴旋转角（度）。 */
export function yawQuat(degrees: number): [number, number, number, number] {
  const half = (degrees * Math.PI) / 180 / 2
  return [0, Math.sin(half), 0, Math.cos(half)]
}
