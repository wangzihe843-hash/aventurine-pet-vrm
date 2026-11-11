/**
 * 窗口枚举助手 TS 封装（Wave 1 A4）—— `native/winlist`（Swift CGWindowListCopyWindowInfo）。
 *
 * 职责：
 * - `parseWinlistJson`：把助手的 stdout JSON 解析成冻结契约 `WindowInfo[]`；脏输入一律降级为 `[]`
 *   （不抛异常），逐项严格校验字段类型，过滤自身进程窗口 / 已不在屏上的窗口 / 零尺寸窗口。
 * - `createWinlistHelper`：spawn 助手（超时 kill、捕获 stdout/stderr、错误记 `lastError`、
 *   promise 永不 reject），供 `src/main/ipc/desktop.ts` 每 500ms 轮询；spawn / binPath / ownPid /
 *   timeoutMs 全部可注入，测试不需要 Electron 也不需要真实二进制。
 *   stdout/stderr 统一用流自身 `setEncoding('utf8')` 解码（A4-F04），stdout 累计超过
 *   4MB 视为异常：kill 子进程并降级为 `[]`。
 * - `windowsChanged`：用稳定签名比较两次窗口列表（顺序敏感，CGWindowList 顺序有意义）。
 *
 * 权限：Swift 侧不读窗口标题，因此**无需屏幕录制权限**（PLAN §10 / §18.1）。
 * 所有错误都只在主进程内降级（返回上一份缓存 / `[]`），不向 renderer 抛。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { app } from 'electron'

import type { WindowInfo } from '@shared/types'

/** 默认 spawn 超时：500ms 轮询周期下，单次枚举超过 2s 视为异常。 */
export const WINLIST_TIMEOUT_MS = 2000

/**
 * stdout 累计上限（A4-F04）：正常 12–100 个窗口只有几 KB；4MB 是异常助手 / 超大环境的
 * 防御线。超过即 kill 子进程并降级为 `[]`（`lastError` 可读），避免主进程内存被拖爆。
 */
export const WINLIST_MAX_STDOUT_BYTES = 4 * 1024 * 1024

/** stderr 累计上限（只用于错误摘要，无需保留完整输出）。 */
const MAX_STDERR_BYTES = 64 * 1024

/** stderr / 错误信息截断长度（避免把整段 Swift 报错塞进日志 / IPC 错误）。 */
const MAX_ERROR_LENGTH = 300

/** spawn 注入类型（测试用 fake 实现时按此别名 cast）。 */
export type SpawnFn = typeof spawn

/** `parseWinlistJson` 的可选项。 */
export interface ParseWinlistOptions {
  /** 自身进程 pid（宠物主进程）；命中的窗口（overlay 等）会被丢弃。 */
  ownPid?: number
}

/** `createWinlistHelper` 的可选项（全部可注入，测试不依赖 Electron / 真实二进制）。 */
export interface WinlistHelperOptions {
  /** 助手二进制路径；默认 `defaultWinlistPath()`。 */
  binPath?: string
  /** spawn 实现（测试注入 fake）；默认 `node:child_process.spawn`。 */
  spawn?: SpawnFn
  /** 自身进程 pid，默认 `process.pid`。 */
  ownPid?: number
  /** 单次枚举超时（毫秒），默认 `WINLIST_TIMEOUT_MS`。 */
  timeoutMs?: number
}

/** 窗口枚举助手实例（主进程轮询用）。 */
export interface WinlistHelper {
  /** 枚举一次窗口列表；任何错误 / 超时 / 非 0 退出都返回 `[]`，绝不 reject。 */
  list(): Promise<WindowInfo[]>
  /** 最近一次 `list()` 的错误信息；成功时为 null。 */
  lastError(): string | null
}

/** 是否为有限数字（JSON 无法表达 NaN/Infinity，但注入的 fake 输出仍要防御）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 是否为整数（窗口 id / pid / layer 必须是整数）。 */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** 把错误对象转成短消息（spawn error / 超时等）。 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 截断过长的错误文本。 */
function truncateError(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_ERROR_LENGTH ? `${trimmed.slice(0, MAX_ERROR_LENGTH)}…` : trimmed
}

