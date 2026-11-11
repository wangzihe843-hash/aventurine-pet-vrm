/**
 * 单测：DSH 工作小动作调度器（`src/renderer/src/reactions/dsh-work-fidget.ts`）。
 *
 * 覆盖用户 2026-11-09 决策：DSH online && running 期间随机 30–60s 播一次 hsr-skill01/02
 * one-shot；首次 10–20s 延迟；blocked 不重置计时（跨点顺延）；idle/offline 重置；
 * seeded random 可复现；时钟回退/NaN/脏输入安全。
 */
import { describe, expect, it } from 'vitest'

import { createSeededRandom } from '../src/renderer/src/behavior/random'
import {
  DSH_WORK_FIDGET_DEFAULTS,
  DshWorkFidget,
  type DshWorkFidgetStatus
} from '../src/renderer/src/reactions/dsh-work-fidget'

const WORKING: DshWorkFidgetStatus = { online: true, running: true }
const ONLINE_IDLE: DshWorkFidgetStatus = { online: true, running: false }
const OFFLINE_RUNNING: DshWorkFidgetStatus = { online: false, running: true }

/** 更新一次（默认工作模式、未阻塞）。 */
function update(
  fidget: DshWorkFidget,
  nowMs: number,
  status: DshWorkFidgetStatus | null = WORKING,
  blocked = false
): string | null {
  return fidget.update({ nowMs, status, blocked })
}

/**
 * 精确推进到每次触发点并收集 `count` 次触发（利用 getSnapshot().nextInMs 直接跳到 due）。
 * 返回 `[{ clipId, atMs }]`（atMs 为触发时刻；后续间隔即触发间隔）。
 */
function collectFires(
  fidget: DshWorkFidget,
  startMs: number,
  count: number
): Array<{ clipId: string; atMs: number }> {
  update(fidget, startMs)
  const fires: Array<{ clipId: string; atMs: number }> = []
  let now = startMs
  for (let index = 0; index < count; index += 1) {
    const snapshot = fidget.getSnapshot(now)
    if (snapshot.nextInMs === null) {
      throw new Error(`第 ${index} 次触发前没有排程（未进入工作模式？）`)
    }
    now += snapshot.nextInMs === 0 ? 1 : snapshot.nextInMs
    const clipId = update(fidget, now)
    if (clipId === null) {
      throw new Error(`第 ${index} 次触发失败（nowMs=${now}）`)
    }
    fires.push({ clipId, atMs: now })
  }
  return fires
}

/** 间隔序列（相邻触发时刻差）。 */
function gaps(fires: ReadonlyArray<{ atMs: number }>): number[] {
  const result: number[] = []
  for (let index = 1; index < fires.length; index += 1) {
    result.push(fires[index].atMs - fires[index - 1].atMs)
  }
  return result
}

describe('默认常量 / 首次延迟 / 30–60s 区间（用户决策）', () => {
  it('默认常量：30–60s 间隔、10–20s 首次延迟、hsr-skill01/02、默认启用', () => {
    expect(DSH_WORK_FIDGET_DEFAULTS.minIntervalMs).toBe(30_000)
    expect(DSH_WORK_FIDGET_DEFAULTS.maxIntervalMs).toBe(60_000)
    expect(DSH_WORK_FIDGET_DEFAULTS.initialDelayMinMs).toBe(10_000)
    expect(DSH_WORK_FIDGET_DEFAULTS.initialDelayMaxMs).toBe(20_000)
    expect([...DSH_WORK_FIDGET_DEFAULTS.clipIds]).toEqual(['hsr-skill01', 'hsr-skill02'])
    expect(DSH_WORK_FIDGET_DEFAULTS.enabled).toBe(true)
  })

  it('首次触发在 10–20s；随后 100 次触发间隔全部在 30–60s（相邻 ≥30s，不密集）', () => {
    const fidget = new DshWorkFidget({ random: createSeededRandom(1) })
    const fires = collectFires(fidget, 0, 101)
    // 首次延迟（进入工作模式后）。
    expect(fires[0].atMs).toBeGreaterThanOrEqual(10_000)
    expect(fires[0].atMs).toBeLessThanOrEqual(20_000)
    // 100 个间隔：全部在区间内，且不密集。
    const intervals = gaps(fires)
    expect(intervals.length).toBe(100)
    for (const interval of intervals) {
      expect(interval).toBeGreaterThanOrEqual(30_000)
      expect(interval).toBeLessThanOrEqual(60_000)
    }
    // 触发 clip 只来自默认候选，且不会连续两次相同。
    for (let index = 0; index < fires.length; index += 1) {
      expect(['hsr-skill01', 'hsr-skill02']).toContain(fires[index].clipId)
      if (index > 0) expect(fires[index].clipId).not.toBe(fires[index - 1].clipId)
    }
  })

  it('seeded random：同 seed 序列逐次一致，不同 seed 不同（可复现）', () => {
    const run = (seed: number): Array<{ clipId: string; atMs: number }> => {
      const fidget = new DshWorkFidget({ random: createSeededRandom(seed) })
      return collectFires(fidget, 1_000, 12)
    }
    const first = run(42)
    const second = run(42)
    expect(second).toEqual(first)
    expect(run(43)).not.toEqual(first)
  })
})

