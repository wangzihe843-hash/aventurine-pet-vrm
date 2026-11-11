/**
 * dsh-aventurine-bridge —— DSH（DeepSeek Harness）host-only 文件桥插件。
 *
 * 职责：把 DSH 的运行状态改写成桌宠 app 可通过固定路径读取的文件（契约见 PLAN §8 /
 * wave3 设计 §3，冻结实现见 `src/shared/bridge-schema.ts`）：
 *   - `~/.dsh/aventurine-pet/status.json`：覆盖写的心跳状态，默认每 5s 一帧，
 *     插件卸载/进程退出时写一帧 `offline: true` 的显式离线标记；
 *   - `~/.dsh/aventurine-pet/events.jsonl`：追加写的 NDJSON（每行一个 DshEvent），
 *     单行 > 64KB 丢弃，文件 > 5MB 轮转为 `events.jsonl.1`；
 *   - `~/.dsh/aventurine-pet/control.json`：桥实例状态（v2 新增）。apply 时写 `attached`，
 *     dispose 时写 `detached`（原子写、含 schemaVersion/ts/dshPid）；心跳**不**重写，
 *     只有状态切换才写盘。注意：`detached` 只表示「桥没了」，HMR 重载也会 detach，
 *     消费方不能只凭它判定 DSH 进程退出（见 wave3 设计 §3.2）。
 *
 * 事件映射（只读 DSH 事件，不改变宿主行为；均为真实 DSH 4.x 形状）：
 *   - `agent/status`（payload `{ status, agent }`）：running → `task/start`，idle → `task/end`
 *     （payload `{ agent, status }`；DSH 只在状态变化时 emit）；
 *   - `agent/error`（agent-scoped，payload `{ turn, step, error, agent }`）→ `task/error`
 *     （payload `{ agent, turn?, step?, reasonKind: 'error', message? }`，message 截断）；
 *   - `session/event`（`(session, event)`，event 为 durable 记录 `{ type, seq, time, data }`）：
 *       - `turn/end`：`event.data.reason.kind === 'error'` → `task/error`，且**不再**透传
 *         `session/event`；其余 reason.kind（completed / max-tokens / blocked / aborted…）
 *         照常透传 `session/event`；
 *       - `assistant/message` → `session/event`，除 sessionId/eventType/seq/turn/step 等
 *         安全标量外，**额外写 `text`**（v2）：取 `event.data.message.content[]` 里所有
 *         `type === 'text'` 的 `text` 字符串按 `\n` join → trim → 截断到 8000 字符；
 *         空文本 / 纯 tool-call 消息不写 `text`（事件本身仍写）。**只写 assistant 输出**，
 *         不写 user 输入、不写 reasoning/thinking 正文、不写 tool 参数/结果正文；
 *       - `tool/result` → `session/event`（只带安全标量，不含工具正文）；
 *       - 其它（token 流、step 细节等高频事件）忽略，避免每 token 刷屏；
 *     `agent/error` 与 `turn/end(reason.kind=error)` 是同一个错误的两个真实信号：
 *     同一 `agentId + turn` 只记一条 `task/error`（先到先得；去重集合有上限，防内存增长）；
 *   - `agent/created` / `agent/disposed`：维护内存里的 agent 状态表；`agent/disposed` 时若该
 *     agent 上一状态为 running，先补一条 `task/end`（payload `{ agent, reason: 'disposed' }`），
 *     避免 B7 只按事件流驱动“忙碌”姿态时悬挂。
 *
 * v4（2026-11-11 兼容性安全 v2，计划 §3.2/§4.1）：
 *   - **compat 自述**：`control.json` / `status.json` 的**每一帧**都带
 *     `compat: { bridgeVersion, controlSchema, dshRange }`；`dshRange` 运行时读本包相邻的
 *     `../package.json` 的 `engines.dsh`（live 副本 `work/live-bridge/<rev>/` 与正规 bundle
 *     安装都是相邻 manifest，两种形态都适用；读不到 → `null`，绝不猜兼容）。
 *   - **apply 失败隔离**：`apply` 只做一层 try/catch，实际启动逻辑在 `startBridge()`；任何
 *     启动失败（含桥目录不可写预检）都写 `bridge-error.json` 诊断 + warn + 返回 no-op
 *     disposer `() => {}`，**绝不把异常抛给宿主**（异步孤儿抛错是唯一能打死宿主的插件行为）。
 *   - **防异步孤儿抛错**：心跳 timer 回调、所有事件 handler、`writeStatus/writeControl/
 *     writeEvent`、disposer 全部内部 try/catch；本文件没有任何无 catch 的 promise；
 *     模块顶层零 IO/副作用（`readDeclaredDshRange` 首次调用时才读 manifest 并缓存）。
 *   - apply 成功时 best-effort 清理上一次失败留下的旧 `bridge-error.json`。
 *
 * 失败策略：任何 fs/事件异常都只 `console.warn`，绝不向宿主抛异常（§9）；v4 起 `apply`
 * 的启动失败会额外落盘 `bridge-error.json` 供桌宠解释「桥为什么没加载」。
 *
 * 配置（cordis.patch.yml 的 insert row `config`，均可省略）：
 *   - `dir`：桥目录覆盖（默认 `~/.dsh/aventurine-pet`，支持 `~/` 展开；也可用环境变量
 *     `AVENTURINE_BRIDGE_DIR`，同样支持 `~/`；优先级 config.dir > env > 默认值）；
 *   - `rotateBytes` / `maxLineBytes`：仅为测试/调试留的阈值覆盖，默认取契约常量；
 *   - `launchPet`（默认 false）：apply 时拉起桌宠 app 一次（v2）。需配合
 *     `petAppPath`（`.app` 绝对路径，优先 `open <path>`）或 `petBundleId`（`open -b <id>`）；
 *     两者都为空则只 warn 不 launch。环境变量 `AVENTURINE_BRIDGE_DISABLE_LAUNCH=1`
 *     强制禁用（测试/canary 用）。spawn 失败/detached 子进程异步报错都只 warn，绝不影响宿主。
 *
 * 单写者假设：同一时间只应有一个 DSH profile 安装本插件（多实例同目录启动时
 * status.json / control.json 都是 last-writer-wins；临时文件名已按进程/实例唯一，
 * 不会互踩半截文件，但状态帧仍会互相覆盖）。
 *
 * 本文件是纯 ESM、无构建步骤。
 * ⚠️ `apply` 必须导出为**箭头函数**（不可构造）：cordis 4.x 用 `isConstructor(fn) = !!fn.prototype`
 * 判定插件形态，普通 `function` 声明会被 `new fn(ctx, config)` 调用，apply 返回的 disposer 会被
 * 当作“构造器返回值”丢弃（cordis 只认 `instance[symbols.init]`）→ 心跳 interval 不清、
 * offline 帧不写。回归断言见 `tests/bridge-plugin.test.ts`。
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  BRIDGE_CONTROL_FILE,
  BRIDGE_CONTROL_SCHEMA_VERSION,
  BRIDGE_DIR_NAME,
  BRIDGE_DIAGNOSTIC_FILE,
  BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  BRIDGE_INSTALL_SCHEMA_VERSION,
  BRIDGE_PLUGIN_VERSION,
  BRIDGE_DISABLE_LAUNCH_ENV,
  BRIDGE_EVENTS_FILE,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_MAX_LINE_BYTES,
  BRIDGE_ROTATE_BYTES,
  BRIDGE_STATUS_FILE,
  DSH_EVENT_TEXT_MAX_CHARS,
  DSH_EVENT_TYPES
} from './constants.js'

/** 插件名（cordis 插件入口约定导出；也是 bundle patch 里 insert 的 name）。 */
export const name = 'dsh-aventurine-bridge'

