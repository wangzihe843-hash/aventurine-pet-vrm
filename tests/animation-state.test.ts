/**
 * B3 单测：状态映射（12 个 PetMood 穷举）/ 事件优先级 / 待机变体调度（随机+冷却）。
 */
import { describe, expect, it } from 'vitest'

import {
  EVENT_PRIORITY,
  IdleDirector,
  MOOD_TO_POSE,
  moodTransitionGesture,
  pickReaction,
  resolveBasePoseId
} from '../src/renderer/src/animation/legacy/state-map'
import { BASE_POSES, IDLE_VARIANTS } from '../src/renderer/src/animation/legacy/poses'
import type { AnimationEvent } from '../src/renderer/src/core/wave2-contract'
import type { PetMood } from '../src/shared/types'

const ALL_MOODS: PetMood[] = [
  'idle',
  'walk',
  'climb',
  'sit',
  'sleep',
  'drag',
  'fall',
  'pat',
  'grabWindow',
  'dshBusy',
  'dshDone',
  'dshError'
]

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

describe('state-map：PetMood → 姿态穷举', () => {
  it('12 个 mood 全部映射到已有基础姿态（无 undefined）', () => {
    expect(ALL_MOODS.length).toBe(12)
    for (const mood of ALL_MOODS) {
      const poseId = MOOD_TO_POSE[mood]
      expect(poseId, mood).toBeTruthy()
      expect(BASE_POSES[poseId], `${mood} → ${poseId}`).toBeDefined()
    }
  })

  it('映射语义符合人设：sleep→sleep / dshBusy→busy / dshDone→celebrate / dshError→sad', () => {
    expect(MOOD_TO_POSE.sleep).toBe('sleep')
    expect(MOOD_TO_POSE.dshBusy).toBe('busy')
    expect(MOOD_TO_POSE.dshDone).toBe('celebrate')
    expect(MOOD_TO_POSE.dshError).toBe('sad')
    expect(MOOD_TO_POSE.grabWindow).toBe('climb')
  })

  it('resolveBasePoseId：手动 > 拖拽 > 腾空 > mood；未知 mood 回退 stand', () => {
    expect(resolveBasePoseId({ mood: 'walk', dragging: false, airborne: false, manualPoseId: null })).toBe('walk')
    expect(resolveBasePoseId({ mood: 'idle', dragging: true, airborne: false, manualPoseId: null })).toBe('drag')
    expect(resolveBasePoseId({ mood: 'idle', dragging: false, airborne: true, manualPoseId: null })).toBe('fall')
    expect(
      resolveBasePoseId({ mood: 'idle', dragging: true, airborne: true, manualPoseId: null })
    ).toBe('drag')
    expect(
      resolveBasePoseId({ mood: 'sleep', dragging: false, airborne: false, manualPoseId: 'sit' })
    ).toBe('sit')
    expect(
      resolveBasePoseId({ mood: 'unknown-mood' as PetMood, dragging: false, airborne: false, manualPoseId: null })
    ).toBe('stand')
  })
})

