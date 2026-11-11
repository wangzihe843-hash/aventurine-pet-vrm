/**
 * V6 表情层运行时单测：`src/renderer/src/vrm/expressions.ts`
 *
 * 覆盖：
 * - 业务表情绑定/缺省/强度表与口型表的一致性；
 * - 眨眼调度器（固定随机源；闭/开/双眨/笑眼衰减/停用）；
 * - 文本 → viseme → mouth preset（含交叉淡化、结尾收口、时长）；
 * - 表情 clip 层（淡入淡出、循环、一次性播完自动停）；
 * - 表情驱动（mood 基态、事件反应层、拖拽 clip、口型 + 说话衰减、绑定缺失跳过）；
 * - 接线辅助 `applyExpressionWeights`（先清零再写）。
 */
import { describe, expect, it } from 'vitest'

import { PET_MOODS } from '@shared/types'
import { PET_EXPRESSIONS, type VrmExpressionBindings } from '@shared/vrm'
import {
  DEFAULT_EXPRESSION_INTENSITY,
  DEFAULT_SPEAKING_EMOTION_FACTOR,
  EVENT_EXPRESSION_FALLBACK,
  EXPRESSION_TRIGGER_HINTS,
  ExpressionClipLayer,
  MAX_EXPRESSION_DT_SEC,
  MOOD_EXPRESSION,
  VISEME_AMPLITUDE,
  VISEME_TO_PRESET,
  VisemeScheduler,
  BlinkScheduler,
  VRMExpressionDriver,
  applyExpressionWeights,
  boundExpressionNames,
  crossfadeExpressionWeights,
  sampleVisemes,
  textToVisemes,
  visemeSequenceDurationMs,
  type ExpressionWeightTarget
} from '../src/renderer/src/vrm/expressions'
import { sanitizeExpressionClip } from '@shared/expression-contract'
import type { ExpressionClip } from '@shared/expression-contract'

/** 固定绑定：目标模型的 7 个可用业务表情（与 vrm-manifest.json 当前口径一致）。 */
const BINDINGS: VrmExpressionBindings = {
  blink: 'blink',
  blinkLeft: 'blinkLeft',
  blinkRight: 'blinkRight',
  happy: 'happy',
  angry: 'angry',
  surprised: 'surprised',
  neutral: 'neutral'
}

/** 固定随机源（耗尽后固定 0.5）。 */
function makeRandom(sequence: number[] = []): () => number {
  const queue = [...sequence]
  return () => (queue.length > 0 ? queue.shift()! : 0.5)
}

/** 构造一个 10 帧 @10fps、1s、loop 的 happy 渐强 clip。 */
function makeHappyClip(overrides: Partial<ExpressionClip> = {}): ExpressionClip {
  const { clip } = sanitizeExpressionClip({
    id: 'test/happy',
    source: 'mate',
    fps: 10,
    frames: 10,
    duration: 1,
    loop: true,
    tracks: {
      happy: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    }
  })
  return { ...clip!, ...overrides }
}

/** 推进驱动 N 帧（每帧 1/fps 秒），返回最后一帧快照。 */
function step(
  driver: VRMExpressionDriver,
  input: Parameters<VRMExpressionDriver['update']>[1],
  frames = 1,
  dt = 1 / 60
): ReturnType<VRMExpressionDriver['update']> {
  let snapshot = driver.update(dt, input)
  for (let index = 1; index < frames; index += 1) snapshot = driver.update(dt, input)
  return snapshot
}

