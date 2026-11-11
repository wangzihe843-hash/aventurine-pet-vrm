/**
 * VMD 激活时的 **additive look-at**（头/颈/眼球跟随鼠标）—— 纯逻辑，不 import three（Node 可单测）。
 *
 * 背景（Wave 2.5 / D4b）：
 * VMD 激活时 B3 只写 morph（骨骼写入关闭）以避免双写；代价是 B3 的 look-at 不再生效。
 * 本模块只算「要叠加到 clip 本帧绝对姿态上的局部旋转增量」，由 `vmd-driver.ts` 在
 * `helper.update()` 之后右乘到 `首 / 頭 / 左目先 / 右目先`（`bone.quaternion.multiply(delta)`，
 * local-space additive）：每帧都基于 clip 本帧绝对姿态重新叠加，**不会累积**。
 *
 * 语义与 B3 `look-at.ts` 对齐（复用其纯函数，不改 B3 文件）：
 * - 鼠标 → `pointerToGaze`（死区 40px、深度按宠物高度）→ `localizeGaze`（facing left/right 时
 *   减掉 ±90° 朝向角 + センター身体 Y 转角）→ `clampGaze`（yaw ±31°、pitch [−20°, +26°]）；
 * - 逐层延迟 `GAZE_LAYER_TAU`：眼 50ms、颈 120ms、头 170ms（眼睛先看到，头慢慢跟过去）；
 * - 总注视方向 τ=90ms 指数平滑；鼠标离开后 2.5s 内平滑回落到 0；
 * - **additive 权重**：头/颈只叠加分配角的 30%（避免和 VMD clip 自带头部动作打架），
 *   眼球叠加 100%（`目先` 权重 502/502，是唯一有效眼球骨）。
 *
 * 输出约定：`neck/head/eye` 是 **YXZ 欧拉角（弧度）**，x = pitch、y = yaw、z = 0；
 * 与 B3 的 `eulerToQuat` 口径一致（本模型 `左目先/右目先` 局部轴与 B3 相同）。
 */

import { clamp, damp, dampGaze } from '../quat'
import {
  clampGaze,
  distributeGaze,
  GAZE_LIMITS,
  GAZE_LAYER_TAU,
  GAZE_TAU_SEC,
  GAZE_TIMEOUT_MS,
  localizeGaze,
  pointerToGaze
} from '../look-at'
import { MAX_DT_SEC, type Euler3, type GazeTarget } from '../types'

/** 头/颈 additive 缩放（30%）：VMD 动作本身已有头部表演，叠加过多会「抢戏/扭脖子」。 */
export const VMD_LOOK_AT_HEAD_SCALE = 0.3

/** 眼球 additive 缩放（100%）：眼睛跟随是最强的「活物感」，且不改变头颈 clip 姿态。 */
export const VMD_LOOK_AT_EYE_SCALE = 1

/** 无宠物矩形时注视深度的兜底（px；与 B3 的 `max(60, height*0.9)` 下限一致）。 */
const FALLBACK_DEPTH_PX = 60

/** VMD look-at 每帧输入（窗口本地 CSS px，与 `AnimationInput` 同口径）。 */
export interface VmdLookAtInput {
  /** 鼠标目标（窗口本地 px；null = 无目标 → 平滑回落）。 */
  lookTarget: { x: number; y: number } | null
  /** 当前宠物矩形（窗口本地 px、y 向下）；取中心 x + 顶部 10% 作头部中心。 */
  petRect: { x: number; y: number; width: number; height: number } | null
  /** 朝向（left/right 时模型 root 绕 Y ±90°，需把世界角局部化）。 */
  facing: 'left' | 'right' | 'front'
  /** 本帧 dt（秒；内部再钳制到 [0, 0.1]）。 */
  dt: number
  /** 单调时钟毫秒（超时回落用）。 */
  nowMs: number
  /** センター 本帧世界 Y 转角（弧度；VMD clip 的 3/4 侧身，局部化时减掉；默认 0）。 */
  bodyYawRad?: number
}

