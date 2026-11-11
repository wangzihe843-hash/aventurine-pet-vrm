/**
 * VRM 宠物场景（V1 主路径）—— `PetView` 的 three-vrm 实现，`main.ts` 在
 * `config.modelBackend === 'vrm'` 时用它替换 PMX 的 `PetScene`。
 *
 * 坐标/摆放语义与 `scene/pet-scene.ts` 对齐（对外接口/`PetView` 口径完全一致），但**内部世界单位是米**：
 * - 模型 `modelRoot.scale = 1`，three-vrm 的 SpringBone 物理在**原生米制尺度**下跑（官方 Scaling
 *   guide：若把模型放大 ~300×，stiffness/hitRadius/collider radius/tail 长度必须同步缩放，否则
 *   头发/衣摆僵硬或穿模；因此不做 px 缩放）；
 * - 正交相机视锥用米：`left=0,right=viewport.width/pxPerMeter,bottom=0,top=viewport.height/pxPerMeter`，
 *   其中 `pxPerMeter = rect.height / restHeightMeters`；世界坐标原点仍是视口左下角、y 向上；
 * - `placePet(rect, feetY)` 的 `rect` 是窗口本地 CSS px（y 向下）；`feetY` 是脚底本地 y；
 *   摆放换算：`root.x = (rect.x+rect.width/2)/pxPerMeter − restCenterX`、
 *   `root.y = (viewport.height−feetY)/pxPerMeter − restFeetY`（restCenterX/restFeetY 单位米）；
 * - `petWorldRect`（对外调试面）在返回时**换算回 CSS px**，保持 `debug.stats`/冒烟语义与 PMX 一致；
 * - 朝向：`setFacing(left/right/front)` → 目标 yaw ±90°/0，`step()` 内按指数平滑收敛；
 *   manifest 的 `yawOffsetDeg` 作为模型自身朝向修正叠加（VRM1 面向 +Z，通常 0）；
 * - `fpsCap` 跳帧/像素预算 pixelRatio/透明背景/opacity/visible 均沿用 `scene/` 既有小件。
 *
 * 与 PMX 场景的差异：
 * - **不做屏幕空间 OutlineEffect**：MToon 自带描边（材质 outlineWidth*），`getRenderStats().outlinePx`
 *   暂返回 0（设计文档 §3：允许返回 0 或 MToon 平均描边 px；smoke 对 vrm 后端放宽断言）；
 * - 光照按 MToon 用 r171 物理单位（参考 `scripts/vrm/canary-viewer.js` 的保守初值，Lead 实机再调）；
 * - `modelAspectRatio` 返回**躯干宽高比** `bodyAspectRatio`（不是 T-pose 臂展包围盒比），
 *   因为 `main.ts` 用它算宠物矩形宽度 → 命中区/物理半宽（设计文档 §4.1）；
 * - 世界单位是米，`modelRoot.scale` 恒 1（SpringBone 原生尺度）；场景外需要 px/m 换算的消费方
 *   （Lead 的 clip-player `getPixelsPerMeter`）请读 `modelRoot.userData.pixelsPerMeter`，
 *   **不要再用 `modelRoot.scale.y`**（已恒为 1）；
 * - 动画驱动由 `createPoseDriver` 工厂注入（`loadModel` 内 await，可为 Promise）；失败/缺省时
 *   降级为静态 rest（仍每帧 `vrm.update(dt)` 驱动 spring/材质/内建 lookAt）；正常驱动存在时
 *   `vrm.update(dt)` 由 animator 负责调用，本类不重复调用（也**不**自行驱动眼球骨）。
 *
 * 构造（兼容 `main.ts` 既有的两参形式）：
 * ```ts
 * new VrmPetScene(appRoot, { avatar, motionSet, fpsCap, createPoseDriver })
 * // 或单对象：new VrmPetScene({ container: appRoot, avatar, ... })
 * ```
 */
import {
  AmbientLight,
  Cache,
  DirectionalLight,
  Group,
  OrthographicCamera,
  Scene,
  WebGLRenderer
} from 'three'
import type { Rect } from '@shared/types'
import { VRM_REQUIRED_HUMANOID_BONES, type VrmAvatarAsset } from '@shared/vrm'

import { createPetAssetLoadTracker, resolveVrmAssetUrl, type PetAssetLoadTracker } from '../assets/pet-asset'
import {
  DEFAULT_TEXTURE_MAX_RETRIES,
  DEFAULT_TEXTURE_RETRY_BASE_MS,
  installRetryingTextureLoader
} from '../assets/retrying-texture-loader'
import type {
  AnimationDebugSnapshot,
  AnimationDriverInput,
  AnimationInput,
  PoseDriver
} from '../core/wave2-contract'
import { hipShiftToScreenXPx } from '../interaction/pointer-rect'
import { FALLBACK_MODEL_ASPECT, type Size2D } from '../model/layout'
import type { PetView, VrmRuntimeDiagnostics } from '../scene/pet-view'
import type { PetModelSnapshot, PetRenderStats } from '../scene/pet-scene'
import { FrameRateController } from '../scene/fps-limiter'
import { computePixelRatio } from '../scene/pixel-ratio'

import { FALLBACK_BODY_ASPECT_RATIO } from './avatar-bounds'
import {
  collectVrmTextures,
  countVrmSpringBoneChains,
  loadVrmAvatar,
  readVrmRuntimeExtras
} from './avatar-loader'
import { disposeObjectTreeResources } from './dispose'
import {
  shouldReloadAfterContextLoss,
  type ContextLossReloadStorage
} from './context-loss'
import type { VrmAvatar, VrmPoseDriverFactory } from './runtime-types'
import {
  computeModelVisible,
  isStartupPoseApplied,
  startupPoseFallbackDue
} from './startup-pose'

/* -------------------------------------------------------------------------- */
/* 常量（与 scene/pet-scene.ts 对齐）                                           */
/* -------------------------------------------------------------------------- */

/**
 * 相机到模型的距离（世界单位 = 米；模型 z 跨度约 0.3m，正交相机只看方向不看距离）。
 * 取 5m 让 near/far 留出合理深度精度（MToon 无雾，深度缓冲范围够用即可）。
 */
const CAMERA_DISTANCE = 5
/** 相机近/远裁剪面（米）。 */
const CAMERA_NEAR = 0.1
const CAMERA_FAR = 100

/**
 * 移动朝向角（弧度）：facing='left'/'right' 时把 modelRoot 绕 Y 转 ±90°，
 * 让宠物**面朝移动方向**（侧身走路）；与 PMX 场景/`PetView` 契约一致。
 */
const MOVING_FACING_YAW_RAD = Math.PI / 2
/** 朝向平滑时间常数（秒）。 */
const FACING_SMOOTH_TAU_SEC = 0.16