describe('vrm-expressions：表/常量一致性', () => {
  it('MOOD_EXPRESSION 覆盖全部 PetMood，且值都是合法业务表情或 null', () => {
    for (const mood of PET_MOODS) {
      const expression = MOOD_EXPRESSION[mood]
      if (expression !== null) expect(PET_EXPRESSIONS as readonly string[]).toContain(expression)
    }
  })

  it('EVENT_EXPRESSION_FALLBACK / TRIGGER_HINTS 的值合法', () => {
    for (const expression of Object.values(EVENT_EXPRESSION_FALLBACK)) {
      if (expression !== null) expect(PET_EXPRESSIONS as readonly string[]).toContain(expression)
    }
    for (const hint of Object.values(EXPRESSION_TRIGGER_HINTS)) {
      expect(typeof hint.id).toBe('string')
      expect(typeof hint.hold).toBe('boolean')
    }
  })

  it('DEFAULT_EXPRESSION_INTENSITY 覆盖 9 个业务表情且都在 0..1', () => {
    for (const expression of PET_EXPRESSIONS) {
      const weight = DEFAULT_EXPRESSION_INTENSITY[expression]
      expect(weight).toBeGreaterThanOrEqual(0)
      expect(weight).toBeLessThanOrEqual(1)
    }
  })

  it('VISEME_TO_PRESET：あいうえお → aa/ih/ou/ee/oh，ん → 闭口', () => {
    expect(VISEME_TO_PRESET).toEqual({ あ: 'aa', い: 'ih', う: 'ou', え: 'ee', お: 'oh', ん: null })
    for (const viseme of ['あ', 'い', 'う', 'え', 'お'] as const) {
      expect(VISEME_AMPLITUDE[viseme]).toBeGreaterThan(0)
      expect(VISEME_AMPLITUDE[viseme]).toBeLessThanOrEqual(1)
    }
  })
})

describe('vrm-expressions：权重插值/跨层合并', () => {
  it('crossfadeExpressionWeights：线性插值、只保留非零项', () => {
    expect(crossfadeExpressionWeights({ happy: 1 }, { sad: 1 }, 0)).toEqual({ happy: 1 })
    const half = crossfadeExpressionWeights({ happy: 1 }, { sad: 1 }, 0.5)
    expect(half.happy).toBeCloseTo(0.5, 6)
    expect(half.sad).toBeCloseTo(0.5, 6)
    expect(crossfadeExpressionWeights({}, { aa: 0.8 }, 1)).toEqual({ aa: 0.8 })
    expect(crossfadeExpressionWeights({ happy: 1 }, {}, 1)).toEqual({})
  })
})

describe('vrm-expressions：眨眼调度', () => {
  it('按固定间隔闭眼→睁眼→回到 idle', () => {
    const scheduler = new BlinkScheduler(
      { intervalMinMs: 1000, intervalMaxMs: 1000, closeMsMin: 100, closeMsMax: 100, openMsMin: 100, openMsMax: 100 },
      makeRandom([0.5])
    )
    scheduler.reset(0)
    // 首眨在 1.2–3s（sampleRange(1200,3000) 用 random 0.5 → 2100ms）
    let output = scheduler.update(2000)
    expect(output.active).toBe(false)
    output = scheduler.update(2200)
    expect(output.active).toBe(true)
    expect(scheduler.weightAt(2200)).toBeCloseTo(0, 4)
    // 闭眼 100ms 内权重上升
    const mid = scheduler.weightAt(2250)
    expect(mid).toBeGreaterThan(0.2)
    // 睁眼阶段
    scheduler.update(2250)
    expect(scheduler.active).toBe(true)
    scheduler.update(2350) // closing 结束 → opening
    expect(scheduler.active).toBe(true)
    const opening = scheduler.weightAt(2400)
    expect(opening).toBeGreaterThan(0)
    expect(opening).toBeLessThan(1)
    // 睁开结束 → idle
    scheduler.update(2500)
    expect(scheduler.active).toBe(false)
    expect(scheduler.weightAt(2500)).toBe(0)
  })

  it('forceBlink 立即闭眼；停用后权重恒 0', () => {
    const scheduler = new BlinkScheduler({}, makeRandom())
    scheduler.reset(0)
    scheduler.forceBlink(0)
    expect(scheduler.active).toBe(true)
    const weight = scheduler.update(10)
    expect(weight.weight).toBeGreaterThan(0)
    scheduler.setEnabled(false)
    expect(scheduler.weightAt(20)).toBe(0)
    expect(scheduler.update(30).weight).toBe(0)
  })

  it('笑眼权重高时眨眼权重 ×0.5', () => {
    const scheduler = new BlinkScheduler(
      { closeMsMin: 100, closeMsMax: 100, openMsMin: 100, openMsMax: 100, intervalMinMs: 100, intervalMaxMs: 100 },
      makeRandom()
    )
    scheduler.reset(0)
    scheduler.forceBlink(0)
    const normal = scheduler.update(20, 0)
    const laughing = scheduler.update(20, 0.9)
    expect(laughing.weight).toBeCloseTo(normal.weight * 0.5, 6)
  })
})

