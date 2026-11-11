/**
 * 单测：B4 右键菜单模型（`src/renderer/src/interaction/menu-model.ts`）。
 *
 * 覆盖：菜单项构建（顺序/标签/勾选态/危险项）、锚点位置钳制（四边/非法输入）、
 * 打开/重新定位/关闭、点击外部关闭、键盘（ESC/↑↓/Enter）、选中动作、DOM 测量后重新钳制。
 */
import { describe, expect, it } from 'vitest'

import {
  buildMenuItems,
  clampMenuPosition,
  ContextMenuModel,
  DEFAULT_MENU_SIZE,
  MENU_ACTIONS,
  MENU_SAFE_MARGIN_PX
} from '../src/renderer/src/interaction/menu-model'

const VIEWPORT = { width: 1920, height: 1000 }

describe('buildMenuItems：菜单项', () => {
  it('4 项、顺序固定（设置/隐藏/自主活动/退出）', () => {
    const items = buildMenuItems({ autonomous: true })
    expect(items).toHaveLength(4)
    expect(items.map((item) => item.action)).toEqual([
      'settings',
      'hide',
      'toggleAutonomous',
      'quit'
    ])
    expect(MENU_ACTIONS).toEqual(['settings', 'hide', 'toggleAutonomous', 'quit'])
    expect(items.map((item) => item.label)).toEqual([
      '设置…',
      '隐藏桌宠',
      '自主活动：开',
      '退出'
    ])
  })

  it('自主活动开关：开着 → 勾选；关着 → 标签/勾选态同步', () => {
    const on = buildMenuItems({ autonomous: true })
    expect(on[2].kind).toBe('toggle')
    expect(on[2].checked).toBe(true)

    const off = buildMenuItems({ autonomous: false })
    expect(off[2].label).toBe('自主活动：关')
    expect(off[2].checked).toBe(false)

    // 不传参数默认视为开
    expect(buildMenuItems()[2].checked).toBe(true)
  })

  it('退出项：危险样式 + 上方分隔线', () => {
    const quit = buildMenuItems().find((item) => item.action === 'quit')!
    expect(quit.destructive).toBe(true)
    expect(quit.separatorBefore).toBe(true)
  })
})

describe('clampMenuPosition：位置钳制', () => {
  it('窗口内锚点不变', () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, DEFAULT_MENU_SIZE, VIEWPORT)).toEqual({
      x: 100,
      y: 100
    })
  })

  it('贴右/下边缘 → 向左/上回退到安全区', () => {
    const position = clampMenuPosition(
      { x: VIEWPORT.width + 50, y: VIEWPORT.height + 50 },
      DEFAULT_MENU_SIZE,
      VIEWPORT
    )
    expect(position.x).toBe(VIEWPORT.width - DEFAULT_MENU_SIZE.width - MENU_SAFE_MARGIN_PX)
    expect(position.y).toBe(VIEWPORT.height - DEFAULT_MENU_SIZE.height - MENU_SAFE_MARGIN_PX)
  })

  it('负坐标/非法输入 → 收进 margin', () => {
    expect(clampMenuPosition({ x: -20, y: -30 }, DEFAULT_MENU_SIZE, VIEWPORT)).toEqual({
      x: MENU_SAFE_MARGIN_PX,
      y: MENU_SAFE_MARGIN_PX
    })
    expect(
      clampMenuPosition({ x: Number.NaN, y: Number.NaN }, DEFAULT_MENU_SIZE, VIEWPORT)
    ).toEqual({ x: MENU_SAFE_MARGIN_PX, y: MENU_SAFE_MARGIN_PX })
  })

  it('非法视口（0×0）→ 只按 margin 钳制（不产生 NaN）', () => {
    const position = clampMenuPosition(
      { x: 500, y: 400 },
      DEFAULT_MENU_SIZE,
      { width: Number.NaN, height: 0 }
    )
    const viewportWidth = Math.max(0, 0)
    expect(Number.isFinite(position.x)).toBe(true)
    expect(Number.isFinite(position.y)).toBe(true)
    expect(position.x).toBeGreaterThanOrEqual(MENU_SAFE_MARGIN_PX)
    expect(position.y).toBeGreaterThanOrEqual(MENU_SAFE_MARGIN_PX)
    // width 非法 → viewportWidth=0 → maxX = margin
    expect(position.x).toBe(MENU_SAFE_MARGIN_PX)
    expect(viewportWidth).toBe(0)
  })

  it('自定义 margin 生效', () => {
    expect(clampMenuPosition({ x: 1, y: 1 }, { width: 100, height: 100 }, VIEWPORT, 20)).toEqual({
      x: 20,
      y: 20
    })
  })
})

