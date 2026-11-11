/**
 * 单测：B5 桌面感知 —— `DesktopSensor`（`desktop/sensor.ts`）。
 *
 * 覆盖任务验收条款（docs/wave2-integration.md §3-B5 / PLAN §11）：
 * - 全局 → overlay 本地坐标（overlay 原点 y=30、负原点、窗口负坐标）；
 * - 过滤（layer/alpha/height/onScreen/ownPid/overlay id/其它显示器）；
 * - 前→后排序（前台窗口优先）、菜单栏 / Dock / 地面差集、Dock 在底 / 左侧；
 * - 菜单栏自动隐藏（workArea.y=0 → 无 menubar）；
 * - moved / closed / appeared 去重、一帧内 delta 合并、宽限期（切 Space 不误判关闭）；
 * - findSittableSurface 吸附阈值（<24px）、x 范围、窄窗口、多窗口 tiling；
 * - getClimbSurfaces / getTrackedWindowSurface；
 * - 窗口消失后 surfaces 更新；退化输入（空列表 / NaN / 非法环境）不抛。
 */
import { describe, expect, it } from 'vitest'

import type { DisplayInfo, WindowInfo } from '../src/shared/types'
import {
  DEFAULT_CLOSE_GRACE_MS,
  DEFAULT_SITTABLE_GAP_PX,
  DesktopSensor,
  DOCK_BOTTOM_SURFACE_ID,
  DOCK_LEFT_SURFACE_ID,
  DOCK_RIGHT_SURFACE_ID,
  MENUBAR_SURFACE_ID,
  SCREEN_BOTTOM_SURFACE_ID,
  type DesktopSensorEnvironment,
  type DesktopSensorOptions
} from '../src/renderer/src/desktop/index'

/** 1080p 主屏：bounds 全屏，workArea 因菜单栏(30) + Dock(89) = {0,30,1920,961}。 */
const PRIMARY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 30, width: 1920, height: 961 },
  scaleFactor: 1,
  isPrimary: true
}

/** overlay 主屏原点（主屏上 y 从 30 起，不是 0）。 */
const OVERLAY_ORIGIN = { x: 0, y: 30 }
/** overlay 视口（= workArea 尺寸）。 */
const VIEWPORT = { width: 1920, height: 961 }

/** 构造窗口测试数据（默认：全局 {100,130,800,600}、普通应用窗口）。 */
function makeWindow(
  id: number,
  bounds: Partial<WindowInfo['bounds']> = {},
  overrides: Partial<WindowInfo> = {}
): WindowInfo {
  return {
    id,
    pid: 100,
    owner: `app-${id}`,
    layer: 0,
    alpha: 1,
    bounds: { x: 100, y: 130, width: 800, height: 600, ...bounds },
    onScreen: true,
    ...overrides
  }
}

/** 构造已初始化环境（或故意不初始化）的 sensor。 */
function createSensor(
  options: DesktopSensorOptions = {},
  environment: Partial<DesktopSensorEnvironment> | null = {}
): DesktopSensor {
  const sensor = new DesktopSensor(options)
  if (environment !== null) {
    sensor.updateEnvironment({
      overlayOrigin: OVERLAY_ORIGIN,
      display: PRIMARY,
      viewport: VIEWPORT,
      ownPid: 999,
      ...environment
    })
  }
  return sensor
}

/** 从快照里按 id 取表面。 */
function surfaceById(
  snapshot: { surfaces: { id: string; top: number }[] },
  id: string
): { id: string; top: number } | undefined {
  return snapshot.surfaces.find((surface) => surface.id === id)
}

