/**
 * 渲染进程调试面类型 —— `window.__aventurineDebug`（A2 交付；**生产构建同样存在**）。
 *
 * 消费方：Lead 的实机采集器 `tests/tmp/capture.cjs`、smoke/验收脚本、人工排障。
 * 字段契约见 PLAN §18.3 与 A2 任务书：`{ ready, model, stats(), setMorph(), petWorld? }`；
 * Wave 1 修复批新增 `geometryRefreshCount`（H-1）与 `pointerIntercepting`（M-3）供冒烟断言。
 */
import type { PetMood, Rect } from '@shared/types'

import type { VrmRuntimeDiagnostics } from './scene/pet-view'
import type { HandPropSnapshot } from './vrm/prop-layer'
import type {
  AnimationDebugSnapshot,
  BehaviorDebugSnapshot,
  DesktopSnapshot,
  ExternalReaction,
  InteractionSnapshot,
  MotionSnapshot
} from './core/wave2-contract'

/** 模型静态信息（加载后填充；`textureCount/missingTextures` 随贴图加载进度实时变化）。 */
export interface AventurineDebugModel {
  /** PMX 是否加载完成。 */
  loaded: boolean
  /** 全部 morph 名（85 个，PMX 原始名称、不 trim，便于核对）。 */
  morphNames: string[]
  /** 全部材质名（39 个）。 */
  materialNames: string[]
  /** 成功加载的贴图数（验收期望 20）。 */
  textureCount: number
  /** 缺失/加载失败的贴图文件名列表（验收期望空数组）。 */
  missingTextures: string[]
  /** 顶点数（32966） */
  vertexCount?: number
  /** 三角面数（51829） */
  triangleCount?: number
}

/** 实时统计（每次调用现算）。 */
export interface AventurineDebugStats {
  /** 最近 1s 实测渲染帧率（fpsCap 生效后 ≈ 30）。 */
  fps: number
  /**
   * 最近一帧 draw call 数（F03：OutlineEffect 主 pass + 描边 pass **累计**；
   * 旧实现只统计描边 pass，C4 性能读数会低估约 2.4×）。
   */
  drawCalls: number
  /** 最近一帧三角面数（F03：同上，两个 pass 累计）。 */
  triangles: number
  /** 宠物目标高度（CSS 像素，= sizePercent% × display.bounds.height，受 workArea 封顶）。 */
  petHeightPx: number
  /**
   * 当前基础描边宽度（CSS 像素，0 = 未摆放）。
   * 屏幕空间恒定（横竖同宽）+ 随宠物高度轻度自适应（PLAN §19.11 方案 B）。
   */
  outlinePx: number
  /** 宠物在窗口本地坐标（CSS 像素、y 向下）中的矩形。 */
  petRect: Rect
  /** overlay 窗口所在显示器 id；屏幕信息未就绪时 null。 */
  displayId: number | null
  /** 是否主屏（Wave 1 只主屏渲染宠物）。 */
  isPrimaryDisplay: boolean
}

