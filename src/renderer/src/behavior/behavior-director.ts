/**
 * B1 行为状态机 + 随机调度器（`BehaviorDirector`）。
 *
 * **纯 TS class**：不 import three / DOM / Electron / Node 内置；桌面信息全部来自
 * `BehaviorInput.desktop`（B5 产出），时钟全部来自 `input.nowMs`，随机全部来自
 * `input.random`（契约硬性要求，单测可注入 seeded RNG 复现）。
 *
 * 状态机优先级（高 → 低，见 `docs/wave2-integration.md` §3-B1）：
 * ```
 * drag（按住拖动） > pat/poke 即时反应 > fall（空中/掉落） > DSH 外部反应 > 自主活动 > idle 基线
 * ```
 * - 自主活动可被交互（摸头/戳/拖拽/悬停唤醒）与窗口事件（移动/关闭）打断；
 * - `config.autonomous=false` 时不做任何随机漫游，只 idle + 响应交互/外部反应；
 * - 活动有最短持续与冷却；同一时刻最多一个自主活动（variable-time 调度）；
 * - 输出 `motion`（给 B2）、`mood/facing/lookTarget/poseHint`（给 B3）、`bubble`（给 main.ts）。
 *
 * 模块边界：对外共享类型只来自 `../core/wave2-contract`（Lead 冻结）；本模块内部状态
 * 不外泄，调试面通过 `getDebugSnapshot()` 暴露 `BehaviorDebugSnapshot`。
 */
import type { AutonomousLevel, PetMood, Rect } from '@shared/types'

import type {
  BehaviorConfigSubset,
  BehaviorDecision,
  BehaviorDebugSnapshot,
  BehaviorInput,
  DesktopSnapshot,
  DesktopSurface,
  ExternalReaction,
  Facing,
  InteractionEvent,
  InteractionSnapshot,
  MotionCommand,
  MotionSnapshot,
  PokeRegion,
  Point2D,
  SurfaceKind
} from '../core/wave2-contract'

import {
  ACTIVITY_DEFINITIONS,
  countCoolingActivities,
  findActivityDefinition,
  LEVEL_PACE,
  pickWeightedActivity,
  SLEEP_MIN_IDLE_MS
} from './activities'
import { BubbleGate, type BubbleCategory } from './dialogue'
import { createSeededRandom, randomInt, randomRange, readRandom, sanitizeRandom } from './random'
import type {
  ActivityDefinition,
  ActivityId,
  ActivityPathStep,
  BehaviorDirectorOptions,
  LookMode,
  MotionLimits,
  PreparedActivity,
  SchedulerContext
} from './types'

/* ========================================================================== */
/* 常量                                                                        */
/* ========================================================================== */

/** 桌面快照缺失/非法时的兜底工作区（保证任何输入都能产出合法决策，不抛异常）。 */
const DEFAULT_WORK_AREA: Rect = { x: 0, y: 0, width: 1280, height: 720 }

/** 视为「到达」的距离阈值（px）。 */
const ARRIVE_EPSILON_PX = 16

/** 窄于该宽度的窗口上沿不做横向走动（避免原地踏步）。 */
const MIN_SURFACE_WALK_SPAN_PX = 56

/**
 * 两段式攀爬（用户实机反馈「横着往上走很诡异」，2026-11-08）：
 * - 第一段 walk：水平走到目标窗口侧边**下方**（脚底保持当前支撑面高度）；
 * - 第二段 climb：x 固定在窗口边缘，**竖直向上**爬到边缘点；
 * - 不使用「从角落斜线直达窗口顶部中点」的单段 moveTo。
 */
/** climb 最终目标相对 `surface.top` 的下偏移（px）：留一点余量，到位改发 hold 后由 B2
 *  `CLIMB_SETTLE_SNAP_EPS_PX=24` 吸附补落，避免把脚底精确顶到沿上而触发异常。 */
const CLIMB_EDGE_STOP_OFFSET_PX = 6
/** climb 边缘 x 距离 workArea 左右边界的最小留白（px；宠物半宽由 B2 兜底）。 */
const CLIMB_EDGE_MARGIN_PX = 8
/** climb 最小爬升高度（px）：目标窗沿低于当前脚底不足该值时不值得「爬」。 */
const CLIMB_MIN_RISE_PX = 24
/** climb 活动按路径动态续期：每帧把 endsAt 推到 `now + 该值`（距离远时不会半路结束）。 */
const CLIMB_ACTIVITY_EXTEND_MS = 2_500
/** climb 安全上限（ms；路径异常时兜底结束，防止活动永不结束）。 */
const CLIMB_ACTIVITY_MAX_MS = 45_000
/**
 * H-3b：移动类活动（walkTo/returnCorner/followWindow）按路径动态续期——目标可达但距离可能超过
 * maxDuration（如从屏幕左侧回右下角，1600 宽 @86px/s 需 ~14s > 活动 3–6s），到达前每帧把 endsAt
 * 推到 `now + 该值`，避免「走到一半活动结束」。安全上限兜底结束（路径/环境异常时）。
 */
const MOVEMENT_ACTIVITY_EXTEND_MS = 2_500
const MOVEMENT_ACTIVITY_MAX_MS = 45_000

/** 鼠标「靠近宠物」的判定距离（px；以脚底上方约 160px 作为胸/头部近似中心）。 */
const POINTER_NEAR_DISTANCE_PX = 420
/** 鼠标「离开/用户不在」的判定距离（px）。 */
const MOUSE_AWAY_DISTANCE_PX = 640

/** 甩出速度阈值（px/s）：dragEnd 速度超过它按「被甩出」处理（进入 fall）。 */
const THROW_SPEED_THRESHOLD_PX_PER_SEC = 520

/** 掉落后若物理迟迟不响应（B2 未接/异常），超过该时长兜底回到 idle。 */
const FALL_RESOLVE_TIMEOUT_MS = 2_500
/** 落地后的 `poseHint='land'` 持续时间。 */
const LAND_POSE_HINT_MS = 380

/** 摸头反应时长（ms）。 */
const PAT_DURATION_MS = { min: 1_700, max: 2_400 } as const
/** 被戳反应时长（ms）。 */
const POKE_DURATION_MS = { min: 900, max: 1_400 } as const
/** 连续摸头计数窗口与触发「翻脸（嘴硬）」的阈值。 */
const PAT_ESCALATION_WINDOW_MS = 10_000
const PAT_ESCALATION_COUNT = 3
/** 反应结束后到下一次自主尝试的间隔（让情绪落一落）。 */
const INTERACTION_RECOVER_MS = { min: 1_200, max: 3_200 } as const
/** 落地后的恢复间隔。 */
const LAND_RECOVER_MS = { min: 1_500, max: 4_000 } as const

/** 空闲站在可坐窗口上沿多久后自动坐下（ms）。 */
const WINDOW_TOP_AUTO_SIT_DELAY_MS = 700
/**
 * H-5：sleep 需求要求 `idleElapsed >= SLEEP_MIN_IDLE_MS(20s)`，但活动结束后下一次抽取固定在
 * `LEVEL_PACE.idleDelayMs`（normal 8–18s / high 4.2–10s）——永远小于 20s，默认档 sleep 永不可达。
 * 修法：安静活动不打断 idle 基线累计（见 finalizeDecision），且在鼠标离开时保证「下一次抽取」
 * 不晚于 idle 窗口（idleSince + SLEEP_MIN_IDLE_MS + 抖动），让 sleep 需求在抽取时已满足。
 * 抖动避免每次都在同一帧抽取（ms）。
 */
const SLEEP_WINDOW_JITTER_MS = { min: 0, max: 5_000 } as const
/** 自动坐下后的强制间隔（ms，N-1）：坐完至少隔这么久才允许再次自动坐下，避免「永久只坐」。
 *  **只保留给非窗沿场景**：可坐窗口上沿由 `maintainWindowTopRest` 当帧续下一段 recumbent（见下），
 *  不设站立 gap（用户 2026-11-10 设计约束「窗沿上只趴/坐/躺」）。 */
const AUTO_SIT_GAP_MS = { min: 20_000, max: 40_000 } as const
/**
 * 窗沿卧姿不变量（用户 2026-11-10 设计约束）：`motion.grounded && currentSurface.kind==='window-top'
 * && currentSurface.sittable===true`（OnLedge）时，B1 只产出 recumbent（坐/趴/躺）决策，零站立/走动帧；
 * 唯一自主离开方式是受控 `dropDown`。落地/放置/自主接近/被打断回 idle/autonomous=false/followWindow 后都覆盖。
 */
/** 连续完成 N 个 recumbent 段后，每段结束才允许以概率选择 dropDown 离开窗沿。 */
const WINDOW_TOP_REST_EXIT_MIN_SEGMENTS = 2
/** 每段 recumbent 结束后的受控离开概率（seeded random；`autonomous=false` 时永不跳）。 */
const WINDOW_TOP_REST_EXIT_PROBABILITY = 0.4
/** D6a 段 id 抖动兜底：`currentSurface` id 对不上时按 `top` + 横向覆盖脚底重匹配窗沿的容差（px）。 */
const WINDOW_TOP_REMATCH_TOP_EPS_PX = 2
/** 可坐窗口上沿允许的活动（其余站立/走动/看/睡/爬类一律禁止；调度层与 debug 触发共用口径）。 */
const WINDOW_TOP_REST_ALLOWED_ACTIVITIES: ReadonlySet<ActivityId> = new Set<ActivityId>([
  'sit',
  'dropDown'
])
/** 视为「高处」的判定余量（px，M-13）：表面 top 与 workArea 底边差小于该值视为与地面同高。 */
const ELEVATED_MIN_RISE_PX = 8
/** 悬停进入时的避让延时（「鼠标回来会避让」）。 */
const HOVER_AVOID_DELAY_MS = 2_500
/** 无可抽活动（例如暂时没有表面）时的重试间隔。 */
const NO_ACTIVITY_RETRY_MS = { min: 1_500, max: 4_000 } as const
/** 新窗口出现的偏好期（提高坐/爬权重）。 */
const NEW_WINDOW_BIAS_MS = 12_000
/** DSH 反应结束后「安静」窗口（权重函数里使用同一口径的 15s）。 */
const EXTERNAL_SETTLE_MS = 15_000
/** 外部反应持续时长上限（防御异常输入）。 */
const MAX_EXTERNAL_DURATION_MS = 600_000
/** 单帧事件数上限（防御异常输入）。 */
const MAX_EVENTS_PER_FRAME = 32

/** 视为「高处」的表面类型（可从上面主动跳下）。 */
const ELEVATED_SURFACE_KINDS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  'window-top',
  'menubar',
  'dock'
])

/**
 * 允许「坐下/站立落点」的表面类型（Lead 2026-11-08 集成决策）：
 * - overlay frame = workArea，`menubar` 表面 top = 0（窗口本地 y=0），宠物 feet 在 y=0 时
 *   整个身体渲染在 overlay 视口之外 → **menubar 不作为落点**；
 * - `dock`（workArea 底边/Dock 上沿）与 `window-top`（其他应用窗口上沿）完全可见，允许坐/站；
 * - `screen-bottom` 是地面基线（idle 基线即可，不需要专门的 sit 活动）；`window-side` 是边缘，
 *   只作为可爬表面，不作落点。
 * 如果未来 B5 的菜单栏表面改为「视口内可落点」，改这一处即可。
 */
const SITTABLE_SURFACE_KINDS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  'window-top',
  'dock'
])

/** 允许作为攀爬/跟随目标的边缘类型：除 menubar（落点不可见）外都可。 */
const CLIMBABLE_SURFACE_KINDS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  'window-top',
  'window-side',
  'dock',
  'screen-bottom'
])

const DEFAULT_CONFIG: BehaviorConfigSubset = {
  autonomous: true,
  autonomousLevel: 'normal',
  mischief: true,
  dshLink: true
}

/* ========================================================================== */
/* 内部类型                                                                    */
/* ========================================================================== */

/** 一帧的规范化上下文（所有非法输入已在此层清洗）。 */
interface Frame {
  nowMs: number
  dt: number
  motion: MotionSnapshot
  desktop: DesktopSnapshot
  surfaces: DesktopSurface[]
  /** 可坐表面（已按 Lead 决策过滤：仅 window-top / dock；menubar top=0 不可见不落座）。 */
  sittableSurfaces: DesktopSurface[]
  /** 可爬表面（已过滤 menubar，避免爬到视口外）。 */
  climbableSurfaces: DesktopSurface[]
  /** 位于当前脚底上方的 window-top 表面（爬窗沿候选）。 */
  windowTopSurfacesAbove: DesktopSurface[]
  currentSurface: DesktopSurface | null
  interaction: InteractionSnapshot
  events: InteractionEvent[]
  external: ExternalReaction | null
  config: BehaviorConfigSubset
  random: () => number
  workArea: Rect
  /**
   * 运动目标可达水平区间（B2 半宽钳制后的运动目标范围；H-3b）。
   * 来源 `BehaviorInput.motionLimits`（PetRuntime 依 workArea+petSize 计算）：
   * 本模块只做 sanitize，缺省 = 用 workArea 全宽。
   */
  motionLimits: MotionLimits | null
  feet: Point2D
  pointer: Point2D | null
  /** 注视角目标（B4 LookTracker 平滑输出；缺省 = pointer）。M-11 */
  lookTarget: Point2D | null
  pointerNear: boolean
  mouseAway: boolean
  elevated: boolean
  windowCount: number
}

