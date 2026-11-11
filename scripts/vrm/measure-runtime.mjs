#!/usr/bin/env node
/**
 * Wave 3 V9 / A6 性能基线（dev-only）：在**隔离 profile** 下启动**生产构建** `out/`，
 * 通过 `--remote-debugging-port` + CDP 读取 renderer 的 `window.__aventurineDebug.stats()`
 * （fps / drawCalls / triangles / petRect …），同时用 `ps` 采样 Electron 进程树的
 * RSS / CPU，输出 JSON + markdown 到 `tests/tmp/wave3-perf/`。
 *
 * 安全隔离（沿用 capture-app / e2e-restart 的既有模式，见 scripts/vrm/e2e-restart.mjs:22-47）：
 * - `HOME=/tmp/w3-perf-home`（可用 --home 覆盖）；
 * - `PET_PROFILE=w3-perf`（可用 --profile 覆盖）：dev 下 app 把 userData 放到
 *   `<真实 home>/Library/Application Support/aventurine-pet-<profile>`；
 *   注意 macOS 的 `app.getPath('appData')` **不受 $HOME 影响**（系统 passwd home），
 *   所以 userData 会落在真实 Application Support 的**独立 profile 子目录**，不碰用户默认配置；
 * - `PET_DSH_DIR=<home>/.dsh/aventurine-pet`：硬隔离 DSH 桥目录，**不触碰真实 ~/.dsh**、
 *   不启动/安装任何 DSH 侧东西；本脚本只读快照真实 `~/.dsh/aventurine-pet` 做前后对比。
 * - 不设置 `PET_SMOKE_TEST` / `PET_DEV_CAPTURE_*`，让 app 走正常启动路径（真实渲染 + 正常自主行为）。
 *
 * 测量流程：
 *   spawn electron → 等 CDP target → 等 `__aventurineDebug.ready && model.loaded`（记录启动耗时）
 *   → warmup（默认 5s，不计入统计）→ idle（默认 60s）→ action（默认 20s，通过
 *   `debugTriggerActivity()` 触发真实走动/待机动作）→ SIGTERM 关停 → 采样分析 → 写 JSON/markdown。
 *
 * 用法：
 *   node scripts/vrm/measure-runtime.mjs
 *   node scripts/vrm/measure-runtime.mjs --label cap60 --fps-cap 60
 *   node scripts/vrm/measure-runtime.mjs --idle-ms 60000 --action-ms 20000 --sample-ms 1000
 *   node scripts/vrm/measure-runtime.mjs --no-action --label idle-only
 *   node scripts/vrm/measure-runtime.mjs --build          # 强制 pnpm build 后再测（默认不 build）
 *   node scripts/vrm/measure-runtime.mjs --check          # 只校验最近一次产物
 *
 * 退出码：0 = 完成且 ready/采样充足；1 = 失败（out 缺失、启动/ready 超时、采样不足等）；2 = --check 无产物。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { userInfo, loadavg, cpus, totalmem, release, arch, platform } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ELECTRON_BIN = path.join(
  ROOT,
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const ELECTRON_PKG = path.join(ROOT, 'node_modules/electron/package.json')
const DEFAULT_OUT = path.join(ROOT, 'tests/tmp/wave3-perf')
const REAL_HOME = userInfo().homedir
const APP_DATA_DIR = path.join(REAL_HOME, 'Library/Application Support')

/** action 阶段尝试触发的活动（无外部目标依赖、可反复触发；失败只记录不报错）。 */
const ACTION_ROTATION = [
  'walkTo',
  'returnCorner',
  'idleStretch',
  'lookAround',
  'idleToss',
  'idleCoin',
  'idleTidy'
]

/* -------------------------------------------------------------------------- */
/* 参数                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    home: '/tmp/w3-perf-home',
    profile: 'w3-perf',
    label: 'baseline',
    idleMs: 60_000,
    actionMs: 20_000,
    actionTriggerMs: 5_000,
    warmupMs: 5_000,
    sampleMs: 1_000,
    readyTimeoutMs: 90_000,
    shutdownTimeoutMs: 10_000,
    fpsCap: null,
    build: false,
    noAction: false,
    keepProfile: false,
    cleanProfile: true,
    check: false,
    force: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    if (arg === '--out') options.out = path.resolve(ROOT, next())
    else if (arg === '--home') options.home = path.resolve(next())
    else if (arg === '--profile') options.profile = next()
    else if (arg === '--label') options.label = next()
    else if (arg === '--idle-ms') options.idleMs = Number(next())
    else if (arg === '--action-ms') options.actionMs = Number(next())
    else if (arg === '--action-trigger-ms') options.actionTriggerMs = Number(next())
    else if (arg === '--warmup-ms') options.warmupMs = Number(next())
    else if (arg === '--sample-ms') options.sampleMs = Number(next())
    else if (arg === '--ready-timeout-ms') options.readyTimeoutMs = Number(next())
    else if (arg === '--shutdown-timeout-ms') options.shutdownTimeoutMs = Number(next())
    else if (arg === '--fps-cap') options.fpsCap = Number(next())
    else if (arg === '--build') options.build = true
    else if (arg === '--no-action') options.noAction = true
    else if (arg === '--keep-profile') options.keepProfile = true
    else if (arg === '--clean-profile') options.cleanProfile = true
    else if (arg === '--no-clean-profile') options.cleanProfile = false
    else if (arg === '--check') options.check = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/vrm/measure-runtime.mjs [--label name] [--fps-cap 30|60] [--idle-ms 60000] [--action-ms 20000] [--action-trigger-ms 5000] [--sample-ms 1000] [--build] [--no-action] [--out dir] [--home dir] [--profile name] [--check]'
      )
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.label)) throw new Error('--label 只允许小写字母/数字/连字符')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.profile)) throw new Error('--profile 只允许小写字母/数字/连字符')
  if (options.fpsCap !== null) {
    if (!Number.isFinite(options.fpsCap) || options.fpsCap < 5 || options.fpsCap > 60) {
      throw new Error('--fps-cap 必须在 5..60')
    }
    options.fpsCap = Math.round(options.fpsCap)
  }
  for (const key of ['idleMs', 'actionMs', 'actionTriggerMs', 'warmupMs', 'sampleMs', 'readyTimeoutMs', 'shutdownTimeoutMs']) {
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`${key} 必须是非负数`)
  }
  if (options.sampleMs < 100) throw new Error('--sample-ms 至少 100')
  return options
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function nowIso() {
  return new Date().toISOString()
}

function stamp() {
  return nowIso().replaceAll(':', '-').replaceAll('.', '-')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function safeStat(file) {
  try {
    const stat = statSync(file)
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    return null
  }
}

/** 目录快照（相对路径 → size/mtimeMs），只读；用于真实 DSH 目录前后对比。 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return null
  const entries = {}
  const walk = (current, prefix) => {
    let names
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const full = path.join(current, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(full, rel)
      else entries[rel] = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
    }
  }
  try {
    walk(dir, '')
  } catch {
    return null
  }
  return entries
}

function dirHash(snapshot) {
  if (snapshot === null) return null
  const hash = createHash('sha256')
  for (const key of Object.keys(snapshot).sort()) hash.update(`${key}:${snapshot[key].size}:${snapshot[key].mtimeMs};`)
  return hash.digest('hex')
}

/** 在 PATH 中找 pnpm（不依赖 shell 函数）。 */
function findPnpm() {
  const result = spawnSync('which', ['pnpm'], { encoding: 'utf8' })
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
  return null
}

