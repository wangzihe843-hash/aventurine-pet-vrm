/**
 * A3 单测：配置持久化存储（`src/main/config-store.ts`）。
 *
 * 覆盖 PLAN §5-A3 / §17.5 验收要求：
 * - 首次启动默认值；部分更新合并；数值越界钳制（sizePercent 9/51、fpsCap 4/61、opacity 0.2/1.1）；
 * - 脏输入（数组 / null / 字符串 / 未知键 / 非自有属性）不破坏配置；
 * - 损坏 JSON / 版本缺失或错误 / 缺 config → 回退 DEFAULT_CONFIG + warn，且**绝不抛异常**；
 * - 原子写（`.config.json.<pid>.tmp` 不残留）+ 启动时清理其它 pid 的陈旧 tmp（F10）；
 *   落盘结构 `{ version, config }` 且可重新读取一致；
 * - `get()` 返回副本，调用方修改返回值不会污染内部缓存；写盘失败时内存态仍更新（不抛）。
 *
 * 本文件与 `config-store.ts` 一样**不 import electron**：目录全部注入 `mkdtempSync` 临时目录。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CONFIG_VERSION, DEFAULT_CONFIG } from '@shared/config'
import type { PetConfig } from '@shared/types'
import { createConfigStore, toConfigPartial } from '../src/main/config-store'
import type { ConfigStoreLogger } from '../src/main/config-store'

/** 本用例创建的临时目录，afterEach 统一清理。 */
const tempDirs: string[] = []

/** 创建临时目录（每个用例独立，避免相互污染）。 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-config-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 记录 warn 调用的假日志器（验证「损坏配置必须告警」）。 */
function createFakeLogger(): ConfigStoreLogger & { warnings: unknown[][] } {
  const warnings: unknown[][] = []
  return {
    warnings,
    warn(...args: unknown[]): void {
      warnings.push(args)
    }
  }
}

/** 读取配置文件的 JSON 结构（断言落盘格式用）。 */
function readPayload(dir: string): { version: number; config: PetConfig } {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
    version: number
    config: PetConfig
  }
}

describe('默认值：首次启动 / config.json 不存在', () => {
  it('目录与文件均不存在 → DEFAULT_CONFIG，且不告警（首次启动不是异常）', () => {
    const base = makeTempDir()
    const dir = join(base, 'not-created-yet')
    const logger = createFakeLogger()

    const store = createConfigStore({ dir, logger })

    expect(store.get()).toEqual(DEFAULT_CONFIG)
    expect(store.filePath).toBe(join(dir, 'config.json'))
    expect(logger.warnings).toHaveLength(0)
    // 纯读取不落盘（首次 set 才创建文件）
    expect(existsSync(join(dir, 'config.json'))).toBe(false)
  })

  it('DEFAULT_CONFIG 不被内部状态原地修改', () => {
    const store = createConfigStore({ dir: makeTempDir() })
    store.set({ sizePercent: 45, opacity: 0.5 })
    expect(DEFAULT_CONFIG.sizePercent).toBe(50)
    expect(DEFAULT_CONFIG.opacity).toBe(1)
  })
})

