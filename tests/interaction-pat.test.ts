/**
 * 单测：B4 摸头圆形轨迹检测（`src/renderer/src/interaction/pat-detector.ts`）。
 *
 * 覆盖：完整圆形轨迹触发 pat / 直线轨迹不触发 / 来回蹭不触发 / 穿过中心不触发 /
 * 半径带外不触发 / 冷却 / 断笔与断笔过久 / progress 0–1 与停手衰减 / 参数覆盖。
 */
import { describe, expect, it } from 'vitest'

import type { Point2D } from '../src/renderer/src/core/wave2-contract'
import {
  getPatCenter,
  getPatRadiusBand,
  normalizeAngleRad,
  PAT_COOLDOWN_MS,
  PAT_MAX_SAMPLE_GAP_MS,
  PAT_PROGRESS_DECAY_START_MS,
  PAT_TRIGGER_ANGLE_RAD,
  PatDetector,
  PET_PAT_CENTER_Y_RATIO
} from '../src/renderer/src/interaction/pat-detector'

/** 宠物矩形 200×400；头中心 = (100, 400×0.13=52)；半径带 = [20, 112]px。 */
const PET = { x: 0, y: 0, width: 200, height: 400 }
const CENTER = { x: 100, y: 400 * PET_PAT_CENTER_Y_RATIO }

/** 生成圆周采样点（angle 从 0 递增）。 */
function circlePoints(radius: number, count: number, startAngle = 0): Point2D[] {
  const points: Point2D[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = startAngle + (i / count) * Math.PI * 2
    points.push({
      x: CENTER.x + Math.cos(angle) * radius,
      y: CENTER.y + Math.sin(angle) * radius
    })
  }
  return points
}

/** 按固定步长喂入采样，返回触发次数。 */
function feed(
  detector: PatDetector,
  points: readonly Point2D[],
  startMs = 0,
  stepMs = 16
): { triggers: number; lastTime: number } {
  let triggers = 0
  let time = startMs
  for (const point of points) {
    if (detector.sample(PET, point, time)) triggers += 1
    time += stepMs
  }
  return { triggers, lastTime: time - stepMs }
}

describe('摸头检测：圆形轨迹触发', () => {
  it('一圈（24 采样，半径 60px）触发且只触发一次', () => {
    const detector = new PatDetector()
    const { triggers } = feed(detector, circlePoints(60, 24))
    expect(triggers).toBe(1)
    expect(detector.lastTriggerAtMs).not.toBeNull()
  })

  it('约半圈：progress ≈ 0.47（累积角度 / 阈值）', () => {
    const detector = new PatDetector()
    const points = circlePoints(60, 24).slice(0, 10)
    const { lastTime } = feed(detector, points)
    const progress = detector.progress(lastTime)
    // 9 个有效角度增量 × (2π/24) ≈ 2.356 rad；阈值 1.6π ≈ 5.027 → ≈0.469
    expect(progress).toBeGreaterThan(0.4)
    expect(progress).toBeLessThan(0.55)
    expect(detector.accumulatedAngleRad).toBeGreaterThan(2.3)
  })

  it('慢速画圈（每采样 60ms，仍在 maxSampleGap 内）也能触发', () => {
    const detector = new PatDetector()
    const { triggers } = feed(detector, circlePoints(50, 32), 0, 60)
    expect(triggers).toBe(1)
  })
})

describe('摸头检测：非圆形/无效轨迹不触发', () => {
  it('水平直线（头中心上方弦）不触发：累计张角最多 π', () => {
    const detector = new PatDetector()
    const points: Point2D[] = []
    for (let i = 0; i < 21; i += 1) {
      points.push({ x: 50 + i * 5, y: CENTER.y - 52 })
    }
    const { triggers } = feed(detector, points)
    expect(triggers).toBe(0)
  })

  it('左右来回蹭（角度符号交替）不触发', () => {
    const detector = new PatDetector()
    const points: Point2D[] = []
    for (let i = 0; i < 40; i += 1) {
      const angle = i % 2 === 0 ? 0 : 0.5
      points.push({
        x: CENTER.x + Math.cos(angle) * 60,
        y: CENTER.y + Math.sin(angle) * 60
      })
    }
    const { triggers } = feed(detector, points)
    expect(triggers).toBe(0)
    expect(Math.abs(detector.accumulatedAngleRad)).toBeLessThan(0.6)
  })

  it('穿过头中心的直线不触发（半径带外 + 单步角过大 → 轨迹断裂）', () => {
    const detector = new PatDetector()
    const points: Point2D[] = []
    for (let i = 0; i < 21; i += 1) {
      points.push({ x: CENTER.x, y: CENTER.y - 200 + i * 20 })
    }
    const { triggers } = feed(detector, points)
    expect(triggers).toBe(0)
  })

  it('半径太小（贴中心抖动）/ 半径太大（大范围扫桌）都不触发', () => {
    const small = new PatDetector()
    expect(feed(small, circlePoints(10, 24)).triggers).toBe(0)

    const large = new PatDetector()
    expect(feed(large, circlePoints(180, 24)).triggers).toBe(0)
  })

  it('断笔（pointer=null）会清空连续累积', () => {
    const detector = new PatDetector()
    const circle = circlePoints(60, 24)
    feed(detector, circle.slice(0, 10), 0)
    detector.sample(PET, null, 160)
    const { triggers } = feed(detector, circle.slice(10), 176)
    expect(triggers).toBe(0)
  })

  it('两次采样间隔超过 maxSampleGap → 清空累积', () => {
    const detector = new PatDetector()
    const circle = circlePoints(60, 24)
    feed(detector, circle.slice(0, 10), 0)
    const { triggers } = feed(
      detector,
      circle.slice(10),
      160 + PAT_MAX_SAMPLE_GAP_MS + 50
    )
    expect(triggers).toBe(0)
  })
})

