/**
 * 注视（look-at）纯函数 + 状态机（**不 import three/DOM**）。
 *
 * 方案（`docs/anim-tech-survey.md` §6.1）：
 * - 层级：`首` ≤12°、`頭` ≤18°、`左目先/右目先` ≤25°（合计可达 55°，够用且不「翻白眼」）；
 * - 写 `目先` 而不是 `両目`（眼骨权重 100% 在 `目先` 上；`両目` 有效增益只有 0.3）；
 * - 死区：鼠标在宠物头部中心 ±40px 内不转（避免「盯着你」的诡异感）；
 * - 平滑：指数平滑 τ=90ms，与帧率无关；鼠标离开后平滑回落（2.5s 超时后完全归零）；
 * - 上限：yaw ∈ [−31°, 31°]、pitch ∈ [−20°, 26°]（低头少、抬头多）。
 *
 * 朝向（facing）处理：若 Lead 在 root 层把模型转向 left/right（绕 Y ±90°），
 * 注视角应减去朝向角（局部化）；`front` 时为 0。B3 不写 root，所以只做数学换算。
 */
import { clamp, dampGaze } from './quat'
import type { Euler3, GazeTarget } from './types'

/** 注视角度上限（弧度；来自 survey §6.1）。 */
export const GAZE_LIMITS = {
  /** 总 yaw 上限 ±31°。 */
  yawAbs: (31 * Math.PI) / 180,
  /** 低头下限（−20°）。 */
  pitchMin: (-20 * Math.PI) / 180,
  /** 抬头上限（+26°）。 */
  pitchMax: (26 * Math.PI) / 180,
  /** 颈（首）上限 ±12°。 */
  neckAbs: (12 * Math.PI) / 180,
  /** 头（頭）上限 ±18°。 */
  headAbs: (18 * Math.PI) / 180,
  /** 眼球（目先）上限 ±25°。 */
  eyeAbs: (25 * Math.PI) / 180
} as const

/** 死区半径（窗口本地 CSS px；宠物头部中心 ±40px）。 */
export const GAZE_DEADZONE_PX = 40

/** 鼠标离开后完全归零的超时（毫秒；survey §6.1「2.5s 后回落」）。 */
export const GAZE_TIMEOUT_MS = 2500

/** 平滑时间常数（秒）。 */
export const GAZE_TAU_SEC = 0.09

/** 注视分配结果（弧度；各层为**局部**附加角度，x = pitch、y = yaw）。 */
export interface GazeDistribution {
  /** 颈（首）。 */
  neck: Euler3
  /** 头（頭）。 */
  head: Euler3
  /** 眼球（目先）。 */
  eye: Euler3
}

/** 鼠标窗口本地坐标 → 「看向」目标方向角（弧度；未钳制）。 */
export function pointerToGaze(
  pointer: { x: number; y: number },
  headCenter: { x: number; y: number },
  depthPx: number,
  deadzonePx = GAZE_DEADZONE_PX
): GazeTarget {
  const depth = Math.max(1, depthPx)
  let dx = pointer.x - headCenter.x
  let dy = pointer.y - headCenter.y
  const dist = Math.hypot(dx, dy)
  if (dist < deadzonePx) return { yaw: 0, pitch: 0 }
  // 死区外按比例放大：从死区边缘开始线性过渡，避免边界跳变。
  const scale = (dist - deadzonePx) / dist
  dx *= scale
  dy *= scale
  return {
    yaw: Math.atan2(dx, depth),
    // 屏幕 y 向下：鼠标在头下方 → 低头（pitch 正）。
    pitch: Math.atan2(dy, depth)
  }
}

/** 角度归一化到 (−π, π]。 */
export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  let value = angle % (2 * Math.PI)
  if (value > Math.PI) value -= 2 * Math.PI
  if (value <= -Math.PI) value += 2 * Math.PI
  return value
}

/** 钳制注视到模型可视上限（yaw ±31°、pitch [−20°, +26°]）。 */
export function clampGaze(gaze: GazeTarget): GazeTarget {
  return {
    yaw: clamp(gaze.yaw, -GAZE_LIMITS.yawAbs, GAZE_LIMITS.yawAbs),
    pitch: clamp(gaze.pitch, GAZE_LIMITS.pitchMin, GAZE_LIMITS.pitchMax)
  }
}

/** 朝向 → root 绕 Y 转角的近似（front = 0；left = −90°、right = +90°）。 */
export function facingTurnRad(facing: 'left' | 'right' | 'front'): number {
  if (facing === 'right') return Math.PI / 2
  if (facing === 'left') return -Math.PI / 2
  return 0
}

