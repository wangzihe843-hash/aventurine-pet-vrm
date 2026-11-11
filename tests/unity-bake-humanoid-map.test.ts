/**
 * U2 骨骼映射 / 契约槽位同步测试。
 *
 * 契约来源：`src/shared/vrm.ts`（HUMANOID_BONES）、`src/shared/types.ts`（PET_MOODS）、
 * `src/shared/animation-contract.ts`（ANIMATION_CLIP_MOODS = PET_MOODS + 'salute'）。
 * lib 是纯 ESM（浏览器可 import），不能直接 import TS 契约，所以「同步性」由本测试守护：
 * 契约一旦改动而 lib 未同步，这里立刻失败。
 */
import { describe, expect, it } from 'vitest'

import { ANIMATION_CLIP_MOODS } from '@shared/animation-contract'
import { PET_MOODS } from '@shared/types'
import { HUMANOID_BONES } from '@shared/vrm'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  CLIP_BONE_NAMES,
  CLIP_OPTIONAL_BONES,
  CLIP_REQUIRED_BONES,
  CONTRACT_CLIP_SLOTS,
  UNITY_TO_VRM_BONE,
  VRM_TO_UNITY_BONE,
  isContractClipSlot,
  toUnityBoneName,
  toVrmBoneName
} from '../scripts/unity-bake/lib/humanoid-map.mjs'

/**
 * 期望映射（显式写死，防 lib 悄悄漂移）：22 核心骨 + 30 手指可选骨。
 * 拇指注意：Unity ThumbProximal/Intermediate/Distal ↔ VRM ThumbMetacarpal/Proximal/Distal
 * （错一位；已用 aventurine-tpose.vrm humanoid rest + Unity GT rest worldPos 逐骨核验）。
 */
const EXPECTED_MAP: Record<string, string> = {
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
}

describe('humanoid-map：Unity ↔ VRM 骨骼映射', () => {
  it('映射表是期望的 22 核心骨 + 30 手指（共 52）', () => {
    expect(Object.keys(UNITY_TO_VRM_BONE)).toHaveLength(52)
    expect(UNITY_TO_VRM_BONE).toEqual(EXPECTED_MAP)
  })

  it('拇指错位映射（Unity Proximal/Intermediate/Distal ↔ VRM Metacarpal/Proximal/Distal）', () => {
    expect(toVrmBoneName('LeftThumbProximal')).toBe('leftThumbMetacarpal')
    expect(toVrmBoneName('LeftThumbIntermediate')).toBe('leftThumbProximal')
    expect(toVrmBoneName('LeftThumbDistal')).toBe('leftThumbDistal')
    expect(toVrmBoneName('RightThumbProximal')).toBe('rightThumbMetacarpal')
    expect(toVrmBoneName('LeftIndexProximal')).toBe('leftIndexProximal')
  })

  it('所有 VRM 名都是 src/shared/vrm.ts HUMANOID_BONES 成员', () => {
    const vrmBones = new Set<string>(HUMANOID_BONES as readonly string[])
    for (const vrmName of Object.values(UNITY_TO_VRM_BONE) as string[]) {
      expect(vrmBones.has(vrmName), `lib 映射的 ${vrmName} 不在 HUMANOID_BONES`).toBe(true)
    }
  })

  it('映射无重复 VRM 名，逆映射是双射', () => {
    const vrmNames = Object.values(UNITY_TO_VRM_BONE) as string[]
    expect(new Set(vrmNames).size).toBe(vrmNames.length)
    expect(Object.keys(VRM_TO_UNITY_BONE)).toHaveLength(52)
    for (const [unityName, vrmName] of Object.entries(UNITY_TO_VRM_BONE)) {
      expect(VRM_TO_UNITY_BONE[vrmName as string]).toBe(unityName)
    }
  })

  it('CLIP_REQUIRED_BONES = 22 核心骨；CLIP_OPTIONAL_BONES = 30 手指；合起来覆盖全部映射', () => {
    expect(CLIP_REQUIRED_BONES).toHaveLength(22)
    expect(new Set(CLIP_REQUIRED_BONES).size).toBe(22)
    expect(CLIP_OPTIONAL_BONES).toHaveLength(30)
    expect(new Set(CLIP_OPTIONAL_BONES).size).toBe(30)
    expect([...CLIP_REQUIRED_BONES, ...CLIP_OPTIONAL_BONES].sort()).toEqual(Object.keys(UNITY_TO_VRM_BONE).sort())
    expect(CLIP_BONE_NAMES).toEqual(Object.keys(UNITY_TO_VRM_BONE))
    expect(CLIP_REQUIRED_BONES.length + CLIP_OPTIONAL_BONES.length).toBe(CLIP_BONE_NAMES.length)
  })

  it('CONTRACT_CLIP_SLOTS 与 src/shared/animation-contract.ts 的 ANIMATION_CLIP_MOODS 同步', () => {
    expect(CONTRACT_CLIP_SLOTS).toEqual([...ANIMATION_CLIP_MOODS])
  })

  it('CONTRACT_CLIP_SLOTS = PET_MOODS + salute（去重、无遗漏）', () => {
    expect(CONTRACT_CLIP_SLOTS).toEqual([...PET_MOODS, 'salute'])
    expect(new Set(CONTRACT_CLIP_SLOTS).size).toBe(CONTRACT_CLIP_SLOTS.length)
  })

  it('toVrmBoneName / toUnityBoneName 正反例', () => {
    expect(toVrmBoneName('Hips')).toBe('hips')
    expect(toVrmBoneName('LeftToes')).toBe('leftToes')
    expect(toVrmBoneName('NoSuchBone')).toBeNull()
    expect(toVrmBoneName('hips')).toBeNull() // 大小写敏感：Unity 名是 PascalCase
    // @ts-expect-error 非字符串入参返回 null（防御分支）
    expect(toVrmBoneName(undefined)).toBeNull()
    expect(toUnityBoneName('upperChest')).toBe('UpperChest')
    expect(toUnityBoneName('upperchest')).toBeNull()
    // @ts-expect-error 非字符串入参返回 null
    expect(toUnityBoneName(null)).toBeNull()
  })

  it('isContractClipSlot 正反例', () => {
    expect(isContractClipSlot('idle')).toBe(true)
    expect(isContractClipSlot('pat')).toBe(true)
    expect(isContractClipSlot('salute')).toBe(true)
    expect(isContractClipSlot('hiding')).toBe(false)
    expect(isContractClipSlot('')).toBe(false)
    expect(isContractClipSlot(null)).toBe(false)
    expect(isContractClipSlot(42)).toBe(false)
  })
})
