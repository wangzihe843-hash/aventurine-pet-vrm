/**
 * 单测：设置面板纯逻辑（`src/renderer/src/settings/settings-model.ts`，Wave 2 B6）。
 *
 * 覆盖 task-6 验收条款：config→view model、控件变更→Partial<PetConfig>、钳制/枚举回退、
 * 尺寸 px 换算（bounds/workArea 封顶）、默认恢复 payload、权限/DSH 展示文案、错误文案。
 * 纯函数，无 DOM/Electron 依赖。
 */
import { describe, expect, it } from 'vitest'

import { CONFIG_LIMITS, DEFAULT_CONFIG } from '@shared/config'
import type { AccessibilityStatus, DisplayInfo, DshStatus, PetConfig } from '@shared/types'

import {
  DEFAULT_SCREEN_METRICS,
  clampFpsCap,
  clampNumber,
  clampOpacity,
  clampSizePercent,
  computePetHeightPx,
  defaultsPatch,
  describeDshStatus,
  describePermissions,
  describeSize,
  formatErrorText,
  formatFps,
  formatOpacityPercent,
  formStateFromConfig,
  maxSizePercent,
  normalizeAutonomousLevel,
  patchForField,
  screenMetricsFromDisplay,
  screenMetricsFromDisplays
} from '../src/renderer/src/settings/settings-model'

/** 造一份完整配置（默认值 + 覆盖）。 */
function configWith(partial: Partial<PetConfig>): PetConfig {
  return { ...DEFAULT_CONFIG, ...partial }
}

/** 造显示器信息。 */
function displayWith(partial: Partial<DisplayInfo> = {}): DisplayInfo {
  return {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 30, width: 1920, height: 961 },
    scaleFactor: 1,
    isPrimary: true,
    ...partial
  }
}

/** 造 DSH 状态。 */
function dshStatus(partial: Partial<DshStatus> = {}): DshStatus {
  return { online: true, running: false, lastEventAt: 0, lastType: null, ...partial }
}

/** 造权限状态。 */
function permissions(partial: Partial<AccessibilityStatus> = {}): AccessibilityStatus {
  return { accessibility: false, notifications: 'unknown', ...partial }
}

describe('数值钳制', () => {
  it('clampNumber：非法回退、区间钳制、区间内原样', () => {
    expect(clampNumber(5, 10, 100, 50)).toBe(10)
    expect(clampNumber(150, 10, 100, 50)).toBe(100)
    expect(clampNumber(42, 10, 100, 50)).toBe(42)
    expect(clampNumber(Number.NaN, 10, 100, 50)).toBe(50)
    expect(clampNumber('42', 10, 100, 50)).toBe(50)
    expect(clampNumber(Infinity, 10, 100, 50)).toBe(50)
  })

  it('clampSizePercent：10–100 整数，非法回退默认 50', () => {
    expect(clampSizePercent(5)).toBe(CONFIG_LIMITS.sizePercent.min)
    expect(clampSizePercent(150)).toBe(CONFIG_LIMITS.sizePercent.max)
    expect(clampSizePercent(30)).toBe(30)
    expect(clampSizePercent(50.6)).toBe(51)
    expect(clampSizePercent(Number.NaN)).toBe(DEFAULT_CONFIG.sizePercent)
    expect(clampSizePercent('huge')).toBe(DEFAULT_CONFIG.sizePercent)
  })

  it('clampOpacity：0.3–1 保留两位小数', () => {
    expect(clampOpacity(0.1)).toBe(CONFIG_LIMITS.opacity.min)
    expect(clampOpacity(2)).toBe(1)
    expect(clampOpacity(0.555)).toBe(0.56)
    expect(clampOpacity(0.3)).toBe(0.3)
    expect(clampOpacity(Number.NaN)).toBe(DEFAULT_CONFIG.opacity)
  })

  it('clampFpsCap：5–60 整数', () => {
    expect(clampFpsCap(1)).toBe(CONFIG_LIMITS.fpsCap.min)
    expect(clampFpsCap(120)).toBe(CONFIG_LIMITS.fpsCap.max)
    expect(clampFpsCap(30.9)).toBe(30)
    expect(clampFpsCap(undefined)).toBe(DEFAULT_CONFIG.fpsCap)
  })

  it('normalizeAutonomousLevel：合法枚举透传，非法回退 normal', () => {
    expect(normalizeAutonomousLevel('low')).toBe('low')
    expect(normalizeAutonomousLevel('normal')).toBe('normal')
    expect(normalizeAutonomousLevel('high')).toBe('high')
    expect(normalizeAutonomousLevel('HIGH')).toBe('normal')
    expect(normalizeAutonomousLevel(undefined)).toBe('normal')
    expect(normalizeAutonomousLevel(3)).toBe('normal')
  })
})

