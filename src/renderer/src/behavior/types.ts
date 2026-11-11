/**
 * B1 行为层内部类型（纯 TS；**不 import DOM / three / Electron / Node 内置**）。
 *
 * 模块边界上共享的数据形状一律来自 `../core/wave2-contract`（Lead 冻结），
 * 本文件只放 behavior 模块自己的私有用类型与「可单测的调度器上下文」。
 */
import type { AutonomousLevel, PetMood, Rect } from '@shared/types'

import type { Point2D, SurfaceKind } from '../core/wave2-contract'

/** B1 能发起的全部自主/事件驱动活动 id（调试 `triggerActivity` 可直接用）。 */
export type ActivityId =
  | 'idle'
  | 'idleCoin'
  | 'idleToss'
  | 'idleTidy'
  | 'idleStretch'
  | 'idleGaze'
  | 'idleSalute'
  | 'lookAround'
  | 'walkTo'
  | 'returnCorner'
  | 'climb'
  | 'sit'
  | 'sleep'
  | 'dropDown'
  | 'followWindow'

/**
 * 行为层对注视目标的策略（B3 的 look-at 层按 `BehaviorDecision.lookTarget` 消费）。
 * - `pointer`：跟随鼠标（鼠标离开窗口时自然变成 null）；
 * - `none`：不注入注视（让姿态自己决定头眼方向，例如玩筹码 / 睡觉 / 爬）；
 * - `randomFar`：望远处/四处看——活动开始时用随机数固定一个「远处」点。
 */
export type LookMode = 'pointer' | 'none' | 'randomFar'

/** 活动对当前桌面/交互环境的要求（不满足时权重为 0，不参与抽取）。 */
export type ActivityRequirement =
  | 'grounded'
  | 'sittableSurface'
  | 'climbableSurface'
  | 'elevated'
  | 'pointerNear'
  | 'mouseAway'

/** 一条自主活动定义（权重、时长、冷却、姿态提示、注视策略）。 */
export interface ActivityDefinition {
  id: ActivityId
  /**
   * 调试面 `BehaviorDebugSnapshot.activity` 使用的规范 id（idle 变体统一显示 `idle`），
   * 与 `wave2-contract.ts` 注释里的示例一致（idle / walkTo / sit / climb / sleep / ...）。
   */
  debugId: string
  /** 中文名（README / 调试可读）。 */
  label: string
  /** 基础权重（还会乘以上下文系数；最终权重为 0 表示不参与）。 */
  baseWeight: number
  /** 最短持续（ms）：到点之前不会被自主调度替换（交互/外部反应仍可打断）。 */
  minDurationMs: number
  /** 最长持续（ms）：实际时长 = random(min..max)。 */
  maxDurationMs: number
  /** 冷却（ms）：同一条活动两次发起之间的最小间隔。 */
  cooldownMs: number
  /** 该活动对应的语义 mood（B3 据此选姿态/表情）。 */
  mood: PetMood
  /** 姿态/表演提示（B3 可忽略或映射；B1 不输出具体姿态 id）。 */
  poseHint?: string
  /** 注视策略。 */
  look: LookMode
  /** 环境要求（全部满足才可被抽取）。 */
  requirements: readonly ActivityRequirement[]
  /** 是否参与随机调度（`followWindow` 等事件驱动活动为 false）。 */
  schedulable: boolean
  /** 是否「活跃类」（走动/攀爬/跳跃）：受 `autonomousLevel` 与鼠标在场影响。 */
  energetic?: boolean
  /** 是否待机小动作变体（受 `idle`、`autonomousLevel` 影响）。 */
  idleVariant?: boolean
  /** 活动开始时是否尝试说一句（走气泡冷却门）。 */
  bubblePool?: 'idle'
  /** 走到目标表面后是否转为坐姿（爬窗沿用）。 */
  arriveSit?: boolean
}