/**
 * MToon 光照（three r171 物理单位；`NoToneMapping` + sRGB 输出）。
 * 参考 `scripts/vrm/canary-viewer.js` 经 W0-4 实机验证的保守初值（key/fill/rim/ambient），
 * 换资产（戏浪 T-pose 贴图偏浅）后观感由 Lead 实机调参，这里先保持一致基线。
 */
const LIGHT_AMBIENT = 0.42
const LIGHT_KEY = 1.35
const LIGHT_FILL = 0.28
const LIGHT_RIM = 0.4
const LIGHT_KEY_COLOR = 0xffffff
const LIGHT_FILL_COLOR = 0xbfd4ff
const LIGHT_RIM_COLOR = 0xffe2c4

/** 单帧 delta 上限（秒）：睡眠/遮挡恢复后的首帧可能极大；动画/spring 用同一时间步。 */
const MAX_FRAME_DELTA_SECONDS = 0.1

/**
 * WebGL context 丢失后的重载延迟（ms；B-02）。
 * 给 Chromium/GPU 进程一点时间先尝试自动恢复（webglcontextrestored 若在延迟内到达，
 * 本场景仍会重载——原因见 handleContextRestored 注释），避免 GPU 短暂 reset 时立刻闪一次白屏。
 */
const CONTEXT_LOSS_RELOAD_DELAY_MS = 1500

/** 贴图加载指数退避重试（F04，单张最多 3 次，250/500/1000ms；handler 只装一次）。 */
const TEXTURE_RETRY_MAX = DEFAULT_TEXTURE_MAX_RETRIES
const TEXTURE_RETRY_BASE_MS = DEFAULT_TEXTURE_RETRY_BASE_MS

/** 默认动作集 id（`config.motionSet` 缺省值）。 */
const DEFAULT_MOTION_SET = 'default'

/**
 * 启动姿势兜底等待（ms）：pose driver 存在但 clip 姿势迟迟未完整应用（clip 加载失败/降级/
 * 无动画输入）时，超时后显示静态 rest，避免宠物永久隐身（比闪一下 T-pose 更糟）。
 * 正常路径在首帧吸附后立刻满足门控（~1 帧），不会走到这里。
 */
const STARTUP_POSE_FALLBACK_MS = 2500

/* -------------------------------------------------------------------------- */
/* 构造参数                                                                    */
/* -------------------------------------------------------------------------- */

/** `VrmPetScene` 构造 options（`avatar` 必填；两参构造时 `container` 省略）。 */
export interface VrmPetSceneOptions {
  /** manifest 里的 avatar 资产描述（决定 id/表情绑定/lookAt/朝向修正，并转交给 loader）。 */
  avatar: VrmAvatarAsset
  /** 动作集 id（传给 `createPoseDriver` 的 context；默认 `default`）。 */
  motionSet?: string
  /** 动画驱动工厂（Lead 组合 clip-player/animator；可返回 Promise；返回 null = 静态 rest）。 */
  createPoseDriver?: VrmPoseDriverFactory
  /** 帧率上限（缺省沿用 `FrameRateController` 默认 30）。 */
  fpsCap?: number
  /** canvas 容器（单对象构造时必填；两参构造时从参数取）。 */
  container?: HTMLElement
}

/** 摆放参数：窗口本地 CSS 像素矩形（y 向下） + 脚底锚点 y。 */
interface VrmPlacement {
  rect: Rect
  feetY: number
}

/** 判断值是否像 DOM 容器（`appendChild` 方法存在）。 */
function isCanvasContainer(value: unknown): value is HTMLElement {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as { appendChild?: unknown }).appendChild === 'function'
}

/** 默认 canvas 容器（renderer 页面里的 #app；缺省退回 body）。 */
function defaultCanvasContainer(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById('app') ?? document.body ?? null
}

/** 解析两种构造形式 → `{ container, options }`。 */
function resolveConstructorArguments(
  containerOrOptions: HTMLElement | VrmPetSceneOptions,
  maybeOptions?: VrmPetSceneOptions
): { container: HTMLElement; options: VrmPetSceneOptions } {
  if (isCanvasContainer(containerOrOptions)) {
    if (maybeOptions === undefined) {
      throw new Error('VrmPetScene: 缺少构造 options（至少需要 avatar 资产描述）')
    }
    return { container: containerOrOptions, options: maybeOptions }
  }
  const options = containerOrOptions
  const container = options.container ?? defaultCanvasContainer()
  if (container === null) {
    throw new Error('VrmPetScene: 无法确定 canvas 容器（请传 container 或确保页面存在 #app/body）')
  }
  return { container, options }
}

/* -------------------------------------------------------------------------- */
/* 场景实现                                                                    */
/* -------------------------------------------------------------------------- */

/** VRM 宠物场景（一个 overlay 窗口一个实例；WebGLRenderer + 正交相机 + MToon）。 */
export class VrmPetScene implements PetView {
  readonly renderer: WebGLRenderer

  private readonly scene = new Scene()
  private readonly camera: OrthographicCamera
  private readonly frameRate: FrameRateController
  private readonly tracker: PetAssetLoadTracker
  private readonly avatarAsset: VrmAvatarAsset
  private readonly motionSet: string
  private readonly poseDriverFactory?: VrmPoseDriverFactory
  /** manifest 朝向修正（弧度；叠加在行走朝向之上）。 */
  private readonly modelYawOffsetRad: number

  private avatar: VrmAvatar | null = null
  private modelRoot: Group | null = null
  private poseDriver: PoseDriver | null = null
  /**
   * 启动姿势是否已完整应用（= 模型允许显示的启动门控）。
   *
   * 用户 2026-11-09：app 启动会先闪一瞬「T-pose 还是 A-pose 分不清」的姿势再进 idle。
   * VRM 的 rest 就是规范 T-pose，visible 必须等到「首帧 clip 姿势完整写入」；
   * 有 PoseDriver 时首帧动画应用前保持隐藏（含加载/驱动初始化窗口）；无驱动（静态降级）才直接显示。
   */
  private firstAnimationApplied = false
  /** 启动姿势门控开始计时（rAF 时间 ms；null = 尚未开始等待/已满足）。 */
  private startupPoseWaitStartedMs: number | null = null

  /** main.ts 每帧注入的动画输入（dt/petRect/viewportHeight 由本类补齐）。 */
  private pendingAnimationInput: AnimationDriverInput | null = null
  /** 动画运行时错误（首个；非空且 poseDriver===null 表示已降级静态 rest）。 */
  private animationFailure: string | null = null

