/**
 * VRM (glTF GLB) rest 骨架解析：节点层级 / world rest 位置与朝向 / humanoid 映射 /
 * raw 父链上的「最近 humanoid 祖先」。
 *
 * 背景（Wave 1.5 实测，见 docs/wave15-report.md §5.3）：
 * - PMX→VRM 的戏浪模型 raw 骨层级 ≠ VRM humanoid 层级（腿曾挂在 腰(spine) 下），
 *   three-vrm 的 normalized→raw 会把 spine 旋转泄漏到腿上；Wave 1.5 已产出 legfix VRM
 *   （humanoid 腿骨→MMD 形变骨 + 腿根重挂 hips，`scripts/vrm/fix-vrm-humanoid-legs.mjs`）。
 * - 本模块不假设层级形状：对每根 humanoid 骨，沿 raw parent 链找**最近的 humanoid 祖先**，
 *   作为归一化旋转的父级（`effectiveParent`）。修复前后的 VRM 都适用。
 *
 * 纯函数 + 只读文件（GLB 解析）；无第三方依赖。
 */
import { readFileSync } from 'node:fs'
import {
  quatFromMat3,
  qInvert,
  mat3FromColumns,
  mat3Mul,
  normalize3
} from './quat.mjs'

const GLB_MAGIC = 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a

/**
 * 读取 GLB 的 JSON chunk（不解析 BIN）。
 * @param {string} glbPath
 * @returns {{json: any, binByteLength: number}}
 */
export function parseGlbJson(glbPath) {
  const data = readFileSync(glbPath)
  if (data.toString('utf8', 0, 4) !== GLB_MAGIC) throw new Error(`不是 GLB：${glbPath}`)
  const version = data.readUInt32LE(4)
  if (version !== 2) throw new Error(`不支持的 glTF 版本：${version}`)
  const totalLength = data.readUInt32LE(8)
  let offset = 12
  let json = null
  let binByteLength = 0
  while (offset + 8 <= Math.min(totalLength, data.length)) {
    const chunkLength = data.readUInt32LE(offset)
    const chunkType = data.readUInt32LE(offset + 4)
    const start = offset + 8
    if (chunkType === GLB_CHUNK_JSON) {
      json = JSON.parse(data.toString('utf8', start, start + chunkLength))
    } else {
      binByteLength += chunkLength
    }
    offset = start + chunkLength
  }
  if (!json) throw new Error(`GLB 缺少 JSON chunk：${glbPath}`)
  return { json, binByteLength }
}

/** glTF node 的 TRS（支持 matrix，列主序 16 元数组）。 */
export function nodeLocalTrs(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
    const m = node.matrix
    const t = [m[12], m[13], m[14]]
    const sx = Math.hypot(m[0], m[1], m[2]) || 1
    const sy = Math.hypot(m[4], m[5], m[6]) || 1
    const sz = Math.hypot(m[8], m[9], m[10]) || 1
    const r = quatFromMat3([
      [m[0] / sx, m[4] / sy, m[8] / sz],
      [m[1] / sx, m[5] / sy, m[9] / sz],
      [m[2] / sx, m[6] / sy, m[10] / sz]
    ])
    return { translation: t, rotation: r, scale: [sx, sy, sz] }
  }
  return {
    translation: Array.isArray(node.translation) ? node.translation.slice() : [0, 0, 0],
    rotation: Array.isArray(node.rotation) ? node.rotation.slice() : [0, 0, 0, 1],
    scale: Array.isArray(node.scale) ? node.scale.slice() : [1, 1, 1]
  }
}

