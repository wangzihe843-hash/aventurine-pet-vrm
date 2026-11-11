/**
 * V6 表情层 — 可接线的纯运行时模块（**不 import three / DOM / Electron**）。
 *
 * 职责：把「行为/交互/DSH 语义」翻译成 **VRM expression 权重表**，供 V6 接线层每帧
 * 对 three-vrm 的 `VRMExpressionManager.setValue(name, weight)` 逐项写入：
 *
 *   1. **情绪层**：`PetMood` / 一次性事件（摸头/戳/甩出/落地）→ 业务表情（`PET_EXPRESSIONS`）
 *      → avatar manifest 的 `expressions` 绑定 → VRM expression 名；带淡入淡出；
 *   2. **表情 clip 层**：可选的表情动画 clip（`ExpressionClip`，来自 mate/hsr 数据管线），
 *      由触发键（`drag` / `pet` / `talk` / …）选择；`loop=false` 自动播完停止；
 *   3. **眨眼层**：随机间隔 + 双眨 + 强制眨眼（v1 `animation/blink.ts` 的 VRM 移植）；
 *   4. **口型层**：气泡文本 → viseme（あいうえお）→ VRM mouth preset（`aa/ih/ou/ee/oh`）；
 *   5. **合成**：同 expression 取 max（避免叠加过冲）；说话时情绪层整体 ×0.85（让口型清楚）。
 *
 * 设计原则（与 v1 `animation/*` 纯函数一致）：
 * - 纯逻辑可单测：随机源/时钟全部注入，Node 里无需 WebGL/DOM；
 * - 不 import three；V6 接线层只做 `manager.setValue` 的转发与「未知 expression 跳过」；
 * - 未知/缺失 expression 一律跳过（缺绑定 = 不可用，不崩）。
 */
import {
  expressionClipDuration,
  mergeExpressionWeightsMax,
  resolvePetExpression,
  sampleExpressionClip,
  sanitizeExpressionWeights,
  scaleExpressionWeights,
  type ExpressionClip,
  type VisemeName
} from '@shared/expression-contract'
import type { PetMood } from '@shared/types'
import {
  PET_EXPRESSIONS,
  type PetExpression,
  type VrmExpressionBindings
} from '@shared/vrm'

/* -------------------------------------------------------------------------- */
/* 常量 / 表                                                                   */
/* -------------------------------------------------------------------------- */

/** 表情切换的默认淡入淡出时长（秒；比骨骼姿态快，符合观感）。 */
export const DEFAULT_EXPRESSION_FADE_SEC = 0.15
/** 一次性反应表情的默认持续时间（秒；从触发到完全淡出）。 */
export const DEFAULT_REACTION_EXPRESSION_SEC = 1.2
/** 说话时情绪层整体衰减系数（让口型更清楚；v1 对嘴型情绪用 0.3，这里更温和）。 */
export const DEFAULT_SPEAKING_EMOTION_FACTOR = 0.85
/** 单帧最大 dt（秒；与 B3 `MAX_DT_SEC` 同口径，防止掉帧跳变）。 */
export const MAX_EXPRESSION_DT_SEC = 0.1
/** 笑眼权重阈值：高于该值时眨眼权重 ×0.5（笑眯眼本身半闭，避免双重闭眼）。 */
export const LAUGHING_EYE_THRESHOLD = 0.35

/**
 * mood → 业务表情（情绪层的基态；`null` = 不显示表情/全零）。
 *
 * 依据：
 * - idle/walk/climb/grabWindow：中性（VRM 侧全零）；
 * - sit：`relaxed` 低权重（模型 preset relaxed = 慈愛，柔和但不闭眼）；
 * - sleep：`blink`（闭眼；权重在 `DEFAULT_EXPRESSION_INTENSITY` 给 0.92）；
 * - drag：`sad`（Mate-Engine FACE_DRAG 的 Sorrow=1 语义）；
 * - fall：`surprised`；
 * - pat：`happy`（一次性反应层优先，mood=pat 时同样兜底）；
 * - DSH：busy=`relaxed`（等待）、done=`happy`、error=`sad`。
 */
export const MOOD_EXPRESSION: Readonly<Record<PetMood, PetExpression | null>> = {
  idle: null,
  walk: null,
  climb: null,
  sit: 'relaxed',
  sleep: 'blink',
  drag: 'sad',
  fall: 'surprised',
  pat: 'happy',
  grabWindow: null,
  dshBusy: 'relaxed',
  dshDone: 'happy',
  dshError: 'sad'
}

/**
 * 业务表情的默认强度（0..1）。
 *
 * 为什么不是 1：模型 preset 是 MMD morph 的组合（happy=笑い 闭眼、relaxed=慈愛、sad=困る+心配），
 * 满权重会过度「表情包化」且贴脸（桌宠尺寸），v1 的 morph 权重也普遍 0.35–0.75。
 * 需要满强度时由调用方通过 `options.intensity` 覆盖。
 */
export const DEFAULT_EXPRESSION_INTENSITY: Readonly<Record<PetExpression, number>> = {
  blink: 0.92,
  blinkLeft: 0.7,
  blinkRight: 0.7,
  happy: 0.55,
  sad: 0.6,
  angry: 0.6,
  relaxed: 0.5,
  surprised: 0.6,
  neutral: 0
}

/** 一次性事件 kind → 业务表情（无表情 clip 时的兜底反应）。 */
export const EVENT_EXPRESSION_FALLBACK: Readonly<Record<string, PetExpression | null>> = {
  pat: 'happy',
  poke: 'surprised',
  thrown: 'surprised',
  landed: 'surprised',
  dragStart: 'sad',
  dragEnd: null,
  dshDone: 'happy',
  dshError: 'sad'
}

