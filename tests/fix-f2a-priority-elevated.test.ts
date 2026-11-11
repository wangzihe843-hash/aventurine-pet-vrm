/**
 * F2a 回归（M-13 / M-14）。
 *
 * - **M-13**：Dock 与地面同 top 时 `elevated` 不应为 true（否则 `dropDown` 变成原地跳）。
 *   修复：`isElevatedSurface` 要求表面 top 明显高于 workArea 底边（`ELEVATED_MIN_RISE_PX=8`），
 *   并仍只认 window-top/menubar/dock。menubar/window-top 保持 true。
 * - **M-14**：文件头/README 写的优先级是 `drag > pat/poke 即时反应 > fall`，实现却是 fall > pat。
 *   修复：把 reaction 分支移到 fallState 之前，与文档口径统一；fallState 仍继续跟踪、落地 finishFall
 *   照常生效（见用例 2/3）。
 *
 * 旧断言→新口径关系：本文件为新增用例。旧实现下「空中被摸头」mood 会是 fall（命中失败），
 * 这里显式锁定新口径；`tests/behavior-director.test.ts` 原有 fall/pat 用例均不涉及同帧冲突，无需改。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import { BehaviorDirector, createSeededRandom } from '../src/renderer/src/behavior'
import type {
  BehaviorConfigSubset,
  BehaviorDecision,
  DesktopSnapshot,
  DesktopSurface,
  InteractionEvent,
  InteractionSnapshot,
  MotionSnapshot
} from '../src/renderer/src/core/wave2-contract'

const WA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
const DT = 1 / 30
const CONFIG: BehaviorConfigSubset = {
  autonomous: true,
  autonomousLevel: 'high',
  mischief: true,
  dshLink: true
}
const EMPTY_INTERACTION: InteractionSnapshot = {
  pointer: null,
  hoveringPet: false,
  dragging: false,
  patProgress: 0
}

function desktopOf(surfaces: DesktopSurface[], transitions: DesktopSnapshot['transitions'] = []): DesktopSnapshot {
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

function surface(
  id: string,
  kind: DesktopSurface['kind'],
  top: number,
  options: Partial<DesktopSurface> = {}
): DesktopSurface {
  return {
    id,
    kind,
    rect: { x: WA.x, y: top, width: WA.width, height: 1 },
    top,
    sittable: true,
    climbable: false,
    ...options
  }
}

/**
 * 用固定随机数 0.9999 驱动一次 idle 基线抽取（pickWeightedActivity 取「最后一个权重>0 的活动」），
 * 从而确定性地观察某个活动是否在可抽集合里。
 */
function runUntilFirstDraw(options: {
  surface: DesktopSurface
  standSurfaceId: string
  feetY: number
  seconds?: number
}): { activityFrames: Record<string, number>; firstActivity: string | null; moods: Set<string> } {
  const director = new BehaviorDirector({ seed: 1 })
  const random = (): number => 0.9999
  const desktop = desktopOf([options.surface])
  const standing = motionAt({ x: WA.width / 2, y: options.feetY }, options.standSurfaceId)
  const result: { activityFrames: Record<string, number>; firstActivity: string | null; moods: Set<string> } = {
    activityFrames: {},
    firstActivity: null,
    moods: new Set<string>()
  }
  const frames = Math.round((options.seconds ?? 20) * 30)
  for (let index = 0; index < frames; index += 1) {
    const nowMs = Math.round(index * (1000 / 30))
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
    const activity = debug.activity
    result.activityFrames[activity] = (result.activityFrames[activity] ?? 0) + 1
    result.moods.add(decision.mood)
    if (result.firstActivity === null && activity !== 'idle') result.firstActivity = activity
  }
  return result
}

describe('M-13：Dock 与地面同 top 不算「高处」', () => {
  it('dock-bottom（top=workArea 底边）：elevated=false → 不会抽到 dropDown；可坐则抽到 sit', () => {
    const result = runUntilFirstDraw({
      surface: surface('dock-bottom', 'dock', WA.y + WA.height),
      standSurfaceId: 'dock-bottom',
      feetY: WA.y + WA.height
    })
    // dropDown 要求 elevated；同 top 时不应可抽（旧实现会抽到 dropDown → 原地跳）
    expect(result.activityFrames.dropDown ?? 0).toBe(0)
    // 该场景最后一个可抽活动是 sit（dock 可坐），说明抽取确实发生过
    expect(result.firstActivity).toBe('sit')
  })

  it('window-top（top=500，明显高于地面）仍是高处 → 可抽到 dropDown', () => {
    const result = runUntilFirstDraw({
      // 不可坐，避免 700ms 自动坐下抢先进入 sit
      surface: surface('win-1-top', 'window-top', 500, { sittable: false, windowId: 1 }),
      standSurfaceId: 'win-1-top',
      feetY: 500
    })
    expect(result.activityFrames.dropDown ?? 0).toBeGreaterThan(0)
    expect(result.moods.has('fall')).toBe(true)
  })

  it('menubar（top=0）仍算高处 → 可抽到 dropDown', () => {
    const result = runUntilFirstDraw({
      surface: surface('menubar', 'menubar', 0, { sittable: false }),
      standSurfaceId: 'menubar',
      feetY: 0
    })
    expect(result.activityFrames.dropDown ?? 0).toBeGreaterThan(0)
  })

  it('Dock 上沿（top=840 < 地面 900 - 8）仍是高处 → 可抽到 dropDown（真实跳下）', () => {
    const result = runUntilFirstDraw({
      surface: surface('dock', 'dock', 840, { sittable: false }),
      standSurfaceId: 'dock',
      feetY: 840
    })
    expect(result.activityFrames.dropDown ?? 0).toBeGreaterThan(0)
    expect(result.moods.has('fall')).toBe(true)
  })
})

