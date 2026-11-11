/**
 * 单测：B2 运动与物理 `PetPhysics`（`src/renderer/src/physics/**`）。
 *
 * 覆盖验收条款：固定 dt 积分确定性（自由落体离散解）、落地停止、边界不穿透、
 * moveTo 到达后停住、sit 后 grounded、拖拽平滑/端到端甩出速度（合成轨迹）、
 * 甩出抛物线 + 撞墙小反弹、窗口上沿落地、窗口移除后掉落、朝向、退化输入不 NaN、样本上限。
 *
 * 坐标口径：overlay 窗口本地 CSS px（左上原点、y 向下）；1080p 主屏 workArea=961 高。
 * 纯逻辑，无 Electron/DOM/three 依赖。
 */
import { describe, expect, it } from 'vitest'

import type {
  DesktopSurface,
  MotionCommand,
  MotionSnapshot,
  PetSize
} from '../src/renderer/src/core/wave2-contract'
import type { Rect } from '../src/shared/types'
import {
  DRAG_SMOOTHING_TAU_MS,
  DRAG_START_FACING,
  IMPLICIT_GROUND_SURFACE_ID,
  MOVE_ARRIVE_EPS_PX,
  PetPhysics,
  THROW_MAX_SAMPLES,
  THROW_MAX_SPEED_PX_PER_SEC,
  type PhysicsOptions
} from '../src/renderer/src/physics/index'

/** 1080p 主屏 workArea（窗口本地坐标；Wave 1 实际 1920×961）。 */
const WORK_AREA: Rect = { x: 0, y: 0, width: 1920, height: 961 }
/** 50% 尺寸的宠物（540 高 × 0.7373 宽高比 ≈ 398，取整 400）。 */
const PET_SIZE: PetSize = { width: 400, height: 540 }
const GROUND_TOP = WORK_AREA.y + WORK_AREA.height
const HALF_WIDTH = PET_SIZE.width / 2
const MIN_X = WORK_AREA.x + HALF_WIDTH
const MAX_X = WORK_AREA.x + WORK_AREA.width - HALF_WIDTH
const FIXED_DT = 1 / 60
const GRAVITY = 2400

/** 窗口上沿表面（默认 rect x=800..1400、top=700；宠物半宽 200 → 可站 x∈[600,1600]）。 */
function windowTopSurface(overrides: Partial<DesktopSurface> = {}): DesktopSurface {
  return {
    id: 'win-7-top',
    kind: 'window-top',
    rect: { x: 800, y: 700, width: 600, height: 1 },
    top: 700,
    windowId: 7,
    sittable: true,
    climbable: true,
    ...overrides
  }
}

function createPhysics(options: Partial<PhysicsOptions> = {}): PetPhysics {
  return new PetPhysics({
    workArea: WORK_AREA,
    petSize: PET_SIZE,
    gravityPxPerSec2: GRAVITY,
    initialFeet: { x: 960, y: GROUND_TOP },
    ...options
  })
}

interface Simulation {
  physics: PetPhysics
  now(): number
  step(dt?: number): MotionSnapshot
  steps(count: number, dt?: number): MotionSnapshot
  /** 推进直到 predicate(snapshot) 为真（含当前快照检查），返回最后快照与步数。 */
  until(
    predicate: (snapshot: MotionSnapshot) => boolean,
    maxSteps?: number,
    dt?: number
  ): { snapshot: MotionSnapshot; steps: number }
}

function createSim(options: Partial<PhysicsOptions> = {}): Simulation {
  const physics = createPhysics(options)
  let nowMs = 0
  const step = (dt: number = FIXED_DT): MotionSnapshot => {
    nowMs += dt * 1000
    return physics.step(dt, nowMs)
  }
  const steps = (count: number, dt: number = FIXED_DT): MotionSnapshot => {
    let snapshot = physics.getSnapshot()
    for (let index = 0; index < count; index += 1) snapshot = step(dt)
    return snapshot
  }
  const until = (
    predicate: (snapshot: MotionSnapshot) => boolean,
    maxSteps = 600,
    dt: number = FIXED_DT
  ): { snapshot: MotionSnapshot; steps: number } => {
    let snapshot = physics.getSnapshot()
    let count = 0
    while (!predicate(snapshot) && count < maxSteps) {
      snapshot = step(dt)
      count += 1
    }
    return { snapshot, steps: count }
  }
  return { physics, now: () => nowMs, step, steps, until }
}

/** 断言快照所有数值字段有限、结构合法（退化输入测试用）。 */
function expectFiniteSnapshot(snapshot: MotionSnapshot): void {
  expect(Number.isFinite(snapshot.feet.x)).toBe(true)
  expect(Number.isFinite(snapshot.feet.y)).toBe(true)
  expect(Number.isFinite(snapshot.velocity.x)).toBe(true)
  expect(Number.isFinite(snapshot.velocity.y)).toBe(true)
  expect(['left', 'right', 'front']).toContain(snapshot.facing)
  expect(typeof snapshot.grounded).toBe('boolean')
  expect(typeof snapshot.airborne).toBe('boolean')
  expect(snapshot.surfaceId === null || typeof snapshot.surfaceId === 'string').toBe(true)
}

/* ========================================================================== */
/* 初始状态                                                                   */
/* ========================================================================== */

describe('初始状态', () => {
  it('地面居中站立：grounded=true、surfaceId=screen-bottom、朝前、静止', () => {
    const physics = createPhysics()
    const snapshot = physics.getSnapshot()
    expect(snapshot.feet).toEqual({ x: 960, y: GROUND_TOP })
    expect(snapshot.velocity).toEqual({ x: 0, y: 0 })
    expect(snapshot.facing).toBe('front')
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.airborne).toBe(false)
    expect(snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(physics.getDebugSnapshot().mode).toBe('idle')
    expect(physics.getDebugSnapshot().gravityPxPerSec2).toBe(GRAVITY)
  })

  it('getSnapshot/step 返回拷贝：外部改返回值不影响内部状态', () => {
    const physics = createPhysics()
    const snapshot = physics.getSnapshot()
    snapshot.feet.x = -12345
    snapshot.velocity.y = 999
    expect(physics.getSnapshot().feet.x).toBe(960)
    expect(physics.getSnapshot().velocity.y).toBe(0)
    const stepped = physics.step(FIXED_DT, 1000)
    stepped.feet.y = -1
    expect(physics.getSnapshot().feet.y).toBe(GROUND_TOP)
  })

  it('初始脚底不在地面（悬空）→ airborne=true', () => {
    const physics = createPhysics({ initialFeet: { x: 700, y: 200 } })
    const snapshot = physics.getSnapshot()
    expect(snapshot.airborne).toBe(true)
    expect(snapshot.grounded).toBe(false)
    expect(snapshot.surfaceId).toBeNull()
  })
})

/* ========================================================================== */
/* 重力 / 落地 / 边界                                                          */
/* ========================================================================== */