/**
 * 事件/mood → 表情 clip 触发键（自动推导用；manifest 里 clips 的 `triggers` 与这些键对齐）。
 * `hold=true` 表示"状态持续期间保持"（如拖拽），`false` 表示一次性播完即停。
 */
export const EXPRESSION_TRIGGER_HINTS: Readonly<
  Record<string, { id: string; hold: boolean }>
> = {
  pat: { id: 'pet', hold: false },
  poke: { id: 'poke', hold: false },
  thrown: { id: 'thrown', hold: false },
  landed: { id: 'landed', hold: false },
  drag: { id: 'drag', hold: true },
  sleep: { id: 'sleep', hold: true },
  dshBusy: { id: 'busy', hold: true },
  dshDone: { id: 'happy', hold: false },
  dshError: { id: 'sad', hold: true }
}

/** 一次性事件 kinds（本模块只关心这些；其余忽略）。 */
const ONE_SHOT_EVENT_KINDS = new Set(['pat', 'poke', 'thrown', 'landed'])

/**
 * 保持期间**压制程序化眨眼**的触发（Mate-Engine 源数据语义）：
 * Drag/Intime 的 Blink 显式 0（瞪眼委屈脸）、Head Pat/Hair Stroke 是闭眼笑（Blink=0）；
 * 播放这些 clip 时程序化 blink 必须让位，否则会与源表情冲突。
 */