/** 一条正在执行的活动（自主或事件驱动）。 */
interface RuntimeActivity {
  def: ActivityDefinition
  startedAtMs: number
  endsAtMs: number
  /** true = 随机调度发起；false = 交互/事件/调试发起（调试面 autonomous 字段用）。 */
  autonomous: boolean
  target: Point2D | null
  /** 分段路径（目前只有 climb：walk 到边缘下方 → climb 竖直上爬）；null = 单目标移动。 */
  path: ActivityPathStep[] | null
  /** 当前路径段下标（0 = 第一段；等于 path.length = 已到终点）。 */
  pathIndex: number
  surfaceId: string | null
  windowId: number | null
  lookPoint: Point2D | null
  arriveSit: boolean
  arrived: boolean
  seated: boolean
  /** 事件驱动（跟随窗口）用：之前是否坐姿。 */
  previousSitting: boolean
  dropRequested: boolean
}

/** 一次性交互反应（摸头/戳）。 */
interface ActiveReaction {
  kind: 'pat' | 'poke'
  region: PokeRegion | null
  escalated: boolean
  startedAtMs: number
  endsAtMs: number
  bubbleEmitted: boolean
}

/** 掉落/空中状态。 */
interface FallState {
  startedAtMs: number
  /** 是否真的观察到过 airborne（用于区分「刚触发、物理还没响应」）。 */
  wasAirborne: boolean
  /** 是否由 B1 主动请求 drop（窗口关闭 / 自主跳下）。 */
  emitDrop: boolean
  dropRequested: boolean
  wasThrown: boolean
  fromWindow: boolean
}

/** 最近一次脚底所站表面的跟踪（窗口移动/关闭的判定依据）。 */
interface TrackedSupport {
  surfaceId: string
  windowId: number | null
  kind: SurfaceKind
}

/** 分支产出的决策核心（bubble 在 finalize 时统一带上冷却门结果）。 */
interface DecisionCore {
  mood: PetMood
  motion: MotionCommand
  facing: Facing
  lookTarget: Point2D | null
  poseHint?: string
}

type FinishReason = 'completed' | 'interrupted' | 'invalid'

/* ========================================================================== */
/* 工具函数（模块级，纯函数）                                                    */
/* ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限数字兜底。 */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 数值钳制（非有限值回退 fallback）。 */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 朝向：按目标水平方向决定 left/right，接近垂直时保留 fallback。 */
function facingTowards(from: Point2D, to: Point2D, fallback: Facing): Facing {
  const dx = to.x - from.x
  if (!Number.isFinite(dx) || Math.abs(dx) < 2) return fallback
  return dx > 0 ? 'right' : 'left'
}

function isFacing(value: unknown): value is Facing {
  return value === 'left' || value === 'right' || value === 'front'
}

const SURFACE_KINDS: ReadonlySet<string> = new Set<string>([
  'screen-bottom',
  'window-top',
  'window-side',
  'menubar',
  'dock'
])

function isSurfaceKind(value: unknown): value is SurfaceKind {
  return typeof value === 'string' && SURFACE_KINDS.has(value)
}

const AUTONOMOUS_LEVELS: ReadonlySet<string> = new Set<string>(['low', 'normal', 'high'])

function isAutonomousLevel(value: unknown): value is AutonomousLevel {
  return typeof value === 'string' && AUTONOMOUS_LEVELS.has(value)
}

const POKE_REGIONS: ReadonlySet<string> = new Set<string>(['head', 'body', 'leg'])

function isPokeRegion(value: unknown): value is PokeRegion {
  return typeof value === 'string' && POKE_REGIONS.has(value)
}

const EXTERNAL_MOODS: ReadonlySet<string> = new Set<string>(['dshBusy', 'dshDone', 'dshError'])

type ExternalMood = Extract<PetMood, 'dshBusy' | 'dshDone' | 'dshError'>

function isExternalMood(value: unknown): value is ExternalMood {
  return typeof value === 'string' && EXTERNAL_MOODS.has(value)
}

/** 采样矩形：宽高必须为正、坐标有限（surface 用；非法返回 null）。 */
function normalizeSurfaceRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null
  const x = finiteOr(value.x, Number.NaN)
  const y = finiteOr(value.y, Number.NaN)
  const width = finiteOr(value.width, Number.NaN)
  const height = finiteOr(value.height, Number.NaN)
  if (![x, y, width, height].every((item) => Number.isFinite(item))) return null
  if (width < 0 || height < 0) return null
  return { x, y, width, height }
}

/** workArea：缺失/非法时回退到 1280×720；宽高必须 > 0。 */
function normalizeWorkArea(desktop: unknown): Rect {
  const record = isRecord(desktop) ? desktop : {}
  const rect = normalizeSurfaceRect(record.workArea)
  if (!rect || rect.width <= 0 || rect.height <= 0) return { ...DEFAULT_WORK_AREA }
  return rect
}

function normalizePoint(value: unknown): Point2D | null {
  if (!isRecord(value)) return null
  const x = finiteOr(value.x, Number.NaN)
  const y = finiteOr(value.y, Number.NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * `BehaviorInput.motionLimits` 清洗（H-3b）：两值必须有限、`minX <= maxX`，且都落在 workArea 内；
 * 否则视为缺省（回退到旧口径：目标只按 workArea 钳制），保证旧测试/旧调用方行为不变。
 */
function normalizeMotionLimits(value: unknown, workArea: Rect): MotionLimits | null {
  if (!isRecord(value)) return null
  const minX = finiteOr(value.minX, Number.NaN)
  const maxX = finiteOr(value.maxX, Number.NaN)
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
  if (minX > maxX) return null
  const left = workArea.x
  const right = workArea.x + workArea.width
  if (minX < left || maxX > right) return null
  return { minX, maxX }
}

/**
 * 是否「站在高处」可主动跳下（M-13）：只认 window-top/menubar/dock，且表面 top 必须明显高于地面
 * （高出至少 `ELEVATED_MIN_RISE_PX`）。Dock 与地面同 top 时不算高处，否则 `dropDown` 会变成原地跳。
 */
function isElevatedSurface(surface: DesktopSurface | null, workArea: Rect): boolean {
  if (!surface || !ELEVATED_SURFACE_KINDS.has(surface.kind)) return false
  const groundTop = workArea.y + workArea.height
  return surface.top <= groundTop - ELEVATED_MIN_RISE_PX
}

function normalizeSurface(value: unknown): DesktopSurface | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : ''
  if (!id) return null
  if (!isSurfaceKind(value.kind)) return null
  const rect = normalizeSurfaceRect(value.rect)
  if (!rect) return null
  const top = finiteOr(value.top, rect.y)
  const windowId = finiteOr(value.windowId, Number.NaN)
  return {
    id,
    kind: value.kind,
    rect,
    top,
    windowId: Number.isFinite(windowId) ? Math.trunc(windowId) : undefined,
    sittable: value.sittable === true,
    climbable: value.climbable === true
  }
}

function normalizeDesktop(value: unknown, workArea: Rect): DesktopSnapshot {
  const record = isRecord(value) ? value : {}
  const surfaces: DesktopSurface[] = []
  if (Array.isArray(record.surfaces)) {
    for (const item of record.surfaces) {
      const surface = normalizeSurface(item)
      if (surface) surfaces.push(surface)
    }
  }
  const transitions: Array<import('../core/wave2-contract').WindowTransition> = []
  if (Array.isArray(record.transitions)) {
    for (const item of record.transitions) {
      if (!isRecord(item)) continue
      const windowId = finiteOr(item.windowId, Number.NaN)
      if (!Number.isFinite(windowId)) continue
      if (item.kind === 'moved') {
        const delta = normalizePoint(item.delta) ?? { x: 0, y: 0 }
        transitions.push({ kind: 'moved', windowId: Math.trunc(windowId), delta })
      } else if (item.kind === 'closed') {
        transitions.push({ kind: 'closed', windowId: Math.trunc(windowId) })
      } else if (item.kind === 'appeared') {
        transitions.push({ kind: 'appeared', windowId: Math.trunc(windowId) })
      }
    }
  }
  const screenBoundsRaw = normalizeSurfaceRect(record.screenBounds)
  const screenBounds = screenBoundsRaw ?? {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height
  }
  return { surfaces, transitions, workArea: { ...workArea }, screenBounds }
}

function normalizeMotion(value: unknown, workArea: Rect): MotionSnapshot {
  const record = isRecord(value) ? value : {}
  const feetRecord = isRecord(record.feet) ? record.feet : {}
  const velocityRecord = isRecord(record.velocity) ? record.velocity : {}
  const feetX = clampNumber(
    finiteOr(feetRecord.x, workArea.x + workArea.width / 2),
    workArea.x,
    workArea.x + workArea.width,
    workArea.x + workArea.width / 2
  )
  const feetY = clampNumber(
    finiteOr(feetRecord.y, workArea.y + workArea.height),
    workArea.y,
    workArea.y + workArea.height,
    workArea.y + workArea.height
  )
  return {
    feet: { x: feetX, y: feetY },
    velocity: {
      x: clampNumber(finiteOr(velocityRecord.x, 0), -20_000, 20_000, 0),
      y: clampNumber(finiteOr(velocityRecord.y, 0), -20_000, 20_000, 0)
    },
    facing: isFacing(record.facing) ? record.facing : 'front',
    grounded: record.grounded === true,
    surfaceId: typeof record.surfaceId === 'string' && record.surfaceId ? record.surfaceId : null,
    airborne: record.airborne === true
  }
}

function normalizeInteraction(value: unknown): InteractionSnapshot {
  const record = isRecord(value) ? value : {}
  const pointer = normalizePoint(record.pointer)
  // M-11：区分「字段缺省」与「显式 null」——缺省沿用 pointer（旧输入/单测兼容），
  // 显式 null 表示 LookTracker 判定为不跟随（指针离开窗口 / 2.5s 无移动回落）。
  const hasLookTarget = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'lookTarget')
  const lookTarget = hasLookTarget ? normalizePoint(record.lookTarget) : undefined
  return {
    pointer,
    hoveringPet: record.hoveringPet === true,
    dragging: record.dragging === true,
    patProgress: clampNumber(finiteOr(record.patProgress, 0), 0, 1, 0),
    ...(lookTarget === undefined ? {} : { lookTarget })
  }
}

function normalizeEvents(value: unknown): InteractionEvent[] {
  if (!Array.isArray(value)) return []
  const events: InteractionEvent[] = []
  for (const item of value.slice(0, MAX_EVENTS_PER_FRAME)) {
    if (!isRecord(item)) continue
    switch (item.kind) {
      case 'dragStart': {
        const pointer = normalizePoint(item.pointer)
        if (pointer) events.push({ kind: 'dragStart', pointer })
        break
      }
      case 'dragMove': {
        const pointer = normalizePoint(item.pointer)
        if (pointer) events.push({ kind: 'dragMove', pointer })
        break
      }
      case 'dragEnd': {
        const pointer = normalizePoint(item.pointer) ?? { x: 0, y: 0 }
        const throwVelocity = normalizePoint(item.throwVelocity) ?? { x: 0, y: 0 }
        events.push({ kind: 'dragEnd', pointer, throwVelocity })
        break
      }
      case 'pat':
        events.push({ kind: 'pat' })
        break
      case 'poke':
        if (isPokeRegion(item.region)) events.push({ kind: 'poke', region: item.region })
        break
      case 'hoverEnter':
        events.push({ kind: 'hoverEnter' })
        break
      case 'hoverLeave':
        events.push({ kind: 'hoverLeave' })
        break
      case 'menuAction': {
        const action = item.action
        if (
          action === 'settings' ||
          action === 'hide' ||
          action === 'toggleAutonomous' ||
          action === 'quit'
        ) {
          events.push({ kind: 'menuAction', action })
        }
        break
      }
      default:
        break
    }
  }
  return events
}

function normalizeConfig(value: unknown): BehaviorConfigSubset {
  const record = isRecord(value) ? value : {}
  return {
    autonomous: record.autonomous !== false,
    autonomousLevel: isAutonomousLevel(record.autonomousLevel)
      ? record.autonomousLevel
      : DEFAULT_CONFIG.autonomousLevel,
    mischief: record.mischief !== false,
    dshLink: record.dshLink !== false
  }
}

function normalizeExternal(value: unknown): ExternalReaction | null {
  if (!isRecord(value)) return null
  if (!isExternalMood(value.mood)) return null
  const durationMs = finiteOr(value.durationMs, 0)
  if (!(durationMs > 0)) return null
  const startedAtMs = finiteOr(value.startedAtMs, Number.NaN)
  if (!Number.isFinite(startedAtMs)) return null
  const bubble =
    typeof value.bubble === 'string' && value.bubble.trim().length > 0 ? value.bubble.trim() : null
  return {
    mood: value.mood,
    durationMs: clampNumber(durationMs, 1, MAX_EXTERNAL_DURATION_MS, 1),
    startedAtMs,
    bubble
  }
}

/** 外部反应当前是否在持续期内（时钟口径与 input.nowMs 一致）。 */
function isExternalActive(reaction: ExternalReaction | null, nowMs: number): boolean {
  if (!reaction) return false
  return nowMs >= reaction.startedAtMs && nowMs < reaction.startedAtMs + reaction.durationMs
}

function externalPoseHint(mood: ExternalMood): string {
  if (mood === 'dshBusy') return 'dsh:busy'
  if (mood === 'dshDone') return 'dsh:done'
  return 'dsh:error'
}

/* ========================================================================== */
/* BehaviorDirector                                                            */
/* ========================================================================== */

/**
 * B1 行为决策器。
 *
 * 典型接线（Lead 在 `main.ts` 每帧调用）：
 * ```ts
 * const director = new BehaviorDirector()          // 或 new BehaviorDirector({ seed })
 * const decision = director.update({
 *   nowMs, dt, motion, desktop, interaction, events, external, config,
 *   random: Math.random                             // 单测注入 seeded RNG
 * })
 * physics.setCommand(decision.motion)
 * scene.setAnimationInput({ mood: decision.mood, lookTarget: decision.lookTarget, ... })
 * if (decision.bubble) showBubble(decision.bubble, BUBBLE_DURATION_MS)
 * debug.behavior = director.getDebugSnapshot()
 * ```
 */
