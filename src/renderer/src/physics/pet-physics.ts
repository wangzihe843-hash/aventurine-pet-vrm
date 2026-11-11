/**
 * B2 运动与物理 —— `PetPhysics`（纯逻辑、注入时钟、不 import three/DOM/Electron）。
 *
 * ## 职责
 * 把 B1 的 `MotionCommand`（hold/moveTo/sit/drop/teleport）与 B4 的拖拽事件
 * 变成每帧 `MotionSnapshot`：feet（唯一位置权威）/ velocity / facing / grounded /
 * surfaceId / airborne。重力、地面摩擦、左右墙 clamp 与小反弹、落在窗口上沿 /
 * 菜单栏 / Dock 顶边、拖拽平滑跟随、甩出速度估计都在这里完成。
 *
 * ## 坐标系与单位
 * - `workArea` / `feet` / `pointer` 一律 **overlay 窗口本地 CSS 像素**（左上原点、y 向下）；
 * - dt 单位秒、nowMs 单位毫秒（只用于指针速度估计），速度 px/s、重力 px/s²；
 * - 宠物矩形由 Lead 用 `feet` 推出（`x = feet.x - width/2`、`y = feet.y - height`），
 *   本模块不关心模型宽高比，只用 `petSize.width / 2` 做水平碰撞/边界。
 *
 * ## 每帧顺序（Lead 接线）
 * `setEnvironment(desktop)`（几何/表面变化每帧均可调）→ `setCommand(decision.motion)` →
 * `step(dt, now)` → 用返回快照摆放宠物。拖拽：`beginDrag → dragTo… → endDrag`。
 *
 * ## 状态语义
 * - `grounded=true`：站在地面 / 窗口上沿 / 菜单栏 / Dock 上（surfaceId 对应表面 id；
 *   B5 未提供 screen-bottom 表面时地面 id 为 {@link IMPLICIT_GROUND_SURFACE_ID}）；
 * - `airborne=true`：自由落体/被甩飞中（受重力，左右墙可小反弹）；
 * - 攀爬（`moveTo.mode='climb'`）是第三种状态：`grounded=false && airborne=false`
 *   （沿目标点 2D 受控位移、不受重力；松手/换指令后回到自由落体）；
 * - 拖拽中：`grounded=false && airborne=false`（B3 通过 AnimationInput.dragging 表现）；
 *   V7：`beginDrag` 时若 facing='front' 会切到侧向（{@link DRAG_START_FACING}），拖动中按
 *   水平速度方向更新朝向；落地后由行为层（静止 → front）自然回正。
 */
import type { Rect } from '@shared/types'

import type {
  DesktopSurface,
  Facing,
  MotionCommand,
  MotionSnapshot,
  PetSize,
  Point2D
} from '../core/wave2-contract'

import {
  CEILING_RESTITUTION,
  CLIMB_SETTLE_SNAP_EPS_PX,
  DEFAULT_GRAVITY_PX_PER_SEC2,
  DEFAULT_SIT_APPROACH_SPEED_PX_PER_SEC,
  DRAG_SMOOTHING_TAU_MS,
  DRAG_START_FACING,
  FACING_SPEED_EPS_PX_PER_SEC,
  GROUND_FRICTION_DAMPING_PER_SEC,
  GROUND_STOP_SPEED_PX_PER_SEC,
  IMPLICIT_GROUND_SURFACE_ID,
  LANDING_EPS_PX,
  MAX_STEP_DT_SEC,
  MOVE_ARRIVE_EPS_PX,
  PLACEMENT_MAX_DURATION_MS,
  PLACEMENT_MIN_DURATION_MS,
  PLACEMENT_SPEED_PX_PER_SEC,
  PLACEMENT_SURFACE_DROP_GAP_PX,
  RELEASE_SNAP_EPS_PX,
  RELEASE_SNAP_MAX_VY_PX_PER_SEC,
  SUPPORT_REMATCH_TOP_EPS_PX,
  TELEPORT_SNAP_EPS_PX,
  THROW_MAX_SPEED_PX_PER_SEC,
  WALL_BOUNCE_MIN_SPEED_PX_PER_SEC,
  WALL_RESTITUTION
} from './constants'
import { clampVelocityMagnitude, PointerVelocityTracker } from './pointer-velocity'
import {
  clampNumber,
  clonePoint,
  finitePositive,
  isFiniteNumber,
  isFinitePoint,
  isValidRect
} from './util'

/** `setEnvironment` / 构造参数里的环境（窗口本地坐标）。 */
export interface PhysicsEnvironment {
  /** overlay 窗口的本地工作区（通常 `{x:0,y:0,width,height}`，但不要假设原点为 0）。 */
  workArea: Rect
  /** 当前宠物尺寸（CSS px；宽度用于左右墙/表面横向碰撞）。 */
  petSize: PetSize
  /** B5 当前表面列表（每帧更新；顺序即 B5 前后序）。 */
  surfaces: readonly DesktopSurface[]
}

/** `PetPhysics` 构造参数。 */
export interface PhysicsOptions {
  workArea: Rect
  petSize: PetSize
  /** 重力加速度（px/s²；默认 2400，文档建议 2200–2600）。 */
  gravityPxPerSec2?: number
  /** 可选初始脚底点（默认 workArea 底边居中；Lead 可传 Wave 1 的右下角位置保持视觉连续）。 */
  initialFeet?: Point2D
  /** 可选初始表面列表（通常随后由 `setEnvironment` 每帧更新）。 */
  surfaces?: readonly DesktopSurface[]
  /** sit 接近速度覆盖（px/s；测试/手感调参用）。 */
  sitApproachSpeedPxPerSec?: number
  /** 拖拽平滑时间常数覆盖（ms；40–70 观感自然）。 */
  dragSmoothingTauMs?: number
}

/** `endDrag` 返回值（B4 InteractionEvent.dragEnd 消费）。 */
export interface DragEndResult {
  /** 释放后的初始速度（px/s；已按上限 clamp，可直接作为甩出速度）。 */
  throwVelocity: Point2D
}

/**
 * 「放置」目标（松手后由 `beginPlacement` 消费）：
 *
 * - `surface`：放到窗口上沿 → 平滑吸附后留 2px 落差交给正常自由落体；
 * - `anchor`：窗口上沿太高/被遮挡，不能坐着（全身会出屏）→ 站定在目标脚底点（不随重力下落、
 *   忽略移动指令），实现「放在窗口上就停住」。
 *
 * 坐标口径与 `feet` 相同（overlay 窗口本地 CSS px）。
 */
export type PlacementPlan =
  | {
      mode: 'surface'
      /** 落点表面 id（当前 `surfaces` 里的 `window-top`）。 */
      surfaceId: string
      /** 表面顶边 y（窗口本地 px；与 `DesktopSurface.top` 同口径）。 */
      top: number
      /** 吸附后的水平脚底点（y 由本模块按 `top` 处理）。 */
      feet: Point2D
    }
  | {
      mode: 'anchor'
      /** 站定脚底点（调用方保证在 workArea 内、且尽量让宠物全身可见）。 */
      feet: Point2D
    }

/** 内部运动模式（仅调试快照使用，不影响契约）。 */
export type PhysicsMode =
  | 'idle'
  | 'walk'
  | 'climb'
  | 'sit-approach'
  | 'sit'
  | 'drag'
  | 'air'
  | 'placing'
  | 'placed'

