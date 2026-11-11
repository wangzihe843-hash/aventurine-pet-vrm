/**
 * V1 clip-engine：`src/renderer/src/vrm/clip-player.ts` 单测（fake VrmAvatar + 假 fetchText）。
 *
 * 覆盖：init/ready 降级、mood→clip 选择（priority）、多动作随机轮换/间隔/淡入、交叉淡入、一次性事件回 mood、
 * 坐姿锚点高度（poseHipsAboveLowestM）、walk 步幅地速/playbackRate、
 * playClipById/setMoodOverride、拖拽姿态、Hips.p 缩放 + 贴地常量、缺骨过滤、快照字段、dispose。
 */
import { describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'

import type { AnimationDebugSnapshot } from '../src/renderer/src/core/wave2-contract'
import type { AnimationEvent, AnimationInput } from '../src/renderer/src/core/wave2-contract'
import {
  CLIP_PLAYER_DEFAULTS,
  RARE_VARIANT_PRIORITY_THRESHOLD,
  RARE_VARIANT_WEIGHT,
  VARIANT_SWITCH_CONFIG,
  VrmClipPlayer,
  createVrmClipPlayer,
  variantSwitchConfigFor,
  type VrmClipPlayerTuning
} from '../src/renderer/src/vrm/clip-player'
import { slerpQuat, type Quat4 } from '../src/renderer/src/vrm/clip-data'
import {
  identityQuat,
  makeClipJson,
  makeFakeAvatar,
  pitchQuat,
  trackNested,
  yawQuat,
  type FakeAvatarHandle
} from './fixtures/vrm-motion/clip-fixtures'

/* -------------------------------------------------------------------------- */
/* 假清单 / 假输入                                                              */
/* -------------------------------------------------------------------------- */

const CLIP_FILES = {
  idleHsr: 'hsr/idle.json',
  idleMate: 'mate/idle.json',
  walk: 'mate/walk.json',
  sit: 'mate/sitWindow.json',
  sleep: 'mate/sleep.json',
  drag: 'mate/drag.json',
  happy: 'mate/happy.json',
  laughing: 'mate/laughing.json',
  skill: 'hsr/skill01.json',
  skill02: 'hsr/skill02.json',
  hitL: 'hsr/hitL.json',
  stun: 'hsr/stun.json',
  revive: 'hsr/revive.json',
  breaked: 'hsr/breaked.json'
} as const

/** 测试用 clip 数据（hook 形状简单、便于断言）。 */
function makeClipFiles(): Record<string, unknown> {
  const idleHsr = makeClipJson({
    clip: 'idle',
    fps: 2,
    frames: 3,
    loop: true,
    grounding: 'none',
    bones: {
      Hips: trackNested([identityQuat(), identityQuat(), identityQuat()]),
      Head: trackNested([yawQuat(0), yawQuat(30), yawQuat(60)])
    }
  })
  const idleMate = makeClipJson({
    clip: 'idle',
    fps: 2,
    frames: 3,
    loop: true,
    bones: { Hips: trackNested([identityQuat(), identityQuat(), identityQuat()]) }
  })
  const walk = makeClipJson({
    clip: 'walk',
    fps: 1,
    frames: 2,
    loop: true,
    bones: {
      Hips: trackNested([identityQuat(), identityQuat()]),
      Head: trackNested([pitchQuat(0), pitchQuat(10)])
    }
  })
  const oneShot = (clip: string, yawDeg = 20) =>
    makeClipJson({
      clip,
      fps: 1,
      frames: 2,
      loop: false,
      bones: {
        Hips: trackNested([identityQuat(), identityQuat()]),
        Head: trackNested([identityQuat(), yawQuat(yawDeg)])
      }
    })
  return {
    'app-manifest.json': {
      schemaVersion: 1,
      clips: [
        { id: 'hsr-idle', mood: 'idle', file: CLIP_FILES.idleHsr, loop: true, priority: 10, fadeInSec: 0.15, fadeOutSec: 0.2 },
        { id: 'mate-idle', mood: 'idle', file: CLIP_FILES.idleMate, loop: true, priority: 0, fadeInSec: 0.15, fadeOutSec: 0.2 },
        { id: 'mate-walk', mood: 'walk', file: CLIP_FILES.walk, loop: true, priority: 0 },
        { id: 'mate-sitWindow', mood: 'sit', file: CLIP_FILES.sit, loop: true, priority: 0 },
        { id: 'mate-sleep', mood: 'sleep', file: CLIP_FILES.sleep, loop: true, priority: 0 },
        { id: 'mate-drag', mood: 'drag', file: CLIP_FILES.drag, loop: false, priority: 0 },
        { id: 'mate-happy', mood: 'pat', file: CLIP_FILES.happy, loop: false, priority: 0 }
      ]
    },
    'app-catalog.json': {
      version: 1,
      clips: [
        { id: 'hsr-idle', set: 'hsr', file: CLIP_FILES.idleHsr, loop: true, duration: 1.5, tags: ['idle'], mood: 'idle' },
        { id: 'mate-idle', set: 'mate', file: CLIP_FILES.idleMate, loop: true, duration: 1.5, tags: ['idle'], mood: 'idle' },
        { id: 'mate-walk', set: 'mate', file: CLIP_FILES.walk, loop: true, duration: 2, tags: ['walk'], mood: 'walk' },
        { id: 'mate-sitWindow', set: 'mate', file: CLIP_FILES.sit, loop: true, duration: 1, tags: ['sit'], mood: 'sit' },
        { id: 'mate-sleep', set: 'mate', file: CLIP_FILES.sleep, loop: true, duration: 1, tags: ['sleep'], mood: 'sleep' },
        { id: 'mate-drag', set: 'mate', file: CLIP_FILES.drag, loop: false, duration: 1, tags: ['interaction'], mood: 'drag' },
        { id: 'mate-happy', set: 'mate', file: CLIP_FILES.happy, loop: false, duration: 1, tags: ['interaction'], mood: 'pat' },
        { id: 'mate-laughing', set: 'mate', file: CLIP_FILES.laughing, loop: false, duration: 1, tags: ['interaction'], mood: 'pat' },
        { id: 'hsr-skill01', set: 'hsr', file: CLIP_FILES.skill, loop: false, duration: 1, tags: ['skill'], mood: null },
        { id: 'hsr-skill02', set: 'hsr', file: CLIP_FILES.skill02, loop: false, duration: 1, tags: ['skill'], mood: null },
        { id: 'hsr-hitL', set: 'hsr', file: CLIP_FILES.hitL, loop: false, duration: 1, tags: ['react'], mood: null },
        { id: 'hsr-stun', set: 'hsr', file: CLIP_FILES.stun, loop: false, duration: 1, tags: ['react'], mood: null },
        { id: 'hsr-revive', set: 'hsr', file: CLIP_FILES.revive, loop: false, duration: 1, tags: ['react'], mood: null },
        // V11：catalog-only 手动播放测试（breaked 循环 / revive 一次性）
        { id: 'hsr-breaked', set: 'hsr', file: CLIP_FILES.breaked, loop: true, duration: 2, tags: ['pose', 'weak'], mood: null }
      ]
    },
    [CLIP_FILES.idleHsr]: idleHsr,
    [CLIP_FILES.idleMate]: idleMate,
    [CLIP_FILES.walk]: walk,
    [CLIP_FILES.sit]: oneShot('sitWindow'),
    [CLIP_FILES.sleep]: oneShot('sleep'),
    [CLIP_FILES.drag]: oneShot('drag'),
    [CLIP_FILES.happy]: oneShot('happy'),
    [CLIP_FILES.laughing]: oneShot('laughing'),
    [CLIP_FILES.skill]: oneShot('skill01'),
    [CLIP_FILES.skill02]: oneShot('skill02'),
    [CLIP_FILES.hitL]: oneShot('hitL'),
    [CLIP_FILES.stun]: oneShot('stun'),
    [CLIP_FILES.revive]: oneShot('revive'),
    [CLIP_FILES.breaked]: makeClipJson({
      clip: 'breaked',
      fps: 1,
      frames: 2,
      loop: true,
      bones: {
        Hips: trackNested([identityQuat(), identityQuat()]),
        Head: trackNested([identityQuat(), identityQuat()])
      }
    })
  }
}

/** 由文件表构造假 fetchText（按相对路径映射到 pet-asset://assets/motions/ 基址）。 */
function makeFetchText(files: Record<string, unknown>): {
  fetchText: (url: string) => Promise<string>
  counts: Map<string, number>
} {
  const counts = new Map<string, number>()
  const fetchText = async (url: string): Promise<string> => {
    counts.set(url, (counts.get(url) ?? 0) + 1)
    const relative = url.replace(/^pet-asset:\/\/assets\/motions\//, '')
    if (!(relative in files)) throw new Error(`404 ${url}`)
    const value = files[relative]
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { fetchText, counts }
}

/** 构造 player（默认 fake avatar 无缺骨）。 */
function makePlayer(
  options: {
    files?: Record<string, unknown>
    avatar?: FakeAvatarHandle
    random?: () => number
    now?: () => number
    pixelsPerMeter?: () => number
    getPixelsPerMeterMissing?: boolean
    tuning?: VrmClipPlayerTuning
  } = {}
): { player: VrmClipPlayer; avatar: FakeAvatarHandle; fetchCounts: Map<string, number> } {
  const avatar = options.avatar ?? makeFakeAvatar()
  const files = options.files ?? makeClipFiles()
  const { fetchText, counts } = makeFetchText(files)
  const playerOptions: Parameters<typeof createVrmClipPlayer>[0] = {
    avatar: avatar.avatar,
    fetchText
  }
  if (options.random !== undefined) playerOptions.random = options.random
  if (options.now !== undefined) playerOptions.now = options.now
  if (options.pixelsPerMeter !== undefined && options.getPixelsPerMeterMissing !== true) {
    playerOptions.getPixelsPerMeter = options.pixelsPerMeter
  }
  const player =
    options.tuning !== undefined
      ? new VrmClipPlayer(playerOptions, options.tuning)
      : new VrmClipPlayer(playerOptions)
  return { player, avatar, fetchCounts: counts }
}

/** 构造一帧 AnimationInput（默认 idle/静止/540px 高宠物）。 */
function makeInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
  return {
    dt: 0.1,
    mood: 'idle',
    motion: {
      feet: { x: 500, y: 400 },
      velocity: { x: 0, y: 0 },
      facing: 'right',
      grounded: true,
      surfaceId: 'screen-bottom',
      airborne: false
    },
    facing: 'right',
    lookTarget: null,
    petRect: { x: 400, y: 100, width: 200, height: 540 },
    viewportHeight: 540,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides
  }
}

/** 断言四元数近似（允许 q/-q 符号差）。 */
function expectQuatClose(actual: Quat4, expected: Quat4, epsilon = 1e-4): void {
  const dot =
    actual[0] * expected[0] +
    actual[1] * expected[1] +
    actual[2] * expected[2] +
    actual[3] * expected[3]
  const sign = dot < 0 ? -1 : 1
  for (let index = 0; index < 4; index += 1) {
    expect(Math.abs(actual[index] - sign * expected[index])).toBeLessThan(epsilon)
  }
}

/** 读取 normalized 骨 quaternion（fake avatar 节点）。 */
function nodeQuat(avatar: FakeAvatarHandle, vrmName: string): Quat4 {
  const node = avatar.nodes.get(vrmName)
  if (!node) throw new Error(`fake avatar 缺少节点 ${vrmName}`)
  return [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w]
}

/** 连续推进若干帧（默认 dt=0.1）。 */
function step(player: VrmClipPlayer, frames: number, overrides: Partial<AnimationInput> = {}, dt = 0.1): void {
  for (let index = 0; index < frames; index += 1) {
    player.update(makeInput({ ...overrides, dt }))
  }
}

/* -------------------------------------------------------------------------- */
/* init / ready / 基础播放                                                      */
/* -------------------------------------------------------------------------- */

describe('clip-player：init / ready / 基础播放', () => {
  it('init 后 ready=true，update 选最高优先级 idle clip，写骨并调用 humanoid.update()', async () => {
    const { player, avatar } = makePlayer()
    await player.init()
    expect(player.ready).toBe(true)
    expect(player.loadedClipCount).toBeGreaterThan(0)
    expect(player.init()).toBe(player.init()) // 幂等

    // 首帧触发选片（dt=0：时间不推进；首个 clip 直接吸附，见下一条用例）
    player.update(makeInput({ dt: 0 }))
    expect(player.snapshot().clipId).toBe('hsr-idle')
    // 推进到淡入完成 + 0.3s 剪辑时间
    step(player, 3)
    const snapshot = player.snapshot()
    expect(snapshot.clipId).toBe('hsr-idle')
    expect(snapshot.slot).toBe('idle')
    expect(snapshot.weight).toBe(1)
    expect(snapshot.fading).toBe(false)
    expect(snapshot.bonesApplied).toBe(52)
    expect(snapshot.ready).toBe(true)
    expect(snapshot.loadedClipCount).toBeGreaterThan(0)
    expect(avatar.updateCount()).toBeGreaterThanOrEqual(4)
    // 头部 yaw：t=0.3s、fps=2 → 帧 0.6；0°→30° 插值 = 18°
    expectQuatClose(nodeQuat(avatar, 'head'), yawQuat(18))
  })

  it('首个 clip 直接吸附（不从 rest T-pose crossfade）：第一次 update 即 weight=1 / 不 fading', async () => {
    // 用户 2026-11-09：启动先闪「T/A-pose」再进 idle。修复=首条 clip 满权重写姿势（fadeSec=0），
    // 后续切换才走 crossfade（从当前已应用姿势快照开始，永不从 rest 开始）。
    // 场景层以 weight≈1 作为「启动姿势已完整应用」的显示信号（见 tests/vrm-startup-pose.test.ts）。
    const { player } = makePlayer()
    await player.init()
    // 第一帧 dt=0（真实 app 首帧 dt 可能为 0）：仍须满权重写姿势，否则会停一帧 rest。
    player.update(makeInput({ dt: 0 }))
    const first = player.snapshot()
    expect(first.clipId).toBe('hsr-idle')
    expect(first.fading).toBe(false)
    expect(first.weight).toBe(1)
    expect(first.bonesApplied).toBe(52)
    // 首帧之后仍是同一 clip（吸附不是一次性抖动）
    player.update(makeInput({ dt: 0.1 }))
    expect(player.snapshot().clipId).toBe('hsr-idle')
    expect(player.snapshot().weight).toBe(1)
  })

  it('mood 变化切到对应槽位 clip；缺 clip 的 mood 保持当前动作', async () => {
    const { player } = makePlayer()
    await player.init()
    player.update(makeInput({ dt: 0 }))
    step(player, 3)
    player.update(makeInput({ mood: 'sit', dt: 0 }))
    step(player, 3, { mood: 'sit' })
    expect(player.snapshot().clipId).toBe('mate-sitWindow')
    expect(player.snapshot().slot).toBe('sit')
    // climb 槽位没有 clip → 保持 mate-sitWindow
    player.update(makeInput({ mood: 'climb', dt: 0.1 }))
    expect(player.snapshot().clipId).toBe('mate-sitWindow')
  })

  it('快照字段齐全（debug snapshot 兼容）', async () => {
    const { player } = makePlayer()
    await player.init()
    player.update(makeInput({ dt: 0 }))
    const snapshot = player.snapshot()
    const expectedKeys: Array<keyof ReturnType<typeof player.snapshot>> = [
      'clipId',
      'slot',
      'timeSec',
      'weight',
      'fading',
      'playbackRate',
      'bonesApplied',
      'missingBones',
      'footErrorPx',
      'groundOffsetM',
      'ready',
      'loadedClipCount'
    ]
    for (const key of expectedKeys) expect(snapshot).toHaveProperty(key)
    expect(snapshot.missingBones).toEqual([])
    expect(snapshot.footErrorPx).toBeNull() // grounding=none
  })
})

/* -------------------------------------------------------------------------- */
/* 交叉淡入 / 待机变体轮换                                                      */
/* -------------------------------------------------------------------------- */

describe('clip-player：交叉淡入', () => {
  it('切换 clip 时 per-bone slerp + smoothstep 淡入（0.2s）', async () => {
    const { player, avatar } = makePlayer()
    await player.init()
    player.update(makeInput({ dt: 0 }))
    step(player, 3) // idle 稳定，head ≈ yaw18°
    const fromQuat = nodeQuat(avatar, 'head')

    // 切 walk：fade 时长 = max(新 fadeIn 0.15, 旧 fadeOut 0.2) = 0.2s
    player.update(makeInput({ mood: 'walk', dt: 0 }))
    let snapshot = player.snapshot()
    expect(snapshot.fading).toBe(true)
    expect(snapshot.weight).toBe(0)
    expect(snapshot.clipId).toBe('mate-walk')

    player.update(makeInput({ mood: 'walk', dt: 0.1 }))
    snapshot = player.snapshot()
    expect(snapshot.fading).toBe(true)
    expect(snapshot.weight).toBeCloseTo(0.5) // smoothstep(0.5)
    // 中点 head = slerp(from, walk 当前帧 head, 0.5)；静止 walk 播放速率 0.5 → t=0.05s → pitch 0.5°
    const mid = nodeQuat(avatar, 'head')
    const expectedMid: Quat4 = [0, 0, 0, 1]
    slerpQuat(fromQuat, pitchQuat(0.5), 0.5, expectedMid)
    expectQuatClose(mid, expectedMid, 1e-3)

    player.update(makeInput({ mood: 'walk', dt: 0.1 }))
    snapshot = player.snapshot()
    expect(snapshot.fading).toBe(false)
    expect(snapshot.weight).toBe(1)
  })

})

/* -------------------------------------------------------------------------- */
/* 一次性事件                                                                  */
/* -------------------------------------------------------------------------- */

describe('clip-player：一次性事件 → 播完回 mood', () => {
  it('pat 事件播 catalog 一次性 clip（slot=pat），播完回 idle', async () => {
    const { player } = makePlayer({ random: () => 0 })
    await player.init()
    step(player, 3) // idle 稳定
    // 触发 pat（catalog 候选 mate-happy/laughing 随机；random=0 → happy）
    player.update(makeInput({ events: [{ kind: 'pat' }] }))
    let snapshot = player.snapshot()
    expect(snapshot.clipId).toBe('mate-happy')
    expect(snapshot.slot).toBe('pat')
    // 一次性 clip 播完（frames=2, fps=1 → 末帧 1s）→ 回 idle 槽位；
    // 「事件后换一个待机变体」：hsr-idle → mate-idle（设计 §2.3）
    step(player, 12)
    snapshot = player.snapshot()
    expect(snapshot.slot).toBe('idle')
    expect(['hsr-idle', 'mate-idle']).toContain(snapshot.clipId)
  })

  it('拖拽打断一次性表演，并切到 drag 槽位；dragEnd 后回 mood', async () => {
    const { player } = makePlayer({ random: () => 0 })
    await player.init()
    step(player, 3)
    player.update(makeInput({ events: [{ kind: 'pat' }] }))
    expect(player.snapshot().slot).toBe('pat')
    player.update(makeInput({ dragging: true }))
    expect(player.snapshot().clipId).toBe('mate-drag')
    expect(player.snapshot().slot).toBe('drag')
    player.update(makeInput({ events: [{ kind: 'dragEnd' }], dragging: false }))
    step(player, 2)
    expect(player.snapshot().slot).toBe('idle')
  })

  it('drag 男女版同 priority 时随机二选一；一次拖拽内不轮换（drag interval=null）', async () => {
    const pairFiles = (): Record<string, unknown> => {
      const files = makeClipFiles()
      const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
      manifest.clips.push({
        id: 'mate-dragFemale',
        mood: 'drag',
        file: 'mate/dragFemale.json',
        loop: false,
        priority: 0
      })
      const catalog = files['app-catalog.json'] as { clips: Array<Record<string, unknown>> }
      catalog.clips.push({
        id: 'mate-dragFemale',
        set: 'mate',
        file: 'mate/dragFemale.json',
        loop: false,
        duration: 1,
        tags: ['interaction'],
        mood: 'drag'
      })
      files['mate/dragFemale.json'] = makeClipJson({
        clip: 'dragFemale',
        fps: 1,
        frames: 2,
        loop: false,
        bones: { Hips: trackNested([identityQuat(), identityQuat()]) }
      })
      return files
    }
    // 同 priority 并列 + drag 配置 interval=null（一次拖拽内不轮换）
    expect(variantSwitchConfigFor('drag').intervalSec).toBeNull()

    const male = makePlayer({ files: pairFiles(), random: () => 0.1 })
    await male.player.init()
    male.player.update(makeInput({ dragging: true }))
    expect(male.player.snapshot().clipId).toBe('mate-drag')

    const female = makePlayer({ files: pairFiles(), random: () => 0.9 })
    await female.player.init()
    female.player.update(makeInput({ dragging: true }))
    expect(female.player.snapshot().clipId).toBe('mate-dragFemale')

    let nowMs = 0
    const held = makePlayer({ files: pairFiles(), random: () => 0.4, now: () => nowMs })
    await held.player.init()
    held.player.update(makeInput({ dragging: true }))
    const first = held.player.snapshot().clipId
    for (let index = 0; index < 30; index += 1) {
      nowMs += 5000
      held.player.update(makeInput({ dragging: true }))
    }
    expect(held.player.snapshot().clipId).toBe(first)
  })

  it('事件优先级：thrown 打断 pat；poke 不会打断进行中的 pat', async () => {
    const { player } = makePlayer({ random: () => 0 })
    await player.init()
    step(player, 3)
    player.update(makeInput({ events: [{ kind: 'pat' }] }))
    expect(player.snapshot().slot).toBe('pat')
    // poke 优先级 10 < pat 20 → 不打断
    player.update(makeInput({ events: [{ kind: 'poke', region: 'head' }] }))
    expect(player.snapshot().slot).toBe('pat')
    // thrown 优先级 50 > pat → 打断，catalog 首选 hsr-stun（预载后同步起播）
    await player.clipRegistry.loadClip('hsr-stun')
    player.update(makeInput({ events: [{ kind: 'thrown', speed: 900 }] }))
    expect(player.snapshot().clipId).toBe('hsr-stun')
    expect(player.snapshot().slot).toBe('thrown')
  })

  it('腾空中 thrown 不立刻播地面受击 clip；落地（landed）时补播 hsr-stun', async () => {
    const { player } = makePlayer({ random: () => 0 })
    await player.init()
    step(player, 3)
    await player.clipRegistry.loadClip('hsr-stun')

    const airborneMotion = {
      feet: { x: 500, y: 100 },
      velocity: { x: 0, y: -1200 },
      facing: 'right' as const,
      grounded: false,
      surfaceId: null,
      airborne: true
    }
    player.update(makeInput({ motion: airborneMotion, events: [{ kind: 'thrown', speed: 900 }] }))
    expect(player.snapshot().slot).toBe('idle')

    // 落地事件：有「空中被甩出」记录 → 补播 hsr-stun（而不是默认 landed 的 revive）
    player.update(makeInput({ events: [{ kind: 'landed', impactSpeed: 2000 }] }))
    expect(player.snapshot().clipId).toBe('hsr-stun')
    expect(player.snapshot().slot).toBe('landed')
  })

  it('拖拽重新开始时清掉未落地的 thrown 补播记录', async () => {
    const { player } = makePlayer({ random: () => 0 })
    await player.init()
    step(player, 3)
    await player.clipRegistry.loadClip('hsr-stun')

    const airborneMotion = {
      feet: { x: 500, y: 100 },
      velocity: { x: 0, y: -1200 },
      facing: 'right' as const,
      grounded: false,
      surfaceId: null,
      airborne: true
    }
    player.update(makeInput({ motion: airborneMotion, events: [{ kind: 'thrown', speed: 900 }] }))
    player.update(makeInput({ dragging: true }))
    // 未经历过落地，直接落到 grounded 的普通帧 + landed：应按默认 landed 处理（revive/hitL），不补播 stun
    player.update(makeInput({ events: [{ kind: 'landed', impactSpeed: 2000 }] }))
    expect(player.snapshot().clipId).not.toBe('hsr-stun')
  })
})

/* -------------------------------------------------------------------------- */
/* playClipById / setMoodOverride                                               */
/* -------------------------------------------------------------------------- */

describe('clip-player：playClipById / setMoodOverride', () => {
  it('未知 id 返回 false；已知 id 立即播放（manual 槽位）', async () => {
    const { player } = makePlayer()
    await player.init()
    expect(player.playClipById('nope')).toBe(false)
    // 先确保 catalog clip 已加载
    await player.clipRegistry.loadClip('hsr-skill01')
    expect(player.playClipById('hsr-skill01', { loop: false })).toBe(true)
    player.update(makeInput({ dt: 0 }))
    expect(player.snapshot().clipId).toBe('hsr-skill01')
    expect(player.snapshot().slot).toBe('manual')
  })

  it('hold=true 时一次性 clip 播完停在末帧，不自动回 mood', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.loadClip('hsr-skill01')
    player.playClipById('hsr-skill01', { loop: false, hold: true, fadeSec: 0 })
    player.update(makeInput({ dt: 0 }))
    step(player, 15)
    const snapshot = player.snapshot()
    expect(snapshot.clipId).toBe('hsr-skill01')
    expect(snapshot.slot).toBe('manual')
    expect(snapshot.timeSec).toBeCloseTo(1) // (frames-1)/fps = 1
  })

  it('setMoodOverride 切换/清除 mood 覆盖', async () => {
    const { player } = makePlayer()
    await player.init()
    player.setMoodOverride('sit')
    player.update(makeInput({ dt: 0 }))
    expect(player.snapshot().clipId).toBe('mate-sitWindow')
    player.setMoodOverride('climb') // 无 clip → 保持
    player.update(makeInput({ dt: 0.1 }))
    expect(player.snapshot().clipId).toBe('mate-sitWindow')
    player.setMoodOverride(null)
    player.update(makeInput({ dt: 0.1 }))
    expect(player.snapshot().clipId).toBe('hsr-idle')
  })
})

/* -------------------------------------------------------------------------- */
/* Hips / 贴地 / 缺骨                                                           */
/* -------------------------------------------------------------------------- */

describe('clip-player：Hips.p 缩放 + 贴地常量补偿', () => {
  /** grounding=feet 且首帧 Hips.p=(0,0.05,0) 的 idle clip（源 hips 高 0.95，目标 rest 高 1）。 */
  function makeGroundingFiles(): Record<string, unknown> {
    const files = makeClipFiles()
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    for (const clip of manifest.clips) {
      if (clip.id === 'hsr-idle') clip.file = 'hsr/idleGrounded.json'
    }
    files['hsr/idleGrounded.json'] = makeClipJson({
      clip: 'idleGrounded',
      fps: 1,
      frames: 2,
      loop: true,
      grounding: 'feet',
      sourceHipsHeight: 0.95,
      bones: {
        Hips: trackNested(
          [identityQuat(), identityQuat()],
          [
            [0, 0.05, 0],
            [0, 0.05, 0]
          ]
        ),
        Head: trackNested([identityQuat(), identityQuat()])
      }
    })
    return files
  }

  it('grounding=feet：首帧脚骨最低点补偿为 rest 基准；hips 位置含缩放后 p', async () => {
    const { player, avatar } = makePlayer({
      files: makeGroundingFiles(),
      pixelsPerMeter: () => 100
    })
    await player.init()
    step(player, 4) // 稳定
    const snapshot = player.snapshot()
    expect(snapshot.clipId).toBe('hsr-idle')
    // 首帧脚骨 y = rest 0.02 + p 0.05 = 0.07 → 补偿 = 0.02 - 0.07 = -0.05
    expect(snapshot.groundOffsetM).toBeCloseTo(-0.05)
    // hips = rest 1 + p_scaled(0) ... p=0.05 米；源 hips 高 0.95、目标 1.0 → scale=1/0.95
    const hips = avatar.nodes.get('hips')!
    const expectedHipsY = 1 + 0.05 * (1 / 0.95) + -0.05
    expect(hips.position.y).toBeCloseTo(expectedHipsY)
    // 补偿后脚底回到 rest 基准 → 残余误差 ≈ 0
    expect(snapshot.footErrorPx).not.toBeNull()
    expect(snapshot.footErrorPx!).toBeLessThan(0.5)
  })

  it('grounding=none：不补偿、footErrorPx=null、groundOffsetM=0', async () => {
    const { player } = makePlayer({ pixelsPerMeter: () => 100 })
    await player.init()
    step(player, 4)
    const snapshot = player.snapshot()
    expect(snapshot.groundOffsetM).toBe(0)
    expect(snapshot.footErrorPx).toBeNull()
  })

  it('未提供 getPixelsPerMeter：grounding=feet 时 footErrorPx=null', async () => {
    const { player } = makePlayer({ files: makeGroundingFiles(), getPixelsPerMeterMissing: true })
    await player.init()
    step(player, 4)
    expect(player.snapshot().footErrorPx).toBeNull()
  })

  it('clip 引用的骨模型缺失：identity 轨道不误报，非 identity 轨道进 missingBones', async () => {
    const files = makeClipFiles()
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    for (const clip of manifest.clips) {
      if (clip.id === 'hsr-idle') clip.file = 'hsr/idleMissingBone.json'
    }
    files['hsr/idleMissingBone.json'] = makeClipJson({
      clip: 'idleMissingBone',
      fps: 1,
      frames: 2,
      loop: true,
      bones: {
        Hips: trackNested([identityQuat(), identityQuat()]),
        UpperChest: trackNested([identityQuat(), identityQuat()]), // identity → 不报缺
        Head: trackNested([pitchQuat(0), pitchQuat(15)]) // 缺 head → 报缺
      }
    })
    const avatar = makeFakeAvatar({ missingVrmBones: ['upperChest', 'head'] })
    const { player } = makePlayer({ files, avatar })
    await player.init()
    step(player, 4)
    const snapshot = player.snapshot()
    expect(snapshot.missingBones).toEqual(['head'])
    // 缺失的 head 节点不存在，其余骨照常写
    expect(snapshot.bonesApplied).toBe(50)
  })
})

/* -------------------------------------------------------------------------- */
/* 降级 / 边界                                                                 */
/* -------------------------------------------------------------------------- */

describe('clip-player：失败降级与边界', () => {
  it('manifest 全部缺失：init 不抛，ready=false，update 安全 no-op', async () => {
    const { player } = makePlayer({ files: { 'app-catalog.json': { version: 1, clips: [] } } })
    await expect(player.init()).resolves.toBeUndefined()
    expect(player.ready).toBe(false)
    expect(() => player.update(makeInput())).not.toThrow()
    const snapshot = player.snapshot()
    expect(snapshot.ready).toBe(false)
    expect(snapshot.clipId).toBeNull()
    expect(snapshot.slot).toBeNull()
    expect(snapshot.bonesApplied).toBe(0)
  })

  it('没有 humanoid 骨：ready=false（静态 rest）', async () => {
    const avatar = makeFakeAvatar()
    avatar.nodes.clear() // 清空 fake 节点表，但 avatar.scene 仍有对象（capture 会重新遍历节点引用）
    // 直接把 fake humanoid 的 getNormalizedBoneNode 变为永远 null
    const original = avatar.humanoid.getNormalizedBoneNode
    avatar.humanoid.getNormalizedBoneNode = () => null
    try {
      const { player } = makePlayer({ avatar })
      await player.init()
      expect(player.ready).toBe(false)
    } finally {
      avatar.humanoid.getNormalizedBoneNode = original
    }
  })

  it('dispose 后可重复调用，update 安全 no-op', async () => {
    const { player } = makePlayer()
    await player.init()
    player.update(makeInput())
    expect(() => player.dispose()).not.toThrow()
    expect(() => player.dispose()).not.toThrow()
    expect(player.ready).toBe(false)
    expect(() => player.update(makeInput())).not.toThrow()
  })

  it('非走路 clip playbackRate = timeScale；walk 按速度匹配（0.5–1.6 钳制）', async () => {
    const { player } = makePlayer()
    await player.init()
    // 静止 walk → 速度 0 → 0.5 下限
    player.update(makeInput({ mood: 'walk', dt: 0 }))
    step(player, 2, { mood: 'walk' })
    expect(player.snapshot().playbackRate).toBeCloseTo(0.5)
    // 自然步速 ≈ 0.87 × 540px = 469.8px/s → 1.0
    step(player, 1, { mood: 'walk', motion: { ...makeInput().motion, velocity: { x: 470, y: 0 } } })
    expect(player.snapshot().playbackRate).toBeCloseTo(1, 1)
    // 超速 → 1.6 上限
    step(player, 1, { mood: 'walk', motion: { ...makeInput().motion, velocity: { x: 3000, y: 0 } } })
    expect(player.snapshot().playbackRate).toBeCloseTo(1.6)
  })

  it('快照可供 AnimationDebugSnapshot 映射（clipId/slot/weight 类型正确）', async () => {
    const { player } = makePlayer()
    await player.init()
    step(player, 3)
    const snapshot = player.snapshot()
    const mapped: Partial<AnimationDebugSnapshot> = {
      pose: snapshot.clipId ?? 'rest',
      poseWeight: snapshot.weight,
      footErrorPx: snapshot.footErrorPx,
      missingBones: snapshot.missingBones,
      clipId: snapshot.clipId,
      clipTimeSec: snapshot.timeSec
    }
    expect(mapped.pose).toBe('hsr-idle')
    expect(typeof mapped.poseWeight).toBe('number')
    expect(Array.isArray(mapped.missingBones)).toBe(true)
  })
})


/* -------------------------------------------------------------------------- */
/* V5：pose grounding 兜底（非 grounding='feet' 的姿态贴地） + 变体池           */
/* -------------------------------------------------------------------------- */

describe('clip-player：V5 pose grounding 兜底（坐/睡/躺不悬空）', () => {
  /** 造一份「mood 主 clip 的 hips 竖直偏移 = hipsY 米」的文件表（无 grounding 字段）。 */
  function makeOffsetFiles(options: {
    clipId: 'idle' | 'drag'
    hipsY: number
    grounding?: 'none'
  }): Record<string, unknown> {
    const files = makeClipFiles()
    const relative = options.clipId === 'idle' ? 'hsr/poseOffset.json' : 'mate/dragOffset.json'
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    const target = options.clipId === 'idle' ? 'hsr-idle' : 'mate-drag'
    for (const clip of manifest.clips) {
      if (clip.id === target) clip.file = relative
    }
    const json = makeClipJson({
      clip: options.clipId === 'idle' ? 'poseOffset' : 'dragOffset',
      fps: 1,
      frames: 2,
      loop: options.clipId === 'idle',
      ...(options.grounding === 'none' ? { grounding: 'none' } : {}),
      bones: {
        Hips: trackNested(
          [identityQuat(), identityQuat()],
          [
            [0, options.hipsY, 0],
            [0, options.hipsY, 0]
          ]
        ),
        Head: trackNested([identityQuat(), identityQuat()])
      }
    })
    files[relative] = json
    return files
  }

  it('数据未标注 grounding：用「所有 raw humanoid 骨最低点」算每 clip 常量（平移到 rest 脚骨基准）', async () => {
    // fake avatar rest 脚骨基准 y = 0.02（hips 高 1.0）；clip hips 下沉 0.8m → 最低骨 -0.78m
    const { player, avatar } = makePlayer({
      files: makeOffsetFiles({ clipId: 'idle', hipsY: -0.8 }),
      pixelsPerMeter: () => 100
    })
    await player.init()
    step(player, 4)
    const snapshot = player.snapshot()
    expect(snapshot.clipId).toBe('hsr-idle')
    // offset = restFeetLocalY(0.02) - (-0.78) = +0.8
    expect(snapshot.groundOffsetM).toBeCloseTo(0.8, 2)
    // hips = rest 1.0 + p(-0.8) + offset(0.8) = 1.0
    const hips = avatar.nodes.get('hips')!
    expect(hips.position.y).toBeCloseTo(1, 3)
    // 补偿后最低骨回到 rest 基准 → footErrorPx ≈ 0
    expect(snapshot.footErrorPx).not.toBeNull()
    expect(snapshot.footErrorPx!).toBeLessThan(0.5)
  })

  it('数据未标注 grounding 且姿态偏高：offset 为负（把身体压回地面）', async () => {
    // hips 抬高 0.3m → 最低骨 0.32m → offset = 0.02 - 0.32 = -0.3
    const { player } = makePlayer({
      files: makeOffsetFiles({ clipId: 'idle', hipsY: 0.3 }),
      pixelsPerMeter: () => 100
    })
    await player.init()
    step(player, 4)
    expect(player.snapshot().groundOffsetM).toBeCloseTo(-0.3, 2)
    expect(player.snapshot().footErrorPx!).toBeLessThan(0.5)
  })

  it('slot=drag 排除 pose grounding（拖拽由 B2 抬着，不能吸地）', async () => {
    const { player, avatar } = makePlayer({
      files: makeOffsetFiles({ clipId: 'drag', hipsY: -0.8 }),
      pixelsPerMeter: () => 100
    })
    await player.init()
    step(player, 2)
    player.update(makeInput({ dragging: true }))
    step(player, 2, { dragging: true })
    const snapshot = player.snapshot()
    expect(snapshot.slot).toBe('drag')
    expect(snapshot.clipId).toBe('mate-drag')
    expect(snapshot.groundOffsetM).toBe(0)
    expect(snapshot.footErrorPx).toBeNull()
    // 不做贴地补偿：hips 保留 clip 的 -0.8 偏移
    const hips = avatar.nodes.get('hips')!
    expect(hips.position.y).toBeCloseTo(0.2, 3)
  })

  it('显式 grounding:none 视为「数据标记不贴地」，不做 pose 兜底', async () => {
    const { player, avatar } = makePlayer({
      files: makeOffsetFiles({ clipId: 'idle', hipsY: -0.8, grounding: 'none' }),
      pixelsPerMeter: () => 100
    })
    await player.init()
    step(player, 4)
    const snapshot = player.snapshot()
    expect(snapshot.groundOffsetM).toBe(0)
    expect(snapshot.footErrorPx).toBeNull()
    const hips = avatar.nodes.get('hips')!
    expect(hips.position.y).toBeCloseTo(0.2, 3)
  })
})

describe('clip-player：V5 sit 默认坐姿与变体池（priority ≥ -9 才参与轮换）', () => {
  /** 构造 sit 分组（高优先级地面坐姿 + 低优先级窗沿躺）的 app 清单。 */
  function makeSitFiles(): Record<string, unknown> {
    const files = makeClipFiles()
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    const keep = manifest.clips.filter((clip) => clip.mood !== 'sit')
    const sitClips = [
      { id: 'mate-sit1', priority: 10 },
      { id: 'mate-sit2', priority: 9 },
      { id: 'mate-suwari3', priority: 8 },
      { id: 'mate-sitWindow', priority: -10 }
    ]
    for (const { id, priority } of sitClips) {
      const file = `mate/${id.replace('mate-', '')}.json`
      keep.push({
        id,
        mood: 'sit',
        file,
        loop: true,
        priority,
        fadeInSec: 0.15,
        fadeOutSec: 0.2
      })
      files[file] = makeClipJson({
        clip: id,
        fps: 1,
        frames: 2,
        loop: true,
        bones: {
          Hips: trackNested([identityQuat(), identityQuat()]),
          Head: trackNested([identityQuat(), identityQuat()])
        }
      })
    }
    manifest.clips = keep
    return files
  }

  it('mood=sit 默认播 priority 最高的 sit1；随机轮换只在 priority ≥ -9 的池内（窗沿躺永不参与）', async () => {
    let nowMs = 0
    const { player } = makePlayer({ files: makeSitFiles(), random: () => 0, now: () => nowMs })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'sit', dt: 0 }))
    step(player, 2, { mood: 'sit' })
    expect(player.snapshot().clipId).toBe('mate-sit1')
    // sit 间隔 15–30s（random=0 → 取下限 15s）：14.9s 不换
    nowMs = 14900
    player.update(makeInput({ mood: 'sit' }))
    expect(player.snapshot().clipId).toBe('mate-sit1')
    // 15.1s → 随机候选池 {sit2, suwari3}（当前 + 近期被排除）；random=0 → 池序第一条 sit2
    nowMs = 15100
    player.update(makeInput({ mood: 'sit' }))
    expect(player.snapshot().clipId).toBe('mate-sit2')
    // 再 15s：排除 {sit2, sit1} → suwari3
    nowMs = 30100
    player.update(makeInput({ mood: 'sit' }))
    expect(player.snapshot().clipId).toBe('mate-suwari3')
    // 再 15s：排除 {suwari3, sit2} → sit1
    nowMs = 45100
    player.update(makeInput({ mood: 'sit' }))
    expect(player.snapshot().clipId).toBe('mate-sit1')
    // 多轮都不会轮到 -10 的 sitWindow
    const seen = new Set<string>()
    for (let round = 0; round < 6; round += 1) {
      nowMs += 15100
      player.update(makeInput({ mood: 'sit' }))
      seen.add(player.snapshot().clipId!)
    }
    expect(seen.has('mate-sitWindow')).toBe(false)
    expect(CLIP_PLAYER_DEFAULTS.variantRotationMinPriority).toBe(-9)
    expect(CLIP_PLAYER_DEFAULTS.poseGroundMaxSamples).toBe(16)
    expect(VARIANT_SWITCH_CONFIG.sit.intervalSec).toEqual({ min: 15, max: 30 })
    expect(VARIANT_SWITCH_CONFIG.sit.fadeSec).toEqual({ min: 0.8, max: 1 })
  })
})