/** VMD look-at 输出（供 driver 右乘到骨骼）。 */
export interface VmdLookAtResult {
  /** 首（颈）additive 欧拉（弧度；已 ×0.3） */
  neck: Euler3
  /** 頭 additive 欧拉（弧度；已 ×0.3） */
  head: Euler3
  /** 左目先/右目先 additive 欧拉（弧度；已 ×1.0） */
  eye: Euler3
  /** 平滑后的总注视角（弧度；未钳制前/后即 clamp 后；调试快照用，与 B3 口径一致）。 */
  gaze: GazeTarget
  /** 调试 lookYaw（−1..1，左负右正；null = 无注视/已回落），与 B3 语义一致。 */
  lookYaw: number | null
  /** 当前是否仍有注视（含 2.5s 回落残余）。 */
  active: boolean
}

/** `resolveVmdLookAtTarget` 输入。 */
export interface VmdLookAtTargetInput {
  lookTarget: { x: number; y: number } | null
  petRect: { x: number; y: number; width: number; height: number } | null
  facing: 'left' | 'right' | 'front'
  /** センター 本帧世界 Y 转角（弧度；局部化时减掉；默认 0）。 */
  bodyYawRad?: number
}

/** `resolveVmdLookAtTarget` 结果。 */
export interface VmdLookAtTargetResult {
  /** 本帧目标注视（已局部化 + 钳制；无目标/超时后为 0）。 */
  target: GazeTarget
  /** 本帧是否有直接注视源（鼠标 / 强制注视）；false 时处于回落窗口或完全无注视。 */
  hasDirectTarget: boolean
  /** 头部中心（窗口本地 px；调试/测试用）。 */
  headCenter: { x: number; y: number }
  /** 注视深度（px；鼠标横向偏移 → 角度的换算基准）。 */
  depthPx: number
}

function sanitizeDt(dt: number): number {
  return Number.isFinite(dt) ? Math.min(MAX_DT_SEC, Math.max(0, dt)) : 0
}

/**
 * 计算本帧目标注视（纯函数，不含平滑/状态）：
 * 鼠标 → 头部中心/深度 → pointerToGaze → 朝向局部化（facing ±90° + 身体 Y 转角）→ 钳制。
 *
 * 无鼠标目标时返回 0 目标 + `hasDirectTarget=false`；2.5s 回落窗口与平滑由控制器处理。
 */
export function resolveVmdLookAtTarget(input: VmdLookAtTargetInput): VmdLookAtTargetResult {
  const petRect = input.petRect
  const hasValidRect =
    Boolean(petRect) &&
    Number.isFinite(petRect!.x) &&
    Number.isFinite(petRect!.y) &&
    Number.isFinite(petRect!.width) &&
    Number.isFinite(petRect!.height) &&
    petRect!.width > 0 &&
    petRect!.height > 0
  const rectWidth = hasValidRect ? petRect!.width : 0
  const rectHeight = hasValidRect ? petRect!.height : 0
  const headCenter = {
    x: hasValidRect ? petRect!.x + rectWidth / 2 : 0,
    y: hasValidRect ? petRect!.y + rectHeight * 0.1 : 0
  }
  const depthPx = Math.max(FALLBACK_DEPTH_PX, rectHeight * 0.9)

  const pointer = input.lookTarget
  // 宠物矩形缺失/非法（未摆放）时无法定位头部 → 视为无直接目标（平滑回 0），不猜。
  if (hasValidRect && pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
    const raw = pointerToGaze(pointer, headCenter, depthPx)
    const facing = input.facing ?? 'front'
    const bodyYaw = Number.isFinite(input.bodyYawRad) ? input.bodyYawRad! : 0
    return {
      target: clampGaze(localizeGaze(raw, facing, bodyYaw)),
      hasDirectTarget: true,
      headCenter,
      depthPx
    }
  }

  // 无直接目标：目标角为 0（是否仍算「活跃」由控制器按 2.5s 超时窗口判断）。
  return {
    target: { yaw: 0, pitch: 0 },
    hasDirectTarget: false,
    headCenter,
    depthPx
  }
}

/** 逐分量指数平滑（保持 look-at.ts 的逐层 lag 语义）。 */
function dampEuler(prev: Euler3, next: Euler3, dt: number, tau: number): Euler3 {
  return {
    x: damp(prev.x, next.x, dt, tau),
    y: damp(prev.y, next.y, dt, tau),
    z: damp(prev.z, next.z, dt, tau)
  }
}

function scaleEuler(euler: Euler3, scale: number): Euler3 {
  return { x: euler.x * scale, y: euler.y * scale, z: euler.z * scale }
}

