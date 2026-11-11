/**
 * F2a 回归（H-5）：normal/high 档 sleep 必须可被调度。
 *
 * 背景：sleep 的 `mouseAway` 需求要求 `idleElapsedMs >= SLEEP_MIN_IDLE_MS(20s)`，但活动结束后
 * 下一次抽取固定在 `LEVEL_PACE.idleDelayMs`（normal 8–18s / high 4.2–10s）——永远 <20s，且
 * `idleSinceMs` 在「待机小动作」活动期间也会被清空（只认纯 idle 帧），因此默认两档 sleep 永不调度
 * （旧复现 R1，seed 2026：normal sleepFrames=0、high=0、low=1430）。另外低活跃档因 idleDelay
 * 14–28s 恰好可越过 20s，所以 low 原来就能睡。
 *
 * 修复（双保险）：
 * 1) 待机小动作/四处看这类「安静活动」不再打断 idle 基线累计（finalizeDecision）；
 * 2) 鼠标离开时，idle 基线保证「下一次抽取」不晚于 `idleSince + SLEEP_MIN_IDLE_MS + 抖动`
 *    （buildAutonomousDecision 取 min），让 sleep 需求在抽取时已满足。
 *
 * 旧断言→新口径关系：本文件为新增用例；旧 repro R1 只打印不断言（旧值见上方注释），
 * 修复后同 seed（2026）normal/high sleepFrames 均 >0。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import { BehaviorDirector, createSeededRandom } from '../src/renderer/src/behavior'
import type {
  BehaviorConfigSubset,
  BehaviorDecision,
  DesktopSurface,
  InteractionSnapshot,
  MotionSnapshot,
  Point2D
} from '../src/renderer/src/core/wave2-contract'

const WA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
const DT = 1 / 30

function groundSurface(): DesktopSurface {
  return {
    id: 'screen-bottom',
    kind: 'screen-bottom',
    rect: { x: WA.x, y: WA.y + WA.height, width: WA.width, height: 1 },
    top: WA.y + WA.height,
    sittable: true,
    climbable: false
  }
}

function groundMotion(): MotionSnapshot {
  return {
    feet: { x: WA.width / 2, y: WA.y + WA.height },
    velocity: { x: 0, y: 0 },
    facing: 'front',
    grounded: true,
    surfaceId: 'screen-bottom',
    airborne: false
  }
}

interface SleepSimResult {
  sleepFrames: number
  sleepStarts: number
  activityFrames: Record<string, number>
  /** 非 idle/非 sleep 的活动发起次数（活动饥饿检查）。 */
  otherActivityStarts: number
  firstSleepAtMs: number | null
}

/**
 * ground-only 10 分钟仿真（B1 纯逻辑；不接 B2，睡眠与位移无关）。
 * @param pointer 鼠标位置（null = 用户不在；mouseAway 轴）
 */
function runSleepSim(options: {
  seconds: number
  level: 'low' | 'normal' | 'high'
  seed: number
  pointer?: Point2D | null
}): SleepSimResult {
  const random = createSeededRandom(options.seed)
  const director = new BehaviorDirector({ random })
  const config: BehaviorConfigSubset = {
    autonomous: true,
    autonomousLevel: options.level,
    mischief: true,
    dshLink: true
  }
  const desktop = {
    surfaces: [groundSurface()],
    transitions: [],
    workArea: { ...WA },
    screenBounds: { ...WA }
  }
  const interaction: InteractionSnapshot = {
    pointer: options.pointer ?? null,
    hoveringPet: false,
    dragging: false,
    patProgress: 0
  }
  const result: SleepSimResult = {
    sleepFrames: 0,
    sleepStarts: 0,
    activityFrames: {},
    otherActivityStarts: 0,
    firstSleepAtMs: null
  }
  let lastActivity = 'idle'
  const frameCount = Math.round(options.seconds * 30)
  for (let index = 0; index < frameCount; index += 1) {
    const nowMs = Math.round(index * (1000 / 30))
    const decision: BehaviorDecision = director.update({
      nowMs,
      dt: DT,
      motion: groundMotion(),
      desktop,
      interaction,
      events: [],
      external: null,
      config,
      random
    })
    const debug = director.getDebugSnapshot()
    result.activityFrames[debug.activity] = (result.activityFrames[debug.activity] ?? 0) + 1
    if (decision.mood === 'sleep') result.sleepFrames += 1
    if (debug.activity !== lastActivity) {
      if (debug.activity === 'sleep') {
        result.sleepStarts += 1
        if (result.firstSleepAtMs === null) result.firstSleepAtMs = nowMs
      } else if (debug.activity !== 'idle') {
        result.otherActivityStarts += 1
      }
      lastActivity = debug.activity
    }
  }
  return result
}

