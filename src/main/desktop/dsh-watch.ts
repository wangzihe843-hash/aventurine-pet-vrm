/**
 * DSH 桥文件尾随器（Wave 2 B7）——主进程侧，环境中立可单测。
 *
 * 背景（PLAN §8 / §9 / docs/wave2-integration.md §3-B7）：
 * A5 桥插件把 DSH 运行状态写到 `~/.dsh/aventurine-pet/`：
 * - `status.json`：每 5s 覆盖写的心跳（`ts/running/agents/lastEventAt/lastType/offline`）；
 * - `events.jsonl`：追加写的 NDJSON（每行一个 `DshEvent`，插件负责 5MB 轮转）。
 * 本模块只**读**这两个文件，不依赖 Electron / renderer：
 * - `status.json` 轮询（默认 750ms）→ `isDshBridgeStatusFile` → `toDshStatus(now)`，
 *   在线判定完全复用 `src/shared/bridge-schema.ts`（未来 ts 不算 online、`offline:true`
 *   显式离线、TTL 30s），本文件不复制任何魔法字符串；
 * - `events.jsonl` 按**字节偏移**增量尾随：**启动时以当前 EOF 为基线**（不回放启动前的
 *   历史事件，避免 renderer 启动瞬间表演旧任务），之后只读新增字节；半行留到下次，
 *   轮转（inode 变化）或截断（`size < offset`）时游标归零；单行 64KB 上限、单次轮询最多
 *   读 256KB，**绝不一次性读入整个文件**；
 * - `control.json` 轮询（Wave 3 A3）：与 status 共用 750ms 定时器，**mtime+size 变化才读**
 *   （原子写 tmp→rename 会更新 mtime），单次读取 ≤64KB；用 `parseDshBridgeControlFile`
 *   解析，脏数据静默忽略；`action+ts` 去重后经 `onControl(cb)` 通知订阅者；
 *   `attached` = 桥已加载，`detached` = 桥被卸载（DSH 退出或 HMR，消费方须用 grace 区分）；
 * - 文件缺失 / 坏 JSON / 权限错误 → 返回离线默认值 + 首次 warn，**绝不抛异常**；
 * - 定时器 `unref()`，不阻止 app 退出；`stop()` 后不再触发任何回调。
 *
 * 目录：默认 `~/.dsh/aventurine-pet`（`os.homedir()` + 契约常量）。
 * 可用 env `PET_DSH_DIR` 覆盖（测试/排障用；支持 `~/` 展开），也可直接传 `options.dir`。
 *
 * 使用方（`src/main/ipc/dsh.ts`）：
 * ```ts
 * const watcher = createDshWatcher()
 * watcher.onEvent((event) => { if (watcher.getStatus().online) ctx.broadcast('dsh-event', event) })
 * watcher.onControl((control) => lifecycle.handleControl(control)) // Wave 3 A3
 * watcher.onStatusChanged((status) => lifecycle.handleStatus(status))
 * watcher.start()
 * app.once('will-quit', () => watcher.stop())
 * ```
 */
import { Buffer } from 'node:buffer'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  BRIDGE_CONTROL_FILE,
  BRIDGE_DIR_NAME,
  BRIDGE_EVENTS_FILE,
  BRIDGE_MAX_LINE_BYTES,
  BRIDGE_STATUS_FILE,
  isDshBridgeStatusFile,
  parseDshBridgeControlFile,
  parseDshEventLine,
  toDshStatus
} from '@shared/bridge-schema'
import type { DshBridgeControlFile, DshBridgeStatusFile } from '@shared/bridge-schema'
import type { DshEvent, DshStatus } from '@shared/types'

/** 默认轮询周期（毫秒）。契约要求 500–1000ms；750ms 在时延与磁盘开销之间折中。 */
export const DSH_POLL_INTERVAL_MS = 750

/** 桥目录覆盖环境变量（与桥插件的 `AVENTURINE_BRIDGE_DIR` 区分：本变量只影响 app 读取侧）。 */
export const DSH_DIR_ENV = 'PET_DSH_DIR'

/** `status.json` 允许读取的最大字节数（心跳文件应 <1KB；防御超大/伪造文件一次性读入）。 */
const MAX_STATUS_BYTES = 256 * 1024

