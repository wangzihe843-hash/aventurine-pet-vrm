/**
 * V3 次级骨链映射单测：VRM 头发/衣摆 raw 链 ↔ HSR Hair / Coat 链。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- 纯 ESM 无声明
import { buildVrmRest, buildAlignment } from '../scripts/vrm/motion/lib/vrm-rest.mjs'
// @ts-expect-error -- 同上
import {
  classifyVrmSecondaryNode,
  buildChains,
  buildHsrChains,
  isHsrHairBone,
  isHsrClothBone,
  mapSecondaryChains
} from '../scripts/vrm/motion/lib/secondary-map.mjs'
import { makeSyntheticVrm, makeSyntheticHsrSamples } from './fixtures/vrm-motion/fixtures'

describe('classifyVrmSecondaryNode', () => {
  it('头发/衣服/跳过分类', () => {
    expect(classifyVrmSecondaryNode('後髪1-1')).toBe('hair')
    expect(classifyVrmSecondaryNode('中劉海1-2')).toBe('hair')
    expect(classifyVrmSecondaryNode('辮子1-1')).toBe('hair')
    expect(classifyVrmSecondaryNode('外衣_0_2')).toBe('cloth')
    expect(classifyVrmSecondaryNode('右褲腿1')).toBe('cloth')
    expect(classifyVrmSecondaryNode('後腰帶3')).toBe('cloth')
    expect(classifyVrmSecondaryNode('左足D')).toBe('skip')
    expect(classifyVrmSecondaryNode('右足先EX')).toBe('skip')
    expect(classifyVrmSecondaryNode('左腕捩')).toBe('skip')
    expect(classifyVrmSecondaryNode('左肩P')).toBe('skip')
    expect(classifyVrmSecondaryNode('左袖帶1-1')).toBe('skip')
    expect(classifyVrmSecondaryNode('センター')).toBe('skip')
  })

  it('HSR 类别前缀', () => {
    expect(isHsrHairBone('HairFL_00_JNT')).toBe(true)
    expect(isHsrHairBone('EardropL_00_JNT')).toBe(true)
    expect(isHsrClothBone('CoatL_a_00_JNT')).toBe(true)
    expect(isHsrClothBone('skirtA_03_JNT')).toBe(true)
    expect(isHsrClothBone('RibbonL_a_00_JNT')).toBe(true)
    expect(isHsrClothBone('Hip_L')).toBe(false)
  })
})

describe('buildChains', () => {
  it('按父链切片构建链', () => {
    const parents = [-1, 0, 1, 2, -1]
    const children = [[1], [2], [3], [], []]
    const chains = buildChains([0, 1, 2, 3, 4], parents, children)
    expect(chains).toHaveLength(2)
    expect(chains[0]).toEqual([0, 1, 2, 3])
    expect(chains[1]).toEqual([4])
  })
})

describe('buildHsrChains', () => {
  it('从 HSR rest 构建头发链', () => {
    const samples = makeSyntheticHsrSamples()
    const chains = buildHsrChains(samples.rest, samples.children, isHsrHairBone)
    expect(chains).toHaveLength(1)
    expect(chains[0]).toEqual(['HairFL_00_JNT', 'HairFL_01_JNT'])
  })
})

describe('mapSecondaryChains', () => {
  it('头发/衣摆链按锚点位置与方向匹配', () => {
    const vrm = makeSyntheticVrm()
    const rest = buildVrmRest(vrm)
    const samples = makeSyntheticHsrSamples()
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    const mapping = mapSecondaryChains({
      hsrRest: samples.rest,
      hsrChildren: samples.children,
      vrmRest: rest,
      alignment
    })
    const byName = new Map(mapping.chainReports.flatMap((chain) => chain.vrmNames.map((name) => [name, chain])))
    expect(byName.get('後髪1-1')?.hsrChain).toEqual(['HairFL_00_JNT', 'HairFL_01_JNT'])
    expect(byName.get('外衣_0_2')?.hsrChain).toEqual(['CoatL_a_00_JNT', 'CoatL_a_01_JNT'])
    // 节点 → HSR 骨
    const nodeIndexByName = new Map(rest.nodes.map((node: { name: string }, index: number) => [node.name, index]))
    const hairIndex = nodeIndexByName.get('後髪1-2')
    expect(mapping.nodeToBone.get(hairIndex)).toBe('HairFL_01_JNT')
    expect(mapping.counts.hairNodes).toBe(2)
    expect(mapping.counts.clothNodes).toBe(2)
    expect(mapping.warnings).toEqual([])
  })

  it('overrides 优先于自动匹配', () => {
    const vrm = makeSyntheticVrm()
    const rest = buildVrmRest(vrm)
    const samples = makeSyntheticHsrSamples()
    const alignment = buildAlignment({ hsrRest: samples.rest, vrmRest: rest })
    const mapping = mapSecondaryChains({
      hsrRest: samples.rest,
      hsrChildren: samples.children,
      vrmRest: rest,
      alignment,
      overrides: { '後髪1-1': 'CoatL_a_00_JNT' }
    })
    const nodeIndexByName = new Map(rest.nodes.map((node: { name: string }, index: number) => [node.name, index]))
    expect(mapping.nodeToBone.get(nodeIndexByName.get('後髪1-1'))).toBe('CoatL_a_00_JNT')
  })
})
