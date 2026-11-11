/**
 * B1 自主活动库 + 权重/冷却/上下文评分（纯函数；**不 import DOM / three / Electron / Node 内置**）。
 *
 * 设计依据：
 * - `docs/aventurine-character-brief.md` §4.2「6 个待机小动作变体（随机播放）」的权重与时长建议；
 * - `PLAN.md` §18.1 桌面伴侣「非侵入」结论：显眼行为用 **variable-time** 调度（非 variable-ratio）、
 *   活动抑制轴用「用户不在」而非「用户忙」；
 * - `docs/wave2-integration.md` §3-B1：活动受 `autonomousLevel`、窗口数量/位置、鼠标距离、DSH 状态影响。
 *
 * 说明：
 * - **所有随机只经调用方传入的 `random()`**（`BehaviorInput.random`），本文件不自带随机源；
 * - 活动不可用（缺表面/冷却中/鼠标在宠物上）时权重为 0，由 `pickWeightedActivity` 过滤；
 * - 「最短持续/冷却」由 `BehaviorDirector` 执行，本文件只声明参数。
 */
import type { AutonomousLevel } from '@shared/types'

import type {
  ActivityDefinition,
  ActivityId,
  ActivityRequirement,
  SchedulerContext
} from './types'

/** 待机小动作权重合计 100（brief §4.2）；其余活动在此基础上按上下文浮动。 */
export const ACTIVITY_DEFINITIONS: readonly ActivityDefinition[] = [
  {
    id: 'idle',
    debugId: 'idle',
    label: '站立待机',
    baseWeight: 10,
    minDurationMs: 4000,
    maxDurationMs: 9000,
    cooldownMs: 5_000,
    mood: 'idle',
    look: 'pointer',
    requirements: ['grounded'],
    schedulable: true,
    idleVariant: true
  },
  {
    // 待机变体 A：空手捻筹码（brief 认为最推荐：视线必须“看见”虚拟硬币）
    id: 'idleCoin',
    debugId: 'idle',
    label: '空手捻筹码',
    baseWeight: 25,
    minDurationMs: 3_200,
    maxDurationMs: 4_000,
    cooldownMs: 25_000,
    mood: 'idle',
    poseHint: 'idle:coin',
    look: 'none',
    requirements: ['grounded'],
    schedulable: true,
    idleVariant: true
  },
  {
    // 待机变体 B：抛接硬币看结果（接住后停半拍再收）
    id: 'idleToss',
    debugId: 'idle',
    label: '抛接硬币看结果',
    baseWeight: 18,
    minDurationMs: 2_800,
    maxDurationMs: 3_500,
    cooldownMs: 30_000,
    mood: 'idle',
    poseHint: 'idle:toss',
    look: 'none',
    requirements: ['grounded'],
    schedulable: true,
    idleVariant: true
  },
  {
    // 待机变体 C：整理衣领/袖口/手链（最安全、最“体面”，可高频）
    id: 'idleTidy',
    debugId: 'idle',
    label: '整理衣领/袖口',
    baseWeight: 22,
    minDurationMs: 2_500,
    maxDurationMs: 3_500,
    cooldownMs: 20_000,
    mood: 'idle',
    poseHint: 'idle:tidy',
    look: 'pointer',
    requirements: ['grounded'],
    schedulable: true,
    idleVariant: true
  },
  {
    // 待机变体 D：伸懒腰/转脖子（久坐/长时间未互动时加权）
    id: 'idleStretch',
    debugId: 'idle',
    label: '伸懒腰',
    baseWeight: 15,
    minDurationMs: 3_500,
    maxDurationMs: 4_500,
    cooldownMs: 45_000,
    mood: 'idle',
    poseHint: 'idle:stretch',
    look: 'none',
    requirements: ['grounded'],
    schedulable: true,
    idleVariant: true
  },
  {
    // 待机变体 E：望远处发呆（负责“孤独底色”，低频率）
    id: 'idleGaze',
    debugId: 'idle',
    label: '望远处发呆',
    baseWeight: 12,
    minDurationMs: 6_000,
    maxDurationMs: 8_000,
    cooldownMs: 60_000,
    mood: 'idle',
    poseHint: 'idle:gaze',
    look: 'randomFar',
    requirements: ['grounded'],
    schedulable: true,
    idleVariant: true,
    bubblePool: 'idle'
  },
  {
    // 待机变体 F：对用户两指敬礼/招手（只在鼠标靠近时）
    id: 'idleSalute',
    debugId: 'idle',
    label: '对用户两指敬礼',
    baseWeight: 8,
    minDurationMs: 1_500,
    maxDurationMs: 2_500,
    cooldownMs: 40_000,
    mood: 'idle',
    poseHint: 'idle:salute',
    look: 'pointer',
    requirements: ['grounded', 'pointerNear'],
    schedulable: true,
    idleVariant: true
  },
  {
    // 四处看（看鼠标/四处看；随机远点，不追鼠标）
    id: 'lookAround',
    debugId: 'lookAround',
    label: '四处看',
    baseWeight: 12,
    minDurationMs: 2_500,
    maxDurationMs: 4_500,
    cooldownMs: 18_000,
    mood: 'idle',
    poseHint: 'idle:scan',
    look: 'randomFar',
    requirements: ['grounded'],
    schedulable: true
  },
  {
    // 走上/走下：在“当前所站表面”上随机走动（地面/窗口上沿都行）
    id: 'walkTo',
    debugId: 'walkTo',
    label: '走上/走下',
    baseWeight: 20,
    minDurationMs: 2_600,
    maxDurationMs: 5_200,
    cooldownMs: 12_000,
    mood: 'walk',
    poseHint: 'walk:stroll',
    look: 'none',
    requirements: ['grounded'],
    schedulable: true,
    energetic: true
  },
  {
    // 回到角落（右下角；与 A2 初始摆放口径一致，不硬编码 1080p 尺寸）
    id: 'returnCorner',
    debugId: 'walkTo',
    label: '回到角落',
    baseWeight: 10,
    minDurationMs: 3_000,
    maxDurationMs: 6_000,
    cooldownMs: 30_000,
    mood: 'walk',
    poseHint: 'walk:home',
    look: 'none',
    requirements: ['grounded'],
    schedulable: true,
    energetic: true
  },
  {
    // 爬窗沿：两段式路径（先水平走到窗口侧边下方，再沿边缘竖直上爬）——用户实机反馈修正，
    // 目标点算法见 behavior-director.ts 的 prepareClimbTarget/updateClimbActivity；
    // 爬完站在边缘（顶部中点属于独立 sit 活动），menubar 不参与落点。
    // 2026-11-08 用户实机反馈：爬窗动画（双臂高举）观感差、且坐姿无法贴窗沿；按用户要求
    // **移除爬窗自主行为**：不进随机池（baseWeight=0 + schedulable=false，`scoreActivity` 权重恒 0）。
    // 但仍保留 `triggerActivity('climb')` 调试显式触发用于人工排查（debug API 不受 schedulable
    // 约束，见 behavior-director.ts 的 triggerActivity）；自主调度永远不会选中它。
    id: 'climb',
    debugId: 'climb',
    label: '爬窗沿',
    baseWeight: 0,
    minDurationMs: 4_000,
    maxDurationMs: 10_000,
    cooldownMs: 30_000,
    mood: 'climb',
    poseHint: 'climb:window',
    look: 'none',
    requirements: ['climbableSurface'],
    schedulable: false,
    energetic: true
  },
  {
    // 坐到窗口上沿/Dock（brief 最高价值姿态：坐在窗沿看风暴）；menubar top=0 会渲染出视口，B1 不落座
    id: 'sit',
    debugId: 'sit',
    label: '坐窗沿',
    baseWeight: 24,
    // 2026-11-08：坐姿时长加长（像真的在窗边发呆）；且远距离接近时不会「没坐到就结束」。
    minDurationMs: 20_000,
    maxDurationMs: 35_000,
    cooldownMs: 25_000,
    mood: 'sit',
    poseHint: 'sit:window',
    look: 'pointer',
    requirements: ['sittableSurface'],
    schedulable: true
  },
  {
    // 睡觉：**2026-11-11 用户决定移出自动播放**——mate 的 sleep 动画是女体躺姿，
    // 套到男体后身体扭曲/贴地异常，暂不修不动数据；保留定义供调试 `triggerActivity('sleep')`
    // 排查用（schedulable=false 只约束自主随机调度，debug 显式触发不受限，同 climb）。
    id: 'sleep',
    debugId: 'sleep',
    label: '睡觉',
    baseWeight: 0,
    minDurationMs: 25_000,
    maxDurationMs: 45_000,
    cooldownMs: 120_000,
    mood: 'sleep',
    poseHint: 'sleep',
    look: 'none',
    requirements: ['grounded', 'mouseAway'],
    schedulable: false
  },
  {
    // 主动从窗口上沿跳下（低权重；落到地面由 B2 处理）
    id: 'dropDown',
    debugId: 'dropDown',
    label: '跳下窗口',
    baseWeight: 6,
    minDurationMs: 1_200,
    maxDurationMs: 2_000,
    cooldownMs: 45_000,
    mood: 'fall',
    poseHint: 'fall:jump',
    look: 'none',
    requirements: ['elevated'],
    schedulable: true,
    energetic: true
  },
  {
    // 事件驱动：窗口移动后跟随（不进随机池；由 DesktopSnapshot.transitions 触发）
    id: 'followWindow',
    debugId: 'followWindow',
    label: '跟随窗口',
    baseWeight: 0,
    minDurationMs: 1_000,
    maxDurationMs: 1_400,
    cooldownMs: 1_000,
    mood: 'walk',
    poseHint: 'follow:window',
    look: 'pointer',
    requirements: [],
    schedulable: false,
    energetic: false
  }
]

