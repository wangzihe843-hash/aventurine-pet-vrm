/**
 * 冻结共享契约 —— 基础类型（M0-2）
 *
 * 规则（后续 Wave 所有任务必须遵守）：
 * - 本文件（以及 src/shared/**）是**环境中立纯 TS**：不得 import `electron`、不得 import
 *   `node:*` 等 Node 内置模块，也不得引入任何运行时第三方依赖。
 *   因为 src/shared 同时被 `tsconfig.node.json`（main/preload）和 `tsconfig.web.json`
 *   （renderer）typecheck，且会被打包进三端产物。
 * - 冻结后不得随任务改动；需要变更契约先联系 Lead，由 M0 负责人统一修改。
 */

/** 屏幕/窗口通用矩形，单位为「逻辑像素」，原点为屏幕左上角（macOS 全局坐标）。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 显示器信息（对应 Electron `Display` 的可序列化子集）。 */
export interface DisplayInfo {
  id: number
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  isPrimary: boolean
}

/**
 * 其它应用窗口信息（A4 Swift `CGWindowListCopyWindowInfo` 助手 / B5 桌面感知消费）。
 * bounds 为屏幕全局逻辑坐标（左上原点）。
 */
export interface WindowInfo {
  id: number
  pid: number
  owner: string
  layer: number
  alpha: number
  bounds: Rect
  onScreen: boolean
}

/**
 * 宠物姿态/情绪状态全集（B1 状态机使用；§8 冻结）。
 *
 * W0-3 起改为「常量数组 → 派生类型」：运行时（动画 clip manifest 校验）与编译期共用
 * 同一份来源，避免两份列表漂移。新增 mood 属于契约变更，需走 Lead 评审。
 */
export const PET_MOODS = [
  'idle',
  'walk',
  'climb',
  'sit',
  'sleep',
  'drag',
  'fall',
  'pat',
  'grabWindow',
  'dshBusy',
  'dshDone',
  'dshError'
] as const

/** 宠物姿态/情绪状态（B1 状态机使用；§8 冻结）。 */
export type PetMood = (typeof PET_MOODS)[number]

/**
 * 模型渲染后端（环境变量 `PET_MODEL_BACKEND` 可覆盖配置；W0-3 冻结）。
 * - `vrm`：three-vrm 渲染路径（Phase 3 目标）
 * - `legacy-pmx`：v1 的 PMX/MMDLoader 路径（回退）
 */
export const MODEL_BACKENDS = ['vrm', 'legacy-pmx'] as const
export type ModelBackend = (typeof MODEL_BACKENDS)[number]

/**
 * 动画后端（环境变量 `PET_ANIM_BACKEND` 可覆盖配置；W0-3 冻结）。
 * - `vrm`：humanoid clip（glTF/VRMA）+ VRM expression/spring 层
 * - `legacy-pmx`：v1 的 VMD/程序化动画路径（回退）
 */
export const ANIMATION_BACKENDS = ['vrm', 'legacy-pmx'] as const
export type AnimationBackend = (typeof ANIMATION_BACKENDS)[number]

/** 宠物停靠方式：角落（corner）或自由位置（free）。 */
export type PetPosition = 'corner' | 'free'

/** 自主活动频率档位。 */
export type AutonomousLevel = 'low' | 'normal' | 'high'

