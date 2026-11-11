/**
 * 单测：松手放置集成（`PetRuntime.endDrag` → 吸附窗口上沿 / 原地站定）。
 *
 * 背景（2026-11-09 用户实机反馈）：宠物被拎起来从高处松手后不会停在窗口上，而是掉到屏幕底。
 * 根因不是物理积分，而是「只认下落穿越窗沿」+ 可见窗沿几乎都贴屏幕顶（坐上去会出屏）。
 *
 * 本文件验证集成层行为：
 * 1. 松手时宠物压在**可坐**的窗口上 → 平滑吸附到该窗口可见上沿并落地（随后 B1 优先坐下）；
 * 2. 松手时压在**上沿太高**的窗口上（坐上去会大半出屏）→ 原地站定（不随重力下落、保持可见），
 *    且自主活动暂停（用户要求"原地待机、不要自己走开"），再次拎起后恢复；
 * 3. 松手点在桌面上 → 回退普通自由落体（回归）。
 *
 * 纯逻辑（注入时钟/随机），不依赖 Electron/DOM。
 */
import { describe, expect, it } from 'vitest'

import type { DisplayInfo, PetConfig, WindowInfo } from '@shared/types'

import {
  EMPTY_INTERACTION,
  PetRuntime,
  type PetRuntimeEnvironment
} from '../src/renderer/src/core/pet-runtime'
import type { InteractionSnapshot } from '../src/renderer/src/core/wave2-contract'

/** 1080p 主屏（菜单栏 30 → overlay 本地 workArea 高 961）。 */
const DISPLAY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 30, width: 1920, height: 961 },
  scaleFactor: 1,
  isPrimary: true
}

const CONFIG = {
  autonomous: true,
  autonomousLevel: 'normal',
  mischief: false,
  dshLink: false
} as unknown as PetConfig

/** 宠物尺寸 400×540（与实机 50% 尺寸一致；540 高决定"坐在 y=36 窗沿会出屏"）。 */
function makeEnv(): PetRuntimeEnvironment {
  return {
    workArea: { x: 0, y: 0, width: 1920, height: 961 },
    petSize: { width: 400, height: 540 },
    viewport: { width: 1920, height: 961 },
    overlayOrigin: { x: 0, y: 30 },
    display: DISPLAY
  }
}

function makeWindow(id: number, bounds: WindowInfo['bounds']): WindowInfo {
  return { id, pid: 100 + id, owner: `app-${id}`, layer: 0, alpha: 1, bounds, onScreen: true }
}

function dragging(): InteractionSnapshot {
  return { pointer: { x: 960, y: 700 }, hoveringPet: true, dragging: true, patProgress: 0 }
}

interface FrameOptions {
  nowMs: number
  interaction?: InteractionSnapshot
  events?: Parameters<PetRuntime['frame']>[0]['events']
}

function frame(runtime: PetRuntime, options: FrameOptions): ReturnType<PetRuntime['frame']> {
  return runtime.frame({
    nowMs: options.nowMs,
    dt: 0.016,
    interaction: options.interaction ?? EMPTY_INTERACTION,
    events: options.events ?? [],
    bubbleText: null
  })
}

/**
 * 模拟真实拖拽：抓起宠物（抓在身体上方 180px 处）→ 移到目标脚底点 → 停住 ~320ms（松手速度归零）。
 * 返回松手时刻（ms）。调用方随后调用 `runtime.endDrag(now)`。
 */
function liftPet(runtime: PetRuntime, startNow: number, targetFeet: { x: number; y: number }): number {
  const start = runtime.physics.getSnapshot().feet
  const pointerStart = { x: start.x, y: start.y - 180 }
  runtime.beginDrag(pointerStart, startNow)
  const offset = { x: start.x - pointerStart.x, y: start.y - pointerStart.y }
  const pointerTarget = { x: targetFeet.x - offset.x, y: targetFeet.y - offset.y }
  let now = startNow
  for (let index = 0; index < 40; index += 1) {
    now += 16
    runtime.dragTo(pointerTarget, now)
    frame(runtime, {
      nowMs: now,
      interaction: dragging(),
      events: index === 0 ? [{ kind: 'dragStart', pointer: pointerStart }] : []
    })
  }
  for (let index = 0; index < 20; index += 1) {
    now += 16
    runtime.dragTo(pointerTarget, now)
    frame(runtime, { nowMs: now, interaction: dragging() })
  }
  return now
}

