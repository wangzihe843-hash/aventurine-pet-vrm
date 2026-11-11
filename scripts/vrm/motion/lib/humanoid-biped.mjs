/**
 * 3ds Max Biped 骨架 → VRM humanoid 映射 / **可插拔 source 描述符**（Biped 实现）。
 *
 * 背景（docs/max-anim-conversion-plan.md、docs/research/wave1-15-pitfalls.md §3）：
 * - 官方动作源的每个 `.max` 场景里是标准 3ds Max Biped 骨架（FBX 导出后骨名形如
 *   `Bip001 Pelvis / Spine / Spine1 / Spine2 / Neck / Head / L Clavicle / L UpperArm /
 *   L Forearm / L Hand / L Thigh / L Calf / L Foot / L Toe0 / L Finger0..4（各 3 节）`，
 *   另有 `*Nub`、`Bip001 Footsteps`、`Bip001`（COM）等非人体骨）；
 * - 采样由 `extract-biped-anims.py` / `build-biped-fixture.py`（task-5）完成，输出与
 *   `tests/tmp/hsr-motion/samples.json` 完全同 schema：`rest{quat,head,parent} + children +
 *   clips{id:{action,srcFrames,frames,data:[{f,q,h}]}}`；
 * - 本文件只做「源骨名解析 + humanoid 映射 + 源描述符」，重定向数学复用
 *   `lib/retarget.mjs`（world-delta → R_align → rest 方向修正 → effectiveParent 归一化 →
 *   Hips 位移/in-place → grounding），不重复实现。
 *
 * ## 骨名匹配（健壮性）
 * 实际 FBX 可能来自不同 Max 版本/导出插件：前缀 `Bip001` / `Bip01` / 无前缀；左右侧写法
 * `L Xxx` / `R Xxx` / `Xxx_L` / `Xxx.L`；大小写差异。解析步骤：
 *   1. 去掉 `Bip<数字>` / `Biped` 前缀；
 *   2. 识别侧标记（前/后缀，`L|R|Left|Right`，允许空格/下划线/点作分隔）；
 *   3. core 归一化（小写、去分隔符）后按语义表匹配（`pelvis|spine\d*|neck\d*|head|clavicle|
 *      upperarm|forearm|hand|thigh|calf|foot|toe\d*|finger<链><节>`）；
 *   4. `*Nub` / `Footsteps` / `COM` / twistys / `HorseLink` / `Ponytail` / `Prop` / `Tail`
 *      归类为 ignored（不报错，写进 mapping report）。
 *
 * ## 手指语义证据（禁止瞎猜）
 * - **Autodesk MAXScript 文档「Biped Node Hierarchy」**（`biped.getNode #lfingers link:n`）：
 *   link 顺序 = `L Finger0, L Finger01, L Finger02, L Finger1, L Finger11, L Finger12,
 *   L Finger2, L Finger21, L Finger22, L Finger3, L Finger31, L Finger32, L Finger4,
 *   L Finger41, L Finger42` —— 命名规则是 `Finger<链号><节号?>`（第 1 节无节号后缀），
 *   链号 0..4 依次为解剖顺序 拇指→食指→中指→无名指→小指（与 Biped 手指 UI 顺序一致）。
 *   https://help.autodesk.com/cloudhelp/2017/ENU/MAXScript-Help/files/GUID-BBC1B4FC-FE13-4C06-A20A-BC9BA08C5F93.htm
 * - **BipedPlus（OtakuSolutions）Biped 骨表**：`Bip001 L Finger0` 的 parent 是
 *   `Bip001 L Hand`，链为 `L Finger0 → L Finger01 → L Finger02 → L Finger0Nub`；
 *   默认 Biped 腿链为 `Thigh → Calf → Foot → Toe0`，脊柱为 `Spine → Spine1 → Spine2`。
 *   https://docs.otakusolutions.com/guide/biped-plus/ep21-biped-bones-reference?lang=en
 * - **社区重定向别名表（Blender Avatar Toolkit）**：`valvebipedbip01rfinger0` 归入
 *   `thumb_1_r`（拇指）别名组 —— 佐证 Finger0 = 拇指。
 * - 另外本文件提供 `scoreFingerAssignments()`：用「源 rest 链方向 vs 目标 rest 链方向」
 *   给 5 条链 × 5 组手指的赋值打分，mapping report 会打印选中赋值与最佳赋值的分数；
 *   真实 FBX 到达后用它复核（拇指 rest 方向与其余四指明显不同，可区分；1..4 的先后
 *   顺序按 Autodesk 文档链接顺序确定）。
 *
 * ## 脊柱三节 → 目标两档（spine + chest）
 * HSR 已验证的 target-aware 规则（docs/vrm-motion-hsr.md / pitfalls A2）：目标缺
 * `upperChest` 时 `spine←第一根脊柱骨`、`chest←最后一根（紧邻 Neck 的）脊柱骨`，中间脊柱骨的
 * 旋转不丢——它已包含在最后一根脊柱骨的**世界 delta** 里，归一化局部旋转会把差额并入 chest。
 * Biped 默认 `Spine/Spine1/Spine2` 三节，套用同一规则：`spine←Spine`、`chest←Spine2`
 * （`Spine1` 的局部旋转并入 chest 的绝对旋转）。目标若有 upperChest（旧资产），则按
 * `spine←Spine`、`chest←Spine1`、`upperChest←Spine2` 一比一分布。
 *
 * ## 已知近似/限制（写进 RETARGET-REPORT）
 * - Biped 手指每指 3 节，拇指三节 1:1 映射到 VRM `ThumbMetacarpal/Proximal/Distal`
 *   （HSR 同口径；Biped 拇指第一节点在掌内，语义与 VRM Metacarpal 最接近；rest 方向修正兜底）。
 * - Biped `HorseLink`（马腿附加节，默认无）不映射；`Nub`/`Footsteps`/twistys 忽略。
 * - Biped 的缩放/拉伸（Squash & Stretch）通道不在采样 schema 内 → 忽略（本管线只用旋转 + hips 位移）。
 * - 真实 FBX 的 rest 姿势（T-pose / A-pose）由 Figure Mode 决定：这里不假设，rest 方向修正
 *   会按实测 rest 差生成修正表，mapping report 会打印每根骨的对齐后 rest 方向差。
 */

