/**
 * V1/V5/V6 VRM 运行时共享接口 —— **Lead-owned，并行实现基线（冻结给实现线对接）**。
 *
 * 本文件只放模块边界上真正共享的类型：`avatar-loader` 产出 `VrmAvatar`，
 * `clip-player` 实现 `VrmClipPlayer`，`expression-layer` 实现 `VrmExpressionLayer`，
 * `animator` 把它们组合成 `PoseDriver`。各模块内部私有类型自行定义。
 *
 * 约定：
 * - 接口只增不改；实现线发现缺口先发消息给 Lead（不要自己改本文件/冻结契约）；
 * - 不 import Electron / DOM；three / three-vrm 只作为类型（`import type`）；
 * - 设计说明见 `docs/wave2-vrm-runtime-design.md` §4。
 */
import type { VRM } from '@pixiv/three-vrm'
import type { Group, LoadingManager, Object3D } from 'three'

import type { PetMood } from '@shared/types'
import type { VrmAvatarAsset, VrmAvatarCapabilities } from '@shared/vrm'

import type { VrmMicroMotionOptions } from './micro-motion'
import type { HandPropClipMeta } from './prop-config'
import type { HandPropLayer } from './prop-layer'

import type { AnimationInput, PoseDriver } from '../core/wave2-contract'

/* ========================================================================== */
/* 资产加载（src/renderer/src/vrm/avatar-loader.ts）                            */
/* ========================================================================== */

/**
 * 加载完成、可直接播放的 VRM 资产（V1 `avatar-loader` 产出）。
 *
 * 坐标/单位约定（与 clip 数据一致，见 `docs/vrm-motion-hsr.md` §1.2）：
 * - VRM0 已用 `VRMUtils.rotateVRM0()` 归一化到 VRM1 约定（面向 +Z、左手 +X）；
 * - 世界单位为**米**，`vrm.scene` 放在原点时脚底 ≈ y=0（除非模型本身 rest 有偏移，
 *   由 `restFeetY` 记录）；
 * - `scene` 的父级由场景层（`pet-scene-vrm.ts`）包一层 `Group` 做摆放/缩放。
 */
export interface VrmAvatar {
  /** manifest 里的资产描述（id/file/expressions/lookAt/yawOffsetDeg/…）。 */
  readonly asset: VrmAvatarAsset
  /** three-vrm 实例（`vrm.update(dt)` 驱动 spring bone / 表情材质 / 内建 lookAt）。 */
  readonly vrm: VRM
  /** 模型根（= `vrm.scene`；VRM0 归一化后不会被额外旋转）。 */
  readonly scene: Object3D
  /** 实测能力（humanoid 骨、expression、spring 链、lookAt、内嵌 animations）。 */
  readonly capabilities: VrmAvatarCapabilities
  /** rest（T/A-pose）包围盒高（米）；场景用它做「宠物高度 px → 缩放」的基准。 */
  readonly restHeightMeters: number
  /** rest 包围盒脚底相对 `scene` 原点的 y（米，通常 ≈0）。摆放时 `feetY - restFeetY`。 */
  readonly restFeetY: number
  /**
   * 躯干宽/身高（不是 T-pose 臂展）；用于宠物矩形宽高比（命中区/物理半宽）。
   * 由 normalized rest 肩/髋骨位置估算并 clamp，V5 实机可再调。
   */
  readonly bodyAspectRatio: number
  /**
   * normalized rest pose 的 hips 高度（米，`humanoid.normalizedRestPose.hips.position[1]`）。
   * Hips.p 位移缩放基准：`p * (hipsRestHeight / clip.sourceHipsHeight)`。
   */
  readonly hipsRestHeight: number
  /** 材质名（MToon；调试面/验收用）。 */
  readonly materialNames: readonly string[]
  /** expressionManager 里的 expression 名（调试面：`model.morphNames`）。 */
  readonly expressionNames: readonly string[]
  /** 经 LoadingManager 成功加载的贴图数。 */
  readonly textureCount: number
  /** 加载失败的贴图文件名（验收应为空；重试 loader 已做单张退避）。 */
  readonly missingTextures: readonly string[]
  /** 顶点/三角形（性能对照 PMX 32966/51829）。 */
  readonly vertexCount: number
  readonly triangleCount: number
  /** 释放 GL 资源/贴图（模型切换/退出用；可重复调用）。 */
  dispose(): void
}