/** 跑一次同步命令，返回 { status, stdout, stderr }。 */
function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env: options.env ?? process.env
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error) : null
  }
}

/** 非负有限数 → 保留小数的数值；否则 null。 */
function num(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function stats(values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (clean.length === 0) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  const mean = sum / sorted.length
  const percentile = (ratio) => {
    const position = (sorted.length - 1) * ratio
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    if (lower === upper) return sorted[lower]
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  }
  const variance = sorted.reduce((acc, value) => acc + (value - mean) ** 2, 0) / sorted.length
  return {
    count: sorted.length,
    mean: num(mean),
    p50: num(percentile(0.5)),
    p95: num(percentile(0.95)),
    min: num(sorted[0]),
    max: num(sorted[sorted.length - 1]),
    stddev: num(Math.sqrt(variance)),
    sum: num(sum)
  }
}

/* -------------------------------------------------------------------------- */
/* 进程采样（ps）                                                               */
/* -------------------------------------------------------------------------- */

/** 解析 ps 的 time 字段（`MM:SS.cc` / `HH:MM:SS` / `DD-HH:MM:SS`）为秒。 */
function parseCpuTime(text) {
  if (typeof text !== 'string') return null
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    (days ? Number(days) * 86_400 : 0) +
    (hours ? Number(hours) * 3_600 : 0) +
    Number(minutes) * 60 +
    Number(seconds)
  )
}

/** 当前整机进程表：pid → {pid,ppid,rssKb,cpuSec,pcpu,comm}。 */
function readProcessTable() {
  const result = runSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,pcpu=,comm='], { timeoutMs: 10_000 })
  const table = new Map()
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/.exec(trimmed)
    if (!match) continue
    const [, pid, ppid, rssKb, time, pcpu, comm] = match
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rssKb),
      cpuSec: parseCpuTime(time),
      pcpu: Number(pcpu),
      comm
    })
  }
  return table
}

/** 读取若干 pid 的 argv（用于区分 renderer/gpu/utility helper 与主进程）。 */
function readArgsForPids(pids) {
  const map = new Map()
  if (pids.length === 0) return map
  const result = runSync('ps', ['-o', 'pid=,args=', '-p', pids.join(',')], { timeoutMs: 10_000 })
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const match = /^(\d+)\s+(.*)$/.exec(trimmed)
    if (match) map.set(Number(match[1]), match[2])
  }
  return map
}

/** 以 rootPid 为根收集进程树（BFS，含 root），返回 pid 数组。 */
function collectTree(table, rootPid) {
  const children = new Map()
  for (const [pid, info] of table) {
    if (!children.has(info.ppid)) children.set(info.ppid, [])
    children.get(info.ppid).push(pid)
  }
  const order = []
  const queue = [rootPid]
  const seen = new Set()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    if (!table.has(pid)) continue
    order.push(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return order
}

function classifyProcess(comm, args) {
  if (typeof args === 'string') {
    if (args.includes('--type=renderer')) return 'renderer'
    if (args.includes('--type=gpu-process')) return 'gpu'
    if (args.includes('--type=utility')) return 'utility'
  }
  if (/Helper \(Renderer\)/.test(comm)) return 'renderer'
  if (/Helper \(GPU\)/.test(comm)) return 'gpu'
  if (/Helper \(Plugin\)/.test(comm)) return 'utility'
  if (/Helper/.test(comm)) return 'utility'
  return 'main'
}

/** 单次进程树采样；cpu 百分比用累计 CPU 时间差计算（整树合计）。 */
function sampleProcessTree(rootPid, previous) {
  const table = readProcessTable()
  const tree = rootPid !== null && table.has(rootPid) ? collectTree(table, rootPid) : []
  const argsMap = readArgsForPids(tree)
  const now = Date.now()
  const procs = []
  let rssTotalKb = 0
  const rssByRoleKb = { main: null, renderer: 0, gpu: 0, utility: 0, other: 0 }
  let cpuLifetimeSum = 0
  let cpuSecSum = 0
  let mainCpuSec = null
  for (const pid of tree) {
    const info = table.get(pid)
    if (!info) continue
    const args = argsMap.get(pid) ?? ''
    const role = pid === rootPid ? 'main' : classifyProcess(info.comm, args)
    const record = {
      pid,
      ppid: info.ppid,
      role,
      rssMb: num(info.rssKb / 1024, 1),
      cpuSec: info.cpuSec,
      pcpu: info.pcpu,
      comm: info.comm,
      // 只保留 Electron/Chromium 关键 flags，避免 JSON 过大。
      argsHint: (args.match(/--type=[\w-]+/g) ?? []).join(',') || null
    }
    procs.push(record)
    rssTotalKb += info.rssKb
    cpuLifetimeSum += info.pcpu
    if (role === 'main') {
      rssByRoleKb.main = info.rssKb
      mainCpuSec = info.cpuSec
    } else if (rssByRoleKb[role] !== undefined) {
      rssByRoleKb[role] += info.rssKb
    } else {
      rssByRoleKb.other += info.rssKb
    }
    if (typeof info.cpuSec === 'number') cpuSecSum += info.cpuSec
  }
  let cpuIntervalPct = null
  if (previous !== null && previous !== undefined && typeof previous.cpuSecSum === 'number' && cpuSecSum !== null) {
    const wallSec = (now - previous.at) / 1000
    if (wallSec > 0) {
      const delta = cpuSecSum - previous.cpuSecSum
      // 进程来去（如 GPU helper 重启）会让差值为负：此时本轮记 null，不污染统计。
      cpuIntervalPct = delta >= 0 ? num((delta / wallSec) * 100) : null
    }
  }
  return {
    at: now,
    procs,
    processCount: procs.length,
    rssTotalMb: num(rssTotalKb / 1024, 1),
    rssMainMb: rssByRoleKb.main === null ? null : num(rssByRoleKb.main / 1024, 1),
    rssByRoleMb: Object.fromEntries(
      Object.entries(rssByRoleKb).map(([role, kb]) => [role, kb === null ? null : num(kb / 1024, 1)])
    ),
    cpuLifetimePctSum: num(cpuLifetimeSum),
    cpuSecSum,
    cpuIntervalPct,
    mainCpuSec,
    roles: procs.reduce((acc, proc) => {
      acc[proc.role] = (acc[proc.role] ?? 0) + 1
      return acc
    }, {}),
    next: { at: now, cpuSecSum }
  }
}

/* -------------------------------------------------------------------------- */
/* CDP 客户端                                                                  */
/* -------------------------------------------------------------------------- */

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => (port === null ? reject(new Error('无法分配本机端口')) : resolve(port)))
    })
  })
}

