/**
 * V3.1 合成 Biped 夹具：**程序化**生成「目标 VRM 类 T-pose 骨架 + 标准 3ds Max Biped 骨名/层级
 * + 可预测动画」的采样数据（`samples.json` schema 与 `extract-hsr-anims.py` 一致）。
 *
 * 用途：
 * - `tests/vrm-motion-biped.test.ts`（映射/对齐/rest 修正/grounding/数值断言，不读私有 assets）；
 * - `work/adv-biped/retarget/make-synthetic-samples.mjs`（真实 FBX 未到时跑 `retarget-adv.mjs` 的
 *   端到端链路：samples.json → retarget → clip JSON → grade）。
 *
 * 约定（与 HSR 采样一致）：
 * - 源骨架 Y-up、面向 +Z、左手 +X（与目标 VRM 同向 → 未镜像时 R_align=identity）；
 * - Biped 骨名 `Bip001 Pelvis / Spine / Spine1 / Spine2 / Neck / Head / L|R Clavicle / UpperArm /
 *   Forearm / Hand / Thigh / Calf / Foot / Toe0 / Finger0..4（各 3 节）` + `Bip001` COM / Footsteps /
 *   `*Nub`（验证 ignored 命名）；
 * - 所有 rest 骨四元数 = identity（骨骼局部轴 = 世界轴）；采样帧的 `q[bone]` 直接就是该骨的
 *   **armature-space 世界旋转**（world delta = q · rest⁻¹ = q）；
 * - 帧数据 `f` 用源帧号；`srcFrames`/`frames` 满足 `retarget.mjs` 的 loop 约定
 *   （loop 不重复末帧；非 loop 含末帧）。
 */
import { qMul, qInvert } from '../../../scripts/vrm/motion/lib/quat.mjs'

/** 目标 VRM 类骨架的 rest 世界位置（米；取自 aventurine-tpose.vrm 的 humanoid 相对几何，缩放到 hips=1.0661）。 */
export const VRM_REST_POSITIONS = Object.freeze({
  hips: [0, 1.0661, -0.0056],
  spine: [0, 1.0797, -0.0056],
  chest: [0, 1.2612, -0.0056],
  neck: [0, 1.4653, -0.0476],
  head: [0, 1.5391, -0.0432],
  leftShoulder: [0.0357, 1.3955, -0.0461],
  leftUpperArm: [0.1587, 1.3875, -0.0495],
  leftLowerArm: [0.3894, 1.3875, -0.0495],
  leftHand: [0.6022, 1.3875, -0.0495],
  rightShoulder: [-0.0357, 1.3955, -0.0461],
  rightUpperArm: [-0.1587, 1.3875, -0.0495],
  rightLowerArm: [-0.3894, 1.3875, -0.0495],
  rightHand: [-0.6022, 1.3875, -0.0495],
  leftUpperLeg: [0.0754, 0.9784, -0.0056],
  leftLowerLeg: [0.0837, 0.5426, -0.0069],
  leftFoot: [0.092, 0.0983, -0.0403],
  leftToes: [0.0941, 0.052, 0.09],
  rightUpperLeg: [-0.0754, 0.9784, -0.0056],
  rightLowerLeg: [-0.0837, 0.5426, -0.0069],
  rightFoot: [-0.092, 0.0983, -0.0403],
  rightToes: [-0.0941, 0.052, 0.09],
  leftMiddleProximal: [0.6824, 1.3875, -0.0495],
  leftMiddleIntermediate: [0.7264, 1.3875, -0.0495],
  leftMiddleDistal: [0.7563, 1.3877, -0.0496],
  leftIndexProximal: [0.6853, 1.3837, -0.0288],
  leftIndexIntermediate: [0.7238, 1.3837, -0.0288],
  leftIndexDistal: [0.753, 1.3837, -0.0288],
  leftThumbMetacarpal: [0.6222, 1.3676, -0.033],
  leftThumbProximal: [0.6462, 1.3676, -0.009],
  leftThumbDistal: [0.6654, 1.3676, 0.0102],
  leftRingProximal: [0.6806, 1.3878, -0.0682],
  leftRingIntermediate: [0.7214, 1.3878, -0.0682],
  leftRingDistal: [0.7484, 1.3878, -0.0682],
  leftLittleProximal: [0.6786, 1.3831, -0.0855],
  leftLittleIntermediate: [0.7089, 1.3831, -0.0855],
  leftLittleDistal: [0.7303, 1.3831, -0.0855],
  rightMiddleProximal: [-0.6824, 1.3875, -0.0495],
  rightMiddleIntermediate: [-0.7264, 1.3875, -0.0495],
  rightMiddleDistal: [-0.7563, 1.3877, -0.0496],
  rightIndexProximal: [-0.6853, 1.3837, -0.0288],
  rightIndexIntermediate: [-0.7238, 1.3837, -0.0288],
  rightIndexDistal: [-0.753, 1.3837, -0.0288],
  rightThumbMetacarpal: [-0.6222, 1.3676, -0.033],
  rightThumbProximal: [-0.6462, 1.3676, -0.009],
  rightThumbDistal: [-0.6654, 1.3676, 0.0102],
  rightRingProximal: [-0.6806, 1.3878, -0.0682],
  rightRingIntermediate: [-0.7214, 1.3878, -0.0682],
  rightRingDistal: [-0.7484, 1.3878, -0.0682],
  rightLittleProximal: [-0.6786, 1.3831, -0.0855],
  rightLittleIntermediate: [-0.7089, 1.3831, -0.0855],
  rightLittleDistal: [-0.7303, 1.3831, -0.0855]
})