  private viewport: Size2D = { width: 1, height: 1 }
  private placement: VrmPlacement | null = null
  private petVisible = true
  private worldRect: Rect | null = null
  /** 当前/目标朝向角（弧度，绕 Y；0=面向镜头、±π/2=侧身朝移动方向）。 */
  private facingYawCurrent = 0
  private facingYawTarget = 0
  /** rest bbox 横向尺寸/中心（米；由 loader 的运行时额外数据给，兜底用躯干宽高比）。 */
  private restWidthMeters = 1
  private restCenterX = 0
  /** 当前 1 米 = 多少 CSS px（= `rect.height / restHeightMeters`；未摆放时为 1）。 */
  private pxPerMeter = 1
  /**
   * 视觉竖直偏移（CSS px；正 = 视觉向上，与 AnimationDebugSnapshot.visualOffsetYPx 同口径）。
   * 用于 sit 时「hips 贴窗沿、腿垂下」：main.ts 每帧把 animator 的 visualOffsetYPx 同步进来。
   */
  private visualOffsetPx = 0

  private lastRenderMs: number | null = null
  private lastDrawCalls = 0
  private lastTriangles = 0
  /** 贴图重试 loader 是否已安装到 LoadingManager（只装一次）。 */
  private textureRetryInstalled = false
  /** 进行中的模型加载（并发调用复用同一 Promise）。 */
  private loadPromise: Promise<void> | null = null
  /** 是否已 dispose（R-01：幂等；异步加载/渲染在销毁后不得再写场景）。 */
  private disposed = false
  /** WebGL context 丢失后是否已安排重载（B-02：防重复/防循环）。 */
  private contextLossReloadScheduled = false
  /** 延迟重载 timer（B-02；dispose 时清掉）。 */
  private contextReloadTimer: number | null = null
  /** R-17：每帧复用的动画输入/摆放矩形（poseDriver 只在同一帧同步读取，不跨帧保留引用）。 */
  private frameAnimationInput: AnimationInput | null = null
  private readonly framePetRect: Rect = { x: 0, y: 0, width: 0, height: 0 }