import { UNITY_NAME_BY_VRM, resolveHumanoidNext } from './humanoid-hsr.mjs'
import { normalize3, qRotateVec } from './quat.mjs'

/** Biped 左右侧标签（用于生成 VRM humanoid 名）。 */
export const BIPED_SIDE_LABELS = Object.freeze({ left: 'L', right: 'R' })

/**
 * 手指链语义：Biped `Finger<chain>`（chain 0..4）→ VRM 手指骨头名（不含左右前缀）。
 * chain 顺序证据见文件头（Autodesk Biped Node Hierarchy 的 link 顺序：拇指在 0）。
 */
export const BIPED_FINGER_LAYOUT = Object.freeze({
  0: Object.freeze({ label: 'thumb', vrm: Object.freeze(['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal']) }),
  1: Object.freeze({ label: 'index', vrm: Object.freeze(['IndexProximal', 'IndexIntermediate', 'IndexDistal']) }),
  2: Object.freeze({ label: 'middle', vrm: Object.freeze(['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal']) }),
  3: Object.freeze({ label: 'ring', vrm: Object.freeze(['RingProximal', 'RingIntermediate', 'RingDistal']) }),
  4: Object.freeze({ label: 'little', vrm: Object.freeze(['LittleProximal', 'LittleIntermediate', 'LittleDistal']) })
})

/** Biped 源骨架的 21 根**必需** core 骨（不含 upperChest；缺任何一根都无法满足 22 骨契约）。 */
export const BIPED_REQUIRED_HUMANOID = Object.freeze([
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'leftToes',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'rightToes'
])

/** 全部 52 根 humanoid 名（22 core（含 upperChest）+ 30 手指），用于 expected 全量集合。 */
const ALL_HUMANOID_NAMES = Object.freeze(Object.keys(UNITY_NAME_BY_VRM))

const PREFIX_RE = /^(bip(?:ed)?[\s._-]*\d+|bip\d*|biped)[\s._-]*/i
const SIDE_LEAD_RE = /^(left|right|l|r)[\s._-]+/i
const SIDE_LEAD_COMPACT_RE = /^(left|right)(?=[A-Z])/
const SIDE_TAIL_RE = /[\s._-]+(left|right|l|r)$/i

const IGNORED_CORE_RE = /(nub|twist|footsteps|horselink|ponytail|prop\d*|^tail|bipslave|^com$)/

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const vecAngleDeg = (a, b) => {
  const d = Math.min(1, Math.max(-1, dot3(normalize3(a), normalize3(b))))
  return (Math.acos(d) * 180) / Math.PI
}

function sideFromToken(token) {
  const value = String(token ?? '').toLowerCase()
  if (value === 'l' || value === 'left') return 'left'
  if (value === 'r' || value === 'right') return 'right'
  return null
}

/**
 * 解析一根 Biped 骨名。
 * @param {string} rawName
 * @returns {{ raw: string, prefix: string | null, side: 'left' | 'right' | null,
 *   stem: string, core: string, kind: string, index?: number, chain?: number, link?: number }}
 */
export function parseBipedBoneName(rawName) {
  const raw = String(rawName ?? '').trim()
  let name = raw
  let prefix = null
  const prefixMatch = name.match(PREFIX_RE)
  if (prefixMatch) {
    prefix = prefixMatch[1]
    name = name.slice(prefixMatch[0].length)
  }
  let side = null
  const lead = name.match(SIDE_LEAD_RE)
  if (lead) {
    side = sideFromToken(lead[1])
    name = name.slice(lead[0].length)
  } else {
    const compact = name.match(SIDE_LEAD_COMPACT_RE)
    if (compact) {
      side = sideFromToken(compact[1])
      name = name.slice(compact[0].length)
    } else {
      const tail = name.match(SIDE_TAIL_RE)
      if (tail) {
        side = sideFromToken(tail[1])
        name = name.slice(0, tail.index)
      }
    }
  }
  const stem = name.trim()
  const core = stem.toLowerCase().replace(/[^a-z0-9]/g, '')
  const classified = classifyBipedCore(core)
  return { raw, prefix, side: side ?? null, stem, core, ...classified }
}

