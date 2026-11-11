/**
 * VRM humanoid clip 播放器（V1 运行时，Wave 2 / clip-engine）
 *
 * 实现冻结接口 `VrmClipPlayer`（`vrm/runtime-types.ts`，Lead-owned）：
 * - `init()`：初始化注册表（app-manifest/app-catalog + 预载常用 clip）；失败只降级不抛；
 * - `update(input)`：按 `input.events` / `input.mood` / `input.dragging` 选 clip →
 *   推进时间 → 交叉淡入 → 写 normalized humanoid 骨（quaternion + Hips position）→
 *   `humanoid.update()`（**每帧末尾由本 player 负责**；animator 的 look-at 之后会再调一次）→ 贴地测量；
 * - `playClipById()` / `setMoodOverride()` / `snapshot()` / `dispose()`。
 *
 * 关键口径（`docs/wave2-vrm-runtime-design.md` §2.2/§4.2、`docs/vrm-motion-hsr.md` §2/§7）：
 * - clip 的 `r` 是**相对 rest 的 normalized 局部旋转**，直接写到
 *   `humanoid.getNormalizedBoneNode(vrmName).quaternion`；clip 未覆盖的骨回 rest
 *   （构造时从 normalized 节点快照）；
 * - `Hips.p` 缩放 = `avatar.hipsRestHeight / clip.sourceHipsHeight`，加到 normalized hips 的
 *   rest position 上（见 `scripts/unity-bake/clip-viewer.js` L440–470）；
 * - `rawPolicy=spring`：**不写 raw 节点**（头发/衣摆由 three-vrm SpringBone 在 `vrm.update(dt)`
 *   内驱动）；本文件只认 normalized 骨；
 * - 贴地：`grounding==='feet'` 的 clip 用**首帧最低脚骨世界 y（相对 avatar.scene 局部坐标）**
 *   算一个 per-clip 常量补偿写回 hips 的 y（**不做每帧硬钳**，避免走路脚粘地）；
 *   `grounding==='none'`（含 mate 数据暂未标注的 clip）不补偿、`footErrorPx=null`；
 * - 交叉淡入：per-bone 短弧 slerp + Hips 位置 lerp，权重用 smoothstep；时长取
 *   `新 clip.fadeInSec` / `旧 clip.fadeOutSec`，无数据时默认 0.2s；
 * - upperChest 兼容：目标模型缺该骨时按 VRMA 规则做 α-fold（`upper-chest-fold.ts`），
 *   把 `UpperChest` 轨道折叠进 chest / neck / 左右 shoulder，不静默丢弃；
 * - 失败降级：清单/clip 缺失或坏 JSON 只 warn 一次，保持当前动作或静态 rest，不抛。
 *
 * 红线：不写 `avatar.scene` / 场景 root 的 position/rotation/scale（摆放/朝向归场景层）；
 * 不 import three 的渲染对象，只用运行时 `Vector3` 做坐标换算。
 */
import { PET_MOODS, type PetMood } from '@shared/types'
import { Vector3, type Object3D } from 'three'

import type { AnimationClipEntry } from '@shared/animation-contract'

import type { AnimationEvent, AnimationInput } from '../core/wave2-contract'
import {
  clipDurationSec,
  isBoneTrackNonIdentity,
  sampleBoneRotation,
  sampleScaledHipsPosition,
  slerpQuat,
  smoothstep,
  type ParsedClip,
  type Quat4,
  type Vec3
} from './clip-data'
import {
  ClipRegistry,
  type ClipRegistryOptions,
  type PlayableClipEntry
} from './clip-registry'
import {
  CLIP_BONE_NAMES,
  UNITY_TO_VRM_BONE,
  resolveVrmBoneFallback,
  type UnityHumanoidBone,
  type VrmBoneName
} from './humanoid-map'
import {
  UPPER_CHEST_FOLD_ALPHA,
  foldUpperChest,
  isIdentityQuat,
  multiplyQuat
} from './upper-chest-fold'
import type {
  CreateVrmClipPlayerOptions,
  VrmClipDebugSnapshot,
  VrmClipPlayer as VrmClipPlayerContract
} from './runtime-types'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 默认交叉淡入时长（秒；清单没给 fade 时兜底）。 */
export const DEFAULT_CROSSFADE_SEC = 0.2
/** 单帧最大 dt（秒；与 B3/场景层同口径，防止掉帧时跨度过大）。 */
const MAX_FRAME_DT_SEC = 0.1
/* ------------------------------ 多动作变体切换（随机 + 自然间隔/淡入） ------------------------------ */

/** 秒数区间（闭区间内随机均匀取样）。 */
export interface SecondsRange {
  min: number
  max: number
}

/**
 * 单个槽位的「一个状态对应多个动作」随机轮换配置。
 *
 * 参考成熟桌宠 Mate-Engine `AvatarAnimatorController.cs`
 * （`IDLE_SWITCH_TIME=12s / IDLE_TRANSITION_TIME=3s`、dance `15s / 2s`）：
 * 多展示动作之间隔一段时间自然切换；这里用 per-bone slerp 近似状态机过渡：
 * - idle/sit：间隔长、淡入长（0.8–1.0s）→ 缓慢自然过渡，不易察觉；
 * - walk：间隔短、淡入短（0.25–0.35s）→ 步态变体切换不拖沓；
 * - sleep：不轮换（长循环单人睡觉动作）；
 * - 其它 multi-clip 槽位（pat/climb/fall/dsh*…）用 `default` 兜底。
 */
export interface VariantSwitchConfig {
  /** 轮换间隔（秒，随机均匀）；null = 不轮换。 */
  intervalSec: SecondsRange | null
  /** 变体切换 crossfade 时长（秒，随机均匀）。 */
  fadeSec: SecondsRange
  /** 循环 clip 在变体切换时随机起始相位（避免所有循环同相位）。 */
  randomPhase: boolean
  /** 排除最近 N 个变体（1 = 只排除当前；2 = 再排除上一个，避免近期重复）。 */
  avoidRecent: number
  /** 是否按 priority 加权（默认均匀；true = priority 越高被选概率越大）。 */
  weightedByPriority: boolean
}

/** 多动作状态默认变体切换配置（键 = PetMood；缺省用 `default`）。可被 tuning 覆盖。 */
export const VARIANT_SWITCH_CONFIG: Readonly<Record<string, VariantSwitchConfig>> = Object.freeze({
  idle: {
    intervalSec: { min: 12, max: 20 },
    fadeSec: { min: 0.8, max: 1 },
    randomPhase: true,
    avoidRecent: 2,
    weightedByPriority: false
  },
  sit: {
    intervalSec: { min: 15, max: 30 },
    fadeSec: { min: 0.8, max: 1 },
    randomPhase: true,
    avoidRecent: 2,
    weightedByPriority: false
  },
  walk: {
    intervalSec: { min: 10, max: 18 },
    fadeSec: { min: 0.25, max: 0.35 },
    randomPhase: true,
    avoidRecent: 1,
    weightedByPriority: false
  },
  sleep: {
    intervalSec: null,
    fadeSec: { min: 0.2, max: 0.25 },
    randomPhase: false,
    avoidRecent: 1,
    weightedByPriority: false
  },
  /**
   * 拖拽：一次拖拽会话内不轮换（避免拖到一半男女版动作切换）；男女版随机发生在
   * `selectBaseClip` 进入 drag 槽位时（见 `pickInitialEntry`）。
   */
  drag: {
    intervalSec: null,
    fadeSec: { min: 0.2, max: 0.35 },
    randomPhase: false,
    avoidRecent: 1,
    weightedByPriority: false
  },
  default: {
    intervalSec: { min: 12, max: 24 },
    fadeSec: { min: 0.3, max: 0.5 },
    randomPhase: true,
    avoidRecent: 2,
    weightedByPriority: false
  }
})

/** 解析槽位对应的变体切换配置（未知槽位 → `default`）。 */
export function variantSwitchConfigFor(slot: string): VariantSwitchConfig {
  return Object.prototype.hasOwnProperty.call(VARIANT_SWITCH_CONFIG, slot)
    ? VARIANT_SWITCH_CONFIG[slot]
    : VARIANT_SWITCH_CONFIG.default
}

/** 单个槽位的变体切换参数覆盖（字段省略 = 用 `VARIANT_SWITCH_CONFIG` 默认值）。 */
export type VariantSwitchConfigOverride = Partial<VariantSwitchConfig>

/**
 * `VrmClipPlayer` 可调参数（不改变冻结的 `CreateVrmClipPlayerOptions`；
 * 通过 `new VrmClipPlayer(options, tuning)` / `createVrmClipPlayer(options, tuning)` 传入）。
 */
export interface VrmClipPlayerTuning {
  /** 按槽位覆盖变体切换参数（键 = PetMood/槽位名，或 `default`）。 */
  variantSwitch?: Record<string, VariantSwitchConfigOverride>
  /** 稀有权重覆盖（见 `RARE_VARIANT_PRIORITY_THRESHOLD` / `RARE_VARIANT_WEIGHT`）。 */
  rareVariant?: {
    /** priority ≤ 该值的变体视为「稀有」（默认 -7）。 */
    priorityThreshold?: number
    /** 稀有变体相对权重（普通变体 = 1；默认 0.3）。 */
    weight?: number
  }
}

/**
 * 稀有权重：priority ≤ 该值的变体（如 idle 的 pose1-3 展示动作）只以更低权重参与随机轮换，
 * 避免低优先级但均匀随机的变体出现过于频繁。普通变体权重 = 1，稀有变体 = `RARE_VARIANT_WEIGHT`。
 */
export const RARE_VARIANT_PRIORITY_THRESHOLD = -7

/** 稀有变体相对权重（普通变体 = 1；0.3 → 3 条 pose 在 idle 池中 ≈ 7% 概率/次轮换）。 */
export const RARE_VARIANT_WEIGHT = 0.3
/** 走路类播放速率钳制区间（与 v1 legacy D3 一致）。 */
const MIN_PLAYBACK_RATE = 0.5
const MAX_PLAYBACK_RATE = 1.6
/**
 * 自然步速（体高/秒）：v1 legacy 的 walk VMD 实测 ≈470px/s @540px 高 ≈ 0.87 体高/秒
 * （见 `src/renderer/src/animation/legacy/external/selection.ts`）。
 * walk/climb 槽位用「当前移动速度 / 该尺寸下的自然步速」匹配 playbackRate。
 */
const NATURAL_WALK_SPEED_HEIGHT_FACTOR = 0.87
/** 脚骨集合（feet 贴地测量；世界坐标最低者视为触地点）。 */
const FOOT_BONE_NAMES = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const
/**
 * upperChest 缺失时，VRMA 兼容规则要求折叠到的直接子骨（Unity 名）。
 * 折叠公式见 `upper-chest-fold.ts`（α-fold；任意 α 下子骨世界朝向精确恢复）。
 */
