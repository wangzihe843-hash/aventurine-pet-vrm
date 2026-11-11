/**
 * 宠物场景公共接口（`PetView`）—— V1 起 `main.ts` 在两种渲染后端间切换：
 *
 * - `legacy-pmx`：`scene/pet-scene.ts` 的 `PetScene`（PMX/MMDLoader + v1 动画，回退路径）；
 * - `vrm`：`vrm/pet-scene-vrm.ts` 的 `VrmPetScene`（three-vrm + humanoid clip）。
 *
 * 本文件是**纯类型模块**（不 import three/DOM 运行时），两个实现结构化满足该接口，
 * `main.ts` 只依赖此接口 → legacy 场景零改动、VRM 场景独立演进。
 *
 * 坐标/单位约定与 `PetScene` 完全一致：世界单位 = CSS 像素、正交相机、视口左下原点 y 向上；
 * `placePet` 的 rect 是窗口本地 CSS px（y 向下）。
 */
import type { Rect } from '@shared/types'

import type {
  AnimationDebugSnapshot,
  AnimationDriverInput,
  PoseDriver
} from '../core/wave2-contract'
import type { PetModelSnapshot, PetRenderStats } from './pet-scene'

export type { PetModelSnapshot, PetRenderStats }

/** VRM 场景运行时诊断（V1 调试面/冒烟用；PMX 场景无此字段）。 */
export interface VrmRuntimeDiagnostics {
  /** manifest 资产 id（如 `aventurine-waveflair`）。 */
  avatarId: string
  /** VRM spec 版本（`1.0` / `0.x`）。 */
  specVersion: string
  /** normalized humanoid 骨数（目标模型应 ≥ 52）。 */
  humanoidBoneCount: number
  /** 必需 15 骨中缺失的骨名（应为空）。 */
  requiredMissingBones: string[]
  /** expression 数（目标模型 95）。 */
  expressionCount: number
  /** spring bone 链数（目标模型 50）。 */
  springChainCount: number
  /** lookAt 模式（`vrm`/`procedural`/`none`）。 */
  lookAtMode: string | null
  /** 躯干宽/身高（宠物矩形宽高比）。 */
  bodyAspectRatio: number
  /** rest 包围盒高（米）。 */
  restHeightMeters: number
  /** normalized rest hips 高度（米；Hips.p 缩放基准）。 */
  hipsRestHeight: number
  /** MToon 材质数。 */
  materialCount: number
  /** manifest 朝向修正（度）。 */
  yawOffsetDeg: number
  /** 资产文件（assets 根相对路径；由 main.ts 补，冒烟拉取 app-manifest 断言用）。 */
  avatarFile?: string
}

/** 宠物场景视图接口（`main.ts` 唯一的场景依赖面）。 */
export interface PetView {
  /** 模型是否已加载完成（贴图可能仍在后台解码）。 */
  readonly modelLoaded: boolean
  /** 模型包围盒宽高比（宽/高）；未加载时返回占位值。 */
  readonly modelAspectRatio: number
  /** 模型在世界坐标（视口左下原点、y 向上）中的矩形；未摆放时为 null。 */
  readonly petWorldRect: Rect | null

  /** 模型加载快照（调试面/验收）。 */
  snapshot(): PetModelSnapshot
  /** 等待贴图加载结束（成功/失败/超时）。 */
  waitForTextures(timeoutMs?: number): Promise<void>
  /** 更新视口 CSS 尺寸（pixelRatio/相机/描边随动）。 */
  setViewport(viewport: { width: number; height: number }): void
  /** 热更帧率上限。 */
  setFpsCap(fpsCap: number): void
  /** 当前帧率上限。 */
  readonly fpsCap: number
  /** 整体不透明度（只改 canvas CSS）。 */
  setOpacity(opacity: number): void
  /** 是否渲染宠物（非主屏窗口 false）。 */
  setPetVisible(visible: boolean): void
  /** 加载模型（PMX：`pet-asset://model/...`；VRM：`pet-asset://assets/<avatar.file>`）。 */
  loadModel(url: string): Promise<void>

  /** 是否已启用动画驱动（false = 微动/静态降级）。 */
  readonly animationActive: boolean
  /** 动画运行时错误（首个；null = 无）。 */
  readonly animationFailureMessage: string | null
  /** 注入本帧动画输入（dt/petRect/viewportHeight 由场景补齐）。 */
  setAnimationInput(input: AnimationDriverInput): void
  /** 设置移动朝向（left/right 时模型面朝移动方向）。 */
  setFacing(facing: 'left' | 'right' | 'front'): void
  /** 动画调试快照（未启用驱动时 null）。 */
  getAnimationSnapshot(): AnimationDebugSnapshot | null
  /**
   * L2（M-3）：foot-lock hips 水平对齐的屏幕横向补偿（CSS px，向右为正；0 = 无补偿）。
   *
   * 身体视觉横移（≤0.18m ≈ 56px）必须让命中/气泡跟随；由 `VrmPetScene` 实现，
   * **PMX 后端不实现**（没有 foot-lock 层）→ `main.ts` 用可选调用 `?? 0`。
   *
   * @param snapshot 调用方本帧已取的动画调试快照（main.ts 已为 `visualOffsetYPx` 取过）：
   *   传入时实现内复用、避免每帧重复构建 debug 快照；不传/为 null 时实现自行取（兜底）。
   */
  getHipShiftScreenXPx?(snapshot?: AnimationDebugSnapshot | null): number
  /** 调试/冒烟：强制切姿态；未知返回 false。 */
  debugSetPose(poseId: string, fadeMs?: number): boolean
  /** 调试/冒烟：强制注视角度（度）。 */
  debugSetGaze(yawDeg: number, pitchDeg: number): void

  /** 摆放模型（rect = 窗口本地 CSS px；feetY = 脚底本地 y）。 */
  placePet(rect: Rect, feetY: number): void
  /** 每帧调用：按 fpsCap 跳帧，真正渲染返回 true。 */
  step(nowMs: number): boolean
  /** 单帧渲染统计。 */
  getRenderStats(nowMs?: number): PetRenderStats
  /** 设置 morph 权重（PMX：morph 名；VRM：expression 名）；未知返回 false。 */
  setMorph(name: string, weight: number): boolean
  /**
   * VRM 场景运行时诊断（可选：仅 `VrmPetScene` 实现；PMX 场景返回 undefined）。
   * `main.ts` 把它透传到 `window.__aventurineDebug.vrm`（冒烟/验收断言）。
   */
  getVrmDiagnostics?(): VrmRuntimeDiagnostics
  /**
   * 视觉竖直偏移（CSS px；正 = 视觉向上，与 `AnimationDebugSnapshot.visualOffsetYPx` 同口径）。
   * 仅用于「sit 时 hips 贴窗沿」等视觉修正：物理/hit 仍以 petRect 为准，main.ts 会同步命中矩形。
   */
  setVisualOffsetYPx?(offsetPx: number): void
  /**
   * 释放场景持有的 WebGL/three 资源（R-01/R-02；页面卸载时调用，可重复调用）。
   *
   * 可选：legacy `PetScene` 提供 best-effort 实现；`main.ts` 用 `scene?.dispose?.()` 调用，
   * 不强制所有 `PetView` 实现（含单测假实现）都补齐。
   */
  dispose?(): void
}

/** 生成 `PetView` 所需的 `PoseDriver` 工厂签名（与 `PetSceneOptions.createPoseDriver` 对齐）。 */
export type PetViewPoseDriver = PoseDriver