/** 极简 CDP 客户端：一个 page target 一个 WebSocket，Runtime.evaluate(returnByValue)。 */
class CdpPage {
  constructor(ws, target) {
    this.ws = ws
    this.target = target
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`CDP ${JSON.stringify(message.error)}`))
      else entry.resolve(message.result ?? null)
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('CDP socket closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(debugBase, target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`无法连接 CDP target ${target.id}`)), { once: true })
      setTimeout(() => reject(new Error('CDP 连接超时')), 10_000)
    })
    return new CdpPage(ws, target)
  }

  async evaluate(expression, timeoutMs = 10_000) {
    if (this.closed) throw new Error('CDP tab 已关闭')
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP evaluate 超时：${expression.slice(0, 80)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: false }
        })
      )
    })
  }

  /** evaluate 并返回 result.value（异常/异常值返回 null；调用方自行判断）。 */
  async value(expression, timeoutMs = 10_000) {
    const result = await this.evaluate(expression, timeoutMs)
    if (result === null || result.exceptionDetails !== undefined) return null
    return result.result?.value ?? null
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/** 列出当前所有 page target；CDP 端点未就绪返回 null。 */
async function listPageTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) return null
    const list = await response.json()
    if (!Array.isArray(list)) return null
    return list.filter((target) => target && target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  } catch {
    return null
  }
}

/** 在多个 page target 里找「已 ready 的宠物 overlay」并连上（最多等到 timeoutMs）。 */
async function connectReadyPet(port, timeoutMs, onNote) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    const targets = await listPageTargets(port)
    for (const target of targets ?? []) {
      let page = null
      try {
        page = await CdpPage.connect(port, target)
        const probe = await page.value(
          `(() => {
            const d = window.__aventurineDebug
            if (!d) return { present: false }
            const stats = (() => { try { return d.stats() } catch (error) { return { error: String(error) } } })()
            return { present: true, ready: d.ready === true, loaded: d.model?.loaded === true, stats }
          })()`
        )
        if (probe?.present && probe.ready === true && probe.loaded === true) return { page, target, probe }
        lastError = 'renderer debug 面尚未 ready'
        page.close()
      } catch (error) {
        lastError = String(error)
        page?.close()
      }
    }
    await delay(500)
  }
  throw new Error(`等待 renderer ready 超时（${timeoutMs}ms）：${lastError ?? '无 CDP target'}`)
}

/* -------------------------------------------------------------------------- */
/* 环境采集                                                                    */
/* -------------------------------------------------------------------------- */

function collectEnvironment() {
  const electronVersion = readJsonIfExists(ELECTRON_PKG)?.version ?? null
  const swVers = runSync('sw_vers', [], { timeoutMs: 5_000 })
  const cpuBrand = runSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeoutMs: 5_000 }).stdout.trim()
  const displays = runSync('system_profiler', ['SPDisplaysDataType', '-detailLevel', 'mini'], { timeoutMs: 20_000 })
  const gpuLines = displays.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /Chipset Model|Type:|Cores|Vendor|Resolution|UI Looks like|Main Display|Online/.test(line))
  const appData = safeStat(path.join(ROOT, 'out/main/index.js'))
  const rendererIndex = safeStat(path.join(ROOT, 'out/renderer/index.html'))
  const srcMtimes = []
  const walkSource = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!/node_modules|\.git|tests\/tmp/.test(full)) walkSource(full)
      } else if (/\.(ts|tsx|css|html)$/.test(name)) {
        srcMtimes.push(stat.mtimeMs)
      }
    }
  }
  walkSource(path.join(ROOT, 'src'))
  const newestSrc = srcMtimes.length > 0 ? Math.max(...srcMtimes) : null
  const outMtime = appData?.mtimeMs ?? null
  const gitHead = runSync('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: 5_000 }).stdout.trim() || null
  const gitDirty = runSync('git', ['status', '--porcelain'], { timeoutMs: 10_000 })
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return {
    capturedAt: nowIso(),
    platform: `${platform()} ${arch()} (${release()})`,
    macosVersion: swVers.stdout.trim().replace(/\n/g, ' ') || null,
    cpu: cpuBrand || null,
    cpuCount: cpus().length,
    totalMemGb: num(totalmem() / 1024 ** 3, 1),
    displays: gpuLines,
    electronVersion,
    nodeVersion: process.version,
    out: {
      mainBuiltAt: appData?.mtimeMs ? new Date(appData.mtimeMs).toISOString() : null,
      rendererBuiltAt: rendererIndex?.mtimeMs ? new Date(rendererIndex.mtimeMs).toISOString() : null,
      newestSourceMtime: newestSrc === null ? null : new Date(newestSrc).toISOString(),
      stale: newestSrc !== null && outMtime !== null ? newestSrc > outMtime : null
    },
    git: { head: gitHead, dirtyFiles: gitDirty.length, dirtySample: gitDirty.slice(0, 12) }
  }
}

/* -------------------------------------------------------------------------- */
/* 准备：out/ + 隔离 profile                                                    */
/* -------------------------------------------------------------------------- */

function ensureOut(options, log) {
  const mainEntry = path.join(ROOT, 'out/main/index.js')
  const rendererIndex = path.join(ROOT, 'out/renderer/index.html')
  const hasOut = existsSync(mainEntry) && existsSync(rendererIndex)
  if (!hasOut && !options.build) {
    throw new Error(
      `生产构建缺失（${mainEntry} / ${rendererIndex}）。先跑 \`pnpm build\`，或加 --build 让脚本自动构建。`
    )
  }
  if (options.build || !hasOut) {
    const pnpm = findPnpm()
    if (pnpm === null) throw new Error('找不到 pnpm，无法构建；请先手动 pnpm build 或安装 pnpm 到 PATH')
    log(`[measure] 开始 pnpm build（--build 或 out/ 缺失；不改源码）…`)
    const started = Date.now()
    const result = spawnSync(pnpm, ['run', 'build'], { cwd: ROOT, stdio: 'inherit', env: process.env })
    const durationMs = Date.now() - started
    if (result.status !== 0) {
      throw new Error(`pnpm build 失败（exit=${result.status}，${durationMs}ms）；保留现有 out/ 以便用旧基线继续`)
    }
    log(`[measure] pnpm build 完成（${durationMs}ms）`)
    return { built: true, durationMs }
  }
  log('[measure] 使用现有 out/（不构建；基线口径 = 当前产物）')
  return { built: false, durationMs: 0 }
}

