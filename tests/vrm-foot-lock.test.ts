/**
 * 静态脚部固定（foot planting）单测 —— 2026-11-09 重做。
 *
 * 覆盖（对应 `docs/research/foot-slide-static-planting.md` 与用户反馈）：
 * 1. **旧实现根因回归**：本模型 rest 踝高 ≈9.8cm、bbox 脚底≈0，旧判据（脚骨 y ≤ bbox 脚底+2cm）
 *    永远不成立 → 脚部固定等于没生效；新实现用 rest 踝高做基准，必须能锁定。
 * 2. idle 变体 crossfade：clip 站姿变化（脚横向移动 ~15cm）时，接触脚**保持**在锚点（不滑）。
 * 3. 身体缓慢移动（腰/身体重心偏移）时，接触脚世界位置保持（IK 补偿），不跟着滑。
 * 4. 拖拽 / 坐 / 睡 / 空中 / 走路 不锁定（不破坏已验收的走路/拖拽行为）。
 * 5. 抬脚（超过退出迟滞）→ 权重淡出并释放（不硬拽脚）。
 *    **R1（2026-11-11，REPORT §4-R1）**：退出阈值 0.05→0.020、进入 0.03→0.012。
 *    根因：作者动画 `hsr-idleShow` 右踝**有意抬升 4.1cm** < 旧 5cm 退出阈值 → IK 把抬起的脚
 *    钉回地面锚点 → 右膝屈曲被拧出 +22.1°（左腿 −21.1°）。新口径下「作者抬 4cm → 释放、脚随
 *    动画抬起」「抬 1cm → 仍视为着地钉住」；旧 3/5cm 可用 options 显式传入（可配置性用例）。
 * 6. 目标超出「腿长 + 允许骨盆下沉」→ 释放（宁可少量滑步，也不拉畸形腿）。
 * 7. `solveKneePosition` 腿长钳制不 NaN/不爆炸。
 * 8. **A 锚点-作者脚位对齐**（bug A 修复，REPORT §7.1）：跨 idle 变体作者站姿差 15cm/21cm 时，
 *    把残差均值反向加到 normalized hips x/z（≤18cm、deadband 5mm、τ=0.3s、非累积），让腿恢复
 *    作者姿态、脚仍钉在锚点；离开 idle 平滑归零。
 * 9. **B 脚朝向软跟随**（REPORT §7.2）：偏差 >9° 时把 pinQuaternion 同半球 slerp 向当前作者
 *    脚朝向（τ=0.4s，位置不动）；保留 >35°/0.25s 硬释放安全网（用跟随前角度判定）。
 *
 * rig 用本模型的真实比例（`aventurine-tpose.vrm` rest：hips y=1.0661m、踝 y=0.0983m、
 * 大腿 0.4358m / 小腿 0.4456m、bbox 脚底 y≈0.0007m），避免旧测试「假 rig 脚骨在 y=0」
 * 掩盖接触判据缺陷。
 */
import { Object3D, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import type { AnimationInput } from '../src/renderer/src/core/wave2-contract'
import { VrmFootLock, createFootLockScratch, solveKneePosition } from '../src/renderer/src/vrm/foot-lock'
import type { VrmAvatar } from '../src/renderer/src/vrm/runtime-types'

/* -------------------------------------------------------------------------- */
/* 真实比例 rig                                                                */
/* -------------------------------------------------------------------------- */

/** 本模型实测 rest 数据（`aventurine-tpose.vrm`，见 `docs/research/foot-slide-static-planting.md`）。 */
const REST = {
  hips: [0, 1.0661, -0.0056] as const,
  upperFromHips: [0.0754, -0.0877, 0] as const,
  lowerFromUpper: [0.0083, -0.4358, -0.0013] as const,
  footFromLower: [0.0083, -0.4443, -0.0334] as const,
  ankleWorldY: 0.0983,
  bboxFeetY: 0.0007,
  heightMeters: 1.734
}

interface RigFixture {
  scene: Object3D
  hips: Object3D
  nodes: Record<string, Object3D>
  leftFoot: Object3D
  rightFoot: Object3D
  leftUpper: Object3D
  rightUpper: Object3D
}

/** 建最小 normalized humanoid rig（带本模型真实比例；脚骨 y≈0.0983，bbox 脚底≈0）。 */
function makeRig(): RigFixture {
  const scene = new Object3D()
  const hips = new Object3D()
  hips.name = 'hips'
  hips.position.set(...REST.hips)
  scene.add(hips)
  const nodes: Record<string, Object3D> = { hips }
  const makeLeg = (side: 'left' | 'right', sign: number): { upper: Object3D; foot: Object3D } => {
    const upper = new Object3D()
    upper.name = `${side}UpperLeg`
    upper.position.set(
      sign * REST.upperFromHips[0],
      REST.upperFromHips[1],
      REST.upperFromHips[2]
    )
    hips.add(upper)
    const lower = new Object3D()
    lower.name = `${side}LowerLeg`
    lower.position.set(
      sign * REST.lowerFromUpper[0],
      REST.lowerFromUpper[1],
      REST.lowerFromUpper[2]
    )
    upper.add(lower)
    const foot = new Object3D()
    foot.name = `${side}Foot`
    foot.position.set(
      sign * REST.footFromLower[0],
      REST.footFromLower[1],
      REST.footFromLower[2]
    )
    lower.add(foot)
    nodes[`${side}UpperLeg`] = upper
    nodes[`${side}LowerLeg`] = lower
    nodes[`${side}Foot`] = foot
    return { upper, foot }
  }
  const left = makeLeg('left', 1)
  const right = makeLeg('right', -1)
  scene.updateMatrixWorld(true)
  return {
    scene,
    hips,
    nodes,
    leftFoot: left.foot,
    rightFoot: right.foot,
    leftUpper: left.upper,
    rightUpper: right.upper
  }
}

function makeAvatar(rig: RigFixture): VrmAvatar {
  return {
    asset: { id: 'test', file: 'vrm/test.vrm', heightMeters: REST.heightMeters, expressions: {} },
    vrm: {
      humanoid: {
        getNormalizedBoneNode: (name: string) => rig.nodes[name] ?? null
      }
    },
    scene: rig.scene,
    expressionNames: [],
    materialNames: [],
    capabilities: {},
    restHeightMeters: REST.heightMeters,
    restFeetY: REST.bboxFeetY,
    bodyAspectRatio: 0.5,
    hipsRestHeight: REST.hips[1],
    textureCount: 0,
    missingTextures: [],
    vertexCount: 0,
    triangleCount: 0,
    dispose: () => undefined
  } as unknown as VrmAvatar
}

function makeInput(overrides: Partial<AnimationInput> = {}): AnimationInput {
  return {
    dt: 0.033,
    mood: 'idle',
    motion: {
      feet: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      facing: 'front',
      grounded: true,
      surfaceId: 'screen-bottom',
      airborne: false
    },
    facing: 'front',
    lookTarget: null,
    petRect: { x: 0, y: 0, width: 200, height: 540 },
    viewportHeight: 900,
    dragging: false,
    events: [],
    bubbleText: null,
    ...overrides
  }
}

/** 模拟 clip-player 每帧先把 normalized hips 写回 rest（本模块的骨盆下沉不累积）。 */
function resetHips(rig: RigFixture): void {
  rig.hips.position.set(...REST.hips)
}

function footLocal(scene: Object3D, foot: Object3D): Vector3 {
  scene.updateMatrixWorld(true)
  const world = foot.getWorldPosition(new Vector3())
  return scene.worldToLocal(world)
}

function footWorld(foot: Object3D): Vector3 {
  foot.updateWorldMatrix(true, false)
  return foot.getWorldPosition(new Vector3())
}

/** 稳定接触（步进 N 帧，每帧模拟 clip 写回 hips）。 */
function settle(lock: VrmFootLock, rig: RigFixture, frames = 30, input = makeInput()): void {
  for (let index = 0; index < frames; index += 1) {
    resetHips(rig)
    lock.update(input)
  }
}

function setUpperWorldTilt(upper: Object3D, angleRad: number): void {
  upper.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), angleRad)
}

/** 腿链骨骼名（作者姿态复位用）。 */
const LEG_BONE_NAMES = [
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot'
] as const

/**
 * 模拟 clip-player 每帧把「作者姿态」绝对写回 normalized 骨：hips 复位 + 腿/脚局部旋转复位。
 * （现有 `resetHips` 只复位 hips，用于验证骨盆补偿类用例；A/B 的用例需要每帧都从干净作者
 *  姿态出发，否则上一帧的 IK 结果会被误当成「当前 clip 作者姿态」。）
 */
function resetPose(rig: RigFixture): void {
  resetHips(rig)
  for (const name of LEG_BONE_NAMES) rig.nodes[name].quaternion.identity()
}

/* ---- R1 抬脚用例：真实作者抬脚（小腿屈曲、骨长不变；不是平移 foot 骨） ---- */

/** 小腿 rest 向量 knee→ankle（`REST.footFromLower`；x 符号不影响竖直抬升计算）。 */
const LOWER_TO_ANKLE_REST = new Vector3(...REST.footFromLower)
/** 绕 X 轴屈曲小腿用的轴（测试 rig 无父级旋转 → 局部 X = 世界 X）。 */
const X_AXIS = new Vector3(1, 0, 0)
/** 绕 Z 轴外展大腿用的轴（同上，局部 Z = 世界 Z）。 */
const Z_AXIS = new Vector3(0, 0, 1)

/** 小腿绕 X 屈曲 angleRad 时踝的抬升（米；0..π/2 单调）。 */
function ankleLiftForLowerBend(angleRad: number): number {
  const y = LOWER_TO_ANKLE_REST.y * Math.cos(angleRad) - LOWER_TO_ANKLE_REST.z * Math.sin(angleRad)
  return y - LOWER_TO_ANKLE_REST.y
}

/** 反解「踝抬升 liftM」对应的小腿屈曲角（二分；测试用）。 */
function lowerBendForLift(liftM: number): number {
  let lo = 0
  let hi = Math.PI / 2
  for (let index = 0; index < 40; index += 1) {
    const mid = (lo + hi) / 2
    if (ankleLiftForLowerBend(mid) < liftM) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function nodeWorldPos(node: Object3D): Vector3 {
  node.updateWorldMatrix(true, false)
  return node.getWorldPosition(new Vector3())
}

/** 单腿形态读数（scene 局部 = 世界，本 rig 无场景变换）。 */
interface LegShape {
  /** 膝相对踝的向量（米）。 */
  kneeFromAnkle: Vector3
  /** 膝屈曲角（度；180° = 完全伸直）。 */
  kneeFlexDeg: number
}

function readLegShape(rig: RigFixture, side: 'left' | 'right'): LegShape {
  rig.scene.updateMatrixWorld(true)
  const hip = nodeWorldPos(rig.nodes[`${side}UpperLeg`])
  const knee = nodeWorldPos(rig.nodes[`${side}LowerLeg`])
  const ankle = nodeWorldPos(rig.nodes[`${side}Foot`])
  // 先取相对向量再做归一化（避免别名覆写位置向量）。
  const kneeFromAnkle = knee.clone().sub(ankle)
  const hipFromKnee = hip.sub(knee)
  const ankleFromKnee = ankle.sub(knee)
  const interior =
    (Math.acos(
      Math.max(-1, Math.min(1, hipFromKnee.normalize().dot(ankleFromKnee.normalize())))
    ) *
      180) /
    Math.PI
  return { kneeFromAnkle, kneeFlexDeg: 180 - interior }
}

function maxLegShapeError(
  rig: RigFixture,
  reference: Record<'left' | 'right', LegShape>
): { kneeM: number; flexDeg: number } {
  let kneeM = 0
  let flexDeg = 0
  for (const side of ['left', 'right'] as const) {
    const runtime = readLegShape(rig, side)
    kneeM = Math.max(kneeM, runtime.kneeFromAnkle.distanceTo(reference[side].kneeFromAnkle))
    flexDeg = Math.max(flexDeg, Math.abs(runtime.kneeFlexDeg - reference[side].kneeFlexDeg))
  }
  return { kneeM, flexDeg }
}

/* -------------------------------------------------------------------------- */
/* solveKneePosition（解析两骨 IK，纯函数）                                     */
/* -------------------------------------------------------------------------- */

describe('solveKneePosition（解析两骨 IK）', () => {
  it('目标在腿长范围内：膝到 hip 的距离等于 L1、到目标距离等于 L2', () => {
    const knee = solveKneePosition(
      new Vector3(0, 0, 0),
      new Vector3(0, -0.5, 0),
      new Vector3(0, -0.3, 0.05),
      0.3,
      0.3
    )
    expect(Math.hypot(knee.x, knee.y, knee.z)).toBeCloseTo(0.3, 2)
    expect(Math.hypot(knee.x - 0, knee.y + 0.5, knee.z)).toBeCloseTo(0.3, 2)
  })

  it('目标超出腿长：距离被钳制且返回有限坐标（不 NaN）', () => {
    const knee = solveKneePosition(
      new Vector3(0, 0, 0),
      new Vector3(2, -2, 0),
      new Vector3(0, -0.3, 0),
      0.3,
      0.3
    )
    expect(Number.isFinite(knee.x)).toBe(true)
    expect(Number.isFinite(knee.y)).toBe(true)
    expect(Math.hypot(knee.x, knee.y, knee.z)).toBeCloseTo(0.3, 2)
  })

  it('R-03：传 scratch 与不传结果一致，且复用同一个输出对象（零分配路径）', () => {
    const hip = new Vector3(0.02, 1.05, -0.01)
    const targetFoot = new Vector3(0.08, 0.1, 0.04)
    const currentKnee = new Vector3(0.05, 0.55, 0.09)
    const poleHint = new Vector3(1, 0.2, 0)

    const plain = solveKneePosition(hip, targetFoot, currentKnee, 0.4358, 0.4456, poleHint)
    const scratch = createFootLockScratch()
    const reused = solveKneePosition(hip, targetFoot, currentKnee, 0.4358, 0.4456, poleHint, scratch)
    expect(reused).toBe(scratch.knee)
    expect(reused.x).toBeCloseTo(plain.x, 12)
    expect(reused.y).toBeCloseTo(plain.y, 12)
    expect(reused.z).toBeCloseTo(plain.z, 12)

    // 连续调用复用同一输出对象（不会每帧 new Vector3）。
    const again = solveKneePosition(hip, targetFoot, currentKnee, 0.4358, 0.4456, undefined, scratch)
    expect(again).toBe(scratch.knee)
    expect(again).not.toBe(plain)

    // 退化路径（目标方向 ≈ 零）同样兼容 scratch。
    const degenerate = new Vector3(0.02, 1.05, -0.01)
    const plainDegenerate = solveKneePosition(hip, degenerate, currentKnee, 0.3, 0.3)
    const scratchDegenerate = solveKneePosition(hip, degenerate, currentKnee, 0.3, 0.3, undefined, scratch)
    expect(scratchDegenerate.x).toBeCloseTo(plainDegenerate.x, 12)
    expect(scratchDegenerate.y).toBeCloseTo(plainDegenerate.y, 12)
    expect(scratchDegenerate.z).toBeCloseTo(plainDegenerate.z, 12)
  })
})

/* -------------------------------------------------------------------------- */
/* 接触判定（旧实现根因回归）                                                    */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：接触判定基准 = rest 踝高（不是 bbox 脚底）', () => {
  it('真实比例模型（踝 9.8cm、bbox 脚底≈0）站立时必须锁定——旧实现永远不触发', () => {
    const rig = makeRig()
    const avatar = makeAvatar(rig)
    // 先确认 rig 本身复现了旧实现失效的前提。
    expect(footLocal(rig.scene, rig.leftFoot).y).toBeGreaterThan(0.09)
    expect(avatar.restFeetY).toBeLessThan(0.002)

    const lock = new VrmFootLock(avatar)
    settle(lock, rig, 30)
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.rightPinned).toBe(true)
    expect(snapshot.leftWeight).toBeGreaterThan(0.9)
    expect(snapshot.rightWeight).toBeGreaterThan(0.9)
  })

  it('锚点误差接近 0（钉住后脚不漂）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 40)
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftFootErrorM ?? 1).toBeLessThan(0.01)
    expect(snapshot.rightFootErrorM ?? 1).toBeLessThan(0.01)
  })
})

