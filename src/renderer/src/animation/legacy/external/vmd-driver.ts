/**
 * 外部 VMD 动作层 + B3 混合驱动的**门面**（Wave 2.5 / D1）。
 *
 * 实现 `PoseDriver`（`core/wave2-contract.ts`），由 `main.ts` 的 `createPoseDriver` 工厂注入
 * PetScene。与 B3（`createPetAnimator`）组合而非替换：
 *
 * ```
 * 每帧 PetScene.step → driver.update(input)
 *   ├─ 外部动作层（本文件）
 *   │   ├─ 选 clip：manifest（fetch pet-asset://model/motion-index.json）按 mood 匹配
 *   │   ├─ helper.remove(mesh) → helper.add(mesh,{animation:clip,physics:false})
 *   │   ├─ 每帧 helper.update(dt)（**逐帧真实 dt**；绝不用 mixer.setTime+update(0)，见 K1）
 *   │   ├─ 脚底动态贴地：脚骨世界最低点相对 bind 的漂移 → mesh.position.y 补偿（不改 modelRoot）
 *   │   ├─ 切换：120–250ms 淡入（slerp 全骨 + センター/mesh 竖向一起过渡）
 *   │   └─ debug：source='vmd' / clipId / clipTimeSec / externalFootErrorPx / externalIk
 *   └─ B3 程序化层（表情/眨眼/口型继续跑，**骨骼写入关闭**；无可用 VMD 时完全接管）
 * ```
 *
 * 关键契约/决策：
 * - **互斥**：VMD 激活时调 `b3.setBoneWriteEnabled(false)`（B3 只写 morph）；
 *   退出 VMD 时 `helper.remove(mesh)` + `mesh.pose()`，再恢复 B3 骨骼写入；
 * - **表情分工**：VMD clip 里的 morph 轨道在 `vmd-clip.ts` 已剥掉，表情/眨眼/口型 100% 由 B3 驱动
 *   （动画素材实测 morph=0，且外部 morph 名/索引与本模型不保证匹配）；
 * - **additive look-at（D4b）**：VMD 激活时仍在 `helper.update` 之后把「头/颈 30% + 眼球 100%」的
 *   局部旋转增量右乘到 `首/頭/左目先/右目先`（`bone.quaternion.multiply(delta)`）。每帧基于 clip
 *   本帧绝对姿态重新叠加（helper 的 `_restoreBones` 每帧先恢复备份），所以**不会累积**；贴地测量
 *   只依赖脚骨世界坐标，不受头/眼旋转影响。纯逻辑在 `vmd-look-at.ts`（facing ±90° 局部化、
 *   ±31° 钳制、90ms 平滑、鼠标离开 2.5s 回落），语义与 B3 `look-at.ts` 对齐；
 * - **回退**：manifest 缺失/解析失败/clip 加载失败/运行时异常 → 不抛错、不阻塞渲染，
 *   当帧立即回到 B3 程序化 + 恢复 mesh 原始 Y；失败 clip 不再重试（避免每帧打日志）；
 * - **不写 modelRoot**：贴地补偿只改 `mesh.position.y`（SkinnedMesh 自身），保存原值、退出时恢复，
 *   不干扰 PetScene 的摆放/缩放/resize 逻辑。
 */