/** 由 PET_PROFILE 推导 dev userData 目录（macOS appData 走系统 home，不受 $HOME 影响）。 */
function profileUserDataDir(profile) {
  return path.join(APP_DATA_DIR, `aventurine-pet-${profile}`)
}

function prepareProfile(options, log) {
  const userData = profileUserDataDir(options.profile)
  if (options.cleanProfile) rmSync(userData, { recursive: true, force: true })
  ensureDir(userData)
  // fpsCap 预置：config-store 读取 {version, config}；缺失键由 sanitizeConfig 回填默认值。
  if (options.fpsCap !== null) {
    const payload = { version: 1, config: { fpsCap: options.fpsCap } }
    writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    log(`[measure] 预置 config.json fpsCap=${options.fpsCap} → ${path.join(userData, 'config.json')}`)
  }
  ensureDir(options.home)
  const dshDir = path.join(options.home, '.dsh', 'aventurine-pet')
  ensureDir(dshDir)
  return {
    userData,
    configPath: path.join(userData, 'config.json'),
    mainLogPath: path.join(userData, 'logs', 'main.log'),
    dshDir,
    configHashBefore: sha256File(path.join(userData, 'config.json'))
  }
}

/* -------------------------------------------------------------------------- */
/* 启动 / 关停                                                                  */
/* -------------------------------------------------------------------------- */

function buildLaunchEnv(options, profileInfo) {
  const env = {
    ...process.env,
    HOME: options.home,
    PET_PROFILE: options.profile,
    PET_DSH_DIR: profileInfo.dshDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    NO_COLOR: '1'
  }
  // 去掉会改变启动路径的变量（避免继承到 dev capture / smoke / electron-vite）。
  for (const key of Object.keys(env)) {
    if (
      key === 'ELECTRON_RUN_AS_NODE' ||
      key === 'ELECTRON_RENDERER_URL' ||
      key === 'PET_SMOKE_TEST' ||
      key.startsWith('PET_DEV_CAPTURE_')
    ) {
      delete env[key]
    }
  }
  return env
}

async function launchApp(options, profileInfo, log) {
  const port = await pickFreePort()
  const env = buildLaunchEnv(options, profileInfo)
  const startedAt = Date.now()
  const child = spawn(
    ELECTRON_BIN,
    [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', ROOT],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const appStdout = []
  const appStderr = []
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    appStdout.push(text)
    for (const line of text.split('\n')) if (line.trim() !== '') log(`[app] ${line.trim()}`)
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    appStderr.push(text)
    for (const line of text.split('\n')) if (line.trim() !== '') log(`[app-err] ${line.trim()}`)
  })
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }))
  })
  log(`[measure] Electron 已 spawn pid=${child.pid} remote-debugging-port=${port}（cwd=${ROOT}）`)

  // 等 CDP 端点出现，再等 renderer ready。
  let cdpReadyAt = null
  let connected = null
  try {
    const deadline = Date.now() + options.readyTimeoutMs
    while (Date.now() < deadline) {
      const targets = await listPageTargets(port)
      if (targets !== null && targets.length > 0) {
        cdpReadyAt = Date.now()
        break
      }
      if (child.exitCode !== null) throw new Error(`Electron 提前退出（code=${child.exitCode}）`)
      await delay(250)
    }
    if (cdpReadyAt === null) throw new Error(`等待 CDP target 超时（${options.readyTimeoutMs}ms）`)
    log(`[measure] CDP target 已出现（+${Date.now() - startedAt}ms），等待 renderer ready…`)
    connected = await connectReadyPet(port, options.readyTimeoutMs, log)
  } catch (error) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    throw error
  }
  const debugReadyAt = Date.now()
  log(
    `[measure] renderer ready（spawn→ready ${debugReadyAt - startedAt}ms；` +
      `stats fps=${connected.probe.stats?.fps ?? '?'} drawCalls=${connected.probe.stats?.drawCalls ?? '?'}）`
  )

  // 一次性静态度量（VRM/模型诊断），证明测的是真实 VRM 后端。
  const diagnostics = await connected.page.value(
    `(() => {
      const d = window.__aventurineDebug
      const pick = (value) => { try { return JSON.parse(JSON.stringify(value)) } catch { return null } }
      return {
        ready: d.ready === true,
        model: d.model ? pick(d.model) : null,
        vrm: d.vrm ? pick(d.vrm) : null,
        vrmDrivers: d.vrmDrivers ? pick(d.vrmDrivers) : null,
        animation: d.animation ? pick(d.animation) : null,
        geometryRefreshCount: d.geometryRefreshCount ?? null
      }
    })()`,
    15_000
  )

  return {
    child,
    port,
    startedAt,
    cdpReadyAt,
    debugReadyAt,
    page: connected.page,
    initialProbe: connected.probe,
    diagnostics,
    exit,
    appStdout,
    appStderr,
    knownPids: new Set([child.pid]),
    previousPs: null
  }
}

