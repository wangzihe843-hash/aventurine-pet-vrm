/**
 * A5 单测：DSH host-only 桥插件（`bridge/dsh-aventurine-bridge`）。
 *
 * 覆盖 PLAN §8/§9 约定、Wave 1 审查修复（H-2/H-3/M-7/M-8/F5/F8/F9/F10/F11）
 * 与 Wave 3 v2（assistant text / control.json / launchPet）：
 * - 包结构与安装元数据（bundle patch 形状、locale meta、icon、README）；
 * - 常量 parity：与冻结契约 `@shared/bridge-schema` 逐一相等（测试内不写魔法值）；
 * - 入口形态回归：`apply` 必须是箭头函数（不可构造），否则真实 cordis 会丢弃返回的 disposer；
 * - `apply` 启停文件契约（启动帧、control attached、原子写、disposer 离线帧 + detached、幂等）；
 * - **真实 DSH 形状**的事件映射：
 *   `agent/status { status, agent }` → task/start|end；
 *   `agent/error { turn, step, error, agent }` → task/error；
 *   `session/event (session, { type, seq, time, data })` 的 `turn/end` 按
 *   `data.reason.kind === 'error'` → task/error，其它 reason → session/event；
 *   `assistant/message` → session/event **带 assistant 输出文本** `payload.text`；
 *   `tool/result` → session/event（仅安全标量）；step 等高频事件忽略；
 * - v2 文本：多 text 块 `\n` join / trim / 空文本不写 / 8000 字符截断 / 异常 content 防御 /
 *   纯 tool-call 无 text / **user 输入、reasoning、tool 正文不得落盘**；
 * - v2 control：apply→attached、dispose→detached、原子写无 tmp 残留、0600、心跳不重写；
 * - v2 launchPet：fake spawn 校验 `open` 参数、path 优先、每 apply 最多一次、
 *   `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 禁用、失败只 warn；
 * - 同 turn 去重（agent/error 与 turn/end 先到先得）、running agent 被 dispose 的终止事件；
 * - 心跳、阈值覆盖（config.rotateBytes / config.maxLineBytes）、事件类型运行时白名单、
 *   目录不可写只 warn 不抛、`~/` 展开、文件权限、多实例临时文件唯一。
 *
 * 插件入口是纯 ESM JS（无 TS 构建步骤），因此用动态 import；所有写盘都落在
 * `mkdtempSync` 临时目录，绝不触碰真实的 `~/.dsh/aventurine-pet/`（`~/` 展开用例也只
 * 把 HOME 指向临时目录）。
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import * as schema from '@shared/bridge-schema'
import { satisfiesSemverRange } from '@shared/semver-range'

interface BridgeHandler {
  event: string
  handler: (...args: unknown[]) => void
  opts?: { global?: boolean }
}

interface FakeContext {
  handlers: BridgeHandler[]
  on(
    event: string,
    handler: (...args: unknown[]) => void,
    opts?: { global?: boolean }
  ): () => void
  emit(event: string, ...args: unknown[]): void
}

/** 最小 fake ctx：只依赖 apply 实际用到的 `ctx.on`（返回取消订阅函数）。 */
function makeFakeCtx(): FakeContext {
  const handlers: BridgeHandler[] = []
  return {
    handlers,
    on(event, handler, opts) {
      const entry: BridgeHandler = { event, handler, opts }
      handlers.push(entry)
      return () => {
        const index = handlers.indexOf(entry)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    emit(event, ...args) {
      for (const entry of handlers.filter((candidate) => candidate.event === event)) {
        entry.handler(...args)
      }
    }
  }
}

interface EventLog {
  appendEvent(type: string, payload?: Record<string, unknown>): boolean
  close(): void
  readonly lastEventAt: number
  readonly lastType: string | null
}

/** fake spawn 的返回子进程：只需 on/unref（桥插件对子进程的使用面）。 */
interface FakeChild {
  on(event: string, listener: (error: unknown) => void): void
  unref(): void
  listeners: Map<string, Array<(error: unknown) => void>>
}

interface SpawnCall {
  command: string
  args: string[]
  options: Record<string, unknown>
}

interface FakeSpawn {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => FakeChild
  calls: SpawnCall[]
  children: FakeChild[]
  unrefs: ReturnType<typeof vi.fn>[]
}

/** 构造 fake spawn（不启动任何真实进程）——launchPet 用例专用。 */
function makeFakeSpawn(
  behavior: { throwOnSpawn?: false; failWith?: Error } = {}
): FakeSpawn {
  const calls: SpawnCall[] = []
  const children: FakeChild[] = []
  const unrefs: ReturnType<typeof vi.fn>[] = []
  const spawn = (
    command: string,
    args: string[],
    options: Record<string, unknown>
  ): FakeChild => {
    calls.push({ command, args, options })
    const listeners = new Map<string, Array<(error: unknown) => void>>()
    const unref = vi.fn()
    unrefs.push(unref)
    const child: FakeChild = {
      listeners,
      on(event, listener) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      },
      unref
    }
    children.push(child)
    if (behavior.failWith !== undefined) {
      // 模拟 spawn 成功后子进程异步 'error'（如 open 不存在）。
      queueMicrotask(() => {
        for (const listener of listeners.get('error') ?? []) listener(behavior.failWith)
      })
    }
    return child
  }
  return { spawn, calls, children, unrefs }
}

interface BridgeModule {
  name: string
  apply(
    ctx: FakeContext,
    config?: Record<string, unknown>,
    deps?: {
      spawn?: FakeSpawn['spawn']
      env?: Record<string, string | undefined>
      resolveExecutable?: (appPath: string) => string | null
    }
  ): () => void
  createEventLog(options?: Record<string, unknown>): EventLog
  createPetLauncher(deps?: {
    spawn?: FakeSpawn['spawn']
    env?: Record<string, string | undefined>
    resolveExecutable?: (appPath: string) => string | null
  }): (config?: unknown) => boolean
}

interface ConstantsModule {
  BRIDGE_DIR_NAME: string
  BRIDGE_STATUS_FILE: string
  BRIDGE_EVENTS_FILE: string
  BRIDGE_CONTROL_FILE: string
  BRIDGE_CONTROL_SCHEMA_VERSION: number
  BRIDGE_PLUGIN_VERSION: number
  BRIDGE_INSTALL_SCHEMA_VERSION: number
  BRIDGE_DIAGNOSTIC_FILE: string
  BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS: number
  BRIDGE_DISABLE_LAUNCH_ENV: string
  BRIDGE_HEARTBEAT_MS: number
  BRIDGE_ONLINE_TTL_MS: number
  BRIDGE_ROTATE_BYTES: number
  BRIDGE_MAX_LINE_BYTES: number
  DSH_EVENT_TEXT_MAX_CHARS: number
  DSH_EVENT_TYPES: readonly string[]
  STATUS_FILE: string
  EVENTS_FILE: string
  CONTROL_FILE: string
  DIAGNOSTIC_FILE: string
  HEARTBEAT_MS: number
  ONLINE_TTL_MS: number
  ROTATE_BYTES: number
  MAX_LINE_BYTES: number
}

const packageDir = fileURLToPath(new URL('../bridge/dsh-aventurine-bridge', import.meta.url))

let bridge: BridgeModule
let constants: ConstantsModule

beforeAll(async () => {
  bridge = (await import(
    '../bridge/dsh-aventurine-bridge/lib/index.js'
  )) as unknown as BridgeModule
  constants = (await import(
    '../bridge/dsh-aventurine-bridge/lib/constants.js'
  )) as unknown as ConstantsModule
})

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.useRealTimers()
  delete process.env.AVENTURINE_BRIDGE_DIR
  delete process.env.AVENTURINE_BRIDGE_DISABLE_LAUNCH
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响断言。
    }
  }
})

function statusPathOf(dir: string): string {
  return join(dir, constants.BRIDGE_STATUS_FILE)
}

function eventsPathOf(dir: string): string {
  return join(dir, constants.BRIDGE_EVENTS_FILE)
}

function controlPathOf(dir: string): string {
  return join(dir, constants.BRIDGE_CONTROL_FILE)
}

/** 目录下残留的 status.json 临时文件（M-8：任何时刻都不应留下）。 */
function statusTmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const prefix = `.${constants.BRIDGE_STATUS_FILE}.`
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
}

/** 目录下残留的 control.json 临时文件（v2：原子写完成后不应留下）。 */
function controlTmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const prefix = `.${constants.BRIDGE_CONTROL_FILE}.`
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
}

/** 读 status.json 并用冻结契约校验器校验（同时证明文件结构合法）。 */
function readStatus(dir: string): schema.DshBridgeStatusFile {
  const parsed: unknown = JSON.parse(readFileSync(statusPathOf(dir), 'utf8'))
  expect(schema.isDshBridgeStatusFile(parsed)).toBe(true)
  return parsed as schema.DshBridgeStatusFile
}

/** 读 control.json 并用冻结契约校验器校验（T0：parseDshBridgeControlFile 脏输入返回 null）。 */
function readControl(dir: string): schema.DshBridgeControlFile {
  const control = schema.parseDshBridgeControlFile(readFileSync(controlPathOf(dir), 'utf8'))
  expect(control).not.toBeNull()
  return control as schema.DshBridgeControlFile
}

/** 读 events.jsonl 全部行，每行都必须能被 `parseDshEventLine` 解析。 */
function readEventLines(path: string): schema.DshEvent[] {
  const raw = readFileSync(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const event = schema.parseDshEventLine(line)
      expect(event).not.toBeNull()
      return event as schema.DshEvent
    })
}

function readEvents(dir: string): schema.DshEvent[] {
  return readEventLines(eventsPathOf(dir))
}

/** 断言目录/文件的 POSIX 权限：owner 位齐全、group/other 位为空（F8）。 */
function expectPrivateMode(path: string, ownerMask: number): void {
  const mode = statSync(path).mode & 0o777
  expect(mode & 0o077).toBe(0)
  expect(mode & ownerMask).toBe(ownerMask)
}

/** 桥包 `package.json` 声明的 `engines.dsh`（v4 compat.dshRange 的运行时来源；避免测试写魔法值）。 */
const DECLARED_DSH_RANGE: string = (() => {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const range = manifest?.engines?.dsh
  if (typeof range !== 'string' || range.length === 0) {
    throw new Error('bridge package.json is missing engines.dsh')
  }
  return range
})()

/** v4 compat 块的期望值（control/status 每帧都应携带，且与 package.json engines.dsh 一致）。 */
const EXPECTED_COMPAT = {
  bridgeVersion: 4,
  controlSchema: 1,
  dshRange: DECLARED_DSH_RANGE
} as const

function diagnosticPathOf(dir: string): string {
  return join(dir, constants.BRIDGE_DIAGNOSTIC_FILE)
}

/** 目录下残留的 bridge-error.json 临时文件（原子写完成后不应留下）。 */
function diagnosticTmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const prefix = `.${constants.BRIDGE_DIAGNOSTIC_FILE}.`
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
}

/** 读 bridge-error.json 并用共享契约 `parseDshBridgeDiagnostic` 校验（证明形状合法）。 */
function readDiagnostic(dir: string): schema.DshBridgeDiagnostic {
  const path = diagnosticPathOf(dir)
  expect(existsSync(path)).toBe(true)
  const parsed = schema.parseDshBridgeDiagnostic(readFileSync(path, 'utf8'))
  expect(parsed).not.toBeNull()
  return parsed as schema.DshBridgeDiagnostic
}

/**
 * 把桥包（lib + package.json）复制到临时目录，用来验证 v4 `dshRange` 确实读相邻 manifest
 * （live 副本形态与正规 bundle 安装同一逻辑）。`mutateManifest` 可改写/删除 engines。
 */
function copyBridgePackageToTemp(
  mutateManifest?: (manifest: Record<string, unknown>) => void
): string {
  const root = makeTempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  copyFileSync(join(packageDir, 'lib/index.js'), join(pkgDir, 'lib/index.js'))
  copyFileSync(join(packageDir, 'lib/constants.js'), join(pkgDir, 'lib/constants.js'))
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >
  if (mutateManifest) mutateManifest(manifest)
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest))
  return pkgDir
}

let copiedModuleSeq = 0

/** 以唯一 query 重新 import 临时副本（避免命中 ESM 缓存，保证每个用例读到自己的 manifest）。 */
async function importCopiedBridge(pkgDir: string): Promise<BridgeModule> {
  copiedModuleSeq += 1
  const href = `${pathToFileURL(join(pkgDir, 'lib/index.js')).href}?case=${copiedModuleSeq}`
  return (await import(/* @vite-ignore */ href)) as unknown as BridgeModule
}