/** 额外调试快照（`window.__aventurineDebug.motion` 之外的补充；可选消费）。 */
export interface PhysicsDebugSnapshot {
  mode: PhysicsMode
  /** 当前指令类型（不用展开完整指令，避免调试面过大）。 */
  command: MotionCommand['kind']
  dragging: boolean
  climbing: boolean
  grounded: boolean
  airborne: boolean
  surfaceId: string | null
  gravityPxPerSec2: number
  /** 当前保留的甩出速度样本数（≤ THROW_MAX_SAMPLES，性能自检用）。 */
  pointerSamples: number
  /** 放置状态：none = 普通物理；placing = 放置过渡；anchored = 放在窗口上站定（不随重力下落）。 */
  placement: 'none' | 'placing' | 'anchored'
}

/** 可站立（可落）表面种类：窗口上沿 / 菜单栏 / Dock 顶边。地面单独处理（隐式或 screen-bottom）。 */
const STANDABLE_SURFACE_KINDS: readonly string[] = ['window-top', 'menubar', 'dock']

/** 是否是可落脚的表面（运行时防御：id/top/rect 都可能来自外部）。 */
function isStandableSurface(surface: DesktopSurface | null | undefined): surface is DesktopSurface {
  if (!surface || typeof surface !== 'object') return false
  return (
    typeof surface.id === 'string' &&
    surface.id.length > 0 &&
    STANDABLE_SURFACE_KINDS.includes(surface.kind) &&
    isFiniteNumber(surface.top) &&
    isValidRect(surface.rect)
  )
}

/** 表面落地优先级（同 top 时 Dock 优先于窗口上沿；用于确定性 tie-break）。 */
function surfacePriority(surface: DesktopSurface): number {
  switch (surface.kind) {
    case 'dock':
      return 3
    case 'window-top':
      return 2
    case 'menubar':
      return 1
    default:
      return 0
  }
}

/** 是否合法宠物尺寸（宽高有限且非负）。 */
function isValidPetSize(value: unknown): value is PetSize {
  if (!value || typeof value !== 'object') return false
  const size = value as PetSize
  return (
    isFiniteNumber(size.width) && size.width >= 0 && isFiniteNumber(size.height) && size.height >= 0
  )
}

/** 地面信息（缓存在每次 setEnvironment 后；id 可能是 B5 的 screen-bottom 表面 id）。 */
interface GroundInfo {
  id: string
  top: number
}

/**
 * 站立支撑的身份快照（D6a 段 id 抖动重匹配用）：
 * `DesktopSurface` 数组每帧整体替换，记下 windowId/kind/top 才能在旧 id 消失后按几何找回同一块表面。
 */
interface SupportHint {
  windowId?: number
  kind: DesktopSurface['kind']
  top: number
}

/** 放置过渡的进行中状态（完成前不受重力；完成后进入 grounded 或 anchored）。 */
interface PlacementState {
  mode: 'surface' | 'anchor'
  from: Point2D
  to: Point2D
  /** surface 模式的目标表面 id；anchor 模式为 null。 */
  surfaceId: string | null
  /** surface 模式的目标顶边 y；anchor 模式为 NaN（不使用）。 */
  top: number
  elapsedSec: number
  durationSec: number
}

/**
 * 运动与物理引擎（纯逻辑）。
 *
 * 复杂度：`step()` 每帧对表面列表做常数次线性扫描（S = 表面数，通常 <30），
 * 无历史累积/无增长型分配；指针样本数有硬上限，长时间拖拽内存恒定。
 */
export class PetPhysics {
  private workArea: Rect
  private surfaces: readonly DesktopSurface[]
  private ground: GroundInfo
  private halfWidthPx: number
  private readonly gravityPxPerSec2: number
  private readonly sitApproachSpeed: number
  private readonly dragTauSec: number

  private feet: Point2D
  private velocity: Point2D = { x: 0, y: 0 }
  private facing: Facing = 'front'
  private grounded = false
  private airborne = true
  private climbing = false
  private surfaceId: string | null = null
  /** 最近一次站稳的非地面支撑（D6a 段 id 失效时按 windowId/kind/top 重匹配）。 */
  private lastSupportHint: SupportHint | null = null
  private mode: PhysicsMode = 'idle'
  private command: MotionCommand = { kind: 'hold' }

  private dragging = false
  /** 抓取偏移：beginDrag 时 feet - pointer；之后 dragTarget = pointer + offset。 */
  private dragOffset: Point2D = { x: 0, y: 0 }
  private dragTarget: Point2D = { x: 0, y: 0 }
  private readonly velocityTracker: PointerVelocityTracker
  private lastNowMs = 0

  /** 放置过渡（松手后平滑移动到窗沿/站定点；完成前不受重力）。 */
  private placement: PlacementState | null = null
  /** 原地站定（窗沿太高/被遮挡时的「放在窗口上」状态：不随重力下落、忽略移动指令）。 */
  private anchored: Point2D | null = null
  /** 站定完成的一次性事件（B3 播放落地姿态用；`consumePlacementLanded` 取走即清）。 */
  private placementLanded = false

  constructor(options: PhysicsOptions) {
    const input = options ?? ({} as PhysicsOptions)
    this.workArea = isValidRect(input.workArea)
      ? { x: input.workArea.x, y: input.workArea.y, width: input.workArea.width, height: input.workArea.height }
      : { x: 0, y: 0, width: 0, height: 0 }
    const petSize = isValidPetSize(input.petSize) ? input.petSize : { width: 0, height: 0 }
    this.halfWidthPx = petSize.width / 2
    this.gravityPxPerSec2 = finitePositive(input.gravityPxPerSec2, DEFAULT_GRAVITY_PX_PER_SEC2)
    this.sitApproachSpeed = finitePositive(
      input.sitApproachSpeedPxPerSec,
      DEFAULT_SIT_APPROACH_SPEED_PX_PER_SEC
    )
    this.dragTauSec =
      finitePositive(input.dragSmoothingTauMs, DRAG_SMOOTHING_TAU_MS) / 1000
    this.surfaces = Array.isArray(input.surfaces) ? input.surfaces : []
    this.ground = this.resolveGround()

    const fallbackFeet: Point2D = {
      x: this.workArea.x + this.workArea.width / 2,
      y: this.ground.top
    }
    this.feet = this.clampPointToWorkArea(
      isFinitePoint(input.initialFeet) ? clonePoint(input.initialFeet) : fallbackFeet
    )
    this.velocityTracker = new PointerVelocityTracker()
    this.grounded = false
    this.airborne = true
    this.surfaceId = null
    this.mode = 'air'
    this.snapToSupportAtCurrentPosition(TELEPORT_SNAP_EPS_PX)
  }

  /* ------------------------------------------------------------------ */
  /* 对外 API（docs/wave2-integration.md §3-B2）                          */
  /* ------------------------------------------------------------------ */

