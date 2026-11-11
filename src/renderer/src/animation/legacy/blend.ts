/**
 * 分层姿态混合器（方案 B 的核心；**纯函数，不 import three**）。
 *
 * 层顺序**固定**（单测锁死）：基础姿态 → 呼吸/微动(additive) → 反应 overlay(mask) → look-at(additive) → 弹簧（弹簧在管线最后单独写）。
 * 顺序变了观感就变，所以顺序常量 `LAYER_ORDER` 与 `blendLayers` 的入参顺序必须一致。
 *
 * 语义：
 * - **覆盖层**（`additive: false`）：逐骨 `slerp(base, q, weight)`；
 * - **additive 层**：逐骨 `base * scaleAngle(q, weight)`（把该层旋转角度按权重缩放后乘上去）；
 * - `mask`：只有 mask 内的骨受影响；未列出的骨不写 → 保持当前累积值（最终 = 恒等/rest）；
 * - 权重 / 角度统一钳制，未知骨不报错（由姿态自检/单测保证不出现）。
 */
import {
  IDENTITY_QUAT,
  clamp,
  multiplyQuat,
  normalizeQuat,
  quatToRotationVector,
  rotationVectorToQuat,
  slerpQuat,
  smoothstep
} from './quat'
import type { PoseQuats, Quat } from './types'

/** 层顺序（调试/测试用；实际顺序 = 调用方给出的 layers 数组顺序）。 */
export const LAYER_ORDER = ['base', 'breath', 'overlay', 'lookAt', 'spring'] as const

/** 层 id 类型。 */
export type LayerId = (typeof LAYER_ORDER)[number]

/** 一个混合层。 */
export interface PoseLayer {
  id: LayerId | string
  /** 骨名 → 该层局部旋转偏移。 */
  pose: PoseQuats
  /** 层权重 0..1（钳制后使用）。 */
  weight: number
  /** 只影响这些骨（undefined = pose 里列出的骨全生效）。 */
  mask?: ReadonlySet<string>
  /** additive：base × 缩放后的旋转；否则与 base 做 slerp（覆盖式）。 */
  additive?: boolean
}

/** 把四元数角度按权重缩放（additive 层用；保持轴不变）。 */
export function scaleQuatAngle(q: Quat, weight: number): Quat {
  const w = clamp(weight, 0, 1)
  if (w >= 1) return normalizeQuat(q)
  if (w <= 0) return { ...IDENTITY_QUAT }
  const rv = quatToRotationVector(q)
  return rotationVectorToQuat({ x: rv.x * w, y: rv.y * w, z: rv.z * w })
}

/**
 * 逐层混合。
 * @param layers 顺序 = 优先级（先基础、再 additive、最后 look-at）
 * @param out 可选复用 Map（热路径零分配）；缺省新建。
 */
export function blendLayers(layers: readonly PoseLayer[], out?: PoseQuats): PoseQuats {
  const accum = out ?? new Map<string, Quat>()
  accum.clear()
  for (const layer of layers) {
    const weight = clamp(layer.weight, 0, 1)
    if (weight <= 0) continue
    for (const [bone, q] of layer.pose) {
      if (layer.mask && !layer.mask.has(bone)) continue
      const base = accum.get(bone) ?? IDENTITY_QUAT
      const next = layer.additive
        ? normalizeQuat(multiplyQuat(base, scaleQuatAngle(q, weight)))
        : slerpQuat(base, q, weight)
      accum.set(bone, next)
    }
  }
  return accum
}

/**
 * 错峰混合（v2 生动性）：每根骨有各自的延迟，避免「所有骨同时到达」的木偶感。
 * delay 由 `delayFor(bone)` 给出（秒）；实际时长 = max(0.06, duration − delay)。
 */
export function blendPoseMapsStaggered(
  from: PoseQuats,
  to: PoseQuats,
  elapsed: number,
  duration: number,
  delayFor: (bone: string) => number
): PoseQuats {
  const out = new Map<string, Quat>()
  const names = new Set<string>()
  for (const name of from.keys()) names.add(name)
  for (const name of to.keys()) names.add(name)
  const safeDuration = Math.max(1e-4, duration)
  for (const name of names) {
    const a = from.get(name)
    const b = to.get(name)
    const delay = Math.max(0, Math.min(safeDuration * 0.6, delayFor(name)))
    const span = Math.max(0.06, safeDuration - delay)
    const t = smoothstep((elapsed - delay) / span)
    if (a && b) out.set(name, slerpQuat(a, b, t))
    else if (b) out.set(name, slerpQuat(IDENTITY_QUAT, b, t))
    else if (a) out.set(name, slerpQuat(a, IDENTITY_QUAT, t))
  }
  return out
}

/** 把两个同骨集姿态按 smoothstep 权重插值（pose-machine 内部用）。 */
export function blendPoseMaps(from: PoseQuats, to: PoseQuats, t: number): PoseQuats {
  const out = new Map<string, Quat>()
  const names = new Set<string>()
  for (const name of from.keys()) names.add(name)
  for (const name of to.keys()) names.add(name)
  for (const name of names) {
    const a = from.get(name)
    const b = to.get(name)
    if (a && b) out.set(name, slerpQuat(a, b, t))
    else if (b) out.set(name, slerpQuat(IDENTITY_QUAT, b, t))
    else if (a) out.set(name, slerpQuat(a, IDENTITY_QUAT, t))
  }
  return out
}
