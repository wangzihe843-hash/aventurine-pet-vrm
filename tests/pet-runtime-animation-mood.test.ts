import { describe, expect, it } from 'vitest'

import type { DisplayInfo, PetConfig, WindowInfo } from '@shared/types'

import {
  animationMoodFor,
  buildSitWindowStyleCandidates,
  EMPTY_INTERACTION,
  facingForAnimation,
  isGroundedOnSittableWindowTop,
  isMovingMood,
  PetRuntime,
  pickNextSitWindowStyle,
  SIT_LIE_CLIP_ID,
  SIT_LIE_HEADROOM_RATIO,
  SIT_STYLE_ROTATE_MS,
  SIT_VARIANT_CLIP_ID,
  WINDOW_TOP_RECUMBENT_MOODS,
  type PetRuntimeEnvironment
} from '../src/renderer/src/core/pet-runtime'
import type {
  BehaviorDecision,
  DesktopSnapshot,
  DesktopSurface,
  InteractionSnapshot,
  MotionSnapshot,
  PetMood
} from '../src/renderer/src/core/wave2-contract'
import { DRAG_START_FACING } from '../src/renderer/src/physics'

/**
 * Wave 2.5：坐姿接近阶段的动画 mood 修正。
 *
 * B1 的 sit activity 从接近阶段就下发 mood='sit'（行为语义），但动画层如果照搬会出现
 * 「保持坐姿滑向窗口顶部」的画面。集成层在动画输入里把接近阶段改成 walk/climb：
 * - 水平接近 → walk（有 VMD walk 时播放真实步态）
 * - 垂直接近 → climb（回退 B3 爬行姿态）
 * - 落座后（grounded）→ 仍然是 sit（VMD 坐姿）
 *
 * V7 追加：`isMovingMood` / `facingForAnimation`（移动类 mood 侧身朝运动方向、拖拽起手
 * 兜底侧向、静止回 front）的纯逻辑单测 + `PetRuntime.frame()` 的拖拽/落地朝向集成断言。
 */
function motion(overrides: Partial<MotionSnapshot> = {}): MotionSnapshot {
  return {
    feet: { x: 800, y: 600 },
    velocity: { x: 0, y: 0 },
    facing: 'front',
    grounded: true,
    surfaceId: 'dock-bottom',
    airborne: false,
    ...overrides
  }
}

function decision(
  mood: BehaviorDecision['mood'],
  command: BehaviorDecision['motion'] = { kind: 'hold' }
): BehaviorDecision {
  return {
    mood,
    motion: command,
    facing: 'front',
    lookTarget: null,
    bubble: null,
    poseHint: undefined
  }
}

describe('animationMoodFor：坐姿接近阶段动画 mood', () => {
  it('sit 接近（水平移动）→ walk', () => {
    const d = decision('sit', { kind: 'sit', surfaceId: 'win-1-top' })
    const m = motion({
      grounded: false,
      surfaceId: null,
      velocity: { x: 120, y: 4 }
    })
    expect(animationMoodFor(d, m)).toBe('walk')
  })

  it('sit 接近（垂直为主）→ walk（爬窗行为已按用户要求移除，不再回退举臂 climb 姿态）', () => {
    const d = decision('sit', { kind: 'sit', surfaceId: 'win-1-top' })
    const m = motion({
      grounded: false,
      surfaceId: null,
      velocity: { x: 20, y: -180 }
    })
    expect(animationMoodFor(d, m)).toBe('walk')
  })

  it('落座（grounded）后仍是 sit', () => {
    const d = decision('sit', { kind: 'hold' })
    const m = motion({ grounded: true, surfaceId: 'win-1-top', velocity: { x: 0, y: 0 } })
    expect(animationMoodFor(d, m)).toBe('sit')
  })

  it('sit 指令但 grounded=false 且速度为零 → 退化为 walk（不假装已落座）', () => {
    const d = decision('sit', { kind: 'sit', surfaceId: 'dock' })
    const m = motion({ grounded: false, surfaceId: null, velocity: { x: 0, y: 0 } })
    expect(animationMoodFor(d, m)).toBe('walk')
  })

  it('非 sit 决策不受影响（idle/walk/pat/drag/fall 原样返回）', () => {
    for (const mood of ['idle', 'walk', 'pat', 'drag', 'fall', 'dshDone'] as const) {
      expect(animationMoodFor(decision(mood), motion())).toBe(mood)
    }
  })

  it('hold 指令的 sit（已落座）不触发接近覆盖', () => {
    const d = decision('sit', { kind: 'hold' })
    // 即便瞬时 grounded=false（例如刚被放置），只要不是 sit 指令就不覆盖
    const m = motion({ grounded: false, surfaceId: null, velocity: { x: 100, y: 0 } })
    expect(animationMoodFor(d, m)).toBe('sit')
  })
})