  /**
   * 更新环境：workArea / petSize / 表面列表。**每帧调用**（或几何变化时调用）即可，
   * 内部 O(1)（不拷贝表面数组，使用时逐项校验）；几何变化后会立即重解支撑：
   * 站在窗口上沿时窗口垂直移动 → feet.y 吸附新 top；表面消失/横向移走 → 进入空中。
   */
  setEnvironment(env: PhysicsEnvironment): void {
    if (!env || typeof env !== 'object') return
    if (isValidRect(env.workArea)) {
      this.workArea = {
        x: env.workArea.x,
        y: env.workArea.y,
        width: env.workArea.width,
        height: env.workArea.height
      }
    }
    if (isValidPetSize(env.petSize)) {
      this.halfWidthPx = env.petSize.width / 2
    }
    if (Array.isArray(env.surfaces)) {
      this.surfaces = env.surfaces
    } else if (env.surfaces !== undefined) {
      this.surfaces = []
    }
    this.ground = this.resolveGround()
    this.feet = this.clampPointToWorkArea(this.feet)

    // 放置站定/过渡中：几何变化只做钳制（站定点跟随 workArea 边界），不触发支撑重解。
    if (this.anchored) {
      this.anchored = this.clampPointToWorkArea(this.anchored)
      this.feet = clonePoint(this.anchored)
      return
    }
    if (this.placement) {
      this.placement.from = this.clampPointToWorkArea(this.placement.from)
      this.placement.to = this.clampPointToWorkArea(this.placement.to)
      return
    }

    if (this.dragging) {
      this.dragTarget = this.clampPointToWorkArea(this.dragTarget)
      return
    }
    if (this.climbing) {
      this.feet = this.clampPointToWorkArea(this.feet)
      return
    }
    if (this.grounded) {
      this.refreshSupport()
      if (this.grounded) return
    }
    if (this.airborne && this.feet.y >= this.ground.top) {
      // workArea 变化可能让地面"抬"到脚下：直接落地，而不是穿到地下。
      this.landOn(this.ground.id, this.ground.top)
    }
  }

  /**
   * 设置 B1 的运动意图（每帧可调；同一条指令可重复设置）。
   * 输入不做深校验：非法字段在 `step` 中按当前物理状态丢弃/截断（如空中收到 moveTo 忽略）。
   */
  setCommand(command: MotionCommand): void {
    if (!command || typeof command !== 'object') {
      this.command = { kind: 'hold' }
      return
    }
    switch (command.kind) {
      case 'hold':
      case 'moveTo':
      case 'sit':
      case 'drop':
      case 'teleport':
        this.command = command
        return
      default:
        this.command = { kind: 'hold' }
    }
  }

  /** 开始拖拽（B4 dragStart → main.ts）。pointer 为窗口本地指针位置；非法值忽略。 */
  beginDrag(pointer: Point2D, nowMs: number): void {
    if (!isFinitePoint(pointer)) return
    const now = this.resolveNow(nowMs)
    this.dragging = true
    this.placement = null
    this.anchored = null
    this.climbing = false
    this.grounded = false
    this.airborne = false
    this.surfaceId = null
    this.mode = 'drag'
    // V7（用户实机反馈）：被拎起来时应呈侧身悬挂，不能正面朝镜头。
    // 起手若当前是正面（front）→ 切默认侧向；已侧身/正在走的方向保持不变；
    // 拖动中的水平移动继续由 updateFacing() 按速度方向更新（保持朝移动方向）。
    if (this.facing === 'front') this.facing = DRAG_START_FACING
    // 保留抓取偏移：鼠标按在身体哪个位置，拖动时脚底就相对指针偏移多少，不瞬移。
    this.dragOffset = { x: this.feet.x - pointer.x, y: this.feet.y - pointer.y }
    this.dragTarget = this.clampPointToWorkArea(this.feet)
    this.velocityTracker.reset()
    this.velocityTracker.push(pointer.x, pointer.y, now)
  }

  /** 拖拽中指针移动（窗口本地）。内部只记录目标 + 速度样本，step() 里做平滑跟随。 */
  dragTo(pointer: Point2D, nowMs: number): void {
    if (!this.dragging || !isFinitePoint(pointer)) return
    const now = this.resolveNow(nowMs)
    this.dragTarget = this.clampPointToWorkArea({
      x: pointer.x + this.dragOffset.x,
      y: pointer.y + this.dragOffset.y
    })
    this.velocityTracker.push(pointer.x, pointer.y, now)
  }

  /**
   * 结束拖拽 → 松手进入空中（甩出/落下由 step 的物理继续）。
   * `throwVelocity` 由最近 ~120ms 指针速度估计并 clamp 到 4000px/s；
   * 可选 `throwVelocityOverride`：B4 的 `InteractionEvent.dragEnd.throwVelocity` 已有估计时，
   * main.ts 可直接传入（仍会 clamp），保证 B2 运动与 B3 `AnimationEvent.thrown` 用同一数值。
   * 未在拖拽中调用时返回零速度（不抛异常）。
   */
  endDrag(nowMs: number, throwVelocityOverride?: Point2D): DragEndResult {
    if (!this.dragging) return { throwVelocity: { x: 0, y: 0 } }
    const now = this.resolveNow(nowMs)
    const throwVelocity = isFinitePoint(throwVelocityOverride)
      ? clampVelocityMagnitude(
          { x: throwVelocityOverride.x, y: throwVelocityOverride.y },
          THROW_MAX_SPEED_PX_PER_SEC
        )
      : this.velocityTracker.estimate(now)
    this.dragging = false
    this.grounded = false
    this.airborne = true
    this.climbing = false
    this.surfaceId = null
    this.mode = 'air'
    this.velocity = { x: throwVelocity.x, y: throwVelocity.y }
    this.velocityTracker.reset()
    this.updateFacing()
    // P1：松手时脚底恰好压在窗沿带内（±4px）且不是甩出 → 直接吸附到该窗沿，避免"放上去了又掉下去"。
    this.trySnapToReleaseSurface()
    return { throwVelocity }
  }

  /**
   * 开始「放置」过渡（B4 松手后由集成层调用）：把宠物平滑移到窗沿（surface）或站定点（anchor）。
   *
   * - 拖拽/攀爬中忽略（返回 false）；目标非法 / 顶边不在 workArea 内 / 已有放置进行中忽略；
   * - 成功返回 true，之后由 `step()` 推进；完成前 `grounded=false && airborne=false`（第三态）；
   * - `surface` 模式完成后会变成「窗沿上方 2px 的自由落体」→ 复用既有落地检测与 B1 落地后坐下；
   * - `anchor` 模式完成后进入站定（`isAnchored()`），不随重力下落、忽略移动/落下指令。
   */
  beginPlacement(plan: PlacementPlan, nowMs: number): boolean {
    if (!plan || typeof plan !== 'object') return false
    if (this.dragging || this.climbing || this.placement) return false
    const input = plan as { mode?: unknown }
    if (input.mode !== 'surface' && input.mode !== 'anchor') return false
    this.resolveNow(nowMs)
    const from = clonePoint(this.feet)
    this.placementLanded = false

    if (plan.mode === 'surface') {
      if (typeof plan.surfaceId !== 'string' || plan.surfaceId.length === 0) return false
      if (!isFiniteNumber(plan.top)) return false
      const bottom = this.workArea.y + this.workArea.height
      if (plan.top < this.workArea.y || plan.top > bottom) return false
      const requestedX = isFinitePoint(plan.feet) ? plan.feet.x : this.feet.x
      const to = this.clampPointToWorkArea({ x: requestedX, y: plan.top })
      this.placement = {
        mode: 'surface',
        from,
        to,
        surfaceId: plan.surfaceId,
        top: plan.top,
        elapsedSec: 0,
        durationSec: this.placementDurationSec(from, to)
      }
    } else {
      if (!isFinitePoint(plan.feet)) return false
      const to = this.clampPointToWorkArea(clonePoint(plan.feet))
      this.placement = {
        mode: 'anchor',
        from,
        to,
        surfaceId: null,
        top: Number.NaN,
        elapsedSec: 0,
        durationSec: this.placementDurationSec(from, to)
      }
    }

    this.anchored = null
    this.dragging = false
    this.grounded = false
    this.airborne = false
    this.climbing = false
    this.surfaceId = null
    this.velocity = { x: 0, y: 0 }
    this.mode = 'placing'
    return true
  }