describe('ContextMenuModel：打开 / 关闭 / 外部点击', () => {
  it('open 返回完整状态（位置、锚点、尺寸、item、无高亮）', () => {
    const model = new ContextMenuModel()
    expect(model.isOpen).toBe(false)
    const state = model.open({ x: 400, y: 300 }, VIEWPORT)
    expect(state.open).toBe(true)
    expect(state.position).toEqual({ x: 400, y: 300 })
    expect(state.anchor).toEqual({ x: 400, y: 300 })
    expect(state.size).toEqual(DEFAULT_MENU_SIZE)
    expect(state.items).toHaveLength(4)
    expect(state.activeIndex).toBe(-1)
    expect(model.isOpen).toBe(true)
    expect(model.currentState).not.toBeNull()
  })

  it('打开状态下再次 open → 重新定位（锚点更新）', () => {
    const model = new ContextMenuModel()
    model.open({ x: 400, y: 300 }, VIEWPORT)
    const state = model.open({ x: 800, y: 700 }, VIEWPORT)
    expect(state.anchor).toEqual({ x: 800, y: 700 })
    expect(state.position).toEqual({ x: 800, y: 700 })
  })

  it('close 幂等；关闭后 select/键盘/pointerDownOutside 都是空操作', () => {
    const model = new ContextMenuModel()
    model.open({ x: 400, y: 300 }, VIEWPORT)
    model.close()
    expect(model.isOpen).toBe(false)
    model.close()
    expect(model.select('hide')).toBeNull()
    expect(model.handleKey('Escape')).toBeNull()
    expect(model.pointerDownOutside({ x: 0, y: 0 })).toBe(false)
    expect(model.currentState).toBeNull()
  })

  it('点击菜单外 → 关闭并返回 true；点击菜单内 → 不关闭', () => {
    const model = new ContextMenuModel()
    const size = { width: 168, height: 140 }
    model.open({ x: 100, y: 100 }, VIEWPORT, size)
    // 菜单内
    expect(model.containsPoint({ x: 110, y: 110 })).toBe(true)
    expect(model.pointerDownOutside({ x: 110, y: 110 })).toBe(false)
    expect(model.isOpen).toBe(true)
    // 菜单外
    expect(model.pointerDownOutside({ x: 500, y: 500 })).toBe(true)
    expect(model.isOpen).toBe(false)
  })

  it('containsPoint：边界半开 / 非法输入', () => {
    const model = new ContextMenuModel()
    model.open({ x: 100, y: 100 }, VIEWPORT, { width: 100, height: 50 })
    expect(model.containsPoint({ x: 100, y: 100 })).toBe(true)
    expect(model.containsPoint({ x: 199.9, y: 149.9 })).toBe(true)
    expect(model.containsPoint({ x: 200, y: 120 })).toBe(false)
    expect(model.containsPoint({ x: 120, y: 150 })).toBe(false)
    expect(model.containsPoint({ x: Number.NaN, y: 120 })).toBe(false)
    expect(model.containsPoint(null)).toBe(false)
  })
})