describe('config ↔ 表单 / patch', () => {
  it('formStateFromConfig：字段一一对应且未被篡改', () => {
    const config = configWith({
      sizePercent: 70,
      opacity: 0.65,
      autonomous: false,
      autonomousLevel: 'high',
      mischief: false,
      dshLink: false,
      dshCoupling: false,
      dshBubbleSync: false,
      fpsCap: 60,
      launchAtLogin: true,
      sound: true
    })
    const state = formStateFromConfig(config)
    expect(state).toEqual({
      sizePercent: 70,
      opacity: 0.65,
      autonomous: false,
      autonomousLevel: 'high',
      mischief: false,
      dshLink: false,
      dshCoupling: false,
      dshBubbleSync: false,
      fpsCap: 60,
      launchAtLogin: true,
      sound: true
    })
    // 新对象：改表单不污染原配置
    state.sizePercent = 10
    expect(config.sizePercent).toBe(70)
  })

  it('formStateFromConfig：DSH 联动新键缺省回填 true、脏值回退 true', () => {
    // 旧配置（Wave 3 之前的 config.json）没有这两个可选键 → 表单应显示为开启。
    const legacy = { ...DEFAULT_CONFIG }
    delete legacy.dshCoupling
    delete legacy.dshBubbleSync
    expect(formStateFromConfig(legacy).dshCoupling).toBe(true)
    expect(formStateFromConfig(legacy).dshBubbleSync).toBe(true)

    // 非 boolean 脏值按「缺省 = 默认 true」处理，而不是真值转换。
    const dirty = {
      ...DEFAULT_CONFIG,
      dshCoupling: 'yes',
      dshBubbleSync: 1
    } as unknown as PetConfig
    expect(formStateFromConfig(dirty).dshCoupling).toBe(true)
    expect(formStateFromConfig(dirty).dshBubbleSync).toBe(true)
  })

  it('formStateFromConfig：越界/脏配置按钳制值进入表单', () => {
    const dirty = { ...DEFAULT_CONFIG, sizePercent: 3, opacity: 4, fpsCap: 0 }
    const state = formStateFromConfig(dirty)
    expect(state.sizePercent).toBe(10)
    expect(state.opacity).toBe(1)
    expect(state.fpsCap).toBe(5)
  })

  it('patchForField：每个字段只产生单个键且已钳制', () => {
    const patches = [
      patchForField('sizePercent', 5),
      patchForField('opacity', 0.1),
      patchForField('autonomous', false),
      patchForField('autonomousLevel', 'high'),
      patchForField('mischief', true),
      patchForField('dshLink', false),
      patchForField('dshCoupling', false),
      patchForField('dshBubbleSync', false),
      patchForField('fpsCap', 120),
      patchForField('launchAtLogin', true),
      patchForField('sound', true)
    ]
    expect(patches[0]).toEqual({ sizePercent: 10 })
    expect(patches[1]).toEqual({ opacity: 0.3 })
    expect(patches[2]).toEqual({ autonomous: false })
    expect(patches[3]).toEqual({ autonomousLevel: 'high' })
    expect(patches[4]).toEqual({ mischief: true })
    expect(patches[5]).toEqual({ dshLink: false })
    expect(patches[6]).toEqual({ dshCoupling: false })
    expect(patches[7]).toEqual({ dshBubbleSync: false })
    expect(patches[8]).toEqual({ fpsCap: 60 })
    expect(patches[9]).toEqual({ launchAtLogin: true })
    expect(patches[10]).toEqual({ sound: true })
    for (const patch of patches) expect(Object.keys(patch)).toHaveLength(1)
  })

  it('patchForField：非法/脏值回退默认值', () => {
    expect(patchForField('autonomous', 'yes')).toEqual({ autonomous: DEFAULT_CONFIG.autonomous })
    expect(patchForField('autonomousLevel', 'ultra')).toEqual({
      autonomousLevel: DEFAULT_CONFIG.autonomousLevel
    })
    expect(patchForField('fpsCap', 'fast')).toEqual({ fpsCap: DEFAULT_CONFIG.fpsCap })
    expect(patchForField('sizePercent', null)).toEqual({ sizePercent: DEFAULT_CONFIG.sizePercent })
  })

  it('patchForField：DSH 新键脏值回退默认 true，显式 false 保留', () => {
    expect(patchForField('dshCoupling', 'off')).toEqual({ dshCoupling: true })
    expect(patchForField('dshBubbleSync', 0)).toEqual({ dshBubbleSync: true })
    expect(patchForField('dshCoupling', false)).toEqual({ dshCoupling: false })
    expect(patchForField('dshBubbleSync', false)).toEqual({ dshBubbleSync: false })
  })

  it('defaultsPatch：等于 DEFAULT_CONFIG 且是独立副本', () => {
    const patch = defaultsPatch()
    expect(patch).toEqual(DEFAULT_CONFIG)
    expect(patch).not.toBe(DEFAULT_CONFIG)
    patch.sizePercent = 10
    expect(DEFAULT_CONFIG.sizePercent).toBe(50)
  })
})

