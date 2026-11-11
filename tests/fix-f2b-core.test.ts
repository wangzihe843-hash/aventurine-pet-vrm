/**
 * F2b 集成层修复回归（core 集成层）：
 * - H-3b 契约侧：PetRuntime.frame() 把 `motionLimits` 注入 BehaviorInput；
 * - N-4 接线：frame() 把 petSize.width 传给可见性过滤（窄可见条不可坐）；
 * - 02-L5：updateEnvironment() 后刷新 lastMotion/previousMotion（不再旧一帧）；
 * - 02 N-4：EMPTY_INTERACTION 冻结为只读共享常量。
 *
 * 说明：本文件只 import core/behavior/physics/desktop 纯逻辑（无 DOM/three/Electron），node 环境可直接跑。
 */
import type { DisplayInfo, PetConfig, Rect } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'

import {
  computeMotionLimits,
  EMPTY_INTERACTION,
  PetRuntime,
  type PetRuntimeEnvironment
} from '../src/renderer/src/core/pet-runtime'
import type {
  BehaviorInput,
  DesktopSnapshot,
  DesktopSurface,
  InteractionSnapshot,
  Point2D,
  PetSize
} from '../src/renderer/src/core/wave2-contract'

const DISPLAY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 30, width: 1920, height: 961 },
  scaleFactor: 1,
  isPrimary: true
}

/** 最小 PetConfig（集成层只读取 behavior 子集，其余字段不参与本文件断言）。 */
const CONFIG = {
  autonomous: false,
  autonomousLevel: 'normal',
  mischief: false,
  dshLink: false
} as unknown as PetConfig

function makeEnv(
  overrides: Partial<{
    workArea: Rect
    petSize: PetSize
    viewport: PetSize
  }> = {}
): PetRuntimeEnvironment {
  return {
    workArea: overrides.workArea ?? { x: 0, y: 0, width: 1920, height: 961 },
    petSize: overrides.petSize ?? { width: 300, height: 540 },
    viewport: overrides.viewport ?? { width: 1920, height: 961 },
    overlayOrigin: { x: 0, y: 0 },
    display: DISPLAY
  }
}

function createRuntime(env: PetRuntimeEnvironment = makeEnv(), initialFeet?: Point2D): PetRuntime {
  return new PetRuntime({ env, config: CONFIG, random: () => 0.5, initialFeet })
}

function frameInput(nowMs: number, dt = 0) {
  return { nowMs, dt, interaction: EMPTY_INTERACTION, events: [], bubbleText: null }
}

function surface(id: string, width: number, top = 800): DesktopSurface {
  return {
    id,
    kind: 'window-top',
    rect: { x: 0, y: top, width, height: 1 },
    top,
    windowId: 1,
    sittable: true,
    climbable: true
  }
}

describe('computeMotionLimits：B2 可达水平区间（H-3b 契约侧）', () => {
  it('workArea 原点为 0：minX/maxX = x ± halfW', () => {
    expect(
      computeMotionLimits({ x: 0, y: 0, width: 1920, height: 961 }, { width: 300, height: 540 })
    ).toEqual({ minX: 150, maxX: 1770 })
  })

  it('workArea 原点非 0 时整体平移（窗口本地坐标不假设原点为 0）', () => {
    expect(
      computeMotionLimits({ x: 100, y: 0, width: 1600, height: 900 }, { width: 400, height: 540 })
    ).toEqual({ minX: 300, maxX: 1500 })
  })

  it('宠物宽 <= 0/非法 或 workArea 非法 → undefined（不传字段 = 保持旧行为）', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 961 }
    for (const bad of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeMotionLimits(workArea, { width: bad, height: 540 })).toBeUndefined()
    }
    expect(computeMotionLimits(workArea, null as unknown as PetSize)).toBeUndefined()
    const badWorkArea = { x: Number.NaN, y: 0, width: 1920, height: 961 }
    expect(computeMotionLimits(badWorkArea, { width: 300, height: 540 })).toBeUndefined()
    expect(computeMotionLimits(null as unknown as Rect, { width: 300, height: 540 })).toBeUndefined()
  })

  it('宠物比 workArea 还宽（minX > maxX）→ undefined（B2 会退化为中线）', () => {
    expect(
      computeMotionLimits({ x: 0, y: 0, width: 300, height: 961 }, { width: 400, height: 540 })
    ).toBeUndefined()
  })

  it('宠物恰好与 workArea 等宽 → 退化为单点区间仍有效', () => {
    expect(
      computeMotionLimits({ x: 0, y: 0, width: 300, height: 961 }, { width: 300, height: 540 })
    ).toEqual({ minX: 150, maxX: 150 })
  })
})