/** 所有日志统一前缀，便于宿主日志里过滤。 */
const LOG_PREFIX = '[dsh-aventurine-bridge]'

/** 桥目录的环境变量覆盖（手工验收/测试用；config.dir 优先级更高）。 */
const DIR_ENV = 'AVENTURINE_BRIDGE_DIR'

/** 冻结事件类型白名单的运行时集合（F9：appendEvent 写入前校验）。 */
const EVENT_TYPE_SET = new Set(DSH_EVENT_TYPES)

/** 同进程内 apply 实例序号：保证 status.json 临时文件名在同一进程多实例下也唯一。 */
let instanceSeq = 0

/** 同进程内诊断文件写入序号（`bridge-error.json` 临时文件名用；进程间靠 pid 区分）。 */
let diagnosticSeq = 0

/** 同进程内桥目录可写性探针序号（探针临时文件名用）。 */
let probeSeq = 0

/**
 * 桥自身 `package.json.engines.dsh` 的缓存（v4 compat 自述来源）。
 * `undefined` = 尚未读取；`null` = 读取失败/未声明（已缓存失败，不再反复 IO）；
 * 字符串 = 声明的 DSH SemVer 范围。
 */
let declaredDshRangeCache

/** 同一 agent/session + turn 的 task/error 去重表上限（FIFO 淘汰，防长期运行内存增长）。 */
const ERROR_DEDUPE_LIMIT = 64

/** agent/error 的 message 最大保留字符数（隐私 + 64KB 行上限；只保留截断后的标量）。 */
const ERROR_MESSAGE_MAX_CHARS = 512

/** reason.kind 只接受短字符串（防御异常值把 payload 撑大）。 */
const REASON_KIND_MAX_CHARS = 64

/** 值得透传给桌宠的 durable 会话事件（避免每 token 刷屏）。 */
const NOTABLE_SESSION_EVENTS = new Set(['turn/end', 'assistant/message', 'tool/result'])

/** agent/status 只承认这两种状态（`dsh-agent-loop` 只在变化时 emit）。 */
const AGENT_STATUSES = new Set(['idle', 'running'])

/** 失败只 warn 不抛：主进程/宿主日志里保留前缀与原始信息。 */
function warn(...args) {
  try {
    console.warn(LOG_PREFIX, ...args)
  } catch {
    // console 本身不可用时也不能让插件崩溃。
  }
}

/** 把未知异常压成一行可读文本（避免把整个 error 对象丢进日志）。 */
function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 判断是否为普通对象（class 实例也算对象；数组排除）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限正数覆盖值，否则回退契约常量。 */
function positiveNumberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

/** 有限数值 → 截断整数；否则 null（用于 turn/step 这类安全标量）。 */
function finiteIntegerOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** 非空字符串（去首尾空白、截断上限）；否则 undefined（payload 里省略该键）。 */
function nonEmptyString(value, maxChars) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return maxChars !== undefined && trimmed.length > maxChars
    ? trimmed.slice(0, maxChars)
    : trimmed
}

/**
 * 从 `assistant/message` 的 durable event data 提取 assistant 输出文本（v2 契约 §3.1）。
 *
 * 真实形状（DSH 0.2.2-rc.1）：`event.data.message.content` 是内容块数组，可能同时含
 * `{ type:'text', text }`、`{ type:'reasoning', text }`、`{ type:'tool-call', … }`。
 * 规则：
 * 1. 只取 `type === 'text'` 且 `text` 为**字符串**的块（未知块类型宽容跳过）；
 * 2. 按 `\n` join，再 trim；
 * 3. 空串 / 没有 text 块 / `message.content` 非数组 → 返回 undefined（不写 `text` 键）；
 * 4. 超过 `DSH_EVENT_TEXT_MAX_CHARS` 截断（UTF-16 code unit，与读取侧清洗一致）；
 * 5. 任何访问异常（getter/Proxy 抛错）→ 返回 undefined，绝不把数组/对象塞进 payload。
 *
 * @param {unknown} data `session/event.data`（未信任输入）
 * @returns {string | undefined} 可直接写入 payload.text 的标量；无可写文本时 undefined
 */
function extractAssistantText(data) {
  try {
    if (!isRecord(data)) return undefined
    const message = data.message
    if (!isRecord(message)) return undefined
    const content = message.content
    if (!Array.isArray(content)) return undefined
    const parts = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type !== 'text') continue
      if (typeof block.text !== 'string' || block.text.length === 0) continue
      parts.push(block.text)
    }
    if (parts.length === 0) return undefined
    const joined = parts.join('\n').trim()
    if (joined.length === 0) return undefined
    return joined.length > DSH_EVENT_TEXT_MAX_CHARS
      ? joined.slice(0, DSH_EVENT_TEXT_MAX_CHARS)
      : joined
  } catch {
    // 异常 content（getter 抛错等）：不写 text，事件本身仍写（失败策略：只降级不抛）。
    return undefined
  }
}

/** 从 durable 事件的 `data.reason` 里取 kind（真实 DSH：turn/end.data.reason.kind）。 */
function reasonKindOf(data) {
  try {
    return nonEmptyString(data?.reason?.kind, REASON_KIND_MAX_CHARS)
  } catch {
    // reason getter 抛错时按“没有 reason”处理。
    return undefined
  }
}

/**
 * 从 agent/error 的 error 字段取可读 message（真实 DSH：`{ message, code }`；
 * 也兼容 Error 实例；只取标量，绝不把整个 error 对象写进 events.jsonl）。
 */
function errorMessageOf(error) {
  try {
    if (typeof error === 'string') return error
    if (!isRecord(error)) return undefined
    if (typeof error.message === 'string') return error.message
    if (isRecord(error.failure) && typeof error.failure.message === 'string') {
      return error.failure.message
    }
  } catch {
    // message getter 抛错时按“没有 message”处理。
  }
  return undefined
}