/* -------------------------------------------------------------------------- */
/* 核心场景：idle 变体 crossfade（站姿脚位差 ~15cm）时脚不滑                     */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：跨 clip 站姿变化（crossfade）保持锚点', () => {
  it('新 clip 把脚横向挪 15cm：接触脚仍留在原锚点（漂移 < 2cm，而不是 15cm）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
    const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()
    expect(lock.getSnapshot().leftPinned).toBe(true)

    // 模拟 crossfade 期间 clip 姿势把脚向外挪：30 帧内上段外展到 10°（脚横向 ~15cm）。
    // 速度 0.15 m/s 低于保持阈值 → 仍应视为接触（这正是「混合位移不是抬脚」的判定）。
    for (let index = 1; index <= 30; index += 1) {
      resetHips(rig)
      const progress = index / 30
      setUpperWorldTilt(rig.leftUpper, (progress * 10 * Math.PI) / 180)
      setUpperWorldTilt(rig.rightUpper, (-progress * 10 * Math.PI) / 180)
      lock.update(makeInput())
    }

    const afterLeft = footLocal(rig.scene, rig.leftFoot)
    const afterRight = footLocal(rig.scene, rig.rightFoot)
    expect(lock.getSnapshot().leftPinned).toBe(true)
    expect(lock.getSnapshot().rightPinned).toBe(true)
    expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.9)
    // 未被 IK 修正时脚会横向移动 ~15cm；钉住后应远小于 3cm。
    expect(afterLeft.distanceTo(anchorLeft)).toBeLessThan(0.03)
    expect(afterRight.distanceTo(anchorRight)).toBeLessThan(0.03)
  })

  it('脚朝向锚定：偏差小于软跟随阈值（9°）时脚掌世界朝向不跟着转', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    const anchorQuat = new Quaternion()
    rig.leftFoot.getWorldQuaternion(anchorQuat)

    // 0.12rad ≈ 6.9° < 9°（ORIENTATION_SOFT_FOLLOW_RAD）→ 仍刚性地保持锚定朝向。
    for (let index = 1; index <= 30; index += 1) {
      resetHips(rig)
      setUpperWorldTilt(rig.leftUpper, (index / 30) * 0.12)
      setUpperWorldTilt(rig.rightUpper, (-index / 30) * 0.12)
      lock.update(makeInput())
    }
    const afterQuat = new Quaternion()
    rig.leftFoot.getWorldQuaternion(afterQuat)
    const angleDeg = (2 * Math.acos(Math.min(1, Math.abs(anchorQuat.dot(afterQuat)))) * 180) / Math.PI
    expect(angleDeg).toBeLessThan(5)
  })
})

/* -------------------------------------------------------------------------- */
/* 身体移动：IK 补偿（脚的世界位置保持）                                        */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：身体缓慢移动时接触脚世界位置保持', () => {
  it('hips 横向缓慢移动 10cm：脚世界位置基本不动（IK 把脚拉回锚点）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    const pinnedWorld = footWorld(rig.leftFoot).clone()

    // 每帧 0.5cm（≈0.15 m/s < 保持速度阈值），共 20 帧 = 10cm。
    for (let index = 0; index < 20; index += 1) {
      resetHips(rig)
      rig.hips.position.x += 0.005 * (index + 1)
      lock.update(makeInput())
    }
    const after = footWorld(rig.leftFoot)
    expect(after.x - pinnedWorld.x).toBeLessThan(0.02)
    expect(after.x - pinnedWorld.x).toBeGreaterThan(-0.02)
    expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.9)
  })

  it('v2（3d）：身体抬高 1.5cm 时由 g 的 hipShiftYM=−1.5cm 接管，pelvisDrop 保持 0、脚仍钉住', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    // 抬高 1.5cm：踝抬升 1.5cm 仍 < 2cm 退出迟滞（R1 后），hip 离锚点远了 1.5cm。
    // 旧 A 走 pelvisDrop（≤4cm）；g 用 δy（垂直偏移）把髋→踝距离恢复成作者值——两者都是
    // 「骨盆下沉」，但 g 的下沉量精确等于距离差，因此膝角与脚位同时保持。
    for (let index = 0; index < 90; index += 1) {
      resetHips(rig)
      rig.hips.position.y += 0.015
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.stanceAlignMode).toBe('3d')
    expect(snapshot.leftPinned).toBe(true)
    // g：δy ≈ −1.5cm（只下沉不抬升；钳制区间内）。
    expect(snapshot.hipShiftYM ?? 0).toBeLessThan(-0.012)
    expect(snapshot.hipShiftYM ?? 0).toBeGreaterThan(-0.018)
    expect(Math.abs(snapshot.hipShiftXM ?? 0)).toBeLessThan(0.002)
    expect(Math.abs(snapshot.hipShiftZM ?? 0)).toBeLessThan(0.002)
    // g 生效时可达性 targetDrop 固定 0 → 旧 pelvisDrop 不再叠加（避免再压 1–2mm 造成膝差）。
    expect(snapshot.pelvisDropM ?? 0).toBe(0)
    expect(snapshot.leftFootErrorM ?? 1).toBeLessThan(0.01)
    expect(snapshot.rightFootErrorM ?? 1).toBeLessThan(0.01)
  })

  it('v2（mean 回退通道）：身体抬高 1.5cm 仍走旧 A 的 pelvisDrop（≤4cm），行为与 v1 一致', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig), { stanceAlignMode: 'mean' })
    settle(lock, rig, 30)
    for (let index = 0; index < 60; index += 1) {
      resetHips(rig)
      rig.hips.position.y += 0.015
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.stanceAlignMode).toBe('mean')
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.pelvisDropM ?? 0).toBeGreaterThan(0.01)
    expect(snapshot.pelvisDropM ?? 0).toBeLessThanOrEqual(0.04)
    expect(snapshot.leftFootErrorM ?? 1).toBeLessThan(0.01)
  })
})

/* -------------------------------------------------------------------------- */
/* 禁用条件：不破坏走路/拖拽/坐/睡                                              */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：只在静止动作启用', () => {
  it('拖拽（dragging=true）不锁；从待机进入拖拽时权重平滑淡出（不瞬间弹回）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.9)

    // 刚进入拖拽的前几帧：IK 权重要平滑下降（防「待机→拖拽起手」脚瞬间跳位）。
    for (let index = 0; index < 3; index += 1) {
      resetHips(rig)
      lock.update(makeInput({ dragging: true }))
    }
    expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.4)

    for (let index = 0; index < 40; index += 1) {
      resetHips(rig)
      lock.update(makeInput({ dragging: true }))
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.rightPinned).toBe(false)
    expect(snapshot.leftWeight).toBeLessThan(0.05)
  })

  it.each(['walk', 'climb', 'fall', 'grabWindow', 'sit', 'sleep'] as const)(
    'mood=%s 不锁（走路滑步另由步幅地速校准负责）',
    (mood) => {
      const rig = makeRig()
      const lock = new VrmFootLock(makeAvatar(rig))
      for (let index = 0; index < 40; index += 1) {
        resetHips(rig)
        lock.update(
          makeInput({
            mood,
            motion: { ...makeInput().motion, grounded: mood !== 'fall' && mood !== 'climb' }
          })
        )
      }
      const snapshot = lock.getSnapshot()
      expect(snapshot.leftPinned).toBe(false)
      expect(snapshot.rightPinned).toBe(false)
    }
  )

  it('未接地（grounded=false，空中）不锁', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    for (let index = 0; index < 30; index += 1) {
      resetHips(rig)
      lock.update(makeInput({ motion: { ...makeInput().motion, grounded: false } }))
    }
    expect(lock.getSnapshot().leftPinned).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* 释放条件                                                                     */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：抬脚/不可达时释放（不硬拽）', () => {
  it('抬脚超过退出迟滞 → 权重淡出并释放', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    expect(lock.getSnapshot().leftPinned).toBe(true)

    // 整体抬高 12cm（> 2cm 退出迟滞）。
    for (let index = 0; index < 40; index += 1) {
      resetHips(rig)
      rig.hips.position.y += 0.12
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.rightPinned).toBe(false)
    expect(snapshot.leftWeight).toBeLessThan(0.05)
  })

  it('R1：作者单脚抬升 4cm（hsr-idleShow 实测 4.1cm）→ 旧 5cm 阈值内即释放、权重按 τout 淡出、脚随动画抬起', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    expect(lock.getSnapshot().rightPinned).toBe(true)
    const restAnkleY = footLocal(rig.scene, rig.rightFoot).y

    // 作者动画抬右脚 4cm（小腿屈曲、骨长不变，模拟真实抬脚而非平移 foot 骨）：
    // 18 帧缓慢抬起 → 踝水平速度 < 0.9m/s，唯一可能的释放条件是「抬升 > 退出阈值」
    // （R1 后 2cm；旧 5cm 不会释放 → 正是 hsr-idleShow 被 IK 钉回地面、右膝 +22° 的根因）。
    const theta = lowerBendForLift(0.04)
    let releaseLift: number | null = null
    let fadeWeight: number | null = null
    for (let index = 1; index <= 18; index += 1) {
      resetPose(rig)
      rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, (theta * index) / 18)
      lock.update(makeInput())
      const snapshot = lock.getSnapshot()
      if (releaseLift === null && (snapshot.rightWeight ?? 1) < 0.95) {
        releaseLift = snapshot.rightFootLiftM ?? null
        fadeWeight = snapshot.rightWeight ?? null
      }
    }
    // 释放发生在抬升 > 2cm 之后、且在旧退出阈值 5cm 之内（否则旧实现不会误钉，R1 无从谈起）。
    expect(releaseLift).not.toBeNull()
    expect(releaseLift ?? 0).toBeGreaterThan(0.02)
    expect(releaseLift ?? 1).toBeLessThan(0.05)
    // 首帧淡出符合 tauOut=0.15s（不是瞬间归零）。
    const expectedFadeWeight = Math.exp(-makeInput().dt / 0.15)
    expect(fadeWeight ?? 0).toBeCloseTo(expectedFadeWeight, 2)
    expect(fadeWeight ?? 1).toBeLessThan(0.9)

    // 保持作者抬脚姿态：完全释放后脚跟着作者动画抬起（≈ rest 踝高 + 4cm），不是被钉回地面。
    for (let index = 0; index < 40; index += 1) {
      resetPose(rig)
      rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, theta)
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.rightPinned).toBe(false) // 没被 IK 钉回地面
    expect(snapshot.rightWeight).toBeLessThan(0.05)
    expect(snapshot.leftPinned).toBe(true) // 另一只脚不受影响、仍钉住
    const liftedY = footLocal(rig.scene, rig.rightFoot).y
    expect(liftedY - restAnkleY).toBeGreaterThan(0.035)
    expect(liftedY - restAnkleY).toBeLessThan(0.045)
  })

  it('R1：作者单脚抬升 1cm（< 2cm 退出阈值）→ 仍视为着地，保持钉住', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()
    // 真实抬脚 1cm（小腿屈曲、骨长不变）：低于 2cm 退出阈值 → 仍算着地。
    const theta = lowerBendForLift(0.01)
    for (let index = 1; index <= 20; index += 1) {
      resetPose(rig)
      rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, (theta * index) / 20)
      lock.update(makeInput())
    }
    for (let index = 0; index < 20; index += 1) {
      resetPose(rig)
      rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, theta)
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.rightPinned).toBe(true)
    expect(snapshot.rightWeight).toBeGreaterThan(0.9)
    // 1cm 抬升被当作「着地」，IK 仍把踝钉回地面锚点（脚不滑、不释放）。
    expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.008)
  })

  it('R1 可配置性：显式传旧阈值（enter 3cm/exit 5cm）时同样抬 4cm 仍保持钉住', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig), {
      contactEnterLiftM: 0.03,
      contactExitLiftM: 0.05
    })
    settle(lock, rig, 30)
    const theta = lowerBendForLift(0.04)
    for (let index = 1; index <= 18; index += 1) {
      resetPose(rig)
      rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, (theta * index) / 18)
      lock.update(makeInput())
    }
    for (let index = 0; index < 20; index += 1) {
      resetPose(rig)
      rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, theta)
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.rightPinned).toBe(true)
    expect(snapshot.rightWeight).toBeGreaterThan(0.95)
  })

  it('目标超出腿长 + 骨盆下沉上限 → 释放而不是把腿拉到极限', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    // 身体横向缓慢移动（速度低于保持阈值：0.02m / 0.033s ≈ 0.6 m/s，仍 < 0.9；
    // 距离逐渐超出「腿长 + 骨盆下沉上限」→ 应释放并淡出）。
    for (let index = 0; index < 60; index += 1) {
      resetHips(rig)
      rig.hips.position.x += 0.02 * (index + 1)
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.leftWeight).toBeLessThan(0.05)
    // 释放后脚跟随 clip（最终脚位有限、不 NaN）。
    const local = footLocal(rig.scene, rig.leftFoot)
    expect(Number.isFinite(local.x)).toBe(true)
  })

  it('恢复正常后重新接触（释放不是永久的）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    // 抬起 → 释放。
    for (let index = 0; index < 40; index += 1) {
      resetHips(rig)
      rig.hips.position.y += 0.12
      lock.update(makeInput())
    }
    expect(lock.getSnapshot().leftPinned).toBe(false)
    // 落回地面、静止 → 重新锁定。
    settle(lock, rig, 60)
    expect(lock.getSnapshot().leftPinned).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* crossfade 期间冻结接触状态（未混合/过渡语义）                                 */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：crossfade（transitioning=true）期间冻结接触状态', () => {
  /**
   * 模拟 idle 变体 crossfade 的混合位移：3 帧内上段快速外展到 9°。
   * 踝横向峰值 ≈0.046m/帧 ≈1.4m/s（> 0.9 保持速度阈值）；9° 时踝抬升 ≈1.3cm
   * < R1 的 2cm 退出阈值 → 过渡结束后仍算落地（若旧口径 5cm 也是落地）。
   */
  function fastBlendLegs(rig: RigFixture, progress: number): void {
    const angle = progress * 9
    setUpperWorldTilt(rig.leftUpper, (angle * Math.PI) / 180)
    setUpperWorldTilt(rig.rightUpper, (-angle * Math.PI) / 180)
  }

  it('transitioning=true 时即使合成脚速超阈值也不释放；过渡结束脚仍在锚点', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()

    // 3 帧快速混合（≈1.4m/s > 0.9 保持阈值）：每帧的脚位突变不得被误判成抬脚/换脚。
    for (let index = 1; index <= 3; index += 1) {
      resetPose(rig)
      fastBlendLegs(rig, index / 3)
      lock.update(makeInput(), { transitioning: true })
    }
    expect(lock.getSnapshot().leftPinned).toBe(true)
    expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.9)

    // 过渡结束：新 clip 站姿停在 9° 外展、踝抬升 ≈1.3cm < 2cm（R1 之后仍算着地）→ 保持钉住。
    for (let index = 0; index < 20; index += 1) {
      resetPose(rig)
      fastBlendLegs(rig, 1)
      lock.update(makeInput(), { transitioning: false })
    }
    expect(lock.getSnapshot().leftPinned).toBe(true)
    const afterLeft = footLocal(rig.scene, rig.leftFoot)
    expect(afterLeft.distanceTo(anchorLeft)).toBeLessThan(0.03)
  })

  it('对照：不冻结时同样的快速混合位移会触发释放（证明 freeze 有实际作用）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    for (let index = 1; index <= 3; index += 1) {
      resetPose(rig)
      fastBlendLegs(rig, index / 3)
      lock.update(makeInput())
    }
    expect(lock.getSnapshot().leftWeight).toBeLessThan(0.9)
  })
})

