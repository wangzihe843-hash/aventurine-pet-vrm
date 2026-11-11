/**
 * 单测：B5 桌面感知 —— 坐标换算 / 显示器差集 / 表面几何（`desktop/geometry.ts`）。
 *
 * 覆盖 docs/wave2-integration.md §1 坐标口径与 PLAN §11：
 * - 全局 → overlay 本地换算（overlay 原点 y=30 等；负坐标/NaN 不抛）；
 * - display.bounds / display.workArea 差集 → 菜单栏 / 底部·侧边 Dock（不硬编码高度）；
 * - 菜单栏自动隐藏（workArea.y === bounds.y）→ 不生成 menubar；
 * - screen-bottom 地面总是提供；
 * - window-top / window-side 表面 rect（1px 占位、top = 本地窗口上沿）。
 */
import { describe, expect, it } from 'vitest'

import type { DisplayInfo, Rect, WindowInfo } from '../src/shared/types'
import {
  computeDisplayInsets,
  createWindowSurfaces,
  DOCK_BOTTOM_SURFACE_ID,
  DOCK_LEFT_SURFACE_ID,
  DOCK_RIGHT_SURFACE_ID,
  deriveSystemSurfaces,
  globalToLocalPoint,
  globalToLocalRect,
  MENUBAR_SURFACE_ID,
  rectsIntersect,
  sanitizeDisplayInfo,
  sanitizeRect,
  SCREEN_BOTTOM_SURFACE_ID
} from '../src/renderer/src/desktop/geometry'

/** 构造窗口测试数据。 */
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

/** 1080p 主屏：bounds 全屏，workArea 因菜单栏(30) + Dock(89) 变成 {0,30,1920,961}。 */
const PRIMARY_DISPLAY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 30, width: 1920, height: 961 },
  scaleFactor: 1,
  isPrimary: true
}

describe('坐标换算：global → overlay 本地', () => {
  it('点换算：overlay 原点 y=30 时 y 减 30', () => {
    expect(globalToLocalPoint({ x: 50, y: 80 }, { x: 0, y: 30 })).toEqual({ x: 50, y: 50 })
    expect(globalToLocalPoint({ x: 0, y: 30 }, { x: 0, y: 30 })).toEqual({ x: 0, y: 0 })
  })

  it('矩形换算：只平移原点，宽高不变', () => {
    expect(globalToLocalRect({ x: 100, y: 130, width: 800, height: 600 }, { x: 0, y: 30 })).toEqual({
      x: 100,
      y: 100,
      width: 800,
      height: 600
    })
  })

  it('overlay 原点 (0,0) 时是恒等换算', () => {
    const rect: Rect = { x: 25, y: 35, width: 300, height: 200 }
    expect(globalToLocalRect(rect, { x: 0, y: 0 })).toEqual(rect)
  })

  it('负坐标（窗口在屏幕左上方外）合法保留', () => {
    expect(globalToLocalPoint({ x: -40, y: -10 }, { x: 0, y: 30 })).toEqual({
      x: -40,
      y: -40
    })
    expect(
      globalToLocalRect({ x: -200, y: 80, width: 500, height: 600 }, { x: 0, y: 30 })
    ).toEqual({ x: -200, y: 50, width: 500, height: 600 })
  })

  it('NaN / Infinity 输入不抛，逐字段兜底为 0', () => {
    const dirty = {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: Number.NaN,
      height: -5
    } as unknown as Rect
    expect(() => globalToLocalRect(dirty, { x: 0, y: 30 })).not.toThrow()
    expect(globalToLocalRect(dirty, { x: 0, y: 30 })).toEqual({
      x: 0,
      y: -30,
      width: 0,
      height: 0
    })
  })

  it('sanitizeRect：非法字段回退 fallback，负宽高钳制 0', () => {
    expect(
      sanitizeRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY } as unknown as Rect, {
        x: 5,
        y: 6,
        width: 7,
        height: 8
      })
    ).toEqual({ x: 5, y: 6, width: 7, height: 8 })
    expect(sanitizeRect({ x: -5, y: -6, width: -1, height: -2 } as unknown as Rect)).toEqual({
      x: -5,
      y: -6,
      width: 0,
      height: 0
    })
  })
})