/** `loadVrmAvatar` 可选参数（由场景层注入，便于单测/预览复用）。 */
export interface LoadVrmAvatarOptions {
  /** `pet-asset://assets/<file>` 或 http(s) URL（由场景层解析）。 */
  url: string
  /** 贴图追踪/重试用 LoadingManager（生产由场景层传入 `createPetAssetLoadTracker().manager`）。 */
  manager?: LoadingManager
  /** 是否在加载时对 GLB JSON 做 W0-5 数据修复（旧资产需要；tpose 模型不需要）。 */
  patchGlbOnDemand?: boolean
}

/* ========================================================================== */
/* 场景 → 动画工厂（src/renderer/src/vrm/pet-scene-vrm.ts / main.ts）            */
/* ========================================================================== */

/** `VrmPetScene` 创建动画驱动时给出的上下文（Lead 在 main.ts 里用它组合 animator）。 */
export interface VrmPoseDriverContext {
  avatar: VrmAvatar
  /** 场景层包装的模型根 Group（摆放/缩放/朝向由场景负责，animator 只读）。 */
  root: Group
  /** 当前动作集 id（`config.motionSet`，默认 `default`）。 */
  motionSet: string
}

/**
 * VRM 动画驱动工厂：`VrmPetScene.loadModel()` 在 avatar 加载完成后调用；
 * 允许返回 Promise（clip/expression manifest 需要异步加载）。返回 null = 降级为静态 rest。
 */
export type VrmPoseDriverFactory = (
  context: VrmPoseDriverContext
) => PoseDriver | null | Promise<PoseDriver | null>

/* ========================================================================== */
/* 脚部固定（src/renderer/src/vrm/foot-lock.ts）                                */
/* ========================================================================== */

/**
 * 脚部固定可选参数（`VrmFootLock` 构造参数；全部有默认值）。
 *
 * 语义见 `foot-lock.ts` 文件头：接触判定（抬升/速度双条件 + 迟滞）、锚点位置/朝向、
 * 有界骨盆下沉、释放条件。默认值按本项目的待机动作实测调过（540px 宠物高）。
 */