/* -------------------------------------------------------------------------- */
/* 近伸直腿的膝平面保持（poleHint）                                             */
/* -------------------------------------------------------------------------- */

describe('solveKneePosition：近伸直腿用 poleHint 保持膝平面', () => {
  it('当前膝平面退化时，膝位置落在 poleHint 一侧（不是默认 +Z 翻转）', () => {
    const knee = solveKneePosition(
      new Vector3(0, 0, 0),
      new Vector3(0, -0.87, 0),
      new Vector3(0, -0.435, -0.0001), // 近共线（极向量退化）
      0.44,
      0.44,
      new Vector3(0, 0, -1) // 上一帧膝平面朝 -Z
    )
    expect(knee.z).toBeLessThan(0)
  })

  it('当前膝平面明确时，以当前姿态为准（poleHint 不覆盖）', () => {
    const knee = solveKneePosition(
      new Vector3(0, 0, 0),
      new Vector3(0, -0.87, 0),
      new Vector3(0, -0.435, 0.2),
      0.44,
      0.44,
      new Vector3(0, 0, -1)
    )
    expect(knee.z).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/* allow 门控（一次性/手动 clip 不锁）                                          */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：allow=false（一次性/手动 clip）不锁', () => {
  it('待机锁定后 allow=false：权重淡出并解除（表演/过场不误锁）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    expect(lock.getSnapshot().leftPinned).toBe(true)
    for (let index = 0; index < 40; index += 1) {
      resetHips(rig)
      lock.update(makeInput(), { allow: false })
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.leftWeight).toBeLessThan(0.05)
  })
})

/* -------------------------------------------------------------------------- */
/* 转身/换脚释放（脚朝向偏差）                                                  */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock：目标动画脚朝向持续偏转 → 释放（不硬拧脚踝）', () => {
  /** 把脚（目标动画）绕 Y 轴转 deg 度（模拟表演型 idle 的转身/换脚）。 */
  function setFootYaw(foot: Object3D, deg: number): void {
    foot.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (deg * Math.PI) / 180)
  }

  function footYawDeg(foot: Object3D): number {
    foot.updateWorldMatrix(true, false)
    const quat = foot.getWorldQuaternion(new Quaternion())
    // 绕 Y 的 yaw：把局部 +Z 方向投到水平面。
    const dir = new Vector3(0, 0, 1).applyQuaternion(quat)
    return (Math.atan2(dir.x, dir.z) * 180) / Math.PI
  }

  it('偏转 60° 持续 >0.25s → 释放并按新朝向重锚（脚跟随作者转身，不硬拧脚踝）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    expect(lock.getSnapshot().leftPinned).toBe(true)
    for (let index = 0; index < 40; index += 1) {
      resetHips(rig)
      setFootYaw(rig.leftFoot, 60)
      setFootYaw(rig.rightFoot, 60)
      lock.update(makeInput())
    }
    // 重锚后脚朝向跟到新方向（≈60°），而不是被锁死在旧朝向。
    expect(lock.getSnapshot().leftPinned).toBe(true)
    expect(Math.abs(footYawDeg(rig.leftFoot))).toBeGreaterThan(40)
  })

  it('短暂偏转 60°（<0.25s）→ 不释放、不重锚（恢复后仍按旧朝向锚定）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    for (let index = 0; index < 30; index += 1) {
      resetPose(rig)
      lock.update(makeInput())
    }
    // 尖峰 5 帧（0.165s < 0.25s 硬释放时长）：<35° 之前只被 B 软跟随带走一部分。
    for (let index = 0; index < 5; index += 1) {
      resetPose(rig)
      setFootYaw(rig.leftFoot, 60)
      setFootYaw(rig.rightFoot, 60)
      lock.update(makeInput())
    }
    // 恢复：clip 每帧把作者脚朝向写回 0。
    for (let index = 0; index < 20; index += 1) {
      resetPose(rig)
      setFootYaw(rig.leftFoot, 0)
      setFootYaw(rig.rightFoot, 0)
      lock.update(makeInput())
    }
    expect(lock.getSnapshot().leftPinned).toBe(true)
    // 没有「硬释放后按新朝向重锚」：锚点仍是旧的（被软跟随回带，只残留 <9° 迟滞内偏差）。
    expect(Math.abs(footYawDeg(rig.leftFoot))).toBeLessThan(9.5)
    expect(lock.getSnapshot().leftFootOrientationErrDeg ?? 1).toBeLessThan(9.5)
  })

  it('偏转 20° 持续（< 35° 阈值，普通 idle 变体脚 yaw 差）→ 保持锁定', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    for (let index = 0; index < 60; index += 1) {
      resetHips(rig)
      setFootYaw(rig.leftFoot, 20)
      setFootYaw(rig.rightFoot, -20)
      lock.update(makeInput())
    }
    expect(lock.getSnapshot().leftPinned).toBe(true)
    expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.9)
  })
})

/* -------------------------------------------------------------------------- */
/* A（bug A 主修）：锚点-作者脚位对齐（REPORT §7.1 / §8.2）                      */
/* -------------------------------------------------------------------------- */

const ALIGN_DT = 1 / 30

interface RestLock {
  rig: RigFixture
  lock: VrmFootLock
  restShape: Record<'left' | 'right', LegShape>
  anchorLeft: Vector3
  anchorRight: Vector3
}

/**
 * 建锚点（rest 作者姿态）并记录「同 clip 锚定稳态」的腿形/锚点。
 *
 * 基准取锚定稳态（含既有 ≤2mm pelvisDrop）而不是纯作者 rest：本模型腿接近伸直，
 * 屈曲角对 1mm 级骨盆下沉极敏感（4.1°→7.7°），那是 HEAD 就有的既有行为；A 的验收应
 * 隔离「跨变体站姿差是否被消除」，故与同 clip 锚定稳态对照。
 */
function lockAtRest(mode: '3d' | 'mean' = '3d'): RestLock {
  const rig = makeRig()
  const lock = new VrmFootLock(
    makeAvatar(rig),
    mode === 'mean' ? { stanceAlignMode: 'mean' } : undefined
  )
  for (let index = 0; index < 40; index += 1) {
    resetPose(rig)
    lock.update(makeInput())
  }
  expect(lock.getSnapshot().leftPinned).toBe(true)
  expect(lock.getSnapshot().rightPinned).toBe(true)
  const restShape = { left: readLegShape(rig, 'left'), right: readLegShape(rig, 'right') }
  const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
  const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()
  return { rig, lock, restShape, anchorLeft, anchorRight }
}

/**
 * 模拟新 idle 变体的作者姿态：整个骨架沿 x 平移 offset。
 * （等价于「新变体作者踝位相对旧锚点整体差 offset」；A 只读脚的作者位置，故与真实
 *  「腿局部旋转导致的脚位差」在残差口径上一致。）
 */
function authoredTranslatedFrame(rig: RigFixture, offset: number): void {
  resetPose(rig)
  rig.hips.position.x += offset
}