/** 合成 VRM 的 normalized 父子关系（默认无 upperChest，= 新 T-pose 戏浪）。 */
const VRM_CHILDREN = Object.freeze({
  hips: ['spine', 'leftUpperLeg', 'rightUpperLeg'],
  spine: ['chest'],
  chest: ['neck', 'leftShoulder', 'rightShoulder'],
  neck: ['head'],
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
  leftHand: [
    'leftThumbMetacarpal',
    'leftIndexProximal',
    'leftMiddleProximal',
    'leftRingProximal',
    'leftLittleProximal'
  ],
  rightHand: [
    'rightThumbMetacarpal',
    'rightIndexProximal',
    'rightMiddleProximal',
    'rightRingProximal',
    'rightLittleProximal'
  ],
  leftThumbMetacarpal: ['leftThumbProximal'],
  leftThumbProximal: ['leftThumbDistal'],
  leftIndexProximal: ['leftIndexIntermediate'],
  leftIndexIntermediate: ['leftIndexDistal'],
  leftMiddleProximal: ['leftMiddleIntermediate'],
  leftMiddleIntermediate: ['leftMiddleDistal'],
  leftRingProximal: ['leftRingIntermediate'],
  leftRingIntermediate: ['leftRingDistal'],
  leftLittleProximal: ['leftLittleIntermediate'],
  leftLittleIntermediate: ['leftLittleDistal'],
  rightThumbMetacarpal: ['rightThumbProximal'],
  rightThumbProximal: ['rightThumbDistal'],
  rightIndexProximal: ['rightIndexIntermediate'],
  rightIndexIntermediate: ['rightIndexDistal'],
  rightMiddleProximal: ['rightMiddleIntermediate'],
  rightMiddleIntermediate: ['rightMiddleDistal'],
  rightRingProximal: ['rightRingIntermediate'],
  rightRingIntermediate: ['rightRingDistal'],
  rightLittleProximal: ['rightLittleIntermediate'],
  rightLittleIntermediate: ['rightLittleDistal']
})

function scaleVec(vec, scale) {
  return [vec[0] * scale, vec[1] * scale, vec[2] * scale]
}

function midVec(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}

/**
 * 合成目标 VRM（glTF-like）：53 humanoid 骨语义（无眼睛），默认 **无 upperChest**；
 * includeUpperChest=true 时插入 upperChest（模拟旧 legfix 资产，测试 target-aware 映射）。
 */