const BLINK_SUPPRESSING_TRIGGERS = new Set(['drag', 'intime', 'pet', 'hairStroke'])

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** 线性插值两个权重表（只保留 >1e-4 的项）。 */
export function crossfadeExpressionWeights(
  from: Readonly<Record<string, number>>,
  to: Readonly<Record<string, number>>,
  t: number
): Record<string, number> {
  const progress = clamp01(t)
  const out: Record<string, number> = {}
  const names = new Set([...Object.keys(from), ...Object.keys(to)])
  for (const name of names) {
    const value = (from[name] ?? 0) + ((to[name] ?? 0) - (from[name] ?? 0)) * progress
    const clamped = clamp01(value)
    if (clamped > 1e-4) out[name] = clamped
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* 输入/输出类型                                                                */
/* -------------------------------------------------------------------------- */

/** 本模块关心的一次性事件子集（与 B3 `AnimationEvent` 结构兼容；多余字段忽略）。 */
export interface ExpressionEventLike {
  kind: string
}

/** 外部显式指定/自动推导的表情 clip 触发。 */
export interface ExpressionTrigger {
  /** 触发键（与 expression manifest 的 `triggers` 对齐）。 */
  id: string
  /** true = 状态持续期间保持（拖拽/睡觉/DSH busy）；false = 一次性（播完后自动回到基态）。 */
  hold: boolean
}

/** 每帧输入（由 V6/行为层构造；未知字段忽略）。 */
export interface ExpressionDriverInput {
  /** B1 当前 mood。 */
  mood: PetMood
  /** 本帧一次性动画事件（消费后由 main.ts 清空）。 */
  events?: readonly ExpressionEventLike[]
  /** 是否正在拖拽。 */
  dragging?: boolean
  /** 气泡台词（非 null = 正在说话 → 口型层）。 */
  bubbleText?: string | null
  /** 外部显式覆盖触发（`undefined` = 自动推导；`null` = 强制无 clip）。 */
  expressionTrigger?: ExpressionTrigger | null
}

/** 每帧输出快照（weight 表可直接写 three-vrm expressionManager）。 */
export interface ExpressionDriverSnapshot {
  /** 情绪层当前目标业务表情（null = 无）。 */
  baseExpression: PetExpression | null
  /** 当前生效的表情 clip 触发键（null = 无）。 */
  trigger: string | null
  /** 当前播放的 clip id（null = 无 clip）。 */
  clipId: string | null
  /** 是否处于两个 clip 的 crossfade 过渡。 */
  clipBlending: boolean
  /** 眨眼权重（0..1；已含笑眼衰减）。 */
  blinkWeight: number
  /** 是否处于眨眼动画中。 */
  blinking: boolean
  /** 当前口型（null = 闭嘴/未说话）。 */
  viseme: VisemeName | null
  /** 是否在说话（口型层激活）。 */
  speaking: boolean
  /** 最终 VRM expression 权重表（只含 >1e-4 的项）。 */
  weights: Record<string, number>
}

/** 表情驱动选项（构造时注入）。 */
export interface ExpressionDriverOptions {
  /** avatar manifest 的业务表情绑定（`VrmAvatarAsset.expressions`）。 */
  bindings: VrmExpressionBindings
  /** 随机源（眨眼间隔；单测注入固定序列）。 */
  random?: () => number
  /**
   * 表情 clip 查询函数：触发键 → clip（由 V6 从 `assets/expressions/manifest.json` +
   * clip 文件加载；找不到返回 null = 只用情绪层兜底）。
   */
  clipLookup?: (trigger: string) => ExpressionClip | null
  /** 业务表情强度覆盖（缺省用 `DEFAULT_EXPRESSION_INTENSITY`）。 */
  intensity?: Partial<Record<PetExpression, number>>
  /** 淡入淡出时长（秒；默认 0.15）。 */
  fadeSec?: number
  /** 一次性反应表情持续时长（秒；默认 1.2）。 */
  reactionSec?: number
  /** 说话时情绪层衰减系数（默认 0.85）。 */
  speakingEmotionFactor?: number
  /** 眨眼开关（默认开）。 */
  blinkEnabled?: boolean
}

/* -------------------------------------------------------------------------- */
/* 眨眼调度（v1 animation/blink.ts 的 VRM 移植）                                 */
/* -------------------------------------------------------------------------- */

/** 眨眼调度配置（毫秒；与 v1 常量一致，便于观感对齐）。 */
export interface BlinkSchedulerOptions {
  /** 随机间隔下限（毫秒）。 */
  intervalMinMs?: number
  /** 随机间隔上限（毫秒）。 */
  intervalMaxMs?: number
  /** 双眨概率。 */
  doubleBlinkChance?: number
  /** 双眨间隔（毫秒）。 */
  doubleBlinkGapMs?: number
  /** 闭眼时长范围（毫秒）。 */
  closeMsMin?: number
  closeMsMax?: number
  /** 睁眼时长范围（毫秒）。 */
  openMsMin?: number
  openMsMax?: number
}

const BLINK_DEFAULTS = {
  intervalMinMs: 2200,
  intervalMaxMs: 6500,
  doubleBlinkChance: 0.15,
  doubleBlinkGapMs: 180,
  closeMsMin: 45,
  closeMsMax: 55,
  openMsMin: 65,
  openMsMax: 75
} as const

/** 眨眼阶段。 */
export type BlinkPhase = 'idle' | 'closing' | 'opening'

/** 眨眼调度器（纯状态机；随机源注入）。 */
export class BlinkScheduler {
  private readonly random: () => number
  private readonly options: Required<BlinkSchedulerOptions>
  private phase: BlinkPhase = 'idle'
  private phaseStartMs = 0
  private nextAtMs = 0
  private closeMs = 50
  private openMs = 70
  private second = false
  private pendingSecond = false
  private enabled: boolean

  constructor(options: BlinkSchedulerOptions = {}, random: () => number = Math.random) {
    this.random = random
    this.options = { ...BLINK_DEFAULTS, ...options }
    this.enabled = true
    this.reset(0)
  }

  /** 重置到初始状态（`nowMs` = 当前时钟）。 */
  reset(nowMs: number): void {
    this.phase = 'idle'
    this.phaseStartMs = nowMs
    this.nextAtMs = nowMs + this.sampleRange(1200, 3000)
    this.closeMs = this.sampleRange(this.options.closeMsMin, this.options.closeMsMax)
    this.openMs = this.sampleRange(this.options.openMsMin, this.options.openMsMax)
    this.second = false
    this.pendingSecond = false
  }

  /** 开关（关闭时立即停止闪烁并归零）。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.phase = 'idle'
    }
  }

  /** 立即触发一次眨眼（不打断正在进行的眨眼；`nowMs` = 当前时钟）。 */
  forceBlink(nowMs: number): void {
    if (!this.enabled || this.phase !== 'idle') return
    this.phase = 'closing'
    this.phaseStartMs = nowMs
    this.nextAtMs = nowMs + 600
  }

  /** 当前是否处于眨眼动画中。 */
  get active(): boolean {
    return this.phase !== 'idle'
  }

  /** 当前眨眼权重（0..1；`elapsedMs` 单调递增）。 */
  weightAt(elapsedMs: number): number {
    if (!this.enabled) return 0
    const elapsed = elapsedMs - this.phaseStartMs
    if (this.phase === 'closing') {
      return clamp01(this.smoothstep(this.closeMs > 0 ? elapsed / this.closeMs : 1))
    }
    if (this.phase === 'opening') {
      return clamp01(1 - this.smoothstep(this.openMs > 0 ? elapsed / this.openMs : 1))
    }
    return 0
  }

  /**
   * 推进状态机（`nowMs` 单调递增）。
   * @param laughingWeight 当前笑眼权重（>0.35 时眨眼权重 ×0.5，避免双重闭眼）
   */
  update(nowMs: number, laughingWeight = 0): { state: BlinkPhase; weight: number; active: boolean } {
    if (!this.enabled) return { state: 'idle', weight: 0, active: false }
    const elapsed = nowMs - this.phaseStartMs
    if (this.phase === 'idle' && nowMs >= this.nextAtMs) {
      this.phase = 'closing'
      this.phaseStartMs = nowMs
      this.second = this.pendingSecond
      this.pendingSecond = false
      this.closeMs = this.sampleRange(this.options.closeMsMin, this.options.closeMsMax)
      this.openMs = this.sampleRange(this.options.openMsMin, this.options.openMsMax)
    } else if (this.phase === 'closing' && elapsed >= this.closeMs) {
      this.phase = 'opening'
      this.phaseStartMs = nowMs
    } else if (this.phase === 'opening' && elapsed >= this.openMs) {
      const scheduleSecond =
        !this.second && this.random() < this.options.doubleBlinkChance && !this.pendingSecond
      this.phase = 'idle'
      this.phaseStartMs = nowMs
      this.pendingSecond = scheduleSecond
      this.nextAtMs = scheduleSecond
        ? nowMs + this.options.doubleBlinkGapMs
        : nowMs + this.sampleInterval()
    }
    let weight = this.weightAt(nowMs)
    if (laughingWeight > LAUGHING_EYE_THRESHOLD) weight *= 0.5
    return { state: this.phase, weight: clamp01(weight), active: this.phase !== 'idle' }
  }

  private sampleInterval(): number {
    const u = clamp01(this.random())
    const sample = this.options.intervalMinMs - Math.log(1 - u * 0.999999) * 1500
    return Math.min(this.options.intervalMaxMs, Math.max(this.options.intervalMinMs, sample))
  }

  private sampleRange(min: number, max: number): number {
    return min + clamp01(this.random()) * (max - min)
  }

  private smoothstep(value: number): number {
    const x = clamp01(value)
    return x * x * (3 - 2 * x)
  }
}

/* -------------------------------------------------------------------------- */
/* 口型调度（v1 animation/viseme.ts 的 VRM 移植）                                 */
/* -------------------------------------------------------------------------- */

/** 口型序列的一步。 */
export interface VisemeStepEntry {
  viseme: VisemeName | null
  /** 持续毫秒。 */
  ms: number
}

/** 每个 viseme 的开口幅度（0.35–0.8；v1 观感值）。 */
export const VISEME_AMPLITUDE: Readonly<Record<VisemeName, number>> = {
  あ: 0.8,
  い: 0.52,
  う: 0.55,
  え: 0.65,
  お: 0.72,
  ん: 0.35
}

/** 口型交叉淡化时长（毫秒）。 */
export const VISEME_CROSSFADE_MS = 30
/** 单字时长范围（毫秒）。 */
export const VISEME_CHAR_MIN_MS = 90
export const VISEME_CHAR_MAX_MS = 140
/** 标点/空格停顿（毫秒）。 */
export const VISEME_PAUSE_MS = 140

const KANA_TO_VISEME: Readonly<Record<string, VisemeName>> = (() => {
  const table: Record<string, VisemeName> = {}
  const rows: Array<[VisemeName, string]> = [
    ['あ', 'あかさたなはまやらわがざだばぱぁゃゎ'],
    ['い', 'いきしちにひみりぎじぢびぴぃ'],
    ['う', 'うくすつぬふむゆるぐずづぶぷぅゅゔ'],
    ['え', 'えけせてねへめれげぜでべぺぇ'],
    ['お', 'おこそとのほもよろをごぞどぼぽぉょ'],
    ['ん', 'ん']
  ]
  for (const [viseme, chars] of rows) for (const char of chars) table[char] = viseme
  return table
})()

const LATIN_TO_VISEME: Readonly<Record<string, VisemeName>> = {
  a: 'あ',
  i: 'い',
  u: 'う',
  e: 'え',
  o: 'お',
  y: 'い',
  w: 'う',
  m: 'ん',
  n: 'ん'
}

const PAUSE_CHARS = new Set([
  ' ', '\t', '\n', '，', '。', '、', '！', '？', '!', '?', '.', ',', '…', '—', '~', '～', '：', ':', '；', ';'
])

const HAN_VISEMES: readonly VisemeName[] = ['あ', 'い', 'う', 'え', 'お']

/** 汉字 → viseme（码点确定性映射；v1 已知限制，不引入拼音库）。 */
export function hanToViseme(char: string): VisemeName {
  const code = char.codePointAt(0) ?? 0
  return HAN_VISEMES[code % HAN_VISEMES.length]!
}

function charDurationMs(char: string, index: number): number {
  const code = char.codePointAt(0) ?? 0
  const span = VISEME_CHAR_MAX_MS - VISEME_CHAR_MIN_MS
  return VISEME_CHAR_MIN_MS + ((code * 31 + index * 17) % (span + 1))
}

/** 文本 → 口型序列（中/日/英；标点产生停顿；结尾补「ん」收口）。 */
export function textToVisemes(text: string): VisemeStepEntry[] {
  const steps: VisemeStepEntry[] = []
  if (typeof text !== 'string' || text.length === 0) return steps
  let index = 0
  for (const rawChar of Array.from(text)) {
    const char = rawChar.toLowerCase()
    index += 1
    if (PAUSE_CHARS.has(rawChar) || PAUSE_CHARS.has(char)) {
      steps.push({ viseme: null, ms: VISEME_PAUSE_MS })
      continue
    }
    const kana = KANA_TO_VISEME[rawChar]
    if (kana) {
      steps.push({ viseme: kana, ms: charDurationMs(rawChar, index) })
      continue
    }
    const latin = LATIN_TO_VISEME[char]
    if (latin) {
      steps.push({ viseme: latin, ms: charDurationMs(rawChar, index) })
      continue
    }
    const code = rawChar.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) {
      steps.push({ viseme: hanToViseme(rawChar), ms: charDurationMs(rawChar, index) })
    }
  }
  if (steps.length === 0) return steps
  const last = steps[steps.length - 1]!
  if (last.viseme !== null && last.viseme !== 'ん') steps.push({ viseme: 'ん', ms: 110 })
  return steps
}

/** 序列总时长（毫秒）。 */
export function visemeSequenceDurationMs(steps: readonly VisemeStepEntry[]): number {
  return steps.reduce((sum, step) => sum + Math.max(0, step.ms), 0)
}

/** 某一时刻的口型输出。 */
export interface VisemeSample {
  viseme: VisemeName | null
  weight: number
  done: boolean
  index: number
}

/** 采样口型（`elapsedMs` 相对序列开始；交叉淡化；权重已含幅度）。 */
export function sampleVisemes(steps: readonly VisemeStepEntry[], elapsedMs: number): VisemeSample {
  if (steps.length === 0) return { viseme: null, weight: 0, done: true, index: -1 }
  const elapsed = Math.max(0, elapsedMs)
  let start = 0
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    const end = start + Math.max(0, step.ms)
    if (elapsed < end) {
      const local = elapsed - start
      const stepDuration = Math.max(1, step.ms)
      const fadeIn = Math.min(VISEME_CROSSFADE_MS, stepDuration / 2)
      const fadeOut = Math.min(VISEME_CROSSFADE_MS, stepDuration / 2)
      let envelope = 1
      if (fadeIn > 0 && local < fadeIn) envelope = local / fadeIn
      else if (fadeOut > 0 && end - elapsed < fadeOut) envelope = Math.max(0, (end - elapsed) / fadeOut)
      const amplitude = step.viseme ? VISEME_AMPLITUDE[step.viseme] : 0
      return {
        viseme: step.viseme,
        weight: clamp01(amplitude * envelope),
        done: false,
        index
      }
    }
    start = end
  }
  return { viseme: null, weight: 0, done: true, index: steps.length - 1 }
}

