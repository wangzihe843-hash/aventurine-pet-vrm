/**
 * V1 手持道具（水枪）：`src/renderer/src/vrm/prop-config.ts` 纯逻辑单测。
 *
 * 覆盖（用户 2026-11-09：正常的、没有枪的动作都不要持枪；2026-11-09 task-5 数据驱动白名单）：
 * - 白名单 `clipIds`（app catalog id，adv- 前缀）非空时独占：命中显示、未命中隐藏（不再回落 set+tags）；
 * - 白名单为空时回退 `adv` + `skill` 兜底；三者全空用 DEFAULT；`hsr`/`mate` 不受影响；
 * - 内置 `watergun-attach.json` 的 7 条白名单行为（数据/官方实机证据见
 *   docs/research/watergun-adv-integration.md）；源 clip id（无 adv- 前缀）不误命中；
 * - `watergun-attach.json` 能通过清洗（四元数归一化、bounds 合法、policy 解析）；
 * - 非法配置返回 null（调用方降级为不加载道具）；
 * - catalog 解析：正常/坏 JSON/缺字段；加载失败返回恒 null 解析器（道具保持隐藏）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_HAND_PROP_POLICY,
  loadHandPropClipCatalog,
  parseClipMetaCatalog,
  sanitizeHandPropConfig,
  shouldHoldHandProp,
  WATERGUN_PROP_CONFIG,
  type HandPropClipMeta
} from '../src/renderer/src/vrm/prop-config'

const skillClip: HandPropClipMeta = { id: 'adv-skill01', set: 'adv', tags: ['show', 'skill'] }
const idleClip: HandPropClipMeta = { id: 'adv-idle', set: 'adv', tags: ['idle'] }
const walkClip: HandPropClipMeta = { id: 'adv-walk', set: 'adv', tags: ['walk'] }
const stunClip: HandPropClipMeta = { id: 'adv-stun', set: 'adv', tags: ['react'] }
const hsrSkillClip: HandPropClipMeta = { id: 'hsr-skill01', set: 'hsr', tags: ['show', 'skill'] }

describe('shouldHoldHandProp：只在真正的持武器动作显示', () => {
  it('adv + skill → 持枪', () => {
    expect(shouldHoldHandProp(skillClip)).toBe(true)
  })

  it('adv 的 idle/walk/stun → 不持枪', () => {
    expect(shouldHoldHandProp(idleClip)).toBe(false)
    expect(shouldHoldHandProp(walkClip)).toBe(false)
    expect(shouldHoldHandProp(stunClip)).toBe(false)
  })

  it('非 adv 动作集（hsr skill）→ 不持枪', () => {
    expect(shouldHoldHandProp(hsrSkillClip)).toBe(false)
  })

  it('null / undefined clip → 不持枪', () => {
    expect(shouldHoldHandProp(null)).toBe(false)
    expect(shouldHoldHandProp(undefined)).toBe(false)
  })

  it('clipIds 白名单非空时独占：命中 true、未命中 false（不再回落 set+tags）', () => {
    const policy = { ...DEFAULT_HAND_PROP_POLICY, clipIds: ['adv-skill01'] }
    expect(shouldHoldHandProp(skillClip, policy)).toBe(true)
    // adv+skill 但不在白名单 → 隐藏（数据驱动：skill tag 不再自动持枪）
    expect(shouldHoldHandProp({ id: 'adv-skill03', set: 'adv', tags: ['skill'] }, policy)).toBe(false)
    // 白名单命中时，即使动作普通/非 adv 也显示（显式覆盖语义）
    const idlePolicy = { ...DEFAULT_HAND_PROP_POLICY, clipIds: ['adv-idle', 'hsr-idle'] }
    expect(shouldHoldHandProp(idleClip, idlePolicy)).toBe(true)
    expect(shouldHoldHandProp({ id: 'hsr-idle', set: 'hsr', tags: ['idle'] }, idlePolicy)).toBe(true)
    // 非 adv/hsr/mate 的 clip 不在白名单 → 隐藏
    expect(shouldHoldHandProp(hsrSkillClip, policy)).toBe(false)
    expect(shouldHoldHandProp({ id: 'mate-idle', set: 'mate', tags: ['idle'] }, policy)).toBe(false)
  })

  it('clipIds 使用 app catalog id（adv- 前缀）：源 clip id 不误命中', () => {
    const policy = { ...DEFAULT_HAND_PROP_POLICY, clipIds: ['adv-skill01'] }
    expect(shouldHoldHandProp({ id: 'skill01', set: 'adv', tags: ['skill'] }, policy)).toBe(false)
  })

  it('全空规则回退到兜底（adv+skill，不误举枪）；空 tags 只看 set', () => {
    const unrestricted = { set: [], tags: [], clipIds: [] }
    expect(shouldHoldHandProp(idleClip, unrestricted)).toBe(false)
    expect(shouldHoldHandProp(skillClip, unrestricted)).toBe(true)
    const setOnly = { set: ['adv'], tags: [], clipIds: [] }
    expect(shouldHoldHandProp(idleClip, setOnly)).toBe(true)
    expect(shouldHoldHandProp(hsrSkillClip, setOnly)).toBe(false)
  })
})

describe('watergun-attach.json 清洗', () => {
  it('内置配置合法，且 policy 为数据驱动白名单（7 条 adv id）+ adv/skill 兜底', () => {
    expect(WATERGUN_PROP_CONFIG).not.toBeNull()
    const config = WATERGUN_PROP_CONFIG!
    expect(config.file).toBe('props/watergun/watergun.glb')
    expect(config.bone).toBe('rightHand')
    expect(config.policy.set).toEqual(['adv'])
    expect(config.policy.tags).toEqual(['skill'])
    expect(config.policy.clipIds).toEqual([
      'adv-skill01',
      'adv-mazeattack01',
      'adv-skill01readybs',
      'adv-skill01readyloop',
      'adv-skill01-ready',
      'adv-skill01-ready-loop',
      'adv-skill02toskill01'
    ])
    expect(config.bounds.expectedLengthMeters).toBeGreaterThan(0)
  })

  it('内置白名单行为：7 条命中持枪；其它 adv skill（过场技能）与 hsr/mate 一律隐藏', () => {
    const policy = WATERGUN_PROP_CONFIG!.policy
    for (const id of policy.clipIds) {
      expect(shouldHoldHandProp({ id, set: 'adv', tags: ['skill'] }, policy)).toBe(true)
    }
    // 源数据判定「源里武器骨不跟手」的过场技能（官方实机手中无枪）→ 隐藏
    for (const id of [
      'adv-skill02',
      'adv-skill03',
      'adv-skill03-ready',
      'adv-skill04',
      'adv-skill04-ready',
      'adv-skill04-ready-loop',
      'adv-skill41',
      'adv-mazeSkill',
      'adv-skill02readyloop',
      'adv-skill02-ready-loop',
      'adv-skill01toskill02'
    ]) {
      expect(shouldHoldHandProp({ id, set: 'adv', tags: ['skill'] }, policy)).toBe(false)
    }
    // 普通 adv 动作 + 非 adv 动作集不受影响
    for (const clip of [
      { id: 'adv-idle', set: 'adv', tags: ['idle'] },
      { id: 'adv-walk', set: 'adv', tags: ['walk'] },
      { id: 'adv-stun', set: 'adv', tags: ['react'] },
      { id: 'adv-attackStandby', set: 'adv', tags: ['idle', 'combat'] },
      { id: 'adv-idle2', set: 'adv', tags: ['idle'] }
    ]) {
      expect(shouldHoldHandProp(clip, policy)).toBe(false)
    }
    expect(shouldHoldHandProp({ id: 'hsr-skill01', set: 'hsr', tags: ['show', 'skill'] }, policy)).toBe(false)
    expect(shouldHoldHandProp({ id: 'mate-idle', set: 'mate', tags: ['idle'] }, policy)).toBe(false)
  })

  it('四元数归一化、位置/缩放保留', () => {
    const config = sanitizeHandPropConfig({
      schemaVersion: 1,
      propId: 'x',
      file: 'props/x.glb',
      bone: 'rightHand',
      position: [1, 2, 3],
      quaternion: [0, 0, 2, 0],
      scale: 2,
      bounds: { minLengthMeters: 0.1, maxLengthMeters: 1, expectedLengthMeters: 0.5 },
      policy: { holdSets: ['adv'], holdTags: ['skill'], holdClipIds: ['a'] }
    })
    expect(config).not.toBeNull()
    expect(config!.quaternion).toEqual([0, 0, 1, 0])
    expect(config!.position).toEqual([1, 2, 3])
    expect(config!.scale).toBe(2)
    expect(config!.policy.set).toEqual(['adv'])
    expect(config!.policy.clipIds).toEqual(['a'])
  })

  it('非法配置 → null（不加载道具）', () => {
    const base = {
      file: 'props/x.glb',
      bone: 'rightHand',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: 1,
      bounds: { minLengthMeters: 0.1, maxLengthMeters: 1, expectedLengthMeters: 0.5 },
      policy: { holdSets: ['adv'], holdTags: ['skill'], holdClipIds: [] }
    }
    expect(sanitizeHandPropConfig(null)).toBeNull()
    expect(sanitizeHandPropConfig({ ...base, file: '../escape.glb' })).toBeNull()
    expect(sanitizeHandPropConfig({ ...base, quaternion: [0, 0, 0, 0] })).toBeNull()
    expect(sanitizeHandPropConfig({ ...base, scale: 0 })).toBeNull()
    expect(
      sanitizeHandPropConfig({ ...base, bounds: { minLengthMeters: 2, maxLengthMeters: 1, expectedLengthMeters: 1.5 } })
    ).toBeNull()
    expect(sanitizeHandPropConfig({ ...base, position: [0, 0] })).toBeNull()
  })
})

describe('catalog 解析与容错', () => {
  it('解析 clips 的 set/tags；坏条目跳过', () => {
    const map = parseClipMetaCatalog(
      JSON.stringify({
        version: 1,
        clips: [
          { id: 'adv-skill01', set: 'adv', tags: ['skill', 'show'] },
          { id: 'adv-idle', set: 'adv', tags: ['idle'] },
          { set: 'adv' },
          null,
          { id: '', set: 'adv' }
        ]
      })
    )
    expect(map.size).toBe(2)
    expect(map.get('adv-skill01')).toEqual({ id: 'adv-skill01', set: 'adv', tags: ['skill', 'show'] })
    expect(map.get('adv-idle')?.tags).toEqual(['idle'])
  })

  it('坏 JSON / 缺 clips → 空映射（不抛）', () => {
    expect(parseClipMetaCatalog('not json').size).toBe(0)
    expect(parseClipMetaCatalog('{}').size).toBe(0)
  })

  it('loadHandPropClipCatalog：成功返回解析器；失败 warn 一次并返回恒 null', async () => {
    const ok = await loadHandPropClipCatalog({
      url: 'pet-asset://assets/motions/app-catalog.json',
      fetchText: async () =>
        JSON.stringify({ version: 1, clips: [{ id: 'adv-skill01', set: 'adv', tags: ['skill'] }] })
    })
    expect(ok('adv-skill01')?.tags).toEqual(['skill'])
    expect(ok('missing')).toBeNull()
    expect(ok(null)).toBeNull()

    const warn = vi.fn()
    const failed = await loadHandPropClipCatalog({
      url: 'pet-asset://assets/motions/app-catalog.json',
      fetchText: async () => {
        throw new Error('404')
      },
      warn
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(failed('adv-skill01')).toBeNull()
  })
})