// ---------------------------------------------------------------------------
// 真实 DSH 形状 fixture（本机 app.asar 抽取的 dsh-agent / dsh-agent-loop /
// dsh-session 源码 + 真实 headless session 日志 `session-a1c00648-…`）：
// - agent-scoped 事件由 DSH 融合 agent：{ ...payload, agent }；
// - agent/status payload = { status, agent }（status 是 top-level 契约字段）；
// - agent/error payload = { turn, step, error, agent }；
// - agent/created payload = { agent, source? }；agent/disposed payload = { agent }；
// - session/event 监听签名是 (session, event)，event = { type, seq, time, data }；
// - 真实错误信号：turn/end.data.reason.kind === 'error'（如 MISSING_CREDENTIAL）。
// ---------------------------------------------------------------------------

/** `agent/status` 真实形状：payload 顶层的 status + 融合进来的 agent。 */
function agentStatusFrame(id: string, status: 'idle' | 'running'): Record<string, unknown> {
  return { status, agent: { id } }
}

/** `agent/error` 真实形状：{ turn, step, error: { message, code }, agent }。 */
function agentErrorFrame(
  id: string,
  turn: number,
  step: number,
  message: string
): Record<string, unknown> {
  return { turn, step, error: { message, code: 'MISSING_CREDENTIAL' }, agent: { id } }
}

/** durable session 事件的真实外壳：{ type, seq, time, data }。 */
function durableEvent(
  type: string,
  seq: number,
  data: Record<string, unknown>
): Record<string, unknown> {
  return { type, seq, time: 1794057368604, data }
}

/** 发一条真实形状的 session/event（DSH 监听签名 `(session, event)`）。 */
function emitSessionEvent(
  ctx: FakeContext,
  sessionId: string,
  event: Record<string, unknown>
): void {
  ctx.emit('session/event', { id: sessionId }, event)
}

/**
 * `assistant/message` durable 事件的真实形状（审计 §2.4）：
 * `data.message.content` 是内容块数组（text / reasoning / tool-call …）。
 */
function assistantMessageEvent(
  seq: number,
  content: unknown[],
  data: Record<string, unknown> = { turn: 1, step: 1 }
): Record<string, unknown> {
  return durableEvent('assistant/message', seq, {
    ...data,
    message: { id: 'msg-canary-1', role: 'assistant', content }
  })
}

const TEXT_BLOCK = (text: string): Record<string, unknown> => ({ type: 'text', text })
const REASONING_BLOCK = (text: string): Record<string, unknown> => ({ type: 'reasoning', text })
const TOOL_CALL_BLOCK: Record<string, unknown> = {
  type: 'tool-call',
  id: 'toolu_1',
  name: 'todo_write',
  arguments: '{"hidden":"tool-arguments-sentinel"}'
}

const REAL_SESSION_ID = 'session-a1c00648-7ce6-4cbe-8ce5-132f981bc627'

