/**
 * 外部动作的**纯选择/播放参数逻辑**（不 import three/DOM，Node 可单测）。
 *
 * 覆盖 D1 任务书里的三件事：
 * 1. `AnimationInput.mood` → manifest clip（manifest 顺序 = 优先级，取第一个 mood 匹配的）；
 * 2. walk 类 clip 的播放速率：`当前水平速度 / nominalSpeedPxPerSec`，钳制 0.5–1.6（防滑步/鬼畜）；
 * 3. 切换淡入时长夹取 120–250ms（清单可配置，但不能超出任务书区间）。
 */

import type { PetMood } from '@shared/types'

import { MAX_CROSSFADE_MS, MIN_CROSSFADE_MS, type MotionClipDef, type MotionManifest } from './manifest'

/** 播放速率下限（走路太慢时慢放，避免定住）。 */
export const MIN_PLAYBACK_RATE = 0.5
/** 播放速率上限（走路太快时加快，避免脚滑）。 */
export const MAX_PLAYBACK_RATE = 1.6

/**
 * manifest 里 `nominalSpeedPxPerSec` 的**参考宠物高度**（CSS px）。
 *
 * 约定：清单里的走路自然速度是「在 540px 高宠物上测得的 px/s」（当前 `motion-walk.vmd`
 * ≈ 470px/s @540px，即 ≈0.87 体高/秒）。实际宠物尺寸变化时按体高线性换算，
 * 这样播放速率 `speed / effectiveNominal` 与宠物尺寸无关，任何 sizePercent 下都不滑步。
 */
export const WALK_SPEED_REF_HEIGHT_PX = 540

/**
 * 按当前宠物高度换算后的「自然步速」（px/s）：`nominal × (petHeightPx / 540)`。
 * `nominal` 为 null/非法（非走路类）→ null；宠物高度非法/缺失 → 按参考高度 540 处理。
 */
export function effectiveNominalSpeedPxPerSec(
  nominalSpeedPxPerSec: number | null | undefined,
  petHeightPx: number | null | undefined
): number | null {
  if (
    nominalSpeedPxPerSec === null ||
    nominalSpeedPxPerSec === undefined ||
    !Number.isFinite(nominalSpeedPxPerSec) ||
    nominalSpeedPxPerSec <= 0
  ) {
    return null
  }
  const height =
    typeof petHeightPx === 'number' && Number.isFinite(petHeightPx) && petHeightPx > 0
      ? petHeightPx
      : WALK_SPEED_REF_HEIGHT_PX
  return (nominalSpeedPxPerSec * height) / WALK_SPEED_REF_HEIGHT_PX
}

/** 默认淡入（清单缺省/非法时）。 */
const DEFAULT_FADE_MS = 200

/**
 * 按 mood 选 clip：manifest 顺序即优先级，返回第一个 `moods` 包含该 mood 的 clip。
 * 无匹配/清单为空 → null（调用方回退 B3）。
 */
export function selectClipForMood(
  manifest: MotionManifest | null | undefined,
  mood: PetMood
): MotionClipDef | null {
  if (!manifest || manifest.clips.length === 0) return null
  for (const clip of manifest.clips) {
    if (clip.moods.includes(mood)) return clip
  }
  return null
}

/**
 * 播放速率：`nominalSpeedPxPerSec` 为 null（非走路类）→ 1；
 * 否则 = 当前水平速度 / nominal，钳制 [0.5, 1.6]。
 *
 * `speedPxPerSec` 用水平速度模长；非法值按 0 处理（→ 0.5 下限）。
 */
export function resolvePlaybackRate(
  nominalSpeedPxPerSec: number | null,
  speedPxPerSec: number
): number {
  if (nominalSpeedPxPerSec === null || !Number.isFinite(nominalSpeedPxPerSec) || nominalSpeedPxPerSec <= 0) {
    return 1
  }
  const speed = Number.isFinite(speedPxPerSec) ? Math.max(0, speedPxPerSec) : 0
  const raw = speed / nominalSpeedPxPerSec
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, raw))
}

/** 速度快照（`MotionSnapshot.velocity`，px/s，y 向下为正）→ 水平速率模长。 */
export function horizontalSpeedOf(
  velocity: { x: number; y: number } | null | undefined
): number {
  if (!velocity) return 0
  const x = Number.isFinite(velocity.x) ? velocity.x : 0
  const y = Number.isFinite(velocity.y) ? velocity.y : 0
  return Math.hypot(x, y)
}

/** 淡入时长夹取：默认 200ms，非法回默认，最终钳制在 [120, 250]ms。 */
export function clampCrossfadeMs(crossfadeMs: number | null | undefined): number {
  const value =
    typeof crossfadeMs === 'number' && Number.isFinite(crossfadeMs) && crossfadeMs >= 0
      ? crossfadeMs
      : DEFAULT_FADE_MS
  if (value === 0) return 0
  return Math.min(MAX_CROSSFADE_MS, Math.max(MIN_CROSSFADE_MS, value))
}

/** manifest 的 `ik` 字段 → helper.enable('ik', x) 的布尔值。 */
export function isIkEnabled(mode: 'on' | 'off' | null | undefined): boolean {
  return mode !== 'off'
}