/** 一直跑帧直到 pred 成立（返回成立时的帧输出；超时返回最后一帧）。 */
function runUntil(
  runtime: PetRuntime,
  startNow: number,
  pred: (output: ReturnType<PetRuntime['frame']>) => boolean,
  maxFrames = 240
): { output: ReturnType<PetRuntime['frame']>; now: number; frames: number } {
  let now = startNow
  let output = frame(runtime, { nowMs: now })
  let frames = 0
  while (!pred(output) && frames < maxFrames) {
    now += 16
    output = frame(runtime, { nowMs: now })
    frames += 1
  }
  return { output, now, frames }
}

describe('PetRuntime 松手放置：压在可坐窗口上 → 吸附上沿并落地', () => {
  it('慢速松手在被窗口覆盖的区域 → 平滑吸附到窗口可见上沿（grounded=sill）', () => {
    const runtime = new PetRuntime({ env: makeEnv(), config: CONFIG })
    // 窗口：全局 {300,400,1200,500} → 本地矩形 y=370，顶边可坐（headroom 370 ≥ 0.62×540+8）。
    runtime.updateWindows([makeWindow(7, { x: 300, y: 400, width: 1200, height: 500 })], 0)

    const releasedAt = liftPet(runtime, 0, { x: 960, y: 700 })
    runtime.endDrag(releasedAt)
    // 2026-11-10：直接吸附到位（没有"先滑过去/先落地"的中间站姿），并立刻请求坐下。
    const snapped = runtime.physics.getSnapshot()
    expect(runtime.physics.isPlacing()).toBe(false)
    expect(snapped.grounded).toBe(true)
    expect(snapped.surfaceId).toBe('win-7-top')
    expect(snapped.feet.y).toBe(370)
    expect(runtime.physics.isAnchored()).toBe(false)

    // 下一帧就应进入 sit（不再有 450ms 站立延迟）→「放到窗口上第一时间就是坐着」。
    const seated = runUntil(runtime, releasedAt, (output) => output.decision.mood === 'sit', 10)
    expect(seated.frames).toBeLessThanOrEqual(2)
    expect(seated.output.motion.surfaceId).toBe('win-7-top')
    expect(seated.output.motion.feet.y).toBe(370)
  })

  it('autonomous=false（自主活动关闭）时，放到可坐窗沿仍会坐下（2026-11-10 修复「站着不坐」）', () => {
    const configNoAuto = { ...CONFIG, autonomous: false } as unknown as PetConfig
    const runtime = new PetRuntime({ env: makeEnv(), config: configNoAuto })
    // 实机 Finder 几何（本地顶边 324）；50% 档 540px 宠物 → 可完整坐下。
    runtime.updateWindows([makeWindow(9, { x: 821, y: 354, width: 920, height: 436 })], 0)

    const releasedAt = liftPet(runtime, 0, { x: 1400, y: 700 })
    runtime.endDrag(releasedAt)
    const snapped = runtime.physics.getSnapshot()
    expect(snapped.grounded).toBe(true)
    expect(snapped.surfaceId).toBe('win-9-top')
    expect(snapped.feet.y).toBe(324)
    // 自主活动关闭，但「放到窗沿 → 立刻坐下」是直接反应，仍应立刻坐下（不是站着 idle）。
    const seated = runUntil(runtime, releasedAt, (output) => output.decision.mood === 'sit', 10)
    expect(seated.frames).toBeLessThanOrEqual(2)
    expect(seated.output.decision.mood).toBe('sit')
    expect(seated.output.motion.surfaceId).toBe('win-9-top')
    expect(seated.output.motion.grounded).toBe(true)
  })

  it('2026-11-10 放宽后：50% 档放在 top=324 的窗沿上 → 吸附并坐下（旧「上半身完整可见」规则会判不可坐→站定）', () => {
    const runtime = new PetRuntime({ env: makeEnv(), config: CONFIG })
    // 实机 Finder 几何：global {821,354,920,436} → 本地顶边 y=324；50% 档 540px 宠物
    // 新规则阈值 0.32×540=172.8 → 可坐（旧规则 0.62×540+8≈343 会拒绝）。
    runtime.updateWindows([makeWindow(9, { x: 821, y: 354, width: 920, height: 436 })], 0)

    const releasedAt = liftPet(runtime, 0, { x: 1400, y: 700 })
    runtime.endDrag(releasedAt)
    const snapped = runtime.physics.getSnapshot()
    expect(runtime.physics.isPlacing()).toBe(false)
    expect(runtime.physics.isAnchored()).toBe(false)
    expect(snapped.grounded).toBe(true)
    expect(snapped.surfaceId).toBe('win-9-top')
    expect(snapped.feet.y).toBe(324)

    const seated = runUntil(runtime, releasedAt, (output) => output.decision.mood === 'sit', 10)
    expect(seated.frames).toBeLessThanOrEqual(2)
    expect(seated.output.motion.surfaceId).toBe('win-9-top')
    expect(seated.output.motion.feet.y).toBe(324)
  })
})