describe('包结构与安装元数据', () => {
  it('package.json 声明 host-only bundle（type:module / main / exports / dsh.bundle.patch / files）', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

    expect(manifest.name).toBe('dsh-aventurine-bridge')
    // v4（2026-11-11 兼容性安全 v2）：0.1.0 → 0.2.0。版本变更会让 DSH compatibility.json 的
    // 旧豁免键（dsh-aventurine-bridge@0.1.0）失效 —— 这是预期行为（豁免不跨版本继承）。
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.private).toBe(true)
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('./lib/index.js')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    expect(manifest.exports?.['.']).toBe('./lib/index.js')
    expect(manifest.exports?.['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(manifest.exports?.['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports?.['./icon']).toBe('./icon.svg')

    // 运行时文件真实存在，且 files 清单覆盖所有资源（文件写全，避免 pack 后缺 locale/icon）。
    for (const file of [
      'lib/index.js',
      'lib/constants.js',
      'cordis.patch.yml',
      'locale/en.json',
      'locale/zh.json',
      'icon.svg',
      'README.md'
    ]) {
      expect(existsSync(join(packageDir, file))).toBe(true)
    }
    for (const entry of [
      'lib/index.js',
      'lib/constants.js',
      'cordis.patch.yml',
      'locale/*.json',
      'icon.svg',
      'README.md'
    ]) {
      expect(manifest.files).toContain(entry)
    }
  })

  it('engines.dsh 版本护栏覆盖当前测试基线（0.2.2-rc.1）且以 0.3.0 为硬上界', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

    // 有 engines.dsh 时 DSH 兼容性检查只认它（忽略 peerDependencies）：
    // - 当前 DSH 0.2.2-rc.1 在范围内 → 正常安装；
    // - 跨到 0.3 会被 DSH 插件管理器明确拒绝（要求精确版本豁免），而不是静默跑坏。
    expect(manifest.engines?.dsh).toBe('>=0.2.2-rc.1 <0.3.0')
    // 避免两条兼容性声明并存导致行为含混（engines.dsh 优先，但显式断言更稳）。
    expect(manifest.peerDependencies).toBeUndefined()
  })

  it('cordis.patch.yml 是包含 insert 行的 bundle patch 形状', () => {
    const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')

    expect(patch).toMatch(/^\s*-\s*insert:\s*$/m)
    expect(patch).toMatch(/^\s*-\s*id:\s*aventurine-bridge\s*$/m)
    expect(patch).toMatch(/^\s*name:\s*['"]?dsh-aventurine-bridge['"]?\s*$/m)
    // 只允许一条 insert；避免重复挂载（重复订阅会重复写事件）。
    expect(patch.match(/^\s*-\s*insert:\s*$/gm)).toHaveLength(1)
  })

  it('locale en/zh 提供非空 meta.title/description，icon 是 ≤256KiB 的 SVG', () => {
    for (const locale of ['en', 'zh']) {
      const parsed = JSON.parse(readFileSync(join(packageDir, 'locale', `${locale}.json`), 'utf8'))
      expect(typeof parsed.meta?.title).toBe('string')
      expect(parsed.meta.title.length).toBeGreaterThan(0)
      expect(typeof parsed.meta?.description).toBe('string')
      expect(parsed.meta.description.length).toBeGreaterThan(0)
    }

    const iconPath = join(packageDir, 'icon.svg')
    const iconBytes = statSync(iconPath).size
    expect(iconBytes).toBeGreaterThan(0)
    expect(iconBytes).toBeLessThanOrEqual(256 * 1024)

    const icon = readFileSync(iconPath, 'utf8')
    expect(icon.startsWith('<svg')).toBe(true)
    expect(icon.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('README 记录独立 profile 安装/卸载命令与「禁止装进正在使用的 profile」', () => {
    const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')

    expect(readme).toContain('dsh plugin --profile pet-bridge-test add -w')
    expect(readme).toContain('dsh plugin --profile pet-bridge-test remove dsh-aventurine-bridge')
    expect(readme).toContain('status.json')
    expect(readme).toContain('events.jsonl')
    expect(readme).toContain('offline')
    expect(readme).toMatch(/禁止装进正在使用的 profile/)
  })

  it('README 同步真实 DSH 事件映射/H-2 生命周期/单写者假设/轮转两段/权限语义', () => {
    const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')

    // H-2：箭头函数与 cordis isConstructor 机制必须写进 README（否则维护者会再踩坑）。
    expect(readme).toContain('export const apply')
    expect(readme).toContain('isConstructor')
    expect(readme).toContain('prototype')
    // H-3：真实错误信号与去重。
    expect(readme).toContain('agent/error')
    expect(readme).toContain('turn/end')
    expect(readme).toContain('reasonKind')
    expect(readme).toContain('去重')
    // M-8：单写者假设/多实例已知限制。
    expect(readme).toContain('单写者假设')
    // F7：轮转只保留两段 & B7 截断检测。
    expect(readme).toContain('events.jsonl.1')
    expect(readme).toContain('截断')
    // F8：权限。
    expect(readme).toContain('0700')
    expect(readme).toContain('0600')
    // F6：安装示例不得再指向已删除的 worktree。
    expect(readme).not.toContain('wt-a5-bridge')
  })

  it('README 记录 v4 契约：compat / bridge-error.json / 版本规则 / 禁止异步孤儿抛错 / runbook', () => {
    const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')

    // compat 自述：字段与来源（相邻 package.json engines.dsh）。
    expect(readme).toContain('compat')
    expect(readme).toContain('dshRange')
    expect(readme).toContain('bridgeVersion')
    expect(readme).toContain('engines.dsh')
    // apply 失败隔离 + 诊断文件。
    expect(readme).toContain('bridge-error.json')
    expect(readme).toContain('no-op disposer')
    // v3 legacy 向后兼容与 min supported 语义（E5）。
    expect(readme).toContain('BRIDGE_PLUGIN_MIN_SUPPORTED')
    expect(readme).toContain('BRIDGE_LEGACY_DSH_RANGE')
    // E10：防异步孤儿抛错的维护规则。
    expect(readme).toMatch(/异步孤儿抛错/)
    expect(readme).toContain('unhandledRejection')
    expect(readme).toContain('setInterval')
    // E1/E6：live 副本 engines + 安装清单 + runbook 指向。
    expect(readme).toContain('live 副本')
    expect(readme).toContain('install.json')
    expect(readme).toContain('docs/pet-dsh-coupling-runbook.md')
    expect(readme).toContain('--compat')
    // 版本号同步（package.json 0.2.0）。
    expect(readme).toContain('dsh-aventurine-bridge@0.2.0')
  })
})

describe('入口导出与 H-2 生命周期回归', () => {
  it('入口导出契约：name 常量 + apply 函数 + createEventLog 测试单元', () => {
    expect(bridge.name).toBe('dsh-aventurine-bridge')
    expect(typeof bridge.apply).toBe('function')
    expect(typeof bridge.createEventLog).toBe('function')
  })

  it('H-2 回归：apply 必须不可构造（箭头函数），否则真实 cordis 会丢弃返回的 disposer', () => {
    // 机理（本机 app.asar 抽取的真实 @deepseek-ai/cordis@4.1.0，lib/index.js:58-66,361-365）：
    //   function isConstructor(func) { if (!func.prototype) return false; … return true }
    //   if (isConstructor(runtime.callback)) {
    //     const instance = new runtime.callback(this.ctx, config)  // ← 普通 function 声明走这里
    //     return instance?.[symbols.init]?.()                     // ← 返回的 disposer 被丢弃
    //   } else return runtime.callback(this.ctx, config)          // ← 箭头函数走这里，返回值被收集为 effect
    // 普通 `export function apply` 有 .prototype → 被判为构造器 → apply 返回的 disposer 永不执行
    // （心跳 interval 不清、offline:true 不写）。箭头函数没有 prototype，这里是硬性回归断言。
    const applyPrototype = (bridge.apply as unknown as { prototype?: unknown }).prototype
    expect(applyPrototype).toBeUndefined()
  })

  it('apply 返回的仍是可调用的 disposer（fake ctx 下行为与真实 cordis 语义一致）', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      expect(typeof dispose).toBe('function')
      expect(readStatus(dir).offline).toBe(false)
    } finally {
      dispose()
    }
    expect(readStatus(dir).offline).toBe(true)
  })
})

describe('契约常量 parity（单一来源 = src/shared/bridge-schema.ts）', () => {
  it('文件名/心跳/TTL/轮转/行上限与冻结契约逐一相等', () => {
    expect(constants.BRIDGE_DIR_NAME).toBe(schema.BRIDGE_DIR_NAME)
    expect(constants.BRIDGE_STATUS_FILE).toBe(schema.BRIDGE_STATUS_FILE)
    expect(constants.BRIDGE_EVENTS_FILE).toBe(schema.BRIDGE_EVENTS_FILE)
    expect(constants.BRIDGE_CONTROL_FILE).toBe(schema.BRIDGE_CONTROL_FILE)
    expect(constants.BRIDGE_CONTROL_SCHEMA_VERSION).toBe(schema.BRIDGE_CONTROL_SCHEMA_VERSION)
    expect(constants.DSH_EVENT_TEXT_MAX_CHARS).toBe(schema.DSH_EVENT_TEXT_MAX_CHARS)
    expect(constants.BRIDGE_HEARTBEAT_MS).toBe(schema.BRIDGE_HEARTBEAT_MS)
    expect(constants.BRIDGE_ONLINE_TTL_MS).toBe(schema.BRIDGE_ONLINE_TTL_MS)
    expect(constants.BRIDGE_ROTATE_BYTES).toBe(schema.BRIDGE_ROTATE_BYTES)
    expect(constants.BRIDGE_MAX_LINE_BYTES).toBe(schema.BRIDGE_MAX_LINE_BYTES)
  })

  it('事件类型白名单与契约数组完全一致（顺序、内容、无重复）', () => {
    expect(constants.DSH_EVENT_TYPES).toEqual([...schema.DSH_EVENT_TYPES])
    expect(constants.DSH_EVENT_TYPES).toHaveLength(schema.DSH_EVENT_TYPES.length)
    expect(new Set(constants.DSH_EVENT_TYPES).size).toBe(schema.DSH_EVENT_TYPES.length)
    for (const type of constants.DSH_EVENT_TYPES) {
      expect(schema.isDshEventType(type)).toBe(true)
    }
  })

  it('v2：payload 白名单含 text 且写入侧/读取侧截断上限一致', () => {
    expect(schema.DSH_EVENT_PAYLOAD_KEYS).toContain('text')
    // 写入侧（桥常量）与读取侧（sanitize）同口径：8000 字符，UTF-16 code unit。
    expect(constants.DSH_EVENT_TEXT_MAX_CHARS).toBe(8000)
    expect(schema.DSH_EVENT_TEXT_MAX_CHARS).toBe(constants.DSH_EVENT_TEXT_MAX_CHARS)
    const longText = 'x'.repeat(schema.DSH_EVENT_TEXT_MAX_CHARS + 7)
    const sanitized = schema.sanitizeDshEventPayload({ text: longText })
    expect(typeof sanitized.text).toBe('string')
    expect((sanitized.text as string).length).toBe(schema.DSH_EVENT_TEXT_MAX_CHARS)
  })

  it('短名别名与 BRIDGE_* 契约常量同源', () => {
    expect(constants.STATUS_FILE).toBe(schema.BRIDGE_STATUS_FILE)
    expect(constants.EVENTS_FILE).toBe(schema.BRIDGE_EVENTS_FILE)
    expect(constants.CONTROL_FILE).toBe(schema.BRIDGE_CONTROL_FILE)
    expect(constants.DIAGNOSTIC_FILE).toBe(schema.BRIDGE_DIAGNOSTIC_FILE)
    expect(constants.HEARTBEAT_MS).toBe(schema.BRIDGE_HEARTBEAT_MS)
    expect(constants.ONLINE_TTL_MS).toBe(schema.BRIDGE_ONLINE_TTL_MS)
    expect(constants.ROTATE_BYTES).toBe(schema.BRIDGE_ROTATE_BYTES)
    expect(constants.MAX_LINE_BYTES).toBe(schema.BRIDGE_MAX_LINE_BYTES)
  })

  it('v4 parity：BRIDGE_PLUGIN_VERSION / 诊断与安装清单常量与共享契约一致', () => {
    // 单一来源 = src/shared/bridge-schema.ts；桥侧副本改动必须同步并通过本用例。
    expect(constants.BRIDGE_PLUGIN_VERSION).toBe(4)
    expect(constants.BRIDGE_PLUGIN_VERSION).toBe(schema.BRIDGE_PLUGIN_VERSION)
    // v4 桥必须仍在桌宠支持范围内（BRIDGE_PLUGIN_MIN_SUPPORTED = 3 legacy 下限）。
    expect(constants.BRIDGE_PLUGIN_VERSION).toBeGreaterThanOrEqual(schema.BRIDGE_PLUGIN_MIN_SUPPORTED)
    expect(constants.BRIDGE_DIAGNOSTIC_FILE).toBe('bridge-error.json')
    expect(constants.BRIDGE_DIAGNOSTIC_FILE).toBe(schema.BRIDGE_DIAGNOSTIC_FILE)
    expect(constants.BRIDGE_DIAGNOSTIC_FILE).not.toBe(constants.BRIDGE_CONTROL_FILE)
    expect(constants.BRIDGE_DIAGNOSTIC_FILE).not.toBe(constants.BRIDGE_STATUS_FILE)
    expect(constants.BRIDGE_INSTALL_SCHEMA_VERSION).toBe(schema.BRIDGE_INSTALL_SCHEMA_VERSION)
    expect(constants.BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS).toBe(
      schema.BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS
    )
  })

  it('v4 parity：manifest.engines.dsh 是 compat.dshRange 的声明源，且覆盖当前 DSH 基线/拒绝 0.3.0', () => {
    // 注意：不要求与 BRIDGE_LEGACY_DSH_RANGE 永久相等 —— 后者冻结的是 v3 桥的历史范围，
    // v4 桥将来适配新 DSH 时可独立调整 manifest；这里断言「声明源可读 + 语义可用」：
    // 当前基线 0.2.2-rc.1 在范围内、未来 0.3.0 被硬上界拒绝（与 DSH 版本闸门/C1 同语义，
    // E7 的 includePrerelease 语义由 Lead 的 semver-range 契约保证）。
    expect(typeof DECLARED_DSH_RANGE).toBe('string')
    expect(satisfiesSemverRange('0.2.2-rc.1', DECLARED_DSH_RANGE)).toBe(true)
    expect(satisfiesSemverRange('0.3.0', DECLARED_DSH_RANGE)).toBe(false)
    // 现网这一轮 v4 桥与 v3 桥声明同一范围（>=0.2.2-rc.1 <0.3.0）；范围调整时同步复核对旧桥的
    // legacy 回退语义（BRIDGE_LEGACY_DSH_RANGE 不随 v4 桥适配而变）。
    expect(DECLARED_DSH_RANGE).toBe(schema.BRIDGE_LEGACY_DSH_RANGE)
  })

  it('D1 收口：engines.dsh 只允许裸比较符（禁止 ^ ~ x * 与 hyphen/||）', () => {
    // 背景（2026-11-11 verifier D1）：DSH 内嵌 node-semver 版本会随 app 更新（7.7.x → 7.8.6 的
    // caret 下界 `-0` 语义已经出现差异），而桌宠侧 `src/shared/semver-range.ts` 是子集实现。
    // 桥自身的范围是「单一事实源」，把它限定为裸比较符（比较符 + 完整 semver）后，
    // 「桥声明 = DSH 闸门判定 = 桌宠判定」在 semver 7.x 各小版本间稳定；若未来维护者改成
    // caret/tilde/通配/hyphen，本用例会失败，提醒同时对齐 semver-range 语义。
    const tokens = DECLARED_DSH_RANGE.trim().split(/\s+/)
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      expect(token).toMatch(/^(>=|<=|>|<|=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    }
    expect(DECLARED_DSH_RANGE).not.toMatch(/[~^*xX]|\s-\s|\|\|/)
  })
})

describe('apply：status.json 启停契约', () => {
  it('启动即写合法心跳帧（非离线、toDshStatus online）+ control attached，全局订阅五类事件且无临时文件残留', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      expect(existsSync(statusPathOf(dir))).toBe(true)
      // 原子写不应留下临时文件（M-8：tmp 名唯一，正常 rename 后即消失）。
      expect(statusTmpFiles(dir)).toEqual([])

      const file = readStatus(dir)
      expect(file.offline).toBe(false)
      expect(file.running).toBe(false)
      expect(file.agents).toBe(0)
      expect(file.lastEventAt).toBe(0)
      expect(file.lastType).toBeNull()
      expect(file.ts).toBeGreaterThan(0)
      expect(schema.toDshStatus(file, Date.now()).online).toBe(true)

      // v2：apply 即写 control attached，帧合法且 dshPid = 当前进程。
      const control = readControl(dir)
      expect(control.action).toBe('attached')
      expect(control.schemaVersion).toBe(constants.BRIDGE_CONTROL_SCHEMA_VERSION)
      expect(control.dshPid).toBe(process.pid)
      expect(control.ts).toBeGreaterThan(0)
      expect(controlTmpFiles(dir)).toEqual([])

      expect(ctx.handlers.map((handler) => handler.event).sort()).toEqual([
        'agent/created',
        'agent/disposed',
        'agent/error',
        'agent/status',
        'session/event'
      ])
      for (const handler of ctx.handlers) {
        expect(handler.opts).toEqual({ global: true })
      }
    } finally {
      dispose()
    }
  })

  it('disposer 写显式离线帧（offline:true → 永不 online）+ control detached、幂等、退订后不再写事件', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    ctx.emit('agent/status', agentStatusFrame('agent-offline', 'running'))
    expect(readStatus(dir).running).toBe(true)
    expect(readControl(dir).action).toBe('attached')

    dispose()
    const offline = readStatus(dir)
    expect(offline.offline).toBe(true)
    expect(offline.running).toBe(false)
    expect(offline.agents).toBe(0)
    expect(schema.toDshStatus(offline, Date.now()).online).toBe(false)
    expect(Object.keys(schema.toDshStatus(offline, Date.now()))).toEqual([
      'online',
      'running',
      'lastEventAt',
      'lastType'
    ])

    // v2：dispose 写 detached（HMR 卸载/DSH 退出同一信号；消费方需 grace + 进程探测）。
    const detached = readControl(dir)
    expect(detached.action).toBe('detached')
    expect(detached.dshPid).toBe(process.pid)
    expect(controlTmpFiles(dir)).toEqual([])
    const detachedRaw = readFileSync(controlPathOf(dir), 'utf8')

    const eventCount = readEvents(dir).length
    expect(() => dispose()).not.toThrow()
    ctx.emit('agent/status', agentStatusFrame('agent-offline', 'idle'))
    emitSessionEvent(ctx, 'session-1', durableEvent('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }))
    expect(readEvents(dir)).toHaveLength(eventCount)
    expect(ctx.handlers).toHaveLength(0)
    expect(readStatus(dir).offline).toBe(true)
    // 幂等：第二次 dispose 不再写 control（内容逐字节不变）。
    expect(readFileSync(controlPathOf(dir), 'utf8')).toBe(detachedRaw)
  })

  it('目录优先级：config.dir > 环境变量 AVENTURINE_BRIDGE_DIR > 默认', () => {
    const envDir = makeTempDir()
    const configDir = makeTempDir()
    const previous = process.env.AVENTURINE_BRIDGE_DIR
    process.env.AVENTURINE_BRIDGE_DIR = envDir

    try {
      const envCtx = makeFakeCtx()
      const disposeEnv = bridge.apply(envCtx)
      try {
        expect(existsSync(join(envDir, constants.BRIDGE_STATUS_FILE))).toBe(true)
      } finally {
        disposeEnv()
      }

      const configCtx = makeFakeCtx()
      const disposeConfig = bridge.apply(configCtx, { dir: configDir })
      try {
        expect(existsSync(join(configDir, constants.BRIDGE_STATUS_FILE))).toBe(true)
        // config.dir 生效时不会写 env 目录的新帧（env 目录里只有上一步的离线帧）。
        expect(readStatus(configDir).offline).toBe(false)
        expect(readStatus(envDir).offline).toBe(true)
      } finally {
        disposeConfig()
      }
    } finally {
      if (previous === undefined) delete process.env.AVENTURINE_BRIDGE_DIR
      else process.env.AVENTURINE_BRIDGE_DIR = previous
    }
  })

  it('F10：config.dir / AVENTURINE_BRIDGE_DIR / 默认目录都支持 ~/ 展开（HOME 指向临时目录）', () => {
    if (process.platform === 'win32') return // os.homedir() 在 Windows 用 USERPROFILE；此用例面向 POSIX。
    const fakeHome = makeTempDir()
    const previousHome = process.env.HOME
    process.env.HOME = fakeHome
    delete process.env.AVENTURINE_BRIDGE_DIR

    try {
      // ① env 里的 `~/...` 展开
      process.env.AVENTURINE_BRIDGE_DIR = '~/env-bridge'
      const envCtx = makeFakeCtx()
      const disposeEnv = bridge.apply(envCtx)
      try {
        expect(existsSync(join(fakeHome, 'env-bridge', constants.BRIDGE_STATUS_FILE))).toBe(true)
      } finally {
        disposeEnv()
      }

      // ② config.dir 里的 `~/...` 展开，且优先级高于 env
      const configCtx = makeFakeCtx()
      const disposeConfig = bridge.apply(configCtx, { dir: '~/config-bridge' })
      try {
        expect(existsSync(join(fakeHome, 'config-bridge', constants.BRIDGE_STATUS_FILE))).toBe(true)
        expect(readStatus(join(fakeHome, 'config-bridge')).offline).toBe(false)
        expect(readStatus(join(fakeHome, 'env-bridge')).offline).toBe(true)
      } finally {
        disposeConfig()
      }

      // ③ 默认目录 join(homedir(), '.dsh', BRIDGE_DIR_NAME) 跟随 HOME 展开
      delete process.env.AVENTURINE_BRIDGE_DIR
      const defaultCtx = makeFakeCtx()
      const disposeDefault = bridge.apply(defaultCtx)
      try {
        const defaultDir = join(fakeHome, '.dsh', constants.BRIDGE_DIR_NAME)
        expect(existsSync(join(defaultDir, constants.BRIDGE_STATUS_FILE))).toBe(true)
      } finally {
        disposeDefault()
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      delete process.env.AVENTURINE_BRIDGE_DIR
    }
  })

  it('F8：桥目录创建为 0700、status.json / control.json / events.jsonl 创建为 0600', () => {
    const root = makeTempDir()
    const dir = join(root, 'nested', 'bridge')
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      expectPrivateMode(dir, 0o700)
      expectPrivateMode(statusPathOf(dir), 0o600)
      expectPrivateMode(controlPathOf(dir), 0o600)
      emitSessionEvent(
        ctx,
        'session-perm',
        durableEvent('assistant/message', 1, { turn: 1, step: 1 })
      )
      expectPrivateMode(eventsPathOf(dir), 0o600)
    } finally {
      dispose()
    }
    // 退出帧 rename 后仍是 0600（tmp 与正式文件同源）。
    expectPrivateMode(statusPathOf(dir), 0o600)
    expectPrivateMode(controlPathOf(dir), 0o600)
  })
})

describe('事件映射（真实 DSH 形状）', () => {
  it('F11+agent/status：优先 payload.status，回退 agent.status；running→task/start、idle→task/end、重复帧不重复记', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      // 真实 DSH 形状：payload = { status, agent }，agent 不需要暴露 status getter。
      ctx.emit('agent/status', agentStatusFrame('agent-1', 'running'))
      let events = readEvents(dir)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task/start')
      expect(events[0].payload).toEqual({ agent: 'agent-1', status: 'running' })
      expect(schema.isDshEvent(events[0])).toBe(true)

      let file = readStatus(dir)
      expect(file.running).toBe(true)
      expect(file.agents).toBe(1)
      expect(file.lastType).toBe('task/start')
      expect(file.lastEventAt).toBe(events[0].ts)

      // DSH 只在变化时 emit；重复帧最多刷新心跳，不重复写事件。
      ctx.emit('agent/status', agentStatusFrame('agent-1', 'running'))
      expect(readEvents(dir)).toHaveLength(1)

      ctx.emit('agent/status', agentStatusFrame('agent-1', 'idle'))
      events = readEvents(dir)
      expect(events.map((event) => event.type)).toEqual(['task/start', 'task/end'])
      expect(events[1].payload).toEqual({ agent: 'agent-1', status: 'idle' })

      file = readStatus(dir)
      expect(file.running).toBe(false)
      expect(file.agents).toBe(0)
      expect(file.lastType).toBe('task/end')

      // F11 优先级：payload.status 是契约字段，能压过 agent.status getter 的旧值。
      ctx.emit('agent/status', {
        status: 'running',
        agent: { id: 'agent-priority', status: 'idle' }
      })
      expect(readEvents(dir).at(-1)).toMatchObject({
        type: 'task/start',
        payload: { agent: 'agent-priority', status: 'running' }
      })
      ctx.emit('agent/status', {
        status: 'idle',
        agent: { id: 'agent-priority', status: 'running' }
      })
      expect(readEvents(dir).at(-1)).toMatchObject({
        type: 'task/end',
        payload: { agent: 'agent-priority', status: 'idle' }
      })

      // F11 回退：没有 top-level status 时仍兼容 agent.status。
      ctx.emit('agent/status', { agent: { id: 'agent-fallback', status: 'running' } })
      expect(readEvents(dir).at(-1)).toMatchObject({
        type: 'task/start',
        payload: { agent: 'agent-fallback', status: 'running' }
      })

      // 多 agent：running 计数只算 running（agent-fallback + agent-2）。
      ctx.emit('agent/status', agentStatusFrame('agent-2', 'running'))
      expect(readStatus(dir).agents).toBe(2)
    } finally {
      dispose()
    }
  })

  it('M-7：running agent 被 agent/disposed 时先写 task/end（reason:disposed）；idle agent 不写事件', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      ctx.emit('agent/status', agentStatusFrame('agent-disposed', 'running'))
      const eventsBefore = readEvents(dir).length
      expect(readStatus(dir).running).toBe(true)

      ctx.emit('agent/disposed', { agent: { id: 'agent-disposed' } })
      const events = readEvents(dir)
      expect(events).toHaveLength(eventsBefore + 1)
      expect(events.at(-1)).toMatchObject({
        type: 'task/end',
        payload: { agent: 'agent-disposed', reason: 'disposed' }
      })
      expect(readStatus(dir).running).toBe(false)
      expect(readStatus(dir).agents).toBe(0)

      // idle agent 被 dispose：只移除状态表，不产生终止事件（避免重复 task/end）。
      const idleEventsBefore = readEvents(dir).length
      ctx.emit('agent/created', { agent: { id: 'agent-idle' }, source: 'startup' })
      ctx.emit('agent/disposed', { agent: { id: 'agent-idle' } })
      expect(readEvents(dir)).toHaveLength(idleEventsBefore)
    } finally {
      dispose()
    }
  })

  it('H-3：agent/error（真实 agent-scoped 形状）→ task/error，message 截断且不含 error 对象', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      ctx.emit(
        'agent/error',
        agentErrorFrame(REAL_SESSION_ID, 1, 1, 'llm-deepseek: no API key for provider route')
      )
      const events = readEvents(dir)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task/error')
      expect(events[0].payload).toEqual({
        agent: REAL_SESSION_ID,
        turn: 1,
        step: 1,
        reasonKind: 'error',
        message: 'llm-deepseek: no API key for provider route'
      })
      // 不写整个 error 对象（隐私 + 行长）。
      expect(events[0].payload).not.toHaveProperty('error')

      // message 截断到 512 字符（长错误文本不会撑爆 64KB 上限）。
      ctx.emit('agent/error', agentErrorFrame('agent-long', 2, 1, 'x'.repeat(2000)))
      const longEvent = readEvents(dir).at(-1)
      expect(longEvent?.type).toBe('task/error')
      expect(typeof longEvent?.payload.message).toBe('string')
      expect((longEvent?.payload.message as string).length).toBe(512)
    } finally {
      dispose()
    }
  })

  it('H-3：turn/end reason.kind=error（无 agent/error 前置）→ 单条 task/error，不再透传 session/event', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      // 直接复刻真实失败 session 的最后一条 durable 事件（seq16；MISSING_CREDENTIAL）。
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 16, {
          turn: 1,
          reason: {
            kind: 'error',
            error: {
              message:
                'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service',
              code: 'MISSING_CREDENTIAL'
            }
          }
        })
      )

      const events = readEvents(dir)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task/error')
      expect(events[0].payload).toEqual({
        sessionId: REAL_SESSION_ID,
        eventType: 'turn/end',
        seq: 16,
        turn: 1,
        reasonKind: 'error'
      })
      // 不得把 data/error 正文带进 payload（隐私 + 64KB；只保留安全标量）。
      expect(events[0].payload).not.toHaveProperty('data')
      expect(events[0].payload).not.toHaveProperty('message')
    } finally {
      dispose()
    }
  })

  it('H-3 去重：先 agent/error 后同 turn 的 turn/end(reason=error) 只写一条 task/error；新 turn/新 session 正常再报', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      // DSH 真实顺序：turn 内出错先 emit agent/error，随后 append turn/end。
      ctx.emit('agent/error', agentErrorFrame(REAL_SESSION_ID, 1, 1, 'boom'))
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 16, { turn: 1, reason: { kind: 'error' } })
      )
      let errors = readEvents(dir).filter((event) => event.type === 'task/error')
      expect(errors).toHaveLength(1)
      expect(errors[0].payload.agent).toBe(REAL_SESSION_ID)

      // 同一 agent 的下一个 turn 出错：是新 turn，必须再报。
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 20, { turn: 2, reason: { kind: 'error' } })
      )
      errors = readEvents(dir).filter((event) => event.type === 'task/error')
      expect(errors).toHaveLength(2)
      expect(errors[1].payload).toMatchObject({ turn: 2, reasonKind: 'error' })

      // 不同 session 的同一 turn 是独立错误，各自一条。
      emitSessionEvent(
        ctx,
        'session-other',
        durableEvent('turn/end', 5, { turn: 1, reason: { kind: 'error' } })
      )
      expect(readEvents(dir).filter((event) => event.type === 'task/error')).toHaveLength(3)
    } finally {
      dispose()
    }
  })

  it('turn/end 正常结束（completed/aborted）仍透传 session/event，并带 turn/reasonKind 安全标量', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 16, { turn: 1, reason: { kind: 'completed' } })
      )
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 20, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
      )

      const events = readEvents(dir)
      expect(events.map((event) => event.type)).toEqual(['session/event', 'session/event'])
      expect(events[0].payload).toEqual({
        sessionId: REAL_SESSION_ID,
        eventType: 'turn/end',
        seq: 16,
        turn: 1,
        reasonKind: 'completed'
      })
      expect(events[1].payload).toMatchObject({
        eventType: 'turn/end',
        seq: 20,
        turn: 2,
        reasonKind: 'aborted'
      })
      expect(readEvents(dir).some((event) => event.type === 'task/error')).toBe(false)
    } finally {
      dispose()
    }
  })

  it('F5（v2）：assistant/message 允许 payload.text（仅 assistant 输出）；tool/result 仍只带安全标量；user/reasoning/tool 正文不得出现', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        assistantMessageEvent(
          9,
          [
            REASONING_BLOCK('reasoning-body-sentinel: 思考正文不该落盘'),
            TEXT_BLOCK('这条 assistant 输出可以展示'),
            TOOL_CALL_BLOCK
          ],
          { turn: 1, step: 2 }
        )
      )
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('tool/result', 10, {
          turn: 1,
          step: 2,
          toolCallId: 'call-1',
          result: { content: '工具输出正文' }
        })
      )
      // user/message 事件桥直接忽略（隐私白名单：不写 user 输入）。
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('user/message', 11, {
          turn: 1,
          step: 2,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'user-input-sentinel: 用户输入不该落盘' }]
          }
        })
      )

      const events = readEvents(dir)
      expect(events.map((event) => event.type)).toEqual(['session/event', 'session/event'])
      expect(events[0].payload).toEqual({
        sessionId: REAL_SESSION_ID,
        eventType: 'assistant/message',
        seq: 9,
        turn: 1,
        step: 2,
        text: '这条 assistant 输出可以展示'
      })
      expect(events[1].payload).toEqual({
        sessionId: REAL_SESSION_ID,
        eventType: 'tool/result',
        seq: 10,
        turn: 1,
        step: 2
      })
      // assistant/message 允许 text；其余 payload 仍只允许安全标量键。
      const allowedKeys = [
        'sessionId',
        'eventType',
        'seq',
        'turn',
        'step',
        'reasonKind',
        'text'
      ]
      for (const event of events) {
        for (const key of Object.keys(event.payload)) {
          expect(allowedKeys).toContain(key)
        }
      }
      // 隐私：user 输入 / reasoning 正文 / tool 正文（arguments、result）都没有写进桥文件。
      const raw = readFileSync(eventsPathOf(dir), 'utf8')
      for (const forbidden of [
        'user-input-sentinel',
        'reasoning-body-sentinel',
        'tool-arguments-sentinel',
        '工具输出正文'
      ]) {
        expect(raw).not.toContain(forbidden)
      }
    } finally {
      dispose()
    }
  })

  it('F5（v2）：超长 assistant 文本按 8000 字符截断（单行仍远低于 64KB）；turn/end error 正文仍不写', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      // 70KB 正文：v2 只写前 8000 字符 → 序列化行远小于 64KB 上限。
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        assistantMessageEvent(11, [TEXT_BLOCK('y'.repeat(70 * 1024))], { turn: 3, step: 1 })
      )
      expect(readEvents(dir)).toHaveLength(1)
      const event = readEvents(dir)[0]
      expect(event.payload.eventType).toBe('assistant/message')
      expect(typeof event.payload.text).toBe('string')
      expect((event.payload.text as string).length).toBe(constants.DSH_EVENT_TEXT_MAX_CHARS)
      expect(event.payload.text).toBe('y'.repeat(constants.DSH_EVENT_TEXT_MAX_CHARS))

      const line = readFileSync(eventsPathOf(dir), 'utf8').trim()
      expect(schema.utf8ByteLength(line)).toBeLessThan(constants.BRIDGE_MAX_LINE_BYTES)
      expect(schema.utf8ByteLength(line)).toBeGreaterThan(constants.DSH_EVENT_TEXT_MAX_CHARS)
      // 行能被读取侧契约解析（text 双保险截断后仍是合法 text）。
      expect(schema.parseDshEventLine(line)).not.toBeNull()

      // turn/end error 的 data.error.message 同样被丢弃（只保留 reasonKind/turn）。
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 12, {
          turn: 3,
          reason: { kind: 'error', error: { message: 'z'.repeat(70 * 1024), code: 'X' } }
        })
      )
      const errorEvent = readEvents(dir).at(-1)
      expect(errorEvent?.type).toBe('task/error')
      expect(errorEvent?.payload).toEqual({
        sessionId: REAL_SESSION_ID,
        eventType: 'turn/end',
        seq: 12,
        turn: 3,
        reasonKind: 'error'
      })
    } finally {
      dispose()
    }
  })

  it('高频非 durable 事件（step/start、step/end、assistant/delta 等）被忽略，不刷盘', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      for (const [type, seq, data] of [
        ['turn/start', 4, { turn: 1 }],
        ['step/start', 6, { turn: 1, step: 1 }],
        ['assistant/attempt', 14, { turn: 1, step: 1, stream: [] }],
        ['assistant/delta', 15, { turn: 1, step: 1, delta: 'token' }],
        ['step/end', 15, { turn: 1, step: 1 }]
      ] as const) {
        emitSessionEvent(ctx, REAL_SESSION_ID, durableEvent(type, seq, data))
      }
      expect(existsSync(eventsPathOf(dir))).toBe(false)
      expect(readStatus(dir).lastType).toBeNull()
    } finally {
      dispose()
    }
  })

  it('真实失败 session（session-a1c00648）复放：headless turn/end(reason.kind=error) → task/error（不再误报 task/end）', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      // 真实 headless 会话（缺 API key）的 17 条 durable 事件里与桥映射相关的子序列，
      // 顺序与 session-a1c00648-frames.jsonl 一致（seq 见注释）。
      ctx.emit('agent/status', agentStatusFrame(REAL_SESSION_ID, 'running')) // 先于 turn 边界 emit
      const durableSubset: Array<Record<string, unknown>> = [
        durableEvent('turn/start', 4, { turn: 1 }),
        durableEvent('step/start', 6, { turn: 1, step: 1 }),
        durableEvent('assistant/attempt', 14, {
          turn: 1,
          step: 1,
          stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } }]
        }),
        durableEvent('step/end', 15, { turn: 1, step: 1 }),
        durableEvent('turn/end', 16, {
          turn: 1,
          reason: {
            kind: 'error',
            error: {
              message:
                'llm-deepseek: no API key for provider route "deepseek-official"',
              code: 'MISSING_CREDENTIAL'
            }
          }
        })
      ]
      for (const event of durableSubset) emitSessionEvent(ctx, REAL_SESSION_ID, event)
      ctx.emit('agent/status', agentStatusFrame(REAL_SESSION_ID, 'idle'))

      const events = readEvents(dir)
      expect(events.map((event) => event.type)).toEqual(['task/start', 'task/error', 'task/end'])
      // 真实证据：失败任务必须产生 task/error，而不是被当成完成。
      const error = events[1]
      expect(error.payload).toEqual({
        sessionId: REAL_SESSION_ID,
        eventType: 'turn/end',
        seq: 16,
        turn: 1,
        reasonKind: 'error'
      })
      expect(events.some((event) => event.type === 'session/event')).toBe(false)
    } finally {
      dispose()
    }
  })

  it('脏事件结构不抛异常、不写坏行；status.json 始终合法', () => {
    const dir = makeTempDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      expect(() => {
        ctx.emit('agent/status')
        ctx.emit('agent/status', null)
        ctx.emit('agent/status', { agent: 'not-an-object', status: 'running' })
        ctx.emit('agent/status', { agent: { id: 'agent-x', status: 'sleeping' } })
        ctx.emit('agent/created', null)
        ctx.emit('agent/created', {})
        ctx.emit('agent/error')
        ctx.emit('agent/error', null)
        ctx.emit('agent/disposed', { agent: {} })
        ctx.emit('agent/disposed', null)
        ctx.emit('session/event')
        ctx.emit('session/event', {}, null)
        ctx.emit('session/event', {}, { type: 42 })
        ctx.emit('session/event', {}, { type: '' })
        ctx.emit('session/event', {}, { type: 'turn/end' })
        ctx.emit('session/event', {}, { type: 'turn/end', data: null })
        ctx.emit('session/event', {}, { type: 'turn/end', data: { turn: 1 } })
        ctx.emit('session/event', {}, {
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 42 } }
        })
        ctx.emit('session/event', {}, {
          type: 'turn/end',
          data: { turn: 1, reason: null }
        })
      }).not.toThrow()

      // 没有任何合法事件被写坏：所有已写行都能被契约解析函数接受（readEvents 内断言）。
      const events = readEvents(dir)
      expect(events.every((event) => schema.isDshEvent(event))).toBe(true)
      expect(readStatus(dir).offline).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})

