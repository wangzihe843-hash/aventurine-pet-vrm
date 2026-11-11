/**
 * HSR 次级骨（头发 / 衣摆 / 裙摆 / 腰带 / 裤腿 …）→ VRM raw 骨（MMD 非 humanoid 节点）的链映射。
 *
 * 目标模型（戏浪 VRM，Wave 1.5 legfix 版）里 humanoid 只有 54 根（含手指/脚趾）；
 * 真正的头发、外衣、腰带、裤腿、内衬等是 **raw 节点**（331 根），three-vrm 不会驱动它们。
 * HSR 官方动画对每根次级骨都有完整曲线（1820 曲线/take），本模块把这些曲线按「链」搬到
 * VRM 的对应链上：
 *
 * 1. 分别构建 VRM 次级链（根→子→孙）与 HSR 次级链（Hair / Coat / skirt / Ribbon / Collar 前缀）；
 * 2. 每条 VRM 链按**锚点归一化位置 + 链方向**匹配最近的 HSR 链（锚点：头发→head、
 *    裤腿→腿根、袖带→小臂、其余→upperChest）；
 * 3. 链内按顺序一对一映射（VRM 链比 HSR 长时，尾部重复映射到 HSR 末端骨）。
 *
 * 链匹配是启发式（HSR 35 根 hair vs VRM 63 个 hair 节点、HSR 39 根 cloth vs VRM 168 个
 * cloth 节点），视觉 QA 见 docs/vrm-motion-hsr.md；允许通过 overrides 强制指定。
 */
import { restDirectionOf } from './vrm-rest.mjs'
import { normalize3, qRotateVec } from './quat.mjs'

/** VRM 头发类节点名关键词。 */
export const VRM_HAIR_KEYWORDS = Object.freeze(['髪', '劉海', '碎髮', '辮', '頂髪'])
/** VRM 衣服/腰饰类节点名关键词。 */
export const VRM_CLOTH_KEYWORDS = Object.freeze(['外衣', '腰帶', '腰穗', '內襯', '褲腿', '項鏈', '翎'])
/** VRM 明确跳过（控制骨/形变骨/IK/手套/脸骨等；脚趾已是 humanoid）。 */
export const VRM_SKIP_KEYWORDS = Object.freeze([
  '足ＩＫ',
  'つま先ＩＫ',
  '足IK親',
  '操作中心',
  '全ての親',
  'グルーブ',
  'Root',
  '下半身',
  '腰キャンセル',
  '上半身1',
  'つま先',
  '足先EX',
  '足D',
  'ひざD',
  '足首D',
  '腕捩',
  '手捩',
  'ダミー',
  '目先',
  '両目',
  'tongue',
  'Teeth',
  '喉結',
  '太陽鏡',
  '後領',
  '右領',
  '左領',
  '右手先',
  '左手先',
  '右手環',
  '左手環',
  '右肩P',
  '左肩P',
  '右肩C',
  '左肩C',
  '右上髪一',
  '項鏈中',
  '項鏈下'
])
const VRM_SKIP_EXACT = new Set(['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'])

/** HSR 次级骨类别（按名字前缀）。 */
export function isHsrHairBone(name) {
  return /^Hair/.test(name) || /^Eardrop/.test(name)
}
export function isHsrClothBone(name) {
  return /^(Coat|skirt|Ribbon|Collar)/.test(name)
}

/**
 * 分类一个 VRM raw 节点（非 humanoid）。
 * @param {string} name
 * @returns {'hair'|'cloth'|'skip'}
 */
export function classifyVrmSecondaryNode(name) {
  if (VRM_SKIP_EXACT.has(name)) return 'skip'
  if (VRM_SKIP_KEYWORDS.some((keyword) => name.includes(keyword))) return 'skip'
  if (VRM_HAIR_KEYWORDS.some((keyword) => name.includes(keyword))) return 'hair'
  if (VRM_CLOTH_KEYWORDS.some((keyword) => name.includes(keyword))) return 'cloth'
  return 'skip'
}

/**
 * 从任意节点集合构建链（单链：父不在集合内 → 根；沿唯一子节点向下）。
 * @param {number[]} indices
 * @param {number[]} parents
 * @param {number[][]} children
 * @returns {number[][]}
 */
