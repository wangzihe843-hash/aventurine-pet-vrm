/**
 * M-11 回归：B4 LookTracker 平滑注视目标接入 B1。
 *
 * 背景（上一轮审查 M-11）：`LookTracker`（死区 + τ≈100ms 平滑 + 离窗/2.5s 回落）
 * 的输出 `onLookTarget` 在 main.ts 是空实现，属死代码；B1 注视直接用原始 pointer。
 *
 * 修复约定：
 * - `InteractionSnapshot.lookTarget` 可选：**缺省 = 回退 pointer**（旧输入/单测兼容）；
 * - 显式 `null` = LookTracker 判定不跟随（离窗 / 2.5s 无移动）；
 * - B1 仅把它用于 gaze（`decision.lookTarget`），`facing`/pointerNear/mouseAway 仍用原始 pointer。
 */
import { describe, expect, it } from 'vitest'

import type { Rect } from '../src/shared/types'
import { BehaviorDirector } from '../src/renderer/src/behavior'
import type {
  BehaviorConfigSubset,
  BehaviorInput,
  DesktopSnapshot,
  InteractionSnapshot,
  MotionSnapshot,
  Point2D
} from '../src/renderer/src/core/wave2-contract'

const WORK_AREA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
const GROUND_Y = WORK_AREA.y + WORK_AREA.height

const CONFIG: BehaviorConfigSubset = {
  // 关闭自主活动 → 决策稳定落在 idle（避免随机活动干扰注视断言）
  autonomous: false,
  autonomousLevel: 'normal',
  mischief: true,
  dshLink: true
}

function motion(): MotionSnapshot {
  return {
    feet: { x: 800, y: GROUND_Y },
    velocity: { x: 0, y: 0 },
    facing: 'front',
    grounded: true,
    surfaceId: null,
    airborne: false
  }
}

function desktop(): DesktopSnapshot {
  return {
    surfaces: [],
    transitions: [],
    workArea: WORK_AREA,
    screenBounds: WORK_AREA
  }
}

function input(interaction: InteractionSnapshot): BehaviorInput {
  return {
    nowMs: 0,
    dt: 1 / 30,
    motion: motion(),
    desktop: desktop(),
    interaction,
    events: [],
    external: null,
    config: CONFIG,
    random: () => 0.5
  }
}

/** 指针在宠物右侧 → 朝向应为 right（用于断言 facing 仍来自原始 pointer）。 */
const POINTER: Point2D = { x: 1400, y: 300 }

describe('M-11：LookTracker 平滑注视目标接入 B1', () => {
  it('显式 lookTarget 优先用于 gaze，facing 仍由原始 pointer 决定', () => {
    const director = new BehaviorDirector({ seed: 1 })
    const decision = director.update(
      input({
        pointer: POINTER,
        hoveringPet: false,
        dragging: false,
        patProgress: 0,
        lookTarget: { x: 120, y: 150 }
      })
    )
    expect(decision.mood).toBe('idle')
    expect(decision.lookTarget).toEqual({ x: 120, y: 150 })
    // pointer 在右侧远处，若误用 lookTarget 作为朝向会得到 left
    expect(decision.facing).toBe('right')
  })

  it('lookTarget 缺省（旧输入/旧单测）→ 回退原始 pointer', () => {
    const director = new BehaviorDirector({ seed: 1 })
    const decision = director.update(
      input({
        pointer: POINTER,
        hoveringPet: false,
        dragging: false,
        patProgress: 0
      })
    )
    expect(decision.lookTarget).toEqual(POINTER)
  })

  it('显式 lookTarget=null（LookTracker 回落）→ 不跟随注视', () => {
    const director = new BehaviorDirector({ seed: 1 })
    const decision = director.update(
      input({
        pointer: POINTER,
        hoveringPet: false,
        dragging: false,
        patProgress: 0,
        lookTarget: null
      })
    )
    expect(decision.lookTarget).toBeNull()
    expect(decision.facing).toBe('right')
  })

  it('平滑目标越界时仍被 workArea 钳制（保持既有输出契约）', () => {
    const director = new BehaviorDirector({ seed: 1 })
    const decision = director.update(
      input({
        pointer: POINTER,
        hoveringPet: false,
        dragging: false,
        patProgress: 0,
        lookTarget: { x: -500, y: 5000 }
      })
    )
    expect(decision.lookTarget).toEqual({ x: WORK_AREA.x, y: WORK_AREA.y + WORK_AREA.height })
  })
})