/* -------------------------------------------------------------------------- */
/* V7：手指骨 fallback（换资产兼容防御）                                        */
/* -------------------------------------------------------------------------- */

describe('clip-player：手指骨 fallback（主骨缺失回退 + 不误报 missing + warn 一次）', () => {
  /** 把 idle 主 clip 换成「LeftThumbIntermediate（→ VRM leftThumbProximal）有非 identity 旋转」的合成数据。 */
  function makeThumbFallbackFiles(): Record<string, unknown> {
    const files = makeClipFiles()
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    for (const clip of manifest.clips) {
      if (clip.id === 'hsr-idle') clip.file = 'hsr/thumbFallback.json'
    }
    files['hsr/thumbFallback.json'] = makeClipJson({
      clip: 'thumbFallback',
      fps: 1,
      frames: 2,
      loop: false,
      bones: {
        Hips: trackNested([identityQuat(), identityQuat()]),
        // mate 风格 Unity 键：LeftThumbIntermediate → VRM leftThumbProximal（本测试中缺失）
        LeftThumbIntermediate: trackNested([identityQuat(), yawQuat(30)])
      }
    })
    return files
  }

  it('主骨缺失时写到 VRM_BONE_FALLBACKS 回退骨；missingBones 不报；只 warn 一次', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const avatar = makeFakeAvatar({ missingVrmBones: ['leftThumbProximal'] })
      const { player } = makePlayer({ files: makeThumbFallbackFiles(), avatar })
      await player.init()
      await player.init() // 幂等：不应重复 warn
      player.update(makeInput({ dt: 0 }))
      step(player, 3)
      const snapshot = player.snapshot()
      expect(snapshot.missingBones).toEqual([])
      // 回退到 leftThumbMetacarpal 节点，并写入了该帧的旋转（fps=1 → t=0.3s 对应 yaw 15°? 帧 0.3 插值）
      const fallbackQuat = nodeQuat(avatar, 'leftThumbMetacarpal')
      expect(fallbackQuat).not.toEqual(identityQuat())
      const fallbackWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('leftThumbMetacarpal')
      )
      expect(fallbackWarnings).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})


