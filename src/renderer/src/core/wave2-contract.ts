/**
 * Wave 2 模块间集成契约 —— **Lead-owned，冻结**（2026-11-08 开工前置）
 *
 * 背景：Wave 2（B1–B7）在同一个工作树里并行开发，各模块只写自己的 scope
 * （`behavior/**` / `physics/**` / `animation/**` / `interaction/**` / `desktop/**`），
 * 由 Lead 在 `src/renderer/src/main.ts` + `src/main/index.ts` 完成接线。
 * 本文件只放**模块边界上真正共享的数据形状**；各模块内部的私有类型/类 API 由各自定义，
 * Lead 在自己的集成层（`main.ts`/`core/pet-runtime.ts`）做适配。
 *
 * 约定：
 * - 坐标一律为 **window 本地 CSS 像素**（overlay 窗口左上角为原点、x→右、y→下；
 *   与 `model/layout.ts` 的 `petRect`/`feetY` 完全同口径；DPR 不进入本契约）；
 * - 「脚底位置」= 宠物脚底锚点 `feet`（窗口本地 px）；宠物矩形由
 *   `height = petHeightPx`、`width = height × 模型宽高比`、`feet.x` 居中、`feet.y` 为底边推出；
 * - 本文件是**纯类型模块**（无运行时导出、无 Electron/DOM 依赖），可被单测直接 import；
 * - **除 Lead 外任何人不得修改本文件**。若实现中发现契约缺口，向 Lead 报「契约变更请求」，
 *   先按现有契约开发（可在自己模块内加可选字段/适配层）。
 */
import type { PetMood, Rect } from '@shared/types'

/** 窗口本地 CSS 像素点（原点 = overlay 窗口左上角，y 向下）。 */
export interface Point2D {
  x: number
  y: number
}

/** 宠物在屏幕上的尺寸（CSS px；高度由 sizePercent 决定，宽度按模型宽高比）。 */
export interface PetSize {
  width: number
  height: number
}

/** 宠物朝向（B1 决策 → B2/B3 消费；front = 面向镜头）。 */
export type Facing = 'left' | 'right' | 'front'

/* ========================================================================== */
/* B2 运动与物理（src/renderer/src/physics/**）                                 */
/* ========================================================================== */

/**
 * B2 每帧输出的运动状态快照（B1 决策、B3 动画、main.ts 布局都消费）。
 * 所有字段必须在 `step()` 后保持最新；`feet` 是唯一的位置权威来源。
 */
export interface MotionSnapshot {
  /** 脚底锚点（窗口本地 px） */
  feet: Point2D
  /** 当前速度（px/s；y 向下为正） */
  velocity: Point2D
  /** 朝向 */
  facing: Facing
  /** 是否站在某个表面上（地面/窗口上沿/菜单栏/Dock） */
  grounded: boolean
  /** 站立表面 id（null = 空中；与 DesktopSurface.id 对应） */
  surfaceId: string | null
  /** 是否处于空中（被甩出/跳下/窗口关闭掉落；供 B3 切 fall/jump 姿态） */
  airborne: boolean
}

/**
 * B1 下发给 B2 的运动意图（main.ts 每帧把 BehaviorDecision.motion 转给 B2）。
 * B2 可以丢弃/截断与当前物理状态冲突的指令（例如空中收到 moveTo → 忽略）。
 */
export type MotionCommand =
  | { kind: 'hold' }
  | {
      kind: 'moveTo'
      target: Point2D
      /** 移动速度（px/s；B1 按 autonomousLevel/姿态给，例如走 60–120、爬 25–50） */
      speedPxPerSec: number
      /** walk = 地面走；climb = 沿窗口/屏幕边缘爬 */
      mode: 'walk' | 'climb'
    }
  /** 走向某个可坐表面并坐下（B2 负责移动到 surface 上沿，落座由 B1/B3 姿态表现） */
  | { kind: 'sit'; surfaceId: string }
  /** 主动向下掉落（例如从窗口上沿跳下） */
  | { kind: 'drop' }
  /** 瞬移（显示器/窗口拓扑重建后的复位；不产生甩出动画） */
  | { kind: 'teleport'; feet: Point2D }

