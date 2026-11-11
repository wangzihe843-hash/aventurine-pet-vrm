/**
 * 单测：桥目录静态状态读取器（`src/main/desktop/dsh-bridge-state.ts`，2026-11-11 兼容性安全 v2）。
 *
 * 全部离线注入：`readFile`/`stat`/`dir` 都是 fake；**不读写真实 `~/.dsh`**。
 *
 * 覆盖计划 §6.1：
 * - 读 `install.json` / `bridge-error.json`（共享契约解析器，schema 校验）；
 * - `mtime+size` 未变 → 不重复读盘；变化 → 重读；
 * - 16KB 上限（超限不读入内存）；
 * - 坏 JSON / 非法 schema → 静默忽略（null）；
 * - 文件缺失是正常状态；读取异常只 warn 一次、绝不抛。
 */
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  BRIDGE_DIAGNOSTIC_FILE,
  BRIDGE_INSTALL_MAX_BYTES,
  BRIDGE_INSTALL_FILE
} from '@shared/bridge-schema'

import { createBridgeStateReader } from '../src/main/desktop/dsh-bridge-state'
import type { BridgeFileStat } from '../src/main/desktop/dsh-bridge-state'

const DIR = '/tmp/fake-dsh/aventurine-pet'
const INSTALL_PATH = join(DIR, BRIDGE_INSTALL_FILE)
const DIAGNOSTIC_PATH = join(DIR, BRIDGE_DIAGNOSTIC_FILE)

/** 合法安装清单 JSON。 */
const INSTALL_JSON = JSON.stringify({
  schemaVersion: 1,
  installedAt: 1_794_371_618_741,
  installMethod: 'live-copy-insert',
  bridgeEntry: '/tmp/live-bridge/rev-1/lib/index.js',
  bridgePackageName: 'dsh-aventurine-bridge',
  bridgePackageVersion: '0.2.0',
  bridgeVersion: 4,
  controlSchema: 1,
  dshRange: '>=0.2.2-rc.1 <0.3.0',
  dshVersionAtInstall: '0.2.2-rc.1'
})

/** 合法桥故障诊断 JSON。 */
const DIAGNOSTIC_JSON = JSON.stringify({
  schemaVersion: 1,
  ts: 1_794_376_241_734,
  phase: 'apply',
  message: 'Error: cannot read package.json',
  bridgeVersion: 4,
  dshRange: '>=0.2.2-rc.1 <0.3.0'
})

/** 假文件系统（路径 → 内容 + 签名）。 */
interface FakeFs {
  files: Map<string, { content: string; stat: BridgeFileStat }>
  readCalls: string[]
  statCalls: string[]
  readFile: (path: string) => string
  stat: (path: string) => BridgeFileStat | null
}

function fakeFs(
  entries: Record<string, { content: string; mtimeMs?: number; size?: number }> = {}
): FakeFs {
  const files = new Map<string, { content: string; stat: BridgeFileStat }>()
  for (const [path, entry] of Object.entries(entries)) {
    files.set(path, {
      content: entry.content,
      stat: {
        mtimeMs: entry.mtimeMs ?? 1000,
        size: entry.size ?? Buffer.byteLength(entry.content)
      }
    })
  }
  const readCalls: string[] = []
  const statCalls: string[] = []
  return {
    files,
    readCalls,
    statCalls,
    readFile(path: string): string {
      readCalls.push(path)
      const entry = files.get(path)
      if (!entry) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
      return entry.content
    },
    stat(path: string): BridgeFileStat | null {
      statCalls.push(path)
      return files.get(path)?.stat ?? null
    }
  }
}

describe('createBridgeStateReader：读取与解析', () => {
  it('读 install.json / bridge-error.json（共享契约解析）并返回 dir', () => {
    const fs = fakeFs({
      [INSTALL_PATH]: { content: INSTALL_JSON },
      [DIAGNOSTIC_PATH]: { content: DIAGNOSTIC_JSON }
    })
    const reader = createBridgeStateReader({
      dir: DIR,
      readFile: fs.readFile,
      stat: fs.stat
    })
    const state = reader.read()
    expect(state.dir).toBe(DIR)
    expect(state.installManifest).toMatchObject({
      bridgeVersion: 4,
      dshRange: '>=0.2.2-rc.1 <0.3.0',
      installMethod: 'live-copy-insert'
    })
    expect(state.diagnostic).toMatchObject({ phase: 'apply', bridgeVersion: 4 })
  })

  it('文件缺失（未装桥）→ null 字段，不 warn、不抛', () => {
    const fs = fakeFs()
    const logger = { warn: vi.fn() }
    const reader = createBridgeStateReader({
      dir: DIR,
      readFile: fs.readFile,
      stat: fs.stat,
      logger
    })
    expect(reader.read()).toEqual({ installManifest: null, diagnostic: null, dir: DIR })
    expect(logger.warn).not.toHaveBeenCalled()
    expect(fs.readCalls).toHaveLength(0)
  })

  it('坏 JSON / schema 不匹配 → 静默忽略（null）', () => {
    const fs = fakeFs({
      [INSTALL_PATH]: { content: '{broken' },
      [DIAGNOSTIC_PATH]: { content: JSON.stringify({ schemaVersion: 2, ts: 1, phase: 'x', message: 'y' }) }
    })
    const reader = createBridgeStateReader({ dir: DIR, readFile: fs.readFile, stat: fs.stat })
    const state = reader.read()
    expect(state.installManifest).toBeNull()
    expect(state.diagnostic).toBeNull()
  })
})