/* -------------------------------------------------------------------------- */
/* V7 用户指示：多动作状态「随机播放 + 自然切换」                               */
/* -------------------------------------------------------------------------- */

/** mulberry32 可复现随机源（seeded random，断言随机规则用）。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 顺序随机源：按给定序列返回（用于精确控制间隔/淡入/相位取样）。 */
function sequenceRandom(values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)] ?? 0
}

/** 生成一个 mood 的多变体 app 清单（合成 clip；用于随机轮换单测）。 */
function makeVariantFiles(
  mood: 'idle' | 'sit' | 'walk' | 'sleep' | 'pat',
  variants: Array<{ id: string; priority: number; loop?: boolean; frames?: number; fps?: number }>
): Record<string, unknown> {
  const files = makeClipFiles()
  const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
  const keep = manifest.clips.filter((clip) => clip.mood !== mood)
  for (const variant of variants) {
    const file = `${mood}/${variant.id}.json`
    const frames = variant.frames ?? 4
    const fps = variant.fps ?? 2
    const identity = Array.from({ length: frames }, () => identityQuat())
    keep.push({
      id: variant.id,
      mood,
      file,
      loop: variant.loop ?? true,
      priority: variant.priority,
      fadeInSec: 0.15,
      fadeOutSec: 0.2
    })
    files[file] = makeClipJson({
      clip: variant.id,
      fps,
      frames,
      loop: variant.loop ?? true,
      bones: { Hips: trackNested(identity), Head: trackNested(identity) }
    })
  }
  manifest.clips = keep
  return files
}

