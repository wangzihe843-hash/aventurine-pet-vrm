/**
 * DSH 桌面版版本探测器（2026-11-11 兼容性安全 v2）—— **不 import electron**，fs/execFile 可注入。
 *
 * 契约依据：`docs/pet-dsh-coupling-safety-plan-2026-11-11.md` §3.1 / §6.1。
 *
 * 兼容判定需要知道"当前安装的 DSH 是什么版本"，但桌宠不能假设 DSH 正在运行、也不能依赖
 * 桥文件（桥可能被 DSH 的 `engines.dsh` 闸门静默禁用、一次都不会 apply）。因此这里直接读
 * DSH app 的 `Contents/Info.plist` 的 `CFBundleShortVersionString`：
 *
 * 路径候选（按序，第一个能读到版本的候选胜出）：
 * 1. `PET_DSH_APP_PATH` 环境变量（测试/非常规安装）；
 * 2. `/Applications/DeepSeek Harness.app`（默认安装位置）；
 * 3. `lsappinfo find bundleID=com.deepseek.dsh` → `lsappinfo info -only bundlepath <id>`
 *    （装到非标准位置、正在运行时可用）；
 * 4. `mdfind "kMDItemCFBundleIdentifier == 'com.deepseek.dsh'"` 首行（Spotlight 索引）。
 *
 * 版本读取：
 * - XML plist：文本解析 `<key>CFBundleShortVersionString</key>` 后一个 `<string>`；
 * - 二进制 plist（文件头 `bplist`）：`plutil -extract CFBundleShortVersionString raw -o - <plist>`；
 * - XML 里找不到键 / 读取失败也走 `plutil` 兜底。
 *
 * 行为保证：
 * - **绝不抛异常**：任何失败返回 `version: null` + `error`（调用方按"DSH 版本未知"降级）；
 * - 结果缓存 `cacheMs`（默认 60s，成功与失败都缓存，避免每次 tick 拉起重命令）；
 * - 构造不触碰文件系统/命令（`detect()` 才执行），可在 IPC 注册阶段安全创建；
 * - 所有外部命令有超时与输出上限（防 lsappinfo/mdfind 卡住主进程）。
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseSemverVersion } from '@shared/semver-range'

/** DSH 桌面版 bundle id（与 `dsh-process.ts` 的常量一致；R2 §4.1 实测）。 */
export const DSH_VERSION_BUNDLE_ID = 'com.deepseek.dsh'

/** 默认安装位置（`lsappinfo`/`mdfind` 都失败时的第二候选）。 */
export const DEFAULT_DSH_APP_PATH = '/Applications/DeepSeek Harness.app'

/** 覆盖 DSH app 路径的环境变量（测试/非常规安装）。 */
export const DSH_APP_PATH_ENV = 'PET_DSH_APP_PATH'

/** 版本探测结果缓存时长（毫秒）。 */
export const DSH_VERSION_CACHE_MS = 60_000

/** Info.plist 相对 app bundle 的路径。 */
const INFO_PLIST_RELATIVE_PATH = join('Contents', 'Info.plist')

/** 版本键名。 */
const PLIST_VERSION_KEY = 'CFBundleShortVersionString'

/** 单条查询命令超时（毫秒；防止 lsappinfo/mdfind 卡住主进程）。 */
const QUERY_TIMEOUT_MS = 2000

/** 单条查询命令输出上限（字节）。 */
const QUERY_MAX_BUFFER = 256 * 1024

/** 版本探测结果。 */
export interface DshVersionInfo {
  /** semver 文本（如 `0.2.2-rc.1`）；读取失败 → null。 */
  version: string | null
  /** 解析到的 app bundle 路径（排障/告警用）；未找到 → null。 */
  appPath: string | null
  /** app 路径来源（决定探测优先级）。 */
  source: 'override' | 'info-plist' | 'lsappinfo' | 'mdfind' | 'unknown'
  /** 失败原因（version 为 null 时尽量给出可读说明）。 */
  error?: string
}

/** 可注入的 `execFile`（生产 default = child_process.execFile；单测注入 fake）。 */
export type DshVersionExecFile = (
  file: string,
  args: string[]
) => Promise<{ stdout: string }>

/** `createDshVersionDetector` 选项（全部可省略）。 */
export interface CreateDshVersionDetectorOptions {
  /** 环境变量源（默认 `process.env`；读 `PET_DSH_APP_PATH`）。 */
  env?: NodeJS.ProcessEnv
  /** 读文本文件（默认 `fs.readFileSync(path, 'utf8')`；单测注入 fake）。 */
  readFile?: (path: string) => string
  /** 判断路径存在（默认 `fs.existsSync`；单测注入 fake）。 */
  exists?: (path: string) => boolean
  /** 执行查询命令（默认 `child_process.execFile`；单测注入 fake）。 */
  execFile?: DshVersionExecFile
  /** 时间源（毫秒；默认 `Date.now`；单测注入假时钟断言缓存）。 */
  now?: () => number
  /** 缓存时长（默认 {@link DSH_VERSION_CACHE_MS}；0/负数 = 不缓存）。 */
  cacheMs?: number
}