/** 按 id 索引（构造后不再变化）。 */
const ACTIVITY_BY_ID: ReadonlyMap<string, ActivityDefinition> = new Map(
  ACTIVITY_DEFINITIONS.map((definition) => [definition.id, definition])
)

/** 调试 `triggerActivity` 的别名（宽松一点，方便 Lead 冒烟/人工调试）。 */
const ACTIVITY_ALIASES: Readonly<Record<string, ActivityId>> = {
  walk: 'walkTo',
  stroll: 'walkTo',
  corner: 'returnCorner',
  home: 'returnCorner',
  sitting: 'sit',
  climbWindow: 'climb',
  jump: 'dropDown',
  toss: 'idleToss',
  coin: 'idleCoin',
  tidy: 'idleTidy',
  stretch: 'idleStretch',
  gaze: 'idleGaze',
  salute: 'idleSalute',
  scan: 'lookAround',
  follow: 'followWindow'
}

/** 按 id / 别名查找活动定义（未知返回 null）。 */
export function findActivityDefinition(activityId: string): ActivityDefinition | null {
  if (typeof activityId !== 'string') return null
  const direct = ACTIVITY_BY_ID.get(activityId)
  if (direct) return direct
  const alias = ACTIVITY_ALIASES[activityId]
  if (alias) return ACTIVITY_BY_ID.get(alias) ?? null
  return null
}