/** 口型序列播放器（气泡文本变化时重建，按 dt 推进）。 */
export class VisemeScheduler {
  private steps: VisemeStepEntry[] = []
  private elapsedMs = 0
  private speaking = false
  private text: string | null = null

  /** 更新台词：相同文本不重建（避免每帧重启）。 */
  setText(text: string | null | undefined): void {
    const next = typeof text === 'string' && text.trim().length > 0 ? text : null
    if (next === this.text) return
    this.text = next
    this.steps = next === null ? [] : textToVisemes(next)
    this.elapsedMs = 0
    this.speaking = next !== null
  }

  /** 当前台词。 */
  get currentText(): string | null {
    return this.text
  }

  /** 推进时间并采样。 */
  update(dtSec: number): VisemeSample {
    if (this.steps.length === 0) return { viseme: null, weight: 0, done: true, index: -1 }
    this.elapsedMs += Math.max(0, Number.isFinite(dtSec) ? dtSec : 0) * 1000
    const sample = sampleVisemes(this.steps, this.elapsedMs)
    if (sample.done) {
      // 播完即闭嘴（保留 steps 以便重复更新稳定返回 done）。
      return { viseme: null, weight: 0, done: true, index: sample.index }
    }
    return sample
  }

  /** 是否仍在说话（有序列且未播完）。 */
  get active(): boolean {
    return this.speaking && this.elapsedMs < visemeSequenceDurationMs(this.steps)
  }