/** core 归一化名 → 语义分类。 */
function classifyBipedCore(core) {
  if (!core) return { kind: 'root' }
  if (IGNORED_CORE_RE.test(core)) return { kind: 'ignored' }
  if (core === 'pelvis' || core === 'hips' || core === 'hip') return { kind: 'pelvis' }
  let match = core.match(/^spine(\d*)$/)
  if (match) return { kind: 'spine', index: match[1] ? Number(match[1]) : 0 }
  match = core.match(/^neck(\d*)$/)
  if (match) return { kind: 'neck', index: match[1] ? Number(match[1]) : 0 }
  if (core === 'head') return { kind: 'head' }
  if (core === 'clavicle' || core === 'collarbone') return { kind: 'clavicle' }
  if (core === 'upperarm' || core === 'uparm') return { kind: 'upperArm' }
  if (core === 'forearm' || core === 'lowerarm') return { kind: 'forearm' }
  if (core === 'hand') return { kind: 'hand' }
  if (core === 'thigh' || core === 'upperleg') return { kind: 'thigh' }
  if (core === 'calf' || core === 'shin' || core === 'lowerleg') return { kind: 'calf' }
  if (core === 'foot') return { kind: 'foot' }
  match = core.match(/^toe(\d*)$/)
  if (match) return { kind: 'toe', index: match[1] ? Number(match[1]) : 0 }
  // Finger<链号>（第 1 节无节号）/ Finger<链号><1|2>（后续节）；兼容 Finger0_1 / Finger0Link1 等写法。
  match = core.match(/^finger(\d)(?:link|joint|seg|l)?([0-9])?$/)
  if (match) {
    const chain = Number(match[1])
    const link = match[2] === undefined || match[2] === '' ? 0 : Number(match[2])
    if (chain <= 4 && link <= 2) return { kind: 'finger', chain, link }
  }
  return { kind: 'unknown' }
}

/**
 * 解析 Biped 源 rest 骨架（骨名 → 语义索引），供映射/描述符使用。纯函数。
 *
 * @param {Record<string, { quat?: number[], head: number[], parent?: string | null }>} rest
 * @returns {any} skeleton（见 RETARGET-REPORT 的 mapping-report 结构）
 */