/** 版本探测器对外 API。 */
export interface DshVersionDetector {
  /** 探测 DSH 版本（缓存 + 绝不抛）。 */
  detect(): Promise<DshVersionInfo>
  /** 清空缓存（下一次 detect 重新探测；排障/DSH 更新后可用）。 */
  invalidate(): void
}

/** XML plist 里的版本键值（`<key>CFBundleShortVersionString</key> <string>x</string>`）。 */
const XML_VERSION_PATTERN = new RegExp(
  `<key>\\s*${PLIST_VERSION_KEY}\\s*</key>\\s*<string>([^<]*)</string>`
)

/** 把 unknown 异常压成一行可读文本。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 默认 execFile 实现（utf8、限时、限输出；非 0 退出 → reject）。 */
const defaultExecFile: DshVersionExecFile = (file, args) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_BUFFER },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: String(stdout ?? '') })
      }
    )
  })

/** 文本是否像二进制 plist（`bplist00` 头 / 含 NUL 字节）。 */
function looksLikeBinaryPlist(text: string): boolean {
  return text.startsWith('bplist') || text.includes('\u0000')
}

/** 从 `lsappinfo info -only bundlepath` 输出里提取路径。 */
export function parseLsappinfoBundlePath(stdout: string): string | null {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return null
  const quoted = /"bundlepath"\s*=\s*"([^"]+)"/.exec(stdout)
  if (quoted && quoted[1]) return quoted[1].trim()
  // 兼容不同 macOS 版本的输出形态：取第一条看起来像 `.app` 绝对路径的行。
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const match = /(\/[^"'\n]*?\.app)\b/.exec(trimmed)
    if (match && match[1]) return match[1]
  }
  return null
}

/**
 * 创建 DSH 版本探测器。
 *
 * 构造时不触碰文件系统；`detect()` 在缓存失效时才执行 fs/命令，任何失败都返回
 * `version: null` + `error`，绝不向调用方抛异常。
 */