/* ========================================================================== */
/* V7：facing 映射（移动类 mood 侧身 / 拖拽起手兜底 / 静止回 front）             */
/* ========================================================================== */

describe('V7：isMovingMood / facingForAnimation', () => {
  it('isMovingMood：walk/climb/fall/drag/grabWindow 为移动类，其余不是', () => {
    for (const mood of ['walk', 'climb', 'fall', 'drag', 'grabWindow'] as const) {
      expect(isMovingMood(mood)).toBe(true)
    }
    for (const mood of ['idle', 'sit', 'sleep', 'pat', 'dshBusy', 'dshDone', 'dshError'] as const) {
      expect(isMovingMood(mood)).toBe(false)
    }
  })

  it('移动类 mood → 朝运动方向；静止/坐/摸头 → front', () => {
    expect(facingForAnimation('walk', motion({ facing: 'right' }), false)).toBe('right')
    expect(facingForAnimation('fall', motion({ facing: 'left' }), false)).toBe('left')
    expect(facingForAnimation('climb', motion({ facing: 'right' }), false)).toBe('right')
    expect(facingForAnimation('idle', motion({ facing: 'right' }), false)).toBe('front')
    expect(facingForAnimation('sit', motion({ facing: 'left' }), false)).toBe('front')
    expect(facingForAnimation('pat', motion({ facing: 'right' }), false)).toBe('front')
    expect(facingForAnimation('dshDone', motion({ facing: 'left' }), false)).toBe('front')
  })

  it('拖拽起手兜底：mood=drag 且 motion.facing 仍是 front（B2 未及时切向）→ 默认侧向', () => {
    expect(facingForAnimation('drag', motion({ facing: 'front' }), true)).toBe(DRAG_START_FACING)
    expect(DRAG_START_FACING).toBe('right')
    // 非拖拽时移动类拿到 front（极端兜底）保持 front，不无中生有侧身。
    expect(facingForAnimation('walk', motion({ facing: 'front' }), false)).toBe('front')
    // 已侧身则保留（拖拽中水平移动仍优先运动方向）。
    expect(facingForAnimation('drag', motion({ facing: 'left' }), true)).toBe('left')
  })
})

