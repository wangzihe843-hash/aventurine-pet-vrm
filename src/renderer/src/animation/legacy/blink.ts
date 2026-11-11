/**
 * 眨眼调度器（纯函数状态机；**不 import three/DOM**）。
 *
 * 方案（`docs/anim-tech-survey.md` §5.2）：
 * - 随机间隔 2.2–6.5s，**指数分布**（`-ln(u)×mean` 更像真人，均匀分布会被潜意识预测）；
 * - 15% 概率双眨（间隔 180ms）；
 * - 单次 110–160ms（闭 45–55ms / 开 65–75ms），权重走 smoothstep；
 * - 冲突裁决：`笑い/笑い2/笑目/笑` 权重 > 0.35（笑眼本身半闭）时改用 `ウィンク` 并把权重 × 0.5，
 *   否则用 `まばたき`；
 * - 惊讶等情绪切换可调用 `forceBlink` 立即眨一次（人类惊讶反射）。
 *
 * 随机源由外部注入（`() => [0,1)`），单测给固定序列即可复现。
 */
import { clamp, smoothstep } from './quat'

/** 眨眼 morph 候选（模型内都有；未知由渲染层忽略）。 */
export const BLINK_MORPH = 'まばたき'
/** 笑眼冲突时改用半闭眼 morph。 */
export const BLINK_MORPH_LAUGHING = 'ウィンク'

/** 笑眼权重阈值（> 该值视为「笑眼半闭」，改用 ウィンク）。 */
export const LAUGHING_EYE_THRESHOLD = 0.35

/** 眨眼间隔上下限（毫秒）。 */
export const BLINK_INTERVAL_MIN_MS = 2200
export const BLINK_INTERVAL_MAX_MS = 6500

/** 双眨概率与间隔（毫秒）。 */
export const DOUBLE_BLINK_CHANCE = 0.15
export const DOUBLE_BLINK_GAP_MS = 180

/** 闭/开时长范围（毫秒）。 */
const CLOSE_MS_MIN = 45
const CLOSE_MS_MAX = 55
const OPEN_MS_MIN = 65
const OPEN_MS_MAX = 75

/** 眨眼阶段。 */
export type BlinkPhase = 'idle' | 'closing' | 'opening'

/** 眨眼状态（可序列化，便于单测断言）。 */
export interface BlinkState {
  phase: BlinkPhase
  /** 当前阶段开始时间（毫秒）。 */
  phaseStartMs: number
  /** 下一次自动眨眼时间（毫秒；idle 阶段有效）。 */
  nextAtMs: number
  /** 当前闭眼时长（毫秒）。 */
  closeMs: number
  /** 当前睁眼时长（毫秒）。 */
  openMs: number
  /** 本次是否为双眨的第二下。 */
  second: boolean
  /** 下一批是否安排为双眨第二下。 */
  pendingSecond: boolean
}

/** 一帧的眨眼输出。 */
export interface BlinkOutput {
  state: BlinkState
  /** 眨眼 morph 权重 0..1（已含笑眼冲突衰减）。 */
  weight: number
  /** 使用的 morph 名（idle 时为默认 まばたき）。 */
  morph: string
  /** 是否正在眨。 */
  active: boolean
}

/** 指数分布间隔（毫秒；钳制到 2.2–6.5s）。 */
export function sampleBlinkInterval(random: () => number): number {
  const u = clamp(random(), 0, 0.999999)
  // 1-u ∈ (0,1]；-ln 的均值 1 → 取 mean = 1500ms（截断后落在 2.2–6.5s 区间内）。
  const sample = BLINK_INTERVAL_MIN_MS + -Math.log(1 - u) * 1500
  return clamp(sample, BLINK_INTERVAL_MIN_MS, BLINK_INTERVAL_MAX_MS)
}

function sampleRange(random: () => number, min: number, max: number): number {
  return min + clamp(random(), 0, 1) * (max - min)
}

/** 新建眨眼状态（第一下在 1.5–3s 后，避免启动即眨眼显得呆）。 */
export function createBlinkState(nowMs: number, random: () => number): BlinkState {
  return {
    phase: 'idle',
    phaseStartMs: nowMs,
    nextAtMs: nowMs + sampleRange(random, 1200, 3000),
    closeMs: sampleRange(random, CLOSE_MS_MIN, CLOSE_MS_MAX),
    openMs: sampleRange(random, OPEN_MS_MIN, OPEN_MS_MAX),
    second: false,
    pendingSecond: false
  }
}

/** 立即触发一次眨眼（不打断正在进行的眨眼）。 */
export function forceBlink(state: BlinkState, nowMs: number): BlinkState {
  if (state.phase !== 'idle') return state
  return { ...state, phase: 'closing', phaseStartMs: nowMs, nextAtMs: nowMs + 600 }
}

/**
 * 推进眨眼状态机。
 * @param laughing 当前是否「笑眼半闭」（由情绪层算：笑眼 morph 权重 > 0.35）
 */
export function stepBlink(
  state: BlinkState,
  nowMs: number,
  random: () => number,
  laughing = false
): BlinkOutput {
  let next = state
  const elapsed = nowMs - state.phaseStartMs

  switch (state.phase) {
    case 'idle': {
      if (nowMs >= state.nextAtMs) {
        next = {
          ...state,
          phase: 'closing',
          phaseStartMs: nowMs,
          second: state.pendingSecond,
          pendingSecond: false,
          closeMs: sampleRange(random, CLOSE_MS_MIN, CLOSE_MS_MAX),
          openMs: sampleRange(random, OPEN_MS_MIN, OPEN_MS_MAX)
        }
      }
      break
    }
    case 'closing': {
      if (elapsed >= state.closeMs) {
        next = { ...state, phase: 'opening', phaseStartMs: nowMs }
      }
      break
    }
    case 'opening': {
      if (elapsed >= state.openMs) {
        // 睁眼结束：第一下 15% 概率安排 180ms 后的第二下。
        const scheduleSecond =
          !state.second && random() < DOUBLE_BLINK_CHANCE && state.pendingSecond === false
        next = {
          ...state,
          phase: 'idle',
          phaseStartMs: nowMs,
          pendingSecond: scheduleSecond,
          nextAtMs: scheduleSecond
            ? nowMs + DOUBLE_BLINK_GAP_MS
            : nowMs + sampleBlinkInterval(random)
        }
      }
      break
    }
  }

  let weight = 0
  const phaseElapsed = nowMs - next.phaseStartMs
  if (next.phase === 'closing') {
    weight = smoothstep(next.closeMs > 0 ? phaseElapsed / next.closeMs : 1)
  } else if (next.phase === 'opening') {
    weight = 1 - smoothstep(next.openMs > 0 ? phaseElapsed / next.openMs : 1)
  }
  weight = clamp(weight, 0, 1)
  const morph = laughing ? BLINK_MORPH_LAUGHING : BLINK_MORPH
  const finalWeight = laughing ? weight * 0.5 : weight
  return {
    state: next,
    weight: finalWeight,
    morph,
    active: next.phase !== 'idle'
  }
}

/** 单次眨眼总时长（毫秒；调试用）。 */
export function blinkDurationMs(state: BlinkState): number {
  return state.closeMs + state.openMs
}
