/**
 * 单测：B5 桌面感知 —— 窗口过滤（`desktop/filter.ts`）。
 *
 * 覆盖 PLAN §11 吸附规则：
 * - layer===0（系统窗口/菜单栏/Dock layer>0 被排除）；
 * - alpha>0.01、height>80、onScreen===true；
 * - 排除自身进程 / overlay 窗口、当前显示器之外的窗口；
 * - 脏 payload（非数组 / 字段缺失 / NaN / 零负尺寸）不抛、逐项丢弃。
 */
import { describe, expect, it } from 'vitest'

import type { WindowInfo } from '../src/shared/types'
import {
  filterWindows,
  isEligibleWindow,
  MIN_WINDOW_ALPHA,
  MIN_WINDOW_HEIGHT_PX,
  NORMAL_WINDOW_LAYER,
  sanitizeWindows
} from '../src/renderer/src/desktop/filter'

/** 一个合法普通应用窗口（layer 0 / alpha 1 / 高 600 / 在屏）。 */
function makeWindow(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    id: 42,
    pid: 100,
    owner: '访达',
    layer: 0,
    alpha: 1,
    bounds: { x: 100, y: 130, width: 800, height: 600 },
    onScreen: true,
    ...overrides
  }
}

const DISPLAY_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 }

describe('sanitizeWindows（脏 payload 防御）', () => {
  it('非数组输入 → [];空数组 → []', () => {
    expect(sanitizeWindows(null)).toEqual([])
    expect(sanitizeWindows(undefined)).toEqual([])
    expect(sanitizeWindows('not-an-array')).toEqual([])
    expect(sanitizeWindows(42)).toEqual([])
    expect(sanitizeWindows([])).toEqual([])
  })

  it('合法窗口原样保留并归一化 bounds', () => {
    const windows = sanitizeWindows([makeWindow({ id: 7, owner: 'Safari' })])
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ id: 7, pid: 100, owner: 'Safari', layer: 0, alpha: 1 })
    expect(windows[0].onScreen).toBe(true)
  })

  it('字段缺失 / 类型不对 / NaN bounds 的项被丢弃，其余保留', () => {
    const dirty = [
      makeWindow({ id: 1 }),
      { id: 2, pid: 100, owner: 'X', layer: 0, alpha: 1 }, // 缺 bounds/onScreen
      { ...makeWindow({ id: 3 }), bounds: { x: NaN, y: 0, width: 10, height: 10 } },
      { ...makeWindow({ id: 4 }), onScreen: 'yes' },
      null,
      'window',
      makeWindow({ id: 5 })
    ]
    const windows = sanitizeWindows(dirty)
    expect(windows.map((window) => window.id)).toEqual([1, 5])
  })

  it('零 / 负尺寸窗口被丢弃（隐藏辅助窗 / 异常数据）', () => {
    const windows = sanitizeWindows([
      makeWindow({ id: 1, bounds: { x: 0, y: 0, width: 0, height: 600 } }),
      makeWindow({ id: 2, bounds: { x: 0, y: 0, width: 800, height: 0 } }),
      makeWindow({ id: 3, bounds: { x: 0, y: 0, width: -10, height: 600 } }),
      makeWindow({ id: 4 })
    ])
    expect(windows.map((window) => window.id)).toEqual([4])
  })

  it('id 重复时保留第一项；顺序原样保留（z 序不可排序）', () => {
    const windows = sanitizeWindows([
      makeWindow({ id: 2, owner: '前' }),
      makeWindow({ id: 1, owner: '后' }),
      makeWindow({ id: 2, owner: '重复' })
    ])
    expect(windows.map((window) => window.id)).toEqual([2, 1])
    expect(windows[0].owner).toBe('前')
  })

  it('NaN / 非法数值字段不会产生 NaN 表面输入', () => {
    const windows = sanitizeWindows([
      makeWindow({ id: 1, alpha: Number.NaN }),
      makeWindow({ id: 2, layer: Number.NaN }),
      makeWindow({ id: 3, pid: Number.NaN }),
      makeWindow({ id: 4 })
    ])
    expect(windows.map((window) => window.id)).toEqual([4])
    for (const window of windows) {
      expect(Number.isFinite(window.bounds.x)).toBe(true)
      expect(Number.isFinite(window.alpha)).toBe(true)
    }
  })
})