/** 控制时钟前进直到当前 clip 换成另一条；返回是否换成功。 */
function advanceUntilVariantChange(
  player: VrmClipPlayer,
  nowState: { value: number },
  mood: 'idle' | 'walk' = 'idle',
  limitMs = 25000
): boolean {
  const current = player.snapshot().clipId
  let advanced = 0
  while (advanced < limitMs) {
    nowState.value += 250
    advanced += 250
    player.update(makeInput({ mood, dt: 0.05 }))
    if (player.snapshot().clipId !== current) return true
  }
  return false
}

const IDLE_VARIANTS = [
  { id: 'idle-high', priority: 10 },
  { id: 'idle-a', priority: 0 },
  { id: 'idle-b', priority: -1 },
  { id: 'idle-c', priority: -2 }
]

describe('clip-player：V7 多动作随机播放（随机不重复 + priority 池 + 间隔区间）', () => {
  function makeIdlePoolFiles(): Record<string, unknown> {
    return makeVariantFiles('idle', [...IDLE_VARIANTS, { id: 'idle-window-lay', priority: -10 }])
  }

  it('idle 多变体：首播最高 priority，之后随机（不连续/2 步内不重复），间隔 12–20s，-10 不参与', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeIdlePoolFiles(),
      random: seededRandom(20261109),
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    expect(player.snapshot().clipId).toBe('idle-high') // 首播 = 池内最高 priority

    const sequence = [player.snapshot().clipId!]
    const intervals: number[] = []
    for (let round = 0; round < 10; round += 1) {
      const startedAt = nowState.value
      let advanced = 0
      while (player.snapshot().clipId === sequence[sequence.length - 1] && advanced < 25000) {
        nowState.value += 250
        advanced += 250
        player.update(makeInput({ mood: 'idle', dt: 0.05 }))
      }
      const next = player.snapshot().clipId!
      expect(next).not.toBe(sequence[sequence.length - 1])
      sequence.push(next)
      intervals.push(nowState.value - startedAt)
    }
    // 2 步内不重复（avoidRecent=2：排除当前 + 上一个）
    for (let index = 2; index < sequence.length; index += 1) {
      expect(sequence[index]).not.toBe(sequence[index - 2])
    }
    // 确实随机（4 条池里至少出现过 3 条），且 priority -10 的窗沿躺永不参与
    expect(new Set(sequence).size).toBeGreaterThanOrEqual(3)
    expect(sequence).not.toContain('idle-window-lay')
    // 间隔落在 idle 配置区间 12–20s（±250ms 采样粒度）
    for (const interval of intervals) {
      expect(interval).toBeGreaterThanOrEqual(12000 - 250)
      expect(interval).toBeLessThanOrEqual(20000 + 300)
    }
  })

  it('同一 seed 的随机序列可复现（seeded random 可测）', async () => {
    async function run(seed: number): Promise<string[]> {
      const nowState = { value: 0 }
      const { player } = makePlayer({
        files: makeIdlePoolFiles(),
        random: seededRandom(seed),
        now: () => nowState.value
      })
      await player.init()
      await player.clipRegistry.whenPreloaded()
      player.update(makeInput({ mood: 'idle', dt: 0 }))
      const sequence = [player.snapshot().clipId!]
      for (let round = 0; round < 5; round += 1) {
        advanceUntilVariantChange(player, nowState)
        sequence.push(player.snapshot().clipId!)
      }
      return sequence
    }
    expect(await run(7)).toEqual(await run(7))
    expect(await run(7)).not.toEqual(await run(8))
  })
})

