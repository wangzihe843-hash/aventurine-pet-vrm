/**
 * B2 物理内部工具：数值 / 点 / 矩形防御性校验（纯函数，无副作用）。
 *
 * 物理模块对**外部输入**（B5 表面、B4 指针、main.ts 的 dt/now）一律假设可能非法：
 * NaN/Infinity/负 width 等都只降级、不抛异常、不污染内部状态（验收：退化输入不 NaN）。
 */
import type { Point2D } from '../core/wave2-contract'
import type { Rect } from '@shared/types'

/** 是否有限数字（排除 NaN / ±Infinity / 非 number）。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 有限正数；否则返回 fallback（fallback 由调用方保证 > 0）。 */
export function finitePositive(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? value : fallback
}

/** 数值钳制（调用方保证 min ≤ max 且参数有限）。 */
export function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** 是否为有限二维点。 */
export function isFinitePoint(value: unknown): value is Point2D {
  if (!value || typeof value !== 'object') return false
  const point = value as Point2D
  return isFiniteNumber(point.x) && isFiniteNumber(point.y)
}

/** 是否为合法矩形（四个字段有限、宽高非负）。 */
export function isValidRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Rect
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  )
}

/** 浅拷贝一个有限点（快照返回时用，避免调用方改到内部状态）。 */
export function clonePoint(point: Point2D): Point2D {
  return { x: point.x, y: point.y }
}