describe('V7：PetRuntime.frame 拖拽/落地朝向（集成）', () => {
  const DISPLAY: DisplayInfo = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 30, width: 1920, height: 961 },
    scaleFactor: 1,
    isPrimary: true
  }
  const CONFIG = {
    autonomous: false,
    autonomousLevel: 'normal',
    mischief: false,
    dshLink: false
  } as unknown as PetConfig
  const env: PetRuntimeEnvironment = {
    workArea: { x: 0, y: 0, width: 1920, height: 961 },
    // VRM humanoid：540px 高 × bodyAspectRatio 0.30 ≈ 162 宽。
    petSize: { width: 162, height: 540 },
    viewport: { width: 1920, height: 961 },
    overlayOrigin: { x: 0, y: 0 },
    display: DISPLAY
  }
  const feet = { x: 960, y: 961 }

  function dragInteraction(): InteractionSnapshot {
    return { pointer: { x: 960, y: 700 }, hoveringPet: true, dragging: true, patProgress: 0 }
  }

  it('dragStart：frame 输出侧向 facing（不再正面朝镜头），animation.facing 同步', () => {
    const runtime = new PetRuntime({ env, config: CONFIG, initialFeet: feet })
    const idleFrame = runtime.frame({
      nowMs: 16,
      dt: 0.016,
      interaction: EMPTY_INTERACTION,
      events: [],
      bubbleText: null
    })
    expect(idleFrame.facing).toBe('front')

    // main.ts 在事件当帧先 beginDrag（不等下一帧），再 frame。
    runtime.beginDrag({ x: 960, y: 700 }, 16)
    const dragFrame = runtime.frame({
      nowMs: 32,
      dt: 0.016,
      interaction: dragInteraction(),
      events: [{ kind: 'dragStart', pointer: { x: 960, y: 700 } }],
      bubbleText: null
    })
    expect(dragFrame.animation.mood).toBe('drag')
    expect(dragFrame.facing).toBe(DRAG_START_FACING)
    expect(dragFrame.animation.facing).toBe(dragFrame.facing)
  })

  it('拖拽→松手→落地→静止后 facing 自然回 front（行为层恢复，不在物理层硬重置）', () => {
    const runtime = new PetRuntime({ env, config: CONFIG, initialFeet: feet })
    // 拎到空中：起手 + 向上/向右拖。
    runtime.beginDrag({ x: 960, y: 961 }, 0)
    let now = 0
    let out = runtime.frame({
      nowMs: 16,
      dt: 0.016,
      interaction: dragInteraction(),
      events: [{ kind: 'dragStart', pointer: { x: 960, y: 961 } }],
      bubbleText: null
    })
    expect(out.animation.mood).toBe('drag')
    expect(out.facing).toBe(DRAG_START_FACING)
    for (let index = 0; index < 40; index += 1) {
      now += 16
      runtime.dragTo({ x: 1100 + index * 2, y: 500 }, now)
      out = runtime.frame({
        nowMs: now,
        dt: 0.016,
        interaction: dragInteraction(),
        events: [],
        bubbleText: null
      })
    }
    expect(out.motion.airborne).toBe(false)
    expect(out.motion.grounded).toBe(false)

    // 松手 → 自由落体到地面。
    runtime.endDrag(now)
    for (let index = 0; index < 200; index += 1) {
      now += 16
      out = runtime.frame({
        nowMs: now,
        dt: 0.016,
        interaction: EMPTY_INTERACTION,
        events: [],
        bubbleText: null
      })
      if (out.motion.grounded) break
    }
    expect(out.motion.grounded).toBe(true)
    // 落地后（静止 idle）facing 回正面朝镜头；物理层 motion.facing 仍保留侧向即可。
    for (let index = 0; index < 120; index += 1) {
      now += 16
      out = runtime.frame({
        nowMs: now,
        dt: 0.016,
        interaction: EMPTY_INTERACTION,
        events: [],
        bubbleText: null
      })
      if (out.animation.mood === 'idle') break
    }
    expect(out.animation.mood).toBe('idle')
    expect(out.facing).toBe('front')
  })
})

/* ========================================================================== */
/* Bug B（2026-11-10）：可坐窗口上沿「卧姿」安全网 + 风格候选/轮换纯函数          */
/* ========================================================================== */

/** 可坐窗口上沿（本地坐标，对应实机 Finder 可见段）。 */
function windowTopSurface(overrides: Partial<DesktopSurface> = {}): DesktopSurface {
  return {
    id: 'win-1-top',
    kind: 'window-top',
    rect: { x: 600, y: 324, width: 700, height: 1 },
    top: 324,
    windowId: 1,
    sittable: true,
    climbable: false,
    ...overrides
  }
}

function desktopSnapshot(surfaces: DesktopSurface[]): DesktopSnapshot {
  return {
    surfaces,
    transitions: [],
    workArea: { x: 0, y: 0, width: 1920, height: 961 },
    screenBounds: { x: 0, y: 0, width: 1920, height: 1080 }
  }
}

