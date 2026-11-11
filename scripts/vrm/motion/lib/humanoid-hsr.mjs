/**
 * HSR 官方骨架（Avatar_Aventurine_00）→ VRM humanoid 骨的映射表。
 *
 * HSR 骨名来自游戏资源导出的 FBX（`Main > Root_M > Hip_L/Knee_L/Ankle_L/Toes_L`、
 * `Spine1_M/Spine2_M/Chest_M`、`Scapula_L/Shoulder_L/Elbow_L/Wrist_L` + 手指
 * `IndexFinger1_L…`）。这里覆盖 22 根核心骨（含脚趾）+ 30 根手指 = 52 根；
 * 眼睛（VRM humanoid leftEye/rightEye）不搬——由 app 的 look-at 层负责。
 *
 * 注意：VRM humanoid 的语义父级（normalized 空间的父级）由 VRM 文件的
 * `VRMC_vrm.humanoid` + raw 层级推导（见 `vrm-rest.mjs` 的 effectiveParent）；
 * 本文件只负责「HSR 骨名 ↔ VRM humanoid 名 ↔ clip 里的 Unity 风格键名」。
 */

/** VRM humanoid 名字 → clip 里的 Unity 风格骨名（与 `scripts/unity-bake/lib/humanoid-map.mjs` 的 22 骨命名兼容）。 */
export const UNITY_NAME_BY_VRM = Object.freeze({
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Chest',
  upperChest: 'UpperChest',
  neck: 'Neck',
  head: 'Head',
  leftShoulder: 'LeftShoulder',
  leftUpperArm: 'LeftUpperArm',
  leftLowerArm: 'LeftLowerArm',
  leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder',
  rightUpperArm: 'RightUpperArm',
  rightLowerArm: 'RightLowerArm',
  rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpperLeg',
  leftLowerLeg: 'LeftLowerLeg',
  leftFoot: 'LeftFoot',
  leftToes: 'LeftToes',
  rightUpperLeg: 'RightUpperLeg',
  rightLowerLeg: 'RightLowerLeg',
  rightFoot: 'RightFoot',
  rightToes: 'RightToes',
  leftThumbMetacarpal: 'LeftThumbMetacarpal',
  leftThumbProximal: 'LeftThumbProximal',
  leftThumbDistal: 'LeftThumbDistal',
  leftIndexProximal: 'LeftIndexProximal',
  leftIndexIntermediate: 'LeftIndexIntermediate',
  leftIndexDistal: 'LeftIndexDistal',
  leftMiddleProximal: 'LeftMiddleProximal',
  leftMiddleIntermediate: 'LeftMiddleIntermediate',
  leftMiddleDistal: 'LeftMiddleDistal',
  leftRingProximal: 'LeftRingProximal',
  leftRingIntermediate: 'LeftRingIntermediate',
  leftRingDistal: 'LeftRingDistal',
  leftLittleProximal: 'LeftLittleProximal',
  leftLittleIntermediate: 'LeftLittleIntermediate',
  leftLittleDistal: 'LeftLittleDistal',
  rightThumbMetacarpal: 'RightThumbMetacarpal',
  rightThumbProximal: 'RightThumbProximal',
  rightThumbDistal: 'RightThumbDistal',
  rightIndexProximal: 'RightIndexProximal',
  rightIndexIntermediate: 'RightIndexIntermediate',
  rightIndexDistal: 'RightIndexDistal',
  rightMiddleProximal: 'RightMiddleProximal',
  rightMiddleIntermediate: 'RightMiddleIntermediate',
  rightMiddleDistal: 'RightMiddleDistal',
  rightRingProximal: 'RightRingProximal',
  rightRingIntermediate: 'RightRingIntermediate',
  rightRingDistal: 'RightRingDistal',
  rightLittleProximal: 'RightLittleProximal',
  rightLittleIntermediate: 'RightLittleIntermediate',
  rightLittleDistal: 'RightLittleDistal'
})