describe('工作模式状态机（重置 / blocked）', () => {
  /** 快速用例：固定首次 2s、固定 5s 间隔（语义清晰、与真实区间无关）。 */
  function makeFastFidget(seed = 7): DshWorkFidget {
    return new DshWorkFidget({
      random: createSeededRandom(seed),
      initialDelayMs: [2_000, 2_000],
      minIntervalMs: 5_000,
      maxIntervalMs: 5_000
    })
  }

  it('running → idle → running：重置计时，下次按新的 initial delay 重新排（不是旧 due）', () => {
    const fidget = makeFastFidget()
    update(fidget, 0)
    expect(fidget.getSnapshot(0).nextInMs).toBe(2_000)

    // 到点前切 idle → 计时重置。
    update(fidget, 1_500, ONLINE_IDLE)
    expect(fidget.getSnapshot(1_500)).toMatchObject({ working: false, nextInMs: null })

    // 1.6s 重新 running → 新的 due = 1600 + 2000 = 3600（旧 due=2000 处不触发）。
    update(fidget, 1_600, WORKING)
    expect(fidget.getSnapshot(1_600).nextInMs).toBe(2_000)
    expect(update(fidget, 2_000, WORKING)).toBeNull() // 旧 due 不触发
    expect(update(fidget, 3_599, WORKING)).toBeNull()
    expect(update(fidget, 3_600, WORKING)).not.toBeNull() // 新 initial delay 到点
  })

  it('offline / 未知 status 同样重置计时（offline 不触发）', () => {
    for (const status of [OFFLINE_RUNNING, ONLINE_IDLE, null] as const) {
      const fidget = makeFastFidget()
      update(fidget, 0)
      expect(fidget.getSnapshot(0).working).toBe(true)
      update(fidget, 500, status)
      expect(fidget.getSnapshot(500).working).toBe(false)
      // 非工作模式跑 5 分钟也不触发。
      for (let now = 1_000; now <= 300_000; now += 1_000) {
        expect(update(fidget, now, status)).toBeNull()
      }
      expect(fidget.getSnapshot(300_000).firedCount).toBe(0)
      expect(fidget.getSnapshot(300_000).nextInMs).toBeNull()
    }
  })

  it('blocked 不重置计时：短暂阻塞后仍在原 due 触发', () => {
    const fidget = makeFastFidget()
    update(fidget, 0)
    const due = 2_000
    update(fidget, 500, WORKING, true) // 阻塞（未到点）
    expect(fidget.getSnapshot(500).nextInMs).toBe(due - 500)
    expect(fidget.getSnapshot(500).blocked).toBe(true)
    update(fidget, 1_000, WORKING, false) // 解除阻塞，仍按原 due
    expect(fidget.getSnapshot(1_000).nextInMs).toBe(due - 1_000)
    expect(update(fidget, due - 1, WORKING)).toBeNull()
    expect(update(fidget, due, WORKING)).not.toBeNull()
  })

  it('blocked 跨过触发点 → 顺延到解除阻塞那一帧触发一次（不补多个）', () => {
    const fidget = makeFastFidget()
    update(fidget, 0)
    // 2s due，但在 1.2s 就被阻塞，一直阻塞到 3s。
    expect(update(fidget, 1_200, WORKING, true)).toBeNull()
    expect(update(fidget, 2_000, WORKING, true)).toBeNull() // 跨过 due：不触发、不重置
    expect(update(fidget, 2_999, WORKING, true)).toBeNull()
    expect(fidget.getSnapshot(2_999).nextInMs).toBe(0) // 已到点，等解除阻塞
    const fired = update(fidget, 3_000, WORKING, false)
    expect(fired).not.toBeNull()
    expect(fidget.getSnapshot(3_000)).toMatchObject({
      firedCount: 1,
      lastFiredAtMs: 3_000,
      nextInMs: 5_000 // 以触发时刻 3000 + 5000 为基准，不补触发
    })
    // 阻塞期间不会累积多次触发：下一次仍要等完整间隔。
    expect(update(fidget, 7_999, WORKING)).toBeNull()
    expect(update(fidget, 8_000, WORKING)).not.toBeNull()
  })

  it('同一次到点只触发一次（同一 nowMs 连续 update 第二次返回 null）', () => {
    const fidget = makeFastFidget()
    update(fidget, 0)
    const first = update(fidget, 2_000, WORKING)
    expect(first).not.toBeNull()
    expect(update(fidget, 2_000, WORKING)).toBeNull()
    expect(fidget.getSnapshot(2_000).firedCount).toBe(1)
  })
})