describe('重力与落地', () => {
  it('自由落体：固定 dt 的位移/速度与离散积分精确一致（确定性）', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 100 } })
    const dt = 0.05
    let snapshot = physics.getSnapshot()
    for (let index = 0; index < 10; index += 1) {
      snapshot = physics.step(dt, (index + 1) * dt * 1000)
    }
    // 半隐式欧拉：y = y0 + g·dt²·n(n+1)/2，v = g·dt·n
    expect(snapshot.feet.y).toBeCloseTo(100 + GRAVITY * dt * dt * (10 * 11) / 2, 6)
    expect(snapshot.velocity.y).toBeCloseTo(GRAVITY * dt * 10, 6)
    expect(snapshot.airborne).toBe(true)
    expect(snapshot.grounded).toBe(false)
    expect(snapshot.feet.x).toBeCloseTo(960, 6)
  })

  it('落地：竖直速度清零、grounded、surfaceId=地面、不穿透地面', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 940 } })
    let snapshot = physics.getSnapshot()
    expect(snapshot.airborne).toBe(true)
    let maxY = snapshot.feet.y
    let count = 0
    while (!snapshot.grounded && count < 30) {
      snapshot = physics.step(FIXED_DT, (count + 1) * FIXED_DT * 1000)
      maxY = Math.max(maxY, snapshot.feet.y)
      count += 1
    }
    expect(count).toBeLessThan(30)
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.airborne).toBe(false)
    expect(snapshot.velocity.y).toBe(0)
    expect(snapshot.feet.y).toBe(GROUND_TOP)
    expect(snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(maxY).toBeLessThanOrEqual(GROUND_TOP)
    // 落地后继续 step 不再下穿
    const settled = createSim({ initialFeet: { x: 960, y: 940 } })
    settled.physics.step(FIXED_DT, FIXED_DT * 1000)
    const after = settled.steps(60)
    expect(after.feet.y).toBe(GROUND_TOP)
    expect(after.grounded).toBe(true)
  })

  it('左右墙 clamp：walk 不穿出 workArea，撞墙后水平速度清零', () => {
    const sim = createSim()
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: -5000, y: GROUND_TOP },
      speedPxPerSec: 600,
      mode: 'walk'
    })
    const left = sim.steps(200)
    expect(left.feet.x).toBe(MIN_X)
    expect(left.feet.x).toBeGreaterThanOrEqual(MIN_X - 1e-9)
    expect(left.velocity.x).toBe(0)
    expect(left.grounded).toBe(true)
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: 99999, y: 0 },
      speedPxPerSec: 600,
      mode: 'walk'
    })
    const right = sim.steps(400)
    expect(right.feet.x).toBe(MAX_X)
    expect(right.feet.x).toBeLessThanOrEqual(MAX_X + 1e-9)
    expect(right.velocity.x).toBe(0)
  })

  it('被甩飞撞左墙：速度反向衰减（小反弹），feet 不穿出左墙', () => {
    const physics = createPhysics({ initialFeet: { x: 500, y: 400 } })
    physics.beginDrag({ x: 500, y: 400 }, 0)
    physics.dragTo({ x: 460, y: 400 }, 16)
    physics.dragTo({ x: 420, y: 400 }, 32)
    physics.dragTo({ x: 380, y: 400 }, 48)
    physics.dragTo({ x: 340, y: 400 }, 64)
    const { throwVelocity } = physics.endDrag(64)
    expect(throwVelocity.x).toBeCloseTo(-2500, 6) // 160px / 64ms
    let snapshot = physics.getSnapshot()
    let minX = snapshot.feet.x
    let bouncedX = 0
    let now = 100
    for (let index = 0; index < 200; index += 1) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
      minX = Math.min(minX, snapshot.feet.x)
      if (bouncedX === 0 && snapshot.velocity.x > 0) bouncedX = snapshot.velocity.x
      if (snapshot.grounded) break
    }
    expect(minX).toBeGreaterThanOrEqual(MIN_X - 1e-9)
    expect(minX).toBeCloseTo(MIN_X, 6)
    expect(bouncedX).toBeCloseTo(2500 * 0.4, 3)
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.feet.y).toBe(GROUND_TOP)
    expect(snapshot.feet.x).toBeGreaterThanOrEqual(MIN_X)
    expect(snapshot.feet.x).toBeLessThanOrEqual(MAX_X)
    // 落地后地面摩擦让水平速度衰减到 0
    const settled = simUntilGroundedAndStill(physics, now)
    expect(settled.grounded).toBe(true)
    expect(settled.velocity.x).toBe(0)
    expect(settled.feet.x).toBeGreaterThanOrEqual(MIN_X)
    expect(settled.feet.x).toBeLessThanOrEqual(MAX_X)
  })

  it('被甩往上方：feet 不离开 workArea 顶边，最终落地', () => {
    const physics = createPhysics()
    physics.beginDrag({ x: 960, y: 900 }, 0)
    physics.dragTo({ x: 960, y: 600 }, 20)
    const { throwVelocity } = physics.endDrag(20)
    expect(throwVelocity.y).toBeCloseTo(-THROW_MAX_SPEED_PX_PER_SEC, 6) // 300px/20ms 超上限 → clamp
    let snapshot = physics.getSnapshot()
    let minY = snapshot.feet.y
    let now = 40
    for (let index = 0; index < 400; index += 1) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
      minY = Math.min(minY, snapshot.feet.y)
      expect(Number.isFinite(snapshot.feet.y)).toBe(true)
      if (snapshot.grounded) break
    }
    expect(minY).toBeGreaterThanOrEqual(WORK_AREA.y - 1e-9)
    expect(minY).toBeCloseTo(WORK_AREA.y, 6)
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.feet.y).toBe(GROUND_TOP)
  })
})

/** 推进到 grounded 且水平速度衰减为 0（地面摩擦收尾用）。 */
function simUntilGroundedAndStill(
  physics: PetPhysics,
  startNowMs: number,
  maxSteps = 1200
): MotionSnapshot {
  let now = startNowMs
  let snapshot = physics.getSnapshot()
  for (let index = 0; index < maxSteps; index += 1) {
    now += FIXED_DT * 1000
    snapshot = physics.step(FIXED_DT, now)
    if (snapshot.grounded && snapshot.velocity.x === 0) return snapshot
  }
  return snapshot
}

/* ========================================================================== */
/* 指令：moveTo / sit / drop / teleport / climb                                */
/* ========================================================================== */

