/**
 * 单测：DSH 外部反应映射（`src/renderer/src/reactions/dsh.ts`，Wave 2 B7）。
 *
 * 纯逻辑，全部传假时钟：
 * - 事件映射（task/start、agent/status running/idle、task/end、task/error、session/event）；
 * - 去重（同 agent 重复 start、重复 end、同 turn error、桥双信号兜底）；
 * - 过期（duration 边界、时钟回拨）、pushStatus 离线清空、台词循环与长度约束；
 * - 脏 payload 安全忽略（不抛）。
 */
import { describe, expect, it } from 'vitest'

import type { DshEvent, DshStatus } from '@shared/types'

import {
  DSH_REACTION_BUBBLES,
  DSH_REACTION_DURATIONS,
  DshReactionTracker
} from '../src/renderer/src/reactions/dsh'
import {
  BUSY_BUBBLES,
  DEFEAT_BUBBLES,
  isOfficialVoiceLine,
  SUCCESS_BUBBLES,
  VOICE_LINES_LOADED
} from '../src/renderer/src/core/voicelines'

/** 基准时钟（毫秒）；用例内可任意平移。 */
const T0 = 10_000

/** 造一条桥事件。 */
function event(
  type: DshEvent['type'],
  payload: Record<string, unknown> = {},
  ts = T0
): DshEvent {
  return { ts, type, payload }
}

/** 造一份 DSH 状态。 */
function status(online: boolean): DshStatus {
  return { online, running: online, lastEventAt: online ? T0 : 0, lastType: online ? 'task/start' : null }
}

describe('事件 → ExternalReaction 映射', () => {
  it.skipIf(!VOICE_LINES_LOADED)('task/start → dshBusy（时长/起始时间/台词符合契约）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'agent-a', status: 'running' }), T0)
    const reaction = tracker.reactionAt(T0)
    expect(reaction).not.toBeNull()
    expect(reaction?.mood).toBe('dshBusy')
    expect(reaction?.durationMs).toBe(DSH_REACTION_DURATIONS.dshBusy)
    expect(reaction?.startedAtMs).toBe(T0)
    expect(typeof reaction?.bubble).toBe('string')
    expect((reaction?.bubble ?? '').length).toBeGreaterThan(0)
  })

  it('agent/status running → dshBusy；idle → dshDone', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('agent/status', { agent: 'a', status: 'running' }), T0)
    expect(tracker.reactionAt(T0)?.mood).toBe('dshBusy')

    tracker.pushEvent(event('agent/status', { agent: 'a', status: 'idle' }), T0 + 100)
    expect(tracker.reactionAt(T0 + 100)?.mood).toBe('dshDone')
  })

  it('task/end → dshDone；task/error → dshError（含时长）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/end', { agent: 'a', status: 'idle' }), T0)
    expect(tracker.reactionAt(T0)).toMatchObject({
      mood: 'dshDone',
      durationMs: DSH_REACTION_DURATIONS.dshDone
    })

    tracker.pushEvent(event('task/error', { agent: 'a', turn: 1 }), T0 + 10)
    expect(tracker.reactionAt(T0 + 10)).toMatchObject({
      mood: 'dshError',
      durationMs: DSH_REACTION_DURATIONS.dshError,
      startedAtMs: T0 + 10
    })
  })

  it('session/event 与未知状态不产生反应；不打断已有反应', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('session/event', { eventType: 'turn/end', reasonKind: 'completed' }), T0)
    expect(tracker.reactionAt(T0)).toBeNull()

    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushEvent(event('session/event', { eventType: 'assistant/message' }), T0 + 10)
    expect(tracker.reactionAt(T0 + 10)?.mood).toBe('dshBusy')

    tracker.pushEvent(event('agent/status', { agent: 'a', status: 'starting' }), T0 + 20)
    expect(tracker.reactionAt(T0 + 20)?.mood).toBe('dshBusy')
  })

  it('三种 mood 时长常量：busy 5s / done 2.5s / error 12s（用户 2026-11-09 决策延长 error）', () => {
    expect(DSH_REACTION_DURATIONS.dshBusy).toBe(5000)
    expect(DSH_REACTION_DURATIONS.dshDone).toBe(2500)
    // 用户 2026-11-09 决策：error 要长时间倒地显示严重程度（原 4s → 12s）。
    expect(DSH_REACTION_DURATIONS.dshError).toBe(12_000)
  })

  it('dshError 反应持续整 12s（4s 时仍在倒地，12s 边界过期）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 1 }), T0)
    // 原 4s 时长下这里已经站起来了；现在必须仍在 dshError。
    expect(tracker.reactionAt(T0 + 4_000)?.mood).toBe('dshError')
    expect(tracker.reactionAt(T0 + 11_999)?.mood).toBe('dshError')
    expect(tracker.reactionAt(T0 + 12_000)).toBeNull()
  })
})

