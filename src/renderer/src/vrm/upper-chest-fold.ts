/**
 * upperChest α-fold（目标 avatar 缺 upperChest 时的 VRMA 兼容规则）
 *
 * 背景（`docs/research/mate-female-to-male-joint-plan-2026-11-11.md` §2.1/§4.1）：
 * clip 数据来自带 upperChest 的源骨架，而目标 VRM 1.0 模型可能没有该骨（本仓库的
 * `aventurine-tpose.vrm` 即如此）。若直接丢弃 `UpperChest` 轨道，neck/leftShoulder/
 * rightShoulder/head 的世界朝向会相对源骨架 counter-rotate |U|（误差角恰好 = |U|）。
 *
 * 官方修法（VRMA `how_to_transform_human_pose`）：目标少骨时，把 upperChest 的旋转
 * 乘到其直接子骨（neck、leftShoulder、rightShoulder）上——“the neck, leftShoulder,
 * and rightShoulder of the destination model should be transformed by both the rotation
 * of upperChest and the rotation of the bone itself by multiplying the two”。
 * 本模块把它连续化为 α-fold（α ∈ [0,1]）：
 *
 *   q_chest'          = q_chest · U^α
 *   q_child'          = U^(1-α) · q_child   （child = neck / leftShoulder / rightShoulder）
 *   U^α               = slerp(I, U, α)
 *
 * 恒等式（任意 α，四元数乘法结合律）：
 *   q_chest' · q_child' = q_chest · U^α · U^(1-α) · q_child = q_chest · U · q_child
 * 即 neck/shoulder/head 的**世界朝向精确恢复**；α 只决定 U 在 chest 网格与子骨之间的
 * 分配（α=0 = 规范推荐 child absorb；α=1 = HSR 管线风格 chest absorb）。
 *
 * 纯逻辑模块：不 import three / DOM / Electron / node:*；四元数约定与
 * `clip-data.ts` 一致（`[x,y,z,w]`，Hamilton 乘法，`(a·b)` 表示先 b 后 a）。
 */
import { slerpQuat, type Quat4 } from './clip-data'

/**
 * 默认 α（0–1）：1 = chest 吸收全部 U、子骨不变（与 HSR 管线一致）。
 * 后续 A/B 调参只改这一个常量（或调用方显式传参）。
 */
export const UPPER_CHEST_FOLD_ALPHA = 1

/** 判定「U 为 identity」的旋转角容差（弧度；≈0.000057°）。 */
export const UPPER_CHEST_IDENTITY_EPS_RAD = 1e-6

/** 单位四元数（本模块返回值不会共享该可变数组给调用方以外的位置）。 */
const IDENTITY_QUAT: Quat4 = [0, 0, 0, 1]

/** α-fold 的计算结果（新数组，不修改入参）。 */
export interface UpperChestFoldResult {
  /**
   * 折叠后的 chest normalized 旋转 = `chest · U^α`。
   * `upperChest === null` / U 为 identity 时等于输入 `chest` 的副本。
   */
  chest: Quat4
  /**
   * 子骨（neck/leftShoulder/rightShoulder）左乘乘子 = `U^(1-α)`。
   * 未折叠 / U 为 identity / α=1 时为 identity。
   */
  childMultiplier: Quat4
  /** 是否真正发生了折叠（U 非 null 且非 identity）。false 时两个输出都等于输入/identity。 */
  applied: boolean
}

/** 归一化四元数副本（零/非有限长度回退 identity）。 */
function normalizedCopy(q: readonly number[]): Quat4 {
  const length = Math.hypot(q[0], q[1], q[2], q[3])
  if (!Number.isFinite(length) || length < 1e-12) return [...IDENTITY_QUAT]
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}

/** α 非法（NaN/Infinity）时回退默认值；否则钳制到 [0,1]。 */
function normalizeAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) return UPPER_CHEST_FOLD_ALPHA
  return Math.min(1, Math.max(0, alpha))
}

/**
 * 四元数旋转角（弧度，[0, π]；q/-q 等价，按 |w| 计算）。
 * 输入不需要预先归一化（内部按长度归一）。
 */
export function quatAngleRad(q: readonly number[]): number {
  const length = Math.hypot(q[0], q[1], q[2], q[3])
  if (!Number.isFinite(length) || length < 1e-12) return 0
  const w = Math.min(1, Math.max(-1, Math.abs(q[3] / length)))
  return 2 * Math.acos(w)
}

/** 是否与 identity 等价（旋转角 ≤ `epsRad`；q/-q 等价）。 */
export function isIdentityQuat(q: readonly number[], epsRad = UPPER_CHEST_IDENTITY_EPS_RAD): boolean {
  return quatAngleRad(q) <= (Number.isFinite(epsRad) ? Math.max(0, epsRad) : 0)
}

/**
 * 四元数乘法 `out = a · b`（Hamilton；与 three.js `a.multiply(b)` 同约定）。
 * 支持 `out` 与 `a`/`b` 指向同一数组（先读出全部分量再写）。
 */
export function multiplyQuat(
  a: readonly number[],
  b: readonly number[],
  out: Quat4 = [0, 0, 0, 1]
): Quat4 {
  const ax = a[0]
  const ay = a[1]
  const az = a[2]
  const aw = a[3]
  const bx = b[0]
  const by = b[1]
  const bz = b[2]
  const bw = b[3]
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

/**
 * 把源骨架的 `UpperChest` 归一化旋转 `U` 折叠进目标缺 upperChest 的骨链。
 *
 * @param chest 目标 chest 的 normalized 旋转（`[x,y,z,w]`；本轮 crossfade 已混合后的值）
 * @param upperChest 本帧的 `UpperChest` normalized 旋转（`[x,y,z,w]`）；null = 无轨道/无该骨
 * @param alpha 分配系数（0 = 子骨吸收全部 U；1 = chest 吸收全部 U；默认 `UPPER_CHEST_FOLD_ALPHA`）
 * @returns 折叠后的 chest 与子骨左乘乘子（`q_child' = childMultiplier · q_child`）
 *
 * 纯函数：不修改入参，不做任何 three/DOM 依赖。
 */
export function foldUpperChest(
  chest: readonly number[],
  upperChest: readonly number[] | null,
  alpha: number = UPPER_CHEST_FOLD_ALPHA
): UpperChestFoldResult {
  const unchangedChest: Quat4 = [chest[0], chest[1], chest[2], chest[3]]
  const noChildMultiplier: Quat4 = [...IDENTITY_QUAT]
  if (upperChest === null) {
    return { chest: unchangedChest, childMultiplier: noChildMultiplier, applied: false }
  }
  const u = normalizedCopy(upperChest)
  if (isIdentityQuat(u)) {
    return { chest: unchangedChest, childMultiplier: noChildMultiplier, applied: false }
  }
  const foldAlpha = normalizeAlpha(alpha)
  // U^α = slerp(I, U, α)；U^(1-α) = slerp(I, U, 1-α)。
  // 两个指数走同一条短弧测地线，乘起来在 SO(3) 上等于 U（q/-q 不影响旋转）。
  const chestMultiplier = slerpQuat(IDENTITY_QUAT, u, foldAlpha, [0, 0, 0, 1])
  const childMultiplier = slerpQuat(IDENTITY_QUAT, u, 1 - foldAlpha, [0, 0, 0, 1])
  const foldedChest = multiplyQuat(chest, chestMultiplier)
  return { chest: foldedChest, childMultiplier, applied: true }
}