/* ========================================================================== */
/* B5 桌面感知（src/renderer/src/desktop/**）                                   */
/* ========================================================================== */

/** 桌面表面类型。 */
export type SurfaceKind =
  /** 屏幕工作区底边（地面） */
  | 'screen-bottom'
  /** 其他应用窗口的上沿（可站/可坐） */
  | 'window-top'
  /** 其他应用窗口的左右边缘（可爬） */
  | 'window-side'
  /** 菜单栏底边（workArea 顶边） */
  | 'menubar'
  /** Dock 顶边（workArea 底边的 Dock 区域；若 Dock 在侧边则为相应边缘） */
  | 'dock'

/** B5 产出的「可站立/可坐/可爬」表面（窗口本地坐标）。 */
export interface DesktopSurface {
  /** 稳定 id（B1/B2 引用；窗口表面建议 `win-<windowId>-top|left|right`） */
  id: string
  kind: SurfaceKind
  /** 表面矩形（窗口本地 px；window-top 时 rect.y = 上沿 y、rect.height ≈ 0~1） */
  rect: Rect
  /** 可站立顶边 y（窗口本地 px；B2 落点判定用） */
  top: number
  /** 关联窗口 id（window-* 时必填） */
  windowId?: number
  /** 是否允许「坐」（B1 加权选择/菜单栏 Dock 坐姿） */
  sittable: boolean
  /** 是否允许沿边缘爬（window-side / 屏幕边缘） */
  climbable: boolean
}

/** 窗口列表变化中 B1 需要感知的一次性事件（窗口移动/关闭 → 跟随/掉落）。 */
export type WindowTransition =
  | { kind: 'moved'; windowId: number; delta: Point2D }
  | { kind: 'closed'; windowId: number }
  | { kind: 'appeared'; windowId: number }

/** B5 每帧输出的桌面快照（B1/main.ts 消费）。 */
export interface DesktopSnapshot {
  /** 当前可用表面列表（已按「前到后」排序；最前 = 视觉上最优） */
  surfaces: DesktopSurface[]
  /** 自上一帧以来的窗口变化事件（main.ts 每帧消费后由 B5 清空/由 Lead 取走） */
  transitions: WindowTransition[]
  /** overlay 所在显示的 workArea（窗口本地坐标；通常等于视口，但保留显式来源） */
  workArea: Rect
  /** overlay 所在显示的 bounds（窗口本地坐标；用于判断菜单栏/Dock 侧） */
  screenBounds: Rect
}

/* ========================================================================== */
/* B4 交互（src/renderer/src/interaction/**）                                   */
/* ========================================================================== */

/** 宠物可被戳/摸的身体区域（由 B4 命中检测产出；B1/B3 消费）。 */
export type PokeRegion = 'head' | 'body' | 'leg'

/** B4 每帧输出的交互状态（B1/main.ts 消费）。 */
export interface InteractionSnapshot {
  /** 鼠标在窗口本地坐标中的位置（null = 鼠标不在窗口内） */
  pointer: Point2D | null
  /** 鼠标当前是否悬停在宠物命中区内 */
  hoveringPet: boolean
  /** 是否处于按住拖动中 */
  dragging: boolean
  /** 摸头圆形轨迹进度（0–1；0 = 未在进行） */
  patProgress: number
  /**
   * B4 `LookTracker` 平滑后的注视目标（窗口本地 px；null = 指针离开/2.5s 无移动回落）。
   *
   * M-11：缺省（undefined）= 沿用 `pointer`（兼容旧输入/单测）；
   * 显式 null = 「不跟随」。B1 只把它用于 `lookTarget`（注视），
   * `pointerNear`/`mouseAway`/朝向仍以原始 `pointer` 为准（避免平滑导致避让/休眠迟钝）。
   */
  lookTarget?: Point2D | null
}