/** 用户配置（A3 持久化 / B6 设置面板 / sanitizeConfig 钳制；§8 冻结）。 */
export interface PetConfig {
  /**
   * 屏高百分比，10–100，默认 50（2026-11-07 用户确认由 30 改为 50「近景模式」，
   * 随后把可选上限从 50 放开到 100；30% 仍可作为标准大小通过设置切换）。
   * 基准 = `display.bounds.height`（50% @1080p = 540px，30% ≈ 324px）；放置/命中/渲染
   * 坐标基准 = `display.workArea`（overlay frame 即 workArea，见 PLAN §17.3-2）。
   * 注意：100% 时 1080p 的 bounds 高 1080 > workArea 高 961，实际高度会被
   * `workArea.height` 限制（宠物不出窗，见 `renderer/src/model/layout.ts`）。
   */
  sizePercent: number
  /** 整体不透明度，0.3–1，默认 1 */
  opacity: number
  /** 默认整体点击穿透；Wave1 A1 之后悬停宠物区域可拦截 */
  clickThrough: boolean
  /** 自主活动总开关 */
  autonomous: boolean
  /** 自主活动频率档位 */
  autonomousLevel: AutonomousLevel
  /** 捣乱行为总开关 */
  mischief: boolean
  /** DSH 联动开关 */
  dshLink: boolean
  /**
   * 与 DeepSeek Harness 双向保活/强耦合（Wave 3 新增；默认 `true`）。
   *
   * 语义：任一方启动时若另一方不在则拉起；任一方显式退出时另一方跟随退出；
   * 意外崩溃先按冷却重启，失败后跟随退出。**dev（未打包）构建下还须显式设置
   * `PET_DSH_COUPLING=1` 才生效**，防止开发调试误杀正在使用的 DSH；打包版按本配置生效。
   * 可选键（省略按默认 `true`），旧 config.json 无需迁移。
   */
  dshCoupling?: boolean
  /**
   * 头顶气泡实时同步 DSH 回复（Wave 3 新增；默认 `true`）。
   *
   * `true` 时：思考中显示 `思考中...`，每个 assistant/message 段落到气泡、停留后消失、
   * 下一段再弹；`false` 时恢复 Wave 2 行为（只保留动作反应台词）。可选键，省略按默认 `true`。
   */
  dshBubbleSync?: boolean
  /** 渲染帧率上限，5–60，默认 30 */
  fpsCap: number
  /** 开机自启（登录项） */
  launchAtLogin: boolean
  /** 初始停靠方式 */
  position: PetPosition
  /** 是否播放音效 */
  sound: boolean
  /**
   * 模型渲染后端（W0-3 新增；默认 `vrm`）。环境变量 `PET_MODEL_BACKEND` 优先级高于本项，
   * 解析规则见 `src/shared/vrm.ts` 的 `resolveModelBackend`。
   */
  modelBackend: ModelBackend
  /**
   * 动画后端（W0-3 新增；默认 `vrm`）。环境变量 `PET_ANIM_BACKEND` 优先级高于本项，
   * 解析规则见 `src/shared/animation-contract.ts` 的 `resolveAnimationBackend`。
   */
  animBackend: AnimationBackend
  /**
   * 动作集 id（W0-3 新增；默认 `default`）。对应 `assets/motions/<motionSet>/` 下的
   * clip manifest；缺失时回退 legacy/程序化。清洗规则见 `sanitizeConfig`。
   */
  motionSet: string
}

/** DSH 桥事件类型（A5 写、B7 读；文件契约见 bridge-schema.ts）。 */
export type DshEventType =
  | 'agent/status'
  | 'task/start'
  | 'task/end'
  | 'task/error'
  | 'session/event'

/** 一条 DSH 桥事件（events.jsonl 的一行）。 */
export interface DshEvent {
  /** 事件时间戳（毫秒，`Date.now()`） */
  ts: number
  type: DshEventType
  payload: Record<string, unknown>
}

/** DSH 聚合状态（由 status.json + 新鲜度计算得到，供渲染层消费）。 */
export interface DshStatus {
  /** 最近 30s 内有心跳 */
  online: boolean
  running: boolean
  lastEventAt: number
  lastType: DshEventType | null
}

/** 系统权限状态（辅助功能 / 通知授权）。 */
export interface AccessibilityStatus {
  accessibility: boolean
  notifications: 'granted' | 'denied' | 'unsupported' | 'unknown'
}

/** overlay 窗口自身信息（对应 `pet:window-info` channel）。 */
export interface OverlayWindowInfo {
  id: number
  bounds: Rect
  displayId: number
}

/**
 * 契约清洗结果（W0-3 起用于 VRM/motions manifest 的容错解析）。
 * `warnings` 是给人看的英文/中文混合诊断文本；调用方（loader/日志）可选消费。
 */
export interface SanitizeResult<T> {
  value: T
  warnings: string[]
}

/* -------------------------------------------------------------------------- */
/* 资源清单（M0-3 的 scripts/prepare-assets.mjs 生成                             */
/* src/shared/assets-manifest.json；字段冻结，禁止擅改）                          */
/* -------------------------------------------------------------------------- */

/** 单张贴图的处理记录。 */
export interface TextureManifestEntry {
  /** PMX texture 表索引 */
  index: number
  /** PMX 内的原始引用字符串（已把反斜杠规范成 /） */
  name: string
  /** 相对 assets/model 的源文件名（POSIX） */
  source: string
  /** 相对 assets/model/optimized 的输出文件名 */
  optimized: string
  resized: boolean
  sourceWidth: number
  sourceHeight: number
  /** 输出尺寸 */
  width: number
  height: number
  sourceBytes: number
  bytes: number
  sourceSha256: string
  sha256: string
}

/** 资源管线产物清单。 */
export interface AssetsManifest {
  schemaVersion: 1
  generatedAt: string
  sourceDir: string
  outputDir: string
  maxEdge: number
  pmx: {
    file: string
    bytes: number
    sha256: string
    version: number
    modelName: string
    counts: {
      vertices: number
      faces: number
      materials: number
      bones: number
      morphs: number
      rigidBodies: number
      constraints: number
      textures: number
    }
    textureReferences: string[]
    missingTextures: string[]
  }
  textures: TextureManifestEntry[]
  unreferencedFiles: string[]
}
