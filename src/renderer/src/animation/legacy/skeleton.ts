/**
 * 骨骼白名单 / 骨架常量 / 姿态数据自检（纯常量 + 纯函数，**不 import three**）。
 *
 * 关键事实（`docs/anim-tech-survey.md` §2.4 实测，违反即「姿态看不见」）：
 * - 腿的蒙皮权重全在 **D 链**（`左足D/左ひざD/左足首D`），IK 链 `足/ひざ/足首` 权重为 0；
 * - 眼球的蒙皮权重全在 **`左目先/右目先`**，`目/両目` 权重为 0 且 `両目` 只有 0.3 有效增益；
 * - `肩P`（只动肩部网格、手臂被 `肩C` 反向抵消）、`捩骨`、`腰`、`腰キャンセル` 一律不写；
 * - B3 只写 `bone.quaternion` + `センター.position`，不跑 grant/CCDIK/helper。
 *
 * 本文件的常量被姿态数据自检（`validatePoseDef`/`validatePoseTable`）与运行时启动自检共用；
 * 单测锁死「姿态数据不得引用禁用骨、不得漏写左右臂」。
 */
import type { GestureDef, PoseDef, PoseMeta } from './types'

/** 躯干/头（层混合的主要受控骨）。 */
export const TORSO_BONES = ['上半身', '上半身2', '首', '頭'] as const

/** 肩/臂/手（角色「手是第二张脸」，待机与反应主要靠这批骨）。 */
export const ARM_BONES = [
  '左肩',
  '右肩',
  '左腕',
  '右腕',
  '左ひじ',
  '右ひじ',
  '左手首',
  '右手首'
] as const

/** 骨盆与腿（腿在接地姿态会被解析二骨 IK 覆盖；姿态表里的腿角只用于非接地姿态）。 */
export const LEG_BONES = [
  '下半身',
  '左足D',
  '右足D',
  '左ひざD',
  '右ひざD',
  '左足首D',
  '右足首D'
] as const

/** 眼球骨（look-at 用；**覆盖式**，不参与姿态混合）。 */
export const EYE_BONES = ['左目先', '右目先'] as const

/**
 * 手指微动骨（「活人感」微动层用；**不由姿态表 authoring**，只做 ±2–3° 收放）。
 * 用户反馈「僵硬」后新增：每只手取 2 节人指/中指 + 1 节小指，成本 10 根骨、视觉收益明显。
 */
export const MICRO_BONES = [
  '左人指１',
  '左人指２',
  '左人指３',
  '左中指１',
  '左中指２',
  '左中指３',
  '左薬指１',
  '左薬指２',
  '左薬指３',
  '左小指１',
  '左小指２',
  '左小指３',
  '左親指１',
  '左親指２',
  '右人指１',
  '右人指２',
  '右人指３',
  '右中指１',
  '右中指２',
  '右中指３',
  '右薬指１',
  '右薬指２',
  '右薬指３',
  '右小指１',
  '右小指２',
  '右小指３',
  '右親指１',
  '右親指２'
] as const

/**
 * 姿态表允许出现的骨（= 混合器/世界旋转链会写到的骨）。
 * 注意：`センター` 不在此列——它只允许 `position` 平移与元数据里的 centerRollDeg，
 * 不允许被姿态 keyframe 随意旋转（避免与 B2/Lead 的 root 层打架）。
 */
export const POSE_CONTROLLED_BONES: readonly string[] = [
  ...TORSO_BONES,
  ...ARM_BONES,
  ...LEG_BONES
]

/** 允许被 verlet 弹簧写的次级骨（不在姿态白名单内，只能由 spring 层写）。 */
export const SPRING_BONES: readonly string[] = [
  // 发辫（主辫 4 + 副辫 1 + 碎发 1；辮子1-1 是挂点不积分）
  '辮子1-2',
  '辮子1-3',
  '辮子1-4',
  '辮子1-5',
  '辮子2-1',
  '辮碎髮',
  // 袖子（v2 新增：左袖权重 360 最显眼；身体一动袖子就摆 = 用户要的「关节动起来」）
  '左袖帶1-1',
  '左袖帶1-2',
  '左袖帶1-3',
  '左袖帶1-4',
  '左袖帶1-5',
  '右袖帶1-1',
  '右袖帶1-2',
  '右袖帶1-3',
  '右袖帶1-4',
  '右袖帶1-5'
]

/**
 * 明确禁用（写了也不动/会破坏 grant 链/被 IK 覆盖）。姿态自检遇到即报错。
 * 这是 R1 风险的自动化防线（附录 A.6 / §2.8 K1/K2/K9）。
 */
