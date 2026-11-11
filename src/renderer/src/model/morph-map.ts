/**
 * PMX 表情 morph 名称映射（纯函数，**不 import three**）与材质 morph 规则。
 *
 * 背景（docs/model-morphs.md）：
 * - 模型共 85 个 morph：82 个顶点 morph + 3 个材质 morph（`照れ` / `目影消` / `目影濃`）；
 * - PMX 内部分名称带首尾空格（如 `星目 ` 有尾随空格），代码统一 `trim()` 后再匹配；
 * - r171 `MMDLoader` 对 `morph.type === 8`（材质 morph）只生成零位移的 morphTarget，
 *   不会改材质，因此 A2 需要按名称找到材质 + morph 索引后手动改 alpha。
 *
 * 已知限制（F16）：本模型的 3 个材质 morph 元素只含 `diffuse alpha`，所以
 * `MaterialMorphController` 目前只实现 alpha 通道。PMX 材质 morph 还可改
 * diffuse RGB / specular / ambient / edge 等通道；换模型或加表情时需要扩展控制器，
 * 否则会出现「规则命中但视觉不生效」。
 */

/** 核心表情 → 模型内候选 morph 名（候选按优先级排列，取模型里第一个存在的）。 */
export const CORE_EXPRESSIONS = {
  /** 眨眼 */
  blink: ['まばたき', 'ウィンク', 'ウィンク２', 'ウィンク右', 'ｳｨﾝｸ２右'],
  /** 笑 */
  smile: ['笑い', '笑い2', '笑目', '笑', 'にやり', 'にやり２', 'にやり３'],
  /** 害羞 / 脸红（`照れ` 是材质 morph，需要 A2 手动驱动腮红材质） */
  blush: ['照れ', '脸红'],
  /** 生气 */
  angry: ['怒り', 'ムッ', '怒った', '怒った2', '∧', '倒ω'],
  /** 难过 / 困扰 */
  sad: ['悲しい', '困る', 'やっかい', '心配する', '心配する2'],
  /** 惊讶 */
  surprise: ['びっくり', '驚かす', '手前', '手前2'],
  /** 好感 / 星星眼（`星目 ` 带尾随空格） */
  affection: ['星目', 'はぁと', 'はぅ', 'はちゅ目', 'なごみ'],
  /** 口型 */
  mouth: ['あ', 'い', 'う', 'え', 'お', 'ん']
} as const

/** 核心表情名（`CORE_EXPRESSIONS` 的键）。 */
export type CoreExpression = keyof typeof CORE_EXPRESSIONS

/** 材质 morph 的作用目标。 */
export type MaterialMorphTarget = 'blush' | 'eyeShadow'

/** 材质 morph 的 alpha 计算方式。 */
export type MaterialMorphMode = 'add' | 'multiply-hide'

/** 一条材质 morph 规则：PMX morph 名 → 目标材质名 + alpha 计算方式。 */
export interface MaterialMorphRule {
  /** PMX morph 名（trim 后匹配）。 */
  morphName: string
  /** 目标材质名（trim 后匹配）。 */
  materialName: string
  /** 作用目标（同目标的多条规则按顺序叠加）。 */
  target: MaterialMorphTarget
  /** `add`：alpha += w；`multiply-hide`：alpha ×= (1 - w)。 */
  mode: MaterialMorphMode
}

/**
 * 3 个材质 morph 的规则（§18.2 / docs/model-morphs.md）：
 * - `照れ`：`颜赤`（腮红贴图）默认 diffuse alpha = 0，加算 w 后显示；
 * - `目影消`：`目影`（默认 alpha = 0.3）乘算 (1 - w)，w=1 时隐藏；
 * - `目影濃`：`目影` 加算 w，w=1 时 alpha = 1.3（渲染时钳到 1）。
 */
export const MATERIAL_MORPH_RULES: readonly MaterialMorphRule[] = [
  { morphName: '照れ', materialName: '颜赤', target: 'blush', mode: 'add' },
  { morphName: '目影消', materialName: '目影', target: 'eyeShadow', mode: 'multiply-hide' },
  { morphName: '目影濃', materialName: '目影', target: 'eyeShadow', mode: 'add' }
]

/** 解析后的材质 morph 绑定：morph 索引 + 材质索引 + 计算方式。 */
export interface MaterialMorphBinding extends MaterialMorphRule {
  /** `mesh.morphTargetDictionary[...]` 索引。 */
  morphIndex: number
  /** `mesh.material[]` 索引。 */
  materialIndex: number
}