const UPPER_CHEST_FOLD_CHILD_BONES: ReadonlySet<UnityHumanoidBone> = new Set([
  'Neck',
  'LeftShoulder',
  'RightShoulder'
])
/**
 * pose grounding 兜底的每 clip 采样帧数上限（V5：坐/睡/躺等非站立 clip 用姿态最低骨贴地）。
 * 采样均匀覆盖整段 clip（≤16 帧），取所有 raw humanoid 骨的最低世界 y 作常量偏移。
 */
const POSE_GROUND_MAX_SAMPLES = 16
/**
 * 待机变体轮换的最低 priority：低于该值的 clip（如 build-app-manifest 特意降到 -10 以下的
 * 窗沿躺 `sitWindow`/`windowLay*`）只作特殊动作按 id 播放，不参与 mood 的变体轮换
 * （否则坐着时会轮换出「窗沿躺」横躺动画）。
 */
const VARIANT_ROTATION_MIN_PRIORITY = -9
/** 不参与 pose grounding 的槽位（拖拽由 B2 抬着，不能吸地）。 */
const GROUND_EXCLUDED_SLOTS: ReadonlySet<string> = new Set(['drag'])
/** 交叉淡入的「无前一条 clip」兜底起点（rest 四元数）。 */
const IDENTITY_QUAT: Quat4 = [0, 0, 0, 1]

/** 一次性事件优先级（沿用 v1 legacy `EVENT_PRIORITY`：thrown > landed > dragStart > pat > dragEnd > poke）。 */
const EVENT_PRIORITY: Readonly<Record<AnimationEvent['kind'], number>> = {
  thrown: 50,
  landed: 40,
  dragStart: 30,
  pat: 20,
  dragEnd: 15,
  poke: 10
}

/**
 * 事件 → 优先尝试的 clip id（catalog 里的 app 层 id = `<set>-<clip>`）。
 * 只作为「首选」；缺失时按 tag 回退（见 `EVENT_TAG_FALLBACK`）。
 * dragStart/dragEnd 是状态事件：由 `dragging` + mood=drag 驱动基础姿态，不播一次性 clip。
 */
const EVENT_CLIP_IDS: Readonly<Record<AnimationEvent['kind'], readonly string[]>> = {
  pat: ['mate-happy', 'mate-laughing', 'mate-shyPoint'],
  poke: ['hsr-hitL'],
  thrown: ['hsr-stun'],
  landed: ['hsr-revive', 'hsr-hitL'],
  dragStart: [],
  dragEnd: []
}

/** 事件 → catalog tag 回退（只接受「非循环 + 无 mood 绑定」的一次性片段）。 */
const EVENT_TAG_FALLBACK: Partial<Record<AnimationEvent['kind'], string>> = {
  pat: 'interaction',
  poke: 'react',
  thrown: 'react',
  landed: 'react'
}

/* -------------------------------------------------------------------------- */
/* 内部状态类型                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 贴地模式（V5）：
 * - `feet`：clip 显式 `grounding:'feet'` → 首帧脚骨对齐 rest 脚骨（站立/走路）；
 * - `pose`：clip JSON 未标注 grounding（mate 集）→ 姿态最低骨兜底贴地（坐/睡/躺）；
 * - `none`：显式 `grounding:'none'`（数据标记不贴地）或排除槽位（drag）→ 不补偿。
 */
type GroundMode = 'feet' | 'pose' | 'none'

/** 正在播放的 clip 状态。 */
interface ActiveClipState {
  id: string
  /** 当前播放条目（`loop` 可能被 playClipById 覆盖）。 */
  entry: PlayableClipEntry
  /** 采样用 clip（`loop` 已按条目不变量覆盖；Float64Array 与源数据共享）。 */
  sampledClip: ParsedClip
  /** 清单/目录里的原始 clip（贴地/缺骨缓存的键，保持对象身份稳定）。 */
  sourceClip: ParsedClip
  /** 槽位：mood / salute / 事件名 / `manual`。 */
  slot: string
  timeSec: number
  /** 是否一次性事件 clip（播完回 mood）。 */
  oneShot: boolean
  /** 是否调试手动 clip（优先级最高，不被 mood/事件打断）。 */
  manual: boolean
  /** 非 loop clip 播完后是否停在末帧（debug hold）。 */
  hold: boolean
  /** 是否已播到末尾。 */
  finished: boolean
  /** 事件优先级（一次性 clip 用；普通 mood clip = 0）。 */
  eventPriority: number
}

/** 交叉淡入状态（from = 切换瞬间的完整姿势快照）。 */
interface FadeState {
  /** 切换瞬间的 per-bone 姿势（全部映射骨，含 rest 兜底）。 */
  fromBones: Map<UnityHumanoidBone, Quat4>
  /** 切换瞬间的 hips 位移（米，相对 rest position）。 */
  fromHips: Vec3
  durationSec: number
  elapsedSec: number
}

/** `playClipById` 的播放参数（内部用）。 */
interface PlayOptions {
  loop?: boolean
  fadeSec?: number
  hold?: boolean
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isPetMood(value: unknown): value is PetMood {
  return typeof value === 'string' && (PET_MOODS as readonly string[]).includes(value)
}

/** 读取错误信息文本（warn 用）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* 播放器                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * humanoid clip 播放器（构造参数见 `CreateVrmClipPlayerOptions`）。
 *
 * 使用流程（animator 侧）：
 * ```ts
 * const player = new VrmClipPlayer({ avatar, getPixelsPerMeter })
 * await player.init()
 * player.update(animationInput)   // 每帧；末尾负责 humanoid.update()
 * ```
 */
export class VrmClipPlayer implements VrmClipPlayerContract {
  private readonly options: CreateVrmClipPlayerOptions
  private readonly avatar: CreateVrmClipPlayerOptions['avatar']
  private readonly registry: ClipRegistry
  private readonly random: () => number
  private readonly now: () => number

  /** normalized 骨节点（VRM 名 → 节点；模型缺的骨不在 Map 里）。 */
  private readonly nodes = new Map<VrmBoneName, Object3D>()
  /** rest 旋转（Unity 名 → 四元数）与 hips rest position（米）。 */
  private readonly restQuats = new Map<UnityHumanoidBone, Quat4>()
  private restHipsPos: Vec3 = [0, 0, 0]
  /** Hips.p 缩放基准（米）：优先 avatar.hipsRestHeight，非法时回退 rest hips y。 */
  private hipsRestHeight = 1
  /** rest 脚底基准（米，avatar.scene 局部坐标；贴地目标高度 = rest 姿势下最低脚骨）。 */
  private restFeetLocalY: number | null = null
  /** rest bbox 脚底（`avatar.restFeetY`；rest 脚骨缺失时的后备基准）。 */
  private restFeetY = 0

  /** 当前播放状态（null = 无可用 clip / 刚播完等待回 mood）。 */
  private active: ActiveClipState | null = null
  /** 交叉淡入（null = 稳定播放）。 */
  private fade: FadeState | null = null
  /** 调试 mood 覆盖（animator 的 setPose 别名用）。 */
  private moodOverride: PetMood | null = null

  /**
   * 上一帧写骨用的「fold 前」normalized 姿势（切换时快照做交叉淡入）。
   *
   * 目标缺 upperChest 时，chest/子骨会在写节点前再 α-fold（`applyFrame`）；这里保留
   * fold 前值，使 chest/子骨与虚拟 UpperChest 各自按同一 crossfade weight 混合，
   * 端点（weight=0/1）折叠后仍分别等于两侧的实际视觉姿势（不会把 U 重复计入）。
   */
  private readonly appliedPose = new Map<UnityHumanoidBone, Quat4>()
  /** 上一帧实际写入的 hips 位移（米，相对 rest position）。 */
  private readonly appliedHips: Vec3 = [0, 0, 0]
  /** 每个映射骨的采样/混合临时数组（复用避免每帧分配）。 */
  private readonly targetQuats = new Map<UnityHumanoidBone, Quat4>()
  private readonly outQuats = new Map<UnityHumanoidBone, Quat4>()

  /** 每 clip 各贴地模式的常量补偿（正 = 向上；以源 clip 对象为键保持身份稳定）。 */
  private readonly groundOffsets = new WeakMap<ParsedClip, Map<GroundMode, number>>()
  /** 每 clip 的缺骨列表缓存（key = 源 clip 对象）。 */
  private readonly missingBonesCache = new WeakMap<ParsedClip, string[]>()
  /** 已 warn 过的「主骨缺失 → 回退骨」组合（换资产兼容，避免刷屏）。 */
  private readonly warnedBoneFallbacks = new Set<string>()
  /** 全 raw humanoid 骨节点缓存（贴地/姿态指标/步幅共用；captureRestPose 时建立）。 */
  private rawBoneNodes: Object3D[] = []
  /** 脚部 raw 骨节点缓存（feet 贴地测量）。 */
  private rawFootNodes: Object3D[] = []
  /** 每 clip 的步幅地速（m/s；null = 不可用/非 walk-climb；以源 clip 对象为键）。 */
  private readonly strideGroundSpeeds = new WeakMap<ParsedClip, number | null>()
  /** 当前帧姿态指标：hips 相对全 raw humanoid 骨最低点的高度（米；null = 不可用）。 */
  private lastPoseHipsAboveLowestM: number | null = null
  /** 当前 clip 的步幅地速（snapshot 用；非 walk/climb 为 null）。 */
  private lastStrideGroundSpeedMps: number | null = null
  /** 当前播放的必要信息（snapshot 用）。 */
  private lastBonesApplied = 0
  /**
   * 是否已经至少写过一帧完整姿势（启动首帧吸附用；用户 2026-11-09）。
   * false = 还从未应用过任何 clip 姿势（此时可见骨架仍是 VRM rest T-pose）。
   */
  private poseEverApplied = false
  private lastFootErrorPx: number | null = null
  private lastPlaybackRate = 1

  /** 基础 mood（变体随机轮换的上下文）。 */
  private baseMood: PetMood | null = null
  /** 当前基础 clip 的变体 id（同一 mood 内随机轮换用）。 */
  private currentVariantId: string | null = null
  /** 最近播放过的变体 id（MRU，用于避免近期重复）。 */
  private recentVariantIds: string[] = []
  /** 下一次变体轮换的注入时钟毫秒（Infinity = 不轮换）。 */
  private nextVariantAtMs = Number.POSITIVE_INFINITY
  /** 一次性/手动 clip 播完后，回 mood 时立即随机换一个变体（沿用「事件后换一个」）。 */
  private variantRotationPending = false
  /** `stopManualClip(fadeSec)` 指定的一次性「回基础 mood」crossfade（消费后清空）。 */
  private pendingBaseFadeSec: number | null = null
  /**
   * 腾空期间收到的 thrown（被甩出）：受击/眩晕是**地面接触语义**，不能在半空播
   * （用户 2026-11-09「从高处扔下触发 stun 时先起跳后蜷缩」）。先记下，落地（landed）时
   * 补播 hsr-stun；若落地前又进入拖拽/新状态则丢弃（见 update/applyBestEvent）。
   */
  private pendingThrownLanding = false

  /** 请求序号（异步加载完成时只允许最新一次请求生效）。 */
  private requestToken = 0

