/**
 * B1 单元测试：`BehaviorDirector` 状态机 + 随机调度（Wave 2 B1 验收）。
 *
 * 覆盖（对应 task-1 验收条款）：
 * - 同 seed + 同输入 → 决策序列**完全一致**；不同 seed 决策序列不同（可复现性）；
 * - `config.autonomous=false` 时无任何随机漫游（只 idle + 响应交互/外部反应）；
 * - 优先级：drag > pat/poke 即时反应 > DSH 外部反应 > 自主活动；外部反应不打断拖拽；
 * - 自主活动可被摸头/拖拽打断；活动有最短持续；触发有冷却；
 * - 桌面事件：窗口关闭 → fall + drop；窗口移动 → 跟随（站姿 moveTo / 坐姿 sit）；
 * - 注视抑制：sleep/drag/fall/外部反应时 lookTarget=null；idle 时跟随鼠标；
 * - 输出合法性：目标点落在 workArea 内、无 NaN、枚举合法；脏输入不抛异常；
 * - 台词气泡：冷却 ≥ 全局冷却、同场景不刷屏、不连续重复、人设/短句检查；
 * - `getDebugSnapshot()` / `triggerActivity()` / `applyExternalReaction()` 行为。
 *
 * 纯 node 环境即可跑：本文件自造 `MotionSnapshot` / `DesktopSnapshot` / `InteractionSnapshot`
 * 假数据（不依赖真实窗口/模型/B2/B4/B5 实现）。
 */
import { describe, expect, it } from 'vitest'

import type { PetMood, Rect } from '../src/shared/types'
import {
  ACTIVITY_DEFINITIONS,
  BehaviorDirector,
  BUBBLE_LINES,
  collectAllBubbleLines,
  createSeededRandom,
  findActivityDefinition,
  LEVEL_PACE
} from '../src/renderer/src/behavior'
import {
  BUSY_BUBBLES,
  DEFEAT_BUBBLES,
  DRAG_BUBBLES,
  GREETING_BUBBLES,
  IDLE_BUBBLES,
  isOfficialVoiceLine,
  PAT_BUBBLES,
  POKE_BUBBLES,
  SUCCESS_BUBBLES,
  VOICE_LINE_STATS,
  VOICE_LINES_LOADED
} from '../src/renderer/src/core/voicelines'
import type {
  BehaviorConfigSubset,
  BehaviorDecision,
  BehaviorInput,
  DesktopSnapshot,
  DesktopSurface,
  ExternalReaction,
  InteractionEvent,
  InteractionSnapshot,
  MotionSnapshot,
  Point2D
} from '../src/renderer/src/core/wave2-contract'

/* ========================================================================== */
/* 假数据构造器                                                                */
/* ========================================================================== */

/** 工作区（窗口本地坐标；1080p workArea 常见尺寸）。 */
const WORK_AREA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
const GROUND_Y = WORK_AREA.y + WORK_AREA.height

const DEFAULT_CONFIG: BehaviorConfigSubset = {
  autonomous: true,
  autonomousLevel: 'normal',
  mischief: true,
  dshLink: true
}

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
const MOTION_KINDS = new Set(['hold', 'moveTo', 'sit', 'drop', 'teleport'])
const FACINGS = new Set(['left', 'right', 'front'])

/** 构造 `MotionSnapshot`（默认站在地面底部中央、面朝镜头）。 */
function createMotion(overrides: Partial<MotionSnapshot> = {}): MotionSnapshot {
  return {
    feet: { x: 800, y: GROUND_Y },
    velocity: { x: 0, y: 0 },
    facing: 'front',
    grounded: true,
    surfaceId: null,
    airborne: false,
    ...overrides
  }
}

/** 构造 `DesktopSurface`（默认窗口上沿；可覆盖任意字段）。 */
function createSurface(
  id: string,
  overrides: Partial<DesktopSurface> = {}
): DesktopSurface {
  return {
    id,
    kind: 'window-top',
    rect: { x: 400, y: 500, width: 700, height: 1 },
    top: 500,
    windowId: 5,
    sittable: true,
    climbable: false,
    ...overrides
  }
}

/** 构造 `DesktopSnapshot`（默认无窗口、纯地面）。 */
function createDesktop(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    surfaces: [],
    transitions: [],
    workArea: WORK_AREA,
    screenBounds: WORK_AREA,
    ...overrides
  }
}

function createInteraction(overrides: Partial<InteractionSnapshot> = {}): InteractionSnapshot {
  return {
    pointer: null,
    hoveringPet: false,
    dragging: false,
    patProgress: 0,
    ...overrides
  }
}

/** 构造一帧 `BehaviorInput`；`random` 由调用方注入（单测用 seeded RNG）。 */
function createInput(overrides: Partial<BehaviorInput> = {}): BehaviorInput {
  const base: BehaviorInput = {
    nowMs: 0,
    dt: 1 / 30,
    motion: createMotion(),
    desktop: createDesktop(),
    interaction: createInteraction(),
    events: [],
    external: null,
    config: DEFAULT_CONFIG,
    random: () => 0.5
  }
  return Object.assign(base, overrides)
}

/** 跑一段确定性帧序列，收集全部决策。 */
function runSequence(
  director: BehaviorDirector,
  seed: number,
  frames: number,
  build: (index: number, nowMs: number) => Partial<BehaviorInput> = () => ({})
): BehaviorDecision[] {
  const random = createSeededRandom(seed)
  const decisions: BehaviorDecision[] = []
  for (let index = 0; index < frames; index += 1) {
    const nowMs = Math.round(index * (1000 / 30))
    decisions.push(
      director.update(
        createInput({
          nowMs,
          random,
          ...build(index, nowMs)
        })
      )
    )
  }
  return decisions
}

/** 断言一条决策的结构合法性（枚举/有限数）。 */
function expectValidDecision(decision: BehaviorDecision): void {
  expect(PET_MOODS).toContain(decision.mood)
  expect(MOTION_KINDS.has(decision.motion.kind)).toBe(true)
  expect(FACINGS.has(decision.facing)).toBe(true)
  expect(decision.bubble === null || typeof decision.bubble === 'string').toBe(true)
  // 官方语音有长句（如「关于自己」系列），上限放宽；长度合法性由官方原文集合兜底
  if (decision.bubble !== null) expect(decision.bubble.length).toBeLessThanOrEqual(140)
  if (decision.lookTarget !== null) {
    expect(Number.isFinite(decision.lookTarget.x)).toBe(true)
    expect(Number.isFinite(decision.lookTarget.y)).toBe(true)
  }
  if (decision.motion.kind === 'moveTo') {
    const target = decision.motion.target
    expect(Number.isFinite(target.x)).toBe(true)
    expect(Number.isFinite(target.y)).toBe(true)
    expect(Number.isFinite(decision.motion.speedPxPerSec)).toBe(true)
    expect(decision.motion.speedPxPerSec).toBeGreaterThan(0)
    expect(decision.motion.mode === 'walk' || decision.motion.mode === 'climb').toBe(true)
  }
}