describe('环境与坐标', () => {
  it('默认参数与契约口径一致', () => {
    expect(DEFAULT_SITTABLE_GAP_PX).toBe(24)
    expect(DEFAULT_CLOSE_GRACE_MS).toBe(600)
  })

  it('未 updateEnvironment 时 snapshot 返回空表面 / 零矩形，不抛', () => {
    const sensor = new DesktopSensor()
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces).toEqual([])
    expect(snapshot.transitions).toEqual([])
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(snapshot.screenBounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('环境更新：workArea / screenBounds 换算为 overlay 本地坐标', () => {
    const sensor = createSensor()
    const snapshot = sensor.snapshot(0)
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 1920, height: 961 })
    expect(snapshot.screenBounds).toEqual({ x: 0, y: -30, width: 1920, height: 1080 })
  })

  it('基准表面：menubar(0) → dock-bottom(961) → screen-bottom(961)', () => {
    const sensor = createSensor()
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_BOTTOM_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    expect(surfaceById(snapshot, MENUBAR_SURFACE_ID)?.top).toBe(0)
    expect(surfaceById(snapshot, DOCK_BOTTOM_SURFACE_ID)?.top).toBe(961)
    expect(surfaceById(snapshot, SCREEN_BOTTOM_SURFACE_ID)?.top).toBe(961)
  })

  it('窗口 top 表面：全局 {100,130} − overlay 原点 {0,30} → 本地 y=100', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    const snapshot = sensor.snapshot(0)
    const top = snapshot.surfaces.find((surface) => surface.id === 'win-42-top')
    expect(top).toBeDefined()
    expect(top?.top).toBe(100)
    expect(top?.rect.x).toBe(100)
    expect(top?.windowId).toBe(42)
  })

  it('负 overlay 原点：local = global − (−100,−50)', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: { x: -100, y: -50 },
      display: PRIMARY,
      viewport: VIEWPORT,
      ownPid: 999
    })
    sensor.updateWindows([makeWindow(42)], 0)
    const snapshot = sensor.snapshot(0)
    expect(snapshot.screenBounds).toEqual({ x: 100, y: 50, width: 1920, height: 1080 })
    expect(snapshot.workArea).toEqual({ x: 100, y: 80, width: 1920, height: 961 })
    const top = snapshot.surfaces.find((surface) => surface.id === 'win-42-top')
    expect(top?.top).toBe(180)
    expect(top?.rect.x).toBe(200)
  })

  it('窗口部分在屏幕外（负 x）仍生成表面', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(9, { x: -200, y: 80, width: 500, height: 600 })], 0)
    const snapshot = sensor.snapshot(0)
    const top = snapshot.surfaces.find((surface) => surface.id === 'win-9-top')
    expect(top?.rect.x).toBe(-200)
    expect(top?.top).toBe(50)
  })
})

describe('窗口变化事件（transitions）', () => {
  it('首份窗口列表只做基线，不产生 appeared', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    expect(sensor.snapshot(0).transitions).toEqual([])
  })

  it('相同列表重复更新不产生事件', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([makeWindow(42)], 100)
    expect(sensor.snapshot(100).transitions).toEqual([])
  })

  it('新窗口 → appeared 只报一次；snapshot 后清空', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([makeWindow(42), makeWindow(7, { x: 500 })], 100)
    const first = sensor.snapshot(100)
    expect(first.transitions).toEqual([{ kind: 'appeared', windowId: 7 }])
    expect(first.surfaces.some((surface) => surface.id === 'win-7-top')).toBe(true)
    expect(sensor.snapshot(200).transitions).toEqual([])
  })

  it('appeared + 同帧重复更新仍只报一次（去重）', () => {
    const sensor = createSensor()
    sensor.updateWindows([], 0)
    sensor.updateWindows([makeWindow(7)], 100)
    sensor.updateWindows([makeWindow(7)], 200)
    expect(sensor.snapshot(200).transitions).toEqual([{ kind: 'appeared', windowId: 7 }])
  })

  it('窗口移动 → moved{delta}（全局差 = 本地差），表面同步更新', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([makeWindow(42, { y: 190 })], 100)
    const snapshot = sensor.snapshot(100)
    expect(snapshot.transitions).toEqual([
      { kind: 'moved', windowId: 42, delta: { x: 0, y: 60 } }
    ])
    expect(snapshot.surfaces.find((surface) => surface.id === 'win-42-top')?.top).toBe(160)
  })

  it('一帧内多次移动 → 单个 moved，delta 相加', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([makeWindow(42, { y: 140 })], 100)
    sensor.updateWindows([makeWindow(42, { y: 145, x: 110 })], 200)
    const snapshot = sensor.snapshot(200)
    expect(snapshot.transitions).toEqual([
      { kind: 'moved', windowId: 42, delta: { x: 10, y: 15 } }
    ])
  })

  it('仅尺寸变化 → moved delta {0,0}（表面拓扑变化需要重评估）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([makeWindow(42, { height: 700 })], 100)
    expect(sensor.snapshot(100).transitions).toEqual([
      { kind: 'moved', windowId: 42, delta: { x: 0, y: 0 } }
    ])
  })

  it('moved + closed 同帧 → 只报 closed（最终结果）', () => {
    const sensor = createSensor({ closeGraceMs: 0 })
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([makeWindow(42, { y: 190 })], 100)
    sensor.updateWindows([], 100)
    const snapshot = sensor.snapshot(100)
    expect(snapshot.transitions).toEqual([{ kind: 'closed', windowId: 42 }])
    expect(snapshot.surfaces.some((surface) => surface.windowId === 42)).toBe(false)
  })

  it('appeared + closed 同帧 → 净效果取消', () => {
    const sensor = createSensor({ closeGraceMs: 0 })
    sensor.updateWindows([], 0)
    sensor.updateWindows([makeWindow(7)], 100)
    sensor.updateWindows([], 100)
    expect(sensor.snapshot(100).transitions).toEqual([])
  })
})

