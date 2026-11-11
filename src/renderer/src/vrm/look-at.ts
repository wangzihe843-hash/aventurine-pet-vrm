/**
 * V6 procedural look-at 层：目标模型（aventurine-tpose.vrm）没有 VRM lookAt 扩展
 * （manifest `lookAt.mode='procedural'`），因此用「头/颈/眼球 normalized 骨 additive 旋转」
 * 实现注视指针。
 *
 * 应用顺序（`animator.ts` 组合）：clip-player 写 normalized 骨 → **本层乘 additive 旋转** →
 * `humanoid.update()` → `vrm.update(dt)`。因为 clip 每帧都重写绝对 quaternion，additive 不会累积。
 *
 * 角度来源：`AnimationInput.lookTarget`（窗口本地 px）相对宠物头部锚点的偏移，映射为
 * ±`maxYawDeg`/±`maxPitchDeg`，指数平滑（τ=0.12s）；`lookTarget=null` 时回正。
 * 调试 `setOverride()` 可强制角度（冒烟断言 lookYaw/gaze 用）。
 *
 * ## V7 用户实机反馈（2026-11-08）的两条规则
 * 1. **移动类 mood 不追鼠标**：模型此时已侧身朝运动方向（walk/climb/fall/drag/grabWindow，
 *    见 `core/pet-runtime.ts` 的 `isMovingMood`），若再按鼠标做 additive 头转会变成
 *    「边走路边扭头看镜头」。因此这些 mood（以及 `dragging=true` 的兜底）下目标角固定 0，
 *    头部随身体朝运动方向——走路时头朝走路方向。
 * 2. **静止注视按 facing 做模型局部换算**：模型 root 已按 facing 绕 Y 转 ±90°（
 *    `vrm/pet-scene-vrm.ts` 的 MOVING_FACING_YAW_RAD：left=−90°、right=+90°），本层写的是
 *    骨骼**局部**旋转，必须把指针方向从世界角换算到模型局部：`yaw_local = yaw_world − facingYaw`，
 *    再 clamp 到 ±maxYawDeg；否则侧身静止时会「把世界角度直接加到已转 90° 的头上」。
 *
 * 只在 `lookAt.mode === 'procedural'` 时生效；`vrm`/`none` 模式本层 no-op（不抢内建 applier）。
 * 调试覆盖（`setOverride`）按**模型局部角**理解、不受移动抑制/朝向换算影响（冒烟/验收口径稳定）。
 */
import { Euler, Quaternion } from 'three'

import type { AnimationInput, Facing } from '../core/wave2-contract'
import { isMovingMood } from '../core/pet-runtime'
import type { CreateVrmLookAtOptions, VrmLookAtLayer } from './runtime-types'

/** 注视分布的骨骼权重：颈 + 头转动大部分，眼球补足剩余（1 - HEAD - NECK）。 */
const HEAD_SHARE = 0.45
const NECK_SHARE = 0.25
const EYE_SHARE = 1 - HEAD_SHARE - NECK_SHARE

/** 平滑时间常数（秒）：太小抖、太大像拖影。 */
const SMOOTH_TAU_SEC = 0.12

/** 单帧 dt 上限（与场景层一致）。 */
const MAX_DELTA_SEC = 0.1

/**
 * 朝向 → 模型 root 绕 Y 的目标转角（度）。
 *
 * 必须与 `vrm/pet-scene-vrm.ts` 的 `MOVING_FACING_YAW_RAD` 同号同值：
 * `setFacing('left') = −π/2`、`setFacing('right') = +π/2`、`front = 0`。
 * 用于把世界方向的指针角换算到模型局部（`yaw_local = yaw_world − facingYaw`）。
 */
export const FACING_YAW_DEG: Readonly<Record<Facing, number>> = {
  front: 0,
  left: -90,
  right: 90
}

/** 朝向对应的模型 root Y 转角（度；见 {@link FACING_YAW_DEG}）。 */
export function facingYawDeg(facing: Facing | null | undefined): number {
  return FACING_YAW_DEG[facing ?? 'front'] ?? 0
}