describe('部分更新：merge + 持久化', () => {
  it('set 只改传入键，其余键保留当前值', () => {
    const store = createConfigStore({ dir: makeTempDir() })

    const first = store.set({ sizePercent: 40 })
    expect(first.sizePercent).toBe(40)
    expect(first.opacity).toBe(DEFAULT_CONFIG.opacity)

    const second = store.set({ opacity: 0.5 })
    expect(second.opacity).toBe(0.5)
    expect(second.sizePercent).toBe(40) // 之前设置的键不被默认值覆盖
    expect(store.get()).toEqual(second)
  })

  it('落盘结构为 { version, config }，未知键不进文件，可重新创建 store 读回一致', () => {
    const dir = makeTempDir()
    const store = createConfigStore({ dir })
    store.set({ sizePercent: 45, opacity: 0.6, autonomousLevel: 'high' })

    const payload = readPayload(dir)
    expect(payload.version).toBe(CONFIG_VERSION)
    expect(payload.config.sizePercent).toBe(45)
    expect(payload.config.opacity).toBe(0.6)
    expect(payload.config.autonomousLevel).toBe('high')
    // 恰好是冻结 schema 的 11 个键，没有多写未知键
    expect(Object.keys(payload.config).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())

    const reopened = createConfigStore({ dir })
    expect(reopened.get()).toEqual(store.get())
  })

  it('原子写：成功写入后目录内无 .tmp 残留，且 config.json 存在', () => {
    const dir = makeTempDir()
    const store = createConfigStore({ dir })
    store.set({ fpsCap: 60 })

    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    expect(existsSync(join(dir, 'config.json'))).toBe(true)
  })

  it('启动清理陈旧 tmp（F10）：删除其它 pid 的 .config.json.<pid>.tmp，跳过当前 pid 与无关文件', () => {
    const dir = makeTempDir()
    const staleOtherPid = join(dir, '.config.json.999999.tmp')
    const currentPid = join(dir, `.config.json.${process.pid}.tmp`)
    const unrelated = join(dir, 'unrelated.tmp')
    const wrongPrefix = join(dir, 'config.json.stale.tmp')
    for (const file of [staleOtherPid, currentPid, unrelated, wrongPrefix]) {
      writeFileSync(file, 'stale', 'utf8')
    }

    createConfigStore({ dir })

    expect(existsSync(staleOtherPid)).toBe(false) // 其它 pid 的崩溃残留被清理
    expect(existsSync(currentPid)).toBe(true) // 跳过当前 pid（可能正在写）
    expect(existsSync(unrelated)).toBe(true) // 不匹配命名模板
    expect(existsSync(wrongPrefix)).toBe(true) // 缺少前导点，不匹配命名模板
  })

  it('启动清理不改变正常配置读取，且目录不存在时清理不抛', () => {
    const base = makeTempDir()
    const dir = join(base, 'missing-dir')
    expect(() => createConfigStore({ dir })).not.toThrow()
    expect(createConfigStore({ dir }).get()).toEqual(DEFAULT_CONFIG)
  })
})

describe('数值越界钳制（sanitizeConfig 语义）', () => {
  it('sizePercent 9→10、101→100；fpsCap 4→5、61→60；opacity 0.2→0.3、1.1→1', () => {
    const store = createConfigStore({ dir: makeTempDir() })

    expect(store.set({ sizePercent: 9 }).sizePercent).toBe(10)
    expect(store.set({ sizePercent: 51 }).sizePercent).toBe(51)
    expect(store.set({ sizePercent: 101 }).sizePercent).toBe(100)
    expect(store.set({ fpsCap: 4 }).fpsCap).toBe(5)
    expect(store.set({ fpsCap: 61 }).fpsCap).toBe(60)
    expect(store.set({ opacity: 0.2 }).opacity).toBe(0.3)
    expect(store.set({ opacity: 1.1 }).opacity).toBe(1)
  })
})

