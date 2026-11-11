/**
 * Wave 2.5：B1 目标表面的「可见性过滤」（防止坐下/爬到屏幕上方只剩脚）。
 *
 * 实机验证发现：屏幕最上方被最大化窗口的顶边会被 B5 标成 sittable；B2 把 feet 放到
 * surface.top 后宠物上半身跑到 workArea 外。集成层在给 B1 的 desktop 快照里过滤掉
 * 可见性不足的表面（只影响 B1 的坐/爬目标选择，不改变 B2 物理落点）。
 *
 * 2026-11-10 用户反馈「判定太严，只有 20% 尺寸能放到窗口上」+「头明明没顶到屏幕顶却
 * 还是被截掉」→ 修正坐姿 headroom 口径：窗沿坐时**头到髋**只占 (1−0.62)×H ≈ 0.38×H
 * （旧代码把 0.62 当成上半身高度，多算了 0.24×H，540px 宠物多要 ≈130px）。
 * 现在 540px（50% 档）阈值 ≈213px、756px（70% 档）≈295px：Finder 类窗沿（top=324）
 * 在 50%~79% 尺寸下都能**完整坐下**；爬行仍需全身高度。
 */
import { describe, expect, it } from 'vitest'

import {
  chooseSitWindowStyle,
  filterDesktopTargetsForPet,
  SIT_UPPER_BODY_RATIO,
  SIT_VARIANT_CLIP_ID,
  SIT_VARIANT_UPPER_RATIO,
  SURFACE_HEADROOM_MARGIN_PX
} from '../src/renderer/src/core/pet-runtime'
import type {
  DesktopSnapshot,
  DesktopSurface
} from '../src/renderer/src/core/wave2-contract'

function surface(overrides: Partial<DesktopSurface> = {}): DesktopSurface {
  return {
    id: 'win-1-top',
    kind: 'window-top',
    rect: { x: 0, y: 300, width: 1200, height: 1 },
    top: 300,
    windowId: 1,
    sittable: true,
    climbable: true,
    ...overrides
  }
}

function snapshot(surfaces: DesktopSurface[], workAreaY = 0): DesktopSnapshot {
  return {
    surfaces,
    transitions: [],
    workArea: { x: 0, y: workAreaY, width: 1920, height: 961 },
    screenBounds: { x: 0, y: 0, width: 1920, height: 1080 }
  }
}