/**
 * 指针水平偏移 → 「世界」yaw 角（度；正值 = 屏幕右，范围 (−90, 90)）。
 *
 * 深度基准取 `0.55 × rectWidth / tan(maxYawDeg)`：
 * - 这使 `dx = 0.55 × 宽` 时 angle 正好等于 maxYawDeg（与 V1 线性映射的饱和点/观感一致）；
 * - maxYawDeg=0 或非法时退化为 maxYaw 不生效（目标角随后 clamp 到 0），不产生 NaN。
 */
export function pointerWorldYawDeg(
  offsetX: number,
  rectWidth: number,
  maxYawDeg: number
): number {
  if (!Number.isFinite(offsetX)) return 0
  const width = Number.isFinite(rectWidth) && rectWidth > 0 ? rectWidth : 1
  const maxYawRad = (Math.max(1e-3, Math.abs(maxYawDeg)) * Math.PI) / 180
  const depthPx = (width * 0.55) / Math.tan(maxYawRad)
  return (Math.atan2(offsetX, Math.max(1, depthPx)) * 180) / Math.PI
}

/** 本帧是否应停止鼠标注视（移动类 mood / 拖拽中）。 */
export function shouldSuppressMouseLook(
  mood: AnimationInput['mood'],
  dragging: boolean
): boolean {
  return dragging === true || isMovingMood(mood)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 创建 procedural look-at 层。 */
export function createVrmLookAtLayer(options: CreateVrmLookAtOptions): VrmLookAtLayer {
  const { avatar } = options
  const mode = avatar.asset.lookAt?.mode ?? 'none'
  const maxYawDeg = Math.max(0, avatar.asset.lookAt?.maxYawDeg ?? 35)
  const maxPitchDeg = Math.max(0, avatar.asset.lookAt?.maxPitchDeg ?? 20)
  const active = mode === 'procedural'

  const humanoid = avatar.vrm.humanoid
  const neckNode = humanoid?.getNormalizedBoneNode('neck') ?? null
  const headNode = humanoid?.getNormalizedBoneNode('head') ?? null
  const leftEyeNode = humanoid?.getNormalizedBoneNode('leftEye') ?? null
  const rightEyeNode = humanoid?.getNormalizedBoneNode('rightEye') ?? null
  /**
   * 模型自带的 VRM lookAt（aventurine-tpose 实测 `type='bone'` 的 VRMLookAtBoneApplier）：
   * 直接写 `lookAt.yaw/pitch`（autoUpdate=false），由 `vrm.update(dt)` 驱动眼球；
   * 这样不必手动推眼球骨，也不与内建 applier 打架。
   */
  const builtinLookAt = avatar.vrm.lookAt ?? null
  if (builtinLookAt) builtinLookAt.autoUpdate = false

  const headQuat = new Quaternion()
  const neckQuat = new Quaternion()
  const eyeQuat = new Quaternion()
  const euler = new Euler(0, 0, 0, 'YXZ')

  let yawDeg = 0
  let pitchDeg = 0
  let overrideYaw: number | null = null
  let overridePitch: number | null = null
  let disposed = false

  const applyBone = (
    node: typeof headNode,
    yaw: number,
    pitch: number,
    out: Quaternion
  ): void => {
    if (!node) return
    euler.set((pitch * Math.PI) / 180, (yaw * Math.PI) / 180, 0, 'YXZ')
    out.setFromEuler(euler)
    node.quaternion.multiply(out)
  }

  const update = (input: AnimationInput): void => {
    if (!active || disposed) return
    if (!headNode && !neckNode) return

    const usingOverride = overrideYaw !== null || overridePitch !== null
    let targetYaw = 0
    let targetPitch = 0
    if (usingOverride) {
      // 调试覆盖：按模型局部角理解（不叠加朝向换算/移动抑制），冒烟断言口径稳定。
      targetYaw = clamp(overrideYaw ?? 0, -maxYawDeg, maxYawDeg)
      targetPitch = clamp(overridePitch ?? 0, -maxPitchDeg, maxPitchDeg)
    } else if (shouldSuppressMouseLook(input.mood, input.dragging === true)) {
      // V7 规则 1：移动/拖拽中不追鼠标，头随身体朝运动方向（facing 由场景侧身表现）。
      // 目标角保持 0（下面同样走平滑，避免切 mood 时头部瞬间回正）。
    } else if (input.lookTarget !== null && input.petRect.height > 0) {
      const rect = input.petRect
      // 头部锚点：宠物矩形上部（≈ 头顶下 12% 高度）；纵向偏移按高度归一化到 [-1,1]。
      const anchorX = rect.x + rect.width / 2
      const anchorY = rect.y + rect.height * 0.12
      const unitY = clamp((input.lookTarget.y - anchorY) / Math.max(1, rect.height * 0.4), -1, 1)
      // 指针方向的「世界」yaw：把头部到指针的水平偏移换算成真实角度（正值 = 屏幕右）。
      // 深度基准取 `0.55 × 宽 / tan(maxYaw)`，使 dx=0.55×宽 处正好达到 maxYaw——
      // 与 V1 线性映射的转头观感基本一致（正面朝镜头时几乎无差别）；但它是真角度，
      // 才能做下面的朝向局部化（侧身时把 90° 朝向角减掉）。
      const worldYawDeg = pointerWorldYawDeg(input.lookTarget.x - anchorX, rect.width, maxYawDeg)
      // V7 规则 2：模型 root 已按 facing 转 ±90° → 换算到模型局部再钳制。
      targetYaw = clamp(worldYawDeg - facingYawDeg(input.facing), -maxYawDeg, maxYawDeg)
      // 屏幕 y 向下 → 指针在上方 = 抬头（pitch 正）；pitch 不受 Y 轴朝向旋转影响。
      targetPitch = -unitY * maxPitchDeg
    }

    if (usingOverride) {
      yawDeg = targetYaw
      pitchDeg = targetPitch
    } else {
      const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, MAX_DELTA_SEC)
      const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_SEC)
      yawDeg += (targetYaw - yawDeg) * alpha
      pitchDeg += (targetPitch - pitchDeg) * alpha
    }

    // 分布：颈 25% + 头 45%；剩余由眼球补足（相对头已转过的角度）。
    const headYaw = yawDeg * HEAD_SHARE
    const headPitch = pitchDeg * HEAD_SHARE
    // 头/颈骨局部 +X 旋转方向：对面向 +Z 的骨骼，+X 是低头 → 传 -pitch 才能「向上看」。
    // 用户 2026-11-09 实机反馈「左右对、上下反」即此处符号（内建眼球 applier 的 +pitch = 向上，
    // 见 three-vrm VRMLookAtBoneApplier：pitch>0 走 rangeMapVerticalUp）。
    applyBone(neckNode, yawDeg * NECK_SHARE, -pitchDeg * NECK_SHARE, neckQuat)
    applyBone(headNode, headYaw, -headPitch, headQuat)

    const residualYaw = clamp(yawDeg * EYE_SHARE, -maxYawDeg, maxYawDeg)
    const residualPitch = clamp(pitchDeg * EYE_SHARE, -maxPitchDeg, maxPitchDeg)
    if (builtinLookAt) {
      // 内建 applier 在 vrm.update() 内应用（rangeMap 会再按模型自身 outputScale 缩放）。
      builtinLookAt.yaw = residualYaw
      builtinLookAt.pitch = residualPitch
    } else if (leftEyeNode || rightEyeNode) {
      euler.set((residualPitch * Math.PI) / 180, (residualYaw * Math.PI) / 180, 0, 'YXZ')
      eyeQuat.setFromEuler(euler)
      if (leftEyeNode) leftEyeNode.quaternion.multiply(eyeQuat)
      if (rightEyeNode) rightEyeNode.quaternion.multiply(eyeQuat)
    }
  }

  return {
    update,
    setOverride(nextYawDeg, nextPitchDeg): void {
      overrideYaw = typeof nextYawDeg === 'number' && Number.isFinite(nextYawDeg) ? nextYawDeg : null
      overridePitch =
        typeof nextPitchDeg === 'number' && Number.isFinite(nextPitchDeg) ? nextPitchDeg : null
    },
    snapshot(): { yaw: number | null; pitch: number | null } {
      if (!active) return { yaw: null, pitch: null }
      return { yaw: yawDeg, pitch: pitchDeg }
    },
    dispose(): void {
      disposed = true
    }
  }
}
