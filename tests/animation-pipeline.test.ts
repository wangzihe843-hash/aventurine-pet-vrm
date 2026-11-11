/**
 * B3 单测：完整动画管线（纯逻辑，不依赖 three）。
 *
 * 用本模型实测 rest 位置构造夹具，跑 `AnimationPipeline.update(input, nowMs)`：
 * 姿态选择/过渡、接地误差、坐/睡/拖拽/腾空、摸头反应、表情 morph、look-at、眨眼、
 * 口型、待机变体、调试快照形状、无 NaN 稳定性。
 */
import { describe, expect, it } from 'vitest'

import { AnimationPipeline, type PipelineRig } from '../src/renderer/src/animation/legacy/pipeline'
import { BASE_POSE_IDS } from '../src/renderer/src/animation/legacy/poses'
import { FORBIDDEN_BONES } from '../src/renderer/src/animation/legacy/skeleton'
import type { AnimationInput } from '../src/renderer/src/core/wave2-contract'
import type { PetMood, Rect } from '../src/shared/types'
import type { Vec3 } from '../src/renderer/src/animation/legacy/types'

const MODEL_HEIGHT = 21.681
const PET_RECT: Rect = { x: 100, y: 200, width: 398, height: 540 }

/** 模型实测 rest 位置（与 tests/tmp/bones.json 一致；B3 需要的骨）。 */
const REST: Record<string, Vec3> = {
  センター: { x: 0, y: 8.93, z: 0 },
  下半身: { x: 0, y: 13.33, z: -0.071 },
  上半身: { x: 0, y: 13.5, z: -0.071 },
  上半身2: { x: 0, y: 15.769, z: -0.071 },
  首: { x: 0, y: 18.321, z: -0.595 },
  頭: { x: 0, y: 19.244, z: -0.54 },
  左足D: { x: 0.943, y: 12.234, z: -0.071 },
  左ひざD: { x: 1.046, y: 6.784, z: -0.086 },
  左足首D: { x: 1.151, y: 1.229, z: -0.503 },
  右足D: { x: -0.943, y: 12.234, z: -0.071 },
  右ひざD: { x: -1.046, y: 6.784, z: -0.086 },
  右足首D: { x: -1.151, y: 1.229, z: -0.503 },
  '辮子1-1': { x: 0.468, y: 19.324, z: -0.776 },
  '辮子1-2': { x: 0.522, y: 19.124, z: -0.58 },
  '辮子1-3': { x: 0.575, y: 18.819, z: -0.378 },
  '辮子1-4': { x: 0.52, y: 18.599, z: -0.099 },
  '辮子1-5': { x: 0.488, y: 18.372, z: 0.041 },
  '辮子2-1': { x: 0.432, y: 18.604, z: 0 },
  '辮碎髮': { x: 0.12, y: 19.328, z: -0.939 }
}

function makeRig(missingBones: string[] = []): PipelineRig {
  return { restPositions: REST, modelHeight: MODEL_HEIGHT, missingBones }
}

function makeInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
  const motion = {
    feet: { x: 300, y: 740 },
    velocity: { x: 0, y: 0 },
    facing: 'front' as const,
    grounded: true,
    surfaceId: 'screen-bottom',
    airborne: false,
    ...(overrides.motion ?? {})
  }
  return {
    dt: 1 / 60,
    mood: 'idle',
    motion,
    facing: motion.facing,
    lookTarget: null,
    petRect: PET_RECT,
    viewportHeight: 961,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides,
    motion
  }
}

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** 推进若干帧，返回最后一帧。 */
function run(pipeline: AnimationPipeline, frames: number, input: AnimationInput, startNow = 1000, dt = 1 / 60) {
  let now = startNow
  let frame = pipeline.update(input, now)
  for (let i = 1; i < frames; i += 1) {
    now += dt * 1000
    frame = pipeline.update({ ...input, dt }, now)
  }
  return frame
}