describe('运动指令', () => {
  it('moveTo walk：到达后停住、朝向随方向变、目标 y 被忽略（贴支撑面）', () => {
    const sim = createSim()
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: 1200, y: 100 },
      speedPxPerSec: 240,
      mode: 'walk'
    })
    const arrived = sim.until(
      (snapshot) => snapshot.velocity.x === 0 && Math.abs(snapshot.feet.x - 1200) <= MOVE_ARRIVE_EPS_PX,
      120
    )
    expect(arrived.steps).toBeLessThan(120)
    expect(arrived.snapshot.feet.x).toBeCloseTo(1200, 0)
    expect(arrived.snapshot.facing).toBe('right')
    expect(arrived.snapshot.grounded).toBe(true)
    expect(arrived.snapshot.feet.y).toBe(GROUND_TOP) // 目标 y=100 被忽略
    const after = createSim()
    after.physics.setCommand({
      kind: 'moveTo',
      target: { x: 1200, y: 100 },
      speedPxPerSec: 240,
      mode: 'walk'
    })
    after.until(
      (snapshot) => snapshot.velocity.x === 0 && Math.abs(snapshot.feet.x - 1200) <= MOVE_ARRIVE_EPS_PX,
      120
    )
    const still = after.steps(10)
    expect(still.feet.x).toBeCloseTo(1200, 0)
    expect(still.velocity.x).toBe(0)
    // 反方向：朝向 left，静止后保持
    after.physics.setCommand({
      kind: 'moveTo',
      target: { x: 600, y: 0 },
      speedPxPerSec: 240,
      mode: 'walk'
    })
    const back = after.steps(5)
    expect(back.facing).toBe('left')
    after.physics.setCommand({ kind: 'hold' })
    expect(after.steps(120).facing).toBe('left')
  })

  it('moveTo climb：2D 受控攀爬（不落重力），到点停住；换 hold 后松手掉落', () => {
    const sim = createSim()
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: 1200, y: 400 },
      speedPxPerSec: 200,
      mode: 'climb'
    })
    const arrived = sim.until(
      (snapshot) =>
        !snapshot.grounded &&
        !snapshot.airborne &&
        snapshot.velocity.x === 0 &&
        snapshot.velocity.y === 0 &&
        Math.hypot(snapshot.feet.x - 1200, snapshot.feet.y - 400) <= MOVE_ARRIVE_EPS_PX + 1e-6,
      400
    )
    expect(arrived.steps).toBeGreaterThan(1)
    expect(arrived.steps).toBeLessThan(400)
    expect(arrived.snapshot.grounded).toBe(false)
    expect(arrived.snapshot.airborne).toBe(false) // 攀附是第三种状态
    expect(arrived.snapshot.surfaceId).toBeNull()
    expect(
      Math.hypot(arrived.snapshot.feet.x - 1200, arrived.snapshot.feet.y - 400)
    ).toBeLessThanOrEqual(MOVE_ARRIVE_EPS_PX + 1e-6)
    const holding = sim.steps(5)
    expect(holding.feet.x).toBeCloseTo(arrived.snapshot.feet.x, 6)
    expect(holding.feet.y).toBeCloseTo(arrived.snapshot.feet.y, 6)
    sim.physics.setCommand({ kind: 'hold' })
    const released = sim.step()
    expect(released.airborne).toBe(true)
    expect(released.grounded).toBe(false)
  })

  it('climb 到窗口上沿目标：自动落到表面（对应 B1 爬窗沿流程，随后 hold 不会掉下去）', () => {
    const sim = createSim({
      initialFeet: { x: 960, y: GROUND_TOP },
      surfaces: [windowTopSurface()]
    })
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: 1100, y: 700 },
      speedPxPerSec: 200,
      mode: 'climb'
    })
    const arrived = sim.until(
      (snapshot) => snapshot.grounded && snapshot.surfaceId === 'win-7-top',
      600
    )
    expect(arrived.steps).toBeLessThan(600)
    expect(arrived.snapshot.feet.y).toBe(700)
    expect(arrived.snapshot.airborne).toBe(false)
    // B1 到位后会改发 hold：宠物应稳定站在窗口上沿
    sim.physics.setCommand({ kind: 'hold' })
    const still = sim.steps(30)
    expect(still.grounded).toBe(true)
    expect(still.airborne).toBe(false)
    expect(still.feet.y).toBe(700)
    expect(still.surfaceId).toBe('win-7-top')
  })

  it('B1 在距目标 16px 时改发 hold：攀爬补完最后一段并站稳（不会半空掉落）', () => {
    const sim = createSim({
      initialFeet: { x: 960, y: GROUND_TOP },
      surfaces: [windowTopSurface()]
    })
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: 1100, y: 700 },
      speedPxPerSec: 200,
      mode: 'climb'
    })
    let snapshot = sim.physics.getSnapshot()
    let guard = 0
    while (!(snapshot.feet.y <= 716.5 && snapshot.feet.y > 700) && guard < 400) {
      snapshot = sim.step()
      guard += 1
    }
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(400)
    expect(snapshot.grounded).toBe(false) // 还在攀爬中
    expect(snapshot.airborne).toBe(false)
    sim.physics.setCommand({ kind: 'hold' })
    const settled = sim.step()
    expect(settled.grounded).toBe(true)
    expect(settled.airborne).toBe(false)
    expect(settled.feet.y).toBe(700)
    expect(settled.surfaceId).toBe('win-7-top')
  })

  it('sit：移动到窗口上沿并落座（feet.y=surface.top、grounded、surfaceId 正确）', () => {
    const sim = createSim({
      initialFeet: { x: 900, y: GROUND_TOP },
      surfaces: [windowTopSurface()]
    })
    sim.physics.setCommand({ kind: 'sit', surfaceId: 'win-7-top' })
    const result = sim.until((snapshot) => snapshot.grounded && snapshot.surfaceId === 'win-7-top', 400)
    expect(result.steps).toBeLessThan(400)
    expect(result.snapshot.grounded).toBe(true)
    expect(result.snapshot.airborne).toBe(false)
    expect(result.snapshot.surfaceId).toBe('win-7-top')
    expect(result.snapshot.feet.y).toBe(700)
    expect(result.snapshot.feet.x).toBeCloseTo(1000, 6) // 表面内水平 clamp：rect.x + 半宽
    expect(sim.physics.getDebugSnapshot().mode).toBe('sit')
    // 指令持续重复设置也保持坐姿
    const still = sim.steps(10)
    expect(still.feet.y).toBe(700)
    expect(still.surfaceId).toBe('win-7-top')
  })

  it('sit：不可坐/未知表面被丢弃（不猜、不抛、保持原状态）', () => {
    const sim = createSim({ surfaces: [windowTopSurface({ sittable: false })] })
    sim.physics.setCommand({ kind: 'sit', surfaceId: 'win-7-top' })
    const ignored = sim.steps(10)
    expect(ignored.grounded).toBe(true)
    expect(ignored.feet.y).toBe(GROUND_TOP)
    expect(ignored.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(sim.physics.getDebugSnapshot().command).toBe('hold')
    sim.physics.setCommand({ kind: 'sit', surfaceId: 'not-exists' })
    expect(sim.steps(10).feet.y).toBe(GROUND_TOP)
  })

  it('drop：从窗口上沿主动落下（消费指令）→ 落到地面', () => {
    const sim = createSim({
      initialFeet: { x: 1000, y: 700 },
      surfaces: [windowTopSurface()]
    })
    expect(sim.physics.getSnapshot().surfaceId).toBe('win-7-top')
    expect(sim.physics.getSnapshot().grounded).toBe(true)
    sim.physics.setCommand({ kind: 'drop' })
    const falling = sim.step()
    expect(falling.grounded).toBe(false)
    expect(falling.airborne).toBe(true)
    expect(falling.surfaceId).toBeNull()
    const landed = sim.until((snapshot) => snapshot.grounded, 200)
    expect(landed.snapshot.feet.y).toBe(GROUND_TOP)
    expect(landed.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(sim.physics.getDebugSnapshot().command).toBe('hold')
  })

  it('teleport：位置/速度复位，落点在地面时立即 grounded；非法坐标忽略', () => {
    const physics = createPhysics()
    physics.setCommand({ kind: 'teleport', feet: { x: 400, y: GROUND_TOP } })
    const teleported = physics.step(FIXED_DT, 100)
    expect(teleported.feet).toEqual({ x: 400, y: GROUND_TOP })
    expect(teleported.velocity).toEqual({ x: 0, y: 0 })
    expect(teleported.grounded).toBe(true)
    expect(teleported.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    // 非法坐标：忽略、状态不变、指令被消费
    physics.setCommand({ kind: 'teleport', feet: { x: Number.NaN, y: Number.NaN } })
    const ignored = physics.step(FIXED_DT, 200)
    expectFiniteSnapshot(ignored)
    expect(ignored.feet).toEqual({ x: 400, y: GROUND_TOP })
    expect(physics.getDebugSnapshot().command).toBe('hold')
  })
})

/* ========================================================================== */
/* 桌面表面：窗口上沿 / 消失 / 移动 / Dock                                       */
/* ========================================================================== */

describe('桌面表面', () => {
  it('自由落体落到窗口上沿：feet.y=surface.top、surfaceId、竖直速度清零、不穿透', () => {
    const physics = createPhysics({
      initialFeet: { x: 1000, y: 0 },
      surfaces: [windowTopSurface()]
    })
    let snapshot = physics.getSnapshot()
    expect(snapshot.airborne).toBe(true)
    let maxY = -Infinity
    let now = 0
    let count = 0
    while (!snapshot.grounded && count < 200) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
      maxY = Math.max(maxY, snapshot.feet.y)
      count += 1
    }
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.airborne).toBe(false)
    expect(snapshot.surfaceId).toBe('win-7-top')
    expect(snapshot.velocity.y).toBe(0)
    expect(snapshot.feet.y).toBe(700)
    expect(maxY).toBeLessThanOrEqual(700)
  })

  it('横向半宽判定：只有宠物身体与表面 rect 有重叠才落上去', () => {
    // 窄窗口（rect x=1000..1100）：feet.x=1150 时身体左缘 950 仍在表面内 → 可落
    const narrow = windowTopSurface({
      id: 'win-9-top',
      rect: { x: 1000, y: 300, width: 100, height: 1 },
      top: 300,
      windowId: 9
    })
    const onNarrow = createPhysics({ initialFeet: { x: 1150, y: 0 }, surfaces: [narrow] })
    let snapshot = onNarrow.getSnapshot()
    for (let index = 0; index < 200 && !snapshot.grounded; index += 1) {
      snapshot = onNarrow.step(FIXED_DT, (index + 1) * FIXED_DT * 1000)
    }
    expect(snapshot.surfaceId).toBe('win-9-top')
    expect(snapshot.feet.y).toBe(300)
    // feet.x=1450 时身体左缘 1250 > 1100 → 无重叠 → 落不到，继续掉到地面
    const offNarrow = createPhysics({ initialFeet: { x: 1450, y: 0 }, surfaces: [narrow] })
    let missed = offNarrow.getSnapshot()
    for (let index = 0; index < 300 && !missed.grounded; index += 1) {
      missed = offNarrow.step(FIXED_DT, (index + 1) * FIXED_DT * 1000)
    }
    expect(missed.feet.y).toBe(GROUND_TOP)
    expect(missed.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
  })

  it('窗口表面消失：重新进入空中并掉落到地面', () => {
    const sim = createSim({ initialFeet: { x: 1000, y: 700 }, surfaces: [windowTopSurface()] })
    expect(sim.physics.getSnapshot().surfaceId).toBe('win-7-top')
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: [] })
    const after = sim.step()
    expect(after.grounded).toBe(false)
    expect(after.airborne).toBe(true)
    expect(after.surfaceId).toBeNull()
    const landed = sim.until((snapshot) => snapshot.grounded, 200)
    expect(landed.snapshot.feet.y).toBe(GROUND_TOP)
    expect(landed.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
  })

  it('窗口垂直移动：feety 吸附新 top（跟随）；窗口横向移走：失去支撑掉落', () => {
    const sim = createSim({ initialFeet: { x: 1000, y: 700 }, surfaces: [windowTopSurface()] })
    expect(sim.physics.getSnapshot().grounded).toBe(true)
    sim.physics.setEnvironment({
      workArea: WORK_AREA,
      petSize: PET_SIZE,
      surfaces: [
        windowTopSurface({ top: 650, rect: { x: 800, y: 650, width: 600, height: 1 } })
      ]
    })
    const followed = sim.physics.getSnapshot()
    expect(followed.feet.y).toBe(650)
    expect(followed.grounded).toBe(true)
    expect(followed.surfaceId).toBe('win-7-top')
    sim.physics.setEnvironment({
      workArea: WORK_AREA,
      petSize: PET_SIZE,
      surfaces: [
        windowTopSurface({ top: 650, rect: { x: 1700, y: 650, width: 200, height: 1 } })
      ]
    })
    const lost = sim.step()
    expect(lost.grounded).toBe(false)
    expect(lost.airborne).toBe(true)
    expect(lost.surfaceId).toBeNull()
  })

  it('B5 提供 screen-bottom 表面时使用其 id；Dock 与地面同 top 时优先 Dock', () => {
    const bottom: DesktopSurface = {
      id: 'screen-6-bottom',
      kind: 'screen-bottom',
      rect: { x: 0, y: GROUND_TOP, width: 1920, height: 1 },
      top: GROUND_TOP,
      sittable: false,
      climbable: false
    }
    const physics = createPhysics({ surfaces: [bottom] })
    expect(physics.getSnapshot().grounded).toBe(true)
    expect(physics.getSnapshot().surfaceId).toBe('screen-6-bottom')
    const dock: DesktopSurface = {
      id: 'dock-1',
      kind: 'dock',
      rect: { x: 0, y: GROUND_TOP, width: 1920, height: 1 },
      top: GROUND_TOP,
      sittable: true,
      climbable: false
    }
    const sim = createSim({ initialFeet: { x: 960, y: GROUND_TOP - 10 }, surfaces: [bottom, dock] })
    const landed = sim.until((snapshot) => snapshot.grounded, 60)
    expect(landed.snapshot.surfaceId).toBe('dock-1')
    expect(landed.snapshot.feet.y).toBe(GROUND_TOP)
  })
})

