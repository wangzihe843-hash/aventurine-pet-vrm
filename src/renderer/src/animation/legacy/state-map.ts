/**
 * 状态/事件 → 姿态/手势映射 + 待机变体调度（纯逻辑，不 import three/DOM）。
 *
 * 契约（`core/wave2-contract.ts`）：
 * - B3 只消费 `AnimationInput.mood`（12 个 PetMood 穷举映射）与 `events`（一次性表演）；
 * - `PetMood → 姿态` 的映射由 B3 内部完成；未知/异常值回退 `stand`；
 * - 待机变体（4–6 个）按 `mood==='idle' + random + cooldown` 轮换，不依赖 B1 给变体 id。
 *
 * 人设约束：待机变体只做「空手筹码 / 整理衣领 / 伸懒腰 / 望远处 / 两指敬礼」这类
 * 砂金（男性、赌徒、体面、从容）的动作，**不做**娇羞摇摆/卖萌小动作。
 */
import type { AnimationEvent } from '../../core/wave2-contract'
import type { PetMood } from '@shared/types'

import { IDLE_VARIANTS, REACTION_IDS, type IdleVariantDef } from './poses'

/** PetMood → 基础姿态 id（穷举；未知值回退 stand）。 */
export const MOOD_TO_POSE: Readonly<Record<PetMood, string>> = {
  idle: 'stand',
  walk: 'walk',
  climb: 'climb',
  sit: 'sit',
  sleep: 'sleep',
  drag: 'drag',
  fall: 'fall',
  pat: 'pat',
  // 扒窗沿（BS 桌面边缘）：身体挂在边缘，用爬姿 + 手臂上抓表达
  grabWindow: 'climb',
  // DSH 反应不换基础姿态也 OK，但这里给语义姿态（B3 不写死 B1 的实现）
  dshBusy: 'busy',
  dshDone: 'celebrate',
  dshError: 'sad'
}

/** 事件优先级（survey §1.3：同帧多事件按 thrown > landed > pat > poke 处理）。 */
export const EVENT_PRIORITY: Readonly<Record<AnimationEvent['kind'], number>> = {
  thrown: 50,
  landed: 40,
  dragStart: 30,
  pat: 20,
  dragEnd: 15,
  poke: 10
}

/** 一次反应触发请求。 */
export interface ReactionRequest {
  gestureId: string
  /** 触发事件（用于取 speed/impactSpeed）。 */
  event: AnimationEvent | null
}

/** 解析基础姿态 id（手动 setPose > 拖拽/腾空等即时状态 > mood）。 */
export interface PoseContext {
  mood: PetMood
  dragging: boolean
  airborne: boolean
  /** 调试 `setPose` 强制姿态（null = 跟随 mood）。 */
  manualPoseId: string | null
}

/** 解析当前应使用的基础姿态 id。 */
export function resolveBasePoseId(context: PoseContext): string {
  if (context.manualPoseId) return context.manualPoseId
  if (context.dragging) return 'drag'
  if (context.airborne) return 'fall'
  const mapped = MOOD_TO_POSE[context.mood]
  return mapped ?? 'stand'
}

/**
 * 本帧一次性事件 → 反应手势（只取优先级最高的一个；同优先级取数组里靠后的）。
 * 返回 null = 本帧没有反应类事件。
 */
export function pickReaction(events: readonly AnimationEvent[]): ReactionRequest | null {
  let best: { priority: number; request: ReactionRequest } | null = null
  for (const event of events) {
    const priority = EVENT_PRIORITY[event.kind] ?? 0
    let gestureId: string | null = null
    if (event.kind === 'pat') gestureId = REACTION_IDS.pat
    else if (event.kind === 'poke') {
      gestureId =
        event.region === 'head'
          ? REACTION_IDS.pokedHead
          : event.region === 'body'
            ? REACTION_IDS.pokedBody
            : REACTION_IDS.pokedLeg
    } else if (event.kind === 'thrown') gestureId = REACTION_IDS.thrown
    else if (event.kind === 'landed') gestureId = REACTION_IDS.landed
    if (!gestureId) continue
    if (!best || priority >= best.priority) {
      best = { priority, request: { gestureId, event } }
    }
  }
  return best?.request ?? null
}