describe('v2：assistant/message 文本提取（气泡同步契约）', () => {
  it('多个 text 块按 \\n join、trim；reasoning/tool-call 块不进入 text', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        assistantMessageEvent(1, [
          REASONING_BLOCK('先想一下：这段不该进 text'),
          TEXT_BLOCK('第一段'),
          TOOL_CALL_BLOCK,
          TEXT_BLOCK('第二段')
        ])
      )
      const event = readEvents(dir).at(-1)
      expect(event?.payload).toMatchObject({
        eventType: 'assistant/message',
        text: '第一段\n第二段'
      })
      // 保留 JSON 可读文本；reasoning/tool 正文没有混入。
      expect(JSON.stringify(event?.payload)).not.toContain('先想一下')
      expect(JSON.stringify(event?.payload)).not.toContain('tool-arguments-sentinel')
    } finally {
      dispose()
    }
  })

  it('首尾空白被 trim；只有空白/空串的 text 块不写 text', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        assistantMessageEvent(1, [TEXT_BLOCK('  前后有空白  ')])
      )
      expect(readEvents(dir).at(-1)?.payload.text).toBe('前后有空白')

      emitSessionEvent(ctx, REAL_SESSION_ID, assistantMessageEvent(2, [TEXT_BLOCK('   ')]))
      const whitespaceOnly = readEvents(dir).at(-1)
      expect(whitespaceOnly?.payload).not.toHaveProperty('text')
      expect(whitespaceOnly?.payload.eventType).toBe('assistant/message')

      emitSessionEvent(ctx, REAL_SESSION_ID, assistantMessageEvent(3, [TEXT_BLOCK(''), TEXT_BLOCK('')]))
      expect(readEvents(dir).at(-1)?.payload).not.toHaveProperty('text')
    } finally {
      dispose()
    }
  })

  it('纯 tool-call / 纯 reasoning / 空 content：不写 text，但 assistant/message 事件仍写（桌宠可识别「只有工具调用」）', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(ctx, REAL_SESSION_ID, assistantMessageEvent(1, [REASONING_BLOCK('思考')]))
      emitSessionEvent(ctx, REAL_SESSION_ID, assistantMessageEvent(2, [TOOL_CALL_BLOCK]))
      emitSessionEvent(ctx, REAL_SESSION_ID, assistantMessageEvent(3, []))

      const events = readEvents(dir)
      expect(events).toHaveLength(3)
      for (const event of events) {
        expect(event.type).toBe('session/event')
        expect(event.payload.eventType).toBe('assistant/message')
        expect(event.payload).not.toHaveProperty('text')
      }
    } finally {
      dispose()
    }
  })

  it('异常 content 防御：非数组 / 脏块 / 缺失 message / getter 抛错都不抛、不写 text，事件仍写安全标量', () => {
    const dir = makeTempDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      const cases: Array<Record<string, unknown>> = [
        // content 非数组
        durableEvent('assistant/message', 1, {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: 'not-an-array' }
        }),
        // content 数组内含 null/数字/缺字段/类型错误的块
        assistantMessageEvent(2, [
          null,
          42,
          { type: 'text' },
          { type: 'text', text: 42 },
          { type: 123, text: 'wrong-type-sentinel' },
          'not-an-object'
        ]),
        // 缺 message / data
        durableEvent('assistant/message', 3, { turn: 1, step: 1 }),
        // message.content getter 抛错
        durableEvent('assistant/message', 4, {
          turn: 1,
          step: 1,
          get message(): unknown {
            throw new Error('message getter boom')
          }
        }),
        // content[i].type getter 抛错
        durableEvent('assistant/message', 5, {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              {
                get type(): string {
                  throw new Error('block getter boom')
                },
                text: 'never'
              }
            ]
          }
        })
      ]
      expect(() => {
        for (const event of cases) emitSessionEvent(ctx, REAL_SESSION_ID, event)
      }).not.toThrow()

      const events = readEvents(dir)
      expect(events).toHaveLength(cases.length)
      for (const event of events) {
        expect(event.payload).not.toHaveProperty('text')
        expect(event.payload).toMatchObject({ eventType: 'assistant/message' })
      }
      // 防御走「降级不写 text」，不是异常路径：这些脏输入不需要 warn（避免刷屏）。
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('未知内容块类型宽容跳过；只有 assistant/message 写 text，tool/result 与 turn/end 不写', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        assistantMessageEvent(1, [
          { type: 'image', source: 'ignored-sentinel' },
          TEXT_BLOCK('保留文本')
        ])
      )
      // tool/result 消息体同形状：即使 message.content 有 text 也不得写 text。
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('tool/result', 2, {
          turn: 1,
          step: 1,
          message: { role: 'tool', content: [TEXT_BLOCK('工具结果文本')] }
        })
      )
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        durableEvent('turn/end', 3, { turn: 1, reason: { kind: 'completed' } })
      )

      const events = readEvents(dir)
      expect(events.map((event) => event.payload.eventType)).toEqual([
        'assistant/message',
        'tool/result',
        'turn/end'
      ])
      expect(events[0].payload.text).toBe('保留文本')
      expect(events[1].payload).not.toHaveProperty('text')
      expect(events[2].payload).not.toHaveProperty('text')
      expect(readFileSync(eventsPathOf(dir), 'utf8')).not.toContain('工具结果文本')
      expect(readFileSync(eventsPathOf(dir), 'utf8')).not.toContain('ignored-sentinel')
    } finally {
      dispose()
    }
  })

  it('多块合计超长按 8000 字符截断（slice 保守，不会写出 >8000）', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      emitSessionEvent(
        ctx,
        REAL_SESSION_ID,
        assistantMessageEvent(1, [
          TEXT_BLOCK('a'.repeat(5000)),
          TEXT_BLOCK('b'.repeat(5000))
        ])
      )
      const text = readEvents(dir).at(-1)?.payload.text as string
      expect(typeof text).toBe('string')
      expect(text.length).toBe(constants.DSH_EVENT_TEXT_MAX_CHARS)
      // 两个 text 块先按 '\n' join（共 10001 字符）再截断到 8000：
      // 5000 个 a + '\n' + 2999 个 b。
      expect(text.slice(0, 5000)).toBe('a'.repeat(5000))
      expect(text.slice(5000)).toBe(`\n${'b'.repeat(2999)}`)
    } finally {
      dispose()
    }
  })
})