export interface VrmFootLockOptions {
  /** false = 完全不启用（默认 true）。 */
  enabled?: boolean
  /** 进入接触允许的踝骨抬升（米，相对 rest 踝高；默认 0.03）。 */
  contactEnterLiftM?: number
  /** 退出接触的抬升阈值（米；迟滞，默认 0.05）。 */
  contactExitLiftM?: number
  /** 进入接触允许的最大水平速度（米/秒；默认 0.25）。 */
  contactEnterSpeedMps?: number
  /** 保持接触允许的最大水平速度（米/秒；超过视为抬脚/换步，默认 0.9）。 */
  contactHoldSpeedMps?: number
  /** 接触权重淡入时间常数（秒；默认 0.08）。 */
  weightTauInSec?: number
  /** 接触权重淡出时间常数（秒；默认 0.15）。 */
  weightTauOutSec?: number
  /** 骨盆最多下沉（米；保证脚可达且避免明显下蹲，默认 0.04）。 */
  maxPelvisDropM?: number
  /** 骨盆下沉平滑时间常数（秒；默认 0.12）。 */
  pelvisDropTauSec?: number
  /** 是否同时锚定脚的朝向（默认 true；false = 只锚位置，脚可随 clip 旋转）。 */
  anchorOrientation?: boolean
  /**
   * 锚点-作者姿态对齐模式（2026-11-11 v2，`foot-lock.ts`）：
   * - `'3d'`（默认）：候选 g —— 3-DOF 骨盆距离保持解，让 pinned 腿的髋→踝距离等于作者姿态
   *   （膝角 ≈ 作者），δy 即骨盆升降；
   * - `'mean'`：旧 A —— 锚点与作者踝位的均值水平平移（≤0.18m/5mm deadband/τ0.3s）。
   *   作为一键回滚通道（真机 A/B 用）；fallback 时本模块会在单帧内临时回落到 `'mean'` 语义。
   */
  stanceAlignMode?: '3d' | 'mean'
  /**
   * 换姿势重锚（stance replant，2026-11-11）：idle 变体换 clip 时，把脚锚点从旧站姿
   * **抬脚重踏**到新 clip 的作者站姿；默认 true。false = 完全恢复旧行为（跨 clip 保持锚点），
   * 供真机 A/B 与一键回滚。`stanceAlignMode:'mean'` 时自动关闭（保持旧回滚通道纯净）。
   */
  poseReplant?: boolean
  /** replant：水平位移小于该值（米）走「迷你混合」（不抬脚、0.15s 平滑搬锚点，默认 0.012）。 */
  replantMinMoveM?: number
  /**
   * replant：抬脚弧线峰值下限（米；默认 0.012）。设计初值 0.010；离线验收实测 0.010 时
   * 小步（d≈3.6cm）的接地滑移 8.7px@540 超 6px 门禁，0.012 时 5.7px（视觉差 2mm≈0.6px）。
   */
  replantLiftMinM?: number
  /** replant：抬脚弧线峰值上限（米；实际 h=clamp(0.15·d, liftMin, 本值)，默认 0.030）。 */
  replantLiftMaxM?: number
  /** replant：单脚水平移动速度上限（米/秒；T=clamp(d/本值, 0.30, 0.45)，默认 0.45）。 */
  replantMaxSpeedMps?: number
  /** replant：单脚最短换步时长（秒，默认 0.30）。 */
  replantMinDurationSec?: number
  /** replant：单脚最长换步时长（秒，默认 0.45）。 */
  replantMaxDurationSec?: number
  /** replant：两脚换步间隔（秒；后一脚在前一脚完成 + 本值后开始，默认 0.08）。 */
  replantStepGapSec?: number
}