describe('PetRuntime 松手放置：上沿太高/不可坐的窗口 → 正常掉落（保留落地眩晕链路）', () => {
  it('慢速松手在贴屏幕顶的大窗口上 → 不吸附、自由落体到屏幕底，落地产生 landed 事件', () => {
    const runtime = new PetRuntime({ env: makeEnv(), config: CONFIG })
    // 实机同款窗口：全局 {320,66,1280,820} → 本地顶边 y=36（坐上去宠物大半出屏 → 不可坐）。
    runtime.updateWindows([makeWindow(1, { x: 320, y: 66, width: 1280, height: 820 })], 0)

    const releasedAt = liftPet(runtime, 0, { x: 960, y: 500 })
    runtime.endDrag(releasedAt)
    // 2026-11-10 恢复：不可坐时不做「原地站定」，保持 airborne 走原自由落体物理。
    expect(runtime.physics.isPlacing()).toBe(false)
    expect(runtime.physics.isAnchored()).toBe(false)
    expect(runtime.physics.getSnapshot().airborne).toBe(true)

    let now = releasedAt
    let landedSeen = false
    let groundedAt = -1
    let landedOutput = null as ReturnType<PetRuntime['frame']> | null
    for (let index = 0; index < 240; index += 1) {
      now += 16
      const output = frame(runtime, { nowMs: now })
      if (output.animation.events.some((event) => event.kind === 'landed')) {
        landedSeen = true
        landedOutput = output
      }
      if (output.motion.grounded) {
        groundedAt = index
        break
      }
    }
    expect(groundedAt).toBeGreaterThanOrEqual(0)
    // 高处落地产生 landed 事件 → B3 播落地/眩晕反应（thrown→landed→hsr-stun/revive 链路保留）。
    expect(landedSeen).toBe(true)
    expect(landedOutput?.motion.grounded).toBe(true)
    const final = runtime.physics.getSnapshot()
    expect(final.feet.y).toBe(961)
    expect(['dock-bottom', 'screen-bottom']).toContain(final.surfaceId)
    expect(runtime.physics.isAnchored()).toBe(false)
  })
})

describe('PetRuntime 抛掷链路：thrown → landed（保留高处落地眩晕/受击反应）', () => {
  it('快速甩出（无窗口）→ 先抛 thrown，落地时发 landed（B3 据此播 hsr-stun/revive）', () => {
    const runtime = new PetRuntime({ env: makeEnv(), config: CONFIG })
    const releasedAt = liftPet(runtime, 0, { x: 960, y: 700 })
    // 甩出：给一个向上的初速 + 空中释放，走普通抛掷物理（不放置）。
    runtime.endDrag(releasedAt, { x: 0, y: -1200 })
    expect(runtime.physics.getSnapshot().airborne).toBe(true)

    let now = releasedAt
    let thrownSeen = false
    let landedSeen = false
    for (let index = 0; index < 360; index += 1) {
      now += 16
      const output = frame(runtime, { nowMs: now })
      for (const event of output.animation.events) {
        if (event.kind === 'thrown') thrownSeen = true
        if (event.kind === 'landed') landedSeen = true
      }
      if (landedSeen) break
    }
    expect(thrownSeen).toBe(true)
    expect(landedSeen).toBe(true)
  })
})

describe('PetRuntime 松手放置：桌面上 → 回退普通自由落体（回归）', () => {
  it('松手点不在任何窗口上 → 不放置，正常落到屏幕底部', () => {
    const runtime = new PetRuntime({ env: makeEnv(), config: CONFIG })
    // 窗口只在屏幕左上角；宠物松手点中心明显在窗口外。
    runtime.updateWindows([makeWindow(3, { x: 0, y: 30, width: 400, height: 500 })], 0)

    const releasedAt = liftPet(runtime, 0, { x: 1600, y: 400 })
    runtime.endDrag(releasedAt)
    expect(runtime.physics.isPlacing()).toBe(false)
    expect(runtime.physics.isAnchored()).toBe(false)
    expect(runtime.physics.getSnapshot().airborne).toBe(true)

    const landed = runUntil(runtime, releasedAt, (output) => output.motion.grounded, 240)
    expect(landed.output.motion.grounded).toBe(true)
    expect(landed.output.motion.feet.y).toBe(961)
    // 地面可能是 Dock 顶边（Dock 与 screen-bottom 同 y，Dock 优先级更高）。
    expect(['dock-bottom', 'screen-bottom']).toContain(landed.output.motion.surfaceId)
  })
})