describe('VrmFootLock A：锚点-作者脚位对齐（跨 idle 变体站姿差）', () => {
  it.each([
    // 15cm：完全在 0.18m 预算内 → 腿形应恢复到同 clip 锚定稳态（实测残差 <0.2mm / <0.1°）。
    { offset: 0.15, expectedShiftX: -0.15, kneeTolM: 0.005, flexTolDeg: 1 },
    // 21cm：超出预算 3cm 由 IK 兜底（膝残差 ~4.1cm / 2°；报告 S3 允许钳制后残余畸变）。
    { offset: 0.21, expectedShiftX: -0.18, kneeTolM: 0.05, flexTolDeg: 3 }
  ])(
    '作者脚位整体差 $offset m：hipShift 把骨盆移向锚点、腿恢复作者姿态、脚不滑',
    ({ offset, expectedShiftX, kneeTolM, flexTolDeg }) => {
      const { rig, lock, restShape, anchorLeft, anchorRight } = lockAtRest('mean')
      const shifts: number[] = []
      const alignFrames = 75
      for (let index = 0; index < alignFrames; index += 1) {
        authoredTranslatedFrame(rig, offset)
        // 帧 0 当作 crossfade 冻结（真实 idle 变体切换时 clip-player fading 会冻结接触状态，
        // 避免把 15/21cm 的瞬时位姿差误判成抬脚/超速而释放锚点）。
        lock.update(makeInput(), index === 0 ? { transitioning: true } : undefined)
        shifts.push(lock.getSnapshot().hipShiftXM ?? 0)
      }
      const snapshot = lock.getSnapshot()

      // 收敛到「−作者脚位差」；向量长度被钳制 ≤0.18m（0.21m 用例剩 3cm 交给 IK 兜底）。
      expect(snapshot.hipShiftZM ?? 0).toBeCloseTo(0, 5)
      expect(snapshot.hipShiftXM ?? 0).toBeCloseTo(expectedShiftX, 2)
      expect(Math.hypot(snapshot.hipShiftXM ?? 0, snapshot.hipShiftZM ?? 0)).toBeLessThanOrEqual(0.1801)

      // 平滑：τ=0.3s 生效（首帧增量 ≈ α×目标），无跳变、无过冲。
      const alpha = 1 - Math.exp(-ALIGN_DT / 0.3)
      expect(Math.abs(shifts[0] - expectedShiftX * alpha)).toBeLessThan(0.003)
      let previous = 0
      let maxDelta = 0
      let overshoot = 0
      for (const value of shifts) {
        maxDelta = Math.max(maxDelta, Math.abs(value - previous))
        overshoot = Math.max(overshoot, value, expectedShiftX - value)
        previous = value
      }
      expect(maxDelta).toBeLessThan(0.021)
      expect(overshoot).toBeLessThan(1e-6)

      // 脚仍钉在锚点上（位置不滑）。
      expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
      expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.005)
      expect(snapshot.leftFootErrorM ?? 1).toBeLessThan(0.005)
      expect(snapshot.rightFootErrorM ?? 1).toBeLessThan(0.005)

      // 腿恢复作者姿态（相对形状残差；膝屈曲偏差）。
      const shapeError = maxLegShapeError(rig, restShape)
      expect(shapeError.kneeM).toBeLessThan(kneeTolM)
      expect(shapeError.flexDeg).toBeLessThan(flexTolDeg)

      // 不累积：同一作者姿态再跑 100 帧，hipShift 与 hips 位置不漂移。
      const shiftBefore = lock.getSnapshot().hipShiftXM ?? 0
      authoredTranslatedFrame(rig, offset)
      lock.update(makeInput())
      const hipsBefore = rig.hips.position.clone()
      let maxHipsDrift = 0
      for (let index = 0; index < 100; index += 1) {
        authoredTranslatedFrame(rig, offset)
        lock.update(makeInput())
        maxHipsDrift = Math.max(maxHipsDrift, rig.hips.position.distanceTo(hipsBefore))
      }
      expect(maxHipsDrift).toBeLessThan(0.001)
      expect(Math.abs((lock.getSnapshot().hipShiftXM ?? 0) - shiftBefore)).toBeLessThan(0.001)
    }
  )

  it('残差超预算：目标向量被钳制到 0.18m（方向保持、不放大）', () => {
    const { rig, lock } = lockAtRest('mean')
    // 用 30 帧把作者姿态缓慢平移 0.30m（0.3m/s < 保持阈值 0.9m/s，接触不释放）。
    for (let index = 0; index < 30; index += 1) {
      authoredTranslatedFrame(rig, 0.01 * (index + 1))
      lock.update(makeInput())
    }
    for (let index = 0; index < 60; index += 1) {
      authoredTranslatedFrame(rig, 0.3)
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.rightPinned).toBe(true)
    expect(Math.hypot(snapshot.hipShiftXM ?? 0, snapshot.hipShiftZM ?? 0)).toBeCloseTo(0.18, 3)
    // 方向：hips 朝锚点方向（作者脚位 +x → hips −x）。
    expect(snapshot.hipShiftXM ?? 0).toBeLessThan(-0.17)
  })

  it('mean 回退路径保留旧口径：残差 <5mm（deadband）时 hipShift 保持 0', () => {
    const { rig, lock } = lockAtRest('mean')
    for (let index = 0; index < 60; index += 1) {
      resetPose(rig)
      rig.hips.position.x += 0.003
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.hipShiftXM ?? -1).toBe(0)
    expect(snapshot.hipShiftZM ?? -1).toBe(0)
  })

  it('单脚 pinned 时仍按该脚残差对齐；两脚都未 pin 时目标归零', () => {
    const { rig, lock } = lockAtRest('mean')
    /** 作者姿态：整体平移 0.15m + 左膝缓慢抬起（左脚释放，只剩右脚参与对齐）。 */
    const authorFrame = (progress: number, bent: 'left' | 'both'): void => {
      resetPose(rig)
      rig.hips.position.x += 0.15 * progress
      if (bent === 'left' || bent === 'both') {
        rig.nodes.leftUpperLeg.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.17 * progress)
        rig.nodes.leftLowerLeg.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.9 * progress)
      }
      if (bent === 'both') {
        rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.9 * progress)
      }
    }
    // 抬起过程（避免速度超阈值触发非预期释放路径）。
    for (let index = 0; index < 40; index += 1) {
      authorFrame((index + 1) / 40, 'left')
      lock.update(makeInput())
    }
    for (let index = 0; index < 60; index += 1) {
      authorFrame(1, 'left')
      lock.update(makeInput())
    }
    const oneFoot = lock.getSnapshot()
    expect(oneFoot.rightPinned).toBe(true)
    expect(oneFoot.leftPinned).toBe(false)
    // 只剩右脚残差 = −0.15m；若把抬起的左脚也算进均值会接近 −0.18m（可区分）。
    expect(oneFoot.hipShiftXM ?? 0).toBeLessThan(-0.13)
    expect(oneFoot.hipShiftXM ?? 0).toBeGreaterThan(-0.165)

    // 两脚都抬起（都未 pin）→ 对齐目标归零。
    for (let index = 0; index < 40; index += 1) {
      authorFrame((index + 1) / 40, 'both')
      lock.update(makeInput())
    }
    for (let index = 0; index < 90; index += 1) {
      authorFrame(1, 'both')
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.rightPinned).toBe(false)
    expect(snapshot.hipShiftXM ?? -1).toBe(0)
  })

  it.each([
    { mood: 'walk', dragging: false, grounded: true },
    { mood: 'sit', dragging: false, grounded: true },
    { mood: 'sleep', dragging: false, grounded: true },
    { mood: 'fall', dragging: false, grounded: false },
    { mood: 'idle', dragging: true, grounded: true }
  ])(
    '离开 idle（mood=$mood, dragging=$dragging, grounded=$grounded）：hipShift 按同 τ 归零且不锁定',
    ({ mood, dragging, grounded }) => {
      const { rig, lock } = lockAtRest('mean')
      // 先对齐到 −0.15m（进入一个跨变体 idle）。
      for (let index = 0; index < 75; index += 1) {
        authoredTranslatedFrame(rig, 0.15)
        lock.update(makeInput(), index === 0 ? { transitioning: true } : undefined)
      }
      expect(lock.getSnapshot().hipShiftXM ?? 0).toBeLessThan(-0.1)

      const leaveInput = makeInput({
        mood,
        dragging,
        motion: { ...makeInput().motion, grounded }
      })
      // 1s 内：衰减到 <1cm（τ=0.3s → 1s 约剩 3.5%）。
      for (let index = 0; index < 30; index += 1) {
        resetPose(rig)
        lock.update(leaveInput)
      }
      expect(Math.abs(lock.getSnapshot().hipShiftXM ?? 1)).toBeLessThan(0.01)
      // 3s 内：完全归零、不锁定（walk/climb/fall/drag/grabWindow/sit/sleep 行为不变）。
      for (let index = 0; index < 60; index += 1) {
        resetPose(rig)
        lock.update(leaveInput)
      }
      const snapshot = lock.getSnapshot()
      expect(snapshot.hipShiftXM ?? -1).toBe(0)
      expect(snapshot.hipShiftZM ?? -1).toBe(0)
      expect(snapshot.leftPinned).toBe(false)
      expect(snapshot.rightPinned).toBe(false)
      expect(snapshot.leftWeight).toBeLessThan(0.05)
    }
  )

  it.each([1 / 30, 1 / 60, 1 / 144])('dt=%s s：对齐收敛一致、无 NaN、脚不滑', (dt) => {
    const rig = makeRig()
    // 旧 A（mean 回退通道）的跨帧收敛口径：0.20m 整体平移 → 0.18m 钳制。
    const lock = new VrmFootLock(makeAvatar(rig), { stanceAlignMode: 'mean' })
    const settleFrames = Math.ceil(1.2 / dt)
    for (let index = 0; index < settleFrames; index += 1) {
      resetPose(rig)
      lock.update(makeInput({ dt }))
    }
    const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
    // 0.6s 缓慢平移 0.20m（0.33m/s < 保持阈值），再稳 2.5s。
    const rampFrames = Math.round(0.6 / dt)
    for (let index = 0; index < rampFrames; index += 1) {
      authoredTranslatedFrame(rig, (0.2 * (index + 1)) / rampFrames)
      lock.update(makeInput({ dt }))
    }
    const holdFrames = Math.round(2.5 / dt)
    for (let index = 0; index < holdFrames; index += 1) {
      authoredTranslatedFrame(rig, 0.2)
      lock.update(makeInput({ dt }))
    }
    const snapshot = lock.getSnapshot()
    expect(Number.isFinite(snapshot.hipShiftXM ?? Number.NaN)).toBe(true)
    expect(snapshot.hipShiftXM ?? 0).toBeCloseTo(-0.18, 2)
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.leftFootErrorM ?? 1).toBeLessThan(0.005)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
    expect(Number.isFinite(rig.hips.position.x)).toBe(true)
  })

  it('reset() 后重新锁定：hipShift 从 0 重新累计，无上一轮残留', () => {
    const { rig, lock, anchorLeft } = lockAtRest('mean')
    for (let index = 0; index < 75; index += 1) {
      authoredTranslatedFrame(rig, 0.15)
      lock.update(makeInput(), index === 0 ? { transitioning: true } : undefined)
    }
    expect(lock.getSnapshot().hipShiftXM ?? 0).toBeLessThan(-0.1)

    lock.reset()
    const resetSnapshot = lock.getSnapshot()
    expect(resetSnapshot.hipShiftXM ?? -1).toBe(0)
    expect(resetSnapshot.hipShiftZM ?? -1).toBe(0)
    expect(resetSnapshot.leftPinned).toBe(false)
    expect(resetSnapshot.rightPinned).toBe(false)

    // 用作者 rest 姿态重新锁定：锚点=当前脚位 → hipShift 应保持 0。
    for (let index = 0; index < 40; index += 1) {
      resetPose(rig)
      lock.update(makeInput())
    }
    expect(lock.getSnapshot().leftPinned).toBe(true)
    expect(lock.getSnapshot().hipShiftXM ?? -1).toBe(0)

    // 再切换 15cm 站姿差：从 0 重新累计到 −0.15m，脚仍钉在（新）锚点。
    for (let index = 0; index < 75; index += 1) {
      authoredTranslatedFrame(rig, 0.15)
      lock.update(makeInput(), index === 0 ? { transitioning: true } : undefined)
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.hipShiftXM ?? 0).toBeCloseTo(-0.15, 2)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
  })
})

/* -------------------------------------------------------------------------- */
/* B（bug A 辅修）：脚朝向软跟随（REPORT §7.2）                                 */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock B：脚朝向软跟随', () => {
  /** 把脚（作者姿态）绕 Y 轴转 deg 度（模拟 idle 变体间的脚 yaw 差）。 */
  function setFootYaw(foot: Object3D, deg: number): void {
    foot.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), (deg * Math.PI) / 180)
  }

  function footYawDeg(foot: Object3D): number {
    foot.updateWorldMatrix(true, false)
    const quat = foot.getWorldQuaternion(new Quaternion())
    const dir = new Vector3(0, 0, 1).applyQuaternion(quat)
    return (Math.atan2(dir.x, dir.z) * 180) / Math.PI
  }

  function settleNoYaw(): RestLock {
    return lockAtRest()
  }

  it('偏差 5°（<9° 阈值）不跟随：脚仍按原锚点朝向；左右误差独立上报', () => {
    const { rig, lock, anchorLeft, anchorRight } = settleNoYaw()
    for (let index = 0; index < 60; index += 1) {
      resetPose(rig)
      setFootYaw(rig.leftFoot, 5)
      // 右脚保持作者原朝向（0°）。
      lock.update(makeInput())
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftFootOrientationErrDeg ?? 0).toBeGreaterThan(4)
    expect(snapshot.leftFootOrientationErrDeg ?? 0).toBeLessThan(6)
    expect(Math.abs(snapshot.rightFootOrientationErrDeg ?? 1)).toBeLessThan(0.5)
    // 未被软跟随：脚世界朝向仍被锚定在旧朝向（≈0°）。
    expect(Math.abs(footYawDeg(rig.leftFoot))).toBeLessThan(2)
    // 位置锚定不破坏。
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
    expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.005)
  })

  it('偏差 20°：τ≈0.4s 软跟随收敛到 <5°；位置仍钉在锚点', () => {
    const { rig, lock, anchorLeft } = settleNoYaw()
    const errors: number[] = []
    for (let index = 0; index < 36; index += 1) {
      resetPose(rig)
      setFootYaw(rig.leftFoot, 20)
      setFootYaw(rig.rightFoot, 20)
      lock.update(makeInput())
      errors.push(lock.getSnapshot().leftFootOrientationErrDeg ?? Number.NaN)
    }
    const snapshot = lock.getSnapshot()
    // 首帧测得完整 20° 偏差；约 0.3s（9 帧）时按 τ=0.4s 应剩 ~10°（20·e^(−0.75)≈9.4）。
    expect(errors[0]).toBeCloseTo(20, 0)
    expect(errors[8]).toBeGreaterThan(7.5)
    expect(errors[8]).toBeLessThan(12.5)
    // 1.2s 后偏差 <9°（软跟随在 ORIENTATION_SOFT_FOLLOW_RAD=9° 处停止跟进，平台 ~8.8°）。
    expect(snapshot.leftFootOrientationErrDeg ?? 10).toBeLessThan(9)
    expect(snapshot.rightFootOrientationErrDeg ?? 10).toBeLessThan(9)
    // 脚世界朝向跟到新朝向（不再被硬钉在旧值；剩余 <9° 是软跟随迟滞内允许的残差）。
    expect(footYawDeg(rig.leftFoot)).toBeGreaterThan(10)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
  })

  it('偏差 60°（跟随会把硬释放窗口拖过）：不触发硬释放，权重保持', () => {
    const { rig, lock } = settleNoYaw()
    let minWeight = 1
    for (let index = 0; index < 60; index += 1) {
      resetPose(rig)
      setFootYaw(rig.leftFoot, 60)
      setFootYaw(rig.rightFoot, 60)
      lock.update(makeInput())
      minWeight = Math.min(minWeight, lock.getSnapshot().leftWeight)
    }
    // 60° 在 τ=0.4s 软跟随下 ~0.22s 就降到 35°，攒不满 0.25s 硬释放 → 权重不跌落。
    expect(minWeight).toBeGreaterThan(0.95)
    expect(lock.getSnapshot().leftPinned).toBe(true)
  })

  it('偏差 70°（≥~66°）持续 >0.25s：硬释放安全网仍触发，随后按新朝向重锚/跟随', () => {
    const { rig, lock, anchorLeft } = settleNoYaw()
    let minWeight = 1
    for (let index = 0; index < 60; index += 1) {
      resetPose(rig)
      setFootYaw(rig.leftFoot, 70)
      setFootYaw(rig.rightFoot, 70)
      lock.update(makeInput())
      minWeight = Math.min(minWeight, lock.getSnapshot().leftWeight)
    }
    // 硬释放 → 权重按 tauOut(0.15s) 短暂跌落（安全网未回归）。
    expect(minWeight).toBeLessThan(0.9)
    const snapshot = lock.getSnapshot()
    // 重锚后仍锁定、朝向已跟到作者新朝向、误差归零、位置不动。
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.leftFootOrientationErrDeg ?? 1).toBeLessThan(5)
    expect(footYawDeg(rig.leftFoot)).toBeGreaterThan(60)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
  })
})