describe('v2：control.json 生命周期（attached / detached）', () => {
  it('control.json 是原子覆盖写：无 tmp 残留，帧合法，心跳不重写 control（只有状态切换写盘）', () => {
    const dir = makeTempDir()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-03T04:05:06.000Z'))
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      expect(readControl(dir).action).toBe('attached')
      expect(controlTmpFiles(dir)).toEqual([])
      const attachedRaw = readFileSync(controlPathOf(dir), 'utf8')
      const attachedTs = readControl(dir).ts

      // 心跳只写 status.json；control 不应被重写（减少写盘，也是设计 §6 的明确要求）。
      vi.advanceTimersByTime(constants.BRIDGE_HEARTBEAT_MS * 3)
      expect(readStatus(dir).ts).toBeGreaterThan(attachedTs)
      expect(readFileSync(controlPathOf(dir), 'utf8')).toBe(attachedRaw)

      dispose()
      const detached = readControl(dir)
      expect(detached.action).toBe('detached')
      expect(detached.ts).toBeGreaterThanOrEqual(attachedTs)
      expect(controlTmpFiles(dir)).toEqual([])
    } finally {
      dispose()
      vi.useRealTimers()
    }
  })

  it('上一次运行残留的 detached 帧会被下一次 apply 覆盖成 attached（HMR/重启语义）', () => {
    const dir = makeTempDir()
    const ctxA = makeFakeCtx()
    const disposeA = bridge.apply(ctxA, { dir })
    disposeA()
    expect(readControl(dir).action).toBe('detached')

    const ctxB = makeFakeCtx()
    const disposeB = bridge.apply(ctxB, { dir })
    try {
      expect(readControl(dir).action).toBe('attached')
      expect(controlTmpFiles(dir)).toEqual([])
    } finally {
      disposeB()
    }
    expect(readControl(dir).action).toBe('detached')
  })

  it('同进程多实例同目录：control 临时文件名唯一、无残留（last-writer-wins 为已知限制）', () => {
    const dir = makeTempDir()
    const ctxA = makeFakeCtx()
    const ctxB = makeFakeCtx()
    const disposeA = bridge.apply(ctxA, { dir })
    const disposeB = bridge.apply(ctxB, { dir })

    try {
      expect(readControl(dir).action).toBe('attached')
      expect(controlTmpFiles(dir)).toEqual([])
    } finally {
      disposeA()
      disposeB()
    }
    expect(readControl(dir).action).toBe('detached')
    expect(controlTmpFiles(dir)).toEqual([])
  })
})

/* ---------------------- v4：compat 运行时自述（control/status 每帧） ---------------------- */

