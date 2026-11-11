import { describe, expect, it } from 'vitest'

import {
  WALK_LEVEL_FACTOR,
  WALK_SPEED_BODY_HEIGHTS_PER_SEC,
  naturalWalkSpeedPxPerSec,
  withNaturalWalkSpeed
} from '../src/renderer/src/core/pet-runtime'
import {
  effectiveNominalSpeedPxPerSec,
  resolvePlaybackRate,
  WALK_SPEED_REF_HEIGHT_PX
} from '../src/renderer/src/animation/legacy/external/selection'

/**
 * Wave 2.5 D3：走路速度与 VMD walk clip 自然步速的匹配。
 *
 * 背景：B1 原来按程序化姿态调的 62–112px/s，换成真实 VMD 走路后与 clip 自然步速
 * （≈470px/s @540px 高宠物）差 4–7 倍，播放速率被钳到 0.5× 仍滑步。D3 改成
 * 「体高相对自然步速」并在 VMD 层按宠物高度换算 nominal → 任意 sizePercent 下速率 ≈ 档位系数。
 */
describe('naturalWalkSpeedPxPerSec：体高相对自然步速', () => {
  it('540px 宠物 normal = 470px/s（与 motion-walk.vmd 原速同口径）', () => {
    expect(naturalWalkSpeedPxPerSec(540, 'normal')).toBeCloseTo(470, 6)
  })

  it('任意尺寸线性缩放：324px（30%）normal = 282px/s', () => {
    expect(naturalWalkSpeedPxPerSec(324, 'normal')).toBeCloseTo(282, 6)
    expect(naturalWalkSpeedPxPerSec(324, 'normal')).toBeCloseTo(
      naturalWalkSpeedPxPerSec(540, 'normal') * (324 / 540),
      6
    )
  })

  it('档位系数保持 low < normal < high 且与常量一致', () => {
    const low = naturalWalkSpeedPxPerSec(540, 'low')
    const normal = naturalWalkSpeedPxPerSec(540, 'normal')
    const high = naturalWalkSpeedPxPerSec(540, 'high')
    expect(low).toBeLessThan(normal)
    expect(normal).toBeLessThan(high)
    expect(normal / low).toBeCloseTo(WALK_LEVEL_FACTOR.normal / WALK_LEVEL_FACTOR.low, 6)
    expect(high / normal).toBeCloseTo(WALK_LEVEL_FACTOR.high / WALK_LEVEL_FACTOR.normal, 6)
  })

  it('非法/缺失宠物高度回退 540（不产生 NaN/0 速度）', () => {
    const fallback = naturalWalkSpeedPxPerSec(540, 'normal')
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      expect(naturalWalkSpeedPxPerSec(bad, 'normal')).toBeCloseTo(fallback, 6)
    }
  })
})

describe('withNaturalWalkSpeed：只改写 moveTo(walk)，其余指令原样', () => {
  const walk = {
    kind: 'moveTo' as const,
    target: { x: 100, y: 200 },
    speedPxPerSec: 86,
    mode: 'walk' as const
  }

  it('walk 指令速度替换为自然步速、target 保持不变', () => {
    const out = withNaturalWalkSpeed(walk, 540, 'normal')
    expect(out.kind).toBe('moveTo')
    expect(out).not.toBe(walk)
    if (out.kind !== 'moveTo') throw new Error('unreachable')
    expect(out.speedPxPerSec).toBeCloseTo(naturalWalkSpeedPxPerSec(540, 'normal'), 6)
    expect(out.target).toEqual(walk.target)
    expect(out.mode).toBe('walk')
  })

  it('速度已等于自然步速时返回同一对象（避免无意义克隆）', () => {
    const already = { ...walk, speedPxPerSec: naturalWalkSpeedPxPerSec(540, 'normal') }
    expect(withNaturalWalkSpeed(already, 540, 'normal')).toBe(already)
  })

  it('climb 指令不被改写（爬行速度仍由 B1 控制）', () => {
    const climb = { ...walk, mode: 'climb' as const, speedPxPerSec: 40 }
    expect(withNaturalWalkSpeed(climb, 540, 'normal')).toBe(climb)
  })

  it('hold / sit / drop / teleport 等非 moveTo 指令原样返回', () => {
    expect(withNaturalWalkSpeed({ kind: 'hold' }, 540, 'normal')).toEqual({ kind: 'hold' })
    expect(withNaturalWalkSpeed({ kind: 'sit', surfaceId: 's1' }, 540, 'normal')).toEqual({
      kind: 'sit',
      surfaceId: 's1'
    })
    expect(withNaturalWalkSpeed({ kind: 'drop' }, 540, 'normal')).toEqual({ kind: 'drop' })
    const teleport = { kind: 'teleport' as const, feet: { x: 1, y: 2 } }
    expect(withNaturalWalkSpeed(teleport, 540, 'normal')).toBe(teleport)
  })
})

describe('effectiveNominalSpeedPxPerSec：manifest nominal 按宠物高度换算', () => {
  it('参考高度 540 时原样返回（walk clip ≈470px/s）', () => {
    expect(effectiveNominalSpeedPxPerSec(470, 540)).toBeCloseTo(470, 6)
    expect(WALK_SPEED_REF_HEIGHT_PX).toBe(540)
  })

  it('按体高线性缩放（324px → 470×0.6=282）', () => {
    expect(effectiveNominalSpeedPxPerSec(470, 324)).toBeCloseTo(282, 6)
  })

  it('null/非法 nominal → null；非法高度回退参考高度', () => {
    expect(effectiveNominalSpeedPxPerSec(null, 540)).toBeNull()
    expect(effectiveNominalSpeedPxPerSec(undefined, 540)).toBeNull()
    expect(effectiveNominalSpeedPxPerSec(Number.NaN, 540)).toBeNull()
    expect(effectiveNominalSpeedPxPerSec(0, 540)).toBeNull()
    expect(effectiveNominalSpeedPxPerSec(-5, 540)).toBeNull()
    expect(effectiveNominalSpeedPxPerSec(470, Number.NaN)).toBeCloseTo(470, 6)
    expect(effectiveNominalSpeedPxPerSec(470, 0)).toBeCloseTo(470, 6)
  })

  it('与 naturalWalkSpeedPxPerSec 组合后：任意尺寸下播放速率 = 档位系数（不滑步）', () => {
    const nominalRef = 470
    for (const height of [108, 324, 540, 861]) {
      const naturalSpeed = naturalWalkSpeedPxPerSec(height, 'normal')
      const effectiveNominal = effectiveNominalSpeedPxPerSec(nominalRef, height)
      expect(effectiveNominal).not.toBeNull()
      expect(resolvePlaybackRate(effectiveNominal, naturalSpeed)).toBeCloseTo(
        WALK_LEVEL_FACTOR.normal,
        6
      )
    }
  })

  it('档位系数经钳制后仍在 [0.5,1.6]：low 0.8 / normal 1 / high 1.2 均可直接播放', () => {
    for (const [level, factor] of Object.entries(WALK_LEVEL_FACTOR) as [
      keyof typeof WALK_LEVEL_FACTOR,
      number
    ][]) {
      for (const height of [324, 540, 861]) {
        const rate = resolvePlaybackRate(
          effectiveNominalSpeedPxPerSec(470, height),
          naturalWalkSpeedPxPerSec(height, level)
        )
        expect(rate).toBeCloseTo(factor, 6)
      }
    }
  })
})
