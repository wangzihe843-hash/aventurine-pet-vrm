/**
 * 宠物 3D 场景 —— WebGLRenderer + 正交相机 + PMX 模型 + 轻量微动（A2 核心）。
 *
 * 关键决策（PLAN §18.2 / §18.3）：
 * - `WebGLRenderer({ alpha: true, antialias: true })` + `setClearColor(0x000000, 0)`，
 *   透明 overlay 上直接合成，不引入背景色；
 * - 正交相机，世界单位 = CSS 像素：视锥 `left=0,right=w,top=h,bottom=0`，
 *   原点在视口**左下角**、y 向上；`petRect` 的窗口本地坐标（y 向下）在这里换算成世界坐标；
 * - PMX 朝向：解析后模型面朝 +Z（脚趾/鼻子朝 +Z），相机在 +Z 看向 -Z，无需 yaw 180°
 *   （§11 提示的修正以本机实机截图复核确认；换模型时再改 `MODEL_YAW_CORRECTION`）；
 * - `MMDAnimationHelper.add(mesh, { physics: false })`：Wave 1 不引入 ammo.js；
 *   无 VMD 时 helper.update 为空操作，但先挂上，B2/B3 可直接驱动骨骼/IK；
 * - 描边用**屏幕空间自适应**方案（PLAN §19.11 方案 B）：vendored `outline-effect-screen.ts`
 *   读取 PMX 材质的 edgeSize/edgeColor，厚度单位 = CSS 像素 → 横竖同宽、与窗口宽高比/DPR/
 *   模型缩放解耦；目标像素随宠物屏幕高度轻度自适应（`outline-thickness.ts`）；
 * - 尺寸/位置由纯模块 `model/layout.ts` 计算，本文件只负责把窗口本地矩形映射进世界坐标。
 */
import {
  AmbientLight,
  Cache,
  DirectionalLight,
  Group,
  OrthographicCamera,
  Scene,
  SkinnedMesh,
  WebGLRenderer
} from 'three'
import { MMDAnimationHelper } from 'three/examples/jsm/animation/MMDAnimationHelper.js'
import { OutlineEffect } from './outline-effect-screen'

/**
 * vendored 的 `outline-effect-screen.ts` 带 `@ts-nocheck`（逐字节保留上游 JS 结构），
 * TS 推断不到构造函数里挂的实例方法；这里给出本文件实际使用的最小类型面。
 */
interface ScreenSpaceOutlineEffect {
  enabled: boolean
  autoClear: boolean
  render(scene: Scene, camera: OrthographicCamera): void
  renderOutline(scene: Scene, camera: OrthographicCamera): void
  setSize(width: number, height: number, updateStyle?: boolean): void
  /** 屏幕空间描边专用：写入 CSS 像素视口（不重复调用 renderer.setSize）。 */
  setViewportSize(width: number, height: number): void
}
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js'

import type { Rect } from '@shared/types'

import type {
  AnimationDebugSnapshot,
  AnimationDriverInput,
  AnimationInput,
  PoseDriver
} from '../core/wave2-contract'
import { createPetAssetLoadTracker, type PetAssetLoadTracker } from '../assets/pet-asset'
import {
  DEFAULT_TEXTURE_MAX_RETRIES,
  DEFAULT_TEXTURE_RETRY_BASE_MS,
  installRetryingTextureLoader
} from '../assets/retrying-texture-loader'
import { computeBindPoseBoundingBox } from '../model/bounding'
import { FALLBACK_MODEL_ASPECT, type Size2D } from '../model/layout'
import {
  createMorphLookup,
  findMorphIndex,
  resolveMaterialMorphBindings,
  type MorphLookup
} from '../model/morph-map'
import { disposeObjectTreeResources } from '../vrm/dispose'
import { FrameRateController } from './fps-limiter'
import { IdleMotion } from './idle-motion'
import { MaterialMorphController } from './material-morphs'
import {
  computeMaterialOutlinePx,
  computeOutlineBasePx,
  OUTLINE_EDGE_REFERENCE
} from './outline-thickness'
import { computePixelRatio } from './pixel-ratio'

/** 相机到模型的距离（世界单位 = CSS 像素；模型 z 跨度只有几十 px，1000 足够远）。 */
const CAMERA_DISTANCE = 1000

/** 相机近/远裁剪面。 */
const CAMERA_NEAR = 10
const CAMERA_FAR = 2000

/** PMX 朝向校正角（弧度）。模型解析后朝 +Z（面向相机），当前无需旋转；换模型时再改。 */
const MODEL_YAW_CORRECTION = 0