export function resolveBipedSkeleton(rest) {
  const boneNames = Object.keys(rest ?? {})
  /** @type {Map<string, any>} */
  const parsed = new Map()
  const unsupported = []
  for (const name of boneNames) {
    const info = parseBipedBoneName(name)
    if (info.kind === 'unknown') unsupported.push(name)
    parsed.set(name, info)
  }

  const warnings = []
  const ignored = []
  /** @type {Record<'left'|'right', Record<string, any[]>>} */
  const sided = { left: {}, right: {} }
  /** @type {Record<string, any[]>} */
  const center = {}
  for (const [name, info] of parsed) {
    if (info.kind === 'ignored') {
      ignored.push(name)
      continue
    }
    if (info.kind === 'root' || info.kind === 'unknown') continue
    const bucket = info.side ? sided[info.side] : center
    const list = (bucket[info.kind] ??= [])
    list.push({ name, ...info })
  }
  const sortByIndex = (list) => list.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || (a.chain ?? 0) - (b.chain ?? 0) || (a.link ?? 0) - (b.link ?? 0))

  const pickOne = (kind, side, { preferMinIndex = true } = {}) => {
    const list = sortByIndex((side ? sided[side][kind] : center[kind]) ?? [])
    if (list.length === 0) return null
    if (list.length > 1) {
      warnings.push(`${side ? `${side} ` : ''}${kind} 骨有 ${list.length} 个候选（${list.map((item) => item.name).join(', ')}），取「${list[0].name}」`)
    }
    if (!preferMinIndex) return list[list.length - 1]
    return list[0]
  }

  const pelvis = pickOne('pelvis', null)?.name ?? null
  const spineLinks = sortByIndex(center.spine ?? []).map((item) => item.name)
  const neckLinks = sortByIndex(center.neck ?? []).map((item) => item.name)
  const head = pickOne('head', null)?.name ?? null
  const neck = neckLinks.length > 0 ? neckLinks[neckLinks.length - 1] : null
  if (spineLinks.length === 0) warnings.push('源骨架缺少 Spine 骨（Biped 标准应有 Spine/Spine1/Spine2）')
  if (spineLinks.length > 3) warnings.push(`源脊柱有 ${spineLinks.length} 节（多于目标 2 档），中间节旋转并入 chest 的世界旋转`)
  if (!pelvis) warnings.push('源骨架缺少 Pelvis 骨（Biped 根）')
  if (!head) warnings.push('源骨架缺少 Head 骨')
  if (!neck) warnings.push('源骨架缺少 Neck 骨')

  /** @type {Record<'left'|'right', any>} */
  const arms = {}
  const legs = {}
  for (const side of ['left', 'right']) {
    const clavicle = pickOne('clavicle', side)?.name ?? null
    const upperArm = pickOne('upperArm', side)?.name ?? null
    const forearm = pickOne('forearm', side)?.name ?? null
    const hand = pickOne('hand', side)?.name ?? null
    arms[side] = { clavicle, upperArm, forearm, hand }
    const thigh = pickOne('thigh', side)?.name ?? null
    const calf = pickOne('calf', side)?.name ?? null
    const foot = pickOne('foot', side)?.name ?? null
    const toe = pickOne('toe', side)?.name ?? null // 取 index 最小（Toe0）
    legs[side] = { thigh, calf, foot, toe }
    for (const [label, value] of [
      ['Clavicle', clavicle],
      ['UpperArm', upperArm],
      ['Forearm', forearm],
      ['Hand', hand],
      ['Thigh', thigh],
      ['Calf', calf],
      ['Foot', foot],
      ['Toe0', toe]
    ]) {
      if (!value) warnings.push(`源骨架缺少 ${side} ${label} 骨`)
    }
  }

  /** @type {Record<'left'|'right', Record<number, string[]>>} */
  const fingers = { left: {}, right: {} }
  for (const side of ['left', 'right']) {
    const byChain = sided[side].finger ?? []
    for (const item of byChain) {
      const links = (fingers[side][item.chain] ??= [])
      if (links[item.link] !== undefined) {
        warnings.push(`${side} Finger${item.chain} 第 ${item.link} 节重复（${links[item.link]} / ${item.name}），保留前者`)
        continue
      }
      links[item.link] = item.name
    }
    for (const chain of [0, 1, 2, 3, 4]) {
      const links = fingers[side][chain]
      if (!links) continue
      const labels = BIPED_FINGER_LAYOUT[chain]
      for (let link = 0; link < 3; link += 1) {
        if (!links[link]) warnings.push(`源骨架缺少 ${side} Finger${chain}（${labels.label}）第 ${link + 1} 节`)
      }
      if (links.length < 3) warnings.push(`${side} Finger${chain}（${labels.label}）只有 ${links.filter(Boolean).length} 节，不足 3 节`)
    }
  }

  /** 源骨 → 解剖链下一根（rest 方向修正用；叶骨走 parent→own）。 */
  const boneNext = {}
  const setNext = (from, to) => {
    if (from) boneNext[from] = to ?? null
  }
  if (spineLinks.length > 0) {
    setNext(pelvis, spineLinks[0])
    for (let i = 0; i < spineLinks.length - 1; i += 1) setNext(spineLinks[i], spineLinks[i + 1])
    setNext(spineLinks[spineLinks.length - 1], neckLinks[0] ?? head)
  } else {
    setNext(pelvis, neckLinks[0] ?? head)
  }
  if (neckLinks.length > 0) {
    for (let i = 0; i < neckLinks.length - 1; i += 1) setNext(neckLinks[i], neckLinks[i + 1])
    setNext(neckLinks[neckLinks.length - 1], head)
  }
  setNext(head, null)
  for (const side of ['left', 'right']) {
    const arm = arms[side]
    setNext(arm.clavicle, arm.upperArm)
    setNext(arm.upperArm, arm.forearm)
    setNext(arm.forearm, arm.hand)
    const middle = fingers[side][2]
    setNext(arm.hand, middle?.[0] ?? null)
    for (const chain of [0, 1, 2, 3, 4]) {
      const links = fingers[side][chain] ?? []
      setNext(links[0], links[1] ?? null)
      setNext(links[1], links[2] ?? null)
      setNext(links[2], null)
    }
    const leg = legs[side]
    setNext(leg.thigh, leg.calf)
    setNext(leg.calf, leg.foot)
    setNext(leg.foot, leg.toe)
    setNext(leg.toe, null)
  }

  const unknown = unsupported.length > 0 ? unsupported : []
  if (unknown.length > 0) {
    // 非 Biped 骨（道具/尾巴/额外控制器等）不致命：映射时忽略，写进报告。
    warnings.push(`源骨架有 ${unknown.length} 根未识别骨（忽略）：${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? ' …' : ''}`)
  }

  return {
    bones: parsed,
    ignored,
    unsupported: unknown,
    pelvis,
    spineLinks,
    neck,
    neckLinks,
    head,
    arms,
    legs,
    fingers,
    boneNext,
    warnings,
    stats: {
      sourceBones: boneNames.length,
      humanoidSourceBones:
        (pelvis ? 1 : 0) +
        spineLinks.length +
        neckLinks.length +
        (head ? 1 : 0) +
        ['left', 'right'].reduce((sum, side) => {
          const arm = arms[side]
          const leg = legs[side]
          const armCount = [arm.clavicle, arm.upperArm, arm.forearm, arm.hand].filter(Boolean).length
          const legCount = [leg.thigh, leg.calf, leg.foot, leg.toe].filter(Boolean).length
          const fingerCount = [0, 1, 2, 3, 4].reduce((acc, chain) => acc + (fingers[side][chain] ?? []).filter(Boolean).length, 0)
          return sum + armCount + legCount + fingerCount
        }, 0),
      fingerChains: ['left', 'right'].reduce(
        (sum, side) => sum + [0, 1, 2, 3, 4].filter((chain) => (fingers[side][chain] ?? []).length > 0).length,
        0
      )
    }
  }
}

/**
 * 脊柱 N 节 → 目标 spine/chest（/upperChest）槽位。规则见文件头。
 * @param {string[]} links spineLinks（由下到上）
 * @param {boolean} hasUpperChest 目标是否有 upperChest
 */
