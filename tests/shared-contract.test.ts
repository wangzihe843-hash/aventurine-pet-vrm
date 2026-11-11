/**
 * A6 单测：冻结共享契约（M0-2）—— IPC 通道、事件通道、配置清洗与 PetApi 类型面。
 *
 * 这些断言是“冻结契约”的回归护栏：任何改动 IPC 名称/值、事件通道集合、
 * sanitizeConfig 的钳制/默认/枚举行为，都会在这里失败（需先走契约评审）。
 */
import { describe, expect, expectTypeOf, it } from 'vitest'

import { CONFIG_LIMITS, CONFIG_VERSION, DEFAULT_CONFIG, sanitizeConfig } from '@shared/config'
import { IPC, IPC_EVENTS } from '@shared/ipc'
import type { IpcChannel, IpcEventChannel, PetApi } from '@shared/ipc'
import type { PetConfig } from '@shared/types'

const EXPECTED_IPC = {
  getConfig: 'pet:get-config',
  setConfig: 'pet:set-config',
  screenInfo: 'pet:screen-info',
  windows: 'pet:windows',
  setIgnoreMouse: 'pet:set-ignore-mouse',
  windowInfo: 'pet:window-info',
  accessibilityStatus: 'pet:accessibility-status',
  openAccessibilitySettings: 'pet:open-accessibility-settings',
  moveWindow: 'pet:move-window',
  dshStatus: 'pet:dsh-status',
  notify: 'pet:notify',
  showSettings: 'pet:show-settings',
  quit: 'pet:quit',
  setVisible: 'pet:set-visible'
} as const

const EXPECTED_IPC_EVENTS = {
  windowsUpdated: 'windows-updated',
  dshEvent: 'dsh-event',
  configChanged: 'config-changed',
  screensUpdated: 'screens-updated'
} as const

describe('IPC 通道冻结契约', () => {
  it('恰好 14 个 invoke/handle 通道，名称与值均冻结', () => {
    expect(IPC).toEqual(EXPECTED_IPC)
    expect(Object.keys(IPC)).toHaveLength(14)
  })

  it('通道值唯一、均带 pet: 前缀、均为非空字符串', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
    for (const value of values) {
      expect(typeof value).toBe('string')
      expect(value.startsWith('pet:')).toBe(true)
      expect(value.length).toBeGreaterThan('pet:'.length)
    }
  })

  it('主→渲染事件通道恰好 4 个，含 screens-updated', () => {
    expect(IPC_EVENTS).toEqual(EXPECTED_IPC_EVENTS)
    expect(Object.keys(IPC_EVENTS)).toHaveLength(4)
    const values = Object.values(IPC_EVENTS)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain('screens-updated')
    for (const value of values) {
      expect(value.startsWith('pet:')).toBe(false)
    }
  })

  it('通道常量可赋给冻结联合类型（编译期约束的运行期锚点）', () => {
    const channel: IpcChannel = IPC.quit
    const eventChannel: IpcEventChannel = IPC_EVENTS.screensUpdated
    expect(channel).toBe('pet:quit')
    expect(eventChannel).toBe('screens-updated')
  })
})

describe('PetApi 类型面（编译期 + 运行期锚点）', () => {
  it('invoke 方法签名与 IPC 通道一一对应', () => {
    expectTypeOf<PetApi['getConfig']>().returns.toEqualTypeOf<Promise<PetConfig>>()
    expectTypeOf<PetApi['setConfig']>().parameters.toEqualTypeOf<[Partial<PetConfig>]>()
    expectTypeOf<PetApi['setIgnoreMouse']>().parameters.toEqualTypeOf<[boolean]>()
    expectTypeOf<PetApi['notify']>().parameters.toEqualTypeOf<[string, string]>()
    expectTypeOf<PetApi['onDshEvent']>().returns.toEqualTypeOf<() => void>()
    expectTypeOf<PetApi['onScreensUpdated']>().returns.toEqualTypeOf<() => void>()
  })

  it('PetApi 键集合 = 14 invoke + 4 订阅（编译期精确校验，非自证式）', () => {
    // 独立复验 LOW-6：原用例只是把 14 个名字抄一遍再断言长度，等于自证。
    // 这里改为编译期精确断言 PetApi 的键集合；任何增减/改名都会让类型检查失败。
    type ExpectedPetApiKeys =
      | 'getConfig'
      | 'setConfig'
      | 'getScreenInfo'
      | 'getWindows'
      | 'setIgnoreMouse'
      | 'getWindowInfo'
      | 'getAccessibilityStatus'
      | 'openAccessibilitySettings'
      | 'moveWindow'
      | 'getDshStatus'
      | 'notify'
      | 'showSettings'
      | 'quit'
      | 'setVisible'
      | 'onWindowsUpdated'
      | 'onDshEvent'
      | 'onConfigChanged'
      | 'onScreensUpdated'
    expectTypeOf<keyof PetApi>().toEqualTypeOf<ExpectedPetApiKeys>()

    // 运行期锚点：18 = 14 invoke 通道 + 4 事件通道（与 PLAN §8 一致）
    expect(Object.keys(IPC)).toHaveLength(14)
    expect(Object.keys(IPC_EVENTS)).toHaveLength(4)
    expect(Object.keys(IPC).length + Object.keys(IPC_EVENTS).length).toBe(18)
  })
})