/* ========================================================================== */
/* 修复轮 F3：H-4 支撑面 workArea 外 top / D6a 段 id 抖动重匹配                 */
/* ========================================================================== */

describe('支撑重校验（H-4 workArea 外 top / D6a 段 id 抖动）', () => {
  it('H-4：支撑面 top 移到 -80 → 不再 grounded、feet.y 不得写成负值、最终落在屏幕内地面', () => {
    const sim = createSim({ initialFeet: { x: 1000, y: 700 }, surfaces: [windowTopSurface()] })
    expect(sim.physics.getSnapshot().grounded).toBe(true)
    // 窗口被拖到屏幕上方：本地 top 700 → -80（review P2 复现）
    const moved = windowTopSurface({
      top: -80,
      rect: { x: 800, y: -80, width: 600, height: 1 }
    })
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: [moved] })
    const afterEnv = sim.physics.getSnapshot()
    expect(afterEnv.grounded).toBe(false)
    expect(afterEnv.airborne).toBe(true)
    // 旧 bug：refreshSupport 直接把 feet.y 写成 surface.top=-80 → petRectTop=-620 整只出画
    expect(afterEnv.feet.y).toBe(700)
    expect(afterEnv.surfaceId).toBeNull()
    const next = sim.step()
    expect(next.airborne).toBe(true)
    const landed = sim.until((snapshot) => snapshot.grounded, 200)
    expect(landed.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(landed.snapshot.feet.y).toBe(GROUND_TOP)
    const petRectTop = landed.snapshot.feet.y - PET_SIZE.height
    expect(petRectTop).toBeGreaterThanOrEqual(0) // 不再整体在视口上方
  })

  it('H-4：支撑面 top 落在 workArea 底边之外 → 同样按无支撑处理', () => {
    const sim = createSim({ initialFeet: { x: 1000, y: 700 }, surfaces: [windowTopSurface()] })
    const below = windowTopSurface({
      top: GROUND_TOP + 200,
      rect: { x: 800, y: GROUND_TOP + 200, width: 600, height: 1 }
    })
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: [below] })
    const after = sim.physics.getSnapshot()
    expect(after.grounded).toBe(false)
    expect(after.airborne).toBe(true)
    const landed = sim.until((snapshot) => snapshot.grounded, 200)
    expect(landed.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(landed.snapshot.feet.y).toBe(GROUND_TOP)
  })

  it('D6a：段 id 改指/合并 → 按 windowId+kind+top 重匹配，仍 grounded 且 surfaceId 更新', () => {
    const full: DesktopSurface = {
      id: 'win-7-top',
      kind: 'window-top',
      rect: { x: 200, y: 600, width: 1200, height: 1 },
      top: 600,
      windowId: 7,
      sittable: true,
      climbable: false
    }
    const sim = createSim({ initialFeet: { x: 1000, y: 600 }, surfaces: [full] })
    expect(sim.physics.getSnapshot()).toMatchObject({
      grounded: true,
      surfaceId: 'win-7-top',
      feet: { x: 1000, y: 600 }
    })

    // ① 遮挡出现：旧 id `win-7-top` 改指左段（不再覆盖宠物），宠物脚下是右段 `win-7-top-1`
    const split: DesktopSurface[] = [
      { ...full, rect: { x: 200, y: 600, width: 500, height: 1 } },
      { ...full, id: 'win-7-top-1', rect: { x: 900, y: 600, width: 400, height: 1 } }
    ]
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: split })
    const afterSplit = sim.physics.getSnapshot()
    expect(afterSplit.grounded).toBe(true)
    expect(afterSplit.airborne).toBe(false)
    expect(afterSplit.surfaceId).toBe('win-7-top-1')
    expect(afterSplit.feet.y).toBe(600)

    // ② 遮挡解除：两段合并回整条 `win-7-top`，旧 id `win-7-top-1` 消失 → 重匹配回整段
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: [full] })
    const afterMerge = sim.physics.getSnapshot()
    expect(afterMerge.grounded).toBe(true)
    expect(afterMerge.surfaceId).toBe('win-7-top')
    expect(afterMerge.feet.y).toBe(600)
  })

  it('D6a：段 id 变化且窗口移动 → 退化为同 windowId 最近的 top（跟随窗口）', () => {
    const full: DesktopSurface = {
      id: 'win-7-top',
      kind: 'window-top',
      rect: { x: 200, y: 600, width: 1200, height: 1 },
      top: 600,
      windowId: 7,
      sittable: true,
      climbable: false
    }
    const sim = createSim({ initialFeet: { x: 1000, y: 600 }, surfaces: [full] })
    // 窗口下移 120px 且被切成两段（左段沿用旧 id 但已不覆盖宠物）
    const movedSplit: DesktopSurface[] = [
      { ...full, top: 720, rect: { x: 200, y: 720, width: 500, height: 1 } },
      { ...full, id: 'win-7-top-1', top: 720, rect: { x: 900, y: 720, width: 400, height: 1 } }
    ]
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: movedSplit })
    const after = sim.physics.getSnapshot()
    expect(after.grounded).toBe(true)
    expect(after.surfaceId).toBe('win-7-top-1')
    expect(after.feet.y).toBe(720)
  })

  it('D6a：找不到同窗口/同 top 的表面 → 才掉落（不跨窗口乱吸附）', () => {
    const sim = createSim({ initialFeet: { x: 1000, y: 700 }, surfaces: [windowTopSurface()] })
    // 换成另一个窗口的窗沿（top 相同也不匹配，避免跨窗口吸附）
    const other = windowTopSurface({
      id: 'win-8-top',
      windowId: 8,
      top: 700,
      rect: { x: 200, y: 700, width: 1200, height: 1 }
    })
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: PET_SIZE, surfaces: [other] })
    const after = sim.physics.getSnapshot()
    expect(after.grounded).toBe(false)
    expect(after.airborne).toBe(true)
    expect(after.surfaceId).toBeNull()
    const landed = sim.until((snapshot) => snapshot.grounded, 200)
    expect(landed.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
  })

  it('H-4：sit 到 workArea 外 top 的表面被丢弃（不会坐到视口外）', () => {
    const outOfArea: DesktopSurface = {
      id: 'win-9-top',
      kind: 'window-top',
      rect: { x: 0, y: -30, width: 1920, height: 1 },
      top: -30,
      windowId: 9,
      sittable: true,
      climbable: false
    }
    const sim = createSim({ surfaces: [outOfArea] })
    sim.physics.setCommand({ kind: 'sit', surfaceId: 'win-9-top' })
    // 5s 内不得出现「grounded at win-9-top / feet.y<0」；旧实现会爬到 y=0 坐在这块屏外表面上。
    const after = sim.steps(300)
    expect(after.grounded).toBe(true)
    expect(after.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(after.feet.y).toBe(GROUND_TOP)
  })
})