/* -------------------------------------------------------------------------- */
/* v2（g）：3-DOF 骨盆距离保持解（替代 A 的均值水平平移）                         */
/* -------------------------------------------------------------------------- */

const G_DT = 1 / 30

/** v2 场景的作者姿态：hips 平移（米）+ 左右小腿屈曲（弧度；膝弯、踝抬高，骨长不变）。 */
interface AuthorPose {
  hipOffsetX?: number
  hipOffsetY?: number
  hipOffsetZ?: number
  lowerBendL?: number
  lowerBendR?: number
  /** 左右大腿绕 Z 外展（弧度；正值 = 各自向外，脚横向分开、抬升 ~L·(1−cos)）。 */
  upperSplayRad?: number
  /** 左右脚绕 Y 作者朝向（度；B 脚朝向软跟随测试用）。 */
  footYawDegL?: number
  footYawDegR?: number
}

/** 应用「新 clip 作者姿态」（模拟 clip-player 每帧绝对写回：先 resetPose，再叠加作者差异）。 */
function applyAuthorPose(rig: RigFixture, pose: AuthorPose): void {
  resetPose(rig)
  rig.hips.position.x += pose.hipOffsetX ?? 0
  rig.hips.position.y += pose.hipOffsetY ?? 0
  rig.hips.position.z += pose.hipOffsetZ ?? 0
  if (pose.upperSplayRad !== undefined) {
    rig.nodes.leftUpperLeg.quaternion.setFromAxisAngle(Z_AXIS, pose.upperSplayRad)
    rig.nodes.rightUpperLeg.quaternion.setFromAxisAngle(Z_AXIS, -pose.upperSplayRad)
  }
  if (pose.lowerBendL !== undefined) {
    rig.nodes.leftLowerLeg.quaternion.setFromAxisAngle(X_AXIS, pose.lowerBendL)
  }
  if (pose.lowerBendR !== undefined) {
    rig.nodes.rightLowerLeg.quaternion.setFromAxisAngle(X_AXIS, pose.lowerBendR)
  }
  if (pose.footYawDegL !== undefined) {
    rig.nodes.leftFoot.quaternion.setFromAxisAngle(
      new Vector3(0, 1, 0),
      (pose.footYawDegL * Math.PI) / 180
    )
  }
  if (pose.footYawDegR !== undefined) {
    rig.nodes.rightFoot.quaternion.setFromAxisAngle(
      new Vector3(0, 1, 0),
      (pose.footYawDegR * Math.PI) / 180
    )
  }
  rig.scene.updateMatrixWorld(true)
}

/** 从干净作者姿态（rest 锚点）测「作者踝位相对锚点的位移」（米；验收「跨站姿差」用）。 */
function authorFootDisplacement(
  rig: RigFixture,
  anchors: { left: Vector3; right: Vector3 },
  pose: AuthorPose
): number {
  applyAuthorPose(rig, pose)
  const left = footLocal(rig.scene, rig.leftFoot)
  const right = footLocal(rig.scene, rig.rightFoot)
  return Math.max(left.distanceTo(anchors.left), right.distanceTo(anchors.right))
}

/**
 * 3d 模式稳态步进：每帧写回作者姿态（含作者差异）→ lock.update。
 * 第 0 帧用 `transitioning:true`（真实 crossfade 期间接触状态冻结，避免把站姿瞬时差误判为抬脚）。
 */
function settleG(
  lock: VrmFootLock,
  rig: RigFixture,
  pose: AuthorPose,
  frames: number,
  dt: number = G_DT
): void {
  for (let index = 0; index < frames; index += 1) {
    applyAuthorPose(rig, pose)
    lock.update(makeInput({ dt }), index === 0 ? { transitioning: true } : undefined)
  }
}

/** 作者姿态的膝屈曲角（度；IK 前测量）。 */
function authorKneeFlex(rig: RigFixture): Record<'left' | 'right', number> {
  rig.scene.updateMatrixWorld(true)
  return {
    left: readLegShape(rig, 'left').kneeFlexDeg,
    right: readLegShape(rig, 'right').kneeFlexDeg
  }
}

