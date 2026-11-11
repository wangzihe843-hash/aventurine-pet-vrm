/**
 * 表情（情绪）组合器（纯函数；**不 import three/DOM**）。
 *
 * 方案（`docs/anim-tech-survey.md` §5.3 + `docs/aventurine-character-brief.md` §2.3）：
 * - 情绪 = **眉 / 嘴 / 眼 / 材质** 四组；**同组互斥**、组间可叠；
 * - 同一 morph 被多层写到 → 取 **max**（MMD 表情是加算，求和会过冲变形）；
 * - 同组多源冲突 → 按优先级（反应层 > 情绪层 > 待机层），低优先级乘 `1 − 高优先级权重` 衰减；
 * - 最终权重钳制 [0, 1]；未知 morph 忽略且不抛；
 * - 口型层是独立通道（`viseme.ts`），说话时嘴型类情绪权重 ×0.3。
 *
 * 人设关键：砂金没有「开心」这一个表情，只有**五种笑**：
 * ① 营业笑（嘴笑眼不笑，`にやり` + 平眼）② 玩味/挑衅（`にやり２` + `じと目`）
 * ③ 真笑（`笑い` 闭眼 + `口角上げ`）④ 疲惫空洞（`にやり` + `目影濃`）
 * ⑤ 自嘲诀别（`悲しい` 眉 + 低权重 `にやり` + `目影濃`）。
 * **默认待机用营业笑（business），不要用 `笑い`**（否则眼睛一直是闭的，眨眼也冲突）。
 */
import type { EmotionId } from './types'

/** 表情组（同组互斥）。 */
export type EmotionGroup = 'brow' | 'mouth' | 'eye' | 'material'

/** 一个 morph 的权重定义。 */
export interface MorphWeight {
  morph: string
  weight: number
}

/** 一个情绪 = 四组里最多各一个 morph。 */
export type EmotionDef = Partial<Record<EmotionGroup, MorphWeight>>

/** 情绪定义表（morph 名必须真实存在于模型 85 morph 中；单测校验）。 */
export const EMOTION_DEFS: Readonly<Record<EmotionId, EmotionDef>> = {
  neutral: {},
  /** ① 营业笑：只动嘴，眼睛保持平（默认待机）。 */
  business: { mouth: { morph: 'にやり', weight: 0.45 } },
  /** ② 玩味/挑衅：单侧嘴角更高 + 半垂眼。 */
  smirk: { mouth: { morph: 'にやり２', weight: 0.5 }, eye: { morph: 'じと目', weight: 0.3 } },
  /** ③ 真笑：眼睛弯 + 嘴角两边上去。 */
  realSmile: { eye: { morph: '笑い', weight: 0.55 }, mouth: { morph: '口角上げ', weight: 0.5 } },
  /** ④ 疲惫空洞：笑肌在、眼睛没光。 */
  tired: { mouth: { morph: 'にやり', weight: 0.3 }, material: { morph: '目影濃', weight: 0.55 } },
  /** ⑤ 自嘲/诀别：半垂眼、苦笑。 */
  wry: {
    brow: { morph: '悲しい', weight: 0.4 },
    mouth: { morph: 'にやり', weight: 0.25 },
    material: { morph: '目影濃', weight: 0.4 }
  },
  /** 被摸头的「偷偷接受」：照れ（材质腮红）+ 柔和眼。 */
  shy: {
    material: { morph: '照れ', weight: 0.55 },
    eye: { morph: '笑目', weight: 0.35 },
    brow: { morph: '困る', weight: 0.3 },
    mouth: { morph: '口角上げ', weight: 0.22 }
  },
  /** 被戳烦（轻）。 */
  annoyed: { brow: { morph: '怒り', weight: 0.45 }, mouth: { morph: 'ムッ', weight: 0.45 } },
  /** 生气（连续被戳，翻脸）。 */
  angry: { brow: { morph: '怒り', weight: 0.75 }, mouth: { morph: 'ムッ', weight: 0.65 } },
  /** 沮丧（静音、不嚎哭）。 */
  sad: {
    brow: { morph: '悲しい', weight: 0.7 },
    mouth: { morph: '口角下げ', weight: 0.6 },
    material: { morph: '目影濃', weight: 0.5 }
  },
  /** 惊讶（被甩出/被戳瞬间，0.2–0.4s 即收）。 */
  surprise: {
    brow: { morph: '手前', weight: 0.7 },
    mouth: { morph: '大口', weight: 0.5 },
    eye: { morph: 'びっくり', weight: 0.5 }
  },
  /** 庆祝：星星眼 + 嘴角 + 一点照れ。 */
  celebrate: {
    eye: { morph: '星目', weight: 0.8 },
    mouth: { morph: '口角上げ', weight: 0.55 },
    material: { morph: '照れ', weight: 0.12 }
  },
  /** DSH 忙碌：真面目眼 + 低权重营业笑。 */
  busy: { brow: { morph: '真面目', weight: 0.35 }, mouth: { morph: 'にやり', weight: 0.3 } },
  /** 柔和（被摸头/被顺毛）。 */
  soft: { eye: { morph: 'なごみ', weight: 0.3 }, mouth: { morph: '口角上げ', weight: 0.18 } }
}