/**
 * 移动朝向角（弧度）：B2 的 facing='left'/'right' 时把 modelRoot 绕 Y 转 ±90°，
 * 让宠物**面朝移动方向**（侧身走路），避免用户反馈的「像螃蟹一样横着走」。
 * ±90° 与 B3 look-at 的局部化假设一致（facingTurnRad：left=−π/2、right=+π/2）。
 */
const MOVING_FACING_YAW_RAD = Math.PI / 2

/** 朝向平滑时间常数（秒）：转身太快会突兀，太慢像漂移。 */
const FACING_SMOOTH_TAU_SEC = 0.16

/** 光照强度（实机调参结果，见 visual-report）：
 * ambient + 主光 + 补光 + 轮廓光；MMDToonMaterial 是 phong 派生的 toon 材质，
 * 强度给太高会把白色衣装/皮肤直接 clip 成纯白（首版 1.1/2.2/0.8/0.9 过曝）。
 */
const LIGHT_AMBIENT = 0.55
const LIGHT_KEY = 1.0
const LIGHT_FILL = 0.25
const LIGHT_RIM = 0.3

/** 单帧 delta 上限（秒）：窗口被遮挡/睡眠恢复后 rAF 首帧 delta 可能极大，B2/B3 接动作后
 * 会跳变（F10）。统一在这里钳制，helper / idleMotion 用同一个时间步。 */
const MAX_FRAME_DELTA_SECONDS = 0.1

/** PMX 贴图加载的指数退避重试（F04，单张最多 3 次，250/500/1000ms）。 */
const TEXTURE_RETRY_MAX = DEFAULT_TEXTURE_MAX_RETRIES
const TEXTURE_RETRY_BASE_MS = DEFAULT_TEXTURE_RETRY_BASE_MS

/** 模型加载快照（`window.__aventurineDebug.model` 的字段来源）。 */
export interface PetModelSnapshot {
  loaded: boolean
  morphNames: string[]
  materialNames: string[]
  textureCount: number
  missingTextures: string[]
  vertexCount?: number
  triangleCount?: number
}

/** 单帧渲染统计。 */
export interface PetRenderStats {
  fps: number
  drawCalls: number
  triangles: number
  /** 当前基础描边宽度（CSS 像素，屏幕空间恒定 + 随宠物高度自适应；未摆放为 0）。 */
  outlinePx: number
}

/** 摆放参数：窗口本地 CSS 像素矩形（y 向下） + 脚底锚点 y。 */
export interface PetPlacement {
  rect: Rect
  feetY: number
}

/** PoseDriver 工厂上下文（B3 创建 animator 所需的最小 three 引用）。 */
export interface PoseDriverContext {
  mesh: SkinnedMesh
  root: Group
  helper: MMDAnimationHelper
}

/** PetScene 可选依赖（Wave 2 集成：B3 姿态驱动工厂；不传则维持 Wave 1 的微动行为）。 */
export interface PetSceneOptions {
  /**
   * B3 姿态驱动工厂：PMX 加载完成后调用一次；返回 null 表示降级（保持 A-pose/微动）。
   * 由 main.ts 注入 `createPetAnimator`，避免 pet-scene.ts 直接 import B3 模块。
   */
  createPoseDriver?: (context: PoseDriverContext) => PoseDriver | null
}

/** 模型包围盒（解析后本地单位）。 */
interface ModelBoxInfo {
  width: number
  height: number
  centerX: number
  minY: number
}

/** 宠物 3D 场景（一个 overlay 窗口一个实例）。 */
export class PetScene {
  readonly renderer: WebGLRenderer

  private readonly scene = new Scene()
  private readonly camera: OrthographicCamera
  // F13（可接受）：r171 的 MMDAnimationHelper 构造函数会无条件打印一条 "deprecated
  // in r172" console.warn（每个 overlay 页面一条）。three 0.171 是 PLAN 唯一选定版本，
  // 不 hook console；记录为 pin r171 的已知噪声（换 three/loader 时再处理）。
  private readonly helper = new MMDAnimationHelper()
  private readonly idleMotion = new IdleMotion()
  private readonly frameRate: FrameRateController
  private readonly tracker: PetAssetLoadTracker
  private readonly outlineEffect: ScreenSpaceOutlineEffect