describe('VrmFootLock v2（g）：双约束距离精确性 / 膝角 = 作者', () => {
  it('默认模式 = 3d（g 生效）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 20)
    expect(lock.getSnapshot().stanceAlignMode).toBe('3d')
  })

  it.each([
    // 跨 idle 变体站姿差覆盖 15cm / 21cm：用「大腿外展 + 轻微膝屈 + 微小骨盆偏移」构造
    // 真实站姿差（作者双脚各离锚点约 15/21cm；不是整体平移——整体平移会让 g 需要 ≥10cm 位移）。
    { label: '15cm', pose: { upperSplayRad: 0.17, hipOffsetX: 0.02, hipOffsetY: -0.005, lowerBendL: 0.1, lowerBendR: 0.1 } as AuthorPose, expected: 0.15 },
    { label: '21cm', pose: { upperSplayRad: 0.24, hipOffsetX: 0.02, hipOffsetY: -0.015, lowerBendL: 0.1, lowerBendR: 0.1 } as AuthorPose, expected: 0.21 }
  ])(
    '作者站姿差 $label：稳态 |距离残差|<0.5mm、|Δ膝|<2°、脚不滑、δ 不越界',
    ({ label, pose, expected }) => {
      const { rig, lock, anchorLeft, anchorRight } = lockAtRest()
      // 确认构造出的作者站姿差确实在目标量级（双脚相对锚点位移的均值）。
      applyAuthorPose(rig, pose)
      const leftDisp = footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)
      const rightDisp = footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)
      const displacement = (leftDisp + rightDisp) / 2
      expect(Math.abs(displacement - expected)).toBeLessThan(0.03)

      // 作者膝角（IK 前）。
      applyAuthorPose(rig, pose)
      const authored = authorKneeFlex(rig)

      for (let index = 0; index < 120; index += 1) {
        applyAuthorPose(rig, pose)
        lock.update(makeInput({ dt: G_DT }), index === 0 ? { transitioning: true } : undefined)
      }
      const snapshot = lock.getSnapshot()

      // 1) 距离约束精确性：钳制后最大 |距离残差| < 0.5mm。
      expect(snapshot.stanceSolveResidualM ?? 1).toBeLessThan(0.0005)
      expect(snapshot.stanceAlignMode).toBe('3d')

      // 2) 运行时膝角 = 作者膝角（|Δ膝| < 2°，目标 ≤1°）。
      expect(Math.abs((snapshot.kneeFlexDegL ?? 0) - authored.left)).toBeLessThan(2)
      expect(Math.abs((snapshot.kneeFlexDegR ?? 0) - authored.right)).toBeLessThan(2)
      // 调试字段本身口径一致：runtime 值≈实测量、author 值≈IK 前实测量。
      const runtime = authorKneeFlex(rig) // 当前骨骼=IK 后
      expect(Math.abs((snapshot.kneeFlexDegL ?? 0) - runtime.left)).toBeLessThan(0.3)
      expect(Math.abs((snapshot.authorKneeFlexDegL ?? 0) - authored.left)).toBeLessThan(0.3)

      // 3) δ 不越界：|δxz| ≤ 0.10m、δy ∈ [−0.03,+0.02]m。
      const shiftX = snapshot.hipShiftXM ?? 0
      const shiftY = snapshot.hipShiftYM ?? 0
      const shiftZ = snapshot.hipShiftZM ?? 0
      expect(Math.hypot(shiftX, shiftZ)).toBeLessThanOrEqual(0.1001)
      expect(shiftY).toBeGreaterThanOrEqual(-0.0301)
      expect(shiftY).toBeLessThanOrEqual(0.0201)

      // 4) 脚仍钉在锚点（零脚滑）。
      expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
      expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.005)
      expect(snapshot.leftFootErrorM ?? 1).toBeLessThan(0.005)
      expect(snapshot.rightFootErrorM ?? 1).toBeLessThan(0.005)
      expect(snapshot.leftPinned).toBe(true)
      expect(snapshot.rightPinned).toBe(true)
    }
  )

  it('单脚 pinned：解析最小范数解 δ=(d/|hip−pin|−1)·(hip−pin) 精确生效', () => {
    const { rig, lock, anchorRight } = lockAtRest()
    // 作者姿态：整体平移 6cm + 右小腿轻屈 0.15rad（右踝抬升 <2cm，仍接触）；
    // 左小腿重屈 0.4rad（左踝抬升 >2cm → 左脚释放，只剩右脚约束）。
    const pose: AuthorPose = {
      hipOffsetX: 0.06,
      lowerBendL: 0.4,
      lowerBendR: 0.15
    }
    for (let index = 0; index < 120; index += 1) {
      applyAuthorPose(rig, pose)
      lock.update(makeInput({ dt: G_DT }), index === 0 ? { transitioning: true } : undefined)
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.rightPinned).toBe(true)
    expect(snapshot.stanceAlignMode).toBe('3d')
    // 解析期望值：用「干净作者姿态」测 hip/ankle 与 d，pin = 右锚点。
    applyAuthorPose(rig, pose)
    const hip = nodeWorldPos(rig.nodes.rightUpperLeg)
    const ankle = nodeWorldPos(rig.rightFoot)
    const pin = anchorRight
    const d = hip.distanceTo(ankle)
    const v = hip.clone().sub(pin)
    const expected = v.clone().multiplyScalar(d / v.length() - 1)
    // 稳态平滑已收敛（τ=0.2s，4s≈20τ）→ 与解析解差 < 2mm。
    expect(snapshot.hipShiftXM ?? 0).toBeCloseTo(expected.x, 3)
    expect(snapshot.hipShiftYM ?? 0).toBeCloseTo(expected.y, 3)
    expect(snapshot.hipShiftZM ?? 0).toBeCloseTo(expected.z, 3)
    // 距离约束成立（单脚解析分支无迭代）。
    expect(snapshot.stanceSolveResidualM ?? 1).toBeLessThan(0.0005)
    expect(snapshot.stanceSolveIterations).toBe(0)
    expect(snapshot.rightFootErrorM ?? 1).toBeLessThan(0.005)
  })

  it('钳制：需要 15cm 水平偏移时 |δxz| 钳到 0.10m、残差仍 <10mm（不回退）、不抖', () => {
    const { rig, lock, anchorLeft } = lockAtRest()
    // 整个骨架整体平移 15cm：g 的精确解是 −15cm → 水平钳制 0.10m。
    const pose: AuthorPose = { hipOffsetX: 0.15 }
    settleG(lock, rig, pose, 100)
    const snapshot = lock.getSnapshot()
    expect(snapshot.stanceAlignMode).toBe('3d')
    expect(Math.hypot(snapshot.hipShiftXM ?? 0, snapshot.hipShiftZM ?? 0)).toBeCloseTo(0.1, 3)
    expect(snapshot.hipShiftXM ?? 0).toBeLessThan(-0.099)
    // 腿接近竖直 → 水平钳制对「髋→踝距离」影响很小：残差仍 <10mm，不回退。
    expect(snapshot.stanceSolveResidualM ?? 1).toBeLessThan(0.01)
    // 不抖：后 30 帧 hipShift 逐帧变化 < 0.05mm。
    let previous: number | null = null
    let maxStep = 0
    for (let index = 0; index < 30; index += 1) {
      applyAuthorPose(rig, pose)
      lock.update(makeInput({ dt: G_DT }))
      const value = lock.getSnapshot().hipShiftXM ?? 0
      if (previous !== null) maxStep = Math.max(maxStep, Math.abs(value - previous))
      previous = value
    }
    expect(maxStep).toBeLessThan(0.00005)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
  })

  it('deadband 0.5mm：亚 0.5mm 的作者微差目标归零（不抖动，也不吃掉必要校正）', () => {
    const { rig, lock } = lockAtRest()
    // 整体平移 0.3mm（<0.5mm deadband）→ 目标归零；投影只会补上「约束本身需要的微小校正」
    // （≤deadband 量级、0.1px 以下），不会抖动。
    const smallShifts: number[] = []
    for (let index = 0; index < 60; index += 1) {
      applyAuthorPose(rig, { hipOffsetX: 0.0003 })
      lock.update(makeInput({ dt: G_DT }), index === 0 ? { transitioning: true } : undefined)
      const shift = lock.getSnapshot().hipShiftXM ?? 0
      smallShifts.push(shift)
    }
    expect(Math.abs(lock.getSnapshot().hipShiftXM ?? 1)).toBeLessThan(0.001)
    expect(Math.abs(lock.getSnapshot().hipShiftym ?? lock.getSnapshot().hipShiftYM ?? 1)).toBeLessThan(0.001)
    expect(Math.abs(lock.getSnapshot().hipShiftZM ?? 1)).toBeLessThan(0.001)
    // 不抖：后 30 帧逐帧变化 <0.01mm。
    let smallStep = 0
    for (let index = smallShifts.length - 30; index < smallShifts.length; index += 1) {
      smallStep = Math.max(smallStep, Math.abs(smallShifts[index] - smallShifts[index - 1]))
    }
    expect(smallStep).toBeLessThan(1e-5)
    // 对照：1.5mm（>deadband）必须真的施加（REPORT 实测必要校正最小约 1mm，不能被 deadband 吃掉）。
    settleG(lock, rig, { hipOffsetX: 0.0015 }, 80)
    expect(Math.abs(lock.getSnapshot().hipShiftXM ?? 0)).toBeGreaterThan(0.0005)
  })

  it("fallback：需要 δy=+5cm 但钳制上限 +2cm → 本帧回退旧 A（'mean'）、不产生 >0.18m 位移、无 NaN", () => {
    const { rig, lock } = lockAtRest()
    // 作者姿态：hips 下沉 5cm（腿不变，踝也下沉 5cm；lift 为负 → 仍算接触）。
    // d_author 不变；pin 在地面 → |hip−pin| 比 d 短 5cm，g 需 δy=+5cm，被钳到 +2cm，
    // 残差 3cm > 10mm → 回退旧 A（g 修不动时保留 v1 行为）。
    const pose: AuthorPose = { hipOffsetY: -0.05 }
    let maxShiftY = 0
    let maxShiftMag = 0
    for (let index = 0; index < 90; index += 1) {
      applyAuthorPose(rig, pose)
      lock.update(makeInput({ dt: G_DT }), index === 0 ? { transitioning: true } : undefined)
      const snapshot = lock.getSnapshot()
      maxShiftY = Math.max(maxShiftY, Math.abs(snapshot.hipShiftYM ?? 0))
      maxShiftMag = Math.max(
        maxShiftMag,
        Math.hypot(snapshot.hipShiftXM ?? 0, snapshot.hipShiftYM ?? 0, snapshot.hipShiftZM ?? 0)
      )
      expect(Number.isFinite(snapshot.hipShiftXM ?? 0)).toBe(true)
      expect(Number.isFinite(snapshot.hipShiftYM ?? 0)).toBe(true)
      expect(Number.isFinite(snapshot.hipShiftZM ?? 0)).toBe(true)
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.stanceAlignMode).toBe('mean')
    // 钳制生效过（δy 峰值不超过 +2cm），回退后 y 目标=0 → 当前 y 已收回。
    expect(maxShiftY).toBeLessThanOrEqual(0.0201)
    expect(Math.abs(snapshot.hipShiftYM ?? 1)).toBeLessThan(0.002)
    // 不产生 >0.18m 位移（旧 A 上限）。
    expect(maxShiftMag).toBeLessThanOrEqual(0.1801)
    // 不释放、不 NaN：脚仍钉住（fallback 保留 release 兜底，但该场景可达）。
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.rightPinned).toBe(true)
    expect(footLocal(rig.scene, rig.leftFoot).y).toBeLessThan(0.12) // 脚仍在地面附近
    // 恢复作者站姿 → 回到 3d 模式、偏移归零。
    settleG(lock, rig, {}, 80)
    const recovered = lock.getSnapshot()
    expect(recovered.stanceAlignMode).toBe('3d')
    expect(Math.abs(recovered.hipShiftYM ?? 1)).toBeLessThan(0.0002)
  })

  it('非累积 / 200 帧稳定 / 30-60-144Hz 收敛一致', () => {
    const pose: AuthorPose = { hipOffsetX: 0.13, lowerBendL: 0.2, lowerBendR: 0.2 }
    const results: Array<{ x: number; y: number; z: number; kneeL: number }> = []
    for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
      const { rig, lock } = lockAtRest()
      // 2.5s 收敛（τ=0.2s → 12.5τ）。
      const frames = Math.round(2.5 / dt)
      for (let index = 0; index < frames; index += 1) {
        applyAuthorPose(rig, pose)
        lock.update(makeInput({ dt }), index === 0 ? { transitioning: true } : undefined)
      }
      const snapshot = lock.getSnapshot()
      results.push({
        x: snapshot.hipShiftXM ?? Number.NaN,
        y: snapshot.hipShiftYM ?? Number.NaN,
        z: snapshot.hipShiftZM ?? Number.NaN,
        kneeL: snapshot.kneeFlexDegL ?? Number.NaN
      })
      expect(Number.isFinite(results[results.length - 1].x)).toBe(true)
      // 非累积：继续 200 帧同样作者姿态，hipShift/hips 位置不漂移、膝角恒定。
      let maxShiftDrift = 0
      let maxKneeDrift = 0
      const baseShift = new Vector3(results[results.length - 1].x, results[results.length - 1].y, results[results.length - 1].z)
      const baseKnee = results[results.length - 1].kneeL
      for (let index = 0; index < 200; index += 1) {
        applyAuthorPose(rig, pose)
        lock.update(makeInput({ dt }))
        const next = lock.getSnapshot()
        maxShiftDrift = Math.max(
          maxShiftDrift,
          new Vector3(next.hipShiftXM ?? 0, next.hipShiftYM ?? 0, next.hipShiftZM ?? 0).distanceTo(baseShift)
        )
        maxKneeDrift = Math.max(maxKneeDrift, Math.abs((next.kneeFlexDegL ?? 0) - baseKnee))
      }
      expect(maxShiftDrift).toBeLessThan(0.001)
      expect(maxKneeDrift).toBeLessThan(0.2)
    }
    // 30/60/144Hz：同一作者姿态收敛到同一偏移（差 <1mm）与同一膝角（<0.5°）。
    for (let index = 1; index < results.length; index += 1) {
      const a = results[0]
      const b = results[index]
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.001)
      expect(Math.abs(a.kneeL - b.kneeL)).toBeLessThan(0.5)
    }
  })

  it.each([
    { mood: 'walk', dragging: false, grounded: true },
    { mood: 'sit', dragging: false, grounded: true },
    { mood: 'sleep', dragging: false, grounded: true },
    { mood: 'fall', dragging: false, grounded: false },
    { mood: 'idle', dragging: true, grounded: true }
  ])(
    '离开 idle（mood=$mood, dragging=$dragging, grounded=$grounded）：δx/y/z 平滑归零、不锁定',
    ({ mood, dragging, grounded }) => {
      const { rig, lock } = lockAtRest()
      // 先建立非零的 3-DOF 偏移（含 y；踝抬升 <2cm 仍接触）。
      const pose: AuthorPose = { hipOffsetX: 0.08, hipOffsetY: 0.01, lowerBendL: 0.1, lowerBendR: 0.1 }
      settleG(lock, rig, pose, 90)
      const settled = lock.getSnapshot()
      expect(Math.abs(settled.hipShiftYM ?? 0)).toBeGreaterThan(0.005)
      const leaveInput = makeInput({
        mood,
        dragging,
        motion: { ...makeInput().motion, grounded }
      })
      for (let index = 0; index < 30; index += 1) {
        resetPose(rig)
        lock.update(leaveInput)
      }
      // 1s 内 → <1cm（τ=0.2s → 1s 约剩 0.7%）。
      for (let index = 0; index < 60; index += 1) {
        resetPose(rig)
        lock.update(leaveInput)
      }
      const snapshot = lock.getSnapshot()
      expect(Math.abs(snapshot.hipShiftXM ?? 1)).toBeLessThan(0.001)
      expect(Math.abs(snapshot.hipShiftYM ?? 1)).toBeLessThan(0.001)
      expect(Math.abs(snapshot.hipShiftZM ?? 1)).toBeLessThan(0.001)
      expect(snapshot.leftPinned).toBe(false)
      expect(snapshot.rightPinned).toBe(false)
      expect(snapshot.leftWeight).toBeLessThan(0.05)
    }
  )

  it('与 B（脚朝向软跟随）共存：位置约束与膝角不受朝向锚定影响', () => {
    const { rig, lock, anchorLeft, anchorRight } = lockAtRest()
    const pose: AuthorPose = {
      hipOffsetX: 0.1,
      lowerBendL: 0.18,
      lowerBendR: 0.18,
      footYawDegL: 20,
      footYawDegR: 20
    }
    applyAuthorPose(rig, pose)
    const authored = authorKneeFlex(rig)
    for (let index = 0; index < 120; index += 1) {
      applyAuthorPose(rig, pose)
      lock.update(makeInput({ dt: G_DT }), index === 0 ? { transitioning: true } : undefined)
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.stanceAlignMode).toBe('3d')
    // 位置约束/膝角与无 yaw 场景一致（B 只改脚朝向锚点，不参与距离约束）。
    expect(Math.abs((snapshot.kneeFlexDegL ?? 0) - authored.left)).toBeLessThan(2)
    expect(Math.abs((snapshot.kneeFlexDegR ?? 0) - authored.right)).toBeLessThan(2)
    expect(snapshot.stanceSolveResidualM ?? 1).toBeLessThan(0.0005)
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.rightPinned).toBe(true)
    // B 软跟随把 20° 朝向差收敛到 <9° 平台；位置仍钉在锚点。
    expect(snapshot.leftFootOrientationErrDeg ?? 99).toBeLessThan(9.5)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.005)
    expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.005)
  })
})

/* -------------------------------------------------------------------------- */
/* v2：pat 禁锁（动态反应不锁脚）                                               */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock v2：pat 动态反应禁锁', () => {
  it('mood=pat + allow=true 也不锁（动态反应触地帧重锚会把腿拉直，REPORT §13.3 表 13-C）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    for (let index = 0; index < 60; index += 1) {
      resetPose(rig)
      lock.update(makeInput({ mood: 'pat' }), { allow: true })
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.rightPinned).toBe(false)
    expect(snapshot.leftWeight).toBe(0)
    expect(snapshot.hipShiftXM ?? 0).toBe(0)
    expect(snapshot.hipShiftYM ?? 0).toBe(0)
  })

  it('idle 锁定后切 pat：接触权重按 tauOut 淡出、δ 归零、不再重锚', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 30)
    expect(lock.getSnapshot().leftPinned).toBe(true)
    for (let index = 0; index < 40; index += 1) {
      resetPose(rig)
      lock.update(makeInput({ mood: 'pat' }), { allow: true })
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.leftWeight).toBeLessThan(0.05)
    expect(snapshot.leftFootErrorM).toBeNull()
    expect(Math.abs(snapshot.hipShiftXM ?? 1)).toBeLessThan(0.001)
  })
})

/* -------------------------------------------------------------------------- */
/* v2：平滑滞后投影（移动目标下的逐帧膝角保持）                                  */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock v2：移动作者姿态下，平滑后的 δ 投影回约束流形', () => {
  it('作者站姿每帧缓慢平移/屈膝变化：逐帧运行时膝角 ≈ 作者（≤0.5°）、δ 无突跳', () => {
    const { rig, lock } = lockAtRest()
    let maxKneeDeviation = 0
    let maxShiftStep = 0
    let previousShift: Vector3 | null = null
    // 2.4s：作者站姿按 0.3Hz 缓慢摆动（横向 ±3cm、膝屈 ±0.04rad）——模拟表演型 idle 的移动目标。
    const frames = 72
    for (let index = 0; index < frames; index += 1) {
      const phase = (index / 30) * 2 * Math.PI * 0.3
      const pose: AuthorPose = {
        hipOffsetX: 0.03 * Math.sin(phase),
        hipOffsetY: 0.004 * Math.cos(phase),
        lowerBendL: 0.1 + 0.04 * Math.sin(phase),
        lowerBendR: 0.1 + 0.04 * Math.sin(phase)
      }
      applyAuthorPose(rig, pose)
      const authored = authorKneeFlex(rig)
      lock.update(makeInput({ dt: G_DT }), index === 0 ? { transitioning: true } : undefined)
      if (index >= 20) {
        const snapshot = lock.getSnapshot()
        maxKneeDeviation = Math.max(
          maxKneeDeviation,
          Math.abs((snapshot.kneeFlexDegL ?? 0) - authored.left),
          Math.abs((snapshot.kneeFlexDegR ?? 0) - authored.right)
        )
        const shift = new Vector3(
          snapshot.hipShiftXM ?? 0,
          snapshot.hipShiftYM ?? 0,
          snapshot.hipShiftZM ?? 0
        )
        if (previousShift !== null) {
          maxShiftStep = Math.max(maxShiftStep, shift.distanceTo(previousShift))
        }
        previousShift = shift
      }
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.stanceAlignMode).toBe('3d')
    // 投影把 τ 滞后造成的距离误差消掉 → 运行时膝角始终贴住作者膝角。
    expect(maxKneeDeviation).toBeLessThan(0.5)
    // 位移平滑（非累积）：逐帧 δ 变化 ≤ 目标速率×α + 投影修正，远小于 1cm。
    expect(maxShiftStep).toBeLessThan(0.01)
    expect(snapshot.stanceSolveResidualM ?? 1).toBeLessThan(0.0005)
  })
})

