/**
 * 单测：PMX 表情 morph 名称映射（`src/renderer/src/model/morph-map.ts`）。
 *
 * 覆盖：
 * - `星目 ` 尾随空格 / 首尾空白 / NFC 归一化；
 * - 未知名返回 null（不抛异常）；
 * - `CORE_EXPRESSIONS` 核心表情候选按优先级解析；
 * - 3 条材质 morph 规则（`照れ` / `目影消` / `目影濃`）→ morph/材质索引绑定。
 */
import { describe, expect, it } from 'vitest'

import {
  CORE_EXPRESSIONS,
  createMorphLookup,
  findMaterialIndex,
  findMorphIndex,
  MATERIAL_MORPH_RULES,
  normalizeMorphName,
  resolveCoreExpression,
  resolveMaterialMorphBindings
} from '../src/renderer/src/model/morph-map'

/** 模型里的真实 morph 名样本（docs/model-morphs.md：85 个里的关键项）。 */
const REAL_MORPH_NAMES = [
  '怒り',
  '笑い',
  'まばたき',
  'ウィンク',
  '照れ',
  '目影消',
  '目影濃',
  '星目 ',
  'はぁと',
  'あ',
  'い',
  'う',
  'え',
  'お',
  'ん',
  '！',
  '111'
]

/** 模型里的真实材质名样本（39 个里的关键项）。 */
const REAL_MATERIAL_NAMES = ['颜', '颜赤', '口', '白目', '目', '眉睫', '髪', '目影', 'biaoq']

describe('normalizeMorphName：trim + NFC', () => {
  it('去除 `星目 ` 的尾随空格', () => {
    expect(normalizeMorphName('星目 ')).toBe('星目')
    expect(normalizeMorphName(' 星目 ')).toBe('星目')
  })

  it('去除首尾空白但保留内部空格', () => {
    expect(normalizeMorphName('  怒り\t')).toBe('怒り')
    expect(normalizeMorphName('口 角')).toBe('口 角')
  })

  it('NFC 归一化（组合字符 → 预组合字符）', () => {
    // 'か' + U+3099(combining dakuten) → 'が'
    expect(normalizeMorphName('か\u3099')).toBe('が')
    expect(normalizeMorphName('か\u3099')).toBe('が'.normalize('NFC'))
  })

  it('非字符串/空串安全返回空串', () => {
    expect(normalizeMorphName('')).toBe('')
    // 防御性：运行时可能收到异常类型（IPC/调试面调用）
    expect(normalizeMorphName(undefined as unknown as string)).toBe('')
  })
})

describe('findMorphIndex：按 trim 后名称匹配，未知名返回 null', () => {
  it('`星目 ` 尾随空格：用 `星目` 能命中索引', () => {
    expect(findMorphIndex(REAL_MORPH_NAMES, '星目')).toBe(7)
    expect(findMorphIndex(REAL_MORPH_NAMES, ' 星目 ')).toBe(7)
  })

  it('精确匹配常规 morph', () => {
    expect(findMorphIndex(REAL_MORPH_NAMES, '笑い')).toBe(1)
    expect(findMorphIndex(REAL_MORPH_NAMES, '照れ')).toBe(4)
    expect(findMorphIndex(REAL_MORPH_NAMES, '目影消')).toBe(5)
  })

  it('未知名 / 空名返回 null', () => {
    expect(findMorphIndex(REAL_MORPH_NAMES, '存在しない')).toBeNull()
    expect(findMorphIndex(REAL_MORPH_NAMES, '')).toBeNull()
    expect(findMorphIndex([], '笑い')).toBeNull()
  })

  it('不区分首尾空格但区分大小写/近似名（`笑い` ≠ `笑い2`）', () => {
    expect(findMorphIndex(['笑い2'], '笑い')).toBeNull()
  })
})

