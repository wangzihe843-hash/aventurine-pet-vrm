/**
 * F2a 回归（H-3b）：B1 运动目标必须落在 B2 半宽可达区间内。
 *
 * 背景：`cornerPoint` 取 `workArea.right - margin`、`walkTo/returnCorner` 的随机目标只按 workArea
 * 钳制——这些目标会落进 B2 的「左右各让出宠物半宽」不可达带（1600 宽 workArea + 398 宽宠物时
 * 可达 xRange = [199.07, 1400.93]）。B2 走到墙边被 clamp、B1 的 16px 到达判定永远不满足 →
 * 宠物原地走 + 活动卡住（旧复现 R7：cornerNeverArrived=4/4、totalStuckFrames=1081/1081）。
 *
 * 修复：`BehaviorInput.motionLimits`（F2b 由 PetRuntime 依 workArea+petSize 计算）经 buildFrame
 * sanitize 后，所有下发给 B2 的 moveTo 目标统一经 `clampMotionTarget` 钳制；缺省/非法时回退旧口径。
 *
 * 旧断言→新口径关系：本文件全部为新增用例，不修改旧测试；旧行为（无 motionLimits）由
 * 「非法 motionLimits 回退旧口径」用例显式锁定，保证旧调用方兼容。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import { BehaviorDirector, createSeededRandom } from '../src/renderer/src/behavior'
import { PetPhysics } from '../src/renderer/src/physics'
import type {
  BehaviorConfigSubset,
  BehaviorInput,
  BehaviorDecision,
  DesktopSnapshot,
  DesktopSurface,
  InteractionSnapshot,
  MotionSnapshot,
  Point2D
} from '../src/renderer/src/core/wave2-contract'

const WA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
/** 与 PetRuntime 一致的派生口径：540 高、宽高比 0.7373（≈398.1px 宽）。 */
const PET_SIZE = { width: 540 * 0.7373, height: 540 }
const HALF_WIDTH = PET_SIZE.width / 2
/** PetRuntime 注入的可达区间：左右各让出宠物半宽。 */
const MOTION_LIMITS = { minX: WA.x + HALF_WIDTH, maxX: WA.x + WA.width - HALF_WIDTH }
const DT = 1 / 30
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
const ARRIVE_EPSILON_PX = 16

/** `motionLimits` 是 F2b 新增的契约字段；测试侧用交集类型，避免与并行块的提交顺序耦合。 */
type InputWithLimits = BehaviorInput & { motionLimits?: { minX: number; maxX: number } }

function groundSurface(workArea: Rect = WA): DesktopSurface {
  return {
    id: 'screen-bottom',
    kind: 'screen-bottom',
    rect: { x: workArea.x, y: workArea.y + workArea.height, width: workArea.width, height: 1 },
    top: workArea.y + workArea.height,
    sittable: true,
    climbable: false
  }
}

function desktopOf(surfaces: DesktopSurface[], workArea: Rect = WA): DesktopSnapshot {
  return { surfaces, transitions: [], workArea: { ...workArea }, screenBounds: { ...workArea } }
}

function motionAt(feet: Point2D, surfaceId: string | null, grounded = true): MotionSnapshot {
  return {
    feet: { ...feet },
    velocity: { x: 0, y: 0 },
    facing: 'front',
    grounded,
    surfaceId,
    airborne: !grounded
  }
}

interface WalkEpisode {
  frames: number
  targetX: number
  minRemainingPx: number
  stuckFrames: number
  /** episode 结束时（B1 已判定到达/活动结束）的脚底 x。 */
  finalFeetX: number
  arrived: boolean
}

interface SimResult {
  episodes: WalkEpisode[]
  unreachableTargets: Array<{ targetX: number; t: number }>
  totalWalkFrames: number
  totalStuckFrames: number
}

/**
 * 10 分钟 ground-only 仿真（B1 每帧决策 → B2 step），按走路 episode 统计目标可达性/卡住帧。
 * stuck 口径：走路帧中「距目标 > 20px 且本帧 feet.x 完全没动」（即被墙 clamp 住却还在 moveTo）。
 */
