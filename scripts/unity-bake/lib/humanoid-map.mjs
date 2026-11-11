/**
 * Unity Humanoid ↔ VRM normalized humanoid 骨骼映射（Wave 1.5 / U2）
 *
 * 纯 ESM：**不 import 任何模块**（无 node:fs / three / 浏览器 API），
 * 因此可以同时被 Node CLI、vitest 单测、浏览器 clip-viewer.js 直接 import。
 *
 * 语义：
 * - `assets/motions/<set>/<clip>.json` 的 `bones` 以 Unity `HumanBodyBones`
 *   枚举名（`Hips` / `LeftUpperArm` …）为键，值是该骨相对 rest 的归一化旋转
 *   （`r`，四元数数组）与仅 Hips 才有的位移（`p`，米）。
 * - 播放侧把 `r` 写到 three-vrm 的 **normalized humanoid 骨骼节点**
 *   （`humanoid.getNormalizedBoneNode(vrmName)`），p 加到 normalized hips 的
 *   rest 位置，然后 `humanoid.update()` 自动转到 raw 骨骼。
 * - `Hips` 在 Unity/VRM 两侧同名，映射里是恒等项。
 *
 * 契约同步：
 * - `CONTRACT_CLIP_SLOTS` 必须与 `src/shared/animation-contract.ts` 的
 *   `ANIMATION_CLIP_MOODS`（= `PET_MOODS` + `'salute'`）完全一致；
 * - `UNITY_TO_VRM_BONE` 的 22 个 VRM 名必须都是 `src/shared/vrm.ts`
 *   `HUMANOID_BONES` 的成员。
 * 两条都由 `tests/unity-bake-humanoid-map.test.ts` 断言（lib 纯 ESM，不能直接
 * import TS 契约，所以同步性只能靠测试守护；改契约时请同步改这里）。
 */

/** Unity HumanBodyBones 名 → three-vrm normalized humanoid 骨骼名（22 个）。 */
export const UNITY_TO_VRM_BONE = Object.freeze({
  Hips: 'hips',
  Spine: 'spine',
  Chest: 'chest',
  UpperChest: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'leftShoulder',
  LeftUpperArm: 'leftUpperArm',
  LeftLowerArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightUpperArm: 'rightUpperArm',
  RightLowerArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpperLeg: 'leftUpperLeg',
  LeftLowerLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToes: 'leftToes',
  RightUpperLeg: 'rightUpperLeg',
  RightLowerLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToes: 'rightToes',

  // ---- 手指（30 = 15/手；2026-11-08 补：Unity Humanoid finger muscles -> VRM normalized 手指骨）----
  // 拇指三节的 Unity/VRM 名称错位一位：Unity Proximal/Intermediate/Distal
  // 在 VRM 1.0 里是 ThumbMetacarpal/Proximal/Distal（UniVRM 同款映射，
  // 已用 aventurine-tpose.vrm 的 humanoid rest 与 Unity GT rest worldPos 逐骨核验）。
  LeftThumbProximal: 'leftThumbMetacarpal',
  LeftThumbIntermediate: 'leftThumbProximal',
  LeftThumbDistal: 'leftThumbDistal',
  LeftIndexProximal: 'leftIndexProximal',
  LeftIndexIntermediate: 'leftIndexIntermediate',
  LeftIndexDistal: 'leftIndexDistal',
  LeftMiddleProximal: 'leftMiddleProximal',
  LeftMiddleIntermediate: 'leftMiddleIntermediate',
  LeftMiddleDistal: 'leftMiddleDistal',
  LeftRingProximal: 'leftRingProximal',
  LeftRingIntermediate: 'leftRingIntermediate',
  LeftRingDistal: 'leftRingDistal',
  LeftLittleProximal: 'leftLittleProximal',
  LeftLittleIntermediate: 'leftLittleIntermediate',
  LeftLittleDistal: 'leftLittleDistal',
  RightThumbProximal: 'rightThumbMetacarpal',
  RightThumbIntermediate: 'rightThumbProximal',
  RightThumbDistal: 'rightThumbDistal',
  RightIndexProximal: 'rightIndexProximal',
  RightIndexIntermediate: 'rightIndexIntermediate',
  RightIndexDistal: 'rightIndexDistal',
  RightMiddleProximal: 'rightMiddleProximal',
  RightMiddleIntermediate: 'rightMiddleIntermediate',
  RightMiddleDistal: 'rightMiddleDistal',
  RightRingProximal: 'rightRingProximal',
  RightRingIntermediate: 'rightRingIntermediate',
  RightRingDistal: 'rightRingDistal',
  RightLittleProximal: 'rightLittleProximal',
  RightLittleIntermediate: 'rightLittleIntermediate',
  RightLittleDistal: 'rightLittleDistal'
})

