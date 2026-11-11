/**
 * B1 单元测试：活动权重 / 调度器 / 气泡冷却门 / 随机工具（纯函数层）。
 *
 * 与 `behavior-director.test.ts` 互补：这里不跑状态机，直接构造 `SchedulerContext`
 * 验证「权重受 autonomousLevel、窗口数量、鼠标距离、冷却影响」以及气泡门的冷却语义。
 */
import { describe, expect, it } from 'vitest'

import type { PetMood, Rect } from '../src/shared/types'
import {
  ACTIVITY_DEFINITIONS,
  BUBBLE_LINES,
  BubbleGate,
  collectAllBubbleLines,
  countCoolingActivities,
  createSeededRandom,
  DEFAULT_BUBBLE_COOLDOWNS,
  findActivityDefinition,
  isRequirementMet,
  LEVEL_PACE,
  pickWeightedActivity,
  randomInt,
  randomRange,
  readRandom,
  sanitizeRandom,
  scoreActivity,
  SLEEP_MIN_IDLE_MS,
  SLEEP_MIN_SINCE_INTERACTION_MS
} from '../src/renderer/src/behavior'
import { VOICE_LINES_LOADED } from '../src/renderer/src/core/voicelines'
import type { ActivityId, SchedulerContext } from '../src/renderer/src/behavior'

const WORK_AREA: Rect = { x: 0, y: 0, width: 1600, height: 900 }