export function createDshVersionDetector(
  options: CreateDshVersionDetectorOptions = {}
): DshVersionDetector {
  const env = options.env ?? process.env
  const readFile =
    options.readFile ??
    ((path: string): string => readFileSync(path, 'utf8'))
  const exists = options.exists ?? ((path: string): boolean => existsSync(path))
  const exec = options.execFile ?? defaultExecFile
  const now = options.now ?? ((): number => Date.now())
  const cacheMs =
    typeof options.cacheMs === 'number' && Number.isFinite(options.cacheMs) && options.cacheMs >= 0
      ? Math.floor(options.cacheMs)
      : DSH_VERSION_CACHE_MS

  /** 缓存结果（成功与失败都缓存，避免失败时每 tick 重试）。 */
  let cached: DshVersionInfo | null = null
  let cachedAt = 0
  /** 进行中的探测（并发调用共享同一个 Promise，避免重复拉起命令）。 */
  let inFlight: Promise<DshVersionInfo> | null = null

  /** `lsappinfo` 定位 bundle 路径（未运行/命令失败 → null）。 */
  async function lsappinfoBundlePath(): Promise<string | null> {
    // lsappinfo：先拿 ASN/bundle 标识，再查 bundlepath（正在运行的 DSH 可定位到非常规安装位置）。
    const asn = await safeExec('lsappinfo', ['find', `bundleID=${DSH_VERSION_BUNDLE_ID}`])
    if (!asn) return null
    const identifier = asn.split(/\r?\n/)[0]?.trim() ?? ''
    if (identifier.length === 0) return null
    const info = await safeExec('lsappinfo', ['info', '-only', 'bundlepath', identifier])
    return info ? parseLsappinfoBundlePath(info) : null
  }

  /** `mdfind`/Spotlight 定位 bundle 路径（索引关闭/受限 → null）。 */
  async function mdfindBundlePath(): Promise<string | null> {
    const found = await safeExec('mdfind', [
      `kMDItemCFBundleIdentifier == '${DSH_VERSION_BUNDLE_ID}'`
    ])
    if (!found) return null
    for (const line of found.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length > 0) return trimmed
    }
    return null
  }

  /** 执行一条查询命令；失败（命令不存在/超时/非 0 退出）返回 null，绝不抛。 */
  async function safeExec(file: string, args: string[]): Promise<string | null> {
    try {
      const result = await exec(file, args)
      return typeof result?.stdout === 'string' ? result.stdout : ''
    } catch {
      return null
    }
  }

  /** 从 app bundle 读版本（XML 文本解析优先，plutil 兜底）；失败 → null + error。 */
  async function readVersionFromApp(appPath: string): Promise<{ version: string | null; error?: string }> {
    const plistPath = join(appPath, INFO_PLIST_RELATIVE_PATH)
    const errors: string[] = []
    try {
      const text = readFile(plistPath)
      if (!looksLikeBinaryPlist(text)) {
        const match = XML_VERSION_PATTERN.exec(text)
        if (match && match[1]) {
          const version = match[1].trim()
          if (version.length > 0) return { version }
          errors.push('Info.plist 版本为空')
        } else {
          errors.push('Info.plist 无 CFBundleShortVersionString（XML）')
        }
      } else {
        errors.push('Info.plist 为二进制 plist')
      }
    } catch (error) {
      errors.push(`读取 Info.plist 失败: ${errorText(error)}`)
    }

    // 兜底：plutil 同时支持 XML / 二进制 plist，输出 raw 单值。
    const raw = await safeExec('plutil', [
      '-extract',
      PLIST_VERSION_KEY,
      'raw',
      '-o',
      '-',
      plistPath
    ])
    if (raw !== null) {
      const version = raw.trim()
      if (version.length > 0) return { version }
      errors.push('plutil 输出为空')
    } else {
      errors.push('plutil 提取失败')
    }
    return { version: null, error: errors.join('；') }
  }

  /** 未缓存的完整探测（绝不抛）。 */
  async function detectUncached(): Promise<DshVersionInfo> {
    const errors: string[] = []
    let lastAppPath: string | null = null
    let lastSource: DshVersionInfo['source'] = 'unknown'

    /** 尝试一个候选路径：读到合法 semver 才返回结果；失败记录错误并返回 null。 */
    const tryCandidate = async (
      appPath: string,
      source: DshVersionInfo['source']
    ): Promise<DshVersionInfo | null> => {
      lastAppPath = appPath
      lastSource = source
      const read = await readVersionFromApp(appPath)
      if (read.version === null) {
        errors.push(`${source}:${appPath} → ${read.error ?? '未知错误'}`)
        return null
      }
      // 版本必须可解析为 semver，否则兼容判定只会得到 unverified；
      // 这里仍返回原始文本，让 dsh-compat 用同一套 SemVer 语义判定（不重复造规则）。
      if (parseSemverVersion(read.version) === null) {
        errors.push(`${source}:${appPath} → 非法 semver「${read.version}」`)
        return null
      }
      return { version: read.version, appPath, source }
    }

    try {
      // 候选按优先级**惰性**尝试：前一个成功就不执行后面的命令（默认安装形态零命令开销）。
      const override = env[DSH_APP_PATH_ENV]?.trim()
      if (override && override.length > 0) {
        const found = await tryCandidate(override, 'override')
        if (found) return found
      }
      if (exists(DEFAULT_DSH_APP_PATH)) {
        const found = await tryCandidate(DEFAULT_DSH_APP_PATH, 'info-plist')
        if (found) return found
      }
      const lsPath = await lsappinfoBundlePath()
      if (lsPath) {
        if (exists(lsPath)) {
          const found = await tryCandidate(lsPath, 'lsappinfo')
          if (found) return found
        } else {
          errors.push(`lsappinfo:${lsPath} → app 路径不存在`)
        }
      }
      const mdPath = await mdfindBundlePath()
      if (mdPath) {
        if (exists(mdPath)) {
          const found = await tryCandidate(mdPath, 'mdfind')
          if (found) return found
        } else {
          errors.push(`mdfind:${mdPath} → app 路径不存在`)
        }
      }
      errors.push(
        `未找到可读 DSH app（${DSH_APP_PATH_ENV}/${DEFAULT_DSH_APP_PATH}/lsappinfo/mdfind 均失败）`
      )
    } catch (error) {
      // 兜底：探测链路任何意外异常都不能影响桌宠主流程。
      errors.push(`探测异常: ${errorText(error)}`)
    }
    const error = errors.length > 0 ? errors.join('；') : '未知错误'
    return { version: null, appPath: lastAppPath, source: lastSource, error }
  }

  /** 探测一次（缓存命中直接返回；并发共享 in-flight Promise）。 */
  function detect(): Promise<DshVersionInfo> {
    const current = now()
    if (cached !== null && current - cachedAt < cacheMs) {
      return Promise.resolve(cached)
    }
    if (inFlight !== null) return inFlight
    inFlight = detectUncached()
      .then((info) => {
        cached = info
        cachedAt = now()
        return info
      })
      .catch((error: unknown) => {
        // detectUncached 自身已兜底；这里再兜一层，保证 Promise 永不 reject。
        const info: DshVersionInfo = {
          version: null,
          appPath: null,
          source: 'unknown',
          error: `探测异常: ${errorText(error)}`
        }
        cached = info
        cachedAt = now()
        return info
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    detect,
    invalidate(): void {
      cached = null
      cachedAt = 0
      inFlight = null
    }
  }
}
