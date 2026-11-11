/**
 * 单测：B4 拖拽 / 戳状态机（`src/renderer/src/interaction/drag-machine.ts`）。
 *
 * 覆盖：click vs drag 阈值（2–4px 默认 3px）、拖动后持续跟随（不关心宠物矩形）、
 * 甩出速度估计（合成轨迹 / 只取最近窗口 / clamp 上限 / 退化输入）、
 * poke 时间窗（<250ms 且小位移）、乱序调用安全、cancel 复位。
 */
import { describe, expect, it } from 'vitest'

import {
  DRAG_THRESHOLD_PX,
  DragMachine,
  estimateThrowVelocity,
  MAX_THROW_SPEED_PX_PER_SEC,
  POKE_MAX_DURATION_MS,
  THROW_VELOCITY_WINDOW_MS,
  type DragSample
} from '../src/renderer/src/interaction/drag-machine'

describe('DragMachine：click vs drag 阈值', () => {
  it(`位移 < ${DRAG_THRESHOLD_PX}px 不算拖动，达到阈值才算（started 只报一次）`, () => {
    const machine = new DragMachine()
    machine.begin({ x: 10, y: 10 }, 0)
    expect(machine.pressed).toBe(true)
    expect(machine.dragging).toBe(false)

    const below = machine.move({ x: 12, y: 10 }, 10)
    expect(below).toEqual({ started: false, dragging: false })
    expect(machine.dragging).toBe(false)

    const crossed = machine.move({ x: 13, y: 10 }, 20)
    expect(crossed).toEqual({ started: true, dragging: true })
    expect(machine.dragging).toBe(true)

    const after = machine.move({ x: 40, y: 30 }, 30)
    expect(after).toEqual({ started: false, dragging: true })
  })

  it('拖动一旦开始，指针远离宠物/任意位置都持续拖动（本模块不关心矩形）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    machine.move({ x: 5, y: 0 }, 10)
    expect(machine.dragging).toBe(true)
    machine.move({ x: 5000, y: -3000 }, 20)
    expect(machine.dragging).toBe(true)
    expect(machine.move({ x: 5001, y: -3000 }, 30).dragging).toBe(true)
  })

  it('阈值可覆盖（2px 时 2px 位移即拖动）', () => {
    const machine = new DragMachine({ dragThresholdPx: 2 })
    machine.begin({ x: 0, y: 0 }, 0)
    expect(machine.move({ x: 2, y: 0 }, 10).started).toBe(true)
  })

  it('重复 begin 忽略（不会重置起点）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    machine.begin({ x: 100, y: 100 }, 10)
    // 相对第一个起点 (0,0) 只走了 2px → 不进入拖动
    expect(machine.move({ x: 2, y: 0 }, 20).started).toBe(false)
  })

  it('没有按下状态时 move/end 安全：move 返回非拖动、end 返回 none', () => {
    const machine = new DragMachine()
    expect(machine.move({ x: 1, y: 1 }, 10)).toEqual({ started: false, dragging: false })
    expect(machine.end({ x: 1, y: 1 }, 10)).toEqual({ kind: 'none' })
  })
})

describe('DragMachine：poke（短按）判定', () => {
  it('短按 + 零位移 → tap 且 isPoke=true', () => {
    const machine = new DragMachine()
    machine.begin({ x: 100, y: 200 }, 0)
    const result = machine.end({ x: 100, y: 200 }, 120)
    expect(result).toMatchObject({
      kind: 'tap',
      durationMs: 120,
      displacementPx: 0,
      isPoke: true
    })
  })

  it('短按 + 2px 抖动 → isPoke=true（位移小于拖动阈值）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 100, y: 200 }, 0)
    machine.move({ x: 102, y: 200 }, 50)
    const result = machine.end({ x: 102, y: 200 }, POKE_MAX_DURATION_MS)
    expect(result.kind).toBe('tap')
    if (result.kind === 'tap') {
      expect(result.displacementPx).toBeCloseTo(2, 6)
      expect(result.isPoke).toBe(true)
    }
  })

  it(`长按（>${POKE_MAX_DURATION_MS}ms）不产生 poke`, () => {
    const machine = new DragMachine()
    machine.begin({ x: 100, y: 200 }, 0)
    const result = machine.end({ x: 100, y: 200 }, POKE_MAX_DURATION_MS + 1)
    expect(result.kind).toBe('tap')
    if (result.kind === 'tap') {
      expect(result.isPoke).toBe(false)
      expect(result.durationMs).toBe(POKE_MAX_DURATION_MS + 1)
    }
  })

  it('拖动过的松手返回 dragEnd（不是 tap/poke）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    machine.move({ x: 50, y: 0 }, 10)
    const result = machine.end({ x: 50, y: 0 }, 20)
    expect(result.kind).toBe('dragEnd')
  })
})

