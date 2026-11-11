/**
 * VrmPetAnimator 组合层单测：入场序列（introStart→introLoop→introEnd）、mood 进出场过渡
 * （dshError: breaked/revive）、手动 one-shot API、调试 setPose 打断入场。
 *
 * 用 fake clipPlayer / fake VRM（不加载真模型/GL），只验证组合逻辑与调用序列。
 */
import { describe, expect, it, vi } from 'vitest'

import type { Group } from 'three'

import type { AnimationInput } from '../src/renderer/src/core/wave2-contract'
import { createVrmPetAnimator } from '../src/renderer/src/vrm/animator'
import type {
  CreateVrmPetAnimatorOptions,
  VrmAvatar,
  VrmClipPlayer
} from '../src/renderer/src/vrm/runtime-types'

function makeClipSnapshot(
  clipId: string | null,
  poseHipsAboveLowestM: number | null = null
): {
  clipId: string | null
  slot: string | null
  timeSec: number
  weight: number
  fading: boolean
  playbackRate: number
  bonesApplied: number
  missingBones: string[]
  footErrorPx: number | null
  groundOffsetM: number
  ready: boolean
  loadedClipCount: number
} {
  return {
    clipId,
    slot: clipId === null ? null : 'idle',
    timeSec: 0,
    weight: 1,
    fading: false,
    playbackRate: 1,
    bonesApplied: 0,
    missingBones: [],
    footErrorPx: 0,
    groundOffsetM: 0,
    ready: true,
    loadedClipCount: 1,
    poseHipsAboveLowestM,
    clipStrideGroundSpeedMps: null
  }
}

function makeFixture(nowRef: { ms: number }) {
  let currentClip: string | null = null
  let poseHipsAboveLowestM: number | null = null
  const root = { userData: { pixelsPerMeter: 312 } } as unknown as Group
  const playClipById = vi.fn((id: string) => {
    currentClip = id
    return true
  })
  const stopManualClip = vi.fn(() => {
    currentClip = null
  })
  const clipPlayer = {
    init: async () => undefined,
    ready: true,
    update: vi.fn(() => undefined),
    playClipById,
    stopManualClip,
    setMoodOverride: vi.fn(),
    snapshot: vi.fn(() => makeClipSnapshot(currentClip, poseHipsAboveLowestM)),
    dispose: vi.fn()
  } as unknown as VrmClipPlayer
  const avatar = {
    asset: { id: 'test', file: 'vrm/test.vrm', heightMeters: 1.7, expressions: {} },
    vrm: {
      humanoid: { update: vi.fn() },
      update: vi.fn()
    },
    scene: {},
    expressionNames: [],
    materialNames: [],
    capabilities: {},
    restHeightMeters: 1.7,
    restFeetY: 0,
    bodyAspectRatio: 0.5,
    hipsRestHeight: 1,
    textureCount: 0,
    missingTextures: [],
    vertexCount: 0,
    triangleCount: 0,
    dispose: vi.fn()
  } as unknown as VrmAvatar
  return {
    clipPlayer,
    playClipById,
    stopManualClip,
    avatar,
    nowRef,
    root,
    setPoseHipsAboveLowestM: (value: number | null) => {
      poseHipsAboveLowestM = value
    }
  }
}

function makeInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
  return {
    dt: 0.016,
    mood: 'idle',
    motion: {
      feet: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      facing: 'front',
      grounded: true,
      surfaceId: null,
      airborne: false
    },
    facing: 'front',
    lookTarget: null,
    petRect: { x: 0, y: 0, width: 200, height: 540 },
    viewportHeight: 900,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides
  }
}

const INTRO = {
  steps: [
    { clipId: 'mate-introStart', seconds: 2 },
    { clipId: 'mate-introLoop', seconds: 4, loop: true },
    { clipId: 'mate-introEnd', seconds: 1.5 }
  ]
} as const

const TRANSITIONS = {
  dshError: { enterClip: 'hsr-breaked', enterHold: true, exitClip: 'hsr-revive', exitHold: false }
} as const

/** 2026-11-10：进入 dshError 时在 hsr-breaked / adv-die 之间随机倒地。 */
const RANDOM_FALL_TRANSITIONS = {
  dshError: {
    enterClip: ['hsr-breaked', 'adv-die'],
    enterHold: true,
    exitClip: 'hsr-revive',
    exitHold: false
  }
} as const