/** B4 产出的一次性交互事件（main.ts 每帧收集后传给 B1/B3，消费后清空）。 */
export type InteractionEvent =
  | { kind: 'dragStart'; pointer: Point2D }
  /** 拖动过程中的位置更新（main.ts 转发给 B2 的 dragTo） */
  | { kind: 'dragMove'; pointer: Point2D }
  | { kind: 'dragEnd'; pointer: Point2D; throwVelocity: Point2D }
  /** 摸头成功（圆形轨迹达到阈值） */
  | { kind: 'pat' }
  | { kind: 'poke'; region: PokeRegion }
  | { kind: 'hoverEnter' }
  | { kind: 'hoverLeave' }
  /** 右键菜单动作（B4 渲染 DOM 菜单；某些动作由 main.ts 执行） */
  | { kind: 'menuAction'; action: 'settings' | 'hide' | 'toggleAutonomous' | 'quit' }

/* ========================================================================== */
/* B7 DSH 反应（src/renderer/src/reactions/dsh.ts）                             */
/* ========================================================================== */

/** 外部反应（DSH 任务开始/完成/错误）——优先级高于自主行为，带过期时间。 */
export interface ExternalReaction {
  /** 只允许 DSH 三种 mood（B1 据此决定表演） */
  mood: Extract<PetMood, 'dshBusy' | 'dshDone' | 'dshError'>
  /** 一次性台词气泡（null = 不显示） */
  bubble: string | null
  /** 持续时长（ms；从 startedAtMs 起算，过期后 B1 回到自主行为） */
  durationMs: number
  /** 反应开始时间（`performance.now()` 口径；main.ts 用同口径时钟注入） */
  startedAtMs: number
}

/* ========================================================================== */
/* B1 行为（src/renderer/src/behavior/**）                                      */
/* ========================================================================== */

/** 影响 B1 自主行为的配置子集（main.ts 从 sanitize 后的 `PetConfig` 里取）。 */
export interface BehaviorConfigSubset {
  autonomous: boolean
  autonomousLevel: 'low' | 'normal' | 'high'
  mischief: boolean
  dshLink: boolean
}

/** B1 每帧输入（main.ts 组装）。 */
export interface BehaviorInput {
  /** 单调时钟毫秒（`performance.now()`；注入便于 seed 复现单测） */
  nowMs: number
  /** 距上一帧秒数（已由 main.ts 钳制 ≤0.1） */
  dt: number
  /** B2 当前运动状态 */
  motion: MotionSnapshot
  /**
   * 可达水平区间（B2 半宽钳制后的运动目标范围）；由 PetRuntime 依 workArea+petSize 计算；
   * 缺省 = 用 workArea 全宽（B1 生成 walkTo/returnCorner 目标时应把 x 钳制进该区间）。
   * Wave 2.5 新增（H-3b：窗沿/角落目标落在 B2 不可达带导致「原地走/永不到达」）。
   */
  motionLimits?: { minX: number; maxX: number }
  /** B5 当前桌面快照 */
  desktop: DesktopSnapshot
  /** B4 当前交互状态 */
  interaction: InteractionSnapshot
  /** 本帧收集到的交互事件（B1 消费后由 main.ts 清空；同一事件也会给 B3 用于即时表演） */
  events: InteractionEvent[]
  /** B7 外部反应（未过期时非 null；B1 应优先表演，但不可打断拖拽） */
  external: ExternalReaction | null
  /** 影响自主行为的配置子集 */
  config: BehaviorConfigSubset
  /**
   * 可注入随机源（[0,1)）。**B1 所有随机决策必须只经此函数**，
   * 单测注入 seeded RNG → 序列可复现（B1 验收要求）。
   */
  random: () => number
}

