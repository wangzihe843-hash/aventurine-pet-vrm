/**
 * 主进程日志落盘（Wave 1 A3）—— **不 import electron**，目录由调用方注入。
 *
 * 设计要点（PLAN §5-A3、§17.5 A3）：
 * - 落盘文件：`<dir>/main.log`（主进程传 `join(app.getPath('userData'), 'logs')`）；
 * - 行格式：`ISO时间 [LEVEL] message {json meta}`（meta 可省略；message 内换行会被转义，保证一行一条）；
 * - 写前 `stat`：超过 `maxBytes`（默认 1MB）→ 把 `main.log` 轮转为 `main.log.1`（覆盖旧 .1）；
 * - 追加用 `appendFileSync`（同步、进程退出不丢日志）；
 * - **任何 fs 异常只 `console.error` 兜底，绝不向调用方抛出** —— 日志故障不能影响桌宠主流程；
 * - `dir` 不存在时自动 `mkdirSync(dir, { recursive: true })`；
 * - `now` 可注入，单测用固定时间断言行格式。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 日志级别（同时决定行内 `[LEVEL]` 与 console 镜像方法）。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志器接口：四个级别 + 文件路径 + 可选 flush。方法本身永不抛异常。 */
export interface Logger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  /** `main.log` 绝对路径（排障/测试断言用）。 */
  readonly filePath: string
  /** 当前实现为同步写、无缓冲；保留该接口给未来异步实现与调用方显式 flush。 */
  flush?(): void
}

/** `createLogger` 选项。 */
export interface CreateLoggerOptions {
  /** 日志目录（不存在会自动创建）。 */
  dir: string
  /** 单文件上限（字节）；超过后轮转为 `<file>.1`，默认 1MB。 */
  maxBytes?: number
  /** 时间源（默认 `() => new Date()`；单测注入固定时间）。 */
  now?: () => Date
  /** 是否同时把日志镜像到控制台（默认 false，只落盘）。 */
  console?: boolean
}

/** 默认单文件上限：1MB。 */
const DEFAULT_MAX_BYTES = 1024 * 1024

/** 日志文件名。 */
const LOG_FILE_NAME = 'main.log'

/** 把换行转义为字面量 `\n`：message 与 String 兜底 meta 共用，保证一条日志只占一行。 */
function escapeLineBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * `Error` → `{name, message, stack}`（stack 只取首行，避免多行/大对象）；
 * 不发散 `cause`（可能循环引用，且当前调用方不需要）。
 */
function formatErrorMeta(error: Error): string {
  const stackFirstLine = typeof error.stack === 'string' ? error.stack.split(/\r?\n/, 1)[0] : undefined
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: stackFirstLine
  })
}

/**
 * 格式化 meta 为行尾 JSON；不可序列化（BigInt / 循环引用 / 抛错 getter）时退化为 String，
 * 绝不让日志调用抛错；**所有分支都转义换行**，防 meta 伪造日志行（F9）。
 *
 * `Error` 的可枚举属性为空，`JSON.stringify(new Error('x'))` 会落成 `{}`；config-store 的
 * 全部 warn 都传 Error，因此特判为 `{name,message,stack}`（F4），保留错误原因。
 * meta === undefined 时不追加（保持 `[LEVEL] message` 的简洁行）。
 */
function formatMeta(meta: unknown): string {
  if (meta === undefined) return ''
  let text: string
  try {
    text =
      meta instanceof Error
        ? formatErrorMeta(meta)
        : ((JSON.stringify(meta) as string | undefined) ?? String(meta))
  } catch {
    try {
      text = String(meta)
    } catch {
      // 极端对象（toString 也抛错）不能让日志调用抛：给占位串。
      text = '[unserializable meta]'
    }
  }
  return ` ${escapeLineBreaks(text)}`
}

/**
 * 创建日志器。
 * @param options.dir 日志目录（自动递归创建）
 * @param options.maxBytes 单文件上限字节数（默认 1MB；非法值回退默认）
 * @param options.now 时间源（默认系统时间）
 * @param options.console 是否镜像到控制台（默认 false）
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { dir } = options
  const filePath = join(dir, LOG_FILE_NAME)
  const rotatedPath = `${filePath}.1`
  const now = options.now ?? ((): Date => new Date())
  const mirrorToConsole = options.console === true
  const rawMaxBytes = options.maxBytes
  const maxBytes =
    typeof rawMaxBytes === 'number' && Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
      ? rawMaxBytes
      : DEFAULT_MAX_BYTES

  /** 目录不存在 / 被删时补建；失败交给外层 try/catch 统一兜底（不抛）。 */
  function ensureDir(): void {
    mkdirSync(dir, { recursive: true })
  }

  /** 写前轮转：main.log 超过上限 → 覆盖式改名为 main.log.1。 */
  function rotateIfNeeded(): void {
    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      // 文件不存在 / 不可 stat：本次无需轮转（append 失败由外层 catch 兜底）。
      return
    }
    if (size < maxBytes) return
    renameSync(filePath, rotatedPath)
  }

  /** 单条日志写入；内部所有异常都咽掉，只 console.error 兜底。 */
  function write(level: LogLevel, message: string, meta: unknown): void {
    try {
      const timestamp = now().toISOString()
      // 换行转义：日志按行分析，不允许一条日志被 message 里的换行拆成多行。
      const text = escapeLineBreaks(String(message))
      const line = `${timestamp} [${level.toUpperCase()}] ${text}${formatMeta(meta)}`

      if (mirrorToConsole) {
        try {
          console[level](line)
        } catch {
          // 控制台镜像失败不影响落盘
        }
      }

      ensureDir()
      rotateIfNeeded()
      // 风险记录（F11，接受）：main.log 若是符号链接，appendFileSync/renameSync 会跟随/替换链接。
      // 攻击者需与本进程同一用户且已有目标文件权限，属同权限边界，不构成跨权限提权。
      appendFileSync(filePath, `${line}\n`, 'utf8')
    } catch (error) {
      // 日志失败绝不能影响主流程：仅 console.error 兜底（此时不再尝试写文件，避免递归失败）。
      console.error('[logger] 写日志失败:', error)
    }
  }

  // 创建时就尝试建目录（失败只报错不抛，后续写入仍会重试）；便于调用方立刻使用。
  try {
    ensureDir()
  } catch (error) {
    console.error('[logger] 创建日志目录失败:', error)
  }

  return {
    filePath,
    debug(message: string, meta?: unknown): void {
      write('debug', message, meta)
    },
    info(message: string, meta?: unknown): void {
      write('info', message, meta)
    },
    warn(message: string, meta?: unknown): void {
      write('warn', message, meta)
    },
    error(message: string, meta?: unknown): void {
      write('error', message, meta)
    },
    flush(): void {
      // appendFileSync 同步落盘，无内存缓冲；保留方法供未来异步实现与显式 flush 调用。
    }
  }
}