describe('宽限期（最小化 / 切 Space 去抖）', () => {
  it('默认 600ms 宽限：暂时消失保留表面，超时才 closed', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([], 1000)

    const during = sensor.snapshot(1000)
    expect(during.transitions).toEqual([])
    expect(during.surfaces.some((surface) => surface.id === 'win-42-top')).toBe(true)

    const justBefore = sensor.snapshot(1599)
    expect(justBefore.transitions).toEqual([])
    expect(justBefore.surfaces.some((surface) => surface.id === 'win-42-top')).toBe(true)

    const expired = sensor.snapshot(1600)
    expect(expired.transitions).toEqual([{ kind: 'closed', windowId: 42 }])
    expect(expired.surfaces.some((surface) => surface.id === 'win-42-top')).toBe(false)
  })

  it('宽限内原样回来 → 无事件、表面连续（不误报 appeared/closed）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([], 1000)
    sensor.updateWindows([makeWindow(42)], 1200)
    const snapshot = sensor.snapshot(1200)
    expect(snapshot.transitions).toEqual([])
    expect(snapshot.surfaces.some((surface) => surface.id === 'win-42-top')).toBe(true)
  })

  it('宽限内换个位置回来 → moved（跟随新位置）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([], 1000)
    sensor.updateWindows([makeWindow(42, { y: 200 })], 1200)
    const snapshot = sensor.snapshot(1200)
    expect(snapshot.transitions).toEqual([
      { kind: 'moved', windowId: 42, delta: { x: 0, y: 70 } }
    ])
    expect(snapshot.surfaces.find((surface) => surface.id === 'win-42-top')?.top).toBe(170)
  })

  it('closeGraceMs:0 → 下一次 snapshot 立即确认关闭，之后不再重复报', () => {
    const sensor = createSensor({ closeGraceMs: 0 })
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([], 1000)
    expect(sensor.snapshot(1000).transitions).toEqual([{ kind: 'closed', windowId: 42 }])
    expect(sensor.snapshot(1100).transitions).toEqual([])
  })

  it('宽限期内窗口顶边保留几何供 B2 支撑，但 sittable=false（N-5）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([], 1000) // 42 从列表消失（最小化 / 切 Space）→ 宽限期
    const snapshot = sensor.snapshot(1000)
    const top = snapshot.surfaces.find((surface) => surface.id === 'win-42-top')
    expect(top).toBeDefined()
    // 几何完整（B2 用：top/rect 不变，站在上面的宠物不会误掉）
    expect(top!.top).toBe(100)
    expect(top!.rect).toEqual({ x: 100, y: 100, width: 800, height: 1 })
    expect(top!.sittable).toBe(false)
    // B1 便利方法不会把它当新的坐目标（否则 600ms 宽限内可能「虚空坐下」）
    expect(sensor.findSittableSurface({ x: 500, y: 100 }, { width: 400, height: 540 })).toBeNull()
  })

  it('宽限后窗口回到列表 → 顶边恢复可坐（N-5 只作用于不可见期间）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateWindows([], 1000)
    expect(
      sensor.snapshot(1000).surfaces.find((surface) => surface.id === 'win-42-top')?.sittable
    ).toBe(false)
    sensor.updateWindows([makeWindow(42)], 1200)
    const back = sensor.snapshot(1200)
    expect(back.surfaces.find((surface) => surface.id === 'win-42-top')?.sittable).toBe(true)
    expect(
      sensor.findSittableSurface({ x: 500, y: 100 }, { width: 400, height: 540 })?.id
    ).toBe('win-42-top')
  })
})