export class BehaviorDirector {
  /** 内部随机源（`input.random` 缺失时的兜底；`setRandom` 可替换）。 */
  private randomSource: () => number

  private readonly bubbleGate: BubbleGate

  /** 当前语义 mood（`BehaviorDecision.mood` 的来源）。 */
  private currentMood: PetMood
  private moodSinceMs: number

  /** 正在执行的自主/事件驱动活动。 */
  private activity: RuntimeActivity | null = null
  /** 一次性的摸头/戳反应。 */
  private reaction: ActiveReaction | null = null
  /** 掉落/空中状态。 */
  private fallState: FallState | null = null

  /** 是否按住拖动中（B4 的 dragStart/dragEnd 与 `interaction.dragging` 双保险）。 */
  private dragging = false
  private dragBubbleEmitted = false

  /** `applyExternalReaction` 注入的反应（与 input.external 取较新者）。 */
  private injectedExternal: ExternalReaction | null = null
  /** 当前正在表演的外部反应。 */
  private activeExternal: ExternalReaction | null = null
  /** 已经播过气泡的外部反应 key（`mood:startedAtMs`），避免每帧重复。 */
  private lastExternalBubbleKey: string | null = null
  /** 上一次外部反应结束时刻（权重里的「安静」窗口）。 */
  private lastExternalEndMs: number | null = null

  /** activityId → 冷却结束时刻。 */
  private readonly cooldownUntilMs = new Map<string, number>()
  /** 下一次自主活动尝试的时刻（null = 未计划/自主关闭）。 */
  private nextActivityAtMs: number | null = null
  /**
   * 落地后优先尝试的活动（2026-11-08 用户反馈「把它放到窗口上面不会坐下」）：
   * 落到可坐窗口上沿后，短延迟优先坐上去，而不是等随机活动或先走开掉下去。
   */
  private preferredActivityId: ActivityId | null = null
  /** 落地后优先坐下要绑定的落地表面 id（N-2：不再随机选一块窗沿）。 */
  private preferredSurfaceId: string | null = null
  /** 「立刻坐下」请求：集成层把宠物直接吸附到可坐窗沿后设置，下一帧消费。 */
  private immediateSitSurfaceId: string | null = null
  /** 空闲站在可坐窗口上沿的起始时间（ms；null = 不在这种状态）。 */
  private windowTopIdleSinceMs: number | null = null
  /** 自动坐下后的强制间隔截止时刻（N-1；null = 无间隔，例如刚被放到窗沿）。 */
  private autoSitGapUntilMs: number | null = null
  /** GAP 期间被推后的 sit 冷却原值（N-1；离开窗沿时恢复，避免“换个窗沿还等冷却”）。 */
  private sitCooldownRestoreMs: number | null = null
  /** 窗沿卧姿不变量（2026-11-10）：当前连续完成的 recumbent 段数（受控 dropDown 离开的计数）。 */
  private windowTopRestSegmentsCompleted = 0
  /** 上一次发起（或最近完成）的活动 id（避免连续重复）。 */
  private lastStartedActivityId: ActivityId | null = null

  /** idle 基线进入时刻（活动抑制轴的「闲着多久」）。 */
  private idleSinceMs: number | null = null
  /**
   * 鼠标离开时的 sleep 抽取窗口（H-5）：idle 基线达到 `SLEEP_MIN_IDLE_MS + 抖动` 的时刻。
   * 用于把下一次抽取夹到「sleep 需求刚好满足」的时机（见 buildAutonomousDecision）。
   */
  private idleSleepWindowAtMs: number | null = null
  /** 最近一次交互事件时刻。 */
  private lastInteractionAtMs: number | null = null
  /** 连续摸头时刻表（10s 内 ≥3 次触发嘴硬/翻脸）。 */
  private patTimes: number[] = []
  /** 落地 poseHint 的截止时刻。 */
  private landPoseUntilMs = 0
  /** 新窗口偏好截止时刻。 */
  private newWindowBiasUntilMs = Number.NEGATIVE_INFINITY

  /** 最近一次脚底所站表面（窗口 moved/closed 的匹配依据）。 */
  private trackedSupport: TrackedSupport | null = null

  /** 本帧事件标记（避免事件与 interaction 快照互相覆盖）。 */
  private dragStartedThisFrame = false
  private dragReleasedThisFrame = false

  /** 本帧待发气泡（最终写入 BehaviorDecision.bubble）。 */
  private pendingBubble: string | null = null

  /** 最近一帧（调试 `triggerActivity` 需要环境；也方便排障）。 */
  private lastFrame: Frame | null = null

  /** 最近一次配置（`triggerActivity`/debug 在 update 之外使用）。 */
  private lastConfig: BehaviorConfigSubset = { ...DEFAULT_CONFIG }

  constructor(options: BehaviorDirectorOptions = {}) {
    const seed = options.seed
    if (typeof options.random === 'function') {
      this.randomSource = sanitizeRandom(options.random)
    } else if (typeof seed === 'number' && Number.isFinite(seed)) {
      this.randomSource = createSeededRandom(seed)
    } else {
      this.randomSource = Math.random
    }
    this.currentMood = options.initialMood ?? 'idle'
    this.moodSinceMs = finiteOr(options.initialNowMs, 0)
    this.bubbleGate = new BubbleGate({
      globalCooldownMs: options.bubbleGlobalCooldownMs,
      categoryCooldownMs: options.bubbleCategoryCooldownMs,
      lineCooldownMs: options.bubbleLineCooldownMs
    })
  }

  /* ---------------------------------------------------------------------- */
  /* 对外 API                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * 主更新：每帧调用一次，返回本帧行为决策。
   * 纯函数式语义：同样的初始状态 + 同样的输入序列（含同一个 seeded `random`）→ 完全相同的决策序列。
   */
  update(input: BehaviorInput): BehaviorDecision {
    const frame = this.buildFrame(input)
    this.lastFrame = frame
    this.pendingBubble = null
    this.dragStartedThisFrame = false
    this.dragReleasedThisFrame = false

    this.handleEvents(frame)
    this.handleTransitions(frame)
    this.updateDragState(frame)
    this.refreshExternal(frame)
    this.expireReaction(frame)
    this.trackAirborne(frame)

    // 2026-11-10：被「放置到可坐窗沿」后的立即坐下（跳过落地延迟，避免第一帧站着）。
    const immediateSit =
      this.dragging || this.reaction || this.fallState ? null : this.consumeImmediateSit(frame)
    if (immediateSit) {
      this.updateTrackedSupport(frame)
      return this.finalizeDecision(frame, immediateSit)
    }

    // M-14：优先级与文件头/README 的口径统一为
    // drag > pat/poke 即时反应 > fall > DSH 外部反应 > 自主活动 > idle。
    // pat/poke 分支在 fall 之前：空中被摸头/戳时立即表演反应（物理仍由 B2 接管、fallState 继续跟踪，
    // 落地时 finishFall 照常生效）；否则事件会被 fall 吞掉、落地后再延迟播放。
    let core: DecisionCore
    if (this.dragging) {
      core = this.buildDragDecision(frame)
    } else if (this.reaction) {
      core = this.buildReactionDecision(frame)
    } else if (this.fallState) {
      core = this.buildFallDecision(frame)
    } else if (this.activeExternal) {
      core = this.buildExternalDecision(frame)
    } else {
      core = this.buildAutonomousDecision(frame)
    }

    this.updateTrackedSupport(frame)
    return this.finalizeDecision(frame, core)
  }

  /**
   * B7/main.ts 反应注入（也可只通过 `BehaviorInput.external` 传）。
   * 优先级低于摸头/戳，且不会打断拖拽（由 update 的分支顺序保证）。
   */
  applyExternalReaction(reaction: ExternalReaction): void {
    const sanitized = normalizeExternal(reaction)
    if (!sanitized) return
    this.injectedExternal = sanitized
  }

  /** 设置内部随机源（单测/调试；默认 Math.random）。注意每帧决策仍以 `input.random` 为准。 */
  setRandom(random: () => number): void {
    this.randomSource = sanitizeRandom(random)
  }

  /** 调试快照（main.ts 写 `window.__aventurineDebug.behavior`）。 */
  getDebugSnapshot(): BehaviorDebugSnapshot {
    const nowMs = this.lastFrame?.nowMs ?? this.moodSinceMs
    return {
      mood: this.currentMood,
      activity: this.describeActivity(),
      autonomous: this.describeAutonomous(),
      moodSinceMs: this.moodSinceMs,
      nextActivityInMs: this.computeNextActivityInMs(nowMs),
      cooldownCount: this.countCooldowns(nowMs)
    }
  }

  /**
   * 调试强制触发活动（`window.__aventurineDebug` 的 debugTriggerActivity 用）。
   *
   * `schedulable` 只约束**自主随机调度**（见 activities.ts 的 `scoreActivity`）；调试显式触发是
   * 独立通道，因此 `schedulable=false` 的 climb 仍可人工触发用于排查（2026-11-08 用户要求
   * 移除的只是「自主爬窗」）。climb 的目标准备（`prepareClimbTarget`）与其他活动一样执行。
   *
   * @returns false = 未知活动 / 冷却中 / 正在拖拽/反应/掉落 / 缺少所需桌面表面
   */
  triggerActivity(activityId: string, nowMs: number): boolean {
    if (typeof activityId !== 'string') return false
    const definition = findActivityDefinition(activityId)
    if (!definition) return false
    if (this.dragging || this.reaction || this.fallState) return false
    const now = finiteOr(nowMs, 0)
    const cooldownUntil = this.cooldownUntilMs.get(definition.id)
    if (typeof cooldownUntil === 'number' && now < cooldownUntil) return false

    const baseFrame = this.lastFrame ?? this.createNeutralFrame(now)
    const probeFrame: Frame = {
      ...baseFrame,
      nowMs: now,
      random: sanitizeRandom(this.randomSource)
    }
    // 窗沿卧姿不变量（调度层兜底）：可坐窗口上沿上禁止调试触发站立/走动/看/睡/爬类活动
    // （唯一自主离开方式是受控 dropDown；调试触发是独立通道，但窗沿上是硬约束）。
    if (
      this.onSittableWindowTop(probeFrame) !== null &&
      !WINDOW_TOP_REST_ALLOWED_ACTIVITIES.has(definition.id)
    ) {
      return false
    }
    // 调试触发不走自主调度，但仍要为目标类活动准备路径（climb 依赖 `prepareClimbTarget`
    // 产出的两段式 path；旧逻辑按 schedulable 跳过准备，会导致 climb 被触发后没有路径）。
    const prepared = this.prepareActivity(definition, probeFrame)
    if (
      !prepared &&
      definition.requirements.some(
        (requirement) => requirement === 'sittableSurface' || requirement === 'climbableSurface'
      )
    ) {
      return false
    }
    if (this.activity) this.activity = null
    this.startActivity(definition, probeFrame, prepared ?? {}, false)
    this.currentMood = definition.mood
    this.moodSinceMs = now
    return true
  }

  /* ---------------------------------------------------------------------- */
  /* 帧输入规范化                                                            */
  /* ---------------------------------------------------------------------- */