describe('filterDesktopTargetsForPet：坐/爬目标必须全身可见', () => {
  it('headroom 足够的窗口表面保留 sittable/climbable', () => {
    const snap = snapshot([surface({ top: 900, rect: { x: 0, y: 900, width: 1200, height: 1 } })])
    const out = filterDesktopTargetsForPet(snap, 540)
    expect(out.surfaces[0]!.sittable).toBe(true)
    expect(out.surfaces[0]!.climbable).toBe(true)
    expect(out).toBe(snap) // 无变化返回原对象（避免每帧克隆）
  })

  it('只有 window-top 可坐：Dock / 地面 / 菜单栏即使 headroom 足够也不 sittable', () => {
    const snap = snapshot([
      surface({ id: 'dock', kind: 'dock', top: 900, rect: { x: 0, y: 899, width: 1920, height: 1 } }),
      surface({ id: 'bottom', kind: 'screen-bottom', top: 961, rect: { x: 0, y: 960, width: 1920, height: 1 } }),
      surface({ id: 'menubar', kind: 'menubar', top: 0, rect: { x: 0, y: 0, width: 1920, height: 1 } })
    ])
    const out = filterDesktopTargetsForPet(snap, 540)
    expect(out.surfaces.every((item) => item.sittable === false)).toBe(true)
  })

  it('屏幕最上方的边缘（headroom 过低）→ sittable/climbable 置 false', () => {
    // 540px 宠物：坐姿阈值 0.38×540+8≈213.2；爬行阈值 540+margin；top=59 两者都不够
    const snap = snapshot([
      surface({ id: 'win-hi-top', top: 59, rect: { x: 0, y: 59, width: 1920, height: 1 } })
    ])
    const out = filterDesktopTargetsForPet(snap, 540)
    expect(out).not.toBe(snap)
    expect(out.surfaces[0]!.sittable).toBe(false)
    expect(out.surfaces[0]!.climbable).toBe(false)
    // 其它字段保留（id/top/rect 不变，供物理/B5 继续使用）
    expect(out.surfaces[0]!.id).toBe('win-hi-top')
    expect(out.surfaces[0]!.top).toBe(59)
  })

  it('坐姿 headroom = 头到髋 (1−0.62)×身高 + margin；爬行仍需全身高度', () => {
    // 540px 宠物：sittable 阈值 0.38*540+8 ≈ 213.2；climbable 阈值 540+8 = 548
    const sitOnlyTop = 400
    const sitOnly = snapshot([surface({ top: sitOnlyTop, rect: { x: 0, y: sitOnlyTop, width: 800, height: 1 } })])
    const outSit = filterDesktopTargetsForPet(sitOnly, 540).surfaces[0]!
    expect(outSit.sittable).toBe(true)
    expect(outSit.climbable).toBe(false)

    const fullTop = 560
    const full = snapshot([surface({ top: fullTop, rect: { x: 0, y: fullTop, width: 800, height: 1 } })])
    expect(filterDesktopTargetsForPet(full, 540).surfaces[0]!.climbable).toBe(true)
  })

  it('2026-11-10 修正：50% 档（540px）top=324 可坐（旧 0.62×H 口径≈343 会拒绝）；70% 档（756px）仍可坐', () => {
    // 实机 Finder 窗沿本地 top=324：新口径 540px 宠物只需 ≈213 → 可完整坐下（头不出屏）。
    const finderTop = 324
    const finder = snapshot([
      surface({ id: 'win-324', top: finderTop, rect: { x: 0, y: finderTop, width: 900, height: 1 } })
    ])
    expect(filterDesktopTargetsForPet(finder, 540).surfaces[0]!.sittable).toBe(true)
    // 70% 档：756px → 阈值 0.38*756+8 ≈ 295.3 ≤ 324 → 仍可放（用户要求「70% 尺寸之内都可以放」）。
    expect(filterDesktopTargetsForPet(finder, 756).surfaces[0]!.sittable).toBe(true)
    // 80% 档：864px → 阈值 ≈336.3 > 324 → 完整坐不下（会截头）→ 不 assign sittable。
    expect(filterDesktopTargetsForPet(finder, 864).surfaces[0]!.sittable).toBe(false)
    // 边界：刚好低于 0.38×540+8≈213.2 的窗沿（如贴屏幕顶 y=100）仍不可坐（避免出头屏）。
    const high = snapshot([surface({ id: 'win-100', top: 100, rect: { x: 0, y: 100, width: 900, height: 1 } })])
    expect(filterDesktopTargetsForPet(high, 540).surfaces[0]!.sittable).toBe(false)
    // 阈值边界：213 不可坐 / 214 可坐（0.38*540+8 = 213.2）。
    const edgeFail = snapshot([surface({ id: 'win-213', top: 213, rect: { x: 0, y: 213, width: 900, height: 1 } })])
    const edgePass = snapshot([surface({ id: 'win-214', top: 214, rect: { x: 0, y: 214, width: 900, height: 1 } })])
    expect(filterDesktopTargetsForPet(edgeFail, 540).surfaces[0]!.sittable).toBe(false)
    expect(filterDesktopTargetsForPet(edgePass, 540).surfaces[0]!.sittable).toBe(true)
    // 坐姿阈值与爬行阈值解耦：top=324 可坐但不可爬（324 < 548）。
    expect(filterDesktopTargetsForPet(finder, 540).surfaces[0]!.climbable).toBe(false)
  })

  it('Dock/地面：climbable 由 headroom 决定、sittable 恒 false（只有窗口上沿可坐）', () => {
    const snap = snapshot([
      surface({ id: 'dock', kind: 'dock', top: 900, rect: { x: 0, y: 899, width: 1920, height: 1 } }),
      surface({ id: 'bottom', kind: 'screen-bottom', top: 961, rect: { x: 0, y: 960, width: 1920, height: 1 } })
    ])
    const out = filterDesktopTargetsForPet(snap, 540)
    expect(out.surfaces.every((item) => item.sittable)).toBe(false)
    expect(out.surfaces.every((item) => item.climbable)).toBe(true)
  })

  it('workArea.y 偏移时按相对 headroom 计算（窗口本地坐标可能不从 0 开始）', () => {
    // workArea.y=30；top=560 → headroom=530：够坐（≥213.2）、不够爬（<548）
    const snap = snapshot(
      [surface({ top: 560, rect: { x: 0, y: 560, width: 800, height: 1 } })],
      30
    )
    const out = filterDesktopTargetsForPet(snap, 540).surfaces[0]!
    expect(out.sittable).toBe(true)
    expect(out.climbable).toBe(false)
    // top=600 → headroom=570 ≥ 548 → 坐/爬都保留
    const ok = snapshot([surface({ top: 600, rect: { x: 0, y: 600, width: 800, height: 1 } })], 30)
    expect(filterDesktopTargetsForPet(ok, 540).surfaces[0]!.sittable).toBe(true)
    expect(filterDesktopTargetsForPet(ok, 540).surfaces[0]!.climbable).toBe(true)
  })

  it('不发生变化的表面对象保持引用；只在需要时替换整个 snapshot', () => {
    const keep = surface({ id: 'low', top: 800 })
    const drop = surface({ id: 'high', top: 100 })
    const snap = snapshot([keep, drop])
    const out = filterDesktopTargetsForPet(snap, 540)
    expect(out.surfaces[0]).toBe(keep)
    expect(out.surfaces[1]).not.toBe(drop)
    expect(out.transitions).toBe(snap.transitions)
  })

  it('非法宠物高度/空表 → 安全返回（不抛错）', () => {
    expect(filterDesktopTargetsForPet(snapshot([]), 540).surfaces).toHaveLength(0)
    const snap = snapshot([surface({ top: 100 })])
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = filterDesktopTargetsForPet(snap, bad)
      expect(out.surfaces[0]!.sittable).toBe(true) // 无法判断时不做过滤（保持旧行为）
    }
  })
})