export function makeSyntheticBipedVrm({ includeUpperChest = false, withFingers = true } = {}) {
  const positions = {}
  for (const [name, position] of Object.entries(VRM_REST_POSITIONS)) {
    if (!withFingers && /Thumb|Index|Middle|Ring|Little/.test(name)) continue
    positions[name] = position.slice()
  }
  if (includeUpperChest) {
    positions.upperChest = midVec(VRM_REST_POSITIONS.chest, VRM_REST_POSITIONS.neck)
  }
  const childrenMap = {}
  for (const [parent, children] of Object.entries(VRM_CHILDREN)) {
    const kept = children.filter((child) => positions[child])
    if (kept.length > 0) childrenMap[parent] = kept
  }
  if (includeUpperChest) {
    // chest → upperChest → neck/shoulders
    childrenMap.chest = ['upperChest']
    childrenMap.upperChest = ['neck', 'leftShoulder', 'rightShoulder']
  }
  for (const child of Object.values(childrenMap).flat()) {
    if (!positions[child]) throw new Error(`biped fixture: 子节点 ${child} 缺位置`)
  }
  const parentOf = new Map()
  for (const [parent, children] of Object.entries(childrenMap)) {
    for (const child of children) parentOf.set(child, parent)
  }
  const nodes = []
  const indexOf = new Map()
  for (const name of Object.keys(positions)) {
    const parent = parentOf.get(name) ?? null
    const world = positions[name]
    const parentWorld = parent ? positions[parent] : null
    if (parent && !parentWorld) throw new Error(`biped fixture: 父节点 ${parent} 必须先于 ${name}`)
    indexOf.set(name, nodes.length)
    nodes.push({
      name,
      translation: parentWorld ? [world[0] - parentWorld[0], world[1] - parentWorld[1], world[2] - parentWorld[2]] : world.slice()
    })
  }
  for (const [parent, children] of Object.entries(childrenMap)) {
    const node = nodes[indexOf.get(parent)]
    node.children = children.map((child) => indexOf.get(child))
  }
  const humanBones = {}
  for (const name of Object.keys(positions)) humanBones[name] = { node: indexOf.get(name) }
  return {
    nodes,
    extensions: { VRMC_vrm: { humanoid: { humanBones } } },
    __worldPositions: positions
  }
}

/**
 * Biped 源骨名 ← VRM humanoid 名（合成夹具的语义表；与 lib/humanoid-biped.mjs 的期望一致：
 * Finger0=拇指、Finger1=食指…；Biped 三节脊柱 Spine/Spine1/Spine2 ↔ 目标 spine/chest）。
 */
export const BIPED_NAME_BY_VRM = Object.freeze({
  hips: 'Bip001 Pelvis',
  spine: 'Bip001 Spine',
  chest: 'Bip001 Spine2',
  neck: 'Bip001 Neck',
  head: 'Bip001 Head',
  leftShoulder: 'Bip001 L Clavicle',
  leftUpperArm: 'Bip001 L UpperArm',
  leftLowerArm: 'Bip001 L Forearm',
  leftHand: 'Bip001 L Hand',
  rightShoulder: 'Bip001 R Clavicle',
  rightUpperArm: 'Bip001 R UpperArm',
  rightLowerArm: 'Bip001 R Forearm',
  rightHand: 'Bip001 R Hand',
  leftUpperLeg: 'Bip001 L Thigh',
  leftLowerLeg: 'Bip001 L Calf',
  leftFoot: 'Bip001 L Foot',
  leftToes: 'Bip001 L Toe0',
  rightUpperLeg: 'Bip001 R Thigh',
  rightLowerLeg: 'Bip001 R Calf',
  rightFoot: 'Bip001 R Foot',
  rightToes: 'Bip001 R Toe0',
  leftThumbMetacarpal: 'Bip001 L Finger0',
  leftThumbProximal: 'Bip001 L Finger01',
  leftThumbDistal: 'Bip001 L Finger02',
  leftIndexProximal: 'Bip001 L Finger1',
  leftIndexIntermediate: 'Bip001 L Finger11',
  leftIndexDistal: 'Bip001 L Finger12',
  leftMiddleProximal: 'Bip001 L Finger2',
  leftMiddleIntermediate: 'Bip001 L Finger21',
  leftMiddleDistal: 'Bip001 L Finger22',
  leftRingProximal: 'Bip001 L Finger3',
  leftRingIntermediate: 'Bip001 L Finger31',
  leftRingDistal: 'Bip001 L Finger32',
  leftLittleProximal: 'Bip001 L Finger4',
  leftLittleIntermediate: 'Bip001 L Finger41',
  leftLittleDistal: 'Bip001 L Finger42',
  rightThumbMetacarpal: 'Bip001 R Finger0',
  rightThumbProximal: 'Bip001 R Finger01',
  rightThumbDistal: 'Bip001 R Finger02',
  rightIndexProximal: 'Bip001 R Finger1',
  rightIndexIntermediate: 'Bip001 R Finger11',
  rightIndexDistal: 'Bip001 R Finger12',
  rightMiddleProximal: 'Bip001 R Finger2',
  rightMiddleIntermediate: 'Bip001 R Finger21',
  rightMiddleDistal: 'Bip001 R Finger22',
  rightRingProximal: 'Bip001 R Finger3',
  rightRingIntermediate: 'Bip001 R Finger31',
  rightRingDistal: 'Bip001 R Finger32',
  rightLittleProximal: 'Bip001 R Finger4',
  rightLittleIntermediate: 'Bip001 R Finger41',
  rightLittleDistal: 'Bip001 R Finger42'
})