export const FORBIDDEN_BONES: readonly string[] = [
  // IK 链（0 权重）
  '左足',
  '右足',
  '左ひざ',
  '右ひざ',
  '左足首',
  '右足首',
  '左つま先',
  '右つま先',
  // IK 目标（不跑 CCDIK）
  '左足ＩＫ',
  '右足ＩＫ',
  '左つま先ＩＫ',
  '右つま先ＩＫ',
  '左足IK親',
  '右足IK親',
  // 眼控（0 权重；眼球在 目先 上）
  '左目',
  '右目',
  '両目',
  '両目先',
  // grant 链（±1 / 定比，写了会破坏抵消关系）
  '左肩P',
  '右肩P',
  '左肩C',
  '右肩C',
  '腰',
  '腰キャンセル左',
  '腰キャンセル右',
  '左腕捩',
  '右腕捩',
  '左腕捩1',
  '左腕捩2',
  '左腕捩3',
  '右腕捩1',
  '右腕捩2',
  '右腕捩3',
  '左手捩',
  '右手捩',
  '左手捩1',
  '左手捩2',
  '左手捩3',
  '右手捩1',
  '右手捩2',
  '右手捩3',
  // 根/整体（B3 不碰，交给 Lead/B2）
  '全ての親',
  '操作中心',
  'グルーブ'
]

/**
 * 启动自检必需骨（缺失 → `missingBones` + console.warn，不抛）。
 * 来源：survey 附录 A.6 + 发辫链 + 眼球。
 */
export const REQUIRED_BONES: readonly string[] = [
  'センター',
  ...TORSO_BONES,
  ...ARM_BONES,
  ...LEG_BONES,
  ...EYE_BONES,
  '辮子1-1',
  ...SPRING_BONES
]

/** 弹簧链可覆盖参数（缺省用 `DEFAULT_SPRING_PARAMS`；袖子类布料更硬）。 */
export interface SpringChainParamsOverride {
  stiffness?: number
  damping?: number
  gravity?: number
  inertia?: number
  maxAngularSpeed?: number
}

/** 发辫/碎发/袖子弹簧链（父骨 → 关节顺序；首关节的父骨用于取世界旋转）。 */
export interface SpringChainDef {
  id: string
  /** 关节骨名（从根部到尖部）。 */
  joints: readonly string[]
  /** 第一个关节的父骨名（用于取世界旋转；其余关节父 = 前一关节）。 */
  rootParent: string
  /** 可选参数覆盖（袖子更硬/重力更小）。 */
  params?: SpringChainParamsOverride
}

/**
 * 7 根发辫弹簧骨（4 根主辫 + 副辫 + 碎发 = 6 根参与积分；`辮子1-1` 是挂点不参与）。
 * 任务书写作「7 根」时把挂点 `辮子1-1` 也算上了；按 survey §6.2/D9 只积分 6 根。
 * 袖子弹簧（`左袖帶1-3..1-5`）Wave 2 默认关闭（survey 建议留开关）。
 */
export const SPRING_CHAINS: readonly SpringChainDef[] = [
  { id: 'braid1', joints: ['辮子1-2', '辮子1-3', '辮子1-4', '辮子1-5'], rootParent: '頭' },
  { id: 'braid2', joints: ['辮子2-1'], rootParent: '辮子1-4' },
  { id: 'bang', joints: ['辮碎髮'], rootParent: '頭' },
  // 袖子：左侧挂点在腕（左袖帶1-0 是 identity 中间骨），右侧挂点在右ひじ（模型结构如此）。
  {
    id: 'sleeveL',
    joints: ['左袖帶1-1', '左袖帶1-2', '左袖帶1-3', '左袖帶1-4', '左袖帶1-5'],
    rootParent: '左腕',
    params: { stiffness: 40, damping: 9.5, gravity: 0.8, inertia: 0.55, maxAngularSpeed: 10 }
  },
  {
    id: 'sleeveR',
    joints: ['右袖帶1-1', '右袖帶1-2', '右袖帶1-3', '右袖帶1-4', '右袖帶1-5'],
    rootParent: '右ひじ',
    params: { stiffness: 40, damping: 9.5, gravity: 0.8, inertia: 0.55, maxAngularSpeed: 10 }
  }
]

/** 头部世界旋转链（自下而上；用于发辫弹簧的父世界四元数 / 调试）。 */
export const HEAD_WORLD_CHAIN: readonly string[] = ['上半身', '上半身2', '首', '頭']

/** 一条肢体链（接地 IK 用）。 */
export interface LegChainDef {
  /** 'left' | 'right' */
  side: 'left' | 'right'
  /** 髋关节骨（D 链第一根 = 大腿）。 */
  thigh: string
  /** 膝关节骨。 */
  shin: string
  /** 踝关节骨（脚/鞋主权重）。 */
  foot: string
  /** 骨盆（腿链的旋转父骨；B3 只写它、不写 `腰`）。 */
  pelvis: string
}

