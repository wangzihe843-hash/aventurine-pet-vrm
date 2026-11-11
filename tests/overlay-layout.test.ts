/**
 * 单测：多屏 overlay 布局纯函数（`src/main/windows/layout.ts`，Wave 1 A1）。
 *
 * 覆盖：单屏 / 多屏 + 负坐标 + 主屏识别 / 显示器移除后的布局集合 / workArea 变化 /
 * 空输入 / 重复 id 防御 / 返回矩形不与输入共享引用。
 * 纯函数不依赖 Electron，可在 vitest node 环境直接跑。
 */
import { describe, expect, it } from 'vitest'

import type { DisplayInfo } from '@shared/types'
import { computeOverlayLayouts } from '../src/main/windows/layout'

/** 构造测试用显示器快照（默认 1080p 主屏，workArea 避开 25px 菜单栏）。 */
function makeDisplay(partial: Partial<DisplayInfo> & { id: number }): DisplayInfo {
  return {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 25, width: 1920, height: 1055 },
    scaleFactor: 1,
    isPrimary: false,
    ...partial
  }
}

describe('computeOverlayLayouts：每屏一个 overlay，frame = workArea', () => {
  it('空输入 → 空布局（无显示器不建任何窗口）', () => {
    expect(computeOverlayLayouts([])).toEqual([])
  })

  it('单屏：一个布局；frame 取 workArea（不是 bounds）；主屏标记透传', () => {
    const display = makeDisplay({
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 25, width: 1920, height: 1055 },
      isPrimary: true
    })

    const layouts = computeOverlayLayouts([display])

    expect(layouts).toHaveLength(1)
    expect(layouts[0]).toEqual({
      displayId: 1,
      frame: { x: 0, y: 25, width: 1920, height: 1055 },
      isPrimary: true
    })
  })

  it('多屏 + 负坐标：一屏一项、保留顺序与负坐标、只标记真实主屏', () => {
    const primary = makeDisplay({
      id: 10,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 25, width: 1920, height: 1055 },
      isPrimary: true
    })
    // 左侧外接屏（负 x）
    const left = makeDisplay({
      id: 20,
      bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
      workArea: { x: -2560, y: 24, width: 2560, height: 1376 },
      scaleFactor: 2
    })
    // 上方外接屏（负 y）
    const above = makeDisplay({
      id: 30,
      bounds: { x: 0, y: -1440, width: 1920, height: 1440 },
      workArea: { x: 0, y: -1416, width: 1920, height: 1416 }
    })

    const layouts = computeOverlayLayouts([primary, left, above])

    expect(layouts).toHaveLength(3)
    expect(layouts.map((layout) => layout.displayId)).toEqual([10, 20, 30])
    expect(layouts[0]).toEqual({
      displayId: 10,
      frame: { x: 0, y: 25, width: 1920, height: 1055 },
      isPrimary: true
    })
    expect(layouts[1]).toEqual({
      displayId: 20,
      frame: { x: -2560, y: 24, width: 2560, height: 1376 },
      isPrimary: false
    })
    expect(layouts[2]).toEqual({
      displayId: 30,
      frame: { x: 0, y: -1416, width: 1920, height: 1416 },
      isPrimary: false
    })
    // 只允许一个主屏标记
    expect(layouts.filter((layout) => layout.isPrimary)).toHaveLength(1)
  })

  it('显示器移除后重新计算：只剩仍存在的 display id，不残留旧 frame', () => {
    const primary = makeDisplay({ id: 10, isPrimary: true })
    const externalA = makeDisplay({
      id: 20,
      bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
      workArea: { x: -2560, y: 24, width: 2560, height: 1376 }
    })
    const externalB = makeDisplay({
      id: 30,
      bounds: { x: 1920, y: 0, width: 1080, height: 1920 },
      workArea: { x: 1920, y: 24, width: 1080, height: 1856 }
    })

    const before = computeOverlayLayouts([primary, externalA, externalB])
    expect(before.map((layout) => layout.displayId)).toEqual([10, 20, 30])

    // 拔掉 externalA（id=20）
    const after = computeOverlayLayouts([primary, externalB])
    expect(after.map((layout) => layout.displayId)).toEqual([10, 30])
    expect(after.map((layout) => layout.frame)).toEqual([
      { x: 0, y: 25, width: 1920, height: 1055 },
      { x: 1920, y: 24, width: 1080, height: 1856 }
    ])
    expect(after[1].isPrimary).toBe(false)
  })

  it('workArea 变化（Dock / 菜单栏自动隐藏、分辨率变化）→ frame 跟随新 workArea', () => {
    const display = makeDisplay({
      id: 10,
      isPrimary: true,
      workArea: { x: 0, y: 25, width: 1920, height: 1055 }
    })
    expect(computeOverlayLayouts([display])[0].frame).toEqual({
      x: 0,
      y: 25,
      width: 1920,
      height: 1055
    })

    // Dock 自动隐藏后 workArea 变高、y 上移
    const changed = makeDisplay({
      id: 10,
      isPrimary: true,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    })
    expect(computeOverlayLayouts([changed])[0].frame).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080
    })
  })

  it('重复 displayId 防御：保留首次出现的一项，不重复建窗', () => {
    const first = makeDisplay({
      id: 10,
      isPrimary: true,
      workArea: { x: 0, y: 25, width: 1920, height: 1055 }
    })
    const duplicate = makeDisplay({
      id: 10,
      isPrimary: false,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    })

    const layouts = computeOverlayLayouts([first, duplicate])

    expect(layouts).toHaveLength(1)
    expect(layouts[0]).toEqual({
      displayId: 10,
      frame: { x: 0, y: 25, width: 1920, height: 1055 },
      isPrimary: true
    })
  })

  it('无主屏标记时全部为 false（主屏 fallback 由 overlay-manager 负责）', () => {
    const layouts = computeOverlayLayouts([
      makeDisplay({ id: 1 }),
      makeDisplay({ id: 2 })
    ])
    expect(layouts.every((layout) => layout.isPrimary === false)).toBe(true)
  })

  it('返回的 frame 是显式拷贝：修改布局不污染显示器快照（持续 sync 复用同一快照时安全）', () => {
    const display = makeDisplay({ id: 10, isPrimary: true })
    const snapshot = JSON.parse(JSON.stringify(display)) as DisplayInfo

    const layouts = computeOverlayLayouts([display])
    layouts[0].frame.x = -999
    layouts[0].frame.width = 1

    expect(display.workArea).toEqual(snapshot.workArea)
    expect(display.workArea.x).toBe(0)
    expect(display.workArea.width).toBe(1920)
  })
})