/** 各自主活动频率档位的节奏参数（时长单位 ms、速度单位 px/s）。 */
export interface LevelPace {
  /** 首次自主活动延迟区间。 */
  initialDelayMs: readonly [number, number]
  /** 两次自主活动之间的 idle 间隔。 */
  idleDelayMs: readonly [number, number]
  /** 活跃类活动权重系数。 */
  energyFactor: number
  /** 待机小动作权重系数。 */
  calmFactor: number
  /** 睡觉权重系数。 */
  sleepFactor: number
  /** 走路速度（B2 消费）。 */
  walkSpeedPxPerSec: number
  /** 攀爬速度（B2 消费）。 */
  climbSpeedPxPerSec: number
}

/** `low` 更安静（多站/坐/睡），`high` 更活跃（多走/爬/小动作）。 */
export const LEVEL_PACE: Readonly<Record<AutonomousLevel, LevelPace>> = {
  low: {
    initialDelayMs: [12_000, 22_000],
    idleDelayMs: [14_000, 28_000],
    energyFactor: 0.55,
    calmFactor: 1.35,
    sleepFactor: 1.35,
    walkSpeedPxPerSec: 62,
    climbSpeedPxPerSec: 28
  },
  normal: {
    initialDelayMs: [6_000, 12_000],
    idleDelayMs: [8_000, 18_000],
    energyFactor: 1,
    calmFactor: 1,
    sleepFactor: 1,
    walkSpeedPxPerSec: 86,
    climbSpeedPxPerSec: 40
  },
  high: {
    initialDelayMs: [3_200, 7_000],
    idleDelayMs: [4_200, 10_000],
    energyFactor: 1.55,
    calmFactor: 0.72,
    sleepFactor: 0.7,
    walkSpeedPxPerSec: 112,
    climbSpeedPxPerSec: 48
  }
}