const PET_MOODS: readonly PetMood[] = [
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

/** 构造调度上下文（默认：站在地面、无窗口、用户不在、已闲置 30s）。 */
function createContext(overrides: Partial<SchedulerContext> = {}): SchedulerContext {
  return {
    nowMs: 0,
    autonomousLevel: 'normal',
    workArea: WORK_AREA,
    feet: { x: 800, y: 900 },
    grounded: true,
    surfaceKind: null,
    sittableSurfaceCount: 0,
    climbableSurfaceCount: 0,
    windowCount: 0,
    pointer: null,
    hoveringPet: false,
    pointerNear: false,
    mouseAway: true,
    idleElapsedMs: 30_000,
    sinceInteractionMs: 30_000,
    sinceExternalEndMs: Number.POSITIVE_INFINITY,
    newWindowBias: false,
    lastActivityId: null,
    cooldownUntilMs: new Map<string, number>(),
    elevated: false,
    ...overrides
  }
}

/** 按 id 取活动定义（测试里断言明确，避免非空断言噪音）。 */
function definitionOf(id: ActivityId) {
  const definition = findActivityDefinition(id)
  if (!definition) throw new Error(`missing activity definition: ${id}`)
  return definition
}

/** 用 seeded rng 抽 N 次活动 id。 */
function sampleIds(seed: number, context: SchedulerContext, count: number): ActivityId[] {
  const random = createSeededRandom(seed)
  const ids: ActivityId[] = []
  for (let index = 0; index < count; index += 1) {
    const definition = pickWeightedActivity(context, random)
    if (definition) ids.push(definition.id)
  }
  return ids
}

/* ========================================================================== */
/* 1. 活动定义表不变量                                                          */
/* ========================================================================== */

describe('B1 活动定义表', () => {
  it('活动表覆盖契约要求的全部活动，字段合法且 debugId 命名与契约示例一致', () => {
    const ids = new Set(ACTIVITY_DEFINITIONS.map((definition) => definition.id))
    for (const required of [
      'idle',
      'walkTo',
      'climb',
      'sit',
      'sleep',
      'lookAround',
      'returnCorner',
      'followWindow',
      'dropDown'
    ]) {
      expect(ids.has(required as ActivityId)).toBe(true)
    }
    const debugIds = new Set(ACTIVITY_DEFINITIONS.map((definition) => definition.debugId))
    for (const name of ['idle', 'walkTo', 'climb', 'sit', 'sleep', 'followWindow', 'lookAround']) {
      expect(debugIds.has(name)).toBe(true)
    }
    for (const definition of ACTIVITY_DEFINITIONS) {
      expect(PET_MOODS).toContain(definition.mood)
      expect(definition.minDurationMs).toBeGreaterThan(0)
      expect(definition.maxDurationMs).toBeGreaterThanOrEqual(definition.minDurationMs)
      expect(definition.cooldownMs).toBeGreaterThanOrEqual(0)
      expect(definition.baseWeight).toBeGreaterThanOrEqual(0)
      expect(['pointer', 'none', 'randomFar']).toContain(definition.look)
      expect(typeof definition.label).toBe('string')
      expect(definition.label.length).toBeGreaterThan(0)
    }
  })

  it('followWindow 不参与随机调度；sit/sleep 的依赖为 grounded/surface 要求', () => {
    const follow = definitionOf('followWindow')
    expect(follow.schedulable).toBe(false)
    expect(scoreActivity(follow, createContext())).toBe(0)

    expect(definitionOf('sleep').requirements).toContain('grounded')
    expect(definitionOf('sleep').requirements).toContain('mouseAway')
    expect(definitionOf('sit').requirements).toContain('sittableSurface')
    expect(definitionOf('climb').requirements).toContain('climbableSurface')
    expect(definitionOf('walkTo').requirements).toContain('grounded')
  })

  it('findActivityDefinition 支持别名；未知返回 null', () => {
    expect(findActivityDefinition('walkTo')?.id).toBe('walkTo')
    expect(findActivityDefinition('walk')?.id).toBe('walkTo')
    expect(findActivityDefinition('coin')?.id).toBe('idleCoin')
    expect(findActivityDefinition('unknown-activity')).toBeNull()
    expect(findActivityDefinition('')).toBeNull()
  })
})

/* ========================================================================== */
/* 2. 权重上下文：档位 / 窗口 / 鼠标 / 冷却 / 重复                              */
/* ========================================================================== */

describe('B1 权重受上下文影响', () => {
  it('autonomousLevel：high 时活跃类权重 > low，low 时待机小动作权重 > high', () => {
    const walk = definitionOf('walkTo')
    const coin = definitionOf('idleCoin')
    const lowContext = createContext({ autonomousLevel: 'low' })
    const highContext = createContext({ autonomousLevel: 'high' })
    expect(scoreActivity(walk, highContext)).toBeGreaterThan(scoreActivity(walk, lowContext))
    expect(scoreActivity(coin, lowContext)).toBeGreaterThan(scoreActivity(coin, highContext))
    // 节奏参数方向一致：low 更慢、high 更快
    expect(LEVEL_PACE.low.idleDelayMs[0]).toBeGreaterThan(LEVEL_PACE.normal.idleDelayMs[0])
    expect(LEVEL_PACE.normal.idleDelayMs[0]).toBeGreaterThan(LEVEL_PACE.high.idleDelayMs[0])
    expect(LEVEL_PACE.high.walkSpeedPxPerSec).toBeGreaterThan(LEVEL_PACE.normal.walkSpeedPxPerSec)
    expect(LEVEL_PACE.low.energyFactor).toBeLessThan(LEVEL_PACE.normal.energyFactor)
    // 用户实机要求：沿窗口边缘攀爬速度 25–50 px/s（low/normal/high 全部落区间）
    for (const level of ['low', 'normal', 'high'] as const) {
      expect(LEVEL_PACE[level].climbSpeedPxPerSec).toBeGreaterThanOrEqual(25)
      expect(LEVEL_PACE[level].climbSpeedPxPerSec).toBeLessThanOrEqual(50)
    }
  })

  it('窗口数量：没有可坐表面时 sit 权重为 0，有窗口后 > 0；climb 已按用户要求禁用', () => {
    const sit = definitionOf('sit')
    const climb = definitionOf('climb')
    const noWindows = createContext({ sittableSurfaceCount: 0, climbableSurfaceCount: 0 })
    expect(scoreActivity(sit, noWindows)).toBe(0)
    expect(scoreActivity(climb, noWindows)).toBe(0)

    const withWindows = createContext({
      sittableSurfaceCount: 2,
      climbableSurfaceCount: 1,
      windowCount: 2,
      surfaceKind: 'window-top',
      elevated: true
    })
    expect(scoreActivity(sit, withWindows)).toBeGreaterThan(0)
    // 2026-11-08 用户实机反馈后移除爬窗自主行为（baseWeight=0 + schedulable=false）
    expect(scoreActivity(climb, withWindows)).toBe(0)
    expect(climb.schedulable).toBe(false)

    // 新窗口偏好会更看好坐/爬
    const biased = createContext({
      sittableSurfaceCount: 2,
      climbableSurfaceCount: 1,
      windowCount: 2,
      newWindowBias: true
    })
    expect(scoreActivity(sit, biased)).toBeGreaterThan(scoreActivity(sit, withWindows))
  })

  it('鼠标悬停宠物时抑制走/爬/睡、提高互动类；鼠标不在窗口时提高孤独类', () => {
    const walk = definitionOf('walkTo')
    const sleep = definitionOf('sleep')
    const coin = definitionOf('idleCoin')
    const gaze = definitionOf('idleGaze')

    const baseline = createContext()
    const hovering = createContext({
      pointer: { x: 820, y: 700 },
      hoveringPet: true,
      pointerNear: true,
      mouseAway: false
    })
    expect(scoreActivity(walk, hovering)).toBeLessThan(scoreActivity(walk, baseline))
    expect(scoreActivity(sleep, hovering)).toBe(0) // mouseAway 要求不满足
    expect(scoreActivity(coin, hovering)).toBeGreaterThan(scoreActivity(coin, baseline))

    const near = createContext({
      pointer: { x: 840, y: 760 },
      pointerNear: true,
      mouseAway: false
    })
    expect(scoreActivity(sleep, near)).toBe(0)
    expect(scoreActivity(definitionOf('idleSalute'), near)).toBeGreaterThan(0)

    const idleAway = createContext({ idleElapsedMs: 90_000, sinceInteractionMs: 90_000 })
    const userPresent = createContext({ mouseAway: false, pointer: { x: 100, y: 100 } })
    // 2026-11-11 用户决定：sleep 移出自动播放（男体躺姿崩坏），任何上下文权重都为 0。
    expect(sleep.schedulable).toBe(false)
    expect(scoreActivity(sleep, idleAway)).toBe(0)
    expect(scoreActivity(gaze, idleAway)).toBeGreaterThan(scoreActivity(gaze, userPresent))
  })

  it('sleep 已移出自动播放：定义保留但任何上下文都不参与随机调度', () => {
    const sleep = definitionOf('sleep')
    const fresh = createContext({
      idleElapsedMs: SLEEP_MIN_IDLE_MS - 1,
      sinceInteractionMs: SLEEP_MIN_SINCE_INTERACTION_MS + 1
    })
    const longIdle = createContext({
      idleElapsedMs: SLEEP_MIN_IDLE_MS + 1,
      sinceInteractionMs: SLEEP_MIN_SINCE_INTERACTION_MS + 1
    })
    expect(sleep.schedulable).toBe(false)
    expect(scoreActivity(sleep, fresh)).toBe(0)
    expect(scoreActivity(sleep, longIdle)).toBe(0)
    // mouseAway 需求仍保留在定义里（将来换合格源恢复调度时复用）。
    expect(isRequirementMet('mouseAway', longIdle)).toBe(true)
    expect(isRequirementMet('mouseAway', fresh)).toBe(false)
  })

  it('冷却中权重为 0；时钟越过冷却后恢复', () => {
    const walk = definitionOf('walkTo')
    const cooling = createContext({ nowMs: 1_000, cooldownUntilMs: new Map([['walkTo', 5_000]]) })
    expect(scoreActivity(walk, cooling)).toBe(0)
    expect(countCoolingActivities(cooling)).toBe(1)
    const ready = createContext({ nowMs: 5_001, cooldownUntilMs: new Map([['walkTo', 5_000]]) })
    expect(scoreActivity(walk, ready)).toBeGreaterThan(0)
    expect(countCoolingActivities(ready)).toBe(0)
  })

  it('连续两次不抽同一活动（权重打折）', () => {
    const walk = definitionOf('walkTo')
    const plain = createContext({ lastActivityId: null })
    const repeated = createContext({ lastActivityId: 'walkTo' })
    expect(scoreActivity(walk, repeated)).toBeGreaterThan(0)
    expect(scoreActivity(walk, repeated)).toBeLessThan(scoreActivity(walk, plain))
  })

  it('外部反应刚结束的 15s 内活跃类降权、待机类升权', () => {
    const walk = definitionOf('walkTo')
    const coin = definitionOf('idleCoin')
    const settled = createContext({ sinceExternalEndMs: 0 })
    const fresh = createContext({ sinceExternalEndMs: 60_000 })
    expect(scoreActivity(walk, settled)).toBeLessThan(scoreActivity(walk, fresh))
    expect(scoreActivity(coin, settled)).toBeGreaterThan(scoreActivity(coin, fresh))
  })

  it('isRequirementMet：全部要求分支可用', () => {
    const context = createContext({
      grounded: true,
      sittableSurfaceCount: 1,
      climbableSurfaceCount: 2,
      elevated: true,
      pointerNear: true,
      mouseAway: false
    })
    expect(isRequirementMet('grounded', context)).toBe(true)
    expect(isRequirementMet('sittableSurface', context)).toBe(true)
    expect(isRequirementMet('climbableSurface', context)).toBe(true)
    expect(isRequirementMet('elevated', context)).toBe(true)
    expect(isRequirementMet('pointerNear', context)).toBe(true)
    expect(isRequirementMet('mouseAway', context)).toBe(false)
  })
})

/* ========================================================================== */
/* 3. 加权抽取                                                                  */
/* ========================================================================== */

describe('B1 加权抽取', () => {
  it('同 seed 抽取序列一致、不同 seed 不同（可复现）', () => {
    const context = createContext({
      sittableSurfaceCount: 1,
      climbableSurfaceCount: 1,
      windowCount: 1,
      elevated: true
    })
    const first = sampleIds(2026, context, 120)
    const second = sampleIds(2026, context, 120)
    expect(second).toEqual(first)
    expect(sampleIds(2027, context, 120)).not.toEqual(first)
    expect(first.length).toBe(120)
  })

  it('无窗口/用户不在时只会抽到可满足要求的活动', () => {
    const context = createContext({ mouseAway: false, sinceInteractionMs: 0 })
    const ids = sampleIds(7, context, 300)
    expect(ids.length).toBe(300)
    for (const id of ids) {
      const definition = definitionOf(id)
      expect(definition.schedulable).toBe(true)
      for (const requirement of definition.requirements) {
        expect(isRequirementMet(requirement, context)).toBe(true)
      }
    }
    expect(ids).not.toContain('sit')
    expect(ids).not.toContain('climb')
    expect(ids).not.toContain('sleep') // 鼠标在场/刚交互过
  })

  it('冷却中的活动不会被抽到', () => {
    const walk = definitionOf('walkTo')
    const context = createContext({
      nowMs: 1_000,
      cooldownUntilMs: new Map<string, number>([[walk.id, 999_999]])
    })
    const ids = sampleIds(11, context, 400)
    expect(ids.length).toBe(400)
    expect(ids).not.toContain('walkTo')
  })

  it('全部活动冷却中 → 返回 null（调度器会短延时重试）', () => {
    const cooldowns = new Map<string, number>(
      ACTIVITY_DEFINITIONS.map((definition) => [definition.id, 999_999])
    )
    const random = createSeededRandom(1)
    expect(pickWeightedActivity(createContext({ nowMs: 0, cooldownUntilMs: cooldowns }), random)).toBeNull()
  })

  it('excluded 集合参与重抽（准备失败的活动不会重复选）', () => {
    const context = createContext({
      sittableSurfaceCount: 1,
      climbableSurfaceCount: 1,
      windowCount: 1,
      elevated: true
    })
    const random = createSeededRandom(3)
    for (let index = 0; index < 100; index += 1) {
      const definition = pickWeightedActivity(context, random, new Set<ActivityId>(['walkTo']))
      expect(definition).not.toBeNull()
      expect(definition?.id).not.toBe('walkTo')
    }
  })

  it('autonomousLevel=high 时活跃类活动占比高于 low', () => {
    const energetic: ReadonlySet<ActivityId> = new Set<ActivityId>([
      'walkTo',
      'returnCorner',
      'climb',
      'dropDown'
    ])
    const base = {
      sittableSurfaceCount: 2,
      climbableSurfaceCount: 2,
      windowCount: 2,
      elevated: true,
      idleElapsedMs: 90_000
    }
    const lowIds = sampleIds(101, createContext({ ...base, autonomousLevel: 'low' }), 2000)
    const highIds = sampleIds(102, createContext({ ...base, autonomousLevel: 'high' }), 2000)
    const lowEnergy = lowIds.filter((id) => energetic.has(id)).length / lowIds.length
    const highEnergy = highIds.filter((id) => energetic.has(id)).length / highIds.length
    expect(highEnergy).toBeGreaterThan(lowEnergy)
  })
})

/* ========================================================================== */
/* 4. 气泡冷却门                                                                */
/* ========================================================================== */

describe.skipIf(!VOICE_LINES_LOADED)('B1 气泡冷却门', () => {
  it('全局冷却：两次气泡间隔必须 ≥ 全局冷却（默认 60s）', () => {
    const gate = new BubbleGate()
    const random = createSeededRandom(1)
    const first = gate.tryEmit('pat', 0, random)
    expect(first).not.toBeNull()
    expect(DEFAULT_BUBBLE_COOLDOWNS.globalMs).toBeGreaterThanOrEqual(60_000)
    expect(gate.tryEmit('poke', 30_000, random)).toBeNull()
    expect(gate.tryEmit('poke', 59_999, random)).toBeNull()
    // 60s 后换一个从未用过的场景 → 可以冒泡
    const second = gate.tryEmit('poke', 60_000, random)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it('同类场景冷却：同一 category 冷却期内不重复', () => {
    const gate = new BubbleGate({ globalCooldownMs: 0, categoryCooldownMs: 30_000 })
    const random = createSeededRandom(2)
    expect(gate.tryEmit('pat', 0, random)).not.toBeNull()
    expect(gate.tryEmit('pat', 10_000, random)).toBeNull()
    expect(gate.isCategoryCooling('pat', 10_000)).toBe(true)
    expect(gate.isCategoryCooling('pat', 30_000)).toBe(false)
    expect(gate.tryEmit('pat', 30_000, random)).not.toBeNull()
  })

  it('不连续重复上一句；同一句有独立冷却', () => {
    const gate = new BubbleGate({ globalCooldownMs: 0, categoryCooldownMs: 0, lineCooldownMs: 999_999 })
    const random = createSeededRandom(3)
    const first = gate.tryEmit('hover', 0, random)
    const second = gate.tryEmit('hover', 1_000, random)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    // hover 池 2 条（官方台词）：两条都用过 + 同一句冷却很长 → 第 3 次没有候选
    expect(gate.tryEmit('hover', 2_000, random)).toBeNull()
    expect(gate.lastLine).toBe(second)
  })

  it('外部气泡刷新全局冷却；reset 清空全部状态', () => {
    const gate = new BubbleGate({ globalCooldownMs: 10_000 })
    const random = createSeededRandom(4)
    expect(gate.tryEmit('idle', 0, random)).not.toBeNull()
    gate.notifyExternalBubble(1_000)
    expect(gate.tryEmit('gloom', 2_000, random)).toBeNull()
    expect(gate.tryEmit('gloom', 11_000, random)).not.toBeNull()
    gate.reset()
    expect(gate.lastLine).toBeNull()
    expect(gate.isGlobalReady(11_000)).toBe(true)
  })

  it('时钟回退（now < last）不会永久卡死（允许重新冒泡）', () => {
    const gate = new BubbleGate({ globalCooldownMs: 10_000 })
    const random = createSeededRandom(5)
    expect(gate.tryEmit('idle', 50_000, random)).not.toBeNull()
    expect(gate.isGlobalReady(100)).toBe(true)
  })

  it.skipIf(!VOICE_LINES_LOADED)('台词池分类齐全、每类非空且类内无重复（B1 只负责文本，B3 不重复实现）', () => {
    const categories = [
      'pat',
      'poke',
      'drag',
      'celebrate',
      'gloom',
      'idle',
      'hover',
      'dshBusy',
      'dshDone',
      'dshError'
    ] as const
    for (const category of categories) {
      const pool = BUBBLE_LINES[category]
      expect(pool.length).toBeGreaterThan(0)
      // 类内不能有重复句（跨场景复用官方台词是允许的，见 dialogue.ts 头注释）
      expect(new Set(pool).size).toBe(pool.length)
    }
    expect(collectAllBubbleLines().length).toBeGreaterThanOrEqual(15)
  })
})

/* ========================================================================== */
/* 5. 随机工具                                                                  */
/* ========================================================================== */

describe('B1 随机工具', () => {
  it('createSeededRandom：确定序列、值域 [0,1)、seed 非有限也安全', () => {
    const a = createSeededRandom(0)
    const b = createSeededRandom(0)
    for (let index = 0; index < 20; index += 1) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
    const nanSeed = createSeededRandom(Number.NaN)
    expect(Number.isFinite(nanSeed())).toBe(true)
  })

  it('randomInt / randomRange 输出在区间内（含防御性输入）', () => {
    const random = createSeededRandom(6)
    for (let index = 0; index < 100; index += 1) {
      const intValue = randomInt(random, 10, 20)
      expect(Number.isInteger(intValue)).toBe(true)
      expect(intValue).toBeGreaterThanOrEqual(10)
      expect(intValue).toBeLessThanOrEqual(20)
      const floatValue = randomRange(random, -5, 5)
      expect(floatValue).toBeGreaterThanOrEqual(-5)
      expect(floatValue).toBeLessThan(5)
    }
    expect(randomInt(random, 5, 5)).toBe(5)
    expect(randomRange(random, 3, 3)).toBe(3)
    expect(randomInt(random, 9, 2)).toBe(9)
  })

  it('readRandom 钳制 NaN/负数/≥1；sanitizeRandom 缺省回退 Math.random', () => {
    expect(readRandom(() => Number.NaN)).toBe(0)
    expect(readRandom(() => -1)).toBe(0)
    expect(readRandom(() => 1)).toBeLessThan(1)
    expect(readRandom(() => 0.25)).toBe(0.25)
    expect(readRandom(() => {
      throw new Error('boom')
    })).toBe(0)
    const fallback = sanitizeRandom(undefined)
    expect(typeof fallback()).toBe('number')
    const clamped = sanitizeRandom(() => 2)
    expect(clamped()).toBeLessThan(1)
  })
})
