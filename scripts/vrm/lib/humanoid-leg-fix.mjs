/**
 * Wave 1.5 资产修复：把 VRM humanoid 的腿骨映射到 **MMD 形变骨（*D / *先EX）**，
 * 并把腿根从 spine（腰）下重挂到 hips（センター）下，修复两个实测问题：
 *
 * 1. **蒙皮不跟随**：PMX→VRM 转换把 humanoid 腿映射到了控制骨（`左足`/`左ひざ`/`左足首`），
 *    而网格权重在形变骨（`左足D`/`左ひざD`/`左足首D`/`左足先EX`，裤腿/鞋穗等也挂在 D 链下）。
 *    → three-vrm/Unity 旋转 humanoid 腿骨时画面不动（walk 腿静止、sit/sleep 腿部动画丢失）。
 * 2. **spine 旋转泄漏到腿**：腿链实际父链经过 `腰(spine)`（`腰キャンセル左 → 下半身 → 腰 → グルーブ → センター`），
 *    不符合 VRM humanoid 规范（upperLeg 最近 humanoid 祖先必须是 hips），three-vrm 的
 *    normalized→raw 公式会把 spine 的 normalized 旋转叠到整条腿上（实测 sit/sleep 差 24–31°）。
 *    修法：把腿根（含裤腿等子骨）在保持世界 rest 变换不变的前提下重挂到 hips 的直系子节点（`グルーブ`）。
 *
 * 本文件是纯函数库（无 IO），CLI 见 `scripts/vrm/fix-vrm-humanoid-legs.mjs`；
 * 单测 `tests/vrm-humanoid-leg-fix.test.ts` 用合成 glTF 覆盖 remap/重挂数学/幂等性。
 *
 * 注意：只改 JSON chunk 的 nodes / humanoid 映射，**不动 BIN chunk**（几何/贴图/动画字节），
 * 且重挂后世界 rest 变换必须保持（报告里给出 delta），因此静止外观不变。
 */

/** @typedef {{ [key: string]: any }} GltfJson */

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

function qInv(q) {
  return [-q[0], -q[1], -q[2], q[3]]
}

function qRot(q, v) {
  const [x, y, z, w] = q
  const ix = w * v[0] + y * v[2] - z * v[1]
  const iy = w * v[1] + z * v[0] - x * v[2]
  const iz = w * v[2] + x * v[1] - y * v[0]
  const iw = -x * v[0] - y * v[1] - z * v[2]
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x
  ]
}

function qNorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** 构建 parent 索引数组（gltf scene 唯一根假设下，节点可被多个 parent 时取第一个）。 */
export function buildParents(nodes) {
  const parents = new Array(nodes.length).fill(-1)
  nodes.forEach((node, index) => {
    for (const child of node.children || []) {
      if (parents[child] === -1) parents[child] = index
    }
  })
  return parents
}

/** 计算节点 rest 世界变换（TRS 合成；不含 skin，仅 node 层级）。 */
export function restWorldOf(nodes, parents, index) {
  const chain = []
  let cursor = index
  while (cursor >= 0) {
    chain.unshift(cursor)
    cursor = parents[cursor]
  }
  let pos = [0, 0, 0]
  let rot = [0, 0, 0, 1]
  let scl = [1, 1, 1]
  for (const nodeIndex of chain) {
    const node = nodes[nodeIndex] || {}
    const t = node.translation || [0, 0, 0]
    const r = node.rotation || [0, 0, 0, 1]
    const s = node.scale || [1, 1, 1]
    const ts = t.map((value, axis) => value * scl[axis])
    const rt = qRot(rot, ts)
    pos = pos.map((value, axis) => value + rt[axis])
    rot = qNorm(qMul(rot, r))
    scl = scl.map((value, axis) => value * s[axis])
  }
  return { pos, rot, scl }
}

/** 名称 → 节点下标（重名取第一个；返回 -1 表示不存在）。 */
export function indexByName(nodes) {
  const map = new Map()
  nodes.forEach((node, index) => {
    if (typeof node.name === 'string' && !map.has(node.name)) map.set(node.name, index)
  })
  return map
}

const LEG_BONES = {
  left: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'],
  right: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']
}

/** 从当前 humanoid 映射中读腿骨节点名；缺 upper/lower/foot 返回 null。 */
export function readLegMapping(gltf) {
  const humanoid = gltf?.extensions?.VRMC_vrm?.humanoid
  if (!isRecord(humanoid) || !isRecord(humanoid.humanBones)) return null
  const nodes = gltf.nodes || []
  const byName = indexByName(nodes)
  const result = { left: {}, right: {} }
  for (const side of ['left', 'right']) {
    for (const bone of LEG_BONES[side]) {
      const entry = humanoid.humanBones[bone]
      const nodeIndex = isRecord(entry) ? entry.node : undefined
      const name = typeof nodeIndex === 'number' ? nodes[nodeIndex]?.name : undefined
      if (!name) {
        if (bone === 'leftToes' || bone === 'rightToes') continue // toes 可选
        return null
      }
      result[side][bone] = { node: nodeIndex, name }
    }
  }
  return { mapping: result, humanoid, nodes, byName }
}