/** 脚部固定调试快照（`window.__aventurineDebug.animation.footLock` 来源）。 */
export interface VrmFootLockDebugSnapshot {
  enabled: boolean
  leftPinned: boolean
  rightPinned: boolean
  /** 接触权重（0–1，两位小数）。 */
  leftWeight: number
  rightWeight: number
  /** 当前应用的骨盆下沉（米）。 */
  pelvisDropM: number | null
  /** 踝锚点残差（米；null = 未钉住/无数据）。 */
  leftFootErrorM: number | null
  rightFootErrorM: number | null
  /** 踝骨相对 rest 踝高的抬升（米；null = 无数据）。 */
  leftFootLiftM: number | null
  rightFootLiftM: number | null
  /**
   * 锚点-作者姿态对齐当前施加的 hips 偏移（米；非累积，离开 idle 平滑归零）。
   * `hipShiftXM/ZM` 语义与旧 A 一致（x/z 水平偏移，L2 pointer-rect 消费方不回归）；
   * `hipShiftYM` 为 v2 新增（g 的骨盆升降，正 = 抬升、负 = 下沉）。
   */
  hipShiftXM?: number | null
  hipShiftYM?: number | null
  hipShiftZM?: number | null
  /**
   * g：最近一帧「钳制后」的最大距离残差（米；`||hip+δ−pin| − d_author|` 的最大值）。
   * fallback 判据 = 该值 > 10mm 或 NaN；正常 <0.5mm。null = 无 pinned 脚。
   */
  stanceSolveResidualM?: number | null
  /** 本帧生效的对齐模式（'3d' = 距离保持解；'mean' = 旧 A 回退/强制回退）。 */
  stanceAlignMode?: '3d' | 'mean'
  /** g：最近一帧 Gauss-Newton 迭代数（性能/调参用；单脚解析分支为 0）。 */
  stanceSolveIterations?: number
  /**
   * 脚朝向软跟随（B）后，左右脚当前朝向相对（跟随后的）锚点的偏差（度；0 = 完全对齐）。
   * 可选：`anchorOrientation=false` 或无接触时为 null。
   */
  leftFootOrientationErrDeg?: number | null
  rightFootOrientationErrDeg?: number | null
  /**
   * IK 后的运行时膝屈曲角（度；180 = 完全伸直；髋-膝-踝三点夹角口径）。
   * 与 `authorKneeFlexDeg*` 对比量化「运行时把腿弯了多少度」；dev-capture JSON 断言用。
   */
  kneeFlexDegL?: number | null
  kneeFlexDegR?: number | null
  /** 本帧 IK 前（clip+micro 已写）作者姿态的膝屈曲角（度；口径同上）。 */
  authorKneeFlexDegL?: number | null
  authorKneeFlexDegR?: number | null
  /**
   * replant（换姿势重锚）：已检测到 clip 变化、等待 crossfade 结束（此时接触状态冻结）。
   * 可选：旧消费方不填也合法。
   */
  replantPending?: boolean
  /** replant：当前是否有脚在换步（含等待错峰/迷你混合；settle 期为 false）。 */
  replantActive?: boolean
  /** replant：左/右脚当前是否处于换步状态（含等待错峰）。 */
  leftReplantActive?: boolean
  rightReplantActive?: boolean
  /** replant：左/右脚本帧的抬脚弧线高度（米；迷你混合/等待期为 0；null = 未在换步）。 */
  leftReplantLiftM?: number | null
  rightReplantLiftM?: number | null
  /** replant：左/右脚 pin 到本次目标的水平残差（米；落地后 null）。 */
  leftReplantTargetErrM?: number | null
  rightReplantTargetErrM?: number | null
    /** 最近一帧 IK 后踝骨 scene 局部 x/z（米；dev-capture 断言各站姿=作者用；null = 未锁）。 */
    leftFootX?: number | null
    leftFootZ?: number | null
    rightFootX?: number | null
    rightFootZ?: number | null
}

/* ========================================================================== */
/* clip 播放（src/renderer/src/vrm/clip-player.ts）                             */
/* ========================================================================== */

/** clip-player 每帧/调试快照（`animator` 映射到冻结的 `AnimationDebugSnapshot`）。 */
export interface VrmClipDebugSnapshot {
  /** 当前主 clip id（app-manifest/catalog 的 id；null = 未播放/未就绪）。 */
  clipId: string | null
  /** 当前 clip 绑定的槽位（mood/salute/one-shot 事件名/`manual`；null = 无）。 */
  slot: string | null
  /** 当前播放时间（秒）。 */
  timeSec: number
  /** 交叉淡入权重（0–1；1 = 已稳定）。 */
  weight: number
  /** 是否处于淡入/淡出切换中。 */
  fading: boolean
  /** 播放速率（`entry.timeScale` × 走路速度匹配；1 = 原速）。 */
  playbackRate: number
  /** 本帧成功写入的骨数（normalized humanoid）。 */
  bonesApplied: number
  /** clip 引用但模型缺的骨（应为空；排障用）。 */
  missingBones: string[]
  /** 脚底贴地误差（CSS px；grounding=none/坐/睡/腾空时 null）。 */
  footErrorPx: number | null
  /** 本帧应用的竖直贴地补偿（米；正 = 向上）。 */
  groundOffsetM: number
  /** 播放器是否就绪（manifest + 至少一个 clip 可用）。 */
  ready: boolean
  /** 已加载 clip 数（调试/性能）。 */
  loadedClipCount: number
  /**
   * 当前姿态中 hips 相对「全 raw humanoid 骨最低点」的高度（米；null = 不可用）。
   * Lead 用于「坐窗口上沿」的视觉锚点：把模型整体下移该高度，使 hips 贴窗沿、腿垂下。
   */
  poseHipsAboveLowestM?: number | null
  /** walk/climb clip 的步幅地速（米/秒；用于 playbackRate 校准以减少脚滑；null = 不可用）。 */
  clipStrideGroundSpeedMps?: number | null
}