/**
 * `control.json` 单次读取上限（契约要求 ≤64KB；共享层 `parseDshBridgeControlFile`
 * 还会按 `BRIDGE_CONTROL_MAX_BYTES` 做更严格的 schema 校验）。
 */
const MAX_CONTROL_BYTES = 64 * 1024

/** 单次轮询最多读取的事件字节数（防止历史积压时同步读阻塞主进程）。 */
const MAX_READ_CHUNK_BYTES = 256 * 1024

/** 轮询周期合法范围（测试可传更小值，但不允许 0/负数造成忙等）。 */
const MIN_POLL_MS = 50
const MAX_POLL_MS = 60_000

/** 日志前缀（未注入 logger 时用 console.warn）。 */
const LOG_PREFIX = '[dsh-watch]'

/** 允许注入的最小日志接口（与 `src/main/logger.ts` 的 Logger 结构兼容，避免耦合）。 */
export interface DshWatchLogger {
  warn(message: string, meta?: unknown): void
  info?(message: string, meta?: unknown): void
}

/** `createDshWatcher` 选项（全部可省略；单测用 temp dir + 注入时钟）。 */
export interface CreateDshWatcherOptions {
  /** 桥目录覆盖（优先级高于 env / 默认值；支持 `~/` 展开）。 */
  dir?: string
  /** 时间源（毫秒；默认 `Date.now`；单测注入假时钟以覆盖 TTL/未来时间戳）。 */
  now?: () => number
  /** 轮询周期（毫秒；默认 750，钳制到 50–60000）。 */
  pollMs?: number
  /** 日志接口（默认 `console.warn`；测试注入 spy 断言「只 warn 一次」）。 */
  logger?: DshWatchLogger
}

/** 尾随器对外 API。 */
export interface DshWatcher {
  /** 实际使用的桥目录（排障/测试断言用）。 */
  readonly dir: string
  /** 当前缓存的 DSH 状态（离线默认值 / 由 status.json + 新鲜度折算；返回副本）。 */
  getStatus(): DshStatus
  /** 订阅事件流（返回取消订阅函数）。 */
  onEvent(callback: (event: DshEvent) => void): () => void
  /** 订阅状态变化（只在 online/running/lastEventAt/lastType 实际变化时触发）。 */
  onStatusChanged(callback: (status: DshStatus) => void): () => void
  /** 订阅 control.json 控制帧（attached/detached；同 action+ts 去重，脏数据不触发）。 */
  onControl(callback: (control: DshBridgeControlFile) => void): () => void
  /** 最近一次解析成功的控制帧（无 → null；返回副本）。 */
  getControl(): DshBridgeControlFile | null
  /** 启动轮询（幂等；立即轮询一次再进入定时器）。 */
  start(): void
  /** 停止轮询（幂等；之后不再触发事件/状态回调）。 */
  stop(): void
  /** 是否正在轮询（测试/排障用）。 */
  isRunning(): boolean
}

/** 离线默认状态（`toDshStatus(null, now)` 的同形结果，避免每帧新建）。 */
const OFFLINE_STATUS: DshStatus = {
  online: false,
  running: false,
  lastEventAt: 0,
  lastType: null
}

/** 判断 unknown 是否 Node 的 `ErrnoException` 且 code 属于给定集合。 */
function isErrno(error: unknown, ...codes: string[]): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && codes.includes(code)
}

/** 把 unknown 异常压成一行可读文本（不把整个对象写进日志）。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 展开 `~/` 前缀（只支持当前用户；其它形式原样返回）。 */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * 解析桥目录：`options.dir` > env `PET_DSH_DIR` > `~/.dsh/aventurine-pet`。
 * 非空字符串才生效；空/空白 → 回退下一优先级（避免 ``dir: ''`` 让路径变成相对 cwd）。
 */
export function resolveDshDir(options: { dir?: string; envDir?: string } = {}): string {
  const explicit = typeof options.dir === 'string' ? options.dir.trim() : ''
  if (explicit.length > 0) return expandHomePath(explicit)
  const fromEnv = typeof options.envDir === 'string' ? options.envDir.trim() : ''
  if (fromEnv.length > 0) return expandHomePath(fromEnv)
  return join(homedir(), '.dsh', BRIDGE_DIR_NAME)
}