describe('过滤（经 sensor 消费）', () => {
  it('layer / alpha / height / ownPid / 其它显示器 / NaN bounds 均被过滤', () => {
    const sensor = createSensor()
    sensor.updateWindows([], 0)
    sensor.updateWindows(
      [
        makeWindow(1, {}, { layer: 25 }), // 菜单栏层
        makeWindow(2, {}, { alpha: 0.005 }), // 不可见
        makeWindow(3, { height: 60 }), // 小工具窗
        makeWindow(4, {}, { pid: 999 }), // 自身进程
        makeWindow(5, { x: 2500 }), // 其它显示器
        makeWindow(6, { x: Number.NaN }) // 脏数据，sanitize 丢弃
      ],
      100
    )
    const snapshot = sensor.snapshot(100)
    expect(snapshot.surfaces.filter((surface) => surface.kind === 'window-top')).toEqual([])
    expect(snapshot.transitions).toEqual([])
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_BOTTOM_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
  })

  it('overlayWindowIds 排除自身 overlay 窗口（ownPid 之外的第二保险）', () => {
    const sensor = createSensor({}, { overlayWindowIds: [42] })
    sensor.updateWindows([], 0)
    sensor.updateWindows([makeWindow(42)], 100)
    expect(
      sensor.snapshot(100).surfaces.filter((surface) => surface.windowId !== undefined)
    ).toEqual([])
  })
})

