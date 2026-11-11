#!/usr/bin/env node
/**
 * 桌宠 ⇄ DSH 桥契约 canary（A+ 加固 + Wave 3 v2）。
 *
 * 目的：把「DSH 更新后桥还能不能抓到正确的事件/文本」从"靠人工看源码"变成一条能跑的检查。
 * 做法（全部在临时目录里，不碰真实 `~/.dsh`；`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 保证不会
 * 真的拉起桌宠）：
 *   1. 用**临时 DSH_HOME** 初始化一个 headless 模板 profile；
 *   2. 把当前仓库的 `bridge/dsh-aventurine-bridge` 以本地路径安装进该 profile
 *      —— 这一步同时验证 `engines.dsh` 版本护栏与 bundle patch 安装格式；
 *   3. `--dump-config` 确认桥插件行确实组合进了配置树；
 *   4. **失败回合**：故意让模型请求失败（指向本机一个已关闭端口 + 占位 API key，不产生真实
 *      调用/费用），驱动 DSH 跑一个真实失败回合；断言 `status.json` / `events.jsonl`：
 *      `task/start → task/error → task/end` 顺序、payload 关键字段、`offline:true` 退出帧；
 *   5. **成功回合（v2，离线 mock）**：canary 在本机 127.0.0.1 起一个临时 Anthropic-Messages
 *      SSE mock 服务（thinking + text，stop_reason=end_turn），把 `DEEPSEEK_BASE_URL` 指向它，
 *      驱动一个真实成功的 agent 回合；断言 `events.jsonl` 出现**带非空 `text` 的
 *      `assistant/message`**（`session/event`）且与 mock 注入文本一致、成功回合无 `task/error`；
 *      同时断言 user 输入 / reasoning 哨兵**没有**落盘（隐私白名单）；
 *   6. 两个回合都轮询 `control.json`，断言观察到 `attached → detached` 生命周期（+最终帧 detached）。
 *
 * 7. **v4 兼容性安全（--compat 组，2026-11-11）**：全部在临时 DSH_HOME / 临时桥目录里验证
 *    「绝对路径 insert + live 副本 package.json」这一**真实部署形态**下的宿主失败隔离与兼容握手：
 *      C1 bundle 安装被拒（engines 不兼容 → dsh plugin add 拒绝）；C2 绝对路径 insert + 不兼容
 *      engines（现网形态）→ 宿主仍能完成启动/跑回合、stderr 含 disabling profile plugin/engines.dsh、
 *      桥零产物；C3 同形态但 engines 兼容 → control attached + bridgeVersion=4 + compat.dshRange、
 *      status 心跳带同一 compat；C4 import 抛错插件 → 宿主启动 + `did not activate`；C5 apply
 *      抛错插件 → 同上；C6 桥 apply 失败（不可写桥目录 + env 回退目录）→ 宿主正常 + bridge-error.json。
 *
 * 退出码：0 = PASS；1 = FAIL；2 = SKIP（找不到 DSH CLI）。
 *
 * 用法：
 *   pnpm dsh:canary                    # 默认：离线失败回合 + 本地 mock 成功回合（无外网/费用，~40s）
 *   pnpm dsh:canary --compat           # 默认组 + v4 兼容性/安装形态组（C1–C6，~1-2 分钟）
 *   pnpm dsh:canary --only-compat      # 只跑 --compat 组（跳过既有事件/文本契约组）
 *   pnpm dsh:canary --keep             # 失败时保留临时目录便于排查（含 mock 请求记录）
 *   pnpm dsh:canary --dsh <dsh路径>    # 指定 DSH CLI（默认找 macOS 桌面版内置 CLI，再找 PATH）
 *   pnpm dsh:canary --online           # 成功回合改用真实模型（需环境变量 DEEPSEEK_API_KEY）
 *
 * 注意：canary 只验证「桥对 DSH 事件/文本的映射」。DSH 跨 minor 更新且 `engines.dsh` 不匹配时，
 * 安装步骤会被 DSH 插件管理器明确拒绝——这本身就是护栏生效，按桥 README 的升级流程处理。
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BRIDGE_CONTROL_FILE,
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_DIAGNOSTIC_FILE,
  BRIDGE_DISABLE_LAUNCH_ENV,
  BRIDGE_PLUGIN_VERSION,
  DSH_EVENT_TEXT_MAX_CHARS,
  DSH_EVENT_TYPES
} from '../bridge/dsh-aventurine-bridge/lib/constants.js'
import {
  parseControlFile,
  validateCanaryArtifacts,
  validateCompatControlFrames,
  validateCompatStatus,
  validateControlArtifacts,
  validateDiagnostic
} from './dsh-canary-lib.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(SCRIPT_DIR)
const BRIDGE_DIR = join(REPO_ROOT, 'bridge', 'dsh-aventurine-bridge')
const BRIDGE_PACKAGE = join(BRIDGE_DIR, 'package.json')

/** macOS DeepSeek Harness 桌面版内置 CLI（与 `dsh web` 同一个启动器）。 */
const MAC_DSH_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** canary 专用 profile 名（只存在于临时 DSH_HOME 中）。 */
const PROFILE = 'pet-canary'

/** 失败回合的任务文本（无需工具调用，只触发一次模型请求）。 */
const FAIL_TASK = 'canary-fail-sentinel: reply with the single word OK'

/** 成功回合的任务文本（离线 mock 模式下会额外断言它没有落盘）。 */
const SUCCESS_TASK = 'canary-success-sentinel: reply with the single word OK'

/** mock LLM 注入的 assistant 输出文本：成功回合必须原样出现在 payload.text 里。 */
const MOCK_ASSISTANT_TEXT = 'canary-mock: 桥文本透传 OK。'

/** mock LLM 注入的 reasoning 文本：隐私断言要求它不得出现在 events.jsonl。 */
const MOCK_REASONING_TEXT = 'canary-mock-reasoning-sentinel: 不应落盘的思考正文'

/** spawnSync 输出上限（--dump-config 可能几百 KB）。 */
const MAX_BUFFER = 64 * 1024 * 1024

/** 失败回合/成功回合轮询 control.json 的周期（毫秒）。 */
const CONTROL_POLL_MS = 100

/** 异步 runTurn 捕获的 stdout/stderr 上限（字节字符）。 */
const MAX_CAPTURE_CHARS = 200 * 1024

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_SKIP = 2

const HELP = `桌宠 DSH 桥 canary（Wave 3 v2 + v4 兼容性安全）

用法:
  node scripts/dsh-canary.mjs [选项]

选项:
  --dsh <path>      指定 DSH CLI 路径（默认: $DSH_CLI → macOS 桌面版内置 CLI → PATH 中的 dsh）
  --compat          追加「v4 兼容性/安装形态」组 C1–C6（真实 insert + live 副本形态；~1-2 分钟）
  --only-compat     只跑 --compat 组（跳过既有事件/文本契约组）
  --keep            保留临时目录（打印路径；含 mock 请求记录，排查失败用）
  --online          成功回合改用真实模型（需环境变量 DEEPSEEK_API_KEY；默认用本地 mock，无费用）
  --timeout <sec>   单次 DSH 运行超时秒数（默认: 离线 180 / 在线 300）
  -h, --help        显示帮助

退出码: 0=PASS 1=FAIL 2=SKIP（找不到 DSH CLI）

--compat 组（全部临时 DSH_HOME/临时桥目录，绝不碰真实 ~/.dsh；C1–C6 见 script 头注释）：
  C1 bundle 安装被拒（engines 不兼容）       C2 绝对路径 insert + 不兼容 engines（现网形态）
  C3 绝对路径 insert + 兼容 engines（v4）    C4 import 抛错插件
  C5 apply 抛错插件                          C6 桥 apply 失败隔离（不可写目录 → bridge-error.json）
`