  reset(): void {
    this.steps = []
    this.elapsedMs = 0
    this.speaking = false
    this.text = null
  }
}

/* -------------------------------------------------------------------------- */
/* 表情 clip 层                                                                */
/* -------------------------------------------------------------------------- */

/** 表情 clip 层选项。 */
export interface ExpressionClipLayerOptions {
  /** 淡入时长覆盖（秒；缺省用 clip.fadeInSec 或 0.12）。 */
  fadeInSec?: number
  /** 淡出时长覆盖（秒；缺省用 clip.fadeOutSec 或 0.2）。 */
  fadeOutSec?: number
  /** 循环 clip 的起始相位（秒；调用方可注入随机相位，避免 10s 图案每圈一样）。 */
  phaseSec?: number
}

/** 一个播放槽（淡入/持续/淡出；层内最多 2 个 = 当前 + 上一个，用于线性 crossfade）。 */
interface ClipSlot {
  clip: ExpressionClip
  elapsedSec: number
  fadeInSec: number
  fadeOutSec: number
  weight: number
  stopping: boolean
}

/** 循环 clip 的采样时间（seconds；loop 回绕）。 */
function clipTimeFor(slot: ClipSlot): number {
  const duration = expressionClipDuration(slot.clip)
  if (!(duration > 0)) return 0
  return slot.clip.loop === true ? slot.elapsedSec % duration : Math.min(slot.elapsedSec, duration)
}

/**
 * 表情 clip 层：支持两个 clip 的**线性 crossfade**（Unity Animator 的固定秒数过渡等价物），
 * `loop=false` 播完自动淡出；淡入/淡出时长优先取 clip 自身字段（数据管线从源状态机抄来的
 * 0.05–1.0s），失败回退层默认值。
 *
 * 播放语义（V6 接线）：
 * - `play(clip)`：新 clip 淡入；旧的标记淡出（同轨道线性加权混合，等价 Unity crossfade）；
 * - 同一 clip id 重复 play → no-op；
 * - `stop()`：全部淡出；`stop(true)`：立即清空；
 * - `update(dtSec)` → 当前帧权重表（0..1；`definesBlink` 告诉驱动层"blink 由 clip 权威定义"）。
 */
export class ExpressionClipLayer {
  private readonly defaultFadeInSec: number
  private readonly defaultFadeOutSec: number
  private slots: ClipSlot[] = []

  constructor(options: ExpressionClipLayerOptions = {}) {
    this.defaultFadeInSec = options.fadeInSec ?? 0.12
    this.defaultFadeOutSec = options.fadeOutSec ?? 0.2
  }

  /** 当前（最新）clip id（null = 无）。 */
  get clipId(): string | null {
    return this.slots.length === 0 ? null : this.slots[this.slots.length - 1]!.clip.id
  }

  /** 是否正在 crossfade（>1 个槽）。 */
  get blending(): boolean {
    return this.slots.length > 1
  }

  /** 当前所有槽的 clip 是否含 blink 轨道（clip 权威定义眨眼时，驱动层应关程序化 blink）。 */
  get definesBlink(): boolean {
    for (const slot of this.slots) {
      if (hasBlinkTrack(slot.clip)) return true
    }
    return false
  }

  /** 开始播放 clip（同 id 且在播则 no-op）。 */
  play(clip: ExpressionClip, options: ExpressionClipLayerOptions = {}): void {
    const current = this.slots[this.slots.length - 1]
    if (current?.clip.id === clip.id && !current.stopping) return
    const fadeInSec = Math.max(0, options.fadeInSec ?? clip.fadeInSec ?? this.defaultFadeInSec)
    const fadeOutSec = Math.max(0, options.fadeOutSec ?? clip.fadeOutSec ?? this.defaultFadeOutSec)
    // 旧槽进入淡出（沿用旧 clip 自己的 fadeOut；新的淡入时长独立）。
    for (const slot of this.slots) {
      if (slot.stopping) continue
      slot.stopping = true
      slot.fadeOutSec = Math.max(0.001, slot.clip.fadeOutSec ?? fadeOutSec)
    }
    const phase = Number.isFinite(options.phaseSec) && options.phaseSec! > 0 ? options.phaseSec! : 0
    this.slots.push({
      clip,
      elapsedSec: clip.loop === true ? phase : 0,
      fadeInSec,
      fadeOutSec,
      weight: 0,
      stopping: false
    })
    // 最多保留 2 个槽（新 + 旧）；淘汰更早的瞬时槽。
    if (this.slots.length > 2) this.slots = this.slots.slice(-2)
  }

