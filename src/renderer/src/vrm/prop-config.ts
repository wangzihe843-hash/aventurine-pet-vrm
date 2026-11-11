/**
 * 手持道具（V1 水枪）—— 挂载配置 / 持握规则 / clip 元数据解析（**纯函数，无 three/DOM**）。
 *
 * 数据流（V1）：
 *   `watergun-attach.json`（校准值 + clip 持枪规则）
 *     → `prop-layer.ts` 加载 GLB 并挂到 VRM rightHand
 *     → `animator.ts` 每帧把当前 clip id 交给 `shouldHoldHandProp()`
 *     → 只切 `visible`，不写骨（道具是 hand 子节点，跟随 humanoid 动画）。
 *
 * 规则（2026-11-09 task-5 更新为数据驱动白名单）：
 *   对全量 138 个 `_skel.fbx` 做武器骨探针（武器骨相对右手是否跨帧刚性恒定），
 *   只有 7 个 clip 的源动画真的把枪固定在右手（skill01 家族/普攻 ready/transition + mazeattack01）；
 *   官方实机逐帧对拍也确认「只有普攻全程持枪，终结技/秘技/欢愉技等过场技能手中无枪」。
 *   因此：
 *   - `holdClipIds` 为 **app catalog id 白名单（adv- 前缀）**，**非空时独占**：
 *     命中 → true，未命中 → false（不再回落 set+tags，避免「skill tag 全持枪」误伤过场技能）；
 *   - 白名单全空时退回 `holdSets` + `holdTags` 兜底规则（现行 adv+skill）；
 *   - 三者全空时用 DEFAULT（adv+skill）。
 *   证据：`docs/research/watergun-adv-integration.md` §2/§6。
 *
 * 私有资产约定：道具 GLB 在 `assets/props/**`（gitignore），仅本机开发，禁止二次配布/商用。
 */
import rawWatergunAttach from './watergun-attach.json'

/** 一条 clip 的道具判定所需元信息（来自 `assets/motions/app-catalog.json`）。 */
export interface HandPropClipMeta {
  /** clip id（catalog 唯一 id，如 `adv-skill01`）。 */
  id: string
  /** 动作集（`adv` / `hsr` / `mate` …）。 */
  set: string
  /** 语义标签（`skill` / `show` / `idle` …）。 */
  tags: readonly string[]
}

/** 持枪规则：`clipIds` 白名单非空时独占；否则用 set + tags 兜底。 */
export interface HandPropClipPolicy {
  /** 动作集白名单（`adv` …）——clipIds 为空时生效。 */
  set: readonly string[]
  /** 语义标签白名单（`skill` …）——clipIds 为空时生效。 */
  tags: readonly string[]
  /** app catalog clip id 白名单（如 `adv-skill01`）；**非空时独占**（命中=true，未命中=false）。 */
  clipIds: readonly string[]
}

/** 道具 bbox 尺度校验（米；防止来源/单位错误导致巨大或不可见的道具）。 */
export interface HandPropBounds {
  minLengthMeters: number
  maxLengthMeters: number
  expectedLengthMeters: number
}

/** 道具挂载配置（进入运行时前已 sanitize）。 */
export interface HandPropConfig {
  schemaVersion: number
  propId: string
  /** assets 根相对路径（`pet-asset://assets/<file>`）。 */
  file: string
  /** 挂到 VRM normalized humanoid 骨名（默认 rightHand）。 */
  bone: string
  /** 相对 hand 骨的局部位置（米）。 */
  position: readonly [number, number, number]
  /** 相对 hand 骨的局部旋转（xyzw）。 */
  quaternion: readonly [number, number, number, number]
  scale: number
  bounds: HandPropBounds
  policy: HandPropClipPolicy
}

/** 规则兜底：宁可不显示，也不要在空手动作里突然举枪。 */
export const DEFAULT_HAND_PROP_POLICY: HandPropClipPolicy = Object.freeze({
  set: Object.freeze(['adv']) as readonly string[],
  tags: Object.freeze(['skill']) as readonly string[],
  clipIds: Object.freeze([]) as readonly string[]
})

const BONE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFiniteTuple(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(isFiniteNumber)
}

function clonePolicy(raw: unknown): HandPropClipPolicy {
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const readList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  return {
    set: readList(source.set ?? source.holdSets),
    tags: readList(source.tags ?? source.holdTags),
    clipIds: readList(source.clipIds ?? source.holdClipIds)
  }
}

/**
 * 校验并归一化 `watergun-attach.json`；非法字段返回 null（调用方降级为「不加载道具」）。
 * 数值规则：四元数归一化、scale 必须为正、bounds 合法正数。
 */