/** 调度器上下文（纯数据；由 `BehaviorDirector` 每帧算好，单测可直接构造）。 */
export interface SchedulerContext {
  nowMs: number
  autonomousLevel: AutonomousLevel
  workArea: Rect
  feet: Point2D
  grounded: boolean
  /** 当前脚底所站表面类型（null = 地面占位/未知）。 */
  surfaceKind: SurfaceKind | null
  sittableSurfaceCount: number
  climbableSurfaceCount: number
  windowCount: number
  pointer: Point2D | null
  hoveringPet: boolean
  /** 鼠标靠近宠物（悬停或距离 < 阈值）。 */
  pointerNear: boolean
  /** 鼠标不在窗口内或远离宠物（「用户不在」抑制轴）。 */
  mouseAway: boolean
  /** 距进入 idle 基线（无活动/反应）的毫秒数。 */
  idleElapsedMs: number
  /** 距最近一次交互事件的毫秒数。 */
  sinceInteractionMs: number
  /** 距上一次 DSH 外部反应结束的毫秒数（从未出现 = Infinity）。 */
  sinceExternalEndMs: number
  /** 新窗口出现后的短时偏好期（提高坐/爬权重）。 */
  newWindowBias: boolean
  /** 上一次发起的活动 id（避免连续重复）。 */
  lastActivityId: ActivityId | null
  /** activityId → 冷却结束时刻（`nowMs < 值` 表示冷却中）。 */
  cooldownUntilMs: ReadonlyMap<string, number>
  /** 当前是否站在窗口上沿/菜单栏/Dock 等「高处」（可主动跳下）。 */
  elevated: boolean
}

/** `BehaviorDirector` 构造参数（Lead 接线时通常只传 `seed`/`initialMood` 或不传）。 */
export interface BehaviorDirectorOptions {
  /** 内部随机源种子（单测/调试复现；默认 Math.random）。 */
  seed?: number
  /** 初始 mood（调试/测试；默认 `idle`）。 */
  initialMood?: PetMood
  /** 自定义随机源（优先于 `seed`）。 */
  random?: () => number
  /** 初始时钟（ms；用于 `moodSinceMs` 初值，默认 0）。 */
  initialNowMs?: number
  /** 气泡全局冷却（两次气泡的最小间隔；默认 60s，B1 验收要求 ≥60s）。 */
  bubbleGlobalCooldownMs?: number
  /** 同类场景气泡冷却（默认 120s，避免同一场景刷屏）。 */
  bubbleCategoryCooldownMs?: number
  /** 同一句台词的冷却（默认 300s）。 */
  bubbleLineCooldownMs?: number
}

/** `BehaviorInput.motionLimits` 的模块内别名（B2 半宽钳制后的运动目标可达水平区间）。 */
export interface MotionLimits {
  minX: number
  maxX: number
}

/** 活动路径的一段（两段式攀爬用；用户实机反馈：不要从角落斜着直线穿过窗口）。 */
export interface ActivityPathStep {
  /** 该段的目标点（脚底点；窗口本地 px）。 */
  target: Point2D
  /** 该段的运动模式：walk = 水平走到窗口侧边下方；climb = 沿边缘竖直上爬。 */
  mode: 'walk' | 'climb'
}

/** 一次活动「准备阶段」算出的目标（surface 相关活动需要；与随机抽取分开，便于失败重抽）。 */
export interface PreparedActivity {
  /** 移动目标（脚底点；窗口本地 px）。 */
  target?: Point2D | null
  /** 分段路径（目前只有 climb 使用：先 walk 到边缘下方，再 climb 沿边缘竖直向上）。 */
  path?: readonly ActivityPathStep[] | null
  /** 目标表面 id（坐/爬用）。 */
  surfaceId?: string | null
  /** 目标表面所属窗口 id（跟随用）。 */
  windowId?: number | null
  /** `look: 'randomFar'` 时固定的注视点。 */
  lookPoint?: Point2D | null
  /** 走到目标表面后是否转坐姿（保留能力；climb 不再使用→爬完站在边缘，坐姿由独立 sit 活动负责）。 */
  arriveSit?: boolean
  /** 事件驱动活动（跟随窗口）用：是否保持之前的坐姿。 */
  previousSitting?: boolean
}
