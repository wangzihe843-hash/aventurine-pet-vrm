#!/usr/bin/env node
/**
 * Wave 3 独立实机验证（V）公共库 —— 隔离启动、CDP 驱动、证据落盘、断言收集。
 *
 * 安全红线（task-13）：
 * - 绝不重启/终止真实 DeepSeek Harness、绝不 open -a 真实 DSH、不改真实 ~/.dsh / desktop profile；
 * - 所有桌宠进程用独立 `HOME`（+ `PET_PROFILE`），桥目录用 `PET_DSH_DIR` 指向临时目录；
 * - 强耦合测试仅用 `PET_DSH_TEST_HOOKS=1` + fake 进程；打包版启动必带 `PET_DSH_COUPLING_DISABLE=1`。
 *
 * 本文件只写 `tests/tmp/wave3-e2e/**`；不 import 项目源码（验证脚本与实现解耦）。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(SCRIPT_DIR, '..', '..')
export const OUT_ROOT = join(ROOT, 'tests/tmp/wave3-e2e')
export const ELECTRON_BIN = createRequire(import.meta.url)('electron')
export const PACKAGED_APP_BIN = join(
  ROOT,
  'dist/mac-arm64/AventurinePet.app/Contents/MacOS/AventurinePet'
)
export const PACKAGED_APP = join(ROOT, 'dist/mac-arm64/AventurinePet.app')
export const DESKTOP_PATCH = join(realpathSync(join(homedir(), '.dsh')), 'profiles/desktop/cordis.patch.yml')

/** 真实 DSH 的主进程/子进程匹配用（只读快照，绝不发信号）。 */
export const REAL_DSH_MAIN_PATTERN = /\/Applications\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness$/