/** 腿 D 链（**绝不写 IK 链**）。 */
export const LEG_CHAINS: readonly LegChainDef[] = [
  { side: 'left', thigh: '左足D', shin: '左ひざD', foot: '左足首D', pelvis: '下半身' },
  { side: 'right', thigh: '右足D', shin: '右ひざD', foot: '右足首D', pelvis: '下半身' }
]

/** 姿态角合法范围（度）：允许大幅度坐/睡姿态，但拒绝 180°+ 的明显写错。 */
export const POSE_ANGLE_LIMIT_DEG = 170

/** 姿态数据自检结果。 */
export interface PoseValidation {
  ok: boolean
  errors: string[]
}

/** 单姿态自检：骨名白名单 / 禁用骨 / 角度范围 / 非零骨数量。 */
export function validatePoseDef(
  id: string,
  def: PoseDef,
  /** 允许空姿态（手势关键帧用 `{}` 表示回到基础姿态，见 poses/gestures.ts）。 */
  allowEmpty = false
): PoseValidation {
  const errors: string[] = []
  const names = Object.keys(def)
  if (!allowEmpty && names.length === 0) errors.push(`pose "${id}" 为空（至少要含站姿手臂骨）`)
  for (const name of names) {
    if (FORBIDDEN_BONES.includes(name)) {
      errors.push(`pose "${id}" 引用了禁用骨 "${name}"（K1/K2：该骨权重为 0 或会破坏 grant）`)
      continue
    }
    if (!POSE_CONTROLLED_BONES.includes(name)) {
      errors.push(`pose "${id}" 引用了白名单外的骨 "${name}"`)
      continue
    }
    const euler = def[name] ?? {}
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = euler[axis]
      if (value === undefined) continue
      if (!Number.isFinite(value)) {
        errors.push(`pose "${id}" 骨 "${name}" 的 ${axis} 不是有限数`)
        continue
      }
      if (Math.abs(value) > POSE_ANGLE_LIMIT_DEG) {
        errors.push(
          `pose "${id}" 骨 "${name}" 的 ${axis}=${value}° 超出 ±${POSE_ANGLE_LIMIT_DEG}°`
        )
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 全姿态表 + 手势自检：id 唯一、meta 与姿态表对齐、站姿必须含双臂（防 A-pose 回归）。 */
export function validatePoseTable(
  table: Readonly<Record<string, PoseDef>>,
  metas: Readonly<Record<string, PoseMeta>>,
  gestures: readonly GestureDef[] = []
): PoseValidation {
  const errors: string[] = []
  for (const [id, def] of Object.entries(table)) {
    errors.push(...validatePoseDef(id, def).errors)
  }
  for (const id of Object.keys(metas)) {
    if (!Object.prototype.hasOwnProperty.call(table, id)) {
      errors.push(`meta "${id}" 没有对应姿态定义`)
    }
  }
  for (const id of Object.keys(table)) {
    if (!Object.prototype.hasOwnProperty.call(metas, id)) {
      errors.push(`姿态 "${id}" 缺少 meta（贴地/重心信息）`)
    }
  }
  const stand = table.stand
  if (!stand) {
    errors.push('缺少基础姿态 "stand"')
  } else {
    for (const required of ['左腕', '右腕', '首', '頭', '上半身', '下半身']) {
      if (!Object.prototype.hasOwnProperty.call(stand, required)) {
        errors.push(`stand 必须含 "${required}"（否则保持 A-pose）`)
      }
    }
  }
  const gestureIds = new Set<string>()
  for (const gesture of gestures) {
    if (gestureIds.has(gesture.id)) errors.push(`手势 id 重复 "${gesture.id}"`)
    gestureIds.add(gesture.id)
    if (!(gesture.duration > 0)) errors.push(`手势 "${gesture.id}" duration 必须 > 0`)
    if (gesture.keyframes.length < 2) errors.push(`手势 "${gesture.id}" 至少 2 个关键帧`)
    let lastAt = -Infinity
    for (const frame of gesture.keyframes) {
      if (!(frame.at >= 0)) errors.push(`手势 "${gesture.id}" 关键帧 at 必须 ≥ 0`)
      if (frame.at <= lastAt) errors.push(`手势 "${gesture.id}" 关键帧 at 必须严格递增`)
      lastAt = frame.at
      errors.push(...validatePoseDef(`${gesture.id}@${frame.at}`, frame.pose, true).errors)
    }
    const last = gesture.keyframes[gesture.keyframes.length - 1]
    if (last && last.at > gesture.duration + 1e-6) {
      errors.push(`手势 "${gesture.id}" 关键帧超出 duration`)
    }
    if (gesture.mask) {
      for (const bone of gesture.mask) {
        if (!POSE_CONTROLLED_BONES.includes(bone)) {
          errors.push(`手势 "${gesture.id}" mask 含非受控骨 "${bone}"`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}