describe('rectsIntersect（多屏过滤用）', () => {
  const screen: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

  it('相交 / 包含为真，相离 / 边缘相触为假', () => {
    expect(rectsIntersect(screen, { x: 50, y: 50, width: 100, height: 100 })).toBe(true)
    expect(rectsIntersect(screen, { x: 100, y: 100, width: 5000, height: 5000 })).toBe(true)
    expect(rectsIntersect(screen, { x: 1920, y: 0, width: 100, height: 100 })).toBe(false)
    expect(rectsIntersect(screen, { x: 2500, y: 0, width: 100, height: 100 })).toBe(false)
    expect(rectsIntersect(screen, { x: -100, y: 100, width: 50, height: 100 })).toBe(false)
  })

  it('部分重叠（左半在屏外）为真', () => {
    expect(rectsIntersect(screen, { x: -200, y: 100, width: 500, height: 600 })).toBe(true)
  })

  it('零/负尺寸视为不相交', () => {
    expect(rectsIntersect(screen, { x: 100, y: 100, width: 0, height: 100 })).toBe(false)
    expect(rectsIntersect({ x: 0, y: 0, width: 0, height: 0 }, screen)).toBe(false)
  })
})

describe('computeDisplayInsets（bounds 与 workArea 差集）', () => {
  it('1080p 主屏：上差 30（菜单栏）、下差 89（Dock）', () => {
    expect(computeDisplayInsets(PRIMARY_DISPLAY.bounds, PRIMARY_DISPLAY.workArea)).toEqual({
      top: 30,
      bottom: 89,
      left: 0,
      right: 0
    })
  })

  it('菜单栏自动隐藏（workArea.y = bounds.y）→ 上差 0', () => {
    expect(
      computeDisplayInsets(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 993 }
      )
    ).toEqual({ top: 0, bottom: 87, left: 0, right: 0 })
  })

  it('Dock 在左侧 / 右侧 → 左差 / 右差，下差 0', () => {
    expect(
      computeDisplayInsets(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 80, y: 30, width: 1840, height: 1050 }
      )
    ).toEqual({ top: 30, bottom: 0, left: 80, right: 0 })
    expect(
      computeDisplayInsets(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 30, width: 1840, height: 1050 }
      )
    ).toEqual({ top: 30, bottom: 0, left: 0, right: 80 })
  })

  it('Dock + 菜单栏都自动隐藏 → 四周差集 0', () => {
    expect(
      computeDisplayInsets(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1080 }
      )
    ).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  })

  it('workArea 比 bounds 大（异常）→ 负差钳制 0，不抛', () => {
    expect(
      computeDisplayInsets(
        { x: 0, y: 0, width: 1000, height: 800 },
        { x: -10, y: -10, width: 1020, height: 820 }
      )
    ).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  })

  it('NaN 输入 → 全 0，不抛', () => {
    const dirty = { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN } as Rect
    expect(() => computeDisplayInsets(dirty, dirty)).not.toThrow()
    expect(computeDisplayInsets(dirty, dirty)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  })
})

describe('deriveSystemSurfaces（菜单栏 / Dock / 地面）', () => {
  it('1080p 主屏本地坐标：menubar(0) → dock-bottom(961) → screen-bottom(961)', () => {
    const surfaces = deriveSystemSurfaces(
      { x: 0, y: -30, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 961 }
    )
    expect(surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_BOTTOM_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    expect(surfaces.map((surface) => surface.kind)).toEqual(['menubar', 'dock', 'screen-bottom'])
    const [menubar, dock, ground] = surfaces
    expect(menubar.top).toBe(0)
    expect(menubar.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1 })
    expect(menubar.sittable).toBe(true)
    expect(dock.top).toBe(961)
    expect(dock.rect).toEqual({ x: 0, y: 961, width: 1920, height: 1 })
    expect(ground.top).toBe(961)
    expect(ground.sittable).toBe(true)
    expect(ground.climbable).toBe(false)
  })

  it('菜单栏自动隐藏：不生成 menubar，地面贴 workArea 底边', () => {
    const surfaces = deriveSystemSurfaces(
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 993 }
    )
    expect(surfaces.map((surface) => surface.id)).toEqual([
      DOCK_BOTTOM_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    expect(surfaces.some((surface) => surface.kind === 'menubar')).toBe(false)
    expect(surfaces[1].top).toBe(993)
  })

  it('Dock 自动隐藏：不生成 dock 表面，地面即屏幕底边', () => {
    const surfaces = deriveSystemSurfaces(
      { x: 0, y: -30, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1050 }
    )
    expect(surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    expect(surfaces[1].top).toBe(1050)
  })

  it('左侧 Dock：dock-left 竖条可坐可爬', () => {
    const surfaces = deriveSystemSurfaces(
      { x: 0, y: -30, width: 1920, height: 1080 },
      { x: 80, y: 0, width: 1840, height: 1050 }
    )
    expect(surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_LEFT_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    const dockLeft = surfaces[1]
    expect(dockLeft.kind).toBe('dock')
    expect(dockLeft.rect).toEqual({ x: 80, y: 0, width: 1, height: 1050 })
    expect(dockLeft.top).toBe(0)
    expect(dockLeft.sittable).toBe(true)
    expect(dockLeft.climbable).toBe(true)
  })

  it('右侧 Dock：dock-right 贴 workArea 右边缘', () => {
    const surfaces = deriveSystemSurfaces(
      { x: 0, y: -30, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1840, height: 1050 }
    )
    expect(surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_RIGHT_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    expect(surfaces[1].rect).toEqual({ x: 1839, y: 0, width: 1, height: 1050 })
  })

  it('地面总是提供（四周差集为 0 时只剩 screen-bottom）', () => {
    const surfaces = deriveSystemSurfaces(
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1080 }
    )
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].id).toBe(SCREEN_BOTTOM_SURFACE_ID)
    expect(surfaces[0].top).toBe(1080)
  })

  it('退化输入（undefined / null）不抛，仍返回 screen-bottom', () => {
    expect(() =>
      deriveSystemSurfaces(undefined as unknown as Rect, null as unknown as Rect)
    ).not.toThrow()
    const surfaces = deriveSystemSurfaces(undefined as unknown as Rect, null as unknown as Rect)
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].id).toBe(SCREEN_BOTTOM_SURFACE_ID)
  })
})