describe('屏幕基准与尺寸换算', () => {
  it('screenMetricsFromDisplays：优先 isPrimary，缺失回退首个，空列表回退默认', () => {
    const primary = displayWith({
      id: 2,
      isPrimary: true,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 25, width: 2560, height: 1415 }
    })
    const secondary = displayWith({ id: 1, isPrimary: false })
    expect(screenMetricsFromDisplays([secondary, primary])).toEqual({
      boundsHeight: 1440,
      workAreaHeight: 1415
    })
    expect(screenMetricsFromDisplays([secondary])).toEqual({
      boundsHeight: 1080,
      workAreaHeight: 961
    })
    expect(screenMetricsFromDisplays([])).toEqual(DEFAULT_SCREEN_METRICS)
    expect(screenMetricsFromDisplays(null)).toEqual(DEFAULT_SCREEN_METRICS)
  })

  it('screenMetricsFromDisplay：非法高度各自回退默认值', () => {
    expect(
      screenMetricsFromDisplay(
        displayWith({
          bounds: { x: 0, y: 0, width: 0, height: Number.NaN },
          workArea: { x: 0, y: 0, width: 0, height: 700 }
        })
      )
    ).toEqual({ boundsHeight: DEFAULT_SCREEN_METRICS.boundsHeight, workAreaHeight: 700 })
    expect(screenMetricsFromDisplay(null)).toEqual(DEFAULT_SCREEN_METRICS)
  })

  it('computePetHeightPx：百分比 × bounds 高，受 workArea 封顶', () => {
    expect(computePetHeightPx(50)).toBe(540)
    expect(computePetHeightPx(30)).toBe(324)
    expect(computePetHeightPx(10)).toBe(108)
    expect(computePetHeightPx(100)).toBe(961) // 1080 → 被 workArea 961 截断
    expect(computePetHeightPx(999)).toBe(961)
    expect(computePetHeightPx(Number.NaN)).toBe(540)
    expect(computePetHeightPx(50, { boundsHeight: 1440, workAreaHeight: 1415 })).toBe(720)
  })

  it('maxSizePercent：floor(workArea/bounds)，限制在 1–100', () => {
    expect(maxSizePercent({ boundsHeight: 1080, workAreaHeight: 961 })).toBe(89)
    expect(maxSizePercent({ boundsHeight: 1440, workAreaHeight: 1415 })).toBe(99)
    expect(maxSizePercent({ boundsHeight: 800, workAreaHeight: 800 })).toBe(100)
    expect(maxSizePercent({ boundsHeight: 0, workAreaHeight: 0 })).toBe(89) // 回退默认基准
  })

  it('describeSize：百分比标签 + px 换算 + 上限/近景提示', () => {
    const normal = describeSize(50)
    expect(normal.label).toBe('50%')
    expect(normal.petHeightPx).toBe(540)
    expect(normal.hint).toContain('89%')

    const maxed = describeSize(100)
    expect(maxed.petHeightPx).toBe(961)
    expect(maxed.hint).toContain('上限')
    expect(maxed.hint).toContain('961')

    const near = describeSize(70)
    expect(near.hint).toContain('近景模式')
  })

  it('display 文案：不透明度 / FPS', () => {
    expect(formatOpacityPercent(1)).toBe('100%')
    expect(formatOpacityPercent(0.3)).toBe('30%')
    expect(formatOpacityPercent(0.555)).toBe('56%')
    expect(formatFps(30)).toBe('30 FPS')
    expect(formatFps(5)).toBe('5 FPS')
    expect(formatFps(120)).toBe('60 FPS')
  })
})