async function sampleOnce(state, options, phase, phaseElapsedMs, actionState) {
  const page = state.page
  let debug = null
  let debugError = null
  try {
    debug = await page.value(
      `(() => {
        const d = window.__aventurineDebug
        if (!d) return null
        let stats = null
        try { stats = d.stats() } catch (error) { stats = { error: String(error) } }
        return {
          ready: d.ready === true,
          loaded: d.model?.loaded === true,
          stats,
          activity: d.behavior?.activity ?? null,
          mood: d.behavior?.mood ?? null,
          errors: Array.isArray(d.errors) ? d.errors.slice(-3) : []
        }
      })()`
    )
  } catch (error) {
    debugError = String(error)
    // CDP 连接失效（窗口重建/关闭）时尝试重连一次。
    try {
      const targets = await listPageTargets(state.port)
      const target = (targets ?? []).find((candidate) => candidate.id === state.page.target.id) ?? (targets ?? [])[0]
      if (target) {
        state.page.close()
        state.page = await CdpPage.connect(state.port, target)
        debug = await state.page.value(
          `(() => {
            const d = window.__aventurineDebug
            if (!d) return null
            let stats = null
            try { stats = d.stats() } catch (error) { stats = { error: String(error) } }
            return { ready: d.ready === true, loaded: d.model?.loaded === true, stats, activity: d.behavior?.activity ?? null, mood: d.behavior?.mood ?? null, errors: Array.isArray(d.errors) ? d.errors.slice(-3) : [] }
          })()`
        )
        debugError = null
      }
    } catch (reconnectError) {
      debugError = `${debugError}; reconnect: ${String(reconnectError)}`
    }
  }

  const ps = sampleProcessTree(state.child.pid, state.previousPs)
  state.previousPs = ps.next
  for (const proc of ps.procs) state.knownPids.add(proc.pid)

  // action 阶段：按固定节拍轮换触发真实活动（不等 idle —— debugTriggerActivity 会接管当前活动；
  // 冷却/拖拽/反应/窗沿约束下返回 false，仅记录不报错）。一个节拍只尝试一个候选，轮换覆盖多种活动。
  let actionTrigger = null
  if (phase === 'action' && actionState !== null) {
    const now = Date.now()
    const due = now - actionState.lastAttemptAt >= Math.max(250, options.actionTriggerMs)
    if (due) {
      actionState.lastAttemptAt = now
      const activityId = ACTION_ROTATION[actionState.rotationIndex % ACTION_ROTATION.length]
      actionState.rotationIndex += 1
      let ok = false
      try {
        const value = await page.value(
          `(() => { try { return window.__aventurineDebug.debugTriggerActivity(${JSON.stringify(activityId)}) === true } catch (error) { return false } })()`
        )
        ok = value === true
      } catch {
        ok = false
      }
      const attempt = { tMs: now - state.debugReadyAt, activity: activityId, ok }
      actionState.attempts.push(attempt)
      if (ok) actionState.triggers.push(attempt)
      actionTrigger = ok ? activityId : null
    }
  }

  const load = loadavg()
  return {
    phase,
    elapsedMs: Math.round(phaseElapsedMs),
    tReadyMs: Date.now() - state.debugReadyAt,
    timestamp: nowIso(),
    ready: debug?.ready === true,
    loaded: debug?.loaded === true,
    fps: debug?.stats?.fps ?? null,
    drawCalls: debug?.stats?.drawCalls ?? null,
    triangles: debug?.stats?.triangles ?? null,
    petHeightPx: debug?.stats?.petHeightPx ?? null,
    petRect: debug?.stats?.petRect ?? null,
    displayId: debug?.stats?.displayId ?? null,
    isPrimaryDisplay: debug?.stats?.isPrimaryDisplay ?? null,
    outlinePx: debug?.stats?.outlinePx ?? null,
    activity: debug?.activity ?? null,
    mood: debug?.mood ?? null,
    debugErrors: debug?.errors ?? [],
    debugError,
    actionTrigger,
    process: {
      rssTotalMb: ps.rssTotalMb,
      rssMainMb: ps.rssMainMb,
      rssByRoleMb: ps.rssByRoleMb,
      cpuLifetimePctSum: ps.cpuLifetimePctSum,
      cpuIntervalPct: ps.cpuIntervalPct,
      processCount: ps.processCount,
      roles: ps.roles
    },
    loadavg1: num(load[0] ?? null)
  }
}

async function shutdownApp(state, options, log) {
  const child = state.child
  const pid = child.pid
  const started = Date.now()
  log(`[measure] 关停 Electron pid=${pid}（SIGTERM，最多等 ${options.shutdownTimeoutMs}ms）…`)
  if (child.exitCode === null) {
    try {
      child.kill('SIGTERM')
    } catch (error) {
      log(`[measure] SIGTERM 失败：${String(error)}`)
    }
  }
  const graceful = await Promise.race([state.exit, delay(options.shutdownTimeoutMs).then(() => null)])
  let forced = false
  if (graceful === null && child.exitCode === null) {
    forced = true
    log('[measure] SIGTERM 超时，升级 SIGKILL')
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    await Promise.race([state.exit, delay(5_000)])
  }
  // 兜底：清掉仍存活的 Electron 进程树成员（只 kill 本脚本 tracking 到的 pid）。
  const except = new Set([process.pid])
  let killed = 0
  for (const knownPid of state.knownPids) {
    if (knownPid === pid || except.has(knownPid)) continue
    try {
      const table = readProcessTable()
      if (table.has(knownPid)) {
        process.kill(knownPid, 'SIGKILL')
        killed += 1
      }
    } catch {
      /* 已退出 */
    }
  }
  const exit = await Promise.race([state.exit, delay(2_000).then(() => null)])
  const leftover = [...state.knownPids].filter((knownPid) => {
    try {
      return readProcessTable().has(knownPid)
    } catch {
      return false
    }
  })
  return {
    graceful: graceful !== null && !forced,
    forced,
    durationMs: Date.now() - started,
    exitCode: exit?.code ?? child.exitCode ?? null,
    signal: exit?.signal ?? child.signalCode ?? null,
    leftoverTrackedPids: leftover,
    killedLeftoverCount: killed
  }
}

/* -------------------------------------------------------------------------- */
/* 阶段执行                                                                    */
/* -------------------------------------------------------------------------- */

async function runPhase(state, options, log, phase, durationMs, onSample, actionState = null) {
  const startedAt = Date.now()
  const samples = []
  const deadline = startedAt + durationMs
  let index = 0
  while (Date.now() < deadline) {
    const elapsed = Date.now() - startedAt
    const sample = await sampleOnce(state, options, phase, elapsed, actionState)
    samples.push(sample)
    onSample?.(sample, index)
    index += 1
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const wait = Math.min(options.sampleMs, remaining)
    await delay(wait)
  }
  log(`[measure] phase=${phase} 完成：${samples.length} samples / ${durationMs}ms`)
  return samples
}

/* -------------------------------------------------------------------------- */
/* 分析 + 输出                                                                  */
/* -------------------------------------------------------------------------- */