/** 解析命令行参数（未知参数直接报错，避免静默跑错模式）。 */
function parseArgs(argv) {
  const options = {
    dsh: null,
    keep: false,
    online: false,
    compat: false,
    onlyCompat: false,
    timeout: null,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') options.keep = true
    else if (arg === '--online') options.online = true
    else if (arg === '--compat') options.compat = true
    else if (arg === '--only-compat') {
      options.compat = true
      options.onlyCompat = true
    } else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dsh') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error('--dsh 需要一个路径参数')
      options.dsh = value
      index += 1
    } else if (arg === '--timeout') {
      const value = Number(argv[index + 1])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--timeout 需要一个正数（秒）')
      options.timeout = value
      index += 1
    } else {
      throw new Error(`未知参数：${arg}（--help 查看用法）`)
    }
  }
  return options
}

/** 在 PATH 中查找可执行文件（canary 不引入第三方依赖，自己实现最小版本）。 */
function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 继续找下一个目录。
    }
  }
  return null
}

/** 解析 DSH CLI 路径：显式参数优先，其次 $DSH_CLI，再 macOS 桌面版，最后 PATH。 */
function resolveDshCli() {
  const candidates = [process.env.DSH_CLI, MAC_DSH_CLI, findOnPath('dsh')]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return null
}

/** 起一个临时 TCP server 拿到本机空闲端口后立即关闭——得到一个「必然拒绝连接」的地址。 */
async function pickClosedPort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise((resolve) => server.close(resolve))
  if (port === null) throw new Error('无法分配本机端口')
  return port
}

/** 运行一次 DSH CLI 子进程（同步；仅用于 --version/初始化/安装/--dump-config 等短命令）。 */
function runDsh(cli, args, { env, cwd, timeoutMs, label }) {
  const result = spawnSync(cli, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error !== undefined) {
    const reason = result.error.code === 'ETIMEDOUT' ? `超时（>${Math.round(timeoutMs / 1000)}s）` : result.error.message
    return { status: null, stdout, stderr, timedOut: result.error.code === 'ETIMEDOUT', failure: `${label} 执行失败：${reason}` }
  }
  return { status: result.status, stdout, stderr, timedOut: false, failure: null }
}

/**
 * 异步运行一次 DSH 回合，并在运行期间每 100ms 轮询桥的 control.json / status.json：
 * 记录 attach/detach 转换、完整 control 帧（v4 compat 断言用）与 status 在线心跳样本。
 *
 * 用异步 spawn（而非 spawnSync）是为了在回合运行期间观察这两个文件 —— 才能断言
 * `attached → detached` 的完整生命周期与心跳；回合结束后再补读一次，避免漏掉退出瞬间的帧。
 *
 * @param {{
 *   cli: string, profile: string, task: string,
 *   env: Record<string, string | undefined>, cwd: string,
 *   timeoutMs: number, bridgeDir: string, label: string
 * }} options
 * @returns {Promise<{
 *   code: number | null, signal: string | null, stdout: string, stderr: string,
 *   timedOut: boolean, spawnError: string | null,
 *   observedActions: string[], controlFrames: Array<Record<string, unknown>>,
 *   statusOnlineSamples: number[], durationMs: number
 * }>}
 */