describe('配置默认值/限制常量冻结', () => {
  it('CONFIG_VERSION 与数值限制冻结', () => {
    expect(CONFIG_VERSION).toBe(1)
    expect(CONFIG_LIMITS).toEqual({
      sizePercent: { min: 10, max: 100 },
      opacity: { min: 0.3, max: 1 },
      fpsCap: { min: 5, max: 60 }
    })
  })

  it('DEFAULT_CONFIG 为完整 PetConfig 且值落在限制内', () => {
    expect(DEFAULT_CONFIG).toEqual({
      sizePercent: 50,
      opacity: 1,
      clickThrough: true,
      autonomous: true,
      autonomousLevel: 'normal',
      mischief: true,
      dshLink: true,
      // Wave 3 新增（可选键，默认 true）：DSH 双向保活 + 气泡同步回复
      dshCoupling: true,
      dshBubbleSync: true,
      fpsCap: 30,
      launchAtLogin: false,
      position: 'corner',
      sound: false,
      // W0-3 新增：Phase 3 默认 VRM 渲染/动画后端 + 默认动作集
      modelBackend: 'vrm',
      animBackend: 'vrm',
      motionSet: 'default'
    })
    expect(DEFAULT_CONFIG.sizePercent).toBeGreaterThanOrEqual(CONFIG_LIMITS.sizePercent.min)
    expect(DEFAULT_CONFIG.sizePercent).toBeLessThanOrEqual(CONFIG_LIMITS.sizePercent.max)
    expect(DEFAULT_CONFIG.opacity).toBeGreaterThanOrEqual(CONFIG_LIMITS.opacity.min)
    expect(DEFAULT_CONFIG.opacity).toBeLessThanOrEqual(CONFIG_LIMITS.opacity.max)
    expect(DEFAULT_CONFIG.fpsCap).toBeGreaterThanOrEqual(CONFIG_LIMITS.fpsCap.min)
    expect(DEFAULT_CONFIG.fpsCap).toBeLessThanOrEqual(CONFIG_LIMITS.fpsCap.max)
  })
})

describe('sanitizeConfig：默认回填', () => {
  it.each([[undefined], [null], [[]], ['not-object'], [42], [true]])(
    '非对象输入 %j 返回默认配置且不抛异常',
    (input) => {
      expect(sanitizeConfig(input)).toEqual(DEFAULT_CONFIG)
    }
  )

  it('空对象返回默认配置，且返回新对象（不共享 DEFAULT_CONFIG 引用）', () => {
    const result = sanitizeConfig({})
    expect(result).toEqual(DEFAULT_CONFIG)
    expect(result).not.toBe(DEFAULT_CONFIG)
    result.sizePercent = 11
    expect(DEFAULT_CONFIG.sizePercent).toBe(50)
  })

  it('部分输入只覆盖提供的键，其余回填默认', () => {
    const result = sanitizeConfig({ opacity: 0.5, autonomous: false })
    expect(result).toEqual({ ...DEFAULT_CONFIG, opacity: 0.5, autonomous: false })
  })
})