/** `clip-player` 对外接口（`animator.ts` 每帧调用 `update`）。 */
export interface VrmClipPlayer {
  /** 拉取 `app-manifest.json` / `app-catalog.json` 并预载常用 clip；失败只降级不抛。 */
  init(): Promise<void>
  readonly ready: boolean
  /** 每帧：选 clip → 推进 → 交叉淡入 → 写 normalized 骨 + Hips 位移 + 贴地。 */
  update(input: AnimationInput): void
  /** 调试/一次性动作：按 app-manifest id 或 catalog id 播放；未知返回 false。 */
  playClipById(id: string, options?: { loop?: boolean; fadeSec?: number; hold?: boolean }): boolean
  /** 调试覆盖 mood（null = 清除；不影响 B1 行为）。 */
  setMoodOverride(mood: PetMood | null): void
  /**
   * 清除当前手动 clip（`playClipById`）并按 `fadeSec` 交叉淡出回当前 mood 选片；
   * 无手动 clip 时 no-op。用于「入场序列/error 过场」被交互或调试打断。
   */
  stopManualClip?(fadeSec?: number): void
  snapshot(): VrmClipDebugSnapshot
  dispose(): void
}

/** 创建 `VrmClipPlayer` 的参数（由 `animator.ts` 组装后传入）。 */
export interface CreateVrmClipPlayerOptions {
  avatar: VrmAvatar
  /** 动作集 id（默认 `default`；`app-manifest.json` / `app-catalog.json` 所在目录）。 */
  motionSet?: string
  /**
   * 私有 JSON 文本拉取（`pet-asset://assets/...`）。默认实现用 `fetch`；
   * 单测注入假实现（不依赖 DOM/Electron）。
   */
  fetchText?: (url: string) => Promise<string>
  /** 注入随机源（待机变体轮换/相位；单测 seeded）。 */
  random?: () => number
  /** 注入时钟毫秒（默认 `performance.now`；单测假时钟）。 */
  now?: () => number
  /**
   * 当前 1 米 = 多少 CSS px（场景缩放后由 animator 提供；用于把贴地误差米数换算成 px，
   * 以及按生理步速匹配 `playbackRate`）。未提供时 `footErrorPx` 返回 null。
   */
  getPixelsPerMeter?: () => number
}

/* ========================================================================== */
/* 表情层（V6：src/renderer/src/vrm/expression-layer.ts）                       */
/* ========================================================================== */

/** 表情层调试快照（`animator` 映射到 `AnimationDebugSnapshot`）。 */
export interface VrmExpressionDebugSnapshot {
  ready: boolean
  /** 眨眼权重（0–1）。 */
  blink: number
  /** 微笑类表情权重（0–1；happy 绑定）。 */
  smile: number
  /** 口型开合度（0–1）。 */
  mouthOpen: number
  /** 当前自动触发 id（pat/drag/dshDone/…；null = 无）。 */
  trigger: string | null
  /** 当前表情 clip id（null = 只用 preset 权重）。 */
  clipId: string | null
  /** 本帧写入的非零权重（expression 名 → 0–1）。 */
  weights: Record<string, number>
}

/** 表情层（V6 实现；`animator.ts` 组合）。 */
export interface VrmExpressionLayer {
  init(): Promise<void>
  readonly ready: boolean
  /** 每帧：合成情绪/眨眼/口型/反应 → 写 `vrm.expressionManager.setValue`。 */
  update(input: AnimationInput, dtSec: number): void
  forceBlink(): void
  snapshot(): VrmExpressionDebugSnapshot
  dispose(): void
}