describe('clip-player：V7 自然切换的间隔 / crossfade / 随机相位', () => {
  it('默认配置：idle 12–20s、sit 15–30s、walk 10–18s、sleep 不轮换、其它 12–24s 兜底', () => {
    expect(VARIANT_SWITCH_CONFIG.idle.intervalSec).toEqual({ min: 12, max: 20 })
    expect(VARIANT_SWITCH_CONFIG.sit.intervalSec).toEqual({ min: 15, max: 30 })
    expect(VARIANT_SWITCH_CONFIG.walk.intervalSec).toEqual({ min: 10, max: 18 })
    expect(VARIANT_SWITCH_CONFIG.sleep.intervalSec).toBeNull()
    expect(VARIANT_SWITCH_CONFIG.default.intervalSec).toEqual({ min: 12, max: 24 })
    expect(VARIANT_SWITCH_CONFIG.default.fadeSec).toEqual({ min: 0.3, max: 0.5 })
    expect(CLIP_PLAYER_DEFAULTS.variantSwitch).toBe(VARIANT_SWITCH_CONFIG)
    // 槽位解析：已知槽位精确、未知槽位回退 default
    expect(variantSwitchConfigFor('idle')).toBe(VARIANT_SWITCH_CONFIG.idle)
    expect(variantSwitchConfigFor('walk')).toBe(VARIANT_SWITCH_CONFIG.walk)
    expect(variantSwitchConfigFor('climb')).toBe(VARIANT_SWITCH_CONFIG.default)
    expect(variantSwitchConfigFor('unknown-slot')).toBe(VARIANT_SWITCH_CONFIG.default)
  })

  it('idle 变体 crossfade 实测 0.8–1.0s（普通 mood 切换仍 0.2s 级别）', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeVariantFiles('idle', IDLE_VARIANTS),
      random: seededRandom(11),
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    // 普通 mood 切换（idle→walk→idle）的淡入由条目 fade 决定（0.2s 级别）——单独在既有用例覆盖。
    expect(advanceUntilVariantChange(player, nowState)).toBe(true)
    expect(player.snapshot().fading).toBe(true)
    // 检测到切换时已推进 0.05s；继续按 0.05s 推进直到淡入结束，总时长应 ≈0.8–1.0s
    let extraSec = 0
    while (player.snapshot().fading && extraSec < 2) {
      nowState.value += 50
      extraSec += 0.05
      player.update(makeInput({ mood: 'idle', dt: 0.05 }))
    }
    const fadeSeconds = 0.05 + extraSec
    expect(fadeSeconds).toBeGreaterThanOrEqual(0.75)
    expect(fadeSeconds).toBeLessThanOrEqual(1.1)
    expect(player.snapshot().weight).toBe(1)
  })

  it('walk 变体 crossfade 实测 0.25–0.35s', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeVariantFiles('walk', [
        { id: 'walk-a', priority: 0 },
        { id: 'walk-b', priority: -1 }
      ]),
      random: seededRandom(3),
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'walk', dt: 0 }))
    expect(player.snapshot().clipId).toBe('walk-a')
    expect(advanceUntilVariantChange(player, nowState, 'walk')).toBe(true)
    expect(player.snapshot().fading).toBe(true)
    let extraSec = 0
    while (player.snapshot().fading && extraSec < 1) {
      nowState.value += 50
      extraSec += 0.05
      player.update(makeInput({ mood: 'walk', dt: 0.05 }))
    }
    const fadeSeconds = 0.05 + extraSec
    expect(fadeSeconds).toBeGreaterThanOrEqual(0.2)
    expect(fadeSeconds).toBeLessThanOrEqual(0.4)
  })

  it('变体切换保留循环随机相位（randomPhase=true；关闭时为 0）', async () => {
    // 随机序列：初始间隔、pick、fade、phase、…
    const files = makeVariantFiles('idle', IDLE_VARIANTS)
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files,
      random: sequenceRandom([0.5, 0, 0, 0.5, 0, 0, 0, 0]),
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    nowState.value = 60000 // 远超间隔 → 本次 update 触发轮换
    player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    const switched = player.snapshot()
    expect(switched.clipId).not.toBe('idle-high')
    // 合成 clip：frames=4/fps=2 → duration=2s；phase = 0.5×2 = 1.0s（新 clip 本帧不推进时间）
    expect(switched.timeSec).toBeGreaterThan(0.9)
    expect(switched.timeSec).toBeLessThan(1.1)

    // randomPhase=false（tuning 覆盖）→ 相位固定 0
    const nowState2 = { value: 0 }
    const disabled = makePlayer({
      files,
      random: sequenceRandom([0.5, 0, 0, 0.5, 0, 0, 0, 0]),
      now: () => nowState2.value,
      tuning: { variantSwitch: { idle: { randomPhase: false } } }
    })
    await disabled.player.init()
    await disabled.player.clipRegistry.whenPreloaded()
    disabled.player.update(makeInput({ mood: 'idle', dt: 0 }))
    nowState2.value = 60000
    disabled.player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    expect(disabled.player.snapshot().timeSec).toBeLessThan(0.2)
  })

  it('sleep 不轮换（interval=null）：时钟走 120s 仍保持同一 clip', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeVariantFiles('sleep', [
        { id: 'sleep-a', priority: 0 },
        { id: 'sleep-b', priority: -1 }
      ]),
      random: seededRandom(5),
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'sleep', dt: 0 }))
    expect(player.snapshot().clipId).toBe('sleep-a')
    for (let stepIndex = 0; stepIndex < 120; stepIndex += 1) {
      nowState.value += 1000
      player.update(makeInput({ mood: 'sleep', dt: 0.1 }))
    }
    expect(player.snapshot().clipId).toBe('sleep-a')
  })
})