function zeroEuler(): Euler3 {
  return { x: 0, y: 0, z: 0 }
}

/**
 * VMD additive look-at 状态机（持有 90ms 总平滑 + 首/頭/目先 逐层 lag 状态）。
 *
 * 使用方式（driver 每帧）：`controller.update({...})` → 把 `neck/head/eye` 右乘到对应骨。
 * 离开 VMD / 重挂 clip 时 `reset()`；`setForced` 用于 `debugSetGaze`（度；NaN 清除）。
 */
export class VmdLookAtController {
  private current: GazeTarget = { yaw: 0, pitch: 0 }
  private neckRaw: Euler3 = zeroEuler()
  private headRaw: Euler3 = zeroEuler()
  private eyeRaw: Euler3 = zeroEuler()
  private lastTargetAtMs = -Infinity
  private force: GazeTarget | null = null

  /** 重置平滑状态（切换 clip/退出 VMD/异常回退时调用；不清除 setForced 的强制注视）。 */
  reset(): void {
    this.current = { yaw: 0, pitch: 0 }
    this.neckRaw = zeroEuler()
    this.headRaw = zeroEuler()
    this.eyeRaw = zeroEuler()
    this.lastTargetAtMs = -Infinity
  }

  /** 调试强制注视（度；NaN/Infinity 清除）。语义同 B3：按身体局部角理解（不叠加 bodyYaw）。 */
  setForced(yawDeg: number, pitchDeg: number): void {
    if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) {
      this.force = null
      return
    }
    this.force = {
      yaw: (yawDeg * Math.PI) / 180,
      pitch: (pitchDeg * Math.PI) / 180
    }
  }

  /** 是否处于调试强制注视。 */
  get isForced(): boolean {
    return this.force !== null
  }

  /** 每帧更新，返回要右乘到骨骼的 additive 欧拉角 + 调试快照字段。 */
  update(input: VmdLookAtInput): VmdLookAtResult {
    const dt = sanitizeDt(input.dt)
    const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0
    const facing = input.facing ?? 'front'
    let target: GazeTarget = { yaw: 0, pitch: 0 }
    let active = false

    if (this.force) {
      // 调试强制注视：B3 语义是身体局部角（只看 facing，不叠加 bodyYaw）。
      target = clampGaze(localizeGaze(this.force, facing))
      active = true
      this.lastTargetAtMs = nowMs
    } else {
      const resolved = resolveVmdLookAtTarget({
        lookTarget: input.lookTarget,
        petRect: input.petRect,
        facing,
        bodyYawRad: input.bodyYawRad
      })
      target = resolved.target
      if (resolved.hasDirectTarget) {
        active = true
        this.lastTargetAtMs = nowMs
      } else if (nowMs - this.lastTargetAtMs <= GAZE_TIMEOUT_MS) {
        // 刚离开鼠标：2.5s 内保持 active，目标 0 → current 平滑回落到 0。
        active = true
      }
    }

    // 总注视 τ=90ms；再按「眼 50ms / 颈 120ms / 头 170ms」逐层延迟分配。
    this.current = dampGaze(this.current, target, dt, GAZE_TAU_SEC)
    const distribution = distributeGaze(this.current)
    this.neckRaw = dampEuler(this.neckRaw, distribution.neck, dt, GAZE_LAYER_TAU.neck)
    this.headRaw = dampEuler(this.headRaw, distribution.head, dt, GAZE_LAYER_TAU.head)
    this.eyeRaw = dampEuler(this.eyeRaw, distribution.eye, dt, GAZE_LAYER_TAU.eye)

    const neck = scaleEuler(this.neckRaw, VMD_LOOK_AT_HEAD_SCALE)
    const head = scaleEuler(this.headRaw, VMD_LOOK_AT_HEAD_SCALE)
    const eye = scaleEuler(this.eyeRaw, VMD_LOOK_AT_EYE_SCALE)

    const hasResidual = Math.abs(this.current.yaw) > 0.02 || Math.abs(this.current.pitch) > 0.02
    const lookYaw =
      active || hasResidual ? clamp(this.current.yaw / GAZE_LIMITS.yawAbs, -1, 1) : null

    return {
      neck,
      head,
      eye,
      gaze: { ...this.current },
      lookYaw,
      active: active || hasResidual
    }
  }
}