describe('animationMoodFor：可坐窗沿卧姿安全网（Bug B / Lead 决策 §4.2-B）', () => {
  const onLedge = motion({ grounded: true, surfaceId: 'win-1-top', airborne: false })

  it('OnLedge：idle/walk/climb/pat/grabWindow/DSH 等非 recumbent 动画 mood → 强制 sit', () => {
    for (const mood of [
      'idle',
      'walk',
      'climb',
      'pat',
      'grabWindow',
      'dshBusy',
      'dshDone',
      'dshError'
    ] as const) {
      expect(animationMoodFor(decision(mood), onLedge, true)).toBe('sit')
    }
  })

  it('recumbent mood（sit/sleep）原样保留（sleep 也是躺姿，不算站立）', () => {
    expect(WINDOW_TOP_RECUMBENT_MOODS.has('sit')).toBe(true)
    expect(WINDOW_TOP_RECUMBENT_MOODS.has('sleep')).toBe(true)
    expect(WINDOW_TOP_RECUMBENT_MOODS.has('idle')).toBe(false)
    expect(animationMoodFor(decision('sit'), onLedge, true)).toBe('sit')
    expect(animationMoodFor(decision('sleep'), onLedge, true)).toBe('sleep')
  })

  it('drag/fall 不被压（拖拽、坠落姿态属物理/交互优先级，照常播放）', () => {
    expect(animationMoodFor(decision('drag'), onLedge, true)).toBe('drag')
    expect(animationMoodFor(decision('fall'), onLedge, true)).toBe('fall')
  })

  it('airborne=true 不被压（空中/落地受击瞬间照常播放 fall/idle 兜底）', () => {
    const airborne = motion({ grounded: true, surfaceId: 'win-1-top', airborne: true })
    expect(animationMoodFor(decision('fall'), airborne, true)).toBe('fall')
    expect(animationMoodFor(decision('idle'), airborne, true)).toBe('idle')
  })

  it('不在窗沿（第 3 参默认 false，向后兼容）→ 输出与旧行为完全一致', () => {
    for (const mood of ['idle', 'walk', 'pat', 'dshDone'] as const) {
      expect(animationMoodFor(decision(mood), onLedge)).toBe(mood)
      expect(animationMoodFor(decision(mood), onLedge, false)).toBe(mood)
    }
  })

  it('sit-approach（grounded=false）→ 仍是 walk：接近覆盖优先于安全网', () => {
    const approach = motion({
      grounded: false,
      surfaceId: null,
      velocity: { x: 120, y: 4 }
    })
    const d = decision('sit', { kind: 'sit', surfaceId: 'win-1-top' })
    expect(animationMoodFor(d, approach, true)).toBe('walk')
  })
})

describe('isGroundedOnSittableWindowTop（与 B1 同一套过滤后快照判定）', () => {
  const ledgeMotion = motion({ grounded: true, surfaceId: 'win-1-top' })

  it('grounded + 表面 id 命中可坐 window-top → true', () => {
    expect(isGroundedOnSittableWindowTop(ledgeMotion, desktopSnapshot([windowTopSurface()]))).toBe(
      true
    )
  })

  it('grounded=false（拖拽/空中/落地过程）→ false', () => {
    const airborne = motion({ grounded: false, surfaceId: 'win-1-top' })
    expect(isGroundedOnSittableWindowTop(airborne, desktopSnapshot([windowTopSurface()]))).toBe(
      false
    )
  })

  it('surfaceId 缺失（null / 非字符串）→ false', () => {
    const desktop = desktopSnapshot([windowTopSurface()])
    expect(
      isGroundedOnSittableWindowTop(motion({ grounded: true, surfaceId: null }), desktop)
    ).toBe(false)
  })

  it('surfaceId 不在快照里（窗口刚关闭/被过滤掉）→ false', () => {
    expect(
      isGroundedOnSittableWindowTop(
        motion({ grounded: true, surfaceId: 'win-404-top' }),
        desktopSnapshot([windowTopSurface()])
      )
    ).toBe(false)
    expect(isGroundedOnSittableWindowTop(ledgeMotion, desktopSnapshot([]))).toBe(false)
  })

  it('非 window-top 表面（地面/Dock/菜单栏）→ false', () => {
    const dock = windowTopSurface({ id: 'dock-bottom', kind: 'dock-bottom', sittable: true })
    expect(
      isGroundedOnSittableWindowTop(motion({ grounded: true, surfaceId: 'dock-bottom' }), desktopSnapshot([dock]))
    ).toBe(false)
  })

  it('window-top 但 sittable=false（headroom 不够/被 D6a 过滤）→ false', () => {
    const notSittable = windowTopSurface({ sittable: false })
    expect(
      isGroundedOnSittableWindowTop(ledgeMotion, desktopSnapshot([notSittable]))
    ).toBe(false)
  })
})