export function resolveSpineSlots(links, hasUpperChest) {
  const notes = []
  if (!links || links.length === 0) {
    return { spine: null, chest: null, upperChest: null, merged: [], notes: ['源骨架无脊柱骨'] }
  }
  if (hasUpperChest) {
    if (links.length >= 3) {
      const spine = links[0]
      const chest = links[Math.max(1, links.length - 2)]
      const upperChest = links[links.length - 1]
      const merged = links.filter((name) => name !== spine && name !== chest && name !== upperChest)
      notes.push(`目标有 upperChest：spine←${spine}、chest←${chest}、upperChest←${upperChest}${merged.length ? `（并入：${merged.join(', ')}）` : ''}`)
      return { spine, chest, upperChest, merged, notes }
    }
    const spine = links[0]
    const last = links[links.length - 1]
    notes.push(`目标有 upperChest 但源只有 ${links.length} 节脊柱：spine←${spine}、chest/upperChest←${last}（重复槽位产生 identity 局部旋转）`)
    return { spine, chest: last, upperChest: last, merged: [], notes }
  }
  if (links.length === 1) {
    notes.push(`源只有 1 节脊柱：spine/chest 都映射 ${links[0]}（chest 局部旋转恒 identity，上胸扭转丢失）`)
    return { spine: links[0], chest: links[0], upperChest: null, merged: [], notes }
  }
  const spine = links[0]
  const chest = links[links.length - 1]
  const merged = links.slice(1, -1)
  notes.push(
    `目标缺 upperChest：spine←${spine}、chest←${chest}` +
      (merged.length > 0 ? `（中间 ${merged.join(', ')} 的局部旋转并入 chest 的世界旋转，与 HSR Spine2_M 同口径）` : '')
  )
  return { spine, chest, upperChest: null, merged, notes }
}

/**
 * 源 rest 骨方向（与 rest-direction-fix.mjs 同语义：优先解剖链下一根，否则 parent→own）。
 * @param {any} rest
 * @param {string} boneName
 * @param {Record<string, string | null>} boneNext
 */
export function bipedRestDirection(rest, boneName, boneNext) {
  const bone = rest?.[boneName]
  if (!bone) return null
  const hasNext = Object.prototype.hasOwnProperty.call(boneNext ?? {}, boneName)
  const nextName = hasNext ? boneNext[boneName] : undefined
  if (nextName && rest[nextName]) return normalize3(sub3(rest[nextName].head, bone.head))
  const parent = bone.parent
  if (!parent || !rest[parent]) return null
  return normalize3(sub3(bone.head, rest[parent].head))
}

/** 目标 VRM rest 骨方向（scene space；与 rest-direction-fix.mjs 同语义）。 */
function vrmRestDirection(vrmRest, vrmName) {
  const bone = vrmRest?.humanoid?.[vrmName]
  if (!bone) return null
  const next = resolveHumanoidNext(vrmName, vrmRest)
  if (next && vrmRest.humanoid[next]) return normalize3(sub3(vrmRest.humanoid[next].position, bone.position))
  const parent = vrmRest?.effectiveParent?.[vrmName]
  if (!parent || !vrmRest.humanoid?.[parent]) return null
  return normalize3(sub3(bone.position, vrmRest.humanoid[parent].position))
}

/**
 * 以**目标 VRM 实际 humanoid 骨**为准生成 Biped → VRM 映射（target-aware）。
 *
 * @param {any} vrmRest buildVrmRest 结果（`humanoid` 键）
 * @param {any} skeleton resolveBipedSkeleton 结果
 */
export function resolveBipedMapping(vrmRest, skeleton) {
  const humanoid = vrmRest?.humanoid ?? {}
  /** @type {Record<string, string>} */
  const mapping = {}
  const notes = []
  const missing = []
  const hasUpperChest = Boolean(humanoid.upperChest)
  const slots = resolveSpineSlots(skeleton?.spineLinks ?? [], hasUpperChest)
  notes.push(...slots.notes)

  const corePairs = [
    ['hips', skeleton?.pelvis],
    ['spine', slots.spine],
    ['chest', slots.chest],
    ['upperChest', slots.upperChest],
    ['neck', skeleton?.neck],
    ['head', skeleton?.head],
    ['leftShoulder', skeleton?.arms?.left?.clavicle],
    ['leftUpperArm', skeleton?.arms?.left?.upperArm],
    ['leftLowerArm', skeleton?.arms?.left?.forearm],
    ['leftHand', skeleton?.arms?.left?.hand],
    ['rightShoulder', skeleton?.arms?.right?.clavicle],
    ['rightUpperArm', skeleton?.arms?.right?.upperArm],
    ['rightLowerArm', skeleton?.arms?.right?.forearm],
    ['rightHand', skeleton?.arms?.right?.hand],
    ['leftUpperLeg', skeleton?.legs?.left?.thigh],
    ['leftLowerLeg', skeleton?.legs?.left?.calf],
    ['leftFoot', skeleton?.legs?.left?.foot],
    ['leftToes', skeleton?.legs?.left?.toe],
    ['rightUpperLeg', skeleton?.legs?.right?.thigh],
    ['rightLowerLeg', skeleton?.legs?.right?.calf],
    ['rightFoot', skeleton?.legs?.right?.foot],
    ['rightToes', skeleton?.legs?.right?.toe]
  ]
  for (const [vrmName, sourceBone] of corePairs) {
    if (!humanoid[vrmName]) continue
    if (sourceBone) mapping[vrmName] = sourceBone
    else missing.push(vrmName)
  }

  const fingerMissing = []
  for (const side of ['left', 'right']) {
    for (const chain of [0, 1, 2, 3, 4]) {
      const links = skeleton?.fingers?.[side]?.[chain] ?? []
      const layout = BIPED_FINGER_LAYOUT[chain]
      for (let link = 0; link < 3; link += 1) {
        const vrmName = `${side}${layout.vrm[link]}`
        if (!humanoid[vrmName]) continue
        const sourceBone = links[link]
        if (sourceBone) mapping[vrmName] = sourceBone
        else fingerMissing.push(vrmName)
      }
    }
  }
  if (fingerMissing.length > 0) {
    notes.push(`目标有 ${fingerMissing.length} 根手指骨但源骨架对应节缺失：${fingerMissing.slice(0, 6).join(', ')}…`)
  }
  if (missing.length > 0) notes.push(`目标有 ${missing.length} 根 core 骨但源骨架缺映射：${missing.join(', ')}`)

  return {
    mapping,
    notes,
    missing,
    fingerMissing,
    upperChestFallback: !hasUpperChest,
    spine: slots,
    hasUpperChest
  }
}