/** 校验并归一化单个 JSON 项；非法返回 null。 */
function toWindowInfo(value: unknown): WindowInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  if (!isInteger(raw['id'])) return null
  if (!isInteger(raw['pid'])) return null
  if (typeof raw['owner'] !== 'string') return null
  if (!isInteger(raw['layer'])) return null
  if (!isFiniteNumber(raw['alpha'])) return null
  if (typeof raw['onScreen'] !== 'boolean') return null

  const bounds = raw['bounds']
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) return null
  const rawBounds = bounds as Record<string, unknown>
  if (!isFiniteNumber(rawBounds['x'])) return null
  if (!isFiniteNumber(rawBounds['y'])) return null
  if (!isFiniteNumber(rawBounds['width'])) return null
  if (!isFiniteNumber(rawBounds['height'])) return null
  // 零 / 负尺寸窗口（隐藏辅助窗）不参与桌面感知。
  if (rawBounds['width'] <= 0 || rawBounds['height'] <= 0) return null

  return {
    id: raw['id'],
    pid: raw['pid'],
    owner: raw['owner'],
    layer: raw['layer'],
    alpha: raw['alpha'],
    bounds: {
      x: rawBounds['x'],
      y: rawBounds['y'],
      width: rawBounds['width'],
      height: rawBounds['height']
    },
    onScreen: raw['onScreen']
  }
}

/**
 * 解析 `winlist --json` 的 stdout：
 * - JSON 解析失败 / 顶层不是数组 → `[]`（绝不抛异常）；
 * - 逐项严格校验（id/pid/layer 整数、alpha/bounds 有限数、owner 字符串、onScreen 布尔），
 *   非法项跳过；bounds 宽高 <= 0 的窗口跳过；
 * - `ownPid` 命中的窗口（宠物自身 overlay）跳过；`onScreen === false` 跳过。
 */
export function parseWinlistJson(stdout: string, options: ParseWinlistOptions = {}): WindowInfo[] {
  const ownPid = options.ownPid

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const windows: WindowInfo[] = []
  for (const item of parsed) {
    const window = toWindowInfo(item)
    if (!window) continue
    if (ownPid !== undefined && window.pid === ownPid) continue
    // A4-F12：Swift 侧使用 `.optionOnScreenOnly`，输出项的 onScreen 当前恒为 true；
    // 该过滤保留给未来枚举隐藏窗口的实现，当前分支不可达（消费侧不要用 onScreen 表达「关闭」）。
    if (window.onScreen === false) continue
    windows.push(window)
  }
  return windows
}

/**
 * 助手二进制的默认路径。
 *
 * - dev：`<app.getAppPath()>/native/winlist/.build/winlist`（`node scripts/build-native.mjs` 产物）；
 * - 打包（app.isPackaged）：`<Resources>/native/winlist/winlist`（由 Wave 3 C4 的
 *   electron-builder `extraResources` 放置；C4 未接线前该路径不存在 → 助手降级为 `[]`，
 *   不影响 app 启动）；
 * - 非 Electron 环境（单测直接 import 本模块）：回退到 `<cwd>/native/winlist/.build/winlist`，
 *   只用于 `createWinlistHelper()` 的默认值推导；测试请显式注入 `binPath`。
 */
export function defaultWinlistPath(): string {
  const fallback = join(process.cwd(), 'native/winlist/.build/winlist')
  try {
    if (app.isPackaged) return join(process.resourcesPath, 'native', 'winlist', 'winlist')
    const appPath = app.getAppPath()
    return appPath ? join(appPath, 'native/winlist/.build/winlist') : fallback
  } catch {
    // vitest node 环境 import electron 得到的是二进制路径字符串，取不到 app 时走 fallback。
    return fallback
  }
}

/**
 * 创建窗口枚举助手（默认 2s 超时，排程由调用方负责）。
 * `list()` 保证：resolve 数组、永不 reject；错误 / 超时 / 非 0 退出 → `[]` 且 `lastError()` 可读。
 */