describe('M-14：pat/poke 即时反应优先于 fall（与文档口径一致）', () => {
  const windowTop = surface('win-3-top', 'window-top', 500, { windowId: 3 })

  /** 构造「窗口关闭触发 fall」的 director。 */
  function createFallingDirector(): {
    director: BehaviorDirector
    random: () => number
    step: (
      nowMs: number,
      motion: MotionSnapshot,
      events?: InteractionEvent[],
      transitions?: DesktopSnapshot['transitions']
    ) => BehaviorDecision
  } {
    const random = createSeededRandom(31)
    const director = new BehaviorDirector({ random })
    const step = (
      nowMs: number,
      motion: MotionSnapshot,
      events: InteractionEvent[] = [],
      transitions: DesktopSnapshot['transitions'] = []
    ): BehaviorDecision =>
      director.update({
        nowMs,
        dt: DT,
        motion,
        desktop: desktopOf(transitions.length > 0 ? [] : [windowTop], transitions),
        interaction: EMPTY_INTERACTION,
        events,
        external: null,
        config: CONFIG,
        random
      })
    return { director, random, step }
  }

  it('空中被摸头：当帧 mood=pat（旧实现被 fall 吞掉，落地后才延迟播放）', () => {
    const { director, step } = createFallingDirector()
    // 站在窗沿（建立支撑跟踪）→ 窗口关闭 → fall
    step(0, motionAt({ x: 800, y: 500 }, 'win-3-top'))
    const falling = step(33, motionAt({ x: 800, y: 500 }, 'win-3-top'), [], [{ kind: 'closed', windowId: 3 }])
    expect(falling.mood).toBe('fall')
    // 下一帧：宠物已离地 + 收到摸头事件
    const airborne = motionAt({ x: 800, y: 300 }, null, false)
    const patted = step(66, airborne, [{ kind: 'pat' }])
    // M-14 新口径：pat/poke 即时反应优先于 fall
    expect(patted.mood).toBe('pat')
    expect(patted.motion.kind).toBe('hold')
    expect(director.getDebugSnapshot().activity).toBe('pat')
  })

  it('反应结束后 fallState 仍继续跟踪：同一段下坠回到 mood=fall（不丢物理状态）', () => {
    const { director, step } = createFallingDirector()
    step(0, motionAt({ x: 800, y: 500 }, 'win-3-top'))
    step(33, motionAt({ x: 800, y: 500 }, 'win-3-top'), [], [{ kind: 'closed', windowId: 3 }])
    const airborne = motionAt({ x: 800, y: 300 }, null, false)
    expect(step(66, airborne, [{ kind: 'pat' }]).mood).toBe('pat')
    // 反应时长 1.7–2.4s：下坠继续，反应结束后应回到 fall（fallState 未被 pat 清掉）
    let decision = step(500, airborne)
    expect(decision.mood).toBe('pat')
    let recoveredFall = false
    for (let nowMs = 1_000; nowMs <= 4_000; nowMs += 100) {
      decision = step(nowMs, airborne)
      if (decision.mood === 'fall') {
        recoveredFall = true
        break
      }
    }
    expect(recoveredFall).toBe(true)
    expect(director.getDebugSnapshot().activity).toBe('fall')
  })

  it('环境事件触发的 fall（窗口关闭）优先于同帧 pat：startFall 会清掉 reaction（口径补充记录）', () => {
    const { step } = createFallingDirector()
    step(0, motionAt({ x: 800, y: 500 }, 'win-3-top'))
    // 同帧「窗口关闭 + 摸头」：窗口事件让宠物被物理接管（drop 立即下发），此时 fall 优先；
    // M-14 调换的是 update() 里 reaction/fallState 的分支顺序（已在上面两个用例覆盖：
    // 已经在 fall 中收到 pat → pat 立即表演、fallState 继续跟踪），不包括「同帧环境事件强制进入 fall」。
    const decision = step(33, motionAt({ x: 800, y: 500 }, 'win-3-top'), [{ kind: 'pat' }], [
      { kind: 'closed', windowId: 3 }
    ])
    expect(decision.mood).toBe('fall')
    expect(decision.motion.kind).toBe('drop')
  })
})
