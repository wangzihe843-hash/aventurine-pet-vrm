/**
 * 窗沿卧姿（recumbent）不变量回归测试（B1 行为层）：用户 2026-11-10 设计约束
 * 「桌宠在窗口上沿时只允许趴/坐/躺，禁止站立/走动」。
 *
 * 设计依据：`tests/tmp/inv-sitwindow/REPORT.md` §4.0/§4.1/§4.4-4.6/§7.2（Lead 已批准）。
 * 不变量定义（OnLedge）：`motion.grounded === true && currentSurface.kind === 'window-top'
 * && currentSurface.sittable === true`（含 D6a 段 id 抖动时 top±2px + 横向覆盖脚底的重匹配兜底）。
 *
 * 行为层判据（B1 纯逻辑；动画层安全网/坐姿变体轮换由 fix-window-anim 的 pet-runtime/main 测试覆盖）：
 * - OnLedge 时 B1 只产出 recumbent（默认 sit 族）→ 零站立/走动帧，无 AUTO_SIT_GAP 空档；
 * - 调度层禁止在窗沿抽 walkTo/returnCorner/lookAround/idle 变体/climb/sleep；
 * - 唯一自主离开 = 受控 `dropDown`（连续完成 ≥2 段后每段 P=0.4，autonomous=false 不跳）；
 * - 非可坐窗沿不进入不变量；地面行为完全不回归。
 *
 * 全部用 seeded RNG / 常量随机 + 假 desktop/motion 快照，确定性、无真实等待。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import { BehaviorDirector, createSeededRandom } from '../src/renderer/src/behavior'
import type {
  BehaviorConfigSubset,
  BehaviorDecision,
  BehaviorInput,
  DesktopSnapshot,
  DesktopSurface,
  InteractionEvent,
  InteractionSnapshot,
  MotionSnapshot
} from '../src/renderer/src/core/wave2-contract'

/* ========================================================================== */
/* 假数据构造器                                                                */
/* ========================================================================== */

const WA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
const DT = 1 / 30
const FRAME_MS = 1000 / 30

/** 与 activities.ts 的 sit 时长对齐（下界用于「≥2 段才跳下」的判据）。 */
const SIT_MIN_DURATION_MS = 20_000
/** 与 behavior-director.ts 的 WINDOW_TOP_REST_EXIT_MIN_SEGMENTS 对齐。 */
const REST_EXIT_MIN_SEGMENTS = 2
/** 「≥2 段完整 recumbent」的最早允许 dropDown 时刻（含帧取整余量）。 */
const EARLIEST_DROP_MS = REST_EXIT_MIN_SEGMENTS * SIT_MIN_DURATION_MS - 2 * FRAME_MS

const CONFIG: BehaviorConfigSubset = {
  autonomous: true,
  autonomousLevel: 'normal',
  mischief: true,
  dshLink: true
}
const HIGH_CONFIG: BehaviorConfigSubset = { ...CONFIG, autonomousLevel: 'high' }
const NON_AUTONOMOUS_CONFIG: BehaviorConfigSubset = { ...CONFIG, autonomous: false }
const EMPTY_INTERACTION: InteractionSnapshot = {
  pointer: null,
  hoveringPet: false,
  dragging: false,
  patProgress: 0
}

/** 可坐窗沿上允许出现的 B1 mood：recumbent（sit/sleep）或受控 dropDown 的 fall 过渡。 */
const RECUMBENT_OR_EXIT_MOODS = new Set(['sit', 'sleep', 'fall'])

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

function windowTop(
  id: string,
  windowId: number,
  top: number,
  x: number,
  width: number,
  sittable = true
): DesktopSurface {
  return {
    id,
    kind: 'window-top',
    rect: { x, y: top - 1, width, height: 1 },
    top,
    windowId,
    sittable,
    climbable: false
  }
}

function desktopOf(
  surfaces: DesktopSurface[],
  transitions: DesktopSnapshot['transitions'] = []
): DesktopSnapshot {
  return { surfaces, transitions, workArea: { ...WA }, screenBounds: { ...WA } }
}

function motionAt(
  feet: { x: number; y: number },
  surfaceId: string | null,
  grounded = true
): MotionSnapshot {
  return {
    feet: { ...feet },
    velocity: { x: 0, y: 0 },
    facing: 'front',
    grounded,
    surfaceId,
    airborne: !grounded
  }
}