/** 当前进程 pid（status.json 临时文件名用；非 Node 宿主时退化为 0）。 */
function currentPid() {
  try {
    if (typeof process !== 'undefined' && typeof process.pid === 'number') return process.pid
  } catch {
    // process 不可用时退化为 0。
  }
  return 0
}

/**
 * 展开 `~/` 前缀（F10）。只展开当前用户 home（`~` / `~/…` / Windows `~\…`），
 * 不解析 `~otheruser/…`（文档注明仅支持当前用户）。
 * @param {string} path 用户传入路径
 * @returns {string} 展开后的路径
 */
function expandHomePath(path) {
  if (path === '~') {
    try {
      return homedir()
    } catch {
      return path
    }
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    try {
      return join(homedir(), path.slice(2))
    } catch {
      return path
    }
  }
  return path
}

/**
 * 解析桥目录：config.dir > 环境变量 AVENTURINE_BRIDGE_DIR > `~/.dsh/aventurine-pet`。
 * 三个来源都支持 `~/` 展开（F10）。
 * @param {unknown} config 插件配置（可能为 undefined/脏值）
 * @returns {string} 桥目录路径（由调用方 mkdir）
 */
function resolveBridgeDir(config) {
  if (isRecord(config) && typeof config.dir === 'string' && config.dir.trim().length > 0) {
    return expandHomePath(config.dir)
  }
  try {
    const fromEnv = process.env[DIR_ENV]
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return expandHomePath(fromEnv)
  } catch {
    // process.env 不可用（非 Node 宿主）时静默回退默认目录。
  }
  return join(homedir(), '.dsh', BRIDGE_DIR_NAME)
}

/** 截断到 maxChars（UTF-16 code unit，与共享契约读取侧同口径）；非字符串安全降级为空串。 */
function truncateText(text, maxChars) {
  if (typeof text !== 'string') return ''
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/**
 * 读取桥自身 `package.json` 的 `engines.dsh`（v4 compat 自述的唯一来源）。
 *
 * 为什么运行时读而不是在 `lib/constants.js` 里再抄一份范围：
 * - 真实部署形态是 `work/live-bridge/<rev>/` 的 live 副本，其 `package.json` 由激活脚本生成，
 *   可能随 DSH 版本适配而改；compat 自述必须与 DSH 版本闸门实际使用的 manifest **完全同源**，
 *   抄一份常量会漂移成"桥自称的范围 ≠ 闸门用的范围"。
 * - live 副本（`work/live-bridge/<rev>/lib/index.js`）与正规 bundle 安装的入口都在包内
 *   `lib/` 下，`../package.json` 相邻可读，两种形态同一套逻辑。
 *
 * 约定：读不到 / 没有 `engines.dsh` / 非法 JSON → 返回 `null`（**绝不猜兼容范围**、绝不抛）；
 * 首次读取后缓存（成功与失败都缓存，避免每 5s 心跳反复 IO）。
 *
 * @returns {string | null} 声明的 DSH SemVer 范围；不可得时 null
 */
function readDeclaredDshRange() {
  if (declaredDshRangeCache !== undefined) return declaredDshRangeCache
  // 先按失败缓存：任何异常都不会让桥反复尝试读 manifest。
  declaredDshRangeCache = null
  try {
    const manifestText = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(manifestText)
    const range = isRecord(manifest) && isRecord(manifest.engines) ? manifest.engines.dsh : undefined
    if (typeof range === 'string' && range.trim().length > 0) {
      declaredDshRangeCache = range.trim()
    }
  } catch (error) {
    warn(`declared dsh range unavailable (${errorText(error)})`)
  }
  return declaredDshRangeCache
}

/**
 * 构造 v4 `compat` 块（每帧写入 control.json / status.json，形状见共享契约 `DshBridgeCompat`）。
 * 桥只自述「我是谁 / 我认识哪个控制帧 schema / 我声明兼容哪个 DSH 范围」；
 * **不声称知道当前 DSH 版本**（版本由桌宠从 app Info.plist 读取后与本范围比较）。
 * @returns {{ bridgeVersion: number, controlSchema: number, dshRange: string | null }}
 */
function buildCompat() {
  return {
    bridgeVersion: BRIDGE_PLUGIN_VERSION,
    controlSchema: BRIDGE_CONTROL_SCHEMA_VERSION,
    dshRange: readDeclaredDshRange()
  }
}

/**
 * 计算 `bridge-error.json` 的诊断落点候选（v4）：
 * 1. 本次 apply 的主桥目录（config.dir > env > 默认；即桥正常运行时会写的目录）；
 * 2. 环境变量 `AVENTURINE_BRIDGE_DIR` 指向的目录（仅当与 ① 不同且有效）。
 *
 * 为什么需要回退：主桥目录不可写（chmod / 被文件占用 / 磁盘异常）正是最需要诊断的一类
 * `apply` 失败，此时诊断只能落到另一个已知目录；canary/单测用 `AVENTURINE_BRIDGE_DIR`
 * 注入这个可写目录。两者相同或都不可写 → 只 warn，不写文件（绝不因诊断二次抛错）。
 * @param {unknown} config 插件配置
 * @returns {string[]} 去重后的候选目录（按优先级）
 */
function resolveDiagnosticDirs(config) {
  const dirs = []
  try {
    const primary = resolveBridgeDir(config)
    if (typeof primary === 'string' && primary.length > 0) dirs.push(primary)
  } catch (error) {
    warn(`bridge dir resolve failed for diagnostic (${errorText(error)})`)
  }
  try {
    const fromEnv = process.env[DIR_ENV]
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      const envDir = expandHomePath(fromEnv)
      if (envDir.length > 0 && !dirs.includes(envDir)) dirs.push(envDir)
    }
  } catch {
    // process.env 不可用时没有回退候选。
  }
  return dirs
}

/**
 * 写 `bridge-error.json` 诊断（v4，仅 `apply` 启动失败时调用；**绝不抛错**）。
 *
 * 契约形状见共享契约 `DshBridgeDiagnostic`：
 * `{ schemaVersion, ts, phase, message, bridgeVersion?, dshRange? }`。
 * 写盘：候选目录依次尝试（主桥目录 → AVENTURINE_BRIDGE_DIR），同目录唯一 tmp → rename
 * 原子替换、0600；某个候选不可用就换下一个，全部失败只 warn。
 * @param {unknown} config 插件配置（用于解析候选目录）
 * @param {string} phase 故障阶段（`apply`）
 * @param {unknown} cause 原始异常
 * @returns {string | null} 实际写入的诊断文件路径；未写成功时 null
 */
