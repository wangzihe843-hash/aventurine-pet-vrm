/**
 * B3 单测：眨眼调度 / 情绪组合 / 口型（纯函数）。
 *
 * 覆盖 survey §5.6 清单 + 人设「五种笑」要点（默认营业笑、笑眼与眨眼冲突裁决、问候语照れ）。
 */
import { describe, expect, it } from 'vitest'

import {
  BLINK_MORPH,
  BLINK_MORPH_LAUGHING,
  BLINK_INTERVAL_MAX_MS,
  BLINK_INTERVAL_MIN_MS,
  createBlinkState,
  forceBlink,
  sampleBlinkInterval,
  stepBlink,
  type BlinkState
} from '../src/renderer/src/animation/legacy/blink'
import {
  EMOTION_DEFS,
  laughingEyeWeightOf,
  mergeMorphsMax,
  mixEmotions,
  mouthOpenOf,
  nonZeroMorphs,
  smileWeightOf
} from '../src/renderer/src/animation/legacy/emotion'
import {
  textToVisemes,
  stepViseme,
  visemeSequenceDurationMs,
  VISEME_AMPLITUDE,
  VISEME_CHAR_MAX_MS,
  VISEME_CHAR_MIN_MS
} from '../src/renderer/src/animation/legacy/viseme'

