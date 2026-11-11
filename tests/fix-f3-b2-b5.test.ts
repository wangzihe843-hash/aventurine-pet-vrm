/**
 * 修复轮 F3 回归：B2 物理（H-4 残余 / D6a 段 id 抖动）+ B5 桌面（N-5 宽限期可坐性）。
 *
 * 与 review-w2vrm/behavior 的只读复现（P2 / D6a-1 / D6a-2）同构，但断言**修复后**行为：
 * - P2：站窗口上沿时窗口被拖到屏幕外（本地 top=-80）→ 下一帧 airborne，feet.y 不写负值，
 *   最终 grounded 在屏幕内地面，petRect 不整体在视口上方；
 * - D6a-1：前层窗口把顶边切成两段（旧 id 改指左段）→ 站在右段的宠物保持 grounded，
 *   surfaceId 更新为右段新 id；
 * - D6a-2：遮挡解除段合并（旧 id 消失）→ 宠物保持 grounded，surfaceId 更新为合并段 id；
 * - N-5：宽限期内窗口顶边几何保留但 sittable=false（B1 不会选它作为新坐目标）。
 *
 * 纯逻辑（B5 DesktopSensor + B2 PetPhysics），无 Electron/DOM 依赖。
 */
import { describe, expect, it } from 'vitest'

import type { DisplayInfo, Rect, WindowInfo } from '../src/shared/types'
import { DesktopSensor } from '../src/renderer/src/desktop'
import { PetPhysics } from '../src/renderer/src/physics'
import type { DesktopSurface, MotionSnapshot } from '../src/renderer/src/core/wave2-contract'

/** 1600×900 主屏，overlay 原点 (0,0)（与审查复现同口径，方便数值对照）。 */
const DISPLAY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1600, height: 900 },
  workArea: { x: 0, y: 0, width: 1600, height: 900 },
  scaleFactor: 1,
  isPrimary: true
}
const WA: Rect = { x: 0, y: 0, width: 1600, height: 900 }
/** VRM 迁移期宠物尺寸（540 高 × 0.7373 宽高比 ≈ 398.1）。 */
const PET_SIZE = { width: 540 * 0.7373, height: 540 }
const DT = 1 / 30

