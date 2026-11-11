/**
 * 单测：DSH 版本探测器（`src/main/desktop/dsh-version.ts`，2026-11-11 兼容性安全 v2）。
 *
 * 全部离线注入：`readFile`/`exists`/`execFile`/`now` 都是 fake；**不读真实
 * `/Applications`、不执行真实 lsappinfo/mdfind/plutil、不碰真实 `~/.dsh`**。
 *
 * 覆盖计划 §6.1：
 * - 路径候选优先级：override → 默认安装位 → lsappinfo → mdfind（惰性，前一个成功不跑后面的命令）；
 * - XML plist 文本解析 `<key>CFBundleShortVersionString</key><string>…</string>`；
 * - 二进制 plist / XML 缺键 → `plutil -extract … raw` 兜底；
 * - 任何失败返回 `version:null` + `error`，**绝不抛**；
 * - 60s 缓存（成功与失败都缓存）、`invalidate()`、并发 detect 共享 in-flight Promise。
 */
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DSH_APP_PATH,
  DSH_APP_PATH_ENV,
  DSH_VERSION_CACHE_MS,
  createDshVersionDetector,
  parseLsappinfoBundlePath
} from '../src/main/desktop/dsh-version'
import type { DshVersionExecFile } from '../src/main/desktop/dsh-version'

/** 造一份 XML Info.plist 文本。 */
function xmlPlist(version: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>CFBundleIdentifier</key>',
    '\t<string>com.deepseek.dsh</string>',
    '\t<key>CFBundleShortVersionString</key>',
    `\t<string>${version}</string>`,
    '</dict>',
    '</plist>'
  ].join('\n')
}

/** 假文件系统：path → 文本；readFile 缺失时抛 ENOENT。 */
interface FakeFs {
  files: Map<string, string>
  readCalls: string[]
  readFile: (path: string) => string
  exists: (path: string) => boolean
}

function fakeFs(files: Record<string, string> = {}): FakeFs {
  const map = new Map(Object.entries(files))
  const readCalls: string[] = []
  return {
    files: map,
    readCalls,
    readFile(path: string): string {
      readCalls.push(path)
      const text = map.get(path)
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
          code: 'ENOENT'
        })
      }
      return text
    },
    exists(path: string): boolean {
      if (map.has(path)) return true
      // app bundle 目录本身不在 files 里，但它的 Contents/Info.plist 在 → 视作存在。
      const prefix = path.endsWith('/') ? path : `${path}/`
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) return true
      }
      return false
    }
  }
}

/** 永不成功的 exec（用于断言"前面的候选成功就不跑命令"）。 */
const failExec: DshVersionExecFile = async (file, args) => {
  throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
}

/** 记录调用并按键返回 stdout 的 exec fake。 */
function scriptedExec(
  handler: (file: string, args: readonly string[]) => string | null
): DshVersionExecFile & { calls: Array<{ file: string; args: readonly string[] }> } {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const exec = (async (file: string, args: readonly string[]) => {
    calls.push({ file, args })
    const stdout = handler(file, args)
    if (stdout === null) throw Object.assign(new Error(`${file} exited 1`), { code: 'ENOENT' })
    return { stdout }
  }) as DshVersionExecFile & { calls: typeof calls }
  exec.calls = calls
  return exec
}

const plistPathOf = (appPath: string): string => join(appPath, 'Contents', 'Info.plist')

/** 从 exec 记录里数某命令调用次数。 */
function countCalls(
  exec: { calls: Array<{ file: string }> },
  file: string
): number {
  return exec.calls.filter((call) => call.file === file).length
}

