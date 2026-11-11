/**
 * B4 交互模块公共出口（`src/renderer/src/interaction/**`）。
 *
 * Lead 的接线只需：
 * - `InteractionController`（DOM 层，`attach(window)` + 每帧 `getSnapshot()` / `drainEvents()`）；
 * - 纯逻辑模块导出供单测/调试/B1-B3 参考（一般不需要直接 import）。
 *
 * 事件/快照类型使用 `core/wave2-contract.ts` 的冻结契约，本文件不重复定义。
 */

/* ------------------------------ DOM 层（Lead 接线入口） ------------------------------ */
export { InteractionController } from './controller'
export type { InteractionControllerOptions } from './controller'
export { ContextMenuView } from './menu-view'
export type { ContextMenuViewHandlers } from './menu-view'

/* ------------------------------ 纯逻辑编排（可单测） ------------------------------ */
export {
  InteractionCore,
  LOOK_EMIT_DEADBAND_PX,
  MAX_PENDING_INTERACTION_EVENTS
} from './interaction-core'
export type { InteractionCoreOptions, InteractionTuning } from './interaction-core'

/* ------------------------------ 区域命中 ------------------------------ */
export {
  hitTestHeadBand,
  hitTestHeadShape,
  hitTestRegion,
  normalizePetPoint,
  REGION_RATIOS,
  regionBounds
} from './regions'
export type { NormalizedPetPoint } from './regions'

/* ------------------------------ 拖拽 / 戳 ------------------------------ */
export {
  DRAG_THRESHOLD_PX,
  DragMachine,
  estimateThrowVelocity,
  MAX_DRAG_SAMPLES,
  MAX_THROW_SPEED_PX_PER_SEC,
  MIN_THROW_SAMPLE_DT_MS,
  POKE_MAX_DURATION_MS,
  THROW_VELOCITY_WINDOW_MS
} from './drag-machine'
export type {
  DragEndDragged,
  DragEndNone,
  DragEndResult,
  DragEndTap,
  DragMoveResult,
  DragSample,
  DragTuning
} from './drag-machine'

/* ------------------------------ 摸头 ------------------------------ */
export {
  getPatCenter,
  getPatRadiusBand,
  normalizeAngleRad,
  PAT_COOLDOWN_MS,
  PAT_MAX_SAMPLE_GAP_MS,
  PAT_MAX_STEP_ANGLE_RAD,
  PAT_MIN_SAMPLES,
  PAT_PROGRESS_DECAY_MS,
  PAT_PROGRESS_DECAY_START_MS,
  PAT_TRIGGER_ANGLE_RAD,
  PatDetector,
  PET_PAT_CENTER_Y_RATIO,
  PET_PAT_MAX_RADIUS_RATIO,
  PET_PAT_MIN_RADIUS_RATIO
} from './pat-detector'
export type { PatTuning } from './pat-detector'

/* ------------------------------ 注视 ------------------------------ */
export {
  LOOK_DEADZONE_PX,
  LOOK_IDLE_RELEASE_MS,
  LOOK_MAX_STEP_MS,
  LOOK_TIME_CONSTANT_MS,
  LookTracker
} from './look-tracker'
export type { LookTuning } from './look-tracker'

/* ------------------------------ 右键菜单（模型） ------------------------------ */
export {
  buildMenuItems,
  clampMenuPosition,
  ContextMenuModel,
  DEFAULT_MENU_SIZE,
  MENU_ACTIONS,
  MENU_SAFE_MARGIN_PX
} from './menu-model'
export type {
  MenuAction,
  MenuItemKind,
  MenuItemModel,
  MenuOpenState
} from './menu-model'

/* ------------------------------ 穿透状态机（Wave 1 既有 + B4 forceIntercept 扩展） ------------------------------ */
export {
  computePointerHitRect,
  hitTestPetRect,
  POINTER_HIT_WIDTH_PER_HEIGHT,
  PointerGate
} from './pointer-gate'
export type { PointerGateConfig, PointerPoint } from './pointer-gate'