describe('sanitizeConfig：数值钳制', () => {
  it('sizePercent 钳制到 [10, 100]', () => {
    expect(sanitizeConfig({ sizePercent: 0 }).sizePercent).toBe(10)
    expect(sanitizeConfig({ sizePercent: -999 }).sizePercent).toBe(10)
    expect(sanitizeConfig({ sizePercent: 10 }).sizePercent).toBe(10)
    expect(sanitizeConfig({ sizePercent: 42 }).sizePercent).toBe(42)
    expect(sanitizeConfig({ sizePercent: 50 }).sizePercent).toBe(50)
    expect(sanitizeConfig({ sizePercent: 80 }).sizePercent).toBe(80)
    expect(sanitizeConfig({ sizePercent: 100 }).sizePercent).toBe(100)
    expect(sanitizeConfig({ sizePercent: 999 }).sizePercent).toBe(100)
  })

  it('opacity 钳制到 [0.3, 1]', () => {
    expect(sanitizeConfig({ opacity: 0 }).opacity).toBe(0.3)
    expect(sanitizeConfig({ opacity: 0.3 }).opacity).toBe(0.3)
    expect(sanitizeConfig({ opacity: 0.7 }).opacity).toBe(0.7)
    expect(sanitizeConfig({ opacity: 2 }).opacity).toBe(1)
  })

  it('fpsCap 钳制到 [5, 60]', () => {
    expect(sanitizeConfig({ fpsCap: 0 }).fpsCap).toBe(5)
    expect(sanitizeConfig({ fpsCap: 5 }).fpsCap).toBe(5)
    expect(sanitizeConfig({ fpsCap: 60 }).fpsCap).toBe(60)
    expect(sanitizeConfig({ fpsCap: 1000 }).fpsCap).toBe(60)
  })

  it('非有限数值/错误类型回退默认值', () => {
    expect(sanitizeConfig({ sizePercent: Number.NaN }).sizePercent).toBe(DEFAULT_CONFIG.sizePercent)
    expect(sanitizeConfig({ sizePercent: Infinity }).sizePercent).toBe(DEFAULT_CONFIG.sizePercent)
    expect(sanitizeConfig({ opacity: -Infinity }).opacity).toBe(DEFAULT_CONFIG.opacity)
    expect(sanitizeConfig({ fpsCap: '60' }).fpsCap).toBe(DEFAULT_CONFIG.fpsCap)
  })
})

describe('sanitizeConfig：枚举/布尔/未知键', () => {
  it('AUTONOMOUS_LEVELS 合法值透传，非法回退 normal', () => {
    expect(sanitizeConfig({ autonomousLevel: 'low' }).autonomousLevel).toBe('low')
    expect(sanitizeConfig({ autonomousLevel: 'high' }).autonomousLevel).toBe('high')
    expect(sanitizeConfig({ autonomousLevel: 'extreme' }).autonomousLevel).toBe('normal')
    expect(sanitizeConfig({ autonomousLevel: 7 }).autonomousLevel).toBe('normal')
  })

  it('position 合法值透传，非法回退 corner', () => {
    expect(sanitizeConfig({ position: 'free' }).position).toBe('free')
    expect(sanitizeConfig({ position: 'middle' }).position).toBe('corner')
    expect(sanitizeConfig({ position: null }).position).toBe('corner')
  })

  it('布尔键错误类型回退默认，合法值透传', () => {
    expect(sanitizeConfig({ clickThrough: false }).clickThrough).toBe(false)
    expect(sanitizeConfig({ clickThrough: 'yes' }).clickThrough).toBe(true)
    expect(sanitizeConfig({ autonomous: false }).autonomous).toBe(false)
    expect(sanitizeConfig({ mischief: 0 }).mischief).toBe(true)
    expect(sanitizeConfig({ dshLink: false }).dshLink).toBe(false)
    // Wave 3 新增键：合法布尔透传，脏类型回退默认 true（可选键语义）
    expect(sanitizeConfig({ dshCoupling: false }).dshCoupling).toBe(false)
    expect(sanitizeConfig({ dshBubbleSync: false }).dshBubbleSync).toBe(false)
    expect(sanitizeConfig({ dshCoupling: 'no' }).dshCoupling).toBe(true)
    expect(sanitizeConfig({ dshBubbleSync: 0 }).dshBubbleSync).toBe(true)
    expect(sanitizeConfig({}).dshCoupling).toBe(true)
    expect(sanitizeConfig({}).dshBubbleSync).toBe(true)
    expect(sanitizeConfig({ launchAtLogin: true }).launchAtLogin).toBe(true)
    expect(sanitizeConfig({ sound: 'off' }).sound).toBe(false)
  })

  it('未知键被丢弃，输出键集合与 PetConfig 完全一致', () => {
    const result = sanitizeConfig({
      ...DEFAULT_CONFIG,
      evil: 'x',
      extra: { nested: 1 },
      polluted: true
    }) as PetConfig & Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
    expect('evil' in result).toBe(false)
    expect('extra' in result).toBe(false)
    expect('polluted' in result).toBe(false)
  })

  it('JSON 解析出的脏配置不抛异常且结果回退为默认配置', () => {
    const raw =
      '{"sizePercent":"big","opacity":null,"autonomousLevel":7,"fpsCap":{},' +
      '"clickThrough":"nope","unknown":{"a":1},"position":[]}'
    const parsed: unknown = JSON.parse(raw)
    expect(() => sanitizeConfig(parsed)).not.toThrow()
    expect(sanitizeConfig(parsed)).toEqual(DEFAULT_CONFIG)
  })
})

