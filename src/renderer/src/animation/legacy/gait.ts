/**
 * 程序化步态（走路/爬行的循环叠加；纯函数，不 import three）。
 *
 * v2（用户反馈「动作太僵硬」后重做）：
 * - 走路：**脚跟着地 → 全掌 → 脚尖蹬离**的滚动（foot pitch 交给接地 IK 的脚目标），
 *   摆动相抬脚更高、膝屈伸由 IK 自动产生；骨盆旋转 4–5°、胸腔反向、头稳定；
 * - 手臂**不对称**反摆（左臂摆幅大、右臂小）+ 肘/腕延迟 follow-through；
 * - 重心双峰起伏：触地时最低、迈步中段抬高；
 * - 爬行：身体**竖直贴墙**、四肢交替抓爬（左臂上抓时右膝抬起），头看目标。
 */
import type { FootOffset } from './types'

/** 步态相位状态（管线持有，dt 推进）。 */
export interface GaitState {
  /** 走路相位 0..1。 */
  walkPhase: number
  /** 爬行相位 0..1。 */
  climbPhase: number
  /** 当前步频（Hz，调试用）。 */
  walkFrequency: number
  /** 当前步幅（模型单位；由速度推导，支撑脚不打滑）。 */
  walkStride: number
}

/** 度数记录（骨名 → 角度偏移分量）。 */
export type GaitPoseDegrees = Record<string, { x?: number; y?: number; z?: number }>

/** 一帧步态偏移输出。 */
export interface GaitOffsets {
  /** 叠加到基础姿态上的角度（度）。 */
  poseDegrees: GaitPoseDegrees
  /** 左右脚目标偏移（模型单位 / 度）。 */
  feet: { left: FootOffset; right: FootOffset }
  /** 额外重心下沉（模型单位；走路触地时最大）。 */
  crouch: number
}

/** 走路参考步幅（模型单位；单侧前后 ±，实际按速度推导防滑步）。 */
export const WALK_STRIDE = 0.9
/** 参考抬脚高度（模型单位；实际上限按步幅缩放，避免高抬腿）。 */
export const WALK_LIFT = 0.5
/**
 * 自然步频区间（Hz）：一个完整步态周期（左右各一步）约 0.8–1.3s。
 * 频率与步幅联动：freq = v / (4·stride) → 支撑脚相对地面不打滑。
 */
const WALK_FREQ_MIN = 0.7
const WALK_FREQ_MAX = 1.5
const TAU = Math.PI * 2

/** 推进步态相位（每帧调用；速度来自 B2 `motion.velocity`）。 */
export function advanceGait(
  state: GaitState,
  dt: number,
  speedPxPerSec: number,
  pxPerUnit: number,
  mode: 'walk' | 'climb'
): void {
  const speedModel = pxPerUnit > 1e-6 ? Math.abs(speedPxPerSec) / pxPerUnit : 0
  if (mode === 'walk') {
    // 自然步频优先：v 慢时用小步幅（不是高频小碎步），v 快时步幅变大。
    const rawFreq = speedModel / (4 * WALK_STRIDE)
    const freq = Math.min(WALK_FREQ_MAX, Math.max(WALK_FREQ_MIN, rawFreq))
    const stride = Math.max(
      0.25,
      Math.min(1.6, speedModel / Math.max(0.2, 4 * freq))
    )
    state.walkFrequency = freq
    state.walkStride = stride
    const step = Math.max(0, Math.min(0.1, dt)) * freq
    state.walkPhase = (state.walkPhase + step) % 1
  } else {
    const stride = 1.4
    const rawFreq = speedModel / Math.max(0.2, stride)
    const freq = Math.min(WALK_FREQ_MAX, Math.max(WALK_FREQ_MIN, rawFreq))
    const step = Math.max(0, Math.min(0.1, dt)) * freq
    state.climbPhase = (state.climbPhase + step) % 1
  }
}

/** 单只脚的相位状态（支撑相/摆动相 + 前后位置 + 抬脚 + 脚掌俯仰）。 */
export interface FootCycleState {
  forward: number
  lift: number
  /** 脚掌世界俯仰（度；正 = 脚尖上翘/脚跟着地，负 = 脚尖蹬地）。 */
  pitchDeg: number
  /** 是否处于摆动相。 */
  swing: boolean
}

/** 计算单只脚的步态周期（phase 0 = 该脚脚跟着地）。 */
export function computeFootCycle(phase: number, stride = WALK_STRIDE, liftAmp = WALK_LIFT): FootCycleState {
  const p = wrapPhase(phase)
  const forward = stride * Math.cos(TAU * p)
  if (p < 0.5) {
    // 支撑相：脚跟着地（脚尖上翘 12°）→ 全掌 → 蹬离（脚尖下压 18°）
    const stance = p / 0.5
    let pitchDeg = 0
    if (stance < 0.12) pitchDeg = 7 * (1 - stance / 0.12)
    else if (stance < 0.75) pitchDeg = 0
    else pitchDeg = -9 * ((stance - 0.75) / 0.25)
    return { forward, lift: 0, pitchDeg, swing: false }
  }
  // 摆动相：抬脚 + 脚尖先离地/落地前上翘
  const swing = (p - 0.5) / 0.5
  return {
    forward,
    lift: liftAmp * Math.sin(Math.PI * swing),
    pitchDeg: -6 * Math.cos(Math.PI * swing),
    swing: true
  }
}

