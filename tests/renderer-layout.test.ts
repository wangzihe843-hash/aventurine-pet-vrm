/**
 * 单测：宠物尺寸 / 位置 / 视口换算（`src/renderer/src/model/layout.ts`）。
 *
 * 覆盖 PLAN §17.3-2 / §17.5 P1-7 的口径：
 * - petHeightPx = clamp(sizePercent,10,100)/100 × display.bounds.height（10/30/50/100%），
 *   且 100% 受 workArea.height 封顶（1080p：1080 → 961，宠物不出窗）；
 * - 基准确认：尺寸用 bounds.height，不用 workArea.height（1080p：324 vs 288.3）；
 * - workArea 底边 / 右边缘 → 窗口本地坐标（显式减 window.bounds 原点）；
 * - 主屏渲染 / 非主屏与未知显示器不渲染；
 * - 显示器 / workArea / 视口变化后重算（resize / screens-updated 双保险）；
 * - 布局纯模块不依赖 three / DOM / Electron。
 */
import { describe, expect, it } from 'vitest'

import type { DisplayInfo, OverlayWindowInfo } from '../src/shared/types'
import {
  clampSizePercent,
  computeCornerMarginPx,
  computePetHeightPx,
  computePetLayout,
  computePetRect,
  FALLBACK_MODEL_ASPECT,
  findWindowDisplay,
  type LayoutInput
} from '../src/renderer/src/model/layout'

/** 1080p 主屏：bounds 1080 高、workArea 因菜单栏 + Dock 变成 {0,30,1920,961}。 */
const PRIMARY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 30, width: 1920, height: 961 },
  scaleFactor: 1,
  isPrimary: true
}

/** 副屏（右侧）：主屏之外的显示器。 */
const SECONDARY: DisplayInfo = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 0, width: 1920, height: 1055 },
  scaleFactor: 1,
  isPrimary: false
}

/** overlay 窗口：frame = 主屏 workArea。 */
const PRIMARY_WINDOW: Pick<OverlayWindowInfo, 'bounds' | 'displayId'> = {
  bounds: { x: 0, y: 30, width: 1920, height: 961 },
  displayId: 1
}

const PRIMARY_VIEWPORT = { width: 1920, height: 961 }

/** 构造布局输入，默认主屏 30% + corner。 */
function layoutInput(overrides: Partial<LayoutInput> = {}): LayoutInput {
  return {
    sizePercent: 30,
    position: 'corner',
    windowInfo: PRIMARY_WINDOW,
    displays: [PRIMARY, SECONDARY],
    viewport: PRIMARY_VIEWPORT,
    ...overrides
  }
}

