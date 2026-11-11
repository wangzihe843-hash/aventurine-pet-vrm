/**
 * 启动姿势门控单测（`src/renderer/src/vrm/startup-pose.ts`）。
 *
 * 背景：用户 2026-11-09 反馈启动时先闪 T/A-pose 再进 idle。修复分两层：
 * 1. clip-player 首次应用直接吸附（`tests/vrm-clip-player.test.ts` 有专项用例）；
 * 2. 场景层在「启动姿势完整应用」前隐藏模型（本文件覆盖其纯判定）。
 */
import { describe, expect, it } from 'vitest'

import type { AnimationDebugSnapshot } from '../src/renderer/src/core/wave2-contract'
import {
  STARTUP_POSE_WEIGHT_EPSILON,
  computeModelVisible,
  isStartupPoseApplied,
  startupPoseFallbackDue
} from '../src/renderer/src/vrm/startup-pose'

/** 构造最小 debug 快照（只关心 pose/poseWeight；其余字段不影响判定）。 */
function makeSnapshot(pose: string, poseWeight: number): AnimationDebugSnapshot {
  return { pose, poseWeight } as AnimationDebugSnapshot
}

describe('startup-pose：computeModelVisible（场景唯一可见性判定）', () => {
  it('三个条件全满足才可见', () => {
    expect(
      computeModelVisible({ petVisible: true, placed: true, startupPoseApplied: true })
    ).toBe(true)
  })

  it('启动姿势未应用 → 隐藏（即使宠物应显示且已摆放，也不许露 rest T/A-pose）', () => {
    expect(
      computeModelVisible({ petVisible: true, placed: true, startupPoseApplied: false })
    ).toBe(false)
  })

  it('未摆放 → 隐藏；宠物不可见 → 隐藏', () => {
    expect(
      computeModelVisible({ petVisible: true, placed: false, startupPoseApplied: true })
    ).toBe(false)
    expect(
      computeModelVisible({ petVisible: false, placed: true, startupPoseApplied: true })
    ).toBe(false)
  })
})

describe('startup-pose：isStartupPoseApplied（clip 姿势是否完整写入）', () => {
  it('null/undefined/rest → false（无 clip / 未就绪 / 静态降级）', () => {
    expect(isStartupPoseApplied(null)).toBe(false)
    expect(isStartupPoseApplied(undefined)).toBe(false)
    expect(isStartupPoseApplied(makeSnapshot('rest', 1))).toBe(false)
    expect(isStartupPoseApplied(makeSnapshot('', 1))).toBe(false)
  })

  it('首帧淡入中（weight<1）→ false；内部会从 rest 混出「既不像 T 也不像 A」的中间态', () => {
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', 0))).toBe(false)
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', 0.5))).toBe(false)
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', 1 - STARTUP_POSE_WEIGHT_EPSILON * 2))).toBe(
      false
    )
  })

  it('weight≈1 且非 rest → true（完整写入后才允许显示）', () => {
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', 1))).toBe(true)
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', 1 - STARTUP_POSE_WEIGHT_EPSILON / 2))).toBe(
      true
    )
    expect(isStartupPoseApplied(makeSnapshot('mate-sitWindow', 1.2))).toBe(true)
  })

  it('权重非法（NaN/Infinity）→ false（坏快照不得提前显示）', () => {
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', Number.NaN))).toBe(false)
    expect(isStartupPoseApplied(makeSnapshot('hsr-idle', Number.POSITIVE_INFINITY))).toBe(false)
  })
})

describe('startup-pose：startupPoseFallbackDue（降级兜底，避免永久隐身）', () => {
  it('尚未开始等待 → false', () => {
    expect(startupPoseFallbackDue(null, 10_000, 2500)).toBe(false)
  })

  it('未到超时 → false；到点/超过 → true', () => {
    expect(startupPoseFallbackDue(1_000, 3_499, 2500)).toBe(false)
    expect(startupPoseFallbackDue(1_000, 3_500, 2500)).toBe(true)
    expect(startupPoseFallbackDue(1_000, 9_999, 2500)).toBe(true)
  })

  it('时间/超时非法 → false（不因坏数据提前显示）', () => {
    expect(startupPoseFallbackDue(Number.NaN, 10_000, 2500)).toBe(false)
    expect(startupPoseFallbackDue(1_000, Number.NaN, 2500)).toBe(false)
    expect(startupPoseFallbackDue(1_000, 10_000, Number.NaN)).toBe(false)
    expect(startupPoseFallbackDue(1_000, 10_000, -1)).toBe(false)
  })
})