/** Biped 源骨父级（标准 Biped 层级；spine1 是中间节，测试「并入 chest」）。 */
function bipedParentOf(bipedName) {
  const map = {
    'Bip001 Pelvis': 'Bip001',
    'Bip001 Spine': 'Bip001 Pelvis',
    'Bip001 Spine1': 'Bip001 Spine',
    'Bip001 Spine2': 'Bip001 Spine1',
    'Bip001 Neck': 'Bip001 Spine2',
    'Bip001 Head': 'Bip001 Neck',
    'Bip001 HeadNub': 'Bip001 Head'
  }
  if (map[bipedName]) return map[bipedName]
  const m = bipedName.match(/^Bip001 ([LR]) (\w+?)(\d*)(Nub)?$/)
  if (!m) return null
  const [, side, base, digits, nub] = m
  if (nub) {
    const stem = `${base}${digits}`
    return `Bip001 ${side} ${stem}`
  }
  if (base === 'Clavicle') return 'Bip001 Spine2'
  if (base === 'UpperArm') return `Bip001 ${side} Clavicle`
  if (base === 'Forearm') return `Bip001 ${side} UpperArm`
  if (base === 'Hand') return `Bip001 ${side} Forearm`
  if (base === 'Thigh') return 'Bip001 Pelvis'
  if (base === 'Calf') return `Bip001 ${side} Thigh`
  if (base === 'Foot') return `Bip001 ${side} Calf`
  if (base === 'Toe') return `Bip001 ${side} Foot`
  const finger = bipedName.match(/^Bip001 ([LR]) Finger(\d)(?:(\d))?$/)
  if (finger) {
    const [, fside, chain, linkDigit] = finger
    const link = linkDigit ? Number(linkDigit) : 0
    if (link === 0) return `Bip001 ${fside} Hand`
    return `Bip001 ${fside} Finger${chain}${link === 1 ? '' : '1'}`
  }
  return null
}

/**
 * 合成 Biped 源 rest 骨架。
 *
 * @param {{
 *   scale?: number,           // 整体缩放（模拟 Biped/单位差异；默认 0.9 → sourceHips≈0.96m）
 *   mirrored?: boolean,       // 180° yaw（对齐测试）
 *   armDownDeg?: number,      // 源 A-pose（上臂下斜；rest 方向修正测试）
 *   includeExtraBones?: boolean // Biped COM/Footsteps/Nub 等（默认 true，验证 ignored）
 * }} options
 */
