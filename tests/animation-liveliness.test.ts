/**
 * B3 单测：v2「活人感」——连续微动 / 自然走路（脚跟着地-脚尖滚动）/ 爬行对角协调 /
 * 姿态过渡错峰（不是所有骨同时到位）/ 微动频段与连续性。
 */
import { describe, expect, it } from 'vitest'

import {
  computeIdleHeadDrift,
  computeMicroMotion,
  DEFAULT_MICRO_SCALE,
  MICRO_FINGER_BONES,
  MICRO_SCALE_BY_MODE,
  microScaleFor
} from '../src/renderer/src/animation/legacy/micro-motion'
import {
  advanceGait,
  computeClimbOffsets,
  computeFootCycle,
  computeWalkOffsets,
  createGaitState,
  WALK_LIFT,
  WALK_STRIDE
} from '../src/renderer/src/animation/legacy/gait'
import { PoseMachine } from '../src/renderer/src/animation/legacy/pose-machine'
import { blendPoseMapsStaggered } from '../src/renderer/src/animation/legacy/blend'
import { eulerDegToQuat, quatToRotationVector, lengthVec3 } from '../src/renderer/src/animation/legacy/quat'
import { BASE_POSE_IDS } from '../src/renderer/src/animation/legacy/poses'
import { MICRO_BONES, POSE_CONTROLLED_BONES } from '../src/renderer/src/animation/legacy/skeleton'
import type { PoseQuats } from '../src/renderer/src/animation/legacy/types'

const DEG = Math.PI / 180

describe('micro-motion：永不静止且幅度克制', () => {
  it('微动幅度克制（手指含静态半握 10–28°，其余骨 ≤6.5°）且非零', () => {
    const fingerBones = new Set<string>([
      ...MICRO_FINGER_BONES.left,
      ...MICRO_FINGER_BONES.right
    ])
    for (const t of [0.5, 3.7, 11.25]) {
      const motion = computeMicroMotion(t, DEFAULT_MICRO_SCALE)
      const bones = Object.keys(motion)
      expect(bones.length).toBeGreaterThan(10)
      for (const bone of bones) {
        const euler = motion[bone]!
        const maxComponent = Math.max(
          Math.abs(euler.x ?? 0),
          Math.abs(euler.y ?? 0),
          Math.abs(euler.z ?? 0)
        )
        const wrist = bone === '左手首' || bone === '右手首'
        expect(maxComponent).toBeLessThanOrEqual(fingerBones.has(bone) ? 48 : wrist ? 11 : 6.5)
      }
      // 至少有一根骨在动
      const maxAngle = Math.max(
        ...bones.map((bone) => {
          const euler = motion[bone]!
          return Math.max(Math.abs(euler.x ?? 0), Math.abs(euler.y ?? 0), Math.abs(euler.z ?? 0))
        })
      )
      expect(maxAngle).toBeGreaterThan(0.05)
    }
  })

  it('连续无跳变：16ms 相邻采样的角度差 < 0.5°', () => {
    let previous = computeMicroMotion(10, DEFAULT_MICRO_SCALE)
    for (let i = 1; i <= 120; i += 1) {
      const current = computeMicroMotion(10 + i / 60, DEFAULT_MICRO_SCALE)
      for (const bone of Object.keys(current)) {
        const a = previous[bone] ?? {}
        const b = current[bone] ?? {}
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(Math.abs((b[axis] ?? 0) - (a[axis] ?? 0))).toBeLessThan(0.5)
        }
      }
      previous = current
    }
  })

  it('微动骨都在受控白名单内（不会写到 IK/眼控/裙摆等禁写骨）', () => {
    const allowed = new Set<string>([...POSE_CONTROLLED_BONES, ...MICRO_BONES])
    for (const bone of Object.keys(computeMicroMotion(7.3, DEFAULT_MICRO_SCALE))) {
      expect(allowed.has(bone), bone).toBe(true)
    }
    // 手指静态半握覆盖用户要求（每手 人指/中指/薬指/小指/親指 各 2–3 节）
    const fingers = computeMicroMotion(7.3, DEFAULT_MICRO_SCALE, { withFingers: true })
    for (const bone of [...MICRO_FINGER_BONES.left, ...MICRO_FINGER_BONES.right]) {
      expect(fingers[bone]).toBeDefined()
    }
    // withFingers=false：静态半握仍在（手不能是僵尸手），但手指**不再抖动**（两时刻相同）
    const staticA = computeMicroMotion(7.3, DEFAULT_MICRO_SCALE, { withFingers: false })
    const staticB = computeMicroMotion(7.9, DEFAULT_MICRO_SCALE, { withFingers: false })
    expect(staticA['左人指１']).toEqual(staticB['左人指１'])
    const dynA = computeMicroMotion(7.3, DEFAULT_MICRO_SCALE, { withFingers: true })
    const dynB = computeMicroMotion(7.9, DEFAULT_MICRO_SCALE, { withFingers: true })
    expect(dynA['左人指２']).not.toEqual(dynB['左人指２'])
  })

  it('scale=0 → 无微动；12 个姿态都有微动缩放配置（睡眠最小、拖拽最大）', () => {
    const zero = computeMicroMotion(4.2, { breath: 0, sway: 0, headLag: 0, arm: 0, finger: 0 })
    for (const euler of Object.values(zero)) {
      expect(Math.max(Math.abs(euler.x ?? 0), Math.abs(euler.y ?? 0), Math.abs(euler.z ?? 0))).toBeLessThan(1e-9)
    }
    for (const poseId of BASE_POSE_IDS) {
      expect(microScaleFor(poseId)).toBeDefined()
    }
    expect(MICRO_SCALE_BY_MODE.sleep!.breath).toBeLessThan(MICRO_SCALE_BY_MODE.idle!.breath)
    expect(MICRO_SCALE_BY_MODE.drag!.sway).toBeGreaterThan(MICRO_SCALE_BY_MODE.idle!.sway)
  })

  it('极慢头漂移：幅度 ≤1.5°、两个不可通约频率', () => {
    const drift = computeIdleHeadDrift(5)
    for (const bone of Object.keys(drift)) {
      const euler = drift[bone]!
      expect(Math.abs(euler.y ?? 0)).toBeLessThanOrEqual(4.5)
      expect(Math.abs(euler.x ?? 0)).toBeLessThanOrEqual(4.5)
    }
    expect(drift['首']).toBeDefined()
    expect(drift['頭']).toBeDefined()
  })
})