/** 调试面根对象。 */
export interface AventurineDebug {
  /** 模型已加载 + 贴图加载结束（或超时）+ 首次摆放完成。 */
  ready: boolean
  /** 模型信息（加载后填充）。 */
  model: AventurineDebugModel
  /** 实时统计。 */
  stats(): AventurineDebugStats
  /** 设置 morph 权重（按 PMX 名称 trim 匹配）；未知名返回 false。 */
  setMorph(name: string, weight: number): boolean
  /**
   * 已成功完成的窗口+显示器几何刷新次数（H-1）。
   * 每次 `pet:window-info` + `pet:screen-info` 都成功拉取并重算布局后 +1；
   * 启动后至少为 1，screens-updated / window resize 触发的成功刷新会继续递增。
   */
  readonly geometryRefreshCount: number
  /**
   * 当前是否处于「拦截鼠标」状态（M-3）：true = renderer 已请求 `setIgnoreMouse(false)`，
   * 窗口正在接管输入（鼠标悬停宠物矩形，或配置 clickThrough=false）。
   */
  readonly pointerIntercepting: boolean
  /** 宠物在世界坐标（视口左下原点、y 向上）中的矩形；未摆放时不存在。 */
  petWorld?: Rect
  /**
   * L2（M-3）验收面：当前视觉命中矩形（窗口本地 CSS px、y 向下）。
   * = 物理 `petRect` + `visualOffsetYPx` 竖向补偿 + foot-lock hips 横移横向补偿；
   * `null` = 与 `petRect` 相同（无视觉位移）。交互/气泡消费同一矩形，`petWorld` 保持物理口径。
   */
  pointerRect?: Rect | null
  /** 最近错误（调试用；生产构建同样保留，最多 20 条）。 */
  errors: string[]
  /**
   * V1：VRM 场景运行时诊断（仅 `modelBackend=vrm` 且模型加载后存在；PMX 路径 undefined）。
   * 冒烟/验收断言 humanoid 骨、expression、spring、clip 状态用。
   */
  vrm?: VrmRuntimeDiagnostics
  /**
   * V1：VRM 动画子层是否已接线（冒烟据此决定是否断言眨眼/look-at：
   * V1 只有 clip → `{clips:true, expressions:false, lookAt:false}`；V6 接线后为 true）。
   */
  vrmDrivers?: { clips: boolean; expressions: boolean; lookAt: boolean }
  /**
   * V1 手持道具（水枪）运行时快照（未接线/未加载时 undefined；VRM 后端才有）。
   * 冒烟/采集断言 `attached=true`、普通动作 `visible=false`、技能动作 `visible=true` 用。
   */
  handProp?: HandPropSnapshot
  /**
   * 调试：强制显示/隐藏手持道具（null = 恢复按 clip 规则；截图/冒烟用）。
   */
  debugSetHandPropVisible?: (visible: boolean | null) => void

  /* ---------------- Wave 2（B1–B5；运行时接入后存在，未接入时 undefined） ---------------- */

  /** B3 动画/姿态/表情调试快照（`getAnimationSnapshot()` 透传；冒烟断言用）。 */
  animation?: AnimationDebugSnapshot
  /** B1 行为状态机调试快照（冒烟断言用）。 */
  behavior?: BehaviorDebugSnapshot
  /** B2 运动/物理当前快照（冒烟断言用）。 */
  motion?: MotionSnapshot
  /** B5 桌面感知当前快照（冒烟断言用；surfaces 长度 / window-top 数量）。 */
  desktop?: Pick<DesktopSnapshot, 'surfaces' | 'workArea' | 'screenBounds'>
  /** B4 交互当前快照（冒烟断言用；hover/drag/patProgress）。 */
  interaction?: InteractionSnapshot
  /** B7 DSH 当前外部反应（未过期时非 null；冒烟断言用）。 */
  reaction?: ExternalReaction | null
  /**
   * Wave 2 调试钩子（仅调试面；冒烟/采集器用）：
   * 强制切到某个姿态 id（B3 姿态库），返回是否成功。undefined = 动画未接入。
   */
  debugSetPose?: (poseId: string) => boolean
  /** 强制注视角度（度；B3 实现，冒烟断言 look-at 用）。 */
  debugSetGaze?: (yawDeg: number, pitchDeg: number) => void
  /** 强制触发一次行为活动（B1 activity id），返回是否成功。 */
  debugTriggerActivity?: (activityId: string) => boolean
  /** 调试/截图：把宠物瞬移到指定脚底点（窗口本地 px），返回是否成功。 */
  debugTeleport?: (feet: { x: number; y: number }) => boolean
  /**
   * 调试/截图：临时覆盖动画层 mood（只改 `AnimationInput.mood`，不影响 B1 行为/物理），
   * 用于在实机里检查某个 mood 的外部 VMD（如 pat/drag）；`null` = 清除覆盖。
   * 默认 null，正常运行时零影响。
   */
  debugSetAnimationMood?: (mood: PetMood | null) => void
}