function runGroundSim(options: {
  seconds: number
  seed: number
  motionLimits?: { minX: number; maxX: number } | null
}): SimResult {
  const random = createSeededRandom(options.seed)
  const director = new BehaviorDirector({ random })
  const physics = new PetPhysics({
    workArea: WA,
    petSize: PET_SIZE,
    initialFeet: { x: WA.width / 2, y: WA.y + WA.height },
    surfaces: [groundSurface()]
  })
  const desktop = desktopOf([groundSurface()])
  const result: SimResult = { episodes: [], unreachableTargets: [], totalWalkFrames: 0, totalStuckFrames: 0 }
  let current: WalkEpisode | null = null
  let lastFeetX = physics.getSnapshot().feet.x
  const frameCount = Math.round(options.seconds * 30)
  for (let index = 0; index < frameCount; index += 1) {
    const nowMs = Math.round(index * (1000 / 30))
    const before = physics.getSnapshot()
    const input: InputWithLimits = {
      nowMs,
      dt: DT,
      motion: before,
      desktop,
      interaction: EMPTY_INTERACTION,
      events: [],
      external: null,
      config: CONFIG,
      random
    }
    if (options.motionLimits) input.motionLimits = { ...options.motionLimits }
    const decision: BehaviorDecision = director.update(input)
    const walking = decision.mood === 'walk' && decision.motion.kind === 'moveTo'
    let stuckProbe: { episode: WalkEpisode; remaining: number; beforeX: number } | null = null
    if (walking) {
      result.totalWalkFrames += 1
      const target = decision.motion.target
      if (!current) {
        current = {
          frames: 0,
          targetX: target.x,
          minRemainingPx: Infinity,
          stuckFrames: 0,
          finalFeetX: before.feet.x,
          arrived: false
        }
      }
      current.frames += 1
      current.targetX = target.x
      const remaining = Math.abs(target.x - before.feet.x)
      current.minRemainingPx = Math.min(current.minRemainingPx, remaining)
      if (remaining <= ARRIVE_EPSILON_PX) current.arrived = true
      if (remaining > ARRIVE_EPSILON_PX + 4) {
        stuckProbe = { episode: current, remaining, beforeX: before.feet.x }
      }
      if (
        options.motionLimits &&
        (target.x < options.motionLimits.minX - 0.5 || target.x > options.motionLimits.maxX + 0.5)
      ) {
        result.unreachableTargets.push({ targetX: target.x, t: nowMs })
      }
    } else if (current) {
      // 到达判定容差 16px + 单帧步长（≤3.7px @high）：episode 结束帧脚底距目标 ≤16px 即视为到达
      current.finalFeetX = before.feet.x
      current.arrived = Math.abs(current.targetX - current.finalFeetX) <= ARRIVE_EPSILON_PX
      result.episodes.push(current)
      current = null
    }
    physics.setEnvironment({ workArea: WA, petSize: PET_SIZE, surfaces: desktop.surfaces })
    physics.setCommand(decision.motion)
    const after = physics.step(DT, nowMs)
    // 正确的「原地走」口径：本帧 step 前后脚底 x 完全没动，且离目标仍 > 20px
    if (stuckProbe && Math.abs(after.feet.x - stuckProbe.beforeX) < 1e-6) {
      stuckProbe.episode.stuckFrames += 1
    }
    lastFeetX = after.feet.x
  }
  if (current) {
    current.finalFeetX = lastFeetX
    current.arrived = Math.abs(current.targetX - current.finalFeetX) <= ARRIVE_EPSILON_PX
    result.episodes.push(current)
  }
  result.totalStuckFrames = result.episodes.reduce((sum, episode) => sum + episode.stuckFrames, 0)
  return result
}

