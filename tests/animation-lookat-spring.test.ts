/**
 * B3 单测：look-at（死区/钳制/分配/平滑/超时/朝向）与发辫 verlet 弹簧（收敛/确定性/不发散）。
 */
import { describe, expect, it } from 'vitest'

import {
  GAZE_DEADZONE_PX,
  GAZE_LIMITS,
  GazeController,
  clampGaze,
  distributeGaze,
  facingTurnRad,
  localizeGaze,
  pointerToGaze,
  wrapAngle
} from '../src/renderer/src/animation/legacy/look-at'
import {
  DEFAULT_SPRING_PARAMS,
  computeRestDirections,
  createSpringChainState,
  stepSpringChain,
  type SpringChainConfig
} from '../src/renderer/src/animation/legacy/spring'
import { eulerDegToQuat, quatToRotationVector, lengthVec3 } from '../src/renderer/src/animation/legacy/quat'
import type { Vec3 } from '../src/renderer/src/animation/legacy/types'

const DEG = Math.PI / 180

const SPRING_REST: Record<string, Vec3> = {
  頭: { x: 0, y: 19.244, z: -0.54 },
  '辮子1-1': { x: 0.468, y: 19.324, z: -0.776 },
  '辮子1-2': { x: 0.522, y: 19.124, z: -0.58 },
  '辮子1-3': { x: 0.575, y: 18.819, z: -0.378 },
  '辮子1-4': { x: 0.52, y: 18.599, z: -0.099 },
  '辮子1-5': { x: 0.488, y: 18.372, z: 0.041 },
  '辮子2-1': { x: 0.432, y: 18.604, z: 0 }
}

function makeChain(gravity = 0): SpringChainConfig {
  const joints = ['辮子1-2', '辮子1-3', '辮子1-4', '辮子1-5']
  const restDirs = computeRestDirections(joints, SPRING_REST, '頭')
  return {
    id: 'braid1',
    joints: joints.map((bone, index) => ({ bone, restDir: restDirs[index]! })),
    stiffness: DEFAULT_SPRING_PARAMS.stiffness,
    damping: DEFAULT_SPRING_PARAMS.damping,
    gravity,
    maxAngularSpeed: DEFAULT_SPRING_PARAMS.maxAngularSpeed
  }
}

function simulate(
  config: SpringChainConfig,
  seconds: number,
  dt: number,
  parentWorld = { x: 0, y: 0, z: 0, w: 1 },
  parentOmega = { x: 0, y: 0, z: 0 },
  initialRotation = { x: 0, y: 0, z: 0, w: 1 }
) {
  let state = createSpringChainState(config)
  state = {
    ...state,
    joints: state.joints.map((joint, index) => ({
      rotation: index === 0 ? initialRotation : joint.rotation,
      angularVelocity: joint.angularVelocity
    }))
  }
  let last = stepSpringChain(state, config, { dt: 0, rootParentWorld: parentWorld, rootParentAngularVelocity: parentOmega })
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i += 1) {
    last = stepSpringChain(last.state, config, {
      dt,
      rootParentWorld: parentWorld,
      rootParentAngularVelocity: parentOmega
    })
  }
  return last
}

