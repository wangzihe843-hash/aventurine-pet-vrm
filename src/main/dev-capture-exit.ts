/**
 * dev 姿态截图回环的退出码决策（纯函数，可单测）。
 *
 * 背景（M-9）：修复前 `src/main/index.ts` 的 `runDevCapture` 无论 renderer 是否 ready、
 * 姿态是否全部被跳过、甚至捕获过程抛异常，都会打印 `DEV_CAPTURE_OK` 并 `app.exit(0)`；
 * capturePage 可能只对着空白/旧帧写 PNG，让「截屏证据」假通过。
 *
 * 本模块把「什么算成功」抽成不依赖 Electron 的纯函数：
 * - 只有 renderer 调试面 ready、至少 1 张截图、0 skipped、0 failed、无顶层异常才 OK；
 * - 任一条件不满足 → 非 0 退出并由调用方打印 `DEV_CAPTURE_FAIL`。
 *
 * 刻意不 import electron / fs / index.ts：便于单测覆盖所有分支。
 */

/** 一次 dev 截图回环的统计（由 `runDevCapture` 在捕获过程中累计）。 */
export interface DevCaptureStats {
  /** renderer 调试面是否就绪（`__aventurineDebug` present 且 ready === true）。 */
  ready: boolean
  /** 成功写盘的截图数量。 */
  captured: number
  /** 因 `debugSetPose` 返回 false / 不存在而被跳过的姿态数量。 */
  skipped: number
  /** 捕获过程中的失败数量（顶层异常记 1；将来若改为逐帧容错可累计）。 */
  failed: number
  /** 顶层异常文本（正常路径为 null/undefined）；非空即失败。 */
  error?: string | null
}

/** 退出码决策结果。 */
export interface DevCaptureDecision {
  /** 是否全好（只有 true 才允许打印 `DEV_CAPTURE_OK`）。 */
  ok: boolean
  /** 进程退出码（0 = 成功，1 = 失败）。 */
  exitCode: 0 | 1
  /** 失败原因（OK 时为 null）；用于 `DEV_CAPTURE_FAIL` payload 与单测断言。 */
  reason: string | null
}

/** 非负整数归一化（防 NaN/负数/小数污染统计与 payload）。 */
function count(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * 依据统计决定 dev 截图回环的退出码。
 *
 * 判定顺序（先报最根本的原因）：
 * 1. 顶层异常 / 捕获失败 → `capture-error`；
 * 2. renderer 未就绪 → `renderer-not-ready`；
 * 3. 有姿态被跳过 → `poses-skipped`；
 * 4. 没有任何成功截图 → `no-captures`；
 * 5. 以上都满足 → OK（exit 0）。
 */
export function decideDevCaptureExit(stats: DevCaptureStats): DevCaptureDecision {
  const failed = count(stats.failed)
  const skipped = count(stats.skipped)
  const captured = count(stats.captured)

  if (failed > 0 || (typeof stats.error === 'string' && stats.error.length > 0)) {
    return { ok: false, exitCode: 1, reason: 'capture-error' }
  }
  if (stats.ready !== true) {
    return { ok: false, exitCode: 1, reason: 'renderer-not-ready' }
  }
  if (skipped > 0) {
    return { ok: false, exitCode: 1, reason: 'poses-skipped' }
  }
  if (captured < 1) {
    return { ok: false, exitCode: 1, reason: 'no-captures' }
  }
  return { ok: true, exitCode: 0, reason: null }
}