describe('clip-player：V7 变体切换参数可配置（VrmClipPlayerTuning）', () => {
  it('tuning 覆盖 idle 间隔/淡入/排除窗口/随机相位', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeVariantFiles('idle', IDLE_VARIANTS),
      random: () => 0,
      now: () => nowState.value,
      tuning: {
        variantSwitch: {
          idle: {
            intervalSec: { min: 3, max: 3 },
            fadeSec: { min: 0.4, max: 0.4 },
            avoidRecent: 1,
            randomPhase: false
          }
        }
      }
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    // 自定义 3s 间隔：2.9s 不换、3.1s 换
    nowState.value = 2900
    player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    expect(player.snapshot().clipId).toBe('idle-high')
    nowState.value = 3100
    player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    const changed = player.snapshot()
    expect(changed.clipId).not.toBe('idle-high')
    expect(changed.timeSec).toBeLessThan(0.2) // randomPhase=false → 相位 0
    // 自定义 0.4s crossfade（update 的 dt 被钳制到 0.1s/帧）：0.3s 时仍在淡入，0.6s 时已完成
    expect(changed.fading).toBe(true)
    for (let index = 0; index < 2; index += 1) {
      nowState.value += 100
      player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    }
    expect(player.snapshot().fading).toBe(true)
    for (let index = 0; index < 3; index += 1) {
      nowState.value += 100
      player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    }
    expect(player.snapshot().fading).toBe(false)
  })

  it('weightedByPriority 可配置：仍遵守排除当前/近期，且只从池内选', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeVariantFiles('idle', IDLE_VARIANTS),
      random: seededRandom(21),
      now: () => nowState.value,
      tuning: { variantSwitch: { idle: { weightedByPriority: true } } }
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    const sequence = [player.snapshot().clipId!]
    for (let round = 0; round < 8; round += 1) {
      advanceUntilVariantChange(player, nowState)
      sequence.push(player.snapshot().clipId!)
    }
    for (let index = 1; index < sequence.length; index += 1) {
      expect(sequence[index]).not.toBe(sequence[index - 1])
      expect(IDLE_VARIANTS.map((variant) => variant.id)).toContain(sequence[index])
    }
  })
})


/* -------------------------------------------------------------------------- */
/* 2026-11-10：idle 同级默认动作（hsr-idle / adv-idle 同 priority 10，进入/回归随机） */
/* -------------------------------------------------------------------------- */

