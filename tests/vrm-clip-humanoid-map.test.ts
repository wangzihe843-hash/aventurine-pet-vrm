/**
 * V1 clip-engine：`src/renderer/src/vrm/humanoid-map.ts` 与冻结契约 / Unity 烘焙 lib 的一致性测试。
 *
 * 守护三件事（坏了就会静默播错骨）：
 * 1. TS 运行时映射与 `scripts/unity-bake/lib/humanoid-map.mjs` 逐项一致（52 骨，含拇指错位映射）；
 * 2. 所有 VRM 名都在 `@shared/vrm` 的 `HUMANOID_BONES` 内；
 * 3. `CLIP_SLOT_MOODS` 与 `ANIMATION_CLIP_MOODS`（= PET_MOODS + salute）/ lib 的
 *    `CONTRACT_CLIP_SLOTS` 完全一致。
 */
import { describe, expect, it } from 'vitest'

import { ANIMATION_CLIP_MOODS } from '@shared/animation-contract'
import { PET_MOODS } from '@shared/types'
import { HUMANOID_BONES } from '@shared/vrm'

// @ts-expect-error -- scripts/unity-bake/lib/*.mjs 纯 ESM 无 .d.ts（tests 不参与 tsc）
import {
  CLIP_BONE_NAMES as LIB_CLIP_BONE_NAMES,
  CLIP_OPTIONAL_BONES as LIB_CLIP_OPTIONAL_BONES,
  CLIP_REQUIRED_BONES as LIB_CLIP_REQUIRED_BONES,
  CONTRACT_CLIP_SLOTS,
  UNITY_TO_VRM_BONE as LIB_UNITY_TO_VRM_BONE,
  VRM_TO_UNITY_BONE as LIB_VRM_TO_UNITY_BONE
} from '../scripts/unity-bake/lib/humanoid-map.mjs'

import {
  CLIP_BONE_NAMES,
  CLIP_OPTIONAL_BONES,
  CLIP_REQUIRED_BONES,
  CLIP_SLOT_MOODS,
  CLIP_VRM_STYLE_BONES,
  UNITY_TO_VRM_BONE,
  VRM_BONE_FALLBACKS,
  VRM_TO_UNITY_BONE,
  isClipSlotMood,
  normalizeClipBoneName,
  resolveVrmBoneFallback,
  toUnityBoneName,
  toVrmBoneName
} from '../src/renderer/src/vrm/humanoid-map'

describe('vrm/humanoid-map：Unity ↔ VRM normalized 骨映射（52 骨）', () => {
  it('映射与 unity-bake lib 逐项一致（22 核心 + 30 手指）', () => {
    expect(Object.keys(UNITY_TO_VRM_BONE)).toHaveLength(52)
    expect(UNITY_TO_VRM_BONE).toEqual(LIB_UNITY_TO_VRM_BONE)
    expect(Object.keys(UNITY_TO_VRM_BONE)).toEqual(Object.keys(LIB_UNITY_TO_VRM_BONE))
    expect(Object.values(UNITY_TO_VRM_BONE)).toEqual(Object.values(LIB_UNITY_TO_VRM_BONE))
  })

  it('所有 VRM 名都是 @shared/vrm 的 HUMANOID_BONES 成员', () => {
    const vrmBones = new Set<string>(HUMANOID_BONES as readonly string[])
    for (const vrmName of Object.values(UNITY_TO_VRM_BONE) as string[]) {
      expect(vrmBones.has(vrmName), `${vrmName} 不在 HUMANOID_BONES`).toBe(true)
    }
  })

  it('拇指错位映射与 lib 一致（Unity Proximal/Intermediate/Distal ↔ VRM Metacarpal/Proximal/Distal）', () => {
    expect(UNITY_TO_VRM_BONE.LeftThumbProximal).toBe('leftThumbMetacarpal')
    expect(UNITY_TO_VRM_BONE.LeftThumbIntermediate).toBe('leftThumbProximal')
    expect(UNITY_TO_VRM_BONE.LeftThumbDistal).toBe('leftThumbDistal')
    expect(UNITY_TO_VRM_BONE.RightThumbProximal).toBe('rightThumbMetacarpal')
    expect(UNITY_TO_VRM_BONE.RightThumbIntermediate).toBe('rightThumbProximal')
    expect(UNITY_TO_VRM_BONE.RightThumbDistal).toBe('rightThumbDistal')
    expect(toVrmBoneName('LeftThumbProximal')).toBe('leftThumbMetacarpal')
  })

  it('逆映射与 lib 一致且为双射', () => {
    expect(VRM_TO_UNITY_BONE).toEqual(LIB_VRM_TO_UNITY_BONE)
    const vrmNames = Object.values(UNITY_TO_VRM_BONE) as string[]
    expect(new Set(vrmNames).size).toBe(vrmNames.length)
    for (const [unityName, vrmName] of Object.entries(UNITY_TO_VRM_BONE)) {
      expect(VRM_TO_UNITY_BONE[vrmName]).toBe(unityName)
      expect(toUnityBoneName(vrmName)).toBe(unityName)
    }
  })

  it('必需/可选/全集骨骼常量与 lib 一致', () => {
    expect(CLIP_REQUIRED_BONES).toEqual(LIB_CLIP_REQUIRED_BONES)
    expect(CLIP_OPTIONAL_BONES).toEqual(LIB_CLIP_OPTIONAL_BONES)
    expect(CLIP_BONE_NAMES).toEqual(LIB_CLIP_BONE_NAMES)
    expect(CLIP_REQUIRED_BONES).toHaveLength(22)
    expect(CLIP_OPTIONAL_BONES).toHaveLength(30)
  })

  it('clip 骨名归一：Unity 集 / HSR「VRM 风格」拇指集 / 未知骨', () => {
    // mate（Unity 规范）：原样返回
    const mateNames = ['Hips', 'LeftThumbProximal', 'LeftThumbIntermediate', 'LeftThumbDistal']
    for (const name of mateNames) expect(normalizeClipBoneName(name, mateNames)).toBe(name)
    // hsr（VRM 风格拇指名）：换回 Unity 规范键（Metacarpal→Proximal，Proximal→Intermediate）
    const hsrNames = ['Hips', 'LeftThumbMetacarpal', 'LeftThumbProximal', 'LeftThumbDistal']
    expect(normalizeClipBoneName('LeftThumbMetacarpal', hsrNames)).toBe('LeftThumbProximal')
    expect(normalizeClipBoneName('LeftThumbProximal', hsrNames)).toBe('LeftThumbIntermediate')
    expect(normalizeClipBoneName('LeftThumbDistal', hsrNames)).toBe('LeftThumbDistal')
    expect(normalizeClipBoneName('Hips', hsrNames)).toBe('Hips')
    // 两个拇指骨名都映射到 VRM 同名骨（归一后经 Unity 映射等价）
    expect(UNITY_TO_VRM_BONE['LeftThumbProximal']).toBe('leftThumbMetacarpal')
    expect(UNITY_TO_VRM_BONE['LeftThumbIntermediate']).toBe('leftThumbProximal')
    // 未知骨名原样返回（player 记 missingBones）
    expect(normalizeClipBoneName('MysteryBone', hsrNames)).toBe('MysteryBone')
    // VRM PascalCase 别名表覆盖 52 骨
    expect(CLIP_VRM_STYLE_BONES.size).toBe(52)
    expect(CLIP_VRM_STYLE_BONES.get('LeftThumbMetacarpal')).toBe('leftThumbMetacarpal')
  })

  it('未知骨映射返回 null', () => {
    expect(toVrmBoneName('Bogus')).toBeNull()
    expect(toVrmBoneName(42)).toBeNull()
    expect(toUnityBoneName('bogus')).toBeNull()
  })
})

