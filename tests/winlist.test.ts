/**
 * A4 单测：窗口列表解析 / 变化检测 / Swift 助手 spawn 封装（`src/main/desktop/winlist.ts`）。
 *
 * 约束：vitest node 环境，不依赖 Electron / 真实 Swift 二进制 / 录屏权限：
 * - 解析与变化检测是纯函数，直接测；
 * - spawn 用注入的 fake（EventEmitter 模拟 stdout/stderr/close/error/kill），覆盖成功、
 *   非 0 退出、spawn error、同步抛错、超时、脏 JSON 等降级路径。
 *
 * 真实二进制由 `node scripts/build-native.mjs` 构建、`--check` 校验；本测试**不** spawn 它，
 * 保证干净 clone / 无 Xcode 的 CI 上也能跑。
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { WindowInfo } from '@shared/types'

import {
  createWinlistHelper,
  parseWinlistJson,
  WINLIST_MAX_STDOUT_BYTES,
  windowsChanged
} from '../src/main/desktop/winlist'
import type { SpawnFn } from '../src/main/desktop/winlist'

/* -------------------------------- 测试样例 -------------------------------- */

/** 合法助手输出（多窗口、中文 owner、负坐标、不同 layer/alpha/尺寸）。 */
const VALID_WINDOWS: WindowInfo[] = [
  {
    id: 42,
    pid: 501,
    owner: '访达',
    layer: 0,
    alpha: 1,
    bounds: { x: -120, y: 30, width: 800, height: 600 },
    onScreen: true
  },
  {
    id: 857,
    pid: 19674,
    owner: 'DeepSeek Harness',
    layer: 0,
    alpha: 0.5,
    bounds: { x: 323, y: 89, width: 1280, height: 820 },
    onScreen: true
  },
  {
    id: 24,
    pid: 517,
    owner: '程序坞',
    layer: 20,
    alpha: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    onScreen: true
  }
]

/** 与 VALID_WINDOWS 同内容的另一个数组实例（引用不同、值相同）。 */
function cloneWindows(windows: WindowInfo[] = VALID_WINDOWS): WindowInfo[] {
  return windows.map((window) => ({ ...window, bounds: { ...window.bounds } }))
}

/** 构造合法单项，便于用「单字段覆盖 / 删除字段」的 it.each 用例。 */
function makeRawWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    pid: 501,
    owner: '访达',
    layer: 0,
    alpha: 1,
    bounds: { x: -120, y: 30, width: 800, height: 600 },
    onScreen: true,
    ...overrides
  }
}

/* --------------------------------- fake spawn --------------------------------- */

/** fake 可读流：EventEmitter + setEncoding 记录（模拟 Node Readable 的编码切换）。 */
interface FakeReadable extends EventEmitter {
  encoding: string | null
  setEncoding: (encoding: string) => void
}

/** fake 子进程：EventEmitter + stdout/stderr 流 + kill() 记录。 */
interface FakeChild extends EventEmitter {
  stdout: FakeReadable
  stderr: FakeReadable
  killed: boolean
  kill: (signal?: string) => boolean
}

/** 创建 fake 可读流（记录 setEncoding 调用，便于断言 UTF-8 修复）。 */
function createFakeReadable(): FakeReadable {
  const readable = new EventEmitter() as FakeReadable
  readable.encoding = null
  readable.setEncoding = (encoding: string): void => {
    readable.encoding = encoding
  }
  return readable
}

/** 创建 fake 子进程（stdout/stderr 用独立 EventEmitter 模拟可读流）。 */
function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = createFakeReadable()
  child.stderr = createFakeReadable()
  child.killed = false
  child.kill = (): boolean => {
    child.killed = true
    return true
  }
  return child
}

/**
 * 构造注入用的 fake spawn：`behavior` 在 spawn 返回后的下一次宏任务里执行
 * （保证 helper 已挂好 stdout/stderr/error/close 监听）。
 */
function fakeSpawn(behavior: (child: FakeChild) => void): SpawnFn {
  const spawnFn = (): FakeChild => {
    const child = createFakeChild()
    setImmediate(() => behavior(child))
    return child
  }
  return spawnFn as unknown as SpawnFn
}

/** 让 fake 子进程输出 stdout 后正常退出。 */
function emitSuccess(child: FakeChild, stdout: string): void {
  child.stdout.emit('data', Buffer.from(stdout, 'utf8'))
  child.emit('close', 0, null)
}

/* ------------------------------- parseWinlistJson ------------------------------ */