import { Euler, LoopOnce, LoopRepeat, Quaternion, Vector3 } from 'three'
import type { AnimationAction, AnimationMixer, Bone, Object3D, SkinnedMesh } from 'three'
import type { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'

import type { PetMood } from '@shared/types'

import { buildPetAssetUrl } from '../../../assets/pet-asset'
import type { AnimationDebugSnapshot, AnimationInput, PoseDriver } from '../../../core/wave2-contract'
import { createPetAnimator, type PetAnimator } from '../scene-bridge'
import { MAX_DT_SEC, type Euler3 } from '../types'
import {
  footGroundingErrorPx,
  groundingOffsetLocalY,
  expectedFootGroundWorldY,
  lowestFootWorldY
} from './grounding'
import {
  MOTION_MANIFEST_FILE,
  parseMotionIndex,
  type IkMode,
  type MotionClipDef,
  type MotionManifest
} from './manifest'
import {
  clampCrossfadeMs,
  effectiveNominalSpeedPxPerSec,
  horizontalSpeedOf,
  resolvePlaybackRate,
  selectClipForMood
} from './selection'
import { createVmdClipLoader, setHelperIkMode, type VmdClipInfo } from './vmd-clip'
import { VmdLookAtController, type VmdLookAtResult } from './vmd-look-at'

/** 默认 manifest 加载失败重试（次数/间隔；素材是本地文件，值得容忍「app 先起、素材后到」）。 */
/** 窗沿坐：当表面高于底部不足该比例时（≈地面/Dock），仍按脚底贴地处理（避免腿掉出屏幕）。 */
const SEATED_HIPS_MIN_ELEVATION_RATIO = 0.2

const DEFAULT_MANIFEST_RETRY_COUNT = 2
const DEFAULT_MANIFEST_RETRY_DELAY_MS = 3000

/** 脚骨探针白名单（D 链 = 蒙皮骨；FK 链兜底；取世界最低点做整体贴地补偿）。 */
const FOOT_BONE_CANDIDATES: readonly string[] = [
  '左足首D',
  '右足首D',
  '左足先EX',
  '右足先EX',
  '左つま先',
  '右つま先',
  '左足首',
  '右足首',
  '左足D',
  '右足D'
]

/** clip 加载状态机（按 id 缓存；失败不重试）。 */
type ClipState =
  | { status: 'loading' }
  | { status: 'ready'; info: VmdClipInfo }
  | { status: 'failed'; error: string }

/** 淡入状态：从捕获姿态过渡到当前目标姿态（骨骼 quaternion/position + mesh 竖向补偿）。 */
interface PoseFade {
  readonly bones: ReadonlyArray<{
    bone: Bone
    quaternion: Quaternion
    position: Vector3
  }>
  readonly startMs: number
  readonly durationMs: number
  /** 淡入开始时 `mesh.position.y`（贴地补偿/回退之间的竖向过渡，避免 17px 跳变）。 */
  readonly meshYFrom: number
}

/** `createHybridAnimator` 选项（main.ts 传 mesh/root/helper；单测传 mock）。 */
export interface CreateHybridAnimatorOptions {
  /** MMDLoader 产出的 SkinnedMesh（PetScene 的 mesh；B3 与 VMD 共用）。 */
  mesh: SkinnedMesh
  /** 模型根 Group（PetScene.modelRoot；贴地换算用它的世界缩放/位置，**不写它**）。 */
  root: Object3D
  /** PetScene 已创建并 add 过 mesh 的 MMDAnimationHelper（physics:false）。 */
  helper: MMDAnimationHelper
  /** 注入时钟（毫秒；默认 performance.now；单测假时钟）。 */
  now?: () => number
  /** 注入随机源（透传 B3：眨眼/待机变体）。 */
  random?: () => number
  /** 注入 B3 animator（默认 `createPetAnimator`；单测 mock）。 */
  b3?: PetAnimator
  /** 注入 manifest 加载（默认 `fetch(pet-asset://model/motion-index.json)`；单测 mock）。 */
  loadManifest?: () => Promise<unknown>
  /** 注入单 clip 加载（默认 `createVmdClipLoader`；单测 mock）。 */
  loadClip?: (def: MotionClipDef) => Promise<VmdClipInfo>
  /** 外部动作总开关（默认 true；false = 纯 B3，便于 A/B 回归）。 */
  externalEnabled?: boolean
  /** manifest 加载失败重试次数（默认 2；0 = 不重试，单测用）。 */
  manifestRetryCount?: number
  /** manifest 重试间隔（毫秒；默认 3000）。 */
  manifestRetryDelayMs?: number
}

/** 外部动作层调试状态（`getExternalState()`；冒烟/排障用，不属于冻结契约）。 */
export interface HybridExternalState {
  externalEnabled: boolean
  manifestLoaded: boolean
  manifestClipIds: string[]
  loadedClipIds: string[]
  activeClipId: string | null
  source: 'procedural' | 'vmd'
  /** 当前 IK 模式（未激活时 null）。 */
  currentIk: IkMode | null
  /** 当前播放速率（walk 速度匹配；未激活/非 walk 时 1）。 */
  playbackRate: number
  /** 调试强制姿态 / setPose 导致的外部动作暂停（`setPose('auto')` 恢复）。 */
  externalSuspended: boolean
  warnings: string[]
  disabledReason: string | null
}

/** 混合驱动对外接口：PoseDriver + 外部动作调试面。 */
export interface HybridAnimator extends PoseDriver {
  /** 外部动作层状态（渲染进程没有动画专用调试钩子时，冒烟/控制台可用）。 */
  getExternalState(): HybridExternalState
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function smoothstep01(value: number): number {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

/** 从 SkinnedMesh 骨架里挑出脚骨探针（不存在则空数组 → 跳过贴地补偿，不报错）。 */
function collectFootBones(mesh: SkinnedMesh): Bone[] {
  const result: Bone[] = []
  const skeleton = mesh?.skeleton
  if (!skeleton || typeof skeleton.getBoneByName !== 'function') return result
  for (const name of FOOT_BONE_CANDIDATES) {
    const bone = skeleton.getBoneByName(name)
    if (bone) result.push(bone)
  }
  return result
}

/** 读取 mixer（helper.add 后才存在；对 mock helper 也安全）。 */
function mixerOf(helper: MMDAnimationHelper, mesh: SkinnedMesh): AnimationMixer | null {
  try {
    return helper.objects.get(mesh)?.mixer ?? null
  } catch {
    return null
  }
}

/**
 * 创建混合动画驱动（VMD 外部动作 + B3 程序化）。
 *
 * 行为：
 * - 启动时异步加载 manifest（不阻塞首帧）；加载到 clip 后按 mood 自动激活；
 * - 无 VMD/加载失败/运行时异常 → 完全回退 B3（与现状一致）；
 * - `debugSetPose`（B3 setPose）非 `'auto'` 时暂停外部动作（便于截图 A/B），`'auto'` 恢复。
 */
export function createHybridAnimator(options: CreateHybridAnimatorOptions): HybridAnimator {
  return new HybridDriver(options)
}

class HybridDriver implements HybridAnimator {
  private readonly mesh: SkinnedMesh
  private readonly root: Object3D
  private readonly helper: MMDAnimationHelper
  private readonly now: () => number
  private readonly options: CreateHybridAnimatorOptions

  /** B3 程序化层（VMD 未激活时拥有全部骨骼写入权；VMD 激活时只写 morph）。 */
  private readonly b3: PetAnimator
  /** B3 骨骼写入开关（只在切换时调，避免每帧方法调用）。 */
  private b3BonesEnabled = true
  /** 本帧是否已调用 b3.update（异常回退时避免同帧二次推进 B3 管线）。 */
  private b3UpdatedThisFrame = false

  private externalEnabled: boolean
  private externalSuspended = false
  private disabledReason: string | null = null

  private manifest: MotionManifest | null = null
  private manifestWarnings: string[] = []
  private manifestLoading = false
  private manifestAttempts = 0

  /** clip 加载状态（按 id）。 */
  private readonly clipStates = new Map<string, ClipState>()
  private readonly clipWarnings: string[] = []
  private clipLoader: ((def: MotionClipDef) => Promise<VmdClipInfo>) | null = null

  private active: VmdClipInfo | null = null
  private currentIk: IkMode | null = null
  private playbackRate = 1
  private lastClipTimeSec: number | null = null
  private lastExternalFootErrorPx: number | null = null
  /** 播完的一次性 clip（loop=false）；同一 mood 下不再重播，mood 切走后清除。 */
  private finishedClipId: string | null = null
  private lastSnapshot: AnimationDebugSnapshot | null = null

  /**
   * 跟踪 mesh 当前是否在 helper 内：PetScene 在本驱动创建前已 `helper.add(mesh,{physics:false})`，
   * 正常为 true；用 helper.meshes 实测一次（测试 mock / 异常路径下更准确）。
   */
  private helperHasMesh: boolean
  /** `mesh.position.y` 原值（PetScene 不写 mesh，只写 modelRoot；这里保存/恢复，避免互相污染）。 */
  private readonly baseMeshY: number
  /** 本帧贴地后的目标 `mesh.position.y`（淡入时与起始值混合）。 */
  private frameTargetMeshY: number
  /** 脚骨探针 + bind pose 脚底局部 Y（贴地基准；无脚骨时为 null）。 */
  private readonly footBones: Bone[]
  private readonly restFootLocalMinY: number | null
  /** 淡入（切换动作/回退 B3 时防跳变）。 */
  private fade: PoseFade | null = null

  /** VMD additive look-at：目标骨（首/頭/左目先/右目先；模型缺失则跳过该骨）。 */
  private readonly lookAtBones: {
    neck: Bone | null
    head: Bone | null
    eyeLeft: Bone | null
    eyeRight: Bone | null
  }
  /** センター（读 clip 本帧身体 Y 转角，用于注视局部化；可能为 null）。 */
  private readonly centerBone: Bone | null
  /** VMD additive look-at 状态机（纯逻辑在 `vmd-look-at.ts`）。 */
  private readonly lookAt = new VmdLookAtController()
  /** 调试强制注视（`setGaze`；度；null = 无），VMD 激活时透传给 look-at 控制器。 */
  private forcedGaze: { yawDeg: number; pitchDeg: number } | null = null
  /** 本帧（最近一 VMD 帧）look-at 结果；供 buildSnapshot 输出实际生效的 gaze/lookYaw。 */
  private lastLookAtResult: VmdLookAtResult | null = null
  /**
   * 坐姿锚点骨（`センター`；窗沿坐时把骨盆/臀部对齐到摆放线）。
   *
   * 2026-11-08 用户反馈「腰跟窗口齐平」：此前用 `下半身`（本模型 bind y=13.33，是腰/腹节点），
   * 对齐后腰在窗沿、屁股沉到窗沿下。改用 `センター`（bind y=8.93，骨盆中心）锚定，
   * 屁股/大腿根自然落在窗沿附近，腿往窗沿下悬垂。
   */
  private readonly seatedAnchorBone: Bone | null
  /** 本帧视觉偏移（CSS px；`seatedAnchor='hips'` 时 = mesh.position.y 相对基准的世界偏移）。 */
  private visualOffsetPx = 0
  /** microSway 相位（秒；静态坐姿时叠加极小的呼吸/重心摆动，避免像冻结）。 */
  private swaySec = 0
  /** microSway 需要的骨（上半身/首/頭）。 */
  private readonly swayBones: { spine: Bone | null; neck: Bone | null; head: Bone | null }

  private readonly tmpVector = new Vector3()
  private readonly tmpQuaternion = new Quaternion()
  private readonly tmpEuler = new Euler()

  constructor(options: CreateHybridAnimatorOptions) {
    this.options = options
    this.mesh = options.mesh
    this.root = options.root
    this.helper = options.helper
    this.now = options.now ?? defaultNow
    this.externalEnabled = options.externalEnabled !== false
    this.b3 =
      options.b3 ??
      createPetAnimator({
        mesh: options.mesh,
        root: options.root,
        now: options.now,
        random: options.random
      })

    this.baseMeshY = Number.isFinite(options.mesh.position?.y) ? options.mesh.position.y : 0
    this.frameTargetMeshY = this.baseMeshY
    this.helperHasMesh = Array.isArray(this.helper.meshes)
      ? this.helper.meshes.includes(options.mesh)
      : true
    this.footBones = collectFootBones(options.mesh)
    this.restFootLocalMinY = this.measureRestFootLocalMinY()
    const skeleton = options.mesh.skeleton
    const findBone = (name: string): Bone | null => {
      try {
        return skeleton?.getBoneByName?.(name) ?? null
      } catch {
        return null
      }
    }
    this.lookAtBones = {
      neck: findBone('首'),
      head: findBone('頭'),
      eyeLeft: findBone('左目先'),
      eyeRight: findBone('右目先')
    }
    this.centerBone = findBone('センター')
    this.seatedAnchorBone = findBone('センター') ?? findBone('下半身')
    this.swayBones = {
      spine: findBone('上半身'),
      neck: findBone('首'),
      head: findBone('頭')
    }

    if (!this.externalEnabled) return
    // 启动即异步加载清单（fetch 不阻塞首帧；失败静默回退 B3）。
    void this.loadManifestAndPreload()
  }

  /* ------------------------------- PoseDriver ------------------------------- */

  update(input: AnimationInput): void {
    const safeInput = input ?? ({} as AnimationInput)
    const dt = Number.isFinite(safeInput.dt) ? Math.min(MAX_DT_SEC, Math.max(0, safeInput.dt)) : 0
    this.b3UpdatedThisFrame = false
    try {
      this.updateInner(safeInput, dt)
    } catch (error) {
      this.handleRuntimeFailure(error, safeInput)
    }
    this.lastSnapshot = this.buildSnapshot()
  }

  getDebugSnapshot(): AnimationDebugSnapshot {
    return this.lastSnapshot ?? this.buildSnapshot()
  }

  setPose(poseId: string, fadeMs?: number): boolean {
    const ok = this.b3.setPose(poseId, fadeMs)
    if (!ok) return false
    // 调试强制姿态时暂停 VMD（便于截图 A/B 对比 B3 姿态）；'auto' 恢复自动调度。
    this.externalSuspended = poseId !== 'auto'
    return true
  }

  setGaze(yawDeg: number, pitchDeg: number): void {
    // 调试/冒烟强制注视：VMD 激活时由 additive look-at 生效（B3 骨骼写入是关闭的）。
    this.forcedGaze =
      Number.isFinite(yawDeg) && Number.isFinite(pitchDeg) ? { yawDeg, pitchDeg } : null
    this.lookAt.setForced(yawDeg, pitchDeg)
    this.b3.setGaze(yawDeg, pitchDeg)
  }

  getExternalState(): HybridExternalState {
    const loadedClipIds: string[] = []
    for (const [id, state] of this.clipStates) {
      if (state.status === 'ready') loadedClipIds.push(id)
    }
    return {
      externalEnabled: this.externalEnabled,
      manifestLoaded: this.manifest !== null,
      manifestClipIds: this.manifest ? this.manifest.clips.map((clip) => clip.id) : [],
      loadedClipIds,
      activeClipId: this.active?.def.id ?? null,
      source: this.active ? 'vmd' : 'procedural',
      currentIk: this.active ? this.currentIk : null,
      playbackRate: this.playbackRate,
      externalSuspended: this.externalSuspended,
      warnings: [...this.manifestWarnings, ...this.clipWarnings],
      disabledReason: this.disabledReason
    }
  }

  /* ------------------------------ 每帧调度 ------------------------------ */

  private updateInner(input: AnimationInput, dt: number): void {
    const nowMs = this.now()

    // 2026-11-08 用户要求（参考 Mate-Engine 的拖拽表现）：拖拽时是「被拎起来、四肢自然下垂」，
    // 不应该播 VMD 的甩出/挣扎动作。拖拽期间暂停外部 VMD，交给 B3 的 `drag` 姿态
    // （手臂被拉直上举、躯干拉长、腿自然垂下、脚尖绷直）；松手后下一帧自动恢复 VMD。
    if (input.dragging === true) {
      if (this.active) this.deactivate(nowMs)
      this.driveProcedural(input, nowMs)
      return
    }

    // 非循环 clip 播完 → 回退 B3（D1 的 Idle 循环，Taunt 等一次性动作后续再接事件触发）。
    // 注意用 action.time 原始值（LoopOnce 结束时会恰好 = duration，模 duration 会变 0 → 检测不到）。
    if (this.active && !this.active.def.loop) {
      if (this.readClipActionTimeSec() >= this.active.durationSec - 1e-3) {
        const finishedId = this.active.def.id
        this.deactivate(nowMs)
        this.finishedClipId = finishedId
      }
    }

    const desired = this.selectDesiredClip(input)
    if (desired && !this.clipStates.has(desired.id)) {
      // 预加载全部 clip；mood 命中的 clip 若还没就绪则本帧先走 B3（不阻塞渲染）。
      void this.ensureClipLoaded(desired)
    }
    const ready = desired ? this.getReadyClip(desired.id) : null
    const useVmd = ready !== null && this.externalEnabled && this.disabledReason === null

    if (useVmd && (!this.active || this.active.def.id !== ready.def.id)) {
      this.activate(ready, nowMs)
    } else if (!useVmd && this.active) {
      this.deactivate(nowMs)
    }

    if (this.active) this.driveVmd(input, dt, nowMs)
    else this.driveProcedural(input, nowMs)
  }

  private selectDesiredClip(input: AnimationInput): MotionClipDef | null {
    if (!this.externalEnabled || this.externalSuspended || this.disabledReason !== null) return null
    const mood = (input.mood ?? 'idle') as PetMood
    const clip = selectClipForMood(this.manifest, mood)
    if (clip === null) {
      // 当前 mood 没有外部动作（回退 B3）：视为「切走」，允许一次性 clip 之后再次触发。
      this.finishedClipId = null
      return null
    }
    // 一次性 clip 播完后同一 mood 不再重播；切到别的 clip 后清除标记（可再次触发）。
    if (this.finishedClipId !== null && clip.id !== this.finishedClipId) this.finishedClipId = null
    return clip.id === this.finishedClipId ? null : clip
  }

  private getReadyClip(id: string): VmdClipInfo | null {
    const state = this.clipStates.get(id)
    return state && state.status === 'ready' ? state.info : null
  }

  /** VMD 驱动：helper 逐帧 update → 贴地 → 淡入 → 量残余误差 → B3 只写 morph。 */
  private driveVmd(input: AnimationInput, dt: number, nowMs: number): void {
    const info = this.active!
    this.setB3BonesEnabled(false)

    const mixer = mixerOf(this.helper, this.mesh)
    if (mixer) {
      // walk 类 clip 按当前水平速度调播放速率（非 walk 的 nominal=null → 恒 1）。
      // D3：manifest 的 nominal 以 540px 宠物为参考；按当前宠物高度换算后，
      // 播放速率 = 移动速度 / 该尺寸下的自然步速 → 任意 sizePercent 都不滑步。
      mixer.timeScale = resolvePlaybackRate(
        effectiveNominalSpeedPxPerSec(info.def.nominalSpeedPxPerSec, input.petRect?.height),
        horizontalSpeedOf(input.motion?.velocity)
      )
      this.playbackRate = mixer.timeScale
    }

    // K1（预览器实测坑）：必须逐帧 helper.update(真实 dt)；setTime + update(0) 会因
    // PropertyMixer 跳过 setValue 导致「时间在动、骨架不动」。
    this.helper.update(dt)

    // 防御：VMD/CCDIK 若产出 NaN（坏数据/退化解），立即回退 B3，绝不让 NaN 进渲染（冒烟断言）。
    if (this.hasNonFiniteBonePose()) {
      throw new Error('VMD/IK 输出出现非有限骨骼姿态（NaN/Infinity）')
    }

    // additive look-at（D4b）：在 clip 本帧绝对姿态上右乘 首/頭/目先 局部旋转增量。
    // 只改头/眼，不碰脚骨 → 不影响下面的贴地测量（脚底世界坐标）。
    this.applyVmdLookAt(input, dt, nowMs)

    // 静态/极短坐姿：叠加极小的呼吸/重心摆动（用户反馈坐姿像冻住/僵硬）。
    this.applyMicroSway(dt)
    // 贴地/坐姿锚点目标（在 helper 写完骨骼后用世界坐标算；不改 modelRoot）。
    this.frameTargetMeshY = this.computeFrameTargetMeshY(input)
    this.applyFade(nowMs)
    this.mesh.updateMatrixWorld(true)
    this.measureExternalFootError()

    // B3 只写 morph（表情/眨眼/口型/材质 morph 由 PetScene.materialMorphs.update 读取）。
    // 2026-11-08 用户反馈「点头部出现自卫反应很怪」：外部动作激活时不把一次性反应事件转给 B3
    // （B3 的 pokedHead/pat 等手势是骨骼动画，与 VMD 骨骼层互斥；表情仍由 B3 的 mood/状态驱动）。
    this.b3.update({ ...input, events: [] })
    this.b3UpdatedThisFrame = true
    this.lastClipTimeSec = this.readClipTimeSec(info)
  }

  /** B3 驱动：完全恢复现状行为（骨骼 + 表情），并结束任何外部淡入。 */
  private driveProcedural(input: AnimationInput, nowMs: number): void {
    this.setB3BonesEnabled(true)
    this.b3.update(input)
    this.b3UpdatedThisFrame = true
    this.frameTargetMeshY = this.baseMeshY
    this.visualOffsetPx = 0
    this.applyFade(nowMs)
    this.mesh.updateMatrixWorld(true)
    this.lastClipTimeSec = null
    this.lastExternalFootErrorPx = null
    this.playbackRate = 1
    // B3 接管骨骼后不再叠加 VMD look-at（B3 自己的 look-at 层生效）。
    this.lastLookAtResult = null
  }

  /* ------------------------------ 切换/淡入 ------------------------------ */

  /** 激活 clip：停旧动画 → 重置骨骼 → 挂新 clip → IK 模式 → 循环模式。切换用淡入防跳变。 */
  private activate(info: VmdClipInfo, nowMs: number): void {
    if (this.active && this.active.def.id === info.def.id) return
    this.beginFade(nowMs, clampCrossfadeMs(info.def.crossfadeMs))

    try {
      if (this.helperHasMesh) this.helper.remove(this.mesh)
    } catch (error) {
      console.warn('[animation/external] 切换动作时 helper.remove 失败（忽略）:', errorMessage(error))
    }
    this.helperHasMesh = false
    // 从 bind pose 起一条干净时间线（预览器 resetPlayback 同款：先 pose() 再 add）。
    this.mesh.pose()
    this.mesh.updateMatrixWorld(true)
    this.helper.add(this.mesh, { animation: info.clip, physics: false })
    this.helperHasMesh = true

    this.active = info
    this.applyIkMode(info.def.ik)
    this.configureAction(info)
    this.frameTargetMeshY = this.baseMeshY
    // 新 clip 从头叠加 look-at（清掉上一 clip 的平滑状态；强制注视保留）。
    this.lookAt.reset()
    if (this.forcedGaze) this.lookAt.setForced(this.forcedGaze.yawDeg, this.forcedGaze.pitchDeg)
    this.lastLookAtResult = null
  }

  /** 退出 clip：移除动画、骨骼复位 bind；随后 B3 恢复骨骼写入（淡入从当前姿态接回 B3）。 */
  private deactivate(nowMs: number): void {
    const active = this.active
    if (!active) {
      this.frameTargetMeshY = this.baseMeshY
      return
    }
    this.beginFade(nowMs, clampCrossfadeMs(active.def.crossfadeMs))
    this.active = null
    try {
      if (this.helperHasMesh) this.helper.remove(this.mesh)
    } catch (error) {
      console.warn('[animation/external] 退出动作时 helper.remove 失败（忽略）:', errorMessage(error))
    }
    this.helperHasMesh = false
    try {
      // VMD 可能写过 B3 不管的骨（袖/发/足先EX 等），复位 bind 后交给 B3/弹簧重新覆盖。
      this.mesh.pose()
      this.mesh.updateMatrixWorld(true)
    } catch (error) {
      console.warn('[animation/external] 退出动作时 mesh.pose 失败（忽略）:', errorMessage(error))
    }
    this.lastClipTimeSec = null
    this.lastExternalFootErrorPx = null
    this.lookAt.reset()
    this.lastLookAtResult = null
  }

  /** 捕获当前全身姿态（quaternion + position）+ mesh 竖向，作为淡入起点。 */
  private beginFade(nowMs: number, durationMs: number): void {
    const bones: Array<{ bone: Bone; quaternion: Quaternion; position: Vector3 }> = []
    for (const bone of this.mesh.skeleton?.bones ?? []) {
      if (!bone) continue
      bones.push({
        bone,
        quaternion: bone.quaternion.clone(),
        position: bone.position.clone()
      })
    }
    this.fade = {
      bones,
      startMs: nowMs,
      durationMs: Math.max(0, durationMs),
      meshYFrom: Number.isFinite(this.mesh.position.y) ? this.mesh.position.y : this.baseMeshY
    }
  }

  /**
   * 应用淡入：骨骼从「切换瞬间姿态」slerp/lerp 到当前目标姿态，mesh 竖向从「切换瞬间补偿」混到本帧目标。
   * 目标姿态由每帧的 mixer/B3 重新算（绝对写值），所以只需在目标之上向起点混合。
   */
  private applyFade(nowMs: number): void {
    const fade = this.fade
    if (!fade) {
      if (this.mesh.position.y !== this.frameTargetMeshY) {
        this.mesh.position.y = this.frameTargetMeshY
      }
      return
    }
    const t = fade.durationMs <= 0 ? 1 : clamp01((nowMs - fade.startMs) / fade.durationMs)
    if (t >= 1) {
      this.fade = null
      this.mesh.position.y = this.frameTargetMeshY
      return
    }
    const alpha = smoothstep01(t)
    const keep = 1 - alpha
    for (const item of fade.bones) {
      // 当前值 = 目标；向起点混 keep → 结果 = 起点*keep + 目标*alpha。
      item.bone.quaternion.slerp(item.quaternion, keep)
      item.bone.position.lerp(item.position, keep)
    }
    this.mesh.position.y = fade.meshYFrom * keep + this.frameTargetMeshY * alpha
  }

  private applyIkMode(mode: IkMode): void {
    const enabled = setHelperIkMode(this.helper, mode)
    this.currentIk = enabled ? 'on' : 'off'
  }

  /** 设置 mixer 的循环模式（loop=false 时播完由 updateInner 检测并回退 B3）。 */
  private configureAction(info: VmdClipInfo): void {
    const mixer = mixerOf(this.helper, this.mesh)
    if (!mixer) return
    mixer.timeScale = 1
    const actions = (mixer as unknown as { _actions?: AnimationAction[] })._actions
    const action = actions && actions.length > 0 ? actions[0] : null
    if (!action) return
    if (info.def.loop) {
      action.setLoop(LoopRepeat, Infinity)
      action.clampWhenFinished = false
    } else {
      action.setLoop(LoopOnce, 1)
      action.clampWhenFinished = true
    }
  }

  /* ------------------------------ 贴地/时间 ------------------------------ */

  /** 静态坐姿的微量摆动（加减到已有骨骼旋转上；角度极小，不改变动作语义）。 */
  private applyMicroSway(dt: number): void {
    if (!this.active || this.active.def.microSway !== true) return
    this.swaySec += dt
    const sway = Math.sin(this.swaySec * 1.7)
    const breathe = Math.sin(this.swaySec * 0.9)
    const rotate = (bone: Bone | null, axis: 'x' | 'y' | 'z', deg: number): void => {
      if (!bone) return
      this.tmpEuler.set(axis === 'x' ? deg : 0, axis === 'y' ? deg : 0, axis === 'z' ? deg : 0)
      this.tmpQuaternion.setFromEuler(this.tmpEuler)
      bone.quaternion.multiply(this.tmpQuaternion)
    }
    rotate(this.swayBones.spine, 'x', breathe * 0.6)
    rotate(this.swayBones.neck, 'x', -breathe * 0.4)
    rotate(this.swayBones.head, 'y', sway * 0.8)
    rotate(this.swayBones.head, 'x', breathe * 0.3)
  }

  /**
   * 本帧 mesh Y 目标：窗沿坐（`seatedAnchor='hips'`）→ 臀部锚点；其余 → 脚底贴地。
   *
   * 用户实机反馈（2026-11-08）：坐窗沿时应该「屁股贴着窗口、腿悬在窗口前」，而不是脚底贴
   * 窗顶「扎马步」。这里在高于底部的表面上把 `下半身` 骨对齐到摆放线的世界高度：
   * `surfaceWorldY = viewportHeight − (petRect.y + petRect.height)`（与 PetScene 摆放口径一致），
   * 差值换算到 mesh 局部 Y；同时记录 `visualOffsetPx` 供 hit/bubble 跟随视觉偏移。
   */
  private computeFrameTargetMeshY(input: AnimationInput): number {
    const def = this.active?.def
    if (
      def?.seatedAnchor === 'hips' &&
      input.motion?.grounded === true &&
      this.seatedAnchorBone !== null &&
      input.petRect &&
      Number.isFinite(input.petRect.y) &&
      Number.isFinite(input.petRect.height) &&
      Number.isFinite(input.viewportHeight)
    ) {
      const feetYLocal = input.petRect.y + input.petRect.height
      const elevationPx = input.viewportHeight - feetYLocal
      const petHeightPx = Math.max(1, input.petRect.height)
      // 仅「高于底部」的表面做臀部锚定；地面/Dock（贴底）仍按脚底贴地处理。
      if (elevationPx > petHeightPx * SEATED_HIPS_MIN_ELEVATION_RATIO) {
        this.mesh.updateMatrixWorld(true)
        this.seatedAnchorBone.getWorldPosition(this.tmpVector)
        const surfaceWorldY = input.viewportHeight - feetYLocal
        const scaleY = this.rootScaleY()
        const currentMeshY = Number.isFinite(this.mesh.position.y) ? this.mesh.position.y : this.baseMeshY
        if (scaleY > 1e-6) {
          // 锚点微调：正数 = 锚点取在骨上方，视觉整体下移（让臀底而不是骨盆中心贴窗沿）。
          const anchorOffsetY = (Number.isFinite(def.seatedAnchorOffsetUnits) ? def.seatedAnchorOffsetUnits : 0) * scaleY
          const localOffset = (surfaceWorldY - (this.tmpVector.y + anchorOffsetY)) / scaleY
          const nextMeshY = currentMeshY + localOffset
          // 视觉偏移必须记「相对基准的总偏移」（不是单帧增量），hit/气泡靠它跟随臀部锚定后的视觉位置。
          this.visualOffsetPx = (nextMeshY - this.baseMeshY) * scaleY
          return nextMeshY
        }
      }
    }
    const groundingY = this.computeGroundingTargetMeshY()
    const scaleY = this.rootScaleY()
    this.visualOffsetPx = scaleY > 1e-6 ? (groundingY - this.baseMeshY) * scaleY : 0
    return groundingY
  }

  /**
   * 算本帧贴地目标 `mesh.position.y`：当前脚骨世界最低点 → 与 bind pose 脚底应有高度比较，
   * 把差值换算成 mesh 局部增量（不写 modelRoot）。
   */
  private computeGroundingTargetMeshY(): number {
    // D4：坐姿等「脚不负责地面接触」的 clip 显式关闭脚底补偿（manifest grounding='none'）；
    // 否则脚底贴地会把角色整体抬高，坐面/悬垂腿的语义会被破坏。
    if (this.active?.def.grounding === 'none') return this.baseMeshY
    const currentMeshY = Number.isFinite(this.mesh.position.y) ? this.mesh.position.y : this.baseMeshY
    if (this.restFootLocalMinY === null || this.footBones.length === 0) return this.baseMeshY
    this.mesh.updateMatrixWorld(true)
    const currentMinWorldY = this.measureFootMinWorldY()
    if (currentMinWorldY === null) return this.baseMeshY
    const scaleY = this.rootScaleY()
    const expectedWorldY = expectedFootGroundWorldY(
      this.restFootLocalMinY,
      scaleY,
      this.rootWorldY()
    )
    return currentMeshY + groundingOffsetLocalY(currentMinWorldY, expectedWorldY, scaleY)
  }

  /** 贴地补偿后的残余误差（CSS px = 世界 px；冒烟断言「贴地生效」用，稳定后应 <2px）。 */
  private measureExternalFootError(): void {
    if (this.active?.def.seatedAnchor === 'hips' && this.visualOffsetPx !== 0) {
      // 臀部锚定（窗沿坐）时脚是悬垂的，脚底误差不适用。
      this.lastExternalFootErrorPx = null
      return
    }
    if (this.active?.def.grounding === 'none') {
      // 不做脚底补偿的 clip（坐姿等）：脚底误差不适用，快照给 null（避免误判「贴地失败」）。
      this.lastExternalFootErrorPx = null
      return
    }
    if (this.restFootLocalMinY === null || this.footBones.length === 0) {
      this.lastExternalFootErrorPx = null
      return
    }
    const currentMinWorldY = this.measureFootMinWorldY()
    if (currentMinWorldY === null) {
      this.lastExternalFootErrorPx = null
      return
    }
    const expectedWorldY = expectedFootGroundWorldY(
      this.restFootLocalMinY,
      this.rootScaleY(),
      this.rootWorldY()
    )
    const error = footGroundingErrorPx(currentMinWorldY, expectedWorldY)
    this.lastExternalFootErrorPx = Number.isFinite(error) ? Math.round(error * 100) / 100 : null
  }

  /** 骨骼姿态是否出现 NaN/Infinity（每帧扫 382 骨四元数，成本 ~0.005ms；异常即回退）。 */
  private hasNonFiniteBonePose(): boolean {
    const bones = this.mesh.skeleton?.bones
    if (!bones) return false
    for (const bone of bones) {
      if (!bone) continue
      const q = bone.quaternion
      if (
        !Number.isFinite(q.x) ||
        !Number.isFinite(q.y) ||
        !Number.isFinite(q.z) ||
        !Number.isFinite(q.w)
      ) {
        return true
      }
    }
    const center = this.mesh.skeleton.getBoneByName?.('センター')
    if (center) {
      const p = center.position
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return true
    }
    return false
  }

  /** 脚骨世界最低 Y（调用前需 updateMatrixWorld）。 */
  private measureFootMinWorldY(): number | null {
    if (this.footBones.length === 0) return null
    const values: number[] = []
    for (const bone of this.footBones) {
      bone.getWorldPosition(this.tmpVector)
      values.push(this.tmpVector.y)
    }
    return lowestFootWorldY(values)
  }

  /** bind pose 脚底在**模型局部**的 Y（创建时抓一次；与 root 摆放/缩放无关）。 */
  private measureRestFootLocalMinY(): number | null {
    if (this.footBones.length === 0) return null
    try {
      this.root.updateMatrixWorld(true)
      this.mesh.updateMatrixWorld(true)
    } catch {
      /* 矩阵暂不可用（未挂场景）时按局部坐标近似 */
    }
    let min = Number.POSITIVE_INFINITY
    const world = new Vector3()
    for (const bone of this.footBones) {
      bone.getWorldPosition(world)
      this.mesh.worldToLocal(world)
      if (Number.isFinite(world.y) && world.y < min) min = world.y
    }
    return Number.isFinite(min) ? min : null
  }

  private rootScaleY(): number {
    const scale = this.root.scale?.y
    return Number.isFinite(scale) && Math.abs(scale) > 1e-9 ? scale : 1
  }

  private rootWorldY(): number {
    const elements = this.root.matrixWorld?.elements
    if (elements && elements.length >= 14 && Number.isFinite(elements[13])) return elements[13]!
    return Number.isFinite(this.root.position?.y) ? this.root.position.y : 0
  }

  /** action.time 的原始秒数（不取模；LoopOnce 结束时 = duration，用于判断播完）。 */
  private readClipActionTimeSec(): number {
    const mixer = mixerOf(this.helper, this.mesh)
    if (!mixer) return 0
    const actions = (mixer as unknown as { _actions?: AnimationAction[] })._actions
    const action = actions && actions.length > 0 ? actions[0] : null
    const raw = action && Number.isFinite(action.time) ? action.time : mixer.time
    if (!Number.isFinite(raw)) return 0
    return Math.max(0, raw)
  }

  /** 当前 clip 播放时间（秒，模 duration；优先 action.time，退化 mixer.time）。 */
  private readClipTimeSec(info: VmdClipInfo): number {
    const mixer = mixerOf(this.helper, this.mesh)
    if (!mixer) return 0
    const actions = (mixer as unknown as { _actions?: AnimationAction[] })._actions
    const action = actions && actions.length > 0 ? actions[0] : null
    const raw = action && Number.isFinite(action.time) ? action.time : mixer.time
    if (!Number.isFinite(raw)) return 0
    const duration = info.durationSec
    if (!(duration > 1e-6)) return Math.max(0, raw)
    const wrapped = raw % duration
    return wrapped < 0 ? wrapped + duration : wrapped
  }

  /* ------------------------------ additive look-at ------------------------------ */

  /** VMD 帧内叠加 look-at：读输入（鼠标/宠物矩形/朝向/身体转角）→ 纯控制器 → 右乘头/颈/眼骨。 */
  private applyVmdLookAt(input: AnimationInput, dt: number, nowMs: number): void {
    const facing = (input.facing ?? input.motion?.facing ?? 'front') as 'left' | 'right' | 'front'
    const result = this.lookAt.update({
      lookTarget: input.lookTarget ?? null,
      petRect: input.petRect ?? null,
      facing,
      dt,
      nowMs,
      bodyYawRad: this.currentBodyYawRad()
    })
    this.lastLookAtResult = result
    this.applyAdditiveEuler(this.lookAtBones.neck, result.neck)
    this.applyAdditiveEuler(this.lookAtBones.head, result.head)
    this.applyAdditiveEuler(this.lookAtBones.eyeLeft, result.eye)
    this.applyAdditiveEuler(this.lookAtBones.eyeRight, result.eye)
  }

  /**
   * 把局部 additive 欧拉角右乘到骨骼：`q = q × Δq`（three `quaternion.multiply`）。
   * 右乘 = 在骨骼**局部坐标系**内追加旋转（clip 的姿态在前、look-at 增量在后）；
   * 每帧都基于 clip 本帧绝对姿态重新叠加 → 天然无累积。
   */
  private applyAdditiveEuler(bone: Bone | null, euler: Euler3): void {
    if (!bone) return
    const { x, y, z } = euler
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && Math.abs(z) < 1e-6) return
    this.tmpEuler.set(x, y, z, 'YXZ')
    this.tmpQuaternion.setFromEuler(this.tmpEuler)
    bone.quaternion.multiply(this.tmpQuaternion)
  }

  /** センター 本帧世界 Y 转角（rad；VMD clip 的 3/4 侧身，用于注视局部化；只读不写）。 */
  private currentBodyYawRad(): number {
    if (!this.centerBone) return 0
    this.tmpEuler.setFromQuaternion(this.centerBone.quaternion, 'YXZ')
    return Number.isFinite(this.tmpEuler.y) ? this.tmpEuler.y : 0
  }

  /* ------------------------------ 回退/快照 ------------------------------ */

  /** B3 骨骼写入开关（VMD 激活 = false，只写 morph；回退 = true）。 */
  private setB3BonesEnabled(enabled: boolean): void {
    if (this.b3BonesEnabled === enabled) return
    this.b3BonesEnabled = enabled
    this.b3.setBoneWriteEnabled(enabled)
  }

  /**
   * 运行时异常的回退：记录原因、移除 VMD、骨骼复位、恢复 mesh 原始 Y，尽力让 B3 接管本帧。
   * **永不向 PetScene 抛错**（否则 PetScene 会整条动画降级为 Wave 1 微动）。
   */
  private handleRuntimeFailure(error: unknown, input: AnimationInput): void {
    const message = errorMessage(error)
    if (this.disabledReason === null) {
      this.disabledReason = `外部动作运行时失败：${message}`
      console.error('[animation/external]', this.disabledReason, error)
      try {
        if (this.helperHasMesh) {
          this.helper.remove(this.mesh)
          this.helperHasMesh = false
        }
      } catch {
        /* 清理失败不阻塞渲染 */
      }
      try {
        this.mesh.pose()
      } catch {
        /* 同上 */
      }
      this.active = null
      this.fade = null
      this.lastClipTimeSec = null
      this.lastExternalFootErrorPx = null
      this.lookAt.reset()
      this.lastLookAtResult = null
    }
    this.mesh.position.y = this.baseMeshY
    this.frameTargetMeshY = this.baseMeshY
    try {
      this.setB3BonesEnabled(true)
      if (!this.b3UpdatedThisFrame) {
        this.b3.update(input)
        this.b3UpdatedThisFrame = true
      }
    } catch (nested) {
      console.error('[animation/external] B3 回退更新失败:', nested)
    }
  }

  /** 合并 B3 快照 + 外部动作字段（契约见 `AnimationDebugSnapshot`；procedural 时外部字段为 null）。 */
  private buildSnapshot(): AnimationDebugSnapshot {
    const active = this.active
    const base = this.b3.getDebugSnapshot()
    // VMD 激活时 B3 管线仍在算 gaze/lookYaw，但它的骨骼写入是关闭的（未真正生效）；
    // 用实际生效的 additive look-at 结果覆盖，保证调试面与画面一致（D4b）。
    const look = active ? this.lastLookAtResult : null
    return {
      ...base,
      source: active ? 'vmd' : 'procedural',
      clipId: active ? active.def.id : null,
      clipTimeSec: active ? this.lastClipTimeSec : null,
      externalFootErrorPx: active ? this.lastExternalFootErrorPx : null,
      externalIk: active ? this.currentIk : null,
      externalPlaybackRate: active ? this.playbackRate : null,
      visualOffsetYPx: active ? Math.round(this.visualOffsetPx * 100) / 100 : null,
      ...(look
        ? {
            lookYaw: look.lookYaw,
            gaze: look.active ? { yaw: look.gaze.yaw, pitch: look.gaze.pitch } : null
          }
        : {})
    }
  }

  /* ------------------------------ 加载 ------------------------------ */

  /** 异步加载 manifest → 解析 → 预加载全部 clip（失败重试默认 2 次；全程不抛错）。 */
  private async loadManifestAndPreload(): Promise<void> {
    if (this.manifestLoading || !this.externalEnabled) return
    this.manifestLoading = true
    this.manifestAttempts += 1
    try {
      const raw = this.options.loadManifest
        ? await this.options.loadManifest()
        : await this.fetchManifest()
      const parsed = parseMotionIndex(raw)
      this.manifest = parsed.manifest
      this.manifestWarnings = parsed.warnings
      for (const warning of parsed.warnings) console.warn('[animation/external]', warning)
      this.manifestLoading = false
      if (parsed.manifest.clips.length === 0) return
      console.info(
        `[animation/external] motion-index 载入 ${parsed.manifest.clips.length} 条 clip：` +
          parsed.manifest.clips.map((clip) => `${clip.id}(${clip.moods.join('/')})`).join(', ')
      )
      // 串行预加载（Idle 在清单第一优先）：每个 clip 的 VMD 解析/建轨 ~10–30ms，
      // 串行让出一帧，避免启动时多个 clip 的解析在同一任务里叠加造成明显掉帧。
      for (const clip of parsed.manifest.clips) {
        await this.ensureClipLoaded(clip)
        if (!this.externalEnabled) break
      }
    } catch (error) {
      this.manifestLoading = false
      const message = `motion-index 加载失败：${errorMessage(error)}`
      this.manifestWarnings.push(message)
      console.warn('[animation/external]', message, '（回退 B3 程序化姿态）')
      const retries = this.options.manifestRetryCount ?? DEFAULT_MANIFEST_RETRY_COUNT
      if (this.manifestAttempts <= retries) {
        const delay = this.options.manifestRetryDelayMs ?? DEFAULT_MANIFEST_RETRY_DELAY_MS
        const timer = setTimeout(() => {
          void this.loadManifestAndPreload()
        }, delay)
        // Node 单测环境（无 window）超时器会阻止进程退出：能 unref 就 unref。
        const maybeUnref = timer as unknown as { unref?: () => void }
        maybeUnref.unref?.()
      }
    }
  }

  /** 默认 manifest 加载：`fetch(pet-asset://model/motion-index.json)`（协议已支持 CORS/fetch）。 */
  private async fetchManifest(): Promise<unknown> {
    if (typeof fetch !== 'function') throw new Error('当前环境没有 fetch，无法加载 motion-index')
    const response = await fetch(buildPetAssetUrl(MOTION_MANIFEST_FILE), { cache: 'no-cache' })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}（${MOTION_MANIFEST_FILE} 不存在或协议拒绝）`)
    }
    return (await response.json()) as unknown
  }

  /** 加载单条 clip（按 id 缓存；失败记 warning 并保持 B3；并发调用不重复加载）。 */
  private async ensureClipLoaded(def: MotionClipDef): Promise<void> {
    if (this.clipStates.has(def.id)) return
    this.clipStates.set(def.id, { status: 'loading' })
    try {
      const info = await this.loadClip(def)
      this.clipStates.set(def.id, { status: 'ready', info })
      console.info(
        `[animation/external] clip 就绪：${def.id}（${info.durationSec.toFixed(2)}s, ` +
          `${info.boneTrackCount} 骨轨, ik=${def.ik}, in-place=${info.inPlace}）`
      )
    } catch (error) {
      const message = `clip ${def.id} 加载失败：${errorMessage(error)}`
      this.clipStates.set(def.id, { status: 'failed', error: message })
      this.clipWarnings.push(message)
      console.warn('[animation/external]', message, '（该 mood 回退 B3）')
    }
  }

  private loadClip(def: MotionClipDef): Promise<VmdClipInfo> {
    if (this.options.loadClip) return this.options.loadClip(def)
    if (!this.clipLoader) this.clipLoader = createVmdClipLoader(this.mesh)
    return this.clipLoader(def)
  }
}