describe('resolveCoreExpression：核心表情候选解析', () => {
  it('眨眼：优先 `まばたき`，缺失时回退 `ウィンク`', () => {
    expect(resolveCoreExpression('blink', REAL_MORPH_NAMES)).toBe('まばたき')
    expect(resolveCoreExpression('blink', ['ウィンク'])).toBe('ウィンク')
  })

  it('好感：`星目 ` 返回**原始名称**（供 setMorph 直接用）', () => {
    expect(resolveCoreExpression('affection', REAL_MORPH_NAMES)).toBe('星目 ')
  })

  it('笑 / 害羞 / 口型候选存在', () => {
    expect(resolveCoreExpression('smile', REAL_MORPH_NAMES)).toBe('笑い')
    expect(resolveCoreExpression('blush', REAL_MORPH_NAMES)).toBe('照れ')
    expect(resolveCoreExpression('mouth', REAL_MORPH_NAMES)).toBe('あ')
  })

  it('未知名 / 无候选返回 null', () => {
    expect(resolveCoreExpression('unknown-expression', REAL_MORPH_NAMES)).toBeNull()
    expect(resolveCoreExpression('sad', REAL_MORPH_NAMES)).toBeNull()
    expect(resolveCoreExpression('', REAL_MORPH_NAMES)).toBeNull()
  })

  it('CORE_EXPRESSIONS 覆盖 PLAN §11 的 8 类核心表情', () => {
    expect(Object.keys(CORE_EXPRESSIONS).sort()).toEqual([
      'affection',
      'angry',
      'blink',
      'blush',
      'mouth',
      'sad',
      'smile',
      'surprise'
    ])
    for (const candidates of Object.values(CORE_EXPRESSIONS)) {
      expect(candidates.length).toBeGreaterThan(0)
    }
  })
})

describe('findMaterialIndex：材质名 trim 匹配', () => {
  it('`颜赤` / `目影` 命中', () => {
    expect(findMaterialIndex(REAL_MATERIAL_NAMES, '颜赤')).toBe(1)
    expect(findMaterialIndex(REAL_MATERIAL_NAMES, '目影')).toBe(7)
    expect(findMaterialIndex(REAL_MATERIAL_NAMES, ' 目影 ')).toBe(7)
  })

  it('未知名返回 null', () => {
    expect(findMaterialIndex(REAL_MATERIAL_NAMES, '腮红')).toBeNull()
    expect(findMaterialIndex([], '颜赤')).toBeNull()
  })
})

describe('resolveMaterialMorphBindings：3 条材质 morph 规则', () => {
  it('真实名称样本 → 3 条绑定，morph/材质索引正确', () => {
    const bindings = resolveMaterialMorphBindings(REAL_MORPH_NAMES, REAL_MATERIAL_NAMES)
    expect(bindings).toHaveLength(3)
    expect(bindings.map((binding) => binding.target)).toEqual(['blush', 'eyeShadow', 'eyeShadow'])
    expect(bindings[0]).toMatchObject({
      morphName: '照れ',
      materialName: '颜赤',
      target: 'blush',
      mode: 'add',
      morphIndex: 4,
      materialIndex: 1
    })
    expect(bindings[1]).toMatchObject({ morphName: '目影消', mode: 'multiply-hide', morphIndex: 5 })
    expect(bindings[2]).toMatchObject({ morphName: '目影濃', mode: 'add', morphIndex: 6 })
    expect(bindings[1].materialIndex).toBe(bindings[2].materialIndex)
  })

  it('规则表与 PLAN §18.2 的 3 条规则一致（顺序：照れ → 目影消 → 目影濃）', () => {
    expect(MATERIAL_MORPH_RULES.map((rule) => rule.morphName)).toEqual([
      '照れ',
      '目影消',
      '目影濃'
    ])
    expect(MATERIAL_MORPH_RULES.map((rule) => rule.target)).toEqual([
      'blush',
      'eyeShadow',
      'eyeShadow'
    ])
    expect(MATERIAL_MORPH_RULES.map((rule) => rule.mode)).toEqual([
      'add',
      'multiply-hide',
      'add'
    ])
  })

  it('目标材质缺失时对应规则被跳过（不抛异常）', () => {
    // 只有 `颜`：`照れ` 需要 `颜赤`、`目影` 材质也不存在 → 无绑定
    expect(resolveMaterialMorphBindings(REAL_MORPH_NAMES, ['颜', '口'])).toEqual([])
    // 只缺 `目影`：只剩照れ
    const onlyBlush = resolveMaterialMorphBindings(REAL_MORPH_NAMES, ['颜', '颜赤'])
    expect(onlyBlush).toHaveLength(1)
    expect(onlyBlush[0].morphName).toBe('照れ')
  })

  it('morph 缺失时对应规则被跳过', () => {
    const bindings = resolveMaterialMorphBindings(['照れ'], REAL_MATERIAL_NAMES)
    expect(bindings).toHaveLength(1)
    expect(bindings[0].morphIndex).toBe(0)
  })

  it('空输入安全返回空数组', () => {
    expect(resolveMaterialMorphBindings([], [])).toEqual([])
  })
})