/**
 * N-4（D6a 窄可见条）：遮挡裁剪把窗口顶边切成可见段后，只有 40px 宽的段仍 sittable，
 * 宠物（宽 ≈398px）身体 90% 会压在前层窗口本体上。集成层按「可见宽度 ≥ 0.5×宠宽」过滤，
 * 与 B5 `findSittableSurface` 的 minWidth 口径一致。
 */
describe('filterDesktopTargetsForPet：N-4 可坐表面最小可见宽度', () => {
  const PET_WIDTH = 398 // 540px 高、宽高比 ≈0.737 的宠物（≈398.1，取整便于断言阈值 199）

  it('40px 可见段被过滤（不可坐），600px 可见段保留', () => {
    const snap = snapshot([
      surface({ id: 'win-narrow-top', top: 800, rect: { x: 0, y: 800, width: 40, height: 1 } }),
      surface({ id: 'win-wide-top', top: 800, rect: { x: 0, y: 800, width: 600, height: 1 } })
    ])
    const out = filterDesktopTargetsForPet(snap, 540, PET_WIDTH)
    expect(out.surfaces[0]!.sittable).toBe(false) // 40 < 0.5×398=199
    expect(out.surfaces[1]!.sittable).toBe(true) // 600 ≥ 199
    // 窄段只是不再可坐：id/top 等字段保留（物理仍可站/落）
    expect(out.surfaces[0]!.id).toBe('win-narrow-top')
    expect(out.surfaces[0]!.top).toBe(800)
  })

  it('阈值边界：宽度 ≥ 0.5×宠宽保留（199 通过、198 过滤）', () => {
    const pass = snapshot([surface({ top: 800, rect: { x: 0, y: 800, width: 199, height: 1 } })])
    const fail = snapshot([surface({ top: 800, rect: { x: 0, y: 800, width: 198, height: 1 } })])
    expect(filterDesktopTargetsForPet(pass, 540, PET_WIDTH).surfaces[0]!.sittable).toBe(true)
    expect(filterDesktopTargetsForPet(fail, 540, PET_WIDTH).surfaces[0]!.sittable).toBe(false)
  })

  it('宽度过滤只作用于 sittable：climbable 仍由 headroom 决定', () => {
    const snap = snapshot([surface({ top: 900, rect: { x: 0, y: 900, width: 40, height: 1 } })])
    const out = filterDesktopTargetsForPet(snap, 540, PET_WIDTH).surfaces[0]!
    expect(out.sittable).toBe(false)
    expect(out.climbable).toBe(true) // top=900 → headroom 900 ≥ 548
  })

  it('petWidth 缺省/非法 → 不启用宽度过滤（保持旧语义，兼容旧调用方）', () => {
    const snap = snapshot([
      surface({ top: 800, rect: { x: 0, y: 800, width: 40, height: 1 } })
    ])
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(filterDesktopTargetsForPet(snap, 540, bad).surfaces[0]!.sittable).toBe(true)
    }
  })

  it('签名扩展后第 4 参 margin 仍生效（只作用于爬行 headroom；坐姿阈值由可见比例精确推导）', () => {
    // top=542：margin=0 → 爬行阈值 540（542 ≥ 540 可爬）；margin=8 → 548（542 < 548 不可爬）。
    const snap = snapshot([surface({ top: 542, rect: { x: 0, y: 542, width: 600, height: 1 } })])
    expect(filterDesktopTargetsForPet(snap, 540, PET_WIDTH, 0).surfaces[0]!.climbable).toBe(true)
    expect(filterDesktopTargetsForPet(snap, 540, PET_WIDTH, 8).surfaces[0]!.climbable).toBe(false)
    // 坐姿不受 margin 影响（542 远超 0.32×540）。
    expect(filterDesktopTargetsForPet(snap, 540, PET_WIDTH, 8).surfaces[0]!.sittable).toBe(true)
  })

  it('表面 rect.width 非法（NaN/缺省）→ 不做宽度判断（无法判断时保持旧行为）', () => {
    const nan = snapshot([surface({ top: 800, rect: { x: 0, y: 800, width: Number.NaN, height: 1 } })])
    expect(filterDesktopTargetsForPet(nan, 540, PET_WIDTH).surfaces[0]!.sittable).toBe(true)
  })
})