/** B1 每帧决策输出（main.ts 消费：B2 运动 / B3 动画 / main.ts 摆放与气泡）。 */
export interface BehaviorDecision {
  /** 当前语义状态（冻结 `PetMood`；B3 据此选姿态/表情，B7/调试面消费） */
  mood: PetMood
  /** 下发给 B2 的运动意图 */
  motion: MotionCommand
  /** 朝向 */
  facing: Facing
  /** 注视目标（窗口本地 px；null = 不跟随，例如睡觉/生气时不看鼠标） */
  lookTarget: Point2D | null
  /** 一次性台词气泡文本（null = 本帧不发；main.ts 负责去重/显示时长） */
  bubble: string | null
  /** 姿态/表演提示（可选的语义提示，如 `'idle:coin'`、`'pat:shy'`；B3 可忽略或映射） */
  poseHint?: string
}

/* ========================================================================== */
/* B3 动画（src/renderer/src/animation/**）                                     */
/* ========================================================================== */

/** B3 消费的一次性表演事件（由 main.ts 从 InteractionEvent/DSH 反应转换）。 */
export type AnimationEvent =
  | { kind: 'pat' }
  | { kind: 'poke'; region: PokeRegion }
  /** 被甩出（speed = 甩出速度 px/s） */
  | { kind: 'thrown'; speed: number }
  /** 落地（impactSpeed = 落地竖直速度 px/s） */
  | { kind: 'landed'; impactSpeed: number }
  /** 开始/结束拖拽 */
  | { kind: 'dragStart' }
  | { kind: 'dragEnd' }

/** B3 每帧输入（main.ts 在 scene.step 前注入；placement 为当前摆放矩形）。 */
export interface AnimationInput {
  /** 渲染帧 dt（秒；main.ts 已按渲染帧钳制 ≤0.1） */
  dt: number
  /** B1 当前 mood */
  mood: PetMood
  /** B2 运动状态（速度/接地/空中/朝向） */
  motion: MotionSnapshot
  /** 朝向（与 motion.facing 同源，冗余便于 B3 单独使用） */
  facing: Facing
  /** 注视目标（窗口本地 px；null = 不跟随鼠标） */
  lookTarget: Point2D | null
  /** 当前宠物摆放矩形（窗口本地 px、y 向下） */
  petRect: Rect
  /** 视口高度（窗口本地 CSS px；世界坐标 y 向上换算用） */
  viewportHeight: number
  /** 是否按住拖动中（拖拽姿态 + 手部/视线处理） */
  dragging: boolean
  /** 本帧一次性表演事件（消费后由 main.ts 清空） */
  events: AnimationEvent[]
  /** 当前需要做口型的台词（气泡显示期间非 null；B3 用它驱动 あいうえお 口型） */
  bubbleText: string | null
}

/**
 * B3 提供给 Lead 接线的姿态驱动接口（`PetScene` 内部持有；main.ts 通过工厂创建）。
 *
 * 设计原因：`PetScene` 持有 `SkinnedMesh`/`modelRoot` 私有引用，B3 不能直接拿；
 * 由 main.ts 在构造 PetScene 时注入 `createPoseDriver(context)` 工厂，PetScene 在 PMX
 * 加载完成后调用工厂创建 driver，并在每帧 `step()` 内调用 `driver.update(fullInput)`。
 * 这样 `pet-scene.ts` 不 import B3 模块（Lead 集成层保持解耦），B3 也无需知道摆放细节。
 */
export interface PoseDriver {
  /** 每帧更新（PetScene.step 内、渲染前；dt/petRect/viewportHeight 由 PetScene 填好） */
  update(input: AnimationInput): void
  /** 调试面快照（`window.__aventurineDebug.animation`） */
  getDebugSnapshot(): AnimationDebugSnapshot
  /** 调试/冒烟：强制切换姿态（false = 未知姿态 id） */
  setPose(poseId: string, fadeMs?: number): boolean
  /** 调试/冒烟：强制注视角度（度） */
  setGaze(yawDeg: number, pitchDeg: number): void
}

