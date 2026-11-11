/**
 * 桥目录静态状态读取器（2026-11-11 兼容性安全 v2）—— electron-free，fs 可注入。
 *
 * 契约依据：`docs/pet-dsh-coupling-safety-plan-2026-11-11.md` §3.3/§3.4/§6.1。
 *
 * 背景：桥可能被 DSH 的 `engines.dsh` 版本闸门**静默禁用**（一次都不会 apply），此时
 * `control.json`/`status.json`/运行时 `compat` 全部不可达。桌宠需要另一条静态通道得知
 * "装了什么桥、声明支持哪个 DSH 范围、桥为什么没加载"：
 * - `install.json`：激活脚本写的安装清单（`DshBridgeInstallManifest`）；
 * - `bridge-error.json`：桥 `apply` 失败时写的故障诊断（`DshBridgeDiagnostic`）。
 *
 * 行为保证（生命周期每 3s tick 会调 `read()`，必须便宜且安全）：
 * - `mtimeMs + size` 未变 → 直接返回上次解析结果（不重复读盘）；
 * - 单文件读取上限 16KB（共享契约常量），超限忽略；
 * - 坏 JSON / schema 不匹配 → 解析器返回 null → 静默忽略；
 * - 文件缺失是正常状态（未装桥）→ 静默；其它读取异常只 warn 一次；
 * - **绝不抛异常**（返回 null 字段，生命周期按"无信号"降级）。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  BRIDGE_DIAGNOSTIC_FILE,
  BRIDGE_DIAGNOSTIC_MAX_BYTES,
  BRIDGE_INSTALL_FILE,
  BRIDGE_INSTALL_MAX_BYTES,
  parseDshBridgeDiagnostic,
  parseDshBridgeInstallManifest
} from '@shared/bridge-schema'
import type { DshBridgeDiagnostic, DshBridgeInstallManifest } from '@shared/bridge-schema'

import { DSH_DIR_ENV, resolveDshDir } from './dsh-watch'

/** 只允许注入的最小日志接口（warn 一次即可；避免耦合 `src/main/logger.ts`）。 */
export interface BridgeStateLogger {
  warn?(message: string, meta?: unknown): void
}

/** 文件签名的可注入 `stat` 形态（缺失/不可读 → null）。 */
export interface BridgeFileStat {
  mtimeMs: number
  size: number
}

/** 桥目录状态快照（全部只读；缺失为 null）。 */
export interface BridgeDirState {
  installManifest: DshBridgeInstallManifest | null
  diagnostic: DshBridgeDiagnostic | null
  /** 实际读取的桥目录（排障/测试断言用）。 */
  dir: string
}

/** `createBridgeStateReader` 选项（全部可省略）。 */
export interface CreateBridgeStateReaderOptions {
  /** 桥目录覆盖（优先级最高；默认 env `PET_DSH_DIR` > `~/.dsh/aventurine-pet`）。 */
  dir?: string
  /** 环境变量源（默认 `process.env`；读 `PET_DSH_DIR`）。 */
  env?: NodeJS.ProcessEnv
  /** 读文本文件（默认 `fs.readFileSync(path, 'utf8')`；单测注入 fake）。 */
  readFile?: (path: string) => string
  /** 取文件签名（默认 `fs.statSync`；缺失/不可读 → null；单测注入 fake）。 */
  stat?: (path: string) => BridgeFileStat | null
  /** 日志接口（默认静默；读取异常只 warn 一次）。 */
  logger?: BridgeStateLogger
}

/** 桥目录状态读取器对外 API。 */
export interface BridgeStateReader {
  /** 实际使用的桥目录。 */
  readonly dir: string
  /** 读一次状态（每 tick 可调；mtime 未变走缓存）。 */
  read(): BridgeDirState
}

/** 单文件缓存条目：签名 + 解析结果（null = 无有效内容）。 */
interface FileCacheEntry<T> {
  signature: string
  value: T | null
}

/** 默认 stat 实现：缺失/不可读 → null（区分错误码对上层无意义，统一按"无文件"处理）。 */
function defaultStat(path: string): BridgeFileStat | null {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return null
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return null
  }
}

/** 把未知异常压成一行可读文本。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 创建桥目录状态读取器。
 *
 * 构造时只解析目录（不读盘）；`read()` 才触碰文件系统且绝不抛异常。
 */
export function createBridgeStateReader(
  options: CreateBridgeStateReaderOptions = {}
): BridgeStateReader {
  const env = options.env ?? process.env
  const dir = resolveDshDir({ dir: options.dir, envDir: env[DSH_DIR_ENV] })
  const readFile =
    options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const statFile = options.stat ?? defaultStat
  const logger = options.logger
  const installPath = join(dir, BRIDGE_INSTALL_FILE)
  const diagnosticPath = join(dir, BRIDGE_DIAGNOSTIC_FILE)

  /** 每个文件一份缓存（signature 相同不重读）。 */
  const installCache: { entry: FileCacheEntry<DshBridgeInstallManifest> | null } = {
    entry: null
  }
  const diagnosticCache: { entry: FileCacheEntry<DshBridgeDiagnostic> | null } = {
    entry: null
  }
  /** 读取异常只 warn 一次（文件恢复后重置）。 */
  let warned = false

  /** 读取并解析一个文件（mtime 未变走缓存；任何异常只 warn 一次并返回 null）。 */
  function readParsed<T>(
    path: string,
    maxBytes: number,
    cache: { entry: FileCacheEntry<T> | null },
    parse: (text: string) => T | null
  ): T | null {
    let stats: BridgeFileStat | null
    try {
      stats = statFile(path)
    } catch (error) {
      warnOnce(`读取桥文件签名失败: ${path} (${errorText(error)})`)
      cache.entry = null
      return null
    }
    if (stats === null) {
      // 文件缺失（未装桥/未失败过）：正常状态，静默清缓存。
      cache.entry = null
      return null
    }
    if (stats.size > maxBytes) {
      // 超大/被污染文件：忽略（共享契约解析器也会按上限拒绝，这里提前避免读入内存）。
      warnOnce(`桥文件过大已忽略: ${path} (${stats.size}B > ${maxBytes}B)`)
      cache.entry = { signature: `${stats.mtimeMs}:${stats.size}`, value: null }
      return null
    }
    const signature = `${stats.mtimeMs}:${stats.size}`
    if (cache.entry !== null && cache.entry.signature === signature) {
      return cache.entry.value
    }
    let text: string
    try {
      text = readFile(path)
    } catch (error) {
      warnOnce(`读取桥文件失败: ${path} (${errorText(error)})`)
      cache.entry = { signature, value: null }
      return null
    }
    const parsed = parse(text)
    cache.entry = { signature, value: parsed }
    return parsed
  }

  /** 首次异常 warn（不刷屏）。 */
  function warnOnce(message: string): void {
    if (warned) return
    warned = true
    try {
      logger?.warn?.(`[dsh-bridge-state] ${message}`)
    } catch {
      // 日志失败不影响读取
    }
  }

  return {
    get dir(): string {
      return dir
    },
    read(): BridgeDirState {
      const installManifest = readParsed(
        installPath,
        BRIDGE_INSTALL_MAX_BYTES,
        installCache,
        parseDshBridgeInstallManifest
      )
      const diagnostic = readParsed(
        diagnosticPath,
        BRIDGE_DIAGNOSTIC_MAX_BYTES,
        diagnosticCache,
        parseDshBridgeDiagnostic
      )
      return { installManifest, diagnostic, dir }
    }
  }
}
