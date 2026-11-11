/**
 * 口型（viseme）同步（纯函数；**不 import three/DOM**）。
 *
 * 方案（`docs/anim-tech-survey.md` §5.4）：
 * - 6 个 viseme：`あ/い/う/え/お/ん`（模型自带 morph，**不新增表情资产**）；
 * - 文本 → 序列：日文假名精确映射；英文按元音；汉字无拼音库 → 按码点确定性映射（视觉上的
 *   随机开合，比不动更像说话；这是本 Wave 的已知限制，见 README）；
 * - 节奏：每字 90–140ms，交叉淡化 30ms，振幅 0.35–0.8（MMD 大口会露牙床，不用 1.0）；
 * - 结尾补一个 `ん`（闭嘴收尾）。气泡文本来源 = `AnimationInput.bubbleText`。
 *
 * 口型是独立通道：不参与情绪归一化，只和情绪嘴型互斥（说话时嘴型情绪 ×0.3，在 emotion.ts）。
 */

/** 6 个口型。 */
export type Viseme = 'あ' | 'い' | 'う' | 'え' | 'お' | 'ん'

/** 口型序列的一步（`viseme === null` 表示停顿/闭嘴）。 */
export interface VisemeStep {
  viseme: Viseme | null
  /** 持续毫秒（90–140；停顿 120–160）。 */
  ms: number
}

/** 每个 viseme 的开口幅度（0.35–0.8；survey §5.4）。 */
export const VISEME_AMPLITUDE: Readonly<Record<Viseme, number>> = {
  あ: 0.8,
  い: 0.52,
  う: 0.55,
  え: 0.65,
  お: 0.72,
  ん: 0.35
}

/** 交叉淡化时长（毫秒）。 */
export const VISEME_CROSSFADE_MS = 30

/** 单字时长范围（毫秒）。 */
export const VISEME_CHAR_MIN_MS = 90
export const VISEME_CHAR_MAX_MS = 140

/** 停顿（标点/空格）时长（毫秒）。 */
const VISEME_PAUSE_MS = 140

/** 日文假名 → viseme（按行/段近似；覆盖常用假名）。 */
const KANA_TO_VISEME: Readonly<Record<string, Viseme>> = (() => {
  const table: Record<string, Viseme> = {}
  const rows: Array<[Viseme, string]> = [
    ['あ', 'あかさたなはまやらわがざだばぱぁゃゎ'],
    ['い', 'いきしちにひみりぎじぢびぴぃ'],
    ['う', 'うくすつぬふむゆるぐずづぶぷぅゅゔ'],
    ['え', 'えけせてねへめれげぜでべぺぇ'],
    ['お', 'おこそとのほもよろをごぞどぼぽぉょ'],
    ['ん', 'ん']
  ]
  for (const [viseme, chars] of rows) {
    for (const char of chars) table[char] = viseme
  }
  return table
})()

/** 拉丁元音 → viseme。 */
const LATIN_TO_VISEME: Readonly<Record<string, Viseme>> = {
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

/** 标点/空白（产生停顿）。 */
const PAUSE_CHARS = new Set([' ', '\t', '\n', '，', '。', '、', '！', '？', '!', '?', '.', ',', '…', '—', '~', '～', '：', ':', '；', ';'])

/** 汉字候选（无拼音数据的确定性映射）。 */
const HAN_VISEMES: readonly Viseme[] = ['あ', 'い', 'う', 'え', 'お']

/** 单字时长：90–140ms（按码点确定性分散，避免机械等长）。 */
function charDurationMs(char: string, index: number): number {
  const code = char.codePointAt(0) ?? 0
  const span = VISEME_CHAR_MAX_MS - VISEME_CHAR_MIN_MS
  return VISEME_CHAR_MIN_MS + ((code * 31 + index * 17) % (span + 1))
}

/** 汉字 → viseme（码点确定性映射；已知限制）。 */
export function hanToViseme(char: string): Viseme {
  const code = char.codePointAt(0) ?? 0
  return HAN_VISEMES[code % HAN_VISEMES.length]!
}

/**
 * 文本 → viseme 序列。
 *
 * @param text 气泡文本（可含中/日/英文与标点）
 * @param lang 语言提示（本实现自动识别，参数保留给 B7/未来拼音表）
 */
export function textToVisemes(text: string, lang: 'zh' | 'ja' | 'en' | 'auto' = 'auto'): VisemeStep[] {
  void lang
  const steps: VisemeStep[] = []
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
    // 汉字（CJK 统一表意文字）→ 确定性 viseme；其它符号（emoji 等）→ 跳过。
    const code = rawChar.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) {
      steps.push({ viseme: hanToViseme(rawChar), ms: charDurationMs(rawChar, index) })
    }
  }
  if (steps.length === 0) return steps
  // 结尾补一个「ん」收口（闭嘴），除非最后一步已经是 ん 或停顿。
  const last = steps[steps.length - 1]!
  if (last.viseme !== null && last.viseme !== 'ん') {
    steps.push({ viseme: 'ん', ms: 110 })
  }
  return steps
}

/** 序列总时长（毫秒）。 */
export function visemeSequenceDurationMs(steps: readonly VisemeStep[]): number {
  return steps.reduce((sum, step) => sum + Math.max(0, step.ms), 0)
}

/** 某一时刻的口型输出。 */
export interface VisemeOutput {
  viseme: Viseme | null
  /** 开口权重 0..0.8。 */
  weight: number
  /** 序列是否播完。 */
  done: boolean
  /** 当前步索引（-1 = 未开始）。 */
  index: number
}

/**
 * 采样口型：`elapsedMs` 相对序列开始。
 * 交叉淡化：进入某步的前 30ms 淡入、离开前 30ms 淡出（与下一条重叠时取较大者）。
 */
export function stepViseme(steps: readonly VisemeStep[], elapsedMs: number): VisemeOutput {
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
        weight: Math.max(0, Math.min(0.8, amplitude * envelope)),
        done: false,
        index
      }
    }
    start = end
  }
  return { viseme: null, weight: 0, done: true, index: steps.length - 1 }
}

/** viseme → morph 名（本模型 6 个口型 morph 与名字一致）。 */
export function visemeMorph(viseme: Viseme): string {
  return viseme
}