describe('buildSitWindowStyleCandidates：窗沿坐/躺风格候选（只用窗沿适配素材）', () => {
  const WORK = { workAreaY: 0, workAreaHeight: 961 }

  it('50% 540px @ top=324（实机 Finder 场景）：只有 sitVariant，不含标准 sit / lie（M-1/M-2）', () => {
    const candidates = buildSitWindowStyleCandidates({ surfaceTop: 324, petHeightPx: 540, ...WORK })
    expect(candidates).toEqual([{ mode: 'sitVariant', clipId: SIT_VARIANT_CLIP_ID, sinkPx: 0 }])
    // M-1：高窗绝不使用标准 sit（base sit playlist 会随机播 mate-suwari3 等 floor-sit 素材）。
    expect(candidates.some((item) => item.mode === 'sit')).toBe(false)
    // 0.60×540+8=332 > 324 → 真躺不进入候选（安全不触发）→ 单候选，不轮换（M-2 消失）。
    expect(candidates.some((item) => item.mode === 'lie')).toBe(false)
  })

  it('高窗 headroom 足够（top=400 ≥ 0.60×540+8=332）→ sitVariant + lie（可坐↔躺轮换）', () => {
    const candidates = buildSitWindowStyleCandidates({ surfaceTop: 400, petHeightPx: 540, ...WORK })
    expect(candidates.map((item) => item.mode)).toEqual(['sitVariant', 'lie'])
    expect(candidates[0]).toEqual({ mode: 'sitVariant', clipId: SIT_VARIANT_CLIP_ID, sinkPx: 0 })
    expect(candidates[1]).toEqual({ mode: 'lie', clipId: SIT_LIE_CLIP_ID, sinkPx: 0 })
    expect(SIT_LIE_HEADROOM_RATIO).toBe(0.6)
  })

  it('更高屏幕（workArea 高 1600）：top=700 仍属高窗且 headroom 足够 → sitVariant + lie', () => {
    const candidates = buildSitWindowStyleCandidates({
      surfaceTop: 700,
      workAreaY: 0,
      workAreaHeight: 1600,
      petHeightPx: 540
    })
    expect(candidates.map((item) => item.mode)).toEqual(['sitVariant', 'lie'])
  })

  it('lie 边界：top=331（差 1px）→ 只有 sitVariant；top=332 恰好 → sitVariant + lie', () => {
    const below = buildSitWindowStyleCandidates({ surfaceTop: 331, petHeightPx: 540, ...WORK })
    expect(below.map((item) => item.mode)).toEqual(['sitVariant'])
    const boundary = buildSitWindowStyleCandidates({ surfaceTop: 332, petHeightPx: 540, ...WORK })
    expect(boundary.map((item) => item.mode)).toEqual(['sitVariant', 'lie'])
  })

  it('小尺寸（20% 216px）@ top=324：坐姿变体 + 真躺都放得下（保留 坐↔躺 轮换）', () => {
    const candidates = buildSitWindowStyleCandidates({ surfaceTop: 324, petHeightPx: 216, ...WORK })
    expect(candidates.map((item) => item.mode)).toEqual(['sitVariant', 'lie'])
  })

  it('矮窗（上沿在 workArea 中线及以下，如 top=800 > 480.5）→ 只标准 sit，不轮换', () => {
    const candidates = buildSitWindowStyleCandidates({ surfaceTop: 800, petHeightPx: 540, ...WORK })
    expect(candidates).toEqual([{ mode: 'sit', clipId: null, sinkPx: 0 }])
  })

  it('非法输入（NaN / 身高 ≤ 0）→ 回退只标准 sit（不抛）', () => {
    const fallback = [{ mode: 'sit', clipId: null, sinkPx: 0 }]
    expect(
      buildSitWindowStyleCandidates({ surfaceTop: Number.NaN, petHeightPx: 540, ...WORK })
    ).toEqual(fallback)
    expect(
      buildSitWindowStyleCandidates({ surfaceTop: 324, petHeightPx: Number.NaN, ...WORK })
    ).toEqual(fallback)
    expect(
      buildSitWindowStyleCandidates({ surfaceTop: 324, petHeightPx: 0, ...WORK })
    ).toEqual(fallback)
    expect(
      buildSitWindowStyleCandidates({
        surfaceTop: 324,
        workAreaY: Number.NaN,
        workAreaHeight: 961,
        petHeightPx: 540
      })
    ).toEqual(fallback)
  })

  it('回归不变量：候选含 sitVariant/lie 时不得同时含标准 sit（防 floor-sit 混上窗沿）', () => {
    const surfacesTop = [0, 36, 100, 213, 324, 331, 332, 400, 480, 500, 700, 800, 960]
    const petHeights = [216, 324, 432, 540, 648, 756]
    const workAreas = [
      { workAreaY: 0, workAreaHeight: 961 },
      { workAreaY: 30, workAreaHeight: 961 },
      { workAreaY: 0, workAreaHeight: 1600 }
    ]
    const modesSeen = new Set<string>()
    for (const workArea of workAreas) {
      for (const surfaceTop of surfacesTop) {
        for (const petHeightPx of petHeights) {
          const candidates = buildSitWindowStyleCandidates({ surfaceTop, petHeightPx, ...workArea })
          const modes = candidates.map((item) => item.mode)
          for (const mode of modes) modesSeen.add(mode)
          expect(modes.length).toBeGreaterThan(0)
          expect(new Set(modes).size).toBe(modes.length)
          if (modes.includes('sitVariant') || modes.includes('lie')) {
            expect(modes).not.toContain('sit')
          }
        }
      }
    }
    // 矩阵覆盖三种 mode（高窗：sitVariant/lie；矮窗/非法：sit）。
    expect(modesSeen).toEqual(new Set(['sit', 'sitVariant', 'lie']))
  })
})