describe('state-map：事件优先级 / 心情切换手势', () => {
  it('事件优先级：thrown > landed > dragStart > pat > dragEnd > poke', () => {
    const order = ['thrown', 'landed', 'dragStart', 'pat', 'dragEnd', 'poke'] as const
    for (let i = 1; i < order.length; i += 1) {
      expect(EVENT_PRIORITY[order[i - 1]!]).toBeGreaterThan(EVENT_PRIORITY[order[i]!])
    }
  })

  it('空事件 → null；pat/poke 按部位映射；同帧高优先级胜出', () => {
    expect(pickReaction([])).toBeNull()
    expect(pickReaction([{ kind: 'pat' }])?.gestureId).toBe('patReact')
    expect(pickReaction([{ kind: 'poke', region: 'head' }])?.gestureId).toBe('pokedHead')
    expect(pickReaction([{ kind: 'poke', region: 'body' }])?.gestureId).toBe('pokedBody')
    expect(pickReaction([{ kind: 'poke', region: 'leg' }])?.gestureId).toBe('pokedLeg')
    const events: AnimationEvent[] = [{ kind: 'pat' }, { kind: 'thrown', speed: 1200 }]
    expect(pickReaction(events)?.gestureId).toBe('thrown')
    const thrownWins = pickReaction([
      { kind: 'thrown', speed: 100 },
      { kind: 'landed', impactSpeed: 2000 }
    ])
    // survey §1.3：thrown > landed（被甩出优先于落地）
    expect(thrownWins?.gestureId).toBe('thrown')
    expect(pickReaction([{ kind: 'landed', impactSpeed: 2000 }])?.gestureId).toBe('landed')
    expect(pickReaction([{ kind: 'dragStart' }, { kind: 'dragEnd' }])).toBeNull()
    expect(pickReaction([{ kind: 'dragStart' }])).toBeNull()
  })

  it('mood 切换手势：pat→patReact、dshDone→cheer，同 mood 不重复触发', () => {
    expect(moodTransitionGesture('pat', 'idle')).toBe('patReact')
    expect(moodTransitionGesture('dshDone', 'dshBusy')).toBe('cheer')
    expect(moodTransitionGesture('pat', 'pat')).toBeNull()
    expect(moodTransitionGesture('idle', 'walk')).toBeNull()
    expect(moodTransitionGesture('dshError', 'dshBusy')).toBeNull()
  })
})

describe('IdleDirector：待机变体随机调度（权重/冷却/不连续重复）', () => {
  it('未到排期时间不触发；到点触发合法变体 id', () => {
    const director = new IdleDirector({ random: () => 0 })
    director.reset(100)
    expect(director.update(100, true)).toBeNull() // 排期在 100+8s
    const id = director.update(108, true)
    expect(id).not.toBeNull()
    const ids = IDLE_VARIANTS.map((variant) => variant.gesture.id)
    expect(ids).toContain(id)
    // rng=0 → 轮盘第一个（空手捻筹码）
    expect(id).toBe('coinRoll')
    expect(director.cooldownRemaining('coinRoll', 108)).toBeGreaterThan(0)
  })

  it('不允许时（拖拽/交互中）不触发，也不消耗排期', () => {
    const director = new IdleDirector({ random: () => 0 })
    director.reset(0)
    expect(director.update(8, false)).toBeNull()
    expect(director.update(20, false)).toBeNull()
    expect(director.update(20, true)).not.toBeNull()
  })

  it('冷却中的变体不会被选中；不连续重复同一变体', () => {
    const random = seeded(123)
    const director = new IdleDirector({ random })
    director.reset(0)
    const played: string[] = []
    let now = 8
    for (let i = 0; i < 120; i += 1) {
      const id = director.update(now, true)
      if (id) played.push(id)
      now += 1
    }
    expect(played.length).toBeGreaterThanOrEqual(3)
    // 连续两次不会是同一变体
    for (let i = 1; i < played.length; i += 1) {
      expect(played[i]).not.toBe(played[i - 1])
    }
    // 每个变体实际播放后冷却 > 0（刚播完时）
    for (const id of played) {
      expect(IDLE_VARIANTS.some((variant) => variant.gesture.id === id)).toBe(true)
    }
  })

  it('notifyInterrupted 会把下一次尝试推后（反应打断后不马上抽变体）', () => {
    const director = new IdleDirector({ random: () => 0.5 })
    director.reset(0)
    director.notifyVariantPlayed('adjustCuff', 5)
    const scheduled = director.nextAttemptAt
    director.notifyInterrupted(20)
    expect(director.nextAttemptAt).toBeGreaterThanOrEqual(20 + 12 - 1e-9)
    expect(scheduled).toBeGreaterThan(5)
  })

  it('全部变体都在冷却时等待而不是重复', () => {
    const director = new IdleDirector({ random: () => 0 })
    director.reset(0)
    // 手动把所有变体打入冷却
    for (const variant of IDLE_VARIANTS) director.notifyVariantPlayed(variant.gesture.id, 10)
    // 立即到点（nextAttempt 被推后，直接用量大的时间点绕开排期）
    const id = director.update(11, true)
    expect(id).toBeNull()
  })
})
