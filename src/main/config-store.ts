/**
 * 用户配置持久化存储（Wave 1 A3）—— **不 import electron**，目录由调用方注入。
 *
 * 设计要点（PLAN §8、§17.3-4、§17.5 A3、§18.3）：
 * - 落盘文件：`<dir>/config.json`，内容 `{ version: CONFIG_VERSION, config: PetConfig }`；
 *   版本不符 / 缺 config → 回退 DEFAULT_CONFIG 并 warn（后续不兼容变更递增 CONFIG_VERSION）。
 * - 读取：文件不存在 → DEFAULT_CONFIG；JSON 解析失败 / 结构非法 → DEFAULT_CONFIG + warn；
 *   **任何异常都不抛出**（配置坏了不能阻塞应用启动）。
 * - 清洗：读到的对象一律交 `sanitizeConfig`（钳制 / 默认值 / 枚举校验 / 未知键丢弃）。
 * - 写入：部分更新合并为 `sanitizeConfig({ ...current, ...partial })` 后**原子写**
 *   （同目录 `.config.json.<pid>.tmp` + `renameSync`）；fs 失败只 warn，内存态仍然更新。
 * - `get()` 返回独立副本，调用方（renderer 反序列化 / 设置面板）改返回值不会污染缓存。
 *
 * 不依赖 Electron 与 `app.getPath`：`src/main/ipc/config.ts` 注入 `app.getPath('userData')`，
 * 单测注入 `mkdtempSync` 临时目录（PLAN §18.3-A3）。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_VERSION, DEFAULT_CONFIG, sanitizeConfig } from '@shared/config'
import type { PetConfig } from '@shared/types'

/** 配置文件文件名（与目录 join 后为完整路径）。 */
const CONFIG_FILE_NAME = 'config.json'

/** 配置存储对外接口（只暴露最小面：读 / 部分更新 / 文件路径）。 */
export interface ConfigStore {
  /** 当前生效配置的独立副本（防止调用方改动内部缓存）。 */
  get(): PetConfig
  /** 合并部分更新：清洗后写盘并返回最新完整配置；fs 失败不抛，内存态照常更新。 */
  set(partial: Partial<PetConfig>): PetConfig
  /** 落盘文件绝对路径（`<dir>/config.json`，排障/日志用）。 */
  readonly filePath: string
}

/** 注入的日志器：只需要 warn（配置损坏 / 写盘失败时告警，绝不抛异常）。 */
export interface ConfigStoreLogger {
  warn(...args: unknown[]): void
}

/** `createConfigStore` 选项：目录由调用方注入（主进程传 userData，单测传临时目录）。 */
export interface CreateConfigStoreOptions {
  dir: string
  logger?: ConfigStoreLogger
}

/** 落盘 JSON 结构（版本号与配置本体；版本字段用于后续不兼容迁移）。 */
interface ConfigFilePayload {
  version: number
  config: PetConfig
}

/** 普通对象判定（排除 null / 数组；JSON.parse 的产物只可能是这些）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 配置副本。
 * 当前 `PetConfig` 全部字段都是原始类型（number/boolean/string），浅拷贝即是深拷贝语义；
 * 未来若加嵌套字段必须改成真正的深拷贝（structuredClone）。
 */
function copyConfig(config: PetConfig): PetConfig {
  return { ...config }
}

/**
 * 启动时保守清理本目录遗留的原子写临时文件（F10）：`.config.json.<pid>.tmp`。
 *
 * - 只清理与当前写入命名模板完全一致的 `.config.json.*.tmp`；
 * - **跳过当前进程 pid 的 tmp**（同一进程可能有另一个 store 正在写，不能误删）；
 * - 目录不存在 / 无权限 / 删单个文件失败一律静默忽略（清理是 best-effort，不阻塞启动）。
 */
function cleanupStaleTempFiles(dir: string): void {
  const prefix = `.${CONFIG_FILE_NAME}.`
  const suffix = '.tmp'
  const ownTempName = `${prefix}${process.pid}${suffix}`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === ownTempName) continue
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // 单个文件清理失败不影响配置读取（下次写入会覆盖同名临时文件）。
    }
  }
}

/**
 * 原子写：先写同目录临时文件再 rename；失败只 warn（不抛），并尽力清理临时文件。
 *
 * 风险记录（F11，接受）：若 `config.json` 本身是符号链接，`renameSync` 会用普通文件替换
 * 链接本身（不会写穿到链接目标）。攻击者需与本进程同一用户且已有目标文件读写权限，
 * 属同权限边界，不构成跨权限提权；此处不增加 `O_NOFOLLOW`/`lstat` 预检。
 */
