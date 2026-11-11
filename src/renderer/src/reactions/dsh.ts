/**
 * DSH 外部反应映射（Wave 2 B7，渲染层**纯逻辑**；不 import DOM/Electron/three）。
 *
 * 数据流：main（dsh-watch）→ `dsh-event` IPC → Lead 的 `main.ts` 订阅后调用
 * `tracker.pushEvent(event, nowMs)`；每帧 `tracker.reactionAt(nowMs)` 得到未过期的
 * `ExternalReaction`，注入 B1 `BehaviorInput.external`（或 `applyExternalReaction`）。
 *
 * 映射（PLAN §8 / docs/wave2-integration.md §3-B7）：
 * | 桥事件 | 反应 mood | 时长 |
 * |---|---|---|
 * | `task/start`、`agent/status` running | `dshBusy`（忙碌表演） | 5s |
 * | `task/end`、`agent/status` idle | `dshDone`（完成庆祝） | 2.5s |
 * | `task/error` | `dshError`（出错低落/倒地） | 12s |
 * | `session/event` / 其它 | 无反应（null） | — |
 *
 * 去重：
 * - 同一 agent 连续 `task/start`（未 end）视为重复，只表演一次 busy；
 * - 同一 agent 连续相同 type + turn 的事件（桥/文件层重复写）只表演一次；
 * - `task/error` 按 `agent + turn` 去重（桥插件 `agent/error` 与 `turn/end(error)` 双信号兜底）；
 * - **error→end 抑制**（H-1）：同一 agent `task/error` 后 ≤`ERROR_END_SUPPRESS_MS`(2s) 内的
 *   `task/end` / `agent/status idle` 只清 busy/去重状态，**不覆盖**为 `dshDone`。真实 DSH
 *   失败回合会紧接着写 end/idle（同一轮询窗口内），旧实现会让「失败任务」表演成功庆祝。
 *
 * 静默安全：tracker **不知道** `config.dshLink`/`config.dshLink`——由 Lead 决定是否
 * 调用 `pushEvent`；`pushStatus`（可选）只在 DSH 转为离线时清掉残留反应，避免「DSH 已退出
 * 宠物还在庆祝」。所有脏 payload 一律安全忽略，绝不抛异常。
 *
 * 台词为**游戏内砂金官方中文语音原文**（原文存私有资产 `assets/voicelines.json`，经
 * `../core/voicelines` 读取）：直接引用原文，不改写/不扩写、保持原文标点；每条 ≤18 字，顺序循环使用。
 */
import type { ExternalReaction } from '../core/wave2-contract'
import { BUSY_BUBBLES, DEFEAT_BUBBLES, SUCCESS_BUBBLES } from '../core/voicelines'
import type { DshEvent, DshEventType, DshStatus } from '@shared/types'

/** 反应 mood 只允许 DSH 三种（与 `ExternalReaction['mood']` 同源）。 */
export type DshReactionMood = ExternalReaction['mood']

/**
 * 各反应持续时长（毫秒；量大在 2.5s / 5s / 12s）。
 *
 * - `dshError` = **12s**：用户 2026-11-09 决策「error 要长时间倒地，显示问题的严重程度」
 *   （4s 太短，倒地姿态还没看清就站起来了；配合 VRM 的 hsr-breaked/hsr-revive 进出场过渡）。
 */
export const DSH_REACTION_DURATIONS: Readonly<Record<DshReactionMood, number>> = {
  dshBusy: 5000,
  dshDone: 2500,
  dshError: 12000
}

/**
 * 气泡台词池：**游戏内砂金 / 砂金·戏浪 官方中文语音原文**（单一来源 `../core/voicelines`，
 * 用户硬性要求：禁止自创/改写/扩写，保持原文标点）。顺序循环使用（确定性，便于单测）。
 *
 * 映射（用户 2026-11-08 指示）：dshDone=任务成功池（开启战利品/终结技/角色晋阶/角色满级/行迹激活）；
 * dshError=无法战斗；dshBusy=战技/秘技/战斗开始（准备行动）。
 */
export const DSH_REACTION_BUBBLES: Readonly<Record<DshReactionMood, readonly string[]>> = {
  dshBusy: BUSY_BUBBLES,
  dshDone: SUCCESS_BUBBLES,
  dshError: DEFEAT_BUBBLES
}

/** 同一 agent + turn 的 error 去重表上限（FIFO 淘汰，防长期运行内存增长）。 */
const ERROR_TURN_DEDUPE_LIMIT = 64

/**
 * `task/error` 后抑制 `dshDone` 的时间窗（H-1）。
 *
 * 真实 DSH 失败回合的事件顺序是 `task/error` → agent 转 idle 写 `task/end`/`agent/status idle`
 * （同一 750ms 轮询窗口内）；若 end 直接覆盖 error 反应，用户会看到失败任务在庆祝。
 * 2s 覆盖桥的轮询抖动，同时不会误伤「error 后人类重新发起的新一轮任务」。
 */