/** morph → 组（冲突检测/归一化用；未列出的 morph 视为独立通道）。 */
export const MORPH_GROUPS: Readonly<Record<string, EmotionGroup>> = {
  '怒り': 'brow',
  '怒り右': 'brow',
  '真面目': 'brow',
  '困る': 'brow',
  '手前': 'brow',
  '手前2': 'brow',
  'やっかい': 'brow',
  '悲しい': 'brow',
  '下': 'brow',
  '上': 'brow',
  '口角上げ': 'mouth',
  '口角下げ': 'mouth',
  'ムッ': 'mouth',
  '大口': 'mouth',
  '∧': 'mouth',
  'にやり': 'mouth',
  'にやり２': 'mouth',
  'にやり３': 'mouth',
  '笑い': 'eye',
  '笑い2': 'eye',
  '笑目': 'eye',
  '笑': 'eye',
  'じと目': 'eye',
  'びっくり': 'eye',
  'なごみ': 'eye',
  '星目': 'eye',
  'はぁと': 'eye',
  '喜び': 'eye',
  '照れ': 'material',
  '目影消': 'material',
  '目影濃': 'material'
}

/** 笑眼 morph（与眨眼冲突：>0.35 时改用 ウィンク）。 */
export const EYE_SMILE_MORPHS: readonly string[] = ['笑い', '笑い2', '笑目', '笑']

/** 微笑类 morph（调试面 `smile` 字段 = 这些的最大权重）。 */
export const SMILE_MORPHS: readonly string[] = [
  '笑い',
  '笑い2',
  '笑目',
  '笑',
  'にやり',
  'にやり２',
  'にやり３',
  '口角上げ'
]

/** 情绪层输入（优先级：反应 30 > 姿态基线 10）。 */
export interface EmotionEntry {
  emotion: EmotionId
  /** 层权重 0..1（淡入淡出后）。 */
  weight: number
  /** 优先级（同组冲突时高者先选并衰减低者）。 */
  priority: number
}

/** 组合选项。 */
export interface EmotionMixOptions {
  /** 是否正在说话（嘴型类情绪权重 ×0.3，避免和口型打架）。 */
  speaking?: boolean
  /** 低于该权重的结果丢弃（默认 0.02）。 */
  epsilon?: number
}

/** 取情绪定义（未知回退 neutral）。 */
export function getEmotionDef(id: string): EmotionDef {
  return EMOTION_DEFS[id as EmotionId] ?? {}
}

/**
 * 组合多个情绪层 → morph 权重 Map。
 * 同 morph 取 max；同组按优先级衰减；权重钳制 [0,1]。
 */
