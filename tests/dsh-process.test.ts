/**
 * 单测：DSH 进程探测 / 拉起 / 终止（`src/main/desktop/dsh-process.ts`，Wave 3 A3）。
 *
 * **安全红线**：全部命令执行、信号发送、时钟/等待都注入 fake；本文件绝不执行真实
 * `open -b` / `pgrep` / `lsappinfo`，也绝不向真实 DSH 发信号、不读写真实 `~/.dsh`。
 *
 * 覆盖：
 * - 策略解析：默认模式/拉起方式/超时；dev 测试钩子（`PET_DSH_TEST_HOOKS`）生效与
 *   「打包版忽略钩子」；
 * - 检测：lsappinfo 优先、空输出/失败回退 pgrep+ps、Helper/GPU 子进程过滤、异常不抛；
 * - getPid：主进程优先，排除 Helper 与 desktop-host 子进程；
 * - 拉起：默认 `open -b com.deepseek.dsh`、测试钩子 `/bin/sh -c`、失败返回 false；
 * - 终止：SIGTERM 后进程消失 → 'terminated'（不升级）；持续存在 → 超时 SIGKILL →
 *   'killed'；进程不存在 → 'not-running'；非法 pid → 'failed'；钩子覆盖升级时间。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DSH_PROCESS_PATTERN,
  DSH_BUNDLE_ID,
  DSH_TERMINATE_TIMEOUT_MS,
  PET_DSH_TEST_HOOKS_ENV,
  PET_DSH_TEST_LAUNCH_CMD_ENV,
  PET_DSH_TEST_PROCESS_PATTERN_ENV,
  PET_DSH_TEST_QUIT_DELAY_MS_ENV,
  commandLooksLikeDesktopHost,
  commandLooksLikeHelper,
  createDshProcess,
  resolveDshProcessPolicy
} from '../src/main/desktop/dsh-process'
import type { DshExecFile, DshExecOptions } from '../src/main/desktop/dsh-process'

/* ------------------------------- fake exec -------------------------------- */

interface ExecCall {
  file: string
  args: readonly string[]
  options: DshExecOptions | undefined
}

/** 造一个可脚本化的 execFile：按 (file, args) 返回 stdout；抛 Error 模拟命令失败。 */
function createExec(
  handler: (call: ExecCall) => string | Error | Promise<string>
): { exec: DshExecFile; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: DshExecFile = async (file, args, options) => {
    const call: ExecCall = { file, args, options }
    calls.push(call)
    const result = await handler(call)
    if (result instanceof Error) throw result
    return { stdout: result, stderr: '' }
  }
  return { exec, calls }
}

/** 构造 errno 风格错误（ESRCH/ENOENT）。 */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/** 标准「lsappinfo + pgrep + ps」脚本化 fake。 */
function createSystemExec(script: {
  lsappinfo?: string | Error
  pgrep?: string | Error
  /** pid → 完整命令行；缺省 → ps 失败。 */
  ps?: Record<number, string>
}): { exec: DshExecFile; calls: ExecCall[] } {
  return createExec(({ file, args }) => {
    if (file === 'lsappinfo') {
      return script.lsappinfo ?? ''
    }
    if (file === 'pgrep') {
      return script.pgrep ?? ''
    }
    if (file === 'ps') {
      const pid = Number(args[1])
      const command = script.ps?.[pid]
      return command === undefined ? errno('ENOENT') : `${command}\n`
    }
    return ''
  })
}

const cleanupEnvKeys = [
  PET_DSH_TEST_HOOKS_ENV,
  PET_DSH_TEST_LAUNCH_CMD_ENV,
  PET_DSH_TEST_PROCESS_PATTERN_ENV,
  PET_DSH_TEST_QUIT_DELAY_MS_ENV
]

afterEach(() => {
  for (const key of cleanupEnvKeys) delete process.env[key]
  vi.restoreAllMocks()
})

/* --------------------------------- 策略解析 -------------------------------- */