describe('脏输入：数组 / null / 字符串 / 未知键 / 非自有属性', () => {
  it('非对象 partial 等价于无更新（不抛、不改配置）', () => {
    const dir = makeTempDir()
    const store = createConfigStore({ dir })
    store.set({ sizePercent: 40 })
    const before = store.get()

    for (const dirty of [[1, 2, 3], null, 'sizePercent=99', 42, true] as unknown[]) {
      expect(() => store.set(dirty as Partial<PetConfig>)).not.toThrow()
      expect(store.get()).toEqual(before)
    }
  })

  it('未知键被丢弃（内存态与落盘文件都不含未知键）', () => {
    const dir = makeTempDir()
    const store = createConfigStore({ dir })

    const next = store.set({ sizePercent: 35, evilKey: 'x' } as unknown as Partial<PetConfig>)
    expect(next.sizePercent).toBe(35)
    expect((next as unknown as Record<string, unknown>).evilKey).toBeUndefined()
    expect(Object.keys(readPayload(dir).config).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
  })

  it('非自有属性（原型链注入）被忽略', () => {
    const store = createConfigStore({ dir: makeTempDir() })
    const malicious = Object.create({ sizePercent: 99 }) as Partial<PetConfig>

    expect(store.set(malicious)).toEqual(DEFAULT_CONFIG)
  })

  it('非法类型/枚举回退默认值：NaN / Infinity / 错误枚举字符串', () => {
    const store = createConfigStore({ dir: makeTempDir() })

    const next = store.set({
      sizePercent: Number.NaN,
      fpsCap: Number.POSITIVE_INFINITY,
      autonomousLevel: 'extreme',
      position: 'ceiling'
    } as unknown as Partial<PetConfig>)

    expect(next.sizePercent).toBe(DEFAULT_CONFIG.sizePercent)
    expect(next.fpsCap).toBe(DEFAULT_CONFIG.fpsCap)
    expect(next.autonomousLevel).toBe(DEFAULT_CONFIG.autonomousLevel)
    expect(next.position).toBe(DEFAULT_CONFIG.position)
  })
})

describe('损坏 / 旧版配置文件：回退默认 + warn，绝不抛异常', () => {
  it('非法 JSON → DEFAULT_CONFIG + warn', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'config.json'), '{ this is not json', 'utf8')
    const logger = createFakeLogger()

    let store: ReturnType<typeof createConfigStore> | undefined
    expect(() => {
      store = createConfigStore({ dir, logger })
    }).not.toThrow()

    expect(store?.get()).toEqual(DEFAULT_CONFIG)
    expect(logger.warnings.length).toBeGreaterThan(0)
  })

  it('JSON 顶层是数组 / null / 字符串 → 回退默认 + warn', () => {
    for (const raw of ['[1,2,3]', 'null', '"config"']) {
      const dir = makeTempDir()
      writeFileSync(join(dir, 'config.json'), raw, 'utf8')
      const logger = createFakeLogger()

      expect(createConfigStore({ dir, logger }).get()).toEqual(DEFAULT_CONFIG)
      expect(logger.warnings.length).toBeGreaterThan(0)
    }
  })

  it('version 缺失 / version 错误 → 回退默认 + warn', () => {
    const cases = [
      JSON.stringify({ config: { sizePercent: 40 } }), // 缺 version
      JSON.stringify({ version: CONFIG_VERSION + 1, config: { sizePercent: 40 } }) // 未来版本
    ]
    for (const raw of cases) {
      const dir = makeTempDir()
      writeFileSync(join(dir, 'config.json'), raw, 'utf8')
      const logger = createFakeLogger()

      expect(createConfigStore({ dir, logger }).get()).toEqual(DEFAULT_CONFIG)
      expect(logger.warnings.length).toBeGreaterThan(0)
    }
  })

  it('version 正确但缺 config / config 不是对象 → 回退默认 + warn', () => {
    const cases = [
      JSON.stringify({ version: CONFIG_VERSION }),
      JSON.stringify({ version: CONFIG_VERSION, config: null }),
      JSON.stringify({ version: CONFIG_VERSION, config: [1, 2] })
    ]
    for (const raw of cases) {
      const dir = makeTempDir()
      writeFileSync(join(dir, 'config.json'), raw, 'utf8')
      const logger = createFakeLogger()

      expect(createConfigStore({ dir, logger }).get()).toEqual(DEFAULT_CONFIG)
      expect(logger.warnings.length).toBeGreaterThan(0)
    }
  })

  it('结构合法但内容越界 / 带未知键 → 读取时清洗（钳制 + 丢弃未知键）', () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        version: CONFIG_VERSION,
        config: { sizePercent: 999, fpsCap: 'bad', unknownKey: 'x' }
      }),
      'utf8'
    )

    const config = createConfigStore({ dir }).get()
    expect(config.sizePercent).toBe(100)
    expect(config.fpsCap).toBe(DEFAULT_CONFIG.fpsCap)
    expect((config as unknown as Record<string, unknown>).unknownKey).toBeUndefined()
  })
})

describe('get()/set() 返回值是副本（不可篡改内部缓存）', () => {
  it('修改 get() 的返回值不影响后续读取', () => {
    const store = createConfigStore({ dir: makeTempDir() })
    store.set({ sizePercent: 40 })

    const snapshot = store.get()
    snapshot.sizePercent = 99
    snapshot.opacity = 0.3

    expect(store.get().sizePercent).toBe(40)
    expect(store.get().opacity).toBe(DEFAULT_CONFIG.opacity)
    expect(store.get()).not.toBe(snapshot)
  })

  it('修改 set() 的返回值不影响后续读取', () => {
    const store = createConfigStore({ dir: makeTempDir() })
    const returned = store.set({ sizePercent: 40 })
    returned.sizePercent = 99
    expect(store.get().sizePercent).toBe(40)
  })
})

