/**
 * 发辫/碎发 verlet 弹簧（角速度弹簧；纯函数，**不 import three**）。
 *
 * 方案（`docs/anim-tech-survey.md` §6.2）：
 * - **不引入 ammo.js/MMDPhysics**：7 根发骨（4 主辫 + 1 副辫 + 1 碎发参与积分，`辮子1-1` 是挂点）；
 * - 固定子步 1/120s，每帧最多 4 步（30fps 下 4 步 ≈ 33ms，覆盖整帧）；
 * - **不写 bone.position**：只把「当前偏移四元数」写回 post-rotation，长度守恒由骨骼层级保证；
 * - 不写 `modelRoot`、不做碰撞（Wave 2；截图验证后若穿模再加头部球体）。
 *
 * 模型：每个关节维护**局部偏移四元数 q**（相对 rest）与角速度 ω（父骨局部系）：
 *   - 刚度：`−k · rotVec(q)` 回拉 rest；
 *   - 阻尼/惯性：`c · (ω_parent − ω)`，让头/身体运动把辫子「甩」起来；
 *   - 重力：`cross(q·restDir, gravityLocal) · g`，让辫子自然下垂；
 *   - 显式积分 + 最大角速度钳制，保证「dt=0.1 不爆炸」。
 */
import {
  clamp,
  crossVec3,
  conjugateQuat,
  multiplyQuat,
  normalizeQuat,
  quatToRotationVector,
  rotationVectorToQuat,
  rotateVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3
} from './quat'
import type { Quat, Vec3 } from './types'

/** 一根弹簧关节的静态配置。 */
export interface SpringJointConfig {
  bone: string
  /** rest 方向（模型空间单位向量；父骨局部 = 世界 rest）。 */
  restDir: Vec3
}

/** 一条弹簧链的配置。 */
export interface SpringChainConfig {
  id: string
  /** 链根父骨名（用于获取世界旋转；由骨架数据决定）。 */
  rootParent: string
  joints: readonly SpringJointConfig[]
  /** 刚度（1/s²；越大越快回 rest）。 */
  stiffness: number
  /** 阻尼（1/s；临界阻尼 ≈ 2√k）。 */
  damping: number
  /** 重力扭矩增益（rad/s²）。 */
  gravity: number
  /** 惯性耦合（0..1；父骨角速度传给关节的比例，越大越「甩」）。 */
  inertia: number
  /** 角速度上限（rad/s），防数值爆炸。 */
  maxAngularSpeed: number
}

/** 一个关节的运行状态。 */
export interface SpringJointState {
  /** 局部偏移四元数（相对 rest；写回骨骼的就是它）。 */
  rotation: Quat
  /** 角速度（父骨局部系）。 */
  angularVelocity: Vec3
}

/** 一条链的运行状态。 */
export interface SpringChainState {
  id: string
  joints: SpringJointState[]
}

/** 弹簧默认参数（发辫：偏软、阻尼中等；three-vrm 参数语义的简化版）。 */
export const DEFAULT_SPRING_PARAMS = {
  // v2：更软/响应更快（用户要「头发衣摆动起来」；v1 太稳看不出动）
  stiffness: 12,
  damping: 5.2,
  gravity: 2.8,
  inertia: 0.75,
  maxAngularSpeed: 30
} as const

/** 袖子弹簧参数：比发辫硬一些、重力小一些（布料贴身摆动，不能乱飞）。 */
export const SLEEVE_SPRING_PARAMS = {
  stiffness: 22,
  damping: 6.5,
  gravity: 1.6,
  inertia: 0.9,
  maxAngularSpeed: 26
} as const

/** 固定子步（秒）。 */
export const SPRING_FIXED_STEP_SEC = 1 / 120
/** 每帧最多子步数。 */
export const SPRING_MAX_STEPS = 4

/** 世界重力方向（模型空间；y 向上）。 */
const GRAVITY_DIR: Vec3 = { x: 0, y: -1, z: 0 }

/** 由配置新建运行状态（全部从 rest 开始）。 */
export function createSpringChainState(config: SpringChainConfig): SpringChainState {
  return {
    id: config.id,
    joints: config.joints.map(() => ({
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      angularVelocity: { x: 0, y: 0, z: 0 }
    }))
  }
}

/** 每帧弹簧更新输入（父世界旋转由管线从当前姿态累积得到）。 */
export interface SpringStepInput {
  /** 本帧 dt（秒；调用方已钳制 ≤0.1）。 */
  dt: number
  /** 链根父骨的**世界**四元数（首关节的父骨，例如 頭）。 */
  rootParentWorld: Quat
  /** 链根父骨的**世界**角速度（rad/s；由头/躯干姿态差分估计）。 */
  rootParentAngularVelocity: Vec3
}

/** 弹簧更新输出。 */
export interface SpringStepResult {
  state: SpringChainState
  /** 各关节最终世界四元数（世界 = 父世界 × 局部偏移；调试/下一链父用）。 */
  worldQuats: Quat[]
  /** 各关节写回骨骼的局部偏移四元数。 */
  localQuats: Quat[]
}

/**
 * 推进一条弹簧链（内部固定子步；dt 超过 4 步时只积分前 4 步，剩余时间丢弃 = 慢动作不爆炸）。
 */