describe('pickNextSitWindowStyle：轮换选择（不得连续两段同风格）', () => {
  const SIT = { mode: 'sit', clipId: null, sinkPx: 0 } as const
  const VARIANT = { mode: 'sitVariant', clipId: SIT_VARIANT_CLIP_ID, sinkPx: 0 } as const
  const LIE = { mode: 'lie', clipId: SIT_LIE_CLIP_ID, sinkPx: 0 } as const

  it('两个候选：一定切到另一个（不重复当前）', () => {
    expect(pickNextSitWindowStyle([SIT, VARIANT], 0, () => 0)).toBe(1)
    expect(pickNextSitWindowStyle([SIT, VARIANT], 1, () => 0)).toBe(0)
    expect(pickNextSitWindowStyle([SIT, VARIANT], 0, () => 0.999)).toBe(1)
    expect(pickNextSitWindowStyle([SIT, VARIANT], 1, () => 0.999)).toBe(0)
  })

  it('三个候选：只在「除当前外」的两个里均匀随机', () => {
    expect(pickNextSitWindowStyle([SIT, VARIANT, LIE], 1, () => 0)).toBe(0)
    expect(pickNextSitWindowStyle([SIT, VARIANT, LIE], 1, () => 0.5)).toBe(2)
    expect(pickNextSitWindowStyle([SIT, VARIANT, LIE], 0, () => 0.5)).toBe(2)
    expect(pickNextSitWindowStyle([SIT, VARIANT, LIE], 2, () => 0)).toBe(0)
  })

  it('同随机源可复现；遍历随机序列永远不等于当前 index', () => {
    let seed = 12345
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const candidates = [SIT, VARIANT, LIE]
    for (let current = 0; current < candidates.length; current += 1) {
      for (let index = 0; index < 200; index += 1) {
        const next = pickNextSitWindowStyle(candidates, current, random)
        expect(next).not.toBe(current)
        expect(next).toBeGreaterThanOrEqual(0)
        expect(next).toBeLessThan(candidates.length)
      }
    }
    const a = pickNextSitWindowStyle(candidates, 0, () => 0.42)
    seed = 12345
    const b = pickNextSitWindowStyle(candidates, 0, () => 0.42)
    expect(b).toBe(a)
  })

  it('候选 ≤1 个 → 0（无法轮换）；非法 currentIndex → 返回合法下标（不抛）', () => {
    expect(pickNextSitWindowStyle([SIT], 0)).toBe(0)
    expect(pickNextSitWindowStyle([], 0)).toBe(0)
    expect([0, 1, 2]).toContain(pickNextSitWindowStyle([SIT, VARIANT, LIE], 9, () => 0.5))
    expect([0, 1, 2]).toContain(pickNextSitWindowStyle([SIT, VARIANT, LIE], Number.NaN, () => 0))
  })

  it('轮换间隔常量：20–30s', () => {
    expect(SIT_STYLE_ROTATE_MS.min).toBe(20_000)
    expect(SIT_STYLE_ROTATE_MS.max).toBe(30_000)
    expect(SIT_STYLE_ROTATE_MS.min).toBeLessThan(SIT_STYLE_ROTATE_MS.max)
  })
})