function runTurn({ cli, profile, task, env, cwd, timeoutMs, bridgeDir, label }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    /** 观察到的 control action 序列（按 action+ts 去重，只关心状态转换）。 */
    const observedActions = []
    /** 观察到的完整 control 帧（v4 compat 断言用；按 action+ts 去重）。 */
    const controlFrames = []
    /** 观察到的 status 在线心跳时间戳（离线帧不计；去重）。 */
    const statusOnlineSamples = []
    let lastStatusKey = null
    let lastControlKey = null
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError = null
    let settled = false
    let killEscalation = null

    const child = spawn(cli, ['--profile', profile, task], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const appendCapped = (current, chunk) =>
      current.length >= MAX_CAPTURE_CHARS ? current : (current + chunk).slice(0, MAX_CAPTURE_CHARS)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout = appendCapped(stdout, String(chunk))
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr = appendCapped(stderr, String(chunk))
    })

    /** 读一次 control.json；只在 action+ts 变化时记录，容忍半截/脏文件。 */
    const recordControl = () => {
      let raw
      try {
        raw = readFileSync(join(bridgeDir, BRIDGE_CONTROL_FILE), 'utf8')
      } catch {
        return
      }
      const parsed = parseControlFile(raw)
      if (!parsed.ok) return
      const action = parsed.control.action
      const key = `${action}:${parsed.control.ts}`
      if (key === lastControlKey) return
      lastControlKey = key
      observedActions.push(action)
      controlFrames.push(parsed.control)
    }

    /** 读一次 status.json：记录"在线心跳"样本（offline 帧不计），用于 C3 断言桥在跑。 */
    const recordStatus = () => {
      let raw
      try {
        raw = readFileSync(join(bridgeDir, 'status.json'), 'utf8')
      } catch {
        return
      }
      let frame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
      if (frame.offline === true) return
      if (typeof frame.ts !== 'number' || !Number.isFinite(frame.ts)) return
      const key = `${frame.ts}`
      if (key === lastStatusKey) return
      lastStatusKey = key
      statusOnlineSamples.push(frame.ts)
    }

    const pollTimer = setInterval(() => {
      recordControl()
      recordStatus()
    }, CONTROL_POLL_MS)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // 忽略：进程可能已退出。
      }
      killEscalation = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略：进程可能已退出。
        }
      }, 5000)
      if (typeof killEscalation.unref === 'function') killEscalation.unref()
    }, timeoutMs)

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearInterval(pollTimer)
      clearTimeout(timeoutTimer)
      if (killEscalation !== null) clearTimeout(killEscalation)
      // 退出后再读一次：disposer 的 detached 帧可能落在最后一次轮询之后。
      recordControl()
      recordStatus()
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        spawnError,
        observedActions,
        controlFrames,
        statusOnlineSamples,
        durationMs: Date.now() - startedAt
      })
    }

    child.on('error', (error) => {
      spawnError = `${label} 子进程启动失败：${error instanceof Error ? error.message : String(error)}`
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** 截断子进程输出，失败时打印用（保留头尾，中间省略）。 */
function excerpt(text, maxBytes = 4000) {
  if (typeof text !== 'string' || text === '') return '(空)'
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text.trimEnd()
  const half = Math.floor(maxBytes / 2)
  return `${buffer.subarray(0, half).toString('utf8')}\n…（省略 ${buffer.byteLength - half * 2} 字节）…\n${buffer.subarray(buffer.byteLength - half).toString('utf8')}`
}

/** 真实 ~/.dsh 桥目录快照：canary 必须不写它（环境变量已把桥目录指到临时目录）。 */
function snapshotRealBridgeDir() {
  const dir = join(homedir(), '.dsh', 'aventurine-pet')
  /** @type {Record<string, string>} */
  const snapshot = {}
  for (const name of ['status.json', 'events.jsonl', 'events.jsonl.1', BRIDGE_CONTROL_FILE]) {
    try {
      const stats = statSync(join(dir, name))
      snapshot[name] = `${stats.size}:${stats.mtimeMs}`
    } catch {
      snapshot[name] = 'missing'
    }
  }
  return snapshot
}

/** 读取桥产物（不存在返回 null，便于给出明确错误而不是 ENOENT 栈）。 */
function readArtifact(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * 启动本地 mock Anthropic-Messages 服务（离线成功回合用）。
 *
 * 协议与 R2 审计（docs/research/dsh-harness-audit-2026-11-11.md 附录 A）一致：
 * `POST /v1/messages` 返回 `text/event-stream`，事件序列
 * `message_start → content_block_start(thinking) → thinking_delta → content_block_stop
 *  → content_block_start(text) → text_delta ×2 → content_block_stop
 *  → message_delta(stop_reason=end_turn) → message_stop`。
 * 主回合与 session title 请求都返回同样的文本（title 请求不进 agent 流，不影响断言）。
 *
 * @param {{ assistantText: string, reasoningText: string }} options
 * @returns {Promise<{ port: number, requests: Array<Record<string, unknown>>, close: () => Promise<void> }>}
 */
async function startMockLlm({ assistantText, reasoningText }) {
  /** @type {Array<Record<string, unknown>>} */
  const requests = []

  const sendSse = (res, events) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-request-id': 'req-canary-mock'
    })
    for (const event of events) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    res.end()
  }

  const server = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        // 非 JSON 请求体按空对象处理（DSH 不会这么发；防御 mock 自身不炸）。
      }
      const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : []
      requests.push({ url: req.url, method: req.method, tools: tools.length, stream: body.stream === true })
      if (req.method !== 'POST') {
        // 兜底：非 Messages 的 GET（如 /models 探测）返回空模型列表，避免请求挂住。
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      const head = assistantText.slice(0, 10)
      const tail = assistantText.slice(10)
      sendSse(res, [
        {
          type: 'message_start',
          message: {
            id: 'msg_canary_mock',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 }
          }
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: reasoningText } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: head } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: tail } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
        { type: 'message_stop' }
      ])
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  if (port === null) throw new Error('mock LLM 无法分配本机端口')
  return {
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/* ===========================================================================
 * v4 兼容性/安装形态组（--compat，计划 §5.1 / 评审 E1/E13）：C1–C6
 *
 * 全部在临时 DSH_HOME / 临时桥目录 / 临时 live 副本里运行，绝不碰真实 ~/.dsh；
 * 每个 case 用独立临时 profile，回合统一指向「已关闭端口 + 占位 key」的失败回合
 * （无外网/费用；只要宿主能跑到 turn 失败就说明启动/插件隔离路径正常）。
 * ========================================================================= */

/** 不兼容 engines 的构造值（远高于当前 DSH 版本 → 闸门必然拒绝）。 */
const INCOMPATIBLE_DSH_RANGE = '>=99.0.0 <100.0.0'

/** canary C6 用的不可写目录权限位（chmod；恢复用 0o700）。 */
const READONLY_DIR_MODE = 0o555

/** 可写目录恢复权限位。 */
const WRITABLE_DIR_MODE = 0o700

/**
 * 复制桥 lib/ 到临时目录并写一份带 engines 的 live-copy 风格 package.json。
 * （canary 不写仓库 work/live-bridge；这与激活脚本生成的真实部署形态一致。）
 *
 * @param {{ sourceDir: string, destDir: string, engines: string }} input
 * @returns {{ dir: string, entry: string }}
 */
function createCanaryLiveBridge({ sourceDir, destDir, engines }) {
  mkdirSync(destDir, { recursive: true })
  cpSync(join(sourceDir, 'lib'), join(destDir, 'lib'), { recursive: true })
  const sourceManifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'))
  const manifest = {
    name: typeof sourceManifest.name === 'string' ? sourceManifest.name : 'dsh-aventurine-bridge',
    version: typeof sourceManifest.version === 'string' ? sourceManifest.version : '0.0.0',
    private: true,
    type: 'module',
    main: './lib/index.js',
    engines: { ...(typeof sourceManifest.engines === 'object' ? sourceManifest.engines : {}), dsh: engines }
  }
  writeFileSync(join(destDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { dir: destDir, entry: join(destDir, 'lib', 'index.js') }
}

/** 从 live 副本 constants.js 读 BRIDGE_PLUGIN_VERSION（读不到 → null；用于条件严格断言）。 */
function readLiveBridgeVersion(entry) {
  try {
    const text = readFileSync(join(dirname(entry), 'constants.js'), 'utf8')
    const match = /BRIDGE_PLUGIN_VERSION\s*=\s*(\d+)/.exec(text)
    return match ? Number.parseInt(match[1], 10) : null
  } catch {
    return null
  }
}

/** 写临时 profile 的 cordis.patch.yml（父目录已由 profile 初始化创建）。 */
function writeCanaryProfilePatch(dshHome, profile, patchText) {
  const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  writeFileSync(patchPath, patchText.endsWith('\n') ? patchText : `${patchText}\n`, 'utf8')
  return patchPath
}

/** 构造插入临时插件入口的 patch（canary 的"绝对路径 insert"形态）。 */
function buildCanaryInsertPatch({ entry, rowId = 'aventurine-bridge', bridgeDir = null }) {
  const lines = ['- insert:', `    - id: ${rowId}`, `      name: ${JSON.stringify(entry)}`]
  if (typeof bridgeDir === 'string' && bridgeDir !== '') {
    lines.push(`      config:`, `        dir: ${JSON.stringify(bridgeDir)}`, '        launchPet: false')
  }
  return `${lines.join('\n')}\n`
}

/** 临时 fixture 插件目录（C4 import 抛错 / C5 apply 抛错）。 */
function createCanaryFixturePlugin({ dir, name, indexSource }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', main: './index.js' }, null, 2)}\n`,
    'utf8'
  )
  writeFileSync(join(dir, 'index.js'), indexSource, 'utf8')
  return { dir, entry: join(dir, 'index.js') }
}

/** 初始化一个临时 profile（headless 模板 + --dump-config）；失败返回错误串。 */
function initCanaryProfile({ cli, env, cwd, profile, label }) {
  const result = runDsh(
    cli,
    ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'],
    { env, cwd, timeoutMs: 120_000, label }
  )
  if (result.status !== 0) {
    return `初始化临时 profile ${profile} 失败：${excerpt(result.stderr || result.stdout)}`
  }
  return null
}

/** 扫出输出里的宿主级未捕获异常/fatal 迹象（C2/C4/C5/C6 的隔离断言）。 */
function findUncaughtFailure(text) {
  if (typeof text !== 'string' || text === '') return null
  const patterns = [
    /uncaughtException/i,
    /unhandledRejection/i,
    /UnhandledPromiseRejection/i,
    /\bFATAL ERROR\b/i,
    /fatal error:/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return null
}

/**
 * 运行 --compat 组（C1–C6），把失败追加到共享 failures。
 *
 * @param {{
 *   cli: string,
 *   baseEnv: Record<string, string | undefined>,
 *   tempRoot: string,
 *   workDir: string,
 *   failures: string[],
 *   fail: (message: string) => void,
 *   step: (message: string) => void,
 *   timeoutMs: number,
 *   bridgeManifest: Record<string, unknown>
 * }} context
 */
async function runCompatGroup(context) {
  const { cli, baseEnv, tempRoot, workDir, fail, step, timeoutMs, bridgeManifest } = context
  const compatRoot = join(tempRoot, 'compat')
  mkdirSync(compatRoot, { recursive: true })
  const dshHome = baseEnv.DSH_HOME
  const enginesOk = typeof bridgeManifest?.engines?.dsh === 'string' ? bridgeManifest.engines.dsh : null
  if (enginesOk === null) {
    fail('C1–C6 前置失败：桥源包 package.json 缺少 engines.dsh（无法构造兼容/不兼容形态）')
    return
  }
  const bridgeVersionSource = BRIDGE_PLUGIN_VERSION
  const strictV4 = bridgeVersionSource >= 4
  step(`compat 组：DSH CLI ${cli}；桥包 version=${JSON.stringify(bridgeManifest?.version ?? null)} engines.dsh=${JSON.stringify(enginesOk)}；桥源码 v${bridgeVersionSource}`)
  if (!strictV4) {
    step('compat 组：WARN 桥源码仍 < v4，C3 compat / C6 bridge-error 断言降级为 WARN（等桥 v4 后自动严格）')
  }

  const closedPort = await pickClosedPort()
  /** 失败回合 env：指向必然拒绝连接的本机端口（不产生真实模型调用/费用）。 */
  const failureEnv = {
    ...baseEnv,
    DEEPSEEK_API_KEY: 'dsh-canary-invalid-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${closedPort}`
  }

  /**
   * 断言"宿主正常跑到回合失败"：退出码 1、stderr 有 transport failed、无未捕获异常。
   * @returns {boolean}
   */
  const assertHostReachedTurnFailure = (run, label) => {
    let ok = true
    if (run.spawnError !== null) {
      fail(`${label} 子进程启动失败：${run.spawnError}`)
      return false
    }
    if (run.timedOut) {
      fail(`${label} 超时（>${Math.round(timeoutMs / 1000)}s）：宿主可能挂住`)
      return false
    }
    if (run.code !== 1) {
      fail(`${label} 退出码 ${JSON.stringify(run.code)}，期望 1（宿主正常但回合失败）；stderr: ${excerpt(run.stderr)}`)
      ok = false
    }
    if (!/transport failed|TRANSPORT[:\s]/i.test(run.stderr)) {
      fail(`${label} stderr 未出现模型传输失败（无法证明宿主完成启动并跑到 turn）；stderr: ${excerpt(run.stderr)}`)
      ok = false
    }
    const uncaught = findUncaughtFailure(`${run.stdout}\n${run.stderr}`)
    if (uncaught !== null) {
      fail(`${label} 输出出现宿主级未捕获异常/fatal（${uncaught}）——插件绝不能伤宿主`)
      ok = false
    }
    return ok
  }

  /** 每轮跑完打印原始 stderr 摘要（排查失败用）。 */
  const logRunSummary = (run) => {
    const firstLines = (run.stderr ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('    at '))
      .slice(0, 8)
    for (const line of firstLines) step(`  stderr│ ${line}`)
  }

  /** 通用：初始化 profile（返回 profile 名或 null）。 */
  const prepareProfile = (profile, label) => {
    const error = initCanaryProfile({ cli, env: { ...baseEnv }, cwd: workDir, profile, label })
    if (error !== null) {
      fail(error)
      return false
    }
    return true
  }

  /* ------------------------------- C1 ------------------------------- */
  step('C1/6 bundle 安装被拒（engines.dsh 不兼容 → dsh plugin add 必须拒绝）…')
  try {
    const badBundleDir = join(compatRoot, 'c1-bad-bundle')
    cpSync(BRIDGE_DIR, badBundleDir, { recursive: true })
    const badManifestPath = join(badBundleDir, 'package.json')
    const badManifest = JSON.parse(readFileSync(badManifestPath, 'utf8'))
    badManifest.engines = { ...(typeof badManifest.engines === 'object' ? badManifest.engines : {}), dsh: INCOMPATIBLE_DSH_RANGE }
    writeFileSync(badManifestPath, `${JSON.stringify(badManifest, null, 2)}\n`, 'utf8')
    const profile = 'pet-compat-c1'
    if (prepareProfile(profile, 'C1 初始化 profile')) {
      const result = runDsh(cli, ['plugin', '--profile', profile, 'add', '-w', badBundleDir], {
        env: { ...baseEnv },
        cwd: workDir,
        timeoutMs: 120_000,
        label: 'C1 dsh plugin add'
      })
      const output = `${result.stderr}\n${result.stdout}`
      if (result.status === 0) {
        fail('C1 FAIL：engines.dsh 不兼容的 bundle 居然安装成功（版本护栏失效）')
      } else if (!/installation rejected/i.test(output)) {
        fail(`C1 FAIL：安装被拒原因不是版本护栏（缺少 "installation rejected" 文案）：${excerpt(output)}`)
      } else if (!/incompatible/i.test(output)) {
        fail(`C1 FAIL：拒绝文案缺少 "incompatible"：${excerpt(output)}`)
      } else if (!/engines\.dsh|requirements/i.test(output)) {
        fail(`C1 FAIL：拒绝文案缺少 "engines.dsh"/"requirements"：${excerpt(output)}`)
      } else {
        step('C1 PASS：bundle 安装被 DSH 版本闸门拒绝（installation rejected + incompatible + engines.dsh）')
      }
    }
  } catch (error) {
    fail(`C1 构造/执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }

  /* ------------------------------- C2 ------------------------------- */
  step('C2/6 绝对路径 insert + 不兼容 engines（现网形态）→ 宿主仍完成启动/回合、桥零产物…')
  try {
    const c2Bridge = createCanaryLiveBridge({
      sourceDir: BRIDGE_DIR,
      destDir: join(compatRoot, 'c2-live-bridge'),
      engines: INCOMPATIBLE_DSH_RANGE
    })
    const c2BridgeDir = join(compatRoot, 'c2-bridge-dir')
    mkdirSync(c2BridgeDir, { recursive: true })
    const profile = 'pet-compat-c2'
    if (prepareProfile(profile, 'C2 初始化 profile')) {
      writeCanaryProfilePatch(dshHome, profile, buildCanaryInsertPatch({ entry: c2Bridge.entry, bridgeDir: c2BridgeDir }))
      const run = await runTurn({
        cli,
        profile,
        task: FAIL_TASK,
        env: { ...failureEnv, AVENTURINE_BRIDGE_DISABLE_LAUNCH: '1', AVENTURINE_BRIDGE_DIR: c2BridgeDir },
        cwd: workDir,
        timeoutMs,
        bridgeDir: c2BridgeDir,
        label: 'C2 回合'
      })
      const hostOk = assertHostReachedTurnFailure(run, 'C2')
      const disabled = /disabling profile plugin/i.test(run.stderr)
      const enginesMentioned = /engines\.dsh/i.test(run.stderr)
      if (!disabled) {
        fail(`C2 FAIL：stderr 缺少 "disabling profile plugin"（闸门应禁用该 insert 行）；stderr: ${excerpt(run.stderr)}`)
        logRunSummary(run)
      } else if (!enginesMentioned) {
        fail(`C2 FAIL：stderr 缺少 "engines.dsh"（无法证明是版本闸门而非其它原因）：${excerpt(run.stderr)}`)
      }
      let artifacts = []
      try {
        artifacts = readdirSync(c2BridgeDir)
      } catch {
        artifacts = []
      }
      if (artifacts.length > 0) {
        fail(`C2 FAIL：桥被禁用后仍产生产物：${artifacts.join(', ')}`)
      }
      if (hostOk && disabled && enginesMentioned && artifacts.length === 0) {
        step('C2 PASS：宿主完成启动并跑到 turn 失败；stderr 有 disabling profile plugin/engines.dsh；桥目录零产物')
      }
    }
  } catch (error) {
    fail(`C2 构造/执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }

  /* ------------------------------- C3 ------------------------------- */
  step('C3/6 绝对路径 insert + 兼容 engines → control attached + compat.dshRange、status 心跳…')
  try {
    const c3Bridge = createCanaryLiveBridge({
      sourceDir: BRIDGE_DIR,
      destDir: join(compatRoot, 'c3-live-bridge'),
      engines: enginesOk
    })
    const c3BridgeDir = join(compatRoot, 'c3-bridge-dir')
    mkdirSync(c3BridgeDir, { recursive: true })
    const c3Version = readLiveBridgeVersion(c3Bridge.entry)
    const c3Strict = typeof c3Version === 'number' && c3Version >= 4
    const expectedBridgeVersion = typeof c3Version === 'number' ? c3Version : bridgeVersionSource
    const profile = 'pet-compat-c3'
    if (prepareProfile(profile, 'C3 初始化 profile')) {
      writeCanaryProfilePatch(dshHome, profile, buildCanaryInsertPatch({ entry: c3Bridge.entry, bridgeDir: c3BridgeDir }))
      const run = await runTurn({
        cli,
        profile,
        task: FAIL_TASK,
        env: { ...failureEnv, AVENTURINE_BRIDGE_DISABLE_LAUNCH: '1', AVENTURINE_BRIDGE_DIR: c3BridgeDir },
        cwd: workDir,
        timeoutMs,
        bridgeDir: c3BridgeDir,
        label: 'C3 回合'
      })
      const hostOk = assertHostReachedTurnFailure(run, 'C3')
      const control = validateCompatControlFrames({
        frames: run.controlFrames,
        expectedBridgeVersion,
        expectedControlSchema: BRIDGE_CONTROL_SCHEMA_VERSION,
        expectedDshRange: enginesOk,
        requireCompat: c3Strict
      })
      for (const error of control.errors) fail(`C3 FAIL：${error}`)
      if (!c3Strict) {
        step(`  C3 WARN：桥源码常量版本 <4（实际 ${JSON.stringify(c3Version)}），compat 断言降级为 WARN`)
      }
      const statusValidation = validateCompatStatus({
        statusText: readArtifact(join(c3BridgeDir, 'status.json')),
        expectedBridgeVersion,
        expectedControlSchema: BRIDGE_CONTROL_SCHEMA_VERSION,
        expectedDshRange: enginesOk,
        requireCompat: c3Strict,
        expectedOffline: true
      })
      for (const error of statusValidation.errors) fail(`C3 FAIL（status）：${error}`)
      if (run.statusOnlineSamples.length === 0) {
        fail('C3 FAIL：未观察到 status.json 在线心跳（桥 apply 后应先写一帧相对 status）')
      } else if (c3Strict && run.statusOnlineSamples.length > 0) {
        step(`  C3 观察到 ${run.statusOnlineSamples.length} 帧在线 status 心跳`)
      }
      if (hostOk && control.errors.length === 0 && statusValidation.errors.length === 0 && run.statusOnlineSamples.length > 0) {
        step(
          `C3 PASS：attached（bridgeVersion=${expectedBridgeVersion}，compat.dshRange=${JSON.stringify(control.compat?.dshRange ?? null)}）；` +
            'status 心跳/离线帧带同一 compat；桥产物齐全'
        )
      } else if (control.errors.length > 0 || statusValidation.errors.length > 0) {
        logRunSummary(run)
        step(`  控制帧：${JSON.stringify(run.controlFrames)}`)
      }
    }
  } catch (error) {
    fail(`C3 构造/执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }

  /* ------------------------------- C4 ------------------------------- */
  step('C4/6 import 抛错插件 → 宿主正常启动 + warning did not activate…')
  try {
    const fixture = createCanaryFixturePlugin({
      dir: join(compatRoot, 'c4-import-throw'),
      name: 'pet-canary-import-throw',
      indexSource: `throw new Error('canary-injected import failure')\nexport const name = 'pet-canary-import-throw'\n`
    })
    const fixtureDir = join(compatRoot, 'c4-bridge-dir')
    mkdirSync(fixtureDir, { recursive: true })
    const profile = 'pet-compat-c4'
    if (prepareProfile(profile, 'C4 初始化 profile')) {
      writeCanaryProfilePatch(dshHome, profile, buildCanaryInsertPatch({ entry: fixture.entry, rowId: 'canary-import-throw' }))
      const run = await runTurn({
        cli,
        profile,
        task: FAIL_TASK,
        env: { ...failureEnv, AVENTURINE_BRIDGE_DISABLE_LAUNCH: '1', AVENTURINE_BRIDGE_DIR: fixtureDir },
        cwd: workDir,
        timeoutMs,
        bridgeDir: fixtureDir,
        label: 'C4 回合'
      })
      const hostOk = assertHostReachedTurnFailure(run, 'C4')
      if (!/did not activate/i.test(run.stderr)) {
        fail(`C4 FAIL：stderr 缺少 "did not activate"：${excerpt(run.stderr)}`)
        logRunSummary(run)
      } else if (!/canary-injected import failure/i.test(run.stderr)) {
        fail(`C4 FAIL：stderr 未包含注入的 import 错误：${excerpt(run.stderr)}`)
      } else if (readdirSync(fixtureDir).length > 0) {
        fail('C4 FAIL：import 抛错插件不应产生任何桥产物')
      } else if (hostOk) {
        step('C4 PASS：宿主正常启动并跑到回合失败；warning did not activate + 注入错误可见；零产物')
      }
    }
  } catch (error) {
    fail(`C4 构造/执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }

  /* ------------------------------- C5 ------------------------------- */
  step('C5/6 apply 同步抛错插件 → 宿主正常启动 + warning did not activate…')
  try {
    const fixture = createCanaryFixturePlugin({
      dir: join(compatRoot, 'c5-apply-throw'),
      name: 'pet-canary-apply-throw',
      indexSource:
        `export const name = 'pet-canary-apply-throw'\n` +
        `export const apply = () => { throw new Error('canary-injected apply failure') }\n`
    })
    const fixtureDir = join(compatRoot, 'c5-bridge-dir')
    mkdirSync(fixtureDir, { recursive: true })
    const profile = 'pet-compat-c5'
    if (prepareProfile(profile, 'C5 初始化 profile')) {
      writeCanaryProfilePatch(dshHome, profile, buildCanaryInsertPatch({ entry: fixture.entry, rowId: 'canary-apply-throw' }))
      const run = await runTurn({
        cli,
        profile,
        task: FAIL_TASK,
        env: { ...failureEnv, AVENTURINE_BRIDGE_DISABLE_LAUNCH: '1', AVENTURINE_BRIDGE_DIR: fixtureDir },
        cwd: workDir,
        timeoutMs,
        bridgeDir: fixtureDir,
        label: 'C5 回合'
      })
      const hostOk = assertHostReachedTurnFailure(run, 'C5')
      if (!/did not activate/i.test(run.stderr)) {
        fail(`C5 FAIL：stderr 缺少 "did not activate"：${excerpt(run.stderr)}`)
        logRunSummary(run)
      } else if (!/canary-injected apply failure/i.test(run.stderr)) {
        fail(`C5 FAIL：stderr 未包含注入的 apply 错误：${excerpt(run.stderr)}`)
      } else if (readdirSync(fixtureDir).length > 0) {
        fail('C5 FAIL：apply 抛错插件不应产生任何桥产物')
      } else if (hostOk) {
        step('C5 PASS：宿主正常启动并跑到回合失败；warning did not activate + 注入错误可见；零产物')
      }
    }
  } catch (error) {
    fail(`C5 构造/执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }

  /* ------------------------------- C6 ------------------------------- */
  step('C6/6 桥 apply 失败隔离（不可写桥目录 → env 回退目录写 bridge-error.json，宿主无感）…')
  let c6ReadonlyDir = null
  try {
    const c6Bridge = createCanaryLiveBridge({
      sourceDir: BRIDGE_DIR,
      destDir: join(compatRoot, 'c6-live-bridge'),
      engines: enginesOk
    })
    const c6Version = readLiveBridgeVersion(c6Bridge.entry)
    const c6Strict = typeof c6Version === 'number' && c6Version >= 4
    c6ReadonlyDir = join(compatRoot, 'c6-readonly-bridge-dir')
    const c6DiagDir = join(compatRoot, 'c6-writable-diag-dir')
    mkdirSync(c6ReadonlyDir, { recursive: true })
    mkdirSync(c6DiagDir, { recursive: true })
    chmodSync(c6ReadonlyDir, READONLY_DIR_MODE)
    const profile = 'pet-compat-c6'
    if (prepareProfile(profile, 'C6 初始化 profile')) {
      // config.dir = 不可写目录（优先于 env）；AVENTURINE_BRIDGE_DIR = 可写回退目录 → 诊断落点。
      writeCanaryProfilePatch(dshHome, profile, buildCanaryInsertPatch({ entry: c6Bridge.entry, bridgeDir: c6ReadonlyDir }))
      const run = await runTurn({
        cli,
        profile,
        task: FAIL_TASK,
        env: { ...failureEnv, AVENTURINE_BRIDGE_DISABLE_LAUNCH: '1', AVENTURINE_BRIDGE_DIR: c6DiagDir },
        cwd: workDir,
        timeoutMs,
        bridgeDir: c6DiagDir,
        label: 'C6 回合'
      })
      const hostOk = assertHostReachedTurnFailure(run, 'C6')
      const disabledAsPluginFailure = /did not activate/i.test(run.stderr)
      if (c6Strict && disabledAsPluginFailure) {
        fail(`C6 FAIL：桥 apply 失败被宿主当成插件失败（v4 应返回 no-op disposer 静默隔离）：${excerpt(run.stderr)}`)
      }
      if (c6Strict && !/bridge dir not writable|apply failed|bridge-error/i.test(run.stderr)) {
        step(`  C6 提示：未在 stderr 看到桥 apply 失败 warn（桥可能自行选择静默），继续检查 bridge-error.json`)
      }
      let readonlyArtifacts = []
      try {
        readonlyArtifacts = readdirSync(c6ReadonlyDir)
      } catch (error) {
        readonlyArtifacts = [`<readdir 失败: ${error instanceof Error ? error.message : String(error)}>`]
      }
      if (readonlyArtifacts.length > 0) {
        fail(`C6 FAIL：不可写桥目录残留产物：${readonlyArtifacts.join(', ')}`)
      }
      const diagnosticText = readArtifact(join(c6DiagDir, BRIDGE_DIAGNOSTIC_FILE))
      if (diagnosticText === null) {
        if (c6Strict) {
          fail(
            `C6 FAIL：回退目录缺少 ${BRIDGE_DIAGNOSTIC_FILE}（桥 apply 失败必须写诊断；` +
              `目录：${c6DiagDir}）; stderr: ${excerpt(run.stderr)}`
          )
          logRunSummary(run)
        } else {
          step(`  C6 WARN：桥源码 v${JSON.stringify(c6Version)} 尚未实现 bridge-error.json，诊断断言降级`)
        }
      } else {
        const expectedVersion = typeof c6Version === 'number' ? c6Version : bridgeVersionSource
        const diagnostic = validateDiagnostic(diagnosticText, {
          expectedPhase: 'apply',
          expectedBridgeVersion: expectedVersion,
          expectedDshRange: enginesOk
        })
        for (const error of diagnostic.errors) fail(`C6 FAIL（bridge-error.json）：${error}`)
        if (diagnostic.errors.length === 0 && hostOk && readonlyArtifacts.length === 0) {
          step(
            `C6 PASS：宿主正常；bridge-error.json phase=apply、bridgeVersion=${expectedVersion}、` +
              `dshRange=${JSON.stringify(diagnostic.diagnostic?.dshRange ?? null)}；不可写目录零残留`
          )
        }
      }
    }
  } catch (error) {
    fail(`C6 构造/执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    // 恢复权限，保证 --keep 时临时目录可删除。
    if (c6ReadonlyDir !== null) {
      try {
        chmodSync(c6ReadonlyDir, WRITABLE_DIR_MODE)
      } catch {
        // 清理阶段失败只忽略（rmSync force 仍可能成功）。
      }
    }
  }
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[dsh-canary] ERROR ${error instanceof Error ? error.message : String(error)}`)
    console.error(HELP)
    return EXIT_FAIL
  }
  if (options.help) {
    console.log(HELP)
    return EXIT_PASS
  }

  const timeoutMs = (options.timeout ?? (options.online ? 300 : 180)) * 1000
  if (options.dsh !== null && !existsSync(options.dsh)) {
    console.error(`[dsh-canary] ERROR --dsh 指定的路径不存在：${options.dsh}`)
    return EXIT_FAIL
  }
  const cli = options.dsh ?? resolveDshCli()
  if (cli === null) {
    console.log('[dsh-canary] SKIP 找不到 DSH CLI。设置 DSH_CLI 或 --dsh <path> 后重试。')
    return EXIT_SKIP
  }
  if (options.online && (typeof process.env.DEEPSEEK_API_KEY !== 'string' || process.env.DEEPSEEK_API_KEY === '')) {
    console.error('[dsh-canary] ERROR --online 模式需要环境变量 DEEPSEEK_API_KEY（真实模型调用会产生少量费用）')
    return EXIT_FAIL
  }

  if (!existsSync(BRIDGE_PACKAGE)) {
    console.error(`[dsh-canary] FAIL 找不到桥插件：${BRIDGE_PACKAGE}`)
    return EXIT_FAIL
  }
  const bridgeManifest = JSON.parse(readFileSync(BRIDGE_PACKAGE, 'utf8'))
  const declaredDshRange = bridgeManifest.engines?.dsh ?? null

  const realBefore = snapshotRealBridgeDir()
  const tempRoot = mkdtempSync(join(tmpdir(), 'pet-dsh-canary-'))
  const dshHome = join(tempRoot, 'dsh-home')
  const failBridgeDir = join(tempRoot, 'bridge-fail')
  const okBridgeDir = join(tempRoot, 'bridge-ok')
  const workDir = join(tempRoot, 'work')
  for (const dir of [dshHome, failBridgeDir, okBridgeDir, workDir]) mkdirSync(dir, { recursive: true })

  /** @type {string[]} */
  const failures = []
  /** @type {{ close: () => Promise<void> } | null} */
  let mockLlm = null
  const step = (message) => console.log(`[dsh-canary] ${message}`)
  const fail = (message) => {
    failures.push(message)
    console.log(`[dsh-canary] FAIL ${message}`)
  }
  /** 把 validate* 返回的 errors 汇总到 failures（每条都打印）。 */
  const absorb = (errors) => {
    for (const error of errors) fail(error)
  }

  /** canary 子进程统一环境：临时 DSH_HOME + 强制禁用 launchPet（绝不拉起真实桌宠）。 */
  const baseEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    NO_COLOR: '1',
    [BRIDGE_DISABLE_LAUNCH_ENV]: '1'
  }

  try {
    if (options.onlyCompat) {
      step(`mode: --only-compat（跳过既有事件/文本契约组）`)
      step(`隔离目录: ${tempRoot}（临时 DSH_HOME + 临时桥/副本/profile）`)
      await runCompatGroup({ cli, baseEnv, tempRoot, workDir, failures, fail, step, timeoutMs, bridgeManifest })
      return report()
    }
    step(`DSH CLI: ${cli}`)
    step(`桥插件: ${BRIDGE_DIR}`)
    step(`版本护栏 engines.dsh: ${declaredDshRange ?? '（未声明！）'}`)
    step(`隔离目录: ${tempRoot}（临时 DSH_HOME + 两个独立 AVENTURINE_BRIDGE_DIR）`)

    // 1) 版本
    const versionResult = runDsh(cli, ['--version'], { env: { ...baseEnv }, cwd: workDir, timeoutMs: 60_000, label: 'dsh --version' })
    if (versionResult.status !== 0) {
      fail(`dsh --version 失败：${excerpt(versionResult.stderr || versionResult.stdout)}`)
      return report()
    }
    const dshVersion = versionResult.stdout.trim().split('\n').at(-1)?.trim() ?? '(未知)'
    step(`DSH 版本: ${dshVersion}`)

    // 2) 初始化 headless 模板 profile（--dump-config 只组合配置，不启动 agent）。
    const initResult = runDsh(
      cli,
      ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'],
      { env: { ...baseEnv }, cwd: workDir, timeoutMs: 120_000, label: '初始化 profile' }
    )
    if (initResult.status !== 0) {
      fail(`初始化 headless profile 失败：${excerpt(initResult.stderr || initResult.stdout)}`)
      return report()
    }
    step('1/6 初始化隔离 headless profile：PASS')

    // 3) 安装桥插件（本地路径）。DSH 会在这里检查 engines.dsh / bundle 形状。
    const installResult = runDsh(
      cli,
      ['plugin', '--profile', PROFILE, 'add', '-w', BRIDGE_DIR],
      { env: { ...baseEnv }, cwd: workDir, timeoutMs: 120_000, label: '安装桥插件' }
    )
    if (installResult.status !== 0) {
      const output = `${installResult.stderr}\n${installResult.stdout}`
      if (/incompatible|engines\.dsh|requirements|allow-version/i.test(output)) {
        fail(
          '桥插件被 DSH 插件管理器拒绝（版本护栏生效）：当前 DSH 可能已超出 engines.dsh 范围。' +
            '先按桥 README 的升级流程核对事件契约，再更新 engines.dsh 并重跑 canary。'
        )
      } else {
        fail(`安装桥插件失败：${excerpt(output)}`)
      }
      return report()
    }
    step('2/6 以本地路径安装桥插件（含版本护栏检查）：PASS')

    // 4) 组合后的配置树里必须真的出现桥插件行。
    const dumpResult = runDsh(cli, ['--profile', PROFILE, '--dump-config'], {
      env: { ...baseEnv },
      cwd: workDir,
      timeoutMs: 120_000,
      label: '组合配置'
    })
    if (dumpResult.status !== 0) {
      fail(`--dump-config 失败：${excerpt(dumpResult.stderr || dumpResult.stdout)}`)
      return report()
    }
    if (!/^\s*- id: aventurine-bridge\s*$/m.test(dumpResult.stdout)) {
      fail('组合后的配置树中找不到 aventurine-bridge 行（cordis.patch.yml 可能未生效）')
      return report()
    }
    step('3/6 bundle patch 已组合进 profile：PASS')

    // 5) 失败回合（离线：关闭端口 + 占位 key，无外网/费用）。
    const closedPort = await pickClosedPort()
    const failEnv = {
      ...baseEnv,
      AVENTURINE_BRIDGE_DIR: failBridgeDir,
      DEEPSEEK_API_KEY: 'dsh-canary-invalid-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${closedPort}`
    }
    step(`4/6 失败回合（模型端点 127.0.0.1:${closedPort} 已关闭，无真实调用）：…`)
    const failRun = await runTurn({
      cli,
      profile: PROFILE,
      task: FAIL_TASK,
      env: failEnv,
      cwd: workDir,
      timeoutMs,
      bridgeDir: failBridgeDir,
      label: '失败回合'
    })
    if (failRun.spawnError !== null) {
      fail(failRun.spawnError)
      return report()
    }
    if (failRun.timedOut) {
      fail(`失败回合超时（>${Math.round(timeoutMs / 1000)}s）；可加大 --timeout，或检查 DSH 是否在等待网络/凭据`)
      return report()
    }
    if (failRun.code !== 1) {
      fail(
        `失败回合退出码 ${JSON.stringify(failRun.code)}，期望 1。stderr: ${excerpt(failRun.stderr)}`
      )
      return report()
    }
    const failStatusText = readArtifact(join(failBridgeDir, 'status.json'))
    const failEventsText = readArtifact(join(failBridgeDir, 'events.jsonl'))
    if (failStatusText === null) {
      fail(`失败回合桥没有写出 status.json（插件是否加载？目录：${failBridgeDir}）`)
      return report()
    }
    if (failEventsText === null) {
      fail(`失败回合桥没有写出 events.jsonl（事件订阅是否生效？目录：${failBridgeDir}）`)
      return report()
    }
    const failValidation = validateCanaryArtifacts({
      statusText: failStatusText,
      eventsText: failEventsText,
      allowedTypes: DSH_EVENT_TYPES,
      expectError: true,
      forbiddenSubstrings: [FAIL_TASK]
    })
    const failControl = validateControlArtifacts({
      controlText: readArtifact(join(failBridgeDir, BRIDGE_CONTROL_FILE)),
      observedActions: failRun.observedActions,
      expectedSchemaVersion: BRIDGE_CONTROL_SCHEMA_VERSION
    })
    absorb(failValidation.errors)
    absorb(failControl.errors)
    if (failValidation.errors.length > 0 || failControl.errors.length > 0) {
      console.log(`[dsh-canary] 失败回合原始 status.json: ${excerpt(failStatusText, 800)}`)
      console.log(`[dsh-canary] 失败回合原始 events.jsonl: ${excerpt(failEventsText)}`)
      return report()
    }
    step(
      `4/6 失败回合断言：PASS（事件 ${failValidation.summary.types.join(' → ')}；` +
        `agent=${failValidation.summary.agents.join(',') || '?'}；` +
        `control ${failRun.observedActions.join(' → ')}；耗时 ${Math.round(failRun.durationMs / 1000)}s）`
    )

    // 6) 成功回合（默认：本地 mock LLM，离线无费用；--online：真实模型）。
    /** 成功回合期望的 assistant 文本（mock 模式下精确比对；online 模式只要求非空）。 */
    let expectedText = null
    const okEnv = { ...baseEnv, AVENTURINE_BRIDGE_DIR: okBridgeDir }
    if (options.online) {
      step('5/6 成功回合（在线真实模型调用）：…')
    } else {
      mockLlm = await startMockLlm({ assistantText: MOCK_ASSISTANT_TEXT, reasoningText: MOCK_REASONING_TEXT })
      okEnv.DEEPSEEK_API_KEY = 'dsh-canary-mock-key'
      okEnv.DEEPSEEK_BASE_URL = `http://127.0.0.1:${mockLlm.port}`
      expectedText = MOCK_ASSISTANT_TEXT
      step(`5/6 成功回合（本地 mock LLM 127.0.0.1:${mockLlm.port}，离线无费用）：…`)
    }

    const okRun = await runTurn({
      cli,
      profile: PROFILE,
      task: SUCCESS_TASK,
      env: okEnv,
      cwd: workDir,
      timeoutMs,
      bridgeDir: okBridgeDir,
      label: '成功回合'
    })
    // mock 请求记录落盘（--keep 时保留，排查用）。
    if (mockLlm !== null) {
      writeFileSync(
        join(tempRoot, 'mock-llm-requests.jsonl'),
        mockLlm.requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
        'utf8'
      )
    }
    if (okRun.spawnError !== null) {
      fail(okRun.spawnError)
      return report()
    }
    if (okRun.timedOut) {
      fail(`成功回合超时（>${Math.round(timeoutMs / 1000)}s）；可加大 --timeout，或检查 mock/DSH 是否挂住`)
      return report()
    }
    if (okRun.code !== 0) {
      fail(
        `成功回合退出码 ${JSON.stringify(okRun.code)}，期望 0。stderr: ${excerpt(okRun.stderr)}`
      )
      return report()
    }
    const okStatusText = readArtifact(join(okBridgeDir, 'status.json'))
    const okEventsText = readArtifact(join(okBridgeDir, 'events.jsonl'))
    if (okStatusText === null) {
      fail(`成功回合桥没有写出 status.json（插件是否加载？目录：${okBridgeDir}）`)
      return report()
    }
    if (okEventsText === null) {
      fail(`成功回合桥没有写出 events.jsonl（DSH 可能没有产生 durable 事件）`)
      return report()
    }
    const okValidation = validateCanaryArtifacts({
      statusText: okStatusText,
      eventsText: okEventsText,
      allowedTypes: DSH_EVENT_TYPES,
      expectError: false,
      requireAssistantText: true,
      expectedText,
      maxTextChars: DSH_EVENT_TEXT_MAX_CHARS,
      forbiddenSubstrings: options.online ? [] : [SUCCESS_TASK, MOCK_REASONING_TEXT]
    })
    const okControl = validateControlArtifacts({
      controlText: readArtifact(join(okBridgeDir, BRIDGE_CONTROL_FILE)),
      observedActions: okRun.observedActions,
      expectedSchemaVersion: BRIDGE_CONTROL_SCHEMA_VERSION
    })
    absorb(okValidation.errors)
    absorb(okControl.errors)
    if (okValidation.errors.length > 0 || okControl.errors.length > 0) {
      console.log(`[dsh-canary] 成功回合原始 status.json: ${excerpt(okStatusText, 800)}`)
      console.log(`[dsh-canary] 成功回合原始 events.jsonl: ${excerpt(okEventsText)}`)
      return report()
    }
    if (mockLlm !== null) {
      const mainRequests = mockLlm.requests.filter((request) => Number(request.tools) > 0).length
      step(`  mock LLM 收到请求 ${mockLlm.requests.length} 个（其中主 agent 请求 ${mainRequests} 个）`)
    }
    step(
      `5/6 成功回合断言：PASS（事件 ${okValidation.summary.types.join(' → ')}；` +
        `text=${JSON.stringify(okValidation.summary.texts)}；` +
        `control ${okRun.observedActions.join(' → ')}；耗时 ${Math.round(okRun.durationMs / 1000)}s）`
    )

    // 7) 隔离检查：真实 ~/.dsh 桥目录不应被 canary 改动。
    const realAfter = snapshotRealBridgeDir()
    if (JSON.stringify(realBefore) !== JSON.stringify(realAfter)) {
      console.log(
        '[dsh-canary] WARN 真实 ~/.dsh/aventurine-pet 在 canary 期间发生变化；' +
          '若有其它 DSH 实例同时运行请忽略，否则说明桥目录隔离失效，需要排查。'
      )
    } else {
      step('6/6 隔离检查：真实 ~/.dsh/aventurine-pet 未被改动')
    }

    const failStatus = failValidation.status ?? {}
    step(
      `失败回合心跳/离线帧: offline=${JSON.stringify(failStatus.offline)} ` +
        `running=${JSON.stringify(failStatus.running)} lastType=${JSON.stringify(failStatus.lastType)}`
    )

    // v4 兼容性/安装形态组（--compat；默认组保持快速，只有显式 flag 才加跑）
    if (options.compat) {
      await runCompatGroup({ cli, baseEnv, tempRoot, workDir, failures, fail, step, timeoutMs, bridgeManifest })
    }
    return report()
  } catch (error) {
    fail(`canary 执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    return report()
  } finally {
    if (mockLlm !== null) {
      try {
        await mockLlm.close()
      } catch {
        // mock server 关闭失败不影响结果。
      }
    }
    if (!options.keep) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  /** 打印总结并返回退出码。 */
  function report() {
    if (failures.length === 0) {
      console.log('[dsh-canary] PASS 桥与当前 DSH 的事件/文本/control 契约匹配。')
      if (options.keep) console.log(`[dsh-canary] 临时目录保留在：${tempRoot}`)
      return EXIT_PASS
    }
    console.log(`[dsh-canary] FAIL ${failures.length} 项断言失败。`)
    if (options.keep) console.log(`[dsh-canary] 临时目录保留在：${tempRoot}`)
    else console.log('[dsh-canary] 加 --keep 可保留临时目录用于排查。')
    return EXIT_FAIL
  }
}

const exitCode = await main()
process.exitCode = exitCode
