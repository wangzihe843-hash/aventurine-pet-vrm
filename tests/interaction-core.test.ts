/**
 * 单测：B4 交互核心编排（`src/renderer/src/interaction/interaction-core.ts`）。
 *
 * 覆盖（合成 DOM 事件序列 → 纯逻辑核心）：
 * 悬停事件/快照、poke 按区域、click vs drag 阈值、拖动持续跟随、dragEnd 甩出速度、
 * 长按不 poke、摸头圆形轨迹 pat 事件、离开窗口收尾、右键菜单打开/关闭/动作/键盘、
 * 禁用时收尾、注视目标回调与平滑、drainEvents 清空语义。
 */
import { describe, expect, it } from 'vitest'

import type {
  InteractionEvent,
  Point2D
} from '../src/renderer/src/core/wave2-contract'
import {
  InteractionCore,
  type InteractionCoreOptions
} from '../src/renderer/src/interaction/interaction-core'
import type { MenuAction } from '../src/renderer/src/interaction/menu-model'

/** 宠物矩形：200×400，左上 (1000, 200) → 头中心 (1100, 252)。 */
const PET = { x: 1000, y: 200, width: 200, height: 400 }
const HEAD = { x: 1100, y: 250 }
const BODY = { x: 1100, y: 350 }
const LEG = { x: 1100, y: 500 }

interface Harness {
  core: InteractionCore
  lookTargets: (Point2D | null)[]
  menuActions: MenuAction[]
  setEnabled(value: boolean): void
  setAutonomous(value: boolean): void
  setClock(value: number): void
}

/** 构造核心 + 记录回调；`overrides` 可覆盖任意选项（如 getPetRect 返回 null）。 */
function createHarness(overrides: Partial<InteractionCoreOptions> = {}): Harness {
  let enabled = true
  let autonomous = true
  let clock = 0
  const lookTargets: (Point2D | null)[] = []
  const menuActions: MenuAction[] = []
  const core = new InteractionCore({
    getPetRect: () => PET,
    getPetHeightPx: () => 400,
    isEnabled: () => enabled,
    now: () => clock,
    onLookTarget: (target) => lookTargets.push(target),
    onMenuAction: (action) => menuActions.push(action),
    getAutonomous: () => autonomous,
    getViewport: () => ({ width: 1920, height: 1080 }),
    ...overrides
  })
  return {
    core,
    lookTargets,
    menuActions,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    setAutonomous: (value: boolean) => {
      autonomous = value
    },
    setClock: (value: number) => {
      clock = value
    }
  }
}

/** 事件种类列表（断言方便）。 */
function kinds(events: InteractionEvent[]): string[] {
  return events.map((event) => event.kind)
}

/** 合并若干次 drain（按调用顺序）。 */
function drainAll(core: InteractionCore): InteractionEvent[] {
  return core.drainEvents()
}

describe('悬停 / 快照 / 事件队列', () => {
  it('进入宠物 → hoverEnter；离开 → hoverLeave；快照 pointer/hoveringPet 同步', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 100)
    expect(kinds(drainAll(h.core))).toEqual(['hoverEnter'])
    expect(h.core.getSnapshot()).toMatchObject({
      pointer: { x: HEAD.x, y: HEAD.y },
      hoveringPet: true,
      dragging: false
    })

    h.core.pointerMove({ x: 1100, y: 700 }, 200) // 宠物矩形外
    expect(kinds(drainAll(h.core))).toEqual(['hoverLeave'])
    expect(h.core.getSnapshot().hoveringPet).toBe(false)
    expect(h.core.getSnapshot().pointer).toEqual({ x: 1100, y: 700 })
  })

  it('drainEvents 取走即清空（第二次为空）', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 0)
    expect(h.core.drainEvents()).toHaveLength(1)
    expect(h.core.drainEvents()).toHaveLength(0)
  })

  it('非法坐标忽略（不改变快照/不发事件）', () => {
    const h = createHarness()
    h.core.pointerMove({ x: Number.NaN, y: 250 }, 0)
    expect(h.core.getSnapshot().pointer).toBeNull()
    expect(h.core.drainEvents()).toHaveLength(0)
  })

  it('初始快照为「无指针、未悬停、未拖动、摸头进度 0」', () => {
    const h = createHarness()
    expect(h.core.getSnapshot()).toEqual({
      pointer: null,
      hoveringPet: false,
      dragging: false,
      patProgress: 0
    })
  })
})