describe('摸头检测：冷却 / progress 衰减 / 复位', () => {
  it('冷却期内第二圈不触发；冷却结束后可再次触发', () => {
    const detector = new PatDetector()
    const first = feed(detector, circlePoints(60, 24), 0)
    expect(first.triggers).toBe(1)
    // 紧接着再画两圈（总时长 < 冷却） → 不触发
    const second = feed(detector, circlePoints(60, 48), first.lastTime + 16)
    expect(second.triggers).toBe(0)
    // 等冷却结束后再画一圈 → 触发第二次
    const afterCooldown = feed(
      detector,
      circlePoints(60, 24),
      first.lastTime + PAT_COOLDOWN_MS + 100,
      16
    )
    expect(afterCooldown.triggers).toBe(1)
    // 第三次触发后进入新的冷却
    expect(detector.isCoolingDown(afterCooldown.lastTime + 1)).toBe(true)
    expect(detector.isCoolingDown(afterCooldown.lastTime + PAT_COOLDOWN_MS + 1)).toBe(false)
  })

  it('触发后 progress 归零', () => {
    const detector = new PatDetector()
    const { triggers, lastTime } = feed(detector, circlePoints(60, 24))
    expect(triggers).toBe(1)
    expect(detector.progress(lastTime + 1)).toBe(0)
    expect(detector.progress(lastTime + PAT_COOLDOWN_MS + 500)).toBe(0)
  })

  it('停手后 progress 线性衰减到 0', () => {
    const detector = new PatDetector()
    const { lastTime } = feed(detector, circlePoints(60, 24).slice(0, 10))
    const atStop = detector.progress(lastTime)
    expect(atStop).toBeGreaterThan(0.4)
    // 衰减开始前仍保持
    expect(detector.progress(lastTime + PAT_PROGRESS_DECAY_START_MS)).toBeCloseTo(atStop, 5)
    // 衰减中点 ≈ 一半
    const half = detector.progress(lastTime + PAT_PROGRESS_DECAY_START_MS + 450)
    expect(half).toBeCloseTo(atStop / 2, 2)
    // 充分衰减后 = 0
    expect(detector.progress(lastTime + PAT_PROGRESS_DECAY_START_MS + 2000)).toBe(0)
  })

  it('reset 清空一切（进度/冷却/最近触发）', () => {
    const detector = new PatDetector()
    feed(detector, circlePoints(60, 24))
    expect(detector.lastTriggerAtMs).not.toBeNull()
    detector.reset()
    expect(detector.progress(10_000)).toBe(0)
    expect(detector.lastTriggerAtMs).toBeNull()
    expect(detector.isCoolingDown(0)).toBe(false)
  })

  it('非法矩形的采样安全返回 false', () => {
    const detector = new PatDetector()
    expect(detector.sample(null, { x: 0, y: 0 }, 0)).toBe(false)
    expect(detector.sample({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0 }, 0)).toBe(false)
  })
})

describe('几何辅助 / 参数', () => {
  it('getPatCenter / getPatRadiusBand 与比例一致', () => {
    expect(getPatCenter(PET)).toEqual({ x: 100, y: 52 })
    const band = getPatRadiusBand(PET)
    expect(band).not.toBeNull()
    expect(band!.minPx).toBeCloseTo(20, 6)
    expect(band!.maxPx).toBeCloseTo(112, 6)
    expect(getPatCenter(null)).toBeNull()
    expect(getPatRadiusBand({ x: 0, y: 0, width: 0, height: 0 })).toBeNull()
  })

  it('normalizeAngleRad 归一到 (-π, π]', () => {
    expect(normalizeAngleRad(0)).toBeCloseTo(0, 12)
    expect(normalizeAngleRad(Math.PI * 3)).toBeCloseTo(Math.PI, 6)
    expect(normalizeAngleRad(-Math.PI * 3)).toBeCloseTo(-Math.PI, 6)
    expect(normalizeAngleRad(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12)
  })

  it('参数覆盖：阈值调低/冷却调长生效', () => {
    const detector = new PatDetector({ triggerAngleRad: Math.PI * 0.5, cooldownMs: 5000 })
    const { triggers } = feed(detector, circlePoints(60, 24).slice(0, 10))
    expect(triggers).toBe(1)
    expect(detector.currentTuning.triggerAngleRad).toBeCloseTo(Math.PI * 0.5, 6)
    expect(detector.currentTuning.cooldownMs).toBe(5000)
    // 默认阈值下不会这么早触发（对照）
    const normal = new PatDetector()
    expect(feed(normal, circlePoints(60, 24).slice(0, 10)).triggers).toBe(0)
  })

  it('默认触发角度约为 1.6π', () => {
    expect(PAT_TRIGGER_ANGLE_RAD).toBeCloseTo(Math.PI * 1.6, 6)
  })
})