export function createWinlistHelper(options: WinlistHelperOptions = {}): WinlistHelper {
  const spawnFn = options.spawn ?? spawn
  const ownPid = options.ownPid ?? process.pid
  const timeoutMs = options.timeoutMs ?? WINLIST_TIMEOUT_MS
  const binPath = options.binPath ?? defaultWinlistPath()

  let lastError: string | null = null

  function list(): Promise<WindowInfo[]> {
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let stdout = ''
      let stdoutBytes = 0
      let stderr = ''
      let stderrBytes = 0

      const settle = (windows: WindowInfo[], error?: string): void => {
        if (settled) return
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        lastError = error ?? null
        resolve(windows)
      }

      let child: ReturnType<typeof spawnFn>
      try {
        child = spawnFn(binPath, ['--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        settle([], `spawn failed: ${truncateError(toErrorMessage(error))}`)
        return
      }

      /** 超时 / 输出超限时强杀，避免僵尸进程；kill 失败忽略（可能已退出）。 */
      const killChild = (): void => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已退出，忽略 kill 失败。
        }
      }

      // A4-F04：用流自身的 StringDecoder 处理跨 chunk 的多字节 UTF-8（中文 owner），
      // 避免逐 chunk `toString('utf8')` 把被拆开的汉字解成 U+FFFD。
      if (typeof child.stdout?.setEncoding === 'function') child.stdout.setEncoding('utf8')
      if (typeof child.stderr?.setEncoding === 'function') child.stderr.setEncoding('utf8')

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stdoutBytes += Buffer.byteLength(text, 'utf8')
        if (stdoutBytes > WINLIST_MAX_STDOUT_BYTES) {
          // 异常输出：丢弃缓冲、kill 并降级，避免无限累积。
          stdout = ''
          killChild()
          settle([], `winlist stdout exceeded ${WINLIST_MAX_STDOUT_BYTES} bytes`)
          return
        }
        stdout += text
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (settled) return
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (stderrBytes >= MAX_STDERR_BYTES) return
        stderrBytes += Buffer.byteLength(text, 'utf8')
        stderr += text.slice(0, MAX_STDERR_BYTES)
      })

      child.on('error', (error) => {
        settle([], `spawn error: ${truncateError(toErrorMessage(error))}`)
      })

      child.on('close', (code) => {
        if (settled) return
        if (code !== 0) {
          const details = truncateError(stderr)
          const suffix = details.length > 0 ? `: ${details}` : ''
          settle([], `winlist exited with code ${code ?? 'null'}${suffix}`)
          return
        }
        settle(parseWinlistJson(stdout, { ownPid }))
      })

      timer = setTimeout(() => {
        if (settled) return
        // 超时后强杀，避免僵尸进程堆积；错误码/关闭事件后续被 settle 忽略。
        killChild()
        settle([], `winlist timeout after ${timeoutMs}ms`)
      }, timeoutMs)
      timer.unref?.()
    })
  }

  return {
    list,
    lastError: (): string | null => lastError
  }
}

/**
 * 比较两次窗口列表是否变化（顺序敏感：CGWindowList 前后顺序表达窗口 z 序，不能排序后比较）。
 * 用稳定签名比较 id + pid + owner + layer + alpha + bounds + onScreen。
 */
export function windowsChanged(previous: WindowInfo[], next: WindowInfo[]): boolean {
  if (previous.length !== next.length) return true
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (!before || !after) return true
    if (before.id !== after.id) return true
    if (before.pid !== after.pid) return true
    if (before.owner !== after.owner) return true
    if (before.layer !== after.layer) return true
    if (before.alpha !== after.alpha) return true
    if (before.onScreen !== after.onScreen) return true
    if (before.bounds.x !== after.bounds.x) return true
    if (before.bounds.y !== after.bounds.y) return true
    if (before.bounds.width !== after.bounds.width) return true
    if (before.bounds.height !== after.bounds.height) return true
  }
  return false
}