describe('参数字典 / 退化输入', () => {
  it('initialDelayMs 为数字 = 固定值；自定义 clipIds 全部可用且不连续重复', () => {
    const fidget = new DshWorkFidget({
      random: createSeededRandom(3),
      initialDelayMs: 500,
      minIntervalMs: 3_000,
      maxIntervalMs: 3_000,
      clipIds: ['a', 'b', 'c']
    })
    const fires = collectFires(fidget, 0, 20)
    expect(fires[0].atMs).toBe(500)
    const seen = new Set(fires.map((fire) => fire.clipId))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
    for (let index = 1; index < fires.length; index += 1) {
      expect(fires[index].clipId).not.toBe(fires[index - 1].clipId)
    }
  })

  it('自定义 clipIds（含 adv 技能）：多次触发只返回候选集合内 id（seeded 可复现）', () => {
    const clipIds = ['hsr-skill01', 'hsr-skill02', 'adv-skill01', 'adv-mazeattack01'] as const
    const fidget = new DshWorkFidget({
      random: createSeededRandom(20261110),
      initialDelayMs: [1_000, 1_000],
      minIntervalMs: 2_000,
      maxIntervalMs: 2_000,
      clipIds
    })
    const fires = collectFires(fidget, 0, 40)
    const allowed = new Set<string>(clipIds)
    for (const fire of fires) {
      expect(allowed.has(fire.clipId)).toBe(true)
    }
    // 40 次触发覆盖全部 4 条候选，且不连续重复（pickClipId 保证）。
    expect(new Set(fires.map((fire) => fire.clipId)).size).toBe(clipIds.length)
    for (let index = 1; index < fires.length; index += 1) {
      expect(fires[index].clipId).not.toBe(fires[index - 1].clipId)
    }
    expect(fidget.getSnapshot(fires[fires.length - 1].atMs).clipCount).toBe(clipIds.length)
  })

  it('min > max / 非法间隔安全回退（不会产生 0 或 NaN 间隔）', () => {
    const fidget = new DshWorkFidget({
      random: createSeededRandom(5),
      initialDelayMs: 100,
      minIntervalMs: 4_000,
      maxIntervalMs: 1_000 // < min → 按 min 固定
    })
    const fires = collectFires(fidget, 0, 3)
    for (const interval of gaps(fires)) expect(interval).toBe(4_000)

    const bad = new DshWorkFidget({
      random: createSeededRandom(5),
      minIntervalMs: Number.NaN,
      maxIntervalMs: Number.POSITIVE_INFINITY,
      initialDelayMs: Number.NaN
    })
    const badFires = collectFires(bad, 0, 2)
    // 回退默认：首次 10–20s，间隔 30–60s。
    expect(badFires[0].atMs).toBeGreaterThanOrEqual(10_000)
    expect(badFires[0].atMs).toBeLessThanOrEqual(20_000)
    for (const interval of gaps(badFires)) {
      expect(interval).toBeGreaterThanOrEqual(30_000)
      expect(interval).toBeLessThanOrEqual(60_000)
    }
  })

  it('enabled=false / clipIds 为空：完全不调度（恒 null、无排程）', () => {
    const disabled = new DshWorkFidget({ enabled: false, random: createSeededRandom(1) })
    for (let now = 0; now <= 120_000; now += 1_000) expect(update(disabled, now)).toBeNull()
    expect(disabled.getSnapshot(120_000)).toMatchObject({
      enabled: false,
      working: false,
      nextInMs: null,
      firedCount: 0
    })

    const noClips = new DshWorkFidget({ clipIds: [], random: createSeededRandom(1) })
    for (let now = 0; now <= 120_000; now += 1_000) expect(update(noClips, now)).toBeNull()
    expect(noClips.getSnapshot(120_000)).toMatchObject({
      enabled: true,
      working: false,
      nextInMs: null,
      clipCount: 0,
      firedCount: 0
    })
  })

  it('时钟回退不提前触发；NaN nowMs / 脏输入静默忽略；reset 清空全部状态', () => {
    const fidget = new DshWorkFidget({
      random: createSeededRandom(9),
      initialDelayMs: 1_000,
      minIntervalMs: 2_000,
      maxIntervalMs: 2_000
    })
    update(fidget, 1_000)
    expect(fidget.getSnapshot(1_000).nextInMs).toBe(1_000)
    // 回拨到 0：不触发、不重置（按上次时钟 1000 封顶）。
    expect(update(fidget, 0)).toBeNull()
    expect(fidget.getSnapshot().nextInMs).toBe(1_000)
    // NaN 时钟：忽略本次，不破坏排程。
    expect(update(fidget, Number.NaN)).toBeNull()
    expect(fidget.getSnapshot().nextInMs).toBe(1_000)
    // 脏输入不抛。
    expect(fidget.update(null as unknown as Parameters<DshWorkFidget['update']>[0])).toBeNull()
    // 到点仍按原计划触发（1000 时 due=2000）。
    expect(update(fidget, 2_000)).not.toBeNull()

    // reset：清空统计与排程，之后重新从 initial delay 开始。
    fidget.reset()
    expect(fidget.getSnapshot(2_000)).toMatchObject({
      working: false,
      nextInMs: null,
      lastFiredAtMs: null,
      lastClipId: null,
      firedCount: 0
    })
    update(fidget, 5_000)
    expect(fidget.getSnapshot(5_000).nextInMs).toBe(1_000)
  })
})

