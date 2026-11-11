/**
 * F2a 回归（N-1 / N-2）：可坐窗口上沿的 recumbent（趴/坐/躺）不变量 + 自动坐下绑定当前表面。
 *
 * 背景演进（用户 2026-11-10 设计约束，见 `tests/tmp/inv-sitwindow/REPORT.md` §4.0/§4.6/§7.1）：
 * - 旧 **N-1**（`d787e35`）：`trySitOnWindowTop` 绕过 cooldown → 97.6% 帧全坐死循环；当时用
 *   `AUTO_SIT_GAP_MS`（20–40s）强制间隔修掉，但副作用是「坐完窗沿上站 20–40s」，且间隔内随机调度
 *   会在窗沿上抽到 walkTo/returnCorner/lookAround/idle 变体 → 用户看到「窗沿上站起来/走动」。
 * - **新口径（不可变量，本轮）**：`OnLedge`（grounded + 可坐 window-top）时 B1 只产出 recumbent
 *   （默认 sit 族）——**零站立/走动帧**、无 AUTO_SIT_GAP 空档；sit 段结束**当帧**续下一段 sit；
 *   唯一自主离开是受控 `dropDown`（连续 ≥2 段后每段 P=0.4，autonomous=false 不跳）。
 *   → 本文件 N-1 三条断言按新口径重写；「不 97.6% 死循环」由「sit↔下一段 sit 的连续轮换」保证，
 *   不再用「其它活动 >0 / sit 占比 <0.75」表达（与产品新约束冲突，属产品决策变更而非回归）。
 * - **N-2**（`1caffdb`）：自动坐下/落地优先坐下绑定**脚下这块**表面（不再随机选旁边窗沿）——保持通过。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import { BehaviorDirector, createSeededRandom } from '../src/renderer/src/behavior'
import type {
  BehaviorConfigSubset,
  BehaviorDecision,
  DesktopSnapshot,
  DesktopSurface,
  InteractionSnapshot,
  MotionSnapshot
} from '../src/renderer/src/core/wave2-contract'

const WA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
const DT = 1 / 30
const FRAME_MS = 1000 / 30
/** 与 activities.ts 的 sit.minDurationMs 对齐（新口径「无 GAP / 当帧续段」的判据基准）。 */
const SIT_MIN_DURATION_MS = 20_000
/** 与 behavior-director.ts 的 WINDOW_TOP_REST_EXIT_MIN_SEGMENTS=2 对齐。 */
const REST_EXIT_MIN_SEGMENTS = 2

const CONFIG: BehaviorConfigSubset = {
  autonomous: true,
  autonomousLevel: 'normal',
  mischief: true,
  dshLink: true
}
const EMPTY_INTERACTION: InteractionSnapshot = {
  pointer: null,
  hoveringPet: false,
  dragging: false,
  patProgress: 0
}

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

function windowTop(id: string, windowId: number, top: number, x: number, width: number): DesktopSurface {
  return {
    id,
    kind: 'window-top',
    rect: { x, y: top - 1, width, height: 1 },
    top,
    windowId,
    sittable: true,
    climbable: false
  }
}