/** main.ts 每帧注入的动画输入（dt/petRect/viewportHeight 由 PetScene 补齐）。 */
export type AnimationDriverInput = Omit<AnimationInput, 'dt' | 'petRect' | 'viewportHeight'>

/** B3 对外暴露的调试快照（调试面 `window.__aventurineDebug.animation`，冒烟断言用）。 */
export interface AnimationDebugSnapshot {
  /** 当前主要姿态 id（B3 命名，如 `stand` / `sit` / `sitEdge` / `sleep` / `pat` / `drag` / `fall`） */
  pose: string
  /** 当前姿态的混合权重（0–1） */
  poseWeight: number
  /** 姿态混合层数（基础层 + 覆盖层，>1 表示正在过渡/叠加） */
  activeLayers: number
  /** 正在播放的一次性表演（null = 无） */
  gesture: string | null
  /** 当前眨眼权重（0–1，调试/冒烟用） */
  blink: number
  /** 当前微笑类表情权重（0–1，调试/冒烟用） */
  smile: number
  /** 当前口型开合度（0–1） */
  mouthOpen: number
  /** 当前头部看向方向（-1..1，左负右正；null = 无注视），用于冒烟断言 look-at 生效 */
  lookYaw: number | null
  /** 姿态引用但模型骨骼里找不到的骨骼名（应为空数组；集成验收/排障用） */
  missingBones: string[]
  /** 当前非零表情 morph 权重（冒烟断言眨眼/害羞等链路通；只列非零项） */
  morphs?: Record<string, number>
  /** 当前注视角度（弧度；null = 无注视/已回落；冒烟断言 look-at 生效） */
  gaze?: { yaw: number; pitch: number } | null
  /** 脚底贴地误差（CSS px；站/走时应 <2px；坐/睡/腾空时为 null） */
  footErrorPx?: number | null
  /** 动画来源（默认 `procedural` = B3 程序化；`vmd` = 外部 VMD 动作；`vpd` = 外部静态姿势）。Wave 2.5 新增。 */
  source?: 'procedural' | 'vmd' | 'vpd'
  /** 当前外部动作 clip id（source = `vmd`／`vpd` 时；null = 无）。Wave 2.5 新增。 */
  clipId?: string | null
  /** 当前外部动作播放时间（秒；source = `vmd` 时）。Wave 2.5 新增。 */
  clipTimeSec?: number | null
  /** 外部动作驱动时的脚底贴地误差（CSS px；source = `vmd` 时，供冒烟断言）。Wave 2.5 新增。 */
  externalFootErrorPx?: number | null
  /**
   * 脚部固定（静态动作 foot planting）运行时快照（VRM 后端；未启用/PMX 后端为 null/undefined）。
   *
   * 2026-11-09 重做：待机变体 crossfade 时接触脚钉在锚点；验收断言 `leftPinned/rightPinned=true`、
   * `*FootErrorM` ≈ 0（米）、且 **walk/drag/sit/sleep 时 pinned=false**（不误锁走路/拖拽）。
   */
  footLock?: {
    enabled: boolean
    leftPinned: boolean
    rightPinned: boolean
    leftWeight: number
    rightWeight: number
    pelvisDropM: number | null
    leftFootErrorM: number | null
    rightFootErrorM: number | null
    leftFootLiftM: number | null
    rightFootLiftM: number | null
    /** A/g：当前施加的 hips 偏移（米；x/z 水平，语义与旧 A 一致；y = g 骨盆升降）。非累积，离开 idle 平滑归零。 */
    hipShiftXM?: number | null
    hipShiftYM?: number | null
    hipShiftZM?: number | null
    /** g：钳制后最大距离残差（米；>10mm 或 NaN → 本帧回退旧 A）。null = 无 pinned 脚。 */
    stanceSolveResidualM?: number | null
    /** 本帧生效的对齐模式（'3d' = 距离保持解；'mean' = 旧 A 回退/强制回退）。 */
    stanceAlignMode?: '3d' | 'mean'
    /** g：最近一帧 Gauss-Newton 迭代数（性能/调参用）。 */
    stanceSolveIterations?: number
    /** B：左右脚朝向相对（跟随后的）锚点的偏差（度）。可选（旧消费方不填）。 */
    leftFootOrientationErrDeg?: number | null
    rightFootOrientationErrDeg?: number | null
    /** IK 后运行时膝屈曲角（度；180=伸直；dev-capture JSON/验收断言用）。 */
    kneeFlexDegL?: number | null
    kneeFlexDegR?: number | null
    /** 本帧 IK 前作者膝屈曲角（度；与上面两字段同口径对比）。 */
    authorKneeFlexDegL?: number | null
    authorKneeFlexDegR?: number | null
    /** replant：已检测到 clip 变化、等待 crossfade 结束（接触状态冻结中）。 */
    replantPending?: boolean
    /** replant：当前是否有脚在换步（含等待错峰/迷你混合；settle 期 false）。 */
    replantActive?: boolean
    /** replant：左/右脚当前是否处于换步状态（含等待错峰）。 */
    leftReplantActive?: boolean
    rightReplantActive?: boolean
    /** replant：左/右脚本帧抬脚弧线高度（米；迷你混合/等待期 0；null = 未换步）。 */
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
  } | null
  /** 当前外部动作的 IK 模式（`on` = 足ＩＫ CCD 解算；`off` = 纯 FK 腿）。Wave 2.5 新增。 */
  externalIk?: 'on' | 'off' | null
  /**
   * 外部动作的视觉 Y 偏移（CSS px；**three 世界 Y 方向的视觉偏移**：
   * 正 = 视觉整体向上（世界 Y 正向）；负 = 视觉整体向下。消费者按屏幕 y 向下换算时取反
   * （屏幕 y 偏移 = −visualOffsetYPx）；0/null = 无偏移）。
   * 窗沿坐（`seatedAnchor='hips'`）时用于让 hit/气泡跟随「臀部贴沿、腿悬垂」的视觉位置。
   * Wave 2.5 新增。
   */
  visualOffsetYPx?: number | null
  /**
   * 当前外部动作的播放速率（`mixer.timeScale`；1 = 原速）。
   * walk 类按「当前移动速度 / 该宠物尺寸下的自然步速」求值，钳制 0.5–1.6。
   * Wave 2.5 新增（D3 步行速度匹配；供调试/冒烟断言）。
   */
  externalPlaybackRate?: number | null
  /** 弹簧链当前摆角（度；无弹簧/未启用时为空对象） */
  spring?: Record<string, number>
  /** 姿态动画帧率/耗时（可选，性能诊断） */
  updateMs?: number
}

/* ========================================================================== */
/* 调试面（`window.__aventurineDebug`，Lead/冒烟消费）                          */
/* ========================================================================== */

/** B1 对外暴露的调试快照（调试面 `window.__aventurineDebug.behavior`，冒烟断言用）。 */
export interface BehaviorDebugSnapshot {
  /** 当前语义状态 */
  mood: PetMood
  /** 当前活动 id（B1 命名，如 `idle` / `walkTo` / `sit` / `climb` / `sleep` / `pat` / `drag` / `fall`） */
  activity: string
  /** 当前活动是否自主发起（false = 交互/外部反应驱动） */
  autonomous: boolean
  /** 最近一次 mood 切换的单调时钟毫秒 */
  moodSinceMs: number
  /** 距离下一次自主活动尝试的剩余毫秒（无计划时为 null） */
  nextActivityInMs: number | null
  /** 当前冷却中的活动数量（调试用） */
  cooldownCount: number
}