describe('Bug B：PetRuntime.frame 窗沿安全网接线（集成）', () => {
  const DISPLAY: DisplayInfo = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 30, width: 1920, height: 961 },
    scaleFactor: 1,
    isPrimary: true
  }
  const CONFIG = {
    autonomous: false,
    autonomousLevel: 'normal',
    mischief: false,
    dshLink: false
  } as unknown as PetConfig
  const env: PetRuntimeEnvironment = {
    workArea: { x: 0, y: 0, width: 1920, height: 961 },
    petSize: { width: 162, height: 540 },
    viewport: { width: 1920, height: 961 },
    overlayOrigin: { x: 0, y: 0 },
    display: DISPLAY
  }

  function makeWindow(id: number, bounds: WindowInfo['bounds']): WindowInfo {
    return { id, pid: 100 + id, owner: `app-${id}`, layer: 0, alpha: 1, bounds, onScreen: true }
  }

  function nextFrame(runtime: PetRuntime, nowMs: number): ReturnType<PetRuntime['frame']> {
    return runtime.frame({
      nowMs,
      dt: 0.016,
      interaction: EMPTY_INTERACTION,
      events: [],
      bubbleText: null
    })
  }

  it('瞬移到可坐窗口上沿后：即便决策是 idle（B1 非自主路径），animation.mood 也被压成 sit', () => {
    const runtime = new PetRuntime({ env, config: CONFIG, initialFeet: { x: 960, y: 961 } })
    // 全局 {821,354,920,436} → 本地顶边 y=354、headroom=354-30=324（≥0.38×540+8）→ 可坐。
    runtime.updateWindows([makeWindow(9, { x: 821, y: 354, width: 920, height: 436 })], 0)
    // 先跑一帧把 B5 表面同步进物理环境。
    expect(nextFrame(runtime, 0).motion.grounded).toBe(true)
    // 瞬移到窗沿脚底点（物理会判定 grounded 在 win-9-top 上）。
    expect(runtime.debugTeleport({ x: 1281, y: 354 })).toBe(true)
    const output = nextFrame(runtime, 16)
    expect(output.motion.grounded).toBe(true)
    expect(output.motion.surfaceId).toBe('win-9-top')
    expect(output.animation.mood).toBe('sit')
    // animation.mood 被压成 sit，但 B1 的 decision.mood 保持原语义（安全网只改动画层）。
    expect(['idle', 'sit']).toContain(output.decision.mood)
  })

  it('坐在可坐窗沿被 pat 打断：B1 允许反应 mood，动画层安全网压成 sit（视觉不站）', () => {
    const runtime = new PetRuntime({ env, config: CONFIG, initialFeet: { x: 960, y: 961 } })
    runtime.updateWindows([makeWindow(9, { x: 821, y: 354, width: 920, height: 436 })], 0)
    runtime.frame({
      nowMs: 0,
      dt: 0.016,
      interaction: EMPTY_INTERACTION,
      events: [],
      bubbleText: null
    })
    runtime.debugTeleport({ x: 1281, y: 354 })
    // 先确认已 grounded 在可坐窗沿上。
    const seated = nextFrame(runtime, 16)
    expect(seated.motion.grounded).toBe(true)
    expect(seated.animation.mood).toBe('sit')
    // 摸头事件：B1 反应 mood=pat（允许），动画层仍必须是 sit（坐姿反应，tradeoff 已批准）。
    const patFrame = runtime.frame({
      nowMs: 32,
      dt: 0.016,
      interaction: EMPTY_INTERACTION,
      events: [{ kind: 'pat' }],
      bubbleText: null
    })
    expect(patFrame.motion.grounded).toBe(true)
    expect(patFrame.decision.mood).toBe('pat')
    expect(patFrame.animation.mood).toBe('sit')
    // 反应持续期间逐帧都不应回到站立动画。
    let now = 32
    for (let index = 0; index < 30; index += 1) {
      now += 16
      const frame = nextFrame(runtime, now)
      expect(frame.animation.mood).toBe('sit')
    }
  })
})