/** 本次运行的运行目录（`<OUT_ROOT>/<ts>-<name>`）。 */
export function makeRunDir(name) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(OUT_ROOT, `${ts}-${name}`)
  mkdirSync(join(dir, 'bridge'), { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  mkdirSync(join(dir, 'shots'), { recursive: true })
  return dir
}

/** 写 JSON（自动 mkdir）。 */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** 追加一行 JSON。 */
export function appendJsonl(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

/** 读 JSON（失败 → null）。 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 截断长文本（证据可读性）。 */
export function excerpt(text, max = 2000) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max}]` : value
}

/** 文件 sha256（不存在 → null）。 */
export function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** 文件签名（size + mtimeMs + sha256），不存在 → 'missing'。 */
export function fileSignature(file) {
  try {
    const stats = statSync(file)
    if (!stats.isFile()) return `not-file:${stats.mode}`
    return `${stats.size}:${stats.mtimeMs.toFixed(3)}:${sha256File(file)}`
  } catch {
    return 'missing'
  }
}

/** 目录内文件的签名表（只一层；不存在 → {}）。 */
export function dirSignature(dir) {
  const out = {}
  try {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      try {
        const stats = statSync(file)
        if (stats.isFile()) out[name] = `${stats.size}:${stats.mtimeMs.toFixed(3)}:${sha256File(file)}`
      } catch {
        out[name] = 'stat-failed'
      }
    }
  } catch {
    // 目录不存在 → 空表
  }
  return out
}

/** 找空闲本地端口。 */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => (port === null ? reject(new Error('无法分配端口')) : resolvePort(port)))
    })
  })
}

/** 从 `ps -axo pid=,args=` 输出里解析真实 DSH 主进程 pid 列表（只读）。 */
export function realDshPids() {
  const result = spawnSyncSafe('/bin/ps', ['-axo', 'pid=,args='])
  const pids = []
  for (const line of result.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const [, pid, args] = match
    if (REAL_DSH_MAIN_PATTERN.test(args)) pids.push(Number(pid))
  }
  return pids.sort((a, b) => a - b)
}

/** 同步执行（只读查询用；超时兜底）。 */
export function spawnSyncSafe(file, args) {
  const { spawnSync } = createRequire(import.meta.url)('node:child_process')
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 5000 })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/** 真实 ~/.dsh 中「本任务不得改动」的最小快照（桥目录 + desktop patch + DSH_HOME 实体路径）。 */
export function snapshotRealDshState() {
  const dshHome = realpathSync(join(homedir(), '.dsh'))
  const bridgeDir = join(dshHome, 'aventurine-pet')
  return {
    dshHome,
    desktopPatch: fileSignature(join(dshHome, 'profiles/desktop/cordis.patch.yml')),
    bridgeDir: dirSignature(bridgeDir),
    dshHomeTop: readdirSync(dshHome, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
      .sort(),
    realDshPids: realDshPids()
  }
}

/**
 * 构造隔离子进程环境：清掉可能串到真实 DSH 的变量，设置 HOME/PET_PROFILE/PET_DSH_DIR。
 * @param {{ home: string, profile: string, dshDir: string, extra?: Record<string,string|undefined> }} options
 */
export function isolatedEnv({ home, profile, dshDir, extra = {} }) {
  const env = { ...process.env }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'DSH_HOME',
    'PET_PROFILE',
    'PET_DSH_DIR',
    'PET_DSH_COUPLING',
    'PET_DSH_COUPLING_DISABLE',
    'PET_DSH_TEST_HOOKS',
    'PET_DSH_TEST_PROCESS_PATTERN',
    'PET_DSH_TEST_LAUNCH_CMD',
    'PET_DSH_TEST_QUIT_DELAY_MS',
    'PET_DEV_CAPTURE_DIR',
    'PET_DEV_CAPTURE_POSES',
    'PET_SMOKE_TEST',
    'AVENTURINE_BRIDGE_DISABLE_LAUNCH',
    'PET_DSH_COUPLING_SILENT_ALERTS'
  ]) {
    delete env[key]
  }
  // 测试脚本可能从 shell 继承代理/调试变量；保持最小化。
  env.HOME = home
  env.PET_PROFILE = profile
  env.PET_DSH_DIR = dshDir
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'
  // 2026-11-11 兼容性安全 v2：DEGRADED 告警默认静默（只写 main.log），避免模态框卡住 CDP 自动化；
  // 需要验证告警 UI 的场景可通过 extra 覆盖。
  env.PET_DSH_COUPLING_SILENT_ALERTS = '1'
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/**
 * 启动桌宠（dev：`electron .`；packaged：直接跑 .app 内二进制）。
 * 远程调试开关放在 app 路径之前（Electron 官方推荐形式）。
 * @returns {{ child: import('node:child_process').ChildProcess, logFile: string, close: () => Promise<{code:number|null, signal:string|null}> }}
 */
export function launchPet({ runDir, label, env, debugPort = null, packaged = false }) {
  const logFile = join(runDir, `${label}.stdout.log`)
  const args = []
  if (debugPort !== null) args.push(`--remote-debugging-port=${debugPort}`)
  if (!packaged) args.push('.')
  const stream = { file: logFile, chunks: [] }
  mkdirSync(dirname(logFile), { recursive: true })
  const child = spawn(packaged ? PACKAGED_APP_BIN : ELECTRON_BIN, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const fanout = (chunk) => {
    const text = String(chunk)
    stream.chunks.push(text)
    appendFileSync(logFile, text)
  }
  child.stdout?.on('data', fanout)
  child.stderr?.on('data', fanout)
  let exitInfo = null
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal }
  })
  /** 关闭：SIGTERM（优雅）→ deadline 后 SIGKILL；返回退出码/信号。 */
  const close = async ({ graceful = false, deadlineMs = 15000 } = {}) => {
    if (exitInfo === null) {
      try {
        child.kill(graceful ? 'SIGTERM' : 'SIGKILL')
      } catch {
        // 已退出
      }
    }
    const started = Date.now()
    while (exitInfo === null && Date.now() - started < deadlineMs) {
      await delay(100)
    }
    if (exitInfo === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出
      }
      await delay(500)
    }
    return exitInfo ?? { code: null, signal: 'unknown' }
  }
  return { child, logFile, get exitInfo() { return exitInfo }, close }
}

/** 等待条件成立；超时抛错（带 label 与最近一次值）。 */
export async function waitFor(check, { timeoutMs = 10000, intervalMs = 100, label = 'condition' } = {}) {
  const started = Date.now()
  let last = null
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      last = value
      if (value) return { value, elapsedMs: Date.now() - started }
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  const suffix = lastError ? `；最后异常：${lastError instanceof Error ? lastError.message : String(lastError)}` : ''
  throw new Error(`等待超时（${label}，${timeoutMs}ms）：last=${JSON.stringify(last)}${suffix}`)
}

/** 等待桌宠进程自行退出（不发任何信号；返回退出码/信号或 null=超时）。 */
export async function waitPetExit(pet, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (pet.exitInfo !== null) return pet.exitInfo
    await delay(intervalMs)
  }
  return pet.exitInfo
}

/** 轮询 HTTP JSON（CDP /json/list 用）。 */
export async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 极简 CDP 客户端（Node 22+ 自带全局 WebSocket；无第三方依赖）。 */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`CDP ${entry.method} 失败：${JSON.stringify(message.error)}`))
      else entry.resolve(message.result ?? {})
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolveOpen()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP WebSocket 连接失败'))
      })
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = this.nextId++
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, method })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        rejectSend(error)
      }
    })
  }

  /** Runtime.evaluate；返回 JS 值（by value）。 */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: false
    })
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`页面求值异常：${description}`)
    }
    return result.result?.value
  }

  /** 透明背景截图（保留 overlay alpha），可裁剪到指定 CSS 矩形。 */
  async screenshot(file, { clip = null } = {}) {
    await this.send('Page.enable').catch(() => {})
    // Electron overlay 是透明窗口：显式允许透明背景，否则合成结果可能变黑底。
    await this.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 }
    }).catch(() => {})
    const params = { format: 'png', fromSurface: true, captureBeyondViewport: false }
    if (clip) {
      params.clip = {
        x: Math.max(0, Math.floor(clip.x)),
        y: Math.max(0, Math.floor(clip.y)),
        width: Math.max(1, Math.ceil(clip.width)),
        height: Math.max(1, Math.ceil(clip.height)),
        scale: 1
      }
    }
    const result = await this.send('Page.captureScreenshot', params)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return { file, bytes: statSync(file).size, clip }
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // 已关闭
    }
    this.closed = true
  }
}

/**
 * 等待 CDP page target（自动选 overlay 页面：url 含 index.html 或首个 page）。
 * @returns {Promise<{ wsUrl: string, target: any }>}
 */
export async function waitCdpTarget(port, { timeoutMs = 60000, label = 'cdp' } = {}) {
  let lastList = null
  const { value } = await waitFor(
    async () => {
      lastList = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      if (!Array.isArray(lastList)) return null
      const pages = lastList.filter((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
      if (pages.length === 0) return null
      return pages.find((entry) => /index\.html/.test(entry.url)) ?? pages[0]
    },
    { timeoutMs, intervalMs: 250, label }
  )
  return { wsUrl: value.webSocketDebuggerUrl, target: value, targets: lastList }
}

/**
 * 定位 main.log。
 *
 * 背景（本次验证实测）：macOS 上 Electron 的 `app.getPath('appData')` 走 NSHomeDirectory，
 * **不认子进程 `HOME` 环境变量**；因此隔离手段是 `PET_PROFILE`（dev 版 userData 后缀）。
 * 这里同时扫描「隔离 HOME 的 appData」与「真实 HOME 的 appData」：
 * - dev：`<真实HOME>/Library/Application Support/aventurine-pet-<profile>/logs/main.log`；
 * - packaged：`<真实HOME>/Library/Application Support/{aventurine-pet,AventurinePet}/logs/main.log`。
 */
export function findMainLog(home, { profile = null, packaged = false } = {}) {
  const appDataRoots = [join(home, 'Library/Application Support'), join(homedir(), 'Library/Application Support')]
  const candidates = []
  for (const appData of appDataRoots) {
    let names
    try {
      names = readdirSync(appData)
    } catch {
      continue
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      if (!lower.startsWith('aventurine-pet') && lower !== 'aventurinepet') continue
      // 目录筛选：dev 按下划线后缀匹配 profile；packaged 只看默认 userData 目录。
      if (packaged) {
        if (lower !== 'aventurine-pet' && lower !== 'aventurinepet') continue
      } else if (profile !== null) {
        if (!name.endsWith(`-${profile}`)) continue
      }
      const file = join(appData, name, 'logs/main.log')
      try {
        candidates.push({ file, userDataDir: join(appData, name), mtimeMs: statSync(file).mtimeMs })
      } catch {
        // 还没写日志（目录可能刚创建）
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.file ?? null
}

/** 等 main.log 出现并返回路径（附带 userData 目录，用于证据/清理）。 */
export async function waitMainLog(home, options = {}) {
  const { value } = await waitFor(
    () => {
      const file = findMainLog(home, { profile: options.profile ?? null, packaged: options.packaged === true })
      if (file === null) return null
      return { file, userDataDir: dirname(dirname(file)) }
    },
    { timeoutMs: options.timeoutMs ?? 45000, label: 'main.log' }
  )
  return value
}

/** 读取日志文本（不存在 → 空串）。 */
export function readLog(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 日志中是否包含任一子串。 */
export function logContains(logFile, needles) {
  const text = readLog(logFile)
  const list = Array.isArray(needles) ? needles : [needles]
  return list.some((needle) => text.includes(needle))
}

/** 等日志出现指定子串（返回命中行）。 */
export async function waitLog(logFile, needle, { timeoutMs = 15000, intervalMs = 100, label = needle } = {}) {
  const needles = Array.isArray(needle) ? needle : [needle]
  const { value } = await waitFor(
    () => {
      const text = readLog(logFile)
      for (const item of needles) {
        if (text.includes(item)) return item
      }
      return null
    },
    { timeoutMs, intervalMs, label: `日志出现「${label}」` }
  )
  return value
}

/** 取日志中包含 needle 的行（证据用）。 */
export function logLinesMatching(logFile, pattern) {
  const regex = typeof pattern === 'string' ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : pattern
  return readLog(logFile)
    .split('\n')
    .filter((line) => regex.test(line))
}

/** 断言收集器：不抛错，统一写入结果 JSON。 */
export class Assertions {
  constructor(name) {
    this.name = name
    this.items = []
  }

  check(id, ok, detail = null) {
    this.items.push({ id, ok: ok === true, detail, at: new Date().toISOString() })
    const mark = ok === true ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${id}${detail === null ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
    return ok === true
  }

  get failed() {
    return this.items.filter((item) => !item.ok)
  }

  summary() {
    return {
      name: this.name,
      total: this.items.length,
      passed: this.items.length - this.failed.length,
      failed: this.failed.length,
      failures: this.failed
    }
  }
}

/** 原子写 JSON（tmp + rename；模拟桥插件的写盘契约）。 */
export function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  const { renameSync } = createRequire(import.meta.url)('node:fs')
  renameSync(tmp, file)
}

/** 写桥 control 帧（schemaVersion 1）。 */
/**
 * 写 control.json 控制帧。
 *
 * 2026-11-11 兼容性安全 v2：新桌宠的 PAIRED 门槛要求「进程 + status.online + control attached
 * + compat 可验证」。默认写 `bridgeVersion: 3`（现网 legacy 桥形态）：桌宠用
 * `BRIDGE_LEGACY_DSH_RANGE = '>=0.2.2-rc.1 <0.3.0'` 回退判定，在真实 DSH 0.2.2-rc.1 下可正常
 * PAIRED。需要 v4 / 不兼容兼容块的场景用 `extra` 覆盖（例如
 * `writeControl(dir, 'attached', { bridgeVersion: 4, compat: { bridgeVersion: 4, controlSchema: 1, dshRange: '>=9.0.0' } })`）。
 *
 * @param {string} bridgeDir 隔离桥目录
 * @param {'attached'|'detached'} action 控制帧动作
 * @param {object} [extra] 覆盖字段（如 v4 compat）
 * @returns {number} 控制帧 ts
 */
export function writeControl(bridgeDir, action, extra = {}) {
  const ts = Date.now()
  atomicWriteJson(join(bridgeDir, 'control.json'), {
    schemaVersion: 1,
    bridgeVersion: 3,
    ts,
    action,
    dshPid: process.pid,
    ...(extra && typeof extra === 'object' ? extra : {})
  })
  return ts
}

/** 写桥 status 心跳（online 判定 TTL 30s）。 */
export function writeStatus(bridgeDir, patch = {}) {
  const ts = Date.now()
  atomicWriteJson(join(bridgeDir, 'status.json'), {
    ts,
    running: true,
    agents: 1,
    lastEventAt: ts,
    lastType: 'agent/status',
    ...patch
  })
  return ts
}

/** 追加一条桥事件（events.jsonl NDJSON）。 */
export function appendDshEvent(bridgeDir, type, payload) {
  const ts = Date.now()
  appendFileSync(join(bridgeDir, 'events.jsonl'), `${JSON.stringify({ ts, type, payload })}\n`)
  return ts
}

/** 辅助：生成唯一的 fake 进程路径（文件名含测试 pattern）。 */
export function fakeDshScriptPath(runDir) {
  return join(runDir, 'w3e2e-fake-dsh.mjs')
}

/** 写入 fake DSH 脚本（node 脚本；支持 SIGTERM 记录 + pid 文件 + 启动记录）。 */
export function writeFakeDshScript(runDir) {
  const file = fakeDshScriptPath(runDir)
  const code = `#!/usr/bin/env node