/* -------------------------------------------------------------------------- */
/* v2：NaN 防御（异常骨骼矩阵不得污染 hips）                                     */
/* -------------------------------------------------------------------------- */

describe('VrmFootLock v2：NaN 防御', () => {
  it('作者骨位置出现 NaN 时：不写 NaN 到 hips、后续帧自动恢复', () => {
    const { rig, lock } = lockAtRest()
    const pose: AuthorPose = { hipOffsetX: 0.05, lowerBendL: 0.1, lowerBendR: 0.1 }
    settleG(lock, rig, pose, 90)
    expect(lock.getSnapshot().stanceAlignMode).toBe('3d')

    // 模拟异常骨骼矩阵：左大腿位置注入 NaN。
    applyAuthorPose(rig, pose)
    rig.nodes.leftUpperLeg.position.set(Number.NaN, Number.NaN, Number.NaN)
    rig.scene.updateMatrixWorld(true)
    lock.update(makeInput({ dt: G_DT }), { transitioning: true })
    const nanSnapshot = lock.getSnapshot()
    expect(Number.isFinite(rig.hips.position.x)).toBe(true)
    expect(Number.isFinite(rig.hips.position.y)).toBe(true)
    expect(Number.isFinite(rig.hips.position.z)).toBe(true)
    expect(Number.isFinite(nanSnapshot.hipShiftXM ?? Number.NaN)).toBe(true)
    expect(Number.isFinite(nanSnapshot.hipShiftYM ?? Number.NaN)).toBe(true)
    expect(Number.isFinite(nanSnapshot.hipShiftZM ?? Number.NaN)).toBe(true)

    // 恢复正常骨位置：锁定/对齐继续工作，不残留 NaN。
    rig.nodes.leftUpperLeg.position.set(...REST.upperFromHips)
    for (let index = 0; index < 60; index += 1) {
      applyAuthorPose(rig, pose)
      lock.update(makeInput({ dt: G_DT }))
    }
    const snapshot = lock.getSnapshot()
    expect(Number.isFinite(rig.hips.position.x)).toBe(true)
    expect(snapshot.leftPinned).toBe(true)
    expect(snapshot.rightPinned).toBe(true)
    expect(snapshot.stanceAlignMode).toBe('3d')
    expect(snapshot.stanceSolveResidualM ?? 1).toBeLessThan(0.001)
  })
})

/* -------------------------------------------------------------------------- */
/* v3（2026-11-11）：换姿势重锚（stance replant）                                */
/* -------------------------------------------------------------------------- */

/**
 * 换姿势重锚测试夹具：
 * - `A` 是 rest 站姿；`B` 是整骨架水平平移 `offsetX` + 下沉 `dropY` 的作者站姿
 *   （等价于「新变体作者踝位相对旧锚点整体差 offsetX」；与真实 idle 变体 15cm 站姿差同口径）；
 * - 克隆/平移整骨架会让新髋→旧 pin 距离略小于腿长（可 IK 到达），与真实 fade 结束时
 *   g 已把骨盆移向新站姿的效果等价；
 * - 每帧先 `resetPose` 模拟 clip-player 绝对写回，再传 `clipId` 走 replant 检测。
 */
const REPLANT_DT = 1 / 30

interface ReplantFrame {
  snapshot: ReturnType<VrmFootLock['getSnapshot']>
  left: Vector3
  right: Vector3
}

function authoredPose(rig: RigFixture, offsetX: number, dropY: number): void {
  resetPose(rig)
  rig.hips.position.x += offsetX
  rig.hips.position.y -= dropY
}

function runReplantFrames(
  lock: VrmFootLock,
  rig: RigFixture,
  clipId: string,
  offsetX: number,
  dropY: number,
  frames: number,
  transitioning = false
): ReplantFrame[] {
  const out: ReplantFrame[] = []
  for (let index = 0; index < frames; index += 1) {
    authoredPose(rig, offsetX, dropY)
    lock.update(makeInput({ dt: REPLANT_DT }), {
      clipId,
      ...(transitioning ? { transitioning: true } : {})
    })
    out.push({
      snapshot: lock.getSnapshot(),
      left: footLocal(rig.scene, rig.leftFoot).clone(),
      right: footLocal(rig.scene, rig.rightFoot).clone()
    })
  }
  return out
}

/** 在当前站姿 A 上锁定（clipId='A'，40 帧 → weight=1）。 */
function lockWithClipA(lock: VrmFootLock, rig: RigFixture): void {
  for (let index = 0; index < 40; index += 1) {
    authoredPose(rig, 0, 0)
    lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'A' })
  }
  expect(lock.getSnapshot().leftPinned).toBe(true)
  expect(lock.getSnapshot().leftWeight).toBeGreaterThan(0.99)
}

/** 模拟 0.9s crossfade：作者姿态从 A 插值到 B（20 帧；首帧 clipId 变化 → pending）。 */
function fadeAtoB(
  lock: VrmFootLock,
  rig: RigFixture,
  offsetX: number,
  dropY: number,
  expectPending = true
): void {
  const fadeFrames = 20
  for (let index = 1; index <= fadeFrames; index += 1) {
    const p = index / fadeFrames
    authoredPose(rig, offsetX * p, dropY * p)
    lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'B', transitioning: true })
  }
  // poseReplant:false / mean 模式下不进入 pending；其余路径 fade 结束应已排队等重踏。
  expect(lock.getSnapshot().replantPending).toBe(expectPending)
}

function assertFiniteSnapshot(snapshot: ReturnType<VrmFootLock['getSnapshot']>): void {
  for (const value of [
    snapshot.leftFootErrorM,
    snapshot.rightFootErrorM,
    snapshot.leftFootLiftM,
    snapshot.rightFootLiftM,
    snapshot.hipShiftXM,
    snapshot.hipShiftYM,
    snapshot.hipShiftZM,
    snapshot.leftReplantLiftM,
    snapshot.rightReplantLiftM,
    snapshot.leftReplantTargetErrM,
    snapshot.rightReplantTargetErrM
  ]) {
    if (value !== null && value !== undefined) expect(Number.isFinite(value)).toBe(true)
  }
}

