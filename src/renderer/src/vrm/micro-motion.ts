/**
 * VRM 待机程序化微动层（2026-11-10 用户实机反馈：「待机看起来脚被固定、腰也不动」）。
 *
 * ## 背景（为什么需要这一层）
 * - 源动作数据本身极静：HSR `StandBy` 的 Root_M 旋转范围 0.00°、位移 0mm；adv `StandBy` 的
 *   Biped Pelvis 旋转 0.52°、位移 ~3mm。即「官方 idle 本来就没有腰/骨盆动画」——不是 retarget 丢的。
 * - 旧 PMX 后端有程序化微动层（`animation/legacy/micro-motion.ts`：呼吸/重心摆动/头漂移，
 *   单骨 3–6°、周期 3–6s、多频率不可通约叠加、8–15s 换承重脚），VRM 后端没有搬过来。
 * - 脚部固定（`foot-lock.ts`）只改大腿/小腿旋转（不做腰锁），但数据静止 + 双脚钉死会放大「僵」的观感。
 *
 * ## 本层做什么
 * 在 clip-player 写完 normalized 骨之后、foot-lock IK 之前，叠加一层**小幅、多频率、不可通约**的
 * 加性旋转/位移：
 * - 呼吸（胸/颈/头轻微起伏，~0.23Hz）；
 * - 重心左右转移（骨盆 roll/yaw + 躯干反向补偿，~0.11Hz）与慢层承重脚（~0.075Hz，约 13s 周期）；
 * - 极慢头部漂移（0.043/0.06Hz）；
 * - 骨盆横向/竖向微位移（默认峰值 ±1.2cm / ±3mm；foot-lock 的 IK 会把脚拉回锚点，因此脚不滑）。
 *
 * ## 约束
 * - 只对「基础选片 = idle」启用（`animator` 里判断 `slot === mood === 'idle'`）；walk/sit/sleep/拖拽/
 *   一次性动作不启用，权重平滑淡出，避免和已验收动作打架。
 * - 纯加性：每帧 clip-player 会把骨重写为绝对姿态，本层在其后 `multiply(delta)`，不累积。
 * - 幅度/频率全部集中在本文件常量 + 构造选项里，实机观感可调；`scale: 0` 可整体关闭。
 * - 本层不写 `avatar.scene`（摆放/朝向归场景层），只改 normalized 骨。
 */
import { Euler, Quaternion, type Object3D } from 'three'

import type { HumanoidBone } from '@shared/vrm'

import type { VrmAvatar } from './runtime-types'

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const TAU = Math.PI * 2
/** 呼吸频率（Hz；周期 ≈4.3s）。 */
const FREQ_BREATH = 0.23
/** 重心快层摆动频率（Hz；周期 ≈9.1s）。 */
const FREQ_SWAY = 0.11
/** 承重脚慢层频率（Hz；周期 ≈13.3s）。 */
const FREQ_WEIGHT = 0.075
/** 极慢头部漂移频率（Hz；周期 ≈23s）。 */
const FREQ_DRIFT = 0.043
/** 第二组头部漂移频率（Hz；与 0.043 不可通约，避免循环感）。 */
const FREQ_DRIFT2 = 0.06

/** 单帧 dt 上限（与 clip-player/B3 同口径）。 */
const MAX_DELTA_SEC = 0.1

/** 默认幅度（度 / 米；scale=1 时）。 */
export const VRM_MICRO_MOTION_DEFAULTS = Object.freeze({
  /** 呼吸：胸/脊 pitch 幅度（度；业界 1.2–1.5°）。 */
  breathDeg: 1.5,
  /** 重心快层：骨盆 roll/yaw 基准幅度（度；roll ±2° / yaw ±1.2°）。 */
  swayDeg: 2.0,
  /** 承重脚慢层：骨盆 roll 幅度（度，叠加在 sway 上）。 */
  weightShiftDeg: 2.0,
  /** 头/颈跟随 + 极慢漂移幅度（度；业界 2–2.5°）。 */
  headDeg: 2.4,
  /** 骨盆横向位移峰值（米；research 实测 1.5cm sway 脚漂移 0mm）。 */
  hipsLateralM: 0.015,
  /** 骨盆竖向位移峰值（米）。 */
  hipsVerticalM: 0.003,
  /**
   * 软膝基准下沉（米）：站立时髋→踝 0.8801m vs 腿长 0.8814m，膝部余量仅 1.3mm，
   * 不主动下沉的话腿像直杆、摇摆看起来仍僵。research 探针：下沉 0.8cm 后膝弯 7.7→15.6°，
   * foot-lock 额外下沉仅 1.1mm、脚漂移 0mm。
   */
  softKneeDropM: 0.008,
  /** 启用时权重淡入时间常数（秒）。 */
  weightTauInSec: 0.6,
  /** 停用时权重淡出时间常数（秒）。 */
  weightTauOutSec: 0.35
})

/** 欧拉增量（度；XYZ 顺序）。 */
export interface VrmMicroMotionEuler {
  x: number
  y: number
  z: number
}