describe('resolveDshProcessPolicy：默认值与 dev 测试钩子', () => {
  it('默认：桌面版主可执行文件模式 + open -b + 5s 升级时间，未启用钩子', () => {
    const policy = resolveDshProcessPolicy({ env: {} })
    expect(policy.processPattern).toBe(DEFAULT_DSH_PROCESS_PATTERN)
    expect(policy.launchMode).toBe('open-bundle')
    expect(policy.launchCommand).toBeNull()
    expect(policy.terminateTimeoutMs).toBe(DSH_TERMINATE_TIMEOUT_MS)
    expect(policy.testHooks).toBe(false)
  })

  it('dev + PET_DSH_TEST_HOOKS=1：三个钩子全部生效（pattern/launchCmd/quitDelay）', () => {
    const policy = resolveDshProcessPolicy({
      env: {
        [PET_DSH_TEST_HOOKS_ENV]: '1',
        [PET_DSH_TEST_PROCESS_PATTERN_ENV]: '/tmp/fake-dsh-pet',
        [PET_DSH_TEST_LAUNCH_CMD_ENV]: '/tmp/fake-dsh-pet start',
        [PET_DSH_TEST_QUIT_DELAY_MS_ENV]: '1200'
      },
      isPackaged: false
    })
    expect(policy.testHooks).toBe(true)
    expect(policy.processPattern).toBe('/tmp/fake-dsh-pet')
    expect(policy.launchMode).toBe('shell-command')
    expect(policy.launchCommand).toBe('/tmp/fake-dsh-pet start')
    expect(policy.terminateTimeoutMs).toBe(1200)
  })

  it('打包版忽略全部测试钩子（即使环境变量被伪造）', () => {
    const policy = resolveDshProcessPolicy({
      env: {
        [PET_DSH_TEST_HOOKS_ENV]: '1',
        [PET_DSH_TEST_PROCESS_PATTERN_ENV]: 'evil-pattern',
        [PET_DSH_TEST_LAUNCH_CMD_ENV]: 'echo pwned',
        [PET_DSH_TEST_QUIT_DELAY_MS_ENV]: '10'
      },
      isPackaged: true
    })
    expect(policy.testHooks).toBe(false)
    expect(policy.processPattern).toBe(DEFAULT_DSH_PROCESS_PATTERN)
    expect(policy.launchMode).toBe('open-bundle')
    expect(policy.terminateTimeoutMs).toBe(DSH_TERMINATE_TIMEOUT_MS)
  })

  it('钩子 quit delay 非法/越界 → 回退默认；过小钳制到下限', () => {
    expect(
      resolveDshProcessPolicy({
        env: { [PET_DSH_TEST_HOOKS_ENV]: '1', [PET_DSH_TEST_QUIT_DELAY_MS_ENV]: 'abc' }
      }).terminateTimeoutMs
    ).toBe(DSH_TERMINATE_TIMEOUT_MS)
    expect(
      resolveDshProcessPolicy({
        env: { [PET_DSH_TEST_HOOKS_ENV]: '1', [PET_DSH_TEST_QUIT_DELAY_MS_ENV]: '1' }
      }).terminateTimeoutMs
    ).toBe(10)
  })
})

/* ----------------------------- 命令行分类（纯函数） ------------------------- */

describe('命令行分类：Helper 与 desktop-host', () => {
  const mainCmd = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
  const helperCmd =
    '/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper (Renderer).app/Contents/MacOS/DeepSeek Harness Helper (Renderer) --type=renderer'
  const hostCmd = `${mainCmd} --expose-internals /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`

  it('Helper/GPU/renderer 命令行被识别为子进程', () => {
    expect(commandLooksLikeHelper(helperCmd)).toBe(true)
    expect(commandLooksLikeHelper(`${mainCmd} --type=gpu-process`)).toBe(true)
    expect(commandLooksLikeHelper(mainCmd)).toBe(false)
    expect(commandLooksLikeHelper(hostCmd)).toBe(false)
  })

  it('desktop-host 子进程与 Electron 主进程可区分', () => {
    expect(commandLooksLikeDesktopHost(hostCmd)).toBe(true)
    expect(commandLooksLikeDesktopHost(mainCmd)).toBe(false)
    expect(
      commandLooksLikeDesktopHost(`${mainCmd} dsh-desktop-host/lib/cli.js`)
    ).toBe(true)
  })
})

/* ---------------------------------- 检测 ---------------------------------- */