export function makeSyntheticBipedRest({ scale = 0.9, mirrored = false, armDownDeg = 0, includeExtraBones = true } = {}) {
  /** @type {Record<string, { quat: number[], head: number[], parent: string | null }>} */
  const rest = {}
  const children = {}
  const positions = {}
  const vrmToBiped = new Map(Object.entries(BIPED_NAME_BY_VRM))
  const bipedToVrm = new Map(Object.entries(BIPED_NAME_BY_VRM).map(([vrm, biped]) => [biped, vrm]))

  const rotateArmPoint = (position, side) => {
    if (!armDownDeg) return position
    const originVrm = side === 'left' ? 'leftUpperArm' : 'rightUpperArm'
    const origin = VRM_REST_POSITIONS[originVrm]
    const sign = side === 'left' ? -1 : 1
    const angle = ((armDownDeg * Math.PI) / 180) * sign
    const dx = position[0] - origin[0]
    const dy = position[1] - origin[1]
    return [origin[0] + dx * Math.cos(angle) - dy * Math.sin(angle), origin[1] + dx * Math.sin(angle) + dy * Math.cos(angle), position[2]]
  }

  for (const [vrmName, bipedName] of vrmToBiped) {
    const base = VRM_REST_POSITIONS[vrmName]
    if (!base) continue
    const isArmBelowShoulder = /^(left|right)(UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(vrmName)
    const posed = isArmBelowShoulder ? rotateArmPoint(base, vrmName.startsWith('left') ? 'left' : 'right') : base
    const scaled = scaleVec(posed, scale)
    const head = mirrored ? [-scaled[0], scaled[1], -scaled[2]] : scaled
    positions[bipedName] = head
    rest[bipedName] = { quat: [0, 0, 0, 1], head, parent: bipedParentOf(bipedName) }
    children[bipedName] = []
  }
  // 中间脊柱节（Spine1 放在 spine 与 chest 之间；仅用于验证「并入 chest」语义）
  const bipedSpine = BIPED_NAME_BY_VRM.spine
  const bipedChest = BIPED_NAME_BY_VRM.chest
  const spinePos = positions[bipedSpine]
  const chestPos = positions[bipedChest]
  const spine1Pos = midVec(spinePos, chestPos)
  const spine1Mirrored = mirrored ? [-spine1Pos[0], spine1Pos[1], -spine1Pos[2]] : spine1Pos
  rest['Bip001 Spine1'] = { quat: [0, 0, 0, 1], head: spine1Mirrored, parent: bipedSpine }
  children['Bip001 Spine1'] = [bipedChest]
  children[bipedSpine] = ['Bip001 Spine1']

  if (includeExtraBones) {
    const extras = {
      Bip001: { head: [0, 0, 0], parent: null },
      'Bip001 Footsteps': { head: [0, 0, 0], parent: 'Bip001' },
      'Bip001 HeadNub': { head: [positions['Bip001 Head'][0], positions['Bip001 Head'][1] + 0.02 * scale, positions['Bip001 Head'][2]], parent: 'Bip001 Head' },
      'Bip001 L Toe0Nub': { head: [positions['Bip001 L Toe0'][0], positions['Bip001 L Toe0'][1], positions['Bip001 L Toe0'][2] + 0.02 * scale], parent: 'Bip001 L Toe0' },
      'Bip001 R Toe0Nub': { head: [positions['Bip001 R Toe0'][0], positions['Bip001 R Toe0'][1], positions['Bip001 R Toe0'][2] + 0.02 * scale], parent: 'Bip001 R Toe0' },
      'Bip001 L Finger0Nub': { head: positions['Bip001 L Finger02'], parent: 'Bip001 L Finger02' },
      'Bip001 R Finger0Nub': { head: positions['Bip001 R Finger02'], parent: 'Bip001 R Finger02' }
    }
    const fixedParents = {
      'Bip001 Pelvis': 'Bip001',
      'Bip001 Spine': 'Bip001 Pelvis'
    }
    for (const [name, info] of Object.entries(extras)) {
      const head = mirrored ? [-info.head[0], info.head[1], -info.head[2]] : info.head
      rest[name] = { quat: [0, 0, 0, 1], head, parent: info.parent }
      children[name] = []
    }
    for (const [name, parent] of Object.entries(fixedParents)) {
      rest[name].parent = parent
      children[parent].push(name)
    }
    children['Bip001 Head'].push('Bip001 HeadNub')
    children['Bip001 L Toe0'].push('Bip001 L Toe0Nub')
    children['Bip001 R Toe0'].push('Bip001 R Toe0Nub')
    children['Bip001 L Finger02'].push('Bip001 L Finger0Nub')
    children['Bip001 R Finger02'].push('Bip001 R Finger0Nub')
    // 修复中间脊柱节的父链（Spine1 的 parent 已设置；把 Spine1 挂到 Spine 下已在上面处理）
  }
  // children 重建（避免手写遗漏）：按 parent 字段统一生成
  for (const name of Object.keys(rest)) children[name] = []
  for (const [name, info] of Object.entries(rest)) {
    if (info.parent && children[info.parent]) children[info.parent].push(name)
  }
  const pelvisName = BIPED_NAME_BY_VRM.hips
  const sourceHipsHeightMeters = rest[pelvisName].head[1]
  return { rest, children, positions, scale, mirrored, sourceHipsHeightMeters }
}

/** 世界旋转四元数（轴角；axis 为单位轴）。 */
export function axisAngleQuat(axis, degrees) {
  const half = (degrees * Math.PI) / 180 / 2
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1
  return [(axis[0] / length) * Math.sin(half), (axis[1] / length) * Math.sin(half), (axis[2] / length) * Math.sin(half), Math.cos(half)]
}

const Y_AXIS = [0, 1, 0]
const X_AXIS = [1, 0, 0]
const Z_AXIS = [0, 0, 1]

/** 180° yaw 四元数（镜像源坐标系用）。 */
const YAW_180 = [0, 1, 0, 0]

function conjugateQuat(q, frameQuat) {
  return qMul(qMul(frameQuat, q), qInvert(frameQuat))
}

/**
 * 构造一条合成 clip（采样帧）。`poseFn(frameIndex)` 返回 `{ [bipedBone]: worldQuat }` 覆盖；
 * `hipsOffsetFn(frameIndex)` 返回 hips 世界位移（米，源坐标）。
 *
 * @param {{
 *   id: string, frames: number, loop: boolean, takeName?: string,
 *   poseFn?: (frame: number, frames: number) => Record<string, number[]>,
 *   hipsOffsetFn?: (frame: number, frames: number) => number[],
 *   rest: Record<string, { quat: number[], head: number[] }>,
 *   scale?: number, mirrored?: boolean, sourceFps?: number, fps?: number
 * }} args
 */
export function makeBipedClip({
  id,
  frames,
  loop,
  takeName = null,
  poseFn = () => ({}),
  hipsOffsetFn = () => [0, 0, 0],
  rest,
  scale = 0.9,
  mirrored = false,
  sourceFps = 30,
  fps = 30
}) {
  const step = Math.round(sourceFps / fps)
  const dataFrames = loop ? frames + 1 : frames
  const data = []
  const pelvisName = BIPED_NAME_BY_VRM.hips
  const pelvisRest = rest[pelvisName].head
  for (let index = 0; index < dataFrames; index += 1) {
    const overrides = poseFn(index, dataFrames) ?? {}
    const q = {}
    for (const name of Object.keys(rest)) q[name] = [0, 0, 0, 1]
    for (const [name, quat] of Object.entries(overrides)) {
      if (!rest[name]) throw new Error(`makeBipedClip(${id}): 未知骨 ${name}`)
      q[name] = mirrored ? conjugateQuat(quat, YAW_180) : quat.slice()
    }
    const h = {}
    for (const name of Object.keys(rest)) h[name] = rest[name].head.slice()
    const offset = hipsOffsetFn(index, dataFrames) ?? [0, 0, 0]
    const offsetMirrored = mirrored ? [-offset[0], offset[1], -offset[2]] : offset
    h[pelvisName] = [pelvisRest[0] + offsetMirrored[0], pelvisRest[1] + offsetMirrored[1], pelvisRest[2] + offsetMirrored[2]]
    data.push({ f: 1 + index * step, q, h })
  }
  const lastF = data[data.length - 1].f
  return {
    action: takeName ?? id,
    takeMatch: takeName ?? id,
    srcFrames: [1, lastF],
    frames: data.length,
    data
  }
}

/**
 * 合成 Biped 采样集合：rest + children + 几条可预测动画。
 * - idle：左臂绕肩刚性抬起（每帧 +10°，绕 Z 轴）+ hips 竖向 bob / 水平漂移（in-place 测试）；
 * - walk：双腿交替前后摆（绕 X 轴 ±20°）+ 脚保持世界水平；
 * - fingers：手指各链绕 Z 轴逐节弯曲（每节 -10° 世界增量 → 局部 -10°）；
 * - torso：脊柱/胸/颈/头逐节 yaw（每节 +10° 世界增量，验证 Spine1 并入 chest）；
 * - ground：双脚绕 X 轴抬起 20°（grounding 测试）。
 *
 * @param {{ scale?: number, mirrored?: boolean, armDownDeg?: number, frames?: number, sourceFps?: number, fps?: number }} options
 */
export function makeSyntheticBipedSamples({ scale = 0.9, mirrored = false, armDownDeg = 0, frames = 5, sourceFps = 30, fps = 30 } = {}) {
  const fixture = makeSyntheticBipedRest({ scale, mirrored, armDownDeg })
  const { rest, children, sourceHipsHeightMeters } = fixture
  const biped = BIPED_NAME_BY_VRM
  const liftArm = (side, degrees) => {
    // 上臂沿 ±X；绕 Z 轴旋转使 +X 侧手臂向上（左臂 +X：+a 向上；右臂 -X：-a 向上）
    const sign = side === 'left' ? 1 : -1
    return axisAngleQuat(Z_AXIS, degrees * sign)
  }
  const rotateX = (degrees) => axisAngleQuat(X_AXIS, degrees)
  const rotateY = (degrees) => axisAngleQuat(Y_AXIS, degrees)

  const clips = {}
  // ---- idle：手臂抬起 + hips bob/漂移 ----
  clips.idle = makeBipedClip({
    id: 'idle',
    frames,
    loop: true,
    takeName: 'StandBy',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const angle = frame * 10
      return {
        [biped.leftUpperArm]: liftArm('left', angle),
        [biped.leftLowerArm]: liftArm('left', angle),
        [biped.leftHand]: liftArm('left', angle),
        [biped.rightUpperArm]: liftArm('right', angle / 2),
        [biped.rightLowerArm]: liftArm('right', angle / 2),
        [biped.rightHand]: liftArm('right', angle / 2)
      }
    },
    hipsOffsetFn: (frame) => [frame * 0.01, frame * 0.005, 0]
  })
  // ---- walk：双腿交替摆 + 脚保持世界水平 ----
  clips.walk = makeBipedClip({
    id: 'walk',
    frames,
    loop: true,
    takeName: 'Walk',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const swing = Math.sin((frame / frames) * Math.PI * 2) * 20
      return {
        [biped.leftUpperLeg]: rotateX(-swing),
        [biped.rightUpperLeg]: rotateX(swing),
        [biped.leftLowerLeg]: rotateX(-swing),
        [biped.rightLowerLeg]: rotateX(swing),
        [biped.leftFoot]: [0, 0, 0, 1],
        [biped.rightFoot]: [0, 0, 0, 1]
      }
    }
  })
  // ---- fingers：四条长指 + 拇指逐节弯曲 ----
  const fingerChains = [
    ['leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal'],
    ['leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'],
    ['leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal'],
    ['leftRingProximal', 'leftRingIntermediate', 'leftRingDistal'],
    ['leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'],
    ['rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal'],
    ['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal'],
    ['rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal'],
    ['rightRingProximal', 'rightRingIntermediate', 'rightRingDistal'],
    ['rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal']
  ]
  clips.fingers = makeBipedClip({
    id: 'fingers',
    frames,
    loop: true,
    takeName: 'FingerCurl',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const overrides = {}
      const bend = (frame / Math.max(1, frames - 1)) * 30
      for (const chain of fingerChains) {
        chain.forEach((vrmName, link) => {
          overrides[biped[vrmName]] = rotateX(-bend * (link + 1))
        })
      }
      return overrides
    }
  })
  // ---- torso：脊柱三节/胸/颈/头 yaw（验证 Spine1 世界旋转并入 chest 的绝对旋转） ----
  clips.torso = makeBipedClip({
    id: 'torso',
    frames,
    loop: true,
    takeName: 'TorsoTwist',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const step = frame * 10
      return {
        [biped.hips]: rotateY(step * 0.5), // 5°/帧
        [biped.spine]: rotateY(step), // Spine 世界 10°/帧 → 映射 spine
        'Bip001 Spine1': rotateY(step * 2), // 中间节 20°/帧（应并入 chest）
        [biped.chest]: rotateY(step * 4), // Spine2 世界 40°/帧 → 映射 chest
        [biped.neck]: rotateY(step * 4.5),
        [biped.head]: rotateY(step * 5)
      }
    }
  })
  // ---- ground：双脚同时抬起（grounding 应补偿 hips 竖直位置） ----
  clips.ground = makeBipedClip({
    id: 'ground',
    frames,
    loop: false,
    takeName: 'FootLift',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const angle = frame * 5
      return {
        [biped.leftFoot]: rotateX(-angle),
        [biped.rightFoot]: rotateX(-angle),
        [biped.leftToes]: rotateX(-angle),
        [biped.rightToes]: rotateX(-angle)
      }
    }
  })
  return {
    schemaVersion: 1,
    sourceFps,
    fps,
    sourceHeightMeters: 1.73 * scale,
    sourceHipsHeightMeters,
    rest,
    children,
    clips
  }
}