export function mixEmotions(
  entries: readonly EmotionEntry[],
  options: EmotionMixOptions = {}
): Map<string, number> {
  const epsilon = options.epsilon ?? 0.02
  const speaking = options.speaking ?? false

  // 按组收集候选。
  const byGroup = new Map<EmotionGroup, Array<{ morph: string; weight: number; priority: number }>>()
  for (const entry of entries) {
    const def = getEmotionDef(entry.emotion)
    const entryWeight = clamp01(entry.weight)
    if (entryWeight <= 0) continue
    for (const group of ['brow', 'mouth', 'eye', 'material'] as const) {
      const part = def[group]
      if (!part) continue
      const list = byGroup.get(group) ?? []
      list.push({
        morph: part.morph,
        weight: clamp01(part.weight * entryWeight),
        priority: entry.priority
      })
      byGroup.set(group, list)
    }
  }

  const result = new Map<string, number>()
  for (const [group, candidates] of byGroup) {
    // 优先级高者在先；同优先级按权重降序（结果稳定、可复现）。
    candidates.sort((a, b) => b.priority - a.priority || b.weight - a.weight)
    let attenuation = 1
    const selected = new Map<string, number>()
    for (const candidate of candidates) {
      const effective = clamp01(candidate.weight * attenuation)
      if (effective <= epsilon) continue
      const previous = selected.get(candidate.morph)
      if (previous !== undefined) {
        // 同 morph 取 max（MMD 加算，不能求和）。
        if (effective > previous) selected.set(candidate.morph, effective)
      } else {
        selected.set(candidate.morph, effective)
        attenuation *= 1 - effective
      }
    }
    // 说话时嘴型类情绪衰减（口型是独立通道，不参与归一化）。
    const mouthFactor = group === 'mouth' && speaking ? 0.3 : 1
    for (const [morph, weight] of selected) {
      const next = clamp01(weight * mouthFactor)
      if (next <= epsilon) continue
      result.set(morph, Math.max(result.get(morph) ?? 0, next))
    }
  }
  return result
}

/** 把第二个 morph Map 以 max 规则合并进第一个（blink/viseme 叠加用）。 */
export function mergeMorphsMax(target: Map<string, number>, extra: ReadonlyMap<string, number>): void {
  for (const [morph, weight] of extra) {
    const value = clamp01(weight)
    if (value <= 0) continue
    target.set(morph, Math.max(target.get(morph) ?? 0, value))
  }
}

/** `smile` 调试字段：微笑类 morph 的最大权重。 */
export function smileWeightOf(morphs: ReadonlyMap<string, number>): number {
  let max = 0
  for (const morph of SMILE_MORPHS) {
    const value = morphs.get(morph) ?? 0
    if (value > max) max = value
  }
  return max
}

/** 笑眼权重（眨眼冲突裁决用；>0.35 时改用 ウィンク）。 */
export function laughingEyeWeightOf(morphs: ReadonlyMap<string, number>): number {
  let max = 0
  for (const morph of EYE_SMILE_MORPHS) {
    const value = morphs.get(morph) ?? 0
    if (value > max) max = value
  }
  return max
}

/** 口型开合度（调试字段 `mouthOpen` = 6 个 viseme morph 的最大权重）。 */
export function mouthOpenOf(morphs: ReadonlyMap<string, number>): number {
  let max = 0
  for (const morph of ['あ', 'い', 'う', 'え', 'お', 'ん']) {
    const value = morphs.get(morph) ?? 0
    if (value > max) max = value
  }
  return max
}

/** 钳制到 [0,1]（NaN → 0）。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** 表情内所有非零 morph（调试面 `morphs` 字段；只列非零）。 */
export function nonZeroMorphs(morphs: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [morph, weight] of morphs) {
    if (weight > 0.001) out[morph] = Math.round(weight * 1000) / 1000
  }
  return out
}