// 2026-11-11 用户决定：sleep 动画在男体上崩坏，已从自主调度移除（activities.ts schedulable=false）。
// 本文件验证的 H-5「sleep 必须可被自主调度」需求随之废止；保留断言供将来换合格源后恢复。
describe.skip('H-5：sleep 在 normal/high 档可调度（已废止：sleep 移出自动播放）', () => {
  const results: Record<'low' | 'normal' | 'high', SleepSimResult> = {
    low: runSleepSim({ seconds: 600, level: 'low', seed: 2026 }),
    normal: runSleepSim({ seconds: 600, level: 'normal', seed: 2026 }),
    high: runSleepSim({ seconds: 600, level: 'high', seed: 2026 })
  }

  it('normal/high 10min 仿真 sleepFrames>0（旧值 0）；low 仍正常（旧值 1430）', () => {
    // eslint-disable-next-line no-console
    console.log('[H-5]', {
      low: {
        sleepFrames: results.low.sleepFrames,
        sleepStarts: results.low.sleepStarts,
        otherActivityStarts: results.low.otherActivityStarts
      },
      normal: {
        sleepFrames: results.normal.sleepFrames,
        sleepStarts: results.normal.sleepStarts,
        otherActivityStarts: results.normal.otherActivityStarts
      },
      high: {
        sleepFrames: results.high.sleepFrames,
        sleepStarts: results.high.sleepStarts,
        otherActivityStarts: results.high.otherActivityStarts
      }
    })
    // 旧缺陷值：normal=0 / high=0（同一 seed 2026 的旧 R1）；修复后必须 >0
    expect(results.normal.sleepStarts).toBeGreaterThan(0)
    expect(results.high.sleepStarts).toBeGreaterThan(0)
    expect(results.normal.sleepFrames).toBeGreaterThan(0)
    expect(results.high.sleepFrames).toBeGreaterThan(0)
    // low 档原本就能睡：修复后仍必须能睡（不得把低活跃档的睡眠需求修坏）
    expect(results.low.sleepStarts).toBeGreaterThan(0)
    expect(results.low.sleepFrames).toBeGreaterThan(0)
  })

  it('不造成活动饥饿：睡眠之外仍持续发起/执行其它自主活动', () => {
    // normal/high 档除 sleep 外仍有足够多其它活动（旧实现 normal 10 个非 idle 活动 / high 25 个）
    expect(results.normal.otherActivityStarts).toBeGreaterThanOrEqual(5)
    expect(results.high.otherActivityStarts).toBeGreaterThanOrEqual(10)
    // 非 idle/sleep 的表演帧确实存在（不是只剩睡觉与站立）
    const normalOtherFrames = Object.entries(results.normal.activityFrames)
      .filter(([id]) => id !== 'idle' && id !== 'sleep')
      .reduce((sum, [, frames]) => sum + frames, 0)
    const highOtherFrames = Object.entries(results.high.activityFrames)
      .filter(([id]) => id !== 'idle' && id !== 'sleep')
      .reduce((sum, [, frames]) => sum + frames, 0)
    expect(normalOtherFrames).toBeGreaterThan(300)
    expect(highOtherFrames).toBeGreaterThan(1_000)
  })

  it('鼠标在场（mouseAway=false）时 sleep 不应被调度（保留「用户不在才睡」语义）', () => {
    const present = runSleepSim({
      seconds: 600,
      level: 'normal',
      seed: 2026,
      pointer: { x: WA.width / 2, y: WA.y + WA.height - 160 }
    })
    expect(present.sleepFrames).toBe(0)
    expect(present.sleepStarts).toBe(0)
  })

  it('sleep 冷却生效：两次 sleep 发起间隔 ≥ 120s（sleep.cooldownMs）', () => {
    // 用同 seed 的 normal 结果复核：sleepStarts ≤ 1 + floor(600s / (minDuration+cooldown))
    expect(results.normal.sleepStarts).toBeLessThanOrEqual(4)
    expect(results.high.sleepStarts).toBeLessThanOrEqual(4)
  })
})