/** 源骨架能驱动的 humanoid 名（不管目标有没有）——用于「目标缺骨」告警。 */
export function intendedBipedHumanoidNames(skeleton) {
  const fakeVrmRest = { humanoid: Object.fromEntries(ALL_HUMANOID_NAMES.map((name) => [name, { position: [0, 0, 0] }])) }
  const { mapping } = resolveBipedMapping(fakeVrmRest, skeleton)
  return Object.keys(mapping)
}

function estimateSourceHeightMeters(rest, upBone, hipsBone) {
  const direction = upDirection(rest, upBone, hipsBone)
  const values = []
  for (const bone of Object.values(rest ?? {})) {
    if (!bone?.head) continue
    values.push(dot3(bone.head, direction))
  }
  if (values.length === 0) return null
  return Math.max(...values) - Math.min(...values)
}

function upDirection(rest, upBone, hipsBone) {
  const hips = rest?.[hipsBone]
  const up = rest?.[upBone]
  if (hips?.head && up?.head) {
    const vec = sub3(up.head, hips.head)
    if (Math.hypot(vec[0], vec[1], vec[2]) > 1e-6) return normalize3(vec)
  }
  return [0, 1, 0]
}

/**
 * 构造 Biped 源描述符（`retargetClip` / `buildAlignment` 的可插拔 source 参数）。
 *
 * @param {{
 *   samples: { rest: Record<string, any>, children?: any, sourceHeightMeters?: number,
 *     sourceHipsHeightMeters?: number, fps?: number, sourceFps?: number },
 *   strict?: boolean
 * }} args
 */
export function createBipedSource({ samples, strict = false }) {
  if (!samples || typeof samples !== 'object' || !samples.rest || typeof samples.rest !== 'object') {
    throw new Error('createBipedSource: samples.rest 缺失（需要 extract-biped-anims.py 产出的采样 JSON）')
  }
  const skeleton = resolveBipedSkeleton(samples.rest)
  const fullMapping = resolveBipedMapping(
    { humanoid: Object.fromEntries(ALL_HUMANOID_NAMES.map((name) => [name, { position: [0, 0, 0] }])) },
    skeleton
  )
  const missingRequired = BIPED_REQUIRED_HUMANOID.filter((name) => !fullMapping.mapping[name])
  if (strict && missingRequired.length > 0) {
    throw new Error(
      `createBipedSource: 源骨架缺少必需 humanoid 骨映射：${missingRequired.join(', ')}；` +
        `源骨名样例=${Object.keys(samples.rest).slice(0, 12).join(' / ')}`
    )
  }

  const hipsBone = skeleton.pelvis
  const upBone = skeleton.spineLinks[skeleton.spineLinks.length - 1] ?? skeleton.head ?? null
  const sourceHipsHeightMeters =
    Number.isFinite(samples.sourceHipsHeightMeters) && samples.sourceHipsHeightMeters > 0
      ? samples.sourceHipsHeightMeters
      : hipsBone && samples.rest[hipsBone]?.head
        ? dot3(samples.rest[hipsBone].head, upDirection(samples.rest, upBone, hipsBone))
        : null
  const sourceHeightMeters =
    Number.isFinite(samples.sourceHeightMeters) && samples.sourceHeightMeters > 0
      ? samples.sourceHeightMeters
      : estimateSourceHeightMeters(samples.rest, upBone, hipsBone)

  const warnings = [...skeleton.warnings]
  if (missingRequired.length > 0) {
    warnings.push(`源骨架缺必需 humanoid 骨映射：${missingRequired.join(', ')}（clip 将补 identity 轨道并告警）`)
  }
  if (!(sourceHipsHeightMeters > 0)) {
    warnings.push('无法确定 sourceHipsHeightMeters（Hips 位移缩放基准）——请让采样器写入该字段')
  } else if (sourceHipsHeightMeters > 3) {
    warnings.push(`sourceHipsHeightMeters=${sourceHipsHeightMeters} 偏大：疑似单位不是米（Max 单位可能为 cm）`)
  }

  return {
    name: 'biped',
    set: 'adv',
    rest: samples.rest,
    hipsBone,
    upBone,
    leftShoulderBone: skeleton.arms.left.clavicle,
    rightShoulderBone: skeleton.arms.right.clavicle,
    avatar: 'Avatar_AventurineW_00',
    sourceHeightMeters,
    sourceHipsHeightMeters,
    boneNext: skeleton.boneNext,
    expectedHumanoid: intendedBipedHumanoidNames(skeleton),
    resolveMapping: (vrmRest) => resolveBipedMapping(vrmRest, skeleton),
    skeleton,
    warnings
  }
}