function inputAt(
  nowMs: number,
  options: {
    motion: MotionSnapshot
    desktop: DesktopSnapshot
    random: () => number
    config?: BehaviorConfigSubset
    events?: InteractionEvent[]
    external?: BehaviorInput['external']
    interaction?: InteractionSnapshot
  }
): BehaviorInput {
  return {
    nowMs,
    dt: DT,
    motion: options.motion,
    desktop: options.desktop,
    interaction: options.interaction ?? EMPTY_INTERACTION,
    events: options.events ?? [],
    external: options.external ?? null,
    config: options.config ?? CONFIG,
    random: options.random
  }
}

interface LedgeSimResult {
  moodFrames: Record<string, number>
  /** 窗沿上出现站立/走动类 mood（recumbent/fall 之外的任意 mood）的帧数（不变量下 = 0）。 */
  standingFrames: number
  /** B1 mood=walk 帧数（walkTo/returnCorner/站姿 follow）。 */
  walkFrames: number
  /** 未处于 sit/dropDown 的帧中，出现的其它自主活动 id 集合（调度层兜底检查）。 */
  otherActivities: Set<string>
  /** 受控 dropDown 起始时刻（ms；按 mood 由非 fall → fall 判定一次起始）。 */
  dropStartMs: number[]
  /** 相邻两次 dropDown 起始的间隔（ms）。 */
  dropIntervals: number[]
  /** dropDown 首帧下发的 motion.kind。 */
  dropMotionKinds: string[]
  firstSitFrame: number
  firstDropMotionKind: string | null
}

/**
 * 站在可坐窗沿上的静态仿真（脚底固定在窗沿上、桌面快照固定）：用于观察 recumbent 轮换与受控
 * dropDown 时序（不接 B2，避免物理走动掉下窗沿干扰统计）。
 */