describe('gait：脚跟着地 → 全掌 → 蹬离；不对称摆臂；对角爬行', () => {
  it('单脚周期：脚跟着地脚尖上翘、支撑相全掌、蹬离脚尖下压、摆动相抬起', () => {
    const strike = computeFootCycle(0)
    expect(strike.lift).toBe(0)
    expect(strike.forward).toBeCloseTo(WALK_STRIDE, 6)
    expect(strike.pitchDeg).toBeCloseTo(7, 0) // 脚跟着地脚尖上翘（收敛幅度）
    const flat = computeFootCycle(0.25)
    expect(Math.abs(flat.pitchDeg)).toBeLessThan(0.5)
    expect(flat.lift).toBe(0)
    const pushOff = computeFootCycle(0.48)
    expect(pushOff.pitchDeg).toBeLessThan(-5) // 蹬离脚尖下压
    const swing = computeFootCycle(0.75)
    expect(swing.lift).toBeGreaterThan(0.3) // 低抬脚（不要高抬腿）
    expect(swing.swing).toBe(true)
    const preStrike = computeFootCycle(0.98)
    expect(preStrike.pitchDeg).toBeGreaterThan(3)
  })

  it('走路循环：左臂摆幅明显大于右臂（不对称，避免军训感）', () => {
    const offsets = computeWalkOffsets(0.12)
    const leftArm = Math.abs(offsets.poseDegrees['左腕']?.x ?? 0)
    const rightArm = Math.abs(offsets.poseDegrees['右腕']?.x ?? 0)
    expect(leftArm).toBeGreaterThan(rightArm)
    expect(leftArm).toBeGreaterThan(6)
    // 骨盆旋转 4–5°、头反向保持稳定
    expect(Math.abs(offsets.poseDegrees['下半身']?.y ?? 0)).toBeGreaterThan(2)
    expect(Math.abs(offsets.poseDegrees['首']?.y ?? 0)).toBeLessThan(2.5)
    // 双峰重心起伏
    expect(offsets.crouch).toBeGreaterThan(0)
    expect(offsets.crouch).toBeLessThan(0.12)
  })

  it('走路左右相位差半周期（支撑/摆动交替）', () => {
    const offsets = computeWalkOffsets(0.1)
    const left = offsets.feet.left
    const right = offsets.feet.right
    expect(Math.sign(left.forward ?? 0)).not.toBe(Math.sign(right.forward ?? 0))
    expect((left.lift ?? 0) > 0 || (right.lift ?? 0) > 0).toBe(true)
  })

  it('爬行：对角协调（左手上抓时右膝抬起）、身体不横向倒下', () => {
    const offsets = computeClimbOffsets(0.25) // leftReach = +1
    expect(offsets.poseDegrees['左腕']?.z ?? 0).toBeGreaterThan(5)
    expect(offsets.poseDegrees['右ひざD']?.x ?? 0).toBeGreaterThan(20)
    expect(offsets.poseDegrees['左ひざD']?.x ?? 0).toBe(0)
    const back = computeClimbOffsets(0.75) // rightReach = +1
    expect(back.poseDegrees['右腕']?.z ?? 0).toBeLessThan(-5)
    expect(back.poseDegrees['左ひざD']?.x ?? 0).toBeGreaterThan(20)
    // 爬行只产生小角度躯干侧摆（不是横躺）
    expect(Math.abs(offsets.poseDegrees['上半身']?.z ?? 0)).toBeLessThan(3)
    expect(Math.abs(offsets.poseDegrees['下半身']?.z ?? 0)).toBeLessThan(3)
  })

  it('步频随速度增加并钳制；相位折叠到 [0,1)', () => {
    const slow = createGaitState()
    const fast = createGaitState()
    advanceGait(slow, 1 / 60, 20, 24.9, 'walk')
    advanceGait(fast, 1 / 60, 400, 24.9, 'walk')
    expect(fast.walkFrequency).toBeGreaterThan(slow.walkFrequency)
    advanceGait(fast, 1, 400, 24.9, 'walk')
    expect(fast.walkPhase).toBeGreaterThanOrEqual(0)
    expect(fast.walkPhase).toBeLessThan(1)
  })

  it('微动层与步态层叠加后角度仍是小量（<25°）', () => {
    const micro = computeMicroMotion(3.3, DEFAULT_MICRO_SCALE)
    const walk = computeWalkOffsets(0.3)
    for (const bone of ['上半身', '下半身', '左腕', '右腕', '首', '頭']) {
      const microAngle = Math.max(
        Math.abs(micro[bone]?.x ?? 0),
        Math.abs(micro[bone]?.y ?? 0),
        Math.abs(micro[bone]?.z ?? 0)
      )
      const walkAngle = Math.max(
        Math.abs(walk.poseDegrees[bone]?.x ?? 0),
        Math.abs(walk.poseDegrees[bone]?.y ?? 0),
        Math.abs(walk.poseDegrees[bone]?.z ?? 0)
      )
      expect(microAngle + walkAngle).toBeLessThan(25)
    }
  })
})