/** 某一时刻的微动姿势增量（纯函数输出；不依赖 three）。 */
export interface VrmMicroMotionPose {
  hipsRotation: VrmMicroMotionEuler
  spineRotation: VrmMicroMotionEuler
  chestRotation: VrmMicroMotionEuler
  neckRotation: VrmMicroMotionEuler
  headRotation: VrmMicroMotionEuler
  /** 骨盆位移增量（米；模型局部空间）。 */
  hipsOffset: { x: number; y: number; z: number }
}

/** 构造选项（全部可选；非法值安全回退默认）。 */
export interface VrmMicroMotionOptions {
  /** false = 完全不启用（默认 true）。 */
  enabled?: boolean
  /** 整体幅度缩放（0..2；默认 1；0 = 关闭但仍记录权重）。 */
  scale?: number
  /** 是否施加骨盆位移（默认 true；foot-lock 不存在时应整层禁用以免脚滑）。 */
  applyHipsOffset?: boolean
  /** 软膝基准下沉（米；默认 0.008；0 = 关闭软膝）。 */
  softKneeDropM?: number
}

/** 逐帧调试快照（测试/排障用）。 */
export interface VrmMicroMotionSnapshot {
  enabled: boolean
  /** 当前平滑权重（0–1）。 */
  weight: number
  /** 累计时间（秒）。 */
  timeSec: number
  /** 是否存在可写的 normalized 骨。 */
  applied: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function smoothingAlpha(dtSec: number, tauSec: number): number {
  if (!(dtSec > 0) || !(tauSec > 0)) return 0
  return 1 - Math.exp(-dtSec / tauSec)
}

/**
 * 计算某时刻的微动增量（纯函数，便于单测/复现）。
 *
 * @param timeSec 单调时间（秒；NaN/Infinity → 按 0 处理）
 * @param scale 整体幅度缩放（0..2；非法回退 1）
 */
export function computeVrmMicroMotionPose(timeSec: number, scale = 1): VrmMicroMotionPose {
  const t = Number.isFinite(timeSec) ? timeSec : 0
  const s = Number.isFinite(scale) ? clamp(scale, 0, 2) : 1
  const d = VRM_MICRO_MOTION_DEFAULTS

  const breath = Math.sin(TAU * FREQ_BREATH * t)
  const breath2 = Math.sin(TAU * FREQ_BREATH * t + 1.9)
  const sway = Math.sin(TAU * FREQ_SWAY * t + 0.7)
  const sway2 = Math.sin(TAU * FREQ_SWAY * t + 2.6)
  const weightShift = Math.sin(TAU * FREQ_WEIGHT * t + 1.2)
  const drift = Math.sin(TAU * FREQ_DRIFT * t + 0.4)
  const drift2 = Math.sin(TAU * FREQ_DRIFT2 * t + 1.7)

  const swayAmp = d.swayDeg * s
  const breathAmp = d.breathDeg * s
  const headAmp = d.headDeg * s
  const weightAmp = d.weightShiftDeg * s

  return {
    // 骨盆：慢层承重脚 roll + 快层摆动（roll/pitch/yaw）
    hipsRotation: {
      x: 0.25 * swayAmp * sway2,
      y: 0.6 * swayAmp * sway,
      z: 0.72 * weightAmp * weightShift + 0.27 * swayAmp * sway
    },
    // 脊柱/胸：呼吸起伏 + 与骨盆反向的躯干补偿（避免整体像一块木板）
    spineRotation: {
      x: 0.72 * breathAmp * breath,
      y: -0.55 * swayAmp * sway,
      z: -0.36 * weightAmp * weightShift
    },
    chestRotation: {
      x: 1.0 * breathAmp * breath2,
      y: -0.4 * swayAmp * sway,
      z: -0.23 * swayAmp * sway2
    },
    // 颈/头：滞后跟随 + 极慢漂移（头部保持视觉水平感）
    neckRotation: {
      x: -0.36 * headAmp * Math.sin(TAU * FREQ_BREATH * t - 0.6),
      y: 0.36 * headAmp * drift,
      z: 0.23 * headAmp * sway
    },
    headRotation: {
      x: -0.55 * headAmp * Math.sin(TAU * FREQ_BREATH * t - 1.0),
      y: 0.9 * headAmp * drift2,
      z: 0.3 * headAmp * sway
    },
    hipsOffset: {
      x: d.hipsLateralM * s * sway2,
      y: d.hipsVerticalM * s * breath2,
      z: 0
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 运行时层                                                                    */
/* -------------------------------------------------------------------------- */

interface MicroMotionNodes {
  hips: Object3D | null
  spine: Object3D | null
  chest: Object3D | null
  neck: Object3D | null
  head: Object3D | null
}

const NODE_BONE_MAP = {
  hips: 'hips',
  spine: 'spine',
  chest: 'chest',
  neck: 'neck',
  head: 'head'
} as const satisfies Record<keyof MicroMotionNodes, HumanoidBone>

/**
 * 待机微动运行时层：每帧在 clip-player 之后、foot-lock 之前调用。
 */
export class VrmMicroMotion {
  private readonly nodes: MicroMotionNodes
  private readonly enabled: boolean
  private readonly scale: number
  private readonly applyHipsOffset: boolean
  private readonly softKneeDropM: number
  private timeSec = 0
  private weight = 0
  private disposed = false

  constructor(avatar: VrmAvatar, options: VrmMicroMotionOptions = {}) {
    const input = options ?? {}
    this.enabled = input.enabled !== false
    this.scale = Number.isFinite(input.scale) ? clamp(input.scale as number, 0, 2) : 1
    this.applyHipsOffset = input.applyHipsOffset !== false
    this.softKneeDropM = Number.isFinite(input.softKneeDropM)
      ? clamp(input.softKneeDropM as number, 0, 0.04)
      : VRM_MICRO_MOTION_DEFAULTS.softKneeDropM

    const humanoid = avatar?.vrm?.humanoid
    const get = (name: HumanoidBone): Object3D | null => {
      if (!humanoid || typeof humanoid.getNormalizedBoneNode !== 'function') return null
      try {
        return humanoid.getNormalizedBoneNode(name) ?? null
      } catch {
        return null
      }
    }
    this.nodes = {
      hips: get(NODE_BONE_MAP.hips),
      spine: get(NODE_BONE_MAP.spine),
      chest: get(NODE_BONE_MAP.chest),
      neck: get(NODE_BONE_MAP.neck),
      head: get(NODE_BONE_MAP.head)
    }
  }

  /**
   * 每帧推进（`enabled` = 当前是否处于 idle 基础姿态；false 时平滑淡出）。
   * 调用顺序必须在 clip-player.update() 之后、foot-lock.update() 之前。
   */
  /**
   * @param dtSec 帧时长（秒）
   * @param enabled 当前是否处于 idle 基础姿态（false = 平滑淡出）
   * @param scaleMultiplier 外部幅度缩放（缺省 1）：crossfade 期间 ×0.85（不要归零）、
   *   表演型 idle（Idle_Show 等本身已有大动作）建议 ×0.25–0.3。
   */
  update(dtSec: number, enabled: boolean, scaleMultiplier = 1): void {
    if (this.disposed || !this.enabled) return
    const dt = clamp(Number.isFinite(dtSec) ? dtSec : 0, 0, MAX_DELTA_SEC)
    this.timeSec += dt

    const target = enabled === true ? 1 : 0
    const tau = target > this.weight
      ? VRM_MICRO_MOTION_DEFAULTS.weightTauInSec
      : VRM_MICRO_MOTION_DEFAULTS.weightTauOutSec
    this.weight += (target - this.weight) * smoothingAlpha(dt, tau)
    if (Math.abs(target - this.weight) < 1e-4) this.weight = target
    if (this.weight < 1e-3) return

    const externalScale = Number.isFinite(scaleMultiplier) ? clamp(scaleMultiplier, 0, 1) : 1
    const pose = computeVrmMicroMotionPose(this.timeSec, this.scale * externalScale)
    const w = this.weight
    this.applyRotation(this.nodes.hips, pose.hipsRotation, w)
    this.applyRotation(this.nodes.spine, pose.spineRotation, w)
    this.applyRotation(this.nodes.chest, pose.chestRotation, w)
    this.applyRotation(this.nodes.neck, pose.neckRotation, w)
    this.applyRotation(this.nodes.head, pose.headRotation, w)

    if (this.applyHipsOffset && this.nodes.hips !== null) {
      this.nodes.hips.position.x += pose.hipsOffset.x * w
      this.nodes.hips.position.y += (pose.hipsOffset.y - this.softKneeDropM * externalScale) * w
      this.nodes.hips.position.z += pose.hipsOffset.z * w
    }
  }

  /** 清空时间/权重（模型重载/场景重建时用）。 */
  reset(): void {
    this.timeSec = 0
    this.weight = 0
  }

  /** 调试快照。 */
  getSnapshot(): VrmMicroMotionSnapshot {
    const humanoid = this.nodes
    const applied = humanoid.hips !== null || humanoid.spine !== null || humanoid.chest !== null
    return {
      enabled: this.enabled,
      weight: this.weight,
      timeSec: this.timeSec,
      applied
    }
  }

  dispose(): void {
    this.disposed = true
    this.weight = 0
  }

  /** 对一个 normalized 骨叠加欧拉增量（度 → 四元数；乘在现有局部旋转之后，不累积）。 */
  private applyRotation(
    node: Object3D | null,
    euler: VrmMicroMotionEuler,
    weight: number
  ): void {
    if (node === null || weight <= 0) return
    const x = euler.x * weight
    const y = euler.y * weight
    const z = euler.z * weight
    if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && Math.abs(z) < 1e-6) return
    const delta = QUAT_FROM_EULER.setFromEuler(EULER.fromArray([degToRad(x), degToRad(y), degToRad(z)]))
    node.quaternion.multiply(delta)
  }
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 复用的临时对象（避免每帧分配；单实例单线程使用安全）。 */
const EULER = new Euler()
const QUAT_FROM_EULER = new Quaternion()