describe('DragMachine：甩出速度估计（合成轨迹）', () => {
  it('最近 120ms 内匀速移动 → 速度 = 位移/时间（px/s）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    machine.move({ x: 100, y: 0 }, 50)
    machine.move({ x: 200, y: 0 }, 100)
    const result = machine.end({ x: 240, y: 0 }, 120)
    expect(result.kind).toBe('dragEnd')
    if (result.kind === 'dragEnd') {
      // 窗口内最早采样 (0,0)@0 → (240,0)@120 → 2000 px/s
      expect(result.throwVelocity.x).toBeCloseTo(2000, 3)
      expect(result.throwVelocity.y).toBeCloseTo(0, 6)
      expect(result.pointer).toEqual({ x: 240, y: 0 })
    }
  })

  it('只取最近窗口（旧的慢速采样不参与）：400ms 前 → 最近 20ms 快速段', () => {
    const samples: DragSample[] = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 0, t: 400 },
      { x: 50, y: 0, t: 800 },
      { x: 80, y: 0, t: 820 }
    ]
    const velocity = estimateThrowVelocity(samples, 820, THROW_VELOCITY_WINDOW_MS)
    expect(velocity.x).toBeCloseTo(1500, 3)
    expect(velocity.y).toBeCloseTo(0, 6)
  })

  it('速度按上限 clamp（保持方向）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    machine.move({ x: 1000, y: 0 }, 10)
    const result = machine.end({ x: 2000, y: 0 }, 20)
    expect(result.kind).toBe('dragEnd')
    if (result.kind === 'dragEnd') {
      expect(result.throwVelocity.x).toBeCloseTo(MAX_THROW_SPEED_PX_PER_SEC, 3)
      expect(result.throwVelocity.y).toBeCloseTo(0, 6)
    }
  })

  it('退化输入：采样不足 / 时间差太小 / 非法值 → 0 速度不抛', () => {
    expect(estimateThrowVelocity([], 0)).toEqual({ x: 0, y: 0 })
    expect(estimateThrowVelocity([{ x: 1, y: 1, t: 0 }], 10)).toEqual({ x: 0, y: 0 })
    // 两个采样时间相同 → 找不到有效时间差 → 0
    expect(
      estimateThrowVelocity(
        [
          { x: 0, y: 0, t: 0 },
          { x: 5, y: 0, t: 0 }
        ],
        0
      )
    ).toEqual({ x: 0, y: 0 })
    // 非法窗口参数回退默认值（不抛、结果有限）
    const velocity = estimateThrowVelocity(
      [
        { x: 0, y: 0, t: 0 },
        { x: 10, y: 0, t: 100 }
      ],
      100,
      Number.NaN,
      Number.NaN
    )
    expect(Number.isFinite(velocity.x)).toBe(true)
    expect(velocity.x).toBeGreaterThan(0)
  })
})

describe('DragMachine：复位 / 取消', () => {
  it('cancel 后 pressed/dragging 均 false，end 返回 none', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    machine.move({ x: 10, y: 0 }, 10)
    machine.cancel()
    expect(machine.pressed).toBe(false)
    expect(machine.dragging).toBe(false)
    expect(machine.end({ x: 10, y: 0 }, 20)).toEqual({ kind: 'none' })
  })

  it('松手后状态清空（可立即开始下一次点击）', () => {
    const machine = new DragMachine()
    machine.begin({ x: 0, y: 0 }, 0)
    expect(machine.end({ x: 0, y: 0 }, 50).kind).toBe('tap')
    expect(machine.pressed).toBe(false)
    machine.begin({ x: 0, y: 0 }, 100)
    expect(machine.pressed).toBe(true)
  })

  it('非法输入（NaN 点/时间）不改变状态、不抛', () => {
    const machine = new DragMachine()
    machine.begin({ x: Number.NaN, y: 0 }, 0)
    expect(machine.pressed).toBe(false)
    machine.begin({ x: 0, y: 0 }, 0)
    machine.move({ x: Number.NaN, y: 0 }, 10)
    expect(machine.dragging).toBe(false)
    machine.end({ x: 0, y: 0 }, Number.NaN)
    expect(machine.pressed).toBe(false)
  })
})