describe('vrm/humanoid-map：手指骨 fallback（换资产兼容）', () => {
  it('VRM_BONE_FALLBACKS 的键/值都是合法 VRM normalized 骨名，且不自我回退', () => {
    const vrmNames = new Set<string>(Object.values(UNITY_TO_VRM_BONE) as string[])
    for (const [primary, fallback] of Object.entries(VRM_BONE_FALLBACKS)) {
      expect(vrmNames.has(primary), `fallback 键 ${primary} 非法`).toBe(true)
      expect(vrmNames.has(fallback as string), `fallback 值 ${fallback} 非法`).toBe(true)
      expect(primary).not.toBe(fallback)
    }
    // 任务明确的拇指映射（两套资产拇指前两节命名差异）
    expect(VRM_BONE_FALLBACKS.leftThumbMetacarpal).toBe('leftThumbProximal')
    expect(VRM_BONE_FALLBACKS.rightThumbMetacarpal).toBe('rightThumbProximal')
    // 中间指节缺失退到同指近节
    expect(VRM_BONE_FALLBACKS.leftIndexIntermediate).toBe('leftIndexProximal')
  })

  it('resolveVrmBoneFallback：主骨优先 / 单步回退 / 无回退 null / 环安全', () => {
    const all = new Set<string>(Object.keys(VRM_BONE_FALLBACKS))
    const present = (names: string[]) => (name: string) => names.includes(name)
    // 主骨存在 → 原样、不算回退
    expect(resolveVrmBoneFallback('leftThumbProximal', present(['leftThumbProximal']))).toEqual({
      resolvedName: 'leftThumbProximal',
      fallbackUsed: false
    })
    // Metacarpal 缺失 → 回退 Proximal
    expect(resolveVrmBoneFallback('leftThumbMetacarpal', present(['leftThumbProximal']))).toEqual({
      resolvedName: 'leftThumbProximal',
      fallbackUsed: true
    })
    // Intermediate 缺失 → 回退同指 Proximal
    expect(
      resolveVrmBoneFallback('rightMiddleIntermediate', present(['rightMiddleProximal']))
    ).toEqual({ resolvedName: 'rightMiddleProximal', fallbackUsed: true })
    // 主骨与回退骨都缺失 → null（拇指双向映射有环，不能死循环）
    expect(resolveVrmBoneFallback('leftThumbMetacarpal', () => false)).toBeNull()
    // 不在回退表里的骨缺失 → null
    expect(resolveVrmBoneFallback('leftHand', () => false)).toBeNull()
    expect(all.has('leftHand')).toBe(false)
  })
})

describe('vrm/humanoid-map：动作槽位 CLIP_SLOT_MOODS', () => {
  it('与 ANIMATION_CLIP_MOODS（PET_MOODS + salute）完全一致', () => {
    expect(CLIP_SLOT_MOODS).toEqual([...PET_MOODS, 'salute'])
    expect(CLIP_SLOT_MOODS).toEqual([...ANIMATION_CLIP_MOODS])
  })

  it('与 unity-bake lib 的 CONTRACT_CLIP_SLOTS 完全一致（lib 侧同步守护）', () => {
    expect(CLIP_SLOT_MOODS).toEqual([...CONTRACT_CLIP_SLOTS])
  })

  it('isClipSlotMood 只接受合法槽位', () => {
    for (const mood of CLIP_SLOT_MOODS) expect(isClipSlotMood(mood)).toBe(true)
    expect(isClipSlotMood('bogus')).toBe(false)
    expect(isClipSlotMood(null)).toBe(false)
    expect(isClipSlotMood(3)).toBe(false)
  })
})
