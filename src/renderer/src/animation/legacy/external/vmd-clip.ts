/**
 * 外部 VMD → `AnimationClip`（three 适配层，Wave 2.5 / D1）。
 *
 * 关键事实（`docs/research/vmd-preview-tool.md` §5，实测过的坑，不重复调研）：
 * - 用 `MMDLoader.loadVMD(url)` 读 `pet-asset://model/<单段文件名>`（协议已支持 .vmd，
 *   MIME octet-stream，CSP connect-src 已含 pet-asset:）；
 * - `MMDLoader.animationBuilder.build(vmd, mesh)` 把 VMD 转成绑定到本模型骨名的 `AnimationClip`；
 *   track 名形如 `.bones[センター].position` / `.bones[頭].quaternion`，**模型不存在的骨静默丢弃**；
 * - VMD 固定 30fps，时间 = `frameNum / 30`（MMDLoader 内部已处理，含贝塞尔插值）；
 * - VMD 的 `センター` position 已被 MMDLoader 加上 **构建时的 bone.position 基准**，
 *   所以 clip 里的 position 轨道是「构建瞬间的骨骼位置 + VMD 偏移」。B3 会实时写 `センター.position`，
 *   因此这里在 build 前抓一份 live 基准、用 PMX rest 位置（`geometry.userData.MMD.bones[].pos`）重挂，
 *   保证 clip 与 B3 当前姿态无关（否则会把 B3 的接地偏移烤进 VMD）；
 * - **in-place**：`センター`（以及 `グルーブ`/`全ての親` 若有轨道）的 X/Z 归零（只保留 Y bob，
 *   重心起伏是表演的一部分）；水平 root motion 交给 PetScene/B2，VMD 不负责位移；
 * - **IK**：r171 `MMDAnimationHelper` 不消费 VMD 的 IK on/off 开关段，只能整段用
 *   `helper.enable('ik', manifest.ik === 'on')`；`on` = 模型自带 4 根足ＩＫ 跑 CCDIK，
 *   `off` = 纯 FK（要求动作本身有 FK 腿轨道，否则腿会冻结）；
 * - **morph**：转换出的 VMD normally morph=0（Taunt/Idle 实测 0 条）；即使有 morph 轨道，
 *   D1 也**剥掉**（表情/眨眼/口型统一由 B3 驱动，避免双写冲突，见 anim-strategy §4 A5）。
 */