/**
 * 手指赋值打分：5 条 Biped 指链（chain 0..4）→ 5 组 VRM 手指，用 rest 链方向（对齐后）求平均角差。
 * 环境无关、纯函数；mapping report 用它打印「按文档赋值」与「最优赋值」的分数。
 *
 * @param {any} source createBipedSource 结果
 * @param {any} vrmRest
 * @param {{ quat: number[] }} alignment
 */
export function scoreFingerAssignments(source, vrmRest, alignment) {
  const skeleton = source.skeleton
  const rest = source.rest
  const boneNext = source.boneNext
  const result = { left: null, right: null, chosenMeanDeg: null, bestMeanDeg: null, bestPermutation: null, thumbVsIndexDeg: null }
  const sideScores = {}
  for (const side of ['left', 'right']) {
    /** @type {number[][]} chain × vrmGroup 平均角差 */
    const scores = []
    for (const chain of [0, 1, 2, 3, 4]) {
      const links = skeleton.fingers[side][chain] ?? []
      const row = []
      for (const group of [0, 1, 2, 3, 4]) {
        const layout = BIPED_FINGER_LAYOUT[group]
        const angles = []
        for (let link = 0; link < 3; link += 1) {
          const sourceBone = links[link]
          const vrmName = `${side}${layout.vrm[link]}`
          const sourceDir = sourceBone ? bipedRestDirection(rest, sourceBone, boneNext) : null
          const targetDir = vrmRestDirection(vrmRest, vrmName)
          if (!sourceDir || !targetDir) continue
          angles.push(vecAngleDeg(targetDir, qRotateVec(alignment.quat, sourceDir)))
        }
        row.push(angles.length > 0 ? angles.reduce((a, b) => a + b, 0) / angles.length : 180)
      }
      scores.push(row)
    }
    // 枚举 120 个置换，找平均分最低（链 c → 组 perm[c]）
    let best = null
    const permutations = permute5()
    for (const permutation of permutations) {
      let sum = 0
      for (let chain = 0; chain < 5; chain += 1) sum += scores[chain][permutation[chain]]
      const mean = sum / 5
      if (!best || mean < best.mean) best = { permutation: permutation.slice(), mean }
    }
    const identity = [0, 1, 2, 3, 4]
    const chosenMean = identity.reduce((sum, group, chain) => sum + scores[chain][group], 0) / 5
    sideScores[side] = {
      chosenMeanDeg: round(chosenMean, 2),
      bestMeanDeg: round(best.mean, 2),
      bestPermutation: best.permutation,
      chosenIsBest: best.permutation.every((group, chain) => group === chain) || Math.abs(best.mean - chosenMean) < 0.01,
      thumbVsIndexDeg: round(scores[0][1], 2)
    }
  }
  result.left = sideScores.left
  result.right = sideScores.right
  result.chosenMeanDeg = round((sideScores.left.chosenMeanDeg + sideScores.right.chosenMeanDeg) / 2, 2)
  result.bestMeanDeg = round(Math.min(sideScores.left.bestMeanDeg, sideScores.right.bestMeanDeg), 2)
  result.bestPermutation = sideScores.left.bestPermutation
  result.thumbVsIndexDeg = round((sideScores.left.thumbVsIndexDeg + sideScores.right.thumbVsIndexDeg) / 2, 2)
  return result
}

