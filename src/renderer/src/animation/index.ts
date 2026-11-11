/**
 * B3 动画/姿态/表情系统入口（Lead 接线用）。
 *
 * ```ts
 * import { createPetAnimator } from './animation'
 * const animator = createPetAnimator({ mesh, root })
 * // PetScene.step 内、渲染前：
 * animator.update({ ...animationInput, dt })
 * debug.animation = animator.getDebugSnapshot()
 * ```
 *
 * 架构（`docs/anim-tech-survey.md` 方案 B，`src/renderer/src/animation/README.md` 有完整说明）：
 * - 纯逻辑管线 `pipeline.ts`（Node 可单测，不 import three）；
 * - three 适配只在 `scene-bridge.ts`（唯一 import three 的文件）；
 * - 姿态表 + 分层混合 + 解析二骨 IK + 发辫弹簧 + 表情调度全部纯函数化。
 */
export {
  createPetAnimator,
  type CreatePetAnimatorOptions,
  type PetAnimator
} from './legacy/scene-bridge'

/* ------------------- Wave 2.5：外部 VMD 动作层（D1） ------------------- */
// 混合驱动门面：VMD 外部动作 + B3 程序化/表情组合。main.ts 的 createPoseDriver 用这个工厂。
export {
  createHybridAnimator,
  type CreateHybridAnimatorOptions,
  type HybridAnimator,
  type HybridExternalState
} from './legacy/external/vmd-driver'
// 运行期动作清单（motion-index.json）：纯函数解析/校验 + 类型。
export {
  parseMotionIndex,
  emptyMotionManifest,
  isSingleSegmentVmdFileName,
  MOTION_MANIFEST_FILE,
  MOTION_SCHEMA_VERSION,
  PET_MOODS,
  DEFAULT_CROSSFADE_MS,
  MIN_CROSSFADE_MS,
  MAX_CROSSFADE_MS,
  type GroundingMode,
  type SeatedAnchor,
  type IkMode,
  type MotionClipDef,
  type MotionManifest,
  type ParseMotionIndexResult
} from './legacy/external/manifest'
// VMD 加载/处理与选择逻辑（供调试/单测/后续 D3 走路复用）。
export {
  loadVmdClip,
  processVmdData,
  createVmdClipLoader,
  setHelperIkMode,
  VMD_FRAME_RATE,
  ROOT_MOTION_BONES,
  type LoadVmdClipOptions,
  type VmdClipInfo
} from './legacy/external/vmd-clip'
export {
  selectClipForMood,
  resolvePlaybackRate,
  horizontalSpeedOf,
  clampCrossfadeMs,
  isIkEnabled,
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE
} from './legacy/external/selection'
export {
  expectedFootGroundWorldY,
  groundingOffsetLocalY,
  footGroundingErrorPx,
  lowestFootWorldY,
  FOOT_GROUND_TOLERANCE_PX
} from './legacy/external/grounding'
// D4b：VMD 激活时的 additive look-at（头/颈 30% + 眼球 100%；语义对齐 B3 look-at.ts）。
export {
  VmdLookAtController,
  resolveVmdLookAtTarget,
  VMD_LOOK_AT_HEAD_SCALE,
  VMD_LOOK_AT_EYE_SCALE,
  type VmdLookAtInput,
  type VmdLookAtResult,
  type VmdLookAtTargetInput,
  type VmdLookAtTargetResult
} from './legacy/external/vmd-look-at'

export { AnimationPipeline, ANIMATION_POSE_IDS, type AnimationFrameOutput, type PipelineRig } from './legacy/pipeline'
export { BASE_POSES, BASE_POSE_META, BASE_POSE_IDS, ALL_GESTURES, IDLE_VARIANTS, sampleGesture } from './legacy/poses'
export { POSE_CONTROLLED_BONES, FORBIDDEN_BONES, REQUIRED_BONES, SPRING_BONES, validatePoseTable } from './legacy/skeleton'
export { GAZE_LIMITS, GAZE_LAYER_TAU, distributeGaze, pointerToGaze } from './legacy/look-at'
export {
  computeMicroMotion,
  computeIdleHeadDrift,
  microScaleFor,
  MICRO_SCALE_BY_MODE,
  DEFAULT_MICRO_SCALE
} from './legacy/micro-motion'
export { computeFootCycle, computeWalkOffsets, computeClimbOffsets, WALK_STRIDE, WALK_LIFT } from './legacy/gait'
export { mixEmotions, EMOTION_DEFS } from './legacy/emotion'
export { textToVisemes, stepViseme } from './legacy/viseme'
export { solveLegSagittal, createLegGeometry } from './legacy/leg-ik'
export { solveGrounding, createGroundingRig } from './legacy/grounding'
export { stepSpringChain, createSpringChainState } from './legacy/spring'
export { MOOD_TO_POSE, IdleDirector, pickReaction } from './legacy/state-map'
export type {
  EulerDeg,
  Euler3,
  FootOffset,
  GazeTarget,
  GestureDef,
  GestureKeyframe,
  PoseDef,
  PoseMeta,
  PoseQuats,
  Quat,
  Vec3
} from './legacy/types'
export type { AnimationDebugSnapshot, AnimationEvent, AnimationInput } from '../core/wave2-contract'