function writeBridgeDiagnostic(config, phase, cause) {
  const diagnosticDirs = resolveDiagnosticDirs(config)
  if (diagnosticDirs.length === 0) {
    warn('bridge diagnostic skipped: no writable candidate dir')
    return null
  }
  const frame = {
    schemaVersion: BRIDGE_INSTALL_SCHEMA_VERSION,
    ts: Date.now(),
    phase,
    message: truncateText(errorText(cause), BRIDGE_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    bridgeVersion: BRIDGE_PLUGIN_VERSION,
    dshRange: readDeclaredDshRange()
  }
  for (const dir of diagnosticDirs) {
    diagnosticSeq += 1
    const path = join(dir, BRIDGE_DIAGNOSTIC_FILE)
    const tmpPath = join(dir, `.${BRIDGE_DIAGNOSTIC_FILE}.${currentPid()}.${diagnosticSeq}.tmp`)
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(tmpPath, `${JSON.stringify(frame)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmpPath, path)
      return path
    } catch (error) {
      warn(`bridge diagnostic write failed: ${path} (${errorText(error)})`)
      try {
        unlinkSync(tmpPath)
      } catch {
        // tmp 可能还没创建成功，无需处理。
      }
    }
  }
  return null
}

/**
 * best-effort 清理旧 `bridge-error.json`（v4：apply 成功 = 上一次失败已恢复）。
 * 文件不存在 / 不可删 / 目录不可用都只 warn，绝不影响启动。
 * @param {string} dir 本次 apply 的桥目录
 */
function clearBridgeDiagnostic(dir) {
  try {
    const path = join(dir, BRIDGE_DIAGNOSTIC_FILE)
    if (!existsSync(path)) return
    unlinkSync(path)
  } catch (error) {
    warn(`stale bridge diagnostic cleanup failed (${errorText(error)})`)
  }
}

/**
 * 校验桥目录可用（v4 启动预检）：建目录成功 + 能写入一个探针文件。
 *
 * 为什么 v4 要把「目录不可写」从静默降级改成 apply 失败：v3 的每次写入都内部 catch，
 * 目录不可写时桥会变成一个**僵尸桥**（永远写不出 status/control，桌宠只能看到"桥没加载"，
 * 无法解释原因）。v4 由 `apply` 外层兜底：预检失败 → throw → 写 `bridge-error.json` +
 * 返回 no-op disposer，既让宿主完全无感，又留下可诊断证据（计划 §5.1 C6）。
 *
 * 注意：对**已存在**目录 `mkdirSync(recursive:true)` 不会因权限位失败，所以必须写探针
 * 才能真正区分「可读但不可写」。
 * @param {string} dir 桥目录
 * @throws 目录不可建 / 探针写入失败（调用方 = startBridge，由 apply 外层 catch 兜底）
 */
function assertBridgeDirWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new Error(`bridge dir unavailable: ${dir} (${errorText(error)})`)
  }
  probeSeq += 1
  const probePath = join(dir, `.bridge-write-probe.${currentPid()}.${probeSeq}.tmp`)
  try {
    writeFileSync(probePath, '', { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    throw new Error(`bridge dir not writable: ${dir} (${errorText(error)})`)
  } finally {
    try {
      unlinkSync(probePath)
    } catch {
      // 探针清理失败不影响判定（写入已成功证明目录可写）。
    }
  }
}

/** 从 event payload 里取 agent id（防御脏值；缺失时用固定占位，保证 Map 不炸）。 */
function agentIdOf(agent) {
  try {
    const id = agent?.id
    if (typeof id === 'string' && id.length > 0) return id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  } catch {
    // 访问 id getter 抛错时走占位值。
  }
  return '(unknown)'
}

/** 从 session 取 id（真实 DSH：agent.id === session.id；缺失时返回 undefined）。 */
function sessionIdOf(session) {
  try {
    const id = session?.id
    if (typeof id === 'string' && id.length > 0) return id
    if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  } catch {
    // 访问 id getter 抛错时按缺失处理。
  }
  return undefined
}

/**
 * 创建事件写入器（events.jsonl）：白名单校验 → 序列化 → 64KB 行长上限 → 5MB 轮转 → 追加写。
 *
 * 从 `apply` 独立出来是为了可直接单测（非法事件类型、超长丢弃等分支无法从插件外部触发）；
 * 它不是 cordis 插件契约的一部分，生产路径只有 `apply` 使用。所有失败只 warn/返回 false，绝不抛。
 * @param {{ dir?: string, rotateBytes?: number, maxLineBytes?: number }} [options]
 * @returns {{ appendEvent(type: string, payload?: object): boolean, close(): void,
 *   readonly lastEventAt: number, readonly lastType: string | null }}
 */
export function createEventLog(options = {}) {
  const opts = isRecord(options) ? options : {}
  const dir = typeof opts.dir === 'string' ? opts.dir : ''
  const eventsPath = dir.length > 0 ? join(dir, BRIDGE_EVENTS_FILE) : ''
  const rotateBytes = positiveNumberOr(opts.rotateBytes, BRIDGE_ROTATE_BYTES)
  const maxLineBytes = positiveNumberOr(opts.maxLineBytes, BRIDGE_MAX_LINE_BYTES)

  /** 最近一次成功写入 events.jsonl 的事件时间戳（0 表示还没有事件）。 */
  let lastEventAt = 0
  /** 最近一次成功写入的事件类型（null 表示还没有事件）。 */
  let lastType = null
  /** 写入器是否已关闭（插件 dispose 后不再写事件）。 */
  let closed = false

  /** events.jsonl 超过阈值时轮转为 events.jsonl.1（覆盖旧 .1）；失败只 warn。 */
  function rotateIfNeeded() {
    let stats
    try {
      stats = statSync(eventsPath)
    } catch (error) {
      // 文件还不存在/目录不可用：无需轮转，后续 append 会自己处理失败。
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return
      warn(`events stat failed: ${eventsPath} (${errorText(error)})`)
      return
    }
    if (!stats.isFile() || stats.size <= rotateBytes) return
    try {
      renameSync(eventsPath, `${eventsPath}.1`)
    } catch (error) {
      warn(`events rotate failed: ${eventsPath} (${errorText(error)})`)
    }
  }

  /**
   * 追加写一行 DshEvent（NDJSON）。类型不在契约白名单 / 超长行一律丢弃并 warn；
   * 只有成功写入才更新 lastEventAt/lastType（心跳据此反映最近事件）。
   * @param {string} type 事件类型（必须来自 DSH_EVENT_TYPES）
   * @param {object} [payload] 事件 payload（非对象按 `{}` 处理）
   * @returns {boolean} 是否成功写入
   */
  function appendEvent(type, payload = {}) {
    if (closed) return false
    if (eventsPath.length === 0) {
      warn('event dropped: bridge dir is not configured')
      return false
    }
    // F9：运行时白名单校验，避免调用点写错字符串后整行被读侧静默丢弃。
    if (!EVENT_TYPE_SET.has(type)) {
      warn(`event type rejected: ${String(type)} (not in DSH_EVENT_TYPES)`)
      return false
    }
    const ts = Date.now()
    let line
    try {
      line = JSON.stringify({ ts, type, payload: isRecord(payload) ? payload : {} })
    } catch (error) {
      warn(`event serialize failed: ${errorText(error)}`)
      return false
    }
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > maxLineBytes) {
      warn(`event dropped: ${bytes}B > maxLineBytes ${maxLineBytes}B (type=${String(type)})`)
      return false
    }
    try {
      rotateIfNeeded()
      appendFileSync(eventsPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      warn(`event append failed: ${eventsPath} (${errorText(error)})`)
      return false
    }
    lastEventAt = ts
    lastType = type
    return true
  }

  return {
    appendEvent,
    close() {
      closed = true
    },
    get lastEventAt() {
      return lastEventAt
    },
    get lastType() {
      return lastType
    }
  }
}

/**
 * 解析 `.app` 的内部可执行文件路径（`<App>.app/Contents/MacOS/<App>`）。
 *
 * ⚠️ 为什么需要「直接执行可执行文件」而不是一律 `open <path>`（2026-11-11 实机发现）：
 * DSH Host 进程自身以 `ELECTRON_RUN_AS_NODE=1` 运行；它 `spawn('open', ...)` 时子进程继承
 * 该环境变量，macOS LaunchServices 启动的 Electron 应用若继承到 `ELECTRON_RUN_AS_NODE=1`
 * 会以纯 Node 模式运行主脚本后立即退出（桌宠窗口不出现）。因此桥优先直接 spawn `.app`
 * 内部可执行文件，并**清洗 `ELECTRON_RUN_AS_NODE`**；解析不到时才回退 `open`（向后兼容）。
 * 直接执行不需要 `open` 的 LaunchServices 路径，也规避了未签名/无 CMS 的 AMFI 限制。
 *
 * @param {string} appPath `.app` 绝对路径（未信任配置值）
 * @returns {string | null} 可执行文件绝对路径；不是 `.app`/结构不符/不存在 → null
 */
function defaultResolveExecutable(appPath) {
  try {
    if (typeof appPath !== 'string' || !appPath.endsWith('.app')) return null
    const base = appPath.split('/').pop() ?? ''
    const name = base.slice(0, -'.app'.length)
    if (name.length === 0) return null
    const candidate = join(appPath, 'Contents', 'MacOS', name)
    return existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * 创建「拉起桌宠 app」执行器（v2 契约 §3.4 / §6）。
 *
 * 从 `apply` 独立出来是为了可直接单测（无法从插件外部观察 spawn 参数/失败分支）；
 * 它不是 cordis 插件契约的一部分，生产路径只有 `apply` 使用。语义：
 * - 每个**执行器实例**最多触发一次（apply 每实例创建一个 → 「每个 apply 最多一次」）；
 * - 只在 `config.launchPet === true` 时触发；`AVENTURINE_BRIDGE_DISABLE_LAUNCH=1` 强制禁用；
 * - 目标：`petAppPath`（绝对路径，优先）→ `open <path>`；否则 `petBundleId` → `open -b <id>`；
 *   两者都缺 → 只 warn，不 spawn；
 * - `spawn('open', args, { detached: true, stdio: 'ignore' })` 后立即 `unref()`：
 *   桌宠是独立常驻进程，不能因为 DSH 退出/HMR 重载被一起带走；
 * - spawn 同步抛错 / 子进程异步 'error' / `unref` 不可用都只 warn，绝不影响宿主。
 *
 * @param {{ spawn?: Function, env?: Record<string, string | undefined> }} [deps] 注入点（单测用）
 * @returns {(config?: unknown) => boolean} 是否已成功发起一次拉起（含「无需拉起」返回 false）
 */
export function createPetLauncher(deps = {}) {
  const depsRecord = isRecord(deps) ? deps : {}
  const spawnImpl = typeof depsRecord.spawn === 'function' ? depsRecord.spawn : spawn
  const resolveExecutable =
    typeof depsRecord.resolveExecutable === 'function'
      ? depsRecord.resolveExecutable
      : defaultResolveExecutable
  let env = depsRecord.env
  if (!isRecord(env)) {
    try {
      env = process.env
    } catch {
      env = {}
    }
  }
  /** 本执行器是否已经处理过一次（无论结果成功/失败/跳过，均不再触发）。 */
  let attempted = false

  return function launchPet(config) {
    if (attempted) return false
    attempted = true
    try {
      if (!isRecord(config)) return false
      if (config.launchPet !== true) return false
      if (env[BRIDGE_DISABLE_LAUNCH_ENV] === '1') return false

      const appPath = nonEmptyString(config.petAppPath)
      const bundleId = nonEmptyString(config.petBundleId)
      // 清洗 `ELECTRON_RUN_AS_NODE`：DSH Host 自身带该变量，被拉起的 Electron app 继承后
      // 会以纯 Node 模式启动并立即退出（2026-11-11 实机定位）。direct-exec 与 `open` 回退共用。
      const cleanEnv = { ...env }
      delete cleanEnv.ELECTRON_RUN_AS_NODE

      // 优先：`.app` → 直接执行内部可执行文件 + 清洗 ELECTRON_RUN_AS_NODE（见 defaultResolveExecutable）。
      if (appPath !== undefined) {
        const executable = resolveExecutable(appPath)
        if (typeof executable === 'string' && executable.length > 0) {
          const child = spawnImpl(executable, [], {
            detached: true,
            stdio: 'ignore',
            env: cleanEnv
          })
          if (child && typeof child.on === 'function') {
            child.on('error', (error) => {
              warn(`launch pet failed: ${executable} (${errorText(error)})`)
            })
          }
          if (child && typeof child.unref === 'function') child.unref()
          return true
        }
      }

      // 回退：`open <path>`（非 .app 路径 / 解析不到可执行时）或 `open -b <bundleId>`。
      const args = appPath !== undefined ? [appPath] : bundleId !== undefined ? ['-b', bundleId] : null
      if (args === null) {
        warn('launchPet enabled but neither petAppPath nor petBundleId is configured; skip launch')
        return false
      }

      const child = spawnImpl('open', args, { detached: true, stdio: 'ignore', env: cleanEnv })
      // 异步失败（如 open 不存在 / 无此 app）也必须消费 'error'，否则 Node 会把它
      // 升级成未捕获异常打挂宿主进程；失败只 warn。
      if (child && typeof child.on === 'function') {
        child.on('error', (error) => {
          warn(`launch pet failed: open ${args.join(' ')} (${errorText(error)})`)
        })
      }
      if (child && typeof child.unref === 'function') child.unref()
      return true
    } catch (error) {
      warn(`launch pet failed: ${errorText(error)}`)
      return false
    }
  }
}

/**
 * 桥的实际启动逻辑（v4：由 `apply` 外层 try/catch 兜底调用）。
 *
 * 职责：订阅全局事件、写文件心跳 + control 状态，返回 disposer。
 * **启动阶段的失败允许抛出**（目录不可写预检、ctx 读取异常等），由 `apply` 统一捕获 →
 * 写 `bridge-error.json` + 返回 no-op disposer（宿主完全无感，见文件头 §4.1 规则）。
 *
 * @param {object} ctx cordis 插件上下文（只用 ctx.on）
 * @param {object} config 插件配置（cordis.patch.yml row 的 config；已保证是普通对象）
 * @param {object} deps 测试注入点（生产省略）
 * @returns {() => void} disposer：clearInterval + 移除监听 + 写离线帧 + control detached（幂等）
 */
function startBridge(ctx, config, deps) {
  const cfg = isRecord(config) ? config : {}
  const dir = resolveBridgeDir(cfg)
  const rotateBytes = positiveNumberOr(cfg.rotateBytes, BRIDGE_ROTATE_BYTES)
  const maxLineBytes = positiveNumberOr(cfg.maxLineBytes, BRIDGE_MAX_LINE_BYTES)
  /** v4：本 apply 实例的兼容自述（同一份对象写进 control 与每一帧 status）。 */
  const compat = buildCompat()

  const statusPath = join(dir, BRIDGE_STATUS_FILE)
  const controlPath = join(dir, BRIDGE_CONTROL_FILE)
  const pid = currentPid()
  instanceSeq += 1
  const instanceId = instanceSeq
  /** status.json 当前实例的写序号（临时文件名 `.status.json.<pid>.<instance>.<seq>.tmp`）。 */
  let statusWriteSeq = 0
  /** control.json 当前实例的写序号（与 status 分开计数，临时文件名同规则）。 */
  let controlWriteSeq = 0
  /** 「拉起桌宠」执行器：本 apply 实例最多触发一次（见 createPetLauncher）。 */
  const launchPetOnce = createPetLauncher(isRecord(deps) ? deps : {})

  /** agentId → 'idle' | 'running'（存活 agent 的最近一次状态）。 */
  const agents = new Map()
  /** `agentId:turn` → true：同一 turn 的 task/error 只报一次（agent/error 与 turn/end 二选一）。 */
  const reportedErrors = new Map()
  /** disposer 是否已执行（幂等 + 阻止退出后的事件写入）。 */
  let disposed = false
  /** ctx.on 返回的取消订阅函数。 */
  const listeners = []
  /** 心跳定时器（disposer 清除）。 */
  let timer = null

  /** events.jsonl 写入器（独立单元，见 createEventLog）。 */
  const eventLog = createEventLog({ dir, rotateBytes, maxLineBytes })

  /**
   * 写一条 bridge 事件（本地别名；写入器负责白名单/64KB/轮转/失败只 warn）。
   * v4：再包一层 try/catch，保证任何写入单元异常都不会沿事件 handler 泄漏（§4.1）。
   * @param {string} type 事件类型（必须来自 DSH_EVENT_TYPES）
   * @param {object} payload 事件 payload
   * @returns {boolean} 是否成功写入
   */
  function appendEvent(type, payload) {
    try {
      return eventLog.appendEvent(type, payload)
    } catch (error) {
      warn(`event append failed: ${errorText(error)}`)
      return false
    }
  }

  /** 当前 running 状态的 agent 数（status.json 的 running/agents 字段）。 */
  function runningAgentCount() {
    let count = 0
    for (const status of agents.values()) {
      if (status === 'running') count += 1
    }
    return count
  }

  /** 本次写入专用的临时文件路径（M-8：进程 + 实例 + 序号唯一，避免并发写互踩）。 */
  function nextStatusTmpPath() {
    statusWriteSeq += 1
    return join(dir, `.${BRIDGE_STATUS_FILE}.${pid}.${instanceId}.${statusWriteSeq}.tmp`)
  }

  /**
   * 覆盖写 status.json（同目录唯一 tmp → renameSync 原子替换）。
   * v4：帧带 `compat`；整个函数（含帧构造）都 try/catch —— 心跳路径绝不能把异常抛给宿主。
   * 失败只 warn；offline=true 是插件退出时的显式离线标记（即使 ts 新鲜也不 online）。
   */
  function writeStatus(offline) {
    try {
      const runningAgents = runningAgentCount()
      const frame = {
        ts: Date.now(),
        running: runningAgents > 0,
        agents: runningAgents,
        lastEventAt: eventLog.lastEventAt,
        lastType: eventLog.lastType,
        offline,
        // v4：每帧（启动/心跳/离线）都自述兼容信息，桌宠无需读 control.json 也能判定。
        compat
      }
      const tmpPath = nextStatusTmpPath()
      try {
        // F8：状态文件只对当前用户可读写；tmp 与正式文件同目录，rename 才是原子的。
        writeFileSync(tmpPath, `${JSON.stringify(frame)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmpPath, statusPath)
      } catch (error) {
        warn(`status write failed: ${statusPath} (${errorText(error)})`)
        // rename 失败时清理本次 tmp，避免留下半截临时文件（清理失败同样只忽略）。
        try {
          unlinkSync(tmpPath)
        } catch {
          // tmp 可能还没创建成功，无需处理。
        }
      }
    } catch (error) {
      warn(`status frame failed: ${errorText(error)}`)
    }
  }

  /** control.json 本次写入专用的临时文件路径（同目录 + 进程/实例/序号唯一，rename 原子替换）。 */
  function nextControlTmpPath() {
    controlWriteSeq += 1
    return join(dir, `.${BRIDGE_CONTROL_FILE}.${pid}.${instanceId}.${controlWriteSeq}.tmp`)
  }

  /**
   * 原子覆盖写 control.json（v2 契约 §3.2 + v4 compat）：
   * `{ schemaVersion, bridgeVersion, ts, action, dshPid, compat }`。
   * 只在 apply（attached）/ dispose（detached）时调用，**心跳不重写**（减少写盘）。
   * v4：整个函数 try/catch，绝不向宿主抛错。
   * @param {'attached' | 'detached'} action 桥实例状态
   */
  function writeControl(action) {
    try {
      const frame = {
        schemaVersion: BRIDGE_CONTROL_SCHEMA_VERSION,
        bridgeVersion: BRIDGE_PLUGIN_VERSION,
        ts: Date.now(),
        action,
        dshPid: pid,
        // v4：attached/detached 都带 compat，桌宠可用任一帧做运行时兼容判定。
        compat
      }
      const tmpPath = nextControlTmpPath()
      try {
        writeFileSync(tmpPath, `${JSON.stringify(frame)}\n`, { encoding: 'utf8', mode: 0o600 })
        renameSync(tmpPath, controlPath)
      } catch (error) {
        warn(`control write failed: ${controlPath} (${errorText(error)})`)
        try {
          unlinkSync(tmpPath)
        } catch {
          // tmp 可能还没创建成功，无需处理。
        }
      }
    } catch (error) {
      warn(`control frame failed: ${errorText(error)}`)
    }
  }

  /**
   * 同一 agent/session + turn 的 task/error 只报一次（agent/error 与 turn/end 先到先得）。
   * @param {string} id agentId（真实 DSH 中等于 sessionId）
   * @param {number | null} turn turn 序号（缺失时用 `?` 归并）
   * @returns {boolean} 是否应写这条 task/error
   */
  function markErrorReportedOnce(id, turn) {
    const key = `${id}#${turn === null ? '?' : turn}`
    if (reportedErrors.has(key)) return false
    reportedErrors.set(key, true)
    // FIFO 上限：B7 只关心最近若干 turn；旧键淘汰不会影响真实去重语义。
    while (reportedErrors.size > ERROR_DEDUPE_LIMIT) {
      const oldest = reportedErrors.keys().next().value
      if (oldest === undefined) break
      reportedErrors.delete(oldest)
    }
    return true
  }

  /**
   * 订阅全局事件并记录取消函数。
   *
   * 注意：`ctx.on` 的**读取**（getter）故意不放进下面的 try —— 投毒/损坏的 ctx 在这里抛错时
   * 直接冒泡到 `apply` 外层兜底（写 `bridge-error.json` + no-op disposer），这既是 §4.1
   * "apply 失败隔离"的兜底路径，也让失败可诊断；`ctx.on(...)` **调用**失败则只 warn 跳过，
   * 桥尽量降级继续（无事件的桥仍能提供 control/status 心跳，比整体失败有用）。
   */
  function subscribe(eventName, handler) {
    if (!ctx || typeof ctx.on !== 'function') {
      warn(`ctx.on unavailable; skip subscription: ${eventName}`)
      return
    }
    try {
      const off = ctx.on(eventName, handler, { global: true })
      if (typeof off === 'function') listeners.push(off)
    } catch (error) {
      warn(`subscribe ${eventName} failed: ${errorText(error)}`)
    }
  }

  /**
   * `agent/status`：idle→running 写 task/start，running→idle 写 task/end，随后刷新心跳。
   * F11：真实 DSH payload 是 `{ status, agent }` —— 优先读 payload.status，
   * 再回退 agent.status（旧形态/自定义 emit 兼容）。
   */
  function handleAgentStatus(payload) {
    if (disposed) return
    try {
      if (!isRecord(payload)) return
      const agent = payload.agent
      if (!isRecord(agent)) return
      const status =
        typeof payload.status === 'string' ? payload.status : agent.status
      if (typeof status !== 'string' || !AGENT_STATUSES.has(status)) return
      const id = agentIdOf(agent)
      const previous = agents.get(id) ?? 'idle'
      agents.set(id, status)
      if (status === previous) {
        // DSH 只在变化时 emit；重复帧不重复记事件，只刷新状态。
        writeStatus(false)
        return
      }
      appendEvent(status === 'running' ? 'task/start' : 'task/end', { agent: id, status })
      writeStatus(false)
    } catch (error) {
      warn(`agent/status handler failed: ${errorText(error)}`)
    }
  }

  /** `agent/created`：新 agent 初始 idle。 */
  function handleAgentCreated(payload) {
    if (disposed) return
    try {
      if (!isRecord(payload)) return
      const agent = payload.agent
      if (!isRecord(agent)) return
      agents.set(agentIdOf(agent), 'idle')
    } catch (error) {
      warn(`agent/created handler failed: ${errorText(error)}`)
    }
  }

  /**
   * `agent/error`（agent-scoped，真实 payload `{ turn, step, error, agent }`）→ task/error。
   * 与 `turn/end(reason.kind=error)` 同 turn 去重：先到先得。
   */
  function handleAgentError(payload) {
    if (disposed) return
    try {
      if (!isRecord(payload)) return
      const agent = payload.agent
      if (!isRecord(agent)) return
      const id = agentIdOf(agent)
      const turn = finiteIntegerOrNull(payload.turn)
      if (!markErrorReportedOnce(id, turn)) return
      const eventPayload = { agent: id, reasonKind: 'error' }
      if (turn !== null) eventPayload.turn = turn
      const step = finiteIntegerOrNull(payload.step)
      if (step !== null) eventPayload.step = step
      const message = nonEmptyString(errorMessageOf(payload.error), ERROR_MESSAGE_MAX_CHARS)
      if (message !== undefined) eventPayload.message = message
      appendEvent('task/error', eventPayload)
    } catch (error) {
      warn(`agent/error handler failed: ${errorText(error)}`)
    }
  }

  /**
   * `agent/disposed`：移除 agent。M-7：若它上一状态是 running（会话取消/关闭），
   * 先补一条 task/end（reason: 'disposed'），保证事件流有终止信号；再刷新心跳。
   */
  function handleAgentDisposed(payload) {
    if (disposed) return
    try {
      if (!isRecord(payload)) return
      const agent = payload.agent
      if (!isRecord(agent)) return
      const id = agentIdOf(agent)
      const previous = agents.get(id)
      // M-7：若该 agent 上一状态是 running（会话取消/关闭），先补一条 task/end
      // （reason: 'disposed'）再删除，保证事件流有终止信号。
      if (previous === 'running') {
        appendEvent('task/end', { agent: id, reason: 'disposed' })
      }
      agents.delete(id)
      writeStatus(false)
    } catch (error) {
      warn(`agent/disposed handler failed: ${errorText(error)}`)
    }
  }

  /**
   * 构造 session/event 透传 payload。
   * **只带安全标量，不含 user 输入 / reasoning / tool 参数与结果正文**；
   * 唯一例外（v2 契约 §3.1）：`assistant/message` 额外带 `text` = assistant 输出文本
   * （多 text 块 `\n` join → trim → ≤8000 字符；空文本/纯 tool-call 消息不写该键）。
   * 字段缺失时省略对应键，绝不塞 undefined；字段总量受限 → 64KB 上限实际不可能被撑爆。
   */
  function buildSessionPayload(session, event) {
    const payload = {}
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId !== undefined) payload.sessionId = sessionId
      const eventType = event?.type
      if (typeof eventType === 'string' && eventType.length > 0) payload.eventType = eventType
      const seq = finiteIntegerOrNull(event?.seq)
      if (seq !== null) payload.seq = seq
      const data = isRecord(event?.data) ? event.data : undefined
      if (data !== undefined) {
        const turn = finiteIntegerOrNull(data.turn)
        if (turn !== null) payload.turn = turn
        const step = finiteIntegerOrNull(data.step)
        if (step !== null) payload.step = step
        const reasonKind = reasonKindOf(data)
        if (reasonKind !== undefined) payload.reasonKind = reasonKind
        // v2：只有 assistant/message 带文本正文（模型输出可以展示；其它事件正文仍不写）。
        if (eventType === 'assistant/message') {
          const text = extractAssistantText(data)
          if (text !== undefined) payload.text = text
        }
      }
    } catch (error) {
      warn(`session payload build failed: ${errorText(error)}`)
    }
    return payload
  }

  /**
   * `turn/end`（H-3）：`event.data.reason.kind === 'error'` → task/error（不再透传
   * session/event）；其它 reason.kind（completed/max-tokens/blocked/aborted…）→ session/event。
   */
  function handleTurnEnd(session, event) {
    const data = isRecord(event.data) ? event.data : {}
    const reasonKind = reasonKindOf(data)
    if (reasonKind === 'error') {
      const sessionId = sessionIdOf(session) ?? '(unknown)'
      const turn = finiteIntegerOrNull(data.turn)
      if (!markErrorReportedOnce(sessionId, turn)) return
      appendEvent('task/error', buildSessionPayload(session, event))
      return
    }
    appendEvent('session/event', buildSessionPayload(session, event))
  }

  /**
   * `session/event`：只看 durable 事件（真实签名 `(session, event)`）。
   * turn/end 按 reason.kind 分流；assistant/message、tool/result 透传；
   * 其余（token 流、step 细节等）忽略，避免高频刷盘。
   */
  function handleSessionEvent(session, event) {
    if (disposed) return
    try {
      if (!isRecord(event)) return
      const eventType = event.type
      if (typeof eventType !== 'string' || eventType.length === 0) return
      if (eventType === 'turn/end') {
        handleTurnEnd(session, event)
        return
      }
      if (!NOTABLE_SESSION_EVENTS.has(eventType)) return
      appendEvent('session/event', buildSessionPayload(session, event))
    } catch (error) {
      warn(`session/event handler failed: ${errorText(error)}`)
    }
  }

  // v4：启动预检（建目录 + 写探针）——目录不可写时 fail-fast 到 apply 外层兜底，
  // 否则桥会变成永远写不出 status/control 的僵尸桥（见 assertBridgeDirWritable）。
  assertBridgeDirWritable(dir)
  subscribe('agent/status', handleAgentStatus)
  subscribe('agent/created', handleAgentCreated)
  subscribe('agent/error', handleAgentError)
  subscribe('agent/disposed', handleAgentDisposed)
  subscribe('session/event', handleSessionEvent)

  try {
    // v4：心跳回调**再包一层** try/catch（writeStatus 内部也全包）—— setInterval 回调里
    // 抛出的异常是脱离 apply 调用栈的异步孤儿抛错，会直接 fatal 宿主（§4.1/E10）。
    timer = setInterval(() => {
      try {
        writeStatus(false)
      } catch (error) {
        warn(`heartbeat tick failed: ${errorText(error)}`)
      }
    }, BRIDGE_HEARTBEAT_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  } catch (error) {
    warn(`heartbeat setup failed: ${errorText(error)}`)
  }

  // 启动即写一帧：消费方（B7）无需等第一个 5s 心跳就能看到 status.json。
  writeStatus(false)
  // v2：apply 即 attached（HMR 重载后也靠这一帧让桌宠取消 detached grace 等待）。
  writeControl('attached')
  // v2：launchPet=true 时拉起桌宠一次（放在 status/control 写完之后，桌宠一启动就能读到桥文件；
  // 无配置/被环境变量禁用/失败都只 warn，绝不影响宿主）。
  launchPetOnce(cfg)
  // v4：真正启动成功 → 清掉上一次失败留下的旧诊断（best-effort，失败只 warn）。
  clearBridgeDiagnostic(dir)

  /** disposer：停心跳、退订、写最后一帧离线标记 + control detached；重复调用无副作用。 */
  return function dispose() {
    if (disposed) return
    disposed = true
    // v4：整个 disposer 也兜底 try/catch —— cordis 在宿主卸载路径调用它，绝不能抛错。
    try {
      try {
        if (timer !== null) clearInterval(timer)
      } catch (error) {
        warn(`heartbeat clear failed: ${errorText(error)}`)
      }
      timer = null
      for (const off of listeners.splice(0).reverse()) {
        try {
          if (typeof off === 'function') off()
        } catch (error) {
          warn(`unsubscribe failed: ${errorText(error)}`)
        }
      }
      // 退出帧固定报 running:false / agents:0（不再有 live agent 在跑），
      // 并带上显式离线标记：即使 ts 还在 TTL 内，消费方也必须判 offline（契约 §8）。
      agents.clear()
      eventLog.close()
      writeStatus(true)
      // v2：dispose 即 detached（DSH 退出 / HMR 卸载 / 禁用）。注意它不能单独证明 DSH 退出，
      // 消费方需按 design §3.2 加 grace 等待 attached。
      writeControl('detached')
    } catch (error) {
      warn(`dispose failed: ${errorText(error)}`)
    }
  }
}