function withinWorkArea(point: Point2D): boolean {
  return (
    point.x >= WORK_AREA.x &&
    point.x <= WORK_AREA.x + WORK_AREA.width &&
    point.y >= WORK_AREA.y &&
    point.y <= WORK_AREA.y + WORK_AREA.height
  )
}

/* ========================================================================== */
/* 1. 复现性（同 seed 同输入 → 决策序列完全一致）                                 */
/* ========================================================================== */

describe('B1 复现性：seed 固定 → 决策序列一致', () => {
  it('同一 seed + 同一输入序列 → 决策完全一致（含活动切换/气泡/注视）', () => {
    const first = runSequence(new BehaviorDirector({ seed: 2026 }), 2026, 1200, (index) => ({
      // 鼠标缓慢移动 + 每 300 帧一次摸头，覆盖事件分支
      interaction: createInteraction({
        pointer: { x: 700 + (index % 300), y: 500 },
        hoveringPet: index % 300 < 30
      }),
      events: index % 300 === 150 ? ([{ kind: 'pat' }] as InteractionEvent[]) : []
    }))
    const second = runSequence(new BehaviorDirector({ seed: 2026 }), 2026, 1200, (index) => ({
      interaction: createInteraction({
        pointer: { x: 700 + (index % 300), y: 500 },
        hoveringPet: index % 300 < 30
      }),
      events: index % 300 === 150 ? ([{ kind: 'pat' }] as InteractionEvent[]) : []
    }))
    expect(second).toEqual(first)
    // 序列里两种以上 mood 说明状态机确实切换过，不是恒 idle 的平凡序列
    expect(new Set(first.map((decision) => decision.mood)).size).toBeGreaterThan(1)
  })

  it('不同 seed → 决策序列不同（随机调度确实在使用注入随机源）', () => {
    const a = runSequence(new BehaviorDirector(), 11, 1800)
    const b = runSequence(new BehaviorDirector(), 12, 1800)
    expect(b).not.toEqual(a)
  })

  it('seeded RNG 自身：同 seed 序列相同、不同 seed 不同、值域 [0,1)', () => {
    const first = createSeededRandom(42)
    const second = createSeededRandom(42)
    const valuesA: number[] = []
    const valuesB: number[] = []
    for (let index = 0; index < 40; index += 1) {
      valuesA.push(first())
      valuesB.push(second())
    }
    expect(valuesB).toEqual(valuesA)
    expect(valuesA.every((value) => value >= 0 && value < 1)).toBe(true)
    const other = createSeededRandom(43)
    expect(other()).not.toBe(valuesA[0])
  })
})

/* ========================================================================== */
/* 2. autonomous=false：无自主漫游                                             */
/* ========================================================================== */

describe('B1 自主活动开关', () => {
  it('autonomous=false：20 秒内始终 idle/hold，且调试面无下一次活动计划', () => {
    const director = new BehaviorDirector({ seed: 5 })
    const random = createSeededRandom(5)
    for (let index = 0; index < 600; index += 1) {
      const decision = director.update(
        createInput({
          nowMs: index * 33,
          random,
          config: { ...DEFAULT_CONFIG, autonomous: false, autonomousLevel: 'high' }
        })
      )
      expect(decision.mood).toBe('idle')
      expect(decision.motion.kind).toBe('hold')
      expect(decision.lookTarget).toBeNull()
    }
    const snapshot = director.getDebugSnapshot()
    expect(snapshot.autonomous).toBe(false) // 自主关闭时该字段为 false
    expect(snapshot.nextActivityInMs).toBeNull()
    expect(snapshot.activity).toBe('idle')
  })

  it('autonomous=false 仍响应摸头（交互优先级不受自主开关影响）', () => {
    const director = new BehaviorDirector({ seed: 7 })
    const random = createSeededRandom(7)
    director.update(
      createInput({ nowMs: 0, random, config: { ...DEFAULT_CONFIG, autonomous: false } })
    )
    const decision = director.update(
      createInput({
        nowMs: 100,
        random,
        config: { ...DEFAULT_CONFIG, autonomous: false },
        events: [{ kind: 'pat' }]
      })
    )
    expect(decision.mood).toBe('pat')
    expect(decision.poseHint).toBe('pat:head')
  })

  it('autonomous=true 时 nextActivityInMs 为正数计划值（variable-time 调度）', () => {
    const director = new BehaviorDirector({ seed: 9 })
    const snapshotAfter = director.update(createInput({ nowMs: 0, random: createSeededRandom(9) }))
    expect(snapshotAfter.mood).toBe('idle')
    const debug = director.getDebugSnapshot()
    expect(debug.nextActivityInMs).not.toBeNull()
    expect(debug.nextActivityInMs as number).toBeGreaterThan(0)
    expect(debug.nextActivityInMs as number).toBeLessThanOrEqual(12_000)
  })
})

/* ========================================================================== */
/* 3. 优先级：drag > pat/poke > 外部反应 > 自主活动                              */
/* ========================================================================== */

const EXTERNAL_DONE: ExternalReaction = {
  mood: 'dshDone',
  bubble: '理所当然的胜利。',
  durationMs: 6000,
  startedAtMs: 0
}