  /**
   * 立刻吸附到某个可站表面（放置到**可坐**窗沿用）：不经过自由落体/过渡动画，直接 grounded。
   *
   * 背景（2026-11-10 用户反馈「被放到窗口上第一时间永远站在窗口上」）：旧实现吸附后要
   * 经历 2px 落差 + 落地 + B1 450ms 延迟才坐下 → 观感上先站一会儿。改为直接吸附到位后由
   * 集成层立刻请求坐下，宠物出现在窗沿上的第一帧就是坐/躺姿态。
   *
   * 相对 `beginPlacement` 的 surface 模式：无中间过渡，输入非法/表面 top 不在 workArea 内返回 false。
   */
  snapOntoSurface(surfaceId: string, top: number, feet: Point2D): boolean {
    if (typeof surfaceId !== 'string' || surfaceId.length === 0) return false
    if (!isFiniteNumber(top)) return false
    const bottom = this.workArea.y + this.workArea.height
    if (top < this.workArea.y || top > bottom) return false
    if (!isFinitePoint(feet)) return false
    this.dragging = false
    this.placement = null
    this.anchored = null
    this.climbing = false
    this.velocity = { x: 0, y: 0 }
    this.velocityTracker.reset()
    this.feet = this.clampPointToWorkArea({ x: feet.x, y: top })
    const surface = this.findStandableSurface(surfaceId)
    if (surface) this.rememberSupport(surface)
    this.landOn(surfaceId, top)
    return true
  }

  /** 是否处于「放置站定」状态（放在窗口上；不随重力下落、忽略移动指令）。 */
  isAnchored(): boolean {
    return this.anchored !== null
  }

  /** 是否处于「放置过渡」动画中（松手 → 吸附窗沿/站定点的平滑移动）。 */
  isPlacing(): boolean {
    return this.placement !== null
  }

  /** 取走「站定完成」一次性事件（main.ts 转成 `landed` 动画事件用；取走即清）。 */
  consumePlacementLanded(): boolean {
    if (!this.placementLanded) return false
    this.placementLanded = false
    return true
  }

  /**
   * 主更新：推进 dt 秒并返回本帧快照（feet 唯一位置权威）。
   * dt 已由 main.ts 钳制 ≤0.1；本模块仍会兜底（NaN/负数按 0、超大截断），退化输入不抛不 NaN。
   */
  step(dt: number, nowMs: number): MotionSnapshot {
    const now = isFiniteNumber(nowMs) ? nowMs : this.lastNowMs
    this.lastNowMs = now
    const rawDt = isFiniteNumber(dt) ? dt : 0
    const dtSec = rawDt > 0 ? Math.min(rawDt, MAX_STEP_DT_SEC) : 0
    if (dtSec > 0) this.advance(dtSec)
    return this.getSnapshot()
  }

  /** 当前运动快照（拷贝；调用方随意修改不影响内部状态）。 */
  getSnapshot(): MotionSnapshot {
    return {
      feet: clonePoint(this.feet),
      velocity: clonePoint(this.velocity),
      facing: this.facing,
      grounded: this.grounded,
      surfaceId: this.surfaceId,
      airborne: this.airborne
    }
  }

  /** 额外调试快照（Lead 可挂到 `window.__aventurineDebug`；非契约必需）。 */
  getDebugSnapshot(): PhysicsDebugSnapshot {
    return {
      mode: this.mode,
      command: this.command.kind,
      dragging: this.dragging,
      climbing: this.climbing,
      grounded: this.grounded,
      airborne: this.airborne,
      surfaceId: this.surfaceId,
      gravityPxPerSec2: this.gravityPxPerSec2,
      pointerSamples: this.velocityTracker.getSampleCount(),
      placement: this.placement ? 'placing' : this.anchored ? 'anchored' : 'none'
    }
  }

  /* ------------------------------------------------------------------ */
  /* 每帧推进                                                            */
  /* ------------------------------------------------------------------ */

  private advance(dt: number): void {
    // teleport：当帧直接复位（不产生甩出动画），之后指令消费为 hold。
    if (this.command.kind === 'teleport') {
      this.applyTeleport(this.command.feet)
      this.command = { kind: 'hold' }
      return
    }
    // 放置过渡 / 站定：优先于普通物理（不随重力、忽略 B1 移动指令）。
    if (this.placement) {
      this.stepPlacement(dt)
      return
    }
    if (this.anchored) {
      this.stepAnchored()
      return
    }
    if (this.dragging) {
      this.stepDrag(dt)
      this.updateFacing()
      return
    }
    if (this.climbing) {
      this.stepClimbing(dt)
      this.updateFacing()
      return
    }
    if (this.grounded) this.refreshSupport()
    if (this.grounded) {
      this.stepGrounded(dt)
    } else if (
      this.mode === 'sit-approach' &&
      !this.airborne &&
      this.command.kind === 'sit'
    ) {
      // sit 接近是受控 2D 位移（既非站立也非自由落体），必须跨帧延续，不能被重力打断。
      this.stepSit(this.command, dt)
    } else {
      this.stepAirborne(dt)
    }
    this.updateFacing()
  }

  /** 站立状态：feet.y 贴当前支撑 top，按指令行走/落座/跳下/静止摩擦。 */
  private stepGrounded(dt: number): void {
    const command = this.command
    switch (command.kind) {
      case 'moveTo':
        this.stepMoveTo(command, dt)
        return
      case 'sit':
        this.stepSit(command, dt)
        return
      case 'drop':
        // drop 是一次性事件：消费掉，避免落地后反复起跳。
        this.command = { kind: 'hold' }
        this.startDrop(dt)
        return
      default:
        this.applyGroundFriction(dt)
    }
  }

  /** 地面摩擦（hold / 无有效指令时）：水平速度指数衰减，y 速度清零。 */
  private applyGroundFriction(dt: number): void {
    const factor = Math.exp(-GROUND_FRICTION_DAMPING_PER_SEC * dt)
    this.velocity.x *= factor
    if (Math.abs(this.velocity.x) < GROUND_STOP_SPEED_PX_PER_SEC) this.velocity.x = 0
    this.velocity.y = 0
    this.mode = 'idle'
  }