const ERROR_END_SUPPRESS_MS = 2_000

/** 单个 agent 的最近一次被接受事件（连续重复去重）。 */
interface LastAcceptedEvent {
  type: DshEventType
  turn: number | null
  atMs: number
}

/** 从脏 payload 里取 agent id（桥插件写字符串 id；也兼容缺失）。 */
function agentIdOf(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== 'object') return '(unknown)'
  const agent = (payload as Record<string, unknown>)['agent']
  if (typeof agent === 'string' && agent.length > 0) return agent
  if (typeof agent === 'number' && Number.isFinite(agent)) return String(agent)
  const sessionId = (payload as Record<string, unknown>)['sessionId']
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  return '(unknown)'
}

/** 从脏 payload 里取 turn（有限数值 → 截断整数；缺失 → null）。 */
function turnOf(payload: Record<string, unknown> | null | undefined): number | null {
  if (!payload || typeof payload !== 'object') return null
  const turn = (payload as Record<string, unknown>)['turn']
  if (typeof turn === 'number' && Number.isFinite(turn)) return Math.trunc(turn)
  return null
}

/** 从脏 payload 里取 agent/status 的 status 字段（running / idle / 其它）。 */
function agentStatusOf(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)['status']
  return typeof value === 'string' ? value : null
}

/**
 * DSH 反应跟踪器（纯逻辑、可注入时钟）。
 *
 * Lead 接线示例：
 * ```ts
 * const tracker = new DshReactionTracker()
 * api.onDshEvent((event) => tracker.pushEvent(event, performance.now())) // 仅 dshLink 开启时
 * // 每帧：
 * const external = tracker.reactionAt(performance.now())
 * ```
 */
export class DshReactionTracker {
  /** 当前未过期的反应（null = 无）。 */
  private reaction: ExternalReaction | null = null
  /** 正在 busy 的 agent（task/start 未 end）。 */
  private readonly busyAgents = new Set<string>()
  /** `task/error` 之后的 dshDone 抑制窗（agent → 截止时间 ms；H-1）。 */
  private readonly errorSuppressUntilMs = new Map<string, number>()
  /** 每个 agent 最近一次被接受的事件（连续重复去重）。 */
  private readonly lastAccepted = new Map<string, LastAcceptedEvent>()
  /** `agent#turn` 的 error 去重表（FIFO 上限）。 */
  private readonly reportedErrorTurns = new Set<string>()
  /** 台词循环游标（每个 mood 独立）。 */
  private readonly bubbleCursor: Record<DshReactionMood, number> = {
    dshBusy: 0,
    dshDone: 0,
    dshError: 0
  }

  /**
   * 消费一条桥事件。脏事件（未知类型/坏 payload/重复事件）安全忽略。
   *
   * @param event 桥事件（`DshEvent`）
   * @param nowMs 单调时钟毫秒（与 `reactionAt` 同口径；Lead 传 `performance.now()`）
   */
  pushEvent(event: DshEvent, nowMs: number): void {
    if (!event || typeof event !== 'object') return
    const type: DshEventType = event.type
    const payload: Record<string, unknown> =
      event.payload && typeof event.payload === 'object' ? event.payload : {}
    const agent = agentIdOf(payload)
    const turn = turnOf(payload)

    switch (type) {
      case 'task/start': {
        if (!this.markBusy(agent)) return
        this.startReaction('dshBusy', nowMs)
        return
      }
      case 'agent/status': {
        const status = agentStatusOf(payload)
        if (status === 'running') {
          if (!this.markBusy(agent)) return
          this.startReaction('dshBusy', nowMs)
        } else if (status === 'idle') {
          if (!this.markIdle(agent, type, turn, nowMs)) return
          this.startReaction('dshDone', nowMs)
        }
        return
      }
      case 'task/end': {
        if (!this.markIdle(agent, type, turn, nowMs)) return
        this.startReaction('dshDone', nowMs)
        return
      }
      case 'task/error': {
        if (!this.markError(agent, turn, nowMs)) return
        this.startReaction('dshError', nowMs)
        return
      }
      default:
        // session/event 等不产生桌宠反应。
        return
    }
  }

  /**
   * 可选：同步 DSH 聚合状态（Lead 可在 `getDshStatus()`/周期轮询时调用）。
   *
   * 只在**转为离线**时清空残留反应与去重状态（避免 DSH 退出后宠物还挂着 busy/done）；
   * 转回在线不做任何表演——等真实事件驱动。未调用时 tracker 行为完全等价（静默安全）。
   */
  pushStatus(status: DshStatus, _nowMs: number): void {
    if (!status || typeof status !== 'object') return
    if (status.online === true) return
    this.reset()
  }