describe('parseWinlistJson：合法输入', () => {
  it('解析多窗口 JSON 数组（中文 owner / 负坐标 / 非 0 layer / 小数 alpha）', () => {
    const parsed = parseWinlistJson(JSON.stringify(VALID_WINDOWS))

    expect(parsed).toEqual(VALID_WINDOWS)
    // 返回的是新对象，不与输入共享引用。
    expect(parsed[0]).not.toBe(VALID_WINDOWS[0])
    expect(parsed[0]?.bounds).not.toBe(VALID_WINDOWS[0]?.bounds)
  })

  it('容忍前后空白 / pretty-print 输出', () => {
    expect(parseWinlistJson(`\n  ${JSON.stringify(VALID_WINDOWS, null, 2)}\n`)).toEqual(VALID_WINDOWS)
  })

  it('空数组 / 空白 stdout → []', () => {
    expect(parseWinlistJson('[]')).toEqual([])
    expect(parseWinlistJson('  \n ')).toEqual([])
    expect(parseWinlistJson('')).toEqual([])
  })

  it('忽略未知额外字段（向前兼容 Swift 侧追加字段）', () => {
    const raw = makeRawWindow({ title: '不应读取', extra: { nested: true } })
    expect(parseWinlistJson(JSON.stringify([raw]))).toEqual([
      {
        id: 42,
        pid: 501,
        owner: '访达',
        layer: 0,
        alpha: 1,
        bounds: { x: -120, y: 30, width: 800, height: 600 },
        onScreen: true
      }
    ])
  })

  it('合法项与非法项混合时只保留合法项', () => {
    const raws = [
      makeRawWindow(),
      makeRawWindow({ id: '42' }),
      makeRawWindow({ id: 43, bounds: { x: 0, y: 0, width: 0, height: 600 } }),
      makeRawWindow({ id: 44 })
    ]
    expect(parseWinlistJson(JSON.stringify(raws)).map((window) => window.id)).toEqual([42, 44])
  })
})

describe('parseWinlistJson：脏输入一律降级为 []（不抛异常）', () => {
  it.each([
    ['非 JSON 文本', 'not json at all'],
    ['截断的 JSON', '[{"id":42,'],
    ['JSON 对象而非数组', '{"id":42}'],
    ['JSON null', 'null'],
    ['JSON 字符串', '"winlist"'],
    ['二进制垃圾', '\u0000\u0001\u0002']
  ])('%s → []', (_label, stdout) => {
    expect(parseWinlistJson(stdout)).toEqual([])
  })

  it('数组内全部非法 / 空数组 → []', () => {
    expect(parseWinlistJson('[null, 1, "x", [], {}]')).toEqual([])
  })
})

describe('parseWinlistJson：字段严格校验（非法项跳过）', () => {
  it.each([
    { label: 'id 为字符串', overrides: { id: '42' } },
    { label: 'id 为小数', overrides: { id: 42.5 } },
    { label: 'pid 缺失', overrides: { pid: undefined } },
    { label: 'layer 为字符串', overrides: { layer: '0' } },
    { label: 'layer 为小数', overrides: { layer: 0.5 } },
    { label: 'alpha 为字符串', overrides: { alpha: '1' } },
    { label: 'alpha 缺失', overrides: { alpha: undefined } },
    { label: 'owner 为数字', overrides: { owner: 42 } },
    { label: 'owner 缺失', overrides: { owner: undefined } },
    { label: 'onScreen 缺失', overrides: { onScreen: undefined } },
    { label: 'onScreen 为字符串', overrides: { onScreen: 'true' } },
    { label: 'bounds 缺失', overrides: { bounds: undefined } },
    { label: 'bounds 为 null', overrides: { bounds: null } },
    { label: 'bounds 为数组', overrides: { bounds: [] } },
    { label: 'bounds.x 缺失', overrides: { bounds: { y: 30, width: 800, height: 600 } } },
    { label: 'bounds.width 为字符串', overrides: { bounds: { x: 0, y: 0, width: '800', height: 600 } } },
    { label: 'bounds 宽为 0', overrides: { bounds: { x: 0, y: 0, width: 0, height: 600 } } },
    { label: 'bounds 高为负', overrides: { bounds: { x: 0, y: 0, width: 800, height: -1 } } }
  ])('$label → 丢弃', ({ overrides }) => {
    const raw = makeRawWindow(overrides)
    // JSON.stringify 会丢掉值为 undefined 的键，正好模拟「字段缺失」。
    expect(parseWinlistJson(JSON.stringify([raw]))).toEqual([])
  })
})