describe('B1 优先级与打断', () => {
  it('拖拽 > 外部反应：DSH 反应不打断拖拽', () => {
    const director = new BehaviorDirector({ seed: 21 })
    const random = createSeededRandom(21)
    const decision = director.update(
      createInput({
        nowMs: 0,
        random,
        external: EXTERNAL_DONE,
        interaction: createInteraction({ dragging: true, pointer: { x: 900, y: 600 } })
      })
    )
    expect(decision.mood).toBe('drag')
    expect(decision.motion.kind).toBe('hold')
    expect(decision.lookTarget).toBeNull()
    expect(director.getDebugSnapshot().activity).toBe('drag')
  })

  it('摸头/戳 > 外部反应（同一帧 pat 事件优先于 DSH 反应）', () => {
    const director = new BehaviorDirector({ seed: 22 })
    const random = createSeededRandom(22)
    const decision = director.update(
      createInput({
        nowMs: 0,
        random,
        external: EXTERNAL_DONE,
        events: [{ kind: 'poke', region: 'head' }]
      })
    )
    expect(decision.mood).toBe('pat')
    expect(decision.poseHint).toBe('poke:head')
  })

  it('外部反应 > 自主活动，且到期后回到 idle', () => {
    const director = new BehaviorDirector({ seed: 23 })
    const random = createSeededRandom(23)
    const first = director.update(
      createInput({ nowMs: 0, random, external: EXTERNAL_DONE })
    )
    expect(first.mood).toBe('dshDone')
    expect(first.lookTarget).toBeNull()
    expect(first.bubble).toBe('理所当然的胜利。')
    // 同一反应下一帧不重复说同一句
    const second = director.update(
      createInput({ nowMs: 500, random, external: EXTERNAL_DONE })
    )
    expect(second.mood).toBe('dshDone')
    expect(second.bubble).toBeNull()
    // 到期后回到自主/idle
    const third = director.update(createInput({ nowMs: 7000, random }))
    expect(third.mood).toBe('idle')
    expect(PET_MOODS).toContain(third.mood)
  })

  it('applyExternalReaction 注入等效于 input.external，且 dshLink=false 时静默', () => {
    const injected = new BehaviorDirector({ seed: 24 })
    injected.applyExternalReaction({ mood: 'dshError', bubble: null, durationMs: 5000, startedAtMs: 0 })
    const decision = injected.update(createInput({ nowMs: 100, random: createSeededRandom(24) }))
    expect(decision.mood).toBe('dshError')
    expect(decision.poseHint).toBe('dsh:error')
    expect(decision.lookTarget).toBeNull()

    const muted = new BehaviorDirector({ seed: 25 })
    const silent = muted.update(
      createInput({
        nowMs: 0,
        random: createSeededRandom(25),
        external: EXTERNAL_DONE,
        config: { ...DEFAULT_CONFIG, dshLink: false }
      })
    )
    expect(silent.mood).toBe('idle')
  })

  it('自主活动可被摸头打断；活动被取消后回 idle 重新排程', () => {
    const director = new BehaviorDirector({ seed: 26 })
    const random = createSeededRandom(26)
    director.update(createInput({ nowMs: 0, random }))
    expect(director.triggerActivity('idleCoin', 100)).toBe(true)
    const during = director.update(createInput({ nowMs: 200, random }))
    expect(during.poseHint).toBe('idle:coin')
    const interrupted = director.update(
      createInput({ nowMs: 300, random, events: [{ kind: 'pat' }] })
    )
    expect(interrupted.mood).toBe('pat')
    expect(director.getDebugSnapshot().nextActivityInMs).toBeNull() // 反应中无活动计划
    const after = director.update(createInput({ nowMs: 3_500, random }))
    expect(after.mood).toBe('idle')
    expect(director.getDebugSnapshot().nextActivityInMs).not.toBeNull()
  })
})

/* ========================================================================== */
/* 4. 最短持续 / 冷却 / 触发                                                    */
/* ========================================================================== */

describe('B1 活动时长与冷却', () => {
  it('活动至少持续 minDurationMs（不会被自主调度提前替换）', () => {
    const director = new BehaviorDirector({ seed: 31 })
    const random = createSeededRandom(31)
    director.update(createInput({ nowMs: 0, random }))
    expect(director.triggerActivity('idleCoin', 100)).toBe(true)
    const definition = findActivityDefinition('idleCoin')
    expect(definition).not.toBeNull()
    const minDuration = definition ? definition.minDurationMs : 3_200
    for (let nowMs = 200; nowMs < 100 + minDuration; nowMs += 33) {
      const decision = director.update(createInput({ nowMs, random }))
      expect(decision.poseHint).toBe('idle:coin')
      expect(decision.mood).toBe('idle')
    }
    // 超过 maxDuration 后活动应已结束（poseHint 不再是 idle:coin）
    const finished = director.update(createInput({ nowMs: 100 + 5_000, random }))
    expect(finished.poseHint).not.toBe('idle:coin')
  })

  it('冷却：冷却期内再次触发返回 false，冷却结束后可再次触发', () => {
    const director = new BehaviorDirector({ seed: 32 })
    const random = createSeededRandom(32)
    director.update(
      createInput({ nowMs: 0, random, config: { ...DEFAULT_CONFIG, autonomous: false } })
    )
    expect(director.triggerActivity('idleCoin', 1_000)).toBe(true)
    expect(director.getDebugSnapshot().cooldownCount).toBeGreaterThan(0)
    expect(director.triggerActivity('idleCoin', 2_000)).toBe(false) // 冷却中
    // 活动结束 + 冷却期内
    director.update(
      createInput({ nowMs: 6_000, random, config: { ...DEFAULT_CONFIG, autonomous: false } })
    )
    expect(director.triggerActivity('idleCoin', 7_000)).toBe(false)
    // 冷却结束（idleCoin 冷却 25s）后可以再次触发
    director.update(
      createInput({ nowMs: 26_000, random, config: { ...DEFAULT_CONFIG, autonomous: false } })
    )
    expect(director.getDebugSnapshot().cooldownCount).toBe(0)
    expect(director.triggerActivity('idleCoin', 27_000)).toBe(true)
  })

  it('triggerActivity：未知活动返回 false；拖拽中返回 false', () => {
    const director = new BehaviorDirector({ seed: 33 })
    const random = createSeededRandom(33)
    director.update(createInput({ nowMs: 0, random }))
    expect(director.triggerActivity('no-such-activity', 100)).toBe(false)
    expect(director.triggerActivity('idleCoin', 100)).toBe(true)
    director.update(
      createInput({
        nowMs: 200,
        random,
        interaction: createInteraction({ dragging: true })
      })
    )
    expect(director.triggerActivity('idleTidy', 300)).toBe(false)
  })

  it('debug 快照活动 id 使用契约示例命名（idle/walkTo/sit/climb/sleep/pat/drag/fall）', () => {
    const director = new BehaviorDirector({ seed: 34 })
    const random = createSeededRandom(34)
    // idle 变体在快照里统一显示 idle（与 wave2-contract 注释一致）
    director.update(createInput({ nowMs: 0, random }))
    director.triggerActivity('idleToss', 100)
    expect(director.getDebugSnapshot().activity).toBe('idle')
    expect(director.getDebugSnapshot().autonomous).toBe(false) // 调试强制 = 非自主发起
    const names = new Set(ACTIVITY_DEFINITIONS.map((definition) => definition.debugId))
    for (const name of ['idle', 'walkTo', 'sit', 'climb', 'sleep', 'dropDown']) {
      expect(names.has(name)).toBe(true)
    }
  })
})

/* ========================================================================== */
/* 5. 桌面事件：窗口关闭 → 掉落；窗口移动 → 跟随                                 */
/* ========================================================================== */