describe('过渡错峰：不是所有骨同时到位（去木偶感）', () => {
  const identityPose = (): PoseQuats =>
    new Map([
      ['左足D', eulerDegToQuat({})],
      ['左腕', eulerDegToQuat({})],
      ['頭', eulerDegToQuat({})]
    ])
  const targetPose = (): PoseQuats =>
    new Map([
      ['左足D', eulerDegToQuat({ x: 30 })],
      ['左腕', eulerDegToQuat({ x: 30 })],
      ['頭', eulerDegToQuat({ x: 30 })]
    ])

  const angleOf = (pose: PoseQuats, bone: string): number =>
    lengthVec3(quatToRotationVector(pose.get(bone)!)) / DEG

  it('blendPoseMapsStaggered：腿先到、手臂次之、头最后', () => {
    const blended = blendPoseMapsStaggered(identityPose(), targetPose(), 0.25, 0.5, (bone) => {
      if (bone === '左足D') return 0
      if (bone === '左腕') return 0.1
      return 0.2
    })
    const leg = angleOf(blended, '左足D')
    const arm = angleOf(blended, '左腕')
    const head = angleOf(blended, '頭')
    expect(leg).toBeGreaterThan(arm)
    expect(arm).toBeGreaterThan(head)
    expect(head).toBeGreaterThanOrEqual(0)
  })

  it('PoseMachine 传入 stagger 时逐骨错峰；不传时行为不变（全部同步）', () => {
    const machine = new PoseMachine({
      stagger: (bone) => (bone === '左足D' ? 0 : bone === '左腕' ? 0.1 : 0.2)
    })
    machine.setTarget('a', identityPose(), 0.5, true)
    machine.update(0, 'a', identityPose())
    machine.setTarget('b', targetPose(), 0.5, true)
    machine.update(0.12, 'b', targetPose())
    const staggered = machine.currentPose
    expect(angleOf(staggered, '左足D')).toBeGreaterThan(angleOf(staggered, '頭'))

    const plain = new PoseMachine()
    plain.setTarget('a', identityPose(), 0.5, true)
    plain.update(0, 'a', identityPose())
    plain.setTarget('b', targetPose(), 0.5, true)
    plain.update(0.12, 'b', targetPose())
    const sync = plain.currentPose
    expect(Math.abs(angleOf(sync, '左足D') - angleOf(sync, '頭'))).toBeLessThan(0.2)
  })
})