describe('isRunning：lsappinfo 优先 + pgrep 兜底', () => {
  it('lsappinfo exit 0 且输出非空 → 在运行，不再调用 pgrep', async () => {
    const { exec, calls } = createSystemExec({ lsappinfo: '{ "pid" = 123 }' })
    const process = createDshProcess({ execFile: exec })
    await expect(process.isRunning()).resolves.toBe(true)
    expect(calls.map((call) => call.file)).toEqual(['lsappinfo'])
    expect(calls[0]?.args).toEqual(['find', `bundleID=${DSH_BUNDLE_ID}`])
  })

  it('lsappinfo 成功但输出为空 → 回退 pgrep，命中主进程 → 在运行', async () => {
    const { exec, calls } = createSystemExec({
      lsappinfo: '   \n',
      pgrep: '100\n',
      ps: {
        100: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
      }
    })
    const process = createDshProcess({ execFile: exec })
    await expect(process.isRunning()).resolves.toBe(true)
    expect(calls.some((call) => call.file === 'pgrep')).toBe(true)
    expect(calls.find((call) => call.file === 'pgrep')?.args).toEqual([
      '-f',
      DEFAULT_DSH_PROCESS_PATTERN
    ])
  })

  it('pgrep 只命中 Helper 子进程 → 不在运行（排除 Helper）', async () => {
    const { exec } = createSystemExec({
      lsappinfo: '',
      pgrep: '200\n201\n',
      ps: {
        200: '/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper (Renderer).app/Contents/MacOS/DeepSeek Harness Helper (Renderer) --type=renderer',
        201: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness Helper --type=gpu-process'
      }
    })
    const process = createDshProcess({ execFile: exec })
    await expect(process.isRunning()).resolves.toBe(false)
  })

  it('lsappinfo ENOENT + pgrep 无匹配 → false（不抛）', async () => {
    const { exec } = createSystemExec({ lsappinfo: errno('ENOENT'), pgrep: '' })
    const process = createDshProcess({ execFile: exec })
    await expect(process.isRunning()).resolves.toBe(false)
  })

  it('测试钩子模式跳过 lsappinfo（与真实 DSH 隔离，只按 fake 模式 pgrep）', async () => {
    const { exec, calls } = createSystemExec({
      lsappinfo: '{ "pid" = 123 }', // 即使真实 DSH 在跑也不得采信
      pgrep: '',
      ps: {}
    })
    const process = createDshProcess({
      execFile: exec,
      env: {
        [PET_DSH_TEST_HOOKS_ENV]: '1',
        [PET_DSH_TEST_PROCESS_PATTERN_ENV]: '/tmp/fake-dsh-pet'
      }
    })
    await expect(process.isRunning()).resolves.toBe(false)
    expect(calls.some((call) => call.file === 'lsappinfo')).toBe(false)
    expect(calls.find((call) => call.file === 'pgrep')?.args).toEqual(['-f', '/tmp/fake-dsh-pet'])
  })

  it('pgrep 非 0 退出（无匹配）→ false，不向调用方抛', async () => {
    const { exec } = createSystemExec({ lsappinfo: errno('ENOENT'), pgrep: errno('EXIT1') })
    const process = createDshProcess({ execFile: exec })
    await expect(process.isRunning()).resolves.toBe(false)
  })
})

/* --------------------------------- getPid --------------------------------- */