function runStaticLedgeSim(options: {
  seconds: number
  random: () => number
  config?: BehaviorConfigSubset
  surfaces?: DesktopSurface[]
  feet?: { x: number; y: number }
  surfaceId?: string
}): LedgeSimResult {
  const config = options.config ?? CONFIG
  const surfaces = options.surfaces ?? [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
  const desktop = desktopOf(surfaces)
  const standing = motionAt(options.feet ?? { x: 800, y: 600 }, options.surfaceId ?? 'win-A-top')
  const director = new BehaviorDirector({ random: options.random })
  const frameCount = Math.round(options.seconds * 30)
  const result: LedgeSimResult = {
    moodFrames: {},
    standingFrames: 0,
    walkFrames: 0,
    otherActivities: new Set<string>(),
    dropStartMs: [],
    dropIntervals: [],
    dropMotionKinds: [],
    firstSitFrame: -1,
    firstDropMotionKind: null
  }
  let previousMood: string | null = null
  for (let index = 0; index < frameCount; index += 1) {
    const nowMs = Math.round(index * FRAME_MS)
    const decision = director.update(
      inputAt(nowMs, { motion: standing, desktop, random: options.random, config })
    )
    const debug = director.getDebugSnapshot()
    result.moodFrames[decision.mood] = (result.moodFrames[decision.mood] ?? 0) + 1
    if (!RECUMBENT_OR_EXIT_MOODS.has(decision.mood)) result.standingFrames += 1
    if (decision.mood === 'walk') result.walkFrames += 1
    if (decision.mood === 'sit' && result.firstSitFrame < 0) result.firstSitFrame = index
    if (
      decision.mood !== 'fall' &&
      debug.activity !== 'sit' &&
      debug.activity !== 'dropDown'
    ) {
      result.otherActivities.add(debug.activity)
    }
    if (decision.mood === 'fall' && previousMood !== 'fall') {
      const previousDropStart = result.dropStartMs[result.dropStartMs.length - 1]
      if (previousDropStart !== undefined) result.dropIntervals.push(nowMs - previousDropStart)
      result.dropStartMs.push(nowMs)
      result.dropMotionKinds.push(decision.motion.kind)
      if (result.firstDropMotionKind === null) result.firstDropMotionKind = decision.motion.kind
    }
    previousMood = decision.mood
  }
  return result
}

/* ========================================================================== */
/* T1：静态站可坐窗沿 10min × 3 seeds → 0 站立/走动帧，只有 recumbent + 受控跳下   */
/* ========================================================================== */

describe('T1 窗沿卧姿不变量：静态站可坐窗沿 10min 零站立/走动', () => {
  const runs = [2026, 7, 11].map((seed) => ({
    seed,
    result: runStaticLedgeSim({ seconds: 600, random: createSeededRandom(seed) })
  }))

  it('mood 只 recumbent（sit）+ dropDown 的 fall 过渡；walkTo/returnCorner/lookAround/idle 变体/climb/sleep 帧 = 0', () => {
    for (const { seed, result } of runs) {
      // eslint-disable-next-line no-console
      console.log('[T1]', {
        seed,
        moodFrames: result.moodFrames,
        standingFrames: result.standingFrames,
        walkFrames: result.walkFrames,
        otherActivities: [...result.otherActivities],
        drops: result.dropStartMs.length
      })
      // 首帧即 recumbent（无 700ms 站立延迟、无落地缓冲站立帧）
      expect(result.firstSitFrame).toBe(0)
      // 不变量核心：零站立/走动帧
      expect(result.standingFrames).toBe(0)
      expect(result.walkFrames).toBe(0)
      // 调度层兜底：窗沿上不会抽到 sit/dropDown 之外的自主活动
      expect([...result.otherActivities]).toEqual([])
      // mood 只可能是 recumbent 或受控 dropDown 的 fall 过渡
      for (const mood of Object.keys(result.moodFrames)) {
        expect(RECUMBENT_OR_EXIT_MOODS.has(mood)).toBe(true)
      }
      // 10min 内应有受控 dropDown（≥2 段后 P=0.4，均值 ~1–2 分钟一次）
      expect(result.dropStartMs.length).toBeGreaterThan(0)
      expect(result.dropStartMs[0]!).toBeGreaterThanOrEqual(EARLIEST_DROP_MS)
      // 跳下首帧：mood=fall、motion.kind='drop'
      expect(result.firstDropMotionKind).toBe('drop')
    }
  })
})

/* ========================================================================== */
/* T2：放置（requestSitOnSurface）→ 首帧 sit；段结束当帧续段（无 idle 帧）          */
/* ========================================================================== */

describe('T2 放置到可坐窗沿：首帧 sit，段结束当帧续段', () => {
  it('放置后首帧 mood=sit；120s 内 0 站立/0 idle 帧；段边界帧仍是 sit', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const snapped = motionAt({ x: 800, y: 600 }, 'win-A-top')
    // 常量 0.5：sit 时长恒 = randomInt(20000,35000,0.5) = 27500ms；dropDown 判定 0.5≥0.4 不跳
    // → 段边界时刻确定：27500 / 55000 / 82500 / 110000ms（帧号 825/1650/2475/3300）。
    const director = new BehaviorDirector({ random: () => 0.5 })
    const random = (): number => 0.5
    director.requestSitOnSurface('win-A-top')
    const first = director.update(
      inputAt(0, { motion: snapped, desktop, random })
    )
    expect(first.mood).toBe('sit')
    expect(first.motion.kind).toBe('hold')
    expect(first.poseHint).toBe('sit:window')
    const boundaryFrames = new Set([825, 1_650, 2_475, 3_300])
    const boundaryMoods: string[] = []
    const moodFrames: Record<string, number> = {}
    for (let index = 1; index < 120 * 30; index += 1) {
      const nowMs = Math.round(index * FRAME_MS)
      const decision = director.update(inputAt(nowMs, { motion: snapped, desktop, random }))
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
      if (boundaryFrames.has(index)) boundaryMoods.push(decision.mood)
    }
    // eslint-disable-next-line no-console
    console.log('[T2]', { moodFrames, boundaryMoods })
    // 段边界（上一段 sit 到点）当帧直接续下一段 sit，没有 1 帧 idle 过渡
    expect(boundaryMoods).toEqual(['sit', 'sit', 'sit', 'sit'])
    expect(moodFrames.sit).toBe(120 * 30 - 1)
    expect(moodFrames.idle ?? 0).toBe(0)
    expect(moodFrames.walk ?? 0).toBe(0)
  })
})

/* ========================================================================== */
/* T3：空中落到可坐窗沿（finishFall）→ 落地帧即 recumbent，绑定落地表面            */
/* ========================================================================== */