export function sanitizeHandPropConfig(raw: unknown): HandPropConfig | null {
  if (raw === null || typeof raw !== 'object') return null
  const source = raw as Record<string, unknown>
  const file = typeof source.file === 'string' ? source.file : ''
  const bone = typeof source.bone === 'string' ? source.bone : 'rightHand'
  const position = source.position
  const quaternion = source.quaternion
  const scale = isFiniteNumber(source.scale) ? source.scale : 1
  const boundsRaw = (source.bounds ?? {}) as Record<string, unknown>
  if (!FILE_PATTERN.test(file)) return null
  if (!BONE_PATTERN.test(bone)) return null
  if (!isFiniteTuple(position, 3)) return null
  if (!isFiniteTuple(quaternion, 4)) return null
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const length = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3])
  if (!(length > 1e-6)) return null
  const minLength = boundsRaw.minLengthMeters
  const maxLength = boundsRaw.maxLengthMeters
  const expectedLength = boundsRaw.expectedLengthMeters
  if (!isFiniteNumber(minLength) || !isFiniteNumber(maxLength) || !isFiniteNumber(expectedLength)) return null
  if (!(minLength > 0) || !(maxLength > minLength)) return null
  return {
    schemaVersion: isFiniteNumber(source.schemaVersion) ? source.schemaVersion : 1,
    propId: typeof source.propId === 'string' && source.propId.length > 0 ? source.propId : 'hand-prop',
    file,
    bone,
    position: [position[0], position[1], position[2]] as const,
    quaternion: [quaternion[0] / length, quaternion[1] / length, quaternion[2] / length, quaternion[3] / length] as const,
    scale,
    bounds: { minLengthMeters: minLength, maxLengthMeters: maxLength, expectedLengthMeters: expectedLength },
    policy: clonePolicy(source.policy)
  }
}

/**
 * 当前 clip 是否应显示手持道具（数据驱动白名单，2026-11-09 task-5 更新）。
 *
 * 规则优先级：
 * 1. `clipIds` 非空 → **独占白名单**：`clipIds.includes(clip.id)` 即结果（不再回落 set/tags；
 *    防止 adv+skill 兜底把「过场技能」误判为持枪）。
 * 2. `clipIds` 为空 → 退回 `set` + `tags` 兜底：set 命中且 tags 有交集 → true；其余 false。
 *    任一维度为空 = 该维度不限制。
 * 3. 三者全空 → 用 DEFAULT_HAND_PROP_POLICY（adv + skill）。
 *
 * 任意非法/缺失 clip → false（道具隐藏，失败安全）。
 */
export function shouldHoldHandProp(
  clip: HandPropClipMeta | null | undefined,
  policy: HandPropClipPolicy = DEFAULT_HAND_PROP_POLICY
): boolean {
  if (!clip) return false
  const effective =
    policy.set.length === 0 && policy.tags.length === 0 && policy.clipIds.length === 0 ? DEFAULT_HAND_PROP_POLICY : policy
  if (effective.clipIds.length > 0) return effective.clipIds.includes(clip.id)
  if (effective.set.length > 0 && !effective.set.includes(clip.set)) return false
  if (effective.tags.length > 0 && !effective.tags.some((tag) => clip.tags.includes(tag))) return false
  return true
}

/** 从 catalog JSON 文本解析 clip id → 元信息映射；坏数据/缺字段的条目跳过。 */
export function parseClipMetaCatalog(text: string): Map<string, HandPropClipMeta> {
  const map = new Map<string, HandPropClipMeta>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return map
  }
  const clips = (parsed as { clips?: unknown } | null)?.clips
  if (!Array.isArray(clips)) return map
  for (const clip of clips) {
    if (clip === null || typeof clip !== 'object') continue
    const entry = clip as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    map.set(entry.id, {
      id: entry.id,
      set: typeof entry.set === 'string' ? entry.set : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : []
    })
  }
  return map
}

/** clip id → 元信息解析器（catalog 加载失败返回恒 null，道具保持隐藏）。 */
export type HandPropClipMetaResolver = (clipId: string | null | undefined) => HandPropClipMeta | null

/** 拉取并解析 `app-catalog.json`（失败只 warn，返回恒 null 解析器，不抛）。 */
export async function loadHandPropClipCatalog(options: {
  url: string
  fetchText?: (url: string) => Promise<string>
  warn?: (message: string, error?: unknown) => void
}): Promise<HandPropClipMetaResolver> {
  const fetchText = options.fetchText ?? ((url: string) => fetch(url).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.text()
  }))
  try {
    const text = await fetchText(options.url)
    const map = parseClipMetaCatalog(text)
    return (clipId) => (typeof clipId === 'string' && clipId.length > 0 ? map.get(clipId) ?? null : null)
  } catch (error) {
    options.warn?.(`hand-prop catalog 加载失败，道具保持隐藏：${options.url}`, error)
    return () => null
  }
}

/** 应用内使用的水枪配置（非法 JSON 时为 null → 不加载道具）。 */
export const WATERGUN_PROP_CONFIG: HandPropConfig | null = sanitizeHandPropConfig(rawWatergunAttach)
