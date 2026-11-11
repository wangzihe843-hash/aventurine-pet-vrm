/**
 * Unity Humanoid ↔ VRM normalized humanoid 骨骼映射（V1 运行时版，Wave 2 / clip-engine）
 *
 * 来源与同步：`scripts/unity-bake/lib/humanoid-map.mjs`（Wave 1.5 / U2 的纯 ESM 版本，
 * Node CLI / 浏览器预览器共用）。本文件是它的**运行时 TypeScript 副本**：
 * - 内容逐项一致（`tests/vrm-clip-humanoid-map.test.ts` 用动态 import 的 lib 逐项对拍）；
 * - 改映射必须两处同步（lib 那份还被 U2 clip 导出/校验脚本使用）。
 *
 * 语义（见 `docs/wave2-vrm-runtime-design.md` §2.2、`docs/vrm-motion-hsr.md` §2）：
 * - `assets/motions/<set>/<clip>.json` 的 `bones` 以 Unity `HumanBodyBones` 枚举名为键，
 *   值是该骨相对 rest 的归一化旋转（`r`，四元数 `[x,y,z,w]`）与仅 Hips 才有的位移（`p`，米）；
 * - 播放侧把 `r` 写到 three-vrm 的 **normalized humanoid 骨骼节点**
 *   （`humanoid.getNormalizedBoneNode(vrmName)`），`p` 加到 normalized hips 的 rest 位置，
 *   然后 `humanoid.update()` 自动转到 raw 骨骼（本文件不懂 three，只提供字符串映射）。
 *
 * 契约同步：
 * - `CLIP_SLOT_MOODS` 必须与 `@shared/animation-contract` 的 `ANIMATION_CLIP_MOODS`
 *   （= `PET_MOODS` + `'salute'`）一致；
 * - `UNITY_TO_VRM_BONE` 的所有 VRM 名必须都是 `@shared/vrm` 的 `HUMANOID_BONES` 成员。
 * 两条都由 `tests/vrm-clip-humanoid-map.test.ts` 守护。
 */
import { ANIMATION_CLIP_MOODS, type AnimationClipMood } from '@shared/animation-contract'
import type { HumanoidBone } from '@shared/vrm'

/**
 * Unity HumanBodyBones 名 → three-vrm normalized humanoid 骨骼名（52 骨 = 22 核心 + 30 手指）。
 *
 * 拇指三节存在 Unity/VRM 名称错位（见下方注释），照抄 lib 的映射，勿"顺手纠正"。
 */
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
} as const satisfies Readonly<Record<string, HumanoidBone>>)

/** Unity humanoid 骨骼名（52 骨全集；clip JSON 的 `bones` 键）。 */
export type UnityHumanoidBone = keyof typeof UNITY_TO_VRM_BONE

/** three-vrm normalized humanoid 骨骼名（`@shared/vrm` 的 `HumanoidBone` 子集）。 */
export type VrmBoneName = (typeof UNITY_TO_VRM_BONE)[UnityHumanoidBone]

/** VRM normalized 骨骼名 → Unity HumanBodyBones 名（`UNITY_TO_VRM_BONE` 的逆映射）。 */
export const VRM_TO_UNITY_BONE: Readonly<Record<VrmBoneName, UnityHumanoidBone>> = Object.freeze(
  Object.fromEntries(
    Object.entries(UNITY_TO_VRM_BONE).map(([unity, vrm]) => [vrm, unity])
  ) as Record<VrmBoneName, UnityHumanoidBone>
)

/**
 * clip JSON 中**必须存在**的骨骼（22 个 = Unity 标准 humanoid 骨集的宠物子集；
 * U1 导出固定包含这 22 个）。缺失任一 = clip 数据错误。
 */
export const CLIP_REQUIRED_BONES: readonly UnityHumanoidBone[] = Object.freeze([
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
]) as readonly UnityHumanoidBone[]

/** 手指可选骨（30 = 15/手；clip JSON 有则播放，无则手指保持 rest）。 */
export const CLIP_OPTIONAL_BONES: readonly UnityHumanoidBone[] = Object.freeze(
  (Object.keys(UNITY_TO_VRM_BONE) as UnityHumanoidBone[]).filter((name) =>
    /Thumb|Index|Middle|Ring|Little/.test(name)
  )
) as readonly UnityHumanoidBone[]