/** 睡觉要求的最小闲置时长（活动抑制轴：用户不在且长时间无操作）。 */
export const SLEEP_MIN_IDLE_MS = 20_000
/** 睡觉要求的距最近一次交互的最小间隔。 */
export const SLEEP_MIN_SINCE_INTERACTION_MS = 12_000

/** 单个环境要求是否满足。 */
export function isRequirementMet(
  requirement: ActivityRequirement,
  context: SchedulerContext
): boolean {
  switch (requirement) {
    case 'grounded':
      return context.grounded
    case 'sittableSurface':
      return context.sittableSurfaceCount > 0
    case 'climbableSurface':
      return context.climbableSurfaceCount > 0
    case 'elevated':
      return context.elevated
    case 'pointerNear':
      return context.pointerNear
    case 'mouseAway':
      return (
        context.mouseAway &&
        context.idleElapsedMs >= SLEEP_MIN_IDLE_MS &&
        context.sinceInteractionMs >= SLEEP_MIN_SINCE_INTERACTION_MS
      )
    default:
      return false
  }
}

/** 活动是否处于冷却（nowMs < cooldownUntil）。 */
function isCoolingDown(definition: ActivityDefinition, context: SchedulerContext): boolean {
  const until = context.cooldownUntilMs.get(definition.id)
  return typeof until === 'number' && Number.isFinite(until) && context.nowMs < until
}

/**
 * 计算一条活动在当前上下文下的权重。
 * @returns 0 = 不可抽（不可调度/冷却中/要求不满足/权重被压没）；>0 = 参与加权抽取。
 */
