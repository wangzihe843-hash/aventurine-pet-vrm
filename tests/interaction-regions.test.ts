/**
 * 单测：B4 区域命中（`src/renderer/src/interaction/regions.ts`）。
 *
 * 覆盖：头/躯干/腿分带边界（半开区间）、头形水平收窄、矩形外/非法输入、
 * 归一化坐标、区域矩形（debug/测试口径）、头部带 vs 头形区分。
 *
 * V7 追加：用 VRM humanoid 的真实比例（体高 1.7347m、`bodyAspectRatio=0.30` → 540px 高时
 * 宽 162px、头/发丝剪影 ≈ 0.140×高）验证命中带仍合理；并用 `PatDetector` 跑一条真实比例的
 * 摸头圆轨迹（摸头判定走 `hitTestHeadBand`，不依赖横向收窄）。
 */
import { describe, expect, it } from 'vitest'

import {
  hitTestHeadBand,
  hitTestHeadShape,
  hitTestRegion,
  normalizePetPoint,
  REGION_RATIOS,
  regionBounds
} from '../src/renderer/src/interaction/regions'
import {
  getPatCenter,
  getPatRadiusBand,
  PatDetector
} from '../src/renderer/src/interaction/pat-detector'

/** 宠物矩形（窗口本地 CSS px）：200×400，左上 (100, 200)。 */
const PET = { x: 100, y: 200, width: 200, height: 400 }

describe('hitTestRegion：分带边界', () => {
  it('顶部头部带中心 → head；头形水平范围 [0.28, 0.72]', () => {
    expect(hitTestRegion(PET, { x: 200, y: 210 })).toBe('head')
    expect(hitTestRegion(PET, { x: 200, y: 250 })).toBe('head')
    // 头带下边界前 0.1px 仍是 head
    expect(hitTestRegion(PET, { x: 200, y: 200 + 400 * 0.2999 })).toBe('head')
    // 正好 0.30 → body（半开区间：下边界归下一带）
    expect(hitTestRegion(PET, { x: 200, y: 200 + 400 * 0.3 })).toBe('body')
  })

  it('头形收窄：头带内但水平超出 [0.28, 0.72] 的点归 body', () => {
    // nx = 0.2 → 收窄范围外（肩/手臂）
    expect(hitTestRegion(PET, { x: 100 + 200 * 0.2, y: 250 })).toBe('body')
    // nx = 0.27（差 0.01）→ body
    expect(hitTestRegion(PET, { x: 100 + 200 * 0.27, y: 250 })).toBe('body')
    // 收窄左边界 nx = 0.28 → head
    expect(hitTestRegion(PET, { x: 100 + 200 * 0.28, y: 250 })).toBe('head')
    // 收窄右边界 nx = 0.72 是半开区间 → body
    expect(hitTestRegion(PET, { x: 100 + 200 * 0.72, y: 250 })).toBe('body')
    // 略小于 0.72 → head
    expect(hitTestRegion(PET, { x: 100 + 200 * 0.7199, y: 250 })).toBe('head')
  })

  it('躯干带 [0.30, 0.55) → body；腿 [0.55, 1) → leg', () => {
    expect(hitTestRegion(PET, { x: 200, y: 200 + 400 * 0.4 })).toBe('body')
    expect(hitTestRegion(PET, { x: 200, y: 200 + 400 * 0.5499 })).toBe('body')
    expect(hitTestRegion(PET, { x: 200, y: 200 + 400 * 0.55 })).toBe('leg')
    expect(hitTestRegion(PET, { x: 200, y: 200 + 400 * 0.9 })).toBe('leg')
    // 躯干/腿带全宽（含手臂位置）
    expect(hitTestRegion(PET, { x: 105, y: 350 })).toBe('body')
    expect(hitTestRegion(PET, { x: 295, y: 500 })).toBe('leg')
  })

  it('半开区间：左/上边界命中，右/下边界不命中；矩形外 → null', () => {
    expect(hitTestRegion(PET, { x: 100, y: 200 })).toBe('body') // 左上角 → ny=0 → head 带但 nx=0 → body
    expect(hitTestRegion(PET, { x: 300, y: 250 })).toBeNull() // 右边界
    expect(hitTestRegion(PET, { x: 200, y: 600 })).toBeNull() // 下边界
    expect(hitTestRegion(PET, { x: 99, y: 250 })).toBeNull()
    expect(hitTestRegion(PET, { x: 200, y: 199 })).toBeNull()
  })

  it('非法输入安全返回 null（不抛）', () => {
    expect(hitTestRegion(null, { x: 200, y: 250 })).toBeNull()
    expect(hitTestRegion(undefined, { x: 200, y: 250 })).toBeNull()
    expect(hitTestRegion({ x: 0, y: 0, width: 0, height: 400 }, { x: 0, y: 0 })).toBeNull()
    expect(hitTestRegion({ x: 0, y: 0, width: 200, height: -1 }, { x: 0, y: 0 })).toBeNull()
    expect(hitTestRegion(PET, { x: Number.NaN, y: 250 })).toBeNull()
    expect(hitTestRegion(PET, { x: 200, y: Number.POSITIVE_INFINITY })).toBeNull()
  })
})

