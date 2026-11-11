/**
 * 渲染帧率上限 + FPS 统计（A2，PLAN §17.5 P2「FPS 上限归 A2 实现」）。
 *
 * macOS 上 `requestAnimationFrame` 跟随显示器刷新率（60/120Hz 常见），
 * 桌宠无需满帧渲染：用累加器/时间间隔跳过帧，把 render 频率压到 `fpsCap`（默认 30）；
 * `pet:get-config` 返回/变更时热更，无需重启。
 */
import { CONFIG_LIMITS } from '@shared/config'

/** 配置缺失时的默认上限（与 @shared/config DEFAULT_CONFIG.fpsCap 一致）。 */
export const DEFAULT_FPS_CAP = 30

/** FPS 统计窗口（毫秒）：只统计最近 1s 内真正渲染的帧。 */
const FPS_WINDOW_MS = 1000

/** 统计样本上限（60fps 下 1s = 60 帧，预留 120 防抖动）。 */
const MAX_SAMPLES = 120

/** 统计 FPS 时忽略的异常长间隔（如 capturePage / DevTools 导致的 >250ms 卡顿）。 */
const MAX_FRAME_GAP_MS = 250

/** 把 fpsCap 钳制到契约区间 [5, 60]（非法值回退默认 30）。 */
export function clampFpsCap(fpsCap: number): number {
  if (typeof fpsCap !== 'number' || !Number.isFinite(fpsCap)) return DEFAULT_FPS_CAP
  if (fpsCap < CONFIG_LIMITS.fpsCap.min) return CONFIG_LIMITS.fpsCap.min
  if (fpsCap > CONFIG_LIMITS.fpsCap.max) return CONFIG_LIMITS.fpsCap.max
  return Math.round(fpsCap)
}

/** 帧率控制器：决定每一帧是否真正渲染，并统计实际 FPS。 */
export class FrameRateController {
  private cap = DEFAULT_FPS_CAP
  private lastRenderMs: number | null = null
  private readonly samples: number[] = []

  constructor(fpsCap: number = DEFAULT_FPS_CAP) {
    this.setCap(fpsCap)
  }

  /** 当前帧率上限（5–60）。 */
  get fpsCap(): number {
    return this.cap
  }

  /** 热更帧率上限；已挂起的间隔按新上限计算（下一帧生效）。 */
  setCap(fpsCap: number): void {
    this.cap = clampFpsCap(fpsCap)
  }

  /**
   * `nowMs` 时刻是否应渲染：距上一渲染帧 ≥ 1000/cap 时返回 true 并记录样本。
   * 用 0.5ms 容差吸收 rAF 时间戳抖动（60Hz → 30fps 时相邻 rAF 间隔 33.3ms、
   * 阈值 = 33.33ms − 0.5ms = 32.83ms，避免 60Hz 下每帧都被判成「还没到」而掉到 15fps）。
   */
  shouldRender(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) return false
    if (this.lastRenderMs !== null) {
      const interval = 1000 / this.cap
      if (nowMs - this.lastRenderMs < interval - 0.5) return false
    }
    this.lastRenderMs = nowMs
    this.samples.push(nowMs)
    while (this.samples.length > MAX_SAMPLES) this.samples.shift()
    while (this.samples.length > 0 && nowMs - this.samples[0] > FPS_WINDOW_MS) {
      this.samples.shift()
    }
    return true
  }

  /**
   * 最近 1s 的实测 FPS（样本不足返回 0）。
   * 跳过 >250ms 的异常间隔（`capturePage`/DevTools 抓帧会阻塞渲染循环；
   * 这是外部停顿而不是渲染能力下降，计入会低估稳态帧率）。
   */
  getFps(nowMs: number): number {
    while (this.samples.length > 0 && nowMs - this.samples[0] > FPS_WINDOW_MS) {
      this.samples.shift()
    }
    if (this.samples.length < 2) return 0
    let frames = 0
    let elapsedMs = 0
    for (let i = 1; i < this.samples.length; i += 1) {
      const gap = this.samples[i] - this.samples[i - 1]
      if (gap <= 0 || gap > MAX_FRAME_GAP_MS) continue
      frames += 1
      elapsedMs += gap
    }
    if (elapsedMs <= 0) return 0
    return (frames * 1000) / elapsedMs
  }
}