/** clip JSON 支持的骨骼全集（22 必需 + 30 手指可选 = 52）。 */
export const CLIP_BONE_NAMES: readonly UnityHumanoidBone[] = Object.freeze(
  Object.keys(UNITY_TO_VRM_BONE) as UnityHumanoidBone[]
) as readonly UnityHumanoidBone[]

/**
 * clip 可绑定的动作槽位（= `@shared/animation-contract` 的 `ANIMATION_CLIP_MOODS`：
 * `PET_MOODS` 全集 + `salute`）。
 *
 * `slot === null` 表示「事件类片段」：不绑定状态机槽位，只由 tags/代码按名字触发
 * （intro/hiding/talking/hover/pose 等）。
 */
export const CLIP_SLOT_MOODS: readonly AnimationClipMood[] = Object.freeze([
  ...ANIMATION_CLIP_MOODS
]) as readonly AnimationClipMood[]

/** 是否为合法动作槽位（`CLIP_SLOT_MOODS` 成员）。 */
export function isClipSlotMood(value: unknown): value is AnimationClipMood {
  return (
    typeof value === 'string' && (CLIP_SLOT_MOODS as readonly string[]).includes(value)
  )
}

/**
 * Unity 骨骼名 → VRM normalized 骨骼名；未知骨返回 null（播放侧应忽略并告警）。
 */
export function toVrmBoneName(unityBoneName: unknown): VrmBoneName | null {
  if (typeof unityBoneName !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(UNITY_TO_VRM_BONE, unityBoneName)) return null
  return UNITY_TO_VRM_BONE[unityBoneName as UnityHumanoidBone]
}

/** 把 VRM normalized 骨名转成 clip 里可能出现的 PascalCase 别名（leftThumbMetacarpal → LeftThumbMetacarpal）。 */
function vrmBoneToClipAlias(vrmName: string): string {
  return vrmName.length === 0 ? vrmName : vrmName[0].toUpperCase() + vrmName.slice(1)
}

/** clip JSON 里可能出现的「VRM 风格」骨名 → VRM normalized 骨名（HSR 手指/拇指数据用）。 */
export const CLIP_VRM_STYLE_BONES: ReadonlyMap<string, VrmBoneName> = new Map(
  (Object.values(UNITY_TO_VRM_BONE) as VrmBoneName[]).map((vrmName) => [
    vrmBoneToClipAlias(vrmName),
    vrmName
  ])
)

/** 判断一组 clip 骨名是否使用「VRM 风格」拇指命名（HSR 数据；Unity 规范里没有 ThumbMetacarpal 键）。 */
function usesVrmStyleThumbs(boneNames: readonly string[]): boolean {
  return boneNames.some((name) => name === 'LeftThumbMetacarpal' || name === 'RightThumbMetacarpal')
}

/**
 * 把 clip JSON 的骨名归一成 **Unity 规范键**（运行时内部统一用 Unity 名做 map 键）。
 *
 * 兼容两类真实数据（见 docs/vrm-motion-hsr.md §2 示例）：
 * 1. Unity HumanBodyBones 名（mate 集）：拇指三节 Proximal/Intermediate/Distal
 *    → VRM Metacarpal/Proximal/Distal（错位映射）；
 * 2. HSR 集的「VRM 风格」拇指名：clip 直接写 LeftThumbMetacarpal / LeftThumbProximal /
 *    LeftThumbDistal（= VRM 同名骨），需要换回 Unity 规范键：
 *    Metacarpal → Unity Proximal、Proximal → Unity Intermediate、Distal → Distal。
 *
 * 未知骨名原样返回（player 会把它记入 missingBones）；两个风格混用同一 clip 时以先到者为准。
 */