describe('parseWinlistJson：过滤规则', () => {
  it('ownPid 命中的窗口（宠物自身 overlay）被丢弃，其余保留', () => {
    const parsed = parseWinlistJson(JSON.stringify(VALID_WINDOWS), { ownPid: 501 })
    expect(parsed.map((window) => window.id)).toEqual([857, 24])
  })

  it('不传 ownPid 时不过滤自身进程', () => {
    expect(parseWinlistJson(JSON.stringify(VALID_WINDOWS))).toHaveLength(VALID_WINDOWS.length)
  })

  it('onScreen === false 的窗口被丢弃（onScreen === true 保留）', () => {
    const parsed = parseWinlistJson(
      JSON.stringify([makeRawWindow(), makeRawWindow({ id: 99, onScreen: false })])
    )
    expect(parsed.map((window) => window.id)).toEqual([42])
  })
})

/* -------------------------------- windowsChanged ------------------------------- */

describe('windowsChanged：稳定签名比较（顺序敏感）', () => {
  it('内容相同（不同对象实例）→ false', () => {
    expect(windowsChanged(VALID_WINDOWS, cloneWindows())).toBe(false)
  })

  it('同数组实例自身比较 → false', () => {
    expect(windowsChanged(VALID_WINDOWS, VALID_WINDOWS)).toBe(false)
  })

  it('空 ↔ 非空 → true', () => {
    expect(windowsChanged([], cloneWindows())).toBe(true)
    expect(windowsChanged(cloneWindows(), [])).toBe(true)
    expect(windowsChanged([], [])).toBe(false)
  })

  it('数量变化 → true', () => {
    expect(windowsChanged(VALID_WINDOWS, cloneWindows().slice(0, 2))).toBe(true)
  })

  it.each([
    { label: 'id 变化', mutate: (window: WindowInfo) => { window.id = 999 } },
    { label: 'pid 变化', mutate: (window: WindowInfo) => { window.pid = 999 } },
    { label: 'owner 变化', mutate: (window: WindowInfo) => { window.owner = 'Safari' } },
    { label: 'layer 变化', mutate: (window: WindowInfo) => { window.layer = 3 } },
    { label: 'alpha 变化', mutate: (window: WindowInfo) => { window.alpha = 0.25 } },
    { label: 'onScreen 变化', mutate: (window: WindowInfo) => { window.onScreen = false } },
    { label: 'bounds.x 变化', mutate: (window: WindowInfo) => { window.bounds.x -= 1 } },
    { label: 'bounds.y 变化', mutate: (window: WindowInfo) => { window.bounds.y += 1 } },
    { label: 'bounds.width 变化', mutate: (window: WindowInfo) => { window.bounds.width += 1 } },
    { label: 'bounds.height 变化', mutate: (window: WindowInfo) => { window.bounds.height += 1 } }
  ])('$label → true', ({ mutate }) => {
    const next = cloneWindows()
    mutate(next[1])
    expect(windowsChanged(VALID_WINDOWS, next)).toBe(true)
  })

  it('仅顺序变化（窗口 z 序变化）→ true', () => {
    expect(windowsChanged(VALID_WINDOWS, cloneWindows().reverse())).toBe(true)
  })
})

/* ------------------------------- createWinlistHelper ------------------------------- */

describe('createWinlistHelper：成功路径', () => {
  it('注入 fake spawn 输出合法 JSON → 解析出窗口数组，lastError 为 null', async () => {
    const spawn = fakeSpawn((child) => emitSuccess(child, JSON.stringify(VALID_WINDOWS)))
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual(VALID_WINDOWS)
    expect(helper.lastError()).toBeNull()
  })

  it('每次调用都 spawn 一次助手（轮询可重复调用）', async () => {
    let calls = 0
    const base = fakeSpawn((child) => emitSuccess(child, JSON.stringify(VALID_WINDOWS)))
    const spawn = ((...args: unknown[]) => {
      calls += 1
      return (base as unknown as (...innerArgs: unknown[]) => unknown)(...args)
    }) as unknown as SpawnFn
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await helper.list()
    await helper.list()
    expect(calls).toBe(2)
  })

  it('退出码 0 但 stdout 是脏 JSON → []（解析降级不算 helper 错误）', async () => {
    const spawn = fakeSpawn((child) => emitSuccess(child, 'not json'))
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual([])
    expect(helper.lastError()).toBeNull()
  })
})