async function makeAnimator(
  nowRef: { ms: number },
  options: {
    random?: () => number
    moodTransitionClips?: CreateVrmPetAnimatorOptions['moodTransitionClips']
  } = {}
) {
  const fixture = makeFixture(nowRef)
  const animator = createVrmPetAnimator({
    avatar: fixture.avatar,
    root: fixture.root,
    clipPlayer: fixture.clipPlayer,
    now: () => nowRef.ms,
    introSequence: { steps: INTRO.steps },
    ...(options.random !== undefined ? { random: options.random } : {}),
    moodTransitionClips: options.moodTransitionClips ?? TRANSITIONS
  })
  await animator.ready
  return { ...fixture, animator }
}

describe('createVrmPetAnimator：入场序列', () => {
  it('idle 首帧开始 introStart → 到点 introLoop → 到点 introEnd → 结束', async () => {
    const nowRef = { ms: 0 }
    const { animator, playClipById } = await makeAnimator(nowRef)
    animator.update(makeInput())
    expect(playClipById).toHaveBeenCalledWith('mate-introStart', { loop: false, fadeSec: 0.3 })
    expect(animator.introActive).toBe(true)

    nowRef.ms = 2100
    animator.update(makeInput())
    expect(playClipById).toHaveBeenLastCalledWith('mate-introLoop', { loop: true, fadeSec: 0.3 })

    nowRef.ms = 6200
    animator.update(makeInput())
    expect(playClipById).toHaveBeenLastCalledWith('mate-introEnd', { loop: false, fadeSec: 0.3 })

    nowRef.ms = 8000
    animator.update(makeInput())
    expect(animator.introActive).toBe(false)
  })

  it('拖拽打断：stopManualClip 调一次，且后续 idle 不重播入场', async () => {
    const nowRef = { ms: 0 }
    const { animator, playClipById, stopManualClip } = await makeAnimator(nowRef)
    animator.update(makeInput())
    expect(animator.introActive).toBe(true)

    animator.update(makeInput({ dragging: true }))
    expect(stopManualClip).toHaveBeenCalledTimes(1)
    expect(animator.introActive).toBe(false)

    playClipById.mockClear()
    animator.update(makeInput())
    expect(playClipById).not.toHaveBeenCalled()
  })

  it('交互事件打断入场', async () => {
    const nowRef = { ms: 0 }
    const { animator, stopManualClip } = await makeAnimator(nowRef)
    animator.update(makeInput())
    animator.update(makeInput({ events: [{ kind: 'pat' }] }))
    expect(stopManualClip).toHaveBeenCalled()
    expect(animator.introActive).toBe(false)
  })
})