describe('normalizePetPoint / 头部辅助判定', () => {
  it('归一化坐标：中心 (0.5, 0.5)，边界半开', () => {
    expect(normalizePetPoint(PET, { x: 200, y: 400 })).toEqual({ nx: 0.5, ny: 0.5 })
    expect(normalizePetPoint(PET, { x: 100, y: 200 })).toEqual({ nx: 0, ny: 0 })
    expect(normalizePetPoint(PET, { x: 300, y: 400 })).toBeNull()
  })

  it('hitTestHeadBand 不要求水平收窄（画圈轨迹宽容判定）', () => {
    expect(hitTestHeadBand(PET, { x: 110, y: 250 })).toBe(true)
    expect(hitTestHeadBand(PET, { x: 200, y: 200 + 400 * 0.3 })).toBe(false)
    expect(hitTestHeadBand(null, { x: 110, y: 250 })).toBe(false)
  })

  it('hitTestHeadShape 等价于 hitTestRegion === head', () => {
    expect(hitTestHeadShape(PET, { x: 200, y: 250 })).toBe(true)
    expect(hitTestHeadShape(PET, { x: 110, y: 250 })).toBe(false)
    expect(hitTestHeadShape(PET, { x: 200, y: 400 })).toBe(false)
  })
})

describe('regionBounds：区域矩形（调试/测试口径）', () => {
  it('head 收窄、body/leg 全宽，且比例与 REGION_RATIOS 一致', () => {
    const head = regionBounds(PET, 'head')
    expect(head).not.toBeNull()
    expect(head!.x).toBeCloseTo(100 + 200 * REGION_RATIOS.headXMin, 6)
    expect(head!.width).toBeCloseTo(200 * (REGION_RATIOS.headXMax - REGION_RATIOS.headXMin), 6)
    expect(head!.y).toBe(200)
    expect(head!.height).toBeCloseTo(400 * REGION_RATIOS.headBottom, 6)

    const body = regionBounds(PET, 'body')
    expect(body!.x).toBe(100)
    expect(body!.width).toBe(200)
    expect(body!.y).toBeCloseTo(200 + 400 * REGION_RATIOS.headBottom, 6)
    expect(body!.height).toBeCloseTo(
      400 * (REGION_RATIOS.bodyBottom - REGION_RATIOS.headBottom),
      6
    )

    const leg = regionBounds(PET, 'leg')
    expect(leg!.y).toBeCloseTo(200 + 400 * REGION_RATIOS.bodyBottom, 6)
    expect(leg!.height).toBeCloseTo(400 * (1 - REGION_RATIOS.bodyBottom), 6)
  })

  it('非法矩形返回 null', () => {
    expect(regionBounds(null, 'head')).toBeNull()
    expect(regionBounds({ x: 0, y: 0, width: 0, height: 10 }, 'body')).toBeNull()
  })
})

/* ========================================================================== */
/* V7：VRM humanoid 真实比例下的命中带核查（bodyAspectRatio=0.30）               */
/* ========================================================================== */

/**
 * 实测数据（`assets/vrm/aventurine-tpose.vrm`，rest 姿势，Node 直接解析 GLB）：
 * - 顶点包围盒高 1.7347m（脚底 0.0007m）；
 * - humanoid 骨高度（距顶比例）：head 11.28%、neck 15.53%、upperArm 19.56%、
 *   hips 38.56%、upperLeg 43.60%、lowerLeg(膝) 68.73%、foot 94.33%
 *   ——与本文件头部注释里的 PMX 比例（11.3/15.5/19.6/38.6/68.8%）一致；
 * - 头/发丝顶点横向宽度 0.243m = 0.140×高（`bodyAspectRatio` clamp 到 0.30，
 *   即命中矩形宽 = 0.30×高，头宽 ≈ 0.467×矩形宽 → 头带 [0.28,0.72] 恰好贴合）。
 */
const VRM_RECT = { x: 100, y: 200, width: 162, height: 540 }