import { AnimationClip } from 'three'
import type { KeyframeTrack, SkinnedMesh } from 'three'
import type { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'

import { buildPetAssetUrl } from '../../../assets/pet-asset'
import type { IkMode, MotionClipDef } from './manifest'

/** MMD/VMD 固定帧率（VMD 文件里没有帧率字段，MMD 约定 30fps）。 */
export const VMD_FRAME_RATE = 30

/**
 * 单帧/静态 VMD（例如坐姿单帧）最短 clip 时长（秒）：让 Mixer 有可循环的时间轴，
 * 首帧姿势恒定；配合 manifest `microSway` 可让静态姿势有轻微呼吸摆动，避免像冻结。
 */
export const MIN_STATIC_CLIP_DURATION_SEC = 0.2

/** in-place 归零水平位移的根位移骨（`センター` 必须；另两根有轨道时一并处理）。 */
export const ROOT_MOTION_BONES: readonly string[] = ['センター', 'グルーブ', '全ての親']

/** `.bones[<骨名>].position|quaternion`。 */
const BONE_TRACK_PATTERN = /^\.bones\[(.+)\]\.(position|quaternion)$/

/** 加载/处理后的外部 VMD clip 元信息（`vmd-driver` 消费）。 */
export interface VmdClipInfo {
  /** 清单里的 clip 定义（id/moods/ik/loop/速度等）。 */
  def: MotionClipDef
  /** 已处理（in-place + 剥 morph）的 three `AnimationClip`；直接交给 `MMDAnimationHelper.add`。 */
  clip: AnimationClip
  /** 实际加载 URL（`pet-asset://model/<file>`）。 */
  url: string
  /** clip 时长（秒）。 */
  durationSec: number
  /** 帧率（固定 30）。 */
  frameRate: number
  /** 帧数（≈ duration × 30）。 */
  frameCount: number
  /** 最终 track 数。 */
  trackCount: number
  /** 骨骼 track 数（应为「有轨道的骨数 × 2」，position + quaternion）。 */
  boneTrackCount: number
  /** 被剥掉的 VMD morph track 数（D1 恒由 B3 管表情）。 */
  strippedMorphTrackCount: number
  /** 被 `suppressBones` 剔除的骨骼 track 数（脚趾等）。 */
  suppressedTrackCount: number
  /** 处理时 live 基准与 rest 基准不同的 position track 数（正常应只有 センター；排障用）。 */
  rebasedPositionTrackCount: number
  /** 是否做了 in-place（X/Z 归零）。 */
  inPlace: boolean
  /** IK 模式（manifest 决定，运行时用 `setHelperIkMode` 开关 helper）。 */
  ik: IkMode
}

/** `loadVmdClip` 选项（测试可注入 loader/url；默认走真实 MMDLoader + pet-asset URL）。 */
export interface LoadVmdClipOptions {
  /** 复用 loader（默认每次 new MMDLoader；同一实例可并发 loadVMD 不同文件）。 */
  loader?: MMDLoader
  /** 覆盖 URL（单测用；默认 buildPetAssetUrl(def.file)）。 */
  url?: string
  /** 是否把 root motion X/Z 归零（默认 true）。 */
  inPlace?: boolean
  /** 是否剥掉 morph 轨道（默认 true；VMD 表情交给 B3）。 */
  stripMorphTracks?: boolean
}

/** `MMDLoader.animationBuilder` 的 @types/three 声明是 object，这里收窄到实际用到的接口。 */
interface MmdAnimationBuilderLike {
  build(vmd: object, mesh: SkinnedMesh): AnimationClip
}

/** `geometry.userData.MMD.bones` 元素（MMDLoader 写入；pos 是相对父骨的 rest 位置）。 */
interface MmdBoneRestLike {
  name?: string
  pos?: readonly number[]
}

interface MmdGeometryLike {
  userData?: { MMD?: { bones?: readonly MmdBoneRestLike[] } }
}

type LocalPosition = readonly [number, number, number]

/** 把任意异常/错误事件规整成 Error（保证 Promise reject 语义统一）。 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return new Error(message)
  }
  return new Error(String(error))
}

/**
 * 创建一个「单 clip 加载器」（共享同一个 MMDLoader；`vmd-driver` 预加载/按需加载共用）。
 * 返回函数是 fire-and-forget 友好的：不抛同步错误，失败通过 rejected Promise 交给调用方。
 */
export function createVmdClipLoader(
  mesh: SkinnedMesh,
  options: Omit<LoadVmdClipOptions, 'loader' | 'url'> = {}
): (def: MotionClipDef) => Promise<VmdClipInfo> {
  const loader = new MMDLoader()
  return (def: MotionClipDef) => loadVmdClip(mesh, def, { ...options, loader })
}

/**
 * 加载并处理一条 VMD clip（异步；**不要**在帧循环里 await，`vmd-driver` 只 fire-and-forget）。
 *
 * 失败（网络/解析/无轨道）→ reject Error，由 `vmd-driver` 捕获后回退 B3，不向上抛。
 */
export function loadVmdClip(
  mesh: SkinnedMesh,
  def: MotionClipDef,
  options: LoadVmdClipOptions = {}
): Promise<VmdClipInfo> {
  const loader = options.loader ?? new MMDLoader()
  const url = options.url ?? buildPetAssetUrl(def.file)

  return new Promise<VmdClipInfo>((resolve, reject) => {
    try {
      loader.loadVMD(
        url,
        (vmd) => {
          try {
            resolve(processVmdData(vmd, mesh, def, url, loader, options))
          } catch (error) {
            reject(toError(error))
          }
        },
        undefined,
        (error) => reject(toError(error))
      )
    } catch (error) {
      reject(toError(error))
    }
  })
}

/**
 * 同步处理已解析的 VMD 数据（`loadVmdClip` 的核心；Node 单测可直接调用，不需要 WebGL）。
 *
 * 顺序：抓 live/rest 基准 → build clip → position 基准重挂 + in-place X/Z 归零 → 剥 morph →
 * 重建 clip（duration 由剩余轨道决定）→ 元信息。
 */
export function processVmdData(
  vmd: object,
  mesh: SkinnedMesh,
  def: MotionClipDef,
  url: string,
  loader?: MMDLoader,
  options: LoadVmdClipOptions = {}
): VmdClipInfo {
  const builder = (loader?.animationBuilder ?? new MMDLoader().animationBuilder) as
    | MmdAnimationBuilderLike
    | undefined
  if (!builder || typeof builder.build !== 'function') {
    throw new Error('MMDLoader.animationBuilder 不可用，无法把 VMD 转成 AnimationClip')
  }

  // build 会把「当前 bone.position」烤进 position 轨道：B3 可能正在写 センター.position，
  // 所以先抓 live 基准，build 后统一换成 PMX rest 基准（保证 clip 与 B3 姿态无关）。
  const liveBase = captureLiveBonePositions(mesh)
  const restBase = readRestBonePositions(mesh)

  const rawClip = builder.build(vmd, mesh)
  if (!rawClip || !Array.isArray(rawClip.tracks) || rawClip.tracks.length === 0) {
    throw new Error(`VMD ${def.file} 没有可用骨骼轨道（骨名与模型不匹配？）`)
  }

  const inPlace = options.inPlace !== false
  const stripMorphTracks = options.stripMorphTracks !== false
  const suppressed = new Set((def.suppressBones ?? []).map((name) => name.trim()))
  const tracks: KeyframeTrack[] = []
  let strippedMorphTrackCount = 0
  let rebasedPositionTrackCount = 0
  let suppressedTrackCount = 0

  for (const track of rawClip.tracks) {
    if (track.name.includes('.morphTargetInfluences')) {
      strippedMorphTrackCount += 1
      if (stripMorphTracks) continue
    }
    const match = BONE_TRACK_PATTERN.exec(track.name)
    if (match && suppressed.has(match[1]!)) {
      suppressedTrackCount += 1
      continue
    }
    if (match && match[2] === 'position') {
      if (rebasePositionTrack(track, match[1]!, liveBase, restBase, inPlace)) {
        rebasedPositionTrackCount += 1
      }
    }
    tracks.push(track)
  }

  // 重建 clip：duration=-1 由轨道最大时间自动算（过滤轨道后必须重算）。
  const clip = new AnimationClip(def.id, -1, tracks)
  clip.resetDuration()
  let durationSec = clip.duration
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    // 单帧静态姿势（例如坐姿单帧）：给 Mixer 一个最短循环时长，姿势保持首帧不变。
    durationSec = MIN_STATIC_CLIP_DURATION_SEC
    clip.duration = durationSec
  }

  const boneTrackCount = tracks.reduce(
    (count, track) => (BONE_TRACK_PATTERN.test(track.name) ? count + 1 : count),
    0
  )

  return {
    def,
    clip,
    url,
    durationSec,
    frameRate: VMD_FRAME_RATE,
    frameCount: Math.max(1, Math.round(durationSec * VMD_FRAME_RATE)),
    trackCount: tracks.length,
    boneTrackCount,
    strippedMorphTrackCount,
    suppressedTrackCount,
    rebasedPositionTrackCount,
    inPlace,
    ik: def.ik
  }
}