describe('createDshVersionDetector：路径候选与版本读取', () => {
  it('PET_DSH_APP_PATH override + XML plist → 版本 + source=override，不执行任何命令', async () => {
    const appPath = '/opt/custom/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(appPath)]: xmlPlist('0.2.2-rc.1') })
    const exec = scriptedExec(() => null)
    const detector = createDshVersionDetector({
      env: { [DSH_APP_PATH_ENV]: appPath },
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })

    const info = await detector.detect()
    expect(info).toEqual({
      version: '0.2.2-rc.1',
      appPath,
      source: 'override'
    })
    expect(exec.calls).toHaveLength(0)
  })

  it('默认安装位存在 → source=info-plist，同样不执行命令（惰性候选）', async () => {
    const fs = fakeFs({ [plistPathOf(DEFAULT_DSH_APP_PATH)]: xmlPlist('0.2.2') })
    const exec = scriptedExec(() => null)
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })

    const info = await detector.detect()
    expect(info.version).toBe('0.2.2')
    expect(info.appPath).toBe('/Applications/DeepSeek Harness.app')
    expect(info.source).toBe('info-plist')
    expect(exec.calls).toHaveLength(0)
  })

  it('默认安装位失败 → lsappinfo 两段查询定位 bundlepath → source=lsappinfo', async () => {
    const located = '/Volumes/External/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(located)]: xmlPlist('0.2.2-rc.1') })
    let lsCount = 0
    const exec = scriptedExec((file) => {
      if (file !== 'lsappinfo') return null
      lsCount += 1
      return lsCount === 1
        ? '"ASN:0x0-0x1a2b3c-"'
        : '"bundlepath"="/Volumes/External/DeepSeek Harness.app"'
    })
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })

    const info = await detector.detect()
    expect(info.version).toBe('0.2.2-rc.1')
    expect(info.appPath).toBe(located)
    expect(info.source).toBe('lsappinfo')
    expect(countCalls(exec, 'lsappinfo')).toBe(2)
    // lsappinfo 成功后不再跑 mdfind。
    expect(countCalls(exec, 'mdfind')).toBe(0)
  })

  it('lsappinfo 失败 → mdfind 首行兜底 → source=mdfind', async () => {
    const located = '/Users/someone/Applications/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(located)]: xmlPlist('0.2.2-rc.1') })
    const exec = scriptedExec((file) => {
      if (file === 'mdfind') return `${located}\n/other/DeepSeek Harness.app`
      return null
    })
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })

    const info = await detector.detect()
    expect(info.version).toBe('0.2.2-rc.1')
    expect(info.appPath).toBe(located)
    expect(info.source).toBe('mdfind')
    expect(countCalls(exec, 'mdfind')).toBe(1)
  })

  it('二进制 plist（bplist 头）→ plutil -extract CFBundleShortVersionString raw 兜底', async () => {
    const appPath = '/Applications/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(appPath)]: 'bplist00\u0000\u0001binary-garbage' })
    const exec = scriptedExec((file, args) => {
      if (file === 'plutil' && args.includes('CFBundleShortVersionString')) return '0.2.2-rc.1\n'
      return null
    })
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })

    const info = await detector.detect()
    expect(info.version).toBe('0.2.2-rc.1')
    expect(countCalls(exec, 'plutil')).toBe(1)
    // plutil 参数完整（extract/raw/-o -）。
    const call = exec.calls.find((entry) => entry.file === 'plutil')
    expect(call?.args).toEqual([
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      plistPathOf(appPath)
    ])
  })

  it('XML 里没有版本键 → 走 plutil 兜底', async () => {
    const appPath = '/Applications/DeepSeek Harness.app'
    const fs = fakeFs({
      [plistPathOf(appPath)]: '<plist><dict><key>CFBundleIdentifier</key><string>x</string></dict></plist>'
    })
    const exec = scriptedExec((file) => (file === 'plutil' ? '0.2.2-rc.1' : null))
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })
    expect((await detector.detect()).version).toBe('0.2.2-rc.1')
  })

  it('读 Info.plist 抛错 + plutil 成功 → 仍返回版本（读取失败不放弃候选）', async () => {
    const appPath = '/Applications/DeepSeek Harness.app'
    const fs = fakeFs({})
    const exec = scriptedExec((file) => (file === 'plutil' ? '0.2.2-rc.1' : null))
    // 让默认安装位"存在"但 readFile 失败（模拟权限/损坏）。
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: (path) => path === appPath,
      execFile: exec
    })
    const info = await detector.detect()
    expect(info.version).toBe('0.2.2-rc.1')
    expect(info.source).toBe('info-plist')
  })

  it('非法 semver 版本 → 候选失败继续（最终 version:null + error）', async () => {
    const appPath = '/Applications/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(appPath)]: xmlPlist('version-two') })
    const exec = scriptedExec(() => null)
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })
    const info = await detector.detect()
    expect(info.version).toBeNull()
    expect(info.error).toContain('非法 semver')
  })

  it('全部候选失败 → version:null + 可读 error，绝不抛', async () => {
    const fs = fakeFs({})
    const exec = scriptedExec(() => null)
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec
    })
    const info = await detector.detect()
    expect(info.version).toBeNull()
    expect(info.appPath).toBeNull()
    expect(info.source).toBe('unknown')
    expect(info.error).toContain('未找到可读 DSH app')
  })

  it('execFile 永久 reject / readFile 永久抛错 → 仍不抛（Promise resolve version:null）', async () => {
    const detector = createDshVersionDetector({
      env: {},
      readFile: () => {
        throw new Error('EACCES')
      },
      exists: () => true,
      execFile: async () => {
        throw new Error('command failed')
      }
    })
    const info = await detector.detect()
    expect(info.version).toBeNull()
    expect(typeof info.error).toBe('string')
  })
})