// Wave 3 E2E fake DSH（仅测试用；绝不接触真实 DSH）
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const args = process.argv.slice(2)
const logIndex = args.indexOf('--log')
const pidIndex = args.indexOf('--pidfile')
const logFile = logIndex >= 0 ? args[logIndex + 1] : null
const pidFile = pidIndex >= 0 ? args[pidIndex + 1] : null
const record = (value) => {
  if (!logFile) return
  mkdirSync(dirname(logFile), { recursive: true })
  appendFileSync(logFile, JSON.stringify({ ...value, pid: process.pid, at: Date.now() }) + '\\n')
}
record({ event: 'start' })
if (pidFile) {
  mkdirSync(dirname(pidFile), { recursive: true })
  writeFileSync(pidFile, String(process.pid))
}
const heartbeat = setInterval(() => record({ event: 'heartbeat' }), 2000)
heartbeat.unref()
process.on('SIGTERM', () => {
  record({ event: 'sigterm' })
  clearInterval(heartbeat)
  // 模拟 Electron 优雅退出：稍作延迟后退出，让 SIGTERM 轮询能看到 pid 消失。
  setTimeout(() => process.exit(0), 120)
})
process.on('SIGINT', () => {
  record({ event: 'sigint' })
  process.exit(0)
})
// 永不自行退出：由测试或 SIGTERM 结束。
setInterval(() => {}, 1 << 30)
`
  writeFileSync(file, code)
  return file
}

/** 读 fake DSH 日志（JSONL → 数组；不存在 → []）。 */
export function readFakeLog(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 轮询 fake 日志直到满足条件。 */
export async function waitFakeLog(file, predicate, options = {}) {
  const { value } = await waitFor(
    () => {
      const entries = readFakeLog(file)
      const found = entries.filter(predicate)
      return found.length > 0 ? found : null
    },
    { timeoutMs: options.timeoutMs ?? 15000, intervalMs: options.intervalMs ?? 100, label: options.label ?? 'fake log' }
  )
  return value
}

/** 进程存活（signal 0）。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 用 fake pid 文件读 pid（不存在 → null）。 */
export function readPidFile(file) {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** 断言表 → 证据 JSON + 控制台汇总；返回退出码。 */
export async function finalizeResult(runDir, assertions, extra = {}) {
  const summary = { generatedAt: new Date().toISOString(), runDir, ...assertions.summary(), ...extra }
  writeJson(join(runDir, 'result.json'), summary)
  const failed = assertions.summary().failed > 0
  console.log(`\n[${failed ? 'FAIL' : 'PASS'}] ${assertions.name}：${summary.passed}/${summary.total} 断言通过 → ${join(runDir, 'result.json')}`)
  if (failed) {
    for (const item of assertions.failed) console.log(`  - ${item.id}: ${JSON.stringify(item.detail)}`)
  }
  return failed ? 1 : 0
}

/** 默认临时 HOME（runDir 内，避免 /tmp 清理干扰证据）。 */
export function tempHome(runDir) {
  return join(runDir, 'home')
}

/** 默认临时桥目录（runDir 内）。 */
export function tempBridgeDir(runDir) {
  return join(runDir, 'bridge')
}

/** 常用睡眠（导出，统一单位）。 */
export { delay }

/** 供脚本显式引用（避免 tree-shaking 误判未使用）。 */
export const VERSION = '1.0.0'