/** VRM normalized 骨骼名 → Unity HumanBodyBones 名（`UNITY_TO_VRM_BONE` 的逆映射）。 */
export const VRM_TO_UNITY_BONE = Object.freeze(
  Object.fromEntries(Object.entries(UNITY_TO_VRM_BONE).map(([unity, vrm]) => [vrm, unity]))
)

/**
 * clip JSON 中**必须存在**的骨骼（22 个 = Unity 标准 humanoid 骨集的宠物子集；
 * U1 导出固定包含这 22 个）。缺失任一 = clip 数据错误。
 */
export const CLIP_REQUIRED_BONES = Object.freeze([
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

/** 手指可选骨（30 = 15/手；clip JSON 有则播放，无则手指保持 rest）。 */
export const CLIP_OPTIONAL_BONES = Object.freeze(
  Object.keys(UNITY_TO_VRM_BONE).filter((name) => /Thumb|Index|Middle|Ring|Little/.test(name))
)

/** clip JSON 支持的骨骼全集（22 必需 + 30 手指可选 = 52）。 */
export const CLIP_BONE_NAMES = Object.freeze(Object.keys(UNITY_TO_VRM_BONE))

/**
 * clip 可绑定的动作槽位（= `ANIMATION_CLIP_MOODS`：PetMood 全集 + `salute`）。
 * `slot === null` 表示「事件类片段」：不绑定状态机槽位，只由 tags/代码按名字触发
 * （intro/hiding/talking/hover/pose 等）。
 */
export const CONTRACT_CLIP_SLOTS = Object.freeze([
  'idle',
  'walk',
  'climb',
  'sit',
  'sleep',
  'drag',
  'fall',
  'pat',
  'grabWindow',
  'dshBusy',
  'dshDone',
  'dshError',
  'salute'
])

/** 是否为合法动作槽位（`CONTRACT_CLIP_SLOTS` 成员）。 */
export function isContractClipSlot(value) {
  return typeof value === 'string' && CONTRACT_CLIP_SLOTS.includes(value)
}

/**
 * Unity 骨骼名 → VRM normalized 骨骼名；未知骨返回 null（播放侧应忽略并告警）。
 * @param {string} unityBoneName
 * @returns {string | null}
 */
export function toVrmBoneName(unityBoneName) {
  if (typeof unityBoneName !== 'string') return null
  return Object.prototype.hasOwnProperty.call(UNITY_TO_VRM_BONE, unityBoneName)
    ? UNITY_TO_VRM_BONE[unityBoneName]
    : null
}

/**
 * VRM normalized 骨骼名 → Unity 骨骼名；未知返回 null。
 * @param {string} vrmBoneName
 * @returns {string | null}
 */
export function toUnityBoneName(vrmBoneName) {
  if (typeof vrmBoneName !== 'string') return null
  return Object.prototype.hasOwnProperty.call(VRM_TO_UNITY_BONE, vrmBoneName)
    ? VRM_TO_UNITY_BONE[vrmBoneName]
    : null
}