/* ========================================================================== */
/* 拖拽 / 甩出                                                                 */
/* ========================================================================== */

describe('拖拽', () => {
  it('beginDrag 保留抓取偏移；step 指数平滑跟随目标、不越过目标', () => {
    const physics = createPhysics()
    physics.beginDrag({ x: 960, y: GROUND_TOP }, 0)
    expect(physics.getDebugSnapshot().dragging).toBe(true)
    physics.dragTo({ x: 1060, y: GROUND_TOP }, 16)
    let snapshot = physics.step(FIXED_DT, 32)
    expect(snapshot.grounded).toBe(false)
    expect(snapshot.airborne).toBe(false)
    expect(physics.getDebugSnapshot().mode).toBe('drag')
    const factor = 1 - Math.exp(-FIXED_DT / (DRAG_SMOOTHING_TAU_MS / 1000))
    expect(snapshot.feet.x).toBeCloseTo(960 + 100 * factor, 6)
    expect(snapshot.velocity.x).toBeGreaterThan(0)
    let previousX = snapshot.feet.x
    let maxX = snapshot.feet.x
    for (let index = 0; index < 60; index += 1) {
      snapshot = physics.step(FIXED_DT, 32 + (index + 1) * FIXED_DT * 1000)
      expect(snapshot.feet.x).toBeGreaterThanOrEqual(previousX - 1e-9) // 单调逼近
      expect(snapshot.feet.x).toBeLessThanOrEqual(1060 + 1e-9) // 不越过目标
      previousX = snapshot.feet.x
      maxX = Math.max(maxX, snapshot.feet.x)
    }
    expect(maxX).toBeLessThanOrEqual(1060 + 1e-9)
    expect(1060 - snapshot.feet.x).toBeLessThan(1)
  })

  it('endDrag：最近 120ms 指针速度估计（合成轨迹）', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics.beginDrag({ x: 960, y: 400 }, 0)
    physics.dragTo({ x: 980, y: 400 }, 16)
    physics.dragTo({ x: 1000, y: 400 }, 32)
    physics.dragTo({ x: 1020, y: 400 }, 48)
    const result = physics.endDrag(48)
    expect(result.throwVelocity.x).toBeCloseTo(1250, 6) // 60px / 48ms
    expect(result.throwVelocity.y).toBeCloseTo(0, 6)
    const snapshot = physics.getSnapshot()
    expect(physics.getDebugSnapshot().dragging).toBe(false)
    expect(snapshot.airborne).toBe(true)
    expect(snapshot.grounded).toBe(false)
    expect(snapshot.velocity.x).toBeCloseTo(1250, 6)
  })

  it('endDrag 可传入 B4 的 throwVelocity 覆盖（仍 clamp）；非法覆盖值退回自估', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics.beginDrag({ x: 960, y: 400 }, 0)
    physics.dragTo({ x: 980, y: 400 }, 16)
    const overridden = physics.endDrag(16, { x: 1000, y: -200 })
    expect(overridden.throwVelocity).toEqual({ x: 1000, y: -200 })
    expect(physics.getSnapshot().velocity).toEqual({ x: 1000, y: -200 })
    const physics2 = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics2.beginDrag({ x: 960, y: 400 }, 0)
    physics2.dragTo({ x: 980, y: 400 }, 16)
    const clamped = physics2.endDrag(16, { x: 9000, y: 0 })
    expect(clamped.throwVelocity.x).toBeCloseTo(THROW_MAX_SPEED_PX_PER_SEC, 6)
    const physics3 = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics3.beginDrag({ x: 960, y: 400 }, 0)
    physics3.dragTo({ x: 980, y: 400 }, 16)
    const fallback = physics3.endDrag(16, { x: Number.NaN, y: 0 })
    expect(fallback.throwVelocity.x).toBeGreaterThan(0) // 非法覆盖 → 用自估
    expect(Number.isFinite(fallback.throwVelocity.x)).toBe(true)
  })

  it('endDrag：先停住再松手 → 估计速度衰减/归零（不会误甩）', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics.beginDrag({ x: 960, y: 400 }, 0)
    physics.dragTo({ x: 980, y: 400 }, 16)
    physics.dragTo({ x: 1000, y: 400 }, 32)
    physics.dragTo({ x: 1020, y: 400 }, 48)
    expect(physics.endDrag(100).throwVelocity.x).toBeCloseTo(600, 6) // 60px / 100ms
    const physics2 = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics2.beginDrag({ x: 960, y: 400 }, 0)
    physics2.dragTo({ x: 980, y: 400 }, 16)
    physics2.dragTo({ x: 1000, y: 400 }, 32)
    physics2.dragTo({ x: 1020, y: 400 }, 48)
    expect(physics2.endDrag(400).throwVelocity).toEqual({ x: 0, y: 0 }) // 停住超过窗口
  })

  it('endDrag 未在拖拽中调用 → 零速度（不抛异常）', () => {
    const physics = createPhysics()
    expect(physics.endDrag(10)).toEqual({ throwVelocity: { x: 0, y: 0 } })
    physics.beginDrag({ x: Number.NaN, y: Number.NaN }, 0)
    expect(physics.getDebugSnapshot().dragging).toBe(false)
    expect(physics.endDrag(10)).toEqual({ throwVelocity: { x: 0, y: 0 } })
  })

  it('拖拽样本数有上限：长时间高频输入内存恒定、估计有限', () => {
    const physics = createPhysics()
    physics.beginDrag({ x: 960, y: GROUND_TOP }, 0)
    for (let index = 1; index <= 5000; index += 1) {
      physics.dragTo({ x: 960 + (index % 10), y: GROUND_TOP }, index)
    }
    expect(physics.getDebugSnapshot().pointerSamples).toBeLessThanOrEqual(THROW_MAX_SAMPLES)
    expect(physics.getDebugSnapshot().pointerSamples).toBeGreaterThan(1)
    const snapshot = physics.step(FIXED_DT, 5001)
    expectFiniteSnapshot(snapshot)
    const result = physics.endDrag(5001)
    expect(Number.isFinite(result.throwVelocity.x)).toBe(true)
    expect(Math.hypot(result.throwVelocity.x, result.throwVelocity.y)).toBeLessThanOrEqual(
      THROW_MAX_SPEED_PX_PER_SEC + 1e-9
    )
  })
})