function qRotVec(q, v) {
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

function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

function qNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/**
 * 构建 VRM rest 骨架模型。
 * @param {any} gltf
 */
export function buildVrmRest(gltf) {
  const nodes = gltf.nodes ?? []
  const parents = new Array(nodes.length).fill(-1)
  const children = nodes.map(() => [])
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) {
      if (parents[child] === -1) parents[child] = index
      children[index].push(child)
    }
  })

  const local = nodes.map(nodeLocalTrs)
  const worldPos = new Array(nodes.length)
  const worldRot = new Array(nodes.length)
  const worldScale = new Array(nodes.length)
  /** 深度（层级越深越大） */
  const depth = new Array(nodes.length).fill(0)
  const order = []
  const roots = []
  nodes.forEach((_, index) => {
    if (parents[index] === -1) roots.push(index)
  })
  const queue = roots.slice()
  while (queue.length > 0) {
    const index = queue.shift()
    order.push(index)
    const parent = parents[index]
    const trs = local[index]
    if (parent === -1) {
      worldPos[index] = trs.translation.slice()
      worldRot[index] = qNormalize(trs.rotation)
      worldScale[index] = trs.scale.slice()
      depth[index] = 0
    } else {
      const parentScale = worldScale[parent]
      const scaled = [
        trs.translation[0] * parentScale[0],
        trs.translation[1] * parentScale[1],
        trs.translation[2] * parentScale[2]
      ]
      const rotated = qRotVec(worldRot[parent], scaled)
      worldPos[index] = [
        worldPos[parent][0] + rotated[0],
        worldPos[parent][1] + rotated[1],
        worldPos[parent][2] + rotated[2]
      ]
      worldRot[index] = qNormalize(qMul(worldRot[parent], qNormalize(trs.rotation)))
      worldScale[index] = [
        worldScale[parent][0] * trs.scale[0],
        worldScale[parent][1] * trs.scale[1],
        worldScale[parent][2] * trs.scale[2]
      ]
      depth[index] = depth[parent] + 1
    }
    for (const child of children[index]) queue.push(child)
  }

  const humanoidDef = gltf.extensions?.VRMC_vrm?.humanoid?.humanBones ?? {}
  /** @type {Record<string, { nodeIndex: number, nodeName: string, position: number[], rotation: number[] }>} */
  const humanoid = {}
  /** @type {Map<number, string>} */
  const humanoidNameByNode = new Map()
  for (const [name, info] of Object.entries(humanoidDef)) {
    if (!info || typeof info.node !== 'number') continue
    const nodeIndex = info.node
    humanoid[name] = {
      nodeIndex,
      nodeName: nodes[nodeIndex]?.name ?? `#${nodeIndex}`,
      position: worldPos[nodeIndex],
      rotation: worldRot[nodeIndex]
    }
    humanoidNameByNode.set(nodeIndex, name)
  }

  /** humanoid 骨的 raw 父级中最近的 humanoid 祖先（= 归一化旋转的父级）。 */
  /** @type {Record<string, string | null>} */
  const effectiveParent = {}
  for (const name of Object.keys(humanoid)) {
    let cursor = parents[humanoid[name].nodeIndex]
    let found = null
    while (cursor >= 0) {
      if (humanoidNameByNode.has(cursor)) {
        found = humanoidNameByNode.get(cursor)
        break
      }
      cursor = parents[cursor]
    }
    effectiveParent[name] = found
  }

  /** 按层级排序的 humanoid 骨（父级在前）。 */
  const humanoidOrder = Object.keys(humanoid).sort(
    (a, b) => depth[humanoid[a].nodeIndex] - depth[humanoid[b].nodeIndex]
  )

  /** @type {Map<string, number[]>} */
  const nameToNodes = new Map()
  nodes.forEach((node, index) => {
    const name = node.name
    if (typeof name !== 'string') return
    if (!nameToNodes.has(name)) nameToNodes.set(name, [])
    nameToNodes.get(name).push(index)
  })

  return {
    gltf,
    nodes,
    parents,
    children,
    local,
    worldPos,
    worldRot,
    worldScale,
    depth,
    order,
    roots,
    humanoid,
    humanoidNameByNode,
    effectiveParent,
    humanoidOrder,
    nameToNodes
  }
}

/**
 * 从 vrm-manifest.json 解析 avatar 的 VRM 文件路径。
 * @param {string} manifestPath
 * @param {string} assetsRoot
 * @param {string} [avatarId] 缺省用 defaultAvatarId
 */
export function resolveVrmAsset(manifestPath, assetsRoot, avatarId) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const id = avatarId ?? manifest.defaultAvatarId
  const avatar = (manifest.avatars ?? []).find((item) => item && item.id === id)
  if (!avatar) throw new Error(`vrm-manifest 中找不到 avatar: ${id}`)
  const file = String(avatar.file ?? '')
  if (!file) throw new Error(`avatar ${id} 缺少 file`)
  return { avatarId: id, heightMeters: avatar.heightMeters ?? null, file: `${assetsRoot}/${file}`, manifest: avatar }
}

/** @param {ReturnType<typeof buildVrmRest>} rest @param {number} nodeIndex */
export function restDirectionOf(rest, nodeIndex) {
  const children = rest.children[nodeIndex] ?? []
  if (children.length > 0) {
    const childPos = rest.worldPos[children[0]]
    const ownPos = rest.worldPos[nodeIndex]
    return normalize3([childPos[0] - ownPos[0], childPos[1] - ownPos[1], childPos[2] - ownPos[2]])
  }
  const parent = rest.parents[nodeIndex]
  if (parent >= 0) {
    const parentPos = rest.worldPos[parent]
    const ownPos = rest.worldPos[nodeIndex]
    return normalize3([ownPos[0] - parentPos[0], ownPos[1] - parentPos[1], ownPos[2] - parentPos[2]])
  }
  return [0, 1, 0]
}

