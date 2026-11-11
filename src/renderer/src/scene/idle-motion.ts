/**
 * 轻量环境微动：呼吸缩放 + 重心横移（PLAN §18.1 / §18.3：0.15–0.42 Hz 档）。
 *
 * 桌面伴侣「非侵入」研究给出的最不干扰频段是 0.15–0.42 Hz 的锚定振荡
 * （Presence You Can Ignore, DOI 10.5281/zenodo.22806803；CHI 2024 桌面伴侣行为研究）。
 * 因此呼吸取 0.24 Hz、重心横移取 0.16 Hz，两个不可通约的正弦叠加；
 * 幅度很小（高度 ±0.4%、摆角 ±0.004 rad ≈ ±0.26°）——不会破坏脚底贴边，
 * 在 324px 高的宠物上头部横向摆动约 1.5px、纵向起伏约 1.3px，属于「几乎察觉不到」的活体感。
 */
import type { Object3D } from 'three'

/** 微动参数（可在后续 Wave 由配置/行为系统覆盖）。 */
export interface IdleMotionOptions {
  /** 呼吸频率（Hz），建议 0.15–0.42。 */
  breathHz: number
  /** 重心横移频率（Hz），建议 0.15–0.42。 */
  swayHz: number
  /** 呼吸缩放幅度（相对高度，0.004 = ±0.4%）。 */
  breathAmplitude: number
  /** 摆角幅度（弧度，0.004 ≈ 0.23°）。 */
  swayAmplitudeRad: number
}

/** 默认参数：呼吸 0.24 Hz / 横移 0.16 Hz（论文结论频段内）。 */
export const DEFAULT_IDLE_MOTION: IdleMotionOptions = {
  breathHz: 0.24,
  swayHz: 0.16,
  breathAmplitude: 0.004,
  swayAmplitudeRad: 0.004
}

/** 单次 update 允许的最大 dt（秒），防止标签页恢复时一次性跳变。 */
const MAX_DELTA_SECONDS = 0.1

/** 以脚底为支点的呼吸/横移控制器（apply 时直接改 modelRoot 的 scale/rotation）。 */
export class IdleMotion {
  private readonly options: IdleMotionOptions
  private elapsedSeconds = 0

  constructor(options: IdleMotionOptions = DEFAULT_IDLE_MOTION) {
    this.options = options
  }

  /** 累加环境动作时间（按真实渲染帧 dt，跳帧时由调用方传入累计 dt）。 */
  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return
    this.elapsedSeconds += Math.min(deltaSeconds, MAX_DELTA_SECONDS)
  }

  /** 当前时间（秒），调试/测试用。 */
  get elapsed(): number {
    return this.elapsedSeconds
  }

  /** 把微动叠加到模型根节点：scale 以脚底为原点、rotation.z 让重心轻微横移。 */
  apply(root: Object3D, baseScale: number): void {
    if (!Number.isFinite(baseScale) || baseScale <= 0) return
    const { breathHz, swayHz, breathAmplitude, swayAmplitudeRad } = this.options
    const t = this.elapsedSeconds
    const breath = Math.sin(2 * Math.PI * breathHz * t)
    const sway = Math.sin(2 * Math.PI * swayHz * t + Math.PI / 3)
    // 呼吸：纵向 ±amp，横向做少量反向补偿（近似保持体积/观感自然）。
    root.scale.set(
      baseScale * (1 - 0.35 * breathAmplitude * breath),
      baseScale * (1 + breathAmplitude * breath),
      baseScale
    )
    root.rotation.z = swayAmplitudeRad * sway
  }

  /** 归零（重新摆放模型时避免残留上一状态）。 */
  reset(): void {
    this.elapsedSeconds = 0
  }
}