describe('Pipeline：基础姿态 / 接地 / 输出形状', () => {
  it('首帧即自然站姿（非 A-pose），含双眼/腿 D 链/发辫骨，不写禁用骨', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    const frame = pipeline.update(makeInput(), 1000)
    const pose = frame.boneQuaternions
    expect(pose.get('左腕')).toBeDefined()
    expect(pose.get('右腕')).toBeDefined()
    expect(pose.get('上半身')).toBeDefined()
    expect(pose.get('首')).toBeDefined()
    expect(pose.get('頭')).toBeDefined()
    expect(pose.get('左足D')).toBeDefined()
    expect(pose.get('右ひざD')).toBeDefined()
    expect(pose.get('左足首D')).toBeDefined()
    expect(pose.get('左目先')).toBeDefined()
    expect(pose.get('右目先')).toBeDefined()
    expect(pose.get('辮子1-2')).toBeDefined()
    for (const forbidden of FORBIDDEN_BONES) {
      expect(pose.has(forbidden)).toBe(false)
    }
    expect(frame.debug.pose).toBe('stand')
    expect(typeof frame.debug.poseWeight).toBe('number')
  })

  it('stand：脚底贴地误差 < 2px；センター下沉；手放下（相对 A-pose 有明显 Z 旋转）', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    const frame = pipeline.update(makeInput(), 1000)
    expect(frame.debug.footErrorPx).not.toBeNull()
    expect(frame.debug.footErrorPx!).toBeLessThan(2)
    expect(frame.centerOffsetY).toBeLessThan(0)
    const arm = frame.boneQuaternions.get('左腕')!
    // 左腕 Z 负角 = 手臂放下（survey §2.3）
    expect(Math.abs(arm.z) + Math.abs(arm.w - 1)).toBeGreaterThan(0.05)
  })

  it('调试快照字段形状符合契约', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    pipeline.update(makeInput(), 1000)
    const snapshot = pipeline.getDebugSnapshot()
    expect(typeof snapshot.pose).toBe('string')
    expect(typeof snapshot.poseWeight).toBe('number')
    expect(typeof snapshot.activeLayers).toBe('number')
    expect(snapshot.gesture === null || typeof snapshot.gesture === 'string').toBe(true)
    expect(typeof snapshot.blink).toBe('number')
    expect(typeof snapshot.smile).toBe('number')
    expect(typeof snapshot.mouthOpen).toBe('number')
    expect(snapshot.lookYaw === null || typeof snapshot.lookYaw === 'number').toBe(true)
    expect(Array.isArray(snapshot.missingBones)).toBe(true)
    expect(snapshot.morphs).toBeDefined()
    expect(snapshot.footErrorPx === null || typeof snapshot.footErrorPx === 'number').toBe(true)
    expect(snapshot.spring).toBeDefined()
  })

  it('切换 12 个基础姿态都不产生 NaN，且 grounded 姿态脚底误差 < 2px', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(2) })
    const groundedPoses = BASE_POSE_IDS.filter((id) =>
      ['stand', 'walk', 'pat', 'celebrate', 'sad', 'busy'].includes(id)
    )
    let now = 1000
    for (const poseId of BASE_POSE_IDS) {
      expect(pipeline.setPose(poseId)).toBe(true)
      for (let i = 0; i < 20; i += 1) {
        now += 1000 / 60
        const frame = pipeline.update(makeInput(), now)
        for (const [, quat] of frame.boneQuaternions) {
          expect(Number.isFinite(quat.x)).toBe(true)
          expect(Number.isFinite(quat.y)).toBe(true)
          expect(Number.isFinite(quat.z)).toBe(true)
          expect(Number.isFinite(quat.w)).toBe(true)
        }
        expect(Number.isFinite(frame.centerOffsetY)).toBe(true)
        if (groundedPoses.includes(poseId) && frame.debug.pose === poseId) {
          expect(frame.debug.footErrorPx!).toBeLessThan(2)
        }
      }
    }
  })

  it('未知姿态 setPose 返回 false；setPose("auto") 清除强制并回到 mood 姿态', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    expect(pipeline.setPose('nope')).toBe(false)
    expect(pipeline.setPose('sit')).toBe(true)
    run(pipeline, 40, makeInput({ mood: 'idle' }), 1000)
    expect(pipeline.getDebugSnapshot().pose).toBe('sit')
    expect(pipeline.setPose('auto')).toBe(true)
    run(pipeline, 40, makeInput({ mood: 'idle' }), 3000)
    expect(pipeline.getDebugSnapshot().pose).toBe('stand')
  })

  it('12 个 mood 在管线里映射到正确姿态（含拖拽/腾空即时覆盖）', () => {
    const expectations: Array<[PetMood, string, Partial<AnimationInput>?]> = [
      ['idle', 'stand'],
      ['walk', 'walk'],
      ['climb', 'climb'],
      ['sit', 'sit'],
      ['sleep', 'sleep'],
      ['drag', 'drag'],
      ['fall', 'fall'],
      ['pat', 'pat'],
      ['grabWindow', 'climb'],
      ['dshBusy', 'busy'],
      ['dshDone', 'celebrate'],
      ['dshError', 'sad']
    ]
    for (const [mood, expected] of expectations) {
      const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
      const frame = run(pipeline, 3, makeInput({ mood }), 1000)
      expect(frame.debug.pose, mood).toBe(expected)
    }
    // 拖拽 / 腾空覆盖 mood
    const dragging = new AnimationPipeline(makeRig(), { random: seeded(1) })
    expect(run(dragging, 3, makeInput({ mood: 'idle', dragging: true }), 1000).debug.pose).toBe('drag')
    const airborne = new AnimationPipeline(makeRig(), { random: seeded(1) })
    expect(
      run(airborne, 3, makeInput({ mood: 'idle', motion: { airborne: true, grounded: false } as never }), 1000)
        .debug.pose
    ).toBe('fall')
  })
})