describe('T3 落到可坐窗沿：落地帧即 recumbent（N-2 绑定落地表面）', () => {
  it('落地帧 mood=sit、motion=hold、poseHint=sit:window；之后 10s 无站立帧', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    const falling = motionAt({ x: 800, y: 300 }, null, false)
    const landedOnA = motionAt({ x: 800, y: 600 }, 'win-A-top')
    const airborne = director.update(
      inputAt(0, { motion: falling, desktop, random, config: HIGH_CONFIG })
    )
    expect(airborne.mood).toBe('fall')
    const landed = director.update(
      inputAt(500, { motion: landedOnA, desktop, random, config: HIGH_CONFIG })
    )
    // finishFall 的「优先坐一次」被不变量接管：落地帧当帧即坐（不再有 450ms 站立空窗）
    expect(landed.mood).toBe('sit')
    expect(landed.motion.kind).toBe('hold')
    expect(landed.poseHint).toBe('sit:window')
    // 之后 10s 无站立/走动帧
    const moodFrames: Record<string, number> = {}
    for (let index = 0; index < 10 * 30; index += 1) {
      const nowMs = 500 + Math.round(index * FRAME_MS)
      const decision = director.update(
        inputAt(nowMs, { motion: landedOnA, desktop, random, config: HIGH_CONFIG })
      )
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
      expect(RECUMBENT_OR_EXIT_MOODS.has(decision.mood)).toBe(true)
    }
    expect(moodFrames.sit).toBe(10 * 30)
  })
})

/* ========================================================================== */
/* T4：坐着被摸头打断 → 反应结束下一帧 recumbent（无 idle 回站）                   */
/* ========================================================================== */

describe('T4 坐着被 pat 打断：反应结束下一帧回 recumbent', () => {
  it('pat 反应期 mood=pat（B1 允许，动画层安全网压坐姿）；反应结束下一帧即 sit', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    const sitting = motionAt({ x: 800, y: 600 }, 'win-A-top')
    expect(director.update(inputAt(0, { motion: sitting, desktop, random })).mood).toBe('sit')
    // pat 时长 randomInt(1700,2400,0.5)=2050ms → 1000ms 触发、3050ms 结束
    const moodFrames: Record<string, number> = {}
    let firstSitAfterPatFrame = -1
    let lastPatFrame = -1
    for (let index = 1; index < 150; index += 1) {
      const nowMs = Math.round(index * FRAME_MS)
      const decision = director.update(
        inputAt(nowMs, {
          motion: sitting,
          desktop,
          random,
          events: index === 30 ? [{ kind: 'pat' }] : []
        })
      )
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
      if (decision.mood === 'pat') lastPatFrame = index
      if (decision.mood === 'sit' && lastPatFrame >= 0 && firstSitAfterPatFrame < 0) {
        firstSitAfterPatFrame = index
      }
    }
    // eslint-disable-next-line no-console
    console.log('[T4]', { moodFrames, lastPatFrame, firstSitAfterPatFrame })
    // B1 反应 mood 允许（动画层安全网负责视觉不站）
    expect(moodFrames.pat ?? 0).toBeGreaterThan(0)
    // 反应结束下一帧就回到 recumbent（旧实现会回 idle 站立）
    expect(firstSitAfterPatFrame).toBe(lastPatFrame + 1)
    expect(moodFrames.idle ?? 0).toBe(0)
    expect(moodFrames.walk ?? 0).toBe(0)
  })
})

/* ========================================================================== */
/* T5：窗沿上 debug 触发站立类活动被禁止；不产生 moveTo                             */
/* ========================================================================== */

describe('T5 窗沿上禁止调试触发站立/走动类活动', () => {
  it('triggerActivity(walkTo/returnCorner/lookAround/sleep/climb/idle 变体) 返回 false；后续无 moveTo', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    const sitting = motionAt({ x: 800, y: 600 }, 'win-A-top')
    expect(director.update(inputAt(0, { motion: sitting, desktop, random })).mood).toBe('sit')
    for (const activityId of [
      'walkTo',
      'returnCorner',
      'lookAround',
      'sleep',
      'climb',
      'idleTidy',
      'idleGaze'
    ]) {
      expect(director.triggerActivity(activityId, 500)).toBe(false)
    }
    // 触发被拒后继续跑：不产生指向窗沿/窗外的 moveTo，一直是 sit
    for (let index = 1; index < 90; index += 1) {
      const decision = director.update(
        inputAt(Math.round(index * FRAME_MS), { motion: sitting, desktop, random })
      )
      expect(decision.motion.kind).not.toBe('moveTo')
      expect(decision.mood).toBe('sit')
    }
  })
})