/** 创建表情层参数。 */
export interface CreateVrmExpressionLayerOptions {
  avatar: VrmAvatar
  fetchText?: (url: string) => Promise<string>
  random?: () => number
  /** false = 完全不驱动表情（排障/性能对照用）。 */
  enabled?: boolean
}

/* ========================================================================== */
/* look-at 层（V6：src/renderer/src/vrm/look-at.ts）                            */
/* ========================================================================== */

/** procedural look-at 层（目标模型无 VRM lookAt 时用手动头/眼 additive 旋转）。 */
export interface VrmLookAtLayer {
  /** 每帧在 clip 写骨之后、`humanoid.update()` 之前调用（additive）。 */
  update(input: AnimationInput): void
  /** 调试强制角度（度）；null = 清除覆盖、回到输入驱动。 */
  setOverride(yawDeg: number | null, pitchDeg?: number | null): void
  snapshot(): { yaw: number | null; pitch: number | null }
  dispose(): void
}

/** 创建 look-at 层参数。 */
export interface CreateVrmLookAtOptions {
  avatar: VrmAvatar
}

/* ========================================================================== */
/* animator 组合层（src/renderer/src/vrm/animator.ts，Lead）                     */
/* ========================================================================== */

/** 入场序列单步（catalog clip id + 播放秒数；loop=true 时作为循环步骤，由下一步打断）。 */
export interface VrmIntroStep {
  clipId: string
  /** 该步骤持续秒数（到点进入下一步；最后一步到点结束序列）。 */
  seconds: number
  loop?: boolean
}

/** 启动入场序列（app 启动后、玩家第一次交互前；可被交互/调试打断）。 */
export interface VrmIntroSequence {
  steps: readonly VrmIntroStep[]
  /** false = 不播放（默认 true）。 */
  enabled?: boolean
}

/** mood 进出场过渡 clip（一次性；enter 在进入该 mood 时播，exit 在离开时播）。 */
export interface VrmMoodTransitionClips {
  /**
   * 进入过渡 clip：字符串 = 固定一条；数组 = 每次进入该 mood 时等概率随机取一条
   * （如 hsr-breaked / adv-die 随机倒地）。
   */
  enterClip?: string | readonly string[]
  /** enter clip 播完是否停在末帧（true = 保持倒地/蹲伏姿态直到离开该 mood）。 */
  enterHold?: boolean
  /**
   * 离开过渡 clip：字符串 = 固定一条；数组 = 每次离开该 mood 时等概率随机取一条
   * （当前主要用于进入方向的随机倒地）。
   */
  exitClip?: string | readonly string[]
  /** exit clip 播完是否停在末帧（一般 false：播完回当前 mood）。 */
  exitHold?: boolean
}