function summarizePhase(samples, { discardMs = 0, capValue = null } = {}) {
  const kept = samples.filter(
    (sample) => sample.ready === true && sample.fps !== null && sample.elapsedMs >= discardMs
  )
  const fps = stats(kept.map((sample) => sample.fps))
  const drawCalls = stats(kept.map((sample) => sample.drawCalls))
  const triangles = stats(kept.map((sample) => sample.triangles))
  const rssTotal = stats(kept.map((sample) => sample.process.rssTotalMb))
  const rssMain = stats(kept.map((sample) => sample.process.rssMainMb))
  const rssRenderer = stats(kept.map((sample) => sample.process.rssByRoleMb?.renderer))
  const rssGpu = stats(kept.map((sample) => sample.process.rssByRoleMb?.gpu))
  const rssUtility = stats(kept.map((sample) => sample.process.rssByRoleMb?.utility))
  const cpuInterval = stats(kept.map((sample) => sample.process.cpuIntervalPct))
  const cpuLifetime = stats(kept.map((sample) => sample.process.cpuLifetimePctSum))
  const loadavg1 = stats(kept.map((sample) => sample.loadavg1))
  const activityHistogram = {}
  for (const sample of kept) {
    const key = sample.activity ?? '(null)'
    activityHistogram[key] = (activityHistogram[key] ?? 0) + 1
  }
  let capRelation = null
  if (capValue !== null && fps !== null) {
    const tolerance = 3
    capRelation = {
      fpsCap: capValue,
      idleMean: fps.mean,
      withinCap: fps.mean <= capValue + tolerance,
      nearCap: fps.mean >= Math.max(5, capValue - tolerance) && fps.mean <= capValue + tolerance,
      headroomBelowCap: num(capValue - fps.mean),
      ratioOfCap: num(fps.mean / capValue, 3)
    }
  }
  return {
    sampleCount: kept.length,
    discardedSamples: samples.length - kept.length,
    fps,
    drawCalls,
    triangles,
    rssTotalMb: rssTotal,
    rssMainMb: rssMain,
    rssRendererMb: rssRenderer,
    rssGpuMb: rssGpu,
    rssUtilityMb: rssUtility,
    cpuIntervalPct: cpuInterval,
    cpuLifetimePctSum: cpuLifetime,
    loadavg1,
    activityHistogram,
    capRelation
  }
}

function buildMarkdown(meta, environment, analysis) {
  const lines = []
  lines.push(`# Wave 3 V9 / A6 性能测量 — ${meta.label}`)
  lines.push('')
  lines.push(`- 生成时间：${meta.generatedAt}`)
  lines.push(`- 命令：\`${meta.command}\``)
  lines.push(`- 运行时长：idle ${meta.options.idleMs}ms（warmup ${meta.options.warmupMs}ms 不计入）+ action ${meta.options.actionMs}ms；采样间隔 ${meta.options.sampleMs}ms`)
  lines.push(`- 隔离：HOME=\`${meta.options.home}\`，PET_PROFILE=\`${meta.options.profile}\`，PET_DSH_DIR=\`${meta.profileInfo.dshDir}\``)
  lines.push(`- userData（appData 走系统 home，不受 $HOME 影响）：\`${meta.profileInfo.userData}\``)
  lines.push(`- 生产构建：out/main/index.js @ ${environment.out.mainBuiltAt ?? '?'}（stale=${String(environment.out.stale)}；不构建=${String(!meta.build?.built)}）`)
  lines.push(`- Electron ${environment.electronVersion} / ${environment.platform} / ${environment.cpu} (${environment.cpuCount} CPU, ${environment.totalMemGb} GB)`)
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push('| phase | samples | fps mean | fps p50 | fps p95 | fps min | fps max | drawCalls mean | triangles | RSS total mean(MB) | RSS main p50(MB) | RSS renderer mean(MB) | RSS gpu mean(MB) | CPU% (interval mean) | CPU% (lifetime sum mean) | loadavg1 mean |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const phase of ['idle', 'action']) {
    const summary = analysis.phases?.[phase]
    if (!summary) continue
    const fps = summary.fps ?? {}
    lines.push(
      `| ${phase} | ${summary.sampleCount} | ${fmt(fps.mean)} | ${fmt(fps.p50)} | ${fmt(fps.p95)} | ${fmt(fps.min)} | ${fmt(fps.max)} | ${fmt(summary.drawCalls?.mean)} | ${fmt(summary.triangles?.mean, 0)} | ${fmt(summary.rssTotalMb?.mean)} | ${fmt(summary.rssMainMb?.p50)} | ${fmt(summary.rssRendererMb?.mean)} | ${fmt(summary.rssGpuMb?.mean)} | ${fmt(summary.cpuIntervalPct?.mean)} | ${fmt(summary.cpuLifetimePctSum?.mean)} | ${fmt(summary.loadavg1?.mean)} |`
    )
  }
  lines.push('')
  lines.push('## fps 与 fpsCap 的关系')
  lines.push('')
  const idlePhase = analysis.phases?.idle ?? null
  if (idlePhase?.capRelation) {
    const relation = idlePhase.capRelation
    lines.push(
      `- 配置 fpsCap=${relation.fpsCap}；idle fps mean=${fmt(relation.idleMean)}（cap 的 ${fmt(relation.ratioOfCap, 3)}），` +
        `withinCap=${relation.withinCap}，nearCap(±3)=${relation.nearCap}。`
    )
    lines.push(`- 结论：${relation.withinCap ? '帧率被 fpsCap 有效钳制' : '实测 fps 明显高于 fpsCap（需排查 cap 是否生效）'}；` +
      `与显示器刷新率的关系：macOS 上 requestAnimationFrame 跟随刷新率，fpsCap 通过跳帧实现（见 src/renderer/src/scene/fps-limiter.ts）。`)
  } else {
    lines.push('- 未指定 --fps-cap，按配置默认值（见 config.json / DEFAULT_CONFIG.fpsCap=30）测量。')
  }
  lines.push('')
  lines.push('## 活动分布（采样快照）')
  lines.push('')
  for (const phase of ['idle', 'action']) {
    const summary = analysis.phases?.[phase]
    if (!summary) continue
    lines.push(`- ${phase}: ${JSON.stringify(summary.activityHistogram)}`)
  }
  if (meta.action.triggers.length > 0) {
    lines.push('')
    lines.push('## action 阶段触发记录')
    lines.push('')
    lines.push(`- 成功触发 ${meta.action.triggers.filter((trigger) => trigger.ok).length} 次（rotation: ${ACTION_ROTATION.join(', ')}）：`)
    lines.push('```json')
    lines.push(JSON.stringify(meta.action.triggers, null, 2))
    lines.push('```')
  }
  lines.push('')
  lines.push('## 静态诊断（证明测的是真实 VRM 场景）')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(meta.diagnostics, null, 2).slice(0, 4000))
  lines.push('```')
  lines.push('')
  lines.push('## 启动/关停')
  lines.push('')
  lines.push(`- spawn→CDP target：${fmt(meta.timing.cdpReadyMs, 0)}ms`)
  lines.push(`- spawn→renderer ready：${fmt(meta.timing.debugReadyMs, 0)}ms`)
  lines.push(`- 关停：graceful=${meta.shutdown.graceful} forced=${meta.shutdown.forced} duration=${fmt(meta.shutdown.durationMs, 0)}ms exitCode=${meta.shutdown.exitCode} leftoverTrackedPids=${JSON.stringify(meta.shutdown.leftoverTrackedPids)}`)
  lines.push('')
  lines.push('## 隔离校验')
  lines.push('')
  lines.push(`- 真实 \`~/.dsh/aventurine-pet\` 前后 hash 是否一致：${meta.isolation.realDshUntouched}（before=${meta.isolation.realDshHashBefore ?? 'missing'}，after=${meta.isolation.realDshHashAfter ?? 'missing'}）`)
  lines.push(`- 应用 stderr 尾部（含 \`sandbox_extension_issue_file_to_process\` 属 dev 未签名 Electron 的正常告警）：`)
  lines.push('```')
  lines.push((meta.appStderrTail ?? '').trim().split('\n').slice(-8).join('\n'))
  lines.push('```')
  lines.push('')
  lines.push('## 局限')
  lines.push('')
  lines.push('- 单机单次测量；与其它并行 worker/构建/测试共享机器，loadavg 已记录，跨轮比较需结合 loadavg。')
  lines.push('- 生产构建未打包（`electron .`，`app.isPackaged=false`）：userData 走 dev profile 隔离、网络 guard 未注册、登录项写入跳过；渲染/VRM/动画代码路径与打包版一致。')
  lines.push('- CDP 采样本身（每 1s 一次 evaluate）可能带来极小抖动；fps 统计来自 renderer 自身 1s 滑动窗口。')
  lines.push('- 透明窗口合成受 macOS WindowServer 影响，系统负载/其它全屏应用会改变结果。')
  lines.push('- action 阶段的「动作」是 `debugTriggerActivity()` 真实活动（走动/待机动作），不是 OS 级鼠标拖拽；拖拽物理另见 Wave 2 交互测试。')
  return lines.join('\n') + '\n'
}