/* ========================================================================== */
/* T6：autonomous=false → 仍维持 recumbent，且永不自主跳下                        */
/* ========================================================================== */

describe('T6 autonomous=false：仍维持 recumbent，不跳下', () => {
  it('放置后首帧 sit；120s 全 sit；0 fall/drop', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    const snapped = motionAt({ x: 800, y: 600 }, 'win-A-top')
    director.requestSitOnSurface('win-A-top')
    const moodFrames: Record<string, number> = {}
    for (let index = 0; index < 120 * 30; index += 1) {
      const nowMs = Math.round(index * FRAME_MS)
      const decision = director.update(
        inputAt(nowMs, {
          motion: snapped,
          desktop,
          random,
          config: NON_AUTONOMOUS_CONFIG
        })
      )
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
    }
    // eslint-disable-next-line no-console
    console.log('[T6]', moodFrames)
    expect(moodFrames.sit).toBe(120 * 30)
    expect(moodFrames.fall ?? 0).toBe(0)
    expect(moodFrames.idle ?? 0).toBe(0)
    expect(moodFrames.walk ?? 0).toBe(0)
    expect(director.getDebugSnapshot().nextActivityInMs).toBeNull()
  })
})

/* ========================================================================== */
/* T7：dropDown 受控概率：前 2 段不跳；之后每段 P=0.4；均值 ~1–2 分钟             */
/* ========================================================================== */

describe('T7 受控 dropDown：前 2 段不跳，之后每段 P=0.4', () => {
  const seeds = Array.from({ length: 12 }, (_, index) => index + 1)
  const runs = seeds.map((seed) => ({
    seed,
    result: runStaticLedgeSim({ seconds: 600, random: createSeededRandom(seed) })
  }))
  const allIntervals = runs.flatMap(({ result }) => result.dropIntervals)

  it('每个 seed：首次跳下 ≥ 2 段完整 recumbent；相邻跳下间隔同样 ≥ 2 段', () => {
    for (const { seed, result } of runs) {
      expect(result.dropStartMs.length).toBeGreaterThan(0)
      expect(result.dropStartMs[0]!).toBeGreaterThanOrEqual(EARLIEST_DROP_MS)
      for (const interval of result.dropIntervals) {
        expect(interval).toBeGreaterThanOrEqual(EARLIEST_DROP_MS)
      }
      // 跳下时 mood=fall / motion=drop
      expect(result.firstDropMotionKind).toBe('drop')
      void seed
    }
  })

  it('多 seed 统计：平均离开间隔 ≈1–2 分钟（P=0.4 的几何分布，均值 ~97s）', () => {
    expect(allIntervals.length).toBeGreaterThanOrEqual(seeds.length)
    const meanInterval = allIntervals.reduce((sum, value) => sum + value, 0) / allIntervals.length
    const minInterval = Math.min(...allIntervals)
    const maxInterval = Math.max(...allIntervals)
    // eslint-disable-next-line no-console
    console.log('[T7]', {
      drops: runs.reduce((sum, { result }) => sum + result.dropStartMs.length, 0),
      intervals: allIntervals.length,
      meanInterval: Math.round(meanInterval),
      minInterval,
      maxInterval
    })
    // 均值 ~1–2 分钟（区间给宽：多 seed 抽样波动）
    expect(meanInterval).toBeGreaterThanOrEqual(60_000)
    expect(meanInterval).toBeLessThanOrEqual(240_000)
    expect(minInterval).toBeGreaterThanOrEqual(EARLIEST_DROP_MS)
  })

  it('autonomous=false：10min 内 0 次 dropDown（不主动离开）', () => {
    const result = runStaticLedgeSim({
      seconds: 600,
      random: createSeededRandom(2026),
      config: NON_AUTONOMOUS_CONFIG
    })
    expect(result.dropStartMs).toEqual([])
    expect(result.moodFrames.fall ?? 0).toBe(0)
    expect(result.moodFrames.sit).toBe(600 * 30)
  })
})

/* ========================================================================== */
/* T8：坐着时窗口移动（followWindow）→ 保持 sit，无 walk/idle                      */
/* ========================================================================== */