/* ========================================================================== */
/* V7：拖拽起手侧身朝向（humanoid / 用户实机反馈）                              */
/* ========================================================================== */

/** VRM humanoid 在 540px 高时的宠物尺寸：`bodyAspectRatio=0.30` → 宽 162（比 PMX 窄）。 */
const VRM_PET_SIZE: PetSize = { width: 162, height: 540 }

describe('V7：拖拽起手侧身朝向', () => {
  it('facing=front 时 beginDrag → 立即切到默认侧向（right），不再正面朝镜头', () => {
    const physics = createPhysics()
    expect(physics.getSnapshot().facing).toBe('front')
    physics.beginDrag({ x: 960, y: GROUND_TOP }, 0)
    expect(DRAG_START_FACING).toBe('right')
    expect(physics.getSnapshot().facing).toBe(DRAG_START_FACING)
    // 不用等 step：起手当帧运行时就能拿到侧向 facing（main.ts 在同帧 setFacing）。
    expect(physics.getDebugSnapshot().dragging).toBe(true)
  })

  it('已侧身/行走方向保留：facing=left 时 beginDrag 不强制改向', () => {
    const sim = createSim()
    sim.physics.setCommand({
      kind: 'moveTo',
      target: { x: 600, y: GROUND_TOP },
      speedPxPerSec: 240,
      mode: 'walk'
    })
    const walking = sim.steps(5)
    expect(walking.facing).toBe('left')
    sim.physics.beginDrag({ x: walking.feet.x, y: walking.feet.y }, sim.now())
    expect(sim.physics.getSnapshot().facing).toBe('left')
  })

  it('拖拽中水平移动 → 朝移动方向（左右切换）；纯纵向拖动保持侧向', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 400 } })
    physics.beginDrag({ x: 960, y: 400 }, 0)
    physics.dragTo({ x: 1060, y: 400 }, 16)
    let snapshot = physics.step(FIXED_DT, 32)
    expect(snapshot.facing).toBe('right')

    physics.dragTo({ x: 700, y: 400 }, 100)
    let now = 100
    for (let index = 0; index < 30; index += 1) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
    }
    expect(snapshot.facing).toBe('left')

    // 纯纵向拖动（目标 x = 当前 x）→ 不动朝向，保持侧向。
    physics.dragTo({ x: snapshot.feet.x, y: 300 }, now)
    for (let index = 0; index < 30; index += 1) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
    }
    expect(snapshot.facing).toBe('left')
  })

  it('松手落地后物理层保留侧向（回 front 由行为层/运行时负责，B2 不硬重置）', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 300 } })
    physics.beginDrag({ x: 960, y: 300 }, 0)
    expect(physics.getSnapshot().facing).toBe('right')
    physics.endDrag(60)
    let now = 60
    let snapshot = physics.getSnapshot()
    for (let index = 0; index < 300 && !snapshot.grounded; index += 1) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
    }
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(snapshot.facing).toBe('right')
  })

  it('窄模型（宽 162）起手同样切侧向，不受 petSize 影响', () => {
    const physics = createPhysics({ petSize: VRM_PET_SIZE, initialFeet: { x: 960, y: GROUND_TOP } })
    physics.beginDrag({ x: 960, y: GROUND_TOP }, 0)
    expect(physics.getSnapshot().facing).toBe(DRAG_START_FACING)
  })
})

/* ========================================================================== */
/* V7：窄模型（VRM bodyAspectRatio=0.30）边界 / 坐窗核查                         */
/* ========================================================================== */