/** VRM humanoid 骨的 rest 世界位置（米）。 */
export function humanoidRestPosition(rest, name) {
  const item = rest.humanoid[name]
  return item ? item.position.slice() : null
}

/**
 * 由 humanoid 三根骨的位置构造 R_align（源 armature space → VRM scene space）。
 *
 * 默认行为 = HSR（`Scapula_R-L` / `Chest_M-Root_M` / `Root_M`，即 Wave 1 已验证口径）。
 * 可插拔 source：传 `source`（V3.1 新增，纯增量）可换源骨架的参考骨：
 *   { rest, leftShoulderBone, rightShoulderBone, upBone, hipsBone }
 * — Biped 用 `L Clavicle / R Clavicle / 最高一节 Spine / Pelvis`（见 lib/humanoid-biped.mjs）。
 * 不传 source 时所有骨名与旧实现完全一致，数值逐位不变（有回归测试）。
 *
 * @param {{
 *   hsrRest?: Record<string, { head: number[], quat?: number[] }>,
 *   vrmRest: any,
 *   source?: { rest?: any, leftShoulderBone?: string, rightShoulderBone?: string,
 *     upBone?: string, hipsBone?: string } | null
 * }} args
 */
export function buildAlignment({ hsrRest, vrmRest, source = null }) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const sourceRest = source?.rest ?? hsrRest
  if (!sourceRest) throw new Error('buildAlignment: 缺少源 rest（hsrRest 或 source.rest）')
  const sourceBones = {
    leftShoulder: source?.leftShoulderBone ?? 'Scapula_L',
    rightShoulder: source?.rightShoulderBone ?? 'Scapula_R',
    up: source?.upBone ?? 'Chest_M',
    hips: source?.hipsBone ?? 'Root_M'
  }
  const hhead = (name) => {
    const bone = sourceRest[name]
    if (!bone || !Array.isArray(bone.head)) {
      throw new Error(`buildAlignment: 源 rest 缺少参考骨 ${name}（source 参考骨=${JSON.stringify(sourceBones)}）`)
    }
    return bone.head
  }
  // VRM 1.0 的 upperChest 是可选骨（新版 T-pose 戏浪没有）：缺失时用 chest 位置定义 up 轴。
  const vpos = (name) => {
    if (vrmRest.humanoid[name]) return vrmRest.humanoid[name].position
    if (name === 'upperChest' && vrmRest.humanoid.chest) {
      return vrmRest.humanoid.chest.position
    }
    throw new Error(`buildAlignment: 目标 VRM 缺少 humanoid 骨 ${name}，无法计算对齐`)
  }
  const rh = normalize3(sub(hhead(sourceBones.rightShoulder), hhead(sourceBones.leftShoulder)))
  const uh = normalize3(sub(hhead(sourceBones.up), hhead(sourceBones.hips)))
  const fh = normalize3(cross(uh, rh))
  const rv = normalize3(sub(vpos('rightShoulder'), vpos('leftShoulder')))
  const uv = normalize3(sub(vpos('upperChest'), vpos('hips')))
  const fv = normalize3(cross(uv, rv))
  const bh = mat3FromColumns(rh, uh, fh)
  const bv = mat3FromColumns(rv, uv, fv)
  const matrix = mat3Mul(bv, transpose3(bh))
  return {
    matrix,
    quat: quatFromMat3(matrix),
    inverseQuat: qInvert(quatFromMat3(matrix)),
    hsrAxes: { right: rh, up: uh, forward: fh },
    vrmAxes: { right: rv, up: uv, forward: fv },
    upperChestFallback: !vrmRest.humanoid.upperChest
  }
}

/** VRM SpringBone 摘要（用于 raw 策略/QA：有 spring 的新资产默认让 spring 驱动次级骨）。 */
export function springBoneInfo(json) {
  const spring = json?.extensions?.VRMC_springBone
  if (!spring) return { present: false, chains: 0, colliders: 0, joints: 0 }
  const chains = Array.isArray(spring.springs) ? spring.springs.length : 0
  let joints = 0
  for (const chain of spring.springs ?? []) joints += chain.joints?.length ?? 0
  return {
    present: true,
    chains,
    colliders: Array.isArray(spring.colliders) ? spring.colliders.length : 0,
    joints
  }
}

function transpose3(m) {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]]
  ]
}