function log(label: string, value: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[FIX-F3] ${label}:`, JSON.stringify(value))
}

function makeWindow(id: number, bounds: Rect): WindowInfo {
  return {
    id,
    pid: 100,
    owner: `app-${id}`,
    layer: 0,
    alpha: 1,
    bounds: { ...bounds },
    onScreen: true
  }
}

function createSensor(): DesktopSensor {
  const sensor = new DesktopSensor()
  sensor.updateEnvironment({
    overlayOrigin: { x: 0, y: 0 },
    display: DISPLAY,
    viewport: { width: 1600, height: 900 },
    ownPid: 999
  })
  return sensor
}

function createPhysics(surfaces: readonly DesktopSurface[], feet: { x: number; y: number }): PetPhysics {
  return new PetPhysics({
    workArea: WA,
    petSize: PET_SIZE,
    initialFeet: feet,
    surfaces
  })
}

function stepUntilGrounded(
  physics: PetPhysics,
  nowStartMs: number,
  maxSteps = 240
): { snapshot: MotionSnapshot; steps: number } {
  let snapshot = physics.getSnapshot()
  let steps = 0
  while (!snapshot.grounded && steps < maxSteps) {
    snapshot = physics.step(DT, nowStartMs + (steps + 1) * DT * 1000)
    steps += 1
  }
  return { snapshot, steps }
}

describe('F3：B2 H-4 残余（支撑面移出 workArea）', () => {
  it('P2：窗口被拖到屏幕上方（top=-80）→ airborne，feet 不写负值，最终落在屏幕内地面', () => {
    const sensor = createSensor()
    const win = makeWindow(2, { x: 200, y: 500, width: 900, height: 300 })
    sensor.updateWindows([win], 0)
    const snapBefore = sensor.snapshot(0)
    const physics = createPhysics(snapBefore.surfaces, { x: 800, y: 500 })
    const before = physics.getSnapshot()
    expect(before.grounded).toBe(true)
    expect(before.surfaceId).toBe('win-2-top')

    // 窗口被拖出屏幕上方：全局 y=-80 → overlay 本地 top=-80
    sensor.updateWindows([makeWindow(2, { x: 200, y: -80, width: 900, height: 300 })], 1000)
    const snapAfter = sensor.snapshot(1000)
    physics.setEnvironment({ workArea: WA, petSize: PET_SIZE, surfaces: snapAfter.surfaces })
    physics.setCommand({ kind: 'hold' })
    const afterEnv = physics.getSnapshot()
    const afterOneStep = physics.step(DT, 1033)
    const landed = stepUntilGrounded(physics, 1033)
    const beforeRectTop = before.feet.y - PET_SIZE.height
    const afterRectTop = afterEnv.feet.y - PET_SIZE.height
    const landedRectTop = landed.snapshot.feet.y - PET_SIZE.height
    log('P2', {
      before: { feet: before.feet, grounded: before.grounded, petRectTop: beforeRectTop },
      afterSetEnvironment: {
        feet: afterEnv.feet,
        grounded: afterEnv.grounded,
        airborne: afterEnv.airborne,
        surfaceId: afterEnv.surfaceId,
        petRectTop: afterRectTop
      },
      afterOneStep: { airborne: afterOneStep.airborne, feet: afterOneStep.feet },
      landed: {
        feet: landed.snapshot.feet,
        grounded: landed.snapshot.grounded,
        surfaceId: landed.snapshot.surfaceId,
        steps: landed.steps,
        petRectTop: landedRectTop
      },
      oldBugReference: { feetY: -80, petRectTop: -620 }
    })
    expect(afterEnv.grounded).toBe(false)
    expect(afterEnv.airborne).toBe(true)
    // 修复前：feet.y=-80（petRectTop=-620 整只出画）；修复后保持原站立高度，不写视口外负值。
    expect(afterEnv.feet.y).toBe(500)
    expect(afterOneStep.airborne).toBe(true)
    expect(landed.snapshot.grounded).toBe(true)
    expect(landed.snapshot.surfaceId).toBe('screen-bottom')
    expect(landed.snapshot.feet.y).toBe(900) // workArea 底边（屏幕内）
    expect(landedRectTop).toBeGreaterThanOrEqual(0)
  })
})

describe('F3：B2 D6a 段 id 抖动（遮挡裁剪）', () => {
  it('D6a-1：顶边被切成两段（旧 id 改指左段）→ 站在右段仍 grounded，surfaceId 更新', () => {
    const sensor = createSensor()
    const A = makeWindow(1, { x: 200, y: 500, width: 1000, height: 300 })
    const C = makeWindow(2, { x: 700, y: 100, width: 200, height: 600 }) // 前层，盖住 A 顶边 x=700..900
    sensor.updateWindows([A], 0)
    const snap1 = sensor.snapshot(0)
    const physics = createPhysics(snap1.surfaces, { x: 1000, y: 500 })
    const before = physics.getSnapshot()
    expect(before.grounded).toBe(true)
    expect(before.surfaceId).toBe('win-1-top')

    sensor.updateWindows([C, A], 1000)
    const snap2 = sensor.snapshot(1000)
    const aTops = snap2.surfaces.filter(
      (surface) => surface.kind === 'window-top' && surface.windowId === 1
    )
    physics.setEnvironment({ workArea: WA, petSize: PET_SIZE, surfaces: snap2.surfaces })
    physics.setCommand({ kind: 'hold' })
    const afterEnv = physics.getSnapshot()
    // 保持站立 30 帧（约 1s）不落地
    let last = afterEnv
    for (let index = 0; index < 30; index += 1) last = physics.step(DT, 1000 + index * 33)
    log('D6a-1', {
      before: { surfaceId: before.surfaceId, feet: before.feet },
      splitSegments: aTops.map((surface) => ({
        id: surface.id,
        x: surface.rect.x,
        width: surface.rect.width,
        coversPetX: surface.rect.x <= 1000 && surface.rect.x + surface.rect.width >= 1000
      })),
      afterSetEnvironment: {
        grounded: afterEnv.grounded,
        airborne: afterEnv.airborne,
        surfaceId: afterEnv.surfaceId,
        feet: afterEnv.feet
      },
      after30Frames: { grounded: last.grounded, surfaceId: last.surfaceId, feet: last.feet }
    })
    expect(aTops).toHaveLength(2)
    expect(afterEnv.grounded).toBe(true)
    expect(afterEnv.airborne).toBe(false)
    expect(afterEnv.surfaceId).toBe('win-1-top-1') // 重匹配到覆盖脚底的右段新 id
    expect(afterEnv.feet).toEqual({ x: 1000, y: 500 })
    expect(last.grounded).toBe(true)
  })

  it('D6a-2：遮挡解除段合并（旧 id 消失）→ 仍 grounded，surfaceId 更新为合并段', () => {
    const sensor = createSensor()
    const A = makeWindow(1, { x: 200, y: 500, width: 1000, height: 300 })
    const C = makeWindow(2, { x: 700, y: 100, width: 200, height: 600 })
    sensor.updateWindows([C, A], 0)
    const snapSplit = sensor.snapshot(0)
    const physics = createPhysics(snapSplit.surfaces, { x: 1000, y: 500 })
    const before = physics.getSnapshot()
    expect(before.grounded).toBe(true)
    expect(before.surfaceId).toBe('win-1-top-1')

    sensor.updateWindows([A], 1000) // C 关闭（进入宽限期）→ A 顶边整段可见，单段 id=win-1-top
    const snapMerged = sensor.snapshot(1000)
    physics.setEnvironment({ workArea: WA, petSize: PET_SIZE, surfaces: snapMerged.surfaces })
    physics.setCommand({ kind: 'hold' })
    const afterEnv = physics.getSnapshot()
    let last = afterEnv
    for (let index = 0; index < 30; index += 1) last = physics.step(DT, 1000 + index * 33)
    log('D6a-2', {
      before: { surfaceId: before.surfaceId },
      mergedSegments: snapMerged.surfaces
        .filter((surface) => surface.kind === 'window-top' && surface.windowId === 1)
        .map((surface) => ({ id: surface.id, x: surface.rect.x, width: surface.rect.width })),
      afterSetEnvironment: {
        grounded: afterEnv.grounded,
        airborne: afterEnv.airborne,
        surfaceId: afterEnv.surfaceId
      },
      after30Frames: { grounded: last.grounded, surfaceId: last.surfaceId, feet: last.feet }
    })
    expect(afterEnv.grounded).toBe(true)
    expect(afterEnv.surfaceId).toBe('win-1-top') // 旧 id `win-1-top-1` 消失 → 重匹配到合并段
    expect(afterEnv.feet).toEqual({ x: 1000, y: 500 })
    expect(last.grounded).toBe(true)
  })
})

describe('F3：B5 N-5 宽限期窗口顶边不可坐', () => {
  it('宽限期内 window-top 几何保留但 sittable=false，恢复可见后重新可坐', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42, { x: 100, y: 130, width: 800, height: 600 })], 0)
    const visible = sensor.snapshot(0)
    const visibleTop = visible.surfaces.find((surface) => surface.id === 'win-42-top')
    expect(visibleTop?.sittable).toBe(true)

    sensor.updateWindows([], 1000) // 最小化/切 Space → 宽限期
    const during = sensor.snapshot(1000)
    const graceTop = during.surfaces.find((surface) => surface.id === 'win-42-top')
    expect(graceTop).toBeDefined()
    expect(graceTop!.top).toBe(130) // 几何仍在（B2 支撑用；overlay 原点 (0,0) → 本地 y=全局 y）
    expect(graceTop!.sittable).toBe(false)
    expect(sensor.findSittableSurface({ x: 500, y: 130 }, PET_SIZE)).toBeNull()

    sensor.updateWindows([makeWindow(42, { x: 100, y: 130, width: 800, height: 600 })], 1200)
    const back = sensor.snapshot(1200)
    expect(back.surfaces.find((surface) => surface.id === 'win-42-top')?.sittable).toBe(true)
    expect(sensor.findSittableSurface({ x: 500, y: 130 }, PET_SIZE)?.id).toBe('win-42-top')
  })
})