describe('表面排序与 findSittableSurface（吸附阈值 / 前台优先 / tiling）', () => {
  it('窗口表面前→后按列表顺序，系统表面排在最后', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(2), makeWindow(3, { x: 500 })], 0)
    const ids = sensor
      .snapshot(0)
      .surfaces.filter((surface) => surface.windowId !== undefined)
      .map((surface) => surface.id)
    expect(ids).toEqual([
      'win-2-top',
      'win-2-left',
      'win-2-right',
      'win-3-top',
      'win-3-left',
      'win-3-right'
    ])
  })

  it('同类表面重叠时优先前台窗口（列表前者）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(2), makeWindow(3)], 0)
    const found = sensor.findSittableSurface({ x: 500, y: 100 }, { width: 400, height: 540 })
    expect(found?.windowId).toBe(2)
    expect(found?.id).toBe('win-2-top')
  })

  it('吸附阈值：|feet.y − top| < 24px（23.9 命中、24.1 不中）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    const petSize = { width: 400, height: 540 }
    expect(sensor.findSittableSurface({ x: 500, y: 123.9 }, petSize)?.windowId).toBe(42)
    expect(sensor.findSittableSurface({ x: 500, y: 124.1 }, petSize)).toBeNull()
    expect(sensor.findSittableSurface({ x: 500, y: 76.1 }, petSize)?.windowId).toBe(42)
  })

  it('x 范围：脚底必须落在表面矩形水平范围内（边界含）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    const petSize = { width: 400, height: 540 }
    expect(sensor.findSittableSurface({ x: 99, y: 100 }, petSize)).toBeNull()
    expect(sensor.findSittableSurface({ x: 100, y: 100 }, petSize)?.windowId).toBe(42)
    expect(sensor.findSittableSurface({ x: 900, y: 100 }, petSize)?.windowId).toBe(42)
    expect(sensor.findSittableSurface({ x: 901, y: 100 }, petSize)).toBeNull()
  })

  it('窄窗口：小于宠物宽度一半不作为可坐面', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(11, { x: 100, y: 130, width: 100, height: 600 })], 0)
    expect(
      sensor.findSittableSurface({ x: 150, y: 100 }, { width: 400, height: 540 })
    ).toBeNull()
    expect(
      sensor.findSittableSurface({ x: 150, y: 100 }, { width: 100, height: 540 })?.windowId
    ).toBe(11)
  })

  it('多窗口 tiling：不同高度的窗口各自命中', () => {
    const sensor = createSensor()
    sensor.updateWindows(
      [makeWindow(42), makeWindow(43, { x: 600, y: 700, width: 800, height: 600 })],
      0
    )
    const petSize = { width: 400, height: 540 }
    // 2026-11-08 遮挡裁剪：42 在前层，盖住了 43 顶边的 x=100..900；43 只剩 x>=900 的可见顶边。
    expect(sensor.findSittableSurface({ x: 700, y: 670 }, petSize)?.windowId).toBeUndefined()
    expect(sensor.findSittableSurface({ x: 1000, y: 670 }, petSize)?.windowId).toBe(43)
    expect(sensor.findSittableSurface({ x: 500, y: 100 }, petSize)?.windowId).toBe(42)
  })

  it('可见性：被前层窗口完全遮住顶边的窗口不可坐（不能虚空坐）', () => {
    const sensor = createSensor()
    // 前层 fullscreen 窗口（id 1）盖住整个屏幕；后层窗口（id 2）的顶边被完全遮挡。
    sensor.updateWindows(
      [makeWindow(1, { x: 0, y: 30, width: 1920, height: 900 }), makeWindow(2, { x: 200, y: 500, width: 800, height: 400 })],
      0
    )
    const snapshot = sensor.snapshot(0)
    const behindTop = snapshot.surfaces.filter(
      (surface) => surface.windowId === 2 && surface.kind === 'window-top'
    )
    expect(behindTop).toHaveLength(0)
    // 前层窗口自己的顶边可见，仍可坐。
    expect(
      snapshot.surfaces.some((surface) => surface.windowId === 1 && surface.kind === 'window-top')
    ).toBe(true)
  })

  it('可见性：顶边只露出一段时，window-top 表面被裁剪到可见区间', () => {
    const sensor = createSensor()
    sensor.updateWindows(
      [makeWindow(1, { x: 0, y: 30, width: 600, height: 900 }), makeWindow(2, { x: 200, y: 500, width: 1000, height: 400 })],
      0
    )
    const snapshot = sensor.snapshot(0)
    const tops = snapshot.surfaces.filter(
      (surface) => surface.windowId === 2 && surface.kind === 'window-top'
    )
    expect(tops).toHaveLength(1)
    // 全局 x=200..1200，被前层盖住 x=200..600 → 可见 x=600..1200（本地坐标 = 全局 - overlayOrigin.x=0）
    expect(tops[0]!.rect.x).toBe(600)
    expect(tops[0]!.rect.width).toBe(600)
  })

  it('菜单栏（top=0）/ Dock（top=961）可坐', () => {
    const sensor = createSensor()
    const petSize = { width: 400, height: 540 }
    expect(sensor.findSittableSurface({ x: 500, y: 0 }, petSize)?.id).toBe(MENUBAR_SURFACE_ID)
    expect(sensor.findSittableSurface({ x: 500, y: 961 }, petSize)?.id).toBe(
      DOCK_BOTTOM_SURFACE_ID
    )
  })

  it('Dock 自动隐藏时无 dock 表面，底部由 screen-bottom 兜底', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: OVERLAY_ORIGIN,
      display: { ...PRIMARY, workArea: { x: 0, y: 30, width: 1920, height: 1050 } },
      viewport: { width: 1920, height: 1050 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.some((surface) => surface.kind === 'dock')).toBe(false)
    expect(
      sensor.findSittableSurface({ x: 500, y: 1050 }, { width: 400, height: 540 })?.id
    ).toBe(SCREEN_BOTTOM_SURFACE_ID)
  })

  it('未初始化环境 / NaN 脚底 → null，不抛', () => {
    const empty = new DesktopSensor()
    expect(empty.findSittableSurface({ x: 0, y: 0 }, { width: 100, height: 100 })).toBeNull()
    const sensor = createSensor()
    expect(
      sensor.findSittableSurface({ x: Number.NaN, y: Number.NaN }, { width: 100, height: 100 })
    ).toBeNull()
  })
})