describe('V7：窄模型半宽/边界核查（宽 162 @540）', () => {
  const HALF_WIDTH_VRM = VRM_PET_SIZE.width / 2 // 81
  const VRM_MIN_X = WORK_AREA.x + HALF_WIDTH_VRM
  const VRM_MAX_X = WORK_AREA.x + WORK_AREA.width - HALF_WIDTH_VRM

  it('走到左右边界精确停在 ±halfW（不越界 / 不卡在墙里）', () => {
    const physics = createPhysics({ petSize: VRM_PET_SIZE })
    physics.setCommand({
      kind: 'moveTo',
      target: { x: -500, y: GROUND_TOP },
      speedPxPerSec: 300,
      mode: 'walk'
    })
    let snapshot = physics.getSnapshot()
    for (let index = 0; index < 240; index += 1) {
      snapshot = physics.step(FIXED_DT, (index + 1) * FIXED_DT * 1000)
    }
    expect(snapshot.feet.x).toBeCloseTo(VRM_MIN_X, 6)
    expect(snapshot.velocity.x).toBe(0)

    physics.setCommand({
      kind: 'moveTo',
      target: { x: 5000, y: GROUND_TOP },
      speedPxPerSec: 300,
      mode: 'walk'
    })
    // 81 → 1839 约 1758px / 300px/s ≈ 5.9s → 400 帧足够（留余量）。
    for (let index = 0; index < 400; index += 1) {
      snapshot = physics.step(FIXED_DT, (300 + index) * FIXED_DT * 1000)
    }
    expect(snapshot.feet.x).toBeCloseTo(VRM_MAX_X, 6)
    expect(snapshot.velocity.x).toBe(0)
  })

  it('窄窗台上沿可落可坐：目标 x 按半宽 clamp 进窗沿，不卡住', () => {
    const surface = windowTopSurface({
      rect: { x: 900, y: 700, width: 240, height: 1 },
      top: 700
    })
    const sim = createSim({ petSize: VRM_PET_SIZE, surfaces: [surface] })
    // 从窗口上沿正上方落下（初速 0）→ 应落到窗沿而不是穿过去。
    sim.physics.setCommand({ kind: 'teleport', feet: { x: 1000, y: 640 } })
    sim.step(0.001)
    const landed = sim.until((snapshot) => snapshot.grounded, 300)
    expect(landed.snapshot.surfaceId).toBe('win-7-top')
    expect(landed.snapshot.feet.y).toBe(700)
    // 坐：目标 x 必须落在 [rect.x+halfW, rect.right-halfW] = [981, 1059] 内。
    sim.physics.setCommand({ kind: 'sit', surfaceId: 'win-7-top' })
    const seated = sim.until(
      (snapshot) => snapshot.grounded && snapshot.surfaceId === 'win-7-top' && snapshot.velocity.x === 0,
      600
    )
    expect(seated.snapshot.feet.y).toBe(700)
    expect(seated.snapshot.feet.x).toBeGreaterThanOrEqual(981 - 1e-6)
    expect(seated.snapshot.feet.x).toBeLessThanOrEqual(1059 + 1e-6)
  })

  it('窄模型站窗沿时表面消失 → 正常掉落（半宽重叠判定不会卡住）', () => {
    const sim = createSim({ petSize: VRM_PET_SIZE, surfaces: [windowTopSurface()] })
    sim.physics.setCommand({ kind: 'teleport', feet: { x: 1000, y: 700 } })
    sim.step(0.001)
    expect(sim.physics.getSnapshot().surfaceId).toBe('win-7-top')
    sim.physics.setEnvironment({ workArea: WORK_AREA, petSize: VRM_PET_SIZE, surfaces: [] })
    const falling = sim.physics.getSnapshot()
    expect(falling.grounded).toBe(false)
    expect(falling.airborne).toBe(true)
    const ground = sim.until((snapshot) => snapshot.grounded, 300)
    expect(ground.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(ground.snapshot.feet.y).toBe(GROUND_TOP)
  })
})

/* ========================================================================== */
/* 确定性 / 退化输入                                                            */
/* ========================================================================== */

describe('确定性与退化输入', () => {
  it('同一输入序列产生逐帧相同的快照（纯确定性）', () => {
    const surfaces = [windowTopSurface()]
    const first = createPhysics({ surfaces })
    const second = createPhysics({ surfaces })
    const commands: MotionCommand[] = [
      { kind: 'moveTo', target: { x: 1200, y: GROUND_TOP }, speedPxPerSec: 240, mode: 'walk' },
      { kind: 'hold' },
      { kind: 'moveTo', target: { x: 1100, y: 400 }, speedPxPerSec: 120, mode: 'climb' },
      { kind: 'sit', surfaceId: 'win-7-top' },
      { kind: 'hold' },
      { kind: 'drop' },
      { kind: 'teleport', feet: { x: 500, y: 500 } },
      { kind: 'moveTo', target: { x: 700, y: 300 }, speedPxPerSec: 90, mode: 'climb' }
    ]
    const dts = [FIXED_DT, 1 / 30, 0.05, 1 / 120, 0.1]
    let now = 0
    let mismatches = 0
    for (let index = 0; index < 40; index += 1) {
      const command = commands[index % commands.length]
      const dt = dts[index % dts.length]
      first.setCommand(command)
      second.setCommand(command)
      now += dt * 1000
      const a = first.step(dt, now)
      const b = second.step(dt, now)
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches += 1
      expect(a).toEqual(b)
    }
    expect(mismatches).toBe(0)
  })

  it('NaN/负数/超大 dt：不抛、不产生 NaN、内部状态保持有限', () => {
    const physics = createPhysics({ initialFeet: { x: 960, y: 100 } })
    expectFiniteSnapshot(physics.step(Number.NaN, Number.NaN))
    expectFiniteSnapshot(physics.step(-1, 0))
    expectFiniteSnapshot(physics.step(Number.POSITIVE_INFINITY, 10))
    expectFiniteSnapshot(physics.step(1e9, 20)) // dt 截断到 MAX_STEP_DT
    expectFiniteSnapshot(physics.getSnapshot())
  })

  it('NaN 环境参数被忽略（保留上一份合法环境）', () => {
    const physics = createPhysics()
    physics.setEnvironment({
      workArea: { x: Number.NaN, y: 0, width: 0, height: 0 } as unknown as Rect,
      petSize: { width: Number.NaN, height: Number.NaN } as unknown as PetSize,
      surfaces: undefined as unknown as DesktopSurface[]
    })
    expectFiniteSnapshot(physics.step(FIXED_DT, 100))
    expect(physics.getSnapshot().feet.x).toBe(960)
    expect(physics.getSnapshot().grounded).toBe(true)
  })

  it('非法表面（NaN top / 坏 rect）被忽略，正常落到地面', () => {
    const badTop: DesktopSurface = {
      id: 'bad-top',
      kind: 'window-top',
      rect: { x: 800, y: 300, width: 600, height: 1 },
      top: Number.NaN,
      sittable: true,
      climbable: true
    }
    const badRect: DesktopSurface = {
      id: 'bad-rect',
      kind: 'window-top',
      rect: { x: Number.NaN, y: 300, width: 600, height: 1 },
      top: 300,
      sittable: true,
      climbable: true
    }
    const physics = createPhysics({ initialFeet: { x: 960, y: 100 }, surfaces: [badTop, badRect] })
    let snapshot = physics.getSnapshot()
    let now = 0
    for (let index = 0; index < 300 && !snapshot.grounded; index += 1) {
      now += FIXED_DT * 1000
      snapshot = physics.step(FIXED_DT, now)
    }
    expect(snapshot.feet.y).toBe(GROUND_TOP)
    expect(snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
    expect(Number.isFinite(snapshot.feet.y)).toBe(true)
  })

  it('非法指令/坐标：丢弃或忽略，不抛异常、位置不变', () => {
    const physics = createPhysics()
    physics.setCommand({
      kind: 'moveTo',
      target: { x: Number.NaN, y: 0 },
      speedPxPerSec: 100,
      mode: 'walk'
    })
    expectFiniteSnapshot(physics.step(FIXED_DT, 100))
    expect(physics.getSnapshot().feet.x).toBe(960)
    physics.setCommand({ kind: 'moveTo', target: { x: 1400, y: 0 }, speedPxPerSec: 0, mode: 'walk' })
    expectFiniteSnapshot(physics.step(FIXED_DT, 200))
    expect(physics.getSnapshot().feet.x).toBe(960)
    physics.setCommand(null as unknown as MotionCommand)
    expectFiniteSnapshot(physics.step(FIXED_DT, 300))
    physics.setCommand({ kind: 'unknown-kind' } as unknown as MotionCommand)
    expect(physics.getDebugSnapshot().command).toBe('hold')
  })

  it('拖拽中注入 NaN 指针：被忽略、状态仍有限', () => {
    const physics = createPhysics()
    physics.beginDrag({ x: 960, y: GROUND_TOP }, 0)
    physics.dragTo({ x: Number.NaN, y: 0 }, 16)
    physics.dragTo({ x: 0, y: Number.POSITIVE_INFINITY }, 32)
    expectFiniteSnapshot(physics.step(FIXED_DT, 48))
    const result = physics.endDrag(48)
    expectFiniteSnapshot(physics.getSnapshot())
    expect(result.throwVelocity).toEqual({ x: 0, y: 0 })
  })
})

/* ========================================================================== */
/* 放置（松手 → 吸附窗沿 / 原地站定，2026-11-09 用户反馈修复）                   */
/* ========================================================================== */

describe('放置：beginPlacement（surface 吸附 / anchor 站定）', () => {
  it('surface 模式：平滑滑到窗沿上方 → 自由落体 2px 落到窗沿（grounded）', () => {
    const sim = createSim({
      initialFeet: { x: 900, y: 300 },
      surfaces: [windowTopSurface({ id: 'win-7-top', top: 700, rect: { x: 600, y: 700, width: 800, height: 1 } })]
    })
    const accepted = sim.physics.beginPlacement(
      { mode: 'surface', surfaceId: 'win-7-top', top: 700, feet: { x: 1000, y: 700 } },
      sim.now()
    )
    expect(accepted).toBe(true)
    expect(sim.physics.isPlacing()).toBe(true)
    const mid = sim.physics.getSnapshot()
    expect(mid.grounded).toBe(false)
    expect(mid.airborne).toBe(false)

    // 过渡中不受重力：脚底向 700 方向移动（而不是往下掉到地面 961）。
    const during = sim.steps(6)
    expect(during.feet.y).toBeGreaterThan(300)
    expect(during.feet.y).toBeLessThan(700)

    const landed = sim.until((snapshot) => snapshot.grounded, 120)
    expect(landed.snapshot.surfaceId).toBe('win-7-top')
    expect(landed.snapshot.feet.y).toBe(700)
    expect(sim.physics.isPlacing()).toBe(false)
    expect(sim.physics.isAnchored()).toBe(false)
    // surface 模式走正常落地管线，不额外产生「站定完成」事件。
    expect(sim.physics.consumePlacementLanded()).toBe(false)
  })

  it('anchor 模式：滑到站定点后 grounded 且不再下落（忽略 moveTo / drop 指令）', () => {
    const sim = createSim({
      initialFeet: { x: 900, y: 300 },
      surfaces: [windowTopSurface({ id: 'win-7-top', top: 36, rect: { x: 600, y: 36, width: 800, height: 1 } })]
    })
    const accepted = sim.physics.beginPlacement(
      { mode: 'anchor', feet: { x: 960, y: 600 } },
      sim.now()
    )
    expect(accepted).toBe(true)
    const anchored = sim.until(() => sim.physics.isAnchored(), 120).snapshot
    expect(anchored.grounded).toBe(true)
    expect(anchored.surfaceId).toBeNull()
    expect(anchored.airborne).toBe(false)
    expect(anchored.feet).toEqual({ x: 960, y: 600 })
    // 站定完成一次性事件（B3 播落地姿态）。
    expect(sim.physics.consumePlacementLanded()).toBe(true)
    expect(sim.physics.consumePlacementLanded()).toBe(false)

    // 之后不管过多久、收到什么移动/落下指令，都停在原地（不随重力下落）。
    sim.physics.setCommand({ kind: 'moveTo', target: { x: 200, y: 200 }, speedPxPerSec: 200, mode: 'walk' })
    sim.steps(30)
    sim.physics.setCommand({ kind: 'sit', surfaceId: 'win-7-top' })
    sim.steps(30)
    sim.physics.setCommand({ kind: 'drop' })
    const after = sim.steps(120)
    expect(after.feet).toEqual({ x: 960, y: 600 })
    expect(after.grounded).toBe(true)
    expect(after.surfaceId).toBeNull()
  })

  it('站定可被再次拖拽解除（beginDrag 清除 anchored）', () => {
    const sim = createSim({ initialFeet: { x: 900, y: 300 } })
    sim.physics.beginPlacement({ mode: 'anchor', feet: { x: 900, y: 600 } }, sim.now())
    sim.until(() => sim.physics.isAnchored(), 120)
    expect(sim.physics.isAnchored()).toBe(true)
    sim.physics.beginDrag({ x: 900, y: 400 }, sim.now())
    expect(sim.physics.isAnchored()).toBe(false)
    expect(sim.physics.getDebugSnapshot().placement).toBe('none')
    expect(sim.physics.getDebugSnapshot().dragging).toBe(true)
  })

  it('拖拽中 / 目标非法 → beginPlacement 返回 false，不改变状态', () => {
    const sim = createSim({ initialFeet: { x: 900, y: 300 } })
    sim.physics.beginDrag({ x: 900, y: 300 }, sim.now())
    expect(
      sim.physics.beginPlacement({ mode: 'anchor', feet: { x: 900, y: 600 } }, sim.now())
    ).toBe(false)
    expect(sim.physics.getSnapshot().feet.y).toBe(300)

    const other = createSim()
    expect(
      other.physics.beginPlacement({ mode: 'surface', surfaceId: 'win-7-top', top: -10, feet: { x: 1, y: 1 } }, 0)
    ).toBe(false)
    expect(
      other.physics.beginPlacement({ mode: 'anchor', feet: { x: Number.NaN, y: 0 } }, 0)
    ).toBe(false)
  })

  it('debug 快照暴露放置状态（none / placing / anchored）', () => {
    const sim = createSim({ initialFeet: { x: 900, y: 300 } })
    expect(sim.physics.getDebugSnapshot().placement).toBe('none')
    sim.physics.beginPlacement({ mode: 'anchor', feet: { x: 900, y: 600 } }, sim.now())
    expect(sim.physics.getDebugSnapshot().placement).toBe('placing')
    sim.until(() => sim.physics.isAnchored(), 120)
    expect(sim.physics.getDebugSnapshot().placement).toBe('anchored')
    expect(sim.physics.getDebugSnapshot().mode).toBe('placed')
  })
})

describe('松手贴沿吸附（±4px 容差）与甩出回归', () => {
  it('松手时脚底距窗沿 ≤4px 且未甩出 → 直接吸附到窗沿', () => {
    const sim = createSim({
      initialFeet: { x: 1000, y: 703 },
      surfaces: [windowTopSurface({ id: 'win-7-top', top: 700, rect: { x: 600, y: 700, width: 800, height: 1 } })]
    })
    sim.physics.beginDrag({ x: 1000, y: 703 }, 0)
    sim.physics.endDrag(20)
    const after = sim.physics.getSnapshot()
    expect(after.grounded).toBe(true)
    expect(after.surfaceId).toBe('win-7-top')
    expect(after.feet.y).toBe(700)
  })

  it('距离 >4px 不误吸附（照常自由落体）', () => {
    const sim = createSim({
      initialFeet: { x: 1000, y: 707 },
      surfaces: [windowTopSurface({ id: 'win-7-top', top: 700, rect: { x: 600, y: 700, width: 800, height: 1 } })]
    })
    sim.physics.beginDrag({ x: 1000, y: 707 }, 0)
    sim.physics.endDrag(20)
    expect(sim.physics.getSnapshot().airborne).toBe(true)
    const landed = sim.until((snapshot) => snapshot.grounded, 200)
    expect(landed.snapshot.surfaceId).toBe(IMPLICIT_GROUND_SURFACE_ID)
  })

  it('快速甩出（竖直速度大）不触发贴沿吸附（回归：甩出仍按物理飞出）', () => {
    const sim = createSim({
      initialFeet: { x: 1000, y: 703 },
      surfaces: [windowTopSurface({ id: 'win-7-top', top: 700, rect: { x: 600, y: 700, width: 800, height: 1 } })]
    })
    sim.physics.beginDrag({ x: 1000, y: 703 }, 0)
    const result = sim.physics.endDrag(20, { x: 0, y: 900 })
    expect(result.throwVelocity.y).toBe(900)
    const after = sim.physics.getSnapshot()
    expect(after.airborne).toBe(true)
    expect(after.grounded).toBe(false)
  })
})

/* ========================================================================== */
/* snapOntoSurface（放置到可坐窗沿：直接吸附，无“先站一会儿”的中间态）            */
/* ========================================================================== */

describe('snapOntoSurface：直接吸附到窗沿', () => {
  const surface = windowTopSurface({ id: 'win-7-top', top: 700, rect: { x: 600, y: 700, width: 800, height: 1 } })

  it('立刻 grounded 到目标表面、速度清零、无过渡状态', () => {
    const sim = createSim({ initialFeet: { x: 900, y: 300 }, surfaces: [surface] })
    const accepted = sim.physics.snapOntoSurface('win-7-top', 700, { x: 1000, y: 700 })
    expect(accepted).toBe(true)
    const snapshot = sim.physics.getSnapshot()
    expect(snapshot.grounded).toBe(true)
    expect(snapshot.airborne).toBe(false)
    expect(snapshot.surfaceId).toBe('win-7-top')
    expect(snapshot.feet).toEqual({ x: 1000, y: 700 })
    expect(snapshot.velocity).toEqual({ x: 0, y: 0 })
    expect(sim.physics.isPlacing()).toBe(false)
    expect(sim.physics.isAnchored()).toBe(false)
    expect(sim.physics.getDebugSnapshot().mode).toBe('idle')
  })

  it('吸附后保持站立（不会被重力/移动指令带走），直到收到新指令', () => {
    const sim = createSim({ initialFeet: { x: 900, y: 300 }, surfaces: [surface] })
    sim.physics.snapOntoSurface('win-7-top', 700, { x: 1000, y: 700 })
    const after = sim.steps(60)
    expect(after.feet).toEqual({ x: 1000, y: 700 })
    expect(after.grounded).toBe(true)
    expect(after.surfaceId).toBe('win-7-top')
  })

  it('非法参数 / top 不在 workArea 内 → false，状态不变', () => {
    const sim = createSim({ initialFeet: { x: 900, y: 300 }, surfaces: [surface] })
    expect(sim.physics.snapOntoSurface('', 700, { x: 1, y: 700 })).toBe(false)
    expect(sim.physics.snapOntoSurface('win-7-top', Number.NaN, { x: 1, y: 700 })).toBe(false)
    expect(sim.physics.snapOntoSurface('win-7-top', -10, { x: 1, y: -10 })).toBe(false)
    expect(sim.physics.snapOntoSurface('win-7-top', 700, { x: Number.NaN, y: 700 })).toBe(false)
    expect(sim.physics.getSnapshot().feet.y).toBe(300)
  })
})
