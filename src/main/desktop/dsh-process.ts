/**
 * DSH 桌面版进程探测 / 拉起 / 终止（Wave 3 A3）—— **不 import electron**，全部外部能力可注入。
 *
 * 背景（`docs/wave3-dsh-integration-design.md` §4.2 + R2 报告 §4/§6）：
 * 强耦合生命周期需要主进程回答三个问题：「DSH 在跑吗」「把它拉起来」「让它优雅退出」。
 * 全部只走 macOS 自带、**零 TCC 权限**的命令行工具（R2 §4.4 / R3：绝不用 `osascript`，
 * 那会触发 Automation 权限弹窗）：
 *
 * - 检测（优先级从高到低）：
 *   1. `lsappinfo find bundleID=com.deepseek.dsh`：exit 0 且输出非空 → 桌面版 app 在跑；
 *      不依赖进程名，也不受安装路径/AI Host 启停影响（Host 崩溃时 app 仍在，属于「在跑」）；
 *   2. 兜底 `pgrep -f '<pattern>'`：`lsappinfo` 不可用 / 无结果（例如只读沙箱、测试钩子
 *      fake 进程）时扫描命令行；再用 `ps -p <pid> -o command=` 取完整命令行，**排除
 *      Helper / renderer / GPU / `--type=` 等子进程**，避免把 Helper 当成主进程。
 * - 拉起：`open -b com.deepseek.dsh`。DSH 是 Electron 单实例 app（R2 §4.2），已有实例时
 *   该命令只聚焦窗口，**幂等安全**；不要附加任何 `--args`（profile 固定 desktop）。
 * - 终止：SIGTERM → 轮询等待进程消失（默认 ≤5s）→ 仍存在则 SIGKILL（见 `terminate`）。
 *   不使用 `pkill`/`killall` 按名字杀（可能命中无关进程）；只对探测到的 pid 发信号。
 *
 * 可注入项（全部有生产默认值，单测**绝不执行真实命令/杀真实进程**）：
 * `execFile` / `kill` / `now` / `sleep` / `logger` / `env` / `isPackaged`。
 *
 * dev-only 测试钩子（契约 §3.5；仅当 `PET_DSH_TEST_HOOKS=1` **且** `isPackaged !== true`）：
 * - `PET_DSH_TEST_PROCESS_PATTERN`：覆盖 pgrep 检测模式（默认桌面版主可执行文件路径）；
 * - `PET_DSH_TEST_LAUNCH_CMD`：覆盖拉起命令（经 `/bin/sh -c` 执行，detached）；
 * - `PET_DSH_TEST_QUIT_DELAY_MS`：覆盖 SIGTERM→SIGKILL 升级时间（钳制 10–60000ms）。
 * 打包版忽略全部测试钩子；`PET_DSH_COUPLING_DISABLE` 由生命周期层处理，本模块不读。
 */
import { execFile, spawn } from 'node:child_process'

/** DSH 桌面版 bundle id（R2 §4.1 实测；Info.plist 与 dshDesktopAppId 一致）。 */
export const DSH_BUNDLE_ID = 'com.deepseek.dsh'

/** 默认进程检测模式：桌面版 Electron 主可执行文件完整路径（不锚定安装位置）。 */
export const DEFAULT_DSH_PROCESS_PATTERN =
  'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'

/** SIGTERM 后等待进程消失的默认上限（契约 §4.2：≤5s）。 */
export const DSH_TERMINATE_TIMEOUT_MS = 5000

/** 终止轮询间隔（毫秒）。 */
export const DSH_TERMINATE_POLL_MS = 250

/** 单次查询命令的默认超时（防止 lsappinfo/pgrep 卡住主进程）。 */
const QUERY_TIMEOUT_MS = 2000

/** 拉起命令的默认超时（`open` 正常 <1s）。 */
const LAUNCH_TIMEOUT_MS = 10_000

/** 测试钩子总开关环境变量。 */
export const PET_DSH_TEST_HOOKS_ENV = 'PET_DSH_TEST_HOOKS'

/** 测试钩子：覆盖进程检测模式。 */
export const PET_DSH_TEST_PROCESS_PATTERN_ENV = 'PET_DSH_TEST_PROCESS_PATTERN'