  private mesh: SkinnedMesh | null = null
  private modelRoot: Group | null = null
  private materialMorphs: MaterialMorphController | null = null
  private modelBox: ModelBoxInfo = { width: 1, height: 1, centerX: 0, minY: 0 }
  private morphLookup: MorphLookup = { names: [], namesByIndex: [], count: 0 }
  private materialNames: string[] = []
  /** 描边材质（Ordinal 与 materialNames 一致；用户在 = 待写入 outlineParameters.thickness）。 */
  private outlineMaterials: ReadonlyArray<object> = []
  /** 每材质的 PMX edgeSize（0 = 该材质无描边 / 未启用），用于保留作者相对粗细。 */
  private outlineEdgeSizes: number[] = []
  /** 当前基础描边宽度（CSS 像素；0 = 宠物未摆放）。 */
  private outlineBasePx = 0
  private vertexCount = 0
  private triangleCount = 0

  private viewport: Size2D = { width: 1, height: 1 }
  private placement: PetPlacement | null = null
  private baseScale = 1
  private petVisible = true
  private lastRenderMs: number | null = null
  private worldRect: Rect | null = null
  /** 当前/目标朝向角（弧度，绕 Y；0=面向镜头、±π/2=侧身朝移动方向）。 */
  private facingYawCurrent = 0
  private facingYawTarget = 0
  /** 最近一帧的渲染统计（F03：OutlineEffect 两个 pass 的累计值）。 */
  private lastDrawCalls = 0
  private lastTriangles = 0
  /** 贴图重试 loader 是否已安装到 LoadingManager（只装一次）。 */
  private textureRetryInstalled = false
  /** 是否已 dispose（R-01/R-02：幂等；legacy 路径 best-effort）。 */
  private disposed = false

  /* ------------------------- Wave 2：B3 姿态驱动（Lead 接线） ------------------------- */
  /** B3 姿态驱动（null = 未注入 / 创建失败 / 运行出错降级 → 走 Wave 1 微动路径）。 */
  private poseDriver: PoseDriver | null = null
  private readonly poseDriverFactory?: (context: PoseDriverContext) => PoseDriver | null
  /** main.ts 每帧注入的动画输入（dt/petRect/viewportHeight 由本类补齐）。 */
  private pendingAnimationInput: AnimationDriverInput | null = null
  /** 动画运行时错误（首个；非空且 poseDriver===null 表示已降级）。 */
  private animationFailure: string | null = null

  constructor(container: HTMLElement, fpsCap?: number, options: PetSceneOptions = {}) {
    this.poseDriverFactory = options.createPoseDriver
    this.frameRate = new FrameRateController(fpsCap)
    this.tracker = createPetAssetLoadTracker()

    // 透明 canvas：所有像素 alpha 由模型/贴图决定，窗口合成时透出桌面。
    this.renderer = new WebGLRenderer({ alpha: true, antialias: true })
    this.renderer.setClearColor(0x000000, 0)
    // pixelRatio 依赖视口尺寸（F08 像素预算），在 setViewport() 里按 CSS 面积计算：
    // 1x 屏在 4K 像素预算内超采样（1080p→2x、1440p→1.5x、4K→1x），Retina 按原生 dpr。

    const canvas = this.renderer.domElement
    canvas.id = 'pet-canvas'
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    canvas.style.pointerEvents = 'none'
    container.appendChild(canvas)

    this.camera = new OrthographicCamera(0, 1, 1, 0, CAMERA_NEAR, CAMERA_FAR)
    this.camera.position.set(0, 0, CAMERA_DISTANCE)
    this.camera.lookAt(0, 0, 0)

    this.outlineEffect = new OutlineEffect(this.renderer) as unknown as ScreenSpaceOutlineEffect
    this.setupLights()
  }

  /** 当前 PMX 是否已加载完成（贴图可能仍在后台解码）。 */
  get modelLoaded(): boolean {
    return this.mesh !== null
  }

  /** 模型包围盒宽高比（宽 / 高）；未加载时返回占位值。 */
  get modelAspectRatio(): number {
    if (!this.modelLoaded || this.modelBox.height <= 0) return FALLBACK_MODEL_ASPECT
    return this.modelBox.width / this.modelBox.height
  }

  /** 模型在世界坐标（视口左下原点、y 向上）中的矩形；未摆放时为 null。 */
  get petWorldRect(): Rect | null {
    return this.worldRect ? { ...this.worldRect } : null
  }

  /** 模型加载快照（供调试面/验收）。 */
  snapshot(): PetModelSnapshot {
    return {
      loaded: this.mesh !== null,
      morphNames: [...this.morphLookup.names],
      materialNames: [...this.materialNames],
      textureCount: this.tracker.textureCount,
      missingTextures: [...this.tracker.missingTextures],
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount
    }
  }