describe('sanitizeConfig：只读取自有属性（原型链/继承值防护，LOW-7 覆盖缺口）', () => {
  it('Object.create 继承的属性不生效，回退默认值', () => {
    const inherited = Object.create({ sizePercent: 50, mischief: false }) as Record<string, unknown>
    expect(sanitizeConfig(inherited)).toEqual(DEFAULT_CONFIG)
  })

  it('JSON.parse 的 __proto__ 键不会污染 / 生效', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"sizePercent":50,"mischief":false}}')
    expect(sanitizeConfig(parsed)).toEqual(DEFAULT_CONFIG)
    // 输出是全新普通对象，不共享 DEFAULT_CONFIG 引用、也不继承注入原型
    const result = sanitizeConfig(parsed)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
  })

  it('自有属性与继承值混用时只取自有值', () => {
    const own = Object.assign(Object.create({ sizePercent: 50 }), { opacity: 0.5 }) as Record<
      string,
      unknown
    >
    const result = sanitizeConfig(own)
    expect(result.sizePercent).toBe(DEFAULT_CONFIG.sizePercent)
    expect(result.opacity).toBe(0.5)
  })
})

describe('sanitizeConfig：W0-3 新增 VRM 后端/动作集配置', () => {
  it('缺省回填：旧版 config.json（无这三项）→ vrm/vrm/default', () => {
    const result = sanitizeConfig({ sizePercent: 30 } as unknown)
    expect(result.modelBackend).toBe('vrm')
    expect(result.animBackend).toBe('vrm')
    expect(result.motionSet).toBe('default')
  })

  it('modelBackend/animBackend：只接受 vrm / legacy-pmx，其它回退默认 vrm', () => {
    expect(sanitizeConfig({ modelBackend: 'legacy-pmx' } as unknown).modelBackend).toBe(
      'legacy-pmx'
    )
    expect(sanitizeConfig({ animBackend: 'legacy-pmx' } as unknown).animBackend).toBe(
      'legacy-pmx'
    )
    for (const bad of ['VRM', 'pmx', '', null, 7, {}, []]) {
      expect(sanitizeConfig({ modelBackend: bad } as unknown).modelBackend).toBe('vrm')
      expect(sanitizeConfig({ animBackend: bad } as unknown).animBackend).toBe('vrm')
    }
  })

  it('motionSet：trim 后合法 id 透传；路径穿越/空白/超长/非字符串回退 default', () => {
    expect(sanitizeConfig({ motionSet: 'summer-2026' } as unknown).motionSet).toBe('summer-2026')
    expect(sanitizeConfig({ motionSet: '  default  ' } as unknown).motionSet).toBe('default')
    for (const bad of [
      '',
      '   ',
      '../etc',
      'a/b',
      'a\\b',
      '.hidden',
      'x'.repeat(65),
      '-leading', // 允许（pattern 允许连字符开头）
      7,
      null
    ]) {
      const result = sanitizeConfig({ motionSet: bad } as unknown)
      if (bad === '-leading') {
        expect(result.motionSet).toBe('-leading')
      } else {
        expect(result.motionSet).toBe('default')
      }
    }
  })

  it('新增键不改变未知键丢弃语义', () => {
    const result = sanitizeConfig({
      ...DEFAULT_CONFIG,
      evil: 'x'
    } as unknown) as PetConfig & Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
  })
})