/* ========================================================================== */
/* chooseSitWindowStyle：窗沿坐 vs 趴/躺（按 headroom 选，2026-11-10）          */
/* ========================================================================== */

describe('chooseSitWindowStyle：窗沿坐姿（变体臀部贴沿 / 标准坐兜底）', () => {
  const WORK = { workAreaY: 0, workAreaHeight: 961 }
  const SILL = 324 // 实机 Finder 可见上沿（overlay 本地）

  it('20% 档（216px）：坐姿变体放得下 → sitVariant（animator 随机 windowLay8/9/10）', () => {
    const choice = chooseSitWindowStyle({ surfaceTop: SILL, petHeightPx: 216, ...WORK })
    expect(choice.mode).toBe('sitVariant')
    expect(choice.clipId).toBe(SIT_VARIANT_CLIP_ID)
    expect(choice.sinkPx).toBe(0)
    expect(SILL >= 216 * SIT_VARIANT_UPPER_RATIO + SURFACE_HEADROOM_MARGIN_PX).toBe(true)
  })

  it('50% 档（540px）：坐姿变体仍放得下 → sitVariant（臀部贴沿、腿垂下，才是「坐在窗口上」）', () => {
    const choice = chooseSitWindowStyle({ surfaceTop: SILL, petHeightPx: 540, ...WORK })
    expect(choice.mode).toBe('sitVariant')
    expect(choice.clipId).toBe(SIT_VARIANT_CLIP_ID)
    expect(SILL >= 540 * SIT_VARIANT_UPPER_RATIO + SURFACE_HEADROOM_MARGIN_PX).toBe(true)
  })

  it('70% 档（756px）：坐姿变体仍放得下（臀部贴沿后仅占头到髋 0.38×H）→ sitVariant', () => {
    const choice = chooseSitWindowStyle({ surfaceTop: SILL, petHeightPx: 756, ...WORK })
    expect(choice.mode).toBe('sitVariant')
    expect(choice.clipId).toBe(SIT_VARIANT_CLIP_ID)
    // 0.38*756+8 ≈295 ≤ 324 → 头完整可见（2026-11-10 用户要求 70% 尺寸也能坐）
    expect(756 * SIT_VARIANT_UPPER_RATIO + SURFACE_HEADROOM_MARGIN_PX).toBeLessThan(SILL)
    expect(SIT_VARIANT_UPPER_RATIO).toBe(SIT_UPPER_BODY_RATIO)
  })

  it('矮窗（上沿在屏幕下半部）→ 始终标准 sit（沿用「矮窗坐」策略）', () => {
    expect(chooseSitWindowStyle({ surfaceTop: 700, petHeightPx: 216, ...WORK }).mode).toBe('sit')
    expect(chooseSitWindowStyle({ surfaceTop: 800, petHeightPx: 432, ...WORK }).mode).toBe('sit')
  })

  it('非法输入 → sit（不抛）', () => {
    expect(chooseSitWindowStyle({ surfaceTop: Number.NaN, petHeightPx: 540, ...WORK }).mode).toBe('sit')
    expect(chooseSitWindowStyle({ surfaceTop: SILL, petHeightPx: Number.NaN, ...WORK }).mode).toBe('sit')
    expect(
      chooseSitWindowStyle({ surfaceTop: SILL, petHeightPx: 0, workAreaY: 0, workAreaHeight: 961 })
        .mode
    ).toBe('sit')
  })
})
