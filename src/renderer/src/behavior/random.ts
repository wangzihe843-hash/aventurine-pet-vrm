/**
 * B1 随机源工具（纯函数；**不 import DOM / three / Electron / Node 内置**）。
 *
 * 验收要求：相同 seed + 相同输入 → 决策序列完全一致。
 * - 每帧随机决策只经 `BehaviorInput.random`（契约硬性规定），本文件的 seeded RNG
 *   既可作为构造参数注入，也可在单测里做 `input.random`；
 * - mulberry32 实现短小、分布够用、跨平台确定（只用 32 位整数运算）。
 */

/**
 * 由 seed 构造可复现随机源，返回 `[0, 1)`。
 * 相同 seed 在任意机器上产生完全相同的序列（不依赖时钟/平台函数）。
 */
export function createSeededRandom(seed: number): () => number {
  // 非有限值兜底 0；取整后截断为 32 位无符号，保证任何 number 输入都有确定行为。
  const initial = Number.isFinite(seed) ? Math.trunc(seed) : 0
  let state = initial >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 读取一次随机值并钳制到 `[0, 1)`（防御注入源返回 NaN / 越界 / 1）。 */
export function readRandom(random: () => number): number {
  let value: number
  try {
    value = random()
  } catch {
    return 0
  }
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 0.9999999999
  return value
}

/** `[min, max)` 区间随机数（min/max 非有限或 min > max 时安全回退）。 */
export function randomRange(random: () => number, min: number, max: number): number {
  const lo = Number.isFinite(min) ? min : 0
  const hi = Number.isFinite(max) ? max : lo
  if (!(hi > lo)) return lo
  return lo + readRandom(random) * (hi - lo)
}

/** 整数区间随机数（闭区间 `[min, max]`；用于时长，避免浮点累积）。 */
export function randomInt(random: () => number, min: number, max: number): number {
  const lo = Math.ceil(Number.isFinite(min) ? min : 0)
  const hi = Math.floor(Number.isFinite(max) ? max : lo)
  if (!(hi > lo)) return lo
  return lo + Math.floor(readRandom(random) * (hi - lo + 1))
}

/** 把任意可能缺省/非法的随机源规范为可用函数（缺省 → Math.random）。 */
export function sanitizeRandom(random: (() => number) | null | undefined): () => number {
  if (typeof random !== 'function') return Math.random
  return (): number => readRandom(random)
}