/** 测试钩子：覆盖拉起命令（`/bin/sh -c`）。 */
export const PET_DSH_TEST_LAUNCH_CMD_ENV = 'PET_DSH_TEST_LAUNCH_CMD'

/** 测试钩子：覆盖 SIGTERM→SIGKILL 升级时间。 */
export const PET_DSH_TEST_QUIT_DELAY_MS_ENV = 'PET_DSH_TEST_QUIT_DELAY_MS'

/** 测试钩子覆盖的升级时间允许范围（过小会忙等，过大违反 ≤5s 语义）。 */
const MIN_TEST_QUIT_DELAY_MS = 10
const MAX_TEST_QUIT_DELAY_MS = 60_000

/** 日志前缀。 */
const LOG_PREFIX = '[dsh-process]'

/** 注入的最小日志接口（与 `src/main/logger.ts` 的 Logger 结构兼容）。 */
export interface DshProcessLogger {
  info?(message: string, meta?: unknown): void
  warn?(message: string, meta?: unknown): void
  debug?(message: string, meta?: unknown): void
}

/** execFile 结果（只取文本输出；错误经 Promise reject 抛出）。 */
export interface DshExecResult {
  stdout: string
  stderr: string
}

/** execFile 选项（生产实现映射到 child_process.execFile）。 */
export interface DshExecOptions {
  timeoutMs?: number
  /** 仅测试钩子拉起命令使用：让子进程脱离父进程（`/bin/sh` 退出后 fake 进程仍在）。 */
  detached?: boolean
}

/**
 * 可注入的命令执行器。
 * 生产默认实现 = `child_process.execFile`（非 shell，避免注入面）；单测注入 fake。
 */
export type DshExecFile = (
  file: string,
  args: readonly string[],
  options?: DshExecOptions
) => Promise<DshExecResult>

/** 可注入的信号发送器（默认 `process.kill`）。`signal === 0` 表示只做存在性检查。 */
export type DshKillFn = (pid: number, signal: NodeJS.Signals | 0) => void

/** 终止结果（生命周期只区分「已退出」与「失败」，保留原因便于日志）。 */
export type DshTerminateResult = 'terminated' | 'killed' | 'not-running' | 'failed'

/** `createDshProcess` 选项（全部可省略）。 */
export interface DshProcessOptions {
  /** 环境变量源（默认 `process.env`；测试注入）。 */
  env?: NodeJS.ProcessEnv
  /** 是否打包版（默认 `false`；打包版禁用全部 dev 测试钩子）。 */
  isPackaged?: boolean
  /** 命令执行器（默认 child_process.execFile）。 */
  execFile?: DshExecFile
  /** 信号发送器（默认 process.kill）。 */
  kill?: DshKillFn
  /** 时间源（毫秒；默认 Date.now）。 */
  now?: () => number
  /** 等待（默认 setTimeout Promise；测试可注入假等待）。 */
  sleep?: (ms: number) => Promise<void>
  /** 日志接口（默认静默）。 */
  logger?: DshProcessLogger
  /** 显式覆盖 SIGTERM→SIGKILL 升级时间（优先级高于测试钩子）。 */
  terminateTimeoutMs?: number
}

/** 解析后的进程策略（可单独导出便于单测/排障断言）。 */
export interface DshProcessPolicy {
  /** pgrep -f 使用的进程模式。 */
  processPattern: string
  /** 拉起方式：`open -b <bundle>` 或测试钩子的 `/bin/sh -c <cmd>`。 */
  launchMode: 'open-bundle' | 'shell-command'
  /** shell-command 模式下实际命令（其它模式为 null）。 */
  launchCommand: string | null
  /** SIGTERM→SIGKILL 升级时间。 */
  terminateTimeoutMs: number
  /** 是否启用了 dev 测试钩子（便于日志/测试断言）。 */
  testHooks: boolean
}

/** 进程探测/控制对外 API（生命周期只依赖本接口，单测注入 fake）。 */
export interface DshProcess {
  /** 解析后的策略（排障/测试断言用；只读）。 */
  readonly policy: DshProcessPolicy
  /** DSH 桌面版是否在运行（lsappinfo 优先，pgrep 兜底；任何异常 → false，绝不抛）。 */
  isRunning(): Promise<boolean>
  /** 取 DSH 主进程 pid（优先 Electron 主进程，排除 Helper/Host 子进程）；找不到 → null。 */
  getPid(): Promise<number | null>
  /** 拉起/聚焦 DSH（`open -b`，幂等）；返回是否执行成功。 */
  launch(): Promise<boolean>
  /** 终止指定 pid：SIGTERM → 等待 ≤timeout → SIGKILL；绝不按名字杀。 */
  terminate(pid: number): Promise<DshTerminateResult>
}