describe('B1 桌面事件驱动', () => {
  const windowSurface = createSurface('win-7-top', {
    windowId: 7,
    kind: 'window-top',
    rect: { x: 400, y: 519, width: 800, height: 1 },
    top: 520,
    sittable: true,
    climbable: false
  })

  /**
   * 站姿跟随用例专用：**不可坐**窗口上沿。
   * 2026-11-10 窗沿卧姿不变量下，可坐窗沿上的窗口移动一律保持 sit（见下「窗口移动（坐姿）」用例）；
   * 站姿 follow（moveTo walk）只在非可坐窗沿上还能发生，保留原覆盖。
   */
  const nonSittableWindowSurface = createSurface('win-7-top', {
    windowId: 7,
    kind: 'window-top',
    rect: { x: 400, y: 519, width: 800, height: 1 },
    top: 520,
    sittable: false,
    climbable: false
  })

  it('站在可坐窗口上沿：首帧即坐下（窗沿卧姿不变量，不再先站 700ms）', () => {
    const windowTop = createSurface('win-10-top', {
      windowId: 10,
      kind: 'window-top',
      rect: { x: 600, y: 400, width: 600, height: 1 },
      top: 400,
      sittable: true,
      climbable: false
    })
    const desktop = createDesktop({ surfaces: [windowTop] })
    const director = new BehaviorDirector({ seed: 11 })
    const random = createSeededRandom(11)
    const config = { ...DEFAULT_CONFIG, autonomous: true, autonomousLevel: 'high' as const }
    const standing = createMotion({
      grounded: true,
      surfaceId: 'win-10-top',
      feet: { x: 800, y: 400 }
    })
    let decision = director.update(createInput({ nowMs: 0, random, config, desktop, motion: standing }))
    // 2026-11-10 用户设计约束：可坐窗沿上只允许趴/坐/躺 → 首帧就是 sit，不再等 700ms 延迟。
    expect(decision.mood).toBe('sit')
    for (let nowMs = 200; nowMs <= 3_000 && decision.mood !== 'sit'; nowMs += 200) {
      decision = director.update(
        createInput({ nowMs, random, config, desktop, motion: standing })
      )
    }
    expect(decision.mood).toBe('sit')
    expect(decision.poseHint).toBe('sit:window')
  })

  it('落在可见可坐的窗口上沿后，恢复时优先坐下（用户把宠物放到窗沿的场景）', () => {
    const windowTop = createSurface('win-9-top', {
      windowId: 9,
      kind: 'window-top',
      rect: { x: 600, y: 400, width: 600, height: 1 },
      top: 400,
      sittable: true,
      climbable: false
    })
    const desktop = createDesktop({ surfaces: [windowTop] })
    const director = new BehaviorDirector({ seed: 7 })
    const random = createSeededRandom(7)
    const config = { ...DEFAULT_CONFIG, autonomous: true, autonomousLevel: 'high' as const }
    const landedMotion = createMotion({
      airborne: false,
      grounded: true,
      surfaceId: 'win-9-top',
      feet: { x: 800, y: 400 }
    })
    director.update(
      createInput({
        nowMs: 0,
        random,
        config,
        desktop,
        motion: createMotion({ airborne: true, grounded: false, feet: { x: 800, y: 300 } })
      })
    )
    const landed = director.update(
      createInput({ nowMs: 500, random, config, desktop, motion: landedMotion })
    )
    // 窗沿卧姿不变量：落地帧当帧即进入 recumbent（不再有 450ms 站立空窗）
    expect(landed.mood).toBe('sit')
    let decision = director.update(
      createInput({ nowMs: 1_000, random, config, desktop, motion: landedMotion })
    )
    for (let nowMs = 2_000; nowMs <= 15_000 && decision.mood !== 'sit'; nowMs += 1_000) {
      decision = director.update(
        createInput({ nowMs, random, config, desktop, motion: landedMotion })
      )
    }
    // 已经在窗沿上 → B1 判定 seated：mood=sit + hold（B2 已站在表面上，不需要再移动）
    expect(decision.mood).toBe('sit')
    expect(decision.motion.kind).toBe('hold')
    expect(decision.poseHint).toBe('sit:window')
  })

  it('autonomous=false 时落在可坐窗口上沿后仍会坐下（2026-11-10 修复：不再因自主关闭站着不动）', () => {
    const windowTop = createSurface('win-9-top', {
      windowId: 9,
      kind: 'window-top',
      rect: { x: 600, y: 400, width: 600, height: 1 },
      top: 400,
      sittable: true,
      climbable: false
    })
    const desktop = createDesktop({ surfaces: [windowTop] })
    const director = new BehaviorDirector({ seed: 7 })
    const random = createSeededRandom(7)
    const config = { ...DEFAULT_CONFIG, autonomous: false, autonomousLevel: 'high' as const }
    const landedMotion = createMotion({
      airborne: false,
      grounded: true,
      surfaceId: 'win-9-top',
      feet: { x: 800, y: 400 }
    })
    // 空中 → 落在窗沿（finishFall 写入「优先坐下」的直接反应）。
    director.update(
      createInput({
        nowMs: 0,
        random,
        config,
        desktop,
        motion: createMotion({ airborne: true, grounded: false, feet: { x: 800, y: 300 } })
      })
    )
    director.update(createInput({ nowMs: 500, random, config, desktop, motion: landedMotion }))
    let decision = director.update(
      createInput({ nowMs: 1_000, random, config, desktop, motion: landedMotion })
    )
    for (let nowMs = 1_500; nowMs <= 15_000 && decision.poseHint !== 'sit:window'; nowMs += 500) {
      decision = director.update(
        createInput({ nowMs, random, config, desktop, motion: landedMotion })
      )
    }
    // 自主活动关闭，但「放到窗沿 → 坐下」是直接反应：mood=sit + sit:window。
    expect(decision.mood).toBe('sit')
    expect(decision.poseHint).toBe('sit:window')
  })

  it('requestSitOnSurface：被直接吸附到可坐窗沿后，下一帧立刻坐（无 450ms 站立延迟）', () => {
    const windowTop = createSurface('win-9-top', {
      windowId: 9,
      kind: 'window-top',
      rect: { x: 600, y: 400, width: 600, height: 1 },
      top: 400,
      sittable: true,
      climbable: false
    })
    const desktop = createDesktop({ surfaces: [windowTop] })
    const director = new BehaviorDirector({ seed: 7 })
    const random = createSeededRandom(7)
    const config = { ...DEFAULT_CONFIG, autonomous: false }
    const snapped = createMotion({
      airborne: false,
      grounded: true,
      surfaceId: 'win-9-top',
      feet: { x: 800, y: 400 }
    })
    director.update(createInput({ nowMs: 0, random, config, desktop, motion: snapped }))
    director.requestSitOnSurface('win-9-top')
    const decision = director.update(createInput({ nowMs: 33, random, config, desktop, motion: snapped }))
    // 同一帧/下一帧即进入 sit（不再等 finishFall 的 450ms）。
    expect(decision.mood).toBe('sit')
    expect(decision.poseHint).toBe('sit:window')
  })

  it('窗口关闭 → mood=fall 且 motion=drop（掉落到地面由 B2 接管）', () => {
    const director = new BehaviorDirector({ seed: 41 })
    const random = createSeededRandom(41)
    // 先站在窗口上沿站稳一帧（建立支撑跟踪）
    const standing = director.update(
      createInput({
        nowMs: 0,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [windowSurface] })
      })
    )
    // 窗沿卧姿不变量：站在可坐窗沿上首帧即 sit
    expect(standing.mood).toBe('sit')
    // 窗口关闭：表面消失 + closed transition
    const falling = director.update(
      createInput({
        nowMs: 33,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({
          surfaces: [],
          transitions: [{ kind: 'closed', windowId: 7 }]
        })
      })
    )
    expect(falling.mood).toBe('fall')
    expect(falling.motion.kind).toBe('drop')
    expect(falling.lookTarget).toBeNull()
    // 掉落后不再下发 drop（避免 B2 重复触发）
    const fallingAgain = director.update(
      createInput({
        nowMs: 66,
        random,
        motion: createMotion({
          feet: { x: 800, y: 600 },
          grounded: false,
          airborne: true,
          surfaceId: null
        })
      })
    )
    expect(fallingAgain.mood).toBe('fall')
    expect(fallingAgain.motion.kind).toBe('hold')
  })

  it('窗口移动（站姿）→ 跟随：motion=moveTo 且目标为新表面中心', () => {
    const director = new BehaviorDirector({ seed: 42 })
    const random = createSeededRandom(42)
    // 不可坐窗沿：站姿跟随只在非可坐窗沿上还能发生（可坐窗沿走「窗口移动（坐姿）」用例）
    director.update(
      createInput({
        nowMs: 0,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [nonSittableWindowSurface] })
      })
    )
    const movedSurface = createSurface('win-7-top', {
      windowId: 7,
      rect: { x: 440, y: 489, width: 800, height: 1 },
      top: 490,
      sittable: false
    })
    const following = director.update(
      createInput({
        nowMs: 33,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({
          surfaces: [movedSurface],
          transitions: [{ kind: 'moved', windowId: 7, delta: { x: 40, y: -30 } }]
        })
      })
    )
    expect(following.motion.kind).toBe('moveTo')
    if (following.motion.kind === 'moveTo') {
      // 跟随窗口一律水平 walk（竖直方向由 B2 同窗口吸附 top 处理），不允许斜线 climb
      expect(following.motion.mode).toBe('walk')
      expect(following.motion.target.y).toBeCloseTo(490, 5)
      expect(following.motion.target.x).toBeCloseTo(440 + 800 / 2, 5)
      expect(withinWorkArea(following.motion.target)).toBe(true)
    }
    expect(following.mood).toBe('walk')
    expect(director.getDebugSnapshot().activity).toBe('followWindow')
    expect(director.getDebugSnapshot().autonomous).toBe(false)
  })

  it('窗口移动（坐姿）→ 跟随：重新下发 sit 指令到新表面', () => {
    const director = new BehaviorDirector({ seed: 43 })
    const random = createSeededRandom(43)
    // 站在可坐窗沿：窗沿卧姿不变量使首帧即 sit（无需 debug 强制触发）
    director.update(
      createInput({
        nowMs: 0,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [windowSurface] })
      })
    )
    expect(director.getDebugSnapshot().activity).toBe('sit')
    const seated = director.update(
      createInput({
        nowMs: 50,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [windowSurface] })
      })
    )
    expect(seated.mood).toBe('sit')
    const movedSurface = createSurface('win-7-top', {
      windowId: 7,
      rect: { x: 440, y: 489, width: 800, height: 1 },
      top: 490
    })
    const following = director.update(
      createInput({
        nowMs: 100,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({
          surfaces: [movedSurface],
          transitions: [{ kind: 'moved', windowId: 7, delta: { x: 40, y: -30 } }]
        })
      })
    )
    expect(following.motion.kind).toBe('sit')
    if (following.motion.kind === 'sit') {
      expect(following.motion.surfaceId).toBe('win-7-top')
    }
    expect(following.mood).toBe('sit')
    // 跟随结束后恢复坐姿（而不是站起来）
    const resumed = director.update(
      createInput({
        nowMs: 2_000,
        random,
        motion: createMotion({ feet: { x: 800, y: 490 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [movedSurface] })
      })
    )
    expect(resumed.mood).toBe('sit')
  })

  it('无关窗口的 moved/closed 不影响当前姿态', () => {
    const director = new BehaviorDirector({ seed: 44 })
    const random = createSeededRandom(44)
    director.update(
      createInput({
        nowMs: 0,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [windowSurface] })
      })
    )
    const decision = director.update(
      createInput({
        nowMs: 33,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({
          surfaces: [windowSurface],
          transitions: [{ kind: 'closed', windowId: 99 }]
        })
      })
    )
    // 窗沿卧姿不变量：无关窗口事件不影响当前姿态 → 可坐窗沿上保持 sit
    expect(decision.mood).toBe('sit')
    expect(decision.motion.kind).toBe('hold')
  })

  it('Lead 边界决策：menubar（top=0 会渲染出视口）不作 sit/climb 落点', () => {
    const menubar = createSurface('menubar', {
      kind: 'menubar',
      windowId: undefined,
      top: 0,
      rect: { x: 0, y: 0, width: WORK_AREA.width, height: 1 },
      sittable: true,
      climbable: true
    })
    const director = new BehaviorDirector({ seed: 45 })
    const random = createSeededRandom(45)
    director.update(
      createInput({
        nowMs: 0,
        random,
        config: { ...DEFAULT_CONFIG, autonomousLevel: 'high' },
        desktop: createDesktop({ surfaces: [menubar] })
      })
    )
    // 没有合法落点 → 调试强制触发也返回 false
    expect(director.triggerActivity('sit', 100)).toBe(false)
    expect(director.triggerActivity('climb', 100)).toBe(false)
    // 随机调度也不会选 sit / climb（权重为 0）
    const decisions = runSequence(director, 45, 1_200, () => ({
      config: { ...DEFAULT_CONFIG, autonomousLevel: 'high' },
      desktop: createDesktop({ surfaces: [menubar] })
    }))
    for (const decision of decisions) {
      expect(decision.mood).toBe('idle')
      expect(decision.motion.kind).not.toBe('sit')
      expect(decision.poseHint).not.toBe('sit:window')
    }
  })

  it('Lead 边界决策：Dock 上沿可以坐（在 workArea 内完全可见）', () => {
    const dock = createSurface('dock', {
      kind: 'dock',
      windowId: undefined,
      top: 840,
      rect: { x: 0, y: 839, width: WORK_AREA.width, height: 1 },
      sittable: true,
      climbable: false
    })
    const director = new BehaviorDirector({ seed: 46 })
    const random = createSeededRandom(46)
    director.update(
      createInput({ nowMs: 0, random, desktop: createDesktop({ surfaces: [dock] }) })
    )
    expect(director.triggerActivity('sit', 100)).toBe(true)
    const seated = director.update(
      createInput({ nowMs: 150, random, desktop: createDesktop({ surfaces: [dock] }) })
    )
    expect(seated.mood).toBe('sit')
    expect(seated.motion.kind).toBe('sit')
    if (seated.motion.kind === 'sit') expect(seated.motion.surfaceId).toBe('dock')
  })

  it('窗口大幅垂直移动（站姿）→ 跟随仍是水平 walk，不出现斜线 climb', () => {
    const director = new BehaviorDirector({ seed: 47 })
    const random = createSeededRandom(47)
    // 不可坐窗沿：站姿跟随只在非可坐窗沿上还能发生
    director.update(
      createInput({
        nowMs: 0,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({ surfaces: [nonSittableWindowSurface] })
      })
    )
    const movedSurface = createSurface('win-7-top', {
      windowId: 7,
      rect: { x: 400, y: 319, width: 800, height: 1 },
      top: 320,
      sittable: false
    })
    const following = director.update(
      createInput({
        nowMs: 33,
        random,
        motion: createMotion({ feet: { x: 800, y: 520 }, surfaceId: 'win-7-top' }),
        desktop: createDesktop({
          surfaces: [movedSurface],
          transitions: [{ kind: 'moved', windowId: 7, delta: { x: 0, y: -200 } }]
        })
      })
    )
    expect(following.motion.kind).toBe('moveTo')
    if (following.motion.kind === 'moveTo') {
      expect(following.motion.mode).toBe('walk')
    }
  })

  // climb 自主行为已按用户 2026-11-08 要求移除（schedulable=false / 权重 0），但 debug 显式触发保留，
  // 以下 3 例锁定「调试排查用」的两段式路径、右边缘选点与最小爬升高度。
  it('爬窗沿：两段式路径（先水平到侧边下方 walk，再沿边缘竖直 climb）', () => {
    // 窗口上沿 top=300，横向 x∈[500,1100]；宠物在地面 (800,900)
    const windowTop = createSurface('win-8-top', {
      windowId: 8,
      kind: 'window-top',
      rect: { x: 500, y: 299, width: 600, height: 1 },
      top: 300,
      sittable: true,
      climbable: false
    })
    const desktop = createDesktop({ surfaces: [windowTop] })
    const director = new BehaviorDirector({ seed: 81 })
    const random = createSeededRandom(81)
    director.update(createInput({ nowMs: 0, random, desktop }))
    expect(director.triggerActivity('climb', 100)).toBe(true)
    // 显式调试触发：活动可执行，但 debug 快照标记为非自主（不会被随机池选中）
    const debugSnapshot = director.getDebugSnapshot()
    expect(debugSnapshot.activity).toBe('climb')
    expect(debugSnapshot.autonomous).toBe(false)

    // 第一段：水平走向「离脚底更近的左边缘 x=500」，y 保持当前脚底 900
    const approach = director.update(createInput({ nowMs: 150, random, desktop }))
    expect(approach.mood).toBe('walk')
    expect(approach.motion.kind).toBe('moveTo')
    if (approach.motion.kind === 'moveTo') {
      expect(approach.motion.mode).toBe('walk')
      expect(approach.motion.target.x).toBeCloseTo(500, 5)
      expect(approach.motion.target.y).toBeCloseTo(900, 5)
      expect(approach.motion.speedPxPerSec).toBe(LEVEL_PACE.normal.walkSpeedPxPerSec)
    }
    expect(approach.facing).toBe('left')

    // 第二段：脚底已到边缘下方 → 改为竖直上爬，x 固定在边缘 500，目标 y=top+6（不是顶部中点）
    const ascend = director.update(
      createInput({
        nowMs: 200,
        random,
        desktop,
        motion: createMotion({ feet: { x: 500, y: 900 } })
      })
    )
    expect(ascend.mood).toBe('climb')
    expect(ascend.motion.kind).toBe('moveTo')
    if (ascend.motion.kind === 'moveTo') {
      expect(ascend.motion.mode).toBe('climb')
      expect(ascend.motion.target.x).toBeCloseTo(500, 5)
      expect(ascend.motion.target.y).toBeCloseTo(300 + 6, 5)
      // 慢速上爬：25–50 px/s
      expect(ascend.motion.speedPxPerSec).toBeGreaterThanOrEqual(25)
      expect(ascend.motion.speedPxPerSec).toBeLessThanOrEqual(50)
      // 绝不能是窗口顶部中点（坐的位置）
      expect(ascend.motion.target.x).not.toBeCloseTo(500 + 600 / 2, 5)
    }
    // 朝向窗口内侧（窗口中心 800，脚底 500 → 向右）
    expect(ascend.facing).toBe('right')

    // 最后一段到位（距 {500,306} 6px）→ 改发 hold 交给 B2 吸附落座，活动结束站到窗沿
    const landed = director.update(
      createInput({
        nowMs: 250,
        random,
        desktop,
        motion: createMotion({ feet: { x: 500, y: 312 } })
      })
    )
    expect(landed.mood).toBe('idle')
    expect(landed.motion.kind).toBe('hold')
  })

  // debug-only 活动：自主调度不会选中 climb，但显式触发仍需保持原有选边语义。
  it('爬窗沿：脚底在窗口中心右侧时选右边缘 x=rect 右边', () => {
    const windowTop = createSurface('win-8-top', {
      windowId: 8,
      kind: 'window-top',
      rect: { x: 500, y: 299, width: 600, height: 1 },
      top: 300,
      sittable: true
    })
    const desktop = createDesktop({ surfaces: [windowTop] })
    const director = new BehaviorDirector({ seed: 82 })
    const random = createSeededRandom(82)
    director.update(
      createInput({
        nowMs: 0,
        random,
        desktop,
        motion: createMotion({ feet: { x: 1_200, y: 900 } })
      })
    )
    expect(director.triggerActivity('climb', 100)).toBe(true)
    const approach = director.update(
      createInput({
        nowMs: 150,
        random,
        desktop,
        motion: createMotion({ feet: { x: 1_200, y: 900 } })
      })
    )
    expect(approach.motion.kind).toBe('moveTo')
    if (approach.motion.kind === 'moveTo') {
      expect(approach.motion.target.x).toBeCloseTo(1_100, 5) // 右边缘 = 500+600
      expect(approach.motion.target.y).toBeCloseTo(900, 5)
      expect(approach.motion.mode).toBe('walk')
    }
    expect(approach.facing).toBe('left') // 向右走 → dx>0 面向右？左边缘在左边…见下
  })

  // 调试显式触发也要遵守「不往下爬」：目标窗沿不足最小爬升高度 → 无可准备路径 → false。
  it('爬窗沿：目标窗沿低于脚底不足 24px 时不可触发（不往下爬）', () => {
    const lowSurface = createSurface('win-8-top', {
      windowId: 8,
      kind: 'window-top',
      rect: { x: 500, y: 899, width: 600, height: 1 },
      top: 900,
      sittable: true
    })
    const director = new BehaviorDirector({ seed: 83 })
    director.update(
      createInput({
        nowMs: 0,
        random: createSeededRandom(83),
        desktop: createDesktop({ surfaces: [lowSurface] }),
        motion: createMotion({ feet: { x: 800, y: 900 } })
      })
    )
    expect(director.triggerActivity('climb', 100)).toBe(false)
  })
})