describe('computePetHeightPx：尺寸基准 = display.bounds.height', () => {
  it('10% / 30% / 50% @1080p → 108 / 324 / 540', () => {
    expect(computePetHeightPx(10, 1080)).toBe(108)
    expect(computePetHeightPx(30, 1080)).toBe(324)
    expect(computePetHeightPx(50, 1080)).toBe(540)
  })

  it('sizePercent 越界时按 10–100 钳制（5→10%，150→100%，80 保持 80）', () => {
    expect(clampSizePercent(5)).toBe(10)
    expect(clampSizePercent(150)).toBe(100)
    expect(clampSizePercent(80)).toBe(80)
    expect(computePetHeightPx(5, 1080)).toBe(108)
    expect(computePetHeightPx(150, 1080)).toBe(1080)
  })

  it('100%：1080p 下 bounds 语义是 1080，但布局按 workArea.height 封顶 → 961（不出窗）', () => {
    expect(computePetHeightPx(100, 1080)).toBe(1080)
    const layout = computePetLayout(layoutInput({ sizePercent: 100 }))
    expect(layout.petHeightPx).toBe(961)
    const rect = computePetRect(layout, FALLBACK_MODEL_ASPECT)
    expect(rect.y).toBe(0) // 脚底 961 − 高 961 = 0，头顶恰好贴窗口顶边
    expect(rect.y + rect.height).toBeCloseTo(layout.feetY, 6)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(PRIMARY_VIEWPORT.width)
  })

  it('workArea 更高时封顶值随之变化（workArea 1055 → 100% = 1055）', () => {
    const tallPrimary: DisplayInfo = {
      ...PRIMARY,
      workArea: { x: 0, y: 0, width: 1920, height: 1055 }
    }
    const layout = computePetLayout(
      layoutInput({
        sizePercent: 100,
        displays: [tallPrimary],
        windowInfo: { bounds: { x: 0, y: 0, width: 1920, height: 1055 }, displayId: 1 },
        viewport: { width: 1920, height: 1055 }
      })
    )
    expect(layout.petHeightPx).toBe(1055)
  })

  it('60% / 80% 中间档位：按 bounds 计算且均小于 workArea 封顶（1080p → 648 / 864）', () => {
    expect(computePetLayout(layoutInput({ sizePercent: 60 })).petHeightPx).toBeCloseTo(648, 6)
    expect(computePetLayout(layoutInput({ sizePercent: 80 })).petHeightPx).toBeCloseTo(864, 6)
  })

  it('NaN / 缺失 bounds 高度时安全兜底，不产生 NaN', () => {
    expect(computePetHeightPx(Number.NaN, 1080)).toBe(108)
    expect(computePetHeightPx(30, Number.NaN)).toBe(0)
    expect(computePetHeightPx(30, 0)).toBe(0)
  })

  it('布局里 30% 用 bounds.height=1080 → 324（而不是 workArea.height=961 → 288.3）', () => {
    const layout = computePetLayout(layoutInput())
    expect(layout.petHeightPx).toBeCloseTo(324, 6)
    expect(layout.petHeightPx).not.toBeCloseTo(0.3 * PRIMARY.workArea.height, 3)
  })
})