describe('Pipeline：坐/睡/拖拽/腾空', () => {
  it('sit：センター 下沉到坐面（≈ −12.2 单位），脚底误差为 null', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    pipeline.setPose('sit')
    const frame = run(pipeline, 60, makeInput(), 1000)
    expect(frame.centerOffsetY).toBeLessThan(-11)
    expect(frame.debug.footErrorPx).toBeNull()
    // 腿垂下的 FK 角：大腿前摆（X 负角）明显
    const thigh = frame.boneQuaternions.get('左足D')!
    const angle = 2 * Math.acos(Math.min(1, Math.abs(thigh.w)))
    expect(angle).toBeGreaterThan(0.5)
  })

  it('sleep：センター 翻滚（侧躺）且脚底误差为 null；呼吸更慢', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    pipeline.setPose('sleep')
    const frame = run(pipeline, 90, makeInput(), 1000)
    expect(frame.debug.footErrorPx).toBeNull()
    const roll = 2 * Math.acos(Math.min(1, Math.abs(frame.centerQuaternion.w)))
    expect(roll).toBeGreaterThan((60 * Math.PI) / 180)
    // 侧躺翻滚后贴地：centerY ≈ −2.05（截图回环校准值）
    expect(frame.centerOffsetY).toBeLessThan(-1.5)
    expect(frame.centerOffsetY).toBeGreaterThan(-3)
  })

  it('drag/fall：脚底误差为 null；手臂上举（drag）', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    expect(run(pipeline, 20, makeInput({ dragging: true }), 1000).debug.footErrorPx).toBeNull()
    const airborne = new AnimationPipeline(makeRig(), { random: seeded(1) })
    const frame = run(
      airborne,
      20,
      makeInput({ motion: { airborne: true, grounded: false } as never }),
      1000
    )
    expect(frame.debug.footErrorPx).toBeNull()
    expect(frame.debug.pose).toBe('fall')
  })
})