describe('look-at：死区/钳制/分配/平滑/超时', () => {
  it('死区内不转；死区外右/下方向产生正 yaw/pitch', () => {
    const head = { x: 400, y: 300 }
    expect(pointerToGaze({ x: 400, y: 300 }, head, 400)).toEqual({ yaw: 0, pitch: 0 })
    expect(pointerToGaze({ x: 400 + GAZE_DEADZONE_PX - 1, y: 300 }, head, 400).yaw).toBe(0)
    const right = pointerToGaze({ x: 900, y: 300 }, head, 400)
    expect(right.yaw).toBeGreaterThan(0.5)
    expect(Math.abs(right.pitch)).toBeLessThan(1e-6)
    const below = pointerToGaze({ x: 400, y: 900 }, head, 400)
    expect(below.pitch).toBeGreaterThan(0.5)
  })

  it('角度钳制：yaw ±31°、pitch [−20°, +26°]', () => {
    const clamped = clampGaze({ yaw: 3, pitch: -3 })
    expect(clamped.yaw).toBeCloseTo(GAZE_LIMITS.yawAbs, 9)
    expect(clamped.pitch).toBeCloseTo(GAZE_LIMITS.pitchMin, 9)
    const up = clampGaze({ yaw: 0, pitch: 3 })
    expect(up.pitch).toBeCloseTo(GAZE_LIMITS.pitchMax, 9)
  })

  it('分配：首 ≤12°、頭 ≤18°、目先 ≤25°；总角度守恒（25° 与 31°）', () => {
    for (const yawDeg of [25, 31]) {
      const distribution = distributeGaze({ yaw: yawDeg * DEG, pitch: 0 })
      expect(Math.abs(distribution.neck.y)).toBeLessThanOrEqual(GAZE_LIMITS.neckAbs + 1e-9)
      expect(Math.abs(distribution.head.y)).toBeLessThanOrEqual(GAZE_LIMITS.headAbs + 1e-9)
      expect(Math.abs(distribution.eye.y)).toBeLessThanOrEqual(GAZE_LIMITS.eyeAbs + 1e-9)
      const total = distribution.neck.y + distribution.head.y + distribution.eye.y
      expect(total).toBeCloseTo(yawDeg * DEG, 6)
    }
    const pitch = distributeGaze({ yaw: 0, pitch: 20 * DEG })
    expect(pitch.neck.x).toBeLessThanOrEqual(GAZE_LIMITS.neckAbs + 1e-9)
    expect(Math.abs(pitch.neck.x + pitch.head.x + pitch.eye.x)).toBeCloseTo(20 * DEG, 6)
  })

  it('朝向：facing right/left 的 root 转角 ±90°；局部化后 yaw 减去朝向角', () => {
    expect(facingTurnRad('front')).toBe(0)
    expect(facingTurnRad('right')).toBeCloseTo(Math.PI / 2, 9)
    expect(facingTurnRad('left')).toBeCloseTo(-Math.PI / 2, 9)
    const localized = localizeGaze({ yaw: 30 * DEG, pitch: 0 }, 'right')
    expect(localized.yaw).toBeCloseTo(30 * DEG - Math.PI / 2, 9)
    // (−π, π] 口径：3π 归一化为 π（与 −π 等价朝向）
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 9)
  })

  it('GazeController：τ=90ms 平滑收敛（0.27s 后误差 <5%）', () => {
    const controller = new GazeController()
    const head = { x: 400, y: 300 }
    const pointer = { x: 2000, y: 300 } // 右侧远处 → 目标被钳制到 +31°
    controller.update({ lookTarget: pointer, headCenter: head, depthPx: 400, facing: 'front', dt: 0.016, nowMs: 0 })
    for (let i = 0; i < 17; i += 1) {
      controller.update({
        lookTarget: pointer,
        headCenter: head,
        depthPx: 400,
        facing: 'front',
        dt: 1 / 60,
        nowMs: (i + 1) * (1000 / 60)
      })
    }
    expect(controller.gaze.yaw).toBeGreaterThan(GAZE_LIMITS.yawAbs * 0.95)
  })

  it('鼠标离开后 2.5s 内平滑回零（lookYaw 归 null）', () => {
    const controller = new GazeController()
    const head = { x: 400, y: 300 }
    let now = 0
    for (let i = 0; i < 30; i += 1) {
      now += 16
      controller.update({ lookTarget: { x: 1200, y: 400 }, headCenter: head, depthPx: 400, facing: 'front', dt: 0.016, nowMs: now })
    }
    expect(Math.abs(controller.gaze.yaw)).toBeGreaterThan(0.2)
    // 目标消失 → 平滑回落
    for (let i = 0; i < 60; i += 1) {
      now += 16
      controller.update({ lookTarget: null, headCenter: head, depthPx: 400, facing: 'front', dt: 0.016, nowMs: now })
    }
    const after = controller.update({ lookTarget: null, headCenter: head, depthPx: 400, facing: 'front', dt: 0.016, nowMs: now + 2600 })
    expect(Math.abs(after.gaze.yaw)).toBeLessThan(0.01)
    expect(after.lookYaw === null || Math.abs(after.lookYaw) < 0.01).toBe(true)
  })

  it('setGaze 强制注视（调试）：25° yaw 收敛；NaN 清除', () => {
    const controller = new GazeController()
    controller.setForced(25, 0)
    expect(controller.isForced).toBe(true)
    let now = 0
    let result = controller.update({ lookTarget: null, headCenter: { x: 0, y: 0 }, depthPx: 300, facing: 'front', dt: 0.016, nowMs: 0 })
    for (let i = 0; i < 60; i += 1) {
      now += 16
      result = controller.update({ lookTarget: null, headCenter: { x: 0, y: 0 }, depthPx: 300, facing: 'front', dt: 0.016, nowMs: now })
    }
    expect(result.gaze.yaw).toBeCloseTo(25 * DEG, 1)
    expect(result.lookYaw).toBeCloseTo(25 / 31, 2)
    controller.setForced(Number.NaN, Number.NaN)
    expect(controller.isForced).toBe(false)
  })

  it('手势强制注视（forced 参数）优先于鼠标位置', () => {
    const controller = new GazeController()
    let now = 0
    let result = controller.update({
      lookTarget: { x: 2000, y: 0 },
      headCenter: { x: 0, y: 0 },
      depthPx: 300,
      facing: 'front',
      dt: 0.016,
      nowMs: 0,
      forced: { yawDeg: -6, pitchDeg: 18 }
    })
    for (let i = 0; i < 60; i += 1) {
      now += 16
      result = controller.update({
        lookTarget: { x: 2000, y: 0 },
        headCenter: { x: 0, y: 0 },
        depthPx: 300,
        facing: 'front',
        dt: 0.016,
        nowMs: now,
        forced: { yawDeg: -6, pitchDeg: 18 }
      })
    }
    expect(result.gaze.yaw).toBeCloseTo(-6 * DEG, 1)
    expect(result.gaze.pitch).toBeCloseTo(18 * DEG, 1)
  })
})