describe('createWindowSurfaces（窗口 → window-top / window-side）', () => {
  it('全局窗口 bounds 换算为本地 top / left / right 表面', () => {
    const surfaces = createWindowSurfaces(makeWindow(), { x: 0, y: 30 })
    expect(surfaces.map((surface) => surface.id)).toEqual([
      'win-42-top',
      'win-42-left',
      'win-42-right'
    ])
    const [top, left, right] = surfaces
    expect(top.kind).toBe('window-top')
    expect(top.windowId).toBe(42)
    expect(top.top).toBe(100)
    expect(top.rect).toEqual({ x: 100, y: 100, width: 800, height: 1 })
    expect(top.sittable).toBe(true)
    expect(top.climbable).toBe(false)
    expect(left.kind).toBe('window-side')
    expect(left.rect).toEqual({ x: 100, y: 100, width: 1, height: 600 })
    expect(left.sittable).toBe(false)
    expect(left.climbable).toBe(true)
    expect(right.rect).toEqual({ x: 899, y: 100, width: 1, height: 600 })
  })

  it('origin (0,0) 时 top = 全局 y', () => {
    const surfaces = createWindowSurfaces(makeWindow(), { x: 0, y: 0 })
    expect(surfaces[0].top).toBe(130)
  })

  it('窗口部分在屏幕外（负坐标）照常生成表面', () => {
    const surfaces = createWindowSurfaces(
      makeWindow({ bounds: { x: -200, y: 80, width: 500, height: 600 } }),
      { x: 0, y: 30 }
    )
    expect(surfaces).toHaveLength(3)
    expect(surfaces[0].rect.x).toBe(-200)
    expect(surfaces[0].top).toBe(50)
  })

  it('零尺寸 / NaN bounds 返回空数组，不抛', () => {
    expect(
      createWindowSurfaces(
        makeWindow({ bounds: { x: 10, y: 10, width: 0, height: 500 } }),
        { x: 0, y: 30 }
      )
    ).toEqual([])
    const dirty = makeWindow({
      bounds: { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN } as Rect
    })
    expect(() => createWindowSurfaces(dirty, { x: 0, y: 30 })).not.toThrow()
    expect(createWindowSurfaces(dirty, { x: 0, y: 30 })).toEqual([])
  })
})

describe('sanitizeDisplayInfo（显示器输入防御）', () => {
  it('合法显示器原样保留（scaleFactor 缺失兜底 1）', () => {
    expect(sanitizeDisplayInfo(PRIMARY_DISPLAY)).toEqual(PRIMARY_DISPLAY)
    const partial = {
      id: 2,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    } as unknown as DisplayInfo
    expect(sanitizeDisplayInfo(partial)?.scaleFactor).toBe(1)
  })

  it('非法输入返回 null（调用方退化为「视口即工作区」）', () => {
    expect(sanitizeDisplayInfo(null)).toBeNull()
    expect(sanitizeDisplayInfo(undefined)).toBeNull()
    const noId = { ...PRIMARY_DISPLAY, id: Number.NaN }
    expect(sanitizeDisplayInfo(noId)).toBeNull()
    const badBounds = { ...PRIMARY_DISPLAY, bounds: { x: NaN, y: 0, width: 1, height: 1 } }
    expect(
      sanitizeDisplayInfo(badBounds as unknown as DisplayInfo)
    ).toBeNull()
  })
})