describe('v4：compat 运行时自述（control/status 每帧）', () => {
  it('apply 后 control/status 均带 compat（bridgeVersion=4 / controlSchema=1 / dshRange 来自 package.json）', () => {
    const dir = makeTempDir()
    const dispose = bridge.apply(makeFakeCtx(), { dir })
    try {
      // readControl 内部用 isDshBridgeControlFile 校验：compat 形状非法会让整帧无效。
      const control = readControl(dir)
      expect(control.bridgeVersion).toBe(4)
      expect(control.compat).toEqual(EXPECTED_COMPAT)
      // 共享契约解析器视角同样成立（桌宠侧兼容判定消费的正是这个形状）。
      expect(schema.parseDshBridgeCompat(control.compat)).toEqual(EXPECTED_COMPAT)

      const status = readStatus(dir)
      expect(status.compat).toEqual(EXPECTED_COMPAT)
      expect(schema.parseDshBridgeCompat(status.compat)).toEqual(EXPECTED_COMPAT)
      expect(schema.toDshStatus(status, Date.now()).online).toBe(true)
    } finally {
      dispose()
    }
  })

  it('每一帧都带 compat：启动帧 / 心跳帧 / 离线帧 / attached+detached 控制帧', () => {
    const dir = makeTempDir()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T06:04:44.000Z'))
    const dispose = bridge.apply(makeFakeCtx(), { dir })
    try {
      expect(readStatus(dir).compat).toEqual(EXPECTED_COMPAT) // 启动帧
      for (const tick of [1, 2, 3]) {
        vi.advanceTimersByTime(constants.BRIDGE_HEARTBEAT_MS)
        expect(readStatus(dir).compat, `heartbeat #${tick}`).toEqual(EXPECTED_COMPAT)
      }
      const attached = readControl(dir)
      expect(attached.action).toBe('attached')
      expect(attached.compat).toEqual(EXPECTED_COMPAT)

      dispose()
      // 离线帧（disposer 写的最后一帧）同样带 compat：桌宠在 DSH 退出后仍能读到桥的自述。
      const offline = readStatus(dir)
      expect(offline.offline).toBe(true)
      expect(offline.compat).toEqual(EXPECTED_COMPAT)
      expect(schema.isDshBridgeStatusFile(offline)).toBe(true)
      const detached = readControl(dir)
      expect(detached.action).toBe('detached')
      expect(detached.compat).toEqual(EXPECTED_COMPAT)
    } finally {
      dispose()
      vi.useRealTimers()
    }
  })

  it('多个 apply 实例的 compat 一致（同源 manifest，不含进程相关字段）', () => {
    const dirA = makeTempDir()
    const dirB = makeTempDir()
    const disposeA = bridge.apply(makeFakeCtx(), { dir: dirA })
    const disposeB = bridge.apply(makeFakeCtx(), { dir: dirB })
    try {
      expect(readControl(dirA).compat).toEqual(readControl(dirB).compat)
      expect(readStatus(dirA).compat).toEqual(readStatus(dirB).compat)
    } finally {
      disposeA()
      disposeB()
    }
  })
})

/* ---------------------- v4：dshRange 来源（相邻 package.json.engines.dsh） ---------------------- */

describe('v4：dshRange 来源（相邻 package.json.engines.dsh，live 副本/正规 bundle 同源）', () => {
  it('engines.dsh 被改写后，新加载的桥 compat.dshRange 跟着变（证明运行时读 manifest 而非抄常量）', async () => {
    const pkgDir = copyBridgePackageToTemp((manifest) => {
      manifest['engines'] = { dsh: '>=9.0.0 <10.0.0' }
    })
    const copied = await importCopiedBridge(pkgDir)
    const dir = makeTempDir()
    const dispose = copied.apply(makeFakeCtx(), { dir })
    try {
      const expected = { bridgeVersion: 4, controlSchema: 1, dshRange: '>=9.0.0 <10.0.0' }
      expect(readControl(dir).compat).toEqual(expected)
      expect(readStatus(dir).compat).toEqual(expected)
      expect(schema.parseDshBridgeCompat(readControl(dir).compat)).toEqual(expected)
    } finally {
      dispose()
    }
    // live 副本按 rev 不可变，manifest 读取结果被缓存：同一模块实例再 apply 仍是旧范围
    // （避免每 5s 心跳反复 IO；也保证同一 DSH 会话内 compat 自述稳定）。
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'dsh-aventurine-bridge', type: 'module', engines: { dsh: '>=8.0.0' } })
    )
    const dirAgain = makeTempDir()
    const disposeAgain = copied.apply(makeFakeCtx(), { dir: dirAgain })
    try {
      expect(readControl(dirAgain).compat?.dshRange).toBe('>=9.0.0 <10.0.0')
    } finally {
      disposeAgain()
    }
  })

  it('engines.dsh 缺失 → dshRange=null（不猜兼容、不抛，帧结构仍合法）', async () => {
    const pkgDir = copyBridgePackageToTemp((manifest) => {
      manifest['engines'] = {}
    })
    const copied = await importCopiedBridge(pkgDir)
    const dir = makeTempDir()
    const dispose = copied.apply(makeFakeCtx(), { dir })
    try {
      const expected = { bridgeVersion: 4, controlSchema: 1, dshRange: null }
      expect(readControl(dir).compat).toEqual(expected)
      expect(readStatus(dir).compat).toEqual(expected)
      // v4 null 范围是「可解析的声明为 null」，由桌宠判 range-missing，而不是桥崩溃/失败。
      expect(schema.parseDshBridgeCompat(readControl(dir).compat)).toEqual(expected)
    } finally {
      dispose()
    }
  })

  it('package.json 损坏/读不到 → dshRange=null，apply 照常成功（绝不因 manifest 不可读而失败）', async () => {
    const pkgDir = copyBridgePackageToTemp()
    // 先 import（Vite 解析模块时需要合法 package.json），再损坏它：readDeclaredDshRange 是
    // apply 时才惰性读 manifest 的，正好覆盖"运行时 manifest 损坏"的真实分支。
    const copied = await importCopiedBridge(pkgDir)
    writeFileSync(join(pkgDir, 'package.json'), '{ not valid json')
    const dir = makeTempDir()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dispose = copied.apply(makeFakeCtx(), { dir })
    try {
      expect(readControl(dir).compat).toEqual({
        bridgeVersion: 4,
        controlSchema: 1,
        dshRange: null
      })
      expect(readStatus(dir).compat?.dshRange).toBeNull()
      // 桥仍正常运行（有 status/control），且不会误写 apply 失败诊断。
      expect(existsSync(diagnosticPathOf(dir))).toBe(false)
    } finally {
      dispose()
    }
  })
})

/* ---------------------- v4：apply 失败隔离 + bridge-error.json 诊断 ---------------------- */

describe('v4：apply 失败隔离（绝不 throw 到宿主）+ bridge-error.json', () => {
  it('投毒 ctx（on getter 抛错）→ apply 不抛、返回函数 disposer、写诊断、零桥产物', () => {
    const dir = makeTempDir()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 投毒 ctx：读取 ctx.on 时抛错（模拟损坏/异常的宿主上下文）。
    const poisonedCtx = {
      get on(): never {
        throw new Error('poisoned-ctx')
      }
    } as unknown as FakeContext

    let dispose: () => void = () => {}
    expect(() => {
      dispose = bridge.apply(poisonedCtx, { dir })
    }).not.toThrow()
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()

    const diagnostic = readDiagnostic(dir)
    expect(diagnostic.schemaVersion).toBe(constants.BRIDGE_INSTALL_SCHEMA_VERSION)
    expect(diagnostic.phase).toBe('apply')
    expect(diagnostic.message).toContain('poisoned-ctx')
    expect(diagnostic.bridgeVersion).toBe(constants.BRIDGE_PLUGIN_VERSION)
    expect(diagnostic.dshRange).toBe(DECLARED_DSH_RANGE)
    // 启动失败发生在写帧之前：不产生 status/control（桌宠会按「桥没加载」+ 诊断解释）。
    expect(existsSync(statusPathOf(dir))).toBe(false)
    expect(existsSync(controlPathOf(dir))).toBe(false)
    expect(statusTmpFiles(dir)).toEqual([])
    expect(controlTmpFiles(dir)).toEqual([])
    expect(diagnosticTmpFiles(dir)).toEqual([])
  })

  it('deps 注入 getter 抛错（单测注入点）也走同一失败隔离路径', () => {
    const dir = makeTempDir()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const poisonedDeps = {
      get spawn(): never {
        throw new Error('poisoned-deps')
      }
    }
    let dispose: () => void = () => {}
    expect(() => {
      dispose = bridge.apply(makeFakeCtx(), { dir }, poisonedDeps as never)
    }).not.toThrow()
    expect(typeof dispose).toBe('function')
    expect(readDiagnostic(dir).message).toContain('poisoned-deps')
    expect(existsSync(statusPathOf(dir))).toBe(false)
    expect(existsSync(controlPathOf(dir))).toBe(false)
  })

  it('ctx.on 调用抛错（非 getter）→ 桥降级继续：控制/心跳帧照常写，不误判 apply 失败', () => {
    const dir = makeTempDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = {
      on(): never {
        throw new Error('on-call-boom')
      }
    } as unknown as FakeContext
    const dispose = bridge.apply(ctx, { dir })
    try {
      expect(readControl(dir).action).toBe('attached')
      expect(readStatus(dir).compat).toEqual(EXPECTED_COMPAT)
      expect(existsSync(diagnosticPathOf(dir))).toBe(false)
      expect(warnSpy).toHaveBeenCalled() // 每次订阅失败都只 warn
    } finally {
      dispose()
    }
  })

  it('桥目录不可写（chmod 0555）→ apply 失败隔离，诊断回退到 AVENTURINE_BRIDGE_DIR；目录零残留', () => {
    if (process.platform === 'win32') return // chmod 权限位语义仅在 POSIX 可靠。
    const root = makeTempDir()
    const unwritable = join(root, 'locked-bridge')
    mkdirSync(unwritable)
    chmodSync(unwritable, 0o555)
    const fallbackDir = makeTempDir()
    const previous = process.env.AVENTURINE_BRIDGE_DIR
    process.env.AVENTURINE_BRIDGE_DIR = fallbackDir
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let dispose: () => void = () => {}
      expect(() => {
        dispose = bridge.apply(makeFakeCtx(), { dir: unwritable })
      }).not.toThrow()
      expect(typeof dispose).toBe('function')
      expect(() => dispose()).not.toThrow()

      // 主目录不可写 → 诊断回退到 env 目录（T2 canary C6 的落点规则）。
      const diagnostic = readDiagnostic(fallbackDir)
      expect(diagnostic.phase).toBe('apply')
      expect(diagnostic.message).toContain('bridge dir not writable')
      expect(diagnostic.bridgeVersion).toBe(4)
      expect(diagnostic.dshRange).toBe(DECLARED_DSH_RANGE)
      // 不可写目录零产物（status/control/诊断/探针都没有）。
      expect(readdirSync(unwritable)).toEqual([])
    } finally {
      chmodSync(unwritable, 0o755)
      if (previous === undefined) delete process.env.AVENTURINE_BRIDGE_DIR
      else process.env.AVENTURINE_BRIDGE_DIR = previous
    }
  })

  it('dir 被文件占用（跨平台构造）→ 同样失败隔离，诊断回退到 AVENTURINE_BRIDGE_DIR', () => {
    const root = makeTempDir()
    const occupied = join(root, 'bridge-dir-is-a-file')
    writeFileSync(occupied, 'occupied')
    const fallbackDir = makeTempDir()
    const previous = process.env.AVENTURINE_BRIDGE_DIR
    process.env.AVENTURINE_BRIDGE_DIR = fallbackDir
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let dispose: () => void = () => {}
      expect(() => {
        dispose = bridge.apply(makeFakeCtx(), { dir: occupied })
      }).not.toThrow()
      expect(typeof dispose).toBe('function')
      const diagnostic = readDiagnostic(fallbackDir)
      expect(diagnostic.phase).toBe('apply')
      expect(diagnostic.message).toContain('bridge dir unavailable')
      expect(existsSync(join(occupied, constants.BRIDGE_STATUS_FILE))).toBe(false)
      expect(existsSync(join(occupied, constants.BRIDGE_CONTROL_FILE))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.AVENTURINE_BRIDGE_DIR
      else process.env.AVENTURINE_BRIDGE_DIR = previous
    }
  })

  it('所有候选目录都不可写 → 只 warn 不二次抛（apply 仍返回 no-op disposer）', () => {
    const root = makeTempDir()
    const occupied = join(root, 'no-where')
    writeFileSync(occupied, 'x')
    const previous = process.env.AVENTURINE_BRIDGE_DIR
    // 回退候选也落在文件路径下 → 同样不可写。
    process.env.AVENTURINE_BRIDGE_DIR = join(occupied, 'nested')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let dispose: () => void = () => {}
      expect(() => {
        dispose = bridge.apply(makeFakeCtx(), { dir: occupied })
      }).not.toThrow()
      expect(typeof dispose).toBe('function')
      expect(warnSpy).toHaveBeenCalled()
      expect(existsSync(join(occupied, 'nested'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.AVENTURINE_BRIDGE_DIR
      else process.env.AVENTURINE_BRIDGE_DIR = previous
    }
  })

  it('apply 成功时 best-effort 清理旧 bridge-error.json（恢复后不留假诊断）', () => {
    const dir = makeTempDir()
    writeFileSync(
      diagnosticPathOf(dir),
      JSON.stringify({ schemaVersion: 1, ts: 1, phase: 'apply', message: 'stale-failure' })
    )
    expect(existsSync(diagnosticPathOf(dir))).toBe(true)
    const dispose = bridge.apply(makeFakeCtx(), { dir })
    try {
      expect(existsSync(diagnosticPathOf(dir))).toBe(false)
    } finally {
      dispose()
    }
    // dispose 不应写回诊断（只有 apply 失败才写）。
    expect(existsSync(diagnosticPathOf(dir))).toBe(false)
  })

  it('失败会覆盖旧诊断（不残留上一次的 phase/message），且无 tmp 残留', () => {
    const dir = makeTempDir()
    writeFileSync(
      diagnosticPathOf(dir),
      JSON.stringify({ schemaVersion: 1, ts: 1, phase: 'stale', message: 'stale' })
    )
    const poisonedCtx = {
      get on(): never {
        throw new Error('fresh-failure')
      }
    } as unknown as FakeContext
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let dispose: () => void = () => {}
    expect(() => {
      dispose = bridge.apply(poisonedCtx, { dir })
    }).not.toThrow()
    const diagnostic = readDiagnostic(dir)
    expect(diagnostic.phase).toBe('apply')
    expect(diagnostic.message).toContain('fresh-failure')
    expect(diagnosticTmpFiles(dir)).toEqual([])
  })
})

/* ---------------------- v4：防异步孤儿抛错（§4.1/E10） ---------------------- */

describe('v4：防异步孤儿抛错（毒化 handler / 无未捕获异常）', () => {
  it('事件 handler 遇到毒化 payload 只 warn 不抛，后续心跳/事件仍正常', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dispose = bridge.apply(ctx, { dir })
    try {
      // 每种事件都用「访问任意属性即抛错」的 payload 打一遍：handler 内部必须自己 try/catch。
      const poisonPayload = (): Record<string, unknown> =>
        new Proxy(
          {},
          {
            get(): never {
              throw new Error('poisoned-payload')
            }
          }
        ) as unknown as Record<string, unknown>
      expect(() => {
        ctx.emit('agent/status', poisonPayload())
        ctx.emit('agent/created', poisonPayload())
        ctx.emit('agent/error', poisonPayload())
        ctx.emit('agent/disposed', poisonPayload())
        ctx.emit('session/event', { id: 'session-poison' }, poisonPayload())
      }).not.toThrow()
      expect(warnSpy).toHaveBeenCalled()

      // 心跳/状态文件仍然合法。
      const status = readStatus(dir)
      expect(status.compat).toEqual(EXPECTED_COMPAT)
      expect(schema.toDshStatus(status, Date.now()).online).toBe(true)
      // 毒化 handler 没有破坏事件流：后续正常事件仍能写入。
      ctx.emit('agent/status', agentStatusFrame('agent-after-poison', 'running'))
      expect(readStatus(dir).running).toBe(true)
      expect(readEvents(dir).map((event) => event.type)).toEqual(['task/start'])
    } finally {
      dispose()
    }
  })

  it('毒化场景驱动（投毒 ctx / 不可写目录 / handler 毒化 / spawn 异步失败）无 unhandledRejection / uncaughtException', async () => {
    const rejections: unknown[] = []
    const exceptions: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    const onException = (error: unknown): void => {
      exceptions.push(error)
    }
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const disposers: Array<() => void> = []
    try {
      // ① 投毒 ctx：apply 失败隔离（内部 catch，不抛到调用方）。
      const dirPoisoned = makeTempDir()
      const poisonedCtx = {
        get on(): never {
          throw new Error('poison-ctx')
        }
      } as unknown as FakeContext
      expect(() => {
        disposers.push(bridge.apply(poisonedCtx, { dir: dirPoisoned }))
      }).not.toThrow()

      // ② ctx.on 调用抛错：降级继续。
      const dirThrowingOn = makeTempDir()
      const throwingOnCtx = {
        on(): never {
          throw new Error('on-boom')
        }
      } as unknown as FakeContext
      expect(() => {
        disposers.push(bridge.apply(throwingOnCtx, { dir: dirThrowingOn }))
      }).not.toThrow()

      // ③ 不可写目录（dir 是文件）。
      const occupied = join(makeTempDir(), 'occupied')
      writeFileSync(occupied, 'x')
      expect(() => {
        disposers.push(bridge.apply(makeFakeCtx(), { dir: occupied }))
      }).not.toThrow()

      // ④ handler 毒化 payload（同步路径）。
      const dirHandler = makeTempDir()
      const ctx = makeFakeCtx()
      disposers.push(bridge.apply(ctx, { dir: dirHandler }))
      expect(() => {
        ctx.emit(
          'agent/status',
          new Proxy(
            {},
            {
              get(): never {
                throw new Error('poison-agent')
              }
            }
          )
        )
        ctx.emit(
          'session/event',
          { id: 's' },
          new Proxy(
            {},
            {
              get(): never {
                throw new Error('poison-event')
              }
            }
          )
        )
      }).not.toThrow()

      // ⑤ spawn 异步 'error'（launchPet 必须消费，否则 Node 会升级成未捕获异常）。
      const fake = makeFakeSpawn({ failWith: new Error('spawn-async-error') })
      const dirLaunch = makeTempDir()
      disposers.push(
        bridge.apply(
          makeFakeCtx(),
          { dir: dirLaunch, launchPet: true, petBundleId: 'com.aventurine.pet' },
          { spawn: fake.spawn, env: {} }
        )
      )

      for (const dispose of disposers.splice(0).reverse()) {
        expect(() => dispose()).not.toThrow()
      }
      // 给异步 'error' 与 microtask 机会落地（若有孤儿抛错会在这里触发监听器）。
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(rejections).toEqual([])
      expect(exceptions).toEqual([])
      // 所有毒化场景后落盘的状态帧仍合法（没有写出半截/坏 JSON）。
      expect(
        schema.isDshBridgeStatusFile(JSON.parse(readFileSync(statusPathOf(dirHandler), 'utf8')))
      ).toBe(true)
    } finally {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
      for (const dispose of disposers.splice(0).reverse()) dispose()
    }
  })
})

