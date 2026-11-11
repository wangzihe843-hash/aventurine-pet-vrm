/**
 * Wave 1.5 资产修复单测：`scripts/vrm/lib/humanoid-leg-fix.mjs`
 *
 * 背景（对拍实测）：PMX→VRM 转换把 humanoid 腿骨映射到控制骨（左足/左ひざ/左足首），
 * 但蒙皮权重在 MMD 形变骨（左足D/左ひざD/左足首D/左足先EX）→ 播放动画时腿不动；
 * 且腿链父链经过 spine（腰），VRM 规范要求 upperLeg 最近 humanoid 祖先为 hips。
 *
 * 本测试用合成 glTF（无私有资产）验证：腿骨 remap、腿根重挂保持世界 rest、幂等、缺骨报错。
 * lib 是纯 ESM（无 .d.ts，tests 不参与 tsc）。
 */
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- scripts/vrm/lib/*.mjs 纯 ESM 无 .d.ts
import {
  buildParents,
  fixHumanoidLegs,
  isLegMappingDeform,
  readLegMapping,
  remapHumanoidLegs,
  restWorldOf
} from '../scripts/vrm/lib/humanoid-leg-fix.mjs'

interface NodeLike {
  name?: string
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  children?: number[]
}

interface HumanBoneLike {
  node: number
}

/** 构造一个「3 节躯干 + 左右腿控制链 + 左右腿 D 形变链」的合成 glTF（VRM1 humanoid 形状）。 */
function makeGltf(): any {
  let cursor = 0
  const next = () => cursor++
  const node = (name: string, translation: number[]): number => {
    const index = next()
    nodes[index] = { name, translation }
    return index
  }
  const nodes: NodeLike[] = []
  const attach = (parent: number, child: number): void => {
    const entry = nodes[parent]
    entry.children = [...(entry.children || []), child]
  }

  const root = node('Root', [0, 0, 0])
  const center = node('センター', [0, 0.98, 0])
  const groove = node('グルーブ', [0, 0.05, 0])
  const waist = node('腰', [0, 0.05, 0])
  const lowerBody = node('下半身', [0, 0.02, 0])
  attach(root, center)
  attach(center, groove)
  attach(groove, waist)
  attach(waist, lowerBody)

  const humanBones: Record<string, HumanBoneLike> = { hips: { node: center }, spine: { node: waist } }
  for (const side of ['left', 'right']) {
    const prefix = side === 'left' ? '左' : '右'
    const cancel = node(`${prefix}腰キャンセル`, [side === 'left' ? 0.1 : -0.1, 0.98, 0])
    attach(lowerBody, cancel)
    // 控制链（当前 humanoid 误映射到的骨）
    const upper = node(`${prefix}足`, [0, 0, 0])
    const lower = node(`${prefix}ひざ`, [0, -0.44, 0])
    const foot = node(`${prefix}足首`, [0, -0.44, 0])
    attach(cancel, upper)
    attach(upper, lower)
    attach(lower, foot)
    // 形变链（蒙皮真正驱动的骨；与控制链并列挂在 cancel 下）
    const deformUpper = node(`${prefix}足D`, [0, 0, 0])
    const deformLower = node(`${prefix}ひざD`, [0, -0.44, 0])
    const deformFoot = node(`${prefix}足首D`, [0, -0.44, 0])
    const deformToes = node(`${prefix}足先EX`, [0, -0.08, 0.1])
    attach(cancel, deformUpper)
    attach(deformUpper, deformLower)
    attach(deformLower, deformFoot)
    attach(deformFoot, deformToes)

    humanBones[`${side}UpperLeg`] = { node: upper }
    humanBones[`${side}LowerLeg`] = { node: lower }
    humanBones[`${side}Foot`] = { node: foot }
  }

  return {
    nodes,
    extensions: { VRMC_vrm: { humanoid: { humanBones } } }
  }
}