/** 归一化轮询周期（非法/越界钳制；保证定时器可用）。 */
export function normalizePollMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DSH_POLL_INTERVAL_MS
  }
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(value)))
}

/** 浅比较两份 DshStatus（避免相同心跳内容重复触发回调）。 */
function statusEquals(a: DshStatus, b: DshStatus): boolean {
  return (
    a.online === b.online &&
    a.running === b.running &&
    a.lastEventAt === b.lastEventAt &&
    a.lastType === b.lastType
  )
}

/** 取默认 logger（console.warn；info 不输出，避免刷屏）。 */
function defaultLogger(): DshWatchLogger {
  return {
    warn(message: string, meta?: unknown): void {
      if (meta === undefined) console.warn(LOG_PREFIX, message)
      else console.warn(LOG_PREFIX, message, meta)
    }
  }
}

/**
 * 创建 DSH 桥文件尾随器。
 *
 * 行为保证：
 * - 构造时不触碰文件系统（可安全在 IPC 注册阶段创建）；`start()` 才轮询；
 * - 所有 fs/JSON 错误只 warn（首次）并降级为离线/跳过，绝不向调用方抛；
 * - 事件/状态回调逐个 try/catch 隔离，单个回调抛错不影响其它回调与后续轮询。
 */
export function createDshWatcher(options: CreateDshWatcherOptions = {}): DshWatcher {
  const now: () => number = typeof options.now === 'function' ? options.now : (): number => Date.now()
  const pollMs = normalizePollMs(options.pollMs)
  const logger: DshWatchLogger =
    options.logger && typeof options.logger.warn === 'function' ? options.logger : defaultLogger()
  const dir = resolveDshDir({ dir: options.dir, envDir: process.env[DSH_DIR_ENV] })
  const statusPath = join(dir, BRIDGE_STATUS_FILE)
  const eventsPath = join(dir, BRIDGE_EVENTS_FILE)
  const controlPath = join(dir, BRIDGE_CONTROL_FILE)

  /** 当前 DSH 状态（离线默认值起）。 */
  let status: DshStatus = { ...OFFLINE_STATUS }
  /** 轮询定时器（null = 未启动）。 */
  let timer: ReturnType<typeof setInterval> | null = null
  /** events.jsonl 已消费到的字节偏移（半行所占字节也计入 offset）。 */
  let eventOffset = 0
  /** 尚未遇到换行的半行字节（下次轮询拼接）。 */
  let eventPending: Buffer = Buffer.alloc(0)
  /** 是否处于「超长行丢弃」模式（跳过直到下一个换行）。 */
  let skippingLongLine = false
  /** 上一次看到的 events.jsonl inode（轮转检测；0 = 平台不支持）。 */
  let lastEventsIno: number | null = null
  /** 最近一次读取 control.json 的 mtime+size 签名（相同则跳过读取）。 */
  let controlSignature: string | null = null
  /** 最近一次解析成功的控制帧（用于 action+ts 去重）。 */
  let lastControl: DshBridgeControlFile | null = null

  /** 首次 warn 标记（文件恢复健康后重置，之后再次异常还能再 warn 一次）。 */
  let statusWarned = false
  let eventsWarned = false
  let controlWarned = false
  let runtimeWarned = false
  let eventLineDroppedWarned = false

  const eventListeners = new Set<(event: DshEvent) => void>()
  const statusListeners = new Set<(changed: DshStatus) => void>()
  const controlListeners = new Set<(control: DshBridgeControlFile) => void>()

  /** 首次 warn：status 读取/解析异常。 */
  function warnStatusOnce(message: string): void {
    if (statusWarned) return
    statusWarned = true
    logger.warn(message)
  }

  /** 首次 warn：events 读取异常（非 ENOENT）。 */
  function warnEventsOnce(message: string): void {
    if (eventsWarned) return
    eventsWarned = true
    logger.warn(message)
  }

  /** 首次 warn：轮询内部意外异常（兜底，正常路径不会走到）。 */
  function warnRuntimeOnce(message: string, error: unknown): void {
    if (runtimeWarned) return
    runtimeWarned = true
    logger.warn(`${message}: ${errorText(error)}`)
  }

  /** 首次 warn：坏行/超长行被丢弃（脏输入不应刷屏）。 */
  function warnEventLineDroppedOnce(message: string): void {
    if (eventLineDroppedWarned) return
    eventLineDroppedWarned = true
    logger.warn(message)
  }

  /** 首次 warn：control.json 读取/解析异常（脏数据静默忽略，不刷屏）。 */
  function warnControlOnce(message: string): void {
    if (controlWarned) return
    controlWarned = true
    logger.warn(message)
  }

  /** 状态变化安全分发（回调抛错只 warn 一次，不打断其它回调）。 */
  function dispatchStatus(next: DshStatus): void {
    for (const listener of [...statusListeners]) {
      try {
        listener({ ...next })
      } catch (error) {
        warnRuntimeOnce('status listener failed', error)
      }
    }
  }

  /** 事件安全分发（同上）。 */
  function dispatchEvent(event: DshEvent): void {
    for (const listener of [...eventListeners]) {
      try {
        listener(event)
      } catch (error) {
        warnRuntimeOnce('event listener failed', error)
      }
    }
  }

  /** 控制帧安全分发（回调抛错只 warn 一次，不打断其它回调）。 */
  function dispatchControl(control: DshBridgeControlFile): void {
    for (const listener of [...controlListeners]) {
      try {
        listener({ ...control })
      } catch (error) {
        warnRuntimeOnce('control listener failed', error)
      }
    }
  }

  /** 重置事件游标（轮转/截断时调用）；保留 inode 由调用方随后更新。 */
  function resetEventCursor(reason: string): void {
    eventOffset = 0
    eventPending = Buffer.alloc(0)
    skippingLongLine = false
    logger.info?.(`events cursor reset (${reason})`)
  }

  /**
   * 启动时建立事件游标基线（M-1）。
   *
   * 旧实现 `eventOffset = 0` → `start()` 的首次轮询会从文件头重放**启动前**的历史事件，
   * 主进程把它们当新事件广播，renderer 按当前时钟重演旧任务（可能立刻 busy/报错误动画）。
   * 修复：启动瞬间先取 EOF 作为基线，此后只读新增字节。
   *
   * - 文件存在 → offset = 当前 size（忽略历史）；
   * - 文件不存在 / 不可 stat → offset = 0：插件之后创建文件时按「全部是新事件」读取
   *   （这些行确实写于本进程启动之后，不能丢）；
   * - 任何异常都降级为 0，不向调用方抛（启动不能被桥文件故障阻断）。
   */
  function establishEventBaseline(): void {
    try {
      const stats = statSync(eventsPath)
      if (stats.isFile()) {
        eventOffset = stats.size
        lastEventsIno = stats.ino
        logger.info?.(`events baseline at EOF (${eventOffset}B)`)
        return
      }
    } catch {
      // 文件缺失是最常见的正常情况（DSH 未运行）：基线 0，文件出现后读取全部新增。
    }
    eventOffset = 0
    lastEventsIno = null
  }

  /** 读取并折算 status.json；任何异常 → null（离线默认值）。 */
  function readStatusFile(): DshBridgeStatusFile | null {
    try {
      const stats = statSync(statusPath)
      if (!stats.isFile()) {
        throw Object.assign(new Error('status.json is not a regular file'), { code: 'ENOTFILE' })
      }
      if (stats.size > MAX_STATUS_BYTES) {
        throw Object.assign(
          new Error(`status.json too large (${stats.size}B > ${MAX_STATUS_BYTES}B)`),
          { code: 'EFBIG' }
        )
      }
      const raw = readFileSync(statusPath, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw Object.assign(new Error('status.json invalid JSON'), { code: 'EPARSE' })
      }
      if (!isDshBridgeStatusFile(parsed)) {
        throw Object.assign(new Error('status.json schema mismatch'), { code: 'ESCHEMA' })
      }
      return parsed
    } catch (error) {
      // 文件缺失是最常见的正常情况（DSH 未安装/未运行桥插件）：只第一次 warn，便于排障。
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) {
        warnStatusOnce(`status.json not found: ${statusPath}`)
      } else {
        warnStatusOnce(`status.json unreadable: ${statusPath} (${errorText(error)})`)
      }
      return null
    }
  }

  /** 轮询 status.json：折算 DshStatus，变化时通知订阅者。 */
  function pollStatus(): void {
    const file = readStatusFile()
    // 成功解析后重置告警标记：之后再次损坏还能重新 warn 一次。
    if (file) statusWarned = false

    const next = toDshStatus(file, now())
    if (statusEquals(status, next)) return
    status = next
    dispatchStatus(next)
  }

  /**
   * 轮询 control.json（Wave 3 A3）。
   *
   * - 先 stat：mtime+size 未变 → 直接返回（750ms 轮询不重复读同一个文件）；
   * - 单文件 ≤64KB（共享层 parse 还会按 `BRIDGE_CONTROL_MAX_BYTES` 做 schema 校验）；
   * - 文件缺失是正常状态（桥未安装/DSH 未运行）：静默；其它异常首次 warn；
   * - 解析失败（脏数据/超限/未来 schema）→ 静默忽略，**绝不抛**；
   * - 同 `action+ts` 去重：原子 rename 可能让 mtime 变化但内容相同，不重复通知。
   */
  function pollControl(): void {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(controlPath)
    } catch (error) {
      // 文件被删除（DSH 退出时桥目录清理/测试夹具）：清签名，下次出现再读取。
      controlSignature = null
      if (!isErrno(error, 'ENOENT', 'ENOTDIR')) {
        warnControlOnce(`control.json unavailable: ${controlPath} (${errorText(error)})`)
      }
      return
    }
    if (!stats.isFile()) {
      warnControlOnce(`control.json unreadable: ${controlPath} (not a regular file)`)
      return
    }
    if (stats.size > MAX_CONTROL_BYTES) {
      warnControlOnce(
        `control.json too large (${stats.size}B > ${MAX_CONTROL_BYTES}B), ignored`
      )
      return
    }

    const signature = `${stats.mtimeMs}:${stats.size}`
    if (signature === controlSignature) return
    controlSignature = signature

    try {
      const frame = parseDshBridgeControlFile(readFileSync(controlPath, 'utf8'))
      if (!frame) {
        warnControlOnce('control.json invalid (schema mismatch / bad JSON), ignored')
        return
      }
      if (lastControl && lastControl.action === frame.action && lastControl.ts === frame.ts) {
        return
      }
      lastControl = frame
      controlWarned = false
      dispatchControl(frame)
    } catch (error) {
      warnControlOnce(`control.json read failed: ${controlPath} (${errorText(error)})`)
    }
  }

  /** 处理一条完整行（字节已去换行；坏行/超长行静默跳过）。 */
  function handleLine(lineBytes: Buffer): void {
    if (lineBytes.length > BRIDGE_MAX_LINE_BYTES) {
      warnEventLineDroppedOnce(
        `event line dropped: ${lineBytes.length}B > BRIDGE_MAX_LINE_BYTES ${BRIDGE_MAX_LINE_BYTES}B`
      )
      return
    }
    const line = lineBytes.toString('utf8')
    if (line.trim().length === 0) return
    const event = parseDshEventLine(line)
    if (!event) {
      // 半行/脏行/非 JSON：契约要求返回 null 且不抛；这里只首次 warn，避免刷屏。
      warnEventLineDroppedOnce('invalid events.jsonl line ignored')
      return
    }
    dispatchEvent(event)
  }

  /** 吸收一块新增字节：切行、处理完整行、把半行留到下次。 */
  function absorbChunk(chunk: Buffer): void {
    let data = eventPending.length > 0 ? Buffer.concat([eventPending, chunk]) : chunk

    // 超长行丢弃模式：先跳过本块里（若有）的换行符，再处理换行后的内容。
    if (skippingLongLine) {
      const newline = data.indexOf(0x0a)
      if (newline === -1) {
        eventPending = Buffer.alloc(0)
        return
      }
      data = data.subarray(newline + 1)
      skippingLongLine = false
    }

    let start = 0
    for (;;) {
      const newline = data.indexOf(0x0a, start)
      if (newline === -1) break
      handleLine(data.subarray(start, newline))
      start = newline + 1
    }

    const rest = data.subarray(start)
    if (rest.length > BRIDGE_MAX_LINE_BYTES) {
      // 半行已超过单行上限：丢弃并跳过直到下一个换行，避免 pending 无界增长。
      eventPending = Buffer.alloc(0)
      skippingLongLine = true
      warnEventLineDroppedOnce(
        `event line dropped: partial line > BRIDGE_MAX_LINE_BYTES ${BRIDGE_MAX_LINE_BYTES}B`
      )
      return
    }
    // 复制一份，避免 subarray 持有整个读缓冲导致内存滞留。
    eventPending = rest.length > 0 ? Buffer.from(rest) : Buffer.alloc(0)
  }

  /** 轮询 events.jsonl：inode/大小检测轮转与截断 → 增量读 → 切行。 */
  function pollEvents(): void {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(eventsPath)
    } catch (error) {
      // events.jsonl 缺失是正常状态（DSH 未运行）：静默跳过；其它错误首次 warn。
      if (!isErrno(error, 'ENOENT', 'ENOTDIR')) {
        warnEventsOnce(`events.jsonl unavailable: ${eventsPath} (${errorText(error)})`)
      }
      return
    }
    if (!stats.isFile()) {
      warnEventsOnce(`events.jsonl unreadable: ${eventsPath} (not a regular file)`)
      return
    }

    // 轮转检测：桥插件把旧文件 rename 成 .1 后新建文件，inode 会变化（平台不支持时 ino=0）。
    if (
      lastEventsIno !== null &&
      stats.ino !== 0 &&
      lastEventsIno !== 0 &&
      stats.ino !== lastEventsIno
    ) {
      resetEventCursor('rotated (inode changed)')
    }
    lastEventsIno = stats.ino

    // 截断检测：游标超过当前文件大小 → 从头开始。
    if (stats.size < eventOffset) resetEventCursor('truncated (size < offset)')
    if (stats.size === eventOffset) return

    const toRead = Math.min(stats.size - eventOffset, MAX_READ_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(toRead)
    let fd: number | null = null
    try {
      fd = openSync(eventsPath, 'r')
      const bytesRead = readSync(fd, buffer, 0, toRead, eventOffset)
      if (bytesRead <= 0) return
      eventOffset += bytesRead
      absorbChunk(buffer.subarray(0, bytesRead))
    } catch (error) {
      warnEventsOnce(`events.jsonl read failed: ${eventsPath} (${errorText(error)})`)
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 关闭失败不影响已读取内容；下次轮询重新打开。
        }
      }
    }
  }

  /** 单次轮询：status + events + control（各自兜底，互不影响）。 */
  function poll(): void {
    try {
      pollStatus()
    } catch (error) {
      warnRuntimeOnce('status poll failed', error)
    }
    try {
      pollEvents()
    } catch (error) {
      warnRuntimeOnce('events poll failed', error)
    }
    try {
      pollControl()
    } catch (error) {
      warnRuntimeOnce('control poll failed', error)
    }
  }

  return {
    get dir(): string {
      return dir
    },
    getStatus(): DshStatus {
      return { ...status }
    },
    onEvent(callback: (event: DshEvent) => void): () => void {
      if (typeof callback !== 'function') return (): void => {}
      eventListeners.add(callback)
      return (): void => {
        eventListeners.delete(callback)
      }
    },
    onStatusChanged(callback: (changed: DshStatus) => void): () => void {
      if (typeof callback !== 'function') return (): void => {}
      statusListeners.add(callback)
      return (): void => {
        statusListeners.delete(callback)
      }
    },
    onControl(callback: (control: DshBridgeControlFile) => void): () => void {
      if (typeof callback !== 'function') return (): void => {}
      controlListeners.add(callback)
      return (): void => {
        controlListeners.delete(callback)
      }
    },
    getControl(): DshBridgeControlFile | null {
      return lastControl ? { ...lastControl } : null
    },
    start(): void {
      if (timer !== null) return
      // M-1：先建立 EOF 基线再轮询 —— 启动前的历史事件不回放（只转发启动后的新增）。
      establishEventBaseline()
      // 先立即轮询一次：启动即有缓存状态，不必等第一个心跳周期。
      poll()
      timer = setInterval(poll, pollMs)
      // unref：尾随器不阻止 app 退出（will-quit 时也会显式 stop）。
      timer.unref?.()
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    isRunning(): boolean {
      return timer !== null
    }
  }
}