/** 走路循环偏移（phase ∈ [0,1)）。 */
export function computeWalkOffsets(phase: number, stride = WALK_STRIDE): GaitOffsets {
  const p = wrapPhase(phase)
  const liftAmp = Math.min(WALK_LIFT, 0.32 + 0.25 * stride)
  const left = computeFootCycle(p, stride, liftAmp)
  const right = computeFootCycle(wrapPhase(p + 0.5), stride, liftAmp)
  // 重心起伏：触地（p=0/0.5）最低、迈步中段抬高（双峰）。
  const bob = 0.06 * (0.5 + 0.5 * Math.cos(2 * TAU * p))
  // 手臂反摆：自然摆幅（左 12°/右 9°，轻微不对称），肘/腕再滞后半拍。
  const swingLeft = 12 * Math.cos(TAU * p)
  const swingRight = -9 * Math.cos(TAU * p + 0.12)
  return {
    poseDegrees: {
      左腕: { x: swingLeft, z: 1.2 * Math.sin(TAU * p + 0.4) },
      右腕: { x: swingRight, z: -0.8 * Math.sin(TAU * p + 0.2) },
      左ひじ: { x: -2 + 2 * Math.cos(TAU * p - 0.5) },
      右ひじ: { x: -1.5 + 1.5 * Math.cos(TAU * p + 0.1) },
      左手首: { x: 1.5 * Math.cos(TAU * p - 0.8), z: 0.8 * Math.sin(TAU * p) },
      右手首: { x: 1.2 * Math.cos(TAU * p - 0.4), z: -0.7 * Math.sin(TAU * p) },
      左肩: { z: -0.8 * Math.cos(TAU * p) },
      右肩: { z: -0.6 * Math.cos(TAU * p) },
      // 骨盆旋转 3–4°，胸腔反向，头保持稳定（不跟着晃）。
      下半身: { y: -3.6 * Math.cos(TAU * p), z: 1.6 * Math.sin(TAU * p), x: 0.4 * Math.abs(Math.sin(TAU * p)) },
      上半身: { y: 2.2 * Math.cos(TAU * p), z: -0.8 * Math.sin(TAU * p) },
      上半身2: { y: 0.9 * Math.cos(TAU * p) },
      首: { y: -1.4 * Math.cos(TAU * p), x: 0.3 * Math.sin(2 * TAU * p) },
      頭: { y: -1.0 * Math.cos(TAU * p) }
    },
    feet: {
      left: { forward: left.forward, lift: left.lift, pitchDeg: left.pitchDeg },
      right: { forward: right.forward, lift: right.lift, pitchDeg: right.pitchDeg }
    },
    crouch: bob
  }
}

/** 爬行循环偏移（身体竖直贴墙、四肢交替抓爬；不做接地 IK）。 */
export function computeClimbOffsets(phase: number): GaitOffsets {
  const p = wrapPhase(phase)
  const leftReach = Math.sin(TAU * p)
  const rightReach = Math.sin(TAU * p + Math.PI)
  // 左臂上抓（抬肩+屈肘）时右膝抬起，反之亦然（对角协调 = 人爬墙的自然步态）。
  const leftKneeLift = Math.max(0, -leftReach)
  const rightKneeLift = Math.max(0, -rightReach)
  return {
    poseDegrees: {
      // 交替抓墙：一手向上伸（肩抬、肘伸），另一手回收（肘屈），幅度要明显
      左腕: { x: -20 * leftReach, z: 26 * leftReach },
      右腕: { x: -20 * rightReach, z: -26 * rightReach },
      左ひじ: { x: -38 * Math.max(0, leftReach) + 16 * Math.max(0, -leftReach) },
      右ひじ: { x: -38 * Math.max(0, rightReach) + 16 * Math.max(0, -rightReach) },
      左手首: { x: 10 * leftReach },
      右手首: { x: 10 * rightReach },
      左肩: { z: 4.5 * leftReach },
      右肩: { z: -4.5 * rightReach },
      左足D: { x: -34 * leftKneeLift },
      右足D: { x: -34 * rightKneeLift },
      左ひざD: { x: 46 * leftKneeLift },
      右ひざD: { x: 46 * rightKneeLift },
      左足首D: { x: -12 * leftKneeLift },
      右足首D: { x: -12 * rightKneeLift },
      下半身: { y: 3.0 * Math.sin(TAU * p), z: -2.0 * Math.sin(TAU * p), x: 2 * Math.sin(2 * TAU * p) },
      上半身: { y: -2.2 * Math.sin(TAU * p), z: 1.6 * Math.sin(TAU * p) },
      首: { y: 1.2 * Math.sin(TAU * p) },
      頭: { y: 0.8 * Math.sin(TAU * p) }
    },
    feet: { left: {}, right: {} },
    crouch: 0
  }
}

/** 坐窗沿的晃腿微动（右腿垂下、前后 4°；6–8s 微循环的一部分）。 */
export function computeSitEdgeOffsets(timeSec: number): GaitPoseDegrees {
  const swing = 3.5 * Math.sin((TAU * timeSec) / 3.2)
  return {
    右足D: { x: swing },
    右ひざD: { x: -0.6 * swing },
    右足首D: { x: 1.5 * swing },
    首: { y: 0.8 * Math.sin((TAU * timeSec) / 6.5) },
    頭: { y: 1.2 * Math.sin((TAU * timeSec) / 6.5) }
  }
}

/** 把相位折叠到 [0,1)。 */
export function wrapPhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0
  const wrapped = phase % 1
  return wrapped < 0 ? wrapped + 1 : wrapped
}

/** 新建步态状态。 */
export function createGaitState(): GaitState {
  return { walkPhase: 0, climbPhase: 0, walkFrequency: 0, walkStride: WALK_STRIDE }
}