describe('VrmFootLock v3：换姿势重锚（clipId 变化 → 单脚错峰抬脚到新作者站姿）', () => {
  it('15cm 站姿差：fade 结束后单脚抬脚搬到新作者站姿；落地后 pin=目标、contact 不释放、hipShift≈0', () => {
    const offsetX = 0.15
    const dropY = 0.015
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)
    const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
    const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()

    fadeAtoB(lock, rig, offsetX, dropY)

    // fade 结束后推进重踏（R1 起两脚同步换步，不再错峰；时长 ≈ 单脚 0.3s，约 9–10 帧）。
    const frames = runReplantFrames(lock, rig, 'B', offsetX, dropY, 45)
    const activeFrames = frames.filter((f) => f.snapshot.replantActive)
    // 仍要求持续多帧（≥8），证明是一次完整换步而非瞬时跳变。
    expect(activeFrames.length).toBeGreaterThanOrEqual(8)

    let maxLift = 0
    let maxTargetErr = 0
    // R1 同步换步允许两脚短暂同时离地（实测峰值 2.36cm、持续 0.3s），改为约束该高度有界。
    let maxBothAirborneLift = 0
    let contactLost = false
    let maxHipShiftWhileStepping = 0
    for (const frame of frames) {
      const snapshot = frame.snapshot
      assertFiniteSnapshot(snapshot)
      if (snapshot.replantActive) {
        const liftL = snapshot.leftReplantLiftM ?? 0
        const liftR = snapshot.rightReplantLiftM ?? 0
        maxLift = Math.max(maxLift, liftL, liftR)
        maxTargetErr = Math.max(
          maxTargetErr,
          snapshot.leftReplantTargetErrM ?? 0,
          snapshot.rightReplantTargetErrM ?? 0
        )
        // 两脚同时离地时，记录最大抬脚高度（后面断言不超过 liftMax 0.03m）。
        if (liftL > 0.002 && liftR > 0.002) {
          maxBothAirborneLift = Math.max(maxBothAirborneLift, liftL, liftR)
        }
        // 重踏期 contact/pin 必须保持（脚本抬脚不能被自家状态机判成释放）。
        if (!snapshot.leftPinned || !snapshot.rightPinned) contactLost = true
        if ((snapshot.leftWeight ?? 0) < 0.99 || (snapshot.rightWeight ?? 0) < 0.99) {
          contactLost = true
        }
        maxHipShiftWhileStepping = Math.max(
          maxHipShiftWhileStepping,
          Math.hypot(snapshot.hipShiftXM ?? 0, snapshot.hipShiftZM ?? 0)
        )
      }
    }
    // 同步换步双脚同时离地时，抬脚高度不超过 liftMax（0.03m），避免蹦跳感。
    expect(maxBothAirborneLift).toBeLessThanOrEqual(0.03)
    expect(contactLost).toBe(false)
    expect(maxLift).toBeGreaterThan(0.01)
    expect(maxTargetErr).toBeGreaterThan(0.1)
    // g 在 fade 期间可能已被钳到 0.10m（本夹具是整骨架平移，距离约束不可行 → fallback 均值）；
    // replant 只要求把它按进度衰减、不越界，settle 后回到 ~0（下面稳态断言）。
    expect(maxHipShiftWhileStepping).toBeLessThanOrEqual(0.1001)

    // 全部落地：两脚都到达新作者站姿（残差 <2mm），且明显离开了旧锚点（≈15cm）。
    const afterLeft = footLocal(rig.scene, rig.leftFoot).clone()
    const afterRight = footLocal(rig.scene, rig.rightFoot).clone()
    expect(afterLeft.distanceTo(anchorLeft)).toBeGreaterThan(0.12)
    expect(afterRight.distanceTo(anchorRight)).toBeGreaterThan(0.12)
    const targetLeft = afterLeft
    const targetRight = afterRight
    runReplantFrames(lock, rig, 'B', offsetX, dropY, 1)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(targetLeft)).toBeLessThan(0.002)
    expect(footLocal(rig.scene, rig.rightFoot).distanceTo(targetRight)).toBeLessThan(0.002)

    // 稳态：脚不漂、contact 不释放、g 的 hipShift 回到 ~0、膝角接近作者。
    const authorFootL = footLocal(rig.scene, rig.leftFoot).clone()
    const authorFootR = footLocal(rig.scene, rig.rightFoot).clone()
    const steady = runReplantFrames(lock, rig, 'B', offsetX, dropY, 45)
    for (const frame of steady.slice(10)) {
      expect(frame.snapshot.leftPinned).toBe(true)
      expect(frame.snapshot.rightPinned).toBe(true)
      expect(frame.left.distanceTo(authorFootL)).toBeLessThan(0.002)
      expect(frame.right.distanceTo(authorFootR)).toBeLessThan(0.002)
      expect(Math.hypot(frame.snapshot.hipShiftXM ?? 0, frame.snapshot.hipShiftZM ?? 0)).toBeLessThan(0.005)
      expect(frame.snapshot.leftFootErrorM ?? 1).toBeLessThan(0.002)
      expect(frame.snapshot.rightFootErrorM ?? 1).toBeLessThan(0.002)
      assertFiniteSnapshot(frame.snapshot)
    }
    const last = steady[steady.length - 1]!
    const kneeDevL = Math.abs((last.snapshot.kneeFlexDegL ?? 0) - (last.snapshot.authorKneeFlexDegL ?? 0))
    const kneeDevR = Math.abs((last.snapshot.kneeFlexDegR ?? 0) - (last.snapshot.authorKneeFlexDegR ?? 0))
    expect(kneeDevL).toBeLessThan(1)
    expect(kneeDevR).toBeLessThan(1)
  })

  it('小站姿差（8mm < replantMinMoveM）：走迷你混合——不抬脚、平滑到位、无瞬移', () => {
    const offsetX = 0.008
    const dropY = 0.004
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)
    const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
    const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()
    fadeAtoB(lock, rig, offsetX, dropY)

    const frames = runReplantFrames(lock, rig, 'B', offsetX, dropY, 30)
    const active = frames.filter((f) => f.snapshot.replantActive)
    expect(active.length).toBeGreaterThan(3)
    let maxLift = 0
    let maxFrameStep = 0
    for (let index = 1; index < frames.length; index += 1) {
      const frame = frames[index]!
      maxLift = Math.max(
        maxLift,
        frame.snapshot.leftReplantLiftM ?? 0,
        frame.snapshot.rightReplantLiftM ?? 0
      )
      maxFrameStep = Math.max(
        maxFrameStep,
        frame.left.distanceTo(frames[index - 1]!.left),
        frame.right.distanceTo(frames[index - 1]!.right)
      )
      assertFiniteSnapshot(frame.snapshot)
    }
    // 迷你混合：弧线高度恒 0；8mm 在 0.15s 内 smoothstep 搬完，单帧远小于 6mm。
    expect(maxLift).toBe(0)
    expect(maxFrameStep).toBeLessThan(0.006)
    // 平滑到位（不瞬移；首帧位移 ≈ α×8mm）。
    expect(anchorLeft.distanceTo(frames[0]!.left)).toBeLessThan(0.003)
    const after = footLocal(rig.scene, rig.leftFoot).clone()
    expect(after.distanceTo(anchorLeft)).toBeGreaterThan(0.006)
    expect(after.distanceTo(anchorLeft)).toBeLessThan(0.012)
    expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.012)
  })

  it('重踏中再次换 clip：从当前脚位重新起弧到最新目标（无跳变、无 NaN）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)
    fadeAtoB(lock, rig, 0.15, 0.015)
    // 走 8 帧（第一只脚已抬起/移动中）。
    const first = runReplantFrames(lock, rig, 'B', 0.15, 0.015, 8)
    expect(first[first.length - 1]!.snapshot.replantActive).toBe(true)
    const interruptedLeft = first[first.length - 1]!.left.clone()
    const interruptedRight = first[first.length - 1]!.right.clone()

    // clipId B→C：C 站姿 = 从 B 再平移 0.05m / 下沉 0.005m（总 20cm，仍在真实站姿差量级）。
    const cOffsetX = 0.2
    const cDropY = 0.02
    // 先进入 C 的 crossfade（3 帧）；首帧检测到再次变化 → finishReplantNow + pending，脚停在当前插值位。
    const fade = runReplantFrames(lock, rig, 'C', cOffsetX, cDropY, 3, true)
    for (const frame of fade) {
      assertFiniteSnapshot(frame.snapshot)
      expect(frame.snapshot.replantActive).toBe(false)
      expect(frame.snapshot.replantPending).toBe(true)
    }
    // R3：打断时空中脚立即落地（finishReplantNow 去掉 lift 分量），水平位置仍冻结在打断位，
    // 不出现水平瞬移/跳回旧锚点（旧锚点距此 >10cm）。
    const lastFade = fade[fade.length - 1]!
    expect(
      Math.hypot(lastFade.left.x - interruptedLeft.x, lastFade.left.z - interruptedLeft.z)
    ).toBeLessThan(0.01)
    expect(
      Math.hypot(lastFade.right.x - interruptedRight.x, lastFade.right.z - interruptedRight.z)
    ).toBeLessThan(0.01)
    // 脚已落地：当前 replant lift 归零（垂直差 = 打断时的 liftNow，已被 finish 去掉）。
    expect(lastFade.snapshot.leftReplantLiftM ?? 0).toBe(0)
    expect(lastFade.snapshot.rightReplantLiftM ?? 0).toBe(0)

    // fade 结束后重新规划：目标更新为 C，从当前脚位起弧。
    const replan = runReplantFrames(lock, rig, 'C', cOffsetX, cDropY, 50)
    let maxFrameStep = 0
    let nan = false
    for (let index = 1; index < replan.length; index += 1) {
      maxFrameStep = Math.max(
        maxFrameStep,
        replan[index]!.left.distanceTo(replan[index - 1]!.left),
        replan[index]!.right.distanceTo(replan[index - 1]!.right)
      )
      const snapshot = replan[index]!.snapshot
      assertFiniteSnapshot(snapshot)
      if (replan[index]!.left.x !== replan[index]!.left.x) nan = true
    }
    expect(nan).toBe(false)
    expect(maxFrameStep).toBeLessThan(0.035)
    // 最终落到 C 作者站姿（>0.1m 的新目标；残差 <2mm）。
    const steady = runReplantFrames(lock, rig, 'C', cOffsetX, cDropY, 45)
    const authorLeft = footLocal(rig.scene, rig.leftFoot).clone()
    const authorRight = footLocal(rig.scene, rig.rightFoot).clone()
    for (const frame of steady.slice(10)) {
      expect(frame.left.distanceTo(authorLeft)).toBeLessThan(0.002)
      expect(frame.right.distanceTo(authorRight)).toBeLessThan(0.002)
      expect(Math.hypot(frame.snapshot.hipShiftXM ?? 0, frame.snapshot.hipShiftZM ?? 0)).toBeLessThan(0.005)
    }
  })

  it('ineligible（mood=walk）+ clipId 变化：不触发重踏，走原释放路径（pinned=false）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)
    for (let index = 0; index < 30; index += 1) {
      authoredPose(rig, 0.15, 0.015)
      lock.update(makeInput({ dt: REPLANT_DT, mood: 'walk' }), { clipId: 'B' })
      const snapshot = lock.getSnapshot()
      expect(snapshot.replantActive).toBe(false)
      expect(snapshot.replantPending).toBe(false)
      expect(snapshot.leftReplantActive).toBe(false)
      expect(snapshot.rightReplantActive).toBe(false)
    }
    const snapshot = lock.getSnapshot()
    expect(snapshot.leftPinned).toBe(false)
    expect(snapshot.rightPinned).toBe(false)
    expect(snapshot.leftWeight).toBeLessThan(0.05)
  })

  it('poseReplant:false / stanceAlignMode:mean：不触发重踏，保持旧锚点（A/B 回滚通道）', () => {
    for (const options of [
      { poseReplant: false as const },
      { stanceAlignMode: 'mean' as const }
    ]) {
      const rig = makeRig()
      const lock = new VrmFootLock(makeAvatar(rig), options)
      lockWithClipA(lock, rig)
      const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
      const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()
      fadeAtoB(lock, rig, 0.15, 0.015, false)
      const frames = runReplantFrames(lock, rig, 'B', 0.15, 0.015, 45)
      for (const frame of frames) {
        expect(frame.snapshot.replantActive).toBe(false)
        expect(frame.snapshot.replantPending).toBe(false)
        expect(frame.snapshot.leftReplantActive).toBe(false)
        expect(frame.snapshot.rightReplantActive).toBe(false)
      }
      // 旧行为：脚仍钉在旧锚点（不追新作者站姿）。
      expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.03)
      expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.03)
      expect(lock.getSnapshot().leftPinned).toBe(true)
      expect(lock.getSnapshot().rightPinned).toBe(true)
    }
  })

  it('不传 clipId：跨 clip 站姿变化保持旧锚点（旧行为兼容）', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    settle(lock, rig, 40)
    const anchorLeft = footLocal(rig.scene, rig.leftFoot).clone()
    const anchorRight = footLocal(rig.scene, rig.rightFoot).clone()
    // 模拟真实 crossfade：20 帧内作者姿态缓慢从 A 移到 B（不传 clipId / transitioning）。
    for (let index = 1; index <= 20; index += 1) {
      const p = index / 20
      authoredPose(rig, 0.15 * p, 0.015 * p)
      lock.update(makeInput({ dt: REPLANT_DT }))
    }
    for (let index = 0; index < 40; index += 1) {
      authoredPose(rig, 0.15, 0.015)
      lock.update(makeInput({ dt: REPLANT_DT }))
    }
    expect(lock.getSnapshot().replantActive).toBe(false)
    expect(lock.getSnapshot().replantPending).toBe(false)
    expect(footLocal(rig.scene, rig.leftFoot).distanceTo(anchorLeft)).toBeLessThan(0.03)
    expect(footLocal(rig.scene, rig.rightFoot).distanceTo(anchorRight)).toBeLessThan(0.03)
  })

  it('反向站姿差（一脚外展、一脚内收）：换步中间帧站姿宽不超出目标宽 +3cm，不出现超宽畸形', () => {
    // 作者站姿：左脚外移 6cm、右脚内收 4cm，骨盆右移 3cm 配合（保证两脚 IK 可达，复刻真实
    // adv-idle→hsr-idle 这类反向大站姿差；现网实测错峰中间帧宽被拉到 42cm vs 作者 31cm）。
    const leftDx = 0.06
    // 右脚内收：世界 x 增大（从负侧向中心靠近），故 rightDx 为正。
    const rightDx = 0.04
    const hipsDx = 0.03
    const splitPose = (p: number): void => {
      resetPose(rig)
      rig.hips.position.x += hipsDx * p
      // foot 节点 position 用绝对设置（resetPose 不复位 position，避免逐帧累加）。
      rig.nodes.leftFoot.position.set(
        REST.footFromLower[0] + leftDx * p,
        REST.footFromLower[1],
        REST.footFromLower[2]
      )
      rig.nodes.rightFoot.position.set(
        -REST.footFromLower[0] + rightDx * p,
        REST.footFromLower[1],
        REST.footFromLower[2]
      )
    }
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)

    // crossfade（20 帧）：作者姿态从 rest 插值到反向站姿，clipId 变化 → pending。
    const fadeFrames = 20
    for (let index = 1; index <= fadeFrames; index += 1) {
      splitPose(index / fadeFrames)
      lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'B', transitioning: true })
    }
    expect(lock.getSnapshot().replantPending).toBe(true)

    // fade 结束后推进重踏，逐帧记录站姿宽（左右脚 scene 局部 x 差）。
    const startWidth = 0.184
    let maxWidth = startWidth
    for (let index = 0; index < 45; index += 1) {
      splitPose(1)
      lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'B' })
      const snapshot = lock.getSnapshot()
      assertFiniteSnapshot(snapshot)
      const l = footLocal(rig.scene, rig.leftFoot)
      const r = footLocal(rig.scene, rig.rightFoot)
      maxWidth = Math.max(maxWidth, l.x - r.x)
    }
    // 目标作者站姿宽 = (0.092+0.06) − (−0.092+0.04) = 0.152 − (−0.052) = 0.204。
    const targetWidth = 0.204
    // 同步换步：宽度在起止之间，峰值 ≈ 目标宽；旧错峰（先动脚到目标、后动脚留旧位）峰值 0.284。
    expect(maxWidth).toBeLessThanOrEqual(targetWidth + 0.03)
  })

  it('R3 快速连续切换：每次打断空中脚落地，停止切换后 1s 内收敛且不再抽搐、不超宽', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)

    // 三次快速切换（B/C/D，目标站姿 offset 不同）；每次只给 3 帧 fade + 5 帧 replant，
    // replant 来不及完成就被下一次切换打断（复刻现网每 0.6s 切换、replant 0 完成的场景）。
    const targets = [
      { id: 'B', x: 0.15, y: 0.015 },
      { id: 'C', x: 0.05, y: 0.005 },
      { id: 'D', x: 0.2, y: 0.02 }
    ]
    let maxWidth = 0
    // kneeFlexDeg 是屈曲角（0=腿直、越大越弯）；记录最大屈曲以检测异常弯曲。
    let maxFlex = 0
    for (const target of targets) {
      const fade = runReplantFrames(lock, rig, target.id, target.x, target.y, 3, true)
      for (const f of fade) {
        expect(f.snapshot.replantActive).toBe(false)
        expect(f.snapshot.replantPending).toBe(true)
      }
      const partial = runReplantFrames(lock, rig, target.id, target.x, target.y, 5)
      for (const f of [...fade, ...partial]) {
        const w = f.left.x - f.right.x
        maxWidth = Math.max(maxWidth, w)
        maxFlex = Math.max(maxFlex, f.snapshot.kneeFlexDegL ?? 0, f.snapshot.kneeFlexDegR ?? 0)
        assertFiniteSnapshot(f.snapshot)
      }
    }

    // 停止切换：保持最后 clip（D）40 帧，测量首次进入稳态的帧偏移。
    let convergeOffset: number | null = null
    for (let i = 0; i < 40; i += 1) {
      authoredPose(rig, 0.2, 0.02)
      lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'D' })
      const snapshot = lock.getSnapshot()
      assertFiniteSnapshot(snapshot)
      maxWidth = Math.max(maxWidth, footLocal(rig.scene, rig.leftFoot).x - footLocal(rig.scene, rig.rightFoot).x)
      maxFlex = Math.max(maxFlex, snapshot.kneeFlexDegL ?? 0, snapshot.kneeFlexDegR ?? 0)
      if (convergeOffset === null && !snapshot.replantActive && !snapshot.replantPending) {
        convergeOffset = i
      }
    }
    // 末段 15 帧必须保持稳态（不再抽搐）。
    let tailUnstable = 0
    for (let i = 0; i < 15; i += 1) {
      authoredPose(rig, 0.2, 0.02)
      lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'D' })
      const snapshot = lock.getSnapshot()
      if (snapshot.replantActive || snapshot.replantPending) tailUnstable += 1
    }

    expect(convergeOffset).not.toBeNull()
    expect(convergeOffset!).toBeLessThanOrEqual(30) // 停止切换后 1s 内进入稳态
    expect(tailUnstable).toBe(0)
    expect(maxWidth).toBeLessThan(0.34) // 全程不超宽（<34cm）
    expect(maxFlex).toBeLessThan(50) // 最大屈曲 <50°，无异常弯曲腿
  })

  it('reset() 清空重踏状态：重踏中 reset 后不再 pending/active、无 NaN', () => {
    const rig = makeRig()
    const lock = new VrmFootLock(makeAvatar(rig))
    lockWithClipA(lock, rig)
    fadeAtoB(lock, rig, 0.15, 0.015)
    const frames = runReplantFrames(lock, rig, 'B', 0.15, 0.015, 8)
    expect(frames[frames.length - 1]!.snapshot.replantActive).toBe(true)
    lock.reset()
    const snapshot = lock.getSnapshot()
    expect(snapshot.replantPending).toBe(false)
    expect(snapshot.replantActive).toBe(false)
    expect(snapshot.leftReplantActive).toBe(false)
    expect(snapshot.rightReplantActive).toBe(false)
    expect(snapshot.leftReplantLiftM).toBeNull()
    expect(snapshot.rightReplantLiftM).toBeNull()
    // reset 后 lastClipId=null：同一 clipId 不会立刻触发重踏。
    authoredPose(rig, 0.15, 0.015)
    lock.update(makeInput({ dt: REPLANT_DT }), { clipId: 'B' })
    expect(lock.getSnapshot().replantPending).toBe(false)
    expect(lock.getSnapshot().replantActive).toBe(false)
    assertFiniteSnapshot(lock.getSnapshot())
  })
})