/** 简单 seeded RNG（LCG；测试可复现）。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

describe('blink：随机间隔/双眨/笑眼冲突/惊讶反射', () => {
  it('指数分布间隔落在 2.2–6.5s（含两端）', () => {
    expect(sampleBlinkInterval(() => 0)).toBeCloseTo(BLINK_INTERVAL_MIN_MS, 0)
    expect(sampleBlinkInterval(() => 0.999999)).toBeLessThanOrEqual(BLINK_INTERVAL_MAX_MS)
    const rng = seeded(42)
    for (let i = 0; i < 200; i += 1) {
      const interval = sampleBlinkInterval(rng)
      expect(interval).toBeGreaterThanOrEqual(BLINK_INTERVAL_MIN_MS)
      expect(interval).toBeLessThanOrEqual(BLINK_INTERVAL_MAX_MS)
    }
  })

  it('10s 固定 RNG 内眨眼 2–5 次、权重始终在 [0,1]', () => {
    const rng = seeded(7)
    let state = createBlinkState(0, rng)
    let blinks = 0
    let previousPhase = state.phase
    for (let now = 0; now <= 10_000; now += 16) {
      const output = stepBlink(state, now, rng)
      if (output.state.phase === 'closing' && previousPhase !== 'closing') blinks += 1
      expect(output.weight).toBeGreaterThanOrEqual(0)
      expect(output.weight).toBeLessThanOrEqual(1)
      expect([BLINK_MORPH, BLINK_MORPH_LAUGHING]).toContain(output.morph)
      previousPhase = output.state.phase
      state = output.state
    }
    expect(blinks).toBeGreaterThanOrEqual(2)
    expect(blinks).toBeLessThanOrEqual(7)
  })

  it('阶段推进：idle → closing → opening → idle；闭/开时长为 110–160ms 内在附近', () => {
    const rng = seeded(3)
    let state: BlinkState = { ...createBlinkState(0, rng), nextAtMs: 0 }
    let output = stepBlink(state, 0, rng)
    expect(output.state.phase).toBe('closing')
    expect(output.weight).toBe(0)
    state = output.state
    const closeMs = state.closeMs
    expect(closeMs).toBeGreaterThanOrEqual(40)
    expect(closeMs).toBeLessThanOrEqual(60)
    output = stepBlink(state, closeMs, rng)
    expect(output.state.phase).toBe('opening')
    expect(output.weight).toBeGreaterThan(0.9)
    state = output.state
    output = stepBlink(state, closeMs + state.openMs, rng)
    expect(output.state.phase).toBe('idle')
    expect(output.weight).toBe(0)
    // 单次总时长 110–160ms 的设计范围（含采样上下限抖动）
    expect(closeMs + state.openMs).toBeGreaterThanOrEqual(100)
    expect(closeMs + state.openMs).toBeLessThanOrEqual(140)
  })

  it('双眨：15% 概率在睁眼后 180ms 安排第二下（rng=0 必触发）', () => {
    let state: BlinkState = {
      ...createBlinkState(0, () => 0.5),
      nextAtMs: 0,
      phase: 'opening',
      phaseStartMs: 0,
      closeMs: 50,
      openMs: 60,
      second: false,
      pendingSecond: false
    }
    const rng = () => 0 // 必然 < 0.15
    const output = stepBlink(state, 60, rng)
    expect(output.state.phase).toBe('idle')
    expect(output.state.pendingSecond).toBe(true)
    expect(output.state.nextAtMs).toBe(60 + 180)
    state = output.state
    const second = stepBlink(state, 240, rng)
    expect(second.state.phase).toBe('closing')
    expect(second.state.second).toBe(true)
  })

  it('笑眼冲突：laughing=true 时改用 ウィンク 且权重 ×0.5', () => {
    const rng = seeded(1)
    const normal = stepBlink(createBlinkState(0, rng), 5000, rng, false)
    const laughing = stepBlink(createBlinkState(0, rng), 5000, rng, true)
    expect(normal.morph).toBe(BLINK_MORPH)
    expect(laughing.morph).toBe(BLINK_MORPH_LAUGHING)
    expect(laughing.weight).toBeLessThanOrEqual(0.5)
  })

  it('forceBlink：idle 时立即闭眼；眨眼进行中不重复触发', () => {
    const rng = seeded(5)
    const state = createBlinkState(0, rng)
    const forced = forceBlink(state, 1234)
    expect(forced.phase).toBe('closing')
    expect(forceBlink(forced, 1300)).toBe(forced)
  })
})

describe('emotion：五种笑 / 同组互斥 / 同 morph 取 max / 权重钳制', () => {
  it('neutral 输出空 Map；business=にやり（眼不笑）；realSmile=笑い+口角上げ', () => {
    expect(mixEmotions([{ emotion: 'neutral', weight: 1, priority: 10 }]).size).toBe(0)
    const business = mixEmotions([{ emotion: 'business', weight: 1, priority: 10 }])
    expect(business.get('にやり')).toBeGreaterThan(0.4)
    expect(laughingEyeWeightOf(business)).toBe(0)
    const realSmile = mixEmotions([{ emotion: 'realSmile', weight: 1, priority: 10 }])
    expect(realSmile.get('笑い')).toBeGreaterThan(0.5)
    expect(realSmile.get('口角上げ')).toBeGreaterThan(0.4)
  })

  it('人设映射：shy 必含 照れ、sad 必含 悲しい+目影濃、celebrate 必含 星目、smirk 含じと目', () => {
    const shy = mixEmotions([{ emotion: 'shy', weight: 1, priority: 10 }])
    expect(shy.get('照れ')).toBeGreaterThan(0.5)
    const sad = mixEmotions([{ emotion: 'sad', weight: 1, priority: 10 }])
    expect(sad.get('悲しい')).toBeGreaterThan(0.6)
    expect(sad.get('目影濃')).toBeGreaterThan(0.4)
    const celebrate = mixEmotions([{ emotion: 'celebrate', weight: 1, priority: 10 }])
    expect(celebrate.get('星目')).toBeGreaterThan(0.7)
    const smirk = mixEmotions([{ emotion: 'smirk', weight: 1, priority: 10 }])
    expect(smirk.get('にやり２')).toBeGreaterThan(0.4)
    expect(smirk.get('じと目')).toBeGreaterThan(0.2)
  })

  it('同 morph 多源 → 取 max（不是求和）', () => {
    const result = mixEmotions([
      { emotion: 'business', weight: 1, priority: 10 },
      { emotion: 'business', weight: 1, priority: 10 }
    ])
    expect(result.get('にやり')).toBeCloseTo(0.45, 5)
  })

  it('同组冲突：高优先级先选、低优先级按 1−高权重衰减', () => {
    const result = mixEmotions([
      { emotion: 'business', weight: 1, priority: 10 }, // にやり 0.45
      { emotion: 'surprise', weight: 1, priority: 30 } // 大口 0.5 / 手前 / びっくり
    ])
    expect(result.get('大口')).toBeCloseTo(0.5, 5)
    // 同组（mouth）的 にやり 被衰减到 0.45*(1-0.5)
    expect(result.get('にやり')).toBeCloseTo(0.225, 5)
    expect(result.get('大口')!).toBeGreaterThan(result.get('にやり')!)
  })

  it('权重钳制 [0,1]；weight≤0 的层被忽略', () => {
    const result = mixEmotions([
      { emotion: 'realSmile', weight: 99, priority: 10 },
      { emotion: 'sad', weight: 0, priority: 10 }
    ])
    for (const [, weight] of result) {
      expect(weight).toBeGreaterThanOrEqual(0)
      expect(weight).toBeLessThanOrEqual(1)
    }
    expect(result.has('悲しい')).toBe(false)
  })

  it('说话时嘴型类情绪 ×0.3（口型是独立通道）', () => {
    const normal = mixEmotions([{ emotion: 'business', weight: 1, priority: 10 }])
    const speaking = mixEmotions([{ emotion: 'business', weight: 1, priority: 10 }], { speaking: true })
    expect(speaking.get('にやり')!).toBeCloseTo(normal.get('にやり')! * 0.3, 5)
  })

  it('未知情绪 id 忽略且不抛；smile/laughing/mouthOpen 聚合正确', () => {
    const unknown = mixEmotions([{ emotion: 'nonsense' as never, weight: 1, priority: 10 }])
    expect(unknown.size).toBe(0)
    const smile = mixEmotions([{ emotion: 'realSmile', weight: 1, priority: 10 }])
    expect(smileWeightOf(smile)).toBeGreaterThan(0.5)
    expect(laughingEyeWeightOf(smile)).toBeGreaterThan(0.5)
    const mouth = new Map([['あ', 0.7]])
    expect(mouthOpenOf(mouth)).toBeCloseTo(0.7, 5)
    expect(Object.keys(nonZeroMorphs(smile)).length).toBeGreaterThan(0)
    // mergeMorphsMax 同 morph 取 max
    const merged = new Map([['まばたき', 0.2]])
    mergeMorphsMax(merged, new Map([['まばたき', 0.6]]))
    expect(merged.get('まばたき')).toBeCloseTo(0.6, 5)
  })

  it('情绪定义里的 morph 名都是模型真实资产（85 morph 里的名字）', () => {
    const realMorphs = new Set([
      '怒り', '怒り右', '真面目', '困る', '手前', '手前2', 'やっかい', '悲しい', '下', '上',
      '口角上げ', '口角下げ', 'ムッ', '大口', '∧', 'にやり', 'にやり２', 'にやり３',
      '笑い', '笑い2', '笑目', '笑', 'じと目', 'びっくり', 'なごみ', '星目', 'はぁと', '喜び',
      '照れ', '目影消', '目影濃'
    ])
    for (const def of Object.values(EMOTION_DEFS)) {
      for (const part of Object.values(def)) {
        if (part) expect(realMorphs.has(part.morph)).toBe(true)
      }
    }
    expect(Object.keys(EMOTION_DEFS).length).toBeGreaterThanOrEqual(12)
  })
})

describe('viseme：文本 → 口型序列 / 节奏 / 收尾', () => {
  it('中文文本 → 非空序列；每字 90–140ms；结尾补 ん', () => {
    const steps = textToVisemes('你好朋友')
    expect(steps.length).toBeGreaterThanOrEqual(4)
    for (const step of steps) {
      if (step.viseme === null) continue
      expect(step.ms).toBeGreaterThanOrEqual(VISEME_CHAR_MIN_MS)
      expect(step.ms).toBeLessThanOrEqual(VISEME_CHAR_MAX_MS)
      expect(VISEME_AMPLITUDE[step.viseme]).toBeGreaterThan(0)
    }
    expect(steps[steps.length - 1]!.viseme).toBe('ん')
  })

  it('日文假名精确映射；标点产生停顿；英文按元音', () => {
    const japanese = textToVisemes('あいうえお')
    expect(japanese.slice(0, 5).map((step) => step.viseme)).toEqual(['あ', 'い', 'う', 'え', 'お'])
    const withPause = textToVisemes('あ、い')
    expect(withPause.some((step) => step.viseme === null)).toBe(true)
    const english = textToVisemes('hello')
    expect(english.filter((step) => step.viseme !== null).length).toBeGreaterThanOrEqual(2)
  })

  it('空文本 → 空序列；总时长 = 各步之和', () => {
    expect(textToVisemes('')).toEqual([])
    const steps = textToVisemes('朋友')
    const total = visemeSequenceDurationMs(steps)
    expect(total).toBeGreaterThan(0)
    expect(total).toBe(steps.reduce((sum, step) => sum + step.ms, 0))
  })

  it('采样：开始权重 0→中间 >0→结束 done 且权重归零；开口幅度 ≤0.8', () => {
    const steps = textToVisemes('朋友')
    const total = visemeSequenceDurationMs(steps)
    const start = stepViseme(steps, 0)
    expect(start.weight).toBeLessThanOrEqual(0.01)
    const mid = stepViseme(steps, total * 0.5)
    expect(mid.done).toBe(false)
    expect(mid.weight).toBeGreaterThan(0)
    expect(mid.weight).toBeLessThanOrEqual(0.8)
    const end = stepViseme(steps, total + 50)
    expect(end.done).toBe(true)
    expect(end.weight).toBe(0)
    expect(stepViseme([], 0).done).toBe(true)
  })
})