/** 兼容 `ExecFileException` 的宽松错误形状（用于识别 ESRCH/ENOENT）。 */
interface CommandError {
  code?: unknown
  message?: unknown
}

/** 把 unknown 异常压成一行可读文本（日志用）。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 取 errno code（非 Node 错误 → undefined）。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as CommandError).code
  return typeof code === 'string' ? code : undefined
}

/** 解析非负整数（非法 → null）。 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return null
  return value
}

/** 解析并钳制测试钩子的升级时间（非法/越界 → null，回退默认）。 */
function resolveTestQuitDelay(raw: string | undefined): number | null {
  const parsed = parsePositiveInt(raw)
  if (parsed === null) return null
  return Math.min(MAX_TEST_QUIT_DELAY_MS, Math.max(MIN_TEST_QUIT_DELAY_MS, parsed))
}

/**
 * 解析进程策略（纯函数；测试可直接断言 dev 钩子生效/失效）。
 *
 * dev 测试钩子只在 `PET_DSH_TEST_HOOKS === '1'` **且** `isPackaged !== true` 时生效：
 * 打包版即使环境变量被伪造也不会执行任意 shell 命令 / 检测任意模式。
 */
export function resolveDshProcessPolicy(
  options: { env?: NodeJS.ProcessEnv; isPackaged?: boolean } = {}
): DshProcessPolicy {
  const env = options.env ?? process.env
  const testHooks = env[PET_DSH_TEST_HOOKS_ENV] === '1' && options.isPackaged !== true
  const patternOverride = testHooks ? env[PET_DSH_TEST_PROCESS_PATTERN_ENV]?.trim() : undefined
  const launchOverride = testHooks ? env[PET_DSH_TEST_LAUNCH_CMD_ENV]?.trim() : undefined
  const quitDelayOverride = testHooks
    ? resolveTestQuitDelay(env[PET_DSH_TEST_QUIT_DELAY_MS_ENV])
    : null

  return {
    processPattern:
      patternOverride && patternOverride.length > 0 ? patternOverride : DEFAULT_DSH_PROCESS_PATTERN,
    launchMode: launchOverride && launchOverride.length > 0 ? 'shell-command' : 'open-bundle',
    launchCommand: launchOverride && launchOverride.length > 0 ? launchOverride : null,
    terminateTimeoutMs: quitDelayOverride ?? DSH_TERMINATE_TIMEOUT_MS,
    testHooks
  }
}

/**
 * 命令行是否像 Electron 子进程（Helper / renderer / GPU / utility / Framework 内嵌 app）。
 *
 * pgrep -f 按子串匹配，`.../MacOS/DeepSeek Harness` 同时会命中
 * `.../DeepSeek Harness Helper (GPU)`，必须再按完整命令行过滤，否则会把 Helper 当主进程。
 * 导出便于单测直接覆盖分类规则。
 */
export function commandLooksLikeHelper(command: string): boolean {
  if (command.length === 0) return false
  return (
    /DeepSeek Harness Helper/.test(command) ||
    /[\\/]Contents[\\/]Frameworks[\\/]/.test(command) ||
    /--type=/.test(command) ||
    /--utility-sub-type=/.test(command)
  )
}

/**
 * 命令行是否像 DSH 的 AI Host 子进程（与 Electron 主进程同一可执行文件，但带
 * `--expose-internals` 或 `dsh-desktop-host/lib/...` 参数）。
 *
 * 生命周期终止时优先杀 Electron 主进程（退出时会带走 Host）；只有在找不到主进程时
 * 才退化为杀 Host，因此这里单独分类。导出便于单测覆盖。
 */
export function commandLooksLikeDesktopHost(command: string): boolean {
  if (command.length === 0) return false
  return (
    /--expose-internals/.test(command) ||
    /dsh-desktop-host[\\/]lib[\\/](index|cli)\.js/.test(command)
  )
}