  /**
   * 取当前未过期的反应（过期/无事件 → null）。
   *
   * @param nowMs 单调时钟毫秒（与 `pushEvent` 同口径）
   */
  reactionAt(nowMs: number): ExternalReaction | null {
    if (!this.reaction) return null
    const age = nowMs - this.reaction.startedAtMs
    // 时钟回拨（age < 0）也视为过期：静默安全，不表演「未开始」的反应。
    if (!Number.isFinite(age) || age < 0 || age >= this.reaction.durationMs) {
      this.reaction = null
      return null
    }
    return { ...this.reaction }
  }

  /** 清空全部反应与去重状态（DSH 离线 / 关闭联动 / Lead 复位时用）。 */
  reset(): void {
    this.reaction = null
    this.busyAgents.clear()
    this.errorSuppressUntilMs.clear()
    this.lastAccepted.clear()
    this.reportedErrorTurns.clear()
  }

  /* ------------------------------ 去重状态机 ------------------------------ */

  /** 标记 agent 进入 busy；已在 busy → 重复，返回 false。 */
  private markBusy(agent: string): boolean {
    if (this.busyAgents.has(agent)) return false
    this.busyAgents.add(agent)
    // 新一轮 busy 结束 error 抑制窗（error 后人工重新发起任务 → 正常表演完成）
    this.errorSuppressUntilMs.delete(agent)
    this.lastAccepted.set(agent, { type: 'task/start', turn: null, atMs: 0 })
    return true
  }

  /** 标记 agent 结束；连续重复 end（无 start 间隔）→ 重复，返回 false。 */
  private markIdle(
    agent: string,
    type: DshEventType,
    turn: number | null,
    nowMs: number
  ): boolean {
    const previous = this.lastAccepted.get(agent)
    const wasBusy = this.busyAgents.delete(agent)
    // H-1：error 后短窗口内的 end/idle 只清 busy（保留 dshError 反应），不得覆盖为 dshDone。
    // 用独立的「抑制截止时间」而非上一事件类型，覆盖 error→end 之后又跟一条 agent/status idle 的
    // 桥双信号序列（第一条 end 被抑制后 lastAccepted 已变成 end，仍需继续抑制）。
    const suppressUntil = this.errorSuppressUntilMs.get(agent)
    if (suppressUntil !== undefined) {
      if (nowMs <= suppressUntil) {
        this.lastAccepted.set(agent, { type, turn, atMs: nowMs })
        return false
      }
      this.errorSuppressUntilMs.delete(agent)
    }
    const duplicate =
      !wasBusy && previous !== undefined && previous.type === type && previous.turn === turn
    if (duplicate) return false
    this.lastAccepted.set(agent, { type, turn, atMs: nowMs })
    return true
  }

  /** 标记 agent 出错；同 agent + turn 只报一次（桥的双信号兜底）。 */
  private markError(agent: string, turn: number | null, nowMs: number): boolean {
    if (turn !== null) {
      const key = `${agent}#${turn}`
      if (this.reportedErrorTurns.has(key)) return false
      this.reportedErrorTurns.add(key)
      while (this.reportedErrorTurns.size > ERROR_TURN_DEDUPE_LIMIT) {
        const oldest = this.reportedErrorTurns.values().next().value
        if (oldest === undefined) break
        this.reportedErrorTurns.delete(oldest)
      }
    }
    const previous = this.lastAccepted.get(agent)
    if (previous !== undefined && previous.type === 'task/error' && previous.turn === turn) {
      return false
    }
    this.busyAgents.delete(agent)
    this.errorSuppressUntilMs.set(agent, nowMs + ERROR_END_SUPPRESS_MS)
    this.lastAccepted.set(agent, { type: 'task/error', turn, atMs: nowMs })
    return true
  }

  /** 开始一次反应（覆盖旧反应；台词按 mood 顺序循环）。 */
  private startReaction(mood: DshReactionMood, nowMs: number): void {
    const bubbles = DSH_REACTION_BUBBLES[mood]
    // 私有台词文件缺失时池为空：不冒气泡，但仍要有动作反应（不崩、不阻塞）。
    const hasBubbles = bubbles.length > 0
    const bubble = hasBubbles ? (bubbles[this.bubbleCursor[mood] % bubbles.length] ?? null) : null
    this.bubbleCursor[mood] = hasBubbles ? (this.bubbleCursor[mood] + 1) % bubbles.length : 0
    this.reaction = {
      mood,
      bubble,
      durationMs: DSH_REACTION_DURATIONS[mood],
      startedAtMs: nowMs
    }
  }
}