describe('getPid：主进程优先，排除 Helper/Host', () => {
  it('主进程 + Helper + desktop-host → 返回 Electron 主进程 pid', async () => {
    const mainCmd = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
    const { exec } = createSystemExec({
      pgrep: '10\n11\n12\n',
      ps: {
        10: `${mainCmd} --expose-internals /x/dsh-desktop-host/lib/index.js`,
        11: '/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper --type=renderer',
        12: mainCmd
      }
    })
    const process = createDshProcess({ execFile: exec })
    await expect(process.getPid()).resolves.toBe(12)
  })

  it('只有 Helper → null（绝不误杀子进程）', async () => {
    const { exec } = createSystemExec({
      pgrep: '20\n',
      ps: { 20: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness Helper --type=gpu-process' }
    })
    const process = createDshProcess({ execFile: exec })
    await expect(process.getPid()).resolves.toBeNull()
  })

  it('pgrep 无输出 → null', async () => {
    const { exec } = createSystemExec({ pgrep: '' })
    const process = createDshProcess({ execFile: exec })
    await expect(process.getPid()).resolves.toBeNull()
  })
})

/* ---------------------------------- 拉起 ---------------------------------- */

describe('launch：默认 open -b / 测试钩子 / 失败降级', () => {
  it('默认执行 open -b com.deepseek.dsh，返回 true', async () => {
    const { exec, calls } = createSystemExec({})
    const process = createDshProcess({ execFile: exec })
    await expect(process.launch()).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe('open')
    expect(calls[0]?.args).toEqual(['-b', DSH_BUNDLE_ID])
    // 安全红线：绝不使用 osascript（Automation TCC）。
    expect(calls.some((call) => call.file === 'osascript')).toBe(false)
  })

  it('dev 测试钩子：经 /bin/sh -c 执行覆盖命令（detached）', async () => {
    const { exec, calls } = createSystemExec({})
    const process = createDshProcess({
      execFile: exec,
      env: {
        [PET_DSH_TEST_HOOKS_ENV]: '1',
        [PET_DSH_TEST_LAUNCH_CMD_ENV]: '/tmp/fake-dsh-pet run'
      }
    })
    await expect(process.launch()).resolves.toBe(true)
    expect(calls[0]?.file).toBe('/bin/sh')
    expect(calls[0]?.args).toEqual(['-c', '/tmp/fake-dsh-pet run'])
    expect(calls[0]?.options?.detached).toBe(true)
  })

  it('拉起命令失败 → false（只 warn，不抛）', async () => {
    const warn = vi.fn()
    const { exec } = createExec(() => errno('ENOENT'))
    const process = createDshProcess({ execFile: exec, logger: { warn } })
    await expect(process.launch()).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})

/* ---------------------------------- 终止 ---------------------------------- */

describe('terminate：SIGTERM → ≤5s → SIGKILL', () => {
  interface FakeSignalWorld {
    alive: boolean
    clock: number
    signals: (NodeJS.Signals | 0)[]
    diesAt: number | null
    /** SIGTERM 后多久自行退出（null = 永不，用于验证超时升级）。 */
    gracefulExitAfterMs: number | null
    kill: (pid: number, signal: NodeJS.Signals | 0) => void
    now: () => number
    sleep: (ms: number) => Promise<void>
  }

  /** 造一个假进程世界：kill 记录信号，sleep 推进假时钟并结算「进程是否已退出」。 */
  function createWorld(gracefulExitAfterMs: number | null): FakeSignalWorld {
    const world: FakeSignalWorld = {
      alive: true,
      clock: 0,
      signals: [],
      diesAt: null,
      gracefulExitAfterMs,
      now: () => world.clock,
      kill: (pid, signal) => {
        expect(pid).toBe(4321)
        if (!world.alive) throw errno('ESRCH')
        if (signal === 0) return
        world.signals.push(signal)
        if (signal === 'SIGTERM') {
          world.diesAt =
            world.gracefulExitAfterMs === null ? null : world.clock + world.gracefulExitAfterMs
        } else if (signal === 'SIGKILL') {
          world.diesAt = world.clock
        }
      },
      sleep: async (ms) => {
        world.clock += ms
        if (world.diesAt !== null && world.clock >= world.diesAt) world.alive = false
      }
    }
    return world
  }

  function createProcessIn(world: FakeSignalWorld, options: { terminateTimeoutMs?: number } = {}) {
    return createDshProcess({
      execFile: createSystemExec({}).exec,
      kill: world.kill,
      now: world.now,
      sleep: world.sleep,
      ...(options.terminateTimeoutMs !== undefined
        ? { terminateTimeoutMs: options.terminateTimeoutMs }
        : {})
    })
  }

  it('SIGTERM 后进程在超时前退出 → terminated，绝不升级 SIGKILL', async () => {
    const world = createWorld(1200)
    const process = createProcessIn(world)
    await expect(process.terminate(4321)).resolves.toBe('terminated')
    expect(world.signals).toEqual(['SIGTERM'])
    expect(world.clock).toBeGreaterThanOrEqual(1200)
    expect(world.clock).toBeLessThanOrEqual(5000)
  })

  it('SIGTERM 无效（进程坚持存在）→ 超时 SIGKILL → killed', async () => {
    const world = createWorld(null)
    const process = createProcessIn(world)
    await expect(process.terminate(4321)).resolves.toBe('killed')
    expect(world.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(world.clock).toBeGreaterThanOrEqual(5000)
  })

  it('进程一开始就不存在（ESRCH）→ not-running，不等待', async () => {
    const world = createWorld(null)
    world.alive = false
    const process = createProcessIn(world)
    await expect(process.terminate(4321)).resolves.toBe('not-running')
    expect(world.signals).toEqual([])
    expect(world.clock).toBe(0)
  })

  it('非法 pid → failed，不发送任何信号', async () => {
    const world = createWorld(null)
    const process = createProcessIn(world)
    await expect(process.terminate(0)).resolves.toBe('failed')
    await expect(process.terminate(-1)).resolves.toBe('failed')
    expect(world.signals).toEqual([])
  })

  it('测试钩子覆盖升级时间（1200ms）：到点即 SIGKILL', async () => {
    const world = createWorld(null)
    const process = createDshProcess({
      execFile: createSystemExec({}).exec,
      kill: world.kill,
      now: world.now,
      sleep: world.sleep,
      env: {
        [PET_DSH_TEST_HOOKS_ENV]: '1',
        [PET_DSH_TEST_QUIT_DELAY_MS_ENV]: '1200'
      }
    })
    await expect(process.terminate(4321)).resolves.toBe('killed')
    expect(world.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(world.clock).toBeGreaterThanOrEqual(1200)
    expect(world.clock).toBeLessThan(2000)
  })

  it('显式 terminateTimeoutMs 优先于钩子/默认', async () => {
    const world = createWorld(null)
    const process = createProcessIn(world, { terminateTimeoutMs: 800 })
    await expect(process.terminate(4321)).resolves.toBe('killed')
    expect(world.clock).toBeGreaterThanOrEqual(800)
    expect(world.clock).toBeLessThan(2000)
  })
})