  /** 停止（淡出）；`immediate=true` 立即清空。 */
  stop(immediate = false): void {
    if (immediate) {
      this.slots = []
      return
    }
    for (const slot of this.slots) {
      if (slot.stopping) continue
      slot.stopping = true
      slot.fadeOutSec = Math.max(0.001, slot.clip.fadeOutSec ?? this.defaultFadeOutSec)
    }
  }

  /** 推进并返回当前帧权重表（crossfade 线性加权和，clamp 0..1）。 */
  update(dtSec: number): Record<string, number> {
    if (this.slots.length === 0) return {}
    const dt = Math.min(MAX_EXPRESSION_DT_SEC, Math.max(0, Number.isFinite(dtSec) ? dtSec : 0))
    const merged: Record<string, number> = {}
    for (const slot of this.slots) {
      slot.elapsedSec += dt
      const duration = expressionClipDuration(slot.clip)
      if (slot.clip.loop !== true && duration > 0 && slot.elapsedSec >= duration) {
        if (!slot.stopping) {
          slot.stopping = true
          slot.fadeOutSec = Math.max(0.001, slot.clip.fadeOutSec ?? this.defaultFadeOutSec)
        }
      }
      if (slot.stopping) {
        slot.weight -= dt / Math.max(0.001, slot.fadeOutSec)
      } else if (slot.weight < 1) {
        slot.weight = Math.min(1, slot.weight + dt / Math.max(0.001, slot.fadeInSec))
      }
      const weight = clamp01(slot.weight)
      if (weight <= 1e-4) continue
      const sampled = sampleExpressionClip(slot.clip, clipTimeFor(slot))
      for (const [name, value] of Object.entries(sampled)) {
        const next = clamp01((merged[name] ?? 0) + value * weight)
        if (next > 1e-4) merged[name] = next
      }
    }
    this.slots = this.slots.filter((slot) => slot.weight > 1e-4 || !slot.stopping)
    return merged
  }

  reset(): void {
    this.slots = []
  }
}

const BLINK_TRACK_NAMES = ['blink', 'blinkLeft', 'blinkRight'] as const