function legWorld(gltf: any, nodeName: string): { pos: number[] } {
  const nodes = gltf.nodes
  const parents = buildParents(nodes)
  const index = nodes.findIndex((entry: NodeLike) => entry.name === nodeName)
  expect(index).toBeGreaterThanOrEqual(0)
  return restWorldOf(nodes, parents, index)
}

describe('humanoid-leg-fix：腿骨映射到 MMD 形变骨', () => {
  it('remap 后 humanoid 腿骨指向 *D / 足先EX，并新增 toes', () => {
    const gltf = makeGltf()
    expect(isLegMappingDeform(readLegMapping(gltf))).toBe(false)

    const result = remapHumanoidLegs(gltf)
    expect(result.alreadyFixed).toBe(false)
    expect(result.changes.length).toBe(8) // 左右 × (upper/lower/foot/toes)

    const bones = gltf.extensions.VRMC_vrm.humanoid.humanBones
    const nameOf = (bone: string) => gltf.nodes[bones[bone].node].name
    expect(nameOf('leftUpperLeg')).toBe('左足D')
    expect(nameOf('leftLowerLeg')).toBe('左ひざD')
    expect(nameOf('leftFoot')).toBe('左足首D')
    expect(nameOf('leftToes')).toBe('左足先EX')
    expect(nameOf('rightUpperLeg')).toBe('右足D')
    expect(nameOf('rightToes')).toBe('右足先EX')
    expect(isLegMappingDeform(readLegMapping(gltf))).toBe(true)
  })

  it('缺形变骨时报错（非 MMD D 骨约定需人工处理，不能静默）', () => {
    const gltf = makeGltf()
    gltf.nodes = gltf.nodes.filter((entry: NodeLike) => !/足D$/.test(entry.name || ''))
    expect(() => remapHumanoidLegs(gltf)).toThrow(/找不到形变骨/)
  })
})

describe('humanoid-leg-fix：腿根重挂到 hips 下', () => {
  it('腿根从 spine 下重挂到 hips 直系子节点，且世界 rest 不变', () => {
    const gltf = makeGltf()
    // 修复前：控制链最近 humanoid 祖先链经过 spine（腰）
    const beforeParents = buildParents(gltf.nodes)
    const waistIndex = gltf.nodes.findIndex((entry: NodeLike) => entry.name === '腰')
    const cancelIndex = gltf.nodes.findIndex((entry: NodeLike) => entry.name === '左腰キャンセル')
    let ancestor = cancelIndex
    const ancestors: string[] = []
    while (ancestor >= 0) {
      ancestors.push(gltf.nodes[ancestor].name)
      ancestor = beforeParents[ancestor]
    }
    expect(ancestors).toContain('腰')

    const before = legWorld(gltf, '左腰キャンセル')

    const result = fixHumanoidLegs(gltf)
    expect(result.reparent.changes.length).toBe(2) // 左右腿根

    const parents = buildParents(gltf.nodes)
    const grooveIndex = gltf.nodes.findIndex((entry: NodeLike) => entry.name === 'グルーブ')
    expect(parents[cancelIndex]).toBe(grooveIndex)
    // spine 不再是腿根祖先
    let cursor = cancelIndex
    const names: string[] = []
    while (cursor >= 0) {
      names.push(gltf.nodes[cursor].name)
      cursor = parents[cursor]
    }
    expect(names).not.toContain('腰')

    const after = legWorld(gltf, '左腰キャンセル')
    const delta = Math.hypot(...after.pos.map((value: number, axis: number) => value - before.pos[axis]))
    expect(delta).toBeLessThan(1e-3)
  })

  it('幂等：对已修复资产再跑一次无变化', () => {
    const gltf = makeGltf()
    fixHumanoidLegs(gltf)
    const second = fixHumanoidLegs(gltf)
    expect(second.remap.changes.length).toBe(0)
    expect(second.remap.alreadyFixed).toBe(true)
    expect(second.reparent.changes.length).toBe(0)
  })
})