export function stepSpringChain(
  chain: SpringChainState,
  config: SpringChainConfig,
  input: SpringStepInput
): SpringStepResult {
  const jointCount = Math.min(chain.joints.length, config.joints.length)
  const states: SpringJointState[] = chain.joints.map((joint) => ({
    rotation: { ...joint.rotation },
    angularVelocity: { ...joint.angularVelocity }
  }))

  const totalDt = clamp(input.dt, 0, SPRING_MAX_STEPS * SPRING_FIXED_STEP_SEC)
  let remaining = totalDt
  while (remaining > 1e-9) {
    const step = Math.min(SPRING_FIXED_STEP_SEC, remaining)
    remaining -= step

    let parentWorld = normalizeQuat(input.rootParentWorld)
    let parentOmegaWorld: Vec3 = { ...input.rootParentAngularVelocity }
    for (let index = 0; index < jointCount; index += 1) {
      const state = states[index]!
      const jointConfig = config.joints[index]!
      // 父角速度封顶：链式累加不能无限放大（否则末端袖子/发辫会被「甩飞」）。
      const parentOmegaSpeed = lengthVec3(parentOmegaWorld)
      if (parentOmegaSpeed > config.maxAngularSpeed) {
        parentOmegaWorld = scaleVec3(parentOmegaWorld, config.maxAngularSpeed / parentOmegaSpeed)
      }
      const parentInv = conjugateQuat(parentWorld)
      const omegaLocal = rotateVec3(parentInv, parentOmegaWorld)
      const gravityLocal = rotateVec3(parentInv, GRAVITY_DIR)
      const currentDir = rotateVec3(state.rotation, jointConfig.restDir)

      // 刚度回拉（父骨局部系里的旋转向量）。
      const rotVec = quatToRotationVector(state.rotation)
      const stiffnessTorque = scaleVec3(rotVec, -config.stiffness)
      // 重力：把当前方向往世界下方拧。
      const gravityTorque = scaleVec3(crossVec3(currentDir, gravityLocal), config.gravity)
      // 阻尼 + 惯性：父骨角速度按 inertia 比例传递（头/身体一转身，辫子/袖子被甩起来）。
      const inertia = clamp(config.inertia ?? 0.75, 0, 1)
      const dampTorque = scaleVec3(
        {
          x: omegaLocal.x * inertia - state.angularVelocity.x,
          y: omegaLocal.y * inertia - state.angularVelocity.y,
          z: omegaLocal.z * inertia - state.angularVelocity.z
        },
        config.damping
      )

      let omega = {
        x: state.angularVelocity.x +
          (stiffnessTorque.x + gravityTorque.x + dampTorque.x) * step,
        y: state.angularVelocity.y +
          (stiffnessTorque.y + gravityTorque.y + dampTorque.y) * step,
        z: state.angularVelocity.z +
          (stiffnessTorque.z + gravityTorque.z + dampTorque.z) * step
      }
      const speed = lengthVec3(omega)
      if (speed > config.maxAngularSpeed) {
        omega = scaleVec3(omega, config.maxAngularSpeed / speed)
      }
      // 半隐式欧拉：先更新角速度，再在父骨局部系里叠加旋转增量。
      const delta = rotationVectorToQuat(scaleVec3(omega, step))
      state.angularVelocity = omega
      state.rotation = normalizeQuat(multiplyQuat(delta, state.rotation))

      parentWorld = normalizeQuat(multiplyQuat(parentWorld, state.rotation))
      // 子链父角速度 ≈ 父角速度 + 自身角速度（世界系近似）。
      const ownOmegaWorld = rotateVec3(parentWorld, omega)
      parentOmegaWorld = {
        x: parentOmegaWorld.x + ownOmegaWorld.x,
        y: parentOmegaWorld.y + ownOmegaWorld.y,
        z: parentOmegaWorld.z + ownOmegaWorld.z
      }
      const accumulated = lengthVec3(parentOmegaWorld)
      const cap = config.maxAngularSpeed * 0.8
      if (accumulated > cap) {
        parentOmegaWorld = scaleVec3(parentOmegaWorld, cap / accumulated)
      }
    }
  }

  // 组装世界/局部四元数（世界 = 链根父 × 各关节偏移累积）。
  const localQuats = states.map((state) => state.rotation)
  const worldQuats: Quat[] = []
  let world = normalizeQuat(input.rootParentWorld)
  for (const state of states) {
    world = normalizeQuat(multiplyQuat(world, state.rotation))
    worldQuats.push(world)
  }
  return {
    state: { id: chain.id, joints: states },
    worldQuats,
    localQuats
  }
}

/**
 * 由 rest 位置推导每个关节的 rest 方向（模型空间）。
 *
 * @param jointNames 关节骨名（从根到尖）
 * @param restPositions 骨名 → rest 模型空间位置
 * @param parentName 首关节父骨名（用于单关节链 / 尖端方向回退）
 */
export function computeRestDirections(
  jointNames: readonly string[],
  restPositions: Readonly<Record<string, Vec3>>,
  parentName: string
): Vec3[] {
  const dirs: Vec3[] = []
  for (let index = 0; index < jointNames.length; index += 1) {
    const name = jointNames[index]!
    const position = restPositions[name]
    const nextName = jointNames[index + 1]
    const nextPosition = nextName ? restPositions[nextName] : undefined
    // 段方向 = 当前关节 → 下一个关节；末端骨没有子骨时用「上一关节 → 本节」的延续方向。
    const target = nextPosition ?? undefined
    const from =
      index > 0
        ? restPositions[jointNames[index - 1]!]
        : restPositions[parentName]
    let dir: Vec3 = { x: 0, y: -1, z: 0 }
    if (target && position) {
      dir = normalizeVec3({
        x: target.x - position.x,
        y: target.y - position.y,
        z: target.z - position.z
      })
    } else if (position && from) {
      dir = normalizeVec3({
        x: position.x - from.x,
        y: position.y - from.y,
        z: position.z - from.z
      })
    }
    if (lengthVec3(dir) < 1e-6) dir = { x: 0, y: -1, z: 0 }
    dirs.push(dir)
  }
  return dirs
}