/**
 * 把世界方向角换算到模型局部（减去朝向角 + 身体 3/4 侧身角）。
 * @param bodyYawRad センター 的 Y 旋转（弧度；3/4 侧身，正 = 面朝屏幕右）
 */
export function localizeGaze(
  gaze: GazeTarget,
  facing: 'left' | 'right' | 'front',
  bodyYawRad = 0
): GazeTarget {
  const turn = facingTurnRad(facing)
  const offset = turn + bodyYawRad
  if (offset === 0) return gaze
  return { yaw: wrapAngle(gaze.yaw - offset), pitch: gaze.pitch }
}

/**
 * 把总注视角分配给 首/頭/目先（各自上限内，逐级消耗）。
 * 比例：颈先拿 30%、头拿剩余 55%、眼拿剩余；每级钳制到自身上限。
 */
export function distributeGaze(gaze: GazeTarget): GazeDistribution {
  const g = clampGaze(gaze)
  const neckYaw = clamp(g.yaw * 0.3, -GAZE_LIMITS.neckAbs, GAZE_LIMITS.neckAbs)
  const remainYaw1 = g.yaw - neckYaw
  const headYaw = clamp(remainYaw1 * 0.55, -GAZE_LIMITS.headAbs, GAZE_LIMITS.headAbs)
  const eyeYaw = clamp(remainYaw1 - headYaw, -GAZE_LIMITS.eyeAbs, GAZE_LIMITS.eyeAbs)

  const neckPitch = clamp(g.pitch * 0.3, -GAZE_LIMITS.neckAbs, GAZE_LIMITS.neckAbs)
  const remainPitch1 = g.pitch - neckPitch
  const headPitch = clamp(remainPitch1 * 0.55, -GAZE_LIMITS.headAbs, GAZE_LIMITS.headAbs)
  const eyePitch = clamp(remainPitch1 - headPitch, -GAZE_LIMITS.eyeAbs, GAZE_LIMITS.eyeAbs)

  return {
    neck: { x: neckPitch, y: neckYaw, z: 0 },
    head: { x: headPitch, y: headYaw, z: 0 },
    eye: { x: eyePitch, y: eyeYaw, z: 0 }
  }
}

/** 逐分量指数平滑（用于注视三层的延迟）。 */
function dampEuler(prev: Euler3, next: Euler3, dt: number, tau: number): Euler3 {
  const alpha = tau > 1e-6 ? 1 - Math.exp(-Math.max(0, dt) / tau) : 1
  return {
    x: prev.x + (next.x - prev.x) * alpha,
    y: prev.y + (next.y - prev.y) * alpha,
    z: prev.z + (next.z - prev.z) * alpha
  }
}

/** 注视控制器输入。 */
export interface GazeUpdateInput {
  /** 鼠标目标（窗口本地 CSS px；null = 无目标）。 */
  lookTarget: { x: number; y: number } | null
  /** 宠物头部中心（窗口本地 CSS px）。 */
  headCenter: { x: number; y: number }
  /** 注视深度（px；用宠物高度估计，决定鼠标横向偏移映射成多少度）。 */
  depthPx: number
  /** 朝向（局部化角用）。 */
  facing: 'left' | 'right' | 'front'
  /** 本帧 dt（秒）。 */
  dt: number
  /** 单调时钟毫秒（注入；用于 2.5s 超时）。 */
  nowMs: number
  /** 强制注视（setGaze / 手势 gaze；度；优先级最高；null = 无）。 */
  forced?: { yawDeg: number; pitchDeg: number } | null
  /** 身体 3/4 侧身角（弧度；センター Y 旋转，注视要减掉它才能对准镜头/鼠标）。 */
  bodyYawRad?: number
}

/** 注视控制器输出。 */
export interface GazeUpdateResult {
  /** 平滑后的注视方向（弧度；未分配）。 */
  gaze: GazeTarget
  /** 分配后的 首/頭/目先 局部角度（弧度）。 */
  distribution: GazeDistribution
  /** 调试字段 lookYaw（−1..1；无注视 = null）。 */
  lookYaw: number | null
  /** 当前是否处于「有目标」状态。 */
  active: boolean
}

/**
 * 分层延迟（秒）：眼最快、颈次之、头最慢 —— 产生「眼睛先看到、头再跟过去」的层级 lag。
 * 这是用户反馈「没有跟随/像木偶」的关键：所有骨同时转 = 机械，依次到达 = 活人。
 */