function hasBlinkTrack(clip: ExpressionClip): boolean {
  for (const name of BLINK_TRACK_NAMES) {
    if (Object.prototype.hasOwnProperty.call(clip.tracks ?? {}, name)) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* 表情驱动                                                                    */
/* -------------------------------------------------------------------------- */

/** 一次性反应表情的计时状态。 */
interface ReactionState {
  expression: PetExpression
  elapsedSec: number
  durationSec: number
}

/** 情绪层交叉淡化状态。 */
interface FadeState {
  from: Record<string, number>
  to: Record<string, number>
  elapsedSec: number
  durationSec: number
}

/**
 * VRM 表情驱动（可接线纯模块）。
 *
 * 用法（V6 接线示例）：
 * ```ts
 * const driver = new VRMExpressionDriver({
 *   bindings: avatar.expressions,
 *   clipLookup: (trigger) => clipRegistry.get(trigger) ?? null
 * })
 * // 每帧：
 * const snapshot = driver.update(dt, { mood, events, dragging, bubbleText })
 * driver.resetValues?.(manager) // 或对 manager.expressionMap 全量 setValue(0) 后逐项写入
 * for (const [name, weight] of Object.entries(snapshot.weights)) manager.setValue(name, weight)
 * ```
 */
export class VRMExpressionDriver {
  private readonly bindings: VrmExpressionBindings
  private readonly random: () => number
  private readonly clipLookup: ((trigger: string) => ExpressionClip | null) | null
  private readonly intensity: Record<PetExpression, number>
  private readonly fadeSec: number
  private readonly reactionSec: number
  private readonly speakingEmotionFactor: number
  private readonly blink: BlinkScheduler
  private readonly viseme: VisemeScheduler
  private readonly clipLayer: ExpressionClipLayer

  private nowMs = 0
  private baseExpression: PetExpression | null = null
  private baseFade: FadeState | null = null
  private baseWeights: Record<string, number> = {}
  private reaction: ReactionState | null = null
  private trigger: ExpressionTrigger | null = null
  private lastAutoTriggerKey = ''
  /** 显式 `playClip()` 接管中（忽略自动触发，直到 `stopClip()`/播完）。 */
  private manualClip = false

  constructor(options: ExpressionDriverOptions) {
    this.bindings = options.bindings ?? {}
    this.random = options.random ?? Math.random
    this.clipLookup = options.clipLookup ?? null
    this.intensity = { ...DEFAULT_EXPRESSION_INTENSITY, ...(options.intensity ?? {}) }
    this.fadeSec = Math.max(0, options.fadeSec ?? DEFAULT_EXPRESSION_FADE_SEC)
    this.reactionSec = Math.max(0.1, options.reactionSec ?? DEFAULT_REACTION_EXPRESSION_SEC)
    this.speakingEmotionFactor =
      options.speakingEmotionFactor === undefined
        ? DEFAULT_SPEAKING_EMOTION_FACTOR
        : clamp01(options.speakingEmotionFactor)
    this.blink = new BlinkScheduler({}, this.random)
    this.viseme = new VisemeScheduler()
    this.clipLayer = new ExpressionClipLayer()
    this.blink.setEnabled(options.blinkEnabled !== false)
  }

  /** 立即触发一次眨眼。 */
  forceBlink(): void {
    this.blink.forceBlink(this.nowMs)
  }

  /** 显式播放某条 expression clip（接管自动触发；不改变 mood；`stopClip()`/播完才结束）。 */
  playClip(clip: ExpressionClip): void {
    this.manualClip = true
    this.trigger = { id: clip.id, hold: true }
    this.clipLayer.play(clip)
    this.lastAutoTriggerKey = `manual:${clip.id}`
  }

  /** 停止当前 clip（退出显式接管）。 */
  stopClip(immediate = false): void {
    this.manualClip = false
    this.trigger = null
    this.clipLayer.stop(immediate)
    this.lastAutoTriggerKey = ''
  }

  /** 重置全部状态（模型切换/测试用）。 */
  reset(): void {
    this.nowMs = 0
    this.baseExpression = null
    this.baseFade = null
    this.baseWeights = {}
    this.reaction = null
    this.trigger = null
    this.lastAutoTriggerKey = ''
    this.manualClip = false
    this.blink.reset(0)
    this.viseme.reset()
    this.clipLayer.reset()
  }

  /**
   * 每帧推进（`dtSec` 会被钳制到 `MAX_EXPRESSION_DT_SEC`）。
   * 返回的 `snapshot.weights` 只含非零项，可直接逐项 `expressionManager.setValue`。
   */
  update(dtSec: number, input: ExpressionDriverInput): ExpressionDriverSnapshot {
    const dt = Math.min(
      MAX_EXPRESSION_DT_SEC,
      Math.max(0, Number.isFinite(dtSec) ? dtSec : 0)
    )
    this.nowMs += dt * 1000

    // 1) 台词/口型
    this.viseme.setText(input.bubbleText ?? null)
    const visemeSample = this.viseme.update(dt)
    const speaking = this.viseme.active

    // 2) 触发推导（显式 > 自动；playClip 接管期间不动 clip）
    if (!this.manualClip) {
      const auto = this.deriveTrigger(input)
      const explicit = input.expressionTrigger
      const trigger = explicit === undefined ? auto : explicit
      this.applyTrigger(trigger)
    }

    // 3) 情绪层目标（mood + 一次性事件/兜底 + 反应计时）
    const moodExpression = MOOD_EXPRESSION[input.mood] ?? null
    let targetExpression: PetExpression | null = moodExpression
    if (this.trigger) {
      const hint = EXPRESSION_TRIGGER_HINTS[this.trigger.id]
      const fallback = EVENT_EXPRESSION_FALLBACK[this.trigger.id] ?? null
      if (fallback !== null && hint !== undefined) targetExpression = fallback
      // 一次性事件触发：即使没有 clip，也用反应层兜底（如 pat → happy）。
      if (hint !== undefined && hint.hold === false && fallback === null) targetExpression = moodExpression
    }
    // 一次性事件：反应层覆盖基态（pat/poke/thrown/landed），用独立计时淡出。
    this.updateReaction(input, dt)
    this.setBaseExpression(targetExpression)

    // 4) 各层权重
    const emotionWeights = this.resolveEmotionWeights(dt, speaking)
    const clipWeights = this.clipLayer.update(dt)
    if (this.manualClip && this.clipLayer.clipId === null) {
      this.manualClip = false
      this.trigger = null
    }
    const happyName = this.resolveBinding('happy')
    const laughWeight =
      happyName === null
        ? 0
        : Math.max(emotionWeights[happyName] ?? 0, clipWeights[happyName] ?? 0)
    const blinkOutput = this.blink.update(this.nowMs, laughWeight)
    const suppressBlink =
      input.dragging === true ||
      (this.trigger !== null && BLINK_SUPPRESSING_TRIGGERS.has(this.trigger.id)) ||
      this.clipLayer.definesBlink
    const blinkWeight = input.mood === 'sleep' ? 0.95 : suppressBlink ? 0 : blinkOutput.weight

    let merged = mergeExpressionWeightsMax({}, emotionWeights)
    merged = mergeExpressionWeightsMax(merged, clipWeights)
    const blinkName = this.resolveBinding('blink')
    if (blinkName !== null && blinkWeight > 1e-4) {
      merged = mergeExpressionWeightsMax(merged, { [blinkName]: blinkWeight })
    }
    const visemeMap = this.visemeWeights(visemeSample)
    merged = mergeExpressionWeightsMax(merged, visemeMap)

    return {
      baseExpression: this.reaction?.expression ?? this.baseExpression,
      trigger: this.trigger?.id ?? null,
      clipId: this.clipLayer.clipId,
      clipBlending: this.clipLayer.blending,
      blinkWeight: clamp01(blinkWeight),
      blinking: (blinkOutput.active || input.mood === 'sleep') && !suppressBlink,
      viseme: visemeSample.viseme,
      speaking,
      weights: merged
    }
  }

  /** 业务表情 → VRM expression 名（缺绑定 null）。 */
  resolveBinding(expression: PetExpression): string | null {
    return resolvePetExpression(this.bindings, expression)
  }

  private deriveTrigger(input: ExpressionDriverInput): ExpressionTrigger | null {
    if (input.dragging) return { id: EXPRESSION_TRIGGER_HINTS.drag!.id, hold: true }
    for (const event of input.events ?? []) {
      const kind = typeof event?.kind === 'string' ? event.kind : ''
      if (kind === 'dragStart') return { id: 'drag', hold: true }
      const hint = EXPRESSION_TRIGGER_HINTS[kind]
      if (hint) return { id: hint.id, hold: hint.hold }
    }
    if (input.mood === 'dshBusy' || input.mood === 'dshDone' || input.mood === 'dshError') {
      const hint = EXPRESSION_TRIGGER_HINTS[input.mood]
      if (hint) return { id: hint.id, hold: hint.hold }
    }
    if (input.mood === 'sleep' && this.clipLookup?.(EXPRESSION_TRIGGER_HINTS.sleep!.id) != null) {
      return { id: EXPRESSION_TRIGGER_HINTS.sleep!.id, hold: true }
    }
    return null
  }

  /** 应用触发：按需换 clip / 关闭 clip / 兜底情绪。 */
  private applyTrigger(trigger: ExpressionTrigger | null): void {
    const key = trigger === null ? '' : `${trigger.id}:${trigger.hold ? 'h' : 'o'}`
    const previous = this.trigger
    this.trigger = trigger
    if (key === this.lastAutoTriggerKey) return
    this.lastAutoTriggerKey = key
    if (trigger === null) {
      this.clipLayer.stop()
      return
    }
    const clip = this.clipLookup?.(trigger.id) ?? null
    if (clip !== null) {
      // 循环 clip 随机起始相位（Mate 建议：避免 10s 眨眼图案每圈相同）。
      const duration = expressionClipDuration(clip)
      const phaseSec =
        clip.loop === true && duration > 0 ? clamp01(this.random()) * duration : 0
      this.clipLayer.play(clip, { phaseSec })
      return
    }
    // 无 clip：停止上一个 clip，交给情绪层兜底。
    if (previous !== null) this.clipLayer.stop()
  }

  private updateReaction(input: ExpressionDriverInput, dtSec: number): void {
    const events = input.events ?? []
    for (const event of events) {
      const kind = typeof event?.kind === 'string' ? event.kind : ''
      if (!ONE_SHOT_EVENT_KINDS.has(kind)) continue
      const expression = EVENT_EXPRESSION_FALLBACK[kind]
      if (!expression) continue
      this.reaction = { expression, elapsedSec: 0, durationSec: this.reactionSec }
      break
    }
    if (this.reaction) {
      this.reaction.elapsedSec += dtSec
      if (this.reaction.elapsedSec >= this.reaction.durationSec) this.reaction = null
    }
  }

  private setBaseExpression(expression: PetExpression | null): void {
    if (expression === this.baseExpression) return
    const from = this.baseWeights
    const to = this.expressionWeights(expression)
    this.baseExpression = expression
    this.baseWeights = to
    if (this.fadeSec <= 0) {
      this.baseFade = null
      return
    }
    this.baseFade = { from, to, elapsedSec: 0, durationSec: this.fadeSec }
  }

  /** 情绪层：基态淡入淡出 + 反应层 + 说话衰减。 */
  private resolveEmotionWeights(dtSec: number, speaking: boolean): Record<string, number> {
    let current = this.baseWeights
    if (this.baseFade) {
      this.baseFade.elapsedSec += dtSec
      const t = this.baseFade.durationSec <= 0 ? 1 : this.baseFade.elapsedSec / this.baseFade.durationSec
      current = crossfadeExpressionWeights(this.baseFade.from, this.baseFade.to, t)
      if (t >= 1) this.baseFade = null
    }
    let weights = { ...current }
    if (this.reaction) {
      const progress = this.reaction.elapsedSec / this.reaction.durationSec
      const envelope = progress < 0.15 ? progress / 0.15 : clamp01((1 - progress) / 0.4)
      const reactionWeights = scaleExpressionWeights(
        this.expressionWeights(this.reaction.expression),
        envelope
      )
      weights = mergeExpressionWeightsMax(weights, reactionWeights)
    }
    if (speaking) weights = scaleExpressionWeights(weights, this.speakingEmotionFactor)
    return weights
  }

  /** 业务表情 → 强度缩放后的 VRM 权重表。 */
  private expressionWeights(expression: PetExpression | null): Record<string, number> {
    if (expression === null) return {}
    const name = this.resolveBinding(expression)
    if (name === null) return {}
    const weight = clamp01(this.intensity[expression] ?? 0)
    if (weight <= 0) return {}
    return { [name]: weight }
  }

  private visemeWeights(sample: VisemeSample): Record<string, number> {
    if (sample.viseme === null || sample.weight <= 0) return {}
    const name = VISEME_TO_PRESET[sample.viseme]
    if (name === null) return {}
    return { [name]: clamp01(sample.weight) }
  }
}

/** viseme → VRM mouth preset 名（`ん` = 闭口）。 */
export const VISEME_TO_PRESET: Readonly<Record<VisemeName, string | null>> = {
  あ: 'aa',
  い: 'ih',
  う: 'ou',
  え: 'ee',
  お: 'oh',
  ん: null
}

/* -------------------------------------------------------------------------- */
/* 接线辅助                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 把权重表写入 three-vrm `expressionManager` 的最小结构接口。
 * 本模块不 import three：V6 接线层传真实 manager 即可（结构化鸭子类型）。
 */
export interface ExpressionWeightTarget {
  setValue(name: string, weight: number): void
  getValue?(name: string): number | null
}

/**
 * 全量写入权重：先对 `knownNames` 清零，再写入非零权重（避免上一帧残留）。
 *
 * @param target three-vrm `VRMExpressionManager`（或其子集）
 * @param weights `VRMExpressionDriver.update()` 返回的权重表
 * @param knownNames 当前模型真实存在的 expression 名（loader/`VRMExpressionManager.expressionMap`）
 */
export function applyExpressionWeights(
  target: ExpressionWeightTarget,
  weights: Readonly<Record<string, number>>,
  knownNames: Iterable<string>
): void {
  if (!target || typeof target.setValue !== 'function') return
  const names = knownNames ? Array.from(knownNames) : []
  for (const name of names) {
    target.setValue(name, 0)
  }
  for (const [name, weight] of Object.entries(sanitizeExpressionWeights(weights))) {
    target.setValue(name, weight)
  }
}

/** 把业务表情绑定表里出现过的名字去重（V6 接线写清零用）。 */
export function boundExpressionNames(bindings: VrmExpressionBindings): string[] {
  const names = new Set<string>()
  for (const expression of PET_EXPRESSIONS) {
    const name = resolvePetExpression(bindings, expression)
    if (name !== null) names.add(name)
  }
  return [...names]
}

/** 调试快照里是否包含某业务表情的绑定（单测/接线自检用）。 */
export function hasPetExpressionBinding(
  bindings: VrmExpressionBindings,
  expression: PetExpression
): boolean {
  return resolvePetExpression(bindings, expression) !== null
}