describe('状态展示文案', () => {
  it('describeDshStatus：null/离线/在线空闲/在线忙碌（Wave 3 §7 文案）', () => {
    expect(describeDshStatus(null)).toEqual({ text: '未知（主进程未响应）', tone: 'unknown' })
    expect(describeDshStatus(dshStatus({ online: false }))).toEqual({
      text: '未连接（安装桥插件后生效）',
      tone: 'offline'
    })
    expect(describeDshStatus(dshStatus({ online: true, running: false }))).toEqual({
      text: '已连接（空闲）',
      tone: 'online-idle'
    })
    expect(describeDshStatus(dshStatus({ online: true, running: true }))).toEqual({
      text: '已连接（运行中）',
      tone: 'online-busy'
    })
  })

  it('describePermissions：权限/通知各分支', () => {
    expect(describePermissions(null)).toEqual({
      accessibilityText: '未知',
      accessibilityOk: false,
      notificationsText: '未知',
      notificationsOk: false
    })
    const granted = describePermissions(
      permissions({ accessibility: true, notifications: 'granted' })
    )
    expect(granted).toEqual({
      accessibilityText: '已授权',
      accessibilityOk: true,
      notificationsText: '已允许',
      notificationsOk: true
    })
    expect(describePermissions(permissions({ notifications: 'denied' }))).toMatchObject({
      accessibilityText: '未授权',
      accessibilityOk: false,
      notificationsText: '已拒绝',
      notificationsOk: false
    })
    expect(describePermissions(permissions({ notifications: 'unsupported' }))).toMatchObject({
      notificationsText: '系统不支持',
      notificationsOk: false
    })
  })

  it('formatErrorText：Error/字符串/未知值/超长截断', () => {
    expect(formatErrorText(new Error('boom'))).toBe('boom')
    expect(formatErrorText('ipc failed')).toBe('ipc failed')
    expect(formatErrorText(undefined)).toBe('未知错误')
    const long = formatErrorText(new Error('x'.repeat(200)))
    expect(long.length).toBe(120)
    expect(long.endsWith('…')).toBe(true)
  })
})