/** morph 名称归一化：NFC + 去首尾空白（PMX 里 `星目 ` 带尾随空格；内部空格保留）。 */
export function normalizeMorphName(name: string): string {
  if (typeof name !== 'string') return ''
  return name.normalize('NFC').trim()
}

/**
 * 在 morph 名列表里按名称（trim 后）找索引；未知名返回 null。
 * 名称重复时取第一个（本模型无重复，防御性处理）。
 */
export function findMorphIndex(morphNames: readonly string[], name: string): number | null {
  const wanted = normalizeMorphName(name)
  if (wanted.length === 0) return null
  for (let index = 0; index < morphNames.length; index += 1) {
    if (normalizeMorphName(morphNames[index]) === wanted) return index
  }
  return null
}

/**
 * 解析核心表情：返回模型里第一个可用的**原始** morph 名；未知名 / 无候选返回 null。
 * 例：`resolveCoreExpression('affection', ['星目 ', ...])` → `'星目 '`（保留原始名称，供 setMorph 使用）。
 */
export function resolveCoreExpression(
  expression: string,
  morphNames: readonly string[]
): string | null {
  if (!Object.prototype.hasOwnProperty.call(CORE_EXPRESSIONS, expression)) return null
  const candidates = CORE_EXPRESSIONS[expression as CoreExpression]
  for (const candidate of candidates) {
    const index = findMorphIndex(morphNames, candidate)
    if (index !== null) return morphNames[index]
  }
  return null
}

/** morph 名称查找表（分离「展示顺序」与「morph 索引顺序」）。 */
export interface MorphLookup {
  /** 原始 morph 名列表（展示/调试用，顺序 = morphTargetDictionary 的键顺序）。 */
  names: string[]
  /** 按 morph 索引对齐的名称数组（`namesByIndex[i]` 对应 morphTargetInfluences[i]）。 */
  namesByIndex: string[]
  /** morph 总数（= 模型表情数，85）。 */
  count: number
}

/**
 * 由 `mesh.morphTargetDictionary` 构造名称查找表。
 *
 * **重要**：不能直接用 `Object.keys(morphTargetDictionary)` 的数组下标当 morph 索引——
 * JS 对象会把 `'111'`、`'1111'` 这类整数样式键排到最前，而它们在 PMX 里的真实 morph 索引
 * 分别是 77/78（docs/model-morphs.md）；用数组下标会让后续所有表情错位。
 * 这里按字典的**值**（真实索引）填充 `namesByIndex`，供 `findMorphIndex` /
 * `resolveMaterialMorphBindings` 使用。
 */
export function createMorphLookup(
  morphTargetDictionary: Readonly<Record<string, number>>
): MorphLookup {
  const entries = Object.entries(morphTargetDictionary).filter(
    (entry): entry is [string, number] => Number.isInteger(entry[1]) && entry[1] >= 0
  )
  const maxIndex = entries.reduce((max, [, index]) => Math.max(max, index), -1)
  const namesByIndex: string[] = new Array(Math.max(0, maxIndex + 1)).fill('')
  for (const [name, index] of entries) {
    if (namesByIndex[index] === '') namesByIndex[index] = name
  }
  return {
    names: entries.map(([name]) => name),
    namesByIndex,
    count: entries.length
  }
}

/** 在材质列表里按名称（trim 后）找索引；未知名返回 null。 */
export function findMaterialIndex(
  materialNames: readonly string[],
  name: string
): number | null {
  const wanted = normalizeMorphName(name)
  if (wanted.length === 0) return null
  for (let index = 0; index < materialNames.length; index += 1) {
    if (normalizeMorphName(materialNames[index]) === wanted) return index
  }
  return null
}

/**
 * 解析材质 morph 绑定：返回 3 条规则里 morph 与目标材质都存在的子集。
 * 规则顺序保留（渲染时按顺序叠加，先乘算再加算）。
 */
export function resolveMaterialMorphBindings(
  morphNames: readonly string[],
  materialNames: readonly string[]
): MaterialMorphBinding[] {
  const bindings: MaterialMorphBinding[] = []
  for (const rule of MATERIAL_MORPH_RULES) {
    const morphIndex = findMorphIndex(morphNames, rule.morphName)
    const materialIndex = findMaterialIndex(materialNames, rule.materialName)
    if (morphIndex === null || materialIndex === null) continue
    bindings.push({ ...rule, morphIndex, materialIndex })
  }
  return bindings
}