/** 是否为已修复状态（腿骨映射节点名以 D 结尾 / 足先EX）。 */
export function isLegMappingDeform(result) {
  for (const side of ['left', 'right']) {
    const m = result?.mapping?.[side]
    if (!m) return false
    if (!/D$/.test(m[`${side}UpperLeg`]?.name || '')) return false
    if (!/D$/.test(m[`${side}LowerLeg`]?.name || '')) return false
    if (!/D$/.test(m[`${side}Foot`]?.name || '')) return false
  }
  return true
}

/**
 * 根据控制骨名推断形变骨名（MMD 约定）：
 *   左足 → 左足D；左ひざ → 左ひざD；左足首 → 左足首D；足先 → `左足先EX`（由足首前缀 + 先EX）。
 * @returns {{ deform: Record<string, string>, missing: string[] }}
 */
export function inferDeformLegNames(byName, sideMapping) {
  const deform = {}
  const missing = []
  for (const key of ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']) {
    if (!sideMapping[key]) continue
    const candidate = `${sideMapping[key]}D`
    if (byName.has(candidate)) deform[key] = candidate
    else missing.push(candidate)
  }
  // toes（可选）：控制足名去掉末字 + 先EX，例如 左足首 → 左足 + 先EX = 左足先EX
  for (const side of ['left', 'right']) {
    const foot = sideMapping[`${side}Foot`]
    if (typeof foot !== 'string') continue
    const prefix = foot.slice(0, -1) // 左足首 → 左足
    const candidate = `${prefix}先EX`
    if (byName.has(candidate)) deform[`${side}Toes`] = candidate
  }
  return { deform, missing }
}

/** 把 humanoid 腿骨重映射到形变骨；返回变更列表。 */
export function remapHumanoidLegs(gltf) {
  const state = readLegMapping(gltf)
  if (!state) throw new Error('缺少 VRMC_vrm.humanoid 腿骨映射（不是 VRM1 或缺少 upper/lower/foot）')
  if (isLegMappingDeform(state)) return { changes: [], alreadyFixed: true }

  const { humanoid, byName } = state
  const changes = []
  for (const side of ['left', 'right']) {
    const sideMapping = {}
    for (const bone of LEG_BONES[side]) {
      if (state.mapping[side][bone]) sideMapping[bone] = state.mapping[side][bone].name
    }
    const inferred = inferDeformLegNames(byName, sideMapping)
    if (inferred.missing.length > 0) {
      throw new Error(`找不到形变骨：${inferred.missing.join(', ')}（该 VRM 可能不是 MMD D 骨约定，需人工指定）`)
    }
    for (const [bone, nodeName] of Object.entries(inferred.deform)) {
      if (!LEG_BONES[side].includes(bone)) continue
      const nodeIndex = byName.get(nodeName)
      const before = humanoid.humanBones[bone]?.node
      humanoid.humanBones[bone] = { ...(humanoid.humanBones[bone] || {}), node: nodeIndex }
      changes.push({ bone, fromNode: before, fromName: state.mapping[side][bone]?.name, toNode: nodeIndex, toName: nodeName })
    }
  }
  return { changes, alreadyFixed: false }
}

/** 腿根沿祖先链向上爬到 hips 的直系子节点（例如 グルーブ）。 */
export function findHipsChildForLegs(nodes, parents, hipsNode, legNode) {
  let cursor = legNode
  while (cursor >= 0) {
    const parent = parents[cursor]
    if (parent === hipsNode) return cursor
    if (parent < 0) return -1
    cursor = parent
  }
  return -1
}