describe('菜单栏 / Dock 差集（经 sensor）', () => {
  it('菜单栏自动隐藏（workArea.y=0）→ 不生成 menubar，地面贴新底边', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: { x: 0, y: 0 },
      display: {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 993 },
        scaleFactor: 1,
        isPrimary: true
      },
      viewport: { width: 1920, height: 993 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.some((surface) => surface.kind === 'menubar')).toBe(false)
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 1920, height: 993 })
    expect(surfaceById(snapshot, SCREEN_BOTTOM_SURFACE_ID)?.top).toBe(993)
  })

  it('Dock 在左侧：dock-left 可坐可爬，workArea 本地坐标从 0 开始', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: { x: 80, y: 30 },
      display: {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 80, y: 30, width: 1840, height: 1050 },
        scaleFactor: 1,
        isPrimary: true
      },
      viewport: { width: 1840, height: 1050 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(0)
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 1840, height: 1050 })
    expect(snapshot.screenBounds).toEqual({ x: -80, y: -30, width: 1920, height: 1080 })
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_LEFT_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    const dockLeft = snapshot.surfaces.find((surface) => surface.id === DOCK_LEFT_SURFACE_ID)
    expect(dockLeft?.rect.x).toBe(0)
    expect(dockLeft?.sittable).toBe(true)
    expect(dockLeft?.climbable).toBe(true)
    expect(sensor.getClimbSurfaces().map((surface) => surface.id)).toEqual([
      DOCK_LEFT_SURFACE_ID
    ])
  })

  it('Dock 在右侧：dock-right 贴 workArea 右边缘', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: OVERLAY_ORIGIN,
      display: { ...PRIMARY, workArea: { x: 0, y: 30, width: 1840, height: 1050 } },
      viewport: { width: 1840, height: 1050 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_RIGHT_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
    expect(
      snapshot.surfaces.find((surface) => surface.id === DOCK_RIGHT_SURFACE_ID)?.rect.x
    ).toBe(1839)
  })

  it('Dock 自动隐藏（workArea 到 bounds 底边）→ 无 dock，地面即底边', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: OVERLAY_ORIGIN,
      display: { ...PRIMARY, workArea: { x: 0, y: 30, width: 1920, height: 1050 } },
      viewport: { width: 1920, height: 1050 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
  })

  it('环境变化（workArea 改变）→ 表面/矩形跟随，且不产生事件噪声', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    expect(sensor.snapshot(0).surfaces.some((s) => s.id === DOCK_BOTTOM_SURFACE_ID)).toBe(true)

    sensor.updateEnvironment({
      overlayOrigin: OVERLAY_ORIGIN,
      display: { ...PRIMARY, workArea: { x: 0, y: 30, width: 1920, height: 1050 } },
      viewport: { width: 1920, height: 1050 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(100)
    expect(snapshot.transitions).toEqual([])
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 1920, height: 1050 })
    expect(snapshot.surfaces.some((s) => s.id === DOCK_BOTTOM_SURFACE_ID)).toBe(false)
    expect(surfaceById(snapshot, SCREEN_BOTTOM_SURFACE_ID)?.top).toBe(1050)
    expect(snapshot.surfaces.some((s) => s.id === 'win-42-top')).toBe(true)
  })
})

