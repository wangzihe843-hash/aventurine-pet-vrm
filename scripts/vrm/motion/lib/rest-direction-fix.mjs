/**
 * Rest 姿态方向修正（Fix A：per-bone swing correction）。
 *
 * 背景（V3 调查，见 docs/vrm-motion-hsr.md）：世界旋转 delta 重定标
 *   target_pose = D_target · target_rest   （D_target = R_align · D_hsr · R_alignᵀ）
 * 只有在「源 rest 方向 ≈ 目标 rest 方向（对齐后）」时才精确。HSR 源 rest 是 A-pose
 * （手臂下斜 54.6°），目标 VRM rest 由 A-pose 换成规范 T-pose（手臂水平），差 54.6°；
 * 手/手指差 51–88°。若不修正，所有手臂姿势会带一个常量偏转（手离身体/膝盖/头 10+cm）。
 *
 * 修正公式：对每根骨求世界系 swing
 *   C_b = swing( v_target_rest , R_align · u_source_rest )
 * 再把它右乘进 world delta：
 *   D_fixed = D_target · C_b
 * 于是 target_pose 的骨方向 = D_target · (R_align·u_source_rest)，
 * 即**方向与源绝对方向一致**（数学上等价于方向重定标；twist 保留原 delta 语义）。
 *
 * 只对需要修正的组（默认上臂/前臂/手 + 30 手指）应用；躯干/腿/脚不修：
 * - 躯干 chest/upperChest/neck 的 rest 方向差异 ≤0.6°（目标无 upperChest 时用 chest 合并映射）；
 * - 脚/脚趾 14° 差异是 足先EX 骨骼语义差异（不是真实姿势差），修了反而穿地。
 */
import { qRotateVec, qSwingFromTo } from './quat.mjs'
import { HSR_BONE_NEXT, resolveHumanoidNext } from './humanoid-hsr.mjs'

/** 默认修正组：上臂 / 前臂 / 手 / 30 手指。 */
export const REST_FIX_DEFAULT_PATTERN = /^(left|right)(UpperArm|LowerArm|Hand)$|Thumb|Index|Middle|Ring|Little/

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const unit = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}
const vecAngleDeg = (a, b) =>
  (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI

/**
 * 源 rest 骨方向（armature space；叶骨用 parent→own）。
 *
 * `boneNext` 是可插拔 source 的「解剖链下一根」表（默认 HSR 的 `HSR_BONE_NEXT`；
 * Biped 由 `lib/humanoid-biped.mjs` 生成）。不传时行为与旧实现完全一致。
 *
 * @param {Record<string, { head: number[], parent?: string | null }>} hsrRest
 * @param {string} hsrBone
 * @param {Record<string, string | null> | Map<string, string | null>} [boneNext]
 */
export function sourceRestDirection(hsrRest, hsrBone, boneNext = HSR_BONE_NEXT) {
  const bone = hsrRest?.[hsrBone]
  if (!bone) return null
  const hasKey =
    boneNext instanceof Map
      ? boneNext.has(hsrBone)
      : Object.prototype.hasOwnProperty.call(boneNext ?? {}, hsrBone)
  const next = hasKey ? (boneNext instanceof Map ? boneNext.get(hsrBone) : boneNext[hsrBone]) : undefined
  if (next && hsrRest[next]) return unit(sub(hsrRest[next].head, bone.head))
  const parent = bone.parent
  if (!parent || !hsrRest[parent]) return null
  return unit(sub(bone.head, hsrRest[parent].head))
}

/** 目标 VRM rest 骨方向（scene space；叶骨用 parent→own）。 */
export function targetRestDirection(vrmRest, vrmName) {
  const bone = vrmRest?.humanoid?.[vrmName]
  if (!bone) return null
  const next = resolveHumanoidNext(vrmName, vrmRest)
  if (next) return unit(sub(vrmRest.humanoid[next].position, bone.position))
  const parent = vrmRest.effectiveParent?.[vrmName]
  if (!parent || !vrmRest.humanoid?.[parent]) return null
  return unit(sub(bone.position, vrmRest.humanoid[parent].position))
}

/**
 * 计算全部修正。
 * @param {{
 *   hsrRest: Record<string, { head: number[], quat: number[], parent: string|null }>,
 *   vrmRest: any,
 *   mapping: Record<string, string>, // vrmName → hsrBone / 源骨名（target-aware）
 *   alignment: { quat: number[] },
 *   pattern?: RegExp,
 *   minMismatchDeg?: number,
 *   sourceNext?: Record<string, string | null> | Map<string, string | null> // 源骨解剖链下一根（默认 HSR）
 * }} args
 */
export function buildRestDirectionFix({
  hsrRest,
  vrmRest,
  mapping,
  alignment,
  pattern = REST_FIX_DEFAULT_PATTERN,
  minMismatchDeg = 0.5,
  sourceNext = HSR_BONE_NEXT
}) {
  /** @type {Map<string, { mismatchDeg: number, quat: number[], hsrBone: string }>} */
  const corrections = new Map()
  /** @type {Array<{ vrmName: string, hsrBone: string, group: string, mismatchDeg: number }>} */
  const rows = []
  const groupOf = (name) =>
    /UpperArm/.test(name)
      ? 'upperArm'
      : /LowerArm/.test(name)
        ? 'lowerArm'
        : /Hand$/.test(name)
          ? 'hand'
          : /Thumb|Index|Middle|Ring|Little/.test(name)
            ? 'fingers'
            : 'other'
  for (const [vrmName, hsrBone] of Object.entries(mapping ?? {})) {
    if (!pattern.test(vrmName)) continue
    const sourceDir = sourceRestDirection(hsrRest, hsrBone, sourceNext)
    const targetDir = targetRestDirection(vrmRest, vrmName)
    if (!sourceDir || !targetDir) continue
    const mappedSourceDir = qRotateVec(alignment.quat, sourceDir)
    const mismatchDeg = vecAngleDeg(targetDir, mappedSourceDir)
    rows.push({ vrmName, hsrBone, group: groupOf(vrmName), mismatchDeg: Number(mismatchDeg.toFixed(2)) })
    if (mismatchDeg > minMismatchDeg) {
      corrections.set(vrmName, {
        mismatchDeg: Number(mismatchDeg.toFixed(2)),
        quat: qSwingFromTo(targetDir, mappedSourceDir),
        hsrBone
      })
    }
  }
  const groups = {}
  let maxMismatchDeg = 0
  for (const row of rows) {
    const group = (groups[row.group] ??= { count: 0, corrected: 0, maxDeg: 0, meanDeg: 0, sum: 0 })
    group.count += 1
    group.sum += row.mismatchDeg
    group.maxDeg = Math.max(group.maxDeg, row.mismatchDeg)
    maxMismatchDeg = Math.max(maxMismatchDeg, row.mismatchDeg)
    if (corrections.has(row.vrmName)) group.corrected += 1
  }
  for (const group of Object.values(groups)) {
    group.meanDeg = Number((group.sum / group.count).toFixed(2))
    group.maxDeg = Number(group.maxDeg.toFixed(2))
    delete group.sum
  }
  return {
    corrections,
    rows,
    groups,
    stats: {
      bones: corrections.size,
      maxMismatchDeg: Number(maxMismatchDeg.toFixed(2)),
      applied: corrections.size > 0
    }
  }
}