describe('H-3b：motionLimits 使 B1 运动目标可达', () => {
  it('1600 宽 workArea + 398 宽宠物：10min ground-only 仿真 cornerNeverArrived=0、stuck≈0', () => {
    const result = runGroundSim({ seconds: 600, seed: 2026, motionLimits: MOTION_LIMITS })
    // 「角落型」目标：被钳到右墙可达上限的 episode（旧实现为 1582 的不可达目标）
    const cornerLike = result.episodes.filter((episode) => episode.targetX >= MOTION_LIMITS.maxX - 0.5)
    const cornerNeverArrived = cornerLike.filter((episode) => !episode.arrived)
    // 旧缺陷对照（旧复现 R7，seed 2026 同配置）：episodes=8、cornerNeverArrived=4/4、
    // totalWalkFrames=1081、totalStuckFrames=1081（100% 卡住）→ 修复后 stuck 必须≈0。
    // eslint-disable-next-line no-console
    console.log('[H-3b]', {
      episodes: result.episodes.length,
      cornerLike: cornerLike.length,
      cornerNeverArrived: cornerNeverArrived.length,
      totalWalkFrames: result.totalWalkFrames,
      totalStuckFrames: result.totalStuckFrames,
      unreachableTargets: result.unreachableTargets.slice(0, 5)
    })
    expect(result.unreachableTargets).toEqual([])
    expect(cornerLike.length).toBeGreaterThan(0)
    expect(cornerLike.every((episode) => episode.arrived)).toBe(true)
    expect(cornerNeverArrived).toHaveLength(0)
    expect(result.totalStuckFrames).toBeLessThanOrEqual(2)
  })

  it('合法 motionLimits：walkTo / returnCorner / followWindow 的 moveTo 目标都钳进可达区间', () => {
    const random = createSeededRandom(7)
    const director = new BehaviorDirector({ random })
    const surface = {
      id: 'win-1-top',
      kind: 'window-top' as const,
      // 窗口右半边在可达带之外：中心 x=1500 > 可达上限 1400.93
      rect: { x: 1300, y: 600, width: 400, height: 1 },
      top: 600,
      windowId: 1,
      // 2026-11-10 窗沿卧姿不变量：可坐窗沿上禁止站立/走动类活动（window-top 锁 recumbent），
      // 本用例只验证 motionLimits 目标钳制，因此用**不可坐**窗沿保留 walkTo/returnCorner 覆盖。
      sittable: false,
      climbable: false
    }
    const desktop = desktopOf([groundSurface(), surface])
    const baseInput = (nowMs: number): InputWithLimits => ({
      nowMs,
      dt: DT,
      motion: motionAt({ x: 1350, y: 600 }, 'win-1-top'),
      desktop,
      interaction: EMPTY_INTERACTION,
      events: [],
      external: null,
      config: CONFIG,
      random,
      motionLimits: { ...MOTION_LIMITS }
    })
    // returnCorner：旧实现目标是 workArea.right-32=1568（不可达），修复后钳到 maxX
    director.update(baseInput(0))
    expect(director.triggerActivity('returnCorner', 100)).toBe(true)
    const corner = director.update(baseInput(150))
    expect(corner.motion.kind).toBe('moveTo')
    if (corner.motion.kind === 'moveTo') {
      expect(corner.motion.target.x).toBeCloseTo(MOTION_LIMITS.maxX, 5)
      expect(corner.motion.target.y).toBeCloseTo(WA.y + WA.height, 5)
    }
    // walkTo：在当前窗沿上随机走，目标同样必须落在可达区间
    director.triggerActivity('walkTo', 200)
    const walk = director.update(baseInput(250))
    if (walk.motion.kind === 'moveTo') {
      expect(walk.motion.target.x).toBeGreaterThanOrEqual(MOTION_LIMITS.minX - 1e-6)
      expect(walk.motion.target.x).toBeLessThanOrEqual(MOTION_LIMITS.maxX + 1e-6)
    }
    // followWindow：窗口右移后目标=新表面中心 1500 → 钳到可达上限
    const follow = director.update({
      ...baseInput(300),
      desktop: {
        ...desktop,
        transitions: [{ kind: 'moved', windowId: 1, delta: { x: 100, y: 0 } }]
      }
    })
    expect(follow.motion.kind).toBe('moveTo')
    if (follow.motion.kind === 'moveTo') {
      expect(follow.motion.target.x).toBeLessThanOrEqual(MOTION_LIMITS.maxX + 1e-6)
      expect(follow.motion.mode).toBe('walk')
    }
  })

  it('站在窗沿上抽 returnCorner：水平到位后按原时长收尾（不会被续期僵到 45s 安全上限）', () => {
    const random = createSeededRandom(3)
    const director = new BehaviorDirector({ random })
    const ledge: DesktopSurface = {
      id: 'win-2-top',
      kind: 'window-top',
      rect: { x: 200, y: 499, width: 1200, height: 1 },
      top: 500,
      windowId: 2,
      sittable: false,
      climbable: false
    }
    const surfaces = [groundSurface(), ledge]
    const physics = new PetPhysics({
      workArea: WA,
      petSize: PET_SIZE,
      initialFeet: { x: 1000, y: 500 },
      surfaces
    })
    const desktop = desktopOf(surfaces)
    const input = (nowMs: number): InputWithLimits => ({
      nowMs,
      dt: DT,
      motion: physics.getSnapshot(),
      desktop,
      interaction: EMPTY_INTERACTION,
      events: [],
      external: null,
      config: CONFIG,
      random,
      motionLimits: { ...MOTION_LIMITS }
    })
    director.update(input(0))
    expect(director.triggerActivity('returnCorner', 100)).toBe(true)
    let endedAtMs: number | null = null
    let walkFrames = 0
    for (let index = 0; index < 30 * 15; index += 1) {
      const nowMs = Math.round(index * 1000 / 30) + 100
      const decision = director.update(input(nowMs))
      const activity = director.getDebugSnapshot().activity
      if (activity === 'walkTo') {
        walkFrames += 1
      } else if (endedAtMs === null && index > 5) {
        endedAtMs = nowMs
      }
      physics.setEnvironment({ workArea: WA, petSize: PET_SIZE, surfaces })
      physics.setCommand(decision.motion)
      physics.step(DT, nowMs)
    }
    const finalFeetX = physics.getSnapshot().feet.x
    // eslint-disable-next-line no-console
    console.log('[H-3b-ledge]', { walkFrames, endedAtMs, finalFeetX })
    // 水平上确实走到了可达上限附近（不是原地走墙）
    expect(finalFeetX).toBeGreaterThan(MOTION_LIMITS.maxX - 3)
    // 活动按原时长收尾（≈走到 + 2.5s 续期尾巴），不会僵到 45s 上限
    expect(endedAtMs).not.toBeNull()
    expect(endedAtMs!).toBeLessThanOrEqual(12_000)
  })

  it('motionLimits 非法（NaN / minX>maxX / 超出 workArea）→ 回退旧口径（不钳到宠物半宽）', () => {
    const invalidVariants: unknown[] = [
      { minX: Number.NaN, maxX: 1400 },
      { minX: 1500, maxX: 200 },
      { minX: -50, maxX: 1400 },
      { minX: 199, maxX: WA.width + 100 },
      'not-an-object',
      null
    ]
    for (const motionLimits of invalidVariants) {
      const random = createSeededRandom(11)
      const director = new BehaviorDirector({ random })
      const input: InputWithLimits = {
        nowMs: 0,
        dt: DT,
        motion: motionAt({ x: 800, y: 900 }, 'screen-bottom'),
        desktop: desktopOf([groundSurface()]),
        interaction: EMPTY_INTERACTION,
        events: [],
        external: null,
        config: CONFIG,
        random,
        motionLimits: motionLimits as { minX: number; maxX: number }
      }
      director.update(input)
      expect(director.triggerActivity('returnCorner', 100)).toBe(true)
      const decision = director.update({ ...input, nowMs: 150 })
      // 旧口径：cornerPoint = workArea.right - margin（margin = min(1600,900)*0.02 = 18 → 1582），
      // 不因 motionLimits 非法而崩溃/误用
      expect(decision.motion.kind).toBe('moveTo')
      if (decision.motion.kind === 'moveTo') {
        expect(decision.motion.target.x).toBeCloseTo(WA.x + WA.width - 18, 5)
      }
    }
  })
})