  /**
   * B-02：WebGL context 丢失（GPU reset/驱动崩溃/强制丢上下文）。
   *
   * - 必须先 `preventDefault()`，浏览器才允许后续 `webglcontextrestored`（three.js 官方要求）；
   * - 记一条 console.warn（本类无 main.ts 的 recordError 通道）；
   * - 延迟重载一次页面：本场景没有实现 GPU 资源重建，context 丢失后继续渲染只会黑屏/花屏，
   *   重载是唯一可靠恢复路径。局部 flag 防止多次 lost 事件重复安排 reload；
   * - 跨 reload 限流（`context-loss.ts`）：同一 session 10 分钟内最多重载 3 次，避免上下文
   *   持续损坏时「重载 → 立刻再 lost → 再重载」把 CPU/IO 打满；限流计数存 sessionStorage
   *   （关窗清空）。被限流时只记 warn，等用户/主进程重启处理。
   */
  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    if (this.disposed || this.contextLossReloadScheduled) return
    this.contextLossReloadScheduled = true
    console.warn(
      `[pet-scene-vrm] WebGL context 丢失（GPU 重置/驱动异常）：${CONTEXT_LOSS_RELOAD_DELAY_MS}ms 后尝试重载页面恢复渲染`
    )
    if (typeof window === 'undefined') return
    this.contextReloadTimer = window.setTimeout(() => {
      this.contextReloadTimer = null
      if (this.disposed) return
      const storage = this.contextLossReloadStorage()
      if (storage !== null && !shouldReloadAfterContextLoss(Date.now(), storage)) {
        console.warn(
          '[pet-scene-vrm] WebGL context 反复丢失：10 分钟内已重载 3 次，跳过本次重载（请手动重启应用）'
        )
        return
      }
      try {
        window.location.reload()
      } catch (error) {
        console.warn('[pet-scene-vrm] 页面重载失败（请手动重启应用）', error)
      }
    }, CONTEXT_LOSS_RELOAD_DELAY_MS)
  }

  /** context-lost 重载限流的跨 reload 存储（sessionStorage；不可用时返回 null = 不限流）。 */
  private contextLossReloadStorage(): ContextLossReloadStorage | null {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  }

  /**
   * B-02：context 恢复（若在重载延迟内到达）。
   *
   * **不取消重载**：three.js 的 WebGLRenderer 在 context 恢复后不保证重建全部 GPU 资源
   * （本场景的 VRM 贴图/蒙皮是 GLB 内嵌解码 + MToon 材质，没有 restore 后重新上传的路径），
   * 保留渲染只会呈现黑模/花屏；重载是唯一稳的恢复方式。这里只记录日志便于排障。
   */
  private readonly handleContextRestored = (): void => {
    console.warn(
      '[pet-scene-vrm] WebGL context 已恢复；本场景未实现 GPU 资源重建，仍将按计划重载页面'
    )
  }

  constructor(container: HTMLElement, options: VrmPetSceneOptions)
  constructor(options: VrmPetSceneOptions & { container: HTMLElement })
  constructor(
    containerOrOptions: HTMLElement | VrmPetSceneOptions,
    maybeOptions?: VrmPetSceneOptions
  ) {
    const { container, options } = resolveConstructorArguments(containerOrOptions, maybeOptions)
    if (options.avatar === undefined) {
      throw new Error('VrmPetScene: avatar 资产描述缺失')
    }
    this.avatarAsset = options.avatar
    this.motionSet = options.motionSet ?? DEFAULT_MOTION_SET
    this.poseDriverFactory = options.createPoseDriver
    this.modelYawOffsetRad = (this.avatarAsset.yawOffsetDeg * Math.PI) / 180
    this.frameRate = new FrameRateController(options.fpsCap)
    this.tracker = createPetAssetLoadTracker()

    // 透明 canvas：像素 alpha 由模型/贴图决定，窗口合成时透出桌面（与 PetScene 同口径）。
    this.renderer = new WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setClearColor(0x000000, 0)

    const canvas = this.renderer.domElement
    canvas.id = 'pet-canvas'
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    canvas.style.pointerEvents = 'none'
    container.appendChild(canvas)
    // B-02：WebGL context 丢失/恢复监听（只在构造内挂，node 单测不构造本类 → 不会碰 window）。
    canvas.addEventListener('webglcontextlost', this.handleContextLost)
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored)

    this.camera = new OrthographicCamera(0, 1, 1, 0, CAMERA_NEAR, CAMERA_FAR)
    this.camera.position.set(0, 0, CAMERA_DISTANCE)
    this.camera.lookAt(0, 0, 0)
    this.setupLights()
  }

  /* ------------------------------ PetView：只读状态 ------------------------------ */

  /** 当前 VRM 是否已加载完成（贴图由 GLTFLoader 在 parse 内全部解码，加载完即完整）。 */
  get modelLoaded(): boolean {
    return this.avatar !== null
  }

  /**
   * 宠物矩形宽高比（宽/高）= **躯干宽高比**（不含 T-pose 臂展）；
   * 未加载时返回 `FALLBACK_MODEL_ASPECT`（PMX 兼容占位，保证首帧布局稳定）。
   */
  get modelAspectRatio(): number {
    return this.avatar?.bodyAspectRatio ?? FALLBACK_MODEL_ASPECT
  }

  /** 模型在世界坐标（视口左下原点、y 向上）中的矩形；未摆放时为 null。 */
  get petWorldRect(): Rect | null {
    return this.worldRect ? { ...this.worldRect } : null
  }

  /** 模型加载快照（调试面/验收；`morphNames` = VRM expression 名）。 */
  snapshot(): PetModelSnapshot {
    const avatar = this.avatar
    return {
      loaded: avatar !== null,
      morphNames: avatar === null ? [] : [...avatar.expressionNames],
      materialNames: avatar === null ? [] : [...avatar.materialNames],
      textureCount: avatar?.textureCount ?? 0,
      missingTextures: avatar === null ? [] : [...avatar.missingTextures],
      vertexCount: avatar?.vertexCount,
      triangleCount: avatar?.triangleCount
    }
  }

  /** 等待贴图加载结束（成功/失败/超时）；VRM 内嵌贴图在 parse 阶段已解码，通常立即返回。 */
  waitForTextures(timeoutMs = 4000): Promise<void> {
    return this.tracker.whenIdle(timeoutMs)
  }

  /* ------------------------------ PetView：视口 / 帧率 / 外观 ------------------------------ */

  /** 更新视口 CSS 尺寸：pixelRatio 按像素预算随视口重算；投影坐标系仍是 CSS px。 */
  setViewport(viewport: Size2D): void {
    const width = Math.max(1, Math.round(viewport.width))
    const height = Math.max(1, Math.round(viewport.height))
    this.viewport = { width, height }

    const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
    const pixelRatio = computePixelRatio(devicePixelRatio, width, height)
    if (pixelRatio !== this.renderer.getPixelRatio()) {
      // setPixelRatio 内部会用「旧」尺寸重设一次 canvas；随后统一 setSize 到当前视口一次。
      this.renderer.setPixelRatio(pixelRatio)
    }
    this.renderer.setSize(width, height, false)

    // 视口变化会改变相机视锥（米制）；已摆放时重新套用摆放（pxPerMeter 依赖 rect.height）。
    this.updateCameraProjection()
    this.applyModelTransform()
  }

  /**
   * 设置视觉竖直偏移（CSS px；正 = 视觉向上）。只影响渲染摆放，物理/hit 仍由 main.ts 的
   * petRect + visualOffset 同步换算（见 interaction/pointer-rect.ts）。
   */
  setVisualOffsetYPx(offsetPx: number): void {
    const next = Number.isFinite(offsetPx) ? Math.max(-4000, Math.min(4000, offsetPx)) : 0
    if (Math.abs(next - this.visualOffsetPx) < 0.05) return
    this.visualOffsetPx = next
    this.applyModelTransform()
  }

  /** 热更帧率上限。 */
  setFpsCap(fpsCap: number): void {
    this.frameRate.setCap(fpsCap)
  }

  /** 当前帧率上限。 */
  get fpsCap(): number {
    return this.frameRate.fpsCap
  }

  /** 整体不透明度（只改 canvas CSS，不影响命中/坐标）。 */
  setOpacity(opacity: number): void {
    const value = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
    this.renderer.domElement.style.opacity = value === 1 ? '' : String(value)
  }

  /** 是否渲染宠物（非主屏窗口 false → 透明空场景）。 */
  setPetVisible(visible: boolean): void {
    this.petVisible = visible
    // 可见性唯一 owner：不得在这里直接写 visible 绕过启动姿势门控（见 syncModelVisibility）。
    this.syncModelVisibility()
  }

  /* ------------------------------ PetView：模型加载 ------------------------------ */

  /**
   * 加载 VRM 模型（`pet-asset://assets/<avatar.file>`，由 main.ts 解析好传入）。
   *
   * - 安装贴图重试 handler（与 PMX 同款；VRM 内嵌贴图主要靠 GLTFLoader 自身，外部贴图走重试）；
   * - `await loadVrmAvatar()`：能力探测/bbox/贴图统计完成；
   * - 包一层 `Group` 作为 modelRoot（摆放/缩放/朝向由本类负责，动画层只读）；
   * - **await 动画驱动工厂**（Lead 的 animator 要等 clip manifest 初始化后再宣告模型 ready，
   *   见 `main.ts` createVrmPoseDriver 注释）；工厂失败只降级不抛（记录 animationFailureMessage）。
   */
  async loadModel(url: string): Promise<void> {
    if (this.disposed) return
    if (this.avatar !== null) return
    if (this.loadPromise !== null) return this.loadPromise
    const promise = this.performLoad(url)
    this.loadPromise = promise
    try {
      await promise
    } finally {
      this.loadPromise = null
    }
  }

  private async performLoad(url: string): Promise<void> {
    // F04：贴图加载失败按指数退避重试（handler 挂在 tracker 的 LoadingManager 上，只装一次）。
    if (!this.textureRetryInstalled) {
      installRetryingTextureLoader(this.tracker.manager, {
        maxRetries: TEXTURE_RETRY_MAX,
        baseDelayMs: TEXTURE_RETRY_BASE_MS,
        holdPending: () => this.tracker.holdPending()
      })
      this.textureRetryInstalled = true
    }

    const requestedUrl =
      typeof url === 'string' && url.trim().length > 0
        ? url.trim()
        : resolveVrmAssetUrl(this.avatarAsset)
    const avatar = await loadVrmAvatar({
      url: requestedUrl,
      manager: this.tracker.manager,
      patchGlbOnDemand: true,
      asset: this.avatarAsset
    })
    // R-01：加载期间被 dispose（页面卸载/后端切换）→ 释放刚加载的模型，不得再写场景字段。
    if (this.disposed) {
      try {
        avatar.dispose()
      } catch (error) {
        console.warn('[pet-scene-vrm] dispose 后到达的模型释放失败（已忽略）', error)
      }
      return
    }

    // 摆放基准：rest bbox 宽/中心（loader 的 WeakMap 通道）+ rest 高/脚底（VrmAvatar 字段）。
    const extras = readVrmRuntimeExtras(avatar.vrm)
    this.restWidthMeters =
      extras !== null && Number.isFinite(extras.restWidthMeters) && extras.restWidthMeters > 0
        ? extras.restWidthMeters
        : Math.max(avatar.bodyAspectRatio * avatar.restHeightMeters, 0.01)
    this.restCenterX = extras !== null && Number.isFinite(extras.restCenterX) ? extras.restCenterX : 0

    const root = new Group()
    root.name = 'pet-model-root'
    root.visible = false
    root.add(avatar.vrm.scene)
    // 2026-11-10：VRM 的每个材质是独立 SkinnedMesh（颜/髪/肌/衣…），three.js 的蒙皮包围球按
    // bind pose 计算；当模型整体下移贴到屏幕顶（高窗沿坐/躺）时，个别 mesh 的包围球会越出正交
    // 视锥 → 整块被错误剔除（实机表现为「头突然消失、眼镜还浮着」）。桌面宠物固定在正交相机下
    // 渲染、mesh 数量很少，关闭每-mesh 视锥剔除的代价可忽略，从根上消除这类“部件消失”。
    root.traverse((object) => {
      const mesh = object as { isMesh?: boolean; isSkinnedMesh?: boolean; frustumCulled?: boolean }
      if (mesh.isMesh === true || mesh.isSkinnedMesh === true) mesh.frustumCulled = false
    })
    this.scene.add(root)

    this.avatar = avatar
    this.modelRoot = root
    this.applyTextureQuality()

    await this.createPoseDriverIfNeeded()
    // 有驱动：等第一帧动画完整应用后再显示（否则会闪 VRM rest T/A-pose）；无驱动：静态显示。
    this.firstAnimationApplied = this.poseDriver === null
    this.startupPoseWaitStartedMs = null
    this.applyModelTransform()
  }

  /* ------------------------------ PetView：动画驱动 ------------------------------ */

  /** 是否已启用动画驱动（false = 静态 rest 降级）。 */
  get animationActive(): boolean {
    return this.poseDriver !== null
  }

  /** 动画运行时错误（首个；null = 无错误）。 */
  get animationFailureMessage(): string | null {
    return this.animationFailure
  }

  /**
   * 注入本帧动画输入（main.ts 在 `scene.step()` 前调用；未调用时静止在 rest）。
   * dt/petRect/viewportHeight 由本类在 step 内补齐（单一来源，不让 main.ts 重复算）。
   */
  setAnimationInput(input: AnimationDriverInput): void {
    if (this.disposed) return
    this.pendingAnimationInput = input
  }

  /** 设置移动朝向：left/right 时模型绕 Y 转 ±90° 面朝移动方向，front 回正面（step 内平滑）。 */
  setFacing(facing: 'left' | 'right' | 'front'): void {
    this.facingYawTarget =
      facing === 'left' ? -MOVING_FACING_YAW_RAD : facing === 'right' ? MOVING_FACING_YAW_RAD : 0
  }

  /** 调试面：动画快照（未启用驱动时返回 null）。 */
  getAnimationSnapshot(): AnimationDebugSnapshot | null {
    if (!this.poseDriver) return null
    try {
      return this.poseDriver.getDebugSnapshot()
    } catch (error) {
      this.recordAnimationFailure(error)
      return null
    }
  }

  /**
   * L2（M-3）：foot-lock 的 hips 水平对齐（`avatar.scene` 局部米）→ 屏幕横向 CSS px。
   *
   * 消费方 `main.ts` 用它把命中矩形/气泡横向对齐到身体视觉位置：hips 对齐预算
   * `MAX_HIP_SHIFT_M = 0.18m` ≈ 56px @540px 宠物，未补偿时身体视觉侧移但命中区不动
   * （点不到/气泡偏）。换算口径见 `interaction/pointer-rect.ts#hipShiftToScreenXPx`：
   * `ppm·(cos(yaw)·shiftX + sin(yaw)·shiftZ)`；yaw 与 `applyModelTransform` 同源
   * （`modelYawOffsetRad + facingYawCurrent`，front=0、侧身 ±90°）。
   *
   * 边界：未加载/已 dispose/驱动降级/未摆放（pxPerMeter 兜底 1）→ 0；PMX 后端没有 foot-lock
   * 层 → `PetView.getHipShiftScreenXPx?` 可选、不实现即 0；拖拽/坐/走等不锁定时 hipShift 已按
   * τ=0.3s 平滑归零；快照来自上一帧（`applyRuntimeOutput` 在 `step()` 前），1 帧滞后可忽略。
   *
   * @param snapshot main.ts 本帧已取的动画调试快照（同一帧已为 `visualOffsetYPx` 取过）：
   *   传入时**复用**，避免每帧二次构建 debug 快照（`getDebugSnapshot` 会分配多个对象）；
   *   未传/为 null 时回退到 `poseDriver.getDebugSnapshot()`（兜底，保持独立可调用）。
   */
  getHipShiftScreenXPx(snapshot?: AnimationDebugSnapshot | null): number {
    const root = this.modelRoot
    if (this.disposed || root === null) return 0
    let footLock = snapshot?.footLock
    if (footLock === undefined) {
      try {
        footLock = this.poseDriver?.getDebugSnapshot().footLock
      } catch {
        return 0
      }
    }
    const hipShiftXM = footLock?.hipShiftXM
    const hipShiftZM = footLock?.hipShiftZM
    if (typeof hipShiftXM !== 'number' || typeof hipShiftZM !== 'number') return 0
    return hipShiftToScreenXPx({
      shiftXM: hipShiftXM,
      shiftZM: hipShiftZM,
      yawRad: root.rotation.y,
      pixelsPerMeter: this.pxPerMeter
    })
  }

  /** 调试/冒烟：强制切姿态（未启用驱动/未知姿态返回 false）。 */
  debugSetPose(poseId: string, fadeMs?: number): boolean {
    if (!this.poseDriver) return false
    try {
      return this.poseDriver.setPose(poseId, fadeMs) === true
    } catch (error) {
      this.recordAnimationFailure(error)
      return false
    }
  }

  /** 调试/冒烟：强制注视角度（度；未启用驱动时忽略）。 */
  debugSetGaze(yawDeg: number, pitchDeg: number): void {
    if (!this.poseDriver) return
    try {
      this.poseDriver.setGaze(yawDeg, pitchDeg)
    } catch (error) {
      this.recordAnimationFailure(error)
    }
  }

  /** 模型加载完成后异步创建动画驱动（工厂由 main.ts 注入；失败仅降级不抛）。 */
  private async createPoseDriverIfNeeded(): Promise<void> {
    const factory = this.poseDriverFactory
    const avatar = this.avatar
    const root = this.modelRoot
    if (factory === undefined || avatar === null || root === null) return
    try {
      const driver = await factory({ avatar, root, motionSet: this.motionSet })
      // 加载期间未发生重载（本类当前只加载一次，保留判等防御异步竞态）；已 dispose 则不挂载
      // （驱动的释放归 main.ts 持有点，见 shutdown 的 vrmAnimator.dispose）。
      if (this.disposed || this.avatar !== avatar) return
      this.poseDriver = driver
    } catch (error) {
      this.recordAnimationFailure(error, '姿态驱动创建失败')
    }
  }

  /** 记录动画错误并降级为静态 rest（骨骼归位到 rest；渲染继续）。 */
  private recordAnimationFailure(error: unknown, label = '姿态更新失败'): void {
    if (!this.animationFailure) {
      this.animationFailure = `${label}: ${
        error instanceof Error ? error.message : String(error)
      }`
      console.error('[pet-scene-vrm]', this.animationFailure, error)
    }
    this.poseDriver = null
    this.pendingAnimationInput = null
    // 已降级为静态 rest：解除启动门控（否则会因为等不到 clip 姿势而永久隐身）。
    this.firstAnimationApplied = true
    this.startupPoseWaitStartedMs = null
    try {
      this.avatar?.vrm.humanoid.resetPose()
      this.avatar?.vrm.humanoid.update()
    } catch {
      // 归零失败不阻塞渲染。
    }
    this.applyModelTransform()
  }

  /* ------------------------------ 启动姿势门控（可见性唯一 owner） ------------------------------ */

  /**
   * 唯一写 `modelRoot.visible` 的地方。
   *
   * 用户 2026-11-09 反馈启动闪 T/A-pose 的根因之一：旧实现在 `applyModelTransform()` 里
   * `root.visible = petVisible`，绕过了 `firstAnimationApplied` 门控——模型加载完成后、
   * 动画驱动创建/首帧写骨前就被渲染成 VRM rest T-pose（实测可见 ~69ms + 中间态 ~135ms）。
   * 现在所有可见性变化都收敛到本方法：`visible = petVisible && placed && startupPoseApplied`。
   */
  private syncModelVisibility(): void {
    const root = this.modelRoot
    if (root === null) return
    root.visible = computeModelVisible({
      petVisible: this.petVisible,
      placed: this.placement !== null,
      startupPoseApplied: this.firstAnimationApplied
    })
  }

  /**
   * 每帧在 `poseDriver.update()` 之后调用：只有 clip 姿势**完整写入**（weight≈1、非 rest）
   * 才解除启动门控并显示模型。首帧吸附后通常第一次 update 即满足（不会出现 rest 帧）。
   */
  private markStartupPoseAppliedIfReady(): void {
    if (this.firstAnimationApplied || this.poseDriver === null) return
    let applied = false
    try {
      applied = isStartupPoseApplied(this.poseDriver.getDebugSnapshot())
    } catch {
      applied = false
    }
    if (!applied) return
    this.firstAnimationApplied = true
    this.startupPoseWaitStartedMs = null
    this.syncModelVisibility()
  }

  /**
   * 启动门控兜底：驱动存在但姿势迟迟未应用（clip 未就绪/降级/无动画输入）→ 超时显示静态 rest。
   * 正常情况下第一次 update 就满足门控，不会走到超时分支。
   */
  private waitForStartupPose(nowMs: number): void {
    if (this.startupPoseWaitStartedMs === null) {
      this.startupPoseWaitStartedMs = nowMs
      return
    }
    if (!startupPoseFallbackDue(this.startupPoseWaitStartedMs, nowMs, STARTUP_POSE_FALLBACK_MS)) {
      return
    }
    this.firstAnimationApplied = true
    this.startupPoseWaitStartedMs = null
    console.warn(
      `[pet-scene-vrm] 启动姿势 ${STARTUP_POSE_FALLBACK_MS}ms 内未完整应用（clip 未就绪/降级），改为显示静态 rest`
    )
    this.syncModelVisibility()
  }

  /* ------------------------------ PetView：摆放 / 渲染循环 ------------------------------ */

  /**
   * 摆放模型：`rect` 为窗口本地 CSS 像素矩形（y 向下），`feetY` 为脚底本地 y。
   * 世界坐标：x = rect 中心 − rest 中心 × scale；y = viewport.height − feetY（y 向上）。
   */
  placePet(rect: Rect, feetY: number): void {
    this.placement = { rect: { ...rect }, feetY }
    this.applyModelTransform()
  }

  /** 每帧调用：按 fpsCap 跳帧，真正渲染返回 true；被跳过返回 false。 */
  step(nowMs: number): boolean {
    if (this.disposed) return false
    if (!this.frameRate.shouldRender(nowMs)) return false
    // F10：钳制 delta（睡眠/遮挡恢复后的首帧可能极大），动画驱动用同一时间步。
    const deltaSeconds =
      this.lastRenderMs === null
        ? 0
        : Math.min(MAX_FRAME_DELTA_SECONDS, Math.max(0, (nowMs - this.lastRenderMs) / 1000))
    this.lastRenderMs = nowMs

    // 朝向平滑（facing → 侧身朝移动方向；转身不瞬移）。
    if (this.facingYawCurrent !== this.facingYawTarget) {
      const alpha = 1 - Math.exp(-deltaSeconds / FACING_SMOOTH_TAU_SEC)
      this.facingYawCurrent +=
        (this.facingYawTarget - this.facingYawCurrent) * Math.min(1, Math.max(0, alpha))
      if (Math.abs(this.facingYawTarget - this.facingYawCurrent) < 0.002) {
        this.facingYawCurrent = this.facingYawTarget
      }
      if (this.modelRoot) {
        this.modelRoot.rotation.y = this.modelYawOffsetRad + this.facingYawCurrent
      }
    }

    if (this.poseDriver !== null && this.pendingAnimationInput !== null) {
      // R-17：复用输入容器 + petRect（poseDriver/animator/clip-player 均同步读取，不跨帧持有引用），
      // 不再每渲染帧 spread 出 2–3 个新对象。
      const pending = this.pendingAnimationInput
      if (this.placement !== null) {
        const rect = this.placement.rect
        this.framePetRect.x = rect.x
        this.framePetRect.y = rect.y
        this.framePetRect.width = rect.width
        this.framePetRect.height = rect.height
      } else {
        this.framePetRect.x = 0
        this.framePetRect.y = 0
        this.framePetRect.width = 0
        this.framePetRect.height = 0
      }
      let input = this.frameAnimationInput
      if (input === null) {
        input = {
          ...pending,
          dt: deltaSeconds,
          petRect: this.framePetRect,
          viewportHeight: this.viewport.height
        }
        this.frameAnimationInput = input
      } else {
        input.dt = deltaSeconds
        input.mood = pending.mood
        input.motion = pending.motion
        input.facing = pending.facing
        input.lookTarget = pending.lookTarget
        input.dragging = pending.dragging
        input.events = pending.events
        input.bubbleText = pending.bubbleText
        input.viewportHeight = this.viewport.height
      }
      try {
        this.poseDriver.update(input)
        // 姿势真正写好（weight≈1）才允许显示：避免从 rest T-pose 混出的 T/A 中间态。
        this.markStartupPoseAppliedIfReady()
      } catch (error) {
        this.recordAnimationFailure(error)
      }
    } else if (this.avatar !== null) {
      // 无驱动/未注入输入：至少推进 three-vrm（spring bone / 表情材质 / 内建 lookAt）。
      try {
        this.avatar.vrm.update(deltaSeconds)
      } catch (error) {
        this.recordAnimationFailure(error)
      }
    }

    // 兜底：驱动存在但启动姿势未应用（无动画输入/clip 降级）→ 超时后显示静态 rest，
    // 避免宠物永久隐身（比闪 T-pose 更糟）。正常路径第一次 update 就解除门控。
    if (!this.firstAnimationApplied && this.poseDriver !== null) {
      this.waitForStartupPose(nowMs)
    }

    // 单 pass 渲染：renderer.render 内部会 reset info（autoReset=true），渲染后读取本帧统计。
    this.renderer.render(this.scene, this.camera)
    const renderInfo = this.renderer.info.render
    this.lastDrawCalls = renderInfo.calls
    this.lastTriangles = renderInfo.triangles
    return true
  }

  /**
   * 单帧渲染统计。
   * `outlinePx` 暂为 0：VRM 不做屏幕空间 OutlineEffect（MToon 描边由材质自身渲染），
   * 设计文档 §3 允许返回 0 或 MToon 平均描边 px；smoke 对 vrm 后端放宽断言。
   */
  getRenderStats(
    nowMs: number = typeof performance === 'undefined' ? Date.now() : performance.now()
  ): PetRenderStats {
    return {
      fps: Math.round(this.frameRate.getFps(nowMs) * 10) / 10,
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      outlinePx: 0
    }
  }

  /**
   * 设置 morph 权重（VRM：expression 名；`trim()` 后匹配）。
   * 成功返回 true；未知 expression 名/未加载返回 false。
   */
  setMorph(name: string, weight: number): boolean {
    const manager = this.avatar?.vrm.expressionManager
    if (!manager || typeof name !== 'string') return false
    const trimmed = name.trim()
    if (trimmed.length === 0) return false
    const expression = manager.getExpression(trimmed)
    if (expression === null) return false
    const value = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0
    manager.setValue(expression.expressionName, value)
    return true
  }

  /* ------------------------------ 调试诊断（V1 冒烟） ------------------------------ */

  /**
   * VRM 场景运行时诊断（`window.__aventurineDebug.vrm` 来源；PMX 场景没有该方法）。
   * 未加载完成时返回资产占位值（骨/expression 计数为 0），加载后来自实测能力。
   */
  getVrmDiagnostics(): VrmRuntimeDiagnostics {
    const asset = this.avatarAsset
    const avatar = this.avatar
    if (avatar === null) {
      return {
        avatarId: asset.id,
        specVersion: asset.specVersion,
        humanoidBoneCount: 0,
        requiredMissingBones: [...VRM_REQUIRED_HUMANOID_BONES],
        expressionCount: 0,
        springChainCount: 0,
        lookAtMode: asset.lookAt.mode,
        bodyAspectRatio: FALLBACK_BODY_ASPECT_RATIO,
        restHeightMeters: asset.heightMeters,
        hipsRestHeight: 0,
        materialCount: 0,
        yawOffsetDeg: asset.yawOffsetDeg
      }
    }

    const capabilities = avatar.capabilities
    const presentBones = new Set(capabilities.humanoidBones)
    const requiredMissingBones = VRM_REQUIRED_HUMANOID_BONES.filter(
      (bone) => !presentBones.has(bone)
    )
    // lookAtMode 报「实际可用」状态：模型自带 VRM lookAt → 'vrm'；否则用 manifest 配置的 mode。
    const lookAtMode = capabilities.hasLookAt ? 'vrm' : asset.lookAt.mode
    return {
      avatarId: asset.id,
      specVersion: capabilities.specVersion,
      humanoidBoneCount: capabilities.humanoidBones.length,
      requiredMissingBones,
      expressionCount: avatar.expressionNames.length,
      springChainCount: countVrmSpringBoneChains(avatar.vrm),
      lookAtMode,
      bodyAspectRatio: avatar.bodyAspectRatio,
      restHeightMeters: avatar.restHeightMeters,
      hipsRestHeight: avatar.hipsRestHeight,
      materialCount: avatar.materialNames.length,
      yawOffsetDeg: asset.yawOffsetDeg
    }
  }

  /* ------------------------------ PetView：资源释放（R-01） ------------------------------ */

  /**
   * 释放本场景持有的 WebGL/three 资源（页面卸载/模型切换时调用；**幂等**，异常只 warn 不抛）。
   *
   * 顺序（对齐 three.js cleanup 手册 + R-01 复核结论）：
   * 1. 清掉延迟重载 timer、摘除 canvas 的 contextlost/restored 监听（避免 dispose 触发的
   *    `forceContextLoss()` 反过来触发 B-02 的 reload）；
   * 2. 从 `scene` 摘除 `modelRoot`；
   * 3. `avatar.dispose()`（内部 `VRMUtils.deepDispose` 释放 mesh geometry/material/texture）；
   * 4. 兜底 traverse `modelRoot` + `avatar.scene`（共享 Set 去重）：deepDispose 只覆盖 Mesh，
   *    这里补上材质字段里的贴图/非 Mesh 节点；与 deepDispose 重叠的部分重复 dispose 是安全的
   *    （three 的 dispose 是事件通知，第二次无对应 GPU 资源）；
   * 5. `renderer.dispose()` → `forceContextLoss()` → 从 DOM 移除 canvas；
   * 6. `THREE.Cache` 仅在显式启用时 clear（R-19 撤回：默认关闭，不做无条件清理）；
   * 7. 置空 avatar/modelRoot/poseDriver 等引用（`vrmAvatar` 是 manifest 资产，main.ts 不 dispose 它）。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    if (this.contextReloadTimer !== null) {
      window.clearTimeout(this.contextReloadTimer)
      this.contextReloadTimer = null
    }

    const canvas = this.renderer.domElement
    try {
      canvas.removeEventListener('webglcontextlost', this.handleContextLost)
      canvas.removeEventListener('webglcontextrestored', this.handleContextRestored)
    } catch (error) {
      console.warn('[pet-scene-vrm] canvas 监听移除失败（已忽略）', error)
    }

    const avatar = this.avatar
    const modelRoot = this.modelRoot

    // 1) 从场景树摘除模型根（之后不再渲染）。
    if (modelRoot !== null) {
      try {
        this.scene.remove(modelRoot)
      } catch (error) {
        console.warn('[pet-scene-vrm] modelRoot 摘除失败（已忽略）', error)
      }
    }

    // 2) 官方释放路径（VRMUtils.deepDispose）。
    try {
      avatar?.dispose()
    } catch (error) {
      console.warn('[pet-scene-vrm] avatar.dispose 失败（继续兜底释放）', error)
    }

    // 3) 兜底 traverse（共享 Set 去重；两棵树之间共享的 geometry/material/texture 只释放一次）。
    const disposedResources = new Set<object>()
    try {
      disposeObjectTreeResources(modelRoot, disposedResources)
    } catch (error) {
      console.warn('[pet-scene-vrm] modelRoot 资源兜底释放失败（已忽略）', error)
    }
    try {
      disposeObjectTreeResources(avatar?.scene, disposedResources)
    } catch (error) {
      console.warn('[pet-scene-vrm] avatar.scene 资源兜底释放失败（已忽略）', error)
    }

    // 4) WebGLRenderer / WebGL context / canvas DOM。
    try {
      this.renderer.dispose()
    } catch (error) {
      console.warn('[pet-scene-vrm] renderer.dispose 失败（已忽略）', error)
    }
    try {
      this.renderer.forceContextLoss()
    } catch (error) {
      console.warn('[pet-scene-vrm] renderer.forceContextLoss 失败（已忽略）', error)
    }
    try {
      canvas.remove()
    } catch (error) {
      console.warn('[pet-scene-vrm] canvas 移除失败（已忽略）', error)
    }

    // 5) GLTFLoader/TextureLoader 走 THREE.Cache 单例；默认关闭（R-19 撤回），仅启用时清理。
    try {
      if (Cache.enabled) Cache.clear()
    } catch (error) {
      console.warn('[pet-scene-vrm] THREE.Cache.clear 失败（已忽略）', error)
    }

    // 6) 释放引用（poseDriver 由 main.ts 的 vrmAnimator.dispose 负责，见 shutdown）。
    this.avatar = null
    this.modelRoot = null
    this.poseDriver = null
    this.pendingAnimationInput = null
    this.frameAnimationInput = null
    this.placement = null
    this.worldRect = null
    this.loadPromise = null
    this.lastRenderMs = null
  }

  /* ------------------------------ 私有：光照 / 贴图 / 摆放 ------------------------------ */

  /** 光照：ambient + 主光 + 补光 + 轮廓光（MToon 需要 ambient + directional；r171 物理单位）。 */
  private setupLights(): void {
    this.scene.add(new AmbientLight(0xffffff, LIGHT_AMBIENT))

    const keyLight = new DirectionalLight(LIGHT_KEY_COLOR, LIGHT_KEY)
    keyLight.position.set(1.1, 2.0, 1.7)
    this.scene.add(keyLight)

    const fillLight = new DirectionalLight(LIGHT_FILL_COLOR, LIGHT_FILL)
    fillLight.position.set(-1.8, 0.9, 1.1)
    this.scene.add(fillLight)

    const rimLight = new DirectionalLight(LIGHT_RIM_COLOR, LIGHT_RIM)
    rimLight.position.set(-0.4, 1.4, -2.0)
    this.scene.add(rimLight)
  }

  /**
   * 贴图质量：对 VRM 实际使用的贴图开各向异性过滤（正交相机下衣摆/头发仍有斜视角纹理；
   * 默认无各向异性时斜视区域会发糊）。GPU 不支持时静默跳过（最多 8x，与 PMX 一致）。
   */
  private applyTextureQuality(): void {
    const avatar = this.avatar
    if (avatar === null) return
    let maxAnisotropy = 1
    try {
      maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy()
    } catch {
      maxAnisotropy = 1
    }
    for (const texture of collectVrmTextures(avatar.vrm)) {
      texture.anisotropy = Math.min(8, maxAnisotropy)
      texture.needsUpdate = true
    }
  }

  /**
   * 把窗口本地 CSS px 矩形映射到**米制世界坐标**（y 向上、原点视口左下角）。
   *
   * 关键（Lead 设计修正，task-2 追加）：`modelRoot.scale = 1`，模型保持米制 —— SpringBone
   * 物理在原生尺度下更新；视觉尺寸由正交相机视锥（米）与 `pxPerMeter` 换算实现。
   * `petWorldRect` 对外仍换算回 CSS px（与 PMX `PetScene.worldRect` 同语义）。
   */
  private applyModelTransform(): void {
    const root = this.modelRoot
    const avatar = this.avatar
    const placement = this.placement
    if (root === null || avatar === null || placement === null) return
    const { rect, feetY } = placement
    if (!(rect.height > 0) || !(rect.width > 0)) return

    // 1 米 = rect.height / restHeightMeters 个 CSS px（宠物高度换算基准）。
    const pxPerMeter = rect.height / avatar.restHeightMeters
    this.pxPerMeter = pxPerMeter > 0 && Number.isFinite(pxPerMeter) ? pxPerMeter : 1

    // 摆放：rect 是窗口本地 px（y 向下）→ 世界米（y 向上）；扣除 rest 中心/脚底偏移。
    const centerXPx = rect.x + rect.width / 2
    const feetYPx = this.viewport.height - feetY
    root.position.set(
      centerXPx / this.pxPerMeter - this.restCenterX,
      feetYPx / this.pxPerMeter - avatar.restFeetY + this.visualOffsetPx / this.pxPerMeter,
      0
    )
    root.scale.setScalar(1)
    // 朝向：manifest 朝向修正 + 行走朝向（±90° 侧身）。
    root.rotation.set(0, this.modelYawOffsetRad + this.facingYawCurrent, 0)
    // 可见性不在此处处理（旧实现 `root.visible = petVisible` 会绕过启动门控、露出 rest T/A-pose）；
    // 统一由 syncModelVisibility() 决定，放在矩阵更新之后。
    root.updateMatrixWorld(true)
    this.syncModelVisibility()
    // 场景外消费方（Lead 的 clip-player：footErrorPx/步速匹配）需要的 px/m 换算；
    // root.scale 恒为 1（SpringBone 原生尺度），不要把 scale 当 pxPerMeter 用。
    root.userData['pixelsPerMeter'] = this.pxPerMeter

    this.updateCameraProjection()

    // 对外调试矩形换算回 CSS px：y 为世界坐标下边界（脚底），向上延伸高度。
    this.worldRect = {
      x: centerXPx - (this.restWidthMeters * this.pxPerMeter) / 2,
      y: feetYPx,
      width: this.restWidthMeters * this.pxPerMeter,
      height: avatar.restHeightMeters * this.pxPerMeter
    }
  }

  /** 按当前 `pxPerMeter` 更新米制正交相机视锥（视口 CSS px → 世界米）。 */
  private updateCameraProjection(): void {
    const pxPerMeter = this.pxPerMeter > 0 && Number.isFinite(this.pxPerMeter) ? this.pxPerMeter : 1
    this.camera.left = 0
    this.camera.right = this.viewport.width / pxPerMeter
    this.camera.top = this.viewport.height / pxPerMeter
    this.camera.bottom = 0
    this.camera.updateProjectionMatrix()
  }
}