describe('vrm-expressions：文本 → viseme', () => {
  it('假名精确映射、英文元音、汉字确定性、标点停顿、结尾补 ん', () => {
    const steps = textToVisemes('あいうえお')
    expect(steps.slice(0, 5).map((step) => step.viseme)).toEqual(['あ', 'い', 'う', 'え', 'お'])
    expect(steps[steps.length - 1]!.viseme).toBe('ん')

    const latin = textToVisemes('aeiou')
    expect(latin.slice(0, 5).map((step) => step.viseme)).toEqual(['あ', 'え', 'い', 'お', 'う'])

    const han = textToVisemes('砂金')
    expect(han.length).toBeGreaterThanOrEqual(2)
    expect(han[han.length - 1]!.viseme).toBe('ん')

    const paused = textToVisemes('a，b')
    expect(paused.some((step) => step.viseme === null)).toBe(true)
    expect(textToVisemes('')).toEqual([])
  })

  it('序列时长 = 各步之和；采样权重含幅度/包络', () => {
    const steps = textToVisemes('あ')
    expect(visemeSequenceDurationMs(steps)).toBeGreaterThan(0)
    const mid = sampleVisemes(steps, 50)
    expect(mid.viseme).toBe('あ')
    expect(mid.weight).toBeGreaterThan(0)
    expect(mid.done).toBe(false)
    const end = sampleVisemes(steps, visemeSequenceDurationMs(steps) + 100)
    expect(end.done).toBe(true)
    expect(end.weight).toBe(0)
    expect(sampleVisemes([], 0).done).toBe(true)
  })

  it('VisemeScheduler：文本变化重建、推进后完成闭嘴、相同文本不重启', () => {
    const scheduler = new VisemeScheduler()
    scheduler.setText('あ')
    expect(scheduler.currentText).toBe('あ')
    const duration = visemeSequenceDurationMs(textToVisemes('あ'))
    const first = scheduler.update(0.02)
    expect(first.viseme).not.toBeNull()
    expect(scheduler.update(duration / 1000 + 0.2).viseme).toBeNull()
    expect(scheduler.active).toBe(false)
    // 相同文本不重建（elapsed 不清零）
    scheduler.setText('あ')
    expect(scheduler.update(0.02).done).toBe(true)
    scheduler.setText(null)
    expect(scheduler.currentText).toBeNull()
    expect(scheduler.update(0.02).done).toBe(true)
  })
})

describe('vrm-expressions：表情 clip 层', () => {
  it('淡入 → 采样 → 停止淡出（clipId 最终清空）', () => {
    const layer = new ExpressionClipLayer({ fadeInSec: 0.1, fadeOutSec: 0.1 })
    const clip = makeHappyClip()
    layer.play(clip)
    expect(layer.clipId).toBe('test/happy')
    const first = layer.update(1 / 60)
    expect(first.happy).toBeGreaterThan(0)
    // 两个 fadeIn 时长后权重接近采样值
    layer.update(0.1)
    const full = layer.update(1 / 60)
    expect(full.happy).toBeGreaterThan(first.happy!)
    layer.stop()
    const stopping = layer.update(1 / 60)
    expect(stopping.happy).toBeLessThanOrEqual(full.happy!)
    layer.update(0.2)
    expect(layer.clipId).toBeNull()
    expect(layer.update(1 / 60)).toEqual({})
  })

  it('非循环 clip 播完自动停止', () => {
    const layer = new ExpressionClipLayer()
    const { clip } = sanitizeExpressionClip({
      id: 'test/oneshot',
      fps: 10,
      frames: 11,
      duration: 1,
      loop: false,
      tracks: { happy: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] }
    })
    layer.play(clip!)
    for (let index = 0; index < 40; index += 1) layer.update(0.05)
    expect(layer.clipId).toBeNull()
  })
})