describe('PetRuntime.frame：motionLimits 注入 BehaviorInput（H-3b）', () => {
  it('正常尺寸：motionLimits 依 workArea + petSize.width 计算传入', () => {
    const runtime = createRuntime(makeEnv())
    const spy = vi.spyOn(runtime.behaviorDirector, 'update')
    runtime.frame(frameInput(16, 0.016))
    expect(spy).toHaveBeenCalledTimes(1)
    const input = spy.mock.calls[0]![0] as BehaviorInput
    expect(input.motionLimits).toEqual({ minX: 150, maxX: 1770 })
  })

  it('petSize 非法/宽度 <= 0 → 不传 motionLimits 字段（B1 按 workArea 全宽兜底）', () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const runtime = createRuntime(makeEnv({ petSize: { width, height: 540 } }))
      const spy = vi.spyOn(runtime.behaviorDirector, 'update')
      runtime.frame(frameInput(16, 0.016))
      const input = spy.mock.calls[0]![0] as BehaviorInput
      expect('motionLimits' in input).toBe(false)
      expect(input.motionLimits).toBeUndefined()
    }
  })
})

describe('PetRuntime.frame：N-4 窄可见条过滤接线（传 petSize.width）', () => {
  it('40px 可见段 sittable=false、600px 段保留（B1 收到的 desktop 已过滤）', () => {
    const runtime = createRuntime(makeEnv({ petSize: { width: 398, height: 540 } }))
    const snapshot: DesktopSnapshot = {
      surfaces: [surface('win-narrow-top', 40), surface('win-wide-top', 600)],
      transitions: [],
      workArea: { x: 0, y: 0, width: 1920, height: 961 },
      screenBounds: { x: 0, y: 0, width: 1920, height: 1080 }
    }
    vi.spyOn(runtime.desktopSensor, 'snapshot').mockReturnValue(snapshot)
    const spy = vi.spyOn(runtime.behaviorDirector, 'update')
    runtime.frame(frameInput(16, 0))
    const input = spy.mock.calls[0]![0] as BehaviorInput
    expect(input.desktop.surfaces[0]!.sittable).toBe(false)
    expect(input.desktop.surfaces[1]!.sittable).toBe(true)
  })

  it('petSize.width 缺失/非法时不按宽度过滤（保持旧语义）', () => {
    const runtime = createRuntime(makeEnv({ petSize: { width: Number.NaN, height: 540 } }))
    const snapshot: DesktopSnapshot = {
      surfaces: [surface('win-narrow-top', 40)],
      transitions: [],
      workArea: { x: 0, y: 0, width: 1920, height: 961 },
      screenBounds: { x: 0, y: 0, width: 1920, height: 1080 }
    }
    vi.spyOn(runtime.desktopSensor, 'snapshot').mockReturnValue(snapshot)
    const spy = vi.spyOn(runtime.behaviorDirector, 'update')
    runtime.frame(frameInput(16, 0))
    const input = spy.mock.calls[0]![0] as BehaviorInput
    expect(input.desktop.surfaces[0]!.sittable).toBe(true)
  })
})

describe('PetRuntime.updateEnvironment：刷新 lastMotion/previousMotion（02-L5）', () => {
  it('环境变矮后物理已落地：runtime.motion 立刻反映新快照（不再旧一帧）', () => {
    const runtime = createRuntime(makeEnv(), { x: 960, y: 900 })
    runtime.frame(frameInput(16, 0.016))
    expect(runtime.motion.airborne).toBe(true)
    expect(runtime.motion.feet.y).toBeLessThan(961)

    runtime.updateEnvironment(makeEnv({ workArea: { x: 0, y: 0, width: 1920, height: 700 } }))
    // setEnvironment 已把 feet clamp 到新地面并落地；lastMotion 必须同步刷新
    expect(runtime.motion.feet.y).toBe(700)
    expect(runtime.motion.grounded).toBe(true)
    expect(runtime.motion.airborne).toBe(false)
  })

  it('刷新后下一帧不把「环境钳制导致的落地」误报为 landed 事件', () => {
    const runtime = createRuntime(makeEnv(), { x: 960, y: 900 })
    runtime.frame(frameInput(16, 0.016))
    runtime.updateEnvironment(makeEnv({ workArea: { x: 0, y: 0, width: 1920, height: 700 } }))
    const out = runtime.frame(frameInput(32, 0))
    expect(out.animation.events.some((event) => event.kind === 'landed')).toBe(false)
  })
})

describe('EMPTY_INTERACTION：只读共享常量（02 N-4）', () => {
  it('已冻结（运行时误改抛 TypeError），字段语义不变', () => {
    expect(Object.isFrozen(EMPTY_INTERACTION)).toBe(true)
    expect(EMPTY_INTERACTION).toEqual({
      pointer: null,
      hoveringPet: false,
      dragging: false,
      patProgress: 0
    })
    expect(() => {
      ;(EMPTY_INTERACTION as { dragging: boolean }).dragging = true
    }).toThrow(TypeError)
  })

  it('可安全展开成新快照（调用方不应就地修改共享常量）', () => {
    const snapshot: InteractionSnapshot = { ...EMPTY_INTERACTION, dragging: true }
    expect(snapshot.dragging).toBe(true)
    expect(EMPTY_INTERACTION.dragging).toBe(false)
  })
})