describe('createWinlistHelper：stdout 编码 / 累计上限（A4-F04）', () => {
  it('对 stdout/stderr 调用 setEncoding(utf8)，交给流处理跨 chunk 多字节边界', async () => {
    let captured: FakeChild | null = null
    const spawn = fakeSpawn((child) => {
      captured = child
      emitSuccess(child, JSON.stringify(VALID_WINDOWS))
    })
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual(VALID_WINDOWS)
    expect((captured as FakeChild | null)?.stdout.encoding).toBe('utf8')
    expect((captured as FakeChild | null)?.stderr.encoding).toBe('utf8')
  })

  it('跨 chunk 拆开的多字节 UTF-8 字符（中文 owner）不损坏', async () => {
    const child = createFakeChild()
    const stdout = new PassThrough()
    child.stdout = stdout as unknown as FakeReadable

    const raw = JSON.stringify([makeRawWindow({ owner: '访达' })])
    const buffer = Buffer.from(raw, 'utf8')
    // 在「访」的 3 字节中间切开：逐 chunk toString('utf8') 的旧实现会产出 U+FFFD
    const splitIndex = Buffer.byteLength(raw.slice(0, raw.indexOf('访')), 'utf8') + 1

    const spawn = (() => {
      setImmediate(() => {
        stdout.write(buffer.subarray(0, splitIndex))
        stdout.write(buffer.subarray(splitIndex))
        child.emit('close', 0, null)
      })
      return child
    }) as unknown as SpawnFn
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    const windows = await helper.list()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.owner).toBe('访达')
    expect(windows[0]?.owner).not.toContain('\uFFFD')
  })

  it('stdout 累计超过 4MB：kill 子进程并降级为 []，lastError 记录超限', async () => {
    let captured: FakeChild | null = null
    const spawn = fakeSpawn((child) => {
      captured = child
      // 单 chunk 即超限（正常输出只有几 KB）
      child.stdout.emit('data', Buffer.alloc(WINLIST_MAX_STDOUT_BYTES + 1, 0x61))
    })
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual([])
    expect(helper.lastError()).toContain(
      `winlist stdout exceeded ${WINLIST_MAX_STDOUT_BYTES} bytes`
    )
    expect((captured as FakeChild | null)?.killed).toBe(true)
  })
})

describe('createWinlistHelper：错误降级（resolve []，lastError 有值，不 reject）', () => {
  it('非 0 退出 → [] + lastError 含退出码与 stderr 摘要', async () => {
    const spawn = fakeSpawn((child) => {
      child.stderr.emit('data', Buffer.from('CGWindowListCopyWindowInfo returned nil', 'utf8'))
      child.emit('close', 2, null)
    })
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual([])
    expect(helper.lastError()).toContain('code 2')
    expect(helper.lastError()).toContain('CGWindowListCopyWindowInfo returned nil')
  })

  it('spawn error 事件（如 ENOENT 二进制缺失）→ [] + lastError', async () => {
    const spawn = fakeSpawn((child) => {
      child.emit('error', new Error('spawn ENOENT'))
    })
    const helper = createWinlistHelper({ binPath: '/fake/missing', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual([])
    expect(helper.lastError()).toContain('ENOENT')
  })

  it('spawn 同步抛错 → [] + lastError（不冒泡 reject）', async () => {
    const spawn = (() => {
      throw new Error('spawn is not a function')
    }) as unknown as SpawnFn
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await expect(helper.list()).resolves.toEqual([])
    expect(helper.lastError()).toContain('spawn is not a function')
  })

  it('超时（子进程不退出）→ [] + lastError 含 timeout，并 kill 子进程', async () => {
    let captured: FakeChild | null = null
    const spawn = fakeSpawn((child) => {
      captured = child
      // 故意不 emit close/error：等 helper 的 timeout 分支。
    })
    const helper = createWinlistHelper({
      binPath: '/fake/winlist',
      spawn,
      ownPid: 1,
      timeoutMs: 25
    })

    await expect(helper.list()).resolves.toEqual([])
    expect(helper.lastError()).toContain('timeout after 25ms')
    expect(captured).not.toBeNull()
    expect((captured as FakeChild | null)?.killed).toBe(true)
  })

  it('成功后 lastError 清空（失败 → 成功的连续状态不残留）', async () => {
    let attempt = 0
    const spawn = fakeSpawn((child) => {
      attempt += 1
      if (attempt === 1) {
        child.emit('close', 1, null)
        return
      }
      emitSuccess(child, JSON.stringify(VALID_WINDOWS))
    })
    const helper = createWinlistHelper({ binPath: '/fake/winlist', spawn, ownPid: 1 })

    await helper.list()
    expect(helper.lastError()).not.toBeNull()
    await expect(helper.list()).resolves.toEqual(VALID_WINDOWS)
    expect(helper.lastError()).toBeNull()
  })
})