  /** moveTo：walk 贴当前支撑水平移动；climb 进入攀附做 2D 受控位移。 */
  private stepMoveTo(
    command: Extract<MotionCommand, { kind: 'moveTo' }>,
    dt: number
  ): void {
    const target = command.target
    const speed = command.speedPxPerSec
    if (!isFinitePoint(target) || !isFiniteNumber(speed) || speed <= 0) {
      this.applyGroundFriction(dt)
      return
    }
    if (command.mode === 'climb') {
      // 攀附：脱离支撑进入第三种状态（无重力），沿 2D 方向移动（爬窗口侧边/屏幕边缘）。
      this.climbing = true
      this.grounded = false
      this.airborne = false
      this.surfaceId = null
      this.mode = 'climb'
      this.stepClimbMotion(target, speed, dt)
      return
    }
    // walk：只水平走，竖直方向贴当前支撑面（目标 y 由 B1 决定坐/跳，用 sit/drop）。
    this.feet.y = this.currentSupportTop()
    const dx = target.x - this.feet.x
    if (Math.abs(dx) <= MOVE_ARRIVE_EPS_PX) {
      this.velocity.x = 0
      this.velocity.y = 0
      this.mode = 'idle'
      return
    }
    const direction = dx < 0 ? -1 : 1
    const stepLength = Math.min(Math.abs(dx), speed * dt)
    this.feet.x += direction * stepLength
    this.velocity.x = direction * speed
    this.velocity.y = 0
    this.mode = 'walk'
    this.clampGroundedX()
    // 走出窗口上沿边缘 → 失去支撑进入空中（下一帧开始自由落体）。
    this.refreshSupport()
    if (!this.grounded) this.mode = 'air'
  }

  /** 攀附中的 2D 受控位移（climb target）；clamp 在 workArea 内。 */
  private stepClimbMotion(target: Point2D, speed: number, dt: number): void {
    const dx = target.x - this.feet.x
    const dy = target.y - this.feet.y
    const distance = Math.hypot(dx, dy)
    if (distance <= MOVE_ARRIVE_EPS_PX) {
      this.velocity.x = 0
      this.velocity.y = 0
      // 攀到目标点若正好是可站表面（B1 的爬窗沿目标是 {表面中心, surface.top}），
      // 直接落到表面上（grounded），而不是继续挂在空中——否则 B1 随后发的 hold 会让宠物掉下去。
      if (this.snapToSupportAtCurrentPosition(MOVE_ARRIVE_EPS_PX)) return
      this.mode = 'climb'
      return
    }
    const nx = dx / distance
    const ny = dy / distance
    const stepLength = Math.min(distance, speed * dt)
    this.feet.x += nx * stepLength
    this.feet.y += ny * stepLength
    this.velocity.x = nx * speed
    this.velocity.y = ny * speed
    this.clampClimbingPosition()
    this.mode = 'climb'
  }

  /** 攀附状态推进：同指令继续爬；换指令则松手（sit 可直接接近并落座，其余进入自由落体）。 */
  private stepClimbing(dt: number): void {
    const command = this.command
    if (command.kind === 'moveTo' && command.mode === 'climb') {
      if (isFinitePoint(command.target) && isFiniteNumber(command.speedPxPerSec) && command.speedPxPerSec > 0) {
        this.stepClimbMotion(command.target, command.speedPxPerSec, dt)
      } else {
        this.velocity.x = 0
        this.velocity.y = 0
      }
      return
    }
    this.climbing = false
    if (command.kind === 'sit') {
      this.stepSit(command, dt)
      return
    }
    // B1 在距目标 16px 内就判定到位并改发 hold：若脚下 24px 内正好有可站表面，
    // 补完最后一段"上沿"并站稳；否则松手自由落体。
    if (this.snapToSupportAtCurrentPosition(CLIMB_SETTLE_SNAP_EPS_PX)) return
    this.becomeAirborne()
    this.stepAirborne(dt)
  }

  /**
   * sit：移动到可坐表面正上方并落座（feet = {surface 内水平 clamp, surface.top}）。
   * 接近阶段为受控 2D 位移（grounded=false、airborne=false）；表面不存在/不可坐 → 丢弃指令。
   */
  private stepSit(command: Extract<MotionCommand, { kind: 'sit' }>, dt: number): void {
    const surface = this.findStandableSurface(command.surfaceId)
    // H-4：workArea 垂直范围外的顶边（全屏应用 / 窗口拖出屏幕）不可坐，丢弃指令而不是坐到视口外。
    if (
      !surface ||
      surface.sittable !== true ||
      !this.isSupportTopInsideWorkArea(surface)
    ) {
      this.command = { kind: 'hold' }
      if (this.grounded) {
        this.applyGroundFriction(dt)
      } else if (!this.airborne) {
        this.becomeAirborne()
        this.stepAirborne(dt)
      }
      return
    }
    const rect = surface.rect
    const half = this.halfWidthPx
    const minCenterX = rect.x + half
    const maxCenterX = rect.x + rect.width - half
    const surfaceTargetX =
      maxCenterX >= minCenterX ? clampNumber(this.feet.x, minCenterX, maxCenterX) : rect.x + rect.width / 2
    const xRange = this.getXRange()
    const yRange = this.getYRange()
    const targetX = clampNumber(surfaceTargetX, xRange.lo, xRange.hi)
    const targetY = clampNumber(surface.top, yRange.lo, yRange.hi)
    const dx = targetX - this.feet.x
    const dy = targetY - this.feet.y
    const distance = Math.hypot(dx, dy)
    if (distance <= MOVE_ARRIVE_EPS_PX) {
      this.feet.x = targetX
      this.feet.y = targetY
      this.velocity.x = 0
      this.velocity.y = 0
      this.grounded = true
      this.airborne = false
      this.climbing = false
      this.surfaceId = surface.id
      this.rememberSupport(surface)
      this.mode = 'sit'
      return
    }
    const nx = dx / distance
    const ny = dy / distance
    const stepLength = Math.min(distance, this.sitApproachSpeed * dt)
    this.feet.x += nx * stepLength
    this.feet.y += ny * stepLength
    this.velocity.x = nx * this.sitApproachSpeed
    this.velocity.y = ny * this.sitApproachSpeed
    this.grounded = false
    this.airborne = false
    this.climbing = false
    this.surfaceId = null
    this.mode = 'sit-approach'
  }

  /** drop：主动落下（消费指令）；起落瞬间保留水平速度、竖直速度清零。 */
  private startDrop(dt: number): void {
    if (!this.grounded) return
    this.grounded = false
    this.airborne = true
    this.climbing = false
    this.surfaceId = null
    this.velocity.y = 0
    this.mode = 'air'
    this.stepAirborne(dt)
  }

  /** 空中：重力 + 位移 + 边界（左右墙小反弹 / 天花板）+ 落点判定。 */
  private stepAirborne(dt: number): void {
    const fromY = this.feet.y
    this.velocity.y += this.gravityPxPerSec2 * dt
    this.feet.x += this.velocity.x * dt
    this.feet.y += this.velocity.y * dt
    this.applyAirborneBounds()
    if (this.velocity.y > 0) {
      const landing = this.findLandingSurface(fromY, this.feet.y)
      if (landing) {
        this.rememberSupport(landing)
        this.landOn(landing.id, landing.top)
        return
      }
    }
    if (this.feet.y >= this.ground.top) {
      this.landOn(this.ground.id, this.ground.top)
      return
    }
    this.grounded = false
    this.airborne = true
    this.climbing = false
    this.surfaceId = null
    this.mode = 'air'
  }

  /* ------------------------------------------------------------------ */
  /* 碰撞 / 支撑                                                         */
  /* ------------------------------------------------------------------ */