describe('去重', () => {
  it('同一 agent 连续 task/start 只表演一次（不重置起始时间）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0 + 1000)
    tracker.pushEvent(event('agent/status', { agent: 'a', status: 'running' }), T0 + 1500)

    const reaction = tracker.reactionAt(T0 + 1500)
    expect(reaction?.mood).toBe('dshBusy')
    expect(reaction?.startedAtMs).toBe(T0) // 重复事件不重置
  })

  it('end 之后新的 start 可以再次表演', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushEvent(event('task/end', { agent: 'a' }), T0 + 100)
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0 + 200)
    expect(tracker.reactionAt(T0 + 200)).toMatchObject({
      mood: 'dshBusy',
      startedAtMs: T0 + 200
    })
  })

  it('同一 agent 连续重复 task/end 只表演一次', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/end', { agent: 'a' }), T0)
    tracker.pushEvent(event('task/end', { agent: 'a' }), T0 + 500)
    expect(tracker.reactionAt(T0 + 500)?.startedAtMs).toBe(T0)
  })

  it('不同 agent 的 start 各自触发（后到者覆盖为当前反应）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushEvent(event('task/start', { agent: 'b' }), T0 + 500)
    expect(tracker.reactionAt(T0 + 500)?.startedAtMs).toBe(T0 + 500)
  })

  it('同一 agent + turn 的 task/error 只报一次（桥双信号兜底）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 3 }), T0)
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 3 }), T0 + 1000)
    expect(tracker.reactionAt(T0 + 1000)?.startedAtMs).toBe(T0)

    tracker.pushEvent(event('task/error', { agent: 'a', turn: 4 }), T0 + 2000)
    expect(tracker.reactionAt(T0 + 2000)?.startedAtMs).toBe(T0 + 2000)
  })

  it('H-1：error 之后 ≤2s 的 task/end 只清 busy，不覆盖为 dshDone', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 1 }), T0 + 100)
    tracker.pushEvent(event('task/end', { agent: 'a', status: 'idle' }), T0 + 200)
    // 旧实现会变成 dshDone（成功庆祝）；修复后应保留 dshError
    expect(tracker.reactionAt(T0 + 200)).toMatchObject({
      mood: 'dshError',
      startedAtMs: T0 + 100
    })
    // 桥的双信号：error 后还可能再来 agent/status idle —— 同样不覆盖
    tracker.pushEvent(event('agent/status', { agent: 'a', status: 'idle' }), T0 + 400)
    expect(tracker.reactionAt(T0 + 400)?.mood).toBe('dshError')
  })

  it('H-1：error 抑制窗过后（>2s）的 task/end 恢复表演完成', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 1 }), T0 + 100)
    tracker.pushEvent(event('task/end', { agent: 'a', status: 'idle' }), T0 + 2_600)
    expect(tracker.reactionAt(T0 + 2_600)?.mood).toBe('dshDone')
  })

  it('H-1：error 后新 busy 周期结束时正常表演完成（不误抑制）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 1 }), T0)
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0 + 500)
    tracker.pushEvent(event('task/end', { agent: 'a' }), T0 + 900)
    expect(tracker.reactionAt(T0 + 900)?.mood).toBe('dshDone')
  })

  it('不同 agent 的 task/error 互不影响', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/error', { agent: 'a', turn: 1 }), T0)
    tracker.pushEvent(event('task/error', { agent: 'b', turn: 1 }), T0 + 100)
    expect(tracker.reactionAt(T0 + 100)?.startedAtMs).toBe(T0 + 100)
  })
})

describe('过期 / 静默', () => {
  it('反应在 duration 边界过期（之前仍有效，边界归零）', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/end', { agent: 'a' }), T0)
    const duration = DSH_REACTION_DURATIONS.dshDone

    expect(tracker.reactionAt(T0 + duration - 1)).not.toBeNull()
    expect(tracker.reactionAt(T0 + duration)).toBeNull()
    expect(tracker.reactionAt(T0 + duration + 1000)).toBeNull()
  })

  it('时钟回拨（nowMs < startedAtMs）视为过期，不表演', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    expect(tracker.reactionAt(T0 - 1)).toBeNull()
  })

  it('无事件时 reactionAt 返回 null（静默安全）', () => {
    const tracker = new DshReactionTracker()
    expect(tracker.reactionAt(T0)).toBeNull()
    expect(tracker.reactionAt(Number.NaN)).toBeNull()
  })

  it('pushStatus(online=true) 不清空；转为离线清空残留反应', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.pushStatus(status(true), T0 + 10)
    expect(tracker.reactionAt(T0 + 10)?.mood).toBe('dshBusy')

    tracker.pushStatus(status(false), T0 + 20)
    expect(tracker.reactionAt(T0 + 20)).toBeNull()

    // 离线清空后，即使旧事件重复到达也不会立即表演（需新的在线事件）
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0 + 30)
    expect(tracker.reactionAt(T0 + 30)?.mood).toBe('dshBusy')
  })

  it('reset 清空反应与去重状态', () => {
    const tracker = new DshReactionTracker()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0)
    tracker.reset()
    expect(tracker.reactionAt(T0)).toBeNull()
    tracker.pushEvent(event('task/start', { agent: 'a' }), T0 + 100)
    expect(tracker.reactionAt(T0 + 100)?.startedAtMs).toBe(T0 + 100)
  })
})