describe('createBridgeStateReader：mtime 缓存与上限', () => {
  it('mtime+size 未变 → 第二次 read 不重复读盘', () => {
    const fs = fakeFs({ [INSTALL_PATH]: { content: INSTALL_JSON } })
    const reader = createBridgeStateReader({ dir: DIR, readFile: fs.readFile, stat: fs.stat })
    const first = reader.read()
    const second = reader.read()
    expect(second.installManifest).toEqual(first.installManifest)
    expect(fs.readCalls).toHaveLength(1)
  })

  it('mtime 变化 → 重读并使用新内容', () => {
    const fs = fakeFs({ [INSTALL_PATH]: { content: INSTALL_JSON, mtimeMs: 1000 } })
    const reader = createBridgeStateReader({ dir: DIR, readFile: fs.readFile, stat: fs.stat })
    expect(reader.read().installManifest?.bridgeVersion).toBe(4)

    const next = { ...JSON.parse(INSTALL_JSON), bridgeVersion: 3 }
    fs.files.set(INSTALL_PATH, {
      content: JSON.stringify(next),
      stat: { mtimeMs: 2000, size: Buffer.byteLength(JSON.stringify(next)) }
    })
    expect(reader.read().installManifest?.bridgeVersion).toBe(3)
    expect(fs.readCalls).toHaveLength(2)
  })

  it(`超过 ${BRIDGE_INSTALL_MAX_BYTES}B 上限 → 忽略且不读入内存`, () => {
    const fs = fakeFs({
      [INSTALL_PATH]: { content: INSTALL_JSON, size: BRIDGE_INSTALL_MAX_BYTES + 1 }
    })
    const logger = { warn: vi.fn() }
    const reader = createBridgeStateReader({ dir: DIR, readFile: fs.readFile, stat: fs.stat, logger })
    expect(reader.read().installManifest).toBeNull()
    expect(fs.readCalls).toHaveLength(0)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('读取异常 → null、只 warn 一次、绝不抛', () => {
    const logger = { warn: vi.fn() }
    const readFile = (): string => {
      throw new Error('EACCES')
    }
    const reader = createBridgeStateReader({
      dir: DIR,
      readFile,
      stat: (path) => ({ mtimeMs: 1, size: 10 }),
      logger
    })
    expect(() => reader.read()).not.toThrow()
    expect(reader.read().installManifest).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('stat 抛异常 → 不抛、返回 null', () => {
    const reader = createBridgeStateReader({
      dir: DIR,
      readFile: () => INSTALL_JSON,
      stat: () => {
        throw new Error('stat boom')
      }
    })
    expect(reader.read()).toEqual({ installManifest: null, diagnostic: null, dir: DIR })
  })

  it('文件被删除后 read → 缓存清空返回 null；重新出现后按新签名读取', () => {
    const fs = fakeFs({ [INSTALL_PATH]: { content: INSTALL_JSON } })
    const reader = createBridgeStateReader({ dir: DIR, readFile: fs.readFile, stat: fs.stat })
    expect(reader.read().installManifest).not.toBeNull()

    const cached = fs.files.get(INSTALL_PATH)
    fs.files.delete(INSTALL_PATH)
    expect(reader.read().installManifest).toBeNull()

    if (cached) {
      fs.files.set(INSTALL_PATH, {
        content: cached.content,
        stat: { mtimeMs: cached.stat.mtimeMs + 500, size: cached.stat.size }
      })
    }
    expect(reader.read().installManifest).not.toBeNull()
  })
})

describe('createBridgeStateReader：目录解析', () => {
  it('options.dir 优先；env PET_DSH_DIR 次之；默认 ~/.dsh/aventurine-pet', () => {
    expect(createBridgeStateReader({ dir: '/custom/dir' }).dir).toBe('/custom/dir')
    expect(createBridgeStateReader({ env: { PET_DSH_DIR: '/from/env' } }).dir).toBe('/from/env')
    expect(createBridgeStateReader({ env: {} }).dir.endsWith('/.dsh/aventurine-pet')).toBe(true)
  })
})