describe('findWindowDisplay / 主屏判定', () => {
  it('按 displayId 精确匹配', () => {
    expect(findWindowDisplay({ displayId: 2 }, [PRIMARY, SECONDARY])?.id).toBe(2)
    expect(findWindowDisplay({ displayId: 99 }, [PRIMARY, SECONDARY])).toBeNull()
  })

  it('主屏窗口 renderPet=true，isPrimaryDisplay=true', () => {
    const layout = computePetLayout(layoutInput())
    expect(layout.renderPet).toBe(true)
    expect(layout.isPrimaryDisplay).toBe(true)
    expect(layout.display?.id).toBe(1)
  })

  it('副屏窗口：不渲染宠物（透明空场景），尺寸归零', () => {
    const layout = computePetLayout(
      layoutInput({
        windowInfo: { bounds: { x: 1920, y: 0, width: 1920, height: 1055 }, displayId: 2 },
        viewport: { width: 1920, height: 1055 }
      })
    )
    expect(layout.renderPet).toBe(false)
    expect(layout.isPrimaryDisplay).toBe(false)
    expect(layout.petHeightPx).toBe(0)
    expect(computePetRect(layout, 0.7)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('未知 displayId（屏幕信息暂缺/竞态）：不渲染，不抛异常', () => {
    const layout = computePetLayout(layoutInput({ windowInfo: { ...PRIMARY_WINDOW, displayId: 99 } }))
    expect(layout.renderPet).toBe(false)
    expect(layout.display).toBeNull()
    expect(computePetRect(layout, 0.7)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('坐标换算：workArea ≠ bounds，本地坐标 = 全局 − window.bounds 原点', () => {
  it('主屏窗口 frame=workArea 时脚底贴视口底边（本地 y=961）', () => {
    const layout = computePetLayout(layoutInput())
    expect(layout.feetY).toBe(961)
    expect(layout.feetY).toBe(PRIMARY_VIEWPORT.height)
  })

  it('窗口从屏幕原点 (0,0) 开始时，脚底贴 workArea 底边（本地 y=991，不是 961）', () => {
    const layout = computePetLayout(
      layoutInput({
        windowInfo: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, displayId: 1 },
        viewport: { width: 1920, height: 1080 }
      })
    )
    // workArea 底边全局 y = 30 + 961 = 991；减窗口原点 y=0 → 991。
    expect(layout.feetY).toBe(991)
  })

  it('副屏（x 偏移 1920）作为主屏时，全局→本地换算正确', () => {
    const secondaryAsPrimary: DisplayInfo = { ...SECONDARY, isPrimary: true }
    const layout = computePetLayout(
      layoutInput({
        windowInfo: { bounds: { x: 1920, y: 0, width: 1920, height: 1055 }, displayId: 2 },
        displays: [PRIMARY, secondaryAsPrimary],
        viewport: { width: 1920, height: 1055 }
      })
    )
    expect(layout.renderPet).toBe(true)
    expect(layout.feetY).toBe(1055)
    // 右边缘全局 3840 − 窗口原点 1920 − margin(21) = 1899
    expect(layout.rightEdgeX).toBe(1899)
  })

  it('corner 边距：workArea 短边 2%（1920×961 → 19px），并限制在 8–32px', () => {
    expect(computeCornerMarginPx(PRIMARY)).toBe(19)
    expect(computeCornerMarginPx(null)).toBe(8)
    const tiny: DisplayInfo = {
      ...PRIMARY,
      workArea: { x: 0, y: 0, width: 200, height: 300 }
    }
    expect(computeCornerMarginPx(tiny)).toBe(8) // 300*2%=6 → 钳到 8
    const huge: DisplayInfo = {
      ...PRIMARY,
      workArea: { x: 0, y: 0, width: 7680, height: 4320 }
    }
    expect(computeCornerMarginPx(huge)).toBe(32) // 4320*2%=86.4 → 钳到 32
  })
})

describe('FALLBACK_MODEL_ASPECT：加载期占位 = 真实绑定姿势宽高比', () => {
  it('≈0.7373（真实模型基础姿势 0.73729；旧的 0.5 会让加载期 rect 偏窄 47%，F15）', () => {
    expect(FALLBACK_MODEL_ASPECT).toBeCloseTo(0.7373, 4)
    expect(FALLBACK_MODEL_ASPECT).toBeGreaterThan(0.7)
  })
})

describe('H-1 回归：workArea 原点变化后不得沿用启动时 windowInfo 快照', () => {
  it('菜单栏自动隐藏（workArea y 30→0、窗口 setBounds 同步）→ 刷新后 feetY=991 贴底', () => {
    const shifted: DisplayInfo = {
      ...PRIMARY,
      workArea: { x: 0, y: 0, width: 1920, height: 991 }
    }
    const refreshed = computePetLayout(
      layoutInput({
        windowInfo: { bounds: { x: 0, y: 0, width: 1920, height: 991 }, displayId: 1 },
        displays: [shifted, SECONDARY],
        viewport: { width: 1920, height: 991 }
      })
    )
    expect(refreshed.feetY).toBe(991)
    expect(refreshed.feetY).toBe(991) // workArea 底边全局 991 − 新窗口原点 0
  })

  it('反例：沿用旧窗口原点 y=30 会把脚底算成 961 → 悬浮 30px（H-1 的真实缺陷）', () => {
    const shifted: DisplayInfo = {
      ...PRIMARY,
      workArea: { x: 0, y: 0, width: 1920, height: 991 }
    }
    const stale = computePetLayout(
      layoutInput({
        // 旧快照：窗口 y=30（A1 已 setBounds 到 y=0，但 renderer 未重新 invoke pet:window-info）
        windowInfo: { bounds: { x: 0, y: 30, width: 1920, height: 991 }, displayId: 1 },
        displays: [shifted, SECONDARY],
        viewport: { width: 1920, height: 991 }
      })
    )
    expect(stale.feetY).toBe(961)
    // 视口高 991、脚底本地 y=961 → 宠物整体上浮 30px
    expect(991 - stale.feetY).toBe(30)
  })
})

describe('computePetRect：模型宽高比 + 锚点', () => {
  it('corner：右下角、贴 workArea 底边与右边缘', () => {
    const layout = computePetLayout(layoutInput())
    const rect = computePetRect(layout, 0.7)
    expect(rect.height).toBe(324)
    expect(rect.width).toBeCloseTo(226.8, 6)
    expect(rect.y).toBeCloseTo(637, 6) // 961 − 324
    expect(rect.x).toBeCloseTo(layout.rightEdgeX - 226.8, 6) // 1901 − 226.8
    expect(rect.x + rect.width).toBeCloseTo(layout.rightEdgeX, 6)
  })

  it('free：水平居中、脚底仍贴 workArea 底边', () => {
    const layout = computePetLayout(layoutInput({ position: 'free' }))
    expect(layout.anchor).toBe('center')
    const rect = computePetRect(layout, 0.7)
    expect(rect.x + rect.width / 2).toBeCloseTo(layout.centerX, 6) // 960
    expect(rect.y + rect.height).toBeCloseTo(961, 6)
  })

  it('宽高比非法（模型未加载 / NaN）时使用占位值，不产生 NaN', () => {
    const layout = computePetLayout(layoutInput())
    const rect = computePetRect(layout, Number.NaN)
    expect(Number.isFinite(rect.width)).toBe(true)
    expect(rect.width).toBeCloseTo(324 * FALLBACK_MODEL_ASPECT, 6)
    expect(Number.isFinite(rect.x)).toBe(true)
  })
})

describe('变化重算：resize / screens-updated 双保险', () => {
  it('视口缩小后重新计算并钳制进视口（feetY / rightEdgeX 不越界）', () => {
    const before = computePetLayout(layoutInput())
    expect(before.feetY).toBe(961)
    expect(before.rightEdgeX).toBe(1901)

    const after = computePetLayout(
      layoutInput({ viewport: { width: 1280, height: 700 } })
    )
    expect(after.feetY).toBe(700)
    expect(after.rightEdgeX).toBe(1280)
  })

  it('screens-updated：显示器 bounds 高度变化 → petHeightPx 随之重算', () => {
    const before = computePetLayout(layoutInput())
    expect(before.petHeightPx).toBe(324)
    const resizedDisplay: DisplayInfo = {
      ...PRIMARY,
      bounds: { ...PRIMARY.bounds, height: 900 },
      workArea: { ...PRIMARY.workArea, height: 781 }
    }
    const after = computePetLayout(
      layoutInput({
        displays: [resizedDisplay, SECONDARY],
        windowInfo: { ...PRIMARY_WINDOW, bounds: resizedDisplay.workArea },
        viewport: { width: 1920, height: 781 }
      })
    )
    expect(after.petHeightPx).toBe(270) // 900 × 30%
    expect(after.feetY).toBe(781)
  })

  it('screens-updated：显示器拓扑变化（主屏换到 id=2）→ 渲染开关翻转', () => {
    const before = computePetLayout(layoutInput())
    expect(before.renderPet).toBe(true)
    const primaryMoved: DisplayInfo[] = [
      { ...PRIMARY, isPrimary: false },
      { ...SECONDARY, isPrimary: true }
    ]
    const after = computePetLayout(layoutInput({ displays: primaryMoved }))
    expect(after.renderPet).toBe(false)
    expect(after.isPrimaryDisplay).toBe(false)
  })

  it('相同输入重复计算是纯函数（结果稳定，便于事件重入）', () => {
    const first = computePetLayout(layoutInput())
    const second = computePetLayout(layoutInput())
    expect(second).toEqual(first)
  })
})