describe('可爬表面 / 跟随窗口', () => {
  it('getClimbSurfaces：窗口左右边缘可爬（window-side）', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    const climb = sensor.getClimbSurfaces()
    expect(climb.map((surface) => surface.id)).toEqual(['win-42-left', 'win-42-right'])
    expect(climb.every((surface) => surface.kind === 'window-side')).toBe(true)
    expect(climb.every((surface) => surface.climbable)).toBe(true)
  })

  it('两个窗口 → 4 条可爬边缘', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(2), makeWindow(3, { x: 500 })], 0)
    expect(sensor.getClimbSurfaces()).toHaveLength(4)
  })

  it('getTrackedWindowSurface：按 id 取 top 表面，移动后坐标更新，未知 id → null', () => {
    const sensor = createSensor()
    expect(sensor.getTrackedWindowSurface(42)).toBeNull()
    sensor.updateWindows([makeWindow(42)], 0)
    expect(sensor.getTrackedWindowSurface(42)?.top).toBe(100)
    sensor.updateWindows([makeWindow(42, { y: 190 })], 100)
    expect(sensor.getTrackedWindowSurface(42)?.top).toBe(160)
    expect(sensor.getTrackedWindowSurface(999)).toBeNull()
  })

  it('未初始化环境时 getTrackedWindowSurface → null', () => {
    const sensor = new DesktopSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    expect(sensor.getTrackedWindowSurface(42)).toBeNull()
  })
})

describe('环境变化 / 退化输入（不抛）', () => {
  it('显示器变化（窗口不再属于当前屏）→ 静默重建基线，不报 closed', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateEnvironment({
      overlayOrigin: { x: 2000, y: 30 },
      display: {
        id: 2,
        bounds: { x: 2000, y: 0, width: 1920, height: 1080 },
        workArea: { x: 2000, y: 30, width: 1920, height: 961 },
        scaleFactor: 1,
        isPrimary: false
      },
      viewport: VIEWPORT,
      ownPid: 999
    })
    const snapshot = sensor.snapshot(100)
    expect(snapshot.transitions).toEqual([])
    expect(snapshot.surfaces.some((surface) => surface.windowId === 42)).toBe(false)
  })

  it('环境无实际变化时是 no-op：不重置基线，后续 appeared 正常', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(42)], 0)
    sensor.updateEnvironment({
      overlayOrigin: OVERLAY_ORIGIN,
      display: PRIMARY,
      viewport: VIEWPORT,
      ownPid: 999
    })
    sensor.updateWindows([makeWindow(42), makeWindow(7, { x: 500 })], 100)
    expect(sensor.snapshot(100).transitions).toEqual([{ kind: 'appeared', windowId: 7 }])
  })

  it('非法环境输入：空对象不抛，退化为「视口即工作区」，仍有地面', () => {
    const sensor = new DesktopSensor()
    expect(() => sensor.updateEnvironment({} as DesktopSensorEnvironment)).not.toThrow()
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([SCREEN_BOTTOM_SURFACE_ID])
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('非法 display（NaN id）→ 退化为视口工作区 + 地面', () => {
    const sensor = new DesktopSensor()
    sensor.updateEnvironment({
      overlayOrigin: { x: 0, y: 30 },
      display: { id: Number.NaN } as unknown as DisplayInfo,
      viewport: { width: 1920, height: 961 },
      ownPid: 999
    })
    const snapshot = sensor.snapshot(0)
    expect(snapshot.workArea).toEqual({ x: 0, y: 0, width: 1920, height: 961 })
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([SCREEN_BOTTOM_SURFACE_ID])
    expect(snapshot.surfaces[0].top).toBe(961)
  })

  it('空列表 / null / NaN 时间：不抛且表面全部有限', () => {
    const sensor = createSensor()
    expect(() =>
      sensor.updateWindows(null as unknown as WindowInfo[], Number.NaN)
    ).not.toThrow()
    expect(() => sensor.snapshot(Number.NaN)).not.toThrow()
    const snapshot = sensor.snapshot(Number.NaN)
    expect(snapshot.surfaces.every((surface) => Number.isFinite(surface.top))).toBe(true)
    expect(snapshot.transitions).toEqual([])
    expect(snapshot.surfaces.map((surface) => surface.id)).toEqual([
      MENUBAR_SURFACE_ID,
      DOCK_BOTTOM_SURFACE_ID,
      SCREEN_BOTTOM_SURFACE_ID
    ])
  })

  it('空窗口列表：只剩系统表面；快照矩形仍是有限数', () => {
    const sensor = createSensor()
    sensor.updateWindows([], 0)
    const snapshot = sensor.snapshot(0)
    expect(snapshot.surfaces.filter((surface) => surface.kind === 'window-top')).toEqual([])
    expect(snapshot.surfaces.length).toBeGreaterThanOrEqual(3)
    expect(Number.isFinite(snapshot.workArea.width)).toBe(true)
  })
})