export const GAZE_LAYER_TAU = { eye: 0.05, neck: 0.12, head: 0.17 } as const

/** 注视状态机（持有平滑状态、逐层延迟与超时计时）。 */
export class GazeController {
  private current: GazeTarget = { yaw: 0, pitch: 0 }
  private neckCurrent: Euler3 = { x: 0, y: 0, z: 0 }
  private headCurrent: Euler3 = { x: 0, y: 0, z: 0 }
  private eyeCurrent: Euler3 = { x: 0, y: 0, z: 0 }
  private lastTargetAtMs = -Infinity
  private force: GazeTarget | null = null
  private forcedNow = false

  /** 重置（场景切换/模型重载）。 */
  reset(): void {
    this.current = { yaw: 0, pitch: 0 }
    this.neckCurrent = { x: 0, y: 0, z: 0 }
    this.headCurrent = { x: 0, y: 0, z: 0 }
    this.eyeCurrent = { x: 0, y: 0, z: 0 }
    this.lastTargetAtMs = -Infinity
    this.force = null
    this.forcedNow = false
  }

  /** 强制注视（度）；传 NaN/Infinity 清除。 */
  setForced(yawDeg: number, pitchDeg: number): void {
    if (!Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) {
      this.force = null
      this.forcedNow = false
      return
    }
    this.force = {
      yaw: (yawDeg * Math.PI) / 180,
      pitch: (pitchDeg * Math.PI) / 180
    }
    this.forcedNow = true
  }

  /** 当前平滑后的注视（调试/单测）。 */
  get gaze(): GazeTarget {
    return { ...this.current }
  }

  /** 每帧更新。 */
  update(input: GazeUpdateInput): GazeUpdateResult {
    let target: GazeTarget = { yaw: 0, pitch: 0 }
    let active = false
    const bodyYaw = input.bodyYawRad ?? 0

    const forced = input.forced ?? null
    if (this.force) {
      // setGaze 的持续强制（调试用；直到 NaN 清除）
      // 调试强制注视按「身体局部角」理解（smoke 断言 setGaze(25,0) → gaze.yaw≈25°）
      target = clampGaze(localizeGaze(this.force, input.facing))
      active = true
      this.lastTargetAtMs = input.nowMs
    } else if (forced) {
      // 手势 gaze 也是身体局部角（例如看自己手里的「硬币」）
      target = clampGaze(
        localizeGaze(
          { yaw: (forced.yawDeg * Math.PI) / 180, pitch: (forced.pitchDeg * Math.PI) / 180 },
          input.facing
        )
      )
      active = true
      this.lastTargetAtMs = input.nowMs
    } else if (input.lookTarget) {
      target = clampGaze(
        localizeGaze(
          pointerToGaze(input.lookTarget, input.headCenter, input.depthPx),
          input.facing,
          bodyYaw
        )
      )
      active = true
      this.lastTargetAtMs = input.nowMs
    } else if (input.nowMs - this.lastTargetAtMs <= GAZE_TIMEOUT_MS) {
      // 刚离开目标：朝 0 平滑回落（2.5s 内保持「活跃」以便调试面读到 residual）。
      target = { yaw: 0, pitch: 0 }
      active = true
    }

    this.current = dampGaze(this.current, target, input.dt, GAZE_TAU_SEC)
    // 逐层延迟：目先 50ms、首 120ms、頭 170ms（眼睛先动，头慢慢跟过去）。
    const rawDistribution = distributeGaze(this.current)
    this.eyeCurrent = dampEuler(this.eyeCurrent, rawDistribution.eye, input.dt, GAZE_LAYER_TAU.eye)
    this.neckCurrent = dampEuler(this.neckCurrent, rawDistribution.neck, input.dt, GAZE_LAYER_TAU.neck)
    this.headCurrent = dampEuler(this.headCurrent, rawDistribution.head, input.dt, GAZE_LAYER_TAU.head)
    const distribution: GazeDistribution = {
      neck: this.neckCurrent,
      head: this.headCurrent,
      eye: this.eyeCurrent
    }
    const hasResidual = Math.abs(this.current.yaw) > 0.02 || Math.abs(this.current.pitch) > 0.02
    const lookYaw =
      active || hasResidual
        ? clamp(this.current.yaw / GAZE_LIMITS.yawAbs, -1, 1)
        : null
    return { gaze: { ...this.current }, distribution, lookYaw, active: active || hasResidual }
  }

  /** 是否处于调试强制注视。 */
  get isForced(): boolean {
    return this.forcedNow
  }
}