function permute5() {
  const output = []
  const used = new Array(5).fill(false)
  const current = []
  const walk = () => {
    if (current.length === 5) {
      output.push(current.slice())
      return
    }
    for (let value = 0; value < 5; value += 1) {
      if (used[value]) continue
      used[value] = true
      current.push(value)
      walk()
      current.pop()
      used[value] = false
    }
  }
  walk()
  return output
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 生成 mapping report（CLI 写盘 + 报告用）：映射表、每根骨的对齐后 rest 方向差、
 * 指链赋值打分、命名匹配统计、缺失/忽略/告警。
 *
 * @param {{ source: any, vrmRest: any, alignment?: { quat: number[] } | null, samplesPath?: string }} args
 */
export function buildBipedMappingReport({ source, vrmRest, alignment = null, samplesPath = null }) {
  const mappingInfo = source.resolveMapping(vrmRest)
  const rows = []
  for (const [vrmName, sourceBone] of Object.entries(mappingInfo.mapping)) {
    const sourceDir = bipedRestDirection(source.rest, sourceBone, source.boneNext)
    const targetDir = vrmRestDirection(vrmRest, vrmName)
    const mappedSourceDir = sourceDir && alignment ? qRotateVec(alignment.quat, sourceDir) : null
    const mismatchDeg = targetDir && mappedSourceDir ? round(vecAngleDeg(targetDir, mappedSourceDir), 2) : null
    rows.push({
      vrmName,
      unityName: UNITY_NAME_BY_VRM[vrmName] ?? null,
      sourceBone,
      isFinger: /Thumb|Index|Middle|Ring|Little/.test(vrmName),
      restDirectionMismatchDeg: mismatchDeg
    })
  }
  const mismatchValues = rows.map((row) => row.restDirectionMismatchDeg).filter((value) => typeof value === 'number')
  const groupStats = {}
  for (const row of rows) {
    if (typeof row.restDirectionMismatchDeg !== 'number') continue
    const group = /UpperArm/.test(row.vrmName)
      ? 'upperArm'
      : /LowerArm/.test(row.vrmName)
        ? 'lowerArm'
        : /Hand$/.test(row.vrmName)
          ? 'hand'
          : row.isFinger
            ? 'fingers'
            : 'torsoLegs'
    const entry = (groupStats[group] ??= { count: 0, maxDeg: 0, sum: 0 })
    entry.count += 1
    entry.sum += row.restDirectionMismatchDeg
    entry.maxDeg = Math.max(entry.maxDeg, row.restDirectionMismatchDeg)
  }
  for (const entry of Object.values(groupStats)) {
    entry.meanDeg = round(entry.sum / entry.count, 2)
    entry.maxDeg = round(entry.maxDeg, 2)
    delete entry.sum
  }

  const prefixes = new Set()
  const sideStyles = new Set()
  const ignored = []
  const unknown = []
  for (const [name, info] of source.skeleton.bones) {
    if (info.prefix) prefixes.add(info.prefix.replace(/\d+$/, '') + '*')
    if (info.side) sideStyles.add(info.side)
    if (info.kind === 'ignored') ignored.push(name)
    if (info.kind === 'unknown') unknown.push(name)
  }

  const sourceNames = Object.keys(source.rest)
  const targetMissingHumanoid = ALL_HUMANOID_NAMES.filter(
    (name) => !vrmRest?.humanoid?.[name] && !(name === 'upperChest' && mappingInfo.upperChestFallback)
  )
  const expectedSet = new Set(source.expectedHumanoid ?? [])
  return {
    generatedAt: new Date().toISOString(),
    samples: samplesPath,
    source: {
      name: source.name,
      avatar: source.avatar,
      boneCount: sourceNames.length,
      humanoidSourceBones: source.skeleton.stats.humanoidSourceBones,
      fingerChains: source.skeleton.stats.fingerChains,
      hipsBone: source.hipsBone,
      upBone: source.upBone,
      leftShoulderBone: source.leftShoulderBone,
      rightShoulderBone: source.rightShoulderBone,
      sourceHeightMeters: source.sourceHeightMeters,
      sourceHipsHeightMeters: source.sourceHipsHeightMeters,
      boneNameStyles: { prefixes: [...prefixes], sides: [...sideStyles].sort() }
    },
    target: {
      avatarId: null,
      humanoidBones: Object.keys(vrmRest?.humanoid ?? {}).length,
      hasUpperChest: Boolean(vrmRest?.humanoid?.upperChest),
      hasFingers: ALL_HUMANOID_NAMES.filter((name) => /Thumb|Index|Middle|Ring|Little/.test(name)).every(
        (name) => Boolean(vrmRest?.humanoid?.[name])
      )
    },
    mapping: rows,
    mappingStats: {
      mappedBones: rows.length,
      missingOnTarget: targetMissingHumanoid.filter((name) => expectedSet.has(name)),
      targetHasButSourceMissing: mappingInfo.missing,
      sourceFingerLinksMissing: mappingInfo.fingerMissing.length,
      restDirectionMismatch: {
        maxDeg: mismatchValues.length > 0 ? round(Math.max(...mismatchValues), 2) : null,
        meanDeg: mismatchValues.length > 0 ? round(mismatchValues.reduce((a, b) => a + b, 0) / mismatchValues.length, 2) : null,
        groups: groupStats
      }
    },
    spine: {
      links: source.skeleton.spineLinks,
      slots: { spine: mappingInfo.spine.spine, chest: mappingInfo.spine.chest, upperChest: mappingInfo.spine.upperChest },
      merged: mappingInfo.spine.merged,
      upperChestFallback: mappingInfo.upperChestFallback,
      notes: mappingInfo.notes
    },
    neck: { links: source.skeleton.neckLinks, mapped: source.skeleton.neck },
    fingers: {
      layout: Object.fromEntries(
        Object.entries(BIPED_FINGER_LAYOUT).map(([chain, layout]) => [
          chain,
          { label: layout.label, vrm: layout.vrm, source: { left: source.skeleton.fingers.left[chain] ?? [], right: source.skeleton.fingers.right[chain] ?? [] } }
        ])
      ),
      assignment: alignment ? scoreFingerAssignments(source, vrmRest, alignment) : null,
      note: 'Finger0=拇指依据 Autodesk Biped Node Hierarchy link 顺序 + BipedPlus 骨表 + Avatar Toolkit 别名表；assignment 分数为实测 rest 方向复核'
    },
    ignoredBones: ignored,
    unsupportedBones: unknown,
    warnings: source.warnings ?? []
  }
}