describe('isEligibleWindow（吸附过滤规则）', () => {
  it('默认规则常量与契约口径一致', () => {
    expect(NORMAL_WINDOW_LAYER).toBe(0)
    expect(MIN_WINDOW_HEIGHT_PX).toBe(80)
    expect(MIN_WINDOW_ALPHA).toBe(0.01)
  })

  it('合法普通窗口通过', () => {
    expect(isEligibleWindow(makeWindow())).toBe(true)
  })

  it('layer !== 0 被排除（菜单栏 / Dock / 面板等系统窗口）', () => {
    expect(isEligibleWindow(makeWindow({ layer: 1 }))).toBe(false)
    expect(isEligibleWindow(makeWindow({ layer: 20 }))).toBe(false)
    expect(isEligibleWindow(makeWindow({ layer: 25 }))).toBe(false)
    expect(isEligibleWindow(makeWindow({ layer: 1000 }))).toBe(false) // overlay 自身层
  })

  it('alpha <= 0.01 被排除（严格大于才可见）', () => {
    expect(isEligibleWindow(makeWindow({ alpha: 0 }))).toBe(false)
    expect(isEligibleWindow(makeWindow({ alpha: 0.005 }))).toBe(false)
    expect(isEligibleWindow(makeWindow({ alpha: 0.01 }))).toBe(false)
    expect(isEligibleWindow(makeWindow({ alpha: 0.02 }))).toBe(true)
    expect(isEligibleWindow(makeWindow({ alpha: 1 }))).toBe(true)
  })

  it('height <= 80 被排除（小工具窗口不坐）', () => {
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 0, y: 0, width: 800, height: 80 } }))
    ).toBe(false)
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 0, y: 0, width: 800, height: 81 } }))
    ).toBe(true)
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 0, y: 0, width: 800, height: 40 } }))
    ).toBe(false)
  })

  it('onScreen !== true 被排除', () => {
    expect(isEligibleWindow(makeWindow({ onScreen: false }))).toBe(false)
  })

  it('自身进程 pid 被排除，其它 pid 保留', () => {
    expect(isEligibleWindow(makeWindow({ pid: 999 }), { ownPid: 999 })).toBe(false)
    expect(isEligibleWindow(makeWindow({ pid: 100 }), { ownPid: 999 })).toBe(true)
    expect(isEligibleWindow(makeWindow({ pid: 999 }))).toBe(true)
  })

  it('overlay 窗口 id 被排除（ownPid 之外的第二保险）', () => {
    expect(isEligibleWindow(makeWindow({ id: 42 }), { overlayWindowIds: [42, 43] })).toBe(false)
    expect(isEligibleWindow(makeWindow({ id: 44 }), { overlayWindowIds: [42, 43] })).toBe(true)
  })

  it('显示器 bounds 之外 / 仅边缘相触的窗口被排除；部分重叠保留', () => {
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 50, y: 50, width: 800, height: 600 } }), {
        displayBounds: DISPLAY_BOUNDS
      })
    ).toBe(true)
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 2000, y: 100, width: 800, height: 600 } }), {
        displayBounds: DISPLAY_BOUNDS
      })
    ).toBe(false)
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 1920, y: 100, width: 800, height: 600 } }), {
        displayBounds: DISPLAY_BOUNDS
      })
    ).toBe(false)
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: -200, y: 100, width: 500, height: 600 } }), {
        displayBounds: DISPLAY_BOUNDS
      })
    ).toBe(true)
  })

  it('结构非法（NaN bounds）被排除，不抛', () => {
    const dirty = makeWindow({
      bounds: { x: Number.NaN, y: 100, width: 800, height: 600 }
    })
    expect(() => isEligibleWindow(dirty)).not.toThrow()
    expect(isEligibleWindow(dirty)).toBe(false)
  })

  it('可注入阈值：minHeightPx / minAlpha / requiredLayer 生效', () => {
    expect(
      isEligibleWindow(makeWindow({ bounds: { x: 0, y: 0, width: 800, height: 40 } }), {
        minHeightPx: 0
      })
    ).toBe(true)
    expect(isEligibleWindow(makeWindow({ alpha: 0.2 }), { minAlpha: 0.5 })).toBe(false)
    expect(isEligibleWindow(makeWindow({ alpha: 0.6 }), { minAlpha: 0.5 })).toBe(true)
    expect(isEligibleWindow(makeWindow({ layer: 1 }), { requiredLayer: 1 })).toBe(true)
  })
})

describe('filterWindows（列表过滤）', () => {
  it('保留合法窗口原顺序，排除系统窗口 / 小工具窗 / 自身窗口', () => {
    const windows = [
      makeWindow({ id: 1, owner: '前台' }),
      makeWindow({ id: 2, layer: 25, owner: '菜单栏' }),
      makeWindow({ id: 3, owner: '后台' }),
      makeWindow({ id: 4, layer: 20, owner: 'Dock' }),
      makeWindow({ id: 5, bounds: { x: 0, y: 0, width: 600, height: 40 }, owner: '工具条' }),
      makeWindow({ id: 6, alpha: 0, owner: '不可见' }),
      makeWindow({ id: 999, pid: 999, owner: '自身' })
    ]
    const filtered = filterWindows(windows, { ownPid: 999 })
    expect(filtered.map((window) => window.id)).toEqual([1, 3])
  })

  it('空列表 / 非数组输入安全返回 []', () => {
    expect(filterWindows([])).toEqual([])
    expect(filterWindows(undefined as unknown as WindowInfo[])).toEqual([])
  })
})
