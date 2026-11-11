/**
 * 单测：渲染循环健康度纯函数（F4 / M-3、M-7 修复）。
 *
 * - M-3：`renderErrorCount` 是「连续异常帧数」，成功帧清零；达到上限停更新但保留 rAF。
 * - M-7：动画驱动失败只上报首次/内容变化，避免每帧刷屏 `debug.errors`。
 */
import { describe, expect, it } from 'vitest'

import {
  nextRenderErrorCount,
  shouldReportAnimationFailure
} from '../src/renderer/src/interaction/render-health'

describe('nextRenderErrorCount：连续错误计数', () => {
  it('成功帧（含 fpsCap 跳帧但 step 正常返回）清零', () => {
    expect(nextRenderErrorCount(0, false)).toBe(0)
    expect(nextRenderErrorCount(2, false)).toBe(0)
    expect(nextRenderErrorCount(3, false)).toBe(0)
  })

  it('抛错帧递增（连续语义）', () => {
    expect(nextRenderErrorCount(0, true)).toBe(1)
    expect(nextRenderErrorCount(1, true)).toBe(2)
    expect(nextRenderErrorCount(2, true)).toBe(3)
  })

  it('异常入参安全（NaN/负数/小数 → 归一后再计算）', () => {
    expect(nextRenderErrorCount(Number.NaN, true)).toBe(1)
    expect(nextRenderErrorCount(-5, true)).toBe(1)
    expect(nextRenderErrorCount(1.9, true)).toBe(2)
    expect(nextRenderErrorCount(Number.POSITIVE_INFINITY, true)).toBe(1)
  })
})

describe('shouldReportAnimationFailure：动画失败去重上报', () => {
  it('首次出现 → 上报', () => {
    expect(shouldReportAnimationFailure(null, '姿态驱动创建失败: x')).toBe(true)
    expect(shouldReportAnimationFailure('旧错误', '新错误')).toBe(true)
  })

  it('同一错误重复出现 → 不重复上报（不刷屏）', () => {
    expect(shouldReportAnimationFailure('同一错误', '同一错误')).toBe(false)
  })

  it('null/空串/非字符串 → 不上报（恢复后再次失败会重新上报）', () => {
    expect(shouldReportAnimationFailure('旧错误', null)).toBe(false)
    expect(shouldReportAnimationFailure(null, null)).toBe(false)
    expect(shouldReportAnimationFailure('旧错误', '')).toBe(false)
    expect(shouldReportAnimationFailure('旧错误', undefined)).toBe(false)
  })
})