/* ========================================================================== */
/* findPlacementTarget（松手放置 → 窗口上沿）                                   */
/* ========================================================================== */

describe('findPlacementTarget：松手放置目标（窗口矩形 + 可见顶边）', () => {
  const PET = { width: 400, height: 540 }

  /** 以「宠物身体中心」构造摆放矩形（findPlacementTarget 用中心点判定压在哪个窗口上）。 */
  function petRectAt(centerX: number, centerY: number): {
    x: number
    y: number
    width: number
    height: number
  } {
    return {
      x: centerX - PET.width / 2,
      y: centerY - PET.height / 2,
      width: PET.width,
      height: PET.height
    }
  }

  it('宠物中心压在窗口内 → 返回窗口 id / 本地完整矩形 / 可见顶边表面', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(7, { x: 300, y: 400, width: 1200, height: 500 })], 0)
    const target = sensor.findPlacementTarget(petRectAt(900, 600))
    expect(target?.windowId).toBe(7)
    // 全局 {300,400} − overlayOrigin {0,30} → 本地 {300,370,1200,500}
    expect(target?.windowRect).toEqual({ x: 300, y: 370, width: 1200, height: 500 })
    expect(target?.topSurface?.id).toBe('win-7-top')
    expect(target?.topSurface?.top).toBe(370)
  })

  it('多个窗口重叠：返回列表最前（前台）的窗口', () => {
    const sensor = createSensor()
    sensor.updateWindows(
      [
        makeWindow(1, { x: 200, y: 200, width: 1200, height: 700 }),
        makeWindow(2, { x: 100, y: 150, width: 1600, height: 800 })
      ],
      0
    )
    expect(sensor.findPlacementTarget(petRectAt(900, 600))?.windowId).toBe(1)
  })

  it('顶边被前层完全遮挡 → topSurface=null（可用于原地站定，不能吸附坐）', () => {
    const sensor = createSensor()
    sensor.updateWindows(
      [
        // 前层只在顶边高度盖一条（不覆盖宠物中心点）
        makeWindow(1, { x: 200, y: 450, width: 1000, height: 100 }),
        makeWindow(2, { x: 200, y: 500, width: 1000, height: 500 })
      ],
      0
    )
    const target = sensor.findPlacementTarget(petRectAt(700, 700))
    expect(target?.windowId).toBe(2)
    expect(target?.topSurface).toBeNull()
  })

  it('顶边只露一段且宠物横向压到可见段 → 返回该可见段', () => {
    const sensor = createSensor()
    sensor.updateWindows(
      [
        makeWindow(1, { x: 0, y: 30, width: 600, height: 900 }),
        makeWindow(2, { x: 200, y: 500, width: 1000, height: 400 })
      ],
      0
    )
    // 窗口 2 的顶边全局 y=500，被前层盖住 x=200..600 → 可见段 x=600..1200（本地 y=470）
    const target = sensor.findPlacementTarget(petRectAt(900, 700))
    expect(target?.windowId).toBe(2)
    expect(target?.topSurface?.rect.x).toBe(600)
    expect(target?.topSurface?.rect.width).toBe(600)
  })

  it('宠物中心落在桌面（无窗口）→ null', () => {
    const sensor = createSensor()
    sensor.updateWindows([makeWindow(1, { x: 0, y: 30, width: 400, height: 500 })], 0)
    expect(sensor.findPlacementTarget(petRectAt(1600, 800))).toBeNull()
  })

  it('未初始化环境 / 非法 petRect → null，不抛', () => {
    const empty = new DesktopSensor()
    expect(empty.findPlacementTarget(petRectAt(960, 500))).toBeNull()
    const sensor = createSensor()
    expect(
      sensor.findPlacementTarget({ x: Number.NaN, y: 0, width: 400, height: 540 })
    ).toBeNull()
  })
})