describe('vrm-expressions：clip 层 crossfade / 独立淡入淡出 / 随机相位', () => {
  it('两个 clip 切换 = 线性 crossfade（新淡入 + 旧淡出，同轨道加权和）', () => {
    const layer = new ExpressionClipLayer()
    const clipA = makeHappyClip()
    const clipB = makeHappyClip({ id: 'test/sad', tracks: { sad: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } })
    layer.play(clipA)
    for (let index = 0; index < 20; index += 1) layer.update(0.01)
    expect(layer.clipId).toBe('test/happy')
    expect(layer.blending).toBe(false)
    layer.play(clipB)
    expect(layer.blending).toBe(true)
    const during = layer.update(0.02)
    expect(during.happy).toBeGreaterThan(0)
    expect(during.sad).toBeGreaterThan(0)
    // 过渡结束后只剩新 clip
    for (let index = 0; index < 40; index += 1) layer.update(0.02)
    expect(layer.clipId).toBe('test/sad')
    expect(layer.blending).toBe(false)
    const after = layer.update(0.02)
    expect(after.sad).toBeGreaterThan(0.99)
    expect(after.happy ?? 0).toBe(0)
  })

  it('clip 自带 fadeInSec/fadeOutSec 优先于层默认值', () => {
    const layer = new ExpressionClipLayer({ fadeInSec: 0.01, fadeOutSec: 0.01 })
    const slow = sanitizeExpressionClip({
      id: 'test/slow-in',
      source: 'hsr',
      fps: 10,
      frames: 10,
      duration: 1,
      loop: true,
      fadeInSec: 1.0,
      fadeOutSec: 0.5,
      tracks: { happy: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }
    }).clip!
    layer.play(slow)
    const first = layer.update(0.05) // 0.05s / 1.0s fade → ~0.05
    expect(first.happy).toBeGreaterThan(0)
    expect(first.happy!).toBeLessThan(0.1)
    for (let index = 0; index < 30; index += 1) layer.update(0.05)
    expect(layer.update(0.05).happy).toBeCloseTo(1, 2)
  })

  it('loop clip 支持起始相位（随机相位避免图案每圈一样）', () => {
    const layer = new ExpressionClipLayer({ fadeInSec: 0 })
    const clip = makeHappyClip() // happy 0→0.9 渐强
    layer.play(clip, { phaseSec: 0.5 })
    const atHalf = layer.update(0.001)
    // 0.5s 相位 → happy 约 0.5（10fps 第 5 帧）
    expect(atHalf.happy).toBeGreaterThan(0.45)
    expect(atHalf.happy).toBeLessThan(0.55)
  })

  it('definesBlink：clip 含 blink 轨道时驱动层应关程序化 blink', () => {
    const layer = new ExpressionClipLayer()
    expect(layer.definesBlink).toBe(false)
    layer.play(makeHappyClip()) // 只含 happy
    expect(layer.definesBlink).toBe(false)
    layer.play(makeClipWithBlink())
    expect(layer.definesBlink).toBe(true)
  })
})

/** 含 blink 轨道的 clip（definesBlink/驱动压制测试用）。 */
function makeClipWithBlink(): ExpressionClip {
  const { clip } = sanitizeExpressionClip({
    id: 'test/with-blink',
    source: 'mate',
    fps: 10,
    frames: 10,
    duration: 1,
    loop: true,
    tracks: { blink: [0, 0, 0, 1, 1, 0, 0, 0, 0, 0] }
  })
  return clip!
}

