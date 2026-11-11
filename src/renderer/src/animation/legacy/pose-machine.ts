/**
 * 姿态过渡状态机（smoothstep + slerp 短弧；**纯函数**，时间显式传入，不依赖 rAF/three）。
 *
 * 用法：
 * ```ts
 * const machine = new PoseMachine()
 * machine.setTarget('walk', poseQuats, nowSec)   // 目标 id 变化 → from = 当前输出，progress = 0
 * const current = machine.update(dt, 'walk', poseQuats)
 * ```
 *
 * 设计要点（`docs/anim-tech-survey.md` §3.4）：
 * - `from` 是**上一帧输出**而不是某个静态姿态 → 任意时刻打断都从当前视觉状态开始（可打断性）；
 * - 同一目标 id 持续更新（走路程序化姿态每帧都在变）时不重置进度，只更新 `to`；
 * - 进度 `t` 走 `smoothstep`，默认 0.25s。
 */
import { blendPoseMaps, blendPoseMapsStaggered } from './blend'
import { smoothstep } from './quat'
import { DEFAULT_POSE_FADE_SEC, type PoseQuats } from './types'

/** 姿态过渡的逐骨延迟（秒；v2 生动性：不同骨错峰到达）。 */
export type PoseStagger = (bone: string) => number

export class PoseMachine {
  private readonly stagger?: PoseStagger
  private from: PoseQuats = new Map()
  private to: PoseQuats = new Map()
  private targetId = ''
  private elapsed = 0
  private duration = DEFAULT_POSE_FADE_SEC
  private current: PoseQuats = new Map()

  constructor(options: { stagger?: PoseStagger } = {}) {
    this.stagger = options.stagger
  }

  /** 当前目标姿态 id。 */
  get poseId(): string {
    return this.targetId
  }

  /** 过渡进度（0..1；1 = 已完全到达目标）。 */
  get progress(): number {
    if (this.duration <= 0) return 1
    return Math.min(1, this.elapsed / this.duration)
  }

  /** 目标 id 是否变化（用于调试 / activeLayers 统计）。 */
  get transitioning(): boolean {
    return this.progress < 1
  }

  /** 当前输出（拷贝引用，不可修改内部状态）。 */
  get currentPose(): PoseQuats {
    return this.current
  }

  /**
   * 设置目标姿态。
   * @param id 目标姿态 id（只用于判断「是否换姿态」）
   * @param target 目标姿态（每帧都可传入新计算的值）
   * @param durationSec 过渡时长（秒；<=0 表示瞬间切换）
   * @param force 强制重头开始过渡（例如 setPose 调试强制切换）
   */
  setTarget(id: string, target: PoseQuats, durationSec = DEFAULT_POSE_FADE_SEC, force = false): void {
    const changed = id !== this.targetId || force
    if (changed) {
      // 打断：从**当前输出**开始，保证视觉连续。
      this.from = clonePose(this.current)
      this.elapsed = 0
    }
    this.targetId = id
    this.to = target
    this.duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  }

  /**
   * 推进一帧并返回当前姿态（复用同 Map，不要持有）。
   * @param dt 秒（调用方负责钳制 ≤0.1）
   */
  update(dt: number, id: string, target: PoseQuats): PoseQuats {
    if (id !== this.targetId) {
      this.setTarget(id, target, this.duration)
    } else {
      this.to = target
    }
    if (this.duration <= 0) {
      this.elapsed = 0
      this.current = this.to
      return this.current
    }
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt))
    const t = smoothstep(this.elapsed / this.duration)
    this.current = this.stagger
      ? blendPoseMapsStaggered(this.from, this.to, this.elapsed, this.duration, this.stagger)
      : blendPoseMaps(this.from, this.to, t)
    if (this.elapsed >= this.duration) {
      // 到达后直接引用目标（省一次 20 骨混合）。
      this.current = this.to
    }
    return this.current
  }

  /** 重置（场景重建/模型重载时用）。 */
  reset(): void {
    this.from = new Map()
    this.to = new Map()
    this.current = new Map()
    this.targetId = ''
    this.elapsed = 0
    this.duration = DEFAULT_POSE_FADE_SEC
  }
}

/** 深拷贝姿态 Map（from 快照必须与内部输出隔离）。 */
export function clonePose(pose: PoseQuats): PoseQuats {
  const copy = new Map<string, import('./types').Quat>()
  for (const [name, q] of pose) copy.set(name, { x: q.x, y: q.y, z: q.z, w: q.w })
  return copy
}