describe('createMorphLookup：Object.keys 顺序 ≠ morph 索引的真实陷阱', () => {
  // 真实模型里 '111'/'1111'/'11+' 是整数样式键，JS 对象会排到最前（索引 77/78/79），
  // 而 Object.keys 的数组下标是 0/1/2 —— 直接拿数组下标当 morph 索引会让全部表情错位。
  const dictionary = {
    '111': 77,
    '1111': 78,
    '怒り': 0,
    '笑い': 13,
    '照れ': 68,
    '目影消': 66,
    '目影濃': 67,
    '星目 ': 73
  }

  it('names 保留字典键顺序（展示用），namesByIndex 按真实索引对齐', () => {
    const lookup = createMorphLookup(dictionary)
    expect(lookup.count).toBe(8)
    expect(lookup.names[0]).toBe('111') // JS 对象整数键优先
    expect(lookup.namesByIndex[0]).toBe('怒り')
    expect(lookup.namesByIndex[13]).toBe('笑い')
    expect(lookup.namesByIndex[68]).toBe('照れ')
    expect(lookup.namesByIndex[73]).toBe('星目 ')
    expect(lookup.namesByIndex[77]).toBe('111')
    expect(lookup.namesByIndex[1]).toBe('') // 空洞（真实模型 85 个连续索引，这里样本稀疏）
  })

  it('findMorphIndex(lookup.namesByIndex, name) 返回真实 morph 索引（不是数组下标）', () => {
    const lookup = createMorphLookup(dictionary)
    expect(findMorphIndex(lookup.namesByIndex, '怒り')).toBe(0)
    expect(findMorphIndex(lookup.namesByIndex, '照れ')).toBe(68)
    expect(findMorphIndex(lookup.namesByIndex, '星目')).toBe(73)
    expect(findMorphIndex(lookup.namesByIndex, '111')).toBe(77)
  })

  it('材质 morph 绑定用真实索引（照れ→68、目影消→66、目影濃→67）', () => {
    const lookup = createMorphLookup(dictionary)
    const bindings = resolveMaterialMorphBindings(lookup.namesByIndex, [
      '颜',
      '颜赤',
      '目影'
    ])
    expect(bindings.map((binding) => binding.morphIndex)).toEqual([68, 66, 67])
    expect(bindings.map((binding) => binding.materialIndex)).toEqual([1, 2, 2])
  })

  it('忽略非法索引（负数 / 非整数 / 非有限）', () => {
    const lookup = createMorphLookup({
      good: 2,
      negative: -1,
      float: 1.5,
      nan: Number.NaN
    } as Record<string, number>)
    expect(lookup.count).toBe(1)
    expect(lookup.namesByIndex[2]).toBe('good')
    expect(lookup.namesByIndex).toHaveLength(3)
  })

  it('空字典安全返回空查找表', () => {
    expect(createMorphLookup({})).toEqual({ names: [], namesByIndex: [], count: 0 })
  })
})