export function buildChains(indices, parents, children) {
  const inSet = new Set(indices)
  const roots = indices.filter((index) => !inSet.has(parents[index]))
  /** @type {number[][]} */
  const chains = []
  for (const root of roots) {
    const chain = [root]
    let cursor = root
    for (;;) {
      const kids = children[cursor].filter((child) => inSet.has(child))
      if (kids.length !== 1) break
      cursor = kids[0]
      chain.push(cursor)
    }
    chains.push(chain)
  }
  return chains
}

/**
 * 从 HSR 骨架构建链（只用名字集合内的骨）。
 * @param {Record<string, {parent: string|null}>} hsrRest
 * @param {Record<string, string[]>} hsrChildren
 * @param {(name: string) => boolean} predicate
 */
export function buildHsrChains(hsrRest, hsrChildren, predicate) {
  const names = Object.keys(hsrRest).filter(predicate)
  const inSet = new Set(names)
  const roots = names.filter((name) => !hsrRest[name].parent || !inSet.has(hsrRest[name].parent))
  /** @type {string[][]} */
  const chains = []
  for (const root of roots) {
    const chain = [root]
    let cursor = root
    for (;;) {
      const kids = (hsrChildren[cursor] ?? []).filter((child) => inSet.has(child))
      if (kids.length !== 1) break
      cursor = kids[0]
      chain.push(cursor)
    }
    chains.push(chain)
  }
  return chains
}

/** 锚点：HSR 骨 ↔ VRM humanoid 骨。 */
export const ANCHOR_PAIRS = Object.freeze({
  head: ['Head_M', 'head'],
  torso: ['Chest_M', 'upperChest'],
  hips: ['Root_M', 'hips'],
  legL: ['Hip_L', 'leftUpperLeg'],
  legR: ['Hip_R', 'rightUpperLeg'],
  armL: ['Elbow_L', 'leftLowerArm'],
  armR: ['Elbow_R', 'rightLowerArm']
})

function anchorForClothName(name) {
  if (name.includes('褲腿')) return name.startsWith('左') ? 'legL' : 'legR'
  return 'torso'
}

/**
 * 把 VRM 世界坐标点转到 HSR armature 坐标系。
 * @param {number[]} pVrm
 * @param {string} anchorKey
 * @param {Record<string, any>} hsrRest
 * @param {ReturnType<import('./vrm-rest.mjs').buildVrmRest>} vrmRest
 * @param {ReturnType<import('./vrm-rest.mjs').buildAlignment>} alignment
 */
export function vrmPointToHsr(pVrm, anchorKey, hsrRest, vrmRest, alignment) {
  const [hsrAnchor, vrmAnchor] = ANCHOR_PAIRS[anchorKey]
  const hsrBase = hsrRest[hsrAnchor].head
  const vrmBase = vrmRest.humanoid[vrmAnchor].position
  const local = [pVrm[0] - vrmBase[0], pVrm[1] - vrmBase[1], pVrm[2] - vrmBase[2]]
  const rotated = qRotateVec(alignment.inverseQuat, local)
  return [rotated[0] + hsrBase[0], rotated[1] + hsrBase[1], rotated[2] + hsrBase[2]]
}

/**
 * 主映射：VRM 次级链 → HSR 次级链。
 *
 * @param {{
 *   hsrRest: Record<string, { head: number[], parent: string|null }>,
 *   hsrChildren: Record<string, string[]>,
 *   vrmRest: any,
 *   alignment: any,
 *   overrides?: Record<string, string>  // VRM 节点名 → HSR 骨名（强制）
 * }} args
 */
