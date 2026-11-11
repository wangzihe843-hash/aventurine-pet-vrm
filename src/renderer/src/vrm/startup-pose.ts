/**
 * 启动姿势门控（纯函数，供 `pet-scene-vrm` 使用；单测见 `tests/vrm-startup-pose.test.ts`）。
 *
 * 背景（用户 2026-11-09 复现）：桌宠启动时先闪一瞬「T-pose 还是 A-pose 分不清」的姿势，再变 idle。
 * VRM 模型的 rest 姿势就是规范 T-pose（`user 2026-11-09`；见 `docs/vrm-tpose-repair.md`），
 * 而 idle/walk 等姿势**完全由 clip 每帧写入** normalized humanoid 骨。因此从「模型加载完成」
 * 到「首帧 clip 姿势真正写好」之间必须保持隐藏，否则就会露出 rest T-pose；
 * 这段窗口里若还有从 rest 起步的 crossfade，画面会是「既不像 T 也不像 A」的中间态。
 *
 * 本模块只做纯判定，不持有状态：
 * - `computeModelVisible`：场景层唯一的可见性判定（宠物可见 + 已摆放 + 启动姿势已应用）；
 * - `isStartupPoseApplied`：用动画驱动快照判定「clip 姿势已完整写入」（weight≈1 且非 rest），
 *   而不是「驱动对象存在」——后者在首帧淡入/首帧未就绪时仍会露出 rest；
 * - `startupPoseFallbackDue`：clip 数据缺失/驱动降级时的超时兜底（显示静态 rest，避免永久隐身）。
 */
import type { AnimationDebugSnapshot } from '../core/wave2-contract'

/** 姿势权重达到该值即视为「已完整写入」（浮点容差）。 */
export const STARTUP_POSE_WEIGHT_EPSILON = 1e-3

/** 模型可见性输入（由 `VrmPetScene` 组装）。 */
export interface ModelVisibilityInput {
  /** 宠物是否应显示（非主屏窗口 false）。 */
  petVisible: boolean
  /** 是否已摆放（有 placement；否则位置未知，不应渲染）。 */
  placed: boolean
  /** 启动姿势是否已完整应用（false = 仍处于 rest/T-pose 窗口，必须隐藏）。 */
  startupPoseApplied: boolean
}

/**
 * 场景层唯一的模型可见性判定。
 * 任一条件不满足即隐藏；`startupPoseApplied=false` 时即使宠物应显示也不能露出 rest T/A-pose。
 */
export function computeModelVisible(input: ModelVisibilityInput): boolean {
  return input.petVisible && input.placed && input.startupPoseApplied
}

/**
 * 动画驱动快照是否表示「clip 姿势已完整写入」（可作为显示信号）。
 * - `pose === 'rest'`（无 clip/未就绪）→ false；
 * - `poseWeight < 1−ε`（首帧 crossfade 从 rest 混入中间态）→ false；
 * - 权重非法（NaN/Infinity）→ false。
 */
export function isStartupPoseApplied(
  snapshot: AnimationDebugSnapshot | null | undefined
): boolean {
  if (snapshot === null || snapshot === undefined) return false
  const pose = snapshot.pose
  if (typeof pose !== 'string' || pose.length === 0 || pose === 'rest') return false
  const weight = snapshot.poseWeight
  return Number.isFinite(weight) && weight >= 1 - STARTUP_POSE_WEIGHT_EPSILON
}

/**
 * 启动姿势兜底：从首次等待开始超过 `timeoutMs` 仍未应用 → true（显示静态 rest，避免隐身）。
 * `startedAtMs=null`（尚未开始等待）或时间非法 → false。
 */
export function startupPoseFallbackDue(
  startedAtMs: number | null,
  nowMs: number,
  timeoutMs: number
): boolean {
  if (startedAtMs === null || !Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return false
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return false
  return nowMs - startedAtMs >= timeoutMs
}
