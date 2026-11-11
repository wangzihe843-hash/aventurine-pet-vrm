/**
 * 单测：拖拽被右键菜单打断时的收尾（F4 / M-8 修复）。
 *
 * 旧行为：`contextMenu()` 直接 `drag.cancel()`，不产生 dragEnd → main.ts 收不到
 * `runtime.endDrag`，B2 永久停在 dragging（悬空、无重力、不能落地）。
 * 新行为：已进入拖动时先 emit `dragEnd`（甩出速度强制 0）；仅按下候选（未拖）时静默取消。
 */
import { describe, expect, it } from 'vitest'

import type { InteractionEvent, Point2D } from '../src/renderer/src/core/wave2-contract'
import { InteractionCore } from '../src/renderer/src/interaction/interaction-core'

/** 宠物矩形：200×400，左上 (1000, 200)。 */
const PET = { x: 1000, y: 200, width: 200, height: 400 }
const BODY: Point2D = { x: 1100, y: 350 }

function createCore(): { core: InteractionCore; setClock(value: number): void } {
  let clock = 0
  const core = new InteractionCore({
    getPetRect: () => PET,
    getPetHeightPx: () => 400,
    isEnabled: () => true,
    now: () => clock,
    getViewport: () => ({ width: 1920, height: 1080 })
  })
  return {
    core,
    setClock: (value: number) => {
      clock = value
    }
  }
}

function kinds(events: InteractionEvent[]): string[] {
  return events.map((event) => event.kind)
}

describe('M-8：拖拽中右键打开菜单 → 先 emit dragEnd 再取消', () => {
  it('已进入拖动（越过阈值）→ contextMenu 产生 dragEnd（速度 0），dragging 复位', () => {
    const { core, setClock } = createCore()
    core.pointerDown(BODY, 'left', 0)
    setClock(20)
    core.pointerMove({ x: 1160, y: 360 }, 20) // 位移 > 3px 阈值 → dragStart
    expect(core.getSnapshot().dragging).toBe(true)
    core.drainEvents() // 清掉 hoverEnter / dragStart

    setClock(400)
    const menu = core.contextMenu(BODY, 400)
    expect(menu).not.toBeNull()
    expect(core.isMenuOpen()).toBe(true)

    const events = core.drainEvents()
    expect(kinds(events)).toContain('dragEnd')
    const dragEnd = events.find((event) => event.kind === 'dragEnd')
    expect(dragEnd).toBeDefined()
    if (dragEnd?.kind !== 'dragEnd') throw new Error('unreachable')
    // 右键打断不能把宠物甩飞 → 速度必须为 0（B2 收到后原地失重落地）
    expect(dragEnd.throwVelocity).toEqual({ x: 0, y: 0 })
    expect(core.getSnapshot().dragging).toBe(false)
  })

  it('拖拽中右键 → 之后 pointerUp 不再补发第二个 dragEnd（菜单打开时忽略指针抬起）', () => {
    const { core, setClock } = createCore()
    core.pointerDown(BODY, 'left', 0)
    setClock(20)
    core.pointerMove({ x: 1160, y: 360 }, 20)
    core.drainEvents()

    setClock(400)
    core.contextMenu(BODY, 400)
    const afterMenu = core.drainEvents()
    expect(afterMenu.filter((event) => event.kind === 'dragEnd')).toHaveLength(1)

    setClock(500)
    core.pointerUp({ x: 1160, y: 360 }, 500)
    const afterUp = core.drainEvents()
    expect(afterUp.filter((event) => event.kind === 'dragEnd')).toHaveLength(0)
  })

  it('仅按下候选（未越过拖动阈值）→ 右键静默取消，不凭空产生 dragEnd', () => {
    const { core, setClock } = createCore()
    core.pointerDown(BODY, 'left', 0)
    setClock(10)
    core.drainEvents() // 清掉 hoverEnter

    setClock(400)
    const menu = core.contextMenu(BODY, 400)
    expect(menu).not.toBeNull()
    const events = core.drainEvents()
    expect(kinds(events)).not.toContain('dragEnd')
    expect(core.getSnapshot().dragging).toBe(false)
  })
})