export function scoreActivity(
  definition: ActivityDefinition,
  context: SchedulerContext
): number {
  if (!definition.schedulable) return 0
  if (!Number.isFinite(context.nowMs)) return 0
  if (isCoolingDown(definition, context)) return 0
  for (const requirement of definition.requirements) {
    if (!isRequirementMet(requirement, context)) return 0
  }

  const pace = LEVEL_PACE[context.autonomousLevel] ?? LEVEL_PACE.normal
  let weight = definition.baseWeight
  if (!Number.isFinite(weight) || weight <= 0) return 0

  if (definition.energetic) weight *= pace.energyFactor
  if (definition.idleVariant) weight *= pace.calmFactor
  if (definition.id === 'sleep') weight *= pace.sleepFactor

  // 窗口数量：窗口越多，越有机会坐/爬（同时提高新窗口出现后的短期偏好）
  if (
    definition.requirements.includes('sittableSurface') ||
    definition.requirements.includes('climbableSurface')
  ) {
    const surfaceCount = definition.requirements.includes('climbableSurface')
      ? context.climbableSurfaceCount
      : context.sittableSurfaceCount
    weight *= Math.min(2.2, 0.55 + 0.4 * surfaceCount)
    if (context.newWindowBias) weight *= 1.5
  }

  // 鼠标距离：鼠标在宠物上 → 安静/互动类加权、走爬睡被抑制；鼠标离开窗口 → 孤独类加权
  if (context.hoveringPet) {
    if (definition.id === 'idleSalute' || definition.id === 'idleToss' || definition.id === 'idleTidy') {
      weight *= 1.8
    } else if (
      definition.id === 'walkTo' ||
      definition.id === 'climb' ||
      definition.id === 'sleep' ||
      definition.id === 'dropDown' ||
      definition.id === 'returnCorner' ||
      definition.id === 'sit'
    ) {
      weight *= 0.12
    } else {
      weight *= 1.05
    }
  } else if (context.pointerNear) {
    if (definition.id === 'idleSalute') weight *= 2.2
    else if (definition.id === 'sleep') weight *= 0.12
    else if (
      definition.id === 'walkTo' ||
      definition.id === 'climb' ||
      definition.id === 'returnCorner'
    ) {
      weight *= 0.7
    }
  } else if (context.mouseAway) {
    // 「用户不在」抑制轴（PLAN §18.1）：孤独/安静类加权，敬礼等互动类降权
    if (definition.id === 'sleep') weight *= 1.6
    else if (definition.id === 'idleGaze') weight *= 1.45
    else if (definition.id === 'idleStretch') weight *= 1.2
    else if (definition.id === 'walkTo') weight *= 1.15
    else if (definition.id === 'idleSalute') weight *= 0.4
  }

  // 闲置时长：越久越容易睡/伸懒腰；刚回到 idle 时活跃类略降
  if (definition.id === 'sleep') weight *= context.idleElapsedMs >= SLEEP_MIN_IDLE_MS ? 1.65 : 0.35
  if (definition.id === 'idleStretch' && context.idleElapsedMs >= 90_000) weight *= 1.6
  if (context.idleElapsedMs < 4_000 && definition.energetic) weight *= 0.7

  // DSH 反应刚结束：先安静一阵（DSH 状态对权重的间接影响）
  if (context.sinceExternalEndMs < 15_000) {
    if (definition.energetic) weight *= 0.55
    if (definition.idleVariant) weight *= 1.2
  }

  // 避免连续两次抽到同一个活动
  if (context.lastActivityId === definition.id) weight *= 0.2

  return weight > 0 && Number.isFinite(weight) ? weight : 0
}

/**
 * 按当前权重抽一条活动（单次随机数；权重为 0 的被过滤）。
 * @param excluded 本次抽取已尝试但「准备失败」的活动 id（重抽时排除）
 */
export function pickWeightedActivity(
  context: SchedulerContext,
  random: () => number,
  excluded?: ReadonlySet<ActivityId>
): ActivityDefinition | null {
  const weighted: Array<{ definition: ActivityDefinition; weight: number }> = []
  let total = 0
  for (const definition of ACTIVITY_DEFINITIONS) {
    if (excluded?.has(definition.id)) continue
    const weight = scoreActivity(definition, context)
    if (weight <= 0) continue
    weighted.push({ definition, weight })
    total += weight
  }
  if (weighted.length === 0 || !(total > 0)) return null
  let value: number
  try {
    value = random()
  } catch {
    value = 0
  }
  if (!Number.isFinite(value)) value = 0
  if (value <= 0) value = 0
  if (value >= 1) value = 0.9999999999
  const targetWeight = value * total
  let accumulated = 0
  for (const entry of weighted) {
    accumulated += entry.weight
    if (targetWeight < accumulated) return entry.definition
  }
  return weighted[weighted.length - 1].definition
}

/** 调试面用：正在冷却的活动数量。 */
export function countCoolingActivities(context: SchedulerContext): number {
  let count = 0
  for (const definition of ACTIVITY_DEFINITIONS) {
    if (isCoolingDown(definition, context)) count += 1
  }
  return count
}