/** VRM humanoid 名 → HSR 骨名（52 根；不含眼睛）。 */
export const HSR_TO_VRM_HUMANOID = Object.freeze({
  hips: 'Root_M',
  spine: 'Spine1_M',
  chest: 'Spine2_M',
  upperChest: 'Chest_M',
  neck: 'Neck_M',
  head: 'Head_M',
  leftShoulder: 'Scapula_L',
  leftUpperArm: 'Shoulder_L',
  leftLowerArm: 'Elbow_L',
  leftHand: 'Wrist_L',
  rightShoulder: 'Scapula_R',
  rightUpperArm: 'Shoulder_R',
  rightLowerArm: 'Elbow_R',
  rightHand: 'Wrist_R',
  leftUpperLeg: 'Hip_L',
  leftLowerLeg: 'Knee_L',
  leftFoot: 'Ankle_L',
  leftToes: 'Toes_L',
  rightUpperLeg: 'Hip_R',
  rightLowerLeg: 'Knee_R',
  rightFoot: 'Ankle_R',
  rightToes: 'Toes_R',
  leftThumbMetacarpal: 'ThumbFinger1_L',
  leftThumbProximal: 'ThumbFinger2_L',
  leftThumbDistal: 'ThumbFinger3_L',
  leftIndexProximal: 'IndexFinger1_L',
  leftIndexIntermediate: 'IndexFinger2_L',
  leftIndexDistal: 'IndexFinger3_L',
  leftMiddleProximal: 'MiddleFinger1_L',
  leftMiddleIntermediate: 'MiddleFinger2_L',
  leftMiddleDistal: 'MiddleFinger3_L',
  leftRingProximal: 'RingFinger1_L',
  leftRingIntermediate: 'RingFinger2_L',
  leftRingDistal: 'RingFinger3_L',
  leftLittleProximal: 'PinkyFinger1_L',
  leftLittleIntermediate: 'PinkyFinger2_L',
  leftLittleDistal: 'PinkyFinger3_L',
  rightThumbMetacarpal: 'ThumbFinger1_R',
  rightThumbProximal: 'ThumbFinger2_R',
  rightThumbDistal: 'ThumbFinger3_R',
  rightIndexProximal: 'IndexFinger1_R',
  rightIndexIntermediate: 'IndexFinger2_R',
  rightIndexDistal: 'IndexFinger3_R',
  rightMiddleProximal: 'MiddleFinger1_R',
  rightMiddleIntermediate: 'MiddleFinger2_R',
  rightMiddleDistal: 'MiddleFinger3_R',
  rightRingProximal: 'RingFinger1_R',
  rightRingIntermediate: 'RingFinger2_R',
  rightRingDistal: 'RingFinger3_R',
  rightLittleProximal: 'PinkyFinger1_R',
  rightLittleIntermediate: 'PinkyFinger2_R',
  rightLittleDistal: 'PinkyFinger3_R'
})

/** 22 根核心骨（不含手指；等价 `scripts/unity-bake/lib/humanoid-map.mjs` 的必需集）。 */
export const CORE_UNITY_BONES = Object.freeze([
  'Hips',
  'Spine',
  'Chest',
  'UpperChest',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightShoulder',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
  'LeftUpperLeg',
  'LeftLowerLeg',
  'LeftFoot',
  'LeftToes',
  'RightUpperLeg',
  'RightLowerLeg',
  'RightFoot',
  'RightToes'
])

/** 30 根手指骨（Unity 风格名，与 UNITY_NAME_BY_VRM 一致）。 */
export const FINGER_UNITY_BONES = Object.freeze(
  Object.values(UNITY_NAME_BY_VRM).filter((name) => !CORE_UNITY_BONES.includes(name))
)

/** 全部 52 根 humanoid 骨（Unity 风格名）。 */
export const CLIP_HUMANOID_BONES = Object.freeze([
  ...CORE_UNITY_BONES,
  ...FINGER_UNITY_BONES
])

/**
 * 以**目标 VRM 实际 humanoid 骨**为准解析映射（默认目标 = 无 upperChest 的 T-pose 戏浪）。
 *
 * - 目标有 upperChest（旧 legfix）：保持 1:1：chest←Spine2_M、upperChest←Chest_M；
 * - 目标无 upperChest（新 T-pose / VRMify）：spine←Spine1_M、**chest←Chest_M**
 *   （把整段上胸世界旋转合并到 chest，避免肩/臂丢掉 HSR Chest_M 的旋转；
 *    HSR Spine2_M 的局部旋转因此并入 chest 的绝对旋转，躯干扭转分布略有近似，见 docs）。
 *
 * @param {any} vrmRest buildVrmRest 结果
 */
export function resolveHumanoidMapping(vrmRest) {
  /** @type {Record<string, string>} */
  const mapping = {}
  /** @type {string[]} */
  const missing = []
  for (const [vrmName, hsrBone] of Object.entries(HSR_TO_VRM_HUMANOID)) {
    if (vrmRest?.humanoid?.[vrmName]) mapping[vrmName] = hsrBone
    else missing.push(vrmName)
  }
  /** @type {string[]} */
  const notes = []
  if (!vrmRest?.humanoid?.upperChest && vrmRest?.humanoid?.chest && vrmRest?.humanoid?.spine) {
    mapping.chest = HSR_TO_VRM_HUMANOID.upperChest
    notes.push('target 缺 upperChest：chest←HSR Chest_M（Spine2_M 局部旋转并入 chest），spine←Spine1_M')
  }
  return { mapping, missing, notes, upperChestFallback: notes.length > 0 }
}

