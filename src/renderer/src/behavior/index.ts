/**
 * B1 行为层公共出口（`src/renderer/src/behavior`）。
 *
 * Lead 接线（`main.ts`）只需要：
 * ```ts
 * import { BehaviorDirector } from './behavior'
 * ```
 * 其余导出供调试/单测/README 使用（活动表、台词池、可复现随机源）。
 *
 * 约束：本目录（`mischief.ts` 除外）归 B1；不 import DOM/three/Electron/Node 内置；
 * 跨模块类型只引用 `../core/wave2-contract`（Lead 冻结）。
 */
export { BehaviorDirector } from './behavior-director'
export {
  ACTIVITY_DEFINITIONS,
  LEVEL_PACE,
  SLEEP_MIN_IDLE_MS,
  SLEEP_MIN_SINCE_INTERACTION_MS,
  countCoolingActivities,
  findActivityDefinition,
  isRequirementMet,
  pickWeightedActivity,
  scoreActivity
} from './activities'
export type { LevelPace } from './activities'
export {
  BUBBLE_LINES,
  BubbleGate,
  DEFAULT_BUBBLE_COOLDOWNS,
  collectAllBubbleLines
} from './dialogue'
export type { BubbleCategory, BubbleGateOptions } from './dialogue'
export { createSeededRandom, randomInt, randomRange, readRandom, sanitizeRandom } from './random'
export type {
  ActivityDefinition,
  ActivityId,
  ActivityRequirement,
  BehaviorDirectorOptions,
  LookMode,
  PreparedActivity,
  SchedulerContext
} from './types'
