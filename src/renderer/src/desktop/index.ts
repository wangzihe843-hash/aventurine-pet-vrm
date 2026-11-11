/**
 * B5 桌面感知消费（`src/renderer/src/desktop/**`）对外出口。
 *
 * 纯逻辑模块：不 import DOM / Electron / node 内置，可在 vitest node 环境直接单测。
 * Lead 接线方式见同目录 `README.md`；数据契约见 `core/wave2-contract.ts`。
 *
 * 典型用法：
 * ```ts
 * import { DesktopSensor } from './desktop'
 * const desktopSensor = new DesktopSensor()
 * // 订阅 windows-updated 后先 invoke('pet:windows') 取基线
 * // 每帧：desktopSensor.snapshot(nowMs) → BehaviorInput.desktop
 * ```
 */
export {
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_SITTABLE_GAP_PX,
  DesktopSensor
} from './sensor'
export type { DesktopSensorEnvironment, DesktopSensorOptions, PlacementTarget } from './sensor'

export {
  DOCK_BOTTOM_SURFACE_ID,
  DOCK_LEFT_SURFACE_ID,
  DOCK_RIGHT_SURFACE_ID,
  MENUBAR_SURFACE_ID,
  SCREEN_BOTTOM_SURFACE_ID,
  computeDisplayInsets,
  createWindowSurfaces,
  deriveSystemSurfaces,
  globalToLocalPoint,
  globalToLocalRect,
  horizontalOverlapWidth,
  isFiniteNumber,
  isValidRect,
  rectContainsPoint,
  rectsIntersect,
  sanitizeRect,
  ZERO_RECT
} from './geometry'
export type { DisplayInsets } from './geometry'

export {
  MIN_WINDOW_ALPHA,
  MIN_WINDOW_HEIGHT_PX,
  NORMAL_WINDOW_LAYER,
  filterWindows,
  isEligibleWindow,
  sanitizeWindows
} from './filter'
export type { WindowFilterOptions } from './filter'

export { coalesceTransitions, diffWindowLists, sameBounds } from './transitions'
export type { DiffWindowOptions } from './transitions'
