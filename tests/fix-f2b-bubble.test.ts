/**
 * F2b bubble LOW 修复回归（core/bubble.ts）：
 * - 02 L-2 淡出：hide() 先透明播 CSS opacity 过渡，过渡结束后才 visibility:hidden
 *   （旧实现同帧 hidden → 过渡完全不播）；
 * - 02 L-3 每帧 reflow：只在文本变化时 getBoundingClientRect 测量并缓存；place() 在宠物矩形/
 *   视口不变时不重算、不写 style；
 * - 02 L-8 过期依赖渲染帧：show() 挂独立定时器自驱动过期（update(nowMs) 仅兜底）。
 *
 * 环境：仓库 vitest 为 node 环境（无 jsdom/happy-dom），本文件用最小假 DOM（FakeElement +
 * document.createElement/requestAnimationFrame/vi fake timers）驱动 BubbleView，不引入新依赖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUBBLE_FADE_OUT_MS,
  BubbleView,
  computeBubblePosition,
  type BubbleViewport
} from '../src/renderer/src/core/bubble'
import type { Rect } from '@shared/types'

/** 最小假元素（只实现 BubbleView 用到的 DOM 表面）。 */
class FakeElement {
  className = ''
  style: Record<string, string> = {}
  textContent = ''
  attributes: Record<string, string> = {}
  children: FakeElement[] = []
  removed = false
  measureCalls = 0
  rect = { left: 100, top: 100, width: 160, height: 40 }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }

  appendChild(child: FakeElement): void {
    this.children.push(child)
  }

  remove(): void {
    this.removed = true
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    this.measureCalls += 1
    return { ...this.rect }
  }
}

let container: FakeElement
let rafQueue: Array<() => void>

function installFakeDom(): void {
  container = new FakeElement()
  rafQueue = []
  ;(globalThis as unknown as { document: unknown }).document = {
    body: new FakeElement(),
    createElement: () => new FakeElement()
  }
  ;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
    callback: () => void
  ) => {
    rafQueue.push(callback)
    return rafQueue.length
  }
}

function uninstallFakeDom(): void {
  delete (globalThis as unknown as { document?: unknown }).document
  delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame
}

/** 执行已排队的 rAF 回调（模拟下一渲染帧的二次测量）。 */
function flushAnimationFrames(): void {
  const pending = rafQueue.splice(0, rafQueue.length)
  for (const callback of pending) callback()
}

function createView(): { view: BubbleView; element: FakeElement } {
  const view = new BubbleView({ container: container as unknown as HTMLElement })
  const element = container.children[0]!
  return { view, element }
}

const VIEWPORT: BubbleViewport = { width: 800, height: 1000 }
const PET_RECT: Rect = { x: 300, y: 600, width: 200, height: 540 }

beforeEach(() => {
  vi.useFakeTimers()
  installFakeDom()
})

afterEach(() => {
  vi.useRealTimers()
  uninstallFakeDom()
})

describe('BubbleView：02 L-2 淡出真正生效', () => {
  it('hide() 后先保持 visible 播 opacity 过渡，过渡结束才 visibility:hidden', () => {
    const { view, element } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('测试台词', 0)
    expect(element.style.opacity).toBe('1')
    expect(element.style.visibility).toBe('visible')

    view.hide()
    expect(view.visible).toBe(false)
    expect(element.style.opacity).toBe('0')
    // 关键回归：旧实现同帧写 hidden，CSS opacity 过渡根本不会播
    expect(element.style.visibility).toBe('visible')
    vi.advanceTimersByTime(BUBBLE_FADE_OUT_MS - 1)
    expect(element.style.visibility).toBe('visible')
    vi.advanceTimersByTime(1)
    expect(element.style.visibility).toBe('hidden')
  })

  it('淡出中途再次 show：取消隐藏定时器，保持可见并重新计时', () => {
    const { view, element } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词A', 0, 1000)
    view.hide()
    vi.advanceTimersByTime(50)

    view.show('台词B', 60, 1000)
    expect(element.style.visibility).toBe('visible')
    expect(element.style.opacity).toBe('1')
    vi.advanceTimersByTime(BUBBLE_FADE_OUT_MS)
    // 老的淡出定时器已取消，不应被隐藏
    expect(element.style.visibility).toBe('visible')
    expect(view.visible).toBe(true)
  })
})