/* ========================================================================== */
/* 6. 注视目标抑制 / 朝向                                                       */
/* ========================================================================== */

describe('B1 注视目标与朝向', () => {
  const POINTER: Point2D = { x: 1_200, y: 400 }

  it('idle 时 lookTarget 跟随鼠标，facing 朝向鼠标一侧', () => {
    const director = new BehaviorDirector({ seed: 51 })
    const decision = director.update(
      createInput({
        nowMs: 0,
        random: createSeededRandom(51),
        interaction: createInteraction({ pointer: POINTER })
      })
    )
    expect(decision.mood).toBe('idle')
    expect(decision.lookTarget).toEqual(POINTER)
    expect(decision.facing).toBe('right')
  })

  it('睡觉 / 拖拽 / 掉落 / 外部反应时 lookTarget 抑制为 null', () => {
    // 睡觉（调试强制；requirements 不阻挡调试触发）
    const sleeping = new BehaviorDirector({ seed: 52 })
    const random = createSeededRandom(52)
    sleeping.update(createInput({ nowMs: 0, random, interaction: createInteraction({ pointer: POINTER }) }))
    expect(sleeping.triggerActivity('sleep', 100)).toBe(true)
    const sleepDecision = sleeping.update(
      createInput({
        nowMs: 200,
        random,
        interaction: createInteraction({ pointer: POINTER })
      })
    )
    expect(sleepDecision.mood).toBe('sleep')
    expect(sleepDecision.lookTarget).toBeNull()

    // 拖拽
    const dragging = new BehaviorDirector({ seed: 53 })
    const dragDecision = dragging.update(
      createInput({
        nowMs: 0,
        random: createSeededRandom(53),
        interaction: createInteraction({ dragging: true, pointer: POINTER })
      })
    )
    expect(dragDecision.lookTarget).toBeNull()

    // 掉落（由窗口关闭触发）
    const windowSurface = createSurface('win-3-top', { windowId: 3, top: 500 })
    const faller = new BehaviorDirector({ seed: 54 })
    const fallRandom = createSeededRandom(54)
    faller.update(
      createInput({
        nowMs: 0,
        random: fallRandom,
        motion: createMotion({ feet: { x: 800, y: 500 }, surfaceId: 'win-3-top' }),
        desktop: createDesktop({ surfaces: [windowSurface] })
      })
    )
    const fallDecision = faller.update(
      createInput({
        nowMs: 33,
        random: fallRandom,
        motion: createMotion({ feet: { x: 800, y: 500 }, surfaceId: 'win-3-top' }),
        desktop: createDesktop({ surfaces: [], transitions: [{ kind: 'closed', windowId: 3 }] }),
        interaction: createInteraction({ pointer: POINTER })
      })
    )
    expect(fallDecision.mood).toBe('fall')
    expect(fallDecision.lookTarget).toBeNull()

    // 外部反应
    const external = new BehaviorDirector({ seed: 55 })
    const externalDecision = external.update(
      createInput({
        nowMs: 0,
        random: createSeededRandom(55),
        external: EXTERNAL_DONE,
        interaction: createInteraction({ pointer: POINTER })
      })
    )
    expect(externalDecision.lookTarget).toBeNull()

    // 鼠标不在窗口内 → idle 时 lookTarget 也是 null
    const away = new BehaviorDirector({ seed: 56 })
    const awayDecision = away.update(createInput({ nowMs: 0, random: createSeededRandom(56) }))
    expect(awayDecision.lookTarget).toBeNull()
  })
})