describe('vrm-expressions：驱动', () => {
  it('mood → 业务表情 → 绑定名（pat=happy、idle=无、sleep=blink）', () => {
    const driver = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom() })
    const pat = step(driver, { mood: 'pat' }, 30)
    expect(pat.baseExpression).toBe('happy')
    expect(pat.weights.happy).toBeGreaterThan(0.4)

    const idle = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom() })
    expect(step(idle, { mood: 'idle' }).weights).toEqual({})

    const sleep = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom() })
    const sleepState = step(sleep, { mood: 'sleep' })
    expect(sleepState.weights.blink).toBeGreaterThan(0.9)
  })

  it('缺绑定跳过（不崩）：只有 happy 绑定时 mood=sad 无输出', () => {
    const driver = new VRMExpressionDriver({ bindings: { happy: 'happy' }, random: makeRandom() })
    expect(step(driver, { mood: 'dshError' }).weights).toEqual({})
    expect(step(driver, { mood: 'pat' }).weights.happy).toBeGreaterThan(0)
  })

  it('一次性事件反应层：pat → happy，持续 reactionSec 后淡出', () => {
    const driver = new VRMExpressionDriver({
      bindings: BINDINGS,
      random: makeRandom(),
      reactionSec: 0.5,
      fadeSec: 0
    })
    // 反应层有 0.15 的淡入包络；推进 10 帧（~0.17s）后达到峰值
    let withEvent = driver.update(1 / 60, { mood: 'idle', events: [{ kind: 'pat' }] })
    for (let index = 0; index < 9; index += 1) withEvent = driver.update(1 / 60, { mood: 'idle' })
    expect(withEvent.weights.happy).toBeGreaterThanOrEqual(
      DEFAULT_EXPRESSION_INTENSITY.happy - 1e-6
    )
    // 推进 0.6s 后反应结束 → 回到 idle 基态
    let snapshot = withEvent
    for (let index = 0; index < 40; index += 1) {
      snapshot = driver.update(1 / 60, { mood: 'idle' })
    }
    expect(snapshot.baseExpression).toBeNull()
    expect(snapshot.weights.happy ?? 0).toBe(0)
  })

  it('拖拽：自动推导 drag 触发并播 clip；松开后停止', () => {
    const clip = makeHappyClip({ id: 'mate/drag' })
    const lookupCalls: string[] = []
    const driver = new VRMExpressionDriver({
      bindings: BINDINGS,
      random: makeRandom(),
      clipLookup: (trigger) => {
        lookupCalls.push(trigger)
        return trigger === 'drag' ? clip : null
      }
    })
    const dragging = step(driver, { mood: 'drag', dragging: true }, 20)
    expect(lookupCalls).toContain('drag')
    expect(dragging.trigger).toBe('drag')
    expect(dragging.clipId).toBe('mate/drag')
    expect(dragging.weights.happy).toBeGreaterThan(0)

    const released = step(driver, { mood: 'idle', dragging: false }, 60)
    expect(released.trigger).toBeNull()
    expect(released.clipId).toBeNull()
  })

  it('显式触发覆盖自动推导；playClip 直接指定 clip', () => {
    const clip = makeHappyClip({ id: 'hsr/photoGentle' })
    const driver = new VRMExpressionDriver({
      bindings: BINDINGS,
      random: makeRandom(),
      clipLookup: () => null
    })
    const explicit = step(driver, {
      mood: 'idle',
      expressionTrigger: { id: 'free', hold: true }
    })
    expect(explicit.trigger).toBe('free')
    expect(explicit.clipId).toBeNull()

    driver.playClip(clip)
    const played = step(driver, { mood: 'idle' })
    expect(played.clipId).toBe('hsr/photoGentle')
    expect(played.weights.happy).toBeGreaterThan(0)
    driver.stopClip(true)
    expect(step(driver, { mood: 'idle' }).clipId).toBeNull()
  })

  it('气泡台词 → 口型权重 + 说话时情绪层衰减', () => {
    const driver = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom(), fadeSec: 0 })
    // 先建立 happy 基态
    step(driver, { mood: 'pat' }, 5)
    const speaking = step(driver, { mood: 'pat', bubbleText: 'あ' })
    expect(speaking.speaking).toBe(true)
    expect(speaking.viseme).toBe('あ')
    const mouthWeight = speaking.weights.aa ?? 0
    expect(mouthWeight).toBeGreaterThan(0)
    expect(mouthWeight).toBeLessThanOrEqual(VISEME_AMPLITUDE['あ'])
    expect(speaking.weights.happy).toBeCloseTo(
      Math.min(1, DEFAULT_EXPRESSION_INTENSITY.happy * DEFAULT_SPEAKING_EMOTION_FACTOR),
      6
    )
  })

  it('forceBlink：下一帧出现眨眼权重（并用眨眼绑定名）', () => {
    const driver = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom() })
    driver.forceBlink()
    const snapshot = driver.update(0.02, { mood: 'idle' })
    expect(snapshot.blinking).toBe(true)
    expect(snapshot.blinkWeight).toBeGreaterThan(0)
    expect(snapshot.weights.blink).toBeGreaterThan(0)
  })

  it('拖拽期间压制程序化 blink（源 Drag 表情显式不眨眼）', () => {
    const driver = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom() })
    driver.forceBlink() // 强制眨眼进行中
    const normal = driver.update(0.01, { mood: 'idle' })
    expect(normal.blinkWeight).toBeGreaterThan(0)
    driver.forceBlink()
    const dragging = driver.update(0.01, { mood: 'drag', dragging: true })
    expect(dragging.blinkWeight).toBe(0)
    expect(dragging.blinking).toBe(false)
    expect(dragging.weights.blink ?? 0).toBe(0)
  })

  it('clip 含 blink 轨道 → 程序化 blink 让位（以 clip 为准）', () => {
    const blinkClip = makeClipWithBlink()
    const driver = new VRMExpressionDriver({
      bindings: BINDINGS,
      random: makeRandom(),
      clipLookup: (trigger) => (trigger === 'idleFace' ? blinkClip : null)
    })
    driver.forceBlink()
    const playing = driver.update(0.02, {
      mood: 'idle',
      expressionTrigger: { id: 'idleFace', hold: true }
    })
    expect(playing.clipId).toBe('test/with-blink')
    expect(playing.blinkWeight).toBe(0)
    expect(playing.weights.blink ?? 0).toBe(0)
  })

  it('update 的 dt 钳制到 MAX_EXPRESSION_DT_SEC；reset 清空状态', () => {
    const driver = new VRMExpressionDriver({ bindings: BINDINGS, random: makeRandom() })
    step(driver, { mood: 'pat' }, 3)
    driver.reset()
    const snapshot = step(driver, { mood: 'idle' })
    expect(snapshot.weights).toEqual({})
    expect(MAX_EXPRESSION_DT_SEC).toBeLessThanOrEqual(0.1)
  })
})