/** 找出与 pgrep 模式匹配的进程候选（pid + 完整命令行；命令行取不到时为空串）。 */
interface DshProcessCandidate {
  pid: number
  command: string
}

/**
 * 脱离父进程执行（仅 dev 测试钩子的拉起命令用）。
 *
 * `execFile` 不支持 `detached`（Node 类型/运行时都按 spawn 的管道模式处理），因此这里单独
 * 用 `spawn({ detached: true, stdio: 'ignore' })`：`/bin/sh -c` 退出后 fake 进程仍存活，
 * 与真实 DSH 的 GUI 生命周期一致。resolved 时机 = spawn 成功（不等命令退出）。
 */
function runDetached(file: string, args: readonly string[]): Promise<DshExecResult> {
  return new Promise<DshExecResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, [...args], { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve({ stdout: '', stderr: '' })
    })
  })
}

/** 生产默认 execFile 实现（utf8、限时、限输出大小；非 0 退出 → reject；detached 走 spawn）。 */
const defaultExecFile: DshExecFile = (file, args, options = {}) => {
  if (options.detached === true) return runDetached(file, args)
  return new Promise<DshExecResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? QUERY_TIMEOUT_MS,
        maxBuffer: 512 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
          return
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

/**
 * 创建 DSH 进程控制器。
 *
 * 所有方法都「尽力而为、绝不抛」：查询失败 → false/null（生命周期按「不在运行」降级），
 * 拉起失败 → false，终止失败 → `failed`（调用方照常退出，只记日志）。
 */
export function createDshProcess(options: DshProcessOptions = {}): DshProcess {
  const env = options.env ?? process.env
  const policy = resolveDshProcessPolicy({ env, isPackaged: options.isPackaged })
  const exec = options.execFile ?? defaultExecFile
  const kill = options.kill ?? ((pid, signal): void => { process.kill(pid, signal) })
  const now = options.now ?? ((): number => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const logger = options.logger
  const terminateTimeoutMs = options.terminateTimeoutMs ?? policy.terminateTimeoutMs

  /** 执行一条查询命令；失败（命令不存在/超时/非 0 退出）返回 null。 */
  async function query(file: string, args: readonly string[]): Promise<DshExecResult | null> {
    try {
      return await exec(file, args, { timeoutMs: QUERY_TIMEOUT_MS })
    } catch (error) {
      const code = errorCode(error)
      // pgrep 无匹配时退出码 1（不是错误）；lsappinfo 查询失败同理。只在意外错误时 debug 一次。
      if (code !== 'ENOENT' && code !== 'EPERM') {
        logger?.debug?.(`${LOG_PREFIX} 查询失败: ${file} ${args.join(' ')} (${errorText(error)})`)
      }
      return null
    }
  }

  /** `lsappinfo find bundleID=...` 是否报告 app 在运行（exit 0 且输出非空）。 */
  async function lsappinfoReportsRunning(): Promise<boolean> {
    const result = await query('lsappinfo', ['find', `bundleID=${DSH_BUNDLE_ID}`])
    if (!result) return false
    return result.stdout.trim().length > 0
  }

  /** 用 pgrep + ps 找出候选进程（pgrep 无匹配 → []）。 */
  async function findCandidates(): Promise<DshProcessCandidate[]> {
    const pgrep = await query('pgrep', ['-f', policy.processPattern])
    if (!pgrep) return []
    const pids: number[] = []
    for (const line of pgrep.stdout.split(/\r?\n/)) {
      const pid = parsePositiveInt(line)
      if (pid !== null && !pids.includes(pid)) pids.push(pid)
    }
    if (pids.length === 0) return []

    const candidates: DshProcessCandidate[] = []
    for (const pid of pids) {
      // 取完整命令行用于区分主进程/Helper/Host；取不到也保留候选（只是无法分类）。
      // -ww：不截断命令行宽度，避免长 Helper 路径被截断后误判为主进程。
      const ps = await query('ps', ['-p', String(pid), '-o', 'command=', '-ww'])
      candidates.push({ pid, command: ps ? ps.stdout.trim() : '' })
    }
    return candidates
  }

  /** pid 是否仍存在（signal 0；ESRCH → 不存在，EPERM → 存在但无权限）。 */
  function isAlive(pid: number): boolean {
    try {
      kill(pid, 0)
      return true
    } catch (error) {
      return errorCode(error) !== 'ESRCH'
    }
  }

  /** 发送信号；进程已不存在 → gone，其它错误 → error。 */
  function sendSignal(pid: number, signal: NodeJS.Signals): 'ok' | 'gone' | 'error' {
    try {
      kill(pid, signal)
      return 'ok'
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ESRCH') return 'gone'
      logger?.warn?.(`${LOG_PREFIX} 发送 ${signal} 失败 pid=${pid} (${errorText(error)})`)
      return 'error'
    }
  }

  return {
    policy,

    async isRunning(): Promise<boolean> {
      try {
        // 测试钩子模式必须与真实 DSH 隔离：跳过 lsappinfo（真实 app 在跑会干扰 fake E2E），
        // 只用 pgrep 匹配指定模式，避免把正在使用的 DSH 误判成 fake 进程。
        if (!policy.testHooks && (await lsappinfoReportsRunning())) return true
        const candidates = await findCandidates()
        return candidates.some((candidate) => !commandLooksLikeHelper(candidate.command))
      } catch (error) {
        logger?.warn?.(`${LOG_PREFIX} isRunning 失败: ${errorText(error)}`)
        return false
      }
    },

    async getPid(): Promise<number | null> {
      try {
        const candidates = await findCandidates()
        if (candidates.length === 0) return null
        const usable = candidates.filter((candidate) => !commandLooksLikeHelper(candidate.command))
        if (usable.length === 0) return null
        // 优先 Electron 主进程（无 --expose-internals / 非 desktop-host 子进程）。
        const main = usable.find(
          (candidate) =>
            candidate.command.length > 0 && !commandLooksLikeDesktopHost(candidate.command)
        )
        return (main ?? usable[0])?.pid ?? null
      } catch (error) {
        logger?.warn?.(`${LOG_PREFIX} getPid 失败: ${errorText(error)}`)
        return null
      }
    },

    async launch(): Promise<boolean> {
      try {
        if (policy.launchMode === 'shell-command' && policy.launchCommand) {
          logger?.info?.(`${LOG_PREFIX} launch via test hook: ${policy.launchCommand}`)
          await exec('/bin/sh', ['-c', policy.launchCommand], {
            timeoutMs: LAUNCH_TIMEOUT_MS,
            detached: true
          })
        } else {
          logger?.info?.(`${LOG_PREFIX} launch open -b ${DSH_BUNDLE_ID}`)
          await exec('open', ['-b', DSH_BUNDLE_ID], { timeoutMs: LAUNCH_TIMEOUT_MS })
        }
        return true
      } catch (error) {
        logger?.warn?.(`${LOG_PREFIX} launch 失败: ${errorText(error)}`)
        return false
      }
    },

    async terminate(pid: number): Promise<DshTerminateResult> {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        logger?.warn?.(`${LOG_PREFIX} terminate 收到非法 pid: ${String(pid)}`)
        return 'failed'
      }

      const startedAt = now()
      const termResult = sendSignal(pid, 'SIGTERM')
      if (termResult === 'gone') return 'not-running'

      const pollMs = Math.min(DSH_TERMINATE_POLL_MS, Math.max(10, Math.floor(terminateTimeoutMs / 10)))
      const deadline = startedAt + terminateTimeoutMs
      while (now() < deadline) {
        await sleep(pollMs)
        if (!isAlive(pid)) {
          logger?.info?.(`${LOG_PREFIX} 已优雅退出 pid=${pid} (${now() - startedAt}ms)`, {
            signal: 'SIGTERM'
          })
          return 'terminated'
        }
      }

      // 超时强杀：SIGKILL 后不再无限等待（进程可能处于不可中断状态），记录耗时即可。
      logger?.warn?.(`${LOG_PREFIX} SIGTERM 超时，升级 SIGKILL pid=${pid}`, {
        waitedMs: now() - startedAt,
        timeoutMs: terminateTimeoutMs
      })
      const killResult = sendSignal(pid, 'SIGKILL')
      if (killResult === 'gone') return 'not-running'
      await sleep(pollMs)
      if (!isAlive(pid)) return 'killed'
      logger?.warn?.(`${LOG_PREFIX} SIGKILL 后进程仍存在 pid=${pid}`)
      return 'killed'
    }
  }
}