/* ========================================================================== */
/* 7. 台词气泡                                                                  */
/* ========================================================================== */

describe('B1 台词气泡池与冷却', () => {
  it.skipIf(!VOICE_LINES_LOADED)('台词池全部为官方语音原文（用户硬性要求，禁自创）：单一来源 + 场景映射', () => {
    const lines = collectAllBubbleLines()
    expect(lines.length).toBeGreaterThanOrEqual(30)
    for (const line of lines) {
      expect(line.trim().length).toBeGreaterThan(0)
      // 官方台词原文照录（含「…」「？」），且全部在官方语音单一来源内（= 不是自创/改写）
      expect(isOfficialVoiceLine(line)).toBe(true)
      expect(line.length).toBeLessThanOrEqual(120)
    }
    // 官方原文可能出现「主人」等词（如「做游戏的主人」），因此不再做词表黑名单，
    // 改由「全部 ∈ 已核实官方原文集合」这条更强约束兜底（见上方 isOfficialVoiceLine）。
    // 场景映射（用户 2026-11-08 指示）：成功=开启战利品/终结技/角色晋阶/角色满级/行迹激活；失败=无法战斗；
    // 闲置=关于自己/闲谈/爱好/烦恼/分享/见闻/关于*/回合待机；其它交互=最接近的官方分类。
    expect(BUBBLE_LINES.celebrate).toEqual(SUCCESS_BUBBLES)
    expect(BUBBLE_LINES.dshDone).toEqual(SUCCESS_BUBBLES)
    expect(BUBBLE_LINES.gloom).toEqual(DEFEAT_BUBBLES)
    expect(BUBBLE_LINES.dshError).toEqual(DEFEAT_BUBBLES)
    expect(BUBBLE_LINES.dshBusy).toEqual(BUSY_BUBBLES)
    expect(BUBBLE_LINES.idle).toEqual(IDLE_BUBBLES)
    expect(BUBBLE_LINES.hover).toEqual(GREETING_BUBBLES)
    expect(BUBBLE_LINES.pat).toEqual(PAT_BUBBLES)
    expect(BUBBLE_LINES.poke).toEqual(POKE_BUBBLES)
    expect(BUBBLE_LINES.drag).toEqual(DRAG_BUBBLES)
    // 各池非空且类内无重复
    for (const pool of Object.values(BUBBLE_LINES)) {
      expect(pool.length).toBeGreaterThan(0)
      expect(new Set(pool).size).toBe(pool.length)
    }
    // 官方数据规模（两个版本合计）
    expect(VOICE_LINE_STATS.base).toBeGreaterThanOrEqual(50)
    expect(VOICE_LINE_STATS.wave).toBeGreaterThanOrEqual(45)
  })

  it.skipIf(!VOICE_LINES_LOADED)('全局冷却生效：冷却期内不冒泡，冷却后才会冒泡且不连续重复', () => {
    const director = new BehaviorDirector({
      seed: 61,
      bubbleGlobalCooldownMs: 10_000,
      bubbleCategoryCooldownMs: 15_000,
      bubbleLineCooldownMs: 60_000
    })
    const random = createSeededRandom(61)
    const first = director.update(
      createInput({ nowMs: 0, random, events: [{ kind: 'hoverEnter' }] })
    )
    expect(first.bubble).not.toBeNull()
    const blockedByGlobal = director.update(
      createInput({ nowMs: 1_000, random, events: [{ kind: 'hoverEnter' }] })
    )
    expect(blockedByGlobal.bubble).toBeNull()
    const blockedByCategory = director.update(
      createInput({ nowMs: 12_000, random, events: [{ kind: 'hoverEnter' }] })
    )
    expect(blockedByCategory.bubble).toBeNull()
    const afterCooldown = director.update(
      createInput({ nowMs: 16_000, random, events: [{ kind: 'hoverEnter' }] })
    )
    expect(afterCooldown.bubble).not.toBeNull()
    expect(afterCooldown.bubble).not.toBe(first.bubble)
  })

  it.skipIf(!VOICE_LINES_LOADED)('摸头/戳气泡来自对应场景池', () => {
    const patDirector = new BehaviorDirector({ seed: 62 })
    const patDecision = patDirector.update(
      createInput({ nowMs: 0, random: createSeededRandom(62), events: [{ kind: 'pat' }] })
    )
    expect(patDecision.mood).toBe('pat')
    expect(BUBBLE_LINES.pat).toContain(patDecision.bubble as string)

    const pokeDirector = new BehaviorDirector({ seed: 63 })
    const pokeDecision = pokeDirector.update(
      createInput({
        nowMs: 0,
        random: createSeededRandom(63),
        events: [{ kind: 'poke', region: 'body' }]
      })
    )
    expect(pokeDecision.mood).toBe('pat')
    expect(pokeDecision.poseHint).toBe('poke:body')
    expect(BUBBLE_LINES.poke).toContain(pokeDecision.bubble as string)
  })

  it('外部 DSH 反应的台词由 B7 提供且只播一次（不每帧重复）', () => {
    const director = new BehaviorDirector({ seed: 64 })
    const random = createSeededRandom(64)
    const external: ExternalReaction = {
      mood: 'dshBusy',
      bubble: '这就满足了吗？买定离手，全押。',
      durationMs: 8000,
      startedAtMs: 0
    }
    const first = director.update(createInput({ nowMs: 0, random, external }))
    expect(first.bubble).toBe(external.bubble)
    const second = director.update(createInput({ nowMs: 500, random, external }))
    expect(second.bubble).toBeNull()
  })

  it('悬停唤醒睡觉/发呆并延后下一次自主活动（鼠标回来会避让）', () => {
    const director = new BehaviorDirector({ seed: 65 })
    const random = createSeededRandom(65)
    director.update(createInput({ nowMs: 0, random }))
    expect(director.triggerActivity('sleep', 100)).toBe(true)
    const wake = director.update(
      createInput({
        nowMs: 200,
        random,
        events: [{ kind: 'hoverEnter' }],
        interaction: createInteraction({ pointer: { x: 800, y: 700 }, hoveringPet: true })
      })
    )
    expect(wake.mood).toBe('idle')
    expect(director.getDebugSnapshot().activity).toBe('idle')
    const debug = director.getDebugSnapshot()
    expect(debug.nextActivityInMs).not.toBeNull()
    expect(debug.nextActivityInMs as number).toBeGreaterThanOrEqual(1_500)
  })
})