/** 重挂腿根：把 legRoot 的父节点在保持世界 rest 变换不变的前提挂到 hips 的直系子节点下。 */
export function reparentLegRootUnderHips(gltf, options = {}) {
  const nodes = gltf.nodes || []
  const parents = buildParents(nodes)
  const byName = indexByName(nodes)
  const state = readLegMapping(gltf)
  if (!state) throw new Error('缺少 VRMC_vrm.humanoid 腿骨映射')
  const hipsNode = gltf?.extensions?.VRMC_vrm?.humanoid?.humanBones?.hips?.node
  if (typeof hipsNode !== 'number') throw new Error('缺少 humanoid.hips 映射')
  if (typeof nodes[hipsNode]?.name !== 'string') throw new Error('hips 节点无 name，无法定位腿根')

  // 用形变腿骨（已 remap 后）作为腿根探测；若还没 remap，先用控制骨。
  const probingBone = 'leftUpperLeg'
  const legNode = gltf.extensions.VRMC_vrm.humanoid.humanBones[probingBone]?.node
  if (typeof legNode !== 'number') throw new Error('缺少 leftUpperLeg 映射')
  const hipsChild = findHipsChildForLegs(nodes, parents, hipsNode, legNode)
  if (hipsChild < 0) throw new Error('无法在 leftUpperLeg 祖先链上找到 hips 的直系子节点')

  const result = { changes: [], skipped: [] }
  const seen = new Set()
  for (const side of ['left', 'right']) {
    const bone = `${side}UpperLeg`
    const nodeIndex = gltf.extensions.VRMC_vrm.humanoid.humanBones[bone]?.node
    if (typeof nodeIndex !== 'number') continue
    const legRootParent = parents[nodeIndex]
    if (legRootParent < 0) continue
    if (parents[legRootParent] === hipsChild) {
      result.skipped.push({ bone, reason: '腿根已（经父节点）挂在 hips 的直系子节点下' })
      continue
    }
    // 已经是最新判断的话可能左右共用同一个父节点（如 腰キャンセル 是分开的左右）；seen 防重复
    if (seen.has(legRootParent)) {
      result.skipped.push({ bone, reason: '腿根父节点已被处理' })
      continue
    }
    seen.add(legRootParent)

    const nodeBefore = restWorldOf(nodes, parents, legRootParent)
    const newParentWorld = restWorldOf(nodes, parents, hipsChild)
    const invParentRot = qInv(newParentWorld.rot)
    const delta = [
      nodeBefore.pos[0] - newParentWorld.pos[0],
      nodeBefore.pos[1] - newParentWorld.pos[1],
      nodeBefore.pos[2] - newParentWorld.pos[2]
    ]
    const localPos = qRot(invParentRot, delta).map((value, axis) => value / newParentWorld.scl[axis])
    const localRot = qNorm(qMul(invParentRot, nodeBefore.rot))
    const node = nodes[legRootParent]
    const oldParent = parents[legRootParent]
    node.translation = localPos.map((value) => Number(value.toFixed(6)))
    node.rotation = localRot.map((value) => Number(value.toFixed(9)))
    nodes[oldParent].children = (nodes[oldParent].children || []).filter((child) => child !== legRootParent)
    nodes[hipsChild].children = [...(nodes[hipsChild].children || []), legRootParent]
    parents[legRootParent] = hipsChild

    const nodeAfter = restWorldOf(nodes, parents, legRootParent)
    const restWorldDelta = Math.hypot(...nodeAfter.pos.map((value, axis) => value - nodeBefore.pos[axis]))
    result.changes.push({
      bone,
      node: legRootParent,
      nodeName: node.name,
      fromParent: oldParent,
      fromParentName: nodes[oldParent]?.name,
      toParent: hipsChild,
      toParentName: nodes[hipsChild]?.name,
      restWorldDelta
    })
  }
  // 校验：最近 humanoid 祖先必须是 hips
  for (const side of ['left', 'right']) {
    const nodeIndex = gltf.extensions.VRMC_vrm.humanoid.humanBones[`${side}UpperLeg`]?.node
    let cursor = parents[nodeIndex]
    while (cursor >= 0 && cursor !== hipsNode) {
      if (isHumanoidBoneNode(gltf, cursor)) {
        throw new Error(`重挂后 ${side}UpperLeg 的最近 humanoid 祖先仍是 ${nodes[cursor]?.name}（应为 hips）`)
      }
      cursor = parents[cursor]
    }
    if (cursor !== hipsNode) throw new Error('重挂后腿链未连到 hips')
  }
  return result
}

function isHumanoidBoneNode(gltf, nodeIndex) {
  const humanBones = gltf?.extensions?.VRMC_vrm?.humanoid?.humanBones
  if (!isRecord(humanBones)) return false
  return Object.values(humanBones).some((entry) => isRecord(entry) && entry.node === nodeIndex)
}

/** 组合修复：先 remap（先让腿骨指向形变骨），再重挂腿根到 hips 下。 */
export function fixHumanoidLegs(gltf, options = {}) {
  const remap = remapHumanoidLegs(gltf)
  const reparent =
    options.reparent === false ? { changes: [], skipped: [{ reason: '跳过（--no-reparent）' }] } : reparentLegRootUnderHips(gltf)
  return { remap, reparent }
}