function writeConfigAtomically(
  dir: string,
  filePath: string,
  config: PetConfig,
  logger: ConfigStoreLogger | undefined
): void {
  const tmpPath = join(dir, `.${CONFIG_FILE_NAME}.${process.pid}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    const payload: ConfigFilePayload = { version: CONFIG_VERSION, config }
    // R-27：显式 0600（原子 rename 保留 tmp 的权限位）。config 字段全是 UI 偏好、无凭据，
    // 但同机其它用户/进程仍不应读到用户的桌面宠物设置；父目录 0700 只是兜底。
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(tmpPath, filePath)
  } catch (error) {
    logger?.warn('[config] 写入配置失败（内存态已更新，本次不落盘）:', error)
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // 清理失败不影响主流程（下次写入会覆盖同名临时文件）
    }
  }
}

/**
 * 从磁盘读取配置；任何问题都回退 DEFAULT_CONFIG（不抛）。
 * 文件不存在视为首次启动（正常路径，不 warn）；其余异常/结构问题 warn 后回退。
 *
 * 风险记录（F11，接受）：`readFileSync` 会跟随 `config.json` 符号链接读取目录外文件；
 * 同用户威胁面，与写盘语义一致，暂不加固。
 */
function readConfigFromDisk(filePath: string, logger: ConfigStoreLogger | undefined): PetConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      logger?.warn('[config] 读取配置失败，回退默认配置:', error)
    }
    return copyConfig(DEFAULT_CONFIG)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    logger?.warn('[config] config.json 不是合法 JSON，回退默认配置:', error)
    return copyConfig(DEFAULT_CONFIG)
  }

  if (!isRecord(parsed)) {
    logger?.warn('[config] config.json 结构非法（不是对象），回退默认配置')
    return copyConfig(DEFAULT_CONFIG)
  }
  if (parsed.version !== CONFIG_VERSION) {
    logger?.warn(
      `[config] config.json 版本不匹配（期望 ${CONFIG_VERSION}，实际 ${JSON.stringify(parsed.version)}），回退默认配置`
    )
    return copyConfig(DEFAULT_CONFIG)
  }
  if (!('config' in parsed) || !isRecord(parsed.config)) {
    logger?.warn('[config] config.json 缺少合法 config 字段，回退默认配置')
    return copyConfig(DEFAULT_CONFIG)
  }

  // 读到的配置可能来自旧版本 / 手工编辑：统一清洗（钳制、枚举、默认值、丢弃未知键）。
  return sanitizeConfig(parsed.config)
}

/**
 * 把 IPC 的任意入参收窄为「仅包含调用方显式提供的合法配置键」的部分配置。
 *
 * 为什么不能直接 `sanitizeConfig(raw)` 后交给 `store.set`：`sanitizeConfig` 会为缺失键回填
 * DEFAULT_CONFIG，如果整份结果当成 partial 合并，会把用户其它已保存的配置重置为默认值；
 * 因此这里只保留 `raw` 自有且属于 `PetConfig` 的键，值则采用 sanitizeConfig 的清洗结果
 * （数值钳制 / 枚举回退默认 / 非法类型回退默认），既防御脏输入又保持「部分更新」语义。
 *
 * 非对象输入（null / 数组 / 字符串等）→ {}（等价于无更新）。
 *
 * 风险记录（F12，接受）：不防御自带抛错 getter / Proxy 的对象（`sanitizeConfig` 只读属性值，
 * 读取会抛）。IPC structured clone 不可能携带 getter/Proxy，故当前不可达；若未来从其它
 * 不可信来源调用本函数需重新评估。
 */
export function toConfigPartial(raw: unknown): Partial<PetConfig> {
  if (!isRecord(raw)) return {}
  const sanitized = sanitizeConfig(raw) as unknown as Record<string, unknown>
  const partial: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) continue
    partial[key] = sanitized[key]
  }
  return partial as Partial<PetConfig>
}

/**
 * 创建配置存储：构造时读盘 + 清洗一次，之后读写都走内存缓存（主进程单实例，无需加锁）。
 * @param options.dir 配置目录（主进程 = app.getPath('userData')；单测 = 临时目录）
 * @param options.logger 可选 warn 接收器（logger.ts 的 Logger 结构兼容）
 */
export function createConfigStore(options: CreateConfigStoreOptions): ConfigStore {
  const { dir, logger } = options
  const filePath = join(dir, CONFIG_FILE_NAME)
  // 进程启动时清理上次崩溃遗留的 tmp（跳过当前 pid，见 cleanupStaleTempFiles 注释）。
  cleanupStaleTempFiles(dir)
  let current = readConfigFromDisk(filePath, logger)

  return {
    filePath,
    get(): PetConfig {
      return copyConfig(current)
    },
    set(partial: Partial<PetConfig>): PetConfig {
      // 任意来源的脏输入都经过合并 + sanitizeConfig：未知键丢弃、越界钳制、非法枚举回退默认。
      const next = sanitizeConfig({ ...current, ...(partial as Record<string, unknown>) })
      // fs 失败也要保持内存态更新（配置在本次运行内仍然生效），只 warn 不抛。
      current = next
      writeConfigAtomically(dir, filePath, next, logger)
      return copyConfig(next)
    }
  }
}