export function normalizeClipBoneName(
  boneName: string,
  allClipBoneNames: readonly string[]
): string {
  const vrmStyleThumbs = usesVrmStyleThumbs(allClipBoneNames)
  const isKnownUnityBone = Object.prototype.hasOwnProperty.call(UNITY_TO_VRM_BONE, boneName)
  if (isKnownUnityBone) {
    if (vrmStyleThumbs) {
      // HSR 风格：LeftThumbProximal 实际对应 VRM leftThumbProximal（= Unity 规范 LeftThumbIntermediate）。
      if (boneName === 'LeftThumbProximal') return 'LeftThumbIntermediate'
      if (boneName === 'RightThumbProximal') return 'RightThumbIntermediate'
    }
    return boneName
  }
  const vrmName = CLIP_VRM_STYLE_BONES.get(boneName)
  if (vrmName === undefined) return boneName
  // VRM 风格指骨（HSR 数据）补回 Unity 规范键（含拇指 Metacarpal → Unity Proximal 的错位）。
  return VRM_TO_UNITY_BONE[vrmName]
}

/** VRM normalized 骨骼名 → Unity 骨骼名；未知/非字符串返回 null。 */
export function toUnityBoneName(vrmBoneName: unknown): UnityHumanoidBone | null {
  if (typeof vrmBoneName !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(VRM_TO_UNITY_BONE, vrmBoneName)) return null
  return VRM_TO_UNITY_BONE[vrmBoneName as VrmBoneName]
}

/* -------------------------------------------------------------------------- */
/* 手指骨 fallback（换资产兼容，vrm-core 建议；纯防御，当前 tpose 资产不缺骨）      */
/* -------------------------------------------------------------------------- */

/**
 * 手指骨 fallback 表：**主 normalized 骨缺失 → 回退骨**（VRM 1.0 里除核心骨外的
 * 拇指/手指骨都是可选骨，换资产时可能出现部分缺失）。
 *
 * 规则：
 * - 拇指 Metacarpal ↔ Proximal 互为回退（不同资产/转换工具对拇指前两节的命名不一致）；
 * - Index/Middle/Ring/Little 的 Intermediate（中间节）缺失时退到同指 Proximal
 *   （少一节但整根手指仍能跟随近节运动，避免整根手指僵在 rest）。
 *
 * 解析见 `resolveVrmBoneFallback`（单向链式、带环保护）；fallback 命中不算 missingBones，
 * 播放器只 warn 一次。
 */
export const VRM_BONE_FALLBACKS: Readonly<Partial<Record<VrmBoneName, VrmBoneName>>> =
  Object.freeze({
    leftThumbMetacarpal: 'leftThumbProximal',
    rightThumbMetacarpal: 'rightThumbProximal',
    leftThumbProximal: 'leftThumbMetacarpal',
    rightThumbProximal: 'rightThumbMetacarpal',
    leftIndexIntermediate: 'leftIndexProximal',
    rightIndexIntermediate: 'rightIndexProximal',
    leftMiddleIntermediate: 'leftMiddleProximal',
    rightMiddleIntermediate: 'rightMiddleProximal',
    leftRingIntermediate: 'leftRingProximal',
    rightRingIntermediate: 'rightRingProximal',
    leftLittleIntermediate: 'leftLittleProximal',
    rightLittleIntermediate: 'rightLittleProximal'
  })

/** fallback 解析结果：实际使用的 normalized 骨名 + 是否走了回退。 */
export interface ResolvedVrmBoneName {
  resolvedName: VrmBoneName
  fallbackUsed: boolean
}

/**
 * 解析某 normalized 骨实际可用的节点名：
 * 1. 主骨存在（`hasBone` 为 true）→ 直接用主骨；
 * 2. 否则沿 `VRM_BONE_FALLBACKS` 链找第一个存在的回退骨；
 * 3. 都没有（或链有环）→ null（播放器按 missingBones 处理）。
 *
 * `hasBone` 由调用方注入（生产 = `humanoid.getNormalizedBoneNode(name) !== null`，
 * 单测可用纯函数模拟）。纯逻辑、不 import three。
 */
export function resolveVrmBoneFallback(
  vrmName: VrmBoneName,
  hasBone: (name: VrmBoneName) => boolean
): ResolvedVrmBoneName | null {
  if (hasBone(vrmName)) return { resolvedName: vrmName, fallbackUsed: false }
  const seen = new Set<VrmBoneName>([vrmName])
  let candidate = VRM_BONE_FALLBACKS[vrmName]
  while (candidate !== undefined && !seen.has(candidate)) {
    seen.add(candidate)
    if (hasBone(candidate)) return { resolvedName: candidate, fallbackUsed: true }
    candidate = VRM_BONE_FALLBACKS[candidate]
  }
  return null
}