describe('spring：发辫 verlet 弹簧（收敛/确定性/不发散）', () => {
  it('rest 方向：主辫朝下、碎发链方向有效', () => {
    const dirs = computeRestDirections(['辮子1-2', '辮子1-3', '辮子1-4', '辮子1-5'], SPRING_REST, '頭')
    expect(dirs.length).toBe(4)
    for (const dir of dirs) {
      expect(lengthVec3(dir)).toBeCloseTo(1, 6)
    }
    expect(dirs[0]!.y).toBeLessThan(0) // 朝下
  })

  it('静止（父骨不动、重力 0）：初始即恒等、5s 后仍恒等', () => {
    const config = makeChain(0)
    const result = simulate(config, 5, 1 / 60)
    for (const quat of result.localQuats) {
      const rv = quatToRotationVector(quat)
      expect(lengthVec3(rv)).toBeLessThan(1e-6)
    }
  })

  it('给定初始偏移 + 重力 0：5s 后收敛回 rest（摆角 < 1°）', () => {
    const config = makeChain(0)
    const result = simulate(config, 5, 1 / 30, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, eulerDegToQuat({ x: 25 }))
    const angle = lengthVec3(quatToRotationVector(result.localQuats[0]!))
    expect(angle).toBeLessThan(1 * DEG)
  })

  it('固定 dt 的确定性：两次同样输入输出完全一致', () => {
    const config = makeChain(0.5)
    const a = simulate(config, 2, 1 / 60, { x: 0, y: 0, z: 0, w: 1 }, { x: 2, y: 0, z: 0 })
    const b = simulate(config, 2, 1 / 60, { x: 0, y: 0, z: 0, w: 1 }, { x: 2, y: 0, z: 0 })
    expect(a.localQuats.length).toBe(4)
    for (let i = 0; i < a.localQuats.length; i += 1) {
      expect(a.localQuats[i]).toEqual(b.localQuats[i])
    }
  })

  it('父骨角速度驱动：辫子被甩起来（偏离 rest）', () => {
    const config = makeChain(0)
    const result = simulate(config, 0.3, 1 / 120, { x: 0, y: 0, z: 0, w: 1 }, { x: 6, y: 0, z: 0 })
    const angle = lengthVec3(quatToRotationVector(result.localQuats[0]!))
    expect(angle).toBeGreaterThan(0.01)
  })

  it('dt=0.1（掉帧/跳帧）不爆炸：角度有限且角速度被钳制', () => {
    const config = { ...makeChain(2.2), maxAngularSpeed: 24 }
    const state0 = createSpringChainState(config)
    const result = stepSpringChain(state0, config, {
      dt: 0.1,
      rootParentWorld: { x: 0, y: 0, z: 0, w: 1 },
      rootParentAngularVelocity: { x: 3, y: 2, z: 1 }
    })
    for (const quat of result.localQuats) {
      expect(Number.isFinite(quat.x)).toBe(true)
      expect(Number.isFinite(quat.y)).toBe(true)
      expect(Number.isFinite(quat.z)).toBe(true)
      expect(Number.isFinite(quat.w)).toBe(true)
      expect(Math.abs(quat.w)).toBeLessThanOrEqual(1)
    }
    for (const joint of result.state.joints) {
      expect(lengthVec3(joint.angularVelocity)).toBeLessThanOrEqual(24 + 1e-6)
    }
  })

  it('世界四元数 = 父世界 × 局部偏移累积', () => {
    const config = makeChain(0)
    const parent = eulerDegToQuat({ y: 20 })
    const state = createSpringChainState(config)
    const result = stepSpringChain(state, config, {
      dt: 0,
      rootParentWorld: parent,
      rootParentAngularVelocity: { x: 0, y: 0, z: 0 }
    })
    expect(result.worldQuats.length).toBe(4)
    // 初始偏移恒等 → 世界 = 父世界
    const rv = quatToRotationVector(result.worldQuats[0]!)
    expect(lengthVec3(rv)).toBeGreaterThan(0.3)
  })
})