export function mapSecondaryChains({ hsrRest, hsrChildren, vrmRest, alignment, overrides = {} }) {
  const hsrHairChains = buildHsrChains(hsrRest, hsrChildren, isHsrHairBone)
  const hsrClothChains = buildHsrChains(hsrRest, hsrChildren, isHsrClothBone)
  const hsrNameToChainIndex = new Map()
  for (const chains of [hsrHairChains, hsrClothChains]) {
    chains.forEach((chain, index) => chain.forEach((name) => hsrNameToChainIndex.set(name, index)))
  }

  /** @type {Map<number, string>} */
  const nodeToBone = new Map()
  /** @type {Array<{ category: string, vrmRoot: string, vrmNames: string[], hsrChain: string[], distanceMeters: number, angleDeg: number }>} */
  const chainReports = []
  /** @type {string[]} */
  const warnings = []

  for (const category of ['hair', 'cloth']) {
    const vrmIndices = []
    for (let index = 0; index < vrmRest.nodes.length; index += 1) {
      const name = vrmRest.nodes[index]?.name
      if (typeof name !== 'string') continue
      if (vrmRest.humanoidNameByNode.has(index)) continue
      if (classifyVrmSecondaryNode(name) !== category) continue
      vrmIndices.push(index)
    }
    const chains = buildChains(vrmIndices, vrmRest.parents, vrmRest.children)
    const candidates = category === 'hair' ? hsrHairChains : hsrClothChains
    if (candidates.length === 0) {
      warnings.push(`HSR 没有 ${category} 候选链，跳过 ${chains.length} 条 VRM 链`)
      continue
    }
    for (const chain of chains) {
      const rootIndex = chain[0]
      const rootName = vrmRest.nodes[rootIndex].name
      const anchorKey = category === 'hair' ? 'head' : anchorForClothName(rootName)
      const rootHsr = vrmPointToHsr(vrmRest.worldPos[rootIndex], anchorKey, hsrRest, vrmRest, alignment)
      const vrmDir = restDirectionOf(vrmRest, rootIndex)
      const vrmDirHsr = qRotateVec(alignment.inverseQuat, vrmDir)

      let best = null
      for (const hsrChain of candidates) {
        const hsrRoot = hsrRest[hsrChain[0]].head
        const distance = Math.hypot(
          hsrRoot[0] - rootHsr[0],
          hsrRoot[1] - rootHsr[1],
          hsrRoot[2] - rootHsr[2]
        )
        let angleDeg = 0
        if (hsrChain.length > 1) {
          const next = hsrRest[hsrChain[1]].head
          const hsrDir = normalize3([next[0] - hsrRoot[0], next[1] - hsrRoot[1], next[2] - hsrRoot[2]])
          const dot = Math.max(-1, Math.min(1, hsrDir[0] * vrmDirHsr[0] + hsrDir[1] * vrmDirHsr[1] + hsrDir[2] * vrmDirHsr[2]))
          angleDeg = (Math.acos(dot) * 180) / Math.PI
        }
        const score = distance + (angleDeg / 180) * 0.03
        if (!best || score < best.score) best = { chain: hsrChain, score, distance, angleDeg }
      }
      if (!best) continue
      const vrmNames = chain.map((index) => vrmRest.nodes[index].name)
      chainReports.push({
        category,
        vrmRoot: rootName,
        vrmNames,
        hsrChain: best.chain,
        distanceMeters: Number(best.distance.toFixed(4)),
        angleDeg: Number(best.angleDeg.toFixed(1))
      })
      for (let index = 0; index < chain.length; index += 1) {
        const hsrBone = best.chain[Math.min(index, best.chain.length - 1)]
        nodeToBone.set(chain[index], hsrBone)
      }
    }
  }

  // 显式 overrides（VRM 节点名 → HSR 骨名）优先
  for (const [vrmName, hsrBone] of Object.entries(overrides ?? {})) {
    if (!hsrRest[hsrBone]) {
      warnings.push(`override ${vrmName} → ${hsrBone}：HSR 骨不存在，已忽略`)
      continue
    }
    const indices = vrmRest.nameToNodes.get(vrmName) ?? []
    if (indices.length === 0) {
      warnings.push(`override ${vrmName}：VRM 节点不存在，已忽略`)
      continue
    }
    nodeToBone.set(indices[0], hsrBone)
  }

  const counts = { hairNodes: 0, clothNodes: 0 }
  for (const [index] of nodeToBone) {
    const name = vrmRest.nodes[index]?.name ?? ''
    if (classifyVrmSecondaryNode(name) === 'hair') counts.hairNodes += 1
    else counts.clothNodes += 1
  }

  return { nodeToBone, chainReports, counts, warnings, hsrChainCounts: { hair: hsrHairChains.length, cloth: hsrClothChains.length } }
}