  /** 空中边界：左右墙 clamp + 小反弹衰减；天花板 clamp（极少数被甩到顶边的情况）。 */
  private applyAirborneBounds(): void {
    const xRange = this.getXRange()
    if (this.feet.x < xRange.lo) {
      this.feet.x = xRange.lo
      this.velocity.x = this.bounceHorizontal(this.velocity.x, 1)
    } else if (this.feet.x > xRange.hi) {
      this.feet.x = xRange.hi
      this.velocity.x = this.bounceHorizontal(this.velocity.x, -1)
    }
    const ceiling = this.workArea.y
    if (this.feet.y < ceiling) {
      this.feet.y = ceiling
      if (this.velocity.y < 0) {
        const speed = Math.abs(this.velocity.y) * CEILING_RESTITUTION
        this.velocity.y = speed >= WALL_BOUNCE_MIN_SPEED_PX_PER_SEC ? speed : 0
      }
    }
  }

  /** 撞墙后的水平速度：向外方向为 outwardSign（左墙 outward=1、右墙=-1），返回新 vx。 */
  private bounceHorizontal(velocityX: number, outwardSign: 1 | -1): number {
    const movingOutward = outwardSign === 1 ? velocityX < 0 : velocityX > 0
    if (!movingOutward) return velocityX
    const speed = Math.abs(velocityX) * WALL_RESTITUTION
    if (speed < WALL_BOUNCE_MIN_SPEED_PX_PER_SEC) return 0
    return outwardSign === 1 ? speed : -speed
  }

  /**
   * 自由落体跨表面检测：返回本帧应落到的表面（y 从 fromY 增大到 toY，表面 top 在两者之间）。
   * 严格 top > fromY（避免从支撑面离开的当帧又落回原面）；多个表面同时穿越时取最高（top 最小，
   * 即先碰到的那层）；top 相同时按 Dock > 窗口上沿 > 菜单栏 的确定性优先级。
   */
  private findLandingSurface(fromY: number, toY: number): DesktopSurface | null {
    if (!(toY > fromY + LANDING_EPS_PX)) return null
    const workBottom = this.workArea.y + this.workArea.height
    let best: DesktopSurface | null = null
    for (const surface of this.surfaces) {
      if (!isStandableSurface(surface)) continue
      const top = surface.top
      if (!(top > fromY) || top > toY) continue
      if (top < this.workArea.y || top > workBottom) continue
      if (!this.overlapsHorizontally(surface)) continue
      if (best === null) {
        best = surface
        continue
      }
      if (top < best.top - LANDING_EPS_PX) {
        best = surface
      } else if (
        Math.abs(top - best.top) <= LANDING_EPS_PX &&
        surfacePriority(surface) > surfacePriority(best)
      ) {
        best = surface
      }
    }
    return best
  }

  /**
   * 站在某表面上时重新校验支撑：表面消失 / 横向移走 → 进入空中；仍在则吸附新 top（窗口垂直移动跟随）。
   *
   * H-4：仅当表面 `top` 落在 workArea 垂直范围内才可作为支撑；窗口被拖出屏幕 / 全屏应用顶边
   * （top=-30 等）时按无支撑处理，进入空中并最终落到屏幕内地面，**绝不把 feet.y 写成视口外的负值**。
   * D6a：B5 遮挡裁剪按可见区间给顶边分段编号，段数变化会让 `surfaceId` 消失或改指别的段；
   * 此时先按 {@link findRematchSupport} 做确定性几何重匹配，匹配到就采用新 id 并保持 grounded，
   * 匹配不到才掉落。
   */
  private refreshSupport(): void {
    if (!this.grounded || this.climbing) return
    // 放置站定/过渡中：支撑由 placement 状态机维护，不参与常规支撑重解。
    if (this.anchored || this.placement) return
    if (this.surfaceId === this.ground.id) {
      this.feet.y = this.ground.top
      this.clampGroundedX()
      return
    }
    const surface = this.findStandableSurface(this.surfaceId)
    if (surface && this.isSupportTopInsideWorkArea(surface) && this.overlapsHorizontally(surface)) {
      this.rememberSupport(surface)
      this.feet.y = surface.top
      this.clampGroundedX()
      return
    }
    const rematched = this.findRematchSupport()
    if (rematched) {
      this.surfaceId = rematched.id
      this.rememberSupport(rematched)
      this.feet.y = rematched.top
      this.clampGroundedX()
      return
    }
    this.becomeAirborne()
  }

  /** 记录当前支撑身份（地面不记录：地面 id 稳定，不需要重匹配）。 */
  private rememberSupport(surface: DesktopSurface): void {
    this.lastSupportHint = {
      windowId: surface.windowId,
      kind: surface.kind,
      top: surface.top
    }
  }

  /** 支撑面 top 是否落在 workArea 垂直范围内（H-4 不变量；地面 top 由 resolveGround 钳制保证）。 */
  private isSupportTopInsideWorkArea(surface: DesktopSurface): boolean {
    const bottom = this.workArea.y + this.workArea.height
    return surface.top >= this.workArea.y && surface.top <= bottom
  }

  /**
   * D6a 段 id 抖动后的支撑面重匹配：优先当前 surfaces 里「同 windowId + 同 kind + top 差 ≤1px」
   * 的表面，没有同 top 时退化为「同 windowId 最近的 top」（窗口移动同时段编号变化的跟随）；
   * 没有 windowId 参考时退化为「top 与当前脚底差 ≤1px」。
   * 候选必须可站立、top 在 workArea 内、且与宠物横向重叠；返回确定性最优者，找不到 → null（掉落）。
   */
  private findRematchSupport(): DesktopSurface | null {
    const hint = this.lastSupportHint
    const referenceTop = hint ? hint.top : this.feet.y
    const hintWindowId = hint?.windowId
    const hintKind = hint?.kind
    let best: DesktopSurface | null = null
    for (const surface of this.surfaces) {
      if (!isStandableSurface(surface)) continue
      if (!this.isSupportTopInsideWorkArea(surface)) continue
      if (!this.overlapsHorizontally(surface)) continue
      if (hintWindowId !== undefined && hintKind !== undefined) {
        if (surface.windowId !== hintWindowId || surface.kind !== hintKind) continue
      } else if (Math.abs(surface.top - referenceTop) > SUPPORT_REMATCH_TOP_EPS_PX) {
        continue
      }
      if (best === null || this.compareRematchSupport(surface, best, referenceTop) < 0) {
        best = surface
      }
    }
    return best
  }

  /** 重匹配候选排序（返回 <0 表示 a 更优）：top 差 ≤1px 优先 → 覆盖脚底点优先 → top 更近 → 中心更近 → id 字典序。 */
  private compareRematchSupport(
    a: DesktopSurface,
    b: DesktopSurface,
    referenceTop: number
  ): number {
    const aExact = Math.abs(a.top - referenceTop) <= SUPPORT_REMATCH_TOP_EPS_PX ? 0 : 1
    const bExact = Math.abs(b.top - referenceTop) <= SUPPORT_REMATCH_TOP_EPS_PX ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    const aContains = this.containsFootX(a) ? 0 : 1
    const bContains = this.containsFootX(b) ? 0 : 1
    if (aContains !== bContains) return aContains - bContains
    const aTopDiff = Math.abs(a.top - referenceTop)
    const bTopDiff = Math.abs(b.top - referenceTop)
    if (aTopDiff !== bTopDiff) return aTopDiff - bTopDiff
    const aCenterDist = Math.abs(a.rect.x + a.rect.width / 2 - this.feet.x)
    const bCenterDist = Math.abs(b.rect.x + b.rect.width / 2 - this.feet.x)
    if (aCenterDist !== bCenterDist) return aCenterDist - bCenterDist
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  }