describe('ContextMenuModel：动作选中 / 键盘', () => {
  it('select 已知 action → 关闭并返回 action；未知 action → null 且保持打开', () => {
    const model = new ContextMenuModel()
    model.open({ x: 100, y: 100 }, VIEWPORT)
    expect(model.select('nope' as never)).toBeNull()
    expect(model.isOpen).toBe(true)
    expect(model.select('settings')).toBe('settings')
    expect(model.isOpen).toBe(false)
  })

  it('方向键循环移动高亮；Enter/空格选中高亮项', () => {
    const model = new ContextMenuModel()
    model.open({ x: 100, y: 100 }, VIEWPORT)
    expect(model.activeIndex).toBe(-1)
    expect(model.handleKey('ArrowDown')).toBeNull()
    expect(model.activeIndex).toBe(0)
    expect(model.handleKey('ArrowUp')).toBeNull()
    expect(model.activeIndex).toBe(3) // 从 0 向上 → 末项（循环）
    expect(model.handleKey('ArrowDown')).toBeNull()
    expect(model.activeIndex).toBe(0)
    expect(model.handleKey('Enter')).toBe('settings')
    expect(model.isOpen).toBe(false)

    model.open({ x: 100, y: 100 }, VIEWPORT)
    model.handleKey('ArrowDown')
    model.handleKey('ArrowDown')
    expect(model.activeIndex).toBe(1)
    expect(model.handleKey(' ')).toBe('hide')
  })

  it('Escape 关闭菜单', () => {
    const model = new ContextMenuModel()
    model.open({ x: 100, y: 100 }, VIEWPORT)
    expect(model.handleKey('Escape')).toBe('close')
    expect(model.isOpen).toBe(false)
  })

  it('setActiveIndex 越界 → -1；selectActive 无高亮 → null', () => {
    const model = new ContextMenuModel()
    model.open({ x: 100, y: 100 }, VIEWPORT)
    expect(model.selectActive()).toBeNull()
    expect(model.setActiveIndex(99)).toBe(-1)
    expect(model.setActiveIndex(2)).toBe(2)
    expect(model.selectActive()).toBe('toggleAutonomous')
  })
})

describe('ContextMenuModel：DOM 实测尺寸回填', () => {
  it('updateSize 按新尺寸重新钳制（贴右边缘时左移）', () => {
    const model = new ContextMenuModel()
    // 以 1920×1000 视口打开，锚点靠右下
    model.open({ x: 1700, y: 800 }, VIEWPORT, { width: 100, height: 100 })
    const updated = model.updateSize({ width: 400, height: 300 })
    expect(updated).not.toBeNull()
    expect(updated!.position.x).toBe(VIEWPORT.width - 400 - MENU_SAFE_MARGIN_PX)
    expect(updated!.position.y).toBe(VIEWPORT.height - 300 - MENU_SAFE_MARGIN_PX)
    expect(updated!.size).toEqual({ width: 400, height: 300 })
  })

  it('菜单未打开时 updateSize 返回 null', () => {
    const model = new ContextMenuModel()
    expect(model.updateSize({ width: 100, height: 100 })).toBeNull()
  })

  it('非法/零尺寸回退为默认估算尺寸（不产生 0 宽高菜单）', () => {
    const model = new ContextMenuModel()
    const state = model.open({ x: 100, y: 100 }, VIEWPORT, {
      width: Number.NaN,
      height: 0
    })
    // 任一维非法 → 整体回退默认估算尺寸（避免 0 宽高菜单）
    expect(state.size).toEqual(DEFAULT_MENU_SIZE)
  })

  it('setViewport 更新后 updateSize 用新视口钳制', () => {
    const model = new ContextMenuModel()
    model.open({ x: 1000, y: 800 }, { width: 1200, height: 900 })
    model.setViewport({ width: 500, height: 400 })
    const updated = model.updateSize({ width: 200, height: 100 })
    expect(updated!.position.x).toBe(500 - 200 - MENU_SAFE_MARGIN_PX)
    expect(updated!.position.y).toBe(400 - 100 - MENU_SAFE_MARGIN_PX)
  })
})