/** HSR 源骨架的“解剖链下一根”骨（用于 rest 方向修正；叶片骨用 parent→own 方向）。 */
export const HSR_BONE_NEXT = Object.freeze({
  Root_M: 'Spine1_M',
  Spine1_M: 'Spine2_M',
  Spine2_M: 'Chest_M',
  Chest_M: 'Neck_M',
  Neck_M: 'Head_M',
  Scapula_L: 'Shoulder_L',
  Scapula_R: 'Shoulder_R',
  Shoulder_L: 'Elbow_L',
  Shoulder_R: 'Elbow_R',
  Elbow_L: 'Wrist_L',
  Elbow_R: 'Wrist_R',
  Wrist_L: 'MiddleFinger1_L',
  Wrist_R: 'MiddleFinger1_R',
  Hip_L: 'Knee_L',
  Hip_R: 'Knee_R',
  Knee_L: 'Ankle_L',
  Knee_R: 'Ankle_R',
  Ankle_L: 'Toes_L',
  Ankle_R: 'Toes_R',
  Toes_L: null,
  Toes_R: null,
  ThumbFinger1_L: 'ThumbFinger2_L',
  ThumbFinger2_L: 'ThumbFinger3_L',
  ThumbFinger3_L: null,
  ThumbFinger1_R: 'ThumbFinger2_R',
  ThumbFinger2_R: 'ThumbFinger3_R',
  ThumbFinger3_R: null,
  IndexFinger1_L: 'IndexFinger2_L',
  IndexFinger2_L: 'IndexFinger3_L',
  IndexFinger3_L: null,
  IndexFinger1_R: 'IndexFinger2_R',
  IndexFinger2_R: 'IndexFinger3_R',
  IndexFinger3_R: null,
  MiddleFinger1_L: 'MiddleFinger2_L',
  MiddleFinger2_L: 'MiddleFinger3_L',
  MiddleFinger3_L: null,
  MiddleFinger1_R: 'MiddleFinger2_R',
  MiddleFinger2_R: 'MiddleFinger3_R',
  MiddleFinger3_R: null,
  RingFinger1_L: 'RingFinger2_L',
  RingFinger2_L: 'RingFinger3_L',
  RingFinger3_L: null,
  RingFinger1_R: 'RingFinger2_R',
  RingFinger2_R: 'RingFinger3_R',
  RingFinger3_R: null,
  PinkyFinger1_L: 'PinkyFinger2_L',
  PinkyFinger2_L: 'PinkyFinger3_L',
  PinkyFinger3_L: null,
  PinkyFinger1_R: 'PinkyFinger2_R',
  PinkyFinger2_R: 'PinkyFinger3_R',
  PinkyFinger3_R: null
})

/**
 * 目标 VRM 的“解剖链下一根”候选（按顺序取第一个存在的 humanoid 骨；用于 rest 方向）。
 * 目标缺 upperChest 时 chest→neck。
 */
const VRM_NEXT_CANDIDATES = Object.freeze({
  hips: ['spine'],
  spine: ['chest'],
  chest: ['upperChest', 'neck'],
  upperChest: ['neck'],
  neck: ['head'],
  head: [],
  leftShoulder: ['leftUpperArm'],
  rightShoulder: ['rightUpperArm'],
  leftUpperArm: ['leftLowerArm'],
  rightUpperArm: ['rightLowerArm'],
  leftLowerArm: ['leftHand'],
  rightLowerArm: ['rightHand'],
  leftHand: ['leftMiddleProximal', 'leftIndexProximal'],
  rightHand: ['rightMiddleProximal', 'rightIndexProximal'],
  leftUpperLeg: ['leftLowerLeg'],
  rightUpperLeg: ['rightLowerLeg'],
  leftLowerLeg: ['leftFoot'],
  rightLowerLeg: ['rightFoot'],
  leftFoot: ['leftToes'],
  rightFoot: ['rightToes'],
  leftToes: [],
  rightToes: [],
  leftThumbMetacarpal: ['leftThumbProximal'],
  leftThumbProximal: ['leftThumbDistal'],
  leftThumbDistal: [],
  rightThumbMetacarpal: ['rightThumbProximal'],
  rightThumbProximal: ['rightThumbDistal'],
  rightThumbDistal: [],
  leftIndexProximal: ['leftIndexIntermediate'],
  leftIndexIntermediate: ['leftIndexDistal'],
  leftIndexDistal: [],
  rightIndexProximal: ['rightIndexIntermediate'],
  rightIndexIntermediate: ['rightIndexDistal'],
  rightIndexDistal: [],
  leftMiddleProximal: ['leftMiddleIntermediate'],
  leftMiddleIntermediate: ['leftMiddleDistal'],
  leftMiddleDistal: [],
  rightMiddleProximal: ['rightMiddleIntermediate'],
  rightMiddleIntermediate: ['rightMiddleDistal'],
  rightMiddleDistal: [],
  leftRingProximal: ['leftRingIntermediate'],
  leftRingIntermediate: ['leftRingDistal'],
  leftRingDistal: [],
  rightRingProximal: ['rightRingIntermediate'],
  rightRingIntermediate: ['rightRingDistal'],
  rightRingDistal: [],
  leftLittleProximal: ['leftLittleIntermediate'],
  leftLittleIntermediate: ['leftLittleDistal'],
  leftLittleDistal: [],
  rightLittleProximal: ['rightLittleIntermediate'],
  rightLittleIntermediate: ['rightLittleDistal'],
  rightLittleDistal: []
})

/** 目标 humanoid 骨的下一根（不存在则 null）。 */
export function resolveHumanoidNext(vrmName, vrmRest) {
  for (const candidate of VRM_NEXT_CANDIDATES[vrmName] ?? []) {
    if (vrmRest?.humanoid?.[candidate]) return candidate
  }
  return null
}