describe('Pipeline：反应手势 / 表情 / 注视 / 眨眼 / 口型', () => {
  it('摸头：patReact 手势出现，过程中出现 照れ（shy）与笑眼', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(3) })
    let frame = pipeline.update(makeInput({ events: [{ kind: 'pat' }], mood: 'pat' }), 1000)
    const gestures = new Set<string | null>()
    const morphsSeen = new Set<string>()
    for (let i = 0; i < 150; i += 1) {
      const now = 1000 + (i + 1) * (1000 / 60)
      frame = pipeline.update(makeInput({ mood: 'pat', dt: 1 / 60 }), now)
      gestures.add(frame.debug.gesture)
      for (const morph of Object.keys(frame.debug.morphs ?? {})) morphsSeen.add(morph)
    }
    expect(gestures.has('patReact')).toBe(true)
    expect(morphsSeen.has('照れ')).toBe(true)
    expect(gestures.has(null)).toBe(true) // 播放完回 null
  })

  it('戳头/戳身/戳腿：按部位映射不同反应手势', () => {
    const cases: Array<['head' | 'body' | 'leg', string]> = [
      ['head', 'pokedHead'],
      ['body', 'pokedBody'],
      ['leg', 'pokedLeg']
    ]
    for (const [region, expected] of cases) {
      const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
      const frame = pipeline.update(makeInput({ events: [{ kind: 'poke', region }] }), 1000)
      expect(frame.debug.gesture).toBe(expected)
    }
  })

  it('被甩出/落地：thrown/landed 手势；落地时重心明显下沉', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    const thrown = pipeline.update(makeInput({ events: [{ kind: 'thrown', speed: 1500 }] }), 1000)
    expect(thrown.debug.gesture).toBe('thrown')
    const landing = new AnimationPipeline(makeRig(), { random: seeded(1) })
    const baseline = landing.update(makeInput(), 1000).centerOffsetY
    const frame = landing.update(makeInput({ events: [{ kind: 'landed', impactSpeed: 2200 }] }), 1016)
    expect(frame.debug.gesture).toBe('landed')
    expect(frame.centerOffsetY).toBeLessThan(baseline - 0.3)
  })

  it('表情：默认站姿是营业笑（にやり，眼不笑，不用 笑い）', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    const frame = pipeline.update(makeInput(), 1000)
    const morphs = frame.debug.morphs ?? {}
    expect(morphs['にやり']).toBeGreaterThan(0.3)
    expect(morphs['笑い']).toBeUndefined()
    expect(frame.debug.smile).toBeGreaterThan(0.3)
  })

  it('注视：lookTarget 在右侧远处 → lookYaw > 0.3；setGaze(25,0) 后 gaze.yaw ≈ 25°', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    let now = 1000
    const lookInput = makeInput({ lookTarget: { x: PET_RECT.x + PET_RECT.width + 800, y: PET_RECT.y + 40 } })
    let frame = pipeline.update(lookInput, now)
    for (let i = 0; i < 60; i += 1) {
      now += 1000 / 60
      frame = pipeline.update(lookInput, now)
    }
    expect(frame.debug.lookYaw).not.toBeNull()
    expect(frame.debug.lookYaw!).toBeGreaterThan(0.3)
    expect(frame.debug.gaze).not.toBeNull()
    // 眼球骨跟着写
    expect(frame.boneQuaternions.get('左目先')).toBeDefined()

    pipeline.setGaze(25, 0)
    for (let i = 0; i < 90; i += 1) {
      now += 1000 / 60
      frame = pipeline.update(makeInput(), now)
    }
    expect(frame.debug.gaze!.yaw).toBeCloseTo((25 * Math.PI) / 180, 1)
    expect(frame.debug.lookYaw!).toBeCloseTo(25 / 31, 1)
  })

  it('眨眼：8s 内 blink 权重出现过 > 0.5（懒初始化 + 随机调度）', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(9) })
    let maxBlink = 0
    let now = 1000
    for (let i = 0; i < 480; i += 1) {
      now += 1000 / 60
      const frame = pipeline.update(makeInput(), now)
      maxBlink = Math.max(maxBlink, frame.debug.blink)
    }
    expect(maxBlink).toBeGreaterThan(0.5)
  })

  it('口型：bubbleText 驱动 mouthOpen > 0.2，文本结束后回落 < 0.05', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    let now = 1000
    let frame = pipeline.update(makeInput({ bubbleText: '朋友，要来一局吗' }), now)
    let maxMouth = 0
    for (let i = 0; i < 60; i += 1) {
      now += 1000 / 60
      frame = pipeline.update(makeInput({ bubbleText: '朋友，要来一局吗' }), now)
      maxMouth = Math.max(maxMouth, frame.debug.mouthOpen)
    }
    expect(maxMouth).toBeGreaterThan(0.2)
    for (let i = 0; i < 60; i += 1) {
      now += 1000 / 60
      frame = pipeline.update(makeInput({ bubbleText: null }), now)
    }
    expect(frame.debug.mouthOpen).toBeLessThan(0.05)
  })

  it('待机变体：idle + 站姿下 15s 内至少触发一次（随机源固定时 coinRoll）', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: () => 0 })
    let now = 1000
    let sawVariant: string | null = null
    for (let i = 0; i < 900; i += 1) {
      now += 1000 / 60
      const frame = pipeline.update(makeInput(), now)
      if (frame.debug.gesture) sawVariant = frame.debug.gesture
      if (sawVariant) break
    }
    expect(sawVariant).not.toBeNull()
    expect(['coinRoll', 'coinToss', 'adjustCuff', 'stretch', 'gazeAway', 'salute']).toContain(sawVariant)
  })

  it('缺失骨写进调试快照（不抛异常）', () => {
    const pipeline = new AnimationPipeline(makeRig(['左腕']), { random: seeded(1) })
    const frame = pipeline.update(makeInput(), 1000)
    expect(frame.debug.missingBones).toContain('左腕')
  })

  it('长跑 600 帧（混合 mood/事件/注视/气泡）无 NaN、无异常', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(11) })
    const moods: PetMood[] = ['idle', 'walk', 'climb', 'sit', 'sleep', 'drag', 'fall', 'pat', 'dshBusy', 'dshDone', 'dshError', 'grabWindow']
    let now = 1000
    for (let i = 0; i < 600; i += 1) {
      now += 1000 / 60
      const mood = moods[Math.floor(i / 50) % moods.length]!
      const events =
        i % 97 === 0
          ? ([{ kind: 'pat' }, { kind: 'poke', region: 'head' }, { kind: 'thrown', speed: 900 }] as AnimationInput['events'])
          : i % 61 === 0
            ? ([{ kind: 'landed', impactSpeed: 1800 }] as AnimationInput['events'])
            : []
      const frame = pipeline.update(
        makeInput({
          mood,
          events,
          dragging: mood === 'drag',
          motion: mood === 'fall' ? ({ airborne: true, grounded: false } as never) : undefined,
          lookTarget: i % 7 === 0 ? null : { x: 200 + (i % 800), y: 100 + (i % 300) },
          bubbleText: i % 120 < 40 ? '朋友，买定离手。' : null
        }),
        now
      )
      for (const [, quat] of frame.boneQuaternions) {
        expect(Number.isFinite(quat.x + quat.y + quat.z + quat.w)).toBe(true)
      }
      expect(Number.isFinite(frame.centerOffsetY)).toBe(true)
      expect(Number.isFinite(frame.debug.updateMs ?? 0)).toBe(true)
      for (const [, weight] of frame.morphWeights) {
        expect(weight).toBeGreaterThanOrEqual(0)
        expect(weight).toBeLessThanOrEqual(1)
      }
    }
  })

  it('接地误差在有速度的走路里仍 < 2px（支撑脚/摆动脚都被 IK 钉住）', () => {
    const pipeline = new AnimationPipeline(makeRig(), { random: seeded(1) })
    pipeline.setPose('walk')
    let frame = pipeline.update(makeInput(), 1000)
    let now = 1000
    let maxError = 0
    for (let i = 0; i < 120; i += 1) {
      now += 1000 / 60
      frame = pipeline.update(
        makeInput({ dt: 1 / 60, motion: { velocity: { x: 120, y: 0 } } as never }),
        now
      )
      maxError = Math.max(maxError, frame.debug.footErrorPx ?? 0)
    }
    expect(frame.debug.pose).toBe('walk')
    expect(maxError).toBeLessThan(2)
  })
})