  /** 脚底中心点是否落在表面 rect 的水平范围内（候选排序的次级 tie-break）。 */
  private containsFootX(surface: DesktopSurface): boolean {
    return this.feet.x >= surface.rect.x && this.feet.x <= surface.rect.x + surface.rect.width
  }

  /** 进入自由落体（保留当前速度，供 B3 切 fall 姿态）。 */
  private becomeAirborne(): void {
    this.grounded = false
    this.airborne = true
    this.climbing = false
    this.surfaceId = null
    this.mode = 'air'
  }

  /** 落地：竖直速度清零、grounded=true、记录表面 id（水平速度保留 → 后续摩擦滑行）。 */
  private landOn(surfaceId: string, top: number): void {
    this.feet.y = top
    this.velocity.y = 0
    this.grounded = true
    this.airborne = false
    this.climbing = false
    this.surfaceId = surfaceId
    // 落到地面后清空支撑身份：地面 id 稳定，避免旧窗口的 hint 在极端环境变化下被误用。
    if (surfaceId === this.ground.id) this.lastSupportHint = null
    this.mode = 'idle'
    const xRange = this.getXRange()
    if (this.feet.x < xRange.lo) {
      this.feet.x = xRange.lo
      if (this.velocity.x < 0) this.velocity.x = 0
    } else if (this.feet.x > xRange.hi) {
      this.feet.x = xRange.hi
      if (this.velocity.x > 0) this.velocity.x = 0
    }
  }

  /** teleport：位置复位、速度清零、重新判定支撑（落点正好在地面/表面时立即 grounded）。 */
  private applyTeleport(target: Point2D): void {
    if (!isFinitePoint(target)) return
    this.dragging = false
    this.climbing = false
    this.placement = null
    this.anchored = null
    this.velocity.x = 0
    this.velocity.y = 0
    this.feet = this.clampPointToWorkArea(clonePoint(target))
    this.grounded = false
    this.airborne = true
    this.surfaceId = null
    this.mode = 'air'
    this.velocityTracker.reset()
    this.snapToSupportAtCurrentPosition(TELEPORT_SNAP_EPS_PX)
  }

  /** 当前位置是否"正好"落在支撑上（teleport/初始化用）；落在范围内则立即 grounded。 */
  private snapToSupportAtCurrentPosition(epsilonPx: number): boolean {
    if (this.feet.y >= this.ground.top - epsilonPx) {
      this.landOn(this.ground.id, this.ground.top)
      return true
    }
    for (const surface of this.surfaces) {
      if (!isStandableSurface(surface)) continue
      // H-4 不变量：workArea 垂直范围外的 top 不能成为支撑（落到那里的宠物会被 refreshSupport 再踢下去）。
      if (!this.isSupportTopInsideWorkArea(surface)) continue
      if (!this.overlapsHorizontally(surface)) continue
      if (Math.abs(surface.top - this.feet.y) > epsilonPx) continue
      this.rememberSupport(surface)
      this.landOn(surface.id, surface.top)
      return true
    }
    return false
  }

  /** 拖拽平滑跟随：指数平滑逼近 dragTarget（τ≈45ms），velocity 由实际位移差分。 */
  private stepDrag(dt: number): void {
    const target = this.clampPointToWorkArea(this.dragTarget)
    const previousX = this.feet.x
    const previousY = this.feet.y
    const factor = 1 - Math.exp(-dt / this.dragTauSec)
    this.feet.x += (target.x - this.feet.x) * factor
    this.feet.y += (target.y - this.feet.y) * factor
    this.velocity.x = (this.feet.x - previousX) / dt
    this.velocity.y = (this.feet.y - previousY) / dt
    this.grounded = false
    this.airborne = false
    this.surfaceId = null
    this.mode = 'drag'
  }

  /**
   * 放置过渡：从松手位置平滑移动到目标（窗沿上方 / 站定点），完成前不受重力。
   *
   * - surface 模式完成时：脚底停在 `top - 2px`，转为 airborne → 下一帧正常自由落体跨过 top 落地，
   *   复用现有落地检测/`landed` 事件/B1 `finishFall`（落地后优先坐下）整条管线；
   * - anchor 模式完成时：进入 anchored（grounded、surfaceId=null），不随重力下落、忽略移动指令。
   */
  private stepPlacement(dt: number): void {
    const plan = this.placement
    if (!plan) return
    plan.elapsedSec += dt
    const rawT = plan.durationSec > 0 ? plan.elapsedSec / plan.durationSec : 1
    const t = clampNumber(rawT, 0, 1)
    // easeOutCubic：起步快、到位缓，观感像「一下被放上去」。
    const eased = 1 - (1 - t) * (1 - t) * (1 - t)
    const previousX = this.feet.x
    const previousY = this.feet.y
    this.feet.x = plan.from.x + (plan.to.x - plan.from.x) * eased
    this.feet.y = plan.from.y + (plan.to.y - plan.from.y) * eased
    this.velocity.x = dt > 0 ? (this.feet.x - previousX) / dt : 0
    this.velocity.y = dt > 0 ? (this.feet.y - previousY) / dt : 0
    this.grounded = false
    this.airborne = false
    this.climbing = false
    this.surfaceId = null
    this.mode = 'placing'
    if (t < 1) return

    this.placement = null
    if (plan.mode === 'anchor') {
      this.anchored = { x: plan.to.x, y: plan.to.y }
      this.feet = clonePoint(plan.to)
      this.velocity = { x: 0, y: 0 }
      this.grounded = true
      this.airborne = false
      this.climbing = false
      this.surfaceId = null
      this.mode = 'placed'
      this.placementLanded = true
      return
    }

    // surface：留 2px 落差交给正常落地检测（复用 landed 事件与 B1 落地后坐下）。
    const surfaceId = typeof plan.surfaceId === 'string' ? plan.surfaceId : null
    if (surfaceId === null) {
      this.becomeAirborne()
      return
    }
    const dropFeetY = plan.top - PLACEMENT_SURFACE_DROP_GAP_PX
    if (dropFeetY < this.workArea.y) {
      // 顶边贴 workArea 上边（没有落差空间）：直接落到窗沿上。
      const surface = this.findStandableSurface(surfaceId)
      if (surface) {
        this.rememberSupport(surface)
        this.landOn(surface.id, surface.top)
        this.placementLanded = true
      } else {
        this.becomeAirborne()
      }
      return
    }
    this.feet = { x: plan.to.x, y: dropFeetY }
    this.velocity = { x: 0, y: 0 }
    this.grounded = false
    this.airborne = true
    this.surfaceId = null
    this.mode = 'air'
  }

  /** 站定推进：位置锁定在 anchor（忽略 moveTo/sit/drop），速度清零、保持 grounded。 */
  private stepAnchored(): void {
    const anchor = this.anchored
    if (!anchor) return
    const target = this.clampPointToWorkArea(anchor)
    this.anchored = { x: target.x, y: target.y }
    this.feet = clonePoint(target)
    this.velocity = { x: 0, y: 0 }
    this.grounded = true
    this.airborne = false
    this.climbing = false
    this.surfaceId = null
    this.mode = 'placed'
  }