describe('clip-player：idle 同级默认动作（hsr-idle / adv-idle）', () => {
  /** idle 池：2 条 priority 10 同级主待机 + 低优先级变体（模拟真实 app-manifest）。 */
  function makeTiedIdleFiles(): Record<string, unknown> {
    return makeVariantFiles('idle', [
      { id: 'hsr-idle', priority: 10 },
      { id: 'adv-idle', priority: 10 },
      { id: 'idle-show', priority: 8 },
      { id: 'mate-idle', priority: 0 }
    ])
  }

  async function idleClipFor(randomValue: number): Promise<string | null> {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeTiedIdleFiles(),
      random: () => randomValue,
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    return player.snapshot().clipId
  }

  it('进入 idle：在同 priority 10 的 hsr-idle / adv-idle 之间等概率随机（random 决定取哪条）', async () => {
    // 并列 2 条：random 0.1 → 第 1 条 hsr-idle；0.9 → 第 2 条 adv-idle。
    expect(await idleClipFor(0.1)).toBe('hsr-idle')
    expect(await idleClipFor(0.9)).toBe('adv-idle')
  })

  it('一次性 clip 播完回归 idle：重新在 priority 10 同级里随机（不落到低优先级变体）', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeTiedIdleFiles(),
      random: () => 0.9,
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    await player.clipRegistry.loadClip('hsr-skill01')
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    expect(['hsr-idle', 'adv-idle']).toContain(player.snapshot().clipId)

    expect(player.playClipById('hsr-skill01', { loop: false })).toBe(true)
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    for (let index = 0; index < 30 && player.snapshot().slot !== 'idle'; index += 1) {
      nowState.value += 100
      player.update(makeInput({ mood: 'idle', dt: 0.1 }))
    }
    expect(player.snapshot().slot).toBe('idle')
    expect(['hsr-idle', 'adv-idle']).toContain(player.snapshot().clipId)
    expect(player.snapshot().clipId).not.toBe('mate-idle')
  })

  it('idle 定时轮换保持开启（默认 12–20s 到点仍切到其它 idle 变体）', async () => {
    const nowState = { value: 0 }
    const { player } = makePlayer({
      files: makeTiedIdleFiles(),
      random: () => 0.9,
      now: () => nowState.value
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    player.update(makeInput({ mood: 'idle', dt: 0 }))
    const before = player.snapshot().clipId
    let rotated = false
    // random 0.9 → idle 间隔 = 12 + 0.9×8 = 19.2s；推进 25s 应到点轮换一次。
    for (let index = 0; index < 250 && !rotated; index += 1) {
      nowState.value += 100
      player.update(makeInput({ mood: 'idle', dt: 0.1 }))
      if (player.snapshot().clipId !== before) rotated = true
    }
    expect(rotated).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* V11：稀有权重随机（idle pose 变体）+ 手动 clip 清除 + catalog-only 播放       */
/* -------------------------------------------------------------------------- */

/** 12 条普通 idle 变体（priority 10…-6）+ 3 条 pose 稀有变体（-7/-8/-8），模拟真实 app-manifest。 */
function makeRareIdleFiles(): Record<string, unknown> {
  const normalPriorities = [10, 8, 5, 4, 3, 0, -1, -2, -3, -4, -5, -6]
  return makeVariantFiles('idle', [
    ...normalPriorities.map((priority, index) => ({ id: `idle-n${index}`, priority })),
    { id: 'pose1', priority: -7 },
    { id: 'pose2', priority: -8 },
    { id: 'pose3', priority: -8 }
  ])
}

/** 统计 N 次变体轮换里稀有 pose 变体出现的比例（seeded random 可复现）。 */
async function measureRareRatio(
  tuning: VrmClipPlayerTuning | undefined,
  rotations = 1000
): Promise<number> {
  const nowState = { value: 0 }
  const { player } = makePlayer({
    files: makeRareIdleFiles(),
    random: seededRandom(20261110),
    now: () => nowState.value,
    ...(tuning !== undefined ? { tuning } : {})
  })
  await player.init()
  await player.clipRegistry.whenPreloaded()
  player.update(makeInput({ mood: 'idle', dt: 0 }))
  const rareIds = new Set(['pose1', 'pose2', 'pose3'])
  let rare = 0
  for (let round = 0; round < rotations; round += 1) {
    nowState.value += 25000 // 超过 idle 最大间隔 20s，保证本轮到点
    player.update(makeInput({ mood: 'idle', dt: 0.01 }))
    if (rareIds.has(player.snapshot().clipId!)) rare += 1
  }
  return rare / rotations
}

describe('clip-player：V11 稀有加权随机（idle pose1-3）', () => {
  it('默认稀有权重 0.3：1000 次轮换中 pose 占比 ~7%（5–10%）', async () => {
    expect(RARE_VARIANT_PRIORITY_THRESHOLD).toBe(-7)
    expect(RARE_VARIANT_WEIGHT).toBe(0.3)
    expect(CLIP_PLAYER_DEFAULTS.rareVariant).toEqual({ priorityThreshold: -7, weight: 0.3 })
    const ratio = await measureRareRatio(undefined)
    expect(ratio).toBeGreaterThan(0.04)
    expect(ratio).toBeLessThan(0.11)
  })

  it('tuning.rareVariant.weight=1 → 稀有变体回退为均匀概率（占比明显升高）', async () => {
    const ratio = await measureRareRatio({ rareVariant: { weight: 1 } })
    expect(ratio).toBeGreaterThan(0.13)
  })

  it('tuning.rareVariant.priorityThreshold 可覆盖（-100 → 全部视为稀有，等价均匀）', async () => {
    const ratio = await measureRareRatio({
      rareVariant: { priorityThreshold: -100, weight: 0.3 }
    })
    expect(ratio).toBeGreaterThan(0.13)
  })
})

describe('clip-player：V11 stopManualClip（打断入场/错误过场等手动 clip）', () => {
  it('playClipById(loop=true) 后 stopManualClip(fadeSec) → 下一帧回 mood clip 并按指定 fade 淡出', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    await player.clipRegistry.loadClip('hsr-skill01')
    expect(player.playClipById('hsr-skill01', { loop: true })).toBe(true)
    player.update(makeInput({ dt: 0 }))
    expect(player.snapshot().clipId).toBe('hsr-skill01')
    expect(player.snapshot().slot).toBe('manual')

    player.stopManualClip(0.5)
    player.update(makeInput({ dt: 0 }))
    const back = player.snapshot()
    expect(back.clipId).toBe('hsr-idle') // 回当前 mood 选片
    expect(back.slot).toBe('idle')
    expect(back.fading).toBe(true)
    expect(back.weight).toBe(0)
    // 指定 0.5s fade：0.3s 时仍在淡入，0.6s 后完成
    for (let index = 0; index < 3; index += 1) player.update(makeInput({ dt: 0.1 }))
    expect(player.snapshot().fading).toBe(true)
    for (let index = 0; index < 3; index += 1) player.update(makeInput({ dt: 0.1 }))
    expect(player.snapshot().fading).toBe(false)
    expect(player.snapshot().weight).toBe(1)
  })

  it('无手动 clip 时 no-op（不抛、保持当前 mood clip）', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    step(player, 2)
    const before = player.snapshot().clipId
    expect(() => player.stopManualClip()).not.toThrow()
    player.update(makeInput({ dt: 0.1 }))
    expect(player.snapshot().clipId).toBe(before)
    // dispose 后调用也不抛
    player.dispose()
    expect(() => player.stopManualClip()).not.toThrow()
  })

  it('手动 hold=true clip 也能被 stopManualClip 打断回 mood', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    await player.clipRegistry.loadClip('hsr-skill01')
    player.playClipById('hsr-skill01', { loop: false, hold: true, fadeSec: 0 })
    player.update(makeInput({ dt: 0 }))
    step(player, 20) // 播完并 hold 在末帧
    expect(player.snapshot().clipId).toBe('hsr-skill01')
    player.stopManualClip()
    player.update(makeInput({ dt: 0 }))
    expect(player.snapshot().slot).toBe('idle')
  })
})

describe('clip-player：V11 catalog-only clip 手动播放（loop/hold 覆盖、播完回 mood）', () => {
  const CATALOG_ONLY_IDS = ['hsr-skill01', 'hsr-skill02', 'hsr-breaked', 'hsr-revive'] as const

  it('四个 catalog-only id 都能从 registry 懒加载并 playClipById 播放', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    for (const id of CATALOG_ONLY_IDS) {
      const clip = await player.clipRegistry.loadClip(id)
      expect(clip, `${id} 懒加载失败`).not.toBeNull()
      expect(player.clipRegistry.getPlayableEntry(id)).not.toBeNull()
      expect(player.playClipById(id)).toBe(true)
      player.update(makeInput({ dt: 0 }))
      expect(player.snapshot().clipId).toBe(id)
      expect(player.snapshot().slot).toBe('manual')
    }
  })

  it('loop=true 覆盖：一次性源 clip 循环播放不结束', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    await player.clipRegistry.loadClip('hsr-skill01')
    expect(player.playClipById('hsr-skill01', { loop: true, fadeSec: 0 })).toBe(true)
    player.update(makeInput({ dt: 0 }))
    step(player, 40) // 4s 远超片段时长（1s），仍应停在手动 clip
    expect(player.snapshot().clipId).toBe('hsr-skill01')
    expect(player.snapshot().slot).toBe('manual')
  })

  it('hold=true 覆盖：非循环 clip 播完停在末帧，不自动回 mood', async () => {
    const { player } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    await player.clipRegistry.loadClip('hsr-skill02')
    expect(player.playClipById('hsr-skill02', { loop: false, hold: true, fadeSec: 0 })).toBe(true)
    player.update(makeInput({ dt: 0 }))
    step(player, 30)
    expect(player.snapshot().clipId).toBe('hsr-skill02')
    expect(player.snapshot().slot).toBe('manual')
    expect(player.snapshot().timeSec).toBeCloseTo(1) // (frames-1)/fps = 1s
  })

  it('hold=false 覆盖：非循环 clip 播完自动回 mood clip', async () => {
    const { player } = makePlayer({ random: () => 0 })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    await player.clipRegistry.loadClip('hsr-revive')
    expect(player.playClipById('hsr-revive', { loop: false, fadeSec: 0 })).toBe(true)
    player.update(makeInput({ dt: 0 }))
    expect(player.snapshot().slot).toBe('manual')
    step(player, 30) // 3s > 1s，播完回 mood
    expect(player.snapshot().slot).toBe('idle')
    expect(['hsr-idle', 'mate-idle']).toContain(player.snapshot().clipId)
  })
})


/* -------------------------------------------------------------------------- */
/* V13 A：坐姿锚点高度 poseHipsAboveLowestM（avatar.scene 局部坐标，米）       */
/* -------------------------------------------------------------------------- */

/** 独立测量 fake 骨架当前帧「hips 相对全 raw 骨最低点」高度（与 player 内部实现解耦）。 */
function measureFakeHipsAboveLowest(avatar: FakeAvatarHandle): number | null {
  const scene = avatar.scene
  scene.updateWorldMatrix(true, true)
  const temp = new Vector3()
  let minY = Infinity
  const nodes = [...avatar.nodes.values()]
  if (nodes.length === 0) return null
  for (const node of nodes) {
    node.getWorldPosition(temp)
    scene.worldToLocal(temp)
    if (temp.y < minY) minY = temp.y
  }
  const hips = avatar.nodes.get('hips')
  if (!hips || !Number.isFinite(minY)) return null
  hips.getWorldPosition(temp)
  scene.worldToLocal(temp)
  return temp.y - minY
}