describe('写盘失败：只 warn 不抛，内存态仍更新', () => {
  it('dir 指向一个普通文件（无法建目录/写文件）→ set 不抛，get 返回新值，logger 收到 warn', () => {
    const base = makeTempDir()
    const fileAsDir = join(base, 'i-am-a-file')
    writeFileSync(fileAsDir, 'not a directory', 'utf8')
    const logger = createFakeLogger()

    let store: ReturnType<typeof createConfigStore> | undefined
    expect(() => {
      store = createConfigStore({ dir: fileAsDir, logger })
    }).not.toThrow()
    expect(store?.get()).toEqual(DEFAULT_CONFIG)

    expect(() => store?.set({ sizePercent: 44 })).not.toThrow()
    expect(store?.get().sizePercent).toBe(44) // 内存态已更新
    expect(logger.warnings.length).toBeGreaterThan(0)
  })
})

describe('toConfigPartial：IPC 入参防御性收窄', () => {
  it('非对象输入 → {}', () => {
    expect(toConfigPartial(null)).toEqual({})
    expect(toConfigPartial(undefined)).toEqual({})
    expect(toConfigPartial([1, 2])).toEqual({})
    expect(toConfigPartial('str')).toEqual({})
    expect(toConfigPartial(42)).toEqual({})
  })

  it('只保留显式提供且属于 PetConfig 的键（未提供的键不出现，避免覆盖用户已存配置）', () => {
    expect(toConfigPartial({})).toEqual({})
    expect(toConfigPartial({ sizePercent: 40, unknownKey: 'x' })).toEqual({ sizePercent: 40 })
    // 非自有属性不是「显式提供」
    expect(toConfigPartial(Object.create({ sizePercent: 99 }))).toEqual({})
  })

  it('显式键的值走 sanitizeConfig 清洗（钳制 / 非法类型回退默认）', () => {
    expect(toConfigPartial({ sizePercent: 9, fpsCap: 4 })).toEqual({ sizePercent: 10, fpsCap: 5 })
    expect(toConfigPartial({ sizePercent: 'bad', opacity: 2 })).toEqual({
      sizePercent: DEFAULT_CONFIG.sizePercent,
      opacity: 1
    })
  })

  it('与 store.set 组合后保持部分更新语义：只改显式键，其它键保留', () => {
    const store = createConfigStore({ dir: makeTempDir() })
    store.set({ opacity: 0.5 })

    const next = store.set(toConfigPartial({ fpsCap: 60 }))
    expect(next.fpsCap).toBe(60)
    expect(next.opacity).toBe(0.5) // 不被默认值 1 覆盖
    expect(next.sizePercent).toBe(DEFAULT_CONFIG.sizePercent)
  })
})

describe('文件落盘与重新读取一致（端到端）', () => {
  it('多次部分更新后新建 store 读回与内存态完全一致', () => {
    const dir = makeTempDir()
    const store = createConfigStore({ dir })
    store.set({ sizePercent: 45 })
    store.set({ opacity: 0.7 })
    store.set({ autonomousLevel: 'high', clickThrough: false })
    const expected = store.get()

    const reopened = createConfigStore({ dir })
    expect(reopened.get()).toEqual(expected)
    expect(readFileSync(join(dir, 'config.json'), 'utf8').endsWith('\n')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'R-27：最终 config.json mode 为 0600（原子 rename 保留 tmp 的权限位）',
    () => {
      const dir = makeTempDir()
      const store = createConfigStore({ dir })
      store.set({ sizePercent: 45 })
      store.set({ opacity: 0.7 })

      const mode = statSync(join(dir, 'config.json')).mode & 0o777
      expect(mode).toBe(0o600)
      // 同机其它用户不可读（group/other 位为空）——权限的实质目的。
      expect(mode & 0o077).toBe(0)
      // 临时文件已 rename，不残留。
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    }
  )
})