  /** 放置过渡时长（秒）：按距离/速度估算，再夹到 [min,max]，避免瞬移感或拖太久。 */
  private placementDurationSec(from: Point2D, to: Point2D): number {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const ms = (distance / PLACEMENT_SPEED_PX_PER_SEC) * 1000
    return clampNumber(ms, PLACEMENT_MIN_DURATION_MS, PLACEMENT_MAX_DURATION_MS) / 1000
  }

  /**
   * 松手贴沿吸附（P1）：脚底与某条窗沿 top 相差 ≤ {@link RELEASE_SNAP_EPS_PX} 且竖直速度很小 →
   * 直接落到该窗沿上。避免「松手瞬间恰好压在沿上、却因严格 `top > fromY` 穿越判定而直接穿过」。
   * 只考虑 `window-top`（地面/菜单栏/Dock 由既有落地逻辑处理）。
   */
  private trySnapToReleaseSurface(): void {
    if (Math.abs(this.velocity.y) > RELEASE_SNAP_MAX_VY_PX_PER_SEC) return
    const bottom = this.workArea.y + this.workArea.height
    let best: DesktopSurface | null = null
    for (const surface of this.surfaces) {
      if (!isStandableSurface(surface) || surface.kind !== 'window-top') continue
      if (surface.top < this.workArea.y || surface.top > bottom) continue
      if (Math.abs(surface.top - this.feet.y) > RELEASE_SNAP_EPS_PX) continue
      if (!this.overlapsHorizontally(surface)) continue
      if (best === null || surface.top < best.top) best = surface
    }
    if (!best) return
    this.rememberSupport(best)
    this.landOn(best.id, best.top)
  }

  /* ------------------------------------------------------------------ */
  /* 辅助                                                                */
  /* ------------------------------------------------------------------ */

  /** 朝向：优先由水平速度推导；静止时由 moveTo/拖拽目标推导；否则保持上一朝向。 */
  private updateFacing(): void {
    if (Math.abs(this.velocity.x) > FACING_SPEED_EPS_PX_PER_SEC) {
      this.facing = this.velocity.x < 0 ? 'left' : 'right'
      return
    }
    if (this.dragging) {
      const dx = this.dragTarget.x - this.feet.x
      if (Math.abs(dx) > MOVE_ARRIVE_EPS_PX) this.facing = dx < 0 ? 'left' : 'right'
      return
    }
    const command = this.command
    if (command.kind === 'moveTo' && isFinitePoint(command.target)) {
      const dx = command.target.x - this.feet.x
      if (Math.abs(dx) > MOVE_ARRIVE_EPS_PX) this.facing = dx < 0 ? 'left' : 'right'
    }
    // hold / sit / drop / teleport：静止保持上一朝向（初始 'front'）。
  }

  /** 解析地面：优先 B5 提供的 screen-bottom 表面（id + top），否则用 workArea 底边。 */
  private resolveGround(): GroundInfo {
    const bottom = this.workArea.y + this.workArea.height
    for (const surface of this.surfaces) {
      if (!surface || typeof surface !== 'object' || surface.kind !== 'screen-bottom') continue
      if (!isFiniteNumber(surface.top)) continue
      const id =
        typeof surface.id === 'string' && surface.id.length > 0
          ? surface.id
          : IMPLICIT_GROUND_SURFACE_ID
      return { id, top: clampNumber(surface.top, this.workArea.y, bottom) }
    }
    return { id: IMPLICIT_GROUND_SURFACE_ID, top: bottom }
  }

  /** 按 id 找可站立表面（运行时逐项校验，非法项忽略）。 */
  private findStandableSurface(surfaceId: string | null): DesktopSurface | null {
    if (typeof surfaceId !== 'string') return null
    for (const surface of this.surfaces) {
      if (isStandableSurface(surface) && surface.id === surfaceId) return surface
    }
    return null
  }

  /** 当前支撑表面 top（找不到时退化为地面 top）。 */
  private currentSupportTop(): number {
    if (this.surfaceId === this.ground.id) return this.ground.top
    const surface = this.findStandableSurface(this.surfaceId)
    return surface ? surface.top : this.ground.top
  }

  /**
   * 横向支撑判定（"脚底点 + 宠物半宽"）：宠物身体横向投影与表面 rect 有重叠即可站立/落上。
   * 比"脚底中心点必须落在表面内"更宽容，也能处理比宠物还窄的窗口上沿。
   */
  private overlapsHorizontally(surface: DesktopSurface): boolean {
    const left = this.feet.x - this.halfWidthPx
    const right = this.feet.x + this.halfWidthPx
    return right >= surface.rect.x && left <= surface.rect.x + surface.rect.width
  }

  /** 可活动 x 区间（左右墙 = 宠物半宽不穿出 workArea）；宠物比 workArea 还宽时退化为中线。 */
  private getXRange(): { lo: number; hi: number } {
    const lo = this.workArea.x + this.halfWidthPx
    const hi = this.workArea.x + this.workArea.width - this.halfWidthPx
    if (hi >= lo) return { lo, hi }
    const center = this.workArea.x + this.workArea.width / 2
    return { lo: center, hi: center }
  }

  /** 可活动 y 区间（feet 点不离开 workArea）。 */
  private getYRange(): { lo: number; hi: number } {
    return { lo: this.workArea.y, hi: this.workArea.y + this.workArea.height }
  }

  /** 把点钳制进 workArea（feet 允许贴边）。 */
  private clampPointToWorkArea(point: Point2D): Point2D {
    const xRange = this.getXRange()
    const yRange = this.getYRange()
    return {
      x: clampNumber(point.x, xRange.lo, xRange.hi),
      y: clampNumber(point.y, yRange.lo, yRange.hi)
    }
  }

  /** 站立行走时的左右墙 clamp（撞墙即停，不反弹）。 */
  private clampGroundedX(): void {
    const xRange = this.getXRange()
    if (this.feet.x < xRange.lo) {
      this.feet.x = xRange.lo
      if (this.velocity.x < 0) this.velocity.x = 0
    } else if (this.feet.x > xRange.hi) {
      this.feet.x = xRange.hi
      if (this.velocity.x > 0) this.velocity.x = 0
    }
  }

  /** 攀附时的边界 clamp（不出 workArea，撞边不动）。 */
  private clampClimbingPosition(): void {
    const xRange = this.getXRange()
    const yRange = this.getYRange()
    if (this.feet.x < xRange.lo) {
      this.feet.x = xRange.lo
      if (this.velocity.x < 0) this.velocity.x = 0
    } else if (this.feet.x > xRange.hi) {
      this.feet.x = xRange.hi
      if (this.velocity.x > 0) this.velocity.x = 0
    }
    if (this.feet.y < yRange.lo) {
      this.feet.y = yRange.lo
      if (this.velocity.y < 0) this.velocity.y = 0
    } else if (this.feet.y > yRange.hi) {
      this.feet.y = yRange.hi
      if (this.velocity.y > 0) this.velocity.y = 0
    }
  }

  /** 统一时钟回退：nowMs 非法时使用上次记录值。 */
  private resolveNow(nowMs: number): number {
    const now = isFiniteNumber(nowMs) ? nowMs : this.lastNowMs
    this.lastNowMs = now
    return now
  }
}