describe('poke：短按按区域', () => {
  it('头/躯干/腿三个区域分别产出对应 poke', () => {
    const h = createHarness()
    for (const [point, region] of [
      [HEAD, 'head'],
      [BODY, 'body'],
      [LEG, 'leg']
    ] as const) {
      h.core.pointerDown(point, 'left', 0)
      h.core.pointerUp(point, 100)
      const pokes = h.core.drainEvents().filter((event) => event.kind === 'poke')
      expect(pokes).toEqual([{ kind: 'poke', region }])
    }
  })

  it('位移 2px（小于拖动阈值）的短按仍是 poke', () => {
    const h = createHarness()
    h.core.pointerDown(HEAD, 'left', 0)
    h.core.pointerMove({ x: HEAD.x + 2, y: HEAD.y }, 50)
    h.core.pointerUp({ x: HEAD.x + 2, y: HEAD.y }, 120)
    const pokes = h.core.drainEvents().filter((event) => event.kind === 'poke')
    expect(pokes).toEqual([{ kind: 'poke', region: 'head' }])
  })

  it('长按（>250ms）不产生 poke', () => {
    const h = createHarness()
    h.core.pointerDown(HEAD, 'left', 0)
    h.core.pointerUp(HEAD, 400)
    expect(h.core.drainEvents().filter((event) => event.kind === 'poke')).toHaveLength(0)
  })

  it('按在宠物外（矩形外）不产生 poke', () => {
    const h = createHarness()
    h.core.pointerDown({ x: 10, y: 10 }, 'left', 0)
    h.core.pointerUp({ x: 10, y: 10 }, 100)
    expect(h.core.drainEvents()).toHaveLength(0)
  })
})

describe('drag：阈值 / 持续跟随 / 甩出速度', () => {
  it('越过 3px 阈值才发 dragStart；后续发 dragMove；松手发 dragEnd（含速度）', () => {
    const h = createHarness()
    h.core.pointerDown(HEAD, 'left', 0)
    h.core.drainEvents() // 按下即悬停 → hoverEnter

    h.core.pointerMove({ x: HEAD.x, y: HEAD.y + 2 }, 10)
    expect(h.core.drainEvents()).toHaveLength(0) // 未越过阈值
    expect(h.core.getSnapshot().dragging).toBe(false)

    h.core.pointerMove({ x: HEAD.x, y: HEAD.y + 10 }, 20)
    // 按下已算悬停 → 开始拖动时先 hoverLeave，再 dragStart
    expect(kinds(h.core.drainEvents())).toEqual(['hoverLeave', 'dragStart'])
    expect(h.core.getSnapshot().dragging).toBe(true)

    h.core.pointerMove({ x: 1200, y: 400 }, 40)
    expect(kinds(h.core.drainEvents())).toEqual(['dragMove'])

    h.core.pointerUp({ x: 1200, y: 400 }, 60)
    const events = h.core.drainEvents()
    expect(kinds(events)).toEqual(['dragEnd'])
    const dragEnd = events[0] as Extract<InteractionEvent, { kind: 'dragEnd' }>
    expect(dragEnd.pointer).toEqual({ x: 1200, y: 400 })
    // 窗口内最早采样 (1100,250)@0 → (1200,400)@60：vx=100/0.06≈1666.7, vy=150/0.06=2500
    expect(dragEnd.throwVelocity.x).toBeCloseTo(100 / 0.06, 3)
    expect(dragEnd.throwVelocity.y).toBeCloseTo(150 / 0.06, 3)
    expect(h.core.getSnapshot().dragging).toBe(false)
  })

  it('拖动中指针离开宠物矩形仍持续拖动（dragMove 继续）', () => {
    const h = createHarness()
    h.core.pointerDown(HEAD, 'left', 0)
    h.core.pointerMove({ x: 1100, y: 300 }, 20)
    h.core.drainEvents()
    expect(h.core.getSnapshot().dragging).toBe(true)

    h.core.pointerMove({ x: 50, y: 50 }, 40) // 远离宠物
    expect(kinds(h.core.drainEvents())).toEqual(['dragMove'])
    expect(h.core.getSnapshot().dragging).toBe(true)
    expect(h.core.getSnapshot().hoveringPet).toBe(false)

    h.core.pointerUp({ x: 50, y: 50 }, 60)
    expect(kinds(h.core.drainEvents())).toEqual(['dragEnd'])
  })

  it('拖动时先发 hoverLeave（hoveringPet=false），松手回到宠物上补发 hoverEnter', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 0)
    h.core.drainEvents() // hoverEnter
    h.core.pointerDown(HEAD, 'left', 10)
    h.core.pointerMove({ x: 1100, y: 300 }, 20)
    expect(kinds(h.core.drainEvents())).toEqual(['hoverLeave', 'dragStart'])
    h.core.pointerUp({ x: 1100, y: 300 }, 30)
    expect(kinds(h.core.drainEvents())).toEqual(['dragEnd', 'hoverEnter'])
  })
})