/**
 * 用 `helper.enable('ik', ...)` 设定整段 clip 的 IK 模式（r171 不支持逐帧 IK 开关）。
 * 返回最终是否启用（便于调试快照记录）。
 */
export function setHelperIkMode(
  helper: Pick<MMDAnimationHelper, 'enable'>,
  mode: IkMode | null | undefined
): boolean {
  const enabled = mode !== 'off'
  helper.enable('ik', enabled)
  return enabled
}

/** 抓 build 前各骨 `bone.position`（模型局部；用于抵消 build 时被烤进 position 轨道的基准）。 */
function captureLiveBonePositions(mesh: SkinnedMesh): Map<string, LocalPosition> {
  const result = new Map<string, LocalPosition>()
  const bones = mesh?.skeleton?.bones ?? []
  for (const bone of bones) {
    if (!bone) continue
    const position = bone.position
    if (!position) continue
    result.set(bone.name, [position.x, position.y, position.z])
  }
  return result
}

/** 从 `geometry.userData.MMD.bones` 读 PMX rest 位置（MMDLoader 写入、与 bind pose 一致）。 */
function readRestBonePositions(mesh: SkinnedMesh): Map<string, LocalPosition> {
  const result = new Map<string, LocalPosition>()
  const userData = (mesh?.geometry as unknown as MmdGeometryLike | undefined)?.userData
  const bones = userData?.MMD?.bones ?? []
  for (const bone of bones) {
    if (!bone || typeof bone.name !== 'string') continue
    const pos = bone.pos
    if (!Array.isArray(pos) || pos.length < 3) continue
    if (!pos.every((value) => Number.isFinite(value))) continue
    result.set(bone.name, [pos[0]!, pos[1]!, pos[2]!])
  }
  return result
}

/**
 * 重挂一条 position 轨道的基准，并按需把根位移骨 X/Z 归零。
 * 返回 true = 该轨道被重挂（live 与 rest 基准不同），用于调试统计。
 *
 * 公式：`轨道值 = build 时基准 + VMD 偏移` → `新值 = rest 基准 + VMD 偏移`；
 * in-place 根位移骨再强制 X/Z = rest（Y 保留 bob）。
 */
function rebasePositionTrack(
  track: KeyframeTrack,
  boneName: string,
  liveBase: Map<string, LocalPosition>,
  restBase: Map<string, LocalPosition>,
  inPlace: boolean
): boolean {
  const values = track.values
  if (!values || values.length < 3) return false
  const live = liveBase.get(boneName)
  const rest = restBase.get(boneName) ?? live
  if (!rest) return false

  const zeroHorizontal = inPlace && ROOT_MOTION_BONES.includes(boneName)
  const liveX = live ? live[0] : rest[0]
  const liveY = live ? live[1] : rest[1]
  const liveZ = live ? live[2] : rest[2]

  for (let index = 0; index + 2 < values.length; index += 3) {
    const rawX = values[index]!
    const rawY = values[index + 1]!
    const rawZ = values[index + 2]!
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawZ)) continue
    const offsetX = rawX - liveX
    const offsetY = rawY - liveY
    const offsetZ = rawZ - liveZ
    values[index] = zeroHorizontal ? rest[0] : rest[0] + offsetX
    values[index + 1] = rest[1] + offsetY // 保留 センター Y bob（重心起伏）
    values[index + 2] = zeroHorizontal ? rest[2] : rest[2] + offsetZ
  }
  // 「是否重挂」= build 时 live 基准与 PMX rest 基准不同（正常只有被 B3 实时写 position 的 センター）。
  return liveX !== rest[0] || liveY !== rest[1] || liveZ !== rest[2]
}