describe('clip-player：V13 A 坐姿锚点高度 poseHipsAboveLowestM', () => {
  it('显式 grounding=none（默认 idle）：字段非 null 且等于独立测量（fake 直腿骨架 ≈0.98）', async () => {
    const { player, avatar } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    step(player, 3)
    const snapshot = player.snapshot()
    expect(snapshot.poseHipsAboveLowestM).not.toBeNull()
    const expected = measureFakeHipsAboveLowest(avatar)
    expect(expected).not.toBeNull()
    expect(snapshot.poseHipsAboveLowestM!).toBeCloseTo(expected!, 5)
    // fake 骨架直腿：hips y=1.0、最低骨（toes）y=0.02 → ≈0.98m
    expect(snapshot.poseHipsAboveLowestM!).toBeCloseTo(0.98, 2)
    // 非 walk clip 的步幅字段为 null
    expect(snapshot.clipStrideGroundSpeedMps).toBeNull()
  })

  it('pose 模式（未标注 grounding）与 feet 模式都能算出字段（与独立测量一致）', async () => {
    // pose 模式：默认 walk clip（mate 集无 grounding 字段）
    const posePlayer = makePlayer({ pixelsPerMeter: () => 300 })
    await posePlayer.player.init()
    await posePlayer.player.clipRegistry.whenPreloaded()
    step(posePlayer.player, 3, { mood: 'walk' })
    const poseSnapshot = posePlayer.player.snapshot()
    expect(poseSnapshot.poseHipsAboveLowestM).not.toBeNull()
    expect(poseSnapshot.poseHipsAboveLowestM!).toBeCloseTo(
      measureFakeHipsAboveLowest(posePlayer.avatar)!,
      5
    )

    // feet 模式：把 idle 主 clip 换成显式 grounding='feet'
    const files = makeClipFiles()
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    for (const clip of manifest.clips) {
      if (clip.id === 'hsr-idle') clip.file = 'hsr/feetIdle.json'
    }
    files['hsr/feetIdle.json'] = makeClipJson({
      clip: 'feetIdle',
      fps: 1,
      frames: 2,
      loop: true,
      grounding: 'feet',
      bones: {
        Hips: trackNested([identityQuat(), identityQuat()]),
        Head: trackNested([identityQuat(), identityQuat()])
      }
    })
    const feetPlayer = makePlayer({ files, pixelsPerMeter: () => 300 })
    await feetPlayer.player.init()
    await feetPlayer.player.clipRegistry.whenPreloaded()
    step(feetPlayer.player, 4)
    const feetSnapshot = feetPlayer.player.snapshot()
    expect(feetSnapshot.poseHipsAboveLowestM).not.toBeNull()
    expect(feetSnapshot.poseHipsAboveLowestM!).toBeCloseTo(
      measureFakeHipsAboveLowest(feetPlayer.avatar)!,
      5
    )
  })

  it('drag 模式（slot=drag）也计算字段；无 active/未就绪时为 null 且不抛', async () => {
    const { player, avatar } = makePlayer()
    await player.init()
    await player.clipRegistry.whenPreloaded()
    step(player, 2)
    player.update(makeInput({ dragging: true }))
    step(player, 2, { dragging: true })
    const snapshot = player.snapshot()
    expect(snapshot.slot).toBe('drag')
    expect(snapshot.poseHipsAboveLowestM).not.toBeNull()
    expect(snapshot.poseHipsAboveLowestM!).toBeCloseTo(measureFakeHipsAboveLowest(avatar)!, 5)

    // 未 init / 无 active：null
    const fresh = makePlayer()
    expect(fresh.player.snapshot().poseHipsAboveLowestM).toBeNull()
    expect(() => fresh.player.update(makeInput())).not.toThrow()
    expect(fresh.player.snapshot().poseHipsAboveLowestM).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* V13 B：walk 步幅地速 strideGroundSpeed 与 playbackRate 校准                  */
/* -------------------------------------------------------------------------- */

/** 让 walk 主 clip 变成「hips 沿水平方向匀速平移」的合成 clip：脚与 hips 同步平移，支撑相全帧。 */
function makeLinearStrideWalkFiles(stepMeters = 0.12): Record<string, unknown> {
  const files = makeClipFiles()
  const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
  const frames = 6
  const fps = 6
  for (const clip of manifest.clips) {
    if (clip.id === 'mate-walk') clip.file = 'walk/stride.json'
  }
  const identity = Array.from({ length: frames }, () => identityQuat())
  const positions = Array.from({ length: frames }, (_, index) => [index * stepMeters, 0, 0] as [number, number, number])
  files['walk/stride.json'] = makeClipJson({
    clip: 'stride',
    fps,
    frames,
    // 非循环（Hips.p 线性平移不是周期运动；loop 会破坏首尾连续性，便于精确断言步幅）
    loop: false,
    bones: {
      Hips: trackNested(identity, positions),
      Head: trackNested(identity)
    }
  })
  return files
}

describe('clip-player：V13 B walk 步幅地速校准（减少脚滑）', () => {
  it('FK 实测步幅地速：水平匀速平移 Δx=0.12m/帧、fps=6 → 0.72 m/s', async () => {
    const { player } = makePlayer({
      files: makeLinearStrideWalkFiles(0.12),
      pixelsPerMeter: () => 300
    })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    step(player, 2, { mood: 'walk' })
    const snapshot = player.snapshot()
    expect(snapshot.clipStrideGroundSpeedMps).not.toBeNull()
    // Δx=0.12m，Δt=1/6s → 0.72 m/s（左右脚一致，中位数相同）
    expect(snapshot.clipStrideGroundSpeedMps!).toBeCloseTo(0.72, 2)
  })

  it('playbackRate = 移动速度 / (stride × ppm)（ppm 翻倍 → rate 减半）', async () => {
    const files = makeLinearStrideWalkFiles(0.12)
    const makeWalkPlayer = async (ppm: number) => {
      const { player } = makePlayer({ files, pixelsPerMeter: () => ppm })
      await player.init()
      await player.clipRegistry.whenPreloaded()
      step(player, 2, { mood: 'walk' })
      return player
    }
    const player300 = await makeWalkPlayer(300)
    const player600 = await makeWalkPlayer(600)
    const walkInput = (speed: number) =>
      makeInput({
        mood: 'walk',
        motion: { ...makeInput().motion, velocity: { x: speed, y: 0 } }
      })
    // stride=0.72m/s；ppm300 → 216px/s；speed=150 → rate=150/216≈0.694
    player300.update(walkInput(150))
    const rate150 = player300.snapshot().playbackRate
    expect(rate150).toBeCloseTo(150 / (0.72 * 300), 2)
    // 同 ppm、速度翻倍（300px/s）→ rate 翻倍（1.389，仍在钳制区间内）
    player300.update(walkInput(300))
    const rate300 = player300.snapshot().playbackRate
    expect(rate300).toBeCloseTo(300 / (0.72 * 300), 2)
    expect(rate300).toBeCloseTo(rate150 * 2, 1)
    // ppm 翻倍（600）→ 同样速度下 rate 减半 = 0.694
    player600.update(walkInput(300))
    const rate600 = player600.snapshot().playbackRate
    expect(rate600).toBeCloseTo(300 / (0.72 * 600), 2)
    expect(rate300 / rate600).toBeCloseTo(2, 1)
  })

  it('循环 clip 左右脚交替摆动（loop 接缝支撑相）：测得合理步幅且不报错', async () => {
    const files = makeClipFiles()
    const manifest = files['app-manifest.json'] as { clips: Array<Record<string, unknown>> }
    for (const clip of manifest.clips) {
      if (clip.id === 'mate-walk') clip.file = 'walk/swing.json'
    }
    const frames = 16
    const fps = 8
    const leftLeg = Array.from({ length: frames }, (_, index) =>
      pitchQuat(20 * Math.sin((2 * Math.PI * index) / frames))
    )
    const rightLeg = Array.from({ length: frames }, (_, index) =>
      pitchQuat(-20 * Math.sin((2 * Math.PI * index) / frames))
    )
    const identity = Array.from({ length: frames }, () => identityQuat())
    files['walk/swing.json'] = makeClipJson({
      clip: 'swing',
      fps,
      frames,
      loop: true,
      bones: {
        Hips: trackNested(identity),
        LeftUpperLeg: trackNested(leftLeg),
        RightUpperLeg: trackNested(rightLeg)
      }
    })
    const { player } = makePlayer({ files, pixelsPerMeter: () => 311 })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    step(player, 2, { mood: 'walk' })
    const stride = player.snapshot().clipStrideGroundSpeedMps
    expect(stride).not.toBeNull()
    // 摆幅 20°、周期 2s、腿长约 0.98m → 过零附近脚速 ≈0.9–1.1 m/s（采样离散，放宽区间）
    expect(stride!).toBeGreaterThan(0.5)
    expect(stride!).toBeLessThan(1.6)
  })

  it('stride 不可用（脚静止/非 walk）→ 回退旧公式与 null 字段', async () => {
    // 默认 fixture 的 walk clip 只有 Head 动作、脚静止 → stride 不可用
    const { player } = makePlayer({ pixelsPerMeter: () => 300 })
    await player.init()
    await player.clipRegistry.whenPreloaded()
    step(player, 2, { mood: 'walk' })
    const snapshot = player.snapshot()
    expect(snapshot.clipStrideGroundSpeedMps).toBeNull()
    // 回退旧公式：speed / (0.87 × petRect.height=540) = 300/469.8
    player.update(
      makeInput({
        mood: 'walk',
        motion: { ...makeInput().motion, velocity: { x: 300, y: 0 } }
      })
    )
    expect(player.snapshot().playbackRate).toBeCloseTo(300 / (0.87 * 540), 2)
    // 非 walk clip（idle）步幅字段为 null
    player.update(makeInput({ mood: 'idle' }))
    expect(player.snapshot().clipStrideGroundSpeedMps).toBeNull()
  })
})