  /** 等待贴图加载结束（成功/失败/超时），供 `ready` 判定与验收统计。 */
  waitForTextures(timeoutMs = 4000): Promise<void> {
    return this.tracker.whenIdle(timeoutMs)
  }

  /**
   * 更新视口 CSS 尺寸：pixelRatio 按像素预算随视口重算（F08）；投影坐标系仍是 CSS px。
   *
   * F12：只调一次 `renderer.setSize(w, h, false)`。three 的 `OutlineEffect.setSize`
   * 只是透传 `renderer.setSize(width,height,updateStyle)`（默认 updateStyle=true，会改
   * canvas 行内样式），旧实现每帧 resize 会调两次并覆盖 CSS 100% 的行内样式。
   */
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
    // 屏幕空间描边：把 CSS 像素视口交给 vendored OutlineEffect（只存 uniform，不重复 setSize）
    this.outlineEffect.setViewportSize(width, height)

    this.camera.left = 0
    this.camera.right = width
    this.camera.top = height
    this.camera.bottom = 0
    this.camera.updateProjectionMatrix()
    // 视口变化会改变世界坐标的高度基准：已摆放时重新套用（窗口 resize / 屏幕变化双保险）。
    this.applyModelTransform()
  }

  /** 热更帧率上限（`pet:get-config` / `config-changed`）。 */
  setFpsCap(fpsCap: number): void {
    this.frameRate.setCap(fpsCap)
  }

  /** 当前帧率上限。 */
  get fpsCap(): number {
    return this.frameRate.fpsCap
  }

  /** 整体不透明度（`opacity` 配置；只改 canvas CSS，不影响命中/坐标）。 */
  setOpacity(opacity: number): void {
    const value = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
    this.renderer.domElement.style.opacity = value === 1 ? '' : String(value)
  }

  /** 是否渲染宠物（Wave 1：非主屏窗口设为 false → 透明空场景）。 */
  setPetVisible(visible: boolean): void {
    this.petVisible = visible
    if (this.modelRoot) this.modelRoot.visible = visible && this.placement !== null
  }

  /**
   * 脸部描边调优（实机观感修正）：
   * - PMX 里 `颜 / 颜赤 / 肌 / 肌2 / 印` 的 edgeColor 是纯红（0.5,0,0,0.7），在 324px 桌宠上
   *   会在脸/脖子/手臂形成明显红圈，看起来像“脸脏/糊”；改为深棕近黑并压低 alpha，
   *   保留轮廓却不抢脸部细节。
   * - `颜赤` 是腮红叠加材质（默认 alpha=0），单独关掉描边（显示时否则会出现红圈）。
   * 其余材质（黑描边）保持 PMX 作者原样。
   */
  private tuneOutlineParameters(materials: ReadonlyArray<object>): void {
    const skinMaterials = new Set(['颜', '肌', '肌2', '印'])
    const edgeSizes: number[] = []
    for (const material of materials) {
      const source = material as {
        name?: string
        userData?: {
          outlineParameters?: {
            color?: number[]
            alpha?: number
            visible?: boolean
            thickness?: number
          }
        }
      }
      const outline = source.userData?.outlineParameters
      const name = (source.name ?? '').trim()
      // MMDLoader 给 PMX 材质的初始 thickness = edgeSize / 300（NDC 单位）；
      // 这里反解出作者 edgeSize，之后由 updateOutlineThickness() 统一改写成 CSS 像素。
      const authoredEdgeSize =
        outline && typeof outline.thickness === 'number' ? outline.thickness * 300 : 0
      edgeSizes.push(
        outline && outline.visible !== false && authoredEdgeSize > 0 ? authoredEdgeSize : 0
      )
      if (!outline) continue
      if (name === '颜赤') {
        outline.visible = false
        continue
      }
      if (!skinMaterials.has(name)) continue
      if (Array.isArray(outline.color) && outline.color.length >= 3) {
        outline.color = [0.22, 0.11, 0.09]
      }
      if (typeof outline.alpha === 'number') outline.alpha = Math.min(outline.alpha, 0.45)
    }
    this.outlineMaterials = materials
    this.outlineEdgeSizes = edgeSizes
    this.updateOutlineThickness()
  }

  /**
   * 把「目标 CSS 像素宽度」写回每个材质的 `outlineParameters.thickness`。
   *
   * vendored OutlineEffect 的 `updateUniforms()` 每帧从 `userData.outlineParameters` 读取
   * thickness（见 outline-effect-screen.ts 的 onBeforeRender 链路），因此：
   * - 尺寸/窗口/显示器变化后只需调用本方法一次，下一帧立即生效，无需清材质缓存；
   * - 单位是 CSS 像素（屏幕空间恒定），窗口宽高比 / DPR / 模型缩放都不改变实际像素宽度。
   */
  private updateOutlineThickness(): void {
    const petHeightPx = this.placement?.rect.height ?? 0
    const basePx = petHeightPx > 0 ? computeOutlineBasePx(petHeightPx) : 0
    this.outlineBasePx = basePx
    if (basePx <= 0) return
    for (let index = 0; index < this.outlineMaterials.length; index += 1) {
      const material = this.outlineMaterials[index] as {
        userData?: { outlineParameters?: { thickness?: number; visible?: boolean } }
      }
      const outline = material.userData?.outlineParameters
      if (!outline) continue
      const edgeSize = this.outlineEdgeSizes[index] ?? OUTLINE_EDGE_REFERENCE
      if (!(edgeSize > 0) || outline.visible === false) {
        outline.thickness = 0
        continue
      }
      outline.thickness = computeMaterialOutlinePx(petHeightPx, edgeSize)
    }
  }

  /**
   * 贴图质量：对颜色贴图 `map` 与环境贴图 `matcap` 开各向异性过滤（正交相机下衣摆/头发
   * 仍有斜视角纹理；默认无各向异性时斜视区域会发糊）。GPU 不支持时静默跳过。
   *
   * F14：`gradientMap`（MMD toon 贴图，loader 已设为 NearestFilter、无 mipmap）不处理
   * ——各向异性对它无意义；PLAN §19.7「全部贴图」的措辞应理解为 map/matcap。
   */
  private applyTextureQuality(materials: ReadonlyArray<object>): void {
    let maxAnisotropy = 1
    try {
      maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy()
    } catch {
      maxAnisotropy = 1
    }
    const seen = new Set<unknown>()
    for (const material of materials) {
      const source = material as { map?: unknown; matcap?: unknown }
      for (const texture of [source.map, source.matcap]) {
        if (!texture || typeof texture !== 'object' || seen.has(texture)) continue
        seen.add(texture)
        const candidate = texture as { anisotropy?: number; needsUpdate?: boolean }
        if (typeof candidate.anisotropy !== 'number') continue
        candidate.anisotropy = Math.min(8, maxAnisotropy)
        candidate.needsUpdate = true
      }
    }
  }

  /**
   * 加载 PMX（`pet-asset://model/<encodeURIComponent(文件名)>`）。
   * 贴图由 MMDLoader 按 PMX URL 的 base 自动拼接并走 `pet-asset://` 协议。
   */
  async loadModel(url: string): Promise<void> {
    if (this.mesh) return
    // F04：贴图加载失败按指数退避重试（handler 挂在 tracker 的 LoadingManager 上，只装一次）。
    if (!this.textureRetryInstalled) {
      installRetryingTextureLoader(this.tracker.manager, {
        maxRetries: TEXTURE_RETRY_MAX,
        baseDelayMs: TEXTURE_RETRY_BASE_MS,
        holdPending: () => this.tracker.holdPending()
      })
      this.textureRetryInstalled = true
    }
    const loader = new MMDLoader(this.tracker.manager)
    const mesh = await new Promise<SkinnedMesh>((resolve, reject) => {
      loader.load(
        url,
        (data) => {
          resolve(data)
        },
        undefined,
        (error) => {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      )
    })

    // M-1：只能用基础 position attribute 算**绑定姿势**包围盒。r171 的
    // geometry.computeBoundingBox() 会把 85 个 morph target 并入（= 所有表情并集），
    // 用它做缩放基准会让实际渲染高度偏小约 0.93%（540 → 约 535px）。
    const geometry = mesh.geometry
    const bindPose = computeBindPoseBoundingBox(geometry.getAttribute('position'))
    if (!bindPose) throw new Error('PMX 几何缺少有效的 position attribute')
    this.modelBox = {
      width: Math.max(1e-3, bindPose.width),
      height: Math.max(1e-3, bindPose.height),
      centerX: (bindPose.minX + bindPose.maxX) / 2,
      minY: bindPose.minY
    }

    // 不能用 Object.keys 下标当 morph 索引（'111'/'1111' 会被 JS 排到最前，与 PMX 索引错位）；
    // createMorphLookup 按字典值（真实索引）对齐 namesByIndex。
    this.morphLookup = createMorphLookup(mesh.morphTargetDictionary ?? {})
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    this.materialNames = materials.map((material) => material.name ?? '')
    this.applyTextureQuality(materials)
    this.tuneOutlineParameters(materials)
    this.vertexCount = geometry.getAttribute('position')?.count ?? 0
    const index = geometry.getIndex()
    this.triangleCount = index
      ? Math.floor(index.count / 3)
      : Math.floor(this.vertexCount / 3)

    // 材质 morph 绑定（照れ/目影消/目影濃 → 颜赤/目影 alpha；MMDLoader 不实现 type=8）
    const bindings = resolveMaterialMorphBindings(this.morphLookup.namesByIndex, this.materialNames)
    this.materialMorphs = new MaterialMorphController(mesh, bindings)

    // 关键：显式 physics:false（否则默认 true 会 new MMDPhysics 并要求全局 Ammo → 抛错）。
    this.helper.add(mesh, { physics: false })

    const root = new Group()
    root.name = 'pet-model-root'
    root.visible = false
    root.add(mesh)
    this.scene.add(root)

    this.mesh = mesh
    this.modelRoot = root
    this.createPoseDriver()
    this.applyModelTransform()
  }

  /* ------------------------- Wave 2：姿态驱动公共接口 ------------------------- */

  /** 是否已启用 B3 姿态驱动（false = Wave 1 微动降级路径）。 */
  get animationActive(): boolean {
    return this.poseDriver !== null
  }

  /** 动画运行时错误（首个；null = 无错误）。 */
  get animationFailureMessage(): string | null {
    return this.animationFailure
  }

  /**
   * 注入本帧动画输入（main.ts 在 `scene.step()` 前调用；未调用时 animator 不更新）。
   * dt/petRect/viewportHeight 由 PetScene 在 step 内补齐（单一来源，不让 main.ts 重复算）。
   */
  setAnimationInput(input: AnimationDriverInput): void {
    this.pendingAnimationInput = input
  }

  /**
   * 设置移动朝向（B2 facing → Lead 每帧调用）：left/right 时模型绕 Y 转 ±90° 面朝移动方向，
   * front 时回正面。转身在 step 内按指数平滑收敛，避免瞬间跳变。
   */
  setFacing(facing: 'left' | 'right' | 'front'): void {
    this.facingYawTarget =
      facing === 'left' ? -MOVING_FACING_YAW_RAD : facing === 'right' ? MOVING_FACING_YAW_RAD : 0
  }

  /** 调试面：B3 动画快照（未启用驱动时返回 null）。 */
  getAnimationSnapshot(): AnimationDebugSnapshot | null {
    if (!this.poseDriver) return null
    try {
      return this.poseDriver.getDebugSnapshot()
    } catch (error) {
      this.recordAnimationFailure(error)
      return null
    }
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

  /** PMX 加载完成后创建 B3 姿态驱动（工厂由 main.ts 注入；失败仅降级不抛）。 */
  private createPoseDriver(): void {
    if (!this.poseDriverFactory || !this.mesh || !this.modelRoot) return
    try {
      this.poseDriver = this.poseDriverFactory({
        mesh: this.mesh,
        root: this.modelRoot,
        helper: this.helper
      })
    } catch (error) {
      this.animationFailure = `姿态驱动创建失败: ${
        error instanceof Error ? error.message : String(error)
      }`
      console.error('[pet-scene]', this.animationFailure, error)
      this.poseDriver = null
    }
  }

  /** 记录动画错误并降级为 Wave 1 微动路径（骨骼归零到 bind pose）。 */
  private recordAnimationFailure(error: unknown): void {
    if (!this.animationFailure) {
      this.animationFailure = `姿态更新失败: ${
        error instanceof Error ? error.message : String(error)
      }`
      console.error('[pet-scene]', this.animationFailure, error)
    }
    this.poseDriver = null
    this.pendingAnimationInput = null
    try {
      this.mesh?.skeleton.pose()
    } catch {
      /* 归零失败不阻塞渲染 */
    }
    this.applyModelTransform()
  }

  /**
   * 摆放模型：`rect` 为窗口本地 CSS 像素矩形（y 向下），`feetY` 为脚底本地 y。
   * 映射到世界坐标：x 不变；y = viewport.height − feetY（世界 y 向上）。
   */
  placePet(rect: Rect, feetY: number): void {
    this.placement = { rect: { ...rect }, feetY }
    this.applyModelTransform()
    // 描边宽度随宠物屏幕高度自适应（30%→~0.71px、50%→~1.19px、100%→1.6px）
    this.updateOutlineThickness()
  }

  /** 每帧调用：按 fpsCap 跳帧，真正渲染返回 true；被跳过返回 false。 */
  step(nowMs: number): boolean {
    if (!this.frameRate.shouldRender(nowMs)) return false
    // F10：钳制 delta（睡眠/遮挡恢复后的首帧可能极大），helper/idleMotion 用同一时间步。
    const deltaSeconds =
      this.lastRenderMs === null
        ? 0
        : Math.min(MAX_FRAME_DELTA_SECONDS, Math.max(0, (nowMs - this.lastRenderMs) / 1000))
    this.lastRenderMs = nowMs

    // 朝向平滑（B2 facing → 面朝移动方向；转身不会瞬移，见 MOVING_FACING_YAW_RAD 注释）。
    if (this.facingYawCurrent !== this.facingYawTarget) {
      const alpha = 1 - Math.exp(-deltaSeconds / FACING_SMOOTH_TAU_SEC)
      this.facingYawCurrent += (this.facingYawTarget - this.facingYawCurrent) * Math.min(1, Math.max(0, alpha))
      if (Math.abs(this.facingYawTarget - this.facingYawCurrent) < 0.002) {
        this.facingYawCurrent = this.facingYawTarget
      }
      if (this.modelRoot) {
        this.modelRoot.rotation.y = MODEL_YAW_CORRECTION + this.facingYawCurrent
      }
    }

    // Wave 2：B3 接管骨骼写入时与 MMDAnimationHelper 互斥（survey §2.5：一旦有 mixer，
    // helper 会每帧 _restoreBones + IK + grant 覆盖手工姿态）。未启用时保留 Wave 1 路径。
    if (this.poseDriver && this.pendingAnimationInput) {
      const input: AnimationInput = {
        ...this.pendingAnimationInput,
        dt: deltaSeconds,
        petRect: this.placement ? { ...this.placement.rect } : { x: 0, y: 0, width: 0, height: 0 },
        viewportHeight: this.viewport.height
      }
      try {
        this.poseDriver.update(input)
      } catch (error) {
        this.recordAnimationFailure(error)
      }
      // 材质 morph 必须在 B3 写完顶点 morph influences 之后读取（照れ/目影消/目影濃）。
      this.materialMorphs?.update()
    } else {
      // 无 VMD 时是空操作；Wave 1 降级路径（B3 未接入 / 驱动失败）。
      this.helper.update(deltaSeconds)
      this.materialMorphs?.update()
      if (this.modelRoot && this.placement) {
        this.idleMotion.update(deltaSeconds)
        this.idleMotion.apply(this.modelRoot, this.baseScale)
      }
    }

    // F03：`renderer.info` 默认每次 render 自动 reset，而 OutlineEffect 一次 render 内部会
    // 跑两次 `renderer.render`（主 pass + 描边 pass）。先关自动 reset 再手动 reset，
    // 让一次 `outlineEffect.render` 后 info 累计两个 pass 的 drawCalls/triangles
    // （主 pass 39 材质 + 描边 pass ~21 材质），最后由 getRenderStats() 读取。
    const info = this.renderer.info
    const previousAutoReset = info.autoReset
    info.autoReset = false
    info.reset()
    try {
      this.outlineEffect.render(this.scene, this.camera)
      this.lastDrawCalls = info.render.calls
      this.lastTriangles = info.render.triangles
    } finally {
      info.autoReset = previousAutoReset
    }
    return true
  }

  /**
   * 单帧渲染统计。
   * `drawCalls/triangles` 是**全帧累计值**：OutlineEffect 主 pass + 描边 pass 相加
   * （F03；旧实现只统计第二次 render 的描边 pass，C4 性能读数会低估约 2.4×）。
   * `fps` 为最近 1s 实测值。
   */
  getRenderStats(
    nowMs: number = typeof performance === 'undefined' ? Date.now() : performance.now()
  ): PetRenderStats {
    return {
      fps: Math.round(this.frameRate.getFps(nowMs) * 10) / 10,
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      outlinePx: Math.round(this.outlineBasePx * 100) / 100
    }
  }

  /**
   * 设置 morph 权重（按 PMX 名称，`trim()` 后匹配；`星目 ` 这类尾随空格可省略）。
   * 成功返回 true；未知 morph 名返回 false。
   */
  setMorph(name: string, weight: number): boolean {
    const influences = this.mesh?.morphTargetInfluences
    if (!influences) return false
    const index = findMorphIndex(this.morphLookup.namesByIndex, name)
    if (index === null) return false
    const value = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0
    influences[index] = value
    return true
  }

  /**
   * 释放本场景持有的 WebGL/three 资源（R-01/R-02；页面卸载时由 `main.ts` 的 `scene?.dispose?.()` 调用）。
   *
   * legacy PMX 路径当前已无维护（默认后端是 VRM），这里只做 **best-effort**：
   * 解除 MMDAnimationHelper 对 mesh 的持有 → 释放模型子树 geometry/material/texture →
   * canvas 移除 + `renderer.dispose()`/`forceContextLoss()`；每个对象单独 try/catch，异常只 warn 不抛。
   * （MMDAnimationHelper 没有 dispose API；`remove(mesh)` 是它解除 mixer 持有的官方方式。）
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const mesh = this.mesh
    if (mesh !== null) {
      try {
        this.helper.remove(mesh)
      } catch (error) {
        console.warn('[pet-scene] MMDAnimationHelper.remove 失败（已忽略）', error)
      }
    }

    try {
      disposeObjectTreeResources(this.modelRoot)
    } catch (error) {
      console.warn('[pet-scene] 模型资源释放失败（已忽略）', error)
    }

    const canvas = this.renderer.domElement
    try {
      canvas.remove()
    } catch (error) {
      console.warn('[pet-scene] canvas 移除失败（已忽略）', error)
    }
    try {
      this.renderer.dispose()
    } catch (error) {
      console.warn('[pet-scene] renderer.dispose 失败（已忽略）', error)
    }
    try {
      this.renderer.forceContextLoss()
    } catch (error) {
      console.warn('[pet-scene] renderer.forceContextLoss 失败（已忽略）', error)
    }
    try {
      if (Cache.enabled) Cache.clear()
    } catch (error) {
      console.warn('[pet-scene] THREE.Cache.clear 失败（已忽略）', error)
    }

    this.mesh = null
    this.modelRoot = null
    this.materialMorphs = null
    this.poseDriver = null
    this.pendingAnimationInput = null
    this.placement = null
    this.worldRect = null
    this.lastRenderMs = null
  }

  /** 光照：ambient + 主方向光 + 补光 + 轮廓光（MMDToonMaterial 需要 ambient + directional）。 */
  private setupLights(): void {
    this.scene.add(new AmbientLight(0xffffff, LIGHT_AMBIENT))

    const keyLight = new DirectionalLight(0xffffff, LIGHT_KEY)
    keyLight.position.set(0.6, 1.0, 1.6)
    this.scene.add(keyLight)

    const fillLight = new DirectionalLight(0xffffff, LIGHT_FILL)
    fillLight.position.set(-1.2, 0.5, 0.9)
    this.scene.add(fillLight)

    const rimLight = new DirectionalLight(0xffffff, LIGHT_RIM)
    rimLight.position.set(-0.2, 1.2, -1.0)
    this.scene.add(rimLight)
  }

  /** 把窗口本地矩形映射到世界坐标（世界单位 = CSS 像素，y 向上、原点视口左下角）。 */
  private applyModelTransform(): void {
    if (!this.modelRoot || !this.placement) return
    const { rect, feetY } = this.placement
    if (!(rect.height > 0) || !(rect.width > 0)) return

    const box = this.modelBox
    const scale = rect.height / box.height
    this.baseScale = scale

    const worldCenterX = rect.x + rect.width / 2
    const worldFeetY = this.viewport.height - feetY
    this.modelRoot.position.set(
      worldCenterX - box.centerX * scale,
      worldFeetY - box.minY * scale,
      0
    )
    this.modelRoot.scale.setScalar(scale)
    // 朝向：MODEL_YAW_CORRECTION（模型自身校正）+ 行走朝向（±90° 侧身）。
    this.modelRoot.rotation.set(0, MODEL_YAW_CORRECTION + this.facingYawCurrent, 0)
    this.modelRoot.visible = this.petVisible
    this.modelRoot.updateMatrixWorld(true)

    this.worldRect = {
      x: worldCenterX - (box.width * scale) / 2,
      // 世界坐标 y 向上：y 为矩形下边界（脚底 = worldFeetY），向上延伸 height。
      y: worldFeetY,
      width: box.width * scale,
      height: box.height * scale
    }
  }
}