describe('BubbleView：02 L-8 过期不依赖渲染帧', () => {
  it('show() 挂独立定时器：不调用 update() 也会按时隐藏', () => {
    const { view } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词', 1000, 4200)
    expect(view.visible).toBe(true)

    vi.advanceTimersByTime(4199)
    expect(view.visible).toBe(true)
    vi.advanceTimersByTime(1)
    expect(view.visible).toBe(false)
  })

  it('update(nowMs) 兜底仍有效（注入时钟/定时器被节流场景）', () => {
    const { view } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词', 0, 1000)

    view.update(999)
    expect(view.visible).toBe(true)
    view.update(1000)
    expect(view.visible).toBe(false)
  })

  it('destroy() 清理过期/淡出定时器（再推进时间不抛错）', () => {
    const { view, element } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词', 0, 4200)
    view.destroy()
    expect(element.removed).toBe(true)
    expect(view.visible).toBe(false)
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow()
  })
})

describe('BubbleView：02 L-3 不再每帧强制 reflow / 写 style', () => {
  it('文本未变时重复 place() 不调用 getBoundingClientRect；文本变化才重测一次', () => {
    const { view, element } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词', 0)
    expect(element.measureCalls).toBe(1)
    const callsAfterShow = element.measureCalls

    for (let index = 0; index < 60; index += 1) {
      view.place({ ...PET_RECT }, { ...VIEWPORT })
    }
    expect(element.measureCalls).toBe(callsAfterShow)

    view.show('另一句台词', 100)
    expect(element.measureCalls).toBe(callsAfterShow + 1)
  })

  it('宠物矩形不变时 place() 不写 style；移动后只写 left/top 且不重测', () => {
    const { view, element } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词', 0)
    // 用 Proxy 统计 style 写入次数（BubbleView 运行时通过 element.style 属性赋值）
    const writes: string[] = []
    const countingStyle = new Proxy(
      {},
      {
        set(target: Record<string, string>, key: string, value: string) {
          target[key] = value
          writes.push(key)
          return true
        }
      }
    )
    ;(element as unknown as { style: Record<string, string> }).style = countingStyle

    view.place({ ...PET_RECT }, { ...VIEWPORT })
    expect(writes).toHaveLength(0)

    const measureCallsBefore = element.measureCalls
    view.place({ ...PET_RECT, x: PET_RECT.x + 100 }, VIEWPORT)
    expect(element.measureCalls).toBe(measureCallsBefore) // 复用缓存尺寸，不 reflow
    expect(writes).toEqual(['left', 'top'])
  })

  it('rAF 二次测量只发生在文本变化后的下一帧（字体/换行稳定后精确定位）', () => {
    const { view, element } = createView()
    view.place(PET_RECT, VIEWPORT)
    view.show('台词', 0)
    expect(element.measureCalls).toBe(1)

    flushAnimationFrames()
    expect(element.measureCalls).toBe(2) // 文本变化后的一次补偿测量

    flushAnimationFrames()
    expect(element.measureCalls).toBe(2) // 无新文本不再测量
  })
})

describe('computeBubblePosition（回归基础几何，纯函数）', () => {
  it('气泡在宠物头顶上方水平居中', () => {
    expect(
      computeBubblePosition(PET_RECT, VIEWPORT, { width: 100, height: 40 })
    ).toEqual({ x: 350, y: 550 })
  })

  it('宠物贴顶且两侧都放不下时，改放到宠物下方（不盖住宠物）', () => {
    const position = computeBubblePosition(
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 800, height: 1000 },
      { width: 300, height: 40 }
    )
    // 头顶放不下（aboveY<8）、左右侧也不够 → 放到宠物下方 600+10=610。
    expect(position).toEqual({ x: 250, y: 610 })
  })

  it('宠物贴顶但侧面有空间时，放到侧面（水平分离，不盖头）', () => {
    const position = computeBubblePosition(
      { x: 1500, y: -400, width: 200, height: 540 },
      { width: 1920, height: 961 },
      { width: 300, height: 40 }
    )
    // 右侧放不下（1500+200+10+300 > 1920）→ 放到左侧：x = 1500-10-300 = 1190。
    expect(position.x).toBe(1190)
    expect(position.y).toBe(8)
    // 必须与宠物矩形水平分离（不重叠）。
    expect(position.x + 300).toBeLessThanOrEqual(1500 - 10)
  })

  it('坐在高窗沿（petRect.y 为负）时气泡不落在宠物矩形内', () => {
    const petRect = { x: 1619, y: -216, width: 162, height: 540 }
    const position = computeBubblePosition(petRect, { width: 1920, height: 961 }, { width: 300, height: 40 })
    const overlapsPet =
      position.x < petRect.x + petRect.width &&
      position.x + 300 > petRect.x &&
      position.y < petRect.y + petRect.height &&
      position.y + 40 > petRect.y
    expect(overlapsPet).toBe(false)
  })
})