describe('T8 坐着跟随窗口移动：保持 recumbent', () => {
  it('moved transition → followWindow 下发 sit；活动结束后仍 sit（无站姿跟随）', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const movedSurface = windowTop('win-A-top', 1, 590, 400, 800)
    const movedDesktop = desktopOf([groundSurface(), movedSurface], [
      { kind: 'moved', windowId: 1, delta: { x: 0, y: -10 } }
    ])
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    expect(
      director.update(
        inputAt(0, { motion: motionAt({ x: 800, y: 600 }, 'win-A-top'), desktop, random })
      ).mood
    ).toBe('sit')
    // 窗口上移 10px（宠物正坐着 → previousSitting=true）
    const following = director.update(
      inputAt(33, {
        motion: motionAt({ x: 800, y: 590 }, 'win-A-top'),
        desktop: movedDesktop,
        random
      })
    )
    expect(following.mood).toBe('sit')
    expect(following.motion.kind).toBe('sit')
    if (following.motion.kind === 'sit') {
      expect(following.motion.surfaceId).toBe('win-A-top')
    }
    // followWindow 活动结束（1000–1400ms）后恢复 sit；全程无 walk/idle 帧
    const moodFrames: Record<string, number> = {}
    for (let index = 0; index < 300; index += 1) {
      const nowMs = 33 + Math.round(index * FRAME_MS)
      const decision = director.update(
        inputAt(nowMs, {
          motion: motionAt({ x: 800, y: 590 }, 'win-A-top'),
          desktop: desktopOf([groundSurface(), movedSurface]),
          random
        })
      )
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
    }
    // eslint-disable-next-line no-console
    console.log('[T8]', moodFrames)
    expect(moodFrames.sit).toBe(300)
    expect(moodFrames.idle ?? 0).toBe(0)
    expect(moodFrames.walk ?? 0).toBe(0)
  })
})

/* ========================================================================== */
/* T9：非可坐 window-top 不进入不变量（调度照旧）                                  */
/* ========================================================================== */

describe('T9 非可坐窗沿不进入不变量', () => {
  it('grounded 在 sittable=false 窗沿：首帧 idle（不被强制 sit）；debug 触发 walkTo 仍可用', () => {
    const ledge = windowTop('win-A-top', 1, 600, 400, 800, false)
    const surfaces = [groundSurface(), ledge]
    const desktop = desktopOf(surfaces)
    const random = createSeededRandom(77)
    const director = new BehaviorDirector({ random })
    const standing = motionAt({ x: 800, y: 600 }, 'win-A-top')
    const first = director.update(
      inputAt(0, { motion: standing, desktop, random, config: HIGH_CONFIG })
    )
    // 非可坐窗沿不在用户约束内 → 不进入 recumbent 不变量（首帧是 idle 基线，而非 sit）
    expect(first.mood).toBe('idle')
    // 调度层兜底只锁「可坐」窗沿 → debug 触发 walkTo 仍可用（旧行为保留）
    expect(director.triggerActivity('walkTo', 100)).toBe(true)
    const moodFrames: Record<string, number> = {}
    for (let index = 0; index < 20 * 30; index += 1) {
      const nowMs = 100 + Math.round(index * FRAME_MS)
      const decision = director.update(
        inputAt(nowMs, { motion: standing, desktop, random, config: HIGH_CONFIG })
      )
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
    }
    // 非可坐窗沿上仍允许站立/走动类活动（不强制 sit）
    expect(moodFrames.sit ?? 0).toBe(0)
    expect((moodFrames.idle ?? 0) + (moodFrames.walk ?? 0)).toBeGreaterThan(0)
  })
})

/* ========================================================================== */
/* T10：D6a 段 id 抖动（id 对不上、同 top/覆盖脚底）→ 仍判定 OnLedge，0 站立帧      */
/* ========================================================================== */

