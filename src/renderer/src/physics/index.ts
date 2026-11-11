/**
 * B2 运动与物理（`src/renderer/src/physics/**`）—— 对外入口。
 *
 * Lead 接线方式（docs/wave2-integration.md §2/§3-B2）：
 * ```ts
 * import { PetPhysics } from './physics'
 *
 * const physics = new PetPhysics({
 *   workArea,               // overlay 窗口本地工作区（随 screens-updated / window resize 更新）
 *   petSize: { width, height }, // 当前宠物 CSS 尺寸（petHeightPx × 模型宽高比）
 *   initialFeet: { x: 1750, y: 961 } // 可选：Wave 1 右下角位置，保持启动画面连续
 * })
 * physics.setEnvironment({ workArea, petSize, surfaces: desktop.surfaces })
 * physics.setCommand(decision.motion)
 * const motion = physics.step(dt, performance.now())   // feet 是唯一位置权威
 * petRect = { x: motion.feet.x - width / 2, y: motion.feet.y - height, width, height }
 * ```
 * 拖拽：`beginDrag(pointer, now)` → `dragTo(pointer, now)`… → `endDrag(now)` 拿 throwVelocity。
 *
 * 纯逻辑：不 import three / DOM / Electron / node 内置；可在 vitest node 环境直接单测。
 */
export {
  PetPhysics,
  type DragEndResult,
  type PhysicsDebugSnapshot,
  type PhysicsEnvironment,
  type PhysicsMode,
  type PhysicsOptions,
  type PlacementPlan
} from './pet-physics'

export {
  PointerVelocityTracker,
  clampVelocityMagnitude,
  type PointerSample
} from './pointer-velocity'

export {
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
  SUPPORT_REMATCH_TOP_EPS_PX,
  TELEPORT_SNAP_EPS_PX,
  THROW_MAX_SAMPLES,
  THROW_MAX_SPEED_PX_PER_SEC,
  THROW_SAMPLE_WINDOW_MS,
  WALL_BOUNCE_MIN_SPEED_PX_PER_SEC,
  WALL_RESTITUTION
} from './constants'