/**
 * 合成 Biped 采样（**循环友好版**）：所有循环 clip 的末帧→首帧接缝 ≈0（用正弦相位，
 * 便于跑 `retarget-adv.mjs` 端到端后 QA 门禁 PASS/WARN 而非 FAIL），额外包含非 loop 的
 * `skill01`（一次性动作）与 `ground`（hips bob + 双脚贴地 → grounding 测试）。
 *
 * 键名 = clip id（= clips.synthetic.json 的 id），take 名 = 真实 .max 文件名风格。
 */
export function makeLoopFriendlyBipedSamples({ frames = 30, scale = 0.9, mirrored = false, armDownDeg = 0, sourceFps = 30, fps = 30 } = {}) {
  const fixture = makeSyntheticBipedRest({ scale, mirrored, armDownDeg })
  const { rest, children, sourceHipsHeightMeters } = fixture
  const biped = BIPED_NAME_BY_VRM
  const sine = (frame, amplitudeDeg, phase = 0) => Math.sin((2 * Math.PI * frame) / frames + phase) * amplitudeDeg
  const z = (deg) => axisAngleQuat([0, 0, 1], deg)
  const x = (deg) => axisAngleQuat([1, 0, 0], deg)
  const y = (deg) => axisAngleQuat([0, 1, 0], deg)
  const fingerChains = [
    ['leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal'],
    ['leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal'],
    ['leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal'],
    ['leftRingProximal', 'leftRingIntermediate', 'leftRingDistal'],
    ['leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal'],
    ['rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal'],
    ['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal'],
    ['rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal'],
    ['rightRingProximal', 'rightRingIntermediate', 'rightRingDistal'],
    ['rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal']
  ]
  const clips = {}
  clips.idle = makeBipedClip({
    id: 'idle',
    frames,
    loop: true,
    takeName: 'StandBy',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const lift = sine(frame, 8)
      return {
        [biped.leftUpperArm]: z(lift),
        [biped.leftLowerArm]: z(lift),
        [biped.leftHand]: z(lift),
        [biped.rightUpperArm]: z(-lift),
        [biped.rightLowerArm]: z(-lift),
        [biped.rightHand]: z(-lift),
        [biped.neck]: y(sine(frame, 4)),
        [biped.head]: y(sine(frame, 6))
      }
    },
    hipsOffsetFn: (frame) => [0, sine(frame, 0.008), 0]
  })
  clips.walk = makeBipedClip({
    id: 'walk',
    frames,
    loop: true,
    takeName: 'Walk',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const swing = sine(frame, 8)
      return {
        [biped.leftUpperLeg]: x(-swing),
        [biped.rightUpperLeg]: x(swing),
        [biped.leftLowerLeg]: x(-swing),
        [biped.rightLowerLeg]: x(swing),
        [biped.leftFoot]: [0, 0, 0, 1],
        [biped.rightFoot]: [0, 0, 0, 1]
      }
    }
  })
  clips.fingers = makeBipedClip({
    id: 'fingers',
    frames,
    loop: true,
    takeName: 'FingerCurl',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const bend = 15 * (1 - Math.cos((2 * Math.PI * frame) / frames))
      const overrides = {}
      for (const chain of fingerChains) {
        chain.forEach((vrmName, link) => {
          overrides[biped[vrmName]] = x(-bend * (link + 1))
        })
      }
      return overrides
    }
  })
  clips.torso = makeBipedClip({
    id: 'torso',
    frames,
    loop: true,
    takeName: 'TorsoTwist',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const bend = sine(frame, 3)
      return {
        [biped.spine]: y(bend),
        'Bip001 Spine1': y(bend * 1.5),
        [biped.chest]: y(bend * 2.5),
        [biped.neck]: y(bend * 2.8),
        [biped.head]: y(bend * 3)
      }
    }
  })
  clips.ground = makeBipedClip({
    id: 'ground',
    frames: 10,
    loop: false,
    takeName: 'StandBy',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    hipsOffsetFn: (frame) => [0, frame * 0.01, 0],
    poseFn: () => ({})
  })
  clips.skill01 = makeBipedClip({
    id: 'skill01',
    frames: 20,
    loop: false,
    takeName: 'Skill01',
    rest,
    scale,
    mirrored,
    sourceFps,
    fps,
    poseFn: (frame) => {
      const progress = frame / 19
      const raise = Math.sin(progress * Math.PI) * 45
      return {
        [biped.leftUpperArm]: z(raise),
        [biped.leftLowerArm]: z(raise),
        [biped.leftHand]: z(raise),
        [biped.rightUpperArm]: z(-raise),
        [biped.rightLowerArm]: z(-raise),
        [biped.rightHand]: z(-raise),
        [biped.spine]: x(-Math.sin(progress * Math.PI) * 6),
        [biped.chest]: x(-Math.sin(progress * Math.PI) * 10)
      }
    }
  })
  return {
    schemaVersion: 1,
    sourceFps,
    fps,
    sourceHeightMeters: 1.73 * scale,
    sourceHipsHeightMeters,
    rest,
    children,
    clips
  }
}

/** 构造 clipDef（默认与 clips.adv.json 同形状）。 */
export function makeBipedClipDef(overrides = {}) {
  return { id: 'idle', takeMatch: 'StandBy', fps: 30, loop: true, slot: 'idle', grounding: 'feet', priority: 10, tags: [], ...overrides }
}
