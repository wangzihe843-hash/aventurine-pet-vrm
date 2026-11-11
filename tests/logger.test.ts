/**
 * A3 单测：日志落盘（`src/main/logger.ts`）。
 *
 * 覆盖 PLAN §5-A3 / §17.5 验收要求：
 * - 目录不存在时自动 `mkdirSync(recursive)`；
 * - 行格式 `ISO时间 [LEVEL] message {json meta}`，时间可注入（固定 now）；
 * - 四个级别都落盘；message 换行被转义保持一行一条；
 * - 超过 maxBytes 写前轮转为 `main.log.1`（覆盖旧 .1）；
 * - fs 不可写（dir 替换为普通文件路径）时只 console.error 兜底，**绝不抛异常**；
 * - meta 不可序列化（循环引用 / BigInt）不抛；Error meta 落盘 name/message/stack 首行（F4），
 *   String 兜底也转义换行防日志注入（F9）。
 *
 * 本文件与 `logger.ts` 一样**不 import electron**：目录全部注入 `mkdtempSync` 临时目录。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLogger } from '../src/main/logger'

/** 固定时间：用于断言行首 ISO 时间（等价于 `Date.prototype.toISOString` 输出）。 */
const FIXED_NOW = new Date('2026-11-07T12:34:56.789Z')
const FIXED_ISO = '2026-11-07T12:34:56.789Z'

/** 本用例创建的临时目录，afterEach 统一清理。 */
const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pet-logger-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 读取日志文件并按行切分（去掉末尾空行）。 */
function readLines(filePath: string): string[] {
  return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0)
}

describe('目录自动创建与落盘路径', () => {
  it('多级目录不存在时自动创建，日志写 main.log', () => {
    const dir = join(makeTempDir(), 'a', 'b', 'logs')
    const logger = createLogger({ dir, now: () => FIXED_NOW })

    expect(logger.filePath).toBe(join(dir, 'main.log'))
    expect(existsSync(dir)).toBe(true) // 创建 logger 即建目录

    logger.info('hello')
    expect(existsSync(logger.filePath)).toBe(true)
    expect(readLines(logger.filePath)).toHaveLength(1)
  })
})

describe('行格式：ISO 时间 + [LEVEL] + message + json meta', () => {
  it('注入固定 now：行内容可精确断言（含 meta）', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    logger.info('hello', { a: 1, b: 'x' })
    expect(readLines(logger.filePath)).toEqual([`${FIXED_ISO} [INFO] hello {"a":1,"b":"x"}`])
  })

  it('meta 省略时行尾无 JSON；meta 支持数字/数组/字符串', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    logger.info('plain')
    logger.warn('count', 3)
    logger.debug('list', [1, 2])
    logger.error('tag', 'boom')

    expect(readLines(logger.filePath)).toEqual([
      `${FIXED_ISO} [INFO] plain`,
      `${FIXED_ISO} [WARN] count 3`,
      `${FIXED_ISO} [DEBUG] list [1,2]`,
      `${FIXED_ISO} [ERROR] tag "boom"`
    ])
  })

  it('四个级别都写入且级别大写标记正确', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    const lines = readLines(logger.filePath)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('[DEBUG] d')
    expect(lines[1]).toContain('[INFO] i')
    expect(lines[2]).toContain('[WARN] w')
    expect(lines[3]).toContain('[ERROR] e')
    for (const line of lines) expect(line.startsWith(FIXED_ISO)).toBe(true)
  })

  it('message 内换行被转义，保证一条日志一行', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    logger.info('line1\nline2\r\nline3')

    const lines = readLines(logger.filePath)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(`${FIXED_ISO} [INFO] line1\\nline2\\nline3`)
  })

  it('meta 不可序列化时不抛异常（循环引用 / BigInt），退化为 String', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => logger.info('circular', circular)).not.toThrow()
    expect(() => logger.info('bigint', 10n)).not.toThrow()

    const lines = readLines(logger.filePath)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[INFO] circular [object Object]')
    expect(lines[1]).toContain('[INFO] bigint 10')
  })

  it('meta 是 Error 时落盘 name/message/stack 首行（F4：不再丢成 {}）', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    const error = new TypeError('boom')
    error.stack = 'TypeError: boom\n    at firstFrame (a.ts:1:1)\n    at secondFrame (b.ts:2:2)'

    logger.warn('[config] 写入配置失败', error)

    const lines = readLines(logger.filePath)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[WARN] [config] 写入配置失败 {"name":"TypeError","message":"boom"')
    const metaJson = lines[0].slice(lines[0].indexOf('{'))
    expect(JSON.parse(metaJson)).toEqual({
      name: 'TypeError',
      message: 'boom',
      stack: 'TypeError: boom' // 只保留首行，不含后续 frame
    })
  })

  it('String 兜底也转义换行（F9：不可序列化 meta 不能伪造日志行）', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    const malicious = {
      toJSON(): never {
        throw new Error('toJSON disabled')
      },
      toString(): string {
        return 'INJECTED\n2026-01-01T00:00:00.000Z [ERROR] FORGED-BY-META'
      }
    }

    expect(() => logger.info('meta-injection', malicious)).not.toThrow()

    const lines = readLines(logger.filePath)
    expect(lines).toHaveLength(1) // 不得被拆成两行
    expect(lines[0]).toBe(
      `${FIXED_ISO} [INFO] meta-injection INJECTED\\n2026-01-01T00:00:00.000Z [ERROR] FORGED-BY-META`
    )
  })
})