describe('pointerLeave：离开窗口的收尾', () => {
  it('清空指针/悬停；拖动中离开视为松手（发 dragEnd，不会卡住）', () => {
    const h = createHarness()
    h.core.pointerDown(HEAD, 'left', 0)
    h.core.pointerMove({ x: 1200, y: 300 }, 20)
    h.core.drainEvents() // dragStart
    h.core.pointerLeave(40)
    const events = h.core.drainEvents()
    expect(kinds(events)).toEqual(['dragEnd'])
    expect(h.core.getSnapshot().pointer).toBeNull()
    expect(h.core.getSnapshot().dragging).toBe(false)
    expect(h.lookTargets[h.lookTargets.length - 1]).toBeNull()
  })

  it('悬停中离开 → hoverLeave + 注视 null', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 0)
    h.core.drainEvents()
    h.core.pointerLeave(16)
    expect(kinds(h.core.drainEvents())).toEqual(['hoverLeave'])
    expect(h.lookTargets[h.lookTargets.length - 1]).toBeNull()
  })
})

describe('摸头：圆形轨迹 → pat 事件', () => {
  it('头部中心画一圈（半径 60px、24 采样）→ 恰好一次 pat 事件，快照进度归零', () => {
    const h = createHarness()
    const center = { x: 1100, y: 200 + 400 * 0.13 }
    for (let i = 0; i < 24; i += 1) {
      const angle = (i / 24) * Math.PI * 2
      h.core.pointerMove(
        { x: center.x + Math.cos(angle) * 60, y: center.y + Math.sin(angle) * 60 },
        i * 16
      )
    }
    const pats = h.core.drainEvents().filter((event) => event.kind === 'pat')
    expect(pats).toHaveLength(1)
    expect(h.core.getSnapshot().patProgress).toBe(0)
  })

  it('直线扫过头部不产生 pat', () => {
    const h = createHarness()
    const centerY = 200 + 400 * 0.13
    for (let i = 0; i < 24; i += 1) {
      h.core.pointerMove({ x: 1040 + i * 5, y: centerY - 52 }, i * 16)
    }
    expect(h.core.drainEvents().filter((event) => event.kind === 'pat')).toHaveLength(0)
  })
})

describe('右键菜单', () => {
  it('宠物上右键 → 打开菜单；快照 hoveringPet=false；菜单动作选中发事件 + 回调', () => {
    const h = createHarness()
    const state = h.core.contextMenu(HEAD, 100)
    expect(state).not.toBeNull()
    expect(state!.items).toHaveLength(4)
    expect(h.core.isMenuOpen()).toBe(true)
    expect(h.core.getSnapshot().hoveringPet).toBe(false)

    expect(h.core.selectMenuAction('hide')).toBe(true)
    expect(h.core.isMenuOpen()).toBe(false)
    expect(h.menuActions).toEqual(['hide'])
    expect(h.core.drainEvents()).toContainEqual({ kind: 'menuAction', action: 'hide' })
  })

  it('宠物外右键 → 不打开菜单', () => {
    const h = createHarness()
    expect(h.core.contextMenu({ x: 10, y: 10 }, 0)).toBeNull()
    expect(h.core.isMenuOpen()).toBe(false)
  })

  it('菜单打开时点击菜单外 → 关闭且不开始拖拽/不产生 poke', () => {
    const h = createHarness()
    h.core.contextMenu(HEAD, 0)
    h.core.drainEvents()
    h.core.pointerDown({ x: 10, y: 10 }, 'left', 100)
    expect(h.core.isMenuOpen()).toBe(false)
    h.core.pointerUp({ x: 10, y: 10 }, 150)
    const events = h.core.drainEvents()
    expect(events.filter((event) => event.kind === 'poke' || event.kind === 'dragStart')).toHaveLength(0)
  })

  it('菜单打开时点击菜单内 → 保持打开', () => {
    const h = createHarness()
    const state = h.core.contextMenu(HEAD, 0)
    // 菜单左上角 = 锚点（宠物内，视口足够大不钳制）
    h.core.pointerDown({ x: state!.position.x + 10, y: state!.position.y + 10 }, 'left', 16)
    expect(h.core.isMenuOpen()).toBe(true)
  })

  it('菜单反映自主活动开关状态', () => {
    const h = createHarness()
    h.setAutonomous(false)
    const state = h.core.contextMenu(HEAD, 0)
    expect(state!.items[2].label).toBe('自主活动：关')
    expect(state!.items[2].checked).toBe(false)
  })

  it('键盘：↓ 移动高亮、Enter 选中、ESC 关闭', () => {
    const h = createHarness()
    h.core.contextMenu(HEAD, 0)
    h.core.drainEvents()
    expect(h.core.handleKey('ArrowDown')).toBeNull()
    expect(h.core.getMenuState()!.activeIndex).toBe(0)
    expect(h.core.handleKey('Enter')).toBe('settings')
    expect(h.menuActions).toEqual(['settings'])
    expect(h.core.isMenuOpen()).toBe(false)
    expect(h.core.drainEvents()).toContainEqual({ kind: 'menuAction', action: 'settings' })

    h.core.contextMenu(HEAD, 100)
    expect(h.core.handleKey('Escape')).toBe('close')
    expect(h.core.isMenuOpen()).toBe(false)
  })

  it('closeMenu 幂等；未打开时 handleKey/selectMenuAction 安全', () => {
    const h = createHarness()
    h.core.closeMenu()
    expect(h.core.handleKey('Escape')).toBeNull()
    expect(h.core.selectMenuAction('quit')).toBe(false)
  })

  it('DOM 实测尺寸回填 → 菜单重新钳制位置', () => {
    let viewport = { width: 1920, height: 1080 }
    const h = createHarness({ getViewport: () => viewport })
    const state = h.core.contextMenu({ x: 1100, y: 590 }, 0)
    expect(state!.position).toEqual({ x: 1100, y: 590 })
    const updated = h.core.setMenuSize({ width: 400, height: 300 })
    expect(updated).not.toBeNull()
    // 视口 1080 高：maxY = 1080-300-6 = 774 > 590 → 不变；宽度无影响
    viewport = { width: 1200, height: 700 }
    h.core.contextMenu({ x: 1100, y: 590 }, 16)
    const updated2 = h.core.setMenuSize({ width: 400, height: 300 })
    expect(updated2!.position.x).toBe(1200 - 400 - 6)
    expect(updated2!.position.y).toBe(700 - 300 - 6)
  })
})