describe('createVrmPetAnimator：mood 进出场过渡', () => {
  it('进入 dshError 播 hsr-breaked（hold 停末帧）；离开播 hsr-revive；同 mood 不重复', async () => {
    const nowRef = { ms: 0 }
    const { animator, playClipById } = await makeAnimator(nowRef)
    // 先 idle 建立 lastMood（同时会启动入场；用拖拽打断避免干扰后续调用断言）
    animator.update(makeInput())
    animator.update(makeInput({ dragging: true }))
    playClipById.mockClear()

    animator.update(makeInput({ mood: 'dshError' }))
    expect(playClipById).toHaveBeenCalledWith('hsr-breaked', {
      loop: false,
      hold: true,
      fadeSec: 0.15
    })

    playClipById.mockClear()
    animator.update(makeInput({ mood: 'dshError' }))
    expect(playClipById).not.toHaveBeenCalled()

    animator.update(makeInput({ mood: 'idle' }))
    expect(playClipById).toHaveBeenCalledWith('hsr-revive', {
      loop: false,
      hold: false,
      fadeSec: 0.2
    })
  })

  it('腾空中进入 dshError 不立刻播 breaked（地面过场延迟）；落地后补播一次', async () => {
    const nowRef = { ms: 0 }
    const { animator, playClipById } = await makeAnimator(nowRef)
    animator.update(makeInput())
    animator.update(makeInput({ dragging: true }))
    playClipById.mockClear()

    const airborneMotion = {
      feet: { x: 0, y: 0 },
      velocity: { x: 0, y: -1200 },
      facing: 'front' as const,
      grounded: false,
      surfaceId: null,
      airborne: true
    }
    animator.update(makeInput({ mood: 'dshError', motion: airborneMotion }))
    expect(playClipById).not.toHaveBeenCalled()

    // 落地（airborne=false）→ 补播 breaked 一次
    animator.update(makeInput({ mood: 'dshError' }))
    expect(playClipById).toHaveBeenCalledWith('hsr-breaked', {
      loop: false,
      hold: true,
      fadeSec: 0.15
    })

    playClipById.mockClear()
    animator.update(makeInput({ mood: 'dshError' }))
    expect(playClipById).not.toHaveBeenCalled()
  })
  it('enterClip 为数组：按注入 random 等概率随机倒地（0.1 → hsr-breaked，0.9 → adv-die）', async () => {
    const enterDshError = async (randomValue: number) => {
      const nowRef = { ms: 0 }
      const { animator, playClipById } = await makeAnimator(nowRef, {
        random: () => randomValue,
        moodTransitionClips: RANDOM_FALL_TRANSITIONS
      })
      // 先走 idle 建立 lastMood（会启动入场序列）→ 拖拽打断 intro，避免入场调用干扰断言。
      animator.update(makeInput())
      animator.update(makeInput({ dragging: true }))
      playClipById.mockClear()
      animator.update(makeInput({ mood: 'dshError' }))
      return playClipById
    }

    // clamp(0.1,0,0.999)×2 = 0.2 → 第 0 条；0.9×2 = 1.8 → 第 1 条。
    const low = await enterDshError(0.1)
    expect(low).toHaveBeenCalledTimes(1)
    expect(low).toHaveBeenCalledWith('hsr-breaked', { loop: false, hold: true, fadeSec: 0.15 })

    const high = await enterDshError(0.9)
    expect(high).toHaveBeenCalledTimes(1)
    expect(high).toHaveBeenCalledWith('adv-die', { loop: false, hold: true, fadeSec: 0.15 })
  })
})

describe('createVrmPetAnimator：sit 窗口视觉锚点', () => {
  it('sit mood + poseHipsAboveLowestM → visualOffsetYPx ≈ -高度×pxPerMeter（模型下移，hips 贴窗沿）', async () => {
    const nowRef = { ms: 0 }
    const { animator, setPoseHipsAboveLowestM } = await makeAnimator(nowRef)
    setPoseHipsAboveLowestM(0.65)
    // 先 idle 建立状态（入场序列会启动；用拖拽打断）
    animator.update(makeInput())
    animator.update(makeInput({ dragging: true }))
    // 进入 sit，多帧让偏移平滑收敛
    for (let index = 0; index < 60; index += 1) {
      animator.update(makeInput({ mood: 'sit', dt: 0.05 }))
    }
    const snapshot = animator.getDebugSnapshot()
    // 0.65m × 312 px/m ≈ 202.8px（向下 → 负值）
    expect(snapshot.visualOffsetYPx ?? 0).toBeLessThan(-190)
    expect(snapshot.visualOffsetYPx ?? 0).toBeGreaterThan(-215)
  })
})

describe('createVrmPetAnimator：手动 one-shot 与调试接口', () => {
  it('playOneShotClip 调用 clipPlayer.playClipById 并返回结果', async () => {
    const nowRef = { ms: 0 }
    const { animator, playClipById } = await makeAnimator(nowRef)
    animator.update(makeInput())
    playClipById.mockClear()
    expect(animator.playOneShotClip('hsr-skill01', { loop: false, fadeSec: 0.25 })).toBe(true)
    expect(playClipById).toHaveBeenCalledWith('hsr-skill01', { loop: false, fadeSec: 0.25 })
  })

  it('setPose 打断入场；未知 pose 返回 false', async () => {
    const nowRef = { ms: 0 }
    const { animator, stopManualClip, playClipById } = await makeAnimator(nowRef)
    animator.update(makeInput())
    expect(animator.introActive).toBe(true)
    expect(animator.setPose('sit')).toBe(true)
    expect(stopManualClip).toHaveBeenCalled()
    // 未知 id：clipPlayer.playClipById 返回 false，且不是合法 mood 别名 → setPose false。
    playClipById.mockReturnValueOnce(false)
    expect(animator.setPose('definitely-unknown-pose')).toBe(false)
  })

  it('setGaze 无 look-at 层时安全 no-op', async () => {
    const nowRef = { ms: 0 }
    const { animator } = await makeAnimator(nowRef)
    expect(() => animator.setGaze(20, -5)).not.toThrow()
  })
})