function desktopOf(surfaces: DesktopSurface[]): DesktopSnapshot {
  return { surfaces, transitions: [], workArea: { ...WA }, screenBounds: { ...WA } }
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

/** 可坐窗沿上允许的 B1 mood：recumbent（sit/sleep 族）+ dropDown 期间的 fall 过渡。 */
const RECUMBENT_OR_EXIT_MOODS = new Set(['sit', 'sleep', 'fall'])
/** 可坐窗沿上禁止的自主活动 debugId（调度层兜底判据；idle 变体 debugId 也是 idle，无法与 dropDown
 *  结束帧的过渡 idle 区分，因此这里只列有独立 debugId 的站立/走动/看/睡/爬类活动）。 */
const FORBIDDEN_ACTIVITY_IDS = new Set([
  'walkTo',
  'returnCorner',
  'lookAround',
  'climb',
  'sleep',
  'followWindow'
])

interface LedgeSimResult {
  totalFrames: number
  /** 每种 B1 mood 的帧数。 */
  moodFrames: Record<string, number>
  /** 窗沿上出现站立/走动类 mood 的帧数（不变量下必须为 0）。 */
  standingFramesOnLedge: number
  /** B1 mood=walk 的帧数（walkTo/returnCorner/站姿 followWindow 都会落到 walk）。 */
  walkFrames: number
  /** 窗口上抽到的非 sit/dropDown 活动帧数（debugId 统计，walkTo/returnCorner/lookAround/idle 变体等）。 */
  forbiddenActivityFrames: number
  /** 首次进入 sit 的帧号（-1 = 从未）。 */
  firstSitFrame: number
  /** 受控 dropDown 的起始时刻（ms；按 mood 由非 fall → fall 判定一次起始）。 */
  dropStartMs: number[]
  /** 相邻两次 dropDown 起始的间隔（ms）。 */
  dropIntervals: number[]
}

/**
 * 站在可坐窗沿上的「静态」10min 仿真（B1 纯逻辑）：脚底固定在窗沿上（不接 B2，避免走动掉下
 * 窗沿干扰统计）。新口径下预期：全帧 recumbent + 受控 dropDown 的短暂 fall 过渡，零站立/走动。
 */
function runStandingOnWindowTopSim(seconds: number, seed: number): LedgeSimResult {
  const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
  const desktop = desktopOf(surfaces)
  const director = new BehaviorDirector({ random: createSeededRandom(seed) })
  const random = createSeededRandom(seed)
  const standing = motionAt({ x: 800, y: 600 }, 'win-A-top')
  const frameCount = Math.round(seconds * 30)
  const result: LedgeSimResult = {
    totalFrames: frameCount,
    moodFrames: {},
    standingFramesOnLedge: 0,
    walkFrames: 0,
    forbiddenActivityFrames: 0,
    firstSitFrame: -1,
    dropStartMs: [],
    dropIntervals: []
  }
  let previousMood: string | null = null
  for (let index = 0; index < frameCount; index += 1) {
    const nowMs = Math.round(index * FRAME_MS)
    const decision: BehaviorDecision = director.update({
      nowMs,
      dt: DT,
      motion: standing,
      desktop,
      interaction: EMPTY_INTERACTION,
      events: [],
      external: null,
      config: CONFIG,
      random
    })
    const debug = director.getDebugSnapshot()
    result.moodFrames[decision.mood] = (result.moodFrames[decision.mood] ?? 0) + 1
    if (!RECUMBENT_OR_EXIT_MOODS.has(decision.mood)) {
      result.standingFramesOnLedge += 1
    }
    if (decision.mood === 'walk') result.walkFrames += 1
    if (FORBIDDEN_ACTIVITY_IDS.has(debug.activity)) result.forbiddenActivityFrames += 1
    if (decision.mood === 'sit' && result.firstSitFrame < 0) result.firstSitFrame = index
    // dropDown 起始：mood 由非 fall → fall（dropDown 首帧；之后 fall/hold 直到活动结束）
    if (decision.mood === 'fall' && previousMood !== 'fall') {
      const previousDropStart = result.dropStartMs[result.dropStartMs.length - 1]
      if (previousDropStart !== undefined) result.dropIntervals.push(nowMs - previousDropStart)
      result.dropStartMs.push(nowMs)
    }
    previousMood = decision.mood
  }
  return result
}

describe('N-1（新口径）：可坐窗沿上只 recumbent，零站立/走动，无 AUTO_SIT_GAP 空档', () => {
  const runs = [2026, 7, 11].map((seed) => ({ seed, result: runStandingOnWindowTopSim(600, seed) }))

  it('站窗沿 10min × 3 seeds：站立帧=0、walk 帧=0、无 idle/walkTo 类活动、sit 占比高', () => {
    for (const { seed, result } of runs) {
      const sitRatio = (result.moodFrames.sit ?? 0) / result.totalFrames
      // eslint-disable-next-line no-console
      console.log(`[N-1-new] seed=${seed}`, {
        moodFrames: result.moodFrames,
        standingFramesOnLedge: result.standingFramesOnLedge,
        walkFrames: result.walkFrames,
        forbiddenActivityFrames: result.forbiddenActivityFrames,
        sitRatio: Number(sitRatio.toFixed(3)),
        firstSitFrame: result.firstSitFrame,
        drops: result.dropStartMs.length
      })
      // 放在/站在可坐窗沿上：首帧即 recumbent（不再等 700ms，也不再有 GAP 站立期）
      expect(result.firstSitFrame).toBe(0)
      // 不变量核心：零站立/走动帧（旧实现 42–50% 帧站立/走动）
      expect(result.standingFramesOnLedge).toBe(0)
      expect(result.walkFrames).toBe(0)
      // 调度层兜底：窗沿上不会出现 sit/dropDown 之外的自主活动（walkTo/returnCorner/lookAround/idle 变体）
      expect(result.forbiddenActivityFrames).toBe(0)
      // sit 占比允许→1.0（只被受控 dropDown 的短暂 fall 过渡占据）
      expect(sitRatio).toBeGreaterThanOrEqual(0.9)
      expect(sitRatio).toBeLessThanOrEqual(1)
      // mood 只可能是 recumbent 或 dropDown 的 fall 过渡
      for (const mood of Object.keys(result.moodFrames)) {
        expect(RECUMBENT_OR_EXIT_MOODS.has(mood)).toBe(true)
      }
    }
  })

  it('sit 段结束无 GAP：当帧续下一段 recumbent（旧口径「GAP≥20s 才再坐」已被产品约束推翻）', () => {
    for (const { result } of runs) {
      // 每段 sit 时长 ≥20s；受控 dropDown 只在 ≥2 段完成后（P=0.4）才可能出现
      expect(result.dropStartMs.length).toBeGreaterThan(0)
      expect(result.dropStartMs[0]!).toBeGreaterThanOrEqual(
        REST_EXIT_MIN_SEGMENTS * SIT_MIN_DURATION_MS - 2 * FRAME_MS
      )
      // 两次 dropDown 之间必然是「≥2 段完整 sit」→ 间隔 ≥ 2×20s（旧缺陷：立即可再坐/或长 GAP 站立）
      for (const interval of result.dropIntervals) {
        expect(interval).toBeGreaterThanOrEqual(
          REST_EXIT_MIN_SEGMENTS * SIT_MIN_DURATION_MS - 2 * FRAME_MS
        )
      }
    }
  })

  it('sit 结束当帧续段（定长种子仿真：120s 全 sit，0 站立/0 idle 帧）', () => {
    // 注入常量 0.5 随机：sit 时长恒 = randomInt(20000,35000,0.5) = 27500ms；dropDown 概率判定
    // readRandom=0.5 ≥ 0.4 → 不跳。于是段边界时刻完全确定：27500/55000/82500/110000ms。
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const director = new BehaviorDirector({ random: () => 0.5 })
    const random = (): number => 0.5
    const standing = motionAt({ x: 800, y: 600 }, 'win-A-top')
    const totalFrames = 120 * 30
    const boundaryFrames = [825, 1_650, 2_475, 3_300]
    const moodFrames: Record<string, number> = {}
    const boundaryMoods: string[] = []
    for (let index = 0; index < totalFrames; index += 1) {
      const nowMs = Math.round(index * FRAME_MS)
      const decision = director.update({
        nowMs,
        dt: DT,
        motion: standing,
        desktop,
        interaction: EMPTY_INTERACTION,
        events: [],
        external: null,
        config: CONFIG,
        random
      })
      moodFrames[decision.mood] = (moodFrames[decision.mood] ?? 0) + 1
      if (boundaryFrames.includes(index)) boundaryMoods.push(decision.mood)
    }
    // eslint-disable-next-line no-console
    console.log('[N-1-new-boundary]', { moodFrames, boundaryMoods })
    // 段边界帧（上一段 sit 到点的一帧）仍然是 sit → 当帧续下段，没有 idle 过渡帧
    expect(boundaryMoods).toEqual(['sit', 'sit', 'sit', 'sit'])
    expect(moodFrames.sit).toBe(totalFrames)
    expect(moodFrames.idle ?? 0).toBe(0)
    expect(moodFrames.walk ?? 0).toBe(0)
  })

  it('离开窗沿后回到窗沿：首帧即 recumbent（旧口径「≤10s 内」升级为 ≤1 帧）', () => {
    const surfaces = [groundSurface(), windowTop('win-A-top', 1, 600, 400, 800)]
    const desktop = desktopOf(surfaces)
    const director = new BehaviorDirector({ random: createSeededRandom(99) })
    const random = createSeededRandom(99)
    const standing = motionAt({ x: 800, y: 600 }, 'win-A-top')
    const onGround = motionAt({ x: 800, y: 900 }, 'screen-bottom')
    const step = (nowMs: number, motion: MotionSnapshot): BehaviorDecision =>
      director.update({
        nowMs,
        dt: DT,
        motion,
        desktop,
        interaction: EMPTY_INTERACTION,
        events: [],
        external: null,
        config: CONFIG,
        random
      })
    let nowMs = 0
    // 1) 站在窗沿：首帧即 sit
    let decision = step(nowMs, standing)
    expect(decision.mood).toBe('sit')
    // 2) 用户把它拖离窗沿放到地面（真实离开路径：拖拽会取消当前 sit 活动），再站 3s
    nowMs += 100
    decision = step(nowMs, standing)
    expect(decision.mood).toBe('sit')
    nowMs += 100
    decision = director.update({
      nowMs,
      dt: DT,
      motion: standing,
      desktop,
      interaction: { ...EMPTY_INTERACTION, dragging: true },
      events: [{ kind: 'dragStart' }],
      external: null,
      config: CONFIG,
      random
    })
    expect(decision.mood).toBe('drag')
    nowMs += 100
    decision = director.update({
      nowMs,
      dt: DT,
      motion: onGround,
      desktop,
      interaction: EMPTY_INTERACTION,
      events: [{ kind: 'dragEnd', throwVelocity: { x: 0, y: 0 } }],
      external: null,
      config: CONFIG,
      random
    })
    for (let index = 0; index < 30; index += 1) {
      nowMs += 100
      decision = step(nowMs, onGround)
    }
    expect(decision.mood).not.toBe('sit')
    // 3) 放回窗沿：**首帧**即进入 recumbent（无 GAP、无 700ms 延迟）
    const backOnLedgeAtMs = nowMs
    decision = step(backOnLedgeAtMs, standing)
    expect(decision.mood).toBe('sit')
    expect(decision.poseHint).toBe('sit:window')
  })
})

describe('N-2：自动/落地坐下绑定当前表面', () => {
  const twoLedges = [
    groundSurface(),
    windowTop('win-A-top', 1, 600, 400, 600),
    windowTop('win-B-top', 2, 500, 1000, 400)
  ]

  it('站在 A 窗沿自动坐下：目标必须是脚下的 A（旧实现会随机选中 B）', () => {
    const desktop = desktopOf(twoLedges)
    const random = createSeededRandom(5)
    const director = new BehaviorDirector({ random })
    const standingOnA = motionAt({ x: 700, y: 600 }, 'win-A-top')
    let decision: BehaviorDecision | null = null
    for (let nowMs = 0; nowMs <= 5_000; nowMs += 100) {
      decision = director.update({
        nowMs,
        dt: DT,
        motion: standingOnA,
        desktop,
        interaction: EMPTY_INTERACTION,
        events: [],
        external: null,
        config: CONFIG,
        random
      })
      if (decision.mood === 'sit') break
    }
    expect(decision?.mood).toBe('sit')
    // 绑定 A 且已站上 A → updateSitActivity 判定 seated，直接发 hold（不需要再向 B 移动）
    expect(decision?.motion.kind).toBe('hold')
    expect(decision?.motion.kind === 'sit' ? decision.motion.surfaceId : null).not.toBe('win-B-top')
  })

  it('从空中落到 B 窗沿：恢复时优先坐下必须绑定落地表面 B（旧实现随机选表面）', () => {
    const desktop = desktopOf(twoLedges)
    const random = createSeededRandom(5)
    const director = new BehaviorDirector({ random })
    const falling = motionAt({ x: 1_150, y: 200 }, null, false)
    const landedOnB = motionAt({ x: 1_150, y: 500 }, 'win-B-top')
    const step = (nowMs: number, motion: MotionSnapshot): BehaviorDecision =>
      director.update({
        nowMs,
        dt: DT,
        motion,
        desktop,
        interaction: EMPTY_INTERACTION,
        events: [],
        external: null,
        config: CONFIG,
        random
      })
    step(0, falling) // 空中 → fallState
    step(100, landedOnB) // 落地 → finishFall 记录 preferredSurfaceId='win-B-top'
    // 新口径不变量：落地帧之后**首帧**即 recumbent，且绑定落地表面 B（已站上 B → seated → hold）
    const decision = step(200, landedOnB)
    expect(decision.mood).toBe('sit')
    expect(decision.motion.kind).toBe('hold')
    expect(decision.poseHint).toBe('sit:window')
  })
})