function fmt(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return Number(value.toFixed(digits)).toString()
}

/* -------------------------------------------------------------------------- */
/* --check                                                                      */
/* -------------------------------------------------------------------------- */

function checkLatest(outDir) {
  const latestPath = path.join(outDir, 'latest.json')
  const latest = readJsonIfExists(latestPath)
  if (latest === null) {
    console.error(`[measure] --check：找不到 ${latestPath}`)
    return 2
  }
  const problems = []
  if (latest.ok !== true) problems.push('latest.ok !== true')
  const actionExpected = (latest.meta?.options?.actionMs ?? 0) > 0
  for (const phase of actionExpected ? ['idle', 'action'] : ['idle']) {
    const summary = latest.analysis?.phases?.[phase]
    if (!summary) {
      problems.push(`缺少 ${phase} 阶段分析`)
      continue
    }
    if (summary.sampleCount < 5) problems.push(`${phase} samples 太少（${summary.sampleCount}）`)
    if (summary.fps?.mean === null || summary.fps?.mean === undefined) problems.push(`${phase} fps 缺失`)
    if ((summary.drawCalls?.mean ?? 0) <= 0) problems.push(`${phase} drawCalls 非正`)
  }
  if (latest.shutdown?.leftoverTrackedPids?.length > 0) problems.push('存在未清理的 Electron 进程')
  if (problems.length > 0) {
    console.error(`[measure] --check FAIL：\n  ${problems.join('\n  ')}`)
    return 1
  }
  console.log(
    `[measure] --check OK：${latest.meta?.label} idle fps=${fmt(latest.analysis.phases.idle.fps.mean)} / action fps=${fmt(latest.analysis.phases.action?.fps?.mean)}（${latestPath}）`
  )
  return 0
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.check) return checkLatest(options.out)

  ensureDir(options.out)
  const log = (message) => console.log(message)
  const environment = collectEnvironment()
  log(
    `[measure] label=${options.label} idle=${options.idleMs}ms action=${options.actionMs}ms profile=${options.profile} fpsCap=${options.fpsCap ?? '(config default)'}`
  )
  log(
    `[measure] out/ built=${environment.out.mainBuiltAt ?? '?'} stale=${String(environment.out.stale)} ` +
      `git=${environment.git.head} dirty=${environment.git.dirtyFiles}`
  )

  const build = ensureOut(options, log)
  const profileInfo = prepareProfile(options, log)

  // 真实 DSH 桥目录快照（只读）：确认全程未被本脚本触碰。
  const realDshDir = path.join(REAL_HOME, '.dsh', 'aventurine-pet')
  const realDshHashBefore = dirHash(snapshotDir(realDshDir))

  let state = null
  const action = { triggers: [], attempts: [], lastAttemptAt: 0, rotationIndex: 0 }
  let warmupSamples = []
  let idleSamples = []
  let actionSamples = []
  let shutdown = null
  let failure = null
  const launchFacts = {
    timing: { cdpReadyMs: null, debugReadyMs: null },
    diagnostics: null,
    appStderrTail: null
  }
  const runDir = path.join(options.out, `${stamp()}-${options.label}`)
  ensureDir(runDir)

  try {
    state = await launchApp(options, profileInfo, log)
    launchFacts.timing = {
      cdpReadyMs: state.cdpReadyAt === null ? null : state.cdpReadyAt - state.startedAt,
      debugReadyMs: state.debugReadyAt - state.startedAt
    }
    launchFacts.diagnostics = state.diagnostics
    warmupSamples = await runPhase(state, options, log, 'warmup', options.warmupMs)
    idleSamples = await runPhase(state, options, log, 'idle', options.idleMs)
    if (!options.noAction && options.actionMs > 0) {
      action.lastAttemptAt = Date.now()
      actionSamples = await runPhase(state, options, log, 'action', options.actionMs, null, action)
    }
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log(`[measure] FAIL：${failure}`)
  } finally {
    if (state !== null) {
      // 先抓取 app 输出（关停后 child stdio 不再有数据）。
      const appStdout = state.appStdout.join('')
      const appStderr = state.appStderr.join('')
      launchFacts.appStderrTail = appStderr.slice(-8000)
      try {
        shutdown = await shutdownApp(state, options, log)
        if (!shutdown.graceful) log(`[measure] 注意：关停非 graceful（forced=${shutdown.forced}）`)
      } catch (shutdownError) {
        log(`[measure] 关停失败：${String(shutdownError)}`)
        try {
          state.child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      writeFileSync(path.join(runDir, 'app-stdout.log'), appStdout)
      writeFileSync(path.join(runDir, 'app-stderr.log'), appStderr)
      state = null
    }
  }

  // 主进程日志（若存在）：复制到结果目录（在关停之后，保证日志落盘完整）。
  if (existsSync(profileInfo.mainLogPath)) {
    try {
      writeFileSync(path.join(runDir, 'main.log'), readFileSync(profileInfo.mainLogPath))
    } catch (error) {
      log(`[measure] 复制 main.log 失败（可忽略）：${String(error)}`)
    }
  }

  const realDshHashAfter = dirHash(snapshotDir(realDshDir))
  const realDshUntouched = realDshHashBefore === realDshHashAfter
  if (!realDshUntouched) log('[measure] WARN 真实 ~/.dsh/aventurine-pet 在测量期间发生变化（可疑！）')

  const idleSummary = summarizePhase(idleSamples, { discardMs: 0, capValue: options.fpsCap })
  // 若未显式指定 fpsCap，按默认配置口径 30 计算关系（DEFAULT_CONFIG.fpsCap=30）。
  if (idleSummary.capRelation === null) {
    const idleMean = idleSummary.fps?.mean ?? null
    idleSummary.capRelation = {
      fpsCap: 30,
      idleMean,
      withinCap: idleMean === null ? null : idleMean <= 33,
      nearCap: idleMean === null ? null : idleMean >= 27 && idleMean <= 33,
      headroomBelowCap: idleMean === null ? null : num(30 - idleMean),
      ratioOfCap: idleMean === null ? null : num(idleMean / 30, 3),
      assumedDefault: true
    }
  }
  const actionSummary = actionSamples.length > 0 ? summarizePhase(actionSamples, { discardMs: 0 }) : null
  const analysis = {
    phases: { idle: idleSummary, action: actionSummary },
    warmupSamples: warmupSamples.length
  }

  const minIdleSamples = Math.max(5, Math.floor(options.idleMs / Math.max(options.sampleMs, 1) / 2))
  const ok =
    failure === null &&
    idleSummary.sampleCount >= minIdleSamples &&
    (idleSummary.drawCalls?.mean ?? 0) > 0 &&
    shutdown !== null &&
    (shutdown.leftoverTrackedPids ?? []).length === 0

  const meta = {
    label: options.label,
    generatedAt: nowIso(),
    command: `node scripts/vrm/measure-runtime.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    options: {
      idleMs: options.idleMs,
      actionMs: options.noAction ? 0 : options.actionMs,
      warmupMs: options.warmupMs,
      sampleMs: options.sampleMs,
      actionTriggerMs: options.actionTriggerMs,
      fpsCap: options.fpsCap,
      home: options.home,
      profile: options.profile,
      out: options.out,
      noAction: options.noAction,
      build: options.build
    },
    build,
    profileInfo: {
      userData: profileInfo.userData,
      configPath: profileInfo.configPath,
      mainLogPath: profileInfo.mainLogPath,
      dshDir: profileInfo.dshDir,
      configHashBefore: profileInfo.configHashBefore,
      configHashAfter: sha256File(profileInfo.configPath)
    },
    environment,
    timing: launchFacts.timing,
    diagnostics: launchFacts.diagnostics,
    action: { rotation: ACTION_ROTATION, triggers: action.triggers, attempts: action.attempts },
    shutdown,
    isolation: {
      realDshDir,
      realDshHashBefore,
      realDshHashAfter,
      realDshUntouched
    },
    ok,
    failure,
    appStderrTail: launchFacts.appStderrTail
  }

  const result = {
    ok,
    meta,
    analysis,
    samples: { warmup: warmupSamples, idle: idleSamples, action: actionSamples }
  }

  const runJson = path.join(runDir, 'run.json')
  writeFileSync(runJson, JSON.stringify(result, null, 2))
  writeFileSync(path.join(runDir, 'summary.md'), buildMarkdown(meta, environment, analysis))
  writeFileSync(path.join(runDir, 'environment.json'), JSON.stringify(environment, null, 2))
  // 主采样 CSV，便于二次分析。
  const csvLines = [
    'phase,elapsedMs,fps,drawCalls,triangles,activity,rssTotalMb,rssMainMb,cpuIntervalPct,cpuLifetimePctSum,loadavg1'
  ]
  for (const sample of [...idleSamples, ...actionSamples]) {
    csvLines.push(
      [
        sample.phase,
        sample.elapsedMs,
        sample.fps ?? '',
        sample.drawCalls ?? '',
        sample.triangles ?? '',
        sample.activity ?? '',
        sample.process.rssTotalMb ?? '',
        sample.process.rssMainMb ?? '',
        sample.process.cpuIntervalPct ?? '',
        sample.process.cpuLifetimePctSum ?? '',
        sample.loadavg1 ?? ''
      ].join(',')
    )
  }
  writeFileSync(path.join(runDir, 'samples.csv'), csvLines.join('\n') + '\n')
  writeFileSync(path.join(options.out, 'latest.json'), JSON.stringify(result, null, 2))
  writeFileSync(path.join(options.out, 'latest.md'), buildMarkdown(meta, environment, analysis))

  // 清理隔离 profile（默认清理；--keep-profile 保留以便排查）。
  if (!options.keepProfile && options.cleanProfile) {
    try {
      rmSync(profileInfo.userData, { recursive: true, force: true })
    } catch (error) {
      log(`[measure] 清理 userData 失败（可忽略）：${String(error)}`)
    }
  }

  log('')
  log(`[measure] 结果目录：${runDir}`)
  log(
    `[measure] idle: fps mean=${fmt(idleSummary.fps?.mean)} p95=${fmt(idleSummary.fps?.p95)} ` +
      `drawCalls=${fmt(idleSummary.drawCalls?.mean)} RSS=${fmt(idleSummary.rssTotalMb?.mean)}MB ` +
      `CPU(interval)=${fmt(idleSummary.cpuIntervalPct?.mean)}%`
  )
  if (actionSummary !== null) {
    log(
      `[measure] action: fps mean=${fmt(actionSummary.fps?.mean)} drawCalls=${fmt(actionSummary.drawCalls?.mean)} ` +
        `RSS=${fmt(actionSummary.rssTotalMb?.mean)}MB CPU(interval)=${fmt(actionSummary.cpuIntervalPct?.mean)}% ` +
        `triggers=${action.triggers.filter((trigger) => trigger.ok).length}`
    )
  }
  log(
    `[measure] 启动 spawn→ready=${fmt(meta.timing?.debugReadyMs, 0)}ms；` +
      `关停 graceful=${shutdown?.graceful} forced=${shutdown?.forced}；真实 ~/.dsh 未触碰=${realDshUntouched}`
  )
  log(`[measure] ${ok ? 'PASS' : 'FAIL'}（${failure ?? 'ok'}）`)
  return ok ? 0 : 1
}

const exitCode = await main()
process.exitCode = exitCode