describe('createDshVersionDetector：缓存 / invalidate / 并发', () => {
  it(`缓存 ${DSH_VERSION_CACHE_MS}ms：TTL 内重复 detect 不重读，过期后重读`, async () => {
    const appPath = '/Applications/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(appPath)]: xmlPlist('0.2.2-rc.1') })
    let clock = 1000
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: failExec,
      now: () => clock
    })

    await detector.detect()
    await detector.detect()
    expect(fs.readCalls).toHaveLength(1)

    clock += DSH_VERSION_CACHE_MS - 1
    await detector.detect()
    expect(fs.readCalls).toHaveLength(1)

    clock += 1
    await detector.detect()
    expect(fs.readCalls).toHaveLength(2)
  })

  it('失败结果同样缓存（避免每 tick 重拉重命令）；invalidate 后立即重试', async () => {
    const fs = fakeFs({})
    const exec = scriptedExec(() => null)
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: exec,
      now: () => 0
    })

    const first = await detector.detect()
    expect(first.version).toBeNull()
    const callsAfterFirst = exec.calls.length
    await detector.detect()
    expect(exec.calls.length).toBe(callsAfterFirst) // 缓存命中，没有新命令

    detector.invalidate()
    await detector.detect()
    expect(exec.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('并发 detect 共享同一个 in-flight 探测（readFile 只读一次）', async () => {
    const appPath = '/Applications/DeepSeek Harness.app'
    const fs = fakeFs({ [plistPathOf(appPath)]: xmlPlist('0.2.2-rc.1') })
    const detector = createDshVersionDetector({
      env: {},
      readFile: fs.readFile,
      exists: fs.exists,
      execFile: failExec
    })
    const [a, b, c] = await Promise.all([detector.detect(), detector.detect(), detector.detect()])
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(fs.readCalls).toHaveLength(1)
  })

  it('构造时不触碰 fs/命令（首次 detect 才读）', () => {
    const readFile = vi.fn(() => '')
    const exists = vi.fn(() => true)
    const execFile = vi.fn()
    createDshVersionDetector({ env: {}, readFile, exists, execFile })
    expect(readFile).not.toHaveBeenCalled()
    expect(exists).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('parseLsappinfoBundlePath', () => {
  it('解析标准 bundlepath 行', () => {
    expect(
      parseLsappinfoBundlePath('"bundlepath"="/Applications/DeepSeek Harness.app"\n')
    ).toBe('/Applications/DeepSeek Harness.app')
  })

  it('兼容无引号/多行输出（取第一条 .app 绝对路径）', () => {
    expect(
      parseLsappinfoBundlePath('bundlepath: /Users/x/Applications/DeepSeek Harness.app\n')
    ).toBe('/Users/x/Applications/DeepSeek Harness.app')
  })

  it('空/无关输出 → null', () => {
    expect(parseLsappinfoBundlePath('')).toBeNull()
    expect(parseLsappinfoBundlePath('ASN:0x0-0x1')).toBeNull()
  })
})
