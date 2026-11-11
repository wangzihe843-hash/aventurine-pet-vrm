/**
 * 渲染循环健康度 / 动画失败可见性（F4 / M-3、M-7；纯函数，不 import DOM，可单测）。
 *
 * - M-3：`renderErrorCount` 语义是「**连续**异常帧数」——成功执行一帧必须清零；
 *   达到上限后停更新场景但保留 rAF，便于采集器读调试面。
 * - M-7：动画驱动失败（`PetScene.animationFailureMessage`）只上报首次/内容变化，
 *   避免每帧刷屏 `debug.errors`。
 */

/** 连续渲染错误计数：本帧抛错 +1，正常执行（含 fpsCap 跳帧但 step 正常返回）清零。 */
export function nextRenderErrorCount(previous: number, frameThrew: boolean): number {
  const safePrevious =
    typeof previous === 'number' && Number.isFinite(previous) && previous > 0
      ? Math.floor(previous)
      : 0
  return frameThrew ? safePrevious + 1 : 0
}

/** 是否应上报动画失败：非空且与上次已上报内容不同（null → 不报，恢复后再次失败会重报）。 */
export function shouldReportAnimationFailure(
  previous: string | null,
  current: string | null | undefined
): boolean {
  if (typeof current !== 'string' || current.length === 0) return false
  return current !== previous
}