describe('启用/禁用与收尾', () => {
  it('禁用时：tick 收尾发 hoverLeave、注视 null；后续指针事件不再产生交互事件', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 0)
    h.core.drainEvents()
    h.setEnabled(false)
    h.core.tick(16)
    expect(kinds(h.core.drainEvents())).toEqual(['hoverLeave'])
    expect(h.lookTargets[h.lookTargets.length - 1]).toBeNull()

    h.core.pointerMove(BODY, 32)
    h.core.pointerDown(BODY, 'left', 40)
    h.core.pointerUp(BODY, 50)
    expect(h.core.drainEvents()).toHaveLength(0)
    expect(h.core.getSnapshot().hoveringPet).toBe(false)
  })

  it('禁用时右键不打开菜单', () => {
    const h = createHarness()
    h.setEnabled(false)
    expect(h.core.contextMenu(HEAD, 0)).toBeNull()
  })

  it('禁用时拖动收尾：tick 发 dragEnd（不卡住）', () => {
    const h = createHarness()
    h.core.pointerDown(HEAD, 'left', 0)
    h.core.pointerMove({ x: 1200, y: 300 }, 20)
    h.core.drainEvents()
    h.setEnabled(false)
    h.core.tick(40)
    expect(kinds(h.core.drainEvents())).toEqual(['dragEnd'])
    expect(h.core.getSnapshot().dragging).toBe(false)
  })

  it('reset 清空一切（指针/悬停/事件/注视回调 null）', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 0)
    h.core.drainEvents()
    h.core.reset()
    expect(h.core.getSnapshot()).toEqual({
      pointer: null,
      hoveringPet: false,
      dragging: false,
      patProgress: 0
    })
    expect(h.core.drainEvents()).toHaveLength(0)
    expect(h.lookTargets[h.lookTargets.length - 1]).toBeNull()
  })
})

describe('注视目标（onLookTarget）', () => {
  it('指针移动 → 回调平滑目标（首次吸附）；tick 推进平滑', () => {
    const h = createHarness()
    h.core.pointerMove({ x: 1100, y: 250 }, 0)
    expect(h.lookTargets.length).toBeGreaterThan(0)
    expect(h.lookTargets[0]).toEqual({ x: 1100, y: 250 })

    h.core.pointerMove({ x: 1150, y: 300 }, 0)
    expect(h.lookTargets[h.lookTargets.length - 1]).toEqual({ x: 1100, y: 250 }) // dt=0 尚未推进
    h.core.tick(100)
    const latest = h.lookTargets[h.lookTargets.length - 1]!
    expect(latest.x).toBeGreaterThan(1100)
    expect(latest.x).toBeLessThan(1150)
    expect(latest.y).toBeGreaterThan(250)
    expect(latest.y).toBeLessThan(300)
  })

  it('注视 2.5s 无移动 → tick 回落为 null', () => {
    const h = createHarness()
    h.core.pointerMove(HEAD, 0)
    expect(h.lookTargets[h.lookTargets.length - 1]).not.toBeNull()
    h.core.tick(2600)
    expect(h.lookTargets[h.lookTargets.length - 1]).toBeNull()
  })
})