describe('调试快照 getSnapshot', () => {
  it('初始态 / 进入工作 / 触发后 / idle 后 的快照字段', () => {
    const fidget = new DshWorkFidget({
      random: createSeededRandom(11),
      initialDelayMs: [2_500, 2_500],
      minIntervalMs: 30_000,
      maxIntervalMs: 30_000
    })
    expect(fidget.getSnapshot()).toEqual({
      enabled: true,
      working: false,
      blocked: false,
      nextInMs: null,
      lastFiredAtMs: null,
      lastClipId: null,
      firedCount: 0,
      clipCount: 2
    })

    update(fidget, 1_000)
    expect(fidget.getSnapshot(1_000)).toMatchObject({
      working: true,
      nextInMs: 2_500,
      firedCount: 0
    })
    expect(fidget.getSnapshot(2_000).nextInMs).toBe(1_500) // 按传入 nowMs 计算剩余

    const firedAt = 3_500
    const clipId = update(fidget, firedAt)
    expect(clipId).not.toBeNull()
    expect(fidget.getSnapshot(firedAt)).toMatchObject({
      working: true,
      nextInMs: 30_000,
      lastFiredAtMs: firedAt,
      lastClipId: clipId,
      firedCount: 1
    })

    update(fidget, 4_000, ONLINE_IDLE)
    expect(fidget.getSnapshot(4_000)).toMatchObject({
      working: false,
      nextInMs: null,
      lastFiredAtMs: firedAt, // 历史统计保留（调试面）
      lastClipId: clipId,
      firedCount: 1
    })
  })
})