describe('T10 D6a 段 id 抖动兜底：仍判定 OnLedge 且 0 站立帧', () => {
  it('motion.surfaceId 暂时对不上、快照里只有同 top 的窗沿 → 仍 recumbent', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    // D6a 抖动：脚底仍在新表面上，但 motion.surfaceId 暂时对不上（null / 旧 id），
    // 快照里只有新 id 的同 top 表面 → onSittableWindowTop 按 top±2px + 横向覆盖脚底重匹配。
    const jittered = motionAt({ x: 800, y: 600 }, null)
    const moodFrames: Record<string, number> = {}
    const motionKinds = new Set<string>()
    for (let index = 0; index < 10 * 30; index += 1) {
      const nowMs = Math.round(index * FRAME_MS)
      const decision = director.update(inputAt(nowMs, { motion: jittered, desktop, random }))
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
      motionKinds.add(decision.motion.kind)
    }
    // eslint-disable-next-line no-console
    console.log('[T10]', { moodFrames, motionKinds: [...motionKinds] })
    // 重匹配到同 top 的窗沿 → 仍进入不变量：0 站立帧，mood 恒 sit
    expect(moodFrames.sit).toBe(10 * 30)
    expect(moodFrames.idle ?? 0).toBe(0)
    expect(moodFrames.walk ?? 0).toBe(0)
    // 坐下/接近指令合法（sit 或 hold；不能是 moveTo）
    for (const kind of motionKinds) {
      expect(['sit', 'hold']).toContain(kind)
    }
  })
})

/* ========================================================================== */
/* 附加：窗口关闭 → fall 过渡；落地后回到地面行为（不强行 sit）                     */
/* ========================================================================== */

describe('窗口关闭：原窗沿消失 → fall/drop（既有 transitions 路径）', () => {
  it('坐着时窗口关闭 → 首帧 mood=fall/motion=drop；落地后回到地面行为（非 sit）', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const random = (): number => 0.5
    const director = new BehaviorDirector({ random })
    const sitting = motionAt({ x: 800, y: 600 }, 'win-A-top')
    expect(director.update(inputAt(0, { motion: sitting, desktop, random })).mood).toBe('sit')
    const falling = director.update(
      inputAt(33, {
        motion: sitting,
        desktop: desktopOf([groundSurface()], [{ kind: 'closed', windowId: 1 }]),
        random
      })
    )
    expect(falling.mood).toBe('fall')
    expect(falling.motion.kind).toBe('drop')
    // 下坠帧
    const airborne = motionAt({ x: 800, y: 700 }, null, false)
    const fallingAgain = director.update(
      inputAt(66, { motion: airborne, desktop: desktopOf([groundSurface()]), random })
    )
    expect(fallingAgain.mood).toBe('fall')
    expect(fallingAgain.motion.kind).toBe('hold')
    // 落回地面：返回地面行为（不变量只在可坐窗沿生效 → 不是 sit 锁定）
    const onGround = motionAt({ x: 800, y: 900 }, 'screen-bottom')
    let decision = director.update(
      inputAt(2_000, { motion: onGround, desktop: desktopOf([groundSurface()]), random })
    )
    for (let index = 0; index < 60 && decision.mood === 'sit'; index += 1) {
      decision = director.update(
        inputAt(2_000 + index * 100, {
          motion: onGround,
          desktop: desktopOf([groundSurface()]),
          random
        })
      )
    }
    expect(decision.mood).not.toBe('sit')
  })
})

/* ========================================================================== */
/* 不回归：地面行为完全照旧（idle/walk 等由随机调度正常产出）                       */
/* ========================================================================== */

describe('不回归：地面行为照旧（不受窗沿不变量影响）', () => {
  it('地面 10min 自主（high）：有 idle 帧、抽到 walkTo 等地面活动', () => {
    const desktop = desktopOf([groundSurface()])
    const random = createSeededRandom(2026)
    const director = new BehaviorDirector({ random })
    const onGround = motionAt({ x: 800, y: 900 }, 'screen-bottom')
    const moodFrames: Record<string, number> = {}
    const activityFrames: Record<string, number> = {}
    for (let index = 0; index < 600 * 30; index += 1) {
      const nowMs = Math.round(index * FRAME_MS)
      const decision = director.update(
        inputAt(nowMs, { motion: onGround, desktop, random, config: HIGH_CONFIG })
      )
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
      const activity = director.getDebugSnapshot().activity
      activityFrames[activity] = (activityFrames[activity] ?? 0) + 1
    }
    // eslint-disable-next-line no-console
    console.log('[ground]', { moodFrames, activityFrames })
    // 地面 idle 基线/站立走动照旧存在（旧行为不回归）
    expect(moodFrames.idle ?? 0).toBeGreaterThan(0)
    expect(activityFrames.walkTo ?? 0).toBeGreaterThan(0)
    // 地面不会被强制 recumbent
    expect((moodFrames.idle ?? 0) + (moodFrames.walk ?? 0)).toBeGreaterThan(moodFrames.sit ?? 0)
  })
})
