/**
 * 姿态数据入口：基础姿态表、手势表、以及「度 → 四元数」转换 / 关键帧采样工具。
 *
 * 纯函数、不 import three；单测直接 import 本模块校验姿态数据合法性。
 */
import {
  IDENTITY_QUAT,
  eulerDegToQuat,
  slerpQuat
} from '../quat'
import type { GestureDef, PoseDef, PoseQuats, Quat } from '../types'
import { BASE_POSES, BASE_POSE_IDS, BASE_POSE_META } from './base'
import {
  ALL_GESTURES,
  CHEER_GESTURE,
  EMPTY_POSE,
  HEAD_MASK,
  IDLE_VARIANTS,
  REACTION_IDS,
  REACTIONS,
  TORSO_ARM_MASK,
  UPPER_BODY_MASK,
  findGesture,
  gestureEmotionAt,
  gestureGazeAt,
  type IdleVariantDef
} from './gestures'

export {
  BASE_POSES,
  BASE_POSE_IDS,
  BASE_POSE_META,
  ALL_GESTURES,
  CHEER_GESTURE,
  EMPTY_POSE,
  HEAD_MASK,
  TORSO_ARM_MASK,
  UPPER_BODY_MASK,
  IDLE_VARIANTS,
  REACTION_IDS,
  REACTIONS,
  findGesture,
  gestureEmotionAt,
  gestureGazeAt
}
export type { IdleVariantDef }

/** 姿态元数据查询（未知 id 回退 stand）。 */
export function getPoseMeta(id: string) {
  return BASE_POSE_META[id] ?? BASE_POSE_META.stand
}

/** 基础姿态定义查询（未知 id 回退 stand）。 */
export function getPoseDef(id: string): PoseDef {
  return BASE_POSES[id] ?? BASE_POSES.stand
}

/** 单个姿态定义（度）→ 四元数 Map。 */
export function poseDefToQuats(def: PoseDef): PoseQuats {
  const map = new Map<string, Quat>()
  for (const bone of Object.keys(def)) {
    map.set(bone, eulerDegToQuat(def[bone] ?? {}))
  }
  return map
}

/** 度数记录的深拷贝/合并：把 `extra` 的角度叠加到 `base` 上（gait/procedural 用）。 */
export function addEulerDegrees(
  base: PoseDef,
  extra: Readonly<Record<string, { x?: number; y?: number; z?: number }>>
): Record<string, { x: number; y: number; z: number }> {
  const out: Record<string, { x: number; y: number; z: number }> = {}
  const add = (bone: string, src: { x?: number; y?: number; z?: number }) => {
    const current = out[bone] ?? { x: 0, y: 0, z: 0 }
    current.x += src.x ?? 0
    current.y += src.y ?? 0
    current.z += src.z ?? 0
    out[bone] = current
  }
  for (const bone of Object.keys(base)) add(bone, base[bone] ?? {})
  for (const bone of Object.keys(extra)) add(bone, extra[bone] ?? {})
  return out
}

/** 度数记录 → 四元数 Map（合并后的姿态可以直接转）。 */
export function degreesToQuats(
  degrees: Readonly<Record<string, { x?: number; y?: number; z?: number }>>
): PoseQuats {
  const map = new Map<string, Quat>()
  for (const bone of Object.keys(degrees)) map.set(bone, eulerDegToQuat(degrees[bone] ?? {}))
  return map
}

/**
 * 采样手势关键帧（`t` 秒）。
 *
 * 语义：取相邻两个关键帧做 slerp（缺省骨视为恒等）；返回**该时刻所有曾出现的骨**，
 * 这样手势结束前的淡出由外层权重包络负责，而不是在 keyframe 里硬切。
 */
export function sampleGesture(gesture: GestureDef, t: number): PoseQuats {
  const clamped = Math.max(0, Math.min(gesture.duration, t))
  const frames = gesture.keyframes
  const first = frames[0]
  if (!first) return new Map<string, Quat>()

  // 所有骨并集（关键帧里出现过的都参与采样）。
  const bones = new Set<string>()
  for (const frame of frames) {
    for (const bone of Object.keys(frame.pose)) bones.add(bone)
  }
  const out = new Map<string, Quat>()
  if (bones.size === 0) return out

  // 找区间 [i, i+1]（clamped 落在关键帧之间）。
  let upper = frames.length - 1
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i]!.at > clamped) {
      upper = i
      break
    }
  }
  const lower = Math.max(0, upper - 1)
  const a = frames[lower]!
  const b = frames[upper]!
  const span = b.at - a.at
  const localT = span > 1e-6 ? Math.max(0, Math.min(1, (clamped - a.at) / span)) : 1
  for (const bone of bones) {
    const qa = a.pose[bone] ? eulerDegToQuat(a.pose[bone]!) : IDENTITY_QUAT
    const qb = b.pose[bone] ? eulerDegToQuat(b.pose[bone]!) : IDENTITY_QUAT
    out.set(bone, slerpQuat(qa, qb, localT))
  }
  return out
}

/** 姿态表 + 手势自检（供单测/启动自检调用）。 */
export { validatePoseDef, validatePoseTable } from '../skeleton'