  private buildFrame(input: BehaviorInput): Frame {
    const raw: Record<string, unknown> = isRecord(input) ? (input as unknown as Record<string, unknown>) : {}
    const nowMs = finiteOr(raw.nowMs, 0)
    const dt = clampNumber(finiteOr(raw.dt, 0), 0, 0.1, 0)
    const workArea = normalizeWorkArea(raw.desktop)
    const desktop = normalizeDesktop(raw.desktop, workArea)
    const motion = normalizeMotion(raw.motion, workArea)
    const motionLimits = normalizeMotionLimits(raw.motionLimits, workArea)
    const interaction = normalizeInteraction(raw.interaction)
    const events = normalizeEvents(raw.events)
    const external = normalizeExternal(raw.external)
    const config = normalizeConfig(raw.config)
    const injectedRandom = raw.random
    const random = sanitizeRandom(
      typeof injectedRandom === 'function' ? (injectedRandom as () => number) : this.randomSource
    )
    this.lastConfig = config

    const surfaces = desktop.surfaces
    const currentSurface = motion.surfaceId
      ? (surfaces.find((surface) => surface.id === motion.surfaceId) ?? null)
      : null
    const windowIds = new Set<number>()
    for (const surface of surfaces) {
      if (typeof surface.windowId === 'number') windowIds.add(surface.windowId)
    }

    const pointer = interaction.pointer
    // M-11：注视目标 = LookTracker 平滑输出（缺省回退原始 pointer）；
    // 仅用于 gaze，pointerNear/mouseAway/朝向仍用原始 pointer。
    const lookTarget = interaction.lookTarget !== undefined ? interaction.lookTarget : pointer
    const chestReference: Point2D = { x: motion.feet.x, y: motion.feet.y - 160 }
    const pointerDistance = pointer ? distance(pointer, chestReference) : Number.POSITIVE_INFINITY
    const pointerNear =
      pointer !== null && (interaction.hoveringPet || pointerDistance <= POINTER_NEAR_DISTANCE_PX)
    const mouseAway = pointer === null || pointerDistance > MOUSE_AWAY_DISTANCE_PX

    return {
      nowMs,
      dt,
      motion,
      desktop,
      surfaces,
      // 落点过滤（Lead B5/B2 边界决策）：menubar top=0 会把宠物渲染到视口外，不坐不站；
      // Dock / window-top 在 workArea 内完全可见，允许坐。
      sittableSurfaces: surfaces.filter(
        (surface) => surface.sittable && SITTABLE_SURFACE_KINDS.has(surface.kind)
      ),
      climbableSurfaces: surfaces.filter(
        (surface) => surface.climbable && CLIMBABLE_SURFACE_KINDS.has(surface.kind)
      ),
      windowTopSurfacesAbove: surfaces.filter(
        (surface) => surface.kind === 'window-top' && surface.top < motion.feet.y - 40
      ),
      currentSurface,
      interaction,
      events,
      external,
      config,
      random,
      workArea,
      motionLimits,
      feet: motion.feet,
      pointer,
      lookTarget,
      pointerNear,
      mouseAway,
      elevated: isElevatedSurface(currentSurface, workArea),
      windowCount: windowIds.size
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 事件 / 交互 / 外部反应 / 物理状态                                        */
  /* ---------------------------------------------------------------------- */

  private handleEvents(frame: Frame): void {
    if (frame.events.length === 0) return
    let patSeen = false
    let pokeRegion: PokeRegion | null = null
    let hoverEnterSeen = false

    for (const event of frame.events) {
      this.lastInteractionAtMs = frame.nowMs
      switch (event.kind) {
        case 'dragStart':
          this.dragStartedThisFrame = true
          if (!this.dragging) {
            this.dragging = true
            this.dragBubbleEmitted = false
            this.cancelAutonomousActivity()
            this.reaction = null
            this.fallState = null
          }
          break
        case 'dragMove':
          break
        case 'dragEnd': {
          this.dragReleasedThisFrame = true
          const speed = Math.hypot(event.throwVelocity.x, event.throwVelocity.y)
          this.dragging = false
          this.reaction = null
          if (speed >= THROW_SPEED_THRESHOLD_PX_PER_SEC || frame.motion.airborne) {
            this.startFall(frame, { emitDrop: false, wasThrown: true, fromWindow: false })
          } else {
            this.scheduleAfterInteraction(frame)
          }
          break
        }
        case 'pat':
          patSeen = true
          break
        case 'poke':
          if (pokeRegion === null) pokeRegion = event.region
          break
        case 'hoverEnter':
          hoverEnterSeen = true
          break
        case 'hoverLeave':
        case 'menuAction':
          break
        default:
          break
      }
    }

    if (hoverEnterSeen && !this.dragging && !this.reaction && !this.fallState) {
      // 「鼠标回来会避让」：延后下一次自主活动，并唤醒睡/发呆中的宠物
      this.postponeAutonomous(frame, HOVER_AVOID_DELAY_MS)
      if (this.activity && (this.activity.def.id === 'sleep' || this.activity.def.id === 'idleGaze')) {
        this.wakeActivity(frame)
      }
      if (!this.activeExternal) this.tryEmitBubble(frame, 'hover')
    }

    if (!this.dragging) {
      if (patSeen) this.startReaction(frame, 'pat', null)
      else if (pokeRegion) this.startReaction(frame, 'poke', pokeRegion)
    }
  }

  /** `interaction.dragging` 与事件双保险（事件可能被 main.ts 清空/丢失）。 */
  private updateDragState(frame: Frame): void {
    if (frame.interaction.dragging) {
      if (!this.dragging && !this.dragReleasedThisFrame) {
        this.dragging = true
        this.dragBubbleEmitted = false
        this.cancelAutonomousActivity()
        this.reaction = null
        this.fallState = null
      }
      return
    }
    if (this.dragging && !this.dragStartedThisFrame && !this.dragReleasedThisFrame) {
      this.dragging = false
      if (frame.motion.airborne) {
        this.startFall(frame, { emitDrop: false, wasThrown: true, fromWindow: false })
      } else {
        this.scheduleAfterInteraction(frame)
      }
    }
  }

  /** 桌面窗口变化：moved → 跟随；closed → 掉落（仅当宠物靠该窗口支撑）。 */
  private handleTransitions(frame: Frame): void {
    if (frame.desktop.transitions.length === 0) return
    for (const transition of frame.desktop.transitions) {
      if (transition.kind === 'appeared') {
        this.newWindowBiasUntilMs = frame.nowMs + NEW_WINDOW_BIAS_MS
        continue
      }
      const tracked = this.trackedSupport
      if (!tracked || tracked.windowId === null || tracked.windowId !== transition.windowId) continue

      if (transition.kind === 'closed') {
        if (this.dragging) continue
        this.startFall(frame, { emitDrop: true, wasThrown: false, fromWindow: true })
        this.trackedSupport = null
        continue
      }

      if (transition.kind === 'moved') {
        if (this.dragging || this.reaction || this.fallState || this.activeExternal) continue
        const surface = this.findFollowSurface(frame, transition.windowId)
        if (!surface) continue
        this.startFollowActivity(frame, surface)
      }
    }
  }

  /** 外部反应同步：input.external 与 applyExternalReaction 注入取较新且未过期者。 */
  private refreshExternal(frame: Frame): void {
    const candidates: ExternalReaction[] = []
    if (isExternalActive(frame.external, frame.nowMs)) candidates.push(frame.external as ExternalReaction)
    if (isExternalActive(this.injectedExternal, frame.nowMs)) {
      candidates.push(this.injectedExternal as ExternalReaction)
    }
    if (this.injectedExternal && !isExternalActive(this.injectedExternal, frame.nowMs)) {
      this.injectedExternal = null
    }

    let chosen: ExternalReaction | null = null
    for (const candidate of candidates) {
      if (!chosen || candidate.startedAtMs >= chosen.startedAtMs) chosen = candidate
    }
    // dshLink 关闭 → 静默（B7 侧应已不产反应；这里双保险）
    if (!frame.config.dshLink) chosen = null

    if (chosen) {
      const isNewInstance =
        !this.activeExternal ||
        this.activeExternal.startedAtMs !== chosen.startedAtMs ||
        this.activeExternal.mood !== chosen.mood
      if (isNewInstance) {
        // 只打断自主活动；摸头/戳与拖拽优先级更高，由 update 的分支顺序保证
        this.cancelAutonomousActivity()
      }
      this.activeExternal = chosen
      if (!this.activeExternal) this.lastExternalEndMs = null
    } else if (this.activeExternal) {
      this.activeExternal = null
      this.lastExternalEndMs = frame.nowMs
      if (this.lastConfig.autonomous) {
        this.nextActivityAtMs = frame.nowMs + randomInt(frame.random, 2_000, 5_000)
      }
    }
  }

  /** 摸头/戳结束后排下一次自主尝试。 */
  private expireReaction(frame: Frame): void {
    if (!this.reaction) return
    if (frame.nowMs < this.reaction.endsAtMs) return
    this.reaction = null
    if (this.lastConfig.autonomous) {
      this.nextActivityAtMs =
        frame.nowMs + randomInt(frame.random, INTERACTION_RECOVER_MS.min, INTERACTION_RECOVER_MS.max)
    }
  }

  /** 空中状态跟踪：拖拽后甩出/被物理抛起 → fall；窗口关闭由 transitions 触发 drop。 */
  private trackAirborne(frame: Frame): void {
    if (this.dragging) return
    if (this.fallState) {
      if (frame.motion.airborne) {
        this.fallState.wasAirborne = true
        return
      }
      if (this.fallState.wasAirborne && frame.motion.grounded) {
        this.finishFall(frame)
        return
      }
      if (frame.nowMs - this.fallState.startedAtMs > FALL_RESOLVE_TIMEOUT_MS) {
        this.finishFall(frame)
      }
      return
    }
    if (frame.motion.airborne) {
      this.startFall(frame, { emitDrop: false, wasThrown: false, fromWindow: false })
    }
  }

  private startFall(
    frame: Frame,
    options: { emitDrop: boolean; wasThrown: boolean; fromWindow: boolean }
  ): void {
    this.cancelAutonomousActivity()
    this.reaction = null
    this.fallState = {
      startedAtMs: frame.nowMs,
      wasAirborne: frame.motion.airborne,
      emitDrop: options.emitDrop,
      dropRequested: false,
      wasThrown: options.wasThrown,
      fromWindow: options.fromWindow
    }
    this.nextActivityAtMs = null
  }

  private finishFall(frame: Frame): void {
    this.fallState = null
    this.landPoseUntilMs = frame.nowMs + LAND_POSE_HINT_MS
    this.trackedSupport = null
    // 落在窗口上沿 → 恢复后优先坐/跳下（用户把宠物放到窗口上沿时期望它坐上去）。
    // 2026-11-10：这是对「用户把宠物放到窗口上」的直接反应，**不再受 autonomous 开关门控**
    //（此前测试配置 autonomous=false 时宠物落在窗沿上只会站着，看起来像「坐窗沿失效」）。
    const landedSurface = frame.motion.surfaceId
      ? frame.desktop.surfaces.find((surface) => surface.id === frame.motion.surfaceId)
      : null
    if (landedSurface && landedSurface.kind === 'window-top') {
      // 落在窗沿上：可坐 → 尽快坐下（用户不希望它先在窗沿上站着）；不可坐（太高/被挡）→ 干脆跳下去，
      // 不要在高窗口顶「站」着（身体会跑到屏幕外）。
      this.preferredActivityId = landedSurface.sittable === true ? 'sit' : 'dropDown'
      // N-2：优先 sit 绑定「落地的那块」表面，不能再随机选到旁边另一块窗沿
      this.preferredSurfaceId = landedSurface.sittable === true ? landedSurface.id : null
      this.nextActivityAtMs = frame.nowMs + (landedSurface.sittable === true ? 450 : 250)
    } else if (this.lastConfig.autonomous) {
      this.preferredActivityId = null
      this.preferredSurfaceId = null
      this.nextActivityAtMs =
        frame.nowMs + randomInt(frame.random, LAND_RECOVER_MS.min, LAND_RECOVER_MS.max)
    } else {
      this.preferredActivityId = null
      this.preferredSurfaceId = null
      this.nextActivityAtMs = null
    }
  }

  private startReaction(frame: Frame, kind: 'pat' | 'poke', region: PokeRegion | null): void {
    this.cancelAutonomousActivity()
    const now = frame.nowMs

    if (kind === 'pat') {
      this.patTimes = this.patTimes.filter((time) => now - time <= PAT_ESCALATION_WINDOW_MS)
      this.patTimes.push(now)
      const escalated = this.patTimes.length >= PAT_ESCALATION_COUNT
      const duration = escalated
        ? 1_100
        : randomInt(frame.random, PAT_DURATION_MS.min, PAT_DURATION_MS.max)
      this.reaction = {
        kind: 'pat',
        region: null,
        escalated,
        startedAtMs: now,
        endsAtMs: now + duration,
        bubbleEmitted: false
      }
      return
    }

    // 摸头反应期间被戳不再叠加（摸头优先）；同部位连戳只刷新一次
    if (this.reaction?.kind === 'pat') return
    const duration = randomInt(frame.random, POKE_DURATION_MS.min, POKE_DURATION_MS.max)
    this.reaction = {
      kind: 'poke',
      region,
      escalated: false,
      startedAtMs: now,
      endsAtMs: now + duration,
      bubbleEmitted: false
    }
  }

  private scheduleAfterInteraction(frame: Frame): void {
    if (!this.lastConfig.autonomous) {
      this.nextActivityAtMs = null
      return
    }
    this.nextActivityAtMs =
      frame.nowMs + randomInt(frame.random, INTERACTION_RECOVER_MS.min, INTERACTION_RECOVER_MS.max)
  }

  private postponeAutonomous(frame: Frame, delayMs: number): void {
    if (!this.lastConfig.autonomous) {
      this.nextActivityAtMs = null
      return
    }
    const target = frame.nowMs + Math.max(0, delayMs)
    if (this.nextActivityAtMs === null || this.nextActivityAtMs < target) {
      this.nextActivityAtMs = target
    }
  }

  /** 悬停唤醒睡觉/发呆：结束当前活动并推迟下一次自主尝试（先观察用户）。 */
  private wakeActivity(frame: Frame): void {
    if (!this.activity) return
    this.finishActivity(frame, 'interrupted')
    this.nextActivityAtMs = frame.nowMs + randomInt(frame.random, 2_000, 5_000)
  }

  /* ---------------------------------------------------------------------- */
  /* 各优先级分支的决策                                                       */
  /* ---------------------------------------------------------------------- */

  private buildDragDecision(frame: Frame): DecisionCore {
    if (!this.dragBubbleEmitted) {
      this.dragBubbleEmitted = true
      this.tryEmitBubble(frame, 'drag')
    }
    return {
      mood: 'drag',
      motion: { kind: 'hold' },
      facing: frame.motion.facing,
      lookTarget: null,
      poseHint: 'drag'
    }
  }

  private buildFallDecision(frame: Frame): DecisionCore {
    const fall = this.fallState
    let motion: MotionCommand = { kind: 'hold' }
    if (fall && !fall.dropRequested && fall.emitDrop) {
      fall.dropRequested = true
      motion = { kind: 'drop' }
    }
    return {
      mood: 'fall',
      motion,
      facing: frame.motion.facing,
      lookTarget: null,
      poseHint: fall?.wasThrown ? 'fall:thrown' : 'fall'
    }
  }

  private buildReactionDecision(frame: Frame): DecisionCore {
    const reaction = this.reaction
    if (!reaction) {
      return this.buildIdleDecision(frame)
    }
    if (!reaction.bubbleEmitted) {
      reaction.bubbleEmitted = true
      this.tryEmitBubble(frame, reaction.kind === 'pat' ? 'pat' : 'poke')
    }
    const pointer = frame.pointer
    let poseHint = 'pat:head'
    if (reaction.kind === 'poke') {
      poseHint = reaction.region ? `poke:${reaction.region}` : 'poke:body'
    } else if (reaction.escalated) {
      poseHint = 'pat:annoyed'
    }
    return {
      mood: 'pat',
      motion: { kind: 'hold' },
      facing: pointer ? facingTowards(frame.feet, pointer, frame.motion.facing) : frame.motion.facing,
      lookTarget: pointer,
      poseHint
    }
  }

  private buildExternalDecision(frame: Frame): DecisionCore {
    const external = this.activeExternal
    if (!external) {
      return this.buildIdleDecision(frame)
    }
    const key = `${external.mood}:${external.startedAtMs}`
    if (this.lastExternalBubbleKey !== key) {
      this.lastExternalBubbleKey = key
      if (external.bubble) {
        // B7 给的现成台词：只播一次，出现后刷新全局气泡冷却
        this.pendingBubble = external.bubble
        this.bubbleGate.notifyExternalBubble(frame.nowMs)
      } else if (frame.config.dshLink) {
        this.pendingBubble = this.bubbleGate.tryEmit(external.mood, frame.nowMs, frame.random)
      }
    }
    return {
      mood: external.mood,
      motion: { kind: 'hold' },
      facing: 'front',
      lookTarget: null,
      poseHint: externalPoseHint(external.mood)
    }
  }

  /**
   * 自主/空闲分支：处理 `autonomous=false`、执行中的活动、以及 idle 基线的 variable-time 调度。
   */
  private buildAutonomousDecision(frame: Frame): DecisionCore {
    // 0) 窗沿卧姿不变量：最高优先级（用户 2026-11-10 设计约束）。
    //    与 autonomous 开关无关——放到/落在可坐窗沿是直接物理状态，和 consumeImmediateSit/finishFall
    //    同口径不受「随机漫游」门控；返回非 null 时覆盖全部空闲/活动路径，保证零站立/走动帧。
    const windowTopRest = this.maintainWindowTopRest(frame)
    if (windowTopRest) return windowTopRest

    // 1) 自主活动总开关：关闭后只保留 idle + 「落地/放到窗沿」的直接反应
    //    （交互/外部反应已在更高优先级分支处理）。
    if (!frame.config.autonomous) {
      // 1a) 正在进行的非自主直接反应（落地坐/跳下）继续执行到结束。
      if (this.activity) {
        if (this.activity.autonomous) {
          this.cancelAutonomousActivity()
        } else {
          const core = this.updateActivity(frame)
          if (core) return core
        }
      }
      // 1b) 消费 finishFall 写入的窗沿落地反应（sit / dropDown）——不因自主关闭而站着不动。
      //     保留 finishFall 设定的 250/450ms 延迟（先播落地姿态，再坐/跳下）。
      if (
        (this.preferredActivityId === 'sit' || this.preferredActivityId === 'dropDown') &&
        this.nextActivityAtMs !== null &&
        frame.nowMs < this.nextActivityAtMs
      ) {
        return this.buildIdleDecision(frame)
      }
      const windowTopReaction = this.consumePreferredWindowTopReaction(frame)
      if (windowTopReaction) return windowTopReaction
      this.nextActivityAtMs = null
      return this.buildIdleDecision(frame)
    }

    // 2) 执行中的活动（活动结束可能立即续接另一活动，如跟随窗口结束后恢复坐姿）
    if (this.activity) {
      for (let attempt = 0; attempt < 2 && this.activity; attempt += 1) {
        const core = this.updateActivity(frame)
        if (core) return core
      }
      // 活动刚刚结束（已排程）→ 回 idle 基线
      return this.buildIdleDecision(frame)
    }

    // 2.5) 空闲站在「可坐窗口上沿」→ 短延迟自动坐下（用户把宠物丢到窗沿上时不想看它一直站着）
    if (!this.activity) {
      const windowTopSit = this.trySitOnWindowTop(frame)
      if (windowTopSit) return windowTopSit
    }

    // 3) idle 基线：首次进入 / 被重置后初始化下一次尝试时间
    if (this.nextActivityAtMs === null) {
      const pace = LEVEL_PACE[frame.config.autonomousLevel] ?? LEVEL_PACE.normal
      this.nextActivityAtMs = frame.nowMs + randomInt(frame.random, pace.initialDelayMs[0], pace.initialDelayMs[1])
    }

    // 3.5) H-5：鼠标离开时保证「下一次抽取」不晚于 sleep 窗口（idleSince + 20s + 抖动）。
    //      否则活动结束后的固定 idleDelay（normal 8–18s / high 4.2–10s）永远早于 20s，
    //      sleep 需求在抽取时永远不满足（默认档 sleep 永不调度）。
    if (
      frame.mouseAway &&
      this.idleSleepWindowAtMs !== null &&
      this.nextActivityAtMs !== null &&
      frame.nowMs < this.idleSleepWindowAtMs
    ) {
      this.nextActivityAtMs = Math.min(this.nextActivityAtMs, this.idleSleepWindowAtMs)
    }

    // 4) 到点 → 加权抽活动；抽不到（无表面等）短延时重试
    if (frame.nowMs >= this.nextActivityAtMs) {
      // 落地在可坐窗口上沿 → 优先坐下（一次机会；失败则回到常规加权抽取）。
      if (this.preferredActivityId) {
        const preferred = findActivityDefinition(this.preferredActivityId)
        const preferredSurfaceId = this.preferredSurfaceId
        this.preferredActivityId = null
        this.preferredSurfaceId = null
        if (preferred) {
          const prepared = this.preparePreferredActivity(preferred, preferredSurfaceId, frame)
          if (prepared) {
            this.startActivity(preferred, frame, prepared, true)
            const core = this.updateActivity(frame)
            if (core) return core
          }
        }
      }
      const definition = this.pickAndStartActivity(frame)
      if (definition) {
        const core = this.updateActivity(frame)
        if (core) return core
      } else {
        this.nextActivityAtMs =
          frame.nowMs + randomInt(frame.random, NO_ACTIVITY_RETRY_MS.min, NO_ACTIVITY_RETRY_MS.max)
      }
    }

    return this.buildIdleDecision(frame)
  }

  private buildIdleDecision(frame: Frame): DecisionCore {
    const pointer = frame.pointer
    const facing =
      pointer && Math.abs(pointer.x - frame.feet.x) > 24
        ? facingTowards(frame.feet, pointer, frame.motion.facing)
        : frame.motion.facing
    return {
      mood: 'idle',
      motion: { kind: 'hold' },
      facing,
      // M-11：注视用 LookTracker 平滑目标；朝向仍跟随原始 pointer（避免平滑造成迟钝）。
      lookTarget: frame.lookTarget,
      poseHint: frame.nowMs < this.landPoseUntilMs ? 'land' : undefined
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 窗沿卧姿不变量（用户 2026-11-10：可坐窗口上沿只趴/坐/躺）                   */
  /* ---------------------------------------------------------------------- */

  /**
   * 脚底是否 grounded 在**可坐窗口上沿**（OnLedge）。
   *
   * 主口径：`motion.grounded && currentSurface.kind==='window-top' && currentSurface.sittable`。
   * D6a 段 id 抖动兜底：`currentSurface` 的 id 暂时对不上时，按「同 top ±2px + 横向覆盖脚底」在
   * `frame.surfaces` 里重匹配一块可坐窗沿（返回重匹配表面；调用方按它的 id 绑定 sit）。
   *
   * 拖拽/反应/掉落期间返回 null：这些是更高优先级的物理/交互路径（动画层另有安全网）。
   */
  private onSittableWindowTop(frame: Frame): DesktopSurface | null {
    if (frame.motion.grounded !== true || this.dragging || this.reaction || this.fallState) {
      return null
    }
    const surface = frame.currentSurface
    if (surface && surface.kind === 'window-top' && surface.sittable === true) return surface
    for (const candidate of frame.surfaces) {
      if (candidate.kind !== 'window-top' || candidate.sittable !== true) continue
      if (Math.abs(candidate.top - frame.feet.y) > WINDOW_TOP_REMATCH_TOP_EPS_PX) continue
      if (frame.feet.x < candidate.rect.x) continue
      if (frame.feet.x > candidate.rect.x + candidate.rect.width) continue
      return candidate
    }
    return null
  }

  /**
   * 窗沿卧姿不变量主体（在 `buildAutonomousDecision` 最顶部调用，覆盖 autonomous=false 与全部空闲/
   * 活动路径；交互/拖拽/fall/外部反应优先级更高，不经过这里）。
   *
   * - 不在可坐窗沿 → 重置段计数，返回 null（交回常规逻辑）；
   * - 正在执行 followWindow（事件驱动、坐姿跟随）或 dropDown（唯一自主离开）→ 放行；
   * - 正在执行 sit → 正常续期；到点结束后段计数 +1；
   * - 执行任何其它活动（walkTo/returnCorner/lookAround/idle 变体/climb/sleep 等）→ 立即终止；
   * - 连续完成 ≥2 段后每段结束以 seeded random P=0.4 选择 dropDown（autonomous=false 不跳）；
   * - 否则**当帧**开始下一段 sit（显式绑定脚下表面，跳过随机池/冷却/GAP）→ 零站立帧。
   *
   * @returns null = 本帧不影响决策（非窗沿 / 正在执行放行类活动）
   */
  private maintainWindowTopRest(frame: Frame): DecisionCore | null {
    const surface = this.onSittableWindowTop(frame)
    if (!surface) {
      this.windowTopRestSegmentsCompleted = 0
      return null
    }
    // 窗沿卧姿优先于「落地后优先坐一次」的一次性反应：不变量已当帧开始卧姿，
    // 清掉 pending preferred 以免宠物离开窗沿后仍被旧表面拖去 sit-approach（陈旧偏好）。
    this.preferredActivityId = null
    this.preferredSurfaceId = null

    // (a) 正在执行的活动
    const activity = this.activity
    if (activity) {
      const id = activity.def.id
      if (id === 'followWindow') return null // 事件驱动：坐着跟窗口由 updateMovementActivity 保持 sit
      if (id === 'dropDown') return null // 唯一自主离开方式：放行到结束/进入 fall
      if (id === 'sit') {
        const core = this.updateActivity(frame) // 正常续 sit；到点 finishActivity 返回 null
        if (core) return core
        this.windowTopRestSegmentsCompleted += 1 // 完成一段 recumbent
      } else {
        // walkTo/returnCorner/lookAround/idle 变体/climb/sleep 等 → 窗沿上不允许，立即终止
        this.finishActivity(frame, 'interrupted')
      }
    }

    // (b) 受控离开：连续 ≥2 段后，每段结束以 seeded random P=0.4 选 dropDown（autonomous=false 不跳）
    if (
      frame.config.autonomous &&
      this.windowTopRestSegmentsCompleted >= WINDOW_TOP_REST_EXIT_MIN_SEGMENTS &&
      readRandom(frame.random) < WINDOW_TOP_REST_EXIT_PROBABILITY &&
      frame.elevated
    ) {
      const drop = findActivityDefinition('dropDown')
      if (drop) {
        this.windowTopRestSegmentsCompleted = 0
        this.startActivity(drop, frame, {}, true)
        return this.updateActivity(frame)
      }
    }

    // (c) 当帧开始下一段 recumbent：显式绑定脚下表面（N-2 口径），跳过随机池/冷却/GAP
    const sit = findActivityDefinition('sit')
    if (!sit) return null
    this.startActivity(
      sit,
      frame,
      {
        target: this.clampMotionTarget(
          { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
          frame
        ),
        surfaceId: surface.id,
        windowId: surface.windowId ?? null
      },
      frame.config.autonomous
    )
    return this.updateActivity(frame)
  }

  /* ---------------------------------------------------------------------- */
  /* 自主活动生命周期                                                         */
  /* ---------------------------------------------------------------------- */

  /** 加权抽取 + 准备目标；准备失败（目标表面消失等）会排除后重抽。 */
  /**
   * 站在可坐窗口上沿且空闲 ≥700ms → 自动坐下。
   *
   * - **N-1（自动坐下死循环修复）**：自动发起的 sit 结束后有一段强制间隔
   *   （`AUTO_SIT_GAP_MS` 20–40s，见 finishActivity）才允许再次自动坐，并尊重 sit 自身冷却；
   *   间隔内 `return null`，让常规活动抽取照常进行（不会只坐不做别的）。
   * - **N-2（选错表面修复）**：目标显式绑定脚下这块表面（旧实现走 `prepareActivity` 的
   *   「最近 3 个可坐表面随机」，可能把目标定到旁边另一块窗沿）。
   * - 宠物离开/切换到其他表面时重置间隔（下次被放到窗沿可立刻坐下）。
   *
   * 返回 null = 本帧不做额外处理。
   */
  private trySitOnWindowTop(frame: Frame): DecisionCore | null {
    const surface = frame.currentSurface
    const standingOnSittableWindowTop =
      frame.motion.grounded === true &&
      surface !== null &&
      surface.kind === 'window-top' &&
      surface.sittable === true
    if (!standingOnSittableWindowTop || surface === null) {
      this.windowTopIdleSinceMs = null
      // 离开窗沿/切换到其他表面 → 重置自动坐下间隔（若 GAP 曾推后 sit 冷却则恢复原值，
      // 这样「换个窗沿放上去」仍可立刻坐下，不会被上一块窗沿的 GAP 拖住）
      if (this.autoSitGapUntilMs !== null) this.restoreSitCooldown()
      this.autoSitGapUntilMs = null
      return null
    }
    // N-1：自动坐下间隔内不再自动坐（常规活动抽取不受影响）
    if (this.autoSitGapUntilMs !== null) {
      if (frame.nowMs < this.autoSitGapUntilMs) {
        this.windowTopIdleSinceMs = null
        return null
      }
      this.autoSitGapUntilMs = null
      this.sitCooldownRestoreMs = null
    }
    if (this.windowTopIdleSinceMs === null) {
      this.windowTopIdleSinceMs = frame.nowMs
      return null
    }
    if (frame.nowMs - this.windowTopIdleSinceMs < WINDOW_TOP_AUTO_SIT_DELAY_MS) return null
    const definition = findActivityDefinition('sit')
    if (!definition) return null
    // N-1：尊重 sit 冷却（旧实现无条件坐下，绕过了 cooldown）
    const cooldownUntil = this.cooldownUntilMs.get(definition.id)
    if (typeof cooldownUntil === 'number' && frame.nowMs < cooldownUntil) return null
    this.windowTopIdleSinceMs = null
    // N-2：显式绑定脚下这块表面（窗口本地 px）
    const prepared: PreparedActivity = {
      target: this.clampMotionTarget(
        { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
        frame
      ),
      surfaceId: surface.id,
      windowId: surface.windowId ?? null
    }
    this.startActivity(definition, frame, prepared, true)
    return this.updateActivity(frame)
  }

  /** 恢复被自动坐下 GAP 推后的 sit 冷却（N-1）。 */
  private restoreSitCooldown(): void {
    if (this.sitCooldownRestoreMs === null) return
    const current = this.cooldownUntilMs.get('sit')
    const restore = this.sitCooldownRestoreMs
    this.sitCooldownRestoreMs = null
    if (typeof current === 'number' && Number.isFinite(restore) && current > restore) {
      this.cooldownUntilMs.set('sit', restore)
    }
  }

  /**
   * 请求「立刻坐到某个窗沿」：集成层把宠物直接吸附到可坐窗沿上后调用，
   * 下一帧 B1 直接开始 sit 活动（跳过落地延迟 / 自主开关门控）。
   */
  requestSitOnSurface(surfaceId: string): void {
    if (typeof surfaceId !== 'string' || surfaceId.length === 0) return
    this.immediateSitSurfaceId = surfaceId
  }

  /**
   * 消费「立刻坐下」请求：要求当前帧已 grounded 在该表面且表面可坐；否则保留请求等下一帧。
   * 直接以非自主活动启动 sit（不经过 `preferredActivityId` 的 250/450ms 延迟）。
   */
  private consumeImmediateSit(frame: Frame): DecisionCore | null {
    const surfaceId = this.immediateSitSurfaceId
    if (surfaceId === null) return null
    if (frame.motion.grounded !== true || frame.motion.surfaceId !== surfaceId) return null
    const surface = frame.surfaces.find((item) => item.id === surfaceId) ?? null
    if (!surface || surface.sittable !== true) return null
    const definition = findActivityDefinition('sit')
    if (!definition) return null
    this.immediateSitSurfaceId = null
    this.cancelAutonomousActivity()
    this.fallState = null
    this.preferredActivityId = null
    this.preferredSurfaceId = null
    // 集成层已把脚底 x 钳进可坐区间 → 这里只需保证目标落在表面矩形内，即可当帧到位。
    const minCenterX = surface.rect.x
    const maxCenterX = surface.rect.x + surface.rect.width
    const targetX =
      maxCenterX >= minCenterX
        ? Math.min(maxCenterX, Math.max(minCenterX, frame.feet.x))
        : surface.rect.x + surface.rect.width / 2
    const prepared: PreparedActivity = {
      target: this.clampMotionTarget({ x: targetX, y: surface.top }, frame),
      surfaceId: surface.id,
      windowId: surface.windowId ?? null
    }
    // autonomous=false：这是对用户放置操作的直接反应，只执行这一次活动。
    this.startActivity(definition, frame, prepared, false)
    return this.updateActivity(frame)
  }

  /**
   * 消费「落地/放到窗沿」的直接反应（`sit` / `dropDown`），即使 `autonomous=false` 也执行一次。
   *
   * 与自主加权抽取不同：这是对用户「把宠物放到窗口上」操作的即时反馈，不属于随机漫游
   *（2026-11-10 修复：旧实现只在 autonomous=true 时消费，导致关闭自主后落在窗沿上只站着）。
   */
  private consumePreferredWindowTopReaction(frame: Frame): DecisionCore | null {
    const preferredId = this.preferredActivityId
    if (preferredId !== 'sit' && preferredId !== 'dropDown') return null
    const preferredSurfaceId = this.preferredSurfaceId
    this.preferredActivityId = null
    this.preferredSurfaceId = null
    const preferred = findActivityDefinition(preferredId)
    if (!preferred) return null
    const prepared = this.preparePreferredActivity(preferred, preferredSurfaceId, frame)
    if (!prepared) return null
    // autonomous=false：只完成这一次直接反应，不续排后续自主活动。
    this.startActivity(preferred, frame, prepared, false)
    return this.updateActivity(frame)
  }

  /**
   * 落地后优先活动的准备（N-2）：`sit` 显式绑定落地表面（surfaceId → 表面中心/顶层），
   * 不再走「最近 3 个可坐表面随机」；表面已消失/不是窗沿时回退常规 prepareActivity。
   */
  private preparePreferredActivity(
    definition: ActivityDefinition,
    surfaceId: string | null,
    frame: Frame
  ): PreparedActivity | null {
    if (definition.id === 'sit' && surfaceId) {
      const surface = frame.surfaces.find((item) => item.id === surfaceId) ?? null
      if (surface && surface.kind === 'window-top') {
        return {
          target: this.clampMotionTarget(
            { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
            frame
          ),
          surfaceId: surface.id,
          windowId: surface.windowId ?? null
        }
      }
    }
    return this.prepareActivity(definition, frame)
  }

  private pickAndStartActivity(frame: Frame): ActivityDefinition | null {
    const context = this.buildSchedulerContext(frame)
    const excluded = new Set<ActivityId>()
    // 窗沿卧姿不变量（调度层兜底）：可坐窗口上沿只允许 sit / dropDown，其余活动先整体排除，
    // 即使不变量层未来被改坏也不会在窗沿上产生站立/走动类活动。
    if (this.onSittableWindowTop(frame) !== null) {
      for (const definition of ACTIVITY_DEFINITIONS) {
        if (!WINDOW_TOP_REST_ALLOWED_ACTIVITIES.has(definition.id)) excluded.add(definition.id)
      }
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const definition = pickWeightedActivity(context, frame.random, excluded)
      if (!definition) return null
      excluded.add(definition.id)
      const prepared = this.prepareActivity(definition, frame)
      if (!prepared) continue
      this.startActivity(definition, frame, prepared, true)
      return definition
    }
    return null
  }

  private startActivity(
    definition: ActivityDefinition,
    frame: Frame,
    prepared: PreparedActivity,
    autonomous: boolean
  ): void {
    const now = frame.nowMs
    const duration = randomInt(frame.random, definition.minDurationMs, definition.maxDurationMs)
    this.cooldownUntilMs.set(definition.id, now + definition.cooldownMs)
    const path = prepared.path && prepared.path.length > 0 ? prepared.path.map((step) => ({ ...step })) : null
    this.activity = {
      def: definition,
      startedAtMs: now,
      endsAtMs: now + Math.max(definition.minDurationMs, duration),
      autonomous,
      target: prepared.target ?? path?.[0]?.target ?? null,
      path,
      pathIndex: 0,
      surfaceId: prepared.surfaceId ?? null,
      windowId: prepared.windowId ?? null,
      lookPoint: prepared.lookPoint ?? null,
      arriveSit: prepared.arriveSit ?? definition.arriveSit === true,
      arrived: false,
      seated: false,
      previousSitting: prepared.previousSitting === true,
      dropRequested: false
    }
    this.nextActivityAtMs = null
    this.lastStartedActivityId = definition.id
    if (definition.bubblePool === 'idle') this.tryEmitBubble(frame, 'idle')
  }

  private finishActivity(frame: Frame, reason: FinishReason): void {
    const finished = this.activity
    if (!finished) return
    this.activity = null
    // N-1：自动发起的坐姿结束后进入强制间隔（20–40s），避免「坐完 700ms 又坐」的死循环。
    // 间隔内只允许其它常规活动抽取：同时把 sit 冷却推到间隔结束，堵住「随机抽到 sit 又立刻坐下」。
    // 2026-11-10 窗沿卧姿不变量：可坐窗口上沿上由 maintainWindowTopRest 当帧续下一段 recumbent，
    // **不设 standing gap**（GAP 只保留给非窗沿场景）。
    if (
      finished.def.id === 'sit' &&
      finished.autonomous &&
      this.onSittableWindowTop(frame) === null
    ) {
      const gapEndMs =
        frame.nowMs + randomInt(frame.random, AUTO_SIT_GAP_MS.min, AUTO_SIT_GAP_MS.max)
      this.autoSitGapUntilMs = gapEndMs
      const sitCooldownUntil = this.cooldownUntilMs.get(finished.def.id) ?? Number.NEGATIVE_INFINITY
      if (gapEndMs > sitCooldownUntil) {
        this.sitCooldownRestoreMs = Number.isFinite(sitCooldownUntil) ? sitCooldownUntil : null
        this.cooldownUntilMs.set(finished.def.id, gapEndMs)
      }
    }
    if (!this.lastConfig.autonomous) {
      this.nextActivityAtMs = null
      return
    }
    // 跟随窗口结束后恢复原坐姿（窗口移动时正在窗沿上坐着 → 继续坐着，而不是站起来）
    if (finished.def.id === 'followWindow' && finished.previousSitting && finished.surfaceId) {
      const sitDefinition = findActivityDefinition('sit')
      const surface = frame.surfaces.find((item) => item.id === finished.surfaceId) ?? null
      if (sitDefinition && surface) {
        this.startActivity(
          sitDefinition,
          frame,
          {
            target: this.clampPointToWorkArea(
              { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
              frame.workArea
            ),
            surfaceId: surface.id,
            windowId: surface.windowId ?? null
          },
          false
        )
        return
      }
    }
    const pace = LEVEL_PACE[frame.config.autonomousLevel] ?? LEVEL_PACE.normal
    const delay =
      reason === 'interrupted'
        ? randomInt(frame.random, INTERACTION_RECOVER_MS.min, INTERACTION_RECOVER_MS.max)
        : randomInt(frame.random, pace.idleDelayMs[0], pace.idleDelayMs[1])
    this.nextActivityAtMs = frame.nowMs + delay
  }

  /** 取消当前活动（交互/外部反应/窗口事件打断时调用），不安排下一次计划。 */
  private cancelAutonomousActivity(): void {
    this.preferredActivityId = null
    this.preferredSurfaceId = null
    this.activity = null
    this.nextActivityAtMs = null
  }

  /**
   * 执行中活动的一帧更新。
   * @returns 决策核心；null = 活动已结束（调用方回 idle 基线）
   */
  private updateActivity(frame: Frame): DecisionCore | null {
    const activity = this.activity
    if (!activity) return null
    const definition = activity.def

    // 结束判定：实际时长不短于 minDuration（最短持续约束）
    if (frame.nowMs >= activity.endsAtMs) {
      this.finishActivity(frame, 'completed')
      return null
    }

    if (definition.id === 'sleep') {
      return {
        mood: 'sleep',
        motion: { kind: 'hold' },
        facing: frame.motion.facing,
        lookTarget: null,
        poseHint: definition.poseHint
      }
    }

    if (definition.id === 'dropDown') {
      return this.updateDropDownActivity(frame, activity)
    }

    if (definition.id === 'climb') {
      return this.updateClimbActivity(frame, activity)
    }

    if (definition.id === 'sit') {
      return this.updateSitActivity(frame, activity)
    }

    if (
      definition.id === 'walkTo' ||
      definition.id === 'returnCorner' ||
      definition.id === 'followWindow'
    ) {
      return this.updateMovementActivity(frame, activity)
    }

    // idle 变体 / lookAround：原地表演
    return {
      mood: definition.mood,
      motion: { kind: 'hold' },
      facing: this.idleFacing(frame),
      lookTarget: this.resolveLookTarget(frame, definition.look, activity.lookPoint),
      poseHint: definition.poseHint
    }
  }

  private updateDropDownActivity(frame: Frame, activity: RuntimeActivity): DecisionCore {
    if (!activity.dropRequested) {
      activity.dropRequested = true
      return {
        mood: 'fall',
        motion: { kind: 'drop' },
        facing: frame.motion.facing,
        lookTarget: null,
        poseHint: 'fall:jump'
      }
    }
    if (!frame.motion.airborne && frame.nowMs - activity.startedAtMs > 800) {
      this.finishActivity(frame, 'completed')
      this.landPoseUntilMs = frame.nowMs + LAND_POSE_HINT_MS
    }
    return {
      mood: 'fall',
      motion: { kind: 'hold' },
      facing: frame.motion.facing,
      lookTarget: null,
      poseHint: 'fall:jump'
    }
  }

  /**
   * 两段式攀爬（用户实机反馈「横着往上走很诡异」）：
   * 1) walk 段：水平走到目标窗口侧边「下方」（脚底保持当前支撑面高度）；
   * 2) climb 段：x 固定在窗口 rect 左/右边，**竖直向上**爬到 `{edgeX, surface.top + 6}`；
   * 3) 到位后改发 hold：B2 的 `CLIMB_SETTLE_SNAP_EPS_PX=24` 会把宠物吸附落到窗沿，
   *    x 仍保持在边缘（顶部中点留给独立的 sit 活动），活动随即结束 → idle 站在边缘。
   */
  private updateClimbActivity(frame: Frame, activity: RuntimeActivity): DecisionCore | null {
    const path = activity.path
    if (!path || path.length === 0) {
      this.finishActivity(frame, 'invalid')
      return null
    }
    // 目标窗沿消失（窗口关闭等）：交给 transitions/物理；这里兜底结束
    if (activity.surfaceId) {
      const surface = frame.surfaces.find((item) => item.id === activity.surfaceId) ?? null
      if (!surface) {
        this.finishActivity(frame, 'invalid')
        return null
      }
    }
    // 安全上限：路径异常/超长时结束，避免活动永不结束
    if (frame.nowMs - activity.startedAtMs > CLIMB_ACTIVITY_MAX_MS) {
      this.finishActivity(frame, 'invalid')
      return null
    }
    // 距离远时按路径动态续期，避免走/爬到一半因 maxDuration 到点而松手掉落
    activity.endsAtMs = Math.max(activity.endsAtMs, frame.nowMs + CLIMB_ACTIVITY_EXTEND_MS)

    let step = path[Math.min(activity.pathIndex, path.length - 1)]
    let stepTarget = this.clampMotionTarget(step.target, frame)
    if (distance(frame.feet, stepTarget) <= ARRIVE_EPSILON_PX) {
      if (activity.pathIndex < path.length - 1) {
        activity.pathIndex += 1
        step = path[activity.pathIndex]
        stepTarget = this.clampMotionTarget(step.target, frame)
      } else {
        // 最后一段到位 → 改发 hold 交给 B2 吸附落座；活动结束（不转到顶部中点）
        this.finishActivity(frame, 'completed')
        return {
          mood: 'idle',
          motion: { kind: 'hold' },
          facing: this.idleFacing(frame),
          lookTarget: frame.lookTarget,
          poseHint: undefined
        }
      }
    }

    const pace = LEVEL_PACE[frame.config.autonomousLevel] ?? LEVEL_PACE.normal
    if (step.mode === 'walk') {
      // 第一段：水平走到窗口侧边下方；facing 与水平运动方向一致
      return {
        mood: 'walk',
        motion: {
          kind: 'moveTo',
          target: { x: stepTarget.x, y: stepTarget.y },
          speedPxPerSec: pace.walkSpeedPxPerSec,
          mode: 'walk'
        },
        facing: facingTowards(frame.feet, stepTarget, frame.motion.facing),
        lookTarget: null,
        poseHint: 'climb:approach'
      }
    }

    // 第二段：沿窗口边缘竖直上爬（x 固定）；朝向窗口内侧，B2 的 facing 仅姿态语义
    const surface = activity.surfaceId
      ? (frame.surfaces.find((item) => item.id === activity.surfaceId) ?? null)
      : null
    const facing: Facing = surface
      ? frame.feet.x < surface.rect.x + surface.rect.width / 2
        ? 'right'
        : 'left'
      : frame.motion.facing
    return {
      mood: 'climb',
      motion: {
        kind: 'moveTo',
        target: { x: stepTarget.x, y: stepTarget.y },
        speedPxPerSec: pace.climbSpeedPxPerSec,
        mode: 'climb'
      },
      facing,
      lookTarget: null,
      poseHint: 'climb:window'
    }
  }

  private updateSitActivity(frame: Frame, activity: RuntimeActivity): DecisionCore | null {
    const surfaceId = activity.surfaceId
    if (!surfaceId) {
      this.finishActivity(frame, 'invalid')
      return null
    }
    const surface = frame.surfaces.find((item) => item.id === surfaceId) ?? null
    if (!surface) {
      // 窗口关闭等导致表面消失：交给 transitions/物理；这里兜底结束，避免坐空气
      this.finishActivity(frame, 'invalid')
      return null
    }
    if (frame.motion.grounded && frame.motion.surfaceId === surfaceId) {
      activity.seated = true
    }
    return {
      mood: 'sit',
      motion: activity.seated ? { kind: 'hold' } : { kind: 'sit', surfaceId },
      facing: this.idleFacing(frame),
      lookTarget: this.resolveLookTarget(frame, activity.def.look, activity.lookPoint),
      poseHint: activity.def.poseHint
    }
  }

  private updateMovementActivity(frame: Frame, activity: RuntimeActivity): DecisionCore | null {
    const definition = activity.def

    // 事件驱动「跟随窗口」：之前坐着 → 直接下发新的 sit 目标（B2 负责平滑移动）
    if (definition.id === 'followWindow' && activity.previousSitting && activity.surfaceId) {
      const surface = frame.surfaces.find((item) => item.id === activity.surfaceId) ?? null
      if (surface) {
        return {
          mood: 'sit',
          motion: { kind: 'sit', surfaceId: surface.id },
          facing: this.idleFacing(frame),
          lookTarget: this.resolveLookTarget(frame, definition.look, activity.lookPoint),
          poseHint: 'sit:window'
        }
      }
    }

    // H-3b：movement 活动（walkTo/returnCorner/followWindow）目标统一经可达范围钳制
    const target = activity.target ? this.clampMotionTarget(activity.target, frame) : null
    if (!target) {
      this.finishActivity(frame, 'invalid')
      return null
    }
    const deltaX = target.x - frame.feet.x
    const deltaY = target.y - frame.feet.y
    const remaining = Math.hypot(deltaX, deltaY)

    if (!activity.arrived && remaining <= ARRIVE_EPSILON_PX) {
      activity.arrived = true
      if (definition.arriveSit && activity.surfaceId) {
        const surface = frame.surfaces.find((item) => item.id === activity.surfaceId) ?? null
        if (surface?.sittable) activity.seated = true
      }
    }

    if (!activity.arrived) {
      // H-3b：仅在已知 B2 可达区间（motionLimits）时按路径动态续期——到达前每帧把 endsAt 推到
      // now + 2.5s，避免远距离目标（如从屏幕左侧回右下角 > 活动 maxDuration）走到一半就结束。
      // 只按「水平」剩余距离续期：walk 模式只水平走（y 由 B2 支撑吸附），像「站在窗沿上回角落」
      // 这种 y 永远对不上的目标不应无限续期（否则会在原地僵到 45s 安全上限）。
      // 无 motionLimits 时保持旧时长口径（目标可能不可达，续期会变成长时间原地走墙）。
      if (frame.motionLimits && Math.abs(deltaX) > ARRIVE_EPSILON_PX) {
        if (frame.nowMs - activity.startedAtMs > MOVEMENT_ACTIVITY_MAX_MS) {
          this.finishActivity(frame, 'invalid')
          return null
        }
        activity.endsAtMs = Math.max(activity.endsAtMs, frame.nowMs + MOVEMENT_ACTIVITY_EXTEND_MS)
      }
      const pace = LEVEL_PACE[frame.config.autonomousLevel] ?? LEVEL_PACE.normal
      // 通用移动活动一律水平 walk：竖直方向由 B2 的「同窗口垂直移动自动吸附 top」处理；
      // 需要沿窗口边缘上爬的只有 climb 活动（两段式，见 updateClimbActivity），
      // 避免「斜着直接穿到窗口顶部中点」的诡异路径（用户实机反馈）。
      return {
        mood: definition.mood,
        motion: {
          kind: 'moveTo',
          target: { x: target.x, y: target.y },
          speedPxPerSec: pace.walkSpeedPxPerSec,
          mode: 'walk'
        },
        facing: facingTowards(frame.feet, target, frame.motion.facing),
        lookTarget: null,
        poseHint: definition.poseHint
      }
    }

    // 到达：爬窗沿 → 坐在沿上；其余 → 站定（继续占满本次活动时长）
    if (activity.seated && activity.surfaceId) {
      return {
        mood: 'sit',
        motion: { kind: 'hold' },
        facing: this.idleFacing(frame),
        lookTarget: this.resolveLookTarget(frame, definition.look, activity.lookPoint),
        poseHint: 'sit:window'
      }
    }
    return {
      mood: 'idle',
      motion: { kind: 'hold' },
      facing: this.idleFacing(frame),
      lookTarget: frame.lookTarget,
      poseHint: undefined
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 活动目标准备（surface / 远点 / 角落）                                     */
  /* ---------------------------------------------------------------------- */

  /** 为活动准备目标；`null` = 当前环境无法准备（调用方排除后重抽）。 */
  private prepareActivity(definition: ActivityDefinition, frame: Frame): PreparedActivity | null {
    switch (definition.id) {
      case 'walkTo':
        return this.prepareWalkTarget(frame)
      case 'returnCorner':
        return { target: this.cornerPoint(frame) }
      case 'climb':
        return this.prepareClimbTarget(frame)
      case 'sit':
        return this.prepareSitTarget(frame)
      case 'idleGaze':
      case 'lookAround':
        return { lookPoint: this.prepareFarLookPoint(frame) }
      case 'sleep':
      case 'dropDown':
      case 'followWindow':
        return {}
      default:
        return {}
    }
  }

  /** 在当前所站表面上随机选一个 x（窗口上沿太窄时不走）。 */
  private prepareWalkTarget(frame: Frame): PreparedActivity | null {
    const workArea = frame.workArea
    const surface = frame.currentSurface
    // 窗沿卧姿不变量（调度层兜底）：可坐窗口上沿禁止走动；唯一自主离开方式是受控 dropDown。
    if (surface && surface.kind === 'window-top' && surface.sittable === true) return null
    const groundY = workArea.y + workArea.height
    let minX = workArea.x + 32
    let maxX = workArea.x + workArea.width - 32
    let targetY = groundY

    if (surface && surface.kind !== 'screen-bottom') {
      const rect = surface.rect
      minX = Math.max(minX, rect.x + 16)
      maxX = Math.min(maxX, rect.x + Math.max(0, rect.width) - 16)
      targetY = surface.top
      if (maxX - minX < MIN_SURFACE_WALK_SPAN_PX) return null
    } else if (surface && surface.kind === 'screen-bottom') {
      targetY = surface.top > 0 ? surface.top : groundY
    }

    // H-3b：可走区间与 B2 可达区间求交（表面靠边时目标不再落进墙内不可达带）
    if (frame.motionLimits) {
      minX = Math.max(minX, frame.motionLimits.minX)
      maxX = Math.min(maxX, frame.motionLimits.maxX)
    }

    const span = maxX - minX
    if (!(span > 0)) return null
    let targetX = minX + readRandom(frame.random) * span
    // 目标离当前太近 → 推向更远的一侧，避免原地踱步
    if (Math.abs(targetX - frame.feet.x) < 80 && span > 160) {
      targetX =
        targetX < frame.feet.x ? Math.min(maxX, frame.feet.x + 120) : Math.max(minX, frame.feet.x - 120)
    }
    return { target: this.clampMotionTarget({ x: targetX, y: targetY }, frame) }
  }

  /** 爬窗沿：优先爬上方最近的窗口上沿，其次可爬边缘。 */
  /**
   * 爬窗沿目标点算法（两段式；用户实机反馈后定稿）：
   * 1) 候选：脚下的上方 `window-top` 表面 + B5 提供的 `climbable` 表面（menubar 已在帧构建时排除）；
   * 2) 边缘 x：`window-top` 取 rect 左/右边中离脚底更近的一侧；`window-side` 取 rect 中心 x；
   *    再钳制到 workArea 内并留 8px 边距；
   * 3) 第一段 waypoint：`{edgeX, 当前脚底 y}`，`mode='walk'`（水平走到侧边下方）；
   * 4) 第二段 waypoint：`{edgeX, surface.top + 6}`，`mode='climb'`（x 固定、y 逐步减少、慢速上爬）；
   * 5) 候选排序按「横向接近距离 + 竖直爬升距离」从近到远，避免绕远路。
   * 落点不是窗口顶部中点（中点属于 sit 活动），这样不会出现横着斜穿的诡异路径。
   */
  private prepareClimbTarget(frame: Frame): PreparedActivity | null {
    const workArea = frame.workArea
    const candidates: DesktopSurface[] = []
    const seenIds = new Set<string>()
    for (const surface of frame.windowTopSurfacesAbove) {
      if (seenIds.has(surface.id)) continue
      seenIds.add(surface.id)
      candidates.push(surface)
    }
    for (const surface of frame.climbableSurfaces) {
      if (seenIds.has(surface.id)) continue
      if (surface.kind === 'menubar') continue
      seenIds.add(surface.id)
      candidates.push(surface)
    }
    if (candidates.length === 0) return null

    const riseMin = frame.feet.y - CLIMB_MIN_RISE_PX
    const climbOptions: Array<{
      surface: DesktopSurface
      edgeX: number
      approach: Point2D
      ascend: Point2D
      cost: number
    }> = []
    for (const surface of candidates) {
      const ascendY = surface.top
      if (!(ascendY < riseMin)) continue // 爬升高度不足/要往下爬 → 不选
      let edgeX: number
      if (surface.kind === 'window-side') {
        edgeX = surface.rect.x + surface.rect.width / 2
      } else {
        const leftEdge = surface.rect.x
        const rightEdge = surface.rect.x + surface.rect.width
        edgeX =
          Math.abs(frame.feet.x - leftEdge) <= Math.abs(frame.feet.x - rightEdge)
            ? leftEdge
            : rightEdge
      }
      edgeX = clampNumber(
        edgeX,
        workArea.x + CLIMB_EDGE_MARGIN_PX,
        workArea.x + workArea.width - CLIMB_EDGE_MARGIN_PX,
        edgeX
      )
      // 第一段：走到「侧边下方」——y 保持当前脚底高度（B2 walk 会钉在当前支撑面 top）
      const approach = this.clampMotionTarget({ x: edgeX, y: frame.feet.y }, frame)
      // 第二段：沿边缘竖直上爬到 top+6（到位后 hold → B2 吸附落到窗沿，x 仍在边缘）
      const ascend = this.clampMotionTarget(
        { x: edgeX, y: surface.top + CLIMB_EDGE_STOP_OFFSET_PX },
        frame
      )
      const horizontalApproach = Math.abs(approach.x - frame.feet.x)
      const verticalClimb = Math.abs(ascend.y - approach.y)
      climbOptions.push({
        surface,
        edgeX,
        approach,
        ascend,
        cost: horizontalApproach + verticalClimb * 0.75
      })
    }
    if (climbOptions.length === 0) return null
    climbOptions.sort((left, right) => left.cost - right.cost)
    const chosen = climbOptions[0]

    return {
      target: chosen.approach,
      path: [
        { target: chosen.approach, mode: 'walk' },
        { target: chosen.ascend, mode: 'climb' }
      ],
      surfaceId: chosen.surface.id,
      windowId: chosen.surface.windowId ?? null,
      arriveSit: false
    }
  }

  /** 坐窗沿：最近的 3 个可坐表面里随机一个（窗口越多选择越多）。 */
  private prepareSitTarget(frame: Frame): PreparedActivity | null {
    if (frame.sittableSurfaces.length === 0) return null
    const sorted = frame.sittableSurfaces
      .slice()
      .sort((left, right) => this.surfaceDistance(left, frame.feet) - this.surfaceDistance(right, frame.feet))
    const limit = Math.min(3, sorted.length)
    const index = Math.min(limit - 1, Math.floor(readRandom(frame.random) * limit))
    const surface = sorted[index]
    const target = this.clampPointToWorkArea(
      { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
      frame.workArea
    )
    return { target, surfaceId: surface.id, windowId: surface.windowId ?? null }
  }

  /** 「望远处」注视点：屏幕左/右半区偏上，落在 workArea 内。 */
  private prepareFarLookPoint(frame: Frame): Point2D | null {
    const workArea = frame.workArea
    const side = readRandom(frame.random) < 0.5 ? -1 : 1
    const x = frame.feet.x + side * randomRange(frame.random, 260, 640)
    const y = workArea.y + workArea.height * randomRange(frame.random, 0.12, 0.44)
    return this.clampPointToWorkArea({ x, y }, workArea)
  }

  /**
   * 「回到角落」目标（H-3b）：旧实现取 `workArea.right - margin`，会落进 B2 不可达带
   * （宠物半宽不进墙 → 目标永远走不到），活动卡在走路姿态。现统一经可达范围钳制。
   */
  private cornerPoint(frame: Frame): Point2D {
    const workArea = frame.workArea
    const margin = clampNumber(
      Math.min(workArea.width, workArea.height) * 0.02,
      8,
      32,
      8
    )
    return this.clampMotionTarget(
      { x: workArea.x + workArea.width - margin, y: workArea.y + workArea.height },
      frame
    )
  }

  private surfaceDistance(surface: DesktopSurface, feet: Point2D): number {
    return distance(
      { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
      feet
    )
  }

  /* ---------------------------------------------------------------------- */
  /* 窗口跟随                                                                 */
  /* ---------------------------------------------------------------------- */

  private findFollowSurface(frame: Frame, windowId: number): DesktopSurface | null {
    const previousId = this.trackedSupport?.surfaceId
    if (previousId) {
      const previous = frame.surfaces.find((surface) => surface.id === previousId)
      if (previous) return previous
    }
    return (
      frame.surfaces.find(
        (surface) => surface.windowId === windowId && surface.kind === 'window-top'
      ) ??
      frame.surfaces.find((surface) => surface.windowId === windowId) ??
      null
    )
  }

  /** 窗口移动 → 事件驱动跟随活动（保持原坐/站姿态，B2 负责平滑移动）。 */
  private startFollowActivity(frame: Frame, surface: DesktopSurface): void {
    const previousSitting =
      this.activity?.seated === true || this.activity?.def.id === 'sit' || this.currentMood === 'sit'
    const definition = findActivityDefinition('followWindow')
    if (!definition) return
    this.cancelAutonomousActivity()
    this.startActivity(
      definition,
      frame,
      {
        target: this.clampMotionTarget(
          { x: surface.rect.x + surface.rect.width / 2, y: surface.top },
          frame
        ),
        surfaceId: surface.id,
        windowId: surface.windowId ?? null,
        previousSitting
      },
      false
    )
  }

  /* ---------------------------------------------------------------------- */
  /* 调度上下文 / 注视 / 朝向 / 工具                                          */
  /* ---------------------------------------------------------------------- */

  private buildSchedulerContext(frame: Frame): SchedulerContext {
    const sinceExternalEndMs =
      this.lastExternalEndMs === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, frame.nowMs - this.lastExternalEndMs)
    const idleElapsedMs = this.idleSinceMs === null ? 0 : Math.max(0, frame.nowMs - this.idleSinceMs)
    const sinceInteractionMs =
      this.lastInteractionAtMs === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, frame.nowMs - this.lastInteractionAtMs)

    return {
      nowMs: frame.nowMs,
      autonomousLevel: frame.config.autonomousLevel,
      workArea: frame.workArea,
      feet: frame.feet,
      grounded: frame.motion.grounded,
      surfaceKind: frame.currentSurface?.kind ?? null,
      sittableSurfaceCount: frame.sittableSurfaces.length,
      climbableSurfaceCount:
        frame.windowTopSurfacesAbove.length + frame.climbableSurfaces.length,
      windowCount: frame.windowCount,
      pointer: frame.pointer,
      hoveringPet: frame.interaction.hoveringPet,
      pointerNear: frame.pointerNear,
      mouseAway: frame.mouseAway,
      idleElapsedMs,
      sinceInteractionMs,
      sinceExternalEndMs: Math.min(sinceExternalEndMs, EXTERNAL_SETTLE_MS),
      newWindowBias: frame.nowMs < this.newWindowBiasUntilMs,
      lastActivityId: this.lastStartedActivityId,
      cooldownUntilMs: this.cooldownUntilMs,
      elevated: frame.elevated
    }
  }

  private resolveLookTarget(
    frame: Frame,
    mode: LookMode,
    fixedPoint: Point2D | null
  ): Point2D | null {
    if (mode === 'none') return null
    if (mode === 'randomFar') {
      return fixedPoint ? this.clampPointToWorkArea(fixedPoint, frame.workArea) : null
    }
    // M-11：沿视线跟随 B4 LookTracker 平滑后的目标（缺省 = pointer）。
    return frame.lookTarget
  }

  private idleFacing(frame: Frame): Facing {
    const pointer = frame.pointer
    if (pointer && Math.abs(pointer.x - frame.feet.x) > 24) {
      return facingTowards(frame.feet, pointer, frame.motion.facing)
    }
    return frame.motion.facing
  }

  private clampPointToWorkArea(point: Point2D, workArea: Rect): Point2D {
    return {
      x: clampNumber(point.x, workArea.x, workArea.x + workArea.width, workArea.x),
      y: clampNumber(point.y, workArea.y, workArea.y + workArea.height, workArea.y)
    }
  }

  /**
   * 运动目标钳制（H-3b；所有下发给 B2 的 moveTo 目标的唯一入口）：
   * - y 仍按 workArea 钳制（与旧口径一致）；
   * - 有 `motionLimits` 时 x 钳进 B2 可达区间（左右各让出宠物半宽，B2 的 xRange），
   *   避免目标落在墙内不可达带 →「原地走 + 活动永不结束」；
   * - 无 `motionLimits` 时退回旧口径（workArea 全宽），保持旧测试/无运行时限制调用方兼容。
   */
  private clampMotionTarget(point: Point2D, frame: Frame): Point2D {
    const workArea = frame.workArea
    const y = clampNumber(point.y, workArea.y, workArea.y + workArea.height, workArea.y)
    const limits = frame.motionLimits
    if (!limits) {
      return {
        x: clampNumber(point.x, workArea.x, workArea.x + workArea.width, workArea.x),
        y
      }
    }
    return { x: clampNumber(point.x, limits.minX, limits.maxX, limits.minX), y }
  }

  private tryEmitBubble(frame: Frame, category: BubbleCategory): void {
    if (this.pendingBubble !== null) return
    const line = this.bubbleGate.tryEmit(category, frame.nowMs, frame.random)
    if (line !== null) this.pendingBubble = line
  }

  /* ---------------------------------------------------------------------- */
  /* 支撑跟踪 / 决策收尾 / 调试                                               */
  /* ---------------------------------------------------------------------- */

  /** 更新「脚底靠哪个表面支撑」的跟踪（供下一帧窗口 moved/closed 匹配）。 */
  private updateTrackedSupport(frame: Frame): void {
    if (this.fallState || this.dragging) return
    if (!frame.motion.grounded) return
    const surface = frame.currentSurface
    if (surface) {
      this.trackedSupport = {
        surfaceId: surface.id,
        windowId: surface.windowId ?? null,
        kind: surface.kind
      }
      return
    }
    if (frame.motion.surfaceId) {
      // 表面 id 存在但已不在桌面快照里（B5 未给 closed transition 的兜底）：按支撑丢失处理
      this.startFall(frame, { emitDrop: true, wasThrown: false, fromWindow: true })
      this.trackedSupport = null
      return
    }
    this.trackedSupport = null
  }

  private finalizeDecision(frame: Frame, core: DecisionCore): BehaviorDecision {
    if (core.mood !== this.currentMood || frame.nowMs < this.moodSinceMs) {
      this.currentMood = core.mood
      this.moodSinceMs = frame.nowMs
    }
    // H-5 修复：待机小动作/四处看属于「安静活动」，不打断 idle 基线累计。
    // 否则活动结束后的下一次抽取固定在 idleDelay（normal 8–18s / high 4.2–10s），
    // 永远小于 sleep 要求的 SLEEP_MIN_IDLE_MS=20s → 默认档 sleep 永不调度。
    const quietActivity =
      this.activity !== null &&
      (this.activity.def.idleVariant === true || this.activity.def.id === 'lookAround')
    const baselineIdle =
      core.mood === 'idle' &&
      (!this.activity || quietActivity) &&
      !this.reaction &&
      !this.activeExternal &&
      !this.dragging &&
      !this.fallState
    if (baselineIdle) {
      if (this.idleSinceMs === null) {
        this.idleSinceMs = frame.nowMs
        // H-5：记录「sleep 需求刚好满足」的抽取窗口（idle 达到 20s + 抖动）
        this.idleSleepWindowAtMs =
          frame.nowMs +
          SLEEP_MIN_IDLE_MS +
          randomInt(frame.random, SLEEP_WINDOW_JITTER_MS.min, SLEEP_WINDOW_JITTER_MS.max)
      }
    } else {
      this.idleSinceMs = null
      this.idleSleepWindowAtMs = null
    }

    const lookTarget = core.lookTarget
      ? this.clampPointToWorkArea(core.lookTarget, frame.workArea)
      : null
    const decision: BehaviorDecision = {
      mood: core.mood,
      motion: core.motion,
      facing: core.facing,
      lookTarget,
      bubble: this.pendingBubble
    }
    if (core.poseHint !== undefined) decision.poseHint = core.poseHint
    return decision
  }

  private describeActivity(): string {
    if (this.dragging) return 'drag'
    if (this.reaction) return 'pat'
    if (this.fallState) return 'fall'
    if (this.activeExternal) return this.activeExternal.mood
    if (this.activity) return this.activity.def.debugId
    return 'idle'
  }

  private describeAutonomous(): boolean {
    if (this.dragging || this.reaction || this.fallState || this.activeExternal) return false
    if (this.activity) return this.activity.autonomous
    return this.lastConfig.autonomous
  }

  private computeNextActivityInMs(nowMs: number): number | null {
    if (!this.lastConfig.autonomous) return null
    if (this.activity || this.dragging || this.reaction || this.fallState || this.activeExternal) {
      return null
    }
    if (this.nextActivityAtMs === null) return null
    return Math.max(0, Math.round(this.nextActivityAtMs - nowMs))
  }

  private countCooldowns(nowMs: number): number {
    const context: SchedulerContext = {
      nowMs,
      autonomousLevel: this.lastConfig.autonomousLevel,
      workArea: DEFAULT_WORK_AREA,
      feet: { x: 0, y: 0 },
      grounded: false,
      surfaceKind: null,
      sittableSurfaceCount: 0,
      climbableSurfaceCount: 0,
      windowCount: 0,
      pointer: null,
      hoveringPet: false,
      pointerNear: false,
      mouseAway: true,
      idleElapsedMs: 0,
      sinceInteractionMs: Number.POSITIVE_INFINITY,
      sinceExternalEndMs: Number.POSITIVE_INFINITY,
      newWindowBias: false,
      lastActivityId: null,
      cooldownUntilMs: this.cooldownUntilMs,
      elevated: false
    }
    return countCoolingActivities(context)
  }

  /** 从未 update 过时 `triggerActivity` 的兜底上下文（无桌面表面）。 */
  private createNeutralFrame(nowMs: number): Frame {
    const workArea = { ...DEFAULT_WORK_AREA }
    const motion: MotionSnapshot = {
      feet: { x: workArea.x + workArea.width / 2, y: workArea.y + workArea.height },
      velocity: { x: 0, y: 0 },
      facing: 'front',
      grounded: true,
      surfaceId: null,
      airborne: false
    }
    const desktop: DesktopSnapshot = {
      surfaces: [],
      transitions: [],
      workArea,
      screenBounds: { ...workArea }
    }
    return {
      nowMs,
      dt: 0,
      motion,
      desktop,
      surfaces: [],
      sittableSurfaces: [],
      climbableSurfaces: [],
      windowTopSurfacesAbove: [],
      currentSurface: null,
      interaction: { pointer: null, hoveringPet: false, dragging: false, patProgress: 0 },
      events: [],
      external: null,
      config: { ...DEFAULT_CONFIG },
      random: sanitizeRandom(this.randomSource),
      workArea,
      motionLimits: null,
      feet: motion.feet,
      pointer: null,
      lookTarget: null,
      pointerNear: false,
      mouseAway: true,
      elevated: false,
      windowCount: 0
    }
  }
}