/** 行为状态切换触发的一次性手势（例如 DSH 完成时摊手庆祝）。 */
export function moodTransitionGesture(mood: PetMood, previousMood: PetMood | null): string | null {
  if (previousMood === mood) return null
  if (mood === 'pat') return REACTION_IDS.pat
  if (mood === 'dshDone') return 'cheer'
  return null
}

/** 待机变体调度器（随机 + 冷却 + 不连续重复；随机源由外部注入，单测可复现）。 */
export class IdleDirector {
  private readonly variants: readonly IdleVariantDef[]
  private readonly random: () => number
  /** 下次尝试抽变体的时间（秒；-1 = 尚未排期）。 */
  private nextAttemptAtSec = -1
  private readonly cooldownUntilSec = new Map<string, number>()
  private lastVariantId: string | null = null

  constructor(options: { variants?: readonly IdleVariantDef[]; random?: () => number } = {}) {
    this.variants = options.variants ?? IDLE_VARIANTS
    this.random = options.random ?? Math.random
  }

  /** 重置调度（切换场景/进入交互时调用；`nowSec` 后重新排期）。 */
  reset(nowSec: number): void {
    this.nextAttemptAtSec = nowSec + 8 + 10 * this.random()
    this.cooldownUntilSec.clear()
    this.lastVariantId = null
  }

  /** 当前是否在等待下一次尝试。 */
  get nextAttemptAt(): number {
    return this.nextAttemptAtSec
  }

  /** 记录变体开始播放（进入冷却、排下一次）。 */
  notifyVariantPlayed(id: string, nowSec: number): void {
    this.lastVariantId = id
    const def = this.variants.find((variant) => variant.gesture.id === id)
    const cooldown = def?.cooldownSec ?? 30
    this.cooldownUntilSec.set(id, nowSec + cooldown)
    this.nextAttemptAtSec = nowSec + 10 + 15 * this.random()
  }

  /** 中断（反应/交互打断待机变体）：稍后再排期。 */
  notifyInterrupted(nowSec: number): void {
    this.nextAttemptAtSec = nowSec + 12 + 10 * this.random()
  }

  /** 某个变体的剩余冷却（秒；调试用）。 */
  cooldownRemaining(id: string, nowSec: number): number {
    return Math.max(0, (this.cooldownUntilSec.get(id) ?? 0) - nowSec)
  }

  /**
   * 每帧调用：允许时到点就抽一个变体 id；否则返回 null。
   * 抽取规则：过滤冷却中的 & 与上次相同（若还有其它可选），按权重轮盘。
   */
  update(nowSec: number, allowed: boolean): string | null {
    if (!allowed) return null
    if (this.nextAttemptAtSec < 0) {
      this.nextAttemptAtSec = nowSec + 8 + 10 * this.random()
      return null
    }
    if (nowSec < this.nextAttemptAtSec) return null
    const candidates = this.variants.filter(
      (variant) =>
        this.cooldownRemaining(variant.gesture.id, nowSec) <= 0 &&
        variant.gesture.id !== this.lastVariantId
    )
    if (candidates.length === 0) {
      this.nextAttemptAtSec = nowSec + 5
      return null
    }
    const total = candidates.reduce((sum, variant) => sum + Math.max(0, variant.weight), 0)
    let roll = this.random() * total
    let picked = candidates[candidates.length - 1]!
    for (const variant of candidates) {
      roll -= Math.max(0, variant.weight)
      if (roll <= 0) {
        picked = variant
        break
      }
    }
    this.notifyVariantPlayed(picked.gesture.id, nowSec)
    return picked.gesture.id
  }
}