describe('v2：launchPet（fake spawn，绝不启动真实进程）', () => {
  /** apply 一次并注入 fake spawn/env；返回 disposer。 */
  function applyWithLaunch(
    dir: string,
    config: Record<string, unknown>,
    fake: FakeSpawn,
    env?: Record<string, string | undefined>,
    resolveExecutable?: (appPath: string) => string | null
  ): () => void {
    const ctx = makeFakeCtx()
    const deps: Record<string, unknown> = { spawn: fake.spawn, env }
    if (resolveExecutable !== undefined) deps['resolveExecutable'] = resolveExecutable
    return bridge.apply(ctx, { dir, ...config }, deps)
  }

  it('launchPet=true + petAppPath：apply 时 spawn(\'open\', [path], detached+stdio:\'ignore\') 一次并 unref', () => {
    const dir = makeTempDir()
    const fake = makeFakeSpawn()
    const dispose = applyWithLaunch(
      dir,
      { launchPet: true, petAppPath: '/Applications/AventurinePet.app' },
      fake,
      {}
    )

    try {
      expect(fake.calls).toEqual([
        {
          command: 'open',
          args: ['/Applications/AventurinePet.app'],
          options: { detached: true, stdio: 'ignore', env: {} }
        }
      ])
      expect(fake.unrefs).toHaveLength(1)
      expect(fake.unrefs[0]).toHaveBeenCalledTimes(1)
      expect(fake.children[0].listeners.get('error')).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('petBundleId：spawn(\'open\', [\'-b\', id])；petAppPath 优先于 petBundleId', () => {
    const dirBundle = makeTempDir()
    const fakeBundle = makeFakeSpawn()
    const disposeBundle = applyWithLaunch(dirBundle, { launchPet: true, petBundleId: 'com.aventurine.pet' }, fakeBundle, {})
    try {
      expect(fakeBundle.calls[0]).toMatchObject({ command: 'open', args: ['-b', 'com.aventurine.pet'] })
    } finally {
      disposeBundle()
    }

    const dirBoth = makeTempDir()
    const fakeBoth = makeFakeSpawn()
    const disposeBoth = applyWithLaunch(
      dirBoth,
      { launchPet: true, petAppPath: '/Applications/AventurinePet.app', petBundleId: 'com.aventurine.pet' },
      fakeBoth,
      {}
    )
    try {
      expect(fakeBoth.calls[0].args).toEqual(['/Applications/AventurinePet.app'])
    } finally {
      disposeBoth()
    }
  })

  it('launchPet 缺省/false、或环境变量 AVENTURINE_BRIDGE_DISABLE_LAUNCH=1 时不 spawn', () => {
    const dirDefault = makeTempDir()
    const fakeDefault = makeFakeSpawn()
    const disposeDefault = applyWithLaunch(dirDefault, { petAppPath: '/Applications/AventurinePet.app' }, fakeDefault, {})
    try {
      expect(fakeDefault.calls).toEqual([])
    } finally {
      disposeDefault()
    }

    const dirFalse = makeTempDir()
    const fakeFalse = makeFakeSpawn()
    const disposeFalse = applyWithLaunch(dirFalse, { launchPet: false, petAppPath: '/Applications/AventurinePet.app' }, fakeFalse, {})
    try {
      expect(fakeFalse.calls).toEqual([])
    } finally {
      disposeFalse()
    }

    const dirDisabled = makeTempDir()
    const fakeDisabled = makeFakeSpawn()
    const disposeDisabled = applyWithLaunch(
      dirDisabled,
      { launchPet: true, petAppPath: '/Applications/AventurinePet.app' },
      fakeDisabled,
      { [constants.BRIDGE_DISABLE_LAUNCH_ENV]: '1' }
    )
    try {
      expect(fakeDisabled.calls).toEqual([])
    } finally {
      disposeDisabled()
    }

    // 真实 process.env 路径（canary 就靠它禁用拉起）：deps 未传 env 时读 process.env。
    const previous = process.env.AVENTURINE_BRIDGE_DISABLE_LAUNCH
    process.env.AVENTURINE_BRIDGE_DISABLE_LAUNCH = '1'
    try {
      const dirProcessEnv = makeTempDir()
      const fakeProcessEnv = makeFakeSpawn()
      const ctx = makeFakeCtx()
      const dispose = bridge.apply(
        ctx,
        { dir: dirProcessEnv, launchPet: true, petAppPath: '/Applications/AventurinePet.app' },
        { spawn: fakeProcessEnv.spawn }
      )
      try {
        expect(fakeProcessEnv.calls).toEqual([])
      } finally {
        dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.AVENTURINE_BRIDGE_DISABLE_LAUNCH
      else process.env.AVENTURINE_BRIDGE_DISABLE_LAUNCH = previous
    }
  })

  it('launchPet=true 但既无 petAppPath 也无 petBundleId：只 warn 不 spawn，宿主不受影响', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = makeTempDir()
    const fake = makeFakeSpawn()
    let dispose: () => void = () => {}
    expect(() => {
      dispose = applyWithLaunch(dir, { launchPet: true }, fake, {})
    }).not.toThrow()

    try {
      expect(fake.calls).toEqual([])
      expect(
        warnSpy.mock.calls.some((call) => String(call[1]).includes('neither petAppPath nor petBundleId'))
      ).toBe(true)
      // 桥的其他功能正常（status/control 已写）。
      expect(readControl(dir).action).toBe('attached')
    } finally {
      dispose()
    }
  })

  it('spawn 同步抛错 / 子进程异步 error 都只 warn，不向宿主抛；disposer 正常', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // ① spawn 同步抛错
    const throwingFake: FakeSpawn = {
      calls: [],
      children: [],
      unrefs: [],
      spawn: vi.fn(() => {
        throw new Error('spawn boom')
      }) as unknown as FakeSpawn['spawn']
    }
    const dirThrow = makeTempDir()
    let disposeThrow: () => void = () => {}
    expect(() => {
      disposeThrow = applyWithLaunch(dirThrow, { launchPet: true, petAppPath: '/x.app' }, throwingFake, {})
    }).not.toThrow()
    try {
      expect(
        warnSpy.mock.calls.some((call) => String(call[1]).includes('launch pet failed'))
      ).toBe(true)
    } finally {
      disposeThrow()
    }

    // ② spawn 成功但子进程异步 'error'（如 open 不存在）
    const asyncFailFake = makeFakeSpawn({ failWith: new Error('open: no such app') })
    const dirAsync = makeTempDir()
    const disposeAsync = applyWithLaunch(dirAsync, { launchPet: true, petAppPath: '/x.app' }, asyncFailFake, {})
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            String(call[1]).includes('launch pet failed') &&
            String(call[1]).includes('open: no such app')
        )
      ).toBe(true)
      // 异步失败不能让宿主崩溃：disposer 仍可正常执行。
      expect(() => disposeAsync()).not.toThrow()
      expect(readControl(dirAsync).action).toBe('detached')
    } finally {
      disposeAsync()
    }
  })

  it('petAppPath 能解析出内部可执行文件：直接 spawn 可执行 + 清洗 ELECTRON_RUN_AS_NODE（修复 open 继承 Node 模式）', () => {
    const dir = makeTempDir()
    const fake = makeFakeSpawn()
    const dispose = applyWithLaunch(
      dir,
      { launchPet: true, petAppPath: '/fake/AventurinePet.app' },
      fake,
      { ELECTRON_RUN_AS_NODE: '1', DSH_CLIENT_VERSION: '0.2.2-rc.1' },
      () => '/fake/AventurinePet.app/Contents/MacOS/AventurinePet'
    )

    try {
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0].command).toBe('/fake/AventurinePet.app/Contents/MacOS/AventurinePet')
      expect(fake.calls[0].args).toEqual([])
      const options = fake.calls[0].options as { detached: boolean; stdio: string; env: Record<string, string | undefined> }
      expect(options.detached).toBe(true)
      expect(options.stdio).toBe('ignore')
      expect(options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
      expect(options.env['DSH_CLIENT_VERSION']).toBe('0.2.2-rc.1')
      expect(fake.unrefs).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('petAppPath 解析不到可执行（非 .app / 内部缺失）：回退 open <path>', () => {
    const dir = makeTempDir()
    const fake = makeFakeSpawn()
    const dispose = applyWithLaunch(
      dir,
      { launchPet: true, petAppPath: '/Applications/AventurinePet.app' },
      fake,
      {},
      () => null
    )

    try {
      expect(fake.calls).toEqual([
        {
          command: 'open',
          args: ['/Applications/AventurinePet.app'],
          options: { detached: true, stdio: 'ignore', env: {} }
        }
      ])
    } finally {
      dispose()
    }
  })

  it('createPetLauncher：每个实例最多触发一次；非 true 的脏值不拉起', () => {
    const fake = makeFakeSpawn()
    const launcher = bridge.createPetLauncher({ spawn: fake.spawn, env: {} })

    expect(launcher({ launchPet: true, petAppPath: '/Applications/AventurinePet.app' })).toBe(true)
    expect(launcher({ launchPet: true, petAppPath: '/Applications/AventurinePet.app' })).toBe(false)
    expect(fake.calls).toHaveLength(1)

    const dirtyFake = makeFakeSpawn()
    const dirtyLauncher = bridge.createPetLauncher({ spawn: dirtyFake.spawn, env: {} })
    expect(dirtyLauncher(undefined)).toBe(false)
    expect(dirtyLauncher(null)).toBe(false)
    expect(dirtyLauncher({ launchPet: 'true' })).toBe(false)
    expect(dirtyLauncher({ launchPet: 1 })).toBe(false)
    expect(dirtyFake.calls).toEqual([])

    // 每个 apply 实例独立：两次 apply 各拉起一次（幂等性由单实例范围保证）。
    const dirA = makeTempDir()
    const dirB = makeTempDir()
    const fakeApply = makeFakeSpawn()
    const disposeA = applyWithLaunch(dirA, { launchPet: true, petBundleId: 'com.aventurine.pet' }, fakeApply, {})
    const disposeB = applyWithLaunch(dirB, { launchPet: true, petBundleId: 'com.aventurine.pet' }, fakeApply, {})
    try {
      expect(fakeApply.calls).toHaveLength(2)
    } finally {
      disposeA()
      disposeB()
    }
  })
})

describe('createEventLog：F9 事件类型白名单（可单测的写入单元）', () => {
  it('非法事件类型只 warn 不写入；白名单类型正常写入并更新 lastType/lastEventAt', () => {
    const dir = makeTempDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = bridge.createEventLog({ dir })

    try {
      expect(log.appendEvent('task/error', { agent: 'agent-1' })).toBe(true)
      const firstTs = log.lastEventAt
      expect(firstTs).toBeGreaterThan(0)
      expect(log.lastType).toBe('task/error')

      // 非白名单类型（含现实中不存在的 subagent/failed —— 防旧错误 fixture 回归）。
      expect(log.appendEvent('bogus/type', { agent: 'x' })).toBe(false)
      expect(log.appendEvent('subagent/failed', {})).toBe(false)

      const events = readEvents(dir)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('task/error')
      expect(log.lastType).toBe('task/error')
      expect(
        warnSpy.mock.calls.some((call) => String(call[1]).includes('event type rejected'))
      ).toBe(true)
    } finally {
      log.close()
    }
  })

  it('关闭后不再写入；超长行丢弃与轮转阈值仍可覆盖', () => {
    const dir = makeTempDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = bridge.createEventLog({ dir, maxLineBytes: 400, rotateBytes: 512 })

    try {
      expect(log.appendEvent('session/event', { payload: 'x'.repeat(600) })).toBe(false)
      expect(
        warnSpy.mock.calls.some((call) => String(call[1]).includes('event dropped'))
      ).toBe(true)

      for (let index = 0; index < 8; index += 1) {
        expect(
          log.appendEvent('session/event', {
            sessionId: `session-${index}`,
            eventType: 'assistant/message',
            seq: index
          })
        ).toBe(true)
      }
      // 8 条事件足以触发 512B 轮转；两段内容都必须是合法 NDJSON。
      expect(existsSync(`${eventsPathOf(dir)}.1`)).toBe(true)
      const rotated = readEventLines(`${eventsPathOf(dir)}.1`)
      const current = readEvents(dir)
      expect(rotated.length).toBeGreaterThan(0)
      expect(current.length).toBeGreaterThan(0)
      expect(rotated.length + current.length).toBe(8)

      log.close()
      expect(log.appendEvent('task/end', { agent: 'x' })).toBe(false)
    } finally {
      log.close()
    }
  })

  it('未提供 dir 时防御性拒绝写入（不抛、不写相对路径）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = bridge.createEventLog({})

    try {
      expect(log.appendEvent('task/start', { agent: 'x' })).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      log.close()
    }
  })
})