describe('V7：VRM 比例命中带（宽 162 @540）', () => {
  const centerX = VRM_RECT.x + VRM_RECT.width / 2
  /** VRM 头/发丝剪影半宽（540px 高 × 0.1401 / 2 ≈ 37.8px）。 */
  const headHalfPx = (540 * 0.1401) / 2

  it('头/发丝剪影占矩形宽 46.7%：head 带 [0.28,0.72] 完整覆盖，边缘只差 ~2px', () => {
    const headWidthRatio = (headHalfPx * 2) / VRM_RECT.width
    expect(headWidthRatio).toBeCloseTo(0.467, 2)
    // 头部带内的中心 44% 全部归 head（与发丝剪影重合，够点到头）。
    for (const nx of [0.28, 0.35, 0.5, 0.65, 0.7199]) {
      expect(hitTestRegion(VRM_RECT, { x: VRM_RECT.x + VRM_RECT.width * nx, y: 200 + 540 * 0.13 })).toBe(
        'head'
      )
    }
    // 剪影左右边缘（nx ≈ 0.2665 / 0.7335）略出收窄带 → body（容差 ~2px；
    // 摸头判定走 hitTestHeadBand 不受影响，戳头边缘只会算身体）。
    expect(hitTestRegion(VRM_RECT, { x: centerX + headHalfPx, y: 200 + 540 * 0.13 })).toBe('body')
    expect(hitTestHeadBand(VRM_RECT, { x: centerX + headHalfPx, y: 200 + 540 * 0.13 })).toBe(true)
  })

  it('纵向骨比例：头顶/头骨/颈/肩(带内)→head；胸/髋/大腿→body；膝/脚→leg', () => {
    const yOf = (ratio: number): number => VRM_RECT.y + VRM_RECT.height * ratio
    // 头骨 11.28%、颈 15.53%：水平中心 → head。
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.1128) })).toBe('head')
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.1553) })).toBe('head')
    // 肩 19.56%：中心仍是 head 带（设计：头带含颈部过渡）；横向远离中心 → body。
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.1956) })).toBe('head')
    expect(
      hitTestRegion(VRM_RECT, { x: VRM_RECT.x + VRM_RECT.width * 0.1, y: yOf(0.1956) })
    ).toBe('body')
    // 胸 27.3%：中心 head（头带下界 30% 内）；髋 38.56%、大腿 43.6% → body。
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.273) })).toBe('head')
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.3856) })).toBe('body')
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.436) })).toBe('body')
    // 膝 68.73%、脚 94.33% → leg。
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.6873) })).toBe('leg')
    expect(hitTestRegion(VRM_RECT, { x: centerX, y: yOf(0.9433) })).toBe('leg')
  })

  it('头形水平收窄对 VRM 宽度仍生效（nx 0.2 / 0.8 的头部带点归 body）', () => {
    const y = VRM_RECT.y + VRM_RECT.height * 0.13
    expect(hitTestRegion(VRM_RECT, { x: VRM_RECT.x + VRM_RECT.width * 0.2, y })).toBe('body')
    expect(hitTestRegion(VRM_RECT, { x: VRM_RECT.x + VRM_RECT.width * 0.8, y })).toBe('body')
    expect(hitTestHeadBand(VRM_RECT, { x: VRM_RECT.x + VRM_RECT.width * 0.2, y })).toBe(true)
    // 区域矩形随宽度缩放（调试/菜单用）：head 区矩形宽 ≈ 71.3px。
    const headBounds = regionBounds(VRM_RECT, 'head')
    expect(headBounds?.width).toBeCloseTo(162 * (0.72 - 0.28), 6)
    expect(headBounds?.height).toBeCloseTo(540 * 0.3, 6)
  })

  it('摸头（真实比例圆轨迹）：头中心 13% + 半径 60px 整圈 → 触发 pat', () => {
    const center = getPatCenter(VRM_RECT)
    const band = getPatRadiusBand(VRM_RECT)
    expect(center).not.toBeNull()
    expect(band).not.toBeNull()
    expect(band?.minPx).toBeCloseTo(540 * 0.05, 6) // 27px
    expect(band?.maxPx).toBeCloseTo(540 * 0.28, 6) // 151.2px
    // 半径 60px 在半径带内；整圈累积 2π > 1.6π → 应触发一次摸头。
    const detector = new PatDetector()
    const radius = 60
    let triggered = false
    for (let index = 0; index <= 36; index += 1) {
      const angle = (index / 36) * Math.PI * 2
      const point = {
        x: (center as { x: number }).x + radius * Math.cos(angle),
        y: (center as { y: number }).y + radius * Math.sin(angle)
      }
      if (detector.sample(VRM_RECT, point, index * 30)) triggered = true
    }
    expect(triggered).toBe(true)
    // 圆轨迹点都落在头带内（摸头不会误判成身体/腿）。
    const samplePoint = {
      x: (center as { x: number }).x + radius,
      y: (center as { y: number }).y
    }
    expect(hitTestHeadBand(VRM_RECT, samplePoint)).toBe(true)
  })
})