describe('台词与脏输入', () => {
  it.skipIf(!VOICE_LINES_LOADED)('每个 mood 都有非空台词池，且全部为已核实的官方中文语音原文', () => {
    for (const mood of ['dshBusy', 'dshDone', 'dshError'] as const) {
      const bubbles = DSH_REACTION_BUBBLES[mood]
      expect(bubbles.length).toBeGreaterThanOrEqual(1)
      for (const line of bubbles) {
        expect(line.trim().length).toBeGreaterThan(0)
        expect(line.length).toBeLessThanOrEqual(120)
        expect(isOfficialVoiceLine(line)).toBe(true)
      }
      // 池内无重复句
      expect(new Set(bubbles).size).toBe(bubbles.length)
    }
  })

  it.skipIf(!VOICE_LINES_LOADED)('场景映射（用户 2026-11-08 指示）：完成=开启战利品/终结技/晋阶/满级/行迹；失败=无法战斗；忙碌=战技/秘技/战斗开始', () => {
    expect(DSH_REACTION_BUBBLES.dshDone).toEqual(SUCCESS_BUBBLES)
    expect(DSH_REACTION_BUBBLES.dshError).toEqual(DEFEAT_BUBBLES)
    expect(DSH_REACTION_BUBBLES.dshBusy).toEqual(BUSY_BUBBLES)
    // 成功池必须包含官方分类中的每类台词（混合两个角色版本）
    const success = DSH_REACTION_BUBBLES.dshDone.join('|')
    for (const keyword of ['全归你了，朋友。', '一无所有？或者，赢下所有！', '这就满足了吗？买定离手，全押。', '看吧？我依然选择了正确的那边。', '赌局还未结束，重码加注咯。']) {
      expect(success.includes(keyword)).toBe(true)
    }
    // 失败池 = 两个版本的无法战斗语音
    expect(DSH_REACTION_BUBBLES.dshError).toContain('满盘皆输啊…')
    expect(DSH_REACTION_BUBBLES.dshError).toContain('扫兴呐。')
  })

  it.skipIf(!VOICE_LINES_LOADED)('台词按顺序循环（确定性，不随机）', () => {
    const tracker = new DshReactionTracker()
    const bubbles: string[] = []
    // 不同 agent 连续 start → 每条都产生新的 busy 反应
    for (let index = 0; index < 4; index += 1) {
      tracker.pushEvent(event('task/start', { agent: `agent-${index}` }), T0 + index * 10)
      bubbles.push(tracker.reactionAt(T0 + index * 10)?.bubble ?? '')
    }
    const busyLines = DSH_REACTION_BUBBLES.dshBusy
    for (let index = 0; index < 4; index += 1) {
      expect(bubbles[index]).toBe(busyLines[index % busyLines.length])
    }
    // 循环成立：第 busyLines.length 次回到第 1 条
    expect(busyLines.length).toBeGreaterThan(2)
    expect(bubbles[0]).toBe(busyLines[0])
  })

  it('脏 payload / 空事件安全忽略，不抛异常', () => {
    const tracker = new DshReactionTracker()
    expect(() => {
      tracker.pushEvent(null as unknown as DshEvent, T0)
      tracker.pushEvent({ ts: T0, type: 'task/start', payload: null } as unknown as DshEvent, T0)
      tracker.pushEvent(event('task/end', {}), T0)
      tracker.pushEvent(event('task/error', { turn: 'not-a-number' }), T0)
      tracker.pushStatus(null as unknown as DshStatus, T0)
    }).not.toThrow()

    // payload:null 的 task/start 仍按未知 agent 处理；后续 end/error 依次覆盖（静默安全，不崩）
    expect(tracker.reactionAt(T0)?.mood).toBe('dshError')
    // 不同 event 对象返回独立副本，调用方修改不污染内部状态
    const snapshot = tracker.reactionAt(T0)
    if (snapshot) snapshot.bubble = 'tampered'
    expect(tracker.reactionAt(T0)?.bubble).not.toBe('tampered')
  })
})