  private readonly tmpFootWorld = new Vector3()
  private readonly tmpHipsOffset: Vec3 = [0, 0, 0]
  private readonly tmpBlendHips: Vec3 = [0, 0, 0]

  /** 可调参数（变体切换覆盖；见 `VrmClipPlayerTuning`）。 */
  private readonly tuning: VrmClipPlayerTuning

  private initPromise: Promise<void> | null = null
  private readyFlag = false
  private disposed = false

  constructor(options: CreateVrmClipPlayerOptions, tuning: VrmClipPlayerTuning = {}) {
    this.options = options
    this.tuning = tuning
    this.avatar = options.avatar
    this.random = typeof options.random === 'function' ? options.random : Math.random
    this.now =
      typeof options.now === 'function'
        ? options.now
        : () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const registryOptions: ClipRegistryOptions = { motionSet: options.motionSet }
    if (typeof options.fetchText === 'function') registryOptions.fetchText = options.fetchText
    this.registry = new ClipRegistry(registryOptions)
    // 临时数组初始化（每个映射骨 4 个分量）。
    for (const unityBone of CLIP_BONE_NAMES) {
      this.targetQuats.set(unityBone, [0, 0, 0, 1])
      this.outQuats.set(unityBone, [0, 0, 0, 1])
      this.appliedPose.set(unityBone, [...IDENTITY_QUAT] as Quat4)
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  /** 是否就绪（manifest 加载成功 + 至少一个 clip 可用）。 */
  get ready(): boolean {
    return this.readyFlag
  }

  /** 已加载 clip 数（调试/测试）。 */
  get loadedClipCount(): number {
    return this.registry.loadedClipCount
  }

  /** 注册表（只读用途：调试/测试；不要从外部改状态）。 */
  get clipRegistry(): ClipRegistry {
    return this.registry
  }

  /** 当前主 clip id（调试/冒烟；未就绪 null）。 */
  get currentClipId(): string | null {
    return this.active?.id ?? null
  }

  /** 初始化：拉清单 + 预载常用 clip。失败只降级（ready=false）不抛；可重复调用。 */
  init(): Promise<void> {
    if (this.initPromise !== null) return this.initPromise
    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    if (this.disposed) return
    try {
      this.captureRestPose()
    } catch (error) {
      console.warn(`[vrm-clip-player] 捕获 rest pose 失败（降级为静态）：${errorMessage(error)}`)
      return
    }
    try {
      await this.registry.init()
    } catch (error) {
      // registry 内部已 warn；这里只保证不抛。
      console.warn(`[vrm-clip-player] clip 注册表初始化失败（降级为静态）：${errorMessage(error)}`)
    }
    if (this.disposed) return
    if (this.nodes.size === 0) {
      console.warn('[vrm-clip-player] 模型没有可写的 normalized humanoid 骨，clip 播放禁用')
      return
    }
    this.readyFlag = this.registry.ready && this.registry.loadedClipCount > 0
    if (!this.readyFlag) {
      console.warn('[vrm-clip-player] clip 未就绪（app-manifest/clip 缺失或全部损坏），保持静态 rest')
    }
  }

  /** 释放（可重复调用；in-flight 加载结果会被忽略）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.readyFlag = false
    this.registry.dispose()
    this.nodes.clear()
    this.restQuats.clear()
    this.appliedPose.clear()
    this.targetQuats.clear()
    this.outQuats.clear()
    this.warnedBoneFallbacks.clear()
    this.rawBoneNodes = []
    this.rawFootNodes = []
    this.lastPoseHipsAboveLowestM = null
    this.lastStrideGroundSpeedMps = null
    this.active = null
    this.fade = null
  }

  /** 快照 normalized 骨 rest 状态（模型 T/A-pose；clip 未覆盖骨与贴地基准）。 */
  private captureRestPose(): void {
    const humanoid = this.avatar.vrm.humanoid
    this.restQuats.clear()
    this.nodes.clear()
    const hasNormalizedBone = (name: VrmBoneName): boolean =>
      humanoid.getNormalizedBoneNode(name) !== null
    for (const unityBone of CLIP_BONE_NAMES) {
      const vrmName = UNITY_TO_VRM_BONE[unityBone]
      // 手指可选骨缺失时按 `VRM_BONE_FALLBACKS` 回退（换资产兼容；命中不算 missingBones）。
      const resolved = resolveVrmBoneFallback(vrmName, hasNormalizedBone)
      if (resolved === null) continue
      if (resolved.fallbackUsed) this.warnBoneFallback(vrmName, resolved.resolvedName)
      const node = humanoid.getNormalizedBoneNode(resolved.resolvedName)
      if (!node) continue
      this.nodes.set(vrmName, node)
      const rest: Quat4 = [
        node.quaternion.x,
        node.quaternion.y,
        node.quaternion.z,
        node.quaternion.w
      ]
      this.restQuats.set(unityBone, rest)
      this.appliedPose.set(unityBone, [...rest] as Quat4)
    }
    const hipsNode = this.nodes.get('hips')
    if (hipsNode) {
      this.restHipsPos = [hipsNode.position.x, hipsNode.position.y, hipsNode.position.z]
    }
    const avatarHips = this.avatar.hipsRestHeight
    this.hipsRestHeight =
      isFiniteNumber(avatarHips) && avatarHips > 0 ? avatarHips : Math.max(0, this.restHipsPos[1])
    this.restFeetY = isFiniteNumber(this.avatar.restFeetY) ? this.avatar.restFeetY : 0
    // raw humanoid 骨节点缓存（模型加载后节点不变；避免每帧 allocation/查找）。
    this.rawBoneNodes = this.buildRawBoneNodeList()
    this.rawFootNodes = this.buildRawFootNodeList()
    // rest 姿势下的最低脚骨 y（贴地目标：clip 首帧脚骨应对齐到这里，而不是 bbox 底边，
    // 否则会把脚踝骨低于 bbox 底边的模型整体压进地面）。
    this.restFeetLocalY = this.measureMinRawBoneLocalY('feet')
    this.appliedHips[0] = 0
    this.appliedHips[1] = 0
    this.appliedHips[2] = 0
  }

  /* ------------------------------ 对外控制 ------------------------------ */

  /**
   * 调试/一次性动作：按 app-manifest id 或 catalog id 播放（未知 id 返回 false）。
   * @param options.loop 覆盖 loop（默认取条目）
   * @param options.fadeSec 交叉淡入时长（默认条目 fade）
   * @param options.hold 非 loop 播完是否停在末帧（默认 false = 播完回 mood）
   */
  playClipById(id: string, options: PlayOptions = {}): boolean {
    if (this.disposed || typeof id !== 'string') return false
    const entry = this.registry.getPlayableEntry(id)
    if (entry === null) return false
    // 新手动 clip 覆盖旧的「回 mood」过渡（避免 stopManualClip 的 pending fade 残留）。
    this.pendingBaseFadeSec = null
    const token = this.advanceRequestToken()
    const playOptions: PlayOptions = { ...options }
    if (playOptions.loop === undefined) playOptions.loop = entry.loop
    const clip = this.registry.getLoadedClip(id)
    if (clip !== null) {
      this.beginClip(entry, clip, {
        slot: 'manual',
        manual: true,
        loop: playOptions.loop,
        hold: playOptions.hold === true,
        fadeSec: playOptions.fadeSec
      })
      return true
    }
    void this.registry.loadClip(id).then((loaded) => {
      if (loaded === null || this.disposed || token !== this.requestToken) return
      this.beginClip(entry, loaded, {
        slot: 'manual',
        manual: true,
        loop: playOptions.loop === true,
        hold: playOptions.hold === true,
        fadeSec: playOptions.fadeSec
      })
    })
    return true
  }

  /**
   * 清除当前手动 clip（`playClipById`），按 `fadeSec` 交叉淡出回当前 mood 的选片。
   * 无手动 clip 时 no-op（Lead animator 用它打断入场/错误过场序列；不新增冻结契约）。
   * @param fadeSec 淡出回 mood 的交叉淡入时长（秒，默认 0.2；钳制 0–2）
   */
  stopManualClip(fadeSec: number = DEFAULT_CROSSFADE_SEC): void {
    if (this.disposed) return
    if (this.active?.manual !== true) return
    this.active = null
    this.fade = null
    this.lastFootErrorPx = null
    this.lastBonesApplied = 0
    this.pendingBaseFadeSec = isFiniteNumber(fadeSec)
      ? clamp(fadeSec, 0, 2)
      : DEFAULT_CROSSFADE_SEC
    // 回到当前 mood 的当前变体（不强制随机换一个）；下一次 update 选片时消费上述 fade。
    this.variantRotationPending = false
    this.nextVariantAtMs = Number.POSITIVE_INFINITY
  }

  /**
   * 调试覆盖 mood（null = 清除）。会同时清除手动 clip（回到 mood 驱动）。
   * 不改 B1 行为——animator 只在 `setPose` 别名路径调用。
   */
  setMoodOverride(mood: PetMood | null): void {
    if (this.disposed) return
    this.moodOverride = mood === null || isPetMood(mood) ? mood : null
    // mood 覆盖变化 → 重新选片（重置变体轮换状态）。
    this.baseMood = null
    this.currentVariantId = null
    this.recentVariantIds = []
    this.variantRotationPending = false
    this.nextVariantAtMs = Number.POSITIVE_INFINITY
    if (this.active?.manual === true) {
      this.active = null
      this.fade = null
    }
  }

  /** 调试快照（每帧 update 后读取；返回新对象，调用方不要缓存）。 */
  snapshot(): VrmClipDebugSnapshot {
    const active = this.active
    const fade = this.fade
    const weight = fade === null ? (active === null ? 0 : 1) : this.fadeWeight()
    return {
      clipId: active?.id ?? null,
      slot: active?.slot ?? null,
      timeSec: active?.timeSec ?? 0,
      weight,
      fading: fade !== null && fade.durationSec > 0 && fade.elapsedSec < fade.durationSec,
      playbackRate: this.lastPlaybackRate,
      bonesApplied: this.lastBonesApplied,
      missingBones: active === null ? [] : [...this.missingBonesFor(active.sourceClip)],
      footErrorPx: this.lastFootErrorPx,
      groundOffsetM:
        active === null ? 0 : this.groundOffsetForClip(active.sourceClip, active.slot),
      ready: this.readyFlag,
      loadedClipCount: this.registry.loadedClipCount,
      // V13：坐姿锚点高度（hips 相对全骨最低点）与 walk 步幅地速（Lead animator 接线用）。
      poseHipsAboveLowestM: active === null ? null : this.lastPoseHipsAboveLowestM,
      clipStrideGroundSpeedMps: active === null ? null : this.lastStrideGroundSpeedMps
    }
  }

  /* ------------------------------ 每帧更新 ------------------------------ */

  /**
   * 每帧更新入口（见文件头注释的完整流程）。
   * 内部保证 `humanoid.update()` 在写入后调用一次；`vrm.update(dt)` 由 animator 负责。
   */
  update(input: AnimationInput): void {
    if (!this.readyFlag || this.disposed) return
    if (input === null || typeof input !== 'object') return
    const dt = clamp(isFiniteNumber(input.dt) ? input.dt : 0, 0, MAX_FRAME_DT_SEC)
    const nowMs = this.nowSafely()

    // ---- 1) 一次性事件：拖拽状态 + 最高优先级事件 ----
    const frameState = this.readEvents(input)
    // 重新抓起 = 上一次「空中被甩出」的补播作废（避免旧状态在下一轮落地时突然触发）。
    if (frameState.dragging) this.pendingThrownLanding = false
    if (frameState.dragging && this.active?.oneShot === true) {
      // 拖拽姿态（mood=drag）优先于一次性表演：被打断的一次性 clip 直接让位。
      this.active = null
      this.fade = null
      this.lastFootErrorPx = null
    }
    const manualActive = this.active?.manual === true && this.active.finished === false
    if (!manualActive && !frameState.dragging) {
      this.applyBestEvent(frameState.bestEvent, input)
    }

    // ---- 2) 推进当前 clip 时间，处理播完 ----
    this.advanceActiveTime(dt, input, frameState.dragging, nowMs)

    // ---- 3) 基础 clip 选择（mood → app-manifest；含待机变体轮换） ----
    if (this.active === null || (!this.active.oneShot && !this.active.manual)) {
      this.selectBaseClip(input, frameState.dragging, nowMs)
    }

    // ---- 4) 写姿势 + humanoid.update() + 贴地测量 ----
    this.applyFrame(dt)
  }

  /** 解析本帧事件：拖拽状态变化 + 最高优先级一次性事件。 */
  private readEvents(input: AnimationInput): {
    dragging: boolean
    bestEvent: { kind: AnimationEvent['kind']; priority: number } | null
  } {
    let dragging = input.dragging === true
    let bestEvent: { kind: AnimationEvent['kind']; priority: number } | null = null
    const events = Array.isArray(input.events) ? input.events : []
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      const kind = event.kind
      if (typeof kind !== 'string') continue
      if (kind === 'dragStart') {
        dragging = true
        continue
      }
      if (kind === 'dragEnd') {
        dragging = false
        continue
      }
      const priority = EVENT_PRIORITY[kind] ?? 0
      if (bestEvent === null || priority > bestEvent.priority) {
        bestEvent = { kind, priority }
      }
    }
    return { dragging, bestEvent }
  }

  /** 事件优先级高者打断当前一次性 clip；解析 catalog clip 并播放。 */
  private applyBestEvent(
    bestEvent: { kind: AnimationEvent['kind']; priority: number } | null,
    input: AnimationInput
  ): void {
    if (bestEvent === null) return
    // 空中不播地面接触类受击反应：记下 thrown，落地后再补播眩晕（落地表现由 landed 接管）。
    if (bestEvent.kind === 'thrown' && input.motion.airborne === true) {
      this.pendingThrownLanding = true
      return
    }
    const current = this.active
    if (current !== null && current.oneShot && current.eventPriority >= bestEvent.priority) return
    const clipId = this.resolveEventClipId(bestEvent.kind)
    if (clipId === null) return
    const entry = this.registry.getPlayableEntry(clipId)
    if (entry === null) return
    const token = this.advanceRequestToken()
    const clip = this.registry.getLoadedClip(clipId)
    if (clip !== null) {
      this.beginClip(entry, clip, {
        slot: bestEvent.kind,
        eventPriority: bestEvent.priority,
        oneShot: true,
        loop: false,
        hold: false
      })
      return
    }
    // 懒加载：加载完成前保持当前动作（静默，不是错误）。
    void this.registry.loadClip(clipId).then((loaded) => {
      if (loaded === null || this.disposed || token !== this.requestToken) return
      this.beginClip(entry, loaded, {
        slot: bestEvent.kind,
        eventPriority: bestEvent.priority,
        oneShot: true,
        loop: false,
        hold: false
      })
    })
  }

  /** 事件 → clip id：优先策展 id，其次 catalog tag 回退（只取非循环一次性片段，随机选一）。 */
  private resolveEventClipId(kind: AnimationEvent['kind']): string | null {
    // 「空中被甩出 → 落地」的补播：眩晕/受击是落地冲击反应，用 hsr-stun 替代默认的起身 clip。
    if (kind === 'landed' && this.pendingThrownLanding) {
      this.pendingThrownLanding = false
      if (this.registry.getPlayableEntry('hsr-stun') !== null) return 'hsr-stun'
    }
    const curated = EVENT_CLIP_IDS[kind] ?? []
    const availableCurated = curated.filter((id) => this.registry.getPlayableEntry(id) !== null)
    if (availableCurated.length > 0) return this.pickRandom(availableCurated)
    const tag = EVENT_TAG_FALLBACK[kind]
    if (tag === undefined) return null
    const candidates = this.registry.catalogClips.filter(
      (clip) =>
        clip.tags.includes(tag) &&
        clip.loop === false &&
        clip.mood === null &&
        this.registry.getPlayableEntry(clip.id) !== null
    )
    if (candidates.length === 0) return null
    return this.pickRandom(candidates).id
  }

  /** 推进当前 clip 时间；到达末尾时处理「一次性/调试回 mood、mood 基础 clip 停在末帧」。 */
  private advanceActiveTime(
    dt: number,
    input: AnimationInput,
    dragging: boolean,
    nowMs: number
  ): void {
    const active = this.active
    if (active === null) {
      this.lastPlaybackRate = 1
      return
    }
    const rate = this.computePlaybackRate(active, input, dragging)
    this.lastPlaybackRate = rate
    active.timeSec += dt * rate
    if (active.entry.loop) {
      const duration = clipDurationSec(active.sampledClip)
      if (duration > 0) active.timeSec %= duration
      return
    }
    const endSec = this.nonLoopEndSec(active)
    if (active.timeSec < endSec) return
    active.timeSec = endSec
    if (active.finished) return
    active.finished = true
    if (active.hold) return // 调试 hold：停在末帧，等下一次显式请求
    if (active.oneShot || active.manual) {
      // 一次性表演/调试 clip 播完 → 回当前 mood（下一帧基础选片接上）。
      this.finishActive(nowMs)
      return
    }
    // mood 绑定但 loop=false 的 clip（如 mate drag）：停在末帧保持姿态，
    // 不重复起播（避免「播完 → 重头再来」的跳变）；mood 离开时自然切换。
  }

  /** 非 loop clip 的可达末帧时刻（末帧包含语义）。 */
  private nonLoopEndSec(active: ActiveClipState): number {
    const frames = Math.max(1, active.sampledClip.frames)
    const fps = active.sampledClip.fps > 0 ? active.sampledClip.fps : 1
    return (frames - 1) / fps
  }

  /** 当前 clip 播完：清空 active（下一帧基础选片会接回 mood），并推进待机变体。 */
  private finishActive(nowMs: number): void {
    this.active = null
    this.fade = null
    this.lastFootErrorPx = null
    this.lastBonesApplied = 0
    // 回 mood 时立即随机换一个变体（沿用「事件后换一个」；下一帧 selectBaseClip 执行）。
    this.variantRotationPending = true
    this.nextVariantAtMs = nowMs
  }

  /** 播放速率：走路/攀爬按「移动速度 / 自然步速」匹配，其余 = entry.timeScale。 */
  private computePlaybackRate(
    active: ActiveClipState,
    input: AnimationInput,
    dragging: boolean
  ): number {
    const entry = active.entry
    const baseRate = isFiniteNumber(entry.timeScale) && entry.timeScale > 0 ? entry.timeScale : 1
    const mood = entry.mood
    if (mood !== 'walk' && mood !== 'climb') {
      this.lastStrideGroundSpeedMps = null
      return baseRate
    }
    // V13：步幅地速惰性计算并缓存（applyFrame 里只读缓存值）。
    const strideMps = this.strideGroundSpeedForClip(active.sourceClip)
    this.lastStrideGroundSpeedMps = strideMps
    if (dragging) return baseRate
    const velocity = input.motion?.velocity
    const speed = Math.hypot(
      isFiniteNumber(velocity?.x) ? velocity.x : 0,
      isFiniteNumber(velocity?.y) ? velocity.y : 0
    )
    // 优先用 clip 的「步幅地速」校准（脚在支撑相相对 root 的水平速度），减少脚滑：
    // playbackRate = 当前移动速度(px/s) / (步幅地速(m/s) × 每米像素数)。
    const ppm = this.pixelsPerMeter()
    if (ppm !== null && strideMps !== null && strideMps > 1e-3) {
      const stridePxPerSec = strideMps * ppm
      if (stridePxPerSec > 0) {
        return (
          baseRate * clamp(speed / stridePxPerSec, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE)
        )
      }
    }
    // 回退旧公式：移动速度 / 自然步速（体高 × 0.87 体高/秒）。
    const petHeightPx = this.petHeightPx(input)
    if (petHeightPx === null) return baseRate
    const naturalSpeedPx = NATURAL_WALK_SPEED_HEIGHT_FACTOR * petHeightPx
    if (!(naturalSpeedPx > 0)) return baseRate
    return baseRate * clamp(speed / naturalSpeedPx, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE)
  }

  /** 当前宠物高度（CSS px）：优先 petRect.height，其次 getPixelsPerMeter × 模型 rest 高。 */
  private petHeightPx(input: AnimationInput): number | null {
    const rectHeight = input.petRect?.height
    if (isFiniteNumber(rectHeight) && rectHeight > 0) return rectHeight
    const ppm = this.pixelsPerMeter()
    const restHeight = this.avatar.restHeightMeters
    if (ppm !== null && isFiniteNumber(restHeight) && restHeight > 0) return ppm * restHeight
    return null
  }

  /** `getPixelsPerMeter` 安全读取（非法/未提供 → null）。 */
  private pixelsPerMeter(): number | null {
    const getter = this.options.getPixelsPerMeter
    if (typeof getter !== 'function') return null
    try {
      const value = getter()
      return isFiniteNumber(value) && value > 0 ? value : null
    } catch {
      return null
    }
  }

  /** 基础选片：mood（或 dragging → drag）→ app-manifest 条目（随机变体轮换）。 */
  private selectBaseClip(input: AnimationInput, dragging: boolean, nowMs: number): void {
    if (this.active?.manual === true) return
    const inputMood = isPetMood(input.mood) ? input.mood : 'idle'
    let mood: PetMood = this.moodOverride ?? (dragging ? 'drag' : inputMood)
    let entries = this.registry.entriesForMood(mood)
    if (entries.length === 0 && this.moodOverride === null) {
      // 拖拽态优先 drag 槽位；该槽位没有 clip 时退回 B1 mood（保持当前动作）。
      mood = inputMood
      entries = this.registry.entriesForMood(mood)
    }
    if (entries.length === 0) return // 缺 clip：保持当前动作（不清空）
    // 变体池：过滤 priority 过低的「特殊动作」clip（如窗沿躺 sitWindow/windowLay*）。
    entries = this.variantPool(entries)
    const config = this.variantConfigFor(mood)

    const isBaseActive = this.active !== null && !this.active.oneShot && !this.active.manual
    const activeId = isBaseActive ? this.active!.id : null
    const effectiveId = activeId ?? this.currentVariantId
    if (this.baseMood !== mood) {
      // 换 mood：重置轮换状态（旧变体 id 仅作为近期排除参考）。
      this.baseMood = mood
      this.recentVariantIds = effectiveId !== null ? [effectiveId] : []
      this.variantRotationPending = false
      this.nextVariantAtMs = Number.POSITIVE_INFINITY
    }
    const currentEntry =
      effectiveId === null
        ? null
        : entries.find((entry) => entry.id === effectiveId) ?? null

    // 1) 新 mood 或当前变体不在池内 → 播池内最高优先级（priority = 默认主选）。
    if (currentEntry === null) {
      const entry = this.pickInitialEntry(entries)
      this.startVariant(entry, false, config, nowMs)
      return
    }

    // 2) 同一 mood 的变体随机轮换：间隔到点、或一次性/手动 clip 刚播完。
    const rotationDue =
      entries.length > 1 &&
      (this.variantRotationPending || nowMs >= this.nextVariantAtMs)
    if (rotationDue) {
      // 一次性/手动 clip 播完回 mood → 按「初始选片」重新随机：最高优先级并列随机
      // （如 idle 的 hsr-idle / adv-idle 同级 → 每次打开/回归 idle 随机主待机）；
      // 到点的定时轮换保持原行为（变体池随机，idle 12–20s 等由 VARIANT_SWITCH_CONFIG 决定）。
      const fromFinishedOneShot = this.variantRotationPending
      this.variantRotationPending = false
      const entry = fromFinishedOneShot
        ? this.pickInitialEntry(entries)
        : this.pickNextVariant(entries, currentEntry.id, config)
      if (entry.id !== currentEntry.id) {
        this.startVariant(entry, true, config, nowMs)
        return
      }
      // 池太小（候选只有当前）→ 保持当前，稍后再试。
      this.scheduleNextVariant(nowMs, config)
    } else if (!isBaseActive && this.active === null) {
      // 一次性/手动 clip 已结束、当前变体未切换 → 接回当前变体。
      this.startVariant(currentEntry, false, config, nowMs)
    }
  }

  /**
   * 开始基础 mood 的一个变体（新 mood 首播 / 随机轮换共用）：
   * - 变体轮换时用 `VARIANT_SWITCH_CONFIG` 的随机 crossfade 时长与随机起始相位；
   * - 更新当前/近期变体记录，并排下一次轮换（sleep 等 interval=null 不轮换）。
   */
  private startVariant(
    entry: AnimationClipEntry,
    variantSwitch: boolean,
    config: VariantSwitchConfig,
    nowMs: number
  ): void {
    const clip = this.registry.getLoadedClip(entry.id)
    if (clip === null) {
      // 懒加载未就绪：保持当前动作，稍后重试（避免每帧重复 kick load）。
      void this.registry.loadClip(entry.id)
      if (variantSwitch) this.nextVariantAtMs = nowMs + 250
      return
    }
    const pendingFadeSec = this.consumePendingBaseFadeSec()
    const fadeSec =
      pendingFadeSec !== null
        ? pendingFadeSec
        : variantSwitch
          ? this.sampleVariantFade(config)
          : undefined
    const initialPhaseSec =
      variantSwitch && entry.loop ? this.sampleInitialPhase(config, clip) : 0
    this.beginClip(entry, clip, {
      slot: entry.mood,
      loop: entry.loop,
      ...(fadeSec !== undefined ? { fadeSec } : {}),
      initialPhaseSec
    })
    this.currentVariantId = entry.id
    this.rememberVariant(entry.id, config)
    this.scheduleNextVariant(nowMs, config)
  }

  /**
   * 变体池：只保留 priority ≥ `VARIANT_ROTATION_MIN_PRIORITY`（-9）的条目；
   * 全部低于阈值时退回原列表（保证仍有 clip 可播）。
   * 与 `scripts/vrm/motion/build-app-manifest.mjs` 的「窗沿躺降到 -10 以下」约定配套。
   */
  private variantPool(entries: readonly AnimationClipEntry[]): readonly AnimationClipEntry[] {
    const pool = entries.filter((entry) => entry.priority >= VARIANT_ROTATION_MIN_PRIORITY)
    return pool.length > 0 ? pool : entries
  }

  /**
   * 新进入一个槽位时的首播选片：
   * - 默认取最高优先级（`entries` 已按 priority 降序、同 priority 保持清单顺序）；
   * - 若最高优先级存在并列（如 drag 的男女版同为 priority 0），等概率随机取一条。
   *   并列条目在自己的 `avoidRecent` 轮换间隔内不会互相切换（drag 的 interval=null 不轮换）。
   */
  private pickInitialEntry(entries: readonly AnimationClipEntry[]): AnimationClipEntry {
    const first = entries[0]
    if (entries.length <= 1) return first
    const topPriority = first.priority
    const tied = entries.filter((entry) => entry.priority === topPriority)
    if (tied.length <= 1) return first
    return this.pickRandom(tied)
  }

  /** 解析槽位变体配置（默认 + 可选 tuning 覆盖；区间字段整体覆盖）。 */
  private variantConfigFor(slot: string): VariantSwitchConfig {
    const defaults = variantSwitchConfigFor(slot)
    const override = this.tuning.variantSwitch?.[slot] ?? this.tuning.variantSwitch?.default
    if (override === undefined) return defaults
    return {
      intervalSec:
        override.intervalSec !== undefined ? override.intervalSec : defaults.intervalSec,
      fadeSec: override.fadeSec ?? defaults.fadeSec,
      randomPhase: override.randomPhase ?? defaults.randomPhase,
      avoidRecent: override.avoidRecent ?? defaults.avoidRecent,
      weightedByPriority: override.weightedByPriority ?? defaults.weightedByPriority
    }
  }

  /** 区间随机取样（注入 random；非法/倒置区间安全处理）。 */
  private sampleRange(range: SecondsRange): number {
    const min = isFiniteNumber(range.min) ? range.min : 0
    const max = isFiniteNumber(range.max) ? Math.max(min, range.max) : min
    return min + clamp(this.randomSafely(), 0, 1) * (max - min)
  }

  /** 排下一次变体轮换（interval=null → 不再轮换；随机均匀间隔）。 */
  private scheduleNextVariant(nowMs: number, config: VariantSwitchConfig): void {
    this.nextVariantAtMs =
      config.intervalSec === null
        ? Number.POSITIVE_INFINITY
        : nowMs + this.sampleRange(config.intervalSec) * 1000
  }

  /** 变体切换 crossfade 时长（秒；区间随机）。 */
  private sampleVariantFade(config: VariantSwitchConfig): number {
    return clamp(this.sampleRange(config.fadeSec), 0, 2)
  }

  /** 变体切换时循环 clip 的随机起始相位（秒；关闭或非 loop 时为 0）。 */
  private sampleInitialPhase(config: VariantSwitchConfig, clip: ParsedClip): number {
    if (!config.randomPhase) return 0
    const duration = clipDurationSec(clip)
    if (!(duration > 0)) return 0
    return this.randomSafely() * duration
  }

  /** 归一化变体切换的初始相位：仅 loop clip、取 [0, duration) 防负数/越界。 */
  private normalizeInitialPhase(
    phaseSec: number | undefined,
    clip: ParsedClip,
    loop: boolean
  ): number {
    if (!loop || !isFiniteNumber(phaseSec)) return 0
    const duration = clipDurationSec(clip)
    if (!(duration > 0)) return 0
    return ((phaseSec % duration) + duration) % duration
  }

  /** 取出并清空 `stopManualClip(fadeSec)` 指定的一次性回 mood crossfade。 */
  private consumePendingBaseFadeSec(): number | null {
    const value = this.pendingBaseFadeSec
    this.pendingBaseFadeSec = null
    return value
  }

  /** 记住最近变体（MRU；最多保留 avoidRecent+1 个，用于排除近期重复）。 */
  private rememberVariant(id: string, config: VariantSwitchConfig): void {
    const keep = clamp(Math.floor(config.avoidRecent) + 1, 2, 24)
    this.recentVariantIds = [
      id,
      ...this.recentVariantIds.filter((recent) => recent !== id)
    ].slice(0, keep)
  }

  /** 稀有权重阈值（tuning 可覆盖；非法值回退默认）。 */
  private rarePriorityThreshold(): number {
    const value = this.tuning.rareVariant?.priorityThreshold
    return isFiniteNumber(value) ? value : RARE_VARIANT_PRIORITY_THRESHOLD
  }

  /** 稀有变体权重（tuning 可覆盖；钳制到 [0,1] 防止异常值）。 */
  private rareVariantWeight(): number {
    const value = this.tuning.rareVariant?.weight
    return isFiniteNumber(value) ? clamp(value, 0, 1) : RARE_VARIANT_WEIGHT
  }

  /**
   * 随机选下一个变体：
   * - 排除当前 + 最近 `avoidRecent-1` 个（避免连续/近期重复；池不够时降级为只排除当前）；
   * - `weightedByPriority=true` 时按 priority 加权（越高权重越大），默认均匀随机；
   * - 没有可换的候选时返回当前（调用方保持不切换）。
   */
  private pickNextVariant(
    entries: readonly AnimationClipEntry[],
    currentId: string | null,
    config: VariantSwitchConfig
  ): AnimationClipEntry {
    const avoidCount = clamp(Math.floor(config.avoidRecent), 1, Math.max(1, entries.length))
    const excluded = new Set<string>()
    if (currentId !== null) excluded.add(currentId)
    // recentVariantIds 是 MRU（[0] = 当前变体）；排除最近 avoidRecent 个（含当前）避免近期重复。
    const excludeRecent = Math.min(avoidCount, this.recentVariantIds.length)
    for (let index = 0; index < excludeRecent; index += 1) {
      excluded.add(this.recentVariantIds[index])
    }
    let candidates = entries.filter((entry) => !excluded.has(entry.id))
    if (candidates.length === 0 && currentId !== null) {
      candidates = entries.filter((entry) => entry.id !== currentId)
    }
    if (candidates.length === 0) {
      return entries.find((entry) => entry.id === currentId) ?? entries[0]
    }
    // 权重 = 稀有权重（priority ≤ 阈值 → 0.3，其余 1）
    //        × 可选 priority 加权（weightedByPriority 时 priority 越高权重越大；默认关）。
    const rareThreshold = this.rarePriorityThreshold()
    const rareWeight = this.rareVariantWeight()
    const minPriority = config.weightedByPriority
      ? Math.min(...candidates.map((entry) => entry.priority))
      : 0
    const weights = candidates.map((entry) => {
      const rare = entry.priority <= rareThreshold ? rareWeight : 1
      if (!config.weightedByPriority) return rare
      return rare * (1 + Math.max(0, entry.priority - minPriority))
    })
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if (!(total > 0)) return this.pickRandom(candidates)
    let roll = this.randomSafely() * total
    for (let index = 0; index < candidates.length; index += 1) {
      roll -= weights[index]
      if (roll <= 0) return candidates[index]
    }
    return candidates[candidates.length - 1]
  }

  /* ------------------------------ 切换 / 写骨 ------------------------------ */

  /** 开始播放一条 clip（交叉淡入从当前实际姿势开始）。 */
  private beginClip(
    entry: PlayableClipEntry,
    clip: ParsedClip,
    options: {
      slot: string
      oneShot?: boolean
      manual?: boolean
      eventPriority?: number
      loop?: boolean
      hold?: boolean
      /** 显式 crossfade 覆盖（变体切换用配置区间；普通切换用条目 fade）。 */
      fadeSec?: number
      /** 变体切换的随机起始相位（秒；仅 loop clip 有意义）。 */
      initialPhaseSec?: number
    }
  ): void {
    const playingEntry: PlayableClipEntry = { ...entry }
    if (options.loop !== undefined) playingEntry.loop = options.loop === true
    // manifest 的 loop 与 clip JSON 的 loop 可能不一致（clip JSON 只影响首帧/末帧语义），
    // 采样用「覆盖 loop 后的浅拷贝」；Float64Array 与源数据共享，不复制大块数据。
    const sampledClip: ParsedClip = { ...clip, loop: playingEntry.loop }
    const initialPhaseSec = this.normalizeInitialPhase(
      options.initialPhaseSec,
      sampledClip,
      playingEntry.loop
    )
    // 启动首帧吸附（用户 2026-11-09：启动先闪「T/A-pose」再进 idle）：
    // 第一条 clip 前的 appliedPose 是 VRM rest（T-pose）；若走 crossfade，前几帧是
    // rest↔idle 的中间态（既不像 T 也不像 A）。首次应用直接满权重写姿势，
    // crossfade 只用于后续从「当前已应用姿势快照」开始的切换（fromBones 已是当前姿势）。
    const fadeSec = this.poseEverApplied ? this.resolveFadeSec(playingEntry, options.fadeSec) : 0
    // 先快照当前实际姿势（mid-fade 时也是当前视觉姿势），再做贴地测量（测量会临时写首帧姿势）。
    const fromBones = new Map<UnityHumanoidBone, Quat4>()
    for (const [bone, quat] of this.appliedPose.entries()) fromBones.set(bone, [...quat] as Quat4)
    const fromHips: Vec3 = [...this.appliedHips] as Vec3
    this.fade =
      fadeSec > 0
        ? { fromBones, fromHips, durationSec: fadeSec, elapsedSec: 0 }
        : null
    this.active = {
      id: entry.id,
      entry: playingEntry,
      sampledClip,
      sourceClip: clip,
      slot: options.slot,
      timeSec: initialPhaseSec,
      oneShot: options.oneShot === true,
      manual: options.manual === true,
      hold: options.hold === true,
      finished: false,
      eventPriority: options.eventPriority ?? 0
    }
    this.lastFootErrorPx = null
    // 贴地常量补偿按需计算（会临时写采样帧姿势；下一次 applyFrame 覆盖为正式姿势）。
    this.groundOffsetForClip(clip, options.slot)
  }

  /** 交叉淡入时长：新条目 fadeIn / 旧条目 fadeOut / 显式覆盖；无数据默认 0.2s。 */
  private resolveFadeSec(entry: PlayableClipEntry, override: number | undefined): number {
    if (isFiniteNumber(override) && override >= 0) return Math.min(2, override)
    const previous = this.active?.entry
    const candidates: number[] = []
    if (isFiniteNumber(entry.fadeInSec)) candidates.push(entry.fadeInSec)
    if (previous !== undefined && isFiniteNumber(previous.fadeOutSec)) {
      candidates.push(previous.fadeOutSec)
    }
    if (candidates.length === 0) return DEFAULT_CROSSFADE_SEC
    const fade = Math.max(...candidates)
    // 数据显式给 0 = 瞬时切换，尊重数据。
    return fade > 0 ? Math.min(2, fade) : 0
  }

  /** 当前帧写姿势：交叉淡入 → 写 normalized 骨 + Hips → humanoid.update() → 贴地测量。 */
  private applyFrame(dt: number): void {
    const active = this.active
    if (active === null) {
      // 无 clip 可播：保持上一次写的姿势（不写 = rest/T-pose 或上一动作末帧）。
      this.lastBonesApplied = 0
      return
    }
    // 淡入推进。
    if (this.fade !== null) {
      this.fade.elapsedSec += dt
      if (this.fade.durationSec <= 0 || this.fade.elapsedSec >= this.fade.durationSec) {
        this.fade = null
      }
    }
    const fade = this.fade
    const weight = fade === null ? 1 : smoothstep(fade.elapsedSec / fade.durationSec)

    // ---- 骨旋转（clip 未覆盖的骨回 rest；先算 out，按需 fold，最后写节点） ----
    // upperChest 兼容：目标模型可能缺该骨（VRM1 可选骨）。此时不能因为没有节点就跳过
    // UpperChest 轨道——先按与其它骨相同的 sample + crossfade 权重算出本帧的 U 存到局部
    // 变量，写节点前再统一折叠；否则 neck/左右 shoulder/head 会 counter-rotate |U|。
    // 规则/公式出处：VRMA `how_to_transform_human_pose`；详见
    // `docs/research/mate-female-to-male-joint-plan-2026-11-11.md` §4.1 与 `upper-chest-fold.ts`。
    let applied = 0
    let upperChestBlend: Quat4 | null = null
    for (const unityBone of CLIP_BONE_NAMES) {
      const vrmName = UNITY_TO_VRM_BONE[unityBone]
      const node = this.nodes.get(vrmName)
      // 目标缺 upperChest：没有节点也要求值（供折叠用）；其余缺骨照旧跳过。
      const virtualUpperChest = unityBone === 'UpperChest' && node === undefined
      if (node === undefined && !virtualUpperChest) continue
      const target = this.targetQuats.get(unityBone)
      const rest =
        this.restQuats.get(unityBone) ?? (virtualUpperChest ? IDENTITY_QUAT : undefined)
      if (target === undefined || rest === undefined) continue
      const covered = sampleBoneRotation(active.sampledClip, unityBone, active.timeSec, target)
      const targetQuat = covered ? target : rest
      const out = this.outQuats.get(unityBone)
      if (out === undefined) continue
      if (fade !== null && weight < 1) {
        const from = fade.fromBones.get(unityBone) ?? rest
        slerpQuat(from, targetQuat, weight, out)
      } else {
        out[0] = targetQuat[0]
        out[1] = targetQuat[1]
        out[2] = targetQuat[2]
        out[3] = targetQuat[3]
      }
      // appliedPose 存「fold 前」的 normalized 值（只用于下一次 crossfade 快照）：
      // chest/子骨与 U 各自按同一 weight 混合，写节点前再统一折叠；weight=0/1 时仍分别
      // 等于两侧的最终视觉姿势（端点处 U^α·U^(1-α)=U），不会把 U 重复计入。
      const appliedBone = this.appliedPose.get(unityBone)
      if (appliedBone !== undefined) {
        appliedBone[0] = out[0]
        appliedBone[1] = out[1]
        appliedBone[2] = out[2]
        appliedBone[3] = out[3]
      }
      if (virtualUpperChest) upperChestBlend = out
    }

    // ---- upperChest α-fold（仅目标缺该骨且 U 非 identity 时；α 默认 1） ----
    // U 已按 crossfade weight 混合；在写 chest/子骨 node.quaternion 之前合成：
    //   chest' = chest · U^α；neck/leftShoulder/rightShoulder' = U^(1-α) · child。
    // 任意 α 下子骨世界朝向都精确恢复；α 只影响 U 在 chest 网格与子骨间的分配。
    let upperChestChildMultiplier: Quat4 | null = null
    const chestOut = this.outQuats.get('Chest')
    if (
      upperChestBlend !== null &&
      chestOut !== undefined &&
      this.nodes.get('chest') !== undefined
    ) {
      const folded = foldUpperChest(chestOut, upperChestBlend, UPPER_CHEST_FOLD_ALPHA)
      if (folded.applied) {
        chestOut[0] = folded.chest[0]
        chestOut[1] = folded.chest[1]
        chestOut[2] = folded.chest[2]
        chestOut[3] = folded.chest[3]
        if (!isIdentityQuat(folded.childMultiplier)) {
          upperChestChildMultiplier = folded.childMultiplier
        }
      }
    }

    // ---- 写 normalized 骨最终值（缺失的 upperChest 虚拟骨不写节点） ----
    for (const unityBone of CLIP_BONE_NAMES) {
      const vrmName = UNITY_TO_VRM_BONE[unityBone]
      const node = this.nodes.get(vrmName)
      if (node === undefined) continue
      const out = this.outQuats.get(unityBone)
      if (out === undefined) continue
      // 无 rest 映射 = 本帧未参与计算（captureRestPose 为每个有节点的骨都写了 rest）。
      if (this.restQuats.get(unityBone) === undefined) continue
      if (upperChestChildMultiplier !== null && UPPER_CHEST_FOLD_CHILD_BONES.has(unityBone)) {
        multiplyQuat(upperChestChildMultiplier, out, out)
      }
      node.quaternion.set(out[0], out[1], out[2], out[3])
      applied += 1
    }
    this.lastBonesApplied = applied
    // 首帧吸附后标记「姿势已应用过」（后续 clip 切换恢复 crossfade 语义）。
    if (applied > 0) this.poseEverApplied = true

    // ---- Hips 位置（rest + 缩放后的 p + 贴地常量；交叉淡入线性插值） ----
    const hipsNode = this.nodes.get('hips')
    if (hipsNode !== undefined) {
      const targetOffset = this.tmpHipsOffset
      const hasPosition = sampleScaledHipsPosition(
        active.sampledClip,
        active.timeSec,
        this.hipsRestHeight,
        targetOffset
      )
      if (!hasPosition) {
        targetOffset[0] = 0
        targetOffset[1] = 0
        targetOffset[2] = 0
      }
      targetOffset[1] += this.groundOffsetForClip(active.sourceClip, active.slot)
      const outHips = this.tmpBlendHips
      if (fade !== null && weight < 1) {
        outHips[0] = fade.fromHips[0] + (targetOffset[0] - fade.fromHips[0]) * weight
        outHips[1] = fade.fromHips[1] + (targetOffset[1] - fade.fromHips[1]) * weight
        outHips[2] = fade.fromHips[2] + (targetOffset[2] - fade.fromHips[2]) * weight
      } else {
        outHips[0] = targetOffset[0]
        outHips[1] = targetOffset[1]
        outHips[2] = targetOffset[2]
      }
      hipsNode.position.set(
        this.restHipsPos[0] + outHips[0],
        this.restHipsPos[1] + outHips[1],
        this.restHipsPos[2] + outHips[2]
      )
      this.appliedHips[0] = outHips[0]
      this.appliedHips[1] = outHips[1]
      this.appliedHips[2] = outHips[2]
    }

    // ---- normalized → raw 同步（player 负责；animator 的 look-at 之后还会再调一次） ----
    this.avatar.vrm.humanoid.update()

    // ---- 每帧姿态竖直指标（一次 world matrix 更新，同时供贴地误差 / 坐姿锚点使用） ----
    const vertical = this.measurePoseVerticalMetrics()
    this.lastPoseHipsAboveLowestM =
      vertical.hipsLocalY === null || vertical.minBoneLocalY === null
        ? null
        : vertical.hipsLocalY - vertical.minBoneLocalY
    // 贴地误差（feet = 脚骨；pose = 最低骨；none = null；不做每帧硬钳）
    const groundMode = this.groundModeFor(active.sourceClip, active.slot)
    if (groundMode !== 'none') {
      const minBoneY =
        groundMode === 'feet' ? vertical.minFootLocalY : vertical.minBoneLocalY
      const ppm = this.pixelsPerMeter()
      this.lastFootErrorPx =
        minBoneY === null || ppm === null ? null : Math.abs(minBoneY - this.groundTargetY) * ppm
    } else {
      this.lastFootErrorPx = null
    }
    // V13：步幅地速（在 computePlaybackRate 里惰性计算；这里只读缓存，避免 applyFrame 内重复测 FK）
    this.lastStrideGroundSpeedMps =
      active.entry.mood === 'walk' || active.entry.mood === 'climb'
        ? this.cachedStrideGroundSpeed(active.sourceClip)
        : null
  }

  /* ------------------------------ 贴地 ------------------------------ */

  /** 贴地目标 y（米，avatar.scene 局部坐标）：rest 姿势最低脚骨，缺失时退回 bbox 脚底。 */
  private get groundTargetY(): number {
    return this.restFeetLocalY ?? this.restFeetY
  }

  /**
   * 决定 clip 的贴地模式（V5）：
   * - `slot==='drag'`：`none`（拖拽由 B2 抬着，不能吸地）；
   * - clip 显式 `grounding:'feet'`：`feet` 脚骨贴地（HSR 站立/待机）；
   * - clip JSON **显式** `grounding:'none'`：数据作者标记不贴地（空中技能等）→ `none`；
   * - clip JSON **未标注** grounding（mate 集全部 clip）：`pose` 姿态最低骨兜底贴地
   *   （修复 V5 实机「坐下/睡觉整体悬空」）。
   */
  private groundModeFor(clip: ParsedClip, slot: string | null): GroundMode {
    if (slot !== null && GROUND_EXCLUDED_SLOTS.has(slot)) return 'none'
    if (clip.grounding === 'feet') return 'feet'
    const meta = this.registry.getClipMeta(clip)
    if (meta !== null && meta.groundingDeclared) return 'none'
    return 'pose'
  }

  /**
   * 每 clip 每模式的贴地常量（米，正 = 向上；写回 normalized hips y）：
   * - `feet`：首帧最低脚骨 → 对齐 rest 脚骨（保持站立/走路视觉与 rest 一致）；
   * - `pose`：均匀采样 ≤16 帧，取**所有 raw humanoid 骨**的最低世界 y → 对齐 rest 脚骨基准；
   * - `none`：0。
   */
  private groundOffsetForClip(clip: ParsedClip, slot: string | null = null): number {
    const mode = this.groundModeFor(clip, slot)
    let offsets = this.groundOffsets.get(clip)
    if (offsets === undefined) {
      offsets = new Map()
      this.groundOffsets.set(clip, offsets)
    }
    const cached = offsets.get(mode)
    if (cached !== undefined) return cached
    let offset = 0
    if (mode === 'feet') {
      const minFootY = this.measureClipMinBoneLocalY(clip, 'feet', 1)
      if (minFootY !== null) offset = this.groundTargetY - minFootY
    } else if (mode === 'pose') {
      const minBoneY = this.measureClipMinBoneLocalY(clip, 'all', POSE_GROUND_MAX_SAMPLES)
      if (minBoneY !== null) offset = this.groundTargetY - minBoneY
    }
    offsets.set(mode, offset)
    return offset
  }

  /**
   * 采样 clip 的至多 `maxSamples` 帧（均匀覆盖 `[0, frames-1]`），返回测量骨的最低世界 y
   * （avatar.scene 局部坐标）。测量期间会临时写姿势；调用方（beginClip）随后会用正式姿势覆盖。
   */
  private measureClipMinBoneLocalY(
    clip: ParsedClip,
    scope: 'feet' | 'all',
    maxSamples: number
  ): number | null {
    const frames = Math.max(1, clip.frames)
    const sampleCount = Math.max(1, Math.min(frames, maxSamples))
    const fps = clip.fps > 0 ? clip.fps : 1
    let minY = Infinity
    for (let index = 0; index < sampleCount; index += 1) {
      const frame =
        sampleCount === 1 ? 0 : Math.round((index * (frames - 1)) / (sampleCount - 1))
      this.applyClipPoseDirect(clip, frame / fps)
      const sampleMin = this.measureMinRawBoneLocalY(scope)
      if (sampleMin !== null && sampleMin < minY) minY = sampleMin
    }
    return Number.isFinite(minY) ? minY : null
  }

  /** 把 clip 某时刻的姿势（normalized 骨 + 缩放后 Hips.p，**不含贴地偏移**）直接写到骨骼上。 */
  private applyClipPoseDirect(clip: ParsedClip, timeSec: number): void {
    const humanoid = this.avatar.vrm.humanoid
    for (const unityBone of CLIP_BONE_NAMES) {
      const vrmName = UNITY_TO_VRM_BONE[unityBone]
      const node = this.nodes.get(vrmName)
      if (node === undefined) continue
      const target = this.targetQuats.get(unityBone)
      const rest = this.restQuats.get(unityBone)
      if (target === undefined || rest === undefined) continue
      const covered = sampleBoneRotation(clip, unityBone, timeSec, target)
      const quat = covered ? target : rest
      node.quaternion.set(quat[0], quat[1], quat[2], quat[3])
    }
    // upperChest 兼容（与 applyFrame 同一规则）：贴地/步幅等离线测量也必须看到「折叠后」
    // 的显示姿势，否则 10 条 upperChest 非 identity 的 clip 会用未折叠姿势算 grounding 常量，
    // 显示姿势与贴地基准不一致（见 upper-chest-fold.ts / §4.1）。
    const upperChestNode = this.nodes.get(UNITY_TO_VRM_BONE.UpperChest)
    const chestNode = this.nodes.get(UNITY_TO_VRM_BONE.Chest)
    if (upperChestNode === undefined && chestNode !== undefined) {
      const upperChestSample: Quat4 = [0, 0, 0, 1]
      if (sampleBoneRotation(clip, 'UpperChest', timeSec, upperChestSample)) {
        const chestQuat: Quat4 = [
          chestNode.quaternion.x,
          chestNode.quaternion.y,
          chestNode.quaternion.z,
          chestNode.quaternion.w
        ]
        const folded = foldUpperChest(chestQuat, upperChestSample, UPPER_CHEST_FOLD_ALPHA)
        if (folded.applied) {
          chestNode.quaternion.set(
            folded.chest[0],
            folded.chest[1],
            folded.chest[2],
            folded.chest[3]
          )
          if (!isIdentityQuat(folded.childMultiplier)) {
            const out: Quat4 = [0, 0, 0, 1]
            for (const childBone of UPPER_CHEST_FOLD_CHILD_BONES) {
              const childNode = this.nodes.get(UNITY_TO_VRM_BONE[childBone])
              if (childNode === undefined) continue
              const childQuat: Quat4 = [
                childNode.quaternion.x,
                childNode.quaternion.y,
                childNode.quaternion.z,
                childNode.quaternion.w
              ]
              multiplyQuat(folded.childMultiplier, childQuat, out)
              childNode.quaternion.set(out[0], out[1], out[2], out[3])
            }
          }
        }
      }
    }
    const hipsNode = this.nodes.get('hips')
    if (hipsNode !== undefined) {
      const offset = this.tmpHipsOffset
      if (!sampleScaledHipsPosition(clip, timeSec, this.hipsRestHeight, offset)) {
        offset[0] = 0
        offset[1] = 0
        offset[2] = 0
      }
      hipsNode.position.set(
        this.restHipsPos[0] + offset[0],
        this.restHipsPos[1] + offset[1],
        this.restHipsPos[2] + offset[2]
      )
    }
    humanoid.update()
  }

  /** 建立全 raw humanoid 骨节点缓存（优先 rawHumanBones；fake humanoid 退回 52 骨映射表）。 */
  private buildRawBoneNodeList(): Object3D[] {
    const humanoid = this.avatar.vrm.humanoid
    const result: Object3D[] = []
    const seen = new Set<Object3D>()
    const push = (node: Object3D | null | undefined): void => {
      if (node === null || node === undefined || seen.has(node)) return
      seen.add(node)
      result.push(node)
    }
    const rawBones = (
      humanoid as unknown as {
        rawHumanBones?: Record<string, { node?: Object3D }>
      }
    ).rawHumanBones
    if (rawBones !== undefined && rawBones !== null) {
      for (const bone of Object.values(rawBones)) push(bone?.node ?? null)
    }
    if (result.length === 0) {
      for (const unityBone of CLIP_BONE_NAMES) {
        push(humanoid.getRawBoneNode(UNITY_TO_VRM_BONE[unityBone]))
      }
    }
    return result
  }

  /** 建立脚部 raw 骨节点缓存（feet/toes；去重）。 */
  private buildRawFootNodeList(): Object3D[] {
    const humanoid = this.avatar.vrm.humanoid
    const result: Object3D[] = []
    const seen = new Set<Object3D>()
    for (const boneName of FOOT_BONE_NAMES) {
      const node = humanoid.getRawBoneNode(boneName)
      if (!node || seen.has(node)) continue
      seen.add(node)
      result.push(node)
    }
    return result
  }

  /**
   * 当前 raw humanoid 骨的最低 y（avatar.scene 局部坐标，米）；grounding 采样用。
   * @param scope 'feet' = 只测脚骨（feet/toes）；'all' = 所有 raw humanoid 骨（pose 兜底）
   */
  private measureMinRawBoneLocalY(scope: 'feet' | 'all'): number | null {
    const scene = this.avatar.scene
    if (scene === null || scene === undefined) return null
    const candidates = scope === 'feet' ? this.rawFootNodes : this.rawBoneNodes
    if (candidates.length === 0) return null
    scene.updateWorldMatrix(true, true)
    let minY = Infinity
    for (const node of candidates) {
      node.getWorldPosition(this.tmpFootWorld)
      scene.worldToLocal(this.tmpFootWorld)
      if (this.tmpFootWorld.y < minY) minY = this.tmpFootWorld.y
    }
    return Number.isFinite(minY) ? minY : null
  }

  /* ------------------------------ 每帧姿态竖直指标（V13 A） ------------------------------ */

  /**
   * 当前帧姿态竖直指标（avatar.scene 局部坐标，米）：
   * - `minBoneLocalY`：全 raw humanoid 骨最低 y；
   * - `minFootLocalY`：脚骨（feet/toes）最低 y（feet 模式贴地误差用）；
   * - `hipsLocalY`：raw hips 世界 y（转 scene 局部）。
   *
   * 只做一次 world matrix 更新 + 一次遍历；供 `footErrorPx` 与 `poseHipsAboveLowestM` 共用。
   */
  private measurePoseVerticalMetrics(): {
    minBoneLocalY: number | null
    minFootLocalY: number | null
    hipsLocalY: number | null
  } {
    const scene = this.avatar.scene
    if (scene === null || scene === undefined) {
      return { minBoneLocalY: null, minFootLocalY: null, hipsLocalY: null }
    }
    scene.updateWorldMatrix(true, true)
    const minOf = (nodes: readonly Object3D[]): number | null => {
      let minY = Infinity
      for (const node of nodes) {
        node.getWorldPosition(this.tmpFootWorld)
        scene.worldToLocal(this.tmpFootWorld)
        if (this.tmpFootWorld.y < minY) minY = this.tmpFootWorld.y
      }
      return Number.isFinite(minY) ? minY : null
    }
    const minBoneLocalY = minOf(this.rawBoneNodes)
    const minFootLocalY = minOf(this.rawFootNodes)
    const hipsNode = this.avatar.vrm.humanoid.getRawBoneNode('hips')
    let hipsLocalY: number | null = null
    if (hipsNode) {
      hipsNode.getWorldPosition(this.tmpFootWorld)
      scene.worldToLocal(this.tmpFootWorld)
      hipsLocalY = this.tmpFootWorld.y
    }
    return { minBoneLocalY, minFootLocalY, hipsLocalY }
  }

  /* ------------------------------ 步幅地速（V13 B） ------------------------------ */

  /** 当前 clip 的步幅地速（只读缓存；仅 walk/climb，其余 null）。 */
  private cachedStrideGroundSpeed(clip: ParsedClip): number | null {
    if (!this.strideGroundSpeeds.has(clip)) return null
    return this.strideGroundSpeeds.get(clip) ?? null
  }

  /** 取/算 clip 的步幅地速（m/s；缓存；不可用 null）。 */
  private strideGroundSpeedForClip(clip: ParsedClip): number | null {
    if (this.strideGroundSpeeds.has(clip)) return this.strideGroundSpeeds.get(clip) ?? null
    const value = this.measureClipStrideGroundSpeed(clip)
    this.strideGroundSpeeds.set(clip, value)
    return value
  }

  /**
   * FK 采样测「步幅地速」（m/s）：脚在支撑相相对 root（avatar.scene 原点）的水平速度。
   *
   * 方法（V13）：
   * 1. 均匀采样 min(frames, 16) 帧，应用 normalized 骨 + 缩放 Hips.p → humanoid.update；
   * 2. 每帧读左右脚（foot+toes 取最低者）在 avatar.scene 局部坐标的世界位置；
   * 3. 每只脚 y 最低 20% 的帧视为支撑相；相邻采样帧都在支撑相时，
   *    速度 = |Δ(x, z)| / Δt（米/秒，水平面距离，兼容模型朝向轴）；
   * 4. 左右脚合并取中位数；样本不足或速度≈0 → null（播放速率回退旧公式）。
   */
  private measureClipStrideGroundSpeed(clip: ParsedClip): number | null {
    const scene = this.avatar.scene
    if (scene === null || scene === undefined) return null
    const sampleCount = Math.max(1, Math.min(clip.frames, POSE_GROUND_MAX_SAMPLES))
    if (sampleCount < 2) return null
    const fps = clip.fps > 0 ? clip.fps : 1
    const humanoid = this.avatar.vrm.humanoid
    const footBoneGroups: ReadonlyArray<readonly string[]> = [
      ['leftFoot', 'leftToes'],
      ['rightFoot', 'rightToes']
    ]
    interface FootSample {
      frame: number
      y: number
      x: number
      z: number
    }
    const baseFrames: number[] = []
    for (let index = 0; index < sampleCount; index += 1) {
      baseFrames.push(Math.round((index * (clip.frames - 1)) / (sampleCount - 1)))
    }
    const groupSamples: FootSample[][] = footBoneGroups.map(() => [])
    for (const frame of baseFrames) {
      this.applyClipPoseDirect(clip, frame / fps)
      scene.updateWorldMatrix(true, true)
      for (let groupIndex = 0; groupIndex < footBoneGroups.length; groupIndex += 1) {
        let lowestY = Infinity
        let bestX = 0
        let bestZ = 0
        for (const boneName of footBoneGroups[groupIndex]) {
          const node = humanoid.getRawBoneNode(
            boneName as Parameters<typeof humanoid.getRawBoneNode>[0]
          )
          if (!node) continue
          node.getWorldPosition(this.tmpFootWorld)
          scene.worldToLocal(this.tmpFootWorld)
          if (this.tmpFootWorld.y < lowestY) {
            lowestY = this.tmpFootWorld.y
            bestX = this.tmpFootWorld.x
            bestZ = this.tmpFootWorld.z
          }
        }
        if (Number.isFinite(lowestY)) {
          groupSamples[groupIndex].push({ frame, y: lowestY, x: bestX, z: bestZ })
        }
      }
    }
    const speeds: number[] = []
    for (const samples of groupSamples) {
      if (samples.length < 2) continue
      const ys = samples.map((sample) => sample.y)
      const minY = Math.min(...ys)
      const maxY = Math.max(...ys)
      const threshold = minY + 0.2 * Math.max(0, maxY - minY)
      // 循环 clip：支撑相可能跨 loop 接缝 → 追加「下一循环的首个采样帧」参与配对。
      const extended: FootSample[] = clip.loop
        ? [...samples, { ...samples[0], frame: samples[0].frame + clip.frames }]
        : samples
      for (let index = 1; index < extended.length; index += 1) {
        const previous = extended[index - 1]
        const current = extended[index]
        if (previous.y > threshold || current.y > threshold) continue
        const dtSec = (current.frame - previous.frame) / fps
        if (!(dtSec > 0)) continue
        const distance = Math.hypot(current.x - previous.x, current.z - previous.z)
        speeds.push(distance / dtSec)
      }
    }
    if (speeds.length === 0) return null
    speeds.sort((a, b) => a - b)
    const median = speeds[Math.floor(speeds.length / 2)]
    // 速度过小（≈静止）视为不可用，让 playbackRate 回退旧公式。
    return median > 0.02 ? median : null
  }

  /* ------------------------------ 缺骨 / 杂项 ------------------------------ */

  /** 模型缺主 normalized 骨、已回退到 fallback 骨时 warn 一次（避免每帧刷屏）。 */
  private warnBoneFallback(primary: VrmBoneName, fallback: VrmBoneName): void {
    const key = `${primary}->${fallback}`
    if (this.warnedBoneFallbacks.has(key)) return
    this.warnedBoneFallbacks.add(key)
    console.warn(
      `[vrm-clip-player] 模型缺少 normalized 骨 ${primary}，已回退到 ${fallback} 播放该骨动作（只提示一次）`
    )
  }

  /** clip 引用但模型缺的骨（只报「确实有非 identity 动画」的骨；模型缺 upperChest 等常见差异不误报）。 */
  private missingBonesFor(clip: ParsedClip): string[] {
    const cached = this.missingBonesCache.get(clip)
    if (cached !== undefined) return cached
    const missing: string[] = []
    for (const boneName of clip.bones.keys()) {
      const vrmName = (UNITY_TO_VRM_BONE as Readonly<Record<string, VrmBoneName>>)[boneName]
      if (vrmName === undefined) {
        // clip 里出现映射表之外的 Unity 骨名：无法应用，报出来排障。
        missing.push(boneName)
        continue
      }
      if (this.nodes.has(vrmName)) continue
      // 目标缺 upperChest 但 chest 存在：该轨道已按 α-fold 折叠进 chest/子骨
      // （applyFrame / upper-chest-fold.ts），不算「缺骨未应用」的误报。
      if (boneName === 'UpperChest' && this.nodes.has('chest')) continue
      if (isBoneTrackNonIdentity(clip, boneName, 0.5)) missing.push(vrmName)
    }
    this.missingBonesCache.set(clip, missing)
    return missing
  }

  /** 交叉淡入权重（0–1，smoothstep；无 fade = 1）。 */
  private fadeWeight(): number {
    const fade = this.fade
    if (fade === null || fade.durationSec <= 0) return 1
    return smoothstep(clamp(fade.elapsedSec / fade.durationSec, 0, 1))
  }

  /** 安全时钟：注入 `now` 非法时回退 `performance.now()`。 */
  private nowSafely(): number {
    try {
      const value = this.now()
      if (isFiniteNumber(value)) return value
    } catch {
      // ignore
    }
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  }

  /** 注入随机源安全读取（[0,1)，非法回退 0.5）。 */
  private randomSafely(): number {
    try {
      const value = this.random()
      return isFiniteNumber(value) ? clamp(value, 0, 1) : 0.5
    } catch {
      return 0.5
    }
  }

  /** 随机取一个元素（空数组调用方保证非空）。 */
  private pickRandom<T>(items: readonly T[]): T {
    const index = Math.min(items.length - 1, Math.floor(this.randomSafely() * items.length))
    return items[Math.max(0, index)]
  }

  /** 请求序号自增（异步 clip 加载完成时只允许最新请求生效）。 */
  private advanceRequestToken(): number {
    this.requestToken += 1
    return this.requestToken
  }
}

/* -------------------------------------------------------------------------- */
/* 工厂                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 创建 `VrmClipPlayer`（冻结接口 `VrmClipPlayer` 的实现；main.ts 构造后注入 animator）。
 * 构造后需 `await player.init()`。
 */
export function createVrmClipPlayer(
  options: CreateVrmClipPlayerOptions,
  tuning: VrmClipPlayerTuning = {}
): VrmClipPlayerContract {
  return new VrmClipPlayer(options, tuning)
}

/** 便于测试/调试：内部播放参数（不承诺稳定）。 */
export const CLIP_PLAYER_DEFAULTS = Object.freeze({
  /** 普通 mood 切换/无数据时的默认 crossfade（秒）。 */
  crossfadeSec: DEFAULT_CROSSFADE_SEC,
  /** 多动作变体随机切换默认配置（按槽位；可用 `VrmClipPlayerTuning` 覆盖）。 */
  variantSwitch: VARIANT_SWITCH_CONFIG,
  /** 稀有权重默认值（priority ≤ 阈值 → weight；tuning.rareVariant 可覆盖）。 */
  rareVariant: Object.freeze({
    priorityThreshold: RARE_VARIANT_PRIORITY_THRESHOLD,
    weight: RARE_VARIANT_WEIGHT
  }),
  minPlaybackRate: MIN_PLAYBACK_RATE,
  maxPlaybackRate: MAX_PLAYBACK_RATE,
  naturalWalkSpeedHeightFactor: NATURAL_WALK_SPEED_HEIGHT_FACTOR,
  /** pose grounding 兜底每 clip 采样帧数上限。 */
  poseGroundMaxSamples: POSE_GROUND_MAX_SAMPLES,
  /** 参与变体轮换的最低 priority（更低 = 特殊动作，仅按 id 播放）。 */
  variantRotationMinPriority: VARIANT_ROTATION_MIN_PRIORITY
})