/**
 * 插件入口（cordis functional plugin）。
 *
 * 必须是箭头函数 —— 见文件头注释的 cordis isConstructor 说明：普通 `function` 声明会被
 * cordis 当作构造器 `new fn(ctx, config)`，返回的 disposer 会被丢弃。
 *
 * v4（§4.1）：`apply` 本身**绝不 throw**。真正的启动逻辑在 `startBridge()`；任何启动失败
 * （目录不可建/不可写、投毒 ctx、spawn 注入异常等）统一在这里兜底：
 * 写 `bridge-error.json` 诊断 + warn + 返回 no-op disposer，宿主（DSH）完全不受影响。
 *
 * @param {object} ctx cordis 插件上下文（只用 ctx.on）
 * @param {object} [config] 插件配置（cordis.patch.yml row 的 config）
 * @param {{ spawn?: Function, env?: Record<string, string | undefined> }} [deps]
 *   测试注入点（生产省略）：spawn/env/resolveExecutable 覆写，仅用于单测
 * @returns {() => void} disposer（失败时是 no-op `() => {}`）
 */
export const apply = (ctx, config = {}, deps = {}) => {
  try {
    return startBridge(ctx, config, deps)
  } catch (error) {
    warn(`apply failed; host continues with no-op disposer (${errorText(error)})`)
    try {
      writeBridgeDiagnostic(config, 'apply', error)
    } catch (diagnosticError) {
      // 诊断写盘自身的意外异常也不能再抛（writeBridgeDiagnostic 内部已全包，这里是最后保险）。
      warn(`bridge diagnostic failed (${errorText(diagnosticError)})`)
    }
    // no-op disposer：cordis 仍会把它作为 effect 收集，卸载时调用完全无害。
    return () => {}
  }
}