/* ========================================================================== */
/* 8. 输出合法性 / 边界 / 脏输入                                                */
/* ========================================================================== */

describe('B1 输出合法性与边界', () => {
  // F2a：H-5 修复后 sleep 在 high 档可调度、N-1 自动坐下有 GAP，活动序列变长；
  // 帧数 2000→3000 以保持「≥4 种 poseHint」的原断言（旧断言本身不涉及缺陷口径，仅覆盖窗口不同）。
  it('高强度自主活动 3000 帧：所有 moveTo/lookTarget 都在 workArea 内、无非法枚举', () => {
    const windowTop = createSurface('win-9-top', { windowId: 9, top: 560, rect: { x: 200, y: 559, width: 900, height: 1 } })
    const menubar = createSurface('menubar', {
      kind: 'menubar',
      windowId: undefined,
      top: 0,
      rect: { x: 0, y: 0, width: WORK_AREA.width, height: 1 },
      sittable: true,
      climbable: true
    })
    const director = new BehaviorDirector({ seed: 71 })
    const decisions = runSequence(director, 71, 3000, () => ({
      config: { ...DEFAULT_CONFIG, autonomousLevel: 'high' },
      desktop: createDesktop({ surfaces: [windowTop, menubar] })
    }))
    const motionKinds = new Set(decisions.map((decision) => decision.motion.kind))
    const moods = new Set(decisions.map((decision) => decision.mood))
    const poseHints = new Set(
      decisions.map((decision) => decision.poseHint).filter((hint): hint is string => Boolean(hint))
    )
    for (const decision of decisions) {
      expectValidDecision(decision)
      if (decision.lookTarget) expect(withinWorkArea(decision.lookTarget)).toBe(true)
      if (decision.motion.kind === 'moveTo') {
        expect(withinWorkArea(decision.motion.target)).toBe(true)
      }
    }
    // 状态机确实在多个活动间切换（不是恒 idle/恒 hold 的平凡序列）
    expect(motionKinds.has('moveTo')).toBe(true)
    expect(motionKinds.has('hold')).toBe(true)
    expect(moods.has('walk') || moods.has('climb')).toBe(true)
    expect(poseHints.size).toBeGreaterThanOrEqual(4)
  })

  it('脏输入（NaN/Infinity/非法枚举/缺字段）不抛异常且输出合法', () => {
    const director = new BehaviorDirector({ seed: 72 })
    const evilRandom = () => Number.NaN
    for (let index = 0; index < 200; index += 1) {
      const raw = {
        nowMs: index % 2 === 0 ? Number.NaN : index * 33,
        dt: Number.POSITIVE_INFINITY,
        motion: {
          feet: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
          velocity: { x: Number.NaN, y: Number.NaN },
          facing: 'sideways',
          grounded: 'yes',
          surfaceId: 42,
          airborne: Number.NaN
        },
        desktop: {
          surfaces: [
            null,
            { id: 42 },
            { id: 'bad', kind: 'not-a-kind', rect: { x: 'a', y: 2, width: -1, height: 0 } }
          ],
          transitions: [null, { kind: 'moved', windowId: Number.NaN }, { kind: 'closed' }],
          workArea: index % 3 === 0 ? null : { x: 0, y: 0, width: 1600, height: 900 }
        },
        interaction: { pointer: { x: Number.NaN, y: 3 }, hoveringPet: 'maybe', dragging: 1, patProgress: 99 },
        events: [null, { kind: 'poke', region: 'tail' }, { kind: 'dragEnd' }, { kind: 'unknown' }],
        external: { mood: 'angry', durationMs: Number.NaN, startedAtMs: 0 },
        config: { autonomous: 'off', autonomousLevel: 'insane', mischief: 0, dshLink: null },
        random: evilRandom
      }
      const decision = director.update(raw as unknown as BehaviorInput)
      expectValidDecision(decision)
    }
    const snapshot = director.getDebugSnapshot()
    expect(PET_MOODS).toContain(snapshot.mood)
    expect(Number.isFinite(snapshot.moodSinceMs)).toBe(true)
    expect(snapshot.cooldownCount).toBeGreaterThanOrEqual(0)
  })

  it('moodSinceMs 在 mood 切换时更新', () => {
    const director = new BehaviorDirector({ seed: 73 })
    const random = createSeededRandom(73)
    director.update(createInput({ nowMs: 1_000, random }))
    expect(director.getDebugSnapshot().mood).toBe('idle')
    const reaction = director.update(
      createInput({ nowMs: 5_000, random, events: [{ kind: 'pat' }] })
    )
    expect(reaction.mood).toBe('pat')
    expect(director.getDebugSnapshot().moodSinceMs).toBe(5_000)
  })
})