describe('vrm-expressions：10s 脚本化时间线（端到端不变量）', () => {
  it('mood/事件/拖拽/台词交替 10 秒：无 NaN、权重恒 0..1、关键时刻行为符合预期', () => {
    const dragClip = makeHappyClip({ id: 'mate/faceDrag' })
    const petClip = sanitizeExpressionClip({
      id: 'mate/faceSmile',
      source: 'mate',
      fps: 10,
      frames: 10,
      duration: 1,
      loop: true,
      fadeInSec: 1.0,
      fadeOutSec: 1.0,
      tracks: { happy: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], aa: [0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4, 0, 0.4] }
    }).clip!
    const driver = new VRMExpressionDriver({
      bindings: BINDINGS,
      random: makeRandom([0.1, 0.9, 0.4]),
      clipLookup: (trigger) => (trigger === 'drag' ? dragClip : trigger === 'pet' ? petClip : null)
    })
    let sawBlink = false
    let sawMouth = false
    let sawPetClip = false
    let sawDragClip = false
    let sawHappy = false
    const fps = 60
    for (let frame = 0; frame < 10 * fps; frame += 1) {
      const time = frame / fps
      const input = {
        mood: 'idle',
        events: [] as Array<{ kind: string }>,
        dragging: false,
        bubbleText: null as string | null
      }
      if (time >= 1 && time < 2) input.events = [{ kind: 'pat' }]
      if (time >= 2.5 && time < 4) input.dragging = true
      if (time >= 4) input.mood = 'idle'
      if (time >= 5 && time < 7) input.bubbleText = '你好呀'
      if (time >= 7 && time < 8) input.mood = 'dshDone'
      const snapshot = driver.update(1 / fps, input)
      for (const value of Object.values(snapshot.weights)) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
      expect(Number.isFinite(snapshot.blinkWeight)).toBe(true)
      if (snapshot.blinkWeight > 0) sawBlink = true
      if (snapshot.trigger === 'pet') sawPetClip = true
      if (snapshot.trigger === 'drag') sawDragClip = true
      if ((snapshot.weights.happy ?? 0) > 0.2) sawHappy = true
      if (Object.keys(snapshot.weights).some((name) => ['aa', 'ih', 'ou', 'ee', 'oh'].includes(name))) sawMouth = true
    }
    expect(sawBlink).toBe(true)
    expect(sawMouth).toBe(true)
    expect(sawPetClip).toBe(true)
    expect(sawDragClip).toBe(true)
    expect(sawHappy).toBe(true)
  })
})

describe('vrm-expressions：接线辅助', () => {
  it('applyExpressionWeights 先清零已知 expression 再写非零值', () => {
    const calls: Array<[string, number]> = []
    const target: ExpressionWeightTarget = {
      setValue: (name, weight) => {
        calls.push([name, weight])
      }
    }
    applyExpressionWeights(target, { happy: 0.5, sad: 0.2 }, ['happy', 'sad', 'blink'])
    expect(calls).toEqual([
      ['happy', 0],
      ['sad', 0],
      ['blink', 0],
      ['happy', 0.5],
      ['sad', 0.2]
    ])
  })

  it('boundExpressionNames：去重且只含绑定名', () => {
    expect(boundExpressionNames(BINDINGS).sort()).toEqual(
      ['angry', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'neutral', 'surprised'].sort()
    )
    expect(boundExpressionNames({})).toEqual([])
  })
})