/** `createVrmPetAnimator` 参数（由 main.ts 的 createPoseDriver 组装）。 */
export interface CreateVrmPetAnimatorOptions {
  avatar: VrmAvatar
  root: Group
  motionSet?: string
  random?: () => number
  now?: () => number
  fetchText?: (url: string) => Promise<string>
  /** 表情层（V6；未传 = 不驱动表情）。 */
  expressionLayer?: VrmExpressionLayer
  /** look-at 层（V6；未传 = 不附加注视）。 */
  lookAtLayer?: VrmLookAtLayer
  /**
   * clip 播放器（由 main.ts 用 `createVrmClipPlayer` 构造后注入；未传 = 静态 rest）。
   * 注入而不是内部 new，避免 animator 依赖 clip 模块具体实现（便于单测/降级）。
   */
  clipPlayer?: VrmClipPlayer
  /** 是否启用 clip 播放（false = 静态 rest，排障用）。 */
  clipsEnabled?: boolean
  /**
   * 是否启用脚部固定（foot planting；默认 true）。
   *
   * 2026-11-09 重做后只对**静止动作**生效（idle/pat/dsh* 等；walk/climb/fall/drag/grabWindow/sit/
   * sleep 一律不锁）：待机变体 crossfade 期间把接触脚钉在锚点上，消除「腰不动、脚在地面滑」。
   * 走路滑步仍由 clip-player 的步幅地速校准负责（本轮不动，避免回归已验收的走路/拖拽观感）。
   */
  footLock?: boolean
  /**
   * 启动入场序列（catalog clip；app 启动后播一次，玩家第一次交互/拖拽/调试打断）。
   * 例：introStart(2s, 非循环) → introLoop(4.5s, 循环) → introEnd(1.55s, 非循环)。
   */
  introSequence?: VrmIntroSequence
  /**
   * mood 进出场一次性过渡 clip（例如 dshError 进入播 hsr-breaked、离开播 hsr-revive）；
   * 播完自动回到当前 mood 的循环选片。
   */
  moodTransitionClips?: Partial<Record<PetMood, VrmMoodTransitionClips>>
  /**
   * 待机程序化微动层（呼吸/重心/头部漂移；2026-11-10 用户反馈「待机腰不动」）。
   * - `false` = 关闭；缺省 = 启用（只对「基础选片 = idle」生效；模型无 normalized 骨时自动降级）；
   * - 传对象可覆盖幅度缩放/是否施加骨盆位移（见 `VrmMicroMotionOptions`）。
   */
  microMotion?: boolean | VrmMicroMotionOptions
  /**
   * 手持道具层（V1 水枪）；未传 = 不驱动道具显隐。
   * 道具挂在 hand 骨下，本层只按当前 clip 切 visible，不写骨骼。
   */
  handProp?: HandPropLayer
  /**
   * clip id → 道具判定元信息（catalog 的 set/tags）；catalog 未就绪/未知 clip 返回 null
   * → 道具隐藏（宁可空手也不要在普通动作里举枪）。
   */
  resolveHandPropClipMeta?: (clipId: string | null) => HandPropClipMeta | null
}

/** `animator` 额外暴露的异步就绪信号（clip/expression manifest 加载）。 */
export interface VrmPetAnimator extends PoseDriver {
  /** clip/expression 层初始化完成（失败也会 resolve，`ready=false` 时降级）。 */
  readonly ready: Promise<void>
  /** 当前主 clip id（调试/冒烟断言；未就绪 null）。 */
  readonly currentClipId: string | null
  /** 调试覆盖 mood（null = 清除；只影响 animator 传给 clip-player 的 input.mood）。 */
  setMoodOverride(mood: PetMood | null): void
  /**
   * 手动播放一条 catalog/app-manifest clip（一次性/循环可选），播完自动回当前 mood。
   * 用于 DSH 工作小动作（skill01/02）与 error 过场；返回 false = clip 未知/未就绪。
   */
  playOneShotClip(
    id: string,
    options?: { loop?: boolean; fadeSec?: number; hold?: boolean }
  ): boolean
  /** 入场序列是否仍在播放（调试/冒烟用）。 */
  readonly introActive: boolean
  /**
   * 坐窗口风格（用户 2026-11-09）：`lie` = 高窗（窗口上沿在屏幕上半部）→ 躺/趴在窗沿；
   * `sit` = 矮窗（上沿到屏幕一半及以下）→ 坐；null = 非坐姿/自动。
   * 由 main.ts 每帧根据当前 sit 目标表面 top 与 workArea 中线计算后注入。
   */
  setSitWindowStyle(
    mode: 'sit' | 'sitVariant' | 'lie' | null,
    options?: {
      /** lie 模式指定素材（null/缺省 = 在窗沿坐姿变体里随机）。 */
      clipId?: string | null
      /** lie 模式下额外向下位移（px；差几像素时保证头不出屏）。 */
      sinkPx?: number
    }
  ): void
  /** 脚部固定调试快照（调试/验收用；未启用返回 null）。 */
  getFootLockSnapshot(): VrmFootLockDebugSnapshot | null
  /** 释放子层资源（模型切换/退出；可重复调用）。 */
  dispose(): void
}