describe('心跳与阈值覆盖', () => {
  it('心跳按 BRIDGE_HEARTBEAT_MS 覆盖写 status.json，disposer 后停止', () => {
    const dir = makeTempDir()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))

    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir })

    try {
      const first = readStatus(dir)
      expect(first.ts).toBe(Date.now())

      vi.advanceTimersByTime(constants.BRIDGE_HEARTBEAT_MS)
      const second = readStatus(dir)
      expect(second.offline).toBe(false)
      expect(second.ts).toBe(first.ts + constants.BRIDGE_HEARTBEAT_MS)

      dispose()
      const offlineRaw = readFileSync(statusPathOf(dir), 'utf8')
      vi.advanceTimersByTime(constants.BRIDGE_HEARTBEAT_MS * 3)
      // 心跳已清除：离线帧不会再被覆盖。
      expect(readFileSync(statusPathOf(dir), 'utf8')).toBe(offlineRaw)
      expect(readStatus(dir).offline).toBe(true)
    } finally {
      dispose()
      vi.useRealTimers()
    }
  })

  it('config.rotateBytes 覆盖：超过阈值后 events.jsonl.1 出现，两段内容都是合法 NDJSON', () => {
    const dir = makeTempDir()
    const ctx = makeFakeCtx()
    // 测试专用覆盖（默认仍是契约常量 5MB）；每个事件行约 100B，8 条足以触发 512B 轮转。
    const dispose = bridge.apply(ctx, { dir, rotateBytes: 512 })

    try {
      for (let index = 0; index < 8; index += 1) {
        const status = index % 2 === 0 ? 'running' : 'idle'
        ctx.emit('agent/status', agentStatusFrame('agent-rotate', status))
      }

      const rotatedPath = `${eventsPathOf(dir)}.1`
      expect(existsSync(rotatedPath)).toBe(true)

      const rotatedEvents = readEventLines(rotatedPath)
      const currentEvents = readEvents(dir)
      expect(rotatedEvents.length).toBeGreaterThan(0)
      expect(currentEvents.length).toBeGreaterThan(0)
      // 轮转不丢事件：旧段 + 新段 = 8 条。
      expect(rotatedEvents.length + currentEvents.length).toBe(8)
      expect(readStatus(dir).lastType).toBe('task/end')
    } finally {
      dispose()
    }
  })

  it('config.maxLineBytes 覆盖：超长事件被丢弃并 warn，正常事件不受影响', () => {
    const dir = makeTempDir()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeFakeCtx()
    const dispose = bridge.apply(ctx, { dir, maxLineBytes: 256 })

    try {
      ctx.emit('agent/status', agentStatusFrame('small', 'running'))
      expect(readEvents(dir)).toHaveLength(1)

      ctx.emit('agent/status', agentStatusFrame('x'.repeat(600), 'running'))
      expect(readEvents(dir)).toHaveLength(1)
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            String(call[0]).includes('[dsh-aventurine-bridge]') &&
            String(call[1]).includes('event dropped')
        )
      ).toBe(true)

      // 丢弃不会让进程/插件崩溃；后续正常事件仍然写入。
      ctx.emit('agent/status', agentStatusFrame('small', 'idle'))
      expect(readEvents(dir)).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  it('桥目录不可用（dir 指向文件）：v4 apply 失败隔离只 warn 不抛，事件/disposer 均安全', () => {
    const root = makeTempDir()
    const occupiedPath = join(root, 'bridge-dir-is-a-file')
    writeFileSync(occupiedPath, 'occupied')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = makeFakeCtx()
    let dispose: () => void = () => {}

    // v4：目录不可用 → apply 外层兜底（写不了诊断也无妨：候选都不可写时只 warn），
    // 返回 no-op disposer，绝不 throw 到宿主。
    expect(() => {
      dispose = bridge.apply(ctx, { dir: occupiedPath })
    }).not.toThrow()
    expect(typeof dispose).toBe('function')

    try {
      // 启动失败不订阅任何事件，emit 完全无副作用；同时覆盖「坏目录下事件/disposer 不抛」。
      expect(() => {
        ctx.emit('agent/status', agentStatusFrame('agent-1', 'running'))
        emitSessionEvent(
          ctx,
          'session-1',
          durableEvent('turn/end', 1, { turn: 1, reason: { kind: 'error' } })
        )
        ctx.emit('agent/status', agentStatusFrame('agent-1', 'idle'))
      }).not.toThrow()
      expect(ctx.handlers).toHaveLength(0)
      expect(existsSync(join(occupiedPath, 'status.json'))).toBe(false)
      expect(existsSync(join(occupiedPath, constants.BRIDGE_CONTROL_FILE))).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
      expect(String(warnSpy.mock.calls[0][0])).toBe('[dsh-aventurine-bridge]')
    } finally {
      expect(() => dispose()).not.toThrow()
    }
  })
})

describe('M-8：同进程多实例同目录', () => {
  it('两个实例并发写同一桥目录：临时文件名唯一、无 tmp 残留、status.json 始终合法（last-writer-wins 为已知限制）', () => {
    const dir = makeTempDir()
    const ctxA = makeFakeCtx()
    const ctxB = makeFakeCtx()
    const disposeA = bridge.apply(ctxA, { dir })
    const disposeB = bridge.apply(ctxB, { dir })

    try {
      // 两个实例都写了启动帧，但各自的 tmp 名按 pid+实例+序号唯一 → 无残留。
      expect(statusTmpFiles(dir)).toEqual([])
      expect(readStatus(dir).offline).toBe(false)

      ctxA.emit('agent/status', agentStatusFrame('agent-a', 'running'))
      let status = readStatus(dir)
      expect(status.running).toBe(true)
      expect(status.agents).toBe(1)
      expect(statusTmpFiles(dir)).toEqual([])

      // B 的帧会覆盖 A 的 running 状态（README 声明的单写者假设 / 已知限制），
      // 但不会产生半截 JSON，也不会互相删除临时文件。
      ctxB.emit('agent/status', agentStatusFrame('agent-b', 'idle'))
      status = readStatus(dir)
      expect(status.running).toBe(false)
      expect(status.agents).toBe(0)
      expect(statusTmpFiles(dir)).toEqual([])

      // 事件流是追加写：两实例的事件都保留（顺序由写入时刻决定）。
      expect(readEvents(dir).map((event) => event.type)).toEqual(['task/start'])
    } finally {
      disposeA()
      disposeB()
    }

    expect(statusTmpFiles(dir)).toEqual([])
    const finalStatus = readStatus(dir)
    expect(finalStatus.offline).toBe(true)
    expect(schema.toDshStatus(finalStatus, Date.now()).online).toBe(false)
  })
})