describe('按大小轮转：main.log → main.log.1（覆盖旧 .1）', () => {
  it('首次写前文件不存在不轮转；超过 maxBytes 后下次写前轮转并覆盖旧 .1', () => {
    const dir = makeTempDir()
    const logger = createLogger({ dir, maxBytes: 120, now: () => FIXED_NOW })
    const filePath = logger.filePath
    const rotatedPath = `${filePath}.1`

    const first = `first:${'x'.repeat(150)}` // 单行 > 120，先写入（写前文件不存在，不轮转）
    const second = 'second-line'
    const third = `third:${'y'.repeat(150)}`

    logger.info(first)
    expect(existsSync(rotatedPath)).toBe(false)
    const firstSize = readFileSync(filePath, 'utf8').length
    expect(firstSize).toBeGreaterThan(120)

    // 写前 stat 发现已超限 → 轮转（旧 .1 不存在，直接改名），新文件只含 second
    logger.info(second)
    expect(existsSync(rotatedPath)).toBe(true)
    expect(readLines(rotatedPath)).toEqual([`${FIXED_ISO} [INFO] ${first}`])
    expect(readLines(filePath)).toEqual([`${FIXED_ISO} [INFO] ${second}`])

    // 再写一条大日志把当前 main.log 撑过上限 → 下一次写入把 .1 覆盖为 [second, third]
    logger.info(third)
    logger.info('fourth')
    expect(readLines(rotatedPath)).toEqual([
      `${FIXED_ISO} [INFO] ${second}`,
      `${FIXED_ISO} [INFO] ${third}`
    ])
    expect(readLines(filePath)).toEqual([`${FIXED_ISO} [INFO] fourth`])
  })

  it('maxBytes 非法（0 / 负数 / 非数字）时回退默认 1MB，不提前轮转', () => {
    const dir = makeTempDir()
    const logger = createLogger({ dir, maxBytes: 0, now: () => FIXED_NOW })
    logger.info('hello')
    logger.info('world')
    expect(readLines(logger.filePath)).toHaveLength(2)
    expect(existsSync(`${logger.filePath}.1`)).toBe(false)
  })
})

describe('fs 失败：只 console.error 兜底，绝不抛异常', () => {
  it('dir 是普通文件路径（无法建目录/写文件）→ createLogger 与各级别日志调用都不抛', () => {
    const base = makeTempDir()
    const fileAsDir = join(base, 'i-am-a-file')
    writeFileSync(fileAsDir, 'not a directory', 'utf8')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let logger: ReturnType<typeof createLogger> | undefined
    expect(() => {
      logger = createLogger({ dir: fileAsDir, now: () => FIXED_NOW })
    }).not.toThrow()

    expect(() => {
      logger?.debug('d')
      logger?.info('i')
      logger?.warn('w')
      logger?.error('e')
      logger?.flush?.()
    }).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('console 镜像选项', () => {
  it('默认只落盘，不打印到控制台', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    logger.info('file-only')

    expect(readLines(logger.filePath)).toHaveLength(1)
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it('console:true 时按级别镜像同一行到控制台', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW, console: true })
    logger.info('mirror', { ok: true })

    const expected = `${FIXED_ISO} [INFO] mirror {"ok":true}`
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy.mock.calls[0]?.[0]).toBe(expected)
    // 落盘内容与镜像内容一致
    expect(readLines(logger.filePath)).toEqual([expected])
  })

  it('flush 存在且可安全调用（当前实现同步写、无缓冲）', () => {
    const logger = createLogger({ dir: makeTempDir(), now: () => FIXED_NOW })
    expect(typeof logger.flush).toBe('function')
    expect(() => logger.flush?.()).not.toThrow()
  })
})
